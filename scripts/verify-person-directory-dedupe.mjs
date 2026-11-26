#!/usr/bin/env node
/**
 * 玺爱 · **印人名録 `tmp-` 暂存行去重** 离线自检
 * ============================================================================
 * **本地、离线、零网络、零生产读写、零浏览器**：被测件只有 `src/services/persons.js`
 * 的三个纯函数 —— `isShadowedTempRow` / `dedupeShadowedTempRows` / `listPersons`（静态接线），
 * 以及检索真源 `src/services/personSearch.js`（`buildPersonIndex` / `searchPersons`）。
 * 所有用例都**显式注入假行集**（不走 `listPersons()` ⇒ 不碰 localStorage、不碰云端快照）。
 *
 * 覆盖（逐条硬口）：
 *   A  `isShadowedTempRow`：同 `proposal_id` ⇒ 遮蔽（优先于 `card_id`）；`proposal_id`
 *      不同而 `card_id` 相同 ⇒ 仍遮蔽；两键皆空 / 只与另一条 `tmp-` 行相同 / 无正式行 /
 *      非 `tmp-` 行入参 ⇒ **不遮蔽**。
 *   B  `dedupeShadowedTempRows`：只剩正式行（**保留的是正式行不是 `tmp-`**）、正式行之间
 *      不去重（同 `card_id` 也留）、**未成对 `tmp-` 行保留**、**顺序稳定**、空 / 非数组入参。
 *   C  名録读面同源：「刘垚」双行场景 **改前 2 ⇒ 改后 1**；搜索命中数 ＝ 去重后行数；
 *      「收錄 N 位」计数同源；保留者断言。
 *   D  静态接线（读真源、非常量）：`listPersons` ⇒ `dedupeShadowedTempRows` ⇒
 *      `isShadowedTempRow` 单点链；`personReferenceDenial` / 名録页 / 详情页解析未被改动。
 *
 * 纪律：断言失败 ⇒ 退出码 1；不打印任何令牌 / 手机号；**不改任何被测件**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
/* 被测件真源（直接 import；本仓 `package.json` `type: module`）。 */
import * as persons from '../src/services/persons.js'
/* 检索真源（纯函数模组，与名録页同一份算法）。 */
import { buildPersonIndex, searchPersons } from '../src/services/personSearch.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const PERSONS_SRC = read('src/services/persons.js')
const INDEX_SRC = read('src/views/PersonIndexView.vue')
const DB_SRC = read('src/data/db.js')

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

/** 剥注释 —— 产品件注释里逐字写着这些标识符，不剥会把说明当实码（口径照既有套件）。 */
function stripComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}
const PERSONS_CLEAN = stripComments(PERSONS_SRC)

/** 函数体切片（从 `export function <name>(` 到配平的收尾 `\n}`）。 */
function bodyOf(source, marker) {
  const start = source.indexOf(marker)
  if (start === -1) return ''
  const end = source.indexOf('\n}\n', start)
  return end === -1 ? '' : source.slice(start, end)
}

/* ---------------------------------------------------------------- 假行集（照线上实据同形） */
/** 云端正式行（照 `xiai_persons/PR000000571` 同形）。 */
const FORMAL_ROW = Object.freeze({
  _id: 'PR000000571',
  id: 'PR000000571',
  code: 'PR000000571',
  card_id: '100000574',
  proposal_id: 'pp-mwh3srta-2uidjx',
  family_name: '劉',
  given_name: '垚',
  name: '劉垚',
  dynasty: '清'
})
/** 同一位印人的本机暂存行（与正式行同 `proposal_id` ＋ 同 `card_id`）。 */
const TEMP_ROW = Object.freeze({
  id: 'tmp-000002',
  code: 'tmp-000002',
  card_id: '100000574',
  proposal_id: 'pp-mwh3srta-2uidjx',
  family_name: '劉',
  given_name: '垚',
  name: '劉垚',
  dynasty: '清'
})
/** 正式行 B（与正式行 A 同 `card_id` —— 正式行之间**不去重**的负对照）。 */
const FORMAL_SAME_CARD = Object.freeze({
  _id: 'PR000000572',
  id: 'PR000000572',
  code: 'PR000000572',
  card_id: '100000574',
  proposal_id: 'pp-other',
  family_name: '劉',
  given_name: '垚',
  name: '劉垚',
  dynasty: '清'
})
/** 未采纳的草稿暂存行（云端**确无**对应正式行 ⇒ 必须保留）。 */
const TEMP_DRAFT = Object.freeze({
  id: 'tmp-000009',
  code: 'tmp-000009',
  card_id: '',
  proposal_id: '',
  family_name: '張',
  given_name: '三',
  name: '張三',
  dynasty: '清'
})
/** 只与另一条 `tmp-` 行同键的暂存行（两键都只命中 `tmp-` ⇒ 不去重）。 */
const TEMP_A = Object.freeze({ id: 'tmp-000021', code: 'tmp-000021', card_id: '555555555', proposal_id: 'pp-tmp-only' })
const TEMP_B = Object.freeze({ id: 'tmp-000022', code: 'tmp-000022', card_id: '555555555', proposal_id: 'pp-tmp-only' })

const idsOf = (rows) => rows.map((row) => (row && (row.code || row.id)) || '')

/* ===========================================================================
   A. `isShadowedTempRow`：只对 `tmp-` 行生效；proposal 优先、次之 card
   =========================================================================== */
section('A', 'isShadowedTempRow：同 proposal ⇒ 遮蔽 / 同 card ⇒ 遮蔽 / 两键皆空或只同 tmp ⇒ 不遮蔽')
check('A1', '同一 `proposal_id` 的 `tmp-` 行 ＋ 正式行 ⇒ 遮蔽', true, persons.isShadowedTempRow(TEMP_ROW, [FORMAL_ROW]))
check('A2', '`proposal_id` 不同但 `card_id` 相同 ⇒ **仍遮蔽**', true, persons.isShadowedTempRow({ ...TEMP_ROW, proposal_id: 'pp-x' }, [FORMAL_ROW]))
check('A3', '`proposal_id` 相同而 `card_id` 不同 ⇒ 遮蔽（proposal 优先，不因 card 不同而漏判）', true, persons.isShadowedTempRow({ ...TEMP_ROW, card_id: '' }, [FORMAL_ROW]))
check('A4', '`proposal_id` 有值但无人命中 ⇒ 落 `card_id` 兜底', true, persons.isShadowedTempRow({ ...TEMP_ROW, proposal_id: 'pp-none' }, [FORMAL_ROW]))
check('A5', '两键皆空 ⇒ **不遮蔽（保留）**', false, persons.isShadowedTempRow(TEMP_DRAFT, [FORMAL_ROW]))
check('A6', '`proposal_id` / `card_id` 只与另一条 `tmp-` 行相同 ⇒ **不遮蔽**（暂存行之间不去重）', false, persons.isShadowedTempRow(TEMP_A, [TEMP_B]))
check('A7', '混集（`formalRows` 里含 `tmp-` 行）⇒ `tmp-` 行**绝不充当遮蔽源**', false, persons.isShadowedTempRow(TEMP_A, [TEMP_B, FORMAL_ROW]))
check('A8', '正式行入参 ⇒ 恒不遮蔽（正式行之间不去重）', false, persons.isShadowedTempRow(FORMAL_ROW, [FORMAL_SAME_CARD]))
check('A9', '云端无对应正式行（正式行集里没有同键行）⇒ **不遮蔽（保留）**', false, persons.isShadowedTempRow(TEMP_DRAFT, [FORMAL_ROW]))
check('A10', '非对象 / 非数组入参 ⇒ 一律 `false`（不抛、不误杀）', [false, false, false], [
  persons.isShadowedTempRow(null, [FORMAL_ROW]),
  persons.isShadowedTempRow(TEMP_ROW, null),
  persons.isShadowedTempRow(TEMP_ROW, 'not-an-array')
])
check('A11', '空白 `proposal_id`（仅空格）视为无值 ⇒ 落 `card_id` 判定', false, persons.isShadowedTempRow({ id: 'tmp-000031', code: 'tmp-000031', proposal_id: '   ', card_id: '' }, [FORMAL_ROW]))
check('A12', '前缀大小写敏感：`TMP-000002` 不算暂存行 ⇒ 不遮蔽', false, persons.isShadowedTempRow({ id: 'TMP-000002', code: 'TMP-000002', card_id: '100000574' }, [FORMAL_ROW]))

/* ===========================================================================
   B. `dedupeShadowedTempRows`：只剩正式行 / 正式行不去重 / 未成对保留 / 顺序稳定
   =========================================================================== */
section('B', 'dedupeShadowedTempRows：只滤被遮蔽的 tmp- 行，顺序不变、未成对 tmp 行保留')
check('B1', '同 `proposal_id` 的 `tmp-` ＋ 正式 ⇒ **只剩正式行**（且保留的是正式行、不是 `tmp-`）', ['PR000000571'], idsOf(persons.dedupeShadowedTempRows([TEMP_ROW, FORMAL_ROW])))
check('B1b', '保留者**就是那条正式行对象**（同引用，不是重新造的行）', true, (() => {
  const out = persons.dedupeShadowedTempRows([TEMP_ROW, FORMAL_ROW])
  return out.length === 1 && out[0] === FORMAL_ROW
})())
check('B2', '`proposal_id` 不同而 `card_id` 相同 ⇒ 仍去重', ['PR000000571'], idsOf(persons.dedupeShadowedTempRows([{ ...TEMP_ROW, proposal_id: 'pp-x' }, FORMAL_ROW])))
check('B3', '两键皆空的 `tmp-` 行 ＋ 只与另一 `tmp-` 行同键的两行 ⇒ **三条全保留**', ['tmp-000009', 'tmp-000021', 'tmp-000022'], idsOf(persons.dedupeShadowedTempRows([TEMP_DRAFT, TEMP_A, TEMP_B])))
check('B4', '正式行之间不去重（同 `card_id` 的两条正式行 ⇒ 2 条）', ['PR000000571', 'PR000000572'], idsOf(persons.dedupeShadowedTempRows([FORMAL_ROW, FORMAL_SAME_CARD])))
check('B5', '顺序稳定：交错输入 ⇒ 输出 ＝ 输入去掉被遮蔽行、相对顺序逐字不变', ['PR000000571', 'tmp-000009', 'PR000000572'], idsOf(persons.dedupeShadowedTempRows([FORMAL_ROW, TEMP_ROW, TEMP_DRAFT, FORMAL_SAME_CARD])))
check('B6', '**未成对**的 `tmp-` 行（云端确无对应正式行）继续保留', ['tmp-000009'], idsOf(persons.dedupeShadowedTempRows([TEMP_DRAFT])))
check('B7', '两条 `tmp-` 行同 `proposal_id`、均被同一条正式行遮蔽 ⇒ 两条都滤掉、只留正式行', ['PR000000571'], idsOf(persons.dedupeShadowedTempRows([{ ...TEMP_ROW, id: 'tmp-000041', code: 'tmp-000041' }, TEMP_ROW, FORMAL_ROW])))
check('B8', '空数组 / 非数组入参 ⇒ 原样空数组（不抛）', [[], []], [
  persons.dedupeShadowedTempRows([]),
  persons.dedupeShadowedTempRows(null)
])
check('B9', '零遮蔽场景 ⇒ 返回行数与顺序与入参逐字一致', ['PR000000571', 'PR000000572'], idsOf(persons.dedupeShadowedTempRows([FORMAL_ROW, FORMAL_SAME_CARD])))

/* ===========================================================================
   C. 名録读面同源：搜索命中数 ＝ 「收錄 N 位」计数 ＝ 去重后行数
   =========================================================================== */
section('C', '名録读面：「刘垚」双行场景 改前 2 ⇒ 改后 1；搜索与「收錄 N 位」同源去重')
const ROSTER_RAW = [TEMP_ROW, FORMAL_ROW]
const ROSTER_DEDUPED = persons.dedupeShadowedTempRows(ROSTER_RAW)
const hitsOf = (rows, keyword) => searchPersons(buildPersonIndex(rows), keyword).length

check('C1', '「刘垚」命中数：**改前（未去重）2 → 改后（去重）1**', { before: 2, after: 1 }, {
  before: hitsOf(ROSTER_RAW, '刘垚'),
  after: hitsOf(ROSTER_DEDUPED, '刘垚')
})
check('C2', '搜索命中数 ＝ 去重后行数（同源，不是两套口径）', { hits: 1, rows: 1 }, {
  hits: hitsOf(ROSTER_DEDUPED, '刘垚'),
  rows: ROSTER_DEDUPED.length
})
check('C3', '「收錄 N 位」计数（＝ 行数）同源：改前 2 → 改后 1', { before: 2, after: 1 }, {
  before: ROSTER_RAW.length,
  after: ROSTER_DEDUPED.length
})
check('C4', '去重后保留的是正式行 `PR000000571`（不是 `tmp-000002`）', ['PR000000571'], idsOf(ROSTER_DEDUPED))
check('C5', '未成对草稿行仍进计数与搜索（`張三`：1 行 1 命中）', { rows: 1, hits: 1 }, (() => {
  const rows = persons.dedupeShadowedTempRows([TEMP_DRAFT])
  return { rows: rows.length, hits: hitsOf(rows, '張三') }
})())
check('C6', '繁简两侧同源：简体「刘垚」与繁体「劉垚」命中数一致（去重后皆 1）', [1, 1], [
  hitsOf(ROSTER_DEDUPED, '刘垚'),
  hitsOf(ROSTER_DEDUPED, '劉垚')
])

/* ===========================================================================
   D. 静态接线（读真源、非常量；含负对照）
   =========================================================================== */
section('D', '静态接线：单点链 listPersons ⇒ dedupeShadowedTempRows ⇒ isShadowedTempRow；详情页 / 名録页 / 拒引门未被改动')
const LIST_PERSONS_BODY = bodyOf(PERSONS_CLEAN, 'export function listPersons(')
const DEDUPE_BODY = bodyOf(PERSONS_CLEAN, 'export function dedupeShadowedTempRows(')
const SHADOW_BODY = bodyOf(PERSONS_CLEAN, 'export function isShadowedTempRow(')

check('D1', '`listPersons` 函数体经 `dedupeShadowedTempRows(` 取数（名録去重的唯一应用点）', { callSites: 1 }, { callSites: countOf(LIST_PERSONS_BODY, 'dedupeShadowedTempRows(') })
check('D2', '`dedupeShadowedTempRows` 函数体经 `isShadowedTempRow(` 判定（不立第二套判定）', { callSites: 1 }, { callSites: countOf(DEDUPE_BODY, 'isShadowedTempRow(') })
check('D3', '`isShadowedTempRow` 函数体零 `tmp-` 字面前缀（前缀单点仍是既有 `TEMP_PERSON_ID_PREFIX`）', { literal: 0, usesConst: true }, { literal: countOf(SHADOW_BODY, "'tmp-'") + countOf(SHADOW_BODY, '"tmp-"'), usesConst: SHADOW_BODY.includes('isTempPersonCode(') })
check('D4', '静态：`isShadowedTempRow` 全 `src/**` 恰 1 处定义（单点）', 1, (() => {
  const hits = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(js|vue|mjs)$/.test(entry.name) && /export function isShadowedTempRow\(/.test(fs.readFileSync(full, 'utf8'))) {
        hits.push(path.relative(ROOT, full).split(path.sep).join('/'))
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  return hits.length
})())
check('D5', '负对照：内存抹掉 `listPersons` 体里的去重调用 ⇒ 判据由真翻假（读真源、非常量）', { original: true, mutated: false }, {
  original: countOf(LIST_PERSONS_BODY, 'dedupeShadowedTempRows(') === 1,
  mutated: countOf(LIST_PERSONS_BODY.replace('dedupeShadowedTempRows(', 'identity('), 'dedupeShadowedTempRows(') === 1
})
check('D6', '名録页取数仍是单点 `persons.listPersons()`（改视图零行 ⇒ 搜索 / 计数自动同源）', { callSites: 1, indexFromRoster: true }, {
  callSites: countOf(stripComments(INDEX_SRC), 'persons.listPersons()'),
  indexFromRoster: /buildPersonIndex\(baseRows\.value\)/.test(stripComments(INDEX_SRC)) && /const baseRows = computed/.test(stripComments(INDEX_SRC))
})
check('D7', '详情页 `tmp-` 解析**逻辑**未改：缺省行集＝全量（未去重）行集，注入行集的优先级读数仍 `PR000000571`', { fallback: true, resolve: 'PR000000571' }, {
  fallback:
    countOf(bodyOf(PERSONS_CLEAN, 'export function resolveFormalPersonCode('), 'listAllPersonRows()') === 1 &&
    countOf(LIST_PERSONS_BODY, 'listAllPersonRows(') === 1,
  resolve: persons.resolveFormalPersonCode('tmp-000002', [TEMP_ROW, FORMAL_ROW])
})
check('D8', '写面 / 拒引门未动：`db.js` 的 `tmp-` 引用拒绝仍在（恰 1 处）', 1, countOf(DB_SRC, "id.indexOf('tmp-') === 0"))

/* ---------------------------------------------------------------- 汇总 */
console.log(JSON.stringify({ summary: { total, passed, failed: total - passed, failed_ids: failedIds }, sections: sectionStats }))
if (failedIds.length > 0) process.exit(1)
