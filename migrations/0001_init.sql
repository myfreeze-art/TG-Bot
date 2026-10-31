-- anon-msg-bot · начальная схема D1
-- Все временные метки — Unix seconds (UTC).

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,          -- Telegram user id владельца ящика
  username          TEXT,
  first_name        TEXT,
  lang              TEXT    NOT NULL DEFAULT 'ru',
  inbox_token       TEXT    NOT NULL UNIQUE,      -- случайный токен для deep-link
  accept_messages   INTEGER NOT NULL DEFAULT 1,
  allow_media       INTEGER NOT NULL DEFAULT 1,
  allow_links       INTEGER NOT NULL DEFAULT 0,
  notify_reactions  INTEGER NOT NULL DEFAULT 1,
  target_id         INTEGER,                      -- ящик, в который сейчас пишет пользователь
  target_at         INTEGER,
  is_blocked        INTEGER NOT NULL DEFAULT 0,   -- глобальный бан
  created_at        INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_created   ON users (created_at);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen_at);

-- ВАЖНО: здесь нет telegram id отправителя.
-- sender_key — необратимый HMAC-псевдоним, нужен только для бана/блокировки.
CREATE TABLE IF NOT EXISTS messages (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id         INTEGER NOT NULL,
  sender_key           TEXT    NOT NULL,
  kind                 TEXT    NOT NULL,
  content_preview      TEXT,
  content_hash         TEXT,
  has_link             INTEGER NOT NULL DEFAULT 0,
  delivered_message_id INTEGER,
  created_at           INTEGER NOT NULL,
  replied_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages (recipient_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_created   ON messages (created_at);
CREATE INDEX IF NOT EXISTS idx_messages_delivered ON messages (recipient_id, delivered_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_hash      ON messages (recipient_id, content_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender    ON messages (sender_key);
CREATE INDEX IF NOT EXISTS idx_messages_owner_sender ON messages (recipient_id, sender_key);

-- Зашифрованный (AES-256-GCM) id отправителя. Живёт только до ответа / истечения TTL.
-- Ни одна админская команда не читает эту таблицу.
CREATE TABLE IF NOT EXISTS reply_keys (
  message_id INTEGER PRIMARY KEY,
  ref        TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reply_keys_expires ON reply_keys (expires_at);

CREATE TABLE IF NOT EXISTS blocks (
  owner_id   INTEGER NOT NULL,
  sender_key TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, sender_key)
);

CREATE TABLE IF NOT EXISTS bans (
  sender_key TEXT PRIMARY KEY,
  reason     TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS rate_limits (
  sender_key   TEXT PRIMARY KEY,
  minute_start INTEGER NOT NULL,
  minute_count INTEGER NOT NULL,
  hour_start   INTEGER NOT NULL,
  hour_count   INTEGER NOT NULL,
  day_start    INTEGER NOT NULL,
  day_count    INTEGER NOT NULL,
  last_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_last ON rate_limits (last_at);

CREATE TABLE IF NOT EXISTS sessions (
  user_id    INTEGER PRIMARY KEY,
  state      TEXT    NOT NULL,
  data       TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      INTEGER NOT NULL,
  recipient_id    INTEGER NOT NULL,
  sender_key      TEXT    NOT NULL,
  kind            TEXT    NOT NULL,
  content_preview TEXT,
  status          TEXT    NOT NULL DEFAULT 'new',  -- new | banned | dismissed
  created_at      INTEGER NOT NULL,
  reviewed_at     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_message ON reports (message_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at);

CREATE TABLE IF NOT EXISTS reaction_events (
  message_id INTEGER NOT NULL,
  emoji      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, emoji)
);

CREATE TABLE IF NOT EXISTS broadcast_jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id            INTEGER NOT NULL,
  from_chat_id        INTEGER NOT NULL,
  message_id          INTEGER NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'draft', -- draft|running|done|stopped
  sent                INTEGER NOT NULL DEFAULT 0,
  failed              INTEGER NOT NULL DEFAULT 0,
  last_user_id        INTEGER NOT NULL DEFAULT 0,
  attempts            INTEGER NOT NULL DEFAULT 0,
  locked_until        INTEGER NOT NULL DEFAULT 0,
  worker_url          TEXT,
  progress_chat_id    INTEGER,
  progress_message_id INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broadcast_status ON broadcast_jobs (status);
-- В один момент времени может быть только одна running-рассылка.
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_one_running ON broadcast_jobs (status) WHERE status = 'running';

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('maintenance', '0'),
  ('strict_anon', '0'),
  ('digest', '1'),
  ('last_digest_date', '');
