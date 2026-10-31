import type { Env } from './env.ts';
import { contentTtlDays, digestHour, parseAdminIds } from './env.ts';
import { createCtx } from './ctx.ts';
import { claimDigestDate, getSettings, getUser } from './db.ts';
import { loadDigest, renderDigest } from './stats.ts';
import { normalizeLang } from './i18n.ts';
import { safeSend } from './notify.ts';
import { drainBroadcast } from './broadcast.ts';

const DAY = 86400;

async function maybeSendDigest(ctx: Awaited<ReturnType<typeof createCtx>>): Promise<void> {
  const now = new Date();
  if (now.getUTCHours() !== digestHour(ctx.env)) return;

  const settings = await getSettings(ctx.db);
  if (!settings.digest) return;

  const date = now.toISOString().slice(0, 10);
  if (settings.lastDigestDate === date) return;
  if (!(await claimDigestDate(ctx.db, date))) return;

  const data = await loadDigest(ctx.db, Math.floor(now.getTime() / 1000));
  for (const adminId of parseAdminIds(ctx.env)) {
    const admin = await getUser(ctx.db, adminId);
    const lang = normalizeLang(admin?.lang);
    await safeSend(ctx, adminId, renderDigest(data, lang, Math.floor(now.getTime() / 1000)));
  }
}

async function cleanup(ctx: Awaited<ReturnType<typeof createCtx>>): Promise<void> {
  if (new Date().getUTCMinutes() !== 7) return;
  const now = Math.floor(Date.now() / 1000);

  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM reply_keys WHERE expires_at <= ?').bind(now),
    ctx.db.prepare('DELETE FROM rate_limits WHERE last_at < ?').bind(now - 2 * DAY),
    ctx.db.prepare('DELETE FROM sessions WHERE updated_at < ?').bind(now - DAY),
    ctx.db
      .prepare('UPDATE messages SET content_preview = NULL WHERE content_preview IS NOT NULL AND created_at < ?')
      .bind(now - contentTtlDays(ctx.env) * DAY),
    ctx.db
      .prepare("DELETE FROM reports WHERE status <> 'new' AND reviewed_at IS NOT NULL AND reviewed_at < ?")
      .bind(now - 90 * DAY),
    ctx.db.prepare('DELETE FROM reaction_events WHERE created_at < ?').bind(now - 7 * DAY),
    ctx.db
      .prepare("DELETE FROM broadcast_jobs WHERE status IN ('done', 'stopped') AND updated_at < ?")
      .bind(now - 7 * DAY),
  ]);
}

export async function runCron(env: Env, execution: ExecutionContext): Promise<void> {
  const ctx = await createCtx(env, '', execution);
  await drainBroadcast(ctx);
  await maybeSendDigest(ctx);
  await cleanup(ctx);
}
