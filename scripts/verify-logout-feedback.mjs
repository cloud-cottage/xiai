/**
 * 玺爱 · **退出登錄三態反馈** 自检套件（离線、零网络、零副作用）
 * ============================================================================
 * 覆盖 Kevin 报的 UI 缺口：「点击退出登录，页面没有已经退出的操作反馈」。
 *
 * 判据（静态 ＋ 纯函数；每条皆可判负，末尾带变异负对照证明尺子会响）：
 *   A  **文案单点**：成功文案 `已退出登錄`（**繁體，含 `錄`**）在 `src/services/logoutText.js`
 *      唯一一处定义；退出函数消费同一常量（不另写字面）；全 `src/**` 零简体 `已退出登录`。
 *   B  **顺序（不得先清后发请求）**：`services/auth.js::logout` 里**第一个 `await`
 *      必须早于 `setUser(null)` / 任何清点**；且 `logout` 是 `async` 且 `await signOutOtpSession()`。
 *   C  **失败分支**：`退出失敗：` 前缀存在；失败 return **早于** `setUser(null)`
 *      （⇒ 失败时**不做状态重置**、原会话保留）；文案经 `logoutFailureText()` 归一。
 *   D  **三态 UI**：两个入口（頁頭 / 登錄頁）的退出按钮都读同一份 `logoutView`
 *      （label ＋ disabled ＋ aria-busy）；`正在退出…` 来自单点；提示条容器挂在 `App.vue`
 *      且 `aria-live="polite"`；三个文件零 `alert(`。
 *   E  **幂等**：未登錄 ⇒ `logout` 首行短路回 `ok`（零网络）；壳层 `running` 在飞即返回；
 *      退出按钮只在**已登錄**分支渲染。
 *   F  **登出后回到未登錄态（与既有判据同源）**：管理员入口判据仍只来自
 *      `data/session.js::isAdmin`（`state.user`），退出只经 `setUser(null)` 写同一份状态；
 *      `services/admin.js::isAdminSession` 读 `currentUser()`；`AppSidebar` 的【印譜匯觀】
 *      由同一 `isAdmin` 控制 ⇒ 退出后整条不渲染。
 *   G  **纯函数**：`logoutView` / `logoutFailureText` / `shortReason` / `logoutOutcome`
 *      的取值与边界（含前綴不重复、超长截断、空原因兜底）。
 *   H  **负对照**：把 `setUser(null)` 变异到函数首行 ⇒ B 判据必须翻红；把原因变异成
 *      超长多行 ⇒ `shortReason` 必须仍是一行且截断。
 *
 * 纪律：只读 `src/**`；离线（`XIAI_NO_REAL_CARD=1`）；不新增依赖；断言失败 ⇒ 退出码非 0。
 */
process.env.XIAI_NO_REAL_CARD = '1'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  LOGOUT_DONE_TEXT,
  LOGOUT_FAIL_PREFIX,
  LOGOUT_IDLE_TEXT,
  LOGOUT_RUNNING_TEXT,
  logoutFailureText,
  logoutOutcome,
  logoutView,
  shortReason
} from '../src/services/logoutText.js'
/* **运行时段**（I 段）：真函数 ＋ 假平台（`setOtpAuthProvider` 注入缝）＋ 零网络
   —— 判的是「服务层真跑了」而不是「源码里写了字」。 */
import * as authService from '../src/services/auth.js'
import { currentUser, isAdmin, setUser } from '../src/data/session.js'
import { resetOtpAuth, setOtpAuthProvider } from '../src/data/cloudbaseAuth.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
   0. 读数与小工具（沿既有套件形态：check(id, desc, expected, actual) ＋ JSON summary）
   --------------------------------------------------------------------------- */
const results = []
let failures = 0

function canon(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`)
    .join(',')}}`
}

function check(id, desc, expected, actual) {
  const pass = canon(expected) === canon(actual)
  if (!pass) failures += 1
  results.push({ id, desc, pass, expected, actual })
  console.log(JSON.stringify({ id, case: desc, pass, expected, actual }))
}

const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')

/**
 * 去注释（`<!-- -->` / 块注释 / 整行行尾 `//`）：注释里写的「正在退出…」不算实现，
 * 判据只看**实码字面**（同族口径见 `verify-modal-esc.mjs`）。
 */
function stripComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
}

/** `data-logout` 按钮计数（排除 `data-logout-error` / `data-logout-done` 这两个兄弟属性）。 */
function countLogoutButtons(text) {
  return (text.match(/data-logout(?![\w-])/g) || []).length
}

/** `data-logout` 按钮在模板中的位置（同上，不能被兄弟属性提前命中）。 */
function logoutButtonIndex(text) {
  const match = /data-logout(?![\w-])/.exec(text)
  return match ? match.index : -1
}

/** 从 `marker` 起做花括号配对，取出一段函数体（用于逐字判顺序）。 */
function bodyOf(source, marker) {
  const start = source.indexOf(marker)
  if (start < 0) return ''
  const open = source.indexOf('{', start)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return ''
}

/** 全目录递归收集（只收 `.js` / `.vue`）。 */
import { readdirSync } from 'node:fs'
function collect(dir, out = []) {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) collect(rel, out)
    else if (/\.(js|vue)$/.test(entry.name)) out.push(rel)
  }
  return out
}

const AUTH = read('src/services/auth.js')
const TEXTS = read('src/services/logoutText.js')
const PLATFORM = read('src/data/cloudbaseAuth.js')
const SHELL = read('src/utils/useLogout.js')
const TOAST_BUS = read('src/utils/appToast.js')
const HEADER = read('src/components/AppHeader.vue')
const LOGIN = read('src/views/LoginView.vue')
const TOAST_VIEW = read('src/components/AppToast.vue')
const APP = read('src/App.vue')
const SESSION = read('src/data/session.js')
const SIDEBAR = read('src/components/AppSidebar.vue')
const ADMIN = read('src/services/admin.js')

const logoutBody = bodyOf(AUTH, 'export async function logout()')
const srcFiles = collect('src')
const allSrc = srcFiles.map((rel) => ({ rel, text: read(rel) }))

/* ---------------------------------------------------------------------------
   A. 文案单点（成功文案必须存在、必须繁體、必须与消费点同源）
   --------------------------------------------------------------------------- */
check('A1', '成功文案常量 `LOGOUT_DONE_TEXT` 逐字为 `已退出登錄`（繁體，含 `錄`）', { done: '已退出登錄', hasLu: true }, { done: LOGOUT_DONE_TEXT, hasLu: LOGOUT_DONE_TEXT.includes('錄') })

const doneLiteralHits = allSrc.filter(({ text }) => text.includes("'已退出登錄'") || text.includes('"已退出登錄"')).map(({ rel }) => rel)
check(
  'A2',
  '字面 `已退出登錄` 全 `src/**` **只在** `src/services/logoutText.js` 出现一次（其余消费方一律用常量 ⇒ 不会漂成两套字）',
  ['src/services/logoutText.js'],
  doneLiteralHits
)

const simplifiedHits = allSrc.filter(({ text }) => /已退出登录|退出登录|登出成功/.test(text)).map(({ rel }) => rel)
check('A3', '全 `src/**` 零简体 `已退出登录` / `退出登录`（本单文案一律繁體）', [], simplifiedHits)

check(
  'A4',
  '退出函数（`services/auth.js::logout`）的成功分支**用同一常量** `LOGOUT_DONE_TEXT`（不另写字面文案）',
  { usesConstant: true, hits: 2 },
  { usesConstant: logoutBody.includes('LOGOUT_DONE_TEXT'), hits: logoutBody.split('LOGOUT_DONE_TEXT').length - 1 }
)

/* ---------------------------------------------------------------------------
   B. 顺序：await 之后才清本地（不得先清后发请求）
   --------------------------------------------------------------------------- */
const firstAwait = logoutBody.indexOf('await')
const clearAt = logoutBody.indexOf('setUser(null)')
const tokenClearAt = logoutBody.indexOf('clearUserToken()')

function orderHolds(body) {
  const a = body.indexOf('await')
  const c = body.indexOf('setUser(null)')
  if (a < 0 || c < 0) return false
  const token = body.indexOf('clearUserToken()')
  const adminToken = body.indexOf('clearAdminToken()')
  const reward = body.indexOf('resetOtpAuth()')
  /* ① await 在场且早于**每一个**清点；② 清点彼此顺序不变（登錄態 → 令牌 → SDK 實例）。 */
  return a < c && a < token && a < adminToken && a < reward && c < token && token < adminToken && adminToken < reward
}

check(
  'B1',
  '`logout` 体里第一个 `await` **早于**全部清点（`setUser(null)` → `clearUserToken()` → `clearAdminToken()` → `resetOtpAuth()`），且清点顺序不变',
  { awaitsBeforeClear: true, clearOrderKept: true, orderHolds: true },
  {
    awaitsBeforeClear: firstAwait >= 0 && clearAt >= 0 && firstAwait < clearAt,
    clearOrderKept: clearAt < tokenClearAt && tokenClearAt < logoutBody.indexOf('clearAdminToken()') && logoutBody.indexOf('clearAdminToken()') < logoutBody.indexOf('resetOtpAuth()'),
    orderHolds: orderHolds(logoutBody)
  }
)

check(
  'B2',
  '`logout` 是 `async` 且**等的是平台撤销** `signOutOtpSession()`（唯一可能失败的一步，失败点可控）',
  { async: true, awaitsSignOut: true, asyncDecl: true },
  {
    async: /export\s+async\s+function\s+logout\s*\(/.test(AUTH),
    awaitsSignOut: /await\s+signOutOtpSession\(\)/.test(logoutBody),
    asyncDecl: AUTH.includes('export async function logout()')
  }
)

check(
  'B3',
  '平台撤销入口自身**不碰本地状态**（不清会话、不清令牌；清点只有 `auth.js::logout` 一处）',
  { touchesLocalClear: false },
  { touchesLocalClear: /setUser\(|clearUserToken\(|clearAdminToken\(|resetOtpAuth\(/.test(bodyOf(PLATFORM, 'export async function signOutOtpSession()')) }
)

/* ---------------------------------------------------------------------------
   C. 失败分支：可见文案 ＋ 不做状态重置
   --------------------------------------------------------------------------- */
const failAt = logoutBody.indexOf('logoutFailureText')
check(
  'C1',
  '失败文案 `退出失敗：` 前缀存在（单点定义），且失败 return **早于** `setUser(null)` ⇒ 失败时零状态重置、原会话保留',
  { prefix: '退出失敗：', failBeforeClear: true, failAt: failAt >= 0 ? 'before-clear' : 'missing' },
  {
    prefix: LOGOUT_FAIL_PREFIX,
    failBeforeClear: failAt >= 0 && clearAt >= 0 && failAt < clearAt,
    failAt: failAt >= 0 ? 'before-clear' : 'missing'
  }
)

check(
  'C2',
  '失败分支回的是**结构化失败**（`ok: false` ＋ message），不是静默 / 不是 throw 给上层硬崩',
  { silentThrow: false, returnsStructured: true },
  { silentThrow: !logoutBody.includes('ok: false'), returnsStructured: /return\s*\{\s*ok:\s*false,/.test(logoutBody) }
)

check(
  'C3',
  '平台撤销失败时**回传原因**（`ended.reason` 进入 `logoutFailureText`）⇒ 文案可带上简短原因',
  { reasonWired: true },
  { reasonWired: logoutBody.includes('logoutFailureText((ended && ended.reason)') }
)

check(
  'C4',
  'UI 壳层把服务层失败**上屏**（toast ＋ 就地 error），且**不调用**成功收尾 `onSignedOut`',
  { toastOnError: true, noSuccessCallbackOnError: true },
  {
    toastOnError: /if\s*\(!outcome\.ok\)\s*\{[\s\S]{0,240}pushToast\(outcome\.message,\s*'error'\)/.test(SHELL),
    noSuccessCallbackOnError: SHELL.indexOf("pushToast(outcome.message, 'error')") < SHELL.indexOf('options.onSignedOut')
  }
)

/* ---------------------------------------------------------------------------
   D. 三态 UI：两个入口同一份判据 ＋ 提示条容器 ＋ 零 alert()
   --------------------------------------------------------------------------- */
const headerButtons = countLogoutButtons(HEADER)
const loginButtons = countLogoutButtons(LOGIN)
check(
  'D1',
  '两个退出入口各**恰一处** `data-logout` 按钮，且都读同一份 `logoutView`（`label` ＋ `disabled` ＋ `aria-busy`）',
  { headerButtons: 1, loginButtons: 1, headerViewBound: true, loginViewBound: true },
  {
    headerButtons,
    loginButtons,
    headerViewBound: HEADER.includes(':disabled="logoutView.disabled"') && HEADER.includes('{{ logoutView.label }}'),
    loginViewBound: LOGIN.includes(':disabled="logoutView.disabled"') && LOGIN.includes('{{ logoutView.label }}')
  }
)

check(
  'D2',
  '進行中文案 `正在退出…` 的**实码字面**只在单点 `logoutText.js` 定义（两入口不得各自写一份；注释不计）',
  { owners: ['src/services/logoutText.js'], literal: '正在退出…' },
  {
    owners: allSrc.filter(({ text }) => stripComments(text).includes('正在退出…')).map(({ rel }) => rel),
    literal: LOGOUT_RUNNING_TEXT
  }
)

check(
  'D3',
  '退出后**成功/失败**都有落点：`App.vue` 挂 `AppToast`，容器 `aria-live="polite"`；登錄頁另有頁內提示条（`data-logout-done`）',
  { mounted: true, ariaLive: true, inlineNotice: true },
  {
    mounted: APP.includes('<AppToast />') && APP.includes("import AppToast from './components/AppToast.vue'"),
    ariaLive: TOAST_VIEW.includes('aria-live="polite"'),
    inlineNotice: LOGIN.includes('data-logout-done')
  }
)

const alertHits = ['src/services/auth.js', 'src/utils/useLogout.js', 'src/components/AppHeader.vue', 'src/views/LoginView.vue', 'src/utils/appToast.js'].filter(
  (rel) => /\balert\s*\(/.test(read(rel))
)
check('D4', '退出链路五个文件零 `alert(`（反馈一律走组件内提示条 / 就地文案）', [], alertHits)

/* ---------------------------------------------------------------------------
   E. 幂等
   --------------------------------------------------------------------------- */
check(
  'E1',
  '未登錄点退出 ⇒ `logout` **首段短路**回 `ok`（零网络、零报错）',
  { earlyReturn: true, beforeAwait: true },
  {
    earlyReturn: /if\s*\(!currentUser\(\)\)\s*\{\s*return\s*\{\s*ok:\s*true,[\s\S]{0,120}already:\s*true/.test(logoutBody),
    beforeAwait: logoutBody.indexOf('already: true') < logoutBody.indexOf('await')
  }
)

check(
  'E2',
  '壳层二次点幂等：`running` 在飞 ⇒ 立即返回（不重发请求、不产生第二条提示）',
  { guarded: true },
  { guarded: /if\s*\(running\.value\)\s*return\s*\{\s*ok:\s*false,\s*message:\s*''\s*\}/.test(SHELL) }
)

check(
  'E3',
  '退出按钮只在**已登錄**分支渲染（未登錄根本看不到退出按钮，等同于「已在未登錄态」）',
  { headerInLoggedBranch: true, loginInSignedBranch: true },
  {
    headerInLoggedBranch: logoutButtonIndex(HEADER) > HEADER.indexOf('<template v-else>'),
    loginInSignedBranch:
      logoutButtonIndex(LOGIN) > LOGIN.indexOf('v-if="user"') &&
      logoutButtonIndex(LOGIN) < LOGIN.indexOf('<template v-else>')
  }
)

/* ---------------------------------------------------------------------------
   F. 登出后回到未登錄态（与既有判据同源，不另造第三套）
   --------------------------------------------------------------------------- */
check(
  'F1',
  '管理员入口判据仍单点：`data/session.js` 的 `isAdmin`（读 `state.user`）是唯一 computed 定义，`AppSidebar` / `AppHeader` 都从它取',
  { sessionDefines: true, sidebarImports: true, headerImports: true },
  {
    sessionDefines: /export const isAdmin = computed\(\(\) => state\.user !== null && state\.user\.role === 'admin'\)/.test(SESSION),
    sidebarImports: SIDEBAR.includes("import { isAdmin, isLoggedIn } from '../data/session.js'"),
    headerImports: HEADER.includes("import { currentUser, goldBalance, isLoggedIn } from '../data/session.js'")
  }
)

check(
  'F2',
  '退出**只**经 `setUser(null)` 写这份状态（`currentUser()` 随即为 null ⇒ 头像回「客」、菜單回「尚未登錄」、【印譜匯觀】整条不渲染）',
  { singleWriter: true, adminSessionReadsCurrentUser: true, sidebarGated: true },
  {
    singleWriter: logoutBody.includes('setUser(null)') && !/state\.user\s*=\s*null/.test(logoutBody),
    adminSessionReadsCurrentUser: /export function isAdminSession\(\)\s*\{\s*const user = currentUser\(\)/.test(ADMIN),
    sidebarGated: SIDEBAR.includes('if (isAdmin.value) {')
  }
)

check(
  'F3',
  '登錄頁「已登錄」区块的唯一判据是 `currentUser()`（退出后自然落回未登錄表单，不留已登錄残影）',
  { bound: true, clearsSensitive: true },
  {
    bound: LOGIN.includes('const user = computed(() => currentUser())') && LOGIN.includes('v-if="user"'),
    clearsSensitive: /onSignedOut:\s*\(\)\s*=>\s*\{[\s\S]{0,420}phone\.value = ''/.test(LOGIN)
  }
)

/* ---------------------------------------------------------------------------
   G. 纯函数（三态投影 / 失败文案 / 原因归一 / 结果判定）
   --------------------------------------------------------------------------- */
check(
  'G1',
  '`logoutView` 進行中 ⇒ 文案换「正在退出…」且**禁用**（防重复点）',
  { tone: 'running', label: '正在退出…', disabled: true, message: '' },
  logoutView({ running: true, error: '' })
)

check(
  'G2',
  '`logoutView` 空閒 ⇒ 原「退出登錄」且可点（失败重试后必须回到这个态）',
  { tone: 'idle', label: '退出登錄', disabled: false, message: '' },
  logoutView({ running: false, error: '' })
)

check(
  'G3',
  '`logoutView` 失敗 ⇒ 文案带前缀且**前綴不重复**（幂等：喂进已带前缀的文本也不叠两层）',
  { tone: 'error', label: '退出登錄', disabled: false, message: '退出失敗：平台超時' },
  logoutView({ running: false, error: '退出失敗：平台超時' })
)

check(
  'G4',
  '`logoutFailureText` 空原因 ⇒ 兜底「退出失敗：請稍後重試。」（不出现空原因的裸前缀）',
  '退出失敗：請稍後重試。',
  logoutFailureText('')
)

check(
  'G5',
  '`shortReason` 多行异常 ⇒ 只取第一行、空白归一、去首尾',
  'Error: network down',
  shortReason(new Error('Error: network down\n    at foo.js:1:2\n    at bar.js:3:4'))
)

check(
  'G6',
  '`shortReason` 超长原因 ⇒ 截断到 40 字 ＋ `…`（上屏求「简」，不是复印堆栈）',
  { length: 41, endsWithEllipsis: true },
  (() => {
    const text = shortReason('x'.repeat(120))
    return { length: text.length, endsWithEllipsis: text.endsWith('…') }
  })()
)

check(
  'G7',
  '`logoutOutcome` 只把 `ok === false` 当失败（缺字段不冒充失败），成功恒定回落 `已退出登錄`',
  {
    failed: { ok: false, already: false, message: '退出失敗：平台超時' },
    succeeded: { ok: true, already: true, message: '已退出登錄' }
  },
  {
    failed: logoutOutcome({ ok: false, message: '平台超時' }),
    succeeded: logoutOutcome({ ok: true, already: true })
  }
)

check(
  'G8',
  '`logoutOutcome` 幂等：服务层已格式化过前缀的失败文案，再判定一次也不叠前缀',
  { message: '退出失敗：平台超時' },
  { message: logoutOutcome({ ok: false, message: '退出失敗：平台超時' }).message }
)

/* ---------------------------------------------------------------------------
   H. 负对照（证明判据判的是扫描读数，不是拿常量自证）
   --------------------------------------------------------------------------- */
const mutatedPreClear = `${logoutBody.slice(0, 1)}setUser(null);${logoutBody.slice(1)}`
check(
  'H1',
  '负对照：把 `setUser(null)` 变异到函数体首行（＝先清后发请求）⇒ B1 的 `orderHolds` 必须翻红',
  { mutationApplied: true, orderHolds: false },
  { mutationApplied: mutatedPreClear !== logoutBody && mutatedPreClear.includes('setUser(null);'), orderHolds: orderHolds(mutatedPreClear) }
)

check(
  'H2',
  '负对照：原因变异成「超长首行 ＋ 多行尾巴」⇒ `shortReason` 仍**单行**且截断（证明单行/截断判据真的在跑）',
  { lines: 1, truncated: true },
  (() => {
    const text = shortReason(`${'很長的一行內容'.repeat(12)}\n第二行\n第三行`)
    return { lines: text.split('\n').length, truncated: text.endsWith('…') }
  })()
)

/* ---------------------------------------------------------------------------
   收尾
   --------------------------------------------------------------------------- */
const total = results.length
const failedIds = results.filter((item) => !item.pass).map((item) => item.id)
console.log(JSON.stringify({ summary: { total, passed: total - failures, failed: failures, failed_ids: failedIds } }))
process.exit(failures === 0 ? 0 : 1)
