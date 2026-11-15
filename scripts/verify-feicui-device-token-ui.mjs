/**
 * 玺爱 · **自检：管理員「斐萃桌面授權」入口（前端侧｜跨仓契约 §13）**
 * ============================================================================
 * 被测件（本单只改前端两处）：
 *   · `src/services/feicui.js` —— 新增 `FEICUI_DEVICE_OP` ＋ `issueDeviceToken()`（唯一业务入口；
 *     入口契约逐字 `{action:'verify', op:'issueFeicuiDeviceToken', payload:{}}`）；
 *   · `src/views/ConnectFeicuiView.vue` —— `/connect` 页内新增**仅管理员可见**的
 *     【斐萃桌面授權】卡片（`v-if="admin"` 条件渲染，非 CSS 隐藏 / 非 disabled）。
 * 真源：`/Users/kevin/bistro/feicui/ops/feicui-sync-20261115/dispatch-zang.md` §13.1 / §13.2
 *   （令牌只经内存、不进任何持久层、不进 URL、不打日志；非 admin ⇒ FORBIDDEN 零签发）。
 *
 * **完全离线**：零联网（传输层由本脚本的假件替换：`setCloudFunctionTransport`）、零真库、
 * 零真 CARD（`XIAI_NO_REAL_CARD=1`）、零浏览器、零部署。断言失败 ⇒ 退出码 1。
 *
 * 覆盖面（A〜G 七段；每条判据都能被变异样本打红，正 / 负对照就地证明探测器有效）：
 *   A 入口面：面板标记恰 1 处 / 开标签就地 `v-if="admin"` / **不是** disabled、**不是** CSS 隐藏
 *     （`v-show` / `hidden` / `display:none` 全 0）/ 三个钩子各 1 处 / 零 `data-admin-action` 撑破
 *     （全仓该族仍恰 12 值）；文案逐字「斐萃桌面授權」。
 *   B 内存-only（静态）：令牌唯一持有 `deviceToken` 一个 ref；上屏恰 1 处且落在面板内；
 *     码面零 `localStorage` / `sessionStorage` / `indexedDB` / `cookie` / `console` /
 *     `location` / `history` / `pushState` / `replaceState`；发前先清 ＋ 失败分支早退；首行 admin 守卫。
 *   C 调用形状（**可执行**）：事件恰 3 键、`action === 'verify'`（**不是**把 op 名当 action）、
 *     `op` 逐字、`payload` 深等于 `{}`；成功回包经服务层仍恰 3 键、令牌与到期逐字透传。
 *   D 四类存储零写入（**可执行**｜令牌窗口内）：localStorage / sessionStorage（set·remove·clear 各 0）
 *     ＋ IndexedDB `open` 0 ＋ `document.cookie` 写入 0；窗口后全表扫存储值 —— 令牌命中 0；
 *     正对照：同一计数器对一次真实写入必 +1。
 *   E 令牌不入 console / URL（**可执行**）：捕获的 console 条目内令牌命中 0（整轮条目数一并印出）、
 *     `location.search` / `hash` 未变、`history.*` 与 `location.assign` 调用 0；正对照：打一次必被捕获。
 *   F 失败路径零令牌（**可执行**）：非管理員 `NOT_ADMIN` / 未登錄 `LOGIN_REQUIRED` 皆零往返；
 *     服务端 `FORBIDDEN` 原样透传；回包恒无 `token` 键且恰 3 键；成功回包缺令牌 ⇒ 结构化拒绝；
 *     失败文案内令牌串命中 0。
 *   G 上屏繁體 ＋ 唯一通道：面板文案简体专用码位 0（正 / 负对照）；op 名在 `src/**` 只出现在
 *     `services/feicui.js`（`.vue` 零处）；路由零新增（零 `feicui-device` 字样）。
 *
 * 纪律：**不打印令牌原文**（只给长度与 sha256 前 12 位指纹）；令牌运行期随机构造（仓内零字面值）；
 *   不碰任何服务；不写被测仓库任何文件。
 * 用法：node scripts/verify-feicui-device-token-ui.mjs
 */
process.env.XIAI_NO_REAL_CARD = '1'

import { readFileSync, readdirSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

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

const countIn = (text, needle) => (needle === '' ? -1 : String(text).split(needle).length - 1)
const fingerprint = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12)
const sorted = (arr) => [...arr].sort()

/* ---------------------------------------------------------------------------
   1. 浏览器面假体（**只为让 `src/**` 的 ESM 真源在本机 Node 下可导入 / 可测**）
   ---------------------------------------------------------------------------
   四类存储全部**计数式**假体：每一次 set / remove / clear / open / cookie 写都会 +1，
   于是「零写入」是读数（可被正对照证伪），不是声明。
   ------------------------------------------------------------------------- */

const counters = {
  lsGet: 0,
  lsSet: 0,
  lsRemove: 0,
  lsClear: 0,
  ssGet: 0,
  ssSet: 0,
  ssRemove: 0,
  ssClear: 0,
  idbOpen: 0,
  cookieSet: 0,
  nav: 0
}

/** 令牌窗口（发请求 → 拿到令牌）内的四类存储 / 导航读数；只由 D 段填充、汇总行原样印出。 */
let tokenWindowDelta = null

function makeStoreApi(prefix, data) {
  return {
    getItem(key) {
      counters[`${prefix}Get`] += 1
      const name = String(key)
      return data.has(name) ? data.get(name) : null
    },
    setItem(key, value) {
      counters[`${prefix}Set`] += 1
      data.set(String(key), String(value))
    },
    removeItem(key) {
      counters[`${prefix}Remove`] += 1
      data.delete(String(key))
    },
    clear() {
      counters[`${prefix}Clear`] += 1
      data.clear()
    },
    key(index) {
      return [...data.keys()][index] || null
    },
    get length() {
      return data.size
    }
  }
}

const lsData = new Map()
const ssData = new Map()
const cookieJar = []

const localStorageShim = makeStoreApi('ls', lsData)
const sessionStorageShim = makeStoreApi('ss', ssData)

const locationShim = {
  href: 'https://xiai.test/xiai/connect',
  protocol: 'https:',
  host: 'xiai.test',
  pathname: '/xiai/connect',
  origin: 'https://xiai.test',
  search: '',
  hash: '',
  assign() {
    counters.nav += 1
  },
  replace() {
    counters.nav += 1
  },
  reload() {
    counters.nav += 1
  },
  toString() {
    return this.href
  }
}

const historyShim = {
  state: null,
  pushState() {
    counters.nav += 1
  },
  replaceState() {
    counters.nav += 1
  },
  back() {
    counters.nav += 1
  },
  forward() {
    counters.nav += 1
  }
}

const documentShim = {
  documentElement: { setAttribute: () => {}, getAttribute: () => null },
  get cookie() {
    return cookieJar.join('; ')
  },
  set cookie(value) {
    counters.cookieSet += 1
    cookieJar.push(String(value))
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  createElement: () => ({ style: {}, setAttribute: () => {} })
}

globalThis.window = globalThis.window || {}
Object.assign(globalThis.window, {
  localStorage: localStorageShim,
  sessionStorage: sessionStorageShim,
  location: locationShim,
  history: historyShim,
  document: documentShim,
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
})
globalThis.localStorage = localStorageShim
globalThis.sessionStorage = sessionStorageShim
globalThis.location = locationShim
globalThis.history = historyShim
globalThis.document = documentShim
globalThis.indexedDB = {
  open() {
    counters.idbOpen += 1
    throw new Error('OFFLINE_NO_INDEXEDDB')
  },
  deleteDatabase() {
    counters.idbOpen += 1
    throw new Error('OFFLINE_NO_INDEXEDDB')
  }
}
globalThis.navigator = globalThis.navigator || { clipboard: { writeText: async () => {} } }

/* --- console 捕获（**只存文本、不回显**；用于「令牌不打日志」的可执行判据） --- */
const consoleEntries = []
const realConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug }
function captureConsole() {
  ;['log', 'warn', 'error', 'info', 'debug'].forEach((level) => {
    console[level] = (...args) => {
      consoleEntries.push({ level, text: args.map((item) => (typeof item === 'string' ? item : safeStringify(item))).join(' ') })
    }
  })
}
function releaseConsole() {
  Object.keys(realConsole).forEach((level) => {
    console[level] = realConsole[level]
  })
}
function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/* ---------------------------------------------------------------------------
   2. 测试材料（运行期随机构造 ⇒ 仓内零令牌 / 零密钥字面值）
   ------------------------------------------------------------------------- */

const TOKEN = `v1.${randomBytes(36).toString('base64url')}.${randomBytes(32).toString('base64url')}`
const EXPIRES_AT = '2026-12-15T04:00:00.000Z'
const SERVER_MESSAGE_FORBIDDEN = '僅管理員可以簽發斐萃桌面授權；本次零簽發。'

function snapshot() {
  return { ...counters }
}
function deltaSince(before) {
  const out = {}
  Object.keys(counters).forEach((key) => {
    out[key] = counters[key] - (before[key] || 0)
  })
  return out
}

/* ---------------------------------------------------------------------------
   3. 静态源面（去注释后判；判据只看码面 / 上屏面）
   ------------------------------------------------------------------------- */

const VIEW_REL = 'src/views/ConnectFeicuiView.vue'
const SERVICE_REL = 'src/services/feicui.js'
const ROUTER_REL = 'src/router/index.js'
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

/** 去注释（HTML / 块 / 行；行注释不吞 `http://` 这类协议头）。 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

const viewRaw = read(VIEW_REL)
const viewSrc = stripComments(viewRaw)
const serviceRaw = read(SERVICE_REL)
const serviceSrc = stripComments(serviceRaw)
const routerSrc = stripComments(read(ROUTER_REL))

function walkFiles(dir, out = []) {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(vue|js)$/.test(entry.name)) out.push(full)
  })
  return out
}
const SRC_FILES = walkFiles(path.join(ROOT, 'src'))

/* 入口面板定界：从面板开标签到其后第一个 `</section>`（面板内无嵌套 section）。 */
const PANEL_MARK = 'data-feicui-device-panel'
const panelOpenAt = viewSrc.indexOf('<section v-if="admin" class="panel" ' + PANEL_MARK)
const panelEndAt = panelOpenAt < 0 ? -1 : viewSrc.indexOf('</section>', panelOpenAt)
const panelSrc = panelOpenAt < 0 || panelEndAt < 0 ? '' : viewSrc.slice(panelOpenAt, panelEndAt + '</section>'.length)
const panelText = panelSrc.replace(/<[^>]*>/g, ' ')

/* script 段（静态结构判据用）。 */
const scriptSrc = viewSrc.slice(viewSrc.indexOf('<script setup>'), viewSrc.indexOf('</script>'))

/** 按花括号配平切出顶层函数体（本文件无花括号不平衡的字面量）。 */
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

/* ===========================================================================
   A 段：入口面（位置 / 门 / **不是** disabled 或 CSS 隐藏）
   =========================================================================== */
section('A', '① 入口：僅管理員可見（條件渲染）；文案【斐萃桌面授權】')
{
  check('A1', '入口面板标记 `data-feicui-device-panel` 在 View（去注释）恰 1 处', 1, countIn(viewSrc, PANEL_MARK))
  const openTagEnd = panelOpenAt < 0 ? -1 : viewSrc.indexOf('>', panelOpenAt)
  const openTag = openTagEnd > 0 ? viewSrc.slice(panelOpenAt, openTagEnd + 1) : ''
  check('A2', '面板开标签就地带 `v-if="admin"`（真条件渲染 ⇒ 非管理員根本无此 DOM）', true, /v-if="admin"/.test(openTag))
  /* 变异负对照：同一探测器必须**认得**「假门」——否则 A2 恒真、什么都没钉住。
     判据形态与 A2 / A4 同构：`v-if="admin"` 在，且无 `v-show` / `hidden` / `display:none`。 */
  const gateHolds = (tag) => /v-if="admin"/.test(tag) && !/v-show/.test(tag) && !/\bhidden\b/.test(tag) && !/display:\s*none/.test(tag)
  check('A3', '负对照：`v-if="!admin"` / 只在 class 写 hidden / `v-show` 反向 / `:disabled` 四种「冒充门」样本必判 false，真门样本必判 true', { inverted: false, classHidden: false, vShow: false, disabled: false, real: true }, {
    inverted: gateHolds('<section v-if="!admin" class="panel" ' + PANEL_MARK + '>'),
    classHidden: gateHolds('<section class="panel hidden" ' + PANEL_MARK + '>'),
    vShow: gateHolds('<section v-if="admin" class="panel" v-show="admin" ' + PANEL_MARK + '>'),
    disabled: gateHolds('<section class="panel" ' + PANEL_MARK + ' :disabled="!admin">'),
    real: gateHolds('<section v-if="admin" class="panel" ' + PANEL_MARK + '>')
  })
  check('A4', '面板内零 `v-show` / 零 `hidden` 属性 / 零 `display:none`（不用 CSS 隐藏冒充权限门）', { vShow: 0, hiddenAttr: 0, displayNone: 0 }, {
    vShow: countIn(panelSrc, 'v-show'),
    hiddenAttr: countIn(panelSrc, ' hidden') + countIn(panelSrc, 'hidden='),
    displayNone: countIn(panelSrc, 'display:none') + countIn(panelSrc, 'display: none')
  })
  check('A5', '面板内零 `data-admin-action`（该族全仓仍恰 12 值，本入口不得撑破）', { inPanel: 0, globalCount: 12 }, {
    inPanel: countIn(panelSrc, 'data-admin-action'),
    globalCount: new Set(SRC_FILES.flatMap((file) => (stripComments(readFileSync(file, 'utf8')).match(/data-admin-action="([^"]+)"/g) || []).map((item) => item.replace(/^data-admin-action="/, '').replace(/"$/, '')))).size
  })
  check('A6', '入口文案【斐萃桌面授權】逐字在面板 `<h2>` 内恰 1 处', { heading: 1, inPanel: 1 }, {
    heading: countIn(panelSrc, '<h2>斐萃桌面授權</h2>'),
    inPanel: countIn(viewSrc, '斐萃桌面授權') >= 1 ? 1 : 0
  })
  check('A7', '三个动作钩子各 1 处且在面板内（签发 / 複製 / 清除），且均为 `type="button"`', { issue: 1, copy: 1, clear: 1, disabledOnly: 0 }, {
    issue: countIn(panelSrc, 'data-action="feicui-device-issue"'),
    copy: countIn(panelSrc, 'data-action="feicui-device-copy"'),
    clear: countIn(panelSrc, 'data-action="feicui-device-clear"'),
    disabledOnly: countIn(panelSrc, 'disabled="disabled"')
  })
  check('A8', '面板内全部按钮 `type="button"`（不发请求的按钮不得触发隐式 submit）', true, (panelSrc.match(/<button\b[^>]*>/g) || []).every((tag) => tag.includes('type="button"')))
}

/* ===========================================================================
   B 段：内存-only（静态半边）—— 令牌唯一持有 / 唯一上屏 / 零持久层 / 零日志
   =========================================================================== */
section('B', '② 令牌只在组件内存：唯一持有 ＋ 唯一上屏 ＋ 码面零持久层 / 零日志 / 零 URL')
{
  check('B1', '令牌唯一持有：`const deviceToken = ref(null)` 恰 1 处（成功回包只拆 token / expires_at 两键）', { ref: 1, assignKeys: 1 }, {
    ref: countIn(scriptSrc, 'const deviceToken = ref(null)'),
    assignKeys: countIn(scriptSrc, 'deviceToken.value = { token: reply.token, expires_at: reply.expires_at }')
  })
  const storKeys = ['localStorage', 'sessionStorage', 'indexedDB', 'cookie', 'console.', 'location', 'history', 'pushState', 'replaceState']
  const hits = storKeys.reduce((acc, key) => {
    acc[key] = countIn(viewSrc, key)
    return acc
  }, {})
  check('B2', 'View（去注释）码面零 `localStorage` / `sessionStorage` / `indexedDB` / `cookie` / `console` / `location` / `history` / `pushState` / `replaceState`', true, Object.values(hits).every((value) => value === 0))
  console.log(JSON.stringify({ readout: 'B2 逐键读数', hits }))
  /* 正对照：探测器对写作样本必报（否则 B2 的「全 0」可能只是探测器坏了）。 */
  const probe = (text) => storKeys.filter((key) => text.includes(key)).length
  check('B3', '负对照：含四类存储 / console / URL 写的样本必被命中（探测器有效）', 9, probe('localStorage.setItem(1);sessionStorage.setItem(1);indexedDB.open(1);document.cookie="a";console.log(1);location.search="?";history.pushState({},"","");history.replaceState({},"","")'))
  check('B4', '令牌上屏恰 1 处（`:value="deviceToken.token"` 只读文本域），且落在面板内', { all: 1, inPanel: 1 }, {
    all: countIn(viewSrc, ':value="deviceToken.token"'),
    inPanel: countIn(panelSrc, ':value="deviceToken.token"')
  })
  check('B5', '到期时间以本地时间格式化后上屏（`formatDateTime(deviceToken.expires_at)` 恰 1 处）', 1, countIn(viewSrc, 'formatDateTime(deviceToken.expires_at)'))
  check('B6', '令牌 block 由 `v-if="deviceToken"` 控制（null ⇒ 整块不渲染，不留占位令牌文本）', 1, countIn(panelSrc, '<div v-if="deviceToken" class="token-box" data-feicui-device-token-box>'))
  const issueBody = functionBody(scriptSrc, 'onIssueDeviceToken')
  const clearAt = issueBody.indexOf('deviceToken.value = null')
  const awaitAt = issueBody.indexOf('await issueDeviceToken()')
  const failAt = issueBody.indexOf('if (!reply.ok)')
  const assignAt = issueBody.indexOf('deviceToken.value = {')
  check('B7', '发前先清：`deviceToken.value = null` 出现在 `await issueDeviceToken()` **之前**', true, clearAt >= 0 && awaitAt >= 0 && clearAt < awaitAt)
  check('B8', '失败分支早退：`if (!reply.ok) { … return }` 整体落在唯一赋值点**之前**', true, failAt >= 0 && assignAt > failAt && issueBody.slice(failAt, assignAt).includes('return'))
  check('B9', '动作首行即 admin 守卫（`if (!admin.value) return`），非管理員零请求', true, /^\{\s*if \(!admin\.value\) return/.test(issueBody))
  check('B10', '请求在途去重（`deviceBusy` 守卫）＋ 离开页面即清（`onUnmounted(clearDeviceToken)`）', { busyGuard: true, unmountClear: true }, {
    busyGuard: issueBody.indexOf('if (deviceBusy.value) return') > 0 && issueBody.indexOf('if (deviceBusy.value) return') < awaitAt,
    unmountClear: scriptSrc.includes('onUnmounted(clearDeviceToken)') && functionBody(scriptSrc, 'clearDeviceToken').includes('deviceToken.value = null')
  })
  check('B11', '令牌**唯一清除点**＝`clearDeviceToken`（置 null），且视图零第二处持久化 / 缓存点', { clearAssignments: 2, cacheHits: 0 }, {
    clearAssignments: countIn(scriptSrc, 'deviceToken.value = null'),
    cacheHits: countIn(scriptSrc, 'Cache') + countIn(scriptSrc, 'sessionStorage')
  })
}

/* ===========================================================================
   C〜F 段：可执行（真 `src/services/feicui.js` ＋ 假传输）
   =========================================================================== */
const cloudbaseFn = await import(path.join(ROOT, 'src/data/cloudbaseFn.js'))
const feicuiSvc = await import(path.join(ROOT, SERVICE_REL))
const session = await import(path.join(ROOT, 'src/data/session.js'))

const ADMIN_USER = { id: 'u-' + '0'.repeat(16), phone: '13800000000', role: 'admin', nickname: '自檢管理員' }
const PLAIN_USER = { id: 'u-' + '1'.repeat(16), phone: '13900000000', role: 'user', nickname: '自檢用戶' }

const transportCalls = []
let transportMode = 'ok'
cloudbaseFn.setCloudFunctionTransport(async (name, data) => {
  transportCalls.push({ name, data })
  if (transportMode === 'forbidden') {
    return { result: { ok: false, reason: 'FORBIDDEN', message: SERVER_MESSAGE_FORBIDDEN } }
  }
  if (transportMode === 'no-token') {
    return { result: { ok: true, expires_at: EXPIRES_AT } }
  }
  if (transportMode === 'transport-down') {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '雲端暫時不可用（自檢假件）。' }
  }
  return { result: { ok: true, token: TOKEN, expires_at: EXPIRES_AT } }
})

/* 登录态（会话本身走既有 localStorage 通道，与令牌无关；先置好再开测令牌窗口）。 */
session.setUser(ADMIN_USER)

section('C', '③ 调用形状：`{action:\'verify\', op:\'issueFeicuiDeviceToken\', payload:{}}` ＋ 回包恰 3 键')
let successReply = null
{
  transportCalls.length = 0
  successReply = await feicuiSvc.issueDeviceToken()
  const call = transportCalls[0] || {}
  const event = call.data || {}
  check('C1', '传输层恰 1 次往返，且函数名逐字 `xiai-user-token`', { calls: 1, name: 'xiai-user-token' }, { calls: transportCalls.length, name: call.name })
  check('C2', '事件对象恰 3 键 `{action, op, payload}`（无第四键、无身份类键）', ['action', 'op', 'payload'], sorted(Object.keys(event)))
  check('C3', '入口契约 `action === \'verify\'`（**不是**把 op 名当 action）', 'verify', event.action)
  check('C4', '`op` 逐字 ＝ `issueFeicuiDeviceToken`（与服务端注册面同字）', 'issueFeicuiDeviceToken', event.op)
  check('C5', '`payload` 深等于空对象 `{}`（载荷封闭；本入口不收集任何字段）', { keys: [], json: '{}' }, { keys: Object.keys(event.payload || {}), json: JSON.stringify(event.payload) })
  check('C6', '成功回包经服务层仍**恰 3 键** `{ok, token, expires_at}`', ['expires_at', 'ok', 'token'], sorted(Object.keys(successReply)))
  check('C7', '令牌与到期时间**逐字**透传（不裁剪 / 不改写）；只报长度与指纹、不打印原文', { ok: true, tokenLen: TOKEN.length, tokenFp: fingerprint(TOKEN), expiresAt: EXPIRES_AT }, {
    ok: successReply.ok,
    tokenLen: String(successReply.token || '').length,
    tokenFp: fingerprint(successReply.token || ''),
    expiresAt: successReply.expires_at
  })
  check('C8', '服务层导出 op 名常量（`FEICUI_DEVICE_OP`），视图不直连该字面值', { constant: 'issueFeicuiDeviceToken', viewHits: 0 }, { constant: feicuiSvc.FEICUI_DEVICE_OP, viewHits: countIn(viewSrc, 'issueFeicuiDeviceToken') })
}

section('D', '④ 四类存储零写入（令牌窗口内；可执行）')
{
  /* **令牌窗口**：从「即将请求」到「已拿到令牌」这一段，是唯一可能发生持久化的时刻。
     窗口前的一次 `session.setUser()` 是登录态自身的既有写入（与令牌无关），已在窗口外。 */
  const before = snapshot()
  captureConsole()
  const reply = await feicuiSvc.issueDeviceToken()
  releaseConsole()
  const window = deltaSince(before)
  tokenWindowDelta = window
  check('D0', '窗口内确实拿到了令牌（判据有效：不是「没调用」造成的零写入）', true, reply.ok === true && reply.token === TOKEN)
  check('D1', 'localStorage 零写入（set 0 / remove 0 / clear 0）', { set: 0, remove: 0, clear: 0 }, { set: window.lsSet, remove: window.lsRemove, clear: window.lsClear })
  check('D2', 'sessionStorage 零写入（set 0 / remove 0 / clear 0）', { set: 0, remove: 0, clear: 0 }, { set: window.ssSet, remove: window.ssRemove, clear: window.ssClear })
  check('D3', 'IndexedDB 零打开 / 零删除（`open` 计数 0）', 0, window.idbOpen)
  check('D4', 'cookie 零写入（`document.cookie` setter 计数 0）', 0, window.cookieSet)
  const storedValues = [...lsData.values()].concat([...ssData.values()])
  const tokenInStores = storedValues.filter((value) => String(value).includes(TOKEN)).length
  check('D5', '四类存储**全表扫**：令牌串在已存值中命中 0（localStorage ＋ sessionStorage 共 ' + storedValues.length + ' 项；IndexedDB / cookie 为空）', 0, tokenInStores + cookieJar.filter((item) => item.includes(TOKEN)).length)
  /* 正对照：同一计数器对一次真实写入必 +1（否则「零写入」可能只是假体没接线）。 */
  const probeBefore = snapshot()
  localStorageShim.setItem('__probe__', '1')
  sessionStorageShim.setItem('__probe__', '1')
  documentShim.cookie = '__probe__=1'
  try {
    globalThis.indexedDB.open('__probe__')
  } catch {
    /* 假体故意抛：计数已 +1 */
  }
  const probeDelta = deltaSince(probeBefore)
  check('D6', '正对照：四类各写一次 ⇒ 计数器 ldc 各 +1（探测器确实接线）', { ls: 1, ss: 1, idb: 1, cookie: 1 }, { ls: probeDelta.lsSet, ss: probeDelta.ssSet, idb: probeDelta.idbOpen, cookie: probeDelta.cookieSet })
  localStorageShim.removeItem('__probe__')
  sessionStorageShim.removeItem('__probe__')
  cookieJar.length = 0
}

section('E', '⑤ 令牌不入 console、不入 URL（可执行）')
{
  const before = snapshot()
  consoleEntries.length = 0
  captureConsole()
  await feicuiSvc.issueDeviceToken()
  releaseConsole()
  const window = deltaSince(before)
  check('E1', '捕获的 console 条目内令牌串命中 0（整轮条目数一并印出）', { entries: 0, tokenHits: 0 }, {
    entries: consoleEntries.length,
    tokenHits: consoleEntries.filter((entry) => entry.text.includes(TOKEN)).length
  })
  check('E2', '窗口内 `location.search` / `hash` 未变、`history.*` 与 `location.assign` 调用 0', { search: '', hash: '', navOps: 0 }, { search: locationShim.search, hash: locationShim.hash, navOps: window.nav })
  /* 正对照：往 console 打一次令牌 ⇒ 捕获器必命中（E1 的 0 不是「捕获器没接上」）。 */
  captureConsole()
  console.warn('probe', TOKEN)
  releaseConsole()
  check('E3', '正对照：console 打一次令牌 ⇒ 捕获器命中 1（探测器有效）', 1, consoleEntries.filter((entry) => entry.text.includes(TOKEN)).length)
  consoleEntries.length = 0
}

section('F', '⑥ 失败路径零令牌（非管理員 / 未登錄 / 服务端 FORBIDDEN / 回包残缺）')
{
  /* F1：非管理員（会话为普通用户）⇒ 前端前置拒 ＋ **零往返** ＋ 回包无 token 键。 */
  session.setUser(PLAIN_USER)
  transportCalls.length = 0
  const notAdmin = await feicuiSvc.issueDeviceToken()
  check('F1', '非管理員：`NOT_ADMIN` ＋ **零往返** ＋ 回包恰 3 键且无 `token` 键', { reason: 'NOT_ADMIN', roundtrips: 0, keys: ['message', 'ok', 'reason'] }, {
    reason: notAdmin.reason,
    roundtrips: transportCalls.length,
    keys: sorted(Object.keys(notAdmin))
  })
  /* F2：未登錄 ⇒ LOGIN_REQUIRED ＋ 零往返。 */
  session.setUser(null)
  transportCalls.length = 0
  const anon = await feicuiSvc.issueDeviceToken()
  check('F2', '未登錄：`LOGIN_REQUIRED` ＋ **零往返** ＋ 回包无 `token` 键（恰 3 键）', { reason: 'LOGIN_REQUIRED', roundtrips: 0, keys: ['message', 'ok', 'reason'] }, {
    reason: anon.reason,
    roundtrips: transportCalls.length,
    keys: sorted(Object.keys(anon))
  })
  /* F3：服务端 FORBIDDEN ⇒ 原样透传（不伪装成传输故障、不造兜底文案）。 */
  session.setUser(ADMIN_USER)
  transportMode = 'forbidden'
  transportCalls.length = 0
  const forbidden = await feicuiSvc.issueDeviceToken()
  check('F3', '服务端 `FORBIDDEN`：reason / message **逐字透传**（恰 3 键、无 `token` 键）', { reason: 'FORBIDDEN', message: SERVER_MESSAGE_FORBIDDEN, keys: ['message', 'ok', 'reason'] }, {
    reason: forbidden.reason,
    message: forbidden.message,
    keys: sorted(Object.keys(forbidden))
  })
  /* F4：传输层故障 ⇒ STORAGE_UNAVAILABLE（**不得**伪装成 FORBIDDEN）。 */
  transportMode = 'transport-down'
  const down = await feicuiSvc.issueDeviceToken()
  check('F4', '传输层故障：`STORAGE_UNAVAILABLE`（**不伪装**成 `FORBIDDEN`）＋ 无 `token` 键', { reason: 'STORAGE_UNAVAILABLE', hasToken: false }, {
    reason: down.reason,
    hasToken: Object.prototype.hasOwnProperty.call(down, 'token')
  })
  /* F5：回包 `ok:true` 却缺令牌（形状残缺）⇒ 结构化拒绝、**不編造令牌**。 */
  transportMode = 'no-token'
  const malformed = await feicuiSvc.issueDeviceToken()
  check('F5', '回包 `ok:true` 但缺令牌 ⇒ 结构化拒绝 `STORAGE_UNAVAILABLE` ＋ 零令牌（不編造）', { ok: false, reason: 'STORAGE_UNAVAILABLE', hasToken: false }, {
    ok: malformed.ok,
    reason: malformed.reason,
    hasToken: Object.prototype.hasOwnProperty.call(malformed, 'token')
  })
  transportMode = 'ok'
  /* F6：所有失败回包与可读文案里令牌串命中 0（失败路径**零令牌文本**）。 */
  const failureReplies = [notAdmin, anon, forbidden, down, malformed]
  check('F6', '五条失败回包的全量序列化文本内令牌串命中 0（失败路径零令牌文本）', 0, failureReplies.filter((reply) => safeStringify(reply).includes(TOKEN)).length)
  check('F7', '失败回包形状恒**恰 3 键** `{ok, reason, message}`（与契约同形；无读数键泄漏）', true, failureReplies.every((reply) => JSON.stringify(sorted(Object.keys(reply))) === JSON.stringify(['message', 'ok', 'reason'])))
}

/* ===========================================================================
   G 段：上屏繁體 ＋ 唯一通道 ＋ 路由零新增
   =========================================================================== */
section('G', '⑦ 上屏文案繁體 ＋ op 名唯一通道 ＋ 路由零新增')
{
  /* 只含「简体专用」码位（无合法繁体用法）⇒ 命中必为简体（与仓内 G 段同一张表）。 */
  const SIMPLIFIED_ONLY = new Set(
    '说这认边过请对员码确录记误页项题类别输选择开关击钮盘师价体变总积键种样数据获奖励审览处办当给让删询详单号称显标签档尽为无与专业东丝两严个临汉从众们会优传伟伤伦'.split('')
  )
  const simplifiedHits = (text) => [...new Set([...text].filter((ch) => SIMPLIFIED_ONLY.has(ch)))]
  check('G0', '正 / 负对照：简体串必命中、纯繁体串不命中（探测器有效）', { simplified: true, traditionalClean: true }, {
    simplified: simplifiedHits('这里说数据').length > 0,
    traditionalClean: simplifiedHits('這裏說數據').length === 0
  })
  check('G1', '入口面板上屏文案简体专用码位命中 0（全繁體）', [], simplifiedHits(panelText))
  const FORBIDDEN_WORDS = ['生成密钥', '设置', '密钥', '默认', '网络', '缓存', '点击']
  check('G2', '面板简体词面零命中（生成密钥 / 设置 / 密钥 / 默认 / 网络 / 缓存 / 点击）', [], FORBIDDEN_WORDS.filter((word) => panelSrc.includes(word)))
  const serviceHits = []
  SRC_FILES.forEach((file) => {
    const rel = path.relative(ROOT, file)
    const hits = countIn(stripComments(readFileSync(file, 'utf8')), 'issueFeicuiDeviceToken')
    if (hits > 0) serviceHits.push({ file: rel, hits })
  })
  check('G3', 'op 名在 `src/**` 只出现在 `src/services/feicui.js`（组件 / 视图零直连字面值）', [{ file: 'src/services/feicui.js', hits: 1 }], serviceHits)
  check('G4', '服务层导出的通道常量沿用既有 `xiai-user-token`（不另造第二个函数名）', 'xiai-user-token', feicuiSvc.FEICUI_FUNCTION_NAME)
  check('G5', '路由零新增：`src/router/index.js` 内零 `feicui-device` 字样（入口是页内卡片，不新开一级导航）', 0, countIn(routerSrc, 'feicui-device'))
  check('G6', '入口所在路由 `/connect` 未设 `requiresAuth`（未登錄可直达并看到登录引导；页内门由 `v-if="admin"` 与本卡片的 admin 守卫之二重把关）', 1, countIn(routerSrc, "path: '/connect'"))
}

/* ---------------------------------------------------------------------------
   汇总
   ------------------------------------------------------------------------- */
console.log(
  JSON.stringify({
    summary: { total, passed, failed: total - passed },
    sections: sectionStats,
    failed_ids: failedIds,
    storage_window_deltas: tokenWindowDelta,
    note: '完全离线：假传输 + 计数式存储假体；令牌运行期随机构造，读数只给长度与指纹；不写被测仓库任何文件。'
  })
)
process.exit(failedIds.length === 0 ? 0 : 1)
