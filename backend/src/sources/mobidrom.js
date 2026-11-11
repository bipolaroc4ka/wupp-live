
import { inCityBbox } from '../config.js';
import { fetchWithRetry, ISO, truncate, shortId } from '../util.js';
import { geocodeStreet } from '../geo.js';
import { syncSource } from '../events.js';

export const meta = {
  id: 'mobidrom',
  name: 'NRW.Mobidrom (DATEX II Arbeitsstellen)',
  intervalSec: 600,
  cron: '*/10 * * * *',
  group: 'traffic'
};

const FEED_URL =
  'https://www.mobilitaetsdaten.nrw/api/systemadapter-mobilithek-exporter/arbeitsstellen-nrw.xml';

const SCOPE = 'nrw/roadworks';
const DAY = 86400000;
const EVENT_TTL_DAYS = 14;
const MAX_FUTURE_DAYS = 30;

const ALLOWED_GEO_PRECISIONS = new Set([
  'source',
  'street',
  'district',
  'city',
  'none'
]);

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, value) => {
      const code = Number(value);

      return code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => {
      const code = parseInt(value, 16);

      return code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    });
}

function cleanText(value) {
  return decodeXml(
    String(value || '').replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tagValues(xml, tag) {
  const escaped = escapeRegExp(tag);

  const re = new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>`,
    'gi'
  );

  return [...xml.matchAll(re)]
    .map((match) => cleanText(match[1]))
    .filter(Boolean);
}

function firstTag(xml, names) {
  for (const name of names) {
    const values = tagValues(xml, name);

    if (values.length) return values[0];
  }

  return null;
}

function openingAttributes(block, tagName) {
  const escaped = escapeRegExp(tagName);

  const match = block.match(
    new RegExp(
      `<(?:[\\w.-]+:)?${escaped}\\b([^>]*)>`,
      'i'
    )
  );

  return match ? match[1] : '';
}

function attributeValue(attributes, names) {
  for (const name of names) {
    const escaped = escapeRegExp(name);

    const match = attributes.match(
      new RegExp(
        `(?:^|\\s)${escaped}\\s*=\\s*["']([^"']*)["']`,
        'i'
      )
    );

    if (match) return decodeXml(match[1]);
  }

  return null;
}

function elementBlocks(xml, name) {
  const escaped = escapeRegExp(name);

  const re = new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>[\\s\\S]*?<\\/(?:[\\w.-]+:)?${escaped}\\s*>`,
    'gi'
  );

  return [...xml.matchAll(re)].map((match) => match[0]);
}

function situationBlocks(xml) {
  return elementBlocks(xml, 'situation');
}

function recordBlocks(xml) {
  return elementBlocks(xml, 'situationRecord');
}

function elementId(block, name) {
  const attributes = openingAttributes(block, name);

  return attributeValue(attributes, ['id', 'recordId']);
}

function normalizeGeoPrecision(value, fallback = 'street') {
  if (ALLOWED_GEO_PRECISIONS.has(value)) {
    return value;
  }

  return fallback;
}

function validPoint(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    inCityBbox(lat, lon)
  );
}

/**
 * DATEX II GML posList обычно содержит пары координат.
 *
 * Порядок координат может различаться у поставщиков.
 * Проверяем оба варианта и оставляем только точки
 * внутри географических границ Wuppertal.
 */
function parsePositionPairs(value) {
  const numbers = String(value || '')
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number);

  const points = [];

  for (let i = 0; i + 1 < numbers.length; i += 2) {
    const a = numbers[i];
    const b = numbers[i + 1];

    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      continue;
    }

    const candidates = [
      { lat: a, lon: b },
      { lat: b, lon: a }
    ];

    const point = candidates.find(
      (candidate) => validPoint(candidate.lat, candidate.lon)
    );

    if (point) points.push(point);
  }

  return points;
}

function coordinates(block) {
  const points = [];

  for (const value of tagValues(block, 'posList')) {
    points.push(...parsePositionPairs(value));
  }

  for (const value of tagValues(block, 'pos')) {
    points.push(...parsePositionPairs(value));
  }

  // Удаляем повторяющиеся вершины.
  const unique = [
    ...new Map(
      points.map((point) => [
        `${point.lat.toFixed(6)}:${point.lon.toFixed(6)}`,
        point
      ])
    ).values()
  ];

  if (!unique.length) return null;

  // Центр геометрии дорожного участка.
  const lat =
    unique.reduce((sum, point) => sum + point.lat, 0) /
    unique.length;

  const lon =
    unique.reduce((sum, point) => sum + point.lon, 0) /
    unique.length;

  if (!validPoint(lat, lon)) {
    return unique[0];
  }

  return { lat, lon };
}

function parseDate(value) {
  if (!value) return null;

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? ms : null;
}

function extractStreet(text) {
  if (!text) return null;

  const patterns = [
    /\b([A-ZÄÖÜ][\p{L}\d.-]*(?:straße|strasse|str\.|weg|platz|allee|ufer|gasse|ring|damm|chaussee))\b/iu,
    /\b([A-ZÄÖÜ][\p{L}\d.-]*(?:\s+[A-ZÄÖÜ][\p{L}\d.-]*){0,4}\s+(?:straße|strasse|str\.|weg|platz|allee|ufer|gasse|ring|damm|chaussee))\b/iu
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) return match[1].trim();
  }

  return null;
}

function classify(text, recordTypes = []) {
  const value = String(text || '');

  // Полное перекрытие или явно указанная блокировка дороги.
  if (
    /\b(vollsperrung|voll gesperrt|gesperrt|sperrung|umleitung|closed|closed road|road closed)\b/i.test(
      value
    )
  ) {
    return 'road_closure';
  }

  // DATEX II типы, явно связанные с дорожными работами.
  if (
    recordTypes.some((type) =>
      /MaintenanceWorks|ConstructionWorks/i.test(type)
    )
  ) {
    return 'roadworks';
  }

  // Тексты о строительстве, ремонте и обслуживании дорог.
  if (
    /\b(baustelle|bauarbeiten|bauabschnitt|sanierung|erneuerung|reparatur|instandsetzung|fahrbahnsanierung|straßenbau|strassenbau|kanalarbeiten|brückenarbeiten|brueckenarbeiten|markierungsarbeiten|arbeitsstelle)\b/i.test(
      value
    )
  ) {
    return 'roadworks';
  }

  // Остальные записи этого фида относятся к дорожным работам
  // или связанным с ними ограничениям.
  return 'roadworks';
}

function parseRecord(block) {
  const attributes = openingAttributes(block, 'situationRecord');

  const type =
    attributeValue(attributes, ['xsi:type', 'type']) || '';

  const road = firstTag(block, [
    'roadName',
    'roadNumber',
    'roadNumberIdentifier'
  ]);

  const location = firstTag(block, [
    'locationDescription',
    'supplementaryPositionalDescription',
    'alertCLine'
  ]);

  const comments = [
    ...tagValues(block, 'generalPublicComment'),
    ...tagValues(block, 'comment'),
    ...tagValues(block, 'value'),
    ...tagValues(block, 'roadworksName'),
    ...tagValues(block, 'roadworksType'),
    ...tagValues(block, 'roadworksSubType'),
    ...tagValues(block, 'subjectTypeOfWorks')
  ];

  const description = [...new Set(comments)]
    .join(' · ');

  const combinedText = [
    road,
    location,
    description
  ].filter(Boolean).join(' · ');

  const street = extractStreet(combinedText);

  const title =
    road ||
    street ||
    location ||
    description.slice(0, 150);

  if (!title && !description) return null;

  const start = parseDate(
    firstTag(block, [
      'overallStartTime',
      'startOfPeriod',
      'situationRecordCreationTime'
    ])
  );

  const end = parseDate(
    firstTag(block, [
      'overallEndTime',
      'endOfPeriod'
    ])
  );

  return {
    id: elementId(block, 'situationRecord'),
    type,
    title: truncate(title || 'Baustelle', 220),
    description: truncate(description, 1600),
    road,
    street,
    location,
    start,
    end,
    coordinates: coordinates(block)
  };
}

function typePriority(type) {
  if (/MaintenanceWorks|ConstructionWorks/i.test(type)) {
    return 3;
  }

  if (/RoadOrCarriagewayOrLaneManagement/i.test(type)) {
    return 1;
  }

  return 2;
}

/**
 * Объединяет все situationRecord внутри одной DATEX II situation.
 *
 * Одна дорожная ситуация может содержать несколько связанных
 * записей и геометрий. На карту отправляем одно событие.
 */
function parseSituation(block) {
  const records = recordBlocks(block)
    .map(parseRecord)
    .filter(Boolean);

  if (!records.length) return null;

  records.sort(
    (a, b) => typePriority(b.type) - typePriority(a.type)
  );

  const main = records[0];

  const descriptions = [
    ...new Set(
      records
        .map((record) => record.description)
        .filter(Boolean)
    )
  ];

  const roads = [
    ...new Set(
      records
        .map((record) => record.road)
        .filter(Boolean)
    )
  ];

  const streets = [
    ...new Set(
      records
        .map((record) => record.street)
        .filter(Boolean)
    )
  ];

  const locations = [
    ...new Set(
      records
        .map((record) => record.location)
        .filter(Boolean)
    )
  ];

  const points = records
    .map((record) => record.coordinates)
    .filter(Boolean);

  let point = null;

  if (points.length) {
    const lat =
      points.reduce((sum, item) => sum + item.lat, 0) /
      points.length;

    const lon =
      points.reduce((sum, item) => sum + item.lon, 0) /
      points.length;

    if (validPoint(lat, lon)) {
      point = { lat, lon };
    } else {
      // Если средняя точка вышла за границы города,
      // используем первую валидную геометрию.
      point = points[0];
    }
  }

  const starts = records
    .map((record) => record.start)
    .filter(Number.isFinite);

  const ends = records
    .map((record) => record.end)
    .filter(Number.isFinite);

  const start = starts.length
    ? Math.min(...starts)
    : null;

  const end = ends.length
    ? Math.max(...ends)
    : null;

  const situationId = elementId(block, 'situation');

  const title =
    main.road ||
    main.street ||
    main.location ||
    main.title ||
    'Baustelle';

  return {
    id: situationId,
    recordCount: records.length,
    title: truncate(title, 220),
    description: truncate(descriptions.join(' · '), 1600),
    road: roads[0] || null,
    street: streets[0] || null,
    location: locations[0] || null,
    start,
    end,
    coordinates: point,
    recordTypes: records.map((record) => record.type)
  };
}

async function makeEvent(ctx, situation) {
  const text = [
    situation.title,
    situation.description,
    situation.road,
    situation.street,
    situation.location
  ].filter(Boolean).join(' ');

  let point = situation.coordinates;
  let precision = point ? 'source' : 'none';
  let district = null;
  let geocoded = false;

  // Геометрия DATEX II имеет приоритет.
  // Геокодируем только записи без координат,
  // в тексте которых явно указан Wuppertal.
  if (!point && /\bWuppertal\b/i.test(text)) {
    const street =
      situation.street ||
      extractStreet(text);

    if (street && ctx.geoBudget > 0) {
      try {
        const geo = await geocodeStreet(ctx, street);

        if (
          geo &&
          !geo.pending &&
          Number.isFinite(geo.lat) &&
          Number.isFinite(geo.lon) &&
          validPoint(geo.lat, geo.lon)
        ) {
          point = {
            lat: geo.lat,
            lon: geo.lon
          };

          // Не допускаем невалидные значения из геокодера
          // в колонку geo_precision.
          precision = normalizeGeoPrecision(
            geo.precision,
            'street'
          );

          district = geo.district || null;
          geocoded = true;
        }
      } catch (error) {
        ctx.log(`mobidrom geocode ${street}: ${error.message}`);
      }
    }
  }

  if (!point || !validPoint(point.lat, point.lon)) {
    return null;
  }

  // Не публикуем события, завершившиеся до текущего времени.
  if (situation.end && situation.end < ctx.now) {
    return null;
  }

  // Не берём слишком далёкие будущие работы.
  if (
    situation.start &&
    situation.start > ctx.now + MAX_FUTURE_DAYS * DAY
  ) {
    return null;
  }

  const endExpiry = situation.end
    ? situation.end + 2 * DAY
    : 0;

  const startExpiry = situation.start
    ? situation.start + EVENT_TTL_DAYS * DAY
    : 0;

  const expiresAt = Math.max(
    ctx.now + EVENT_TTL_DAYS * DAY,
    endExpiry,
    startExpiry
  );

  // Стабильный ID родительской DATEX II situation.
  // Не используем случайные значения или координаты.
  const stableId =
    situation.id ||
    [
      situation.title,
      situation.road || '',
      situation.start || ''
    ].join('|');

  const isScheduled =
    Boolean(situation.start && situation.start > ctx.now);

  const category = classify(
    text,
    situation.recordTypes
  );

  const confidence = geocoded
    ? 0.68
    : precision === 'source'
      ? 0.9
      : 0.65;

  return {
    source_event_id: await shortId(stableId),
    scope: SCOPE,
    publisher: 'NRW.Mobidrom / Straßen.NRW',
    title: situation.title,
    description: situation.description || null,
    category,
    source_url: FEED_URL,
    latitude: point.lat,
    longitude: point.lon,
    geo_precision: precision,
    location_name:
      situation.road ||
      situation.street ||
      situation.location ||
      situation.title,
    district,
    event_time: situation.start
      ? ISO(situation.start)
      : null,
    time_precision: situation.start
      ? 'minute'
      : 'unknown',
    published_at: null,
    expires_at: ISO(expiresAt),
    status: 'ACTIVE',
    status_reason: isScheduled
      ? 'scheduled_in_mobidrom_datex_feed'
      : 'listed_in_mobidrom_datex_feed',
    confidence,
    is_verified: 1
  };
}

function parseFeed(xml) {
  if (!/<(?:[\w.-]+:)?d2LogicalModel\b/i.test(xml)) {
    throw new Error(
      'Mobidrom returned unexpected DATEX II XML'
    );
  }

  const situations = situationBlocks(xml);

  if (!situations.length) {
    throw new Error(
      'No DATEX II situation elements found; refusing empty sync'
    );
  }

  const parsed = situations
    .map(parseSituation)
    .filter(Boolean);

  if (!parsed.length) {
    throw new Error(
      'No DATEX II situations could be parsed; refusing empty sync'
    );
  }

  return {
    situations,
    parsed
  };
}

async function fetchFeed() {
  const response = await fetchWithRetry(FEED_URL, {
    timeoutMs: 20000,
    retries: 2,
    backoffMs: 1000,
    headers: {
      accept: 'application/xml, text/xml, application/octet-stream',
      'user-agent': 'WuppertalLive/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Mobidrom HTTP ${response.status}`);
  }

  const xml = await response.text();

  if (!xml || xml.length < 1000) {
    throw new Error(
      'Mobidrom returned an unexpectedly small XML feed'
    );
  }

  return xml;
}

export async function run(ctx) {
  const xml = await fetchFeed();

  const {
    situations,
    parsed
  } = parseFeed(xml);

  const withCoordinates = parsed.filter(
    (item) => item.coordinates
  ).length;

  if (!withCoordinates) {
    throw new Error(
      'No usable Wuppertal coordinates in DATEX II situations; refusing sync'
    );
  }

  const events = [];

  for (const situation of parsed) {
    const event = await makeEvent(ctx, situation);

    if (event) events.push(event);
  }

  // Не разрешаем отсутствующие записи автоматически:
  // DATEX II ситуации могут временно не иметь геометрии
  // или не распознаваться парсером.
  //
  // Завершение работ обрабатывается через expires_at.
  const stats = await syncSource(ctx, meta.id, events, {
    resolveMissing: false
  });

  return {
    ...stats,
    datex_situations: situations.length,
    parsed_situations: parsed.length,
    situations_with_coordinates: withCoordinates,
    situations_without_coordinates:
      parsed.length - withCoordinates,
    wuppertal_events: events.length,
    grouped_records: parsed.reduce(
      (sum, item) => sum + item.recordCount,
      0
    )
  };
}

export async function probe() {
  const xml = await fetchFeed();

  const {
    situations,
    parsed
  } = parseFeed(xml);

  const withCoordinates = parsed.filter(
    (item) => item.coordinates
  );

  return {
    url: FEED_URL,
    status: 200,
    xml_bytes: new TextEncoder().encode(xml).length,
    situations: situations.length,
    parsed_situations: parsed.length,
    situations_with_coordinates: withCoordinates.length,
    situations_without_coordinates:
      parsed.length - withCoordinates.length,
    grouped_records: parsed.reduce(
      (sum, item) => sum + item.recordCount,
      0
    ),
    sample: withCoordinates.slice(0, 5).map((item) => ({
      situation_id: item.id,
      title: item.title,
      road: item.road,
      street: item.street,
      coordinates: item.coordinates,
      records_in_situation: item.recordCount,
      start: item.start ? ISO(item.start) : null,
      end: item.end ? ISO(item.end) : null
    }))
  };
}
