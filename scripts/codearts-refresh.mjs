#!/usr/bin/env node
// CodeArts（华为云）STS 令牌续期。
//
// 背景：渠道包只在 401 时触发续期，而华为这里过期返回的是
// 400 + APIG.0602 "the security token has expired"，于是凭据过了
// expires_at 之后就再也没人去换，所有 codearts 模型开始"操作失败"。
// 这个脚本按 expires_at 判断，提前把 access_key_id / secret_access_key /
// security_token / refresh_token 一整套换新，按行写回 .credentials.yaml。
//
// 用法：
//   node scripts/codearts-refresh.mjs                 # 只续期将要过期的（提前 30 分钟）
//   node scripts/codearts-refresh.mjs --force         # 强制续期全部 codearts 账号
//   node scripts/codearts-refresh.mjs --dry           # 只看状态，不联网不写盘
//   node scripts/codearts-refresh.mjs --file <path>   # 指定凭据文件（默认 ~/.dsh/.credentials.yaml）
//
// 依赖：只用 node 内置模块。ES256 签名自己拼（不依赖 jose）。

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createPrivateKey, sign as cryptoSign, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STS_TOKEN_ENDPOINT = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';
const CLIENT_ID = 'codearts-agent';
const GRANT_REFRESH_TOKEN = 'refresh_token';
const TIMEOUT_MS = 20000;
const EARLY_MS = 30 * 60 * 1000; // 提前 30 分钟续，别等真的过期

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const dry = argv.includes('--dry');
const fileArg = argv.indexOf('--file');
const credPath = fileArg >= 0 && argv[fileArg + 1]
  ? argv[fileArg + 1]
  : join(homedir(), '.dsh', '.credentials.yaml');

const REF_LINE_RE = /^(\s{2})(CODEARTS_[A-Z0-9_]+):\s*'(.*)'\s*$/;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// node 的 ECDSA 签名是 DER，JWS 要 R||S 定长拼接。
function derToJose(der, size = 32) {
  let off = 0;
  if (der[off++] !== 0x30) throw new Error('bad DER');
  if (der[off] & 0x80) off += 1 + (der[off] & 0x7f); else off += 1;
  const readInt = () => {
    if (der[off++] !== 0x02) throw new Error('bad DER int');
    let len = der[off++];
    let start = off;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | der[off++];
      start = off;
    }
    let end = start + len;
    while (end - start > size) start++;
    const out = Buffer.alloc(size);
    der.copy(out, size - (end - start), start, end);
    off = end;
    return out;
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

function signDpop(jwk, htm, htu) {
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
  const payload = { htm, htu, iat: Math.floor(Date.now() / 1000), jti: randomBytes(32).toString('hex') };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const der = cryptoSign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'der' });
  return `${signingInput}.${b64url(derToJose(der))}`;
}

async function refreshCredential(cred) {
  const dpop = signDpop(cred.dpop_private_key_jwk, 'POST', STS_TOKEN_ENDPOINT);
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    code_verifier: cred.code_verifier,
    grant_type: GRANT_REFRESH_TOKEN,
    refresh_token: cred.refresh_token,
  }).toString();
  const res = await fetch(STS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { DPoP: dpop, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data?.credentials) {
    const msg = `STS ${res.status}${data ? ' ' + JSON.stringify(data) : ''}`;
    const err = new Error(msg);
    const code = String(data?.error_code ?? '');
    err.terminal = data?.error === 'invalid_grant' || code.includes('ExpiredRefreshToken');
    throw err;
  }
  return {
    access_key_id: data.credentials.access_key_id ?? '',
    secret_access_key: data.credentials.secret_access_key ?? '',
    security_token: data.credentials.security_token ?? '',
    expires_at: data.credentials.expiration ?? '',
    refresh_token: data.refresh_token,
    code_verifier: cred.code_verifier,
    dpop_private_key_jwk: cred.dpop_private_key_jwk,
  };
}

const rows = [];
const text = readFileSync(credPath, 'utf8');
let changed = 0;
const lines = text.split('\n');
const out = [];

for (const line of lines) {
  const m = REF_LINE_RE.exec(line);
  if (!m) { out.push(line); continue; }
  const [, indent, ref, raw] = m;
  let cred;
  try { cred = JSON.parse(raw); } catch { out.push(line); continue; }
  const exp = cred.expires_at ? Date.parse(cred.expires_at) : NaN;
  const left = Number.isFinite(exp) ? exp - Date.now() : NaN;
  const row = { ref, expiresAt: cred.expires_at ?? null, minutesLeft: Number.isFinite(left) ? Math.round(left / 60000) : null };
  rows.push(row);

  const ready = Boolean(cred.refresh_token && cred.code_verifier && cred.dpop_private_key_jwk);
  if (dry) { row.action = ready ? 'would-check' : 'no-refresh-material'; out.push(line); continue; }
  if (!ready) { row.action = 'no-refresh-material'; out.push(line); continue; }
  if (!force && Number.isFinite(left) && left > EARLY_MS) { row.action = 'fresh'; out.push(line); continue; }

  try {
    const next = await refreshCredential(cred);
    row.action = 'refreshed';
    row.newExpiresAt = next.expires_at;
    row.akChanged = next.access_key_id !== cred.access_key_id;
    out.push(`${indent}${ref}: '${JSON.stringify(next)}'`);
    changed++;
  } catch (err) {
    row.action = 'failed';
    row.error = String(err.message).slice(0, 300);
    row.terminal = Boolean(err.terminal);
    out.push(line);
  }
}

if (!dry && changed > 0) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(credPath, `${credPath}.bak-codearts-${stamp}`);
  writeFileSync(credPath, out.join('\n'));
}

console.log(JSON.stringify({ file: credPath, dry, force, refreshed: changed, accounts: rows }, null, 2));
process.exit(rows.some((r) => r.action === 'failed') ? 1 : 0);
