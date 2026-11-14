#!/usr/bin/env node
/**
 * 玺爱 · **seal / face 层口径（base face / side face / 整枚印章圖）** 自检
 * ============================================================================
 * 口径正本：`docs/face-layer-ruling-2026-11-14.md`（eec0054）；
 * 规范：`docs/xiai.spec.md` §3.89 / §3.89.1 〜 §3.89.6 ＋ §10.96（`AC-748` 〜 `AC-753`）
 * ＋ §3.88.4 / §3.88.6 追加注（v1.112）。
 *
 * **本地、离线、零网络、零云端、零生产数据**：读源码做静态门 ＋ 直接调用
 * `src/services/seals.js` 的**真实导出函数**（`sortFacesForDisplay` / `listFacesOf` /
 * `wholeSealImagesOf` / `faceRoleOf` / `faceLabelOn`）＋ 本机镜像（`local-dev` 形态）注入行。
 *
 * ----------------------------------------------------------------------------
 * 断言面（`A` 〜 `G`，每条可机械判负）
 * ----------------------------------------------------------------------------
 * A. **上屏零「邊款」零 `edge`**（`AC-749`）—— 判尺与豁免规则**逐条写死在 A 段注释里**；
 * B. **显示次序 ＋ 排序单点**（`AC-748` / `AC-750`）：base face 最先、其余按 `face_no` 升序，
 *    排序只落 `sortFacesForDisplay`（`listFacesOf` 唯一调用点）；
 * C. **整枚印章圖**（`AC-751`）：未被任何面引用、**按 `seq` 升序**、排所有面块之后、零枚不渲染；
 * D. **上传三选一**（`AC-752`）：base 禁用文案逐字、默认 side、整章图不建面 / 不写 `face_count`；
 * E. **`kind` 数据值未改**（零迁移）：`FACE_KIND` 仍 `FACE` / `EDGE`，代码仍接受 `'EDGE'`；
 * F. **`[data-admin-action]` 仍恰 12 值**且**逐字等于改前**（`f4a90ed`，见 F 段注释）；
 * G. **规范锚点在册**（§3.89 ＋ §10.96 `AC-748` 〜 `AC-753` 各恰 1 条）；
 * H. **三新 op 行为面**（v1.113 `ADMIN_OPS` 41 → 44：`migrateEdgeFaces` / `deleteWholeSealImage` /
 *    `setBaseFace`）—— 注入式假 DB ＋ 假对象删除缝，直调 `ops.ADMIN_OPS[<op>]` 走真实注册面 →
 *    薄委派 → `lib/faceLayerOps.js` 真实现（零网络、零生产数据）。
 *
 * 纪律：零外部网络、零生产写入；不打印任何密钥 / 令牌；断言失败 ⇒ 退出码非 0。
 *
 * 用法：node scripts/verify-face-layer.mjs
 */

/* **测试环境保护哨兵（硬防线）** —— 本套件只读源码 ＋ 跑离线本机镜像：置 `XIAI_NO_REAL_CARD=1`。
   若哪个调用点漏注入假传输，`lib/cardApi.js` 会**当场抛错、零请求**（绝不悄悄打生产 CARD）。
   跑任何套件前**不得** export 真 `CARD_API_KEY`（见 `scripts/README-test-net.md`）。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const fileUrl = (p) => pathToFileURL(`${ROOT}/${p}`).href

/* ---------------------------------------------------------------------------
   0. localStorage / window 假体（只为让 ESM 真源在本机 Node 下可导入）
   --------------------------------------------------------------------------- */
const memory = new Map()
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear()
}
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}

/* ---------------------------------------------------------------------------
   1. 断言与读数（沿既有套件形态：check(id, desc, expected, actual)）
   --------------------------------------------------------------------------- */
const results = []
let failures = 0
function check(id, desc, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual)
  if (!ok) failures += 1
  results.push({ id, pass: ok })
  console.log(JSON.stringify({ id, case: desc, pass: ok, expected, actual }))
}
const section = (name, title) => console.log(JSON.stringify({ section: name, title }))
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

/* ===========================================================================
   A. 上屏零「邊款」零 `edge`（`AC-749`）
   ---------------------------------------------------------------------------
   **判尺规则（逐条写死；实现必须与本注释逐字一致，改尺 ＝ 改口径 ⇒ 需另开单）**

   1. 扫描面 ＝ `src/**\/*.js` ＋ `src/**\/*.vue`（`node_modules` / `.git` 外全扫）。
   2. 先去注释、再抽「用户可见串」：
      · `.js`：整文件按 JS 处理；
      · `.vue`：按**列 0** 的 `<template>` / `<script>` / `<style>` 分段，`<style>` 整段跳过，
        `template` 只剥 `<!-- -->`（HTML 注释）并保留换行，`script` 段按 JS 剥注释
        （`//` 与 `/* *\/`；**注释空位保留换行**，行号不漂）。
   3. 抽串规则：
      · `script` 段 / `.js`：抽 `'…'` / `"…"` / `` `…` `` 三种字面量。**模板字面量里的
        `${…}` 表达式按代码处理**（其内部的字面量单独再抽一层），只有表达式之外的文本算文案；
      · `template` 段：`{{ … }}` 插值按代码处理（剔除后再取文本）；**静态属性值**（`class` /
        `placeholder` / `aria-label` …）整值为文案；**动态绑定**（`:` / `@` / `v-` 前缀）的值
        是代码 ⇒ 只抽其中的字符串字面量当文案；标签之间的文本节点（去空白）为文案。
   4. 判定（对每条文案）：
      · 含 `邊款` ⇒ **命中（必红）**；
      · 含 `edge` / `Edge` / `EDGE`（`\bedge\b` 词边界、大小写不敏感）⇒ 进入下一步；
      · **放行**：单 token 形态 —— 去空白后**无中日韩字符**（含 U+3000〜U+303F 标点）
        且整体匹配 `^[A-Za-z0-9_.$-]+$` ⇒ 视为「内部常量 / 变量名 / 类名 / 数据值 / 事件名」
        （`AC-749` 明确豁免「內部常量 / 變量名 / 數據值 / 註釋」）⇒ 不算命中。
        典型放行样本：`edge_image_ids` / `EDGE` / `FACE` / `fixed-edge-ids` /
        `face-block__badge--side` / `X-Xiai-Thumb-Long-Edge`；
      · 其余（含空白或中日韩字符）⇒ **命中（必红）**。典型命中样本：`邊款圖` /
        `side edge 圖` / `僅接受 FACE、EDGE 或 PHOTO`。
   5. **豁免白名单（逐条 `file` ＋ `mustContain` 精确四元组里的两元，且逐条自证仍在场）**：
      · `src/data/seed.js` 的 **4 条藏品释文正文**（`transcription` 字面量，属**内容**不属文案；
        裁定件 §三「上屏）不得出现」不约束藏品原文）；
      · `src/tilesplicer/core.js` 的 1 条**结构性诊断文案**（`reason:'UNKNOWN_KIND'` 的
        `message`，仅当数据里出现未登记 `kind` 时才可达）—— **本单写集外**的已知残留，
        由 `A5` 单列在册（条数写死 ＝ 1，多一条即红）。
   =========================================================================== */
const CJK_RE = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff]/
const TOKEN_RE = /^[A-Za-z0-9_.$-]+$/
const isTokenLike = (value) => {
  const text = String(value).trim()
  if (!text) return true
  if (CJK_RE.test(text)) return false
  return TOKEN_RE.test(text)
}
/** 判尺单点：返回 `''`（不命中）/ `'cjk'`（含「邊款」）/ `'edge'`（含 edge 且非单 token）。 */
function textHitOf(value) {
  const text = String(value)
  if (text.includes('邊款')) return 'cjk'
  if (/\bedge\b/i.test(text) && !isTokenLike(text)) return 'edge'
  return ''
}

/**
 * JS 词法单点：**一次扫描同时剥注释与抽字面量**。
 * · 注释（`//` 与 `/* *\/`）→ 换成换行（行号不漂）；
 * · 字符串 / 模板字面量 → 收集文本；模板字面量的 `${…}` 表达式**按代码递归**（其内字面量单独收）；
 * · **正则字面量**（`/…/flags`）→ 整段跳过（正则里的引号 / 反斜线不是字符串起点 —— 否则
 *   `/[\\/:*?"<>|]/g` 会被当成字符串起点，把后文整段吞成一个假字面量）。
 */
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '=', '+', '-', '*', '%', '<', '>', '~', '^'])
function scanJs(code) {
  const literals = []
  let out = ''
  let i = 0
  const n = code.length
  const regexAllowed = () => {
    let j = out.length - 1
    while (j >= 0 && /\s/.test(out[j])) j -= 1
    if (j < 0) return true
    if (REGEX_PREV.has(out[j])) return true
    const tail = out.slice(Math.max(0, j - 6), j + 1)
    return /\b(return|typeof|case|in|of|new|delete|void)$/.test(tail)
  }
  while (i < n) {
    const ch = code[i]
    if (ch === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i += 1
    } else if (ch === '/' && code[i + 1] === '*') {
      i += 2
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') out += '\n'
        i += 1
      }
      i += 2
    } else if (ch === "'" || ch === '"') {
      const quote = ch
      out += ch
      i += 1
      let acc = ''
      while (i < n) {
        if (code[i] === '\\') {
          acc += code[i + 1] === undefined ? '' : code[i + 1]
          out += code.slice(i, i + 2)
          i += 2
          continue
        }
        if (code[i] === quote) {
          out += quote
          i += 1
          break
        }
        acc += code[i]
        out += code[i]
        i += 1
      }
      literals.push(acc)
    } else if (ch === '`') {
      out += ch
      i += 1
      let acc = ''
      while (i < n) {
        if (code[i] === '\\') {
          acc += code[i + 1] === undefined ? '' : code[i + 1]
          out += code.slice(i, i + 2)
          i += 2
          continue
        }
        if (code[i] === '`') {
          out += '`'
          i += 1
          break
        }
        if (code[i] === '$' && code[i + 1] === '{') {
          let depth = 1
          let j = i + 2
          const start = j
          while (j < n && depth > 0) {
            if (code[j] === '{') depth += 1
            else if (code[j] === '}') depth -= 1
            if (depth > 0) j += 1
          }
          const inner = scanJs(code.slice(start, j))
          inner.literals.forEach((item) => literals.push(item))
          out += code.slice(i, j + 1)
          i = j + 1
          continue
        }
        acc += code[i]
        out += code[i]
        i += 1
      }
      literals.push(acc)
    } else if (ch === '/' && regexAllowed()) {
      let j = i + 1
      let inClass = false
      while (j < n) {
        const c = code[j]
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) break
        else if (c === '\n') break
        j += 1
      }
      out += code.slice(i, j + 1)
      i = j + 1
    } else {
      out += ch
      i += 1
    }
  }
  return { code: out, literals }
}

/** 只取「去注释后的代码」（正则 / 字符串原样保留）。 */
const stripJsComments = (source) => scanJs(source).code
/** 只取字面量。 */
const jsLiterals = (code) => scanJs(code).literals

/** `.vue` 按列 0 分 `<template>` / `<script>` / `<style>` 段（`<style>` 跳过）。 */
function vueSegments(source) {
  const segments = []
  let current = null
  let buffer = []
  const flush = () => {
    if (current) segments.push({ kind: current, body: buffer.join('\n') })
    buffer = []
  }
  source.split('\n').forEach((line) => {
    const trimmed = line.trim()
    const open = /^<(template|script|style)(\s[^>]*)?>$/.exec(trimmed)
    const close = /^<\/(template|script|style)>$/.exec(trimmed)
    if (open) {
      flush()
      current = open[1]
    } else if (close) {
      flush()
      current = null
    } else {
      buffer.push(line)
    }
  })
  flush()
  return segments
}

/** `template` 段抽文案：文本节点 ＋ 静态属性值（动态绑定只抽其字符串字面量）。 */
function templateLiterals(source) {
  const out = []
  let i = 0
  const n = source.length
  let text = ''
  const flushText = () => {
    const plain = text.replace(/\{\{[\s\S]*?\}\}/g, '')
    if (plain.trim()) out.push(plain)
    text = ''
  }
  while (i < n) {
    if (source[i] === '<') {
      if (source.startsWith('<!--', i)) {
        const end = source.indexOf('-->', i)
        i = end < 0 ? n : end + 3
        continue
      }
      flushText()
      let j = i + 1
      let quote = null
      while (j < n) {
        const ch = source[j]
        if (quote) {
          if (ch === quote) quote = null
        } else if (ch === '"' || ch === "'") {
          quote = ch
        } else if (ch === '>') break
        j += 1
      }
      const tag = source.slice(i + 1, j)
      const attrRe = /([:@#]?[A-Za-z0-9_\-.[\]]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
      let match = attrRe.exec(tag)
      while (match) {
        const name = match[1]
        const value = match[2] !== undefined ? match[2] : match[3]
        const dynamic = name[0] === ':' || name[0] === '@' || name[0] === '#' || name.startsWith('v-')
        if (dynamic) jsLiterals(stripJsComments(value)).forEach((item) => out.push(item))
        else out.push(value)
        match = attrRe.exec(tag)
      }
      i = j + 1
      continue
    }
    text += source[i]
    i += 1
  }
  flushText()
  return out
}

/** 单文件可见串集（`.vue` 分段；`.js` 整文件）。 */
function visibleStringsOf(rel) {
  const source = read(rel)
  if (!rel.endsWith('.vue')) return jsLiterals(stripJsComments(source))
  const out = []
  vueSegments(source).forEach((segment) => {
    if (segment.kind === 'template') out.push(...templateLiterals(segment.body))
    else if (segment.kind === 'script') out.push(...jsLiterals(stripJsComments(segment.body)))
  })
  return out
}

function listSourceFiles(dir) {
  const out = []
  const walk = (abs) => {
    readdirSync(abs).forEach((name) => {
      if (name === 'node_modules' || name === '.git') return
      const full = path.join(abs, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.js') || name.endsWith('.vue')) out.push(path.relative(ROOT, full))
    })
  }
  walk(path.join(ROOT, dir))
  return out.sort()
}

const ALLOWED_VISIBLE = [
  { file: 'src/data/seed.js', mustContain: '邊款一行，記此印為漢吉語印之同範者', why: '藏品释文正文（内容，非文案）' },
  { file: 'src/data/seed.js', mustContain: '邊款記「壬寅秋日三橋自制」', why: '藏品释文正文（内容，非文案）' },
  { file: 'src/data/seed.js', mustContain: '邊款記「龍泓山人自製」', why: '藏品释文正文（内容，非文案）' },
  { file: 'src/data/seed.js', mustContain: '邊款記內府編次', why: '藏品释文正文（内容，非文案）' },
  { file: 'src/tilesplicer/core.js', mustContain: '僅接受 FACE、EDGE 或 PHOTO', why: '本单写集外的结构性诊断文案（未登记 kind 才可达）⇒ A5 单列在册' }
]

section('A', '上屏零「邊款」零 edge（AC-749）：去注释抽可见串 ＋ 单 token 豁免 ＋ 4 条释文豁免')
const sourceFiles = listSourceFiles('src')
let literalCount = 0
const rawHits = []
sourceFiles.forEach((rel) => {
  const literals = visibleStringsOf(rel)
  literalCount += literals.length
  literals.forEach((value) => {
    const kind = textHitOf(value)
    if (kind) rawHits.push({ file: rel, kind, text: String(value).trim().slice(0, 120) })
  })
})
const allowedHit = (hit) =>
  ALLOWED_VISIBLE.some((entry) => entry.file === hit.file && hit.text.includes(entry.mustContain))
const hits = rawHits.filter((hit) => !allowedHit(hit))
console.log(JSON.stringify({ reading: 'visible-scan', files: sourceFiles.length, literals: literalCount, rawHits: rawHits.length, allowedHits: rawHits.length - hits.length }))

check('A0', `扫描面读数：src 下 .js/.vue 文件数 ≥ 70（现抽 ${sourceFiles.length}）`, true, sourceFiles.length >= 70)
check('A1', 'src/** 用户可见串**零「邊款」**（豁免 4 条藏品释文 ＋ 1 条本单外诊断文案后）', [], hits.filter((hit) => hit.kind === 'cjk').map((hit) => `${hit.file}::${hit.text}`))
check('A2', 'src/** 用户可见串**零 `edge`**（含 Edge / EDGE；单 token 内部标识 / 数据值豁免）', [], hits.filter((hit) => hit.kind === 'edge').map((hit) => `${hit.file}::${hit.text}`))

/* 豁免自证：每条 mustContain 必须**仍在场**（过期 ⇒ 报红），且释文恰 4 条。 */
const seedHits = rawHits.filter((hit) => hit.file === 'src/data/seed.js')
check('A3', '豁免自证：4 条 seed.js 释文逐条仍在场（mustContain 命中 4 / 豁免 4）', { kept: 4, allowed: 4 }, {
  kept: ALLOWED_VISIBLE.filter((entry) => entry.file === 'src/data/seed.js').filter((entry) => read(entry.file).includes(entry.mustContain)).length,
  allowed: seedHits.length
})
check('A4', '豁免条数写死：seed.js 释文命中恰 4（多一条 ⇒ 红，须显式登记）', 4, seedHits.length)
const splicerHits = rawHits.filter((hit) => hit.file === 'src/tilesplicer/core.js')
check('A5', '本单写集外残留单列在册：tilesplicer 结构性诊断文案 `僅接受 FACE、EDGE 或 PHOTO` 恰 2 处（`familyOf` / 切片入口两条同文案路径；未收口，须另开单）', 2, splicerHits.length)

/* 尺子正 / 负对照（判尺必须双向可判）。 */
check('A6', '正对照：`side edge 圖` ⇒ 必命中（含空白 + 非 CJK 也算文案）', 'edge', textHitOf('side edge 圖'))
check('A7', '正对照：`邊款圖` ⇒ 必命中', 'cjk', textHitOf('邊款圖'))
check('A8', '负对照：内部标识 / 数据值一律不命中', ['', '', '', '', ''], [
  textHitOf('edge_image_ids'),
  textHitOf('EDGE'),
  textHitOf('face-block__badge--side'),
  textHitOf('X-Xiai-Thumb-Long-Edge'),
  textHitOf('fixed-edge-ids')
])

/* ===========================================================================
   B. 显示次序 ＋ 排序单点（AC-748 / AC-750）
   =========================================================================== */
section('B', '显示次序（base 最先 → side 按 face_no 升序）＋ 排序单点（仅 sortFacesForDisplay）')
const writeFaceMode = await import(fileUrl('src/data/writeFaceMode.js'))
writeFaceMode.setWriteFaceModeOverride('local-dev')
const db = await import(fileUrl('src/data/db.js'))
const storage = await import(fileUrl('src/data/storage.js'))
const seals = await import(fileUrl('src/services/seals.js'))

const faceRow = (id, sealId, extra) =>
  Object.assign(
    {
      _id: id,
      id,
      sealId,
      stamp_id: sealId,
      kind: 'FACE',
      face_no: 0,
      face_image_id: null,
      edge_image_ids: [],
      seal_name: '',
      dynasty: '',
      seal_type: '',
      face_style: '',
      author: '',
      transcription: ''
    },
    extra || {}
  )

/* B1：1 base ＋ 2 side，**存储序乱序**、`face_no` 乱序 ⇒ base 最先、其余升序。 */
const scrambled = [
  faceRow('fb-s5', 'FLB001', { face_no: 5 }),
  faceRow('fb-s1', 'FLB001', { face_no: 1 }),
  faceRow('fb-base', 'FLB001', { face_no: 3, is_primary: true })
]
const ordered = seals.sortFacesForDisplay(scrambled)
check('B1', '排序：1 base（face_no 3）＋ 2 side（face_no 5 / 1，存储序乱序）⇒ base 最先、其余 face_no 升序', ['fb-base', 'fb-s1', 'fb-s5'], ordered.map((row) => row.id))
check('B2', '不就地改入参（入参顺序逐字不变）', ['fb-s5', 'fb-s1', 'fb-base'], scrambled.map((row) => row.id))

/* B3：`is_primary` 三真值形态（`true` / `'true'` / `1`）都判 base。 */
const truthForms = seals.sortFacesForDisplay([
  faceRow('fb-t-false', 'FLB002', { face_no: 1 }),
  faceRow('fb-t-str', 'FLB002', { face_no: 4, is_primary: 'true' }),
  faceRow('fb-t-num', 'FLB002', { face_no: 6, is_primary: 1 })
])
check('B3', '`is_primary` 真值三形态（`\'true\'` / `1`）都排到最前（判定不只看 `=== true`）', ['fb-t-str', 'fb-t-num', 'fb-t-false'], truthForms.map((row) => row.id))

/* B4：`kind='EDGE'` 行**不**因此被排到 base 前，也不被排除（§3.89.1：side face 含 EDGE）。 */
const withEdge = seals.sortFacesForDisplay([
  faceRow('fb-e1', 'FLB003', { kind: 'EDGE', face_no: 2 }),
  faceRow('fb-b1', 'FLB003', { face_no: 9, is_primary: true }),
  faceRow('fb-f1', 'FLB003', { kind: 'FACE', face_no: 4 })
])
check('B4', '`kind=\'EDGE\'` 行按 `face_no` 参与 side face 排序（不被排除、不因 EDGE 提前）', ['fb-b1', 'fb-e1', 'fb-f1'], withEdge.map((row) => row.id))

/* B5：角色 / 标签单点（`is_primary` ⇒ base；其余含 EDGE ⇒ side）。 */
check('B5', '`faceRoleOf`：`is_primary` 行 ⇒ base face，`EDGE` 行 ⇒ side face', ['base face', 'side face', 'side face'], [
  seals.faceRoleOf({ id: 'x1', is_primary: true }),
  seals.faceRoleOf({ id: 'x2', kind: 'EDGE' }),
  seals.faceRoleOf({ id: 'x3', kind: 'FACE' })
])
check('B6', '`faceLabelOn`：base / 同角色序号（side face 一 / 二），不含「印面」「邊款」字样', ['base face', 'side face 一', 'side face 二'], [
  seals.faceLabelOn(withEdge[0], withEdge),
  seals.faceLabelOn(withEdge[1], withEdge),
  seals.faceLabelOn(withEdge[2], withEdge)
])

/* B7：集成 —— `listFacesOf` 是**显示次序的唯一入口**（注入乱序行后读回）。 */
db.ensureSeed()
storage.writeKey(
  storage.STORAGE_KEYS.faces,
  [
    faceRow('fb-i-s2', 'FLB900', { face_no: 7 }),
    faceRow('fb-i-base', 'FLB900', { face_no: 2, is_primary: true }),
    faceRow('fb-i-s1', 'FLB900', { face_no: 4 })
  ].map((row) => Object.assign({}, row, { seal_name: '測試', dynasty: '清' }))
)
const listed = seals.listFacesOf('FLB900')
check('B7', '`listFacesOf` 读面即已排序：base 最先、其余 face_no 升序（id 集合恰 3 条）', ['fb-i-base', 'fb-i-s1', 'fb-i-s2'], listed.map((row) => row.id))

/* B8：静态单点 —— 全仓 `.sort(` 中**同一行前置含 face** 的只允许 `sortFacesForDisplay` 内一处。 */
const sortSites = []
const sortFiles = listSourceFiles('src')
sortFiles.forEach((rel) => {
  read(rel)
    .split('\n')
    .forEach((line, index) => {
      const at = line.indexOf('.sort(')
      if (at < 0) return
      const before = line.slice(0, at)
      if (!/face/i.test(before)) return
      sortSites.push({ file: rel, line: index + 1, code: line.trim().slice(0, 110) })
    })
})
const sealsSource = read('src/services/seals.js')
const sortFnStart = sealsSource.split('\n').findIndex((line) => line.includes('export function sortFacesForDisplay'))
const sortFnEnd = (() => {
  /* 从函数体首行起按花括号配平找结尾（够用且不依赖格式）。 */
  const lines = sealsSource.split('\n')
  let depth = 0
  let started = false
  for (let index = sortFnStart; index < lines.length; index += 1) {
    for (const ch of lines[index]) {
      if (ch === '{') {
        depth += 1
        started = true
      } else if (ch === '}') depth -= 1
    }
    if (started && depth === 0) return index + 1
  }
  return lines.length
})()
const outsideSingle = sortSites.filter((site) => !(site.file === 'src/services/seals.js' && site.line >= sortFnStart + 1 && site.line <= sortFnEnd))
check('B8', '排序单点：带 face 的 `.sort(` 仅 `src/services/seals.js::sortFacesForDisplay` 一处（视图层零二次排序）', [], outsideSingle.map((site) => `${site.file}:${site.line} ${site.code}`))
check('B9', '`sortFacesForDisplay` 全仓仅 2 处出现（定义 1 ＋ 调用 1）⇒ 排序只此一处入口', 2, (sealsSource.match(/sortFacesForDisplay\(/g) || []).length)
check('B10', '详情页面块 v-for 直接消费已排序的 `faces`（模板内零 `.sort(`）', 0, (read('src/views/SealDetailView.vue').match(/\.sort\(/g) || []).length - 1)

/* ===========================================================================
   C. 整枚印章圖（AC-751）
   =========================================================================== */
section('C', '整枚印章圖：未被任何面引用 / 按 seq 升序 / 排所有面块之后 / 零枚不渲染')
const imageRow = (id, stampId, seq, mime) =>
  Object.assign({ _id: id, id, stamp_id: stampId, seq, kind: 'FACE' }, mime ? { mime } : {})
const facesOfChapter = [
  faceRow('fc-1', 'FLC001', { face_no: 1, is_primary: true, face_image_id: 'img-ref-face' }),
  faceRow('fc-2', 'FLC001', { kind: 'EDGE', face_no: 2, face_image_id: null, edge_image_ids: ['img-ref-edge'] })
]
/* 造 2 张未被引用的章级影像：`seq` 与 `id` 的**自然升序相反**（用来分开两种排序口径）：
   `img-zzz` 的 seq ＝ 2、`img-aaa` 的 seq ＝ 9 ⇒ 「按 seq 升序」＝ [zzz, aaa]；「按 id 升序」＝ [aaa, zzz]。 */
const chapterImages = [
  imageRow('img-aaa', 'FLC001', 9),
  imageRow('img-ref-face', 'FLC001', 1),
  imageRow('img-zzz', 'FLC001', 2),
  imageRow('img-ref-edge', 'FLC001', 3)
]
const whole = seals.wholeSealImagesOf(facesOfChapter, chapterImages)
check('C1', '只回「未被任何面 `face_image_id` / `edge_image_ids` 引用」的 2 张（被引用的 2 张排除）', ['img-zzz', 'img-aaa'], whole.map((row) => row.id))
check('C2', '整枚印章圖**按 `seq` 升序**（AC-751：seq 2 的 `img-zzz` 排在 seq 9 的 `img-aaa` 之前）', ['img-zzz', 'img-aaa'], whole.map((row) => row.id))
check('C3', '不就地改入参（影像数组顺序逐字不变）', ['img-aaa', 'img-ref-face', 'img-zzz', 'img-ref-edge'], chapterImages.map((row) => row.id))
check('C4', '全部被面引用 ⇒ 回空数组（不得把被引用的也列入）', [], seals.wholeSealImagesOf(facesOfChapter, chapterImages.filter((row) => row.id.startsWith('img-ref'))))
check('C5', '零面章 ⇒ 本章影像全算整枚印章圖（无面可引用）', ['img-solo'], seals.wholeSealImagesOf([], [imageRow('img-solo', 'FLC009', 1)]).map((row) => row.id))

const detailSource = read('src/views/SealDetailView.vue')
const faceLoopAt = detailSource.indexOf('v-for="face in faces"')
const wholeSectionAt = detailSource.indexOf('data-whole-seal-images')
check('C6', '详情页「整枚印章圖」区块在面块 v-for **之后**（DOM 次序 ＝ 三层最末）', true, faceLoopAt > -1 && wholeSectionAt > faceLoopAt)
check('C7', '区块 `v-if="wholeSealImages.length"` ⇒ 零枚不渲染空壳（无 `v-else` 兜底空块）', true, /v-if="wholeSealImages\.length"/.test(detailSource) && !/v-else[^"]*data-whole-seal-images/.test(detailSource))
check('C8', '区块取图走同一套 `imageUrlOf`（不另拼对象键）：`data-whole-seal-figure` ＋ `SliceImage` 命中 ≥1', true, detailSource.includes('data-whole-seal-figure') && detailSource.includes('data-whole-seal-image'))
check('C9', '服务层单点：`listSeals` 里 `wholeSealImages: wholeSealImagesOf(` 恰 1 处（视图不自筛）', 1, (sealsSource.match(/wholeSealImages: wholeSealImagesOf\(/g) || []).length)

/* ===========================================================================
   D. 上传三选一（AC-752）
   =========================================================================== */
section('D', '上传三选一：base 禁用文案逐字 / side 默认 / 整章图不建面不写 face_count')
const dialogSource = read('src/components/AddSealFaceDialog.vue')
const DISABLED_HINT = '本章已有主印面，請改選 side face'
check('D1', `base face 禁用说明**逐字**「${DISABLED_HINT}」在弹窗恰 1 处`, 1, (dialogSource.match(new RegExp(DISABLED_HINT, 'g')) || []).length)
check('D2', '禁用条件绑在 `hasBaseFace` prop 上（`modeDisabled` 判 `props.hasBaseFace`）且 `:disabled` 同源', true, /props\.hasBaseFace/.test(dialogSource) && dialogSource.includes(':disabled="submitting || modeDisabled(option.value)"'))
check('D3', '三选一取值逐字：base face / side face / 整枚印章圖（选项恒 3 项）', ['base face', 'side face', '整枚印章圖'], (dialogSource.match(/label: (seals\.FACE_ROLE_[A-Z]+|'[^']*')/g) || []).map((item) => item.replace(/^label: /, '').replace(/^'|'$/g, '').replace('seals.FACE_ROLE_BASE', 'base face').replace('seals.FACE_ROLE_SIDE', 'side face')))
check('D4', '默认选项 ＝ side face（`const mode = ref(UPLOAD_MODE_SIDE)`）', true, /const mode = ref\(UPLOAD_MODE_SIDE\)/.test(dialogSource))
check('D5', '弹窗不再暴露 `EDGE`：`FACE_KIND.EDGE` 与 `\'EDGE\'` 命中 0（后端分支保留、UI 不出现）', 0, (dialogSource.match(/FACE_KIND\.EDGE|'EDGE'|"EDGE"/g) || []).length)
check('D6', '提交分流：整章图走 `seals.registerWholeSealImage(`，面走 `seals.addSealFace(`（两分支都在场）', true, dialogSource.includes('mode.value === UPLOAD_MODE_SEAL') && dialogSource.includes('seals.registerWholeSealImage(') && dialogSource.includes('seals.addSealFace('))
check('D7', '详情页把 `:has-base-face="sealHasBaseFace"` 传给弹窗（禁用判据来自本章面集合）', true, detailSource.includes(':has-base-face="sealHasBaseFace"') && /sealHasBaseFace = computed\(/.test(detailSource))

/* `registerWholeSealImage` 函数体：**不调 `addSealFace`**、**不写 `face_count` / `face_no`**。 */
/** 从函数签名取函数体（跨过形参里的 `{}` 默认值，按花括号配平找结尾）。 */
function functionBodyOf(source, signature) {
  const at = source.indexOf(signature)
  if (at < 0) return ''
  const parenClose = source.indexOf(')', source.indexOf('(', at))
  const bodyStart = source.indexOf('{', parenClose)
  if (bodyStart < 0) return ''
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(bodyStart, index + 1)
    }
  }
  return ''
}
const wholeFnBody = functionBodyOf(sealsSource, 'export async function registerWholeSealImage')
const wholeFnCode = scanJs(wholeFnBody).code
check('D8', '`registerWholeSealImage` 在册（函数体非空，长度 > 800 字符）', true, wholeFnBody.length > 800)
check('D9', '整章图路径**不调 `addSealFace`**（函数体去注释后命中 0）', 0, (wholeFnCode.match(/addSealFace\s*\(/g) || []).length)
check('D10', '整章图路径**不写 `face_count` / `face_no`**（函数体去注释后命中 0，面行数不变）', { faceCount: 0, faceNo: 0 }, {
  faceCount: (wholeFnCode.match(/face_count/g) || []).length,
  faceNo: (wholeFnCode.match(/face_no/g) || []).length
})
check('D11', '整章图入册走**既有 op** `registerFaceImage`（零新增 op；函数体内引用 `FACE_IMAGE_REGISTER_OP`）', true, wholeFnCode.includes('FACE_IMAGE_REGISTER_OP'))

/* ===========================================================================
   E. `kind` 数据值未改（零迁移）
   =========================================================================== */
section('E', 'kind 数据值未改：FACE_KIND 仍 FACE / EDGE，代码仍接受 EDGE')
check('E1', '`FACE_KIND` 数据值逐字未改', { FACE: 'FACE', EDGE: 'EDGE' }, { FACE: seals.FACE_KIND.FACE, EDGE: seals.FACE_KIND.EDGE })
check('E2', '`FACE_ADD_ALLOWED_KINDS` 仍含 `FACE_KIND.EDGE`（后端兼容分支保留，不删数据值）', true, sealsSource.includes('export const FACE_ADD_ALLOWED_KINDS = Object.freeze([FACE_KIND.FACE, FACE_KIND.EDGE])'))
check('E3', '服务端 `addSealFace` 仍接受 `EDGE`（`lib/addSealFace.js` 内 `EDGE` 命中 ≥1）', true, (read('cloudfunctions/xiai-user-token/lib/addSealFace.js').match(/'EDGE'/g) || []).length >= 1)
check('E4', '`kind` 数据值在消费方仍被识别（5 个文件仍引用 EDGE）', ['src/services/seals.js', 'src/services/imageFaces.js', 'src/services/sealCards.js', 'src/tilesplicer/core.js', 'src/views/SealDetailView.vue'], ['src/services/seals.js', 'src/services/imageFaces.js', 'src/services/sealCards.js', 'src/tilesplicer/core.js', 'src/views/SealDetailView.vue'].filter((file) => read(file).includes('EDGE')))
check('E5', '零迁移：本单未出现把 `EDGE` 改写成 `FACE` 的数据写入（`src/services/seals.js` 内 `kind: FACE_KIND.FACE` 只出现在新面 / 分支常量，`EDGE` 行改写命中 0）', 0, (sealsSource.match(/kind\s*=\s*FACE_KIND\.FACE/g) || []).length)

/* ===========================================================================
   F. `[data-admin-action]` 仍恰 12 值且逐字等于改前（f4a90ed）
   ---------------------------------------------------------------------------
   改前读数（质检时用 `git grep -h -o 'data-admin-action="[a-z-]*"' f4a90ed -- src/ | sort -u`
   现取，恰 12 值）与 HEAD 逐字相同 ⇒ 这里把该 12 值**写死**作冻结表（套件不依赖 git）。
   =========================================================================== */
section('F', '[data-admin-action] 仍恰 12 值且逐字等于改前（f4a90ed 冻结表）')
const FROZEN_ADMIN_ACTIONS = [
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
const adminActions = new Set()
listSourceFiles('src').forEach((rel) => {
  for (const hit of read(rel).matchAll(/data-admin-action="([a-z-]+)"/g)) adminActions.add(hit[1])
})
check('F1', '`[data-admin-action]` 取值集合**逐字等于改前 12 值**（禁扩、禁改字面）', FROZEN_ADMIN_ACTIONS, [...adminActions].sort())
check('F2', '取值**恰 12 值**', 12, adminActions.size)
check('F3', '每个冻结值在 `src/**` 命中 ≥1（防拼写漂移 / 防只删不报）', 12, FROZEN_ADMIN_ACTIONS.filter((value) => adminActions.has(value)).length)
/* 负对照：多加一个值 ⇒ 集合必变（尺子会响，不是恒等断言）。 */
const negative = new Set(adminActions)
negative.add('face-layer-probe')
check('F4', '负对照：注入 `face-layer-probe` ⇒ 集合变 13、与冻结表不等（尺子会响）', { count: 13, equals: false }, { count: negative.size, equals: JSON.stringify([...negative].sort()) === JSON.stringify(FROZEN_ADMIN_ACTIONS) })

/* ===========================================================================
   G. 规范锚点在册（§3.89 ＋ §10.96 AC-748〜753）
   =========================================================================== */
section('G', '规范锚点在册：§3.89 / §3.89.1〜6 / §10.96 / AC-748〜753 各恰 1 条')
const spec = read('docs/xiai.spec.md')
check('G1', '§3.89 在册（`### 3.89` 恰 1 处）', 1, (spec.match(/^### 3\.89[ 　]/gm) || []).length)
check('G2', '§3.89.1 〜 §3.89.6 六个子节在册（`#### 3.89.N`）', 6, [1, 2, 3, 4, 5, 6].filter((n) => new RegExp(`^#### 3\\.89\\.${n}[ 　]`, 'm').test(spec)).length)
check('G3', '§10.96 在册（`### 10.96` 恰 1 处）', 1, (spec.match(/^### 10\.96[ 　]/gm) || []).length)
const acRows = (id) => (spec.match(new RegExp(`^\\| \\*\\*${id}\\*\\* \\|`, 'gm')) || []).length
check('G4', '`AC-748` 〜 `AC-753` 各恰 1 条判据行（共 6 条）', { 748: 1, 749: 1, 750: 1, 751: 1, 752: 1, 753: 1 }, {
  748: acRows('AC-748'),
  749: acRows('AC-749'),
  750: acRows('AC-750'),
  751: acRows('AC-751'),
  752: acRows('AC-752'),
  753: acRows('AC-753')
})
check('G5', '§3.88.4 / §3.88.6 追加注（v1.112）在册（各 1 处、行首锚定）', 2, (spec.match(/^\*\*§3\.88\.(4|6) 追加注（v1\.112/gm) || []).length)

/* ===========================================================================
   H. 三新 op 行为面（v1.113：`ADMIN_OPS` 41 → 44）
   ---------------------------------------------------------------------------
   题目：`docs/face-layer-ruling-v2-2026-11-14.md`（1B / 2C / 3B）；实现单点
   `cloudfunctions/xiai-user-token/lib/faceLayerOps.js`（`lib/ops.js` 里那三处是薄委派）。

   **本段的判尺（逐条；实现改了就得红）**
   · `migrateEdgeFaces`
     H1 回包**恒恰 7 键**（`dry_run` 与真写同形）；
     H2 `dry_run` **缺省为 true**（不写、面行零改、章 `face_count` 不动）；
     H3 `dry_run` 也给 `samples`（≤5、元素恰 3 键、`moved_image_id` ＝ 原 `edge_image_ids[0]`）；
     H4 窗口读数：`scanned / eligible / next_cursor`（＝ 本窗口最后一条被扫描行的 `_id`）；
     H5 真写四键生效（`kind` / `face_image_id` / `edge_image_ids` / `is_primary`），其余键一字不动；
     H6 章 `face_count` **按 FACE 行重算**（1 base ＋ 1 已迁 ＝ 2；**不是**盲目 +1、也不是旧值）；
     H7 真写回包同形 ＋ 计数如实（1/1/1、`failed` 空）；
     H8 重放 ⇒ 无 EDGE 行 ⇒ 0/0/0 ＋ `next_cursor` 空串（幂等，不重复搬图）。
   · `deleteWholeSealImage`
     H9 未引用 ⇒ 可删（恰 4 键、`deleted_rows` 1、`deleted_objects` 1，行与对象都真删掉）；
     H10 被 `face_image_id` 引用 ⇒ `INVALID_VALUE`，行与对象**均不变**（零删）；
     H11 被 `edge_image_ids` 引用 ⇒ 同上（夹具造 EDGE 行 —— 真实库已无 EDGE 行）。
   · `setBaseFace`
     H12 切到第二面 ⇒ 原 base `false`、目标 `true`、章内**仍恰一枚**、两次写；
     H13 同参重放 ⇒ **零写** 且 `previous_base_face_id` ＝ 目标（幂等）；
     H14 非 `FACE` 行 ⇒ `INVALID_VALUE` ＋ 零写 ＋ base 不变。

   夹具说明：`EDGE` 行**只在夹具里造**（迁移后真实库已无 `EDGE`）；三个 op 均经
   `ops.ADMIN_OPS` 调用（不绕过注册面），注入缝只用 `setOpsDbProvider` ＋
   `setOpsStorageDeleteProvider`，段末一律卸掉（不留全局污染）。
   =========================================================================== */
section('H', '三新 op 行为面：migrateEdgeFaces（dry_run 缺省 / 真写 / face_count 重算 / 幂等）＋ deleteWholeSealImage（可删 / 两类引用必拒）＋ setBaseFace（切换 / 幂等 / 非 FACE 必拒）')

const nodeRequire = createRequire(import.meta.url)
const OPS_MODULE = nodeRequire(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))
const LAYER_OPS = nodeRequire(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/faceLayerOps.js'))

const LAYER_ADMIN_PHONE = '13800000000'
const LAYER_OTHER_PHONE = '13900000009'
const LAYER_CONTEXT = { adminPhone: LAYER_ADMIN_PHONE, nowSeconds: 1762000000 }
const LAYER_ADMIN = { uid: 'u-layer-admin', phone: LAYER_ADMIN_PHONE, role: 'user', identity_source: 'SERVER_TOKEN' }
const LAYER_OTHER = { uid: 'u-layer-other', phone: LAYER_OTHER_PHONE, role: 'user', identity_source: 'SERVER_TOKEN' }

/* 注入式内存假 DB（与 `verify-direct-write` / `verify-ai-enhance-discard` 同形：无 `db.command`
   ⇒ `readAscendingWindowOf` 走「整桶取回 ＋ 内存收口」退路，窗口语义仍由 ops.js 单点实现）。 */
function createLayerStore(seedRows) {
  const collections = new Map()
  const writes = []
  const mapOf = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  const allOf = (name) => [...mapOf(name).values()].map((row) => Object.assign({}, row))
  const hitOf = (name, match) =>
    allOf(name).filter((row) =>
      Object.keys(match || {}).every((key) => String(row[key]) === String(match[key]))
    )
  ;(seedRows || []).forEach((row) => {
    const copy = Object.assign({}, row)
    const name = copy.__collection
    delete copy.__collection
    const key = String(copy._id || copy.id)
    mapOf(name).set(key, Object.assign({ _id: key }, copy))
  })
  const provider = () => ({
    collection(name) {
      return {
        where(match) {
          let limit = 0
          const api = {
            limit(n) {
              limit = Math.floor(Number(n)) || 0
              return api
            },
            async get() {
              const rows = hitOf(name, match)
              return { data: limit > 0 ? rows.slice(0, limit) : rows }
            },
            async update(doc) {
              const rows = hitOf(name, match)
              rows.forEach((row) => {
                const key = String(row._id || row.id)
                mapOf(name).set(key, Object.assign({}, mapOf(name).get(key), doc))
              })
              writes.push({ collection: name, kind: 'update', match, doc, count: rows.length })
              return { updated: rows.length }
            }
          }
          return api
        },
        async get() {
          return { data: allOf(name) }
        },
        doc(id) {
          const key = String(id)
          return {
            async get() {
              const row = mapOf(name).get(key)
              return { data: row ? [Object.assign({}, row)] : [] }
            },
            async set(doc) {
              mapOf(name).set(key, Object.assign({ _id: key }, doc))
              writes.push({ collection: name, kind: 'set', id: key })
              return { updated: 1 }
            },
            async delete() {
              const had = mapOf(name).has(key)
              mapOf(name).delete(key)
              writes.push({ collection: name, kind: 'delete', id: key, had })
              return { deleted: had ? 1 : 0 }
            }
          }
        },
        async add(doc) {
          const key = String(doc && doc._id ? doc._id : `auto-${mapOf(name).size + 1}`)
          mapOf(name).set(key, Object.assign({ _id: key }, doc))
          writes.push({ collection: name, kind: 'add', id: key })
          return { id: key }
        }
      }
    }
  })
  return {
    provider,
    writes,
    rows: (name) => allOf(name),
    rowOf: (name, id) => allOf(name).find((row) => String(row._id) === String(id)) || null,
    keySet: (name, id) => {
      const row = allOf(name).find((item) => String(item._id) === String(id))
      return row ? Object.keys(row).sort() : null
    }
  }
}

/* 假对象删除缝：只认「登记过的键」⇒ 删成功计一件；未登记 ⇒ 抛错（模拟对象不存在，
   `deleteImageObjectsOfRow` 不抛、如实回 0 ⇒ 回包 `deleted_objects` 的判负非空转）。 */
const objectDeletes = []
let liveObjects = new Set()
const resetObjects = (keys) => {
  objectDeletes.length = 0
  liveObjects = new Set(keys)
}
OPS_MODULE.setOpsStorageDeleteProvider(async (cloudPath) => {
  const key = String(cloudPath)
  if (!liveObjects.has(key)) throw new Error('OBJECT_NOT_FOUND')
  liveObjects.delete(key)
  objectDeletes.push(key)
})

const objectKeyOf = (tag) => `xiai/images/${tag.slice(0, 2)}/${tag.repeat(64).slice(0, 64)}.png`

/* ---------------------------------------------------------------------------
   H-A｜migrateEdgeFaces
   --------------------------------------------------------------------------- */
{
  const EDGE_IMG = 'img-edge-m1'
  const BASE_IMG = 'img-base-m1'
  const migrateStore = createLayerStore([
    { __collection: 'xiai_seals', _id: 'seal-m1', stamp_id: 'S-M1', sid: 'S-M1', face_count: 7 },
    {
      __collection: 'xiai_faces',
      _id: 'fc-S-M1-001',
      id: 'fc-S-M1-001',
      sealId: 'S-M1',
      kind: 'FACE',
      is_primary: true,
      face_no: 1,
      fid: 'F-M-1',
      face_image_id: BASE_IMG,
      edge_image_ids: []
    },
    {
      __collection: 'xiai_faces',
      _id: 'fc-S-M1-002',
      id: 'fc-S-M1-002',
      sealId: 'S-M1',
      kind: 'EDGE',
      is_primary: false,
      face_no: 2,
      fid: 'F-M-2',
      edge_image_ids: [EDGE_IMG]
    }
  ])
  OPS_MODULE.setOpsDbProvider(migrateStore.provider)
  resetObjects([])

  /* 管理员门（正 / 负对照）：非白名单手机号 ⇒ FORBIDDEN ＋ 零写。 */
  const denied = await OPS_MODULE.ADMIN_OPS.migrateEdgeFaces({}, LAYER_OTHER, LAYER_CONTEXT)
  check('H0', '管理员门（负对照）：非白名单手机号 ⇒ `FORBIDDEN` ＋ 零写（迁移不因自检而放行）', { ok: false, reason: 'FORBIDDEN', writes: 0 }, {
    ok: denied.ok,
    reason: denied.reason,
    writes: migrateStore.writes.length
  })

  const dry = await OPS_MODULE.ADMIN_OPS.migrateEdgeFaces({}, LAYER_ADMIN, LAYER_CONTEXT)
  check('H1', '`migrateEdgeFaces` 回包（`dry_run` 缺省）**恰 7 键**且逐字 ＝ `MIGRATE_EDGE_FACES_READOUT_KEYS`（`dry_run` 与真写同形）', LAYER_OPS.MIGRATE_EDGE_FACES_READOUT_KEYS.slice().sort(), Object.keys(dry).sort())

  const dryRow = migrateStore.rowOf('xiai_faces', 'fc-S-M1-002')
  check('H2', '`dry_run` **缺省为 true**：`written` 恒 0、面行零改（`kind` 仍 `EDGE`、`face_image_id` 未设、`edge_image_ids` 逐字）、章 `face_count` 仍 7', {
    written: 0,
    kind: 'EDGE',
    faceImageId: '',
    edgeIds: [EDGE_IMG],
    faceCount: 7
  }, {
    written: dry.written,
    kind: dryRow.kind,
    faceImageId: String(dryRow.face_image_id === undefined || dryRow.face_image_id === null ? '' : dryRow.face_image_id),
    edgeIds: dryRow.edge_image_ids,
    faceCount: migrateStore.rowOf('xiai_seals', 'seal-m1').face_count
  })

  check('H3', '`dry_run` 也给 `samples`（≤5、元素恰 3 键、`moved_image_id` 逐字 ＝ 面行原 `edge_image_ids[0]`、`seal_id` 逐字）', [
    { row_id: 'fc-S-M1-002', seal_id: 'S-M1', moved_image_id: EDGE_IMG }
  ], dry.samples)

  check('H4', '窗口读数：`scanned` ＝ `eligible` ＝ 1、`failed` 空、`next_cursor` ＝ 本窗口最后一条被扫描行 `_id`', {
    scanned: 1,
    eligible: 1,
    failed: [],
    nextCursor: 'fc-S-M1-002'
  }, {
    scanned: dry.scanned,
    eligible: dry.eligible,
    failed: dry.failed,
    nextCursor: dry.next_cursor
  })

  const keysBefore = migrateStore.keySet('xiai_faces', 'fc-S-M1-002')
  const real = await OPS_MODULE.ADMIN_OPS.migrateEdgeFaces({ dry_run: false }, LAYER_ADMIN, LAYER_CONTEXT)
  const migrated = migrateStore.rowOf('xiai_faces', 'fc-S-M1-002')
  /* 键面口径：写体**只这 4 个键** ⇒ 迁移后键面只允许**新增** `face_image_id`（原 EDGE 行没有该键），
     不得删除任何既有键、不得新增其它键（`updated_at` / `fid` / `face_no` 一律不碰）。 */
  const keysAfter = migrateStore.keySet('xiai_faces', 'fc-S-M1-002')
  check('H5', '真写：面行四键生效（`kind` ＝ `FACE`／`face_image_id` 已搬／`edge_image_ids` ＝ `[]`／`is_primary` ＝ false），键面只新增 `face_image_id`（零删键、零其它新键），`fid` / `face_no` / 行 id 一字未动', {
    kind: 'FACE',
    faceImageId: EDGE_IMG,
    edgeIds: [],
    isPrimary: false,
    fid: 'F-M-2',
    faceNo: 2,
    id: 'fc-S-M1-002',
    addedKeys: ['face_image_id'],
    removedKeys: []
  }, {
    kind: migrated.kind,
    faceImageId: migrated.face_image_id,
    edgeIds: migrated.edge_image_ids,
    isPrimary: migrated.is_primary,
    fid: migrated.fid,
    faceNo: migrated.face_no,
    id: migrated._id,
    addedKeys: keysAfter.filter((key) => keysBefore.indexOf(key) === -1),
    removedKeys: keysBefore.filter((key) => keysAfter.indexOf(key) === -1)
  })

  check('H6', '真写后该章 `face_count` **按 FACE 行重算** ＝ 2（1 base FACE ＋ 1 已迁 EDGE）；**不是**盲目 +1 的 8、也不是旧值 7', 2, migrateStore.rowOf('xiai_seals', 'seal-m1').face_count)

  check('H7', '真写回包同形（恰 7 键）且计数如实：`scanned` / `eligible` / `written` ＝ 1/1/1、`failed` 空', {
    keys: LAYER_OPS.MIGRATE_EDGE_FACES_READOUT_KEYS.slice().sort(),
    scanned: 1,
    eligible: 1,
    written: 1,
    failed: []
  }, {
    keys: Object.keys(real).sort(),
    scanned: real.scanned,
    eligible: real.eligible,
    written: real.written,
    failed: real.failed
  })

  const replay = await OPS_MODULE.ADMIN_OPS.migrateEdgeFaces({}, LAYER_ADMIN, LAYER_CONTEXT)
  check('H8', '重放（`dry_run` 缺省）：无 EDGE 行 ⇒ `scanned 0 / eligible 0 / written 0`、`next_cursor` 空串（幂等，不重复搬图）', {
    scanned: 0,
    eligible: 0,
    written: 0,
    nextCursor: ''
  }, {
    scanned: replay.scanned,
    eligible: replay.eligible,
    written: replay.written,
    nextCursor: replay.next_cursor
  })
}

/* ---------------------------------------------------------------------------
   H-B｜deleteWholeSealImage
   --------------------------------------------------------------------------- */
{
  const FREE_KEY = objectKeyOf('aa')
  const FACE_REF_KEY = objectKeyOf('bb')
  const EDGE_REF_KEY = objectKeyOf('cc')
  const deleteStore = createLayerStore([
    { __collection: 'xiai_images', _id: 'img-free-d1', id: 'img-free-d1', stamp_id: 'S-D1', storage_key: FREE_KEY },
    { __collection: 'xiai_images', _id: 'img-face-d2', id: 'img-face-d2', stamp_id: 'S-D2', storage_key: FACE_REF_KEY },
    { __collection: 'xiai_images', _id: 'img-edge-d3', id: 'img-edge-d3', stamp_id: 'S-D3', storage_key: EDGE_REF_KEY },
    {
      __collection: 'xiai_faces',
      _id: 'fc-S-D2-001',
      id: 'fc-S-D2-001',
      sealId: 'S-D2',
      kind: 'FACE',
      is_primary: true,
      face_image_id: 'img-face-d2',
      edge_image_ids: []
    },
    {
      __collection: 'xiai_faces',
      _id: 'fc-S-D3-001',
      id: 'fc-S-D3-001',
      sealId: 'S-D3',
      kind: 'EDGE',
      is_primary: false,
      edge_image_ids: ['img-edge-d3']
    }
  ])
  OPS_MODULE.setOpsDbProvider(deleteStore.provider)
  resetObjects([FREE_KEY, FACE_REF_KEY, EDGE_REF_KEY])

  const freeReply = await OPS_MODULE.ADMIN_OPS.deleteWholeSealImage({ stamp_id: 'S-D1', image_id: 'img-free-d1' }, LAYER_ADMIN, LAYER_CONTEXT)
  check('H9', '未引用可删：回包**恰 4 键**（`ok / image_id / deleted_rows / deleted_objects`）、`deleted_rows` 1、`deleted_objects` 1（对象经注入缝实删一件）、影像行已不在', {
    keys: LAYER_OPS.DELETE_WHOLE_SEAL_IMAGE_READOUT_KEYS.slice().sort(),
    ok: true,
    imageId: 'img-free-d1',
    deletedRows: 1,
    deletedObjects: 1,
    rowGone: true,
    objects: [FREE_KEY]
  }, {
    keys: Object.keys(freeReply).sort(),
    ok: freeReply.ok,
    imageId: freeReply.image_id,
    deletedRows: freeReply.deleted_rows,
    deletedObjects: freeReply.deleted_objects,
    rowGone: deleteStore.rowOf('xiai_images', 'img-free-d1') === null,
    objects: objectDeletes.slice()
  })

  const writesBeforeFaceRef = deleteStore.writes.length
  const objsBeforeFaceRef = objectDeletes.length
  const faceRefReply = await OPS_MODULE.ADMIN_OPS.deleteWholeSealImage({ stamp_id: 'S-D2', image_id: 'img-face-d2' }, LAYER_ADMIN, LAYER_CONTEXT)
  check('H10', '被 `face_image_id` 引用 ⇒ `INVALID_VALUE` 且行与对象**均不变**（零删行、零删对象）', {
    ok: false,
    reason: 'INVALID_VALUE',
    rowStill: true,
    objectStill: true,
    writes: 0,
    objectsDeleted: 0
  }, {
    ok: faceRefReply.ok,
    reason: faceRefReply.reason,
    rowStill: deleteStore.rowOf('xiai_images', 'img-face-d2') !== null,
    objectStill: liveObjects.has(FACE_REF_KEY),
    writes: deleteStore.writes.length - writesBeforeFaceRef,
    objectsDeleted: objectDeletes.length - objsBeforeFaceRef
  })

  const writesBeforeEdgeRef = deleteStore.writes.length
  const objsBeforeEdgeRef = objectDeletes.length
  const edgeRefReply = await OPS_MODULE.ADMIN_OPS.deleteWholeSealImage({ stamp_id: 'S-D3', image_id: 'img-edge-d3' }, LAYER_ADMIN, LAYER_CONTEXT)
  check('H11', '被 `edge_image_ids` 引用（夹具造 `EDGE` 行）⇒ `INVALID_VALUE` 且行与对象**均不变**（零删行、零删对象）', {
    ok: false,
    reason: 'INVALID_VALUE',
    rowStill: true,
    objectStill: true,
    writes: 0,
    objectsDeleted: 0
  }, {
    ok: edgeRefReply.ok,
    reason: edgeRefReply.reason,
    rowStill: deleteStore.rowOf('xiai_images', 'img-edge-d3') !== null,
    objectStill: liveObjects.has(EDGE_REF_KEY),
    writes: deleteStore.writes.length - writesBeforeEdgeRef,
    objectsDeleted: objectDeletes.length - objsBeforeEdgeRef
  })
}

/* ---------------------------------------------------------------------------
   H-C｜setBaseFace
   --------------------------------------------------------------------------- */
{
  const baseStore = createLayerStore([
    { __collection: 'xiai_seals', _id: 'seal-s1', stamp_id: 'S-S1', sid: 'S-S1', face_count: 3 },
    {
      __collection: 'xiai_faces',
      _id: 'fc-S-S1-001',
      id: 'fc-S-S1-001',
      sealId: 'S-S1',
      kind: 'FACE',
      is_primary: true,
      face_no: 1,
      face_image_id: 'img-s1-a'
    },
    {
      __collection: 'xiai_faces',
      _id: 'fc-S-S1-002',
      id: 'fc-S-S1-002',
      sealId: 'S-S1',
      kind: 'FACE',
      is_primary: false,
      face_no: 2,
      face_image_id: 'img-s1-b'
    },
    {
      __collection: 'xiai_faces',
      _id: 'fc-S-S1-003',
      id: 'fc-S-S1-003',
      sealId: 'S-S1',
      kind: 'EDGE',
      is_primary: false,
      face_no: 3,
      edge_image_ids: ['img-s1-c']
    }
  ])
  OPS_MODULE.setOpsDbProvider(baseStore.provider)
  resetObjects([])
  const baseIds = () =>
    baseStore
      .rows('xiai_faces')
      .filter((row) => row.is_primary === true)
      .map((row) => String(row._id))
      .sort()

  const switchWritesBefore = baseStore.writes.length
  const switched = await OPS_MODULE.ADMIN_OPS.setBaseFace({ stamp_id: 'S-S1', face_id: 'fc-S-S1-002' }, LAYER_ADMIN, LAYER_CONTEXT)
  check('H12', '切到第二面：回包**恰 3 键**（`ok / face_id / previous_base_face_id`）、`previous_base_face_id` ＝ 原 base、原 base 落 `false`、目标 `true`、章内 base **仍恰一枚**、两次写（先关旧再开新）', {
    keys: LAYER_OPS.SET_BASE_FACE_READOUT_KEYS.slice().sort(),
    ok: true,
    faceId: 'fc-S-S1-002',
    previous: 'fc-S-S1-001',
    baseIds: ['fc-S-S1-002'],
    oldIsPrimary: false,
    writes: 2
  }, {
    keys: Object.keys(switched).sort(),
    ok: switched.ok,
    faceId: switched.face_id,
    previous: switched.previous_base_face_id,
    baseIds: baseIds(),
    oldIsPrimary: baseStore.rowOf('xiai_faces', 'fc-S-S1-001').is_primary,
    writes: baseStore.writes.length - switchWritesBefore
  })

  const replayWritesBefore = baseStore.writes.length
  const replayBase = await OPS_MODULE.ADMIN_OPS.setBaseFace({ stamp_id: 'S-S1', face_id: 'fc-S-S1-002' }, LAYER_ADMIN, LAYER_CONTEXT)
  check('H13', '同参重放（目标已是 base）⇒ **零写** 且 `previous_base_face_id` ＝ 目标（幂等；不产生第二次切换）', {
    writes: 0,
    previous: 'fc-S-S1-002',
    baseIds: ['fc-S-S1-002']
  }, {
    writes: baseStore.writes.length - replayWritesBefore,
    previous: replayBase.previous_base_face_id,
    baseIds: baseIds()
  })

  const nonFaceWritesBefore = baseStore.writes.length
  const nonFaceReply = await OPS_MODULE.ADMIN_OPS.setBaseFace({ stamp_id: 'S-S1', face_id: 'fc-S-S1-003' }, LAYER_ADMIN, LAYER_CONTEXT)
  check('H14', '非 `FACE` 行（`kind` ＝ `EDGE`）⇒ `INVALID_VALUE` ＋ 零写 ＋ base 面不变', {
    ok: false,
    reason: 'INVALID_VALUE',
    writes: 0,
    baseIds: ['fc-S-S1-002']
  }, {
    ok: nonFaceReply.ok,
    reason: nonFaceReply.reason,
    writes: baseStore.writes.length - nonFaceWritesBefore,
    baseIds: baseIds()
  })
}

/* 静态门（H15）：实现点不得自建集合句柄 —— `collection(` 字面在 `lib/**` 下只允许命中
   `ops.js`（唯一持久化路径）与 `sealCards.js`（前单遗留、逐字未改）。新 op 侧
   `lib/faceLayerOps.js` 必须**零命中**（全经 `ops.readRows` / `ops.persist` / `ops.deleteRow`）。
   判定写死为「命中文件名集合**恰为**这两个」：多一个文件即红，少一个也红（防只删不报）。 */
{
  const LIB_DIR = 'cloudfunctions/xiai-user-token/lib'
  const libFiles = readdirSync(path.join(ROOT, LIB_DIR)).filter((name) => name.endsWith('.js'))
  const strippedHits = libFiles
    .filter((name) => stripJsComments(readFileSync(path.join(ROOT, LIB_DIR, name), 'utf8')).includes('collection('))
    .sort()
  const rawHits = libFiles
    .filter((name) => readFileSync(path.join(ROOT, LIB_DIR, name), 'utf8').includes('collection('))
    .sort()
  check('H15', '静态门：`lib/**` 下 `collection(` 字面（去注释 / 原文两读一致）命中文件名集合**恰为** `ops.js` / `sealCards.js`（`faceLayerOps.js` 零命中 ⇒ 三新 op 全经 `ops.*` 单点，零第二套集合句柄）', {
    stripped: ['ops.js', 'sealCards.js'],
    raw: ['ops.js', 'sealCards.js'],
    newOpsFileClean: true
  }, {
    stripped: strippedHits,
    raw: rawHits,
    newOpsFileClean: strippedHits.indexOf('faceLayerOps.js') === -1 && rawHits.indexOf('faceLayerOps.js') === -1
  })
}

/* 卸掉注入缝（不留全局污染；后续段 / 进程复用不继承假 DB）。 */
OPS_MODULE.setOpsDbProvider(null)
OPS_MODULE.setOpsStorageDeleteProvider(null)

/* ---------------------------------------------------------------------------
   汇总
   --------------------------------------------------------------------------- */
const failedIds = results.filter((item) => !item.pass).map((item) => item.id)
console.log(JSON.stringify({ summary: { total: results.length, passed: results.length - failedIds.length, failed: failedIds.length }, failed_ids: failedIds }))
process.exit(failedIds.length === 0 ? 0 : 1)
