
import { CITY, inCityBbox } from '../config.js';
import { fetchWithRetry, ISO, truncate } from '../util.js';
import { geocodeStreet } from '../geo.js';
import { syncSource } from '../events.js';

export const meta = {
  id: 'wuppertal',
  name: 'Stadt Wuppertal (offizielle Baustellen)',
  intervalSec: 600,
  cron: '*/10 * * * *',
  group: 'traffic'
};

const INDEX_URL =
  'https://www.wuppertal.de/rathaus-buergerservice/verkehr/baustellen/aktuelle-baustellen.php';

const SCOPE = 'municipal/large-projects';
const MAX_DETAILS = 40;
const CONCURRENCY = 5;
const EVENT_TTL_DAYS = 14;

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripHtml(value) {
  return decodeHtml(
    String(value || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6]|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function absoluteUrl(href) {
  try {
    const url = new URL(href, INDEX_URL);
    if (url.hostname !== 'www.wuppertal.de') return null;
    if (!url.pathname.includes('/baustellen/meldungen/')) return null;
    return url.href;
  } catch {
    return null;
  }
}

function extractDetailLinks(html) {
  const found = new Map();
  const re = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = re.exec(html))) {
    const url = absoluteUrl(match[2]);
    if (!url) continue;

    const label = stripHtml(match[3]);
    if (!label || label.length < 8) continue;

    found.set(url, { url, label });
  }

  return [...found.values()].slice(0, MAX_DETAILS);
}

function extractMainText(html) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (!h1) return null;

  const title = stripHtml(h1[1]);
  const start = html.indexOf(h1[0]) + h1[0].length;

  let body = html.slice(start);
  const end = body.search(/<h[2-4]\b[^>]*>\s*Erläuterungen und Hinweise/i);
  if (end >= 0) body = body.slice(0, end);

  const description = stripHtml(body);
  if (!title || description.length < 40) return null;

  return { title, description: truncate(description, 1800) };
}

function parseGermanDate(value) {
  const match = String(value || '').match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;

  return date;
}

function extractDates(text) {
  const startMatch = text.match(
    /\b(?:ab(?:\s+dem)?|seit|Beginn(?:\s+der Arbeiten)?(?:\s+am)?)\s+(\d{1,2}\.\d{1,2}\.\d{4})/i
  );

  const endMatch = text.match(
    /\b(?:bis(?:\s+zum)?|voraussichtlich\s+bis|Ende(?:\s+der Arbeiten)?(?:\s+am)?)\s+(\d{1,2}\.\d{1,2}\.\d{4})/i
  );

  return {
    start: startMatch ? parseGermanDate(startMatch[1]) : null,
    end: endMatch ? parseGermanDate(endMatch[1]) : null
  };
}

function extractStreet(text) {
  const patterns = [
    /\b(?:in|auf|an|der|die|im)\s+(?:der\s+)?([A-ZÄÖÜ][\p{L}\d.-]*(?:\s+[A-ZÄÖÜ][\p{L}\d.-]*){0,2}\s+(?:straße|strasse|weg|platz|allee|ufer|gasse|ring|damm))\b/iu,
    /\b([A-ZÄÖÜ][\p{L}\d.-]*(?:straße|strasse|weg|platz|allee|ufer|gasse|ring|damm))\b/iu
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }

  return null;
}

function isCompleted(text) {
  return /\b(abgeschlossen|fertiggestellt|beendet|vollständig abgeschlossen)\b/i.test(text);
}

function classify(text) {
  if (
    /\b(vollsperrung|voll gesperrt|gesperrt|sperrung|umleitung|nicht passierbar)\b/i.test(text)
  ) return 'road_closure';

  return 'roadworks';
}

function makeEvent(detail, geo, now) {
  const { url, title, description } = detail;
  const text = `${title}\n${description}`;

  if (isCompleted(text)) return null;

  const dates = extractDates(text);

  // Noch nicht begonnene Arbeiten nicht als aktuelle Ereignisse anzeigen.
  if (dates.start && dates.start.getTime() > now) return null;

  // Если официально указан срок окончания и он уже прошёл,
  // событие не должно появляться на карте.
  if (dates.end && dates.end.getTime() < now) return null;

  const street = extractStreet(text);
  const location = street || title;

  const expiresAt = dates.end
    ? dates.end.getTime() + 2 * 24 * 60 * 60 * 1000
    : now + EVENT_TTL_DAYS * 24 * 60 * 60 * 1000;

  const hasGeo =
    geo &&
    Number.isFinite(geo.lat) &&
    Number.isFinite(geo.lon) &&
    inCityBbox(geo.lat, geo.lon);

  return {
    source_event_id: new URL(url).pathname,
    scope: SCOPE,
    publisher: 'Stadt Wuppertal – Ressort Straßen und Verkehr',
    title,
    description,
    category: classify(text),
    source_url: url,
    latitude: hasGeo ? geo.lat : null,
    longitude: hasGeo ? geo.lon : null,
    geo_precision: hasGeo ? geo.precision : 'none',
    location_name: location,
    district: hasGeo ? (geo.district || null) : null,
    event_time: dates.start ? ISO(dates.start.getTime()) : null,
    time_precision: dates.start ? 'day' : 'unknown',
    published_at: null,
    expires_at: ISO(expiresAt),
    status: 'ACTIVE',
    status_reason: 'listed_on_official_city_baustellen_page',
    confidence: hasGeo ? 0.85 : 0.75,
    is_verified: 1
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;

      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

async function fetchDetail(link) {
  const response = await fetchWithRetry(link.url, {
    timeoutMs: 10000,
    retries: 2,
    backoffMs: 700,
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'WuppertalLive/1.0 (local traffic information aggregator)'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${link.url}`);
  }

  const html = await response.text();
  const parsed = extractMainText(html);

  if (!parsed) {
    throw new Error(`Cannot parse official detail page: ${link.url}`);
  }

  return {
    ...parsed,
    url: link.url
  };
}

export async function run(ctx) {
  const indexResponse = await fetchWithRetry(INDEX_URL, {
    timeoutMs: 12000,
    retries: 2,
    backoffMs: 800,
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'WuppertalLive/1.0 (local traffic information aggregator)'
    }
  });

  if (!indexResponse.ok) {
    throw new Error(`Wuppertal Baustellen page HTTP ${indexResponse.status}`);
  }

  const indexHtml = await indexResponse.text();
  const links = extractDetailLinks(indexHtml);

  if (!links.length) {
    throw new Error('No official Baustellen detail links found; refusing empty sync');
  }

  ctx.log(`wuppertal: found ${links.length} official detail links`);

  const results = await mapLimit(links, CONCURRENCY, fetchDetail);

  const details = [];
  let failures = 0;

  for (const result of results) {
    if (result && result.error) {
      failures++;
      ctx.log(`wuppertal detail: ${result.error.message || result.error}`);
    } else if (result) {
      details.push(result);
    }
  }

  if (!details.length) {
    throw new Error('All Wuppertal Baustellen detail pages failed');
  }

  const items = [];
  let geocoded = 0;

  for (const detail of details) {
    const text = `${detail.title}\n${detail.description}`;
    const street = extractStreet(text);
    let geo = null;

    if (street && ctx.geoBudget > 0) {
      try {
        geo = await geocodeStreet(ctx, street);

        if (geo && geo.pending) {
          ctx.log(`wuppertal: geocoding budget exhausted at ${street}`);
        } else if (geo && geo.precision === 'street') {
          geocoded++;
        }
      } catch (error) {
        ctx.log(`wuppertal geocode ${street}: ${error.message}`);
      }
    }

    const item = makeEvent(detail, geo, ctx.now);
    if (item) items.push(item);
  }

  // Missing events are resolved only if every detail page was read successfully.
  // This prevents a temporary outage of one city page from removing valid events.
  const resolvedScopes = failures === 0
    ? new Set([SCOPE])
    : new Set();

  const stats = await syncSource(ctx, meta.id, items, {
    resolveMissing: true,
    resolvedScopes
  });

  return {
    ...stats,
    detail_pages: details.length,
    detail_failures: failures,
    geocoded,
    partial_failures: failures
  };
}

export async function probe(ctx) {
  const response = await fetchWithRetry(INDEX_URL, {
    timeoutMs: 12000,
    retries: 1,
    headers: {
      accept: 'text/html',
      'user-agent': 'WuppertalLive/1.0'
    }
  });

  const html = await response.text();
  const links = extractDetailLinks(html);

  return {
    url: INDEX_URL,
    status: response.status,
    detail_links: links.length,
    sample: links.slice(0, 5)
  };
}
