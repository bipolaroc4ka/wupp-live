// Уникальные посетители по дням. Без cookie и без хранения данных на устройстве:
// идентификатор = SHA-256(секрет + день + IP + User-Agent), усечённый до 16 символов.
// Соль меняется каждый день, поэтому связать посетителя между днями нельзя; IP и User-Agent нигде не сохраняются.
const berlinDay = (ms = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

async function visitorId(env, req, day) {
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const raw = `${env.VISITOR_SALT || env.ADMIN_TOKEN || 'wl'}|${day}|${ip}|${req.headers.get('user-agent') || ''}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// POST /api/hit?p=web|pwa|tg&l=de|ru
export async function handleHit(req, env, url) {
  if (/bot|crawl|spider|headless|lighthouse|preview/i.test(req.headers.get('user-agent') || '')) return;
  const day = berlinDay();
  const q = url.searchParams;
  const platform = ['web', 'pwa', 'tg'].includes(q.get('p')) ? q.get('p') : 'web';
  const lang = ['de', 'ru'].includes(q.get('l')) ? q.get('l') : null;
  await env.DB.prepare('INSERT OR IGNORE INTO visits (day, vid, platform, lang) VALUES (?, ?, ?, ?)')
    .bind(day, await visitorId(env, req, day), platform, lang).run();
  // старые записи (старше 90 дней) удаляем попутно, примерно раз на 200 визитов
  if (Math.random() < 0.005) {
    await env.DB.prepare('DELETE FROM visits WHERE day < ?').bind(berlinDay(Date.now() - 90 * 86400e3)).run();
  }
}

// Данные для админки: поле visitors в ответе /api/admin/overview
export async function visitorStats(db) {
  const today = berlinDay(), since = berlinDay(Date.now() - 29 * 86400e3), since7 = berlinDay(Date.now() - 6 * 86400e3);
  const rows = (await db.prepare(
    "SELECT day, COUNT(*) AS n, SUM(platform = 'tg') AS tg, SUM(platform = 'pwa') AS pwa, SUM(platform = 'web') AS web, SUM(lang = 'ru') AS ru " +
    'FROM visits WHERE day >= ? GROUP BY day ORDER BY day DESC'
  ).bind(since).all()).results || [];
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return {
    today: (byDay.get(today) || { n: 0 }).n,
    yesterday: (byDay.get(berlinDay(Date.now() - 86400e3)) || { n: 0 }).n,
    visitor_days_7: rows.filter((r) => r.day >= since7).reduce((s, r) => s + r.n, 0),
    visitor_days_30: rows.reduce((s, r) => s + r.n, 0),
    daily: rows
  };
}
