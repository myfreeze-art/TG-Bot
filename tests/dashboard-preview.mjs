// src/telegram.ts
var TelegramError = class extends Error {
  description;
  code;
  retryAfter;
  constructor(description, code, retryAfter) {
    super(description);
    this.name = "TelegramError";
    this.description = description;
    this.code = code;
    this.retryAfter = retryAfter;
  }
};
function isFormData(value) {
  return typeof FormData !== "undefined" && value instanceof FormData;
}
var Telegram = class {
  base;
  constructor(token, apiBase = "https://api.telegram.org") {
    this.base = `${apiBase.replace(/\/$/, "")}/bot${token}`;
  }
  async call(method, params) {
    const init = { method: "POST" };
    if (isFormData(params)) {
      init.body = params;
    } else {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(params ?? {});
    }
    const response = await fetch(`${this.base}/${method}`, init);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramError(`HTTP ${response.status}`, response.status);
    }
    if (!payload.ok) {
      throw new TelegramError(
        payload.description ?? `Telegram API error (HTTP ${response.status})`,
        payload.error_code ?? response.status,
        payload.parameters?.retry_after
      );
    }
    return payload.result;
  }
  sendMessage(chatId, text, options = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...options
    });
  }
  editMessageText(chatId, messageId, text, options = {}) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...options
    });
  }
  editMessageReplyMarkup(chatId, messageId, markup) {
    return this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: markup
    });
  }
  copyMessage(params) {
    return this.call("copyMessage", params);
  }
  deleteMessage(chatId, messageId) {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }
  answerCallbackQuery(callbackQueryId, text, showAlert = false) {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert
    });
  }
  sendDocument(chatId, filename, content, caption) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }
    form.append("document", new Blob([content], { type: "text/csv;charset=utf-8" }), filename);
    return this.call("sendDocument", form);
  }
  getMe() {
    return this.call("getMe");
  }
};
function isIgnorableTelegramError(error) {
  if (!(error instanceof TelegramError)) return false;
  return /message is not modified|message to edit not found|message can't be edited|chat not found|bot was blocked by the user|user is deactivated|not enough rights|message to delete not found|query is too old|bot was kicked|BUTTON_DATA_INVALID|message can't be deleted/i.test(
    error.description
  );
}

// src/ctx.ts
async function createCtx(env, origin, execution) {
  return {
    env,
    api: new Telegram(env.BOT_TOKEN),
    db: env.DB,
    now: Math.floor(Date.now() / 1e3),
    origin,
    waitUntil: (promise) => execution.waitUntil(promise)
  };
}
var botUsernameCache = null;
async function getBotUsername(ctx) {
  const configured2 = ctx.env.BOT_USERNAME?.trim().replace(/^@/, "");
  if (configured2) return configured2;
  if (botUsernameCache && botUsernameCache.token === ctx.env.BOT_TOKEN) return botUsernameCache.username;
  try {
    const me = await ctx.api.getMe();
    if (me.username) {
      botUsernameCache = { token: ctx.env.BOT_TOKEN, username: me.username };
      return me.username;
    }
  } catch (error) {
    console.error("getMe failed", error instanceof Error ? error.message : String(error));
  }
  return "your_bot";
}
function inboxLink(username, token) {
  return `https://t.me/${username}?start=u_${token}`;
}

// src/crypto.ts
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var hmacKeyCache = /* @__PURE__ */ new Map();
var refKeyCache = /* @__PURE__ */ new Map();
function toHex(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
function randomToken(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}
function timingSafeEqual(a, b) {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}
async function hmacKey(secret) {
  let cached = hmacKeyCache.get(secret);
  if (!cached) {
    cached = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacKeyCache.set(secret, cached);
  }
  return cached;
}
async function hmacHex(secret, data) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(data));
  return toHex(signature);
}
async function sha256Hex(data) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return toHex(digest);
}
async function senderKey(secret, userId) {
  const digest = await hmacHex(secret, `sender:v1:${userId}`);
  return digest.slice(0, 32);
}
async function deriveRefKey(secret) {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("anon-msg-bot/ref/salt/v1"),
      info: encoder.encode("sender-ref")
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
function refKey(secret) {
  let cached = refKeyCache.get(secret);
  if (!cached) {
    cached = deriveRefKey(secret);
    refKeyCache.set(secret, cached);
  }
  return cached;
}
async function encryptSenderRef(secret, userId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode("anon-msg-bot:v1") },
    await refKey(secret),
    encoder.encode(String(userId))
  );
  const payload = new Uint8Array(iv.length + ciphertext.byteLength);
  payload.set(iv, 0);
  payload.set(new Uint8Array(ciphertext), iv.length);
  return toBase64Url(payload);
}
async function decryptSenderRef(secret, ref) {
  const payload = fromBase64Url(ref);
  if (payload.length < 13) throw new Error("bad ref");
  const iv = payload.slice(0, 12);
  const ciphertext = payload.slice(12);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode("anon-msg-bot:v1") },
    await refKey(secret),
    ciphertext
  );
  const userId = Number(decoder.decode(plain));
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("bad ref payload");
  return userId;
}

// src/i18n.ts
var ru = {
  // ---------------------------------------------------------------- buttons
  "btn.link": "\u{1F517} \u041C\u043E\u044F \u0441\u0441\u044B\u043B\u043A\u0430",
  "btn.share": "\u{1F4E4} \u041F\u043E\u0434\u0435\u043B\u0438\u0442\u044C\u0441\u044F",
  "btn.stats": "\u{1F4CA} \u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430",
  "btn.settings": "\u2699\uFE0F \u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438",
  "btn.help": "\u2753 \u041F\u043E\u043C\u043E\u0449\u044C",
  "btn.back": "\u2039 \u041D\u0430\u0437\u0430\u0434",
  "btn.close": "\u2716\uFE0F \u0417\u0430\u043A\u0440\u044B\u0442\u044C",
  "btn.refresh": "\u{1F504} \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C",
  "btn.acceptOn": "\u{1F7E2} \u041F\u0440\u0438\u0451\u043C: \u0432\u043A\u043B",
  "btn.acceptOff": "\u{1F534} \u041F\u0440\u0438\u0451\u043C: \u0432\u044B\u043A\u043B",
  "btn.mediaOn": "\u{1F5BC} \u041C\u0435\u0434\u0438\u0430: \u0432\u043A\u043B",
  "btn.mediaOff": "\u{1F5BC} \u041C\u0435\u0434\u0438\u0430: \u0432\u044B\u043A\u043B",
  "btn.linksOn": "\u{1F517} \u0421\u0441\u044B\u043B\u043A\u0438: \u0432\u043A\u043B",
  "btn.linksOff": "\u{1F517} \u0421\u0441\u044B\u043B\u043A\u0438: \u0432\u044B\u043A\u043B",
  "btn.reactionsOn": "\u2728 \u0420\u0435\u0430\u043A\u0446\u0438\u0438: \u0432\u043A\u043B",
  "btn.reactionsOff": "\u2728 \u0420\u0435\u0430\u043A\u0446\u0438\u0438: \u0432\u044B\u043A\u043B",
  "btn.blocks": "\u{1F6AB} \u0411\u043B\u043E\u043A-\u043B\u0438\u0441\u0442",
  "btn.clearBlocks": "\u267B\uFE0F \u0420\u0430\u0437\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0432\u0441\u0435\u0445",
  "btn.reply": "\u{1F4AC} \u041E\u0442\u0432\u0435\u0442\u0438\u0442\u044C",
  "btn.block": "\u{1F6AB} \u0411\u043B\u043E\u043A",
  "btn.report": "\u26A0\uFE0F \u0416\u0430\u043B\u043E\u0431\u0430",
  "btn.continue": "\u21A9\uFE0F \u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C \u0434\u0438\u0430\u043B\u043E\u0433",
  "btn.langRu": "\u{1F1F7}\u{1F1FA} \u0420\u0443\u0441\u0441\u043A\u0438\u0439",
  "btn.langEn": "\u{1F1EC}\u{1F1E7} English",
  "btn.cancel": "\u2716\uFE0F \u041E\u0442\u043C\u0435\u043D\u0430",
  // ------------------------------------------------------------------- menu
  "on": "\u2705 \u0432\u043A\u043B",
  "off": "\u{1F6AB} \u0432\u044B\u043A\u043B",
  "menu.title": "\u{1F44B} <b>\u041F\u0440\u0438\u0432\u0435\u0442, {name}!</b>\n\n\u042D\u0442\u043E \u0431\u043E\u0442 \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u044B\u0445 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439. \u0422\u0432\u043E\u0439 \u043B\u0438\u0447\u043D\u044B\u0439 \u044F\u0449\u0438\u043A \u0433\u043E\u0442\u043E\u0432.\n\n\u{1F517} <code>{link}</code>\n\n\u041F\u043E\u0434\u0435\u043B\u0438\u0441\u044C \u0441\u0441\u044B\u043B\u043A\u043E\u0439 \u2014 \u0438 \u043F\u043E\u043B\u0443\u0447\u0430\u0439 \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u044B\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F. \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044C \u043E\u0441\u0442\u0430\u043D\u0435\u0442\u0441\u044F \u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u043C. \u041C\u043E\u0436\u043D\u043E \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E \u043E\u0442\u0432\u0435\u0447\u0430\u0442\u044C, \u0441\u0442\u0430\u0432\u0438\u0442\u044C \u0440\u0435\u0430\u043A\u0446\u0438\u0438 \u0438 \u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0441\u043F\u0430\u043C\u0435\u0440\u043E\u0432.",
  "menu.hint": "\u0412\u044B\u0431\u0435\u0440\u0438 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435:",
  "menu.link": "\u{1F517} <b>\u0422\u0432\u043E\u044F \u0441\u0441\u044B\u043B\u043A\u0430</b>\n\n<code>{link}</code>\n\n\u0414\u043E\u0431\u0430\u0432\u044C \u0435\u0451 \u0432 \u043F\u0440\u043E\u0444\u0438\u043B\u044C, \u0441\u0442\u043E\u0440\u0438\u0441 \u0438\u043B\u0438 \u0447\u0430\u0442. \u041A\u0430\u0436\u0434\u044B\u0439, \u043A\u0442\u043E \u043F\u0435\u0440\u0435\u0439\u0434\u0451\u0442, \u0441\u043C\u043E\u0436\u0435\u0442 \u043D\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0442\u0435\u0431\u0435 \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E.\n\n\u{1F4A1} \u0427\u0435\u043C \u0447\u0430\u0449\u0435 \u0441\u0441\u044B\u043B\u043A\u0430 \u043D\u0430 \u0432\u0438\u0434\u0443, \u0442\u0435\u043C \u0431\u043E\u043B\u044C\u0448\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439.",
  "menu.shareText": "\u041D\u0430\u043F\u0438\u0448\u0438 \u043C\u043D\u0435 \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E \u{1F447}",
  "menu.stats": "\u{1F4CA} <b>\u0422\u0432\u043E\u0439 \u044F\u0449\u0438\u043A</b>\n\n\u{1F4E8} \u041F\u043E\u043B\u0443\u0447\u0435\u043D\u043E: <b>{total}</b>\n\u{1F195} \u0417\u0430 7 \u0434\u043D\u0435\u0439: <b>{week}</b>\n\u{1F4AC} \u041E\u0442\u0432\u0435\u0442\u043E\u0432: <b>{replies}</b>\n\u{1F6AB} \u0412 \u0431\u043B\u043E\u043A-\u043B\u0438\u0441\u0442\u0435: <b>{blocked}</b>\n\n{status}",
  "menu.statusOn": "\u{1F7E2} \u041F\u0440\u0438\u0451\u043C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u0432\u043A\u043B\u044E\u0447\u0451\u043D",
  "menu.statusOff": "\u{1F534} \u041F\u0440\u0438\u0451\u043C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D",
  "menu.settings": "\u2699\uFE0F <b>\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u044F\u0449\u0438\u043A\u0430</b>\n\n\u041F\u0440\u0438\u0451\u043C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439: {accept}\n\u041C\u0435\u0434\u0438\u0430: {media}\n\u0421\u0441\u044B\u043B\u043A\u0438: {links}\n\u0420\u0435\u0430\u043A\u0446\u0438\u0438: {reactions}\n\n\u041D\u0430\u0436\u043C\u0438 \u043D\u0430 \u043A\u043D\u043E\u043F\u043A\u0443, \u0447\u0442\u043E\u0431\u044B \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0438\u0442\u044C.",
  "menu.blocks": "\u{1F6AB} <b>\u0411\u043B\u043E\u043A-\u043B\u0438\u0441\u0442</b>\n\n\u0417\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u043E \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u0435\u0439: <b>{count}</b>\n\n\u0425\u0440\u0430\u043D\u044F\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u043D\u0435\u043E\u0431\u0440\u0430\u0442\u0438\u043C\u044B\u0435 \u0445\u0435\u0448\u0438 \u2014 \u0442\u044B \u043D\u0435 \u0443\u0437\u043D\u0430\u0435\u0448\u044C, \u043A\u0442\u043E \u044D\u0442\u043E, \u0434\u0430\u0436\u0435 \u0435\u0441\u043B\u0438 \u0437\u0430\u0445\u043E\u0447\u0435\u0448\u044C.",
  "menu.help": "\u2753 <b>\u041A\u0430\u043A \u044D\u0442\u043E \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442</b>\n\n1. \u041F\u043E\u0434\u0435\u043B\u0438\u0441\u044C \u0441\u0432\u043E\u0435\u0439 \u0441\u0441\u044B\u043B\u043A\u043E\u0439.\n2. \u041B\u044E\u0434\u0438 \u043F\u0438\u0448\u0443\u0442 \u0442\u0435\u0431\u0435 \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E.\n3. \u0422\u044B \u043C\u043E\u0436\u0435\u0448\u044C \u043E\u0442\u0432\u0435\u0442\u0438\u0442\u044C, \u043F\u043E\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u0440\u0435\u0430\u043A\u0446\u0438\u044E, \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044F \u0438\u043B\u0438 \u043F\u043E\u0436\u0430\u043B\u043E\u0432\u0430\u0442\u044C\u0441\u044F \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443.\n\n<b>\u041A\u043E\u043C\u0430\u043D\u0434\u044B</b>\n/link \u2014 \u043C\u043E\u044F \u0441\u0441\u044B\u043B\u043A\u0430\n/stats \u2014 \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430\n/settings \u2014 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438\n/pause \u2014 \u043D\u0435 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0442\u044C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F\n/resume \u2014 \u0441\u043D\u043E\u0432\u0430 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0442\u044C\n/lang \u2014 \u044F\u0437\u044B\u043A\n/privacy \u2014 \u043F\u0440\u0438\u0432\u0430\u0442\u043D\u043E\u0441\u0442\u044C\n/cancel \u2014 \u043E\u0442\u043C\u0435\u043D\u0438\u0442\u044C \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435\n\n<b>\u0410\u0434\u043C\u0438\u043D\u0443</b>\n/admin \u2014 \u043F\u0430\u043D\u0435\u043B\u044C \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F",
  "menu.privacy": "\u{1F575}\uFE0F <b>\u041F\u0440\u0438\u0432\u0430\u0442\u043D\u043E\u0441\u0442\u044C</b>\n\n\u0411\u043E\u0442 \u043D\u0435 \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044F \u043D\u0438 \u0442\u0435\u0431\u0435, \u043D\u0438 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443.\n\n<b>\u0427\u0442\u043E \u0445\u0440\u0430\u043D\u0438\u0442\u0441\u044F</b>\n\u2022 \u043F\u0440\u0435\u0432\u044C\u044E \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F \u2014 \u0434\u043E {days} \u0434\u043D\u0435\u0439;\n\u2022 \u043D\u0435\u043E\u0431\u0440\u0430\u0442\u0438\u043C\u044B\u0439 \u0445\u0435\u0448 \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044F \u2014 \u0434\u043B\u044F \u0430\u043D\u0442\u0438\u0441\u043F\u0430\u043C\u0430, \u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u043E\u043A \u0438 \u0431\u0430\u043D\u043E\u0432;\n\u2022 \u0437\u0430\u0448\u0438\u0444\u0440\u043E\u0432\u0430\u043D\u043D\u0430\u044F \u0441\u0441\u044B\u043B\u043A\u0430 \u0434\u043B\u044F \u043E\u0442\u0432\u0435\u0442\u0430 \u2014 \u0443\u0434\u0430\u043B\u044F\u0435\u0442\u0441\u044F \u043F\u043E\u0441\u043B\u0435 \u043E\u0442\u0432\u0435\u0442\u0430 \u0438\u043B\u0438 \u0447\u0435\u0440\u0435\u0437 {replyDays} \u0434\u043D.\n\n\u0410\u0434\u043C\u0438\u043D \u0432\u0438\u0434\u0438\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0430\u0433\u0440\u0435\u0433\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u0443\u044E \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0443. \u041F\u0440\u0438 \u0436\u0430\u043B\u043E\u0431\u0435 \u043E\u043D \u043F\u043E\u043B\u0443\u0447\u0430\u0435\u0442 \u0442\u0435\u043A\u0441\u0442 \u0438 \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u0439 \u0445\u0435\u0448, \u043D\u043E \u043D\u0435 \u0438\u043C\u044F.\n\n\u26A0\uFE0F \u0423 \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430 \u0431\u043E\u0442\u0430 \u0435\u0441\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F \u043A \u0441\u0435\u0440\u0432\u0435\u0440\u0443 \u0438 \u0441\u0435\u043A\u0440\u0435\u0442\u0430\u043C, \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u0442\u0435\u0445\u043D\u0438\u0447\u0435\u0441\u043A\u0438 \u0438\u0434\u0435\u0430\u043B\u044C\u043D\u0430\u044F \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E\u0441\u0442\u044C \u043E\u0442 \u043D\u0435\u0433\u043E \u043D\u0435\u0432\u043E\u0437\u043C\u043E\u0436\u043D\u0430. \u041D\u043E \u043F\u0430\u043D\u0435\u043B\u044C \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0430 \u043D\u0435 \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044F \u0438 \u043D\u0435 \u0438\u043C\u0435\u0435\u0442 \u043A\u043E\u043C\u0430\u043D\u0434\u044B, \u0447\u0442\u043E\u0431\u044B \u0435\u0433\u043E \u0440\u0430\u0441\u043A\u0440\u044B\u0442\u044C.",
  "menu.maintenance": "\u{1F6E0} \u0411\u043E\u0442 \u043D\u0430 \u0442\u0435\u0445\u043D\u0438\u0447\u0435\u0441\u043A\u043E\u043C \u043E\u0431\u0441\u043B\u0443\u0436\u0438\u0432\u0430\u043D\u0438\u0438. \u0417\u0430\u0433\u043B\u044F\u043D\u0438 \u0447\u0443\u0442\u044C \u043F\u043E\u0437\u0436\u0435.",
  "menu.cancelled": "\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u043E.",
  "menu.unknownCommand": "\u041D\u0435 \u0437\u043D\u0430\u044E \u0442\u0430\u043A\u0443\u044E \u043A\u043E\u043C\u0430\u043D\u0434\u0443. \u041D\u0430\u0436\u043C\u0438 /help.",
  // ------------------------------------------------------------- user flow
  "send.noTarget": "\u{1F48C} \u0427\u0442\u043E\u0431\u044B \u043D\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E, \u043E\u0442\u043A\u0440\u043E\u0439 \u0447\u0443\u0436\u043E\u0439 \u044F\u0449\u0438\u043A \u043F\u043E \u0441\u0441\u044B\u043B\u043A\u0435.\n\n\u0421\u0432\u043E\u044F \u0441\u0441\u044B\u043B\u043A\u0430: /link",
  "send.sent": "\u2705 \u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E. \u041F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u044C \u043D\u0435 \u0443\u0437\u043D\u0430\u0435\u0442, \u043A\u0442\u043E \u0442\u044B.",
  "send.sentNamed": "\u2705 \u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E \u0432 \u044F\u0449\u0438\u043A {name}.",
  "send.self": "\u{1F605} \u041D\u0435\u043B\u044C\u0437\u044F \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0441\u0430\u043C\u043E\u043C\u0443 \u0441\u0435\u0431\u0435.",
  "send.closed": "\u{1F634} \u042D\u0442\u043E\u0442 \u044F\u0449\u0438\u043A \u0441\u0435\u0439\u0447\u0430\u0441 \u043D\u0435 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u0442 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439 \u043F\u043E\u0437\u0436\u0435.",
  "send.blocked": "\u{1F6AB} \u041F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u044C \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043B \u0442\u0435\u0431\u044F.",
  "send.banned": "\u26D4\uFE0F \u0422\u044B \u043D\u0435 \u043C\u043E\u0436\u0435\u0448\u044C \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0442\u044C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F.",
  "send.mediaOff": "\u{1F5BC} \u042D\u0442\u043E\u0442 \u044F\u0449\u0438\u043A \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0442\u0435\u043A\u0441\u0442.",
  "send.linksOff": "\u{1F517} \u0421\u0441\u044B\u043B\u043A\u0438 \u0432 \u044D\u0442\u043E\u043C \u044F\u0449\u0438\u043A\u0435 \u0437\u0430\u043F\u0440\u0435\u0449\u0435\u043D\u044B.",
  "send.tooLong": "\u2702\uFE0F \u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0434\u043B\u0438\u043D\u043D\u043E: \u043C\u0430\u043A\u0441\u0438\u043C\u0443\u043C {max} \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432.",
  "send.unsupported": "\u{1F937} \u042D\u0442\u043E\u0442 \u0442\u0438\u043F \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F. \u041D\u0430\u043F\u0438\u0448\u0438 \u0442\u0435\u043A\u0441\u0442\u043E\u043C \u0438\u043B\u0438 \u043F\u0440\u0438\u043A\u0440\u0435\u043F\u0438 \u0444\u043E\u0442\u043E, \u0432\u0438\u0434\u0435\u043E, \u0433\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435 \u0438\u043B\u0438 \u0444\u0430\u0439\u043B.",
  "send.empty": "\u270D\uFE0F \u041D\u0430\u043F\u0438\u0448\u0438 \u0442\u0435\u043A\u0441\u0442 \u0438\u043B\u0438 \u043F\u0440\u0438\u043A\u0440\u0435\u043F\u0438 \u043C\u0435\u0434\u0438\u0430.",
  "send.rate": "\u23F3 \u041D\u0435 \u0442\u0430\u043A \u0431\u044B\u0441\u0442\u0440\u043E. \u041F\u043E\u0434\u043E\u0436\u0434\u0438 {sec} \u0441\u0435\u043A.",
  "send.duplicate": "\u{1F9D0} \u0422\u044B \u0443\u0436\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u043B \u044D\u0442\u043E \u043D\u0435\u0434\u0430\u0432\u043D\u043E. \u041D\u0430\u043F\u0438\u0448\u0438 \u0447\u0442\u043E-\u043D\u0438\u0431\u0443\u0434\u044C \u0434\u0440\u0443\u0433\u043E\u0435.",
  "send.failed": "\u{1F614} \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0434\u043E\u0441\u0442\u0430\u0432\u0438\u0442\u044C. \u0412\u043E\u0437\u043C\u043E\u0436\u043D\u043E, \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u044C \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043B \u0431\u043E\u0442\u0430.",
  "send.replyPrompt": "\u{1F4AC} <b>\u041E\u0442\u0432\u0435\u0442 \u043D\u0430 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 #{id}</b>\n\n\u041D\u0430\u043F\u0438\u0448\u0438 \u043E\u0442\u0432\u0435\u0442 \u2014 \u043E\u043D \u0443\u0439\u0434\u0451\u0442 \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E. \u041C\u043E\u0436\u043D\u043E \u043F\u0440\u0438\u043A\u0440\u0435\u043F\u0438\u0442\u044C \u043C\u0435\u0434\u0438\u0430.\n\n/cancel \u2014 \u043E\u0442\u043C\u0435\u043D\u0430",
  "send.replySent": "\u2705 \u041E\u0442\u0432\u0435\u0442 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E.",
  "send.replyExpired": "\u231B\uFE0F \u041E\u0442\u0432\u0435\u0442 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D: \u0441\u0440\u043E\u043A \u0445\u0440\u0430\u043D\u0435\u043D\u0438\u044F \u0438\u0441\u0442\u0451\u043A \u0438\u043B\u0438 \u043D\u0430 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0443\u0436\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B\u0438.",
  "send.replyFailed": "\u{1F614} \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0434\u043E\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u043E\u0442\u0432\u0435\u0442. \u0412\u043E\u0437\u043C\u043E\u0436\u043D\u043E, \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044C \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043B \u0431\u043E\u0442\u0430.",
  "send.replyHeader": "\u{1F4AC} <b>\u0410\u043D\u043E\u043D\u0438\u043C\u043D\u044B\u0439 \u043E\u0442\u0432\u0435\u0442</b>",
  "send.reactionSent": "\u0420\u0435\u0430\u043A\u0446\u0438\u044F \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0430 \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E.",
  "send.reactionAlready": "\u0422\u044B \u0443\u0436\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u043B \u044D\u0442\u0443 \u0440\u0435\u0430\u043A\u0446\u0438\u044E.",
  "send.reactionNotify": "\u2728 \u0422\u0432\u043E\u0451 \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u043E \u0440\u0435\u0430\u043A\u0446\u0438\u044E: {emoji}",
  "send.reportSent": "\u26A0\uFE0F \u0416\u0430\u043B\u043E\u0431\u0430 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0430 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443, \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044C \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D. \u0421\u043F\u0430\u0441\u0438\u0431\u043E!",
  "send.reportAlready": "\u0416\u0430\u043B\u043E\u0431\u0430 \u0443\u0436\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0430.",
  "send.blockedUser": "\u{1F6AB} \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044C \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D. \u0411\u043E\u043B\u044C\u0448\u0435 \u043E\u043D \u043D\u0435 \u0441\u043C\u043E\u0436\u0435\u0442 \u0442\u0435\u0431\u0435 \u043F\u0438\u0441\u0430\u0442\u044C.",
  "send.unblockedAll": "\u267B\uFE0F \u0411\u043B\u043E\u043A-\u043B\u0438\u0441\u0442 \u043E\u0447\u0438\u0449\u0435\u043D.",
  "send.continueSet": "\u21A9\uFE0F \u0422\u0435\u043F\u0435\u0440\u044C \u0442\u0432\u043E\u0438 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F \u0443\u0445\u043E\u0434\u044F\u0442 \u0432 \u044F\u0449\u0438\u043A {name}.",
  "send.targetGone": "\u042D\u0442\u043E\u0442 \u044F\u0449\u0438\u043A \u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435 \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u0435\u0442.",
  "send.inboxIntro": "\u{1F48C} <b>\u0410\u043D\u043E\u043D\u0438\u043C\u043D\u044B\u0439 \u044F\u0449\u0438\u043A</b>\n\n{name}\n\n\u041D\u0430\u043F\u0438\u0448\u0438 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u2014 \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u044C \u043D\u0435 \u0443\u0437\u043D\u0430\u0435\u0442, \u043A\u0442\u043E \u0442\u044B.",
  "send.badLink": "\u{1F517} \u0421\u0441\u044B\u043B\u043A\u0430 \u043D\u0435\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043B\u044C\u043D\u0430 \u0438\u043B\u0438 \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0430.",
  "send.ownLink": "\u{1F605} \u042D\u0442\u043E \u0442\u0432\u043E\u0439 \u0441\u043E\u0431\u0441\u0442\u0432\u0435\u043D\u043D\u044B\u0439 \u044F\u0449\u0438\u043A. \u041E\u0442\u043F\u0440\u0430\u0432\u044C \u0441\u0441\u044B\u043B\u043A\u0443 \u0434\u0440\u0443\u0433\u0443!",
  "send.langChanged": "\u0413\u043E\u0442\u043E\u0432\u043E, \u044F\u0437\u044B\u043A \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0451\u043D.",
  "send.paused": "\u23F8 \u041F\u0440\u0438\u0451\u043C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D. \u0412\u043A\u043B\u044E\u0447\u0438\u0442\u044C: /resume",
  "send.resumed": "\u25B6\uFE0F \u041F\u0440\u0438\u0451\u043C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u0432\u043A\u043B\u044E\u0447\u0451\u043D.",
  "send.noRepliesStrict": "\u0412 \u044D\u0442\u043E\u043C \u044F\u0449\u0438\u043A\u0435 \u043E\u0442\u0432\u0435\u0442\u044B \u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u044B.",
  // ------------------------------------------------------------------ admin
  "admin.denied": "\u26D4\uFE0F \u0414\u043E\u0441\u0442\u0443\u043F \u0442\u043E\u043B\u044C\u043A\u043E \u0434\u043B\u044F \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0430.",
  "admin.title": "\u{1F6E1} <b>\u0410\u0434\u043C\u0438\u043D-\u043F\u0430\u043D\u0435\u043B\u044C</b>",
  "admin.users": "\u{1F465} \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u0438",
  "admin.messages": "\u{1F4E8} \u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F",
  "admin.replies": "\u{1F4AC} \u041E\u0442\u0432\u0435\u0442\u044B",
  "admin.bans": "\u{1F6AB} \u0411\u0430\u043D\u044B",
  "admin.reports": "\u26A0\uFE0F \u0416\u0430\u043B\u043E\u0431\u044B",
  "admin.activeInboxes": "\u{1F4E5} \u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0435 \u044F\u0449\u0438\u043A\u0438",
  "admin.today": "\u0441\u0435\u0433\u043E\u0434\u043D\u044F",
  "admin.week": "7 \u0434\u043D\u0435\u0439",
  "admin.last7": "\u{1F4C8} 7 \u0434\u043D\u0435\u0439",
  "admin.updated": "\u{1F552} \u041E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u043E",
  "admin.overview": "\u{1F6E1} <b>\u0410\u0434\u043C\u0438\u043D-\u043F\u0430\u043D\u0435\u043B\u044C</b>\n\n\u{1F465} \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u0438: <b>{users}</b> (+{usersToday} \u0441\u0435\u0433\u043E\u0434\u043D\u044F, +{users7} \u0437\u0430 7\u0434)\n\u{1F4E8} \u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F: <b>{messages}</b> (+{messagesToday} \u0441\u0435\u0433\u043E\u0434\u043D\u044F, +{messages7} \u0437\u0430 7\u0434)\n\u{1F4AC} \u041E\u0442\u0432\u0435\u0442\u044B: <b>{replies}</b> ({replyRate}%)\n\u{1F6AB} \u0411\u0430\u043D\u044B: <b>{bans}</b> \xB7 \u26A0\uFE0F \u041D\u043E\u0432\u044B\u0435 \u0436\u0430\u043B\u043E\u0431\u044B: <b>{reportsNew}</b>\n\u{1F4E5} \u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0435 \u044F\u0449\u0438\u043A\u0438: <b>{activeInboxes}</b>\n\n\u{1F4C8} 7 \u0434\u043D\u0435\u0439: <code>{spark}</code>  (\u043C\u0430\u043A\u0441 {max}/\u0434\u0435\u043D\u044C)\n\u{1F6E0} \u041E\u0431\u0441\u043B\u0443\u0436\u0438\u0432\u0430\u043D\u0438\u0435: {maint} \xB7 \u{1F575}\uFE0F \u0421\u0442\u0440\u043E\u0433\u0430\u044F \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E\u0441\u0442\u044C: {strict}\n\u{1F552} \u041E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u043E: {updated}",
  "admin.btn.overview": "\u{1F4CA} \u041E\u0431\u0437\u043E\u0440",
  "admin.btn.dynamics": "\u{1F4C8} \u0414\u0438\u043D\u0430\u043C\u0438\u043A\u0430",
  "admin.btn.kinds": "\u{1F3AD} \u0422\u0438\u043F\u044B",
  "admin.btn.top": "\u{1F3C6} \u0422\u043E\u043F \u044F\u0449\u0438\u043A\u043E\u0432",
  "admin.btn.reports": "\u26A0\uFE0F \u0416\u0430\u043B\u043E\u0431\u044B ({n})",
  "admin.btn.bans": "\u{1F6AB} \u0411\u0430\u043D\u044B",
  "admin.btn.broadcast": "\u{1F4E3} \u0420\u0430\u0441\u0441\u044B\u043B\u043A\u0430",
  "admin.btn.csv": "\u{1F4E4} CSV",
  "admin.btn.settings": "\u2699\uFE0F \u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438",
  "admin.btn.refresh": "\u{1F504} \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C",
  "admin.btn.back": "\u2039 \u041D\u0430\u0437\u0430\u0434",
  "admin.dynamicsTitle": "\u{1F4C8} <b>\u0414\u0438\u043D\u0430\u043C\u0438\u043A\u0430 \u0437\u0430 {days} \u0434\u043D\u0435\u0439</b>",
  "admin.dynamicsTotals": "\u{1F4E8} \u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439: <b>{messages}</b>\n\u{1F465} \u041D\u043E\u0432\u044B\u0445: <b>{users}</b>\n\u{1F4AC} \u041E\u0442\u0432\u0435\u0442\u043E\u0432: <b>{replies}</b>\n\u{1F4CA} \u0412 \u0441\u0440\u0435\u0434\u043D\u0435\u043C: <b>{avg}</b>/\u0434\u0435\u043D\u044C\n\n<code>{spark}</code>\n{peak}",
  "admin.peak": "\u{1F552} \u041F\u0438\u043A (UTC): {from}:00\u2013{to}:00 ({count})",
  "admin.dayLine": "{date} \xB7 <b>{count}</b>",
  "admin.kindsTitle": "\u{1F3AD} <b>\u0422\u0438\u043F\u044B \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u0437\u0430 30 \u0434\u043D\u0435\u0439</b>",
  "admin.kindLine": "{emoji} {label} \u2014 <b>{count}</b> ({percent}%)",
  "admin.kindsEmpty": "\u041F\u043E\u043A\u0430 \u043D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445.",
  "admin.topTitle": "\u{1F3C6} <b>\u0422\u043E\u043F \u044F\u0449\u0438\u043A\u043E\u0432 \u0437\u0430 30 \u0434\u043D\u0435\u0439</b>",
  "admin.topLine": "{rank}. {name} \u2014 <b>{count}</b>",
  "admin.topEmpty": "\u041F\u043E\u043A\u0430 \u043D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445.",
  "admin.reportsTitle": "\u26A0\uFE0F <b>\u0416\u0430\u043B\u043E\u0431\u044B</b>",
  "admin.reportsEmpty": "\u041D\u043E\u0432\u044B\u0445 \u0436\u0430\u043B\u043E\u0431 \u043D\u0435\u0442. \u0412\u0441\u0451 \u0441\u043F\u043E\u043A\u043E\u0439\u043D\u043E \u2728",
  "admin.reportsPage": "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 {page} \u0438\u0437 {pages}",
  "admin.reportItem": "\u26A0\uFE0F <b>#{id}</b> \xB7 {kind}\n\u042F\u0449\u0438\u043A: {owner}\n\u041F\u0441\u0435\u0432\u0434\u043E\u043D\u0438\u043C: <code>{alias}</code> \xB7 {date}\n<blockquote>{preview}</blockquote>",
  "admin.reportItemNoPreview": "\u26A0\uFE0F <b>#{id}</b> \xB7 {kind}\n\u042F\u0449\u0438\u043A: {owner}\n\u041F\u0441\u0435\u0432\u0434\u043E\u043D\u0438\u043C: <code>{alias}</code> \xB7 {date}\n<i>\u0431\u0435\u0437 \u0442\u0435\u043A\u0441\u0442\u0430</i>",
  "admin.reportHint": "\u041A\u043D\u043E\u043F\u043A\u0438 \u043F\u043E\u0434 \u0441\u043F\u0438\u0441\u043A\u043E\u043C: \u0437\u0430\u0431\u0430\u043D\u0438\u0442\u044C \u0438\u043B\u0438 \u043E\u0442\u043A\u043B\u043E\u043D\u0438\u0442\u044C. \u041B\u0438\u0447\u043D\u043E\u0441\u0442\u044C \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044F \u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430 \u2014 \u0442\u043E\u043B\u044C\u043A\u043E \u043D\u0435\u043E\u0431\u0440\u0430\u0442\u0438\u043C\u044B\u0439 \u043F\u0441\u0435\u0432\u0434\u043E\u043D\u0438\u043C.",
  "admin.bansTitle": "\u{1F6AB} <b>\u0411\u0430\u043D\u044B</b>",
  "admin.bansTotal": "\u0412\u0441\u0435\u0433\u043E: <b>{count}</b>",
  "admin.bansEmpty": "\u0417\u0430\u0431\u0430\u043D\u0435\u043D\u043D\u044B\u0445 \u043D\u0435\u0442.",
  "admin.bansHint": "\u041F\u0441\u0435\u0432\u0434\u043E\u043D\u0438\u043C\u044B \u043D\u0435\u043E\u0431\u0440\u0430\u0442\u0438\u043C\u044B \u2014 \u043F\u043E \u043D\u0438\u043C \u043D\u0435\u043B\u044C\u0437\u044F \u0443\u0437\u043D\u0430\u0442\u044C \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430.",
  "admin.banItem": "<code>{key}</code> \xB7 {date}",
  "admin.unban": "\u2705 \u0420\u0430\u0437\u0431\u0430\u043D\u0438\u0442\u044C",
  "admin.ban": "\u{1F6AB} \u0417\u0430\u0431\u0430\u043D\u0438\u0442\u044C",
  "admin.dismiss": "\u2705 \u041E\u0442\u043A\u043B\u043E\u043D\u0438\u0442\u044C",
  "admin.settingsTitle": "\u2699\uFE0F <b>\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438</b>",
  "admin.setMaintenance": "\u{1F6E0} \u041E\u0431\u0441\u043B\u0443\u0436\u0438\u0432\u0430\u043D\u0438\u0435: {state}",
  "admin.setStrict": "\u{1F575}\uFE0F \u0421\u0442\u0440\u043E\u0433\u0430\u044F \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E\u0441\u0442\u044C: {state}",
  "admin.setDigest": "\u{1F514} \u0414\u0430\u0439\u0434\u0436\u0435\u0441\u0442: {state}",
  "admin.setDigestHour": "\u{1F552} \u0414\u0430\u0439\u0434\u0436\u0435\u0441\u0442 \u043F\u0440\u0438\u0445\u043E\u0434\u0438\u0442 \u0432 {hour}:00 UTC",
  "admin.setStrictHint": "\u0412 \u0441\u0442\u0440\u043E\u0433\u043E\u043C \u0440\u0435\u0436\u0438\u043C\u0435 \u043D\u0435\u043B\u044C\u0437\u044F \u043E\u0442\u0432\u0435\u0442\u0438\u0442\u044C \u0438 \u043F\u043E\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u0440\u0435\u0430\u043A\u0446\u0438\u044E: \u0431\u043E\u0442 \u043D\u0435 \u0445\u0440\u0430\u043D\u0438\u0442 \u0434\u0430\u0436\u0435 \u0437\u0430\u0448\u0438\u0444\u0440\u043E\u0432\u0430\u043D\u043D\u0443\u044E \u0441\u0441\u044B\u043B\u043A\u0443 \u043D\u0430 \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044F. \u0411\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u043A\u0438 \u0438 \u0436\u0430\u043B\u043E\u0431\u044B \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u044E\u0442 \u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C.",
  "admin.setStorage": "\u{1F5D1} \u041F\u0440\u0435\u0432\u044C\u044E \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u0445\u0440\u0430\u043D\u044F\u0442\u0441\u044F {days} \u0434\u043D., \u043A\u043B\u044E\u0447\u0438 \u0434\u043B\u044F \u043E\u0442\u0432\u0435\u0442\u0430 \u2014 {replyDays} \u0434\u043D.",
  "admin.setMaintenanceHint": "\u0412 \u0440\u0435\u0436\u0438\u043C\u0435 \u043E\u0431\u0441\u043B\u0443\u0436\u0438\u0432\u0430\u043D\u0438\u044F \u0431\u043E\u0442 \u043E\u0442\u0432\u0435\u0447\u0430\u0435\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0430\u043C.",
  "admin.btn.maintOn": "\u{1F6E0} \u041E\u0431\u0441\u043B\u0443\u0436\u0438\u0432\u0430\u043D\u0438\u0435: \u0432\u043A\u043B",
  "admin.btn.maintOff": "\u{1F6E0} \u041E\u0431\u0441\u043B\u0443\u0436\u0438\u0432\u0430\u043D\u0438\u0435: \u0432\u044B\u043A\u043B",
  "admin.btn.strictOn": "\u{1F575}\uFE0F \u0421\u0442\u0440\u043E\u0433\u0430\u044F \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E\u0441\u0442\u044C: \u0432\u043A\u043B",
  "admin.btn.strictOff": "\u{1F575}\uFE0F \u0421\u0442\u0440\u043E\u0433\u0430\u044F \u0430\u043D\u043E\u043D\u0438\u043C\u043D\u043E\u0441\u0442\u044C: \u0432\u044B\u043A\u043B",
  "admin.btn.digestOn": "\u{1F514} \u0414\u0430\u0439\u0434\u0436\u0435\u0441\u0442: \u0432\u043A\u043B",
  "admin.btn.digestOff": "\u{1F514} \u0414\u0430\u0439\u0434\u0436\u0435\u0441\u0442: \u0432\u044B\u043A\u043B",
  "admin.broadcastTitle": "\u{1F4E3} <b>\u0420\u0430\u0441\u0441\u044B\u043B\u043A\u0430</b>",
  "admin.broadcastIdle": "\u0410\u043A\u0442\u0438\u0432\u043D\u043E\u0439 \u0440\u0430\u0441\u0441\u044B\u043B\u043A\u0438 \u043D\u0435\u0442.\n\u041F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0435\u0439: <b>{recipients}</b>.",
  "admin.broadcastPrompt": "\u041E\u0442\u043F\u0440\u0430\u0432\u044C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0434\u043B\u044F \u0440\u0430\u0441\u0441\u044B\u043B\u043A\u0438 (\u0442\u0435\u043A\u0441\u0442, \u0444\u043E\u0442\u043E, \u0432\u0438\u0434\u0435\u043E \u0438 \u0442.\u043F.).\n\n\u041E\u043D\u043E \u0443\u0439\u0434\u0451\u0442 \u0432\u0441\u0435\u043C \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F\u043C \u043E\u0442 \u0438\u043C\u0435\u043D\u0438 \u0431\u043E\u0442\u0430. /cancel \u2014 \u043E\u0442\u043C\u0435\u043D\u0430.",
  "admin.broadcastConfirm": "\u{1F4E3} <b>\u041F\u0440\u043E\u0432\u0435\u0440\u044C \u0440\u0430\u0441\u0441\u044B\u043B\u043A\u0443</b>\n\n{content}\n\n\u041F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0435\u0439: <b>{recipients}</b>.\n\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u043C?",
  "admin.broadcastStarted": "\u23F3 \u0420\u0430\u0441\u0441\u044B\u043B\u043A\u0430 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430. \u041F\u0440\u043E\u0433\u0440\u0435\u0441\u0441: {sent} / {total}.",
  "admin.broadcastProgress": "\u23F3 \u0420\u0430\u0441\u0441\u044B\u043B\u043A\u0430: {sent} / {total} (\u043E\u0448\u0438\u0431\u043E\u043A: {failed})",
  "admin.broadcastDone": "\u2705 \u0420\u0430\u0441\u0441\u044B\u043B\u043A\u0430 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430.\n\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E: <b>{sent}</b>\n\u041E\u0448\u0438\u0431\u043E\u043A: <b>{failed}</b>",
  "admin.broadcastStopped": "\u23F9 \u0420\u0430\u0441\u0441\u044B\u043B\u043A\u0430 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430.\n\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E: <b>{sent}</b>\n\u041E\u0448\u0438\u0431\u043E\u043A: <b>{failed}</b>",
  "admin.broadcastAlready": "\u0423\u0436\u0435 \u0435\u0441\u0442\u044C \u0430\u043A\u0442\u0438\u0432\u043D\u0430\u044F \u0440\u0430\u0441\u0441\u044B\u043B\u043A\u0430 #{id}. \u0414\u043E\u0436\u0434\u0438\u0441\u044C \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u044F \u0438\u043B\u0438 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438 \u0435\u0451.",
  "admin.broadcastContentText": "\u0422\u0435\u043A\u0441\u0442: {preview}",
  "admin.broadcastContentMedia": "\u041C\u0435\u0434\u0438\u0430: {kind}",
  "admin.broadcastStop": "\u23F9 \u041E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C",
  "admin.broadcastNew": "\u{1F4E3} \u041D\u043E\u0432\u0430\u044F \u0440\u0430\u0441\u0441\u044B\u043B\u043A\u0430",
  "admin.broadcastCancel": "\u274C \u041E\u0442\u043C\u0435\u043D\u0438\u0442\u044C",
  "admin.broadcastStart": "\u{1F680} \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C",
  "admin.broadcastNoJob": "\u0420\u0430\u0441\u0441\u044B\u043B\u043A\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430.",
  "admin.broadcastRecipients": "\u041F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0435\u0439: <b>{count}</b>",
  "admin.newReport": "\u26A0\uFE0F <b>\u041D\u043E\u0432\u0430\u044F \u0436\u0430\u043B\u043E\u0431\u0430 #{id}</b>\n\u042F\u0449\u0438\u043A: {owner}\n\u0422\u0438\u043F: {kind}\n\u041F\u0441\u0435\u0432\u0434\u043E\u043D\u0438\u043C: <code>{alias}</code>\n<blockquote>{preview}</blockquote>",
  "admin.reportBanned": "\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044C \u0437\u0430\u0431\u0430\u043D\u0435\u043D \u043F\u043E \u0436\u0430\u043B\u043E\u0431\u0435 #{id}.",
  "admin.reportDismissed": "\u0416\u0430\u043B\u043E\u0431\u0430 #{id} \u043E\u0442\u043A\u043B\u043E\u043D\u0435\u043D\u0430.",
  "admin.reportGone": "\u0416\u0430\u043B\u043E\u0431\u0430 \u0443\u0436\u0435 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D\u0430.",
  "admin.banDone": "\u0417\u0430\u0431\u0430\u043D\u0435\u043D.",
  "admin.unbanDone": "\u0420\u0430\u0437\u0431\u0430\u043D\u0435\u043D.",
  "admin.csvCaption": "\u{1F4CA} \u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430 \u0431\u043E\u0442\u0430 \u043D\u0430 {date}",
  "admin.csvSent": "CSV \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D \u0432 \u0447\u0430\u0442.",
  "admin.csvError": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0431\u0440\u0430\u0442\u044C CSV.",
  "admin.answer.saved": "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E.",
  // ----------------------------------------------------------------- digest
  "digest.title": "\u{1F4EC} <b>\u0414\u0430\u0439\u0434\u0436\u0435\u0441\u0442 \u0437\u0430 {date}</b>",
  "digest.body": "\u{1F4E8} \u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439: <b>{messages}</b>\n\u{1F465} \u041D\u043E\u0432\u044B\u0445 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u0435\u0439: <b>{users}</b>\n\u{1F4AC} \u041E\u0442\u0432\u0435\u0442\u043E\u0432: <b>{replies}</b>\n\u26A0\uFE0F \u041D\u043E\u0432\u044B\u0445 \u0436\u0430\u043B\u043E\u0431: <b>{reports}</b>\n\u{1F6AB} \u0412\u0441\u0435\u0433\u043E \u0431\u0430\u043D\u043E\u0432: <b>{bans}</b>",
  "digest.week": "\u{1F4C8} \u041D\u0435\u0434\u0435\u043B\u044F: <code>{spark}</code>",
  "digest.topKind": "\u{1F3AD} \u0427\u0430\u0449\u0435 \u0432\u0441\u0435\u0433\u043E: {kind}",
  // ------------------------------------------------------------------ kinds
  "kind.text": "\u0422\u0435\u043A\u0441\u0442",
  "kind.photo": "\u0424\u043E\u0442\u043E",
  "kind.video": "\u0412\u0438\u0434\u0435\u043E",
  "kind.animation": "GIF",
  "kind.audio": "\u0410\u0443\u0434\u0438\u043E",
  "kind.voice": "\u0413\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435",
  "kind.document": "\u0424\u0430\u0439\u043B",
  "kind.sticker": "\u0421\u0442\u0438\u043A\u0435\u0440",
  "kind.video_note": "\u041A\u0440\u0443\u0436\u043E\u043A",
  "kind.poll": "\u041E\u043F\u0440\u043E\u0441",
  "kind.other": "\u0414\u0440\u0443\u0433\u043E\u0435"
};
var en = {
  "btn.link": "\u{1F517} My link",
  "btn.share": "\u{1F4E4} Share",
  "btn.stats": "\u{1F4CA} Stats",
  "btn.settings": "\u2699\uFE0F Settings",
  "btn.help": "\u2753 Help",
  "btn.back": "\u2039 Back",
  "btn.close": "\u2716\uFE0F Close",
  "btn.refresh": "\u{1F504} Refresh",
  "btn.acceptOn": "\u{1F7E2} Inbox: on",
  "btn.acceptOff": "\u{1F534} Inbox: off",
  "btn.mediaOn": "\u{1F5BC} Media: on",
  "btn.mediaOff": "\u{1F5BC} Media: off",
  "btn.linksOn": "\u{1F517} Links: on",
  "btn.linksOff": "\u{1F517} Links: off",
  "btn.reactionsOn": "\u2728 Reactions: on",
  "btn.reactionsOff": "\u2728 Reactions: off",
  "btn.blocks": "\u{1F6AB} Blocklist",
  "btn.clearBlocks": "\u267B\uFE0F Unblock everyone",
  "btn.reply": "\u{1F4AC} Reply",
  "btn.block": "\u{1F6AB} Block",
  "btn.report": "\u26A0\uFE0F Report",
  "btn.continue": "\u21A9\uFE0F Continue chat",
  "btn.langRu": "\u{1F1F7}\u{1F1FA} \u0420\u0443\u0441\u0441\u043A\u0438\u0439",
  "btn.langEn": "\u{1F1EC}\u{1F1E7} English",
  "btn.cancel": "\u2716\uFE0F Cancel",
  "on": "\u2705 on",
  "off": "\u{1F6AB} off",
  "menu.title": "\u{1F44B} <b>Hi, {name}!</b>\n\nThis is an anonymous message bot. Your personal inbox is ready.\n\n\u{1F517} <code>{link}</code>\n\nShare the link to receive anonymous messages. The sender stays unknown. You can reply anonymously, react and block spammers.",
  "menu.hint": "Pick an action:",
  "menu.link": "\u{1F517} <b>Your link</b>\n\n<code>{link}</code>\n\nPut it in your bio, stories or a chat. Anyone who opens it can write to you anonymously.\n\n\u{1F4A1} The more visible the link, the more messages you get.",
  "menu.shareText": "Message me anonymously \u{1F447}",
  "menu.stats": "\u{1F4CA} <b>Your inbox</b>\n\n\u{1F4E8} Received: <b>{total}</b>\n\u{1F195} Last 7 days: <b>{week}</b>\n\u{1F4AC} Replies: <b>{replies}</b>\n\u{1F6AB} Blocked: <b>{blocked}</b>\n\n{status}",
  "menu.statusOn": "\u{1F7E2} Inbox is open",
  "menu.statusOff": "\u{1F534} Inbox is paused",
  "menu.settings": "\u2699\uFE0F <b>Inbox settings</b>\n\nAccept messages: {accept}\nMedia: {media}\nLinks: {links}\nReaction notifications: {reactions}\n\nTap a button to toggle.",
  "menu.blocks": "\u{1F6AB} <b>Blocklist</b>\n\nBlocked senders: <b>{count}</b>\n\nOnly irreversible hashes are stored \u2014 you will never know who they are.",
  "menu.help": "\u2753 <b>How it works</b>\n\n1. Share your link.\n2. People write to you anonymously.\n3. You can reply, react, block the sender or report them.\n\n<b>Commands</b>\n/link \u2014 my link\n/stats \u2014 stats\n/settings \u2014 settings\n/pause \u2014 stop receiving\n/resume \u2014 start receiving\n/lang \u2014 language\n/privacy \u2014 privacy\n/cancel \u2014 cancel\n\n<b>For admin</b>\n/admin \u2014 control panel",
  "menu.privacy": "\u{1F575}\uFE0F <b>Privacy</b>\n\nNeither you nor the admin can see the sender.\n\n<b>What is stored</b>\n\u2022 message preview \u2014 up to {days} days;\n\u2022 irreversible sender hash \u2014 for anti-spam, blocks and bans;\n\u2022 encrypted reply reference \u2014 deleted after a reply or in {replyDays} days.\n\nThe admin sees aggregate stats only. A report gives them the text and a short hash, never a name.\n\n\u26A0\uFE0F The bot owner controls the server and secrets, so perfect anonymity from them is technically impossible. But the admin panel never shows the sender and has no command to reveal them.",
  "menu.maintenance": "\u{1F6E0} The bot is under maintenance. Please come back later.",
  "menu.cancelled": "Cancelled.",
  "menu.unknownCommand": "Unknown command. Try /help.",
  "send.noTarget": "\u{1F48C} To write anonymously, open someone\u2019s inbox link.\n\nYour own link: /link",
  "send.sent": "\u2705 Sent anonymously. The recipient will not know who you are.",
  "send.sentNamed": "\u2705 Sent anonymously to {name}\u2019s inbox.",
  "send.self": "\u{1F605} You cannot message your own inbox.",
  "send.closed": "\u{1F634} This inbox is not accepting messages right now. Try later.",
  "send.blocked": "\u{1F6AB} The recipient has blocked you.",
  "send.banned": "\u26D4\uFE0F You cannot send messages.",
  "send.mediaOff": "\u{1F5BC} This inbox accepts text only.",
  "send.linksOff": "\u{1F517} Links are not allowed in this inbox.",
  "send.tooLong": "\u2702\uFE0F Too long: max {max} characters.",
  "send.unsupported": "\u{1F937} This message type is not supported. Send text, a photo, video, voice or file.",
  "send.empty": "\u270D\uFE0F Write something or attach media.",
  "send.rate": "\u23F3 Too fast. Wait {sec} sec.",
  "send.duplicate": "\u{1F9D0} You sent this recently. Try different text.",
  "send.failed": "\u{1F614} Delivery failed. The recipient may have blocked the bot.",
  "send.replyPrompt": "\u{1F4AC} <b>Reply to message #{id}</b>\n\nWrite a reply \u2014 it will be delivered anonymously. Media is fine too.\n\n/cancel \u2014 cancel",
  "send.replySent": "\u2705 Reply sent anonymously.",
  "send.replyExpired": "\u231B\uFE0F This reply is no longer available: it expired or was already answered.",
  "send.replyFailed": "\u{1F614} Could not deliver the reply. The sender may have blocked the bot.",
  "send.replyHeader": "\u{1F4AC} <b>Anonymous reply</b>",
  "send.reactionSent": "Reaction sent anonymously.",
  "send.reactionAlready": "You already sent this reaction.",
  "send.reactionNotify": "\u2728 Your anonymous message received a reaction: {emoji}",
  "send.reportSent": "\u26A0\uFE0F Report sent to the admin, the sender is blocked. Thank you!",
  "send.reportAlready": "Already reported.",
  "send.blockedUser": "\u{1F6AB} Sender blocked. They will not be able to message you again.",
  "send.unblockedAll": "\u267B\uFE0F Blocklist cleared.",
  "send.continueSet": "\u21A9\uFE0F Your messages now go to {name}\u2019s inbox.",
  "send.targetGone": "This inbox no longer exists.",
  "send.inboxIntro": "\u{1F48C} <b>Anonymous inbox</b>\n\n{name}\n\nWrite a message \u2014 the recipient will not know who you are.",
  "send.badLink": "\u{1F517} This link is invalid or outdated.",
  "send.ownLink": "\u{1F605} This is your own inbox. Share the link with a friend!",
  "send.langChanged": "Language switched.",
  "send.paused": "\u23F8 Inbox paused. Turn it back on with /resume",
  "send.resumed": "\u25B6\uFE0F Inbox is open again.",
  "send.noRepliesStrict": "Replies are disabled in this inbox.",
  "admin.denied": "\u26D4\uFE0F Admins only.",
  "admin.title": "\u{1F6E1} <b>Admin panel</b>",
  "admin.users": "\u{1F465} Users",
  "admin.messages": "\u{1F4E8} Messages",
  "admin.replies": "\u{1F4AC} Replies",
  "admin.bans": "\u{1F6AB} Bans",
  "admin.reports": "\u26A0\uFE0F Reports",
  "admin.activeInboxes": "\u{1F4E5} Active inboxes",
  "admin.today": "today",
  "admin.week": "7 days",
  "admin.last7": "\u{1F4C8} 7 days",
  "admin.updated": "\u{1F552} Updated",
  "admin.overview": "\u{1F6E1} <b>Admin panel</b>\n\n\u{1F465} Users: <b>{users}</b> (+{usersToday} today, +{users7} in 7d)\n\u{1F4E8} Messages: <b>{messages}</b> (+{messagesToday} today, +{messages7} in 7d)\n\u{1F4AC} Replies: <b>{replies}</b> ({replyRate}%)\n\u{1F6AB} Bans: <b>{bans}</b> \xB7 \u26A0\uFE0F New reports: <b>{reportsNew}</b>\n\u{1F4E5} Active inboxes: <b>{activeInboxes}</b>\n\n\u{1F4C8} 7 days: <code>{spark}</code>  (max {max}/day)\n\u{1F6E0} Maintenance: {maint} \xB7 \u{1F575}\uFE0F Strict anonymity: {strict}\n\u{1F552} Updated: {updated}",
  "admin.btn.overview": "\u{1F4CA} Overview",
  "admin.btn.dynamics": "\u{1F4C8} Dynamics",
  "admin.btn.kinds": "\u{1F3AD} Types",
  "admin.btn.top": "\u{1F3C6} Top inboxes",
  "admin.btn.reports": "\u26A0\uFE0F Reports ({n})",
  "admin.btn.bans": "\u{1F6AB} Bans",
  "admin.btn.broadcast": "\u{1F4E3} Broadcast",
  "admin.btn.csv": "\u{1F4E4} CSV",
  "admin.btn.settings": "\u2699\uFE0F Settings",
  "admin.btn.refresh": "\u{1F504} Refresh",
  "admin.btn.back": "\u2039 Back",
  "admin.dynamicsTitle": "\u{1F4C8} <b>Dynamics, last {days} days</b>",
  "admin.dynamicsTotals": "\u{1F4E8} Messages: <b>{messages}</b>\n\u{1F465} New users: <b>{users}</b>\n\u{1F4AC} Replies: <b>{replies}</b>\n\u{1F4CA} Average: <b>{avg}</b>/day\n\n<code>{spark}</code>\n{peak}",
  "admin.peak": "\u{1F552} Peak (UTC): {from}:00\u2013{to}:00 ({count})",
  "admin.dayLine": "{date} \xB7 <b>{count}</b>",
  "admin.kindsTitle": "\u{1F3AD} <b>Message types, last 30 days</b>",
  "admin.kindLine": "{emoji} {label} \u2014 <b>{count}</b> ({percent}%)",
  "admin.kindsEmpty": "No data yet.",
  "admin.topTitle": "\u{1F3C6} <b>Top inboxes, last 30 days</b>",
  "admin.topLine": "{rank}. {name} \u2014 <b>{count}</b>",
  "admin.topEmpty": "No data yet.",
  "admin.reportsTitle": "\u26A0\uFE0F <b>Reports</b>",
  "admin.reportsEmpty": "No new reports. All quiet \u2728",
  "admin.reportsPage": "Page {page} of {pages}",
  "admin.reportItem": "\u26A0\uFE0F <b>#{id}</b> \xB7 {kind}\nInbox: {owner}\nAlias: <code>{alias}</code> \xB7 {date}\n<blockquote>{preview}</blockquote>",
  "admin.reportItemNoPreview": "\u26A0\uFE0F <b>#{id}</b> \xB7 {kind}\nInbox: {owner}\nAlias: <code>{alias}</code> \xB7 {date}\n<i>no text</i>",
  "admin.reportHint": "Buttons below: ban or dismiss. The sender\u2019s identity is unknown \u2014 only an irreversible alias.",
  "admin.bansTitle": "\u{1F6AB} <b>Bans</b>",
  "admin.bansTotal": "Total: <b>{count}</b>",
  "admin.bansEmpty": "No bans.",
  "admin.bansHint": "Aliases are irreversible \u2014 they cannot reveal a person.",
  "admin.banItem": "<code>{key}</code> \xB7 {date}",
  "admin.unban": "\u2705 Unban",
  "admin.ban": "\u{1F6AB} Ban",
  "admin.dismiss": "\u2705 Dismiss",
  "admin.settingsTitle": "\u2699\uFE0F <b>Settings</b>",
  "admin.setMaintenance": "\u{1F6E0} Maintenance: {state}",
  "admin.setStrict": "\u{1F575}\uFE0F Strict anonymity: {state}",
  "admin.setDigest": "\u{1F514} Digest: {state}",
  "admin.setDigestHour": "\u{1F552} Digest is sent at {hour}:00 UTC",
  "admin.setStrictHint": "In strict mode replies and reactions are disabled: the bot does not store even an encrypted sender reference. Blocks and reports still work.",
  "admin.setStorage": "\u{1F5D1} Message previews are kept for {days} days, reply keys for {replyDays} days.",
  "admin.setMaintenanceHint": "In maintenance mode only admins get responses.",
  "admin.btn.maintOn": "\u{1F6E0} Maintenance: on",
  "admin.btn.maintOff": "\u{1F6E0} Maintenance: off",
  "admin.btn.strictOn": "\u{1F575}\uFE0F Strict anonymity: on",
  "admin.btn.strictOff": "\u{1F575}\uFE0F Strict anonymity: off",
  "admin.btn.digestOn": "\u{1F514} Digest: on",
  "admin.btn.digestOff": "\u{1F514} Digest: off",
  "admin.broadcastTitle": "\u{1F4E3} <b>Broadcast</b>",
  "admin.broadcastIdle": "No active broadcast.\nRecipients: <b>{recipients}</b>.",
  "admin.broadcastPrompt": "Send the message to broadcast (text, photo, video, etc.).\n\nIt will be delivered by the bot to every user. /cancel \u2014 cancel.",
  "admin.broadcastConfirm": "\u{1F4E3} <b>Check the broadcast</b>\n\n{content}\n\nRecipients: <b>{recipients}</b>.\nSend it?",
  "admin.broadcastStarted": "\u23F3 Broadcast started. Progress: {sent} / {total}.",
  "admin.broadcastProgress": "\u23F3 Broadcast: {sent} / {total} (failed: {failed})",
  "admin.broadcastDone": "\u2705 Broadcast finished.\nSent: <b>{sent}</b>\nFailed: <b>{failed}</b>",
  "admin.broadcastStopped": "\u23F9 Broadcast stopped.\nSent: <b>{sent}</b>\nFailed: <b>{failed}</b>",
  "admin.broadcastAlready": "Broadcast #{id} is already running. Wait for it or stop it.",
  "admin.broadcastContentText": "Text: {preview}",
  "admin.broadcastContentMedia": "Media: {kind}",
  "admin.broadcastStop": "\u23F9 Stop",
  "admin.broadcastNew": "\u{1F4E3} New broadcast",
  "admin.broadcastCancel": "\u274C Cancel",
  "admin.broadcastStart": "\u{1F680} Send",
  "admin.broadcastNoJob": "Broadcast not found.",
  "admin.broadcastRecipients": "Recipients: <b>{count}</b>",
  "admin.newReport": "\u26A0\uFE0F <b>New report #{id}</b>\nInbox: {owner}\nType: {kind}\nAlias: <code>{alias}</code>\n<blockquote>{preview}</blockquote>",
  "admin.reportBanned": "Sender banned for report #{id}.",
  "admin.reportDismissed": "Report #{id} dismissed.",
  "admin.reportGone": "This report is already handled.",
  "admin.banDone": "Banned.",
  "admin.unbanDone": "Unbanned.",
  "admin.csvCaption": "\u{1F4CA} Bot stats for {date}",
  "admin.csvSent": "CSV sent to this chat.",
  "admin.csvError": "Could not build the CSV.",
  "admin.answer.saved": "Saved.",
  "digest.title": "\u{1F4EC} <b>Digest for {date}</b>",
  "digest.body": "\u{1F4E8} Messages: <b>{messages}</b>\n\u{1F465} New users: <b>{users}</b>\n\u{1F4AC} Replies: <b>{replies}</b>\n\u26A0\uFE0F New reports: <b>{reports}</b>\n\u{1F6AB} Total bans: <b>{bans}</b>",
  "digest.week": "\u{1F4C8} Week: <code>{spark}</code>",
  "digest.topKind": "\u{1F3AD} Most common: {kind}",
  "kind.text": "Text",
  "kind.photo": "Photo",
  "kind.video": "Video",
  "kind.animation": "GIF",
  "kind.audio": "Audio",
  "kind.voice": "Voice",
  "kind.document": "File",
  "kind.sticker": "Sticker",
  "kind.video_note": "Video note",
  "kind.poll": "Poll",
  "kind.other": "Other"
};
var dictionary = { ru, en };
function normalizeLang(code) {
  if (!code) return "ru";
  const lower = code.toLowerCase();
  if (["ru", "uk", "be", "kk", "uz", "ky", "tg", "hy", "az", "ka", "mo"].some((prefix) => lower.startsWith(prefix))) {
    return "ru";
  }
  return "en";
}
function t(lang, key, vars) {
  const template = dictionary[lang][key] ?? dictionary.ru[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = vars[name];
    return value === void 0 ? match : String(value);
  });
}
function kindLabel(lang, kind) {
  const key = `kind.${kind}`;
  return dictionary[lang][key] ?? dictionary.ru[key] ?? kind;
}

// src/db.ts
var DEFAULT_SETTINGS = {
  maintenance: false,
  strictAnon: false,
  digest: true,
  lastDigestDate: ""
};
var SETTINGS_TTL_MS = 1e4;
var settingsCache = /* @__PURE__ */ new WeakMap();
function parseSettings(rows) {
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
    maintenance: map.get("maintenance") === "1",
    strictAnon: map.get("strict_anon") === "1",
    digest: map.get("digest") !== "0",
    lastDigestDate: map.get("last_digest_date") ?? DEFAULT_SETTINGS.lastDigestDate
  };
}
async function getSettings(db, nowMs = Date.now()) {
  const cached = settingsCache.get(db);
  if (cached && nowMs - cached.at < SETTINGS_TTL_MS) return cached.values;
  const result = await db.prepare("SELECT key, value FROM settings").all();
  const values = parseSettings(result.results ?? []);
  settingsCache.set(db, { at: nowMs, values });
  return values;
}
async function setSetting(db, key, value) {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
  settingsCache.delete(db);
}
async function claimDigestDate(db, date) {
  const result = await db.prepare(
    "INSERT INTO settings (key, value) VALUES ('last_digest_date', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value <> excluded.value"
  ).bind(date).run();
  settingsCache.delete(db);
  return Boolean(result.meta.changes);
}
async function getUser(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}
async function getUserByToken(db, token) {
  return db.prepare("SELECT * FROM users WHERE inbox_token = ?").bind(token).first();
}
function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error));
}
async function touchUser(db, from, now) {
  const existing = await getUser(db, from.id);
  const username = from.username ?? null;
  const firstName = from.first_name ?? null;
  if (existing) {
    if (now - existing.last_seen_at > 300 || existing.username !== username || existing.first_name !== firstName) {
      await db.prepare("UPDATE users SET username = ?, first_name = ?, last_seen_at = ? WHERE id = ?").bind(username, firstName, now, from.id).run();
      return { ...existing, username, first_name: firstName, last_seen_at: now };
    }
    return existing;
  }
  const initialLang = normalizeLang(from.language_code);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await db.prepare(
        "INSERT INTO users (id, username, first_name, lang, inbox_token, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(from.id, username, firstName, initialLang, randomToken(16), now, now).run();
      const created = await getUser(db, from.id);
      if (created) return created;
      throw new Error("user row was not created");
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 4) throw error;
    }
  }
  throw new Error("failed to create user");
}
var MUTABLE_FLAGS = /* @__PURE__ */ new Set(["accept_messages", "allow_media", "allow_links", "notify_reactions", "lang"]);
async function setUserFlag(db, userId, column, value) {
  if (!MUTABLE_FLAGS.has(column)) throw new Error("column is not mutable");
  await db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).bind(value, userId).run();
}
async function setTarget(db, userId, targetId, now) {
  await db.prepare("UPDATE users SET target_id = ?, target_at = ? WHERE id = ?").bind(targetId, now, userId).run();
}
var TARGET_TTL_SECONDS = 24 * 60 * 60;
function freshTargetId(user, now) {
  if (!user.target_id || !user.target_at) return null;
  if (now - user.target_at > TARGET_TTL_SECONDS) return null;
  return user.target_id;
}
async function getSession(db, userId) {
  return db.prepare("SELECT * FROM sessions WHERE user_id = ?").bind(userId).first();
}
async function setSession(db, userId, state2, data, now) {
  await db.prepare(
    "INSERT INTO sessions (user_id, state, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at"
  ).bind(userId, state2, data, now).run();
}
async function clearSession(db, userId) {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}
async function countUserMessages(db, userId, since = 0) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND created_at >= ?").bind(userId, since).first();
  return Number(row?.n ?? 0);
}
async function countUserReplies(db, userId) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND replied_at IS NOT NULL").bind(userId).first();
  return Number(row?.n ?? 0);
}
async function insertMessage(db, input) {
  const result = await db.prepare(
    "INSERT INTO messages (recipient_id, sender_key, kind, content_preview, content_hash, has_link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(input.recipientId, input.senderKey, input.kind, input.preview, input.contentHash, input.hasLink ? 1 : 0, input.now).run();
  const id = Number(result.meta.last_row_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("failed to insert message");
  return id;
}
async function attachDeliveredMessage(db, messageId, deliveredMessageId) {
  await db.prepare("UPDATE messages SET delivered_message_id = ? WHERE id = ?").bind(deliveredMessageId, messageId).run();
}
async function deleteMessageRow(db, messageId) {
  await db.prepare("DELETE FROM messages WHERE id = ?").bind(messageId).run();
}
async function markMessageReplied(db, messageId, now) {
  await db.prepare("UPDATE messages SET replied_at = ? WHERE id = ?").bind(now, messageId).run();
}
async function getMessage(db, messageId) {
  return db.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId).first();
}
async function getMessageByDeliveredId(db, recipientId, deliveredMessageId) {
  return db.prepare("SELECT * FROM messages WHERE recipient_id = ? AND delivered_message_id = ?").bind(recipientId, deliveredMessageId).first();
}
async function countRecentDuplicates(db, recipientId, contentHash, since) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND content_hash = ? AND created_at >= ?").bind(recipientId, contentHash, since).first();
  return Number(row?.n ?? 0);
}
async function insertReplyKey(db, messageId, ref, now, ttlDays) {
  await db.prepare("INSERT OR REPLACE INTO reply_keys (message_id, ref, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(messageId, ref, now, now + ttlDays * 86400).run();
}
async function getReplyKey(db, messageId) {
  return db.prepare("SELECT * FROM reply_keys WHERE message_id = ?").bind(messageId).first();
}
async function deleteReplyKey(db, messageId) {
  await db.prepare("DELETE FROM reply_keys WHERE message_id = ?").bind(messageId).run();
}
async function purgeReplyKeys(db) {
  await db.prepare("DELETE FROM reply_keys").run();
}
async function revokeReplyKeysForSenderInInbox(db, ownerId, key) {
  await db.prepare(
    "DELETE FROM reply_keys WHERE message_id IN (SELECT id FROM messages WHERE recipient_id = ? AND sender_key = ?)"
  ).bind(ownerId, key).run();
}
async function revokeReplyKeysForSender(db, key) {
  await db.prepare("DELETE FROM reply_keys WHERE message_id IN (SELECT id FROM messages WHERE sender_key = ?)").bind(key).run();
}
async function isSenderBlocked(db, ownerId, key) {
  const row = await db.prepare("SELECT 1 AS n FROM blocks WHERE owner_id = ? AND sender_key = ?").bind(ownerId, key).first();
  return Boolean(row?.n);
}
async function blockSender(db, ownerId, key, now) {
  await db.prepare("INSERT OR IGNORE INTO blocks (owner_id, sender_key, created_at) VALUES (?, ?, ?)").bind(ownerId, key, now).run();
}
async function countBlocks(db, ownerId) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM blocks WHERE owner_id = ?").bind(ownerId).first();
  return Number(row?.n ?? 0);
}
async function clearBlocks(db, ownerId) {
  await db.prepare("DELETE FROM blocks WHERE owner_id = ?").bind(ownerId).run();
}
async function isSenderBanned(db, key, now) {
  const row = await db.prepare("SELECT 1 AS n FROM bans WHERE sender_key = ? AND (expires_at IS NULL OR expires_at > ?)").bind(key, now).first();
  return Boolean(row?.n);
}
async function banSender(db, key, reason, now) {
  await db.prepare(
    "INSERT INTO bans (sender_key, reason, created_at, expires_at) VALUES (?, ?, ?, NULL) ON CONFLICT(sender_key) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at, expires_at = NULL"
  ).bind(key, reason, now).run();
}
async function unbanSender(db, key) {
  await db.prepare("DELETE FROM bans WHERE sender_key = ?").bind(key).run();
}
async function countBans(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM bans").first();
  return Number(row?.n ?? 0);
}
async function listBans(db, limit = 10) {
  const result = await db.prepare("SELECT * FROM bans ORDER BY created_at DESC LIMIT ?").bind(limit).all();
  return result.results ?? [];
}
async function consumeRate(db, key, now, limits) {
  const minute = Math.floor(now / 60);
  const hour = Math.floor(now / 3600);
  const day = Math.floor(now / 86400);
  const row = await db.prepare("SELECT * FROM rate_limits WHERE sender_key = ?").bind(key).first();
  let minuteCount = 0;
  let hourCount = 0;
  let dayCount = 0;
  let lastAt = 0;
  if (row) {
    minuteCount = row.minute_start === minute ? row.minute_count : 0;
    hourCount = row.hour_start === hour ? row.hour_count : 0;
    dayCount = row.day_start === day ? row.day_count : 0;
    lastAt = row.last_at;
  }
  if (lastAt > 0 && now - lastAt < limits.minInterval) {
    return { allowed: false, retryAfter: Math.max(1, limits.minInterval - (now - lastAt)) };
  }
  if (minuteCount >= limits.perMin) return { allowed: false, retryAfter: 60 - now % 60 };
  if (hourCount >= limits.perHour) return { allowed: false, retryAfter: 3600 - now % 3600 };
  if (dayCount >= limits.perDay) return { allowed: false, retryAfter: 86400 - now % 86400 };
  await db.prepare(
    `INSERT INTO rate_limits (sender_key, minute_start, minute_count, hour_start, hour_count, day_start, day_count, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sender_key) DO UPDATE SET
         minute_start = excluded.minute_start, minute_count = excluded.minute_count,
         hour_start = excluded.hour_start, hour_count = excluded.hour_count,
         day_start = excluded.day_start, day_count = excluded.day_count,
         last_at = excluded.last_at`
  ).bind(key, minute, minuteCount + 1, hour, hourCount + 1, day, dayCount + 1, now).run();
  return { allowed: true, retryAfter: 0 };
}
async function createReport(db, input) {
  const result = await db.prepare(
    `INSERT INTO reports (message_id, recipient_id, sender_key, kind, content_preview, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'new', ?)
       ON CONFLICT(message_id) DO NOTHING`
  ).bind(input.messageId, input.recipientId, input.senderKey, input.kind, input.preview, input.now).run();
  if (!result.meta.changes) return null;
  const id = Number(result.meta.last_row_id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
async function getReport(db, reportId) {
  return db.prepare("SELECT * FROM reports WHERE id = ?").bind(reportId).first();
}
async function setReportStatus(db, reportId, status, now) {
  await db.prepare("UPDATE reports SET status = ?, reviewed_at = ? WHERE id = ?").bind(status, now, reportId).run();
}
async function countNewReports(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'new'").first();
  return Number(row?.n ?? 0);
}
async function listNewReports(db, limit = 5, offset = 0) {
  const result = await db.prepare(
    `SELECT r.*, u.username AS owner_username, u.first_name AS owner_first_name
       FROM reports r LEFT JOIN users u ON u.id = r.recipient_id
       WHERE r.status = 'new' ORDER BY r.id DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();
  return result.results ?? [];
}
async function recordReaction(db, messageId, emoji, now) {
  const result = await db.prepare("INSERT OR IGNORE INTO reaction_events (message_id, emoji, created_at) VALUES (?, ?, ?)").bind(messageId, emoji, now).run();
  return Boolean(result.meta.changes);
}
async function createBroadcastJob(db, input) {
  await db.prepare("DELETE FROM broadcast_jobs WHERE admin_id = ? AND status = 'draft'").bind(input.adminId).run();
  const result = await db.prepare(
    `INSERT INTO broadcast_jobs (admin_id, from_chat_id, message_id, status, worker_url, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?)`
  ).bind(input.adminId, input.fromChatId, input.messageId, input.workerUrl, input.now, input.now).run();
  return Number(result.meta.last_row_id);
}
async function getBroadcastJob(db, jobId) {
  return db.prepare("SELECT * FROM broadcast_jobs WHERE id = ?").bind(jobId).first();
}
async function getActiveBroadcast(db) {
  return db.prepare("SELECT * FROM broadcast_jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1").first();
}
async function startBroadcastJob(db, jobId, now) {
  const result = await db.prepare(
    `UPDATE broadcast_jobs
       SET status = 'running', updated_at = ?
       WHERE id = ? AND status = 'draft'
         AND NOT EXISTS (SELECT 1 FROM broadcast_jobs WHERE status = 'running')`
  ).bind(now, jobId).run();
  return Boolean(result.meta.changes);
}
async function getLatestBroadcast(db) {
  return db.prepare("SELECT * FROM broadcast_jobs ORDER BY id DESC LIMIT 1").first();
}
async function deleteBroadcastJob(db, jobId) {
  await db.prepare("DELETE FROM broadcast_jobs WHERE id = ? AND status = 'draft'").bind(jobId).run();
}
async function setBroadcastStatus(db, jobId, status, now) {
  await db.prepare("UPDATE broadcast_jobs SET status = ?, updated_at = ? WHERE id = ?").bind(status, now, jobId).run();
}
async function completeBroadcast(db, jobId, now) {
  const result = await db.prepare("UPDATE broadcast_jobs SET status = 'done', locked_until = 0, updated_at = ? WHERE id = ? AND status = 'running'").bind(now, jobId).run();
  return Boolean(result.meta.changes);
}
async function setBroadcastProgressTarget(db, jobId, chatId, messageId, now) {
  await db.prepare("UPDATE broadcast_jobs SET progress_chat_id = ?, progress_message_id = ?, updated_at = ? WHERE id = ?").bind(chatId, messageId, now, jobId).run();
}
async function setBroadcastProgress(db, jobId, progress) {
  await db.prepare(
    "UPDATE broadcast_jobs SET sent = ?, failed = ?, last_user_id = ?, attempts = ?, updated_at = ? WHERE id = ?"
  ).bind(progress.sent, progress.failed, progress.lastUserId, progress.attempts, progress.now, jobId).run();
}
async function acquireBroadcastLock(db, jobId, now, ttlSeconds = 120) {
  const result = await db.prepare("UPDATE broadcast_jobs SET locked_until = ? WHERE id = ? AND locked_until < ?").bind(now + ttlSeconds, jobId, now).run();
  return Boolean(result.meta.changes);
}
async function releaseBroadcastLock(db, jobId) {
  await db.prepare("UPDATE broadcast_jobs SET locked_until = 0 WHERE id = ?").bind(jobId).run();
}
async function countBroadcastRecipients(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_blocked = 0").first();
  return Number(row?.n ?? 0);
}
async function nextBroadcastRecipients(db, afterUserId, limit) {
  const result = await db.prepare("SELECT id FROM users WHERE id > ? AND is_blocked = 0 ORDER BY id ASC LIMIT ?").bind(afterUserId, limit).all();
  return (result.results ?? []).map((row) => Number(row.id));
}
async function countUsersAfter(db, afterUserId) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE id > ? AND is_blocked = 0").bind(afterUserId).first();
  return Number(row?.n ?? 0);
}

// src/format.ts
var BARS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];
function escapeHtml(input) {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function truncate(input, max) {
  const text = input.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}
function fmtInt(value) {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
function sparkline(values) {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max <= 0) return BARS[0].repeat(values.length);
  return values.map((value) => {
    if (value <= 0) return BARS[0];
    const index = Math.min(BARS.length - 1, Math.max(0, Math.round(value / max * (BARS.length - 1))));
    return BARS[index];
  }).join("");
}
function shortDay(isoDay2) {
  const [, month, day] = isoDay2.split("-");
  return `${day}.${month}`;
}
function formatDateTime(ts) {
  const date = new Date(ts * 1e3);
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
function formatTime(ts) {
  return new Date(ts * 1e3).toISOString().slice(11, 16);
}
function displayName(username, firstName) {
  if (username) return `@${username}`;
  if (firstName) return firstName;
  return "\u2014";
}
function isoDay(ts) {
  return new Date(ts * 1e3).toISOString().slice(0, 10);
}
function csvEscape(value) {
  let text = String(value);
  if (/^[=+\-]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
function buildCsv(rows) {
  return `\uFEFF${rows.map((row) => row.map(csvEscape).join(",")).join("\r\n")}`;
}

// src/content.ts
var LINK_RE = /(https?:\/\/|t\.me\/|www\.|tg:\/\/)/i;
function detectContent(message) {
  let kind = null;
  if (message.text !== void 0) kind = "text";
  else if (message.photo && message.photo.length > 0) kind = "photo";
  else if (message.video) kind = "video";
  else if (message.animation) kind = "animation";
  else if (message.audio) kind = "audio";
  else if (message.voice) kind = "voice";
  else if (message.document) kind = "document";
  else if (message.sticker) kind = "sticker";
  else if (message.video_note) kind = "video_note";
  else if (message.poll) kind = "poll";
  if (!kind) return null;
  const text = (message.text ?? message.caption ?? "").trim();
  const entities = [...message.entities ?? [], ...message.caption_entities ?? []];
  const hasEntityLink = entities.some((entity) => entity.type === "url" || entity.type === "text_link");
  return { kind, text, hasLink: LINK_RE.test(text) || hasEntityLink };
}
function contentPreview(content) {
  if (content.text) return truncate(content.text, 300);
  return `[${content.kind}]`;
}

// src/env.ts
function intEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
function parseAdminIds(env) {
  return (env.ADMIN_IDS ?? "").split(/[,\s]+/).map((part) => Number(part.trim())).filter((id) => Number.isSafeInteger(id) && id > 0);
}
function isAdmin(env, userId) {
  return parseAdminIds(env).includes(userId);
}
function getLimits(env) {
  return {
    perMin: intEnv(env.LIMIT_PER_MIN, 4),
    perHour: intEnv(env.LIMIT_PER_HOUR, 15),
    perDay: intEnv(env.LIMIT_PER_DAY, 40),
    minInterval: intEnv(env.MIN_INTERVAL_SEC, 3)
  };
}
function replyTtlDays(env) {
  return intEnv(env.REPLY_TTL_DAYS, 7);
}
function contentTtlDays(env) {
  return intEnv(env.CONTENT_TTL_DAYS, 30);
}
function digestHour(env) {
  const raw = Number(env.DAILY_DIGEST_HOUR_UTC);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 9;
}

// src/notify.ts
function logTelegramError(method, error) {
  if (error instanceof TelegramError) {
    if (isIgnorableTelegramError(error)) return;
    console.error(`${method}: ${error.description}`);
    return;
  }
  console.error(`${method}:`, error instanceof Error ? error.message : String(error));
}
async function safeSend(ctx, chatId, text, keyboard) {
  try {
    await ctx.api.sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : {});
    return true;
  } catch (error) {
    logTelegramError("sendMessage", error);
    return false;
  }
}
async function answerCallback(ctx, callbackId, text) {
  try {
    await ctx.api.answerCallbackQuery(callbackId, text);
  } catch (error) {
    logTelegramError("answerCallbackQuery", error);
  }
}
async function editOrSend(ctx, chatId, messageId, text, keyboard) {
  try {
    await ctx.api.editMessageText(chatId, messageId, text, keyboard ? { reply_markup: keyboard } : {});
    return;
  } catch (error) {
    if (error instanceof TelegramError && /message is not modified/i.test(error.description)) return;
    logTelegramError("editMessageText", error);
  }
  await safeSend(ctx, chatId, text, keyboard);
}

// src/broadcast.ts
var BATCH_SIZE = 25;
var MAX_ATTEMPTS = 1e3;
var CHAIN_ATTEMPTS_PER_REPORT = 5;
async function startBroadcastPrompt(ctx, admin) {
  const lang = normalizeLang(admin.lang);
  const active = await getActiveBroadcast(ctx.db);
  if (active) {
    await safeSend(ctx, admin.id, t(lang, "admin.broadcastAlready", { id: String(active.id) }));
    return;
  }
  await setSession(ctx.db, admin.id, "bc", null, ctx.now);
  await safeSend(ctx, admin.id, t(lang, "admin.broadcastPrompt"), {
    inline_keyboard: [[{ text: t(lang, "btn.cancel"), callback_data: "a:bc:cancel" }]]
  });
}
async function receiveBroadcastContent(ctx, admin, message) {
  if (!isAdmin(ctx.env, admin.id)) return;
  const lang = normalizeLang(admin.lang);
  const content = detectContent(message);
  if (!content) {
    await safeSend(ctx, admin.id, t(lang, "send.unsupported"));
    return;
  }
  const active = await getActiveBroadcast(ctx.db);
  if (active) {
    await clearSession(ctx.db, admin.id);
    await safeSend(ctx, admin.id, t(lang, "admin.broadcastAlready", { id: String(active.id) }));
    return;
  }
  const jobId = await createBroadcastJob(ctx.db, {
    adminId: admin.id,
    fromChatId: message.chat.id,
    messageId: message.message_id,
    workerUrl: ctx.origin || null,
    now: ctx.now
  });
  await clearSession(ctx.db, admin.id);
  const total = await countBroadcastRecipients(ctx.db);
  const preview = content.text ? truncate(content.text, 300) : "";
  const description = [
    content.kind !== "text" ? t(lang, "admin.broadcastContentMedia", { kind: kindLabel(lang, content.kind) }) : "",
    preview ? t(lang, "admin.broadcastContentText", { preview: escapeHtml(preview) }) : ""
  ].filter(Boolean).join("\n");
  const keyboard = {
    inline_keyboard: [
      [
        { text: t(lang, "admin.broadcastStart"), callback_data: `a:bc:go:${jobId}` },
        { text: t(lang, "admin.broadcastCancel"), callback_data: `a:bc:del:${jobId}` }
      ]
    ]
  };
  await safeSend(
    ctx,
    admin.id,
    t(lang, "admin.broadcastConfirm", {
      content: description || t(lang, "admin.broadcastContentMedia", { kind: kindLabel(lang, content.kind) }),
      recipients: fmtInt(total)
    }),
    keyboard
  );
}
function scheduleChain(ctx, job) {
  if (!job.worker_url) return;
  const url = `${job.worker_url.replace(/\/$/, "")}/__internal/broadcast`;
  ctx.waitUntil(
    (async () => {
      const token = await hmacHex(ctx.env.BOT_SECRET, "internal-broadcast-v1");
      const response = await fetch(url, {
        method: "POST",
        headers: { "x-internal-token": token }
      });
      await response.text();
    })().catch((error) => {
      console.error("broadcast chain failed", error instanceof Error ? error.message : String(error));
    })
  );
}
async function progressText(ctx, job, sent, failed, adminLang) {
  const total = await countBroadcastRecipients(ctx.db);
  return t(normalizeLang(adminLang), "admin.broadcastProgress", {
    sent: fmtInt(sent),
    total: fmtInt(total),
    failed: fmtInt(failed)
  });
}
async function finishDone(ctx, job, sent, failed, now) {
  const changed = await completeBroadcast(ctx.db, job.id, now);
  if (!changed) return;
  const admin = await getUser(ctx.db, job.admin_id);
  const lang = normalizeLang(admin?.lang);
  const text = t(lang, "admin.broadcastDone", { sent: fmtInt(sent), failed: fmtInt(failed) });
  if (job.progress_chat_id && job.progress_message_id) {
    await editOrSend(ctx, job.progress_chat_id, job.progress_message_id, text);
  } else {
    await safeSend(ctx, job.admin_id, text);
  }
}
async function drainBroadcast(ctx) {
  const job = await getActiveBroadcast(ctx.db);
  if (!job) return;
  const now = Math.floor(Date.now() / 1e3);
  if (job.attempts >= MAX_ATTEMPTS) {
    await setBroadcastStatus(ctx.db, job.id, "stopped", now);
    const admin = await getUser(ctx.db, job.admin_id);
    const lang = normalizeLang(admin?.lang);
    await safeSend(
      ctx,
      job.admin_id,
      t(lang, "admin.broadcastStopped", { sent: fmtInt(job.sent), failed: fmtInt(job.failed) })
    );
    return;
  }
  if (!await acquireBroadcastLock(ctx.db, job.id, now)) return;
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
          message_id: job.message_id
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
        logTelegramError("broadcast copyMessage", error);
      }
    }
    const attempts = job.attempts + 1;
    await setBroadcastProgress(ctx.db, job.id, { sent, failed, lastUserId, attempts, now });
    const fresh = await getBroadcastJob(ctx.db, job.id);
    if (!fresh || fresh.status !== "running") return;
    const remaining = await countUsersAfter(ctx.db, lastUserId);
    if (remaining === 0) {
      await finishDone(ctx, job, sent, failed, now);
      return;
    }
    if (rateLimited) return;
    if (attempts % CHAIN_ATTEMPTS_PER_REPORT === 0 && job.progress_chat_id && job.progress_message_id) {
      const admin = await getUser(ctx.db, job.admin_id);
      const text = await progressText(ctx, job, sent, failed, admin?.lang ?? "ru");
      await editOrSend(ctx, job.progress_chat_id, job.progress_message_id, text);
    }
    shouldChain = Boolean(job.worker_url);
  } finally {
    await releaseBroadcastLock(ctx.db, job.id);
  }
  if (shouldChain) scheduleChain(ctx, job);
}
async function stopBroadcast(ctx, query, jobId) {
  const job = await getBroadcastJob(ctx.db, jobId);
  const admin = await getUser(ctx.db, query.from.id);
  const lang = normalizeLang(admin?.lang);
  if (!job) {
    await answerCallback(ctx, query.id, t(lang, "admin.broadcastNoJob"));
    return;
  }
  if (job.status !== "running") {
    await answerCallback(ctx, query.id, t(lang, "admin.broadcastNoJob"));
    return;
  }
  await setBroadcastStatus(ctx.db, job.id, "stopped", ctx.now);
  const text = t(lang, "admin.broadcastStopped", { sent: fmtInt(job.sent), failed: fmtInt(job.failed) });
  if (job.progress_chat_id && job.progress_message_id) {
    await editOrSend(ctx, job.progress_chat_id, job.progress_message_id, text);
  } else {
    await safeSend(ctx, job.admin_id, text);
  }
  await answerCallback(ctx, query.id);
}

// src/keyboards.ts
function mainMenuKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        { text: t(lang, "btn.link"), callback_data: "m:link" },
        { text: t(lang, "btn.stats"), callback_data: "m:stats" }
      ],
      [
        { text: t(lang, "btn.settings"), callback_data: "m:settings" },
        { text: t(lang, "btn.help"), callback_data: "m:help" }
      ]
    ]
  };
}
function backToMenuKeyboard(lang) {
  return {
    inline_keyboard: [[{ text: t(lang, "btn.back"), callback_data: "m:back" }]]
  };
}
function linkKeyboard(lang, link) {
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(t(lang, "menu.shareText"))}`;
  return {
    inline_keyboard: [
      [{ text: t(lang, "btn.share"), url: share }],
      [{ text: t(lang, "btn.back"), callback_data: "m:back" }]
    ]
  };
}
function settingsKeyboard(lang, user) {
  return {
    inline_keyboard: [
      [
        {
          text: user.accept_messages ? t(lang, "btn.acceptOn") : t(lang, "btn.acceptOff"),
          callback_data: "s:accept"
        }
      ],
      [
        {
          text: user.allow_media ? t(lang, "btn.mediaOn") : t(lang, "btn.mediaOff"),
          callback_data: "s:media"
        },
        {
          text: user.allow_links ? t(lang, "btn.linksOn") : t(lang, "btn.linksOff"),
          callback_data: "s:links"
        }
      ],
      [
        {
          text: user.notify_reactions ? t(lang, "btn.reactionsOn") : t(lang, "btn.reactionsOff"),
          callback_data: "s:reactions"
        }
      ],
      [
        { text: t(lang, "btn.blocks"), callback_data: "s:blocks" },
        { text: t(lang, "btn.link"), callback_data: "m:link" }
      ],
      [{ text: t(lang, "btn.back"), callback_data: "m:back" }]
    ]
  };
}
function blocklistKeyboard(lang) {
  return {
    inline_keyboard: [
      [{ text: t(lang, "btn.clearBlocks"), callback_data: "s:clearblocks" }],
      [{ text: t(lang, "btn.back"), callback_data: "m:settings" }]
    ]
  };
}
var REACTION_EMOJIS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F525}", "\u{1F602}", "\u{1F622}"];
function anonymousMessageKeyboard(lang, messageId, strictAnon) {
  const rows = [];
  if (!strictAnon) {
    rows.push([
      { text: t(lang, "btn.reply"), callback_data: `r:${messageId}` },
      { text: t(lang, "btn.block"), callback_data: `b:${messageId}` }
    ]);
  } else {
    rows.push([{ text: t(lang, "btn.block"), callback_data: `b:${messageId}` }]);
  }
  if (!strictAnon) {
    rows.push(
      REACTION_EMOJIS.map((emoji) => ({
        text: emoji,
        callback_data: `k:${messageId}:${emoji}`
      }))
    );
  }
  rows.push([{ text: t(lang, "btn.report"), callback_data: `rep:${messageId}` }]);
  return { inline_keyboard: rows };
}
function continueDialogKeyboard(lang, recipientId) {
  return {
    inline_keyboard: [[{ text: t(lang, "btn.continue"), callback_data: `cont:${recipientId}` }]]
  };
}
function languageKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: t("ru", "btn.langRu"), callback_data: "lang:ru" },
        { text: t("en", "btn.langEn"), callback_data: "lang:en" }
      ]
    ]
  };
}
function adminNavKeyboard(lang, newReports) {
  return {
    inline_keyboard: [
      [
        { text: t(lang, "admin.btn.overview"), callback_data: "a:ov" },
        { text: t(lang, "admin.btn.dynamics"), callback_data: "a:st:7" }
      ],
      [
        { text: t(lang, "admin.btn.kinds"), callback_data: "a:kinds" },
        { text: t(lang, "admin.btn.top"), callback_data: "a:top" }
      ],
      [
        { text: t(lang, "admin.btn.reports", { n: newReports }), callback_data: "a:reps" },
        { text: t(lang, "admin.btn.bans"), callback_data: "a:bans" }
      ],
      [
        { text: t(lang, "admin.btn.broadcast"), callback_data: "a:bc" },
        { text: t(lang, "admin.btn.csv"), callback_data: "a:csv" }
      ],
      [{ text: t(lang, "admin.btn.settings"), callback_data: "a:set" }],
      [{ text: t(lang, "admin.btn.refresh"), callback_data: "a:ov" }]
    ]
  };
}
function adminBackKeyboard(lang) {
  return {
    inline_keyboard: [[{ text: t(lang, "admin.btn.back"), callback_data: "a:ov" }]]
  };
}

// src/stats.ts
var DAY = 86400;
var KIND_EMOJI = {
  text: "\u{1F4DD}",
  photo: "\u{1F5BC}",
  video: "\u{1F3AC}",
  animation: "\u{1F39E}",
  audio: "\u{1F3A7}",
  voice: "\u{1F399}",
  document: "\u{1F4CE}",
  sticker: "\u{1F0CF}",
  video_note: "\u2B55\uFE0F",
  poll: "\u{1F4CA}",
  other: "\u2754"
};
function dayStart(now) {
  return Math.floor(now / DAY) * DAY;
}
async function scalar(db, sql, ...binds) {
  const row = await db.prepare(sql).bind(...binds).first();
  return Number(row?.n ?? 0);
}
function dayKeys(count, now) {
  const start = dayStart(now);
  const keys = [];
  for (let index = count - 1; index >= 0; index -= 1) keys.push(isoDay(start - index * DAY));
  return keys;
}
async function dailyCounts(db, table, column, count, now) {
  const start = dayStart(now) - (count - 1) * DAY;
  const result = await db.prepare(
    `SELECT strftime('%Y-%m-%d', ${column}, 'unixepoch') AS day, COUNT(*) AS n
       FROM ${table}
       WHERE ${column} IS NOT NULL AND ${column} >= ?
       GROUP BY day`
  ).bind(start).all();
  const map = new Map((result.results ?? []).map((row) => [row.day, Number(row.n)]));
  return dayKeys(count, now).map((key) => map.get(key) ?? 0);
}
async function loadOverview(db, now) {
  const today = dayStart(now);
  const weekAgo = now - 7 * DAY;
  const [
    users,
    usersToday,
    users7,
    messages,
    messagesToday,
    messages7,
    replies,
    bans,
    reportsNew,
    activeInboxes,
    series7
  ] = await Promise.all([
    scalar(db, "SELECT COUNT(*) AS n FROM users"),
    scalar(db, "SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", today),
    scalar(db, "SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", weekAgo),
    scalar(db, "SELECT COUNT(*) AS n FROM messages"),
    scalar(db, "SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?", today),
    scalar(db, "SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?", weekAgo),
    scalar(db, "SELECT COUNT(*) AS n FROM messages WHERE replied_at IS NOT NULL"),
    scalar(db, "SELECT COUNT(*) AS n FROM bans"),
    scalar(db, "SELECT COUNT(*) AS n FROM reports WHERE status = 'new'"),
    scalar(db, "SELECT COUNT(*) AS n FROM users WHERE accept_messages = 1 AND is_blocked = 0"),
    dailyCounts(db, "messages", "created_at", 7, now)
  ]);
  return {
    users,
    usersToday,
    users7,
    messages,
    messagesToday,
    messages7,
    replies,
    replyRate: messages > 0 ? Math.round(replies / messages * 100) : 0,
    bans,
    reportsNew,
    activeInboxes,
    series7
  };
}
function renderOverview(data, settings, lang, now) {
  return t(lang, "admin.overview", {
    users: fmtInt(data.users),
    usersToday: fmtInt(data.usersToday),
    users7: fmtInt(data.users7),
    messages: fmtInt(data.messages),
    messagesToday: fmtInt(data.messagesToday),
    messages7: fmtInt(data.messages7),
    replies: fmtInt(data.replies),
    replyRate: String(data.replyRate),
    bans: fmtInt(data.bans),
    reportsNew: fmtInt(data.reportsNew),
    activeInboxes: fmtInt(data.activeInboxes),
    spark: sparkline(data.series7),
    max: fmtInt(Math.max(0, ...data.series7)),
    maint: settings.maintenance ? t(lang, "on") : t(lang, "off"),
    strict: settings.strictAnon ? t(lang, "on") : t(lang, "off"),
    updated: formatDateTime(now)
  });
}
async function renderDynamics(db, days, lang, now) {
  const [messagesSeries, usersSeries, replies] = await Promise.all([
    dailyCounts(db, "messages", "created_at", days, now),
    dailyCounts(db, "users", "created_at", days, now),
    scalar(db, "SELECT COUNT(*) AS n FROM messages WHERE replied_at >= ?", dayStart(now) - (days - 1) * DAY)
  ]);
  const messagesTotal = messagesSeries.reduce((sum, value) => sum + value, 0);
  const usersTotal = usersSeries.reduce((sum, value) => sum + value, 0);
  const hourly = await db.prepare(
    `SELECT CAST(strftime('%H', created_at, 'unixepoch') AS INTEGER) AS h, COUNT(*) AS n
       FROM messages WHERE created_at >= ? GROUP BY h ORDER BY n DESC LIMIT 1`
  ).bind(now - 7 * DAY).first();
  const peak = hourly ? t(lang, "admin.peak", {
    from: String(hourly.h).padStart(2, "0"),
    to: String((hourly.h + 1) % 24).padStart(2, "0"),
    count: fmtInt(Number(hourly.n))
  }) : "";
  const tailLength = Math.min(days, 7);
  const tail = messagesSeries.slice(-tailLength).map((value, index) => {
    const day = dayKeys(days, now)[days - tailLength + index] ?? "";
    return t(lang, "admin.dayLine", { date: shortDay(day), count: fmtInt(value) });
  }).join("\n");
  return [
    t(lang, "admin.dynamicsTitle", { days: String(days) }),
    "",
    t(lang, "admin.dynamicsTotals", {
      messages: fmtInt(messagesTotal),
      users: fmtInt(usersTotal),
      replies: fmtInt(replies),
      avg: fmtInt(Math.round(messagesTotal / days)),
      spark: sparkline(messagesSeries),
      peak
    }),
    "",
    tail
  ].join("\n");
}
async function renderKinds(db, lang, now) {
  const since = now - 30 * DAY;
  const result = await db.prepare("SELECT kind, COUNT(*) AS n FROM messages WHERE created_at >= ? GROUP BY kind ORDER BY n DESC").bind(since).all();
  const rows = result.results ?? [];
  const total = rows.reduce((sum, row) => sum + Number(row.n), 0);
  if (!rows.length || total <= 0) {
    return [t(lang, "admin.kindsTitle"), "", t(lang, "admin.kindsEmpty")].join("\n");
  }
  const lines = rows.map((row) => {
    const count = Number(row.n);
    const percent = Math.round(count / total * 100);
    return t(lang, "admin.kindLine", {
      emoji: KIND_EMOJI[row.kind] ?? KIND_EMOJI.other,
      label: kindLabel(lang, row.kind),
      count: fmtInt(count),
      percent: String(percent)
    });
  });
  return [t(lang, "admin.kindsTitle"), "", ...lines].join("\n");
}
async function renderTop(db, lang, now) {
  const result = await db.prepare(
    `SELECT m.recipient_id AS id, COUNT(*) AS n, u.username, u.first_name
       FROM messages m LEFT JOIN users u ON u.id = m.recipient_id
       WHERE m.created_at >= ?
       GROUP BY m.recipient_id ORDER BY n DESC LIMIT 10`
  ).bind(now - 30 * DAY).all();
  const rows = result.results ?? [];
  if (!rows.length) {
    return [t(lang, "admin.topTitle"), "", t(lang, "admin.topEmpty")].join("\n");
  }
  const lines = rows.map(
    (row, index) => t(lang, "admin.topLine", {
      rank: String(index + 1),
      name: escapeHtml(displayName(row.username, row.first_name)),
      count: fmtInt(Number(row.n))
    })
  );
  return [t(lang, "admin.topTitle"), "", ...lines].join("\n");
}
async function buildStatsCsv(db, now) {
  const days = 30;
  const [messagesSeries, usersSeries, kinds, hourly, top, totals] = await Promise.all([
    dailyCounts(db, "messages", "created_at", days, now),
    dailyCounts(db, "users", "created_at", days, now),
    db.prepare("SELECT kind, COUNT(*) AS n FROM messages WHERE created_at >= ? GROUP BY kind ORDER BY n DESC").bind(now - days * DAY).all(),
    db.prepare(
      `SELECT CAST(strftime('%H', created_at, 'unixepoch') AS INTEGER) AS h, COUNT(*) AS n
         FROM messages WHERE created_at >= ? GROUP BY h ORDER BY h`
    ).bind(now - 7 * DAY).all(),
    db.prepare(
      `SELECT m.recipient_id AS id, COUNT(*) AS n, u.username, u.first_name
         FROM messages m LEFT JOIN users u ON u.id = m.recipient_id
         WHERE m.created_at >= ? GROUP BY m.recipient_id ORDER BY n DESC LIMIT 20`
    ).bind(now - days * DAY).all(),
    db.prepare(
      `SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM messages) AS messages,
           (SELECT COUNT(*) FROM messages WHERE replied_at IS NOT NULL) AS replies,
           (SELECT COUNT(*) FROM bans) AS bans,
           (SELECT COUNT(*) FROM reports WHERE status = 'new') AS reports`
    ).first()
  ]);
  const keys = dayKeys(days, now);
  const rows = [
    ["section", "key", "messages", "new_users", "replies", "value"],
    ["total", "messages", Number(totals?.messages ?? 0), "", "", ""],
    ["total", "users", "", Number(totals?.users ?? 0), "", ""],
    ["total", "replies", "", "", Number(totals?.replies ?? 0), ""],
    ["moderation", "bans", "", "", "", Number(totals?.bans ?? 0)],
    ["moderation", "new_reports", "", "", "", Number(totals?.reports ?? 0)],
    ["meta", "generated_at_utc", "", "", "", new Date(now * 1e3).toISOString()]
  ];
  keys.forEach((key, index) => {
    rows.push(["daily", key, messagesSeries[index] ?? 0, usersSeries[index] ?? 0, "", ""]);
  });
  for (const row of kinds.results ?? []) rows.push(["kind", row.kind, Number(row.n), "", "", ""]);
  for (const row of hourly.results ?? []) {
    rows.push(["hour_utc_7d", String(row.h).padStart(2, "0"), Number(row.n), "", "", ""]);
  }
  for (const row of top.results ?? []) {
    rows.push(["top_inbox", displayName(row.username, row.first_name), Number(row.n), "", "", ""]);
  }
  return buildCsv(rows);
}
async function loadDigest(db, now) {
  const today = dayStart(now);
  const yesterday = today - DAY;
  const [messages, users, replies, reports, bans, series, topKindRow] = await Promise.all([
    scalar(db, "SELECT COUNT(*) AS n FROM messages WHERE created_at >= ? AND created_at < ?", yesterday, today),
    scalar(db, "SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?", yesterday, today),
    scalar(db, "SELECT COUNT(*) AS n FROM messages WHERE replied_at >= ? AND replied_at < ?", yesterday, today),
    scalar(db, "SELECT COUNT(*) AS n FROM reports WHERE created_at >= ? AND created_at < ?", yesterday, today),
    scalar(db, "SELECT COUNT(*) AS n FROM bans"),
    dailyCounts(db, "messages", "created_at", 7, now),
    db.prepare(
      "SELECT kind, COUNT(*) AS n FROM messages WHERE created_at >= ? AND created_at < ? GROUP BY kind ORDER BY n DESC LIMIT 1"
    ).bind(yesterday, today).first()
  ]);
  return {
    messages,
    users,
    replies,
    reports,
    bans,
    series,
    topKind: topKindRow?.kind ?? "other"
  };
}
function renderDigest(data, lang, now) {
  const date = shortDay(isoDay(now - DAY));
  return [
    t(lang, "digest.title", { date }),
    "",
    t(lang, "digest.body", {
      messages: fmtInt(data.messages),
      users: fmtInt(data.users),
      replies: fmtInt(data.replies),
      reports: fmtInt(data.reports),
      bans: fmtInt(data.bans)
    }),
    "",
    t(lang, "digest.week", { spark: sparkline(data.series) }),
    t(lang, "digest.topKind", {
      kind: `${KIND_EMOJI[data.topKind] ?? KIND_EMOJI.other} ${kindLabel(lang, data.topKind)}`
    })
  ].join("\n");
}

// src/admin.ts
function state(lang, value) {
  return value ? t(lang, "on") : t(lang, "off");
}
function reportItem(lang, report) {
  const owner = escapeHtml(displayName(report.owner_username, report.owner_first_name));
  const date = `${shortDay(isoDay(report.created_at))} ${formatTime(report.created_at)} UTC`;
  const alias = report.sender_key.slice(0, 8);
  if (!report.content_preview) {
    return t(lang, "admin.reportItemNoPreview", {
      id: String(report.id),
      kind: kindLabel(lang, report.kind),
      owner,
      alias,
      date
    });
  }
  return t(lang, "admin.reportItem", {
    id: String(report.id),
    kind: kindLabel(lang, report.kind),
    owner,
    alias,
    date,
    preview: escapeHtml(report.content_preview)
  });
}
async function renderReports(ctx, lang, offset = 0) {
  const total = await countNewReports(ctx.db);
  const pages = Math.max(1, Math.ceil(total / 5));
  const page = Math.min(Math.max(0, Math.floor(offset / 5)), pages - 1);
  const actualOffset = page * 5;
  const reports = await listNewReports(ctx.db, 5, actualOffset);
  const lines = [t(lang, "admin.reportsTitle")];
  if (!reports.length) {
    lines.push("", t(lang, "admin.reportsEmpty"));
  } else {
    lines.push("", reports.map((report) => reportItem(lang, report)).join("\n\n"));
    if (pages > 1) {
      lines.push("", t(lang, "admin.reportsPage", { page: String(page + 1), pages: String(pages) }));
    }
    lines.push("", t(lang, "admin.reportHint"));
  }
  const rows = reports.map((report) => [
    { text: `${t(lang, "admin.ban")} #${report.id}`, callback_data: `a:ban:${report.id}` },
    { text: `${t(lang, "admin.dismiss")} #${report.id}`, callback_data: `a:dis:${report.id}` }
  ]);
  if (pages > 1) {
    const pagination = [];
    if (page > 0) pagination.push({ text: "\u2039", callback_data: `a:reps:${Math.max(0, actualOffset - 5)}` });
    if (page + 1 < pages) pagination.push({ text: "\u203A", callback_data: `a:reps:${actualOffset + 5}` });
    if (pagination.length) rows.push(pagination);
  }
  rows.push([{ text: t(lang, "admin.btn.back"), callback_data: "a:ov" }]);
  return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
}
async function renderBans(ctx, lang) {
  const [bans, total] = await Promise.all([listBans(ctx.db, 10), countBans(ctx.db)]);
  const lines = [t(lang, "admin.bansTitle"), "", t(lang, "admin.bansHint")];
  if (!bans.length) {
    lines.push("", t(lang, "admin.bansEmpty"));
  } else {
    lines.push("", t(lang, "admin.bansTotal", { count: fmtInt(total) }), "");
    for (const ban of bans) {
      lines.push(
        t(lang, "admin.banItem", {
          key: ban.sender_key.slice(0, 12),
          date: `${shortDay(isoDay(ban.created_at))} ${formatTime(ban.created_at)} UTC`
        })
      );
    }
  }
  const rows = bans.map((ban) => [
    { text: `${t(lang, "admin.unban")} ${ban.sender_key.slice(0, 6)}`, callback_data: `a:unban:${ban.sender_key}` }
  ]);
  rows.push([{ text: t(lang, "admin.btn.back"), callback_data: "a:ov" }]);
  return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
}
async function renderSettings(ctx, lang) {
  const settings = await getSettings(ctx.db);
  const hour = String(digestHour(ctx.env)).padStart(2, "0");
  const lines = [
    t(lang, "admin.settingsTitle"),
    "",
    t(lang, "admin.setMaintenance", { state: state(lang, settings.maintenance) }),
    t(lang, "admin.setStrict", { state: state(lang, settings.strictAnon) }),
    t(lang, "admin.setDigest", { state: state(lang, settings.digest) }),
    t(lang, "admin.setDigestHour", { hour }),
    "",
    t(lang, "admin.setStorage", {
      days: String(contentTtlDays(ctx.env)),
      replyDays: String(replyTtlDays(ctx.env))
    }),
    "",
    t(lang, "admin.setMaintenanceHint")
  ];
  if (settings.strictAnon) lines.push("", t(lang, "admin.setStrictHint"));
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          {
            text: settings.maintenance ? t(lang, "admin.btn.maintOn") : t(lang, "admin.btn.maintOff"),
            callback_data: "a:t:maint"
          }
        ],
        [
          {
            text: settings.strictAnon ? t(lang, "admin.btn.strictOn") : t(lang, "admin.btn.strictOff"),
            callback_data: "a:t:strict"
          }
        ],
        [
          {
            text: settings.digest ? t(lang, "admin.btn.digestOn") : t(lang, "admin.btn.digestOff"),
            callback_data: "a:t:digest"
          }
        ],
        [{ text: t(lang, "admin.btn.back"), callback_data: "a:ov" }]
      ]
    }
  };
}
async function renderBroadcast(ctx, lang) {
  const active = await getActiveBroadcast(ctx.db);
  const latest = active ?? await getLatestBroadcast(ctx.db);
  const total = await countBroadcastRecipients(ctx.db);
  const lines = [t(lang, "admin.broadcastTitle"), ""];
  if (active) {
    lines.push(
      t(lang, "admin.broadcastProgress", {
        sent: fmtInt(active.sent),
        total: fmtInt(total),
        failed: fmtInt(active.failed)
      })
    );
  } else if (latest && (latest.status === "done" || latest.status === "stopped")) {
    lines.push(
      t(lang, latest.status === "done" ? "admin.broadcastDone" : "admin.broadcastStopped", {
        sent: fmtInt(latest.sent),
        failed: fmtInt(latest.failed)
      }),
      "",
      t(lang, "admin.broadcastIdle", { recipients: fmtInt(total) })
    );
  } else {
    lines.push(t(lang, "admin.broadcastIdle", { recipients: fmtInt(total) }));
  }
  const rows = [];
  if (active) {
    rows.push([
      { text: t(lang, "admin.broadcastStop"), callback_data: `a:bc:stop:${active.id}` }
    ]);
  } else {
    rows.push([{ text: t(lang, "admin.broadcastNew"), callback_data: "a:bc:new" }]);
  }
  rows.push([{ text: t(lang, "admin.btn.back"), callback_data: "a:ov" }]);
  return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
}
async function renderView(ctx, view, lang, reportOffset = 0) {
  const newReports = await countNewReports(ctx.db);
  const nav = adminNavKeyboard(lang, newReports);
  switch (view) {
    case "ov": {
      const [overview, settings] = await Promise.all([loadOverview(ctx.db, ctx.now), getSettings(ctx.db)]);
      return { text: renderOverview(overview, settings, lang, ctx.now), keyboard: nav };
    }
    case "st7":
      return { text: await renderDynamics(ctx.db, 7, lang, ctx.now), keyboard: adminBackKeyboard(lang) };
    case "st30":
      return { text: await renderDynamics(ctx.db, 30, lang, ctx.now), keyboard: adminBackKeyboard(lang) };
    case "kinds":
      return { text: await renderKinds(ctx.db, lang, ctx.now), keyboard: adminBackKeyboard(lang) };
    case "top":
      return { text: await renderTop(ctx.db, lang, ctx.now), keyboard: adminBackKeyboard(lang) };
    case "reps":
      return renderReports(ctx, lang, reportOffset);
    case "bans":
      return renderBans(ctx, lang);
    case "set":
      return renderSettings(ctx, lang);
    case "bc":
      return renderBroadcast(ctx, lang);
  }
}
async function openAdminPanel(ctx, chatId, view, lang, editMessageId, reportOffset = 0) {
  const rendered = await renderView(ctx, view, lang, reportOffset);
  if (editMessageId) await editOrSend(ctx, chatId, editMessageId, rendered.text, rendered.keyboard);
  else await safeSend(ctx, chatId, rendered.text, rendered.keyboard);
}
async function handleCsv(ctx, query, lang) {
  if (!query.message) return;
  try {
    const csv = await buildStatsCsv(ctx.db, ctx.now);
    const date = isoDay(ctx.now);
    await ctx.api.sendDocument(
      query.message.chat.id,
      `anon-stats-${date}.csv`,
      csv,
      t(lang, "admin.csvCaption", { date: shortDay(date) })
    );
    await answerCallback(ctx, query.id, t(lang, "admin.csvSent"));
  } catch (error) {
    logTelegramError("sendDocument", error);
    await answerCallback(ctx, query.id, t(lang, "admin.csvError"));
  }
}
async function toggleSetting(ctx, key) {
  const settings = await getSettings(ctx.db);
  if (key === "maint") {
    await setSetting(ctx.db, "maintenance", settings.maintenance ? "0" : "1");
    return;
  }
  if (key === "strict") {
    const next = !settings.strictAnon;
    await setSetting(ctx.db, "strict_anon", next ? "1" : "0");
    if (next) await purgeReplyKeys(ctx.db);
    return;
  }
  if (key === "digest") {
    await setSetting(ctx.db, "digest", settings.digest ? "0" : "1");
  }
}
async function handleAdminCallback(ctx, query, data) {
  const adminUser = await getUser(ctx.db, query.from.id);
  const lang = normalizeLang(adminUser?.lang);
  if (!isAdmin(ctx.env, query.from.id) || !query.message) {
    await answerCallback(ctx, query.id, t(lang, "admin.denied"));
    return;
  }
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  if (data === "a:ov") {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, "ov", lang, messageId);
    return;
  }
  if (data === "a:st:7" || data === "a:st:30") {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, data === "a:st:7" ? "st7" : "st30", lang, messageId);
    return;
  }
  if (data === "a:kinds") {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, "kinds", lang, messageId);
    return;
  }
  if (data === "a:top") {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, "top", lang, messageId);
    return;
  }
  if (data === "a:reps") {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, "reps", lang, messageId, 0);
    return;
  }
  if (data.startsWith("a:reps:")) {
    const offset = Number(data.slice(7));
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, "reps", lang, messageId, Number.isFinite(offset) ? Math.max(0, offset) : 0);
    return;
  }
  if (data === "a:bans") {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, "bans", lang, messageId);
    return;
  }
  if (data === "a:set") {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, "set", lang, messageId);
    return;
  }
  if (data === "a:bc") {
    await answerCallback(ctx, query.id);
    await openAdminPanel(ctx, chatId, "bc", lang, messageId);
    return;
  }
  if (data === "a:csv") {
    await handleCsv(ctx, query, lang);
    return;
  }
  if (data.startsWith("a:t:")) {
    await toggleSetting(ctx, data.slice(4));
    await answerCallback(ctx, query.id, t(lang, "admin.answer.saved"));
    await openAdminPanel(ctx, chatId, "set", lang, messageId);
    return;
  }
  if (data.startsWith("a:ban:")) {
    const report = await getReport(ctx.db, Number(data.slice(6)));
    if (!report || report.status !== "new") {
      await answerCallback(ctx, query.id, t(lang, "admin.reportGone"));
      await openAdminPanel(ctx, chatId, "reps", lang, messageId);
      return;
    }
    await banSender(ctx.db, report.sender_key, `report:${report.id}`, ctx.now);
    await revokeReplyKeysForSender(ctx.db, report.sender_key);
    await setReportStatus(ctx.db, report.id, "banned", ctx.now);
    await answerCallback(ctx, query.id, t(lang, "admin.reportBanned", { id: String(report.id) }));
    await openAdminPanel(ctx, chatId, "reps", lang, messageId);
    return;
  }
  if (data.startsWith("a:dis:")) {
    const report = await getReport(ctx.db, Number(data.slice(6)));
    if (!report || report.status !== "new") {
      await answerCallback(ctx, query.id, t(lang, "admin.reportGone"));
      await openAdminPanel(ctx, chatId, "reps", lang, messageId);
      return;
    }
    await setReportStatus(ctx.db, report.id, "dismissed", ctx.now);
    await answerCallback(ctx, query.id, t(lang, "admin.reportDismissed", { id: String(report.id) }));
    await openAdminPanel(ctx, chatId, "reps", lang, messageId);
    return;
  }
  if (data.startsWith("a:unban:")) {
    await unbanSender(ctx.db, data.slice(8));
    await answerCallback(ctx, query.id, t(lang, "admin.unbanDone"));
    await openAdminPanel(ctx, chatId, "bans", lang, messageId);
    return;
  }
  if (data === "a:bc:new") {
    if (!adminUser) {
      await answerCallback(ctx, query.id, t(lang, "admin.denied"));
      return;
    }
    await answerCallback(ctx, query.id);
    await startBroadcastPrompt(ctx, adminUser);
    return;
  }
  if (data === "a:bc:cancel") {
    await clearSession(ctx.db, query.from.id);
    await answerCallback(ctx, query.id, t(lang, "menu.cancelled"));
    await openAdminPanel(ctx, chatId, "bc", lang, messageId);
    return;
  }
  if (data.startsWith("a:bc:go:")) {
    const job = await getBroadcastJob(ctx.db, Number(data.slice(8)));
    if (!job || job.status !== "draft") {
      await answerCallback(ctx, query.id, t(lang, "admin.broadcastNoJob"));
      await openAdminPanel(ctx, chatId, "bc", lang, messageId);
      return;
    }
    const active = await getActiveBroadcast(ctx.db);
    if (active) {
      await answerCallback(ctx, query.id, t(lang, "admin.broadcastAlready", { id: String(active.id) }));
      return;
    }
    const total = await countBroadcastRecipients(ctx.db);
    const started = await startBroadcastJob(ctx.db, job.id, ctx.now);
    if (!started) {
      const running = await getActiveBroadcast(ctx.db);
      await answerCallback(
        ctx,
        query.id,
        running ? t(lang, "admin.broadcastAlready", { id: String(running.id) }) : t(lang, "admin.broadcastNoJob")
      );
      await openAdminPanel(ctx, chatId, "bc", lang, messageId);
      return;
    }
    await setBroadcastProgressTarget(ctx.db, job.id, chatId, messageId, ctx.now);
    await editOrSend(
      ctx,
      chatId,
      messageId,
      t(lang, "admin.broadcastStarted", { sent: "0", total: fmtInt(total) })
    );
    await answerCallback(ctx, query.id);
    ctx.waitUntil(
      drainBroadcast(ctx).catch((error) => {
        console.error("broadcast start failed", error instanceof Error ? error.message : String(error));
      })
    );
    return;
  }
  if (data.startsWith("a:bc:del:")) {
    await deleteBroadcastJob(ctx.db, Number(data.slice(9)));
    await answerCallback(ctx, query.id, t(lang, "menu.cancelled"));
    await openAdminPanel(ctx, chatId, "bc", lang, messageId);
    return;
  }
  if (data.startsWith("a:bc:stop:")) {
    await stopBroadcast(ctx, query, Number(data.slice(10)));
    return;
  }
  await answerCallback(ctx, query.id);
}

// src/user.ts
function parseCommand(text) {
  const match = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}
function langOf(user) {
  return normalizeLang(user.lang);
}
async function linkFor(ctx, user) {
  const username = await getBotUsername(ctx);
  return inboxLink(username, user.inbox_token);
}
function settingsText(lang, user) {
  return t(lang, "menu.settings", {
    accept: user.accept_messages ? t(lang, "on") : t(lang, "off"),
    media: user.allow_media ? t(lang, "on") : t(lang, "off"),
    links: user.allow_links ? t(lang, "on") : t(lang, "off"),
    reactions: user.notify_reactions ? t(lang, "on") : t(lang, "off")
  });
}
async function sendMainMenu(ctx, chatId, user, editMessageId) {
  const lang = langOf(user);
  const link = await linkFor(ctx, user);
  const name = escapeHtml(user.first_name ?? "\u2014");
  const text = t(lang, "menu.title", { name, link: escapeHtml(link) });
  const keyboard = mainMenuKeyboard(lang);
  if (editMessageId) await editOrSend(ctx, chatId, editMessageId, text, keyboard);
  else await safeSend(ctx, chatId, text, keyboard);
}
async function sendStats(ctx, chatId, user, editMessageId) {
  const lang = langOf(user);
  const weekAgo = ctx.now - 7 * 86400;
  const [total, week, replies, blocked] = await Promise.all([
    countUserMessages(ctx.db, user.id),
    countUserMessages(ctx.db, user.id, weekAgo),
    countUserReplies(ctx.db, user.id),
    countBlocks(ctx.db, user.id)
  ]);
  const text = t(lang, "menu.stats", {
    total: fmtInt(total),
    week: fmtInt(week),
    replies: fmtInt(replies),
    blocked: fmtInt(blocked),
    status: user.accept_messages ? t(lang, "menu.statusOn") : t(lang, "menu.statusOff")
  });
  if (editMessageId) await editOrSend(ctx, chatId, editMessageId, text, backToMenuKeyboard(lang));
  else await safeSend(ctx, chatId, text, backToMenuKeyboard(lang));
}
async function sendSettings(ctx, chatId, user, editMessageId) {
  const lang = langOf(user);
  const text = settingsText(lang, user);
  const keyboard = settingsKeyboard(lang, user);
  if (editMessageId) await editOrSend(ctx, chatId, editMessageId, text, keyboard);
  else await safeSend(ctx, chatId, text, keyboard);
}
async function sendBlocklist(ctx, chatId, user, editMessageId) {
  const lang = langOf(user);
  const count = await countBlocks(ctx.db, user.id);
  const text = t(lang, "menu.blocks", { count: fmtInt(count) });
  const keyboard = blocklistKeyboard(lang);
  if (editMessageId) await editOrSend(ctx, chatId, editMessageId, text, keyboard);
  else await safeSend(ctx, chatId, text, keyboard);
}
async function handleCommand(ctx, user, command, args, admin) {
  const lang = langOf(user);
  switch (command) {
    case "start": {
      await clearSession(ctx.db, user.id);
      if (args.startsWith("u_")) {
        const recipient = await getUserByToken(ctx.db, args.slice(2));
        if (!recipient) {
          await setTarget(ctx.db, user.id, null, ctx.now);
          await safeSend(ctx, user.id, t(lang, "send.badLink"));
          return;
        }
        if (recipient.id === user.id) {
          await setTarget(ctx.db, user.id, null, ctx.now);
          await safeSend(ctx, user.id, t(lang, "send.ownLink"));
          return;
        }
        await setTarget(ctx.db, user.id, recipient.id, ctx.now);
        const name = escapeHtml(displayName(recipient.username, recipient.first_name));
        await safeSend(ctx, user.id, t(lang, "send.inboxIntro", { name }), mainMenuKeyboard(lang));
        return;
      }
      await setTarget(ctx.db, user.id, null, ctx.now);
      await sendMainMenu(ctx, user.id, user);
      return;
    }
    case "link": {
      const link = await linkFor(ctx, user);
      await safeSend(ctx, user.id, t(lang, "menu.link", { link: escapeHtml(link) }), linkKeyboard(lang, link));
      return;
    }
    case "stats":
      await sendStats(ctx, user.id, user);
      return;
    case "settings":
      await sendSettings(ctx, user.id, user);
      return;
    case "pause":
      await setUserFlag(ctx.db, user.id, "accept_messages", 0);
      await safeSend(ctx, user.id, t(lang, "send.paused"));
      return;
    case "resume":
      await setUserFlag(ctx.db, user.id, "accept_messages", 1);
      await safeSend(ctx, user.id, t(lang, "send.resumed"));
      return;
    case "lang":
      await safeSend(ctx, user.id, "\u{1F30D} <b>\u0420\u0443\u0441\u0441\u043A\u0438\u0439 / English</b>", languageKeyboard());
      return;
    case "help":
      await safeSend(ctx, user.id, t(lang, "menu.help"), backToMenuKeyboard(lang));
      return;
    case "privacy":
      await safeSend(
        ctx,
        user.id,
        t(lang, "menu.privacy", {
          days: String(contentTtlDays(ctx.env)),
          replyDays: String(replyTtlDays(ctx.env))
        }),
        backToMenuKeyboard(lang)
      );
      return;
    case "cancel":
      await clearSession(ctx.db, user.id);
      await setTarget(ctx.db, user.id, null, ctx.now);
      await safeSend(ctx, user.id, t(lang, "menu.cancelled"), mainMenuKeyboard(lang));
      return;
    case "admin":
      if (!admin) {
        await safeSend(ctx, user.id, t(lang, "admin.denied"));
        return;
      }
      await openAdminPanel(ctx, user.id, "ov", lang);
      return;
    case "broadcast":
      if (!admin) {
        await safeSend(ctx, user.id, t(lang, "admin.denied"));
        return;
      }
      await openAdminPanel(ctx, user.id, "bc", lang);
      return;
    default:
      await safeSend(ctx, user.id, t(lang, "menu.unknownCommand"), mainMenuKeyboard(lang));
  }
}
async function onMessage(ctx, message) {
  const from = message.from;
  if (!from || from.is_bot) return;
  if (message.chat.type !== "private") return;
  const user = await touchUser(ctx.db, from, ctx.now);
  const lang = langOf(user);
  const admin = isAdmin(ctx.env, from.id);
  const settings = await getSettings(ctx.db);
  if (settings.maintenance && !admin) {
    await safeSend(ctx, user.id, t(lang, "menu.maintenance"));
    return;
  }
  if (message.text && message.text.startsWith("/")) {
    const command = parseCommand(message.text);
    if (command) {
      await handleCommand(ctx, user, command.name, command.args, admin);
      return;
    }
  }
  const session = await getSession(ctx.db, user.id);
  if (session?.state === "await_reply") {
    await handleReply(ctx, user, message, Number(session.data));
    return;
  }
  if (session?.state === "bc" && admin) {
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
    await safeSend(ctx, user.id, t(lang, "send.noTarget"), mainMenuKeyboard(lang));
    return;
  }
  await sendAnonymous(ctx, user, message, targetId, settings.strictAnon);
}
async function sendAnonymous(ctx, user, message, recipientId, strictAnon) {
  const lang = langOf(user);
  const content = detectContent(message);
  if (!content) {
    await safeSend(ctx, user.id, t(lang, "send.unsupported"));
    return;
  }
  if (content.kind === "text" && !content.text) {
    await safeSend(ctx, user.id, t(lang, "send.empty"));
    return;
  }
  const recipient = await getUser(ctx.db, recipientId);
  if (!recipient) {
    await setTarget(ctx.db, user.id, null, ctx.now);
    await safeSend(ctx, user.id, t(lang, "send.targetGone"));
    return;
  }
  if (recipient.id === user.id) {
    await setTarget(ctx.db, user.id, null, ctx.now);
    await safeSend(ctx, user.id, t(lang, "send.self"));
    return;
  }
  if (user.is_blocked) {
    await safeSend(ctx, user.id, t(lang, "send.banned"));
    return;
  }
  if (!recipient.accept_messages || recipient.is_blocked) {
    await safeSend(ctx, user.id, t(lang, "send.closed"));
    return;
  }
  const key = await senderKey(ctx.env.BOT_SECRET, user.id);
  if (await isSenderBanned(ctx.db, key, ctx.now)) {
    await safeSend(ctx, user.id, t(lang, "send.banned"));
    return;
  }
  if (await isSenderBlocked(ctx.db, recipient.id, key)) {
    await safeSend(ctx, user.id, t(lang, "send.blocked"));
    return;
  }
  if (content.kind !== "text" && !recipient.allow_media) {
    await safeSend(ctx, user.id, t(lang, "send.mediaOff"));
    return;
  }
  if (content.hasLink && !recipient.allow_links) {
    await safeSend(ctx, user.id, t(lang, "send.linksOff"));
    return;
  }
  const maxLength = content.kind === "text" ? 4096 : 1024;
  if (content.text.length > maxLength) {
    await safeSend(ctx, user.id, t(lang, "send.tooLong", { max: fmtInt(maxLength) }));
    return;
  }
  const rate = await consumeRate(ctx.db, key, ctx.now, getLimits(ctx.env));
  if (!rate.allowed) {
    await safeSend(ctx, user.id, t(lang, "send.rate", { sec: String(Math.max(1, rate.retryAfter)) }));
    return;
  }
  const normalized = content.text.trim().toLowerCase();
  const contentHash = normalized ? await sha256Hex(normalized) : null;
  if (contentHash) {
    const duplicates = await countRecentDuplicates(ctx.db, recipient.id, contentHash, ctx.now - 600);
    if (duplicates >= 2) {
      await safeSend(ctx, user.id, t(lang, "send.duplicate"));
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
    now: ctx.now
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
      reply_markup: anonymousMessageKeyboard(normalizeLang(recipient.lang), messageId, strictAnon)
    });
    await attachDeliveredMessage(ctx.db, messageId, delivered.message_id);
    const name = escapeHtml(displayName(recipient.username, recipient.first_name));
    await safeSend(ctx, user.id, t(lang, "send.sentNamed", { name }));
  } catch (error) {
    logTelegramError("copyMessage", error);
    await deleteMessageRow(ctx.db, messageId);
    await deleteReplyKey(ctx.db, messageId);
    await safeSend(ctx, user.id, t(lang, "send.failed"));
  }
}
async function handleReply(ctx, user, message, messageId) {
  const lang = langOf(user);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    await clearSession(ctx.db, user.id);
    await safeSend(ctx, user.id, t(lang, "send.replyExpired"));
    return;
  }
  const original = await getMessage(ctx.db, messageId);
  if (!original || original.recipient_id !== user.id) {
    await clearSession(ctx.db, user.id);
    await safeSend(ctx, user.id, t(lang, "send.replyExpired"));
    return;
  }
  const replyKey = await getReplyKey(ctx.db, messageId);
  if (!replyKey || replyKey.expires_at <= ctx.now) {
    await clearSession(ctx.db, user.id);
    await safeSend(ctx, user.id, t(lang, "send.replyExpired"));
    return;
  }
  const content = detectContent(message);
  if (!content) {
    await safeSend(ctx, user.id, t(lang, "send.unsupported"));
    return;
  }
  if (content.kind === "text" && !content.text) {
    await safeSend(ctx, user.id, t(lang, "send.empty"));
    return;
  }
  let senderId;
  try {
    senderId = await decryptSenderRef(ctx.env.BOT_SECRET, replyKey.ref);
  } catch {
    await clearSession(ctx.db, user.id);
    await safeSend(ctx, user.id, t(lang, "send.replyExpired"));
    return;
  }
  const sender = await getUser(ctx.db, senderId);
  const senderLang = normalizeLang(sender?.lang);
  const header = t(senderLang, "send.replyHeader");
  try {
    if (content.kind === "text") {
      await ctx.api.sendMessage(senderId, `${header}

${escapeHtml(content.text)}`, {
        reply_markup: continueDialogKeyboard(senderLang, user.id)
      });
    } else {
      await ctx.api.sendMessage(senderId, header, {
        reply_markup: continueDialogKeyboard(senderLang, user.id)
      });
      await ctx.api.copyMessage({
        chat_id: senderId,
        from_chat_id: user.id,
        message_id: message.message_id
      });
    }
    await deleteReplyKey(ctx.db, messageId);
    await markMessageReplied(ctx.db, messageId, ctx.now);
    await clearSession(ctx.db, user.id);
    await safeSend(ctx, user.id, t(lang, "send.replySent"));
  } catch (error) {
    logTelegramError("reply delivery", error);
    await safeSend(ctx, user.id, t(lang, "send.replyFailed"));
  }
}
async function handleBlock(ctx, query, user, messageId) {
  const lang = langOf(user);
  const original = await getMessage(ctx.db, messageId);
  if (!original || original.recipient_id !== user.id) {
    await answerCallback(ctx, query.id, t(lang, "send.replyExpired"));
    return;
  }
  await blockSender(ctx.db, user.id, original.sender_key, ctx.now);
  await revokeReplyKeysForSenderInInbox(ctx.db, user.id, original.sender_key);
  await answerCallback(ctx, query.id, t(lang, "send.blockedUser"));
}
async function handleReport(ctx, query, user, messageId) {
  const lang = langOf(user);
  const original = await getMessage(ctx.db, messageId);
  if (!original || original.recipient_id !== user.id) {
    await answerCallback(ctx, query.id, t(lang, "send.replyExpired"));
    return;
  }
  const preview = original.content_preview ?? `[${original.kind}]`;
  const reportId = await createReport(ctx.db, {
    messageId: original.id,
    recipientId: user.id,
    senderKey: original.sender_key,
    kind: original.kind,
    preview,
    now: ctx.now
  });
  if (!reportId) {
    await answerCallback(ctx, query.id, t(lang, "send.reportAlready"));
    return;
  }
  await blockSender(ctx.db, user.id, original.sender_key, ctx.now);
  await revokeReplyKeysForSenderInInbox(ctx.db, user.id, original.sender_key);
  await answerCallback(ctx, query.id, t(lang, "send.reportSent"));
  for (const adminId of parseAdminIds(ctx.env)) {
    const adminUser = await getUser(ctx.db, adminId);
    const adminLang = normalizeLang(adminUser?.lang);
    const text = t(adminLang, "admin.newReport", {
      id: String(reportId),
      owner: escapeHtml(displayName(user.username, user.first_name)),
      kind: t(adminLang, `kind.${original.kind}`),
      alias: original.sender_key.slice(0, 8),
      preview: escapeHtml(preview)
    });
    const keyboard = {
      inline_keyboard: [
        [
          { text: t(adminLang, "admin.ban"), callback_data: `a:ban:${reportId}` },
          { text: t(adminLang, "admin.dismiss"), callback_data: `a:dis:${reportId}` }
        ]
      ]
    };
    await safeSend(ctx, adminId, text, keyboard);
  }
}
async function handleReaction(ctx, query, user, messageId, emoji, strictAnon) {
  const lang = langOf(user);
  if (strictAnon) {
    await answerCallback(ctx, query.id, t(lang, "send.noRepliesStrict"));
    return;
  }
  if (!REACTION_EMOJIS.includes(emoji)) {
    await answerCallback(ctx, query.id);
    return;
  }
  const original = await getMessage(ctx.db, messageId);
  if (!original || original.recipient_id !== user.id) {
    await answerCallback(ctx, query.id, t(lang, "send.replyExpired"));
    return;
  }
  const replyKey = await getReplyKey(ctx.db, messageId);
  if (!replyKey || replyKey.expires_at <= ctx.now) {
    await answerCallback(ctx, query.id, t(lang, "send.replyExpired"));
    return;
  }
  const isNew = await recordReaction(ctx.db, messageId, emoji, ctx.now);
  if (!isNew) {
    await answerCallback(ctx, query.id, t(lang, "send.reactionAlready"));
    return;
  }
  let senderId;
  try {
    senderId = await decryptSenderRef(ctx.env.BOT_SECRET, replyKey.ref);
  } catch {
    await answerCallback(ctx, query.id, t(lang, "send.replyExpired"));
    return;
  }
  const sender = await getUser(ctx.db, senderId);
  if (sender?.notify_reactions) {
    await safeSend(ctx, senderId, t(normalizeLang(sender.lang), "send.reactionNotify", { emoji }));
  }
  await answerCallback(ctx, query.id, t(lang, "send.reactionSent"));
}
async function handleContinue(ctx, query, user, recipientId) {
  const lang = langOf(user);
  const recipient = await getUser(ctx.db, recipientId);
  if (!recipient) {
    await answerCallback(ctx, query.id, t(lang, "send.targetGone"));
    return;
  }
  if (recipient.id === user.id) {
    await answerCallback(ctx, query.id, t(lang, "send.self"));
    return;
  }
  await setTarget(ctx.db, user.id, recipient.id, ctx.now);
  await answerCallback(
    ctx,
    query.id,
    t(lang, "send.continueSet", {
      name: displayName(recipient.username, recipient.first_name)
    })
  );
}
async function handleUserCallback(ctx, query, user, data, strictAnon) {
  const message = query.message;
  if (!message) {
    await answerCallback(ctx, query.id);
    return;
  }
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const lang = langOf(user);
  if (data === "m:back") {
    await answerCallback(ctx, query.id);
    await sendMainMenu(ctx, chatId, user, messageId);
    return;
  }
  if (data === "r:cancel") {
    await clearSession(ctx.db, user.id);
    await answerCallback(ctx, query.id, t(lang, "menu.cancelled"));
    await sendMainMenu(ctx, chatId, user, messageId);
    return;
  }
  if (data === "m:link") {
    const link = await linkFor(ctx, user);
    await answerCallback(ctx, query.id);
    await editOrSend(
      ctx,
      chatId,
      messageId,
      t(lang, "menu.link", { link: escapeHtml(link) }),
      linkKeyboard(lang, link)
    );
    return;
  }
  if (data === "m:stats") {
    await answerCallback(ctx, query.id);
    await sendStats(ctx, chatId, user, messageId);
    return;
  }
  if (data === "m:settings") {
    await answerCallback(ctx, query.id);
    await sendSettings(ctx, chatId, user, messageId);
    return;
  }
  if (data === "m:help") {
    await answerCallback(ctx, query.id);
    await editOrSend(ctx, chatId, messageId, t(lang, "menu.help"), backToMenuKeyboard(lang));
    return;
  }
  if (data === "m:privacy") {
    await answerCallback(ctx, query.id);
    await editOrSend(
      ctx,
      chatId,
      messageId,
      t(lang, "menu.privacy", {
        days: String(contentTtlDays(ctx.env)),
        replyDays: String(replyTtlDays(ctx.env))
      }),
      backToMenuKeyboard(lang)
    );
    return;
  }
  if (data.startsWith("lang:")) {
    const nextLang = data.slice(5) === "en" ? "en" : "ru";
    await setUserFlag(ctx.db, user.id, "lang", nextLang);
    const updated = { ...user, lang: nextLang };
    await answerCallback(ctx, query.id, t(nextLang, "send.langChanged"));
    await sendMainMenu(ctx, chatId, updated, messageId);
    return;
  }
  if (data.startsWith("s:")) {
    const action = data.slice(2);
    if (action === "accept") {
      const next = user.accept_messages ? 0 : 1;
      await setUserFlag(ctx.db, user.id, "accept_messages", next);
      user = { ...user, accept_messages: next };
      await answerCallback(ctx, query.id, next ? t(lang, "on") : t(lang, "off"));
      await sendSettings(ctx, chatId, user, messageId);
      return;
    }
    if (action === "media") {
      const next = user.allow_media ? 0 : 1;
      await setUserFlag(ctx.db, user.id, "allow_media", next);
      user = { ...user, allow_media: next };
      await answerCallback(ctx, query.id, next ? t(lang, "on") : t(lang, "off"));
      await sendSettings(ctx, chatId, user, messageId);
      return;
    }
    if (action === "links") {
      const next = user.allow_links ? 0 : 1;
      await setUserFlag(ctx.db, user.id, "allow_links", next);
      user = { ...user, allow_links: next };
      await answerCallback(ctx, query.id, next ? t(lang, "on") : t(lang, "off"));
      await sendSettings(ctx, chatId, user, messageId);
      return;
    }
    if (action === "reactions") {
      const next = user.notify_reactions ? 0 : 1;
      await setUserFlag(ctx.db, user.id, "notify_reactions", next);
      user = { ...user, notify_reactions: next };
      await answerCallback(ctx, query.id, next ? t(lang, "on") : t(lang, "off"));
      await sendSettings(ctx, chatId, user, messageId);
      return;
    }
    if (action === "blocks") {
      await answerCallback(ctx, query.id);
      await sendBlocklist(ctx, chatId, user, messageId);
      return;
    }
    if (action === "clearblocks") {
      await clearBlocks(ctx.db, user.id);
      await answerCallback(ctx, query.id, t(lang, "send.unblockedAll"));
      await sendBlocklist(ctx, chatId, user, messageId);
      return;
    }
    await answerCallback(ctx, query.id);
    return;
  }
  if (data.startsWith("r:")) {
    const originalId = Number(data.slice(2));
    const original = await getMessage(ctx.db, originalId);
    if (!original || original.recipient_id !== user.id) {
      await answerCallback(ctx, query.id, t(lang, "send.replyExpired"));
      return;
    }
    if (strictAnon) {
      await answerCallback(ctx, query.id, t(lang, "send.noRepliesStrict"));
      return;
    }
    const replyKey = await getReplyKey(ctx.db, originalId);
    if (!replyKey || replyKey.expires_at <= ctx.now) {
      await answerCallback(ctx, query.id, t(lang, "send.replyExpired"));
      return;
    }
    await setSession(ctx.db, user.id, "await_reply", String(originalId), ctx.now);
    await answerCallback(ctx, query.id);
    await safeSend(ctx, chatId, t(lang, "send.replyPrompt", { id: String(originalId) }), {
      inline_keyboard: [[{ text: t(lang, "btn.cancel"), callback_data: "r:cancel" }]]
    });
    return;
  }
  if (data.startsWith("b:")) {
    await handleBlock(ctx, query, user, Number(data.slice(2)));
    return;
  }
  if (data.startsWith("rep:")) {
    await handleReport(ctx, query, user, Number(data.slice(3)));
    return;
  }
  if (data.startsWith("k:")) {
    const [, rawId, emoji] = data.split(":");
    await handleReaction(ctx, query, user, Number(rawId), emoji ?? "", strictAnon);
    return;
  }
  if (data.startsWith("cont:")) {
    await handleContinue(ctx, query, user, Number(data.slice(5)));
    return;
  }
  await answerCallback(ctx, query.id);
}
async function onCallback(ctx, query) {
  const data = query.data ?? "";
  if (!query.message) {
    await answerCallback(ctx, query.id);
    return;
  }
  const user = await touchUser(ctx.db, query.from, ctx.now);
  const admin = isAdmin(ctx.env, query.from.id);
  const settings = await getSettings(ctx.db);
  const lang = langOf(user);
  if (settings.maintenance && !admin) {
    await answerCallback(ctx, query.id, t(lang, "menu.maintenance"));
    return;
  }
  if (data.startsWith("a:")) {
    await handleAdminCallback(ctx, query, data);
    return;
  }
  await handleUserCallback(ctx, query, user, data, settings.strictAnon);
}

// src/cron.ts
var DAY2 = 86400;
async function maybeSendDigest(ctx) {
  const now = /* @__PURE__ */ new Date();
  if (now.getUTCHours() !== digestHour(ctx.env)) return;
  const settings = await getSettings(ctx.db);
  if (!settings.digest) return;
  const date = now.toISOString().slice(0, 10);
  if (settings.lastDigestDate === date) return;
  if (!await claimDigestDate(ctx.db, date)) return;
  const data = await loadDigest(ctx.db, Math.floor(now.getTime() / 1e3));
  for (const adminId of parseAdminIds(ctx.env)) {
    const admin = await getUser(ctx.db, adminId);
    const lang = normalizeLang(admin?.lang);
    await safeSend(ctx, adminId, renderDigest(data, lang, Math.floor(now.getTime() / 1e3)));
  }
}
async function cleanup(ctx) {
  if ((/* @__PURE__ */ new Date()).getUTCMinutes() !== 7) return;
  const now = Math.floor(Date.now() / 1e3);
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM reply_keys WHERE expires_at <= ?").bind(now),
    ctx.db.prepare("DELETE FROM rate_limits WHERE last_at < ?").bind(now - 2 * DAY2),
    ctx.db.prepare("DELETE FROM sessions WHERE updated_at < ?").bind(now - DAY2),
    ctx.db.prepare("UPDATE messages SET content_preview = NULL WHERE content_preview IS NOT NULL AND created_at < ?").bind(now - contentTtlDays(ctx.env) * DAY2),
    ctx.db.prepare("DELETE FROM reports WHERE status <> 'new' AND reviewed_at IS NOT NULL AND reviewed_at < ?").bind(now - 90 * DAY2),
    ctx.db.prepare("DELETE FROM reaction_events WHERE created_at < ?").bind(now - 7 * DAY2),
    ctx.db.prepare("DELETE FROM broadcast_jobs WHERE status IN ('done', 'stopped') AND updated_at < ?").bind(now - 7 * DAY2)
  ]);
}
async function runCron(env, execution) {
  const ctx = await createCtx(env, "", execution);
  await drainBroadcast(ctx);
  await maybeSendDigest(ctx);
  await cleanup(ctx);
}

// src/index.ts
async function handleUpdate(env, update, origin, execution) {
  const ctx = await createCtx(env, origin, execution);
  if (update.message) {
    await onMessage(ctx, update.message);
    return;
  }
  if (update.callback_query) {
    await onCallback(ctx, update.callback_query);
  }
}
function configured(env) {
  return Boolean(env.BOT_TOKEN && env.BOT_SECRET && env.TELEGRAM_WEBHOOK_SECRET && env.DB);
}
var ZERO_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
var index_default = {
  async fetch(request, env, execution) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ ok: true, configured: configured(env) }), {
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      return new Response("anon-msg-bot is running \u2705", {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    if (!configured(env)) {
      console.error("missing required secrets or bindings");
      return new Response("server is not configured", { status: 503 });
    }
    if (url.pathname === "/__internal/broadcast") {
      const provided = request.headers.get("x-internal-token") ?? "";
      const expected = await hmacHex(env.BOT_SECRET, "internal-broadcast-v1");
      if (!timingSafeEqual(provided, expected)) {
        return new Response("forbidden", { status: 403 });
      }
      const ctx = await createCtx(env, url.origin, execution);
      execution.waitUntil(
        drainBroadcast(ctx).catch((error) => {
          console.error("broadcast drain failed", error instanceof Error ? error.message : String(error));
        })
      );
      return new Response("ok");
    }
    if (url.pathname !== "/" && url.pathname !== "/webhook") {
      return new Response("not found", { status: 404 });
    }
    if (env.DB && env.DB.databaseId === ZERO_DATABASE_ID) {
      console.error("D1 database_id is still the placeholder from wrangler.toml");
      return new Response("D1 binding points to a placeholder database_id", { status: 503 });
    }
    const providedSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!timingSafeEqual(providedSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("forbidden", { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    execution.waitUntil(
      handleUpdate(env, update, url.origin, execution).catch((error) => {
        console.error("update failed", error instanceof Error ? error.message : String(error));
      })
    );
    return new Response("ok");
  },
  async scheduled(_event, env, execution) {
    if (!configured(env)) return;
    execution.waitUntil(
      runCron(env, execution).catch((error) => {
        console.error("cron failed", error instanceof Error ? error.message : String(error));
      })
    );
  }
};
export {
  index_default as default
};
