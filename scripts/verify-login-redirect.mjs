/**
 * 玺爱 · **已登錄 ＋ 有 redirect ⇒ 自動前往簽發頁（白名單 ＋ 單次閘）** 自检套件
 * ============================================================================
 * 覆盖真机缺口（Kevin 截图确认）：斐萃桌面 App 点【重新授權】⇒ 弹登录窗落
 *   `/login?redirect=/connect`，但用户**已登录** ⇒ `LoginView` 停在「已登錄」分支
 *   （【登出此帳號】【返回璽印匯類】），**不会自动跳 `/connect`** ⇒ 签发流程走不下去。
 *
 * 判据（静态 ＋ 纯函数；每条皆可判负，末尾带变异负对照证明尺子会响）：
 *   A  **白名单单点**：`src/views/LoginView.vue` 里 `redirectTarget` 唯一定义
 *      （`type dev` / 空 ⇒ 拒；非 `/` 开头 ⇒ 拒；`//` 与 `/\` 协议相对 ⇒ 拒；
 *      控制符 ⇒ 拒；`/login` 及其 query / hash / 子路径 ⇒ 拒）。
 *   B  **单次闸**：`autoRedirectPlan(user, redirect, jumped)` —— 未登录**一律不跳**
 *      （走原登录流程）；`jumped === true` ⇒ 不再跳（同一渲染周期只一次）。
 *   C  **接线**：`watch(user, …, { immediate: true })` 里调 plan ⇒ `jump` 才
 *      `router.replace(plan.target)`；跳前先置 `autoJumped`；已在目标页 ⇒ 不重复导航。
 *   D  **原三条登录成功路径一字未改**：`route.query.redirect` 三处、
 *      `router.replace(redirect || { name: 'square' })` 三处逐字仍在；
 *      `router.replace` 全文件**恰 4 处**（3 原 ＋ 1 新）。
 *   E  **文案单点**：`正在前往簽發頁…`（繁體）去注释后全 `src/**` **恰一次**定义，
 *      模板只读 `{{ redirectNoticeText }}`；提示行只在「已登錄」分支内渲染。
 *   F  **负对照（变异体）**：去掉 `/login` 拒判 ⇒ B 段白名单判据必须翻身；
 *      去掉 `jumped` 闸 ⇒ 「不重复跳」判据必须翻身；去掉 `!user` 短路 ⇒
 *      未登录不跳判据必须翻身。（pass:true ＝ 尺子确实会响。）
 *
 * 纪律：只读 `src/**`；离线（`XIAI_NO_REAL_CARD=1`）；不新增依赖；断言失败 ⇒ 退出码非 0。
 */
process.env.XIAI_NO_REAL_CARD = '1'

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = path.join(ROOT, 'src')
const LOGIN = 'src/views/LoginView.vue'

/* ---------------------------------------------------------------------------
   0. 断言与读数（沿既有套件形态：check(id, desc, expected, actual) ＋ JSON summary）
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

const section = (id, title) => console.log(JSON.stringify({ section: id, title }))
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')
const count = (text, needle) => text.split(needle).length - 1

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/**
 * 去注释（SFC 分段口径的简化版）：`<!-- -->` / `/* *\/` / 整行 `//` 抹成空格、换行保留。
 * **注释里写的文案不算实现**（同族口径见 `verify-logout-feedback.mjs` / `verify-modal-esc.mjs`）。
 */
function stripComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
}

/** 从文件文本里按大括号配平抽出一个具名函数源码（纯静态，不求值）。 */
function extractFunctionSource(fileText, name) {
  const anchor = fileText.indexOf(`function ${name}(`)
  if (anchor < 0) return ''
  const brace = fileText.indexOf('{', anchor)
  if (brace < 0) return ''
  let depth = 0
  for (let i = brace; i < fileText.length; i += 1) {
    if (fileText[i] === '{') depth += 1
    else if (fileText[i] === '}') {
      depth -= 1
      if (depth === 0) return fileText.slice(anchor, i + 1)
    }
  }
  return ''
}

const RAW = read(LOGIN)
const CODE = stripComments(RAW)
const FN_WHITELIST = extractFunctionSource(CODE, 'redirectTarget')
const FN_PLAN = extractFunctionSource(CODE, 'autoRedirectPlan')

/** 把两段真源码装进沙箱：`redirectTarget` / `autoRedirectPlan` 均为纯函数（无 import）。 */
function buildRuntime(whitelistSrc = FN_WHITELIST, planSrc = FN_PLAN) {
  return new Function(`${whitelistSrc}\n${planSrc}\nreturn { redirectTarget, autoRedirectPlan }`)()
}

/* ---------------------------------------------------------------------------
   A. 白名单单点（静态：函数确实在 LoginView 里定义，且只有一处）
   --------------------------------------------------------------------------- */
section('A', '白名单单点（redirectTarget）')
check('A0', '`redirectTarget` / `autoRedirectPlan` 可从 LoginView.vue 抽出（非空）', true, FN_WHITELIST.length > 0 && FN_PLAN.length > 0)
check('A1', '`redirectTarget` 在 LoginView.vue 唯一一处定义', 1, count(CODE, 'function redirectTarget('))
check(
  'A2',
  '`redirectTarget` 在 src/** 唯一一处定义（无第二真源）',
  1,
  walk(SRC)
    .filter((f) => /\.(js|vue)$/.test(f))
    .reduce((n, f) => n + count(stripComments(readFileSync(f, 'utf8')), 'function redirectTarget('), 0)
)
check('A3', '`autoRedirectPlan` 在 LoginView.vue 唯一一处定义', 1, count(CODE, 'function autoRedirectPlan('))
check('A4', '白名单里 `/login` 自指拒判字面在（`=== \'/login\'` ＋ 三种前缀）', 4, (FN_WHITELIST.match(/\/login/g) || []).length)

/* ---------------------------------------------------------------------------
   B. 纯函数取值（白名单 ＋ 单次闸；沙箱跑真源码）
   --------------------------------------------------------------------------- */
section('B', '纯函数：白名单与单次闸')
const { redirectTarget, autoRedirectPlan } = buildRuntime()

check('B1', '`/connect`（本单真机目标）⇒ 接受原值', '/connect', redirectTarget('/connect'))
check('B2', '站内带参 / 带段路径 ⇒ 原样接受', '/seal/s-1?tab=face#top', redirectTarget('/seal/s-1?tab=face#top'))
check('B3', '`/login` 自指 ⇒ 拒（防自循环）', '', redirectTarget('/login'))
check('B4', '`/login?x=1` ⇒ 拒（防自循环）', '', redirectTarget('/login?x=1'))
check('B5', '`/login#a` 与 `/login/sub` ⇒ 拒', ['', ''], [redirectTarget('/login#a'), redirectTarget('/login/sub')])
check('B6', '外链 / 协议相对 ⇒ 拒', ['', '', '', ''], [
  redirectTarget('//evil.com'),
  redirectTarget('http://x'),
  redirectTarget('javascript:alert(1)'),
  redirectTarget('/\\evil.com')
])
check('B7', '空 / null / undefined / 非字符串 ⇒ 拒', ['', '', '', '', ''], [
  redirectTarget(''),
  redirectTarget('   '),
  redirectTarget(null),
  redirectTarget(undefined),
  redirectTarget(123)
])

const PLAN_OK = { jump: true, jumped: true, target: '/connect' }
check('B8', '已登录 ＋ 合法 redirect ⇒ 跳（target = /connect）', PLAN_OK, autoRedirectPlan({ id: 'u1' }, '/connect', false))
check('B9', '未登录 ＋ 合法 redirect ⇒ **不**跳（走原登录流程）', { jump: false, jumped: false, target: '' }, autoRedirectPlan(null, '/connect', false))
check('B10', '已登录 ＋ 非法 redirect（`/login?x=1`）⇒ 不跳', { jump: false, jumped: false, target: '' }, autoRedirectPlan({ id: 'u1' }, '/login?x=1', false))
check('B11', '已登录 ＋ 外链 redirect ⇒ 不跳', { jump: false, jumped: false, target: '' }, autoRedirectPlan({ id: 'u1' }, 'https://evil.com', false))
check(
  'B12',
  '无重复跳：同一渲染周期连调三次 ⇒ 只第一次 jump',
  [true, false, false],
  [
    autoRedirectPlan({ id: 'u1' }, '/connect', false).jump,
    autoRedirectPlan({ id: 'u1' }, '/connect', true).jump,
    autoRedirectPlan({ id: 'u1' }, '/connect', true).jump
  ]
)

/* ---------------------------------------------------------------------------
   C. 接线（静态：watch immediate ＋ 跳前置闸 ＋ 已在目标页不重复导航）
   --------------------------------------------------------------------------- */
section('C', '接线：watch(user, …, immediate) ⇒ plan.jump ⇒ router.replace')
const WATCH_BLOCK = (() => {
  const anchor = CODE.indexOf('watch(\n  user,')
  if (anchor < 0) return ''
  const end = CODE.indexOf('{ immediate: true }', anchor)
  return end < 0 ? '' : CODE.slice(anchor, end + '{ immediate: true }'.length)
})()

check('C1', '存在 `watch(user, …, { immediate: true })` 且块内调 `autoRedirectPlan`', true, WATCH_BLOCK.includes('autoRedirectPlan(') && WATCH_BLOCK.includes('immediate: true'))
check('C2', '块内以 `plan.jump` 为闸（不 jump 直接 return）', true, /if \(!plan\.jump\) return/.test(WATCH_BLOCK))
check('C3', '块内 `router.replace(plan.target)` 在（＝已登录有 redirect 会跳）', 1, count(WATCH_BLOCK, 'router.replace(plan.target)'))
const IDX_SET_FLAG = WATCH_BLOCK.indexOf('autoJumped.value = plan.jumped')
const IDX_REPLACE = WATCH_BLOCK.indexOf('router.replace(plan.target)')
check('C4', '跳之前先置 `autoJumped = plan.jumped`（顺序防重入）', true, IDX_SET_FLAG > 0 && IDX_SET_FLAG < IDX_REPLACE)
check('C5', '已在目标页 ⇒ 不重复导航（`route.fullPath === plan.target` 判据在）', true, WATCH_BLOCK.includes('route.fullPath === plan.target'))
check('C6', '`autoJumped` 是组件内状态（`ref(false)`），不是模块级可变全局', 1, count(CODE, 'const autoJumped = ref(false)'))
check('C7', '未用 `window.location` / `location.href` 硬跳（一律走 router）', 0, (CODE.match(/window\.location|location\.href/g) || []).length)

/* ---------------------------------------------------------------------------
   D. 原三条登录成功路径一字未改（静态门）
   --------------------------------------------------------------------------- */
section('D', '原三条登录成功路径未改（静态门）')
const REDIRECT_LINE = "const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : ''"
const REPLACE_LINE = 'router.replace(redirect || { name: \'square\' })'
check('D1', '`route.query.redirect` 消费行仍恰 3 处（三条成功路径）', 3, count(CODE, REDIRECT_LINE))
check('D2', '`router.replace(redirect || { name: \'square\' })` 仍恰 3 处', 3, count(CODE, REPLACE_LINE))
check('D3', '`router.replace` 全文件恰 4 处（3 原 ＋ 1 新）', 4, (CODE.match(/router\.replace\(/g) || []).length)
check(
  'D4',
  '三条路径的归属未变：submit / submitPassword / submitReset 各持一处',
  [1, 1, 1],
  ['async function submit()', 'async function submitPassword()', 'async function submitReset()'].map((anchor) => {
    const from = CODE.indexOf(anchor)
    const to = CODE.indexOf('async function', from + 1)
    return count(CODE.slice(from, to < 0 ? CODE.length : to), REDIRECT_LINE)
  })
)

/* ---------------------------------------------------------------------------
   E. 文案单点（繁体「正在前往簽發頁…」恰一次定义；提示行只在已登录分支）
   --------------------------------------------------------------------------- */
section('E', '文案单点与渲染位置')
const NOTICE_TEXT = '正在前往簽發頁…'
check('E1', '文案 `正在前往簽發頁…` 在 LoginView.vue 去注释后恰一处定义', 1, count(CODE, NOTICE_TEXT))
const ALL_SRC = walk(SRC)
  .filter((f) => /\.(js|vue)$/.test(f))
  .map((f) => stripComments(readFileSync(f, 'utf8')))
check('E2', '全 src/** 去注释后 `正在前往簽發頁…` 合计恰 1 次（无第二处字面）', 1, ALL_SRC.reduce((n, t) => n + count(t, NOTICE_TEXT), 0))
check('E3', '模板只读 `{{ redirectNoticeText }}`（不重写字面）', 1, count(CODE, '{{ redirectNoticeText }}'))
const IDX_SIGNED = CODE.indexOf('v-if="user" class="login__signed"')
const IDX_NOTICE = CODE.indexOf('data-login-redirect-pending')
const IDX_ELSE = CODE.indexOf('<template v-else>')
check('E4', '提示行落在「已登錄」分支内（signed < notice < v-else）', true, IDX_SIGNED > 0 && IDX_NOTICE > IDX_SIGNED && IDX_NOTICE < IDX_ELSE)
check('E5', '提示行由 `pendingRedirect` 控制（非法 redirect 不显示）', true, /v-if="pendingRedirect"/.test(CODE))
check('E6', '`pendingRedirect` 由同一 plan 判定（`autoRedirectPlan(user.value, …).jump`）', true, /pendingRedirect = computed\(\(\) => autoRedirectPlan\(user\.value/.test(CODE))

/* ---------------------------------------------------------------------------
   F. 负对照（变异体必须让目标判据翻身 ⇒ pass:true ＝ 尺子会响）
   --------------------------------------------------------------------------- */
section('F', '负对照（变异体）')
const MUTANT_NO_LOGIN_GUARD = FN_WHITELIST.replace(
  `if (
    value === '/login' ||
    value.startsWith('/login?') ||
    value.startsWith('/login#') ||
    value.startsWith('/login/')
  ) {
    return ''
  }`,
  ''
)
const mutantWhitelistApplied = MUTANT_NO_LOGIN_GUARD !== FN_WHITELIST
const mutantA = buildRuntime(MUTANT_NO_LOGIN_GUARD, FN_PLAN)
check(
  'F1',
  '变异①：去掉 `/login` 拒判 ⇒ 自循环判据必须翻身（`/login?x=1` 被接受）',
  true,
  mutantWhitelistApplied && mutantA.redirectTarget('/login?x=1') === '/login?x=1'
)

const MUTANT_NO_JUMP_GUARD = FN_PLAN.replace(
  "if (jumped === true) return { jump: false, jumped: true, target: '' }",
  ''
)
const mutantPlanApplied = MUTANT_NO_JUMP_GUARD !== FN_PLAN
const mutantB = buildRuntime(FN_WHITELIST, MUTANT_NO_JUMP_GUARD)
check(
  'F2',
  '变异②：去掉 `jumped` 闸 ⇒ 同一周期会连跳两次（判据翻身）',
  true,
  mutantPlanApplied && mutantB.autoRedirectPlan({ id: 'u1' }, '/connect', true).jump === true
)

const MUTANT_NO_USER_SHORT = FN_PLAN.replace(
  "if (!user) return { jump: false, jumped: false, target: '' }",
  ''
)
const mutantPlanApplied2 = MUTANT_NO_USER_SHORT !== FN_PLAN
const mutantC = buildRuntime(FN_WHITELIST, MUTANT_NO_USER_SHORT)
check(
  'F3',
  '变异③：去掉 `!user` 短路 ⇒ 未登录也会跳（判据翻身）',
  true,
  mutantPlanApplied2 && mutantC.autoRedirectPlan(null, '/connect', false).jump === true
)

/* ---------------------------------------------------------------------------
   Summary（与既有套件同形：末行 JSON，失败 ⇒ 退出码 1）
   --------------------------------------------------------------------------- */
const total = results.length
const passed = results.filter((r) => r.pass).length
console.log(
  JSON.stringify({
    suite: 'verify-login-redirect',
    total,
    passed,
    failed: total - passed,
    ok: failures === 0
  })
)
if (failures > 0) process.exit(1)
