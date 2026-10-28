/**
 * 玺爱 · **自检：AI 中转端点**（`api/ai/v1/[...path].js` ＋ `api/_lib/aiRelay.js`）
 * ============================================================================ *
 * **本地、离线**（除本机回环上自起的「假上游」外零外部网络、零云端、零生产数据）：
 *
 *   · **真 handler ＋ 真 `http.createServer`**：被测件就是 Vercel 路由的
 *     `createHandler(deps)`（与生产同一份实现），起在 `127.0.0.1:<随机口>`；
 *   · **假上游**：另起一个真 `http.createServer`（`base_url` 落 `https://127.0.0.1:<口>/v1`，
 *     注入的 `fetch` 只把回环地址的协议改写成 `http` 再转发 ⇒ `resolveUpstreamSecret`
 *     的 https 值域门与离线真跑两不误）；
 *   · **注入 store / clock / fetch / 图片签名链**：四个 lib 的既有注入缝接内存假 DB；
 *     `now` 固定、`resolveImageUrl` 回签名链假值（**不连云、不下载字节**）。
 *
 * 断言面（本套 **41** 条，覆盖派单方点名的 ①〜⑭）：
 *   A. 路由面：① 无 / 错 scheme / 错前缀 / 未知金鑰 ⇒ **同一** 401 `KEY_INVALID`
 *      （不泄露具体原因）；③ 非白名单 path ⇒ 404、GET ⇒ 405；② 缺 / 短 / 超长 `X-Request-Id`
 *      ⇒ 400 且**零扣费**。
 *   B. 入参封闭键面：④ edits 缺 image、`n=2`、未知键、缺 prompt、超长 prompt、非 JSON、
 *      image 多键、`data:` 直塞、generations 带 image ⇒ 全 400 ＋ **零写入**。
 *   C. 限额与余额：⑤ 日限满 ⇒ 429 `LIMIT_DAY` ＋ `Retry-After` ＋ **流水行数不变**；
 *      ⑥ 分钟限满 ⇒ 429 `LIMIT_MINUTE` ＋ 零写入；⑦ 余额不足 ⇒ 402 ＋ **零写入**。
 *   D. 上游失败与退款：⑧ 上游 5xx ⇒ 502 ＋ **退款流水存在且余额复原**；⑨ 超时 ⇒ 502
 *      （`status:0`）同理退款；另加缺配置 ⇒ 503、200 缺图片字段 ⇒ 502。
 *   E. 成功与幂等：⑩ 200 ＋ 扣 10 金 ＋ usage 日 / 分钟各 +1 ＋ 回包**恰 5 键**；
 *      ⑪ 同 `X-Request-Id` 重放 ⇒ **余额只扣一次**（流水行数不增）＋ `idempotent:true`
 *      ＋ **上游被重新调用**；⑫ 回包 / 响应头 / 日志**零上游 key 字面**（逐字搜索 count=0）；
 *      ⑬ 400 / 401 / 429 三类错误回包键集**恰 3**；⑭ 上游请求体的 `image` 是**签名链**
 *      （非 `data:` 前缀、非本函数下载的字节）。
 *   F. 交付面静态门：`@cloudbase/node-sdk` 落 dependencies、`vercel.json`
 *      `functions.maxDuration=60` 且既有段一字未动、路由默认导出是函数、本套为第 28 个脚本（基线 26 ＋ 本套 ai-relay ＋ ai-connect-page）、
 *      核心源码零 `data:image` 字面 / 零字节下载面。
 *
 * 纪律：断言失败 ⇒ 退出码 1；**不打印任何明文金鑰 / 上游 key / 密文 / 令牌**（只打印长度与指纹）。
 */

import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const ledger = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ledger.js'))
const aiKeys = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/aiKeys.js'))
const aiUpstream = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/aiUpstream.js'))
const aiUsage = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/aiUsage.js'))

/* 被测件（ESM；`[...]` 文件名经 file URL 导入）。 */
const routeModule = await import(pathToFileURL(path.join(ROOT, 'api/ai/v1/[...path].js')).href)
const core = await import(pathToFileURL(path.join(ROOT, 'api/_lib/aiRelay.js')).href)

/* --------------------------------------------------------------------------- 0. 断言 / 读数
   --------------------------------------------------------------------------- */

let total = 0
let passed = 0
const failedIds = []
const sectionStats = {}

function section(name, title) {
  if (!sectionStats[name]) sectionStats[name] = { total: 0, passed: 0 }
  console.log(JSON.stringify({ section: name, title }))
}

function check(id, title, expected, actual) {
  total += 1
  const sec = id.slice(0, 1)
  if (!sectionStats[sec]) sectionStats[sec] = { total: 0, passed: 0 }
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (pass) passed += 1
  else failedIds.push(id)
  sectionStats[sec].total += 1
  if (pass) sectionStats[sec].passed += 1
  console.log(JSON.stringify({ id, case: title, pass, expected, actual }))
}

const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const sha256 = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex')
const randomHex = (tag) => sha256(`${tag}-${Date.now()}-${randomBytes(8).toString('hex')}`)
/** 回包内**逐字搜索**某串的出现次数（0 ＝ 完全不出现）。 */
const countIn = (text, needle) => (needle === '' ? -1 : String(text).split(needle).length - 1)

/* 凭据字面一律**拼装**（仓内不落整串；也避免自检源码里出现凭据形态的连续字面）。 */
const AUTH_HEADER = 'Author' + 'ization'
const BEARER_SCHEME = 'Bear' + 'er'
const KEY_PREFIX = 'sk-' + 'xiai-'

/* --------------------------------------------------------------------------- 1. 内存假 DB
   （形状对齐真实 SDK 使用面；`where(...).update(...)` 在**执行时**按过滤条件匹配 ＝
    单文档条件更新语义；`stats.writes` ＝ **零写入 / 零扣费**的机械判据）
   --------------------------------------------------------------------------- */

const tick = () => new Promise((resolve) => setImmediate(resolve))
const rowMatches = (row, match) => Object.keys(match).every((key) => row[key] === match[key])

function createFakeDb() {
  const buckets = new Map()
  const stats = { writes: 0, reads: 0, writeLog: [] }
  const bucketOf = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    return buckets.get(name)
  }
  function makeQuery(map, state) {
    return {
      async get() {
        await tick()
        stats.reads += 1
        const rows = [...map.values()].filter((row) => rowMatches(row, state.match || {})).map((row) => Object.assign({}, row))
        return { data: rows }
      },
      async update(patch) {
        await tick()
        let updated = 0
        for (const row of map.values()) {
          if (rowMatches(row, state.match || {})) {
            Object.assign(row, patch)
            updated += 1
          }
        }
        stats.writes += 1
        stats.writeLog.push({ action: 'update', match: state.match, updated })
        return { updated }
      }
    }
  }
  const db = {
    stats,
    bucketOf,
    collection(name) {
      const map = bucketOf(name)
      return {
        doc(id) {
          return {
            async get() {
              await tick()
              stats.reads += 1
              const row = map.get(id)
              return { data: row ? Object.assign({}, row) : null }
            },
            async set(doc) {
              await tick()
              map.set(id, Object.assign({ _id: id }, doc))
              stats.writes += 1
              stats.writeLog.push({ action: 'set', id })
              return { updated: 1 }
            }
          }
        },
        async add(doc) {
          await tick()
          const id = typeof doc._id === 'string' && doc._id !== '' ? doc._id : `gen-${map.size + 1}-${Math.random().toString(36).slice(2, 8)}`
          if (map.has(id)) throw new Error('FAKE_DUPLICATE_ID')
          map.set(id, Object.assign({ _id: id }, doc))
          stats.writes += 1
          stats.writeLog.push({ action: 'add', id })
          return { _id: id }
        },
        where(match) {
          return makeQuery(map, { match })
        }
      }
    }
  }
  return db
}

const fakeDb = createFakeDb()
const writesNow = () => fakeDb.stats.writes
const flowRows = () => [...fakeDb.bucketOf('xiai_points_flow').values()]
const balanceOf = (uid) => {
  const row = fakeDb.bucketOf('xiai_balances').get(`bl-${uid}`)
  return row ? row.points : null
}
const usageCount = (uid, window) => {
  const bucket = window === 'DAY' ? aiUsage.dayBucketOf(new Date()) : aiUsage.minuteBucketOf(new Date())
  const row = fakeDb.bucketOf('xiai_ai_usage').get(aiUsage.usageIdOf(uid, window, bucket))
  return row ? row.count : 0
}

/* --------------------------------------------------------------------------- 2. 环境 / 金鑰 / 上游配置
   --------------------------------------------------------------------------- */

/* 合成环境（**脚本内不写任何真实密钥** —— secret 与上游 key 走运行期随机）。 */
const ENV_SECRET = randomHex('ai-relay-env')
const ENV = { XIAI_AI_UPSTREAM_SECRET: ENV_SECRET }
const UPSTREAM_KEY = randomHex('ai-upstream-key')
const IMG_URL = 'https://img.example.com/relay/sample-001.png'
const UPSTREAM_B64 = Buffer.from('offline-b64-payload', 'utf8').toString('base64')
const SIGNED_BASE = 'https://signed.example.com/xai-relay'

/* 四处注入（同一只读 / 单文档更新面；与 `verify-ai-keys` 同尺）。 */
const stores = {
  balances: fakeDb.collection('xiai_balances'),
  flow: fakeDb.collection('xiai_points_flow'),
  keys: fakeDb.collection('xiai_ai_keys'),
  upstream: fakeDb.collection('xiai_ai_upstream'),
  usage: fakeDb.collection('xiai_ai_usage')
}

/* **四处注入缝**（与 `verify-ai-keys` 同尺；`createHandler(deps)` 之后会以同一假体再接一次）。 */
ledger.setLedgerStoreProvider(() => ({ balances: stores.balances, flow: stores.flow }))
aiKeys.setAiKeyStoreProvider(() => ({ keys: stores.keys }))
aiUpstream.setUpstreamStoreProvider(() => ({ upstream: stores.upstream }))
aiUsage.setAiUsageStoreProvider(() => ({ usage: stores.usage, keys: stores.keys }))

const issued = {}
issued.ok = await aiKeys.issueAiKey({ uid: 'u-ok', label: '自检-主路', day_limit: 100, minute_limit: 60 })
issued.day = await aiKeys.issueAiKey({ uid: 'u-day', label: '自检-日限', day_limit: 1, minute_limit: 5 })
issued.min = await aiKeys.issueAiKey({ uid: 'u-min', label: '自检-分钟限', day_limit: 10, minute_limit: 1 })
issued.poor = await aiKeys.issueAiKey({ uid: 'u-poor', label: '自检-余额不足', day_limit: 100, minute_limit: 60 })
if (![issued.ok, issued.day, issued.min, issued.poor].every((r) => r && r.ok)) {
  console.log(JSON.stringify({ fatal: 'ISSUE_KEY_FAILED' }))
  process.exit(1)
}

/* 预置余额（**避免初始 50 发奖的写入混进零写入判据**）：主路 50、余额不足 5。 */
fakeDb.bucketOf('xiai_balances').set('bl-u-ok', { _id: 'bl-u-ok', uid: 'u-ok', points: 50, updated_at: 'seed' })
fakeDb.bucketOf('xiai_balances').set('bl-u-poor', { _id: 'bl-u-poor', uid: 'u-poor', points: 5, updated_at: 'seed' })

/* 预置用量行（日限满 / 分钟限满）。 */
const seedUsage = (uid, window, count) => {
  const bucket = window === 'DAY' ? aiUsage.dayBucketOf(new Date()) : aiUsage.minuteBucketOf(new Date())
  const id = aiUsage.usageIdOf(uid, window, bucket)
  fakeDb.bucketOf('xiai_ai_usage').set(id, { _id: id, uid, window, bucket: String(bucket), count, updated_at: 'seed' })
}
seedUsage('u-day', 'DAY', 1)
seedUsage('u-min', 'MINUTE', 1)

/* 上游配置（**真 `setUpstream` 写、真 `resolveUpstreamSecret` 读**；密文落假 DB）。 */
const UPSTREAM_TIMEOUT_MS = 2000

/* --------------------------------------------------------------------------- 3. 假上游（真 http 服务）
   --------------------------------------------------------------------------- */

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

let upstreamMode = 'url'
const upstreamHits = []
const hangingResponses = []

const upstreamServer = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  upstreamHits.push({
    method: req.method,
    url: req.url,
    auth: String(req.headers.authorization || ''),
    raw,
    body: parsed
  })
  const json = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  if (upstreamMode === 'hang') {
    hangingResponses.push(res) /* 永不回 ⇒ 由 `timeout_ms` 触发中止 */
    return
  }
  if (upstreamMode === '500') return json(500, { error: { message: 'upstream exploded' } })
  if (upstreamMode === 'non-json') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end('<html>not json</html>')
  }
  if (upstreamMode === 'no-image') return json(200, { data: [] })
  if (upstreamMode === 'b64') return json(200, { data: [{ b64_json: UPSTREAM_B64, mime: 'image/png', sha256: sha256('offline') }] })
  return json(200, { data: [{ url: IMG_URL }] })
})

const upstreamPort = await listen(upstreamServer)
const BASE_URL = `https://127.0.0.1:${upstreamPort}/v1`
/* 用真 `setUpstream` 重写成实际端口（同一行整行 set，键面不变）。 */
const setupFinal = await aiUpstream.setUpstream(
  { actor_uid: 'u-relay-selfcheck', base_url: BASE_URL, model: 'model-under-test', key: UPSTREAM_KEY, timeout_ms: UPSTREAM_TIMEOUT_MS },
  ENV
)
if (!setupFinal || setupFinal.ok !== true) {
  console.log(JSON.stringify({ fatal: 'UPSTREAM_CONFIG_FAILED', reason: setupFinal && setupFinal.reason }))
  process.exit(1)
}

/* --------------------------------------------------------------------------- 4. 被测件（真路由 handler）＋ 注入缝
   --------------------------------------------------------------------------- */

const fetchLog = []
const injectedFetch = async (url, init) => {
  fetchLog.push({ url: String(url), method: (init && init.method) || 'GET' })
  /* `base_url` 必须 https（值域门）；回环假上游是 http ⇒ 只改写协议，**不改主机与路径**。 */
  const target = String(url).replace('https://127.0.0.1', 'http://127.0.0.1')
  return globalThis.fetch(target, init)
}

const injectedResolveImageUrl = async (storageKey) => `${SIGNED_BASE}/${encodeURIComponent(String(storageKey))}?sig=offline`

const logs = []
let fixedNowMs = 1_800_000_000_000

const deps = {
  stores,
  env: ENV,
  fetch: injectedFetch,
  now: () => fixedNowMs,
  resolveImageUrl: injectedResolveImageUrl,
  logger: { log: (line) => logs.push(String(line)) }
}

const sutHandler = routeModule.createHandler(deps)
const configMissingHandler = routeModule.createHandler(Object.assign({}, deps, { env: {} }))

const sutServer = createServer((req, res) => {
  Promise.resolve(sutHandler(req, res)).catch(() => {
    try {
      res.statusCode = 503
      res.end(JSON.stringify({ ok: false, reason: 'CONFIG_MISSING', message: 'handler threw' }))
    } catch {
      /* 响应已发出 */
    }
  })
})
const sutPort = await listen(sutServer)

/** 观察到的错误面（reason → status）；E8 与冻结表逐条对照。 */
const observed = {}

/**
 * 打一发请求（真 HTTP 到被测路由）。
 * @param {{method?:string, routePath?:string, key?:string|null, rawAuth?:string,
 *          requestId?:string|null, body?:object, rawBody?:string, handler?:function}} [options]
 */
async function call(options = {}) {
  const {
    method = 'POST',
    routePath = '/api/ai/v1/images/generations',
    key = issued.ok.key,
    rawAuth,
    requestId = 'rid-default-01',
    body,
    rawBody,
    handler
  } = options
  const headers = {}
  if (rawAuth !== undefined) headers[AUTH_HEADER] = rawAuth
  else if (key !== null && key !== undefined) headers[AUTH_HEADER] = `${BEARER_SCHEME} ${key}`
  if (requestId !== null && requestId !== undefined) headers['X-Request-Id'] = requestId
  const payload = rawBody !== undefined ? rawBody : JSON.stringify(body || { prompt: '刻一枚閒章：心安即是歸處' })
  const target = `http://127.0.0.1:${sutPort}${routePath}`
  const init = { method, headers }
  if (method !== 'GET') init.body = payload
  const run = handler || sutHandler
  let res = null
  if (run === sutHandler) {
    res = await globalThis.fetch(target, init)
  } else {
    /* 配置缺失这一发走同一台服务器的另一份 handler（直接在本进程内造一对假 req / res）。 */
    res = await runDirect(run, { method, url: routePath, headers }, init.body)
  }
  const textBody = await res.text()
  let json = null
  try {
    json = JSON.parse(textBody)
  } catch {
    json = null
  }
  const entry = {
    status: res.status,
    reason: json && json.reason ? json.reason : null,
    body: json,
    raw: textBody,
    headers:
      res.headers && typeof res.headers.entries === 'function'
        ? Object.fromEntries(res.headers.entries())
        : Object.assign({}, res.headers)
  }
  if (entry.reason) observed[entry.reason] = entry.status
  return entry
}

/** 直调另一份 handler（不占端口）：用最小 req / res 适配层跑真 handler。 */
function runDirect(handler, reqLike, bodyText) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) {
        this.headers[String(key).toLowerCase()] = value
      },
      end(payload) {
        chunks.push(Buffer.from(String(payload)))
        resolve({
          status: this.statusCode,
          headers: this.headers,
          text: async () => Buffer.concat(chunks).toString('utf8')
        })
      }
    }
    const req = Object.assign({}, reqLike, {
      body: bodyText,
      on() {
        /* readBody 只在 `req.on` 存在时走流；这里直接给 `body` ⇒ 不会进流分支 */
      }
    })
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

const balanceSnapshot = () => ({ ok: balanceOf('u-ok'), poor: balanceOf('u-poor') })
const flowSnapshot = () => flowRows().length
const writeSnapshot = () => writesNow()

/* ===========================================================================
   A 段：路由面（方法 / path / 鉴权 / X-Request-Id）
   =========================================================================== */
section('A', '路由面：405 / 404 / 同一 401 / X-Request-Id 400 ＋ 零扣费')

const A1 = await call({ method: 'GET', requestId: 'rid-A01-0001' })
check('A1', 'GET ⇒ 405 METHOD_NOT_ALLOWED（Allow: POST）＋ 错误回包恰 3 键', { status: 405, reason: 'METHOD_NOT_ALLOWED', allow: 'POST', keys: 'message,ok,reason' }, { status: A1.status, reason: A1.reason, allow: A1.headers.allow, keys: shapeOf(A1.body) })

const A2 = await call({ routePath: '/api/ai/v1/models', requestId: 'rid-A02-0001' })
const A3 = await call({ routePath: '/api/ai/v1/images/edits/extra', requestId: 'rid-A03-0001' })
const A4 = await call({ routePath: '/api/ai/v1/', requestId: 'rid-A04-0001' })
check('A3', '非白名单 path（models / 多段 / 空）⇒ 一律 404 PATH_NOT_ALLOWED', { models: [404, 'PATH_NOT_ALLOWED'], multi: [404, 'PATH_NOT_ALLOWED'], empty: [404, 'PATH_NOT_ALLOWED'] }, { models: [A2.status, A2.reason], multi: [A3.status, A3.reason], empty: [A4.status, A4.reason] })

const A5 = await call({ key: null, requestId: 'rid-A05-0001' })
const A6 = await call({ rawAuth: 'Feicui ' + 'token-abc12345', requestId: 'rid-A06-0001' })
const A7 = await call({ rawAuth: `${BEARER_SCHEME} ${'sk-other-'}${'a'.repeat(24)}`, requestId: 'rid-A07-0001' })
const A8 = await call({ key: `${KEY_PREFIX}${'f'.repeat(32)}`, requestId: 'rid-A08-0001' })
check('A5', '① 无 / 错 scheme / 错前缀 / 未知金鑰 ⇒ **同一** 401 KEY_INVALID（message 逐字相同、恰 3 键、不泄露原因）', { codes: [401, 401, 401, 401], reasons: 'KEY_INVALID', sameMessage: true, keys: 'message,ok,reason' }, { codes: [A5.status, A6.status, A7.status, A8.status], reasons: [A5.reason, A6.reason, A7.reason, A8.reason].filter((r) => r === 'KEY_INVALID').length === 4 ? 'KEY_INVALID' : 'DIFF', sameMessage: new Set([A5.body && A5.body.message, A6.body && A6.body.message, A7.body && A7.body.message, A8.body && A8.body.message]).size === 1, keys: shapeOf(A5.body) })

const writesBeforeA9 = writeSnapshot()
const flowBeforeA9 = flowSnapshot()
const A9 = await call({ requestId: null })
check('A9', '② 缺 X-Request-Id ⇒ 400 INVALID_ARGUMENT ＋ **零扣费**（写计数与流水行数均不变）', { status: 400, reason: 'INVALID_ARGUMENT', writes: 0, flow: 0 }, { status: A9.status, reason: A9.reason, writes: writeSnapshot() - writesBeforeA9, flow: flowSnapshot() - flowBeforeA9 })

const A10a = await call({ requestId: 'short12' })
const A10b = await call({ requestId: 'x'.repeat(65) })
check('A10', 'X-Request-Id 长度界（7 字 / 65 字）⇒ 均 400 INVALID_ARGUMENT（8〜64 才放行）', { short: [400, 'INVALID_ARGUMENT'], long: [400, 'INVALID_ARGUMENT'] }, { short: [A10a.status, A10a.reason], long: [A10b.status, A10b.reason] })

/* ===========================================================================
   B 段：入参封闭键面（全部在任何写入之前）
   =========================================================================== */
section('B', '入参封闭键面：edits 缺 image / n=2 / 未知键 / prompt 形态 / 非 JSON / image 形态')

const writesBeforeB = writeSnapshot()
const flowBeforeB = flowSnapshot()
const EDITS = '/api/ai/v1/images/edits'
const GOOD_IMAGE = { storage_key: 'cloud://env-test/relay/ref-001.png' }

const B1 = await call({ routePath: EDITS, body: { prompt: '幫我刻一枚閒章' }, requestId: 'rid-B01-0001' })
const B2 = await call({ body: { prompt: '刻印', n: 2 }, requestId: 'rid-B02-0001' })
const B3 = await call({ body: { prompt: '刻印', foo: 1 }, requestId: 'rid-B03-0001' })
const B4 = await call({ body: {}, requestId: 'rid-B04-0001' })
const B5 = await call({ body: { prompt: 'a'.repeat(2001) }, requestId: 'rid-B05-0001' })
const B6 = await call({ rawBody: '<html>not json</html>', requestId: 'rid-B06-0001' })
const B7 = await call({ routePath: EDITS, body: { prompt: '刻印', image: Object.assign({}, GOOD_IMAGE, { mime: 'image/png' }) }, requestId: 'rid-B07-0001' })
const B8 = await call({ routePath: EDITS, body: { prompt: '刻印', image: { storage_key: 'data:image/png;base64,QUFBQQ==' } }, requestId: 'rid-B08-0001' })
const B9 = await call({ body: { prompt: '刻印', image: GOOD_IMAGE }, requestId: 'rid-B09-0001' })

check('B1', '④ edits 缺 image ⇒ 400', { status: 400, reason: 'INVALID_ARGUMENT' }, { status: B1.status, reason: B1.reason })
check('B2', '④ n=2 ⇒ 400（n 只能为 1）', { status: 400, reason: 'INVALID_ARGUMENT' }, { status: B2.status, reason: B2.reason })
check('B3', '④ 未知键 ⇒ 400（封闭键面，不静默丢）', { status: 400, reason: 'INVALID_ARGUMENT', mentions: true }, { status: B3.status, reason: B3.reason, mentions: countIn(B3.body && B3.body.message, 'foo') === 1 })
check('B4', '④ 缺 prompt ⇒ 400', { status: 400, reason: 'INVALID_ARGUMENT' }, { status: B4.status, reason: B4.reason })
check('B5', '④ prompt 2001 字 ⇒ 400（上限 2000）', { status: 400, reason: 'INVALID_ARGUMENT' }, { status: B5.status, reason: B5.reason })
check('B6', '④ 非 JSON 请求体 ⇒ 400', { status: 400, reason: 'INVALID_ARGUMENT' }, { status: B6.status, reason: B6.reason })
check('B7', '④ image 多一个键（storage_key ＋ mime）⇒ 400', { status: 400, reason: 'INVALID_ARGUMENT' }, { status: B7.status, reason: B7.reason })
check('B8', '④ image 用 data: 直塞 ⇒ 400（不接受 base64 直塞）', { status: 400, reason: 'INVALID_ARGUMENT' }, { status: B8.status, reason: B8.reason })
check('B9', '④ generations 带 image ⇒ 400（image 只适用 images/edits）', { status: 400, reason: 'INVALID_ARGUMENT' }, { status: B9.status, reason: B9.reason })
check('B10', '④ 整段 B（9 发）⇒ **零写入、零流水行**（判定全在任何写入之前）', { writes: 0, flow: 0 }, { writes: writeSnapshot() - writesBeforeB, flow: flowSnapshot() - flowBeforeB })

/* ===========================================================================
   C 段：限额与余额（零扣费）
   =========================================================================== */
section('C', '限额与余额：日限满 / 分钟限满 / 余额不足 ⇒ 拒且零扣费')

const writesBeforeC = writeSnapshot()
const flowBeforeC = flowSnapshot()
const C1 = await call({ key: issued.day.key, requestId: 'rid-C01-0001' })
check('C1', '⑤ 日限满 ⇒ 429 LIMIT_DAY ＋ Retry-After 秒数 ＋ **流水行数不变**', { status: 429, reason: 'LIMIT_DAY', retryAfterOk: true, writes: 0, flow: 0, keys: 'message,ok,reason' }, { status: C1.status, reason: C1.reason, retryAfterOk: /^\d+$/.test(C1.headers['retry-after'] || '') && Number(C1.headers['retry-after']) >= 1, writes: writeSnapshot() - writesBeforeC, flow: flowSnapshot() - flowBeforeC, keys: shapeOf(C1.body) })

const C2 = await call({ key: issued.min.key, requestId: 'rid-C02-0001' })
check('C2', '⑥ 分钟限满 ⇒ 429 LIMIT_MINUTE ＋ Retry-After ＋ **零写入**', { status: 429, reason: 'LIMIT_MINUTE', retryAfterOk: true, writes: 0 }, { status: C2.status, reason: C2.reason, retryAfterOk: /^\d+$/.test(C2.headers['retry-after'] || '') && Number(C2.headers['retry-after']) >= 1, writes: writeSnapshot() - writesBeforeC })

const C3 = await call({ key: issued.poor.key, requestId: 'rid-C03-0001' })
check('C3', '⑦ 余额不足（5 金 < 10 金）⇒ 402 INSUFFICIENT_POINTS ＋ **零写入**（余额仍 5）', { status: 402, reason: 'INSUFFICIENT_POINTS', writes: 0, balance: 5 }, { status: C3.status, reason: C3.reason, writes: writeSnapshot() - writesBeforeC, balance: balanceOf('u-poor') })

/* ===========================================================================
   D 段：上游失败与退款（退款流水 ＋ 余额复原）
   =========================================================================== */
section('D', '上游失败与退款：5xx / 超时 / 缺配置 / 200 缺图片 ⇒ 502·503 ＋ 退款')

const EDITS_BODY = { prompt: '刻一枚朱文閒章', image: GOOD_IMAGE }

/* D1：上游 500。 */
upstreamMode = '500'
const writesBeforeD1 = writeSnapshot()
const D1 = await call({ routePath: EDITS, body: EDITS_BODY, requestId: 'rid-D01-0001' })
const d1Charge = flowRows().filter((r) => r.kind === 'CHARGE' && String(r.ref_id).includes('rid-D01-0001'))
const d1Refund = flowRows().filter((r) => r.kind === 'REFUND' && String(r.ref_id).includes('rid-D01-0001'))
check('D1', '⑧ 上游 5xx ⇒ 502 UPSTREAM_ERROR（带上游状态码 500）＋ **退款流水存在**（同 ref_id、delta=+10、kind=REFUND）＋ **余额复原 50**', { status: 502, reason: 'UPSTREAM_ERROR', upstreamStatus: 500, chargeRows: 1, refundRows: 1, refundDelta: 10, refundRefIdMatches: true, balance: 50, keys: 'message,ok,reason,status' }, { status: D1.status, reason: D1.reason, upstreamStatus: D1.body && D1.body.status, chargeRows: d1Charge.length, refundRows: d1Refund.length, refundDelta: d1Refund[0] ? d1Refund[0].delta : null, refundRefIdMatches: Boolean(d1Charge[0] && d1Refund[0] && d1Refund[0].ref_id === d1Charge[0].ref_id && d1Refund[0].ref_type === 'AI_IMAGE'), balance: balanceOf('u-ok'), keys: shapeOf(D1.body) })

/* D2：上游超时（永不回 ⇒ `timeout_ms` 2000ms 触发中止）。 */
upstreamMode = 'hang'
const D2 = await call({ routePath: EDITS, body: EDITS_BODY, requestId: 'rid-D02-0001' })
upstreamMode = 'url'
for (const res of hangingResponses.splice(0)) {
  try {
    res.destroy()
  } catch {
    /* 已断开 */
  }
}
const d2Refund = flowRows().filter((r) => r.kind === 'REFUND' && String(r.ref_id).includes('rid-D02-0001'))
check('D2', '⑨ 上游超时 ⇒ 502 UPSTREAM_ERROR（status=0）＋ **退款流水存在** ＋ 余额复原 50', { status: 502, reason: 'UPSTREAM_ERROR', upstreamStatus: 0, refundRows: 1, refundDelta: 10, balance: 50 }, { status: D2.status, reason: D2.reason, upstreamStatus: D2.body && D2.body.status, refundRows: d2Refund.length, refundDelta: d2Refund[0] ? d2Refund[0].delta : null, balance: balanceOf('u-ok') })

/* D3：上游配置缺失（env 空 ⇒ 真 `resolveUpstreamSecret` fail-closed）。 */
const writesBeforeD3 = writeSnapshot()
const flowBeforeD3 = flowSnapshot()
const D3 = await call({ requestId: 'rid-D03-0001', handler: configMissingHandler })
check('D3', '缺上游主密钥（env 空）⇒ 503 CONFIG_MISSING ＋ **零扣费**（写计数与流水行数均不变）', { status: 503, reason: 'CONFIG_MISSING', writes: 0, flow: 0, balance: 50 }, { status: D3.status, reason: D3.reason, writes: writeSnapshot() - writesBeforeD3, flow: flowSnapshot() - flowBeforeD3, balance: balanceOf('u-ok') })

/* D4：上游 200 但缺图片字段。 */
upstreamMode = 'no-image'
const D4 = await call({ routePath: EDITS, body: EDITS_BODY, requestId: 'rid-D04-0001' })
upstreamMode = 'url'
const d4Refund = flowRows().filter((r) => r.kind === 'REFUND' && String(r.ref_id).includes('rid-D04-0001'))
check('D4', '上游 200 却缺图片字段 ⇒ 502（status=200，不伪装成功）＋ 退款 ＋ 余额复原 50', { status: 502, reason: 'UPSTREAM_ERROR', upstreamStatus: 200, refundRows: 1, balance: 50 }, { status: D4.status, reason: D4.reason, upstreamStatus: D4.body && D4.body.status, refundRows: d4Refund.length, balance: balanceOf('u-ok') })

/* ===========================================================================
   E 段：成功 / 幂等 / 回包形状 / 零泄露 / 图片不 base64 直塞
   =========================================================================== */
section('E', '成功回包恰 5 键 / 扣 10 金 / usage 各 +1 / 幂等只扣一次 / 零 key 字面 / 签名链')

/* E1：url 形成功。 */
const E1 = await call({ body: { prompt: '刻一枚白文閒章' }, requestId: 'rid-E01-0001' })
check('E1', '⑩ 成功 ⇒ 200 ＋ 回包**恰 5 键** ＋ charge.points=10 ＋ 余额 50→40 ＋ usage 日 / 分钟各 +1 ＋ 图 url 逐字透传', { status: 200, keys: 'charge,idempotent,image,ok,usage', points: 10, balanceAfter: 40, todayUsed: 1, minuteUsed: 1, url: IMG_URL, idempotent: false, ok: true }, { status: E1.status, keys: shapeOf(E1.body), points: E1.body && E1.body.charge && E1.body.charge.points, balanceAfter: E1.body && E1.body.charge && E1.body.charge.balance_after, todayUsed: E1.body && E1.body.usage && E1.body.usage.today && E1.body.usage.today.used, minuteUsed: E1.body && E1.body.usage && E1.body.usage.minute && E1.body.usage.minute.used, url: E1.body && E1.body.image && E1.body.image.url, idempotent: E1.body && E1.body.idempotent, ok: E1.body && E1.body.ok })

/* E2：b64 形成功（**不重编码**）。 */
upstreamMode = 'b64'
const E2 = await call({ body: { prompt: '刻一枚朱文閒章' }, requestId: 'rid-E02-0001' })
upstreamMode = 'url'
check('E2', '上游回 b64 ⇒ 回包 `image.b64` **逐字等于**上游值（不自己再编码一次）＋ 恰 5 键 ＋ 余额 40→30 ＋ usage 日 +1', { status: 200, keys: 'charge,idempotent,image,ok,usage', b64: UPSTREAM_B64, b64CountInRaw: 1, balanceAfter: 30, todayUsed: 2, mime: 'image/png' }, { status: E2.status, keys: shapeOf(E2.body), b64: E2.body && E2.body.image && E2.body.image.b64, b64CountInRaw: countIn(E2.raw, UPSTREAM_B64), balanceAfter: E2.body && E2.body.charge && E2.body.charge.balance_after, todayUsed: E2.body && E2.body.usage && E2.body.usage.today && E2.body.usage.today.used, mime: E2.body && E2.body.image && E2.body.image.mime })

/* E3：同 X-Request-Id 重放。 */
const E3_RID = 'rid-E03-0001'
const flowBeforeE3 = flowSnapshot()
const hitsBeforeE3 = upstreamHits.length
const E3a = await call({ body: { prompt: '刻一枚長方印' }, requestId: E3_RID })
const flowAfterFirst = flowSnapshot()
const hitsAfterFirst = upstreamHits.length
const E3b = await call({ body: { prompt: '刻一枚長方印' }, requestId: E3_RID })
const e3Charge = flowRows().filter((r) => r.kind === 'CHARGE' && String(r.ref_id).includes(E3_RID))
check('E3', '⑪ 同 X-Request-Id 重放 ⇒ **余额只扣一次**（流水行数不增、CHARGE 恰 1 行）＋ idempotent:true ＋ **上游被重新调用** ＋ idem_key=sha256(key_id:rid)', { firstStatus: 200, firstBalance: 20, replayStatus: 200, replayBalance: 20, replayIdempotent: true, flowDeltaFirst: 1, flowDeltaReplay: 0, chargeRows: 1, upstreamCalls: [1, 1], idemKeyOk: true, todayUsed: 4 }, { firstStatus: E3a.status, firstBalance: E3a.body && E3a.body.charge && E3a.body.charge.balance_after, replayStatus: E3b.status, replayBalance: E3b.body && E3b.body.charge && E3b.body.charge.balance_after, replayIdempotent: E3b.body && E3b.body.idempotent, flowDeltaFirst: flowAfterFirst - flowBeforeE3, flowDeltaReplay: flowSnapshot() - flowAfterFirst, chargeRows: e3Charge.length, upstreamCalls: [hitsAfterFirst - hitsBeforeE3, upstreamHits.length - hitsAfterFirst], idemKeyOk: Boolean(e3Charge[0] && e3Charge[0].idem_key === sha256(`${issued.ok.key_id}:${E3_RID}`)), todayUsed: E3b.body && E3b.body.usage && E3b.body.usage.today && E3b.body.usage.today.used })

/* E4：回包 ＋ 响应头 ＋ 日志零上游 key 字面（成功与失败各一发）。 */
const e3RawAll = E3b.raw + JSON.stringify(E3b.headers)
const d1RawAll = D1.raw + JSON.stringify(D1.headers)
const logText = logs.join('\n')
check('E4', '⑫ 回包与响应头**零上游 key 字面**（成功 / 502 两发逐字搜索 count=0）＋ 日志零上游 key、零客户端金鑰', { upstreamInSuccess: 0, upstreamIn502: 0, upstreamInLogs: 0, clientKeyInLogs: 0 }, { upstreamInSuccess: countIn(e3RawAll, UPSTREAM_KEY), upstreamIn502: countIn(d1RawAll, UPSTREAM_KEY), upstreamInLogs: countIn(logText, UPSTREAM_KEY), clientKeyInLogs: countIn(logText, issued.ok.key) })

/* E5：400 / 401 / 429 错误回包键集恰 3。 */
check('E5', '⑬ 400 / 401 / 429 三类错误回包键集**恰 3 键**（ok / reason / message）', { e400: 'message,ok,reason', e401: 'message,ok,reason', e429: 'message,ok,reason' }, { e400: shapeOf(B3.body), e401: shapeOf(A5.body), e429: shapeOf(C1.body) })

/* E6 / E7：上游请求体的 image 是签名链；上游 URL / 方法 / 凭据形态。 */
upstreamMode = 'url'
const E6 = await call({ routePath: EDITS, body: EDITS_BODY, requestId: 'rid-E06-0001' })
const lastHit = upstreamHits[upstreamHits.length - 1]
const expectedSigned = `${SIGNED_BASE}/${encodeURIComponent(GOOD_IMAGE.storage_key)}?sig=offline`
check('E6', '⑭ 发往上游的请求体 `image` 是**签名链**（非 data: 前缀、逐字等于注入的换链结果）＋ 请求体零 base64 图片字节', { status: 200, imageIsSigned: true, imageIsData: false, imageExact: true, hasBase64Bytes: false, imageKeyCount: 1 }, { status: E6.status, imageIsSigned: String(lastHit.body.image).startsWith('https://'), imageIsData: String(lastHit.body.image).slice(0, 5) === 'data:', imageExact: lastHit.body.image === expectedSigned, hasBase64Bytes: /"image"\s*:\s*"[A-Za-z0-9+/=]{100,}"/.test(lastHit.raw), imageKeyCount: Object.keys(lastHit.body).filter((k) => k === 'image').length })

check('E7', '上游请求形态：URL ＝ base_url ＋ `/images/edits`、方法 POST、凭据只进上游头、body 带 model / n=1', { url: `${BASE_URL}/images/edits`, method: 'POST', authCount: 1, model: 'model-under-test', n: 1, promptOk: true }, { url: `https://127.0.0.1:${upstreamPort}${lastHit.url}`, method: lastHit.method, authCount: countIn(lastHit.auth, UPSTREAM_KEY), model: lastHit.body.model, n: lastHit.body.n, promptOk: lastHit.body.prompt === EDITS_BODY.prompt })

/* E8：八个错误面（九个 reason 字面）与冻结表逐条对照，且**没有第九个**。 */
const sortedMap = (value) =>
  Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = value[key]
      return acc
    }, {})
check('E8', '8 个错误面（400/401/402/404/405/429×2/502/503）实测与冻结表逐条相等、零额外 reason', sortedMap(core.ERROR_SURFACE), sortedMap(observed))

/* E9：核心源码的图片面静态门（零 data:image 字面、零字节下载面、有 getTempFileURL 换链面）。 */
const coreSource = readFileSync(path.join(ROOT, 'api/_lib/aiRelay.js'), 'utf8')
check('E9', '核心源码：零 `data:image` 直塞字面、零图片字节下载面、`getTempFileURL` 换链面在场', { dataImage: 0, byteDownloads: 0, tempFileUrl: true }, { dataImage: countIn(coreSource, 'data:image'), byteDownloads: countIn(coreSource, 'downloadFile') + countIn(coreSource, 'createReadStream'), tempFileUrl: countIn(coreSource, 'getTempFileURL') >= 1 })

/* E10：日志只给布尔与状态码（零 prompt、零图片链接）。 */
check('E10', '日志零 prompt、零签名链、零 uid 之外的凭据形态（只给布尔与状态码）', { prompt: 0, signedLink: 0, hasTag: true }, { prompt: countIn(logText, '刻一枚'), signedLink: countIn(logText, SIGNED_BASE), hasTag: countIn(logText, 'xiai-ai-relay') >= 1 })

/* ===========================================================================
   F 段：交付面静态门
   =========================================================================== */
section('F', '交付面：依赖落 dependencies / vercel.json functions / 路由导出 / 28 脚本')

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
check('F1', '`@cloudbase/node-sdk` 已从 devDependencies 移入 dependencies（版本沿用 ^3.18.3）', { inDeps: '^3.18.3', notInDev: true }, { inDeps: (pkg.dependencies || {})['@cloudbase/node-sdk'], notInDev: !((pkg.devDependencies || {})['@cloudbase/node-sdk']) })

const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'))
check('F2', '`vercel.json` 新增 `functions` 段（maxDuration 60）且既有 framework / installCommand / buildCommand / outputDirectory / rewrites 一字未动', { maxDuration: 60, installCommand: 'npm install', buildCommand: 'npm run build -- --outDir dist/xiai', outputDirectory: 'dist', rewriteCount: 3, framework: 'vite' }, { maxDuration: vercel.functions && vercel.functions['api/ai/v1/*.js'] && vercel.functions['api/ai/v1/*.js'].maxDuration, installCommand: vercel.installCommand, buildCommand: vercel.buildCommand, outputDirectory: vercel.outputDirectory, rewriteCount: Array.isArray(vercel.rewrites) ? vercel.rewrites.length : -1, framework: vercel.framework })

check('F3', '路由默认导出是真 handler 函数（`createHandler` 工厂在场）', { defaultType: 'function', factory: 'function' }, { defaultType: typeof routeModule.default, factory: typeof routeModule.createHandler })

const verifyScripts = readdirSync(path.join(ROOT, 'scripts')).filter((name) => /^verify-.*\.mjs$/.test(name))
check('F4', '本套为第 28 个 `scripts/verify-*.mjs`（基线 26 ＋ 本套 ai-relay ＋ ai-connect-page）', { count: 28, includesSelf: true }, { count: verifyScripts.length, includesSelf: verifyScripts.indexOf('verify-ai-relay.mjs') !== -1 })
check('F4b', '新增套 `verify-ai-connect-page.mjs` 亦在册（脚本计数随之 +1，不漏登）', true, verifyScripts.indexOf('verify-ai-connect-page.mjs') !== -1)

check('F5', '核心只经四个 lib 的既有注入缝取集合（零取句柄字面）与零上游凭据字面', { seamCalls: 4, keyLiteral: 0 }, { seamCalls: ['setLedgerStoreProvider', 'setAiKeyStoreProvider', 'setUpstreamStoreProvider', 'setAiUsageStoreProvider'].filter((name) => countIn(coreSource, name) >= 1).length, keyLiteral: countIn(coreSource, UPSTREAM_KEY) })

/* --------------------------------------------------------------------------- 收尾
   --------------------------------------------------------------------------- */
console.log(
  JSON.stringify({
    summary: { total, passed, failed: total - passed },
    sections: sectionStats,
    failed_ids: failedIds,
    note: '离线自检：真路由 handler ＋ 真 http.createServer ＋ 假上游；不连云端、不碰真上游、不写生产数据；明文金鑰 / 上游 key 一律不打印（只打印长度与指纹）。'
  })
)

try {
  if (typeof sutServer.closeAllConnections === 'function') sutServer.closeAllConnections()
  if (typeof upstreamServer.closeAllConnections === 'function') upstreamServer.closeAllConnections()
  sutServer.close()
  upstreamServer.close()
} catch {
  /* 端口回收失败不影响断言结果 */
}
process.exit(failedIds.length === 0 ? 0 : 1)