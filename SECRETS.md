# Секреты и переменные: куда что вставлять

Коротко: **в GitHub-репозиторий (`wrangler.dashboard.jsonc`, код) ни токен, ни BOT_SECRET не попадают** —
они вводятся в Cloudflare. GitHub хранит их только как Actions Secrets, если ты хочешь, чтобы
вебхук и секреты бота ставились автоматически при деплое.

## 1. Всегда нужные секреты — Cloudflare Dashboard

Worker `anon-msg-bot` → **Settings → Variables and Secrets** → **Add** → тип **Secret** →
имя → значение → Save → Deploy (кнопка «Deploy latest changes»).

| Имя (Name) | Значение | Как получить |
|---|---|---|
| `BOT_TOKEN` | `123456789:AA...` | @BotFather → /mybots → твой бот → API Token |
| `BOT_SECRET` | 64 символа `0-9a-f` | `openssl rand -hex 32` (или `scripts/make-secrets.ps1`) |
| `TELEGRAM_WEBHOOK_SECRET` | 64 символа `0-9a-f` | там же |
| `ADMIN_IDS` | `123456789` — твой id | @userinfobot |
| `BOT_USERNAME` | `my_anon_bot` без `@` | имя, которое дал в BotFather |

`BOT_SECRET` — не меняй после запуска: сломаются старые ссылки для ответов и баны.
Всё остальное (лимиты, `DAILY_DIGEST_HOUR_UTC`, `REPLY_TTL_DAYS`) — тоже сюда, как обычные переменные (тип «Text»/Plaintext).

## 2. GitHub Secrets и Variables (для автоустановки webhook)

GitHub-репозиторий → **Settings → Secrets and variables → Actions**:

- вкладка **Secrets** → New repository secret:
  `BOT_TOKEN`, `BOT_SECRET`, `TELEGRAM_WEBHOOK_SECRET`
- вкладка **Variables** → New repository variable:
  `ADMIN_IDS`, `BOT_USERNAME`

Это нужно только если ты будешь запускать полную версию деплоя через GitHub Actions.
Простой вариант «залить в GitHub → бот всё равно собирается в Cloudflare» — без этого.

## 3. Ключи/другие варианты — НЕ подходят

- Файл `.dev.vars` — только для локального `wrangler dev`, в GitHub его не коммитить.
- `wrangler.jsonc` / `wrangler.toml` / `wrangler.dashboard.jsonc` — публичные, туда секреты не пишем.
- `.dev.vars.example` — пример без значений.

## 4. Проверка, что всё на месте

1. Открой `https://anon-msg-bot.<subdomain>.workers.dev/health` →
   `{"ok":true,"configured":true}` — бот включён и секреты заданы.
2. `"mode":"placeholder"` — в `wrangler.jsonc` `main` всё ещё указывает на `src/placeholder.ts`.
3. `configured:false` — не задан один из трёх секретов (`BOT_TOKEN`, `BOT_SECRET`,
   `TELEGRAM_WEBHOOK_SECRET`).
4. `npx wrangler tail` — живые логи Worker (ошибки Telegram API, D1 и т.п.).
