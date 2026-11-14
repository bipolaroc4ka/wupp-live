
// Планировщик: запуск источников, учёт состояния, служебные задачи.

import * as autobahn from './sources/autobahn.js';
import * as nina from './sources/nina.js';
import * as presseportal from './sources/presseportal.js';
import * as wuppertal from './sources/wuppertal.js';
import * as mobidrom from './sources/mobidrom.js';

import { sweepExpired, cleanupOld } from './events.js';
import { geocodeStreet } from './geo.js';
import { translatePending } from './translate.js';
import { ISO, truncate } from './util.js';

// Все источники, доступные планировщику.
export const SOURCES = {
  autobahn,
  nina,
  presseportal,
  wuppertal,
  mobidrom
};

// Должно совпадать с [triggers].crons в wrangler.toml.
export const CRON_MAP = {
  '*/2 * * * *': ['autobahn'],
  '*/5 * * * *': ['nina'],
  '*/10 * * * *': [
    'presseportal',
    'wuppertal',
    'mobidrom',
    '__maintenance'
  ]
};

export function makeCtx(env) {
  const logs = [];

  return {
    env,
    now: Date.now(),
    geoBudget: 3,
    lastGeoAt: 0,
    logs,
    log: (m) => {
      logs.push(String(m));
      console.log(m);
    }
  };
}

// Создание записей источников в D1, если их ещё нет.
export async function ensureSources(env) {
  const stmts = Object.values(SOURCES).map(({ meta }) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO sources (id, name, enabled, interval_sec) VALUES (?, ?, 1, ?)'
    ).bind(meta.id, meta.name, meta.intervalSec)
  );

  await env.DB.batch(stmts);
}

async function logError(env, source, message) {
  try {
    await env.DB.prepare(
      'INSERT INTO error_log (ts, source, message) VALUES (?, ?, ?)'
    )
      .bind(ISO(Date.now()), source, truncate(message, 500))
      .run();
  } catch {
    // Логирование не должно ронять задачу.
  }
}

// Запуск отдельного источника с учётом его состояния.
export async function runSource(env, id, { manual = false } = {}) {
  const mod = SOURCES[id];

  if (!mod) {
    throw new Error(`unknown source: ${id}`);
  }

  await ensureSources(env);

  const row = await env.DB.prepare(
    'SELECT * FROM sources WHERE id = ?'
  ).bind(id).first();

  if (row && !row.enabled && !manual) {
    return { skipped: 'disabled' };
  }

  const ctx = makeCtx(env);
  const startIso = ISO(ctx.now);

  try {
    const r = await mod.run(ctx);

    await env.DB.prepare(
      `UPDATE sources
       SET last_run_at = ?,
           last_success_at = ?,
           last_error = NULL,
           runs = runs + 1,
           last_fetched = ?,
           last_changes = ?
       WHERE id = ?`
    )
      .bind(
        startIso,
        startIso,
        r.fetched ?? 0,
        r.changes ?? 0,
        id
      )
      .run();

    return { ok: true, ...r };

  } catch (e) {
    const msg = (e && e.message) || String(e);

    console.error(`[${id}] ${msg}`);

    await env.DB.prepare(
      `UPDATE sources
       SET last_run_at = ?,
           last_error = ?,
           last_error_at = ?,
           runs = runs + 1,
           errors = errors + 1
       WHERE id = ?`
    )
      .bind(
        startIso,
        truncate(msg, 300),
        startIso,
        id
      )
      .run();

    await logError(env, id, msg);

    return { ok: false, error: msg };
  }
}

// Повторная попытка геокодирования для релизов,
// у которых не хватило бюджета запросов.
async function retryGeocoding(env) {
  const ctx = makeCtx(env);

  const rows = (
    await env.DB.prepare(
      `SELECT id, location_name, geocode_attempts
       FROM events
       WHERE source = 'presseportal'
         AND status IN ('LIVE','ACTIVE','RECENT')
         AND geo_precision = 'none'
         AND location_name IS NOT NULL
         AND geocode_attempts < 3
       ORDER BY published_at DESC
       LIMIT 3`
    ).all()
  ).results || [];

  for (const r of rows) {
    try {
      const g = await geocodeStreet(ctx, r.location_name);

      if (g && g.pending) {
        break;
      }

      if (!g) {
        await env.DB.prepare(
          'UPDATE events SET geocode_attempts = geocode_attempts + 1 WHERE id = ?'
        ).bind(r.id).run();

      } else if (g.precision === 'street') {
        await env.DB.prepare(
          `UPDATE events
           SET latitude = ?,
               longitude = ?,
               geo_precision = 'street',
               district = ?,
               confidence = 0.6,
               updated_at = ?
           WHERE id = ?`
        )
          .bind(
            g.lat,
            g.lon,
            g.district,
            ISO(Date.now()),
            r.id
          )
          .run();

      } else {
        await env.DB.prepare(
          `UPDATE events
           SET geo_precision = 'district',
               district = ?,
               confidence = 0.6,
               updated_at = ?
           WHERE id = ?`
        )
          .bind(
            g.district,
            ISO(Date.now()),
            r.id
          )
          .run();
      }

    } catch (e) {
      await logError(env, 'geocoder', e.message);
      break;
    }
  }
}

// Служебные задачи.
async function maintenance(env) {
  const ctx = makeCtx(env);

  await sweepExpired(ctx);
  await retryGeocoding(env);

  try {
    const tr = await translatePending(env);

    if (tr.error) {
      await logError(env, 'translate', tr.error);
    }
  } catch (e) {
    await logError(env, 'translate', e.message);
  }

  await cleanupOld(ctx);
}

// Обработка Cron-события.
export async function runScheduled(env, cronExpr) {
  const ids = CRON_MAP[cronExpr] || [];

  for (const id of ids) {
    if (id === '__maintenance') {
      try {
        await maintenance(env);
      } catch (e) {
        await logError(env, 'maintenance', e.message);
      }

    } else {
      await runSource(env, id);

      // Сразу после запуска источника переводим
      // просроченные записи в EXPIRED.
      try {
        await sweepExpired(makeCtx(env));
      } catch (e) {
        await logError(env, 'maintenance', e.message);
      }
    }
  }
}
