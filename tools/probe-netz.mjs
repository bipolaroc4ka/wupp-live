// Проба страниц отключений WSW Netz: есть ли список текущих störungen и откуда он грузится (HTML, JSON, iframe).
// Запуск: node probe-netz.mjs (Node 18+). Только чтение. Пришлите вывод целиком.
const UA = 'WuppertalLive-probe/1.0 (open data check)';
const URLS = ['https://www.wsw-netz.de/leistung-service/netzstoerungen/', 'https://www.wsw-netz.de/stoerungen'];
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
for (const u of URLS) {
  console.log(`\n=== ${u} ===`);
  try {
    const r = await fetch(u, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const h = await r.text();
    console.log(`${r.status} ${r.url} (${r.headers.get('content-type')}, ${h.length} байт)`);
    console.log('title:', (h.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]?.trim());
    const t = strip(h);
    const i = t.search(/st(ö|oe)rung/i);
    console.log('текст вокруг «Störung»:', t.slice(Math.max(0, i - 100), i + 900));
    console.log('iframe:', [...h.matchAll(/<iframe[^>]+src=["']([^"']+)/gi)].map((m) => m[1]).join(' | ') || 'нет');
    console.log('скрипты не с typo3temp:', [...h.matchAll(/<script[^>]+src=["']([^"']+)/gi)].map((m) => m[1]).filter((s) => !/typo3temp|typo3conf/.test(s)).slice(0, 8).join(' | ') || 'нет');
    console.log('api/json/ajax в коде:', [...new Set([...h.matchAll(/["'(]([^"'\s()]*(?:\/api\/|\.json|ajax|maps\.|geojson)[^"'\s()]*)["')]/gi)].map((m) => m[1]))].slice(0, 10).join(' | ') || 'нет');
    console.log('таблицы/списки:', (h.match(/<table/gi) || []).length, 'table,', (h.match(/<li\b/gi) || []).length, 'li');
    console.log('«keine Störung»:', /keine\s+(aktuellen?\s+)?st(ö|oe)rung/i.test(h));
  } catch (e) { console.log('ERR', e.message); }
}
console.log('\nГотово.');
