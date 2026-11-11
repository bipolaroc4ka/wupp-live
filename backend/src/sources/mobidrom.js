
import { CITY, inCityBbox } from '../config.js';
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

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
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
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        `(?:^|\\s)${escaped}\\s*=\\s*["']([^"']+)["']`,
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

function inValidCoordinateRange(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * DATEX II GML posList обычно содержит последовательность пар:
 * latitude longitude.
 *
 * У разных поставщиков возможен другой порядок.
 * Поэтому проверяем оба варианта по границам Wuppertal.
 */
function parsePositionPairs(value) {
  const numbers = String(value || '')
    .trim()
    .split(/[\s,;]+/)
    .map(Number)
    .filter(Number.isFinite);

  const points = [];

  for (let i = 0; i + 1 < numbers.length; i += 2) {
    const a = numbers[i];
    const b = numbers[i + 1];

    const candidates = [
      { lat: a, lon: b },
      { lat: b, lon: a }
    ];

    const point = candidates.find(
      (candidate) =>
        inValidCoordinateRange(candidate.lat, candidate.lon) &&
        inCityBbox(candidate.lat, candidate.lon)
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

  // Убираем повторяющиеся вершины.
  const unique = [
    ...new Map(
      points.map((point) => [
        `${point.lat.toFixed(6)}:${point.lon.toFixed(6)}`,
        point
      ])
    ).values()
  ];

  if (!unique.length) return null;

  // Для одной точки на карте используем центр геометрии,
  // а не первую вершину дорожного участка.
  const lat =
    unique.reduce((sum, point) => sum + point.lat, 0) /
    unique.length;

  const lon =
    unique.reduce((sum, point) => sum + point.lon, 0) /
    unique.length;

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

function classify(text) {
  if (
    /\b(vollsperrung|voll gesperrt|gesperrt|sperrung|umleitung|closed|closed road|road closed)\b/i.test(
      text
    )
  ) {
    return 'road_closure';
  }

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
  if (/MaintenanceWorks|ConstructionWorks/i.test(type)) return 3;
  if (/RoadOrCarriagewayOrLaneManagement/i.test(type)) return 1;
  return 2;
}

/**
 * Объединяет все situationRecord внутри одной DATEX II situation.
 * Одна дорожная ситуация может содержать несколько связанных
 * записей и геометрий.
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
      points.reduce((sum, p) => sum + p.lat, 0) /
      points.length;

    const lon =
      points.reduce((sum, p) => sum + p.lon, 0) /
      points.length;

    if (inCityBbox(lat, lon)) {
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

  const start = starts.length ? Math.min(...starts) : null;
  const end = ends.length ? Math.max(...ends) : null;

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

  // Геокодируем только явно относящиеся к Wuppertal записи.
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
          inCityBbox(geo.lat, geo.lon)
        ) {
          point = { lat: geo.lat, lon: geo.lon };
          precision = geo.precision;
          district = geo.district || null;
        }
      } catch (error) {
        ctx.log(`mobidrom geocode ${street}: ${error.message}`);
      }
    }
  }

  if (!point) return null;

  // События, завершившиеся до текущего времени, не публикуем.
  if (situation.end && situation.end < ctx.now) return null;

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

  const stableId =
    situation.id ||
    [
      situation.title,
      situation.road || '',
      situation.start || ''
    ].join('|');

  const isScheduled =
    situation.start && situation.start > ctx.now;

  return {
    source_event_id: await shortId(stableId),
    scope: SCOPE,
    publisher: 'NRW.Mobidrom / Straßen.NRW',
    title: situation.title,
    description: situation.description || null,
    category: classify(text),
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
    time_precision: situation.start ? 'minute' : 'unknown',
    published_at: null,
    expires_at: ISO(expiresAt),
    status: 'ACTIVE',
    status_reason: isScheduled
      ? 'scheduled_in_mobidrom_datex_feed'
      : 'listed_in_mobidrom_datex_feed',
    confidence: precision === 'source' ? 0.9 : 0.65,
    is_verified: 1
  };
}

function parseFeed(xml) {
  if (!/<(?:[\w.-]+:)?d2LogicalModel\b/i.test(xml)) {
    throw new Error('Mobidrom returned unexpected DATEX II XML');
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
    throw new Error('Mobidrom returned an unexpectedly small XML feed');
  }

  return xml;
}

export async function run(ctx) {
  const xml = await fetchFeed();
  const { situations, parsed } = parseFeed(xml);

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
  // часть DATEX II ситуаций может не иметь геометрии или
  // временно не распознаваться парсером.
  // Завершение работ обрабатывается через expires_at.
  const stats = await syncSource(ctx, meta.id, events, {
    resolveMissing: false
  });

  return {
    ...stats,
    datex_situations: situations.length,
    parsed_situations: parsed.length,
    situations_with_coordinates: withCoordinates,
    situations_without_coordinates: parsed.length - withCoordinates,
    wuppertal_events: events.length,
    grouped_records: parsed.reduce(
      (sum, item) => sum + item.recordCount,
      0
    )
  };
}

export async function probe() {
  const xml = await fetchFeed();
  const { situations, parsed } = parseFeed(xml);

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
