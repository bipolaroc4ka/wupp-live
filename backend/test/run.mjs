// Автотесты backend: без сети и без Cloudflare. Запуск: node test/run.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDB } from './d1shim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, '..', 'schema.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log('  ok  ', name); } else { failed++; console.log('  FAIL', name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}${JSON.stringify(a) === JSON.stringify(b) ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);

// ---- окружение Workers ----
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const calls = [];
let routes = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  calls.push(u);
  for (const r of routes) {
    if (r.match.test(u)) {
      const v = typeof r.reply === 'function' ? r.reply(u) : r.reply;
      if (v instanceof Error) throw v;
      if (typeof v === 'number') return new Response('err', { status: v });
      return new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }
  return new Response('not mocked: ' + u, { status: 404 });
};
const setRoutes = (r) => { routes = r; calls.length = 0; };

const { parseEventTime, berlinToUtc } = await import('../src/time.js');
const { extractStreet } = await import('../src/geo.js');
const { runSource, ensureSources } = await import('../src/cron.js');
const api = (await import('../src/index.js')).default;

const newEnv = (extra = {}) => ({
  DB: makeDB(schema), NOMINATIM_CONTACT: 'test@example.org', PRESSEPORTAL_API_KEY: 'k',
  PRESSEPORTAL_OFFICE_IDS: '115885', PRESS_TTL_HOURS: '12', AUTOBAHN_ROADS: 'A46',
  ADMIN_TOKEN: 'x'.repeat(32), ALLOWED_ORIGINS: '*', ...extra
});
const rows = async (env, sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;

// ================= время =================
console.log('\n[time] разбор времени происшествия');
{
  const pub = Date.parse('2026-09-28T01:23:00+02:00'); // понедельник
  let r = parseEventTime('Am Sonntagabend gegen 22:55 Uhr brannte es', pub);
  eq([r.precision, new Date(r.ms).toISOString()], ['minute', '2026-09-27T20:55:00.000Z'], 'Sonntag 22:55 -> предыдущее воскресенье (CEST)');
  r = parseEventTime('Gestern um 14:30 Uhr kam es zu einem Unfall', pub);
  eq([r.precision, new Date(r.ms).toISOString()], ['minute', '2026-09-27T12:30:00.000Z'], 'gestern 14:30');
  r = parseEventTime('Am 25.09.2026 gegen 8 Uhr', pub);
  eq([r.precision, new Date(r.ms).toISOString()], ['minute', '2026-09-25T06:00:00.000Z'], 'явная дата + "gegen 8 Uhr"');
  r = parseEventTime('Heute Nacht brannte ein Container', pub);
  eq(r.precision, 'day', 'heute без времени -> только день');
  r = parseEventTime('Feuerwehr löscht einen Brand an der Straße', pub);
  eq(r, { ms: null, precision: 'unknown' }, 'нет указаний -> unknown (время публикации не подставляется)');
  r = parseEventTime('Am 30.09.2026 um 10:00 Uhr', pub);
  eq(r.precision, 'unknown', 'будущая дата отклонена');
  r = parseEventTime('Um 9.10 Uhr wurde gemeldet', pub);
  eq(r.precision, 'unknown', '"9.10 Uhr" не принимается за дату 9 октября');
  const w = berlinToUtc(2026, 1, 15, 12, 0);
  eq(new Date(w).toISOString(), '2026-01-15T11:00:00.000Z', 'зима: UTC+1');
}

// ================= улицы =================
console.log('\n[geo] извлечение улицы');
eq(extractStreet('Brand in der Friedrich-Ebert-Straße 12 in Elberfeld'), 'Friedrich-Ebert-Straße', 'составное название без номера дома');
eq(extractStreet('Unfall auf der Autobahn A46'), null, 'Autobahn — не улица');
eq(extractStreet('Einsatz an der Hauptstraße'), null, 'слишком общее слово отклонено');
eq(extractStreet('Feuer an der Gathe in Elberfeld'), null, 'без суффикса не угадываем');

// ================= Autobahn =================
console.log('\n[autobahn] источник, дубли, завершение');
{
  const env = newEnv();
  await ensureSources(env);
  const A = (extra) => ({
    roadworks: [
      { identifier: 'RW1', title: 'A46 | Wuppertal', subtitle: 'AS Wuppertal-Elberfeld', startTimestamp: '2026-11-01T06:00:00.000+01:00', isBlocked: 'false', future: false,
        coordinate: { lat: '51.2500', long: '7.1400' }, description: ['Baustelle', 'Fahrbahnverengung'] },
      { identifier: 'RW2', title: 'A46 | Düsseldorf', subtitle: 'AS Düsseldorf', startTimestamp: '2026-11-01T06:00:00.000+01:00', future: false, coordinate: { lat: '51.2200', long: '6.7700' }, description: [] },
      { identifier: 'RW3', title: 'A46 | geplant', subtitle: 'Wuppertal', startTimestamp: '2027-01-01T06:00:00.000+01:00', future: true, coordinate: { lat: '51.2500', long: '7.1400' }, description: [] }
    ],
    closure: [{ identifier: 'CL1', title: 'A46 | Sperrung', subtitle: 'Wuppertal-Barmen', startTimestamp: '2026-11-09T22:00:00.000+01:00', future: false, isBlocked: 'true', coordinate: { lat: '51.2700', long: '7.2000' }, description: ['Vollsperrung'] }],
    warning: [{ identifier: 'WA1', title: 'A46 | Stau', subtitle: 'Wuppertal', startTimestamp: '2026-11-10T08:00:00.000+01:00', future: false, coordinate: { lat: '51.2600', long: '7.1700' }, description: ['Stau 3 km'] }],
    ...extra
  });
  setRoutes([
    { match: /roadworks/, reply: () => ({ roadworks: cur.roadworks }) },
    { match: /closure/, reply: () => ({ closure: cur.closure }) },
    { match: /warning/, reply: () => cur.warningReply ?? ({ warning: cur.warning }) }
  ]);
  let cur = A();
  let r = await runSource(env, 'autobahn');
  ok(r.ok, 'запуск успешен');
  let ev = await rows(env, 'SELECT * FROM events ORDER BY source_event_id');
  eq(ev.map((e) => e.source_event_id), ['A46/closure/CL1', 'A46/roadworks/RW1', 'A46/warning/WA1'], 'только события в границах города, без будущих');
  const cl = ev.find((e) => e.source_event_id.includes('CL1'));
  eq([cl.category, cl.status, cl.geo_precision, cl.is_verified], ['road_closure', 'ACTIVE', 'source', 1], 'closure: категория/статус/точность');
  const wa = ev.find((e) => e.source_event_id.includes('WA1'));
  eq([wa.category, wa.status], ['road_jam', 'LIVE'], 'warning "Stau" -> road_jam / LIVE');
  eq([cl.published_at, cl.time_precision], [null, 'minute'], 'время публикации не выдумано, время начала от источника');

  const before = ev.map((e) => e.updated_at).join();
  await new Promise((s) => setTimeout(s, 15));
  r = await runSource(env, 'autobahn');
  eq(r.changes, 0, 'повторный запуск без изменений: 0 изменений');
  eq((await rows(env, 'SELECT COUNT(*) n FROM events'))[0].n, 3, 'дублей нет');
  eq((await rows(env, 'SELECT * FROM events ORDER BY source_event_id')).map((e) => e.updated_at).join(), before, 'updated_at не трогается без изменений');

  cur = A({ warning: [{ ...A().warning[0], description: ['Stau 6 km'] }] });
  r = await runSource(env, 'autobahn');
  eq(r.updated, 1, 'изменение описания обнаружено');
  ev = await rows(env, 'SELECT * FROM events WHERE source_event_id LIKE ?', '%WA1');
  ok(ev[0].description.includes('6 km'), 'описание обновлено');

  // событие пропало: 1-й раз — ждём, 2-й раз — RESOLVED
  cur = A({ closure: [] });
  await runSource(env, 'autobahn');
  eq((await rows(env, "SELECT status FROM events WHERE source_event_id LIKE '%CL1'"))[0].status, 'ACTIVE', 'после 1-го пропуска ещё ACTIVE');
  await runSource(env, 'autobahn');
  const res = (await rows(env, "SELECT status, status_reason FROM events WHERE source_event_id LIKE '%CL1'"))[0];
  eq([res.status, res.status_reason], ['RESOLVED', 'removed_from_source_feed'], 'после 2-го пропуска RESOLVED');

  // ошибка одного запроса не завершает события этой области
  cur = A({ warningReply: 500 });
  calls.length = 0;
  r = await runSource(env, 'autobahn');
  ok(r.ok && r.partial_failures === 1, 'частичный отказ засчитан, запуск не упал');
  eq((await rows(env, "SELECT status FROM events WHERE source_event_id LIKE '%WA1'"))[0].status, 'LIVE', 'при ошибке запроса warning события НЕ завершаются');
  const attempts = calls.filter((u) => /warning/.test(u)).length;
  eq(attempts, 3, 'повторные попытки при 500: 1 + 2 retry');

  // полный отказ
  setRoutes([{ match: /./, reply: 503 }]);
  r = await runSource(env, 'autobahn');
  ok(!r.ok, 'полный отказ -> ok:false');
  const src = (await rows(env, "SELECT * FROM sources WHERE id='autobahn'"))[0];
  ok(src.errors === 1 && src.last_error && src.last_success_at, 'ошибка записана, last_success_at сохранён');
  eq((await rows(env, 'SELECT COUNT(*) n FROM error_log'))[0].n, 1, 'запись в error_log');
}

// ================= NINA =================
console.log('\n[nina] официальные предупреждения');
{
  const env = newEnv();
  let dash = [
    { id: 'mow.DE-NW-W-SE-001', payload: { id: 'x', data: { headline: 'Gefahrenmeldung Chemieunfall', provider: 'MOWAS', severity: 'Severe', msgType: 'Alert' } }, i18nTitle: { de: 'Gefahrenmeldung Chemieunfall' }, sent: '2026-11-10T09:00:00+01:00' },
    { id: 'dwd.1', payload: { data: { headline: 'Amtliche WARNUNG vor STARKREGEN', provider: 'DWD', severity: 'Moderate', msgType: 'Alert' } }, i18nTitle: { de: 'Amtliche WARNUNG vor STARKREGEN' }, sent: '2026-11-10T09:10:00+01:00' },
    { id: 'bad', payload: {} }
  ];
  setRoutes([{ match: /dashboard/, reply: () => dash }]);
  let r = await runSource(env, 'nina');
  ok(r.ok, 'NINA запуск');
  const ev = await rows(env, 'SELECT * FROM events ORDER BY source_event_id');
  eq(ev.length, 2, 'запись без заголовка пропущена');
  const rain = ev.find((e) => e.category === 'heavy_rain');
  ok(rain && rain.geo_precision === 'city' && rain.latitude === null, 'Starkregen: на весь город, без выдуманных координат');
  eq([rain.status, rain.event_time, rain.published_at !== null], ['ACTIVE', null, true], 'время явления неизвестно, время публикации — от источника');
  dash = [dash[0]];
  await runSource(env, 'nina'); await runSource(env, 'nina');
  eq((await rows(env, "SELECT status FROM events WHERE category='heavy_rain'"))[0].status, 'RESOLVED', 'снятое предупреждение -> RESOLVED');
}

// ================= Presseportal =================
console.log('\n[presseportal] релизы, актуальность, геокодирование');
{
  const env = newEnv();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const story = (id, title, body, agoH) => ({ id, title, body, published: iso(agoH * 3600e3), url: `https://www.presseportal.de/blaulicht/pm/${id}` });
  const stories = [
    story(1, 'FW-W: Gestern um 14:30 Uhr Küchenbrand in der Friedrich-Ebert-Straße', 'Wuppertal (ots) - Gestern um 14:30 Uhr wurde ein Küchenbrand in der Friedrich-Ebert-Straße 12 gemeldet. Verletzt wurde niemand.', 2),
    story(2, 'FW-W: Brand in Wohnhaus', 'Wuppertal (ots) - Die Feuerwehr löschte einen Brand.', 3),
    story(3, 'FW-W: Alter Einsatz', 'Wuppertal (ots) - Am Sonntag brannte es in der Gathe-Straße.', 20),
    story(4, 'FW-W: Einsatz in Solingen', 'Solingen (ots) - Brand in Solingen.', 1)
  ];
  setRoutes([
    { match: /api\.presseportal\.de/, reply: () => ({ content: { story: stories } }) },
    { match: /nominatim/, reply: () => [{ lat: '51.2560', lon: '7.1480', category: 'highway', type: 'residential', address: { road: 'Friedrich-Ebert-Straße', suburb: 'Elberfeld' }, display_name: 'x' }] }
  ]);
  const r = await runSource(env, 'presseportal');
  ok(r.ok, 'запуск Presseportal');
  const ev = await rows(env, 'SELECT * FROM events ORDER BY source_event_id');
  eq(ev.length, 3, 'релиз из другого города отфильтрован');
  const e1 = ev.find((e) => e.source_event_id === '1');
  eq([e1.status, e1.category, e1.is_verified], ['RECENT', 'fire', 1], 'релиз = RECENT (не LIVE), категория fire');
  eq([e1.time_precision, e1.published_at !== null], ['minute', true], 'время из текста, отдельно от публикации');
  const evT = new Date(e1.event_time).getTime(), pubT = new Date(e1.published_at).getTime();
  ok(evT < pubT && e1.event_time !== e1.published_at, 'время происшествия ≠ время публикации');
  eq([e1.geo_precision, e1.district, e1.latitude !== null], ['street', 'Elberfeld', true], 'улица геокодирована, точность street');
  ok(!/\b12\b/.test(e1.location_name || ''), 'номер дома не сохранён');
  const e2 = ev.find((e) => e.source_event_id === '2');
  eq([e2.event_time, e2.time_precision, e2.geo_precision, e2.latitude], [null, 'unknown', 'none', null], 'нет улицы/времени -> ничего не выдумано');
  const e3 = ev.find((e) => e.source_event_id === '3');
  eq(e3.status, 'EXPIRED', 'релиз старше TTL сразу EXPIRED (не RECENT)');
  eq(calls.filter((u) => /nominatim/.test(u)).length, 1, 'геокодер вызван 1 раз (улица 2-го релиза не найдена по тексту)');

  await runSource(env, 'presseportal');
  eq(calls.filter((u) => /nominatim/.test(u)).length, 1, 'повторный запуск: геокодер из кэша, не вызывается');
  eq((await rows(env, 'SELECT COUNT(*) n FROM events'))[0].n, 3, 'дублей нет');

  // ключ не должен попадать в ошибки
  const env2 = newEnv({ PRESSEPORTAL_API_KEY: 'SECRETKEY123' });
  setRoutes([{ match: /presseportal/, reply: 500 }]);
  await runSource(env2, 'presseportal');
  const err = (await rows(env2, 'SELECT message FROM error_log'))[0].message;
  ok(!err.includes('SECRETKEY123'), 'API-ключ не попадает в логи ошибок');
  // отсутствие ключа
  const env3 = newEnv({ PRESSEPORTAL_API_KEY: undefined });
  const r3 = await runSource(env3, 'presseportal');
  ok(!r3.ok && /PRESSEPORTAL_API_KEY/.test(r3.error), 'без ключа — понятная ошибка, без падения');
}

// ================= API =================
console.log('\n[api] публичный и админский API');
{
  const env = newEnv();
  const now = Date.now();
  const mk = (id, over) => ({
    id, city_id: 'wuppertal', source: 'autobahn', source_event_id: id, title: 'T ' + id, category: 'roadworks', geo_precision: 'source',
    latitude: 51.25, longitude: 7.15, received_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), status: 'ACTIVE',
    confidence: 0.9, is_verified: 1, content_hash: 'h', geocode_attempts: 0, miss_count: 0, time_precision: 'unknown', ...over
  });
  const ins = async (e) => {
    const cols = Object.keys(e);
    await env.DB.prepare(`INSERT INTO events (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map((c) => e[c])).run();
  };
  await ins(mk('autobahn:aaaaaaaaaaaaaaaa'));
  await ins(mk('presseportal:bbbbbbbbbbbbbbbb', { source: 'presseportal', status: 'RECENT', geo_precision: 'district', latitude: 51.1, longitude: 7.1, published_at: new Date(now - 3600e3).toISOString() }));
  await ins(mk('autobahn:cccccccccccccccc', { status: 'RESOLVED' }));
  await ins(mk('presseportal:dddddddddddddddd', { source: 'presseportal', status: 'RECENT', published_at: new Date(now - 40 * 3600e3).toISOString(), event_time: null }));
  await ins(mk('presseportal:eeeeeeeeeeeeeeee', { source: 'presseportal', status: 'RECENT', published_at: new Date(now - 1000).toISOString(), expires_at: new Date(now - 5000).toISOString() }));

  const get = async (p, headers = {}) => api.fetch(new Request('https://x.test' + p, { headers }), env, { waitUntil() {} });
  let res = await get('/api/events?hours=24');
  let body = await res.json();
  const ids = body.events.map((e) => e.id).sort();
  eq(ids, ['autobahn:aaaaaaaaaaaaaaaa', 'presseportal:bbbbbbbbbbbbbbbb'], 'отдаются только действующие/недавние; RESOLVED, старые RECENT и просроченные скрыты');
  const district = body.events.find((e) => e.id.startsWith('presseportal'));
  eq([district.latitude, district.longitude], [null, null], 'для точности district координаты не отдаются');
  ok(!('content_hash' in body.events[0]) && !('miss_count' in body.events[0]), 'служебные поля не утекают');
  eq(res.headers.get('access-control-allow-origin'), '*', 'CORS');

  res = await get('/api/events?hours=24&history=1');
  body = await res.json();
  ok(body.events.some((e) => e.status === 'RESOLVED'), 'history=1 включает завершённые');

  res = await get("/api/events?categories=roadworks'; DROP TABLE events;--");
  eq(res.status, 200, 'SQL-инъекция в параметре не ломает запрос (параметры отфильтрованы/биндятся)');
  eq((await rows(env, 'SELECT COUNT(*) n FROM events'))[0].n, 5, 'таблица цела');

  res = await get('/api/admin/overview');
  eq(res.status, 401, 'админка без токена -> 401');
  res = await get('/api/admin/overview', { authorization: 'Bearer wrong' });
  eq(res.status, 401, 'неверный токен -> 401');
  const ADM = { authorization: 'Bearer ' + 'x'.repeat(32) };
  res = await get('/api/admin/overview', ADM);
  eq(res.status, 200, 'верный токен -> 200');
  const noTok = await api.fetch(new Request('https://x.test/api/admin/overview', { headers: ADM }), { ...env, ADMIN_TOKEN: 'short' }, { waitUntil() {} });
  eq(noTok.status, 401, 'слишком короткий ADMIN_TOKEN отклоняется');

  res = await api.fetch(new Request('https://x.test/api/admin/events/autobahn:aaaaaaaaaaaaaaaa', { method: 'DELETE', headers: ADM }), env, { waitUntil() {} });
  eq(res.status, 200, 'удаление события');
  eq((await rows(env, 'SELECT COUNT(*) n FROM suppressed'))[0].n, 1, 'удалённое запрещено к повторному добавлению');

  res = await get('/api/status');
  body = await res.json();
  ok(Array.isArray(body.sources) && body.sources.length === 3, '/api/status: три источника');
  ok(body.sources.every((s) => s.stale), 'источники без успешных запусков помечены stale');
  ok(!JSON.stringify(body).includes('last_error"'), 'публично нет текста ошибок');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
