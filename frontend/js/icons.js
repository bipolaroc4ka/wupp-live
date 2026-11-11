// Собственный набор SVG-иконок (контурные, 24×24). Строятся через DOM, без innerHTML.
// Эмодзи не используются: на разных платформах и в клиентах Telegram они выглядят по-разному.
window.WL_ICONS = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const P = (d) => ['path', { d }];
  const C = (cx, cy, r) => ['circle', { cx, cy, r }];
  const DEFS = {
    fire: [P('M12 3c.5 3 4 4.8 4 9a4 4 0 0 1-8 0c0-1.7.7-3 1.8-4.2C10.2 9.6 11.5 7 12 3z')],
    burst: [P('M12 3l1.8 4.2L18 5.5l-1.2 4.4L21 12l-4.2 2.1L18 18.5l-4.2-1.7L12 21l-1.8-4.2L6 18.5l1.2-4.4L3 12l4.2-2.1L6 5.5l4.2 1.7z')],
    siren: [P('M7 18v-5a5 5 0 0 1 10 0v5M5 21h14M12 3v2M4.5 6l1.5 1.5M19.5 6L18 7.5')],
    cross: [P('M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z'), P('M12 9v6M9 12h6')],
    hazard: [P('M12 4L2.5 20h19z'), P('M12 10v4.5M12 17.5h.01')],
    alert: [C(12, 12, 9), P('M12 7.5v5M12 16h.01')],
    jam: [P('M9 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'), C(12, 8, 1.2), C(12, 12, 1.2), C(12, 16, 1.2)],
    closed: [C(12, 12, 9), P('M7.5 12h9')],
    cone: [P('M7 21l2.2-13h5.6L17 21M5 21h14M8.4 13h7.2M7.7 17h8.6')],
    road: [P('M8 3L5 21M16 3l3 18M12 4v3M12 10.5v3M12 17v3')],
    bus: [P('M5 4h14a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z'), P('M4 11h16M7 17v3M17 17v3M7.5 14h.01M16.5 14h.01')],
    bolt: [P('M13 2L5 13.5h6L10 22l9-12h-6.2z')],
    drop: [P('M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z')],
    damage: [P('M4 21V9l8-5 8 5v12M3 21h18M12 12l-2 3 3 1-1.5 3')],
    waves: [P('M2 10c2-2 4-2 6 0s4 2 6 0 4-2 6 0M2 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0M2 20c2-2 4-2 6 0s4 2 6 0 4-2 6 0')],
    rain: [P('M7 14a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 7.5 3.5 3.5 0 0 1 17 14H7z'), P('M8 17v3M12 17v3M16 17v3')],
    bell: [P('M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0')],
    calendar: [P('M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z'), P('M3 10h18M8 3v4M16 3v4')],
    people: [C(9, 8, 3), C(17, 9, 2.5), P('M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M15.5 14.5c3 .2 5.5 2.2 5.5 5.5')],
    banned: [C(12, 12, 9), P('M5.6 5.6l12.8 12.8')],
    // интерфейс
    sliders: [P('M4 7h9M17 7h3M4 17h3M11 17h9'), C(15, 7, 2), C(9, 17, 2)],
    more: [P('M5 12h.01M12 12h.01M19 12h.01')],
    close: [P('M6 6l12 12M18 6L6 18')],
    chevron: [P('M6 9l6 6 6-6')],
    info: [C(12, 12, 9), P('M12 11v5M12 8h.01')],
    pin: [P('M12 21s-6.5-5.7-6.5-11a6.5 6.5 0 0 1 13 0c0 5.3-6.5 11-6.5 11z'), C(12, 10, 2.3)],
    external: [P('M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5')],
    layers: [P('M12 3l9 5-9 5-9-5z M3 13l9 5 9-5')]
  };

  // категория -> имя иконки
  const BY_CATEGORY = {
    fire: 'fire', accident: 'burst', police: 'siren', rescue: 'cross', hazard: 'hazard', emergency_other: 'alert',
    road_jam: 'jam', road_closure: 'closed', road_accident: 'burst', roadworks: 'cone', road_obstacle: 'hazard', traffic_other: 'road',
    transit_delay: 'bus', transit_cancel: 'bus', transit_detour: 'bus', transit_stop: 'bus',
    infra_power: 'bolt', infra_water: 'drop', infra_damage: 'damage', flood: 'waves', heavy_rain: 'rain', warning_other: 'bell',
    event_big: 'calendar', event_crowd: 'people', event_restriction: 'banned'
  };
  const BY_GROUP = { emergency: 'siren', traffic: 'jam', roadworks: 'cone', transit: 'bus', infra: 'bell', events: 'calendar' };

  function make(name, size = 20, width = 2) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', String(width));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const [tag, attrs] of (DEFS[name] || DEFS.alert)) {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      svg.append(n);
    }
    return svg;
  }

  return {
    make,
    forCategory: (cat, size, width) => make(BY_CATEGORY[cat] || 'alert', size, width),
    forGroup: (g, size, width) => make(BY_GROUP[g] || 'alert', size, width)
  };
})();
