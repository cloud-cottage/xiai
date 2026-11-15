/**
 * 玺爱 · **P1a 登录签发（`action:'issue'`｜Zang 裁定 R-L1）负向自检**
 * ----------------------------------------------------------------------------
 * **本机、零部署、零短信、零真实凭证、零写库**。
 * 只做一件事：证明「固定演示码」下线后，登录签发的四条负向**归口正确**（不新增 reason 字面值）：
 *   N1 伪造 `platformAccessToken` ⇒ `FORBIDDEN`（**真打**生产 auth 端点，只带伪造凭证）；
 *   N2 凭证成立但手机号不一致 ⇒ `FORBIDDEN`（传输注入：回体给**别的号**）；
 *   N3 缺参数（`{}` / 旧入参 `{phone, code}`）⇒ `FORBIDDEN` 且**零网络**；
 *   N4 内部不可用（envId 改错 ⇒ 平台回 `INVALID_ENV`；以及 1 ms 超时 ⇒ 网络侧失败）
 *      ⇒ `STORAGE_UNAVAILABLE`（**绝不伪装 `FORBIDDEN`**）。
 * 另加两条**正面对照**（证明判定不是「恒 false」）：号一致 ⇒ 签发成功且 `sub` 只回掩码；
 * `XIAI_USER_SMS_CODE` 缺失 ⇒ `readConfig().ready === true`（变量已退出必填集）。
 *
 * 纪律：
 *  · **不打印任何令牌 / 验证码 / 手机号原文**（只给布尔、长度、指纹、掩码、内部判别码）；
 *  · 传输注入只用于「无真实 `access_token` 时验判否逻辑」，**生产路径不传 `transport`** ⇒ 恒走内置 https；
 *  · 断言失败 ⇒ 退出码非 0。
 *
 * 用法：node scripts/probe-user-issue-platform-auth.mjs
 */
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* **测试环境保护哨兵**：本套件不碰任何真实 CARD 接口（若哪个调用点漏注入假传输 ⇒ 当场抛错）。 */
process.env.XIAI_NO_REAL_CARD = '1'

/* 环境：合成密钥（一次性、不落盘、不进报告）；手机号取合成号，绝不使用任何真实号。 */
const SECRET = randomBytes(32).toString('hex')
const REAL_ENV_ID = 'liwu-cny1313-d1gb2fukyb7cb19bb'
const BAD_ENV_ID = 'probe-env-does-not-exist-x1'
const DECLARED_PHONE = '13800000001' /* 合成号，非真实用户 */
const OTHER_PHONE = '13900000002' /* 合成号，非真实用户 */

process.env.XIAI_USER_TOKEN_SECRET = SECRET
process.env.XIAI_USER_TOKEN_VERSION = '1'
process.env.XIAI_USER_TOKEN_TTL_SECONDS = '900'
process.env.TCB_ENV = REAL_ENV_ID
/* **故意不设 `XIAI_USER_SMS_CODE`**：证明它已退出 `ready` 必填集。 */
delete process.env.XIAI_USER_SMS_CODE

const fn = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/index.js'))
const platformAuth = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/platformAuth.js'))
const configModule = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/config.js'))

const results = []
let failures = 0
function check(id, label, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (!pass) failures += 1
  results.push({ id, label, pass })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}

/* 回包读数：**只挑非敏感键**（不打印 token 原文）。 */
function denialOf(reply) {
  if (!reply || typeof reply !== 'object') return { keys: [], reason: null }
  return {
    keys: Object.keys(reply).sort(),
    ok: reply.ok,
    reason: reply.reason === undefined ? null : reply.reason,
    message: reply.message === undefined ? '' : reply.message
  }
}

const FAKE_TOKEN = `fake.${randomBytes(6).toString('hex')}.probe`

/* ---------------------------------------------------------------------------
   N1 伪造凭证 ⇒ FORBIDDEN（**真打**生产 auth 端点；零真实凭证、零写库）
   --------------------------------------------------------------------------- */
const n1 = await fn.main({ action: 'issue', phone: DECLARED_PHONE, platformAccessToken: FAKE_TOKEN })
check('N1', '伪造 platformAccessToken ⇒ FORBIDDEN', { ok: false, reason: 'FORBIDDEN' }, {
  ok: n1.ok,
  reason: n1.reason
})
check('N1-keys', '回包恒为恰 3 键 {ok,message,reason}', ['message', 'ok', 'reason'], Object.keys(n1).sort())
check('N1-token-free', '回包不含 token 键', false, Object.prototype.hasOwnProperty.call(n1, 'token'))

/* ---------------------------------------------------------------------------
   N2 凭证成立但手机号不一致 ⇒ FORBIDDEN（传输注入：回体给**别的号**）
   --------------------------------------------------------------------------- */
const transportOtherPhone = async () => ({ ok: true, status: 200, body: { phone_number: `+86 ${OTHER_PHONE}` } })
const n2 = await fn.handleIssue({ phone: DECLARED_PHONE, platformAccessToken: FAKE_TOKEN }, configModule.readConfig(), transportOtherPhone)
check('N2', '凭证有效但号不一致 ⇒ FORBIDDEN', { ok: false, reason: 'FORBIDDEN' }, { ok: n2.ok, reason: n2.reason })
check('N2-token-free', '回包不含 token 键', false, Object.prototype.hasOwnProperty.call(n2, 'token'))

/* 正面对照 A：号一致（回体带 `+86 ` 前缀与空格）⇒ 签发成功，`sub` 只回掩码。 */
const transportSamePhone = async () => ({ ok: true, status: 200, body: { phone_number: `+86 ${DECLARED_PHONE}` } })
const okA = await fn.handleIssue({ phone: DECLARED_PHONE, platformAccessToken: FAKE_TOKEN }, configModule.readConfig(), transportSamePhone)
check('P1', '号一致（+86 前缀归一）⇒ 签发成功', { ok: true, subMasked: true, uidShape: true }, {
  ok: okA.ok,
  subMasked: okA.sub === `138****0001`,
  uidShape: typeof okA.uid === 'string' && /^u-[0-9a-f]{16}$/.test(okA.uid)
})
check('P1-token1', '成功回包含 token 且仅此一处', typeof okA.token === 'string' && okA.token.split('.').length === 2, true)

/* 正面对照 B：回体是平台错误码形态（HTTP 200 ＋ code）⇒ 必须判否而不是当成功。 */
const transportInvalidCode = async () => ({ ok: true, status: 200, body: { code: 'INVALID_ACCESS_TOKEN', message: 'x' } })
const okB = await fn.handleIssue({ phone: DECLARED_PHONE, platformAccessToken: FAKE_TOKEN }, configModule.readConfig(), transportInvalidCode)
check('P2', 'HTTP 200 ＋ code=INVALID_ACCESS_TOKEN ⇒ FORBIDDEN（不当成功）', { ok: false, reason: 'FORBIDDEN' }, {
  ok: okB.ok,
  reason: okB.reason
})

/* ---------------------------------------------------------------------------
   N3 缺参数 ⇒ FORBIDDEN（**零网络**：传输注入若被调用即抛错）
   --------------------------------------------------------------------------- */
let transportCalls = 0
const transportTripwire = async () => {
  transportCalls += 1
  throw new Error('transport must not be called')
}
const n3a = await fn.handleIssue({}, configModule.readConfig(), transportTripwire)
const n3b = await fn.handleIssue({ phone: DECLARED_PHONE, code: 'x' }, configModule.readConfig(), transportTripwire)
const n3c = await fn.handleIssue({ action: 'issue' }, configModule.readConfig(), transportTripwire)
check('N3', '缺平台凭证 / 旧入参 {phone,code} / 空事件 ⇒ FORBIDDEN', [
  { ok: false, reason: 'FORBIDDEN' },
  { ok: false, reason: 'FORBIDDEN' },
  { ok: false, reason: 'FORBIDDEN' }
], [
  { ok: n3a.ok, reason: n3a.reason },
  { ok: n3b.ok, reason: n3b.reason },
  { ok: n3c.ok, reason: n3c.reason }
])
check('N3-zero-network', '缺参数路径零网络调用', 0, transportCalls)

/* ---------------------------------------------------------------------------
   N4 内部不可用 ⇒ STORAGE_UNAVAILABLE（两种真实故障面）
   --------------------------------------------------------------------------- */
/* N4-a：envId 改错 ⇒ 平台回 HTTP 200 ＋ code=INVALID_ENV（**真实请求**）。 */
process.env.TCB_ENV = BAD_ENV_ID
const n4a = await fn.main({ action: 'issue', phone: DECLARED_PHONE, platformAccessToken: FAKE_TOKEN })
process.env.TCB_ENV = REAL_ENV_ID
check('N4-a', 'envId 错（平台回 INVALID_ENV）⇒ STORAGE_UNAVAILABLE', { ok: false, reason: 'STORAGE_UNAVAILABLE' }, {
  ok: n4a.ok,
  reason: n4a.reason
})
check('N4-a-not-forbidden', '内部不可用不得伪装 FORBIDDEN', true, n4a.reason === 'STORAGE_UNAVAILABLE')

/* N4-b：1 ms 超时 ⇒ 传输侧失败（**真实请求**，不等回包）。 */
const n4b = await platformAuth.verifyPlatformSession({ envId: REAL_ENV_ID, accessToken: FAKE_TOKEN, timeoutMs: 1 })
check('N4-b', '1 ms 超时 ⇒ {ok:false,detail:PLATFORM_UNAVAILABLE}', { ok: false, detail: 'PLATFORM_UNAVAILABLE' }, n4b)

/* N4-c：传输层直接报网络错（DNS / 连接失败等价形态）⇒ 同一致命归口。 */
const n4c = await platformAuth.verifyPlatformSession({
  envId: REAL_ENV_ID,
  accessToken: FAKE_TOKEN,
  transport: async () => ({ ok: false, detail: 'PLATFORM_UNAVAILABLE' })
})
check('N4-c', '网络错 ⇒ {ok:false,detail:PLATFORM_UNAVAILABLE}', { ok: false, detail: 'PLATFORM_UNAVAILABLE' }, n4c)

/* N4-d：传输层抛异常（任何意外）⇒ 不自抛、收敛成不可用。 */
const n4d = await platformAuth.verifyPlatformSession({
  envId: REAL_ENV_ID,
  accessToken: FAKE_TOKEN,
  transport: async () => {
    throw new Error('boom')
  }
})
check('N4-d', '传输层抛错 ⇒ 不自抛、收敛成不可用', { ok: false, detail: 'PLATFORM_UNAVAILABLE' }, n4d)

/* ---------------------------------------------------------------------------
   配置面：`XIAI_USER_SMS_CODE` 已退出 `ready` 必填集
   --------------------------------------------------------------------------- */
const cfgNoSms = configModule.readConfig()
check('C1', '无 XIAI_USER_SMS_CODE ⇒ ready 且 legacySmsCodeConfigured=false', { ready: true, legacySmsCodeConfigured: false }, {
  ready: cfgNoSms.ready,
  legacySmsCodeConfigured: cfgNoSms.legacySmsCodeConfigured
})
check('C2', 'ready 结果不再回传 smsCode 值', false, Object.prototype.hasOwnProperty.call(cfgNoSms, 'smsCode'))
const cfgWithSms = configModule.readConfig({ XIAI_USER_TOKEN_SECRET: SECRET, XIAI_USER_SMS_CODE: 'legacy-value' })
check('C3', '遗留变量仍在 ⇒ 只出布尔读数（值不回传）', { ready: true, legacySmsCodeConfigured: true }, {
  ready: cfgWithSms.ready,
  legacySmsCodeConfigured: cfgWithSms.legacySmsCodeConfigured
})
const cfgNoSecret = configModule.readConfig({ TCB_ENV: REAL_ENV_ID })
check('C4', '缺 secret ⇒ ready=false 且 reason=STORAGE_UNAVAILABLE', { ready: false, reason: 'STORAGE_UNAVAILABLE' }, {
  ready: cfgNoSecret.ready,
  reason: cfgNoSecret.reason
})

/* 手机号归一口径（平台侧带 +86 / 空格） */
check('C5', '归一：+86 前缀 / 空格 / 13 位 86 开头', ['13800000001', '13800000001', '', ''], [
  platformAuth.normalizePlatformPhone('+86 13800000001'),
  platformAuth.normalizePlatformPhone('8613800000001'),
  platformAuth.normalizePlatformPhone('12800000001'),
  platformAuth.normalizePlatformPhone('')
])

console.log(JSON.stringify({ summary: { total: results.length, failures, pass: failures === 0 } }))
process.exit(failures === 0 ? 0 : 1)
