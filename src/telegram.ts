import type { InlineKeyboardMarkup, TgMessage } from './types.ts';

export class TelegramError extends Error {
  readonly description: string;
  readonly code?: number;
  readonly retryAfter?: number;

  constructor(description: string, code?: number, retryAfter?: number) {
    super(description);
    this.name = 'TelegramError';
    this.description = description;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export interface SendOptions {
  parse_mode?: 'HTML';
  disable_notification?: boolean;
  reply_markup?: InlineKeyboardMarkup;
  link_preview_options?: { is_disabled?: boolean };
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== 'undefined' && value instanceof FormData;
}

/** Тонкая обёртка над Bot API. Никаких ретраев: пусть вызывающий решает. */
export class Telegram {
  private readonly base: string;

  constructor(token: string, apiBase = 'https://api.telegram.org') {
    this.base = `${apiBase.replace(/\/$/, '')}/bot${token}`;
  }

  async call<T>(method: string, params?: Record<string, unknown> | FormData): Promise<T> {
    const init: RequestInit = { method: 'POST' };
    if (isFormData(params)) {
      init.body = params;
    } else {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(params ?? {});
    }

    const response = await fetch(`${this.base}/${method}`, init);
    let payload: {
      ok?: boolean;
      result?: unknown;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new TelegramError(`HTTP ${response.status}`, response.status);
    }

    if (!payload.ok) {
      throw new TelegramError(
        payload.description ?? `Telegram API error (HTTP ${response.status})`,
        payload.error_code ?? response.status,
        payload.parameters?.retry_after,
      );
    }
    return payload.result as T;
  }

  sendMessage(chatId: number, text: string, options: SendOptions = {}): Promise<TgMessage> {
    return this.call<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...options,
    });
  }

  editMessageText(chatId: number, messageId: number, text: string, options: SendOptions = {}): Promise<TgMessage | boolean> {
    return this.call<TgMessage | boolean>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...options,
    });
  }

  editMessageReplyMarkup(chatId: number, messageId: number, markup: InlineKeyboardMarkup): Promise<TgMessage | boolean> {
    return this.call<TgMessage | boolean>('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: markup,
    });
  }

  copyMessage(params: {
    chat_id: number;
    from_chat_id: number;
    message_id: number;
    reply_markup?: InlineKeyboardMarkup;
    disable_notification?: boolean;
  }): Promise<{ message_id: number }> {
    return this.call<{ message_id: number }>('copyMessage', params);
  }

  deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.call<boolean>('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<boolean> {
    return this.call<boolean>('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  }

  sendDocument(chatId: number, filename: string, content: string, caption?: string): Promise<TgMessage> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }
    form.append('document', new Blob([content], { type: 'text/csv;charset=utf-8' }), filename);
    return this.call<TgMessage>('sendDocument', form);
  }

  getMe(): Promise<{ id: number; username?: string; first_name: string }> {
    return this.call('getMe');
  }
}

export function isIgnorableTelegramError(error: unknown): boolean {
  if (!(error instanceof TelegramError)) return false;
  return /message is not modified|message to edit not found|message can't be edited|chat not found|bot was blocked by the user|user is deactivated|not enough rights|message to delete not found|query is too old|bot was kicked|BUTTON_DATA_INVALID|message can't be deleted/i.test(
    error.description,
  );
}
