// Минимальные типы Telegram Bot API, которых достаточно боту.

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  username?: string;
  first_name?: string;
  title?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: unknown[];
  caption_entities?: unknown[];
  photo?: { file_id: string }[];
  video?: { file_id: string };
  animation?: { file_id: string };
  audio?: { file_id: string };
  voice?: { file_id: string };
  document?: { file_id: string };
  sticker?: { file_id: string; emoji?: string };
  video_note?: { file_id: string };
  poll?: { id: string };
  dice?: { emoji: string; value: number };
  reply_to_message?: TgMessage;
  media_group_id?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}
