
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
  /\b(baustelle|baustellen|baumaßnahme|baumaßnahmen|bauarbeiten|straßenbauarbeiten|fahrbahnsanierung|fahrbahndecke|asphalt|sperrung|vollsperrung|teilsperrung|halbseitige sperrung|umleitung|verkehrsbehinderung|brückensanierung|brückenarbeiten|brückenbau|treppensanierung|geländerarbeiten|fahrbahnschäden|fahrbahn|straßensanierung|straßenbau|arbeitsstelle|ampelanlage|ampelarbeiten|lichtsignalanlage|gehwegsanierung|gehweg|radwegsanierung|radweg|kanalarbeiten|kanalsanierung|tiefbauarbeiten|straßenunterhaltung|deckensanierung|pflasterarbeiten|unterführung|tunnelarbeiten|verkehrsführung|verkehrssicherung)\b/i;

const STRONG_ROAD_KEYWORDS =
  /\b(baustelle|baumaßnahme|bauarbeiten|fahrbahnsanierung|fahrbahndecke|asphalt|sperrung|vollsperrung|teilsperrung|umleitung|brückensanierung|brückenarbeiten|brückenbau|fahrbahnschäden|straßensanierung|straßenbau|arbeitsstelle|ampelarbeiten|lichtsignalanlage|gehwegsanierung|radwegsanierung|kanalsanierung|tiefbauarbeiten|deckensanierung)\b/i;

const CLOSURE_KEYWORDS =
  /\b(vollsperrung|voll gesperrt|teilsperrung|halbseitige sperrung|gesperrt|sperrung|umleitung|nicht passierbar|für den verkehr gesperrt)\b/i;

const DISRUPTION_KEYWORDS =
  /\b(verkehrsbehinderung|verkehrsführung|ampelarbeiten|ampelanlage|lichtsignalanlage|verkehrssicherung|fahrbahnschäden)\b/i;

const INFRASTRUCTURE_KEYWORDS =
  /\b(brücke|brücken|tunnel|unterführung|treppe|treppen|geländer|stützmauer|stützwand|kanal|kanäle|gehweg|radweg)\b/i;

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

function parseFeed(xml) {
  const items = [];
  const re = /<(?:[\w.-]+:)?item\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?item\s*>/gi;

  let match;

  while ((match = re.exec(xml))) {
    const block = match[1];

    const title = textOf(tagValue(block, 'title'));
    const link = textOf(tagValue(block, 'link'));

    const description = textOf(
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

    items.push({
      title,
      description: truncate(description, 2200),
      url: url.href,
      guid,
      pubDate
    });
  }

  return items;
}

/**
 * Распознаёт названия улиц:
 * Siebeneicker Straße
 * Friedrich-Engels-Allee
 * Am Unterbarmer Friedhof
 * Oberer Grifflenberg
 */
function extractStreet(text) {
  if (!text) return null;

  const patterns = [
    /\b((?:Am|An der|An den|Auf dem|Auf der|Im|In der|Unter dem|Über dem|Zum|Zur)\s+[A-ZÄÖÜ][\p{L}\d.-]*(?:\s+[A-ZÄÖÜ][\p{L}\d.-]*){0,4})\b/u,

    /\b([A-ZÄÖÜ][\p{L}\d.-]*(?:\s+[A-ZÄÖÜ][\p{L}\d.-]*){0,4}\s+(?:straße|strasse|str\.|weg|platz|allee|ufer|gasse|ring|damm|chaussee|steig|pfad|markt))\b/iu,

    /\b([A-ZÄÖÜ][\p{L}\d.-]*(?:straße|strasse|str\.|weg|platz|allee|ufer|gasse|ring|damm|chaussee|steig|pfad|markt))\b/iu
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) {
      return match[1].trim();
    }
  }

  return null;
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

    // Если дата сильно раньше текущего месяца,
    // вероятно, речь идёт о следующем календарном году.
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

/**
 * Извлекает начало и окончание работ.
 *
 * Примеры:
 * ab Montag, 16. November
 * bis 4. Dezember
 * vom 10.11.2026 bis 20.11.2026
 * voraussichtlich bis Ende Dezember
 *
 * Даты без года интерпретируются относительно ctx.now.
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
    return { start: null, end: null };
  }

  const startMatch = matches.find(
    (item) => ['ab', 'seit', 'vom', 'von'].includes(item.prefix)
  );

  const endMatch = matches.find(
    (item) => item.prefix === 'bis' ||
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

  // Если год окончания не указан и дата окончания
  // оказалась раньше начала, переносим её на следующий год.
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

/**
 * Не считаем любое упоминание слова Verkehr дорожным событием.
 * Требуем конкретный дорожный признак и географическую привязку.
 */
function analyzeRoadItem(item) {
  const text = `${item.title} ${item.description}`;

  const hasRoadKeyword = ROAD_KEYWORDS.test(text);
  const hasStrongKeyword = STRONG_ROAD_KEYWORDS.test(text);
  const street = extractStreet(text);

  if (!hasRoadKeyword) {
    return {
      accepted: false,
      reason: 'no_road_keyword',
      street,
      category: null
    };
  }

  if (!street && !hasStrongKeyword) {
    return {
      accepted: false,
      reason: 'no_clear_road_context',
      street: null,
      category: null
    };
  }

  // Не принимаем общие сообщения о транспорте,
  // если в них нет конкретной дорожной темы.
  if (
    /\bverkehr\b/i.test(text) &&
    !hasStrongKeyword &&
    !street
  ) {
    return {
      accepted: false,
      reason: 'generic_traffic_mention',
      street: null,
      category: null
    };
  }

  return {
    accepted: true,
    reason: 'road_event_detected',
    street,
    category: classify(text)
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

  const street = analysis.street;
  let geo = null;

  if (street && ctx.geoBudget > 0) {
    try {
      geo = await geocodeStreet(ctx, street);

      if (geo?.pending) {
        ctx.log(`wuppertal: geocoding pending: ${street}`);
      }
    } catch (error) {
      ctx.log(`wuppertal geocode ${street}: ${error.message}`);
    }
  }

  const hasGeo =
    geo &&
    !geo.pending &&
    Number.isFinite(geo.lat) &&
    Number.isFinite(geo.lon) &&
    inCityBbox(geo.lat, geo.lon);

  const { start, end } = parseGermanDates(text, ctx.now);

  // Если дата окончания уже прошла, публикация не должна
  // снова появляться на карте как действующая работа.
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
    location_name: street || item.title,
    district: hasGeo ? geo.district || null : null,
    event_time: start ? ISO(start.getTime()) : null,
    time_precision: start ? 'day' : 'unknown',
    published_at: publishedAt,
    expires_at: ISO(expiresAt),
    status: isScheduled ? 'ACTIVE' : 'RECENT',
    status_reason: isScheduled
      ? 'official_city_scheduled_roadwork'
      : 'official_city_traffic_press_release',
    confidence: hasGeo ? 0.9 : 0.7,
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
      (event) => !event.latitude || !event.longitude
    ).length,
    sample: accepted.slice(0, 5).map(({ item, analysis }) => ({
      title: item.title,
      street: analysis.street,
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
      category: analysis.category,
      pubDate: item.pubDate,
      url: item.url
    })),
    rejected_samples: rejected.slice(0, 5)
  };
}
