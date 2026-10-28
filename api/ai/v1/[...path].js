/**
 * 玺爱 · **AI 中转路由**（Vercel Serverless Function）
 * ============================================================================
 * 路由：`POST /api/ai/v1/images/edits`（有参考图）／ `POST /api/ai/v1/images/generations`
 *
 * 职责（**薄壳**）：读方法 / path / 头 / 请求体 → 交给 `api/_lib/aiRelay.js` 的纯 handler
 * （`{status, body, headers}`）→ 写回响应。**判定逻辑一律不在本文件**（同一份实现、
 * 两条入口：生产走本文件、离线自检 `scripts/verify-ai-relay.mjs` 直调 handler）。
 *
 * 硬口径（逐条）：
 *   ① **只认 POST**；path 白名单封闭两值（`images/edits` / `images/generations`）；
 *      其余（含多段、空、`models`）⇒ 404 `PATH_NOT_ALLOWED`；非 POST ⇒ 405 `METHOD_NOT_ALLOWED`。
 *   ② 鉴权：`Authorization` 头按 `Bearer` 方案取凭据且值须以 `sk-xiai-` 开头；否则 401 `KEY_INVALID`
 *      （**不向客户端区分失败原因**）。
 *   ③ 必填头 `X-Request-Id`（8〜64 字）＝幂等键的组成部分；缺 / 非法 ⇒ 400 `INVALID_ARGUMENT`。
 *   ④ **请求体只读原始字节**（本文件不解析 JSON、不拼对象 ⇒ 解析与值域门只在核心一处）；
 *      有上限（`MAX_BODY_BYTES`），超限按非法体走 400；**不接受 multipart**。
 *   ⑤ 响应恒 `Cache-Control: no-store`（本路由是 bearer 保护的，**不得**给 CDN 共享缓存）。
 *   ⑥ 本文件与核心**都不打印任何凭据 / 密文 / 令牌 / prompt**（日志只给布尔与状态码）。
 *
 * 超时：`vercel.json` 的 `functions` 段给本函数 `maxDuration: 60`（与上游 `timeout_ms`
 * 缺省 60000ms 对齐）。
 *
 * 离线自检：`scripts/verify-ai-relay.mjs` —— 真 handler ＋ 真 `http.createServer` ＋ 假上游
 * ＋ 注入 store / clock / fetch。
 */

import { createAiRelay, MAX_BODY_BYTES } from '../../_lib/aiRelay.js'

/** 路由前缀（Vercel catch-all 的 path 段拼回完整路径用）。 */
export const ROUTE_PREFIX = '/api/ai/v1'

/** 默认错误体（核心未回结果时的兜底；**仍落在冻结的 reason 面内**）。 */
const FALLBACK_BODY = { ok: false, reason: 'CONFIG_MISSING', message: 'AI 中轉服務未配置完成；請稍後再試。' }

/**
 * 取路由 path（优先 Vercel 的 `req.query.path`〔catch-all 数组〕，其次 `req.url`）。
 * @param {object} req
 * @returns {string}
 */
export function pathOf(req) {
  const query = (req && req.query) || {}
  if (query.path !== undefined && query.path !== null) {
    const raw = Array.isArray(query.path) ? query.path.join('/') : String(query.path)
    return `${ROUTE_PREFIX}/${raw}`
  }
  return req && typeof req.url === 'string' && req.url ? req.url : '/'
}

/**
 * 读**原始**请求体（不解析、不拼装；`req.body` 已被宿主给定时直接用）。
 * 超过 `MAX_BODY_BYTES` ⇒ 丢弃并回空串（核心按非法体 ⇒ 400）。
 * @param {object} req
 * @returns {Promise<string|Buffer|object>}
 */
export function readBody(req) {
  if (!req || typeof req.on !== 'function') {
    return Promise.resolve(req && req.body !== undefined ? req.body : '')
  }
  if (req.body !== undefined && req.body !== null) return Promise.resolve(req.body)
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let overflow = false
    req.on('data', (chunk) => {
      if (overflow) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    const finish = () => resolve(overflow ? '' : Buffer.concat(chunks))
    req.on('end', finish)
    req.on('error', finish)
    req.on('aborted', finish)
  })
}

/**
 * 写响应（状态码 ＋ 冻结头面 ＋ 核心给的额外头；体恒 JSON）。
 * @param {object} res Node `ServerResponse`（或同形对象）
 * @param {{status:number, body:object, headers?:object}} result
 */
export function send(res, result) {
  if (!res || typeof res.end !== 'function') return
  const status = Number(result && result.status) || 503
  const body = result && result.body && typeof result.body === 'object' ? result.body : FALLBACK_BODY
  const headers = (result && result.headers) || {}
  try {
    res.statusCode = status
    if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      for (const key of Object.keys(headers)) res.setHeader(key, headers[key])
    }
    res.end(JSON.stringify(body))
  } catch {
    /* 响应已发出 / 头已送 ⇒ 不再补写（不影响判定结果） */
  }
}

/**
 * 路由处理器工厂（**注入缝**：`fetch` / `now` / `resolveImageUrl` / `env` / `stores`）。
 * @param {object} [deps] 透传给 `createAiRelay`
 * @returns {(req:object, res:object)=>Promise<void>}
 */
export function createHandler(deps) {
  const handle = createAiRelay(deps)
  return async function routeHandler(req, res) {
    const body = await readBody(req)
    const result = await handle({
      method: req && req.method,
      path: pathOf(req),
      headers: (req && req.headers) || {},
      body
    })
    send(res, result)
  }
}

/** Vercel 默认导出（生产实例：真 env ＋ 真 fetch ＋ 默认签名链实现）。 */
export default createHandler()
