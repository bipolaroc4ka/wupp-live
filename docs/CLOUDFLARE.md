# Настройка Cloudflare Workers + D1

Всё выполняется вами на своём компьютере. Нужны: аккаунт Cloudflare (бесплатный подходит) и Node.js 20+.

```bash
cd backend
npm install            # установит wrangler
npx wrangler login     # откроет браузер для входа
```

## 1. База данных D1

```bash
npx wrangler d1 create wuppertal-live
```

Команда выведет `database_id`. Вставьте его в `backend/wrangler.toml` вместо `ВСТАВЬТЕ-database_id-ИЗ-wrangler-d1-create`.

Применить схему:

```bash
npx wrangler d1 execute wuppertal-live --remote --file=./schema.sql
```

(Для локальной разработки: `npm run db:init:local`.)

## 2. Переменные в `wrangler.toml`

Откройте `backend/wrangler.toml` и задайте:

- `NOMINATIM_CONTACT`: ваша почта или адрес проекта. Nominatim требует идентифицирующий User-Agent.
- `ALLOWED_ORIGINS`: origin вашего сайта без пути, например `https://ваш-логин.github.io`. Пока можно оставить `*`, но для работы лучше сузить.
- `PRESSEPORTAL_OFFICE_IDS`: `115885` — Feuerwehr Wuppertal. Чтобы добавить Polizei Wuppertal, откройте её страницу на presseportal.de и возьмите число из адреса `…/nr/<ID>`; перечислите ID через запятую. Полицейский newsroom охватывает также Remscheid и Solingen; код оставляет только релизы с датой-строкой «Wuppertal (ots)».
- `PRESS_TTL_HOURS`, `AUTOBAHN_ROADS`: при необходимости.
- `NINA_ARS` (необязательно, по умолчанию `051240000000`).

Cron-выражения в `[triggers]` должны совпадать с `CRON_MAP` в `src/cron.js` (сейчас совпадают). Если меняете частоту, меняйте оба места.

## 3. Секреты

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put PRESSEPORTAL_API_KEY
```

`ADMIN_TOKEN` — придумайте случайную строку не короче 16 символов (лучше 32+), например:
`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. Короткие токены сервер отклоняет.

Ключ Presseportal получите на https://api.presseportal.de (там же условия использования). Без него источник Presseportal отключён с понятной ошибкой в админке, остальные работают.

Для локального запуска создайте `backend/.dev.vars` (файл в .gitignore) по образцу `.dev.vars.example`.

## 4. Деплой

```bash
npx wrangler deploy
```

Wrangler напечатает адрес вида `https://wuppertal-live-api.<ваш-сабдомен>.workers.dev`. Проверка:

```bash
curl https://wuppertal-live-api.<сабдомен>.workers.dev/api/health
curl https://wuppertal-live-api.<сабдомен>.workers.dev/api/status
```

Этот адрес вставьте в `frontend/js/config.js` (`API_BASE`).

## 5. Первый запуск источников

Cron сработает сам в течение 2–10 минут. Чтобы не ждать, откройте `admin.html` на вашем сайте, введите `ADMIN_TOKEN`, затем у каждого источника нажмите **«Проба»** (сырой ответ источника — сверьте поля, см. README) и **«Запустить»**.

Локально можно проверить cron: `npm run dev`, затем в другом окне
`curl "http://localhost:8787/__scheduled?cron=*/2+*+*+*+*"`.

## 6. Рекомендации по защите

- В Cloudflare Dashboard → Security → WAF → Rate limiting добавьте правило на путь `/api/admin/*` (например, 20 запросов/мин с одного IP). В коде есть простая защита в памяти, но она не заменяет правило WAF.
- Не публикуйте `ADMIN_TOKEN` и не вставляйте его в frontend: админка просит его у вас в браузере (sessionStorage вкладки).
- Токен можно сменить в любой момент повторным `wrangler secret put ADMIN_TOKEN`.

## 7. Обновление и откат

- Обновить код: `npx wrangler deploy`. Откатить: Dashboard → Workers → ваш Worker → Deployments.
- Изменения схемы делайте отдельными SQL-файлами и применяйте `d1 execute --remote`. Не пересоздавайте таблицу `events` без нужды: потеряете историю.
