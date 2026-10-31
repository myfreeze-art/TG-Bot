import type { Ctx } from './ctx.ts';
import type { TgCallbackQuery, TgMessage } from './types.ts';
import type { Lang } from './i18n.ts';
import type { UserRow } from './db.ts';
import {
  attachDeliveredMessage,
  blockSender,
  clearBlocks,
  clearSession,
  consumeRate,
  countBlocks,
  countRecentDuplicates,
  countUserMessages,
  countUserReplies,
  createReport,
  deleteMessageRow,
  deleteReplyKey,
  freshTargetId,
  getMessage,
  getMessageByDeliveredId,
  getReplyKey,
  getSession,
  getSettings,
  getUser,
  getUserByToken,
  insertMessage,
  insertReplyKey,
  isSenderBanned,
  isSenderBlocked,
  markMessageReplied,
  recordReaction,
  revokeReplyKeysForSenderInInbox,
  setSession,
  setTarget,
  setUserFlag,
  touchUser,
} from './db.ts';
import { contentTtlDays, getLimits, isAdmin, parseAdminIds, replyTtlDays } from './env.ts';
import { contentPreview, detectContent } from './content.ts';
import { decryptSenderRef, encryptSenderRef, senderKey, sha256Hex } from './crypto.ts';
import { displayName, escapeHtml, fmtInt } from './format.ts';
import { normalizeLang, t } from './i18n.ts';
import { getBotUsername, inboxLink } from './ctx.ts';
import {
  REACTION_EMOJIS,
  anonymousMessageKeyboard,
  backToMenuKeyboard,
  blocklistKeyboard,
  continueDialogKeyboard,
  languageKeyboard,
  linkKeyboard,
  mainMenuKeyboard,
  settingsKeyboard,
} from './keyboards.ts';
import { answerCallback, editOrSend, logTelegramError, safeSend } from './notify.ts';
import { handleAdminCallback, openAdminPanel } from './admin.ts';
import { receiveBroadcastContent } from './broadcast.ts';
import type { InlineKeyboardMarkup } from './types.ts';

interface Command {
  name: string;
  args: string;
}

function parseCommand(text: string): Command | null {
  const match = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

function langOf(user: UserRow): Lang {
  return normalizeLang(user.lang);
}

async function linkFor(ctx: Ctx, user: UserRow): Promise<string> {
  const username = await getBotUsername(ctx);
  return inboxLink(username, user.inbox_token);
}

function settingsText(lang: Lang, user: UserRow): string {
  return t(lang, 'menu.settings', {
    accept: user.accept_messages ? t(lang, 'on') : t(lang, 'off'),
    media: user.allow_media ? t(lang, 'on') : t(lang, 'off'),
    links: user.allow_links ? t(lang, 'on') : t(lang, 'off'),
    reactions: user.notify_reactions ? t(lang, 'on') : t(lang, 'off'),
  });
}

async function sendMainMenu(ctx: Ctx, chatId: number, user: UserRow, editMessageId?: number): Promise<void> {
  const lang = langOf(user);
  const link = await linkFor(ctx, user);
  const name = escapeHtml(user.first_name ?? '—');
  const text = t(lang, 'menu.title', { name, link: escapeHtml(link) });
  const keyboard = mainMenuKeyboard(lang);
  if (editMessageId) await editOrSend(ctx, chatId, editMessageId, text, keyboard);
  else await safeSend(ctx, chatId, text, keyboard);
}

async function sendStats(ctx: Ctx, chatId: number, user: UserRow, editMessageId?: number): Promise<void> {
  const lang = langOf(user);
  const weekAgo = ctx.now - 7 * 86400;
  const [total, week, replies, blocked] = await Promise.all([
    countUserMessages(ctx.db, user.id),
    countUserMessages(ctx.db, user.id, weekAgo),
    countUserReplies(ctx.db, user.id),
    countBlocks(ctx.db, user.id),
  ]);
  const text = t(lang, 'menu.stats', {
    total: fmtInt(total),
    week: fmtInt(week),
    replies: fmtInt(replies),
    blocked: fmtInt(blocked),
    status: user.accept_messages ? t(lang, 'menu.statusOn') : t(lang, 'menu.statusOff'),
  });
  if (editMessageId) await editOrSend(ctx, chatId, editMessageId, text, backToMenuKeyboard(lang));
  else await safeSend(ctx, chatId, text, backToMenuKeyboard(lang));
}

async function sendSettings(
  ctx: Ctx,
  chatId: number,
  user: UserRow,
  editMessageId?: number,
): Promise<void> {
  const lang = langOf(user);
  const text = settingsText(lang, user);
  const keyboard = settingsKeyboard(lang, user);
  if (editMessageId) await editOrSend(ctx, chatId, editMessageId, text, keyboard);
  else await safeSend(ctx, chatId, text, keyboard);
}

async function sendBlocklist(
  ctx: Ctx,
  chatId: number,
  user: UserRow,
  editMessageId?: number,
): Promise<void> {
  const lang = langOf(user);
  const count = await countBlocks(ctx.db, user.id);
  const text = t(lang, 'menu.blocks', { count: fmtInt(count) });
  const keyboard = blocklistKeyboard(lang);
  if (editMessageId) await editOrSend(ctx, chatId, editMessageId, text, keyboard);
  else await safeSend(ctx, chatId, text, keyboard);
}

async function handleCommand(ctx: Ctx, user: UserRow, command: string, args: string, admin: boolean): Promise<void> {
  const lang = langOf(user);

  switch (command) {
    case 'start': {
      await clearSession(ctx.db, user.id);
      if (args.startsWith('u_')) {
        const recipient = await getUserByToken(ctx.db, args.slice(2));
        if (!recipient) {
          await setTarget(ctx.db, user.id, null, ctx.now);
          await safeSend(ctx, user.id, t(lang, 'send.badLink'));
          return;
        }
        if (recipient.id === user.id) {
          await setTarget(ctx.db, user.id, null, ctx.now);
          await safeSend(ctx, user.id, t(lang, 'send.ownLink'));
          return;
        }
        await setTarget(ctx.db, user.id, recipient.id, ctx.now);
        const name = escapeHtml(displayName(recipient.username, recipient.first_name));
        await safeSend(ctx, user.id, t(lang, 'send.inboxIntro', { name }), mainMenuKeyboard(lang));
        return;
      }
      await setTarget(ctx.db, user.id, null, ctx.now);
      await sendMainMenu(ctx, user.id, user);
      return;
    }

    case 'link': {
      const link = await linkFor(ctx, user);
      await safeSend(ctx, user.id, t(lang, 'menu.link', { link: escapeHtml(link) }), linkKeyboard(lang, link));
      return;
    }

    case 'stats':
      await sendStats(ctx, user.id, user);
      return;

    case 'settings':
      await sendSettings(ctx, user.id, user);
      return;

    case 'pause':
      await setUserFlag(ctx.db, user.id, 'accept_messages', 0);
      await safeSend(ctx, user.id, t(lang, 'send.paused'));
      return;

    case 'resume':
      await setUserFlag(ctx.db, user.id, 'accept_messages', 1);
      await safeSend(ctx, user.id, t(lang, 'send.resumed'));
      return;

    case 'lang':
      await safeSend(ctx, user.id, '🌍 <b>Русский / English</b>', languageKeyboard());
      return;

    case 'help':
      await safeSend(ctx, user.id, t(lang, 'menu.help'), backToMenuKeyboard(lang));
      return;

    case 'privacy':
      await safeSend(
        ctx,
        user.id,
        t(lang, 'menu.privacy', {
          days: String(contentTtlDays(ctx.env)),
          replyDays: String(replyTtlDays(ctx.env)),
        }),
        backToMenuKeyboard(lang),
      );
      return;

    case 'cancel':
      await clearSession(ctx.db, user.id);
      await setTarget(ctx.db, user.id, null, ctx.now);
      await safeSend(ctx, user.id, t(lang, 'menu.cancelled'), mainMenuKeyboard(lang));
      return;

    case 'admin':
      if (!admin) {
        await safeSend(ctx, user.id, t(lang, 'admin.denied'));
        return;
      }
      await openAdminPanel(ctx, user.id, 'ov', lang);
      return;

    case 'broadcast':
      if (!admin) {
        await safeSend(ctx, user.id, t(lang, 'admin.denied'));
        return;
      }
      await openAdminPanel(ctx, user.id, 'bc', lang);
      return;

    default:
      await safeSend(ctx, user.id, t(lang, 'menu.unknownCommand'), mainMenuKeyboard(lang));
  }
}

export async function onMessage(ctx: Ctx, message: TgMessage): Promise<void> {
  const from = message.from;
  if (!from || from.is_bot) return;
  if (message.chat.type !== 'private') return;

  const user = await touchUser(ctx.db, from, ctx.now);
  const lang = langOf(user);
  const admin = isAdmin(ctx.env, from.id);
  const settings = await getSettings(ctx.db);

  if (settings.maintenance && !admin) {
    await safeSend(ctx, user.id, t(lang, 'menu.maintenance'));
    return;
  }

  if (message.text && message.text.startsWith('/')) {
    const command = parseCommand(message.text);
    if (command) {
      await handleCommand(ctx, user, command.name, command.args, admin);
      return;
    }
  }

  const session = await getSession(ctx.db, user.id);
  if (session?.state === 'await_reply') {
    await handleReply(ctx, user, message, Number(session.data));
    return;
  }
  if (session?.state === 'bc' && admin) {
    await receiveBroadcastContent(ctx, user, message);
    return;
  }

  if (message.reply_to_message) {
    const original = await getMessageByDeliveredId(ctx.db, user.id, message.reply_to_message.message_id);
    if (original) {
      await handleReply(ctx, user, message, original.id);
      return;
    }
  }

  const targetId = freshTargetId(user, ctx.now);
  if (!targetId) {
    if (user.target_id) await setTarget(ctx.db, user.id, null, ctx.now);
    await safeSend(ctx, user.id, t(lang, 'send.noTarget'), mainMenuKeyboard(lang));
    return;
  }

  await sendAnonymous(ctx, user, message, targetId, settings.strictAnon);
}

async function sendAnonymous(
  ctx: Ctx,
  user: UserRow,
  message: TgMessage,
  recipientId: number,
  strictAnon: boolean,
): Promise<void> {
  const lang = langOf(user);
  const content = detectContent(message);
  if (!content) {
    await safeSend(ctx, user.id, t(lang, 'send.unsupported'));
    return;
  }
  if (content.kind === 'text' && !content.text) {
    await safeSend(ctx, user.id, t(lang, 'send.empty'));
    return;
  }

  const recipient = await getUser(ctx.db, recipientId);
  if (!recipient) {
    await setTarget(ctx.db, user.id, null, ctx.now);
    await safeSend(ctx, user.id, t(lang, 'send.targetGone'));
    return;
  }
  if (recipient.id === user.id) {
    await setTarget(ctx.db, user.id, null, ctx.now);
    await safeSend(ctx, user.id, t(lang, 'send.self'));
    return;
  }
  if (user.is_blocked) {
    await safeSend(ctx, user.id, t(lang, 'send.banned'));
    return;
  }
  if (!recipient.accept_messages || recipient.is_blocked) {
    await safeSend(ctx, user.id, t(lang, 'send.closed'));
    return;
  }

  const key = await senderKey(ctx.env.BOT_SECRET, user.id);
  if (await isSenderBanned(ctx.db, key, ctx.now)) {
    await safeSend(ctx, user.id, t(lang, 'send.banned'));
    return;
  }
  if (await isSenderBlocked(ctx.db, recipient.id, key)) {
    await safeSend(ctx, user.id, t(lang, 'send.blocked'));
    return;
  }

  if (content.kind !== 'text' && !recipient.allow_media) {
    await safeSend(ctx, user.id, t(lang, 'send.mediaOff'));
    return;
  }
  if (content.hasLink && !recipient.allow_links) {
    await safeSend(ctx, user.id, t(lang, 'send.linksOff'));
    return;
  }

  const maxLength = content.kind === 'text' ? 4096 : 1024;
  if (content.text.length > maxLength) {
    await safeSend(ctx, user.id, t(lang, 'send.tooLong', { max: fmtInt(maxLength) }));
    return;
  }

  const rate = await consumeRate(ctx.db, key, ctx.now, getLimits(ctx.env));
  if (!rate.allowed) {
    await safeSend(ctx, user.id, t(lang, 'send.rate', { sec: String(Math.max(1, rate.retryAfter)) }));
    return;
  }

  const normalized = content.text.trim().toLowerCase();
  const contentHash = normalized ? await sha256Hex(normalized) : null;
  if (contentHash) {
    const duplicates = await countRecentDuplicates(ctx.db, recipient.id, contentHash, ctx.now - 600);
    if (duplicates >= 2) {
      await safeSend(ctx, user.id, t(lang, 'send.duplicate'));
      return;
    }
  }

  const messageId = await insertMessage(ctx.db, {
    recipientId: recipient.id,
    senderKey: key,
    kind: content.kind,
    preview: contentPreview(content),
    contentHash,
    hasLink: content.hasLink,
    now: ctx.now,
  });

  const encryptedRef = strictAnon ? null : await encryptSenderRef(ctx.env.BOT_SECRET, user.id);
  if (encryptedRef) {
    await insertReplyKey(ctx.db, messageId, encryptedRef, ctx.now, replyTtlDays(ctx.env));
  }

  try {
    const delivered = await ctx.api.copyMessage({
      chat_id: recipient.id,
      from_chat_id: user.id,
      message_id: message.message_id,
      reply_markup: anonymousMessageKeyboard(normalizeLang(recipient.lang), messageId, strictAnon),
    });
    await attachDeliveredMessage(ctx.db, messageId, delivered.message_id);

    const name = escapeHtml(displayName(recipient.username, recipient.first_name));
    await safeSend(ctx, user.id, t(lang, 'send.sentNamed', { name }));
  } catch (error) {
    logTelegramError('copyMessage', error);
    await deleteMessageRow(ctx.db, messageId);
    await deleteReplyKey(ctx.db, messageId);
    await safeSend(ctx, user.id, t(lang, 'send.failed'));
  }
}

async function handleReply(ctx: Ctx, user: UserRow, message: TgMessage, messageId: number): Promise<void> {
  const lang = langOf(user);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    await clearSession(ctx.db, user.id);
    await safeSend(ctx, user.id, t(lang, 'send.replyExpired'));
    return;
  }
  const original = await getMessage(ctx.db, messageId);
  if (!original || original.recipient_id !== user.id) {
    await clearSession(ctx.db, user.id);
    await safeSend(ctx, user.id, t(lang, 'send.replyExpired'));
    return;
  }

  const replyKey = await getReplyKey(ctx.db, messageId);
  if (!replyKey || replyKey.expires_at <= ctx.now) {
    await clearSession(ctx.db, user.id);
    await safeSend(ctx, user.id, t(lang, 'send.replyExpired'));
    return;
  }

  const content = detectContent(message);
  if (!content) {
    await safeSend(ctx, user.id, t(lang, 'send.unsupported'));
    return;
  }
  if (content.kind === 'text' && !content.text) {
    await safeSend(ctx, user.id, t(lang, 'send.empty'));
    return;
  }

  let senderId: number;
  try {
    senderId = await decryptSenderRef(ctx.env.BOT_SECRET, replyKey.ref);
  } catch {
    await clearSession(ctx.db, user.id);
    await safeSend(ctx, user.id, t(lang, 'send.replyExpired'));
    return;
  }

  const sender = await getUser(ctx.db, senderId);
  const senderLang = normalizeLang(sender?.lang);
  const header = t(senderLang, 'send.replyHeader');

  try {
    if (content.kind === 'text') {
      await ctx.api.sendMessage(senderId, `${header}\n\n${escapeHtml(content.text)}`, {
        reply_markup: continueDialogKeyboard(senderLang, user.id),
      });
    } else {
      await ctx.api.sendMessage(senderId, header, {
        reply_markup: continueDialogKeyboard(senderLang, user.id),
      });
      await ctx.api.copyMessage({
        chat_id: senderId,
        from_chat_id: user.id,
        message_id: message.message_id,
      });
    }

    await deleteReplyKey(ctx.db, messageId);
    await markMessageReplied(ctx.db, messageId, ctx.now);
    await clearSession(ctx.db, user.id);
    await safeSend(ctx, user.id, t(lang, 'send.replySent'));
  } catch (error) {
    logTelegramError('reply delivery', error);
    await safeSend(ctx, user.id, t(lang, 'send.replyFailed'));
  }
}

async function handleBlock(ctx: Ctx, query: TgCallbackQuery, user: UserRow, messageId: number): Promise<void> {
  const lang = langOf(user);
  const original = await getMessage(ctx.db, messageId);
  if (!original || original.recipient_id !== user.id) {
    await answerCallback(ctx, query.id, t(lang, 'send.replyExpired'));
    return;
  }
  await blockSender(ctx.db, user.id, original.sender_key, ctx.now);
  await revokeReplyKeysForSenderInInbox(ctx.db, user.id, original.sender_key);
  await answerCallback(ctx, query.id, t(lang, 'send.blockedUser'));
}

async function handleReport(ctx: Ctx, query: TgCallbackQuery, user: UserRow, messageId: number): Promise<void> {
  const lang = langOf(user);
  const original = await getMessage(ctx.db, messageId);
  if (!original || original.recipient_id !== user.id) {
    await answerCallback(ctx, query.id, t(lang, 'send.replyExpired'));
    return;
  }

  const preview = original.content_preview ?? `[${original.kind}]`;
  const reportId = await createReport(ctx.db, {
    messageId: original.id,
    recipientId: user.id,
    senderKey: original.sender_key,
    kind: original.kind,
    preview,
    now: ctx.now,
  });

  if (!reportId) {
    await answerCallback(ctx, query.id, t(lang, 'send.reportAlready'));
    return;
  }

  await blockSender(ctx.db, user.id, original.sender_key, ctx.now);
  await revokeReplyKeysForSenderInInbox(ctx.db, user.id, original.sender_key);
  await answerCallback(ctx, query.id, t(lang, 'send.reportSent'));

  for (const adminId of parseAdminIds(ctx.env)) {
    const adminUser = await getUser(ctx.db, adminId);
    const adminLang = normalizeLang(adminUser?.lang);
    const text = t(adminLang, 'admin.newReport', {
      id: String(reportId),
      owner: escapeHtml(displayName(user.username, user.first_name)),
      kind: t(adminLang, `kind.${original.kind}`),
      alias: original.sender_key.slice(0, 8),
      preview: escapeHtml(preview),
    });
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: t(adminLang, 'admin.ban'), callback_data: `a:ban:${reportId}` },
          { text: t(adminLang, 'admin.dismiss'), callback_data: `a:dis:${reportId}` },
        ],
      ],
    };
    await safeSend(ctx, adminId, text, keyboard);
  }
}

async function handleReaction(
  ctx: Ctx,
  query: TgCallbackQuery,
  user: UserRow,
  messageId: number,
  emoji: string,
  strictAnon: boolean,
): Promise<void> {
  const lang = langOf(user);
  if (strictAnon) {
    await answerCallback(ctx, query.id, t(lang, 'send.noRepliesStrict'));
    return;
  }
  if (!(REACTION_EMOJIS as readonly string[]).includes(emoji)) {
    await answerCallback(ctx, query.id);
    return;
  }

  const original = await getMessage(ctx.db, messageId);
  if (!original || original.recipient_id !== user.id) {
    await answerCallback(ctx, query.id, t(lang, 'send.replyExpired'));
    return;
  }

  const replyKey = await getReplyKey(ctx.db, messageId);
  if (!replyKey || replyKey.expires_at <= ctx.now) {
    await answerCallback(ctx, query.id, t(lang, 'send.replyExpired'));
    return;
  }

  const isNew = await recordReaction(ctx.db, messageId, emoji, ctx.now);
  if (!isNew) {
    await answerCallback(ctx, query.id, t(lang, 'send.reactionAlready'));
    return;
  }

  let senderId: number;
  try {
    senderId = await decryptSenderRef(ctx.env.BOT_SECRET, replyKey.ref);
  } catch {
    await answerCallback(ctx, query.id, t(lang, 'send.replyExpired'));
    return;
  }

  const sender = await getUser(ctx.db, senderId);
  if (sender?.notify_reactions) {
    await safeSend(ctx, senderId, t(normalizeLang(sender.lang), 'send.reactionNotify', { emoji }));
  }
  await answerCallback(ctx, query.id, t(lang, 'send.reactionSent'));
}

async function handleContinue(ctx: Ctx, query: TgCallbackQuery, user: UserRow, recipientId: number): Promise<void> {
  const lang = langOf(user);
  const recipient = await getUser(ctx.db, recipientId);
  if (!recipient) {
    await answerCallback(ctx, query.id, t(lang, 'send.targetGone'));
    return;
  }
  if (recipient.id === user.id) {
    await answerCallback(ctx, query.id, t(lang, 'send.self'));
    return;
  }
  await setTarget(ctx.db, user.id, recipient.id, ctx.now);
  await answerCallback(
    ctx,
    query.id,
    t(lang, 'send.continueSet', {
      name: displayName(recipient.username, recipient.first_name),
    }),
  );
}

export async function handleUserCallback(
  ctx: Ctx,
  query: TgCallbackQuery,
  user: UserRow,
  data: string,
  strictAnon: boolean,
): Promise<void> {
  const message = query.message;
  if (!message) {
    await answerCallback(ctx, query.id);
    return;
  }
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const lang = langOf(user);

  if (data === 'm:back') {
    await answerCallback(ctx, query.id);
    await sendMainMenu(ctx, chatId, user, messageId);
    return;
  }

  if (data === 'r:cancel') {
    await clearSession(ctx.db, user.id);
    await answerCallback(ctx, query.id, t(lang, 'menu.cancelled'));
    await sendMainMenu(ctx, chatId, user, messageId);
    return;
  }

  if (data === 'm:link') {
    const link = await linkFor(ctx, user);
    await answerCallback(ctx, query.id);
    await editOrSend(
      ctx,
      chatId,
      messageId,
      t(lang, 'menu.link', { link: escapeHtml(link) }),
      linkKeyboard(lang, link),
    );
    return;
  }

  if (data === 'm:stats') {
    await answerCallback(ctx, query.id);
    await sendStats(ctx, chatId, user, messageId);
    return;
  }

  if (data === 'm:settings') {
    await answerCallback(ctx, query.id);
    await sendSettings(ctx, chatId, user, messageId);
    return;
  }

  if (data === 'm:help') {
    await answerCallback(ctx, query.id);
    await editOrSend(ctx, chatId, messageId, t(lang, 'menu.help'), backToMenuKeyboard(lang));
    return;
  }

  if (data === 'm:privacy') {
    await answerCallback(ctx, query.id);
    await editOrSend(
      ctx,
      chatId,
      messageId,
      t(lang, 'menu.privacy', {
        days: String(contentTtlDays(ctx.env)),
        replyDays: String(replyTtlDays(ctx.env)),
      }),
      backToMenuKeyboard(lang),
    );
    return;
  }

  if (data.startsWith('lang:')) {
    const nextLang = data.slice(5) === 'en' ? 'en' : 'ru';
    await setUserFlag(ctx.db, user.id, 'lang', nextLang);
    const updated: UserRow = { ...user, lang: nextLang };
    await answerCallback(ctx, query.id, t(nextLang, 'send.langChanged'));
    await sendMainMenu(ctx, chatId, updated, messageId);
    return;
  }

  if (data.startsWith('s:')) {
    const action = data.slice(2);
    if (action === 'accept') {
      const next = user.accept_messages ? 0 : 1;
      await setUserFlag(ctx.db, user.id, 'accept_messages', next);
      user = { ...user, accept_messages: next };
      await answerCallback(ctx, query.id, next ? t(lang, 'on') : t(lang, 'off'));
      await sendSettings(ctx, chatId, user, messageId);
      return;
    }
    if (action === 'media') {
      const next = user.allow_media ? 0 : 1;
      await setUserFlag(ctx.db, user.id, 'allow_media', next);
      user = { ...user, allow_media: next };
      await answerCallback(ctx, query.id, next ? t(lang, 'on') : t(lang, 'off'));
      await sendSettings(ctx, chatId, user, messageId);
      return;
    }
    if (action === 'links') {
      const next = user.allow_links ? 0 : 1;
      await setUserFlag(ctx.db, user.id, 'allow_links', next);
      user = { ...user, allow_links: next };
      await answerCallback(ctx, query.id, next ? t(lang, 'on') : t(lang, 'off'));
      await sendSettings(ctx, chatId, user, messageId);
      return;
    }
    if (action === 'reactions') {
      const next = user.notify_reactions ? 0 : 1;
      await setUserFlag(ctx.db, user.id, 'notify_reactions', next);
      user = { ...user, notify_reactions: next };
      await answerCallback(ctx, query.id, next ? t(lang, 'on') : t(lang, 'off'));
      await sendSettings(ctx, chatId, user, messageId);
      return;
    }
    if (action === 'blocks') {
      await answerCallback(ctx, query.id);
      await sendBlocklist(ctx, chatId, user, messageId);
      return;
    }
    if (action === 'clearblocks') {
      await clearBlocks(ctx.db, user.id);
      await answerCallback(ctx, query.id, t(lang, 'send.unblockedAll'));
      await sendBlocklist(ctx, chatId, user, messageId);
      return;
    }
    await answerCallback(ctx, query.id);
    return;
  }

  if (data.startsWith('r:')) {
    const originalId = Number(data.slice(2));
    const original = await getMessage(ctx.db, originalId);
    if (!original || original.recipient_id !== user.id) {
      await answerCallback(ctx, query.id, t(lang, 'send.replyExpired'));
      return;
    }
    if (strictAnon) {
      await answerCallback(ctx, query.id, t(lang, 'send.noRepliesStrict'));
      return;
    }
    const replyKey = await getReplyKey(ctx.db, originalId);
    if (!replyKey || replyKey.expires_at <= ctx.now) {
      await answerCallback(ctx, query.id, t(lang, 'send.replyExpired'));
      return;
    }
    await setSession(ctx.db, user.id, 'await_reply', String(originalId), ctx.now);
    await answerCallback(ctx, query.id);
    await safeSend(ctx, chatId, t(lang, 'send.replyPrompt', { id: String(originalId) }), {
      inline_keyboard: [[{ text: t(lang, 'btn.cancel'), callback_data: 'r:cancel' }]],
    });
    return;
  }

  if (data.startsWith('b:')) {
    await handleBlock(ctx, query, user, Number(data.slice(2)));
    return;
  }

  if (data.startsWith('rep:')) {
    await handleReport(ctx, query, user, Number(data.slice(3)));
    return;
  }

  if (data.startsWith('k:')) {
    const [, rawId, emoji] = data.split(':');
    await handleReaction(ctx, query, user, Number(rawId), emoji ?? '', strictAnon);
    return;
  }

  if (data.startsWith('cont:')) {
    await handleContinue(ctx, query, user, Number(data.slice(5)));
    return;
  }

  await answerCallback(ctx, query.id);
}

export async function onCallback(ctx: Ctx, query: TgCallbackQuery): Promise<void> {
  const data = query.data ?? '';
  if (!query.message) {
    await answerCallback(ctx, query.id);
    return;
  }

  const user = await touchUser(ctx.db, query.from, ctx.now);
  const admin = isAdmin(ctx.env, query.from.id);
  const settings = await getSettings(ctx.db);
  const lang = langOf(user);

  if (settings.maintenance && !admin) {
    await answerCallback(ctx, query.id, t(lang, 'menu.maintenance'));
    return;
  }

  if (data.startsWith('a:')) {
    await handleAdminCallback(ctx, query, data);
    return;
  }

  await handleUserCallback(ctx, query, user, data, settings.strictAnon);
}
