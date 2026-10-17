#!/usr/bin/env node
/**
 * 玺爱 · **斐萃（feicui）换身份 · 一次性授权码** 离线自检（本单新增）
 * ============================================================================
 * **本地、离线、零网络、零凭据**：注入假 DB ＋ 假时钟，把「云函数 op」与「Vercel 路由」
 * 两段真源直接跑起来（**不以读代码推断充当证据**）。
 *
 * 跑什么（逐条对应契约）：
 *   A. **码面**（`cloudfunctions/xiai-user-token/lib/feicuiCode.js`）：
 *      字母表剔除 `0/O/1/I`、长度 6、生成 2000 枚全部合形、大小写归一、行形 + TTL 600 s；
 *   B. **op 面**（`lib/ops.js::OPS.issueFeicuiCode`）：
 *      会话身份（`SESSION`）⇒ 发码且**回包无 uid / 无 role**；令牌路（`SERVER_TOKEN`）⇒ `FORBIDDEN`；
 *      匿名 ⇒ `FORBIDDEN`；载荷含身份键 / 形态不对 ⇒ `INVALID_FIELD`；**零写入**（拒绝时库行数不变）；
 *      成功后的落盘计划经 `persist()` 真实写进假 DB（行形 7 键）；
 *   C. **路由面**（`api/auth/feicui-exchange.js`）：
 *      有效码 ⇒ `200 {ok:true, uid, role}`（且**只有这 3 个键**）；重放同一码 ⇒ `CODE_INVALID`；
 *      过期 ⇒ `CODE_INVALID`；未知码 ⇒ `CODE_INVALID`；**并发双花 ⇒ 恰一个成功**；
 *      限流 ⇒ 第 N+1 次 `429 RATE_LIMITED`（同 IP），换 IP 不受影响（未触全局）；方法面 ⇒ `405`；
 *      缺凭据 ⇒ `503 CONFIG_MISSING`；小写 / 首尾空白码 ⇒ 成功；坏包体 ⇒ `CODE_INVALID`；
 *   D. **静态门**：`index.js` 仍零 SDK 字面；`feicuiCode.js` 零 SDK 零 `collection(`；
 *      前端 op 名 / 路由路径与云函数 / `api/` 目录逐字一致；侧边栏仍**恰四项**；无 `/admin` 路由；
 *      `configStatus()` 只回布尔（**不泄漏凭据值**）。
 *
 * 纪律：**不打印任何凭据 / 码以外的敏感值**；断言失败 ⇒ 退出码非 0。
 *
 * 用法：`node scripts/verify-feicui-exchange.mjs`
 */

import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const opsModule = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))
const feicuiCode = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/feicuiCode.js'))
const routeModule = await import(path.join(ROOT, 'api/auth/feicui-exchange.js'))

let passed = 0
const failures = []
function check(id, title, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed += 1
    console.log(`  ✔ ${id} ${title}`)
  } else {
    failures.push({ id, title, actual, expected })
    console.log(`  ✘ ${id} ${title}\n      预期 ${JSON.stringify(expected)}\n      实测 ${JSON.stringify(actual)}`)
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`)
}

/* ---------------------------------------------------------------------------
   假 DB（云数据库最小面：`collection().where().get() / .update() / doc().get()`）
   `where().update()` 在**调用即求值**（同步原子）⇒ 与真实云数据库「条件更新原子命中」
   同一语义；这正是本设计防双花所依赖的那一条原语。
   --------------------------------------------------------------------------- */
function matches(doc, match) {
  for (const key of Object.keys(match || {})) {
    const want = match[key]
    const have = doc[key]
    if (want === null) {
      if (have !== null && have !== undefined) return false
      continue
    }
    if (have !== want) return false
  }
  return true
}

function createFakeDb(seedRows) {
  const docs = new Map()
  for (const row of seedRows || []) docs.set(row._id, { ...row })
  const stats = { adds: 0, updates: 0, updateCalls: 0 }
  function collection() {
    return {
      where(match) {
        return {
          async get() {
            const rows = []
            for (const row of docs.values()) if (matches(row, match)) rows.push({ ...row })
            return { data: rows }
          },
          update(patch) {
            stats.updateCalls += 1
            let updated = 0
            for (const row of docs.values()) {
              if (!matches(row, match)) continue
              Object.assign(row, patch)
              updated += 1
            }
            stats.updates += updated
            return Promise.resolve({ updated })
          }
        }
      },
      doc(id) {
        return {
          async get() {
            return { data: docs.has(id) ? [{ ...docs.get(id) }] : [] }
          },
          async set(doc) {
            docs.set(id, { ...doc })
            stats.adds += 1
            return { id }
          },
          async update(patch) {
            stats.updateCalls += 1
            if (!docs.has(id)) return { updated: 0 }
            Object.assign(docs.get(id), patch)
            stats.updates += 1
            return { updated: 1 }
          }
        }
      }
    }
  }
  return { docs, stats, collection }
}

/** 造一个假 `res`（Vercel 风格：`statusCode` + `setHeader` + `end`）。 */
function createFakeRes() {
  const out = { statusCode: 0, headers: {}, body: null }
  out.setHeader = (key, value) => {
    out.headers[String(key).toLowerCase()] = value
  }
  out.end = (payload) => {
    out.body = payload === undefined ? null : JSON.parse(payload)
  }
  return out
}

async function call(handler, req) {
  const res = createFakeRes()
  await handler(req, res)
  return res
}

function postReq(code, ip) {
  return { method: 'POST', headers: { 'x-forwarded-for': ip || '203.0.113.7', 'user-agent': 'verify-script' }, body: { code } }
}

/* =========================================================================
   A. 码面
   ========================================================================= */
section('A 碼面（lib/feicuiCode.js）')
const alphabet = feicuiCode.CODE_ALPHABET
check('A1a', '字母表长度 32', alphabet.length, 32)
check('A1b', '剔除易混淆字符 0/O/1/I', ['0', 'O', '1', 'I'].filter((c) => alphabet.includes(c)), [])
check('A2', '码长 6', feicuiCode.CODE_LENGTH, 6)

let formatBad = 0
const seen = new Set()
for (let i = 0; i < 2000; i += 1) {
  const code = feicuiCode.generateCode()
  if (!feicuiCode.CODE_PATTERN.test(code)) formatBad += 1
  seen.add(code)
}
check('A3a', '生成 2000 枚全部合形（6 位、仅字母表内字符）', formatBad, 0)
check('A3b', '2000 枚无重复（随机面正常）', seen.size, 2000)

check('A4a', '归一：小写 + 首尾空白 ⇒ 大写原码', feicuiCode.normalizeCode('  ab2cd3 '), 'AB2CD3')
check('A4b', '归一：含 0/O/1/I ⇒ 空串', [feicuiCode.normalizeCode('AB0CD3'), feicuiCode.normalizeCode('ABOCD3'), feicuiCode.normalizeCode('AB1CD3')], ['', '', ''])
check('A4c', '归一：长度不足 / 空 / 非串 ⇒ 空串', [feicuiCode.normalizeCode('AB2CD'), feicuiCode.normalizeCode(''), feicuiCode.normalizeCode(null)], ['', '', ''])

const T0 = Date.parse('2026-10-17T02:00:00.000Z')
const sampleRow = feicuiCode.buildRow({ code: 'AB2CD3', uid: 'u-0123456789abcdef', role: 'user', nowMs: T0 })
check('A5a', '行形恰 7 键（_id/uid/role/issued_at/expires_at/used_at/used_by）', Object.keys(sampleRow).sort(), ['_id', 'expires_at', 'issued_at', 'role', 'uid', 'used_at', 'used_by'])
check('A5b', 'TTL = 600 s（默认）', Date.parse(sampleRow.expires_at) - Date.parse(sampleRow.issued_at), 600000)
check('A5c', 'used_at / used_by 初值 null', [sampleRow.used_at, sampleRow.used_by], [null, null])
check('A5d', '时戳为 ISO 8601（UTC, Z）', /Z$/.test(sampleRow.issued_at) && /Z$/.test(sampleRow.expires_at), true)

/* =========================================================================
   B. op 面（云函数 issueFeicuiCode）
   ========================================================================= */
section('B op 面（OPS.issueFeicuiCode）')
const db = createFakeDb()
opsModule.setOpsDbProvider(() => db)
const OPS = opsModule.OPS
check('B0', 'op 已注册在用户写面 OPS（不在 ADMIN_OPS）', [typeof OPS.issueFeicuiCode, typeof opsModule.ADMIN_OPS.issueFeicuiCode], ['function', 'undefined'])
check('B0b', 'op 名逐字 `issueFeicuiCode`', Object.prototype.hasOwnProperty.call(OPS, 'issueFeicuiCode'), true)

const sessionIdentity = Object.freeze({ uid: 'u-0123456789abcdef', phone: '', role: 'user', identity_source: 'SESSION' })
const issued = await OPS.issueFeicuiCode({}, sessionIdentity)
check('B1a', '会话身份 ⇒ 发码成功', issued.ok, true)
check('B1b', '回包 row 恰 4 键（code/issued_at/expires_at/ttl_seconds）', Object.keys(issued.row || {}).sort(), ['code', 'expires_at', 'issued_at', 'ttl_seconds'])
check('B1c', '回包**不含** uid / role / token', ['uid', 'role', 'token'].filter((k) => Object.prototype.hasOwnProperty.call(issued.row || {}, k)), [])
check('B1d', '码形合规', feicuiCode.CODE_PATTERN.test(issued.row.code), true)
check('B1e', 'TTL 读数 600', issued.row.ttl_seconds, 600)
check('B1f', '落盘计划：单步 set 到 xiai_feicui_codes', [issued.plan.writes.length, issued.plan.writes[0].kind, issued.plan.writes[0].collection], [1, 'set', 'xiai_feicui_codes'])
check('B1g', '落盘行含服务端派生 uid 且零手机号', [issued.plan.writes[0].doc.uid, Object.prototype.hasOwnProperty.call(issued.plan.writes[0].doc, 'phone')], ['u-0123456789abcdef', false])

const beforeDeny = db.docs.size
const tokenFaceIdentity = Object.freeze({ uid: 'u-0123456789abcdef', phone: '13800000000', role: 'user', identity_source: 'SERVER_TOKEN' })
const deniedToken = await OPS.issueFeicuiCode({}, tokenFaceIdentity)
check('B2a', '令牌路身份（SERVER_TOKEN）⇒ FORBIDDEN', [deniedToken.ok, deniedToken.reason], [false, 'FORBIDDEN'])
check('B2b', 'B2a 零写入（库行数不变）', db.docs.size, beforeDeny)

const deniedAnon = await OPS.issueFeicuiCode({}, null)
check('B3', '匿名（无身份）⇒ FORBIDDEN', [deniedAnon.ok, deniedAnon.reason], [false, 'FORBIDDEN'])

const deniedUidInPayload = await OPS.issueFeicuiCode({ uid: 'u-deadbeefdeadbeef' }, sessionIdentity)
check('B4a', '载荷带身份键 ⇒ INVALID_FIELD', [deniedUidInPayload.ok, deniedUidInPayload.reason], [false, 'INVALID_FIELD'])
const deniedShape = await OPS.issueFeicuiCode(['x'], sessionIdentity)
check('B4b', '载荷形态不对（数组）⇒ INVALID_FIELD', [deniedShape.ok, deniedShape.reason], [false, 'INVALID_FIELD'])
check('B4c', 'B4 全部零写入', db.docs.size, beforeDeny)

const persistedId = await opsModule.persist(issued.plan)
check('B5a', 'persist 真实落盘（文档键 ＝ 码）', [persistedId, db.docs.has(issued.row.code)], [issued.row.code, true])
const persistedRow = db.docs.get(issued.row.code)
check('B5b', '落盘行 7 键且 uid/role/used_at 正确', [Object.keys(persistedRow).sort(), persistedRow.uid, persistedRow.role, persistedRow.used_at], [['_id', 'expires_at', 'issued_at', 'role', 'uid', 'used_at', 'used_by'], 'u-0123456789abcdef', 'user', null])

/* =========================================================================
   C. 路由面（api/auth/feicui-exchange.js）
   ========================================================================= */
section('C 路由面（POST /api/auth/feicui-exchange）')
let clock = Date.now()
const routeDb = createFakeDb([...db.docs.values()])
const handler = routeModule.createExchangeHandler({
  getDb: async () => routeDb,
  now: () => clock,
  limiter: routeModule.createRateLimiter({ perIpMax: 100, globalMax: 1000 })
})

const okRes = await call(handler, postReq(issued.row.code))
check('C1a', '有效码 ⇒ 200', okRes.statusCode, 200)
check('C1b', '回包恰 3 键且 ok:true', [Object.keys(okRes.body).sort(), okRes.body.ok], [['ok', 'role', 'uid'], true])
check('C1c', 'uid / role 与签发时一致', [okRes.body.uid, okRes.body.role], ['u-0123456789abcdef', 'user'])
check('C1d', '回包不含 code / phone / token', ['code', 'phone', 'phoneFingerprint', 'token'].filter((k) => Object.prototype.hasOwnProperty.call(okRes.body, k)), [])
check('C1e', '`Cache-Control: no-store`（失败面同样）', okRes.headers['cache-control'], 'no-store')
const usedRow = routeDb.docs.get(issued.row.code)
check('C1f', '行被核销：used_at 非空、used_by 为指纹', [typeof usedRow.used_at, String(usedRow.used_by).startsWith('fb-')], ['string', true])

const replayRes = await call(handler, postReq(issued.row.code))
check('C2', '同一码重放 ⇒ 400 CODE_INVALID', [replayRes.statusCode, replayRes.body.reason, replayRes.body.uid], [400, 'CODE_INVALID', undefined])

const second = await OPS.issueFeicuiCode({}, sessionIdentity)
routeDb.docs.set(second.row.code, { ...second.plan.writes[0].doc })
clock = Date.parse(second.row.expires_at) + 1000
const expiredRes = await call(handler, postReq(second.row.code))
check('C3', '过期码 ⇒ 400 CODE_INVALID（不给「存在但过期」信号）', [expiredRes.statusCode, expiredRes.body.reason], [400, 'CODE_INVALID'])
clock = Date.now()

const unknownRes = await call(handler, postReq('ZZZZZZ'))
check('C4', '不存在的码 ⇒ 400 CODE_INVALID', [unknownRes.statusCode, unknownRes.body.reason], [400, 'CODE_INVALID'])

const fourth = await OPS.issueFeicuiCode({}, sessionIdentity)
routeDb.docs.set(fourth.row.code, { ...fourth.plan.writes[0].doc })
const lowerRes = await call(handler, {
  method: 'POST',
  headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'verify-script' },
  body: JSON.stringify({ code: `  ${fourth.row.code.toLowerCase()}  ` })
})
check('C5', '小写 + 首尾空白码（串体）⇒ 归一后成功', [lowerRes.statusCode, lowerRes.body.ok], [200, true])

const badBodyRes = await call(handler, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.7' }, body: '{not json' })
check('C6a', '非 JSON 串体 ⇒ CODE_INVALID', [badBodyRes.statusCode, badBodyRes.body.reason], [400, 'CODE_INVALID'])
const numericCodeRes = await call(handler, postReq(123456))
check('C6b', '非串码（数字）⇒ CODE_INVALID', [numericCodeRes.statusCode, numericCodeRes.body.reason], [400, 'CODE_INVALID'])
const emptyBodyRes = await call(handler, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.7' } })
check('C6c', '空体 ⇒ CODE_INVALID', [emptyBodyRes.statusCode, emptyBodyRes.body.reason], [400, 'CODE_INVALID'])

/* --- 并发双花：两个请求同时争同一码，只允许一个成功 ------------------------- */
const third = await OPS.issueFeicuiCode({}, sessionIdentity)
routeDb.docs.set(third.row.code, { ...third.plan.writes[0].doc })
const racerA = routeModule.createExchangeHandler({
  getDb: async () => routeDb,
  now: () => clock,
  limiter: routeModule.createRateLimiter({ perIpMax: 100, globalMax: 1000 })
})
const racerB = routeModule.createExchangeHandler({
  getDb: async () => routeDb,
  now: () => clock,
  limiter: routeModule.createRateLimiter({ perIpMax: 100, globalMax: 1000 })
})
const [raceA, raceB] = await Promise.all([call(racerA, postReq(third.row.code)), call(racerB, postReq(third.row.code))])
const winners = [raceA, raceB].filter((res) => res.statusCode === 200 && res.body && res.body.ok === true).length
const losers = [raceA, raceB].filter((res) => res.statusCode === 400 && res.body && res.body.reason === 'CODE_INVALID').length
check('C7a', '并发双花：**恰一个成功**（winners=1）', winners, 1)
check('C7b', '并发双花：另一个必为 CODE_INVALID（losers=1）', losers, 1)
check('C7c', '并发后行 used_at 只有一次写入值', typeof routeDb.docs.get(third.row.code).used_at, 'string')

/* --- 限流 ---------------------------------------------------------------- */
const tightHandler = routeModule.createExchangeHandler({
  getDb: async () => routeDb,
  now: () => clock,
  limiter: routeModule.createRateLimiter({ perIpMax: 3, globalMax: 1000 })
})
const burst = []
for (let i = 0; i < 4; i += 1) burst.push(await call(tightHandler, postReq('PPPPPP', '198.51.100.9')))
check('C8a', '同 IP 前 3 次进业务（不受限流拦截）', burst.slice(0, 3).map((r) => r.statusCode), [400, 400, 400])
check('C8b', '第 4 次 ⇒ 429 RATE_LIMITED', [burst[3].statusCode, burst[3].body.reason], [429, 'RATE_LIMITED'])
check('C8c', '带 Retry-After（秒）', typeof burst[3].headers['retry-after'], 'string')
const otherIpRes = await call(tightHandler, postReq('PPPPPP', '198.51.100.10'))
check('C8d', '换 IP 不受该 IP 窗口影响（仍进业务）', otherIpRes.statusCode, 400)

const globalLimited = routeModule.createExchangeHandler({
  getDb: async () => routeDb,
  now: () => clock,
  limiter: routeModule.createRateLimiter({ perIpMax: 100, globalMax: 2 })
})
await call(globalLimited, postReq('PPPPPP', '198.51.100.21'))
await call(globalLimited, postReq('PPPPPP', '198.51.100.22'))
const globalRes = await call(globalLimited, postReq('PPPPPP', '198.51.100.23'))
check('C9', '全局窗口打满 ⇒ 429（换 IP 也挡）', [globalRes.statusCode, globalRes.body.reason], [429, 'RATE_LIMITED'])

/* --- 缺凭据 / 方法面 ------------------------------------------------------ */
const noCredHandler = routeModule.createExchangeHandler({
  getDb: async () => null,
  now: () => clock,
  limiter: routeModule.createRateLimiter({ perIpMax: 100, globalMax: 1000 })
})
const noCredRes = await call(noCredHandler, postReq('PPPPPP', '198.51.100.31'))
check('C10', '缺 CloudBase 凭据 ⇒ 503 CONFIG_MISSING（绝不降级放行）', [noCredRes.statusCode, noCredRes.body.reason], [503, 'CONFIG_MISSING'])

const getRes = await call(handler, { method: 'GET', headers: { 'x-forwarded-for': '198.51.100.41' } })
check('C11', '非 POST ⇒ 405 且 `Allow: POST`', [getRes.statusCode, getRes.body.reason, getRes.headers.allow], [405, 'METHOD_NOT_ALLOWED', 'POST'])

const ttlOf = routeModule.DEFAULT_TTL_SECONDS || 600
check('C12', '路由与云函数 TTL 同值（600 s）', [ttlOf, feicuiCode.DEFAULT_TTL_SECONDS], [600, 600])
check('C13', '路由码正则与云函数同一真源（同一实例）', routeModule.normalizeCode('ab2cd3'), 'AB2CD3')

/* =========================================================================
   D. 静态门
   ========================================================================= */
section('D 靜態門（紀律機械斷言）')
const fnIndex = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/index.js'), 'utf8')
const codeLib = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/feicuiCode.js'), 'utf8')
const routeSrc = readFileSync(path.join(ROOT, 'api/auth/feicui-exchange.js'), 'utf8')
const serviceSrc = readFileSync(path.join(ROOT, 'src/services/feicui.js'), 'utf8')
const routerSrc = readFileSync(path.join(ROOT, 'src/router/index.js'), 'utf8')
const sidebarSrc = readFileSync(path.join(ROOT, 'src/components/AppSidebar.vue'), 'utf8')

check('D1', '`index.js` 仍零 `@cloudbase/node-sdk` 字面', fnIndex.includes('@cloudbase/node-sdk'), false)
check('D2a', '`lib/feicuiCode.js` 零 SDK 字面', codeLib.includes('@cloudbase'), false)
check('D2b', '`lib/feicuiCode.js` 零 `collection(`（不是落点）', /collection\s*\(/.test(codeLib), false)
check('D3a', '服务层 op 名与云函数注册键逐字一致', [serviceSrc.includes("FEICUI_ISSUE_OP = 'issueFeicuiCode'"), Object.prototype.hasOwnProperty.call(OPS, 'issueFeicuiCode')], [true, true])
check('D3b', '服务层核销路径 ＝ 实际文件路径', [routeModule && existsSync(path.join(ROOT, 'api/auth/feicui-exchange.js')), serviceSrc.includes("FEICUI_EXCHANGE_PATH = '/api/auth/feicui-exchange'")], [true, true])
check('D3c', '集合名在云函数与路由侧逐字一致', [opsModule.COLLECTIONS.feicuiCodes, routeModule.COLLECTION_CODES], ['xiai_feicui_codes', 'xiai_feicui_codes'])
check('D4a', '路由新增 `/connect`（本单入口）', /path: '\/connect'/.test(routerSrc), true)
check('D4b', '无任何 `/admin` 路由', /path: '\/admin/.test(routerSrc), false)
check('D5', '侧边栏仍**恰四项**（本单不动侧边栏）', (sidebarSrc.match(/glyph: '/g) || []).length, 4)
check('D6a', '`configStatus()` 只回布尔（零值回显）', Object.values(routeModule.configStatus({})).every((v) => typeof v === 'boolean'), true)
check('D6b', '源码不含任何 `AKID` 形态密钥字面', /AKID[A-Za-z0-9]{6,}/.test(routeSrc) || /AKID[A-Za-z0-9]{6,}/.test(serviceSrc), false)
check('D7', '路由只作核销（`collection(...)` + `where/update`，无 `.add(` 建行）', routeSrc.includes('db.collection(collection)') && !routeSrc.includes('.add('), true)

/* =========================================================================
   汇总
   ========================================================================= */
console.log(`\n通過 ${passed} 條；失敗 ${failures.length} 條`)
if (failures.length > 0) {
  console.log(JSON.stringify({ failures }, null, 2))
  process.exit(1)
}
console.log(
  JSON.stringify({
    ok: true,
    checks: passed,
    op: 'issueFeicuiCode',
    route: '/api/auth/feicui-exchange',
    collection: opsModule.COLLECTIONS.feicuiCodes,
    ttlSeconds: feicuiCode.DEFAULT_TTL_SECONDS,
    codeAlphabet: feicuiCode.CODE_ALPHABET,
    codeLength: feicuiCode.CODE_LENGTH
  })
)
