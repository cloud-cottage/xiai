'use strict'
/**
 * 玺爱 · `/xiai/` 子路径 SPA 网关函数（CloudBase HTTP 访问服务 · 事件型函数）
 * ============================================================================
 * 【为什么有这个函数】静态托管域只出 COS 文件、不走网关；网关域只走路由、无静态回落。
 *   ⇒ 线上 `/xiai/*` 全部由本函数代答：**深链回 HTML** ＋ **`/assets/*` 原样代理静态域**。
 *
 * 【事件形状（HTTP 访问服务 → 本函数）】`{ path, httpMethod, headers, body, isBase64Encoded }`
 *   【返回形状（本函数 → 网关）】`{ statusCode, headers, body, isBase64Encoded }`：
 *   文本型 content-type ⇒ utf8 字符串 ＋ `false`；否则（图片 / 字体 / wasm…）⇒ base64 ＋ `true`。
 *
 * 【网关剥路径（上一轮实测，本文件按它写）】
 *   请求 `/xiai/assets/x.js` ⇒ 函数收到 `/assets/x.js`；请求 `/xiai/` ⇒ 收到 `/`。
 *   ⇒ 本文件**两种形态都认**：`event.path` 里仍带 `/xiai` 前缀时先剥掉（直连 invoke 也可用）。
 *
 * 【判定顺序（末段有无扩展名 = 静态文件形 vs 深链）】
 *   ① `rel` 为 `/` 或空 ⇒ 目标 `/xiai/index.html`
 *   ② 末段**含扩展名**（`/\.[a-z0-9]{1,12}$/i`）⇒ 目标 `/xiai<rel>`（**原样代理**，
 *      透传 `content-type` / `cache-control`，二进制走 base64）
 *   ③ 其余（无扩展名深链，SPA 路由不含 `.`）⇒ 目标 `/xiai/index.html`
 *   目标拉不到时：**回退类**（①③，即 index.html）⇒ 502 纯文本（不假装 200；
 *     进程内仍有上一次好值 ⇒ 先回退旧值 `source=stale`）；**文件形**（②）⇒ **404 JSON**
 *     （静态文件不由本函数编造，把「静态域没有这个文件」如实回出去）。
 *
 * 【缓存】进程内存 Map、**TTL 5 min**、按目标 URL 作键、上限 64 条；只缓存 2xx；
 *   失败不写缓存（避免把 404 / 网络错钉死 5 分钟）。**不落盘、不跨实例**，冷启动即空。
 *
 * 【纪律】本函数不读写任何数据库集合、不碰 liwu 根路径、只读静态域；密钥零持有。
 */

/** 静态托管域（＝本环境静态网站域；**只读**，只往其 `/xiai/` 取，绝不写）。 */
const STATIC_HOST = 'https://liwu-cny1313-d1gb2fukyb7cb19bb-1463728495.tcloudbaseapp.com'
/** 子路径前缀（静态托管里玺爱的挂载点；根 `/` 归 liwu，本函数一个字节都不碰根）。 */
const STATIC_PREFIX = '/xiai'
/** 回退目标（SPA 唯一入口）。 */
const INDEX_PATH = '/xiai/index.html'

const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_ENTRIES = 64
const FETCH_TIMEOUT_MS = 10000

/** 静态文件形路径（末段含扩展名）；SPA 路由本身不含 `.`。 */
const STATIC_FILE_LIKE = /\.[a-z0-9]{1,12}$/i

/** 模块级缓存：target → { status, contentType, cacheControl, body: Buffer, storedAt }。 */
const store = new Map()

/* 本函数统一自答 CORS（网关侧未配置、也不该依赖网关配置）。 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, Accept, X-Requested-With',
  'access-control-max-age': '600'
}

function isTextContentType(contentType) {
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

/**
 * 归一 `event.path` ⇒ **去掉 query、去掉 `/xiai` 前缀**的站点内相对路径。
 * @param {string} [rawPath]
 * @returns {string} 恒以 `/` 开头；`/` 表示站点根。
 */
function relPathOf(rawPath) {
  let value = String(rawPath === undefined || rawPath === null ? '/' : rawPath)
  const question = value.indexOf('?')
  if (question >= 0) value = value.slice(0, question)
  if (!value.startsWith('/')) value = `/${value}`
  if (value === '/xiai') return '/'
  if (value.startsWith('/xiai/')) return value.slice('/xiai'.length) || '/'
  return value
}

/**
 * 站点内相对路径 ⇒ 静态域目标 URL 路径（判定顺序见文件头 ①②③）。
 * @param {string} rel
 * @returns {{target:string, fallback:boolean}} `fallback:true` ⇒ 目标是 index.html（回退类）
 */
function targetOf(rel) {
  if (rel === '/' || rel === '') return { target: INDEX_PATH, fallback: true }
  const last = rel.slice(rel.lastIndexOf('/') + 1)
  if (!STATIC_FILE_LIKE.test(last)) return { target: INDEX_PATH, fallback: true }
  return { target: `${STATIC_PREFIX}${rel}`, fallback: false }
}

/**
 * 取一个目标（带 5 min 进程内缓存）。**不抛**：失败一律 `{ ok:false }` ＋ 可选 `stale`。
 * @param {string} target
 * @returns {Promise<{ok:boolean, source?:string, entry?:object, stale?:object, status?:number, detail?:string}>}
 */
async function load(target) {
  const now = Date.now()
  const hit = store.get(target)
  if (hit && now - hit.storedAt < CACHE_TTL_MS) return { ok: true, source: 'cache', entry: hit }

  try {
    const reply = await fetch(STATIC_HOST + target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!reply.ok) {
      /* 失败不写缓存；旧值（若有）留给调用方决定是否回退。 */
      return { ok: false, status: reply.status, detail: `HTTP ${reply.status}`, stale: hit || null }
    }
    const buffer = Buffer.from(await reply.arrayBuffer())
    const entry = {
      status: reply.status,
      contentType: reply.headers.get('content-type') || '',
      cacheControl: reply.headers.get('cache-control') || '',
      body: buffer,
      storedAt: Date.now()
    }
    store.set(target, entry)
    while (store.size > CACHE_MAX_ENTRIES) {
      const oldest = store.keys().next()
      if (oldest.done) break
      store.delete(oldest.value)
    }
    return { ok: true, source: 'fresh', entry }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      detail: String((error && error.message) || error || 'fetch failed'),
      stale: hit || null
    }
  }
}

/** 统一出口：合并 CORS ＋ 按 content-type 决定 utf8 / base64。 */
function buildResult({ statusCode = 200, headers = {}, body }) {
  const buffer =
    body === undefined || body === null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(String(body), 'utf8')

  const resultHeaders = { ...headers, ...CORS_HEADERS }
  if (buffer.length === 0) {
    return { statusCode, headers: resultHeaders, body: '', isBase64Encoded: false }
  }
  return isTextContentType(resultHeaders['content-type'])
    ? { statusCode, headers: resultHeaders, body: buffer.toString('utf8'), isBase64Encoded: false }
    : { statusCode, headers: resultHeaders, body: buffer.toString('base64'), isBase64Encoded: true }
}

function serve(entry, source, fallback) {
  const contentType = entry.contentType || (fallback ? 'text/html; charset=utf-8' : 'application/octet-stream')
  const headers = {
    'content-type': contentType,
    /* 回退类（index.html）恒 `no-cache`：SPA 外壳必须每次校验；文件形原样透传上游 cache-control。 */
    'cache-control': fallback ? 'no-cache' : entry.cacheControl || 'no-cache',
    /* 调试 / 验收用：区分「新取 / 命中缓存 / 失败回退旧值」。 */
    'x-xiai-spa-source': source
  }
  return buildResult({ statusCode: entry.status || 200, headers, body: entry.body })
}

/**
 * 网关入口。
 * @param {{path?:string, httpMethod?:string, method?:string}} [event]
 * @returns {Promise<{statusCode:number, headers:object, body:string, isBase64Encoded:boolean}>}
 */
async function main(event = {}) {
  const method = String(event.httpMethod || event.method || 'GET').toUpperCase()
  if (method === 'OPTIONS') {
    return buildResult({ statusCode: 204, headers: {}, body: null })
  }

  const rel = relPathOf(event.path)
  const { target, fallback } = targetOf(rel)

  const outcome = await load(target)
  if (outcome.ok) return serve(outcome.entry, outcome.source, fallback)
  if (outcome.stale) return serve(outcome.stale, 'stale', fallback)

  if (fallback) {
    /* 回退类首次即失败 ⇒ 502 纯文本（不假装 200）。 */
    return buildResult({
      statusCode: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' },
      body: `首页 HTML 获取失败：${outcome.detail || 'unknown error'}`
    })
  }
  /* 文件形拉不到 ⇒ 404 JSON（如实回「静态域没有这个文件」，不编造字节）。 */
  return buildResult({
    statusCode: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' },
    body: JSON.stringify({
      error: 'not_found',
      message: `静态文件取不到（静态托管无此文件）：${target}`,
      upstream_status: Number(outcome.status) || 0
    })
  })
}

module.exports = {
  main,
  relPathOf,
  targetOf,
  buildResult,
  STATIC_HOST,
  STATIC_PREFIX,
  INDEX_PATH
}
