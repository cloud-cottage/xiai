'use strict'
/**
 * 玺爱 · 管理员令牌 · **签名 / 验签**（写面 Phase 1）
 * ----------------------------------------------------------------------------
 * 硬约束（逐条）：
 *   ① **HMAC 密钥只在云函数环境变量里**（`XIAI_ADMIN_TOKEN_SECRET`）；本文件**不含任何密钥字面值**，
 *      也不把密钥写进任何日志 / 返回值（调用方拿到的只有令牌本体与声明）。
 *   ② **服务端时钟是唯一判据**：`iat` / `exp` **一律由本模块按调用方给的 `now` 生成**；
 *      客户端本地时间**不参与**任何判定（`now` 由 `index.js` 传云函数时钟）。
 *   ③ **结构化拒绝**：本模块**不抛未捕获异常**（§3.12.10(e)⑥ 同族纪律）；一切失败返回
 *      `{ ok:false, detail:'<内部判别码>' }`。**内部判别码只在函数内部与日志里用**，
 *      **绝不原样回给客户端**（防探测 —— 见 `index.js` 的对外文案表）。
 *   ④ **令牌形态**：`<base64url(payload)>.<base64url(hmac-sha256(payload))>`，payload 为 JSON。
 *   ⑤ **时序安全比较**（`crypto.timingSafeEqual`，长度先归一化到固定 32 字节摘要再比）。
 */

const crypto = require('crypto')

/** 令牌格式版本（载荷内 `v` 字段；与密钥轮换用的 `ver` 不是一回事）。 */
const TOKEN_FORMAT_VERSION = 1

/** 段数（令牌恒为恰 2 段：载荷 + 签名）。 */
const PART_COUNT = 2

/**
 * 内部判别码（**只在函数内部 / 日志里出现**，不回客户端）。
 * 取值面封闭：新增取值须同轮登记。
 */
const TOKEN_DETAILS = Object.freeze({
  MISSING: 'TOKEN_MISSING',
  MALFORMED: 'TOKEN_MALFORMED',
  BAD_SIGNATURE: 'TOKEN_BAD_SIGNATURE',
  EXPIRED: 'TOKEN_EXPIRED',
  NOT_YET_VALID: 'TOKEN_NOT_YET_VALID',
  VERSION_MISMATCH: 'TOKEN_VERSION_MISMATCH',
  SUBJECT_MISSING: 'TOKEN_SUBJECT_MISSING'
})

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(segment) {
  const normalized = String(segment).replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  return Buffer.from(normalized + padding, 'base64')
}

/** 令牌段是否只含 base64url 字符（避免把奇怪输入喂进 Buffer 解码）。 */
function isBase64urlSegment(segment) {
  return typeof segment === 'string' && segment.length > 0 && /^[A-Za-z0-9_-]+$/.test(segment)
}

/** 载荷 → 段（**确定性**：键序固定 ⇒ 同一声明恒得同一段）。 */
function encodePayload(claims) {
  return base64url(Buffer.from(JSON.stringify(claims), 'utf8'))
}

function signPayloadSegment(payloadSegment, secret) {
  return base64url(crypto.createHmac('sha256', String(secret)).update(payloadSegment).digest())
}

/** 摘要后比较（长度恒定、无短路 ⇒ 不泄漏「哪一位不同」）。 */
function digestEquals(left, right) {
  const a = crypto.createHash('sha256').update(String(left), 'utf8').digest()
  const b = crypto.createHash('sha256').update(String(right), 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}

/**
 * 签发令牌。
 * @param {{sub:string, secret:string, nowSeconds:number, ttlSeconds:number, version:string, role?:string, jti?:string}} input
 * @returns {{ok:true, token:string, claims:object}|{ok:false, detail:string}}
 */
function issueToken(input) {
  const secret = input && input.secret ? String(input.secret) : ''
  const sub = input && input.sub ? String(input.sub) : ''
  if (!secret) return { ok: false, detail: 'SECRET_MISSING' }
  if (!sub) return { ok: false, detail: TOKEN_DETAILS.SUBJECT_MISSING }
  const now = Math.floor(Number(input.nowSeconds))
  if (!Number.isFinite(now)) return { ok: false, detail: 'CLOCK_UNAVAILABLE' }
  const ttl = Math.floor(Number(input.ttlSeconds))
  if (!Number.isFinite(ttl) || ttl <= 0) return { ok: false, detail: 'TTL_UNAVAILABLE' }
  const claims = {
    v: TOKEN_FORMAT_VERSION,
    sub,
    role: input.role ? String(input.role) : 'admin',
    iat: now,
    exp: now + ttl,
    jti: input.jti ? String(input.jti) : crypto.randomUUID(),
    ver: input.version ? String(input.version) : '1'
  }
  const payloadSegment = encodePayload(claims)
  return { ok: true, token: `${payloadSegment}.${signPayloadSegment(payloadSegment, secret)}`, claims }
}

/**
 * 验签 + 验有效期 + 验密钥版本。
 * **不做白名单判定**（那属 `index.js` 的授权面；此处只判「令牌本身是否成立」）。
 * @param {{token:string, secret:string, nowSeconds:number, leewaySeconds?:number, version?:string}} input
 * @returns {{ok:true, claims:object}|{ok:false, detail:string}}
 */
function verifyToken(input) {
  const secret = input && input.secret ? String(input.secret) : ''
  if (!secret) return { ok: false, detail: 'SECRET_MISSING' }
  const raw = input && input.token
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: false, detail: TOKEN_DETAILS.MISSING }
  }
  const parts = String(raw).trim().split('.')
  if (parts.length !== PART_COUNT) return { ok: false, detail: TOKEN_DETAILS.MALFORMED }
  const [payloadSegment, signatureSegment] = parts
  if (!isBase64urlSegment(payloadSegment) || !isBase64urlSegment(signatureSegment)) {
    return { ok: false, detail: TOKEN_DETAILS.MALFORMED }
  }
  if (!digestEquals(signatureSegment, signPayloadSegment(payloadSegment, secret))) {
    return { ok: false, detail: TOKEN_DETAILS.BAD_SIGNATURE }
  }
  let claims = null
  try {
    claims = JSON.parse(fromBase64url(payloadSegment).toString('utf8'))
  } catch {
    return { ok: false, detail: TOKEN_DETAILS.MALFORMED }
  }
  if (!claims || typeof claims !== 'object') return { ok: false, detail: TOKEN_DETAILS.MALFORMED }
  /** 格式版本：本模块只认 `v === TOKEN_FORMAT_VERSION`（认不出 ⇒ 不给「同义异名」的机会）。 */
  if (Number(claims.v) !== TOKEN_FORMAT_VERSION) return { ok: false, detail: TOKEN_DETAILS.MALFORMED }
  /** 密钥版本（撤销面）：与环境里的现行版本不符 ⇒ 旧令牌即刻失效。 */
  if (input.version !== undefined && String(claims.ver) !== String(input.version)) {
    return { ok: false, detail: TOKEN_DETAILS.VERSION_MISMATCH }
  }
  const now = Math.floor(Number(input.nowSeconds))
  if (!Number.isFinite(now)) return { ok: false, detail: 'CLOCK_UNAVAILABLE' }
  const exp = Math.floor(Number(claims.exp))
  const iat = Math.floor(Number(claims.iat))
  if (!Number.isFinite(exp) || !Number.isFinite(iat)) return { ok: false, detail: TOKEN_DETAILS.MALFORMED }
  const leeway = Number.isFinite(Number(input.leewaySeconds)) ? Math.max(0, Math.floor(Number(input.leewaySeconds))) : 0
  /* 余量只作「时钟抖动 / 跨实例」容差，**不作放宽**：过期判定以 `exp + leeway` 为界。 */
  if (now > exp + leeway) return { ok: false, detail: TOKEN_DETAILS.EXPIRED }
  if (iat > now + leeway) return { ok: false, detail: TOKEN_DETAILS.NOT_YET_VALID }
  return { ok: true, claims }
}

module.exports = {
  TOKEN_FORMAT_VERSION,
  TOKEN_DETAILS,
  issueToken,
  verifyToken,
  digestEquals,
  base64url,
  fromBase64url
}
