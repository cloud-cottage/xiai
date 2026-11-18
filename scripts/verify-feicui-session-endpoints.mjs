/**
 * 玺爱 · **自检：斐萃换签端点（`session/refresh` ＋ `session/device-token`）**
 * ============================================================================
 * 被测件（本单新增，别处不改）：
 *   · `api/_lib/feicuiSession.js`（＋ `cloudfunctions/xiai-web-api/api/_lib/` 的**逐字节副本**）
 *     —— 两个换签端点的全部判定；
 *   · `api/feicui/v1/[...path].js`（＋ 同形副本）—— **路由分流**（`POST /session/*` 在方法门之前）；
 *   · `src/views/ConnectFeicuiView.vue` —— 交付桥 `meta` 带 `refresh_token`（可选 `phone`），
 *     且**不落持久层 / 不上屏 / 手动复制路径不带它**。
 *
 * **完全离线**：无网络（假平台传输层，逐请求记账）、无真库（假 DB 只做「有没有被碰」的探针）、
 * 无浏览器、零部署、不写仓内任何文件。**不打印任何令牌原文**（只给长度 / 指纹 / 布尔）。
 *
 * 覆盖面（A〜E）：
 *   A 路由：网关前缀归一（`/api/xiai/feicui/v1/...` ⇒ `apiPathOf` ⇒ `routeOf` 命中本文件）／
 *     POST 两路能穿到端点／GET ⇒ 405 `Allow: POST`／未登记子路由 ⇒ 旧 GET-only 门／
 *     既有读面行为逐字不变（503 缺 key、401 缺令牌）／默认实例缺环境 Id ⇒ 503 且零联网。
 *   B refresh：成功（键集恰 4、phone 只取验签值、零 refresh_token）／失效（invalid_grant、
 *     200+INVALID_ACCESS_TOKEN）／上游故障四形态（网络 0、502、HTML、200 无令牌）／
 *     **裸 403 不谎报成凭据无效**／缺环境 Id／非法入参四形态（400 ＋ 零上游）。
 *   C device-token：成功（键集恰 3、claims 键序、TTL 28800、uid 口径）／签名与 `ops.js`
 *     **逐字节同源**／无会话 401／非管理员 403／`refresh_token` 入参两跳顺序／
 *     二选一违规 400 零上游／缺密钥与缺白名单 503。
 *   D 零副作用与等价性：假 DB 零接触 ＋ 源码零集合句柄/零 SDK/零 `console.`／审计行键集恰四键
 *     且零令牌零手机号／`readAuthRegion`・`readEnvId`・`uidOf`・claims 与仓内权威实现逐值对拍／
 *     两份副本逐字节相同。
 *   E 视图：桥 meta 带 `refresh_token` ＋ `phone`／不上屏不落存储／手动复制路径不带它。
 *
 * 用法：node scripts/verify-feicui-session-endpoints.mjs
 */

import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const require = createRequire(import.meta.url)

const sessionLib = await import(path.join(ROOT, 'api/_lib/feicuiSession.js'))
const routeModule = await import(path.join(ROOT, 'api/feicui/v1/[...path].js'))
const webApi = require(path.join(ROOT, 'cloudfunctions/xiai-web-api/index.js'))
const configLib = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/config.js'))
const opsLib = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))

/* ---------------------------------------------------------------------------
   0. 断言 / 读数（与仓内既有套件同形：逐条 JSON 行 ＋ 末行 summary）
   ------------------------------------------------------------------------- */

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
  const sec = id.charAt(0)
  if (!sectionStats[sec]) sectionStats[sec] = { total: 0, passed: 0 }
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (pass) {
    passed += 1
    sectionStats[sec].passed += 1
  } else {
    failedIds.push(id)
  }
  sectionStats[sec].total += 1
  console.log(JSON.stringify({ id, case: title, pass, expected, actual }))
}

function fingerprint(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12)
}

function sorted(object) {
  return Object.keys(object || {}).sort()
}

const PHONE = '139' + '00000001'
const OTHER_PHONE = '139' + '00000002'
const ADMIN_PHONE = '138' + '00000000'
const REFRESH = 'rt-' + 'a'.repeat(40)
const ACCESS = 'at-' + 'b'.repeat(40)
const NEW_ACCESS = 'at-' + 'c'.repeat(40)
const SECRET = 'shadow-secret-' + 'f'.repeat(20)
const NOW_MS = Date.parse('2026-11-17T04:00:00.000Z')

/* ---------------------------------------------------------------------------
   1. 假件：平台传输（逐请求记账）／res／req
   ------------------------------------------------------------------------- */

function fakePlatform(script) {
  const calls = []
  const queue = (script || []).slice()
  const impl = async (spec) => {
    calls.push({ method: spec.method, hostname: spec.hostname, path: spec.path, body: spec.body, headers: spec.headers })
    const next = queue.length > 0 ? queue.shift() : { status: 500, text: '' }
    if (typeof next === 'function') return next(spec)
    return next
  }
  impl.calls = calls
  return impl
}

function makeRes() {
  const state = { statusCode: 200, headers: {}, body: '' }
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
    end(chunk) {
      state.body = chunk === undefined || chunk === null ? '' : String(chunk)
    }
  }
  return { state, res }
}

function makeReq(method, url, body) {
  return { method, url, headers: {}, body }
}

const BASE_ENV = {
  TCB_ENV: 'liwu-test-env',
  XIAI_ADMIN_PHONE: ADMIN_PHONE,
  SHADOW_TOKEN_SECRET: SECRET
}

/** 走**真路由文件**（`createForwardHandler`）→ 只替换换签处理器内部的平台传输层。 */
async function callRoute({ method, pathname, body, env, platform }) {
  const sessionHandler = sessionLib.createSessionHandler({
    env: env === undefined ? BASE_ENV : env,
    platform,
    now: () => NOW_MS,
    logger: { log: () => {} }
  })
  const handler = routeModule.createForwardHandler({
    env: env === undefined ? BASE_ENV : env,
    now: () => NOW_MS,
    logger: { log: () => {} },
    sessionHandler
  })
  const { state, res } = makeRes()
  await handler(makeReq(method, pathname, body), res)
  let parsed = null
  try {
    parsed = JSON.parse(state.body)
  } catch {
    parsed = null
  }
  return { status: state.statusCode, headers: state.headers, text: state.body, json: parsed }
}

/** 直调端点（C/D 段用：不经过路由，方便数上游调用）。 */
function callSession({ route, method, body, env, platform, secretOf, adminPhoneOf, logger }) {
  const handler = sessionLib.createSessionHandler({
    env: env === undefined ? BASE_ENV : env,
    platform,
    now: () => NOW_MS,
    secretOf,
    adminPhoneOf,
    logger: logger || { log: () => {} }
  })
  const { state, res } = makeRes()
  return handler(makeReq(method === undefined ? 'POST' : method, '/api/feicui/v1/session/' + route, body), res, route).then(() => {
    let parsed = null
    try {
      parsed = JSON.parse(state.body)
    } catch {
      parsed = null
    }
    return { status: state.statusCode, headers: state.headers, text: state.body, json: parsed }
  })
}

function decodeDeviceToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 2) return null
  try {
    const json = Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return { parts, payload: JSON.parse(json), sig: parts[1] }
  } catch {
    return null
  }
}

/* ===========================================================================
   A 段：路由（真 handler ＋ 假平台）
   =========================================================================== */
section('A', '路由：网关前缀归一 ⇒ 本文件 ／ POST 两路可达 ／ 方法不对 405 ／ 读面行为不变')

{
  /* A1｜网关（`/api/xiai` 触发）到本文件的映射：证明线上那条 URL 真的落到被测 handler。 */
  const apiPath = webApi.apiPathOf('/feicui/v1/session/refresh')
  const apiPathFull = webApi.apiPathOf('/api/xiai/feicui/v1/session/refresh')
  const relative = webApi.routeOf(apiPath)
  const relativeDevice = webApi.routeOf(webApi.apiPathOf('/feicui/v1/session/device-token'))
  check(
    'A1',
    '网关路径归一：`/api/xiai/feicui/v1/session/refresh` 与已剥前缀的 `/feicui/v1/session/refresh` 都归一到 `…/api/feicui/v1/session/refresh`，且 `routeOf` 命中的就是本单改的那个文件',
    {
      fromStripped: '/api/feicui/v1/session/refresh',
      fromFull: '/api/feicui/v1/session/refresh',
      route: './api/feicui/v1/[...path].js',
      routeDevice: './api/feicui/v1/[...path].js'
    },
    { fromStripped: apiPath, fromFull: apiPathFull, route: relative, routeDevice: relativeDevice }
  )

  /* A2｜POST refresh 能穿到端点（且**不需要** Feicui 令牌，也不需要上游 key）。 */
  const platform = fakePlatform([
    { status: 200, text: JSON.stringify({ access_token: NEW_ACCESS, expires_in: 3600 }) },
    { status: 200, text: JSON.stringify({ phone_number: '+86 ' + PHONE }) }
  ])
  const viaBuffer = await callRoute({
    method: 'POST',
    pathname: '/api/feicui/v1/session/refresh',
    /* 云函数宿主给的是 Buffer（事件体），这里直接用 Buffer 形态 ⇒ 两个宿主都覆盖。 */
    body: Buffer.from(JSON.stringify({ refresh_token: REFRESH }), 'utf8'),
    env: { ...BASE_ENV },
    platform
  })
  check(
    'A2',
    '`POST /api/feicui/v1/session/refresh`（Buffer 体，云函数宿主形态）⇒ 200 且 `ok:true`；**无 Feicui 令牌、无 YINYUAN_API_KEY 也照样到达**（换签与读面转发彻底分离）',
    { status: 200, ok: true, upstream: 2 },
    { status: viaBuffer.status, ok: viaBuffer.json && viaBuffer.json.ok, upstream: platform.calls.length }
  )

  /* A3｜POST device-token 能穿到端点。 */
  const platform3 = fakePlatform([{ status: 200, text: JSON.stringify({ phone_number: ADMIN_PHONE }) }])
  const viaDevice = await callRoute({
    method: 'POST',
    pathname: '/api/feicui/v1/session/device-token',
    body: JSON.stringify({ access_token: ACCESS, phone: ADMIN_PHONE }),
    platform: platform3
  })
  check(
    'A3',
    '`POST /api/feicui/v1/session/device-token` ⇒ 200 且回包恰 `{ok, token, expires_at}`（键集排序后逐字）',
    { status: 200, keys: ['expires_at', 'ok', 'token'] },
    { status: viaDevice.status, keys: sorted(viaDevice.json) }
  )

  /* A4｜方法不对 ⇒ 405 ＋ `Allow: POST`（**不是**继续去验 Feicui 令牌）。 */
  const platform4 = fakePlatform([])
  const wrongMethod = await callRoute({
    method: 'GET',
    pathname: '/api/feicui/v1/session/refresh',
    platform: platform4
  })
  check(
    'A4',
    '`GET /session/refresh` ⇒ 405 `METHOD_NOT_ALLOWED` ＋ `Allow: POST`，且**零上游调用**',
    { status: 405, reason: 'METHOD_NOT_ALLOWED', allow: 'POST', upstream: 0 },
    {
      status: wrongMethod.status,
      reason: wrongMethod.json && wrongMethod.json.reason,
      allow: wrongMethod.headers.allow,
      upstream: platform4.calls.length
    }
  )

  /* A5｜未登记子路由 ⇒ 落回旧 GET-only 门（405 METHOD_NOT_ALLOWED），不新增第三路。 */
  const unknownSub = await callRoute({
    method: 'POST',
    pathname: '/api/feicui/v1/session/whatever',
    platform: fakePlatform([])
  })
  check(
    'A5',
    '`POST /session/whatever`（未登记子路由）⇒ 仍是旧门的 405 `METHOD_NOT_ALLOWED`（`Allow: GET`），**不新增任何路由面**',
    { status: 405, reason: 'METHOD_NOT_ALLOWED', allow: 'GET' },
    { status: unknownSub.status, reason: unknownSub.json && unknownSub.json.reason, allow: unknownSub.headers.allow }
  )

  /* A6/A7｜既有读面行为**逐字不变**（回归：缺 key ⇒ 503；有 key 无令牌 ⇒ 401）。 */
  const noKey = await callRoute({ method: 'GET', pathname: '/api/feicui/v1/dynasties', env: {}, platform: fakePlatform([]) })
  const noToken = await callRoute({
    method: 'GET',
    pathname: '/api/feicui/v1/dynasties',
    env: { YINYUAN_API_KEY: 'fake-upstream-key' },
    platform: fakePlatform([])
  })
  check(
    'A6',
    '回归：`GET /dynasties` 行为不变 —— 缺 `YINYUAN_API_KEY` ⇒ 503 `CONFIG_MISSING`；有 key 无令牌 ⇒ 401 `TOKEN_INVALID`',
    { missingKey: { status: 503, reason: 'CONFIG_MISSING' }, noToken: { status: 401, reason: 'TOKEN_INVALID' } },
    {
      missingKey: { status: noKey.status, reason: noKey.json && noKey.json.reason },
      noToken: { status: noToken.status, reason: noToken.json && noToken.json.reason }
    }
  )

  /* A8｜默认实例（生产装配，不注入 handler）：缺环境 Id ⇒ 503 且**不发网络**（hostname 为空即早退）。 */
  const prodHandler = routeModule.createForwardHandler({ env: {}, now: () => NOW_MS, logger: { log: () => {} } })
  const prodRes = makeRes()
  await prodHandler(makeReq('POST', '/api/feicui/v1/session/refresh', JSON.stringify({ refresh_token: REFRESH })), prodRes.res)
  const prodJson = JSON.parse(prodRes.state.body)
  check(
    'A8',
    '默认装配（不注入）：缺环境 Id ⇒ 503 `CONFIG_MISSING`（**内部配置故障，不谎报凭据无效**；且此分支早于任何平台调用 ⇒ 零联网）',
    { status: 503, reason: 'CONFIG_MISSING' },
    { status: prodRes.state.statusCode, reason: prodJson.reason }
  )
}

/* ===========================================================================
   B 段：refresh —— 成功 / 失效 / 上游故障三路（＋零谎报 ＋ 非法入参）
   =========================================================================== */
section('B', 'refresh：refresh_token → 新会话（键集恰 4 ／ 失效 401 ／ 故障 502 ／ 非法入参 400 零上游）')

{
  const okPlatform = fakePlatform([
    { status: 200, text: JSON.stringify({ access_token: NEW_ACCESS, refresh_token: 'rotated-' + 'z'.repeat(20), expires_in: 3600 }) },
    { status: 200, text: JSON.stringify({ phone_number: '+86 ' + PHONE, sub: 'abc' }) }
  ])
  const ok = await callSession({
    route: 'refresh',
    /* 客户端自报另一个号 ⇒ 回包**必须是平台验签后的号**，不是自报值。 */
    body: JSON.stringify({ refresh_token: REFRESH, phone: OTHER_PHONE }),
    platform: okPlatform
  })
  check(
    'B1',
    '成功 ⇒ 200，回包键集**恰四键** `{ok, access_token, phone, expires_at}`；`phone` 取平台验签值（**不回显**请求里自报的号）；`expires_at` 由 `expires_in` 换算',
    {
      status: 200,
      keys: ['access_token', 'expires_at', 'ok', 'phone'],
      phone: PHONE,
      expiresAt: new Date(NOW_MS + 3600 * 1000).toISOString()
    },
    {
      status: ok.status,
      keys: sorted(ok.json),
      phone: ok.json.phone,
      expiresAt: ok.json.expires_at
    }
  )

  /* 上游请求形状：POST /auth/v1/token，body 逐字 refresh grant（region 来自 env，不写死）。 */
  const first = okPlatform.calls[0] || {}
  const sentBody = (() => {
    try {
      return JSON.parse(first.body || '{}')
    } catch {
      return {}
    }
  })()
  check(
    'B2',
    '平台请求形状逐字：`POST https://<envId>.<region>.tcb-api.tencentcloudapi.com/auth/v1/token`，body `{client_id, client_secret:\'\', grant_type:\'refresh_token\', refresh_token}`（区域取自 `XIAI_AUTH_REGION`→`TCB_REGION`，不写死）',
    {
      method: 'POST',
      hostname: 'liwu-test-env.ap-shanghai.tcb-api.tencentcloudapi.com',
      path: '/auth/v1/token',
      grant: 'refresh_token',
      clientId: 'liwu-test-env'
    },
    {
      method: first.method,
      hostname: first.hostname,
      path: first.path,
      grant: sentBody.grant_type,
      clientId: sentBody.client_id
    }
  )

  /* 回包**零 refresh_token / 零轮换凭据**（即使平台回了新的 refresh_token）。 */
  check(
    'B3',
    '回包零凭据外溢：无 `refresh_token` 键、序列化正文不含刷新令牌原文（平台回的轮换值也不透传）、不含任何 `secret`/`key` 字面',
    { refreshKey: false, rotatedLeak: false, secretLeak: false },
    {
      refreshKey: Object.prototype.hasOwnProperty.call(ok.json, 'refresh_token'),
      rotatedLeak: ok.text.indexOf('rotated-') !== -1,
      secretLeak: /secret|client_secret/i.test(ok.text)
    }
  )

  const invalidGrant = await callSession({
    route: 'refresh',
    body: JSON.stringify({ refresh_token: REFRESH }),
    platform: fakePlatform([{ status: 400, text: JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }) }])
  })
  const invalidTokenCode = await callSession({
    route: 'refresh',
    body: JSON.stringify({ refresh_token: REFRESH }),
    platform: fakePlatform([{ status: 200, text: JSON.stringify({ code: 'INVALID_ACCESS_TOKEN', message: 'bad' }) }])
  })
  check(
    'B4',
    '凭据失效两形态 ⇒ **401** `REFRESH_INVALID`：① 400 ＋ `invalid_grant` ② 平台 200 ＋ `INVALID_ACCESS_TOKEN`（云开发把无效凭证回成 200 ＋ code）',
    { first: { status: 401, reason: 'REFRESH_INVALID' }, second: { status: 401, reason: 'REFRESH_INVALID' } },
    {
      first: { status: invalidGrant.status, reason: invalidGrant.json && invalidGrant.json.reason },
      second: { status: invalidTokenCode.status, reason: invalidTokenCode.json && invalidTokenCode.json.reason }
    }
  )

  const upstreamCases = {
    networkDown: await callSession({ route: 'refresh', body: JSON.stringify({ refresh_token: REFRESH }), platform: fakePlatform([{ status: 0, text: '' }]) }),
    server502: await callSession({ route: 'refresh', body: JSON.stringify({ refresh_token: REFRESH }), platform: fakePlatform([{ status: 502, text: '<html>bad gateway</html>' }]) }),
    htmlPage: await callSession({ route: 'refresh', body: JSON.stringify({ refresh_token: REFRESH }), platform: fakePlatform([{ status: 200, text: '<html>login</html>' }]) }),
    emptyToken200: await callSession({ route: 'refresh', body: JSON.stringify({ refresh_token: REFRESH }), platform: fakePlatform([{ status: 200, text: JSON.stringify({ expires_in: 3600 }) }]) })
  }
  check(
    'B5',
    '平台故障四形态（网络 0 / 502 / 200 但回 HTML / 200 但无令牌）⇒ **502 `UPSTREAM_ERROR`**（不得谎报成「凭据无效」）',
    { networkDown: 502, server502: 502, htmlPage: 502, emptyToken200: 502 },
    {
      networkDown: upstreamCases.networkDown.status,
      server502: upstreamCases.server502.status,
      htmlPage: upstreamCases.htmlPage.status,
      emptyToken200: upstreamCases.emptyToken200.status
    }
  )

  const bare403 = await callSession({
    route: 'refresh',
    body: JSON.stringify({ refresh_token: REFRESH }),
    platform: fakePlatform([{ status: 403, text: 'Forbidden' }])
  })
  check(
    'B6',
    '★「不得把故障谎报成凭据无效」的硬判据：裸 403（无 JSON 体的网关/WAF 拦截页）⇒ **502 `UPSTREAM_ERROR`**，**不是** `REFRESH_INVALID`（否则桌面版会把好凭据清掉）',
    { status: 502, reason: 'UPSTREAM_ERROR' },
    { status: bare403.status, reason: bare403.json && bare403.json.reason }
  )

  const badPayloads = [
    {},
    { refresh_token: '' },
    { refresh_token: REFRESH, extra: 1 },
    { refresh_token: 'x'.repeat(sessionLib.MAX_CREDENTIAL_LENGTH + 1) },
    { refresh_token: REFRESH, phone: '12345' }
  ]
  const badPlatform = fakePlatform([])
  const badResults = []
  for (const payload of badPayloads) {
    const reply = await callSession({ route: 'refresh', body: JSON.stringify(payload), platform: badPlatform })
    badResults.push({ status: reply.status, reason: reply.json && reply.json.reason })
  }
  check(
    'B7',
    '非法入参五形态（空体 / 空 refresh_token / 未知键 / 超长 / 手机号形态不成立）⇒ **400 `INVALID_FIELD`**，且**零上游调用**',
    {
      statuses: [400, 400, 400, 400, 400],
      reasons: ['INVALID_FIELD', 'INVALID_FIELD', 'INVALID_FIELD', 'INVALID_FIELD', 'INVALID_FIELD'],
      upstream: 0
    },
    { statuses: badResults.map((r) => r.status), reasons: badResults.map((r) => r.reason), upstream: badPlatform.calls.length }
  )

  /* H 段：非 JSON 体同样 400（不抛、不把解析错漏成 500）。 */
  const notJson = await callSession({ route: 'refresh', body: 'not-json', platform: fakePlatform([]) })
  check(
    'B8',
    '非 JSON 体 ⇒ 400 `INVALID_FIELD`（不抛 500、零上游）',
    { status: 400, reason: 'INVALID_FIELD' },
    { status: notJson.status, reason: notJson.json && notJson.json.reason }
  )
}

/* ===========================================================================
   C 段：device-token —— 成功 / 无会话 / 非管理员（＋两跳 ／ 二选一 ／ 缺配置）
   =========================================================================== */
section('C', 'device-token：会话 → 8 小时设备令牌（claims 逐字 ／ TTL 28800 ／ 401 ／ 403 ／ 503）')

{
  const platform = fakePlatform([{ status: 200, text: JSON.stringify({ phone_number: '+86 ' + ADMIN_PHONE }) }])
  const ok = await callSession({
    route: 'device-token',
    body: JSON.stringify({ access_token: ACCESS, phone: ADMIN_PHONE }),
    platform
  })
  check(
    'C1',
    '成功 ⇒ 200，回包键集**恰三键** `{ok, token, expires_at}`（不回 refresh_token、不回会话令牌、不回任何密钥）',
    { status: 200, keys: ['expires_at', 'ok', 'token'], hasRefresh: false },
    {
      status: ok.status,
      keys: sorted(ok.json),
      hasRefresh: Object.prototype.hasOwnProperty.call(ok.json, 'refresh_token')
    }
  )

  const decoded = decodeDeviceToken(ok.json && ok.json.token)
  const payload = decoded ? decoded.payload : {}
  check(
    'C2',
    '令牌形态与 claims 逐字：恰 2 段 base64url；claims 键序 `v,uid,roles,iat,exp,jti`；`v=1`、`roles=[\'admin\']`、`uid=u-<sha256(号)前16>`、`exp-iat=28800`（8 小时）',
    {
      segments: 2,
      keys: ['v', 'uid', 'roles', 'iat', 'exp', 'jti'],
      v: 1,
      roles: ['admin'],
      uid: configLib.uidOf(ADMIN_PHONE),
      ttl: 28800
    },
    {
      segments: decoded ? decoded.parts.length : 0,
      keys: Object.keys(payload),
      v: payload.v,
      roles: payload.roles,
      uid: payload.uid,
      ttl: Number(payload.exp) - Number(payload.iat)
    }
  )

  /* **与 `issueFeicuiDeviceToken` 逐字节同源**：同一 claims 用 `ops.js` 的签发函数现签 ⇒ 必须逐字相等。 */
  const sameClaims = opsLib.buildFeicuiDeviceTokenClaims({
    uid: configLib.uidOf(ADMIN_PHONE),
    roles: ['admin'],
    nowSeconds: Math.floor(NOW_MS / 1000),
    ttlSeconds: sessionLib.DEVICE_TTL_SECONDS,
    jti: payload.jti
  })
  const expectedToken = opsLib.signFeicuiDeviceToken(sameClaims, SECRET)
  const hmacOfReturned = createHmac('sha256', SECRET)
    .update(String((ok.json.token || '').split('.')[0]))
    .digest('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  check(
    'C3',
    '★ 复用既有签发逻辑：同一 claims 由 `ops.js::signFeicuiDeviceToken` 现签 ⇒ 与端点回包**逐字节相等**；端点自签的 HMAC 段用同一密钥独立验一遍也相等（证明没有第二套算法）',
    { sameAsOps: true, sameClaimsJson: true, hmacMatches: true },
    {
      sameAsOps: String(ok.json.token) === expectedToken,
      sameClaimsJson: JSON.stringify(sessionLib.buildDeviceClaims({ uid: configLib.uidOf(ADMIN_PHONE), roles: ['admin'], nowSeconds: Math.floor(NOW_MS / 1000), ttlSeconds: 28800, jti: payload.jti })) === JSON.stringify(sameClaims),
      hmacMatches: hmacOfReturned === decoded.sig
    }
  )

  const noSession = await callSession({
    route: 'device-token',
    body: JSON.stringify({ access_token: ACCESS }),
    platform: fakePlatform([{ status: 200, text: JSON.stringify({ code: 'INVALID_ACCESS_TOKEN' }) }])
  })
  check(
    'C4',
    '无会话（平台明确判 `INVALID_ACCESS_TOKEN`）⇒ **401 `LOGIN_REQUIRED`**，回包无 `token`（零签发）',
    { status: 401, reason: 'LOGIN_REQUIRED', hasToken: false },
    { status: noSession.status, reason: noSession.json && noSession.json.reason, hasToken: Object.prototype.hasOwnProperty.call(noSession.json || {}, 'token') }
  )

  const notAdmin = await callSession({
    route: 'device-token',
    body: JSON.stringify({ access_token: ACCESS }),
    platform: fakePlatform([{ status: 200, text: JSON.stringify({ phone_number: OTHER_PHONE }) }])
  })
  check(
    'C5',
    '非管理员（平台验签回的是另一个号）⇒ **403 `FORBIDDEN`**，回包无 `token`（白名单是唯一判据，不采信载荷里的 `phone`）',
    { status: 403, reason: 'FORBIDDEN', hasToken: false },
    { status: notAdmin.status, reason: notAdmin.json && notAdmin.json.reason, hasToken: Object.prototype.hasOwnProperty.call(notAdmin.json || {}, 'token') }
  )

  const twoHop = fakePlatform([
    { status: 200, text: JSON.stringify({ access_token: NEW_ACCESS, expires_in: 3600 }) },
    { status: 200, text: JSON.stringify({ phone_number: ADMIN_PHONE }) }
  ])
  const byRefresh = await callSession({ route: 'device-token', body: JSON.stringify({ refresh_token: REFRESH }), platform: twoHop })
  check(
    'C6',
    '`{refresh_token}` 入参 ⇒ 两跳且顺序正确：① `POST /auth/v1/token`（换取会话）② `GET /auth/v1/user/me?client_id=…`（验签取号，只 GET）；两跳后签出一枚令牌',
    { status: 200, hops: 2, paths: ['/auth/v1/token', '/auth/v1/user/me?client_id=liwu-test-env'], ok: true },
    {
      status: byRefresh.status,
      hops: twoHop.calls.length,
      paths: twoHop.calls.map((call) => call.path),
      ok: byRefresh.json && byRefresh.json.ok
    }
  )

  const bothPlatform = fakePlatform([])
  const both = await callSession({ route: 'device-token', body: JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH }), platform: bothPlatform })
  const neither = await callSession({ route: 'device-token', body: JSON.stringify({ phone: ADMIN_PHONE }), platform: bothPlatform })
  check(
    'C7',
    '`access_token` / `refresh_token` **二选一**：两枚都给或都不给 ⇒ 400 `INVALID_FIELD` ＋ 零上游（不替调用方猜用哪一枚）',
    { both: { status: 400, reason: 'INVALID_FIELD' }, neither: { status: 400, reason: 'INVALID_FIELD' }, upstream: 0 },
    {
      both: { status: both.status, reason: both.json && both.json.reason },
      neither: { status: neither.status, reason: neither.json && neither.json.reason },
      upstream: bothPlatform.calls.length
    }
  )

  const noSecret = await callSession({
    route: 'device-token',
    body: JSON.stringify({ access_token: ACCESS }),
    env: { TCB_ENV: 'liwu-test-env', XIAI_ADMIN_PHONE: ADMIN_PHONE },
    platform: fakePlatform([{ status: 200, text: JSON.stringify({ phone_number: ADMIN_PHONE }) }])
  })
  const noAdmin = await callSession({
    route: 'device-token',
    body: JSON.stringify({ access_token: ACCESS }),
    env: { TCB_ENV: 'liwu-test-env', SHADOW_TOKEN_SECRET: SECRET },
    platform: fakePlatform([{ status: 200, text: JSON.stringify({ phone_number: ADMIN_PHONE }) }])
  })
  check(
    'C8',
    '缺配置 ⇒ **503 `CONFIG_MISSING`** 且零签发：① 缺 `SHADOW_TOKEN_SECRET` ② 缺 `XIAI_ADMIN_PHONE`（**不因未配置而放行**）',
    { noSecret: { status: 503, reason: 'CONFIG_MISSING' }, noAdmin: { status: 503, reason: 'CONFIG_MISSING' } },
    {
      noSecret: { status: noSecret.status, reason: noSecret.json && noSecret.json.reason },
      noAdmin: { status: noAdmin.status, reason: noAdmin.json && noAdmin.json.reason }
    }
  )
}

/* ===========================================================================
   D 段：零落库 / 零日志 / 与权威实现等价 / 两份副本同源
   =========================================================================== */
section('D', '零副作用与等价性：零 DB 接触 ／ 审计行四键且零令牌 ／ region·envId·uid·claims 对拍 ／ 副本逐字节相同')

{
  /* D1｜假 DB 零接触（任何属性访问都算「碰了」）。 */
  let touched = 0
  const dbTrap = new Proxy(
    {},
    {
      get() {
        touched += 1
        return () => {
          touched += 1
          return null
        }
      }
    }
  )
  const dbPlatform = fakePlatform([
    { status: 200, text: JSON.stringify({ access_token: NEW_ACCESS, expires_in: 3600 }) },
    { status: 200, text: JSON.stringify({ phone_number: ADMIN_PHONE }) },
    { status: 200, text: JSON.stringify({ phone_number: ADMIN_PHONE }) }
  ])
  const dbHandler = sessionLib.createSessionHandler({ env: BASE_ENV, platform: dbPlatform, now: () => NOW_MS, db: dbTrap, logger: { log: () => {} } })
  for (const [route, body] of [
    ['refresh', JSON.stringify({ refresh_token: REFRESH })],
    ['device-token', JSON.stringify({ access_token: ACCESS })]
  ]) {
    const { res } = makeRes()
    await dbHandler(makeReq('POST', '/api/feicui/v1/session/' + route, body), res, route)
  }
  check('D1', '两个端点都**不碰数据库**：注入的假 DB 在被调用 N 次后，属性访问计数仍为 0（零读零写）', 0, touched)

  /* D2｜源码静态：零集合句柄 / 零 SDK / 零直接 console。 */
  const libSrc = readFileSync(path.join(ROOT, 'api/_lib/feicuiSession.js'), 'utf8')
  const codeSrc = libSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n')
  const forbidden = ['collection(', 'createCollection', 'node-sdk', '@cloudbase', 'console.log', 'console.warn', 'process.env.XIAI_ADMIN_PHONE=']
  const hits = Object.fromEntries(forbidden.map((needle) => [needle, codeSrc.split(needle).length - 1]))
  check(
    'D2',
    '源码静态（去注释后）：零集合句柄（`collection(`）／零建集／零 SDK 引用／零直接 `console.*`（审计只经注入的 logger）',
    { collection: 0, createCollection: 0, sdk: 0, cloudbase: 0, consoleLog: 0, consoleWarn: 0, envHardcode: 0 },
    {
      collection: hits['collection('],
      createCollection: hits.createCollection,
      sdk: hits['node-sdk'],
      cloudbase: hits['@cloudbase'],
      consoleLog: hits['console.log'],
      consoleWarn: hits['console.warn'],
      envHardcode: hits['process.env.XIAI_ADMIN_PHONE=']
    }
  )

  /* D3｜审计行：键集恰四键，且**零令牌 / 零手机号**。 */
  const lines = []
  const auditPlatform = fakePlatform([
    { status: 200, text: JSON.stringify({ access_token: NEW_ACCESS, expires_in: 3600 }) },
    { status: 200, text: JSON.stringify({ phone_number: ADMIN_PHONE }) },
    { status: 200, text: JSON.stringify({ phone_number: ADMIN_PHONE }) }
  ])
  const auditHandler = sessionLib.createSessionHandler({
    env: BASE_ENV,
    platform: auditPlatform,
    now: () => NOW_MS,
    logger: { log: (line) => lines.push(String(line)) }
  })
  for (const [route, body] of [
    ['refresh', JSON.stringify({ refresh_token: REFRESH })],
    ['device-token', JSON.stringify({ access_token: ACCESS })],
    ['device-token', JSON.stringify({ access_token: 'nope' })]
  ]) {
    const { res } = makeRes()
    await auditHandler(makeReq('POST', '/api/feicui/v1/session/' + route, body), res, route)
  }
  const parsedLines = lines.map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  const keySets = parsedLines.map((row) => (row ? Object.keys(row).sort().join(',') : 'unparsable'))
  const allowedKeySets = ['outcome,route,status,tag', 'outcome,status,tag']
  const joined = lines.join('\n')
  check(
    'D3',
    '审计行（三次调用）只含 `{tag, route, outcome, status}` 四键；正文里**零 refresh_token / 零 access_token / 零设备令牌 / 零手机号**',
    { allParsable: true, keysOk: true, tokenLeak: 0, phoneLeak: 0 },
    {
      allParsable: parsedLines.every((row) => row !== null),
      keysOk: keySets.every((keys) => allowedKeySets.indexOf(keys) !== -1),
      tokenLeak: [REFRESH, ACCESS, NEW_ACCESS, ADMIN_PHONE].filter((needle) => joined.indexOf(needle) !== -1).length,
      phoneLeak: (joined.match(/1[3-9]\d{9}/g) || []).length
    }
  )

  /* D4｜区域 / 环境 Id / uid / 手机号归一：与仓内权威实现**逐值对拍**。 */
  const envMatrix = [
    {},
    { XIAI_AUTH_REGION: 'ap-guangzhou' },
    { TCB_REGION: 'ap-beijing' },
    { XIAI_AUTH_REGION: 'BAD/../x', TCB_REGION: 'ap-shenzhen' },
    { XIAI_AUTH_REGION: 'AP-HANGZHOU' }
  ]
  const regionPairs = envMatrix.map((env) => [sessionLib.readAuthRegion(env), configLib.readAuthRegion(env)])
  const envIdPairs = [{}, { TCB_ENV: 'liwu-test-env' }, { SCF_NAMESPACE: 'ns-1' }, { CLOUDBASE_ENV_ID: 'cb-1' }].map((env) => [
    sessionLib.readEnvId(env),
    configLib.readEnvId(env)
  ])
  check(
    'D4',
    '区域与环境 Id **不写死且不另立口径**：`readAuthRegion` / `readEnvId` 对 9 组 env 与 `lib/config.js` 的同名函数逐值相等（含非法区域回落默认值）',
    { region: true, envId: true, regionSample: configLib.readAuthRegion({}) },
    {
      region: regionPairs.every(([mine, theirs]) => mine === theirs),
      envId: envIdPairs.every(([mine, theirs]) => mine === theirs),
      regionSample: sessionLib.readAuthRegion({})
    }
  )

  /* D5｜uid / 手机号归一 与 `lib/config.js` 对拍（含 +86 与空格形态）。 */
  const phoneSamples = [PHONE, '+86 ' + PHONE, '86' + PHONE, '12345', '', ' 139 0000 0001 ']
  const uidPairs = phoneSamples.map((value) => [sessionLib.uidOf(value), configLib.uidOf(value)])
  check(
    'D5',
    '`uidOf` / `normalizePhone` 与 `lib/config.js` 逐值相等（6 个样本，含 `+86` 前缀、空格、非法号）：uid 恒为 `u-` ＋ sha256 前 16 位',
    { same: true, uidShape: /^u-[0-9a-f]{16}$/.test(configLib.uidOf(PHONE)) },
    { same: uidPairs.every(([mine, theirs]) => mine === theirs), uidShape: /^u-[0-9a-f]{16}$/.test(sessionLib.uidOf(PHONE)) }
  )

  /* D6｜claims 构造与 `ops.js` 逐字节相等（固定 jti ⇒ JSON 文本逐字同）。 */
  const claimInput = { uid: configLib.uidOf(ADMIN_PHONE), roles: ['ADMIN'], nowSeconds: 1000, ttlSeconds: 28800, jti: 'jti-fixed-0001' }
  const mineClaims = JSON.stringify(sessionLib.buildDeviceClaims(claimInput))
  const opsClaims = JSON.stringify(opsLib.buildFeicuiDeviceTokenClaims(Object.assign({}, claimInput, { roles: ['admin'] })))
  check(
    'D6',
    'claims 构造与 `ops.js::buildFeicuiDeviceTokenClaims` **逐字节相同**（键序 `v,uid,roles,iat,exp,jti`；`roles` 统一小写；TTL 缺省回落 30 天）',
    { sameJson: true, fallbackTtl: 30 * 24 * 60 * 60 },
    {
      sameJson: mineClaims === opsClaims,
      fallbackTtl: sessionLib.buildDeviceClaims({ uid: 'u-0', nowSeconds: 0 }).exp
    }
  )

  /* D7｜两份副本逐字节相同（根 `api/**` 与 `cloudfunctions/xiai-web-api/api/**`）。 */
  const pairs = [
    ['api/_lib/feicuiSession.js', 'cloudfunctions/xiai-web-api/api/_lib/feicuiSession.js'],
    ['api/feicui/v1/[...path].js', 'cloudfunctions/xiai-web-api/api/feicui/v1/[...path].js']
  ]
  const same = pairs.map(([left, right]) => {
    const a = readFileSync(path.join(ROOT, left))
    const b = readFileSync(path.join(ROOT, right))
    return a.length === b.length && a.equals(b)
  })
  check(
    'D7',
    '云函数侧副本与仓内 `api/**` **逐字节相同**（两件：换签模块 ＋ 路由文件）⇒ 两个宿主跑的是同一份判定，不会各修一半',
    { lib: true, route: true },
    { lib: same[0], route: same[1] }
  )
}

/* ===========================================================================
   E 段：视图契约（静态｜`/connect` 交付 meta 带 refresh_token）
   =========================================================================== */
section('E', '视图：桥 meta 带 refresh_token（可选 phone）／不上屏 ／ 手动复制路径不带它')

{
  const viewPath = path.join(ROOT, 'src/views/ConnectFeicuiView.vue')
  const viewSrc = readFileSync(viewPath, 'utf8')
  /* 判「码面是否写持久层」必须**剔注释**：视图的文档注释里正当地提到了
     「不落 localStorage / cookie」这类字样，直接数原文会把自己的说明当成违规（E5 假红）。 */
  const viewCode = viewSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const scriptSrc = viewSrc.slice(viewSrc.indexOf('<script setup>'), viewSrc.indexOf('</script>'))
  const countIn = (haystack, needle) => haystack.split(needle).length - 1

  /** 取顶层函数的函数体（静态判据用）。 */
  function bodyOf(source, name) {
    const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
    const match = re.exec(source)
    if (!match) return ''
    const open = source.indexOf('{', match.index)
    let depth = 0
    let i = open
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    return source.slice(open, i + 1)
  }

  const sessionBody = bodyOf(scriptSrc, 'onIssueSessionToken')
  check(
    'E1',
    '交付桥 `meta` 带续签凭据：会话签发路径里 `refresh_token: renewal.refresh_token` 与 `phone: renewal.phone` 各恰 1 处，且 `expires_at` / `ttl_seconds` 仍在（契约未被替换，只是加性扩展）',
    { refresh: 1, phone: 1, expiresAt: 1, ttl: 1 },
    {
      refresh: countIn(sessionBody, 'refresh_token: renewal.refresh_token'),
      phone: countIn(sessionBody, 'phone: renewal.phone'),
      expiresAt: countIn(sessionBody, 'expires_at: reply.expires_at'),
      ttl: countIn(sessionBody, 'ttl_seconds: DEVICE_SESSION_TTL_SECONDS')
    }
  )

  const renewalBody = bodyOf(scriptSrc, 'sessionRenewalMeta')
  check(
    'E2',
    '取凭据的唯一路径是**当前 OTP 会话**（`otpAuth()` → `getSession()` 的 `session.refresh_token`，与 `access_token` 同处）；取不到 ⇒ 空串（**不阻断交付**，降级为纯 8 小时会话）',
    {
      usesOtpAuth: 1,
      readsRefresh: true,
      emptyFallback: true,
      storageHits: 0
    },
    {
      usesOtpAuth: countIn(renewalBody, 'await otpAuth()'),
      /* 读法在 2026-11-17 由「字面 `session.refresh_token`」收敛为「经 `pairOf()` 归一」：
         `source.refresh_token || source.refreshToken`（同一字段的两种拼法）。
         判据强度不变 —— 仍要求**从 OTP 会话读 refresh_token**，只是不再限定字面形态。 */
      readsRefresh: (renewalBody.indexOf('session.refresh_token') !== -1)
        || /source\.refresh_token\s*\|\|\s*source\.refreshToken/.test(renewalBody)
        || /refresh_token\s*=\s*String\(source\.refresh_token/.test(renewalBody),
      emptyFallback: renewalBody.indexOf("refresh_token: ''") !== -1 && renewalBody.indexOf('return out') !== -1,
      storageHits: ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'console.', 'URLSearchParams']
        .map((needle) => countIn(renewalBody, needle))
        .reduce((sum, value) => sum + value, 0)
    }
  )

  /* 令牌 / 续签凭据都**不上屏**：唯一文本域仍是设备令牌；delivered 块零令牌绑定。 */
  const deliveredAt = viewSrc.indexOf('data-feicui-device-delivered')
  const deliveredEnd = deliveredAt < 0 ? -1 : viewSrc.indexOf('</section>', deliveredAt)
  const deliveredSrc = deliveredAt < 0 || deliveredEnd < 0 ? '' : viewSrc.slice(deliveredAt, deliveredEnd)
  check(
    'E3',
    '`refresh_token` **不上屏**：模板里零 `refresh_token` 命中（唯一文本域仍只有 `deviceToken.token`），“已交付”块零令牌绑定',
    { template: 0, tokenBindings: 1, deliveredBlock: 0 },
    {
      template: countIn(viewSrc.slice(viewSrc.indexOf('<template>'), viewSrc.indexOf('</template>')), 'refresh_token'),
      tokenBindings: countIn(viewSrc, ':value="deviceToken.token"'),
      deliveredBlock: countIn(deliveredSrc, 'deviceToken')
    }
  )

  const copyBody = bodyOf(scriptSrc, 'onCopyDeviceToken')
  const issue30 = bodyOf(scriptSrc, 'onIssueDeviceToken')
  check(
    'E4',
    '手动复制回退路径**不带** `refresh_token`（`onCopyDeviceToken` 只复制设备令牌）；30 天那条路零改动（不涉及续签凭据）',
    { copyHits: 0, thirtyDayHits: 0 },
    { copyHits: countIn(copyBody, 'refresh_token'), thirtyDayHits: countIn(issue30, 'refresh_token') }
  )

  check(
    'E5',
    '视图码面零持久层 / 零日志（`localStorage` / `sessionStorage` / `indexedDB` / `cookie` / `console.` 五键命中全 0）—— 续签凭据随 `meta` 离场，存钥匙串是桌面端的事',
    { localStorage: 0, sessionStorage: 0, indexedDB: 0, cookie: 0, console: 0 },
    {
      localStorage: countIn(viewCode, 'localStorage'),
      sessionStorage: countIn(viewCode, 'sessionStorage'),
      indexedDB: countIn(viewCode, 'indexedDB'),
      cookie: countIn(viewCode, 'cookie'),
      console: countIn(viewCode, 'console.')
    }
  )

  check(
    'E6',
    '取不到续签凭据时**不阻断交付**：`onIssueSessionToken` 里对 `sessionRenewalMeta()` 的调用被 try/catch 包住，异常 ⇒ 空 meta 继续交付（失败路径不会丢掉 8 小时令牌）',
    { guarded: true, ttlSurvives: true },
    {
      guarded: /try\s*\{\s*renewal = await sessionRenewalMeta\(\)/.test(sessionBody),
      ttlSurvives: sessionBody.indexOf('refresh_token: renewal.refresh_token') !== -1 && sessionBody.indexOf('ttl_seconds: DEVICE_SESSION_TTL_SECONDS') !== -1
    }
  )
}

/* ---------------------------------------------------------------------------
   收尾：summary（末行 JSON；退出码 1 ⇒ 有红）
   ------------------------------------------------------------------------- */
const summary = {
  suite: 'verify-feicui-session-endpoints',
  total,
  passed,
  failed: total - passed,
  failed_ids: failedIds,
  sections: sectionStats
}
console.log(JSON.stringify(summary))
if (failedIds.length > 0) process.exitCode = 1
