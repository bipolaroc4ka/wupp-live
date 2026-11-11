
import { CITY, inCityBbox } from '../config.js';
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

const ROAD_KEYWORDS =
  /\b(baustelle|baumaßnahme|bauarbeiten|straßenbauarbeiten|fahrbahnsanierung|fahrbahndecke|asphalt|sperrung|vollsperrung|umleitung|verkehrsbehinderung|brückensanierung|brückenarbeiten|treppensanierung|geländerarbeiten|fahrbahn|straßensanierung|straßenbau|arbeitsstelle|ampel|verkehr)\b/i;

function decodeHtml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/gi, ' ')
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

function tagValue(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>`,
    'i'
  );

  return xml.match(re)?.[1]?.trim() || '';
}

function parseFeed(xml) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi;

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

    if (url.hostname !== 'www.wuppertal.de') continue;

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

function extractStreet(text) {
  const patterns = [
    /\b([A-ZÄÖÜ][\p{L}\d.-]*(?:\s+[A-ZÄÖÜ][\p{L}\d.-]*){0,3}\s+(?:straße|strasse|weg|platz|allee|ufer|gasse|ring|damm|chaussee|steig))\b/iu,
    /\b([A-ZÄÖÜ][\p{L}\d.-]*(?:straße|strasse|weg|platz|allee|ufer|gasse|ring|damm|chaussee|steig))\b/iu
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }

  return null;
}

function parseGermanDate(text) {
  const full = text.match(
    /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/
  );

  if (full) {
    const [, d, m, y] = full;
    const date = new Date(Date.UTC(+y, +m - 1, +d));

    if (
      date.getUTCDate() === +d &&
      date.getUTCMonth() === +m - 1 &&
      date.getUTCFullYear() === +y
    ) return date;
  }

  const short = text.match(
    /\b(?:ab|bis|seit|voraussichtlich bis)\s+(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)?\s*(\d{1,2})\.\s*(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\b/i
  );

  if (!short) return null;

  const months = {
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

  const now = new Date();
  let year = now.getUTCFullYear();
  const month = months[short[2].toLowerCase()];

  if (month < now.getUTCMonth() - 1) year++;

  return new Date(Date.UTC(year, month, Number(short[1])));
}

function classify(text) {
  if (
    /\b(vollsperrung|voll gesperrt|gesperrt|sperrung|umleitung|nicht passierbar)\b/i.test(text)
  ) {
    return 'road_closure';
  }

  return 'roadworks';
}

function isRoadEvent(item) {
  const text = `${item.title} ${item.description}`;
  return ROAD_KEYWORDS.test(text) && Boolean(extractStreet(text));
}

async function toEvent(ctx, item) {
  const text = `${item.title}\n${item.description}`;

  if (!isRoadEvent(item)) return null;

  const publishedMs = Date.parse(item.pubDate || '');
  const publishedAt = Number.isFinite(publishedMs)
    ? new Date(publishedMs).toISOString()
    : null;

  if (
    publishedMs &&
    ctx.now - publishedMs > MAX_AGE_DAYS * 86400000
  ) return null;

  const street = extractStreet(text);
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
    Number.isFinite(geo.lat) &&
    Number.isFinite(geo.lon) &&
    inCityBbox(geo.lat, geo.lon);

  const start = parseGermanDate(text);
  const end = parseGermanDate(
    text.match(/(?:bis|voraussichtlich bis)[\s\S]{0,50}/i)?.[0] || ''
  );

  const expiresAt = end
    ? end.getTime() + 2 * 86400000
    : Math.max(
        ctx.now + EVENT_TTL_DAYS * 86400000,
        publishedMs ? publishedMs + EVENT_TTL_DAYS * 86400000 : 0
      );

  const id = item.guid || item.url;

  return {
    source_event_id: await shortId(id),
    scope: SCOPE,
    publisher: 'Stadt Wuppertal',
    title: item.title,
    description: item.description || null,
    category: classify(text),
    source_url: item.url,
    latitude: hasGeo ? geo.lat : null,
    longitude: hasGeo ? geo.lon : null,
    geo_precision: hasGeo ? geo.precision : 'none',
    location_name: street,
    district: hasGeo ? geo.district || null : null,
    event_time: start ? ISO(start.getTime()) : null,
    time_precision: start ? 'day' : 'unknown',
    published_at: publishedAt,
    expires_at: ISO(expiresAt),
    status: 'RECENT',
    status_reason: 'official_city_traffic_press_release',
    confidence: hasGeo ? 0.85 : 0.7,
    is_verified: 1
  };
}

export async function run(ctx) {
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

  const feedItems = parseFeed(xml);

  if (!feedItems.length) {
    throw new Error('Wuppertal RSS contains no items');
  }

  const roadItems = feedItems.filter(isRoadEvent);
  const events = [];

  for (const item of roadItems) {
    const event = await toEvent(ctx, item);
    if (event) events.push(event);
  }

  // RSS — ограниченная лента последних сообщений.
  // Не разрешаем события только потому, что они выпали из RSS.
  const stats = await syncSource(ctx, meta.id, events, {
    resolveMissing: false
  });

  return {
    ...stats,
    rss_items: feedItems.length,
    road_items: roadItems.length,
    geocoded: events.filter((e) => e.geo_precision === 'street').length
  };
}

export async function probe() {
  const response = await fetchWithRetry(FEED_URL, {
    timeoutMs: 12000,
    retries: 1,
    headers: {
      accept: 'application/rss+xml, application/xml, text/xml',
      'user-agent': 'WuppertalLive/1.0'
    }
  });

  const xml = await response.text();
  const items = parseFeed(xml);

  return {
    url: FEED_URL,
    status: response.status,
    rss_items: items.length,
    sample: items.slice(0, 5)
  };
}
