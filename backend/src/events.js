// Единый формат события, защита от дублей, обнаружение изменений, завершение событий.

import { ACTIVE_STATUSES, CITY } from './config.js';
import { ISO, sha256Hex, shortId } from './util.js';

const COLS = [
  'id', 'city_id', 'source', 'source_event_id', 'scope', 'publisher', 'title', 'description', 'category',
  'source_url', 'latitude', 'longitude', 'geo_precision', 'location_name', 'district', 'event_time',
  'time_precision', 'published_at', 'received_at', 'updated_at', 'status', 'status_reason', 'confidence',
  'is_verified', 'expires_at', 'severity', 'content_hash', 'geocode_attempts', 'miss_count'
];
const UPDATE_COLS = COLS.filter((c) => !['id', 'received_at', 'city_id', 'source', 'source_event_id'].includes(c));

const UPSERT_SQL =
  `INSERT INTO events (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')}) ` +
  `ON CONFLICT(id) DO UPDATE SET ${UPDATE_COLS.map((c) => `${c} = excluded.${c}`).join(', ')} ` +
  `WHERE events.content_hash != excluded.content_hash OR events.status != excluded.status OR events.miss_count > 0`;

// Поля, влияющие на «смысл» записи. Геокод сюда не входит: он добавляется отдельно.
// Поля, влияющие на содержимое и состояние события.
async function hashOf(it) {
  return sha256Hex(JSON.stringify([
    it.title,
    it.description,
    it.category,
    it.status,
    it.status_reason,
    it.event_time,
    it.time_precision,
    it.published_at,
    it.expires_at,
    it.latitude,
    it.longitude,
    it.geo_precision,
    it.location_name,
    it.district,
    it.publisher,
    it.source_url,
    it.severity,
    it.confidence,
    it.is_verified
  ]));
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Синхронизирует список записей одного источника с базой.
 * items: нормализованные события (см. sources/*). Каждое может иметь enrich(ctx) — геокодирование,
 *        вызывается только для новых или изменённых записей.
 * opts.resolveMissing  — завершать записи, пропавшие из официальной ленты
 * opts.resolvedScopes  — Set областей, чей запрос в этом запуске удался (null = все)
 */
export async function syncSource(ctx, sourceId, items, opts = {}) {
  const { resolveMissing = false, resolvedScopes = null } = opts;
  const db = ctx.env.DB;
  const nowIso = ISO(ctx.now);

  const existingRows = (await db.prepare(
    'SELECT id, content_hash, status, scope, miss_count FROM events WHERE source = ? AND city_id = ?'
  ).bind(sourceId, CITY.id).all()).results || [];
  const existing = new Map(existingRows.map((r) => [r.id, r]));
  const suppressed = new Set(((await db.prepare('SELECT id FROM suppressed').all()).results || []).map((r) => r.id));

  const stmts = [];
  const seen = new Set();
  let inserted = 0, updated = 0, resolved = 0;

  for (const it of items) {
    it.id = `${sourceId}:${await shortId(it.source_event_id)}`;
    if (suppressed.has(it.id) || seen.has(it.id)) continue;
    seen.add(it.id);
    it.content_hash = await hashOf(it);
    const ex = existing.get(it.id);
    if (ex && ex.content_hash === it.content_hash && ex.status === it.status && ex.miss_count === 0) continue;

    if (typeof it.enrich === 'function' && (!ex || ex.content_hash !== it.content_hash)) {
      try { await it.enrich(ctx); } catch (e) { ctx.log(`enrich failed: ${e.message}`); }
    }
    const row = {
      city_id: CITY.id, source: sourceId, scope: null, publisher: null, description: null, source_url: null,
      latitude: null, longitude: null, geo_precision: 'none', location_name: null, district: null,
      event_time: null, time_precision: 'unknown', published_at: null, status_reason: null,
      confidence: 0.5, is_verified: 0, expires_at: null, severity: null, geocode_attempts: 0,
      ...it, received_at: nowIso, updated_at: nowIso, miss_count: 0
    };
    stmts.push(db.prepare(UPSERT_SQL).bind(...COLS.map((c) => row[c] ?? null)));
    if (ex) updated++; else inserted++;
  }

  if (resolveMissing) {
    for (const ex of existingRows) {
      if (seen.has(ex.id) || !ACTIVE_STATUSES.includes(ex.status)) continue;
      if (resolvedScopes && !resolvedScopes.has(ex.scope)) continue; // запрос по этой области не удался — не трогаем
      if (ex.miss_count + 1 >= 2) {
        // два запуска подряд записи нет в официальной ленте — считаем завершённой
        stmts.push(db.prepare(
          "UPDATE events SET status = 'RESOLVED', status_reason = 'removed_from_source_feed', updated_at = ?, miss_count = 0 WHERE id = ?"
        ).bind(nowIso, ex.id));
        resolved++;
      } else {
        stmts.push(db.prepare('UPDATE events SET miss_count = miss_count + 1 WHERE id = ?').bind(ex.id));
      }
    }
  }

  for (const part of chunk(stmts, 40)) await db.batch(part);
  return { fetched: items.length, inserted, updated, resolved, changes: inserted + updated + resolved };
}

// Автоматическое завершение по сроку (TTL).
export async function sweepExpired(ctx) {
  const nowIso = ISO(ctx.now);
  await ctx.env.DB.prepare(
    "UPDATE events SET status = 'EXPIRED', status_reason = 'ttl', updated_at = ? " +
    "WHERE status IN ('LIVE','ACTIVE','RECENT') AND expires_at IS NOT NULL AND expires_at < ?"
  ).bind(nowIso, nowIso).run();
}

export async function cleanupOld(ctx) {
  const db = ctx.env.DB;
  const cutoff = ISO(ctx.now - 30 * 24 * 3600e3);
  await db.prepare(
    "DELETE FROM events WHERE status IN ('EXPIRED','RESOLVED') AND COALESCE(event_time, published_at, received_at) < ?"
  ).bind(cutoff).run();
  await db.prepare('DELETE FROM error_log WHERE ts < ?').bind(ISO(ctx.now - 14 * 24 * 3600e3)).run();
  await db.prepare('DELETE FROM geocode_cache WHERE found = 0 AND created_at < ?').bind(ISO(ctx.now - 7 * 24 * 3600e3)).run();
}
