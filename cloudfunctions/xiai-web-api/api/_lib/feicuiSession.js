/**
 * 玺爱 · **斐萃换签端点**（`POST /api/xiai/feicui/v1/session/{refresh,device-token}`）
 * ============================================================================
 * 为什么是这两个端点：斐萃桌面版（`local-dist/src/shadow/renew.py`）启动时要「零点击续签」——
 *   ① 钥匙串里的 `refresh_token` → 换新平台会话；
 *   ② 新会话 → 换一枚 **168 小时（7 天）斐萃设备令牌**（`ttl_seconds = 604800`）。
 *   两步都必须是**服务端**动作：平台 `refresh_token` 的换发要用 `client_id`（＝环境 Id）与区域
 *   端点信息，且**斐萃侧永不持有任何密钥**；设备令牌的签名密钥更只能待在服务端。
 *
 * 路由承载：本模块被 `api/feicui/v1/[...path].js` 在**方法门之前**分流 ⇒
 *   · Vercel：`POST /api/feicui/v1/session/refresh`
 *   · 云开发 HTTP 访问服务（网关 `/api/xiai` 剥前缀后补回 `/api`）：
 *     `POST /api/xiai/feicui/v1/session/refresh`
 *   两者落到**同一份** handler（`cloudfunctions/xiai-web-api/api/**` 与仓内 `api/**` 逐字节相同）。
 *
 * ── 逐字契约 ────────────────────────────────────────────────────────────────
 * ① `POST .../session/refresh`
 *    入参（JSON，封闭键面）：`{refresh_token:<string 非空>, phone?:<11 位>}`
 *    成功 200：`{ok:true, access_token, phone, expires_at}` —— **恰 4 键**；
 *      `phone` 是**平台验签后**的真实号（取不到 ⇒ `''`），**绝不回显客户端自报值**；
 *      **不回 refresh_token、不回任何密钥**。
 *    凭据失效 401：`{ok:false, reason:'REFRESH_INVALID'}`（**只有平台明确判 invalid_grant 一族**）
 *    平台不可用 502：`{ok:false, reason:'UPSTREAM_ERROR'}`（网络 / 超时 / 5xx / 429 / 回体不可解 ——
 *      **绝不把故障谎报成「凭据无效」**，否则桌面版会把好凭据清掉）
 *    配置缺失 503：`{ok:false, reason:'CONFIG_MISSING'}`（缺环境 Id —— 内部配置故障，非凭证判定）
 *    入参非法 400：`{ok:false, reason:'INVALID_FIELD'}` 且**零上游调用**
 *
 * ② `POST .../session/device-token`
 *    入参（JSON，封闭键面，二选一）：`{access_token, phone?}` / `{refresh_token}`；
 *      兼容别名 `session_token`（＝`access_token`，只为让已实现的桌面端少改一行；**不是新通道**）
 *    成功 200：`{ok:true, token, expires_at}` —— **恰 3 键**；`token` 的 claims / 签名与
 *      `issueFeicuiDeviceToken`（云函数 op）**逐字节同源**（`{v,uid,roles,iat,exp,jti}` ＋ 2 段
 *      HMAC-SHA256），TTL 恒 `604800`（168 小时 / 7 天）。
 *    无会话 401：`{ok:false, reason:'LOGIN_REQUIRED'}`；非管理员 403：`{ok:false, reason:'FORBIDDEN'}`；
 *    平台不可用 502 / 配置缺失 503 / 入参非法 400 同上。
 *
 * ── 硬约束（逐条可判） ──────────────────────────────────────────────────────
 *   · **零数据库**：本模块不 require 任何 SDK、不取集合句柄、不写任何行（`options.db` 若被注入，
 *     本模块**一次都不碰**；自检对假 DB 做零调用断言）。
 *   · **零日志带令牌**：审计只落 `{tag, route, outcome, status}` 四个键，**无令牌 / 无手机号 /
 *     无 refresh_token**；模块内不 `console.log` 任何请求体。
 *   · **区域不写死**：读 `XIAI_AUTH_REGION` → `TCB_REGION` → 默认 `ap-shanghai`（与
 *     `cloudfunctions/xiai-user-token/lib/config.js::readAuthRegion` **同序、同正则、同默认值**；
 *     自检对该函数逐值对拍等价）。环境 Id 读 `TCB_ENV` → `SCF_NAMESPACE` → `CLOUDBASE_ENV_ID`
 *     （同 `config.js::readEnvId`）。
 *   · **自包含**：只依赖 Node 内置（`node:https` / `node:crypto`）＋ 注入缝 ⇒ 本文件可以**逐字节
 *     复制**到 `cloudfunctions/xiai-web-api/api/_lib/`（两个宿主的相对路径都成立）。
 *     与仓内权威实现的**等价性**由 `scripts/verify-feicui-session-endpoints.mjs` 逐值对拍
 *     （`uidOf` / `readAuthRegion` / `readEnvId` / claims 构造 / 2 段签名逐个比字节）。
 *   · **限流**：本模块**不做**限流 —— 转发路由那套 `createUidLimiter` 按 uid 计，而这里在验签
 *     之前没有 uid（键只能落到「凭据指纹 / 源地址」，属新的配额口径）。已在交付报告里如实登记，
 *     不假装有。
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'
import https from 'node:https'

/* ---------------------------------------------------------------------------
   常量面（封闭；自检逐值断言）
   ------------------------------------------------------------------------- */

/** 路由段（`/session/<route>`；唯一一处定义点）。 */
export const SESSION_SEGMENT = 'session'

/** 允许的子路由（封闭两值）。 */
export const SESSION_ROUTES = Object.freeze(['refresh', 'device-token'])

/** 对外 reason 面（封闭 7 值；全部是既有词汇，零新造词）。 */
export const REASONS = Object.freeze({
  INVALID_FIELD: 'INVALID_FIELD',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  REFRESH_INVALID: 'REFRESH_INVALID',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  CONFIG_MISSING: 'CONFIG_MISSING'
})

/** 设备令牌 TTL：168 小时 / 7 天（**唯一一处定义点**；与 `/connect` 的 `FEICUI_DEVICE_TTL.sessionSeconds` 同值）。 */
export const DEVICE_TTL_SECONDS = 168 * 60 * 60

/**
 * `buildDeviceClaims` 的**缺省** TTL：30 天。
 * 与 `ops.js::buildFeicuiDeviceTokenClaims` 的缺省**逐字一致**（自检 D6 钉住）——
 * 168 小时（7 天）是本通道**显式传入**的值（见 device-token 路由），不是缺省。
 */
export const DEVICE_TTL_FALLBACK_SECONDS = 30 * 24 * 60 * 60

/** 平台 auth 段（契约逐字；与 `lib/platformAuth.js` 同源语义）。 */
export const PLATFORM = Object.freeze({
  HOST_SUFFIX: '.tcb-api.tencentcloudapi.com',
  TOKEN_PATH: '/auth/v1/token',
  ME_PATH: '/auth/v1/user/me',
  DEFAULT_REGION: 'ap-shanghai'
})

/** 区域候选（同序同值：`lib/config.js::AUTH_REGION_NAMES`）。 */
export const AUTH_REGION_ENV_NAMES = Object.freeze(['XIAI_AUTH_REGION', 'TCB_REGION'])
/** 环境 Id 候选（同序同值：`lib/config.js::ENV_ID_NAMES`）。 */
export const ENV_ID_ENV_NAMES = Object.freeze(['TCB_ENV', 'SCF_NAMESPACE', 'CLOUDBASE_ENV_ID'])
/** 设备令牌签名密钥的 env 兼底名（同值：`ops.js::FEICUI_DEVICE_TOKEN_SECRET_ENV` / 斐萃影子库 `SHADOW_TOKEN_SECRET`）。 */
export const DEVICE_SECRET_ENV = 'SHADOW_TOKEN_SECRET'
/** 管理员白名单的 env 名（同值：`lib/config.js::ENV_NAMES.ADMIN_PHONE`）。 */
export const ADMIN_PHONE_ENV = 'XIAI_ADMIN_PHONE'

/** 载荷封闭键面（**逐路由**；出现表外键 ⇒ `INVALID_FIELD`，如实报回不静默丢键）。 */
export const ALLOWED_KEYS = Object.freeze({
  refresh: Object.freeze(['refresh_token', 'phone']),
  'device-token': Object.freeze(['access_token', 'phone', 'refresh_token', 'session_token'])
})

/** 请求体上限（换签载荷只有一枚凭据；超限即拒，不读进内存）。 */
export const MAX_BODY_BYTES = 16 * 1024
/** 凭据字面量上限（与桌面端 `renew.py` 的 8192 护栏同量级）。 */
export const MAX_CREDENTIAL_LENGTH = 8192
/** 平台往返超时（两跳 ⇒ 最坏 2 × 4 s，压在网关 60 s 与桌面端 8 s 之内）。 */
export const PLATFORM_TIMEOUT_MS = 4000

/** 手机号形态（与 `lib/config.js::PHONE_PATTERN` **逐字同正则**）。 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/
/** 区域形态（与 `lib/config.js::AUTH_REGION_PATTERN` 逐字同正则）。 */
const REGION_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
/** 环境 Id 形态（不含点与斜杠 ⇒ 拼不出别的域）。 */
const ENV_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/
/** 平台回体里表示「凭据不成立」的错误码（**只认逐字值**，不做文本匹配）。 */
const AUTH_FAILURE_CODES = Object.freeze([
  'invalid_grant',
  'invalid_token',
  'invalid_request',
  'unauthenticated',
  'token_expired',
  'access_token_expired',
  'INVALID_ACCESS_TOKEN',
  'UNAUTHENTICATED',
  'ACCESS_TOKEN_EXPIRED',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'UNAUTHORIZED'
])

/* ---------------------------------------------------------------------------
   小工具（**纯函数、零 IO**）
   ------------------------------------------------------------------------- */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/**
 * 手机号归一（**与 `lib/config.js::normalizePhone` 逐字同口径**：只去非数字，**不做形态判定**）。
 * 形态判定归 `isPhoneLike`（与 config 的 `isPhoneLike` 同一条 `PHONE_PATTERN`）——
 * 把「归一」与「判定」混在一个函数里曾导致与权威实现分叉（自检 D5 抓到）。
 */
export function normalizePhone(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[^0-9]/g, '')
}

/** 手机号形态判定（归一后整串匹配；**不猜格式**）。 */
export function isPhoneLike(value) {
  return PHONE_PATTERN.test(normalizePhone(value))
}

/**
 * **平台回体号归一**（`+86 138…` / 空格 / 连字符 ⇒ 11 位；不合格 ⇒ `''`）。
 * 与 `lib/platformAuth.js::normalizePlatformPhone` 逐字同口径 —— 平台号**带国家码**，
 * 不能与客户端自报号共用同一个归一函数（自检 D5 抓到的分叉点）。
 */
export function normalizePlatformPhone(value) {
  const digits = String(value === undefined || value === null ? '' : value).replace(/[^0-9]/g, '')
  if (digits.length === 13 && digits.startsWith('86')) return PHONE_PATTERN.test(digits.slice(2)) ? digits.slice(2) : ''
  if (digits.length === 11 && PHONE_PATTERN.test(digits)) return digits
  return ''
}

/**
 * uid 派生（**与 `lib/config.js::uidOf` 逐字同口径**）：
 * 先 `normalizePhone` 再 `isPhoneLike` 过门，不合格 ⇒ `''`；合格 ⇒ `u-` ＋ sha256 前 16 位。
 */
export function uidOf(value) {
  const digits = normalizePhone(value)
  if (!isPhoneLike(digits)) return ''
  return `u-${createHash('sha256').update(digits, 'utf8').digest('hex').slice(0, 16)}`
}

/** 区域（同序 / 同正则 / 同默认值：`lib/config.js::readAuthRegion`）。 */
export function readAuthRegion(env) {
  const source = env || {}
  for (const name of AUTH_REGION_ENV_NAMES) {
    const value = text(source[name]).toLowerCase()
    if (!value) continue
    if (REGION_PATTERN.test(value)) return value
  }
  return PLATFORM.DEFAULT_REGION
}

/** 环境 Id（同序：`lib/config.js::readEnvId`；形态不成立 ⇒ `''`）。 */
export function readEnvId(env) {
  const source = env || {}
  for (const name of ENV_ID_ENV_NAMES) {
    const value = text(source[name])
    if (!value) continue
    if (ENV_ID_PATTERN.test(value)) return value
  }
  return ''
}

/** host 拼接（单点；三段拼出，区域 / 环境 Id 都不写死）。 */
export function authHostOf(envId, region) {
  return `${envId}.${region}${PLATFORM.HOST_SUFFIX}`
}

/** 2 段令牌的 claims（**键序即契约**：`v / uid / roles / iat / exp / jti`；与 `ops.js` 同形）。 */
export function buildDeviceClaims(input) {
  const uid = text(input && input.uid)
  const roles = Array.isArray(input && input.roles)
    ? input.roles.map((role) => text(role).toLowerCase()).filter(Boolean)
    : []
  const nowSeconds = Math.floor(Number(input && input.nowSeconds))
  const rawTtl = Math.floor(Number(input && input.ttlSeconds))
  const ttlSeconds = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : DEVICE_TTL_FALLBACK_SECONDS
  return {
    v: 1,
    uid,
    roles,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    jti: text(input && input.jti) || randomUUID()
  }
}

function base64urlOf(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/** 2 段签名（`base64url(payload).base64url(HMAC_SHA256(payloadSegment, secret))`；与 `ops.js` 同形）。 */
export function signDeviceToken(claims, secret) {
  const payloadSegment = base64urlOf(Buffer.from(JSON.stringify(claims), 'utf8'))
  const signatureSegment = base64urlOf(createHmac('sha256', String(secret)).update(payloadSegment).digest())
  return `${payloadSegment}.${signatureSegment}`
}

/** 默认平台传输层：`node:https`，**永不抛出**（失败统一 `{status:0, text:''}`）。 */
export function httpsPlatform(spec) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let request = null
    try {
      request = https.request(
        {
          method: spec.method,
          hostname: spec.hostname,
          path: spec.path,
          headers: spec.headers
        },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => done({ status: Number(response.statusCode) || 0, text: Buffer.concat(chunks).toString('utf8') }))
          response.on('error', () => done({ status: 0, text: '' }))
        }
      )
    } catch {
      return done({ status: 0, text: '' })
    }
    request.on('error', () => done({ status: 0, text: '' }))
    request.setTimeout(Number(spec.timeoutMs) || PLATFORM_TIMEOUT_MS, () => {
      try {
        request.destroy()
      } catch {
        /*  destroys 失败也只是失败路径 */
      }
      done({ status: 0, text: '' })
    })
    if (spec.body) {
      try {
        request.write(spec.body)
      } catch {
        /* 写失败 ⇒ 下面 end 会报 error ⇒ 归网络错 */
      }
    }
    request.end()
  })
}

function jsonOf(raw) {
  try {
    const parsed = JSON.parse(String(raw || ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 平台回体里的错误码（OAuth2 形态 `error` 与云开发形态 `code` **两种都认**）。 */
function platformErrorCode(body) {
  if (!body) return ''
  const raw = body.error !== undefined && body.error !== null ? body.error : body.code
  return text(raw)
}

function isAuthFailureCode(code) {
  return code !== '' && AUTH_FAILURE_CODES.indexOf(code) !== -1
}

/* ---------------------------------------------------------------------------
   入参解析（**任何一条不成立 ⇒ `INVALID_FIELD` ＋ 零上游调用**）
   ------------------------------------------------------------------------- */

function jsonBodyOf(req) {
  const raw = req ? req.body : undefined
  if (raw === undefined || raw === null) return { ok: true, value: {} }
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) {
    return Array.isArray(raw) ? { ok: false } : { ok: true, value: raw }
  }
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')
  if (buffer.length === 0) return { ok: true, value: {} }
  if (buffer.length > MAX_BODY_BYTES) return { ok: false }
  const parsed = jsonOf(buffer.toString('utf8'))
  return parsed ? { ok: true, value: parsed } : { ok: false }
}

function credentialOf(value) {
  const raw = text(value)
  if (!raw || raw.length > MAX_CREDENTIAL_LENGTH) return ''
  return raw
}

/**
 * 载荷校验（封闭键面 ＋ 二选一凭据 ＋ 可选手机号形态）。
 * @returns {{ok:true, accessToken:string, refreshToken:string, phone:string}|{ok:false}}
 */
function payloadOf(route, body) {
  const allowed = ALLOWED_KEYS[route] || []
  const keys = Object.keys(body)
  if (keys.some((key) => allowed.indexOf(key) === -1)) return { ok: false }
  const phoneRaw = body.phone
  let phone = ''
  if (phoneRaw !== undefined && phoneRaw !== null && text(phoneRaw) !== '') {
    phone = normalizePhone(phoneRaw)
    /* 归一只去非数字（与 config.js 同口径）⇒ 形态判定必须单独过门，
       否则「手机号形态不成立」会被当成合法入参送去上游（自检 B7 抓到的回归）。 */
    if (!isPhoneLike(phone)) return { ok: false }
  }
  if (route === 'refresh') {
    const refreshToken = credentialOf(body.refresh_token)
    if (!refreshToken) return { ok: false }
    return { ok: true, accessToken: '', refreshToken, phone }
  }
  const accessToken = credentialOf(body.access_token) || credentialOf(body.session_token)
  const refreshToken = credentialOf(body.refresh_token)
  /* **二选一**：两枚都给或都不给 ⇒ 拒（不猜「用哪一枚」）。 */
  if (accessToken && refreshToken) return { ok: false }
  if (!accessToken && !refreshToken) return { ok: false }
  return { ok: true, accessToken, refreshToken, phone }
}

/* ---------------------------------------------------------------------------
   平台两跳（注入缝：`platform` ＝ `({method, hostname, path, headers, body, timeoutMs})`
   ⇒ `{status, text}`；自检全程用假上游，零联网）
   ------------------------------------------------------------------------- */

function createPlatformCalls({ platform, env, now, timeoutMs }) {
  const envId = readEnvId(env)
  const region = readAuthRegion(env)
  const hostname = envId ? authHostOf(envId, region) : ''

  /** ① `refresh_token` → 新会话（`POST /auth/v1/token`，OAuth2 refresh grant）。 */
  async function refreshSession(refreshToken) {
    if (!hostname) return { ok: false, kind: 'CONFIG_MISSING' }
    const payload = JSON.stringify({
      client_id: envId,
      client_secret: '',
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
    const reply = await platform({
      method: 'POST',
      hostname,
      path: PLATFORM.TOKEN_PATH,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
      timeoutMs
    })
    const status = Number(reply && reply.status) || 0
    const body = jsonOf(reply && reply.text)
    const code = platformErrorCode(body)
    const accessToken = credentialOf(body && body.access_token)
    /* 成功面：2xx ＋ 有令牌（优先判成功，避免把带附加字段的正常回体误判）。 */
    if (status === 200 && accessToken) {
      const expiresIn = Number(body && body.expires_in)
      const expiresAt =
        Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Number(now()) + Math.floor(expiresIn) * 1000).toISOString() : ''
      return { ok: true, accessToken, expiresAt }
    }
    /* **凭据判定必须由平台明确给出**（回体里的 invalid_grant 一族 / 平台认证失败码）：
       裸 401/403、HTML 错误页、网关拦截页、`invalid_client`（＝我方 client 配置错）**都不算**
       凭据失效 —— 否则桌面版会把好凭据清掉（不可逆：用户得重新登录）。 */
    if (isAuthFailureCode(code)) return { ok: false, kind: 'REFRESH_INVALID' }
    return { ok: false, kind: 'UPSTREAM_ERROR', status }
  }

  /** ② 平台会话验签 → 真实手机号（`GET /auth/v1/user/me`；**只 GET**，不带长度头）。 */
  async function verifySession(accessToken) {
    if (!hostname) return { ok: false, kind: 'CONFIG_MISSING' }
    const reply = await platform({
      method: 'GET',
      hostname,
      path: `${PLATFORM.ME_PATH}?client_id=${envId}`,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      body: '',
      timeoutMs
    })
    const status = Number(reply && reply.status) || 0
    const body = jsonOf(reply && reply.text)
    const code = platformErrorCode(body)
    if (status === 200 && !code) {
      const phone = normalizePlatformPhone(body && (body.phone_number || body.phoneNumber || body.phone))
      if (!phone) return { ok: false, kind: 'LOGIN_REQUIRED' }
      return { ok: true, phone }
    }
    /* 同「refresh」的判据纪律：**只有平台明确判否**才算「无会话」，其余一律上游故障。 */
    if (isAuthFailureCode(code)) return { ok: false, kind: 'LOGIN_REQUIRED' }
    return { ok: false, kind: 'UPSTREAM_ERROR', status }
  }

  return { envId, region, hostname, refreshSession, verifySession }
}

/* ---------------------------------------------------------------------------
   响应
   ------------------------------------------------------------------------- */

function sendJson(res, statusCode, body, extraHeaders) {
  const payload = JSON.stringify(body)
  res.statusCode = statusCode
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (extraHeaders) for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value)
  }
  if (typeof res.end === 'function') res.end(payload)
}

/** 各 reason 的 HTTP 状态（封闭表；自检逐值断言）。 */
export const STATUS_OF = Object.freeze({
  INVALID_FIELD: 400,
  METHOD_NOT_ALLOWED: 405,
  REFRESH_INVALID: 401,
  LOGIN_REQUIRED: 401,
  FORBIDDEN: 403,
  UPSTREAM_ERROR: 502,
  CONFIG_MISSING: 503
})

/* ---------------------------------------------------------------------------
   处理器工厂
   ------------------------------------------------------------------------- */

/**
 * @param {{env?:object, platform?:Function, now?:Function, logger?:object,
 *          secretOf?:Function, adminPhoneOf?:Function}} [options]
 *   注入缝全部可选 ⇒ 生产 = 文件末尾默认实例；自检 = 假平台 ＋ 假 env ＋ 假时钟。
 * @returns {(req:object, res:object, route:string)=>Promise<void>}
 */
export function createSessionHandler(options = {}) {
  const env = options.env || (typeof process !== 'undefined' ? process.env : {}) || {}
  const platform = typeof options.platform === 'function' ? options.platform : httpsPlatform
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const logger = options.logger || console
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : PLATFORM_TIMEOUT_MS
  const calls = createPlatformCalls({ platform, env, now, timeoutMs })

  /** 审计：**只四个键**（零令牌、零手机号、零 refresh_token）。 */
  function audit(record) {
    try {
      if (logger && typeof logger.log === 'function') {
        logger.log(JSON.stringify(Object.assign({ tag: 'xiai-feicui-session' }, record)))
      }
    } catch {
      /* 日志失败不得影响判定 */
    }
  }

  function deny(res, reason, extra) {
    const status = STATUS_OF[reason] || 500
    audit({ route: extra && extra.route, outcome: reason, status })
    return sendJson(res, status, { ok: false, reason })
  }

  const secretOf =
    typeof options.secretOf === 'function'
      ? options.secretOf
      : () => text(env[DEVICE_SECRET_ENV])
  const adminPhoneOf =
    typeof options.adminPhoneOf === 'function'
      ? options.adminPhoneOf
      : () => normalizePhone(env[ADMIN_PHONE_ENV])

  return async function handle(req, res, route) {
    const request = req || {}
    if (SESSION_ROUTES.indexOf(route) === -1) return deny(res, REASONS.INVALID_FIELD, { route })
    if (text(request.method).toUpperCase() !== 'POST') {
      return sendJson(res, 405, { ok: false, reason: REASONS.METHOD_NOT_ALLOWED }, { Allow: 'POST' })
    }
    const parsedBody = jsonBodyOf(request)
    if (!parsedBody.ok) return deny(res, REASONS.INVALID_FIELD, { route })
    const payload = payloadOf(route, parsedBody.value)
    if (!payload.ok) return deny(res, REASONS.INVALID_FIELD, { route })

    /* ---------------- ① refresh：refresh_token → 新会话 ---------------- */
    if (route === 'refresh') {
      const refreshed = await calls.refreshSession(payload.refreshToken)
      if (!refreshed.ok) return deny(res, refreshed.kind === 'CONFIG_MISSING' ? REASONS.CONFIG_MISSING : refreshed.kind, { route })
      /* 手机号只取**平台验签后**的真实值（取不到 ⇒ 空串，**绝不回显客户端自报值**）。 */
      const verified = await calls.verifySession(refreshed.accessToken)
      const phone = verified.ok ? verified.phone : ''
      audit({ route, outcome: 'OK', status: 200 })
      return sendJson(res, 200, {
        ok: true,
        access_token: refreshed.accessToken,
        phone,
        expires_at: refreshed.expiresAt
      })
    }

    /* ---------------- ② device-token：会话 → 168 小时设备令牌 ---------------- */
    let accessToken = payload.accessToken
    if (!accessToken) {
      const refreshed = await calls.refreshSession(payload.refreshToken)
      if (!refreshed.ok) return deny(res, refreshed.kind === 'CONFIG_MISSING' ? REASONS.CONFIG_MISSING : refreshed.kind, { route })
      accessToken = refreshed.accessToken
    }
    const verified = await calls.verifySession(accessToken)
    if (!verified.ok) {
      return deny(res, verified.kind === 'CONFIG_MISSING' ? REASONS.CONFIG_MISSING : verified.kind, { route })
    }
    /* 管理员门：**唯一判据是平台验签后的手机号 ∈ 白名单**（不采信任何自报身份）。 */
    const expected = adminPhoneOf()
    if (!expected) return deny(res, REASONS.CONFIG_MISSING, { route })
    if (verified.phone !== expected) return deny(res, REASONS.FORBIDDEN, { route })
    const uid = uidOf(verified.phone)
    if (!uid) return deny(res, REASONS.FORBIDDEN, { route })
    const secret = secretOf()
    if (!secret) return deny(res, REASONS.CONFIG_MISSING, { route })
    const nowMs = Number(now())
    const claims = buildDeviceClaims({
      uid,
      roles: ['admin'],
      nowSeconds: Math.floor(nowMs / 1000),
      ttlSeconds: DEVICE_TTL_SECONDS
    })
    const token = signDeviceToken(claims, secret)
    audit({ route, outcome: 'OK', status: 200 })
    return sendJson(res, 200, {
      ok: true,
      token,
      expires_at: new Date(claims.exp * 1000).toISOString()
    })
  }
}

export default createSessionHandler()
