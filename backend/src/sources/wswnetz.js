// WSW Netz GmbH: официальная карта störungen в сети высокого и среднего напряжения (Hoch- und Mittelspannung).
// Данные — статический JS-файл карты, который WSW перегенерирует (Cache-Control 10 мин). В спокойное время там один маркер
// с текстом «Derzeit keine Stromstörungen … bekannt» — он событием не считается. Любой другой маркер с текстом = сообщение WSW,
// показывается дословно (текст официальный). Домовые сети низкого напряжения карта НЕ покрывает.
// ВНИМАНИЕ: формат файла во время реального отключения не проверен; всё, что не удалось разобрать, считается в stats.unparsed
// (видно в результате запуска), события при этом не выдумываются.
import { fetchWithRetry, ISO, truncate } from '../util.js';
import { syncSource } from '../events.js';

export const meta = {
  id: 'wswnetz',
  name: 'WSW Netz (störungen в сети высокого и среднего напряжения)',
  intervalSec: 600,
  cron: '2-59/10 * * * *',
  group: 'infra'
};

export const URL_JS = 'https://www.wsw-netz.de/fileadmin/leaflet/WSW_Netz_Marker.js?version=v2';
export const PAGE = 'https://www.wsw-netz.de/leistung-service/netzstoerungen/';
const SCOPE = 'wswnetz/map';
const TTL_HOURS = 6; // продлевается при каждом запуске, пока маркер на карте
const BBOX = { lat: [51.15, 51.32], lon: [6.95, 7.35] };
const NO_OUTAGE = /derzeit\s+keine|keine\s+stromst\S*rungen[^.]{0,80}bekannt/i;

const ENT = { auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>' };
// В файле сущности без «;»: «St&oumlrungen»
const decode = (s) => String(s || '').replace(/&(auml|ouml|uuml|Auml|Ouml|Uuml|szlig|nbsp|amp|quot|lt|gt);?/g, (_, n) => ENT[n]);
const plain = (html) => decode(String(html).replace(/<\/(?:h\d|p|div|li)>|<br\s*\/?>/gi, '. ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/(?:\.\s*){2,}/g, '. ').trim();

// Маркеры карты: [{ lat, lon, html }]
export function parseMarkers(js) {
  const out = [];
  const re = /L\.marker\(\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]\s*\)[\s\S]{0,200}?\.bindPopup\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/g;
  for (const m of String(js || '').matchAll(re)) out.push({ lat: +m[1], lon: +m[2], html: m[3].slice(1, -1).replace(/\\(["'\\])/g, '$1') });
  return out;
}

export function analyze(js, nowMs) {
  const markers = parseMarkers(js);
  const items = [];
  let quiet = 0, unparsed = 0;
  for (const mk of markers) {
    const text = plain(mk.html);
    if (NO_OUTAGE.test(text)) { quiet++; continue; }
    if (!text || !Number.isFinite(mk.lat) || !Number.isFinite(mk.lon)
      || mk.lat < BBOX.lat[0] || mk.lat > BBOX.lat[1] || mk.lon < BBOX.lon[0] || mk.lon > BBOX.lon[1]) { unparsed++; continue; }
    const body = text.replace(/^WSW NETZ\.?\s*/i, '');
    items.push({
      source_event_id: `wswnetz:${mk.lat.toFixed(5)},${mk.lon.toFixed(5)}`,
      scope: SCOPE,
      publisher: 'WSW Netz',
      title: truncate(`Stromstörung: ${body}`, 200),
      description: truncate(body, 1200),
      category: 'infra_power',
      source_url: PAGE,
      latitude: mk.lat, longitude: mk.lon,
      geo_precision: 'source',
      location_name: null,
      event_time: null, time_precision: 'unknown',
      published_at: ISO(nowMs),
      expires_at: ISO(nowMs + TTL_HOURS * 3600e3),
      status: 'ACTIVE', status_reason: 'official_wsw_netz_map',
      confidence: 0.8, is_verified: 1
    });
  }
  return { markers: markers.length, quiet, unparsed, items };
}

async function fetchJs() {
  const res = await fetchWithRetry(URL_JS, { timeoutMs: 15000, retries: 2, backoffMs: 800, headers: { 'user-agent': 'WuppertalLive/1.0' } });
  if (!res.ok) throw new Error(`WSW Netz HTTP ${res.status}`);
  const js = await res.text();
  if (!/L\.map\(/.test(js)) throw new Error('WSW Netz: неожиданное содержимое (нет карты)');
  return js;
}

export async function probe(ctx) {
  const a = analyze(await fetchJs(), ctx && ctx.now ? ctx.now : Date.now());
  return { markers: a.markers, quiet: a.quiet, unparsed: a.unparsed, accepted: a.items.length, items: a.items.map((i) => ({ title: i.title, lat: i.latitude, lon: i.longitude })) };
}

export async function run(ctx) {
  const a = analyze(await fetchJs(), ctx.now);
  // Если маркеров нет вообще (сменился формат), ничего не закрываем: пустой разбор не доказывает отсутствие störungen
  const stats = await syncSource(ctx, meta.id, a.items, { resolveMissing: a.markers > 0 });
  return { ...stats, markers: a.markers, quiet: a.quiet, unparsed: a.unparsed, accepted: a.items.length };
}
