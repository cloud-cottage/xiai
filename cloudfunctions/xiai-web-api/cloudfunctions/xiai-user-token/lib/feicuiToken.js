'use strict'
/**
 * 玺爱 · **斐萃（feicui）令牌 · HMAC 签名面**（纯函数：零 SDK / 零 IO / 零时钟隐依赖）
 * ============================================================================
 * 形态（自包含、**服务端不存储任何令牌状态**）：
 *
 *     v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, "v1.<payload>"))>
 *
 * payload 恰 7 键：`{v, uid, role, jti, iat, exp, kid}`
 *   · `v`   版本号（数值 `1`；前缀段 `v1` 与之同源）；
 *   · `uid` 目标用户（`u-` ＋ 16 hex；或平台会话 uid），**由服务端派生/校验**，不采信客户端自称；
 *   · `role` `user` / `admin`（下游只读）；
 *   · `jti` 令牌唯一号（吊销单元：把 jti 写进 `config/feicui-token-revoked.json` 即失效）；
 *   · `iat` / `exp` 签发 / 到期（**秒**，UTC epoch；服务端时钟是唯一判据）；
 *   · `kid` 密钥号（轮换单元）。
 *
 * 硬口径（逐条）：
 *   ① **验签即确权**：签名、`exp`、`v`、`kid ∈ 允许集合`、`jti ∉ 吊销名单` 五者同时通过才算 `ok`；
 *      **任何一环失败 ⇒ `ok:false` ＋ 结构化 `reason`**（内部判别码），对外由调用方统一收敛成
 *      `TOKEN_INVALID`（不向客户端区分「过期 / 已吊销 / 签名错」⇒ 防探测）。
 *   ② **fail-closed**：缺 `FEICUI_TOKEN_SECRET` ⇒ 签不出、验不过（`SECRET_MISSING`），**绝不降级放行**。
 *   ③ **密钥只在环境变量**（`FEICUI_TOKEN_SECRET` / `FEICUI_TOKEN_KID`，轮换期可用
 *      `FEICUI_TOKEN_PREVIOUS_SECRET` / `FEICUI_TOKEN_PREVIOUS_KID` 并行验证旧 kid）；
 *      本文件**无任何密钥字面值**、**不打印令牌与密钥**。
 *   ④ **TTL 封闭**：默认 30 天（2592000 s）；允许区间 `[300 s, 90 d]`，越界 ⇒ `TTL_INVALID`（不静默夹取）。
 *   ⑤ **零 IO**：吊销名单由调用方（路由）读文件后**注入**（`verify(token, {revoked})`）⇒ 本文件可被
 *      云函数（签发）与 Serverless 路由（验签）共用，也可离线自检直接执行。
 *   ⑥ **不引第三方库**：只用 Node 内置 `crypto`（`createHmac` / `timingSafeEqual` / `randomBytes`）。
 *
 * 轮换 / 吊销（运维面，见 `config/README.md`）：
 *   · 单个令牌失效 ⇒ 把它的 `jti` 追加进 `config/feicui-token-revoked.json` ⇒ 重新部署；
 *   · 一枚令牌对应的整个用户面失效 ⇒ 换 `FEICUI_TOKEN_SECRET`（新 kid），旧令牌最迟 `exp` 自然死；
 *   · 平滑轮换 ⇒ 把旧密钥/旧 kid 放进 `FEICUI_TOKEN_PREVIOUS_*`，新签一律走当前 kid。
 */

const crypto = require('crypto')

/** 令牌版本（payload `v` 与文本前缀 `v1` 同源；改版本 ⇒ 旧令牌一律 `VERSION_MISMATCH`）。 */
const TOKEN_VERSION = 1
const TOKEN_PREFIX = 'v1'
/** 令牌段数（`v1` / payload / sig）。 */
const TOKEN_PARTS = 3
/** 令牌长度上限（形态护栏；正常令牌 ≈ 250 字符）。 */
const MAX_TOKEN_LENGTH = 4096

const B64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const UID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const JTI_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
const ROLES = Object.freeze(['user', 'admin'])

/** env 名（唯一一处定义点；**值不入仓**）。 */
const ENV_NAMES = Object.freeze({
  SECRET: 'FEICUI_TOKEN_SECRET',
  KID: 'FEICUI_TOKEN_KID',
  PREVIOUS_SECRET: 'FEICUI_TOKEN_PREVIOUS_SECRET',
  PREVIOUS_KID: 'FEICUI_TOKEN_PREVIOUS_KID'
})

/** 当前 kid 缺省值（**不是密钥**；轮换时显式给 `FEICUI_TOKEN_KID`）。 */
const DEFAULT_KID = 'k1'

/** TTL：默认 30 天；下限 5 分钟、上限 90 天（越界 ⇒ 拒，不夹取）。 */
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60
const MIN_TTL_SECONDS = 5 * 60
const MAX_TTL_SECONDS = 90 * 24 * 60 * 60

/** `iat` 允许的时钟余量（只作容差，不作放宽）。 */
const CLOCK_LEEWAY_SECONDS = 60

/** 内部判别码（**结构化 reason**；对外统一 `TOKEN_INVALID`）。 */
const DETAILS = Object.freeze({
  OK: 'OK',
  MISSING: 'MISSING',
  MALFORMED: 'MALFORMED',
  BAD_SIGNATURE: 'BAD_SIGNATURE',
  EXPIRED: 'EXPIRED',
  NOT_YET_VALID: 'NOT_YET_VALID',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  KID_UNKNOWN: 'KID_UNKNOWN',
  REVOKED: 'REVOKED',
  CLAIMS_INVALID: 'CLAIMS_INVALID',
  TTL_INVALID: 'TTL_INVALID',
  SECRET_MISSING: 'SECRET_MISSING',
  CLOCK_UNAVAILABLE: 'CLOCK_UNAVAILABLE'
})

/** 对外唯一失败字面值（路由 / 页面只认这个）。 */
const PUBLIC_REASON = 'TOKEN_INVALID'

/* ---------------------------------------------------------------------------
   小工具
   --------------------------------------------------------------------------- */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function envOf(options) {
  if (options && options.env) return options.env
  return typeof process !== 'undefined' && process.env ? process.env : {}
}

function nowSecondsOf(options) {
  const raw = options && options.nowSeconds !== undefined ? options.nowSeconds : Math.floor(Date.now() / 1000)
  const value = Number(raw)
  return Number.isFinite(value) ? Math.floor(value) : null
}

/** base64url（**无 padding**、无 `+ / =`）。 */
function encodeBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/** 严格解码：字符集 / 规范编码（重编码必须逐字相等）都要过；否则 `null`。 */
function decodeBase64Url(value) {
  if (typeof value !== 'string' || value === '' || !B64URL_PATTERN.test(value)) return null
  let buffer = null
  try {
    buffer = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  } catch {
    return null
  }
  if (!buffer || buffer.length === 0) return null
  /* 非规范编码（尾位不全零 / 含 padding）⇒ 拒：不给「同签名多形态」留口子。 */
  if (encodeBase64Url(buffer) !== value) return null
  return buffer
}

function hmacOf(secret, signingInput) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(signingInput, 'utf8').digest()
}

/** 定长常量时间比较（长度不同 ⇒ 直接 false，不抛）。 */
function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  if (a.length === 0 || a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/* ---------------------------------------------------------------------------
   密钥环（当前 kid ＋ 可选上一个 kid；缺密钥 ⇒ 空环 ⇒ 一切 fail-closed）
   --------------------------------------------------------------------------- */

/**
 * 由 env 造密钥环（**只读布尔/计数可外传，密钥本身永不回吐**）。
 * @param {{env?:object, allowedKids?:string[]}} [options]
 * @returns {{currentKid:string, secrets:Map<string,string>, allowedKids:Set<string>, configured:boolean}}
 */
function keyringOf(options) {
  const env = envOf(options)
  const currentKid = text(env[ENV_NAMES.KID]) || DEFAULT_KID
  const currentSecret = text(env[ENV_NAMES.SECRET])
  const previousKid = text(env[ENV_NAMES.PREVIOUS_KID])
  const previousSecret = text(env[ENV_NAMES.PREVIOUS_SECRET])
  const secrets = new Map()
  if (currentSecret && KID_PATTERN.test(currentKid)) secrets.set(currentKid, currentSecret)
  if (previousSecret && previousKid && KID_PATTERN.test(previousKid) && previousKid !== currentKid) {
    secrets.set(previousKid, previousSecret)
  }
  const requested = options && Array.isArray(options.allowedKids) ? options.allowedKids.map(text).filter(Boolean) : []
  const allowedKids = new Set()
  for (const kid of requested.length > 0 ? requested : Array.from(secrets.keys())) {
    /* **交集**：允许集合里出现但**没有密钥**的 kid 不算数（否则等于放行未签名令牌）。 */
    if (secrets.has(kid)) allowedKids.add(kid)
  }
  return { currentKid, secrets, allowedKids, configured: secrets.size > 0 }
}

/** 诊断读数（**布尔/计数 only**，不参与任何判定、不含密钥）。 */
function keyringStatus(options) {
  const ring = keyringOf(options)
  return {
    configured: ring.configured,
    currentKid: ring.currentKid,
    keyCount: ring.secrets.size,
    previousKidPresent: ring.secrets.size > 1
  }
}

/* ---------------------------------------------------------------------------
   吊销名单
   --------------------------------------------------------------------------- */

/**
 * 归一吊销名单（`[{jti, reason, at}]` / `['jti']` / `Set` / `{revoked:[…]}` 都收）。
 * 只保留形态合法的 `jti`（**不因某条脏数据而放宽**）。
 * @param {*} input
 * @returns {Array<{jti:string, reason:string, at:string}>}
 */
function normalizeRevokedList(input) {
  const source = input && !Array.isArray(input) && typeof input === 'object' && Array.isArray(input.revoked) ? input.revoked : input
  const out = []
  const seen = new Set()
  let items = []
  if (!source) return out
  if (typeof source[Symbol.iterator] === 'function') items = Array.from(source)
  for (const item of items) {
    const jti = text(typeof item === 'string' ? item : item && item.jti)
    if (!JTI_PATTERN.test(jti) || seen.has(jti)) continue
    seen.add(jti)
    out.push({
      jti,
      reason: text(item && typeof item === 'object' ? item.reason : '') || 'REVOKED',
      at: text(item && typeof item === 'object' ? item.at : '')
    })
  }
  return out
}

/** 吊销集合（**判定用**；`Set<string>`）。 */
function revokedSetOf(input) {
  const set = new Set()
  for (const entry of normalizeRevokedList(input)) set.add(entry.jti)
  return set
}

/* ---------------------------------------------------------------------------
   签发
   --------------------------------------------------------------------------- */

/**
 * 签一枚斐萃令牌。
 * @param {{uid:string, role?:string, ttlSeconds?:number, kid?:string, jti?:string,
 *          nowSeconds?:number, secret?:string, env?:object}} input
 * @returns {{ok:true, token:string, uid:string, role:string, kid:string, jti:string,
 *            iat:number, exp:number, expires_at:string, ttl_seconds:number}
 *          |{ok:false, reason:string, message:string}}
 */
function sign(input) {
  const options = input || {}
  const uid = text(options.uid)
  const role = text(options.role) || 'user'
  const ring = keyringOf(options)
  const kid = text(options.kid) || ring.currentKid
  /* kid 形态**先于**密钥解析判：否则「kid 不合」会被误报成「缺密钥」。 */
  if (!KID_PATTERN.test(kid)) {
    return { ok: false, reason: DETAILS.CLAIMS_INVALID, message: '斐萃令牌服務的 kid 形態不合（只允許 [A-Za-z0-9_-]{1,32}）；本次不簽發。' }
  }
  const secret = text(options.secret) || ring.secrets.get(kid) || ''
  if (!secret) {
    return { ok: false, reason: DETAILS.SECRET_MISSING, message: `斐萃令牌服務未配置（缺環境變量：${ENV_NAMES.SECRET}）；本次不簽發。` }
  }
  if (!UID_PATTERN.test(uid) || /\s/.test(uid)) {
    return { ok: false, reason: DETAILS.CLAIMS_INVALID, message: '目標 uid 形態不合（應為 u- 開頭的派生值或平台會話 uid）；本次不簽發。' }
  }
  if (ROLES.indexOf(role) === -1) {
    return { ok: false, reason: DETAILS.CLAIMS_INVALID, message: `角色「${role}」不在允許面（user / admin）之內；本次不簽發。` }
  }
  const ttlRaw = options.ttlSeconds === undefined || options.ttlSeconds === null ? DEFAULT_TTL_SECONDS : Number(options.ttlSeconds)
  if (!Number.isFinite(ttlRaw)) {
    return { ok: false, reason: DETAILS.TTL_INVALID, message: 'TTL 不是可辨識的秒數；本次不簽發。' }
  }
  const ttlSeconds = Math.floor(ttlRaw)
  if (ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    return {
      ok: false,
      reason: DETAILS.TTL_INVALID,
      message: `TTL 超出允許區間（${MIN_TTL_SECONDS}–${MAX_TTL_SECONDS} 秒）；本次不簽發。`
    }
  }
  const now = nowSecondsOf(options)
  if (now === null) {
    return { ok: false, reason: DETAILS.CLOCK_UNAVAILABLE, message: '斐萃令牌服務時鐘不可用；本次不簽發。' }
  }
  const jti = text(options.jti) || `jt-${crypto.randomBytes(12).toString('hex')}`
  if (!JTI_PATTERN.test(jti)) {
    return { ok: false, reason: DETAILS.CLAIMS_INVALID, message: '令牌號（jti）形態不合；本次不簽發。' }
  }
  const iat = now
  const exp = now + ttlSeconds
  const claims = { v: TOKEN_VERSION, uid, role, jti, iat, exp, kid }
  const body = `${TOKEN_PREFIX}.${encodeBase64Url(Buffer.from(JSON.stringify(claims), 'utf8'))}`
  const signature = encodeBase64Url(hmacOf(secret, body))
  return {
    ok: true,
    token: `${body}.${signature}`,
    uid,
    role,
    kid,
    jti,
    iat,
    exp,
    expires_at: new Date(exp * 1000).toISOString(),
    ttl_seconds: ttlSeconds
  }
}

/* ---------------------------------------------------------------------------
   验签
   --------------------------------------------------------------------------- */

function failure(reason, extra) {
  return Object.assign(
    {
      ok: false,
      uid: '',
      role: '',
      exp: 0,
      iat: 0,
      kid: '',
      jti: '',
      reason: reason || PUBLIC_REASON,
      detail: reason || PUBLIC_REASON
    },
    extra || {}
  )
}

/**
 * 验一枚斐萃令牌（**验签即确权**；不查任何库）。
 * @param {string} token
 * @param {{nowSeconds?:number, revoked?:*, env?:object, secret?:string, kid?:string,
 *          previousSecret?:string, previousKid?:string, allowedKids?:string[]}} [options]
 * @returns {{ok:true, uid:string, role:string, exp:number, iat:number, kid:string,
 *            jti:string, reason:string(OK), detail:string(OK)}
 *          |{ok:false, uid:string, role:string, exp:number, iat:number, kid:string,
 *             jti:string, reason:string, detail:string}}
 */
function verify(token, options) {
  const opts = options || {}
  /* ① 时钟（唯一时源；不可用 ⇒ 拒，不猜）。 */
  const now = nowSecondsOf(opts)
  if (now === null) return failure(DETAILS.CLOCK_UNAVAILABLE)
  /* ② 密钥环（缺密钥 ⇒ fail-closed，不降级放行）。 */
  const ring = keyringOf({
    env: opts.env,
    allowedKids: opts.allowedKids
  })
  /* 注入面（离线自检 / 显式密钥）：**注入即入允许集合** —— 但只加有密钥的那个 kid。 */
  if (opts.secret) {
    const injectedKid = text(opts.kid) || ring.currentKid
    ring.secrets.set(injectedKid, text(opts.secret))
    ring.allowedKids.add(injectedKid)
  }
  if (opts.previousSecret && text(opts.previousKid)) {
    const injectedPreviousKid = text(opts.previousKid)
    ring.secrets.set(injectedPreviousKid, text(opts.previousSecret))
    ring.allowedKids.add(injectedPreviousKid)
  }
  if (ring.secrets.size === 0) return failure(DETAILS.SECRET_MISSING)
  /* ③ 形态面。 */
  if (typeof token !== 'string' || token.trim() === '') return failure(DETAILS.MISSING)
  const raw = token.trim()
  if (raw.length > MAX_TOKEN_LENGTH) return failure(DETAILS.MALFORMED)
  const parts = raw.split('.')
  if (parts.length !== TOKEN_PARTS) return failure(DETAILS.MALFORMED)
  if (parts[0] !== TOKEN_PREFIX) return failure(DETAILS.VERSION_MISMATCH, { kid: '' })
  const payloadBytes = decodeBase64Url(parts[1])
  const signatureBytes = decodeBase64Url(parts[2])
  if (!payloadBytes || !signatureBytes) return failure(DETAILS.MALFORMED)
  /* ④ 载荷解析（**先看 kid 再验签**：kid 不在允许集合 ⇒ 连签名都不试）。 */
  let claims = null
  try {
    claims = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    return failure(DETAILS.CLAIMS_INVALID)
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return failure(DETAILS.CLAIMS_INVALID)
  const kid = text(claims.kid)
  if (!KID_PATTERN.test(kid)) return failure(DETAILS.CLAIMS_INVALID, { kid })
  if (!ring.allowedKids.has(kid) || !ring.secrets.has(kid)) return failure(DETAILS.KID_UNKNOWN, { kid })
  /* ⑤ 签名（**先验签，再谈其它声明**）。 */
  const expected = hmacOf(ring.secrets.get(kid), `${TOKEN_PREFIX}.${parts[1]}`)
  if (!safeEqualHex(expected.toString('hex'), signatureBytes.toString('hex'))) {
    return failure(DETAILS.BAD_SIGNATURE, { kid })
  }
  /* ⑥ 版本 / 声明形态。 */
  if (Number(claims.v) !== TOKEN_VERSION) return failure(DETAILS.VERSION_MISMATCH, { kid })
  const uid = text(claims.uid)
  const role = text(claims.role)
  const jti = text(claims.jti)
  const iat = Number(claims.iat)
  const exp = Number(claims.exp)
  if (
    !UID_PATTERN.test(uid) ||
    /\s/.test(uid) ||
    ROLES.indexOf(role) === -1 ||
    !JTI_PATTERN.test(jti) ||
    !Number.isFinite(iat) ||
    !Number.isFinite(exp) ||
    Math.floor(iat) !== iat ||
    Math.floor(exp) !== exp ||
    exp <= iat
  ) {
    return failure(DETAILS.CLAIMS_INVALID, { kid, jti, uid })
  }
  /* ⑦ 有效期（`exp` 是硬边界：`exp === now` 已过期）。 */
  if (exp <= now) return failure(DETAILS.EXPIRED, { kid, jti, uid, role, iat, exp })
  if (iat > now + CLOCK_LEEWAY_SECONDS) return failure(DETAILS.NOT_YET_VALID, { kid, jti, uid, role, iat, exp })
  /* ⑧ 吊销名单（静态名单；命中 ⇒ 拒）。 */
  if (revokedSetOf(opts.revoked).has(jti)) return failure(DETAILS.REVOKED, { kid, jti, uid, role, iat, exp })
  return {
    ok: true,
    uid,
    role,
    exp,
    iat,
    kid,
    jti,
    reason: DETAILS.OK,
    detail: DETAILS.OK
  }
}

module.exports = {
  TOKEN_VERSION,
  TOKEN_PREFIX,
  MAX_TOKEN_LENGTH,
  ENV_NAMES,
  DEFAULT_KID,
  DEFAULT_TTL_SECONDS,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS,
  CLOCK_LEEWAY_SECONDS,
  ROLES,
  DETAILS,
  PUBLIC_REASON,
  keyringOf,
  keyringStatus,
  normalizeRevokedList,
  revokedSetOf,
  sign,
  verify
}
