
import { CITY } from '../config.js';
import { fetchJson } from '../util.js';
import { syncSource } from '../events.js';

const BASE_URL = 'https://warnung.bund.de/api31';

const FEEDS = [
  'mowas',
  'dwd',
  'katwarn',
  'biwapp',
  'lhp',
  'police'
];

// Границы Вупперталя.
// Координаты GeoJSON: [longitude, latitude].
const CITY_BBOX = {
  west: 7.01,
  east: 7.32,
  south: 51.16,
  north: 51.33
};

const CONCURRENCY = 5;
const MAX_DESCRIPTION = 12000;

export const meta = {
  id: 'nina',
  name: 'NINA (BBK, DWD, MOWAS, KATWARN, BIWAPP, LHP, Polizei)',
  intervalSec: 300,
  cron: '*/5 * * * *',
  group: 'warning'
};

// --------------------------------------------------
// Общие функции
// --------------------------------------------------

function cleanText(value) {
  if (value == null) return '';

  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function truncate(value, max = MAX_DESCRIPTION) {
  const text = cleanText(value);

  if (text.length <= max) return text;

  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function parseDate(value) {
  if (!value) return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

function getGermanInfo(detail) {
  const infos = Array.isArray(detail?.info)
    ? detail.info
    : [];

  return (
    infos.find((item) => item?.language?.toLowerCase() === 'de') ||
    infos.find((item) => item?.language?.toLowerCase() === 'de-ls') ||
    infos[0] ||
    {}
  );
}

function getParameter(info, name) {
  const parameters = Array.isArray(info?.parameter)
    ? info.parameter
    : [];

  const item = parameters.find(
    (parameter) => parameter?.valueName === name
  );

  return item?.value ?? null;
}

// --------------------------------------------------
// Получение записей из mapData
// --------------------------------------------------

function extractArray(value, depth = 0) {
  if (Array.isArray(value)) return value;

  if (!value || typeof value !== 'object' || depth > 4) {
    return null;
  }

  const preferredKeys = [
    'warnings',
    'items',
    'data',
    'features',
    'results'
  ];

  for (const key of preferredKeys) {
    if (Array.isArray(value[key])) {
      return value[key];
    }
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      return child;
    }
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const result = extractArray(child, depth + 1);

      if (result) return result;
    }
  }

  return null;
}

function normalizeFeedItem(item) {
  if (!item || typeof item !== 'object') return null;

  const id = firstText(item.id, item.identifier);

  if (!id) return null;

  return {
    ...item,
    id
  };
}

// --------------------------------------------------
// География: проверка пересечения GeoJSON с Wuppertal
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

function pointInsideBbox(point) {
  const [longitude, latitude] = point;

  return (
    longitude >= CITY_BBOX.west &&
    longitude <= CITY_BBOX.east &&
    latitude >= CITY_BBOX.south &&
    latitude <= CITY_BBOX.north
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

function segmentIntersectsBbox(a, b) {
  const corners = [
    [CITY_BBOX.west, CITY_BBOX.south],
    [CITY_BBOX.east, CITY_BBOX.south],
    [CITY_BBOX.east, CITY_BBOX.north],
    [CITY_BBOX.west, CITY_BBOX.north]
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

function ringIntersectsBbox(ring) {
  if (!Array.isArray(ring) || ring.length < 3) {
    return false;
  }

  // Одна из вершин находится внутри Вупперталя.
  for (const point of ring) {
    if (isValidPoint(point) && pointInsideBbox(point)) {
      return true;
    }
  }

  // Граница полигона пересекает границу города.
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];

    if (
      isValidPoint(a) &&
      isValidPoint(b) &&
      segmentIntersectsBbox(a, b)
    ) {
      return true;
    }
  }

  // Город целиком находится внутри полигона.
  const center = [
    (CITY_BBOX.west + CITY_BBOX.east) / 2,
    (CITY_BBOX.south + CITY_BBOX.north) / 2
  ];

  if (pointInRing(center, ring)) return true;

  const corners = [
    [CITY_BBOX.west, CITY_BBOX.south],
    [CITY_BBOX.east, CITY_BBOX.south],
    [CITY_BBOX.east, CITY_BBOX.north],
    [CITY_BBOX.west, CITY_BBOX.north]
  ];

  return corners.some((point) => pointInRing(point, ring));
}

function polygonIntersectsBbox(rings) {
  if (!Array.isArray(rings) || !rings.length) {
    return false;
  }

  // Для обычного CAP-полигона первая граница — внешний контур.
  return ringIntersectsBbox(rings[0]);
}

function geometryIntersectsBbox(geometry) {
  if (!geometry || typeof geometry !== 'object') {
    return false;
  }

  if (geometry.type === 'GeometryCollection') {
    return Array.isArray(geometry.geometries) &&
      geometry.geometries.some(geometryIntersectsBbox);
  }

  const points = collectPoints(geometry.coordinates);
  const bounds = bboxOfPoints(points);

  if (!bounds || !bboxesIntersect(bounds, CITY_BBOX)) {
    return false;
  }

  if (points.some(pointInsideBbox)) {
    return true;
  }

  if (geometry.type === 'Polygon') {
    return polygonIntersectsBbox(geometry.coordinates);
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some(polygonIntersectsBbox);
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
          segmentIntersectsBbox(line[i], line[i + 1])
        ) {
          return true;
        }
      }

      return false;
    });
  }

  // Для Point и MultiPoint достаточно проверки координат.
  return false;
}

function geoJsonIntersectsCity(geojson) {
  if (!geojson || typeof geojson !== 'object') {
    return false;
  }

  if (geojson.type === 'FeatureCollection') {
    return Array.isArray(geojson.features) &&
      geojson.features.some((feature) =>
        geometryIntersectsBbox(feature?.geometry)
      );
  }

  if (geojson.type === 'Feature') {
    return geometryIntersectsBbox(geojson.geometry);
  }

  return geometryIntersectsBbox(geojson);
}

function getGeometryCenter(geojson) {
  const geometries = [];

  if (geojson?.type === 'FeatureCollection') {
    for (const feature of geojson.features || []) {
      if (feature?.geometry) geometries.push(feature.geometry);
    }
  } else if (geojson?.type === 'Feature') {
    if (geojson.geometry) geometries.push(geojson.geometry);
  } else if (geojson?.type) {
    geometries.push(geojson);
  }

  const points = geometries.flatMap((geometry) =>
    collectPoints(geometry.coordinates)
  );

  const bounds = bboxOfPoints(points);

  if (!bounds) return null;

  return {
    longitude: (bounds.west + bounds.east) / 2,
    latitude: (bounds.south + bounds.north) / 2
  };
}

// --------------------------------------------------
// Категории
// --------------------------------------------------

function classify(text, provider, capCategory) {
  const value = `${text || ''} ${provider || ''} ${capCategory || ''}`
    .toLowerCase();

  if (
    /dwd|wetter|gewitter|sturm|orkan|regen|schnee|glätte|frost|hitze|unwetter/.test(value)
  ) {
    return 'weather';
  }

  if (
    /trinkwasser|wasser|gesundheit|seuche|bakteri|virus|infektion|rauchgas/.test(value)
  ) {
    return 'health';
  }

  if (
    /brand|feuer|rauch|explosion|gasgeruch|gasleck/.test(value)
  ) {
    return 'fire';
  }

  if (
    /polizei|fahndung|bombenfund|kampfmittel|evakuierung|sperrung|gefahrstoff/.test(value)
  ) {
    return 'traffic';
  }

  return 'other';
}

// --------------------------------------------------
// CAP: подробности предупреждения
// --------------------------------------------------

function buildDescription(info, raw) {
  const sections = [];

  const description = cleanText(info?.description);
  const instruction = cleanText(info?.instruction);

  if (description) {
    sections.push(description);
  }

  if (
    instruction &&
    instruction !== description
  ) {
    sections.push(`Рекомендации:\n${instruction}`);
  }

  const area = Array.isArray(info?.area)
    ? info.area
        .map((item) => cleanText(item?.areaDesc))
        .filter(Boolean)
    : [];

  if (area.length) {
    sections.push(`Затронутая территория:\n${[...new Set(area)].join('; ')}`);
  }

  const contact = cleanText(info?.contact);

  if (contact) {
    sections.push(`Контакт:\n${contact}`);
  }

  const website = firstText(info?.web);

  if (website) {
    sections.push(`Дополнительная информация: ${website}`);
  }

  const result = sections.join('\n\n');

  if (result) return truncate(result);

  return truncate(
    firstText(
      raw?.i18nTitle?.de,
      info?.headline,
      info?.event,
      'Официальное предупреждение'
    )
  );
}

function buildItem(raw, detail, geojson) {
  if (!raw?.id || !detail || !geojson) return null;

  const msgType = String(detail.msgType || raw.type || '')
    .toLowerCase();

  // Отменённые предупреждения не должны снова становиться активными.
  // Исчезновение из ленты будет обработано syncSource.
  if (msgType === 'cancel') return null;

  if (
    detail.status &&
    String(detail.status).toLowerCase() !== 'actual'
  ) {
    return null;
  }

  const info = getGermanInfo(detail);

  const title = firstText(
    info.headline,
    raw.i18nTitle?.de,
    info.event,
    'Amtliche Warnung'
  );

  const provider = firstText(
    getParameter(info, 'sender_langname'),
    getParameter(info, 'sender_signature'),
    detail.sender,
    raw.provider
  );

  const areaNames = Array.isArray(info.area)
    ? info.area
        .map((area) => cleanText(area?.areaDesc))
        .filter(Boolean)
    : [];

  const locationName = areaNames.length
    ? [...new Set(areaNames)].join('; ')
    : CITY.name;

  const center = getGeometryCenter(geojson);

  const startDate = firstText(
    info.onset,
    info.effective,
    raw.startDate
  );

  const publishedAt = firstText(
    detail.sent,
    raw.sent,
    raw.startDate
  );

  const expiresAt = firstText(
    info.expires,
    raw.expiresDate
  );

  const description = buildDescription(info, raw);

  const category = classify(
    `${title} ${description}`,
    provider,
    Array.isArray(info.category)
      ? info.category.join(' ')
      : info.category
  );

  const sourceUrl = firstText(
    info.web,
    'https://warnung.bund.de/'
  );

  return {
    source_event_id: raw.id,
    publisher: provider || 'NINA / BBK',
    title: truncate(title, 500),
    description,
    category,
    source_url: sourceUrl,

    latitude: center?.latitude ?? null,
    longitude: center?.longitude ?? null,
    geo_precision: center ? 'area' : 'city',
    location_name: locationName,

    event_time: parseDate(startDate),
    time_precision: startDate ? 'minute' : 'unknown',
    published_at: parseDate(publishedAt),

    status: 'ACTIVE',
    status_reason: 'listed_in_nina_mapdata_and_geojson',
    confidence: 0.95,
    is_verified: 1,

    severity: firstText(
      info.severity,
      raw.severity
    ),

    expires_at: parseDate(expiresAt)
  };
}

// --------------------------------------------------
// Ограничение параллельных запросов
// --------------------------------------------------

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      try {
        results[index] = await callback(items[index], index);
      } catch (error) {
        results[index] = {
          error: error?.message || String(error)
        };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );

  await Promise.all(workers);

  return results;
}

// --------------------------------------------------
// Загрузка предупреждения
// --------------------------------------------------

async function loadWarning(raw) {
  const id = encodeURIComponent(raw.id);

  const detailUrl = `${BASE_URL}/warnings/${id}.json`;
  const geoUrl = `${BASE_URL}/warnings/${id}.geojson`;

  const [detailResult, geoResult] = await Promise.all([
    fetchJson(detailUrl),
    fetchJson(geoUrl)
  ]);

  const detail = detailResult?.json;
  const geojson = geoResult?.json;

  if (!detail || typeof detail !== 'object') {
    throw new Error(`Некорректный CAP detail: ${raw.id}`);
  }

  if (!geojson || typeof geojson !== 'object') {
    throw new Error(`Некорректный GeoJSON: ${raw.id}`);
  }

  return {
    raw,
    detail,
    geojson
  };
}

// --------------------------------------------------
// Основной запуск
// --------------------------------------------------

export async function run(ctx) {
  const env = ctx.env;

  const feedResults = await Promise.all(
    FEEDS.map(async (feed) => {
      const url = `${BASE_URL}/${feed}/mapData.json`;

      try {
        const result = await fetchJson(url);
        const array = extractArray(result?.json);

        if (!array) {
          throw new Error(`Неожиданный формат ${feed}/mapData.json`);
        }

        return {
          feed,
          items: array
            .map(normalizeFeedItem)
            .filter(Boolean),
          ok: true
        };
      } catch (error) {
        console.warn(
          `[nina] Ошибка загрузки ленты ${feed}:`,
          error?.message || error
        );

        return {
          feed,
          items: [],
          ok: false
        };
      }
    })
  );

  let complete = feedResults.every((result) => result.ok);

  // Дедупликация предупреждений по идентификатору.
  const warningsById = new Map();

  for (const feed of feedResults) {
    for (const item of feed.items) {
      const existing = warningsById.get(item.id);

      if (!existing) {
        warningsById.set(item.id, item);
        continue;
      }

      // Если один ID присутствует в нескольких лентах,
      // оставляем запись с более высокой версией.
      if (
        Number(item.version || 0) >
        Number(existing.version || 0)
      ) {
        warningsById.set(item.id, item);
      }
    }
  }

  const warnings = [...warningsById.values()];

  console.log(
    `[nina] Ленты: ${feedResults.map(
      (result) => `${result.feed}=${result.items.length}`
    ).join(', ')}; уникальных предупреждений: ${warnings.length}`
  );

  const loaded = await mapLimit(
    warnings,
    CONCURRENCY,
    loadWarning
  );

  const items = [];

  let loadedCount = 0;
  let failedCount = 0;
  let outsideCityCount = 0;
  let cancelledCount = 0;

  for (const result of loaded) {
    if (!result || result.error) {
      failedCount++;
      complete = false;

      console.warn(
        '[nina] Не удалось обработать предупреждение:',
        result?.error || 'Неизвестная ошибка'
      );

      continue;
    }

    loadedCount++;

    const { raw, detail, geojson } = result;

    const msgType = String(detail?.msgType || raw.type || '')
      .toLowerCase();

    if (msgType === 'cancel') {
      cancelledCount++;
      continue;
    }

    // Без корректной геометрии событие не попадёт в базу.
    // Геометрия уже загружена, проверяем её пересечение с городом.
    if (!geoJsonIntersectsCity(geojson)) {
      outsideCityCount++;
      continue;
    }

    const item = buildItem(raw, detail, geojson);

    if (item) {
      items.push(item);
    }
  }

  // Важно: если хотя бы один запрос завершился ошибкой,
  // нельзя разрешать syncSource закрывать отсутствующие события.
  const syncOptions = {
    resolveMissing: complete,
    resolvedScopes: null,
    scope: null
  };

  console.log(
    `[nina] Загружено: ${loadedCount}; ` +
    `ошибок: ${failedCount}; ` +
    `за пределами Вупперталя: ${outsideCityCount}; ` +
    `отменено: ${cancelledCount}; ` +
    `для Вупперталя: ${items.length}; ` +
    `resolveMissing=${complete}`
  );

  return syncSource(
    ctx,
    meta.id,
    items,
    syncOptions
  );
}

// --------------------------------------------------
// Диагностика
// --------------------------------------------------

export async function probe(ctx) {
  const results = {};

  for (const feed of FEEDS) {
    const url = `${BASE_URL}/${feed}/mapData.json`;

    try {
      const result = await fetchJson(url);
      const array = extractArray(result?.json);

      results[feed] = {
        url,
        ok: Boolean(array),
        count: array?.length ?? null,
        sample: array?.slice(0, 2) ?? null
      };
    } catch (error) {
      results[feed] = {
        url,
        ok: false,
        error: error?.message || String(error)
      };
    }
  }

  return {
    city: CITY.name,
    bbox: CITY_BBOX,
    feeds: results
  };
}
