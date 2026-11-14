// NINA / Bundesamt für Bevölkerungsschutz — официальные предупреждения (MOWAS, DWD, KATWARN, BIWAPP, LHP, Polizei).
//
// Как работает (форма mapData подтверждена реальным ответом API, форма CAP-подробностей и GeoJSON — по документации
// bundesAPI/nina-api, поэтому разбор защитный: чего нет в ответе, того нет и у нас, ничего не выдумывается):
//   1) 6 лент  GET /api31/{mowas|dwd|katwarn|biwapp|lhp|police}/mapData.json — ВСЕ активные предупреждения Германии
//      (id, version, startDate, expiresDate, severity, urgency, type, i18nTitle);
//   2) для новых/изменившихся (id+version) предупреждений: GET /api31/warnings/{id}.json (CAP: описание,
//      рекомендации, зоны, onset/expires) и GET /api31/warnings/{id}.geojson (контур зоны);
//   3) география по контуру: затрагивает Вупперталь -> 'city'; иначе затрагивает NRW -> 'region' (или 'national',
//      если сказано «bundesweit»); иначе предупреждение пропускается и запоминается в таблице nina_skip.
//
// Честность данных:
//   • точка на карте ставится только для компактной зоны (≤ ~2 км) внутри города (geo_precision 'source');
//   • для больших зон (район/округ/NRW/вся страна) координат нет: показываем, что оно относится к области,
//     и перечисляем названия территорий; «представительской» точки в центре города не рисуем — это выглядело бы
//     как происшествие в центре Вупперталя.
//
// Лимит Workers Free — 50 подзапросов за запуск: 6 лент + не более MAX_WARNINGS×2. Остальное — в следующий запуск.
// Нужна миграция migrations/003_nina_skip.sql (кэш проверенных чужих предупреждений); без неё источник работает,
// но будет перепроверять чужие предупреждения заново.
//
// Настройки (необязательные): NINA_SCOPE = 'city' | 'nrw' (по умолчанию) — показывать ли предупреждения NRW и всей
// страны, затрагивающие NRW, или только затрагивающие Вупперталь.

import { CITY } from '../config.js';
import { fetchJson, shortId, truncate as truncateText } from '../util.js';
import { syncSource, hashOf } from '../events.js';

const BASE_URL = 'https://warnung.bund.de/api31';
const FEEDS = ['mowas', 'dwd', 'katwarn', 'biwapp', 'lhp', 'police'];
const SCHEMA = 'v3';             // менять при изменении состава сохраняемых данных: всё подгрузится заново
const MAX_WARNINGS = 18;         // 18 × 2 запроса + 6 лент = 42 < 50
const CONCURRENCY = 5;
const SKIP_KEEP_DAYS = 14;

// Координаты GeoJSON: [longitude, latitude]. Города берём из config.js, чтобы границы были в одном месте.
const CITY_BBOX = { west: CITY.bbox.minLon, east: CITY.bbox.maxLon, south: CITY.bbox.minLat, north: CITY.bbox.maxLat };
// Приблизительная область Nordrhein-Westfalen: фильтр-кандидат, а не административная граница.
const NRW_BBOX = { west: 5.86, east: 9.46, south: 50.32, north: 52.53 };
// Зона не крупнее этого (≈ 2,2 км) считается «местом», крупнее — областью.
const MAX_LOCAL_SPAN = { lat: 0.02, lon: 0.032 };

export const meta = {
  id: 'nina',
  name: 'NINA (BBK, DWD, MOWAS, KATWARN, BIWAPP, LHP, Polizei)',
  intervalSec: 300,
  cron: '*/5 * * * *',
  group: 'warning'
};

// Коды земель в id MOWAS («mow.DE-SL-…»): предупреждение выпускает орган своей земли, поэтому
// предупреждения других земель не запрашиваем (экономия подзапросов). NW, BV (федерация) и неизвестное — проверяем.
const OTHER_STATES = new Set(['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH']);
const SEVERITIES = new Set(['Minor', 'Moderate', 'Severe', 'Extreme']);

// --------------------------------------------------
// Текст
// --------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', szlig: 'ß' };

export function cleanText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|ul|ol|h\d)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d{1,6});/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in ENTITIES ? ENTITIES[n] : m))
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// В source_url не должно попасть ничего, кроме веб-адреса.
export function safeWeb(u) {
  try {
    const x = new URL(String(u || '').trim());
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch { return null; }
}

function firstText(...values) {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function getGermanInfo(detail) {
  const infos = Array.isArray(detail && detail.info) ? detail.info : detail && detail.info ? [detail.info] : [];
  const lang = (i) => String((i && i.language) || '').toLowerCase();
  return infos.find((i) => lang(i) === 'de') || infos.find((i) => lang(i).startsWith('de')) || infos[0] || null;
}

// --------------------------------------------------
// Ленты mapData
// --------------------------------------------------

function extractArray(value, depth = 0) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object' || depth > 4) return null;
  for (const key of ['warnings', 'items', 'data', 'features', 'results']) if (Array.isArray(value[key])) return value[key];
  for (const child of Object.values(value)) if (Array.isArray(child)) return child;
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') { const r = extractArray(child, depth + 1); if (r) return r; }
  }
  return null;
}

function normalizeFeedItem(item, feed) {
  if (!item || typeof item !== 'object') return null;
  const id = firstText(item.id, item.identifier);
  if (!id) return null;
  return { ...item, id, feed };
}

// --------------------------------------------------
// Геометрия (GeoJSON, координаты [lon, lat])
// --------------------------------------------------

function isValidPoint(point) {
  return (
    Array.isArray(point) &&
    point.length >= 2 &&
    Number.isFinite(Number(point[0])) &&
    Number.isFinite(Number(point[1]))
  );
}

function collectPoints(value, result = []) {
  if (!Array.isArray(value)) return result;

  if (isValidPoint(value)) {
    result.push([
      Number(value[0]),
      Number(value[1])
    ]);

    return result;
  }

  for (const child of value) {
    collectPoints(child, result);
  }

  return result;
}

function pointInsideBbox(point, bbox) {
  const [longitude, latitude] = point;

  return (
    longitude >= bbox.west &&
    longitude <= bbox.east &&
    latitude >= bbox.south &&
    latitude <= bbox.north
  );
}

function bboxOfPoints(points) {
  if (!points.length) return null;

  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;

  for (const [longitude, latitude] of points) {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }

  return { west, east, south, north };
}

function bboxesIntersect(a, b) {
  return !(
    a.east < b.west ||
    a.west > b.east ||
    a.north < b.south ||
    a.south > b.north
  );
}

function pointOnSegment(point, a, b) {
  const cross =
    (point[1] - a[1]) * (b[0] - a[0]) -
    (point[0] - a[0]) * (b[1] - a[1]);

  if (Math.abs(cross) > 1e-10) return false;

  const dot =
    (point[0] - a[0]) * (b[0] - a[0]) +
    (point[1] - a[1]) * (b[1] - a[1]);

  if (dot < 0) return false;

  const lengthSquared =
    (b[0] - a[0]) ** 2 +
    (b[1] - a[1]) ** 2;

  return dot <= lengthSquared;
}

function orientation(a, b, c) {
  return (
    (b[1] - a[1]) * (c[0] - b[0]) -
    (b[0] - a[0]) * (c[1] - b[1])
  );
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (
    ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
    ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))
  ) {
    return true;
  }

  return (
    pointOnSegment(c, a, b) ||
    pointOnSegment(d, a, b) ||
    pointOnSegment(a, c, d) ||
    pointOnSegment(b, c, d)
  );
}

function segmentIntersectsBbox(a, b, bbox) {
  const corners = [
    [bbox.west, bbox.south],
    [bbox.east, bbox.south],
    [bbox.east, bbox.north],
    [bbox.west, bbox.north]
  ];

  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    const d = corners[(i + 1) % corners.length];

    if (segmentsIntersect(a, b, c, d)) {
      return true;
    }
  }

  return false;
}

function pointInRing(point, ring) {
  if (!Array.isArray(ring) || ring.length < 3) {
    return false;
  }

  let inside = false;

  for (
    let i = 0, j = ring.length - 1;
    i < ring.length;
    j = i++
  ) {
    const a = ring[i];
    const b = ring[j];

    if (!isValidPoint(a) || !isValidPoint(b)) continue;

    if (pointOnSegment(point, a, b)) return true;

    const intersects =
      (a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] <
        ((b[0] - a[0]) * (point[1] - a[1])) /
          (b[1] - a[1]) +
          a[0];

    if (intersects) inside = !inside;
  }

  return inside;
}

function ringIntersectsBbox(ring, bbox) {
  if (!Array.isArray(ring) || ring.length < 3) {
    return false;
  }

  // Хотя бы одна вершина находится внутри области.
  for (const point of ring) {
    if (
      isValidPoint(point) &&
      pointInsideBbox(point, bbox)
    ) {
      return true;
    }
  }

  // Контур полигона пересекает границу области.
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];

    if (
      isValidPoint(a) &&
      isValidPoint(b) &&
      segmentIntersectsBbox(a, b, bbox)
    ) {
      return true;
    }
  }

  // Область целиком находится внутри полигона.
  const center = [
    (bbox.west + bbox.east) / 2,
    (bbox.south + bbox.north) / 2
  ];

  if (pointInRing(center, ring)) return true;

  const corners = [
    [bbox.west, bbox.south],
    [bbox.east, bbox.south],
    [bbox.east, bbox.north],
    [bbox.west, bbox.north]
  ];

  return corners.some((point) => pointInRing(point, ring));
}

function polygonIntersectsBbox(rings, bbox) {
  if (!Array.isArray(rings) || !rings.length) {
    return false;
  }

  // В CAP GeoJSON первый контур — внешний.
  return ringIntersectsBbox(rings[0], bbox);
}

function geometryIntersectsBbox(geometry, bbox) {
  if (!geometry || typeof geometry !== 'object') {
    return false;
  }

  if (geometry.type === 'GeometryCollection') {
    return Array.isArray(geometry.geometries) &&
      geometry.geometries.some((item) =>
        geometryIntersectsBbox(item, bbox)
      );
  }

  const points = collectPoints(geometry.coordinates);
  const bounds = bboxOfPoints(points);

  if (!bounds || !bboxesIntersect(bounds, bbox)) {
    return false;
  }

  if (points.some((point) => pointInsideBbox(point, bbox))) {
    return true;
  }

  if (geometry.type === 'Polygon') {
    return polygonIntersectsBbox(geometry.coordinates, bbox);
  }

  if (geometry.type === 'MultiPolygon') {
    return Array.isArray(geometry.coordinates) &&
      geometry.coordinates.some((polygon) =>
        polygonIntersectsBbox(polygon, bbox)
      );
  }

  if (
    geometry.type === 'LineString' ||
    geometry.type === 'MultiLineString'
  ) {
    const lines = geometry.type === 'LineString'
      ? [geometry.coordinates]
      : geometry.coordinates;

    return lines.some((line) => {
      if (!Array.isArray(line)) return false;

      for (let i = 0; i < line.length - 1; i++) {
        if (
          isValidPoint(line[i]) &&
          isValidPoint(line[i + 1]) &&
          segmentIntersectsBbox(line[i], line[i + 1], bbox)
        ) {
          return true;
        }
      }

      return false;
    });
  }

  // Point и MultiPoint уже проверены выше.
  return false;
}

function geoJsonIntersectsBbox(geojson, bbox) {
  if (!geojson || typeof geojson !== 'object') {
    return false;
  }

  if (geojson.type === 'FeatureCollection') {
    return Array.isArray(geojson.features) &&
      geojson.features.some((feature) =>
        geometryIntersectsBbox(feature?.geometry, bbox)
      );
  }

  if (geojson.type === 'Feature') {
    return geometryIntersectsBbox(geojson.geometry, bbox);
  }

  return geometryIntersectsBbox(geojson, bbox);
}

function getGeoJsonGeometries(geojson) {
  if (geojson?.type === 'FeatureCollection') {
    return (geojson.features || [])
      .map((feature) => feature?.geometry)
      .filter(Boolean);
  }

  if (geojson?.type === 'Feature') {
    return geojson.geometry ? [geojson.geometry] : [];
  }

  return geojson?.type ? [geojson] : [];
}

// --------------------------------------------------
// География: к какой территории относится предупреждение
// --------------------------------------------------

function getAreaNames(info) {
  const areas = Array.isArray(info && info.area) ? info.area : info && info.area ? [info.area] : [];
  return [...new Set(areas.map((a) => cleanText(a && a.areaDesc)).filter(Boolean))];
}

function isNationalWarning(areaNames, title, description) {
  const value = [...areaNames, title || '', description || ''].join(' ').toLowerCase();
  return /bundesweit|bundesgebiet|ganz deutschland|deutschlandweit|gesamte bundesrepublik/.test(value);
}

// 'city' — зона затрагивает Вупперталь; 'region'/'national' — затрагивает NRW (только в режиме nrw); иначе null.
export function getGeographicScope(geojson, areaNames, title, description, mode = 'nrw') {
  if (geoJsonIntersectsBbox(geojson, CITY_BBOX)) return 'city';
  if (mode === 'city') return null;
  if (!geoJsonIntersectsBbox(geojson, NRW_BBOX)) return null;
  return isNationalWarning(areaNames, title, description) ? 'national' : 'region';
}

function geoBounds(geojson) {
  const points = getGeoJsonGeometries(geojson).flatMap((g) => collectPoints(g.coordinates));
  return bboxOfPoints(points);
}

// --------------------------------------------------
// Категории (только значения из CATEGORIES в config.js)
// --------------------------------------------------

const RULES = [
  ['evacuation', /bombe|blindgänger|blindgaenger|kampfmittel|entschärf|entschaerf|evakuier|\bräumung|\braeumung/],
  ['flood', /hochwasser|überflutung|ueberflutung|überschwemm|ueberschwemm|pegel/],
  ['heavy_rain', /starkregen|dauerregen/],
  ['weather_thunder', /gewitter|blitz|hagel/],
  ['weather_storm', /sturm|orkan|böe|boee|tornado|\bwind\b/],
  ['weather_ice', /glätte|glaette|glatteis|schnee|frost|eisregen|tauwetter/],
  ['weather_heat', /hitze|\buv\b|extreme wärme/],
  ['infra_power', /stromausfall|stromversorgung|blackout/],
  ['infra_water', /trinkwasser|wasserversorgung|wasserausfall|abkochen|rohrbruch/],
  ['fire', /brand(?!enburg)|feuer|rauch|explosion|löscharbeiten/],
  ['hazard', /gefahrstoff|chemi|gasaustritt|gasleck|gasgeruch|schadstoff|giftig|ammoniak|chlor|radioaktiv|\bgas\b/],
  ['road_closure', /sperrung|gesperrt/],
  ['police', /vermisst|fahndung|polizei|bedroh|amok|geisel|messer/]
];

export function classify(text, feed, capCategory) {
  const t = String(text || '').toLowerCase();
  const provider = String(feed || '').toUpperCase();
  for (const [cat, re] of RULES) {
    // Метео-категории — только для DWD: слово «Sturm» в сообщении другого провайдера не делает его метеопредупреждением
    if (cat.startsWith('weather_') && provider !== 'DWD') continue;
    if (re.test(t)) return cat;
  }
  if (provider === 'DWD') return 'weather_other';
  if (provider === 'POLICE') return 'police';
  const cap = (Array.isArray(capCategory) ? capCategory.join(' ') : String(capCategory || '')).toLowerCase();
  if (/\bfire\b/.test(cap)) return 'fire';
  if (/\btransport\b/.test(cap)) return 'traffic_other';
  return 'warning_other';
}

// --------------------------------------------------
// Сборка записи
// --------------------------------------------------

function buildDescription(info, areaNames, extra) {
  const parts = [];
  const description = cleanText(info.description);
  const instruction = cleanText(info.instruction);
  if (description) parts.push(truncateText(description, 1000));
  if (instruction && instruction !== description) parts.push(`Handlungsempfehlung: ${truncateText(instruction, 600)}`);
  if (areaNames.length) {
    parts.push(`Betroffenes Gebiet: ${truncateText(areaNames.slice(0, 8).join('; ') + (areaNames.length > 8 ? ' …' : ''), 300)}`);
  }
  if (extra) parts.push(extra);
  const contact = cleanText(info.contact);
  if (contact) parts.push(`Kontakt: ${truncateText(contact, 200)}`);
  return parts.length ? parts.join('\n\n') : null;
}

function sizeLabel(b) {
  const r50 = (m) => Math.max(50, Math.round(m / 50) * 50);
  const lat = (b.north + b.south) / 2;
  return `${r50((b.east - b.west) * 111320 * Math.cos((lat * Math.PI) / 180))} × ${r50((b.north - b.south) * 111320)} m`;
}

const keyOf = (raw) => `${SCHEMA}|${raw.id}|${raw.version ?? ''}`;

// Минимальная запись из mapData: только чтобы не терять предупреждение, детали уже сохранены в базе.
function minimalItem(raw) {
  const title = cleanText(firstText(raw.i18nTitle && raw.i18nTitle.de, 'Amtliche Warnung'));
  return {
    source_event_id: raw.id, content_key: keyOf(raw), title, category: classify(title, raw.feed),
    status: 'ACTIVE', geo_precision: 'none', is_verified: 1
  };
}

export function buildItem(raw, detail, geojson, scope, now) {
  if (!raw || !raw.id) return null;
  if (String((detail && detail.msgType) || raw.type || '').toLowerCase() === 'cancel') return null;
  if (detail && detail.status && String(detail.status).toLowerCase() !== 'actual') return null; // Test/Exercise и т.п.

  const info = getGermanInfo(detail) || {};
  const expiresAt = parseDate(firstText(info.expires, raw.expiresDate));
  if (expiresAt && Date.parse(expiresAt) <= now) return null;

  const title = cleanText(firstText(raw.i18nTitle && raw.i18nTitle.de, info.headline, info.event, 'Amtliche Warnung'));
  const areaNames = getAreaNames(info);
  const provider = String(raw.feed || '').toUpperCase();
  const sender = firstText(
    ...(Array.isArray(info.parameter) ? info.parameter.filter((p) => p && p.valueName === 'sender_langname').map((p) => p.value) : []),
    info.senderName
  );

  const b = geoBounds(geojson);
  const local = scope === 'city' && b && provider !== 'DWD' && provider !== 'LHP'
    && b.north - b.south <= MAX_LOCAL_SPAN.lat && b.east - b.west <= MAX_LOCAL_SPAN.lon
    && pointInsideBbox([(b.west + b.east) / 2, (b.south + b.north) / 2], CITY_BBOX);

  let geo = 'none', lat = null, lon = null, location;
  if (local) {
    geo = 'source'; lat = (b.north + b.south) / 2; lon = (b.west + b.east) / 2;
    location = truncateText(areaNames[0] || CITY.name, 80);
  } else if (scope === 'city') {
    geo = 'city'; location = CITY.name;
  } else if (scope === 'national') {
    location = 'Deutschland';
  } else {
    location = truncateText(`Nordrhein-Westfalen${areaNames.length ? ` · ${areaNames.slice(0, 3).join('; ')}` : ''}`, 120);
  }

  const onset = parseDate(firstText(info.onset, info.effective));
  const severity = [info.severity, raw.severity].find((s) => SEVERITIES.has(s)) || null;
  const text = [title, cleanText(info.headline), cleanText(info.event)].join(' ');

  return {
    source_event_id: raw.id,
    content_key: keyOf(raw),
    publisher: `NINA / ${provider || 'BBK'}${sender ? ` (${truncateText(cleanText(sender), 60)})` : ''}`,
    title: truncateText(title, 300),
    description: buildDescription(info, areaNames, local ? `Ungefähre Ausdehnung des Warngebiets: ${sizeLabel(b)}.` : null),
    category: classify(text, raw.feed, info.category),
    source_url: safeWeb(info.web) || 'https://warnung.bund.de/',
    geo_precision: geo,
    latitude: lat,
    longitude: lon,
    location_name: location,
    event_time: onset,                       // onset/effective из CAP; startDate в mapData — время выпуска версии, не явления
    time_precision: onset ? 'minute' : 'unknown',
    published_at: parseDate(firstText(detail && detail.sent, raw.startDate)),
    status: 'ACTIVE',
    status_reason: `nina_${scope}_warning`,
    confidence: scope === 'city' ? 0.95 : 0.8,
    is_verified: 1,
    severity,
    expires_at: expiresAt
  };
}

// --------------------------------------------------
// Вспомогательное
// --------------------------------------------------

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await callback(items[i], i); } catch (e) { results[i] = { error: (e && e.message) || String(e) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Идентификатор попадает в путь запроса: пропускаем только безопасные символы.
const ID_OK = /^[\w.\-:]{1,200}$/;

async function loadPrev(env) {
  const rows = (await env.DB.prepare(
    'SELECT id, content_hash, status, miss_count FROM events WHERE source = ? AND city_id = ?'
  ).bind(meta.id, CITY.id).all()).results || [];
  return new Map(rows.map((r) => [r.id, r]));
}

async function loadSkip(ctx) {
  try {
    const rows = (await ctx.env.DB.prepare('SELECT id, version, reason FROM nina_skip').all()).results || [];
    return new Map(rows.map((r) => [r.id, r]));
  } catch (e) {
    ctx.log(`nina: таблица nina_skip недоступна (примените migrations/003_nina_skip.sql): ${e.message}`);
    return new Map();
  }
}

async function saveSkip(ctx, rows) {
  const db = ctx.env.DB;
  const ts = new Date(ctx.now).toISOString();
  try {
    for (let i = 0; i < rows.length; i += 40) {
      await db.batch(rows.slice(i, i + 40).map((r) =>
        db.prepare('INSERT OR REPLACE INTO nina_skip (id, version, reason, ts) VALUES (?, ?, ?, ?)').bind(r.id, r.version, r.reason, ts)));
    }
    await db.prepare('DELETE FROM nina_skip WHERE ts < ?').bind(new Date(ctx.now - SKIP_KEEP_DAYS * 86400e3).toISOString()).run();
  } catch (e) { ctx.log(`nina: не удалось записать nina_skip: ${e.message}`); }
}

const isExpired = (w, now) => { const e = parseDate(w.expiresDate); return !!e && Date.parse(e) <= now; };
const foreignState = (w) => { const m = /^mow\.DE-([A-Z]{2})-/.exec(w.id); return !!m && OTHER_STATES.has(m[1]); };
const priority = (w) => (/DE-NW/.test(w.id) ? 0 : w.feed === 'dwd' ? 1 : 2);

// --------------------------------------------------
// Запуск
// --------------------------------------------------

export async function run(ctx) {
  const mode = ctx.env.NINA_SCOPE === 'city' ? 'city' : 'nrw';

  const feedResults = await Promise.all(FEEDS.map(async (feed) => {
    const url = `${BASE_URL}/${feed}/mapData.json`;
    try {
      const array = extractArray((await fetchJson(url, { retries: 1, timeoutMs: 7000 })).json);
      if (!array) throw new Error(`Unexpected format of ${feed}/mapData.json`);
      return { feed, items: array.map((x) => normalizeFeedItem(x, feed)).filter(Boolean), ok: true };
    } catch (e) {
      ctx.log(`nina feed ${feed}: ${(e && e.message) || e}`);
      return { feed, items: [], ok: false };
    }
  }));
  // Если лента не загрузилась, пропавшие предупреждения закрывать нельзя.
  let complete = feedResults.every((r) => r.ok);
  if (feedResults.every((r) => !r.ok)) throw new Error('NINA: ни одна лента mapData не загрузилась');

  const byId = new Map();
  for (const f of feedResults) {
    for (const it of f.items) {
      const ex = byId.get(it.id);
      if (!ex || Number(it.version || 0) > Number(ex.version || 0)) byId.set(it.id, it);
    }
  }
  const all = [...byId.values()];
  const candidates = all.filter((w) => String(w.type || '').toLowerCase() !== 'cancel' && !isExpired(w, ctx.now) && !foreignState(w) && ID_OK.test(w.id));

  const prev = await loadPrev(ctx.env);
  const skip = await loadSkip(ctx);
  const items = [];
  const queue = [];
  let skipped = 0;

  for (const w of candidates) {
    const sk = skip.get(w.id);
    if (sk && sk.version === Number(w.version || 0) && (sk.reason === 'gone' || sk.reason === `outside:${mode}`)) { skipped++; continue; }
    const key = `${mode}:${keyOf(w)}`;
    w.modeKey = key;
    const p = prev.get(`${meta.id}:${await shortId(w.id)}`);
    const unchanged = p && p.content_hash === (await hashOf({ content_key: key })) && p.status !== 'RESOLVED' && !p.miss_count;
    if (unchanged) { if (p.status !== 'EXPIRED') items.push({ ...minimalItem(w), content_key: key }); continue; }
    queue.push(w);
  }

  queue.sort((a, b) => priority(a) - priority(b));
  const batch = queue.slice(0, MAX_WARNINGS);
  if (queue.length > batch.length) complete = false; // остальные догрузятся в следующие запуски

  const loaded = await mapLimit(batch, CONCURRENCY, async (raw) => {
    const id = encodeURIComponent(raw.id);
    const [d, g] = await Promise.all([
      fetchJson(`${BASE_URL}/warnings/${id}.json`, { retries: 0, timeoutMs: 7000 }),
      fetchJson(`${BASE_URL}/warnings/${id}.geojson`, { retries: 0, timeoutMs: 7000 })
    ]);
    if (!d.json || typeof d.json !== 'object') throw new Error(`Invalid CAP detail: ${raw.id}`);
    if (!g.json || typeof g.json !== 'object') throw new Error(`Invalid GeoJSON: ${raw.id}`);
    return { raw, detail: d.json, geojson: g.json };
  });

  const skipRows = [];
  const stat = { city: 0, region: 0, national: 0, outside: 0, dropped: 0, failed: 0 };
  loaded.forEach((r, i) => {
    const raw = batch[i];
    const version = Number(raw.version || 0);
    if (!r || r.error) {
      stat.failed++;
      ctx.log(`nina ${raw.id}: ${r && r.error}`);
      if (/HTTP 404/.test((r && r.error) || '')) skipRows.push({ id: raw.id, version, reason: 'gone' });
      else complete = false;
      return;
    }
    const { detail, geojson } = r;
    const info = getGermanInfo(detail) || {};
    const title = firstText(raw.i18nTitle && raw.i18nTitle.de, info.headline, info.event, '');
    const areas = getAreaNames(info);
    const scope = getGeographicScope(geojson, areas, title, cleanText(info.description), mode);
    if (!scope) { stat.outside++; skipRows.push({ id: raw.id, version, reason: `outside:${mode}` }); return; }
    const item = buildItem(raw, detail, geojson, scope, ctx.now);
    if (!item) { stat.dropped++; skipRows.push({ id: raw.id, version, reason: `outside:${mode}` }); return; }
    item.content_key = raw.modeKey;
    stat[scope]++;
    items.push(item);
  });
  if (skipRows.length) await saveSkip(ctx, skipRows);

  ctx.log(`nina: лент ${feedResults.filter((f) => f.ok).length}/${FEEDS.length}, в лентах ${all.length}, проверено ${batch.length}, ` +
    `в очереди ещё ${queue.length - batch.length}, из кэша пропущено ${skipped}; ` +
    `Вупперталь ${stat.city}, NRW ${stat.region}, вся страна ${stat.national}, вне региона ${stat.outside}, отброшено ${stat.dropped}, ошибок ${stat.failed}`);

  return syncSource(ctx, meta.id, items, { resolveMissing: complete, resolvedScopes: null });
}

// --------------------------------------------------
// Диагностика (админка -> Источники -> «Проба»)
// --------------------------------------------------

export async function probe(ctx) {
  const feeds = {};
  let first = null;
  for (const feed of FEEDS) {
    const url = `${BASE_URL}/${feed}/mapData.json`;
    try {
      const array = extractArray((await fetchJson(url, { retries: 0 })).json);
      feeds[feed] = { url, ok: !!array, count: array ? array.length : null, sample: array ? array.slice(0, 2) : null };
      if (!first && array) first = array.map((x) => normalizeFeedItem(x, feed)).find((x) => x && ID_OK.test(x.id) && !foreignState(x));
    } catch (e) { feeds[feed] = { url, ok: false, error: (e && e.message) || String(e) }; }
  }
  const out = { city: CITY.name, mode: ctx.env.NINA_SCOPE === 'city' ? 'city' : 'nrw', cityBbox: CITY_BBOX, nrwBbox: NRW_BBOX, feeds };
  if (first) {
    const id = encodeURIComponent(first.id);
    try { out.detail_sample = (await fetchJson(`${BASE_URL}/warnings/${id}.json`, { retries: 0 })).text.slice(0, 2500); } catch (e) { out.detail_error = e.message; }
    try {
      const gj = (await fetchJson(`${BASE_URL}/warnings/${id}.geojson`, { retries: 0 })).json;
      out.geojson = { id: first.id, types: getGeoJsonGeometries(gj).map((g) => g.type), bounds: geoBounds(gj) };
    } catch (e) { out.geojson_error = e.message; }
  }
  return out;
}
