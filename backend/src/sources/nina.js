
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

// Координаты GeoJSON: [longitude, latitude].
// Границы Вупперталя — приближённый городской прямоугольник.
const CITY_BBOX = {
  west: 7.01,
  east: 7.32,
  south: 51.16,
  north: 51.33
};

// Приближённая область Nordrhein-Westfalen.
// Используется как географический фильтр-кандидат, а не как
// точная административная граница федеральной земли.
const NRW_BBOX = {
  west: 5.86,
  east: 9.46,
  south: 50.32,
  north: 52.53
};

// Координаты Вупперталя — представительская точка
// для региональных предупреждений на городской карте.
const CITY_CENTER = {
  longitude: 7.197,
  latitude: 51.256
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
    infos.find(
      (item) => String(item?.language || '').toLowerCase() === 'de'
    ) ||
    infos.find(
      (item) => String(item?.language || '').toLowerCase() === 'de-ls'
    ) ||
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
// География
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

function getGeometryCenter(geojson) {
  const points = getGeoJsonGeometries(geojson)
    .flatMap((geometry) =>
      collectPoints(geometry.coordinates)
    );

  const bounds = bboxOfPoints(points);

  if (!bounds) return null;

  return {
    longitude: (bounds.west + bounds.east) / 2,
    latitude: (bounds.south + bounds.north) / 2
  };
}

function getGeoJsonDiagnostics(geojson) {
  const geometries = getGeoJsonGeometries(geojson);

  const points = geometries.flatMap((geometry) =>
    collectPoints(geometry.coordinates)
  );

  return {
    type: geojson?.type || null,
    geometryTypes: geometries.map((geometry) => geometry.type),
    points: points.length,
    bounds: bboxOfPoints(points)
  };
}// --------------------------------------------------
// Определение географической релевантности
// --------------------------------------------------

function getAreaNames(info) {
  const areas = Array.isArray(info?.area)
    ? info.area
    : [];

  return [
    ...new Set(
      areas
        .map((area) => cleanText(area?.areaDesc))
        .filter(Boolean)
    )
  ];
}

function isNationalWarning(areaNames, title, description) {
  const value = [
    ...areaNames,
    title || '',
    description || ''
  ].join(' ').toLowerCase();

  return /bundesweit|bundesgebiet|ganz deutschland|deutschlandweit|gesamte bundesrepublik|in ganz deutschland/.test(value);
}

function getGeographicScope(geojson, areaNames, title, description) {
  // Наивысший приоритет — непосредственно Вупперталь.
  if (geoJsonIntersectsBbox(geojson, CITY_BBOX)) {
    return 'city';
  }

  // Национальное предупреждение принимается только при условии,
  // что его геометрия также затрагивает территорию NRW.
  const intersectsNRW = geoJsonIntersectsBbox(
    geojson,
    NRW_BBOX
  );

  if (!intersectsNRW) {
    return null;
  }

  if (isNationalWarning(areaNames, title, description)) {
    return 'national';
  }

  return 'region';
}

function getEventCoordinates(geojson, scope) {
  // Для региональных и национальных предупреждений используем
  // точку Вупперталя как представительскую точку на городской карте.
  if (scope !== 'city') {
    return {
      latitude: CITY_CENTER.latitude,
      longitude: CITY_CENTER.longitude
    };
  }

  const center = getGeometryCenter(geojson);

  if (
    center &&
    pointInsideBbox(
      [center.longitude, center.latitude],
      CITY_BBOX
    )
  ) {
    return {
      latitude: center.latitude,
      longitude: center.longitude
    };
  }

  // Если центр большой геометрии находится за пределами города,
  // не размещаем локальное предупреждение в случайном месте.
  return {
    latitude: CITY_CENTER.latitude,
    longitude: CITY_CENTER.longitude
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

function buildDescription(info, areaNames) {
  const sections = [];

  const description = cleanText(info?.description);
  const instruction = cleanText(info?.instruction);

  if (description) {
    sections.push(description);
  }

  if (instruction && instruction !== description) {
    sections.push(`Рекомендации:\n${instruction}`);
  }

  if (areaNames.length) {
    sections.push(
      `Затронутая территория:\n${areaNames.join('; ')}`
    );
  }

  const contact = cleanText(info?.contact);

  if (contact) {
    sections.push(`Контакт:\n${contact}`);
  }

  const website = firstText(info?.web);

  if (website) {
    sections.push(`Дополнительная информация: ${website}`);
  }

  return truncate(
    sections.join('\n\n') ||
    firstText(
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

  // Отменённые предупреждения не создаём как активные.
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

  const areaNames = getAreaNames(info);

  const description = buildDescription(info, areaNames);

  const scope = getGeographicScope(
    geojson,
    areaNames,
    title,
    description
  );

  if (!scope) return null;

  const coordinates = getEventCoordinates(
    geojson,
    scope
  );

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

  let locationName;

  if (scope === 'city') {
    locationName = areaNames.length
      ? areaNames.join('; ')
      : CITY.name;
  } else if (scope === 'national') {
    locationName = areaNames.length
      ? `Deutschland · ${areaNames.join('; ')}`
      : 'Deutschland';
  } else {
    locationName = areaNames.length
      ? `Nordrhein-Westfalen · ${areaNames.join('; ')}`
      : 'Nordrhein-Westfalen';
  }

  return {
    source_event_id: raw.id,
    publisher: provider || 'NINA / BBK',
    title: truncate(title, 500),
    description,
    category,
    source_url: sourceUrl,

    latitude: coordinates.latitude,
    longitude: coordinates.longitude,

    // Важно: это географическая область предупреждения,
    // а не точный адрес или координата источника.
    geo_precision: 'area',
    location_name: locationName,

    event_time: parseDate(startDate),
    time_precision: startDate ? 'minute' : 'unknown',
    published_at: parseDate(publishedAt),

    status: 'ACTIVE',
    status_reason: `nina_${scope}_warning`,
    confidence: scope === 'city' ? 0.95 : 0.85,
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
  const feedResults = await Promise.all(
    FEEDS.map(async (feed) => {
      const url = `${BASE_URL}/${feed}/mapData.json`;

      try {
        const result = await fetchJson(url);
        const array = extractArray(result?.json);

        if (!array) {
          throw new Error(
            `Неожиданный формат ${feed}/mapData.json`
          );
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

  // Полная синхронизация допустима только при успешном
  // получении всех шести лент и всех предупреждений.
  let complete = feedResults.every((result) => result.ok);

  // Дедупликация по идентификатору.
  const warningsById = new Map();

  for (const feed of feedResults) {
    for (const item of feed.items) {
      const existing = warningsById.get(item.id);

      if (!existing) {
        warningsById.set(item.id, item);
        continue;
      }

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
  let outsideNRWCount = 0;
  let cityCount = 0;
  let regionCount = 0;
  let nationalCount = 0;
  let cancelledCount = 0;
  let inactiveCount = 0;

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

    const msgType = String(
      detail?.msgType || raw.type || ''
    ).toLowerCase();

    if (msgType === 'cancel') {
      cancelledCount++;
      continue;
    }

    if (
      detail.status &&
      String(detail.status).toLowerCase() !== 'actual'
    ) {
      inactiveCount++;
      continue;
    }

    const info = getGermanInfo(detail);
    const areaNames = getAreaNames(info);

    const title = firstText(
      info.headline,
      raw.i18nTitle?.de,
      info.event,
      'Amtliche Warnung'
    );

    const description = buildDescription(info, areaNames);

    const scope = getGeographicScope(
      geojson,
      areaNames,
      title,
      description
    );

    if (!scope) {
  outsideNRWCount++;

  const geo = getGeoJsonDiagnostics(geojson);

  console.log(
    '[nina] Географический фильтр:',
    JSON.stringify({
      id: raw.id,
      title,
      areas: areaNames,
      geometry: geo,
      intersectsCity: geoJsonIntersectsBbox(
        geojson,
        CITY_BBOX
      ),
      intersectsNRW: geoJsonIntersectsBbox(
        geojson,
        NRW_BBOX
      ),
      cityBbox: CITY_BBOX,
      nrwBbox: NRW_BBOX
    })
  );

  continue;
}

    const item = buildItem(raw, detail, geojson);

    if (!item) {
      inactiveCount++;
      continue;
    }

    items.push(item);

    if (scope === 'city') {
      cityCount++;
    } else if (scope === 'region') {
      regionCount++;
    } else if (scope === 'national') {
      nationalCount++;
    }
  }

  // Если хотя бы один запрос завершился ошибкой,
  // отсутствующие события не должны закрываться.
  const syncOptions = {
    resolveMissing: complete,
    resolvedScopes: null,
    scope: null
  };

  console.log(
    `[nina] Загружено: ${loadedCount}; ` +
    `ошибок: ${failedCount}; ` +
    `вне NRW: ${outsideNRWCount}; ` +
    `отменено: ${cancelledCount}; ` +
    `неактивно: ${inactiveCount}; ` +
    `Вупперталь: ${cityCount}; ` +
    `NRW: ${regionCount}; ` +
    `Германия: ${nationalCount}; ` +
    `всего для проекта: ${items.length}; ` +
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
    cityBbox: CITY_BBOX,
    nrwBbox: NRW_BBOX,
    geographicPolicy: {
      city: 'Warnings intersecting Wuppertal',
      region: 'Warnings intersecting NRW',
      national: 'Germany-wide warnings only when their geometry intersects NRW'
    },
    feeds: results
  };
}
