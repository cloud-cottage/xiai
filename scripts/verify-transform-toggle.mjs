#!/usr/bin/env node
/**
 * 玺爱 · **提案表单简繁**开关图标**（`TextTransformToggle.vue`）** 回归套件
 * ============================================================================
 * 覆盖：规范 v1.115 §3.92（含 §3.92.1 〜 §3.92.6）＋ §10.99（`AC-772` 〜 `AC-779`）；
 *       实现入库 `5bfc93e`；基线副本 `b096bda`（父提交，`git worktree` 取得）。
 *
 * 判据清单（每条皆可判负；负对照见 G 段，尺子必须会响）：
 *   扫描口径：**SFC 分段去注释**（`<template>` 只剥 `<!-- -->`、`<script>` 剥块注释与行尾 `//`、
 *      `<style>` 剥块注释），被剥字符抹成空格、换行原样保留 ⇒ 行号零漂移。
 *      注释里写的 `<TextTransformToggle` / `data-transform-toggle` 不算实码。
 *
 *   A  **落点数量（AC-772）**：`PersonProposalDialog.vue` 去注释后 `type="text"` 数 ≡
 *      `<TextTransformToggle` 数（现 13 / 13）；逐 `<div class="field__row">` 行核「一行恰一框一图标」，
 *      且**同行两件的 `v-model` 指向同一字段**（防「一图标管多框」「图标挂错框」）；本表单
 *      `TextTransformButtons` ≡ 0（旧三按钮版在本表单归零）。
 *   B  **另三处未被改（AC-777）**：`UploadSealDialog` / `AddSealFaceDialog` / `SealFolderPicker`
 *      的 `TextTransformButtons` 计数与 `b096bda` **逐字相同**（`git show` 取基线对比），三份文件
 *      逐字节相同，且三处零 `data-transform-toggle`；旧组件源件 `TextTransformButtons.vue`
 *      亦逐字节未改（`s2t` / `t2s` / `undo` 三取值与「撤銷」文案原样有效）。
 *   C  **钩子取值（AC-778）**：`data-transform-toggle` 的取值恒为 `s2t|t2s` 二值 —— 静态（源码字面
 *      集合 ⊆ {s2t,t2s}、零 `undo` / 零 `data-transform` 串用）＋ **执行面**（跨四态实测取值集合
 *      **恰** `{s2t,t2s}`，两值都出现过）；组件与本表单零 `data-admin-action`。
 *   D  **开关语义（AC-773 / 774 / 775 / 776，执行型）**：把 `TextTransformToggle.vue` 用
 *      `@vue/compiler-sfc` **现编译**（脚本 setup ＋ 模板 render），沙箱里直调 `setup`、`emit` 回写
 *      `v-model`、读**真 render 出来的 vnode props**（不是只看注释 / 只读源码）：
 *      简体→一次→繁体→再一次→回简体逐字相等 —— **可逆判据只取无多义字样例**：`国`⇄`國`、
 *      `汉`⇄`漢`、`龙`⇄`龍`、`门`⇄`門`、`时`⇄`時`（依规范 §3.92.5 追加注③「`AC-773` 的可逆判据
 *      限『无多义字』样例」）；
 *      繁体起首点走 `t2s`；**方向属性 `data-transform-toggle` 随值三态翻转**（D12，防「记忆上一方向」）；
 *      空值（含全角空格）`disabled` 且点击零转换零请求；在途 `disabled` ＋ `aria-busy` ＋
 *      `data-transform-toggle-busy`，DOM 零进度条 / 百分比 / 分段读数；失败（抛错夹具）值逐字不变 ＋
 *      上屏可读文案 ＋ 可重试。
 *   D14 **多义字 `干` / `乾` ＝ 已登记的数据面局限（钉住当前真值，不作可逆判据）**：按规范
 *      §3.92.5 追加注（v1.115「已知轉換局限」）**如实钉住三条当前真值** ——
 *      ① 词组表在位（产品真路径）：`干净` 走 `s2t` 得 `乾淨`；② `乾淨` 走 `t2s` 得 `乾净`
 *      （`乾` 不降级）⇒ `干净` 连点两次停在 `乾净`、**不回原值**；③ 逐字回落形态（词组表未取回时，
 *      亦即规范该追加注所记读数）：`干净` 得 `干淨`。**这不是缺陷、不得当红项长期报**；
 *      将来若补表（另开补表单，落点限 `utils/traditional.js` 真源）**本条会红** ⇒ 届时同步规范
 *      （该追加注标「已解除」＋ 新单号）并把本条改写为新的当前真值。
 *   E  **繁体门（AC-72 同型）**：组件全部可上屏字串（三态悬停说明 ＋ 两条提示文案）与表单本单新增的
 *      提示段，逐条 `s2t(x) === x`；图标可见文案面零「簡體 / 繁體」直排（方向只在 `title` / `aria-label`）。
 *   F  **计数面（AC-779）**：`[data-admin-action]` 仍**恰 12 值 · 归并 11 类**（去注释后扫 `src/**`）。
 *   G  **负对照（≥ 3 点，沙箱拷产品副本，逐点断言对应用法必红）**：
 *      ① 开关判据改成**永远 `s2t`**（不双向）⇒ D2 判据必红；
 *      ② **空值不禁用**（`disabled` 只留 `busy`）⇒ D4 必红；②b 把 `hasValue` 的 `trim()` 去掉
 *      （全角空格当真值）⇒ D4 必红（全角那一格）；
 *      ③ 把新图标从 **3 个字段**拆掉 ⇒ A 段计数与逐行判据必红。
 *      ④ 方向属性改成**记忆上一方向**（`lastDir` ref，只在 `apply` 里更新）⇒ D12 判据必红
 *      （属性滞后成上一次方向 ⇒ 连点后不再述「下一次点按」）。
 *      每点都先断「变异确实打上了」（文本已变），再断「目标判据翻 false」——
 *      若写成「拿变异值比原始期望值」会恒红，语义是反的。
 *
 * 纪律：**只读** `src/**`（沙箱一律落在 `mktemp` 临时目录，跑完即删，不写被测件）；
 *      离线（`XIAI_NO_REAL_CARD=1`，本套零网络：词组表用**读文件的 `fetch` 同义实现**注入，
 *      即浏览器里那条 `loadPhraseTable()` 真路径）；不新增依赖（`@vue/compiler-sfc` 仓内已有）；
 *      断言失败 ⇒ 退出码非 0。
 */
process.env.XIAI_NO_REAL_CARD = '1'

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const VUE_MJS = pathToFileURL(path.join(ROOT, 'node_modules/vue/index.mjs')).href
const BASE_COMMIT = 'b096bda'

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

/** 只记录、不判负（读数行；`summary` 里不计入 pass / fail）。 */
function reading(id, desc, value) {
  console.log(JSON.stringify({ reading: id, case: desc, value }))
}

const section = (id, title) => console.log(JSON.stringify({ section: id, title }))
const sorted = (arr) => [...arr].slice().sort()

/* ---------------------------------------------------------------------------
   1. SFC 分段去注释（被剥字符抹成空格、换行保留 ⇒ 行号零漂移）
   --------------------------------------------------------------------------- */
const BACKTICK = '\u0060'

function blankChars(chars, from, to) {
  for (let k = Math.max(0, from); k < Math.min(to, chars.length); k += 1) {
    if (chars[k] !== '\n') chars[k] = ' '
  }
}

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

/** SFC 分段去注释（`<template>` 只剥 HTML 注释；`<script>` 剥 JS 注释；`<style>` 剥块注释）。 */
function stripSfc(source) {
  const chars = source.split('')
  const open = /<(template|script|style)(\s[^>]*)?>/g
  let m
  const blocks = []
  while ((m = open.exec(source)) !== null) {
    const tag = m[1]
    const bodyStart = open.lastIndex
    const closeIdx = source.indexOf(`</${tag}>`, bodyStart)
    if (closeIdx === -1) continue
    blocks.push({ tag, from: bodyStart, to: closeIdx })
    open.lastIndex = closeIdx
  }
  let cursor = 0
  for (const block of blocks) {
    blankHtmlComments(chars, cursor, block.from)
    if (block.tag === 'template') blankHtmlComments(chars, block.from, block.to)
    else if (block.tag === 'script') blankJsComments(chars, block.from, block.to)
    else blankChars(chars, block.from, block.to)
    cursor = block.to
  }
  blankHtmlComments(chars, cursor, chars.length)
  /* 纯 `.js` 件（无 SFC 段）：整篇按 JS 剥注释。 */
  if (blocks.length === 0) blankJsComments(chars, 0, chars.length)
  return chars.join('')
}

/** 读 `src/**` 某文件（当前工作区）。 */
const readSrc = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
/** 读**基线副本**同路径文件（`git show <BASE_COMMIT>:<rel>`；文件不在基线 ⇒ `null`）。 */
function readBaseline(rel) {
  try {
    return execFileSync('git', ['show', `${BASE_COMMIT}:${rel}`], { cwd: ROOT, encoding: 'utf8' })
  } catch {
    return null
  }
}
const countOf = (text, re) => (text.match(re) || []).length

/* ---------------------------------------------------------------------------
   2. 静态分析件：表单落点（逐行一框一图标 ＋ 同字段绑定）
   --------------------------------------------------------------------------- */
const DIALOG = 'src/components/PersonProposalDialog.vue'
const TOGGLE = 'src/components/TextTransformToggle.vue'

/**
 * **`AC-773` 可逆判据的取样面：限「无多义字」** —— 依规范 §3.92.5 追加注③（v1.115「已知轉換局限」），
 * 取样的**逐字映射必须双向单值**，避开 `干` / `乾` 等多义字（那些字的现状见 D14，**不作可逆判据**）。
 * 每对实测：`s2t(simp) === trad` 且 `t2s(trad) === simp`。
 */
const REVERSIBLE_SAMPLES = [
  { simp: '国', trad: '國' },
  { simp: '汉', trad: '漢' },
  { simp: '龙', trad: '龍' },
  { simp: '门', trad: '門' },
  { simp: '时', trad: '時' }
]

/** 转换真源的**同步逐字层**（D14 的「逐字回落形态」与 E 段繁体门共用；全量异步版在组件里现调）。 */
const { toTraditionalText } = await import(pathToFileURL(path.join(ROOT, 'src/utils/traditional.js')).href)

/** 从一段模板行块里取 `v-model="…"` 的目标表达式。 */
function vModelTargets(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*v-model="([^"]+)"`, 'g')
  const out = []
  let m
  while ((m = re.exec(block)) !== null) out.push(m[1].trim())
  return out
}

/**
 * 分析提案表单模板（**入参为去注释后的源码**，可喂变异副本）：
 *   - `textInputs`：`type="text"` 实例数
 *   - `toggles`：`<TextTransformToggle` 实例数
 *   - `oldButtons`：`<TextTransformButtons` 实例数
 *   - `rows`：逐 `<div class="field__row">」块 —— 每块的 `{inputs, toggles, paired}`，
 *     `paired` ＝ 该行的框与图标的 `v-model` 目标**逐一相同**（一框一图标、图标不串字段）
 *   - `unpaired`：`paired === false` 的行号清单
 */
function analyzeDialog(cleanSource) {
  const textInputs = countOf(cleanSource, /type="text"/g)
  const toggles = countOf(cleanSource, /<TextTransformToggle\b/g)
  const oldButtons = countOf(cleanSource, /<TextTransformButtons\b/g)
  const rows = []
  const unpaired = []
  const rowRe = /<div class="field__row">/g
  let m
  while ((m = rowRe.exec(cleanSource)) !== null) {
    // 取到该 `</div>` 之前的一段（够用：行内只有 input ＋ toggle ＋ 自闭合，无嵌套 div）
    const end = cleanSource.indexOf('</div>', m.index)
    if (end === -1) continue
    const block = cleanSource.slice(m.index, end)
    const inputs = vModelTargets(block, 'input')
    const tog = vModelTargets(block, 'TextTransformToggle')
    const paired = inputs.length === 1 && tog.length === 1 && inputs[0] === tog[0]
    const line = cleanSource.slice(0, m.index).split('\n').length
    rows.push({ line, inputs: inputs.length, toggles: tog.length, target: inputs[0] || null, paired })
    if (!paired) unpaired.push({ line, inputs, toggles: tog })
  }
  return { textInputs, toggles, oldButtons, rows, unpaired }
}

/* 同一把尺子：A 段（产品件）与 G3（变异副本）**共用**这两个判据函数 ——
   保证「变异后必红」判的是同一条判据，而不是另写一份期望值。 */
const a3Holds = (info) => info.textInputs === 13 && info.toggles === 13
const a5Holds = (info) =>
  info.rows.length === 13 && info.rows.every((r) => r.inputs === 1 && r.toggles === 1)

/**
 * **D12 判据（方向属性随值翻转；同一把尺子）**：产品件与 G4（「记忆上一方向」变异副本）**共用**本函数。
 *   简体起：属性 `s2t` ⇒ 执行后 `t2s` ⇒ 再执行后 `s2t`（恒述「下一次点按」的方向）；
 *   繁体起：属性 `t2s` ⇒ 执行后 `s2t`。
 */
const d12Holds = (o) =>
  Boolean(o) &&
  o.simp.dir0 === 's2t' &&
  o.simp.dir1 === 't2s' &&
  o.simp.dir2 === 's2t' &&
  o.trad.dir0 === 't2s' &&
  o.trad.dirAfter === 's2t'

/* ---------------------------------------------------------------------------
   3. 执行夹具：现编译 SFC ⇒ 沙箱模块；直调 setup；读真 render 的 vnode props
   --------------------------------------------------------------------------- */
const sandboxes = []
function makeSandbox(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `xiai-ttt-${label}-`))
  sandboxes.push(dir)
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n')
  return dir
}

/** 把 `from 'vue'` 指向仓内 `node_modules/vue/index.mjs`（沙箱不在仓内 ⇒ 裸说明符不解析）。 */
const rewriteVue = (code) => code.replace(/from (["'])vue\1/g, `from "${VUE_MJS}"`)

/**
 * 用 `@vue/compiler-sfc` 现编译一个 `TextTransformToggle.vue` 源码串，落成沙箱 ESM 模块：
 *   `component.mjs`（`compileScript` 的 `<script setup>` 产物）＋ `render.mjs`（`compileTemplate`）
 *   ＋ `harness.mjs`（`mount()`：reactive props ＋ emit 回写 v-model ＋ `proxyRefs` 后调 render）
 *   ＋ `traditional.js` 与两张词组表副本（**转换真源原样拷贝**，只改 import 说明符）
 * @param {string} source SFC 源码（可已是变异副本）
 * @param {{traditionalStub?: string}} [opts] `traditionalStub` ⇒ 以该源码替换 `traditional.js`（失败夹具）
 */
function buildSandbox(source, label, opts = {}) {
  const dir = makeSandbox(label)
  const { descriptor, errors } = parse(source, { filename: 'TextTransformToggle.vue' })
  if (errors.length) return { dir, error: String(errors[0]) }
  if (!descriptor.template) return { dir, error: 'no <template>' }
  let script
  let tpl
  try {
    script = compileScript(descriptor, { id: 'qa-ttt', inlineTemplate: false })
    tpl = compileTemplate({
      source: descriptor.template.content,
      filename: 'TextTransformToggle.vue',
      id: 'qa-ttt',
      scoped: true
    })
  } catch (err) {
    return { dir, error: String(err && err.message) }
  }
  writeFileSync(
    path.join(dir, 'component.mjs'),
    rewriteVue(script.content).replace(/from (["'])\.\.\/utils\/traditional\.js\1/g, "from './traditional.js'")
  )
  writeFileSync(path.join(dir, 'render.mjs'), rewriteVue(tpl.code))

  if (opts.traditionalStub) {
    writeFileSync(path.join(dir, 'traditional.js'), opts.traditionalStub)
  } else {
    copyFileSync(path.join(ROOT, 'src/utils/traditional.js'), path.join(dir, 'traditional.js'))
    copyFileSync(
      path.join(ROOT, 'src/utils/traditional-phrases-s2t.txt'),
      path.join(dir, 'traditional-phrases-s2t.txt')
    )
    copyFileSync(
      path.join(ROOT, 'src/utils/traditional-phrases-t2s.txt'),
      path.join(dir, 'traditional-phrases-t2s.txt')
    )
  }

  /* `fetch` 同义实现（读文件 ⇒ 与浏览器那条 `loadPhraseTable()` 同路，零网络）；
     `setGate()` 可把请求挂住 ⇒ 真实制造「在途」窗口（不是靠注释声称）。 */
  writeFileSync(
    path.join(dir, 'fetch-stub.mjs'),
    `import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
let gate = null
export const requests = []
export function setGate(p) { gate = p }
globalThis.fetch = async (url) => {
  requests.push(String(url))
  if (gate) { const g = gate; await g }
  const file = fileURLToPath(String(url).split('?')[0])
  const text = readFileSync(file, 'utf8')
  return new Response(text, {
    status: 200,
    headers: { 'content-length': String(Buffer.byteLength(text)) }
  })
}
`
  )

  writeFileSync(
    path.join(dir, 'harness.mjs'),
    `import './fetch-stub.mjs'
import { reactive, proxyRefs, Comment } from "${VUE_MJS}"
import component from './component.mjs'
import { render } from './render.mjs'

function flatten(vnode, out = []) {
  if (!vnode || typeof vnode !== 'object') return out
  if (Array.isArray(vnode)) { for (const v of vnode) flatten(v, out); return out }
  out.push(vnode)
  if (Array.isArray(vnode.children)) flatten(vnode.children, out)
  return out
}
const textOf = (vnode) => {
  const ch = vnode && vnode.children
  if (typeof ch === 'string') return ch
  if (Array.isArray(ch)) return ch.filter((c) => typeof c === 'string').join('')
  return ''
}

/** 挂一个「实例」：props 为 reactive（⇒ emit 回写 modelValue 即 v-model 语义）。 */
export function mount(modelValue, fieldLabel = '姓') {
  const props = reactive({ modelValue, fieldLabel })
  const emitted = []
  let exposed = null
  const emit = (event, ...args) => {
    emitted.push([event, ...args])
    if (event === 'update:modelValue') props.modelValue = args[0]
  }
  const bindings = component.setup(props, { expose: (e) => { exposed = e }, emit })
  const ctx = proxyRefs(bindings)
  const dom = () => {
    /* **注释 vnode 一律剔除**：编译器在 dev 下把 HTML 注释编成 Comment vnode；
       模板注释里的 flex: 1 1 100% 不是进度读数 —— 不剔会误判「出现百分比」。 */
    const vnodes = flatten(render(ctx, [])).filter((v) => v.type !== Comment)
    const button = vnodes.find((v) => v.type === 'button') || null
    const span = vnodes.find((v) => v.type === 'span') || null
    const p = (button && button.props) || {}
    return {
      disabled: Boolean(p.disabled),
      ariaBusy: p['aria-busy'] === undefined ? null : p['aria-busy'],
      dir: p['data-transform-toggle'] === undefined ? null : p['data-transform-toggle'],
      toggleBusy: p['data-transform-toggle-busy'] === undefined ? null : p['data-transform-toggle-busy'],
      title: p.title === undefined ? null : p.title,
      ariaLabel: p['aria-label'] === undefined ? null : p['aria-label'],
      message: span ? textOf(span) : '',
      visibleText: textOf(button).trim(),
      hasButton: Boolean(button),
      html: JSON.stringify(vnodes.map((v) => ({
        type: typeof v.type === 'string' ? v.type : 'fragment',
        props: v.props || null,
        children: typeof v.children === 'string' ? v.children : null
      })))
    }
  }
  return { props, emitted, exposed, dom }
}
`
  )
  return { dir, error: null }
}

/**
 * 跑一组语义场景，回**可判负的观测对象**（不给结论；结论在 D 段判据里下）。
 * 顺序有意：在途态放最先（词组表尚未加载 ⇒ `fetch` 可被 gate 挂住 ⇒ 真实在途窗口）。
 */
async function runScenarios(dir) {
  const harness = await import(pathToFileURL(path.join(dir, 'harness.mjs')).href)
  const stub = await import(pathToFileURL(path.join(dir, 'fetch-stub.mjs')).href)
  const obs = { dirs: [] }

  /* ① 在途态：首点即触发词组表加载 ⇒ 挂住请求读「在途」那一刻的 DOM。 */
  let release
  const gate = new Promise((r) => {
    release = r
  })
  stub.setGate(gate)
  const busyProbe = harness.mount('国')
  const pending = busyProbe.exposed.apply()
  await new Promise((r) => setTimeout(r, 20))
  obs.busy = busyProbe.dom()
  obs.busy.requests = stub.requests.length
  release()
  stub.setGate(null)
  await pending
  obs.busyAfter = busyProbe.dom()

  /* ② 简体起：点一次 ⇒ 繁体；再点一次 ⇒ 回简体（双向可逆）。
     样例**限「无多义字」**（规范 §3.92.5 追加注③）；多义字形态另见 ⑦（钉住已知局限，不作可逆判据）。
     每次点按后**同时读方向属性** —— 它必须恒等于「下一次点按」的方向（D12 判据）。 */
  obs.reversible = []
  for (const sample of REVERSIBLE_SAMPLES) {
    const inst = harness.mount(sample.simp)
    const dir0 = inst.dom().dir
    await inst.exposed.apply()
    const after1 = inst.props.modelValue
    const dir1 = inst.dom().dir
    await inst.exposed.apply()
    const after2 = inst.props.modelValue
    const dir2 = inst.dom().dir
    obs.reversible.push({
      start: sample.simp,
      expectedTrad: sample.trad,
      after1,
      after2,
      dir0,
      dir1,
      dir2,
      emits: inst.emitted.map((e) => e[0])
    })
  }
  obs.simp = obs.reversible[0] /* `国`：逐用例沿用（D1 / D12 / C4 读它） */

  /* ③ 繁体起：首点必须走 t2s；执行后属性随值翻回 s2t（不记忆上一方向）。 */
  const trad = harness.mount('國')
  obs.trad = { dir0: trad.dom().dir }
  await trad.exposed.apply()
  obs.trad.after = trad.props.modelValue
  obs.trad.dirAfter = trad.dom().dir
  obs.trad.emits = trad.emitted.length

  /* ④ 空值（含仅空白 / 全角空格）：禁用 ＋ 点击零转换零请求。 */
  obs.empty = []
  for (const value of ['', '   ', '\u3000', '\u3000 \u3000', '\t\u3000']) {
    const inst = harness.mount(value)
    const before = stub.requests.length
    const dom0 = inst.dom()
    await inst.exposed.apply()
    obs.empty.push({
      value,
      disabled: dom0.disabled,
      emits: inst.emitted.length,
      requests: stub.requests.length - before,
      valueAfter: inst.props.modelValue
    })
  }

  /* ⑤ 非空恢复可用 / 清空重新禁用（三态切换）。 */
  const flip = harness.mount('国')
  obs.flip = { filled: !flip.dom().disabled }
  flip.props.modelValue = ''
  obs.flip.cleared = flip.dom().disabled

  /* ⑥ 逐字未变（无汉字可转）：值不变 ＋ 如实话术。 */
  const nochange = harness.mount('ABC')
  await nochange.exposed.apply()
  obs.nochange = {
    after: nochange.props.modelValue,
    emits: nochange.emitted.length,
    message: nochange.dom().message,
    dir: nochange.dom().dir
  }

  /* ⑦ 多义字 `干` / `乾`（规范 §3.92.5 追加注「已知轉換局限」）：**钉住当前真值**，不作可逆判据。
       三条读数各有归属：① 词组表在位（产品真路径）`干净` ⇒ `s2t` ⇒ `乾淨`；
       ② `乾淨` ⇒ `t2s` ⇒ `乾净`（`乾` 不降级）⇒ 再点回不了 `干净`；③ 逐字回落形态 `干净` ⇒ `干淨`。 */
  const polySimp = harness.mount('干净')
  const polySimpDir0 = polySimp.dom().dir
  await polySimp.exposed.apply()
  const polySimpAfter1 = polySimp.props.modelValue
  const polySimpDir1 = polySimp.dom().dir
  await polySimp.exposed.apply()
  const polySimpAfter2 = polySimp.props.modelValue
  const polyTrad = harness.mount('乾淨')
  const polyTradDir0 = polyTrad.dom().dir
  await polyTrad.exposed.apply()
  obs.poly = {
    simp: {
      start: '干净',
      dir0: polySimpDir0,
      after1: polySimpAfter1,
      dir1: polySimpDir1,
      after2: polySimpAfter2
    },
    trad: { start: '乾淨', dir0: polyTradDir0, after1: polyTrad.props.modelValue },
    glyph: { start: '干净', value: toTraditionalText('干净') }
  }

  /* ⑧ 悬停说明（三态）—— 繁体门与「可见文案零直排」用。 */
  obs.hints = {
    empty: harness.mount('').dom().title,
    simplified: harness.mount('国').dom().title,
    traditional: harness.mount('國').dom().title,
    ariaSame: harness.mount('国').dom().ariaLabel === harness.mount('国').dom().title,
    visibleText: harness.mount('国').dom().visibleText
  }

  for (const d of [
    obs.busy.dir,
    obs.simp.dir0,
    obs.simp.dir1,
    obs.simp.dir2,
    obs.trad.dir0,
    obs.trad.dirAfter,
    obs.nochange.dir
  ]) {
    if (d !== null) obs.dirs.push(d)
  }
  return obs
}

/* 失败夹具：`toTraditionalText` 可用（方向判据要它），两个全量转换**抛错**（模拟表缺失）。 */
const THROW_STUB = `const MAP = { 国: '國' }
export function toTraditionalText(text) {
  return String(text === null || text === undefined ? '' : text).split('').map((c) => MAP[c] || c).join('')
}
export async function toTraditionalFull() { throw new Error('qa fixture: 词组表缺失') }
export async function toSimplifiedFull() { throw new Error('qa fixture: 词组表缺失') }
`

async function runFailureScenario() {
  const built = buildSandbox(readSrc(TOGGLE), 'fail', { traditionalStub: THROW_STUB })
  if (built.error) return { error: built.error }
  const harness = await import(pathToFileURL(path.join(built.dir, 'harness.mjs')).href)
  const inst = harness.mount('国')
  await inst.exposed.apply()
  const first = {
    value: inst.props.modelValue,
    emits: inst.emitted.length,
    message: inst.dom().message,
    disabled: inst.dom().disabled,
    hasBusy: inst.dom().toggleBusy
  }
  await inst.exposed.apply()
  const second = {
    value: inst.props.modelValue,
    emits: inst.emitted.length,
    message: inst.dom().message,
    disabled: inst.dom().disabled
  }
  return { first, second }
}

/* ---------------------------------------------------------------------------
   4. 判据（每条皆可判负）
   --------------------------------------------------------------------------- */
const toggleSource = readSrc(TOGGLE)
const dialogSource = readSrc(DIALOG)
const toggleClean = stripSfc(toggleSource)
const dialogClean = stripSfc(dialogSource)
const dialogInfo = analyzeDialog(dialogClean)

section('A', '落点数量（AC-772）：提案表单 13 框 ↔ 13 图标（1 : 1）、逐行同字段、旧三钮归零')
check('A1', '去注释后 `type="text"` 实例数 ＝ 13（本表单 13 个自由文字框）', 13, dialogInfo.textInputs)
check('A2', '去注释后 `<TextTransformToggle` 实例数 ＝ 13（每框恰一图标）', 13, dialogInfo.toggles)
check(
  'A3',
  '**1 : 1**：文本框实例数 ≡ 图标实例数（同一求值内两侧同数 ⇒ 无「一框两图标」「一图标管多框」）',
  { a3Holds: true, textInputs: 13, toggles: 13 },
  { a3Holds: a3Holds(dialogInfo), textInputs: dialogInfo.textInputs, toggles: dialogInfo.toggles }
)
check('A4', '本表单内 `TextTransformButtons` ≡ 0（旧三文字按钮版在本表单归零，不留变相补回）', 0, dialogInfo.oldButtons)
check(
  'A5',
  '逐 `<div class="field__row">` 行：恰 13 行，每行**恰 1 个框 ＋ 恰 1 个图标**（不得一图标管多框 / 多图标管一框）',
  { a5Holds: true, rows: 13, badRows: 0 },
  {
    a5Holds: a5Holds(dialogInfo),
    rows: dialogInfo.rows.length,
    badRows: dialogInfo.rows.filter((r) => r.inputs !== 1 || r.toggles !== 1).length
  }
)
check(
  'A6',
  '逐行**同字段**：该行图标与输入框的 `v-model` 目标逐一相同（防「图标挂到别的框」——13 行全配对）',
  [],
  dialogInfo.unpaired
)
{
  /* 反向延伸封堵（AC-772 / AC-777④）：`TextTransformToggle` 的**使用处**恰一处 ＝ 提案表单。 */
  const users = walkFiles(path.join(ROOT, 'src'))
    .filter((file) => /<TextTransformToggle\b/.test(stripSfc(readFileSync(file, 'utf8'))))
    .map((file) => path.relative(ROOT, file))
    .sort()
  check('A7', '`<TextTransformToggle` 全仓**仅**出现在 `src/components/PersonProposalDialog.vue`（不反向延伸到别的表单；也不留第二份使用处）', ['src/components/PersonProposalDialog.vue'], users)
}

section('B', '另三处未被改（AC-777）：旧三按钮版三处计数与 b096bda 逐字相同、字节未改')
const UNCHANGED = [
  ['src/components/UploadSealDialog.vue', 4],
  ['src/components/AddSealFaceDialog.vue', 1],
  ['src/components/SealFolderPicker.vue', 1]
]
for (const [rel, expected] of UNCHANGED) {
  const cur = readSrc(rel)
  const base = readBaseline(rel)
  const curClean = stripSfc(cur)
  const baseClean = base === null ? null : stripSfc(base)
  check(
    `B-${path.basename(rel, '.vue')}`,
    `\`${path.basename(rel)}\` 去注释后 \`<TextTransformButtons\` 计数与基线 \`${BASE_COMMIT}\` **逐字相同**（＝ ${expected}），且零 \`data-transform-toggle\`（未被换成图标）`,
    { baseline: expected, current: expected, toggles: 0 },
    {
      baseline: baseClean === null ? null : countOf(baseClean, /<TextTransformButtons\b/g),
      current: countOf(curClean, /<TextTransformButtons\b/g),
      toggles: countOf(curClean, /data-transform-toggle(?![-\w])/g)
    }
  )
}
check(
  'B4',
  '三份文件（上传印章 / 新增印面 / 文件夹命名）**逐字节**与基线相同（不是「肉眼没看出改」）',
  { upload: true, addFace: true, folder: true },
  {
    upload: readSrc(UNCHANGED[0][0]) === readBaseline(UNCHANGED[0][0]),
    addFace: readSrc(UNCHANGED[1][0]) === readBaseline(UNCHANGED[1][0]),
    folder: readSrc(UNCHANGED[2][0]) === readBaseline(UNCHANGED[2][0])
  }
)
check(
  'B5',
  '旧组件源件 `TextTransformButtons.vue` 逐字节未改（`s2t` / `t2s` / `undo` 三取值与「撤銷」文案原样有效）',
  { identical: true, values: ['s2t', 't2s', 'undo'] },
  {
    identical: readSrc('src/components/TextTransformButtons.vue') === readBaseline('src/components/TextTransformButtons.vue'),
    values: sorted(
      new Set(
        (stripSfc(readSrc('src/components/TextTransformButtons.vue')).match(/data-transform="([^"]+)"/g) || []).map((m) =>
          m.replace(/^data-transform="/, '').replace(/"$/, '')
        )
      )
    )
  }
)
check(
  'B6',
  '另三处**零** `data-transform-toggle`（AC-777④：三处未被改成图标开关；图标版也未反向延伸到别的表单）',
  0,
  UNCHANGED.reduce((acc, [rel]) => acc + countOf(stripSfc(readSrc(rel)), /data-transform-toggle(?![-\w])/g), 0)
)

section('C', '钩子取值（AC-778）：`data-transform-toggle` 恒取 s2t|t2s 二值、零串用、零 admin 钩子')
/* 静态取「**字面**写在钩子上的取值」—— 只认非绑定形态（`(?<!:)`），
   绑定形态 `:data-transform-toggle="direction"` 的取值由 D 段执行面证明。 */
const literalToggleValues = sorted(
  new Set(
    (toggleClean.match(/(?<!:)data-transform-toggle="([^"]+)"/g) || []).map((m) =>
      m.replace(/^data-transform-toggle="/, '').replace(/"$/, '')
    )
  )
)
check(
  'C1',
  '组件内 `data-transform-toggle` 为**动态绑定的两值**：字面取值集合内无 {s2t,t2s} 之外的第三值，且恰有一处 `:data-transform-toggle` 绑定（取值面由执行面 C4 佐证）',
  { thirdValues: [], bound: 1 },
  { thirdValues: literalToggleValues.filter((v) => v !== 's2t' && v !== 't2s'), bound: countOf(toggleClean, /:data-transform-toggle="/g) }
)
check(
  'C2',
  '组件内**零**旧钩子 `data-transform`、零 `undo`、零「撤銷」（新族不冒充旧族、也不变相补回撤销）',
  { oldHook: 0, undo: 0 },
  {
    oldHook: countOf(toggleClean, /data-transform(?![-\w])/g),
    undo: countOf(toggleClean, /undo|撤銷/g)
  }
)
check(
  'C3',
  '组件与提案表单**零** `data-admin-action`（AC-45 的 12 值集合不因本单扩张）',
  0,
  countOf(toggleClean, /data-admin-action/g) + countOf(dialogClean, /data-admin-action/g)
)

section('D', '开关语义（AC-773 / 774 / 775 / 776，执行型 —— 现编译 SFC、直调 setup、读真 render 的 props）')
const mainBuilt = buildSandbox(toggleSource, 'main')
let obs = null
if (mainBuilt.error) {
  check('D0', '产品件 `TextTransformToggle.vue` 能被 `@vue/compiler-sfc` 现编译（脚本 setup ＋ 模板 render）', { error: null }, { error: mainBuilt.error })
} else {
  check('D0', '产品件 `TextTransformToggle.vue` 能被 `@vue/compiler-sfc` 现编译（脚本 setup ＋ 模板 render）', { error: null }, { error: null })
  obs = await runScenarios(mainBuilt.dir)
}

if (obs) {
  check(
    'D1',
    '简体起（`国`）：首点走 **s2t**，值变 `國`（真调 `utils/traditional.js` 全量词表版）',
    { dir: 's2t', value: '國' },
    { dir: obs.simp.dir0, value: obs.simp.after1 }
  )
  check(
    'D2',
    '**双向可逆（AC-773；判据限「无多义字」样例 —— 规范 §3.92.5 追加注③）**：`国`⇄`國`、`汉`⇄`漢`、`龙`⇄`龍`、`门`⇄`門`、`时`⇄`時` 逐例连点两次 ⇒ 值**逐字回到起点**（不得「连点两次仍是繁体」/「方向恒 s2t」/「第二次无效果」）',
    REVERSIBLE_SAMPLES.map((s) => ({ start: s.simp, after1: s.trad, after2: s.simp, emits: 2 })),
    obs.reversible.map((r) => ({ start: r.start, after1: r.after1, after2: r.after2, emits: r.emits.length }))
  )
  check('D3', '已是繁体起（`國`）：首点走 **t2s**、值变 `国`（方向按当前值现算，不依赖上一方向标记）', { dir: 't2s', value: '国' }, { dir: obs.trad.dir0, value: obs.trad.after })
  check(
    'D12',
    '**方向属性随值翻转（防回归：不得记忆上一方向）**：简体值 `国` ⇒ `data-transform-toggle="s2t"`；执行一次（值变 `國`）⇒ 属性必翻 **`t2s`**；再执行（回 `国`）⇒ 回 **`s2t`**；繁体值 `國` 起首 ⇒ `t2s`、执行后 ⇒ `s2t` —— 属性恒等于**下一次点按**的真实方向，不得滞后为上一次方向',
    { holds: true, simp: ['s2t', 't2s', 's2t'], trad: ['t2s', 's2t'] },
    {
      holds: d12Holds(obs),
      simp: [obs.simp.dir0, obs.simp.dir1, obs.simp.dir2],
      trad: [obs.trad.dir0, obs.trad.dirAfter]
    }
  )
  check(
    'D4',
    '空值禁用（AC-774）：`""` / 纯空白 / **全角空格** / 全角＋半角混排 —— 逐格 `disabled`',
    [
      { value: '', disabled: true },
      { value: '   ', disabled: true },
      { value: '\u3000', disabled: true },
      { value: '\u3000 \u3000', disabled: true },
      { value: '\t\u3000', disabled: true }
    ],
    obs.empty.map((e) => ({ value: e.value, disabled: e.disabled }))
  )
  check(
    'D5',
    '空值点击**零转换、零请求、零 emit**（AC-774②；含全角空格格）',
    obs.empty.map((e) => ({ emits: 0, requests: 0, value: e.value })),
    obs.empty.map((e) => ({ emits: e.emits, requests: e.requests, value: e.valueAfter }))
  )
  check('D5b', '三态切换：填入非空值 ⇒ 恢复可用；清空 ⇒ 重新禁用（AC-774③④）', { filled: true, cleared: true }, { filled: obs.flip.filled, cleared: obs.flip.cleared })
  check(
    'D6',
    '在途态（AC-775）：`disabled` ＋ `aria-busy="true"` ＋ `data-transform-toggle-busy="true"` 齐备（gate 真挂住词组表请求时读的 DOM）',
    { disabled: true, ariaBusy: 'true', toggleBusy: 'true' },
    { disabled: obs.busy.disabled, ariaBusy: obs.busy.ariaBusy, toggleBusy: obs.busy.toggleBusy }
  )
  const progressHits = ['%', 'progressbar', 'aria-valuenow', 'aria-valuetext'].filter((needle) => obs.busy.html.includes(needle))
  const fractionHits = (obs.busy.html.match(/\d+\s*\/\s*\d+/g) || []).filter((s) => !/0 0 24|24 24/.test(s))
  check(
    'D7',
    '在途**零假进度**（AC-775②）：整段 DOM 无进度条 / 百分比 / `aria-valuenow` / 分段读数（旋转动画不属进度读数，不计）',
    { hits: [], fractions: [] },
    { hits: progressHits, fractions: fractionHits }
  )
  check(
    'D8',
    '在途结束后回到常态：`busy` 摘除、`aria-busy="false"`、按钮按当前值判可用（不得卡在禁用）',
    { toggleBusy: null, ariaBusy: 'false', disabled: false },
    { toggleBusy: obs.busyAfter.toggleBusy, ariaBusy: obs.busyAfter.ariaBusy, disabled: obs.busyAfter.disabled }
  )
  check(
    'D9',
    '逐字未变（无汉字可转，`ABC`）：**值不变、零 emit**，且给一行如实提示（不假装成功、不改写成空串）',
    { value: 'ABC', emits: 0, messageNonEmpty: true },
    { value: obs.nochange.after, emits: obs.nochange.emits, messageNonEmpty: obs.nochange.message.length > 0 }
  )

  const failRun = await runFailureScenario()
  check(
    'D10',
    '失败不静默（AC-776）：转换抛错 ⇒ 上屏**可读失败文案**（逐字记录）、值**逐字不变**、零 emit、零半转值',
    { value: '国', emits: 0, message: '轉換未完成，內容保持不變；請檢查網絡後重試。' },
    failRun.error ? { value: '__build_error__', emits: -1, message: failRun.error } : { value: failRun.first.value, emits: failRun.first.emits, message: failRun.first.message }
  )
  check(
    'D11',
    '失败**可重试**（AC-776③）：失败后按钮未永久禁用（busy 已复位）、再点仍走同一入口并再次如实报错',
    { disabled: false, messageSame: true, emits: 0 },
    failRun.error
      ? { disabled: null, messageSame: false, emits: -1 }
      : { disabled: failRun.second.disabled, messageSame: failRun.second.message === failRun.first.message, emits: failRun.second.emits }
  )

  check(
    'D14',
    '**多义字 `干` / `乾` ＝ 数据面已知局限（规范 §3.92.5 追加注「已知轉換局限」）；本条钉住当前真值、不作可逆判据**：① 词组表在位（产品真路径）`干净` 走 `s2t` 得 `乾淨`；② `乾淨` 走 `t2s` 得 `乾净`（`乾` 不降级）⇒ `干净` 连点两次停在 `乾净`、**不回原值**；③ 逐字回落形态（词组表未取回时）`干净` 得 `干淨`。三条与规范追加注同源、逐字记录。**这不是缺陷、不得当红项长期报**；若将来补表（另开补表单、落点限 `utils/traditional.js` 真源）**此条会红** ⇒ 届时同步规范（该追加注标「已解除」＋ 新单号与解除时点）并把本条改写为新的当前真值',
    {
      phrasePath: { dir: 's2t', value: '乾淨' },
      backPath: { dir: 't2s', value: '乾净' },
      roundTrip: { after2: '乾净', backToOrigin: false },
      glyphPath: { value: '干淨' }
    },
    {
      phrasePath: { dir: obs.poly.simp.dir0, value: obs.poly.simp.after1 },
      backPath: { dir: obs.poly.trad.dir0, value: obs.poly.trad.after1 },
      roundTrip: { after2: obs.poly.simp.after2, backToOrigin: obs.poly.simp.after2 === obs.poly.simp.start },
      glyphPath: { value: obs.poly.glyph.value }
    }
  )
  reading('R-dirs', '执行面实际出现过的 `data-transform-toggle` 取值（去重）', sorted(new Set(obs.dirs)))
  check(
    'C4',
    '执行面取值集合**恰** `{s2t,t2s}` 二值（AC-778 按派单方裁定：该钩子恒取二值之一、不空置、无第三值）',
    ['s2t', 't2s'],
    sorted(new Set(obs.dirs))
  )
}

section('E', '繁体门（AC-72 同型）：可上屏字串逐条 `s2t(x) === x`；图标可见文案零直排')
const hintParagraph = (() => {
  const m = dialogSource.match(/<p class="proposal-box__trad-hint"[\s\S]*?<\/p>/)
  if (!m) return null
  return m[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
})()
const onScreen = obs
  ? {
      hintEmpty: obs.hints.empty,
      hintSimplified: obs.hints.simplified,
      hintTraditional: obs.hints.traditional,
      messageUnchanged: obs.nochange.message,
      dialogHint: hintParagraph
    }
  : { dialogHint: hintParagraph }
const notTraditional = Object.entries(onScreen)
  .filter(([, text]) => typeof text === 'string' && text.length > 0 && toTraditionalText(text) !== text)
  .map(([key, text]) => ({ key, text, converted: toTraditionalText(text) }))
check(
  'E1',
  '组件三态悬停说明 ＋ 「逐字未变」提示 ＋ 表单本单新增提示段：逐条 `s2t(x) === x`（繁体门上屏）',
  [],
  notTraditional
)
check('E2', '表单新增提示段存在且非空（本单确实新增了一段可上屏文案）', { present: true, nonEmpty: true }, { present: hintParagraph !== null, nonEmpty: Boolean(hintParagraph && hintParagraph.length > 0) })
check(
  'E3',
  '图标**可见文案面**零「簡體 / 繁體」直排（方向信息只走 `title` / `aria-label`；图标本体无文字）',
  { visibleText: '', visibleHasDirectionWord: false, ariaEqTitle: true },
  {
    visibleText: obs ? obs.hints.visibleText : '__no_obs__',
    visibleHasDirectionWord: obs ? /簡體|繁體/.test(obs.hints.visibleText) : null,
    ariaEqTitle: obs ? obs.hints.ariaSame : null
  }
)

section('F', '计数面（AC-779）：`[data-admin-action]` 仍恰 12 值 · 归并 11 类')
function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(vue|js)$/.test(entry.name)) out.push(full)
  }
  return out
}
const ADMIN_ACTION_EXPECTED = [
  'upload-seal',
  'edit-fixed-attributes',
  'replace-face-image',
  'correction-accept',
  'correction-reject',
  'edit-seal-attributes',
  'edit-invite-reward',
  'export-seal-data',
  'person-proposal-review',
  'person-import-review',
  'edit-ai-upstream',
  'ai-enhance-face'
]
{
  const found = new Set()
  for (const file of walkFiles(path.join(ROOT, 'src'))) {
    const body = file.endsWith('.vue') ? stripSfc(readFileSync(file, 'utf8')) : stripSfc(readFileSync(file, 'utf8'))
    for (const m of body.match(/data-admin-action="([^"]+)"/g) || []) {
      found.add(m.replace(/^data-admin-action="/, '').replace(/"$/, ''))
    }
  }
  check('F1', '`[data-admin-action]` 去重取值集合逐字 ＝ 12 值（本单零新增；图标不属该族）', sorted(ADMIN_ACTION_EXPECTED), sorted([...found]))
  const classes = [...found].map((v) => (v.startsWith('correction-') ? 'correction-accept|reject' : v))
  check('F2', '按归并表归并后 ＝ 11 类（本单不动）', 11, new Set(classes).size)
}

/* ---------------------------------------------------------------------------
   5. G 段：变异负对照（沙箱拷产品副本 ⇒ 变异 ⇒ 目标判据必红）
   --------------------------------------------------------------------------- */
section('G', '变异负对照：判据必须会响（先断变异打上了，再断目标判据翻 false）')

/* ① 开关判据改成永远 s2t（不双向）。 */
const MUT_KIND_FROM = "const kind = toTraditionalText(before) === before ? 't2s' : 's2t'"
const mutS2tOnly = toggleSource.replace(MUT_KIND_FROM, "const kind = 's2t'")
check('G1a', '负对照前提：①「永远 s2t」变异**确实改到了**产品副本的开关判据（原判据行已消失）', { changed: true }, { changed: mutS2tOnly !== toggleSource && !mutS2tOnly.includes(MUT_KIND_FROM) })
{
  const built = buildSandbox(mutS2tOnly, 'mut-s2t')
  const mutatedObs = built.error ? { error: built.error } : await runScenarios(built.dir)
  const reversible = !mutatedObs.error && mutatedObs.simp.after2 === mutatedObs.simp.initial
  check(
    'G1b',
    '负对照（**变异后 D2 判据红**）：判据改成「永远 s2t」⇒ 第二次点按值停在 `國`（原实现回 `国`）⇒ 双向可逆由 true 翻 false',
    { error: null, reversible: false, after2: '國' },
    mutatedObs.error ? { error: mutatedObs.error, reversible: true, after2: null } : { error: null, reversible, after2: mutatedObs.simp.after2 }
  )
}

/* ② 空值不禁用。 */
const MUT_DISABLED_FROM = ':disabled="busy || !hasValue"'
const mutNoDisable = toggleSource.replace(MUT_DISABLED_FROM, ':disabled="busy"')
check('G2a', '负对照前提：②「空值不禁用」变异确实打上了（`disabled` 只剩 `busy`）', { changed: true }, { changed: mutNoDisable !== toggleSource && mutNoDisable.includes(':disabled="busy"') })
{
  const built = buildSandbox(mutNoDisable, 'mut-disable')
  const mutatedObs = built.error ? { error: built.error } : await runScenarios(built.dir)
  const allDisabled = !mutatedObs.error && mutatedObs.empty.every((e) => e.disabled === true)
  check(
    'G2b',
    '负对照（**变异后 D4 判据红**）：空值不禁用 ⇒ 空框 `disabled` 全 false（原实现全 true）',
    { error: null, allDisabled: false },
    mutatedObs.error ? { error: mutatedObs.error, allDisabled: true } : { error: null, allDisabled }
  )
}

/* ②b 全角空格当真值（`trim()` 去掉）。 */
const MUT_TRIM_FROM = 'const hasValue = computed(() => value.value.trim().length > 0)'
const mutNoTrim = toggleSource.replace(MUT_TRIM_FROM, 'const hasValue = computed(() => value.value.length > 0)')
check('G2c', '负对照前提：②b「去掉 `trim()`」变异确实打上了（`hasValue` 只判长度）', { changed: true }, { changed: mutNoTrim !== toggleSource && !mutNoTrim.includes(MUT_TRIM_FROM) })
{
  const built = buildSandbox(mutNoTrim, 'mut-trim')
  const mutatedObs = built.error ? { error: built.error } : await runScenarios(built.dir)
  const fullWidth = mutatedObs.error ? null : mutatedObs.empty.find((e) => e.value === '\u3000')
  const fullWidthDisabled = fullWidth ? fullWidth.disabled : null
  check(
    'G2d',
    '负对照（**变异后 D4 判据红（全角那一格）**）：`trim()` 去掉 ⇒ 仅全角空格被当作非空（`disabled` false、且点按会真发请求）',
    { error: null, fullWidthDisabled: false },
    mutatedObs.error ? { error: mutatedObs.error, fullWidthDisabled: true } : { error: null, fullWidthDisabled }
  )
}

/* ③ 把新图标从 3 个字段拆掉。 */
const mutDialog = dialogSource.replace(/(<TextTransformToggle\b[^>]*\/>)/g, (full, _g, offset) => {
  // 只拆掉「籍貫 / 傳記 / 來源」三个字段所在行的图标（按 field-label 精确匹配）
  const labels = ['籍貫', '傳記', '來源']
  const isTarget = labels.some((label) => full.includes(`field-label="${label}"`))
  return isTarget ? '<!-- qa mutation: 拆掉 -->' : full
})
check('G3a', '负对照前提：③「拆掉 3 个字段的图标」变异确实打上了（`<TextTransformToggle` 由 13 降为 10）', { toggles: 10 }, { toggles: countOf(stripSfc(mutDialog), /<TextTransformToggle\b/g) })
{
  const info = analyzeDialog(stripSfc(mutDialog))
  check(
    'G3b',
    '负对照（**变异后 A3 判据红**）：拆掉 3 个图标 ⇒ 框 13 ≠ 图标 10（1 : 1 破坏，判据由 true 翻 false）',
    { a3Holds: false, textInputs: 13, toggles: 10 },
    { a3Holds: a3Holds(info), textInputs: info.textInputs, toggles: info.toggles }
  )
  check(
    'G3c',
    '负对照（**变异后 A5 判据红**）：3 行变成「有框无图标」⇒ 逐行判据由 true 翻 false、坏行恰 3',
    { a5Holds: false, badRows: 3 },
    { a5Holds: a5Holds(info), badRows: info.rows.filter((r) => r.inputs !== 1 || r.toggles !== 1).length }
  )
}

/* ④ 方向属性改成「记忆上一方向」（复现修前那个 bug：属性只在 apply 里更新、不随值现算）。 */
const MUT_DIRECTION_FROM = 'const direction = computed(() => pendingDir.value)'
const MUT_DIRECTION_TO = "const lastDir = ref('s2t')\nconst direction = computed(() => lastDir.value)"
const MUT_KIND_LINE = '  const kind = directionFor(before)\n'
const mutStaleDir = toggleSource
  .replace(MUT_DIRECTION_FROM, MUT_DIRECTION_TO)
  .replace(MUT_KIND_LINE, `${MUT_KIND_LINE}  lastDir.value = kind\n`)
check(
  'G4a',
  '负对照前提：④「方向属性记忆上一方向」变异**确实打上了**（`direction` 改读 `lastDir` ref，且 `apply` 里写回 `lastDir`）',
  { changed: true, readsRef: true, writesRef: true },
  {
    changed:
      mutStaleDir !== toggleSource &&
      !mutStaleDir.includes(MUT_DIRECTION_FROM) &&
      mutStaleDir.includes('const lastDir = ref(\'s2t\')'),
    readsRef: mutStaleDir.includes('const direction = computed(() => lastDir.value)'),
    writesRef: mutStaleDir.includes('lastDir.value = kind')
  }
)
{
  const built = buildSandbox(mutStaleDir, 'mut-staledir')
  const mutatedObs = built.error ? { error: built.error } : await runScenarios(built.dir)
  check(
    'G4b',
    '负对照（**变异后 D12 判据红**）：属性记忆上一方向 ⇒ 每次点按后属性滞后一步 —— `国` 三态读成 `s2t` / `s2t` / `t2s`（原实现 `s2t` / `t2s` / `s2t`）、`國` 起首读成 `s2t` / `t2s`（原实现 `t2s` / `s2t`）⇒ D12 由 true 翻 false',
    { error: null, holds: false, simp: ['s2t', 's2t', 't2s'], trad: ['s2t', 't2s'] },
    mutatedObs.error
      ? { error: mutatedObs.error, holds: true, simp: null, trad: null }
      : {
          error: null,
          holds: d12Holds(mutatedObs),
          simp: [mutatedObs.simp.dir0, mutatedObs.simp.dir1, mutatedObs.simp.dir2],
          trad: [mutatedObs.trad.dir0, mutatedObs.trad.dirAfter]
        }
  )
}

/* ---------------------------------------------------------------------------
   6. 收尾
   --------------------------------------------------------------------------- */
for (const dir of sandboxes) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 沙箱清理失败不影响判据 */
  }
}
const total = results.length
check('Z1', '沙箱全部落在临时目录、跑完即删（本套不写被测件；`src/**` 只读）', { sandboxes: 0 }, { sandboxes: sandboxes.filter((d) => { try { readFileSync(path.join(d, 'package.json')); return true } catch { return false } }).length })

console.log(JSON.stringify({ summary: { total, passed: total - failures, failed: failures } }))
process.exit(failures === 0 ? 0 : 1)
