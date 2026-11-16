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
const DESCRIPTION_LIMIT = 900;        // для короткого текста из ленты
const FULLTEXT_LIMIT = 3500;          // для полного текста релиза
const FULLTEXT_PER_RUN = 6;           // страниц релизов за запуск (лимит Workers Free — 50 подзапросов)
const MAX_PAGE_CHARS = 1_500_000;

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

// Служебные части анонса в ленте: «… [ Newsroom ]» в начале, «Lesen Sie hier weiter...» и «Original-Content von: …, übermittelt durch news aktuell».
function stripBoilerplate(text) {
  return String(text || '')
    .replace(/^[^\n]*\[\s*Newsroom\s*\]\s*\n?/i, '') // «Feuerwehr Wuppertal [ Newsroom ]» — ссылка перед текстом
    .replace(/\s*Lesen Sie hier weiter\s*(?:\.{3}|…)?/gi, '')
    .replace(/\s*Original-Content von:[^\n]*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseRss(xml) {
  const items = [];
  for (const match of String(xml || '').matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)) {
    const x = match[1];
    const title = cleanHtml(getTag(x, 'title'));
    // В ленте бывает и анонс (description), и полный текст (content:encoded): берём более длинный
    const d1 = cleanHtml(getTag(x, 'description')), d2 = cleanHtml(getTag(x, 'content:encoded'));
    const description = stripBoilerplate(d2.length > d1.length ? d2 : d1);
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

// Районы Wuppertal: в дата-строке релиза бывает не «Wuppertal», а район («Barmen (ots)», «Wuppertal-Vohwinkel (ots)»).
const DISTRICT_NAMES = ['Oberbarmen', 'Unterbarmen', 'Barmen', 'Wichlinghausen', 'Heckinghausen', 'Nächstebreck', 'Langerfeld', 'Beyenburg',
  'Elberfeld', 'Sonnborn', 'Uellendahl', 'Katernberg', 'Ronsdorf', 'Cronenberg', 'Küllenhahn', 'Vohwinkel', 'Dönberg', 'Langenfeld',
  'Hahnerberg', 'Arrenberg', 'Ölberg', 'Hatzfeld', 'Varresbeck', 'Nordstadt', 'Südstadt'];
// Названия, совпадающие с другими городами или словами: считаются районом только с «Wuppertal-» / «Ortsteil» / «Stadtteil»
const AMBIGUOUS_DISTRICTS = new Set(['Langenfeld', 'Hatzfeld', 'Nordstadt', 'Südstadt', 'Katernberg']);
const DISTRICT_RE = new RegExp(`(?<![\\p{L}-])(Wuppertal[- ]\\s?)?(${DISTRICT_NAMES.join('|')})(?![\\p{L}])`, 'giu');
const canonDistrict = (name) => DISTRICT_NAMES.find((d) => d.toLowerCase() === String(name).toLowerCase()) || null;

// Район из текста: самое раннее надёжное упоминание или null.
export function extractDistrict(text) {
  const t = String(text || '');
  for (const m of t.matchAll(DISTRICT_RE)) {
    const name = canonDistrict(m[2]);
    if (!name) continue;
    if (AMBIGUOUS_DISTRICTS.has(name) && !m[1] && !/(?:Ortsteil|Stadtteil|Quartier)\s+$/i.test(t.slice(Math.max(0, m.index - 14), m.index))) continue;
    return name;
  }
  return null;
}

// Район из дата-строки: «Barmen», «Wuppertal-Vohwinkel», «Wuppertal / Elberfeld».
function districtFromDateline(line) {
  const m = /^(?:Wuppertal\s*[-\/–]?\s*)?(\S.*)$/i.exec(String(line || '').trim());
  return m ? canonDistrict(m[1].trim()) : null;
}

// Заголовки: «FW-W: …», «POL-W: W …» (Wuppertal), «POL-W: SG …» (Solingen), «POL-W: RS …» (Remscheid).
// Полицейская лента Wuppertal объединяет три города, код города стоит после «POL-W:». В заголовке карточки он не нужен.
const POL_CODE_RE = /^POL-W\s*(?:\(\d+\))?\s*:\s*(W|SG|RS)(?![\p{L}])/iu;
const normalizeTitle = (t) => String(t || '')
  .replace(/^(?:FW|POL)-[A-Z]+\s*(?:\(\d+\))?\s*:\s*(?:(?:W|SG|RS)(?![\p{L}])[\s:–-]*)?/iu, '')
  .trim();

// Относится ли релиз к городу Wuppertal.
function isWuppertal(line, title, body, feedType) {
  if (line) return /^wuppertal\b/i.test(line) || districtFromDateline(line) !== null;
  // Без дата-строки город может вообще не упоминаться (релиз называет только улицу). Тогда решает код в заголовке:
  // «POL-W: W …» — Wuppertal, «POL-W: SG …» / «POL-W: RS …» (и старые «POL-SG» / «POL-RS») — Solingen / Remscheid.
  // «FW-W» — пожарная служба Wuppertal. Лента пожарных целиком относится к Wuppertal.
  const code = POL_CODE_RE.exec(title);
  if (code) return code[1].toUpperCase() === 'W';
  if (/^(?:POL|FW)-(?:RS|SG)\b/i.test(title)) return false;
  if (/^FW-W\b/i.test(title)) return true;
  const head = `${title} ${body.slice(0, 160)}`;
  if (feedType === 'police') return (/wuppertal/i.test(head) || extractDistrict(head) !== null) && !/remscheid|solingen/i.test(head);
  return !/remscheid|solingen/i.test(head);
}

function toItem(story, feed, nowMs, ttlMs, rejects = null) {
  const no = (reason) => { if (rejects) rejects[reason] = (rejects[reason] || 0) + 1; return null; };
  const title0 = String(story.title || '').trim();
  const body = String(story.description || '').trim();
  const published = Date.parse(story.pubDate);
  if (!story.id || !title0 || !Number.isFinite(published)) return no('без даты публикации'); // без времени публикации не показываем
  if (published > nowMs + 10 * 60 * 1000) return no('дата из будущего');
  if (nowMs - published > MAX_AGE_DAYS * 24 * 3600e3) return no('старше 7 дней');

  const expiresMs = published + ttlMs;
  if (nowMs >= expiresMs) return no(`старше TTL (${Math.round(ttlMs / 3600e3)} ч)`); // просроченное не сохраняем: статус не должен «мигать»

  const line0 = dateline(body);
  if (!isWuppertal(line0, title0, body, feed.type)) return no(`не Wuppertal (${line0 || 'без дата-строки'})`);

  const title = normalizeTitle(title0) || title0;
  const clean = body.replace(DATELINE_RE, '').trim();
  const eventText = `${title0}. ${body}`;
  const et = parseEventTime(eventText, published);
  const street = extractStreet(eventText);
  // Район: из дата-строки («Barmen (ots)»), иначе из заголовка/текста. Если улицы нет, место = район.
  const districtName = districtFromDateline(line0) || extractDistrict(`${title0}. ${body}`);

  const item = {
    source_event_id: `${feed.id}:${story.id}`, // префикс исключает коллизии между лентами
    publisher: feed.publisher,
    title,
    description: truncate(clean, DESCRIPTION_LIMIT) || null,
    category: classify(`${title0} ${body}`, feed.type),
    source_url: safeStoryUrl(story.link, story.id),
    geo_precision: !street && districtName ? 'district' : 'none',
    district: !street && districtName ? districtName : null,
    location_name: street || districtName || null,
    event_time: et.ms != null ? new Date(et.ms).toISOString() : null,
    time_precision: et.precision,
    published_at: new Date(published).toISOString(),
    status: 'RECENT',
    status_reason: 'press_release_actuality_unknown',
    confidence: 0.5,
    is_verified: 1,
    expires_at: new Date(expiresMs).toISOString() // стабильный: от публикации, а не от «сейчас»
  };

  item.enrich = async (ctx) => {
    let street2 = street;
    if (isTeaser(clean) && (ctx.fullTextBudget ??= FULLTEXT_PER_RUN) > 0 && item.source_url !== 'https://www.presseportal.de/') {
      ctx.fullTextBudget -= 1;
      try {
        const { text: got, diag } = await fetchArticle(item.source_url, clean);
        const full = got || '';
        if (!got) ctx.log(`presseportal fulltext: не найден (${JSON.stringify(diag)})`);
        const fullClean = full.replace(DATELINE_RE, '').trim();
        if (fullClean.length > clean.length) {
          item.description = truncate(fullClean, FULLTEXT_LIMIT);
          // в полном тексте могут оказаться улица и время, которых не было в анонсе
          const t2 = parseEventTime(`${title0}. ${full}`, published);
          if (t2.ms != null && (item.event_time == null || t2.precision === 'minute')) {
            item.event_time = new Date(t2.ms).toISOString(); item.time_precision = t2.precision;
          }
          if (!street2) {
            street2 = extractStreet(`${title0}. ${full}`);
            if (street2) item.location_name = street2;
          }
        }
      } catch (e) { ctx.log(`presseportal fulltext: ${e.message}`); }
    }
    if (!street2) return;
    const g = await geocodeStreet(ctx, street2);
    if (!g) {
      item.geocode_attempts = 1;
      if (districtName) { item.geo_precision = 'district'; item.district = districtName; } // улицу не нашли, район известен из текста
      return;
    }
    if (g.pending) return; // позже повторит retryGeocoding
    item.geo_precision = g.precision;
    item.district = g.district || districtName || null;
    item.confidence = 0.6;
    if (g.precision === 'street') { item.latitude = g.lat; item.longitude = g.lon; }
    // district: координаты не сохраняем — на карте рисуется только приблизительная область района
  };
  return item;
}

// ---------- полный текст релиза ----------
// В RSS приходит анонс, обрезанный на «...». Полный текст берём со страницы релиза (schema.org articleBody в JSON-LD),
// только для новых записей и в пределах бюджета запросов. Не получилось — остаётся анонс из ленты.
const isTeaser = (text) => /(?:\.\.\.|…)\s*$/.test(String(text || ''));

const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
const FOOTER_RE = /^(?:Original-Content von|Rückfragen|Pressekontakt|Presse-?kontakt|Kontakt:|Quelle:|Weitere Meldungen|Diese Meldung)/i;

function articleBodyFromJsonLd(page) {
  for (const m of page.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const stack = Array.isArray(data) ? [...data] : [data];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (typeof node.articleBody === 'string' && node.articleBody.trim().length > 80) return cleanHtml(node.articleBody);
      for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

// Запасной путь без привязки к разметке: страница переводится в текст по строкам, ищется строка с началом анонса
// и берутся строки до служебного хвоста («Original-Content von…», контакты). Нет хвоста — не берём ничего:
// иначе в текст попали бы меню и соседние блоки.
function articleBodyFromText(page, hint, diag = null) {
  const key = norm(String(hint || '').replace(DATELINE_RE, '')).slice(0, 40);
  if (key.length < 20) return null;
  const lines = cleanHtml(page).split('\n').map((l) => l.trim()).filter(Boolean);
  const start = lines.findIndex((l) => norm(l).includes(key));
  if (diag) diag.key_found = start >= 0;
  if (start < 0) return null;
  const out = [];
  let closed = false;
  for (const l of lines.slice(start, start + 80)) {
    if (out.length && FOOTER_RE.test(l)) { closed = true; break; }
    out.push(l);
  }
  if (diag) { diag.footer_found = closed; diag.window = out.join(' ').slice(0, 300); }
  return closed ? out.join('\n\n') : null;
}

export function articleBodyFromHtml(html, hint = '', diag = null) {
  const page = String(html || '');
  return articleBodyFromJsonLd(page) || articleBodyFromText(page.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' '), hint, diag);
}

// Возвращает { text, diag }: diag нужен для «Пробы» (почему полный текст не найден).
async function fetchArticle(url, hint = '') {
  const diag = { url };
  const res = await fetchWithRetry(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      'accept-language': 'de-DE,de;q=0.9',
      'user-agent': 'WuppertalLive/1.0 (+https://github.com/bipolaroc4ka/wupp-live)'
    },
    timeoutMs: 8000, retries: 0
  });
  diag.status = res.status;
  if (!res.ok) return { text: null, diag };
  const html = await res.text();
  diag.chars = html.length;
  diag.has_json_ld = /application\/ld\+json/i.test(html);
  diag.paragraphs = (html.match(/<p\b/gi) || []).length;
  if (html.length > MAX_PAGE_CHARS) { diag.too_large = true; return { text: null, diag }; }
  diag.ld_types = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => { try { const d = JSON.parse(m[1].trim()); return Array.isArray(d) ? d.map((x) => x['@type']) : (d['@graph'] ? d['@graph'].map((x) => x['@type']) : d['@type']); } catch { return 'invalid'; } });
  const text = articleBodyFromHtml(html, hint, diag);
  diag.found = !!text;
  return { text, diag };
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
  const ttlMs = Math.max(1, parseFloat(ctx.env.PRESS_TTL_HOURS) || 48) * 3600e3;
  const items = [];
  let ok = 0, lastErr = null;

  for (const feed of FEEDS) {
    try {
      const { stories } = await fetchFeed(feed);
      ok += 1;
      let accepted = 0;
      const rejects = {};
      for (const story of stories) {
        const it = toItem(story, feed, ctx.now, ttlMs, rejects);
        if (it) { items.push(it); accepted += 1; }
      }
      ctx.log(`presseportal ${feed.type}: RSS items=${stories.length}, accepted=${accepted}, отброшено: ${JSON.stringify(rejects)}`);
    } catch (e) {
      lastErr = e;
      ctx.log(`presseportal ${feed.type}: ${e.message}`);
    }
  }
  if (!ok) throw lastErr || new Error('All Presseportal RSS feeds failed');
  // Релизы не «завершаются» по исчезновению из ленты: их актуальность ограничивается только TTL.
  return syncSource(ctx, meta.id, items, { resolveMissing: false });
}

async function probeFullText(story) {
  if (!story) return null;
  try {
    const url = safeStoryUrl(story.link, story.id);
    const { text, diag } = await fetchArticle(url, story.description);
    return { ...diag, found: !!text, chars_text: text ? text.length : 0, rss_chars: story.description.length, head: text ? text.slice(0, 200) : null };
  } catch (e) { return { error: e.message }; }
}

// Проверка через «Проба» в админке.
export async function probe(ctx) {
  const ttlMs = Math.max(1, parseFloat(ctx?.env?.PRESS_TTL_HOURS) || 48) * 3600e3;
  const feeds = [];
  for (const feed of FEEDS) {
    try {
      const { xml, stories } = await fetchFeed(feed);
      feeds.push({
        publisher: feed.publisher, url: feed.url, status: 'ok', items: stories.length,
        datelines: stories.slice(0, 15).map((s) => dateline(s.description)),
        // что стало с каждым релизом: принят или причина отказа (и найденные улица/район)
        decisions: stories.map((st) => {
          const rej = {};
          const it = toItem(st, feed, Date.now(), ttlMs, rej);
          return it
            ? { title: st.title.slice(0, 70), accepted: true, location: it.location_name, geo: it.geo_precision }
            : { title: st.title.slice(0, 70), accepted: false, reason: Object.keys(rej)[0] || '?' };
        }),
        sample: stories.slice(0, 3).map((s) => ({ title: s.title, pubDate: s.pubDate, link: s.link, description: s.description.slice(0, 200) })),
        raw_head: xml.slice(0, 600),
        teaser_like: stories.slice(0, 5).map((s) => isTeaser(s.description)),
        fulltext_check: await probeFullText(stories[0])
      });
    } catch (e) { feeds.push({ publisher: feed.publisher, url: feed.url, status: 'error', error: e.message }); }
  }
  return { source: 'Presseportal RSS', feeds };
}
