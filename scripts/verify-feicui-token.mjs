/**
 * 玺爱 · **自检：斐萃（feicui）令牌 ＋ 转发路由**（本单改造：废弃一次性授权码 / CloudBase 核销）
 * ============================================================================
 * **本地、离线**（除本机回环上自起的「假上游」外零外部网络）：
 *
 *   A. **令牌纯函数**（`cloudfunctions/xiai-user-token/lib/feicuiToken.js`）
 *      签/验正确；**篡改 payload ⇒ 必拒**；过期 ⇒ 拒；**未知 kid ⇒ 拒**；**已吊销 jti ⇒ 拒**；
 *      缺 env ⇒ 拒（签不出也验不过）；TTL 边界；版本 / 形态 / 声明形态；kid 轮换（上一把仍可验）。
 *
 *   B. **转发路由**（`api/feicui/v1/[...path].js`）—— **真 handler ＋ 真 `http.createServer` ＋ 假上游**：
 *      200 ＋ 第二次**缓存命中不打上游**；无/坏令牌 ⇒ 401；非白名单 path ⇒ 404；query 越界 ⇒ 400；
 *      方法面 405；上游 5xx ⇒ 502 `UPSTREAM_ERROR`（**不伪装成功、不缓存失败**）；
 *      缺 `YINYUAN_API_KEY` ⇒ 503；超限 ⇒ 429 ＋ `Retry-After`；缓存 TTL 到期 ⇒ 重新打上游。
 *
 *   C. **静态门**：`index.js` 零 SDK；`feicuiToken.js` 零 SDK / 零 IO；无 `/admin` 路由；
 *      侧边栏**恰四项**；旧授权码通道**已彻底清除**（文件不存在 / 仓内零引用）；**仓内零 secret 字面**。
 *
 *   D. **回归**：`verify-session-authority` / `verify-userwrite-pa` / `verify-endorsement` /
 *      `verify-sidebar-nav`（逐条跑、取各自 summary）。
 *
 * 纪律：**不打印任何密钥 / 令牌原文**（只给长度与指纹）；不碰任何外部服务；断言失败 ⇒ 退出码 1。
 */

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const tokenLib = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/feicuiToken.js'))

/* ---------------------------------------------------------------------------
   0. 断言 / 读数
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

/* 运行期随机密钥（**仓内零 secret 字面**：连自检也不用固定值）。 */
const SECRET = randomBytes(32).toString('hex')
const OTHER_SECRET = randomBytes(32).toString('hex')
const API_KEY = randomBytes(24).toString('hex')
const NOW = 1_800_000_000

/* ---------------------------------------------------------------------------
   A. 令牌纯函数
   --------------------------------------------------------------------------- */

console.log(JSON.stringify({ section: 'A', title: '斐萃令牌：签 / 验 / 篡改 / 过期 / kid / 吊销 / TTL' }))

const baseEnv = { FEICUI_TOKEN_SECRET: SECRET, FEICUI_TOKEN_KID: 'k1' }
const UID = 'u-0123456789abcdef'

const signed = tokenLib.sign({ uid: UID, role: 'user', ttlSeconds: 3600, nowSeconds: NOW, env: baseEnv })
check('A1', '签发成功且回包带全元数据（token/uid/role/kid/jti/iat/exp/expires_at/ttl_seconds）',
  { ok: true, uid: UID, role: 'user', kid: 'k1', ttl: 3600, iat: NOW, exp: NOW + 3600 },
  { ok: signed.ok, uid: signed.uid, role: signed.role, kid: signed.kid, ttl: signed.ttl_seconds, iat: signed.iat, exp: signed.exp })
check('A2', '令牌形态恰三段、前缀 `v1`、无 `=` padding、无 `+/`（长度读数为指纹不算原文）',
  { parts: 3, prefix: 'v1', padding: false, plusSlash: false, lengthOk: true },
  {
    parts: signed.token.split('.').length,
    prefix: signed.token.split('.')[0],
    padding: signed.token.includes('='),
    plusSlash: /[+/]/.test(signed.token),
    lengthOk: signed.token.length > 100 && signed.token.length < 400
  })
check('A3', 'payload 恰 7 键 `{v,uid,role,jti,iat,exp,kid}`',
  ['exp', 'iat', 'jti', 'kid', 'role', 'uid', 'v'],
  Object.keys(JSON.parse(Buffer.from(signed.token.split('.')[1], 'base64url').toString('utf8'))).sort())

const verified = tokenLib.verify(signed.token, { nowSeconds: NOW + 10, env: baseEnv })
check('A4', '验签通过：uid/role/exp/kid/jti 逐字回吐，reason=OK',
  { ok: true, uid: UID, role: 'user', exp: NOW + 3600, kid: 'k1', jti: signed.jti, reason: 'OK' },
  { ok: verified.ok, uid: verified.uid, role: verified.role, exp: verified.exp, kid: verified.kid, jti: verified.jti, reason: verified.reason })

/* **篡改 payload**（uid 换成别人，签名照抄）⇒ 必拒 BAD_SIGNATURE。 */
const [prefix, payloadSeg, sigSeg] = signed.token.split('.')
const claims = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8'))
const forgedClaims = Object.assign({}, claims, { uid: 'u-ffffffffffffffff' })
const forgedToken = `${prefix}.${Buffer.from(JSON.stringify(forgedClaims)).toString('base64url')}.${sigSeg}`
check('A5', '**篡改 payload（换 uid）⇒ 拒**（BAD_SIGNATURE），且不回 uid',
  { ok: false, reason: 'BAD_SIGNATURE', uid: '' },
  { ok: tokenLib.verify(forgedToken, { nowSeconds: NOW + 10, env: baseEnv }).ok, reason: tokenLib.verify(forgedToken, { nowSeconds: NOW + 10, env: baseEnv }).reason, uid: tokenLib.verify(forgedToken, { nowSeconds: NOW + 10, env: baseEnv }).uid })

/* **篡改签名**（改动最后一字符）。 */
const flipped = `${prefix}.${payloadSeg}.${sigSeg.slice(0, -1)}${sigSeg.slice(-1) === 'A' ? 'B' : 'A'}`
check('A6', '**篡改签名 ⇒ 拒**（BAD_SIGNATURE）', 'BAD_SIGNATURE', tokenLib.verify(flipped, { nowSeconds: NOW + 10, env: baseEnv }).reason)
/* **换密钥签的同形令牌 ⇒ 拒**。 */
const foreign = tokenLib.sign({ uid: UID, ttlSeconds: 3600, nowSeconds: NOW, secret: OTHER_SECRET, kid: 'k1' })
check('A7', '**用另一把密钥签 ⇒ 拒**（BAD_SIGNATURE）', 'BAD_SIGNATURE',
  tokenLib.verify(foreign.token, { nowSeconds: NOW + 10, env: baseEnv }).reason)

/* 过期边界。 */
check('A8', '到期前 1 秒 ⇒ 仍有效（TTL 边界）', true, tokenLib.verify(signed.token, { nowSeconds: NOW + 3599, env: baseEnv }).ok)
check('A9', '**恰在 exp ⇒ 过期**（`exp === now` 判过期，硬边界）', 'EXPIRED',
  tokenLib.verify(signed.token, { nowSeconds: NOW + 3600, env: baseEnv }).reason)
check('A10', '**过期后 ⇒ 拒**（EXPIRED）', 'EXPIRED', tokenLib.verify(signed.token, { nowSeconds: NOW + 7200, env: baseEnv }).reason)

/* 未知 kid / 轮换。 */
check('A11', '**未知 kid（不轮换、不在允许集合）⇒ 拒**（KID_UNKNOWN）', 'KID_UNKNOWN',
  tokenLib.verify(signed.token, { nowSeconds: NOW + 10, env: { FEICUI_TOKEN_SECRET: SECRET, FEICUI_TOKEN_KID: 'k9' } }).reason)
const rotated = tokenLib.sign({ uid: UID, ttlSeconds: 3600, nowSeconds: NOW, env: { FEICUI_TOKEN_SECRET: OTHER_SECRET, FEICUI_TOKEN_KID: 'k2' } })
const rotationEnv = {
  FEICUI_TOKEN_SECRET: OTHER_SECRET,
  FEICUI_TOKEN_KID: 'k2',
  FEICUI_TOKEN_PREVIOUS_SECRET: SECRET,
  FEICUI_TOKEN_PREVIOUS_KID: 'k1'
}
check('A12', '平滑轮换：新 kid= k2 签发 ⇒ 新令牌可验；**旧 kid= k1 的旧令牌仍可验**',
  { newOk: true, newKid: 'k2', oldOk: true },
  {
    newOk: tokenLib.verify(rotated.token, { nowSeconds: NOW + 10, env: rotationEnv }).ok,
    newKid: tokenLib.verify(rotated.token, { nowSeconds: NOW + 10, env: rotationEnv }).kid,
    oldOk: tokenLib.verify(signed.token, { nowSeconds: NOW + 10, env: rotationEnv }).ok
  })
check('A13', '轮换期外（只配 k2）⇒ 旧 kid 令牌被拒（KID_UNKNOWN）', 'KID_UNKNOWN',
  tokenLib.verify(signed.token, { nowSeconds: NOW + 10, env: { FEICUI_TOKEN_SECRET: OTHER_SECRET, FEICUI_TOKEN_KID: 'k2' } }).reason)

/* 吊销名单。 */
check('A14', '**已吊销 jti ⇒ 拒**（REVOKED）', 'REVOKED',
  tokenLib.verify(signed.token, { nowSeconds: NOW + 10, env: baseEnv, revoked: [{ jti: signed.jti, reason: 'lost-device' }] }).reason)
check('A15', '吊销名单里的**别的 jti** 不影响本令牌；`{revoked:[…]}` / `Set` / 裸串数组三种形态等价',
  { ok: true, byObject: 'REVOKED', bySet: 'REVOKED', byArray: 'REVOKED' },
  {
    ok: tokenLib.verify(signed.token, { nowSeconds: NOW + 10, env: baseEnv, revoked: { revoked: [{ jti: 'jt-aaaaaaaaaaaaaaaaaaaaaaaa' }] } }).ok,
    byObject: tokenLib.verify(signed.token, { nowSeconds: NOW + 10, env: baseEnv, revoked: { revoked: [{ jti: signed.jti }] } }).reason,
    bySet: tokenLib.verify(signed.token, { nowSeconds: NOW + 10, env: baseEnv, revoked: new Set([signed.jti]) }).reason,
    byArray: tokenLib.verify(signed.token, { nowSeconds: NOW + 10, env: baseEnv, revoked: [signed.jti] }).reason
  })
check('A16', '吊销名单归一化：脏行（缺 jti / 形态不合）被忽略、不放大影响',
  { kept: 1, dropped: 2 },
  (() => {
    const list = tokenLib.normalizeRevokedList({ revoked: [{ jti: 'jt-0123456789abcdef' }, { reason: 'x' }, { jti: 'bad jti' }] })
    return { kept: list.length, dropped: 3 - list.length }
  })())

/* 缺 env ⇒ fail-closed。 */
check('A17', '**缺 `FEICUI_TOKEN_SECRET` ⇒ 签不出**（SECRET_MISSING）', 'SECRET_MISSING',
  tokenLib.sign({ uid: UID, nowSeconds: NOW, env: {} }).reason)
check('A18', '**缺 `FEICUI_TOKEN_SECRET` ⇒ 验不过**（SECRET_MISSING；不降级放行）', 'SECRET_MISSING',
  tokenLib.verify(signed.token, { nowSeconds: NOW + 10, env: {} }).reason)
check('A19', '密钥环读数只给布尔/计数（不泄密钥）：configured/currentKid/keyCount 三键',
  { configured: true, currentKid: 'k1', keyCount: 1, hasSecretKey: false },
  (() => {
    const status = tokenLib.keyringStatus({ env: baseEnv })
    return { configured: status.configured, currentKid: status.currentKid, keyCount: status.keyCount, hasSecretKey: Object.prototype.hasOwnProperty.call(status, 'secret') }
  })())

/* TTL 边界。 */
check('A20', 'TTL 缺省 ＝ 30 天（2592000 s）', { defaultTtl: 2592000, exp: NOW + 2592000 },
  (() => {
    const s = tokenLib.sign({ uid: UID, nowSeconds: NOW, env: baseEnv })
    return { defaultTtl: s.ttl_seconds, exp: s.exp }
  })())
check('A21', 'TTL 下边界 300 s 可签、299 s 被拒；上边界 7776000 s 可签、7776001 s 被拒',
  { min: true, belowMin: 'TTL_INVALID', max: true, aboveMax: 'TTL_INVALID' },
  {
    min: tokenLib.sign({ uid: UID, ttlSeconds: 300, nowSeconds: NOW, env: baseEnv }).ok,
    belowMin: tokenLib.sign({ uid: UID, ttlSeconds: 299, nowSeconds: NOW, env: baseEnv }).reason,
    max: tokenLib.sign({ uid: UID, ttlSeconds: 7776000, nowSeconds: NOW, env: baseEnv }).ok,
    aboveMax: tokenLib.sign({ uid: UID, ttlSeconds: 7776001, nowSeconds: NOW, env: baseEnv }).reason
  })

/* 形态面。 */
check('A22', '空令牌 ⇒ MISSING；段数不对 / 非 base64url ⇒ MALFORMED；前缀非 v1 ⇒ VERSION_MISMATCH',
  { empty: 'MISSING', twoParts: 'MALFORMED', badB64: 'MALFORMED', prefix: 'VERSION_MISMATCH' },
  {
    empty: tokenLib.verify('', { nowSeconds: NOW, env: baseEnv }).reason,
    twoParts: tokenLib.verify('v1.abc', { nowSeconds: NOW, env: baseEnv }).reason,
    badB64: tokenLib.verify('v1.!!!.???', { nowSeconds: NOW, env: baseEnv }).reason,
    prefix: tokenLib.verify(`v2.${payloadSeg}.${sigSeg}`, { nowSeconds: NOW, env: baseEnv }).reason
  })
check('A23', 'payload 里 `v:2` ⇒ VERSION_MISMATCH（版本面双处一致）', 'VERSION_MISMATCH',
  (() => {
    const tampered = Object.assign({}, claims, { v: 2 })
    const body = `v1.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}`
    const sig = require('node:crypto').createHmac('sha256', SECRET).update(body).digest('base64url')
    return tokenLib.verify(`${body}.${sig}`, { nowSeconds: NOW + 10, env: baseEnv }).reason
  })())
check('A24', '签发面拒绝非法入参：uid 含空格 / role 非法 / kid 形态不合',
  { uid: 'CLAIMS_INVALID', role: 'CLAIMS_INVALID', kid: 'CLAIMS_INVALID' },
  {
    uid: tokenLib.sign({ uid: 'u-01 23', nowSeconds: NOW, env: baseEnv }).reason,
    role: tokenLib.sign({ uid: UID, role: 'root', nowSeconds: NOW, env: baseEnv }).reason,
    kid: tokenLib.sign({ uid: UID, kid: 'k 1', nowSeconds: NOW, env: baseEnv }).reason
  })
check('A25', '声明形态：exp ≤ iat 的令牌即使签名正确也拒（CLAIMS_INVALID）', 'CLAIMS_INVALID',
  (() => {
    const bad = { v: 1, uid: UID, role: 'user', jti: 'jt-0123456789abcdef', iat: NOW, exp: NOW, kid: 'k1' }
    const body = `v1.${Buffer.from(JSON.stringify(bad)).toString('base64url')}`
    const sig = require('node:crypto').createHmac('sha256', SECRET).update(body).digest('base64url')
    return tokenLib.verify(`${body}.${sig}`, { nowSeconds: NOW - 10, env: baseEnv }).reason
  })())
check('A26', '`iat` 在未来超过容差（60 s）⇒ NOT_YET_VALID；容差内 ⇒ 放行',
  { beyond: 'NOT_YET_VALID', within: true },
  (() => {
    const future = tokenLib.sign({ uid: UID, ttlSeconds: 3600, nowSeconds: NOW + 600, env: baseEnv })
    return {
      beyond: tokenLib.verify(future.token, { nowSeconds: NOW, env: baseEnv }).reason,
      within: tokenLib.verify(future.token, { nowSeconds: NOW + 541, env: baseEnv }).ok
    }
  })())

/* ---------------------------------------------------------------------------
   B. 转发路由（真 handler ＋ 真 http.createServer ＋ 假上游）
   --------------------------------------------------------------------------- */

const routeModule = await import(pathToFileURL(path.join(ROOT, 'api/feicui/v1/[...path].js')).href)
const forward = routeModule.default

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function startTarget(handler) {
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      res.statusCode = 500
      res.end('{"ok":false}')
    })
  })
  return listen(server).then((port) => ({ server, base: `http://127.0.0.1:${port}` }))
}

async function request(base, urlPath, init) {
  const response = await fetch(`${base}${urlPath}`, Object.assign({ method: 'GET' }, init || {}))
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, headers: response.headers, body }
}

/* 假上游：计数 ＋ 可切失败模式。 */
const upstreamHits = []
let upstreamMode = 'ok'
const upstreamServer = createServer((req, res) => {
  upstreamHits.push({ url: req.url, authorization: req.headers.authorization })
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (upstreamMode === 'fail') {
    res.statusCode = 500
    res.end('{"ok":false,"reason":"boom"}')
    return
  }
  res.statusCode = 200
  res.end(JSON.stringify({ ok: true, data: [{ id: 'd-1' }], upstreamPath: req.url }))
})
const upstreamPort = await listen(upstreamServer)
const upstreamBase = `http://127.0.0.1:${upstreamPort}/api/v1`

const env = {
  YINYUAN_API_KEY: API_KEY,
  YINYUAN_API_BASE: upstreamBase,
  FEICUI_TOKEN_SECRET: SECRET,
  FEICUI_TOKEN_KID: 'k1',
  FEICUI_FORWARD_TIMEOUT_MS: '2000'
}

const cache = routeModule.createCache({ ttlMs: 60_000, maxEntries: 10 })
const clock = { ms: NOW * 1000 }
const handler = routeModule.createForwardHandler({
  env,
  cache,
  now: () => clock.ms,
  loadRevoked: () => ({ list: [], degraded: false }),
  logger: { log() {} }
})
const target = await startTarget(handler)

const tokenResult = tokenLib.sign({ uid: UID, role: 'user', ttlSeconds: 7200, nowSeconds: NOW, env })
const token = tokenResult.token
const auth = { Authorization: `Feicui ${token}` }
const authHeaderPresent = typeof token === 'string' && token.length > 100

console.log(JSON.stringify({ section: 'B', title: '转发路由：白名单 / 缓存 / 限流 / 上游失败（真 HTTP，假上游）' }))

const r1 = await request(target.base, '/api/feicui/v1/dynasties?limit=2', { headers: auth })
check('B1', '合法令牌 + 白名单 path ⇒ 200，上游被调用 1 次，带 `Authorization: ApiKey <xiai 的 key>`',
  { status: 200, ok: true, hits: 1, upstreamAuthOk: true, cache: 'miss', tokenHeaderPresent: true },
  {
    status: r1.status,
    ok: r1.body && r1.body.ok,
    hits: upstreamHits.length,
    upstreamAuthOk: upstreamHits[0] && upstreamHits[0].authorization === `ApiKey ${API_KEY}`,
    cache: r1.headers.get('x-feicui-cache'),
    tokenHeaderPresent: authHeaderPresent
  })
check('B2', '成功响应 `Cache-Control` **private**（bearer 面不得给 CDN 共享缓存）＋ `Vary: Authorization`',
  { cacheControl: 'private, max-age=300', vary: 'Authorization' },
  { cacheControl: r1.headers.get('cache-control'), vary: r1.headers.get('vary') })

const r2 = await request(target.base, '/api/feicui/v1/dynasties?limit=2', { headers: auth })
check('B3', '**第二次同请求 ⇒ 缓存命中，不再打上游**（上游计数仍为 1）',
  { status: 200, cache: 'hit', hits: 1, samePayload: true },
  { status: r2.status, cache: r2.headers.get('x-feicui-cache'), hits: upstreamHits.length, samePayload: JSON.stringify(r2.body) === JSON.stringify(r1.body) })

const r3 = await request(target.base, '/api/feicui/v1/dynasties?limit=3', { headers: auth })
check('B4', 'query 不同 ⇒ 缓存键不同（重新打上游，计数 2）', { hits: 2, cache: 'miss' },
  { hits: upstreamHits.length, cache: r3.headers.get('x-feicui-cache') })

const r4 = await request(target.base, '/api/feicui/v1/authors', { headers: auth })
check('B5', '另一条白名单 path ⇒ 200（缓存按 path+query 分键）', { status: 200, hits: 3 },
  { status: r4.status, hits: upstreamHits.length })

const r5 = await request(target.base, '/api/feicui/v1/inscriptions?offset=10&limit=5', { headers: auth })
check('B6', '`offset` 也放行，且**上游 URL 的 query 规范化**（limit 在 offset 前）', { status: 200, upstreamUrl: '/api/v1/inscriptions?limit=5&offset=10' },
  { status: r5.status, upstreamUrl: (upstreamHits[upstreamHits.length - 1] || {}).url })

const hitsBeforeNoAuth = upstreamHits.length
const r6 = await request(target.base, '/api/feicui/v1/dynasties')
check('B7', '无 `Authorization` ⇒ 401 TOKEN_INVALID（且不打上游）', { status: 401, reason: 'TOKEN_INVALID', hits: hitsBeforeNoAuth },
  { status: r6.status, reason: r6.body && r6.body.reason, hits: upstreamHits.length })

const r7 = await request(target.base, '/api/feicui/v1/dynasties', { headers: { Authorization: `Feicui ${token.slice(0, -2)}xy` } })
check('B8', '**坏令牌（签名尾改）⇒ 401 TOKEN_INVALID**', { status: 401, reason: 'TOKEN_INVALID' },
  { status: r7.status, reason: r7.body && r7.body.reason })

const r8 = await request(target.base, '/api/feicui/v1/dynasties', { headers: { Authorization: `Bearer ${token}` } })
check('B9', '错误的 scheme（Bearer）⇒ 401（只认 `Feicui`）', { status: 401, reason: 'TOKEN_INVALID' },
  { status: r8.status, reason: r8.body && r8.body.reason })

const expiredToken = tokenLib.sign({ uid: UID, ttlSeconds: 3600, nowSeconds: NOW - 7200, env })
const r9 = await request(target.base, '/api/feicui/v1/dynasties', { headers: { Authorization: `Feicui ${expiredToken.token}` } })
check('B10', '**过期令牌 ⇒ 401 TOKEN_INVALID**（对外不区分过期 / 签名错）', { status: 401, reason: 'TOKEN_INVALID' },
  { status: r9.status, reason: r9.body && r9.body.reason })

const r10 = await request(target.base, '/api/feicui/v1/keys', { headers: auth })
check('B11', '**非白名单 path `/keys` ⇒ 404 PATH_NOT_ALLOWED**（绝不透传）', { status: 404, reason: 'PATH_NOT_ALLOWED' },
  { status: r10.status, reason: r10.body && r10.body.reason })
const r11 = await request(target.base, '/api/feicui/v1/dynasties/extra', { headers: auth })
check('B12', '多段 path ⇒ 404 PATH_NOT_ALLOWED', { status: 404, reason: 'PATH_NOT_ALLOWED' },
  { status: r11.status, reason: r11.body && r11.body.reason })
const r12 = await request(target.base, '/api/feicui/v1/', { headers: auth })
check('B13', '空 path ⇒ 404 PATH_NOT_ALLOWED', { status: 404, reason: 'PATH_NOT_ALLOWED' },
  { status: r12.status, reason: r12.body && r12.body.reason })

/* **Vercel 形态**：`req.query.path`（catch-all 数组）＋ `req.url` 不带 query ⇒ 仍要认得 path / query。 */
function callHandler(handlerFn, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(key, value) {
        this.headers[String(key).toLowerCase()] = value
      },
      end(payload) {
        this.body = payload
        resolve({ status: this.statusCode, headers: this.headers, body: JSON.parse(payload) })
      }
    }
    handlerFn(req, res).catch(() => resolve({ status: 500, headers: {}, body: null }))
  })
}
const vercelLike = await callHandler(handler, {
  method: 'GET',
  url: '/',
  query: { path: ['dynasties'], limit: '4' },
  headers: { authorization: `Feicui ${token}` }
})
check('B14', 'Vercel 形态（`req.query.path` 数组 ＋ `req.url` 无 query）⇒ 200 且按 path/limit 转发',
  { status: 200, upstreamUrl: '/api/v1/dynasties?limit=4' },
  { status: vercelLike.status, upstreamUrl: (upstreamHits[upstreamHits.length - 1] || {}).url })
const vercelBadQuery = await callHandler(handler, {
  method: 'GET',
  url: '/',
  query: { path: ['dynasties'], page: '2' },
  headers: { authorization: `Feicui ${token}` }
})
check('B15', 'Vercel 形态下出现非白名单 query 键（`page`）⇒ 400 INVALID_QUERY', { status: 400, reason: 'INVALID_QUERY' },
  { status: vercelBadQuery.status, reason: vercelBadQuery.body && vercelBadQuery.body.reason })

const r13 = await request(target.base, '/api/feicui/v1/dynasties?foo=1', { headers: auth })
check('B16', 'query 含非白名单键 ⇒ 400 INVALID_QUERY（**如实报错，不静默丢键**）', { status: 400, reason: 'INVALID_QUERY' },
  { status: r13.status, reason: r13.body && r13.body.reason })
const r14 = await request(target.base, '/api/feicui/v1/dynasties?limit=0', { headers: auth })
check('B17', '`limit=0`（下界外）⇒ 400 INVALID_QUERY', { status: 400, reason: 'INVALID_QUERY' },
  { status: r14.status, reason: r14.body && r14.body.reason })
const r15 = await request(target.base, '/api/feicui/v1/dynasties?limit=201', { headers: auth })
check('B18', '`limit=201`（上界外）⇒ 400 INVALID_QUERY', { status: 400, reason: 'INVALID_QUERY' },
  { status: r15.status, reason: r15.body && r15.body.reason })
const r16 = await request(target.base, '/api/feicui/v1/dynasties?limit=abc', { headers: auth })
check('B19', '`limit=abc`（非整数）⇒ 400 INVALID_QUERY', { status: 400, reason: 'INVALID_QUERY' },
  { status: r16.status, reason: r16.body && r16.body.reason })

const r17 = await request(target.base, '/api/feicui/v1/dynasties', { method: 'POST', headers: auth })
check('B20', 'POST ⇒ 405 METHOD_NOT_ALLOWED ＋ `Allow: GET`', { status: 405, reason: 'METHOD_NOT_ALLOWED', allow: 'GET' },
  { status: r17.status, reason: r17.body && r17.body.reason, allow: r17.headers.get('allow') })

/* 上游 5xx ⇒ 502，且不缓存失败。 */
const beforeFail = upstreamHits.length
upstreamMode = 'fail'
const r18 = await request(target.base, '/api/feicui/v1/authors?limit=7', { headers: auth })
upstreamMode = 'ok'
check('B21', '**上游 500 ⇒ 502 `UPSTREAM_ERROR` ＋ status=500（不伪装成功）**',
  { status: 502, reason: 'UPSTREAM_ERROR', upstreamStatus: 500 },
  { status: r18.status, reason: r18.body && r18.body.reason, upstreamStatus: r18.body && r18.body.status })
const r19 = await request(target.base, '/api/feicui/v1/authors?limit=7', { headers: auth })
check('B22', '**失败响应不被缓存**（同一请求再打 ⇒ 200 且上游计数继续增长）', { status: 200, grew: true },
  { status: r19.status, grew: upstreamHits.length > beforeFail + 1 })

/* 缺上游 key ⇒ 503。 */
const noKeyHandler = routeModule.createForwardHandler({
  env: { FEICUI_TOKEN_SECRET: SECRET, YINYUAN_API_BASE: upstreamBase },
  now: () => clock.ms,
  loadRevoked: () => ({ list: [], degraded: false }),
  logger: { log() {} }
})
const noKeyTarget = await startTarget(noKeyHandler)
const r20 = await request(noKeyTarget.base, '/api/feicui/v1/dynasties', { headers: auth })
check('B23', '**缺 `YINYUAN_API_KEY` ⇒ 503 CONFIG_MISSING**（不猜、不放行）', { status: 503, reason: 'CONFIG_MISSING' },
  { status: r20.status, reason: r20.body && r20.body.reason })

/* 吊销名单注入 ⇒ 401。 */
const revokedHandler = routeModule.createForwardHandler({
  env,
  now: () => clock.ms,
  loadRevoked: () => ({ list: [{ jti: tokenLib.verify(token, { nowSeconds: NOW + 1, env }).jti, reason: 'lost-device' }], degraded: false }),
  logger: { log() {} }
})
const revokedTarget = await startTarget(revokedHandler)
const r21 = await request(revokedTarget.base, '/api/feicui/v1/dynasties', { headers: auth })
check('B24', '**已吊销 jti ⇒ 401 TOKEN_INVALID**（路由层）', { status: 401, reason: 'TOKEN_INVALID' },
  { status: r21.status, reason: r21.body && r21.body.reason })

/* 限流：max=2 ⇒ 第 3 次 429。 */
const limitedHandler = routeModule.createForwardHandler({
  env,
  limiter: routeModule.createUidLimiter({ max: 2, windowMs: 60_000 }),
  now: () => clock.ms,
  loadRevoked: () => ({ list: [], degraded: false }),
  logger: { log() {} }
})
const limitedTarget = await startTarget(limitedHandler)
const l1 = await request(limitedTarget.base, '/api/feicui/v1/dynasties', { headers: auth })
const l2 = await request(limitedTarget.base, '/api/feicui/v1/dynasties?limit=2', { headers: auth })
const l3 = await request(limitedTarget.base, '/api/feicui/v1/dynasties?limit=3', { headers: auth })
check('B25', '**按 uid 限流：第 3 次超限 ⇒ 429 RATE_LIMITED ＋ `Retry-After` ≥ 1**',
  { first: 200, second: 200, third: 429, reason: 'RATE_LIMITED', retryAfterAtLeast1: true },
  {
    first: l1.status,
    second: l2.status,
    third: l3.status,
    reason: l3.body && l3.body.reason,
    retryAfterAtLeast1: Number(l3.headers.get('retry-after')) >= 1
  })

/* 缓存 TTL 到期 ⇒ 重新打上游。 */
const ttlCache = routeModule.createCache({ ttlMs: 1000, maxEntries: 4 })
const ttlClock = { ms: NOW * 1000 }
const ttlHandler = routeModule.createForwardHandler({
  env,
  cache: ttlCache,
  now: () => ttlClock.ms,
  loadRevoked: () => ({ list: [], degraded: false }),
  logger: { log() {} }
})
const ttlTarget = await startTarget(ttlHandler)
const hitsBeforeTtl = upstreamHits.length
await request(ttlTarget.base, '/api/feicui/v1/inscriptions?limit=9', { headers: auth })
const afterFirst = upstreamHits.length
await request(ttlTarget.base, '/api/feicui/v1/inscriptions?limit=9', { headers: auth })
const afterSecond = upstreamHits.length
ttlClock.ms += 1001
await request(ttlTarget.base, '/api/feicui/v1/inscriptions?limit=9', { headers: auth })
const afterExpiry = upstreamHits.length
check('B26', '**缓存 TTL 到期 ⇒ 重新打上游**（首打 miss / 二打 hit / 过期后再打 miss）',
  { firstAdds: 1, secondAdds: 0, afterExpiryAdds: 1 },
  { firstAdds: afterFirst - hitsBeforeTtl, secondAdds: afterSecond - afterFirst, afterExpiryAdds: afterExpiry - afterSecond })
check('B27', '缓存默认口径如实：TTL ＝ 24 h、上限 200 条、限流 60 次/分钟（**每实例，非分布式**）',
  { ttlMs: 86400000, maxEntries: 200, windowMs: 60000, max: 60 },
  {
    ttlMs: routeModule.CACHE_DEFAULTS.ttlMs,
    maxEntries: routeModule.CACHE_DEFAULTS.maxEntries,
    windowMs: routeModule.RATE_LIMIT_DEFAULTS.windowMs,
    max: routeModule.RATE_LIMIT_DEFAULTS.max
  })
check('B28', 'LRU 淘汰：maxEntries=2 时塞 3 条 ⇒ size=2 且最早一条被淘汰',
  { size: 2, firstEvicted: true, lastPresent: true },
  (() => {
    const lru = routeModule.createCache({ ttlMs: 10000, maxEntries: 2 })
    lru.set('a', { body: '{"a":1}' }, NOW)
    lru.set('b', { body: '{"b":1}' }, NOW)
    lru.set('c', { body: '{"c":1}' }, NOW)
    return { size: lru.size(), firstEvicted: lru.get('a', NOW) === null, lastPresent: lru.get('c', NOW) !== null }
  })())
check('B29', '吊销名单文件真实可读且初始为空（`config/feicui-token-revoked.json`）',
  { exists: true, revokedCount: 0, degraded: false },
  (() => {
    const loaded = routeModule.loadRevoked()
    return { exists: existsSync(path.join(ROOT, 'config/feicui-token-revoked.json')), revokedCount: loaded.list.length, degraded: loaded.degraded }
  })())

/* ---------------------------------------------------------------------------
   E. 签发面（云端 op）：仅管理员可签、手机号按仓内口径派生、**零落盘**
   --------------------------------------------------------------------------- */

console.log(JSON.stringify({ section: 'E', title: '签发面：`ADMIN_OPS.issueFeicuiToken`（仅管理员 / 手机号派生 uid / 零落盘）' }))

const opsModule = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))
const userConfig = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/config.js'))
const envBackup = { secret: process.env.FEICUI_TOKEN_SECRET, kid: process.env.FEICUI_TOKEN_KID }
process.env.FEICUI_TOKEN_SECRET = SECRET
process.env.FEICUI_TOKEN_KID = 'k1'
const adminIdentity = { uid: UID, phone: '', role: 'admin', identity_source: 'SESSION' }
const plainIdentity = { uid: UID, phone: '', role: 'user', identity_source: 'SESSION' }
const issueContext = { adminPhone: '', nowSeconds: NOW }

const issued = await opsModule.ADMIN_OPS.issueFeicuiToken({ target: '13800000000', role: 'user' }, adminIdentity, issueContext)
check('E1', '管理员 ＋ 手机号目标 ⇒ 签发成功；uid 按仓内口径派生（`u-`＋sha256 前 16 位）；TTL 缺省 30 天',
  { ok: true, op: 'issueFeicuiToken', uid: userConfig.uidOf('13800000000'), ttl: 2592000 },
  { ok: issued.ok, op: issued.op, uid: issued.row && issued.row.uid, ttl: issued.row && issued.row.ttl_seconds })
check('E2', '回包行**恰 9 键**（token/uid/role/kid/jti/iat/exp/expires_at/ttl_seconds），**无 plan ⇒ 零落盘**',
  { keys: ['exp', 'expires_at', 'iat', 'jti', 'kid', 'role', 'token', 'ttl_seconds', 'uid'], hasPlan: false },
  {
    keys: issued.row ? Object.keys(issued.row).sort() : [],
    hasPlan: Object.prototype.hasOwnProperty.call(issued, 'plan') || Object.prototype.hasOwnProperty.call(issued.row || {}, 'plan')
  })
check('E3', '签出的令牌可被路由侧同一套验签通过（同一把 env 密钥）', { ok: true, kid: 'k1' },
  (() => {
    const checked = tokenLib.verify(issued.row.token, { nowSeconds: NOW + 5, env: { FEICUI_TOKEN_SECRET: SECRET, FEICUI_TOKEN_KID: 'k1' } })
    return { ok: checked.ok, kid: checked.kid }
  })())
const denied = await opsModule.ADMIN_OPS.issueFeicuiToken({ target: '13800000000' }, plainIdentity, issueContext)
check('E4', '**普通用户 ⇒ FORBIDDEN**（服务端判据，不靠前端隐藏按钮）', { ok: false, reason: 'FORBIDDEN' },
  { ok: denied.ok, reason: denied.reason })
const unknownKey = await opsModule.ADMIN_OPS.issueFeicuiToken({ target: '13800000000', uid: 'u-ffffffffffffffff' }, adminIdentity, issueContext)
check('E5', '载荷含未登记键（`uid`）⇒ INVALID_FIELD（身份类键一律不采信）', { ok: false, reason: 'INVALID_FIELD' },
  { ok: unknownKey.ok, reason: unknownKey.reason })
const badTtl = await opsModule.ADMIN_OPS.issueFeicuiToken({ target: '13800000000', ttl_seconds: 100 }, adminIdentity, issueContext)
check('E6', 'TTL 越界（100 s）⇒ INVALID_VALUE（不静默夹取）', { ok: false, reason: 'INVALID_VALUE' },
  { ok: badTtl.ok, reason: badTtl.reason })
const badTarget = await opsModule.ADMIN_OPS.issueFeicuiToken({ target: 'not a uid/phone' }, adminIdentity, issueContext)
check('E7', '目标形态不合 ⇒ INVALID_VALUE（且回包不回显目标原文）', { ok: false, reason: 'INVALID_VALUE', echoesTarget: false },
  { ok: badTarget.ok, reason: badTarget.reason, echoesTarget: String(badTarget.message || '').includes('not a uid/phone') })
delete process.env.FEICUI_TOKEN_SECRET
const noSecret = await opsModule.ADMIN_OPS.issueFeicuiToken({ target: '13800000000' }, adminIdentity, issueContext)
check('E8', '**缺 `FEICUI_TOKEN_SECRET` ⇒ STORAGE_UNAVAILABLE**（不签发、不降级）', { ok: false, reason: 'STORAGE_UNAVAILABLE' },
  { ok: noSecret.ok, reason: noSecret.reason })
if (envBackup.secret === undefined) delete process.env.FEICUI_TOKEN_SECRET
else process.env.FEICUI_TOKEN_SECRET = envBackup.secret
if (envBackup.kid === undefined) delete process.env.FEICUI_TOKEN_KID
else process.env.FEICUI_TOKEN_KID = envBackup.kid

/* ---------------------------------------------------------------------------
   C. 静态门
   --------------------------------------------------------------------------- */

console.log(JSON.stringify({ section: 'C', title: '静态门：零 SDK / 零 IO / 无 /admin / 恰四项 / 零 secret 字面' }))

const userIndex = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/index.js'), 'utf8')
const tokenLibSource = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/feicuiToken.js'), 'utf8')
const routerSource = readFileSync(path.join(ROOT, 'src/router/index.js'), 'utf8')
const sidebarSource = readFileSync(path.join(ROOT, 'src/components/AppSidebar.vue'), 'utf8')

check('C1', '`xiai-user-token/index.js` **零 SDK 字面**（`@cloudbase/node-sdk` 0 命中）',
  { hits: 0 }, { hits: (userIndex.match(/@cloudbase\/node-sdk/g) || []).length })
check('C2', '`feicuiToken.js` **零 SDK / 零 IO**：无 `@cloudbase`、无 fs/http/net、`require` 只有 crypto',
  { sdk: 0, fsHttpNet: 0, requires: ['crypto'] },
  {
    sdk: (tokenLibSource.match(/@cloudbase/g) || []).length,
    fsHttpNet: (tokenLibSource.match(/require\(['"](fs|http|https|net|node:fs)['"]\)|readFileSync|writeFileSync|fetch\(/g) || []).length,
    requires: Array.from(new Set((tokenLibSource.match(/require\(['"]([^'"]+)['"]\)/g) || []).map((m) => m.replace(/require\(['"]|['"]\)/g, ''))))
  })
check('C3', '**无 `/admin` 类路由**（`src/router/index.js` 里 0 处 admin 路径）', { adminPaths: 0, connectRoute: 1 },
  { adminPaths: (routerSource.match(/path:\s*['"]\/(admin|sys|manage)/g) || []).length, connectRoute: (routerSource.match(/name:\s*['"]connect-feicui['"]/g) || []).length })
check('C4', '**侧边栏恰四项**（`AppSidebar.vue` 的 items 数组结构解析 ＝ 4）', { items: 4 },
  (() => {
    const start = sidebarSource.indexOf('const items = computed(() => [')
    const end = sidebarSource.indexOf('])', start)
    const slice = start >= 0 && end > start ? sidebarSource.slice(start, end) : ''
    return { items: (slice.match(/\{\s*key:/g) || []).length }
  })())
check('C5', '**旧授权码通道已清除**：`lib/feicuiCode.js` / `api/auth/feicui-exchange.js` / 自检脚本三件皆不存在',
  { codeLib: false, exchangeRoute: false, oldVerifier: false },
  {
    codeLib: existsSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/feicuiCode.js')),
    exchangeRoute: existsSync(path.join(ROOT, 'api/auth/feicui-exchange.js')),
    oldVerifier: existsSync(path.join(ROOT, 'scripts/verify-feicui-exchange.mjs'))
  })
check('C6', '仓内**零 `issueFeicuiCode` / `feicui-exchange` / `xiai_feicui_codes` 引用**（不留两套并存）',
  { issueFeicuiCode: 0, exchange: 0, collection: 0 },
  (() => {
    const files = walk(ROOT).filter((file) => /\.(js|mjs|vue|json|md)$/.test(file) && !/package-lock\.json$/.test(file))
    let issueFeicuiCode = 0
    let exchange = 0
    let collection = 0
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      if (file.endsWith('verify-feicui-token.mjs')) continue
      issueFeicuiCode += (source.match(/issueFeicuiCode/g) || []).length
      exchange += (source.match(/feicui-exchange|xiai_feicui_codes/g) || []).length
      collection += (source.match(/COLLECTIONS\.feicuiCodes/g) || []).length
    }
    return { issueFeicuiCode, exchange, collection }
  })())
check('C7', '**仓内零 secret 字面**（env 名后直接写值 / `ApiKey <长串>` / `Bearer <长串>` 三类 0 命中）',
  { envLiteral: [], apiKeyLiteral: [], bearerLiteral: [] },
  (() => {
    const patterns = [
      { key: 'envLiteral', re: /(?:FEICUI_TOKEN_SECRET|FEICUI_TOKEN_PREVIOUS_SECRET|XIAI_USER_TOKEN_SECRET|XIAI_ADMIN_TOKEN_SECRET|YINYUAN_API_KEY)\s*[:=]\s*['"][^'"\n]{8,}['"]/ },
      { key: 'apiKeyLiteral', re: /ApiKey\s+[A-Za-z0-9._-]{24,}/ },
      { key: 'bearerLiteral', re: /Bearer\s+[A-Za-z0-9._-]{24,}/ }
    ]
    const found = { envLiteral: [], apiKeyLiteral: [], bearerLiteral: [] }
    for (const file of walk(ROOT)) {
      if (!/\.(js|mjs|vue|json|md|html)$/.test(file) || /package-lock\.json$/.test(file)) continue
      const source = readFileSync(file, 'utf8')
      for (const pattern of patterns) {
        if (pattern.re.test(source)) found[pattern.key].push(path.relative(ROOT, file))
      }
    }
    return found
  })())
check('C8', '`ops.js` 的签发面走**管理员门**且**零落盘**（`issueFeicuiToken` 不含 `plan:`）',
  { adminGate: 1, planKeys: 0 },
  (() => {
    const opsSource = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'), 'utf8')
    const start = opsSource.indexOf('async issueFeicuiToken(')
    /* 切片止于**紧接其后的文档注释块**（`\n  /**`）—— 不含下一个 op 的 JSDoc（那里有 `plan:` 字样）。 */
    const end = opsSource.indexOf('\n  /**', start + 10)
    const body = start >= 0 && end > start ? opsSource.slice(start, end) : ''
    return { adminGate: (body.match(/adminWhitelistDenial\(/g) || []).length, planKeys: (body.match(/plan:\s*\{/g) || []).length }
  })())
check('C9', '`vercel.json` 的 catch-all 否定预查**仍排除 `api/`**（路由可达）', { excludesApi: true },
  { excludesApi: /\(\?!assets\/\|yinyuan\/\|xiai\/\|api\/\)/.test(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')) })
check('C10', '路由文件落点在 `api/feicui/v1/[...path].js`，且默认导出是函数（Vercel 可加载）',
  { exists: true, defaultIsFunction: typeof forward === 'function' },
  { exists: existsSync(path.join(ROOT, 'api/feicui/v1/[...path].js')), defaultIsFunction: typeof forward === 'function' })

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'qa-recheck' || entry === '.hermes') continue
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walk(full))
    else if (stat.isFile() && stat.size < 2_000_000) out.push(full)
  }
  return out
}

/* ---------------------------------------------------------------------------
   D. 回归
   --------------------------------------------------------------------------- */

console.log(JSON.stringify({ section: 'D', title: '回归：session-authority / userwrite-pa / endorsement / sidebar-nav' }))
const REGRESSIONS = [
  'verify-session-authority.mjs',
  'verify-userwrite-pa.mjs',
  'verify-endorsement.mjs',
  'verify-sidebar-nav.mjs'
]
for (const script of REGRESSIONS) {
  let summary = null
  let exitCode = 0
  try {
    const output = execFileSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024
    })
    const lines = output.trim().split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index])
        if (parsed && parsed.summary) {
          summary = parsed.summary
          break
        }
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
  } catch (error) {
    exitCode = error && typeof error.status === 'number' ? error.status : 1
  }
  check(`D-${script.replace('verify-', '').replace('.mjs', '')}`, `${script} 全绿（退出码 0，failed=0）`,
    { exitCode: 0, failed: 0 },
    { exitCode, failed: summary ? summary.failed : null })
  if (summary) console.log(JSON.stringify({ id: `${script}:summary`, total: summary.total, passed: summary.passed, failed: summary.failed }))
}

/* 收尾：关掉本机自起的服务。 */
await new Promise((resolve) => target.server.close(resolve))
await new Promise((resolve) => noKeyTarget.server.close(resolve))
await new Promise((resolve) => revokedTarget.server.close(resolve))
await new Promise((resolve) => limitedTarget.server.close(resolve))
await new Promise((resolve) => ttlTarget.server.close(resolve))
await new Promise((resolve) => upstreamServer.close(resolve))

/* ---------------------------------------------------------------------------
   汇总
   --------------------------------------------------------------------------- */

console.log(JSON.stringify({ summary: { total, passed, failed: total - passed }, sections: sectionStats, failed_ids: failedIds }))
console.log(JSON.stringify({ token_fingerprint: fingerprint(signed.token), token_length: signed.token.length, secrets_in_repo: 'runtime-random (no literals)' }))
if (total !== passed) process.exit(1)
