/**
 * 玺爱 · **自检：只读会话验签面 `action:'verifySession'`**（跨仓契约：斐萃影子库服务端代验）
 * ============================================================================
 * **完全离线**：零联网、零真库、零真 CARD（`XIAI_NO_REAL_CARD=1` ＋ DB 注入缝
 * `ops.setOpsDbProvider` 的**只读计数假体**）、零部署；断言失败 ⇒ 退出码 1。
 *
 * 被测真源（本仓）：
 *   · `cloudfunctions/xiai-user-token/lib/verifySession.js`（判定全在此处）；
 *   · `cloudfunctions/xiai-user-token/index.js`（`main()` 短路分发 ＋ 信封）。
 *
 * 契约（逐字；与 feicui-shadow `lib/session.js` 文件头「决策 (b)」同源）：
 *   · 请求 ⇒ `{ action: 'verifySession', token: '<xiai 用户会话令牌>' }`（**不要求 `op` / `payload`**）
 *   · 成功 ⇒ `{ ok: true, uid: 'u-<16 hex>', role: 'user' | 'admin' }`（**恰 3 键**）
 *   · 失败 ⇒ `{ ok: false, reason: 'TOKEN_INVALID' | 'TOKEN_EXPIRED', message: '…' }`（**恰 3 键**）
 *
 * 覆盖面（A〜E 五段，35 条）：
 *   A 契约常量 / 短路位置（静态）/ 「零签发零落盘」静态判据；
 *   B 成功面（有效令牌 ⇒ ok ＋ uid ＋ role；uid 由**独立实现**复算一致；admin 令牌；无需 op/payload）；
 *   C 拒绝面（过期 / 篡改签名 / 篡改载荷 / 错密钥 / ver 不符 / 缺 token / 非字符串 / 空串 /
 *     纯空白 / sub 非手机号 / role 越界 / 三段形态）；
 *   D 零外泄（手机号 / 令牌片段 / jti 逐字扫回包）＋ 幂等（两次同 uid）＋
 *     **滑动续期未发生**（`issueToken` 调用计数 0 ＋ 存储读 0 写 0 ＋ 回包无 `renewed*` 键）
 *     ＋ 内部不可用不伪装（缺密钥 ⇒ `STORAGE_UNAVAILABLE`）＋ 不被签发面配置连坐；
 *   E 既有面不受影响（未知 action 仍旧 FORBIDDEN / 未知 op 仍旧 INVALID_FIELD /
 *     `sessionProbe` 仍旧恰 8 键）。
 *
 * 纪律：**不打印密钥 / 令牌原文**（只给长度与 sha256 前 12 位指纹）；密钥与手机号一律
 * 运行期构造（**仓内零密钥字面值、零手机号字面值**）。
 */
process.env.XIAI_NO_REAL_CARD = '1'

import { createRequire } from 'node:module'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

/* ---------------------------------------------------------------------------
   0. 断言 / 读数（与既有套件同形：JSONL 一行一条）
   ------------------------------------------------------------------------- */

let total = 0
let passed = 0
const failedIds = []

function section(name, title) {
  console.log(JSON.stringify({ section: name, title }))
}

function check(id, title, expected, actual) {
  total += 1
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (pass) passed += 1
  else failedIds.push(id)
  console.log(JSON.stringify({ id, case: title, pass, expected, actual }))
}

const shapeOf = (object) => (object && typeof object === 'object' ? Object.keys(object).sort().join(',') : String(object))
const fingerprint = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12)
/** 去注释后的源码（只判**代码**，不把注释里的字眼当实现）。 */
function codeOnly(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1 ')
}
const countIn = (source, needle) => String(source).split(needle).length - 1

/* ---------------------------------------------------------------------------
   1. 测试材料（**运行期构造 ⇒ 仓内零密钥 / 零手机号字面值**）
   ------------------------------------------------------------------------- */

const randomDigits = (length) => Array.from({ length }, () => String(randomInt(0, 10))).join('')
const SECRET = randomBytes(32).toString('hex')
const OTHER_SECRET = randomBytes(32).toString('hex')
const SMS_CODE = 'code-' + randomBytes(4).toString('hex')
const PHONE = '13' + randomDigits(9)
const NOT_PHONE = 'x-' + randomDigits(6)
const VERSION = '7'
const NOW = Math.floor(Date.now() / 1000)

process.env.XIAI_USER_TOKEN_SECRET = SECRET
process.env.XIAI_USER_SMS_CODE = SMS_CODE
process.env.XIAI_USER_TOKEN_VERSION = VERSION
delete process.env.XIAI_SESSION_AUTHORITY /* ⇒ 会话通道 off：既有令牌路行为可判负（零联网） */

/* ---------------------------------------------------------------------------
   2. 离线 DB 注入缝（只读计数假体：任何读 / 写都会把计数打出来）
   ------------------------------------------------------------------------- */

function createStore() {
  const stats = { reads: 0, writes: 0 }
  const provider = () => ({
    collection() {
      return {
        doc() {
          return {
            async get() {
              stats.reads += 1
              return { data: [] }
            },
            async set() {
              stats.writes += 1
              throw new Error('OFFLINE_STORE_READ_ONLY')
            },
            async update() {
              stats.writes += 1
              throw new Error('OFFLINE_STORE_READ_ONLY')
            }
          }
        },
        where() {
          return {
            async get() {
              stats.reads += 1
              return { data: [] }
            }
          }
        },
        async add() {
          stats.writes += 1
          throw new Error('OFFLINE_STORE_READ_ONLY')
        }
      }
    }
  })
  return { stats, provider }
}

const store = createStore()

/* ---------------------------------------------------------------------------
   3. 装配：先给令牌库打「续期调用」计数器（必须在 require index.js **之前**，
      否则 index.js 解构到的仍是原函数 ⇒ 计不到数）。
   ------------------------------------------------------------------------- */

const tokenLib = require(path.join(FN_DIR, 'lib/token.js'))
const origIssueToken = tokenLib.issueToken
let issueTokenCalls = 0
tokenLib.issueToken = (...args) => {
  issueTokenCalls += 1
  return origIssueToken(...args)
}

const ops = require(path.join(FN_DIR, 'lib/ops.js'))
const fn = require(path.join(FN_DIR, 'index.js'))
const sessionLib = require(path.join(FN_DIR, 'lib/sessionAuthority.js'))
const verifyLib = require(path.join(FN_DIR, 'lib/verifySession.js'))
ops.setOpsDbProvider(store.provider)

/** 铸令牌（**只用原函数** ⇒ 不污染续期计数）。 */
function mint(overrides) {
  const input = Object.assign(
    { sub: PHONE, secret: SECRET, nowSeconds: NOW, ttlSeconds: 900, version: VERSION, role: 'user' },
    overrides || {}
  )
  const issued = origIssueToken(input)
  if (!issued.ok) throw new Error(`mint failed: ${issued.detail}`)
  return issued.token
}

/** 独立复算 uid（**不用被测实现**）：`u-` ＋ sha256(归一手机号) 前 16 位。 */
function uidOfIndependent(phone) {
  const digits = String(phone).replace(/[^0-9]/g, '')
  return 'u-' + createHash('sha256').update(digits, 'utf8').digest('hex').slice(0, 16)
}

const VALID = mint({})
const EXPIRED = mint({ nowSeconds: NOW - 7200 })
const TAMPERED_SIGNATURE = (() => {
  const [payload, signature] = VALID.split('.')
  const flipped = (signature[signature.length - 1] === 'A' ? 'B' : 'A')
  return `${payload}.${signature.slice(0, -1)}${flipped}`
})()
const TAMPERED_PAYLOAD = (() => {
  const [payload, signature] = VALID.split('.')
  const flipped = (payload[0] === 'A' ? 'B' : 'A') + payload.slice(1)
  return `${flipped}.${signature}`
})()
const FOREIGN_SECRET = mint({ secret: OTHER_SECRET })
const VERSION_MISMATCH = mint({ version: '1' })
const NOT_PHONE_SUB = mint({ sub: NOT_PHONE })
const ROLE_OUT_OF_DOMAIN = mint({ role: 'superadmin' })
const ADMIN_ROLE = mint({ role: 'admin' })
const THREE_SEGMENTS = `${VALID}.extra`

const call = (event) => fn.main(event)

console.log(JSON.stringify({
  materials: {
    phone: `<${String(PHONE).length} digits, sha256:${fingerprint(PHONE)}>`,
    token: `<${VALID.length} chars, sha256:${fingerprint(VALID)}>`,
    secret: `<${SECRET.length} chars, sha256:${fingerprint(SECRET)}>`,
    version: VERSION,
    now: NOW
  }
}))

/* ===========================================================================
  A 段：契约常量 / 短路位置 / 静态判据
  =========================================================================== */
section('A', '契约常量（action / 两句 reason / 回包键面）＋ 短路位置 ＋ 零签发零落盘静态判据')

check('A1', 'action 字面值逐字 ＝ verifySession（与 feicui `VERIFY_ACTION` 同值）', 'verifySession', fn.VERIFY_SESSION_ACTION)
check('A2', 'reason 值域恰两句（TOKEN_INVALID / TOKEN_EXPIRED，不多不少）', ['TOKEN_EXPIRED', 'TOKEN_INVALID'], Object.values(fn.VERIFY_SESSION_REASONS).sort())
check('A3', '成功回包键面常量恰 [ok, uid, role]', ['ok', 'role', 'uid'], fn.VERIFY_SESSION_SUCCESS_KEYS.slice().sort())
check('A4', '失败回包键面常量恰 [ok, reason, message]', ['message', 'ok', 'reason'], fn.VERIFY_SESSION_DENIAL_KEYS.slice().sort())
check('A5', 'action 判别：大小写敏感 / 去空白命中 / 近形不误判', { trimmed: true, plain: true, plural: false, empty: false, other: false }, {
  trimmed: verifyLib.isVerifySessionAction('  verifySession\t'),
  plain: verifyLib.isVerifySessionAction('verifySession'),
  plural: verifyLib.isVerifySessionAction('verifySessions'),
  empty: verifyLib.isVerifySessionAction(''),
  other: verifyLib.isVerifySessionAction('verify')
})

const indexSource = readFileSync(path.join(FN_DIR, 'index.js'), 'utf8')
const indexCode = codeOnly(indexSource)
const dispatchAt = indexCode.indexOf('isVerifySessionAction(action)')
const denyForConfigAt = indexCode.indexOf('if (!config.ready)')
const handleVerifyCallAt = indexCode.indexOf('handleVerify(input, config, context)')
check('A6', '短路位置：`main()` 里 verifySession 分发**先于** config.ready 判定与 handleVerify（＝在任何 authority / op 值域判定之前）', { dispatchFound: true, beforeConfigGate: true, beforeVerify: true }, {
  dispatchFound: dispatchAt !== -1,
  beforeConfigGate: dispatchAt !== -1 && denyForConfigAt !== -1 && dispatchAt < denyForConfigAt,
  beforeVerify: dispatchAt !== -1 && handleVerifyCallAt !== -1 && dispatchAt < handleVerifyCallAt
})

const libCode = codeOnly(readFileSync(path.join(FN_DIR, 'lib', 'verifySession.js'), 'utf8'))
check('A7', '零签发 / 零续期 / 零落盘（**代码面**，注释不计）：无 issueToken / renewed / persist / setOpsDbProvider 引用', { issueToken: 0, renewed: 0, persist: 0, dbProvider: 0 }, {
  issueToken: countIn(libCode, 'issueToken'),
  renewed: countIn(libCode, 'renewed'),
  persist: countIn(libCode, 'persist'),
  dbProvider: countIn(libCode, 'setOpsDbProvider')
})

/* ===========================================================================
  B 段：成功面
  =========================================================================== */
section('B', '成功面：有效令牌 ⇒ 恰 {ok,uid,role}；uid 由独立实现复算一致；admin 令牌；无需 op/payload')

const okRole = await call({ action: 'verifySession', token: VALID })
check('B1', '有效令牌 ⇒ ok:true 且回包键面**恰** ok,role,uid（多一键即红）', { ok: true, shape: 'ok,role,uid' }, { ok: okRole.ok, shape: shapeOf(okRole) })
check('B2', 'uid 逐字 ＝ 独立实现复算（u- ＋ sha256(手机号) 前 16 位）', { uidEqualsIndependent: true, shape: 'u-16hex' }, {
  uidEqualsIndependent: okRole.uid === uidOfIndependent(PHONE),
  shape: /^u-[0-9a-f]{16}$/.test(String(okRole.uid)) ? 'u-16hex' : String(okRole.uid)
})
check('B3', 'role ⇒ 小写封闭二值 user', 'user', okRole.role)

const okAdmin = await call({ action: 'verifySession', token: ADMIN_ROLE })
check('B4', 'admin 角色令牌 ⇒ role:admin（角色取自**已验签**载荷，仍恰 3 键）', { ok: true, role: 'admin', shape: 'ok,role,uid' }, { ok: okAdmin.ok, role: okAdmin.role, shape: shapeOf(okAdmin) })

const minimalEvent = { action: 'verifySession', token: VALID }
const okMinimal = await call(minimalEvent)
check('B5', '无需 payload / op：事件只有 {action, token} 两键即成功（`op` / `payload` 缺位不参与任何判定）', { eventKeys: 'action,token', ok: true, sameUid: true }, {
  eventKeys: Object.keys(minimalEvent).sort().join(','),
  ok: okMinimal.ok,
  sameUid: okMinimal.uid === okRole.uid
})

/* ===========================================================================
  C 段：拒绝面（逐条；回包恒恰 3 键）
  =========================================================================== */
section('C', '拒绝面：过期 ⇒ TOKEN_EXPIRED；篡改 / 错密钥 / ver 不符 / 缺 / 非字符串 / 空串 ⇒ TOKEN_INVALID')

const cExpired = await call({ action: 'verifySession', token: EXPIRED })
check('C1', 'exp 过期 ⇒ reason:TOKEN_EXPIRED（键面恰 message,ok,reason）', { ok: false, reason: 'TOKEN_EXPIRED', shape: 'message,ok,reason' }, { ok: cExpired.ok, reason: cExpired.reason, shape: shapeOf(cExpired) })

const cTamperedSignature = await call({ action: 'verifySession', token: TAMPERED_SIGNATURE })
const cTamperedPayload = await call({ action: 'verifySession', token: TAMPERED_PAYLOAD })
check('C2', '篡改签名一字符 / 篡改载荷一字符 ⇒ 均 TOKEN_INVALID', { signature: 'TOKEN_INVALID', payload: 'TOKEN_INVALID' }, { signature: cTamperedSignature.reason, payload: cTamperedPayload.reason })

const cForeign = await call({ action: 'verifySession', token: FOREIGN_SECRET })
check('C3', '别把密钥签的令牌（密钥不符）⇒ TOKEN_INVALID', 'TOKEN_INVALID', cForeign.reason)

const cVersion = await call({ action: 'verifySession', token: VERSION_MISMATCH })
check('C4', 'ver 与现行版本不符（撤销面）⇒ TOKEN_INVALID', 'TOKEN_INVALID', cVersion.reason)

const cMissing = await call({ action: 'verifySession' })
const cNull = await call({ action: 'verifySession', token: null })
check('C5', '缺 token / token:null ⇒ TOKEN_INVALID', { missing: 'TOKEN_INVALID', null: 'TOKEN_INVALID' }, { missing: cMissing.reason, null: cNull.reason })

const cNumber = await call({ action: 'verifySession', token: 1234567890 })
const cObject = await call({ action: 'verifySession', token: { token: VALID } })
const cArray = await call({ action: 'verifySession', token: [VALID] })
check('C6', '非字符串（number / object / array）⇒ 一律 TOKEN_INVALID（不把怪输入喂进解码器）', { number: 'TOKEN_INVALID', object: 'TOKEN_INVALID', array: 'TOKEN_INVALID' }, { number: cNumber.reason, object: cObject.reason, array: cArray.reason })

const cEmpty = await call({ action: 'verifySession', token: '' })
const cBlank = await call({ action: 'verifySession', token: '   \t ' })
check('C7', '空串 / 纯空白 ⇒ TOKEN_INVALID', { empty: 'TOKEN_INVALID', blank: 'TOKEN_INVALID' }, { empty: cEmpty.reason, blank: cBlank.reason })

const cNotPhone = await call({ action: 'verifySession', token: NOT_PHONE_SUB })
check('C8', 'sub 非手机号 ⇒ TOKEN_INVALID（uid 无法派生 ⇒ 不签发回包）', 'TOKEN_INVALID', cNotPhone.reason)

const cRole = await call({ action: 'verifySession', token: ROLE_OUT_OF_DOMAIN })
check('C9', 'role 越出封闭二值（superadmin）⇒ TOKEN_INVALID', 'TOKEN_INVALID', cRole.reason)

const cThreeSegments = await call({ action: 'verifySession', token: THREE_SEGMENTS })
check('C10', '三段形态（多一个点）⇒ TOKEN_INVALID', 'TOKEN_INVALID', cThreeSegments.reason)

check('C11', '全部拒绝回包键面逐条恰 message,ok,reason（11 个样本一起判）', 11, [cExpired, cTamperedSignature, cTamperedPayload, cForeign, cVersion, cMissing, cNumber, cEmpty, cNotPhone, cRole, cThreeSegments].filter((reply) => shapeOf(reply) === 'message,ok,reason').length)

check('C12', '失败回包 reason 恒 ∈ {TOKEN_INVALID, TOKEN_EXPIRED}（两条之外无第三值）', true, [cExpired, cTamperedSignature, cTamperedPayload, cForeign, cVersion, cMissing, cNull, cNumber, cObject, cArray, cEmpty, cBlank, cNotPhone, cRole, cThreeSegments].every((reply) => reply.reason === 'TOKEN_INVALID' || reply.reason === 'TOKEN_EXPIRED'))

check('C13', '拒绝回包不含内部判别码字面（TOKEN_MALFORMED / TOKEN_BAD_SIGNATURE / TOKEN_VERSION_MISMATCH … 一个都不外泄）', 0, ['TOKEN_MALFORMED', 'TOKEN_BAD_SIGNATURE', 'TOKEN_VERSION_MISMATCH', 'TOKEN_MISSING', 'TOKEN_SUBJECT_MISSING', 'ROLE_NOT_ALLOWED', 'SECRET_MISSING'].filter((detail) => [cExpired, cTamperedSignature, cTamperedPayload, cForeign, cVersion, cMissing, cNotPhone, cRole].some((reply) => JSON.stringify(reply).includes(detail))).length)

/* ===========================================================================
  D 段：零外泄 / 幂等 / **滑动续期未发生** / 内部不可用不伪装
  =========================================================================== */
section('D', '零外泄（手机号 / 令牌片段 / jti）＋ 幂等两次同 uid ＋ 续期计数 0 ＋ 存储读 0 写 0 ＋ 缺密钥不伪装')

const payloadSegment = VALID.split('.')[0]
const signatureSegment = VALID.split('.')[1]
const jtiOfValid = JSON.parse(Buffer.from(payloadSegment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).jti
const replyTexts = [okRole, okAdmin, cExpired, cTamperedSignature, cForeign, cMissing, cNotPhone, cRole].map((reply) => JSON.stringify(reply))
check('D1', '回包序列化里**不含**手机号 / 载荷段 / 签名段 / jti（逐字扫，命中 0）', { phone: 0, payloadSegment: 0, signatureSegment: 0, jti: 0 }, {
  phone: replyTexts.filter((text) => text.includes(PHONE)).length,
  payloadSegment: replyTexts.filter((text) => text.includes(payloadSegment.slice(0, 24))).length,
  signatureSegment: replyTexts.filter((text) => text.includes(signatureSegment.slice(0, 24))).length,
  jti: replyTexts.filter((text) => text.includes(String(jtiOfValid))).length
})

const first = await call({ action: 'verifySession', token: VALID })
const second = await call({ action: 'verifySession', token: VALID })
check('D2', '幂等无副作用：同一令牌连续两次 ⇒ 同一 uid 且回包逐字相同', { uid: uidOfIndependent(PHONE), identical: true }, { uid: first.uid === second.uid ? first.uid : `${first.uid}|${second.uid}`, identical: JSON.stringify(first) === JSON.stringify(second) })

check('D3', '**滑动续期未发生**：整段 verifySession 调用后 `issueToken` 调用计数恒 0（未签发、未续期）', 0, issueTokenCalls)
const issueCallsAtD = issueTokenCalls
check('D4', '**零落盘 / 零读库**：离线假体的 reads / writes 计数恒 0', { reads: 0, writes: 0 }, { reads: store.stats.reads, writes: store.stats.writes })
check('D5', '回包无续期字段（renewedToken / renewedExpiresAt / renewedTtlSeconds 逐条缺位）', { renewedToken: false, renewedExpiresAt: false, renewedTtlSeconds: false }, {
  renewedToken: Object.prototype.hasOwnProperty.call(okRole, 'renewedToken'),
  renewedExpiresAt: Object.prototype.hasOwnProperty.call(okRole, 'renewedExpiresAt'),
  renewedTtlSeconds: Object.prototype.hasOwnProperty.call(okRole, 'renewedTtlSeconds')
})

const savedSecret = process.env.XIAI_USER_TOKEN_SECRET
delete process.env.XIAI_USER_TOKEN_SECRET
const cNoSecret = await call({ action: 'verifySession', token: VALID })
process.env.XIAI_USER_TOKEN_SECRET = savedSecret
check('D6', '缺密钥 ⇒ 内部不可用 STORAGE_UNAVAILABLE（**不伪装 TOKEN_INVALID**，恰 3 键；契约内两支之外唯一一支＝基础设施故障）', { reason: 'STORAGE_UNAVAILABLE', shape: 'message,ok,reason', notDisguised: true }, {
  reason: cNoSecret.reason,
  shape: shapeOf(cNoSecret),
  notDisguised: cNoSecret.reason !== 'TOKEN_INVALID' && cNoSecret.reason !== 'TOKEN_EXPIRED'
})

check('D7', '不被签发面配置连坐：`readVerifyConfig` 只读密钥 / 版本 / 余量（缺短信验证码仍 ready）', { ready: true, version: VERSION }, (() => {
  const narrowed = verifyLib.readVerifyConfig({ XIAI_USER_TOKEN_SECRET: SECRET, XIAI_USER_TOKEN_VERSION: VERSION })
  return { ready: narrowed.ready === true, version: narrowed.version }
})())

/* ===========================================================================
  E 段：既有面不受影响
  =========================================================================== */
section('E', '既有面不受影响：未知 action 仍 FORBIDDEN / 未知 op 仍 INVALID_FIELD / sessionProbe 仍恰 8 键')

const cUnknownAction = await call({ action: 'zzz' })
check('E1', '未知 action 仍走原路：FORBIDDEN ＋ 恰 3 键 ＋ 原文案（不被 verifySession 分支吞掉）', { reason: 'FORBIDDEN', shape: 'message,ok,reason', mentionsUnknown: true }, {
  reason: cUnknownAction.reason,
  shape: shapeOf(cUnknownAction),
  mentionsUnknown: String(cUnknownAction.message).includes('未知的操作')
})

const issued = await call({ action: 'issue', phone: PHONE, code: SMS_CODE })
const cUnknownOp = await call({ action: 'verify', token: issued.token, op: 'no-such-op', payload: {} })
check('E2', 'action:verify 未知 op 仍 INVALID_FIELD（写面值域判定未被改动）', 'INVALID_FIELD', cUnknownOp.reason)

const probe = await call({ action: 'verify', op: 'sessionProbe' })
check('E3', '同一位置的只读诊断 op sessionProbe 仍恰 8 键且 ok:true（未被本单影响）', { ok: true, keys: 8 }, { ok: probe.ok, keys: Object.keys(probe).length })

/* ===========================================================================
  汇总
  =========================================================================== */
console.log(JSON.stringify({
  SUMMARY: {
    total,
    passed,
    failed: failedIds.length,
    failed_ids: failedIds,
    /* 读数（供交付报告）：续期计数 / 存储计数（D 阶段快照 ⇒ 早于 E 段两次真签发） */
    issue_token_calls_during_verify_session: issueCallsAtD,
    store_reads_at_verify_session: store.stats.reads,
    store_writes: store.stats.writes
  }
}))

if (failedIds.length > 0) process.exit(1)
