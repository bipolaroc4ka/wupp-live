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

function classifyWarning(text) {
  const t = text.toLowerCase();
  if (/unfall/.test(t)) return 'road_accident';
  if (/stau|stockend|zähfließend|zaehfliessend|verkehrsbehinderung/.test(t)) return 'road_jam';
  if (/gegenstand|gegenstände|fahrzeug|person|tier|gefahr|falschfahrer|verlorene|ladung|ölspur|glätte|nebel/.test(t)) return 'road_obstacle';
  return 'traffic_other';
}

function toItem(it, road, type) {
  if (it.future === true || it.future === 'true') return null;
  const { lat, lon } = coordOf(it);
  const hasCoord = lat != null && lon != null;
  if (!((hasCoord && inCityBbox(lat, lon)) || extentIntersects(it.extent))) return null;
  if (it.identifier == null) return null;

  const lines = Array.isArray(it.description) ? it.description : (it.description ? [it.description] : []);
  const descParts = [it.subtitle, ...lines].filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
  if (type === 'roadworks' && (it.isBlocked === true || it.isBlocked === 'true')) descParts.push('Vollsperrung');
  const text = `${it.title || ''} ${descParts.join(' ')}`;

  const start = Date.parse(it.startTimestamp || '');
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
    time_precision: Number.isFinite(start) ? 'minute' : 'unknown',
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
        const item = toItem(raw, road, t.path);
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
  const { text } = await fetchJson(`${BASE}/${road}/services/closure`);
  return { url: `${BASE}/${road}/services/closure`, sample: text.slice(0, 1500) };
}
