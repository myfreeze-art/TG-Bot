// Криптография: псевдонимы отправителей и зашифрованные ссылки для ответов.
// Всё на Web Crypto — работает и в Workers, и в Node 20+.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();
const refKeyCache = new Map<string, Promise<CryptoKey>>();

export function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomToken(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  let cached = hmacKeyCache.get(secret);
  if (!cached) {
    cached = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeyCache.set(secret, cached);
  }
  return cached;
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(data));
  return toHex(signature);
}

export async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return toHex(digest);
}

/**
 * Стабильный необратимый псевдоним отправителя.
 * Нужен для лимитов, блокировок и банов. Не является Telegram id.
 */
export async function senderKey(secret: string, userId: number): Promise<string> {
  const digest = await hmacHex(secret, `sender:v1:${userId}`);
  return digest.slice(0, 32);
}

async function deriveRefKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('anon-msg-bot/ref/salt/v1'),
      info: encoder.encode('sender-ref'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function refKey(secret: string): Promise<CryptoKey> {
  let cached = refKeyCache.get(secret);
  if (!cached) {
    cached = deriveRefKey(secret);
    refKeyCache.set(secret, cached);
  }
  return cached;
}

/** AES-256-GCM: iv(12) || ciphertext, base64url. */
export async function encryptSenderRef(secret: string, userId: number): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode('anon-msg-bot:v1') },
    await refKey(secret),
    encoder.encode(String(userId)),
  );
  const payload = new Uint8Array(iv.length + ciphertext.byteLength);
  payload.set(iv, 0);
  payload.set(new Uint8Array(ciphertext), iv.length);
  return toBase64Url(payload);
}

export async function decryptSenderRef(secret: string, ref: string): Promise<number> {
  const payload = fromBase64Url(ref);
  if (payload.length < 13) throw new Error('bad ref');
  const iv = payload.slice(0, 12);
  const ciphertext = payload.slice(12);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode('anon-msg-bot:v1') },
    await refKey(secret),
    ciphertext,
  );
  const userId = Number(decoder.decode(plain));
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('bad ref payload');
  return userId;
}
