#!/usr/bin/env node
/**
 * 玺爱 · **印章详情页属性区重构**（去重复表单 ＋ 悬停单条勘誤 ＋ 屬性詳情模态框）回归套件
 * ============================================================================
 * 覆盖：裁定件 `docs/attr-panel-restructure-ruling-2026-11-14.md`（`a3a9880`）
 *       ＋ 规范 §3.93 / §10.100（`AC-780`〜`AC-787`）；
 *       被测实现 `3d91833`（重构）＋ `165b8c0`（行尾【勘誤】可聚焦性）；HEAD 取跑套当时工作区。
 *
 * 判据清单（每条皆可判负；负对照见 I 段，尺子必须会响）：
 *   扫描口径：**SFC 分段去注释**（`<template>` 只剥 `<!-- -->`、`<script>` 剥块注释与行尾 `//`、
 *      `<style>` 剥块注释；被剥字符抹成空格、换行原样保留 ⇒ 行号与字符偏移零漂移）。
 *      **这是本仓踩过四次的误判坑 ①**：`SealDetailView.vue` 的注释里逐字写着
 *      `.face-entry` / `detail__table` / `visibility:hidden` / `display:none`（解释「不得这样做」），
 *      不先剥注释就会把说明文字当实码 ⇒ 全套误红。
 *   坑 ②（CSSOM 遍历跳过普通规则）在本套不成立：**本套不碰浏览器、不遍历 `CSSStyleRule.cssRules`**，
 *      CSS 判据一律对**样式源码文本**解析（`scanCss`：按 `{}` 深度切规则、`@media` 递归、
 *      其余 at-rule 只记录不递归）。
 *   坑 ③（后台节流 ⇒ transition 不推进、读 computed opacity 停在起始值）同样绕过：
 *      C 段**只断言 CSS 源码字面**（`opacity: 0` / `pointer-events: none` / 浮现选择器 / `@media` 恒显），
 *      **不读计算样式**、不依赖动画推进。
 *
 *   A  **三块归零（AC-780）**：`SealDetailView.vue` 去注释后 `face-entry` / `face-block__sub-head` /
 *      `detail__table` 在**模板段与样式段均 0 命中**；全 `src/**` 亦 0（无迁到别处的残件）；
 *      样式段按 CSS 规则核对（选择器里 0 命中，不是「文本里恰好没有」）。
 *   B  **行本体（AC-781）**：属性列表每行 ＝ `li.attr-row` 内**真 `button`**（`type="button"` ＋
 *      `data-action="attr-detail"` ＋ `@click="openAttrDetail(face, item)"`）；行内操作**不在**该
 *      `button` 内（不嵌套 ⇒ 无「点勘誤 顺带开详情」误触）；两枚行内按钮各带 `@click.stop`（恰 2 处）；
 *      行数 ＝ 服务层 `MARKABLE_FIELDS` 长度（现 7，与裁定「7 行」同口径）。
 *   C  **行尾【勘誤】可见性（AC-782 / 783，含 `165b8c0` 修）**：`.attr-row__fix` 默认
 *      `opacity: 0` ＋ `pointer-events: none`，**无** `visibility` / `display` 声明（那两种会让元素
 *      脱离无障碍树、不可聚焦）；浮现选择器**恰含** `.attr-row:hover .attr-row__fix`、
 *      `.attr-row:focus-within .attr-row__fix`、`.attr-row__fix:focus-visible` 三条且均置
 *      `opacity: 1` ＋ `pointer-events: auto`；`@media (hover: none)` 内 `.attr-row__fix` **恒显**。
 *      另断：`.attr-row__fix` 的**全部**规则（含 media 内）零 `visibility` / `display` 声明。
 *   D  **屬性詳情模态框（AC-784〜786）**：`AttrDetailDialog.vue` 三栏 `<dt>` 标签集合 **＝ 旧表格
 *      `<th>` 集合减「屬性」**（`當前展示值` / `來源` / `待審覈`；旧表头从基线 `a3a9880` 的
 *      `SealDetailView.vue` 用 `git show` **现取现比**，不手打文案 ⇒ 不在本套里复制一份「真相」）；
 *      三栏钩子 `data-attr-detail-value|source|pending` 齐备、`未著錄` 兜底与旧格一致；
 *      单条勘誤钩子 `data-action="attr-correction-detail"` 恰 1 处且 `emit('correction')`，
 *      详情页 `@correction="openAttrCorrectionFromDetail"`；接 `useEscToClose`（唯一 ESC 单点）。
 *   E  **单条锁定（AC-785）**：`correctionLockedField` 为 ref、`openCorrection(face, options)` 从
 *      `options.lockedField` 写入；`correctionFieldVisible` **锁定分支优先**（先判锁定、再判 EDGE 收窄）
 *      —— 并且把该函数**源码字面抽出来在沙箱执行**（不是只看文本）：锁定 `author` ⇒ 仅 `author` 可见、
 *      其余 6 条 false；未锁定 ⇒ 7 条按 EDGE 规则（边款闭【印面內容】/【印面風格】）。
 *      模板侧：字段 `v-if="correctionFieldVisible(item)"`、页签 `v-if="!correctionLockedField"`
 *      （锁定态不给改选入口）、`:data-correction-locked` 与 `data-correction-locked-hint` 在位。
 *   F  **标题排多条勘誤（AC-786）**：`data-action="face-correction-multi"` 的 `button`
 *      **无条件渲染**（自身无 `v-if` / `v-show` / `:disabled` / `disabled` / `hidden`）、落在
 *      `.face-block__admin-actions`（印面块标题旁那排）内、`@click="openCorrection(face)"`（多条、
 *      不带 `lockedField`）；未登录走既有登录引导（`openCorrection` 内 `!canSubmit ⇒ goLogin` 未改）。
 *   G  **计数面（AC-787）**：`[data-admin-action]` 去重取值仍**恰 12 值**（扫描口径照抄
 *      `verify-endorsement` D1 段），新钩子一律 `data-action`。
 *   H  **钩子改名**：`data-correction="correction-submit"` 存在（恰 1 处实码）；旧值
 *      `face-entry-submit` 在 `src/**` 与 `scripts/**`（除本套自身）**均 0 命中**。
 *      —— **防自命中**：判据用的字面由 `'face-entry' + '-submit'` 拼装；本套描述串里出现的整串
 *      由 `scripts/**.mjs` 扫描**显式排除自身**（不排就会扫到本文件的说明文字）。
 *   I  **变异负对照（≥ 3 点，沙箱拷产品副本）**：① `pointer-events: none` 改回 `visibility: hidden`
 *      ⇒ C 段必红；② 行尾按钮**移进**行本体 `button`（嵌套）⇒ B 段必红；③ `face-correction-multi`
 *      加管理员 `v-if` ⇒ F 段必红；④ 浮现选择器去掉 `:focus-within` ⇒ C 段必红。
 *      每点先断「变异确实打上了」（沙箱副本内容已变、且变异标记在位），再断「目标判据翻 false」
 *      —— 写成「拿变异值比原始期望」会恒红，语义是反的。
 *
 * 纪律：**只读** `src/**`（沙箱一律拷到 `mktemp` 临时目录，跑完即删；绝不写被测件）；
 *      离线（`XIAI_NO_REAL_CARD=1`，本套零网络、零浏览器、零生产读写）；不新增依赖；
 *      断言失败 ⇒ 退出码非 0（`failed_ids` 由 `run-verify-suite.sh` 收走）。
 */
/* **测试环境保护哨兵（硬防线）**：本套只做静态／源码级判定，置哨兵以防将来误引入服务层读点。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
/** 裁定件提交（旧表格 `detail__table` 仍在此提交的 `SealDetailView.vue` 里，现取现比）。 */
const BASELINE_COMMIT = 'a3a9880'
const VIEW_REL = 'src/views/SealDetailView.vue'
const DIALOG_REL = 'src/components/AttrDetailDialog.vue'
const CORRECTIONS_REL = 'src/services/corrections.js'

/* ---------------------------------------------------------------------------
   0. 断言与读数（沿既有套件形态：check(id, desc, expected, actual) ＋ 末尾 JSON summary）
   --------------------------------------------------------------------------- */
const results = []
let failures = 0
const sectionStats = {}

function canon(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`)
    .join(',')}}`
}

let currentSection = 'A'
function check(id, desc, expected, actual) {
  const pass = canon(expected) === canon(actual)
  if (!pass) failures += 1
  const stat = sectionStats[currentSection] || (sectionStats[currentSection] = { total: 0, failed: 0 })
  stat.total += 1
  if (!pass) stat.failed += 1
  results.push({ id, desc, pass, expected, actual })
  console.log(JSON.stringify({ id, case: desc, pass, expected, actual }))
}

const section = (id, title) => {
  currentSection = id
  console.log(JSON.stringify({ section: id, title }))
}
const sorted = (arr) => [...arr].slice().sort()
const countMatches = (text, re) => (text.match(re) || []).length
/** 出现次数（字面量，避免正则元字符）。 */
const countOf = (text, needle) => text.split(needle).length - 1

/* ---------------------------------------------------------------------------
   1. 文本解析件 —— **SFC 分段**去注释（保留字符偏移与行号；坑 ① 的解法）
   --------------------------------------------------------------------------- */
const BACKTICK = '\u0060'

function blankChars(chars, from, to) {
  for (let k = Math.max(0, from); k < Math.min(to, chars.length); k += 1) {
    if (chars[k] !== '\n') chars[k] = ' '
  }
}

/** HTML 注释抹白（`<template>` 段 / 顶层块间区域）。 */
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

/** 与根 `<template>` 配对的 `</template>` 下标（跳过 HTML 注释，按深度配对嵌套 `<template v-if>`）。 */
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

/**
 * 按 SFC 分段去注释，返回 `{ text, ranges }`：
 *   · `text` 与原文**等长**（被剥字符抹为空格、换行保留）；
 *   · `ranges` ＝ `{ template: [[from,to]], script: [...], style: [...] }`（区间基于同一偏移坐标）。
 */
function stripSfc(src) {
  const chars = src.split('')
  const n = src.length
  const openRe = /<(template|script|style)(?=[\s>/])/gi
  const ranges = { template: [], script: [], style: [] }
  let i = 0
  let blocks = 0
  for (;;) {
    openRe.lastIndex = i
    const m = openRe.exec(src)
    if (!m) break
    const tag = m[1].toLowerCase()
    const tagStart = m.index
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
    ranges[tag].push([bodyStart, bodyEnd])
    blocks += 1
    const closeGt = src.indexOf('>', bodyEnd)
    i = closeGt < 0 ? n : closeGt + 1
  }
  if (blocks === 0) blankJsComments(chars, 0, n)
  return { text: chars.join(''), ranges }
}

/** 取某段（可多段，如 `<style scoped>` 只有一段）的文本（已去注释）。 */
function segText(stripped, name) {
  return (stripped.ranges[name] || []).map(([from, to]) => stripped.text.slice(from, to)).join('\n')
}

/* ---- 元素抽取件（模板段用；标签按同名深度配对） ---------------------------- */

/** 从 `<tag …>` 起始配对同名闭合标签，返回 `{ start, innerStart, innerEnd, end }`。 */
function matchElement(text, startIdx, tag) {
  let depth = 0
  let i = startIdx
  while (i < text.length) {
    const nextOpen = text.indexOf(`<${tag}`, i)
    const nextClose = text.indexOf(`</${tag}`, i)
    if (nextClose < 0) return null
    if (nextOpen >= 0 && nextOpen < nextClose) {
      const after = text[nextOpen + tag.length + 1]
      if (!/[\s>/]/.test(after || '>')) {
        i = nextOpen + 1
        continue
      }
      const gt = text.indexOf('>', nextOpen)
      if (gt < 0) return null
      const selfClose = text[gt - 1] === '/'
      if (!selfClose) depth += 1
      i = gt + 1
      continue
    }
    const gt = text.indexOf('>', nextClose)
    if (gt < 0) return null
    depth -= 1
    const innerStart = text.indexOf('>', startIdx) + 1
    if (depth === 0) return { start: startIdx, innerStart, innerEnd: nextClose, end: gt + 1 }
    i = gt + 1
  }
  return null
}

/** 找首个含 `marker` 的元素，返回 `{ tag, attrs, inner, start, innerStart, innerEnd, end }`。 */
function elementAround(text, marker) {
  const at = text.indexOf(marker)
  if (at < 0) return null
  const lt = text.lastIndexOf('<', at)
  if (lt < 0) return null
  const m = /^<([a-zA-Z0-9-]+)/.exec(text.slice(lt))
  if (!m) return null
  const tag = m[1]
  const el = matchElement(text, lt, tag)
  if (!el) return null
  const attrs = text.slice(lt + tag.length + 1, el.innerStart - 1).trim()
  return { tag, attrs, inner: text.slice(el.innerStart, el.innerEnd), ...el }
}

/* ---- CSS 规则扫描件（对源码文本，坑 ② / ③ 的绕法） ------------------------ */

/** 按 `{}` 深度切规则；`@media` 递归（`media` 记外层条件），其余 at-rule 只记录不递归。 */
function scanCss(css, from, to, media, out) {
  let i = from
  while (i < to) {
    const open = css.indexOf('{', i)
    if (open < 0 || open >= to) break
    const selector = css.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < to && depth > 0) {
      if (css[j] === '{') depth += 1
      else if (css[j] === '}') depth -= 1
      j += 1
    }
    const bodyStart = open + 1
    const bodyEnd = j - 1
    const sel = selector.replace(/\s+/g, ' ').trim()
    /* 选择器原文区间（`[selectorStart, open)`）—— 变异负对照要按**偏移**改选择器，
       不能按归一化后的字符串回写（源码里换行分隔的选择器列表归一化后已不逐字存在）。 */
    let selectorStart = i
    while (selectorStart < open && /\s/.test(css[selectorStart])) selectorStart += 1
    if (sel.startsWith('@media')) {
      scanCss(css, bodyStart, bodyEnd, sel, out)
    } else if (sel.startsWith('@')) {
      out.push({ selector: sel, body: css.slice(bodyStart, bodyEnd), media, bodyStart, bodyEnd, selectorStart, selectorEnd: open, isAtRule: true })
    } else {
      out.push({ selector: sel, body: css.slice(bodyStart, bodyEnd), media, bodyStart, bodyEnd, selectorStart, selectorEnd: open, isAtRule: false })
    }
    i = j
  }
  return out
}

/** 规则的声明表（`prop → value`，值去空白、去 `!important`）。 */
function declsOf(body) {
  const out = {}
  body
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach((d) => {
      const at = d.indexOf(':')
      if (at < 0) return
      out[d.slice(0, at).trim().toLowerCase()] = d.slice(at + 1).replace(/!important/g, '').trim()
    })
  return out
}

const selectorsOf = (rule) => rule.selector.split(',').map((x) => x.replace(/\s+/g, ' ').trim())
const hasSelector = (rule, sel) => selectorsOf(rule).includes(sel)

/* ---------------------------------------------------------------------------
   2. 读数：产品件（只读）＋ 基线件（`git show`，仅用于「旧表头同口径」比对）
   --------------------------------------------------------------------------- */
const viewRaw = readFileSync(path.join(ROOT, VIEW_REL), 'utf8')
const view = stripSfc(viewRaw)
const viewTemplate = segText(view, 'template')
const viewStyle = segText(view, 'style')
const viewScript = segText(view, 'script')

const dialogRaw = readFileSync(path.join(ROOT, DIALOG_REL), 'utf8')
const dialog = stripSfc(dialogRaw)
const dialogTemplate = segText(dialog, 'template')
const dialogScript = segText(dialog, 'script')

const correctionsRaw = readFileSync(path.join(ROOT, CORRECTIONS_REL), 'utf8')

/** 服务层 `MARKABLE_FIELDS`（真源）—— 只读字面抽取 `{key,label}`。 */
function markableFields() {
  const code = stripSfc(correctionsRaw).text
  const at = code.indexOf('export const MARKABLE_FIELDS = [')
  if (at < 0) return []
  const open = code.indexOf('[', at)
  let depth = 1
  let j = open + 1
  while (j < code.length && depth > 0) {
    if (code[j] === '[') depth += 1
    else if (code[j] === ']') depth -= 1
    j += 1
  }
  const block = code.slice(open + 1, j - 1)
  const rows = []
  for (const m of block.matchAll(/\{\s*key:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*\}/g)) {
    rows.push({ key: m[1], label: m[2] })
  }
  return rows
}
const MARKABLE = markableFields()

/** 基线件的「旧表格表头」标签（`git show a3a9880:…`；取不到 ⇒ 空数组，由 D1 判红）。 */
function baselineTableHeaders() {
  try {
    const src = execFileSync('git', ['show', `${BASELINE_COMMIT}:${VIEW_REL}`], { cwd: ROOT, encoding: 'utf8' })
    const code = stripSfc(src).text
    const theadAt = code.indexOf('<thead>')
    if (theadAt < 0) return []
    const theadEnd = code.indexOf('</thead>', theadAt)
    const block = code.slice(theadAt, theadEnd)
    return [...block.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1].trim())
  } catch {
    return []
  }
}
const BASELINE_TH = baselineTableHeaders()

/* 沙箱（跑完删除；沙箱只放**拷贝**，不写被测件）。 */
const SANDBOX_ROOT = mkdtempSync(path.join(tmpdir(), 'xiai-attr-panel-suite-'))
const sandboxes = []
function newSandbox() {
  const dir = mkdtempSync(path.join(SANDBOX_ROOT, 'mut-'))
  sandboxes.push(dir)
  return dir
}
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
   判据件（纯函数，供主流程与 I 段变异共用 —— 变异必须能把这些尺子弄响）
   ---------------------------------------------------------------------------
   入参一律是「已去注释的分段文本」，故同一份判据对产品件与沙箱变异件**同口径**。
   =========================================================================== */

/** A：三块归零（模板段＋样式段＋全 src）。 */
function judgeZeroed(templateText, styleText) {
  const tokens = ['face-entry', 'face-block__sub-head', 'detail__table']
  const inTemplate = Object.fromEntries(tokens.map((t) => [t, countOf(templateText, t)]))
  const inStyle = Object.fromEntries(tokens.map((t) => [t, countOf(styleText, t)]))
  const ok = tokens.every((t) => inTemplate[t] === 0 && inStyle[t] === 0)
  return { ok, inTemplate, inStyle }
}

/** B：行本体结构（真 button ＋ 行内操作不嵌套 ＋ `@click.stop` 恰 2 处）。 */
function judgeRowStructure(templateText, markableCount) {
  const list = elementAround(templateText, 'class="attr-list"')
  const row = elementAround(templateText, 'class="attr-row"')
  const main = elementAround(templateText, 'class="attr-row__main"')
  const actions = elementAround(templateText, 'class="attr-row__actions"')
  const mainHasDetail = !!main && countOf(main.attrs, 'data-action="attr-detail"') === 1
  const mainIsButton = !!main && main.tag === 'button' && /\btype="button"/.test(main.attrs)
  const mainClick = !!main && /@click="openAttrDetail\(face, item\)"/.test(main.attrs)
  /* 不嵌套：行本体 button 体内**不得**出现任何 `<button`（含行尾勘誤 / 校驗作者）。 */
  const nestedButtonsInRow = !!main ? countMatches(main.inner, /<button[\s>]/g) : -1
  /* 行内两枚按钮都在 actions 容器内，且各带 `@click.stop`。 */
  const actionButtons = actions ? countMatches(actions.inner, /<button[\s>]/g) : -1
  const stopClicks = actions ? countMatches(actions.inner, /@click\.stop=/g) : -1
  const fixInActions = !!actions && countOf(actions.inner, 'data-action="attr-correction"') === 1
  const verifyInActions = !!actions && countOf(actions.inner, 'data-author-verify') === 1
  const rowCount = list ? countMatches(list.inner, /<li[\s>]/g) : -1 /* v-for ⇒ 1 个模板 li */
  const ok =
    !!list &&
    !!row &&
    row.tag === 'li' &&
    mainIsButton &&
    mainHasDetail &&
    mainClick &&
    nestedButtonsInRow === 0 &&
    actionButtons === 2 &&
    stopClicks === 2 &&
    fixInActions &&
    verifyInActions &&
    rowCount === 1 &&
    markableCount === 7
  return {
    ok,
    rowTag: row ? row.tag : null,
    mainTag: main ? main.tag : null,
    mainIsButton,
    mainHasDetail,
    mainClick,
    nestedButtonsInRow,
    actionButtons,
    stopClicks,
    fixInActions,
    verifyInActions,
    rowCount,
    markableCount
  }
}

/** C：行尾按钮样式（默认隐藏 ＋ 无 visibility/display ＋ 浮现三条件 ＋ 触摸恒显）。 */
function judgeFixStyles(styleText) {
  const rules = scanCss(styleText, 0, styleText.length, null, [])
  /* 规则的选择器列表里**任一**命中 `.attr-row__fix` 即算本按钮的规则（浮现规则是
     `.attr-row:hover .attr-row__fix` 这类组合选择器，不能用「整串全等」筛）。 */
  const fixRules = rules.filter((r) => !r.isAtRule && selectorsOf(r).some((s) => s.includes('.attr-row__fix')))
  const baseRule = fixRules.find((r) => r.media === null && selectorsOf(r).length === 1 && selectorsOf(r)[0] === '.attr-row__fix')
  const baseDecls = baseRule ? declsOf(baseRule.body) : {}
  const revealRules = fixRules.filter((r) => r.media === null && r !== baseRule)
  const revealSelectors = revealRules.flatMap(selectorsOf)
  const revealOk = revealRules.length > 0 && revealRules.every((r) => {
    const d = declsOf(r.body)
    return d.opacity === '1' && d['pointer-events'] === 'auto'
  })
  const touchRule = fixRules.find((r) => r.media !== null && /\(hover:\s*none\)/.test(r.media))
  const touchDecls = touchRule ? declsOf(touchRule.body) : {}
  /* 全部 `.attr-row__fix` 规则里零 `visibility` / `display` 声明（坑 ①：注释已剥，注释里写的
     `visibility:hidden` 不会误判）。 */
  const avoidsA11yEscape = fixRules.every((r) => {
    const d = declsOf(r.body)
    return d.visibility === undefined && d.display === undefined
  })
  const ok =
    !!baseRule &&
    baseDecls.opacity === '0' &&
    baseDecls['pointer-events'] === 'none' &&
    avoidsA11yEscape &&
    revealSelectors.includes('.attr-row:hover .attr-row__fix') &&
    revealSelectors.includes('.attr-row:focus-within .attr-row__fix') &&
    revealSelectors.includes('.attr-row__fix:focus-visible') &&
    revealOk &&
    !!touchRule &&
    touchDecls.opacity === '1' &&
    touchDecls['pointer-events'] === 'auto'
  return {
    ok,
    baseOpacity: baseDecls.opacity,
    basePointerEvents: baseDecls['pointer-events'],
    avoidsA11yEscape,
    revealSelectors: sorted(revealSelectors),
    revealValuesOk: revealOk,
    touchOpacity: touchDecls.opacity,
    touchPointerEvents: touchDecls['pointer-events']
  }
}

/** F：标题排「多条勘誤」入口无条件渲染 ＋ 落在 admin-actions 内 ＋ 点 openCorrection(face)。 */
function judgeMultiEntry(templateText) {
  const btn = elementAround(templateText, 'data-action="face-correction-multi"')
  const bar = elementAround(templateText, 'class="face-block__admin-actions"')
  const attrs = btn ? btn.attrs : ''
  const noGate = !!btn && !/\bv-if=|\bv-show=|\bv-else\b|\bdisabled\b|:disabled=|\bhidden\b/.test(attrs)
  const inBar = !!btn && !!bar && btn.start > bar.innerStart && btn.end < bar.innerEnd
  const click = !!btn && /@click="openCorrection\(face\)"/.test(attrs)
  const ok = !!btn && btn.tag === 'button' && noGate && inBar && click
  return { ok, tag: btn ? btn.tag : null, noGate, inBar, click, attrsSnippet: attrs.replace(/\s+/g, ' ').slice(0, 160) }
}

/* ===========================================================================
   A 段：三块归零（AC-780）
   =========================================================================== */
section('A', '三块归零：`face-entry` / `face-block__sub-head` / `detail__table`（模板＋样式，剥注释）')

const zero = judgeZeroed(viewTemplate, viewStyle)
check(
  'A1',
  '`SealDetailView.vue` 去注释后：`face-entry` / `face-block__sub-head` / `detail__table` 在**模板段与样式段均 0 命中**（裁定 §六①；注释里解释「不得这样做」的说明文字不算实码）',
  { template: { 'face-entry': 0, 'face-block__sub-head': 0, 'detail__table': 0 }, style: { 'face-entry': 0, 'face-block__sub-head': 0, 'detail__table': 0 } },
  { template: zero.inTemplate, style: zero.inStyle }
)

/* A2：全 `src/**` 亦 0（防残件迁到别处 / 组件化后忘记删）。 */
function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(vue|js|mjs|css)$/.test(entry.name)) out.push(full)
  }
  return out
}
const SRC_FILES = walkFiles(path.join(ROOT, 'src'))
const ZERO_TOKENS = ['face-entry', 'face-block__sub-head', 'detail__table']
const srcHits = Object.fromEntries(ZERO_TOKENS.map((t) => [t, []]))
for (const abs of SRC_FILES) {
  const body = stripSfc(readFileSync(abs, 'utf8')).text
  const rel = path.relative(ROOT, abs).split(path.sep).join('/')
  for (const t of ZERO_TOKENS) if (body.includes(t)) srcHits[t].push(rel)
}
check(
  'A2',
  '全 `src/**`（.vue/.js/.mjs/.css，去注释）三块标识**均 0 命中**（不留残件、不迁到别处）',
  { 'face-entry': [], 'face-block__sub-head': [], 'detail__table': [] },
  { 'face-entry': sorted(srcHits['face-entry']), 'face-block__sub-head': sorted(srcHits['face-block__sub-head']), 'detail__table': sorted(srcHits['detail__table']) }
)

/* A3：样式段按 CSS 规则核（不是「文本里恰好没有」：选择器集合里同样 0）。 */
const viewStyleRules = scanCss(viewStyle, 0, viewStyle.length, null, [])
const styleSelectorHits = viewStyleRules
  .flatMap(selectorsOf)
  .filter((sel) => ZERO_TOKENS.some((t) => sel.includes(`.${t}`)))
check(
  'A3',
  '样式段 CSS 选择器集合里 `.face-entry*` / `.face-block__sub-head` / `.detail__table*` **恰 0 条**（按规则核，非文本巧合）',
  [],
  sorted(styleSelectorHits)
)
check(
  'A4',
  '样式段仍保有新属性列表的选择器（`.attr-list` / `.attr-row` / `.attr-row__main` / `.attr-row__fix` 各 ≥ 1 条）—— 防「删表时顺手把新列表样式也删了」',
  { 'attr-list': true, 'attr-row': true, 'attr-row__main': true, 'attr-row__fix': true },
  {
    'attr-list': viewStyleRules.some((r) => hasSelector(r, '.attr-list')),
    'attr-row': viewStyleRules.some((r) => hasSelector(r, '.attr-row')),
    'attr-row__main': viewStyleRules.some((r) => hasSelector(r, '.attr-row__main')),
    'attr-row__fix': viewStyleRules.some((r) => hasSelector(r, '.attr-row__fix'))
  }
)

/* ===========================================================================
   B 段：行本体（真 button / 不嵌套 / `@click.stop`）
   =========================================================================== */
section('B', '属性行本体：真 `button` ＋ 行内操作不嵌套 ＋ `@click.stop`（防误触）')

check(
  'B0',
  '服务层真源 `MARKABLE_FIELDS` 恰 7 条（与裁定 §二「7 行 × 4 列」同口径；行数由 `v-for` 派生）',
  { count: 7, keys: ['seal_name', 'dynasty', 'seal_type', 'face_style', 'seal_class', 'author', 'transcription'] },
  { count: MARKABLE.length, keys: MARKABLE.map((r) => r.key) }
)

const rowJudge = judgeRowStructure(viewTemplate, MARKABLE.length)
check(
  'B1',
  '属性行本体是**真 `button`**（`type="button"` ＋ `data-action="attr-detail"` ＋ `@click="openAttrDetail(face, item)"`）；行容器是 `li.attr-row`；`v-for` 模板恰 1 个 `li`（逐字段渲染）',
  { rowTag: 'li', mainTag: 'button', mainIsButton: true, mainHasDetail: true, mainClick: true, rowCount: 1 },
  { rowTag: rowJudge.rowTag, mainTag: rowJudge.mainTag, mainIsButton: rowJudge.mainIsButton, mainHasDetail: rowJudge.mainHasDetail, mainClick: rowJudge.mainClick, rowCount: rowJudge.rowCount }
)
check(
  'B2',
  '行本体 `button` **体内零 `<button`**（行尾【勘誤】/【校驗作者】**不嵌套**在行本体里 ⇒ 点这两个钮不会顺带打开详情框）',
  0,
  rowJudge.nestedButtonsInRow
)
check(
  'B3',
  '行内操作容器 `.attr-row__actions` 内**恰 2 枚** `button`（校驗作者 ＋ 勘誤），且**各带 `@click.stop`**（恰 2 处）',
  { buttons: 2, stopClicks: 2, fixInActions: true, verifyInActions: true },
  { buttons: rowJudge.actionButtons, stopClicks: rowJudge.stopClicks, fixInActions: rowJudge.fixInActions, verifyInActions: rowJudge.verifyInActions }
)
check(
  'B4',
  'B 段总判（任一条不成立即红）：真 button ＋ 不嵌套 ＋ 双 `@click.stop` ＋ 行数 ＝ `MARKABLE_FIELDS` 7',
  true,
  rowJudge.ok
)

/* ===========================================================================
   C 段：行尾【勘誤】可见性（164b8c0 修后：opacity ＋ pointer-events，绝不 visibility/display）
   =========================================================================== */
section('C', '行尾【勘誤】可见性：默认 `opacity:0` ＋ `pointer-events:none`（无 `visibility`/`display`），悬停／聚焦浮现，触摸恒显')

const styleJudge = judgeFixStyles(viewStyle)
check(
  'C1',
  '`.attr-row__fix` 默认规则 ＝ `opacity: 0` ＋ `pointer-events: none`（`165b8c0` 的修法：只做视觉隐藏，元素仍在无障碍树、仍可 Tab 聚焦）',
  { opacity: '0', pointerEvents: 'none' },
  { opacity: styleJudge.baseOpacity, pointerEvents: styleJudge.basePointerEvents }
)
check(
  'C2',
  '`.attr-row__fix` 的**全部**规则（含 `@media` 内）零 `visibility` / `display` 声明（不得用这两种回避写法把元素移出无障碍树）',
  true,
  styleJudge.avoidsA11yEscape
)
check(
  'C3',
  '浮现选择器**恰含**三条：`.attr-row:hover .attr-row__fix`、`.attr-row:focus-within .attr-row__fix`（键盘可达）、`.attr-row__fix:focus-visible`，且每条均置 `opacity: 1` ＋ `pointer-events: auto`',
  {
    selectors: sorted(['.attr-row:hover .attr-row__fix', '.attr-row:focus-within .attr-row__fix', '.attr-row__fix:focus-visible']),
    valuesOk: true
  },
  { selectors: styleJudge.revealSelectors, valuesOk: styleJudge.revealValuesOk }
)
check(
  'C4',
  '`@media (hover: none)`（触摸设备无 hover）内 `.attr-row__fix` **恒显**（`opacity: 1` ＋ `pointer-events: auto`；裁定 §四「二选一」选了「恒显」）',
  { opacity: '1', pointerEvents: 'auto' },
  { opacity: styleJudge.touchOpacity, pointerEvents: styleJudge.touchPointerEvents }
)
check('C5', 'C 段总判（任一条不成立即红）', true, styleJudge.ok)

/* ===========================================================================
   D 段：屬性詳情模态框（三栏与旧表格同口径 ＋ 单条勘誤钩子 ＋ ESC 单点）
   =========================================================================== */
section('D', '屬性詳情模态框：三栏口径 ＝ 旧表格（`git show` 现取现比）＋ 单条勘誤钩子 ＋ `useEscToClose`')

const dialogDts = [...dialogTemplate.matchAll(/<dt>([^<]*)<\/dt>/g)].map((m) => m[1].trim())
const expectedCols = BASELINE_TH.filter((label) => label !== '屬性')
check(
  'D1',
  `详情框三栏 \`<dt>\` 集合 **＝ 基线 \`${BASELINE_COMMIT}\` 旧表格 \`<th>\` 集合减「屬性」**（` +
    '`當前展示值` / `來源` / `待審覈`，取值口径一字不改；基线现取现比，不在本套复制「真相」)',
  { cols: sorted(expectedCols), dt: sorted(expectedCols) },
  { cols: sorted(BASELINE_TH.filter((label) => label !== '屬性')), dt: sorted(dialogDts) }
)
check(
  'D2',
  '基线旧表格表头恰 4 列（`屬性` ＋ 三栏）⇒ 「三栏」不是凭空缩减的口径（防基线读取失败时两条都空集而假绿）',
  { header: ['屬性', ...expectedCols], count: 4 },
  { header: BASELINE_TH, count: BASELINE_TH.length }
)
check(
  'D3',
  '详情框三栏各有独立钩子：`data-attr-detail-value` / `data-attr-detail-source` / `data-attr-detail-pending`，另 `data-attr-detail-label`（属性名）与 `data-attr-detail-original`（「原始值：…」副行，仅採納勘誤时）',
  { value: 1, source: 1, pending: 1, label: 1, original: 1 },
  {
    value: countOf(dialogTemplate, 'data-attr-detail-value'),
    source: countOf(dialogTemplate, 'data-attr-detail-source'),
    pending: countOf(dialogTemplate, 'data-attr-detail-pending'),
    label: countOf(dialogTemplate, 'data-attr-detail-label'),
    original: countOf(dialogTemplate, 'data-attr-detail-original')
  }
)
check(
  'D4',
  '「當前展示值」空值兜底与旧格逐字一致（`未著錄`）＋ 三栏分别绑 `value` / `source` / `pending` props（本组件**只呈现、不派生**）',
  { fallback: '未著錄', binds: ['value', 'source', 'pending'] },
  {
    fallback: /value \|\| '未著錄'/.test(dialogTemplate) ? '未著錄' : null,
    binds: ['value', 'source', 'pending'].filter((p) => new RegExp(`\\{\\{\\s*${p}\\b`).test(dialogTemplate))
  }
)
check(
  'D5',
  '详情框底部单条勘誤钩子 `data-action="attr-correction-detail"` **恰 1 处**且 `emit(\'correction\')`；关闭钩子 `data-action="attr-detail-close"` 恰 1 处且 `emit(\'close\')`',
  { correction: 1, close: 1, emitsCorrection: 1, emitsClose: 1 },
  {
    correction: countOf(dialogTemplate, 'data-action="attr-correction-detail"'),
    close: countOf(dialogTemplate, 'data-action="attr-detail-close"'),
    emitsCorrection: countOf(dialogTemplate, "emit('correction')"),
    emitsClose: countOf(dialogTemplate, "emit('close')")
  }
)
check(
  'D6',
  '详情框接 `useEscToClose`（`../utils/useEscToClose.js` 导入 ＋ 以 `emit(\'close\')` 作 `onCancel`）—— ESC 走全仓唯一单点，不另写 `keydown`',
  { imported: 1, wired: 1, ownKeydown: 0 },
  {
    imported: countOf(dialogScript, "from '../utils/useEscToClose.js'"),
    wired: /useEscToClose\(\{\s*onCancel:\s*\(\)\s*=>\s*emit\('close'\)\s*\}\)/.test(dialogScript) ? 1 : 0,
    ownKeydown: countOf(dialogScript, 'addEventListener')
  }
)
check(
  'D7',
  '详情页把 `@correction` 接到 `openAttrCorrectionFromDetail`（详情框先关、再开字段已锁定的勘誤弹窗），`@close` 接 `closeAttrDetail`；`AttrDetailDialog` 以 `v-if="attrDetail"` 挂载（关即卸载）',
  { correction: 1, close: 1, mountGuard: 1 },
  {
    correction: countOf(viewTemplate, '@correction="openAttrCorrectionFromDetail"'),
    close: countOf(viewTemplate, '@close="closeAttrDetail"'),
    mountGuard: /<AttrDetailDialog\s+v-if="attrDetail"/.test(viewTemplate) ? 1 : 0
  }
)
check(
  'D8',
  '详情框无障碍面：`role="dialog"` ＋ `aria-modal="true"` ＋ `aria-label`，容器钩子 `data-attr-detail-dialog` 唯一',
  { roleDialog: 1, ariaModal: 1, container: 1 },
  {
    roleDialog: countOf(dialogTemplate, 'role="dialog"'),
    ariaModal: countOf(dialogTemplate, 'aria-modal="true"'),
    container: countOf(dialogTemplate, 'data-attr-detail-dialog')
  }
)

/* ===========================================================================
   E 段：单条锁定（correctionLockedField ＋ 可见性函数可执行）
   =========================================================================== */
section('E', '单条勘誤锁定：`correctionLockedField` 只渲染该字段（可见性函数**抽出来执行**）')

check(
  'E1',
  '`correctionLockedField` 为 `ref(\'\')`，`openCorrection(face, options = {})` 从 `options.lockedField` 写入（`|| \'\'` ⇒ 多条勘誤全开）',
  { state: 1, signature: 1, fromOptions: 1 },
  {
    state: /const correctionLockedField = ref\(''\)/.test(viewScript) ? 1 : 0,
    signature: /function openCorrection\(face, options = \{\}\)/.test(viewScript) ? 1 : 0,
    fromOptions: /correctionLockedField\.value = \(options && options\.lockedField\) \|\| ''/.test(viewScript) ? 1 : 0
  }
)
check(
  'E2',
  '单条入口 `openAttrCorrection(face, item)` 以 `openCorrection(face, { lockedField: item.key })` 打开（行尾与详情框**同一条**链路）',
  { openAttrCorrection: 1, passLocked: 1, fromDetail: 1 },
  {
    openAttrCorrection: /function openAttrCorrection\(face, item\)/.test(viewScript) ? 1 : 0,
    passLocked: /openCorrection\(face, \{ lockedField: item\.key \}\)/.test(viewScript) ? 1 : 0,
    fromDetail: /if \(item\) openAttrCorrection\(face, item\)/.test(viewScript) ? 1 : 0
  }
)

/** 把 `correctionFieldVisible` 的**源码字面**抽出来（剥注释后）在沙箱执行。 */
function extractFunctionBody(text, signature) {
  const at = text.indexOf(signature)
  if (at < 0) return null
  const open = text.indexOf('{', at)
  let depth = 1
  let j = open + 1
  while (j < text.length && depth > 0) {
    if (text[j] === '{') depth += 1
    else if (text[j] === '}') depth -= 1
    j += 1
  }
  return { body: text.slice(open + 1, j - 1), start: at, open, end: j }
}
const visibleFn = extractFunctionBody(viewScript, 'function correctionFieldVisible(item)')
const LOCKED_KEYS = MARKABLE.map((r) => r.key)
let visibleProbe = null
if (visibleFn) {
  const body = visibleFn.body.replace(/correctionLockedField\.value/g, 'locked').replace(/formFaceIsEdge\.value/g, 'formFaceIsEdge')
  const factory = new Function('FACE_CONTENT_KEY', 'FACE_STYLE_KEY', `return function (locked, item, formFaceIsEdge) {${body}}`)
  const fn = factory('seal_type', 'face_style')
  visibleProbe = {
    lockedAuthor: LOCKED_KEYS.map((k) => [k, fn('author', { key: k }, false)]),
    lockedSealName: LOCKED_KEYS.map((k) => [k, fn('seal_name', { key: k }, false)]),
    unlockedEdge: LOCKED_KEYS.map((k) => [k, fn('', { key: k }, true)]),
    unlockedFace: LOCKED_KEYS.map((k) => [k, fn('', { key: k }, false)])
  }
}
const visibleOf = (rows) => rows.filter(([, v]) => v).map(([k]) => k)
check(
  'E3',
  '「只渲染该字段」可执行判据（函数源码字面沙箱求值）：锁定 `author` ⇒ **仅** `author` 可见；锁定 `seal_name` ⇒ 仅 `seal_name`（换字段亦然 ⇒ 不是写死 author）',
  { author: ['author'], seal_name: ['seal_name'] },
  visibleProbe ? { author: visibleOf(visibleProbe.lockedAuthor), seal_name: visibleOf(visibleProbe.lockedSealName) } : null
)
check(
  'E4',
  '未锁定（多条勘誤）不回归：正/边款全 7 条可见；边款（EDGE）只收窄【印面內容】`seal_type` 与【印面風格】`face_style`（R-43 既有判据仍在）',
  { edge: LOCKED_KEYS.filter((k) => k !== 'seal_type' && k !== 'face_style'), face: LOCKED_KEYS },
  visibleProbe ? { edge: visibleOf(visibleProbe.unlockedEdge), face: visibleOf(visibleProbe.unlockedFace) } : null
)
check(
  'E5',
  '锁定分支**优先**于 EDGE 收窄（先 `if (correctionLockedField.value) return item.key === …`；否则锁定的【印面內容】在边款上会被 EDGE 规则吃掉 ⇒ 弹窗空白）',
  { lockedBranchPresent: true, lockedBranchBeforeEdge: true },
  {
    lockedBranchPresent: !!visibleFn && /if \(correctionLockedField\.value\) return item\.key === correctionLockedField\.value/.test(visibleFn.body),
    lockedBranchBeforeEdge:
      !!visibleFn &&
      visibleFn.body.indexOf('correctionLockedField.value') >= 0 &&
      visibleFn.body.indexOf('correctionLockedField.value') < visibleFn.body.indexOf('formFaceIsEdge.value')
  }
)
check(
  'E6',
  '模板侧收窄：字段渲染由 `v-if="correctionFieldVisible(item)"` 单闸控制；锁定态**不给改选入口**（页签排 `v-if="!correctionLockedField"`）；`:data-correction-locked="correctionLockedField"` 与 `data-correction-locked-hint` 在位',
  { fieldGate: 1, tabsGated: 1, lockedAttr: 1, lockedHint: 1 },
  {
    fieldGate: countOf(viewTemplate, 'v-if="correctionFieldVisible(item)"'),
    tabsGated: countOf(viewTemplate, 'v-if="!correctionLockedField"'),
    lockedAttr: countOf(viewTemplate, ':data-correction-locked="correctionLockedField"'),
    lockedHint: countOf(viewTemplate, 'data-correction-locked-hint')
  }
)
check(
  'E7',
  '单条／多条**同一条提交链**：字段容器仍 `data-correction-field` 单点渲染（1 处模板）、提交钮仍 `@click="submitCorrection"`（本单零新增写口、零改动载荷）',
  { fieldTemplate: 1, submitHook: 1, lockedClass: 1 },
  {
    fieldTemplate: countOf(viewTemplate, ':data-correction-field="item.key"'),
    submitHook: countOf(viewTemplate, '@click="submitCorrection"'),
    lockedClass: countOf(viewTemplate, "'field--locked': correctionLockedField === item.key")
  }
)

/* ===========================================================================
   F 段：印面块标题排「多条勘誤」入口
   =========================================================================== */
section('F', '印面块标题排【勘誤】（多条）：无条件渲染（无 admin 门）＋ 点它走 `openCorrection(face)`')

const multiJudge = judgeMultiEntry(viewTemplate)
check(
  'F1',
  '`data-action="face-correction-multi"` 的 `button` **自身无渲染门**（零 `v-if` / `v-show` / `v-else` / `disabled` / `:disabled` / `hidden`）⇒ 普通用户与游客都渲染（游客点它走登录引导，不是隐藏／置灰冒充）',
  { tag: 'button', noGate: true },
  { tag: multiJudge.tag, noGate: multiJudge.noGate }
)
check(
  'F2',
  '该按钮落在 `.face-block__admin-actions`（印面块标题旁那排：編輯固定屬性／重新上傳印面圖／人工智能修復／設為 base face 同排）内',
  true,
  multiJudge.inBar
)
check(
  'F3',
  '点击调 `openCorrection(face)`（**多条**一次性提交，**不带** `lockedField`）；登录门在 `openCorrection` 内（`!canSubmit ⇒ goLogin`）',
  { click: 1, loginGate: 1, noLockedArg: 1 },
  {
    click: multiJudge.click ? 1 : 0,
    loginGate: /function openCorrection\(face, options = \{\}\) \{\s*if \(!canSubmit\.value\) \{\s*goLogin\(\)/.test(viewScript) ? 1 : 0,
    noLockedArg: countOf(viewTemplate, 'openCorrection(face)') === 1 ? 1 : 0
  }
)
check('F4', 'F 段总判（任一条不成立即红）', true, multiJudge.ok)

/* ===========================================================================
   G 段：`[data-admin-action]` 仍恰 12 值
   =========================================================================== */
section('G', '不可动项：`[data-admin-action]` 去重取值仍恰 12 值（本单新钩子一律 `data-action`）')

const ADMIN_ACTION_EXPECTED = [
  'ai-enhance-face',
  'correction-accept',
  'correction-reject',
  'edit-ai-upstream',
  'edit-fixed-attributes',
  'edit-invite-reward',
  'edit-seal-attributes',
  'export-seal-data',
  'person-import-review',
  'person-proposal-review',
  'replace-face-image',
  'upload-seal'
]
const adminFound = new Set()
for (const abs of SRC_FILES) {
  const body = stripSfc(readFileSync(abs, 'utf8')).text
  for (const m of body.match(/data-admin-action="([^"]+)"/g) || []) {
    adminFound.add(m.slice('data-admin-action="'.length, -1))
  }
}
check('G1', '全 `src/**` 的 `[data-admin-action]` 去重取值集合逐字 ＝ 冻结表（**恰 12 值**）', sorted(ADMIN_ACTION_EXPECTED), sorted([...adminFound]))
const adminClasses = [...adminFound].map((v) => (v.startsWith('correction-') ? 'correction-accept|reject' : v))
check('G2', '归并后仍 11 类（`correction-accept|reject` 合一，其余各自成类）', 11, new Set(adminClasses).size)
check(
  'G3',
  '本单四个新钩子**均不进**该族（`attr-detail` / `attr-correction` / `attr-correction-detail` / `face-correction-multi` 在 `data-admin-action` 取值里零命中）',
  [],
  ['attr-detail', 'attr-correction', 'attr-correction-detail', 'face-correction-multi'].filter((v) => adminFound.has(v))
)

/* ===========================================================================
   H 段：钩子改名（`data-correction="correction-submit"` 在位；旧值 0）
   =========================================================================== */
section('H', '钩子改名：`data-correction="correction-submit"` 在位；旧值 `face-entry-submit` 在 src 与 scripts 均 0')

/* **自命中防护**：字面拼装（本套若把旧值写成一整串，scripts 扫描会扫到自己）。 */
const OLD_HOOK = `${'face-entry'}${'-submit'}`
check(
  'H1',
  '勘誤弹窗提交钮仍挂 `data-correction="correction-submit"`（**恰 1 处实码**；改名后不丢钩子）',
  1,
  countOf(viewTemplate, 'data-correction="correction-submit"')
)
const srcOldHook = SRC_FILES.filter((abs) => stripSfc(readFileSync(abs, 'utf8')).text.includes(OLD_HOOK)).map((abs) =>
  path.relative(ROOT, abs).split(path.sep).join('/')
)
check('H2', '旧值 `face-entry-submit` 在 `src/**`（去注释）**0 命中**', [], sorted(srcOldHook))

const SCRIPT_FILES = walkFiles(path.join(ROOT, 'scripts'), []).filter((abs) => /\.(mjs|js)$/.test(abs))
const SELF = path.join(ROOT, 'scripts/verify-attr-panel.mjs')
const scriptOldHook = SCRIPT_FILES.filter((abs) => abs !== SELF && readFileSync(abs, 'utf8').includes(OLD_HOOK)).map((abs) =>
  path.relative(ROOT, abs).split(path.sep).join('/')
)
check(
  'H3',
  '旧值 `face-entry-submit` 在 `scripts/**.mjs`（除本套自身）**0 命中**（无残留套件继续断言旧钩子）',
  [],
  sorted(scriptOldHook)
)

/* ===========================================================================
   I 段：变异负对照（≥ 3 点；沙箱拷产品副本，逐点断言对应用例必红）
   ---------------------------------------------------------------------------
   尺子会响的证明：把产品件拷进 `mktemp` 沙箱 → 打上变异 → 重新剥注释 → 用**同一份判据**判，
   目标判据必须 `ok === false`；同时断「变异确实打上了」（内容已变且变异标记在位），
   否则「判据红」可能只是拷贝失败 / 判据坏掉。
   =========================================================================== */
section('I', '变异负对照：① `pointer-events:none` → `visibility:hidden`；② 行尾钮嵌套进行本体；③ `face-correction-multi` 加 admin `v-if`；④ 浮现选择器去 `:focus-within`')

/** 在沙箱里改一份 `SealDetailView.vue` 副本，返回变异后的分段文本与中间读数。
    **按偏移改**（去注释文本与原文等长同偏移 ⇒ 同一个下标对两者都成立），
    不按「归一化后的选择器字符串」回写（源码里换行分隔的选择器列表归一化后已不逐字存在）。 */
function mutateView(mutate) {
  const dir = newSandbox()
  const target = path.join(dir, 'SealDetailView.vue')
  copyFileSync(path.join(ROOT, VIEW_REL), target)
  const original = readFileSync(target, 'utf8')
  const stripped = stripSfc(original)
  const full = stripped.text
  const [tplFrom, tplTo] = stripped.ranges.template[0]
  const [styFrom, styTo] = stripped.ranges.style[0]
  let raw = original
  const splice = (from, to, text) => {
    raw = raw.slice(0, from) + text + raw.slice(to)
  }
  mutate({ full, tplFrom, tplTo, styFrom, styTo, splice })
  writeFileSync(target, raw, 'utf8')
  const onDisk = readFileSync(target, 'utf8')
  const after = stripSfc(onDisk)
  return {
    changed: onDisk !== original,
    onDisk,
    template: segText(after, 'template'),
    style: segText(after, 'style'),
    script: segText(after, 'script')
  }
}

/* ---- ① 行尾隐藏写法：`pointer-events: none` 改回 `visibility: hidden` ---------- */
const mutStyle = mutateView(({ full, styFrom, styTo, splice }) => {
  const rules = scanCss(full, styFrom, styTo, null, [])
  const base = rules.find((r) => !r.isAtRule && r.media === null && r.selector === '.attr-row__fix')
  if (!base) return
  const at = full.indexOf('pointer-events: none', base.bodyStart)
  if (at < 0 || at >= base.bodyEnd) return
  splice(at, at + 'pointer-events: none'.length, 'visibility: hidden')
})
const mutStyleJudge = judgeFixStyles(mutStyle.style)
check(
  'I1',
  '负对照 ①：把 `.attr-row__fix` 的 `pointer-events: none` 改回 `visibility: hidden` ⇒ **C 段必红**（`visibility` 出现 ＋ `pointer-events` 消失）',
  { changed: true, markerOnDisk: 1, judgeOk: false, basePointerEvents: null, avoidsA11yEscape: false },
  {
    changed: mutStyle.changed,
    markerOnDisk: countOf(mutStyle.onDisk, 'visibility: hidden;'),
    judgeOk: mutStyleJudge.ok,
    basePointerEvents: mutStyleJudge.basePointerEvents === undefined ? null : mutStyleJudge.basePointerEvents,
    avoidsA11yEscape: mutStyleJudge.avoidsA11yEscape
  }
)

/* ---- ② 行尾按钮嵌套进行本体 button -------------------------------------------- */
const mutNest = mutateView(({ full, splice }) => {
  const main = elementAround(full, 'class="attr-row__main"')
  const actions = elementAround(full, 'class="attr-row__actions"')
  if (!main || !actions || main.innerEnd > actions.start) return
  const block = full.slice(actions.start, actions.end)
  splice(actions.start, actions.end, '')
  /* 先切走 actions 段（位于行本体关闭标签之后 ⇒ 行本体偏移不受影响），再插进行本体体内。 */
  splice(main.innerEnd, main.innerEnd, block)
})
const mutNestJudge = judgeRowStructure(mutNest.template, MARKABLE.length)
check(
  'I2',
  '负对照 ②：把行尾【勘誤】/【校驗作者】容器**移进**行本体 `button` 内（嵌套形态）⇒ **B 段必红**（行本体体内出现 `<button`）',
  { changed: true, nestedButtonsInRow: 2, judgeOk: false },
  {
    changed: mutNest.changed,
    nestedButtonsInRow: mutNestJudge.nestedButtonsInRow,
    judgeOk: mutNestJudge.ok
  }
)

/* ---- ③ `face-correction-multi` 加管理员 v-if -------------------------------- */
const mutGate = mutateView(({ full, splice }) => {
  const btn = elementAround(full, 'data-action="face-correction-multi"')
  if (!btn) return
  const at = btn.start + '<button'.length
  splice(at, at, ' v-if="canEditFixed"')
})
const mutGateJudge = judgeMultiEntry(mutGate.template)
check(
  'I3',
  '负对照 ③：给 `face-correction-multi` 加 `v-if="canEditFixed"`（管理员专属）⇒ **F 段必红**（自身渲染门出现 ⇒ 普通用户看不见 = 本单回归）',
  { changed: true, noGate: false, judgeOk: false },
  { changed: mutGate.changed, noGate: mutGateJudge.noGate, judgeOk: mutGateJudge.ok }
)

/* ---- ④ 浮现选择器去掉 `:focus-within` --------------------------------------- */
const mutFocus = mutateView(({ full, styFrom, styTo, splice }) => {
  const rules = scanCss(full, styFrom, styTo, null, [])
  const reveal = rules.find(
    (r) => !r.isAtRule && r.media === null && selectorsOf(r).includes('.attr-row:hover .attr-row__fix')
  )
  if (!reveal) return
  const kept = selectorsOf(reveal).filter((s) => !s.includes(':focus-within'))
  splice(reveal.selectorStart, reveal.selectorEnd, kept.join(',\n'))
})
const mutFocusJudge = judgeFixStyles(mutFocus.style)
check(
  'I4',
  '负对照 ④：浮现选择器去掉 `.attr-row:focus-within .attr-row__fix`（键盘聚焦不浮现）⇒ **C 段必红**（这正是 `165b8c0` 要守的可聚焦性）',
  { changed: true, hasFocusWithin: false, judgeOk: false },
  {
    changed: mutFocus.changed,
    hasFocusWithin: mutFocusJudge.revealSelectors.some((s) => s.includes(':focus-within')),
    judgeOk: mutFocusJudge.ok
  }
)

/* I5：正对照 —— 未经变异的**同一份判据**在产品件上为真（证明 I1〜I4 的红不是「判据恒红」）。 */
check(
  'I5',
  '正对照：同一份判据在产品件上三判据全真（`zero` / `row` / `style` / `multiEntry`）⇒ I1〜I4 的翻红不是「判据恒红」',
  { zero: true, row: true, style: true, multi: true },
  { zero: zero.ok, row: rowJudge.ok, style: styleJudge.ok, multi: multiJudge.ok }
)

/* I6：坑 ① 的负对照 —— **不去注释**直接判 ⇒ C 判据必红。
   产品件的样式段里，紧贴 `.attr-row__fix` 规则之前的注释逐字写着 `display:none` / `visibility:hidden`
   （解释「不得这样做」）；若不先剥注释，`scanCss` 会把注释块当成选择器文本 ⇒ 识别不到默认规则。 */
const rawStyleText = viewRaw.slice(view.ranges.style[0][0], view.ranges.style[0][1])
const rawStyleJudge = judgeFixStyles(rawStyleText)
check(
  'I6',
  '负对照 ⑤（扫描口径）：把**未剥注释**的样式原文直接喂 C 判据 ⇒ 必红（注释块被当选择器 ⇒ 规则识别失败）；剥注释后才为准 —— 钉住本仓踩过四次的坑 ①「静态扫描必须先剥注释」',
  { judgeOk: false, baseOpacity: null },
  { judgeOk: rawStyleJudge.ok, baseOpacity: rawStyleJudge.baseOpacity === undefined ? null : rawStyleJudge.baseOpacity }
)

/* --------------------------------------------------------------------------- 收尾 */
const total = results.length
const failedIds = results.filter((r) => !r.pass).map((r) => r.id)
console.log(
  JSON.stringify({
    summary: { total, passed: total - failedIds.length, failed: failedIds.length },
    sections: sectionStats,
    failed_ids: failedIds,
    note:
      '离线静态自检：只读 src/**（沙箱拷产品副本到 mktemp，跑完即删，不写被测件）；零网络、零浏览器、零生产读写；' +
      'CSS 判据一律读**样式源码文本**（不读 computed opacity —— 后台节流下 transition 不推进会误判），' +
      '静态扫描一律**先剥注释**（含 HTML 注释 —— 本页注释里逐字写着不得用的类名/写法）。'
  })
)

cleanupSandboxes()
process.exit(failedIds.length === 0 ? 0 : 1)
