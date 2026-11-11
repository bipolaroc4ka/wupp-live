// Машинный перевод текстов событий с немецкого на русский (Cloudflare Workers AI, модель m2m100).
// Необязательная функция: без привязки [ai] AI в wrangler.toml ничего не происходит и приложение показывает оригинал.
// Принципы: перевод никогда не заменяет оригинал (хранится отдельно, в API идут оба текста), любая ошибка
// перевода не влияет на приём событий, лимит событий за запуск защищает бесплатную квоту.

import { ISO, truncate } from './util.js';

const MODEL = '@cf/meta/m2m100-1.2b';
const CHUNK = 400;           // символов на один запрос к модели
const MAX_DESC = 1600;       // длиннее не переводим: хвост пресс-релизов не нужен
const PER_RUN = 6;           // событий за запуск (по 2 запроса и больше на событие, лимит подзапросов Worker — 50)

const DDL = 'CREATE TABLE IF NOT EXISTS translations (' +
  'event_id TEXT NOT NULL, lang TEXT NOT NULL, src_hash TEXT NOT NULL, title TEXT, description TEXT, created_at TEXT NOT NULL, ' +
  'PRIMARY KEY (event_id, lang))';

// Быстрый нестойкий хэш исходного текста: нужен только чтобы заметить, что источник изменил текст.
export function textHash(title, description) {
  const s = `${title || ''}\u0000${description || ''}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + ':' + s.length;
}

// Делим текст на куски по строкам и предложениям, чтобы каждый кусок помещался в модель; переводы строк сохраняем.
export function chunkText(text, max = CHUNK) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) { out.push(''); continue; }
    let cur = '';
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      if (cur && (cur + ' ' + part).length > max) { out.push(cur); cur = part; } else cur = cur ? cur + ' ' + part : part;
      while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
    }
    out.push(cur);
  }
  return out;
}

async function translateText(env, text) {
  const lines = chunkText(text);
  const done = [];
  for (const piece of lines) {
    if (!piece) { done.push(''); continue; }
    const r = await env.AI.run(MODEL, { text: piece, source_lang: 'de', target_lang: 'ru' });
    const t = r && (r.translated_text ?? (r.result && r.result.translated_text));
    if (typeof t !== 'string' || !t.trim()) throw new Error('пустой ответ модели перевода');
    done.push(t.trim());
  }
  return done.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function ensureTranslations(env) {
  await env.DB.prepare(DDL).run();
}

export async function translatePending(env, { limit = PER_RUN } = {}) {
  if (!env.AI || typeof env.AI.run !== 'function') return { skipped: 'no AI binding' };
  await ensureTranslations(env);
  const events = (await env.DB.prepare(
    "SELECT id, title, description FROM events WHERE status IN ('LIVE','ACTIVE','RECENT') ORDER BY updated_at DESC LIMIT 120"
  ).all()).results || [];
  const have = new Map(((await env.DB.prepare("SELECT event_id, src_hash FROM translations WHERE lang = 'ru'").all()).results || [])
    .map((r) => [r.event_id, r.src_hash]));
  const todo = events.filter((e) => have.get(e.id) !== textHash(e.title, e.description)).slice(0, limit);

  let done = 0, failed = 0, lastError = null;
  for (const e of todo) {
    try {
      const title = await translateText(env, truncate(e.title, 300));
      const desc = e.description ? await translateText(env, truncate(e.description, MAX_DESC)) : null;
      await env.DB.prepare(
        "INSERT INTO translations (event_id, lang, src_hash, title, description, created_at) VALUES (?, 'ru', ?, ?, ?, ?) " +
        'ON CONFLICT(event_id, lang) DO UPDATE SET src_hash = excluded.src_hash, title = excluded.title, description = excluded.description, created_at = excluded.created_at'
      ).bind(e.id, textHash(e.title, e.description), title, desc, ISO(Date.now())).run();
      done++;
    } catch (err) {
      failed++; lastError = (err && err.message) || String(err);
      if (failed >= 2) break; // модель недоступна или квота исчерпана: не тратим запросы дальше
    }
  }
  return { translated: done, failed, pending: Math.max(0, todo.length - done), error: lastError };
}

// Для API: переводы нужных событий одним запросом. Если таблицы ещё нет или запрос не удался, просто возвращаем пустую карту.
export async function loadTranslations(env, ids) {
  const map = new Map();
  if (!ids.length) return map;
  try {
    const rows = (await env.DB.prepare(
      `SELECT event_id, src_hash, title, description FROM translations WHERE lang = 'ru' AND event_id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all()).results || [];
    for (const r of rows) map.set(r.event_id, r);
  } catch { /* переводы необязательны */ }
  return map;
}
