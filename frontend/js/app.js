// Wuppertal Live: frontend без сборки, чистый JavaScript.
// Безопасность: все данные с сервера выводятся только через textContent / DOM-узлы (никакого innerHTML).
(() => {
  'use strict';

  const CFG = window.WL_CONFIG || {};
  const I18N = window.WL_I18N;
  const ICON = window.WL_ICONS;
  const TG = window.WL_TG;
  const TZ = 'Europe/Berlin';
  // Работы и перекрытия, идущие дольше этого срока, уходят на вкладку «Долгосрочные».
  const LONG_TERM_DAYS = Number(CFG.LONG_TERM_DAYS) > 0 ? Number(CFG.LONG_TERM_DAYS) : 1;

  // ---------- справочники ----------
  const GROUPS = ['emergency', 'traffic', 'roadworks', 'transit', 'infra', 'events'];
  const GROUP_COLOR = Object.fromEntries(GROUPS.map((g) => [g, `var(--c-${g})`]));
  const CAT_GROUP = {
    fire: 'emergency', accident: 'emergency', police: 'emergency', rescue: 'emergency', hazard: 'emergency', evacuation: 'emergency', emergency_other: 'emergency',
    road_jam: 'traffic', road_closure: 'traffic', road_accident: 'traffic', road_obstacle: 'traffic', traffic_other: 'traffic',
    roadworks: 'roadworks',
    transit_delay: 'transit', transit_cancel: 'transit', transit_detour: 'transit', transit_stop: 'transit',
    infra_power: 'infra', infra_water: 'infra', infra_damage: 'infra', flood: 'infra', heavy_rain: 'infra', warning_other: 'infra',
    weather_storm: 'infra', weather_thunder: 'infra', weather_ice: 'infra', weather_heat: 'infra', weather_other: 'infra',
    event_big: 'events', event_crowd: 'events', event_restriction: 'events'
  };
  // Центры районов приблизительные (для навигации и показа примерной области), это не границы.
  const DISTRICTS = [
    { id: 'elberfeld', name: 'Elberfeld', c: [51.2562, 7.1508], r: 2200, keys: ['elberfeld', 'ostersbaum', 'mirke', 'nützenberg', 'hesselnberg', 'lichtscheid', 'grifflenberg'] },
    { id: 'elberfeld-west', name: 'Elberfeld-West', c: [51.2430, 7.1180], r: 1900, keys: ['elberfeld-west', 'sonnborn', 'westende', 'rauental', 'friedrichsberg'] },
    { id: 'uellendahl', name: 'Uellendahl-Katernberg', c: [51.2720, 7.1380], r: 1900, keys: ['uellendahl', 'katernberg'] },
    { id: 'barmen', name: 'Barmen', c: [51.2740, 7.1980], r: 2000, keys: ['barmen', 'unterbarmen', 'wichlinghausen', 'wupperfeld'] },
    { id: 'heckinghausen', name: 'Heckinghausen', c: [51.2650, 7.2230], r: 1500, keys: ['heckinghausen'] },
    { id: 'oberbarmen', name: 'Oberbarmen', c: [51.2810, 7.2350], r: 1700, keys: ['oberbarmen'] },
    { id: 'langerfeld', name: 'Langerfeld-Beyenburg', c: [51.2850, 7.2800], r: 2600, keys: ['langerfeld', 'beyenburg'] },
    { id: 'ronsdorf', name: 'Ronsdorf', c: [51.2250, 7.2250], r: 2000, keys: ['ronsdorf'] },
    { id: 'cronenberg', name: 'Cronenberg', c: [51.2040, 7.1330], r: 2300, keys: ['cronenberg', 'küllenhahn', 'hahnerberg'] },
    { id: 'vohwinkel', name: 'Vohwinkel', c: [51.2330, 7.0590], r: 2300, keys: ['vohwinkel', 'dornap', 'schöller'] }
  ];
  const END_DATE_SOURCES = new Set(['nina', 'mobidrom', 'autobahn']);
  const SEVERITIES = new Set(['Minor', 'Moderate', 'Severe', 'Extreme']); // степени опасности CAP (NINA)
  const HOURS_OPTIONS =[3, 12, 24, 72, 168];
  const DEFAULT_HOURS = 24;

  // ---------- состояние ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* хранилище недоступно: работаем без него */ } }
  };
  const state = {
    // Немецкий — основной язык. Русский включается сам только при первом заходе, если язык браузера русский;
    // явный выбор пользователя запоминается (ключ wl_lang2) и сильнее любой догадки.
    lang: I18N[store.get('wl_lang2')] ? store.get('wl_lang2')
      : ((navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']).some((l) => /^ru\b/i.test(l)) ? 'ru' : 'de'),
    themePref: ['auto', 'light', 'dark'].includes(store.get('wl_theme')) ? store.get('wl_theme') : 'auto',
    hours: DEFAULT_HOURS,
    groupsOn: new Set(GROUPS),
    district: '',
    tab: 'now',
    events: [],
    status: null,
    generatedAt: null,
    offline: false,
    loaded: false,
    selectedId: null,
    showOriginal: false,
    known: new Set(),
    first: true,
    mapProblem: location.protocol === 'file:' ? 'fileMode' : null
  };

  const $ = (s) => document.querySelector(s);
  const t = (k, vars) => {
    let s = (I18N[state.lang] && I18N[state.lang][k]) ?? I18N.de[k] ?? I18N.ru[k] ?? k;
    if (vars) for (const [a, b] of Object.entries(vars)) s = s.replaceAll(`{${a}}`, b);
    return s;
  };
  const locale = () => I18N[state.lang].locale;

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') n.setAttribute('style', v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }
  // replaceChildren, который не превращает null/false в текст «null»
  function setKids(node, ...kids) { node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false)); }

  // ---------- высота приложения, тема, Telegram ----------
  const PALETTE = { dark: '#172126', light: '#ffffff' };
  let appH = 0;
  let mapInst = null; // карта создаётся ниже; typeof на const до объявления бросил бы ReferenceError
  function setAppH() {
    const h = Math.round(TG.viewportHeight() || window.innerHeight);
    if (h && h !== appH) {
      appH = h;
      document.documentElement.style.setProperty('--app-h', h + 'px');
      if (mapInst) mapInst.invalidateSize({ pan: false });
    }
  }
  function effectiveTheme() {
    if (state.themePref !== 'auto') return state.themePref;
    return TG.colorScheme() || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  }
  function applyTheme() {
    const th = effectiveTheme();
    document.documentElement.dataset.theme = th;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = PALETTE[th];
    TG.setChrome(PALETTE[th]);
  }
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(() => { if (state.themePref === 'auto') applyTheme(); });
  }
  setAppH();
  window.addEventListener('resize', setAppH);
  applyTheme();
  TG.ready.then((ok) => {
    if (!ok) return;
    setAppH(); applyTheme();
    // язык интерфейса Telegram — только если пользователь ещё не выбирал язык сам
    if (!I18N[store.get('wl_lang2')] && TG.languageCode() === 'ru' && state.lang !== 'ru') { state.lang = 'ru'; applyI18n(); render(); }
    TG.onTheme(applyTheme);
    TG.onViewport(setAppH);
  });

  // ---------- время ----------
  const dtf = (opts) => new Intl.DateTimeFormat(locale(), { timeZone: TZ, ...opts });
  const fmtDT = (iso) => dtf({ day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const fmtD = (iso) => dtf({ day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
  const fmtDY = (iso) => dtf({ day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
  const fmtT = (ms) => dtf({ hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  function rel(iso) {
    const diff = (Date.parse(iso) - Date.now()) / 1000;
    const a = Math.abs(diff);
    if (a < 60) return t('ago_now');
    const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
    if (a < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    return rtf.format(Math.round(diff / 86400), 'day');
  }
  function fmtDur(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
    if (d) return `${d} ${t('u_d')}${h ? ` ${h} ${t('u_h')}` : ''}`;
    if (h) return `${h} ${t('u_h')}${mi ? ` ${mi} ${t('u_m')}` : ''}`;
    return `${mi} ${t('u_m')}`;
  }

  // ---------- карта ----------
  const map = L.map('map', {
    zoomControl: false, minZoom: 10, preferCanvas: true,
    maxBounds: L.latLngBounds(CFG.CITY.bounds).pad(0.8)
  });
  mapInst = map;
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.fitBounds(CFG.CITY.bounds);
  // Если тайлы не грузятся (блокировка OSM, нет Referer, нет сети), говорим об этом, а не показываем пустую карту.
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
  }).addTo(map);
  let tileOk = 0, tileErr = 0;
  tiles.on('tileload', () => { tileOk++; if (state.mapProblem === 'tileFail') { state.mapProblem = null; syncFreshness(); } });
  tiles.on('tileerror', () => {
    tileErr++;
    if (tileOk === 0 && tileErr >= 4 && !state.mapProblem) { state.mapProblem = 'tileFail'; syncFreshness(); }
  });

  const cluster = L.markerClusterGroup({
    maxClusterRadius: 48, showCoverageOnHover: false, spiderfyOnMaxZoom: true,
    iconCreateFunction: (c) => L.divIcon({
      className: 'pin-wrap', iconSize: [40, 40],
      html: el('div', { class: 'cluster', text: c.getChildCount() })
    })
  }).addTo(map);
  const areas = L.layerGroup().addTo(map);
  let layerById = new Map();
  let lastMapSig = '';

  // ---------- справочные функции ----------
  const groupOf = (c) => CAT_GROUP[c] || 'events';

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function districtByName(name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    return DISTRICTS.find((d) => d.keys.some((k) => n.includes(k))) || null;
  }
  function inDistrict(ev, d) {
    if (ev.latitude != null) return haversine([ev.latitude, ev.longitude], d.c) <= d.r;
    const m = districtByName(ev.district);
    return !!m && m.id === d.id;
  }
  function eventTimeRef(ev) { return ev.event_time && ev.time_precision !== 'unknown' ? ev.event_time : null; }

  // Срок действия: источники Autobahn не отдают дату окончания, поэтому давно идущие работы выделяем по дате начала.
  function ageDays(ev) {
    const et = eventTimeRef(ev);
    const ms = et ? Date.parse(et) : NaN;
    return Number.isFinite(ms) ? (Date.now() - ms) / 86400000 : null;
  }
  function isLongTerm(ev) {
    const a = ageDays(ev);
    return ev.status === 'ACTIVE' && a != null && a >= LONG_TERM_DAYS;
  }
  const RANK = { LIVE: 0, ACTIVE: 1, RECENT: 2, EXPIRED: 3, RESOLVED: 4 };
  // свежесть для сортировки: более позднее из «произошло» и «опубликовано» (как окно времени в API)
  function sortTs(ev) { return Math.max(Date.parse(eventTimeRef(ev)) || 0, Date.parse(ev.published_at) || 0) || Date.parse(ev.received_at) || 0; }
  function byImportance(a, b) { return (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || sortTs(b) - sortTs(a); }

  function inArea(ev) {
    const d = DISTRICTS.find((x) => x.id === state.district);
    if (!d) return true;
    if (ev.geo_precision === 'city') return true; // предупреждение на весь город касается любого района
    return inDistrict(ev, d);
  }
  const pool = (tab) => state.events.filter((ev) => (isLongTerm(ev) ? 'long' : 'now') === tab && inArea(ev));
  const visibleEvents = () => pool(state.tab).filter((ev) => state.groupsOn.has(groupOf(ev.category))).sort(byImportance);
  const filterCount = () => (state.district ? 1 : 0) + (state.hours !== DEFAULT_HOURS ? 1 : 0) + (state.groupsOn.size < GROUPS.length ? 1 : 0);

  // Машинный перевод есть только на русский и только если пришёл с сервера; оригинал всегда доступен.
  function texts(ev, original) {
    const tr = state.lang === 'ru' && !original && ev.title_ru;
    return { title: tr ? ev.title_ru : ev.title, desc: tr ? (ev.description_ru || '') : (ev.description || ''), translated: !!tr };
  }
  const hasTranslation = (ev) => state.lang === 'ru' && !!ev.title_ru;

  // ---------- отрисовка ----------
  function applyI18n() {
    document.documentElement.lang = I18N[state.lang].htmlLang;
    $('#lblDistrict').textContent = t('district');
    $('#lblTime').textContent = t('period');
    $('#periodHint').textContent = t('periodHint');
    $('#cityBtn').textContent = t('wholeCity');
    $('#menuBtn').setAttribute('aria-label', t('menu'));
    $('#dClose').setAttribute('aria-label', t('close'));
    $('#aboutClose').setAttribute('aria-label', t('close'));
    $('#dShow').textContent = t('showOnMap');
    $('#wxClose').setAttribute('aria-label', t('close'));
    $('#wx').setAttribute('aria-label', t('wxOpen'));
    $('#wxTitle').textContent = t('wxTitle');
    renderWeather();
    $('#dCopy').setAttribute('aria-label', t('copy'));
    $('#dShare').setAttribute('aria-label', t('share'));
    setKids($('#dCopy'), ICON.make('copy', 18), t('copy'));
    setKids($('#dShare'), ICON.make('share', 18), t('share'));
    $('#aboutTitle').textContent = t('aboutTitle');
    $('#lnkImpressum').textContent = t('impressum');
    $('#lnkPrivacy').textContent = t('privacy');
    $('#filterLabel').textContent = t('filters');
    $('#sheetHandle').setAttribute('aria-label', t('toList'));
    setKids($('#filterIcon'), ICON.make('sliders', 18));
    setKids($('#menuBtn'), ICON.make('more', 22));
    setKids($('#dClose'), ICON.make('close', 22));
    setKids($('#aboutClose'), ICON.make('close', 22));
    setKids($('#sheetToggle'), ICON.make('chevron', 20));
    syncSheetUi();

    const ds = $('#districtSel');
    ds.replaceChildren(el('option', { value: '', text: t('allDistricts') }),
      ...DISTRICTS.map((d) => el('option', { value: d.id, text: d.name })));
    ds.value = state.district;
    const ts = $('#timeSel');
    ts.replaceChildren(...HOURS_OPTIONS.map((h) => el('option', { value: String(h), text: t('t' + h) })));
    ts.value = String(state.hours);

    // меню: язык, тема, ссылки
    const seg = (key, values, current, onPick) => el('div', { class: 'seg', role: 'group', 'aria-label': t(key) },
      ...values.map(([v, label]) => {
        const b = el('button', { type: 'button', 'aria-pressed': String(v === current), text: label });
        b.addEventListener('click', () => onPick(v));
        return b;
      }));
    $('#langSeg').replaceChildren(
      seg('language', [['de', 'Deutsch'], ['ru', 'Русский']], state.lang, setLang),
      seg('theme', [['auto', t('themeAuto')], ['light', t('themeLight')], ['dark', t('themeDark')]], state.themePref, setThemePref));
    setKids($('#miAbout'), ICON.make('info', 20), t('about'));
  }

  function setLang(l) {
    if (state.lang === l) return;
    state.lang = l;
    store.set('wl_lang2', l);
    applyI18n(); render();
    if (!$('#about').hidden) openAbout();
  }
  function setThemePref(p) {
    state.themePref = p;
    store.set('wl_theme', p);
    applyTheme(); applyI18n();
  }

  function renderChips() {
    const base = pool(state.tab);
    const counts = {};
    for (const ev of base) counts[groupOf(ev.category)] = (counts[groupOf(ev.category)] || 0) + 1;
    $('#groupChips').replaceChildren(...GROUPS.map((g) => {
      const on = state.groupsOn.has(g);
      const b = el('button', {
        class: 'chip' + (counts[g] ? '' : ' empty'), type: 'button', 'aria-pressed': String(on), style: `--c:${GROUP_COLOR[g]}`
      }, ICON.forGroup(g, 16), t('g_' + g), counts[g] ? el('small', { text: String(counts[g]) }) : null);
      b.addEventListener('click', () => {
        // Все группы включены: тап показывает только выбранную. Иначе тап включает/выключает группу.
        // Если выключили последнюю, снова показываем все.
        if (state.groupsOn.size === GROUPS.length) state.groupsOn = new Set([g]);
        else if (state.groupsOn.has(g)) { state.groupsOn.delete(g); if (!state.groupsOn.size) state.groupsOn = new Set(GROUPS); }
        else state.groupsOn.add(g);
        TG.haptic('select');
        render();
      });
      return b;
    }));
    const n = filterCount();
    $('#filterBadge').hidden = !n;
    $('#filterBadge').textContent = String(n);
  }

  function renderTabs() {
    const nNow = pool('now').length, nLong = pool('long').length;
    if (state.tab === 'long' && !nLong) state.tab = 'now';
    const mk = (id, label, n) => {
      const b = el('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(state.tab === id) },
        label, state.loaded ? el('small', { text: String(n) }) : null);
      b.addEventListener('click', () => { if (state.tab !== id) { state.tab = id; TG.haptic('select'); closeDetail(); render(); } });
      return b;
    };
    // вкладка «Долгосрочные» появляется только когда такие события есть
    $('#tabs').replaceChildren(mk('now', t('tabNow'), nNow), ...(nLong ? [mk('long', t('tabLong'), nLong)] : []));
  }

  function listTimeText(ev) {
    const et = eventTimeRef(ev);
    if (isLongTerm(ev)) return t('sinceDays', { n: String(Math.floor(ageDays(ev))) });
    if (et && ev.time_precision === 'minute') return rel(et);
    if (et && ev.time_precision === 'day') return fmtD(et);
    if (ev.published_at) return `${t('pubShort')} ${rel(ev.published_at)}`;
    return `${t('recvShort')} ${rel(ev.received_at)}`;
  }

  function itemEl(ev) {
    const g = groupOf(ev.category);
    const place = ev.location_name || ev.district || '';
    const btn = el('button', { class: 'item', type: 'button', style: `--c:${GROUP_COLOR[g]}` },
      el('span', { class: 'ico' }, ICON.forCategory(ev.category, 19)),
      el('span', { class: 'body' },
        el('span', { class: 't', text: texts(ev).title }),
        el('span', { class: 'm' },
          el('span', { class: 'st ' + ev.status, text: t('stShort_' + ev.status) }),
          el('span', { text: listTimeText(ev) }),
          place ? el('span', { text: place }) : null)));
    btn.addEventListener('click', () => openDetail(ev.id, true));
    return el('li', {}, btn);
  }

  function resetFilters() {
    state.district = ''; state.groupsOn = new Set(GROUPS);
    const hoursChanged = state.hours !== DEFAULT_HOURS;
    state.hours = DEFAULT_HOURS;
    applyI18n(); render();
    if (hoursChanged) load();
  }

  function renderList(evs) {
    const list = $('#list');
    if (!evs.length) {
      const msg = !state.loaded ? t('loading') : state.tab === 'long' ? t('emptyLong') : t('empty');
      const reset = state.loaded && filterCount() ? el('button', { class: 'btn', type: 'button', text: t('resetFilters') }) : null;
      if (reset) reset.addEventListener('click', resetFilters);
      list.replaceChildren(el('li', { class: 'empty' }, msg, reset ? el('br') : null, reset));
      return;
    }
    const nodes = [];
    if (state.tab === 'long') {
      nodes.push(el('li', { class: 'note-li', text: t('longList', { n: String(LONG_TERM_DAYS) }) }));
      evs.forEach((ev) => nodes.push(itemEl(ev)));
    } else {
      const live = evs.filter((e) => e.status === 'LIVE' || e.status === 'ACTIVE');
      const rest = evs.filter((e) => !(e.status === 'LIVE' || e.status === 'ACTIVE'));
      if (live.length) { nodes.push(el('li', { class: 'group', text: t('grpActive') })); live.forEach((ev) => nodes.push(itemEl(ev))); }
      if (rest.length) { nodes.push(el('li', { class: 'group', text: t('grpRecent') })); rest.forEach((ev) => nodes.push(itemEl(ev))); }
    }
    list.replaceChildren(...nodes);
  }

  function makePinEl(ev, isNew, approx) {
    const g = groupOf(ev.category);
    return el('div', {
      class: `pin st-${ev.status}${approx ? ' approx' : ''}${isNew ? ' pop' : ''}${isLongTerm(ev) ? ' lt' : ''}`,
      style: `--c:${GROUP_COLOR[g]}`
    }, ICON.forCategory(ev.category, 18));
  }

  function renderMap(evs) {
    // Перерисовываем только при изменении данных: иначе раз в минуту маркеры мигают и сбрасывается раскрытый кластер.
    const sig = evs.map((e) => `${e.id}:${e.status}:${e.updated_at}`).join('|') + '#' + state.lang + state.tab + document.documentElement.dataset.theme;
    if (sig === lastMapSig) return;
    lastMapSig = sig;
    cluster.clearLayers();
    areas.clearLayers();
    layerById = new Map();
    const markers = [];
    for (const ev of evs) {
      const color = getComputedStyle(document.documentElement).getPropertyValue('--c-' + groupOf(ev.category)).trim() || '#888';
      const isNew = !state.first && !state.known.has(ev.id);

      if (ev.latitude != null && ev.longitude != null) {
        const approx = ev.geo_precision === 'street';
        const m = L.marker([ev.latitude, ev.longitude], {
          icon: L.divIcon({ className: 'pin-wrap', iconSize: [34, 34], iconAnchor: [17, 17], html: makePinEl(ev, isNew, approx) }),
          title: ev.title, keyboard: true
        });
        m.on('click', () => openDetail(ev.id, false));
        markers.push(m);
        layerById.set(ev.id, m);
        if (approx) {
          areas.addLayer(L.circle([ev.latitude, ev.longitude], {
            radius: 160, color, weight: 1.5, dashArray: '5 5', fillColor: color, fillOpacity: 0.1, interactive: false
          }));
        }
      } else if (ev.geo_precision === 'district') {
        const d = districtByName(ev.district);
        if (d) {
          const c = L.circle(d.c, { radius: d.r, color, weight: 2, dashArray: '8 6', fillColor: color, fillOpacity: 0.08 });
          c.on('click', () => openDetail(ev.id, false));
          areas.addLayer(c);
          layerById.set(ev.id, c);
        }
      }
    }
    cluster.addLayers(markers);
  }

  // «Обновлено 21:04»: слово скрывается на узких экранах, время остаётся всегда
  function setUpdated(node, ms) {
    setKids(node, el('span', { class: 'lbl', text: t('updatedLbl') + ' ' }), el('b', { text: fmtT(ms) }));
  }

  function syncFreshness() {
    const dot = $('#freshDot'), txt = $('#freshText'), banner = $('#banner');
    const staleSources = state.status ? state.status.sources.filter((s) => s.stale) : [];
    let bannerText = null, bannerErr = false;

    if (!CFG.API_BASE) {
      dot.className = 'dot bad'; txt.textContent = t('noData');
      bannerText = t('noConfig'); bannerErr = true;
    } else if (state.offline) {
      dot.className = 'dot bad';
      if (state.generatedAt) setUpdated(txt, state.generatedAt); else txt.textContent = t('noData');
      bannerErr = true;
      bannerText = state.generatedAt ? t('offlineBanner', { time: fmtT(state.generatedAt) }) : t('loadError');
    } else if (state.generatedAt) {
      dot.className = 'dot ' + (staleSources.length ? 'warn' : 'ok');
      setUpdated(txt, state.generatedAt);
      if (staleSources.length) bannerText = `${t('staleWarn')}: ${staleSources.map((s) => s.name.split(':')[0].split('(')[0].trim()).join(', ')}`;
    } else {
      dot.className = 'dot'; txt.textContent = t('loading');
    }
    if (state.mapProblem) {
      bannerText = t(state.mapProblem) + (bannerText ? ' ' + bannerText : '');
      bannerErr = true;
    }
    banner.hidden = !bannerText;
    banner.className = 'banner' + (bannerErr ? ' error' : '');
    if (bannerText) banner.textContent = bannerText;
    updateLayout();
  }

  function render() {
    renderTabs();
    const evs = visibleEvents();
    renderChips();
    renderList(evs);
    renderMap(evs);
    syncFreshness();
    if (state.selectedId && !state.events.some((e) => e.id === state.selectedId)) closeDetail();
    else if (state.selectedId) refreshDetail();
    for (const e of state.events) state.known.add(e.id);
    if (state.loaded) state.first = false;
  }

  // ---------- карточка события ----------
  function safeUrl(u) {
    try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : null; } catch { return null; }
  }
  function tlRow(label, value, unknown, extra) {
    return el('li', { class: unknown ? 'unknown' : '' },
      el('div', { class: 'tl-l', text: label }),
      el('div', { class: 'tl-v' + (unknown ? ' unknown' : '') }, value),
      extra || null);
  }
  const withRel = (iso) => [fmtDT(iso), ' ', el('span', { class: 'rel', text: `(${rel(iso)})` })];

  function refreshDetail() {
    const ev = state.events.find((e) => e.id === state.selectedId);
    if (!ev) return;
    const g = groupOf(ev.category);
    setKids($('#dBadges'),
      el('span', { class: 'badge', style: `color:${GROUP_COLOR[g]}` }, ICON.forCategory(ev.category, 15), t('c_' + ev.category)),
      el('span', { class: 'badge ' + ev.status, text: t('st_' + ev.status) }),
      ev.is_verified ? el('span', { class: 'badge official', text: t('official') }) : null,
      ev.source === 'nina' && SEVERITIES.has(ev.severity) ? el('span', { class: 'badge', text: t('sev_' + ev.severity) }) : null);
    const tx = texts(ev, state.showOriginal);
    $('#dTitle').textContent = tx.title;
    $('#dDesc').textContent = tx.desc;
    $('#dDesc').hidden = !tx.desc;
    const tbox = $('#dTrans');
    if (hasTranslation(ev)) {
      const toggle = el('button', { type: 'button', class: 'linkbtn', text: state.showOriginal ? t('showTr') : t('showOrig') });
      toggle.addEventListener('click', () => {
        state.showOriginal = !state.showOriginal; refreshDetail();
        const nb = $('#dTrans button'); if (nb) nb.focus({ preventScroll: true }); // кнопка пересоздаётся: возвращаем фокус
      });
      setKids(tbox, el('span', { text: (state.showOriginal ? t('origDe') : t('machTr')) + ' ' }), toggle);
      tbox.hidden = false;
    } else { tbox.textContent = ''; tbox.hidden = true; }

    // Срок действия: честно говорим, что даты окончания у нас нет, а не делаем вид, что событие актуально
    const note = $('#dNote');
    const hasEnd = !!(ev.expires_at || ev.valid_until);
    if (isLongTerm(ev) && !hasEnd) {
      note.textContent = t('longDetail', { n: String(Math.floor(ageDays(ev))), date: fmtDY(ev.event_time) });
      note.hidden = false;
    } else if (ev.source === 'autobahn' && ev.status === 'ACTIVE' && !hasEnd) {
      note.textContent = t('endUnknown');
      note.hidden = false;
    } else { note.textContent = ''; note.hidden = true; }

    const place = ev.location_name || ev.district || (ev.geo_precision === 'city' ? t('wholeCity') : '');
    setKids($('#dLoc'),
      place ? el('div', {}, el('strong', { text: `${t('location')}: ` }), place) : null,
      el('div', { class: 'note', text: t('geo_' + (ev.geo_precision || 'none')) }));

    const rows = [];
    const startLabel = ev.source === 'autobahn' ? t('tStart') : t('tEvent');
    if (ev.event_time && ev.time_precision === 'minute') rows.push(tlRow(startLabel, withRel(ev.event_time)));
    else if (ev.event_time && ev.time_precision === 'day') rows.push(tlRow(startLabel, t('tDayOnly', { date: fmtD(ev.event_time) })));
    else rows.push(tlRow(startLabel, t('tEventUnknown'), true));

    if (ev.published_at) {
      const lagMs = ev.event_time && ev.time_precision === 'minute' && ev.source !== 'autobahn'
        ? Date.parse(ev.published_at) - Date.parse(ev.event_time) : null;
      rows.push(tlRow(t('tPublished'), withRel(ev.published_at), false,
        lagMs != null && lagMs > 60000 ? el('span', { class: 'tl-lag', text: t('lagPub', { d: fmtDur(lagMs) }) }) : null));
    } else rows.push(tlRow(t('tPublished'), t('tPubUnknown'), true));

    // «Действует с / до» — срок действия меры или предупреждения (не время происшествия)
    if (ev.valid_from) {
      rows.push(tlRow(t('tValidFrom'), ev.valid_from_precision === 'day' ? t('tDayOnly', { date: fmtD(ev.valid_from) }) : withRel(ev.valid_from)));
    }
    // «Действует до» только там, где это настоящая дата окончания; у пресс-релизов срок хранения — не срок действия
    if (ev.valid_until_precision === 'open') rows.push(tlRow(t('tExpires'), t('tUntilFurther')));
    else if (ev.valid_until) rows.push(tlRow(t('tExpires'), ev.valid_until_precision === 'day' ? t('tDayOnly', { date: fmtD(ev.valid_until) }) : withRel(ev.valid_until)));
    else if (ev.expires_at && END_DATE_SOURCES.has(ev.source)) rows.push(tlRow(t('tExpires'), withRel(ev.expires_at)));
    rows.push(tlRow(t('tReceived'), withRel(ev.received_at)));
    if (Math.abs(Date.parse(ev.updated_at) - Date.parse(ev.received_at)) > 60000) rows.push(tlRow(t('tUpdated'), withRel(ev.updated_at)));
    $('#dTimes').replaceChildren(...rows);

    const url = safeUrl(ev.source_url);
    setKids($('#dSource'),
      `${t('source')}: ${ev.publisher || ev.source}`, ' ',
      url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: t('openSource') }) : null);

    const show = $('#dShow');
    const hasPlace = layerById.has(ev.id);
    show.disabled = !hasPlace;
    setKids(show, ICON.make('pin', 18), hasPlace ? t('showOnMap') : t('noMapPlace'));
  }

  // На телефоне карточка закрывает нижнюю часть карты: сдвигаем центр так, чтобы объект остался виден.
  function setViewAbove(latlng, zoom) {
    if (isDesktop()) return map.setView(latlng, zoom, { animate: true });
    const lift = Math.min(window.innerHeight * 0.3, 260);
    const pt = map.project(latlng, zoom).add([0, lift]);
    map.setView(map.unproject(pt, zoom), zoom, { animate: true });
  }
  function focusLayer(id) {
    const layer = layerById.get(id);
    if (!layer) return;
    if (typeof layer.getRadius === 'function') {
      // приблизительная область (район): показываем её целиком, границы считаем без обращения к карте
      map.flyToBounds(L.latLng(layer.getLatLng()).toBounds(layer.getRadius() * 2), { padding: [40, 40] });
    } else if (layer.getLatLng) {
      const go = () => setViewAbove(layer.getLatLng(), Math.max(map.getZoom(), 15));
      if (cluster.hasLayer(layer)) cluster.zoomToShowLayer(layer, go); else go();
    }
  }

  let lastFocus = null;
  function openDetail(id, fly) {
    closeDropdowns();
    lastFocus = document.activeElement;
    state.selectedId = id;
    state.showOriginal = false;
    refreshDetail();
    $('#detail').hidden = false;
    document.body.classList.add('has-detail');
    TG.haptic('light');
    if (fly) focusLayer(id);
    $('#detail').scrollTop = 0;
    syncBack();
    $('#dClose').focus({ preventScroll: true });
  }
  function closeDetail() {
    if ($('#detail').hidden) return;
    state.selectedId = null;
    $('#detail').hidden = true;
    document.body.classList.remove('has-detail');
    syncBack();
    if (lastFocus && document.contains(lastFocus)) { try { lastFocus.focus({ preventScroll: true }); } catch { /* элемента уже нет */ } }
    lastFocus = null;
  }

  // ---------- нижняя панель ----------
  const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;
  const SHEET_STATES = ['peek', 'half', 'full'];
  const sheetEl = $('#sheet');
  const curSheet = () => SHEET_STATES.find((s) => sheetEl.classList.contains(s)) || 'peek';
  function syncSheetUi() {
    const s = curSheet();
    $('#sheetHandle').setAttribute('aria-expanded', String(s !== 'peek'));
    $('#sheetToggle').setAttribute('aria-label', t(s === 'full' ? 'collapseList' : 'expandList'));
  }
  function setSheet(s) {
    sheetEl.classList.remove(...SHEET_STATES);
    sheetEl.classList.add(s);
    syncSheetUi();
  }

  // Панель следует за пальцем и «прилипает» к одному из трёх положений: учитывается и скорость броска, и расстояние.
  // Тянуть можно за шапку (ручка и вкладки) и за сам список: свайп вверх от верха списка раскрывает панель,
  // свайп вниз от верха списка сворачивает. Кнопка-стрелка делает то же без жестов.
  (function initSheetDrag() {
    const head = $('#sheetHead'), list = $('#list');
    let d = null; // активное перетаскивание
    const HEIGHTS = () => {
      // высоты положений меряем по самому CSS, чтобы они всегда совпадали с классами peek/half/full
      const cur = curSheet();
      sheetEl.style.transition = 'none';
      const out = {};
      for (const s of SHEET_STATES) { sheetEl.classList.remove(...SHEET_STATES); sheetEl.classList.add(s); out[s] = sheetEl.offsetHeight; }
      sheetEl.classList.remove(...SHEET_STATES); sheetEl.classList.add(cur);
      void sheetEl.offsetHeight; // применить возврат к исходному положению без анимации, иначе высота «поедет» от full
      sheetEl.style.transition = '';
      return out;
    };
    function start(y) {
      const from = curSheet();
      d = { y0: y, from, snaps: HEIGHTS(), h0: sheetEl.offsetHeight, pts: [{ y, t: performance.now() }] };
      sheetEl.classList.add('dragging');
    }
    function move(y) {
      if (!d) return;
      const h = Math.min(d.snaps.full, Math.max(d.snaps.peek, d.h0 + (d.y0 - y)));
      sheetEl.style.height = h + 'px';
      d.pts.push({ y, t: performance.now() });
      if (d.pts.length > 4) d.pts.shift();
    }
    function end() {
      if (!d) return;
      const h = sheetEl.offsetHeight;
      const a = d.pts[0], b = d.pts[d.pts.length - 1];
      const v = b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0; // px/мс, положительная — вниз
      const order = SHEET_STATES.map((s) => [s, d.snaps[s]]);
      let target;
      if (Math.abs(v) > 0.4) {
        // бросок: ближайшее положение в сторону движения
        target = v < 0
          ? (order.find(([, px]) => px > h + 8) || order[2])[0]
          : ([...order].reverse().find(([, px]) => px < h - 8) || order[0])[0];
      } else {
        target = order.reduce((best, cur) => (Math.abs(cur[1] - h) < Math.abs(best[1] - h) ? cur : best))[0];
      }
      sheetEl.classList.remove('dragging');
      sheetEl.style.height = '';
      setSheet(target);
      if (target !== d.from) TG.haptic('light');
      d = null;
    }

    // шапка: указатель (мышь и палец). Движение ловим на document: мышь уходит выше шапки, а захват указателя
    // на время клика по вкладкам включать нельзя (клик перестал бы доходить до кнопки).
    let down = null, justDragged = false;
    const onMove = (e) => {
      if (!down || down.id !== e.pointerId) return;
      if (!down.on) {
        if (Math.abs(e.clientY - down.y) < 6) return;
        down.on = true;
        start(e.clientY);
      }
      move(e.clientY);
    };
    const finish = (e) => {
      if (!down || down.id !== e.pointerId) return;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      if (down.on) { end(); justDragged = true; setTimeout(() => { justDragged = false; }, 0); }
      down = null;
    };
    head.addEventListener('pointerdown', (e) => {
      if (isDesktop() || e.pointerType !== 'mouse' || e.button !== 0) return; // палец обрабатывают touch-события ниже
      down = { y: e.clientY, id: e.pointerId, on: false };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
    });
    head.addEventListener('click', (e) => { if (justDragged) { e.stopPropagation(); e.preventDefault(); } }, true);

    // шапка, палец: touch-события работают одинаково в браузере и в WebView Telegram (там pointercancel приходит раньше времени)
    let ht = null;
    head.addEventListener('touchstart', (e) => {
      ht = !isDesktop() && e.touches.length === 1 ? { y: e.touches[0].clientY, on: false } : null;
    }, { passive: true });
    head.addEventListener('touchmove', (e) => {
      if (!ht) return;
      const y = e.touches[0].clientY;
      if (!ht.on) {
        if (Math.abs(y - ht.y) < 6) return;
        ht.on = true;
        start(y);
      }
      if (e.cancelable) e.preventDefault();
      move(y);
    }, { passive: false });
    const hend = () => { if (ht && ht.on) { end(); justDragged = true; setTimeout(() => { justDragged = false; }, 350); } ht = null; };
    head.addEventListener('touchend', hend);
    head.addEventListener('touchcancel', hend);

    // список: передача жеста панели, пока список прокручен до верха
    let lt = null;
    list.addEventListener('touchstart', (e) => {
      lt = !isDesktop() && e.touches.length === 1 ? { y: e.touches[0].clientY, on: false } : null;
    }, { passive: true });
    list.addEventListener('touchmove', (e) => {
      if (!lt) return;
      const y = e.touches[0].clientY, dy = y - lt.y;
      if (!lt.on) {
        const cur = curSheet();
        const takeUp = dy < -6 && cur !== 'full' && list.scrollTop <= 0;
        const takeDown = dy > 6 && cur !== 'peek' && list.scrollTop <= 0;
        if (!takeUp && !takeDown) return;
        lt.on = true;
        start(y);
      }
      if (e.cancelable) e.preventDefault();
      move(y);
    }, { passive: false });
    const lend = () => { if (lt && lt.on) end(); lt = null; };
    list.addEventListener('touchend', lend);
    list.addEventListener('touchcancel', lend);

    // ручка и стрелка работают и без жестов (мышь, клавиатура, вспомогательные технологии)
    $('#sheetHandle').addEventListener('click', () => { setSheet(curSheet() === 'peek' ? 'half' : 'peek'); TG.haptic('light'); });
    $('#sheetToggle').addEventListener('click', () => {
      const s = curSheet();
      setSheet(s === 'peek' ? 'half' : s === 'half' ? 'full' : 'half');
      TG.haptic('light');
    });
    $('#sheetHandle').addEventListener('keydown', (e) => {
      const i = SHEET_STATES.indexOf(curSheet());
      if (e.key === 'ArrowUp') { e.preventDefault(); setSheet(SHEET_STATES[Math.min(i + 1, 2)]); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSheet(SHEET_STATES[Math.max(i - 1, 0)]); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(curSheet() === 'peek' ? 'half' : 'peek'); }
    });
  })();

  // Карточка события: потянуть за верх вниз — закрыть и вернуться к списку
  (function initDetailDrag() {
    const det = $('#detail'), grip = $('#dGrip');
    let s = null;
    grip.addEventListener('pointerdown', (e) => {
      if (isDesktop() || e.pointerType === 'touch') return;
      s = { y: e.clientY, id: e.pointerId, dy: 0, pts: [{ y: e.clientY, t: performance.now() }] };
      try { grip.setPointerCapture(e.pointerId); } catch { /* не критично */ }
      det.classList.add('dragging');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!s || s.id !== e.pointerId) return;
      s.dy = Math.max(0, e.clientY - s.y);
      det.style.transform = `translateY(${s.dy}px)`;
      s.pts.push({ y: e.clientY, t: performance.now() });
      if (s.pts.length > 4) s.pts.shift();
    });
    const done = (e) => {
      if (!s || s.id !== e.pointerId) return;
      const a = s.pts[0], b = s.pts[s.pts.length - 1];
      const v = b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0;
      const close = s.dy > 90 || v > 0.5;
      s = null;
      det.classList.remove('dragging');
      det.style.transform = '';
      if (close) closeDetail();
    };
    grip.addEventListener('pointerup', done);
    grip.addEventListener('pointercancel', done);

    // палец: touch-события (в WebView Telegram надёжнее pointer-событий)
    let tt = null;
    grip.addEventListener('touchstart', (e) => {
      if (isDesktop() || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      tt = { y, dy: 0, pts: [{ y, t: performance.now() }] };
      det.classList.add('dragging');
    }, { passive: true });
    grip.addEventListener('touchmove', (e) => {
      if (!tt) return;
      const y = e.touches[0].clientY;
      if (e.cancelable) e.preventDefault();
      tt.dy = Math.max(0, y - tt.y);
      det.style.transform = `translateY(${tt.dy}px)`;
      tt.pts.push({ y, t: performance.now() });
      if (tt.pts.length > 4) tt.pts.shift();
    }, { passive: false });
    const tdone = () => {
      if (!tt) return;
      const a = tt.pts[0], b = tt.pts[tt.pts.length - 1];
      const v = b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0;
      const close = tt.dy > 90 || v > 0.5;
      tt = null;
      det.classList.remove('dragging');
      det.style.transform = '';
      if (close) closeDetail();
    };
    grip.addEventListener('touchend', tdone);
    grip.addEventListener('touchcancel', tdone);
  })();

  // Высота верхней панели нужна боковой панели на десктопе и для режима full на телефоне.
  function updateLayout() {
    const h = $('#topbar').getBoundingClientRect().height;
    document.documentElement.style.setProperty('--topbar-h', Math.ceil(h) + 'px');
  }
  if ('ResizeObserver' in window) new ResizeObserver(updateLayout).observe($('#topbar'));
  window.addEventListener('resize', updateLayout);

  // ---------- выпадающие панели, «Назад» ----------
  const DROPS = [['#filterPanel', '#filterBtn'], ['#menu', '#menuBtn'], ['#wxCard', '#wx']];
  function closeDropdowns(except) {
    for (const [p, b] of DROPS) {
      if (p === except) continue;
      $(p).hidden = true; $(b).setAttribute('aria-expanded', 'false');
    }
    syncBack();
  }
  function toggleDrop(p, b) {
    const open = $(p).hidden;
    closeDropdowns(open ? p : undefined);
    $(p).hidden = !open; $(b).setAttribute('aria-expanded', String(open));
    syncBack();
  }
  const anyDropOpen = () => DROPS.some(([p]) => !$(p).hidden);

  // Один обработчик «назад»: закрывает самый верхний слой. Системная кнопка Telegram показывается, пока что-то открыто.
  function closeTop() {
    if (!$('#about').hidden) { closeAbout(); return true; }
    if (anyDropOpen()) { closeDropdowns(); return true; }
    if (!$('#detail').hidden) { closeDetail(); return true; }
    return false;
  }
  function syncBack() {
    const open = !$('#about').hidden || anyDropOpen() || !$('#detail').hidden;
    TG.setBack(open ? closeTop : null);
  }

  // ---------- окно «О данных» ----------
  function openAbout() {
    closeDropdowns();
    const body = $('#aboutBody');
    const rows = (state.status ? state.status.sources : []).map((s) => {
      let line;
      if (!s.enabled) line = t('srcDisabled');
      else if (!s.last_success_at) line = t('srcNever');
      else line = t('srcLast', { time: `${fmtDT(s.last_success_at)} (${rel(s.last_success_at)})` });
      const cls = s.stale ? 'warn' : 'ok';
      return el('div', { class: 'src-row' },
        el('div', { text: t('src_' + s.id) }),
        el('div', { class: 's' }, el('span', { class: 'dot ' + cls }), `${s.stale && s.enabled ? t('srcStale') + ': ' : ''}${line}`));
    });
    body.replaceChildren(
      el('p', { text: t('aboutIntro') }),
      el('h3', { text: t('aboutSources') }),
      ...rows,
      el('h3', { text: t('about') }),
      el('p', { text: t('aboutDelay') }),
      el('p', { text: t('aboutNotConnected' ) }),
      el('h3', { text: t('aboutStatuses') }),
      el('ul', { class: 'legend' }, ...['LIVE', 'ACTIVE', 'RECENT', 'EXPIRED', 'RESOLVED'].map((s) => el('li', {}, el('b', { text: t('stShort_' + s) + ': ' }), t('st_' + s)))),
      el('h3', { text: t('legendTitle') }),
      el('ul', { class: 'legend' }, el('li', { text: t('legendLive') }), el('li', { text: t('legendActive') }), el('li', { text: t('legendRecent') }), el('li', { text: t('legendApprox') })),
      el('p', { style: 'margin-top:14px', text: t('aboutEmergency') }));
    lastAboutFocus = document.activeElement;
    $('#about').hidden = false;
    syncBack();
    $('#aboutClose').focus();
  }
  let lastAboutFocus = null;
  function closeAbout() {
    $('#about').hidden = true;
    syncBack();
    if (lastAboutFocus && document.contains(lastAboutFocus)) { try { lastAboutFocus.focus({ preventScroll: true }); } catch { /* элемента уже нет */ } }
  }
  // фокус не уходит из модального окна
  $('#about').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...$('#about').querySelectorAll('button, a[href]')].filter((n) => !n.disabled);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // ---------- загрузка данных ----------
  async function api(path) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(CFG.API_BASE.replace(/\/+$/, '') + path, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  // Номер запроса: ответ на устаревший запрос (например, после смены периода) не затирает свежие данные.
  let loadSeq = 0;
  async function load() {
    if (!CFG.API_BASE) { state.loaded = true; render(); return; }
    const my = ++loadSeq;
    const hours = state.hours;
    try {
      const [ev, st] = await Promise.all([api(`/api/events?hours=${hours}&limit=500`), api('/api/status')]);
      if (my !== loadSeq) return;
      state.events = Array.isArray(ev.events) ? ev.events : [];
      state.status = st;
      state.generatedAt = Date.parse(ev.generated_at) || Date.now();
      state.offline = false;
      store.set('wl_cache', JSON.stringify({ hours, ts: state.generatedAt, events: state.events, status: st }));
    } catch {
      if (my !== loadSeq) return;
      state.offline = true;
    }
    state.loaded = true;
    render();
  }

  function loadCacheOnce() {
    const raw = store.get('wl_cache');
    if (!raw) return;
    try {
      const c = JSON.parse(raw);
      if (c && c.hours === state.hours && Array.isArray(c.events) && c.ts) {
        state.events = c.events; state.status = c.status; state.generatedAt = c.ts;
        state.offline = true; // пока не получим свежие данные, считаем их сохранёнными и возможно устаревшими
        state.loaded = true;
        render();
      }
    } catch { /* повреждённый кэш игнорируем */ }
  }

  // ---------- события интерфейса ----------
  $('#filterBtn').addEventListener('click', () => toggleDrop('#filterPanel', '#filterBtn'));
  $('#menuBtn').addEventListener('click', () => toggleDrop('#menu', '#menuBtn'));
  $('#wx').addEventListener('click', () => toggleDrop('#wxCard', '#wx'));
  $('#wxClose').addEventListener('click', () => closeDropdowns());
  $('#miAbout').addEventListener('click', openAbout);
  $('#freshness').addEventListener('click', openAbout);
  $('#aboutClose').addEventListener('click', closeAbout);
  $('#about').addEventListener('click', (e) => { if (e.target === $('#about')) closeAbout(); });
  $('#dClose').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTop(); });
  document.addEventListener('click', (e) => {
    if (!anyDropOpen()) return;
    // элемент мог быть пересобран обработчиком (смена языка/темы) и уже не в документе: это не клик «снаружи»
    if (!e.target.isConnected) return;
    if (e.target.closest('#filterPanel, #menu, #filterBtn, #menuBtn, #wxCard, #wx')) return;
    closeDropdowns();
  });
  // Копирование и «Поделиться»: текст карточки (заголовок, описание, место, ссылка на источник)
  function detailText() {
    const ev = state.events.find((e) => e.id === state.selectedId);
    if (!ev) return '';
    const tx = texts(ev, state.showOriginal);
    const place = ev.location_name || ev.district || '';
    const url = safeUrl(ev.source_url);
    return [tx.title, tx.desc, place ? `${t('location')}: ${place}` : '', ev.event_time ? fmtDT(ev.event_time) : '',
      `${t('source')}: ${ev.publisher || ev.source}${url ? ' ' + url : ''}`].filter(Boolean).join('\n\n');
  }
  async function copyText(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* пробуем запасной способ */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:0;top:0;opacity:0;font-size:16px';
    document.body.append(ta);
    ta.focus({ preventScroll: true }); ta.select(); ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
  let toastT = 0;
  function toast(msg) {
    let n = $('#toast');
    if (!n) { n = el('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.append(n); }
    n.textContent = msg; n.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => n.classList.remove('on'), 1800);
  }
  $('#dCopy').addEventListener('click', async () => {
    const text = detailText();
    if (!text) return;
    const ok = await copyText(text);
    TG.haptic('light');
    toast(t(ok ? 'copied' : 'copyFail'));
  });
  $('#dShare').addEventListener('click', async () => {
    const ev = state.events.find((e) => e.id === state.selectedId);
    if (!ev) return;
    const tx = texts(ev, state.showOriginal);
    const url = safeUrl(ev.source_url) || location.href.split('#')[0];
    if (TG.share && TG.share(url, tx.title)) return;
    try { if (navigator.share) { await navigator.share({ title: tx.title, text: tx.title, url }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    toast(t((await copyText(detailText())) ? 'copied' : 'copyFail'));
  });
  $('#dShow').addEventListener('click', () => {
    if (!state.selectedId) return;
    focusLayer(state.selectedId);
    // на телефоне карточка закрывает карту: убираем её, чтобы увидеть маркер
    if (!isDesktop()) closeDetail();
  });

  $('#districtSel').addEventListener('change', (e) => {
    state.district = e.target.value;
    const d = DISTRICTS.find((x) => x.id === state.district);
    if (d) map.flyToBounds(L.latLng(d.c).toBounds(d.r * 2), { padding: [20, 20] });
    else map.flyToBounds(CFG.CITY.bounds);
    render();
  });
  $('#timeSel').addEventListener('change', (e) => { state.hours = parseInt(e.target.value, 10) || DEFAULT_HOURS; render(); load(); });
  $('#cityBtn').addEventListener('click', () => {
    state.district = ''; $('#districtSel').value = '';
    closeDetail(); closeDropdowns();
    map.flyToBounds(CFG.CITY.bounds);
    render();
  });
  map.on('click', () => { closeDropdowns(); if (!isDesktop()) setSheet('peek'); });

  // Внешние ссылки в Telegram открываем средствами Telegram, чтобы не уходить из Mini App.
  document.addEventListener('click', (e) => {
    if (!TG.isTma) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.href;
    if (!/^https?:/i.test(href)) return;
    if (TG.openLink && TG.openLink(href)) e.preventDefault();
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, Math.max(30, CFG.REFRESH_SEC || 60) * 1000);

  // ---------- PWA ----------
  if (/^https?:$/.test(location.protocol)) {
    const lm = document.createElement('link');
    lm.rel = 'manifest'; lm.href = 'manifest.webmanifest';
    document.head.append(lm);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* PWA необязательна */ });
  }

  // ---------- погода (DWD через наш API, кэш 10 минут) ----------
  const WX_ICON = { 'clear-day': 'sun', 'clear-night': 'moon', 'partly-cloudy-day': 'suncloud', 'partly-cloudy-night': 'cloud', cloudy: 'cloud', fog: 'fog', wind: 'wind', rain: 'rain', sleet: 'rain', snow: 'snow', hail: 'snow', thunderstorm: 'bolt' };
  const wxState = { data: null, at: 0 };
  const WX_MAX_AGE = 3 * 3600e3; // данные старше 3 часов не показываем
  const wxNum = (v, d = 0) => (v == null ? '–' : Number(v).toLocaleString(locale(), { maximumFractionDigits: d }));
  const wxIcon = (name, size) => ICON.make(WX_ICON[name] || 'cloud', size, 1.8);
  const wxCond = (c) => t('wx_' + String(c && c.icon || 'none').replaceAll('-', '_'));
  const wxDir = (deg) => (deg == null ? '' : t('wxDirs')[Math.round(deg / 45) % 8]);
  function renderWeather() {
    const btn = $('#wx'), d = wxState.data;
    const fresh = d && Date.now() - wxState.at < WX_MAX_AGE;
    btn.hidden = !fresh || d.current.temp == null;
    if (btn.hidden) { if (!$('#wxCard').hidden) closeDropdowns(); return; }
    const c = d.current;
    setKids(btn, wxIcon(c.icon, 20), `${wxNum(c.temp)}°`, d.from === 'forecast' ? el('span', { class: 'fc', text: t('wxForecast') }) : null);
    setKids($('#wxIco'), wxIcon(c.icon, 40));
    $('#wxTemp').textContent = `${wxNum(c.temp, 1)} °C`;
    $('#wxCond').textContent = wxCond(c);
    const cell = (label, value, sub) => el('div', {}, el('dt', { text: label }), el('dd', {}, value, sub ? el('small', { text: sub }) : null));
    const rows = [];
    if (c.wind_kmh != null) rows.push(cell(t('wxWind'), [`${wxNum(c.wind_kmh)} ${t('kmh')}`, wxDir(c.wind_dir)].filter(Boolean).join(', '), c.gust_kmh != null && c.gust_kmh > c.wind_kmh + 5 ? t('wxGust', { v: wxNum(c.gust_kmh) }) : null));
    if (c.humidity != null) rows.push(cell(t('wxHum'), `${wxNum(c.humidity)} %`));
    if (c.precip_mm != null) rows.push(cell(t('wxRain'), `${wxNum(c.precip_mm, 1)} ${t('mm')}`));
    if (c.pressure != null) rows.push(cell(t('wxPress'), `${wxNum(c.pressure)} hPa`));
    $('#wxGrid').replaceChildren(...rows);
    const hourFmt = dtf({ hour: '2-digit', minute: '2-digit' });
    $('#wxFc').replaceChildren(...d.forecast.slice(0, 6).map((f) => el('div', {},
      el('div', { class: 'h', text: hourFmt.format(new Date(f.t)) }), wxIcon(f.icon, 20), el('div', { text: `${wxNum(f.temp)}°` }),
      el('div', { class: 'p', text: f.precip_prob != null && f.precip_prob >= 20 ? `${wxNum(f.precip_prob)} %` : '' }))));
    const parts = [];
    if (d.from === 'forecast') parts.push(t('wxFromFc'));
    else if (d.station) parts.push(t('wxStation', { name: d.station.name, km: wxNum(d.station.distance_km) }));
    parts.push(t('wxAgo', { when: rel(c.t) }), t('wxSrc'));
    $('#wxSrc').textContent = parts.map((x) => (/[.!]$/.test(x) ? x : x + '.')).join(' ');
  }
  async function loadWeather() {
    if (!CFG.API_BASE) return;
    try {
      const d = await api('/api/weather');
      if (d && d.current && Number.isFinite(d.current.temp) && Array.isArray(d.forecast)) { wxState.data = d; wxState.at = Date.now(); }
    } catch { /* остаётся прежнее значение, пока оно не старше 3 часов */ }
    renderWeather();
  }
  setInterval(() => { if (!document.hidden) loadWeather(); }, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - wxState.at > 10 * 60 * 1000) loadWeather(); });

  // ---------- старт ----------
  applyI18n();
  render();
  loadCacheOnce();
  load();
  loadWeather();
})();
