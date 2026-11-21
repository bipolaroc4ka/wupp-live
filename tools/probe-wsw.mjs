// Проба лент WSW. Запуск: node probe-wsw.mjs  (Node 18+). Только чтение. Пришлите вывод целиком.
const UA = 'WuppertalLive-probe/1.0 (open data check)';
const FEEDS = [
  'https://www.wsw-online.de/suchergebnisse/rss.xml',
  'https://www.wsw-online.de/suchergebnisse/presseinformationen.xml',
  'https://www.wsw-online.de/rss.xml'
];
const dec = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
const tag = (b, n) => { const m = b.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`, 'i')); return m ? dec(m[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''; };
for (const url of FEEDS) {
  console.log('\n=== ' + url + ' ===');
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    console.log(`HTTP ${r.status}, ${r.headers.get('content-type')}, ${t.length} байт, формат: ${/<feed\b/i.test(t) ? 'Atom' : /<rss\b/i.test(t) ? 'RSS' : '?'}`);
    const items = t.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
    console.log('записей: ' + items.length);
    items.slice(0, 15).forEach((b, i) => {
      const link = (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || tag(b, 'link');
      console.log(`\n#${i + 1} ${tag(b, 'title')}\n  дата: ${tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published')}\n  ссылка: ${link}\n  id: ${tag(b, 'guid') || tag(b, 'id')}\n  текст: ${(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 400)}`);
    });
    if (!items.length) console.log('начало ответа:\n' + t.slice(0, 1200));
  } catch (e) { console.log('ОШИБКА: ' + (e && e.message || e)); }
}
console.log('\nГотово.');
