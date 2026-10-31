import type { TgUser } from './types.ts';
import type { Limits } from './env.ts';
import { normalizeLang } from './i18n.ts';
import { randomToken } from './crypto.ts';

export interface UserRow {
  id: number;
  username: string | null;
  first_name: string | null;
  lang: string;
  inbox_token: string;
  accept_messages: number;
  allow_media: number;
  allow_links: number;
  notify_reactions: number;
  target_id: number | null;
  target_at: number | null;
  is_blocked: number;
  created_at: number;
  last_seen_at: number;
}

export interface MessageRow {
  id: number;
  recipient_id: number;
  sender_key: string;
  kind: string;
  content_preview: string | null;
  content_hash: string | null;
  has_link: number;
  delivered_message_id: number | null;
  created_at: number;
  replied_at: number | null;
}

export interface SessionRow {
  user_id: number;
  state: string;
  data: string | null;
  updated_at: number;
}

export interface ReplyKeyRow {
  message_id: number;
  ref: string;
  created_at: number;
  expires_at: number;
}

export interface BanRow {
  sender_key: string;
  reason: string | null;
  created_at: number;
  expires_at: number | null;
}

export interface ReportRow {
  id: number;
  message_id: number;
  recipient_id: number;
  sender_key: string;
  kind: string;
  content_preview: string | null;
  status: string;
  created_at: number;
  reviewed_at: number | null;
}

export interface ReportWithOwner extends ReportRow {
  owner_username: string | null;
  owner_first_name: string | null;
}

export interface BroadcastRow {
  id: number;
  admin_id: number;
  from_chat_id: number;
  message_id: number;
  status: string;
  sent: number;
  failed: number;
  last_user_id: number;
  attempts: number;
  locked_until: number;
  worker_url: string | null;
  progress_chat_id: number | null;
  progress_message_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface Settings {
  maintenance: boolean;
  strictAnon: boolean;
  digest: boolean;
  lastDigestDate: string;
}

interface RateRow {
  sender_key: string;
  minute_start: number;
  minute_count: number;
  hour_start: number;
  hour_count: number;
  day_start: number;
  day_count: number;
  last_at: number;
}

const DEFAULT_SETTINGS: Settings = {
  maintenance: false,
  strictAnon: false,
  digest: true,
  lastDigestDate: '',
};

const SETTINGS_TTL_MS = 10_000;
const settingsCache = new WeakMap<D1Database, { at: number; values: Settings }>();

function parseSettings(rows: Array<{ key: string; value: string }>): Settings {
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
    maintenance: map.get('maintenance') === '1',
    strictAnon: map.get('strict_anon') === '1',
    digest: map.get('digest') !== '0',
    lastDigestDate: map.get('last_digest_date') ?? DEFAULT_SETTINGS.lastDigestDate,
  };
}

export async function getSettings(db: D1Database, nowMs = Date.now()): Promise<Settings> {
  const cached = settingsCache.get(db);
  if (cached && nowMs - cached.at < SETTINGS_TTL_MS) return cached.values;
  const result = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const values = parseSettings(result.results ?? []);
  settingsCache.set(db, { at: nowMs, values });
  return values;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
  settingsCache.delete(db);
}

/**
 * Атомарно «занимает» дату дайджеста. Возвращает false, если дайджест за эту дату уже отправлен.
 * Защищает от дублей при нескольких изолятах/повторном cron.
 */
export async function claimDigestDate(db: D1Database, date: string): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('last_digest_date', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value <> excluded.value",
    )
    .bind(date)
    .run();
  settingsCache.delete(db);
  return Boolean(result.meta.changes);
}

export async function getUser(db: D1Database, id: number): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function getUserByToken(db: D1Database, token: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE inbox_token = ?').bind(token).first<UserRow>();
}

function isUniqueViolation(error: unknown): boolean {
  return /UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error));
}

/** Создаёт или обновляет пользователя. last_seen_at обновляется не чаще раза в 5 минут. */
export async function touchUser(db: D1Database, from: TgUser, now: number): Promise<UserRow> {
  const existing = await getUser(db, from.id);
  const username = from.username ?? null;
  const firstName = from.first_name ?? null;

  if (existing) {
    if (now - existing.last_seen_at > 300 || existing.username !== username || existing.first_name !== firstName) {
      await db
        .prepare('UPDATE users SET username = ?, first_name = ?, last_seen_at = ? WHERE id = ?')
        .bind(username, firstName, now, from.id)
        .run();
      return { ...existing, username, first_name: firstName, last_seen_at: now };
    }
    return existing;
  }

  const initialLang = normalizeLang(from.language_code);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await db
        .prepare(
          'INSERT INTO users (id, username, first_name, lang, inbox_token, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(from.id, username, firstName, initialLang, randomToken(16), now, now)
        .run();
      const created = await getUser(db, from.id);
      if (created) return created;
      throw new Error('user row was not created');
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 4) throw error;
    }
  }
  throw new Error('failed to create user');
}

const MUTABLE_FLAGS = new Set(['accept_messages', 'allow_media', 'allow_links', 'notify_reactions', 'lang']);

export async function setUserFlag(
  db: D1Database,
  userId: number,
  column: 'accept_messages' | 'allow_media' | 'allow_links' | 'notify_reactions' | 'lang',
  value: number | string,
): Promise<void> {
  if (!MUTABLE_FLAGS.has(column)) throw new Error('column is not mutable');
  await db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).bind(value, userId).run();
}

export async function setTarget(db: D1Database, userId: number, targetId: number | null, now: number): Promise<void> {
  await db.prepare('UPDATE users SET target_id = ?, target_at = ? WHERE id = ?').bind(targetId, now, userId).run();
}

const TARGET_TTL_SECONDS = 24 * 60 * 60;

/** Ящик, в который пользователь сейчас пишет. Ссылка «живёт» сутки. */
export function freshTargetId(user: UserRow, now: number): number | null {
  if (!user.target_id || !user.target_at) return null;
  if (now - user.target_at > TARGET_TTL_SECONDS) return null;
  return user.target_id;
}

export async function getSession(db: D1Database, userId: number): Promise<SessionRow | null> {
  return db.prepare('SELECT * FROM sessions WHERE user_id = ?').bind(userId).first<SessionRow>();
}

export async function setSession(
  db: D1Database,
  userId: number,
  state: string,
  data: string | null,
  now: number,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO sessions (user_id, state, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at',
    )
    .bind(userId, state, data, now)
    .run();
}

export async function clearSession(db: D1Database, userId: number): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

export async function countUserMessages(db: D1Database, userId: number, since = 0): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND created_at >= ?')
    .bind(userId, since)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function countUserReplies(db: D1Database, userId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND replied_at IS NOT NULL')
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export interface NewMessage {
  recipientId: number;
  senderKey: string;
  kind: string;
  preview: string;
  contentHash: string | null;
  hasLink: boolean;
  now: number;
}

export async function insertMessage(db: D1Database, input: NewMessage): Promise<number> {
  const result = await db
    .prepare(
      'INSERT INTO messages (recipient_id, sender_key, kind, content_preview, content_hash, has_link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(input.recipientId, input.senderKey, input.kind, input.preview, input.contentHash, input.hasLink ? 1 : 0, input.now)
    .run();
  const id = Number(result.meta.last_row_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('failed to insert message');
  return id;
}

export async function attachDeliveredMessage(
  db: D1Database,
  messageId: number,
  deliveredMessageId: number,
): Promise<void> {
  await db.prepare('UPDATE messages SET delivered_message_id = ? WHERE id = ?').bind(deliveredMessageId, messageId).run();
}

export async function deleteMessageRow(db: D1Database, messageId: number): Promise<void> {
  await db.prepare('DELETE FROM messages WHERE id = ?').bind(messageId).run();
}

export async function markMessageReplied(db: D1Database, messageId: number, now: number): Promise<void> {
  await db.prepare('UPDATE messages SET replied_at = ? WHERE id = ?').bind(now, messageId).run();
}

export async function getMessage(db: D1Database, messageId: number): Promise<MessageRow | null> {
  return db.prepare('SELECT * FROM messages WHERE id = ?').bind(messageId).first<MessageRow>();
}

export async function getMessageByDeliveredId(
  db: D1Database,
  recipientId: number,
  deliveredMessageId: number,
): Promise<MessageRow | null> {
  return db
    .prepare('SELECT * FROM messages WHERE recipient_id = ? AND delivered_message_id = ?')
    .bind(recipientId, deliveredMessageId)
    .first<MessageRow>();
}

export async function countRecentDuplicates(
  db: D1Database,
  recipientId: number,
  contentHash: string,
  since: number,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND content_hash = ? AND created_at >= ?')
    .bind(recipientId, contentHash, since)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function insertReplyKey(
  db: D1Database,
  messageId: number,
  ref: string,
  now: number,
  ttlDays: number,
): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO reply_keys (message_id, ref, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(messageId, ref, now, now + ttlDays * 86400)
    .run();
}

export async function getReplyKey(db: D1Database, messageId: number): Promise<ReplyKeyRow | null> {
  return db.prepare('SELECT * FROM reply_keys WHERE message_id = ?').bind(messageId).first<ReplyKeyRow>();
}

export async function deleteReplyKey(db: D1Database, messageId: number): Promise<void> {
  await db.prepare('DELETE FROM reply_keys WHERE message_id = ?').bind(messageId).run();
}

/** Строгий режим: стираем все зашифрованные ссылки на отправителей. */
export async function purgeReplyKeys(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM reply_keys').run();
}

/** Блокировка отправителя в одном ящике: старые сообщения тоже перестают быть доступны для ответа. */
export async function revokeReplyKeysForSenderInInbox(
  db: D1Database,
  ownerId: number,
  key: string,
): Promise<void> {
  await db
    .prepare(
      'DELETE FROM reply_keys WHERE message_id IN (SELECT id FROM messages WHERE recipient_id = ? AND sender_key = ?)',
    )
    .bind(ownerId, key)
    .run();
}

/** Глобальный бан: отзываем все ожидающие ответные ключи этого псевдонима. */
export async function revokeReplyKeysForSender(db: D1Database, key: string): Promise<void> {
  await db
    .prepare('DELETE FROM reply_keys WHERE message_id IN (SELECT id FROM messages WHERE sender_key = ?)')
    .bind(key)
    .run();
}

export async function isSenderBlocked(db: D1Database, ownerId: number, key: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS n FROM blocks WHERE owner_id = ? AND sender_key = ?')
    .bind(ownerId, key)
    .first<{ n: number }>();
  return Boolean(row?.n);
}

export async function blockSender(db: D1Database, ownerId: number, key: string, now: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO blocks (owner_id, sender_key, created_at) VALUES (?, ?, ?)')
    .bind(ownerId, key, now)
    .run();
}

export async function countBlocks(db: D1Database, ownerId: number): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE owner_id = ?').bind(ownerId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function clearBlocks(db: D1Database, ownerId: number): Promise<void> {
  await db.prepare('DELETE FROM blocks WHERE owner_id = ?').bind(ownerId).run();
}

export async function isSenderBanned(db: D1Database, key: string, now: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS n FROM bans WHERE sender_key = ? AND (expires_at IS NULL OR expires_at > ?)')
    .bind(key, now)
    .first<{ n: number }>();
  return Boolean(row?.n);
}

export async function banSender(db: D1Database, key: string, reason: string, now: number): Promise<void> {
  await db
    .prepare(
      'INSERT INTO bans (sender_key, reason, created_at, expires_at) VALUES (?, ?, ?, NULL) ON CONFLICT(sender_key) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at, expires_at = NULL',
    )
    .bind(key, reason, now)
    .run();
}

export async function unbanSender(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM bans WHERE sender_key = ?').bind(key).run();
}

export async function countBans(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM bans').first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function listBans(db: D1Database, limit = 10): Promise<BanRow[]> {
  const result = await db.prepare('SELECT * FROM bans ORDER BY created_at DESC LIMIT ?').bind(limit).all<BanRow>();
  return result.results ?? [];
}

export interface RateResult {
  allowed: boolean;
  retryAfter: number;
}

/** Скользящие окна на минуту/час/день + минимальный интервал. */
export async function consumeRate(db: D1Database, key: string, now: number, limits: Limits): Promise<RateResult> {
  const minute = Math.floor(now / 60);
  const hour = Math.floor(now / 3600);
  const day = Math.floor(now / 86400);

  const row = await db.prepare('SELECT * FROM rate_limits WHERE sender_key = ?').bind(key).first<RateRow>();
  let minuteCount = 0;
  let hourCount = 0;
  let dayCount = 0;
  let lastAt = 0;

  if (row) {
    minuteCount = row.minute_start === minute ? row.minute_count : 0;
    hourCount = row.hour_start === hour ? row.hour_count : 0;
    dayCount = row.day_start === day ? row.day_count : 0;
    lastAt = row.last_at;
  }

  if (lastAt > 0 && now - lastAt < limits.minInterval) {
    return { allowed: false, retryAfter: Math.max(1, limits.minInterval - (now - lastAt)) };
  }
  if (minuteCount >= limits.perMin) return { allowed: false, retryAfter: 60 - (now % 60) };
  if (hourCount >= limits.perHour) return { allowed: false, retryAfter: 3600 - (now % 3600) };
  if (dayCount >= limits.perDay) return { allowed: false, retryAfter: 86400 - (now % 86400) };

  await db
    .prepare(
      `INSERT INTO rate_limits (sender_key, minute_start, minute_count, hour_start, hour_count, day_start, day_count, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sender_key) DO UPDATE SET
         minute_start = excluded.minute_start, minute_count = excluded.minute_count,
         hour_start = excluded.hour_start, hour_count = excluded.hour_count,
         day_start = excluded.day_start, day_count = excluded.day_count,
         last_at = excluded.last_at`,
    )
    .bind(key, minute, minuteCount + 1, hour, hourCount + 1, day, dayCount + 1, now)
    .run();

  return { allowed: true, retryAfter: 0 };
}

export async function createReport(
  db: D1Database,
  input: { messageId: number; recipientId: number; senderKey: string; kind: string; preview: string; now: number },
): Promise<number | null> {
  const result = await db
    .prepare(
      `INSERT INTO reports (message_id, recipient_id, sender_key, kind, content_preview, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'new', ?)
       ON CONFLICT(message_id) DO NOTHING`,
    )
    .bind(input.messageId, input.recipientId, input.senderKey, input.kind, input.preview, input.now)
    .run();
  if (!result.meta.changes) return null;
  const id = Number(result.meta.last_row_id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function getReport(db: D1Database, reportId: number): Promise<ReportRow | null> {
  return db.prepare('SELECT * FROM reports WHERE id = ?').bind(reportId).first<ReportRow>();
}

export async function setReportStatus(db: D1Database, reportId: number, status: string, now: number): Promise<void> {
  await db.prepare('UPDATE reports SET status = ?, reviewed_at = ? WHERE id = ?').bind(status, now, reportId).run();
}

export async function countNewReports(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'new'").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function listNewReports(
  db: D1Database,
  limit = 5,
  offset = 0,
): Promise<ReportWithOwner[]> {
  const result = await db
    .prepare(
      `SELECT r.*, u.username AS owner_username, u.first_name AS owner_first_name
       FROM reports r LEFT JOIN users u ON u.id = r.recipient_id
       WHERE r.status = 'new' ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<ReportWithOwner>();
  return result.results ?? [];
}

export async function recordReaction(
  db: D1Database,
  messageId: number,
  emoji: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare('INSERT OR IGNORE INTO reaction_events (message_id, emoji, created_at) VALUES (?, ?, ?)')
    .bind(messageId, emoji, now)
    .run();
  return Boolean(result.meta.changes);
}

export async function createBroadcastJob(
  db: D1Database,
  input: { adminId: number; fromChatId: number; messageId: number; workerUrl: string | null; now: number },
): Promise<number> {
  await db.prepare("DELETE FROM broadcast_jobs WHERE admin_id = ? AND status = 'draft'").bind(input.adminId).run();
  const result = await db
    .prepare(
      `INSERT INTO broadcast_jobs (admin_id, from_chat_id, message_id, status, worker_url, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
    )
    .bind(input.adminId, input.fromChatId, input.messageId, input.workerUrl, input.now, input.now)
    .run();
  return Number(result.meta.last_row_id);
}

export async function getBroadcastJob(db: D1Database, jobId: number): Promise<BroadcastRow | null> {
  return db.prepare('SELECT * FROM broadcast_jobs WHERE id = ?').bind(jobId).first<BroadcastRow>();
}

export async function getActiveBroadcast(db: D1Database): Promise<BroadcastRow | null> {
  return db
    .prepare("SELECT * FROM broadcast_jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1")
    .first<BroadcastRow>();
}

/**
 * Атомарно переводит черновик в running, только если другой рассылки нет.
 * Защищает от двойного клика и гонки между админами.
 */
export async function startBroadcastJob(db: D1Database, jobId: number, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE broadcast_jobs
       SET status = 'running', updated_at = ?
       WHERE id = ? AND status = 'draft'
         AND NOT EXISTS (SELECT 1 FROM broadcast_jobs WHERE status = 'running')`,
    )
    .bind(now, jobId)
    .run();
  return Boolean(result.meta.changes);
}

export async function getLatestBroadcast(db: D1Database): Promise<BroadcastRow | null> {
  return db.prepare('SELECT * FROM broadcast_jobs ORDER BY id DESC LIMIT 1').first<BroadcastRow>();
}

export async function deleteBroadcastJob(db: D1Database, jobId: number): Promise<void> {
  await db.prepare("DELETE FROM broadcast_jobs WHERE id = ? AND status = 'draft'").bind(jobId).run();
}

export async function setBroadcastStatus(
  db: D1Database,
  jobId: number,
  status: string,
  now: number,
): Promise<void> {
  await db.prepare('UPDATE broadcast_jobs SET status = ?, updated_at = ? WHERE id = ?').bind(status, now, jobId).run();
}

/** Переводит running -> done только если рассылка ещё не была остановлена. */
export async function completeBroadcast(db: D1Database, jobId: number, now: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE broadcast_jobs SET status = 'done', locked_until = 0, updated_at = ? WHERE id = ? AND status = 'running'")
    .bind(now, jobId)
    .run();
  return Boolean(result.meta.changes);
}

export async function setBroadcastProgressTarget(
  db: D1Database,
  jobId: number,
  chatId: number,
  messageId: number,
  now: number,
): Promise<void> {
  await db
    .prepare('UPDATE broadcast_jobs SET progress_chat_id = ?, progress_message_id = ?, updated_at = ? WHERE id = ?')
    .bind(chatId, messageId, now, jobId)
    .run();
}

export async function setBroadcastProgress(
  db: D1Database,
  jobId: number,
  progress: { sent: number; failed: number; lastUserId: number; attempts: number; now: number },
): Promise<void> {
  await db
    .prepare(
      'UPDATE broadcast_jobs SET sent = ?, failed = ?, last_user_id = ?, attempts = ?, updated_at = ? WHERE id = ?',
    )
    .bind(progress.sent, progress.failed, progress.lastUserId, progress.attempts, progress.now, jobId)
    .run();
}

export async function acquireBroadcastLock(
  db: D1Database,
  jobId: number,
  now: number,
  ttlSeconds = 120,
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE broadcast_jobs SET locked_until = ? WHERE id = ? AND locked_until < ?')
    .bind(now + ttlSeconds, jobId, now)
    .run();
  return Boolean(result.meta.changes);
}

export async function releaseBroadcastLock(db: D1Database, jobId: number): Promise<void> {
  await db.prepare('UPDATE broadcast_jobs SET locked_until = 0 WHERE id = ?').bind(jobId).run();
}

export async function countBroadcastRecipients(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_blocked = 0').first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function nextBroadcastRecipients(
  db: D1Database,
  afterUserId: number,
  limit: number,
): Promise<number[]> {
  const result = await db
    .prepare('SELECT id FROM users WHERE id > ? AND is_blocked = 0 ORDER BY id ASC LIMIT ?')
    .bind(afterUserId, limit)
    .all<{ id: number }>();
  return (result.results ?? []).map((row) => Number(row.id));
}

export async function countUsersAfter(db: D1Database, afterUserId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM users WHERE id > ? AND is_blocked = 0')
    .bind(afterUserId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}
