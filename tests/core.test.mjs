import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decryptSenderRef,
  encryptSenderRef,
  fromBase64Url,
  hmacHex,
  senderKey,
  sha256Hex,
  timingSafeEqual,
  toBase64Url,
} from '../src/crypto.ts';
import { buildCsv, escapeHtml, fmtInt, sparkline } from '../src/format.ts';
import { kindLabel, normalizeLang, t } from '../src/i18n.ts';
import { detectContent } from '../src/content.ts';
import { anonymousMessageKeyboard, mainMenuKeyboard, settingsKeyboard } from '../src/keyboards.ts';

const SECRET = 'test-secret-0123456789-0123456789-abcdef';

test('base64url round-trip', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(Array.from(fromBase64Url(toBase64Url(bytes))), Array.from(bytes));
});

test('AES-GCM sender reference round-trip', async () => {
  const ref = await encryptSenderRef(SECRET, 123456789);
  assert.ok(!ref.includes('123456789'));
  assert.equal(await decryptSenderRef(SECRET, ref), 123456789);
  await assert.rejects(() => decryptSenderRef('another-secret-0123456789-0123456789', ref));
});

test('sender pseudonym is stable and secret-bound', async () => {
  const first = await senderKey(SECRET, 42);
  const second = await senderKey(SECRET, 42);
  const other = await senderKey(SECRET, 43);
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(first.length, 32);
});

test('hmac and sha256 are deterministic', async () => {
  assert.equal(await hmacHex(SECRET, 'abc'), await hmacHex(SECRET, 'abc'));
  assert.equal((await sha256Hex('abc')).length, 64);
  assert.notEqual(await hmacHex(SECRET, 'abc'), await hmacHex(SECRET, 'abd'));
});

test('timingSafeEqual compares strings', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'ab'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

test('sparkline handles zeros and peaks', () => {
  assert.equal(sparkline([0, 0, 0]), '▁▁▁');
  assert.equal(sparkline([]), '');
  assert.equal(sparkline([1, 2, 4])[2], '█');
  assert.equal(sparkline([0, 1])[0], '▁');
});

test('i18n has both languages and interpolates', () => {
  assert.match(t('ru', 'menu.stats', { total: 5, week: 2, replies: 1, blocked: 0, status: 'ok' }), /5/);
  assert.match(t('en', 'menu.stats', { total: 5, week: 2, replies: 1, blocked: 0, status: 'ok' }), /Received/);
  assert.equal(t('en', 'kind.photo'), 'Photo');
  assert.equal(kindLabel('ru', 'video_note'), 'Кружок');
  assert.equal(normalizeLang('ru-RU'), 'ru');
  assert.equal(normalizeLang('de-DE'), 'en');
  assert.equal(normalizeLang(null), 'ru');
  assert.equal(escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.equal(fmtInt(1234567), '1 234 567');
});

test('detectContent recognizes text, media and links', () => {
  const base = { message_id: 1, chat: { id: 1, type: 'private' }, date: 0 };

  const text = detectContent({ ...base, text: 'привет https://example.com' });
  assert.equal(text?.kind, 'text');
  assert.equal(text?.hasLink, true);

  const photo = detectContent({ ...base, photo: [{ file_id: 'x' }], caption: 'look' });
  assert.equal(photo?.kind, 'photo');
  assert.equal(photo?.text, 'look');

  const sticker = detectContent({ ...base, sticker: { file_id: 's', emoji: '🔥' } });
  assert.equal(sticker?.kind, 'sticker');

  assert.equal(detectContent({ ...base }), null);
});

test('callback_data stays within the Telegram limit', () => {
  const keyboards = [
    mainMenuKeyboard('ru'),
    anonymousMessageKeyboard('ru', 999999999, false),
    anonymousMessageKeyboard('en', 1, true),
    settingsKeyboard('ru', {
      id: 1,
      username: null,
      first_name: null,
      lang: 'ru',
      inbox_token: 'x',
      accept_messages: 1,
      allow_media: 1,
      allow_links: 0,
      notify_reactions: 1,
      target_id: null,
      target_at: null,
      is_blocked: 0,
      created_at: 0,
      last_seen_at: 0,
    }),
  ];

  for (const keyboard of keyboards) {
    for (const row of keyboard.inline_keyboard) {
      for (const button of row) {
        assert.ok(button.callback_data, 'button has callback_data');
        assert.ok(
          new TextEncoder().encode(button.callback_data).length <= 64,
          `callback too long: ${button.callback_data}`,
        );
      }
    }
  }
});

test('CSV builder escapes and adds BOM', () => {
  const csv = buildCsv([
    ['a', 'b'],
    ['hello, world', 'quote "x"'],
  ]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"hello, world"/);
  assert.match(csv, /"quote ""x"""/);
});
