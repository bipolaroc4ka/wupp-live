// Wuppertal Live — HTTP API (публичное + админское) и обработчик cron.

import { CATEGORIES, STATUSES } from './config.js';
import { SOURCES, runScheduled, runSource, ensureSources } from './cron.js';
import { ISO } from './util.js';

// ---------- вспомогательное ----------

// Список из ALLOWED_ORIGINS приводится к виду «схема://хост»: путь и слэш на конце отбрасываются,
// поэтому значение «https://логин.github.io/репозиторий/» тоже сработает.
function allowedList(env) {
  return String(env.ALLOWED_ORIGINS || '*').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    if (x === '*') return x;
    try { return new URL(x).origin; } catch { return x.replace(/\/+$/, ''); }
  });
}

function allowedOrigin(env, origin) {
  const list = allowedList(env);
  if (list.includes('*')) return '*';
  return origin && list.includes(origin) ? origin : null;
}

function corsHeaders(env, req) {
  const o = allowedOrigin(env, req.headers.get('origin'));
  const h = {
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '86400',
    vary: 'origin'
  };
  if (o) h['access-control-allow-origin'] = o;
  return h;
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};

function json(env, req, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...corsHeaders(env, req), ...extra }
  });
}

// Простое ограничение частоты в памяти изолята (лучше дополнительно включить правило Cloudflare WAF Rate Limiting).
const buckets = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    if (buckets.size > 5000) buckets.clear();
    buckets.set(key, { start: now, n: 1 });
    return false;
  }
  b.n += 1;
  return b.n > limit;
}

function clientIp(req) {
  return req.headers.get('cf-connecting-ip') || 'unknown';
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function isAdmin(req, env) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 16) return false;
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer (.+)$/);
  return !!m && timingSafeEqual(m[1], env.ADMIN_TOKEN);
}

// Публичное представление события: без служебных полей.
// Координаты отдаются только если они обоснованы (источник или улица); район/город — без точки.
function publicEvent(r) {
  const hasPoint = (r.geo_precision === 'source' || r.geo_precision === 'street') && r.latitude != null && r.longitude != null;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    source: r.source,
    publisher: r.publisher,
    source_url: r.source_url,
    latitude: hasPoint ? r.latitude : null,
    longitude: hasPoint ? r.longitude : null,
    geo_precision: r.geo_precision,
    location_name: r.location_name,
    district: r.district,
    event_time: r.event_time,
    time_precision: r.time_precision,
    published_at: r.published_at,
    received_at: r.received_at,
    updated_at: r.updated_at,
    status: r.status,
    status_reason: r.status_reason,
    confidence: r.confidence,
    is_verified: !!r.is_verified,
    expires_at: r.expires_at,
    severity: r.severity
  };
}

function parseList(v, allowed) {
  if (!v) return null;
  const arr = v.split(',').map((s) => s.trim()).filter((s) => allowed.includes(s));
  return arr.length ? arr : null;
}

// ---------- публичные эндпоинты ----------

async function handleEvents(req, env, url) {
  const now = Date.now();
  const hours = Math.min(Math.max(parseFloat(url.searchParams.get('hours')) || 24, 1), 24 * 30);
  const history = url.searchParams.get('history') === '1';
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 300, 1), 500);
  const cats = parseList(url.searchParams.get('categories'), CATEGORIES);
  const sources = (url.searchParams.get('sources') || '').split(',').filter((s) => /^[a-z]+$/.test(s));

  const since = ISO(now - hours * 3600e3);
  const nowIso = ISO(now);
  const where = [];
  const binds = [];

  if (history) {
    where.push("status IN ('LIVE','ACTIVE','RECENT','EXPIRED','RESOLVED')");
  } else {
    where.push("status IN ('LIVE','ACTIVE','RECENT')");
    where.push('(expires_at IS NULL OR expires_at > ?)'); binds.push(nowIso);
  }
  // Окно времени: действующие события (LIVE/ACTIVE) показываются всегда, остальные — по времени происшествия/публикации.
  where.push("(status IN ('LIVE','ACTIVE') OR COALESCE(event_time, published_at, received_at) >= ?)"); binds.push(since);
  if (history) { where.push("(status IN ('LIVE','ACTIVE') OR COALESCE(event_time, published_at, received_at) >= ?)"); binds.push(since); }

  if (cats) { where.push(`category IN (${cats.map(() => '?').join(',')})`); binds.push(...cats); }
  if (sources.length) { where.push(`source IN (${sources.map(() => '?').join(',')})`); binds.push(...sources); }

  const bbox = (url.searchParams.get('bbox') || '').split(',').map(parseFloat);
  if (bbox.length === 4 && bbox.every(Number.isFinite)) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    // события без точки (район/город) не отфильтровываются по рамке карты
    where.push('(latitude IS NULL OR (latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?))');
    binds.push(minLat, maxLat, minLon, maxLon);
  }

  const sql =
    `SELECT * FROM events WHERE ${where.join(' AND ')} ` +
    "ORDER BY CASE status WHEN 'LIVE' THEN 0 WHEN 'ACTIVE' THEN 1 WHEN 'RECENT' THEN 2 ELSE 3 END, " +
    'COALESCE(event_time, published_at, received_at) DESC LIMIT ?';
  binds.push(limit);
  const rows = (await env.DB.prepare(sql).bind(...binds).all()).results || [];
  return { generated_at: nowIso, count: rows.length, events: rows.map(publicEvent) };
}

async function handleStatus(env) {
  await ensureSources(env);
  const now = Date.now();
  const rows = (await env.DB.prepare('SELECT * FROM sources ORDER BY id').all()).results || [];
  return {
    generated_at: ISO(now),
    sources: rows.map((s) => {
      const last = s.last_success_at ? Date.parse(s.last_success_at) : null;
      const stale = !s.enabled || last == null || now - last > s.interval_sec * 3 * 1000;
      return {
        id: s.id, name: s.name, enabled: !!s.enabled, interval_sec: s.interval_sec,
        last_success_at: s.last_success_at, stale, has_error: !!s.last_error
      };
    })
  };
}

// Кэш Cache API (30 секунд): снижает нагрузку на D1 при лимитах бесплатного плана.
async function cached(req, env, ctx, url, ttl, producer) {
  const cache = caches.default;
  const key = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return json(env, req, await hit.json(), 200, { 'x-cache': 'HIT' });
  const data = await producer();
  const stored = new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` }
  });
  ctx.waitUntil(cache.put(key, stored));
  return json(env, req, data, 200, { 'x-cache': 'MISS', 'cache-control': `public, max-age=${ttl}` });
}

// ---------- админка ----------

async function handleAdmin(req, env, url, path) {
  const db = env.DB;

  if (req.method === 'GET' && path === '/api/admin/overview') {
    await ensureSources(env);
    const sources = (await db.prepare('SELECT * FROM sources ORDER BY id').all()).results || [];
    const byStatus = (await db.prepare('SELECT status, COUNT(*) AS n FROM events GROUP BY status').all()).results || [];
    const bySource = (await db.prepare('SELECT source, COUNT(*) AS n FROM events GROUP BY source').all()).results || [];
    const errors = (await db.prepare('SELECT * FROM error_log ORDER BY id DESC LIMIT 30').all()).results || [];
    const geo = await db.prepare('SELECT COUNT(*) AS n FROM geocode_cache WHERE found = 1').first();
    return { generated_at: ISO(Date.now()), sources, events_by_status: byStatus, events_by_source: bySource, errors, geocode_cached: geo ? geo.n : 0 };
  }

  if (req.method === 'GET' && path === '/api/admin/events') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 100, 1), 500);
    const offset = Math.max(parseInt(url.searchParams.get('offset'), 10) || 0, 0);
    const where = [], binds = [];
    const st = url.searchParams.get('status');
    if (st && STATUSES.includes(st)) { where.push('status = ?'); binds.push(st); }
    const src = url.searchParams.get('source');
    if (src && /^[a-z]+$/.test(src)) { where.push('source = ?'); binds.push(src); }
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    const rows = (await db.prepare(sql).bind(...binds, limit, offset).all()).results || [];
    return { count: rows.length, events: rows };
  }

  let m = path.match(/^\/api\/admin\/events\/([a-z]+:[0-9a-f]{16})$/);
  if (m && req.method === 'DELETE') {
    const id = m[1];
    await db.batch([
      db.prepare('INSERT OR REPLACE INTO suppressed (id, ts) VALUES (?, ?)').bind(id, ISO(Date.now())),
      db.prepare('DELETE FROM events WHERE id = ?').bind(id)
    ]);
    return { deleted: id };
  }

  m = path.match(/^\/api\/admin\/sources\/([a-z]+)\/(run|toggle|probe)$/);
  if (m) {
    const [, id, action] = m;
    if (!SOURCES[id]) return { __status: 404, error: 'unknown source' };
    if (action === 'run' && req.method === 'POST') return runSource(env, id, { manual: true });
    if (action === 'toggle' && req.method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch { /* пусто */ }
      await ensureSources(env);
      await db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').bind(body.enabled ? 1 : 0, id).run();
      return { id, enabled: !!body.enabled };
    }
    if (action === 'probe' && req.method === 'GET') {
      try {
        const ctx = { env, now: Date.now(), geoBudget: 0, lastGeoAt: 0, log: () => {} };
        return await SOURCES[id].probe(ctx);
      } catch (e) { return { __status: 502, error: e.message }; }
    }
  }
  return { __status: 404, error: 'not found' };
}

// ---------- точка входа ----------

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...corsHeaders(env, req), ...SECURITY_HEADERS } });

    try {
      if (path === '/' || path === '/api/health') {
        return json(env, req, { ok: true, service: 'wuppertal-live-api', time: ISO(Date.now()) });
      }

      if (req.method === 'GET' && path === '/api/events') {
        if (rateLimited(`pub:${clientIp(req)}`, 240, 60_000)) return json(env, req, { error: 'rate_limited' }, 429, { 'retry-after': '30' });
        return await cached(req, env, ctx, url, 30, () => handleEvents(req, env, url));
      }

      if (req.method === 'GET' && path === '/api/status') {
        if (rateLimited(`pub:${clientIp(req)}`, 240, 60_000)) return json(env, req, { error: 'rate_limited' }, 429, { 'retry-after': '30' });
        return await cached(req, env, ctx, url, 20, () => handleStatus(env));
      }

      if (path.startsWith('/api/admin/')) {
        const ip = clientIp(req);
        if (rateLimited(`admin:${ip}`, 120, 60_000)) return json(env, req, { error: 'rate_limited' }, 429);
        if (!isAdmin(req, env)) {
          rateLimited(`adminfail:${ip}`, 10, 300_000); // учёт неудачных попыток
          const blocked = (buckets.get(`adminfail:${ip}`) || {}).n > 10;
          return json(env, req, { error: blocked ? 'too_many_attempts' : 'unauthorized' }, blocked ? 429 : 401);
        }
        const r = await handleAdmin(req, env, url, path);
        const status = r && r.__status ? r.__status : 200;
        if (r && r.__status) delete r.__status;
        return json(env, req, r, status, { 'cache-control': 'no-store' });
      }

      return json(env, req, { error: 'not_found' }, 404);
    } catch (e) {
      console.error('request failed:', e && e.message);
      return json(env, req, { error: 'internal_error' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env, event.cron));
  }
};
