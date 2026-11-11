
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
const EVENT_TTL_DAYS = 14;

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    );
}

function cleanText(value) {
  return decodeXml(
    String(value || '')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValues(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const re = new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>`,
    'gi'
  );

  return [...xml.matchAll(re)]
    .map((m) => cleanText(m[1]))
    .filter(Boolean);
}

function firstTag(xml, names) {
  for (const name of names) {
    const values = tagValues(xml, name);
    if (values.length) return values[0];
  }

  return null;
}

function recordBlocks(xml) {
  const blocks = [];
  const re =
    /<(?:[\w.-]+:)?situationRecord\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?situationRecord\s*>/gi;

  let match;

  while ((match = re.exec(xml))) {
    blocks.push(match[0]);
  }

  return blocks;
}

function recordId(block) {
  const opening = block.match(
    /<(?:[\w.-]+:)?situationRecord\b([^>]*)>/i
  );

  if (!opening) return null;

  const id = opening[1].match(
    /\b(?:id|recordId)\s*=\s*["']([^"']+)["']/i
  );

  return id ? decodeXml(id[1]) : null;
}

function coordinates(block) {
  const lats = tagValues(block, 'latitude')
    .map(Number)
    .filter(Number.isFinite);

  const lons = tagValues(block, 'longitude')
    .map(Number)
    .filter(Number.isFinite);

  const pairs = [];

  for (let i = 0; i < Math.min(lats.length, lons.length); i++) {
    if (
      lats[i] >= -90 && lats[i] <= 90 &&
      lons[i] >= -180 && lons[i] <= 180
    ) {
      pairs.push({ lat: lats[i], lon: lons[i] });
    }
  }

  // DATEX II kann Koordinaten auch als GML pos enthalten:
  // "latitude longitude".
  const positions = tagValues(block, 'pos');

  for (const position of positions) {
    const values = position.trim().split(/[\s,]+/).map(Number);

    if (
      values.length >= 2 &&
      Number.isFinite(values[0]) &&
      Number.isFinite(values[1])
    ) {
      const [lat, lon] = values;

      if (
        lat >= -90 && lat <= 90 &&
        lon >= -180 && lon <= 180
      ) {
        pairs.push({ lat, lon });
      }
    }
  }

  return pairs.find((p) => inCityBbox(p.lat, p.lon)) || null;
}

function parseDate(value) {
  if (!value) return null;

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function extractStreet(text) {
  const match = text.match(
    /\b([A-ZÄÖÜ][\p{L}\d.-]*(?:\s+[A-ZÄÖÜ][\p{L}\d.-]*){0,3}\s+(?:straße|strasse|weg|platz|allee|ufer|gasse|ring|damm|chaussee))\b/iu
  );

  return match ? match[1].trim() : null;
}

function classify(text) {
  if (
    /\b(vollsperrung|voll gesperrt|gesperrt|sperrung|umleitung|closed|closed road|road closed)\b/i.test(text)
  ) {
    return 'road_closure';
  }

  return 'roadworks';
}

function parseRecord(block) {
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

  const title = road || location || description.slice(0, 150);

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
    id: recordId(block),
    title: truncate(title || 'Baustelle', 220),
    description: truncate(description, 1600),
    road,
    location,
    start,
    end,
    coordinates: coordinates(block)
  };
}

async function makeEvent(ctx, record) {
  const text = `${record.title} ${record.description} ${record.road || ''} ${record.location || ''}`;

  let point = record.coordinates;
  let precision = point ? 'source' : 'none';
  let district = null;

  // Координаты за пределами города уже отфильтрованы.
  // Без координат геокодируем только записи, в которых
  // явно упоминается Wuppertal.
  if (!point && /\bWuppertal\b/i.test(text)) {
    const street = extractStreet(text);

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

  if (record.start && record.start > ctx.now) return null;
  if (record.end && record.end < ctx.now) return null;

  const expiresAt = record.end
    ? record.end + 2 * 86400000
    : ctx.now + EVENT_TTL_DAYS * 86400000;

  const stableId = record.id ||
    `${record.title}|${record.road || ''}|${record.start || ''}`;

  return {
    source_event_id: await shortId(stableId),
    scope: SCOPE,
    publisher: 'NRW.Mobidrom / Straßen.NRW',
    title: record.title,
    description: record.description || null,
    category: classify(text),
    source_url: FEED_URL,
    latitude: point.lat,
    longitude: point.lon,
    geo_precision: precision,
    location_name: record.road || record.location || record.title,
    district,
    event_time: record.start ? ISO(record.start) : null,
    time_precision: record.start ? 'minute' : 'unknown',
    published_at: null,
    expires_at: ISO(expiresAt),
    status: 'ACTIVE',
    status_reason: 'listed_in_mobidrom_datex_feed',
    confidence: precision === 'source' ? 0.9 : 0.65,
    is_verified: 1
  };
}

export async function run(ctx) {
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

  if (!/<(?:[\w.-]+:)?d2LogicalModel\b/i.test(xml)) {
    throw new Error('Mobidrom returned unexpected DATEX II XML');
  }

  const blocks = recordBlocks(xml);

  if (!blocks.length) {
    throw new Error(
      'No DATEX II situationRecord elements found; refusing empty sync'
    );
  }

  const records = blocks
    .map(parseRecord)
    .filter(Boolean);

  if (!records.length) {
    throw new Error(
      'DATEX II records could not be parsed; refusing empty sync'
    );
  }

  const coordinateCount = records.filter(
    (record) => record.coordinates
  ).length;

  if (!coordinateCount) {
    throw new Error(
      'No usable coordinates in DATEX II records; refusing empty sync'
    );
  }

  const events = [];

  for (const record of records) {
    const event = await makeEvent(ctx, record);
    if (event) events.push(event);
  }

  const stats = await syncSource(ctx, meta.id, events, {
    resolveMissing: true,
    resolvedScopes: new Set([SCOPE])
  });

  return {
    ...stats,
    datex_records: records.length,
    records_with_coordinates: coordinateCount,
    wuppertal_events: events.length
  };
}

export async function probe() {
  const response = await fetchWithRetry(FEED_URL, {
    timeoutMs: 20000,
    retries: 1,
    headers: {
      accept: 'application/xml, text/xml, application/octet-stream',
      'user-agent': 'WuppertalLive/1.0'
    }
  });

  const xml = await response.text();
  const blocks = recordBlocks(xml);
  const records = blocks.map(parseRecord).filter(Boolean);

  return {
    url: FEED_URL,
    status: response.status,
    xml_bytes: new TextEncoder().encode(xml).length,
    situation_records: blocks.length,
    parsed_records: records.length,
    records_with_coordinates: records.filter(
      (r) => r.coordinates
    ).length,
    sample: records.slice(0, 3).map((r) => ({
      title: r.title,
      road: r.road,
      coordinates: r.coordinates
    }))
  };
}
