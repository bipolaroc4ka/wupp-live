// WSW (Wuppertaler Stadtwerke): сообщения об изменениях в движении автобусов и Schwebebahn,
// а также аварии на сетях (Rohrbruch, Stromausfall, Gasaustritt, Fernwärme) и перекрытия улиц из-за работ на сетях.
// Источник — две официальные ленты сайта WSW (News и Presseinformationen). В них много рекламы (тарифы, акции, мероприятия),
// поэтому берём только записи, где есть и транспортный предмет (линия, Schwebebahn, остановка), и признак изменения движения
// (объезд, отмена, перенос остановки, замещающий транспорт, сбой). Остальное отбрасывается.
import { fetchWithRetry, ISO, truncate, shortId } from '../util.js';
import { extractStreet, geocodeStreet } from '../geo.js';
import { syncSource } from '../events.js';
import { parseGermanDates } from './wuppertal.js';
import { extractDistrict } from './presseportal.js';

export const meta = {
  id: 'wsw',
  name: 'WSW (Wuppertaler Stadtwerke: Bus und Schwebebahn)',
  intervalSec: 600,
  cron: '2-59/10 * * * *',
  group: 'transit'
};

export const FEEDS = [
  'https://www.wsw-online.de/suchergebnisse/rss.xml',
  'https://www.wsw-online.de/suchergebnisse/presseinformationen.xml'
];
const SCOPE = 'wsw/notices';
const MAX_AGE_DAYS = 45;
const TTL_DAYS = 14; // без даты окончания в тексте: от даты публикации (или от начала)
const INCIDENT_TTL_DAYS = 3; // авария на сети без указанного срока быстро теряет актуальность
const DAY = 86400000;
const MAX_ITEMS_PER_FEED = 40;
const MAX_XML_CHARS = 2_000_000;
const DESCRIPTION_LIMIT = 1200;

// Транспортный предмет (без \b в конце: «Buslinien», «Schwebebahnhaltestelle»)
const SUBJECT = /(?:\blinien?\s+\d{2,3}|\bbuslinie|\bschwebebahn|\btaxibus|\bhaltestelle|\bfahrplan|\bersatzverkehr|\bschienenersatz|\bwsw[\s-]+(?:bus|linie))/i;
// Признак изменения движения
const ACTION = /(?:umleit|abweichende\s+linienführung|ausfall|fällt\s+aus|fallen\s+aus|entfäll|eingestellt|ersatzverkehr|schienenersatz|betriebseinstellung|kein\s+betrieb|nicht\s+(?:bedient|angefahren)|verlegt|fahrplanänderung|störung|einschränkung|verspätung|sperr|baumaßnahme|bauarbeiten|taxibus)/i;

const CATEGORIES = [
  ['transit_detour', /umleit|abweichende\s+linienführung/i],
  ['transit_stop', /haltestellen?[^.\n]{0,100}(?:nicht\s+(?:bedient|angefahren)|verlegt|entfäll|aufgehoben|verschoben)|nicht\s+(?:bedient|angefahren)/i],
  ['transit_cancel', /ausfall|fällt\s+aus|fallen\s+aus|eingestellt|ersatzverkehr|schienenersatz|betriebseinstellung|kein\s+betrieb|entfäll/i],
  ['transit_delay', /störung|einschränkung|verspätung|fahrplanänderung|sperr|baumaßnahme|bauarbeiten|taxibus/i]
];

// Аварии на сетях, затрагивающие жителей (только явные признаки сбоя; плановые работы и новости компании сюда не попадают)
const UTILITY = [
  ['infra_power', /stromausfall|stromstörung|stromversorgung[^.\n]{0,40}(?:unterbrochen|gestört|ausgefallen|eingeschränkt)/i],
  ['infra_water', /wasserrohrbruch|rohrbruch|wasserleitungsbruch|wasserversorgung[^.\n]{0,40}(?:unterbrochen|gestört|eingeschränkt|ausgefallen)|kein(?:e)?\s+wasser|abkochgebot|trinkwasser[^.\n]{0,40}(?:abkochen|verunreinigt)/i],
  ['infra_damage', /gasaustritt|gasleck|gasgeruch|leitungsschaden|(?:gas|fernwärme)versorgung[^.\n]{0,40}(?:unterbrochen|gestört|ausgefallen)|fernwärme[^.\n]{0,40}(?:ausfall|störung|unterbrochen)/i]
];
// Работы на сетях считаются событием только если из-за них перекрыта или ограничена улица (и улица названа)
const WORKS = /(?:leitungs|kanal|bau|tiefbau)?arbeiten|baumaßnahme|baustelle/i;
const CLOSURE = /vollsperrung|halbseitig|gesperrt|sperrung|verkehrseinschränkung|verkehrsbehinderung|einbahnstraße|ampelregelung/i;
const NOT_ROAD = /parkplatz|parkbetrieb|parkhaus|stellplatz/i;

const decode = (v) => String(v || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
  .replace(/&apos;|&#0?39;/gi, "'")
  .replace(/&#(\d+);/g, (_, n) => { const c = +n; return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ''; })
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => { const c = parseInt(n, 16); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ''; })
  .replace(/&amp;/gi, '&');
const text = (v) => decode(decode(v).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function tag(block, names) {
  for (const n of names) {
    const m = block.match(new RegExp(`<(?:[\\w.-]+:)?${n}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${n}\\s*>`, 'i'));
    if (m && text(m[1])) return text(m[1]);
  }
  return '';
}

// Разбор RSS и Atom. Возвращает [{ id, title, url, published, description }]
export function parseFeed(xml, urlFn = safeHttps) {
  const blocks = String(xml || '').slice(0, MAX_XML_CHARS).match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const out = [];
  for (const b of blocks.slice(0, MAX_ITEMS_PER_FEED)) {
    const href = (b.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i) || [])[1];
    const url = urlFn(href ? decode(href) : tag(b, ['link']));
    const title = tag(b, ['title']);
    const dateStr = tag(b, ['pubDate', 'published', 'updated', 'date']);
    const published = Date.parse(dateStr);
    if (!title || !url || !Number.isFinite(published)) continue;
    out.push({
      id: tag(b, ['guid', 'id']) || url,
      title, url, published,
      description: tag(b, ['description', 'summary', 'content'])
    });
  }
  return out;
}

// В ленте WSW встречаются битые ссылки вида «https://www.wsw-online.de/ttps://www.wsw-online.de/mobilitaet/…»: берём вторую часть
function safeHttps(u) {
  u = String(u || '').replace(/^https:\/\/www\.wsw-online\.de\/ttps?:\/\//i, 'https://');
  try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)wsw-online\.de$/i.test(x.hostname) ? x.href : ''; } catch { return ''; }
}

// Сообщение об изменении движения или null (причина отказа — в reason)
export function classify(title, description) {
  const all = `${title}. ${description}`;
  if (!SUBJECT.test(all)) return { reason: 'не про маршруты/остановки' };
  if (!ACTION.test(all)) return { reason: 'нет изменения движения' };
  for (const [cat, re] of CATEGORIES) if (re.test(title)) return { category: cat };
  for (const [cat, re] of CATEGORIES) if (re.test(all)) return { category: cat };
  return { reason: 'не удалось определить тип' };
}

// Транспорт (classify) -> авария на сетях -> перекрытие улицы из-за работ -> иначе отказ с причиной
export function classifyAny(title, description) {
  const all = `${title}. ${description}`;
  const tr = classify(title, description);
  if (tr.category) return tr;
  for (const [cat, re] of UTILITY) if (re.test(all)) return { category: cat, incident: true };
  if (WORKS.test(all) && CLOSURE.test(all) && !NOT_ROAD.test(title) && extractStreet(all)) {
    return { category: /vollsperrung|gesperrt|sperrung/i.test(all) ? 'road_closure' : 'roadworks' };
  }
  return tr;
}

// «für etwa drei Monate», «werden drei Wochen dauern», «Dauer: 2 Tage» -> число дней (или null)
const NW = { ein: 1, eine: 1, einen: 1, einem: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10 };
const DN = '(\\d{1,2}|ein|eine|einen|einem|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn)';
const DU = '(tag|tage|tagen|woche|wochen|monat|monate|monaten)';
export function durationDays(text) {
  const m = text.match(new RegExp(`\\bfür\\s+(?:etwa|rund|ca\\.?|circa|voraussichtlich|mindestens|insgesamt)\\s+${DN}\\s+${DU}\\b`, 'i'))
    || text.match(new RegExp(`\\b${DN}\\s+${DU}\\b[^.\\n]{0,40}?\\b(?:dauer\\w*|lang)\\b`, 'i'))
    || text.match(new RegExp(`\\b(?:dauer\\w*|bauzeit)\\b[^.\\n]{0,30}?\\b${DN}\\s+${DU}\\b`, 'i'));
  if (!m) return null;
  const n = /^\d/.test(m[1]) ? parseInt(m[1], 10) : NW[m[1].toLowerCase()];
  const u = m[2].toLowerCase();
  const days = u.startsWith('tag') ? n : u.startsWith('woch') ? n * 7 : n * 30;
  return days >= 1 && days <= 366 ? days : null;
}

export function toItem(story, nowMs) {
  if (nowMs - story.published > MAX_AGE_DAYS * DAY) return { reason: 'старше 45 дней' };
  if (story.published > nowMs + 10 * 60000) return { reason: 'дата из будущего' };
  const cls = classifyAny(story.title, story.description);
  if (!cls.category) return { reason: cls.reason };

  const all = `${story.title}. ${story.description}`;
  const parsed = parseGermanDates(all, nowMs);
  const start = parsed.start;
  let end = parsed.end;
  if (start && !end) { const days = durationDays(all); if (days) end = new Date(start.getTime() + (days - 1) * DAY); }
  if (end && end.getTime() + DAY < nowMs) return { reason: 'срок действия уже истёк' };
  const anchor = Math.max(story.published, start ? start.getTime() : 0);
  const expiresMs = end ? end.getTime() + DAY : anchor + (cls.incident ? INCIDENT_TTL_DAYS : TTL_DAYS) * DAY;
  if (expiresMs <= nowMs) {
    // подробность для пробы в админке: что именно распознано
    const f = (d) => (d ? d.toISOString().slice(0, 10) : 'нет');
    return { reason: `срок истёк (начало: ${f(start)}, конец: ${f(end)}; без даты конца запись хранится ${cls.incident ? INCIDENT_TTL_DAYS : TTL_DAYS} дн.)` };
  }

  const street = extractStreet(all);
  const district = extractDistrict(all);
  const scheduled = !!start && start.getTime() > nowMs;
  // известный срок ещё идёт (изменение действует сейчас) — тоже «ACTIVE», иначе запись выпадала бы из окна API через сутки
  const inEffect = !scheduled && !!end && end.getTime() + DAY > nowMs;

  const item = {
    source_event_id: story.id,
    scope: SCOPE,
    publisher: 'WSW',
    title: truncate(story.title, 200),
    description: truncate(story.description, DESCRIPTION_LIMIT) || null,
    category: cls.category,
    source_url: story.url,
    geo_precision: !street && district ? 'district' : 'none',
    district: !street && district ? district : null,
    location_name: street || district || null,
    // «Произошло» у объявлений WSW неизвестно: даты начала и конца — это срок действия изменения
    event_time: null,
    time_precision: 'unknown',
    valid_from: start ? ISO(start.getTime()) : null,
    valid_from_precision: start ? 'day' : null,
    valid_until: end ? ISO(end.getTime()) : null,
    valid_until_precision: end ? 'day' : null,
    published_at: ISO(story.published),
    expires_at: ISO(expiresMs),
    status: scheduled || inEffect ? 'ACTIVE' : 'RECENT',
    status_reason: scheduled ? 'official_wsw_scheduled_change' : inEffect ? 'official_wsw_change_in_effect' : 'official_wsw_notice',
    confidence: street ? 0.8 : 0.7,
    is_verified: 1
  };

  item.enrich = async (ctx) => {
    if (!street) return;
    const g = await geocodeStreet(ctx, street);
    if (!g) { item.geocode_attempts = 1; return; }
    if (g.pending) return; // позже повторит retryGeocoding
    item.geo_precision = g.precision;
    item.district = g.district || district || null;
    if (g.precision === 'street') { item.latitude = g.lat; item.longitude = g.lon; }
  };
  return { item };
}

async function fetchFeed(url) {
  const res = await fetchWithRetry(url, {
    timeoutMs: 12000, retries: 2, backoffMs: 800,
    headers: { accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml', 'user-agent': 'WuppertalLive/1.0' }
  });
  if (!res.ok) throw new Error(`WSW feed HTTP ${res.status}`);
  const xml = await res.text();
  if (!/<(?:rss|feed)\b/i.test(xml)) throw new Error('WSW feed returned unexpected content');
  return xml;
}

// Проба для админки: по каждой ленте — статус и размер, по каждой записи — принята или причина отказа. Ничего не сохраняет.
export async function probe(ctx) {
  const now = ctx && ctx.now ? ctx.now : Date.now();
  const feeds = [];
  for (const url of FEEDS) {
    const f = { url };
    try {
      const xml = await fetchFeed(url);
      const stories = parseFeed(xml);
      f.status = 200; f.xml_bytes = xml.length; f.format = /<feed\b/i.test(xml) ? 'Atom' : 'RSS'; f.entries = stories.length;
      f.items = stories.map((s) => {
        const r = toItem(s, now);
        return {
          title: s.title, published: new Date(s.published).toISOString(), url: s.url,
          accepted: !!r.item, reason: r.item ? null : r.reason,
          ...(r.item ? { category: r.item.category, place: r.item.location_name, valid_from: r.item.valid_from, valid_until: r.item.valid_until, expires_at: r.item.expires_at } : {})
        };
      });
    } catch (e) { f.error = e.message; }
    feeds.push(f);
  }
  return { feeds, accepted: feeds.reduce((n, f) => n + (f.items || []).filter((i) => i.accepted).length, 0) };
}

export async function run(ctx) {
  const stories = new Map();
  const errors = [];
  let okFeeds = 0;
  for (const url of FEEDS) {
    try {
      for (const s of parseFeed(await fetchFeed(url))) if (!stories.has(s.url)) stories.set(s.url, s);
      okFeeds++;
    } catch (e) { errors.push(`${url}: ${e.message}`); ctx.log(`wsw: ${e.message}`); }
  }
  if (!okFeeds) throw new Error(`WSW: ни одна лента не доступна (${errors.join('; ')})`);

  const items = [], rejects = {};
  for (const s of stories.values()) {
    const r = toItem(s, ctx.now);
    if (r.item) items.push(r.item); else rejects[r.reason] = (rejects[r.reason] || 0) + 1;
  }
  const stats = await syncSource(ctx, meta.id, items, { resolveMissing: false });
  return {
    ...stats,
    feeds_ok: okFeeds, feed_items: stories.size, accepted: items.length, rejected: rejects,
    sample: items.slice(0, 5).map((i) => ({ title: i.title, category: i.category, place: i.location_name, from: i.valid_from, until: i.valid_until }))
  };
}
