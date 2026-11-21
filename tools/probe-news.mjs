// Проба: есть ли у местных СМИ Wuppertal открытые RSS/Atom-ленты и что в них (заголовки, даты, ссылки, язык лицензии).
// Запуск у себя: node probe-news.mjs   (Node 18+). Только чтение публичных страниц. Пришлите вывод целиком.
const UA = 'WuppertalLive-probe/1.0 (open data check)';
const SITES = [
  ['Wuppertaler Rundschau', 'https://www.wuppertaler-rundschau.de/'],
  ['WZ Wuppertal', 'https://www.wz.de/nrw/wuppertal'],
  ['Wuppertal total', 'https://wuppertal-total.de/'],
  ['Antenne NRW (Blaulicht)', 'https://antenne.nrw/blaulicht/'],
  ['Radio Wuppertal', 'https://www.radiowuppertal.de/'],
  ['news.de Polizei-News Wuppertal', 'https://www.news.de/lokales/wuppertal/']
];
const GUESS = ['feed', 'feed/', 'rss', 'rss.xml', 'feed.xml', 'atom.xml', 'index.rss', 'rssfeed.xml'];
const get = async (url, ms = 15000) => {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    return { ok: r.ok, status: r.status, type: r.headers.get('content-type') || '', url: r.url, text: await r.text() };
  } catch (e) { return { ok: false, status: 0, type: '', url, text: '', err: String(e && e.message || e) }; }
};
const dec = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (b, n) => { const m = b.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`, 'i')); return m ? dec(m[1]) : ''; };
const isFeed = (r) => r.ok && /<(?:rss|feed)\b/i.test(r.text.slice(0, 2000));
const line = (s = '') => console.log(s);

for (const [name, home] of SITES) {
  line(`\n=== ${name} (${home}) ===`);
  const origin = new URL(home).origin;
  const h = await get(home);
  line(`${h.status || 'ERR'} ${h.err || ''} (${h.text.length} байт)`);
  const cand = new Set();
  for (const m of h.text.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi)) {
    const href = (m[0].match(/href=["']([^"']+)["']/i) || [])[1];
    if (href) { try { cand.add(new URL(href.replace(/&amp;/g, '&'), home).href); } catch { /* пропуск */ } }
  }
  for (const g of GUESS) cand.add(`${origin}/${g}`);
  let shown = 0;
  for (const u of cand) {
    if (shown >= 3) break;
    const r = await get(u);
    if (!isFeed(r)) continue;
    shown++;
    const items = r.text.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
    line(`\nЛЕНТА ${r.status} ${u}  (${items.length} записей, ${r.text.length} байт)`);
    const ttl = tag(r.text, 'copyright') || tag(r.text, 'rights'); if (ttl) line('  права: ' + ttl.slice(0, 200));
    items.slice(0, 6).forEach((b) => {
      const link = (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || tag(b, 'link');
      line(`  • ${tag(b, 'title').slice(0, 110)}\n      ${tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published')} | ${link}\n      текст: ${(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 140) || '(нет)'}`);
    });
  }
  if (!shown) line('  RSS не найден');
  const rb = await get(origin + '/robots.txt');
  if (rb.ok) line(`  robots.txt: ${(rb.text.match(/^\s*disallow:.*$/gim) || []).slice(0, 5).map((s) => s.trim()).join(' ') || 'без запретов'}${/ai|gpt|claude|ccbot/i.test(rb.text) ? ' (есть правила для ботов/ИИ)' : ''}`);
}
line('\nГотово. Пришлите вывод целиком.');
