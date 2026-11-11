
import { inCityBbox } from '../config.js';
import { fetchWithRetry, ISO, truncate, shortId } from '../util.js';
import { geocodeStreet } from '../geo.js';
import { syncSource } from '../events.js';

export const meta = {
  id: 'wuppertal',
  name: 'Stadt Wuppertal (Verkehrs-Pressemitteilungen)',
  intervalSec: 600,
  cron: '*/10 * * * *',
  group: 'traffic'
};

const FEED_URL =
  'https://www.wuppertal.de/presse/aktuelle-meldungen.php?sp%3Aout=rss';

const SCOPE = 'municipal/press-roadworks';
const MAX_AGE_DAYS = 45;
const EVENT_TTL_DAYS = 30;
const DAY = 86400000;

const ROAD_KEYWORDS =
  /\b(baustelle|baustellen|baumaßnahme|baumaßnahmen|bauarbeiten|straßenbauarbeiten|fahrbahnsanierung|fahrbahndecke|asphalt|sperrung|vollsperrung|teilsperrung|halbseitige sperrung|umleitung|verkehrsbehinderung|brückensanierung|brückenarbeiten|brückenbau|treppensanierung|geländerarbeiten|fahrbahnschäden|fahrbahn|straßensanierung|straßenbau|arbeitsstelle|ampelanlage|ampelarbeiten|lichtsignalanlage|gehwegsanierung|gehweg|radwegsanierung|radweg|kanalarbeiten|kanalsanierung|tiefbauarbeiten|straßenunterhaltung|deckensanierung|pflasterarbeiten|unterführung|tunnelarbeiten|verkehrsführung|verkehrssicherung|brücke|brücken|tunnel|stützmauer|stützwand)\b/i;

const STRONG_ROAD_KEYWORDS =
  /\b(baustelle|baumaßnahme|bauarbeiten|fahrbahnsanierung|fahrbahndecke|asphalt|sperrung|vollsperrung|teilsperrung|umleitung|brückensanierung|brückenarbeiten|brückenbau|fahrbahnschäden|straßensanierung|straßenbau|arbeitsstelle|ampelarbeiten|lichtsignalanlage|gehwegsanierung|radwegsanierung|kanalsanierung|tiefbauarbeiten|deckensanierung)\b/i;

const CLOSURE_KEYWORDS =
  /\b(vollsperrung|voll gesperrt|teilsperrung|halbseitige sperrung|gesperrt|sperrung|umleitung|nicht passierbar|für den verkehr gesperrt)\b/i;

const DISRUPTION_KEYWORDS =
  /\b(verkehrsbehinderung|verkehrsführung|ampelarbeiten|ampelanlage|lichtsignalanlage|verkehrssicherung|fahrbahnschäden)\b/i;

const INFRASTRUCTURE_KEYWORDS =
  /\b(brücke|brücken|tunnel|unterführung|treppe|treppen|geländer|stützmauer|stützwand|kanal|kanäle|gehweg|radweg)\b/i;

// Служебные заголовки и навигационные элементы сайта.
const BOILERPLATE_PATTERNS = [
  /^sie befinden sich hier\b/i,
  /^startseite$/i,
  /^navigation$/i,
  /^hauptnavigation$/i,
  /^menü$/i,
  /^menu$/i,
  /^zum inhalt$/i,
  /^zum hauptinhalt$/i,
  /^seitenanfang$/i,
  /^breadcrumb/i,
  /^suche$/i,
  /^kontakt$/i,
  /^impressum$/i,
  /^datenschutz$/i
];

const BOILERPLATE_PREFIX =
  /^\s*(?:sie befinden sich hier\s*:|breadcrumb\s*:|hauptnavigation\s*:|navigation\s*:)\s*/i;

const MONTHS = {
  januar: 0,
  februar: 1,
  märz: 2,
  april: 3,
  mai: 4,
  juni: 5,
  juli: 6,
  august: 7,
  september: 8,
  oktober: 9,
  november: 10,
  dezember: 11
};

const WEEKDAYS =
  '(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)';

const STREET_SUFFIX =
  '(?:straße|strasse|str\\.?|weg|platz|allee|ufer|gasse|ring|damm|chaussee|steig|pfad|markt|wall|stieg|bogen|brücke|bruecke)';

function decodeHtml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/gi, ' ')
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

function textOf(value) {
  return decodeHtml(
    String(value || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tagValue(xml, tag) {
  const escaped = escapeRegExp(tag);

  const re = new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>`,
    'i'
  );

  return xml.match(re)?.[1]?.trim() || '';
}

function isBoilerplateItem(item) {
  const title = textOf(item.title || '').trim();

  if (!title) return true;

  if (BOILERPLATE_PATTERNS.some((pattern) => pattern.test(title))) {
    return true;
  }

  // Не принимаем заголовки, состоящие только из навигационного текста.
  if (
    BOILERPLATE_PREFIX.test(title) &&
    title.replace(BOILERPLATE_PREFIX, '').trim().length < 100
  ) {
    return true;
  }

  return false;
}

function cleanDescription(value) {
  let description = textOf(value);

  // Удаляем навигационную строку, если она попала в начало описания.
  description = description.replace(
    /^\s*(?:sie befinden sich hier\s*:)[^\n]*(?:\n|$)/i,
    ''
  );

  return description.trim();
}

function parseFeed(xml) {
  const items = [];

  const re =
    /<(?:[\w.-]+:)?item\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?item\s*>/gi;

  let match;

  while ((match = re.exec(xml))) {
    const block = match[1];

    const title = textOf(tagValue(block, 'title'));
    const link = textOf(tagValue(block, 'link'));

    const description = cleanDescription(
      tagValue(block, 'description') ||
      tagValue(block, 'encoded')
    );

    const guid = textOf(tagValue(block, 'guid'));
    const pubDate = textOf(tagValue(block, 'pubDate'));

    if (!title || !link) continue;

    let url;

    try {
      url = new URL(link, 'https://www.wuppertal.de');
    } catch {
      continue;
    }

    if (
      url.protocol !== 'https:' ||
      !['www.wuppertal.de', 'wuppertal.de'].includes(url.hostname)
    ) {
      continue;
    }

    const item = {
      title,
      description: truncate(description, 2200),
      url: url.href,
      guid,
      pubDate
    };

    // Отсекаем навигационные записи до геокодирования.
    if (isBoilerplateItem(item)) continue;

    items.push(item);
  }

  return items;
}

/**
 * Ищет все возможные названия улиц в тексте.
 *
 * Поддерживает:
 * Siebeneicker Straße
 * Friedrich-Engels-Allee
 * Friedrich-Engels-Allee
 * Am Unterbarmer Friedhof
 * Oberer Grifflenberg
 */
function extractStreetCandidates(text) {
  if (!text) return [];

  const candidates = [];

  const patterns = [
    new RegExp(
      `\\b[A-ZÄÖÜ][\\p{L}\\d.'’\\-]*(?:\\s+[A-ZÄÖÜ][\\p{L}\\d.'’\\-]*){0,4}\\s+${STREET_SUFFIX}\\b`,
      'gu'
    ),

    new RegExp(
      `\\b[A-ZÄÖÜ][\\p{L}\\d.'’]*(?:-[A-ZÄÖÜ][\\p{L}\\d.'’]*)*${STREET_SUFFIX}\\b`,
      'gu'
    ),

    /\b(?:Am|An der|An den|Auf dem|Auf der|Im|In der|Unter dem|Über dem|Zum|Zur)\s+[A-ZÄÖÜ][\p{L}\d.-]*(?:\s+[A-ZÄÖÜ][\p{L}\d.-]*){0,3}/gu
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0]
        .replace(/[.,;:]+$/, '')
        .trim();

      if (value.length < 4 || value.length > 100) continue;

      candidates.push({
        name: value,
        index: match.index
      });
    }
  }

  // Убираем дубликаты, сохраняя порядок появления в тексте.
  const unique = new Map();

  for (const candidate of candidates.sort((a, b) => a.index - b.index)) {
    const key = candidate.name
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    if (!unique.has(key)) {
      unique.set(key, candidate);
    }
  }

  return [...unique.values()];
}

/**
 * Определяет тип географической привязки:
 *
 * single:
 *   Siebeneicker Straße
 *
 * intersection:
 *   Kreuzung Friedrich-Engels-Allee / Morianstraße
 *
 * between:
 *   zwischen Pahlkestraße und ... 
 */
function extractLocation(text) {
  const candidates = extractStreetCandidates(text);

  if (!candidates.length) {
    return {
      type: 'none',
      streets: [],
      label: null
    };
  }

  const betweenMatch = /\bzwischen\b/i.exec(text);

  if (betweenMatch) {
    const after = candidates.filter(
      (item) => item.index > betweenMatch.index
    );

    if (after.length >= 2) {
      const streets = after.slice(0, 2).map((item) => item.name);

      return {
        type: 'between',
        streets,
        label: `zwischen ${streets[0]} und ${streets[1]}`
      };
    }
  }

  const intersectionMatch =
    /\b(kreuzung|kreuzungsbereich|ecke|einmündung|muendung|mündung|kreuzen sich)\b/i.exec(text);

  if (intersectionMatch) {
    const after = candidates.filter(
      (item) => item.index > intersectionMatch.index
    );

    if (after.length >= 2) {
      const streets = after.slice(0, 2).map((item) => item.name);

      return {
        type: 'intersection',
        streets,
        label: `${streets[0]} / ${streets[1]}`
      };
    }
  }

  // Иногда перекрёсток записан без слова Kreuzung:
  // Friedrich-Engels-Allee / Morianstraße.
  if (candidates.length >= 2) {
    const first = candidates[0];
    const second = candidates[1];

    const betweenText = text.slice(
      first.index + first.name.length,
      second.index
    );

    if (/^\s*(?:\/|&|und)\s*$/i.test(betweenText)) {
      return {
        type: 'intersection',
        streets: [first.name, second.name],
        label: `${first.name} / ${second.name}`
      };
    }
  }

  return {
    type: 'single',
    streets: [candidates[0].name],
    label: candidates[0].name
  };
}

function extractStreet(text) {
  return extractLocation(text).streets[0] || null;
}

function parseDateCandidate(match, now) {
  let day;
  let month;
  let year;

  if (match[2] && match[3]) {
    day = Number(match[2]);
    month = MONTHS[match[3].toLowerCase()];
    year = match[4] ? Number(match[4]) : null;
  } else if (match[5] && match[6] && match[7]) {
    day = Number(match[5]);
    month = Number(match[6]) - 1;
    year = Number(match[7]);
  } else {
    return null;
  }

  if (
    !Number.isInteger(day) ||
    !Number.isInteger(month) ||
    month < 0 ||
    month > 11 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const current = new Date(now);
  const currentYear = current.getUTCFullYear();

  if (!year) {
    year = currentYear;

    if (month < current.getUTCMonth() - 1) {
      year++;
    }
  }

  const date = new Date(Date.UTC(year, month, day));

  if (
    date.getUTCDate() !== day ||
    date.getUTCMonth() !== month ||
    date.getUTCFullYear() !== year
  ) {
    return null;
  }

  return date;
}

function parseEndOfMonth(text, now) {
  const monthPattern =
    'Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember';

  const match = text.match(
    new RegExp(
      `\\b(?:bis|voraussichtlich\\s+bis)\\s+Ende\\s+(${monthPattern})(?:\\s+(\\d{4}))?`,
      'i'
    )
  );

  if (!match) return null;

  const month = MONTHS[match[1].toLowerCase()];

  if (!Number.isInteger(month)) return null;

  const currentYear = new Date(now).getUTCFullYear();
  let year = match[2] ? Number(match[2]) : currentYear;

  const currentMonth = new Date(now).getUTCMonth();

  if (!match[2] && month < currentMonth - 1) {
    year++;
  }

  return new Date(Date.UTC(year, month + 1, 0));
}

/**
 * Извлекает начало и окончание работ.
 *
 * Поддерживает:
 * ab Montag, 16. November
 * bis 4. Dezember
 * vom 10.11.2026 bis 20.11.2026
 * voraussichtlich bis Ende Dezember
 */
function parseGermanDates(text, now) {
  const monthPattern =
    'Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember';

  const datePattern = new RegExp(
    `(?:(ab|seit|vom|von|bis|voraussichtlich\\s+bis)\\s+)?(?:${WEEKDAYS}\\s*,?\\s*)?(\\d{1,2})\\.\\s*(${monthPattern})(?:\\s+(\\d{4}))?|\\b(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})\\b`,
    'gi'
  );

  const matches = [...text.matchAll(datePattern)]
    .map((match) => ({
      index: match.index,
      prefix: (match[1] || '').toLowerCase().replace(/\s+/g, ' '),
      date: parseDateCandidate(match, now)
    }))
    .filter((item) => item.date)
    .sort((a, b) => a.index - b.index);

  if (!matches.length) {
    return {
      start: null,
      end: parseEndOfMonth(text, now)
    };
  }

  const startMatch = matches.find(
    (item) => ['ab', 'seit', 'vom', 'von'].includes(item.prefix)
  );

  const endMatch = matches.find(
    (item) =>
      item.prefix === 'bis' ||
      item.prefix === 'voraussichtlich bis'
  );

  let start = startMatch?.date || null;
  let end = endMatch?.date || null;

  if (!start && !end) {
    start = matches[0].date;

    if (matches.length > 1) {
      end = matches[matches.length - 1].date;
    }
  } else if (!start && end) {
    const previous = matches.filter(
      (item) => item.index < endMatch.index
    );

    if (previous.length) {
      start = previous[previous.length - 1].date;
    }
  } else if (start && !end) {
    const later = matches.filter(
      (item) => item.index > startMatch.index
    );

    const possibleEnd = later.find(
      (item) => item.date.getTime() >= start.getTime()
    );

    if (possibleEnd) {
      end = possibleEnd.date;
    }
  }

  if (!end) {
    end = parseEndOfMonth(text, now);
  }

  if (start && end && end.getTime() < start.getTime()) {
    const corrected = new Date(
      Date.UTC(
        end.getUTCFullYear() + 1,
        end.getUTCMonth(),
        end.getUTCDate()
      )
    );

    if (corrected.getTime() >= start.getTime()) {
      end = corrected;
    }
  }

  return { start, end };
}

function classify(text) {
  if (CLOSURE_KEYWORDS.test(text)) {
    return 'road_closure';
  }

  if (DISRUPTION_KEYWORDS.test(text)) {
    return 'traffic_disruption';
  }

  if (INFRASTRUCTURE_KEYWORDS.test(text)) {
    return 'roadworks';
  }

  return 'roadworks';
}

function analyzeRoadItem(item) {
  const text = `${item.title} ${item.description}`;
  const hasRoadKeyword = ROAD_KEYWORDS.test(text);
  const hasStrongKeyword = STRONG_ROAD_KEYWORDS.test(text);
  const location = extractLocation(text);

  if (!hasRoadKeyword) {
    return {
      accepted: false,
      reason: 'no_road_keyword',
      street: null,
      location,
      category: null
    };
  }

  if (!location.streets.length && !hasStrongKeyword) {
    return {
      accepted: false,
      reason: 'no_clear_road_context',
      street: null,
      location,
      category: null
    };
  }

  if (
    /\bverkehr\b/i.test(text) &&
    !hasStrongKeyword &&
    !location.streets.length
  ) {
    return {
      accepted: false,
      reason: 'generic_traffic_mention',
      street: null,
      location,
      category: null
    };
  }

  return {
    accepted: true,
    reason: 'road_event_detected',
    street: location.streets[0] || null,
    location,
    category: classify(text)
  };
}

/**
 * Геокодирует одну или несколько улиц.
 *
 * Для перекрёстков и участков вычисляет приблизительный
 * центр между найденными точками.
 */
async function geocodeLocation(ctx, location) {
  if (!location?.streets?.length || ctx.geoBudget <= 0) {
    return null;
  }

  const points = [];

  for (const street of location.streets.slice(0, 2)) {
    if (ctx.geoBudget <= 0) break;

    try {
      const geo = await geocodeStreet(ctx, street);

      if (
        geo &&
        !geo.pending &&
        Number.isFinite(geo.lat) &&
        Number.isFinite(geo.lon) &&
        inCityBbox(geo.lat, geo.lon)
      ) {
        points.push({
          lat: geo.lat,
          lon: geo.lon,
          district: geo.district || null,
          precision: geo.precision || 'street'
        });
      } else if (geo?.pending) {
        ctx.log(`wuppertal: geocoding pending: ${street}`);
      }
    } catch (error) {
      ctx.log(`wuppertal geocode ${street}: ${error.message}`);
    }
  }

  if (!points.length) return null;

  if (points.length === 1) {
    return {
      ...points[0],
      precision: location.type === 'single'
        ? points[0].precision
        : 'approximate'
    };
  }

  return {
    lat: (points[0].lat + points[1].lat) / 2,
    lon: (points[0].lon + points[1].lon) / 2,
    district: points[0].district || points[1].district || null,
    precision: 'approximate'
  };
}

async function toEvent(ctx, item, analysis) {
  const text = `${item.title}\n${item.description}`;

  const publishedMs = Date.parse(item.pubDate || '');

  const publishedAt = Number.isFinite(publishedMs)
    ? ISO(publishedMs)
    : null;

  if (
    Number.isFinite(publishedMs) &&
    ctx.now - publishedMs > MAX_AGE_DAYS * DAY
  ) {
    return null;
  }

  const location = analysis.location;

  const geo = await geocodeLocation(ctx, location);

  const hasGeo =
    geo &&
    Number.isFinite(geo.lat) &&
    Number.isFinite(geo.lon) &&
    inCityBbox(geo.lat, geo.lon);

  const { start, end } = parseGermanDates(text, ctx.now);

  if (end && end.getTime() + 2 * DAY < ctx.now) {
    return null;
  }

  const expiresAt = end
    ? end.getTime() + 2 * DAY
    : Math.max(
        ctx.now + EVENT_TTL_DAYS * DAY,
        Number.isFinite(publishedMs)
          ? publishedMs + EVENT_TTL_DAYS * DAY
          : 0
      );

  const isScheduled =
    start && start.getTime() > ctx.now;

  const id = item.guid || item.url;

  return {
    source_event_id: await shortId(id),
    scope: SCOPE,
    publisher: 'Stadt Wuppertal',
    title: item.title,
    description: item.description || null,
    category: analysis.category,
    source_url: item.url,

    latitude: hasGeo ? geo.lat : null,
    longitude: hasGeo ? geo.lon : null,

    geo_precision: hasGeo ? geo.precision : 'none',

    location_name:
      location.label ||
      item.title,

    district: hasGeo ? geo.district || null : null,

    event_time: start ? ISO(start.getTime()) : null,
    time_precision: start ? 'day' : 'unknown',

    published_at: publishedAt,
    expires_at: ISO(expiresAt),

    status: isScheduled ? 'ACTIVE' : 'RECENT',

    status_reason: isScheduled
      ? 'official_city_scheduled_roadwork'
      : 'official_city_traffic_press_release',

    confidence: hasGeo
      ? geo.precision === 'approximate' ? 0.78 : 0.9
      : 0.7,

    is_verified: 1
  };
}

async function fetchFeed() {
  const response = await fetchWithRetry(FEED_URL, {
    timeoutMs: 12000,
    retries: 2,
    backoffMs: 800,
    headers: {
      accept: 'application/rss+xml, application/xml, text/xml',
      'user-agent': 'WuppertalLive/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Wuppertal RSS HTTP ${response.status}`);
  }

  const xml = await response.text();

  if (!/<(?:rss|feed)\b/i.test(xml)) {
    throw new Error('Wuppertal RSS returned unexpected content');
  }

  if (xml.length < 500) {
    throw new Error('Wuppertal RSS returned unexpectedly small content');
  }

  return xml;
}

function analyzeFeed(items) {
  const accepted = [];
  const rejected = [];

  for (const item of items) {
    if (isBoilerplateItem(item)) {
      rejected.push({
        title: item.title,
        reason: 'boilerplate'
      });

      continue;
    }

    const analysis = analyzeRoadItem(item);

    if (analysis.accepted) {
      accepted.push({ item, analysis });
    } else {
      rejected.push({
        title: item.title,
        reason: analysis.reason
      });
    }
  }

  return { accepted, rejected };
}

export async function run(ctx) {
  const xml = await fetchFeed();
  const feedItems = parseFeed(xml);

  if (!feedItems.length) {
    throw new Error('Wuppertal RSS contains no items');
  }

  const { accepted, rejected } = analyzeFeed(feedItems);

  const events = [];

  for (const { item, analysis } of accepted) {
    const event = await toEvent(ctx, item, analysis);

    if (event) {
      events.push(event);
    }
  }

  // RSS — ограниченная лента последних сообщений.
  // Не удаляем события, выпавшие из RSS.
  const stats = await syncSource(ctx, meta.id, events, {
    resolveMissing: false
  });

  return {
    ...stats,

    rss_items: feedItems.length,
    road_items: accepted.length,
    rejected_items: rejected.length,
    events_created_or_updated: events.length,

    geocoded: events.filter(
      (event) =>
        event.geo_precision &&
        event.geo_precision !== 'none'
    ).length,

    without_coordinates: events.filter(
      (event) =>
        event.latitude === null ||
        event.longitude === null
    ).length,

    sample: accepted.slice(0, 5).map(({ item, analysis }) => ({
      title: item.title,
      street: analysis.street,
      location_type: analysis.location.type,
      location: analysis.location.label,
      category: analysis.category,
      url: item.url
    }))
  };
}

export async function probe() {
  const xml = await fetchFeed();
  const items = parseFeed(xml);

  const { accepted, rejected } = analyzeFeed(items);

  const now = Date.now();

  const recent = items.filter((item) => {
    const published = Date.parse(item.pubDate || '');

    return (
      !Number.isFinite(published) ||
      now - published <= MAX_AGE_DAYS * DAY
    );
  });

  return {
    url: FEED_URL,
    status: 200,

    rss_items: items.length,
    recent_items: recent.length,
    road_items: accepted.length,
    rejected_items: rejected.length,

    road_samples: accepted.slice(0, 10).map(({ item, analysis }) => ({
      title: item.title,
      description: truncate(item.description, 500),

      street: analysis.street,
      location_type: analysis.location.type,
      location: analysis.location.label,

      category: analysis.category,
      pubDate: item.pubDate,
      url: item.url
    })),

    rejected_samples: rejected.slice(0, 10)
  };
}
