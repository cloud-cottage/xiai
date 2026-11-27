#!/usr/bin/env node
/**
 * 玺爱 · **实物照片点击放大（lightbox）** 回归套件
 * ============================================================================
 * 覆盖：`/seal/*` 详情页「實物照片」区块的**全用户可点放大**（本单只做查看 ——
 *       隐藏 / 删除属下一单，**不在本套判据内**）。
 *
 * 判据清单（每条皆可判负；负对照见 F 段，尺子必须会响）：
 *   扫描口径：**SFC 分段去注释**（`<template>` 只剥 `<!-- -->`、`<script>` 剥块注释与
 *      行尾 `//`、`<style>` 剥块注释）—— 产品件注释里逐字写着 `role="button"` /
 *      `data-photo-open` 等解释性字样，不剥会把说明当实码。
 *   A  触发面：`data-photo-open` 与 `v-for="photo in gallery"` **同一个开标签**（同源
 *      ⇒ 运行时张数恒等 gallery 行数）；`role="button"` / `tabindex="0"` / `@click` /
 *      `@keydown.enter` / `@keydown.space` / `aria-label`（繁体「放大檢視第 N 張…」）齐备；
 *      触发块**零权限判定**（无 `v-if` 门、函数体零 admin 语义）。
 *   B  遮罩面：`role="dialog"` 恰 1、`aria-modal="true"` 恰 1、遮罩根 `data-photo-lightbox`
 *      恰 1、页面侧 `<PhotoLightbox` 恰 1 且带 `v-if` ⇒ **至多渲染一份**；ESC 走全仓单点
 *      `useEscToClose`（组件内零 `Escape` 字面）；三路关闭（X 钮 / 点遮罩 / ESC）；
 *      焦点进遮罩（`tabindex="-1"` ＋ `focus()`）、关窗回焦触发元素；遮罩期锁 `body` overflow
 *      且关窗原样还原。
 *   C  大图面：`<SliceImage` 恰 1 ＋ `cut-hint="photo"` ＋ `:src="srcs[current.id]"` ＋
 *      `:row="current"`（与缩略图同源同切分口径）；**零 `<img`**（不整图直出绕过切分）；
 *      容器 `min(92vw, 900px)`；头部「實拍圖 <id> · 尺寸 · 字节 · mime」＋「N / 总」；
 *      组件零 `services/` 引用（不新增网络请求 / 不改 photoService）。
 *   D  翻页面：边界一律经**纯函数** `neighborIndex(current, total, step)`（首尾不循环 ⇒
 *      返回 `-1`）；行为表 15 例逐条对拍；模板零边界算式（`:disabled="!canPrev"`）。
 *   E  零新色值：新增样式块的颜色字面零命中，且颜色类声明的值全部来自 `var(--…)`。
 *   F  负对照：内存变异（注入权限门 / 回卷边界 / 注入色值 / 去 aria-modal / 复制遮罩）
 *      ⇒ **目标判据必须判红**（`pass:true` ＝ 尺子确实会响）。
 *
 * 纪律：**只读** `src/**`；离线（零网络、零浏览器、零生产读写）；不新增依赖；
 *      断言失败 ⇒ 退出码非 0。
 */
process.env.XIAI_NO_REAL_CARD = '1'

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const VIEW_REL = 'src/views/SealDetailView.vue'
const BOX_REL = 'src/components/PhotoLightbox.vue'
const UTIL_REL = 'src/utils/photoLightbox.js'

/* --------------------------------------------------------------------------- */
/* 0. 断言骨架（沿既有套件形态：check(id, desc, expected, actual) ＋ 末尾 JSON 汇总） */
/* --------------------------------------------------------------------------- */
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
  results.push({ id, case: desc, pass, expected, actual })
  console.log(JSON.stringify({ id, case: desc, pass, expected, actual }))
}

const section = (id, title) => console.log(JSON.stringify({ section: id, title }))
const countOf = (text, re) => (text.match(re) || []).length

/* --------------------------------------------------------------------------- */
/* 1. 文本解析件 —— SFC 分段去注释（被剥字符抹成空格，行号零漂移）                */
/* --------------------------------------------------------------------------- */
function blank(chars, from, to) {
  for (let k = Math.max(0, from); k < Math.min(to, chars.length); k += 1) {
    if (chars[k] !== '\n') chars[k] = ' '
  }
}

/** HTML 注释抹白（`<!-- … -->`）。 */
function stripHtmlComments(text) {
  const chars = [...text]
  let i = 0
  while (i < chars.length) {
    if (chars[i] === '<' && chars[i + 1] === '!' && chars[i + 2] === '-' && chars[i + 3] === '-') {
      let j = i + 4
      while (j < chars.length && !(chars[j] === '-' && chars[j + 1] === '-' && chars[j + 2] === '>')) j += 1
      const end = Math.min(chars.length, j + 3)
      blank(chars, i, end)
      i = end
      continue
    }
    i += 1
  }
  return chars.join('')
}

/** JS 注释抹白（块注释 ＋ 行尾 `//`；引号 / 反引号内不视为注释起点）。 */
function stripJsComments(text) {
  const chars = [...text]
  const n = chars.length
  let i = 0
  while (i < n) {
    const ch = chars[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i += 1
      while (i < n) {
        if (chars[i] === '\\') {
          i += 2
          continue
        }
        if (chars[i] === quote) break
        i += 1
      }
      i += 1
      continue
    }
    if (ch === '/' && chars[i + 1] === '/') {
      let j = i
      while (j < n && chars[j] !== '\n') j += 1
      blank(chars, i, j)
      i = j
      continue
    }
    if (ch === '/' && chars[i + 1] === '*') {
      let j = i + 2
      while (j < n && !(chars[j] === '*' && chars[j + 1] === '/')) j += 1
      const end = Math.min(n, j + 2)
      blank(chars, i, end)
      i = end
      continue
    }
    i += 1
  }
  return chars.join('')
}

/** 取 `.vue` 的某一段（去标签后）并去注释；无该段 ⇒ 空串。 */
function sectionOf(raw, tag, stripper) {
  const open = raw.indexOf(`<${tag}`)
  if (open === -1) return ''
  const bodyStart = raw.indexOf('>', open)
  const close = raw.lastIndexOf(`</${tag}>`)
  if (bodyStart === -1 || close === -1 || close < bodyStart) return ''
  const body = raw.slice(bodyStart + 1, close)
  return stripper ? stripper(body) : body
}

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}

const viewRaw = read(VIEW_REL)
const boxRaw = read(BOX_REL)

const viewTemplate = stripHtmlComments(sectionOf(viewRaw, 'template'))
const viewScript = stripJsComments(sectionOf(viewRaw, 'script'))
const boxTemplate = stripHtmlComments(sectionOf(boxRaw, 'template'))
const boxScript = stripJsComments(sectionOf(boxRaw, 'script'))
const boxStyle = stripJsComments(sectionOf(boxRaw, 'style'))

/* =========================================================================== */
section('A', '触发面：每张照片可点 / 可键盘触发（全用户，零权限判定）')
/* =========================================================================== */

/** 引号感知地取 `<figure …>` 开标签（从 `start` 起到第一个不在引号内的 `>`）。 */
function openTagAt(text, start) {
  let i = start
  let quote = ''
  while (i < text.length) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
    } else if (ch === '>') {
      return text.slice(start, i + 1)
    }
    i += 1
  }
  return ''
}

const vforLiteral = 'v-for="photo in gallery"'
const vforCount = countOf(viewTemplate, new RegExp(vforLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))
const vforAt = viewTemplate.indexOf(vforLiteral)
const figureStart = vforAt === -1 ? -1 : viewTemplate.lastIndexOf('<figure', vforAt)
const figureTag = figureStart === -1 ? '' : openTagAt(viewTemplate, figureStart)

check(
  'A1',
  '触发面同源：唯一一处 `v-for="photo in gallery"` 就在 `<figure>` 开标签上，`data-photo-open` 绑在同一开标签 ⇒ 运行时钩子张数恒等 gallery 行数（无 slice / filter 截断）',
  {
    vforCount: 1,
    onFigure: true,
    hookOnSameTag: true,
    truncated: false
  },
  {
    vforCount,
    onFigure: figureTag.includes(vforLiteral),
    hookOnSameTag: figureTag.includes(':data-photo-open='),
    truncated: /v-for="[^"]*gallery\s*\.(?:slice|filter|slice\()/.test(viewTemplate)
  }
)

check(
  'A2',
  '每张可点 + 可键盘触发：`role="button"` / `tabindex="0"` / `@click` / `@keydown.enter` / `@keydown.space` / 繁体 `aria-label`（放大檢視第 N 張實物照片）齐备',
  {
    role: true,
    tabindex: true,
    click: true,
    enter: true,
    space: true,
    aria: true,
    ariaTraditional: true
  },
  {
    role: figureTag.includes('role="button"'),
    tabindex: figureTag.includes('tabindex="0"'),
    click: figureTag.includes('@click="openPhotoLightbox(photo, $event)"'),
    enter: figureTag.includes('@keydown.enter.prevent='),
    space: figureTag.includes('@keydown.space.prevent='),
    aria: figureTag.includes(':aria-label='),
    ariaTraditional: /放大檢視第 .* 張實物照片/.test(figureTag)
  }
)

check(
  'A3',
  '`data-photo-open` 全文恰 1 处（模板内；去注释后）—— 张数由 `v-for` 决定，不是逐张硬编码',
  { occurrences: 1 },
  { occurrences: countOf(viewTemplate, /data-photo-open(?![-\w])/g) }
)

/* 权限判定零落点：触发块无 `v-if` 门；开窗函数体零 admin 语义。 */
function fnBodyOf(script, name) {
  const at = script.indexOf(`function ${name}(`)
  if (at === -1) return null
  const open = script.indexOf('{', at)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1
    else if (script[i] === '}') {
      depth -= 1
      if (depth === 0) return script.slice(open + 1, i)
    }
  }
  return null
}

const openBody = fnBodyOf(viewScript, 'openPhotoLightbox')
const ADMINISH = /\bisAdmin\b|\bcanAdmin\b|\bcanEdit\w*\b|XIAI_ADMIN|ADMIN_LABEL|role\s*===\s*'|currentUser\s*\(/

check(
  'A4',
  '**全用户可用（零权限判定）**：触发块无 `v-if` / `v-show` 门，`openPhotoLightbox` 函数体零 admin 语义（普通用户与游客一律可点）',
  { triggerGate: 0, adminInBody: false, bodyFound: true },
  {
    triggerGate: countOf(figureTag, /v-(?:if|show|else)/g),
    adminInBody: ADMINISH.test(openBody || ''),
    bodyFound: openBody !== null
  }
)

/* =========================================================================== */
section('B', '遮罩面：只渲染一份 / dialog / aria-modal / ESC / 焦点 / 滚动锁')
/* =========================================================================== */

check(
  'B1',
  '遮罩语义：`role="dialog"` 恰 1 ＋ `aria-modal="true"` 恰 1 ＋ 遮罩根 `data-photo-lightbox` 恰 1（去注释后）',
  { dialog: 1, ariaModal: 1, maskRoot: 1 },
  {
    dialog: countOf(boxTemplate, /role="dialog"/g),
    ariaModal: countOf(boxTemplate, /aria-modal="true"/g),
    maskRoot: countOf(boxTemplate, /data-photo-lightbox(?![-\w])/g)
  }
)

check(
  'B2',
  '只渲染一份：页面侧 `<PhotoLightbox` 恰 1 处且由 `v-if="photoLightboxOpen"` 守卫（`v-if` ⇒ 至多一份）',
  { usage: 1, guarded: true },
  {
    usage: countOf(viewTemplate, /<PhotoLightbox[\s>]/g),
    guarded: /<PhotoLightbox[^>]*v-if="photoLightboxOpen"/s.test(viewTemplate)
  }
)

check(
  'B3',
  'ESC 已接线：组件内 `useEscToClose(` 恰 1 处且为 `onCancel: close`；组件内零 `Escape` 字面（关闭不走自监听）',
  { hookCalls: 1, onCancelClose: true, escapeLiterals: 0 },
  {
    hookCalls: countOf(boxScript, /useEscToClose\s*\(/g),
    onCancelClose: /useEscToClose\(\s*\{\s*onCancel:\s*close\s*\}/.test(boxScript),
    escapeLiterals: countOf(boxScript, /Escape|keyCode\s*===\s*27|\.esc\b/g)
  }
)

check(
  'B4',
  '三路关闭：X 钮（`data-photo-lightbox-close` ＋ `@click="close"`）／点遮罩（根 `@click="onRootClick"` → `close()`）／ESC',
  { closeButton: true, maskClick: true, esc: true },
  {
    closeButton: /data-photo-lightbox-close[\s\S]{0,200}@click="close"/.test(boxTemplate),
    maskClick: /@click="onRootClick"/.test(boxTemplate) && /function onRootClick\(/.test(boxScript) && /\bclose\(\)/.test(fnBodyOf(boxScript, 'onRootClick') || ''),
    esc: countOf(boxScript, /useEscToClose\s*\(/g) === 1
  }
)

check(
  'B5',
  '焦点管理：打开进遮罩（`tabindex="-1"` ＋ 挂载后 `focus()`），关闭回焦触发元素（记忆 `restoreTarget` ＋ `document.contains` 守卫）',
  { tabIndexMinus1: true, focusOnMount: true, restoreOnUnmount: true, restoreGuard: true },
  {
    tabIndexMinus1: /tabindex="-1"/.test(boxTemplate),
    focusOnMount: /rootRef\.value\.focus\(\)/.test(boxScript),
    restoreOnUnmount: /restoreTarget\.focus\(\)/.test(boxScript),
    restoreGuard: /document\.contains\(restoreTarget\)/.test(boxScript)
  }
)

check(
  'B6',
  '遮罩期锁背景滚动且**关窗原样还原**（存 `previousBodyOverflow` ⇒ 不丢当前滚动位置、不覆盖别的弹窗留下的锁）',
  { lock: true, restore: true, saved: true },
  {
    lock: /document\.body\.style\.overflow\s*=\s*'hidden'/.test(boxScript),
    restore: /document\.body\.style\.overflow\s*=\s*previousBodyOverflow/.test(boxScript),
    saved: /previousBodyOverflow\s*=\s*document\.body\.style\.overflow/.test(boxScript)
  }
)

check(
  'B7',
  '无障碍名：遮罩根带 `:aria-label`（由当前照片派生）',
  { ariaLabelBinding: true },
  { ariaLabelBinding: /:aria-label="ariaLabel"/.test(boxTemplate) && /const ariaLabel = computed/.test(boxScript) }
)

/* =========================================================================== */
section('C', '大图面：SliceImage 大尺寸重渲染同一张（不整图直出、零新增取数）')
/* =========================================================================== */

check(
  'C1',
  '大图仍走 `SliceImage`：组件内恰 1 处，`cut-hint="photo"` ＋ `:row="current"` ＋ `:src="srcs[current.id]"`（与缩略图同一 `photoUrls[id]` 源、同一套切分口径）',
  { sliceImage: 1, cutHint: true, sameSource: true, row: true },
  {
    sliceImage: countOf(boxTemplate, /<SliceImage[\s>]/g),
    cutHint: /cut-hint="photo"/.test(boxTemplate),
    sameSource: /:src="srcs\[current\.id\]"/.test(boxTemplate),
    row: /:row="current"/.test(boxTemplate)
  }
)

check(
  'C2',
  '**不绕过切分**：遮罩内零 `<img` 标签（整图直出会被这条判红），大图宽度容器 `min(92vw, 900px)` 在场',
  { imgTags: 0, containerWidth: true },
  {
    imgTags: countOf(boxTemplate, /<img[\s>]/g),
    containerWidth: /width:\s*min\(92vw,\s*900px\)/.test(boxStyle)
  }
)

check(
  'C3',
  '头部信息沿用现有口径：`實拍圖 <id>` ＋ 尺寸 ＋ `formatBytes(bytes)` ＋ `mime` ＋ 计数「N / 总」',
  { title: true, dims: true, bytes: true, mime: true, counter: true },
  {
    title: /實拍圖/.test(boxTemplate),
    dims: /current\.width/.test(boxTemplate) && /current\.height/.test(boxTemplate),
    bytes: /formatBytes\(current\.bytes\)/.test(boxTemplate) && /import \{ formatBytes \}/.test(boxScript),
    mime: /current\.mime/.test(boxTemplate),
    counter: /\{\{\s*position\s*\}\}\s*\/\s*\{\{\s*total\s*\}\}/.test(boxScript + boxTemplate)
  }
)

check(
  'C4',
  '不动数据层：组件零 `services/` 引用（零新增网络请求 / 不改 photoService），图源只经 props 的 `srcs`',
  { serviceImports: 0, srcsFromProps: true },
  {
    serviceImports: countOf(boxScript, /from\s+'[^']*services\//g),
    srcsFromProps: /const props = defineProps\(/.test(boxScript) && /srcs:\s*\{\s*type:\s*Object/.test(boxScript)
  }
)

/* =========================================================================== */
section('D', '翻页面：边界走纯函数 `neighborIndex`（首尾不循环）')
/* =========================================================================== */

const { neighborIndex } = await import(pathToFileURL(path.join(ROOT, UTIL_REL)).href)

const CASES = [
  { current: 0, total: 3, step: 1, expect: 1 },
  { current: 1, total: 3, step: 1, expect: 2 },
  { current: 2, total: 3, step: 1, expect: -1 },
  { current: 0, total: 3, step: -1, expect: -1 },
  { current: 1, total: 3, step: -1, expect: 0 },
  { current: 2, total: 3, step: -1, expect: 1 },
  { current: 0, total: 1, step: 1, expect: -1 },
  { current: 0, total: 1, step: -1, expect: -1 },
  { current: 0, total: 0, step: 1, expect: -1 },
  { current: -1, total: 3, step: 1, expect: -1 },
  { current: 3, total: 3, step: 1, expect: -1 },
  { current: 1, total: 3, step: 0, expect: -1 },
  { current: 1.5, total: 3, step: 1, expect: -1 },
  { current: 0, total: 3, step: 2, expect: 2 },
  { current: 1, total: 3, step: 2, expect: -1 }
]

function tableDiff(fn) {
  return CASES.filter((c) => fn(c.current, c.total, c.step) !== c.expect)
    .map((c) => `${c.current},${c.total},${c.step}→${fn(c.current, c.total, c.step)}≠${c.expect}`)
}

const tableDiffReal = tableDiff(neighborIndex)

check(
  'D1',
  '边界行为表 15 例逐条对拍（首尾不循环 ⇒ 首张再上、末张再下一律 -1；total/入参非法亦 -1）',
  { mismatches: [] },
  { mismatches: tableDiffReal }
)

check(
  'D2',
  '纯函数被组件接线：`neighborIndex(` 调用点 ≥ 3（`canPrev` / `canNext` / `go`），且模板零边界算式（`:disabled="!canPrev"` 形态）',
  { callSitesAtLeast: 3, templateArithmetic: 0 },
  {
    callSitesAtLeast: Math.min(countOf(boxScript, /neighborIndex\s*\(/g), 3),
    templateArithmetic: countOf(boxTemplate, /neighborIndex|photos\.length|index\s*[+-]\s*1|Math\./g)
  }
)

check(
  'D3',
  '边界口径单一：组件内零回卷写法（`% …length`），页面侧也不自持第二份翻页算式',
  { wrapInBox: 0, wrapInView: 0 },
  {
    wrapInBox: countOf(boxScript + boxTemplate, /%\s*(?:props\.)?photos\.length/g),
    wrapInView: countOf(viewScript, /neighborIndex|photoLightboxIndex\s*[+-]\s*1/g)
  }
)

/* =========================================================================== */
section('E', '零 CSS 新色值：新增样式的颜色一律 `var(--…)`')
/* =========================================================================== */

/** `#hex` / `rgb()` / 颜色关键字（词后不接 `-`/`_`，避开 `white-space` 这类误报）。 */
const COLOR_WORDS =
  'aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgrey|darkgreen|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|grey|green|greenyellow|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgrey|lightgreen|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|transparent|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen'
const COLOR_LITERAL = new RegExp(
  `#[0-9a-fA-F]{3,8}\\b|\\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\\s*\\(|\\b(?:${COLOR_WORDS})(?![\\w-])`,
  'gi'
)

const COLOR_PROPS = /^(?:[a-z-]*color|background|border(?:-[a-z]+)?|box-shadow|outline|fill|stroke|caret-color)$/

function cssRulesOf(text) {
  const rules = []
  let rest = text
  for (;;) {
    const open = rest.indexOf('{')
    if (open === -1) break
    const close = rest.indexOf('}', open)
    if (close === -1) break
    rules.push({ selector: rest.slice(0, open).trim().replace(/\s+/g, ' '), body: rest.slice(open + 1, close) })
    rest = rest.slice(close + 1)
  }
  return rules
}

/** 取值里的 `var(--…)` 引用（令牌本身不是色字面 —— `--c-gold` 里的 `gold` 不算）。 */
function withoutVars(value) {
  let out = value
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/var\([^()]*\)/g, ' ')
    if (next === out) break
    out = next
  }
  return out
}

/** 新增样式块的读数：色字面清单 ＋ 非令牌颜色声明清单。 */
function colorAudit(rules) {
  const literals = []
  const nonToken = []
  for (const rule of rules) {
    for (const m of rule.body.matchAll(/([a-zA-Z-]+)\s*:\s*([^;]+);/g)) {
      const prop = m[1]
      const value = m[2].trim()
      if (COLOR_LITERAL.test(withoutVars(value))) {
        COLOR_LITERAL.lastIndex = 0
        literals.push(`${rule.selector}{${prop}:${value}}`)
        continue
      }
      COLOR_LITERAL.lastIndex = 0
      if (COLOR_PROPS.test(prop) && !value.includes('var(') && value !== 'none') {
        nonToken.push(`${rule.selector}{${prop}:${value}}`)
      }
    }
  }
  return { literals, nonToken }
}

const boxRules = cssRulesOf(boxStyle)
const viewStyle = stripJsComments(sectionOf(viewRaw, 'style'))
const zoomRules = cssRulesOf(viewStyle).filter((rule) => rule.selector.includes('photo--zoom'))

const boxAudit = colorAudit(boxRules)
const zoomAudit = colorAudit(zoomRules)

check(
  'E1',
  '零 CSS 新色值：`PhotoLightbox.vue` 样式段颜色字面 0 且颜色类声明全部来自 `var(--…)` / `none`',
  { literals: [], nonToken: [] },
  { literals: boxAudit.literals, nonToken: boxAudit.nonToken }
)

check(
  'E2',
  '零 CSS 新色值：详情页新增的 `.detail__photo--zoom` 规则颜色字面 0 且值全部来自 `var(--…)`',
  { rulesFoundAtLeast: 2, literals: [], nonToken: [] },
  { rulesFoundAtLeast: Math.min(zoomRules.length, 2), literals: zoomAudit.literals, nonToken: zoomAudit.nonToken }
)

/* =========================================================================== */
section('F', '负对照：内存变异 ⇒ 目标判据必须判红（尺子会响）')
/* =========================================================================== */

/* F1：触发块注入权限门 ⇒ A4 判红。 */
const gatedFigure = figureTag.replace('role="button"', 'v-if="canAdmin"\n            role="button"')
check(
  'F1',
  '负对照（**变异后 A4 判红**）：给触发块注入 `v-if="canAdmin"` ⇒ 「零权限门」读数由 0 变 1（A4 expected triggerGate:0 ⇒ 判红）',
  { mutationApplied: true, wouldFailA4: true },
  {
    mutationApplied: gatedFigure !== figureTag && /v-if="canAdmin"/.test(gatedFigure),
    wouldFailA4: countOf(gatedFigure, /v-(?:if|show|else)/g) !== 0
  }
)

/* F2：把边界函数换成回卷版 ⇒ D1 表必须判红。 */
function wrapIndex(current, total, step) {
  if (!Number.isInteger(total) || total <= 0) return -1
  if (!Number.isInteger(current) || !Number.isInteger(step) || step === 0) return -1
  return (((current + step) % total) + total) % total
}
const tableDiffWrap = tableDiff(wrapIndex)
check(
  'F2',
  '负对照（**变异后 D1 判红**）：边界改回卷版 `(i+step+len)%len` ⇒ 至少一条用例不符（首/末张不再返回 -1）',
  { mutationApplied: true, wouldFailD1: true, sample: '2,3,1→0≠-1' },
  {
    mutationApplied: tableDiffWrap.length > 0,
    wouldFailD1: tableDiffWrap.length > 0,
    sample: tableDiffWrap[0] ? `${tableDiffWrap[0]}` : ''
  }
)

/* F3：往新增样式注入色值 ⇒ E1 判红。 */
const boxedWithColor = boxStyle.replace('.photo-lightbox__title {', '.photo-lightbox__title {\n  color: #ffffff;')
const f3Audit = colorAudit(cssRulesOf(boxedWithColor))
check(
  'F3',
  '负对照（**变异后 E1 判红**）：往遮罩样式注入 `color: #ffffff` ⇒ 色字面读数由 [] 变 1 条',
  { mutationApplied: true, wouldFailE1: true },
  {
    mutationApplied: boxedWithColor !== boxStyle && f3Audit.literals.length === 1,
    wouldFailE1: f3Audit.literals.length !== 0
  }
)

/* F4：去掉 aria-modal ⇒ B1 判红。 */
const noAriaModal = boxTemplate.replace('aria-modal="true"', '')
check(
  'F4',
  '负对照（**变异后 B1 判红**）：删掉 `aria-modal="true"` ⇒ 读数由 1 变 0',
  { mutationApplied: true, wouldFailB1: true },
  {
    mutationApplied: noAriaModal !== boxTemplate,
    wouldFailB1: countOf(noAriaModal, /aria-modal="true"/g) !== 1
  }
)

/* F5：复制一份遮罩用法 ⇒ B2 判红（遮罩不再只有一份）。 */
const twice = viewTemplate.replace(
  /(<PhotoLightbox[\s\S]*?\/>)/,
  '$1\n    <PhotoLightbox v-if="photoLightboxOpen" :photos="gallery" />'
)
check(
  'F5',
  '负对照（**变异后 B2 判红**）：页面里再复制一份 `<PhotoLightbox` ⇒ 用法数由 1 变 2（`v-if` 守卫拦不住「两份」）',
  { mutationApplied: true, wouldFailB2: true },
  {
    mutationApplied: twice !== viewTemplate,
    wouldFailB2: countOf(twice, /<PhotoLightbox[\s>]/g) !== 1
  }
)

/* F6：遮罩内改走整图直出（塞一个 `<img>`）⇒ C2 判红。 */
const withImg = boxTemplate.replace('</div>\n  </div>', '<img :src="srcs[current.id]" />\n    </div>\n  </div>')
check(
  'F6',
  '负对照（**变异后 C2 判红**）：遮罩里塞一个整图 `<img>` ⇒ `imgTags` 由 0 变 1（不许绕过切分直出）',
  { mutationApplied: true, wouldFailC2: true },
  {
    mutationApplied: withImg !== boxTemplate && /<img[\s>]/.test(withImg),
    wouldFailC2: countOf(withImg, /<img[\s>]/g) !== 0
  }
)

/* =========================================================================== */
/* 收尾                                                                        */
/* =========================================================================== */
const total = results.length
const failedIds = results.filter((r) => !r.pass).map((r) => r.id)
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: failedIds,
    note: '离线自检：SFC 静态扫描 ＋ 纯函数行为表 ＋ 内存变异负对照；零网络、零浏览器、零生产读写。'
  })
)
process.exit(failures === 0 ? 0 : 1)
