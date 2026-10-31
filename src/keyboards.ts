import type { InlineKeyboardMarkup } from './types.ts';
import type { Lang } from './i18n.ts';
import { t } from './i18n.ts';
import type { UserRow } from './db.ts';

export function mainMenuKeyboard(lang: Lang): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: t(lang, 'btn.link'), callback_data: 'm:link' },
        { text: t(lang, 'btn.stats'), callback_data: 'm:stats' },
      ],
      [
        { text: t(lang, 'btn.settings'), callback_data: 'm:settings' },
        { text: t(lang, 'btn.help'), callback_data: 'm:help' },
      ],
    ],
  };
}

export function backToMenuKeyboard(lang: Lang): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: t(lang, 'btn.back'), callback_data: 'm:back' }]],
  };
}

export function linkKeyboard(lang: Lang, link: string): InlineKeyboardMarkup {
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(t(lang, 'menu.shareText'))}`;
  return {
    inline_keyboard: [
      [{ text: t(lang, 'btn.share'), url: share }],
      [{ text: t(lang, 'btn.back'), callback_data: 'm:back' }],
    ],
  };
}

export function settingsKeyboard(lang: Lang, user: UserRow): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: user.accept_messages ? t(lang, 'btn.acceptOn') : t(lang, 'btn.acceptOff'),
          callback_data: 's:accept',
        },
      ],
      [
        {
          text: user.allow_media ? t(lang, 'btn.mediaOn') : t(lang, 'btn.mediaOff'),
          callback_data: 's:media',
        },
        {
          text: user.allow_links ? t(lang, 'btn.linksOn') : t(lang, 'btn.linksOff'),
          callback_data: 's:links',
        },
      ],
      [
        {
          text: user.notify_reactions ? t(lang, 'btn.reactionsOn') : t(lang, 'btn.reactionsOff'),
          callback_data: 's:reactions',
        },
      ],
      [
        { text: t(lang, 'btn.blocks'), callback_data: 's:blocks' },
        { text: t(lang, 'btn.link'), callback_data: 'm:link' },
      ],
      [{ text: t(lang, 'btn.back'), callback_data: 'm:back' }],
    ],
  };
}

export function blocklistKeyboard(lang: Lang): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: t(lang, 'btn.clearBlocks'), callback_data: 's:clearblocks' }],
      [{ text: t(lang, 'btn.back'), callback_data: 'm:settings' }],
    ],
  };
}

export const REACTION_EMOJIS = ['👍', '❤️', '🔥', '😂', '😢'] as const;

export function anonymousMessageKeyboard(
  lang: Lang,
  messageId: number,
  strictAnon: boolean,
): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup['inline_keyboard'] = [];

  if (!strictAnon) {
    rows.push([
      { text: t(lang, 'btn.reply'), callback_data: `r:${messageId}` },
      { text: t(lang, 'btn.block'), callback_data: `b:${messageId}` },
    ]);
  } else {
    rows.push([{ text: t(lang, 'btn.block'), callback_data: `b:${messageId}` }]);
  }

  if (!strictAnon) {
    rows.push(
      REACTION_EMOJIS.map((emoji) => ({
        text: emoji,
        callback_data: `k:${messageId}:${emoji}`,
      })),
    );
  }

  rows.push([{ text: t(lang, 'btn.report'), callback_data: `rep:${messageId}` }]);
  return { inline_keyboard: rows };
}

export function continueDialogKeyboard(lang: Lang, recipientId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: t(lang, 'btn.continue'), callback_data: `cont:${recipientId}` }]],
  };
}

export function languageKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: t('ru', 'btn.langRu'), callback_data: 'lang:ru' },
        { text: t('en', 'btn.langEn'), callback_data: 'lang:en' },
      ],
    ],
  };
}

export function adminNavKeyboard(lang: Lang, newReports: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: t(lang, 'admin.btn.overview'), callback_data: 'a:ov' },
        { text: t(lang, 'admin.btn.dynamics'), callback_data: 'a:st:7' },
      ],
      [
        { text: t(lang, 'admin.btn.kinds'), callback_data: 'a:kinds' },
        { text: t(lang, 'admin.btn.top'), callback_data: 'a:top' },
      ],
      [
        { text: t(lang, 'admin.btn.reports', { n: newReports }), callback_data: 'a:reps' },
        { text: t(lang, 'admin.btn.bans'), callback_data: 'a:bans' },
      ],
      [
        { text: t(lang, 'admin.btn.broadcast'), callback_data: 'a:bc' },
        { text: t(lang, 'admin.btn.csv'), callback_data: 'a:csv' },
      ],
      [{ text: t(lang, 'admin.btn.settings'), callback_data: 'a:set' }],
      [{ text: t(lang, 'admin.btn.refresh'), callback_data: 'a:ov' }],
    ],
  };
}

export function adminBackKeyboard(lang: Lang): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: t(lang, 'admin.btn.back'), callback_data: 'a:ov' }]],
  };
}
