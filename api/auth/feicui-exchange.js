/**
 * 玺爱 · **斐萃（feicui）换身份 · 一次性授权码核销**（Vercel Serverless Function）
 * ============================================================================
 * 路由：`POST /api/auth/feicui-exchange`  入参 `{code}`  出参 `{ok:true, uid, role}`
 *
 * 为什么需要这条路由：斐萃本地电脑版要调 yinyuan2026 的读面 API，而 `YINYUAN_API_KEY`
 * **只能待在斐萃服务端**（绝不随分发包 / 绝不进客户端）。于是让用户在**玺爱站内**登录后
 * 领一枚一次性短码（云函数 `xiai-user-token` 的 op `issueFeicuiCode`，身份取自 **auth API
 * 通道**、不认 `event.uid`），再由**斐萃服务端**拿码来这里换 `{uid, role}` ⇒ 斐萃侧从此
 * 有可靠 uid 去关联自己的用户，而密钥始终留在斐萃服务端。
 *
 * 硬口径（逐条）：
 *   ① **一次性**：核销 ＝ 对 `xiai_feicui_codes` 做**条件更新**（`where({_id, used_at: null})`
 *      ⇒ `update({used_at, used_by})`）＋ **回读确认**（`doc.used_at === 本次 claimedAt` 才算赢）。
 *      两个并发请求争同一码 ⇒ 条件更新只有一个命中（云数据库端原子）＋ 回读再确认一次 ⇒
 *      **只有一个拿到 `ok:true`**，另一个一律 `CODE_INVALID`（**防双花**）。
 *   ② **不区分失败原因**：码不存在 / 过期 / 已用 / 形态不合 ⇒ **统一** `400 {ok:false,
 *      reason:'CODE_INVALID'}`（防探测：不给攻击者「存在但过期」这类信号）。
 *   ③ **限流必有**：同 IP ＋ 全局双窗（进程内存滑窗；默认 每 IP 10 次 / 60 s、全局 200 次 /
 *      60 s）⇒ 超限 `429 {ok:false, reason:'RATE_LIMITED'}` ＋ `Retry-After`。
 *      **如实登记的局限**：Vercel 每个实例独立内存、不跨实例共享 ⇒ 它是**每实例**的减速带，
 *      不是分布式配额；真正的护栏是「6 位码 ＋ 10 分钟 TTL ＋ 一次性 ＋ 统一失败面」。
 *   ④ **凭据只在环境变量**：`TCB_ENV` ＋ `TCB_SECRET_ID` / `TCB_SECRET_KEY`（或 `CB_*` /
 *      `TENCENTCLOUD_*` 同义名）；**缺任一 ⇒ 503 `CONFIG_MISSING`，绝不降级成"放行"**；
 *      本文件**不打印、不返回任何凭据**（诊断只给布尔）。
 *   ⑤ **不透任何多余面**：成功只回 `uid` / `role`；不回手机号、不回码、不回令牌。
 *
 * 离线自检：`scripts/verify-feicui-exchange.mjs` 用 `createExchangeHandler({ getDb, now, limiter })`
 * 注入假 DB / 假时钟，覆盖「格式 / TTL / 过期拒 / 已用拒 / 并发双花 / 限流 / 方法面」。
 */

import { createHash } from 'node:crypto'
import feicuiCodeModule from '../../cloudfunctions/xiai-user-token/lib/feicuiCode.js'

/* **码面真源**：字母表 / 长度 / 正则一律取云函数侧同一份纯函数模块（不另抄一份 ⇒ 不会漂移）；
   万一相对导入在某次构建里取不到，退回同值字面量（仍与 `lib/feicuiCode.js` 逐字一致）。 */
const CODE_ALPHABET =
  (feicuiCodeModule && feicuiCodeModule.CODE_ALPHABET) || '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const CODE_LENGTH = (feicuiCodeModule && feicuiCodeModule.CODE_LENGTH) || 6
const CODE_PATTERN = (feicuiCodeModule && feicuiCodeModule.CODE_PATTERN) || new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`)
const DEFAULT_TTL_SECONDS = (feicuiCodeModule && feicuiCodeModule.DEFAULT_TTL_SECONDS) || 600

/** 授权码集合（与云函数 `COLLECTIONS.feicuiCodes` 逐字同值）。 */
export const COLLECTION_CODES = 'xiai_feicui_codes'

/** 对外 reason 面（**只有这 5 个**；失败原因对客户端一律不外泄细节）。 */
export const REASONS = Object.freeze({
  CODE_INVALID: 'CODE_INVALID',
  RATE_LIMITED: 'RATE_LIMITED',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFIG_MISSING: 'CONFIG_MISSING',
  UNAVAILABLE: 'UNAVAILABLE'
})

/** 限流默认值（每实例内存窗口；见文件头 ③）。 */
export const RATE_LIMIT_DEFAULTS = Object.freeze({
  windowMs: 60 * 1000,
  perIpMax: 10,
  globalMax: 200
})

/** 请求体上限（`{code}` 只有十几字节；超过即拒，不解析）。 */
const MAX_BODY_BYTES = 4096

/* ---------------------------------------------------------------------------
   小工具
   --------------------------------------------------------------------------- */

function textOf(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/** 码归一（大写；形态不合 ⇒ 空串 ⇒ 调用方统一回 `CODE_INVALID`）。 */
export function normalizeCode(value) {
  const raw = textOf(value).toUpperCase()
  return CODE_PATTERN.test(raw) ? raw : ''
}

/** 取行数组（容错 node-sdk 各版本回包形状 `{data:[…]}` / `{data:{list}}` / 裸数组）。 */
function rowsOf(reply) {
  if (!reply) return []
  if (Array.isArray(reply)) return reply
  if (Array.isArray(reply.data)) return reply.data
  if (reply.data && Array.isArray(reply.data.list)) return reply.data.list
  if (Array.isArray(reply.list)) return reply.list
  return []
}

/** 取更新命中数（认不出 ⇒ `null`，由回读确认兜底，**不猜成功**）。 */
function updatedCountOf(reply) {
  if (reply === null || reply === undefined) return null
  if (typeof reply === 'number') return reply
  if (typeof reply.updated === 'number') return reply.updated
  if (reply.data && typeof reply.data.updated === 'number') return reply.data.updated
  if (reply.stats && typeof reply.stats.updated === 'number') return reply.stats.updated
  return null
}

/** 调用方 IP（Vercel 由 `x-forwarded-for` 给出；取最左一段）。 */
export function clientIpOf(req) {
  const header = req && req.headers ? req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'] : ''
  const first = Array.isArray(header) ? header[0] : String(header || '')
  const ip = first.split(',')[0].trim()
  if (ip) return ip
  const direct = req && req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
  return direct || 'unknown'
}

/** `used_by` 落**不可逆短指纹**（不落原始 IP / UA ⇒ 少留可识别信息）。 */
export function usedByFingerprintOf(req) {
  const ip = clientIpOf(req)
  const ua = textOf(req && req.headers ? req.headers['user-agent'] : '')
  return `fb-${createHash('sha256').update(`${ip}\n${ua}`, 'utf8').digest('hex').slice(0, 12)}`
}

/* ---------------------------------------------------------------------------
   限流（进程内存滑窗；双窗：同 IP ＋ 全局）
   --------------------------------------------------------------------------- */

/**
 * 造一个限流器（**可注入时钟** ⇒ 离线自检可确定性地推进时间）。
 * @param {{windowMs?:number, perIpMax?:number, globalMax?:number}} [options]
 * @returns {{hit:(key:string, nowMs:number)=>{ok:boolean, scope:string, retryAfterSeconds:number}, snapshot:()=>object}}
 */
export function createRateLimiter(options = {}) {
  const windowMs =
    Number.isFinite(options.windowMs) && options.windowMs > 0 ? Math.floor(options.windowMs) : RATE_LIMIT_DEFAULTS.windowMs
  const perIpMax =
    Number.isFinite(options.perIpMax) && options.perIpMax > 0 ? Math.floor(options.perIpMax) : RATE_LIMIT_DEFAULTS.perIpMax
  const globalMax =
    Number.isFinite(options.globalMax) && options.globalMax > 0 ? Math.floor(options.globalMax) : RATE_LIMIT_DEFAULTS.globalMax
  const GLOBAL_KEY = '__global__'
  /** @type {Map<string, number[]>} */
  const hits = new Map()

  function prune(list, nowMs) {
    const keep = []
    for (const at of list) if (nowMs - at < windowMs) keep.push(at)
    return keep
  }

  function retryAfterOf(list, nowMs) {
    if (list.length === 0) return Math.ceil(windowMs / 1000)
    const oldest = Math.min.apply(null, list)
    return Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000))
  }

  return {
    hit(key, nowMs) {
      const bucket = textOf(key) || 'unknown'
      for (const [candidate, list] of hits) {
        const kept = prune(list, nowMs)
        if (kept.length === 0) hits.delete(candidate)
        else hits.set(candidate, kept)
      }
      const mine = hits.get(bucket) || []
      const global = hits.get(GLOBAL_KEY) || []
      if (global.length >= globalMax) {
        return { ok: false, scope: 'global', retryAfterSeconds: retryAfterOf(global, nowMs) }
      }
      if (mine.length >= perIpMax) {
        return { ok: false, scope: 'ip', retryAfterSeconds: retryAfterOf(mine, nowMs) }
      }
      mine.push(nowMs)
      global.push(nowMs)
      hits.set(bucket, mine)
      hits.set(GLOBAL_KEY, global)
      return { ok: true, scope: '', retryAfterSeconds: 0 }
    },
    snapshot() {
      const out = {}
      for (const [key, list] of hits) out[key === GLOBAL_KEY ? 'global' : 'window'] = (out[key === GLOBAL_KEY ? 'global' : 'window'] || 0) + list.length
      return out
    }
  }
}

/* ---------------------------------------------------------------------------
   云数据库（管理凭据**只在环境变量**；缺 ⇒ `null` ⇒ 503，绝不降级放行）
   --------------------------------------------------------------------------- */

function pickEnv(env, names) {
  for (const name of names) {
    const value = textOf(env ? env[name] : '')
    if (value) return value
  }
  return ''
}

/** 配置读数（**布尔 only，零值回显**；给人类排障用，不参与任何判定）。 */
export function configStatus(env) {
  const source = env || (typeof process !== 'undefined' ? process.env : {}) || {}
  return {
    envId: pickEnv(source, ['TCB_ENV', 'CB_ENV_ID', 'CLOUDBASE_ENV_ID']) !== '',
    secretId: pickEnv(source, ['TCB_SECRET_ID', 'CB_SECRET_ID', 'TENCENTCLOUD_SECRETID']) !== '',
    secretKey: pickEnv(source, ['TCB_SECRET_KEY', 'CB_SECRET_KEY', 'TENCENTCLOUD_SECRETKEY']) !== ''
  }
}

/**
 * 生产取库：`@cloudbase/node-sdk`（**延迟 import** ⇒ 离线自检不需要装它）。
 * 未配置 / SDK 不可用 / 初始化失败 ⇒ `null`（调用方回 503 `CONFIG_MISSING`）。
 * @returns {Promise<object|null>}
 */
export async function defaultGetDb() {
  const env = (typeof process !== 'undefined' ? process.env : {}) || {}
  const status = configStatus(env)
  if (!status.envId || !status.secretId || !status.secretKey) return null
  let sdk = null
  try {
    const loaded = await import('@cloudbase/node-sdk')
    sdk = loaded && (loaded.default || loaded)
  } catch {
    return null
  }
  if (!sdk || typeof sdk.init !== 'function') return null
  try {
    const app = sdk.init({
      env: pickEnv(env, ['TCB_ENV', 'CB_ENV_ID', 'CLOUDBASE_ENV_ID']),
      secretId: pickEnv(env, ['TCB_SECRET_ID', 'CB_SECRET_ID', 'TENCENTCLOUD_SECRETID']),
      secretKey: pickEnv(env, ['TCB_SECRET_KEY', 'CB_SECRET_KEY', 'TENCENTCLOUD_SECRETKEY'])
    })
    return app && typeof app.database === 'function' ? app.database() : null
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------------------
   处理器工厂（**依赖注入** ⇒ 离线可测；生产用文件末尾的默认实例）
   --------------------------------------------------------------------------- */

/**
 * @param {{getDb?:function():Promise<object|null>, now?:function():number,
 *          limiter?:object, collection?:string, windowMs?:number}} [options]
 * @returns {(req:object, res:object)=>Promise<void>}
 */
export function createExchangeHandler(options = {}) {
  const getDb = typeof options.getDb === 'function' ? options.getDb : defaultGetDb
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const limiter = options.limiter || createRateLimiter(options)
  const collection = textOf(options.collection) || COLLECTION_CODES

  function send(res, statusCode, body, extraHeaders) {
    if (res && typeof res.status === 'function' && typeof res.json === 'function') {
      /* 兼容 express 风格的假体（离线自检用）。 */
      if (extraHeaders) for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value)
      res.status(statusCode).json(body)
      return
    }
    res.statusCode = statusCode
    if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      if (extraHeaders) for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value)
    }
    if (typeof res.end === 'function') res.end(JSON.stringify(body))
  }

  const invalid = (res) => send(res, 400, { ok: false, reason: REASONS.CODE_INVALID })

  return async function handler(req, res) {
    const request = req || {}
    /* ① 方法面：只收 POST（其余一律 405，带 `Allow`）。 */
    if (textOf(request.method).toUpperCase() !== 'POST') {
      return send(res, 405, { ok: false, reason: REASONS.METHOD_NOT_ALLOWED }, { Allow: 'POST' })
    }
    const nowMs = Number(now())
    /* ② 限流**先于一切解析**（暴力猜码也要计次）。 */
    const gate = limiter.hit(clientIpOf(request), nowMs)
    if (!gate.ok) {
      return send(res, 429, { ok: false, reason: REASONS.RATE_LIMITED }, {
        'Retry-After': String(gate.retryAfterSeconds || 1)
      })
    }
    /* ③ 载荷：`{code}`（串体 / 已解析对象都收；超长 / 非 JSON / 非对象 ⇒ 统一 `CODE_INVALID`）。 */
    let body = request.body
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      const raw = Buffer.isBuffer(body) ? body.toString('utf8') : body
      if (raw.length > MAX_BODY_BYTES) return invalid(res)
      try {
        body = JSON.parse(raw)
      } catch {
        return invalid(res)
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid(res)
    const code = normalizeCode(body.code)
    if (!code) return invalid(res)
    /* ④ 库面（缺凭据 ⇒ 503 `CONFIG_MISSING`，**不猜、不放行**）。 */
    let db = null
    try {
      db = await getDb()
    } catch {
      db = null
    }
    if (!db) {
      return send(res, 503, { ok: false, reason: REASONS.CONFIG_MISSING })
    }
    /* ⑤ **原子核销**：条件更新（`used_at` 仍是 `null` 才命中）⇒ 并发只有一方能赢。 */
    const claimedAt = new Date(nowMs).toISOString()
    const usedBy = usedByFingerprintOf(request)
    let updated = null
    try {
      const collectionRef = db.collection(collection)
      const result = await collectionRef.where({ _id: code, used_at: null }).update({ used_at: claimedAt, used_by: usedBy })
      updated = updatedCountOf(result)
    } catch {
      return send(res, 503, { ok: false, reason: REASONS.UNAVAILABLE })
    }
    if (updated === 0) return invalid(res)
    /* ⑥ **回读确认**：`used_at` 必须是我们这次的 `claimedAt`（别人先赢 ⇒ 一律 `CODE_INVALID`）。 */
    let row = null
    try {
      const read = await db.collection(collection).doc(code).get()
      const rows = rowsOf(read)
      row = rows.length > 0 ? rows[0] : null
    } catch {
      return send(res, 503, { ok: false, reason: REASONS.UNAVAILABLE })
    }
    if (!row || textOf(row.used_at) !== claimedAt) return invalid(res)
    /* ⑦ 有效期（**服务端时钟**唯一判据；码已核销但已过期 ⇒ 仍回 `CODE_INVALID`）。 */
    const expiresMs = Date.parse(textOf(row.expires_at))
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return invalid(res)
    const uid = textOf(row.uid)
    const role = textOf(row.role) || 'user'
    if (!uid) return send(res, 503, { ok: false, reason: REASONS.UNAVAILABLE })
    /* ⑧ 成功面：**只给 uid / role**（无手机号、无码、无令牌）。 */
    return send(res, 200, { ok: true, uid, role })
  }
}

/** Vercel 默认导出（生产实例）。 */
export default createExchangeHandler()
