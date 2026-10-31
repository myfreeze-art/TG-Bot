import type { Env } from './env.ts';
import type { TgUpdate } from './types.ts';
import { createCtx } from './ctx.ts';
import { hmacHex, timingSafeEqual } from './crypto.ts';
import { drainBroadcast } from './broadcast.ts';
import { onCallback, onMessage } from './user.ts';
import { runCron } from './cron.ts';

async function handleUpdate(env: Env, update: TgUpdate, origin: string, execution: ExecutionContext): Promise<void> {
  const ctx = await createCtx(env, origin, execution);
  if (update.message) {
    await onMessage(ctx, update.message);
    return;
  }
  if (update.callback_query) {
    await onCallback(ctx, update.callback_query);
  }
}

function configured(env: Env): boolean {
  return Boolean(env.BOT_TOKEN && env.BOT_SECRET && env.TELEGRAM_WEBHOOK_SECRET && env.DB);
}

const ZERO_DATABASE_ID = '00000000-0000-0000-0000-000000000000';

export default {
  async fetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ ok: true, configured: configured(env) }), {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      return new Response('anon-msg-bot is running ✅', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }

    if (!configured(env)) {
      console.error('missing required secrets or bindings');
      return new Response('server is not configured', { status: 503 });
    }

    // Внутренний эндпоинт для самопродолжающейся рассылки.
    if (url.pathname === '/__internal/broadcast') {
      const provided = request.headers.get('x-internal-token') ?? '';
      const expected = await hmacHex(env.BOT_SECRET, 'internal-broadcast-v1');
      if (!timingSafeEqual(provided, expected)) {
        return new Response('forbidden', { status: 403 });
      }
      const ctx = await createCtx(env, url.origin, execution);
      execution.waitUntil(
        drainBroadcast(ctx).catch((error) => {
          console.error('broadcast drain failed', error instanceof Error ? error.message : String(error));
        }),
      );
      return new Response('ok');
    }

    if (url.pathname !== '/' && url.pathname !== '/webhook') {
      return new Response('not found', { status: 404 });
    }

    if (env.DB && (env.DB as { databaseId?: unknown }).databaseId === ZERO_DATABASE_ID) {
      console.error('D1 database_id is still the placeholder from wrangler.toml');
      return new Response('D1 binding points to a placeholder database_id', { status: 503 });
    }

    const providedSecret = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
    if (!timingSafeEqual(providedSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response('forbidden', { status: 403 });
    }

    let update: TgUpdate;
    try {
      update = (await request.json()) as TgUpdate;
    } catch {
      return new Response('bad request', { status: 400 });
    }

    execution.waitUntil(
      handleUpdate(env, update, url.origin, execution).catch((error) => {
        // Никаких текстов сообщений и id в логах.
        console.error('update failed', error instanceof Error ? error.message : String(error));
      }),
    );

    return new Response('ok');
  },

  async scheduled(_event: ScheduledController, env: Env, execution: ExecutionContext): Promise<void> {
    if (!configured(env)) return;
    execution.waitUntil(
      runCron(env, execution).catch((error) => {
        console.error('cron failed', error instanceof Error ? error.message : String(error));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
