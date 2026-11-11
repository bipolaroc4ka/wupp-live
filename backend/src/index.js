
// Wuppertal Live — HTTP API (публичное + админское) и обработчик cron.

import { CATEGORIES, STATUSES } from './config.js';
import { SOURCES, runScheduled, runSource, ensureSources } from './cron.js';
import { ISO } from './util.js';

// ---------- вспомогательное ----------

function allowedList(env) {
  return String(env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      if (x === '*') return x;

      try {
        return new URL(x).origin;
      } catch {
        return x.replace(/\/+$/, '');
      }
    });
}

function allowedOrigin(env, origin) {
  const list = allowedList(env);

  if (list.includes('*')) return '*';

  return origin && list.includes(origin) ? origin : null;
}

function corsHeaders(env, req) {
  const origin = allowedOrigin(env, req.headers.get('origin'));

  const headers = {
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '86400',
    vary: 'origin'
  };

  if (origin) {
    headers['access-control-allow-origin'] = origin;
  }

  return headers;
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};

function json(env, req, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
      ...corsHeaders(env, req),
      ...extra
    }
  });
}

// Ограничение частоты запросов в памяти изолята.
// Для дополнительной защиты рекомендуется Cloudflare WAF Rate Limiting.
const buckets = new Map();

function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.start > windowMs) {
    if (buckets.size > 5000) buckets.clear();

    buckets.set(key, {
      start: now,
      n: 1
    });

    return false;
  }

  bucket.n += 1;

  return bucket.n > limit;
}

function clientIp(req) {
  return req.headers.get('cf-connecting-ip') || 'unknown';
}

function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();

  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));

  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);

  for (let i = 0; i < len; i++) {
    diff |= (x[i] || 0) ^ (y[i] || 0);
  }

  return diff === 0;
}

function isAdmin(req, env) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 16) {
    return false;
  }

  const header = req.headers.get('authorization') || '';
  const match = header.match(/^Bearer (.+)$/);

  return !!match && timingSafeEqual(match[1], env.ADMIN_TOKEN);
}

function parseList(value, allowed) {
  if (!value) return null;

  const result = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => allowed.includes(item));

  return result.length ? result : null;
}

function intParam(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(Math.max(parsed, min), max);
}

// Публичное представление события.
// Координаты выдаются только при точности source/street.
function publicEvent(row) {
  const hasPoint =
    (row.geo_precision === 'source' || row.geo_precision === 'street') &&
    row.latitude != null &&
    row.longitude != null;

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    source: row.source,
    publisher: row.publisher,
    source_url: row.source_url,

    latitude: hasPoint ? row.latitude : null,
    longitude: hasPoint ? row.longitude : null,

    geo_precision: row.geo_precision,
    location_name: row.location_name,
    district: row.district,

    event_time: row.event_time,
    time_precision: row.time_precision,
    published_at: row.published_at,
    received_at: row.received_at,
    updated_at: row.updated_at,

    status: row.status,
    status_reason: row.status_reason,
    confidence: row.confidence,
    is_verified: !!row.is_verified,
    expires_at: row.expires_at,
    severity: row.severity
  };
}

// ---------- публичные эндпоинты ----------

async function handleEvents(req, env, url) {
  const now = Date.now();

  const hours = Math.min(
    Math.max(Number.parseFloat(url.searchParams.get('hours')) || 24, 1),
    24 * 30
  );

  const history = url.searchParams.get('history') === '1';

  const limit = intParam(
    url.searchParams.get('limit'),
    300,
    1,
    500
  );

  const categories = parseList(
    url.searchParams.get('categories'),
    CATEGORIES
  );

  const sources = (url.searchParams.get('sources') || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^[a-z]+$/.test(item));

  const since = ISO(now - hours * 3600e3);
  const nowIso = ISO(now);

  const where = [];
  const binds = [];

  if (history) {
    where.push("status IN ('LIVE','ACTIVE','RECENT','EXPIRED','RESOLVED')");
  } else {
    where.push("status IN ('LIVE','ACTIVE','RECENT')");
    where.push('(expires_at IS NULL OR expires_at > ?)');
    binds.push(nowIso);
  }

  // Действующие события не ограничиваются датой.
  where.push(
    "(status IN ('LIVE','ACTIVE') OR COALESCE(event_time, published_at, received_at) >= ?)"
  );

  binds.push(since);

  if (categories) {
    where.push(
      `category IN (${categories.map(() => '?').join(',')})`
    );

    binds.push(...categories);
  }

  if (sources.length) {
    where.push(
      `source IN (${sources.map(() => '?').join(',')})`
    );

    binds.push(...sources);
  }

  const bbox = (url.searchParams.get('bbox') || '')
    .split(',')
    .map(Number.parseFloat);

  if (bbox.length === 4 && bbox.every(Number.isFinite)) {
    const [minLon, minLat, maxLon, maxLat] = bbox;

    if (
      minLon >= -180 &&
      maxLon <= 180 &&
      minLat >= -90 &&
      maxLat <= 90 &&
      minLon <= maxLon &&
      minLat <= maxLat
    ) {
      // События без координат не исключаются рамкой карты.
      where.push(
        '(latitude IS NULL OR (latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?))'
      );

      binds.push(minLat, maxLat, minLon, maxLon);
    }
  }

  const sql =
    `SELECT * FROM events WHERE ${where.join(' AND ')} ` +
    "ORDER BY CASE status " +
    "WHEN 'LIVE' THEN 0 " +
    "WHEN 'ACTIVE' THEN 1 " +
    "WHEN 'RECENT' THEN 2 " +
    "ELSE 3 END, " +
    'COALESCE(event_time, published_at, received_at) DESC LIMIT ?';

  binds.push(limit);

  const rows = (
    await env.DB.prepare(sql).bind(...binds).all()
  ).results || [];

  return {
    generated_at: nowIso,
    count: rows.length,
    events: rows.map(publicEvent)
  };
}

async function handleStatus(env) {
  await ensureSources(env);

  const now = Date.now();

  const rows = (
    await env.DB.prepare(
      'SELECT * FROM sources ORDER BY id'
    ).all()
  ).results || [];

  return {
    generated_at: ISO(now),

    sources: rows.map((source) => {
      const last = source.last_success_at
        ? Date.parse(source.last_success_at)
        : null;

      const stale =
        !source.enabled ||
        last == null ||
        now - last > source.interval_sec * 3 * 1000;

      return {
        id: source.id,
        name: source.name,
        enabled: !!source.enabled,
        interval_sec: source.interval_sec,
        last_success_at: source.last_success_at,
        stale,
        has_error: !!source.last_error
      };
    })
  };
}

// Публичный Cache API.
async function cached(req, env, ctx, url, ttl, producer) {
  const cache = caches.default;
  const key = new Request(url.toString(), {
    method: 'GET'
  });

  const hit = await cache.match(key);

  if (hit) {
    return json(
      env,
      req,
      await hit.json(),
      200,
      { 'x-cache': 'HIT' }
    );
  }

  const data = await producer();

  const stored = new Response(
    JSON.stringify(data),
    {
      headers: {
        'content-type': 'application/json',
        'cache-control': `public, max-age=${ttl}`
      }
    }
  );

  ctx.waitUntil(cache.put(key, stored));

  return json(
    env,
    req,
    data,
    200,
    {
      'x-cache': 'MISS',
      'cache-control': `public, max-age=${ttl}`
    }
  );
}

// ---------- административная статистика ----------

async function handleOverview(env) {
  await ensureSources(env);

  const db = env.DB;

  const [
    sourcesResult,
    statusResult,
    sourceResult,
    categoryResult,
    geoResult,
    totalResult,
    coordinateResult,
    suppressedResult,
    geocodeResult,
    errorResult
  ] = await Promise.all([
    db.prepare(
      'SELECT * FROM sources ORDER BY id'
    ).all(),

    db.prepare(
      'SELECT status, COUNT(*) AS n FROM events GROUP BY status ORDER BY status'
    ).all(),

    db.prepare(
      'SELECT source, COUNT(*) AS n FROM events GROUP BY source ORDER BY source'
    ).all(),

    db.prepare(
      'SELECT category, COUNT(*) AS n FROM events GROUP BY category ORDER BY n DESC'
    ).all(),

    db.prepare(
      'SELECT geo_precision, COUNT(*) AS n FROM events GROUP BY geo_precision ORDER BY geo_precision'
    ).all(),

    db.prepare(
      'SELECT COUNT(*) AS n FROM events'
    ).first(),

    db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE
           WHEN latitude IS NOT NULL AND longitude IS NOT NULL
           THEN 1 ELSE 0
         END) AS with_coordinates,
         SUM(CASE
           WHEN latitude IS NULL OR longitude IS NULL
           THEN 1 ELSE 0
         END) AS without_coordinates
       FROM events`
    ).first(),

    db.prepare(
      'SELECT COUNT(*) AS n FROM suppressed'
    ).first(),

    db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN found = 1 THEN 1 ELSE 0 END) AS found,
         SUM(CASE WHEN found = 0 THEN 1 ELSE 0 END) AS not_found
       FROM geocode_cache`
    ).first(),

    db.prepare(
      'SELECT * FROM error_log ORDER BY id DESC LIMIT 30'
    ).all()
  ]);

  return {
    generated_at: ISO(Date.now()),

    sources: sourcesResult.results || [],

    events_total: totalResult?.n || 0,

    events_by_status: statusResult.results || [],
    events_by_source: sourceResult.results || [],
    events_by_category: categoryResult.results || [],
    events_by_geo_precision: geoResult.results || [],

    coordinates: {
      total: coordinateResult?.total || 0,
      with_coordinates: coordinateResult?.with_coordinates || 0,
      without_coordinates: coordinateResult?.without_coordinates || 0
    },

    suppressed_total: suppressedResult?.n || 0,

    geocode: {
      total: geocodeResult?.total || 0,
      found: geocodeResult?.found || 0,
      not_found: geocodeResult?.not_found || 0
    },

    // Сохраняем старое поле для совместимости.
    geocode_cached: geocodeResult?.found || 0,

    errors: errorResult.results || []
  };
}

// ---------- административный список событий ----------

async function handleAdminEvents(env, url) {
  const db = env.DB;

  const limit = intParam(
    url.searchParams.get('limit'),
    100,
    1,
    500
  );

  const offset = intParam(
    url.searchParams.get('offset'),
    0,
    0,
    1000000
  );

  const where = [];
  const binds = [];

  const status = url.searchParams.get('status');

  if (status && STATUSES.includes(status)) {
    where.push('status = ?');
    binds.push(status);
  }

  const source = url.searchParams.get('source');

  if (source && /^[a-z]+$/.test(source)) {
    where.push('source = ?');
    binds.push(source);
  }

  const category = url.searchParams.get('category');

  if (category && CATEGORIES.includes(category)) {
    where.push('category = ?');
    binds.push(category);
  }

  const geoPrecision = url.searchParams.get('geo_precision');

  const allowedGeoPrecisions = [
    'source',
    'street',
    'district',
    'city',
    'none'
  ];

  if (geoPrecision && allowedGeoPrecisions.includes(geoPrecision)) {
    where.push('geo_precision = ?');
    binds.push(geoPrecision);
  }

  const query = String(url.searchParams.get('q') || '')
    .trim()
    .slice(0, 120);

  if (query) {
    const pattern = `%${query}%`;

    where.push(`(
      title LIKE ?
      OR description LIKE ?
      OR location_name LIKE ?
      OR district LIKE ?
      OR publisher LIKE ?
      OR source_event_id LIKE ?
    )`);

    binds.push(
      pattern,
      pattern,
      pattern,
      pattern,
      pattern,
      pattern
    );
  }

  const whereSql = where.length
    ? 'WHERE ' + where.join(' AND ')
    : '';

  const countResult = await db.prepare(
    `SELECT COUNT(*) AS n FROM events ${whereSql}`
  ).bind(...binds).first();

  const rows = (
    await db.prepare(
      `SELECT *
       FROM events
       ${whereSql}
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all()
  ).results || [];

  const total = countResult?.n || 0;

  return {
    count: rows.length,
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
    events: rows
  };
}

// ---------- административный список подавленных событий ----------

async function handleSuppressed(env, url) {
  const limit = intParam(
    url.searchParams.get('limit'),
    100,
    1,
    500
  );

  const offset = intParam(
    url.searchParams.get('offset'),
    0,
    0,
    1000000
  );

  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM suppressed'
  ).first();

  const rows = (
    await env.DB.prepare(
      `SELECT id, ts
       FROM suppressed
       ORDER BY ts DESC
       LIMIT ? OFFSET ?`
    ).bind(limit, offset).all()
  ).results || [];

  const total = count?.n || 0;

  return {
    count: rows.length,
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
    items: rows
  };
}

// ---------- административные маршруты ----------

async function handleAdmin(req, env, url, path) {
  const db = env.DB;

  // Общая статистика.
  if (
    req.method === 'GET' &&
    path === '/api/admin/overview'
  ) {
    return handleOverview(env);
  }

  // Список событий с фильтрами и поиском.
  if (
    req.method === 'GET' &&
    path === '/api/admin/events'
  ) {
    return handleAdminEvents(env, url);
  }

  // Список подавленных событий.
  if (
    req.method === 'GET' &&
    path === '/api/admin/suppressed'
  ) {
    return handleSuppressed(env, url);
  }

  // Удаление события с добавлением ID в suppressed.
  let match = path.match(
    /^\/api\/admin\/events\/([a-z]+:[0-9a-f]{16})$/
  );

  if (match && req.method === 'DELETE') {
    const id = match[1];

    await db.batch([
      db.prepare(
        'INSERT OR REPLACE INTO suppressed (id, ts) VALUES (?, ?)'
      ).bind(id, ISO(Date.now())),

      db.prepare(
        'DELETE FROM events WHERE id = ?'
      ).bind(id)
    ]);

    return {
      deleted: id,
      suppressed: true
    };
  }

  // Снятие блокировки повторного добавления.
  // Само событие появится снова только после следующего запуска источника.
  match = path.match(
    /^\/api\/admin\/suppressed\/([a-z]+:[0-9a-f]{16})$/
  );

  if (match && req.method === 'DELETE') {
    const id = match[1];

    const result = await db.prepare(
      'DELETE FROM suppressed WHERE id = ?'
    ).bind(id).run();

    return {
      unsuppressed: id,
      changes: result.meta?.changes || 0,
      note: 'Для повторного получения события запустите соответствующий источник.'
    };
  }

  // Управление источниками.
  match = path.match(
    /^\/api\/admin\/sources\/([a-z]+)\/(run|toggle|probe)$/
  );

  if (match) {
    const [, id, action] = match;

    if (!SOURCES[id]) {
      return {
        __status: 404,
        error: 'unknown_source'
      };
    }

    if (action === 'run' && req.method === 'POST') {
      return runSource(env, id, {
        manual: true
      });
    }

    if (action === 'toggle' && req.method === 'POST') {
      let body = {};

      try {
        body = await req.json();
      } catch {
        body = {};
      }

      if (typeof body.enabled !== 'boolean') {
        return {
          __status: 400,
          error: 'enabled_must_be_boolean'
        };
      }

      await ensureSources(env);

      await db.prepare(
        'UPDATE sources SET enabled = ? WHERE id = ?'
      ).bind(
        body.enabled ? 1 : 0,
        id
      ).run();

      return {
        id,
        enabled: body.enabled
      };
    }

    if (action === 'probe' && req.method === 'GET') {
      try {
        const ctx = {
          env,
          now: Date.now(),
          geoBudget: 0,
          lastGeoAt: 0,
          logs: [],
          log: () => {}
        };

        return await SOURCES[id].probe(ctx);
      } catch (error) {
        return {
          __status: 502,
          error: error.message || String(error)
        };
      }
    }
  }

  return {
    __status: 404,
    error: 'not_found'
  };
}

// ---------- точка входа ----------

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(env, req),
          ...SECURITY_HEADERS
        }
      });
    }

    try {
      if (
        path === '/' ||
        path === '/api/health'
      ) {
        return json(env, req, {
          ok: true,
          service: 'wuppertal-live-api',
          time: ISO(Date.now())
        });
      }

      // Публичные события.
      if (
        req.method === 'GET' &&
        path === '/api/events'
      ) {
        if (rateLimited(`pub:${clientIp(req)}`, 240, 60000)) {
          return json(
            env,
            req,
            { error: 'rate_limited' },
            429,
            { 'retry-after': '30' }
          );
        }

        return await cached(
          req,
          env,
          ctx,
          url,
          30,
          () => handleEvents(req, env, url)
        );
      }

      // Публичный статус источников.
      if (
        req.method === 'GET' &&
        path === '/api/status'
      ) {
        if (rateLimited(`pub:${clientIp(req)}`, 240, 60000)) {
          return json(
            env,
            req,
            { error: 'rate_limited' },
            429,
            { 'retry-after': '30' }
          );
        }

        return await cached(
          req,
          env,
          ctx,
          url,
          20,
          () => handleStatus(env)
        );
      }

      // Административные маршруты.
      if (path.startsWith('/api/admin/')) {
        const ip = clientIp(req);

        if (rateLimited(`admin:${ip}`, 120, 60000)) {
          return json(
            env,
            req,
            { error: 'rate_limited' },
            429
          );
        }

        if (!isAdmin(req, env)) {
          rateLimited(`adminfail:${ip}`, 10, 300000);

          const blocked =
            (buckets.get(`adminfail:${ip}`) || {}).n > 10;

          return json(
            env,
            req,
            {
              error: blocked
                ? 'too_many_attempts'
                : 'unauthorized'
            },
            blocked ? 429 : 401
          );
        }

        const result = await handleAdmin(
          req,
          env,
          url,
          path
        );

        const status =
          result && result.__status
            ? result.__status
            : 200;

        if (result && result.__status) {
          delete result.__status;
        }

        return json(
          env,
          req,
          result,
          status,
          { 'cache-control': 'no-store' }
        );
      }

      return json(
        env,
        req,
        { error: 'not_found' },
        404
      );
    } catch (error) {
      console.error(
        'request failed:',
        error && error.message
      );

      return json(
        env,
        req,
        { error: 'internal_error' },
        500
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runScheduled(env, event.cron)
    );
  }
};
