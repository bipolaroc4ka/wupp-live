// Autobahn GmbH — «Autobahn App API» (документирована проектом bundesAPI: autobahn.api.bund.dev).
// Данные: Baustellen (roadworks), Sperrungen (closure), Verkehrsmeldungen (warning) по каждой автобане.
// Координаты приходят от источника -> geo_precision = 'source'.
// Статусы:
//   warning  -> LIVE   (запись присутствует в текущей официальной ленте)
//   roadworks/closure -> ACTIVE (источник продолжает публиковать)
//   запись пропала из ленты два запуска подряд -> RESOLVED (см. syncSource)
// Будущие (future=true) записи не показываются: они ещё не действуют.

import { CITY, inCityBbox } from '../config.js';
import { fetchJson } from '../util.js';
import { syncSource } from '../events.js';
import { berlinToUtc } from '../time.js';

export const meta = {
  id: 'autobahn',
  name: 'Autobahn GmbH (Autobahn App API)',
  intervalSec: 120,
  cron: '*/2 * * * *',
  group: 'traffic'
};

const BASE = 'https://verkehr.autobahn.de/o/autobahn';
const TYPES = [
  { path: 'roadworks', key: 'roadworks' },
  { path: 'closure', key: 'closure' },
  { path: 'warning', key: 'warning' }
];

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

function coordOf(it) {
  const c = it.coordinate || {};
  return { lat: num(c.lat ?? c.latitude), lon: num(c.long ?? c.lon ?? c.lng ?? c.longitude) };
}

function extentIntersects(ext) {
  if (!ext) return false;
  const p = String(ext).split(',').map(parseFloat);
  if (p.length !== 4 || p.some((x) => Number.isNaN(x))) return false;
  const [minLon, minLat, maxLon, maxLat] = p;
  const b = CITY.bbox;
  return !(maxLon < b.minLon || minLon > b.maxLon || maxLat < b.minLat || minLat > b.maxLat);
}

// ---------- сроки из текста описания ----------
// В реальных ответах startTimestamp нет, а сроки лежат в строках description:
//   «Die Baustelle ist zu folgenden Zeiträumen gültig:» / «14.11.26 03:00 bis zum 15.11.26 23:00 Uhr.»
//   «Zeitraum dieser Bauphase:» / «Beginn: 07.11.25 um 20:00 Uhr»
//   «(Ende der Gesamtmaßnahme: 01.01.31)»
const D = String.raw`(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})`;
const T = String.raw`(\d{1,2}):(\d{2})`;
const RE_PERIOD = new RegExp(`${D}\\s+(?:um\\s+)?${T}\\s+bis(?:\\s+zum)?\\s+${D}\\s+(?:um\\s+)?${T}`, 'g');
const RE_BEGIN = new RegExp(`Beginn:\\s*${D}(?:\\s+um\\s+${T})?`, 'i');

function toMs(d, m, y, h = null, mi = 0) {
  let year = Number(y);
  if (year < 100) year += 2000;
  const day = Number(d), month = Number(m);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const chk = new Date(Date.UTC(year, month - 1, day));
  if (chk.getUTCMonth() !== month - 1 || chk.getUTCDate() !== day) return null;
  if (h != null && (Number(h) > 23 || Number(mi) > 59)) return null;
  return berlinToUtc(year, month, day, h == null ? 0 : Number(h), Number(mi));
}

/**
 * Начало «текущего» периода по тексту: идущее сейчас окно, иначе «Beginn:», иначе последнее прошедшее окно.
 * Только то, что явно написано в тексте; иначе { ms: null }.
 */
export function parseSchedule(text, now) {
  const windows = [];
  for (const m of String(text || '').matchAll(RE_PERIOD)) {
    const start = toMs(m[1], m[2], m[3], m[4], m[5]);
    const end = toMs(m[6], m[7], m[8], m[9], m[10]);
    if (start != null && end != null && end >= start) windows.push({ start, end });
  }
  const current = windows.find((w) => w.start <= now && now <= w.end);
  if (current) return { ms: current.start, precision: 'minute' };

  const b = RE_BEGIN.exec(String(text || ''));
  if (b) {
    const ms = toMs(b[1], b[2], b[3], b[4] ?? null, b[5] ?? 0);
    if (ms != null && ms <= now) return { ms, precision: b[4] != null ? 'minute' : 'day' };
  }
  const past = windows.filter((w) => w.start <= now).sort((x, y) => y.start - x.start)[0];
  if (past) return { ms: past.start, precision: 'minute' };
  return { ms: null, precision: 'unknown' };
}

function classifyWarning(text) {
  const t = text.toLowerCase();
  if (/unfall/.test(t)) return 'road_accident';
  if (/stau|stockend|zähfließend|zaehfliessend|verkehrsbehinderung/.test(t)) return 'road_jam';
  if (/gegenstand|gegenstände|fahrzeug|person|tier|gefahr|falschfahrer|verlorene|ladung|ölspur|glätte|nebel/.test(t)) return 'road_obstacle';
  return 'traffic_other';
}

function toItem(it, road, type, now = Date.now()) {
  if (it.future === true || it.future === 'true') return null;
  const { lat, lon } = coordOf(it);
  const hasCoord = lat != null && lon != null;
  if (!((hasCoord && inCityBbox(lat, lon)) || extentIntersects(it.extent))) return null;
  if (it.identifier == null) return null;

  const lines = Array.isArray(it.description) ? it.description : (it.description ? [it.description] : []);
  const descParts = [it.subtitle, ...lines].filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
  if (type === 'roadworks' && (it.isBlocked === true || it.isBlocked === 'true')) descParts.push('Vollsperrung');
  const route = (Array.isArray(it.routeRecommendation) ? it.routeRecommendation : [])
    .map((x) => String(x || '').trim()).filter(Boolean);
  if (route.length) descParts.push(`Umleitung: ${route.join(' ')}`);
  const text = `${it.title || ''} ${descParts.join(' ')}`;

  const stamped = Date.parse(it.startTimestamp || '');
  const parsed = Number.isFinite(stamped) ? { ms: stamped, precision: 'minute' } : parseSchedule(lines.join('\n'), now);
  const start = parsed.ms ?? NaN;
  const category = type === 'roadworks' ? 'roadworks' : type === 'closure' ? 'road_closure' : classifyWarning(text);

  return {
    source_event_id: `${road}/${type}/${it.identifier}`,
    scope: `${road}/${type}`,
    publisher: 'Die Autobahn GmbH des Bundes',
    title: String(it.title || `${road}`).trim(),
    description: descParts.join(' · ') || null,
    category,
    source_url: 'https://www.autobahn.de/',
    latitude: hasCoord ? lat : null,
    longitude: hasCoord ? lon : null,
    geo_precision: hasCoord ? 'source' : 'none',
    location_name: it.subtitle ? String(it.subtitle).trim() : `${road}`,
    event_time: Number.isFinite(start) ? new Date(start).toISOString() : null,
    time_precision: Number.isFinite(start) ? parsed.precision : 'unknown',
    published_at: null, // источник не сообщает время публикации
    status: type === 'warning' ? 'LIVE' : 'ACTIVE',
    status_reason: 'listed_in_current_source_feed',
    confidence: hasCoord ? 0.9 : 0.6,
    is_verified: 1
  };
}

function listOf(json, key) {
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json[key])) return json[key];
  const firstArr = Object.values(json).find(Array.isArray);
  return firstArr || [];
}

export async function run(ctx) {
  const roads = (ctx.env.AUTOBAHN_ROADS || 'A1,A46,A535,A43').split(',').map((s) => s.trim()).filter((s) => /^A\d{1,3}$/.test(s));
  const items = [];
  const okScopes = new Set();
  let failures = 0, lastErr = null;

  await Promise.all(roads.flatMap((road) => TYPES.map(async (t) => {
    try {
      const { status, json } = await fetchJson(`${BASE}/${road}/services/${t.path}`);
      okScopes.add(`${road}/${t.path}`);
      if (status === 204) return;
      for (const raw of listOf(json, t.key)) {
        const item = toItem(raw, road, t.path, ctx.now);
        if (item) items.push(item);
      }
    } catch (e) {
      failures += 1; lastErr = e;
      ctx.log(`autobahn ${road}/${t.path}: ${e.message}`);
    }
  })));

  if (okScopes.size === 0) throw lastErr || new Error('all Autobahn requests failed');
  const stats = await syncSource(ctx, meta.id, items, { resolveMissing: true, resolvedScopes: okScopes });
  return { ...stats, partial_failures: failures };
}

export async function probe(ctx) {
  const road = (ctx.env.AUTOBAHN_ROADS || 'A46').split(',')[0].trim();
  const out = { road, types: {} };
  for (const t of TYPES) {
    const url = `${BASE}/${road}/services/${t.path}`;
    try {
      const { json, text } = await fetchJson(url, { retries: 0 });
      const all = listOf(json, t.key);
      const inCity = all.map((raw) => toItem(raw, road, t.path, ctx.now)).filter(Boolean);
      out.types[t.path] = {
        url, total: all.length, in_city: inCity.length,
        // что разобрано из текста: проверьте, что event_time и описание соответствуют строкам источника
        city_samples: inCity.slice(0, 3).map((i) => ({ title: i.title, event_time: i.event_time, time_precision: i.time_precision, description: (i.description || '').slice(0, 400) })),
        raw_sample: text.slice(0, 800)
      };
    } catch (e) { out.types[t.path] = { url, error: e.message }; }
  }
  return out;
}
