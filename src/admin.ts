import type { Ctx } from './ctx.ts';
import type { Lang } from './i18n.ts';
import type { ReportWithOwner } from './db.ts';
import {
  banSender,
  clearSession,
  countBans,
  countBroadcastRecipients,
  countNewReports,
  deleteBroadcastJob,
  getActiveBroadcast,
  getBroadcastJob,
  getLatestBroadcast,
  getReport,
  getSettings,
  getUser,
  listBans,
  listNewReports,
  purgeReplyKeys,
  revokeReplyKeysForSender,
  setBroadcastProgressTarget,
  startBroadcastJob,
  setReportStatus,
  setSetting,
  unbanSender,
} from './db.ts';
import { contentTtlDays, digestHour, isAdmin, replyTtlDays } from './env.ts';
import { buildStatsCsv, loadOverview, renderDynamics, renderKinds, renderOverview, renderTop } from './stats.ts';
import { displayName, escapeHtml, fmtInt, formatTime, isoDay, shortDay } from './format.ts';
import { kindLabel, normalizeLang, t } from './i18n.ts';
import { adminBackKeyboard, adminNavKeyboard } from './keyboards.ts';
import { answerCallback, editOrSend, logTelegramError, safeSend } from './notify.ts';
import { drainBroadcast, startBroadcastPrompt, stopBroadcast } from './broadcast.ts';
import type { InlineKeyboardMarkup, TgCallbackQuery } from './types.ts';

export type AdminView = 'ov' | 'st7' | 'st30' | 'kinds' | 'top' | 'reps' | 'bans' | 'set' | 'bc';

interface RenderedView {
  text: string;
  keyboard: InlineKeyboardMarkup;
}

function state(lang: Lang, value: boolean): string {
  return value ? t(lang, 'on') : t(lang, 'off');
}

function reportItem(lang: Lang, report: ReportWithOwner): string {
  const owner = escapeHtml(displayName(report.owner_username, report.owner_first_name));
  const date = `${shortDay(isoDay(report.created_at))} ${formatTime(report.created_at)} UTC`;
  const alias = report.sender_key.slice(0, 8);
  if (!report.content_preview) {
    return t(lang, 'admin.reportItemNoPreview', {
      id: String(report.id),
      kind: kindLabel(lang, report.kind),
      owner,
      alias,
      date,
    });
  }
  return t(lang, 'admin.reportItem', {
    id: String(report.id),
    kind: kindLabel(lang, report.kind),
    owner,
    alias,
    date,
    preview: escapeHtml(report.content_preview),
  });
}

async function renderReports(ctx: Ctx, lang: Lang, offset = 0): Promise<RenderedView> {
  const total = await countNewReports(ctx.db);
  const pages = Math.max(1, Math.ceil(total / 5));
  const page = Math.min(Math.max(0, Math.floor(offset / 5)), pages - 1);
  const actualOffset = page * 5;
  const reports = await listNewReports(ctx.db, 5, actualOffset);
  const lines = [t(lang, 'admin.reportsTitle')];

  if (!reports.length) {
    lines.push('', t(lang, 'admin.reportsEmpty'));
  } else {
    lines.push('', reports.map((report) => reportItem(lang, report)).join('\n\n'));
    if (pages > 1) {
      lines.push('', t(lang, 'admin.reportsPage', { page: String(page + 1), pages: String(pages) }));
    }
    lines.push('', t(lang, 'admin.reportHint'));
  }

  const rows: InlineKeyboardMarkup['inline_keyboard'] = reports.map((report) => [
    { text: `${t(lang, 'admin.ban')} #${report.id}`, callback_data: `a:ban:${report.id}` },
    { text: `${t(lang, 'admin.dismiss')} #${report.id}`, callback_data: `a:dis:${report.id}` },
  ]);

  if (pages > 1) {
    const pagination: InlineKeyboardMarkup['inline_keyboard'][number] = [];
    if (page > 0) pagination.push({ text: '‹', callback_data: `a:reps:${Math.max(0, actualOffset - 5)}` });
    if (page + 1 < pages) pagination.push({ text: '›', callback_data: `a:reps:${actualOffset + 5}` });
    if (pagination.length) rows.push(pagination);
  }

  rows.push([{ text: t(lang, 'admin.btn.back'), callback_data: 'a:ov' }]);

  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

async function renderBans(ctx: Ctx, lang: Lang): Promise<RenderedView> {
  const [bans, total] = await Promise.all([listBans(ctx.db, 10), countBans(ctx.db)]);
  const lines = [t(lang, 'admin.bansTitle'), '', t(lang, 'admin.bansHint')];

  if (!bans.length) {
    lines.push('', t(lang, 'admin.bansEmpty'));
  } else {
    lines.push('', t(lang, 'admin.bansTotal', { count: fmtInt(total) }), '');
    for (const ban of bans) {
      lines.push(
        t(lang, 'admin.banItem', {
          key: ban.sender_key.slice(0, 12),
          date: `${shortDay(isoDay(ban.created_at))} ${formatTime(ban.created_at)} UTC`,
        }),
      );
    }
  }

  const rows: InlineKeyboardMarkup['inline_keyboard'] = bans.map((ban) => [
    { text: `${t(lang, 'admin.unban')} ${ban.sender_key.slice(0, 6)}`, callback_data: `a:unban:${ban.sender_key}` },
  ]);
  rows.push([{ text: t(lang, 'admin.btn.back'), callback_data: 'a:ov' }]);

  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

async function renderSettings(ctx: Ctx, lang: Lang): Promise<RenderedView> {
  const settings = await getSettings(ctx.db);
  const hour = String(digestHour(ctx.env)).padStart(2, '0');
  const lines = [
    t(lang, 'admin.settingsTitle'),
    '',
    t(lang, 'admin.setMaintenance', { state: state(lang, settings.maintenance) }),
    t(lang, 'admin.setStrict', { state: state(lang, settings.strictAnon) }),
    t(lang, 'admin.setDigest', { state: state(lang, settings.digest) }),
    t(lang, 'admin.setDigestHour', { hour }),
    '',
    t(lang, 'admin.setStorage', {
      days: String(contentTtlDays(ctx.env)),
      replyDays: String(replyTtlDays(ctx.env)),
    }),
    '',
    t(lang, 'admin.setMaintenanceHint'),
  ];
  if (settings.strictAnon) lines.push('', t(lang, 'admin.setStrictHint'));

  return {
    text: lines.join('\n'),
    keyboard: {
      inline_keyboard: [
        [
          {
            text: settings.maintenance ? t(lang, 'admin.btn.maintOn') : t(lang, 'admin.btn.maintOff'),
            callback_data: 'a:t:maint',
          },
        ],
        [
          {
            text: settings.strictAnon ? t(lang, 'admin.btn.strictOn') : t(lang, 'admin.btn.strictOff'),
            callback_data: 'a:t:strict',
          },
        ],
        [
          {
            text: settings.digest ? t(lang, 'admin.btn.digestOn') : t(lang, 'admin.btn.digestOff'),
            callback_data: 'a:t:digest',
          },
        ],
        [{ text: t(lang, 'admin.btn.back'), callback_data: 'a:ov' }],
      ],
    },
  };
}

async function renderBroadcast(ctx: Ctx, lang: Lang): Promise<RenderedView> {
  const active = await getActiveBroadcast(ctx.db);
  const latest = active ?? (await getLatestBroadcast(ctx.db));
  const total = await countBroadcastRecipients(ctx.db);
  const lines = [t(lang, 'admin.broadcastTitle'), ''];

  if (active) {
    lines.push(
      t(lang, 'admin.broadcastProgress', {
        sent: fmtInt(active.sent),
        total: fmtInt(total),
        failed: fmtInt(active.failed),
      }),
    );
  } else if (latest && (latest.status === 'done' || latest.status === 'stopped')) {
    lines.push(
      t(lang, latest.status === 'done' ? 'admin.broadcastDone' : 'admin.broadcastStopped', {
        sent: fmtInt(latest.sent),
        failed: fmtInt(latest.failed),
      }),
      '',
      t(lang, 'admin.broadcastIdle', { recipients: fmtInt(total) }),
    );
  } else {
    lines.push(t(lang, 'admin.broadcastIdle', { recipients: fmtInt(total) }));
  }

  const rows: InlineKeyboardMarkup['inline_keyboard'] = [];
  if (active) {
    rows.push([
      { text: t(lang, 'admin.broadcastStop'), callback_data: `a:bc:stop:${active.id}` },
    ]);
  } else {
    rows.push([{ text: t(lang, 'admin.broadcastNew'), callback_data: 'a:bc:new' }]);
  }
  rows.push([{ text: t(lang, 'admin.btn.back'), callback_data: 'a:ov' }]);

  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

async function renderView(ctx: Ctx, view: AdminView, lang: Lang, reportOffset = 0): Promise<RenderedView> {
  const newReports = await countNewReports(ctx.db);
  const nav = adminNavKeyboard(lang, newReports);

  switch (view) {
    case 'ov': {
      const [overview, settings] = await Promise.all([loadOverview(ctx.db, ctx.now), getSettings(ctx.db)]);
      return { text: renderOverview(overview, settings, lang, ctx.now), keyboard: nav };
    }
    case 'st7':
      return { text: await renderDynamics(ctx.db, 7, lang, ctx.now), keyboard: adminBackKeyboard(lang) };
    case 'st30':
      return { text: await renderDynamics(ctx.db, 30, lang, ctx.now), keyboard: adminBackKeyboard(lang) };
    case 'kinds':
      return { text: await renderKinds(ctx.db, lang, ctx.now), keyboard: adminBackKeyboard(lang) };
    case 'top':
      return { text: await renderTop(ctx.db, lang, ctx.now), keyboard: adminBackKeyboard(lang) };
    case 'reps':
      return renderReports(ctx, lang, reportOffset);
    case 'bans':
      return renderBans(ctx, lang);
    case 'set':
      return renderSettings(ctx, lang);
    case 'bc':
      return renderBroadcast(ctx, lang);
  }
}

export async function openAdminPanel(
  ctx: Ctx,
  chatId: number,
  view: AdminView,
  lang: Lang,
  editMessageId?: number,
  reportOffset = 0,
): Promise<void> {
  const rendered = await renderView(ctx, view, lang, reportOffset);
  if (editMessageId) await editOrSend(ctx, chatId, editMessageId, rendered.text, rendered.keyboard);
  else await safeSend(ctx, chatId, rendered.text, rendered.keyboard);
}

async function handleCsv(ctx: Ctx, query: TgCallbackQuery, lang: Lang): Promise<void> {
  if (!query.message) return;
  try {
    const csv = await buildStatsCsv(ctx.db, ctx.now);
    const date = isoDay(ctx.now);
    await ctx.api.sendDocument(
      query.message.chat.id,
      `anon-stats-${date}.csv`,
      csv,
      t(lang, 'admin.csvCaption', { date: shortDay(date) }),
    );
    await answerCallback(ctx, query.id, t(lang, 'admin.csvSent'));
  } catch (error) {
    logTelegramError('sendDocument', error);
    await answerCallback(ctx, query.id, t(lang, 'admin.csvError'));
  }
}

async function toggleSetting(ctx: Ctx, key: string): Promise<void> {
  const settings = await getSettings(ctx.db);
  if (key === 'maint') {
    await setSetting(ctx.db, 'maintenance', settings.maintenance ? '0' : '1');
    return;
  }
  if (key === 'strict') {
    const next = !settings.strictAnon;
    await setSetting(ctx.db, 'strict_anon', next ? '1' : '0');
    if (next) await purgeReplyKeys(ctx.db);
    return;
  }
  if (key === 'digest') {
    await setSetting(ctx.db, 'digest', settings.digest ? '0' : '1');
  }
}

export async function handleAdminCallback(ctx: Ctx, query: TgCallbackQuery, data: string): Promise<void> {
  const adminUser = await getUser(ctx.db, query.from.id);
  const lang = normalizeLang(adminUser?.lang);

  if (!isAdmin(ctx.env, query.from.id) || !query.message) {
    await answerCallback(ctx, query.id, t(lang, 'admin.denied'));
    return;
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  if (data === 'a:ov') {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, 'ov', lang, messageId);
    return;
  }
  if (data === 'a:st:7' || data === 'a:st:30') {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, data === 'a:st:7' ? 'st7' : 'st30', lang, messageId);
    return;
  }
  if (data === 'a:kinds') {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, 'kinds', lang, messageId);
    return;
  }
  if (data === 'a:top') {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, 'top', lang, messageId);
    return;
  }
  if (data === 'a:reps') {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, 'reps', lang, messageId, 0);
    return;
  }
  if (data.startsWith('a:reps:')) {
    const offset = Number(data.slice(7));
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, 'reps', lang, messageId, Number.isFinite(offset) ? Math.max(0, offset) : 0);
    return;
  }
  if (data === 'a:bans') {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, 'bans', lang, messageId);
    return;
  }
  if (data === 'a:set') {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, 'set', lang, messageId);
    return;
  }
  if (data === 'a:bc') {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, 'bc', lang, messageId);
    return;
  }
  if (data === 'a:csv') {
    await handleCsv(ctx, query, lang);
    return;
  }

  if (data.startsWith('a:t:')) {
    await toggleSetting(ctx, data.slice(4));
    await answerCallback(ctx, query.id, t(lang, 'admin.answer.saved'));
    await openAdminPanel(ctx, chatId, 'set', lang, messageId);
    return;
  }

  if (data.startsWith('a:ban:')) {
    const report = await getReport(ctx.db, Number(data.slice(6)));
    if (!report || report.status !== 'new') {
      await answerCallback(ctx, query.id, t(lang, 'admin.reportGone'));
      await openAdminPanel(ctx, chatId, 'reps', lang, messageId);
      return;
    }
    await banSender(ctx.db, report.sender_key, `report:${report.id}`, ctx.now);
    await revokeReplyKeysForSender(ctx.db, report.sender_key);
    await setReportStatus(ctx.db, report.id, 'banned', ctx.now);
    await answerCallback(ctx, query.id, t(lang, 'admin.reportBanned', { id: String(report.id) }));
    await openAdminPanel(ctx, chatId, 'reps', lang, messageId);
    return;
  }

  if (data.startsWith('a:dis:')) {
    const report = await getReport(ctx.db, Number(data.slice(6)));
    if (!report || report.status !== 'new') {
      await answerCallback(ctx, query.id, t(lang, 'admin.reportGone'));
      await openAdminPanel(ctx, chatId, 'reps', lang, messageId);
      return;
    }
    await setReportStatus(ctx.db, report.id, 'dismissed', ctx.now);
    await answerCallback(ctx, query.id, t(lang, 'admin.reportDismissed', { id: String(report.id) }));
    await openAdminPanel(ctx, chatId, 'reps', lang, messageId);
    return;
  }

  if (data.startsWith('a:unban:')) {
    await unbanSender(ctx.db, data.slice(8));
    await answerCallback(ctx, query.id, t(lang, 'admin.unbanDone'));
    await openAdminPanel(ctx, chatId, 'bans', lang, messageId);
    return;
  }

  if (data === 'a:bc:new') {
    if (!adminUser) {
      await answerCallback(ctx, query.id, t(lang, 'admin.denied'));
      return;
    }
    await answerCallback(ctx, query.id);
    await startBroadcastPrompt(ctx, adminUser);
    return;
  }

  if (data === 'a:bc:cancel') {
    await clearSession(ctx.db, query.from.id);
    await answerCallback(ctx, query.id, t(lang, 'menu.cancelled'));
    await openAdminPanel(ctx, chatId, 'bc', lang, messageId);
    return;
  }

  if (data.startsWith('a:bc:go:')) {
    const job = await getBroadcastJob(ctx.db, Number(data.slice(8)));
    if (!job || job.status !== 'draft') {
      await answerCallback(ctx, query.id, t(lang, 'admin.broadcastNoJob'));
      await openAdminPanel(ctx, chatId, 'bc', lang, messageId);
      return;
    }
    const active = await getActiveBroadcast(ctx.db);
    if (active) {
      await answerCallback(ctx, query.id, t(lang, 'admin.broadcastAlready', { id: String(active.id) }));
      return;
    }
    const total = await countBroadcastRecipients(ctx.db);
    const started = await startBroadcastJob(ctx.db, job.id, ctx.now);
    if (!started) {
      const running = await getActiveBroadcast(ctx.db);
      await answerCallback(
        ctx,
        query.id,
        running
          ? t(lang, 'admin.broadcastAlready', { id: String(running.id) })
          : t(lang, 'admin.broadcastNoJob'),
      );
      await openAdminPanel(ctx, chatId, 'bc', lang, messageId);
      return;
    }
    await setBroadcastProgressTarget(ctx.db, job.id, chatId, messageId, ctx.now);
    await editOrSend(
      ctx,
      chatId,
      messageId,
      t(lang, 'admin.broadcastStarted', { sent: '0', total: fmtInt(total) }),
    );
    await answerCallback(ctx, query.id);
    ctx.waitUntil(
      drainBroadcast(ctx).catch((error) => {
        console.error('broadcast start failed', error instanceof Error ? error.message : String(error));
      }),
    );
    return;
  }

  if (data.startsWith('a:bc:del:')) {
    await deleteBroadcastJob(ctx.db, Number(data.slice(9)));
    await answerCallback(ctx, query.id, t(lang, 'menu.cancelled'));
    await openAdminPanel(ctx, chatId, 'bc', lang, messageId);
    return;
  }

  if (data.startsWith('a:bc:stop:')) {
    await stopBroadcast(ctx, query, Number(data.slice(10)));
    return;
  }

  await answerCallback(ctx, query.id);
}
