import type { TgMessage } from './types.ts';
import { truncate } from './format.ts';

export type ContentKind =
  | 'text'
  | 'photo'
  | 'video'
  | 'animation'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'video_note'
  | 'poll';

export interface Content {
  kind: ContentKind;
  /** Текст или подпись к медиа. Может быть пустым. */
  text: string;
  /** Есть ли в тексте ссылка (для фильтра ящика). */
  hasLink: boolean;
}

const LINK_RE = /(https?:\/\/|t\.me\/|www\.|tg:\/\/)/i;

/** Поддерживаемые типы сообщений. Всё остальное бот вежливо отклоняет. */
export function detectContent(message: TgMessage): Content | null {
  let kind: ContentKind | null = null;

  if (message.text !== undefined) kind = 'text';
  else if (message.photo && message.photo.length > 0) kind = 'photo';
  else if (message.video) kind = 'video';
  else if (message.animation) kind = 'animation';
  else if (message.audio) kind = 'audio';
  else if (message.voice) kind = 'voice';
  else if (message.document) kind = 'document';
  else if (message.sticker) kind = 'sticker';
  else if (message.video_note) kind = 'video_note';
  else if (message.poll) kind = 'poll';

  if (!kind) return null;

  const text = (message.text ?? message.caption ?? '').trim();
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])] as Array<{ type?: string }>;
  const hasEntityLink = entities.some((entity) => entity.type === 'url' || entity.type === 'text_link');
  return { kind, text, hasLink: LINK_RE.test(text) || hasEntityLink };
}

/** Короткое превью для статистики и жалоб. Без медиа. */
export function contentPreview(content: Content): string {
  if (content.text) return truncate(content.text, 300);
  return `[${content.kind}]`;
}
