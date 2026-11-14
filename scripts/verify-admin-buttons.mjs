#!/usr/bin/env node
/**
 * 玺爱 · **管理员按钮样式区分 ＋ 勘误作者印人选择器** 回归套件
 * =====================================================================
 * 覆盖：裁定件 `docs/admin-button-styling-ruling-2026-11-14.md`（`0a0d0b7`）
 *       ＋ `docs/author-correction-picker-ruling-2026-11-14.md`（`1718e94`）；
 *       被测实现 `97ee663`（单点 `.btn--admin` ＋ `AdminBadge` ＋ 作者改用 `PersonPicker`）。
 *
 * 扫描口径（照本仓既有套件）：
 *   · **先剥注释再判**（`<!-- -->` / `/* *\/`；script 段行内 `//`）—— 产品件注释里逐字写着
 *     `btn--admin` / `PersonPicker` / `aria-hidden` 等「解释性字样」，不剥会把说明当实码。
 *     剥除器**引号感知**（' " ` 与模板串内不剥），否则脚本里一个 `/*` 字面量会把整个文件尾巴吃掉
 *     —— 本套第一版就踩了这个坑（C1/C5 假红、B6 样本面归零）。
 *   · CSS 判据一律对**样式源码文本**解析成 `{selector, body}` 规则，不读 computed 样式、不开浏览器。
 *
 * 判据分段：
 *   A 样式单点：`.btn--admin` 有 `position: relative` ＋ `border-style: dashed`；`:hover` 回 `solid`；
 *     角标组件绝对定位 ＋ `pointer-events: none` ＋ `aria-hidden` ＋ `currentColor`；两处均无
 *     `visibility` 声明、样式段无颜色字面量（只用令牌）。
 *   B 应用面：`btn--admin` 开标签数 ＝ `<AdminBadge` 数；每个都含「僅管理員可見」；
 *     10 个管理员门控 `v-if` 后的 class 全带该类；`canClearLocal` / `canUpload`（普通权限）后不带；
 *     普通按钮（存入雲盤 / 下載高清原圖 / 勘誤）零误加；`[data-admin-action]` 全仓仍恰 12 值。
 *   C 作者选择器：`item.key === 'author'` 分支渲染 `PersonPicker` 且分支内零 `<input>`；
 *     全件零 `v-model="form.author"` 文本框；`authorPersons` 取 `persons.referablePersons()`；
 *     传 `persons.personName`；提交链未改（`field: item.key` / `value: form[item.key]`）。
 *   D 变异负对照（D1〜D5）：判据必须会响。
 */
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const BASE_CSS_REL = 'src/styles/base.css'
const BADGE_REL = 'src/components/AdminBadge.vue'
const VIEW_REL = 'src/views/SealDetailView.vue'

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

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/

/* ============================ 判据：纯函数（便于 D 段变异复用） ============ */
function judgeBaseCss(cssText) {
  const rules = cssRules(stripComments(cssText))
  const base = rules.filter((r) => r.selector === '.btn--admin')
  const hover = rules.filter((r) => r.selector === '.btn--admin:hover')
  const baseRule = base[0] || null
  return {
    baseRuleCount: base.length,
    hoverRuleCount: hover.length,
    position: baseRule ? declOf(baseRule.body, 'position') : null,
    borderStyle: baseRule ? declOf(baseRule.body, 'border-style') : null,
    hoverBorderStyle: hover[0] ? declOf(hover[0].body, 'border-style') : null,
    baseHasVisibility: baseRule ? /(?:^|;)\s*(?:visibility|display)\s*:/i.test(baseRule.body) : false,
    colorLiteral: baseRule ? COLOR_LITERAL.test(baseRule.body) : false
  }
}

function judgeBadge(badgeText) {
  const clean = stripComments(badgeText)
  const styleStart = clean.indexOf('<style')
  const styleEnd = clean.indexOf('</style>')
  const styleText = styleStart >= 0 && styleEnd > styleStart ? clean.slice(styleStart, styleEnd) : ''
  const rules = cssRules(styleText)
  return {
    hasTemplateBadge: /class="admin-badge"/.test(clean),
    ariaHidden: /aria-hidden="true"/.test(clean),
    hasSvg: /<svg/i.test(clean),
    absolutePositioned: rules.some((r) => /position\s*:\s*absolute/i.test(r.body)),
    pointerEventsNone: rules.some((r) => /pointer-events\s*:\s*none/i.test(r.body)),
    usesCurrentColor: /currentColor/.test(clean),
    colorLiteralInStyle: COLOR_LITERAL.test(styleText),
    hasVisibility: /visibility\s*:/i.test(styleText)
  }
}

/** 开标签 ＋ 其直系文本（用于按按钮文字取样本）。 */
function btnTags(clean) {
  const tags = []
  const re = /<(button|label)\b[^>]*>/gi
  let m
  while ((m = re.exec(clean))) {
    const openEnd = m.index + m[0].length
    const closeAt = clean.indexOf('<', openEnd)
    const text = clean.slice(openEnd, closeAt < 0 ? openEnd + 60 : closeAt).trim()
    tags.push({ raw: m[0], kind: m[1].toLowerCase(), text, index: m.index })
  }
  return tags
}

const ADMIN_GATES = [
  'canExportSeal',
  'canDeleteSeal',
  'canEditSealAttrs',
  'canAddSealFace',
  'canEditFixed',
  'canReplaceFaceImage',
  'canAiEnhanceFace',
  'canSetBaseFaceOn',
  'canDeleteFaceImage',
  'canDeleteWholeSealImage'
]
const NORMAL_GATES = ['canClearLocal', 'canUpload']

function gateClasses(clean, gate) {
  const out = []
  const needle = `v-if="${gate}`
  let from = 0
  for (;;) {
    const at = clean.indexOf(needle, from)
    if (at < 0) break
    const cls = clean.slice(at, at + 320).match(/class="([^"]*)"/)
    out.push(cls ? cls[1] : null)
    from = at + needle.length
  }
  return out
}

/** 全仓 `[data-admin-action]` 取值集合（递归 src/**）。 */
function adminActionValues() {
  const found = new Set()
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(vue|js|mjs)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8')
        for (const m of text.matchAll(/data-admin-action="([a-z-]+)"/g)) found.add(m[1])
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  return sorted([...found])
}

function judgeView(viewText) {
  const clean = stripComments(viewText)
  const tags = btnTags(clean)
  const adminTags = tags.filter((t) => /\bbtn--admin\b/.test(t.raw))
  const normalTargets = ['存入雲盤', '下載高清原圖', '勘誤']
  const normalSamples = tags.filter((t) => normalTargets.includes(t.text))
  const gateMap = {}
  for (const g of [...ADMIN_GATES, ...NORMAL_GATES]) gateMap[g] = gateClasses(clean, g)
  /* 锚点必须取**模板分支**：脚本段里 `item.key === 'author'` 另有一处（`resolveAuthorDisplayName`），
     按裸字面量取会切到 script 段 ⇒ C1 假红（本套第二版即踩此坑）。 */
  const authorAt = clean.indexOf(`v-else-if="item.key === 'author'"`)
  const branchEndAt = authorAt >= 0 ? clean.indexOf('</template>', authorAt) : -1
  const authorBranch = authorAt >= 0 ? clean.slice(authorAt, branchEndAt > authorAt ? branchEndAt : authorAt + 1600) : ''
  return {
    adminTagCount: adminTags.length,
    badgeCount: countOf(clean, '<AdminBadge'),
    adminTagsWithoutLabel: adminTags.filter((t) => !t.raw.includes('僅管理員可見')).length,
    normalSampleCount: normalSamples.length,
    normalSampleAdminCount: normalSamples.filter((t) => /\bbtn--admin\b/.test(t.raw)).length,
    gateMap,
    adminActionCount: adminActionValues().length,
    authorBranchUsesPicker: authorBranch.includes('<PersonPicker'),
    authorBranchInputCount: countOf(authorBranch, '<input'),
    formAuthorTextInput: countOf(clean, 'v-model="form.author"'),
    usesReferablePersons: /authorPersons\s*=\s*computed\([\s\S]{0,600}?referablePersons\(\)/.test(clean),
    passesPersonName: /:person-name="persons\.personName"/.test(clean),
    submitPayloadIntact: /field:\s*item\.key,\s*\n\s*value:\s*form\[item\.key\]/.test(clean)
  }
}

/* ================================= 读取真源 =============================== */
const baseCss = read(BASE_CSS_REL)
const badgeSrc = read(BADGE_REL)
const viewSrc = read(VIEW_REL)

const baseJudge = judgeBaseCss(baseCss)
const badgeJudge = judgeBadge(badgeSrc)
const viewJudge = judgeView(viewSrc)

/* --------------------------------- A 样式单点 ---------------------------- */
section('A', '样式单点：.btn--admin（虚线 ＋ hover 实线）与 AdminBadge（绝对定位 / 不吃点击 / 无颜色字面量）')
check('A1', '`.btn--admin` 规则恰 1 条且 `position: relative`（给角标定位上下文）＋ `border-style: dashed`（形状差异，非颜色差异）', {
  baseRuleCount: 1,
  position: 'relative',
  borderStyle: 'dashed'
}, {
  baseRuleCount: baseJudge.baseRuleCount,
  position: baseJudge.position,
  borderStyle: baseJudge.borderStyle
})
check('A2', '`.btn--admin:hover` 恰 1 条且 `border-style: solid`（悬停回实线＝可点反馈）', {
  hoverRuleCount: 1,
  hoverBorderStyle: 'solid'
}, {
  hoverRuleCount: baseJudge.hoverRuleCount,
  hoverBorderStyle: baseJudge.hoverBorderStyle
})
check('A3', '`.btn--admin` 主规则零 `visibility` / `display` 声明（区分不得靠隐藏；与行尾勘誤同口径）', {
  hasVisibility: false
}, { hasVisibility: baseJudge.baseHasVisibility })
check('A4', '`.btn--admin` 主规则零颜色字面量（只用既有令牌 ⇒ 三主题自适应）', { colorLiteral: false }, { colorLiteral: baseJudge.colorLiteral })
check('A5', 'AdminBadge 结构：`class="admin-badge"` ＋ `aria-hidden="true"` ＋ 内联 `<svg>`', {
  hasTemplateBadge: true,
  ariaHidden: true,
  hasSvg: true
}, {
  hasTemplateBadge: badgeJudge.hasTemplateBadge,
  ariaHidden: badgeJudge.ariaHidden,
  hasSvg: badgeJudge.hasSvg
})
check('A6', 'AdminBadge 行为：某条规则 `position: absolute`（不占位）＋ 某条规则 `pointer-events: none`（不吃点击）', {
  absolutePositioned: true,
  pointerEventsNone: true
}, {
  absolutePositioned: badgeJudge.absolutePositioned,
  pointerEventsNone: badgeJudge.pointerEventsNone
})
check('A7', 'AdminBadge 着色：用 `currentColor`（跟随按钮文字色）且样式段零颜色字面量', {
  usesCurrentColor: true,
  colorLiteralInStyle: false
}, {
  usesCurrentColor: badgeJudge.usesCurrentColor,
  colorLiteralInStyle: badgeJudge.colorLiteralInStyle
})
check('A8', 'AdminBadge 零 `visibility` 声明（角标靠定位出界，不靠隐藏）', { hasVisibility: false }, { hasVisibility: badgeJudge.hasVisibility })

/* --------------------------------- B 应用面 ------------------------------ */
section('B', '应用面：管理员门控按钮成对带样式＋角标＋「僅管理員可見」，普通按钮零误加，钩子面不变')
check('B1', '`btn--admin` 开标签数 ＝ `<AdminBadge` 数（每个管理入口都配一枚锁标；不成对即红）且 ≥ 10', {
  badgeCount: viewJudge.adminTagCount
}, {
  badgeCount: viewJudge.badgeCount
})
check('B2', '每个带 `btn--admin` 的开标签都含「僅管理員可見」（title / aria-label 至少一处：悬停与读屏都有落点）', {
  adminTagsWithoutLabel: 0
}, { adminTagsWithoutLabel: viewJudge.adminTagsWithoutLabel })
check('B3', '10 个管理员门控 `v-if` 后紧跟的 class 均含 `btn--admin`（逐个门点名，缺一即红）', {
  missing: []
}, {
  missing: ADMIN_GATES.filter((g) => {
    const list = viewJudge.gateMap[g] || []
    return list.length === 0 || list.some((c) => c === null || !/\bbtn--admin\b/.test(c))
  })
})
check('B4', '普通用户权限门（`canClearLocal` 清除本機資料 / `canUpload` 实物照片上传）后**不得**带 `btn--admin`', {
  leaked: []
}, {
  leaked: NORMAL_GATES.filter((g) => (viewJudge.gateMap[g] || []).some((c) => c && /\bbtn--admin\b/.test(c)))
})
check('B5', '普通按钮（存入雲盤 / 下載高清原圖 / 勘誤）开标签零 `btn--admin`（误加即红）', {
  normalSampleAdminCount: 0
}, { normalSampleAdminCount: viewJudge.normalSampleAdminCount })
check('B6', '样本面自证：普通按钮确实取到 ≥ 3 个开标签（防「没取到样本」冒充全绿）', { atLeast3: true }, { atLeast3: viewJudge.normalSampleCount >= 3 })
check('B7', '`[data-admin-action]` 全仓取值集合仍恰 12（样式改动不得新增钩子取值）', { count: 12 }, { count: viewJudge.adminActionCount })

/* --------------------------------- C 作者选择器 -------------------------- */
section('C', '勘误作者：PersonPicker 单点（只选不填），行集 / 显示名复用服务层，提交链零改动')
check('C1', '`item.key === \'author\'` 分支渲染 `PersonPicker`（不是文本输入）', { usesPicker: true }, { usesPicker: viewJudge.authorBranchUsesPicker })
check('C2', '该作者分支内零 `<input>`（禁自由文本：手输姓名与服务端「按印人 id 判定」错配，必被拒）', { inputCount: 0 }, { inputCount: viewJudge.authorBranchInputCount })
check('C3', '全件零 `v-model="form.author"`（旧写法彻底移除，不留旁路）', { count: 0 }, { count: viewJudge.formAuthorTextInput })
check('C4', '`authorPersons` ＝ `computed(… persons.referablePersons() …)`（只列可引用行，不另建检索）', { ok: true }, { ok: viewJudge.usesReferablePersons })
check('C5', '传 `:person-name="persons.personName"`（显示名单点派生，不自写）', { ok: true }, { ok: viewJudge.passesPersonName })
check('C6', '提交链未改：仍 `field: item.key` / `value: form[item.key]`（载荷键面零改动）', { ok: true }, { ok: viewJudge.submitPayloadIntact })

/* --------------------------------- D 变异负对照 -------------------------- */
section('D', '变异负对照：判据必须会响（只在内存副本上改，不写被测件）')

const d1 = judgeBaseCss(baseCss.replace(/(\.btn--admin\s*\{[^}]*?)border-style\s*:\s*dashed/, '$1border-style: solid'))
check('D1', '负对照 ①：`.btn--admin` 的 `dashed` 改 `solid` ⇒ A1 必红（形状差异消失）', { borderStyle: 'solid' }, { borderStyle: d1.borderStyle })

const d2 = judgeBadge(badgeSrc.replaceAll('aria-hidden="true"', 'aria-hidden="false"'))
check('D2', '负对照 ②：AdminBadge 的 `aria-hidden` 全改 false ⇒ A5 必红（读屏会把图形念进按钮名）', { ariaHidden: false }, { ariaHidden: d2.ariaHidden })

const d3 = judgeView(
  viewSrc.replace(
    'class="btn btn--ghost"\n          type="button"\n          data-drive-action="save-seal"',
    'class="btn btn--ghost btn--admin"\n          type="button"\n          data-drive-action="save-seal"'
  )
)
check('D3', '负对照 ③：给普通按钮「存入雲盤」误加 `btn--admin` ⇒ B5 必红（普通用户入口被当成管理入口）', {
  normalSampleAdminCount: 1
}, { normalSampleAdminCount: d3.normalSampleAdminCount })

const d4 = judgeView(viewSrc.replace(/<PersonPicker[\s\S]*?\/>/, '<input v-model="form.author" type="text" />'))
check('D4', '负对照 ④：作者分支换回 `<input v-model="form.author">` ⇒ C1 与 C2 必红（自由文本旁路回归）', {
  usesPicker: false,
  inputCount: 1
}, {
  usesPicker: d4.authorBranchUsesPicker,
  inputCount: d4.authorBranchInputCount
})

const rawRules = cssRules(viewSrc)
check('D5', '负对照 ⑤（扫描口径）：不剥注释直接切 CSS ⇒ 注释块被当选择器文本（本套第一版即因此假红 C1/C5）；钉住「先剥注释再判」', {
  contaminated: true
}, { contaminated: rawRules.some((r) => r.selector.includes('仅管理员') || r.selector.includes('btn--admin') || r.selector.includes('/*')) })

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
      'CSS 判据读样式源码文本，不读 computed 样式；D 段变异只在内存字符串上做，不写被测件。'
  })
)
process.exit(failedIds.length === 0 ? 0 : 1)
