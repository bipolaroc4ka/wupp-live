// Wuppertaler Rundschau (Rheinische Post Mediengruppe): НЕОФИЦИАЛЬНЫЙ источник, только заголовок и ссылка на оригинал.
// Текст статьи и тизер не сохраняются и не показываются (платный контент издательства); тизер используется только
// для распознавания улицы и типа происшествия. Берутся лишь сообщения о происшествиях в Вупперталь; спорт, афиша, политика отбрасываются.
// Метка в интерфейсе: is_verified = 0 («Неофициально»). Достоверность событий выше у Presseportal/NINA, при совпадении приоритет у них.
import { fetchWithRetry, ISO, truncate } from '../util.js';
import { extractStreet, geocodeStreet } from '../geo.js';
import { syncSource } from '../events.js';
import { extractDistrict } from './presseportal.js';
import { parseFeed as parseXml } from './wsw.js';

export const meta = {
  id: 'rundschau',
  name: 'Wuppertaler Rundschau (неофициально: заголовок и ссылка)',
  intervalSec: 600,
  cron: '2-59/10 * * * *',
  group: 'news'
};

export const FEED = 'https://www.wuppertaler-rundschau.de/feed.rss';
const SCOPE = 'rundschau/headlines';
const TTL_HOURS = 36;
const MAX_AGE_HOURS = 30;
const HOUR = 3600000;

// Тема происшествия: категория определяется по заголовку, затем по тизеру
const CATEGORIES = [
  ['hazard', /molotow|brandsatz|sprengs|explosion|bombe|kampfmittel|gasaustritt|gefahrstoff|evakuier/i],
  ['fire', /\b\w*brand\b|\bfeuer(?!wehr)\w*|rauchentwicklung|löscharbeiten|flammen/i],
  ['accident', /verkehrsunfall|unfall|kollision|zusammenstoß|stromschlag/i],
  ['police', /überfall|raub|messer|festnahme|razzia|durchsuchung|schüsse|schuss|angriff|schlägerei|einbruch|diebstahl|stehlen|gestohlen|vermisst|fahndung|tatverdächtig|ermittlung|polizei|körperverletzung|bedroh/i]
];
// Не происшествия: спорт, афиша, бизнес, политика
const SKIP_URL = /\/(sport|freizeit|kultur|wirtschaft|politik|panorama|ratgeber|leserbriefe|anzeigen)\//i;
const SKIP_TITLE = /^(?:bilderstrecke|handball|fußball|bhc|wsv|interview|kommentar)\b|spendenmarathon|winterdienst|weihnachtsmarkt/i;

export const parseFeed = (xml) => parseXml(xml, safeUrl);
const clean = (v) => String(v || '').replace(/([a-zäöüß])([A-ZÄÖÜ])/g, '$1 $2').trim();

export function safeUrl(u) {
  try {
    const x = new URL(String(u || '').replace(/^http:\/\//i, 'https://'));
    return x.protocol === 'https:' && /(^|\.)wuppertaler-rundschau\.de$/i.test(x.hostname) ? x.href : '';
  } catch { return ''; }
}

export function classify(title, teaser) {
  for (const src of [title, `${title}. ${teaser}`]) for (const [cat, re] of CATEGORIES) if (re.test(src)) return cat;
  return null;
}

export function toItem(story, nowMs) {
  const url = safeUrl(story.url);
  if (!url) return { reason: 'ссылка не с wuppertaler-rundschau.de' };
  if (nowMs - story.published > MAX_AGE_HOURS * HOUR) return { reason: 'старше 30 часов' };
  if (story.published > nowMs + 10 * 60000) return { reason: 'дата из будущего' };
  if (SKIP_URL.test(url) || SKIP_TITLE.test(story.title)) return { reason: 'не происшествие (раздел/тема)' };
  const category = classify(story.title, story.description);
  if (!category) return { reason: 'нет признаков происшествия' };

  const all = `${story.title}. ${story.description}`;
  // Улица: в тизере склейки вроде «Normannenstraßein Wuppertal» — разделяем перед поиском
  const street = extractStreet(clean(all).replace(/(straße|strasse|weg|platz|allee|ufer)(in|im|an|auf|bei|am)\s/gi, '$1 $2 '));
  const district = extractDistrict(all);
  if (!street && !district) return { reason: 'нет улицы или района Вупперталя' };

  const item = {
    source_event_id: url,
    scope: SCOPE,
    publisher: 'Wuppertaler Rundschau',
    title: truncate(story.title, 200),
    description: null, // текст издательства не копируем
    category,
    source_url: url,
    geo_precision: !street && district ? 'district' : 'none',
    district: !street && district ? district : null,
    location_name: street || district || null,
    event_time: null,
    time_precision: 'unknown',
    published_at: ISO(story.published),
    expires_at: ISO(story.published + TTL_HOURS * HOUR),
    status: 'RECENT',
    status_reason: 'unofficial_local_press_headline',
    confidence: street ? 0.5 : 0.4,
    is_verified: 0
  };
  item.enrich = async (ctx) => {
    if (!street) return;
    const g = await geocodeStreet(ctx, street);
    if (!g) { item.geocode_attempts = 1; return; }
    if (g.pending) return;
    item.geo_precision = g.precision;
    item.district = g.district || district || null;
    if (g.precision === 'street') { item.latitude = g.lat; item.longitude = g.lon; }
  };
  return { item };
}

async function fetchFeed() {
  const res = await fetchWithRetry(FEED, {
    timeoutMs: 12000, retries: 2, backoffMs: 800,
    headers: { accept: 'application/rss+xml, application/xml, text/xml', 'user-agent': 'WuppertalLive/1.0 (headline links only)' }
  });
  if (!res.ok) throw new Error(`Rundschau feed HTTP ${res.status}`);
  const xml = await res.text();
  if (!/<rss\b|<feed\b/i.test(xml)) throw new Error('Rundschau feed returned unexpected content');
  return xml;
}

export async function probe(ctx) {
  const now = ctx && ctx.now ? ctx.now : Date.now();
  const stories = parseFeed(await fetchFeed());
  const items = stories.map((s) => {
    const r = toItem(s, now);
    return { title: s.title, published: new Date(s.published).toISOString(), accepted: !!r.item, reason: r.item ? null : r.reason, ...(r.item ? { category: r.item.category, place: r.item.location_name } : {}) };
  });
  return { entries: stories.length, accepted: items.filter((i) => i.accepted).length, items };
}

export async function run(ctx) {
  const stories = parseFeed(await fetchFeed());
  const items = [], rejects = {};
  for (const s of stories) {
    const r = toItem(s, ctx.now);
    if (r.item) items.push(r.item); else rejects[r.reason] = (rejects[r.reason] || 0) + 1;
  }
  const stats = await syncSource(ctx, meta.id, items, { resolveMissing: false });
  return { ...stats, feed_items: stories.length, accepted: items.length, rejected: rejects, sample: items.slice(0, 5).map((i) => ({ title: i.title, category: i.category, place: i.location_name })) };
}
