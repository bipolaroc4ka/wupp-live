 // Wuppertal Live — NINA / BBK / DWD / MoWaS / KATWARN / BIWAPP / LHP / Polizei.
// Dashboard + mapData + CAP + GeoJSON.
// Существующая схема events.js остаётся без изменений.

import { CITY } from '../config.js';
import { fetchJson } from '../util.js';
import { syncSource } from '../events.js';

const BASE_URL = 'https://warnung.bund.de/api31';

const DETAIL_CONCURRENCY = 5;
const GEO_CONCURRENCY = 5;
const MAX_DESCRIPTION = 12000;

const MAP_SOURCES = [
  { id: 'mowas', name: 'MoWaS' },
  { id: 'dwd', name: 'DWD' },
  { id: 'katwarn', name: 'KATWARN' },
  { id: 'biwapp', name: 'BIWAPP' },
  { id: 'lhp', name: 'LHP' },
  { id: 'police', name: 'Polizei' }
];

// Приблизительная граница Wuppertal.
// GeoJSON проверяется на пересечение с этой областью.
const CITY_BBOX = {
  west: 7.01,
  east: 7.32,
  south: 51.16,
  north: 51.33
};

export const meta = {
  id: 'nina',
  name: 'NINA / BBK',
  intervalSec: 300,
  cron: '*/5 * * * *',
  group: 'warning'
};

// -------------------- helpers --------------------

function clean(value) {
  if (value == null) return null;

  const text = String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/li>\s*<li[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text || null;
}

function first(...values) {
  for (const value of values) {
    if (value == null) continue;

    if (typeof value === 'string' && !value.trim()) continue;

    return value;
  }

  return null;
}

function arr(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function iso(value) {
  if (!value) return null;

  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : null;
}

function truncateText(value, max = MAX_DESCRIPTION) {
  const text = clean(value);

  if (!text) return null;

  return text.length > max
    ? text.slice(0, max - 1).trimEnd() + '…'
    : text;
}

function ars(env) {
  return /^\d{12}$/.test(env.NINA_ARS || '')
    ? env.NINA_ARS
    : CITY.ars;
}

function dashboardUrl(env) {
  return `${BASE_URL}/dashboard/${ars(env)}.json`;
}

function mapDataUrl(source) {
  return `${BASE_URL}/${source}/mapData.json`;
}

function detailUrl(id) {
  return `${BASE_URL}/warnings/${encodeURIComponent(id)}.json`;
}

function geoJsonUrl(id) {
  return `${BASE_URL}/warnings/${encodeURIComponent(id)}.geojson`;
}

function officialUrl(id) {
  return `https://warnung.bund.de/meldung/${encodeURIComponent(id)}`;
}

function warningId(item) {
  return first(item?.id, item?.identifier, item?.payload?.id);
}

// -------------------- CAP parsing --------------------

function getInfo(detail) {
  const info = first(
    detail?.info,
    detail?.payload?.info,
    detail?.warning?.info
  );

  if (!Array.isArray(info)) return info || {};

  return (
    info.find((x) =>
      String(x?.language || '').toUpperCase().startsWith('DE')
    ) ||
    info[0] ||
    {}
  );
}

function getDashboardData(item) {
  return item?.payload?.data || item?.data || {};
}

function getMsgType(item, detail) {
  return String(first(
    detail?.msgType,
    item?.type,
    item?.payload?.type,
    getDashboardData(item)?.msgType
  ) || 'Alert').toUpperCase();
}

function getTitle(item, detail, info) {
  const data = getDashboardData(item);

  return clean(first(
    info?.headline,
    item?.i18nTitle?.de,
    data?.headline,
    item?.headline,
    ...Object.values(item?.i18nTitle || {})
  ));
}

function getProvider(item, detail, source) {
  const data = getDashboardData(item);

  // CAP sender — технический идентификатор организации.
  // provider — название источника предупреждения.
  return {
    provider: clean(first(
      data?.provider,
      item?.provider,
      source?.name,
      'BBK'
    )),
    sender: clean(first(
      detail?.senderName,
      detail?.sender
    ))
  };
}

function getAreas(info) {
  return arr(info?.area)
    .map((area) => clean(area?.areaDesc))
    .filter(Boolean);
}

function getParameters(info) {
  return arr(info?.parameter)
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      name: clean(p.valueName),
      value: clean(p.value)
    }))
    .filter((p) => p.name || p.value);
}

function getCategories(info) {
  return arr(info?.category)
    .map(clean)
    .filter(Boolean);
}

// -------------------- classification --------------------

function classify(title, event, categories, provider) {
  const text = [
    title,
    event,
    ...categories,
    provider
  ].join(' ').toLowerCase();

  if (/starkregen|sturzflut|flash flood/.test(text)) {
    return 'heavy_rain';
  }

  if (/hochwasser|überschwemm|ueberschwemm|überflutung|ueberflutung|pegel/.test(text)) {
    return 'flood';
  }

  if (/orkan|sturm|windbö|windboe/.test(text)) {
    return 'storm';
  }

  if (/schnee|glätte|glaette|eisregen|frost/.test(text)) {
    return 'weather';
  }

  if (/rauch|brand|explosion|gefahrstoff|chemikal/.test(text)) {
    return 'fire';
  }

  if (/dwd/.test(String(provider).toLowerCase())) {
    return 'weather';
  }

  return 'warning_other';
}

// -------------------- description --------------------

function buildDescription(info, item, detail, provider) {
  const data = getDashboardData(item);
  const sections = [];

  const description = clean(first(
    info?.description,
    data?.description
  ));

  const instruction = clean(first(
    info?.instruction,
    data?.instruction
  ));

  const event = clean(first(
    info?.event,
    data?.event
  ));

  const areas = getAreas(info);
  const parameters = getParameters(info);
  const categories = getCategories(info);

  const urgency = clean(info?.urgency);
  const certainty = clean(info?.certainty);
  const responseType = arr(info?.responseType)
    .map(clean)
    .filter(Boolean);

  const contact = clean(first(info?.contact, detail?.contact));
  const web = clean(first(info?.web, detail?.web));

  if (description) {
    sections.push(description);
  }

  if (instruction) {
    sections.push(`Рекомендации населению:\n${instruction}`);
  }

  if (event) {
    sections.push(`Тип опасности: ${event}`);
  }

  if (categories.length) {
    sections.push(`Категории: ${categories.join(', ')}`);
  }

  if (areas.length) {
    sections.push(`Зона предупреждения: ${areas.join('; ')}`);
  }

  if (urgency) {
    sections.push(`Срочность: ${urgency}`);
  }

  if (certainty) {
    sections.push(`Достоверность: ${certainty}`);
  }

  if (responseType.length) {
    sections.push(`Меры реагирования: ${responseType.join(', ')}`);
  }

  if (parameters.length) {
    sections.push(
      'Дополнительные параметры:\n' +
      parameters.map((p) =>
        `${p.name || 'Параметр'}: ${p.value || '—'}`
      ).join('\n')
    );
  }

  if (contact) {
    sections.push(`Контакт: ${contact}`);
  }

  if (web) {
    sections.push(`Дополнительная информация: ${web}`);
  }

  if (!sections.length) {
    sections.push(`Официальное предупреждение ${provider} для Wuppertal.`);
  }

  return truncateText(sections.join('\n\n'));
}

// -------------------- normalization --------------------

function toItem(item, detail = null, source = null) {
  if (!item || typeof item !== 'object' || !warningId(item)) {
    return null;
  }

  const info = getInfo(detail);
  const msgType = getMsgType(item, detail);

  // Cancel не создаёт отдельное предупреждение.
  // Исходное предупреждение исчезнет из актуального feed.
  if (msgType === 'CANCEL') return null;

  const title = getTitle(item, detail, info);
  if (!title) return null;

  const data = getDashboardData(item);
  const { provider, sender } = getProvider(item, detail, source);

  const event = clean(first(info?.event, data?.event));
  const categories = getCategories(info);
  const description = buildDescription(info, item, detail, provider);

  // Время события и время публикации — разные значения.
  const onset = first(info?.onset, data?.onset);
  const effective = first(info?.effective, data?.effective);
  const startDate = first(item?.startDate, data?.startDate);

  const eventTime = iso(first(onset, effective, startDate));
  const sent = iso(first(detail?.sent, item?.sent, data?.sent));

  const expires = iso(first(
    info?.expires,
    item?.expiresDate,
    data?.expiresDate,
    item?.expires,
    data?.expires
  ));

  const severity = first(info?.severity, data?.severity, item?.severity);

  return {
    source_event_id: String(warningId(item)),

    publisher: sender
      ? `NINA / ${provider} / ${sender}`
      : `NINA / ${provider}`,

    title,
    description,

    category: classify(title, event, categories, provider),

    source_url: officialUrl(warningId(item)),

    latitude: null,
    longitude: null,
    geo_precision: 'unknown',
    location_name: null,

    event_time: eventTime,
    time_precision: eventTime ? 'exact' : 'unknown',

    published_at: sent,

    status: 'ACTIVE',
    status_reason: 'listed_in_current_source_feed',

    confidence: 0.85,
    is_verified: 1,

    severity: severity ? String(severity) : null,
    expires_at: expires
  };
}

// -------------------- concurrency --------------------

async function mapConcurrent(items, concurrency, fn) {
  const result = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;

      if (index >= items.length) return;

      result[index] = await fn(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker()
    )
  );

  return result;
}

// -------------------- requests --------------------

async function fetchArray(url, name) {
  const { json } = await fetchJson(url);

  if (!Array.isArray(json)) {
    throw new Error(`${name}: ожидался JSON-массив`);
  }

  return json;
}

async function fetchDetail(id) {
  try {
    const { json } = await fetchJson(detailUrl(id));
    return json || null;
  } catch (error) {
    console.warn(
      `[nina] detail ${id}: ${error?.message || String(error)}`
    );

    return null;
  }
}

async function fetchGeo(id) {
  try {
    const { json } = await fetchJson(geoJsonUrl(id));

    if (!json || typeof json !== 'object') {
      return null;
    }

    return json;
  } catch (error) {
    console.warn(
      `[nina] geo ${id}: ${error?.message || String(error)}`
    );

    return null;
  }
}

// -------------------- GeoJSON --------------------

function coordinatePoints(value, result = []) {
  if (!Array.isArray(value)) return result;

  if (
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  ) {
    result.push(value);
    return result;
  }

  for (const child of value) {
    coordinatePoints(child, result);
  }

  return result;
}

function getGeoCoordinates(geo) {
  if (!geo) return [];

  const geometries = [];

  if (geo.type === 'FeatureCollection') {
    for (const feature of arr(geo.features)) {
      if (feature?.geometry) geometries.push(feature.geometry);
    }
  } else if (geo.type === 'Feature') {
    if (geo.geometry) geometries.push(geo.geometry);
  } else if (geo.coordinates || geo.geometries) {
    geometries.push(geo);
  }

  const points = [];

  for (const geometry of geometries) {
    if (geometry.type === 'GeometryCollection') {
      for (const child of arr(geometry.geometries)) {
        coordinatePoints(child?.coordinates, points);
      }
    } else {
      coordinatePoints(geometry.coordinates, points);
    }
  }

  return points;
}

function intersectsCity(geo) {
  const points = getGeoCoordinates(geo);

  if (!points.length) return false;

  const west = Math.min(...points.map(p => p[0]));
  const east = Math.max(...points.map(p => p[0]));
  const south = Math.min(...points.map(p => p[1]));
  const north = Math.max(...points.map(p => p[1]));

  return (
    east >= CITY_BBOX.west &&
    west <= CITY_BBOX.east &&
    north >= CITY_BBOX.south &&
    south <= CITY_BBOX.north
  );
}

function mentionsCity(item, detail) {
  const info = getInfo(detail);

  const text = [
    getTitle(item, detail, info),
    info?.description,
    info?.instruction,
    getAreas(info).join(' ')
  ].join(' ');

  return /\bwuppertal\b/i.test(text);
}

async function belongsToCity(item, detail, geo) {
  // Явное упоминание города.
  if (mentionsCity(item, detail)) {
    return {
      accepted: true,
      precision: 'city',
      confidence: 0.9
    };
  }

  // GeoJSON — географическая проверка.
  if (geo) {
    const accepted = intersectsCity(geo);

    return {
      accepted,
      precision: accepted ? 'area' : 'unknown',
      confidence: accepted ? 0.9 : 0
    };
  }

  // Без GeoJSON нельзя уверенно определить территорию.
  return {
    accepted: false,
    precision: 'unknown',
    confidence: 0
  };
}

// -------------------- feed loading --------------------

async function loadDashboard(env) {
  const url = dashboardUrl(env);
  const items = await fetchArray(url, 'NINA dashboard');

  return items.map(item => ({
    item,
    source: { id: 'dashboard', name: 'BBK' },
    localDashboard: true
  }));
}

async function loadMapFeeds() {
  const results = await Promise.allSettled(
    MAP_SOURCES.map(async source => {
      const items = await fetchArray(
        mapDataUrl(source.id),
        source.id
      );

      return items.map(item => ({
        item,
        source,
        localDashboard: false
      }));
    })
  );

  const records = [];
  const errors = [];
  let successful = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];

    if (result.status === 'fulfilled') {
      successful++;
      records.push(...result.value);
    } else {
      errors.push({
        source: MAP_SOURCES[i].id,
        error: result.reason?.message || String(result.reason)
      });

      console.warn(
        `[nina] feed ${MAP_SOURCES[i].id} failed:`,
        result.reason?.message || result.reason
      );
    }
  }

  return {
    records,
    successful,
    errors
  };
}

// -------------------- main --------------------

export async function run(ctx) {
  // Dashboard Wuppertal.
  // Ошибка здесь должна прервать запуск, а не завершить все события.
  const dashboardRecords = await loadDashboard(ctx.env);

  // Остальные системы предупреждений.
  const mapFeeds = await loadMapFeeds();

  const combined = [
    ...dashboardRecords,
    ...mapFeeds.records
  ];

  // Deduplicate по CAP ID.
  // Приоритет — локальный dashboard.
  const unique = new Map();

  for (const record of combined) {
    const id = warningId(record.item);

    if (!id) continue;

    const existing = unique.get(id);

    if (!existing || record.localDashboard) {
      unique.set(id, record);
    }
  }

  const records = [...unique.values()];

  // Подробности CAP.
  const details = await mapConcurrent(
    records,
    DETAIL_CONCURRENCY,
    async record => fetchDetail(warningId(record.item))
  );

  // GeoJSON нужен только для предупреждений из mapData.
  const geoRecords = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => !record.localDashboard);

  const geoResults = await mapConcurrent(
    geoRecords,
    GEO_CONCURRENCY,
    async ({ record }) => fetchGeo(warningId(record.item))
  );

  const geoByIndex = new Map();

  let geoFailures = 0;

  geoRecords.forEach((entry, i) => {
    const geo = geoResults[i];

    geoByIndex.set(entry.index, geo);

    if (!geo) {
      geoFailures++;
    }
  });

  const items = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const detail = details[i];

    const event = toItem(
      record.item,
      detail,
      record.source
    );

    if (!event) continue;

    // Dashboard уже содержит предупреждения своего ARS.
    if (record.localDashboard) {
      event.geo_precision = 'city';
      event.location_name = CITY.name;
      event.confidence = 0.95;

      items.push(event);
      continue;
    }

    const geo = geoByIndex.get(i);

    const location = await belongsToCity(
      record.item,
      detail,
      geo
    );

    if (!location.accepted) continue;

    event.geo_precision = location.precision;
    event.location_name = CITY.name;
    event.confidence = location.confidence;

    items.push(event);
  }

  // Синхронизация безопасна только при полной загрузке feeds
  // и отсутствии ошибок GeoJSON.
  const complete =
    mapFeeds.successful === MAP_SOURCES.length &&
    geoFailures === 0;

  console.log(
    `[nina] dashboard=${dashboardRecords.length}, ` +
    `map=${mapFeeds.records.length}, ` +
    `unique=${records.length}, ` +
    `accepted=${items.length}, ` +
    `feeds=${mapFeeds.successful}/${MAP_SOURCES.length}, ` +
    `geo_errors=${geoFailures}, ` +
    `resolveMissing=${complete}`
  );

  return syncSource(ctx, meta.id, items, {
    resolveMissing: complete,
    resolvedScopes: complete ? null : [],
    scope: null
  });
}

// -------------------- probe --------------------

export async function probe(ctx) {
  const url = dashboardUrl(ctx.env);

  const { json, text } = await fetchJson(url);

  if (!Array.isArray(json)) {
    throw new Error('NINA dashboard: ожидался JSON-массив');
  }

  const dashboard = json;
  const firstItem = dashboard.find(item => warningId(item));

  const detail = firstItem
    ? await fetchDetail(warningId(firstItem))
    : null;

  const feeds = {};

  for (const source of MAP_SOURCES) {
    const feedUrl = mapDataUrl(source.id);

    try {
      const items = await fetchArray(feedUrl, source.id);

      feeds[source.id] = {
        url: feedUrl,
        count: items.length,
        sample: items.slice(0, 2)
      };
    } catch (error) {
      feeds[source.id] = {
        url: feedUrl,
        error: error?.message || String(error)
      };
    }
  }

  const firstMapWarning = Object.values(feeds)
    .find(feed => feed.count > 0)?.sample?.[0];

  let mapDetail = null;
  let geo = null;

  if (firstMapWarning?.id) {
    mapDetail = await fetchDetail(firstMapWarning.id);
    geo = await fetchGeo(firstMapWarning.id);
  }

  return {
    url,
    count: dashboard.length,
    dashboard_sample: dashboard.slice(0, 2),

    detail_url: firstItem
      ? detailUrl(warningId(firstItem))
      : null,

    detail_sample: detail,

    geojson_url: firstItem
      ? geoJsonUrl(warningId(firstItem))
      : null,

    feeds,

    map_warning_id: firstMapWarning?.id || null,

    map_detail_url: firstMapWarning?.id
      ? detailUrl(firstMapWarning.id)
      : null,

    map_detail_sample: mapDetail,

    map_geojson_url: firstMapWarning?.id
      ? geoJsonUrl(firstMapWarning.id)
      : null,

    map_geojson_sample: geo,

    city_bbox: CITY_BBOX,

    raw: text.slice(0, 3000)
  };
}
