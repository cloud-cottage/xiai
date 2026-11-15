/**
 * 玺爱 · **自检：斐萃（feicui）设备令牌签发 op**（跨仓契约 §13.2｜本单）
 * ============================================================================
 * **完全离线**：零联网、零真库、零真 CARD（`XIAI_NO_REAL_CARD=1` ＋ DB 注入缝
 * `ops.setOpsDbProvider`）、零部署；断言失败 ⇒ 退出码 1。
 *
 * 真源（跨仓，**不 import feicui 仓任何文件**）：
 *   · `/Users/kevin/bistro/feicui/ops/feicui-sync-20261115/dispatch-zang.md` §13.1 / §13.2 / §13.3；
 *   · 令牌形态 ＝ `token = base64url(payload) + "." + base64url(HMAC_SHA256(payloadSegment, secret))`，
 *     `payload = {v:1, uid, roles[], iat, exp, jti}`（**键序即此**），TTL ＝ 30 天（2,592,000 s），
 *     `base64url` ＝ 标准 base64 去 padding、`+`→`-`、`/`→`_`。
 *   本套件**自己按同一算法验签**（`verifyLikeFeicui`，逐行照 §13.1 ＋ feicui `verifyDeviceToken`
 *   的判据序：形态 → 验签 → 解析 → v → uid → 有效期），故「验签通过」不是自说自话。
 *
 * 覆盖面（A〜H 八段）：
 *   A 常量 / 注册面；B 管理员门（会话路 ＋ 令牌路，**非 admin ⇒ FORBIDDEN 零签发零读**）；
 *   C admin 签发（2 段 / 键序 / TTL / uid 取身份 / roles 小写快照）；
 *   D 篡改一字符 ⇒ 验签失败、过期 ⇒ 失败（边界 `now == exp` 仍有效，与 feicui 同尺）；
 *   E 密钥源（**集合优先 → env 兼底 → 两源皆缺 ⇒ 结构化拒**；「不存在」类降级 vs 真故障上抛）；
 *   F 载荷封闭（未登记键 / 身份类键 ⇒ `INVALID_FIELD`；`device_label` 非字符串 ⇒ `INVALID_VALUE`）；
 *   G 零泄露 ＋ 回包白名单（真密钥串扫回包 / 日志命中 0；挑拣纯函数按 op 收窄；零写零新集合）；
 *   H 端到端（真 `index.js::main` 信封 ＋ 真审计日志：令牌路 admin 签发 / 非 admin 拒绝）。
 *
 * 纪律：**不打印密钥 / 令牌原文**（只给长度与 sha256 前 12 位指纹）；测试密钥与手机号一律
 * 运行期构造（**仓内零密钥字面值**）。
 */
process.env.XIAI_NO_REAL_CARD = '1'

import { createRequire } from 'node:module'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

/* ---------------------------------------------------------------------------
   0. 断言 / 读数
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

function shapeOf(object) {
  return object && typeof object === 'object' ? Object.keys(object).sort().join(',') : String(object)
}

/** 失败回包恒恰 3 键 `{ok:false, reason, message}`。 */
function isDenial(reply) {
  return !!reply && reply.ok === false && shapeOf(reply) === 'message,ok,reason' && typeof reply.reason === 'string' && reply.reason !== ''
}

/* ---------------------------------------------------------------------------
   1. 测试材料（**运行期构造 ⇒ 仓内零密钥字面值**）
   ------------------------------------------------------------------------- */

const SECRET_IN_COLLECTION = randomBytes(32).toString('hex')
const SECRET_IN_ENV = randomBytes(32).toString('hex')
const SECRET_STRANGER = randomBytes(32).toString('hex')
const USER_TOKEN_SECRET = randomBytes(32).toString('hex')
const SMS_CODE = 'code-' + randomBytes(4).toString('hex')
const ADMIN_PHONE = '138' + '00000000'
const OTHER_PHONE = '139' + '11111111'
const NOW = 1_800_000_000
const UID_ADMIN = 'u-' + randomBytes(8).toString('hex')
const UID_OTHER = 'u-' + randomBytes(8).toString('hex')
/* 手机号白名单 env 与用户令牌配置：**离线假值**（真值不在仓内、也不在本进程环境里）。 */
process.env.XIAI_USER_TOKEN_SECRET = USER_TOKEN_SECRET
process.env.XIAI_USER_SMS_CODE = SMS_CODE
process.env.XIAI_ADMIN_PHONE = ADMIN_PHONE
delete process.env.XIAI_SESSION_AUTHORITY /* ⇒ 会话通道 off，走既有令牌路（零联网） */
delete process.env.SHADOW_TOKEN_SECRET /* 每段显式设定，避免继承外部环境 */

/* ---------------------------------------------------------------------------
   2. 离线 DB 注入缝（只读假体；零写、零联网）
   ------------------------------------------------------------------------- */

function createStore() {
  const docs = new Map()
  const state = { errorOnRead: null }
  const stats = { reads: 0, writes: 0, collections: [] }
  const keyOf = (name, id) => `${name}\u0000${id}`
  const provider = () => ({
    collection(name) {
      stats.collections.push(name)
      return {
        doc(id) {
          return {
            async get() {
              stats.reads += 1
              if (state.errorOnRead) throw state.errorOnRead
              const row = docs.get(keyOf(name, id))
              return row === undefined ? { data: [] } : { data: [Object.assign({}, row)] }
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
        }
      }
    }
  })
  return {
    stats,
    state,
    provider,
    put(name, id, row) {
      docs.set(keyOf(name, id), row)
    },
    clearDocs() {
      docs.clear()
    },
    resetStats() {
      stats.reads = 0
      stats.writes = 0
      stats.collections = []
    }
  }
}

const store = createStore()

const ops = require(path.join(FN_DIR, 'lib/ops.js'))
const fn = require(path.join(FN_DIR, 'index.js'))
ops.setOpsDbProvider(store.provider)

/* ---------------------------------------------------------------------------
   3. 按 §13.1 **独立实现**验签（不 import feicui 仓）
   ------------------------------------------------------------------------- */

const B64URL_PATTERN = /^[A-Za-z0-9_-]+$/

function base64urlOf(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(segment) {
  const normalized = String(segment).replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  return Buffer.from(normalized + padding, 'base64')
}

function digestEquals(left, right) {
  const a = createHash('sha256').update(String(left), 'utf8').digest()
  const b = createHash('sha256').update(String(right), 'utf8').digest()
  return a.equals(b)
}

/**
 * feicui-shadow `verifyDeviceToken()` 的**同形离线复刻**（§13.1）：形态 → 验签（先于解析）→
 * 解析 → `v` → `uid` → 有效期（`now > exp` ⇒ 过期；`now + leeway < iat` ⇒ 未生效）。
 * @param {string} token 待验令牌
 * @param {string} secret 密钥
 * @param {number} nowSeconds 服务端时钟
 * @param {number} [leewaySeconds] 时钟容差（缺省 60，与 feicui 同值）
 * @returns {{ok:true, claims:object}|{ok:false, detail:string}}
 */
function verifyLikeFeicui(token, secret, nowSeconds, leewaySeconds) {
  if (!secret) return { ok: false, detail: 'TOKEN_SECRET_MISSING' }
  if (token === undefined || token === null || String(token).trim() === '') return { ok: false, detail: 'TOKEN_MISSING' }
  const parts = String(token).trim().split('.')
  if (parts.length !== 2) return { ok: false, detail: 'TOKEN_MALFORMED' }
  const [payloadSegment, signatureSegment] = parts
  if (!B64URL_PATTERN.test(payloadSegment) || !B64URL_PATTERN.test(signatureSegment)) {
    return { ok: false, detail: 'TOKEN_MALFORMED' }
  }
  /* 验签先于解析载荷（与 feicui 同序）。 */
  const expectedSignature = base64urlOf(createHmac('sha256', String(secret)).update(payloadSegment).digest())
  if (!digestEquals(signatureSegment, expectedSignature)) return { ok: false, detail: 'TOKEN_BAD_SIGNATURE' }
  let claims = null
  try {
    claims = JSON.parse(fromBase64url(payloadSegment).toString('utf8'))
  } catch {
    return { ok: false, detail: 'TOKEN_MALFORMED' }
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return { ok: false, detail: 'TOKEN_MALFORMED' }
  if (claims.v !== 1) return { ok: false, detail: 'TOKEN_MALFORMED' }
  if (!claims.uid || String(claims.uid).trim() === '') return { ok: false, detail: 'TOKEN_SUBJECT_MISSING' }
  const iat = Number(claims.iat)
  const exp = Number(claims.exp)
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return { ok: false, detail: 'TOKEN_MALFORMED' }
  const leeway = Number.isFinite(Number(leewaySeconds)) ? Math.max(0, Math.floor(Number(leewaySeconds))) : 60
  if (nowSeconds > exp) return { ok: false, detail: 'TOKEN_EXPIRED' }
  if (nowSeconds + leeway < iat) return { ok: false, detail: 'TOKEN_NOT_YET_VALID' }
  return { ok: true, claims }
}

/** 只解码载荷段（**不验签**；给键序 / 键集断言用）。 */
function decodeClaimsOf(token) {
  const segment = String(token).split('.')[0]
  return JSON.parse(fromBase64url(segment).toString('utf8'))
}

/** 载荷段原文（键序按 JSON 文本逐字看）。 */
function payloadRawOf(token) {
  return fromBase64url(String(token).split('.')[0]).toString('utf8')
}

/* ---------------------------------------------------------------------------
   4. 身份面（服务端派生；**载荷里的 uid / role 一律不采信**）
   ------------------------------------------------------------------------- */

const OP = 'issueFeicuiDeviceToken'
const SESSION = 'SESSION'
const SERVER_TOKEN = 'SERVER_TOKEN'

const identitySessionAdmin = Object.freeze({ uid: UID_ADMIN, phone: '', role: 'admin', identity_source: SESSION })
const identitySessionUser = Object.freeze({ uid: UID_OTHER, phone: '', role: 'user', identity_source: SESSION })
const identityTokenAdmin = Object.freeze({ uid: UID_ADMIN, phone: ADMIN_PHONE, role: 'user', identity_source: SERVER_TOKEN })
const identityTokenOther = Object.freeze({ uid: UID_OTHER, phone: OTHER_PHONE, role: 'user', identity_source: SERVER_TOKEN })

function contextOf(adminPhone, nowSeconds) {
  return { adminPhone: adminPhone === undefined ? ADMIN_PHONE : adminPhone, nowSeconds: nowSeconds === undefined ? NOW : nowSeconds }
}

/** 直接调 op（绕过信封；`OPS` 表成员 —— 与 `index.js` 分发的同一函数）。 */
async function callOp(payload, identity, context) {
  return await ops.OPS[OP](payload, identity, context)
}

/* ===========================================================================
  A 段：常量 / 注册面
  =========================================================================== */
section('A', '常量与注册面：TTL 30 天 / 载荷封闭恰一键 / op 已在册 / 回包白名单在册')

check('A1', 'TTL 常量 ＝ 2,592,000 s（30 天，§13.1 冻结）', 2592000, ops.FEICUI_DEVICE_TOKEN_TTL_SECONDS)
check('A2', '载荷封闭键面恰 [device_label]（身份类键一律不在面内）', ['device_label'], ops.FEICUI_DEVICE_TOKEN_ALLOWED_KEYS.slice())
check('A3', '`issueFeicuiDeviceToken` 在 `OPS` 注册面且在册为函数', 'function', typeof ops.OPS[OP])
check('A4', '兼底 env 名逐字 ＝ SHADOW_TOKEN_SECRET（与 feicui-shadow 同名）', 'SHADOW_TOKEN_SECRET', ops.FEICUI_DEVICE_TOKEN_SECRET_ENV)
check('A5', '`index.js` 回包白名单常量恰 [token, expires_at]（只对这一个 op）', ['token', 'expires_at'], fn.FEICUI_DEVICE_TOKEN_READOUT_KEYS.slice())
check('A6', '白名单挑拣纯函数已导出', 'function', typeof fn.pickFeicuiDeviceTokenReadouts)

/* ===========================================================================
  B 段：管理员门（非 admin ⇒ FORBIDDEN ＋ 零签发、零读）
  =========================================================================== */
section('B', '管理员门：非 admin（令牌路 / 会话路）⇒ FORBIDDEN ＋ 零签发 ＋ 零读密钥')

store.clearDocs()
store.put('xiai_server_secrets', 'shadow_token', { _id: 'shadow_token', secret: SECRET_IN_COLLECTION })
store.resetStats()

{
  const deniedByPhone = await callOp({}, identityTokenOther, contextOf())
  check('B1', '令牌路（手机号不在 XIAI_ADMIN_PHONE 白名单）⇒ FORBIDDEN', 'FORBIDDEN', deniedByPhone.reason)
  check('B1b', '拒绝形状恰 3 键 {ok, reason, message}', true, isDenial(deniedByPhone))
  check('B1c', '**零签发**（回包无 token / expires_at）', [], ['token', 'expires_at'].filter((key) => key in deniedByPhone))
  check('B1d', '**零读**：门在密钥读点之前（假 DB 读数 0）', 0, store.stats.reads)

  const deniedByRole = await callOp({}, identitySessionUser, contextOf())
  check('B2', '会话路（xiai_roles 角色 user）⇒ FORBIDDEN', 'FORBIDDEN', deniedByRole.reason)
  check('B2b', '拒绝形状恰 3 键', true, isDenial(deniedByRole))
  check('B2c', '零读（会话路同样不读密钥）', 0, store.stats.reads)

  /* 载荷完全不参与判权：夹带 uid / role 也仍是 FORBIDDEN（不是 INVALID_FIELD —— 门在前）。 */
  const spoof = await callOp({ uid: UID_ADMIN, role: 'admin' }, identityTokenOther, contextOf())
  check('B3', '非 admin 载荷夹带 uid / role ⇒ 仍 FORBIDDEN（**载荷零参与判权**、门先于键面）', 'FORBIDDEN', spoof.reason)

  /* 缺 adminPhone 白名单 ⇒ 结构化拒绝（**不得因未配置而放行、也不得伪装 FORBIDDEN**）。 */
  const noWhitelist = await callOp({}, identityTokenAdmin, contextOf(''))
  check('B4', '缺 XIAI_ADMIN_PHONE（令牌路）⇒ STORAGE_UNAVAILABLE（不误报 FORBIDDEN）', 'STORAGE_UNAVAILABLE', noWhitelist.reason)
  check('B4b', '缺白名单 ⇒ 零签发 ＋ 零读', true, !('token' in noWhitelist) && store.stats.reads === 0)

  /* 无身份（无 uid）⇒ FORBIDDEN（管理员门不会因缺身份而放行）。 */
  const noIdentity = await callOp({}, Object.freeze({ uid: '', phone: ADMIN_PHONE, role: 'admin', identity_source: SERVER_TOKEN }), contextOf())
  check('B5', '无 uid 的身份 ⇒ 结构化拒绝（非 2xx、非签发）', false, noIdentity.ok === true)
  check('B5b', '拒绝形状恰 3 键 ＋ 零签发', true, isDenial(noIdentity) && !('token' in noIdentity))
}

/* ===========================================================================
  C 段：admin 签发（2 段 / 键序 / TTL / uid 与 roles 取自身份）
  =========================================================================== */
section('C', 'admin 签发：恰 2 段令牌 / 载荷键序 v,uid,roles,iat,exp,jti / exp-iat ＝ 2,592,000')

let issued = null
{
  store.resetStats()
  issued = await callOp({ device_label: 'kevin-macbook' }, identitySessionAdmin, contextOf())
  check('C1', 'admin（会话路角色 admin）⇒ ok:true', true, issued.ok === true)
  check('C1b', '成功回包**键面恰** ok + token + expires_at', 'expires_at,ok,token', shapeOf(issued))
  check('C2', '令牌恰 2 段（base64url 段，无 padding）', true, (() => {
    const parts = String(issued.token || '').split('.')
    return parts.length === 2 && parts.every((part) => B64URL_PATTERN.test(part) && part.indexOf('=') === -1)
  })())

  const verified = verifyLikeFeicui(issued.token, SECRET_IN_COLLECTION, NOW)
  check('C3', '按 §13.1 独立验签（feicui verifyDeviceToken 同形）⇒ 通过', true, verified.ok === true)
  const claims = verified.ok ? verified.claims : {}
  check('C4', '载荷键序逐字 ＝ v,uid,roles,iat,exp,jti', 'v,uid,roles,iat,exp,jti', Object.keys(decodeClaimsOf(issued.token)).join(','))
  check('C5', '`v` ＝ 1（格式版本）', 1, claims.v)
  check('C6', '`uid` ＝ 服务端派生身份 uid（非载荷）', UID_ADMIN, claims.uid)
  check('C7', '`roles` ＝ 身份角色的**小写快照**', ['admin'], claims.roles)
  check('C8', 'TTL：exp − iat ＝ 2,592,000 s', 2592000, Number(claims.exp) - Number(claims.iat))
  check('C9', '`iat` ＝ 服务端时钟（context.nowSeconds）', NOW, claims.iat)
  check('C10', '`jti` 形态（uuid v4 样式）', true, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(claims.jti)))
  check('C11', '`expires_at` ＝ exp 的 ISO 时刻', new Date(Number(claims.exp) * 1000).toISOString(), issued.expires_at)
  check('C12', '`device_label` **不进令牌载荷**（载荷键面已冻结）', [], Object.keys(claims).filter((key) => key === 'device_label'))
  check('C13', '令牌路 admin（手机号白名单）亦签发成功（roles 快照 ＝ user，仅供审计）', true, await (async () => {
    const viaToken = await callOp({}, identityTokenAdmin, contextOf())
    const v = verifyLikeFeicui(viaToken.token, SECRET_IN_COLLECTION, NOW)
    return viaToken.ok === true && v.ok === true && JSON.stringify(v.claims.roles) === JSON.stringify(['user'])
  })())
  check('C14', '两次签发 `jti` 不同（每次随机 uuid）', true, claims.jti !== decodeClaimsOf((await callOp({}, identitySessionAdmin, contextOf())).token).jti)
  check('C15', '签发面**零落盘**（假 DB 零写）', 0, store.stats.writes)
}

/* ===========================================================================
  D 段：篡改 / 过期（与 feicui 同尺）
  =========================================================================== */
section('D', '篡改一字符 ⇒ 验签失败；过期 ⇒ 失败（now == exp 仍有效，边界与 feicui 同尺）')

{
  const token = issued.token
  const tamperTail = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A')
  check('D1', '篡改**签名段**末字符 ⇒ 验签失败', 'TOKEN_BAD_SIGNATURE', verifyLikeFeicui(tamperTail, SECRET_IN_COLLECTION, NOW).detail)

  const parts = token.split('.')
  const at = Math.floor(parts[0].length / 2)
  const flipped = parts[0].slice(0, at) + (parts[0][at] === 'A' ? 'B' : 'A') + parts[0].slice(at + 1)
  check('D2', '篡改**载荷段**一字符 ⇒ 验签失败（不签不解析）', 'TOKEN_BAD_SIGNATURE', verifyLikeFeicui(`${flipped}.${parts[1]}`, SECRET_IN_COLLECTION, NOW).detail)

  const claims = decodeClaimsOf(token)
  check('D3', '过期（now ＝ exp + 1）⇒ TOKEN_EXPIRED', 'TOKEN_EXPIRED', verifyLikeFeicui(token, SECRET_IN_COLLECTION, Number(claims.exp) + 1).detail)
  check('D4', '边界（now ＝ exp）⇒ 仍有效', true, verifyLikeFeicui(token, SECRET_IN_COLLECTION, Number(claims.exp)).ok === true)
  check('D5', '换一把密钥验 ⇒ 验签失败', 'TOKEN_BAD_SIGNATURE', verifyLikeFeicui(token, SECRET_STRANGER, NOW).detail)
  check('D6', '`now − 120 s`（早于 iat 且超 60 s 容差）⇒ 未生效', 'TOKEN_NOT_YET_VALID', verifyLikeFeicui(token, SECRET_IN_COLLECTION, NOW - 120).detail)
}

/* ===========================================================================
  E 段：密钥源（集合优先 → env 兼底 → 两源皆缺 ⇒ 结构化拒）
  =========================================================================== */
section('E', '密钥源：集合 xiai_server_secrets.shadow_token.secret 优先 / SHADOW_TOKEN_SECRET 兼底 / 皆缺 ⇒ 拒')

{
  /* E1 集合优先：集合与 env 各给一把，令牌必须能用**集合那把**验过、env 那把验不过。 */
  store.clearDocs()
  store.put('xiai_server_secrets', 'shadow_token', { _id: 'shadow_token', secret: SECRET_IN_COLLECTION })
  process.env.SHADOW_TOKEN_SECRET = SECRET_IN_ENV
  const bothPresent = await callOp({}, identitySessionAdmin, contextOf())
  check('E1', '两源并存 ⇒ 用**集合**密钥签发（集合值验过）', true, verifyLikeFeicui(bothPresent.token, SECRET_IN_COLLECTION, NOW).ok === true)
  check('E1b', '两源并存 ⇒ env 值验不过（证明确实没走 env）', 'TOKEN_BAD_SIGNATURE', verifyLikeFeicui(bothPresent.token, SECRET_IN_ENV, NOW).detail)

  /* E2 env 兼底：集合无该文档（回空）⇒ 用 env 值签发。 */
  store.clearDocs()
  const envOnly = await callOp({}, identitySessionAdmin, contextOf())
  check('E2', '集合无 shadow_token 文档 ⇒ 回落 env 并签发成功', true, envOnly.ok === true && verifyLikeFeicui(envOnly.token, SECRET_IN_ENV, NOW).ok === true)

  /* E3 「集合不存在」类错误 ⇒ 视为缺席、继续兼底（不把配置面缺集合当硬故障）。 */
  store.clearDocs()
  store.state.errorOnRead = Object.assign(new Error('Db or Table not exist'), { code: 'DATABASE_COLLECTION_NOT_EXIST' })
  const collectionMissing = await callOp({}, identitySessionAdmin, contextOf())
  store.state.errorOnRead = null
  check('E3', '读集合报「集合不存在」⇒ 降级为缺席并回落 env（签发成功）', true, collectionMissing.ok === true && verifyLikeFeicui(collectionMissing.token, SECRET_IN_ENV, NOW).ok === true)

  /* E4 非「不存在」类真故障 ⇒ 照旧上抛（**绝不吞成「缺密钥」**）。 */
  store.clearDocs()
  store.state.errorOnRead = Object.assign(new Error('injected-storage-failure'), { code: 'DATABASE_REQUEST_FAILED' })
  let thrown = null
  try {
    await callOp({}, identitySessionAdmin, contextOf())
  } catch (error) {
    thrown = error && error.message ? error.message : 'thrown'
  }
  store.state.errorOnRead = null
  check('E4', '读密钥遇真故障 ⇒ 上抛（由 index.js 转 STORAGE_UNAVAILABLE，不吞成「无密钥」）', 'injected-storage-failure', thrown)

  /* E5 两源皆缺 ⇒ 结构化拒绝 + 零签发。 */
  store.clearDocs()
  delete process.env.SHADOW_TOKEN_SECRET
  const secretMissing = await callOp({}, identitySessionAdmin, contextOf())
  check('E5', '两源皆缺 ⇒ STORAGE_UNAVAILABLE（结构化拒绝、不猜默认值）', 'STORAGE_UNAVAILABLE', secretMissing.reason)
  check('E5b', '两源皆缺 ⇒ 恰 3 键 ＋ 零签发', true, isDenial(secretMissing) && !('token' in secretMissing))
  check('E5c', '两源皆缺 ⇒ 拒绝文案点名密钥来源（可排障），且不含任何密钥值', true,
    secretMissing.message.indexOf('shadow_token') !== -1 &&
    secretMissing.message.indexOf('SHADOW_TOKEN_SECRET') !== -1 &&
    secretMissing.message.indexOf(SECRET_IN_COLLECTION) === -1 &&
    secretMissing.message.indexOf(SECRET_IN_ENV) === -1)
  check('E5d', '两源皆缺 ⇒ 零写', 0, store.stats.writes)
}

/* ===========================================================================
  F 段：载荷封闭
  =========================================================================== */
section('F', '载荷封闭：未登记键 / 身份类键 ⇒ INVALID_FIELD；device_label 非字符串 ⇒ INVALID_VALUE')

{
  store.clearDocs()
  store.put('xiai_server_secrets', 'shadow_token', { _id: 'shadow_token', secret: SECRET_IN_COLLECTION })

  const unknown = await callOp({ device_label: 'x', uid: UID_OTHER }, identitySessionAdmin, contextOf())
  check('F1', '载荷含**未登记键**（uid）⇒ INVALID_FIELD ＋ 零签发', 'INVALID_FIELD', unknown.reason)
  check('F1b', '文案点出身份类字段口径（服务端派生、不采信前端自称）', true, String(unknown.message).indexOf('身份類欄位') !== -1)

  const unknownPlain = await callOp({ anything: 1 }, identitySessionAdmin, contextOf())
  check('F2', '载荷含普通未登记键 ⇒ INVALID_FIELD', 'INVALID_FIELD', unknownPlain.reason)

  const badLabel = await callOp({ device_label: 123 }, identitySessionAdmin, contextOf())
  check('F3', 'device_label 非字符串 ⇒ INVALID_VALUE', 'INVALID_VALUE', badLabel.reason)

  const longLabel = await callOp({ device_label: 'x'.repeat(200) }, identitySessionAdmin, contextOf())
  check('F4', 'device_label 超长（>120 字）⇒ INVALID_VALUE', 'INVALID_VALUE', longLabel.reason)

  const nullPayload = await callOp(null, identitySessionAdmin, contextOf())
  check('F5', '载荷非物件（null）⇒ INVALID_FIELD', 'INVALID_FIELD', nullPayload.reason)

  const arrayPayload = await callOp([], identitySessionAdmin, contextOf())
  check('F6', '载荷非物件（数组）⇒ INVALID_FIELD', 'INVALID_FIELD', arrayPayload.reason)

  const emptyPayload = await callOp({}, identitySessionAdmin, contextOf())
  const emptyLabel = await callOp({ device_label: '' }, identitySessionAdmin, contextOf())
  check('F7', '缺省 / 空串 device_label 均放行（可空）', true, emptyPayload.ok === true && emptyLabel.ok === true)
  check('F8', '以上四类拒绝 ⇒ 零签发', true, [unknown, unknownPlain, badLabel, longLabel, nullPayload, arrayPayload].every((reply) => isDenial(reply) && !('token' in reply)))
}

/* ===========================================================================
  G 段：零泄露 ＋ 回包白名单 ＋ 零写零新集合
  =========================================================================== */
section('G', '零泄露：真密钥串扫回包 / 日志命中 0；白名单按 op 收窄；零写零新集合')

/** 捕获 `console.*`（日志单点 `lib/log.js` 的落点）⇒ 供密钥扫描。 */
async function withCapturedConsole(run) {
  const lines = []
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  const push = (...args) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : safeJson(arg))).join(' '))
  }
  console.log = push
  console.warn = push
  console.error = push
  console.info = push
  let result = null
  try {
    result = await run()
  } finally {
    console.log = saved.log
    console.warn = saved.warn
    console.error = saved.error
    console.info = saved.info
  }
  return { lines, result }
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function secretHits(text, secrets) {
  const haystack = String(text === undefined || text === null ? '' : text)
  return secrets.filter((secret) => secret && haystack.indexOf(secret) !== -1).length
}

const ALL_TEST_SECRETS = [SECRET_IN_COLLECTION, SECRET_IN_ENV, SECRET_STRANGER, USER_TOKEN_SECRET]

{
  store.clearDocs()
  store.put('xiai_server_secrets', 'shadow_token', { _id: 'shadow_token', secret: SECRET_IN_COLLECTION })
  process.env.SHADOW_TOKEN_SECRET = SECRET_IN_ENV
  store.resetStats()

  const captured = await withCapturedConsole(async () => {
    const ok = await callOp({ device_label: 'kevin-macbook' }, identitySessionAdmin, contextOf())
    const denied = await callOp({}, identityTokenOther, contextOf())
    const badField = await callOp({ uid: UID_OTHER }, identitySessionAdmin, contextOf())
    const clockless = await callOp({}, identitySessionAdmin, { adminPhone: ADMIN_PHONE, nowSeconds: NaN })
    return { ok, denied, badField, clockless }
  })

  const success = captured.result.ok
  check('G1', '成功回包序列化后**零密钥**（三把真密钥串扫描命中 0）', 0, secretHits(safeJson(success), ALL_TEST_SECRETS))
  check('G1b', '失败回包（FORBIDDEN / INVALID_FIELD / 时钟不可用）**零密钥**', 0,
    secretHits([captured.result.denied, captured.result.badField, captured.result.clockless].map(safeJson).join('\n'), ALL_TEST_SECRETS))
  check('G1c', 'op 期间日志（console 捕获）**零密钥**', 0, secretHits(captured.lines.join('\n'), ALL_TEST_SECRETS))
  check('G1d', '成功回包不含 `jti` / `uid` / `roles` 等内部声明（键面封闭）', [], ['jti', 'uid', 'roles', 'claims', 'plan'].filter((key) => key in success))
  check('G1e', '时钟不可用（nowSeconds 非数）⇒ STORAGE_UNAVAILABLE ＋ 零签发', 'STORAGE_UNAVAILABLE', captured.result.clockless.reason)

  /* 回包白名单：只对这一个 op 生效，其余 op 一个键都不外泄。 */
  const picked = fn.pickFeicuiDeviceTokenReadouts(OP, success)
  check('G2', '挑拣纯函数（本 op）恰拾 token ＋ expires_at', 'expires_at,token', shapeOf(picked))
  check('G2b', '其余 op（含登录签发面的 token）一律零外泄 ⇒ null', [null, null, null, null],
    ['submitCorrection', 'ai-enhance-face', 'verify', undefined].map((opName) => fn.pickFeicuiDeviceTokenReadouts(opName, success)))
  check('G2c', '非物件 / 空结果 ⇒ 空拾取（不抛）', '{}', safeJson(fn.pickFeicuiDeviceTokenReadouts(OP, null)))

  check('G3', '本 op **零写**（假 DB 写计数 0）', 0, store.stats.writes)
  check('G4', '本 op 只读一个集合：xiai_server_secrets（零新集合）', ['xiai_server_secrets'], Array.from(new Set(store.stats.collections)))
}

/* ===========================================================================
  H 段：端到端（真 `index.js::main` 信封 ＋ 真审计日志）
  =========================================================================== */
section('H', '端到端：index.js::main（令牌路）admin ⇒ 信封带 token / expires_at；非 admin ⇒ FORBIDDEN 零签发')

{
  store.clearDocs()
  store.put('xiai_server_secrets', 'shadow_token', { _id: 'shadow_token', secret: SECRET_IN_COLLECTION })
  process.env.SHADOW_TOKEN_SECRET = SECRET_IN_ENV
  store.resetStats()

  const adminLogin = await fn.main({ action: 'issue', phone: ADMIN_PHONE, code: SMS_CODE })
  const otherLogin = await fn.main({ action: 'issue', phone: OTHER_PHONE, code: SMS_CODE })
  check('H1', '前置：管理员手机号可登录（离线假验证码）', true, adminLogin.ok === true && typeof adminLogin.token === 'string')

  let readsBeforeOther = 0
  const captured = await withCapturedConsole(async () => {
    const adminCall = await fn.main({ action: 'verify', token: adminLogin.token, op: OP, payload: { device_label: 'kevin-pc' } })
    readsBeforeOther = store.stats.reads
    const otherCall = await fn.main({ action: 'verify', token: otherLogin.token, op: OP, payload: {} })
    return { adminCall, otherCall, readsAfterOther: store.stats.reads }
  })
  const envelope = captured.result.adminCall
  const deniedEnvelope = captured.result.otherCall

  check('H2', '信封：admin 调 ⇒ ok:true 且带 token / expires_at', true, envelope.ok === true && typeof envelope.token === 'string' && typeof envelope.expires_at === 'string')
  const envelopeVerified = verifyLikeFeicui(envelope.token, SECRET_IN_COLLECTION, envelope.serverNow)
  check('H2b', '信封里的令牌按 §13.1 验签通过', true, envelopeVerified.ok === true)
  check('H2c', '信封令牌 exp − iat ＝ 2,592,000 s', 2592000, envelopeVerified.ok ? Number(envelopeVerified.claims.exp) - Number(envelopeVerified.claims.iat) : -1)
  check('H2d', '信封 token 的 uid ＝ 登录派生 uid（u- 前缀派生，非客户端自称）', true, /^u-[0-9a-f]+$/.test(String(envelopeVerified.ok ? envelopeVerified.claims.uid : '')))
  check('H3', '信封 JSON **零密钥**（三把真密钥串命中 0）', 0, secretHits(safeJson(envelope), ALL_TEST_SECRETS))
  check('H4', '信封期间日志（audit / op.done）**零密钥**', 0, secretHits(captured.lines.join('\n'), ALL_TEST_SECRETS))
  check('H5', '信封期间日志**不回吐令牌原文**', 0, secretHits(captured.lines.join('\n'), [envelope.token]))
  check('H6', '非 admin（另一手机号）走信封 ⇒ FORBIDDEN ＋ 恰 3 键 ＋ 零 token 键', true,
    deniedEnvelope.ok === false && isDenial(deniedEnvelope) && !('token' in deniedEnvelope))
  check('H7', '非 admin 请求 ⇒ **零读密钥**（该次调用读数增量 0）', 0, captured.result.readsAfterOther - readsBeforeOther)
  check('H8', '信封路径同样**零写**', 0, store.stats.writes)
}

/* ---------------------------------------------------------------------------
   收尾：注入缝恢复未注入态（零残留）
   ------------------------------------------------------------------------- */
ops.setOpsDbProvider(null)
delete process.env.SHADOW_TOKEN_SECRET

console.log(
  JSON.stringify({
    summary: {
      total,
      passed,
      failed: total - passed,
      failed_ids: failedIds,
      sections: sectionStats,
      /* 读数面（**零密钥 / 零令牌原文**：只给指纹与长度）。 */
      readout: {
        token: { length: issued && issued.token ? issued.token.length : 0, fingerprint: issued && issued.token ? fingerprint(issued.token) : '' },
        collection_secret_fingerprint: fingerprint(SECRET_IN_COLLECTION),
        env_secret_fingerprint: fingerprint(SECRET_IN_ENV),
        ttl_seconds: ops.FEICUI_DEVICE_TOKEN_TTL_SECONDS
      }
    }
  })
)

if (failedIds.length > 0) process.exitCode = 1
