// Минимальный эмулятор интерфейса D1 поверх node:sqlite — только для локальных тестов.
import { DatabaseSync } from 'node:sqlite';

export function makeDB(schemaSql) {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  const wrap = (sql, args = []) => ({
    _sql: sql, _args: args,
    bind: (...a) => wrap(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
    run: async () => { db.prepare(sql).run(...args); return { success: true }; }
  });
  return {
    prepare: (sql) => wrap(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try { for (const s of stmts) db.prepare(s._sql).run(...s._args); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      return stmts.map(() => ({ success: true }));
    },
    raw: db
  };
}
