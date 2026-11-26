#!/usr/bin/env node
/**
 * 玺爱 · **身份标记（徽号旁小印形标签）** 自检
 * =====================================================================
 * 口径（派单方裁定，覆盖早先单字方案）：
 *   · `admin`     ⇒ 上屏 **掌書記使**
 *   · `sub-admin` ⇒ 上屏 **掌書記**
 *   · `user` / `''` / `null` / `undefined` / 任何未知值 ⇒ **零渲染**（空串，不占位）
 *
 * 判据分段：
 *   A 取字面：`roleMarkText()` 五值逐字；与 `ROLE_LABEL` **逐字相等**（防第二套字面）。
 *   B 身份文案面：`accountLabel()` 三值文案逐字未被改动（掌書記使賬號 / 掌書記賬號 / 普通用戶賬號）。
 *   C 单一真源：两串仍**只在** `roleLabels.js` 出现一次；`roleMarkText` 全仓恰 1 定义 + 1 调用。
 *   D 展示件接线：`RoleMark.vue` 门控 / 提示语取值；`AppHeader.vue` 插在昵称之后、`·` 之前；
 *      样式与模板同属 `RoleMark.vue` 一处；无虚线、无 hover 变色、无 `cursor: pointer`、无新色值。
 *   E 判定零改动：`session.js::isAdmin` 表达式逐字未动（标记纯展示，不进任何判定）。
 *
 * 零依赖、零网络、零浏览器：纯函数断言 ＋ 只读源码静态断言。
 */
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')

const labels = await import(path.join(ROOT, 'src/data/roleLabels.js'))
const { ROLE_LABEL, accountLabel, roleMarkText } = labels

/* ---------------------------------------------------------------- 断言骨架 */
let failures = 0
const results = []
function check(id, desc, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (!pass) failures += 1
  results.push({ id, pass })
  console.log(JSON.stringify({ id, case: desc, pass, expected, actual }))
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const countOf = (text, needle) => text.split(needle).length - 1
/** 剥注释（`/* *\/` / `//` / `<!-- -->`）：形态与判定类断言只看**真代码**，不被文档字句误伤。 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/<!--[\s\S]*?-->/g, '')

/* ============================================================== A 取字面 */
console.log(JSON.stringify({ section: 'A', title: '取字面：roleMarkText 五值逐字，且与 ROLE_LABEL 逐字相等' }))
check('A1', "roleMarkText('admin') ＝ 掌書記使", '掌書記使', roleMarkText('admin'))
check('A2', "roleMarkText('sub-admin') ＝ 掌書記", '掌書記', roleMarkText('sub-admin'))
check('A3', "roleMarkText('user') ＝ ''（普通用户零渲染，不回落原文）", '', roleMarkText('user'))
check('A4', "空串 / null / undefined ＝ ''（三值）", ['', '', ''], [roleMarkText(''), roleMarkText(null), roleMarkText(undefined)])
check('A5', '表外未知值（`owner` / `guest`）＝ 空串（零渲染，不回显角色值）', ['', ''], [roleMarkText('owner'), roleMarkText('guest')])
check(
  'A6',
  '逐字派生自 ROLE_LABEL：每个键取字 === ROLE_LABEL 对应值（**无第二套字面**）',
  Object.keys(ROLE_LABEL).map((k) => ROLE_LABEL[k]),
  Object.keys(ROLE_LABEL).map((k) => roleMarkText(k))
)
check('A7', '未知值零渲染 ⇒ 空串集合恰 5 枚（user/空串/null/undefined/owner）', ['', '', '', '', ''], [
  roleMarkText('user'),
  roleMarkText(''),
  roleMarkText(null),
  roleMarkText(undefined),
  roleMarkText('owner')
])

/* ======================================================== B 身份文案面 */
console.log(JSON.stringify({ section: 'B', title: 'accountLabel 三值文案逐字未改动（title/aria-label 复用的既有单点）' }))
check('B1', "accountLabel('admin') ＝ 掌書記使賬號（逐字）", '掌書記使賬號', accountLabel('admin'))
check('B2', "accountLabel('sub-admin') ＝ 掌書記賬號（逐字）", '掌書記賬號', accountLabel('sub-admin'))
check('B3', "accountLabel('user') ＝ 普通用戶賬號（逐字）", '普通用戶賬號', accountLabel('user'))
check('B4', "accountLabel(null) ＝ 普通用戶賬號（逐字，兜底未动）", '普通用戶賬號', accountLabel(null))

/* ====================================================== C 单一真源面 */
console.log(JSON.stringify({ section: 'C', title: '单一真源：两串只在 roleLabels.js；roleMarkText 恰 1 定义 + 1 调用' }))
const LABELS = read('src/data/roleLabels.js')
check('C1', 'roleMarkText 恰 1 处**定义**且在 roleLabels.js', 1, countOf(LABELS, 'export function roleMarkText'))
const callHits = []
for (const rel of ['src/components/RoleMark.vue', 'src/components/AppHeader.vue']) {
  const src = read(rel)
  src.split('\n').forEach((line, i) => {
    /* `import … roleMarkText` 是引入、不是调用 —— 调用点只认使用行。 */
    if (line.includes('roleMarkText') && !/^\s*import\b/.test(line)) callHits.push(`${rel}:${i + 1}`)
  })
}
check('C2', 'roleMarkText 恰 1 处**调用**（RoleMark.vue 内，import 行不计，且调的是 props.role）', ['src/components/RoleMark.vue: `const text = computed(() => roleMarkText(props.role))`'], callHits.map((hit) => {
  const line = read('src/components/RoleMark.vue').split('\n')[Number(hit.split(':')[1]) - 1].trim()
  return `${hit.split(':')[0]}: \`${line}\``
}))
/* 两串字面（掌書記使 / 掌書記）剥注释后只在 roleLabels.js 出现 —— RoleMark / AppHeader 零复制。 */
const others = ['src/components/RoleMark.vue', 'src/components/AppHeader.vue'].filter((rel) => {
  const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
  return src.includes('掌書記使') || src.includes('掌書記')
})
check('C3', 'RoleMark / AppHeader **零字面复制**（两串只在 roleLabels.js 出现一次）', [], others)

/* ====================================================== D 展示件接线面 */
console.log(JSON.stringify({ section: 'D', title: '接线：门控 / 提示语 / 插入位 / 样式单处 / 非按钮形态' }))
const MARK = read('src/components/RoleMark.vue')
const MARK_CODE = stripComments(MARK)
const HEADER = read('src/components/AppHeader.vue')
check('D1', 'RoleMark 门控：`v-if="text !== \'\'"`（空串即零渲染）', true, MARK.includes("v-if=\"text !== ''\""))
check('D2', 'RoleMark 模板渲染取字、带 data-role-mark / :title / :aria-label', true, [
  'class="role-mark"',
  'data-role-mark',
  ':title="identity"',
  ':aria-label="identity"',
  '{{ text }}'
].every((needle) => MARK.includes(needle)))
check('D3', 'title/aria-label 复用既有 accountLabel（剥注释后代码零身份文案字面 ⇒ 不另写第二套）', true, MARK_CODE.includes('accountLabel(props.role)') && !MARK_CODE.includes('賬號') && !MARK_CODE.includes('掌書記'))
check('D4', 'AppHeader：import RoleMark 且插在昵称之后、`·` 之前', true, HEADER.includes("import RoleMark from '../components/RoleMark.vue'") && HEADER.includes('{{ user.nickname }}<RoleMark :role="user.role" /> · {{ user.phone }}</template>'))
check('D5', '菜单其余项 / 登出 / 金 / 头像逐字未动（四条原样断言）', true, [
  'type="button" @click="go(\'my-corrections\')"',
  'type="button" @click="go(\'my-photos\')"',
  'type="button" @click="go(\'points\')"',
  'data-entry="connect-feicui"',
  'data-logout',
  ':disabled="logoutView.disabled"',
  '<b>{{ gold }}</b><span>金</span>',
  '{{ avatarGlyph }}'
].every((needle) => HEADER.includes(needle)))
const roleMarkFiles = []
for (const rel of ['src/components/RoleMark.vue', 'src/styles/base.css', 'src/components/AppHeader.vue']) {
  if (fs.existsSync(path.join(ROOT, rel)) && read(rel).includes('role-mark')) roleMarkFiles.push(rel)
}
check('D6', '样式与模板同属 `RoleMark.vue` 一处（base.css / AppHeader 零 role-mark）', ['src/components/RoleMark.vue'], roleMarkFiles)
check(
  'D7',
  '形态红线：实线既有令牌、无虚线、无 hover 变色、无 cursor:pointer、无新颜色字面量',
  true,
  MARK_CODE.includes('border: 1px solid var(--c-line)') &&
    !MARK_CODE.includes('dashed') &&
    !/cursor\s*:\s*pointer/.test(MARK_CODE) &&
    !/\.role-mark\s*:hover/.test(MARK_CODE) &&
    !/#[0-9a-fA-F]{3,8}|rgba?\(/.test(MARK_CODE)
)
check('D8', '尺寸口径：padding 1px 4px / border-radius 2px / 字号比正文小一级 / vertical-align middle / 左边距 4px', true, [
  'padding: 1px 4px',
  'border-radius: 2px',
  'font-size: var(--t-xs)',
  'vertical-align: middle',
  'margin-left: 4px'
].every((needle) => MARK_CODE.includes(needle)))

/* ====================================================== E 判定零改动面 */
console.log(JSON.stringify({ section: 'E', title: '判定零改动：标记纯展示，不进任何判定' }))
const SESSION = read('src/data/session.js')
check(
  'E1',
  'session.js::isAdmin 表达式逐字未动',
  true,
  SESSION.includes("export const isAdmin = computed(() => state.user !== null && state.user.role === 'admin')")
)
check('E2', 'RoleMark.vue 零判定（剥注释后）：不出现 `isAdmin` / `role ===`', true, !/isAdmin|role\s*===/.test(MARK_CODE))
const LABELS_CODE = stripComments(LABELS)
check('E3', 'roleLabels.js 零权限逻辑（剥注释后）：无 `===` 比较、无 `if (` 分支', 0, countOf(LABELS_CODE, '===') + countOf(LABELS_CODE, 'if ('))
check('E4', 'roleLabels.js 无外部依赖（零 import，不引入环）', 0, countOf(LABELS, '\nimport '))

/* ------------------------------------------------------------------ 汇总 */
const failed = results.filter((r) => !r.pass).map((r) => r.id)
console.log(
  JSON.stringify({
    summary: { total: results.length, passed: results.length - failures, failed: failures },
    failed_ids: failed,
    note: '离线自检：纯函数断言 ＋ 只读源码静态断言，零网络、零浏览器、零生产读写。'
  })
)
process.exit(failed.length === 0 ? 0 : 1)
