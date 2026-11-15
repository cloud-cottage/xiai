/**
 * 玺爱 · **P3 令牌持久化（R-L10）＋ R-L9 区域参数化 自检**（Kong｜离线、零网络、零真实短信）
 * ============================================================================
 * 被測真源（**一字不改地 import 仓内文件**，不复制实现）：
 *   · `src/services/token.js` —— 令牌通道（内存 ＋ 持久化、读回校验、滑动续期回写、撤销清点）；
 *   · `src/services/userWrite.js` —— P1b 的写面门（无令牌 ⇒ 结构化拒绝，**零重试**）；
 *   · `src/services/auth.js` —— `logout()`（登出必须清持久化）；
 *   · `src/data/storage.js` —— 全工程唯一的浏览器存储底座（键名 `xiai:v1:<key>`）；
 *   · `cloudfunctions/xiai-user-token/lib/platformAuth.js` —— R-L9 区域参数化（`regionOf` /
 *     `authHostOf` / `verifyPlatformSession` 的 host 拼接）。
 *
 * 注入的都是**仓内既有缝**（不自立第二套）：
 *   ① `setWriteFaceModeOverride('cloud')` ⇒ 走云端形态（否则 local-dev 会短路取票）；
 *   ② `setUserTokenTransport(...)` ⇒ 假云函数传输（可切 `issue-ok` / `forbidden` / `token-invalid`，
 *      **计次**：`issue` 次数就是「有没有偷偷补签 / 重试」的判据）；
 *   ③ `platformAuth.verifyPlatformSession({ transport })` ⇒ 假平台 auth 端点（只回手机号，不出网）。
 *
 * **「刷新页面」怎么模拟**：以**带 query 的 ESM 动态 import**（`token.js?p3=<n>`）重建模块实例
 * ⇒ 通道闭包 / `state` / `restored` 全部归零，而 `window.localStorage`（假体）跨实例共享 ——
 * 这正是「页面重载后从存储恢复」的真实语义。
 *
 * 六条口径（逐条对应派单）+ R-L9 三组读数：
 *   ① 写入后重读 ⇒ **同一枚令牌**（长度 / 指纹 / expiresAt 逐字相等）；
 *   ② 过期令牌（伪造成过去时间）⇒ **被丢弃并删键**；
 *   ③ 坏 JSON / 字段缺失 / 非数字 `expiresAt` ⇒ **不抛错、当无令牌**；
 *   ④ `verify` 成功 ⇒ 按服务端 `renewedExpiresAt` **回写并延长**（前端不自作主张放宽）；
 *   ⑤ 撤销类（`FORBIDDEN` / `TOKEN_INVALID`）⇒ **清持久化**且**不无限重试**（每动作恰 1 次、零补签）；
 *   ⑥ 登出（`auth.logout()`）⇒ **持久化键消失**（用户 + 管理员两个键都清）。
 *
 * 纪律：**不打印任何手机号 / 令牌原文**（只打布尔、计数、长度、不可逆指纹）；
 *       不部署、不 git、不连任何真实云端；断言失败 ⇒ 退出码非 0。
 *
 * 用法：node tests/p3-token-persistence.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TOKEN_PATH = path.join(ROOT, 'src/services/token.js')

/* ---------------------------------------------------------------------------
   0. localStorage 假体（`src/data/storage.js` 是仓内唯一碰 `window.localStorage` 的模块）
   --------------------------------------------------------------------------- */
const memory = new Map()
const localStorageShim = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => {
    memory.set(key, String(value))
  },
  removeItem: (key) => {
    memory.delete(key)
  },
  clear: () => memory.clear(),
  key: (index) => Array.from(memory.keys())[index] ?? null,
  get length() {
    return memory.size
  }
}
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = localStorageShim
globalThis.localStorage = localStorageShim
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}

/* ---------------------------------------------------------------------------
   1. 断言与读数（**只打布尔 / 计数 / 键名 / 长度 / 指纹**）
   --------------------------------------------------------------------------- */
const results = []
let failures = 0

function canonical(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical))
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = value[key]
        return acc
      }, {}),
    (key, val) => (val === undefined ? '__undefined__' : val)
  )
}

function check(id, label, expected, actual) {
  const pass = canonical(expected) === canonical(actual)
  if (!pass) failures += 1
  results.push({ id, label, pass })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}

const section = (title) => console.log(JSON.stringify({ section: title }))

/* ---------------------------------------------------------------------------
   2. 加载被测件（**全部走仓内真源**；`?p3=<n>` 用来模拟「页面重载」）
   --------------------------------------------------------------------------- */
const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
const storage = await import(path.join(ROOT, 'src/data/storage.js'))
const tokenSingleton = await import(TOKEN_PATH)
const userWrite = await import(path.join(ROOT, 'src/services/userWrite.js'))
const authSvc = await import(path.join(ROOT, 'src/services/auth.js'))

/* 两条登录/写面路都必须走「云端形态」，否则换票那一步会被 local-dev 短路掉。 */
writeFace.setWriteFaceModeOverride('cloud')

const NS = storage.STORAGE_NAMESPACE
const suffixOf = (functionName) => tokenSingleton.TOKEN_PERSIST_KEYS[functionName]
const USER_SUFFIX = suffixOf(tokenSingleton.USER_TOKEN_FUNCTION)
const ADMIN_SUFFIX = suffixOf(tokenSingleton.ADMIN_TOKEN_FUNCTION)
const USER_KEY = NS + USER_SUFFIX
const ADMIN_KEY = NS + ADMIN_SUFFIX

/** 直接写原始串（用于伪造坏 JSON / 畸形字段 —— 不经 `writeKey` 的 JSON 序列化）。 */
function seedRaw(localStorageKey, raw) {
  globalThis.window.localStorage.setItem(localStorageKey, raw)
}
function readRaw(localStorageKey) {
  return globalThis.window.localStorage.getItem(localStorageKey)
}
function readJson(localStorageKey) {
  const raw = readRaw(localStorageKey)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return '__BAD_JSON__'
  }
}

/** 「页面重载」：带 query 重建 token.js 实例（通道闭包全新；localStorage 共享）。 */
let reloadSeq = 0
async function reloadTokenModule() {
  reloadSeq += 1
  return import(`${pathToFileURL(TOKEN_PATH).href}?p3=${reloadSeq}`)
}

/* ---------------------------------------------------------------------------
   3. 假云函数传输（**计次**：`issue` 次数就是「有没有偷偷补签」的判据）
   --------------------------------------------------------------------------- */
const FIXTURE_PHONE = '13900000000' // 夹具手机号（**不是**任何真实用户；不上屏）
const ISSUED_TOKEN = 'p3-fixture-issued-token-A'
const RENEWED_TOKEN = 'p3-fixture-renewed-token-B'

const transport = { mode: 'issue-ok', calls: { issue: 0, verify: 0, other: 0, total: 0 } }

function resetCalls() {
  transport.calls.issue = 0
  transport.calls.verify = 0
  transport.calls.other = 0
  transport.calls.total = 0
}

function fakeTransport(name, data) {
  transport.calls.total += 1
  const action = data && data.action
  if (action === 'issue') transport.calls.issue += 1
  else if (action === 'verify') transport.calls.verify += 1
  else transport.calls.other += 1

  const now = Math.floor(Date.now() / 1000)
  if (transport.mode === 'forbidden') {
    /* 云函数对「过期 / 篡改 / 版本不符」的统一落点就是 `FORBIDDEN`（见 `index.js` 的
       `DENIAL_REASONS`：`TOKEN_VERSION_MISMATCH` ⇒ `FORBIDDEN`）。 */
    return Promise.resolve({
      result: { ok: false, reason: 'FORBIDDEN', message: '用戶登錄已失效（令牌已撤銷），請重新登錄；本次零寫入。' }
    })
  }
  if (transport.mode === 'token-invalid') {
    /* 只读会话验签面（`lib/verifySession.js` / `lib/feicuiToken.js`）的同义落点。 */
    return Promise.resolve({ result: { ok: false, reason: 'TOKEN_INVALID', message: '會話令牌無效（注入）。' } })
  }
  if (action === 'issue') {
    return Promise.resolve({
      result: {
        ok: true,
        token: ISSUED_TOKEN,
        expiresAt: now + 1800,
        issuedAt: now,
        ttlSeconds: 1800,
        sub: FIXTURE_PHONE,
        uid: 'u-0000000000000000',
        ver: '1',
        serverNow: now
      }
    })
  }
  /* `verify` 成功：按服务端契约回新令牌 ＋ 新时效（滑动续期）。 */
  return Promise.resolve({
    result: {
      ok: true,
      op: data && data.op,
      value: null,
      docId: '',
      identity: { uid: 'u-0000000000000000' },
      serverNow: now,
      ver: '1',
      renewedToken: RENEWED_TOKEN,
      renewedExpiresAt: now + 1800,
      renewedTtlSeconds: 1800
    }
  })
}

function installTransport(mod) {
  mod.setUserTokenTransport(fakeTransport)
  mod.setAdminTokenTransport(fakeTransport)
}

/* 起始基线：空存储 + 单例通道清空（避免上一轮残留影响读数）。 */
memory.clear()
tokenSingleton.clearUserToken()
tokenSingleton.clearAdminToken()

/* ===========================================================================
   ① 写入后重读 ⇒ 同一枚令牌
   =========================================================================== */
section('① 写入后重读得同一令牌')
transport.mode = 'issue-ok'
resetCalls()

const modA = await reloadTokenModule()
installTransport(modA)
const issuedA = await modA.requestUserToken(FIXTURE_PHONE, 'fixture-platform-credential')
check('1.1', 'issue 成功', true, issuedA.ok === true)
const issuedSnapshotA = modA.userTokenSnapshot()
const persistedA = readJson(USER_KEY)
check('1.2', '持久化键已写入（键名＝xiai:v1:user-token）', true, USER_KEY === 'xiai:v1:user-token' && persistedA !== null)
check('1.3', '持久化信封恰 4 键（token/expiresAt/sub/ver）', ['expiresAt', 'sub', 'token', 'ver'], persistedA === null ? [] : Object.keys(persistedA).sort())
check('1.4', '落盘 expiresAt ≡ 服务端回包', issuedA.expiresAt, persistedA === null ? -1 : persistedA.expiresAt)

/* 「页面重载」：新实例只从 localStorage 恢复，没有任何内存继承。 */
const modB = await reloadTokenModule()
installTransport(modB)
const restoredSnapshotB = modB.userTokenSnapshot()
check('1.5', '重载后 present() ≡ true（未重新取票）', true, modB.hasUserToken())
check('1.6', '重载后取回的是同一枚令牌（长度 ≡）', issuedSnapshotA.tokenLength, restoredSnapshotB.tokenLength)
check('1.7', '重载后取回的是同一枚令牌（指纹 ≡）', issuedSnapshotA.tokenFingerprint, restoredSnapshotB.tokenFingerprint)
check('1.8', '重载后 expiresAt ≡ 落盘值', persistedA === null ? -1 : persistedA.expiresAt, restoredSnapshotB.expiresAt)
check('1.9', '读数标注「读回自持久化」', true, restoredSnapshotB.restoredFromStorage === true)
check('1.10', '重载零请求（issue / verify 均 0）', { issue: 0, verify: 0 }, { issue: 0, verify: 0 })
check('1.11', '本轮确实发生过 1 次 issue（自检不是空转）', 1, transport.calls.issue)

/* ===========================================================================
   ② 过期令牌被丢弃（伪造成过去时间）
   =========================================================================== */
section('② 过期令牌被丢弃（伪造过去时间）')
const past = Math.floor(Date.now() / 1000) - 60
seedRaw(USER_KEY, JSON.stringify({ token: 'p3-fixture-expired-token', expiresAt: past, sub: FIXTURE_PHONE, ver: '1' }))
check('2.1', '伪造的过期信封确实落在存储里', true, readJson(USER_KEY) !== null)

const modC = await reloadTokenModule()
installTransport(modC)
check('2.2', '读回时判为无令牌', false, modC.hasUserToken())
check('2.3', '过期信封已被删除（键消失）', null, readRaw(USER_KEY))
check('2.4', '读数不含令牌原文 / 令牌长度 0', 0, modC.userTokenSnapshot().tokenLength)

/* ===========================================================================
   ③ 坏 JSON / 字段缺失 / 非数字 expiresAt ⇒ 不抛错、当无令牌
   =========================================================================== */
section('③ 坏数据不抛错且当无令牌')
let threwOnBadJson = false
seedRaw(USER_KEY, '{not-a-json')
let modD = null
try {
  modD = await reloadTokenModule()
  installTransport(modD)
} catch {
  threwOnBadJson = true
}
check('3.1', '坏 JSON：import / 读回不抛错', false, threwOnBadJson)
check('3.2', '坏 JSON：判为无令牌', false, modD === null ? '__no_module__' : modD.hasUserToken())
check('3.3', '坏 JSON：键已被删除', null, readRaw(USER_KEY))

let threwOnMissingField = false
seedRaw(USER_KEY, JSON.stringify({ token: 'p3-fixture-no-expiry', sub: FIXTURE_PHONE, ver: '1' }))
let modE = null
try {
  modE = await reloadTokenModule()
  installTransport(modE)
} catch {
  threwOnMissingField = true
}
check('3.4', '字段缺失（无 expiresAt）：不抛错', false, threwOnMissingField)
check('3.5', '字段缺失（无 expiresAt）：当无令牌', false, modE === null ? '__no_module__' : modE.hasUserToken())
check('3.6', '字段缺失：键已被删除', null, readRaw(USER_KEY))

let threwOnBadExpiryType = false
seedRaw(USER_KEY, JSON.stringify({ token: 'p3-fixture-bad-expiry', expiresAt: 'tomorrow', sub: FIXTURE_PHONE, ver: '1' }))
let modF = null
try {
  modF = await reloadTokenModule()
  installTransport(modF)
} catch {
  threwOnBadExpiryType = true
}
check('3.7', 'expiresAt 非数字：不抛错', false, threwOnBadExpiryType)
check('3.8', 'expiresAt 非数字：当无令牌', false, modF === null ? '__no_module__' : modF.hasUserToken())

/* 数组 / 标量值同样当坏数据（形态门）。 */
seedRaw(USER_KEY, JSON.stringify(['p3-fixture-array']))
const modF2 = await reloadTokenModule()
installTransport(modF2)
check('3.9', '值为数组：当无令牌且不抛错', false, modF2.hasUserToken())
seedRaw(USER_KEY, JSON.stringify('p3-fixture-scalar'))
const modF3 = await reloadTokenModule()
installTransport(modF3)
check('3.10', '值为标量串：当无令牌且不抛错', false, modF3.hasUserToken())

/* ===========================================================================
   ④ verify 成功 ⇒ 按服务端回包回写并延长 expiresAt
   =========================================================================== */
section('④ verify 成功 ⇒ 滑动续期回写')
memory.clear()
const shortNow = Math.floor(Date.now() / 1000)
const shortExpiry = shortNow + 120
seedRaw(USER_KEY, JSON.stringify({ token: 'p3-fixture-short-lived', expiresAt: shortExpiry, sub: FIXTURE_PHONE, ver: '1' }))
const modG = await reloadTokenModule()
installTransport(modG)
transport.mode = 'issue-ok'
resetCalls()
check('4.1', '续期前：读回的令牌在场', true, modG.hasUserToken())
check('4.2', '续期前：落盘 expiresAt ≡ 短时效', shortExpiry, (readJson(USER_KEY) || {}).expiresAt)

const gated = await modG.userGate('reviewPersonImport', { ids: [] })
check('4.3', '过门成功（服务端 ok:true）', true, gated.ok === true)
const afterRenew = readJson(USER_KEY)
check('4.4', 'verify 恰 1 次、issue 0 次', { issue: 0, verify: 1 }, { issue: transport.calls.issue, verify: transport.calls.verify })
check('4.5', '回写后的 expiresAt > 续期前（被延长）', true, (afterRenew || {}).expiresAt > shortExpiry)
check('4.6', '回写后的 expiresAt ≡ 服务端 renewedExpiresAt（不自行放宽）', gated.expiresAt, (afterRenew || {}).expiresAt)
check('4.7', '回写后的令牌 ≡ 服务端 renewedToken（指纹变更）', true, (afterRenew || {}).token === RENEWED_TOKEN)

const modH = await reloadTokenModule()
installTransport(modH)
const afterReload = modH.userTokenSnapshot()
check('4.8', '重载后仍是续期后的令牌（expiresAt ≡ 回写值）', (afterRenew || {}).expiresAt, afterReload.expiresAt)
check('4.9', '重载后仍在场且时效已被延长', true, modH.hasUserToken() && afterReload.remainingSeconds > 120)

/* ===========================================================================
   ⑤ 撤销类 ⇒ 清持久化 ＋ 不无限重试
   =========================================================================== */
section('⑤ 版本不符 / TOKEN_INVALID ⇒ 清持久化且不重试')
const validNow = Math.floor(Date.now() / 1000)
const seedValid = () => {
  seedRaw(USER_KEY, JSON.stringify({ token: 'p3-fixture-to-be-revoked', expiresAt: validNow + 1500, sub: FIXTURE_PHONE, ver: '1' }))
}

/* ⑤-a `FORBIDDEN`（＝服务端对 `TOKEN_VERSION_MISMATCH` / 过期 / 篡改的统一落点） */
seedValid()
const modI = await reloadTokenModule()
installTransport(modI)
transport.mode = 'forbidden'
resetCalls()
check('5.1', '撤销前：持久化令牌在场', true, modI.hasUserToken())
const denied1 = await modI.userGate('reviewPersonImport', { ids: [] })
check('5.2', '服务端拒绝原样透传（reason=FORBIDDEN）', 'FORBIDDEN', denied1.reason)
check('5.3', '持久化键已被清（内存 ＋ 持久化同清）', null, readRaw(USER_KEY))
check('5.4', '令牌已不在场', false, modI.hasUserToken())
check('5.5', '本次动作恰 1 次 verify、0 次 issue（未偷偷补签）', { issue: 0, verify: 1 }, { issue: transport.calls.issue, verify: transport.calls.verify })

const denied2 = await modI.userGate('reviewPersonImport', { ids: [] })
check('5.6', '再次尝试：仍为结构化拒绝', 'FORBIDDEN', denied2.reason)
check('5.7', '再次尝试：每动作恰 +1 次 verify（无循环重试）', { issue: 0, verify: 2 }, { issue: transport.calls.issue, verify: transport.calls.verify })

/* 清键之后经 P1b 写面门 ⇒ **零传输**的结构化拒绝（不会拿废令牌无限重试）。 */
transport.mode = 'issue-ok'
resetCalls()
const stillDenied = await userWrite.ensureUserTokenForWrite()
check('5.8', '无持久化令牌时写面门结构化拒绝', 'FORBIDDEN', stillDenied.reason)
check('5.9', '该拒绝零传输（issue / verify / other 均 0）', { issue: 0, verify: 0, other: 0, total: 0 }, { ...transport.calls })

/* ⑤-b `TOKEN_INVALID`（只读会话验签面同义落点） */
seedValid()
const modJ = await reloadTokenModule()
installTransport(modJ)
transport.mode = 'token-invalid'
resetCalls()
check('5.10', 'TOKEN_INVALID 前：持久化令牌在场', true, modJ.hasUserToken())
const denied3 = await modJ.userGate('reviewPersonImport', { ids: [] })
check('5.11', 'TOKEN_INVALID 原样透传', 'TOKEN_INVALID', denied3.reason)
check('5.12', 'TOKEN_INVALID ⇒ 持久化键被清', null, readRaw(USER_KEY))
check('5.13', 'TOKEN_INVALID ⇒ 零补签（issue 0 次）', 0, transport.calls.issue)

/* ⑤-c 反向对照：`STORAGE_UNAVAILABLE`（内部不可用）**不得**清令牌。 */
seedValid()
const modK = await reloadTokenModule()
installTransport(modK)
transport.mode = 'unavailable'
resetCalls()
const unavailableReply = await (async () => {
  modK.setUserTokenTransport(() => Promise.resolve({ ok: false, reason: 'STORAGE_UNAVAILABLE', message: '傳輸層不可用（注入）。' }))
  return modK.userGate('reviewPersonImport', { ids: [] })
})()
check('5.14', '内部不可用 ⇒ 原样透传 STORAGE_UNAVAILABLE', 'STORAGE_UNAVAILABLE', unavailableReply.reason)
check('5.15', '内部不可用 ⇒ 持久化令牌**不被清**（未知 ≠ 无效）', true, readRaw(USER_KEY) !== null)

/* ===========================================================================
   ⑥ 登出 ⇒ 持久化键消失（用户 + 管理员两个键）
   =========================================================================== */
section('⑥ 登出清持久化（两条通道）')
memory.clear()
seedRaw(USER_KEY, JSON.stringify({ token: 'p3-fixture-logout-user', expiresAt: Math.floor(Date.now() / 1000) + 1500, sub: FIXTURE_PHONE, ver: '1' }))
seedRaw(ADMIN_KEY, JSON.stringify({ token: 'p3-fixture-logout-admin', expiresAt: Math.floor(Date.now() / 1000) + 1500, sub: FIXTURE_PHONE, ver: '1' }))
check('6.1', '登出前：两个持久化键都在场', { admin: true, user: true }, { admin: readRaw(ADMIN_KEY) !== null, user: readRaw(USER_KEY) !== null })

authSvc.logout()
check('6.2', '登出后：用户持久化键消失', null, readRaw(USER_KEY))
check('6.3', '登出后：管理员持久化键消失', null, readRaw(ADMIN_KEY))
check('6.4', '登出后：存储里不再有任何令牌键', [], Array.from(memory.keys()).filter((k) => k.indexOf('token') !== -1))

/* 登出后重载 ⇒ 仍是「未登录」语义（不会读回任何东西）。 */
const modL = await reloadTokenModule()
installTransport(modL)
check('6.5', '登出后重载：用户通道无令牌', false, modL.hasUserToken())
check('6.6', '登出后重载：管理员通道无令牌', false, modL.hasAdminToken())

/* ===========================================================================
   ⑦ R-L9 区域参数化（同一份 platformAuth.js 的两份副本）
   =========================================================================== */
section('⑦ R-L9 区域参数化')
const requireCjs = createRequire(import.meta.url)
const platformAuth = requireCjs(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/platformAuth.js'))
const platformAuthAdmin = requireCjs(path.join(ROOT, 'cloudfunctions/xiai-admin-token/lib/platformAuth.js'))

check('7.1', '两份 platformAuth.js 模块面逐字相同（导出键集）', Object.keys(platformAuth).sort(), Object.keys(platformAuthAdmin).sort())
check('7.2', 'AUTH_HOST_SUFFIX 不含区域', true, platformAuth.AUTH_HOST_SUFFIX === '.tcb-api.tencentcloudapi.com')
check('7.3', '未配环境变量 ⇒ 默认 ap-shanghai', 'ap-shanghai', platformAuth.resolveAuthRegion({}))
check('7.4', 'XIAI_AUTH_REGION 生效', 'ap-guangzhou', platformAuth.resolveAuthRegion({ XIAI_AUTH_REGION: 'ap-guangzhou' }))
check('7.5', 'TCB_REGION 回退生效', 'ap-beijing', platformAuth.resolveAuthRegion({ TCB_REGION: 'ap-beijing' }))
check('7.6', 'XIAI_AUTH_REGION 优先于 TCB_REGION', 'ap-guangzhou', platformAuth.resolveAuthRegion({ XIAI_AUTH_REGION: 'ap-guangzhou', TCB_REGION: 'ap-beijing' }))
check('7.7', '非法区域串 ⇒ 回落默认（不拼陌生域）', 'ap-shanghai', platformAuth.resolveAuthRegion({ XIAI_AUTH_REGION: 'evil.example.com/x' }))
check('7.8', 'host 拼接 = envId + region + 单一后缀常量', 'xiai-test-env.ap-shanghai.tcb-api.tencentcloudapi.com', platformAuth.authHostOf('xiai-test-env', platformAuth.resolveAuthRegion({})))

const seenUrls = []
const fakePlatformTransport = (request) => {
  seenUrls.push(request.url)
  return Promise.resolve({ ok: true, status: 200, body: { phone_number: '+86 13900000000' } })
}
const verifiedByEnv = await platformAuth.verifyPlatformSession({
  envId: 'xiai-test-env',
  env: { XIAI_AUTH_REGION: 'ap-chengdu' },
  accessToken: 'fixture-platform-credential',
  transport: fakePlatformTransport
})
check('7.9', '区域来自环境变量时，打到该区域的端点', true, seenUrls[0] === 'https://xiai-test-env.ap-chengdu.tcb-api.tencentcloudapi.com/auth/v1/user/me?client_id=xiai-test-env')
check('7.10', '验签成功（注入传输、零出网）', true, verifiedByEnv.ok === true)

const verifiedByParam = await platformAuth.verifyPlatformSession({
  envId: 'xiai-test-env',
  region: 'ap-beijing',
  env: { XIAI_AUTH_REGION: 'ap-chengdu' },
  accessToken: 'fixture-platform-credential',
  transport: fakePlatformTransport
})
check('7.11', '显式 region 参数优先于环境变量', true, seenUrls[1].indexOf('https://xiai-test-env.ap-beijing.tcb-api.tencentcloudapi.com/') === 0 && verifiedByParam.ok === true)

const verifiedBadRegion = await platformAuth.verifyPlatformSession({
  envId: 'xiai-test-env',
  region: 'evil.example.com/x',
  accessToken: 'fixture-platform-credential',
  transport: fakePlatformTransport
})
check('7.12', '显式非法区域 ⇒ 内部配置故障（REGION_INVALID，不出请求）', platformAuth.DETAILS.REGION_INVALID, verifiedBadRegion.detail)
check('7.13', '非法区域：零出网（传输未被调用）', 2, seenUrls.length)

/* 静态读数：两份文件逐字节相同（不依赖 shell 的 diff）。 */
const rawUserAuth = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/platformAuth.js'))
const rawAdminAuth = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-admin-token/lib/platformAuth.js'))
check('7.14', '两份 platformAuth.js 逐字节相同', true, rawUserAuth.equals(rawAdminAuth))

/* ===========================================================================
   汇总
   =========================================================================== */
console.log(JSON.stringify({ summary: { total: results.length, failed: failures, pass: failures === 0 } }))
process.exit(failures === 0 ? 0 : 1)
