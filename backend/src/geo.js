// Геокодирование улиц через Nominatim (OSM) с кэшем в D1.
// Правила Nominatim: не чаще 1 запроса/сек, обязательный идентифицирующий User-Agent, кэширование,
// без массового геокодирования. Поэтому: бюджет запросов на запуск + кэш + повтор позже.
//
// Точность честная:
//   street   — точка на найденной улице (на карте рисуется как приблизительная зона, не как адрес)
//   district — найден только район (на карте — приблизительная область по центру района)
//   none     — не найдено или не успели
// Номера домов НЕ используются: не показываем точные частные адреса.

import { CITY, inCityBbox } from './config.js';
import { fetchWithRetry, ISO, sleep } from './util.js';

const NEG_TTL_MS = 7 * 24 * 3600e3;

const SUFFIX_ONE = '(?:straße|strasse|weg|allee|platz|ufer|gasse|ring|damm|brücke|pfad|steig)';
const SUFFIX_CAP = '(?:Straße|Strasse|Weg|Allee|Platz|Ufer|Gasse|Ring|Damm|Brücke)';
// «Friedrich-Ebert-Straße»: части через дефис, последняя — с заглавной буквы
const RE_HYPHEN = new RegExp(`\\b([A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)*-${SUFFIX_CAP})\\b`);
// «Hardtstraße», «Ludwig-Richter-Straße» не подходит сюда, зато «Kaiser-Wilhelm-allee» и слитные имена — да
const RE_COMPOUND = new RegExp(`\\b([A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ]?[a-zäöüß]+)*${SUFFIX_ONE})\\b`);
const RE_ABBR = /\b([A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ]?[a-zäöüß]+)*str\.)/;
const RE_TWO = /\b([A-ZÄÖÜ][a-zäöüß]+(?:er|en|e)?)\s+(Straße|Strasse|Str\.|Weg|Allee|Platz|Ufer|Gasse|Ring|Damm|Brücke)\b/;

const NOT_STREETS = new Set(['Autobahn', 'Bundesstraße', 'Landstraße', 'Straße', 'Schnellstraße', 'Hauptstraße']);

// Возвращает название улицы (без номера дома) или null.
export function extractStreet(text) {
  if (!text) return null;
  const cands = [];
  for (const re of [RE_TWO, RE_HYPHEN, RE_COMPOUND, RE_ABBR]) {
    const m = text.match(re);
    if (m) cands.push({ idx: m.index, street: re === RE_TWO ? `${m[1]} ${m[2]}` : m[1] });
  }
  cands.sort((a, b) => a.idx - b.idx);
  for (const c of cands) {
    let s = c.street.replace(/\bStr\.$/, 'Straße').replace(/str\.$/, 'straße');
    if (!NOT_STREETS.has(s)) return s;
  }
  return null;
}

function precisionFromResult(r) {
  const cat = r.category || r.class;
  const type = r.addresstype || r.type;
  if (cat === 'highway') return 'street';
  if (['suburb', 'city_district', 'neighbourhood', 'quarter', 'borough'].includes(type)) return 'district';
  if (r.address && r.address.road) return 'street';
  return 'district';
}

// Возвращает { lat, lon, precision, district } | null (не найдено) | { pending: true } (нет бюджета).
export async function geocodeStreet(ctx, street) {
  const db = ctx.env.DB;
  const key = `street|${street.toLowerCase()}`;
  const cached = await db.prepare('SELECT * FROM geocode_cache WHERE key = ?').bind(key).first();
  if (cached) {
    if (cached.found) {
      return { lat: cached.lat, lon: cached.lon, precision: cached.precision, district: cached.district };
    }
    if (ctx.now - Date.parse(cached.created_at) < NEG_TTL_MS) return null;
  }
  if (ctx.geoBudget <= 0) return { pending: true };
  if (!ctx.env.NOMINATIM_CONTACT) throw new Error('NOMINATIM_CONTACT is not set (required by Nominatim usage policy)');

  ctx.geoBudget -= 1;
  const wait = 1100 - (Date.now() - (ctx.lastGeoAt || 0));
  if (ctx.lastGeoAt && wait > 0) await sleep(wait);
  ctx.lastGeoAt = Date.now();

  const b = CITY.bbox;
  const q = new URLSearchParams({
    format: 'jsonv2', addressdetails: '1', limit: '1',
    street, city: CITY.name, country: 'Germany',
    viewbox: `${b.minLon},${b.maxLat},${b.maxLon},${b.minLat}`, bounded: '1'
  });
  const res = await fetchWithRetry(`https://nominatim.openstreetmap.org/search?${q}`, {
    headers: {
      'user-agent': `WuppertalLive/0.1 (${ctx.env.NOMINATIM_CONTACT})`,
      'accept-language': 'de',
      accept: 'application/json'
    },
    timeoutMs: 10000, retries: 1
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const arr = await res.json();
  const r = Array.isArray(arr) ? arr[0] : null;
  const lat = r ? parseFloat(r.lat) : NaN;
  const lon = r ? parseFloat(r.lon) : NaN;

  if (!r || !Number.isFinite(lat) || !Number.isFinite(lon) || !inCityBbox(lat, lon)) {
    await db.prepare('INSERT OR REPLACE INTO geocode_cache (key, found, created_at) VALUES (?, 0, ?)')
      .bind(key, ISO(ctx.now)).run();
    return null;
  }
  const a = r.address || {};
  const district = a.suburb || a.city_district || a.borough || null;
  const precision = precisionFromResult(r);
  await db.prepare(
    'INSERT OR REPLACE INTO geocode_cache (key, found, lat, lon, precision, district, display_name, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)'
  ).bind(key, lat, lon, precision, district, r.display_name || null, ISO(ctx.now)).run();
  return { lat, lon, precision, district };
}
