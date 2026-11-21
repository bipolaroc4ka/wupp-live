// Проба 2: что внутри карты WSW Netz (WSW_Netz_Marker.js) и откуда она берёт данные о текущих störungen.
// Запуск: node probe-netz2.mjs (Node 18+). Только чтение. Пришлите вывод целиком.
const UA = 'WuppertalLive-probe/1.0 (open data check)';
const get = async (u) => { try { const r = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) }); return { s: r.status, t: await r.text(), ct: r.headers.get('content-type') }; } catch (e) { return { s: 0, t: '', ct: '', e: e.message }; } };
const page = await get('https://www.wsw-netz.de/leistung-service/netzstoerungen/');
const i = page.t.indexOf('Stromstörungen im WSW Netz');
console.log('--- HTML вокруг карты (по ключу «leaflet»/«map») ---');
for (const m of [...page.t.matchAll(/leaflet|id=["'](?:map|karte)[^"']*["']|data-(?:url|src|json|endpoint)[^>]{0,200}/gi)].slice(0, 12)) console.log(page.t.slice(Math.max(0, m.index - 150), m.index + 250).replace(/\s+/g, ' '), '\n  ...');
const js = await get('https://www.wsw-netz.de/fileadmin/leaflet/WSW_Netz_Marker.js?version=v2');
console.log(`\n--- WSW_Netz_Marker.js: ${js.s} ${js.ct} ${js.t.length} байт ---`);
console.log(js.t.slice(0, 3500));
console.log('\nURL/эндпоинты в файле:', [...new Set([...js.t.matchAll(/(?:https?:)?\/\/[^\s"'`)]+|["'`](\/[^\s"'`]*(?:json|api|csv|geo|stoer|stör)[^\s"'`]*)["'`]/gi)].map((m) => m[0]))].slice(0, 15).join('\n') || 'нет');
console.log('\nГотово.');
