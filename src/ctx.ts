import type { Env } from './env.ts';
import { Telegram } from './telegram.ts';

export interface Ctx {
  env: Env;
  api: Telegram;
  db: D1Database;
  now: number;
  origin: string;
  waitUntil: (promise: Promise<unknown>) => void;
}

export async function createCtx(env: Env, origin: string, execution: ExecutionContext): Promise<Ctx> {
  return {
    env,
    api: new Telegram(env.BOT_TOKEN),
    db: env.DB,
    now: Math.floor(Date.now() / 1000),
    origin,
    waitUntil: (promise) => execution.waitUntil(promise),
  };
}

let botUsernameCache: { token: string; username: string } | null = null;

export async function getBotUsername(ctx: Ctx): Promise<string> {
  const configured = ctx.env.BOT_USERNAME?.trim().replace(/^@/, '');
  if (configured) return configured;
  if (botUsernameCache && botUsernameCache.token === ctx.env.BOT_TOKEN) return botUsernameCache.username;
  try {
    const me = await ctx.api.getMe();
    if (me.username) {
      botUsernameCache = { token: ctx.env.BOT_TOKEN, username: me.username };
      return me.username;
    }
  } catch (error) {
    console.error('getMe failed', error instanceof Error ? error.message : String(error));
  }
  return 'your_bot';
}

export function inboxLink(username: string, token: string): string {
  return `https://t.me/${username}?start=u_${token}`;
}
