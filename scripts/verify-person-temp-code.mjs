#!/usr/bin/env node
/**
 * 玺爱 · **`tmp-` 暂存印人编号（详情页读取 / 导航面 ＋ 管理员编辑入口收窄）** 离线自检
 * ============================================================================
 * **本地、离线、零网络、零生产读写、零浏览器**：被测件只有两处 ——
 *   · `src/services/persons.js`（`isTempPersonCode` / `resolveFormalPersonCode` /
 *     `resolveTempPersonCode` / `canEditPersonInfo`）——**真函数直接调用**；
 *   · `src/views/PersonDetailView.vue`（静态接线：文案 / `data-*` / 门控 / `replace`）。
 * 所有解析用例都**显式注入假行集**（不走 `listPersons()` ⇒ 不碰 localStorage、不碰云端快照）；
 * `router` 一律注入**假 router**（只记录 `replace` 调用）⇒ 断言调用次数与参数。
 *
 * 覆盖（逐条硬口）：
 *   A  `isTempPersonCode`：`tmp-` ⇒ 真；`PR…` / 空 / 大写前缀 ⇒ 假；前缀单点
 *      ＝ 既有 `TEMP_PERSON_ID_PREFIX`（**不新造第二套前缀字面**）。
 *   B  渲染门 `canEditPersonInfo`：管理员 ＋ 正式编号 ⇒ 真（**与改前逐字一致**）；
 *      管理员 ＋ `tmp-` ⇒ **假（入口零渲染）**；旧单参调用 ⇒ 行为不变。
 *   C  解析优先级：同 `proposal_id` 命中 ⇒ 取该行 `code`（**优先于 `card_id`**）；
 *      无 / 未中 `proposal_id` ⇒ 同 `card_id` 命中；两键皆空 / 皆不中 / 源行缺席 /
 *      只命中另一 `tmp-` 行 ⇒ **`null`（不编造、不回跳）**。
 *   D  `router.replace`：解析成功 ⇒ **恰 1 次**且参数逐字 `{name:'personDetail',
 *      params:{code:<正式编号>}}`；失败路径 ⇒ **0 次**；正式 `PR…` 编号 ⇒ 0 次
 *      且**行集一次都不读**（毒行集：读即抛）。
 *   E  静态接线：诚实提示文案 / `data-person-temp-row` / 短状态文案 / `replace` 而非
 *      `push` / 前缀单点 / 视图零网络调用。
 *
 * 纪律：断言失败 ⇒ 退出码 1；不打印任何令牌 / 手机号；**不改任何被测件**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
/* 被测件真源（直接 import；本仓 `package.json` `type: module` ⇒ 与 `verify-sync-review.mjs`
   同一口径）。解析用例全部注入假行集 ⇒ 不触发 `listPersons()` / 云端读取面。 */
import * as persons from '../src/services/persons.js'
import { setUser } from '../src/data/session.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const PERSONS_SRC = read('src/services/persons.js')
const VIEW_SRC = read('src/views/PersonDetailView.vue')

/* ---------------------------------------------------------------- 断言骨架 */
let total = 0
let passed = 0
const failedIds = []
let currentSection = 'A'
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

function check(id, testCase, expected, actual) {
  total += 1
  const pass = canon(expected) === canon(actual)
  if (pass) passed += 1
  else failedIds.push(id)
  const stat = (sectionStats[currentSection] = sectionStats[currentSection] || { total: 0, failed: 0 })
  stat.total += 1
  if (!pass) stat.failed += 1
  console.log(JSON.stringify({ id, case: testCase, pass, expected, actual }))
}

const section = (id, title) => {
  currentSection = id
  console.log(JSON.stringify({ section: id, title }))
}
const countOf = (text, needle) => text.split(needle).length - 1

/** 剥注释（`<!-- -->` / `/* *\\/`、行首 `//` `*`）——产品件注释里逐字写着这些标识符，
    不剥会把说明当实码（口径照本仓既有套件 `verify-person-update.mjs`）。 */
function stripComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}
/** 视图**剥注释后**的源码（代码计数一律用它；文案 / `data-*` 判据用原源码）。 */
const VIEW_CLEAN = stripComments(VIEW_SRC)

/* ---------------------------------------------------------------- 假数据 */
/** 云端正式行（照线上实据 `xiai_persons/PR000000571` 同形）。 */
const FORMAL_ROW = Object.freeze({
  _id: 'PR000000571',
  id: 'PR000000571',
  code: 'PR000000571',
  card_id: '100000574',
  proposal_id: 'pp-mwh3srta-2uidjx',
  name: '劉垚',
  dynasty: '清',
  created_by: 'u-91c5c051ff4eb59d'
})
/** 本机镜像暂存行（同一条人的 `tmp-` 行）。 */
const TEMP_ROW = Object.freeze({
  id: 'tmp-000002',
  code: 'tmp-000002',
  card_id: '100000574',
  proposal_id: 'pp-mwh3srta-2uidjx',
  name: '劉垚'
})

/** 毒行集：任何**读取**（`find` / `filter` / `map` / `forEach` / 迭代 / `length`）即抛。 */
function poisonRows() {
  const target = []
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === 'find' || prop === 'filter' || prop === 'map' || prop === 'forEach' || prop === 'length' || prop === Symbol.iterator) {
        throw new Error('行集被讀取了（正式编号不得触发解析）')
      }
      return Reflect.get(obj, prop)
    }
  })
}

/** 假 router：只记录 `replace` 调用（不导航、不抛）。 */
function fakeRouter() {
  const calls = []
  return {
    calls,
    replace(location) {
      calls.push(JSON.parse(JSON.stringify(location)))
      return Promise.resolve(location)
    }
  }
}

/* ===========================================================================
   A. `isTempPersonCode`：前缀单点（真源 `TEMP_PERSON_ID_PREFIX`）
   =========================================================================== */
section('A', 'isTempPersonCode：tmp- 真 / PR… 假 / 前缀单点不新造第二套字面')
check('A1', '`tmp-000002` ⇒ 真', true, persons.isTempPersonCode('tmp-000002'))
check('A2', '`PR000000571` ⇒ 假', false, persons.isTempPersonCode('PR000000571'))
check('A3', '空串 / `null` / `undefined` ⇒ 假（不误伤缺值）', [false, false, false], [
  persons.isTempPersonCode(''),
  persons.isTempPersonCode(null),
  persons.isTempPersonCode(undefined)
])
check('A4', '带空白的 `  tmp-000002  ` ⇒ 真（去空白后判前缀）', true, persons.isTempPersonCode('  tmp-000002  '))
check('A5', '`TMP-000002` ⇒ 假（前缀大小写敏感，不放宽）', false, persons.isTempPersonCode('TMP-000002'))
check(
  'A6',
  '前缀单点：`isTempPersonCode` 函数体只用既有 `TEMP_PERSON_ID_PREFIX`，零第二套 `\'tmp-\'` 字面',
  { usesConst: true, literalInBody: 0 },
  (() => {
    const start = PERSONS_SRC.indexOf('export function isTempPersonCode(')
    const body = start === -1 ? '' : PERSONS_SRC.slice(start, PERSONS_SRC.indexOf('\n}\n', start))
    return {
      usesConst: body.includes('TEMP_PERSON_ID_PREFIX'),
      literalInBody: countOf(body, "'tmp-'") + countOf(body, '"tmp-"')
    }
  })()
)
check('A7', '静态：`TEMP_PERSON_ID_PREFIX = \'tmp-\'` 全 `src/**` 恰 1 处定义（单点）', 1, countOf(PERSONS_SRC, "TEMP_PERSON_ID_PREFIX = 'tmp-'"))

/* ===========================================================================
   B. 渲染门 `canEditPersonInfo`：管理员 ＋ 非 tmp-（入口零渲染）
   =========================================================================== */
section('B', 'canEditPersonInfo：tmp- 恒假（入口零渲染）；正式编号与旧单参调用行为不变')
const ADMIN = Object.freeze({ id: 'u-test-admin', role: 'admin' })
const GUEST = Object.freeze({ id: 'u-test-user', role: 'user' })
/* 无 `actor` 路径（＝详情页真实调用形态：`isAdminSession()`）；用内存登录态驱动
   （`storage.js` 在 Node 下 `window` 缺位 ⇒ 写入被既有 try/catch 吞掉，零副作用）。 */
setUser({ id: 'u-test-admin', role: 'admin' })
const adminSession = persons.canEditPersonInfo() === true
check('B1', '管理员会话 ＋ 正式编号 ⇒ 真（**与改前逐字一致**）', true, persons.canEditPersonInfo(undefined, 'PR000000571'))
check('B2', '管理员会话 ＋ `tmp-000002` ⇒ **假（入口零渲染）**', false, persons.canEditPersonInfo(undefined, 'tmp-000002'))
check('B6', '无 actor 形态实测：管理员会话取到真（B2 的 tmp- 收窄才有意义）', true, adminSession)
setUser(null)
check('B3', '旧单参调用 `canEditPersonInfo(adminActor)` ⇒ 真（缺省不按编号收窄，旧行为不变）', true, persons.canEditPersonInfo(ADMIN))
check('B4', '游客 ＋ 正式编号 ⇒ 假（非管理员恒拒）', false, persons.canEditPersonInfo(GUEST, 'PR000000571'))
check('B5', '显式管理员 actor ＋ `tmp-` ⇒ 假（编号门先于身份门）', false, persons.canEditPersonInfo(ADMIN, 'tmp-000002'))
check(
  'B7',
  '负对照（改前口径）：只按管理员判 ⇒ 暂存行上入口会渲染 —— 正是本单要收掉的那个必然失败的按钮',
  { before: true, after: false },
  { before: persons.canEditPersonInfo(ADMIN) && persons.isTempPersonCode('tmp-000002'), after: persons.canEditPersonInfo(ADMIN, 'tmp-000002') }
)
/* 静态接线：视图唯一调用点带上 `wantedCode`；模板门与钩子数不变。 */
check(
  'B8',
  '静态：视图渲染门恰 1 处且传入 `wantedCode`；模板 `v-if="canEditPerson"`；`data-action="person-edit"` 仍恰 1',
  { callSites: 1, passesWantedCode: true, vIf: 1, hooks: 1 },
  {
    callSites: countOf(VIEW_CLEAN, 'persons.canEditPersonInfo('),
    passesWantedCode: /persons\.canEditPersonInfo\([^)]*wantedCode/.test(VIEW_CLEAN),
    vIf: countOf(VIEW_CLEAN, 'v-if="canEditPerson"'),
    hooks: countOf(VIEW_CLEAN, 'data-action="person-edit"')
  }
)

/* ===========================================================================
   C. 解析优先级：proposal_id → card_id → null（不编造）
   =========================================================================== */
section('C', 'resolveFormalPersonCode：proposal_id 优先、card_id 次之、皆无 ⇒ null（不编造）')
const TEMP_NO_PROPOSAL = Object.freeze({ id: 'tmp-000007', code: 'tmp-000007', proposal_id: '', card_id: '100000574' })
const TEMP_NO_KEYS = Object.freeze({ id: 'tmp-000011', code: 'tmp-000011', proposal_id: '', card_id: '' })
const TEMP_MISS_BOTH = Object.freeze({ id: 'tmp-000013', code: 'tmp-000013', proposal_id: 'pp-none', card_id: '999999999' })
const ROW_X = Object.freeze({ _id: 'PR000000111', code: 'PR000000111', proposal_id: 'pp-A', card_id: '111111111' })
const ROW_Y = Object.freeze({ _id: 'PR000000222', code: 'PR000000222', proposal_id: 'pp-Z', card_id: '111111111' })

check('C1', '同一 `proposal_id` 命中 ⇒ 取该行 `code`（线上实据同形：tmp-000002 → PR000000571）', 'PR000000571', persons.resolveFormalPersonCode('tmp-000002', [TEMP_ROW, FORMAL_ROW]))
check('C2', '源行无 `proposal_id` ⇒ 同 `card_id` 命中', 'PR000000571', persons.resolveFormalPersonCode('tmp-000007', [TEMP_NO_PROPOSAL, FORMAL_ROW]))
check('C3', '优先级：`proposal_id` 与 `card_id` 分别指向两行 ⇒ **取 `proposal_id` 那行**', 'PR000000111', persons.resolveFormalPersonCode('tmp-000002', [{ ...TEMP_ROW, proposal_id: 'pp-A', card_id: '111111111' }, ROW_X, ROW_Y]))
check('C4', '源行 `proposal_id` 有值但无人命中 ⇒ 落 `card_id` 兜底（不因一档未中就放弃）', 'PR000000571', persons.resolveFormalPersonCode('tmp-000013', [{ ...TEMP_MISS_BOTH, card_id: '100000574' }, FORMAL_ROW]))
check('C5', '两键皆空 ⇒ `null`（不编造、不猜）', null, persons.resolveFormalPersonCode('tmp-000011', [TEMP_NO_KEYS, FORMAL_ROW]))
check('C6', '两键皆不中 ⇒ `null`（不编造）', null, persons.resolveFormalPersonCode('tmp-000013', [TEMP_MISS_BOTH, FORMAL_ROW]))
check('C7', '源行不在行集 ⇒ `null`（缺行不得臆造编号）', null, persons.resolveFormalPersonCode('tmp-000009', [FORMAL_ROW]))
check('C8', '只命中另一 `tmp-` 行 ⇒ `null`（绝不跳回临时行）', null, persons.resolveFormalPersonCode('tmp-000013', [TEMP_MISS_BOTH, { id: 'tmp-000014', code: 'tmp-000014', proposal_id: 'pp-none', card_id: '999999999' }]))
check('C9', '正式 `PR…` 入参 ⇒ `null` 且**行集一次都不读**（毒行集读即抛）', null, (() => {
  try {
    return persons.resolveFormalPersonCode('PR000000571', poisonRows())
  } catch (error) {
    return `THREW:${error.message}`
  }
})())
check('C10', '行集内只有正式行、无源行的 `tmp-` ⇒ `null`（不拿别人当自己）', null, persons.resolveFormalPersonCode('tmp-000002', [FORMAL_ROW]))

/* ===========================================================================
   D. `router.replace`：成功恰 1 次 / 失败 0 次 / 正式编号 0 次
   =========================================================================== */
section('D', 'resolveTempPersonCode：replace 只在解析成功时发生（假 router 断次数与参数）')
const routerOk = fakeRouter()
const okResult = await persons.resolveTempPersonCode('tmp-000002', { router: routerOk, rows: [TEMP_ROW, FORMAL_ROW] })
check('D1', '解析成功 ⇒ `redirected: true` ＋ `formal` 正确', { temp: true, formal: 'PR000000571', redirected: true }, { temp: okResult.temp, formal: okResult.formal, redirected: okResult.redirected })
check('D2', '解析成功 ⇒ `router.replace` **恰 1 次**', 1, routerOk.calls.length)
check('D3', '参数逐字 `{name:\'personDetail\', params:{code:\'PR000000571\'}}`（**replace 而非 push**）', { name: 'personDetail', params: { code: 'PR000000571' } }, routerOk.calls[0])

const routerMiss = fakeRouter()
const missResult = await persons.resolveTempPersonCode('tmp-000013', { router: routerMiss, rows: [TEMP_MISS_BOTH, FORMAL_ROW] })
check('D4', '解析不到 ⇒ 不回跳、不报错：`redirected: false` ＋ `formal: null`', { temp: true, formal: null, redirected: false }, { temp: missResult.temp, formal: missResult.formal, redirected: missResult.redirected })
check('D5', '解析不到 ⇒ `router.replace` **0 次**', 0, routerMiss.calls.length)

const routerFormal = fakeRouter()
const formalResult = await persons.resolveTempPersonCode('PR000000571', { router: routerFormal, rows: poisonRows() })
check('D6', '正式 `PR…` 编号 ⇒ 行为与改前一致：不解析、`replace` **0 次**、行集不读', { temp: false, formal: null, redirected: false, calls: 0 }, { temp: formalResult.temp, formal: formalResult.formal, redirected: formalResult.redirected, calls: routerFormal.calls.length })

const routerNoReplace = { replace: undefined }
const noRouterResult = await persons.resolveTempPersonCode('tmp-000002', { router: routerNoReplace, rows: [TEMP_ROW, FORMAL_ROW] })
check('D7', '解析成功但无可用 `router.replace` ⇒ 交回 `formal`、不抛、`redirected: false`（缺路由也不假报成功）', { formal: 'PR000000571', redirected: false }, { formal: noRouterResult.formal, redirected: noRouterResult.redirected })

check('D8', '静态：服务层只用 `router.replace(`、零 `router.push(`（不留坏历史的字面保证）', { replace: true, push: 0 }, { replace: PERSONS_SRC.includes('router.replace('), push: countOf(PERSONS_SRC, 'router.push(') })

/* ===========================================================================
   E. 详情页静态接线：短状态 / 诚实提示 / `data-person-temp-row` / 零网络
   =========================================================================== */
section('E', '详情页静态接线：解析中短状态、诚实提示、data-person-temp-row、视图零网络')
check('E1', '诚实提示文案逐字上屏：`本機暫存行尚未取得正式印人編號，暫不可編輯。`', true, VIEW_SRC.includes('本機暫存行尚未取得正式印人編號，暫不可編輯。'))
check('E2', '诚实提示节点带 `data-person-temp-row`', true, VIEW_SRC.includes('data-person-temp-row'))
check('E3', '解析中短状态文案 `正在對照雲端編號…` ＋ `data-person-temp-resolving`', { text: true, marker: true }, { text: VIEW_SRC.includes('正在對照雲端編號…'), marker: VIEW_SRC.includes('data-person-temp-resolving') })
check('E4', '视图解析经服务层单点 `persons.resolveTempPersonCode(`（恰 1 处，且注入 `router`）', { callSites: 1, injectsRouter: true }, { callSites: countOf(VIEW_CLEAN, 'persons.resolveTempPersonCode('), injectsRouter: /persons\.resolveTempPersonCode\([^)]*\{[^}]*router/.test(VIEW_CLEAN) })
check('E5', '视图判定经服务层单点 `persons.isTempPersonCode(`（不自写 `tmp-` 字面）', { callSites: 1, literal: 0 }, { callSites: countOf(VIEW_CLEAN, 'persons.isTempPersonCode('), literal: countOf(VIEW_CLEAN, "'tmp-'") + countOf(VIEW_CLEAN, '"tmp-"') })
check('E6', '静态：详情页零网络调用（解析只走既有读取面）', { fetch: 0, xhr: 0, axios: 0 }, { fetch: countOf(VIEW_CLEAN, 'fetch('), xhr: countOf(VIEW_CLEAN, 'XMLHttpRequest'), axios: countOf(VIEW_CLEAN, 'axios') })
check('E7', '静态：`isTempPersonCode` 全 `src/**` 恰 1 处定义（不立第二套判定）', ['src/services/persons.js'], (() => {
  const hits = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(js|vue|mjs)$/.test(entry.name) && /export function isTempPersonCode\(/.test(fs.readFileSync(full, 'utf8'))) {
        hits.push(path.relative(ROOT, full).split(path.sep).join('/'))
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  return hits.sort()
})())
/* 负对照：内存变异（不写被测件）—— 判据必须会响（由真翻假）。 */
const TEMP_ROW_MARKER = 'data-person-temp-row'
const TEMP_ROW_MESSAGE = '本機暫存行尚未取得正式印人編號，暫不可編輯。'
const judgeTempRow = (text) => text.includes(TEMP_ROW_MARKER)
const judgeMessage = (text) => text.includes(TEMP_ROW_MESSAGE)
check(
  'E8',
  '负对照①：内存抹掉 `data-person-temp-row` ⇒ 判据由真翻假（读真源、非常量）',
  { original: true, mutated: false },
  { original: judgeTempRow(VIEW_SRC), mutated: judgeTempRow(VIEW_SRC.replace(TEMP_ROW_MARKER, 'data-person-x')) }
)
check(
  'E9',
  '负对照②：内存改动诚实提示文案一个字 ⇒ 判据由真翻假（文案逐字钉住）',
  { original: true, mutated: false },
  { original: judgeMessage(VIEW_SRC), mutated: judgeMessage(VIEW_SRC.replace(TEMP_ROW_MESSAGE, TEMP_ROW_MESSAGE.replace('尚未取得', '未取得'))) }
)

/* ---------------------------------------------------------------- 汇总 */
console.log(JSON.stringify({ summary: { total, passed, failed: total - passed, failed_ids: failedIds }, sections: sectionStats }))
if (failedIds.length > 0) process.exit(1)
