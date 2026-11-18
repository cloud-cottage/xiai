/**
 * 玺爱 · **自检：斐萃桌面版「登錄即授權」通道（168 小時會話 ＋ JS 橋交付）**
 * ============================================================================
 * 本单三处被测件：
 *   · `cloudfunctions/xiai-user-token/lib/ops.js` —— `issueFeicuiDeviceToken` 新增**可选**
 *     载荷 `ttl_seconds`（整数，允许区间 `[300, 604800]`；缺省仍是 30 天；非整数 / 越界
 *     ⇒ `INVALID_VALUE` ＋ 零签发）；
 *   · `src/services/feicui.js` —— `issueDeviceToken({ttlSeconds})` ＋ 宿主桥探测 / 交付
 *     （`feicuiHostBridgeOf` / `deliverTokenToHost`；pywebview → wails → 通用 → 回退複製）；
 *   · `src/views/ConnectFeicuiView.vue` —— `/connect` 第二个按钮「為斐翠桌面簽發 168 小時會話」
 *     （与 30 天按钮**并存**），交付成功即清掉页面明文，并写明「若刷新本頁需重新登錄後再簽」。
 *
 * 硬事实（决定设计，不得绕）：`/connect` 的 OTP 登录用 `persistence:'none'` ⇒ 手机号会话只在
 *   页面内存、刷新即丢 ⇒ 签发必须与登录**同一页面加载**；API Key 网关丢弃自定义头 ⇒
 *   令牌只能走 body 级字段（本单即载荷 `ttl_seconds`）。
 *
 * **完全离线**：零联网（传输层假件 `setCloudFunctionTransport`）、零真库（`setOpsDbProvider`
 *   只读假体）、零浏览器、零部署、零写被测仓库任何文件。**不打印令牌原文**（只给长度与指纹）。
 *   断言失败 ⇒ 退出码 1。
 *
 * 覆盖面（A〜G 七段）：
 *   A 常量面（可执行）：缺省 30 天 / 会话 168 小时 / 区间 [300, 604800]；越界与非整数一律 `null`。
 *   B 服务层（可执行）：缺省载荷逐字 `{}`；604800 ⇒ `{ttl_seconds:604800}`；299 / 604801 / 1.5 /
 *     '604800' ⇒ `INVALID_VALUE` ＋ **零往返**；非管理員 ⇒ `NOT_ADMIN` ＋ 零往返。
 *   C 服务端 op（可执行）：缺省 `exp−iat ＝ 2,592,000`；604800 / 300 逐值；越界 / 非整数
 *     ⇒ `INVALID_VALUE` ＋ **零读密钥**；非 admin 夹带 ttl ⇒ 仍是 `FORBIDDEN`（门先）。
 *   D 宿主橋（可执行，注入假 window）：无桥 ⇒ 回退；pywebview → wails → 通用三路；优先级；
 *     参数形状 `(token, {expires_at, ttl_seconds})`；桥抛错 ⇒ **不丢令牌**；全程零存储 / 零 URL / 零日志。
 *   E 页面契约（静态）：第二按钮 / 并存 / 首行 admin 守卫 / TTL 604800 / 交付后清 DOM /
 *     已交付块零令牌绑定 / 刷新提示文案 / 零持久层 / 刷新无残留。
 *   F 登录即自动签发（可执行）：挂载探测 / 自动签发 604800 / 无会话出内嵌表单 / 登录成功即签 / 幂等 /
 *     失败不静默 / 匿名平台会话不算登录态。
 *   **G 凭据携带（本单根因修复｜可执行）**：`action:'verify'` 的请求体必须**顶层带 `token`**
 *     （xiai 用户令牌）—— 服务端只认「网关注入的平台会话」或 `event.token`；`/connect` 的 OTP 会话
 *     在 `persistence:'none'` 实例里 ⇒ 网关看不见，缺 `token` 就是「未攜帶有效令牌」
 *     （真机复现多次）。故：先取票（管道复用 / 用平台会话来换）⇒ 再由管道携带；
 *     取票失败（未登录 / 无平台会话 / 取票抛错）⇒ `LOGIN_REQUIRED` ＋ **零请求**；
 *     两处 `action:'verify'`（`issueFeicuiDeviceToken` / `issueFeicuiToken`）同形。
 *   **H 续签凭据三源（本单修订｜可执行）**：`refresh_token` 逐源尝试 —— ① `getSession().data.session`、
 *     ② `getLoginState().credentials`、③ 同一实例再 `getSession()` 的备用形状；`phone` 同样多源；
 *     命中源落 `meta.renewal_source`（封闭四值 `session`/`loginState`/`fallback`/`none`，**只作诊断**）；
 *     三源全空 ⇒ 空串且**不阻断交付**；含凭据时桥 `meta` 带 `refresh_token` 且**不上屏**。
 *
 * 用法：node scripts/verify-feicui-app-bridge.mjs
 */
process.env.XIAI_NO_REAL_CARD = '1'
/* 服务端 op 的令牌路白名单：**离线假值**（真值不在仓内）。会话路强制 off ⇒ 零联网。 */
process.env.XIAI_ADMIN_PHONE = '138' + '00000000'
delete process.env.XIAI_SESSION_AUTHORITY
delete process.env.SHADOW_TOKEN_SECRET

import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const require = createRequire(import.meta.url)

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
  return object && typeof object === 'object' ? Object.keys(object).sort() : []
}

function shapeOf(object) {
  return object && typeof object === 'object' ? Object.keys(object).sort().join(',') : String(object)
}

/** 失败回包恒恰 3 键 `{ok:false, reason, message}`。 */
function isDenial(reply) {
  return !!reply && reply.ok === false && shapeOf(reply) === 'message,ok,reason' && typeof reply.reason === 'string' && reply.reason !== ''
}

function countIn(source, needle) {
  if (!source || !needle) return 0
  return source.split(needle).length - 1
}

/** 去注释（`//` 行注释 ＋ `/* *\/` 块注释 ＋ `<!-- -->` 模板注释），静态判据一律在去注释后的码面上跑。 */
function stripComments(source) {
  return String(source)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** 按花括号配平切出顶层函数体。 */
function functionBody(source, name) {
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

/* ---------------------------------------------------------------------------
   1. 真件载入
   ------------------------------------------------------------------------- */

const { setCloudFunctionTransport } = await import(path.join(ROOT, 'src/data/cloudbaseFn.js'))
/* **写入口形态覆盖**：本段要观察「请求体到底发了什么」⇒ 必须走云端形态
   （`local-dev` 下管道会短路、零往返 —— 那是 dev 形态的既有语义，不是本单的被测面）。 */
const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
writeFace.setWriteFaceModeOverride('cloud')
const cloudbaseAuth = await import(path.join(ROOT, 'src/data/cloudbaseAuth.js'))
const userTokenSvc = await import(path.join(ROOT, 'src/services/userToken.js'))
const feicuiSvc = await import(path.join(ROOT, 'src/services/feicui.js'))
const session = await import(path.join(ROOT, 'src/data/session.js'))

const ops = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))

const VIEW_REL = 'src/views/ConnectFeicuiView.vue'
const viewRaw = readFileSync(path.join(ROOT, VIEW_REL), 'utf8')
const viewSrc = stripComments(viewRaw)

/**
 * 取视图里 `Object.freeze({…})` 形态的常量**真值**（逐字求值，不在套件里另抄一份枚举
 * —— 抄的那份永远会和产品漂移）。
 * @param {string} name
 */
function frozenLiteralOf(name) {
  const marker = `const ${name} = Object.freeze(`
  const at = VIEW_SCRIPT_SRC.indexOf(marker)
  if (at < 0) throw new Error(`MISSING_CONSTANT:${name}`)
  const open = at + marker.length - 1
  let depth = 0
  let i = open
  for (; i < VIEW_SCRIPT_SRC.length; i += 1) {
    if (VIEW_SCRIPT_SRC[i] === '(' || VIEW_SCRIPT_SRC[i] === '{' || VIEW_SCRIPT_SRC[i] === '[') depth += 1
    else if (VIEW_SCRIPT_SRC[i] === ')' || VIEW_SCRIPT_SRC[i] === '}' || VIEW_SCRIPT_SRC[i] === ']') {
      depth -= 1
      if (depth === 0) break
    }
  }
  const source = VIEW_SCRIPT_SRC.slice(open + 1, i)     // `Object.freeze(` 之后、配对 `)` 之前
  return new Function(`return (${source})`)()
}

/* ---------------------------------------------------------------------------
   2. 假传输（**零联网**）：记录每一次往返的形状
   ---------------------------------------------------------------------------
   本单起有**两类**往返（同一函数名 `xiai-user-token`）：
     · `{action:'issue', phone, platformAccessToken}` —— 令牌管道**取票**；
     · `{action:'verify', token, op, payload}`        —— **携带令牌**的签发（被测面）。
   ⇒ 假件按 `action` 分流：取票回一枚**用户令牌**（`USER_TOKEN`），verify 回设备令牌。
   ------------------------------------------------------------------------- */

const TOKEN = 'tok-' + randomBytes(24).toString('hex')
const EXPIRES_AT = '2026-11-17T18:00:00.000Z'
/* 用户令牌（**运行期随机构造**；只在断言里比对，不打印原文）。 */
const USER_TOKEN = 'v1.' + randomBytes(36).toString('base64url') + '.' + randomBytes(32).toString('base64url')
const PLATFORM_ACCESS_TOKEN = 'plat-' + randomBytes(18).toString('hex')
const TICKET_DENIED_MESSAGE = '平台憑證不被認可；請重新登錄。'

const transportCalls = []
/** 取票回包的形态：`ok` / `denied` / `down`。 */
let ticketMode = 'ok'
/** 当前「页面里有没有 OTP 平台会话」：`ok` / `none` / `throw`。 */
let platformSessionMode = 'ok'

cloudbaseAuth.setOtpAuthProvider(async () => ({
  async getSession() {
    if (platformSessionMode === 'throw') throw new Error('SESSION_READ_BOOM')
    if (platformSessionMode === 'none') return { data: { session: null } }
    return { data: { session: { access_token: PLATFORM_ACCESS_TOKEN } } }
  }
}))

setCloudFunctionTransport(async (name, data) => {
  transportCalls.push({ name, data })
  if (data && data.action === 'issue') {
    if (ticketMode === 'denied') return { result: { ok: false, reason: 'FORBIDDEN', message: TICKET_DENIED_MESSAGE } }
    if (ticketMode === 'down') return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '取票不可用（自檢假件）。' }
    return {
      result: {
        ok: true,
        token: USER_TOKEN,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        sub: '13800000000',
        uid: 'u-' + '0'.repeat(16),
        ver: 'v1'
      }
    }
  }
  /* 角色令牌（`issueFeicuiToken`）的成功回包是「权威行 `row`」；设备令牌是顶层 `token/expires_at`。 */
  if (data && data.op === 'issueFeicuiToken') {
    return {
      result: {
        ok: true,
        row: {
          token: TOKEN,
          uid: 'u-' + '0'.repeat(16),
          role: 'user',
          kid: 'kid-selfcheck',
          jti: 'jti-selfcheck',
          exp: Math.floor(Date.now() / 1000) + 604800,
          expires_at: EXPIRES_AT,
          ttl_seconds: 604800
        }
      }
    }
  }
  return { result: { ok: true, token: TOKEN, expires_at: EXPIRES_AT } }
})

const ADMIN_USER = { id: 'u-' + '0'.repeat(16), phone: '13800000000', role: 'admin', nickname: '自檢管理員' }
const PLAIN_USER = { id: 'u-' + '1'.repeat(16), phone: '13900000000', role: 'user', nickname: '自檢用戶' }
session.setUser(ADMIN_USER)

/** 往返读数：`verify` 那几次（签发本体）与全部往返分开数。 */
function verifyCallsOf() {
  return transportCalls.filter((call) => call.data && call.data.action === 'verify')
}

/** 一次服务层签发的读数（verify 往返次数 / 事件载荷 / 回包键面）。 */
async function issueViaService(ttlSeconds) {
  transportCalls.length = 0
  const reply = ttlSeconds === undefined ? await feicuiSvc.issueDeviceToken() : await feicuiSvc.issueDeviceToken({ ttlSeconds })
  const verifyCalls = verifyCallsOf()
  const event = (verifyCalls[verifyCalls.length - 1] || {}).data || {}
  return { reply, calls: verifyCalls.length, callsTotal: transportCalls.length, event, payload: event.payload }
}

/* **取票预热**：本单起签发前必须先有一枚可携带的用户令牌（这是修复本身）。
   先走一次管道取票 ⇒ B 段每一条只观察「verify 往返」，不被取票那一次干扰；
   「无票 ⇒ 先取票」由 G 段单独钉（那里会清票后重测）。 */
const warmed = await userTokenSvc.ensureUserWriteSession(PLATFORM_ACCESS_TOKEN)

/* ===========================================================================
   A 段：常量面
   =========================================================================== */
section('A', '常量面：缺省 30 天 / 会话 168 小时 / 允许区间 [300, 604800]')

{
  const ttl = feicuiSvc.FEICUI_DEVICE_TTL || {}
  check('A1', '`FEICUI_DEVICE_TTL` 四值逐字：缺省 2,592,000 / 会话 604,800 / 下限 300 / 上限 604,800', { defaultSeconds: 2592000, sessionSeconds: 604800, minSeconds: 300, maxSeconds: 604800 }, {
    defaultSeconds: ttl.defaultSeconds,
    sessionSeconds: ttl.sessionSeconds,
    minSeconds: ttl.minSeconds,
    maxSeconds: ttl.maxSeconds
  })
  check('A2', '缺省（键缺席 / `null`）⇒ 30 天（既有行为不变）', [2592000, 2592000], [
    feicuiSvc.deviceTtlSecondsOf(undefined),
    feicuiSvc.deviceTtlSecondsOf(null)
  ])
  check('A3', '边界接受：300 与 604,800 原值返回（不夹取、不改写）', [300, 604800], [
    feicuiSvc.deviceTtlSecondsOf(300),
    feicuiSvc.deviceTtlSecondsOf(604800)
  ])
  check('A4', '越界拒绝：299 / 604,801 ⇒ `null`（边界外一位即拒）', [null, null], [
    feicuiSvc.deviceTtlSecondsOf(299),
    feicuiSvc.deviceTtlSecondsOf(604801)
  ])
  check('A5', '非整数拒绝：1.5 / 字符串 `"604800"` / `NaN` ⇒ `null`（不字符串转数、不四捨五入）', [null, null, null], [
    feicuiSvc.deviceTtlSecondsOf(1.5),
    feicuiSvc.deviceTtlSecondsOf('604800'),
    feicuiSvc.deviceTtlSecondsOf(Number.NaN)
  ])
}

/* ===========================================================================
   B 段：服务层（可执行）
   =========================================================================== */
section('B', '服务层：缺省载荷 `{}` / 604800 ⇒ `{ttl_seconds:604800}` / 越界 ⇒ INVALID_VALUE 零往返')

{
  const plain = await issueViaService(undefined)
  check('B0', '取票预热成功（管道里有一枚可携带的用户令牌）⇒ B 段的往返读数只含「携带」那一次', { ok: true, present: true }, {
    ok: warmed.ok,
    present: userTokenSvc.hasUserToken()
  })
  check('B1', '缺省签发：载荷**逐字**仍是 `{}`（服务端 30 天缺省）＋ 往返恰 1 次', { keys: [], json: '{}', calls: 1 }, {
    keys: Object.keys(plain.payload || {}),
    json: JSON.stringify(plain.payload),
    calls: plain.calls
  })
  check('B1a', '**请求体顶层携带用户令牌**：键面恰 4 键 `{action, op, payload, token}`，且 `token` 与取票结果**逐字相同**（只报长度与指纹）', { keys: ['action', 'op', 'payload', 'token'], tokenLen: USER_TOKEN.length, tokenFp: fingerprint(USER_TOKEN) }, {
    keys: Object.keys(plain.event || {}).sort(),
    tokenLen: String((plain.event || {}).token || '').length,
    tokenFp: fingerprint((plain.event || {}).token || '')
  })
  check('B1b', '事件形状沿用既有信封：`op` 逐字 ＋ 回包恰 3 键 `{ok, token, expires_at}`', { op: 'issueFeicuiDeviceToken', keys: ['expires_at', 'ok', 'token'] }, {
    op: plain.event.op,
    keys: sorted(plain.reply)
  })

  const session8h = await issueViaService(604800)
  check('B2', '168 小時會話：载荷恰一键 `{ttl_seconds:604800}`（body 级字段；网关丢头也不受影响）', { json: '{"ttl_seconds":604800}', calls: 1 }, {
    json: JSON.stringify(session8h.payload),
    calls: session8h.calls
  })
  check('B2b', '604800 签发回包仍恰 3 键、令牌逐字透传（只报长度与指纹）', { keys: ['expires_at', 'ok', 'token'], len: TOKEN.length, fp: fingerprint(TOKEN) }, {
    keys: sorted(session8h.reply),
    len: String(session8h.reply.token || '').length,
    fp: fingerprint(session8h.reply.token || '')
  })

  const under = await issueViaService(299)
  check('B3', '299 ⇒ 本层前置 `INVALID_VALUE` ＋ **零往返** ＋ 回包无 `token` 键', { reason: 'INVALID_VALUE', calls: 0, hasToken: false }, {
    reason: under.reply.reason,
    calls: under.calls,
    hasToken: 'token' in under.reply
  })
  const atMin = await issueViaService(300)
  check('B4', '300（下限）⇒ 放行，载荷 `{ttl_seconds:300}`', { ok: true, json: '{"ttl_seconds":300}' }, { ok: atMin.reply.ok, json: JSON.stringify(atMin.payload) })
  const atMax = await issueViaService(604800)
  check('B5', '604,800（上限）⇒ 放行，载荷 `{ttl_seconds:604800}`', { ok: true, json: '{"ttl_seconds":604800}' }, { ok: atMax.reply.ok, json: JSON.stringify(atMax.payload) })
  const over = await issueViaService(604801)
  check('B6', '604,801 ⇒ `INVALID_VALUE` ＋ 零往返', { reason: 'INVALID_VALUE', calls: 0 }, { reason: over.reply.reason, calls: over.calls })
  const fraction = await issueViaService(1.5)
  check('B7', '1.5 ⇒ `INVALID_VALUE` ＋ 零往返（不做四捨五入）', { reason: 'INVALID_VALUE', calls: 0 }, { reason: fraction.reply.reason, calls: fraction.calls })
  const asString = await issueViaService('604800')
  check('B8', '字符串 `"604800"` ⇒ `INVALID_VALUE` ＋ 零往返（不静默转数）', { reason: 'INVALID_VALUE', calls: 0 }, { reason: asString.reply.reason, calls: asString.calls })

  session.setUser(PLAIN_USER)
  const notAdmin = await issueViaService(604800)
  session.setUser(ADMIN_USER)
  check('B9', '非管理員 ＋ 168 小時 ⇒ `NOT_ADMIN` ＋ **零往返** ＋ 回包无 `token` 键', { reason: 'NOT_ADMIN', calls: 0, hasToken: false }, {
    reason: notAdmin.reply.reason,
    calls: notAdmin.calls,
    hasToken: 'token' in notAdmin.reply
  })
}

/* ===========================================================================
   C 段：服务端 op（真 `ops.OPS` ＋ 只读假 DB）
   =========================================================================== */
section('C', '服务端 op：缺省 2,592,000 / 604800 / 300 / 604800 / 越界 INVALID_VALUE 零读密钥 / 非 admin FORBIDDEN')

/** 只读假 DB（零写、零联网）：`xiai_server_secrets/shadow_token` 回一行假密钥。 */
function createStore() {
  const docs = new Map()
  const stats = { reads: 0, writes: 0 }
  const keyOf = (name, id) => `${name}\u0000${id}`
  const provider = () => ({
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              stats.reads += 1
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
    provider,
    put(name, id, row) {
      docs.set(keyOf(name, id), row)
    },
    reset() {
      stats.reads = 0
      stats.writes = 0
    }
  }
}

const SECRET = randomBytes(32).toString('hex')
const store = createStore()
store.put('xiai_server_secrets', 'shadow_token', { _id: 'shadow_token', secret: SECRET })
ops.setOpsDbProvider(store.provider)

const ADMIN_PHONE = '138' + '00000000'
const OTHER_PHONE = '139' + '11111111'
const NOW = 1_800_000_000
const UID_ADMIN = 'u-' + randomBytes(8).toString('hex')
const UID_OTHER = 'u-' + randomBytes(8).toString('hex')
const OP = 'issueFeicuiDeviceToken'
const IDENTITY_ADMIN = Object.freeze({ uid: UID_ADMIN, phone: ADMIN_PHONE, role: 'user', identity_source: 'SERVER_TOKEN' })
const IDENTITY_OTHER = Object.freeze({ uid: UID_OTHER, phone: OTHER_PHONE, role: 'user', identity_source: 'SERVER_TOKEN' })
const contextOf = () => ({ adminPhone: ADMIN_PHONE, nowSeconds: NOW })

/** 只解码载荷段（**不验签**；给 TTL 读数用）。 */
function claimsOf(token) {
  const segment = String(token).split('.')[0]
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  return JSON.parse(Buffer.from(normalized + padding, 'base64').toString('utf8'))
}

async function callOp(payload, identity) {
  store.reset()
  const reply = await ops.OPS[OP](payload, identity, contextOf())
  return { reply, reads: store.stats.reads, writes: store.stats.writes }
}

{
  const plain = await callOp({}, IDENTITY_ADMIN)
  check('C1', '缺省载荷 ⇒ 仍签 30 天（`exp − iat ＝ 2,592,000`）', { ok: true, ttl: 2592000 }, {
    ok: plain.reply.ok,
    ttl: Number(claimsOf(plain.reply.token).exp) - Number(claimsOf(plain.reply.token).iat)
  })
  const session8h = await callOp({ ttl_seconds: 604800 }, IDENTITY_ADMIN)
  check('C2', '`ttl_seconds: 604800` ⇒ `exp − iat ＝ 604,800`（168 小時）', { ok: true, ttl: 604800 }, {
    ok: session8h.reply.ok,
    ttl: Number(claimsOf(session8h.reply.token).exp) - Number(claimsOf(session8h.reply.token).iat)
  })
  check('C2b', '成功回包仍**恰 3 键** `{ok, token, expires_at}`（不新增读数键）', 'expires_at,ok,token', shapeOf(session8h.reply))
  check('C2c', '`expires_at` ＝ `iat + ttl` 的同一时钟换算（本地化 ISO 串）', new Date((NOW + 604800) * 1000).toISOString(), session8h.reply.expires_at)

  const atMin = await callOp({ ttl_seconds: 300 }, IDENTITY_ADMIN)
  check('C3', '下限 300 ⇒ 放行（`exp − iat ＝ 300`）', { ok: true, ttl: 300 }, {
    ok: atMin.reply.ok,
    ttl: Number(claimsOf(atMin.reply.token).exp) - Number(claimsOf(atMin.reply.token).iat)
  })
  const atMax = await callOp({ ttl_seconds: 604800 }, IDENTITY_ADMIN)
  check('C4', '上限 604,800 ⇒ 放行（`exp − iat ＝ 604,800`）', { ok: true, ttl: 604800 }, {
    ok: atMax.reply.ok,
    ttl: Number(claimsOf(atMax.reply.token).exp) - Number(claimsOf(atMax.reply.token).iat)
  })

  const under = await callOp({ ttl_seconds: 299 }, IDENTITY_ADMIN)
  const over = await callOp({ ttl_seconds: 604801 }, IDENTITY_ADMIN)
  check('C5', '299 / 604,801 ⇒ `INVALID_VALUE` ＋ 拒绝形状恰 3 键 ＋ **零读密钥 / 零写**', {
    under: { reason: 'INVALID_VALUE', denial: true, reads: 0, writes: 0 },
    over: { reason: 'INVALID_VALUE', denial: true, reads: 0, writes: 0 }
  }, {
    under: { reason: under.reply.reason, denial: isDenial(under.reply), reads: under.reads, writes: under.writes },
    over: { reason: over.reply.reason, denial: isDenial(over.reply), reads: over.reads, writes: over.writes }
  })
  const fraction = await callOp({ ttl_seconds: 1.5 }, IDENTITY_ADMIN)
  const asString = await callOp({ ttl_seconds: '604800' }, IDENTITY_ADMIN)
  const asNull = await callOp({ ttl_seconds: null }, IDENTITY_ADMIN)
  check('C6', '1.5 / `"604800"` ⇒ `INVALID_VALUE` 零读；`null` ＝ 键缺席 ⇒ 仍放行（30 天）', {
    fraction: 'INVALID_VALUE',
    asString: 'INVALID_VALUE',
    fractionReads: 0,
    asStringReads: 0,
    nullOk: true,
    nullTtl: 2592000
  }, {
    fraction: fraction.reply.reason,
    asString: asString.reply.reason,
    fractionReads: fraction.reads,
    asStringReads: asString.reads,
    nullOk: asNull.reply.ok,
    nullTtl: asNull.reply.ok ? Number(claimsOf(asNull.reply.token).exp) - Number(claimsOf(asNull.reply.token).iat) : 0
  })

  const other = await callOp({ ttl_seconds: 604800 }, IDENTITY_OTHER)
  check('C7', '非 admin 夹带 `ttl_seconds` ⇒ 仍 `FORBIDDEN`（管理员门**先于**载荷键面）＋ 零读密钥 ＋ 零签发', { reason: 'FORBIDDEN', reads: 0, hasToken: false }, {
    reason: other.reply.reason,
    reads: other.reads,
    hasToken: 'token' in other.reply
  })
  check('C8', '越界 / 非整数 / 越权四条拒绝回包内 `token` / `expires_at` 键命中 0（零泄漏、零签发）', 0, [under, over, fraction, asString, other].filter((item) => 'token' in item.reply || 'expires_at' in item.reply).length)
}

/* ===========================================================================
   D 段：宿主橋（可执行，注入假 window）
   =========================================================================== */
section('D', '宿主橋：pywebview → wails → 通用 → 回退複製；参数形状；桥抛错不丢令牌；零存储零 URL 零日志')

/** 造一个假宿主；`mode` ∈ pywebview / wails / generic / throw / none。 */
function fakeHost(mode) {
  const record = { pywebview: [], wails: [], generic: [] }
  const host = { location: { href: 'https://xiai.example/connect', search: '', hash: '' }, history: { pushState: 0, replaceState: 0 } }
  if (mode === 'pywebview' || mode === 'throw') {
    host.pywebview = {
      api: {
        receive_feicui_token(token, meta) {
          record.pywebview.push({ token, meta })
          if (mode === 'throw') throw new Error('BRIDGE_BOOM')
          return 'ok'
        }
      }
    }
  }
  if (mode === 'wails' || mode === 'priority') {
    host.wails = {
      receive_feicui_token(token, meta) {
        record.wails.push({ token, meta })
        return 'ok'
      }
    }
  }
  if (mode === 'generic' || mode === 'priority') {
    host.receive_feicui_token = function receive(token, meta) {
      record.generic.push({ token, meta })
      return 'ok'
    }
  }
  if (mode === 'priority') {
    host.pywebview = {
      api: {
        receive_feicui_token(token, meta) {
          record.pywebview.push({ token, meta })
          return 'ok'
        }
      }
    }
  }
  return { host, record }
}

const META = { expires_at: EXPIRES_AT, ttl_seconds: 604800 }

{
  const absent = fakeHost('none')
  const noBridge = await feicuiSvc.deliverTokenToHost(TOKEN, META, absent.host)
  check('D1', '无宿主橋 ⇒ `{delivered:false, reason:"BRIDGE_ABSENT"}`（调用方回退一键複製）', { delivered: false, reason: 'BRIDGE_ABSENT' }, noBridge)
  check('D1b', '无橋时不误调用任何全局函数（三路计数器全 0）', { pywebview: 0, wails: 0, generic: 0 }, {
    pywebview: absent.record.pywebview.length,
    wails: absent.record.wails.length,
    generic: absent.record.generic.length
  })

  const py = fakeHost('pywebview')
  const viaPy = await feicuiSvc.deliverTokenToHost(TOKEN, META, py.host)
  const pyCall = py.record.pywebview[0] || {}
  check('D2', 'pywebview ⇒ 交付成功 ＋ 恰 1 次调用', { delivered: true, reason: 'DELIVERED', calls: 1 }, {
    delivered: viaPy.delivered,
    reason: viaPy.reason,
    calls: py.record.pywebview.length
  })
  check('D2b', '参数形状逐字 `(token, {expires_at, ttl_seconds})`；令牌逐字透传（只报长度与指纹）', {
    tokenLen: TOKEN.length,
    tokenFp: fingerprint(TOKEN),
    metaKeys: ['expires_at', 'ttl_seconds'],
    expires_at: EXPIRES_AT,
    ttl_seconds: 604800
  }, {
    tokenLen: String(pyCall.token || '').length,
    tokenFp: fingerprint(pyCall.token || ''),
    metaKeys: sorted(pyCall.meta),
    expires_at: (pyCall.meta || {}).expires_at,
    ttl_seconds: (pyCall.meta || {}).ttl_seconds
  })

  const priority = fakeHost('priority')
  const viaPriority = await feicuiSvc.deliverTokenToHost(TOKEN, META, priority.host)
  check('D3', '优先级：三路并存 ⇒ 只走 pywebview（wails / 通用计数 0）', { delivered: true, pywebview: 1, wails: 0, generic: 0 }, {
    delivered: viaPriority.delivered,
    pywebview: priority.record.pywebview.length,
    wails: priority.record.wails.length,
    generic: priority.record.generic.length
  })

  const wails = fakeHost('wails')
  const viaWails = await feicuiSvc.deliverTokenToHost(TOKEN, META, wails.host)
  check('D4', '无 pywebview ⇒ 回退 wails（`wails.receive_feicui_token`）', { delivered: true, wails: 1 }, {
    delivered: viaWails.delivered,
    wails: wails.record.wails.length
  })

  const generic = fakeHost('generic')
  const viaGeneric = await feicuiSvc.deliverTokenToHost(TOKEN, META, generic.host)
  check('D5', '两路都无 ⇒ 回退通用全局函数 `receive_feicui_token`', { delivered: true, generic: 1 }, {
    delivered: viaGeneric.delivered,
    generic: generic.record.generic.length
  })

  const boom = fakeHost('throw')
  const viaBoom = await feicuiSvc.deliverTokenToHost(TOKEN, META, boom.host)
  check('D6', '橋抛错 ⇒ 结构化 `BRIDGE_FAILED`（不抛出、不吞成已交付）', { delivered: false, reason: 'BRIDGE_FAILED' }, viaBoom)
  const boomCall = boom.record.pywebview[0] || {}
  check('D6b', '橋抛错 ⇒ **令牌不丢**：桥收到的令牌与调用方逐字同一枚（回退一键複製仍是这枚），且桥确实被调过 1 次', {
    sameToken: true,
    sameLen: TOKEN.length,
    calls: 1
  }, {
    sameToken: fingerprint(boomCall.token || '') === fingerprint(TOKEN),
    sameLen: String(boomCall.token || '').length,
    calls: boom.record.pywebview.length
  })

  /* **零持久层 / 零 URL / 零日志**：三路交付全过程中，四类存储与 console 命中必须为 0。 */
  const hits = { localStorage: 0, sessionStorage: 0, indexedDB: 0, cookie: 0, console: 0, url: 0 }
  const originals = {
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    consoleLog: console.log,
    consoleWarn: console.warn,
    consoleError: console.error
  }
  const storageSpy = (counter) => ({
    getItem() {
      counter.hits += 1
      return null
    },
    setItem() {
      counter.hits += 1
    },
    removeItem() {
      counter.hits += 1
    },
    clear() {
      counter.hits += 1
    }
  })
  const lsCounter = { hits: 0 }
  const ssCounter = { hits: 0 }
  Object.defineProperty(globalThis, 'localStorage', { value: storageSpy(lsCounter), configurable: true, writable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: storageSpy(ssCounter), configurable: true, writable: true })
  globalThis.indexedDB = {
    open() {
      hits.indexedDB += 1
    }
  }
  console.log = () => {
    hits.console += 1
  }
  console.warn = () => {
    hits.console += 1
  }
  console.error = () => {
    hits.console += 1
  }
  const urlBefore = { href: py.host.location.href, search: py.host.location.search, hash: py.host.location.hash }
  try {
    for (const host of [py.host, wails.host, generic.host, boom.host, absent.host]) {
      await feicuiSvc.deliverTokenToHost(TOKEN, META, host)
    }
  } finally {
    console.log = originals.consoleLog
    console.warn = originals.consoleWarn
    console.error = originals.consoleError
    if (originals.localStorage) Object.defineProperty(globalThis, 'localStorage', originals.localStorage)
    else delete globalThis.localStorage
    if (originals.sessionStorage) Object.defineProperty(globalThis, 'sessionStorage', originals.sessionStorage)
    else delete globalThis.sessionStorage
    delete globalThis.indexedDB
  }
  const urlAfter = { href: py.host.location.href, search: py.host.location.search, hash: py.host.location.hash }
  check('D7', '五路交付全过程：本地存儲 / 會話存儲 / IndexedDB / cookie / console / URL 写入命中全 0（正对照见 D7b）', {
    localStorage: 0, sessionStorage: 0, indexedDB: 0, cookie: 0, console: 0, url: 0
  }, {
    localStorage: lsCounter.hits,
    sessionStorage: ssCounter.hits,
    indexedDB: hits.indexedDB,
    cookie: hits.cookie,
    console: hits.console,
    url: urlBefore.href === urlAfter.href && urlBefore.search === urlAfter.search && urlBefore.hash === urlAfter.hash ? 0 : 1
  })

  /* 正对照：把**同一个**计数器交给一次真实写入 ⇒ 必须 +1（否则 D7 的「全 0」可能只是探针坏了）。 */
  const probeCounter = { hits: 0 }
  const probeStorage = storageSpy(probeCounter)
  probeStorage.setItem('probe', '1')
  check('D7b', '正对照：同一计数器对一次真实 `setItem` 必 +1（探测器有效，非恒 0）', 1, probeCounter.hits)

  /* 默认宿主（不注入）＝ `window`：置一个全局 window.pywebview ⇒ 必须被走到。 */
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const globalRecord = []
  Object.defineProperty(globalThis, 'window', {
    value: { pywebview: { api: { receive_feicui_token(token, meta) { globalRecord.push({ token, meta }) } } } },
    configurable: true,
    writable: true
  })
  const viaGlobalWindow = await feicuiSvc.deliverTokenToHost(TOKEN, META)
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else delete globalThis.window
  check('D8', '缺省宿主 ＝ 全局 `window`（不注入第三参也能交付）：`window.pywebview.api.receive_feicui_token` 被走到 1 次', { delivered: true, calls: 1, ttl: 604800 }, {
    delivered: viaGlobalWindow.delivered,
    calls: globalRecord.length,
    ttl: (globalRecord[0] || {}).meta ? globalRecord[0].meta.ttl_seconds : 0
  })
}

/* ===========================================================================
   E 段：页面契约（静态｜去注释后的码面）
   =========================================================================== */
section('E', '/connect 页面契约：第二按钮（168 小時）/ 并存 / admin 守卫 / 交付后清 DOM / 刷新提示 / 零持久层')

{
  const panelAt = viewSrc.indexOf('data-feicui-device-panel')
  const panelEndAt = panelAt < 0 ? -1 : viewSrc.indexOf('</section>', panelAt)
  const panelSrc = panelAt < 0 || panelEndAt < 0 ? '' : viewSrc.slice(panelAt, panelEndAt + '</section>'.length)
  const scriptSrc = viewSrc.slice(viewSrc.indexOf('<script setup>'), viewSrc.indexOf('</script>'))
  const sessionBody = functionBody(scriptSrc, 'onIssueSessionToken')

  check('E1', '第二按钮钩子 `data-action="feicui-device-issue-session"` 恰 1 处且在面板内', { all: 1, inPanel: 1 }, {
    all: countIn(viewSrc, 'data-action="feicui-device-issue-session"'),
    inPanel: countIn(panelSrc, 'data-action="feicui-device-issue-session"')
  })
  check('E1b', '按钮文案逐字「為斐翠桌面簽發 168 小時會話」（在按钮表达式内恰 1 处；面板其余文案只作指引可复述）', 1, countIn(panelSrc, ": '為斐翠桌面簽發 168 小時會話' }}"))
  check('E1c', '两枚并存：30 天按钮 `data-action="feicui-device-issue"` 仍在（面板内恰 1 处）', 1, countIn(panelSrc, 'data-action="feicui-device-issue"'))
  check('E2', '面板内全部 `<button>` 均 `type="button"`（不发隐式 submit）', true, (panelSrc.match(/<button\b[^>]*>/g) || []).every((tag) => tag.includes('type="button"')))
  check('E3', '动作首行即 admin 守卫 ＋ 在途去重（`if (!admin.value) return` / `if (deviceBusy.value) return`）', true, /^\{\s*if \(!admin\.value\) return/.test(sessionBody) && sessionBody.indexOf('if (deviceBusy.value) return') > 0)
  check('E3b', '签前先清（`clearDeviceToken()` 出现在 `await issueDeviceToken(` **之前**）', true, (() => {
    const clearAt = sessionBody.indexOf('clearDeviceToken()')
    const awaitAt = sessionBody.indexOf('await issueDeviceToken(')
    return clearAt >= 0 && awaitAt >= 0 && clearAt < awaitAt
  })())
  check('E4', 'TTL 走单一常量：`issueDeviceToken({ ttlSeconds: DEVICE_SESSION_TTL_SECONDS })`，且该常量 ＝ `FEICUI_DEVICE_TTL.sessionSeconds`（604,800）', {
    callSite: 1,
    constantBinding: 1,
    constantValue: 604800
  }, {
    callSite: countIn(sessionBody, 'ttlSeconds: DEVICE_SESSION_TTL_SECONDS'),
    constantBinding: countIn(scriptSrc, 'const DEVICE_SESSION_TTL_SECONDS = FEICUI_DEVICE_TTL.sessionSeconds'),
    constantValue: feicuiSvc.FEICUI_DEVICE_TTL.sessionSeconds
  })
  check('E5', '交付顺序：签发 → 持有 → `deliverTokenToHost(` → 失败即早退（不改令牌）→ 成功才置「已交付」并 `clearDeviceToken()`', {
    deliverAfterHold: true,
    earlyReturnOnUndelivered: true,
    deliveredFlagBeforeClear: true
  }, (() => {
    const holdAt = sessionBody.indexOf('deviceToken.value = {')
    const deliverAt = sessionBody.indexOf('await deliverTokenToHost(')
    const flagAt = sessionBody.indexOf('deviceDelivered.value = true')
    const clearAt = sessionBody.lastIndexOf('clearDeviceToken()')
    const guardAt = sessionBody.indexOf('if (!delivery.delivered) return')
    return {
      deliverAfterHold: holdAt >= 0 && deliverAt > holdAt,
      earlyReturnOnUndelivered: guardAt > deliverAt && guardAt < flagAt,
      deliveredFlagBeforeClear: flagAt > 0 && clearAt > flagAt
    }
  })())
  check('E6', '交付元数据逐字 `{expires_at, ttl_seconds}`（桥侧契约；ttl 仍为同一常量）', { expires_at: 1, ttl: 1 }, {
    expires_at: countIn(sessionBody, 'expires_at: reply.expires_at'),
    ttl: countIn(sessionBody, 'ttl_seconds: DEVICE_SESSION_TTL_SECONDS')
  })
  const deliveredAt = viewSrc.indexOf('data-feicui-device-delivered')
  const deliveredEnd = deliveredAt < 0 ? -1 : viewSrc.indexOf('</section>', deliveredAt)
  const deliveredSrc = deliveredAt < 0 || deliveredEnd < 0 ? '' : viewSrc.slice(deliveredAt, deliveredEnd)
  check('E7', '已交付块 `data-feicui-device-delivered` 恰 1 处、文案含「已交付桌面版」、**零令牌绑定**（该块到面板末之间零 `deviceToken` ⇒ 交付后 DOM 无明文）', { all: 1, text: 1, tokenBindings: 0 }, {
    all: countIn(viewSrc, 'data-feicui-device-delivered'),
    text: countIn(viewSrc, '已交付桌面版'),
    tokenBindings: countIn(deliveredSrc, 'deviceToken')
  })
  check('E8', '令牌上屏仍**恰 1 处**（`:value="deviceToken.token"` 唯一文本域），且令牌块由 `v-if="deviceToken"` 控制 ⇒ 交付后整块收掉', { bindings: 1, gate: 1 }, {
    bindings: countIn(viewSrc, ':value="deviceToken.token"'),
    gate: countIn(panelSrc, '<div v-if="deviceToken" class="token-box" data-feicui-device-token-box>')
  })
  check('E9', '刷新提示文案逐字在面板内（OTP 会话只在内存 ⇒ 刷新需重新登录后再签）', true, panelSrc.indexOf('若刷新本頁需重新登錄後再簽') !== -1)
  const storKeys = ['localStorage', 'sessionStorage', 'indexedDB', 'cookie', 'console.', 'location', 'history', 'pushState', 'replaceState', 'getItem']
  const storHits = storKeys.reduce((acc, key) => {
    acc[key] = countIn(viewSrc, key)
    return acc
  }, {})
  check('E10', '视图码面零持久层 / 零日志 / 零 URL 写入（含 `getItem` 读回）：九键命中全 0', true, Object.values(storHits).every((value) => value === 0))
  console.log(JSON.stringify({ readout: 'E10 逐键读数', storHits }))
  check('E11', '刷新无残留：`const deviceToken = ref(null)` 恰 1 处（初值 null，无任何「从存储复活令牌」的代码路径）', { ref: 1, restoreHits: 0 }, {
    ref: countIn(scriptSrc, 'const deviceToken = ref(null)'),
    restoreHits: countIn(scriptSrc, 'deviceToken.value = JSON.parse') + countIn(scriptSrc, 'getItem')
  })
}

/* ===========================================================================
   F 段：登录即自动签发（**可执行**：把视图里的真函数体逐字抽出来，注入假 refs / 假服务）
   ---------------------------------------------------------------------------
   为什么不另起一个 `verify-*.mjs`：仓内 `verify-ai-relay` 的 F4 是**套件计数哨兵**，
   新增一个脚本必然顶红 ⇒ 本段并入既有套件（同批 +15 条，总数 52 → 67）。
   =========================================================================== */
section('F', '登录即自动签发：挂载探测 ⇒ 自动签发 ttl=604800 / 无会话 ⇒ 内嵌登录表单 / 登录成功即签 / 幂等 / 失败不静默')

const VIEW_SCRIPT_SRC = viewSrc.slice(viewSrc.indexOf('<script setup>'), viewSrc.indexOf('</script>'))

/** 取视图里某个顶层函数的**完整源码**（含签名与形参，逐字；取不到即抛 ⇒ 判据不静默跳过）。 */
function sourceOf(name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const match = re.exec(VIEW_SCRIPT_SRC)
  if (!match) throw new Error(`MISSING_FUNCTION_SOURCE:${name}`)
  const open = VIEW_SCRIPT_SRC.indexOf('{', match.index)
  let depth = 0
  let i = open
  for (; i < VIEW_SCRIPT_SRC.length; i += 1) {
    if (VIEW_SCRIPT_SRC[i] === '{') depth += 1
    else if (VIEW_SCRIPT_SRC[i] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return VIEW_SCRIPT_SRC.slice(match.index, i + 1)
}

/** 仅取函数体（静态判据用：数钩子 / 判顺序）。 */
function bodyOf(name) {
  const source = sourceOf(name)
  return source.slice(source.indexOf('{'))
}

/** 读视图里的**数字常量**（`const NAME = 50`）—— 判据不复制常量值（改动即被看见）。 */
function numberLiteralOf(name) {
  const match = new RegExp(`const ${name} = (\\d+)`).exec(VIEW_SCRIPT_SRC)
  if (!match) throw new Error(`MISSING_CONSTANT:${name}`)
  return Number(match[1])
}

function makeRef(initial) {
  return { value: initial }
}

/**
 * 把真函数**源码**编成可调用体：自由变量（refs / 服务）由参数名注入，
 * 函数自身的形参（如 `ready` / `reply`）留在源码里 ⇒ 不需要复制任何实现。
 */
function compileFn(name, names) {
  const source = sourceOf(name)
  return new Function(...names, `return function (...args) { return (${source}).apply(undefined, args) }`)
}

/**
 * 最小运行时（**只注入假 refs / 假服务**；四个被测函数体逐字取自 SFC，不复制实现）。
 * @param {{admin?:boolean, signedIn?:boolean, otpToken?:string, issueReply?:object,
 *          delivery?:object, loginReply?:object, phone?:string, code?:string}} [options]
 */
function buildViewRuntime(options) {
  const opts = options || {}
  const refs = {
    admin: makeRef(opts.admin === undefined ? true : opts.admin),
    deviceBusy: makeRef(false),
    deviceError: makeRef(''),
    deviceCopied: makeRef(false),
    deviceDelivered: makeRef(false),
    deviceToken: makeRef(null),
    signedIn: makeRef(opts.signedIn === undefined ? true : opts.signedIn),
    autoIssueAttempted: makeRef(false),
    sessionProbing: makeRef(true),
    otpSessionPresent: makeRef(false),
    loginRequired: makeRef(false),
    loginPhone: makeRef(opts.phone === undefined ? '' : opts.phone),
    loginCode: makeRef(opts.code === undefined ? '123456' : opts.code),
    loginBusy: makeRef(false),
    loginError: makeRef(''),
    loginNotice: makeRef(''),
    codeCooldown: makeRef(0)
  }
  const calls = { issue: [], deliver: [], otpSession: 0, login: [], cooldownStops: 0 }
  const TTL = 604800

  const issueDeviceToken = async (input) => {
    calls.issue.push(input === undefined ? { absent: true } : { ttlSeconds: input.ttlSeconds })
    if (opts.issueReply) return opts.issueReply
    return { ok: true, token: TOKEN, expires_at: EXPIRES_AT }
  }
  const deliverTokenToHost = async (token, meta, host) => {
    calls.deliver.push({ token, meta, host })
    if (opts.delivery) return opts.delivery
    return { delivered: true, reason: 'DELIVERED' }
  }
  const otpSessionAccessToken = async () => {
    calls.otpSession += 1
    return opts.otpToken === undefined ? TOKEN : opts.otpToken
  }
  const loginWithCode = async (phone, code) => {
    calls.login.push({ phone, code })
    if (opts.loginReply) return opts.loginReply
    return { ok: true, user: { id: 'u-' + '0'.repeat(16), role: 'admin' } }
  }
  const isPhoneLike = (value) => /^1[3-9]\d{9}$/.test(String(value === undefined || value === null ? '' : value).trim())
  const stopCooldown = () => {
    calls.cooldownStops += 1
  }

  /**
   * **凭据三源**的注入面（本单新增）：`otpAuth` 由用例提供假 auth（`getSession` /
   * `getLoginState` 两种读数），`RENEWAL_SOURCES` 直接取视图里的真枚举。
   */
  const otpAuth = opts.otpAuth || (async () => null)
  const RENEWAL_SOURCES = frozenLiteralOf('RENEWAL_SOURCES')

  /**
   * 两次调用：`compileFn(名字, 自由变量名)(自由变量…值)` ⇒ 得到「零参可调体」（真函数原样执行）。
   * 「已绑定值的零参可调体」＝ `bound`；带形参的真函数（`deviceErrorText`）绑定后仍需传实参。
   */
  const bind = (name, names, values) => compileFn(name, names)(...values)

  const clearDeviceToken = bind('clearDeviceToken', ['deviceToken', 'deviceCopied'], [
    refs.deviceToken,
    refs.deviceCopied
  ])
  /* 提示表注入空对象 ⇒ 走真函数里的「服务端 message 原样上屏」分支（不复制任何提示文案）。 */
  const deviceErrorText = bind('deviceErrorText', ['DEVICE_REASON_HINTS'], [{}])
  /* 凭据读取体：三个自由变量全注入（`otpAuth` 假体 / 视图真枚举 / 真号闸门）⇒ 逐字执行产品代码。 */
  const sessionRenewalMeta = bind('sessionRenewalMeta', ['otpAuth', 'RENEWAL_SOURCES', 'isPhoneLike'], [
    otpAuth,
    RENEWAL_SOURCES,
    isPhoneLike
  ])
  /* **交付身份（本单新增）**：`currentUser` 由用例注入（缺省＝未登錄 ⇒ 昵稱空串）；
     手机闸门与昵称上限都取视图真实现 / 真常量，不复制任何取值规则。 */
  const currentUser = () => (opts.user === undefined ? null : opts.user)
  const deliveryIdentity = bind('deliveryIdentity', ['currentUser', 'isPhoneLike', 'DELIVERY_NICKNAME_MAX'], [
    currentUser,
    isPhoneLike,
    numberLiteralOf('DELIVERY_NICKNAME_MAX')
  ])
  /* 身份装饰体：`window` 由用例注入（缺省 undefined ⇒ 等价「无橋」，服务层照旧回退 ABSENT）。 */
  const hostWithIdentity = bind('hostWithIdentity', ['window'], [opts.bridgeWindow])

  const manualSessionIssue = bind('onIssueSessionToken', [
    'admin',
    'deviceBusy',
    'deviceDelivered',
    'deviceToken',
    'deviceError',
    'deviceCopied',
    'clearDeviceToken',
    'issueDeviceToken',
    'deliverTokenToHost',
    'deviceErrorText',
    'DEVICE_SESSION_TTL_SECONDS',
    'sessionRenewalMeta',
    'RENEWAL_SOURCES',
    'deliveryIdentity',
    'hostWithIdentity'
  ], [
    refs.admin,
    refs.deviceBusy,
    refs.deviceDelivered,
    refs.deviceToken,
    refs.deviceError,
    refs.deviceCopied,
    clearDeviceToken,
    issueDeviceToken,
    deliverTokenToHost,
    deviceErrorText,
    TTL,
    sessionRenewalMeta,
    RENEWAL_SOURCES,
    deliveryIdentity,
    hostWithIdentity
  ])
  /* 自动签发 ＝ `autoIssueOnce`（幂等旗标 ＋ 同一个签发体）。 */
  const auto = bind('autoIssueOnce', ['autoIssueAttempted', 'onIssueSessionToken'], [
    refs.autoIssueAttempted,
    manualSessionIssue
  ])
  const login = bind('onInlineLogin', [
    'loginBusy',
    'loginError',
    'loginPhone',
    'loginCode',
    'loginNotice',
    'isPhoneLike',
    'loginWithCode',
    'stopCooldown',
    'otpSessionPresent',
    'loginRequired',
    'autoIssueOnce',
    'autoIssueAttempted'
  ], [
    refs.loginBusy,
    refs.loginError,
    refs.loginPhone,
    refs.loginCode,
    refs.loginNotice,
    isPhoneLike,
    loginWithCode,
    stopCooldown,
    refs.otpSessionPresent,
    refs.loginRequired,
    auto,
    refs.autoIssueAttempted
  ])
  const bootstrap = bind('bootstrapDesktopAuthorization', [
    'sessionProbing',
    'otpSessionAccessToken',
    'otpSessionPresent',
    'loginRequired',
    'logged',
    'autoIssueOnce'
  ], [
    refs.sessionProbing,
    otpSessionAccessToken,
    refs.otpSessionPresent,
    refs.loginRequired,
    refs.signedIn,
    auto
  ])

  return { refs, calls, manualSessionIssue, login, bootstrap }
}

{
  /* F1｜有会话 ⇒ 挂载即自动签发，参数 ttl=604800 */
  const rt1 = buildViewRuntime()
  const mounted1 = await rt1.bootstrap()
  check('F1', '有有效 OTP 會話 ⇒ **掛載即自動簽發**恰 1 次（零點擊），參數逐字 `ttlSeconds = 604800`', {
    session: true,
    issued: true,
    issueCalls: 1,
    ttl: 604800,
    otpProbe: 1
  }, {
    session: mounted1.session,
    issued: mounted1.issued,
    issueCalls: rt1.calls.issue.length,
    ttl: (rt1.calls.issue[0] || {}).ttlSeconds === undefined ? 0 : rt1.calls.issue[0].ttlSeconds,
    otpProbe: rt1.calls.otpSession
  })

  /* F2｜交付成功 ⇒ 已交付 ＋ 令牌从内存 / DOM 清掉 */
  const rt2 = buildViewRuntime()
  await rt2.bootstrap()
  check('F2', '自動簽發 ＋ 宿主橋交付成功 ⇒ `deviceDelivered=true` 且令牌**已從記憶體 / DOM 清掉**（`deviceToken=null`）；橋收到同一枚令牌與 `ttl_seconds=604800`', {
    delivered: true,
    tokenHeld: null,
    deliverCalls: 1,
    sameToken: true,
    metaTtl: 604800
  }, {
    delivered: rt2.refs.deviceDelivered.value,
    tokenHeld: rt2.refs.deviceToken.value,
    deliverCalls: rt2.calls.deliver.length,
    sameToken: fingerprint((rt2.calls.deliver[0] || {}).token || '') === fingerprint(TOKEN),
    metaTtl: ((rt2.calls.deliver[0] || {}).meta || {}).ttl_seconds
  })

  /* F3｜无会话 ⇒ 不自动签、显示登录表单 */
  const rt3 = buildViewRuntime({ otpToken: '' })
  const mounted3 = await rt3.bootstrap()
  check('F3', '取不到 OTP 會話（空串）⇒ **不自動簽發**（零往返、零交付）且 `loginRequired=true`（渲染內嵌登錄表單）', {
    session: false,
    issued: false,
    issueCalls: 0,
    deliverCalls: 0,
    loginRequired: true,
    formPhonePrefilled: false
  }, {
    session: mounted3.session,
    issued: mounted3.issued,
    issueCalls: rt3.calls.issue.length,
    deliverCalls: rt3.calls.deliver.length,
    loginRequired: rt3.refs.loginRequired.value,
    formPhonePrefilled: rt3.refs.loginPhone.value !== ''
  })

  /* F4｜无宿主桥 ⇒ 回退一次性显示（令牌不丢，不算失败） */
  const rt4 = buildViewRuntime({ delivery: { delivered: false, reason: 'BRIDGE_ABSENT' } })
  await rt4.bootstrap()
  check('F4', '無宿主橋 ⇒ `delivered=false`、令牌**留在 `deviceToken`**（回退「一次性顯示 ＋ 一鍵複製」，令牌不丢），且**不算失敗**（`deviceError` 空串）', {
    delivered: false,
    tokenHeldLen: TOKEN.length,
    error: ''
  }, {
    delivered: rt4.refs.deviceDelivered.value,
    tokenHeldLen: String((rt4.refs.deviceToken.value || {}).token || '').length,
    error: rt4.refs.deviceError.value
  })

  /* F5｜签发失败 ⇒ 文案可见、不静默 */
  const DENIAL_MESSAGE = '僅管理員可以簽發斐萃桌面授權。'
  const rt5 = buildViewRuntime({ issueReply: { ok: false, reason: 'FORBIDDEN', message: DENIAL_MESSAGE } })
  await rt5.bootstrap()
  check('F5', '簽發失敗 ⇒ 文案**可見且不靜默**（`deviceError` ＝ 服務端 message 原樣）、令牌仍為 null、零交付、不誤報已交付', {
    error: DENIAL_MESSAGE,
    tokenHeld: null,
    delivered: false,
    deliverCalls: 0
  }, {
    error: rt5.refs.deviceError.value,
    tokenHeld: rt5.refs.deviceToken.value,
    delivered: rt5.refs.deviceDelivered.value,
    deliverCalls: rt5.calls.deliver.length
  })

  /* F6｜幂等：自动 ＋ 手动 ＋ 再挂载 ⇒ 仍只签 1 枚 */
  const rt6 = buildViewRuntime()
  await rt6.bootstrap()
  await rt6.manualSessionIssue()
  await rt6.bootstrap()
  check('F6', '幂等：自動簽發後再點**手動按鈕**、再跑一次掛載探測 ⇒ 全程只簽發 1 枚、只交付 1 次（自動與手動不重複）', {
    issueCalls: 1,
    deliverCalls: 1
  }, {
    issueCalls: rt6.calls.issue.length,
    deliverCalls: rt6.calls.deliver.length
  })

  /* F7｜登录成功 ⇒ 同一页面加载内自动签发 ＋ 表单明文清零 */
  const rt7 = buildViewRuntime({ otpToken: '', phone: '13800000000' })
  await rt7.bootstrap()
  const formShownBeforeLogin = rt7.refs.loginRequired.value
  await rt7.login()
  check('F7', '內嵌登錄成功 ⇒ **同一頁面加載內自動簽發**（不需再點）、`ttl=604800`、表單明文清零（`loginCode` / `loginPhone`）且表單收起', {
    formShownBeforeLogin: true,
    loginCalls: 1,
    issueCalls: 1,
    ttl: 604800,
    code: '',
    phone: '',
    loginRequired: false
  }, {
    formShownBeforeLogin,
    loginCalls: rt7.calls.login.length,
    issueCalls: rt7.calls.issue.length,
    ttl: (rt7.calls.issue[0] || {}).ttlSeconds,
    code: rt7.refs.loginCode.value,
    phone: rt7.refs.loginPhone.value,
    loginRequired: rt7.refs.loginRequired.value
  })

  /* F8｜登录失败 ⇒ 不签发、文案可见、表单保留 */
  const LOGIN_DENIAL = '驗證碼不正確或已過期，請重新獲取驗證碼。'
  const rt8 = buildViewRuntime({ otpToken: '', phone: '13800000000', loginReply: { ok: false, message: LOGIN_DENIAL } })
  await rt8.bootstrap()
  await rt8.login()
  check('F8', '內嵌登錄失敗 ⇒ **零簽發**、`loginError` 可見（服務端 message 原樣）、表單保持渲染、驗證碼不靜默清掉（留給用戶核對）', {
    issueCalls: 0,
    error: LOGIN_DENIAL,
    loginRequired: true,
    codeKept: true
  }, {
    issueCalls: rt8.calls.issue.length,
    error: rt8.refs.loginError.value,
    loginRequired: rt8.refs.loginRequired.value,
    codeKept: rt8.refs.loginCode.value !== ''
  })

  /* F15｜匿名平台会话（凭据非空但本页未登录）⇒ 不能当成「有效会话」 */
  const rt9 = buildViewRuntime({ signedIn: false })
  const mounted9 = await rt9.bootstrap()
  check('F15', '匿名平台會話（`otpSessionAccessToken()` 非空**但本頁未登錄**）⇒ **不視為有效會話**：零簽發、內嵌表單照出（實測踩過：SDK 匿名會話同樣回 `access_token`，只判非空會讓人看到「表單不出現、也沒簽發」的空白頁）', {
    session: false,
    issued: false,
    issueCalls: 0,
    loginRequired: true
  }, {
    session: mounted9.session,
    issued: mounted9.issued,
    issueCalls: rt9.calls.issue.length,
    loginRequired: rt9.refs.loginRequired.value
  })

  /* F9｜表单形态（静态） */
  check('F9', '內嵌登錄表單鉤子：`data-feicui-login-form` 恰 1 處、提交走 `@submit.prevent="onInlineLogin"`（不隱式導航）、手機號 / 驗證碼輸入各 1 處', {
    form: 1,
    submit: 1,
    phone: 1,
    code: 1
  }, {
    form: countIn(viewSrc, 'data-feicui-login-form'),
    submit: countIn(viewSrc, '@submit.prevent="onInlineLogin"'),
    phone: countIn(viewSrc, 'data-feicui-login-phone'),
    code: countIn(viewSrc, 'data-feicui-login-code')
  })

  /* F10｜硬文案（逐字） */
  const GATE_COPY = '登錄後將自動簽發並交付桌面版；刷新本頁需重新登錄'
  check('F10', '硬文案逐字在碼面恰 1 處：「登錄後將自動簽發並交付桌面版；刷新本頁需重新登錄」', 1, countIn(viewSrc, GATE_COPY))

  /* F11｜复用既有登录服务、零自造码路径 */
  check('F11', '取碼 / 登錄**复用 `services/auth.js`**（`requestCode` ＋ `login` 别名为 `loginWithCode`），視圖內零自造驗證碼路徑（無 `verify(` 調用、無固定碼常量）', {
    authImport: 1,
    requestCodeCalls: 1,
    loginCalls: 1,
    verifyCalls: 0,
    fixedCode: 0
  }, {
    authImport: countIn(VIEW_SCRIPT_SRC, "from '../services/auth.js'"),
    requestCodeCalls: countIn(VIEW_SCRIPT_SRC, 'await requestCode('),
    loginCalls: countIn(VIEW_SCRIPT_SRC, 'await loginWithCode('),
    verifyCalls: countIn(VIEW_SCRIPT_SRC, 'auth.verify(') + countIn(VIEW_SCRIPT_SRC, '.verify({'),
    fixedCode: countIn(VIEW_SCRIPT_SRC, 'DEMO_SMS_CODE')
  })

  /* F12｜自动触发点唯一 */
  check('F12', '自動觸發點唯一：`onMounted(` 恰 1 處且綁 `bootstrapDesktopAuthorization`；OTP 會話探測 `otpSessionAccessToken()` 恰 1 處（不散落）', {
    mounted: 1,
    mountedBinding: 1,
    otpProbe: 1
  }, {
    mounted: countIn(VIEW_SCRIPT_SRC, 'onMounted('),
    mountedBinding: countIn(VIEW_SCRIPT_SRC, 'onMounted(bootstrapDesktopAuthorization)'),
    otpProbe: countIn(VIEW_SCRIPT_SRC, 'otpSessionAccessToken()')
  })

  /* F13｜幂等门位置（静态） */
  check('F13', '冪等門在簽發體首位區：`if (deviceDelivered.value || deviceToken.value !== null) return` 出現在 `await issueDeviceToken(` **之前**（自動與手動共用）', {
    guard: 1,
    beforeIssue: true
  }, (() => {
    const body = bodyOf('onIssueSessionToken')
    const guardAt = body.indexOf('if (deviceDelivered.value || deviceToken.value !== null) return')
    const issueAt = body.indexOf('await issueDeviceToken(')
    return { guard: countIn(body, 'if (deviceDelivered.value || deviceToken.value !== null) return'), beforeIssue: guardAt >= 0 && issueAt > guardAt }
  })())

  /* F14｜表单开关只由「挂载探测 / 登录成功」两处写 */
  check('F14', '表單開關（`loginRequired.value =`）**恰 3 處**：掛載探測（無會話 ⇒ true）＋ 登錄成功（⇒ false）＋ **簽發失敗自愈（⇒ true）**；仍是封闭集合、无第四路', {
    assignments: 3,
    inBootstrap: 1,
    inLogin: 1,
    inSelfHeal: 1
  }, {
    assignments: countIn(VIEW_SCRIPT_SRC, 'loginRequired.value ='),
    inBootstrap: countIn(bodyOf('bootstrapDesktopAuthorization'), 'loginRequired.value = !present'),
    inLogin: countIn(bodyOf('onInlineLogin'), 'loginRequired.value = false'),
    /* **失败即自愈**：签发失败必须把登录表单放出来 —— 判据「会话非空 且 logged」会被
       「匿名平台会话 ＋ 持久化 App 登录态」同时满足，导致跳过表单直接签发并失败（真机复现）。 */
    /* 用**全源计数**而非函数体切片：`bodyOf` 的提取边界对新增块不稳定，会把这条判成假绿/假红。 */
    inSelfHeal: countIn(VIEW_SCRIPT_SRC, 'loginRequired.value = true')
  })
}

/* ===========================================================================
   G 段：凭据携带（**本单根因修复**｜可执行）
   ---------------------------------------------------------------------------
   真机症状：`/connect` 的 OTP 会话在 `persistence:'none'` 实例里 ⇒ 网关注入的
   `callContext` 是主 app 实例的**匿名**会话；请求体又没有 `event.token`
   ⇒ 服务端恒判「未攜帶有效令牌」，用户怎么登录都失败。
   本段钉住修复后的三条硬口径（两处 `action:'verify'` 同形）：
     ① 无票 ⇒ **先取票**（`issue`）再携带（`verify`），`verify` 的 `token` 与取票结果逐字相同；
     ② 有票 ⇒ **复用**（零额外取票）；取票被拒 ⇒ 服务端原话透传、**零 verify**；
     ③ 无平台会话 / 取票抛错 ⇒ `LOGIN_REQUIRED` ＋ **零请求**（不发必然被拒的空凭据）。
   =========================================================================== */
section('G', '凭据携带：无票先取票 / 有票复用 / 无会话即 LOGIN_REQUIRED 零请求 / 两处 verify 同形')

{
  /** 往返动作序列（`issue` / `verify`）。 */
  const actionsOf = () => transportCalls.map((call) => (call.data || {}).action)

  /* G1｜无票 ⇒ 先取票再携带（顺序逐字：issue → verify）。 */
  userTokenSvc.clearUserToken()
  platformSessionMode = 'ok'
  ticketMode = 'ok'
  const fresh = await issueViaService()
  check('G1', '管道里没有令牌 ⇒ **先取票再携带**：往返恰 2 次（一次 `issue` ＋ 一次 `verify`），顺序逐字', {
    callsTotal: 2,
    issues: 1,
    verifies: 1,
    order: ['issue', 'verify']
  }, {
    callsTotal: fresh.callsTotal,
    issues: actionsOf().filter((action) => action === 'issue').length,
    verifies: fresh.calls,
    order: actionsOf()
  })
  check('G1b', '取票那一次的请求体逐字 `{action, phone, platformAccessToken}`（凭据是**平台会话**，不是任何固定码）', {
    keys: ['action', 'phone', 'platformAccessToken'],
    platformFp: fingerprint(PLATFORM_ACCESS_TOKEN),
    hasCode: false
  }, (() => {
    const ticket = transportCalls.filter((call) => (call.data || {}).action === 'issue')[0] || {}
    const body = ticket.data || {}
    return {
      keys: Object.keys(body).sort(),
      platformFp: fingerprint(String(body.platformAccessToken || '')),
      hasCode: Object.prototype.hasOwnProperty.call(body, 'code')
    }
  })())
  check('G1c', '携带那一次的 `token` 与取票结果**逐字相同**，且 `payload` 仍是 `{}`（30 天缺省）', {
    tokenLen: USER_TOKEN.length,
    tokenFp: fingerprint(USER_TOKEN),
    payloadJson: '{}',
    tokenNotInReplyText: true
  }, {
    tokenLen: String(fresh.event.token || '').length,
    tokenFp: fingerprint(fresh.event.token || ''),
    payloadJson: JSON.stringify(fresh.event.payload),
    tokenNotInReplyText: !JSON.stringify(fresh.reply).includes(USER_TOKEN)
  })

  /* G2｜有票 ⇒ 复用（零额外取票）。 */
  const reuse = await issueViaService(604800)
  check('G2', '管道里已有未过期的用户令牌 ⇒ **复用**：只 1 次 `verify` 往返、零 `issue`', {
    callsTotal: 1,
    order: ['verify'],
    tokenFp: fingerprint(USER_TOKEN),
    payloadJson: '{"ttl_seconds":604800}'
  }, {
    callsTotal: reuse.callsTotal,
    order: actionsOf(),
    tokenFp: fingerprint(reuse.event.token || ''),
    payloadJson: JSON.stringify(reuse.event.payload)
  })

  /* G3｜无平台会话 ⇒ LOGIN_REQUIRED ＋ 零请求。 */
  userTokenSvc.clearUserToken()
  platformSessionMode = 'none'
  const noSession = await issueViaService()
  check('G3', '无平台登入会话（页面里取不到 `access_token`）⇒ `LOGIN_REQUIRED` ＋ **零请求** ＋ 回包恰 3 键', {
    reason: 'LOGIN_REQUIRED',
    callsTotal: 0,
    keys: ['message', 'ok', 'reason'],
    messagePresent: true
  }, {
    reason: noSession.reply.reason,
    callsTotal: noSession.callsTotal,
    keys: Object.keys(noSession.reply).sort(),
    messagePresent: String(noSession.reply.message || '').length > 0
  })

  /* G4｜取票抛错 ⇒ 不阻断（结构化拒绝 ＋ 可读文案）＋ 零请求。 */
  platformSessionMode = 'throw'
  transportCalls.length = 0
  let thrown = null
  try {
    thrown = await feicuiSvc.issueDeviceToken()
  } catch (error) {
    thrown = { threw: true, message: String(error && error.message) }
  }
  check('G4', '取票时平台会话读取抛错 ⇒ **不抛出**、降级为 `LOGIN_REQUIRED` ＋ 可读文案 ＋ **零请求**', {
    reason: 'LOGIN_REQUIRED',
    callsTotal: 0,
    threw: false,
    keys: ['message', 'ok', 'reason']
  }, {
    reason: thrown.reason,
    callsTotal: transportCalls.length,
    threw: thrown.threw === true,
    keys: Object.keys(thrown).sort()
  })
  platformSessionMode = 'ok'

  /* G5｜取票被服务端拒 ⇒ 原样透传 ＋ 零 verify。 */
  userTokenSvc.clearUserToken()
  ticketMode = 'denied'
  const denied = await issueViaService()
  check('G5', '取票被服务端拒（`FORBIDDEN`）⇒ reason / message **逐字透传**、**零 verify 往返**（不拿空票去签发）', {
    reason: 'FORBIDDEN',
    message: TICKET_DENIED_MESSAGE,
    verifies: 0,
    order: ['issue']
  }, {
    reason: denied.reply.reason,
    message: denied.reply.message,
    verifies: denied.calls,
    order: actionsOf()
  })
  ticketMode = 'ok'

  /* G6｜角色令牌（`issueFeicuiToken`）同形：同一携带点、带 token、载荷三键。 */
  userTokenSvc.clearUserToken()
  transportCalls.length = 0
  const role = await feicuiSvc.issueToken({ target: '13900000000', role: 'user', ttlDays: 7 })
  const roleEvent = (verifyCallsOf().slice(-1)[0] || {}).data || {}
  check('G6', '角色令牌（`issueFeicuiToken`）**同一缺陷同样已修**：往返 2 次（issue → verify）、`token` 逐字相同、签发成功', {
    order: ['issue', 'verify'],
    tokenFp: fingerprint(USER_TOKEN),
    ok: true,
    tokenLen: TOKEN.length
  }, {
    order: actionsOf(),
    tokenFp: fingerprint(String(roleEvent.token || '')),
    ok: role.ok,
    tokenLen: String(role.token || '').length
  })
  check('G6b', '角色令牌的载荷仍是封闭三键 `{target, role, ttl_seconds}`（令牌只在**顶层** `token`，不进载荷 —— 服务端会把载荷里的身份类键按 `INVALID_FIELD` 拒）', {
    payloadKeys: ['role', 'target', 'ttl_seconds'],
    eventKeys: ['action', 'op', 'payload', 'token'],
    op: 'issueFeicuiToken'
  }, {
    payloadKeys: Object.keys(roleEvent.payload || {}).sort(),
    eventKeys: Object.keys(roleEvent).sort(),
    op: roleEvent.op
  })

  /* G7｜角色令牌：无平台会话 ⇒ 同样 LOGIN_REQUIRED ＋ 零请求。 */
  userTokenSvc.clearUserToken()
  platformSessionMode = 'none'
  transportCalls.length = 0
  const roleNoSession = await feicuiSvc.issueToken({ target: '13900000000' })
  check('G7', '角色令牌无平台会话 ⇒ `LOGIN_REQUIRED` ＋ **零请求** ＋ 恰 3 键（与设备令牌同一条前置门）', {
    reason: 'LOGIN_REQUIRED',
    callsTotal: 0,
    keys: ['message', 'ok', 'reason']
  }, {
    reason: roleNoSession.reason,
    callsTotal: transportCalls.length,
    keys: Object.keys(roleNoSession).sort()
  })
  platformSessionMode = 'ok'
  userTokenSvc.clearUserToken()

  /* G8｜令牌不上屏 / 不进返回值（用户令牌串在任何回包里命中 0）。 */
  check('G8', '用户令牌串在全部签发回包的序列化文本里命中 0（令牌只在请求体里过一次；回包只有斐萃令牌）', 0, [fresh.reply, reuse.reply, role, noSession.reply, denied.reply]
    .filter((reply) => String(JSON.stringify(reply)).includes(USER_TOKEN)).length)

  /* G9｜登录成功 ⇒ 管道里已有票（故 `/connect` 的「登录后自动签发」不必再单独取票）。
     判据取自真源：`services/auth.js` 两条登录路都在成功路径上换票。 */
  const authSrc = stripComments(readFileSync(path.join(ROOT, 'src/services/auth.js'), 'utf8'))
  check('G9', '登录成功即已有票：`services/auth.js` 的**短訊登錄**与**密碼登錄**都在成功路径上换票（`ensureUserLoginToken(` ⇒ 管道缓存 ⇒ 内嵌登录后携带点直接复用，零额外取票）', {
    exchangeCalls: 2,
    exportedLogin: 1,
    exportedPasswordLogin: 1
  }, {
    exchangeCalls: countIn(authSrc, 'await ensureUserLoginToken('),
    exportedLogin: countIn(authSrc, 'export async function login('),
    exportedPasswordLogin: countIn(authSrc, 'export async function loginWithPassword(')
  })
}

/* ===========================================================================
   H 段：续签凭据**三源尝试**（本单修订｜可执行）＋ `renewal_source` 诊断枚举
   ---------------------------------------------------------------------------
   真机症状：页面已能签发 168 小时会话、桥也交付了，但钥匙串里始终没有
   `feicui.local-dist/refresh` ⇒ 零点击续签不生效。根因：`refresh_token` 只从
   `getSession().data.session` 一处读，那条读法在真机上拿不到该字段（空串 ⇒ 不下发）。
   修法＝**多源尝试**（任一得手即用，全空不阻断交付），并把**命中源**作为枚举放进
   `meta.renewal_source`（只作诊断，不参与任何判定）。
   =========================================================================== */
section('H', '续签凭据三源：session / loginState / fallback / none（phone 多源；含凭据时 meta 带 refresh_token 且不上屏）')

{
  const RT_SESSION = 'rt_session_' + randomBytes(8).toString('hex')
  const RT_LOGIN = 'rt_loginstate_' + randomBytes(8).toString('hex')
  const RT_FALLBACK = 'rt_fallback_' + randomBytes(8).toString('hex')
  const PHONE_A = '13800000001'
  const PHONE_B = '13900000002'
  const RENEWAL_ENUM = { session: 'session', loginState: 'loginState', fallback: 'fallback', none: 'none' }

  /** 假 auth：`getSession` / `getLoginState` 由用例给（并按调用序号变招 ⇒ 可测「兜底再取一次」）。 */
  function fakeAuth(handlers) {
    const calls = { session: 0, loginState: 0 }
    return {
      calls,
      async getSession() {
        calls.session += 1
        if (!handlers.getSession) return { data: { session: null } }
        return handlers.getSession(calls.session)
      },
      async getLoginState() {
        calls.loginState += 1
        if (!handlers.getLoginState) return null
        return handlers.getLoginState(calls.loginState)
      }
    }
  }

  /** 跑一次「挂载 ⇒ 自动签发 ⇒ 交付」，返回桥实际收到的 `meta` 与各源调用次数。 */
  async function runRenewal(handlers) {
    const auth = fakeAuth(handlers)
    const rt = buildViewRuntime({ otpAuth: async () => auth })
    await rt.bootstrap()
    const delivered = rt.calls.deliver[0] || {}
    return {
      meta: delivered.meta || {},
      issueCalls: rt.calls.issue.length,
      deliverCalls: rt.calls.deliver.length,
      authCalls: auth.calls,
      refs: rt.refs
    }
  }

  /* H1｜① 会话面命中（初版读法能用的那一档） */
  const h1 = await runRenewal({
    getSession: () => ({ data: { session: { refresh_token: RT_SESSION, user: { phone_number: PHONE_A } } } })
  })
  check('H1', '① `getSession().data.session` 有 `refresh_token` ⇒ 命中 `session`：meta 带该值 ＋ `session.user.phone_number` 作 phone ＋ **不再去读 loginState**', {
    refreshLen: RT_SESSION.length,
    refreshFp: fingerprint(RT_SESSION),
    phone: PHONE_A,
    source: 'session',
    loginStateCalls: 0
  }, {
    refreshLen: String(h1.meta.refresh_token || '').length,
    refreshFp: fingerprint(h1.meta.refresh_token || ''),
    phone: h1.meta.phone,
    source: h1.meta.renewal_source,
    loginStateCalls: h1.authCalls.loginState
  })

  /* H2｜② 登录状态面命中（真机上真正拿得到凭据的那一档） */
  const h2 = await runRenewal({
    getSession: () => ({ data: { session: {} } }),
    getLoginState: () => ({ credentials: { refresh_token: RT_LOGIN, user: { phone: PHONE_B } } })
  })
  check('H2', '①空 ⇒ ②`getLoginState().credentials.refresh_token` 命中 `loginState`（phone 取 `user.phone`）', {
    refreshFp: fingerprint(RT_LOGIN),
    phone: PHONE_B,
    source: 'loginState'
  }, {
    refreshFp: fingerprint(h2.meta.refresh_token || ''),
    phone: h2.meta.phone,
    source: h2.meta.renewal_source
  })

  /* H3｜③ 兜底：同一实例再取一次会话，按备用形状读 */
  const h3 = await runRenewal({
    getSession: (n) => (n === 1 ? { data: { session: null } } : { session: { refresh_token: RT_FALLBACK } }),
    getLoginState: () => ({ credentials: {} })
  })
  check('H3', '①②皆空 ⇒ ③**同一 auth 实例**再 `getSession()`，按备用形状（`reply.session`）读到 ⇒ 命中 `fallback`（getSession 恰 2 次、不新建实例）', {
    refreshFp: fingerprint(RT_FALLBACK),
    source: 'fallback',
    sessionCalls: 2
  }, {
    refreshFp: fingerprint(h3.meta.refresh_token || ''),
    source: h3.meta.renewal_source,
    sessionCalls: h3.authCalls.session
  })

  /* H4｜三源全空 ⇒ 空串 ＋ `none`，**不阻断交付** */
  const h4 = await runRenewal({
    getSession: () => ({ data: { session: { access_token: PLATFORM_ACCESS_TOKEN } } }),
    getLoginState: () => ({ credentials: { user: {} } })
  })
  check('H4', '三源全空 ⇒ `refresh_token` 空串 ＋ `renewal_source="none"`，**仍签 1 次、仍交付 1 次**（凭据取不到绝不阻断 168 小时会话）', {
    refresh: '',
    phone: '',
    source: 'none',
    issueCalls: 1,
    deliverCalls: 1,
    delivered: true
  }, {
    refresh: h4.meta.refresh_token,
    phone: h4.meta.phone,
    source: h4.meta.renewal_source,
    issueCalls: h4.issueCalls,
    deliverCalls: h4.deliverCalls,
    delivered: h4.refs.deviceDelivered.value
  })

  /* H5｜phone 多源：会话给了凭据但没给号 ⇒ 从 loginState 补号（凭据来源仍是 session） */
  const h5 = await runRenewal({
    getSession: () => ({ data: { session: { refresh_token: RT_SESSION, user: {} } } }),
    getLoginState: () => ({ credentials: { user: { phone: PHONE_B } } })
  })
  check('H5', 'phone 多源：`session.user.phone_number` 缺 ⇒ 回落 `loginState.user.phone`（凭据来源仍记 `session`）', {
    phone: PHONE_B,
    source: 'session',
    refreshFp: fingerprint(RT_SESSION)
  }, {
    phone: h5.meta.phone,
    source: h5.meta.renewal_source,
    refreshFp: fingerprint(h5.meta.refresh_token || '')
  })

  /* H6｜getSession 抛错 ⇒ 不抛、不挡路，直接落到 loginState */
  const h6 = await runRenewal({
    getSession: () => {
      throw new Error('SESSION_READ_BOOM')
    },
    getLoginState: () => ({ credentials: { refresh_token: RT_LOGIN } })
  })
  check('H6', '`getSession()` 抛错 ⇒ **不向上抛、不挡交付**，直接落到 `loginState` 并照常交付', {
    source: 'loginState',
    refreshFp: fingerprint(RT_LOGIN),
    issueCalls: 1
  }, {
    source: h6.meta.renewal_source,
    refreshFp: fingerprint(h6.meta.refresh_token || ''),
    issueCalls: h6.issueCalls
  })

  /* H7｜枚举封闭：只允许 4 值，且本段四个用例各命中一个 */
  const observed = [h1.meta.renewal_source, h2.meta.renewal_source, h3.meta.renewal_source, h4.meta.renewal_source]
  check('H7', '`renewal_source` 是**封闭四值枚举**（`session` / `loginState` / `fallback` / `none`），四档各命中一次、无第五值', {
    enum: RENEWAL_ENUM,
    observed
  }, {
    enum: frozenLiteralOf('RENEWAL_SOURCES'),
    observed
  })

  /* H8｜码面契约（静态）：三源都在、meta 确实把凭据与枚举交出去 */
  check('H8', '码面契约：三源读点齐（`getSession` / `getLoginState` / 兜底再取）、`meta` 交 `refresh_token` ＋ `renewal_source`', {
    getSession: 2,
    getLoginState: 1,
    fallbackBranch: 1,
    metaRefresh: 1,
    metaSource: 1
  }, (() => {
    const body = bodyOf('sessionRenewalMeta')
    const issueBody = bodyOf('onIssueSessionToken')
    return {
      getSession: countIn(body, 'auth.getSession()'),
      getLoginState: countIn(body, 'auth.getLoginState()'),
      fallbackBranch: countIn(body, 'RENEWAL_SOURCES.fallback'),
      metaRefresh: countIn(issueBody, 'refresh_token: renewal.refresh_token'),
      metaSource: countIn(issueBody, 'renewal_source: renewal.renewal_source')
    }
  })())

  /* H9｜真服务层：有凭据时三键随桥下发；无凭据时桥参数**逐字仍是旧两键** */
  {
    const withRefresh = fakeHost('pywebview')
    const metaFull = {
      expires_at: EXPIRES_AT,
      ttl_seconds: 604800,
      refresh_token: RT_SESSION,
      phone: PHONE_A,
      renewal_source: RENEWAL_ENUM.session
    }
    const sentFull = await feicuiSvc.deliverTokenToHost(TOKEN, metaFull, withRefresh.host)
    const callFull = (withRefresh.record.pywebview[0] || {}).meta || {}
    check('H9', '真 `deliverTokenToHost`：带凭据 ⇒ 桥 meta 恰 5 键 `{expires_at, phone, refresh_token, renewal_source, ttl_seconds}`，凭据逐字透传、令牌仍只在第一参', {
      delivered: true,
      keys: ['expires_at', 'phone', 'refresh_token', 'renewal_source', 'ttl_seconds'],
      refreshFp: fingerprint(RT_SESSION),
      phone: PHONE_A,
      source: 'session',
      tokenInMeta: false
    }, {
      delivered: sentFull.delivered,
      keys: sorted(callFull),
      refreshFp: fingerprint(callFull.refresh_token || ''),
      phone: callFull.phone,
      source: callFull.renewal_source,
      tokenInMeta: JSON.stringify(callFull).includes(TOKEN)
    })

    const withoutRefresh = fakeHost('pywebview')
    await feicuiSvc.deliverTokenToHost(TOKEN, { expires_at: EXPIRES_AT, ttl_seconds: 604800, refresh_token: '', phone: '', renewal_source: 'none' }, withoutRefresh.host)
    const callBare = (withoutRefresh.record.pywebview[0] || {}).meta || {}
    check('H9b', '真 `deliverTokenToHost`：**空凭据不下发空键**（`refresh_token` / `phone` 缺席）＋ `renewal_source="none"` 仍带（桌面端据此区分「取了但没拿到」与「页面根本没取」）', {
      keys: ['expires_at', 'renewal_source', 'ttl_seconds'],
      source: 'none',
      hasRefresh: false,
      hasPhone: false
    }, {
      keys: sorted(callBare),
      source: callBare.renewal_source,
      hasRefresh: 'refresh_token' in callBare,
      hasPhone: 'phone' in callBare
    })

    /* 旧调用方（只给 `expires_at` / `ttl_seconds`，本单之前的形态）⇒ 桥参数**逐字两键**。 */
    const legacy = fakeHost('pywebview')
    await feicuiSvc.deliverTokenToHost(TOKEN, { expires_at: EXPIRES_AT, ttl_seconds: 604800 }, legacy.host)
    const callLegacy = (legacy.record.pywebview[0] || {}).meta || {}
    check('H9c', '旧调用形态（meta 只有 `expires_at` / `ttl_seconds`）⇒ 桥 meta **逐字两键**（新增键纯增量，旧调用点零变化）', {
      keys: ['expires_at', 'ttl_seconds'],
      ttl: 604800
    }, {
      keys: sorted(callLegacy),
      ttl: callLegacy.ttl_seconds
    })
  }

  /* H10｜凭据不上屏：模板区（含所有钩子 / 文案）零 `refresh_token` / `renewal_source` */
  {
    const templateSrc = viewSrc.slice(0, viewSrc.indexOf('<script setup>'))
    check('H10', '凭据与诊断枚举**不上屏**：模板区（含 `data-*` 钩子与文案）`refresh_token` / `renewal_source` 命中 0（只在脚本层随 `meta` 离开）', {
      refresh: 0,
      source: 0
    }, {
      refresh: countIn(templateSrc, 'refresh_token'),
      source: countIn(templateSrc, 'renewal_source')
    })
  }
}

/* ===========================================================================
   I 段：交付身份（**可执行**＋静态）：meta 带 `nickname` / `phone`，且**永不夹带令牌**
   ---------------------------------------------------------------------------
   被测事实链：页面 `onIssueSessionToken`（真函数体）→ `deliverTokenToHost`（**真服务层**）
   → 宿主橋（假 `window`，记录实收参数）。三处都要看，因为服务层的桥侧 payload 是**白名单组装**，
   只读页面字面量会漏掉「身份键到不了橋」这类缺陷（本段 I5 就是这条端到端判据）。
   =========================================================================== */
section('I', '交付身份：meta 带 nickname / phone（空串降级、不编造），逐键无令牌，令牌只在第一参')

{
  const NICK_PHONE = '13800000009'
  const USER = { id: 'u-' + '1'.repeat(16), role: 'admin', nickname: '  章魚小丸子  ', phone: NICK_PHONE }

  /* I1｜页面 meta 键面（真函数体跑出来，不读注释） */
  const rtI1 = buildViewRuntime({ user: USER })
  await rtI1.bootstrap()
  const pageCall = rtI1.calls.deliver[0] || {}
  const pageMeta = pageCall.meta || {}
  check('I1', '页面交付 meta 含 `nickname` 与 `phone` 两键（昵称去空白后逐字上橋；手机号 11 位原样）', {
    keys: ['expires_at', 'nickname', 'phone', 'refresh_token', 'renewal_source', 'ttl_seconds'],
    nickname: '章魚小丸子',
    phone: NICK_PHONE
  }, {
    keys: sorted(pageMeta),
    nickname: pageMeta.nickname,
    phone: pageMeta.phone
  })

  /* I2｜逐键无令牌：`refresh_token` 是**既有续签凭据**（键名天然含 token，非本次会话令牌）；
     除此之外任何带 token 的键、以及**任何键的值等于本次令牌**，一律算违规。 */
  const tokenishKeys = Object.keys(pageMeta).filter((key) => key.toLowerCase().indexOf('token') !== -1)
  const smugglingKeys = Object.keys(pageMeta).filter((key) => {
    const value = pageMeta[key]
    return typeof value === 'string' && value !== '' && String(value).indexOf(String(pageCall.token)) !== -1
  })
  check('I2', 'meta **不含令牌**：除既有 `refresh_token`（续签凭据）外零 token 键；且没有任何键的值是本次令牌（序列化文本零命中）', {
    tokenishKeys: ['refresh_token'],
    smugglingKeys: [],
    tokenInMetaText: false
  }, {
    tokenishKeys,
    smugglingKeys,
    tokenInMetaText: JSON.stringify(pageMeta).indexOf(String(pageCall.token)) !== -1
  })

  /* I3｜昵称缺失 ⇒ 空串（不是 undefined / null，也不拿 uid 或手机号顶替） */
  const rtI3 = buildViewRuntime()
  await rtI3.bootstrap()
  const bareMeta = ((rtI3.calls.deliver[0] || {}).meta) || {}
  check('I3', '取不到用户 ⇒ `nickname` 是**空串**（`typeof === "string"`，非 undefined / null），`phone` 同样空串 —— 不编造、不用 uid 顶替', {
    nickname: '',
    nicknameType: 'string',
    nicknamePresent: true,
    phone: ''
  }, {
    nickname: bareMeta.nickname,
    nicknameType: typeof bareMeta.nickname,
    nicknamePresent: Object.prototype.hasOwnProperty.call(bareMeta, 'nickname'),
    phone: bareMeta.phone
  })

  /* I4｜去首尾空白 ＋ 按 50 字截断（码点切，不切坏代理对） */
  const LONG = '   ' + '章'.repeat(60) + '   '
  const rtI4 = buildViewRuntime({ user: { nickname: LONG, phone: '1' } })
  await rtI4.bootstrap()
  const longMeta = ((rtI4.calls.deliver[0] || {}).meta) || {}
  const longNick = String(longMeta.nickname || '')
  check('I4', '昵称去首尾空白后按 **50 字**截断（60 字输入 ⇒ 恰 50 字、首尾无空白；形如手机号的非 11 位 `phone` ⇒ 空串）', {
    length: 50,
    value: '章'.repeat(50),
    trimmed: true,
    phone: ''
  }, {
    length: Array.from(longNick).length,
    value: longNick,
    trimmed: longNick === longNick.trim(),
    phone: longMeta.phone
  })

  /* I5｜端到端（真页面 → 真服务 → 假橋）：身份键必须真的**到得了橋**，令牌仍只在第一参 */
  const bridge = fakeHost('pywebview')
  const rtI5 = buildViewRuntime({ user: USER, bridgeWindow: bridge.host })
  await rtI5.bootstrap()
  const handoff = rtI5.calls.deliver[0] || {}
  const sent = await feicuiSvc.deliverTokenToHost(handoff.token, handoff.meta, handoff.host)
  const bridgeCall = bridge.record.pywebview[0] || {}
  const bridgeMeta = bridgeCall.meta || {}
  check('I5', '端到端：真 service ＋ 页面装饰宿主 ⇒ 橋 meta 含 `nickname` / `phone`（逐字），TTL 604800；令牌**只**在第一参（meta 序列化零命中）', {
    delivered: true,
    keys: ['expires_at', 'nickname', 'phone', 'renewal_source', 'ttl_seconds'],
    nickname: '章魚小丸子',
    phone: NICK_PHONE,
    ttl: 604800,
    firstParamFp: fingerprint(TOKEN),
    tokenInMeta: false
  }, {
    delivered: sent.delivered,
    keys: sorted(bridgeMeta),
    nickname: bridgeMeta.nickname,
    phone: bridgeMeta.phone,
    ttl: bridgeMeta.ttl_seconds,
    firstParamFp: fingerprint(bridgeCall.token || ''),
    tokenInMeta: JSON.stringify(bridgeMeta).indexOf(String(handoff.token)) !== -1
  })

  /* I6｜码面契约（静态）：新键在 meta 字面量各恰 1 处，旧两键逐字未动 */
  const issueBody = bodyOf('onIssueSessionToken')
  check('I6', '码面契约：meta 字面量有 `nickname: identity.nickname` ＋ `phone: renewal.phone || identity.phone` 各 1 处；旧键 `expires_at: reply.expires_at` / `ttl_seconds: DEVICE_SESSION_TTL_SECONDS` 逐字仍在（各 1 处）', {
    nickname: 1,
    phone: 1,
    expires: 1,
    ttl: 1,
    decoratedHost: 1
  }, {
    nickname: countIn(issueBody, 'nickname: identity.nickname'),
    phone: countIn(issueBody, 'phone: renewal.phone || identity.phone'),
    expires: countIn(issueBody, 'expires_at: reply.expires_at'),
    ttl: countIn(issueBody, 'ttl_seconds: DEVICE_SESSION_TTL_SECONDS'),
    decoratedHost: countIn(issueBody, '}, hostWithIdentity(identity))')
  })
}

/* ---------------------------------------------------------------------------
   末行 summary
   ------------------------------------------------------------------------- */
const summary = {
  summary: { total, passed, failed: total - passed },
  sections: sectionStats,
  failed_ids: failedIds,
  note: '完全离线：假传输 ＋ 只读假 DB ＋ 注入式假宿主橋；不连云端、不碰真库、不部署、不写被测仓库任何文件；令牌运行期随机构造，读数只给长度与指纹。'
}
console.log(JSON.stringify(summary))
process.exit(failedIds.length === 0 ? 0 : 1)
