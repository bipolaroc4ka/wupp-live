
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

const ALLOWED_GEO_PRECISIONS = new Set([
  'source',
  'street',
  'district',
  'city',
  'none'
]);

const ROAD_KEYWORDS =
  /\b(baustelle|baustellen|baumaßnahme|baumaßnahmen|bauarbeiten|straßenbauarbeiten|fahrbahnsanierung|fahrbahndecke|asphalt|sperrung|vollsperrung|teilsperrung|halbseitige sperrung|umleitung|verkehrsbehinderung|brückensanierung|brückenarbeiten|brückenbau|treppensanierung|geländerarbeiten|fahrbahnschäden|fahrbahn|straßensanierung|straßenbau|arbeitsstelle|ampelanlage|ampelarbeiten|lichtsignalanlage|gehwegsanierung|gehweg|radwegsanierung|radweg|kanalarbeiten|kanalsanierung|tiefbauarbeiten|straßenunterhaltung|deckensanierung|pflasterarbeiten|unterführung|tunnelarbeiten|verkehrsführung|verkehrssicherung|brücke|brücken|tunnel|stützmauer|stützwand)\b/i;

const STRONG_ROAD_KEYWORDS =
  /\b(baustelle|baumaßnahme|bauarbeiten|fahrbahnsanierung|fahrbahndecke|asphalt|sperrung|vollsperrung|teilsperrung|umleitung|brückensanierung|brückenarbeiten|brückenbau|fahrbahnschäden|straßensanierung|straßenbau|arbeitsstelle|ampelarbeiten|lichtsignalanlage|gehwegsanierung|radwegsanierung|kanalsanierung|tiefbauarbeiten|deckensanierung)\b/i;

const CLOSURE_KEYWORDS =
  /\b(vollsperrung|voll gesperrt|teilsperrung|halbseitige sperrung|gesperrt|sperrung|umleitung|nicht passierbar|für den verkehr gesperrt)\b/i;

const ROADWORKS_KEYWORDS =
  /\b(baustelle|baumaßnahme|baumaßnahmen|bauarbeiten|straßenbauarbeiten|fahrbahnsanierung|fahrbahndecke|fahrbahnschäden|fahrbahn|asphalt|straßensanierung|straßenbau|sanierung|sanieren|reparatur|repariert|erneuerung|erneuert|instandsetzung|instandsetzen|deckensanierung|pflasterarbeiten|brückensanierung|brückenarbeiten|brückenbau|treppensanierung|geländerarbeiten|gehwegsanierung|radwegsanierung|kanalarbeiten|kanalsanierung|tiefbauarbeiten|straßenunterhaltung|unterführung|tunnelarbeiten|stützmauer|stützwand)\b/i;

const DISRUPTION_KEYWORDS =
  /\b(verkehrsbehinderung|verkehrsführung|ampelarbeiten|ampelanlage|lichtsignalanlage|verkehrssicherung)\b/i;

const INFRASTRUCTURE_KEYWORDS =
  /\b(brücke|brücken|tunnel|unterführung|treppe|treppen|geländer|stützmauer|stützwand|kanal|kanäle|gehweg|radweg)\b/i;

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

const MONTH_PATTERN =
  'Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember';

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

    if (isBoilerplateItem(item)) continue;

    items.push(item);
  }

  return items;
}

function extractStreetCandidates(text) {
  if (!text) return [];

  const candidates = [];

  const patterns = [
    new RegExp(
      `\\b[A-ZÄÖÜ][\\p{L}\\d'’\\-]*(?:\\s+[A-ZÄÖÜ][\\p{L}\\d'’\\-]*){0,4}\\s+${STREET_SUFFIX}\\b`,
      'gu'
    ),
    new RegExp(
      `\\b[A-ZÄÖÜ][\\p{L}\\d'’]*(?:-[A-ZÄÖÜ][\\p{L}\\d'’]*)*${STREET_SUFFIX}\\b`,
      'gu'
    ),
    /\b(?:Am|An der|An den|Auf dem|Auf der|Im|In der|Unter dem|Über dem|Zum|Zur)\s+[A-ZÄÖÜ][\p{L}\d-]*(?:\s+[A-ZÄÖÜ][\p{L}\d-]*){0,3}/gu
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0]
        .replace(/[.,;:!?]+$/, '')
        .trim();

      if (value.length < 4 || value.length > 100) continue;

      candidates.push({
        name: value,
        index: match.index
      });
    }
  }

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

function extractBetweenLocation(text) {
  const match = /\bzwischen\s+/i.exec(text);

  if (!match) return null;

  const segment = text.slice(match.index + match[0].length);
  const sentenceEnd = segment.search(/[.!?;\n]/);

  const clause = (
    sentenceEnd >= 0
      ? segment.slice(0, sentenceEnd)
      : segment
  ).trim();

  const separator = /\s+und\s+/i.exec(clause);

  if (!separator) return null;

  const first = clause
    .slice(0, separator.index)
    .replace(/^[\s,;:]+|[\s,;:.!?]+$/g, '')
    .trim();

  const second = clause
    .slice(separator.index + separator[0].length)
    .replace(/^[\s,;:]+|[\s,;:.!?]+$/g, '')
    .trim();

  if (
    first.length < 3 ||
    second.length < 3 ||
    first.length > 100 ||
    second.length > 100
  ) {
    return null;
  }

  if (
    !/^[A-ZÄÖÜ][\p{L}\d'’ -]*$/u.test(first) ||
    !/^[A-ZÄÖÜ][\p{L}\d'’ -]*$/u.test(second)
  ) {
    return null;
  }

  return {
    type: 'between',
    streets: [first, second],
    label: `zwischen ${first} und ${second}`
  };
}

function extractLocation(text) {
  if (!text) {
    return {
      type: 'none',
      streets: [],
      label: null
    };
  }

  const between = extractBetweenLocation(text);

  if (between) return between;

  const candidates = extractStreetCandidates(text);

  if (!candidates.length) {
    return {
      type: 'none',
      streets: [],
      label: null
    };
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

function makeDate(year, month, day) {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }

  const date = new Date(Date.UTC(year, month, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function resolveYear(day, month, explicitYear, now) {
  if (explicitYear) return explicitYear;

  const current = new Date(now);
  const currentYear = current.getUTCFullYear();

  const candidate = makeDate(currentYear, month, day);

  if (!candidate) return null;

  // Если дата без года находится более чем на месяц в прошлом,
  // предполагаем следующий календарный год.
  if (candidate.getTime() < now - 31 * DAY) {
    return currentYear + 1;
  }

  return currentYear;
}

function parseDateCandidate(match, now) {
  let day;
  let month;
  let year = null;

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

  const resolvedYear = resolveYear(day, month, year, now);

  return makeDate(resolvedYear, month, day);
}

function parseEndOfMonth(text, now) {
  const match = text.match(
    new RegExp(
      `\\b(?:bis|voraussichtlich\\s+bis)\\s+(?:(?:etwa|ungefähr|ca\\.?|circa)\\s+)?Ende\\s+(${MONTH_PATTERN})(?:\\s+(\\d{4}))?`,
      'i'
    )
  );

  if (!match) return null;

  const month = MONTHS[match[1].toLowerCase()];

  if (!Number.isInteger(month)) return null;

  const currentYear = new Date(now).getUTCFullYear();
  let year = match[2] ? Number(match[2]) : currentYear;

  if (!match[2] && month < new Date(now).getUTCMonth() - 1) {
    year++;
  }

  return new Date(Date.UTC(year, month + 1, 0));
}

/**
 * Разбирает даты и определяет их назначение по контексту.
 *
 * Поддерживает:
 * ab Montag, 16. November
 * am kommenden Montag, 16. November
 * Heute, 9. November
 * vom 10.11.2026 bis 20.11.2026
 * bis etwa Ende Dezember
 *
 * Не использует первую найденную дату как начало автоматически.
 */
function parseGermanDates(text, now) {
  const prefixPattern =
    '(ab|seit|vom|von|bis(?:\\s+(?:etwa|ungefähr|ca\\.?|circa|zum))?|voraussichtlich\\s+bis)';

  const datePattern = new RegExp(
    `(?:\\b${prefixPattern}\\s+)?(?:${WEEKDAYS}\\s*,?\\s*)?(?:(\\d{1,2})\\.\\s*(${MONTH_PATTERN})(?:\\s+(\\d{4}))?|\\b(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})\\b)`,
    'gi'
  );

  const matches = [...text.matchAll(datePattern)]
    .map((match) => {
      const date = parseDateCandidate(match, now);

      return {
        index: match.index,
        endIndex: match.index + match[0].length,
        raw: match[0],
        prefix: (match[1] || '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim(),
        date
      };
    })
    .filter((item) => item.date)
    .sort((a, b) => a.index - b.index);

  const result = {
    start: null,
    end: null
  };

  if (!matches.length) {
    result.end = parseEndOfMonth(text, now);
    return result;
  }

  const isStartContext = (item) => {
    const before = text.slice(
      Math.max(0, item.index - 100),
      item.index
    );

    const after = text.slice(
      item.endIndex,
      Math.min(text.length, item.endIndex + 120)
    );

    if (/^(?:ab|seit|vom|von)$/.test(item.prefix)) {
      return true;
    }

    if (
      /\b(?:am\s+kommenden|am\s+nächsten|ab\s+dem|ab\s+kommenden|ab\s+nächsten|heute|morgen)\s*$/i.test(before)
    ) {
      return true;
    }

    if (
      /\b(?:beginnt|beginnen|startet|starten|beginnen\s+die|starten\s+die|nimmt\s+...?\s+auf)\b/i.test(after)
    ) {
      return true;
    }

    if (
      /\b(?:beginnt|beginnen|startet|starten|baubeginn|beginn\s+der\s+arbeiten)\b/i.test(before)
    ) {
      return true;
    }

    return false;
  };

  const isEndContext = (item) => {
    if (
      item.prefix === 'bis' ||
      item.prefix === 'bis zum' ||
      item.prefix.startsWith('bis ') ||
      item.prefix === 'voraussichtlich bis'
    ) {
      return true;
    }

    const before = text.slice(
      Math.max(0, item.index - 100),
      item.index
    );

    return /\b(?:enden|endeten|abgeschlossen|fertiggestellt|dauern|andauern|bis zum|bis etwa|bis voraussichtlich)\s*$/i.test(before);
  };

  // Сначала обрабатываем явно обозначенные даты начала.
  const explicitStart = matches.find(isStartContext);

  if (explicitStart) {
    result.start = explicitStart.date;
  }

  // Затем — явно обозначенные даты окончания.
  const explicitEnd = matches.find(isEndContext);

  if (explicitEnd) {
    result.end = explicitEnd.date;
  }

  // Если начало явно найдено, следующая более поздняя дата
  // может быть окончанием только при наличии подходящего контекста.
  if (result.start && !result.end) {
    const laterEnd = matches.find(
      (item) =>
        item.date.getTime() >= result.start.getTime() &&
        item.index > matches.find(isStartContext).index &&
        isEndContext(item)
    );

    if (laterEnd) {
      result.end = laterEnd.date;
    }
  }

  // Для заголовков вида "Sanierung ... startet" дата в тексте
  // может быть указана отдельно от глагола.
  // Используем её только если дата одна и заголовок явно говорит о начале.
  if (!result.start && matches.length === 1) {
    const titleSignalsStart =
      /\b(startet|starten|beginnt|beginnen|baubeginn|arbeiten\s+beginnen)\b/i.test(
        text.slice(0, Math.min(text.length, 250))
      );

    const dateHasNoEndContext = !isEndContext(matches[0]);

    if (titleSignalsStart && dateHasNoEndContext) {
      result.start = matches[0].date;
    }
  }

  // Обрабатываем "Heute, 9. November, starten die Arbeiten".
  // В этом случае дата находится перед глаголом.
  if (!result.start) {
    const todayStart = matches.find((item) => {
      const before = text.slice(
        Math.max(0, item.index - 35),
        item.index
      );

      const after = text.slice(
        item.endIndex,
        Math.min(text.length, item.endIndex + 100)
      );

      return (
        /\b(?:heute|morgen|am kommenden|am nächsten)\s*,?\s*$/i.test(before) &&
        /\b(?:starten|beginnen|beginnt|startet)\b/i.test(after)
      );
    });

    if (todayStart) {
      result.start = todayStart.date;
    }
  }

  // Если начало и окончание не удалось определить однозначно,
  // не подставляем произвольные даты.
  if (!result.end) {
    result.end = parseEndOfMonth(text, now);
  }

  // Не допускаем окончание раньше начала.
  if (
    result.start &&
    result.end &&
    result.end.getTime() < result.start.getTime()
  ) {
    result.end = null;
  }

  return result;
}

function classify(text) {
  if (CLOSURE_KEYWORDS.test(text)) {
    return 'road_closure';
  }

  if (
    ROADWORKS_KEYWORDS.test(text) ||
    INFRASTRUCTURE_KEYWORDS.test(text)
  ) {
    return 'roadworks';
  }

  if (DISRUPTION_KEYWORDS.test(text)) {
    return 'traffic_disruption';
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

function normalizeGeoPrecision(value) {
  if (ALLOWED_GEO_PRECISIONS.has(value)) {
    return value;
  }

  return 'street';
}

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
          precision: normalizeGeoPrecision(geo.precision)
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
      approximate: location.type !== 'single'
    };
  }

  return {
    lat: (points[0].lat + points[1].lat) / 2,
    lon: (points[0].lon + points[1].lon) / 2,
    district: points[0].district || points[1].district || null,
    precision: 'street',
    approximate: true
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

    geo_precision: hasGeo
      ? normalizeGeoPrecision(geo.precision)
      : 'none',

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
      ? (geo.approximate ? 0.78 : 0.9)
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
