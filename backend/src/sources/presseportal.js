// Presseportal (news aktuell / dpa) — пресс-релизы Feuerwehr Wuppertal и Polizei Wuppertal через публичные RSS-ленты.
// API и ключ не нужны.
//
// ЧЕСТНО О ДАННЫХ:
//  * Это пресс-релизы, а не диспетчерская лента: публикация идёт через часы после события, и не обо всех выездах.
//  * Поэтому статус всегда RECENT («актуальность неизвестна»), никогда LIVE/ACTIVE; срок жизни — только TTL.
//  * Время происшествия берётся только из текста релиза; если не найдено — «неизвестно». Время публикации не подставляется.
//  * Полицейский newsroom охватывает Wuppertal, Remscheid и Solingen: берутся только релизы города Wuppertal.
//  * Уже просроченные релизы не сохраняются вовсе (иначе статус «мигал» бы между RECENT и EXPIRED).
//
// ВАЖНО: форма RSS здесь не проверялась вживую (адрес вне списка доступных из рабочей среды). Парсер защитный;
// проверьте через админку: «Проба» (GET /api/admin/sources/presseportal/probe).

import { fetchWithRetry, truncate } from '../util.js';
import { syncSource } from '../events.js';
import { extractStreet, geocodeStreet } from '../geo.js';
import { parseEventTime } from '../time.js';

export const meta = {
  id: 'presseportal',
  name: 'Presseportal: Feuerwehr / Polizei Wuppertal',
  intervalSec: 600,
  cron: '*/10 * * * *',
  group: 'emergency'
};

const MAX_AGE_DAYS = 7;
const MAX_ITEMS_PER_FEED = 40;
const MAX_XML_CHARS = 2_000_000;
const DESCRIPTION_LIMIT = 900;

const FEEDS = [
  { id: '115885', publisher: 'Feuerwehr Wuppertal', type: 'fire', url: 'https://www.presseportal.de/rss/dienststelle_115885.rss2' },
  { id: '11811', publisher: 'Polizei Wuppertal', type: 'police', url: 'https://www.presseportal.de/rss/dienststelle_11811.rss2' }
];

// ---------- XML / HTML ----------
const NAMED = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', ndash: '–', mdash: '—', hellip: '…', euro: '€', laquo: '«', raquo: '»'
};

// Одним проходом: иначе «&amp;lt;» превратилось бы в «<» (двойное декодирование).
function decodeEntities(value) {
  return String(value || '').replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (all, hex, dec, name) => {
    try {
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      if (dec) return String.fromCodePoint(parseInt(dec, 10));
    } catch { return ' '; }
    return Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : all;
  });
}

// Содержимое тега: CDATA берётся как есть, обычный текст декодируется.
function getTag(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(xml || '').match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'i'));
  if (!m) return '';
  const raw = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  return cdata ? cdata[1].trim() : decodeEntities(raw).trim();
}

// HTML -> текст; абзацы сохраняются (пустая строка), пробелы внутри строки схлопываются.
function cleanHtml(value) {
  const text = decodeEntities(String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h\d)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' '));
  return text
    .split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function parseRss(xml) {
  const items = [];
  for (const match of String(xml || '').matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)) {
    const x = match[1];
    const title = cleanHtml(getTag(x, 'title'));
    const description = cleanHtml(getTag(x, 'description') || getTag(x, 'content:encoded'));
    const link = getTag(x, 'link');
    const guid = getTag(x, 'guid');
    const pubDate = getTag(x, 'pubDate') || getTag(x, 'dc:date');
    const id = guid || link;
    if (!id || !title || !pubDate) continue;
    items.push({ id, title, description, link, pubDate });
    if (items.length >= MAX_ITEMS_PER_FEED) break;
  }
  return items;
}

// Только https-ссылки на presseportal.de (в ленте может оказаться что угодно).
function safeStoryUrl(link, id) {
  try {
    const u = new URL(String(link || id || ''));
    if (u.protocol === 'https:' && /(^|\.)presseportal\.de$/i.test(u.hostname)) { u.search = ''; u.hash = ''; return u.toString(); }
  } catch { /* ниже запасной вариант */ }
  return 'https://www.presseportal.de/';
}

// ---------- разбор релиза ----------
// «Wuppertal (ots) - …» / «Wuppertal-Barmen (ots) - …»
const DATELINE_RE = /^\s*([^()\n]{2,60}?)\s*\(ots\)\s*[-–—:]?\s*/i;
const dateline = (body) => { const m = DATELINE_RE.exec(String(body || '')); return m ? m[1].trim() : null; };

function classify(text, publisher) {
  const t = String(text || '').toLowerCase();
  if (/gefahrstoff|gasaustritt|einsturz|explosion|bombe|kampfmittel|evakuier/.test(t)) return 'hazard';
  if (/\b\w*brand\b|\bfeuer(?!wehr)\w*|rauchentwicklung|löscharbeiten|flammen/.test(t)) return 'fire';
  if (/verkehrsunfall|unfall|kollision|zusammenstoß/.test(t)) return 'accident';
  if (publisher === 'police') return 'police';
  if (/rettungsdienst|reanimation|rettungswagen|notarzt/.test(t)) return 'rescue';
  return 'emergency_other';
}

const normalizeTitle = (t) => String(t || '').replace(/^(?:FW|POL)-[A-Z]+\s*(?:\(\d+\))?\s*:\s*/i, '').trim();

// Относится ли релиз к городу Wuppertal.
function isWuppertal(line, title, body, feedType) {
  if (line) return /^wuppertal\b/i.test(line);
  // Без датастроки: у пожарной ленты достаточно упоминания города; у полицейской — упоминание в начале
  // и отсутствие соседних городов в первой части текста.
  const head = `${title} ${body.slice(0, 160)}`;
  if (feedType === 'police') return /wuppertal/i.test(head) && !/remscheid|solingen/i.test(head);
  return /wuppertal/i.test(`${title} ${body}`);
}

function toItem(story, feed, nowMs, ttlMs) {
  const title0 = String(story.title || '').trim();
  const body = String(story.description || '').trim();
  const published = Date.parse(story.pubDate);
  if (!story.id || !title0 || !Number.isFinite(published)) return null; // без времени публикации не показываем
  if (published > nowMs + 10 * 60 * 1000) return null;                    // публикации «из будущего»
  if (nowMs - published > MAX_AGE_DAYS * 24 * 3600e3) return null;

  const expiresMs = published + ttlMs;
  if (nowMs >= expiresMs) return null; // просроченное не сохраняем: статус не должен «мигать»

  if (!isWuppertal(dateline(body), title0, body, feed.type)) return null;

  const title = normalizeTitle(title0) || title0;
  const clean = body.replace(DATELINE_RE, '').trim();
  const eventText = `${title0}. ${body}`;
  const et = parseEventTime(eventText, published);
  const street = extractStreet(eventText);

  const item = {
    source_event_id: `${feed.id}:${story.id}`, // префикс исключает коллизии между лентами
    publisher: feed.publisher,
    title,
    description: truncate(clean, DESCRIPTION_LIMIT) || null,
    category: classify(`${title0} ${body}`, feed.type),
    source_url: safeStoryUrl(story.link, story.id),
    geo_precision: 'none',
    location_name: street,
    event_time: et.ms != null ? new Date(et.ms).toISOString() : null,
    time_precision: et.precision,
    published_at: new Date(published).toISOString(),
    status: 'RECENT',
    status_reason: 'press_release_actuality_unknown',
    confidence: 0.5,
    is_verified: 1,
    expires_at: new Date(expiresMs).toISOString() // стабильный: от публикации, а не от «сейчас»
  };

  if (street) {
    item.enrich = async (ctx) => {
      const g = await geocodeStreet(ctx, street);
      if (!g) { item.geocode_attempts = 1; return; }
      if (g.pending) return; // позже повторит retryGeocoding
      item.geo_precision = g.precision;
      item.district = g.district || null;
      item.confidence = 0.6;
      if (g.precision === 'street') { item.latitude = g.lat; item.longitude = g.lon; }
      // district: координаты не сохраняем — на карте рисуется только приблизительная область района
    };
  }
  return item;
}

// ---------- загрузка ----------
async function fetchFeed(feed) {
  const res = await fetchWithRetry(feed.url, {
    headers: {
      accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      'user-agent': 'WuppertalLive/1.0 (+https://github.com/bipolaroc4ka/wupp-live)'
    },
    timeoutMs: 10000,
    retries: 1 // каждая попытка — подзапрос (лимит Workers Free: 50 на запуск)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Presseportal RSS (${feed.type})`);
  const xml = await res.text();
  if (xml.length > MAX_XML_CHARS) throw new Error(`Presseportal RSS too large (${feed.type})`);
  if (!/<rss[\s>]/i.test(xml)) throw new Error(`Invalid RSS response from Presseportal (${feed.type})`);
  return { xml, stories: parseRss(xml) };
}

export async function run(ctx) {
  const ttlMs = Math.max(1, parseFloat(ctx.env.PRESS_TTL_HOURS) || 12) * 3600e3;
  const items = [];
  let ok = 0, lastErr = null;

  for (const feed of FEEDS) {
    try {
      const { stories } = await fetchFeed(feed);
      ok += 1;
      let accepted = 0;
      for (const story of stories) {
        const it = toItem(story, feed, ctx.now, ttlMs);
        if (it) { items.push(it); accepted += 1; }
      }
      ctx.log(`presseportal ${feed.type}: RSS items=${stories.length}, accepted=${accepted}`);
    } catch (e) {
      lastErr = e;
      ctx.log(`presseportal ${feed.type}: ${e.message}`);
    }
  }
  if (!ok) throw lastErr || new Error('All Presseportal RSS feeds failed');
  // Релизы не «завершаются» по исчезновению из ленты: их актуальность ограничивается только TTL.
  return syncSource(ctx, meta.id, items, { resolveMissing: false });
}

// Проверка через «Проба» в админке.
export async function probe() {
  const feeds = [];
  for (const feed of FEEDS) {
    try {
      const { xml, stories } = await fetchFeed(feed);
      feeds.push({
        publisher: feed.publisher, url: feed.url, status: 'ok', items: stories.length,
        datelines: stories.slice(0, 10).map((s) => dateline(s.description)),
        sample: stories.slice(0, 3).map((s) => ({ title: s.title, pubDate: s.pubDate, link: s.link, description: s.description.slice(0, 200) })),
        raw_head: xml.slice(0, 600)
      });
    } catch (e) { feeds.push({ publisher: feed.publisher, url: feed.url, status: 'error', error: e.message }); }
  }
  return { source: 'Presseportal RSS', feeds };
}
