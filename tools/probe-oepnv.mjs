// Проба источников ÖPNV для Wuppertal. Запуск у себя: node probe-oepnv.mjs   (Node 18+)
// Ничего не пишет и не меняет: только читает публичные страницы и печатает отчёт. Пришлите вывод целиком.
const UA = 'WuppertalLive-probe/1.0 (open data check)';
const get = async (url, ms = 15000) => {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    return { ok: r.ok, status: r.status, type: r.headers.get('content-type') || '', url: r.url, text: await r.text() };
  } catch (e) { return { ok: false, status: 0, type: '', url, text: '', err: String(e && e.message || e) }; }
};
const line = (s = '') => console.log(s);
const head = (t) => { line(); line('=== ' + t + ' ==='); };

// 1) WSW: ссылки на RSS/Atom, open data, Störungen на главной и в типичных местах
head('WSW: сайт');
for (const base of ['https://www.wsw-online.de/', 'https://www.wsw-online.de/mobilitaet/', 'https://www.wsw-online.de/aktuelles/', 'https://www.wsw-online.de/robots.txt', 'https://www.wsw-online.de/sitemap.xml']) {
  const r = await get(base);
  line(`${r.status || 'ERR'} ${base} ${r.err || ''} (${r.type.split(';')[0]}, ${r.text.length} байт)`);
  if (!r.ok) continue;
  const feeds = [...r.text.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi)].map((m) => m[0]);
  feeds.forEach((f) => line('  FEED: ' + f));
  const kw = [...new Set([...r.text.matchAll(/href=["']([^"']*(?:rss|feed|gtfs|opendata|open-data|störung|stoerung|fahrplanaender|fahrplanänder|verkehrsmeldung|aktuelle-meldung)[^"']*)["']/gi)].map((m) => m[1]))];
  kw.slice(0, 25).forEach((k) => line('  ссылка: ' + k));
  if (/sitemap/.test(base)) {
    const urls = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => /st(ö|oe)rung|fahrplan|meldung|aktuell|verkehr/i.test(u));
    urls.slice(0, 30).forEach((u) => line('  sitemap: ' + u));
  }
}
head('WSW: типичные адреса RSS');
for (const p of ['rss', 'feed', 'rss.xml', 'feed.xml', 'aktuelles/rss', 'aktuelles/feed', 'service/rss', 'index.php?id=rss']) {
  const r = await get('https://www.wsw-online.de/' + p);
  const isXml = /xml|rss|atom/i.test(r.type) || /^\s*<\?xml|<rss|<feed/i.test(r.text.slice(0, 200));
  line(`${r.status || 'ERR'} ${isXml ? 'XML!' : '    '} /${p}`);
}
head('Schwebebahn.de');
for (const p of ['https://schwebebahn.de/', 'https://schwebebahn.de/neuigkeiten', 'https://schwebebahn.de/feed', 'https://schwebebahn.de/rss']) {
  const r = await get(p);
  const isXml = /xml|rss|atom/i.test(r.type) || /<rss|<feed/i.test(r.text.slice(0, 300));
  line(`${r.status || 'ERR'} ${isXml ? 'XML!' : '    '} ${p}`);
}

// 2) Открытые данные NRW (CKAN): наборы про ÖPNV в реальном времени, сообщения о сбоях, GTFS
head('open.nrw (CKAN): поиск наборов');
for (const q of ['IST-Daten Bus und Bahn', 'GTFS Realtime', 'SIRI Störung', 'VRR', 'Wuppertal ÖPNV']) {
  const r = await get('https://open.nrw/api/3/action/package_search?rows=8&q=' + encodeURIComponent(q));
  line(`\n[${q}] ${r.status || 'ERR'} ${r.err || ''}`);
  try {
    const j = JSON.parse(r.text);
    for (const d of (j.result && j.result.results) || []) {
      line(`  • ${d.title}  | лицензия: ${d.license_title || d.license_id || '?'} | обновлён: ${d.metadata_modified || '?'}`);
      for (const res of (d.resources || []).slice(0, 4)) line(`      - ${res.format || '?'} ${res.name || ''} ${res.url || ''}`);
    }
  } catch { line('  (ответ не JSON; первые 150 символов: ' + r.text.slice(0, 150).replace(/\s+/g, ' ') + ')'); }
}

// 3) Mobilitätsdaten NRW: тот же портал, что у Mobidrom — доступен ли каталог
head('mobilitaetsdaten.nrw');
for (const p of ['https://www.mobilitaetsdaten.nrw/', 'https://www.mobilitaetsdaten.nrw/api/systemadapter-mobilithek-exporter/arbeitsstellen-nrw.xml']) {
  const r = await get(p);
  line(`${r.status || 'ERR'} ${p} (${r.type.split(';')[0]}, ${r.text.length} байт)`);
}
line('\nГотово. Пришлите вывод целиком.');
