import type { Ctx } from './ctx.ts';
import type { InlineKeyboardMarkup } from './types.ts';
import { parseAdminIds } from './env.ts';
import { isIgnorableTelegramError, TelegramError } from './telegram.ts';

export function logTelegramError(method: string, error: unknown): void {
  if (error instanceof TelegramError) {
    if (isIgnorableTelegramError(error)) return;
    console.error(`${method}: ${error.description}`);
    return;
  }
  console.error(`${method}:`, error instanceof Error ? error.message : String(error));
}

export async function safeSend(
  ctx: Ctx,
  chatId: number,
  text: string,
  keyboard?: InlineKeyboardMarkup,
): Promise<boolean> {
  try {
    await ctx.api.sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : {});
    return true;
  } catch (error) {
    logTelegramError('sendMessage', error);
    return false;
  }
}

export async function answerCallback(ctx: Ctx, callbackId: string, text?: string): Promise<void> {
  try {
    await ctx.api.answerCallbackQuery(callbackId, text);
  } catch (error) {
    logTelegramError('answerCallbackQuery', error);
  }
}

export async function editOrSend(
  ctx: Ctx,
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboardMarkup,
): Promise<void> {
  try {
    await ctx.api.editMessageText(chatId, messageId, text, keyboard ? { reply_markup: keyboard } : {});
    return;
  } catch (error) {
    if (error instanceof TelegramError && /message is not modified/i.test(error.description)) return;
    logTelegramError('editMessageText', error);
  }
  await safeSend(ctx, chatId, text, keyboard);
}

export async function notifyAdmins(
  ctx: Ctx,
  text: string,
  keyboard?: InlineKeyboardMarkup,
): Promise<void> {
  for (const adminId of parseAdminIds(ctx.env)) {
    await safeSend(ctx, adminId, text, keyboard);
  }
}
