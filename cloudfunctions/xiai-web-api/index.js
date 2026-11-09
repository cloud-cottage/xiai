'use strict'
/**
 * 玺爱 · `api/` 云函数版（CloudBase HTTP 访问服务 · 事件型函数）
 * ============================================================================
 * 【为什么有这个函数】Vercel 的 `api/` 目录在静态托管上不存在 ⇒ 把 `api/`（health、
 *   feicui 转发、ai 两个薄壳）原样搬进本函数，由网关路由 `api/xiai` 挂载。
 *
 * 【事件形状 / 返回形状】与 `liwu-web-api` 同一套：
 *   入 `{ path, httpMethod, headers, body, isBase64Encoded, queryString(可选) }`
 *   出 `{ statusCode, headers, body, isBase64Encoded }`
 *   文本型 content-type ⇒ utf8 ＋ `false`；否则 ⇒ base64 ＋ `true`；空体恒 `''` ＋ `false`。
 *
 * 【网关剥路径 ⇒ 本文件负责把 `/api` 前缀补回去】
 *   HTTP 访问服务会把触发路径从 `event.path` 里剥掉（上一轮实测）：
 *     请求 `/api/xiai/health` ⇒ 函数收到 `/health`；请求 `/api/xiai/feicui/v1/dynasties`
 *     ⇒ 收到 `/feicui/v1/dynasties`。
 *   ⇒ `apiPathOf()` **两种形态都认**：仍带 `/api/xiai` 整段 ⇒ 剥掉再补 `/api`；
 *     已被剥掉（`/…`）⇒ 直接补 `/api`；`fn invoke` 直连给完整 `/api/…` ⇒ 原样用。
 *   补回之后的路径与 Vercel 文件路由**逐字对齐**：
 *     `/api/health`                       ⇒ `api/health.js`
 *     `/api/feicui/v1[/<path>]`           ⇒ `api/feicui/v1/[...path].js`
 *     `/api/ai/v1/images/edits`           ⇒ `api/ai/v1/images/edits.js`（薄壳，fixedPath 传死）
 *     `/api/ai/v1/images/generations`     ⇒ `api/ai/v1/images/generations.js`
 *     其余（含 `/api/` 开头但无文件的）   ⇒ 404 JSON（API 命名空间不回 HTML）
 *
 * 【模块系统（关键，别改）】
 *   · **函数根保持 CommonJS**：SCF / CloudBase 事件函数的加载路径是 `require(index.js)`
 *     （`type: module` 的根会让入口直接 `ERR_REQUIRE_ESM`）⇒ `index.js` 只用
 *     `module.exports` ＋ 运行期 `import()`；
 *   · **`api/package.json` 声明 `{"type":"module"}`** ⇒ 被搬进来的 `api/**` 逐字节保持 ESM
 *     （源码是 `import` / `export`，一个字都不改）；
 *   · 嵌套的 `cloudfunctions/xiai-user-token/package.json` **不带 `type`** ⇒ 那 16 个 lib
 *     仍是 CJS，ESM 侧 `import` 它们走 default 互操作（源码里 `x.default || x` 已兜）。
 *
 * 【实现等价】`api/**` 与仓内 `api/**` **逐字节相同**（由部署前 sha256 比对读数佐证）；
 *   本文件只做「事件 ↔ (req, res)」适配与路径分发，**不实现任何业务判定**：
 *   状态码 / 错误体 / 头面全部由源码自己给出。
 *
 * 【密钥】本函数不新增任何密钥字面量；所需 env 与 Vercel 侧同名（由函数环境变量注入）。
 */

const path = require('node:path')
const { pathToFileURL } = require('node:url')

/** 网关触发路径（可能整段出现在 `event.path` 里；被剥掉时本文件也要认）。 */
const API_TRIGGER = '/api/xiai'

/* 本函数统一自答 CORS（与 `liwu-web-api` 同族；网关侧未配置、也不该依赖网关配置）。 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, Accept, X-Request-Id, X-Liwu-Admin, X-Requested-With',
  'access-control-max-age': '600'
}

const parseSearchParams = (search = '') => {
  const query = {}
  new URLSearchParams(String(search || '')).forEach((value, key) => {
    query[key] = value
  })
  return query
}

const normalizeHeaders = (rawHeaders) => {
  const normalized = {}
  for (const [key, value] of Object.entries(rawHeaders || {})) {
    if (value === undefined || value === null) continue
    normalized[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return normalized
}

/**
 * 解析事件 ⇒ `{ method, pathname, search, query, headers, body }`。
 * query 的来源顺序：`path` 内嵌 → `event.queryString` → `queryStringParameters`
 * （**path 内嵌优先**；与 `liwu-web-api::parseRequest` 同一宽容兜底，不改语义）。
 */
const parseRequest = (event = {}) => {
  const rawPath = typeof event.path === 'string' && event.path ? event.path : '/'
  const question = rawPath.indexOf('?')
  const pathname = question >= 0 ? rawPath.slice(0, question) : rawPath
  let search = question >= 0 ? rawPath.slice(question + 1) : ''

  if (!search && typeof event.queryString === 'string' && event.queryString) {
    search = event.queryString
  }
  if (!search && event.queryStringParameters && typeof event.queryStringParameters === 'object') {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(event.queryStringParameters)) {
      params.append(key, Array.isArray(value) ? String(value[value.length - 1]) : String(value))
    }
    search = params.toString()
  }

  const isBase64Encoded = Boolean(event.isBase64Encoded)
  const rawBody = event.body === undefined || event.body === null ? '' : String(event.body)
  const body = rawBody && isBase64Encoded ? Buffer.from(rawBody, 'base64') : Buffer.from(rawBody, 'utf8')

  return {
    method: String(event.httpMethod || event.method || 'GET').toUpperCase(),
    pathname,
    search,
    query: parseSearchParams(search),
    headers: normalizeHeaders(event.headers),
    body
  }
}

/**
 * 事件路径 ⇒ Vercel 口径的 `/api/...` 路径（**只归一前缀，不碰业务段**）。
 * @param {string} pathname
 * @returns {string}
 */
const apiPathOf = (pathname) => {
  let value = String(pathname || '/')
  if (!value.startsWith('/')) value = `/${value}`
  if (value === API_TRIGGER) value = '/api'
  else if (value.startsWith(`${API_TRIGGER}/`)) value = `/api${value.slice(API_TRIGGER.length)}`
  if (value === '/api' || value === '/api/') return '/api/'
  /* 网关已把触发路径剥掉（`/health`、`/feicui/v1/…`）⇒ 补回 `/api`。 */
  if (!value.startsWith('/api/')) value = `/api${value.startsWith('/') ? value : `/${value}`}`
  return value
}

/* --------------------------------------------------------------------------- 分发
   与 Vercel 文件路由一一对应；`.default` 即各文件的 `export default`。            */

/** rel → Promise<handler>（模块只加载一次；失败不缓存，便于下次重试）。 */
const moduleCache = new Map()
const loadHandler = (relative) => {
  if (!moduleCache.has(relative)) {
    const pending = import(pathToFileURL(path.join(__dirname, relative)).href).then(
      (mod) => mod.default || mod
    )
    pending.catch(() => moduleCache.delete(relative))
    moduleCache.set(relative, pending)
  }
  return moduleCache.get(relative)
}

/** 路径 → 模块相对路径（`null` ＝ 该路径在 Vercel 上没有对应文件 ⇒ 404）。 */
const routeOf = (apiPath) => {
  if (apiPath === '/api/health') return './api/health.js'
  if (apiPath === '/api/feicui/v1' || apiPath.startsWith('/api/feicui/v1/')) {
    return './api/feicui/v1/[...path].js'
  }
  if (apiPath === '/api/ai/v1/images/edits') return './api/ai/v1/images/edits.js'
  if (apiPath === '/api/ai/v1/images/generations') return './api/ai/v1/images/generations.js'
  return null
}

/* --------------------------------------------------------------------------- req / res 垫片
   源码用到的面：`req.method` / `req.headers` / `req.url` / `req.query` / `req.body`
   ＋ `res.statusCode=` / `res.setHeader` / `res.getHeader` / `res.status()` / `res.send()`
   / `res.json()` / `res.end()`（aiRoute 的 `readBody` 走 `req.body` 分支，不挂流）。 */

const createRequestShim = ({ method, headers, query, url, body }) => ({
  method,
  headers,
  query,
  url,
  body
})

const createResponseShim = () => {
  const state = { statusCode: 200, headers: {}, body: null }

  const setBody = (chunk) => {
    if (chunk === undefined || chunk === null) {
      state.body = Buffer.alloc(0)
      return
    }
    state.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
  }

  const res = {
    get statusCode() {
      return state.statusCode
    },
    set statusCode(value) {
      state.statusCode = value
    },
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = String(value)
    },
    getHeader(name) {
      return state.headers[String(name).toLowerCase()]
    },
    status(code) {
      state.statusCode = code
      return res
    },
    json(payload) {
      state.headers['content-type'] = 'application/json; charset=utf-8'
      setBody(JSON.stringify(payload))
      return res
    },
    send(chunk) {
      setBody(chunk)
      return res
    },
    end(chunk) {
      setBody(chunk)
      return res
    }
  }

  return { res, state }
}

const isTextContentType = (contentType = '') => {
  const value = String(contentType || '').toLowerCase()
  if (!value) return false
  return (
    value.includes('json') ||
    value.startsWith('text/') ||
    value.includes('xml') ||
    value.includes('javascript') ||
    value.includes('urlencoded')
  )
}

/** 统一出口：合并 CORS ＋ 按 content-type 决定 utf8 / base64。 */
const buildResult = ({ statusCode = 200, headers = {}, body }) => {
  const buffer =
    body === undefined || body === null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(String(body), 'utf8')

  /* 上游若回 `access-control-allow-credentials`，它与 `*` 是浏览器非法组合 ⇒ 先丢再统一覆盖。 */
  const resultHeaders = { ...headers }
  delete resultHeaders['access-control-allow-credentials']
  Object.assign(resultHeaders, CORS_HEADERS)

  if (buffer.length === 0) {
    return { statusCode, headers: resultHeaders, body: '', isBase64Encoded: false }
  }
  return isTextContentType(resultHeaders['content-type'])
    ? { statusCode, headers: resultHeaders, body: buffer.toString('utf8'), isBase64Encoded: false }
    : { statusCode, headers: resultHeaders, body: buffer.toString('base64'), isBase64Encoded: true }
}

const notFound = (apiPath) =>
  buildResult({
    statusCode: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify({ error: 'not_found', message: `不支持的路径：${apiPath}` })
  })

/**
 * 网关入口。
 * @param {object} [event]
 * @returns {Promise<{statusCode:number, headers:object, body:string, isBase64Encoded:boolean}>}
 */
async function main(event = {}) {
  const { method, pathname, search, query, headers, body } = parseRequest(event)

  /* 预检：任何路径的 OPTIONS 都直接 204（不进入业务分发）。 */
  if (method === 'OPTIONS') {
    return buildResult({ statusCode: 204, headers: {}, body: null })
  }

  const apiPath = apiPathOf(pathname)
  const relative = routeOf(apiPath)
  if (!relative) return notFound(apiPath)

  const handler = await loadHandler(relative)
  const { res, state } = createResponseShim()
  const req = createRequestShim({
    method,
    headers,
    query,
    /* `req.url` 必须带 query：health 的 `?diag=1`、feicui 的 `limit/offset` 都从这里读。 */
    url: search ? `${apiPath}?${search}` : apiPath,
    body
  })
  await handler(req, res)
  return buildResult(state)
}

module.exports = {
  main,
  apiPathOf,
  routeOf,
  parseRequest,
  buildResult,
  createResponseShim,
  API_TRIGGER
}
