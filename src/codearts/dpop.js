/**
 * CodeArts 登录用的 DPoP proof（ES256，P-256）。
 *
 * 为什么这把私钥必须落盘：STS 把 refresh_token 绑在首次换取时提交的 DPoP 公钥上，
 * 续期时换了钥匙就直接回 InvalidDPoPHeader —— 不是「签名不合法」，是「不是同一把」。
 * 所以私钥不是一次性的会话材料，而是账号凭据的一部分，跟着 refresh_token 一起存。
 *
 * 为什么签名后还要做 low-S 归一化：同一组 (r, s) 与 (r, n-s) 都是合法 ECDSA 签名，
 * 但 JOSE 侧（RFC 7518）要求 s 落在低半区；不归一化时华为 STS 会对同一份 proof
 * 时灵时不灵，现象是「有时能登录、有时 InvalidDPoPHeader」，很难查。
 *
 * 为什么用 dsaEncoding: 'ieee-p1363'：Node 默认吐 DER，而 JWS 要的是 r||s 各 32 字节。
 * 让它直接吐裸 r||s，省掉一次手写 DER 解析。
 *
 * @module src/codearts/dpop
 */

import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

/** P-256 的阶 n。low-S 归一化要拿它和 s 比大小、要拿它算 n-s。 */
export const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

/** n/2：s 超过它就算「高 S」，换成 n-s。 */
const P256_HALF = P256_ORDER >> 1n

/** 裸签名长度：r 32 字节 + s 32 字节。 */
const RAW_SIGNATURE_BYTES = 64

/**
 * @param {string} value
 * @returns {string}
 */
function b64u(value) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/**
 * 签名字节走这里：先 utf8 再 base64url 会把 0x80 以上的字节改成 U+FFFD，
 * 而 ES256 签名几乎每个都含高位字节 —— 一步写错就是「签名永远校验不过」。
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
function b64uBytes(bytes) {
  return bytes.toString('base64url')
}

/**
 * 新生成一把 DPoP 私钥，导出成 JWK。
 *
 * 只保留 kty/crv/x/y/d：JWK 里其它字段（kid、key_ops、ext）对 STS 没用，
 * 存进账号文件只是多几个可能被下游误读的字段。
 *
 * @returns {{kty: string, crv: string, x: string, y: string, d: string}}
 */
export function newDPoPPrivateJWK() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  return {
    kty: 'EC',
    crv: 'P-256',
    x: String(jwk.x ?? ''),
    y: String(jwk.y ?? ''),
    d: String(jwk.d ?? ''),
  }
}

/**
 * 形态检查：能拿来签名的最小条件。d 缺了就是只有公钥，签名必然失败。
 *
 * @param {unknown} jwk
 * @returns {boolean}
 */
export function isDPoPPrivateJWK(jwk) {
  if (jwk === null || typeof jwk !== 'object') return false
  const row = /** @type {Record<string, unknown>} */ (jwk)
  return row.kty === 'EC' && row.crv === 'P-256' &&
    typeof row.x === 'string' && row.x !== '' &&
    typeof row.y === 'string' && row.y !== '' &&
    typeof row.d === 'string' && row.d !== ''
}

/**
 * 公钥部分（proof header 里那个 jwk）。绝不能带 d —— 带了就把私钥发出去了。
 *
 * @param {{kty: string, crv: string, x: string, y: string, d?: string}} jwk
 * @returns {{kty: string, crv: string, x: string, y: string}}
 */
export function publicJwkOf(jwk) {
  if (!isDPoPPrivateJWK(jwk)) throw new Error('DPoP 私钥不完整（缺 kty/crv/x/y/d）')
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
}

/**
 * 把 64 字节裸签名按 low-S 归一化。
 *
 * 高 S 的数量级是随机的，约一半签名会被翻；不翻的那一半恰好能用，
 * 于是问题只在「有时」出现 —— 这就是要在落库前、发请求前都统一处理的原因。
 *
 * @param {Buffer} signature - ieee-p1363 输出，r||s
 * @returns {Buffer}
 */
export function normalizeLowS(signature) {
  if (!Buffer.isBuffer(signature) || signature.length !== RAW_SIGNATURE_BYTES) {
    throw new Error(`DPoP 签名长度异常：期望 ${RAW_SIGNATURE_BYTES} 字节 r||s`)
  }
  const s = BigInt(`0x${signature.subarray(32, 64).toString('hex')}`)
  if (s <= P256_HALF) return signature
  const out = Buffer.alloc(RAW_SIGNATURE_BYTES)
  signature.copy(out, 0, 0, 32)
  Buffer.from((P256_ORDER - s).toString(16).padStart(64, '0'), 'hex').copy(out, 32)
  return out
}

/**
 * 生成一个 DPoP proof JWT。
 *
 * iat 用秒（JOSE 口径）；jti 每次随机，因为 STS 会把同一 jti 的重复 proof 当重放拒掉，
 * 而续期与登录可能在同一秒内发生。
 *
 * @param {{kty: string, crv: string, x: string, y: string, d?: string}} privateJwk
 * @param {string} htu - 目标端点完整 URL，必须与实际请求地址逐字一致（含路径）
 * @param {{htm?: string, now?: number}} [options]
 * @returns {string}
 */
export function signDpopProof(privateJwk, htu, options = {}) {
  const htm = typeof options.htm === 'string' ? options.htm : 'POST'
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwkOf(privateJwk) }
  const payload = { htm, htu, iat: Math.floor(now / 1000), jti: randomBytes(16).toString('hex') }
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`
  const key = createPrivateKey({ key: { ...privateJwk, kty: 'EC', crv: 'P-256' }, format: 'jwk' })
  const raw = sign('sha256', Buffer.from(input, 'utf8'), { key, dsaEncoding: 'ieee-p1363' })
  return `${input}.${b64uBytes(normalizeLowS(raw))}`
}
