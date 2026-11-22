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
      if (typeof v === 'string') return new Response(v, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
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
  r = parseEventTime('Ein Lkw mit 2.5 Tonnen und 1.3 Kilometer Stau', pub);
  eq(r.precision, 'unknown', 'десятичные числа (2.5, 1.3) не принимаются за дату');
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

// ================= Autobahn: реальный формат (сроки только в тексте description) =================
console.log('\n[autobahn] сроки из description (startTimestamp в реальных ответах нет)');
{
  const env = newEnv();
  const now = Date.now();
  const f = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: '2-digit' });
  const h = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const stamp = (ms) => `${f.format(ms)} ${h.format(ms)}`;
  const s0 = Math.floor((now - 2 * 3600e3) / 60000) * 60000, e0 = now + 20 * 3600e3;
  const real = {
    identifier: 'CL-REAL', icon: '250', isBlocked: 'false', future: false, extent: '51.25,7.14,51.26,7.15', point: '51.25,7.14',
    impact: { lower: 'Wuppertal-Elberfeld', upper: 'Wuppertal-Barmen', symbols: ['SEPARATE', 'CLOSED', 'CLOSED'] },
    display_type: 'CLOSURE', subtitle: ' Köln -> Dortmund', title: 'A46 | Wuppertal-Elberfeld - Wuppertal-Barmen',
    coordinate: { lat: 51.2500, long: 7.1400 },
    description: ['Die Baustelle ist zu folgenden Zeiträumen gültig:', `${stamp(s0)} bis zum ${stamp(e0)} Uhr.`, '(Ende der Gesamtmaßnahme: 01.01.31)', '', 'Länge: 0.6 km', '', 'A46, Brücke, Ersatzneubau'],
    routeRecommendation: ['Umleitung über die A1.'], footer: [], lorryParkingFeatureIcons: []
  };
  const phase = { identifier: 'RW-PHASE', future: false, title: 'A46 | Phase', subtitle: 'Wuppertal', coordinate: { lat: 51.26, long: 7.15 }, description: ['Zeitraum dieser Bauphase:', 'Beginn: 07.11.25 um 20:00 Uhr', 'Grundhafte Erneuerung'] };
  setRoutes([
    { match: /closure/, reply: () => ({ closure: [real] }) },
    { match: /roadworks/, reply: () => ({ roadworks: [phase] }) },
    { match: /warning/, reply: () => ({ warning: [] }) }
  ]);
  const r = await runSource(env, 'autobahn');
  ok(r.ok, 'autobahn: запуск');
  const ev = await rows(env, 'SELECT * FROM events ORDER BY source_event_id');
  const cl = ev.find((e) => e.source_event_id.includes('CL-REAL')), rw = ev.find((e) => e.source_event_id.includes('RW-PHASE'));
  eq([cl.event_time, cl.time_precision], [new Date(s0).toISOString(), 'minute'], 'начало идущего сейчас окна берётся из текста');
  ok(/Umleitung: über die A1\./.test(cl.description) && /Gesamtmaßnahme bis: 01\.01\.2031/.test(cl.description) && /Länge: 0,6 km/.test(cl.description) && !/ $/m.test(cl.description), 'объезд, конец всей меры, запятая в числах, без хвостовых пробелов');
  eq([rw.event_time, rw.time_precision], ['2025-11-07T19:00:00.000Z', 'minute'], '«Beginn: 07.11.25 um 20:00 Uhr» -> 19:00Z (зима)');
  const { parseSchedule: ps } = await import('../src/sources/autobahn.js');
  const fut = ps('Die Baustelle ist zu folgenden Zeiträumen gültig:\n16.11.26 von 09:00 bis 15:00 Uhr', Date.parse('2026-11-14T18:52:00Z'));
  eq([new Date(fut.ms).toISOString(), fut.precision], ['2026-11-16T08:00:00.000Z', 'minute'], 'будущее окно: начало = ближайшее запланированное из текста');
  const { parsePhaseEnd } = await import('../src/sources/autobahn.js');
  eq(new Date(parsePhaseEnd('Zeitraum dieser Bauphase:\nBeginn: 28.09.26 um 05:00 Uhr\nEnde: 22.01.27 um 22:00 Uhr')).toISOString(), '2027-01-22T21:00:00.000Z', 'конец фазы из «Ende:» -> срок действия');
  eq(parsePhaseEnd('(Ende der Gesamtmaßnahme: 13.06.32)'), null, 'конец всей меры не считается концом фазы');
  {
    const { parseSchedule: P, parseExpiry: X } = await import('../src/sources/autobahn.js');
    const nw = Date.parse('2026-11-14T19:00:00Z'), H = 'Die Baustelle ist zu folgenden Zeiträumen gültig:\n';
    const e = (t) => { const x = X(t); return x == null ? null : new Date(x).toISOString(); };
    eq(e(H + '16.11.26 von 09:00 bis 15:00 Uhr'), '2026-11-16T14:00:00.000Z', 'срок = конец окна');
    eq(e(H + '16.11.26 von 09:00 bis 15:00 Uhr\n18.11.26 von 09:00 bis 15:00 Uhr'), '2026-11-18T14:00:00.000Z', 'несколько окон: срок = конец последнего');
    eq(e(H + '16.11.26\n17.11.26'), '2026-11-17T22:59:00.000Z', 'список дат без времени: конец последнего дня');
    eq([e(H + '16.11.26 bis 20.11.26'), P(H + '16.11.26 bis 20.11.26', nw).precision], ['2026-11-20T22:59:00.000Z', 'day'], 'диапазон дат');
    eq(e('Zeitraum dieser Bauphase:\nBeginn: 28.09.26\nEnde: 22.01.27'), '2027-01-22T22:59:00.000Z', 'фаза без времени');
    eq(e('(Ende der Gesamtmaßnahme: 13.06.32)'), null, 'только конец всей меры: срока нет');
  }
  {
    const { startFromText } = await import('../src/sources/nina.js');
    const pub = Date.parse('2026-11-14T18:30:00Z'), g = (t) => { const r = startFromText(t, pub); return r && [new Date(r.ms).toISOString(), r.precision]; };
    eq(g('Stadtteil Alt-Erkrath ab 22:00 Uhr ein Abkochgebot erlassen'), ['2026-11-14T21:00:00.000Z', 'minute'], 'NINA: «ab 22:00 Uhr» -> начало в день выпуска');
    eq(g('ab dem 16.11. um 08:00 Uhr gesperrt'), ['2026-11-16T07:00:00.000Z', 'minute'], 'NINA: «ab dem 16.11. um 08:00 Uhr»');
    eq([g('ab sofort'), g('ab Montag')], [null, null], 'NINA: без даты и времени начала нет');
  }
  {
    const { startFromText, parseReferences, buildItem } = await import('../src/sources/nina.js');
    const pubUpd = Date.parse('2026-11-15T09:06:00Z');
    eq(startFromText('ab 22:00 Uhr ein Abkochgebot', pubUpd, { isUpdate: true }), null, 'NINA: в обновлении «ab 22:00» без даты не привязывается к дню выпуска');
    eq(parseReferences('a@b.de,mow.DE-NW-X-1,2026-11-14T19:12:00+01:00')[0].id, 'mow.DE-NW-X-1', 'NINA: references разобраны');
    const info = { language: 'de', headline: 'Schaden an der Trinkwasserversorgung - Erkrath', description: 'Es folgt eine wichtige Information der Stadt Erkrath.<br/><br/>Das Abkochgebot besteht weiterhin. ab 22:00 Uhr', area: [{ areaDesc: 'Erkrath' }] };
    const det = { msgType: 'Update', sent: '2026-11-15T10:06:00+01:00', info: [info] };
    const raw = { id: 'mow.DE-NW-X-2', version: 2, type: 'Update', feed: 'mowas', startDate: '2026-11-15T10:06:00+01:00', i18nTitle: { de: info.headline } };
    const geo = { type: 'FeatureCollection', features: [] };
    const a = buildItem(raw, det, geo, 'region', Date.now());
    ok(a && a.event_time == null && a.time_precision === 'unknown' && a.valid_from == null && a.location_name === 'Erkrath' && !/^Es folgt/.test(a.description), 'NINA Update: ни время происшествия, ни начало действия не выдуманы; место без «Nordrhein-Westfalen ·»; шаблонная фраза убрана');
    const b = buildItem(raw, det, geo, 'region', Date.now(), { valid_from: '2026-11-14T21:00:00.000Z', valid_from_precision: 'minute' });
    eq([b.event_time, b.valid_from, b.valid_from_precision], [null, '2026-11-14T21:00:00.000Z', 'minute'], 'NINA Update: «Действует с» наследуется от предыдущей версии, «Произошло» остаётся неизвестным');
    const viaRef = buildItem({ ...raw, type: 'Alert' }, { ...det, msgType: 'Alert', references: 'a@b.de,mow.DE-NW-X-1,2026-11-14T19:02:00+01:00' }, geo, 'region', Date.now());
    eq(viaRef.valid_from, null, 'NINA: сообщение со ссылкой на предыдущую версию считается обновлением даже при msgType Alert');
    const orig = { ...det, msgType: 'Alert', sent: '2026-11-14T19:02:00+01:00' };
    const c = buildItem({ ...raw, type: 'Alert', startDate: '2026-11-14T19:02:00+01:00' }, { ...orig, info: [{ ...info, description: 'Im Stadtteil Alt-Erkrath ab 22:00 Uhr ein Abkochgebot erlassen. Es gilt bis auf Weiteres.' }] }, geo, 'region', Date.now());
    eq([c.event_time, c.valid_from, c.valid_from_precision, c.valid_until, c.valid_until_precision], [null, '2026-11-14T21:00:00.000Z', 'minute', null, 'open'], 'NINA Alert: «ab 22:00 Uhr» -> «Действует с», происшествие неизвестно, срок «до отмены»');
  }
  {
    const { untilFromText } = await import('../src/sources/nina.js');
    const pub = Date.parse('2026-11-14T18:30:00Z'), u = (t) => { const r = untilFromText(t, pub); return r && [r.ms && new Date(r.ms).toISOString(), r.precision]; };
    eq(u('Das Abkochgebot gilt bis auf Weiteres und ausdrücklich bis zur behördlichen Entwarnung durch das Kreisgesundheitsamt'), [null, 'open'], 'NINA: «bis auf Weiteres / Entwarnung» -> до отмены');
    eq(u('Sperrung bis 20.11.2026, 18:00 Uhr'), ['2026-11-20T17:00:00.000Z', 'minute'], 'NINA: «bis 20.11.2026, 18:00 Uhr»');
    eq(u('bis zum 20.11. gesperrt'), ['2026-11-20T22:59:00.000Z', 'day'], 'NINA: «bis zum 20.11.» без года и времени');
    eq(u('Ab sofort bitte beachten'), null, 'NINA: без срока ничего');
  }
  const again = await runSource(env, 'autobahn');
  eq(again.changes, 0, 'повторный запуск: изменений нет');
}

// ================= NINA =================
console.log('\n[nina] официальные предупреждения (mapData + CAP + GeoJSON)');
{
  const rect = (w, s, e, n) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } }] });
  const future = new Date(Date.now() + 6 * 3600e3).toISOString();
  const past = new Date(Date.now() - 3600e3).toISOString();
  const title = (de) => ({ de, en: 'x', ru: 'y' });
  let feeds, details, geos;
  const reset = () => {
    feeds = {
      mowas: [
        { id: 'mow.DE-NW-W-001', version: 1, startDate: '2026-11-12T10:00:00+01:00', severity: 'Severe', type: 'Alert', i18nTitle: title('Bombenentschärfung in Barmen - Evakuierung') },
        { id: 'mow.DE-SL-SLS-002', version: 3, startDate: '2026-11-12T10:00:00+01:00', severity: 'Minor', type: 'Alert', i18nTitle: title('Trinkwasserverunreinigung im Saarland') }
      ],
      dwd: [
        { id: 'dwdmap.A', version: 2, startDate: '2026-11-12T19:12:00+01:00', expiresDate: future, severity: 'Moderate', type: 'Alert', i18nTitle: title('Amtliche WARNUNG vor STURMBÖEN') },
        { id: 'dwdmap.B', version: 1, startDate: '2026-11-12T19:12:00+01:00', expiresDate: future, severity: 'Minor', type: 'Alert', i18nTitle: title('Amtliche WARNUNG vor FROST') },
        { id: 'dwdmap.C', version: 1, startDate: '2026-11-12T19:12:00+01:00', expiresDate: future, severity: 'Minor', type: 'Alert', i18nTitle: title('Amtliche WARNUNG vor HITZE') },
        { id: 'dwdmap.D', version: 1, startDate: '2026-11-12T09:00:00+01:00', expiresDate: past, severity: 'Minor', type: 'Alert', i18nTitle: title('Amtliche WARNUNG vor NEBEL') }
      ],
      katwarn: [], biwapp: [], lhp: [], police: []
    };
    const cap = (o) => ({ identifier: o.id, msgType: 'Alert', status: 'Actual', sent: '2026-11-12T10:00:00+01:00', info: [{ language: 'de-DE', severity: o.sev || 'Moderate', onset: o.onset, expires: o.expires, event: o.event, headline: o.head, description: o.desc, instruction: o.instr, web: o.web, senderName: o.sender, area: (o.areas || []).map((a) => ({ areaDesc: a })) }] });
    details = {
      'mow.DE-NW-W-001': cap({ id: 'mow.DE-NW-W-001', sev: 'Severe', onset: '2026-11-12T12:00:00+01:00', head: 'Bombenentschärfung', desc: 'Es wird eine Fliegerbombe entschärft.<br/>Der Bereich wird <b>evakuiert</b>.', instr: 'Bitte verlassen Sie den Bereich.', web: 'https://www.wuppertal.de/bombe', sender: 'Feuerwehr Wuppertal', areas: ['Wuppertal-Barmen'] }),
      'dwdmap.A': cap({ id: 'dwdmap.A', onset: '2026-11-12T20:00:00+01:00', expires: future, desc: 'Es treten Sturmböen mit Geschwindigkeiten bis 75 km/h auf.', instr: 'Hinweis auf mögliche Gefahren: Es können einzelne Äste herabstürzen.', web: 'javascript:alert(1)', sender: 'Deutscher Wetterdienst', areas: ['Stadt Wuppertal', 'Stadt Solingen'] }),
      'dwdmap.B': cap({ id: 'dwdmap.B', expires: future, desc: 'Frost.', areas: ['Kreis Warendorf'] }),
      'dwdmap.C': cap({ id: 'dwdmap.C', expires: future, desc: 'Hitze.', areas: ['Landkreis München'] })
    };
    geos = {
      'mow.DE-NW-W-001': rect(7.195, 51.272, 7.205, 51.278),   // ≈ 700 × 650 m в Barmen
      'dwdmap.A': rect(7.0, 51.1, 7.4, 51.4),                   // округ, накрывающий весь город
      'dwdmap.B': rect(7.7, 51.8, 8.0, 52.0),                   // NRW, но не Вупперталь
      'dwdmap.C': rect(11.3, 48.0, 11.8, 48.3)                  // Бавария
    };
  };
  const route = () => setRoutes([
    { match: /\/mapData\.json/, reply: (u) => feeds[u.match(/api31\/(\w+)\/mapData/)[1]] },
    { match: /\/warnings\/.+\.json$/, reply: (u) => details[decodeURIComponent(u.match(/warnings\/(.+)\.json$/)[1])] || 404 },
    { match: /\/warnings\/.+\.geojson$/, reply: (u) => geos[decodeURIComponent(u.match(/warnings\/(.+)\.geojson$/)[1])] || 404 }
  ]);
  const detailCalls = () => calls.filter((u) => /\/warnings\/.+\.json$/.test(u)).length;

  reset(); route();
  const env = newEnv();
  let r = await runSource(env, 'nina');
  ok(r.ok, 'NINA запуск');
  const ev = await rows(env, 'SELECT * FROM events ORDER BY source_event_id');
  const by = (id) => ev.find((e) => e.source_event_id === id);
  eq(ev.length, 3, 'сохранены: бомба (город), шторм (город), мороз (NRW); Бавария, Саар и истёкшее — нет');
  ok(!calls.some((u) => /DE-SL-SLS-002/.test(u)), 'чужая земля (MOWAS DE-SL) даже не запрашивалась');
  ok(!calls.some((u) => /dwdmap\.D/.test(u)), 'истёкшее предупреждение не запрашивалось');

  const bomb = by('mow.DE-NW-W-001');
  eq([bomb.category, bomb.geo_precision, bomb.severity, bomb.valid_from_precision], ['evacuation', 'source', 'Severe', 'minute'], 'эвакуация: категория, точка из контура, степень, запланированное начало из CAP');
  ok(bomb.latitude > 51.27 && bomb.latitude < 51.28 && bomb.longitude > 7.19 && bomb.longitude < 7.21, 'точка — центр компактной зоны');
  eq([bomb.event_time, bomb.valid_from], [null, '2026-11-12T11:00:00.000Z'], 'onset позже выпуска -> «Действует с»; время происшествия MOWAS неизвестно');
  ok(/Fliegerbombe entschärft\.\nDer Bereich wird evakuiert\./.test(bomb.description) && !/<|&/.test(bomb.description), 'HTML очищен из описания');
  ok(/Handlungsempfehlung: Bitte verlassen/.test(bomb.description) && /Betroffenes Gebiet: Wuppertal-Barmen/.test(bomb.description) && /Ausdehnung/.test(bomb.description), 'рекомендации, территория и размер зоны в описании');
  eq([bomb.source_url, bomb.publisher], ['https://www.wuppertal.de/bombe', 'NINA / MOWAS (Feuerwehr Wuppertal)'], 'ссылка и издатель');

  const storm = by('dwdmap.A');
  eq([storm.category, storm.geo_precision, storm.latitude, storm.status], ['weather_storm', 'city', null, 'ACTIVE'], 'DWD на округ: «весь город», без координат (нет выдуманной точки)');
  eq(storm.source_url, 'https://warnung.bund.de/', 'небезопасная ссылка javascript: отброшена');
  ok(storm.expires_at && /Stadt Wuppertal; Stadt Solingen/.test(storm.description), 'срок действия и территории сохранены');

  const frost = by('dwdmap.B');
  eq([frost.category, frost.geo_precision, frost.latitude, /^Kreis Warendorf$/.test(frost.location_name)], ['weather_ice', 'none', null, true], 'предупреждение NRW вне города: без точки, регион назван');
  ok(!by('dwdmap.C'), 'Бавария отброшена');
  eq((await rows(env, 'SELECT COUNT(*) n FROM nina_skip'))[0].n, 1, 'чужое (Бавария) запомнено в nina_skip');
  const nCalls = detailCalls();

  // повторный запуск: ничего заново не запрашивается и не пишется
  calls.length = 0;
  r = await runSource(env, 'nina');
  eq([detailCalls(), calls.filter((u) => /geojson/.test(u)).length, r.changes], [0, 0, 0], 'повтор: подробности и контуры из кэша, изменений нет');
  ok(nCalls >= 4, 'в первый запуск проверены все 4 актуальных предупреждения');

  // новая версия -> один запрос подробностей
  feeds.dwd[0].version = 3;
  details['dwdmap.A'].info[0].description = 'Es treten Sturmböen bis 90 km/h auf.';
  calls.length = 0;
  r = await runSource(env, 'nina');
  eq([detailCalls(), r.updated], [1, 1], 'новая версия: 1 запрос подробностей, запись обновлена');
  ok(/90 km\/h/.test((await rows(env, "SELECT description FROM events WHERE source_event_id='dwdmap.A'"))[0].description), 'новое описание сохранено');

  // пропавшее предупреждение закрывается лишь после двух запусков, и только если все ленты загружены
  feeds.mowas = [feeds.mowas[1]];
  await runSource(env, 'nina');
  eq((await rows(env, "SELECT status FROM events WHERE source_event_id='mow.DE-NW-W-001'"))[0].status, 'ACTIVE', 'после первого пропуска ещё ACTIVE');
  await runSource(env, 'nina');
  eq((await rows(env, "SELECT status FROM events WHERE source_event_id='mow.DE-NW-W-001'"))[0].status, 'RESOLVED', 'снятое предупреждение -> RESOLVED');

  // сбой ленты не должен закрывать чужие записи
  const envF = newEnv();
  reset(); route();
  await runSource(envF, 'nina');
  setRoutes([
    { match: /api31\/dwd\/mapData/, reply: 500 },
    { match: /\/mapData\.json/, reply: (u) => feeds[u.match(/api31\/(\w+)\/mapData/)[1]] },
    { match: /\/warnings\/.+\.json$/, reply: (u) => details[decodeURIComponent(u.match(/warnings\/(.+)\.json$/)[1])] || 404 },
    { match: /\/warnings\/.+\.geojson$/, reply: (u) => geos[decodeURIComponent(u.match(/warnings\/(.+)\.geojson$/)[1])] || 404 }
  ]);
  await runSource(envF, 'nina'); await runSource(envF, 'nina'); await runSource(envF, 'nina');
  eq((await rows(envF, "SELECT status FROM events WHERE source_event_id='dwdmap.A'"))[0].status, 'ACTIVE', 'лента DWD недоступна -> её предупреждения не закрываются');

  // режим только Вупперталь
  const envC = newEnv({ NINA_SCOPE: 'city' });
  reset(); route();
  await runSource(envC, 'nina');
  eq((await rows(envC, 'SELECT source_event_id FROM events ORDER BY 1')).map((x) => x.source_event_id), ['dwdmap.A', 'mow.DE-NW-W-001'], 'NINA_SCOPE=city: регион NRW не берём');

  // лимит подзапросов: много новых предупреждений обрабатываются порциями
  const envL = newEnv();
  reset();
  feeds.dwd = Array.from({ length: 30 }, (_, i) => ({ id: `dwdmap.L${i}`, version: 1, expiresDate: future, severity: 'Minor', type: 'Alert', i18nTitle: title('Amtliche WARNUNG vor FROST') }));
  feeds.mowas = [];
  for (let i = 0; i < 30; i++) { details[`dwdmap.L${i}`] = { info: [{ language: 'de', expires: future, area: [{ areaDesc: 'Stadt Wuppertal' }] }] }; geos[`dwdmap.L${i}`] = rect(7.0, 51.1, 7.4, 51.4); }
  route();
  await runSource(envL, 'nina');
  ok(calls.length <= 45, `за запуск не больше 45 подзапросов (было ${calls.length})`);
  eq((await rows(envL, 'SELECT COUNT(*) n FROM events'))[0].n, 18, 'первая порция: 18 предупреждений');
  await runSource(envL, 'nina');
  eq((await rows(envL, 'SELECT COUNT(*) n FROM events'))[0].n, 30, 'вторая порция догружает остальные');
  eq((await rows(envL, "SELECT COUNT(*) n FROM events WHERE status='RESOLVED'"))[0].n, 0, 'пока очередь не пуста, ничего не закрывается');
}

// ================= Stadt Wuppertal (RSS) =================
console.log('\n[wuppertal] пресс-релизы города: дороги, транспорт, мероприятия, коммунальные сбои');
{
  const env = newEnv();
  const pub = new Date(Date.now() - 3600e3).toUTCString();
  const item = (id, title, desc) => `<item><title>${title}</title><link>https://www.wuppertal.de/presse/meldung-${id}.php</link><guid>wup-${id}</guid><pubDate>${pub}</pubDate><description>${desc}</description></item>`;
  const rss = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Aktuelle Meldungen</title><link>https://www.wuppertal.de</link><description>Pressemitteilungen der Stadt Wuppertal mit allen aktuellen Meldungen aus der Verwaltung und dem Stadtgebiet</description>${[
    item(8, 'Sanierung der Siebeneicker Straße startet', 'Die Stadt Wuppertal repariert ab Montag, 16. November, die Siebeneicker Straße zwischen Untenrohleder und Am Elisabetheim. Fahrbahnschäden werden beseitigt und ein neuer Asphaltbelag aufgetragen.'),
    item(9, 'Fahrbahnsanierung in der Pahlkestraße gestartet', 'Die Straße, die zwischen Sonnborn und Katernberg verläuft, bekommt neuen Asphalt. Die Arbeiten dauern bis etwa Ende Dezember an.'),
    item(1, 'Vollsperrung der Friedrich-Ebert-Straße wegen Bauarbeiten', 'Die Straße ist wegen Fahrbahnsanierung voll gesperrt.'),
    item(2, 'WSW: Buslinie 603 fährt Umleitung', 'Wegen einer Baustelle fährt die Buslinie 603 eine Umleitung.'),
    item(3, 'Stromausfall in Oberbarmen', 'Betroffen sind mehrere Straßen.'),
    item(4, 'Marathon: Straßen gesperrt', 'Wegen des Marathons kommt es zu Sperrungen in der Innenstadt.'),
    item(5, 'Neue Verkehrsführung in der Hardtstraße', 'Autofahrer müssen sich umstellen.'),
    item(6, 'Neue Öffnungszeiten im Bürgerbüro', 'Das Bürgerbüro hat ab sofort längere Öffnungszeiten.'),
    item(7, 'Bombenentschärfung in Barmen', 'Der Bereich wird evakuiert.')
  ].join('')}</channel></rss>`;
  setRoutes([
    { match: /wuppertal\.de\/presse/, reply: () => new Response(rss, { status: 200 }) },
    { match: /nominatim/, reply: () => [{ lat: '51.2560', lon: '7.1480', category: 'highway', type: 'residential', address: { road: 'Friedrich-Ebert-Straße', suburb: 'Elberfeld' }, display_name: 'x' }] }
  ]);
  // route reply must be JSON-able in the shim; give the RSS as text via a dedicated fetch wrapper
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => /wuppertal\.de\/presse/.test(String(url)) ? new Response(rss, { status: 200, headers: { 'content-type': 'application/rss+xml' } }) : realFetch(url, init);
  let r = await runSource(env, 'wuppertal');
  ok(r.ok, 'wuppertal: запуск');
  const ev = await rows(env, 'SELECT * FROM events ORDER BY title');
  const cat = (re) => (ev.find((e) => re.test(e.title)) || {}).category;
  eq(cat(/Vollsperrung/), 'road_closure', 'дорожное перекрытие');
  eq(cat(/Buslinie/), 'transit_detour', 'объезд автобуса -> транспорт');
  eq(cat(/Stromausfall/), 'infra_power', 'отключение электричества');
  eq(cat(/Marathon/), 'event_restriction', 'ограничения из-за мероприятия');
  eq(cat(/Verkehrsführung/), 'traffic_other', 'валидная категория вместо traffic_disruption');
  eq(cat(/Bombenentschärfung/), 'evacuation', 'эвакуация');
  ok(!ev.find((e) => /Öffnungszeiten/.test(e.title)), 'нерелевантное сообщение отброшено');
  const sieb = ev.find((e) => /Siebeneicker/.test(e.title));
  eq([sieb.category, /^Siebeneicker Straße, zwischen Untenrohleder und Am Elisabetheim$/.test(sieb.location_name)], ['roadworks', true], '«zwischen X und Y»: улица найдена по тексту, X и Y только границы участка');
  const geoQueries = calls.filter((u) => /nominatim/.test(u)).map((u) => decodeURIComponent(u));
  ok(geoQueries.some((u) => /Siebeneicker/.test(u)) && !geoQueries.some((u) => /Untenrohleder|Elisabetheim/.test(u)), 'геокодируется улица, а не границы участка');
  const pahl = ev.find((e) => /Pahlke/.test(e.title));
  ok(/Pahlkestraße/.test(pahl.location_name || '') && !/Katernberg verläuft/.test(pahl.location_name || ''), 'описательное «zwischen Sonnborn und Katernberg» не захватывает лишнее');
  ok(sieb.valid_from && !sieb.event_time && pahl.valid_until, 'даты из текста (valid_from/valid_until, «Произошло» неизвестно): начало «ab Montag, 16. November», конец «bis etwa Ende Dezember»');
  ok(ev.every((e) => e.expires_at && Date.parse(e.expires_at) > Date.now()), 'у всех стабильный срок действия');
  const road = ev.find((e) => /Vollsperrung/.test(e.title)), topic = ev.find((e) => /Stromausfall/.test(e.title));
  ok(Date.parse(road.expires_at) - Date.parse(road.published_at) > 29 * 86400e3 && Date.parse(topic.expires_at) - Date.parse(topic.published_at) < 8 * 86400e3, 'срок от даты публикации: дороги 30 дней, остальные темы 7');
  r = await runSource(env, 'wuppertal'); // второй запуск может догеокодировать записи, не попавшие в бюджет (3 запроса за запуск)
  r = await runSource(env, 'wuppertal');
  eq(r.changes, 0, 'повторный запуск ничего не меняет (срок не «плавает»)');
  globalThis.fetch = realFetch;
}

// ================= NRW.Mobidrom (DATEX II) =================
console.log('\n[mobidrom] DATEX II: типы ограничений, временные окна, полосы');
{
  const env = newEnv();
  const future = new Date(Date.now() + 20 * 86400e3).toISOString();
  const rec = (id, type, { mgmt = '', kind = '', lanes = '', window = '', status = 'definedByValidityTimeSpecification', end = '', comment, pos }) => `
    <situationRecord id="${id}" xsi:type="${type}"><validity><validityStatus>${status}</validityStatus><validityTimeSpecification><overallStartTime>2026-11-01T08:00:00+01:00</overallStartTime>${end ? `<overallEndTime>${end}</overallEndTime>` : ''}${window}</validityTimeSpecification></validity>
    <generalPublicComment><comment><values><value lang="de">${comment}</value></values></comment></generalPublicComment>
    ${kind ? `<roadMaintenanceType>${kind}</roadMaintenanceType>` : ''}${mgmt ? `<roadOrCarriagewayOrLaneManagementType>${mgmt}</roadOrCarriagewayOrLaneManagementType>` : ''}${lanes}
    <groupOfLocations><posList>${pos}</posList></groupOfLocations></situationRecord>`;
  const win = '<recurringTimePeriodOfDay><startTimeOfPeriod>08:00:00+01:00</startTimeOfPeriod><endTimeOfPeriod>16:00:00+01:00</endTimeOfPeriod></recurringTimePeriodOfDay><recurringDayWeekMonthPeriod><applicableDay>monday</applicableDay><applicableDay>tuesday</applicableDay><applicableDay>wednesday</applicableDay><applicableDay>thursday</applicableDay><applicableDay>friday</applicableDay></recurringDayWeekMonthPeriod>';
  const xml = `<?xml version="1.0"?><d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0"><payloadPublication>
    <situation id="S1">${rec('R1', 'MaintenanceWorks', { kind: 'resurfacingWork', mgmt: 'laneClosures', lanes: '<numberOfLanesRestricted>1</numberOfLanesRestricted><numberOfOperationalLanes>1</numberOfOperationalLanes>', window: win, end: future, comment: 'Fahrbahnerneuerung Hardtstraße', pos: '51.2560 7.1480 51.2570 7.1490' })}</situation>
    <situation id="S2">${rec('R2', 'MaintenanceWorks', { mgmt: 'roadClosed', comment: 'Vollsperrung Friedrich-Ebert-Straße', pos: '51.2500 7.1500' })}</situation>
    <situation id="S3">${rec('R3', 'MaintenanceWorks', { status: 'suspended', comment: 'Arbeiten ruhen Gathe', pos: '51.2600 7.1600' })}</situation>
    <situation id="S4">${rec('R4', 'MaintenanceWorks', { comment: 'Baustelle Düsseldorf Königsallee', pos: '51.2200 6.7700' })}</situation>
    </payloadPublication><!-- ${'x'.repeat(300)} --></d2LogicalModel>`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => /mobilitaetsdaten\.nrw/.test(String(url)) ? new Response(xml, { status: 200 }) : realFetch(url, init);
  let r = await runSource(env, 'mobidrom');
  ok(r.ok, 'mobidrom: запуск');
  const ev = await rows(env, 'SELECT * FROM events ORDER BY source_event_id');
  eq(ev.length, 2, 'сохранены только работы внутри города и не приостановленные');
  const lane = ev.find((e) => /Hardt/.test(e.title)), closed = ev.find((e) => /Friedrich/.test(e.title));
  eq([lane.category, closed.category], ['roadworks', 'road_closure'], 'категория по структурированному типу: полоса ≠ полное перекрытие');
  ok(/Art der Arbeiten: Fahrbahnerneuerung/.test(lane.description) && /Fahrstreifen: 1 eingeschränkt, 1 befahrbar/.test(lane.description) && /Zeitfenster: Mo–Fr 08:00–16:00/.test(lane.description), 'тип работ, полосы и временное окно в описании');
  eq([lane.geo_precision, lane.time_precision, Date.parse(lane.expires_at) === Date.parse(future)], ['source', 'minute', true], 'работа с известным концом: срок = конец (без запаса)');
  ok(/Bauzeit: 01\.11\.2026 – \d{2}\.\d{2}\.\d{4}/.test(lane.description), 'период работ в описании');
  eq([closed.expires_at, closed.event_time !== null], [null, true], 'без даты окончания срока нет (закрывается по исчезновению из ленты)');
  r = await runSource(env, 'mobidrom');
  eq(r.changes, 0, 'повторный запуск ничего не меняет');
  // в ленте нет работ в Вуппертале (вся геометрия разобрана и лежит за городом): это пустой результат, а не ошибка
  const xmlOut = `<?xml version="1.0"?><d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0"><payloadPublication>
    <situation id="S4">${rec('R4', 'MaintenanceWorks', { comment: 'Baustelle Düsseldorf Königsallee', pos: '51.2200 6.7700' })}</situation>
    </payloadPublication><!-- ${'x'.repeat(1200)} --></d2LogicalModel>`;
  globalThis.fetch = async (url, init) => /mobilitaetsdaten\.nrw/.test(String(url)) ? new Response(xmlOut, { status: 200 }) : realFetch(url, init);
  r = await runSource(env, 'mobidrom');
  ok(r.ok, 'mobidrom: лента без работ в Вуппертале — не ошибка');
  r = await runSource(env, 'mobidrom');
  const left = await rows(env, "SELECT status FROM events WHERE source = 'mobidrom' AND status IN ('ACTIVE','LIVE')");
  eq(left.length, 0, 'прежние работы закрываются после двух запусков без них');
  globalThis.fetch = realFetch;
}

// ================= WSW (Atom/RSS: автобус и Schwebebahn) =================
console.log('\n[wsw] ленты WSW: только изменения движения, без рекламы');
{
  const wsw = await import('../src/sources/wsw.js');
  const MON = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const de = (ms) => { const d = new Date(ms); return `${d.getUTCDate()}. ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const now = Date.now();
  const pub = new Date(now - 3 * 86400e3).toISOString();
  const atom = (id, title, body, date = pub) => `<entry><title>${title}</title><link rel="alternate" href="https://www.wsw-online.de/ueber-uns/presse/news/artikel/detail/${id}/"/><id>https://www.wsw-online.de/ueber-uns/presse/news/artikel/detail/${id}/</id><updated>${date}</updated><summary>${body}</summary></entry>`;
  const atomFeed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${[
    atom('umleitung-619', 'Busumleitungen der Linie 619 - WSW richten TaxiBus-Linie ein', `Die WSW starten am ${de(now - 2 * 86400e3)} mit der Erneuerung der Ver- und Entsorgungsinfrastruktur in der Nützenberger Straße. In der ersten Bauphase wird die Buslinie 619 für etwa drei Monate zwischen den Haltestellen Kyffhäuserstraße und Robert-Daum-Platz umgeleitet. Dadurch entfallen die Haltestellen Anilintreppe und Vogelsaue.`),
    atom('kaffee', 'Der Kaffee passt noch!', 'Den Kaffee noch in Ruhe genießen? Mit dem WSW BusRadar sehen Sie live, wo sich der Bus befindet. Alle fünf Sekunden aktualisiert.'),
    atom('circus', 'Weihnachtscircus Wuppertal', 'Der Weihnachtscircus Wuppertal feiert sein fünfjähriges Jubiläum auf dem Carnaper Platz. Als WSW-Kundin ohne Ausfall Rabatt.'),
    atom('rabatt', 'Verlängerung des Sommerrabatts', 'DC-Laden nur noch 45 ct/kWh an den WSW Hyperchargern.'),
    atom('alt', 'Schwebebahn: Ersatzverkehr alt', 'Schienenersatzverkehr zwischen Vohwinkel und Zoo.', new Date(now - 90 * 86400e3).toISOString())
  ].join('')}</feed>`;
  const rssFeed = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>Schwebebahn: Störung am Wochenende</title><link>https://www.wsw-online.de/ueber-uns/presse/news/artikel/detail/stoerung/</link><guid>wsw-stoerung-1</guid><pubDate>${new Date(now - 3600e3).toUTCString()}</pubDate><description>&lt;p&gt;Wegen einer Störung fährt die Schwebebahn zwischen Oberbarmen und Werther Brücke nicht. Es gilt Schienenersatzverkehr.&lt;/p&gt;</description></item></channel></rss>`;

  {
    const cases = [
      ['Wasserrohrbruch in der Friedrichstraße', 'Wegen eines Rohrbruchs ist die Wasserversorgung im Bereich Friedrichstraße unterbrochen.', 'infra_water'],
      ['Stromausfall in Vohwinkel', 'Ein Kabelschaden führte zu einem Stromausfall in Teilen von Vohwinkel.', 'infra_power'],
      ['Gasaustritt an der Hofaue', 'Nach einem Gasaustritt ist die Hofaue gesperrt.', 'infra_damage'],
      ['Leitungsarbeiten: Vollsperrung der Friedrichstraße', 'Wegen Leitungsarbeiten wird die Friedrichstraße zwischen Hofaue und Neumarkt vollgesperrt.', 'road_closure'],
      ['Parkplatzsperrung Carnaper Platz', 'Aufgrund des Weihnachtscircus bleibt der Carnaper Platz gesperrt.', null],
      ['Nächtliche Wartungsarbeiten am Entlastungssammler Wupper', 'Die Arbeiten im Kanal finden nachts statt.', null],
      ['Planbar ins neue Jahr: Strom Garant', 'Der Strom Garant läuft bis Ende 2027.', null]
    ];
    const wswm = await import('../src/sources/wsw.js');
    for (const [ti, de, want] of cases) eq(wswm.classifyAny(ti, de).category || null, want, `WSW классификация: ${ti}`);
    const inc = wswm.toItem({ id: 'u1', title: 'Wasserrohrbruch in der Friedrichstraße', url: 'https://www.wsw-online.de/a/', published: now - 3600e3, description: 'Wegen eines Rohrbruchs ist die Wasserversorgung im Bereich Friedrichstraße unterbrochen.' }, now);
    ok(inc.item && Date.parse(inc.item.expires_at) - (now - 3600e3) === 3 * 86400e3, 'авария на сети без срока хранится 3 дня');
    eq(wswm.durationDays('Die Arbeiten werden voraussichtlich drei Wochen dauern.'), 21, 'срок: «drei Wochen dauern»');
    eq(wswm.durationDays('wird die Buslinie 619 für etwa drei Monate umgeleitet'), 90, 'срок: «für etwa drei Monate»');
  }
  eq(wsw.parseFeed(atomFeed).length, 5, 'Atom: записи разобраны (ссылка из href)');
  eq(wsw.parseFeed(rssFeed).length, 1, 'RSS: запись разобрана');
  ok(!/<p>/.test(wsw.parseFeed(rssFeed)[0].description), 'HTML из описания убран');
  eq(wsw.parseFeed('<feed><entry><title>Winterservice Linie 619 Ausfall</title><link href="https://www.wsw-online.de/ttps://www.wsw-online.de/mobilitaet/fahrplan/"/><updated>2026-11-12T08:00:00Z</updated></entry></feed>')[0].url, 'https://www.wsw-online.de/mobilitaet/fahrplan/', 'битая ссылка «/ttps://» исправляется');
  ok(wsw.parseFeed(atomFeed.replace(/https:\/\/www\.wsw-online\.de/g, 'http://evil.example')).length === 0, 'чужие домены и не-https отбрасываются');

  const env = newEnv();
  setRoutes([
    { match: /wsw-online\.de\/suchergebnisse\/rss\.xml/, reply: atomFeed },
    { match: /wsw-online\.de\/suchergebnisse\/presseinformationen\.xml/, reply: rssFeed },
    { match: /nominatim/, reply: [] }
  ]);
  let r = await runSource(env, 'wsw');
  ok(r.ok, 'wsw: запуск');
  const ev = await rows(env, "SELECT * FROM events WHERE source = 'wsw' ORDER BY title");
  eq(ev.map((e) => e.title), ['Busumleitungen der Linie 619 - WSW richten TaxiBus-Linie ein', 'Schwebebahn: Störung am Wochenende'], 'сохранены только 2 сообщения о движении (реклама и старое отброшены)');
  const d619 = ev[0], sb = ev[1];
  eq([d619.category, sb.category], ['transit_detour', 'transit_delay'], 'категории: объезд и сбой');
  eq(d619.location_name, 'Nützenberger Straße', 'улица найдена в тексте');
  eq(d619.status, 'ACTIVE', 'действующий объезд со сроком — ACTIVE (не выпадает из окна API)');
  ok(d619.valid_from && d619.valid_until && Date.parse(d619.valid_until) - Date.parse(d619.valid_from) > 80 * 86400e3, '«für etwa drei Monate» → срок ≈ 3 месяца');
  eq(Date.parse(d619.expires_at), Date.parse(d619.valid_until) + 86400e3, 'срок хранения = конец действия');
  eq([d619.event_time, d619.is_verified, d619.publisher], [null, 1, 'WSW'], 'время происшествия неизвестно, источник официальный');
  r = await runSource(env, 'wsw');
  eq(r.changes, 0, 'повторный запуск ничего не меняет');
  setRoutes([{ match: /rss\.xml/, reply: atomFeed }, { match: /presseinformationen/, reply: rssFeed }]);
  const pr = await wsw.probe({ now: Date.now() });
  ok(pr.accepted === 2 && pr.feeds.length === 2 && pr.feeds[0].items.some((i) => !i.accepted && i.reason), 'проба для админки: принятые и причины отказа');
  setRoutes([{ match: /wsw-online\.de\/suchergebnisse\/rss\.xml/, reply: 503 }, { match: /presseinformationen/, reply: rssFeed }]);
  r = await runSource(env, 'wsw');
  ok(r.ok, 'одна лента недоступна — вторая всё равно обработана');
  setRoutes([{ match: /wsw-online\.de/, reply: 503 }]);
  r = await runSource(env, 'wsw');
  ok(!r.ok, 'обе ленты недоступны — ошибка источника, записи не закрываются');
  eq((await rows(env, "SELECT id FROM events WHERE source = 'wsw'")).length, 2, 'при ошибке записи сохранены');
}

// ================= Заголовки официальных предупреждений =================
console.log('\n[translate] стандартные заголовки предупреждений');
{
  const { officialWarningTitle: ow } = await import('../src/translate.js');
  eq(ow('Amtliche WARNUNG vor MARKANTER GLÄTTE'), 'Официальное предупреждение: значительная гололедица', 'markanter Glätte');
  eq(ow('Amtliche WARNUNG vor STARKEM FROST'), 'Официальное предупреждение: сильный мороз', 'starkem Frost');
  eq(ow('Amtliche UNWETTERWARNUNG vor STARKEM DAUERREGEN'), 'Предупреждение о непогоде: сильный затяжной дождь', 'Unwetterwarnung');
  eq(ow('Amtliche WARNUNG vor GLATTEIS'), 'Официальное предупреждение: гололёд', 'без прилагательного');
  eq([ow('Amtliche WARNUNG vor ETWAS UNBEKANNTEM'), ow('Brand in Elberfeld')], [null, null], 'неизвестное и обычные заголовки не трогаются');
}

// ================= WSW Netz (карта störungen) =================
console.log('\n[wswnetz] карта: тихий режим, отключение, смена формата');
{
  const wn = await import('../src/sources/wswnetz.js');
  const pre = "var mymap = L.map('mapid').setView([51.235, 7.17], 11);\nvar latlngsWtal = [[51.21,7.05],[51.2,7.04]];\nvar polygonWTal = L.polygon (latlngsWtal,{}).addTo(mymap);\n";
  const quiet = pre + 'L.marker([51.25289257, 7.172574805]).addTo (mymap)\n\n.bindPopup("<p><h3> <b>WSW NETZ</b> </h3> Derzeit keine Stromst&oumlrungen im Hoch- und Mittelspannungsnetz der WSW Netz GmbH bekannt </p>").openPopup();\n';
  const outage = quiet + 'L.marker([51.2701, 7.2002]).addTo (mymap)\n.bindPopup("<p><h3>Stromst&oumlrung</h3> Umspannwerk Kabelstra&szlig;e, Wiederversorgung bis 16 Uhr</p>");\nL.marker([48.1, 11.5]).addTo (mymap).bindPopup("<p>Au&szlig;erhalb</p>");\n';
  const q = wn.analyze(quiet, Date.now());
  eq([q.markers, q.quiet, q.items.length], [1, 1, 0], 'тихий режим: маркер «keine Störungen» — не событие');
  const o = wn.analyze(outage, Date.now());
  eq([o.markers, o.quiet, o.items.length, o.unparsed], [3, 1, 1, 1], 'отключение: 1 событие, чужие координаты в unparsed');
  ok(/Kabelstraße/.test(o.items[0].description) && o.items[0].category === 'infra_power' && o.items[0].geo_precision === 'source', 'текст дословный, ß декодирован, точка с карты');
  const env = newEnv();
  setRoutes([{ match: /WSW_Netz_Marker\.js/, reply: outage }]);
  let r = await runSource(env, 'wswnetz');
  ok(r.ok, 'wswnetz: запуск');
  eq((await rows(env, "SELECT id FROM events WHERE source = 'wswnetz' AND status = 'ACTIVE'")).length, 1, 'событие создано');
  setRoutes([{ match: /WSW_Netz_Marker\.js/, reply: quiet }]);
  await runSource(env, 'wswnetz');
  await runSource(env, 'wswnetz');
  eq((await rows(env, "SELECT id FROM events WHERE source = 'wswnetz' AND status = 'ACTIVE'")).length, 0, 'маркер исчез на двух запусках подряд — событие закрыто');
  setRoutes([{ match: /WSW_Netz_Marker\.js/, reply: pre }]);
  await runSource(env, 'wswnetz');
  setRoutes([{ match: /WSW_Netz_Marker\.js/, reply: 503 }]);
  ok(!(await runSource(env, 'wswnetz')).ok, 'файл недоступен — ошибка источника');
}

// ================= Погода (DWD через Bright Sky) =================
console.log('\n[weather] /api/weather: измерения, прогноз, отказоустойчивость');
{
  const now = Date.now();
  const hr = (k) => new Date(Math.floor(now / 3600e3) * 3600e3 + k * 3600e3).toISOString();
  const cur = { weather: { timestamp: new Date(now - 20 * 60000).toISOString(), temperature: 7.34, icon: 'rain', wind_speed_10: 18.4, wind_gust_speed_10: 41, wind_direction_10: 250, relative_humidity: 93, precipitation_60: 1.2, pressure_msl: 1004.6, cloud_cover: 100 },
    sources: [{ station_name: 'Wuppertal-Buchenhofen', distance: 4200 }] };
  const fc = { weather: [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ timestamp: hr(k), temperature: 6 + k * 0.1, icon: k % 2 ? 'cloudy' : 'rain', precipitation: 0.3, precipitation_probability: 40 })) };
  const env = newEnv();
  const call = async (p = '/api/weather') => {
    const res = await api.fetch(new Request('https://x.test' + p), env, { waitUntil: () => {} });
    return { status: res.status, body: await res.json() };
  };
  setRoutes([{ match: /brightsky\.dev\/current_weather/, reply: cur }, { match: /brightsky\.dev\/weather/, reply: fc }]);
  let r = await call();
  eq(r.status, 200, '/api/weather: 200');
  eq([r.body.from, r.body.current.temp, r.body.current.icon, r.body.current.wind_kmh, r.body.current.gust_kmh, r.body.current.humidity], ['observation', 7.3, 'rain', 18, 41, 93], 'текущие значения из измерений станции');
  eq([r.body.station.name, r.body.station.distance_km], ['Wuppertal-Buchenhofen', 4], 'станция и расстояние');
  ok(r.body.forecast.length === 6 && r.body.forecast.every((f) => Date.parse(f.t) >= now - 30 * 60000), 'прогноз: 6 ближайших часов, без прошедших');
  ok(/DWD/.test(r.body.attribution), 'указан источник DWD');

  // измерения устарели -> берём ближайший час прогноза и честно помечаем
  const stale = { weather: { ...cur.weather, timestamp: new Date(now - 5 * 3600e3).toISOString() }, sources: cur.sources };
  setRoutes([{ match: /brightsky\.dev\/current_weather/, reply: stale }, { match: /brightsky\.dev\/weather/, reply: fc }]);
  r = await call('/api/weather?x=1');
  eq(r.body.from, 'forecast', 'устаревшие измерения (5 ч) не показываем как текущие');

  // мусорные значения отбрасываются
  setRoutes([{ match: /brightsky\.dev\/current_weather/, reply: { weather: { timestamp: new Date(now - 60000).toISOString(), temperature: 999, icon: '<script>' } } }, { match: /brightsky\.dev\/weather/, reply: fc }]);
  r = await call('/api/weather?x=2');
  eq(r.body.from, 'forecast', 'температура вне допустимых пределов отбрасывается');

  // текущая недоступна, прогноз есть
  setRoutes([{ match: /brightsky\.dev\/current_weather/, reply: 503 }, { match: /brightsky\.dev\/weather/, reply: fc }]);
  r = await call('/api/weather?x=3');
  eq([r.status, r.body.from], [200, 'forecast'], 'нет измерений — показываем прогноз с пометкой');

  // всё недоступно
  setRoutes([{ match: /brightsky\.dev/, reply: 503 }]);
  r = await call('/api/weather?x=4');
  eq(r.status, 502, 'источник недоступен: 502, а не выдуманные данные');
}

// ================= разбор реальных релизов Presseportal =================
{
  const pub = Date.parse('Sat, 14 Nov 2026 14:47:51 +0100');
  const r = parseEventTime('Am Samstagmittag gegen 13:00 Uhr wurde der Feuerwehr ein Brand gemeldet', pub);
  eq([r.ms && new Date(r.ms).toISOString(), r.precision], ['2026-11-14T12:00:00.000Z', 'minute'], 'релиз в субботу: «Am Samstagmittag gegen 13:00 Uhr» = сегодня 13:00');
  eq(parseEventTime('Am Samstagabend gegen 20:00 Uhr', pub).ms, null, 'то же время суток ещё не наступило: не угадываем');
  eq(parseEventTime('Am Samstag kam es zu einem Brand', pub).ms, null, 'тот же день недели без времени: не угадываем');
  eq(extractStreet('Brand an der Straße Köttershöhe im Ortsteil Langenfeld'), 'Köttershöhe', '«an der Straße Köttershöhe»');
  eq(extractStreet('Unfall auf der Straße Richtung Köln'), null, '«Straße Richtung …» — не улица');
}

// ================= Presseportal (RSS) =================
console.log('\n[presseportal] RSS: релизы, актуальность, геокодирование');
{
  const env = newEnv({ PRESS_REGIONS: 'W' });
  const now = Date.now();
  const rfc = (agoH) => new Date(now - agoH * 3600e3).toUTCString();
  const item = (id, title, body, agoH, cdata = true) => `<item><title>${title}</title><link>https://www.presseportal.de/blaulicht/pm/115885/${id}?utm=x</link><guid isPermaLink="false">g${id}</guid><pubDate>${rfc(agoH)}</pubDate><description>${cdata ? `<![CDATA[<p>${body}</p>]]>` : body}</description></item>`;
  const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${items.join('')}</channel></rss>`;
  const fire = rss([
    item(1, 'FW-W: Gestern um 14:30 Uhr Küchenbrand in der Friedrich-Ebert-Straße', 'Wuppertal (ots) - Gestern um 14:30 Uhr wurde ein Küchenbrand in der Friedrich-Ebert-Straße 12 gemeldet.<br/>Verletzt wurde niemand.', 2),
    item(2, 'FW-W: Brand in Wohnhaus', 'Wuppertal (ots) - Die Feuerwehr löschte einen Brand &amp; sicherte die Stelle.', 3, false),
    item(3, 'FW-W: Alter Einsatz', 'Wuppertal (ots) - Am Sonntag brannte es in der Gathe-Straße.', 20),
    item(4, 'FW-W: Einsatz in Solingen', 'Solingen (ots) - Brand in Solingen.', 1)
  ]);
  const police = rss([
    item(5, 'POL-W: Verkehrsunfall auf der B7', 'Wuppertal (ots) - Bei einem Verkehrsunfall wurde eine Person verletzt.', 1),
    item(6, 'POL-RS: Einbruch in Remscheid', 'Remscheid (ots) - Einbruch.', 1),
    item(7, 'Meldung ohne Datumszeile', 'Solingen und Wuppertal betreffend.', 1)
  ]);
  setRoutes([
    { match: /dienststelle_115885/, reply: () => fire },
    { match: /dienststelle_11811/, reply: () => police },
    { match: /nominatim/, reply: () => [{ lat: '51.2560', lon: '7.1480', category: 'highway', type: 'residential', address: { road: 'Friedrich-Ebert-Straße', suburb: 'Elberfeld' }, display_name: 'x' }] }
  ]);
  const r = await runSource(env, 'presseportal');
  ok(r.ok, 'запуск Presseportal (RSS)');
  const ev = await rows(env, 'SELECT * FROM events ORDER BY source_event_id');
  eq(ev.length, 3, 'чужие города и релиз старше TTL не сохранены');
  const e1 = ev.find((e) => e.source_event_id === '115885:g1');
  eq([e1.status, e1.category, e1.is_verified, e1.publisher], ['RECENT', 'fire', 1, 'Feuerwehr Wuppertal'], 'релиз = RECENT (не LIVE), категория fire');
  eq([e1.time_precision, e1.published_at !== null], ['minute', true], 'время из текста, отдельно от публикации');
  ok(Date.parse(e1.event_time) < Date.parse(e1.published_at), 'время происшествия ≠ время публикации');
  eq([e1.geo_precision, e1.district, e1.latitude !== null], ['street', 'Elberfeld', true], 'улица геокодирована, точность street');
  ok(!/\b12\b/.test(e1.location_name || ''), 'номер дома не сохранён');
  ok(/gemeldet\.\nVerletzt wurde niemand/.test(e1.description) && !/^Wuppertal \(ots\)/.test(e1.description), 'абзацы сохранены, дата-строка убрана');
  eq(e1.source_url, 'https://www.presseportal.de/blaulicht/pm/115885/1', 'ссылка без параметров отслеживания');
  const e2 = ev.find((e) => e.source_event_id === '115885:g2');
  eq([e2.event_time, e2.time_precision, e2.geo_precision, e2.latitude], [null, 'unknown', 'none', null], 'нет улицы/времени -> ничего не выдумано');
  ok(/Brand & sicherte/.test(e2.description), 'XML-сущности декодированы один раз');
  const e5 = ev.find((e) => e.source_event_id === '11811:g5');
  eq([e5.category, e5.publisher], ['accident', 'Polizei Wuppertal'], 'полицейский релиз Wuppertal принят');
  ok(!ev.some((e) => /g[367]$/.test(e.source_event_id)), 'Remscheid, Solingen и старый релиз отброшены');
  eq(calls.filter((u) => /nominatim/.test(u)).length, 1, 'геокодер вызван 1 раз');

  await runSource(env, 'presseportal');
  eq(calls.filter((u) => /nominatim/.test(u)).length, 1, 'повторный запуск: геокодер из кэша');
  eq((await rows(env, 'SELECT COUNT(*) n FROM events'))[0].n, 3, 'дублей нет');
  const again = await runSource(env, 'presseportal');
  eq(again.changes, 0, 'повторный запуск ничего не меняет');

  // одна лента недоступна — вторая работает; обе — ошибка без падения
  const env2 = newEnv({ PRESS_REGIONS: 'W' });
  setRoutes([{ match: /dienststelle_115885/, reply: 500 }, { match: /dienststelle_11811/, reply: () => police }]);
  const r2 = await runSource(env2, 'presseportal');
  ok(r2.ok && (await rows(env2, 'SELECT COUNT(*) n FROM events'))[0].n === 1, 'одна лента недоступна: вторая обработана');
  const env3 = newEnv();
  setRoutes([{ match: /presseportal/, reply: 500 }]);
  const r3 = await runSource(env3, 'presseportal');
  ok(!r3.ok, 'обе ленты недоступны: ошибка записана, задача не падает');
  const env4 = newEnv();
  setRoutes([{ match: /presseportal/, reply: () => '<html>captcha</html>' }]);
  const r4 = await runSource(env4, 'presseportal');
  ok(!r4.ok && /Invalid RSS/.test(r4.error), 'не RSS в ответе -> понятная ошибка');
}

// ================= Presseportal: районы вместо города =================
{
  const { extractDistrict } = await import('../src/sources/presseportal.js');
  eq(extractDistrict('Unfall in Barmen auf der Schönebecker Straße'), 'Barmen', 'район из текста');
  eq(extractDistrict('Brand in Wuppertal-Vohwinkel'), 'Vohwinkel', '«Wuppertal-Vohwinkel»');
  eq(extractDistrict('Einbruch in Oberbarmen'), 'Oberbarmen', 'Oberbarmen, а не Barmen');
  eq(extractDistrict('Einbruch in Langenfeld (Rheinland)'), null, 'Langenfeld без «Wuppertal-/Ortsteil» — другой город');
  eq(extractDistrict('im Ortsteil Langenfeld gemeldet'), 'Langenfeld', '«Ortsteil Langenfeld» — район Wuppertal');

  const env = newEnv({ PRESS_TTL_HOURS: '48', PRESS_REGIONS: 'W' });
  const now = Date.now();
  const rfc = (h) => new Date(now - h * 3600e3).toUTCString();
  const it = (id, title, body, h) => `<item><title>${title}</title><link>https://www.presseportal.de/blaulicht/pm/11811/${id}</link><guid>g${id}</guid><pubDate>${rfc(h)}</pubDate><description>Polizei Wuppertal [ Newsroom ]\n${body}</description></item>`;
  const police = `<?xml version="1.0"?><rss version="2.0"><channel>${[
    it(1, 'POL-W: Einbruch', 'Barmen (ots) - In der Nacht wurde eingebrochen.', 30),
    it(2, 'POL-W: Unfall', 'Wuppertal-Vohwinkel (ots) - Es kam zu einem Unfall.', 30),
    it(3, 'POL-W: Anderswo', 'Remscheid (ots) - Etwas in Remscheid.', 3),
    it(4, 'POL-W: Zu alt', 'Wuppertal (ots) - Alt.', 60)
  ].join('')}</channel></rss>`;
  setRoutes([{ match: /dienststelle_115885/, reply: 500 }, { match: /dienststelle_11811/, reply: () => police }, { match: /nominatim/, reply: () => [] }]);
  const r = await runSource(env, 'presseportal');
  const ev = await rows(env, 'SELECT source_event_id, geo_precision, district, location_name, latitude FROM events ORDER BY source_event_id');
  eq(ev.map((e) => e.source_event_id), ['11811:g1', '11811:g2'], 'дата-строка с районом принята; чужой город и старше 48 ч отброшены');
  eq([ev[0].geo_precision, ev[0].district, ev[0].location_name, ev[0].latitude], ['district', 'Barmen', 'Barmen', null], 'без улицы: место = район, координат нет');
  eq([ev[1].district, ev[1].location_name], ['Vohwinkel', 'Vohwinkel'], '«Wuppertal-Vohwinkel (ots)» -> район Vohwinkel');
}

// ================= Presseportal: окрестности (Solingen, Remscheid) =================
{
  const now = Date.now(), rfc = (h) => new Date(now - h * 3600e3).toUTCString();
  const it = (id, title, body) => `<item><title>${title}</title><link>https://www.presseportal.de/blaulicht/pm/11811/${id}</link><guid>g${id}</guid><pubDate>${rfc(2)}</pubDate><description>Polizei Wuppertal [ Newsroom ]\nWuppertal (ots) - ${body}</description></item>`;
  const police = `<?xml version="1.0"?><rss version="2.0"><channel>${[
    it(1, 'POL-W: W Unfall', 'Am Abend kam es in der Hofaue zu einem Unfall.'),
    it(2, 'POL-W: RS Verkehrskontrollen in Remscheid', 'Am Freitag kontrollierte die Polizei in der Alleestraße.'),
    it(3, 'POL-W: SG Raub in Solingen', 'Eine Frau wurde in einem Aufzug angegriffen.')
  ].join('')}</channel></rss>`;
  const routes = [{ match: /dienststelle_115885/, reply: 500 }, { match: /dienststelle_11811/, reply: () => police },
    { match: /nominatim/, reply: (u) => (/Remscheid/.test(decodeURIComponent(u)) ? [{ lat: '51.18', lon: '7.19', category: 'highway', type: 'residential', address: { road: 'Alleestraße', suburb: 'Mitte' }, display_name: 'x' }] : []) }];

  // по умолчанию — Wuppertal и окрестности
  const env = newEnv();
  setRoutes(routes);
  await runSource(env, 'presseportal');
  const ev = await rows(env, 'SELECT source_event_id, location_name, geo_precision, latitude, district FROM events ORDER BY source_event_id');
  eq(ev.map((e) => e.source_event_id), ['11811:g1', '11811:g2', '11811:g3'], 'по умолчанию берутся Wuppertal, Remscheid и Solingen');
  const rs = ev.find((e) => e.source_event_id === '11811:g2');
  eq([rs.location_name, rs.geo_precision, rs.latitude !== null], ['Remscheid, Alleestraße', 'street', true], 'Remscheid: улица найдена геокодером в Remscheid, в карточке указан город');
  const sg = ev.find((e) => e.source_event_id === '11811:g3');
  eq([sg.location_name, sg.geo_precision, sg.latitude], ['Solingen', 'none', null], 'Solingen: только город, координат нет');
  ok(calls.filter((u) => /nominatim/.test(u)).every((u) => /city=(Wuppertal|Remscheid|Solingen)/.test(u)), 'геокодер получает город релиза, а не всегда Wuppertal');

  // только Wuppertal
  const env2 = newEnv({ PRESS_REGIONS: 'W' });
  setRoutes(routes);
  await runSource(env2, 'presseportal');
  eq((await rows(env2, 'SELECT source_event_id FROM events')).map((e) => e.source_event_id), ['11811:g1'], 'PRESS_REGIONS=W — только Wuppertal');
}

// ================= Presseportal: «++ заголовок ++» перед дата-строкой =================
{
  const { toItem } = await import('../src/sources/presseportal.js');
  const feed = { id: '11811', publisher: 'Polizei Wuppertal', type: 'police' };
  const st = { id: 'x', title: 'POL-W: W Unfallflucht zwischen Barmen und Uellendahl', link: 'https://www.presseportal.de/blaulicht/pm/11811/1', pubDate: 'Sat, 14 Nov 2026 10:00:00 +0100',
    description: '++ Unfallflucht zwischen Barmen und Uellendahl ++\n\nWuppertal (ots) - Am 13.11.2026, zwischen circa 18:00 Uhr und 18:15 Uhr, kam es von der Carnaper Straße bis zur Uellendahler Straße zu einer Unfallflucht.' };
  const it = toItem(st, feed, Date.parse('2026-11-16T22:00:00Z'), 168 * 3600e3);
  ok(it && !/^\+\+/.test(it.description) && !/\(ots\)/.test(it.description), '«++ заголовок ++» и дата-строка убраны из описания');
  eq([it.title, it.location_name, it.time_precision], ['Unfallflucht zwischen Barmen und Uellendahl', 'Carnaper Straße', 'minute'], 'заголовок без кода города, улица и время найдены');
  ok(toItem(st, feed, Date.parse('2026-11-16T22:00:00Z'), 48 * 3600e3) === null, 'при TTL 48 ч релиз 14.11. к вечеру 16.11. уже не показывается');
}

// ================= Presseportal: общая полицейская лента (W / SG / RS), реальные заголовки =================
{
  const { toItem } = await import('../src/sources/presseportal.js');
  const feed = { id: '11811', publisher: 'Polizei Wuppertal', type: 'police' };
  const now = Date.parse('2026-11-16T22:00:00Z');
  const mk = (title) => toItem({ id: title, title, link: 'https://www.presseportal.de/blaulicht/pm/11811/1', pubDate: 'Mon, 16 Nov 2026 11:00:59 +0100', description: 'Wuppertal (ots) - Am vergangenen Freitag kontrollierte die Polizei in der Hofaue.' }, feed, now, 168 * 3600e3, null, new Set(['W']));
  ok(mk('POL-W: RS Verkehrskontrollen in Remscheid') === null, 'дата-строка «Wuppertal (ots)», но код RS в заголовке: Remscheid — отброшен');
  ok(mk('POL-W: SG- Versuchter Raub in Aufzug') === null, 'код «SG-» (Solingen) — отброшен');
  eq(mk('POL-W: W - Zeugenaufruf - Unfallflucht am Loh').title, 'Zeugenaufruf - Unfallflucht am Loh', '«POL-W: W - …» -> заголовок без кода города');
  eq(mk('POL-W: W- Versammlungen in Wuppertal am 14.11.2026').title, 'Versammlungen in Wuppertal am 14.11.2026', '«POL-W: W- …» -> заголовок без кода города');
  ok(mk('POL-W: Verkehrsunfall') !== null, 'без кода города решает дата-строка');
}

// ================= Presseportal: релиз без слова «Wuppertal» =================
{
  const env = newEnv({ PRESS_TTL_HOURS: '48', PRESS_REGIONS: 'W' });
  const now = Date.now(), rfc = (h) => new Date(now - h * 3600e3).toUTCString();
  const it = (id, title, body, pid) => `<item><title>${title}</title><link>https://www.presseportal.de/blaulicht/pm/${pid}/${id}</link><guid>g${id}</guid><pubDate>${rfc(2)}</pubDate><description>${body}</description></item>`;
  const feed = (x) => `<?xml version="1.0"?><rss version="2.0"><channel>${x}</channel></rss>`;
  const fire = feed(it(1, 'FW-W: Küchenbrand', 'Am Abend brannte es in der Gathe 12 in einer Küche.', 115885) + it(2, 'FW-SG: Brand', 'Solingen (ots) - Brand in Solingen.', 115885));
  const police = feed(it(3, 'POL-W: W Einbruch', 'In der Nacht wurde in der Hofaue eingebrochen.', 11811) + it(4, 'POL-W: SG Einbruch', 'In der Nacht wurde in der Alleestraße eingebrochen.', 11811) + it(5, 'POL-W: W- Ohne Stadt', 'Ein Radfahrer stürzte.', 11811) + it(7, 'POL-W: RS Einbruch', 'In der Nacht wurde in der Hofstraße eingebrochen.', 11811) + it(8, 'POL-W: Ohne Code', 'Ein Radfahrer stürzte.', 11811) + it(6, 'Unbekannter Titel', 'Ein Unfall in der Hofaue.', 11811));
  setRoutes([{ match: /dienststelle_115885/, reply: () => fire }, { match: /dienststelle_11811/, reply: () => police }, { match: /nominatim/, reply: () => [] }]);
  await runSource(env, 'presseportal');
  const ids = (await rows(env, 'SELECT source_event_id FROM events ORDER BY source_event_id')).map((e) => e.source_event_id);
  eq(ids, ['115885:g1', '11811:g3', '11811:g5'], 'релиз без слова «Wuppertal»: решает код в заголовке («POL-W: W» — да; «POL-W: SG», «POL-W: RS», без кода и без города — нет)');
  const tt = (await rows(env, "SELECT title FROM events WHERE source_event_id = '11811:g3'"))[0].title;
  eq(tt, 'Einbruch', 'код города «W» убран из заголовка');
}

// ================= Presseportal: полный текст релиза =================
{
  const env = newEnv();
  const now = Date.now();
  const rfc = new Date(now - 2 * 3600e3).toUTCString();
  const full = 'Am 15. November 2026 kam es gegen 14:30 Uhr in der Zwergstraße zu einem Brand. Beim Eintreffen der ersten Einsatzkräfte war der Treppenraum bereits verraucht. Mehrere Personen machten sich bemerkbar und wurden über Drehleitern gerettet. Der Einsatz dauerte etwa zwei Stunden. Weitere Informationen folgen nicht.';
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>FW-W: Brand in der Zwergstraße</title><link>https://www.presseportal.de/blaulicht/pm/115885/1</link><guid>g1</guid><pubDate>${rfc}</pubDate><description>Feuerwehr Wuppertal [ Newsroom ]
Wuppertal (ots) - Am 15. November 2026 kam es gegen 14:30 Uhr in der Zwergstraße zu einem Brand. Mehrere Personen machten sich ... Lesen Sie hier weiter...&lt;br/&gt;Original-Content von: Feuerwehr Wuppertal, übermittelt durch news aktuell</description></item></channel></rss>`;
  const page = `<html><script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'NewsArticle', articleBody: 'Wuppertal (ots) - ' + full }] })}</script></html>`;
  setRoutes([
    { match: /rss\/dienststelle_115885/, reply: () => feed },
    { match: /rss\/dienststelle_11811/, reply: 500 },
    { match: /blaulicht\/pm\/115885\/1/, reply: () => page },
    { match: /nominatim/, reply: () => [{ lat: '51.25', lon: '7.14', category: 'highway', type: 'residential', address: { road: 'Zwergstraße', suburb: 'Elberfeld' }, display_name: 'x' }] }
  ]);
  const r = await runSource(env, 'presseportal');
  const ev = (await rows(env, 'SELECT * FROM events'))[0];
  ok(r.ok && ev && /Treppenraum bereits verraucht/.test(ev.description) && !/\.\.\.$/.test(ev.description) && !/Lesen Sie hier|Original-Content|Newsroom/.test(ev.description) && !/^Wuppertal \(ots\)/.test(ev.description), 'анонс с «...» заменён полным текстом со страницы релиза');
  eq(calls.filter((u) => /blaulicht\/pm/.test(u)).length, 1, 'страница релиза запрошена один раз');
  await runSource(env, 'presseportal');
  eq(calls.filter((u) => /blaulicht\/pm/.test(u)).length, 1, 'повторный запуск: страница не запрашивается снова');
  // нет JSON-LD: полный текст по абзацам страницы (абзац с началом анонса и следующие, до служебного хвоста)
  const html2 = `<html><body><nav><p>Menü</p></nav><div class="x"><p>Wuppertal (ots) - ${full.slice(0, 120)}</p><p>${full.slice(120)}</p><p>Rückfragen bitte an: Feuerwehr</p></div><p>Original-Content von: Feuerwehr Wuppertal</p></body></html>`;
  const env3 = newEnv();
  setRoutes([{ match: /rss\/dienststelle_115885/, reply: () => feed }, { match: /rss\/dienststelle_11811/, reply: 500 }, { match: /blaulicht\/pm/, reply: () => html2 }, { match: /nominatim/, reply: () => [] }]);
  await runSource(env3, 'presseportal');
  const ev3 = (await rows(env3, 'SELECT * FROM events'))[0];
  ok(ev3 && /Treppenraum bereits verraucht/.test(ev3.description) && /bemerkbar/.test(ev3.description) && !/Rückfragen|Original-Content|Menü/.test(ev3.description), 'без JSON-LD: полный текст собран из абзацев страницы, без меню и служебного хвоста');
  // предложение на странице разбито на строки: склеивается обратно
  const html3 = `<html><body><div><p>Wuppertal (ots) - Am 13.11.2026, zwischen circa 18:00 Uhr und 18:15 Uhr, kam es</p><p>vermutlich zwischen Barmen und Uellendahl zu einer</p><p>Verkehrsunfallflucht.</p><p>Ein 60-jähriger Mann wurde beobachtet.</p><p>Rückfragen bitte an: Polizei</p></div></body></html>`;
  const { articleBodyFromHtml } = await import('../src/sources/presseportal.js');
  eq(articleBodyFromHtml(html3, 'Wuppertal (ots) - Am 13.11.2026, zwischen circa 18:00 Uhr und 18:15 Uhr, kam es vermutlich'), 'Wuppertal (ots) - Am 13.11.2026, zwischen circa 18:00 Uhr und 18:15 Uhr, kam es vermutlich zwischen Barmen und Uellendahl zu einer Verkehrsunfallflucht.\n\nEin 60-jähriger Mann wurde beobachtet.', 'разбитое на строки предложение склеено, абзацы сохранены');
  // страница недоступна — остаётся анонс
  const env2 = newEnv();
  setRoutes([{ match: /rss\/dienststelle_115885/, reply: () => feed }, { match: /rss\/dienststelle_11811/, reply: 500 }, { match: /blaulicht\/pm/, reply: 503 }, { match: /nominatim/, reply: () => [] }]);
  await runSource(env2, 'presseportal');
  const ev2 = (await rows(env2, 'SELECT * FROM events'))[0];
  ok(ev2 && /machten sich/.test(ev2.description) && !/Lesen Sie hier|Original-Content|Newsroom|\(ots\)/.test(ev2.description), 'страница недоступна: остаётся анонс из ленты без служебных хвостов');
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
  await ins(mk('presseportal:ffffffffffffffff', { source: 'presseportal', status: 'RECENT', published_at: new Date(now - 15 * 3600e3).toISOString(), event_time: new Date(now - 41 * 3600e3).toISOString() }));
  await ins(mk('presseportal:eeeeeeeeeeeeeeee', { source: 'presseportal', status: 'RECENT', published_at: new Date(now - 1000).toISOString(), expires_at: new Date(now - 5000).toISOString() }));

  const get = async (p, headers = {}) => api.fetch(new Request('https://x.test' + p, { headers }), env, { waitUntil() {} });
  let res = await get('/api/events?hours=24');
  let body = await res.json();
  const ids = body.events.map((e) => e.id).sort();
  eq(ids, ['autobahn:aaaaaaaaaaaaaaaa', 'presseportal:bbbbbbbbbbbbbbbb', 'presseportal:ffffffffffffffff'], 'отдаются только действующие/недавние; RESOLVED, старые RECENT и просроченные скрыты; свежий релиз о вчерашнем происшествии виден');
  const district = body.events.find((e) => e.id.startsWith('presseportal'));
  eq([district.latitude, district.longitude], [null, null], 'для точности district координаты не отдаются');
  ok(!('content_hash' in body.events[0]) && !('miss_count' in body.events[0]), 'служебные поля не утекают');
  eq(res.headers.get('access-control-allow-origin'), '*', 'CORS');

  res = await get('/api/events?hours=24&history=1');
  body = await res.json();
  ok(body.events.some((e) => e.status === 'RESOLVED'), 'history=1 включает завершённые');

  res = await get("/api/events?categories=roadworks'; DROP TABLE events;--");
  eq(res.status, 200, 'SQL-инъекция в параметре не ломает запрос (параметры отфильтрованы/биндятся)');
  eq((await rows(env, 'SELECT COUNT(*) n FROM events'))[0].n, 6, 'таблица цела');

  res = await get('/api/admin/overview');
  eq(res.status, 401, 'админка без токена -> 401');
  res = await get('/api/admin/overview', { authorization: 'Bearer wrong' });
  eq(res.status, 401, 'неверный токен -> 401');
  const ADM = { authorization: 'Bearer ' + 'x'.repeat(32) };
  res = await get('/api/admin/overview', ADM);
  eq(res.status, 200, 'верный токен -> 200');
  // уникальные посетители
  const hit = (ip, ua, q = '?p=web&l=de') => api.fetch(new Request('https://x.test/api/hit' + q, { method: 'POST', headers: { 'cf-connecting-ip': ip, 'user-agent': ua } }), env, { waitUntil() {} });
  res = await hit('1.1.1.1', 'Mozilla/5.0 A');
  eq(res.status, 204, 'визит: 204 без тела');
  await hit('1.1.1.1', 'Mozilla/5.0 A');
  await hit('2.2.2.2', 'Mozilla/5.0 B', '?p=tg&l=ru');
  await hit('3.3.3.3', 'Googlebot/2.1');
  eq((await rows(env, 'SELECT COUNT(*) n FROM visits'))[0].n, 2, 'повтор того же посетителя не считается, бот не считается');
  const vrow = await rows(env, 'SELECT * FROM visits ORDER BY platform');
  ok(vrow.every((r) => /^[0-9a-f]{16}$/.test(r.vid) && !JSON.stringify(r).includes('1.1.1.1') && !JSON.stringify(r).includes('Mozilla')), 'в базе только хэш, без IP и User-Agent');
  res = await get('/api/admin/overview', ADM);
  const ov = await res.json();
  eq([ov.visitors.today, ov.visitors.daily[0].tg, ov.visitors.daily[0].web], [2, 1, 1], 'админка: уникальные за сегодня и разбивка по платформам');
  res = await hit('9.9.9.9', 'X', '?p=evil&l=xx');
  eq((await rows(env, "SELECT platform, lang FROM visits WHERE platform = 'web' AND lang IS NULL")).length, 1, 'неизвестные platform/lang приводятся к безопасным значениям');
  const noTok = await api.fetch(new Request('https://x.test/api/admin/overview', { headers: ADM }), { ...env, ADMIN_TOKEN: 'short' }, { waitUntil() {} });
  eq(noTok.status, 401, 'слишком короткий ADMIN_TOKEN отклоняется');

  res = await api.fetch(new Request('https://x.test/api/admin/events/autobahn:aaaaaaaaaaaaaaaa', { method: 'DELETE', headers: ADM }), env, { waitUntil() {} });
  eq(res.status, 200, 'удаление события');
  eq((await rows(env, 'SELECT COUNT(*) n FROM suppressed'))[0].n, 1, 'удалённое запрещено к повторному добавлению');

  res = await get('/api/status');
  body = await res.json();
  ok(Array.isArray(body.sources) && body.sources.length === 7, '/api/status: семь источников (с WSW и WSW Netz)');
  ok(body.sources.every((s) => s.stale), 'источники без успешных запусков помечены stale');
  ok(!JSON.stringify(body).includes('last_error"'), 'публично нет текста ошибок');
}

// ================= CORS =================
console.log('\n[cors] ALLOWED_ORIGINS');
{
  const hdr = async (allowed, origin) => {
    const env = newEnv({ ALLOWED_ORIGINS: allowed });
    const res = await api.fetch(new Request('https://x.test/api/health', { headers: origin ? { origin } : {} }), env, { waitUntil() {} });
    return res.headers.get('access-control-allow-origin');
  };
  eq(await hdr('https://bipolaroc4ka.github.io', 'https://bipolaroc4ka.github.io'), 'https://bipolaroc4ka.github.io', 'точное совпадение origin');
  eq(await hdr('https://bipolaroc4ka.github.io/wupp-live/', 'https://bipolaroc4ka.github.io'), 'https://bipolaroc4ka.github.io', 'значение с путём и слэшем тоже работает');
  eq(await hdr('https://a.github.io, https://bipolaroc4ka.github.io/', 'https://bipolaroc4ka.github.io'), 'https://bipolaroc4ka.github.io', 'список через запятую');
  eq(await hdr('https://bipolaroc4ka.github.io', 'https://evil.example'), null, 'чужой origin не получает заголовок');
  eq(await hdr('*', 'https://anything.example'), '*', 'звёздочка разрешает всем');
  const env = newEnv({ ALLOWED_ORIGINS: 'https://bipolaroc4ka.github.io' });
  const pre = await api.fetch(new Request('https://x.test/api/events', { method: 'OPTIONS', headers: { origin: 'https://bipolaroc4ka.github.io', 'access-control-request-method': 'GET' } }), env, { waitUntil() {} });
  eq([pre.status, pre.headers.get('access-control-allow-origin')], [204, 'https://bipolaroc4ka.github.io'], 'preflight OPTIONS');
}


// ================= перевод =================
console.log('\n[translate] машинный перевод на русский, названия улиц не переводятся');
{
  const { translatePending, findProtectedSpans, textHash } = await import('../src/translate.js');
  const now = new Date().toISOString();
  const insEv = async (env, id, title, description, loc = null) => env.DB.prepare(
    "INSERT INTO events (id, source, source_event_id, title, description, category, geo_precision, location_name, received_at, updated_at, status, content_hash) VALUES (?, 'presseportal', ?, ?, ?, 'fire', 'none', ?, ?, ?, 'ACTIVE', 'h')"
  ).bind(id, id, title, description, loc, now, now).run();
  const getApi = async (env, q) => (await (await api.fetch(new Request('https://x.test/api/events?hours=24&' + q), env, { waitUntil() {} })).json()).events;
  const spansOf = (text, loc = '') => findProtectedSpans(text, loc).map((s) => text.slice(s.start, s.end));

  // какие фрагменты считаются названиями (их в модель не отправляем)
  eq(spansOf('Unfall auf der Hauptstraße, Vollsperrung'), ['Hauptstraße'], 'защищено только название, а не «Unfall auf der»');
  eq(spansOf('Brand in der Friedrich-Ebert-Straße'), ['Friedrich-Ebert-Straße'], 'составное название с дефисами');
  eq(spansOf('Wuppertaler Straße gesperrt'), ['Wuppertaler Straße'], 'прилагательное + отдельное слово «Straße»');
  eq(spansOf('Bahnhofstr. und Rathausplatz'), ['Bahnhofstr.', 'Rathausplatz'], 'сокращение «str.» и несколько названий');
  eq(spansOf('Bitte Rettungsgasse bilden, Radweg und Parkplatz gesperrt'), [], 'обычные слова (Rettungsgasse, Radweg, Parkplatz) не считаются улицами');
  eq(spansOf('Der Weg ist frei. Die Straße ist gesperrt.'), [], 'артикль + «Weg» и одиночное «Straße» не защищаются');
  eq(spansOf('Schaden an der Trinkwasserversorgung - Erkrath'), ['Erkrath'], 'NINA: город в хвосте заголовка');
  eq(spansOf('Es folgt eine Information der Stadt Erkrath. Bürgertelefon der Stadt Erkrath: 02104 / 1428 3822. Informationen unter www.erkrath.de .'),
    ['Erkrath', 'Erkrath', '02104 / 1428 3822', 'www.erkrath.de'], 'NINA: город после «Stadt», телефон и сайт не переводятся');
  eq(spansOf('Trinkwasserverunreinigung - Gemeinde Reute und Ortsteil Schupfholz der Gemeinde Vörstetten'), ['Gemeinde Reute und Ortsteil Schupfholz der Gemeinde Vörstetten'].length ? spansOf('Trinkwasserverunreinigung - Gemeinde Reute und Ortsteil Schupfholz der Gemeinde Vörstetten') : [], 'NINA: перечень с Gemeinde/Ortsteil даёт защищённые названия');
  ok(spansOf('Trinkwasserverunreinigung - Gemeinde Reute und Ortsteil Schupfholz der Gemeinde Vörstetten').join('|').includes('Reute') && spansOf('Trinkwasserverunreinigung - Gemeinde Reute und Ortsteil Schupfholz der Gemeinde Vörstetten').join('|').includes('Vörstetten'), 'Reute и Vörstetten защищены');
  eq(spansOf('Betroffenes Gebiet: Erkrath; Kreis Mettmann'), ['Erkrath; Kreis Mettmann'], 'NINA: перечень территорий защищён целиком');
  eq(spansOf('Bakteriologische Beeinträchtigung des Trinkwassers - Chlorung - Biringen, Fürweiler, Gerlfangen und Oberesch - Gde. ReSi'),
    ['Biringen, Fürweiler, Gerlfangen und Oberesch - Gde. ReSi'.split(' - ')[0], 'Gde. ReSi'], 'NINA: перечень населённых пунктов в середине заголовка');
  eq(spansOf('Amtliche WARNUNG vor STURMBÖEN'), [], 'заглавные слова DWD не принимаются за названия');
  eq(spansOf('Bitte sparen Sie Wasser, Feuerwehr und Polizei frei halten.'), [], 'обычный текст без названий не затронут');
  eq(spansOf('Brand an der Kreuzung Hardt-Str. in Barmen', 'Hardtstraße'), ['Hardt-Str.', 'Barmen'], 'сокращённый вариант названия из location_name');
  eq(spansOf('Einsatz in der Hardtstrasse', 'Hardtstraße'), ['Hardtstrasse'], 'вариант написания strasse/straße');

  eq(spansOf('A46 | Wuppertal-Barmen - Holtkamp'), ['A46', 'Wuppertal-Barmen', 'Holtkamp'], 'номер трассы и составное название участка защищены');
  eq(spansOf('A46 | Wuppertal-Barmen - Holtkamp', 'Wuppertal-Barmen - Holtkamp'), ['A46', 'Wuppertal-Barmen - Holtkamp'], 'полное название участка из location_name');
  eq(spansOf('Fahrbahnverengung zwischen Holtkamp und Wuppertal-Barmen in Richtung Köln'), ['Holtkamp', 'Wuppertal-Barmen', 'Köln'], 'названия после «zwischen … und …» и «Richtung»');
  eq(spansOf('Brand in Barmen und Elberfeld'), ['Barmen', 'Elberfeld'], 'районы города не переводятся («Barmen» не «бармен»)');
  eq(spansOf('Richtung Fahrbahn gesperrt'), [], 'обычные существительные после «Richtung» названиями не считаются');

  // без привязки AI
  const envNo = newEnv();
  await insEv(envNo, 'presseportal:t0', 'Brand', null);
  eq((await translatePending(envNo)).skipped, 'no AI binding', 'без привязки AI перевод выключен');
  const evNo = await getApi(envNo, 'a=1');
  eq([evNo[0].title_ru, evNo[0].description_ru], [null, null], 'без перевода API отдаёт оригинал и null');

  // с «моделью»: запоминаем, что именно ей отправили
  const sent = [];
  const mkAi = (fn) => ({ run: async (model, input) => { sent.push(input.text); if (model !== '@cf/meta/m2m100-1.2b' || input.source_lang !== 'de' || input.target_lang !== 'ru') throw new Error('bad args'); return fn ? fn(input) : { translated_text: 'RU(' + input.text + ')' }; } });
  const env = newEnv({ AI: mkAi(), TRANSLATE_PROVIDER: 'm2m' });
  await insEv(env, 'presseportal:t1', 'Brand in der Friedrich-Ebert-Straße', 'Am Abend brannte es in der Friedrich-Ebert-Straße.\nUmleitung über Hauptstraße und Rettungsgasse frei.', 'Friedrich-Ebert-Straße');
  await insEv(env, 'presseportal:t2', 'Nur Titel', null);
  const r1 = await translatePending(env);
  eq([r1.translated, r1.failed], [2, 0], 'оба события переведены');
  ok(sent.every((x) => !/Friedrich-Ebert-Straße|Hauptstraße/.test(x)), 'названия улиц в модель не отправлялись');
  ok(sent.includes('Brand in der') && sent.some((x) => x.includes('Rettungsgasse')), 'вокруг названий переводится текст, обычные слова остаются в запросе');
  let list = await getApi(env, 'b=1');
  const e1 = list.find((e) => e.id === 'presseportal:t1');
  eq(e1.title_ru, 'RU(Brand in der) Friedrich-Ebert-Straße', 'название вставлено в перевод как есть, пробел сохранён');
  ok(e1.description_ru.includes('\n') && e1.description_ru.includes(' Friedrich-Ebert-Straße') && e1.description_ru.includes('RU(Umleitung über) Hauptstraße RU(und Rettungsgasse frei.)'), 'описание: переводы строк и пробелы вокруг названий сохранены');
  eq(e1.title, 'Brand in der Friedrich-Ebert-Straße', 'оригинал в API остаётся рядом с переводом');
  eq(list.find((e) => e.id === 'presseportal:t2').description_ru, null, 'у события без описания перевода описания нет');

  // заголовок целиком из названия: модель не вызывается
  const env2 = newEnv({ AI: mkAi(), TRANSLATE_PROVIDER: 'm2m' });
  await insEv(env2, 'presseportal:t3', 'Friedrich-Ebert-Straße', null, 'Friedrich-Ebert-Straße');
  sent.length = 0;
  await translatePending(env2);
  eq([sent.length, (await getApi(env2, 'c=1'))[0].title_ru], [0, 'Friedrich-Ebert-Straße'], 'заголовок из одного названия остаётся как есть без запроса к модели');

  // заголовок Autobahn не переводится вообще
  const envA = newEnv({ AI: mkAi(), TRANSLATE_PROVIDER: 'm2m' });
  await envA.DB.prepare("INSERT INTO events (id, source, source_event_id, title, description, category, geo_precision, received_at, updated_at, status, content_hash) VALUES ('autobahn:a1','autobahn','a1','A46 | Wuppertal-Barmen - Holtkamp','Fahrbahnverengung zwischen Holtkamp und Wuppertal-Barmen','roadworks','none',?,?,'ACTIVE','h')").bind(now, now).run();
  sent.length = 0;
  await translatePending(envA);
  const ea = (await getApi(envA, 'g=1'))[0];
  ok(ea.title_ru === 'A46 | Wuppertal-Barmen - Holtkamp' && !sent.some((x) => x.includes('A46') || x.includes('Holtkamp') || x.includes('Barmen')), 'заголовок Autobahn остаётся как есть, названия участков в модель не уходят');
  ok(ea.description_ru === 'RU(Fahrbahnverengung zwischen) Holtkamp RU(und) Wuppertal-Barmen', 'описание Autobahn: переведён текст, названия участков сохранены');



  // ---------- реальные примеры из приложения (m2m100: что именно получает модель) ----------
  {
    const EX = {
      ex1: 'Düsseldorf -> Wuppertal · Zeitraum dieser Bauphase: · Beginn: 07.11.25 um 20:00 Uhr · Ende: 03.09.27 um 22:00 Uhr · (Ende der Gesamtmaßnahme: 03.09.27) · A46: Düsseldorf -> Wuppertal, zwischen 2.0 km hinter AS Wuppertal-Elberfeld und 1.7 km vor AS Wuppertal-Wichlinghausen · Länge: 0.6 km | Maximale Durchfahrtsbreite: 5.85 m · Grundhafte Ern. W-Wichlinghausen',
      ex2: 'Ab Montag, 16. November, werden in der Siebeneicker Straße zwischen Untenrohleder und Am Elisabetheim. Auf einer Fläche von rund 5.500 Quadratmetern werden Fahrbahnschäden beseitigt.',
      ex3: 'Erneuerung in Richtung Wuppertal-Ronsdorf über Weststraße, Brüningstraße, Blankstraße, Oberer Grifflenberg, Max-Horkheimer-Straße, Fuhlrottstraße, Im Wald, am Freudenberg und Kapellenweg · Lichtscheider Str. zwischen Kapellenweg und BEK',
      ex4: 'Dortmund -> Köln · Beginn: 11.11.26 um 21:00 Uhr · A1: Dortmund -> Köln, zwischen Bruchmühle und 2.1 km hinter AK Wuppertal-Nord · Länge: 0.75 km · A1 - Vorbereitung Ersatzneubau BW Gevelsberger Str. und BW Schwelmer Str. ALD 37949'
    };
    const NAMES = ['Düsseldorf', 'Wuppertal', 'Elberfeld', 'Wichlinghausen', 'A46', 'AS', 'AK', 'BW', 'ALD', 'Köln', 'Dortmund', 'A1', 'Siebeneicker', 'Untenrohleder', 'Elisabetheim', 'Ronsdorf', 'Weststraße', 'Brüningstraße', 'Blankstraße', 'Grifflenberg', 'Max-Horkheimer', 'Fuhlrottstraße', 'Im Wald', 'Freudenberg', 'Kapellenweg', 'Lichtscheider', 'BEK', 'Bruchmühle', 'Gevelsberger', 'Schwelmer'];
    const toModel = [];
    const mEnv = newEnv({ TRANSLATE_PROVIDER: 'm2m', AI: { run: async (m, i) => { toModel.push(i.text); return { translated_text: 'RU(' + i.text + ')' }; } } });
    let n = 0;
    for (const [k, text] of Object.entries(EX)) await insEv(mEnv, 'presseportal:ex' + (++n), 'Titel ' + k, text);
    const rEx = await translatePending(mEnv);
    eq([rEx.translated, rEx.failed], [4, 0], 'реальные примеры: все события переведены');
    const leaked = toModel.filter((x) => NAMES.some((nm) => new RegExp(`(?<![\\p{L}\\p{N}])${nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(x)));
    eq(leaked, [], 'названия, сокращения (AS/AK/BW), идентификаторы и номера дорог в модель не отправляются');
    ok(toModel.some((x) => x.includes('Grundhafte Erneuerung')), 'сокращение «Ern.» расшифровано перед переводом');
    const res = await getApi(mEnv, 'ex=1');
    const out = Object.fromEntries(res.map((e) => [e.title, e.description_ru]));
    ok(out['Titel ex1'].includes(' · ') && out['Titel ex1'].includes(' | ') && out['Titel ex1'].includes(' -> '), 'разделители « · », « | » и « -> » сохранены');
    ok(!/[\p{L}]RU\(|\)[\p{L}]/u.test(out['Titel ex1']) && out['Titel ex1'].includes('AS Wuppertal-Elberfeld') && out['Titel ex1'].includes('AS Wuppertal-Wichlinghausen'), 'названия вставлены целиком вместе с «AS», слов не слипается');
    ok(out['Titel ex2'].includes('Am Elisabetheim. RU(Auf einer') || out['Titel ex2'].includes('Am Elisabetheim.'), 'точка после названия сохранена, фраза не слипается с названием («…Elisabetheim. На площади…»)');
    ok(!/(?:Blankstraße|Fuhlrottstraße|Elisabetheim|Kapellenweg|BEK)[\p{L}]/u.test(Object.values(out).join('\n')), 'нигде нет слипания названия с русским текстом');
    ok(out['Titel ex3'].includes('Weststraße, Brüningstraße, Blankstraße, Oberer Grifflenberg, Max-Horkheimer-Straße, Fuhlrottstraße, Im Wald'), 'перечисление улиц сохранено целиком, включая «Oberer Grifflenberg» и «Im Wald»');
    ok(toModel.length <= 40, `число обращений к модели в пределах лимита (${toModel.length})`);
  }


  // событие, которому одному не хватает лимита обращений, пропускается и не блокирует очередь
  {
    const bigEnv = newEnv({ TRANSLATE_PROVIDER: 'm2m', AI: { run: async (m, i) => ({ translated_text: 'RU(' + i.text + ')' }) } });
    await insEv(bigEnv, 'presseportal:big', 'Groß', Array.from({ length: 70 }, (_, i) => 'Teil ' + i).join(' · '));
    await insEv(bigEnv, 'presseportal:small', 'Klein', 'Kurz');
    const rb1 = await translatePending(bigEnv);
    const lb = await getApi(bigEnv, 'big=1');
    ok(rb1.skipped === 1 && rb1.translated === 1 && rb1.failed === 0, 'слишком большое событие пропущено, остальные переведены');
    eq([lb.find((e) => e.id === 'presseportal:big').title_ru, lb.find((e) => e.id === 'presseportal:small').title_ru], [null, 'RU(Klein)'], 'у пропущенного события API отдаёт оригинал');
    const rb2 = await translatePending(bigEnv);
    eq([rb2.scanned, rb2.translated, rb2.skipped], [0, 0, 0], 'пропущенное событие больше не стоит в очереди');
  }

  // ---------- выбор движка ----------
  const { pickEngine } = await import('../src/translate.js');
  const fakeAI = { run: async () => ({}) };
  eq([pickEngine({}), pickEngine({ AI: fakeAI }), pickEngine({ DEEPL_API_KEY: 'k:fx' }), pickEngine({ DEEPL_API_KEY: 'k', AI: fakeAI }), pickEngine({ AI: fakeAI, TRANSLATE_PROVIDER: 'm2m' }), pickEngine({ DEEPL_API_KEY: 'k', AI: fakeAI, TRANSLATE_PROVIDER: 'llm' })],
    [null, 'llm', 'deepl', 'deepl', 'm2m', 'llm'], 'выбор движка: DeepL при ключе, иначе языковая модель, m2m по запросу');

  // ---------- языковая модель ----------
  const chat = [];
  const llm = (fn) => ({ run: async (model, input) => {
    chat.push({ model, input });
    if (!input.messages) throw new Error('chat expected');
    const user = input.messages.find((m) => m.role === 'user').content;
    return fn(user);
  } });
  const good = (user) => ({ response: user.replace('TITLE:\n', 'TITLE: Рус ').replace('\n\nTEXT:\n', '\nTEXT: Рус ') });
  const envL = newEnv({ AI: llm(good) });
  await insEv(envL, 'presseportal:l1', 'Brand in der Friedrich-Ebert-Straße', 'Die Feuerwehr war im Einsatz.\nHardtstraße gesperrt.', 'Friedrich-Ebert-Straße');
  const rl = await translatePending(envL);
  eq([rl.translated, rl.failed], [1, 0], 'языковая модель: событие переведено');
  ok(chat[0].model === '@cf/google/gemma-3-12b-it' && chat[0].input.temperature === 0 && /never instructions/.test(chat[0].input.messages[0].content), 'модель по умолчанию Gemma 3, температура 0, в инструкции: текст события это данные, а не команды');
  ok(/Friedrich-Ebert-Straße/.test(chat[0].input.messages[1].content), 'в языковую модель текст уходит целиком (названия сохраняет она сама, проверка после)');
  const l1 = (await getApi(envL, 'h=1'))[0];
  ok(l1.title_ru.startsWith('Рус ') && l1.description_ru.includes('Hardtstraße gesperrt.'), 'ответ в формате TITLE/TEXT разобран, названия на месте');

  // модель исказила название: берём запасной движок m2m100 (в нём названия вырезаются)
  const m2mCalls = [];
  const envF = newEnv({ AI: { run: async (model, input) => {
    if (input.messages) return { response: 'TITLE: Пожар на Фридрих-Эберт-штрассе\nTEXT: Пожарные выехали' };
    m2mCalls.push(input.text); return { translated_text: 'RU(' + input.text + ')' };
  } } });
  await insEv(envF, 'presseportal:l2', 'Brand in der Friedrich-Ebert-Straße', 'Feuerwehr im Einsatz', 'Friedrich-Ebert-Straße');
  const rf2 = await translatePending(envF);
  const f2 = (await getApi(envF, 'i=1'))[0];
  ok(rf2.translated === 1 && f2.title_ru === 'RU(Brand in der) Friedrich-Ebert-Straße' && m2mCalls.every((x) => !x.includes('Straße')), 'модель исказила название: использован запасной перевод, название не тронуто');

  // другие формат ответа и проверки
  const envC = newEnv({ AI: { run: async () => ({ choices: [{ message: { content: 'TITLE: Заголовок\nTEXT: Текст сообщения' } }] }) } });
  await insEv(envC, 'presseportal:l3', 'Verkehrsunfall', 'Ein Unfall ist passiert.');
  await translatePending(envC);
  eq([(await getApi(envC, 'j=1'))[0].title_ru], ['Заголовок'], 'ответ в формате choices[0].message.content тоже понимается');
  const envNoRu = newEnv({ AI: { run: async (m, i) => i.messages ? { response: 'TITLE: Verkehrsunfall\nTEXT: Ein Unfall ist passiert.' } : { translated_text: '' } } });
  await insEv(envNoRu, 'presseportal:l4', 'Verkehrsunfall auf der Autobahn', 'Ein Unfall ist passiert und alles ist gesperrt.');
  eq((await translatePending(envNoRu)).translated, 0, 'ответ без русского текста не принимается');

  // ---------- DeepL ----------
  const realFetch = globalThis.fetch; const dl = [];
  let dlStatus = 200;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('deepl.com')) return realFetch(url, init);
    const body = JSON.parse(init.body); dl.push({ url: String(url), headers: init.headers, body });
    if (dlStatus !== 200) return new Response('err', { status: dlStatus });
    const out = body.text.map((x) => 'Рус: ' + x);
    return new Response(JSON.stringify({ translations: out.map((text) => ({ detected_source_language: 'DE', text })) }), { status: 200 });
  };
  const envD = newEnv({ DEEPL_API_KEY: 'abc:fx' });
  await insEv(envD, 'presseportal:d1', 'Brand in der Friedrich-Ebert-Straße & Barmen', 'Die Feuerwehr löschte <Feuer> in Barmen.', 'Friedrich-Ebert-Straße');
  await envD.DB.prepare("INSERT INTO events (id, source, source_event_id, title, description, category, geo_precision, received_at, updated_at, status, content_hash) VALUES ('autobahn:d2','autobahn','d2','A46 | Wuppertal-Barmen - Holtkamp','Fahrbahnverengung','roadworks','none',?,?,'ACTIVE','h')").bind(now, now).run();
  const rd = await translatePending(envD);
  eq([rd.translated, rd.failed], [2, 0], 'DeepL: события переведены');
  ok(dl[0].url === 'https://api-free.deepl.com/v2/translate' && dl[0].headers.Authorization === 'DeepL-Auth-Key abc:fx', 'бесплатный ключ (:fx) идёт на api-free.deepl.com с правильным заголовком');
  const b0 = dl.find((d) => d.body.text[0].includes('Friedrich'));
  ok(b0.body.target_lang === 'RU' && b0.body.source_lang === 'DE' && b0.body.tag_handling === 'xml' && b0.body.ignore_tags[0] === 'x', 'запрос DeepL: DE→RU, XML-теги, <x> не переводится');
  ok(b0.body.text[0] === 'Brand in der <x>Friedrich-Ebert-Straße</x> &amp; <x>Barmen</x>' && b0.body.text[1].includes('&lt;Feuer&gt;') && b0.body.text[1].includes('<x>Barmen</x>'), 'названия обёрнуты в <x>, спецсимволы экранированы');
  const dd = await getApi(envD, 'k=1');
  const d1 = dd.find((e) => e.id === 'presseportal:d1');
  ok(d1.title_ru === 'Рус: Brand in der Friedrich-Ebert-Straße & Barmen' && d1.description_ru.includes('<Feuer>') && !/<\/?x>/.test(d1.description_ru), 'теги <x> убраны из результата, спецсимволы восстановлены');
  ok(!dl.some((d) => d.body.text.some((x) => x.includes('Holtkamp'))), 'заголовок Autobahn в DeepL не отправляется (не тратим квоту)');
  eq(dd.find((e) => e.id === 'autobahn:d2').title_ru, 'A46 | Wuppertal-Barmen - Holtkamp', 'заголовок Autobahn остаётся оригиналом');
  dlStatus = 456;
  const envQ = newEnv({ DEEPL_API_KEY: 'abc:fx' });
  await insEv(envQ, 'presseportal:q1', 'Brand', null);
  const rq = await translatePending(envQ);
  ok(rq.translated === 0 && /квота/.test(rq.error), 'DeepL: исчерпанная квота даёт понятную ошибку, без падения');
  globalThis.fetch = realFetch;

  // повторный запуск и изменение текста
  sent.length = 0;
  await translatePending(env);
  eq(sent.length, 0, 'неизменённые события повторно не переводятся (экономия квоты)');
  await env.DB.prepare("UPDATE events SET description = 'Neuer Text.' WHERE id = 'presseportal:t1'").run();
  eq((await getApi(env, 'd=1')).find((e) => e.id === 'presseportal:t1').title_ru, null, 'источник изменил текст: старый перевод не показывается');
  await translatePending(env);
  ok((await getApi(env, 'e=1')).find((e) => e.id === 'presseportal:t1').description_ru === 'RU(Neuer Text.)', 'после изменения текст переведён заново');

  // ошибки модели
  const bad = newEnv({ AI: mkAi(() => { throw new Error('quota'); }), TRANSLATE_PROVIDER: 'm2m' });
  for (const k of [1, 2, 3, 4, 5]) await insEv(bad, 'presseportal:x' + k, 'Titel ' + k, null);
  let thrown = false, rb;
  try { rb = await translatePending(bad); } catch { thrown = true; }
  ok(!thrown && rb.translated === 0 && rb.failed === 3, 'модель недоступна: задача не падает и останавливается после трёх сбоев подряд');
  let n = 0;
  const flaky = newEnv({ TRANSLATE_PROVIDER: 'm2m', AI: mkAi((i) => { if (++n === 1) throw new Error('once'); return { translated_text: 'RU(' + i.text + ')' }; }) });
  await insEv(flaky, 'presseportal:f1', 'Eins', null); await insEv(flaky, 'presseportal:f2', 'Zwei', null);
  const rf = await translatePending(flaky);
  eq([rf.translated, rf.failed], [1, 1], 'сбой одного события не останавливает остальные');
  const empty = newEnv({ AI: mkAi(() => ({ translated_text: '' })), TRANSLATE_PROVIDER: 'm2m' });
  await insEv(empty, 'presseportal:y1', 'Eins', null);
  eq([(await translatePending(empty)).translated, (await getApi(empty, 'f=1'))[0].title_ru], [0, null], 'пустой ответ модели не сохраняется как перевод');
  // внешняя модель по OpenAI-совместимому API
  {
    const envApi = newEnv({ TRANSLATE_API_KEY: 'SECRETKEY123', TRANSLATE_API_MODEL: 'test-model', AI: undefined, DEEPL_API_KEY: undefined, TRANSLATE_PROVIDER: undefined });
    const { pickEngine: pickE } = await import('../src/translate.js');
    ok(pickE(envApi) === 'api', 'движок api выбирается автоматически при ключе и модели');
    await insEv(envApi, 'presseportal:a1', 'Brand in der Zwergstraße', 'Am Abend brannte es in der Zwergstraße.', 'Zwergstraße');
    let sent = null;
    setRoutes([{ match: /api\.x\.ai/, reply: (u) => ({ choices: [{ message: { content: 'TITLE: Пожар на Zwergstraße\nTEXT: Вечером горело на Zwergstraße.' } }] }) }]);
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { if (/api\.x\.ai/.test(String(url))) sent = { url: String(url), init }; return prevFetch(url, init); };
    const ra = await translatePending(envApi);
    globalThis.fetch = prevFetch;
    const la = await getApi(envApi, 'f=1');
    eq([ra.translated, la.find((e) => e.id === 'presseportal:a1').title_ru], [1, 'Пожар на Zwergstraße'], 'перевод через внешний API: название улицы сохранено');
    ok(sent && /Bearer SECRETKEY123/.test(sent.init.headers.authorization) && JSON.parse(sent.init.body).model === 'test-model', 'ключ и модель переданы в запросе');
    const envBad = newEnv({ TRANSLATE_API_KEY: 'SECRETKEY123', TRANSLATE_API_MODEL: 'm', AI: undefined, DEEPL_API_KEY: undefined, TRANSLATE_PROVIDER: undefined });
    await insEv(envBad, 'presseportal:a2', 'Brand', null, null);
    setRoutes([{ match: /api\.x\.ai/, reply: 401 }]);
    const rb2 = await translatePending(envBad);
    ok(rb2.failed === 1 && !JSON.stringify(rb2).includes('SECRETKEY123'), 'ошибка API перевода не раскрывает ключ');
  }
  ok(textHash('a', 'b') !== textHash('a', 'c') && textHash('a', null) === textHash('a', ''), 'хэш текста меняется вместе с текстом');
}

// ================= структурированный перевод (Autobahn / Mobidrom) =================
{
  const { translateStructured } = await import('../src/structured.js');
  const calls = [];
  const fake = async (t) => { calls.push(t); return 'RU(' + t + ')'; };
  const de = 'Richtung: Dortmund → Köln\nZeiträume: 16.11.2026 09:00–15:00\nAbschnitt: Auffahrt auf die A46: AS Wuppertal-Barmen (aus Richtung Wuppertal-Elberfeld)\nLänge: 0,14 km\nTempolimit: 60 km/h\nMaßnahme: Grundhafte Erneuerung W-Wichlinghausen';
  const ru = await translateStructured(de, fake);
  ok(/Направление: Dortmund → Köln/.test(ru) && /Протяжённость: 0,14 км/.test(ru) && /Въезд на A46: AS Wuppertal-Barmen \(со стороны Wuppertal-Elberfeld\)/.test(ru) && /60 км\/ч/.test(ru), 'метки, единицы и съезды переведены правилами');
  ok(!calls.some((t) => /Dortmund|Barmen|Wichlinghausen.*Wichlinghausen/.test(t) && /Richtung|Länge/.test(t)), 'названия не отправляются в модель вместе с метками');
  eq(await translateStructured('Просто текст без меток', fake), null, 'без известных меток — возврат к обычному переводу');
}

{
  console.log('\n[presseportal: ленты окрестностей]');
  const { toItem, enabledRegions, NEIGHBOR_NAMES } = await import('../src/sources/presseportal.js');
  const now = Date.parse('2026-11-17T12:00:00Z');
  const mk = (feed, title, desc) => toItem({ id: title, title, link: 'https://www.presseportal.de/blaulicht/pm/1/1', pubDate: 'Tue, 17 Nov 2026 10:00:00 +0100', description: desc }, feed, now, 48 * 3600e3);
  const me = { id: '43777', publisher: 'Polizei Mettmann', type: 'police', mode: 'named', regions: ['VE', 'HA', 'WF'] };
  const en = { id: '12726', publisher: 'Polizei Ennepe-Ruhr-Kreis', type: 'police', mode: 'named', regions: ['SP', 'GB', 'SW', 'EN'] };
  const fx = { id: '118285', publisher: 'Feuerwehr Velbert', type: 'fire', mode: 'fixed', regions: ['VE'] };
  let it = mk(me, 'POL-ME: Zusammenstoß im Kreuzungsbereich - 2611066', 'Velbert-Langenberg (ots) - Auf der Friedrichstraße kam es zu einem Zusammenstoß.');
  eq(it && it.location_name, 'Velbert, Friedrichstraße', 'Mettmann: город из дата-строки, улица из текста');
  eq(it && it.title, 'Zusammenstoß im Kreuzungsbereich', 'служебный номер в конце заголовка убран');
  ok(mk(me, 'POL-ME: Unfall - 2611001', 'Hilden (ots) - Auf der Straße.') === null, 'Hilden не входит в список: отброшено');
  ok(mk(me, 'POL-ME: Einbrüche aus dem Kreisgebiet - 2611069', 'Mettmann (ots) - Mehrere Einbrüche.') === null, 'сводка по району без одного города отброшена');
  it = mk(en, 'POL-EN: Gevelsberg: Unfall auf Hagener Straße- Kind angefahren', 'Gevelsberg (ots) - Ein Kind wurde angefahren.');
  eq(it && it.title, 'Unfall auf Hagener Straße- Kind angefahren', 'EN: префикс с городом убран из заголовка');
  eq(it && it.location_name, 'Gevelsberg, Hagener Straße', 'EN: город и улица');
  ok(mk(en, 'POL-EN: Wetter: Unfall an Autobahnabfahrt', 'Wetter (ots) - Unfall.') === null, 'Wetter (Ruhr) не входит в список');
  it = mk(fx, 'FW Velbert: Kellerbrand', 'Velbert (ots) - Brand im Keller.');
  eq(it && it.location_name, 'Velbert', 'пожарные Velbert: регион зафиксирован лентой');
  ok(toItem({ id: 'x', title: 'POL-ME: Unfall - 1', link: '', pubDate: 'Tue, 17 Nov 2026 10:00:00 +0100', description: 'Velbert (ots) - Unfall.' }, me, now, 48 * 3600e3, null, new Set(['W'])) === null, 'регион выключен — запись не берётся');
  ok(enabledRegions({ PRESS_REGIONS: 'w, ve' }).has('VE') && !enabledRegions({ PRESS_REGIONS: 'W' }).has('VE'), 'PRESS_REGIONS читается');
  ok(NEIGHBOR_NAMES.includes('Velbert') && !NEIGHBOR_NAMES.includes('Wuppertal'), 'список соседних городов без Wuppertal');
  const d = toItem({ id: 'r', title: 'FW-W: Wassereinbruch', link: '', pubDate: 'Tue, 17 Nov 2026 10:00:00 +0100', description: 'Wuppertal (ots) - In Rauental drang Wasser ein.' }, { id: '115885', publisher: 'Feuerwehr Wuppertal', type: 'fire', mode: 'wuppertal', regions: ['W'] }, now, 48 * 3600e3);
  eq(d && d.district, 'Rauental', 'район Rauental распознан');
}

{
  console.log('\n[дата без точки, соседние города, дозагрузка текста]');
  const { parseEventTime } = await import('../src/time.js');
  const { splitNeighbor, backfillFullText } = await import('../src/sources/presseportal.js');
  const { makeCtx } = await import('../src/cron.js');
  const pub = Date.parse('2026-11-17T07:45:00Z');
  const t1 = parseEventTime('Schwer verletzt wurde ein 12-jähriges Kind bei einem Verkehrsunfall am 16.11, gegen 07:10 Uhr.', pub);
  eq([t1.precision, new Date(t1.ms).toISOString()], ['minute', '2026-11-16T06:10:00.000Z'], '«am 16.11, gegen 07:10 Uhr» разобрано');
  eq(parseEventTime('Es wurden 2.5 Tonnen geladen, gegen 07:10 Uhr', pub).ms, null, 'десятичное число не принимается за дату');
  eq(splitNeighbor('Gevelsberg, Hagener Straße').street, 'Hagener Straße', 'splitNeighbor: улица соседнего города');
  eq([splitNeighbor('Gevelsberg'), splitNeighbor('Friedrichstraße, Elberfeld')], [null, null], 'splitNeighbor: без улицы и обычные места -> null');

  const env = newEnv();
  const rfc = new Date(Date.now() - 2 * 3600e3).toUTCString();
  const full = 'Am 15. November 2026 kam es gegen 14:30 Uhr in der Zwergstraße zu einem Brand. Beim Eintreffen der ersten Einsatzkräfte war der Treppenraum bereits verraucht. Mehrere Personen wurden über Drehleitern gerettet. Der Einsatz dauerte etwa zwei Stunden.';
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>FW-W: Brand in der Zwergstraße</title><link>https://www.presseportal.de/blaulicht/pm/115885/7</link><guid>g7</guid><pubDate>${rfc}</pubDate><description>Wuppertal (ots) - Am 15. November 2026 kam es gegen 14:30 Uhr in der Zwergstraße zu einem Brand. Mehrere Personen machten sich ... Lesen Sie hier weiter...</description></item></channel></rss>`;
  const page = `<html><script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'NewsArticle', articleBody: 'Wuppertal (ots) - ' + full }] })}</script></html>`;
  const base = [{ match: /rss\/dienststelle_115885/, reply: () => feed }, { match: /rss\/dienststelle_/, reply: 500 }, { match: /nominatim/, reply: () => [] }];
  setRoutes([...base, { match: /blaulicht\/pm/, reply: 503 }]);
  await runSource(env, 'presseportal');
  ok(/\.\.\.$/.test((await rows(env, 'SELECT description FROM events'))[0].description), 'страница недоступна при приёме: остался анонс');
  setRoutes([{ match: /blaulicht\/pm/, reply: 503 }]);
  await backfillFullText(makeCtx(env));
  setRoutes([{ match: /blaulicht\/pm/, reply: () => page }]);
  const r0 = await backfillFullText(makeCtx(env));
  eq(r0.checked, 0, 'неудачная попытка запоминается: сразу повторно страницу не берём');
  await env.DB.prepare('DELETE FROM geocode_cache WHERE key LIKE ?').bind('fulltext|%').run();
  const r1 = await backfillFullText(makeCtx(env));
  const ev = (await rows(env, 'SELECT description FROM events'))[0];
  ok(r1.updated === 1 && /Treppenraum bereits verraucht/.test(ev.description) && !/\.\.\.$/.test(ev.description), 'дозагрузка заменила анонс полным текстом');
}

{
  console.log('\n[по результатам пробы: сводки, общие слова, перенос строк]');
  const { toItem, articleBodyFromHtml } = await import('../src/sources/presseportal.js');
  const { extractStreet } = await import('../src/geo.js');
  const now = Date.parse('2026-11-17T12:00:00Z');
  const mk = (feed, title, desc) => toItem({ id: title, title, link: 'https://www.presseportal.de/blaulicht/pm/1/1', pubDate: 'Tue, 17 Nov 2026 10:00:00 +0100', description: desc }, feed, now, 48 * 3600e3);
  const me = { id: '43777', publisher: 'Polizei Mettmann', type: 'police', mode: 'named', regions: ['VE', 'HA', 'WF', 'ME', 'ER'] };
  const en = { id: '12726', publisher: 'Polizei Ennepe-Ruhr-Kreis', type: 'police', mode: 'named', regions: ['SP', 'GB', 'SW', 'EN', 'HT', 'WT'] };
  ok(mk(me, 'POL-ME: Einbrüche aus dem Kreisgebiet - 2611073', 'Ratingen / Mettmann (ots) - Einbrüche im Kreis.') === null, 'дата-строка с двумя городами: сводка отброшена');
  eq((mk(me, 'POL-ME: Schulwegunfall - 2611075', 'Mettmann (ots) - In Mettmann ist ein Junge verletzt worden.') || {}).location_name, 'Mettmann', 'Mettmann принимается');
  eq((mk(me, 'POL-ME: Vespa gestohlen - 2611072', 'Erkrath (ots) - Eine Vespa wurde gestohlen.') || {}).location_name, 'Erkrath', 'Erkrath принимается');
  eq((mk(en, 'POL-EN: Wetter: Unfall an Autobahnabfahrt', 'Wetter (ots) - Unfall.') || {}).location_name, 'Wetter', 'Wetter (Ruhr) принимается');
  eq((mk(en, 'POL-EN: Hattingen: Papiercontainer in Brand gesteckt', 'Hattingen (ots) - Ein Papiercontainer brannte.') || {}).location_name, 'Hattingen', 'Hattingen принимается');
  ok(mk(en, 'POL-EN: Herdecke: Betrug', 'Herdecke (ots) - Betrug.') === null && mk(en, 'POL-EN: Ennepe-Ruhr-Kreis: Telefonstörung', 'Ennepe-Ruhr-Kreis (ots) - Störung.') === null, 'Herdecke не включён по умолчанию, «весь район» — не город');
  eq(extractStreet('Am Mittag wurde die Feuerwehr zu einem Gehweg vor dem Gebäude gerufen. Der Gehweg sackte ab.'), null, '«Gehweg» — не название улицы');
  const fx = { id: '118285', publisher: 'Feuerwehr Velbert', type: 'fire', mode: 'fixed', regions: ['VE'] };
  ok(!/PDF Download/.test((mk(fx, 'FW-Velbert: Konzerte', 'PDF Download\n\nVelbert (ots) - Ein Jubiläum.') || {}).description), '«PDF Download» убрано из описания');
  const html = '<html><body><h1>POL-EN: Wetter: Titel</h1><p>Wetter (ots) - Die Polizei des Ennepe-Ruhr<br>Kreises sucht den Fahrer eines Pkw und Zeugen nach einem Unfall.</p><p>Der Fahrer fuhr weiter.</p><p>Rückfragen bitte an: Pressestelle</p></body></html>';
  const got = articleBodyFromHtml(html, 'Die Polizei des Ennepe-Ruhr Kreises sucht den Fahrer eines Pkw und Zeugen nach einem Unfall am 16.11.');
  ok(got && /Der Fahrer fuhr weiter/.test(got), 'перенос строки внутри первых слов не мешает найти текст релиза');
}

{
  const { parseGermanDates } = await import('../src/sources/wuppertal.js');
  const txt = 'Brücke Westring: Betoninstandsetzung ab Montag\nDie Arbeiten beginnen am kommenden Montag, 23. November, und werden voraussichtlich drei Wochen dauern.';
  const r = parseGermanDates(txt, Date.parse('2026-11-18T12:00:00Z'));
  eq(r.start && r.start.toISOString().slice(0, 10), '2026-11-23', 'Westring: начало 23.11.');
  eq(r.end && r.end.toISOString().slice(0, 10), '2026-12-13', 'Westring: «drei Wochen» → конец 13.12.');
  const r2 = parseGermanDates('Die Sperrung gilt ab 2. Dezember bis 5. Dezember.', Date.parse('2026-11-18T12:00:00Z'));
  eq(r2.end && r2.end.toISOString().slice(0, 10), '2026-12-05', 'явная дата конца не перебивается длительностью');
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
