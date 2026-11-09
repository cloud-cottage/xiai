/**
 * 玺爱 · **斐萃（feicui）转发路由**（Vercel Serverless Function）
 * ============================================================================
 * 路由：`GET /api/feicui/v1/<path>?limit=&offset=`
 *
 * 链路（**斐萃侧永不持有上游 key**）：
 *
 *     feicui（带 `Authorization: Feicui <token>`）
 *        → 本路由：验签（`lib/feicuiToken.js`，验签即确权，不查库）
 *        → `https://yinyuan2026.vercel.app/api/v1/<path>`，带 `Authorization: ApiKey <YINYUAN_API_KEY>`
 *
 * 硬口径（逐条）：
 *   ① **令牌面**：只认 `Authorization: Feicui <token>`；缺 / 形态错 / 签名错 / 过期 / 未知 kid /
 *      已吊销 ⇒ **一律** `401 {ok:false, reason:'TOKEN_INVALID'}`（**不向客户端区分失败原因** ⇒ 防探测；
 *      细分只进服务端日志的单键 `detail`，不含令牌原文）。
 *   ② **path 白名单**（封闭三值）：`dynasties` / `authors` / `inscriptions`；其余（含 `/keys`、
 *      多段路径、空路径）⇒ `404 {ok:false, reason:'PATH_NOT_ALLOWED'}` —— **绝不透传任意 path**。
 *   ③ **query 白名单**（封闭两键）：`limit` / `offset`；出现其它键或值非整数 ⇒ `400 INVALID_QUERY`；
 *      `limit ∈ [1,200]`、`offset ≥ 0`（**如实报错，不静默夹取 / 不静默丢键**）。
 *   ④ **服务端缓存**（进程内存 LRU；默认 TTL 24 h，按 `path?query` 做键，最多 200 条）——
 *      同一实例内第二次同请求**不打上游**（响应头 `X-Feicui-Cache: hit|miss`）。
 *      **缓存不跨实例**、**不落盘**；冷启动即空。
 *   ⑤ **按 uid 限流**（进程内存滑窗；默认 60 次 / 60 s）；超限 `429 RATE_LIMITED` ＋ `Retry-After`。
 *      **如实登记的局限**：Vercel 每实例独立内存 ⇒ 这是**每实例**的减速带，不是分布式配额。
 *   ⑥ **上游失败不得伪装成功**：非 2xx / 网络错 / 超时 / 非 JSON ⇒ `502 {ok:false,
 *      reason:'UPSTREAM_ERROR', status:<上游状态码；网络错为 0>}`（**不缓存失败**）。
 *   ⑦ **凭据只在环境变量**：`YINYUAN_API_KEY`（必填；缺 ⇒ `503 CONFIG_MISSING`）、
 *      `FEICUI_TOKEN_SECRET`（必填；缺 ⇒ 验签 fail-closed ⇒ `401 TOKEN_INVALID`）、
 *      `YINYUAN_API_BASE` / `FEICUI_TOKEN_KID` / `FEICUI_TOKEN_PREVIOUS_*` 可选。
 *      **本文件不打印、不返回任何凭据**（诊断只给布尔）。
 *   ⑧ **Cache-Control 用 `private`**：本路由是 bearer 保护的，**不得**给 CDN 共享缓存
 *      （否则边缘命中会绕过令牌校验）；服务端内存缓存不受影响。
 *   ⑨ **吊销名单**：静态 `config/feicui-token-revoked.json`（`{revoked:[{jti,reason,at}]}`），
 *      进程内只读一次；文件缺失 / 解析失败 ⇒ **按空名单继续**（并在日志与响应头
 *      `X-Feicui-Revocation: unavailable` 如实登记，**不假装名单已生效**）。
 *
 * 离线自检：`scripts/verify-feicui-token.mjs` —— 真 handler ＋ 真 `http.createServer` ＋ 假上游。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import feicuiTokenModule from '../../../cloudfunctions/xiai-user-token/lib/feicuiToken.js'

/* CJS 互操作：Node ESM 的 default 即 `module.exports`；再兜一层 `.default`（打包器差异）。 */
const tokenLib =
  feicuiTokenModule && typeof feicuiTokenModule.sign === 'function'
    ? feicuiTokenModule
    : feicuiTokenModule && feicuiTokenModule.default

/** 上游真源（可用 `YINYUAN_API_BASE` 覆盖；**不含 key**）。 */
export const DEFAULT_UPSTREAM_BASE = 'https://yinyuan2026.vercel.app/api/v1'

/** path 白名单（封闭三值；**唯一一处定义点**）。 */
export const ALLOWED_PATHS = Object.freeze(['dynasties', 'authors', 'inscriptions'])

/** query 白名单（封闭两键）。 */
export const ALLOWED_QUERY_KEYS = Object.freeze(['limit', 'offset'])

/** 对外 reason 面（**只有这 7 个**）。 */
export const REASONS = Object.freeze({
  TOKEN_INVALID: 'TOKEN_INVALID',
  RATE_LIMITED: 'RATE_LIMITED',
  CONFIG_MISSING: 'CONFIG_MISSING',
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  INVALID_QUERY: 'INVALID_QUERY',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED'
})

export const CACHE_DEFAULTS = Object.freeze({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 200 })
export const RATE_LIMIT_DEFAULTS = Object.freeze({ windowMs: 60 * 1000, max: 60 })
export const LIMIT_MAX = 200
export const UPSTREAM_TIMEOUT_MS = 8000
/** 可缓存响应体上限（超过 ⇒ 透传但**不缓存**；防止内存被大响应吃掉）。 */
const MAX_CACHEABLE_BYTES = 2 * 1024 * 1024

/* ---------------------------------------------------------------------------
   吊销名单（静态文件；只读一次）
   --------------------------------------------------------------------------- */

let revokedMemo = null

/**
 * 读吊销名单（进程内缓存）。`degraded:true` ⇒ 文件缺失 / 解析失败（**按空名单继续**，如实登记）。
 * @returns {{list:Array<{jti:string,reason:string,at:string}>, degraded:boolean}}
 */
export function loadRevoked() {
  if (revokedMemo) return revokedMemo
  /* 两个候选路径：① 与源码同相对位置（本机 / 常规 bundle）；② 进程 cwd 下的 `config/`
     （某些 serverless 打包会把入口挪进 `.func/`，此时 ① 解析不到）。任一命中即用。 */
  const candidates = [
    () => readFileSync(new URL('../../../config/feicui-token-revoked.json', import.meta.url), 'utf8'),
    () => readFileSync(path.join(process.cwd(), 'config/feicui-token-revoked.json'), 'utf8')
  ]
  for (const read of candidates) {
    try {
      const parsed = JSON.parse(read())
      revokedMemo = { list: tokenLib.normalizeRevokedList(parsed), degraded: false }
      return revokedMemo
    } catch {
      /* 换下一个候选 */
    }
  }
  revokedMemo = { list: [], degraded: true }
  try {
    console.warn(
      JSON.stringify({
        tag: 'xiai-feicui-forward',
        outcome: 'REVOCATION_UNAVAILABLE',
        detail: 'config/feicui-token-revoked.json unreadable in bundle and cwd'
      })
    )
  } catch {
    /* 日志失败不影响主路 */
  }
  return revokedMemo
}

/* ---------------------------------------------------------------------------
   小工具
   --------------------------------------------------------------------------- */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function urlOf(req) {
  const raw = req && typeof req.url === 'string' && req.url ? req.url : '/'
  try {
    return new URL(raw, 'http://localhost')
  } catch {
    return null
  }
}

function send(res, statusCode, body, extraHeaders) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.statusCode = statusCode
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (extraHeaders) for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value)
  }
  if (typeof res.end === 'function') res.end(payload)
}

/** 取 `Authorization: Feicui <token>`（scheme 大小写不敏感；其余 scheme ⇒ 空串）。 */
export function tokenOf(req) {
  const headers = (req && req.headers) || {}
  const rawHeader = headers.authorization || headers.Authorization
  const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
  const value = text(raw)
  if (!value) return ''
  const space = value.indexOf(' ')
  if (space <= 0) return ''
  const scheme = value.slice(0, space).trim().toLowerCase()
  const credential = value.slice(space + 1).trim()
  if (scheme !== 'feicui') return ''
  return credential
}

/** path 段（优先 Vercel 的 `req.query.path`，其次按 `req.url` 切；**一律去空段**）。 */
export function segmentsOf(req) {
  const query = (req && req.query) || {}
  if (query.path !== undefined && query.path !== null) {
    const rawPath = Array.isArray(query.path) ? query.path.join('/') : text(query.path)
    return rawPath.split('/').map(text).filter(Boolean)
  }
  const url = urlOf(req)
  if (!url) return []
  const prefix = '/api/feicui/v1'
  let pathname = url.pathname || ''
  if (pathname.indexOf(prefix) === 0) pathname = pathname.slice(prefix.length)
  return pathname.split('/').map(text).filter(Boolean)
}

/** query 面：只认 `limit` / `offset`（**出现其它键 ⇒ `null`**）。 */
export function queryOf(req) {
  const url = urlOf(req)
  const fromUrl = url ? url.searchParams : null
  const hasUrlQuery = fromUrl ? Array.from(fromUrl.keys()).length > 0 : false
  const pairs = []
  if (hasUrlQuery) {
    for (const key of fromUrl.keys()) pairs.push([key, fromUrl.get(key)])
  } else {
    const query = (req && req.query) || {}
    for (const [key, value] of Object.entries(query)) {
      if (key === 'path' || key === '...path') continue
      const raw = Array.isArray(value) ? value[value.length - 1] : value
      pairs.push([key, raw])
    }
  }
  const out = {}
  for (const [key, value] of pairs) {
    if (key === 'path' || key === '...path') continue
    if (ALLOWED_QUERY_KEYS.indexOf(key) === -1) return null
    if (Object.prototype.hasOwnProperty.call(out, key)) return null
    out[key] = text(value)
  }
  return out
}

/** 规范化 query（缓存键用；**固定键序** ⇒ 同义请求同键）。 */
export function canonicalQuery(query) {
  const parts = []
  for (const key of ALLOWED_QUERY_KEYS) {
    if (query && Object.prototype.hasOwnProperty.call(query, key)) parts.push(`${key}=${query[key]}`)
  }
  return parts.join('&')
}

/* ---------------------------------------------------------------------------
   缓存（进程内存 LRU ＋ TTL）
   --------------------------------------------------------------------------- */

/**
 * @param {{ttlMs?:number, maxEntries?:number}} [options]
 * @returns {{get:(key:string, nowMs:number)=>object|null, set:(key:string, value:object, nowMs:number)=>void, size:()=>number}}
 */
export function createCache(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? Math.floor(options.ttlMs) : CACHE_DEFAULTS.ttlMs
  const maxEntries =
    Number.isFinite(options.maxEntries) && options.maxEntries > 0 ? Math.floor(options.maxEntries) : CACHE_DEFAULTS.maxEntries
  /** @type {Map<string, {body:string, bytes:number, storedAt:number}>} */
  const store = new Map()
  return {
    get(key, nowMs) {
      const hit = store.get(key)
      if (!hit) return null
      if (nowMs - hit.storedAt >= ttlMs) {
        store.delete(key)
        return null
      }
      /* LRU：命中即提到队尾。 */
      store.delete(key)
      store.set(key, hit)
      return hit
    },
    set(key, value, nowMs) {
      if (!value || typeof value.body !== 'string') return
      if (value.body.length > MAX_CACHEABLE_BYTES) return
      store.delete(key)
      store.set(key, { body: value.body, bytes: value.body.length, storedAt: nowMs })
      while (store.size > maxEntries) {
        const oldest = store.keys().next()
        if (oldest.done) break
        store.delete(oldest.value)
      }
    },
    size() {
      return store.size
    }
  }
}

/* ---------------------------------------------------------------------------
   限流（按 uid；进程内存滑窗）
   --------------------------------------------------------------------------- */

/**
 * @param {{windowMs?:number, max?:number}} [options]
 * @returns {{hit:(uid:string, nowMs:number)=>{ok:boolean, retryAfterSeconds:number, used:number}, snapshot:()=>number}}
 */
export function createUidLimiter(options = {}) {
  const windowMs =
    Number.isFinite(options.windowMs) && options.windowMs > 0 ? Math.floor(options.windowMs) : RATE_LIMIT_DEFAULTS.windowMs
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.floor(options.max) : RATE_LIMIT_DEFAULTS.max
  /** @type {Map<string, number[]>} */
  const hits = new Map()
  return {
    hit(uid, nowMs) {
      const key = text(uid) || 'unknown'
      for (const [candidate, list] of hits) {
        const kept = list.filter((at) => nowMs - at < windowMs)
        if (kept.length === 0) hits.delete(candidate)
        else hits.set(candidate, kept)
      }
      const mine = hits.get(key) || []
      if (mine.length >= max) {
        const oldest = Math.min.apply(null, mine)
        return {
          ok: false,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000)),
          used: mine.length
        }
      }
      mine.push(nowMs)
      hits.set(key, mine)
      return { ok: true, retryAfterSeconds: 0, used: mine.length }
    },
    snapshot() {
      let total = 0
      for (const list of hits.values()) total += list.length
      return total
    }
  }
}

/* ---------------------------------------------------------------------------
   处理器工厂（依赖注入 ⇒ 离线可测；生产 = 文件末尾默认实例）
   --------------------------------------------------------------------------- */

/**
 * @param {{env?:object, fetch?:function, now?:function, cache?:object, limiter?:object,
 *          loadRevoked?:function, upstreamBase?:string, timeoutMs?:number, logger?:object}} [options]
 * @returns {(req:object, res:object)=>Promise<void>}
 */
export function createForwardHandler(options = {}) {
  const env = options.env || (typeof process !== 'undefined' ? process.env : {}) || {}
  const fetchImpl =
    typeof options.fetch === 'function' ? options.fetch : typeof fetch === 'function' ? fetch : null
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const cache = options.cache || createCache(options)
  const limiter = options.limiter || createUidLimiter(options)
  const revokedLoader = typeof options.loadRevoked === 'function' ? options.loadRevoked : loadRevoked
  const upstreamBase = text(options.upstreamBase || env.YINYUAN_API_BASE).replace(/\/+$/, '') || DEFAULT_UPSTREAM_BASE
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : Number.isFinite(Number(env.FEICUI_FORWARD_TIMEOUT_MS)) && Number(env.FEICUI_FORWARD_TIMEOUT_MS) > 0
        ? Math.floor(Number(env.FEICUI_FORWARD_TIMEOUT_MS))
        : UPSTREAM_TIMEOUT_MS
  const logger = options.logger || console

  function audit(record) {
    try {
      if (logger && typeof logger.log === 'function') logger.log(JSON.stringify(Object.assign({ tag: 'xiai-feicui-forward' }, record)))
    } catch {
      /* 日志失败不得影响判定 */
    }
  }

  const unauth = (res) => send(res, 401, { ok: false, reason: REASONS.TOKEN_INVALID }, { 'WWW-Authenticate': 'Feicui' })

  return async function handler(req, res) {
    const request = req || {}
    /* ① 方法面：只收 GET（`Allow: GET`）。 */
    if (text(request.method).toUpperCase() !== 'GET') {
      return send(res, 405, { ok: false, reason: REASONS.METHOD_NOT_ALLOWED }, { Allow: 'GET' })
    }
    /* ② 上游凭据（**只在 env**；缺 ⇒ 503，不猜、不放行）。 */
    const apiKey = text(env.YINYUAN_API_KEY)
    if (!apiKey) {
      audit({ outcome: REASONS.CONFIG_MISSING, stage: 'env', keyPresent: false })
      return send(res, 503, { ok: false, reason: REASONS.CONFIG_MISSING })
    }
    /* ③ 令牌面（**验签即确权**；任何失败一律 TOKEN_INVALID）。 */
    const token = tokenOf(request)
    if (!token) {
      audit({ outcome: REASONS.TOKEN_INVALID, stage: 'header', tokenPresent: false })
      return unauth(res)
    }
    const nowMs = Number(now())
    const nowSeconds = Math.floor(nowMs / 1000)
    const revokedLoad = revokedLoader()
    const revokedList = revokedLoad && Array.isArray(revokedLoad.list) ? revokedLoad.list : revokedLoad || []
    const revocationDegraded = !!(revokedLoad && revokedLoad.degraded)
    const verified = tokenLib.verify(token, { nowSeconds, revoked: revokedList, env })
    if (!verified.ok) {
      /* **对外不区分**：细分只进日志（不含令牌原文、不含 uid）。 */
      audit({ outcome: REASONS.TOKEN_INVALID, stage: 'verify', detail: verified.detail })
      return unauth(res)
    }
    /* ④ path 白名单（**不得透传任意 path**）。 */
    const segments = segmentsOf(request)
    if (segments.length !== 1 || ALLOWED_PATHS.indexOf(segments[0]) === -1) {
      audit({ outcome: REASONS.PATH_NOT_ALLOWED, uid: verified.uid, segments: segments.length })
      return send(res, 404, { ok: false, reason: REASONS.PATH_NOT_ALLOWED })
    }
    const resource = segments[0]
    /* ⑤ query 白名单（**如实报错，不静默夹取**）。 */
    const query = queryOf(request)
    if (query === null) {
      return send(res, 400, { ok: false, reason: REASONS.INVALID_QUERY })
    }
    for (const key of Object.keys(query)) {
      const value = query[key]
      if (!/^\d{1,9}$/.test(value)) return send(res, 400, { ok: false, reason: REASONS.INVALID_QUERY })
      const parsed = Number(value)
      if (key === 'limit' && (parsed < 1 || parsed > LIMIT_MAX)) {
        return send(res, 400, { ok: false, reason: REASONS.INVALID_QUERY })
      }
      if (key === 'offset' && parsed < 0) return send(res, 400, { ok: false, reason: REASONS.INVALID_QUERY })
    }
    /* ⑥ 按 uid 限流（**每实例**；见文件头 ⑤）。 */
    const gate = limiter.hit(verified.uid, nowMs)
    if (!gate.ok) {
      return send(
        res,
        429,
        { ok: false, reason: REASONS.RATE_LIMITED },
        { 'Retry-After': String(gate.retryAfterSeconds || 1), 'X-Feicui-RateLimit-Limit': String(RATE_LIMIT_DEFAULTS.max) }
      )
    }
    /* ⑦ 服务端缓存（**命中不打上游**）。 */
    const queryString = canonicalQuery(query)
    const cacheKey = queryString ? `${resource}?${queryString}` : resource
    const cached = cache.get(cacheKey, nowMs)
    if (cached) {
      return send(res, 200, cached.body, {
        'Cache-Control': 'private, max-age=300',
        Vary: 'Authorization',
        'X-Feicui-Cache': 'hit',
        'X-Feicui-Revocation': revocationDegraded ? 'unavailable' : 'ok'
      })
    }
    if (typeof fetchImpl !== 'function') {
      audit({ outcome: REASONS.CONFIG_MISSING, stage: 'fetch', uid: verified.uid })
      return send(res, 503, { ok: false, reason: REASONS.CONFIG_MISSING })
    }
    /* ⑧ 上游（**失败结构化透传，不伪装成功**）。 */
    const upstreamUrl = `${upstreamBase}/${resource}${queryString ? `?${queryString}` : ''}`
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    let upstream = null
    try {
      upstream = await fetchImpl(upstreamUrl, {
        method: 'GET',
        headers: { Authorization: `ApiKey ${apiKey}`, Accept: 'application/json' },
        signal: controller ? controller.signal : undefined
      })
    } catch (error) {
      audit({
        outcome: REASONS.UPSTREAM_ERROR,
        uid: verified.uid,
        resource,
        detail: (error && error.name) || 'fetch-failed'
      })
      return send(res, 502, { ok: false, reason: REASONS.UPSTREAM_ERROR, status: 0 })
    } finally {
      if (timer) clearTimeout(timer)
    }
    const upstreamStatus = Number(upstream && upstream.status) || 0
    let body = ''
    try {
      body = await upstream.text()
    } catch {
      return send(res, 502, { ok: false, reason: REASONS.UPSTREAM_ERROR, status: upstreamStatus })
    }
    if (!upstream || !upstream.ok) {
      audit({ outcome: REASONS.UPSTREAM_ERROR, uid: verified.uid, resource, status: upstreamStatus })
      return send(res, 502, { ok: false, reason: REASONS.UPSTREAM_ERROR, status: upstreamStatus })
    }
    try {
      JSON.parse(body)
    } catch {
      audit({ outcome: REASONS.UPSTREAM_ERROR, uid: verified.uid, resource, status: upstreamStatus, detail: 'non-json' })
      return send(res, 502, { ok: false, reason: REASONS.UPSTREAM_ERROR, status: upstreamStatus })
    }
    cache.set(cacheKey, { body }, nowMs)
    audit({ outcome: 'OK', uid: verified.uid, resource, cache: 'miss', bytes: body.length })
    return send(res, 200, body, {
      'Cache-Control': 'private, max-age=300',
      Vary: 'Authorization',
      'X-Feicui-Cache': 'miss',
      'X-Feicui-Revocation': revocationDegraded ? 'unavailable' : 'ok'
    })
  }
}

/** Vercel 默认导出（生产实例：真 fetch ＋ 真 env ＋ 进程内缓存/限流）。 */
export default createForwardHandler()
