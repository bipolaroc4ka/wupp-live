// Wuppertal Live — frontend. Без сборки, чистый JavaScript.
// Безопасность: все данные с сервера выводятся только через textContent / DOM-узлы (никакого innerHTML).
(() => {
  'use strict';

  const CFG = window.WL_CONFIG || {};
  const I18N = window.WL_I18N;
  const TZ = 'Europe/Berlin';

  // ---------- справочники ----------
  const GROUPS = ['emergency', 'traffic', 'roadworks', 'transit', 'infra', 'events'];
  const GROUP_COLOR = { emergency: '#ef4444', traffic: '#f97316', roadworks: '#eab308', transit: '#3b82f6', infra: '#06b6d4', events: '#a855f7' };
  const CAT = {
    fire: ['emergency', '🔥'], accident: ['emergency', '💥'], police: ['emergency', '🚓'], rescue: ['emergency', '🚑'],
    hazard: ['emergency', '⚠️'], emergency_other: ['emergency', '❗'],
    road_jam: ['traffic', '🚦'], road_closure: ['traffic', '⛔'], road_accident: ['traffic', '🚗'],
    road_obstacle: ['traffic', '⚠️'], traffic_other: ['traffic', '🚦'],
    roadworks: ['roadworks', '🚧'],
    transit_delay: ['transit', '🚌'], transit_cancel: ['transit', '🚌'], transit_detour: ['transit', '🚌'], transit_stop: ['transit', '🚏'],
    infra_power: ['infra', '⚡'], infra_water: ['infra', '💧'], infra_damage: ['infra', '🏚️'],
    flood: ['infra', '🌊'], heavy_rain: ['infra', '🌧️'], warning_other: ['infra', '📢'],
    event_big: ['events', '🎪'], event_crowd: ['events', '👥'], event_restriction: ['events', '🚫']
  };
  // Центры районов — приблизительные (для навигации и показа примерной области), не границы.
  const DISTRICTS = [
    { id: 'elberfeld', name: 'Elberfeld', c: [51.2562, 7.1508], r: 2200, keys: ['elberfeld'] },
    { id: 'elberfeld-west', name: 'Elberfeld-West', c: [51.2430, 7.1180], r: 1900, keys: ['elberfeld-west', 'sonnborn', 'westende'] },
    { id: 'uellendahl', name: 'Uellendahl-Katernberg', c: [51.2720, 7.1380], r: 1900, keys: ['uellendahl', 'katernberg'] },
    { id: 'barmen', name: 'Barmen', c: [51.2740, 7.1980], r: 2000, keys: ['barmen', 'unterbarmen', 'wichlinghausen'] },
    { id: 'heckinghausen', name: 'Heckinghausen', c: [51.2650, 7.2230], r: 1500, keys: ['heckinghausen'] },
    { id: 'oberbarmen', name: 'Oberbarmen', c: [51.2810, 7.2350], r: 1700, keys: ['oberbarmen'] },
    { id: 'langerfeld', name: 'Langerfeld-Beyenburg', c: [51.2850, 7.2800], r: 2600, keys: ['langerfeld', 'beyenburg'] },
    { id: 'ronsdorf', name: 'Ronsdorf', c: [51.2250, 7.2250], r: 2000, keys: ['ronsdorf'] },
    { id: 'cronenberg', name: 'Cronenberg', c: [51.2040, 7.1330], r: 2300, keys: ['cronenberg'] },
    { id: 'vohwinkel', name: 'Vohwinkel', c: [51.2330, 7.0590], r: 2300, keys: ['vohwinkel'] }
  ];
  const HOURS_OPTIONS = [3, 12, 24, 72, 168];

  // ---------- состояние ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* недоступно — работаем без хранилища */ } }
  };
  const state = {
    lang: I18N[store.get('wl_lang')] ? store.get('wl_lang') : 'ru',
    hours: 24,
    groupsOn: new Set(GROUPS),
    district: '',
    events: [],
    status: null,
    generatedAt: null,
    offline: false,
    loaded: false,
    selectedId: null,
    known: new Set(),
    first: true
  };

  const $ = (s) => document.querySelector(s);
  const t = (k, vars) => {
    let s = (I18N[state.lang] && I18N[state.lang][k]) ?? I18N.ru[k] ?? k;
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
  function setKids(node, ...kids) {
    node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  }

  // ---------- время ----------
  const dtf = (opts) => new Intl.DateTimeFormat(locale(), { timeZone: TZ, ...opts });
  const fmtDT = (iso) => dtf({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const fmtD = (iso) => dtf({ day: 'numeric', month: 'long' }).format(new Date(iso));
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

  // ---------- карта ----------
  const map = L.map('map', {
    zoomControl: false, minZoom: 10, preferCanvas: true,
    maxBounds: L.latLngBounds(CFG.CITY.bounds).pad(0.8)
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.fitBounds(CFG.CITY.bounds);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
  }).addTo(map);

  const cluster = L.markerClusterGroup({
    maxClusterRadius: 48, showCoverageOnHover: false, spiderfyOnMaxZoom: true,
    iconCreateFunction: (c) => L.divIcon({
      className: 'pin-wrap', iconSize: [40, 40],
      html: el('div', { class: 'cluster', text: c.getChildCount() })
    })
  }).addTo(map);
  const areas = L.layerGroup().addTo(map);
  let layerById = new Map();

  // ---------- справочные функции ----------
  const catInfo = (c) => CAT[c] || ['events', '•'];
  const groupOf = (c) => catInfo(c)[0];

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

  function visibleEvents() {
    const d = DISTRICTS.find((x) => x.id === state.district);
    return state.events.filter((ev) => state.groupsOn.has(groupOf(ev.category)) && (!d || inDistrict(ev, d)));
  }

  // ---------- отрисовка ----------
  function applyI18n() {
    document.documentElement.lang = I18N[state.lang].htmlLang;
    $('#langBtn').textContent = I18N[state.lang].langCode;
    $('#lblDistrict').textContent = t('district');
    $('#lblTime').textContent = t('period');
    $('#cityBtn').textContent = t('wholeCity');
    $('#aboutBtn').setAttribute('aria-label', t('about'));
    $('#dClose').setAttribute('aria-label', t('close'));
    $('#aboutClose').setAttribute('aria-label', t('close'));
    $('#dShow').textContent = t('showOnMap');
    $('#aboutTitle').textContent = t('aboutTitle');
    $('#lnkImpressum').textContent = t('impressum');
    $('#lnkPrivacy').textContent = t('privacy');

    const ds = $('#districtSel');
    ds.replaceChildren(el('option', { value: '', text: t('allDistricts') }),
      ...DISTRICTS.map((d) => el('option', { value: d.id, text: d.name })));
    ds.value = state.district;
    const ts = $('#timeSel');
    ts.replaceChildren(...HOURS_OPTIONS.map((h) => el('option', { value: String(h), text: t('t' + h) })));
    ts.value = String(state.hours);
  }

  function renderChips() {
    const counts = {};
    for (const ev of state.events) counts[groupOf(ev.category)] = (counts[groupOf(ev.category)] || 0) + 1;
    $('#groupChips').replaceChildren(...GROUPS.map((g) => {
      const on = state.groupsOn.has(g);
      const b = el('button', {
        class: 'chip' + (counts[g] ? '' : ' off'), type: 'button', 'aria-pressed': String(on),
        style: `--c:${GROUP_COLOR[g]}`
      }, el('i'), t('g_' + g), counts[g] ? el('small', { text: String(counts[g]) }) : null);
      b.addEventListener('click', () => {
        if (state.groupsOn.has(g)) state.groupsOn.delete(g); else state.groupsOn.add(g);
        if (state.groupsOn.size === 0) GROUPS.forEach((x) => state.groupsOn.add(x));
        render();
      });
      return b;
    }));
  }

  function statusBadge(ev) {
    return el('span', { class: 'badge ' + ev.status, text: t('stShort_' + ev.status) });
  }

  function listTimeText(ev) {
    const et = eventTimeRef(ev);
    if (et && ev.time_precision === 'minute') return rel(et);
    if (et && ev.time_precision === 'day') return fmtD(et);
    if (ev.published_at) return `${t('pubShort')} ${rel(ev.published_at)}`;
    return `${t('recvShort')} ${rel(ev.received_at)}`;
  }

  function renderList(evs) {
    const list = $('#list');
    const n = evs.length;
    const pr = new Intl.PluralRules(locale()).select(n);
    $('#sheetTitle').textContent = state.loaded ? t('count_' + pr, { n: String(n) }) : t('loading');

    if (!n) {
      list.replaceChildren(el('li', { class: 'empty', text: state.loaded ? t('empty') : t('loading') }));
      return;
    }
    list.replaceChildren(...evs.map((ev) => {
      const [g, icon] = catInfo(ev.category);
      const place = ev.location_name || ev.district || '';
      const li = el('li');
      const btn = el('button', { class: 'item', type: 'button', style: `--c:${GROUP_COLOR[g]}` },
        el('span', { class: 'ico', 'aria-hidden': 'true', text: icon }),
        el('span', { class: 'body' },
          el('span', { class: 't', text: ev.title }),
          el('span', { class: 'm' },
            statusBadge(ev),
            el('span', { text: listTimeText(ev) }),
            place ? el('span', { text: place }) : null)));
      btn.addEventListener('click', () => openDetail(ev.id, true));
      li.append(btn);
      return li;
    }));
  }

  function makePinEl(ev, isNew, approx) {
    const [g, icon] = catInfo(ev.category);
    return el('div', {
      class: `pin st-${ev.status}${approx ? ' approx' : ''}${isNew ? ' pop' : ''}`,
      style: `--c:${GROUP_COLOR[g]}`
    }, icon);
  }

  function renderMap(evs) {
    cluster.clearLayers();
    areas.clearLayers();
    layerById = new Map();
    const markers = [];
    for (const ev of evs) {
      const [g] = catInfo(ev.category);
      const color = GROUP_COLOR[g];
      const isNew = !state.first && !state.known.has(ev.id);

      if (ev.latitude != null && ev.longitude != null) {
        const approx = ev.geo_precision === 'street';
        const m = L.marker([ev.latitude, ev.longitude], {
          icon: L.divIcon({ className: 'pin-wrap', iconSize: [36, 36], iconAnchor: [18, 18], html: makePinEl(ev, isNew, approx) }),
          title: ev.title, keyboard: true
        });
        m.on('click', () => openDetail(ev.id, false));
        markers.push(m);
        layerById.set(ev.id, m);
        if (approx) {
          const c = L.circle([ev.latitude, ev.longitude], {
            radius: 160, color, weight: 1.5, dashArray: '5 5', fillColor: color, fillOpacity: 0.1, interactive: false
          });
          areas.addLayer(c);
        }
      } else if (ev.geo_precision === 'district') {
        const d = districtByName(ev.district);
        if (d) {
          const c = L.circle(d.c, {
            radius: d.r, color, weight: 2, dashArray: '8 6', fillColor: color, fillOpacity: 0.08
          });
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
    banner.hidden = !bannerText;
    banner.className = 'banner' + (bannerErr ? ' error' : '');
    if (bannerText) banner.textContent = bannerText;
    updateLayout();
  }

  function render() {
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
  function timeRow(label, value, unknown) {
    return [el('dt', { text: label }), el('dd', { class: unknown ? 'unknown' : '' }, value)];
  }

  function refreshDetail() {
    const ev = state.events.find((e) => e.id === state.selectedId);
    if (!ev) return;
    const [g] = catInfo(ev.category);
    setKids($('#dBadges'), 
      el('span', { class: 'badge', style: `border-color:${GROUP_COLOR[g]};color:${GROUP_COLOR[g]}`, text: t('c_' + ev.category) }),
      el('span', { class: 'badge ' + ev.status, text: t('st_' + ev.status) }),
      ev.is_verified ? el('span', { class: 'badge official', text: t('official') }) : null);
    $('#dTitle').textContent = ev.title;
    $('#dDesc').textContent = ev.description || '';
    $('#dDesc').hidden = !ev.description;

    const place = ev.location_name || ev.district || (ev.geo_precision === 'city' ? t('wholeCity') : '');
    setKids($('#dLoc'), 
      place ? el('div', {}, el('strong', { text: `${t('location')}: ` }), place) : null,
      el('div', { class: 'note', text: t('geo_' + (ev.geo_precision || 'none')) }));

    const rows = [];
    const startLabel = ev.source === 'autobahn' ? t('tStart') : t('tEvent');
    if (ev.event_time && ev.time_precision === 'minute') {
      rows.push(...timeRow(startLabel, [fmtDT(ev.event_time), ' ', el('span', { class: 'rel', text: `(${rel(ev.event_time)})` })]));
    } else if (ev.event_time && ev.time_precision === 'day') {
      rows.push(...timeRow(startLabel, t('tDayOnly', { date: fmtD(ev.event_time) })));
    } else {
      rows.push(...timeRow(startLabel, t('tEventUnknown'), true));
    }
    rows.push(...(ev.published_at
      ? timeRow(t('tPublished'), [fmtDT(ev.published_at), ' ', el('span', { class: 'rel', text: `(${rel(ev.published_at)})` })])
      : timeRow(t('tPublished'), t('tPubUnknown'))));
    rows.push(...timeRow(t('tReceived'), [fmtDT(ev.received_at), ' ', el('span', { class: 'rel', text: `(${rel(ev.received_at)})` })]));
    if (Math.abs(Date.parse(ev.updated_at) - Date.parse(ev.received_at)) > 60000) {
      rows.push(...timeRow(t('tUpdated'), [fmtDT(ev.updated_at), ' ', el('span', { class: 'rel', text: `(${rel(ev.updated_at)})` })]));
    }
    $('#dTimes').replaceChildren(...rows);

    const url = safeUrl(ev.source_url);
    setKids($('#dSource'), 
      `${t('source')}: ${ev.publisher || ev.source}`,
      url ? ' · ' : null,
      url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: t('openSource') }) : null);

    const show = $('#dShow');
    const hasPlace = layerById.has(ev.id);
    show.disabled = !hasPlace;
    show.textContent = hasPlace ? t('showOnMap') : t('noMapPlace');
  }

  function focusLayer(id) {
    const layer = layerById.get(id);
    if (!layer) return;
    if (typeof layer.getRadius === 'function') {
      // приблизительная область (район): показываем её целиком, границы считаем без обращения к карте
      map.flyToBounds(L.latLng(layer.getLatLng()).toBounds(layer.getRadius() * 2), { padding: [40, 40] });
    } else if (layer.getLatLng) {
      const go = () => map.setView(layer.getLatLng(), Math.max(map.getZoom(), 15), { animate: true });
      if (cluster.hasLayer(layer)) cluster.zoomToShowLayer(layer, go); else go();
    }
  }

  function openDetail(id, fly) {
    state.selectedId = id;
    refreshDetail();
    $('#detail').hidden = false;
    if (fly) focusLayer(id);
    if (!isDesktop()) setSheet('peek');
  }
  function closeDetail() { state.selectedId = null; $('#detail').hidden = true; }

  // ---------- нижняя панель ----------
  const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;
  const SHEET_STATES = ['peek', 'half', 'full'];
  function setSheet(s) {
    const sh = $('#sheet');
    sh.classList.remove(...SHEET_STATES);
    sh.classList.add(s);
  }
  function curSheet() { return SHEET_STATES.find((s) => $('#sheet').classList.contains(s)) || 'peek'; }

  (function initSheetDrag() {
    const h = $('#sheetHandle');
    let y0 = null;
    h.addEventListener('pointerdown', (e) => { y0 = e.clientY; h.setPointerCapture(e.pointerId); });
    h.addEventListener('pointerup', (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0; y0 = null;
      const i = SHEET_STATES.indexOf(curSheet());
      if (Math.abs(dy) < 8) setSheet(i === 0 ? 'half' : 'peek');
      else if (dy < -30) setSheet(SHEET_STATES[Math.min(i + 1, 2)]);
      else if (dy > 30) setSheet(SHEET_STATES[Math.max(i - 1, 0)]);
    });
    h.addEventListener('pointercancel', () => { y0 = null; });
    h.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(curSheet() === 'peek' ? 'half' : 'peek'); }
    });
  })();

  // На десктопе боковая панель начинается под верхней.
  function updateLayout() {
    const h = $('#topbar').getBoundingClientRect().height;
    document.documentElement.style.setProperty('--topbar-h', Math.ceil(h) + 'px');
  }
  if ('ResizeObserver' in window) new ResizeObserver(updateLayout).observe($('#topbar'));
  window.addEventListener('resize', updateLayout);

  // ---------- окно «О данных» ----------
  function openAbout() {
    const body = $('#aboutBody');
    const rows = (state.status ? state.status.sources : []).map((s) => {
      let line;
      if (!s.enabled) line = t('srcDisabled');
      else if (!s.last_success_at) line = t('srcNever');
      else line = t('srcLast', { time: `${fmtDT(s.last_success_at)} (${rel(s.last_success_at)})` });
      const cls = s.stale ? 'warn' : 'ok';
      return el('div', { class: 'src-row' },
        el('div', { text: t('src_' + s.id) }),
        el('div', { class: 's' }, el('span', { class: 'dot ' + cls }), `${s.stale && s.enabled ? t('srcStale') + ' · ' : ''}${line}`));
    });
    body.replaceChildren(
      el('p', { text: t('aboutIntro') }),
      el('h3', { text: t('aboutSources') }),
      ...rows,
      el('h3', { text: t('about') }),
      el('p', { text: t('aboutDelay') }),
      el('p', { text: t('aboutNotConnected') }),
      el('h3', { text: t('aboutStatuses') }),
      el('ul', { class: 'legend' }, ...['LIVE', 'ACTIVE', 'RECENT', 'EXPIRED', 'RESOLVED'].map((s) => el('li', {}, el('b', { text: t('stShort_' + s) + ': ' }), t('st_' + s)))),
      el('h3', { text: t('legendTitle') }),
      el('ul', { class: 'legend' }, el('li', { text: t('legendLive') }), el('li', { text: t('legendActive') }), el('li', { text: t('legendRecent') }), el('li', { text: t('legendApprox') })),
      el('p', { style: 'margin-top:14px', text: t('aboutEmergency') }));
    $('#about').hidden = false;
    $('#aboutClose').focus();
  }

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

  async function load() {
    if (!CFG.API_BASE) { state.loaded = true; render(); return; }
    try {
      const [ev, st] = await Promise.all([
        api(`/api/events?hours=${state.hours}&limit=500`),
        api('/api/status')
      ]);
      state.events = Array.isArray(ev.events) ? ev.events : [];
      state.status = st;
      state.generatedAt = Date.parse(ev.generated_at) || Date.now();
      state.offline = false;
      store.set('wl_cache', JSON.stringify({ hours: state.hours, ts: state.generatedAt, events: state.events, status: st }));
    } catch (e) {
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
        state.offline = true; // пока не получим свежие данные, считаем их сохранёнными/возможно устаревшими
        state.loaded = true;
        render();
      }
    } catch { /* повреждённый кэш игнорируем */ }
  }

  // ---------- события интерфейса ----------
  $('#langBtn').addEventListener('click', () => {
    state.lang = state.lang === 'ru' ? 'de' : 'ru';
    store.set('wl_lang', state.lang);
    applyI18n();
    render();
    if (!$('#about').hidden) openAbout();
  });
  $('#aboutBtn').addEventListener('click', openAbout);
  $('#freshness').addEventListener('click', openAbout);
  $('#aboutClose').addEventListener('click', () => { $('#about').hidden = true; });
  $('#about').addEventListener('click', (e) => { if (e.target === $('#about')) $('#about').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#about').hidden) $('#about').hidden = true; else closeDetail(); }
  });
  $('#dClose').addEventListener('click', closeDetail);
  $('#dShow').addEventListener('click', () => { if (state.selectedId) { focusLayer(state.selectedId); if (!isDesktop()) setSheet('peek'); } });
  $('#districtSel').addEventListener('change', (e) => {
    state.district = e.target.value;
    const d = DISTRICTS.find((x) => x.id === state.district);
    if (d) map.flyToBounds(L.latLng(d.c).toBounds(d.r * 2), { padding: [20, 20] });
    else map.flyToBounds(CFG.CITY.bounds);
    render();
  });
  $('#timeSel').addEventListener('change', (e) => { state.hours = parseInt(e.target.value, 10) || 24; load(); });
  $('#cityBtn').addEventListener('click', () => {
    state.district = ''; $('#districtSel').value = '';
    closeDetail();
    map.flyToBounds(CFG.CITY.bounds);
    render();
  });
  map.on('click', () => { if (!isDesktop()) setSheet('peek'); });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, Math.max(30, CFG.REFRESH_SEC || 60) * 1000);

  // ---------- Telegram Mini App и PWA ----------
  if (/tgWebApp(Data|Version)/.test(location.hash)) {
    const s = document.createElement('script');
    s.src = 'https://telegram.org/js/telegram-web-app.js';
    s.onload = () => { try { window.Telegram.WebApp.ready(); window.Telegram.WebApp.expand(); } catch { /* не в Telegram */ } };
    document.head.append(s);
  }
  if (/^https?:$/.test(location.protocol)) {
    const lm = document.createElement('link');
    lm.rel = 'manifest'; lm.href = 'manifest.webmanifest';
    document.head.append(lm);
  }
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* PWA необязательна */ });
  }

  // ---------- старт ----------
  applyI18n();
  render();
  loadCacheOnce();
  load();
})();
