/**
 * 玺爱 · **自检：斐萃桌面版「登錄即授權」通道（8 小時會話 ＋ JS 橋交付）**
 * ============================================================================
 * 本单三处被测件：
 *   · `cloudfunctions/xiai-user-token/lib/ops.js` —— `issueFeicuiDeviceToken` 新增**可选**
 *     载荷 `ttl_seconds`（整数，允许区间 `[300, 43200]`；缺省仍是 30 天；非整数 / 越界
 *     ⇒ `INVALID_VALUE` ＋ 零签发）；
 *   · `src/services/feicui.js` —— `issueDeviceToken({ttlSeconds})` ＋ 宿主桥探测 / 交付
 *     （`feicuiHostBridgeOf` / `deliverTokenToHost`；pywebview → wails → 通用 → 回退複製）；
 *   · `src/views/ConnectFeicuiView.vue` —— `/connect` 第二个按钮「為斐翠桌面簽發 8 小時會話」
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
 * 覆盖面（A〜E 五段）：
 *   A 常量面（可执行）：缺省 30 天 / 会话 8 小时 / 区间 [300, 43200]；越界与非整数一律 `null`。
 *   B 服务层（可执行）：缺省载荷逐字 `{}`；28800 ⇒ `{ttl_seconds:28800}`；299 / 43201 / 1.5 /
 *     '28800' ⇒ `INVALID_VALUE` ＋ **零往返**；非管理員 ⇒ `NOT_ADMIN` ＋ 零往返。
 *   C 服务端 op（可执行）：缺省 `exp−iat ＝ 2,592,000`；28800 / 300 / 43200 逐值；越界 / 非整数
 *     ⇒ `INVALID_VALUE` ＋ **零读密钥**；非 admin 夹带 ttl ⇒ 仍是 `FORBIDDEN`（门先）。
 *   D 宿主橋（可执行，注入假 window）：无桥 ⇒ 回退；pywebview → wails → 通用三路；优先级；
 *     参数形状 `(token, {expires_at, ttl_seconds})`；桥抛错 ⇒ **不丢令牌**；全程零存储 / 零 URL / 零日志。
 *   E 页面契约（静态）：第二按钮 / 并存 / 首行 admin 守卫 / TTL 28800 / 交付后清 DOM /
 *     已交付块零令牌绑定 / 刷新提示文案 / 零持久层 / 刷新无残留。
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
const feicuiSvc = await import(path.join(ROOT, 'src/services/feicui.js'))
const session = await import(path.join(ROOT, 'src/data/session.js'))

const ops = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))

const VIEW_REL = 'src/views/ConnectFeicuiView.vue'
const viewRaw = readFileSync(path.join(ROOT, VIEW_REL), 'utf8')
const viewSrc = stripComments(viewRaw)

/* ---------------------------------------------------------------------------
   2. 假传输（**零联网**）：记录每一次往返的形状
   ------------------------------------------------------------------------- */

const TOKEN = 'tok-' + randomBytes(24).toString('hex')
const EXPIRES_AT = '2026-11-17T18:00:00.000Z'
const transportCalls = []
setCloudFunctionTransport(async (name, data) => {
  transportCalls.push({ name, data })
  return { result: { ok: true, token: TOKEN, expires_at: EXPIRES_AT } }
})

const ADMIN_USER = { id: 'u-' + '0'.repeat(16), phone: '13800000000', role: 'admin', nickname: '自檢管理員' }
const PLAIN_USER = { id: 'u-' + '1'.repeat(16), phone: '13900000000', role: 'user', nickname: '自檢用戶' }
session.setUser(ADMIN_USER)

/** 一次服务层签发的读数（往返次数 / 事件载荷 / 回包键面）。 */
async function issueViaService(ttlSeconds) {
  transportCalls.length = 0
  const reply = ttlSeconds === undefined ? await feicuiSvc.issueDeviceToken() : await feicuiSvc.issueDeviceToken({ ttlSeconds })
  const event = (transportCalls[0] || {}).data || {}
  return { reply, calls: transportCalls.length, event, payload: event.payload }
}

/* ===========================================================================
   A 段：常量面
   =========================================================================== */
section('A', '常量面：缺省 30 天 / 会话 8 小时 / 允许区间 [300, 43200]')

{
  const ttl = feicuiSvc.FEICUI_DEVICE_TTL || {}
  check('A1', '`FEICUI_DEVICE_TTL` 四值逐字：缺省 2,592,000 / 会话 28,800 / 下限 300 / 上限 43,200', { defaultSeconds: 2592000, sessionSeconds: 28800, minSeconds: 300, maxSeconds: 43200 }, {
    defaultSeconds: ttl.defaultSeconds,
    sessionSeconds: ttl.sessionSeconds,
    minSeconds: ttl.minSeconds,
    maxSeconds: ttl.maxSeconds
  })
  check('A2', '缺省（键缺席 / `null`）⇒ 30 天（既有行为不变）', [2592000, 2592000], [
    feicuiSvc.deviceTtlSecondsOf(undefined),
    feicuiSvc.deviceTtlSecondsOf(null)
  ])
  check('A3', '边界接受：300 与 43,200 原值返回（不夹取、不改写）', [300, 43200], [
    feicuiSvc.deviceTtlSecondsOf(300),
    feicuiSvc.deviceTtlSecondsOf(43200)
  ])
  check('A4', '越界拒绝：299 / 43,201 ⇒ `null`（边界外一位即拒）', [null, null], [
    feicuiSvc.deviceTtlSecondsOf(299),
    feicuiSvc.deviceTtlSecondsOf(43201)
  ])
  check('A5', '非整数拒绝：1.5 / 字符串 `"28800"` / `NaN` ⇒ `null`（不字符串转数、不四捨五入）', [null, null, null], [
    feicuiSvc.deviceTtlSecondsOf(1.5),
    feicuiSvc.deviceTtlSecondsOf('28800'),
    feicuiSvc.deviceTtlSecondsOf(Number.NaN)
  ])
}

/* ===========================================================================
   B 段：服务层（可执行）
   =========================================================================== */
section('B', '服务层：缺省载荷 `{}` / 28800 ⇒ `{ttl_seconds:28800}` / 越界 ⇒ INVALID_VALUE 零往返')

{
  const plain = await issueViaService(undefined)
  check('B1', '缺省签发：载荷**逐字**仍是 `{}`（服务端 30 天缺省）＋ 往返恰 1 次', { keys: [], json: '{}', calls: 1 }, {
    keys: Object.keys(plain.payload || {}),
    json: JSON.stringify(plain.payload),
    calls: plain.calls
  })
  check('B1b', '事件形状沿用既有信封：`op` 逐字 ＋ 回包恰 3 键 `{ok, token, expires_at}`', { op: 'issueFeicuiDeviceToken', keys: ['expires_at', 'ok', 'token'] }, {
    op: plain.event.op,
    keys: sorted(plain.reply)
  })

  const session8h = await issueViaService(28800)
  check('B2', '8 小時會話：载荷恰一键 `{ttl_seconds:28800}`（body 级字段；网关丢头也不受影响）', { json: '{"ttl_seconds":28800}', calls: 1 }, {
    json: JSON.stringify(session8h.payload),
    calls: session8h.calls
  })
  check('B2b', '28800 签发回包仍恰 3 键、令牌逐字透传（只报长度与指纹）', { keys: ['expires_at', 'ok', 'token'], len: TOKEN.length, fp: fingerprint(TOKEN) }, {
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
  const atMax = await issueViaService(43200)
  check('B5', '43,200（上限）⇒ 放行，载荷 `{ttl_seconds:43200}`', { ok: true, json: '{"ttl_seconds":43200}' }, { ok: atMax.reply.ok, json: JSON.stringify(atMax.payload) })
  const over = await issueViaService(43201)
  check('B6', '43,201 ⇒ `INVALID_VALUE` ＋ 零往返', { reason: 'INVALID_VALUE', calls: 0 }, { reason: over.reply.reason, calls: over.calls })
  const fraction = await issueViaService(1.5)
  check('B7', '1.5 ⇒ `INVALID_VALUE` ＋ 零往返（不做四捨五入）', { reason: 'INVALID_VALUE', calls: 0 }, { reason: fraction.reply.reason, calls: fraction.calls })
  const asString = await issueViaService('28800')
  check('B8', '字符串 `"28800"` ⇒ `INVALID_VALUE` ＋ 零往返（不静默转数）', { reason: 'INVALID_VALUE', calls: 0 }, { reason: asString.reply.reason, calls: asString.calls })

  session.setUser(PLAIN_USER)
  const notAdmin = await issueViaService(28800)
  session.setUser(ADMIN_USER)
  check('B9', '非管理員 ＋ 8 小時 ⇒ `NOT_ADMIN` ＋ **零往返** ＋ 回包无 `token` 键', { reason: 'NOT_ADMIN', calls: 0, hasToken: false }, {
    reason: notAdmin.reply.reason,
    calls: notAdmin.calls,
    hasToken: 'token' in notAdmin.reply
  })
}

/* ===========================================================================
   C 段：服务端 op（真 `ops.OPS` ＋ 只读假 DB）
   =========================================================================== */
section('C', '服务端 op：缺省 2,592,000 / 28800 / 300 / 43200 / 越界 INVALID_VALUE 零读密钥 / 非 admin FORBIDDEN')

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
  const session8h = await callOp({ ttl_seconds: 28800 }, IDENTITY_ADMIN)
  check('C2', '`ttl_seconds: 28800` ⇒ `exp − iat ＝ 28,800`（8 小時）', { ok: true, ttl: 28800 }, {
    ok: session8h.reply.ok,
    ttl: Number(claimsOf(session8h.reply.token).exp) - Number(claimsOf(session8h.reply.token).iat)
  })
  check('C2b', '成功回包仍**恰 3 键** `{ok, token, expires_at}`（不新增读数键）', 'expires_at,ok,token', shapeOf(session8h.reply))
  check('C2c', '`expires_at` ＝ `iat + ttl` 的同一时钟换算（本地化 ISO 串）', new Date((NOW + 28800) * 1000).toISOString(), session8h.reply.expires_at)

  const atMin = await callOp({ ttl_seconds: 300 }, IDENTITY_ADMIN)
  check('C3', '下限 300 ⇒ 放行（`exp − iat ＝ 300`）', { ok: true, ttl: 300 }, {
    ok: atMin.reply.ok,
    ttl: Number(claimsOf(atMin.reply.token).exp) - Number(claimsOf(atMin.reply.token).iat)
  })
  const atMax = await callOp({ ttl_seconds: 43200 }, IDENTITY_ADMIN)
  check('C4', '上限 43,200 ⇒ 放行（`exp − iat ＝ 43,200`）', { ok: true, ttl: 43200 }, {
    ok: atMax.reply.ok,
    ttl: Number(claimsOf(atMax.reply.token).exp) - Number(claimsOf(atMax.reply.token).iat)
  })

  const under = await callOp({ ttl_seconds: 299 }, IDENTITY_ADMIN)
  const over = await callOp({ ttl_seconds: 43201 }, IDENTITY_ADMIN)
  check('C5', '299 / 43,201 ⇒ `INVALID_VALUE` ＋ 拒绝形状恰 3 键 ＋ **零读密钥 / 零写**', {
    under: { reason: 'INVALID_VALUE', denial: true, reads: 0, writes: 0 },
    over: { reason: 'INVALID_VALUE', denial: true, reads: 0, writes: 0 }
  }, {
    under: { reason: under.reply.reason, denial: isDenial(under.reply), reads: under.reads, writes: under.writes },
    over: { reason: over.reply.reason, denial: isDenial(over.reply), reads: over.reads, writes: over.writes }
  })
  const fraction = await callOp({ ttl_seconds: 1.5 }, IDENTITY_ADMIN)
  const asString = await callOp({ ttl_seconds: '28800' }, IDENTITY_ADMIN)
  const asNull = await callOp({ ttl_seconds: null }, IDENTITY_ADMIN)
  check('C6', '1.5 / `"28800"` ⇒ `INVALID_VALUE` 零读；`null` ＝ 键缺席 ⇒ 仍放行（30 天）', {
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

  const other = await callOp({ ttl_seconds: 28800 }, IDENTITY_OTHER)
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

const META = { expires_at: EXPIRES_AT, ttl_seconds: 28800 }

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
    ttl_seconds: 28800
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
  check('D8', '缺省宿主 ＝ 全局 `window`（不注入第三参也能交付）：`window.pywebview.api.receive_feicui_token` 被走到 1 次', { delivered: true, calls: 1, ttl: 28800 }, {
    delivered: viaGlobalWindow.delivered,
    calls: globalRecord.length,
    ttl: (globalRecord[0] || {}).meta ? globalRecord[0].meta.ttl_seconds : 0
  })
}

/* ===========================================================================
   E 段：页面契约（静态｜去注释后的码面）
   =========================================================================== */
section('E', '/connect 页面契约：第二按钮（8 小時）/ 并存 / admin 守卫 / 交付后清 DOM / 刷新提示 / 零持久层')

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
  check('E1b', '按钮文案逐字「為斐翠桌面簽發 8 小時會話」（在按钮表达式内恰 1 处；面板其余文案只作指引可复述）', 1, countIn(panelSrc, ": '為斐翠桌面簽發 8 小時會話' }}"))
  check('E1c', '两枚并存：30 天按钮 `data-action="feicui-device-issue"` 仍在（面板内恰 1 处）', 1, countIn(panelSrc, 'data-action="feicui-device-issue"'))
  check('E2', '面板内全部 `<button>` 均 `type="button"`（不发隐式 submit）', true, (panelSrc.match(/<button\b[^>]*>/g) || []).every((tag) => tag.includes('type="button"')))
  check('E3', '动作首行即 admin 守卫 ＋ 在途去重（`if (!admin.value) return` / `if (deviceBusy.value) return`）', true, /^\{\s*if \(!admin\.value\) return/.test(sessionBody) && sessionBody.indexOf('if (deviceBusy.value) return') > 0)
  check('E3b', '签前先清（`clearDeviceToken()` 出现在 `await issueDeviceToken(` **之前**）', true, (() => {
    const clearAt = sessionBody.indexOf('clearDeviceToken()')
    const awaitAt = sessionBody.indexOf('await issueDeviceToken(')
    return clearAt >= 0 && awaitAt >= 0 && clearAt < awaitAt
  })())
  check('E4', 'TTL 走单一常量：`issueDeviceToken({ ttlSeconds: DEVICE_SESSION_TTL_SECONDS })`，且该常量 ＝ `FEICUI_DEVICE_TTL.sessionSeconds`（28,800）', {
    callSite: 1,
    constantBinding: 1,
    constantValue: 28800
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
