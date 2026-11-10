# Wuppertal Live

Карта текущих событий Вупперталя по принципу «лучше 10 достоверных событий, чем 100 сомнительных».
Frontend: GitHub Pages (Leaflet, PWA, RU/DE). Backend: Cloudflare Workers + D1 + Cron.

> **Статус: MVP (этап 3).** Код написан и проверен автотестами на моках, но **не запускался против живых API** (в среде разработки не было доступа к ним) и **не развёрнут**. Всё размещение делаете вы. См. раздел «Что проверить при первом запуске».

## Что реально показывает карта

| Источник | Что даёт | Обновление | Статус на карте | Координаты |
|---|---|---|---|---|
| **Autobahn GmbH** (Autobahn App API) | Baustellen, Sperrungen, Verkehrsmeldungen на A1, A46, A535, A43 в границах города | каждые 2 мин | `ACTIVE` (работы, перекрытия), `LIVE` (сообщения о движении); `RESOLVED`, когда запись пропала из ленты 2 запуска подряд | от источника |
| **NINA** (BBK, DWD, LHP) | Официальные предупреждения для Вупперталя (шторм, Starkregen, Hochwasser, MoWaS) | каждые 5 мин | `ACTIVE`, пока предупреждение в ленте | нет (на весь город, в списке, не на карте) |
| **Presseportal** (Feuerwehr, опц. Polizei Wuppertal) | Пресс-релизы о пожарах, ДТП, происшествиях | каждые 10 мин; сами релизы выходят **через часы** после события | всегда `RECENT` («актуальность неизвестна»), через 12 ч → `EXPIRED` | улица через Nominatim (приблизительная зона), иначе район/нет |

**Чего на карте нет и почему:** пробки на городских улицах, выезды пожарных и скорой в реальном времени, отключения света и воды, задержки WSW/Schwebebahn, скопления людей. Надёжного открытого источника для них найти не удалось, а имитировать их мы не будем. Подробности и варианты расширения: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Правила достоверности, которые реализованы в коде и проверены тестами:

- время **происшествия**, **публикации**, **получения** и **обновления** хранятся и показываются раздельно; время публикации никогда не подставляется вместо времени события; неизвестное время помечено «неизвестно»;
- пресс-релиз никогда не получает `LIVE`; релиз старше TTL сразу `EXPIRED`;
- точка на карте рисуется только если координаты есть у источника или найдена улица (тогда это штриховая зона, а не «точный адрес»); номера домов не обрабатываются; для района — приблизительная область; для города — без отметки;
- при недоступности источника показываются последние данные с пометкой времени последнего успешного обновления и предупреждением (на сервере и в браузере).

## Структура

```
wuppertal-live/
├── README.md
├── docs/
│   ├── ARCHITECTURE.md        архитектура, формат события, правила актуальности, лимиты, план развития
│   ├── GITHUB_PAGES.md        размещение frontend
│   └── CLOUDFLARE.md          настройка Workers + D1, секреты
├── backend/                   Cloudflare Worker
│   ├── wrangler.toml
│   ├── schema.sql             схема D1
│   ├── package.json
│   ├── src/ index.js (API) · cron.js · events.js · geo.js · time.js · config.js · util.js
│   │        sources/ autobahn.js · nina.js · presseportal.js
│   └── test/ run.mjs (65 проверок) · d1shim.mjs
└── frontend/                  статический сайт (без сборки)
    ├── index.html · admin.html · impressum.html · datenschutz.html
    ├── css/style.css · js/ app.js · i18n.js · config.js
    ├── sw.js · manifest.webmanifest · icons/
```

## Быстрый старт

1. Cloudflare: [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) (создать D1, применить схему, добавить секреты, `wrangler deploy`).
2. В `frontend/js/config.js` указать адрес Worker (`API_BASE`).
3. GitHub Pages: [docs/GITHUB_PAGES.md](docs/GITHUB_PAGES.md).
4. Заполнить `frontend/impressum.html` и `frontend/datenschutz.html` своими данными (обязательно для публичного сайта в Германии).

Локальная проверка без Cloudflare: `cd backend && npm test` (Node ≥ 22, без сети и без установки пакетов).

**Локальный просмотр сайта.** Не открывайте `index.html` двойным кликом (`file://`): браузер блокирует часть функций (manifest, service worker, запросы к API). Запустите маленький сервер в папке frontend и откройте http://localhost:8080:

```
cd frontend
py -m http.server 8080        # Windows
python3 -m http.server 8080   # macOS/Linux
```

Если Worker уже развёрнут, в `ALLOWED_ORIGINS` должен быть `http://localhost:8080` (или `*` на время теста).

## Секреты и переменные, которые нужно добавить вручную

| Что | Где | Зачем |
|---|---|---|
| `ADMIN_TOKEN` (секрет, ≥ 16 символов, лучше 32+ случайных) | `wrangler secret put ADMIN_TOKEN` | доступ к админке |
| `PRESSEPORTAL_API_KEY` (секрет) | `wrangler secret put PRESSEPORTAL_API_KEY` | ключ с https://api.presseportal.de (без него источник Presseportal выключен с понятной ошибкой, остальные работают) |
| `database_id` | `backend/wrangler.toml` | выдаёт `wrangler d1 create` |
| `NOMINATIM_CONTACT` | `backend/wrangler.toml` | ваша почта/URL для User-Agent (требование Nominatim) |
| `ALLOWED_ORIGINS` | `backend/wrangler.toml` | origin вашего сайта, например `https://логин.github.io` |
| `PRESSEPORTAL_OFFICE_IDS` | `backend/wrangler.toml` | `115885` (Feuerwehr Wuppertal) + ID Polizei Wuppertal, если нужна |
| `API_BASE` | `frontend/js/config.js` | URL вашего Worker |
| Impressum / Datenschutz | `frontend/*.html` | ваши персональные данные |

Секреты хранятся только в Cloudflare, во frontend их нет.

## Что проверить при первом запуске

Я не мог обратиться к живым API, поэтому три разбора ответов написаны по публичной документации и **защитно** (неизвестное пропускается, а не выдумывается). После деплоя откройте `admin.html` → кнопка **«Проба»** у каждого источника и сверьте реальный ответ с ожиданиями:

1. **Autobahn:** поля `identifier`, `title`, `subtitle`, `coordinate{lat,long}`, `startTimestamp`, `future`, `isBlocked`, `description[]`, `extent`.
2. **NINA:** форма ответа `…/api31/dashboard/051240000000.json` (массив записей с `id`, `i18nTitle`, `payload.data`, `sent`). Если ARS Вупперталя у вас иной, задайте переменную `NINA_ARS`.
3. **Presseportal:** адрес и параметр ключа в `src/sources/presseportal.js` (константы `API_BASE`, `KEY_PARAM`), форма `content.story[]` и поля `id`, `title`, `body`, `published`, `url`. Условия использования API прочитайте на api.presseportal.de.

Если форма отличается, правка локальна: это функции `toItem` соответствующего файла.

Также проверьте актуальные лимиты бесплатного тарифа Cloudflare ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), раздел «Лимиты») и в первый день поглядывайте в админку: ошибки источников и «Получено / изменено».

## Что не вошло в MVP (по вашему ТЗ — после стабильной работы основы)

Пользовательские сообщения и модерация, уведомления и Telegram-бот, управление категориями из админки, WSW/Schwebebahn и городские открытые данные (нет подходящего живого источника). Архитектура под них подготовлена (поле `city_id`, единый формат события, реестр источников), см. ARCHITECTURE.md.

## Лицензии и атрибуция

Карта © участники OpenStreetMap (ODbL). Данные Autobahn, NINA/DWD, Presseportal используются по условиям их владельцев: проверьте их перед публичным запуском (в частности, коммерческое использование и обязательные ссылки на источник). Для DWD в открытых источниках указано CC BY 4.0, но актуальные условия сверьте на сайте DWD.
