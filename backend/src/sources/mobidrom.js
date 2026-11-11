
import { inCityBbox } from '../config.js';
import { fetchWithRetry, ISO, truncate, shortId } from '../util.js';
import { extractStreet, geocodeStreet } from '../geo.js';
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
const MAX_DESCRIPTION = 1600;
const OUTSIDE_CITY_RE = /\b(?:Bochum|Düsseldorf|Ennepetal|Gevelsberg|Haan|Hattingen|Heiligenhaus|Mettmann|Remscheid|Schwelm|Solingen|Sprockhövel|Velbert|Wermelskirchen|Witten|Wülfrath)\b/i;

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
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function cleanText(value) {
  return decodeXml(String(value || '').replace(/<[^>]+>/g, ' '))
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
  return [...xml.matchAll(re)].map((match) => cleanText(match[1])).filter(Boolean);
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
    new RegExp(`<(?:(?:[\\w.-]+):)?${escaped}\\b([^>]*)>`, 'i')
  );
  return match ? match[1] : '';
}

function attributeValue(attributes, names) {
  for (const name of names) {
    const escaped = escapeRegExp(name);
    const match = attributes.match(
      new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*["']([^"']+)["']`, 'i')
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
  return attributeValue(openingAttributes(block, name), ['id', 'recordId']);
}

function validLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

// DATEX-II posList can arrive as lat/lon or lon/lat. First prefer a point
// inside Wuppertal; otherwise detect a plausible German coordinate pair.
function coordinatePair(a, b) {
  const candidates = [{ lat: a, lon: b }, { lat: b, lon: a }]
    .filter((p) => validLatLon(p.lat, p.lon));

  const inCity = candidates.find((p) => inCityBbox(p.lat, p.lon));
  if (inCity) return inCity;

  return candidates.find((p) =>
    p.lat >= 47 && p.lat <= 56 && p.lon >= 5 && p.lon <= 16
  ) || candidates[0] || null;
}

function coordinateData(block) {
  const points = [];
  let hasGeometry = false;

  for (const tag of ['posList', 'pos']) {
    for (const value of tagValues(block, tag)) {
      const numbers = value.split(/[\s,;]+/).map(Number).filter(Number.isFinite);
      if (numbers.length >= 2) hasGeometry = true;

      for (let i = 0; i + 1 < numbers.length; i += 2) {
        const point = coordinatePair(numbers[i], numbers[i + 1]);
        if (point && inCityBbox(point.lat, point.lon)) points.push(point);
      }
    }
  }

  const unique = [...new Map(points.map((p) => [
    `${p.lat.toFixed(6)}:${p.lon.toFixed(6)}`,
    p
  ])).values()];

  return { points: unique, hasGeometry };
}

function parseDate(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function extractStreetName(text) {
  if (!text) return null;
  const value = String(text);
  const patterns = [
    /\b([A-ZÄÖÜ][\p{L}\d.-]*(?:-[A-ZÄÖÜ]?[\p{L}\d.-]+)*(?:straße|strasse|str\.?|str|weg|allee|platz|ufer|gasse|ring|damm|brücke))(?=$|[\s,.;:/-])/iu,
    /\b([A-ZÄÖÜ][\p{L}\d.-]*(?:-[A-ZÄÖÜ]?[\p{L}\d.-]+)*)\s+(Straße|Strasse|Str\.?|Str|Weg|Allee|Platz|Ufer|Gasse|Ring|Damm|Brücke)(?=$|[\s,.;:/-])/iu
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const street = match[2]
      ? `${match[1]} ${match[2]}`
      : match[1];
    if (/\sStr\.?$/i.test(street) || /-Str\.?$/i.test(street)) {
      return street.replace(/Str\.?$/i, 'Straße');
    }
    return street.replace(/str\.?$/i, 'straße').replace(/Strasse$/i, 'straße');
  }
  return null;
}

function isRouteText(value) {
  return /^(?:über\b|für\s+(?:fahrzeuge|pkw|lkw)\b|richtung\b|umleitung\b)/i.test(value.trim());
}

const TECHNICAL_VALUES = new Set([
  'road', 'bridge', 'trafficinformation', 'roadworkstype',
  'roadworks', 'buriedcables', 'constructionwork', 'maintenanceworks',
  'roadclosed', 'roadclosedtoalltraffic', 'lanesdeviated', 'newroadworkslayout'
]);

function usefulValues(block) {
  return [...new Set(tagValues(block, 'value')
    .map(cleanText)
    .filter((value) => value && !TECHNICAL_VALUES.has(value.toLowerCase()))
  )];
}

function chooseWorkLocation(values, location) {
  const candidates = [...values].reverse().filter((value) => !isRouteText(value));
  for (const value of candidates) {
    const street = extractStreetName(value) || extractStreet(value);
    if (street) return { text: value, street };
  }

  if (location && !isRouteText(location)) {
    const street = extractStreetName(location) || extractStreet(location);
    if (street) return { text: location, street };
  }

  const fallback = candidates.find((value) => value.length > 8) || null;
  return { text: fallback, street: fallback ? extractStreet(fallback) : null };
}

function parseRecord(block) {
  const attributes = openingAttributes(block, 'situationRecord');
  const type = attributeValue(attributes, ['xsi:type', 'type']) || '';

  const road = firstTag(block, ['roadName', 'roadNumber', 'roadNumberIdentifier']);
  const location = firstTag(block, [
    'locationDescription',
    'supplementaryPositionalDescription',
    'alertCLine'
  ]);

  const values = usefulValues(block);
  const workLocation = chooseWorkLocation(values, location);
  const siteText = workLocation.text || '';
  const outsideCityHint = OUTSIDE_CITY_RE.test(siteText) && !/\bWuppertal\b/i.test(siteText);
  const descriptionParts = [...values];
  if (location && !descriptionParts.includes(location)) descriptionParts.push(location);
  const description = descriptionParts.join(' · ');

  const street = workLocation.street || extractStreetName(location || '') ||
    extractStreet(location || '') || extractStreetName(road || '') ||
    extractStreet(road || '') || extractStreetName(description) || extractStreet(description);
  const title = street || road || workLocation.text || location ||
    values.find((value) => !isRouteText(value)) || description.slice(0, 150);

  if (!title && !description) return null;

  const start = parseDate(firstTag(block, [
    'overallStartTime', 'startOfPeriod', 'situationRecordCreationTime'
  ]));
  const end = parseDate(firstTag(block, ['overallEndTime', 'endOfPeriod']));
  const geo = coordinateData(block);

  return {
    id: elementId(block, 'situationRecord'),
    type,
    title: truncate(title || 'Baustelle', 220),
    description: truncate(description, MAX_DESCRIPTION),
    road,
    street,
    location: workLocation.text || location,
    start,
    end,
    coordinatePoints: geo.points,
    hasGeometry: geo.hasGeometry,
    outsideCityHint
  };
}

function typePriority(type) {
  if (/MaintenanceWorks|ConstructionWorks/i.test(type)) return 3;
  if (/RoadOrCarriagewayOrLaneManagement/i.test(type)) return 1;
  return 2;
}

function centroid(points) {
  if (!points.length) return null;
  const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const lon = points.reduce((sum, p) => sum + p.lon, 0) / points.length;
  return inCityBbox(lat, lon) ? { lat, lon } : null;
}

// One DATEX-II situation may contain several related records (e.g. works,
// lane management and closure). Keep them as one map event.
function parseSituation(block) {
  const records = recordBlocks(block).map(parseRecord).filter(Boolean);
  if (!records.length) return null;
  records.sort((a, b) => typePriority(b.type) - typePriority(a.type));

  const main = records[0];
  const descriptions = [...new Set(records.map((r) => r.description).filter(Boolean))];
  const roads = [...new Set(records.map((r) => r.road).filter(Boolean))];
  const streets = [...new Set(records.map((r) => r.street).filter(Boolean))];
  const locations = [...new Set(records.map((r) => r.location).filter(Boolean))];
  const cityPoints = records.flatMap((r) => r.coordinatePoints);
  const allPoints = [...new Map(cityPoints.map((p) => [
    `${p.lat.toFixed(6)}:${p.lon.toFixed(6)}`,
    p
  ])).values()];

  const starts = records.map((r) => r.start).filter(Number.isFinite);
  const ends = records.map((r) => r.end).filter(Number.isFinite);
  const start = starts.length ? Math.min(...starts) : null;
  const end = ends.length ? Math.max(...ends) : null;
  const situationId = elementId(block, 'situation');

  const street = main.street || streets[0] || null;
  const title = street || main.road || main.title || locations[0] || 'Baustelle';

  return {
    id: situationId,
    recordCount: records.length,
    title: truncate(title, 220),
    description: truncate(descriptions.join(' · '), MAX_DESCRIPTION),
    road: roads[0] || null,
    street,
    location: locations[0] || null,
    start,
    end,
    coordinates: centroid(allPoints),
    hasGeometry: records.some((r) => r.hasGeometry),
    outsideCityHint: records.some((r) => r.outsideCityHint),
    cityCoordinateCount: allPoints.length,
    recordTypes: records.map((r) => r.type)
  };
}

function classify(text) {
  if (/\b(vollsperrung|voll\s+gesperrt|gesperrt|sperrung|umleitung|road\s+closed)\b/i.test(text)) {
    return 'road_closure';
  }
  return 'roadworks';
}

async function makeEvent(ctx, situation) {
  const text = [
    situation.title,
    situation.description,
    situation.road,
    situation.street,
    situation.location
  ].filter(Boolean).join(' ');

  if (situation.outsideCityHint) return null;

  let point = situation.coordinates;
  let precision = point ? 'source' : 'none';
  let district = null;

  // Critical safeguard: never geocode an event whose source geometry exists
  // but lies outside Wuppertal. Geocoding is only a fallback when the feed has
  // no geometry at all and explicitly names Wuppertal.
  if (!point && !situation.hasGeometry && /\bWuppertal\b/i.test(text)) {
    const street = situation.street || extractStreet(text);
    if (street && ctx.geoBudget > 0) {
      try {
        const geo = await geocodeStreet(ctx, street);
        if (
          geo && !geo.pending &&
          Number.isFinite(geo.lat) && Number.isFinite(geo.lon) &&
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
  if (situation.end && situation.end < ctx.now) return null;
  if (situation.start && situation.start > ctx.now + MAX_FUTURE_DAYS * DAY) return null;

  const endExpiry = situation.end ? situation.end + 2 * DAY : 0;
  const startExpiry = situation.start ? situation.start + EVENT_TTL_DAYS * DAY : 0;
  const expiresAt = Math.max(
    ctx.now + EVENT_TTL_DAYS * DAY,
    endExpiry,
    startExpiry
  );

  const stableId = situation.id || [
    situation.title,
    situation.road || '',
    situation.start || ''
  ].join('|');

  const isScheduled = situation.start && situation.start > ctx.now;
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
    location_name: situation.street || situation.road || situation.location || situation.title,
    district,
    event_time: situation.start ? ISO(situation.start) : null,
    time_precision: 'minute',
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
    throw new Error('No DATEX II situation elements found; refusing empty sync');
  }

  const parsed = situations.map(parseSituation).filter(Boolean);
  if (!parsed.length) {
    throw new Error('No DATEX II situations could be parsed; refusing empty sync');
  }

  return { situations, parsed };
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
  if (!response.ok) throw new Error(`Mobidrom HTTP ${response.status}`);

  const xml = await response.text();
  if (!xml || xml.length < 1000) {
    throw new Error('Mobidrom returned an unexpectedly small XML feed');
  }
  return xml;
}

export async function run(ctx) {
  const xml = await fetchFeed();
  const { situations, parsed } = parseFeed(xml);
  const withCoordinates = parsed.filter((item) => item.coordinates).length;
  const withExternalGeometry = parsed.filter(
    (item) => item.hasGeometry && !item.coordinates
  ).length;

  if (!withCoordinates) {
    throw new Error('No usable Wuppertal coordinates in DATEX II situations; refusing sync');
  }

  const events = [];
  for (const situation of parsed) {
    const event = await makeEvent(ctx, situation);
    if (event) events.push(event);
  }

  // The feed was parsed successfully and contains Wuppertal geometries.
  // Resolve records absent from this complete source scope after two runs.
  const feedIsComplete = parsed.length >= situations.length * 0.9;
  const stats = await syncSource(ctx, meta.id, events, {
    resolveMissing: feedIsComplete,
    resolvedScopes: new Set([SCOPE])
  });

  return {
    ...stats,
    datex_situations: situations.length,
    parsed_situations: parsed.length,
    situations_with_coordinates: withCoordinates,
    situations_with_external_geometry: withExternalGeometry,
    situations_excluded_by_external_city_hint: parsed.filter((item) => item.outsideCityHint).length,
    feed_complete_for_resolution: feedIsComplete,
    situations_without_geometry: parsed.filter((item) => !item.hasGeometry).length,
    situations_without_city_coordinates: parsed.length - withCoordinates,
    wuppertal_events: events.length,
    grouped_records: parsed.reduce((sum, item) => sum + item.recordCount, 0)
  };
}

export async function probe() {
  const xml = await fetchFeed();
  const { situations, parsed } = parseFeed(xml);
  const withCoordinates = parsed.filter((item) => item.coordinates);
  const withExternalGeometry = parsed.filter(
    (item) => item.hasGeometry && !item.coordinates
  );

  return {
    url: FEED_URL,
    status: 200,
    xml_bytes: new TextEncoder().encode(xml).length,
    situations: situations.length,
    parsed_situations: parsed.length,
    situations_with_wuppertal_coordinates: withCoordinates.length,
    situations_with_external_geometry: withExternalGeometry.length,
    situations_without_geometry: parsed.filter((item) => !item.hasGeometry).length,
    grouped_records: parsed.reduce((sum, item) => sum + item.recordCount, 0),
    sample: withCoordinates.slice(0, 12).map((item) => ({
      situation_id: item.id,
      title: item.title,
      description: item.description,
      road: item.road,
      street: item.street,
      location: item.location,
      coordinates: item.coordinates,
      records_in_situation: item.recordCount,
      start: item.start ? ISO(item.start) : null,
      end: item.end ? ISO(item.end) : null
    }))
  };
}
