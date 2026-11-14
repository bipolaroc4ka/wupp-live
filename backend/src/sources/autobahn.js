// Autobahn GmbH — «Autobahn App API» (документирована проектом bundesAPI: autobahn.api.bund.dev).
// Данные: Baustellen (roadworks), Sperrungen (closure), Verkehrsmeldungen (warning) по каждой автобане.
// Координаты приходят от источника -> geo_precision = 'source'.
// Статусы:
//   warning  -> LIVE   (запись присутствует в текущей официальной ленте)
//   roadworks/closure -> ACTIVE (источник продолжает публиковать)
//   запись пропала из ленты два запуска подряд -> RESOLVED (см. syncSource)
// Будущие (future=true) записи не показываются: они ещё не действуют.
//
// Семантика времени:
//   event_time — фактическое время происшествия; Autobahn API его не сообщает.
//   valid_from — начало действия предупреждения / ограничения / фазы работ.
//   valid_until — конец текущей фазы, если он указан.
//   published_at — время публикации; источник его не сообщает.
//   expires_at — сохраняется для существующего механизма автоматического истечения.

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
const RE_END = new RegExp(`(?:^|\\n)\\s*Ende:\\s*${D}(?:\\s+um\\s+${T})?`, 'i');
const RE_BEGIN = new RegExp(`Beginn:\\s*${D}(?:\\s+um\\s+${T})?`, 'i');

const RE_DAY_WINDOW = new RegExp(`${D}\\s+von\\s+${T}\\s+bis\\s+${T}`, 'g');

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

const RE_DATE_RANGE = new RegExp(`${D}\\s+bis(?:\\s+zum)?\\s+${D}(?!\\s*(?:um\\s+)?\\d{1,2}:)`, 'g');
const RE_HEADER = /Zeiträumen gültig:?/i;

/**
 * Все окна, явно названные в тексте: «D T bis zum D T», «D von T bis T», «D bis D», отдельные даты в списке
 * после «…zu folgenden Zeiträumen gültig:». day=true — окно без времени (целые сутки).
 */
export function scheduleWindows(text) {
  const src = String(text || '');
  const out = [], seen = new Set();
  const push = (start, end, day = false) => {
    if (start == null || end == null || end < start) return;
    const k = `${start}|${end}`;
    if (!seen.has(k)) { seen.add(k); out.push({ start, end, day }); }
  };
  for (const m of src.matchAll(RE_PERIOD)) push(toMs(m[1], m[2], m[3], m[4], m[5]), toMs(m[6], m[7], m[8], m[9], m[10]));
  for (const m of src.matchAll(RE_DAY_WINDOW)) push(toMs(m[1], m[2], m[3], m[4], m[5]), toMs(m[1], m[2], m[3], m[6], m[7]));
  for (const m of src.matchAll(RE_DATE_RANGE)) push(toMs(m[1], m[2], m[3], 0, 0), toMs(m[4], m[5], m[6], 23, 59), true);
  // списки отдельных дат под заголовком
  let inList = false;
  for (const raw of src.split('\n')) {
    const line = raw.trim().replace(/\.$/, '');
    if (!line) { inList = false; continue; }
    if (RE_HEADER.test(line)) { inList = true; continue; }
    const m = inList && new RegExp(`^${D}$`).exec(line);
    if (m) push(toMs(m[1], m[2], m[3], 0, 0), toMs(m[1], m[2], m[3], 23, 59), true);
  }
  return out;
}

/**
 * Начало «текущего» периода по тексту: идущее сейчас окно, иначе «Beginn:» в прошлом, иначе последнее прошедшее окно,
 * иначе ближайшее запланированное. Только то, что явно написано в тексте; иначе { ms: null }.
 */
export function parseSchedule(text, now) {
  const windows = scheduleWindows(text);
  const prec = (w) => (w.day ? 'day' : 'minute');
  const current = windows.find((w) => w.start <= now && now <= w.end);
  if (current) return { ms: current.start, precision: prec(current) };

  const b = RE_BEGIN.exec(String(text || ''));
  const begin = b ? { ms: toMs(b[1], b[2], b[3], b[4] ?? null, b[5] ?? 0), precision: b[4] != null ? 'minute' : 'day' } : null;
  if (begin && begin.ms != null && begin.ms <= now) return begin;
  const past = windows.filter((w) => w.start <= now).sort((x, y) => y.start - x.start)[0];
  if (past) return { ms: past.start, precision: prec(past) };
  const next = windows.filter((w) => w.start > now).sort((x, y) => x.start - y.start)[0];
  if (next) return { ms: next.start, precision: prec(next) };
  if (begin && begin.ms != null) return begin;
  return { ms: null, precision: 'unknown' };
}

/** Конец фазы («Ende: …»), иначе конец последнего окна из списка «Zeiträume». Конец всей меры сюда не входит. */
export function parseExpiry(text) {
  const m = RE_END.exec(String(text || ''));
  if (m) return toMs(m[1], m[2], m[3], m[4] ?? 23, m[5] ?? 59);
  const w = scheduleWindows(text);
  return w.length ? Math.max(...w.map((x) => x.end)) : null;
}
export const parsePhaseEnd = parseExpiry;

// ---------- читаемое описание ----------
// Источник отдаёт абзацы текстом: «Die Baustelle ist zu folgenden Zeiträumen gültig: …», «Zeitraum dieser Bauphase: …»,
// «A1: Dortmund -> Köln, zwischen 0.4 km hinter X und 1.4 km vor Y», «Länge: 1.15 km | Max. 100 km/h | …».
// Раскладываем по строкам «Подпись: значение» (числа и даты в нейтральном виде, их же переводит structured.js).
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d, m, y) => `${pad(d)}.${pad(m)}.${Number(y) < 100 ? 2000 + Number(y) : y}`;
const hm = (h, m) => `${pad(h)}:${m}`;
const rx = (src) => new RegExp(src, 'i');
const RE_WIN_FULL = rx(`^${D}\\s+(?:um\\s+)?${T}\\s+bis(?:\\s+zum)?\\s+${D}\\s+(?:um\\s+)?${T}(?:\\s+Uhr)?$`);
const RE_WIN_DAY = rx(`^${D}\\s+von\\s+${T}\\s+bis\\s+${T}(?:\\s+Uhr)?$`);
const RE_WIN_DATE = rx(`^${D}$`);
const RE_WIN_RANGE = rx(`^${D}\\s+bis(?:\\s+zum)?\\s+${D}$`);
const stamp = (d, m, y, h, mi) => (h == null ? ymd(d, m, y) : `${ymd(d, m, y)} ${hm(h, mi)}`);
const RE_PHASE_LINE = (label) => rx(`^${label}:\\s*${D}(?:\\s+um\\s+${T}(?:\\s+Uhr)?)?$`);
const RE_TOTAL = rx(`^\\(?Ende der Gesamtmaßnahme:\\s*${D}\\)?\\.?$`);
const ABBREV = [[/\bErn\./g, 'Erneuerung'], [/\bInst\./g, 'Instandsetzung'], [/\bRtg\./g, 'Richtung']];
const comma = (v) => v.replace(/(\d+)\.(\d+)(?=\s*(?:km|m)\b)/g, '$1,$2');

function windowOf(line) {
  const s = line.replace(/\.$/, '').trim();
  let m = RE_WIN_FULL.exec(s);
  if (m) return `${stamp(m[1], m[2], m[3], m[4], m[5])} – ${stamp(m[6], m[7], m[8], m[9], m[10])}`;
  m = RE_WIN_DAY.exec(s);
  if (m) return `${ymd(m[1], m[2], m[3])}, ${hm(m[4], m[5])}–${hm(m[6], m[7])}`;
  m = RE_WIN_RANGE.exec(s);
  if (m) return `${ymd(m[1], m[2], m[3])} – ${ymd(m[4], m[5], m[6])}`;
  m = RE_WIN_DATE.exec(s);
  if (m) return ymd(m[1], m[2], m[3]);
  return null;
}

export function formatDescription({ subtitle, lines, route, blocked, projectLabel = 'Maßnahme' }) {
  const windows = [];
  const section = [], metrics = [], project = [], other = [];
  let begin = null, end = null, total = null, mode = null;

  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line) { mode = null; continue; }
    if (/^Die Baustelle ist zu folgenden Zeiträumen gültig:?$/i.test(line)) { mode = 'windows'; continue; }
    if (/^Zeitraum dieser Bauphase:?$/i.test(line)) { mode = 'phase'; continue; }
    let m;
    if (mode === 'windows') { const w = windowOf(line); if (w) { windows.push(w); continue; } mode = null; }
    if (mode === 'phase') {
      if ((m = RE_PHASE_LINE('Beginn').exec(line))) { begin = stamp(m[1], m[2], m[3], m[4], m[5]); continue; }
      if ((m = RE_PHASE_LINE('Ende').exec(line))) { end = stamp(m[1], m[2], m[3], m[4], m[5]); continue; }
      mode = null;
    }
    if ((m = RE_TOTAL.exec(line))) { total = ymd(m[1], m[2], m[3]); continue; }
    if (/(?:^|\|\s*)(?:Länge:|Max\.|Maximale Durchfahrtsbreite:)/.test(line)) { metrics.push(...line.split('|').map((x) => x.trim()).filter(Boolean)); continue; }
    if (/^[AB]\d+\s*:/.test(line) || /\bzwischen\b.+\bund\b/.test(line) || /^(?:Auffahrt|Abfahrt|Ausfahrt|Einfahrt)\b/.test(line)) { section.push(comma(line).replace(/\s*->\s*/g, ' → ')); continue; }
    project.push(ABBREV.reduce((t, [re, to]) => t.replace(re, to), line));
  }

  const out = [];
  const add = (label, value) => { if (value) out.push(`${label}: ${value}`); };
  // subtitle: либо направление («Köln -> Dortmund»), либо описание места («AS Wuppertal-Barmen (aus Richtung …)»)
  const sub = String(subtitle || '').trim();
  if (/->/.test(sub)) add('Richtung', sub.replace(/\s*->\s*/g, ' → '));
  else if (sub && !section.some((x) => x.includes(sub)) && !project.some((x) => x === sub)) add('Lage', sub);
  for (let i = project.length - 1; i >= 0; i--) if (section.some((x) => x.includes(project[i]))) project.splice(i, 1); // дубль строки участка
  add('Zeiträume', windows.join('; '));
  add('Bauphase', begin && end ? `${begin} – ${end}` : begin ? `seit ${begin}` : end ? `bis ${end}` : '');
  add('Gesamtmaßnahme bis', total);
  add('Abschnitt', section.join('; '));
  for (const item of metrics) {
    let m;
    if ((m = /^Länge:\s*(.+)$/.exec(item))) { if (!/nicht ermittelt/i.test(m[1])) add('Länge', comma(m[1])); }
    else if ((m = /^Max\.?\s*(\d+)\s*km\/h/.exec(item))) add('Tempolimit', `${m[1]} km/h`);
    else if ((m = /^Maximale Durchfahrtsbreite:\s*(.+)$/.exec(item))) add('Max. Durchfahrtsbreite', comma(m[1]));
    else other.push(item);
  }
  add(projectLabel, project.join('; '));
  if (blocked) other.push('Vollsperrung');
  add('Hinweis', other.join('; '));
  add('Umleitung', String(route || '').replace(/^Umleitung\s*:?\s*/i, ''));
  return out.map((l) => l.replace(/\s+$/, '')).join('\n') || null;
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
  const route = (Array.isArray(it.routeRecommendation) ? it.routeRecommendation : [])
    .map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  const blocked = type === 'roadworks' && (it.isBlocked === true || it.isBlocked === 'true');
  const description = formatDescription({
    subtitle: it.subtitle, lines, route, blocked, projectLabel: type === 'warning' ? 'Meldung' : 'Maßnahme'
  });
  const text = `${it.title || ''} ${it.subtitle || ''} ${lines.join(' ')} ${route}`;

  // startTimestamp и даты из description — начало действия, а не фактическое время происшествия.
  const stamped = Date.parse(it.startTimestamp || '');
  const parsed = Number.isFinite(stamped)
    ? { ms: stamped, precision: 'minute' }
    : parseSchedule(lines.join('\n'), now);

  const start = parsed.ms ?? null;
  const phaseEnd = parseExpiry(lines.join('\n'));

  if (phaseEnd != null && phaseEnd <= now) return null; // фаза закончилась: не показываем (иначе статус «мигал» бы)

  const category = type === 'roadworks' ? 'roadworks' : type === 'closure' ? 'road_closure' : classifyWarning(text);

  const validFrom = start != null ? new Date(start).toISOString() : null;
  const validUntil = phaseEnd != null ? new Date(phaseEnd).toISOString() : null;

  return {
    source_event_id: `${road}/${type}/${it.identifier}`,
    scope: `${road}/${type}`,
    publisher: 'Die Autobahn GmbH des Bundes',
    title: String(it.title || `${road}`).trim(),
    description,
    category,
    source_url: 'https://www.autobahn.de/',
    latitude: hasCoord ? lat : null,
    longitude: hasCoord ? lon : null,
    geo_precision: hasCoord ? 'source' : 'none',
    location_name: it.subtitle ? String(it.subtitle).trim() : `${road}`,

    // Фактическое время происшествия источник не предоставляет.
    event_time: null,
    time_precision: 'unknown',

    // Начало и конец периода действия.
    valid_from: validFrom,
    valid_from_precision: validFrom ? (parsed.precision || 'unknown') : 'unknown',
    valid_until: validUntil,
    valid_until_precision: validUntil ? (phaseEnd != null ? 'minute' : 'unknown') : 'unknown',

    published_at: null, // источник не сообщает время публикации
    expires_at: validUntil, // сохраняем для существующего механизма автоматического истечения
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
        // Проверяем, что начало и конец действия соответствуют строкам источника.
        city_samples: inCity.slice(0, 3).map((i) => ({
          title: i.title,
          event_time: i.event_time,
          time_precision: i.time_precision,
          valid_from: i.valid_from,
          valid_from_precision: i.valid_from_precision,
          valid_until: i.valid_until,
          valid_until_precision: i.valid_until_precision,
          description: (i.description || '').slice(0, 400)
        })),
        raw_sample: text.slice(0, 800)
      };
    } catch (e) {
      out.types[t.path] = { url, error: e.message };
    }
  }
  return out;
}
