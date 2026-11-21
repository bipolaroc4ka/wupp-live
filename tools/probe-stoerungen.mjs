// Проба: есть ли у WSW Netz (электричество/вода/газ) и WSW mobil (Schwebebahn, Bus) страницы или ленты со СЕЙЧАС действующими сбоями.
// Запуск у себя: node probe-stoerungen.mjs   (Node 18+). Только чтение публичных страниц. Пришлите вывод целиком.
const UA = 'WuppertalLive-probe/1.0 (open data check)';
const KW = /st(?:ö|oe|%C3%B6)rung|stromausfall|versorgungsunterbrechung|unterbrechung|verkehrsmeldung|betriebsinfo|aktuelle-?meldung|fahrplan-?[aä]nder|rss|feed|atom|opendata|open-data|api\b|schwebebahn-?(?:info|status)|netzinfo|ausfall/i;
const get = async (url, ms = 15000) => {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    return { ok: r.ok, status: r.status, type: r.headers.get('content-type') || '', url: r.url, text: await r.text() };
  } catch (e) { return { ok: false, status: 0, type: '', url, text: '', err: String(e && e.message || e) }; }
};
const line = (s = '') => console.log(s);
const abs = (h, base) => { try { return new URL(h.replace(/&amp;/g, '&'), base).href; } catch { return null; } };

async function scanSite(name, bases, extraPaths) {
  line(`\n=== ${name} ===`);
  const seen = new Set(), found = new Set(), feeds = new Set();
  for (const b of bases) {
    const r = await get(b);
    line(`${r.status || 'ERR'} ${b} ${r.err || ''} (${r.type.split(';')[0]}, ${r.text.length} байт)`);
    if (!r.ok) continue;
    for (const m of r.text.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi)) feeds.add(m[0]);
    for (const m of r.text.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
      const u = abs(m[1], b), label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (u && (KW.test(u) || KW.test(label)) && !seen.has(u)) { seen.add(u); found.add(`${label || '(без текста)'} → ${u}`); }
    }
  }
  feeds.forEach((f) => line('  FEED: ' + f));
  [...found].slice(0, 40).forEach((f) => line('  ссылка: ' + f));

  // robots.txt: где карты сайта и что запрещено
  const origin = new URL(bases[0]).origin;
  const rb = await get(origin + '/robots.txt');
  line(`${rb.status || 'ERR'} ${origin}/robots.txt`);
  const maps = [...rb.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  if (rb.ok) rb.text.split('\n').filter((l) => /disallow|crawl-delay/i.test(l)).slice(0, 12).forEach((l) => line('  robots: ' + l.trim()));
  const queue = maps.length ? maps : [origin + '/sitemap.xml'];
  const pages = [];
  for (const sm of queue.slice(0, 4)) {
    const s = await get(sm);
    line(`${s.status || 'ERR'} ${sm} (${s.text.length} байт)`);
    const locs = [...s.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    if (/<sitemapindex/i.test(s.text)) {
      for (const sub of locs.slice(0, 6)) { const t = await get(sub); pages.push(...[...t.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])); }
    } else pages.push(...locs);
  }
  line(`  страниц в карте сайта: ${pages.length}`);
  [...new Set(pages.filter((u) => KW.test(u)))].slice(0, 40).forEach((u) => line('  sitemap: ' + u));

  line('  типичные адреса:');
  for (const p of extraPaths) {
    const r = await get(origin + p);
    const xml = /xml|rss|atom|json/i.test(r.type);
    line(`   ${r.status || 'ERR'} ${xml ? '[' + r.type.split(';')[0] + ']' : ''} ${p}`);
  }
}

await scanSite('WSW Netz (электричество, вода, газ, тепло)', ['https://www.wsw-netz.de/', 'https://www.wsw-netz.de/service/', 'https://www.wsw-netz.de/stoerung/'],
  ['/stoerung', '/stoerungen', '/stromnetz/stoerungen', '/service/stoerungen', '/stromausfall', '/rss.xml', '/feed', '/suchergebnisse/rss.xml', '/aktuelles', '/meldungen']);
await scanSite('WSW mobil (Schwebebahn, Bus)', ['https://www.wsw-online.de/mobilitaet/', 'https://www.wsw-online.de/mobilitaet/fahrplan/', 'https://www.wsw-online.de/mobilitaet/schwebebahn/'],
  ['/mobilitaet/fahrplan/aktuelle-meldungen/', '/mobilitaet/fahrplan/verkehrsmeldungen/', '/mobilitaet/fahrplan/stoerungen/', '/mobilitaet/schwebebahn/aktuelles/', '/mobilitaet/aktuelle-meldungen/', '/mobilitaet/stoerungen/']);

line('\nГотово. Пришлите вывод целиком.');
