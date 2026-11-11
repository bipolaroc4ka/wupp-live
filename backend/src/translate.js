
import { ISO, truncate } from './util.js';

const MODEL = '@cf/meta/m2m100-1.2b';
const CHUNK = 400;
const MAX_DESC = 1600;
const PER_RUN = 6;

// Распространённые немецкие окончания названий улиц и мест.
const STREET_SUFFIX =
  '(?:straße|strasse|str\\.?|weg|platz|allee|ring|gasse|ufer|damm|chaussee|stieg|markt|brücke|bruecke|promenade|wall|stieg|höfe|hoefe)';

// Находит названия с заглавной буквы, включая составные названия.
const PLACE_PATTERN = new RegExp(
  String.raw`\b(?:[\p{Lu}][\p{L}\p{M}0-9.'’()-]*[ \t]+){0,3}[\p{Lu}][\p{L}\p{M}0-9.'’()-]*${STREET_SUFFIX}(?=\b|[ \t.,;:!?]|$)`,
  'gu'
);

export function textHash(title, description) {
  const s = `${title || ''}\u0000${description || ''}`;

  let h = 2166136261;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return (h >>> 0).toString(16) + ':' + s.length;
}

export function chunkText(text, max = CHUNK) {
  const out = [];

  for (const line of String(text).split('\n')) {
    if (!line.trim()) {
      out.push('');
      continue;
    }

    let cur = '';

    for (const part of line.split(/(?<=[.!?])\s+/)) {
      if (cur && (cur + ' ' + part).length > max) {
        out.push(cur);
        cur = part;
      } else {
        cur = cur ? cur + ' ' + part : part;
      }

      while (cur.length > max) {
        out.push(cur.slice(0, max));
        cur = cur.slice(max);
      }
    }

    out.push(cur);
  }

  return out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Защищаем название и его сокращённые варианты.
// Например: Feldstraße -> Feldstr.
function makeLocationVariants(locationName) {
  const name = String(locationName || '').trim();

  if (!name) return [];

  const variants = [name];

  const suffixes = [
    [/straße$/iu, ['str.', 'str', 'straße']],
    [/strasse$/iu, ['str.', 'str', 'strasse']],
    [/str\.?$/iu, ['straße', 'strasse', 'str.']],
    [/platz$/iu, ['platz']],
    [/weg$/iu, ['weg']],
    [/allee$/iu, ['allee']],
    [/ring$/iu, ['ring']],
    [/gasse$/iu, ['gasse']],
    [/ufer$/iu, ['ufer']],
    [/damm$/iu, ['damm']]
  ];

  for (const [pattern, endings] of suffixes) {
    if (!pattern.test(name)) continue;

    const stem = name.replace(pattern, '');

    for (const ending of endings) {
      variants.push(stem + ending);
    }
  }

  return [...new Set(variants)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function protectPlaceNames(text, locationName = '') {
  const original = String(text || '');
  const candidates = [];

  // 1. Название места из базы данных и его сокращения.
  candidates.push(...makeLocationVariants(locationName));

  // 2. Другие названия улиц, площадей и мест в тексте.
  candidates.push(...(original.match(PLACE_PATTERN) || []));

  const unique = [...new Set(candidates)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  const replacements = [];
  let protectedText = original;

  for (const candidate of unique) {
    const marker = `ZXQKEEP${replacements.length}XZQ`;
    const pattern = new RegExp(
      escapeRegExp(candidate),
      'giu'
    );

    if (!pattern.test(protectedText)) continue;

    pattern.lastIndex = 0;

    protectedText = protectedText.replace(
      pattern,
      marker
    );

    replacements.push({
      marker,
      original: candidate
    });
  }

  return {
    text: protectedText,
    replacements
  };
}

function restorePlaceNames(text, replacements) {
  let result = text;

  for (const item of replacements) {
    if (!result.includes(item.marker)) {
      throw new Error(
        `Не удалось восстановить название: ${item.original}`
      );
    }

    result = result.split(item.marker).join(item.original);
  }

  return result;
}

async function translateText(env, text, locationName = '') {
  if (!text || !String(text).trim()) return '';

  const protectedResult = protectPlaceNames(
    text,
    locationName
  );

  const lines = chunkText(protectedResult.text);
  const done = [];

  for (const piece of lines) {
    if (!piece) {
      done.push('');
      continue;
    }

    const result = await env.AI.run(MODEL, {
      text: piece,
      source_lang: 'de',
      target_lang: 'ru'
    });

    const translated =
      result?.translated_text ??
      result?.result?.translated_text;

    if (
      typeof translated !== 'string' ||
      !translated.trim()
    ) {
      throw new Error('Пустой ответ модели перевода');
    }

    done.push(translated.trim());
  }

  return restorePlaceNames(
    done.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    protectedResult.replacements
  );
}

async function readTranslationRows(env, ids) {
  if (!ids.length) return [];

  const placeholders = ids.map(() => '?').join(',');

  const result = await env.DB.prepare(
    `SELECT
       event_id,
       text_type,
       src_hash,
       translated_text
     FROM translations
     WHERE target_lang = 'ru'
       AND event_id IN (${placeholders})`
  ).bind(...ids).all();

  return result.results || [];
}

function groupTranslationRows(rows) {
  const grouped = new Map();

  for (const row of rows) {
    if (!grouped.has(row.event_id)) {
      grouped.set(row.event_id, {});
    }

    grouped.get(row.event_id)[row.text_type] = row;
  }

  return grouped;
}

async function saveTranslation(
  env,
  event,
  hash,
  title,
  description
) {
  const now = ISO(Date.now());

  const statements = [
    env.DB.prepare(
      `INSERT INTO translations (
         id,
         event_id,
         source_lang,
         target_lang,
         original_text,
         translated_text,
         model,
         created_at,
         updated_at,
         src_hash,
         text_type
       )
       VALUES (?, ?, 'de', 'ru', ?, ?, ?, ?, ?, ?, 'title')
       ON CONFLICT(event_id, target_lang, text_type)
       DO UPDATE SET
         original_text = excluded.original_text,
         translated_text = excluded.translated_text,
         model = excluded.model,
         updated_at = excluded.updated_at,
         src_hash = excluded.src_hash`
    ).bind(
      crypto.randomUUID(),
      event.id,
      event.title || '',
      title,
      MODEL,
      now,
      now,
      hash
    )
  ];

  if (event.description) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO translations (
           id,
           event_id,
           source_lang,
           target_lang,
           original_text,
           translated_text,
           model,
           created_at,
           updated_at,
           src_hash,
           text_type
         )
         VALUES (?, ?, 'de', 'ru', ?, ?, ?, ?, ?, ?, 'description')
         ON CONFLICT(event_id, target_lang, text_type)
         DO UPDATE SET
           original_text = excluded.original_text,
           translated_text = excluded.translated_text,
           model = excluded.model,
           updated_at = excluded.updated_at,
           src_hash = excluded.src_hash`
      ).bind(
        crypto.randomUUID(),
        event.id,
        event.description,
        description,
        MODEL,
        now,
        now,
        hash
      )
    );
  } else {
    statements.push(
      env.DB.prepare(
        `DELETE FROM translations
         WHERE event_id = ?
           AND target_lang = 'ru'
           AND text_type = 'description'`
      ).bind(event.id)
    );
  }

  await env.DB.batch(statements);
}

export async function translatePending(
  env,
  { limit = PER_RUN } = {}
) {
  if (!env.AI || typeof env.AI.run !== 'function') {
    return { skipped: 'no AI binding' };
  }

  const eventsResult = await env.DB.prepare(
    `SELECT id, title, description, location_name
     FROM events
     WHERE status IN ('LIVE', 'ACTIVE', 'RECENT')
     ORDER BY updated_at DESC
     LIMIT 120`
  ).all();

  const events = eventsResult.results || [];

  if (!events.length) {
    return {
      translated: 0,
      failed: 0,
      pending: 0
    };
  }

  const rows = await readTranslationRows(
    env,
    events.map((event) => event.id)
  );

  const existing = groupTranslationRows(rows);

  const todo = events.filter((event) => {
    const hash = textHash(
      event.title,
      event.description
    );

    const saved = existing.get(event.id);

    if (!saved?.title) return true;
    if (saved.title.src_hash !== hash) return true;

    if (event.description) {
      return (
        !saved.description ||
        saved.description.src_hash !== hash
      );
    }

    return !!saved.description;
  }).slice(0, Math.max(0, limit));

  let done = 0;
  let failed = 0;
  let lastError = null;

  for (const event of todo) {
    try {
      const hash = textHash(
        event.title,
        event.description
      );

      const translatedTitle = await translateText(
        env,
        truncate(event.title, 300),
        event.location_name
      );

      let translatedDescription = null;

      if (event.description) {
        translatedDescription = await translateText(
          env,
          truncate(event.description, MAX_DESC),
          event.location_name
        );
      }

      await saveTranslation(
        env,
        event,
        hash,
        translatedTitle,
        translatedDescription
      );

      done++;
    } catch (error) {
      failed++;

      lastError =
        (error && error.message) || String(error);

      if (failed >= 2) break;
    }
  }

  return {
    translated: done,
    failed,
    pending: Math.max(0, todo.length - done),
    error: lastError
  };
}

export async function loadTranslations(env, ids) {
  const map = new Map();

  if (!ids.length) return map;

  try {
    const rows = await readTranslationRows(env, ids);
    const grouped = groupTranslationRows(rows);

    for (const [eventId, saved] of grouped) {
      const title = saved.title;

      if (!title) continue;

      if (
        saved.description &&
        saved.description.src_hash !== title.src_hash
      ) {
        continue;
      }

      map.set(eventId, {
        src_hash: title.src_hash,
        title: title.translated_text,
        description:
          saved.description?.translated_text || null
      });
    }
  } catch {
    // При ошибке API продолжает отдавать оригинал.
  }

  return map;
}
