#!/usr/bin/env node
/**
 * 玺爱 · **角色文案（繁体）＋ 单一映射** 自检
 * =====================================================================
 * 覆盖（Kevin 裁定，2026-11-18）：
 *   · `admin`     ⇒ 掌書記使
 *   · `sub-admin` ⇒ 掌書記
 *
 * 铁律逐条落成断言：
 *   ① **只改展示文案**：内部角色值仍是 `admin` / `sub-admin`（权限判定一字不动）；
 *   ② **全仓单一真源**：`src/data/roleLabels.js` 导出 `ROLE_LABEL` / `roleLabel()`，
 *      两串**只在该文件出现一次**，其余展示处一律插值取值；
 *   ③ **繁体上屏**：`掌書記` / `掌書記使`（`書`，非 `书`），且不带书名号 / 方括号；
 *   ④ `src/**` 里**不得再留**未过映射的用户可见「管理員 / 管理员」字样。
 *
 * 扫描口径（照本仓既有套件）：
 *   · **先剥注释再判**：`.vue` 剥 `<!-- -->`（模板）＋ script 段 `//` `/* *\/`；
 *     `.js` 剥 `//` `/* *\/`；`.css` 剥 `/* *\/`。剥除器**引号感知**
 *     （' " ` 内不剥），否则一个字面量里的 `/*` 会把文件尾巴吃掉。
 *   · 只读 `src/**`，零网络、零浏览器、零生产读写。
 *
 * 判据分段：
 *   A 映射面：两值正确、键面恰 2、繁体、无书名号、`roleLabel()` 与回落语义；
 *   B 单一真源：`ROLE_LABEL` 恰 1 处定义；两串只在 `roleLabels.js` 出现；展示处均经映射；
 *   C 残留面：`src/**` 剥注释后零「管理員」零「管理员」（逐文件点名，缺一即红）；
 *   D 内部值不变：角色值 / 判定字面量仍是 `admin` / `sub-admin`，映射键与之逐字相同；
 *   E 变异负对照：判据必须会响（只在内存副本上做，不写被测件）。
 */
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const SRC = path.join(ROOT, 'src')
const LABELS_REL = 'src/data/roleLabels.js'
const LABELS_ABS = path.join(ROOT, LABELS_REL)

/* ---------------------------------------------------------------- 断言骨架 */
const results = []
let failures = 0
const sectionStats = {}
let currentSection = 'A'

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
const countOf = (text, needle) => text.split(needle).length - 1

/* ------------------------------------------------------- 剥注释（引号感知） */
/** 剥 JS 段注释：字符串（' " `）内的 `//` `/*` 不剥。 */
function stripJsComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i)
      i = j < 0 ? n : j
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2)
      const end = j < 0 ? n : j + 2
      out += '\n'.repeat(src.slice(i, end).split('\n').length - 1)
      i = end
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      let j = i + 1
      while (j < n) {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === q) break
        if (src[j] === '\n' && q !== '`') break
        j += 1
      }
      out += src.slice(i, j + 1)
      i = j + 1
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** 剥 HTML 注释（保留换行，行号不漂）。 */
function stripHtmlComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const a = src.indexOf('<!--', i)
    if (a < 0) {
      out += src.slice(i)
      break
    }
    out += src.slice(i, a)
    const b = src.indexOf('-->', a)
    if (b < 0) break
    out += '\n'.repeat(src.slice(a, b + 3).split('\n').length - 1)
    i = b + 3
  }
  return out
}

/** 按文件类型剥注释（.vue 分段：模板只剥 HTML 注释、script 剥 JS 注释、style 剥 CSS 注释）。 */
function stripComments(file, text) {
  if (file.endsWith('.js') || file.endsWith('.mjs')) return stripJsComments(text)
  if (file.endsWith('.css')) return stripHtmlComments(stripJsComments(text))
  if (!file.endsWith('.vue')) return text
  /* .vue：先按 <script> / <style> 切段，段外（模板）只剥 HTML 注释。 */
  let out = ''
  let i = 0
  while (i < text.length) {
    const m = /<(script|style)\b[^>]*>/g
    m.lastIndex = i
    const hit = m.exec(text)
    if (!hit) {
      out += stripHtmlComments(text.slice(i))
      break
    }
    out += stripHtmlComments(text.slice(i, hit.index))
    const close = text.indexOf(`</${hit[1]}>`, m.lastIndex)
    const end = close < 0 ? text.length : close
    const inner = text.slice(m.lastIndex, end)
    out += hit[0] + stripJsComments(inner) + text.slice(end, Math.min(text.length, end + hit[1].length + 3))
    i = Math.min(text.length, end + hit[1].length + 3)
  }
  return out
}

/* --------------------------------------------------------------- 全仓枚举 */
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) return walk(p)
    return /\.(vue|js|mjs|css)$/.test(d.name) ? [p] : []
  })

const SRC_FILES = walk(SRC).map((abs) => ({
  abs,
  rel: path.relative(ROOT, abs),
  raw: fs.readFileSync(abs, 'utf8')
}))
for (const f of SRC_FILES) f.clean = stripComments(f.rel, f.raw)

/** 剥注释后仍含 `needle` 的文件:行（行号以 clean 文本为准，剥除保留换行）。 */
function offenders(needle, files = SRC_FILES, opts = {}) {
  const skip = opts.skip || []
  const hits = []
  for (const f of files) {
    if (skip.includes(f.rel)) continue
    if (!f.clean.includes(needle)) continue
    f.clean.split('\n').forEach((line, idx) => {
      if (line.includes(needle)) hits.push(`${f.rel}:${idx + 1}`)
    })
  }
  return hits
}

/* ============================================================== A 映射面 */
const labels = await import(LABELS_ABS)
const { ROLE_LABEL, roleLabel } = labels

section('A', '映射面：两值正确、键面恰 2、繁体、无书名号；`roleLabel()` 命中与回落')
check('A1', '`ROLE_LABEL.admin` ＝ 掌書記使（繁体，`書`）', '掌書記使', ROLE_LABEL.admin)
check('A2', '`ROLE_LABEL["sub-admin"]` ＝ 掌書記（繁体，`書`）', '掌書記', ROLE_LABEL['sub-admin'])
check('A3', '键面恰 `admin` / `sub-admin` 两枚（内部角色值一字未改，不新增别名）', ['admin', 'sub-admin'], sorted(Object.keys(ROLE_LABEL)))
check('A4', '`roleLabel("admin")` ＝ 掌書記使', '掌書記使', roleLabel('admin'))
check('A5', '`roleLabel("sub-admin")` ＝ 掌書記', '掌書記', roleLabel('sub-admin'))
check('A6', '未知角色**回落原文**、不抛错（`guest` ⇒ `guest`）', 'guest', roleLabel('guest'))
check('A7', '空值回落空串（`null` / `undefined` ⇒ 展示层不因缺键报错）', ['', ''], [roleLabel(null), roleLabel(undefined)])
check('A8', '两串均为繁体且不含书名号 / 方括号（上屏不加装饰）', true, [ROLE_LABEL.admin, ROLE_LABEL['sub-admin']].every((s) => s.includes('書') && !/[【】《》\[\]]/.test(s)))
check('A9', '两串互不相同且 `掌書記使` 是 `掌書記` 的严格超串（admin ⊃ sub-admin）', true, ROLE_LABEL.admin !== ROLE_LABEL['sub-admin'] && ROLE_LABEL.admin.startsWith(ROLE_LABEL['sub-admin']))

/* ========================================================== B 单一真源 */
section('B', '单一真源：`ROLE_LABEL` 恰 1 处定义；两串只在 `roleLabels.js` 出现；展示处均经映射')

const defineHits = SRC_FILES.filter((f) => /(export\s+)?(const|let|var)\s+ROLE_LABEL\s*=/.test(f.clean)).map((f) => f.rel)
check('B1', '`ROLE_LABEL` 全仓**恰 1 处**定义且在 `src/data/roleLabels.js`', [LABELS_REL], defineHits)

const adminLabelHits = offenders('掌書記使', SRC_FILES, { skip: [LABELS_REL] })
const subLabelHits = SRC_FILES.filter((f) => f.rel !== LABELS_REL && f.clean.includes('掌書記')).map((f) => f.rel)
check('B2', '`掌書記使` 剥注释后**只在** `roleLabels.js` 出现（其余展示处一律插值，零硬编码）', [], adminLabelHits)
check('B3', '`掌書記`（含其超串）剥注释后**只在** `roleLabels.js` 出现', [], subLabelHits)

const DISPLAY_FILES = [
  'src/views/SealDetailView.vue',
  'src/views/ConnectFeicuiView.vue',
  'src/views/BookIndexView.vue',
  'src/views/LoginView.vue',
  'src/components/PersonProposalDialog.vue',
  'src/components/UploadSealDialog.vue',
  'src/services/feicui.js',
  'src/services/seals.js',
  'src/services/corrections.js',
  'src/services/persons.js',
  'src/services/items.js',
  'src/services/admin.js',
  'src/services/aiAccess.js',
  'src/services/aiEnhance.js',
  'src/services/sealExport.js',
  'src/services/token.js',
  'src/data/db.js'
]
const missingImport = DISPLAY_FILES.filter((rel) => {
  const f = SRC_FILES.find((x) => x.rel === rel)
  return !f || !/from\s+'[./]*[^']*roleLabels\.js'/.test(f.raw) || !/\bADMIN_LABEL\b|\broleLabel\(|\bROLE_LABEL\b/.test(f.raw)
})
check('B4', '17 个展示件全部 `import { ADMIN_LABEL } from …roleLabels.js` 且真的用了它（缺一即红）', [], missingImport)

const helperHits = SRC_FILES.filter((f) => f.rel !== LABELS_REL && /function\s+roleLabel\s*\(/.test(f.clean)).map((f) => f.rel)
check('B5', '`roleLabel()` **只在** `roleLabels.js` 定义（别处不得自建第二套映射函数）', [], helperHits)

/* ============================================================== C 残留面 */
section('C', '残留面：`src/**` 剥注释后零「管理員」零「管理员」（逐文件点名）')

check('C1', '繁体「管理員」零残留（模板 / 提示 / 按钮 / 弹窗 / toast / 占位符 / 无障碍名全算）', [], offenders('管理員'))
check('C2', '简体「管理员」零残留（同上，剥注释后）', [], offenders('管理员'))
check('C3', '旧文案样式零残留：`僅管理員可見` / `管理員賬號` / `管理員簽發` 均不再出现', [], [
  ...offenders('僅管理員可見'),
  ...offenders('管理員賬號'),
  ...offenders('管理員簽發')
])

/* ====================================================== D 内部值零改动 */
section('D', '内部角色值零改动：判定仍用 `admin` / `sub-admin`，映射键与之逐字相同')

const roleJudgements = SRC_FILES.filter((f) => /role\s*===\s*'admin'/.test(f.clean)).map((f) => f.rel)
check('D1', '`role === \'admin\'` 判定仍在（≥ 5 处，权限口径一字未改）', true, roleJudgements.length >= 5)
check('D2', '数据层仍以 `admin` / `user` 为角色值真源（`role: \'admin\'` 仍存在）', true, SRC_FILES.some((f) => /role:\s*'admin'/.test(f.clean)))
check('D3', '`roleLabels.js` 键面与判定字面量逐字相同（`admin` / `sub-admin`，零新别名）', 'admin,sub-admin', Object.keys(ROLE_LABEL).join(','))
const LABELS_CLEAN = (() => {
  const f = SRC_FILES.find((x) => x.rel === LABELS_REL)
  return f ? f.clean : ''
})()
const LABELS_RAW = fs.readFileSync(LABELS_ABS, 'utf8')

check('D4', '`roleLabels.js` 零权限逻辑：不出现 `===` 比较、`if (` 分支（是映射表，不是判定）', 0, countOf(LABELS_CLEAN, '===') + countOf(LABELS_CLEAN, 'if ('))
check('D5', '`roleLabels.js` 无外部依赖（零 `import`），不引入环', 0, countOf(LABELS_RAW, '\nimport '))

/* ========================================================= E 变异负对照 */
section('E', '变异负对照：判据必须会响（只在内存副本上做，不写被测件）')

const probeFile = { rel: 'src/views/__probe__.vue', raw: '<template><p>僅管理和員可見</p></template>', clean: '' }
probeFile.clean = stripComments(probeFile.rel, probeFile.raw.replace('管理和員', '管理員'))
check('E1', '负对照 ①：模板里塞回「管理員」⇒ C1 的收集器必命中（不是恒空）', 1, offenders('管理員', [probeFile]).length)

const probeComment = { rel: 'src/probe.js', raw: '// 管理员注释\n/* 管理員 说明 */\nconst a = 1\n' }
probeComment.clean = stripComments(probeComment.rel, probeComment.raw)
check('E2', '负对照 ②：**注释行**（`//` 与 `/* */`）剥除后不误报（白名单真的生效）', 0, offenders('管理員', [probeComment]).length + offenders('管理员', [probeComment]).length)

const probeString = { rel: 'src/probe2.js', raw: "const s = '僅管理員可以審覈勘誤'\nconst t = `/* 不是註釋 */`\n" }
probeString.clean = stripComments(probeString.rel, probeString.raw)
check('E3', '负对照 ③：**字符串内**的「管理員」必须保留并命中；引号里的 `/*` 不得吞掉后续（引号感知）', 1, offenders('管理員', [probeString]).length)

const probeTpl = { rel: 'src/probe3.vue', raw: '<template>\n<!-- 管理员：老文案 -->\n<p>內容</p>\n</template>\n' }
probeTpl.clean = stripComments(probeTpl.rel, probeTpl.raw)
check('E4', '负对照 ④：`.vue` 模板里的 `<!-- -->` 注释剥除后不误报', 0, offenders('管理员', [probeTpl]).length)

const probeBoth = { rel: 'src/probe4.js', raw: "const a = '掌書記使' + '掌書記'\n" }
probeBoth.clean = stripComments(probeBoth.rel, probeBoth.raw)
check('E5', '负对照 ⑤（单一真源口径）：`.js` 里硬编码 `掌書記使` ⇒ B2 同一收集器必命中', 1, offenders('掌書記使', [probeBoth]).length)
const probeBothSub = { rel: 'src/probe5.js', raw: "const a = '掌書記'\n" }
probeBothSub.clean = stripComments(probeBothSub.rel, probeBothSub.raw)
check('E6', '负对照 ⑥：硬编码 `掌書記` ⇒ B3 同一收集器必命中', 1, offenders('掌書記', [probeBothSub]).length)

/* ------------------------------------------------------------------ 汇总 */
const failedIds = results.filter((r) => !r.pass).map((r) => r.id)
console.log(
  JSON.stringify({
    summary: { total: results.length, passed: results.length - failures, failed: failures },
    sections: sectionStats,
    failed_ids: failedIds,
    note:
      '离线静态自检：只读 src/**，零网络、零浏览器、零生产读写；剥除器引号感知，' +
      '.vue 分模板 / script 段各按各的注释语法剥；D 段锁「内部角色值零改动」，E 段为变异负对照。'
  })
)
process.exit(failedIds.length === 0 ? 0 : 1)
