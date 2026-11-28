#!/usr/bin/env node
/**
 * 玺爱 · **管理员专属卡片（容器）虚线边框** 回归套件（离线静态）
 * =====================================================================
 * 单：`/my/corrections` 页四个管理员門控卡片改 `panel panel--admin`（虚线轮廓）。
 * 裁定口径：与 `.btn--admin` 同一件（`docs/admin-button-styling-ruling-2026-11-14.md`）
 *           —— **只改线型**（`dashed`），宽度 / 颜色 / 圆角一律沿用 `.panel`
 *           （1px `var(--slot-panel-line)`）；**颜色零新增**；卡片不可点故 **不加 `:hover`**。
 *
 * 扫描口径（照本仓既有套件 `verify-admin-buttons.mjs`）：
 *   · **先剥注释再判**（`<!-- -->` / `/* *\\/`；引号感知）—— 产品件注释里逐字写着
 *     `panel--admin` / `canSyncReview` 等「解释性字样」，不剥会把说明当实码。
 *   · CSS 判据对**样式源码文本**解析成 `{selector, body}` 规则，不读 computed、不开浏览器。
 *   · section 开标签解析**引号感知**：属性值里的 `>` 不得当标签结束（同 `btnTags` 口径）；
 *     门控按 **`v-if` 整串**匹配，**不按行号**（行号随并行单漂移）。
 *
 * 判据分段：
 *   A 样式单点：`.panel--admin` 恰 1 条、声明只含 `border-style: dashed`
 *     （零 `border:` 简写、零颜色字面量、零 `:hover` 规则）；落位在 `.btn--admin:hover`
 *     之后、`.btn[disabled]` 之前；`.btn--admin` 块一字未改（`position: relative` ＋
 *     `:hover` 回实线）。
 *   B 应用面：`MyCorrectionsView.vue` 恰 4 处 `panel--admin`；与四扇管理员门
 *     （`canReview` / `canReviewProposals` / 导入面三合一 / `canSyncReview`）**一一对应**；
 *     非管理员门控的 `<section>` 零误加（普通用户面视觉零变化）。
 *   C 变异负对照（C1〜C3）：判据必须会响（只在内存副本上改，不写被测件）。
 *
 * 零网络、零浏览器、零生产读写；只读 `src/**`。
 */
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const BASE_CSS_REL = 'src/styles/base.css'
const VIEW_REL = 'src/views/MyCorrectionsView.vue'

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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/* --------------------------------------------- 去注释（引号感知，保留偏移） */
function stripComments(text) {
  const chars = [...text]
  const blank = (from, to) => {
    for (let k = Math.max(0, from); k < Math.min(to, chars.length); k += 1) {
      if (chars[k] !== '\n') chars[k] = ' '
    }
  }
  let i = 0
  while (i < chars.length) {
    const c = chars[i]
    if (c === '<' && chars[i + 1] === '!' && chars[i + 2] === '-' && chars[i + 3] === '-') {
      let j = i + 4
      while (j < chars.length && !(chars[j] === '-' && chars[j + 1] === '-' && chars[j + 2] === '>')) j += 1
      blank(i, j + 3)
      i = j + 3
      continue
    }
    if (c === '/' && chars[i + 1] === '*') {
      let j = i + 2
      while (j < chars.length && !(chars[j] === '*' && chars[j + 1] === '/')) j += 1
      blank(i, j + 2)
      i = j + 2
      continue
    }
    // 引号串：整段跳过（防脚本里的 `/*` 字面量把尾巴吃掉）
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      let j = i + 1
      while (j < chars.length) {
        if (chars[j] === '\\') {
          j += 2
          continue
        }
        if (chars[j] === quote) break
        j += 1
      }
      i = j + 1
      continue
    }
    i += 1
  }
  return chars.join('')
}

/* ------------------------------------------------------------ CSS 规则解析 */
function cssRules(cssText) {
  const rules = []
  const walk = (text, media) => {
    let start = 0
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '{') {
        const selector = text.slice(start, i).trim().replace(/\s+/g, ' ')
        let j = i + 1
        let inner = 0
        for (; j < text.length; j += 1) {
          if (text[j] === '{') inner += 1
          else if (text[j] === '}') {
            if (inner === 0) break
            inner -= 1
          }
        }
        const body = text.slice(i + 1, j)
        if (/^@media/i.test(selector)) walk(body, selector)
        else rules.push({ selector, body, media })
        i = j
        start = j + 1
      }
    }
  }
  walk(cssText, null)
  return rules
}

const declOf = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i'))
  return m ? m[1].trim().replace(/\s+/g, ' ') : null
}

/** 规则体 → 规范化声明数组（`['border-style: dashed']`）。 */
const declsOf = (body) =>
  body
    .split(';')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean)

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/

/* ==================== 门控面：四扇管理员門控 section ==================== */
/** `/my/corrections` 恰四扇管理员門控 panel 的 `v-if` 整串 —— 按**开标签**匹配，不按行号。 */
const PANEL_GATES = [
  { id: 'canReview', attr: 'v-if="canReview"' },
  { id: 'canReviewProposals', attr: 'v-if="canReviewProposals"' },
  {
    id: 'importFace',
    attr: 'v-if="isLocalImportFace() && (canReviewImports || canReviewSealImports || canReviewItemImports)"'
  },
  { id: 'canSyncReview', attr: 'v-if="canSyncReview"' }
]
const PANEL_GATE_IDS = sorted(PANEL_GATES.map((g) => g.id))

/** 全部 `<section` 开标签（结束符 `>` **引号感知**：属性值里的 `>` 不得当标签结束，
 *  否则开标签被截断、其后的 `class="…"` 落在标签体外 ⇒ 假红）。 */
function sectionOpenTags(clean) {
  const tags = []
  const re = /<section\b/gi
  let m
  while ((m = re.exec(clean))) {
    let i = m.index + m[0].length
    let quote = null
    while (i < clean.length) {
      const c = clean[i]
      if (quote) {
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === quote) quote = null
      } else if (c === '"' || c === "'" || c === '`') {
        quote = c
      } else if (c === '>') {
        break
      }
      i += 1
    }
    if (i >= clean.length) break // 未闭合：不产出残缺标签
    tags.push(clean.slice(m.index, i + 1))
    re.lastIndex = i + 1
  }
  return tags
}

/* ============================ 判据：纯函数（便于 C 段变异复用） ============ */
/** A 段：`.panel--admin` 单点规则 ＋ 落位 ＋ `.btn--admin` 块一字未改。 */
function judgeCss(cssText) {
  const clean = stripComments(cssText)
  const rules = cssRules(clean)
  const base = rules.filter((r) => r.selector === '.panel--admin')
  const hover = rules.filter((r) => r.selector === '.panel--admin:hover')
  const rule = base[0] || null
  const at = (re) => {
    const m = clean.match(re)
    return m ? m.index : -1
  }
  /* 落位：`.panel--admin` 在 `.btn--admin:hover` 之后、`.btn[disabled]` 之前。
     正则带 `{` ⇒ 注释里出现的字样不算命中；stripComments 保留偏移。 */
  const panelAt = at(/\.panel--admin\s*\{/)
  const btnHoverAt = at(/\.btn--admin:hover\s*\{/)
  const disabledAt = at(/\.btn\[disabled\]\s*\{/)
  const btnRules = rules.filter((r) => r.selector === '.btn--admin')
  const btnHoverRules = rules.filter((r) => r.selector === '.btn--admin:hover')
  const btnRule = btnRules[0] || null
  const btnHoverRule = btnHoverRules[0] || null
  return {
    ruleCount: base.length,
    hoverRuleCount: hover.length,
    decls: rule ? declsOf(rule.body) : null,
    /* 零简写：只有裸 `border:` 才是简写；`border-style:` 不算（`border` 后紧跟 `-style`）。 */
    borderShorthand: rule ? /\bborder\s*:/i.test(rule.body) : false,
    colorLiteral: rule ? COLOR_LITERAL.test(rule.body) : false,
    orderOk: panelAt > btnHoverAt && panelAt < disabledAt && btnHoverAt >= 0 && disabledAt >= 0,
    /* `.btn--admin` 块一字未改（裁定件单点实现的两个声明 ＋ `:hover` 回实线）。 */
    btnRuleCount: btnRules.length,
    btnDecls: btnRule ? declsOf(btnRule.body) : null,
    btnPosition: btnRule ? declOf(btnRule.body, 'position') : null,
    btnBorderStyle: btnRule ? declOf(btnRule.body, 'border-style') : null,
    btnHoverRuleCount: btnHoverRules.length,
    btnHoverDecls: btnHoverRule ? declsOf(btnHoverRule.body) : null
  }
}

/** B 段：`/my/corrections` 的 section 门控 ↔ `panel--admin` 一一对应。 */
function judgeView(viewText) {
  const clean = stripComments(viewText)
  const rows = sectionOpenTags(clean).map((tag) => ({
    tag,
    admin: /\bpanel--admin\b/.test(tag),
    gates: PANEL_GATES.filter((g) => tag.includes(g.attr)).map((g) => g.id)
  }))
  const adminRows = rows.filter((r) => r.admin)
  const gatedRows = rows.filter((r) => r.gates.length > 0)
  const nonGated = rows.filter((r) => r.gates.length === 0)
  return {
    panelClassCount: countOf(clean, 'panel--admin'),
    sectionCount: rows.length,
    adminSectionCount: adminRows.length,
    gatedSectionCount: gatedRows.length,
    adminGates: sorted(adminRows.flatMap((r) => r.gates)),
    gatedGates: sorted(gatedRows.flatMap((r) => r.gates)),
    gatedWithoutAdmin: gatedRows.filter((r) => !r.admin).flatMap((r) => r.gates),
    adminWithoutGate: adminRows.filter((r) => r.gates.length === 0).length,
    leaks: nonGated.filter((r) => r.admin).map((r) => r.tag),
    /* 样本自证：非管理员 section 至少 1 个（否则「零误加」是没取到样本的假绿）。 */
    nonGatedSampled: nonGated.length >= 1
  }
}

/* ================================= 读取真源 =============================== */
const baseCss = read(BASE_CSS_REL)
const viewSrc = read(VIEW_REL)

const cssJudge = judgeCss(baseCss)
const viewJudge = judgeView(viewSrc)

/* --------------------------------- A 样式单点 ---------------------------- */
section('A', '样式单点：.panel--admin 单点规则（只改线型 / 零简写 / 零颜色字面量 / 零 hover）＋ .btn--admin 块一字未改')

const A1_EXPECTED = {
  ruleCount: 1,
  decls: ['border-style: dashed'],
  borderShorthand: false,
  colorLiteral: false,
  hoverRuleCount: 0,
  orderOk: true
}
check(
  'A1',
  '`.panel--admin` 规则恰 1 处、声明**只含** `border-style: dashed`（宽度 / 颜色 / 圆角沿用 `.panel`）：零 `border:` 简写（简写会把宽度/颜色重写一份）、零颜色字面量、零 `:hover`（卡片不可点）；落位在 `.btn--admin:hover` 之后、`.btn[disabled]` 之前',
  A1_EXPECTED,
  {
    ruleCount: cssJudge.ruleCount,
    decls: cssJudge.decls,
    borderShorthand: cssJudge.borderShorthand,
    colorLiteral: cssJudge.colorLiteral,
    hoverRuleCount: cssJudge.hoverRuleCount,
    orderOk: cssJudge.orderOk
  }
)
check('A2', '`.btn--admin` 块一字未改（裁定件单点）：主规则 `position: relative` ＋ `border-style: dashed`，`:hover` 回 `border-style: solid`', {
  btnRuleCount: 1,
  btnDecls: ['position: relative', 'border-style: dashed'],
  btnPosition: 'relative',
  btnBorderStyle: 'dashed',
  btnHoverRuleCount: 1,
  btnHoverDecls: ['border-style: solid']
}, {
  btnRuleCount: cssJudge.btnRuleCount,
  btnDecls: cssJudge.btnDecls,
  btnPosition: cssJudge.btnPosition,
  btnBorderStyle: cssJudge.btnBorderStyle,
  btnHoverRuleCount: cssJudge.btnHoverRuleCount,
  btnHoverDecls: cssJudge.btnHoverDecls
})

/* --------------------------------- B 应用面 ------------------------------ */
section('B', '应用面：/my/corrections 恰 4 处 panel--admin，与四扇管理员门（canReview / canReviewProposals / 导入面三合一 / canSyncReview）按开标签一一对应，非管理员段零误加')

const B1_EXPECTED = { panelClassCount: 4, adminSectionCount: 4, gatedSectionCount: 4 }
check('B1', '`MyCorrectionsView.vue` 里 `panel--admin` 恰 4 处、且恰 4 个 `<section>` 带它、恰 4 个管理员门 section（缺一即红；不按行号，按开标签）', B1_EXPECTED, {
  panelClassCount: viewJudge.panelClassCount,
  adminSectionCount: viewJudge.adminSectionCount,
  gatedSectionCount: viewJudge.gatedSectionCount
})

check('B2', '四例一一对应：带 `panel--admin` 的 section 的 `v-if` 集合 ＝ 四扇管理员门集合，且每个门都带类（`gatedWithoutAdmin` / `adminWithoutGate` 双向为零）', {
  adminGates: PANEL_GATE_IDS,
  gatedGates: PANEL_GATE_IDS,
  gatedWithoutAdmin: [],
  adminWithoutGate: 0
}, {
  adminGates: viewJudge.adminGates,
  gatedGates: viewJudge.gatedGates,
  gatedWithoutAdmin: viewJudge.gatedWithoutAdmin,
  adminWithoutGate: viewJudge.adminWithoutGate
})

check('B3', '非管理员门控的 `<section>`（如 `v-if="rows.length"` 的「我的提交」）零 `panel--admin`（普通用户面视觉零变化）＋ 样本自证（非管理员 section ≥ 1）', {
  leaks: [],
  nonGatedSampled: true
}, { leaks: viewJudge.leaks, nonGatedSampled: viewJudge.nonGatedSampled })

/* --------------------------------- C 变异负对照 -------------------------- */
section('C', '变异负对照：判据必须会响（只在内存副本上改，不写被测件）')

const c1 = judgeView(
  viewSrc.replace(
    'v-if="canReviewProposals" class="panel panel--admin"',
    'v-if="canReviewProposals" class="panel"'
  )
)
const c1Pass = canon(B1_EXPECTED) === canon({
  panelClassCount: c1.panelClassCount,
  adminSectionCount: c1.adminSectionCount,
  gatedSectionCount: c1.gatedSectionCount
})
const c1B2Pass =
  canon(PANEL_GATE_IDS) === canon(c1.adminGates) &&
  canon(PANEL_GATE_IDS) === canon(c1.gatedGates) &&
  canon([]) === canon(c1.gatedWithoutAdmin) &&
  canon(0) === canon(c1.adminWithoutGate)
check('C1', '负对照 ①：从「待審印人提案」那扇门删掉 `panel--admin` ⇒ B1 与 B2（四例对应断言）必红', {
  applied: true,
  b1Pass: false,
  b2Pass: false,
  gatedWithoutAdmin: ['canReviewProposals'],
  adminSectionCount: 3
}, {
  applied: c1.panelClassCount === 3 && c1.adminSectionCount === 3,
  b1Pass: c1Pass,
  b2Pass: c1B2Pass,
  gatedWithoutAdmin: c1.gatedWithoutAdmin,
  adminSectionCount: c1.adminSectionCount
})

const c2 = judgeCss(baseCss.replace(/(\.panel--admin\s*\{[^}]*?)border-style\s*:\s*dashed/, '$1border: 1px dashed var(--slot-panel-line)'))
const c2Pass = canon(A1_EXPECTED) === canon({
  ruleCount: c2.ruleCount,
  decls: c2.decls,
  borderShorthand: c2.borderShorthand,
  colorLiteral: c2.colorLiteral,
  hoverRuleCount: c2.hoverRuleCount,
  orderOk: c2.orderOk
})
check('C2', '负对照 ②：把 `.panel--admin` 改成 `border: 1px dashed var(--slot-panel-line)`（简写，重写宽度/颜色）⇒ A1「零简写 / 只含 border-style」断言必红', {
  applied: true,
  a1Pass: false,
  borderShorthand: true,
  decls: ['border: 1px dashed var(--slot-panel-line)']
}, {
  applied: c2.borderShorthand,
  a1Pass: c2Pass,
  borderShorthand: c2.borderShorthand,
  decls: c2.decls
})

const c3 = judgeCss(baseCss.replace(/(\.panel--admin\s*\{[^}]*?)border-style\s*:\s*dashed/, '$1border-style: dashed; border-color: #c00'))
const c3Pass = canon(A1_EXPECTED) === canon({
  ruleCount: c3.ruleCount,
  decls: c3.decls,
  borderShorthand: c3.borderShorthand,
  colorLiteral: c3.colorLiteral,
  hoverRuleCount: c3.hoverRuleCount,
  orderOk: c3.orderOk
})
check('C3', '负对照 ③：给 `.panel--admin` 塞一个颜色字面量 `border-color: #c00` ⇒ A1「零颜色字面量 / 只含 border-style」断言必红（检测非恒空）', {
  applied: true,
  a1Pass: false,
  colorLiteral: true
}, { applied: c3.colorLiteral, a1Pass: c3Pass, colorLiteral: c3.colorLiteral })

/* ---------------------------------------------------------------- 收尾 */
const total = results.length
const failedIds = results.filter((r) => !r.pass).map((r) => r.id)
console.log(
  JSON.stringify({
    summary: { total, passed: total - failedIds.length, failed: failedIds.length },
    sections: sectionStats,
    failed_ids: failedIds,
    note:
      '离线静态自检：只读 src/**，零网络、零浏览器、零生产读写；静态扫描先剥注释（引号感知）；' +
      'CSS 判据读样式源码文本，不读 computed 样式；C 段变异只在内存字符串上做，不写被测件。'
  })
)
process.exit(failedIds.length === 0 ? 0 : 1)
