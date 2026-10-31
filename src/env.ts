export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  BOT_SECRET: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_IDS: string;
  BOT_USERNAME?: string;
  DAILY_DIGEST_HOUR_UTC?: string;
  LIMIT_PER_MIN?: string;
  LIMIT_PER_HOUR?: string;
  LIMIT_PER_DAY?: string;
  MIN_INTERVAL_SEC?: string;
  REPLY_TTL_DAYS?: string;
  CONTENT_TTL_DAYS?: string;
}

export interface Limits {
  perMin: number;
  perHour: number;
  perDay: number;
  minInterval: number;
}

export function intEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function parseAdminIds(env: Env): number[] {
  return (env.ADMIN_IDS ?? '')
    .split(/[,\s]+/)
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

export function isAdmin(env: Env, userId: number): boolean {
  return parseAdminIds(env).includes(userId);
}

export function getLimits(env: Env): Limits {
  return {
    perMin: intEnv(env.LIMIT_PER_MIN, 4),
    perHour: intEnv(env.LIMIT_PER_HOUR, 15),
    perDay: intEnv(env.LIMIT_PER_DAY, 40),
    minInterval: intEnv(env.MIN_INTERVAL_SEC, 3),
  };
}

export function replyTtlDays(env: Env): number {
  return intEnv(env.REPLY_TTL_DAYS, 7);
}

export function contentTtlDays(env: Env): number {
  return intEnv(env.CONTENT_TTL_DAYS, 30);
}

export function digestHour(env: Env): number {
  const raw = Number(env.DAILY_DIGEST_HOUR_UTC);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 9;
}
