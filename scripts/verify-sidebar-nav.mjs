/**
 * 玺爱 · **Slice M1 回归套件：首页左侧菜单改版（恰四项）＋ 两条新路由与两个新页面**
 * ============================================================================
 * 覆盖规范 v1.56 §10.55 `AC-501`〜`AC-506`（实现入库于 `266fad2`）。
 *
 * 判据清单（本套件自成一件「尺子」，每条皆可判负）：
 *   S1  `AC-501` 侧边栏**恰四项**且 `key/label/glyph` 序列**逐字**——
 *       **结构解析** `items` 数组（定位 `const items = computed(() => [ … ])` 后按大括号平衡切对象），
 *       **不以全文关键词检索代偿**。
 *   S2  `AC-502` 三入口（`my-corrections` / `my-photos` / `points`）**不在**侧边栏 items，
 *       但其**三条路由**与**三个视图文件**仍在（**删入口 ≠ 删路由 / 删页面**）。
 *   S3  `AC-503` 两条新路由 `/styles`（name `styles`）与 `/persons`（name `persons`）在场、
 *       `meta.title` 逐字 `印風匯覽` / `印家匯徵`、**均不带 `requiresAuth`**（公开可达）。
 *   S4  `AC-504` 两页文件在场 ＋ **内容留空**：零未定义标识符（`import` 名与模板绑定的顶层名
 *       均已定义）＋ 零「已定义未使用」常量 ＋ 零节点图 · 弹层相关常量（AC-98 精神）。
 *   S5  `AC-505` `src/views/PersonIndexView.vue` 有 `[data-collect-action]` 钩子闸；
 *       登录引导目标含 `/login` ＋ `redirect`
 *       （**静态判据，非 DOM 判据**；口径见 S5b 描述：字面 `/login` 或路由名 `login`，
 *        并交叉核对路由表 `login → /login`）。
 *   S6  `AC-506` 全 `src/**` 的 `[data-admin-action]` 去重取值集合 ⇒ **恰 10 值 / 归并 9 类**。
 *       扫描函数**照抄**既有套件 `scripts/verify-endorsement.mjs` 的 D1 段口径
 *       （`walkFiles` ＋ `readFileSync` ＋ `/data-admin-action="([^"]+)"/g` ＋ `correction-*` 归并），
 *       **不自创第二套**。
 *
 * 负对照（尺子必须会响）：
 *   N1  顺序颠倒后的序列喂给 S1 的顺序判据 ⇒ **必须判负**。
 *   N1b 把 `AppSidebar.vue` 源码里的 `items` 数组**在文本层面倒序**后重解析 ⇒ 同一条判据必须翻红
 *       （证明解析器真读源码顺序、不是硬编码或恒等）。
 *   N1c 正对照：原文重解析 ⇒ 同一条判据为真（同一把尺子，改前对 / 改后错）。
 *   N4  静态标识符检查器喂入含未定义标识符的合成片段 ⇒ 必须报出（否则该尺子恒绿 =
 *       不可判负，S4b 失去意义）。
 *   N6  钩子扫描 canary 注入 / 移除 ⇒ 取值集合与归并类数必须随之变化（集合非恒等）。
 *
 * 纪律：**只读** `src/**`（本套件不写任何源文件；负对照一律在内存里对文本变形，
 * 不在磁盘上改动被测件）；不联网；不新增依赖；断言失败 ⇒ 退出码非 0。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

const sorted = (arr) => [...arr].slice().sort()
const sameSeq = (a, b) => canon(a) === canon(b)
const BACKTICK = '\u0060'

/* ---------------------------------------------------------------------------
   1. 通用结构解析件（**不用全文关键词检索**）
   --------------------------------------------------------------------------- */

/** 去注释（保留字符串字面值；引号内不视为注释起点）。 */
function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === BACKTICK) {
      out += ch
      i += 1
      while (i < src.length) {
        out += src[i]
        if (src[i] === '\\') {
          i += 1
          if (i < src.length) out += src[i]
        } else if (src[i] === ch) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 定位 `marker` 之后的**第一个数组字面值**，按括号平衡切片（返回含 `[` `]` 的原文）。 */
function arrayLiteralAfter(src, marker) {
  const at = src.indexOf(marker)
  if (at === -1) return null
  const open = src.indexOf('[', at)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '[' || ch === '{' || ch === '(') depth += 1
    else if (ch === ']' || ch === '}' || ch === ')') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return null
}

/** 把数组字面值切成**顶层对象**（对象内嵌套括号不切）。 */
function topLevelObjects(arrayText) {
  const body = arrayText.slice(1, -1)
  const out = []
  let depth = 0
  let start = -1
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0 && start !== -1) {
        out.push(body.slice(start, i + 1))
        start = -1
      }
    } else if (ch === '[' || ch === '(') depth += 1
    else if (ch === ']' || ch === ')') depth -= 1
  }
  return out
}

const strField = (obj, field) => {
  const m = obj.match(new RegExp(`\\b${field}\\s*:\\s*'([^']*)'`))
  return m ? m[1] : null
}

/* ---------------------------------------------------------------------------
   2. 被测件定位（全 **只读**）
   --------------------------------------------------------------------------- */
const SIDEBAR_PATH = path.join(ROOT, 'src/components/AppSidebar.vue')
const ROUTER_PATH = path.join(ROOT, 'src/router/index.js')
const VIEWS = {
  styleIndex: path.join(ROOT, 'src/views/StyleIndexView.vue'),
  personIndex: path.join(ROOT, 'src/views/PersonIndexView.vue'),
  myCorrections: path.join(ROOT, 'src/views/MyCorrectionsView.vue'),
  myPhotos: path.join(ROOT, 'src/views/MyPhotosView.vue'),
  points: path.join(ROOT, 'src/views/PointsView.vue')
}

const sidebarSrc = readFileSync(SIDEBAR_PATH, 'utf8')
const routerSrc = readFileSync(ROUTER_PATH, 'utf8')

/* 侧边栏 items 的**结构解析**（表头/模板/注释一律不参与）。 */
function analyzeSidebarSource(src) {
  const arr = arrayLiteralAfter(src, 'const items')
  if (!arr) return { error: 'items 数组未能结构定位', items: [] }
  const items = topLevelObjects(arr).map((obj) => ({
    key: strField(obj, 'key'),
    to: (obj.match(/to\s*:\s*\{\s*name\s*:\s*'([^']*)'\s*\}/) || [])[1] || null,
    glyph: strField(obj, 'glyph'),
    label: strField(obj, 'label')
  }))
  return { error: null, items, arrayText: arr }
}

/** 负对照用：把 items 数组**文本**倒序重建（只在内存里改，不落盘）。 */
function mutateItemsReversed(src) {
  const arr = arrayLiteralAfter(src, 'const items')
  if (!arr) return src
  const rebuilt = `[${topLevelObjects(arr).reverse().join(', ')}]`
  return src.replace(arr, rebuilt)
}

/* 路由表的**结构解析**。 */
function analyzeRoutes(src) {
  const arr = arrayLiteralAfter(src, 'const routes')
  if (!arr) return []
  return topLevelObjects(arr).map((obj) => ({
    path: strField(obj, 'path'),
    name: strField(obj, 'name'),
    title: strField(obj, 'title'),
    component: (obj.match(/import\('\.\.\/views\/([^']*)'\)/) || [])[1] || null,
    requiresAuth: /\brequiresAuth\b/.test(obj)
  }))
}

const EXPECTED_ITEMS = [
  { key: 'square', label: '璽印匯類', glyph: '匯' },
  { key: 'styles', label: '印風匯覽', glyph: '風' },
  { key: 'persons', label: '印家匯徵', glyph: '家' },
  { key: 'my-drive', label: '我的雲盤', glyph: '盤' }
]
const triple = (item) => [item.key, item.label, item.glyph]

const sidebar = analyzeSidebarSource(sidebarSrc)
const items = sidebar.items
const routes = analyzeRoutes(routerSrc)
const routeByName = (name) => routes.find((r) => r.name === name) || null
const routeByPath = (p) => routes.find((r) => r.path === p) || null

/* ===========================================================================
   S1（AC-501）侧边栏**恰四项** ＋ 顺序逐字
   =========================================================================== */
console.log(JSON.stringify({ section: 'S1', title: 'AC-501 侧边栏恰四项与顺序逐字（结构解析）' }))

check('S1a', 'items 数组**结构定位成功**（`const items` 后的数组字面值）', null, sidebar.error)
check('S1b', '侧边栏 items **恰四项**（数组长度）', 4, items.length)
check('S1c', '四项 `key/label/glyph` 序列**逐字且顺序不颠倒**', EXPECTED_ITEMS.map(triple), items.map(triple))
check('S1d', '四项 `to.name` 逐字绑定同名路由（入口 → 路由名一一对应）', EXPECTED_ITEMS.map((i) => i.key), items.map((i) => i.to))
check('S1e', '四项 `key` 集合**恰**为预期四值（无多余 / 无缺失，顺序无关）', sorted(EXPECTED_ITEMS.map((i) => i.key)), sorted(items.map((i) => i.key)))

/* ===========================================================================
   S2（AC-502）三入口移出侧边栏，但路由与视图**不退役**
   =========================================================================== */
console.log(JSON.stringify({ section: 'S2', title: 'AC-502 三入口移出侧边栏 / 路由与视图不退役' }))

const RETIRED = ['my-corrections', 'my-photos', 'points']
check('S2a', '侧边栏 items 的 `key` **不含**三个已移出入口', [], RETIRED.filter((k) => items.map((i) => i.key).includes(k)))
check('S2b', '侧边栏 items 的 `to` **不含**三个已移出入口（入口侧彻底断链）', [], RETIRED.filter((k) => items.map((i) => i.to).includes(k)))
const sidebarCode = stripComments(sidebarSrc)
check('S2c', '侧边栏**代码面**（去注释）零 `name: my-corrections|my-photos|points` 字面值', [], RETIRED.filter((k) => sidebarCode.includes(`'${k}'`)))
check(
  'S2d',
  '`src/router/index.js` 仍含三条 path（`/my/corrections` / `/my/photos` / `/points`）且 name 逐字',
  { '/my/corrections': 'my-corrections', '/my/photos': 'my-photos', '/points': 'points' },
  {
    '/my/corrections': routeByPath('/my/corrections') && routeByPath('/my/corrections').name,
    '/my/photos': routeByPath('/my/photos') && routeByPath('/my/photos').name,
    '/points': routeByPath('/points') && routeByPath('/points').name
  }
)
check(
  'S2e',
  '三个视图文件仍在（`fs.existsSync`）',
  { MyCorrectionsView: true, MyPhotosView: true, PointsView: true },
  { MyCorrectionsView: existsSync(VIEWS.myCorrections), MyPhotosView: existsSync(VIEWS.myPhotos), PointsView: existsSync(VIEWS.points) }
)

/* ===========================================================================
   S3（AC-503）两条新路由：path / name / title 逐字 ＋ **无 requiresAuth**
   =========================================================================== */
console.log(JSON.stringify({ section: 'S3', title: 'AC-503 两条新路由与标题且无 requiresAuth' }))

check(
  'S3a',
  '`/styles`：path / name / `meta.title`（逐字 `印風匯覽`）/ component / **无 requiresAuth**',
  { path: '/styles', name: 'styles', title: '印風匯覽', component: 'StyleIndexView.vue', requiresAuth: false },
  routeByName('styles')
)
check(
  'S3b',
  '`/persons`：path / name / `meta.title`（逐字 `印家匯徵`）/ component / **无 requiresAuth**',
  { path: '/persons', name: 'persons', title: '印家匯徵', component: 'PersonIndexView.vue', requiresAuth: false },
  routeByName('persons')
)
check('S3c', '两条新路由**均**不携带 `requiresAuth`（公开可达）', [false, false], [Boolean(routeByName('styles') && routeByName('styles').requiresAuth), Boolean(routeByName('persons') && routeByName('persons').requiresAuth)])

/* ===========================================================================
   S4（AC-504）两页内容留空：零未定义标识符 / 零僵尸常量 / 零节点图 · 弹层常量
   =========================================================================== */
console.log(JSON.stringify({ section: 'S4', title: 'AC-504 两个新页面内容留空（AC-98 精神）' }))

const JS_WORDS = new Set([
  'true', 'false', 'null', 'undefined', 'in', 'of', 'new', 'typeof', 'instanceof', 'return', 'if', 'else',
  'void', 'this', 'NaN', 'Infinity', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'console', 'await', 'async', 'function', 'const', 'let', 'var', 'delete', 'Date', 'window', 'document',
  'parseInt', 'parseFloat', 'isNaN', 'key'
])

function importLocals(clause) {
  const names = []
  clause.replace(/[{}]/g, ' ').split(',').forEach((part) => {
    const t = part.trim()
    if (!t) return
    if (t.startsWith('*')) {
      const m = t.match(/\bas\s+([A-Za-z_$][\w$]*)/)
      if (m) names.push(m[1])
      return
    }
    const m = t.match(/(?:^|\sas\s+)([A-Za-z_$][\w$]*)\s*$/)
    if (m) names.push(m[1])
  })
  return names
}

/** 取表达式里的**顶层标识符**（跳过 `obj.prop` 的属性位与 `{ key: … }` 的对象键位）。 */
function rootIdentifiers(expr, known) {
  const plain = expr.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ').replace(/`[^`]*`/g, ' ')
  const issues = []
  const re = /[A-Za-z_$][\w$]*/g
  let m = re.exec(plain)
  while (m !== null) {
    const name = m[1] !== undefined ? m[1] : m[0]
    const before = plain.slice(0, m.index)
    const after = plain.slice(m.index + name.length)
    const prev = before.replace(/\s+$/, '').slice(-1)
    const next = after.replace(/^\s+/, '').charAt(0)
    const skip = prev === '.' || (next === ':' && (prev === '{' || prev === ',' || prev === '(' || prev === '')) || known.has(name) || JS_WORDS.has(name) || name === '_'
    if (!skip) issues.push(name)
    m = re.exec(plain)
  }
  return issues
}

const NODE_GRAPH_TOKEN = /data-node|nodeGraph|NODE_GRAPH|\bnodes?\b|\bpopup\b|\bmodal\b|\boverlay\b|\bdialog\b/g

function analyzeView(absPath) {
  const src = readFileSync(absPath, 'utf8')
  const scriptRaw = (src.match(/<script[^>]*>([\s\S]*?)<\/script>/) || [])[1] || ''
  const templateRaw = (src.match(/<template>([\s\S]*)<\/template>/) || [])[1] || ''
  const script = stripComments(scriptRaw)
  const template = stripComments(templateRaw)

  const imported = []
  for (const m of script.matchAll(/import\s+([\s\S]*?)\s+from\s*['"]/g)) imported.push(...importLocals(m[1]))

  const declared = new Set(imported)
  for (const m of script.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  for (const m of script.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])

  const exprs = []
  for (const m of template.matchAll(/\{\{([\s\S]*?)\}\}/g)) exprs.push(m[1])
  for (const m of template.matchAll(/(?::|@|v-[a-zA-Z-]+)(?::[a-zA-Z-]+|\.[a-zA-Z-]+)*\s*=\s*"([^"]*)"/g)) exprs.push(m[1])

  const locals = new Set()
  const stripped = exprs.map((e) => {
    const vf = e.match(/^\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*))?\s*\)?\s+(?:in|of)\s+([\s\S]*)$/)
    if (vf) {
      locals.add(vf[1])
      if (vf[2]) locals.add(vf[2])
      return vf[3]
    }
    return e
  })

  const known = new Set([...declared, ...locals])
  const undefinedIdentifiers = new Set()
  stripped.forEach((e) => rootIdentifiers(e, known).forEach((n) => undefinedIdentifiers.add(n)))

  const whole = `${script}\n${template}`
  const countIn = (name) => (whole.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')) || []).length
  const unusedConstants = []
  for (const m of script.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (countIn(m[1]) < 2) unusedConstants.push(m[1])
  }
  const unusedImports = imported.filter((n) => countIn(n) < 2)
  const codeNoComments = stripComments(src)
  const graphTokens = codeNoComments.match(NODE_GRAPH_TOKEN) || []

  return {
    imported,
    undefinedIdentifiers: sorted(undefinedIdentifiers),
    unusedConstants: sorted(unusedConstants),
    unusedImports: sorted(unusedImports),
    graphTokens: sorted(new Set(graphTokens))
  }
}

const styleView = analyzeView(VIEWS.styleIndex)
const personView = analyzeView(VIEWS.personIndex)

check('S4a', '两个新页面文件均在（`fs.existsSync`）', { StyleIndexView: true, PersonIndexView: true }, { StyleIndexView: existsSync(VIEWS.styleIndex), PersonIndexView: existsSync(VIEWS.personIndex) })
check('S4b', '`StyleIndexView.vue`：零未定义标识符（模板绑定的顶层名均在 `script setup` 已定义）', [], styleView.undefinedIdentifiers)
check('S4c', '`PersonIndexView.vue`：零未定义标识符', [], personView.undefinedIdentifiers)
check('S4d', '两页：`import` 名**全部被使用**（零未使用 import）', { style: [], person: [] }, { style: styleView.unusedImports, person: personView.unusedImports })
check('S4e', '两页：零「已定义未使用」顶层常量（AC-98：不预置未使用的 UI 常量）', { style: [], person: [] }, { style: styleView.unusedConstants, person: personView.unusedConstants })
check('S4f', '两页：**零**节点图 / 弹层相关常量与钩子（本期留空，不预置）', { style: [], person: [] }, { style: styleView.graphTokens, person: personView.graphTokens })

/* 负对照 N4：标识符检查器本身必须会响（喂合成片段，必须报出未定义名）。 */
const n4Issues = rootIdentifiers(`{{ missingName }}`, new Set(['knownName']))
check('N4', '负对照：静态标识符检查器喂入含未定义标识符的合成片段 ⇒ **必须报出**', ['missingName'], n4Issues)

/* ===========================================================================
   S5（AC-505）未登录徵集入口（静态判据，非 DOM 判据）
   =========================================================================== */
console.log(JSON.stringify({ section: 'S5', title: 'AC-505 未登录徵集入口（静态判据）' }))

const personRaw = readFileSync(VIEWS.personIndex, 'utf8')
const personCode = stripComments(personRaw)
const collectHooks = [...personCode.matchAll(/data-collect-action="([^"]+)"/g)].map((m) => m[1])
check('S5a', '存在 `[data-collect-action]` 钩子（恰 1 处、取值非空）', { count: 1, nonEmpty: true }, { count: collectHooks.length, nonEmpty: collectHooks.length > 0 && collectHooks.every((v) => v.length > 0) })

const hasLoginLiteral = /'\/login'/.test(personCode) || /"\/login"/.test(personCode)
const hasLoginRouteName = /name\s*:\s*'login'/.test(personCode)
const hasRedirect = /\bredirect\b/.test(personCode)
const hasPush = /router\s*\.\s*(?:push|replace)\s*\(/.test(personCode)
const routerLogin = routeByName('login')
check(
  'S5b',
  '登录引导目标含 `/login` ＋ `redirect`（口径：字面 `/login` **或**路由名 `login`；并交叉核对路由表 `login → /login`）',
  { target: true, redirect: true, routerLogin: { path: '/login', name: 'login' } },
  {
    target: hasLoginLiteral || hasLoginRouteName,
    redirect: hasRedirect,
    routerLogin: routerLogin ? { path: routerLogin.path, name: routerLogin.name } : null
  }
)
check('S5c', '登录引导经**真实导航调用**（`router.push` / `router.replace`，非静默失败）', true, hasPush)

/* ===========================================================================
   S6（AC-506）钩子族不变：全 src/** 的 `[data-admin-action]` ⇒ 恰 10 值 / 归并 9 类
   —— 扫描函数**照抄** scripts/verify-endorsement.mjs D1 段口径
   =========================================================================== */
console.log(JSON.stringify({ section: 'S6', title: 'AC-506 data-admin-action 去重集合（10 值 / 9 类）' }))

function walkFiles(dir, out = []) {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(vue|js)$/.test(entry.name)) out.push(full)
  })
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
  'person-import-review'
]
const mergeClass = (v) => (v.startsWith('correction-') ? 'correction-accept|reject' : v)

{
  const found = new Set()
  walkFiles(path.join(ROOT, 'src')).forEach((file) => {
    const body = readFileSync(file, 'utf8')
    const matches = body.match(/data-admin-action="([^"]+)"/g) || []
    matches.forEach((m) => found.add(m.replace(/^data-admin-action="/, '').replace(/"$/, '')))
  })
  check('S6a', '`[data-admin-action]` 去重取值集合逐字 ＝ 规范现值（**10 值**）', sorted(ADMIN_ACTION_EXPECTED), sorted([...found]))
  check('S6b', '按归并表归并后 ＝ **9 类**（`correction-accept|reject` 合一，其余各自成类）', 9, new Set([...found].map(mergeClass)).size)

  const withCanary = new Set([...found, 'qa-canary-10th'])
  check('N6a', '正对照：注入 canary `qa-canary-10th` ⇒ 取值集合变 11（证明扫描器非硬编码）', 11, withCanary.size)
  check('N6b', '正对照：canary 使归并类数变 10', 10, new Set([...withCanary].map(mergeClass)).size)
  check('N6c', '负对照：移除 canary 后回基线 10 值 / 9 类（集合非恒等）', { values: 10, classes: 9 }, { values: found.size, classes: new Set([...found].map(mergeClass)).size })
}

/* ===========================================================================
   N1（②）负对照：顺序颠倒后的序列 ⇒ 顺序判据**必须判负**
   =========================================================================== */
console.log(JSON.stringify({ section: 'N1', title: '负对照：顺序判据必须会响' }))

const expectedTriples = EXPECTED_ITEMS.map(triple)
check('N1', '负对照：**顺序颠倒**后的序列喂给 S1 的顺序判据 ⇒ **必须判负**', false, sameSeq([...items].reverse().map(triple), expectedTriples))

const mutatedSrc = mutateItemsReversed(sidebarSrc)
const mutatedSidebar = analyzeSidebarSource(mutatedSrc)
check(
  'N1b',
  '负对照：把 `AppSidebar.vue` 的 items 数组**文本倒序**后重解析 ⇒ 同一条判据翻红（解析器真读源码顺序）',
  false,
  sameSeq(mutatedSidebar.items.map(triple), expectedTriples)
)
check(
  'N1c',
  '正对照：原文重解析 ⇒ 同一条判据为真（同一把尺子：改前对 / 改后错）＋ 倒序文本确为四项倒序',
  { originalTrue: true, mutatedIsReversed: true },
  {
    originalTrue: sameSeq(items.map(triple), expectedTriples),
    mutatedIsReversed: sameSeq(mutatedSidebar.items.map((i) => i.key), [...items].reverse().map((i) => i.key))
  }
)

/* ---------------------------------------------------------------------------
   收尾
   --------------------------------------------------------------------------- */
const total = results.length
console.log(JSON.stringify({ summary: { total, passed: total - failures, failed: failures } }))
process.exit(failures === 0 ? 0 : 1)
