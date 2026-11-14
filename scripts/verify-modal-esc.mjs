/**
 * 玺爱 · **模态框 ESC ＝ 取消 ＋ 印人提案入口三处落点** 回归套件
 * ============================================================================
 * 覆盖：裁定件 `docs/proposal-entry-and-esc-ruling-2026-11-14.md`（`fbaee92`）
 *       ＋ 规范 v1.114 §3.91 / §10.98（`AC-763`〜`AC-771`）；实现入库 `01bbf38`。
 *
 * 判据清单（每条皆可判负；负对照见 F 段，尺子必须会响）：
 *   扫描口径：**SFC 分段去注释**（`<template>` 只剥 `<!-- -->`、`<script>` 剥块注释与行尾 `//`、
 *      `<style>` 剥块注释，被剥字符抹成空格以保行号）—— 注释里写的 `role="dialog"` / `收錄 0 位`
 *      不算实码，注释说「不得这样说」也不构成本套的违规。
 *   A  **单点**：去注释后 `event.key === 'Escape'` 全 `src/**` 只出现在
 *      `src/utils/useEscToClose.js`；`src/components/HeaderSearch.vue` 的那一处**单独登记为豁免**
 *      （非模态输入框「编码格退格复原」的既有行为，`fbaee92` 已存在，非本单引入），
 *      豁免必须同时满足：同文件零 `role="dialog"`、未接 `useEscToClose`、判据落在 `onCellKeydown` 内。
 *      另断：无障碍替代写法（`'Esc'` / `keyCode === 27` / 模板 `.esc` 修饰符）零混入。
 *   A4 **接入面**：接 `useEscToClose` 的文件 ≥ 11，且「去注释后含 `role="dialog"` 的文件」
 *      **全部**在接入名单里（静态比对）；逐文件「真实 dialog 数 = hook 调用数」（SealDetailView 5 层）。
 *   B  **最上层语义（执行型）**：把 `useEscToClose.js` **源码字面**拷进沙箱（只改 import 说明符），
 *      配假 `document` 与假 `vue`（`watch` / `onBeforeUnmount`）真实 import 后派发 ESC：
 *      三层注册 ⇒ 一次 ESC 只关最后注册的那层；栈空即摘监听；卸载中途出栈不误判；
 *      busy 顶层 ESC **零回调且不向下穿透**（但仍消费按键）。
 *   C  **入口三处**：`data-person-proposal-entry` 取值集**恰** {correction-dialog, upload-seal, persons-index}；
 *      详情页零 `proposalOpen` / 零 `data-person-proposal-form`；提案表单模板**恰一处**
 *      （`PersonProposalDialog.vue`）；提交调用点**恰一处**；A/B 两处受「作者检索无命中」闸约束；
 *      C 处与登录态解耦（无 `:disabled`、未登录走登录引导）；旧引导死路句 `src/` 零命中。
 *   D  **`/persons` 水合占位**：未落定不渲染「0 位」（占位「—」），落定后真实数，空库照实 0；
 *      占位判据从源码**字面抽出表达式**在沙箱求值（不是只看注释）。
 *   E  `[data-admin-action]` 仍**恰 12 值**（扫描口径照抄 `verify-endorsement` D1 段）。
 *   F  **负对照**：内存变异（ESC 全关 / 去 `isBusy` 短路 / 多一处入口 / 去占位三元）后，
 *      **目标判据**（B2 / B7 / C1 / D1）必须判红 —— 这些断言判的是「变异后该判据红」，
 *      所以 `pass:true` ＝ 尺子确实会响（写成「拿变异值比原始期望值」会恒红，语义是反的）。
 *
 * 纪律：**只读** `src/**`（沙箱一律落在 `mktemp` 临时目录，跑完即删，不写被测件）；
 *      离线（`XIAI_NO_REAL_CARD=1`，本套不触 CARD / 不联网）；不新增依赖；断言失败 ⇒ 退出码非 0。
 */
/* **测试环境保护哨兵（硬防线）**：本套只跑离线件，置哨兵以防将来误引入服务层读点。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
   0. 断言与读数（沿既有套件形态：check(id, desc, expected, actual) ＋ 末尾 JSON summary）
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
const sorted = (arr) => [...arr].slice().sort()

/* ---------------------------------------------------------------------------
   1. 文本解析件 —— **SFC 分段**去注释（旧版把整篇当 JS 剥行尾 `//` 与 C 风格块注释，
      于是 `<!-- role="dialog" -->` 与模板里的 URL `http://…` 都被算成「实码」⇒ A5/D4 误红）：
        · `<template>` 段：只剥 `<!-- … -->`（模板里没有 JS 注释，`//` 是 URL 的一部分，不得剥）
        · `<script>` 段：剥 C 风格块注释与行尾 `//`（引号内不视为注释起点）
        · `<style>` 段：剥 C 风格块注释
        · 顶层 / 块间区域：只剥 HTML 注释
      被剥字符一律换成**空格**、换行原样保留 ⇒ 行号与字符偏移零漂移（`indexOf` 近邻判据不受影响）。
   --------------------------------------------------------------------------- */
const BACKTICK = '\u0060'

/** 把 `[from, to)` 抹成空格（保留换行 ⇒ 行号不漂移）。 */
function blankChars(chars, from, to) {
  for (let k = Math.max(0, from); k < Math.min(to, chars.length); k += 1) {
    if (chars[k] !== '\n') chars[k] = ' '
  }
}

/** HTML 注释抹白（`<template>` 段 / 顶层块间区域用）。 */
function blankHtmlComments(chars, from, to) {
  let i = from
  while (i < to) {
    if (chars[i] === '<' && chars[i + 1] === '!' && chars[i + 2] === '-' && chars[i + 3] === '-') {
      let j = i + 4
      while (j < to && !(chars[j] === '-' && chars[j + 1] === '-' && chars[j + 2] === '>')) j += 1
      const end = Math.min(to, j + 3)
      blankChars(chars, i, end)
      i = end
      continue
    }
    i += 1
  }
}

/** JS 注释抹白（C 风格块注释 ＋ 行尾 `//`；引号内不算注释起点）。 */
function blankJsComments(chars, from, to) {
  let i = from
  while (i < to) {
    const ch = chars[i]
    if (ch === '"' || ch === "'" || ch === BACKTICK) {
      const quote = ch
      i += 1
      while (i < to) {
        const c = chars[i]
        if (c === '\\') {
          i += 2
          continue
        }
        i += 1
        if (c === quote) break
      }
      continue
    }
    if (ch === '/' && chars[i + 1] === '/') {
      let j = i
      while (j < to && chars[j] !== '\n') j += 1
      blankChars(chars, i, j)
      i = j
      continue
    }
    if (ch === '/' && chars[i + 1] === '*') {
      let j = i + 2
      while (j < to && !(chars[j] === '*' && chars[j + 1] === '/')) j += 1
      const end = Math.min(to, j + 2)
      blankChars(chars, i, end)
      i = end
      continue
    }
    i += 1
  }
}

/** CSS 注释抹白。 */
function blankCssComments(chars, from, to) {
  let i = from
  while (i < to) {
    if (chars[i] === '/' && chars[i + 1] === '*') {
      let j = i + 2
      while (j < to && !(chars[j] === '*' && chars[j + 1] === '/')) j += 1
      const end = Math.min(to, j + 2)
      blankChars(chars, i, end)
      i = end
      continue
    }
    i += 1
  }
}

/** 与根 `<template>` 配对的 `</template>` 下标（跳过 HTML 注释，按嵌套深度配对内联 `<template v-if>`）。 */
function findTemplateClose(src, bodyStart) {
  const n = src.length
  let depth = 1
  let i = bodyStart
  while (i < n) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith('</template', i) && /[\s>]/.test(src[i + 10] || '>')) {
      depth -= 1
      if (depth === 0) return i
      i += 10
      continue
    }
    if (src.startsWith('<template', i) && /[\s>/]/.test(src[i + 9] || '>')) {
      const gt = src.indexOf('>', i)
      if (gt < 0) return n
      if (src[gt - 1] === '/') {
        i = gt + 1
        continue
      }
      depth += 1
      i += 9
      continue
    }
    i += 1
  }
  return n
}

/** 按 SFC 分段去注释（纯 `.js` / `.mjs` ⇒ 整篇按 JS 口径）。 */
function stripComments(src) {
  const chars = src.split('')
  const n = src.length
  const openRe = /<(template|script|style)(?=[\s>/])/gi
  let i = 0
  let blocks = 0
  for (;;) {
    openRe.lastIndex = i
    const m = openRe.exec(src)
    if (!m) break
    const tag = m[1].toLowerCase()
    const tagStart = m.index
    /* 块间顶层区域：只剥 HTML 注释（避免注释里的假标签骗过段扫描）。 */
    blankHtmlComments(chars, i, tagStart)
    const gt = src.indexOf('>', tagStart)
    if (gt < 0) break
    const bodyStart = gt + 1
    let bodyEnd = i
    if (tag === 'template') {
      bodyEnd = src[gt - 1] === '/' ? bodyStart : findTemplateClose(src, bodyStart)
    } else {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'ig')
      closeRe.lastIndex = bodyStart
      const cm = closeRe.exec(src)
      bodyEnd = cm ? cm.index : n
    }
    if (tag === 'template') blankHtmlComments(chars, bodyStart, bodyEnd)
    else if (tag === 'script') blankJsComments(chars, bodyStart, bodyEnd)
    else blankCssComments(chars, bodyStart, bodyEnd)
    blocks += 1
    const closeGt = src.indexOf('>', bodyEnd)
    i = closeGt < 0 ? n : closeGt + 1
  }
  /* 无 SFC 块 ⇒ 纯脚本文件，整篇按 JS 口径。 */
  if (blocks === 0) blankJsComments(chars, 0, n)
  return chars.join('')
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(vue|js|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/')
const SRC_FILES = walkFiles(path.join(ROOT, 'src'))
const RAW = new Map(SRC_FILES.map((abs) => [rel(abs), readFileSync(abs, 'utf8')]))
const CODE = new Map(SRC_FILES.map((abs) => [rel(abs), stripComments(readFileSync(abs, 'utf8'))]))
const read = (relPath) => RAW.get(relPath)
const code = (relPath) => CODE.get(relPath)
const countMatches = (text, re) => (text.match(re) || []).length

/* 沙箱临时根（跑完删除；不写被测件）。 */
const SANDBOX_ROOT = mkdtempSync(path.join(tmpdir(), 'xiai-esc-suite-'))
const sandboxes = []
function cleanupSandboxes() {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  }
  try {
    rmSync(SANDBOX_ROOT, { recursive: true, force: true })
  } catch {
    /* 同上 */
  }
}

/* ===========================================================================
   A 段：ESC 单点 ＋ 豁免登记 ＋ 接入面
   =========================================================================== */
section('A', 'ESC 单点（全 src 唯一 Escape 判据）＋ 豁免登记 ＋ 接入面覆盖')

const ESC_RE = /event\.key\s*===\s*'Escape'/g
const escHits = SRC_FILES.map((abs) => ({ file: rel(abs), hits: countMatches(stripComments(readFileSync(abs, 'utf8')), ESC_RE) })).filter(
  (x) => x.hits > 0
)
const escByFile = new Map(escHits.map((x) => [x.file, x.hits]))
const expectedEscFiles = ['src/components/HeaderSearch.vue', 'src/utils/useEscToClose.js']

check(
  'A1',
  '去注释后 `event.key === \'Escape\'` 全 `src/**` 只落在两处：单点实现 `src/utils/useEscToClose.js`（实码 1 处）＋ 已登记豁免 `HeaderSearch.vue`（非模态输入框）；其余文件零命中',
  { files: expectedEscFiles, useEsc: 1, headerSearch: 1, others: 0 },
  {
    files: sorted(escByFile.keys()),
    useEsc: escByFile.get('src/utils/useEscToClose.js') || 0,
    headerSearch: escByFile.get('src/components/HeaderSearch.vue') || 0,
    others: sorted(escByFile.keys()).filter((f) => !expectedEscFiles.includes(f)).length
  }
)

/* A2：豁免必须「单独登记」且理由成立 —— 不是模态框、不接单点 hook、判据在编码格 keydown 内。 */
const headerRaw = read('src/components/HeaderSearch.vue')
const headerCode = code('src/components/HeaderSearch.vue')
const cellKeydownAt = headerCode.indexOf('function onCellKeydown(')
const escAtInHeader = headerCode.indexOf("event.key === 'Escape'")
check(
  'A2',
  '豁免登记（HeaderSearch.vue）：该 Escape 判据属**非模态**输入框行为 —— 同文件零 `role="dialog"`、未接 `useEscToClose`、判据落在 `onCellKeydown` 内且只做「复原普通搜索框」（`revertToPlain`，不关任何弹窗）',
  { dialog: 0, hook: 0, inCellKeydown: true, revertsPlain: true },
  {
    dialog: countMatches(headerCode, /role="dialog"/g),
    hook: countMatches(headerCode, /useEscToClose/g),
    inCellKeydown: cellKeydownAt >= 0 && escAtInHeader > cellKeydownAt,
    revertsPlain: headerRaw.includes('revertToPlain()')
  }
)

/* A2b：非本单引入（基线 `fbaee92` 已存在同一行）。仅在仓内可查 git 对象时判定，沙箱副本跳过。 */
let baselineHeader = null
try {
  baselineHeader = execFileSync('git', ['-C', ROOT, 'show', 'fbaee92:src/components/HeaderSearch.vue'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
} catch {
  baselineHeader = null
}
if (baselineHeader !== null) {
  check(
    'A2b',
    '豁免为**预存在**行为：`fbaee92:src/components/HeaderSearch.vue` 已有同一 `event.key === \'Escape\'` ＋ `revertToPlain()`（本单未新增第二套 ESC 判据在组件里）',
    { preExisting: 1, revert: true },
    { preExisting: countMatches(stripComments(baselineHeader), ESC_RE), revert: baselineHeader.includes('revertToPlain()') }
  )
}

/* A3：无替代写法混入（避免「换个 key 名又写一套」绕过单点）。 */
const altKeyNames = SRC_FILES.reduce((n, abs) => n + countMatches(stripComments(readFileSync(abs, 'utf8')), /event\.key\s*===\s*'Esc'/g), 0)
const keyCode27 = SRC_FILES.reduce((n, abs) => n + countMatches(stripComments(readFileSync(abs, 'utf8')), /keyCode\s*===\s*27/g), 0)
const escModifiers = SRC_FILES.reduce((n, abs) => n + countMatches(stripComments(readFileSync(abs, 'utf8')), /@key(?:down|up)\.esc/g), 0)
check(
  'A3',
  '无障碍替代写法零混入：`\'Esc\'` / `keyCode === 27` / 模板 `@keydown.esc`·`@keyup.esc` 全部 0（全 src 只有一处 ESC 判据这条口径不被绕过）',
  { escName: 0, keyCode27: 0, templateModifier: 0 },
  { escName: altKeyNames, keyCode27, templateModifier: escModifiers }
)

/* A4：接入面 —— 有 role="dialog" 的文件必须全在 hook 名单里，且 hook 文件数 ≥ 11。 */
const hookFiles = SRC_FILES.filter((abs) => /useEscToClose/.test(code(rel(abs))) && rel(abs) !== 'src/utils/useEscToClose.js').map(rel)
const dialogFiles = SRC_FILES.filter((abs) => /role="dialog"/.test(code(rel(abs)))).map(rel)
const dialogsWithoutHook = dialogFiles.filter((f) => !hookFiles.includes(f))
check(
  'A4',
  '接入面：`useEscToClose` 接入文件 ≥ 11；**每一个**含 `role="dialog"` 的组件文件都在接入名单里（静态比对，零漏网）',
  { hookFilesAtLeast: 11, dialogFiles: dialogFiles.length, missing: [] },
  { hookFilesAtLeast: hookFiles.length >= 11 ? 11 : hookFiles.length, dialogFiles: dialogFiles.length, missing: sorted(dialogsWithoutHook) }
)

/* A5：逐文件「真实 dialog 数 = hook 调用数」（去注释口径；本单 SealDetailView 为 5 层）。 */
const perFile = sorted(dialogFiles).map((f) => {
  const s = code(f)
  return { file: f, dialogs: countMatches(s, /role="dialog"/g), hooks: countMatches(s, /useEscToClose\s*\(/g) }
})
const mismatch = perFile.filter((x) => x.dialogs !== x.hooks).map((x) => `${x.file}:${x.dialogs}/${x.hooks}`)
const detail = perFile.find((x) => x.file === 'src/views/SealDetailView.vue') || { dialogs: -1, hooks: -1 }
check(
  'A5',
  '逐文件「去注释后 dialog 数 = hook 调用数」无不匹配（一层一注册）；详情页自建 5 扇弹窗 ⇒ 5 层（嵌套时按栈序）',
  { mismatch: [], detailPage: { dialogs: 5, hooks: 5 } },
  { mismatch, detailPage: { dialogs: detail.dialogs, hooks: detail.hooks } }
)

/* A6：全局单条监听 ＋ 捕获阶段（内层 `stopPropagation` 拦不住取消）。 */
const hookSrc = code('src/utils/useEscToClose.js')
const addCalls = countMatches(hookSrc, /document\.addEventListener\(\s*'keydown'\s*,\s*onKeydown\s*,\s*true\s*\)/g)
const removeCalls = countMatches(hookSrc, /document\.removeEventListener\(\s*'keydown'\s*,\s*onKeydown\s*,\s*true\s*\)/g)
check(
  'A6',
  '单点实现挂在 `document` **捕获阶段**且 add/remove 各恰一处（弹窗数量不改变监听数量；内层 `stopPropagation` 拦不住「取消」）',
  { add: 1, remove: 1, capture: true },
  { add: addCalls, remove: removeCalls, capture: addCalls === 1 }
)

/* ===========================================================================
   B 段：最上层语义（**执行型** —— 源码字面进沙箱，假 document 派发真 ESC）
   =========================================================================== */
section('B', '最上层 / busy 语义（执行型）：源码字面 + 假 document ＋ 假 vue')

const FAKE_VUE = `const watchers = []
const hooks = []
/* 套件侧读数用：确认「套件驱动的 watcher 表」就是 hook 用的那一张（同一模块实例）。 */
export const state = { watchers, hooks }
export function watch(getter, cb, opts) {
  const entry = { getter, cb, last: undefined, primed: false }
  watchers.push(entry)
  if (opts && opts.immediate) { entry.last = getter(); entry.primed = true; cb(entry.last) }
  return () => { const i = watchers.indexOf(entry); if (i >= 0) watchers.splice(i, 1) }
}
export function onBeforeUnmount(fn) { hooks.push(fn) }
export function flush() {
  for (const w of watchers.slice()) {
    const v = w.getter()
    if (!w.primed || v !== w.last) { w.last = v; w.primed = true; w.cb(v) }
  }
}
export function unmountAt(index) { const fn = hooks[index]; if (fn) fn() }
`

function makeFakeDocument() {
  const handlers = []
  return {
    addEventListener(type, fn) {
      handlers.push({ type, fn })
    },
    removeEventListener(type, fn) {
      const i = handlers.findIndex((h) => h.type === type && h.fn === fn)
      if (i >= 0) handlers.splice(i, 1)
    },
    listenerCount() {
      return handlers.length
    },
    dispatchKey(key) {
      const event = {
        key,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
        }
      }
      for (const h of handlers.slice()) h.fn(event)
      return event
    }
  }
}

let sandboxSeq = 0
async function loadHarness(sourceText) {
  sandboxSeq += 1
  const dir = mkdtempSync(path.join(SANDBOX_ROOT, `h${sandboxSeq}-`))
  sandboxes.push(dir)
  writeFileSync(path.join(dir, 'fake-vue.mjs'), FAKE_VUE)
  const rewritten = sourceText.replace(/from\s+'vue'/, "from './fake-vue.mjs'")
  if (rewritten === sourceText) throw new Error('沙箱改写失败：未找到 `from \'vue\'`')
  writeFileSync(path.join(dir, 'useEscToClose.mjs'), rewritten)
  const doc = makeFakeDocument()
  globalThis.document = doc
  /* 两侧都按**裸文件 URL** import（不加 `?v=`）：hook 里 `from './fake-vue.mjs'` 解析出的 URL
     必须与这里逐字相同，才会命中同一模块实例。每个沙箱是独立目录 ⇒ 天然互不串味。
     （上一轮真红就出在这里：套件侧带 `?v=N` ⇒ 两份 fake-vue ⇒ `flush()` / `unmountAt()`
      打在空表上，出栈永不发生，ESC 连关同一层。） */
  const mod = await import(pathToFileURL(path.join(dir, 'useEscToClose.mjs')).href)
  const vue = await import(pathToFileURL(path.join(dir, 'fake-vue.mjs')).href)
  return { dir, doc, mod, vue, rewritten, sourceText }
}

const HOOK_SOURCE = read('src/utils/useEscToClose.js')
const harness0 = await loadHarness(HOOK_SOURCE)
check(
  'B0',
  '沙箱件与产品件**同源**：只把 import 说明符 `\'vue\'` ⇒ `\'./fake-vue.mjs\'`，还原后与 `src/utils/useEscToClose.js` 逐字相等（没有另写一份替代实现）',
  { identicalAfterRestore: true, importRewrites: 1 },
  {
    identicalAfterRestore: harness0.rewritten.replace("from './fake-vue.mjs'", "from 'vue'") === HOOK_SOURCE,
    importRewrites: HOOK_SOURCE.split("from 'vue'").length - 1
  }
)

/* B0b：夹具**同源**哨兵 —— 套件侧 import 的假 `vue` 必须与 hook 里的 `'./fake-vue.mjs'`
   是同一模块实例。否则 `flush()` / `unmountAt()` 打在另一张 watcher 表上：取消后不出栈，
   ESC 会连关同一层（上一轮 B3〜B6/B9 就是这么假红的）。直接读套件侧 watcher 表计数。 */
async function scenarioSharedVue(sourceText) {
  const h = await loadHarness(sourceText)
  for (const name of ['L1', 'L2', 'L3']) {
    h.mod.useEscToClose({ isActive: () => true, onCancel: () => {} })
  }
  return { suiteSideWatchers: h.vue.state.watchers.length, suiteSideHooks: h.vue.state.hooks.length, listeners: h.doc.listenerCount() }
}
check(
  'B0b',
  '夹具同源：套件侧 import 的假 `vue` 与 hook 侧 `\'./fake-vue.mjs\'` 是**同一模块实例**（三层注册后套件侧 watcher 表恰 3 条）—— 若为两份实例，`flush()`/`unmountAt()` 全部空转，出栈不发生，B3〜B6/B9 假红',
  { suiteSideWatchers: 3, suiteSideHooks: 3, listeners: 1 },
  await scenarioSharedVue(HOOK_SOURCE)
)
async function scenarioLayers(sourceText) {
  const h = await loadHarness(sourceText)
  const cancelled = []
  const layers = [
    { name: 'L1', open: { v: true }, busy: { v: false } },
    { name: 'L2', open: { v: true }, busy: { v: false } },
    { name: 'L3', open: { v: true }, busy: { v: false } }
  ]
  for (const L of layers) {
    h.mod.useEscToClose({
      isActive: () => L.open.v,
      isBusy: () => L.busy.v,
      onCancel: () => {
        cancelled.push(L.name)
        L.open.v = false
        h.vue.flush()
      }
    })
  }
  const listenersWithThree = h.doc.listenerCount()
  const openCount = () => layers.filter((L) => L.open.v).length

  const e1 = h.doc.dispatchKey('Escape')
  const after1 = { cancelled: [...cancelled], remaining: openCount(), listeners: h.doc.listenerCount(), prevented: e1.defaultPrevented }
  const e2 = h.doc.dispatchKey('Escape')
  const after2 = { cancelled: [...cancelled], remaining: openCount() }
  h.doc.dispatchKey('Escape')
  const after3 = { cancelled: [...cancelled], remaining: openCount(), listeners: h.doc.listenerCount() }
  const e4 = h.doc.dispatchKey('Escape')
  const after4 = { cancelled: [...cancelled], prevented: e4.defaultPrevented }
  return { listenersWithThree, after1, after2, after3, after4 }
}

const layers = await scenarioLayers(HOOK_SOURCE)
check('B1', '三层弹窗注册后 `document` 上仍**只挂 1 条** keydown 监听（弹窗数量不影响监听数量）', 1, layers.listenersWithThree)
/* B2 判据式：主判据与 F1b 负对照共用同一把尺子（`b2Holds`）。 */
const B2_EXPECTED = { cancelled: ['L3'], remaining: 2, listeners: 1, prevented: true }
const b2Holds = (readout) => canon(readout) === canon(B2_EXPECTED)
check(
  'B2',
  '一次 ESC **只关最上层**（最后注册的 L3）：取消回调恰 1 次、L1/L2 仍在、监听仍 1 条',
  B2_EXPECTED,
  layers.after1
)
check('B3', '第二次 ESC 关 L2（按栈序逆序出栈）', { cancelled: ['L3', 'L2'], remaining: 1 }, layers.after2)
check('B4', '第三次 ESC 关 L1；栈空即摘监听（不留悬挂监听）', { cancelled: ['L3', 'L2', 'L1'], remaining: 0, listeners: 0 }, layers.after3)
check('B5', '栈空时 ESC 不回调、也不 `preventDefault`（不干扰页面级键盘行为）', { cancelled: ['L3', 'L2', 'L1'], prevented: false }, layers.after4)

/* B6：卸载中途出栈（顶层组件被父级销毁）⇒ 下层变最上层，不被误判。 */
async function scenarioUnmount(sourceText) {
  const h = await loadHarness(sourceText)
  const cancelled = []
  const L1 = { open: { v: true }, busy: { v: false } }
  const L2 = { open: { v: true }, busy: { v: false } }
  h.mod.useEscToClose({ isActive: () => L1.open.v, isBusy: () => L1.busy.v, onCancel: () => cancelled.push('L1') })
  h.mod.useEscToClose({ isActive: () => L2.open.v, isBusy: () => L2.busy.v, onCancel: () => cancelled.push('L2') })
  h.vue.unmountAt(1) /* 卸载 L2（顶层） */
  const e = h.doc.dispatchKey('Escape')
  return { cancelled: [...cancelled], prevented: e.defaultPrevented, listeners: h.doc.listenerCount() }
}
check(
  'B6',
  '顶层卸载后自动出栈：注册 L1/L2 后卸载 L2 ⇒ 一次 ESC 只关 L1（不把已卸载层当最上层、不双关），监听仍 1 条',
  { cancelled: ['L1'], prevented: true, listeners: 1 },
  await scenarioUnmount(HOOK_SOURCE)
)

/* B7/B8：busy 顶层 ⇒ 零回调且**不穿透**；解除后恢复。 */
async function scenarioBusy(sourceText) {
  const h = await loadHarness(sourceText)
  const cancelled = []
  const L1 = { open: { v: true }, busy: { v: false } }
  const L2 = { open: { v: true }, busy: { v: true } }
  h.mod.useEscToClose({
    isActive: () => L1.open.v,
    isBusy: () => L1.busy.v,
    onCancel: () => {
      cancelled.push('L1')
      L1.open.v = false
      h.vue.flush()
    }
  })
  h.mod.useEscToClose({
    isActive: () => L2.open.v,
    isBusy: () => L2.busy.v,
    onCancel: () => {
      cancelled.push('L2')
      L2.open.v = false
      h.vue.flush()
    }
  })
  const eBusy = h.doc.dispatchKey('Escape')
  const whileBusy = { cancelled: [...cancelled], prevented: eBusy.defaultPrevented, topStillOpen: L2.open.v, bottomStillOpen: L1.open.v }
  L2.busy.v = false
  h.doc.dispatchKey('Escape')
  const afterClear = { cancelled: [...cancelled] }
  h.doc.dispatchKey('Escape')
  const afterAll = { cancelled: [...cancelled] }
  return { whileBusy, afterClear, afterAll }
}

const busy = await scenarioBusy(HOOK_SOURCE)
/* B7 判据式：主判据与 F2b 负对照共用同一把尺子（`b7Holds`）。 */
const B7_EXPECTED = { cancelled: [], prevented: true, topStillOpen: true, bottomStillOpen: true }
const b7Holds = (readout) => canon(readout) === canon(B7_EXPECTED)
check(
  'B7',
  'busy 语义：最上层提交中（`isBusy` 真）按 ESC ⇒ **零回调**（不关自己）且**不向下一层穿透**（底层照旧打开）；按键仍被模态框消费（`preventDefault`）',
  B7_EXPECTED,
  busy.whileBusy
)
check('B8', 'busy 解除后 ESC 恢复生效：只关最上层 L2', { cancelled: ['L2'] }, busy.afterClear)
check('B9', '再按一次关 L1（栈空）—— busy 期的那次按键没有被「记账」迟发', { cancelled: ['L2', 'L1'] }, busy.afterAll)

/* B10：单点实现零写请求 / 零网络（「ESC ＝ 取消，不发任何写请求」的机械尺）。 */
const hookWrites = countMatches(
  hookSrc,
  /\bfetch\s*\(|services\/|\.submit|userWriteGate|api\.|axios|XMLHttpRequest|cloudbase/g
)
check(
  'B10',
  '单点实现本身零网络 / 零写：`useEscToClose.js` 去注释后 `fetch(` / `services/` / `userWriteGate` / `api.` / `axios` / `XMLHttpRequest` 零命中（ESC 只调各弹窗既有「关闭」函数，取消路径不发写请求）',
  0,
  hookWrites
)

/* ===========================================================================
   C 段：印人提案入口三处落点（详情页迁出）
   =========================================================================== */
section('C', '入口三处：取值集 / 详情页归零 / 表单与提交调用点各恰一处 / 无命中闸 / 登录态解耦')

const ENTRY_RE = /data-person-proposal-entry="([^"]+)"/g
const entryHits = []
for (const abs of SRC_FILES) {
  const s = read(rel(abs))
  let m
  ENTRY_RE.lastIndex = 0
  while ((m = ENTRY_RE.exec(s))) entryHits.push({ file: rel(abs), value: m[1] })
}
const entryValues = sorted(new Set(entryHits.map((h) => h.value)))

/* C1 判据式：主判据与 F3 负对照共用同一把尺子（`c1Holds`）。 */
const C1_EXPECTED = { values: ['correction-dialog', 'persons-index', 'upload-seal'], occurrences: 3 }
const c1Holds = (readout) => canon(readout) === canon(C1_EXPECTED)

check(
  'C1',
  '`data-person-proposal-entry` 取值集**恰** {correction-dialog, upload-seal, persons-index}（三处落点，不多不少），且总出现 3 次',
  C1_EXPECTED,
  { values: entryValues, occurrences: entryHits.length }
)

const mapping = Object.fromEntries(entryHits.map((h) => [h.value, h.file]))
check(
  'C2',
  '落点文件逐一对上：`correction-dialog` ⇒ 详情页勘误弹窗（SealDetailView）／`upload-seal` ⇒ 上传印章弹窗／`persons-index` ⇒ `/persons` 名录页',
  {
    'correction-dialog': 'src/views/SealDetailView.vue',
    'upload-seal': 'src/components/UploadSealDialog.vue',
    'persons-index': 'src/views/PersonIndexView.vue'
  },
  mapping
)

const detailCode = code('src/views/SealDetailView.vue')
check(
  'C3',
  '详情页**不再有**该入口与内联表单：`proposalOpen` 标识符零命中、`data-person-proposal-form` 全 src 零命中；详情页的 `data-person-proposal-entry` 仅 1 处（且属勘误弹窗内的无命中分支，见 C6）',
  { proposalOpen: 0, formHook: 0, entriesOnDetail: 1 },
  {
    proposalOpen: countMatches(detailCode, /\bproposalOpen\b/g),
    formHook: SRC_FILES.reduce((n, abs) => n + countMatches(read(rel(abs)), /data-person-proposal-form/g), 0),
    entriesOnDetail: entryHits.filter((h) => h.file === 'src/views/SealDetailView.vue').length
  }
)

const dialogOwners = SRC_FILES.filter((abs) => /data-person-proposal-dialog/.test(read(rel(abs)))).map(rel)
const fieldOwners = SRC_FILES.filter((abs) => /data-person-proposal-(family|given|courtesy|note)/.test(read(rel(abs)))).map(rel)
check(
  'C4',
  '提案表单模板**恰一处**：`data-person-proposal-dialog` 与表单字段钩子只出现在 `src/components/PersonProposalDialog.vue`（三处共用同一实现，未复制三份）',
  { dialogOwners: ['src/components/PersonProposalDialog.vue'], fieldOwners: ['src/components/PersonProposalDialog.vue'] },
  { dialogOwners: sorted(dialogOwners), fieldOwners: sorted(fieldOwners) }
)

const submitCallSites = []
for (const abs of SRC_FILES) {
  const s = read(rel(abs))
  const n = countMatches(s, /\.submitPersonProposal\s*\(/g)
  if (n) submitCallSites.push(`${rel(abs)}:${n}`)
}
check(
  'C5',
  '提交调用点**恰一处**：`persons.submitPersonProposal(` 只在 `src/components/PersonProposalDialog.vue`（且服务层写面门 `userWriteGate(\'submitPersonProposal\'` 仍在，未绕门）',
  { callSites: ['src/components/PersonProposalDialog.vue:1'], serviceGate: 1 },
  {
    callSites: sorted(submitCallSites),
    serviceGate: countMatches(code('src/services/persons.js'), /userWriteGate\(\s*'submitPersonProposal'/g)
  }
)

/* C6：A/B 两处入口受「作者检索无命中」闸约束（静态近邻：入口前 1500 字符内必须出现无命中判据）。 */
function gateBefore(relPath, entryValue, marker) {
  const s = read(relPath)
  const at = s.indexOf(`data-person-proposal-entry="${entryValue}"`)
  if (at < 0) return false
  const window = s.slice(Math.max(0, at - 1500), at)
  return window.includes(marker)
}
check(
  'C6',
  'A/B 两处入口受「作者检索无命中」闸约束（不是常驻可见）：`upload-seal` 在 `v-if="authorNoMatch"` 内；`correction-dialog` 在 `authorKeyword.trim() && !correctionAuthorOptions.length` 内',
  { uploadSeal: true, correctionDialog: true },
  {
    uploadSeal: gateBefore('src/components/UploadSealDialog.vue', 'upload-seal', 'v-if="authorNoMatch"'),
    correctionDialog: gateBefore('src/views/SealDetailView.vue', 'correction-dialog', '!correctionAuthorOptions.length')
  }
)

/* C7：C 处（/persons）与登录态解耦 —— 不用 CSS 隐藏 / disabled 冒充，未登录点击走登录引导。 */
const personsRaw = read('src/views/PersonIndexView.vue')
const personsCode = code('src/views/PersonIndexView.vue')
const entryAt = personsRaw.indexOf('data-person-proposal-entry="persons-index"')
const buttonStart = personsRaw.lastIndexOf('<button', entryAt)
const buttonEnd = personsRaw.indexOf('</button>', entryAt)
const buttonText = entryAt >= 0 ? personsRaw.slice(buttonStart, buttonEnd) : ''
const openFnAt = personsCode.indexOf('function openProposalEntry(')
const openFnBody = openFnAt >= 0 ? personsCode.slice(openFnAt, openFnAt + 900) : ''
check(
  'C7',
  '`/persons` 入口与登录态**解耦**：按钮无 `:disabled` / 无 `v-if`（不是隐藏或禁用冒充）；点击走 `openProposalEntry`，未登录时 `router.push({ name: \'login\', query: { redirect … } })`，已登录就地开同一提案框',
  { disabled: false, gatedByVIf: false, hasClick: true, loginRedirect: true, opensDialog: true },
  {
    disabled: /:disabled|disabled=/.test(buttonText),
    gatedByVIf: /\bv-if=/.test(buttonText),
    hasClick: /@click="openProposalEntry"/.test(buttonText),
    loginRedirect: /name:\s*'login'/.test(openFnBody) && /redirect/.test(openFnBody),
    opensDialog: /proposalOpen\.value\s*=\s*true/.test(openFnBody)
  }
)

/* C8：旧引导死路句已删（不再指向详情页），且旧 `collectGuide` 状态位不残留。 */
const deadGuideHits = SRC_FILES.reduce((n, abs) => n + countMatches(read(rel(abs)), /請進入任一印章詳情頁/g), 0)
check(
  'C8',
  '旧引导死路句 `請進入任一印章詳情頁…` 在 `src/**` 零命中；`collectGuide` 旧状态位不残留（入口挪走后不留指向详情页的文案）',
  { deadGuide: 0, collectGuide: 0 },
  { deadGuide: deadGuideHits, collectGuide: countMatches(personsCode, /\bcollectGuide\b/g) }
)

/* C9：既有闸未被本单破坏 —— `[data-collect-action]` 去注释后恰 1。 */
check(
  'C9',
  '既有闸未破：`PersonIndexView.vue` 的 `[data-collect-action]` 去注释后恰 1 处（本单加常驻入口未重复挂闸）',
  1,
  countMatches(personsCode, /data-collect-action/g)
)

/* C10：三处都 import 同一组件；详情页的弹窗状态改名后仍绑共用组件。 */
const importers = SRC_FILES.filter((abs) => /import\s+PersonProposalDialog\s+from/.test(code(rel(abs)))).map(rel)
check(
  'C10',
  '三处落点都 import 共用组件 `PersonProposalDialog`，且各自以 `v-if` 挂 `PersonProposalDialog`（详情页经 `proposalDialogOpen` 打开，位于勘误弹窗之上 ⇒ 嵌套 ESC 只关最上层）',
  {
    importers: ['src/components/UploadSealDialog.vue', 'src/views/PersonIndexView.vue', 'src/views/SealDetailView.vue'],
    mounts: 3,
    detailBinding: true
  },
  {
    importers: sorted(importers),
    mounts: SRC_FILES.reduce((n, abs) => n + countMatches(read(rel(abs)), /<PersonProposalDialog\b/g), 0),
    detailBinding: /<PersonProposalDialog\s+v-if="proposalDialogOpen"/.test(detailCode)
  }
)

/* ===========================================================================
   D 段：/persons 水合占位（不得把「还没读到」写成「0 位」）
   =========================================================================== */
section('D', '`/persons` 水合占位：未落定显示「—」，落定后真实数，空库照实 0')

function computedExpr(src, name) {
  const marker = `const ${name} = computed(() =>`
  const at = src.indexOf(marker)
  if (at < 0) return null
  let i = at + marker.length
  const start = i
  let depth = 0
  for (; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break
      depth -= 1
    }
  }
  return src.slice(start, i).trim()
}

const totalExpr = computedExpr(personsCode, 'totalLabel')
const visibleExpr = computedExpr(personsCode, 'visibleLabel')

/** 用**源码字面表达式**求值（把 `x.value` 交给假 ref 对象）。 */
function evalLabel(expr, loading, rows) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('loading', 'rosterRows', 'visibleRows', `return (${expr})`)
  return fn({ value: loading }, { value: rows }, { value: rows })
}

/** 水合期读数（源码字面表达式求值；抽不到表达式 ⇒ 记哨兵串）。 */
const d1HydratingOf = (expr) => (expr ? evalLabel(expr, true, []) : '__no_expr__')
/* D1 判据式：主判据与 F4 负对照共用同一把尺子（`d1Holds` = 水合期读数恰为「—」）。 */
const d1Holds = (expr) => d1HydratingOf(expr) === '—'

check(
  'D1',
  '占位逻辑从源码字面抽出并可执行：`loading` 真且零行 ⇒ `—`（**不是** `0`）；落定 570 行 ⇒ `570`；落定零行（真空库）⇒ `0`（照实）',
  { hydrating: '—', settled570: '570', settledEmpty: '0' },
  {
    hydrating: d1HydratingOf(totalExpr),
    settled570: totalExpr ? evalLabel(totalExpr, false, new Array(570).fill(1)) : '__no_expr__',
    settledEmpty: totalExpr ? evalLabel(totalExpr, false, []) : '__no_expr__'
  }
)
check(
  'D2',
  '结果计数同口径（`visibleLabel`）：水合期亦为 `—`，不把「还没筛」说成「0 位」',
  { hydrating: '—', settled: '3' },
  {
    hydrating: visibleExpr ? evalLabel(visibleExpr, true, []) : '__no_expr__',
    settled: visibleExpr ? evalLabel(visibleExpr, false, [1, 2, 3]) : '__no_expr__'
  }
)

const totalBind = /data-roster-total>\{\{\s*totalLabel\s*\}\}/.test(personsRaw)
const countBind = /data-roster-count><b>\{\{\s*visibleLabel\s*\}\}/.test(personsRaw)
check(
  'D3',
  '模板绑定到位：`[data-roster-total]` 绑 `totalLabel`、`[data-roster-count]` 绑 `visibleLabel`；两处都不再直绑 `rosterRows.length` / `visibleRows.length`',
  { totalBound: true, countBound: true, rawLengthInTotal: 0, rawLengthInCount: 0 },
  {
    totalBound: totalBind,
    countBound: countBind,
    rawLengthInTotal: countMatches(personsRaw, /data-roster-total>\{\{\s*rosterRows\.length\s*\}\}/g),
    rawLengthInCount: countMatches(personsRaw, /data-roster-count><b>\{\{\s*visibleRows\.length\s*\}\}/g)
  }
)
check(
  'D4',
  '水合判据本身是「零行 **且** 数据源仍 pending」（不是「零行即空库」）；且**去注释后**（HTML 注释 ＋ 脚本块注释都不算文案）模板与脚本串里零 `收錄 0 位` 硬编码 —— 注释里写「不得这样说」不算违规，上屏文案里写才算',
  { loadingJudgeHasPending: true, hardcodedZero: 0 },
  {
    loadingJudgeHasPending: /const loading = computed\([^\n]*source\.value\.pending/.test(personsCode),
    hardcodedZero: countMatches(personsCode, /收錄\s*(<b[^>]*>)?0\s*位/g)
  }
)

/* ===========================================================================
   E 段：`[data-admin-action]` 仍恰 12 值（扫描口径照抄 verify-endorsement D1 段）
   =========================================================================== */
section('E', '不可动项：`[data-admin-action]` 去重取值仍恰 12（本单零新增该族取值）')

const adminActions = new Set()
for (const abs of SRC_FILES) {
  const s = read(rel(abs))
  for (const m of s.match(/data-admin-action="([^"]+)"/g) || []) {
    adminActions.add(m.slice('data-admin-action="'.length, -1))
  }
}
check(
  'E1',
  '全 `src/**` 的 `[data-admin-action]` 去重取值集合恰 **12** 值（本单三处入口只用 `data-person-proposal-entry` / `data-action`，未撑破该族）',
  { values: 12 },
  { values: adminActions.size }
)

/* ===========================================================================
   F 段：负对照（内存变异 ⇒ 目标判据必须翻红）—— 语义：本段每条负对照断言的是
   「**变异后该判据判红**」，所以 `pass:true` ＝ 尺子会响 ＝ 期望状态。
   （上一轮的写法反了：拿变异后的读数去比「原实现的期望值」，于是恒红。）
   =========================================================================== */
section('F', '负对照：内存变异后目标判据必须判负（pass:true ＝ 尺子确实会响）')

/* F1：把「不区分层级」注入单点实现（ESC 关闭全部层）⇒ B2 判据（`b2Holds`）必须红。 */
const mutatedAllClose = HOOK_SOURCE.replace(
  'if (top.isBusy()) return\n  top.onCancel()',
  'if (top.isBusy()) return\n  for (const entry of [...openStack.values()]) entry.onCancel()'
)
check(
  'F1a',
  '负对照前提：变异文本**确实改到了**单点实现（「只关最上层」那行被替换成遍历全栈）',
  { mutated: true, differs: true },
  { mutated: mutatedAllClose !== HOOK_SOURCE, differs: mutatedAllClose.includes('for (const entry of [...openStack.values()])') }
)
const allCloseLayers = await scenarioLayers(mutatedAllClose)
check(
  'F1b',
  '负对照（**变异后 B2 判据红**）：ESC「不区分层级（全关）」⇒ 一次 ESC 取消回调 **3 次**（原实现 1 次）、栈一次清空 ⇒ `b2Holds` 由 true 翻 false',
  { b2Holds: false, cancelledCount: 3, listeners: 0 },
  { b2Holds: b2Holds(allCloseLayers.after1), cancelledCount: allCloseLayers.after1.cancelled.length, listeners: allCloseLayers.after1.listeners }
)

/* F2：取消 busy 判据 ⇒ B7 判据（`b7Holds`）必须红（busy 时仍关闭并穿透）。 */
const mutatedNoBusy = HOOK_SOURCE.replace('  if (top.isBusy()) return\n', '')
check('F2a', '负对照前提：变异文本确实删掉了 `isBusy` 短路（行数少 1）', { removed: 1 }, { removed: HOOK_SOURCE.split('\n').length - mutatedNoBusy.split('\n').length })
const noBusy = await scenarioBusy(mutatedNoBusy)
check(
  'F2b',
  '负对照（**变异后 B7 判据红**）：取消 busy 判据 ⇒ busy 期按 ESC 会关掉最上层（取消回调 1 次 ≠ 0、顶层已关）⇒ `b7Holds` 由 true 翻 false',
  { b7Holds: false, cancelled: ['L2'] },
  { b7Holds: b7Holds(noBusy.whileBusy), cancelled: noBusy.whileBusy.cancelled }
)

/* F3：入口取值集扫描器喂入第四处落点 ⇒ C1 判据（`c1Holds`）必须红（集合非恒等）。 */
const mutatedEntryScan = { values: sorted(new Set([...entryValues, 'detail-page'])), occurrences: entryHits.length + 1 }
check(
  'F3',
  '负对照（**变异后 C1 判据红**）：把提案入口再复制一份到详情页（取值 `detail-page`、总出现 4 次）⇒ `c1Holds` 由 true 翻 false（证明判据比的是扫描读数，不是拿常量自证）',
  { c1Holds: false, values: ['correction-dialog', 'detail-page', 'persons-index', 'upload-seal'], occurrences: 4 },
  { c1Holds: c1Holds(mutatedEntryScan), values: mutatedEntryScan.values, occurrences: mutatedEntryScan.occurrences }
)

/* F4：水合期直接 `String(length)` ⇒ D1 判据（`d1Holds`）必须红。 */
const mutatedExpr = totalExpr ? totalExpr.replace(/loading\.value\s*\?\s*'—'\s*:\s*/, '') : null
check(
  'F4',
  '负对照（**变异后 D1 判据红**）：把占位逻辑改成「水合期直接 `String(length)`」⇒ 未落定求值 `0`（≠ `—`）⇒ `d1Holds` 由 true 翻 false；同时断变异**确实生效**（替换后表达式变短且非空），不留「变异没打上却判绿」的空门',
  { mutationApplied: true, d1Holds: false, mutatedHydrating: '0' },
  {
    mutationApplied: Boolean(totalExpr) && Boolean(mutatedExpr) && mutatedExpr !== totalExpr,
    d1Holds: d1Holds(mutatedExpr),
    mutatedHydrating: d1HydratingOf(mutatedExpr)
  }
)

/* ---------------------------------------------------------------------------
   收尾
   --------------------------------------------------------------------------- */
cleanupSandboxes()
const total = results.length
console.log(JSON.stringify({ summary: { total, passed: total - failures, failed: failures } }))
process.exit(failures === 0 ? 0 : 1)
