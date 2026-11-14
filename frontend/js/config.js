// Настройки frontend. Единственное, что нужно изменить: API_BASE.
window.WL_CONFIG = {
  // Адрес вашего Worker после деплоя, без слэша на конце. Пример:
  // 'https://wuppertal-live-api.ВАШ-САБДОМЕН.workers.dev'
  API_BASE: 'https://wupp-live.isychev10.workers.dev',

  // Автообновление данных, секунд (когда вкладка видима).
  REFRESH_SEC: 60,

  // Работы и перекрытия старше этого числа дней уходят на вкладку «Долгосрочные» (необязательный параметр, по умолчанию 1).
  LONG_TERM_DAYS: 1,

  CITY: {
    name: 'Wuppertal',
    center: [51.2562, 7.1508],
    bounds: [[51.16, 7.01], [51.33, 7.32]]
  }
};
