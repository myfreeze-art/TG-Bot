import type { Settings } from './db.ts';
import type { Lang } from './i18n.ts';
import { kindLabel, t } from './i18n.ts';
import { displayName, escapeHtml, fmtInt, formatDateTime, isoDay, shortDay, sparkline, buildCsv } from './format.ts';

const DAY = 86400;

const KIND_EMOJI: Record<string, string> = {
  text: '📝',
  photo: '🖼',
  video: '🎬',
  animation: '🎞',
  audio: '🎧',
  voice: '🎙',
  document: '📎',
  sticker: '🃏',
  video_note: '⭕️',
  poll: '📊',
  other: '❔',
};

export function dayStart(now: number): number {
  return Math.floor(now / DAY) * DAY;
}

async function scalar(db: D1Database, sql: string, ...binds: Array<string | number>): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

function dayKeys(count: number, now: number): string[] {
  const start = dayStart(now);
  const keys: string[] = [];
  for (let index = count - 1; index >= 0; index -= 1) keys.push(isoDay(start - index * DAY));
  return keys;
}

async function dailyCounts(
  db: D1Database,
  table: 'messages' | 'users',
  column: 'created_at' | 'replied_at',
  count: number,
  now: number,
): Promise<number[]> {
  const start = dayStart(now) - (count - 1) * DAY;
  const result = await db
    .prepare(
      `SELECT strftime('%Y-%m-%d', ${column}, 'unixepoch') AS day, COUNT(*) AS n
       FROM ${table}
       WHERE ${column} IS NOT NULL AND ${column} >= ?
       GROUP BY day`,
    )
    .bind(start)
    .all<{ day: string; n: number }>();
  const map = new Map((result.results ?? []).map((row) => [row.day, Number(row.n)]));
  return dayKeys(count, now).map((key) => map.get(key) ?? 0);
}

export interface Overview {
  users: number;
  usersToday: number;
  users7: number;
  messages: number;
  messagesToday: number;
  messages7: number;
  replies: number;
  replyRate: number;
  bans: number;
  reportsNew: number;
  activeInboxes: number;
  series7: number[];
}

export async function loadOverview(db: D1Database, now: number): Promise<Overview> {
  const today = dayStart(now);
  const weekAgo = now - 7 * DAY;

  const [
    users,
    usersToday,
    users7,
    messages,
    messagesToday,
    messages7,
    replies,
    bans,
    reportsNew,
    activeInboxes,
    series7,
  ] = await Promise.all([
    scalar(db, 'SELECT COUNT(*) AS n FROM users'),
    scalar(db, 'SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', today),
    scalar(db, 'SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', weekAgo),
    scalar(db, 'SELECT COUNT(*) AS n FROM messages'),
    scalar(db, 'SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?', today),
    scalar(db, 'SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?', weekAgo),
    scalar(db, 'SELECT COUNT(*) AS n FROM messages WHERE replied_at IS NOT NULL'),
    scalar(db, 'SELECT COUNT(*) AS n FROM bans'),
    scalar(db, "SELECT COUNT(*) AS n FROM reports WHERE status = 'new'"),
    scalar(db, 'SELECT COUNT(*) AS n FROM users WHERE accept_messages = 1 AND is_blocked = 0'),
    dailyCounts(db, 'messages', 'created_at', 7, now),
  ]);

  return {
    users,
    usersToday,
    users7,
    messages,
    messagesToday,
    messages7,
    replies,
    replyRate: messages > 0 ? Math.round((replies / messages) * 100) : 0,
    bans,
    reportsNew,
    activeInboxes,
    series7,
  };
}

export function renderOverview(data: Overview, settings: Settings, lang: Lang, now: number): string {
  return t(lang, 'admin.overview', {
    users: fmtInt(data.users),
    usersToday: fmtInt(data.usersToday),
    users7: fmtInt(data.users7),
    messages: fmtInt(data.messages),
    messagesToday: fmtInt(data.messagesToday),
    messages7: fmtInt(data.messages7),
    replies: fmtInt(data.replies),
    replyRate: String(data.replyRate),
    bans: fmtInt(data.bans),
    reportsNew: fmtInt(data.reportsNew),
    activeInboxes: fmtInt(data.activeInboxes),
    spark: sparkline(data.series7),
    max: fmtInt(Math.max(0, ...data.series7)),
    maint: settings.maintenance ? t(lang, 'on') : t(lang, 'off'),
    strict: settings.strictAnon ? t(lang, 'on') : t(lang, 'off'),
    updated: formatDateTime(now),
  });
}

export async function renderDynamics(db: D1Database, days: 7 | 30, lang: Lang, now: number): Promise<string> {
  const [messagesSeries, usersSeries, replies] = await Promise.all([
    dailyCounts(db, 'messages', 'created_at', days, now),
    dailyCounts(db, 'users', 'created_at', days, now),
    scalar(db, 'SELECT COUNT(*) AS n FROM messages WHERE replied_at >= ?', dayStart(now) - (days - 1) * DAY),
  ]);

  const messagesTotal = messagesSeries.reduce((sum, value) => sum + value, 0);
  const usersTotal = usersSeries.reduce((sum, value) => sum + value, 0);

  const hourly = await db
    .prepare(
      `SELECT CAST(strftime('%H', created_at, 'unixepoch') AS INTEGER) AS h, COUNT(*) AS n
       FROM messages WHERE created_at >= ? GROUP BY h ORDER BY n DESC LIMIT 1`,
    )
    .bind(now - 7 * DAY)
    .first<{ h: number; n: number }>();

  const peak = hourly
    ? t(lang, 'admin.peak', {
        from: String(hourly.h).padStart(2, '0'),
        to: String((hourly.h + 1) % 24).padStart(2, '0'),
        count: fmtInt(Number(hourly.n)),
      })
    : '';

  const tailLength = Math.min(days, 7);
  const tail = messagesSeries
    .slice(-tailLength)
    .map((value, index) => {
      const day = dayKeys(days, now)[days - tailLength + index] ?? '';
      return t(lang, 'admin.dayLine', { date: shortDay(day), count: fmtInt(value) });
    })
    .join('\n');

  return [
    t(lang, 'admin.dynamicsTitle', { days: String(days) }),
    '',
    t(lang, 'admin.dynamicsTotals', {
      messages: fmtInt(messagesTotal),
      users: fmtInt(usersTotal),
      replies: fmtInt(replies),
      avg: fmtInt(Math.round(messagesTotal / days)),
      spark: sparkline(messagesSeries),
      peak,
    }),
    '',
    tail,
  ].join('\n');
}

export async function renderKinds(db: D1Database, lang: Lang, now: number): Promise<string> {
  const since = now - 30 * DAY;
  const result = await db
    .prepare('SELECT kind, COUNT(*) AS n FROM messages WHERE created_at >= ? GROUP BY kind ORDER BY n DESC')
    .bind(since)
    .all<{ kind: string; n: number }>();
  const rows = result.results ?? [];
  const total = rows.reduce((sum, row) => sum + Number(row.n), 0);
  if (!rows.length || total <= 0) {
    return [t(lang, 'admin.kindsTitle'), '', t(lang, 'admin.kindsEmpty')].join('\n');
  }

  const lines = rows.map((row) => {
    const count = Number(row.n);
    const percent = Math.round((count / total) * 100);
    return t(lang, 'admin.kindLine', {
      emoji: KIND_EMOJI[row.kind] ?? KIND_EMOJI.other,
      label: kindLabel(lang, row.kind),
      count: fmtInt(count),
      percent: String(percent),
    });
  });

  return [t(lang, 'admin.kindsTitle'), '', ...lines].join('\n');
}

export async function renderTop(db: D1Database, lang: Lang, now: number): Promise<string> {
  const result = await db
    .prepare(
      `SELECT m.recipient_id AS id, COUNT(*) AS n, u.username, u.first_name
       FROM messages m LEFT JOIN users u ON u.id = m.recipient_id
       WHERE m.created_at >= ?
       GROUP BY m.recipient_id ORDER BY n DESC LIMIT 10`,
    )
    .bind(now - 30 * DAY)
    .all<{ id: number; n: number; username: string | null; first_name: string | null }>();

  const rows = result.results ?? [];
  if (!rows.length) {
    return [t(lang, 'admin.topTitle'), '', t(lang, 'admin.topEmpty')].join('\n');
  }

  const lines = rows.map((row, index) =>
    t(lang, 'admin.topLine', {
      rank: String(index + 1),
      name: escapeHtml(displayName(row.username, row.first_name)),
      count: fmtInt(Number(row.n)),
    }),
  );

  return [t(lang, 'admin.topTitle'), '', ...lines].join('\n');
}

export async function buildStatsCsv(db: D1Database, now: number): Promise<string> {
  const days = 30;
  const [messagesSeries, usersSeries, kinds, hourly, top, totals] = await Promise.all([
    dailyCounts(db, 'messages', 'created_at', days, now),
    dailyCounts(db, 'users', 'created_at', days, now),
    db
      .prepare('SELECT kind, COUNT(*) AS n FROM messages WHERE created_at >= ? GROUP BY kind ORDER BY n DESC')
      .bind(now - days * DAY)
      .all<{ kind: string; n: number }>(),
    db
      .prepare(
        `SELECT CAST(strftime('%H', created_at, 'unixepoch') AS INTEGER) AS h, COUNT(*) AS n
         FROM messages WHERE created_at >= ? GROUP BY h ORDER BY h`,
      )
      .bind(now - 7 * DAY)
      .all<{ h: number; n: number }>(),
    db
      .prepare(
        `SELECT m.recipient_id AS id, COUNT(*) AS n, u.username, u.first_name
         FROM messages m LEFT JOIN users u ON u.id = m.recipient_id
         WHERE m.created_at >= ? GROUP BY m.recipient_id ORDER BY n DESC LIMIT 20`,
      )
      .bind(now - days * DAY)
      .all<{ id: number; n: number; username: string | null; first_name: string | null }>(),
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM messages) AS messages,
           (SELECT COUNT(*) FROM messages WHERE replied_at IS NOT NULL) AS replies,
           (SELECT COUNT(*) FROM bans) AS bans,
           (SELECT COUNT(*) FROM reports WHERE status = 'new') AS reports`,
      )
      .first<{ users: number; messages: number; replies: number; bans: number; reports: number }>(),
  ]);

  const keys = dayKeys(days, now);
  const rows: Array<Array<string | number>> = [
    ['section', 'key', 'messages', 'new_users', 'replies', 'value'],
    ['total', 'messages', Number(totals?.messages ?? 0), '', '', ''],
    ['total', 'users', '', Number(totals?.users ?? 0), '', ''],
    ['total', 'replies', '', '', Number(totals?.replies ?? 0), ''],
    ['moderation', 'bans', '', '', '', Number(totals?.bans ?? 0)],
    ['moderation', 'new_reports', '', '', '', Number(totals?.reports ?? 0)],
    ['meta', 'generated_at_utc', '', '', '', new Date(now * 1000).toISOString()],
  ];

  keys.forEach((key, index) => {
    rows.push(['daily', key, messagesSeries[index] ?? 0, usersSeries[index] ?? 0, '', '']);
  });
  for (const row of kinds.results ?? []) rows.push(['kind', row.kind, Number(row.n), '', '', '']);
  for (const row of hourly.results ?? []) {
    rows.push(['hour_utc_7d', String(row.h).padStart(2, '0'), Number(row.n), '', '', '']);
  }
  for (const row of top.results ?? []) {
    rows.push(['top_inbox', displayName(row.username, row.first_name), Number(row.n), '', '', '']);
  }

  return buildCsv(rows);
}

export interface DigestData {
  messages: number;
  users: number;
  replies: number;
  reports: number;
  bans: number;
  series: number[];
  topKind: string;
}

export async function loadDigest(db: D1Database, now: number): Promise<DigestData> {
  const today = dayStart(now);
  const yesterday = today - DAY;

  const [messages, users, replies, reports, bans, series, topKindRow] = await Promise.all([
    scalar(db, 'SELECT COUNT(*) AS n FROM messages WHERE created_at >= ? AND created_at < ?', yesterday, today),
    scalar(db, 'SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', yesterday, today),
    scalar(db, 'SELECT COUNT(*) AS n FROM messages WHERE replied_at >= ? AND replied_at < ?', yesterday, today),
    scalar(db, 'SELECT COUNT(*) AS n FROM reports WHERE created_at >= ? AND created_at < ?', yesterday, today),
    scalar(db, 'SELECT COUNT(*) AS n FROM bans'),
    dailyCounts(db, 'messages', 'created_at', 7, now),
    db
      .prepare(
        'SELECT kind, COUNT(*) AS n FROM messages WHERE created_at >= ? AND created_at < ? GROUP BY kind ORDER BY n DESC LIMIT 1',
      )
      .bind(yesterday, today)
      .first<{ kind: string; n: number }>(),
  ]);

  return {
    messages,
    users,
    replies,
    reports,
    bans,
    series,
    topKind: topKindRow?.kind ?? 'other',
  };
}

export function renderDigest(data: DigestData, lang: Lang, now: number): string {
  const date = shortDay(isoDay(now - DAY));
  return [
    t(lang, 'digest.title', { date }),
    '',
    t(lang, 'digest.body', {
      messages: fmtInt(data.messages),
      users: fmtInt(data.users),
      replies: fmtInt(data.replies),
      reports: fmtInt(data.reports),
      bans: fmtInt(data.bans),
    }),
    '',
    t(lang, 'digest.week', { spark: sparkline(data.series) }),
    t(lang, 'digest.topKind', {
      kind: `${KIND_EMOJI[data.topKind] ?? KIND_EMOJI.other} ${kindLabel(lang, data.topKind)}`,
    }),
  ].join('\n');
}
