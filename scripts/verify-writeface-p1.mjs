/**
 * 玺爱 · 写面 Phase 1 自检（**本地、离线、零网络**）
 * ----------------------------------------------------------------------------
 * 跑什么：
 *   A. **云函数本体**（`cloudfunctions/xiai-admin-token`）：签发 / 校验的全部判定分支
 *      （成功 ＋ 六种拒绝 ＋ 配置缺失），并**机械断言失败形状恒为恰 3 键 `{ok, reason, message}`**
 *      且 `reason` ∈ 既有冻结表；另做一次**静态扫描**证明该函数**不含任何持久化写入**（⇒ 负向天然零写入）。
 *   B. **客户端管道 ＋ 垂直切片**（`src/services/adminToken.js` / `src/services/admin.js` /
 *      `src/data/writeFaceMode.js`）：以**注入了真实函数体**的传输实现跑端到端
 *      （签发 → 携带 → 校验通过 → 落盘），并跑四条负向 ＋ 一条「传输失败不得伪装 FORBIDDEN」。
 *   C. **降级机制读数**：`localWriteRegistry()` 的 24 条清单（8 ＋ 6 ＋ 10）与两种形态下的门读数。
 *
 * 纪律：
 *   · **不打印任何密钥 / 令牌原文**（只打长度与指纹）；
 *   · **零网络**（传输注入 ＋ 本地函数调用）；**不碰任何服务**；
 *   · 任何一条断言失败 ⇒ 退出码非 0（失败即终止）。
 *
 * 用法（密钥 / 手机号 / 验证码从**环境变量**传入，绝不落在命令行历史里的字面值中）：
 *   XIAI_ADMIN_PHONE=… XIAI_ADMIN_SMS_CODE=… XIAI_ADMIN_TOKEN_SECRET=… \
 *     node scripts/verify-writeface-p1.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
   0. localStorage 假体（**只为让数据层在本机 Node 下跑起来**；不碰真实浏览器存储）
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
  clear: () => memory.clear()
}
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = localStorageShim

/* ---------------------------------------------------------------------------
   1. 断言与读数收集
   --------------------------------------------------------------------------- */
const results = []
let failures = 0

function check(id, label, expected, actual) {
  const pass = canonical(expected) === canonical(actual)
  if (!pass) failures += 1
  results.push({ id, label, pass, expected, actual })
  console.log(
    JSON.stringify({ id, case: label, pass, expected, actual }, null, 0)
  )
}

/** 规范化（**忽略对象键序** ⇒ 断言只比语义，不比插入顺序）。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 令牌**指纹**（只用于读数；**永不打印原文**）。 */
function fingerprint(value) {
  let hash = 0x811c9dc5
  const text = String(value)
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 失败形状机械断言：恰 3 键、`reason` ∈ 既有冻结表。 */
const FROZEN_REASONS = [
  'FORBIDDEN',
  'INVALID_FIELD',
  'INVALID_VALUE',
  'MISSING_REQUIRED',
  'UNRECOGNIZED_IMAGE',
  'NOT_IMAGE',
  'TOO_LARGE',
  'ARTIFACT_TOO_LARGE',
  'STORAGE_UNAVAILABLE',
  'EMPTY_CONTENT'
]
function failureShape(value) {
  if (!value || typeof value !== 'object' || value.ok !== false) return 'NOT_A_DENIAL'
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'message,ok,reason') return `KEYS:${keys}`
  if (!FROZEN_REASONS.includes(value.reason)) return `REASON_OUT_OF_TABLE:${value.reason}`
  return 'OK'
}

/* ---------------------------------------------------------------------------
   2. 云函数本体（本地直接调用；**无网络**）
   --------------------------------------------------------------------------- */
const adminTokenFunction = require(path.join(ROOT, 'cloudfunctions/xiai-admin-token/index.js'))
const tokenLib = require(path.join(ROOT, 'cloudfunctions/xiai-admin-token/lib/token.js'))

const PHONE = String(process.env.XIAI_ADMIN_PHONE || '').trim()
const CODE = String(process.env.XIAI_ADMIN_SMS_CODE || '').trim()
const SECRET = String(process.env.XIAI_ADMIN_TOKEN_SECRET || '').trim()

if (PHONE === '' || CODE === '' || SECRET === '') {
  console.error(
    JSON.stringify({
      fatal: 'MISSING_TEST_ENV',
      need: ['XIAI_ADMIN_PHONE', 'XIAI_ADMIN_SMS_CODE', 'XIAI_ADMIN_TOKEN_SECRET'],
      note: '三个值只从环境变量读入；本脚本绝不回显它们的值'
    })
  )
  process.exit(2)
}

const main = adminTokenFunction.main
const nowSeconds = () => Math.floor(Date.now() / 1000)
const NON_WHITELIST_PHONE = '13900000001'

console.log(
  JSON.stringify({
    section: 'A',
    title: '云函数本体（本地调用，零网络）',
    env: {
      phoneLength: PHONE.length,
      phoneFingerprint: fingerprint(PHONE),
      codeLength: CODE.length,
      secretLength: SECRET.length,
      secretFingerprint: fingerprint(SECRET)
    }
  })
)

/* A1 签发成功（白名单手机号 ＋ 正确验证码） */
const issued = await main({ action: 'issue', phone: PHONE, code: CODE })
check('A1', 'issue ok（白名单手机号 + 正确验证码）', true, issued.ok === true)
check('A1b', 'issue 回传的令牌形态（长度 > 0 且含恰 1 个分隔点）', true, typeof issued.token === 'string' && issued.token.split('.').length === 2)
check('A1c', 'issue TTL = 900 秒（15 分钟）', 900, issued.expiresAt - issued.issuedAt)
console.log(JSON.stringify({ A1_token_readout: { length: issued.token.length, fingerprint: fingerprint(issued.token) } }))

/* A2 非白名单手机号 ⇒ FORBIDDEN */
const badPhone = await main({ action: 'issue', phone: NON_WHITELIST_PHONE, code: CODE })
check('A2', 'issue 非白名单手机号 ⇒ 拒绝', 'FORBIDDEN', badPhone.reason)
check('A2b', 'A2 失败形状 = 恰 3 键 + 冻结字面值', 'OK', failureShape(badPhone))

/* A3 验证码错误 ⇒ FORBIDDEN */
const badCode = await main({ action: 'issue', phone: PHONE, code: '0000' })
check('A3', 'issue 验证码错误 ⇒ 拒绝', 'FORBIDDEN', badCode.reason)

/* A4 无令牌 ⇒ FORBIDDEN */
const noToken = await main({ action: 'verify', token: '', op: 'setInviteReward', payload: { value: 3 } })
check('A4', 'verify 无令牌 ⇒ 拒绝', 'FORBIDDEN', noToken.reason)
check('A4b', 'A4 失败形状 = 恰 3 键 + 冻结字面值', 'OK', failureShape(noToken))

/* A5 签名错（篡改签名段）⇒ FORBIDDEN，且与「无令牌」**同文案**（防探测） */
const [head, signature] = issued.token.split('.')
const tampered = `${head}.${signature.slice(0, -1)}${signature.slice(-1) === 'A' ? 'B' : 'A'}`
const badSignature = await main({ action: 'verify', token: tampered, op: 'setInviteReward', payload: { value: 3 } })
check('A5', 'verify 签名错 ⇒ 拒绝', 'FORBIDDEN', badSignature.reason)
check('A5b', 'A5 失败形状 = 恰 3 键 + 冻结字面值', 'OK', failureShape(badSignature))
check('A5c', '签名错与「无令牌」同文案（不泄漏「签名错」细节）', true, badSignature.message === noToken.message)

/* A6 过期令牌（用同一密钥签出、`exp` 已在 2 小时前）⇒ FORBIDDEN + 过期专文案 */
const stale = tokenLib.issueToken({
  sub: PHONE,
  secret: SECRET,
  nowSeconds: nowSeconds() - 7200,
  ttlSeconds: 900,
  version: process.env.XIAI_ADMIN_TOKEN_VERSION || '1'
})
const expired = await main({ action: 'verify', token: stale.token, op: 'setInviteReward', payload: { value: 3 } })
check('A6', 'verify 过期令牌 ⇒ 拒绝', 'FORBIDDEN', expired.reason)
check('A6b', '过期文案与「无令牌」不同（可读、指向重新验证）', true, expired.message !== noToken.message)

/* A7 令牌 `sub` 不在白名单（同密钥签出、合法签名、合法有效期）⇒ FORBIDDEN */
const foreign = tokenLib.issueToken({
  sub: NON_WHITELIST_PHONE,
  secret: SECRET,
  nowSeconds: nowSeconds(),
  ttlSeconds: 900,
  version: process.env.XIAI_ADMIN_TOKEN_VERSION || '1'
})
const foreignReply = await main({ action: 'verify', token: foreign.token, op: 'setInviteReward', payload: { value: 3 } })
check('A7', 'verify 签名合法但手机号非白名单 ⇒ 拒绝', 'FORBIDDEN', foreignReply.reason)
check('A7b', 'A7 失败形状 = 恰 3 键 + 冻结字面值', 'OK', failureShape(foreignReply))

/* A8 令牌版本不符（撤销面）⇒ FORBIDDEN */
const oldVersion = tokenLib.issueToken({
  sub: PHONE,
  secret: SECRET,
  nowSeconds: nowSeconds(),
  ttlSeconds: 900,
  version: '0'
})
const revoked = await main({ action: 'verify', token: oldVersion.token, op: 'setInviteReward', payload: { value: 3 } })
check('A8', 'verify 令牌版本不符（已撤销）⇒ 拒绝', 'FORBIDDEN', revoked.reason)

/* A9 校验成功 ⇒ ok:true ＋ **滑动续期**（新令牌、`exp` 前移） */
const verified = await main({ action: 'verify', token: issued.token, op: 'setInviteReward', payload: { value: 3 } })
check('A9', 'verify 成功', true, verified.ok === true)
check('A9b', '滑动续期：回吐新令牌且指纹与旧令牌不同', true, typeof verified.renewedToken === 'string' && fingerprint(verified.renewedToken) !== fingerprint(issued.token))
check('A9c', '滑动续期：新 exp ≥ 旧 exp', true, verified.renewedExpiresAt >= issued.expiresAt)

/* A10 值域门（服务端判）⇒ INVALID_VALUE */
const badValue = await main({ action: 'verify', token: verified.renewedToken, op: 'setInviteReward', payload: { value: -1 } })
check('A10', 'verify 值域不符（-1）⇒ INVALID_VALUE', 'INVALID_VALUE', badValue.reason)
check('A10b', 'A10 失败形状 = 恰 3 键 + 冻结字面值', 'OK', failureShape(badValue))

/* A11 未知 op ⇒ INVALID_FIELD */
const badOp = await main({ action: 'verify', token: verified.renewedToken, op: 'delete-everything', payload: { value: 3 } })
check('A11', 'verify 未知 op ⇒ INVALID_FIELD', 'INVALID_FIELD', badOp.reason)

/* A12 载荷含未知字段 ⇒ INVALID_FIELD */
const extraKey = await main({ action: 'verify', token: verified.renewedToken, op: 'setInviteReward', payload: { value: 3, role: 'admin' } })
check('A12', 'verify 载荷含未知字段（试图夹带 role）⇒ INVALID_FIELD', 'INVALID_FIELD', extraKey.reason)
check('A12b', 'A12 失败形状 = 恰 3 键 + 冻结字面值', 'OK', failureShape(extraKey))

/* A13 未知 action ⇒ FORBIDDEN */
const badAction = await main({ action: 'grant-me-admin' })
check('A13', '未知 action ⇒ 拒绝', 'FORBIDDEN', badAction.reason)

/* A14 配置缺失（清空三个环境变量）⇒ STORAGE_UNAVAILABLE（**不得伪装 FORBIDDEN**） */
const savedEnv = {
  phone: process.env.XIAI_ADMIN_PHONE,
  code: process.env.XIAI_ADMIN_SMS_CODE,
  secret: process.env.XIAI_ADMIN_TOKEN_SECRET
}
delete process.env.XIAI_ADMIN_PHONE
delete process.env.XIAI_ADMIN_SMS_CODE
delete process.env.XIAI_ADMIN_TOKEN_SECRET
const unconfigured = await main({ action: 'issue', phone: PHONE, code: CODE })
process.env.XIAI_ADMIN_PHONE = savedEnv.phone
process.env.XIAI_ADMIN_SMS_CODE = savedEnv.code
process.env.XIAI_ADMIN_TOKEN_SECRET = savedEnv.secret
check('A14', '配置缺失 ⇒ STORAGE_UNAVAILABLE（不是 FORBIDDEN）', 'STORAGE_UNAVAILABLE', unconfigured.reason)
check('A14b', 'A14 失败形状 = 恰 3 键 + 冻结字面值', 'OK', failureShape(unconfigured))

/* A15 静态扫描：函数体**不含任何持久化写入**（⇒ 负向天然零写入） */
const functionSources = ['index.js', 'lib/token.js', 'lib/config.js'].map((relative) =>
  readFileSync(path.join(ROOT, 'cloudfunctions/xiai-admin-token', relative), 'utf8')
)
const forbiddenTokens = ['node-sdk', 'require(\'fs\')', 'require("fs")', 'writeFile', 'collection(', 'database()', 'insertOne', 'updateOne']
const hits = []
functionSources.forEach((source, index) => {
  forbiddenTokens.forEach((token) => {
    if (source.includes(token)) hits.push(`${['index.js', 'lib/token.js', 'lib/config.js'][index]}:${token}`)
  })
})
check('A15', '云函数源码零持久化痕迹（无 DB / 无 fs 写 / 无 node-sdk）', [], hits)

/* ---------------------------------------------------------------------------
   3. 客户端管道 ＋ 垂直切片（注入了**真实函数体**的传输实现）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'B', title: '客户端管道 + 垂直切片（注入真实函数体，零网络）' }))

const session = await import(path.join(ROOT, 'src/data/session.js'))
const storage = await import(path.join(ROOT, 'src/data/storage.js'))
const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
const adminToken = await import(path.join(ROOT, 'src/services/adminToken.js'))
const adminService = await import(path.join(ROOT, 'src/services/admin.js'))

/** 注入「真实函数体的本地调用」实现（生产走 SDK；此处只为离线可复现）。 */
function installLocalFunctionTransport(patch) {
  adminToken.setAdminTokenTransport(async (name, data) => {
    if (typeof patch === 'function') return patch(name, data)
    const result = await main(data)
    return { ok: true, result }
  })
}
installLocalFunctionTransport(null)

const REWARD_KEY = 'xiai:v1:' + storage.STORAGE_KEYS.inviteReward
const readRewardKey = () => localStorageShim.getItem(REWARD_KEY)

/* B0 形态读数（云端形态 = 有云写入面） */
writeFace.setWriteFaceModeOverride('cloud')
check('B0', '云端形态：writeFaceMode()', 'cloud', writeFace.writeFaceMode())
check('B0b', '云端形态：本地写入口门 ⇒ 结构化拒绝（非 null）', 'FORBIDDEN', (writeFace.localWriteDenial() || {}).reason)
check('B0c', '云端形态：本地写入口门文案含「dev / 離線形態」标注', true, String((writeFace.localWriteDenial() || {}).message || '').includes('dev / 離線形態'))

/* B1 未取票时直接写 ⇒ 服务端 FORBIDDEN ＋ 零写入（**前端不预判**：请求真的发到服务端） */
session.setUser({ id: 'u-harness-admin', role: 'admin', phone: PHONE })
let wireCalls = 0
installLocalFunctionTransport(async (name, data) => {
  wireCalls += 1
  const result = await main(data)
  return { ok: true, result }
})
const before = readRewardKey()
const noTokenWrite = await adminService.setInviteReward(null, 11)
check('B1', '无令牌写 ⇒ FORBIDDEN', 'FORBIDDEN', noTokenWrite.reason)
check('B1b', '无令牌写 ⇒ 零写入（配置键未变）', before, readRewardKey())
check('B1c', '无令牌写确实发生了服务端往返（前端不预判）', true, wireCalls === 1)

/* B2 取票（签发 → 缓存） */
const issuedSession = await adminToken.ensureAdminWriteSession(CODE)
check('B2', '取票成功（手机号取自登录用户，验证码来自输入）', true, issuedSession.ok === true)
check('B2b', '令牌进入缓存（只给长度 / 指纹，不给原文）', true, adminToken.adminTokenSnapshot().present === true)
console.log(JSON.stringify({ B2_readout: adminToken.adminTokenSnapshot() }))

/* B3 端到端成功往返：签发 → 携带 → 校验通过 → 落盘 */
const okWrite = await adminService.setInviteReward(null, 7)
check('B3', '经云端校验后写入成功', true, okWrite.ok === true)
check('B3b', '落盘读数：配置键值 = 7', JSON.stringify({ invite_reward: 7 }), readRewardKey())
check('B3c', '滑动续期发生（成功校验回吐新令牌）', true, adminToken.adminTokenSnapshot().slidingRenewals >= 1)
console.log(JSON.stringify({ B3_readout: { key: REWARD_KEY, value: okWrite, token: adminToken.adminTokenSnapshot() } }))

/* B4 值域门（携带有效令牌 + 非法值）⇒ INVALID_VALUE ＋ 零写入 */
const afterB3 = readRewardKey()
const badValueWrite = await adminService.setInviteReward(null, -3)
check('B4', '有效令牌 + 非法值 ⇒ INVALID_VALUE', 'INVALID_VALUE', badValueWrite.reason)
check('B4b', '值域拒绝 ⇒ 零写入', afterB3, readRewardKey())

/* B5 传输失败（网络异常）⇒ STORAGE_UNAVAILABLE，**绝不伪装 FORBIDDEN** ＋ 零写入 */
installLocalFunctionTransport(async () => {
  throw new Error('simulated network failure')
})
const netFail = await adminService.setInviteReward(null, 13)
check('B5', '传输失败 ⇒ STORAGE_UNAVAILABLE', 'STORAGE_UNAVAILABLE', netFail.reason)
check('B5b', '传输失败 ≠ FORBIDDEN（R-WF2）', true, netFail.reason !== 'FORBIDDEN')
check('B5c', '传输失败 ⇒ 零写入', afterB3, readRewardKey())
check('B5d', '传输失败不清令牌（「未知」≠「无效」）', true, adminToken.adminTokenSnapshot().present === true)

/* B6 过期令牌（注入「只签发已过期令牌」的传输）⇒ FORBIDDEN ＋ 零写入 */
installLocalFunctionTransport(async (name, data) => {
  if (data.action === 'issue') {
    return { ok: true, result: await main({ action: 'issue', phone: PHONE, code: CODE }) }
  }
  return { ok: true, result: await main({ ...data, token: stale.token }) }
})
const afterB3b = readRewardKey()
const expiredWrite = await adminService.setInviteReward(null, 17)
check('B6', '过期令牌 ⇒ FORBIDDEN', 'FORBIDDEN', expiredWrite.reason)
check('B6b', '过期拒绝文案指向重新验证', true, String(expiredWrite.message || '').includes('過期'))
check('B6c', '过期拒绝 ⇒ 零写入', afterB3b, readRewardKey())
check('B6d', '授权判定失败 ⇒ 缓存令牌已清（需重新取票）', false, adminToken.adminTokenSnapshot().present)

/* B7 dev / 离线形态：本地写入口保留（**明确标注为非正式写入路径**） */
writeFace.setWriteFaceModeOverride('local-dev')
installLocalFunctionTransport(null)
check('B7', 'dev / 离线形态：writeFaceMode()', 'local-dev', writeFace.writeFaceMode())
check('B7b', 'dev / 离线形态：本地写入口门放行（null）', null, writeFace.localWriteDenial())
check('B7c', 'dev / 离线形态：形态标注写明「非正式写入路径」', true, writeFace.writeFaceModeLabel().includes('非正式寫入路徑'))
const localWrite = await adminService.setInviteReward({ id: 'u-harness-admin', role: 'admin', phone: PHONE }, 5)
check('B7d', 'dev / 离线形态：本地写入仍然可用（改前行为保留）', true, localWrite.ok === true)
check('B7e', 'dev / 离线形态：局部角色门仍在（非管理员 ⇒ FORBIDDEN ＋ 零写入）', 'FORBIDDEN', (await adminService.setInviteReward({ id: 'u-x', role: 'user' }, 99)).reason)
check('B7f', 'dev / 离线形态：非管理员写入后值仍是 5（零写入）', JSON.stringify({ invite_reward: 5 }), readRewardKey())

/* ---------------------------------------------------------------------------
   4. 降级机制读数（清单式标注）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'C', title: '本地写入口降级机制读数' }))
writeFace.setWriteFaceModeOverride('cloud')
const readout = writeFace.localWriteReadout()
check('C1', '清单总条数 = 24（8 裸 save*Rows ＋ 6 drive 裸写 ＋ 10 管理员写入口）', 24, readout.total)
check('C2', '分组计数', { 'raw-persist': 8, 'drive-raw': 6, 'admin-entry': 10 }, readout.byGroup)
check('C3', '迁移状态计数（Phase 1 只有 1 条已过云端校验）', { 'phase1-migrated': 1, 'phase1-unmigrated': 23 }, readout.byStatus)
console.log(JSON.stringify({ C_entries: readout.entries }))

/* ---------------------------------------------------------------------------
   5. 汇总
   --------------------------------------------------------------------------- */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id)
  })
)
process.exit(failures === 0 ? 0 : 1)
