// Конфигурация города. Для другого города достаточно добавить объект и передавать city_id.

export const CITY = {
  id: 'wuppertal',
  name: 'Wuppertal',
  // Границы города: bbox из метаданных открытых наборов данных Stadt Wuppertal (CKAN spatial).
  bbox: { minLon: 7.01, minLat: 51.16, maxLon: 7.32, maxLat: 51.33 },
  // Amtlicher Regionalschlüssel (ARS) Wuppertal — для NINA dashboard. Переопределяется env.NINA_ARS.
  ars: '051240000000'
};

export const CATEGORIES = [
  // экстренные
  'fire', 'accident', 'police', 'rescue', 'hazard', 'emergency_other',
  // дороги
  'road_jam', 'road_closure', 'road_accident', 'roadworks', 'road_obstacle', 'traffic_other',
  // транспорт (источник пока не подключён)
  'transit_delay', 'transit_cancel', 'transit_detour', 'transit_stop',
  // инфраструктура и предупреждения
  'infra_power', 'infra_water', 'infra_damage', 'flood', 'heavy_rain', 'warning_other',
  // прочее
  'event_big', 'event_crowd', 'event_restriction'
];

export const STATUSES = ['LIVE', 'ACTIVE', 'RECENT', 'EXPIRED', 'RESOLVED'];
export const ACTIVE_STATUSES = ['LIVE', 'ACTIVE', 'RECENT'];

export function inCityBbox(lat, lon) {
  const b = CITY.bbox;
  return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}
