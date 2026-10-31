import type { Ctx } from './ctx.ts';
import type { BroadcastRow, UserRow } from './db.ts';
import {
  acquireBroadcastLock,
  clearSession,
  completeBroadcast,
  countBroadcastRecipients,
  countUsersAfter,
  createBroadcastJob,
  getActiveBroadcast,
  getBroadcastJob,
  getUser,
  nextBroadcastRecipients,
  releaseBroadcastLock,
  setBroadcastProgress,
  setBroadcastStatus,
  setSession,
} from './db.ts';
import { detectContent } from './content.ts';
import { escapeHtml, fmtInt, truncate } from './format.ts';
import { hmacHex } from './crypto.ts';
import { isAdmin } from './env.ts';
import { kindLabel, normalizeLang, t } from './i18n.ts';
import { editOrSend, logTelegramError, safeSend, answerCallback } from './notify.ts';
import { TelegramError } from './telegram.ts';
import type { InlineKeyboardMarkup, TgMessage } from './types.ts';
import type { TgCallbackQuery } from './types.ts';

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 1000;
const CHAIN_ATTEMPTS_PER_REPORT = 5;

export async function startBroadcastPrompt(ctx: Ctx, admin: UserRow): Promise<void> {
  const lang = normalizeLang(admin.lang);
  const active = await getActiveBroadcast(ctx.db);
  if (active) {
    await safeSend(ctx, admin.id, t(lang, 'admin.broadcastAlready', { id: String(active.id) }));
    return;
  }
  await setSession(ctx.db, admin.id, 'bc', null, ctx.now);
  await safeSend(ctx, admin.id, t(lang, 'admin.broadcastPrompt'), {
    inline_keyboard: [[{ text: t(lang, 'btn.cancel'), callback_data: 'a:bc:cancel' }]],
  });
}

export async function receiveBroadcastContent(ctx: Ctx, admin: UserRow, message: TgMessage): Promise<void> {
  if (!isAdmin(ctx.env, admin.id)) return;
  const lang = normalizeLang(admin.lang);
  const content = detectContent(message);
  if (!content) {
    await safeSend(ctx, admin.id, t(lang, 'send.unsupported'));
    return;
  }

  const active = await getActiveBroadcast(ctx.db);
  if (active) {
    await clearSession(ctx.db, admin.id);
    await safeSend(ctx, admin.id, t(lang, 'admin.broadcastAlready', { id: String(active.id) }));
    return;
  }

  const jobId = await createBroadcastJob(ctx.db, {
    adminId: admin.id,
    fromChatId: message.chat.id,
    messageId: message.message_id,
    workerUrl: ctx.origin || null,
    now: ctx.now,
  });
  await clearSession(ctx.db, admin.id);

  const total = await countBroadcastRecipients(ctx.db);
  const preview = content.text ? truncate(content.text, 300) : '';
  const description = [
    content.kind !== 'text'
      ? t(lang, 'admin.broadcastContentMedia', { kind: kindLabel(lang, content.kind) })
      : '',
    preview ? t(lang, 'admin.broadcastContentText', { preview: escapeHtml(preview) }) : '',
  ]
    .filter(Boolean)
    .join('\n');

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: t(lang, 'admin.broadcastStart'), callback_data: `a:bc:go:${jobId}` },
        { text: t(lang, 'admin.broadcastCancel'), callback_data: `a:bc:del:${jobId}` },
      ],
    ],
  };

  await safeSend(
    ctx,
    admin.id,
    t(lang, 'admin.broadcastConfirm', {
      content: description || t(lang, 'admin.broadcastContentMedia', { kind: kindLabel(lang, content.kind) }),
      recipients: fmtInt(total),
    }),
    keyboard,
  );
}

function scheduleChain(ctx: Ctx, job: BroadcastRow): void {
  if (!job.worker_url) return;
  const url = `${job.worker_url.replace(/\/$/, '')}/__internal/broadcast`;
  ctx.waitUntil(
    (async () => {
      const token = await hmacHex(ctx.env.BOT_SECRET, 'internal-broadcast-v1');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'x-internal-token': token },
      });
      await response.text();
    })().catch((error) => {
      console.error('broadcast chain failed', error instanceof Error ? error.message : String(error));
    }),
  );
}

async function progressText(ctx: Ctx, job: BroadcastRow, sent: number, failed: number, adminLang: string): Promise<string> {
  const total = await countBroadcastRecipients(ctx.db);
  return t(normalizeLang(adminLang), 'admin.broadcastProgress', {
    sent: fmtInt(sent),
    total: fmtInt(total),
    failed: fmtInt(failed),
  });
}

async function finishDone(ctx: Ctx, job: BroadcastRow, sent: number, failed: number, now: number): Promise<void> {
  const changed = await completeBroadcast(ctx.db, job.id, now);
  if (!changed) return;
  const admin = await getUser(ctx.db, job.admin_id);
  const lang = normalizeLang(admin?.lang);
  const text = t(lang, 'admin.broadcastDone', { sent: fmtInt(sent), failed: fmtInt(failed) });
  if (job.progress_chat_id && job.progress_message_id) {
    await editOrSend(ctx, job.progress_chat_id, job.progress_message_id, text);
  } else {
    await safeSend(ctx, job.admin_id, text);
  }
}

/** Отправляет один батч. Сам себя перезапускает через внутренний HTTP-эндпоинт. */
export async function drainBroadcast(ctx: Ctx): Promise<void> {
  const job = await getActiveBroadcast(ctx.db);
  if (!job) return;

  const now = Math.floor(Date.now() / 1000);
  if (job.attempts >= MAX_ATTEMPTS) {
    await setBroadcastStatus(ctx.db, job.id, 'stopped', now);
    const admin = await getUser(ctx.db, job.admin_id);
    const lang = normalizeLang(admin?.lang);
    await safeSend(
      ctx,
      job.admin_id,
      t(lang, 'admin.broadcastStopped', { sent: fmtInt(job.sent), failed: fmtInt(job.failed) }),
    );
    return;
  }

  if (!(await acquireBroadcastLock(ctx.db, job.id, now))) return;

  let shouldChain = false;
  try {
    const recipients = await nextBroadcastRecipients(ctx.db, job.last_user_id, BATCH_SIZE);
    if (recipients.length === 0) {
      await finishDone(ctx, job, job.sent, job.failed, now);
      return;
    }

    let sent = job.sent;
    let failed = job.failed;
    let lastUserId = job.last_user_id;
    let rateLimited = false;

    for (const recipientId of recipients) {
      try {
        await ctx.api.copyMessage({
          chat_id: recipientId,
          from_chat_id: job.from_chat_id,
          message_id: job.message_id,
        });
        sent += 1;
        lastUserId = recipientId;
      } catch (error) {
        if (error instanceof TelegramError && error.retryAfter) {
          rateLimited = true;
          break;
        }
        failed += 1;
        lastUserId = recipientId;
        logTelegramError('broadcast copyMessage', error);
      }
    }

    const attempts = job.attempts + 1;
    await setBroadcastProgress(ctx.db, job.id, { sent, failed, lastUserId, attempts, now });

    const fresh = await getBroadcastJob(ctx.db, job.id);
    if (!fresh || fresh.status !== 'running') return;

    const remaining = await countUsersAfter(ctx.db, lastUserId);
    if (remaining === 0) {
      await finishDone(ctx, job, sent, failed, now);
      return;
    }
    if (rateLimited) return;

    if (attempts % CHAIN_ATTEMPTS_PER_REPORT === 0 && job.progress_chat_id && job.progress_message_id) {
      const admin = await getUser(ctx.db, job.admin_id);
      const text = await progressText(ctx, job, sent, failed, admin?.lang ?? 'ru');
      await editOrSend(ctx, job.progress_chat_id, job.progress_message_id, text);
    }

    shouldChain = Boolean(job.worker_url);
  } finally {
    await releaseBroadcastLock(ctx.db, job.id);
  }

  if (shouldChain) scheduleChain(ctx, job);
}

export async function stopBroadcast(ctx: Ctx, query: TgCallbackQuery, jobId: number): Promise<void> {
  const job = await getBroadcastJob(ctx.db, jobId);
  const admin = await getUser(ctx.db, query.from.id);
  const lang = normalizeLang(admin?.lang);
  if (!job) {
    await answerCallback(ctx, query.id, t(lang, 'admin.broadcastNoJob'));
    return;
  }
  if (job.status !== 'running') {
    await answerCallback(ctx, query.id, t(lang, 'admin.broadcastNoJob'));
    return;
  }
  await setBroadcastStatus(ctx.db, job.id, 'stopped', ctx.now);
  const text = t(lang, 'admin.broadcastStopped', { sent: fmtInt(job.sent), failed: fmtInt(job.failed) });
  if (job.progress_chat_id && job.progress_message_id) {
    await editOrSend(ctx, job.progress_chat_id, job.progress_message_id, text);
  } else {
    await safeSend(ctx, job.admin_id, text);
  }
  await answerCallback(ctx, query.id);
}
