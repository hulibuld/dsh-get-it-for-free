/**
 * 手写 COSY 信封签名（替代 WASM 签名路径）。
 *
 * 上游每个请求都带 `Authorization: Bearer COSY.<payload>.<sig>`：
 *   1. 账号信息打包成 JSON，用一次性 AES-128-CBC 加密（密钥即 IV）→ `info`；
 *      该密钥再用客户端内置 RSA 公钥加密 → `key`
 *   2. payload = base64(JSON{v1, requestId, info, cosyVersion, ideVersion:""})
 *   3. sig = md5(`${payload}\n${key}\n${ts}\n${body}\n${path}`)
 *
 * 请求体还会经过一套自定义字母表 + 三段交换的编码（`Encode=1`），
 * 签名对的是**编码后的 wire body**。
 *
 * 移植自 @magpie-community/opencode-qoder-auth（MIT，见 THIRD-PARTY-NOTICES.md），
 * 字段与客户端 1.2.0 实测一致。
 *
 * @module dsh-qwenwork-connect/cosy
 */

import {
  constants,
  createCipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from 'node:crypto';

/** 客户端内置的 RSA 公钥，只用来包裹每次请求的 AES 密钥。 */
export const COSY_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/** 自定义编码字母表（`Encode=1`）。 */
const ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const PAD = '$';

/**
 * 把请求体编码成上游 wire 形态。
 * @param {string} text
 * @returns {string}
 */
export function encodeBody(text) {
  return swapThirds(segmentEncode(new TextEncoder().encode(text)));
}

/**
 * 把上游 wire 形态解回明文（响应体可能被同样编码）。
 * @param {string} wire
 * @returns {string}
 */
export function decodeBody(wire) {
  const s = swapThirds(wire);
  const out = [];
  for (let g = 0; g + 4 <= s.length; g += 4) {
    const vals = [...s.slice(g, g + 4)].filter((c) => c !== PAD).map((c) => ALPHABET.indexOf(c));
    if (vals.some((v) => v < 0)) {
      throw new Error('qwenwork: body 含未知字符，不是 COSY 编码');
    }
    let x = 0;
    for (const v of vals) x = x * 64 + v;
    const n = Math.floor((6 * vals.length) / 8);
    for (let k = 0; k < n; k++) {
      out.push(Math.floor(x / 2 ** (6 * vals.length - 8 * (k + 1))) & 255);
    }
  }
  return new TextDecoder().decode(new Uint8Array(out));
}

/** 字符串看起来像 COSY 编码（而不是明文 JSON/SSE）。 */
export function looksEncoded(text) {
  const t = String(text ?? '').trim();
  if (t === '') return false;
  if (t.startsWith('{') || t.startsWith('[')) return false;
  return [...t].every((c) => c === PAD || ALPHABET.includes(c));
}

/**
 * 生成一次请求的 COSY 头。
 *
 * @param {object} params
 * @param {string} params.url 完整请求 URL（签名时去掉 `/algo` 前缀）
 * @param {any} params.credential 归一化凭据（token / user / loginDeviceId）
 * @param {string} params.machineId
 * @param {string} params.cosyVersion
 * @param {string} [params.body] wire body（GET 为空串）
 * @param {'chat'|'json'} [params.mode]
 * @param {string} [params.modelKey] chat 模式必填
 * @returns {{ headers: Record<string,string>, payload: string, signature: string }}
 */
export function buildCosyHeaders(params) {
  const credential = params.credential ?? {};
  const user = credential.user ?? {};
  const uid = String(user.uid ?? user.id ?? '');
  const token = typeof credential.token === 'string' ? credential.token : '';
  if (uid === '' || token === '') {
    throw new Error('qwenwork: COSY 签名缺少 uid 或 token');
  }
  const machineId = String(params.machineId ?? '');
  if (machineId === '') throw new Error('qwenwork: COSY 签名缺少 machineId');

  const { info, key } = buildUserBlob({ uid, user, token });
  const payload = Buffer.from(
    JSON.stringify({
      version: 'v1',
      requestId: randomUUID(),
      info,
      cosyVersion: params.cosyVersion,
      ideVersion: '',
    }),
  ).toString('base64');

  const path = signedPath(params.url);
  const ts = Math.floor(Date.now() / 1000);
  const body = params.body ?? '';
  const signature = createHash('md5')
    .update(`${payload}\n${key}\n${ts}\n${body}\n${path}`)
    .digest('hex');

  const headers = {
    Accept: params.mode === 'chat' ? 'text/event-stream' : 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer COSY.${payload}.${signature}`,
    'Cosy-Business-Product': 'qoder_work',
    'Cosy-Business-Type': 'agent',
    'Cosy-ClientType': '6',
    'Cosy-Data-Policy': user.data_policy_agreed === false ? 'disagree' : 'agree',
    'Cosy-Date': String(ts),
    'Cosy-Key': key,
    'Cosy-MachineId': machineId,
    'Cosy-MachineToken': machineId,
    'Cosy-MachineType': '5',
    ...(typeof user.organization_id === 'string' && user.organization_id !== ''
      ? { 'Cosy-Organization-Id': user.organization_id }
      : {}),
    'Cosy-Scene': 'assistant',
    'Cosy-User': uid,
    'Cosy-Version': params.cosyVersion,
    'Login-Version': 'v2',
  };

  if (params.mode === 'chat') {
    headers['Cache-Control'] = 'no-cache';
    headers.Connection = 'keep-alive';
    if (typeof params.modelKey === 'string' && params.modelKey !== '') {
      headers['X-Model-Key'] = params.modelKey;
    }
  }

  return { headers, payload, signature };
}

/** 账号信息信封：AES-128-CBC（密钥=IV）+ RSA 包裹密钥。 */
function buildUserBlob({ uid, user, token }) {
  const raw = JSON.stringify({
    uid,
    aid: '',
    name: typeof user.name === 'string' ? user.name : '',
    email: typeof user.email === 'string' ? user.email : '',
    security_oauth_token: token,
  });
  const key = Buffer.from(randomBytes(8).toString('hex').slice(0, 16));
  const cipher = createCipheriv('aes-128-cbc', key, key);
  const info = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]).toString('base64');
  const wrapped = publicEncrypt(
    { key: COSY_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
    key,
  ).toString('base64');
  return { info, key: wrapped };
}

/** 签名用的 path：去掉 `/algo` 前缀，不带 query。 */
function signedPath(url) {
  let path = new URL(url).pathname;
  if (path.startsWith('/algo')) path = path.slice(5);
  return path;
}

/** 自定义 base64：6 bit 一组，用私有字母表。 */
function segmentEncode(bytes) {
  let s = '';
  let acc = 0;
  let nb = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffffff;
    nb += 8;
    while (nb >= 6) {
      nb -= 6;
      s += ALPHABET[(acc >> nb) & 63];
    }
  }
  if (nb > 0) s += ALPHABET[(acc << (6 - nb)) & 63];
  while (s.length % 4) s += PAD;
  return s;
}

/** 三段交换。 */
function swapThirds(s) {
  const t = Math.floor(s.length / 3);
  return t ? s.slice(s.length - t) + s.slice(t, s.length - t) + s.slice(0, t) : s;
}
