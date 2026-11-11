
import { ISO, truncate } from './util.js';

const MODEL = '@cf/meta/m2m100-1.2b';
const CHUNK = 400;
const MAX_DESC = 1600;
const PER_RUN = 6;

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

async function translateText(env, text) {
  const lines = chunkText(text);
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

  return done.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

  // Обе записи сохраняются одной D1 batch-операцией.
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
    `SELECT id, title, description
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
    const hash = textHash(event.title, event.description);
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
        truncate(event.title, 300)
      );

      let translatedDescription = null;

      if (event.description) {
        translatedDescription = await translateText(
          env,
          truncate(event.description, MAX_DESC)
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

      // Не показываем неполный или устаревший перевод.
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
    // Переводы необязательны: API продолжает отдавать оригинал.
  }

  return map;
}
