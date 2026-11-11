// Интеграция с Telegram Mini App. Вне Telegram ничего не загружается и не меняется.
// Все вызовы защищены проверкой версии Bot API и try/catch: старые клиенты не ломают приложение.
window.WL_TG = (() => {
  const noop = () => {};
  const api = { isTma: false, ready: Promise.resolve(false), colorScheme: () => null, haptic: noop, setBack: noop,
    openLink: null, setChrome: noop, onTheme: noop, onViewport: noop, viewportHeight: () => null, swipesLocked: false };

  function hasLaunchParams() {
    if (/tgWebApp(Data|Version|Platform)/.test(location.hash)) return true;
    try { return !!sessionStorage.getItem('__telegram__initParams'); } catch { return false; }
  }
  if (!hasLaunchParams()) return api;
  api.isTma = true;

  let W = null;
  const at = (v) => { try { return !!W && W.isVersionAtLeast(v); } catch { return false; } };
  const safe = (fn) => { try { return fn(); } catch { return undefined; } };

  api.ready = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://telegram.org/js/telegram-web-app.js';
    s.onload = () => {
      W = window.Telegram && window.Telegram.WebApp;
      if (!W) return resolve(false);
      safe(() => W.ready());
      safe(() => W.expand());
      // Свайп вниз по странице закрывал бы приложение при перетаскивании нижней панели.
      if (at('7.7')) { safe(() => W.disableVerticalSwipes()); api.swipesLocked = true; }
      resolve(true);
    };
    s.onerror = () => resolve(false);
    document.head.append(s);
  });

  api.colorScheme = () => (W && (W.colorScheme === 'light' || W.colorScheme === 'dark')) ? W.colorScheme : null;
  api.viewportHeight = () => (W && (W.viewportStableHeight || W.viewportHeight)) || null;

  api.onTheme = (cb) => safe(() => W && W.onEvent('themeChanged', cb));
  api.onViewport = (cb) => safe(() => W && W.onEvent('viewportChanged', cb));

  // Цвета оболочки Telegram подгоняем под тему приложения (hex #RRGGBB).
  api.setChrome = (bg) => {
    if (!W) return;
    if (at('6.1')) { safe(() => W.setHeaderColor(bg)); safe(() => W.setBackgroundColor(bg)); }
    if (at('7.10')) safe(() => W.setBottomBarColor(bg));
  };

  api.haptic = (kind = 'select') => {
    if (!W || !at('6.1') || !W.HapticFeedback) return;
    safe(() => {
      if (kind === 'select') W.HapticFeedback.selectionChanged();
      else W.HapticFeedback.impactOccurred(kind === 'medium' ? 'medium' : 'light');
    });
  };

  // Системная кнопка «Назад»: показывается, пока открыта карточка/меню/панель.
  let backFn = null;
  const onBack = () => { if (backFn) backFn(); };
  api.setBack = (fn) => {
    if (!W || !at('6.1') || !W.BackButton) return;
    backFn = fn;
    safe(() => {
      W.BackButton.offClick(onBack);
      if (fn) { W.BackButton.onClick(onBack); W.BackButton.show(); } else W.BackButton.hide();
    });
  };

  // Внешние ссылки открываем средствами Telegram.
  api.openLink = (url) => {
    if (!W) return false;
    try {
      if (/^https:\/\/t\.me\//i.test(url) && W.openTelegramLink) W.openTelegramLink(url);
      else W.openLink(url);
      return true;
    } catch { return false; }
  };

  return api;
})();
