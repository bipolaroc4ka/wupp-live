
// Presseportal (news aktuell / dpa) — RSS Feuerwehr und Polizei Wuppertal.
// Используются публичные RSS-ленты. API-ключ не требуется.
//
// ЧЕСТНО О ДАННЫХ:
//  * Это пресс-релизы, а не диспетчерская лента.
//  * Статус публикаций — RECENT, никогда LIVE/ACTIVE.
//  * Время происшествия извлекается только из текста релиза.
//  * Время публикации не подставляется вместо времени происшествия.
//  * Полицейский newsroom охватывает Wuppertal, Remscheid и Solingen.
//    Поэтому принимаются только публикации с датой-строкой Wuppertal (ots).

import { fetchWithRetry, truncate } from '../util.js';
import { syncSource } from '../events.js';
import { extractStreet, geocodeStreet } from '../geo.js';
import { parseEventTime } from '../time.js';

export const meta = {
  id: 'presseportal',
  name: 'Presseportal: Feuerwehr / Polizei Wuppertal',
  intervalSec: 600,
  cron: '*/10 * * * *',
  group: 'emergency'
};

const MAX_AGE_DAYS = 7;

const FEEDS = [
  {
    id: '115885',
    publisher: 'Feuerwehr Wuppertal',
    type: 'fire',
    url: 'https://www.presseportal.de/rss/dienststelle_115885.rss2'
  },
  {
    id: '11811',
    publisher: 'Polizei Wuppertal',
    type: 'police',
    url: 'https://www.presseportal.de/rss/dienststelle_11811.rss2'
  }
];

// Декодирование XML-сущностей без зависимости от DOMParser.
// Работает в Cloudflare Workers.
function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10))
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

// Извлекает содержимое XML-тега.
// Поддерживает CDATA и обычный текст.
function getTag(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`,
    'i'
  );

  const match = String(xml || '').match(re);
  return match ? decodeXml(match[1]) : '';
}

// Убирает HTML-разметку из RSS description.
function cleanHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Разбирает RSS 2.0 и возвращает массив публикаций.
function parseRss(xml) {
  const source = String(xml || '');
  const items = [];
  const matches = source.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi);

  for (const match of matches) {
    const itemXml = match[1];

    const title = getTag(itemXml, 'title');
    const description =
      getTag(itemXml, 'description') ||
      getTag(itemXml, 'content:encoded');

    const link = getTag(itemXml, 'link');
    const guid = getTag(itemXml, 'guid');
    const pubDate = getTag(itemXml, 'pubDate');

    const id = guid || link;

    if (!id || !title || !pubDate) continue;

    items.push({
      id,
      title,
      description: cleanHtml(description),
      link,
      pubDate
    });
  }

  return items;
}

// Определяет город в начале пресс-релиза.
// Например: Wuppertal (ots) -
function dateline(body) {
  const text = String(body || '');
  const match = text.match(
    /^\s*([^()\n]{2,60}?)\s*\(ots\)/i
  );

  return match ? match[1].trim() : null;
}

function classify(text, publisher) {
  const t = String(text || '').toLowerCase();

  if (/gefahrstoff|gasaustritt|einsturz|explosion|bombe|kampfmittel|evakuier/.test(t)) {
    return 'hazard';
  }

  if (/\b\w*brand\b|\bfeuer(?!wehr)\w*|rauchentwicklung|löscharbeiten|flammen/.test(t)) {
    return 'fire';
  }

  if (/verkehrsunfall|unfall|kollision|zusammenstoß/.test(t)) {
    return 'accident';
  }

  if (/rettungsdienst|reanimation|rettungswagen|notarzt/.test(t)) {
    return 'rescue';
  }

  if (publisher === 'police') {
    return 'police';
  }

  return 'emergency_other';
}

function normalizeTitle(title) {
  return String(title || '')
    .replace(/^(?:FW|POL)-[A-Z]+\s*(?:\(\d+\))?\s*:\s*/i, '')
    .trim();
}

function toItem(story, feed, nowMs, ttlMs) {
  const title0 = String(story.title || '').trim();
  const body = String(story.description || '').trim();

  const published = Date.parse(story.pubDate);

  if (!story.id || !title0 || !Number.isFinite(published)) {
    return null;
  }

  // Не принимаем публикации из будущего.
  if (published > nowMs + 10 * 60 * 1000) {
    return null;
  }

  // Не обрабатываем слишком старые публикации.
  if (nowMs - published > MAX_AGE_DAYS * 24 * 3600 * 1000) {
    return null;
  }

  const line = dateline(body);
  const text = `${title0} ${body}`;

  if (feed.type === 'police') {
    // Полицейская лента содержит также Remscheid и Solingen.
    // Для неё обязательно наличие точной строки Wuppertal (ots).
    if (!line || !/^wuppertal$/i.test(line)) {
      return null;
    }
  } else {
    // Для пожарной службы допускаем публикации с Wuppertal
    // в заголовке или тексте, если отдельная дата-строка отсутствует.
    if (line) {
      if (!/^wuppertal$/i.test(line)) return null;
    } else if (!/wuppertal/i.test(text)) {
      return null;
    }
  }

  const title = normalizeTitle(title0);

  const clean = body
    .replace(/^\s*[^()\n]{2,60}?\s*\(ots\)\s*[-–]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const eventText = `${title0}. ${body}`;
  const eventTime = parseEventTime(eventText, published);

  const expiresMs = published + ttlMs;
  const expired = nowMs >= expiresMs;

  const street = extractStreet(eventText);

  const item = {
    // Префикс источника исключает коллизии между двумя RSS-лентами.
    source_event_id: `${feed.id}:${story.id}`,

    publisher: feed.publisher,
    title,

    description: truncate(clean, 420) || null,

    category: classify(text, feed.type),

    source_url: story.link || (
      String(story.id).startsWith('http')
        ? story.id
        : `https://www.presseportal.de/story/${encodeURIComponent(story.id)}`
    ),

    geo_precision: 'none',
    location_name: street,

    event_time: eventTime.ms != null
      ? new Date(eventTime.ms).toISOString()
      : null,

    time_precision: eventTime.precision,

    published_at: new Date(published).toISOString(),

    status: expired ? 'EXPIRED' : 'RECENT',
    status_reason: expired
      ? 'ttl'
      : 'press_release_actuality_unknown',

    confidence: 0.5,
    is_verified: 1,

    expires_at: new Date(expiresMs).toISOString()
  };

  if (street && !expired) {
    item.enrich = async (ctx) => {
      const geo = await geocodeStreet(ctx, street);

      if (!geo) {
        item.geocode_attempts = 1;
        return;
      }

      if (geo.pending) return;

      item.geo_precision = geo.precision;
      item.district = geo.district || null;
      item.confidence = 0.6;

      if (geo.precision === 'street') {
        item.latitude = geo.lat;
        item.longitude = geo.lon;
      }

      // Для района координаты не сохраняем:
      // на карте отображается только приблизительная область.
    };
  }

  return item;
}

async function fetchFeed(feed) {
  const response = await fetchWithRetry(feed.url, {
    headers: {
      accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      'user-agent': 'WuppertalLive/1.0 (+https://github.com/bipolaroc4ka/wupp-live)'
    },
    timeoutMs: 10000,
    retries: 2
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from Presseportal RSS`);
  }

  const xml = await response.text();

  if (!/<rss[\s>]/i.test(xml) && !/<feed[\s>]/i.test(xml)) {
    throw new Error('Invalid RSS/XML response from Presseportal');
  }

  return {
    xml,
    stories: parseRss(xml)
  };
}

export async function run(ctx) {
  const ttlMs = Math.max(
    1,
    parseFloat(ctx.env.PRESS_TTL_HOURS) || 12
  ) * 3600 * 1000;

  const items = [];

  let successfulFeeds = 0;
  let lastError = null;

  for (const feed of FEEDS) {
    try {
      const result = await fetchFeed(feed);

      successfulFeeds += 1;

      let accepted = 0;

      for (const story of result.stories) {
        const item = toItem(story, feed, ctx.now, ttlMs);

        if (item) {
          items.push(item);
          accepted += 1;
        }
      }

      ctx.log(
        `presseportal ${feed.type}: RSS items=${result.stories.length}, accepted=${accepted}`
      );
    } catch (error) {
      lastError = error;

      ctx.log(
        `presseportal ${feed.type}: ${error.message}`
      );
    }
  }

  // Если обе ленты недоступны, источник считается ошибочным.
  if (successfulFeeds === 0) {
    throw lastError || new Error('All Presseportal RSS feeds failed');
  }

  // Не закрываем события только потому, что они исчезли из RSS.
  // Актуальность ограничивается TTL.
  return syncSource(ctx, meta.id, items, {
    resolveMissing: false
  });
}

// Проверка RSS через существующую кнопку «Проба» в админке.
export async function probe() {
  const results = [];

  for (const feed of FEEDS) {
    try {
      const result = await fetchFeed(feed);

      results.push({
        publisher: feed.publisher,
        url: feed.url,
        status: 'ok',
        items: result.stories.length,
        sample: result.stories.slice(0, 3).map((story) => ({
          title: story.title,
          pubDate: story.pubDate,
          link: story.link
        }))
      });
    } catch (error) {
      results.push({
        publisher: feed.publisher,
        url: feed.url,
        status: 'error',
        error: error.message
      });
    }
  }

  return {
    source: 'Presseportal RSS',
    feeds: results
  };
}
