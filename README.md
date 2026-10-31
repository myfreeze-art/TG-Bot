# Анонимный Telegram-бот на Cloudflare Workers

Готовый к деплою бот «анонимный ящик»: у каждого пользователя есть личная ссылка, по которой ему
можно писать анонимно. Получатель может **анонимно ответить**, поставить **реакцию**, **заблокировать**
отправителя или **пожаловаться** администратору. Администратор видит статистику, жалобы и может
банить отправителей — но **не видит, кто именно отправил сообщение**.

Проект написан на TypeScript, работает на Cloudflare Workers + D1, без внешних сервисов и без
Node-зависимостей в рантайме. Разворачивается за ~15 минут, на free-плане Cloudflare.

---

## Что умеет

**Для пользователя**
- 🔗 Личная анонимная ссылка вида `https://t.me/your_bot?start=u_xxxxx` + кнопка «Поделиться»
- 💌 Приём текста, фото, видео, GIF, голосовых, аудио, файлов, стикеров, кружков и опросов
- 💬 Ответы через бота: получатель отвечает, не раскрывая лишних контактов
- ✨ Анонимные реакции: 👍 ❤️ 🔥 😂 😢 — автор сообщения получает уведомление
- 🚫 Блокировка отправителя (без знания его личности — по необратимому хешу)
- ⚠️ Жалоба админу (с автоматической блокировкой отправителя)
- ⏸ Пауза/возобновление приёма сообщений
- ⚙️ Настройки: медиа, ссылки, уведомления о реакциях
- 🌍 Русский и английский языки

**Для администратора**
- 📊 Обзор: пользователи, сообщения, ответы, баны, жалобы, активные ящики, спарклайн за 7 дней
- 📈 Динамика за 7/30 дней, пик активности по часам
- 🎭 Разбивка по типам сообщений
- 🏆 Топ ящиков по полученным сообщениям
- ⚠️ Жалобы: текст, тип, короткий псевдоним отправителя, кнопки «Забанить» и «Отклонить»
- 🚫 Список банов и разбан
- 📣 Рассылка всем пользователям (с прогрессом и остановкой)
- 📤 CSV-экспорт статистики (открывается в Excel)
- ⚙️ Режим обслуживания, строгая анонимность, ежедневный дайджест
- 🕘 Ежедневный дайджест в Telegram в заданный час UTC

**Антиспам**
- Лимиты на минуту/час/день и минимальный интервал между сообщениями
- Запрет одинаковых сообщений подряд (дубликаты за 10 минут)
- Фильтр ссылок (по умолчанию ссылки запрещены — включается в настройках ящика)
- Глобальные баны по необратимому псевдониму
- Блокировка отправителя в конкретном ящике

---

## Как устроена анонимность

Это главное, поэтому честно и по пунктам.

### Что бот хранит

| Данные | Где | Срок |
|---|---|---|
| Telegram id владельца ящика | `users.id` | пока пользователь пользуется ботом |
| Текст/подпись сообщения (превью) | `messages.content_preview` | 30 дней, потом `NULL` |
| Необратимый псевдоним отправителя | `messages.sender_key` (HMAC-SHA-256) | бессрочно (нужен для банов) |
| Зашифрованный id отправителя для ответа | `reply_keys.ref` (AES-256-GCM) | 7 дней или до ответа |
| Текст жалобы | `reports.content_preview` | 90 дней после решения |
| Медиа | **не хранится ботом** | Telegram хранит у себя |

В таблице `messages` **нет Telegram id отправителя**. Есть только `sender_key` — HMAC от id
с секретом `BOT_SECRET`, обрезанный до 128 бит. По нему нельзя восстановить id без перебора
всех Telegram id и знания секрета.

### Что видит администратор

- Только агрегированную статистику.
- В жалобе — текст сообщения, тип и **короткий псевдоним** (8 символов хеша), но не имя, не username
  и не id.
- Кнопки «Забанить»/«Отклонить» работают с псевдонимом, а не с человеком.

В коде нет ни одной админской команды или запроса, который читает `reply_keys` или
`users.target_id`. Это сделано намеренно.

### Границы возможного

Абсолютная анонимность от владельца сервера технически невозможна: он контролирует код, секреты
и базу. Конкретно:

- С `BOT_SECRET` можно расшифровать `reply_keys` (пока они не удалены) или перебором сопоставить
  `sender_key` с Telegram id.
- Telegram и Cloudflare видят трафик и метаданные; токен бота — это фактически доступ к боту.
- Если включён режим **строгой анонимности**, бот не хранит даже зашифрованную ссылку на
  отправителя: ответы и реакции отключаются, но блокировки, жалобы и баны работают.

Что можно сделать для более сильной модели угроз:

1. Включить строгую анонимность (`/admin` → Настройки), если ответы не нужны.
2. Разделить роли: один человек деплоит и держит `BOT_SECRET`, другой пользуется админкой.
3. Не включать логирование тел запросов в Cloudflare и не добавлять `console.log(update)`.
   В этом коде логируются только названия методов и тексты ошибок, без id и контента.
4. Помнить, что получатель сам решает, что делать с сообщением: он может переслать его, сделать
   скриншот и т.д. Бот гарантирует только сокрытие личности отправителя в интерфейсе.

---

## Технологии

- **Cloudflare Workers** — рантайм, HTTPS-эндпоинт, cron-триггеры
- **Cloudflare D1** (SQLite) — пользователи, сообщения, статистика, баны, жалобы, рассылки
- **Web Crypto API** — HMAC-SHA-256, HKDF, AES-256-GCM
- **Telegram Bot API** — webhook, `copyMessage`, inline-клавиатуры
- Без npm-зависимостей в runtime: только TypeScript-типы и Wrangler для сборки

---

## Быстрый старт

### 0. Что понадобится

- Node.js 22.6+ и npm (или pnpm)
- Аккаунт Cloudflare (бесплатный подойдёт)
- Бот, созданный у [@BotFather](https://t.me/BotFather)
- Свой Telegram id (узнать: [@userinfobot](https://t.me/userinfobot))

### 1. Создай бота

В [@BotFather](https://t.me/BotFather):

1. `/newbot` → имя и username (например, `my_anon_inbox_bot`).
2. Сохрани токен вида `123456789:AA...`.
3. По желанию: `/setdescription`, `/setabouttext`, `/setuserpic`.

Команды бота и webhook установит скрипт из шага 7.

### 2. Установи зависимости

```powershell
cd anon-msg-bot
npm install
npx wrangler login
```

### 3. Создай базу D1

```powershell
npx wrangler d1 create anon-msg-bot
```

В выводе будет `database_id`. Вставь его в `wrangler.toml` вместо нулей:

```toml
[[d1_databases]]
binding = "DB"
database_name = "anon-msg-bot"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Примени миграции:

```powershell
npm run db:migrate
```

### 4. Настрой `wrangler.toml`

```toml
[vars]
ADMIN_IDS = "123456789"          # твой id, можно несколько через запятую
BOT_USERNAME = "my_anon_inbox_bot" # без @, чтобы не дёргать getMe
DAILY_DIGEST_HOUR_UTC = "9"      # 9 UTC = 14:00 Екатеринбург
```

### 5. Задеплой воркер

```powershell
npm run deploy
```

Wrangler покажет URL вида:

```
https://anon-msg-bot.username.workers.dev
```

Сохрани его. Сейчас бот ещё не работает: не заданы секреты.

### 6. Задай секреты

Сгенерируй две случайные строки (32 байта):

```powershell
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$b = New-Object byte[] 32
$rng.GetBytes($b)
($b | ForEach-Object { $_.ToString('x2') }) -join ''
```

Linux/macOS:

```bash
openssl rand -hex 32
```

Задай три секрета (команды интерактивные, вставь значение и Enter):

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put BOT_SECRET
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

- `BOT_TOKEN` — токен от BotFather.
- `BOT_SECRET` — первая случайная строка. **Не меняй после запуска**: сломаются старые ссылки
  для ответов и баны.
- `TELEGRAM_WEBHOOK_SECRET` — вторая случайная строка. Её же передашь в скрипт webhook.
  Допустимы `A-Z a-z 0-9 _ -`, длина 1–256.

После `secret put` Cloudflare сам передеплоит актуальную версию.

### 7. Установи webhook и команды

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-webhook.ps1 `
  -BotToken "123456789:AA..." `
  -WorkerUrl "https://anon-msg-bot.username.workers.dev" `
  -WebhookSecret "твой_TELEGRAM_WEBHOOK_SECRET"
```

Скрипт вызовет `setWebhook`, `setMyCommands` и покажет `getWebhookInfo`.
В `last_error_message` должно быть пусто.

### 8. Проверь

1. Открой `https://твой-воркер.workers.dev/health` — должно вернуться `{"ok":true,"configured":true}`.
2. Открой бота, нажми `/start`.
3. `/link` — получишь свою ссылку.
4. Открой ссылку со второго аккаунта (или попроси друга) и отправь сообщение.
5. В первом аккаунте появятся кнопки «Ответить», реакции, «Блок» и «Жалоба».
6. Зайди в `/admin` — там статистика.
7. Отправь жалобу со второго аккаунта — админу придёт уведомление с кнопками бана.

Готово.

---

## Переменные и секреты

### Секреты (`wrangler secret put`)

| Имя | Обязателен | Описание |
|---|---|---|
| `BOT_TOKEN` | да | Токен Telegram-бота |
| `BOT_SECRET` | да | ≥32 символов. HMAC-псевдонимы + AES-ключ для ответов. Смена ломает старые reply-ключи и баны |
| `TELEGRAM_WEBHOOK_SECRET` | да | Проверка заголовка `X-Telegram-Bot-Api-Secret-Token`. Без него любой мог бы подделать админа |

### Переменные (`[vars]` в `wrangler.toml`)

| Имя | По умолчанию | Описание |
|---|---|---|
| `ADMIN_IDS` | — | id админов через запятую |
| `BOT_USERNAME` | пусто | Юзернейм без `@`; если пусто, бот вызовет `getMe` |
| `DAILY_DIGEST_HOUR_UTC` | `9` | Час дайджеста (0–23 UTC) |
| `LIMIT_PER_MIN` | `4` | Сообщений в минуту с одного отправителя |
| `LIMIT_PER_HOUR` | `15` | В час |
| `LIMIT_PER_DAY` | `40` | В день |
| `MIN_INTERVAL_SEC` | `3` | Минимальная пауза между сообщениями |
| `REPLY_TTL_DAYS` | `7` | Сколько жить зашифрованной ссылке для ответа |
| `CONTENT_TTL_DAYS` | `30` | Через сколько чистить превью сообщений |

После изменения `[vars]` нужен `npm run deploy`. Секреты переживают деплой.

### Без терминала: через Dashboard

Cloudflare Dashboard не собирает TypeScript, поэтому в веб-редактор нужно вставить уже собранный
одним файлом JS. Такая сборка лежит в репозитории: `tests/dashboard-preview.mjs` (пересобрать:
`npx esbuild src/index.ts --bundle --format=esm --outfile=tests/dashboard-preview.mjs`).

Плюс есть страница-заглушка для **Workers Builds** (Deploy from Git) — файлы
`src/placeholder.ts` и корневой `wrangler.jsonc`.

**Кратко про секреты:** токен и пароли — только в Cloudflare (Settings → Variables and Secrets,
тип Secret), в GitHub-репозиторий они не попадают. Подробно — [SECRETS.md](SECRETS.md).
`ADMIN_IDS` и `BOT_USERNAME` в `wrangler.jsonc` — это публичные переменные.

Пошагово (вариант 1 — быстрый):

1. Workers & Pages → **Create** → **Start with Hello World!** → дать имя `anon-msg-bot` → Deploy.
2. Перейти на D1 → **Create database** → имя `anon-msg-bot` → скопировать `database_id` из Settings.
3. В воркере: Settings → Bindings → Add binding → **D1 database**, Variable name `DB`, выбрать базу.
4. Settings → Trigger Events → добавить cron `* * * * *` (нужен для рассылок, дайджеста, очистки).
5. Миграции: D1 → база → **Console** → вставить `migrations/0001_init.sql` → Execute
   (или выполнить `.\scripts\copy-schema.ps1` — оно положит SQL в буфер обмена).
6. Settings → Variables → **Encrypt** → `BOT_TOKEN`, `BOT_SECRET`, `TELEGRAM_WEBHOOK_SECRET`;
   обычными переменными — `ADMIN_IDS`, `BOT_USERNAME`, `DAILY_DIGEST_HOUR_UTC`.
7. Воркер → Edit code → стереть содержимое `worker.js` → вставить весь `tests/dashboard-preview.mjs` → Deploy.
8. Подключить webhook (PowerShell на своём ПК):

```powershell
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot<TOKEN>/setWebhook" `
  -ContentType 'application/json' -Body (@{
    url = 'https://anon-msg-bot.<SUBDOMAIN>.workers.dev'
    secret_token = '<TELEGRAM_WEBHOOK_SECRET>'
    allowed_updates = @('message', 'callback_query')
  } | ConvertTo-Json) | ConvertTo-Json -Depth 5
```

Если хочется обычного терминального деплоя — см. основную инструкцию выше, она проще и
обновлять бота через Git будет удобнее.

### Через GitHub (Deploy from Git)

В корне репозитория лежит `wrangler.jsonc` — это конфиг по умолчанию для Cloudflare Workers Builds.
`npx wrangler deploy` ищет только `wrangler.json` / `wrangler.jsonc` / `wrangler.toml`, поэтому
файл с другим именем (`wrangler.dashboard.jsonc`) нужно передавать явно: `wrangler deploy wrangler.dashboard.jsonc`
или `--config`.

1. Залей проект в репозиторий (папка `anon-msg-bot` — корень репозитория).
2. В `wrangler.jsonc`: `database_id` из D1, `ADMIN_IDS`, `BOT_USERNAME`.
3. Dashboard → **Continue with GitHub** → выбери репозиторий.
4. Build settings:

   - Build command: `npm install`
   - Deploy command: `npx wrangler deploy`  (корневой `wrangler.jsonc` подхватится сам)

5. Секреты — Worker → Settings → Variables and Secrets (тип Secret):

   `BOT_TOKEN`, `BOT_SECRET`, `TELEGRAM_WEBHOOK_SECRET` (+ `ADMIN_IDS`, `BOT_USERNAME`, если не хочешь держать их в jsonc)

6. Включи бота: в `wrangler.jsonc` поменяй
   `"main": "src/placeholder.ts"` → `"main": "src/index.ts"` и сделай commit — Cloudflare
   пересоберёт автоматически. Проверка: `/health` → `{"ok":true,"configured":true}`.
   Либо одной командой из корня репозитория:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-bot.ps1
```

   (если PowerShell блокирует запуск скриптов, флаг `-ExecutionPolicy Bypass` именно так и обходит это)
7. Миграции — один раз: D1 → база → Console → вставить `migrations/0001_init.sql` → Execute.
8. Webhook:

```powershell
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot<TOKEN>/setWebhook" `
  -ContentType 'application/json' -Body (@{
    url = 'https://anon-msg-bot.<SUBDOMAIN>.workers.dev'
    secret_token = '<TELEGRAM_WEBHOOK_SECRET>'
    allowed_updates = @('message', 'callback_query')
  } | ConvertTo-Json) | ConvertTo-Json -Depth 5
```

Деплой через Git-репозиторий, а токен и пароли вводятся в Cloudflare — в git они не попадают.
Если `/health` показывает `"mode":"placeholder"` — значит, шаг 6 не сделан.
Сгенерировать секреты и подготовить блок для GitHub: `.\scripts\make-secrets.ps1 -BotToken "..." -BotUsername "..."`.

---

## Команды бота

| Команда | Что делает |
|---|---|
| `/start` | Главное меню / открыть чужой ящик по deep-link |
| `/link` | Моя анонимная ссылка |
| `/stats` | Статистика моего ящика |
| `/settings` | Настройки приёма |
| `/pause`, `/resume` | Выключить/включить приём |
| `/lang` | Русский / English |
| `/privacy` | Подробно про анонимность |
| `/help` | Справка |
| `/cancel` | Отменить текущее действие |
| `/admin` | Админ-панель (только для `ADMIN_IDS`) |

---

## Админ-панель

`/admin` → обзор. Кнопки:

- **📊 Обзор** — сводка и спарклайн за 7 дней.
- **📈 Динамика** — 7/30 дней, среднее, пик по часам.
- **🎭 Типы** — текст/фото/видео/голосовые и т.д.
- **🏆 Топ ящиков** — кто получает больше всего сообщений (это получатели, не отправители).
- **⚠️ Жалобы** — новые жалобы, бан/отклонение.
- **🚫 Баны** — список псевдонимов и разбан.
- **📣 Рассылка** — отправить сообщение всем.
- **📤 CSV** — файл со статистикой в чат.
- **⚙️ Настройки** — обслуживание, строгая анонимность, дайджест.

### Рассылка

1. `/admin` → «📣 Рассылка» → «Новая рассылка».
2. Отправь **одно** сообщение (текст/фото/видео). Альбомы не поддерживаются.
3. Проверь превью и нажми «🚀 Отправить».
4. Прогресс обновляется в сообщении; кнопка «⏹ Остановить» доступна в панели.
5. Не удаляй исходное сообщение до завершения: бот копирует его из твоего чата.

Рассылка идёт батчами по 25 получателей и сама себя продолжает через внутренний эндпоинт.
Если цепочка оборвётся, cron подхватит её в течение минуты.

### Строгая анонимность

Включается в настройках. Что происходит:

- Бот перестаёт хранить `reply_keys` для новых сообщений.
- Ответы и реакции отключаются (кнопки исчезают).
- Уже существующие reply-ключи удаляются.
- Блокировки, жалобы и баны продолжают работать (они используют `sender_key`).

---

## Локальная разработка

```powershell
copy .dev.vars.example .dev.vars
# заполни BOT_TOKEN, BOT_SECRET, TELEGRAM_WEBHOOK_SECRET, ADMIN_IDS, BOT_USERNAME
npm run db:migrate:local
npm run dev
```

Проверка типов и тесты:

```powershell
npm run typecheck
npm test
```

Локальный воркер слушает `http://localhost:8787`. Telegram не может достучаться до localhost,
поэтому для полноценного теста нужен туннель:

```powershell
# cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://localhost:8787
```

Полученный `https://...trycloudflare.com` передай в `scripts/setup-webhook.ps1` как `-WorkerUrl`.
Не забудь потом вернуть production-webhook.

Можно тестировать и без Telegram, отправив фейковый update:

```powershell
$body = @{
  update_id = 1
  message = @{
    message_id = 1
    date = 0
    chat = @{ id = 123456789; type = 'private' }
    from = @{ id = 123456789; is_bot = $false; first_name = 'Test'; language_code = 'ru' }
    text = '/start'
  }
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/' `
  -Headers @{ 'X-Telegram-Bot-Api-Secret-Token' = 'твой_секрет' } `
  -ContentType 'application/json' -Body $body
```

Бот попробует отправить ответ через реальный Telegram API; чтобы это сработало, `BOT_TOKEN`
в `.dev.vars` должен быть настоящим.

### Скрипт `scripts/deploy.ps1`

Если не хочется править `wrangler.jsonc` руками:

```powershell
# 1) базы ещё нет — создать и сразу задеплоить бота
.\scripts\deploy.ps1 -CreateDatabase -AdminIds "123456789" -BotUsername "my_anon_bot" -Migrate -Bot

# 2) база уже есть (id из Dashboard → D1 или из вывода d1 create)
.\scripts\deploy.ps1 -DatabaseId "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" `
  -AdminIds "123456789" -BotUsername "my_anon_bot" -Migrate -Bot
```

Флаг `-Bot` включает `src/index.ts` (без него деплоится заглушка, как и при GitHub-деплое).
Скрипт делает копию `wrangler.jsonc` с настоящим `database_id` и вызывает
`wrangler deploy <путь к копии>`. В Git Bash — `pwsh -File scripts/deploy.ps1 …`.
Если удобнее просто отредактировать `wrangler.jsonc`, делайте так: оба пути эквивалентны.

---

## Структура проекта

```
anon-msg-bot/
├─ migrations/
│  └─ 0001_init.sql       # схема D1
├─ scripts/
│  ├─ copy-schema.ps1      # SQL-схема → буфер обмена (для D1 Console)
│  ├─ deploy.ps1          # локальный деплой без ручной правки wrangler.jsonc
│  ├─ enable-bot.ps1      # переключить main: заглушка → src/index.ts
│  └─ setup-webhook.ps1   # setWebhook + setMyCommands
├─ src/
│  ├─ index.ts            # entry: webhook, health, внутренний broadcast
│  ├─ placeholder.ts      # заглушка для деплоя из Git (Workers Builds)
│  ├─ ctx.ts              # контекст запроса, username бота
│  ├─ env.ts              # типы env, лимиты, админы
│  ├─ types.ts            # типы Telegram API
│  ├─ telegram.ts         # обёртка Bot API
│  ├─ db.ts               # все запросы к D1
│  ├─ crypto.ts           # HMAC, HKDF, AES-GCM
│  ├─ content.ts          # определение типа сообщения
│  ├─ format.ts           # HTML, числа, спарклайн, CSV
│  ├─ i18n.ts             # RU/EN тексты
│  ├─ keyboards.ts        # inline-клавиатуры
│  ├─ stats.ts            # статистика, CSV, дайджест
│  ├─ user.ts             # пользовательские сценарии
│  ├─ admin.ts            # админ-панель
│  ├─ broadcast.ts        # рассылка
│  ├─ notify.ts           # безопасная отправка/редактирование
│  └─ cron.ts             # рассылка, дайджест, очистка
├─ tests/
│  ├─ core.test.mjs       # тесты крипто/форматирования/клавиатур
│  ├─ dashboard-preview.mjs   # готовая сборка для Dashboard → Edit code
│  └─ placeholder-preview.mjs # сборка заглушки
├─ wrangler.jsonc             # корневой конфиг: его использует деплой из GitHub
├─ wrangler.toml              # тот же конфиг в TOML для локального деплоя
├─ wrangler.dashboard.jsonc   # запасной jsonc-конфиг (если нужен отдельный main)
├─ SECRETS.md                 # куда вставлять токен и секреты (без терминала)
├─ tsconfig.json
├─ package.json
└─ README.md
```

---

## Лимиты бесплатного плана

| Ресурс | Free-план | Комментарий |
|---|---|---|
| Workers requests | 100 000/день | webhook + cron (1 440/день) |
| Workers CPU | 10 мс/запрос | крипто на сообщение ~1–3 мс, укладывается |
| D1 reads | 5 млн/день | ~10 запросов на сообщение |
| D1 writes | 100 000/день | ~6–8 записей на сообщение → ~12–15 тыс. сообщений/день |
| D1 storage | 5 ГБ | текст + метаданные, медиа не хранится |
| Cron | 1 мин | используется для рассылки, дайджеста, очистки |

Если упрётесь — Workers Paid ($5/мес) снимает большинство ограничений.

---

## Обслуживание и обновление

Обновить код:

```powershell
git pull        # или просто измени файлы
npm install
npm run db:migrate   # если добавились миграции
npm run deploy
```

Посмотреть таблицы:

```powershell
npx wrangler d1 execute anon-msg-bot --remote --command "SELECT COUNT(*) FROM users"
```

Почистить данные вручную:

```sql
-- все сообщения ящика
DELETE FROM reply_keys WHERE message_id IN (SELECT id FROM messages WHERE recipient_id = 123);
DELETE FROM messages WHERE recipient_id = 123;
-- сам пользователь
DELETE FROM blocks WHERE owner_id = 123;
DELETE FROM users WHERE id = 123;
```

Сменить `BOT_SECRET` можно только с потерей старых reply-ключей и банов (они станут невалидны).
После смены нужно перезадать секрет и сделать `npm run deploy`.

---

## Troubleshooting

| Симптом | Причина / решение |
|---|---|
| `503 server is not configured` | Не заданы `BOT_TOKEN`, `BOT_SECRET`, `TELEGRAM_WEBHOOK_SECRET` или binding `DB` |
| Webhook отвечает `403` | `TELEGRAM_WEBHOOK_SECRET` не совпадает с `secret_token` в `setWebhook`. Перезапусти скрипт |
| Бот молчит | `getWebhookInfo` → `last_error_message`. Проверь URL, HTTPS и секрет |
| `D1_ERROR: no such table` | Не применены миграции: `npm run db:migrate` |
| В ссылке `your_bot` | Не задан `BOT_USERNAME`, а `getMe` не сработал. Укажи username в `[vars]` |
| `409 Conflict` | Где-то включён polling (`getUpdates`). Удали старый процесс/воркер |
| Рассылка стоит | Проверь cron-триггер в Dashboard → Worker → Triggers; посмотри логи |
| Жалобы не приходят | `ADMIN_IDS` неверный или админ заблокировал бота |
| Ссылки в ящике отклоняются | По умолчанию ссылки запрещены: `/settings` → «Ссылки» |
| `message is too long` | Текст > 4096 или подпись > 1024 символов |
| Медиа не доставляется | В ящике выключены медиа (`/settings`), либо файл слишком большой для Telegram |

Логи:

```powershell
npx wrangler tail
```

В коде намеренно не логируются тела update и id пользователей.

---

## Безопасность и правовые заметки

- **Не публикуй `BOT_TOKEN` и `BOT_SECRET`.** Токен = полный контроль над ботом.
- Webhook защищён `secret_token`; без него можно подделать админа. Не оставляй
  `TELEGRAM_WEBHOOK_SECRET` пустым: код вернёт `503`.
- Админские callback-кнопки проверяют `from.id` на каждом нажатии.
- HTML-текст экранируется; CSV защищён от formula injection.
- Бот работает только в личных чатах и не читает группы.
- Модерация: жалобы и баны — это минимум. Для публичного бота стоит добавить правила,
  возрастные ограничения и реакцию на незаконный контент.
- Анонимность не отменяет ответственность отправителя перед законом: Telegram и Cloudflare
  располагают метаданными, а бот хранит псевдоним, по которому возможна корреляция.

---

## Что можно добавить дальше

- Несколько админов с ролями (модератор/владелец)
- Жалобы с очередью и SLA, авто-бан после N жалоб
- Реакции через `message_reaction` (нативные)
- Ежедневная сводка в канал
- Тематические ящики (несколько ссылок на одного владельца)
- Веб-страница со статистикой и графиком
- Экспорт в BigQuery/ClickHouse
- Отправка фото-ответов с подписью в одном сообщении
- Локализация на другие языки (сейчас RU/EN)

---

## Лицензия

MIT. Делай что хочешь, но не используй для травли, спама и незаконного контента.
