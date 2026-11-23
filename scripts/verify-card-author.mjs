#!/usr/bin/env node
/**
 * 玺爱 · **卡片作者显示链回归（永久夹具）**（`scripts/verify-card-author.mjs`）
 * ============================================================================
 * **本地、离线、零网络、零云端、零库、零生产数据**：前端走 ESM 真源 ＋ 注入传输；
 * 服务端走云函数真实入口 `cloudfunctions/xiai-user-token/index.js::main` ＋ 注入式内存假 DB。
 *
 * 为什么单独立档：「广场卡片显示作者」这一单的实现跨了**两侧四层**
 * （云函数 `lib/sealCards.js` 的指针翻译 / 前端 `services/sealCards.js` 的 16 键归一 /
 * `data/db.js::resolveAuthorName` 的索引首级 / `services/personCards.js` 的索引快照），
 * 而**原实现四组夹具一组都没跑** ⇒ 硬缺口。本套件把正 / 负对照一次固化。
 *
 * 判据（五组，逐条可机械判负）：
 *   CA1 **索引正面**：注入 `listPersonCards` 回包（含
 *       `{person_id:'100000073', family_name_cht:'陳', given_name_cht:'巨來', name:'陳巨來'}`
 *       ）⇒ 索引就绪 ⇒ `resolveAuthorName({author_card_id:'100000073'})` ＝ `'陳巨來'`。
 *   CA2 **勘误覆盖（服务端）**：主印面 `author_person_id:'PR000000422'` ＋
 *       `xiai_corrections_public` 一行 `{faceId, field:'author', status:'ACCEPTED',
 *       value:'PR000000101'}` ＋ `xiai_persons` 两行（`PR000000101 → 100000073` /
 *       `PR000000422 → 100000003`）⇒ 该卡 `author_person_id='PR000000101'`、
 *       `author_card_id='100000073'`。**≥3 枚卡片一次性校验**（防「只对单行生效」）。
 *   CA3 **索引未就绪回落**：索引未加载 / 加载但未命中 ⇒ 回落旧 `author` 文本；
 *       皆空 ⇒ `'佚名'`；且**不得沿用上一次解析出的值**（不缓存假值）。
 *   CA4 **值域门**：(a) ACCEPTED 值是人名 `'黃士陵'` ⇒ 卡片行两键**仍为面行原值那对**
 *       （不被人名污染），前端显示走旧文本回落；(b) 面行原值本身是人名形态 ⇒
 *       两键**皆空串**（键面仍恰 16 键）。
 *   CA5 **键面**：云函数回包每枚卡片**恰 16 键、键名逐字 ＝ `CARD_ROW_KEYS`**；
 *       负样本「删两键的 14 键行」喂同一判据 ⇒ **判红**。
 *
 * 环境（两套假体，各司其职）：
 *   ① `localStorage / window` 假体 —— **逐字取自 `scripts/verify-person-model.mjs` 头部**
 *      （已验证能让 `src/data/db.js` 在 Node 下真导入；**不另造第二套**）。
 *   ② `scripts/lib/import-meta-env-shim.mjs` —— 只补构建期 `import.meta.env`
 *      （否则 `cloudBaseConfigured()` 恒 false，注入的回包到不了索引，CA1 无法离线跑）。
 *
 * 纪律：不打印任何密钥 / 令牌；不碰任何服务；任一断言失败 ⇒ 退出码非 0。
 * 用法：`node scripts/verify-card-author.mjs`
 */
/* **测试环境保护哨兵（硬防线）** —— 本套件只跑离线假 CARD：置 `XIAI_NO_REAL_CARD=1`。
   若哪个调用点漏注入假传输，`lib/cardApi.js` 会**当场抛错、零请求**（绝不悄悄打生产 CARD）。
   跑任何套件前**不得** export 真 `CARD_API_KEY`（见 `scripts/README-test-net.md`）。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { createRequire, register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
   0. 构建期 env 假体（**必须早于任何 `src/**` 的 `import()`**）
   ------------------------------------------------------------------------ */
globalThis.__XIAI_TEST_ENV__ = {
  VITE_XIAI_DATA_SOURCE: 'cloudbase',
  VITE_XIAI_CB_ENV_ID: 'xiai-selfcheck-env'
}
register(pathToFileURL(path.join(HERE, 'lib', 'import-meta-env-shim.mjs')).href)

/* ---------------------------------------------------------------------------
   1. `localStorage / window` 假体（与 `scripts/verify-person-model.mjs` 头部**逐字同套**）
   ------------------------------------------------------------------------ */
const memory = new Map()
const localStorageShim = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear()
}
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = localStorageShim
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}
globalThis.window.dispatchEvent = () => true

/* ---------------------------------------------------------------------------
   2. 断言与读数
   ------------------------------------------------------------------------ */
const results = []
let failures = 0
function check(id, label, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (!pass) failures += 1
  results.push({ id, pass })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}
const section = (name, title) => console.log(JSON.stringify({ section: name, title }))
const sorted = (list) => list.slice().sort()

/* ===========================================================================
   3. 前端被测件（ESM 真源；注入 `listPersonCards` 传输）
   =========================================================================== */
const cloudbaseFn = await import(pathToFileURL(path.join(ROOT, 'src/data/cloudbaseFn.js')).href)
const personCards = await import(pathToFileURL(path.join(ROOT, 'src/services/personCards.js')).href)
const db = await import(pathToFileURL(path.join(ROOT, 'src/data/db.js')).href)

/* 索引夹具两行：一行**正常九位号**（正面）；一行**人名形态混进 `person_id` 位**（值域门负对照）——
   后者证明「前端显示回落到旧文本」是**门在挡**、而不是「索引里根本没有这个人」。 */
const INDEX_ROWS = [
  { person_id: '100000073', family_name_cht: '陳', given_name_cht: '巨來', name: '陳巨來' },
  { person_id: '黃士陵', family_name: '歐', given_name: '陽', name: '歐陽假名' }
]
let transportCalls = 0
cloudbaseFn.setCloudFunctionTransport(async (name, data) => {
  transportCalls += 1
  const ok =
    name === personCards.PERSON_CARDS_FUNCTION_NAME &&
    !!data &&
    data.action === personCards.PERSON_CARDS_ACTION &&
    data.op === personCards.LIST_PERSON_CARDS_OP
  if (!ok) return { ok: false, reason: 'BAD_REPLY', message: 'unexpected transport call' }
  return { result: { ok: true, generated_at: '2026-11-23T00:00:00.000Z', count: INDEX_ROWS.length, rows: INDEX_ROWS } }
})

/* ===========================================================================
   CA1 · 前端正面：索引已加载 ⇒ 按 `author_card_id` 取名
   =========================================================================== */
section('CA1', '索引正面：注入 listPersonCards 回包 ⇒ 索引就绪 ⇒ resolveAuthorName 按 author_card_id 取名')
const ca1Load = await personCards.loadPersonIndex({ force: true })
const CA1_ROW = { author_card_id: '100000073' }
const ca1Name = db.resolveAuthorName(CA1_ROW)
check(
  'CA1',
  '索引经 `setCloudFunctionTransport` 注入回包载入（行含 `100000073 / 陳 / 巨來 / 陳巨來`）⇒ `resolveAuthorName({author_card_id:\'100000073\'})` ＝ `陳巨來`',
  { loadOk: true, ready: true, indexCount: 2, transportCalls: 1, name: '陳巨來' },
  {
    loadOk: ca1Load.ok === true,
    ready: personCards.personIndexReady(),
    indexCount: personCards.personIndexStatus().count,
    transportCalls,
    name: ca1Name
  }
)

/* ===========================================================================
   4. 服务端被测件（云函数真实入口 ＋ 注入式内存假 DB）
   =========================================================================== */
section('CA2', '勘误覆盖（服务端）：ACCEPTED 作者勘误命中 ⇒ 覆盖面行原值并翻成 CARD 九位号')

/* ---- 注入式内存假 DB（`createStore` 形态，与 `scripts/verify-public-ops.mjs` 同尺） ---- */
function createStore(seedRows) {
  const collections = new Map()
  const stats = { writes: [], reads: 0 }
  const mapOf = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  const seedRow = (row) => {
    const name = row.__collection
    const copy = Object.assign({}, row)
    delete copy.__collection
    const map = mapOf(name)
    const key = String(copy._id || copy.id || `${name}-${map.size + 1}`)
    map.set(key, Object.assign({ _id: key }, copy))
    return key
  }
  ;(seedRows || []).forEach(seedRow)
  const command = {
    gt: (value) => ({ __op: 'gt', value }),
    in: (values) => ({ __op: 'in', values: Array.isArray(values) ? values.slice() : [] })
  }
  const literal = (value) => (value === undefined || value === null ? '' : String(value))
  const matches = (row, match) =>
    Object.keys(match || {}).every((key) => {
      const expected = match[key]
      if (key === '$or') return Array.isArray(expected) && expected.some((clause) => matches(row, clause))
      if (key === '$and') return Array.isArray(expected) && expected.every((clause) => matches(row, clause))
      if (key === '$nor') return Array.isArray(expected) && expected.every((clause) => !matches(row, clause))
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        if (expected.$regularExpression) {
          const spec = expected.$regularExpression
          try {
            return new RegExp(String(spec.pattern), String(spec.options || '')).test(literal(row[key]))
          } catch (error) {
            return false
          }
        }
        if (expected.__op === 'gt') return literal(row[key]) > literal(expected.value)
        if (expected.__op === 'in') return expected.values.map((value) => String(value)).indexOf(String(row[key])) !== -1
        if (expected.$gte !== undefined) {
          const num = Number(row[key])
          return Number.isFinite(num) && num >= Number(expected.$gte)
        }
      }
      return row[key] === expected
    })
  const provider = () => ({
    command,
    collection(name) {
      const map = mapOf(name)
      const all = () => [...map.values()].map((row) => Object.assign({}, row))
      const hit = (match) => all().filter((row) => matches(row, match))
      return {
        where(match) {
          let limit = 0
          const api = {
            limit(n) {
              limit = Number(n)
              return api
            },
            async get() {
              stats.reads += 1
              const rows = hit(match)
              return { data: limit > 0 ? rows.slice(0, limit) : rows }
            },
            async count() {
              stats.reads += 1
              return { total: hit(match).length }
            },
            async update(doc) {
              const rows = hit(match)
              rows.forEach((row) => {
                const key = String(row._id || row.id)
                map.set(key, Object.assign({}, map.get(key), doc))
              })
              stats.writes.push({ collection: name, action: 'update', match, count: rows.length })
              return { updated: rows.length }
            }
          }
          return api
        },
        async get() {
          stats.reads += 1
          return { data: all() }
        },
        doc(id) {
          return {
            async get() {
              stats.reads += 1
              const row = map.get(String(id))
              return { data: row ? [Object.assign({}, row)] : [] }
            },
            async set(doc) {
              map.set(String(id), Object.assign({ _id: String(id) }, doc))
              stats.writes.push({ collection: name, action: 'set', id: String(id) })
              return { updated: 1 }
            },
            async remove() {
              map.delete(String(id))
              stats.writes.push({ collection: name, action: 'remove', id: String(id) })
              return { deleted: 1 }
            }
          }
        },
        async add(doc) {
          const id = String(doc && doc._id ? doc._id : `auto-${map.size + 1}`)
          map.set(id, Object.assign({ _id: id }, doc))
          stats.writes.push({ collection: name, action: 'add', id })
          return { id }
        }
      }
    }
  })
  return {
    stats,
    provider,
    rows: (name) => [...mapOf(name).values()].map((row) => Object.assign({}, row))
  }
}

const ops = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))
const sealCards = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/sealCards.js'))
const fn = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/index.js'))

const publicCall = (op, payload) => fn.main({ action: 'public', op, payload })

/* 造一枚章 ＋ 一个主印面（`author_person_id` 可指定）＋ 一条已采纳作者勘误（可省）。 */
function cardSeed({ prefix, count, facePersonId, correctionValue }) {
  const rows = []
  const stamps = []
  for (let i = 1; i <= count; i += 1) {
    const sid = `${prefix}${String(i).padStart(6, '0')}`
    const faceId = `${prefix}F${String(i).padStart(6, '0')}`
    stamps.push(sid)
    rows.push({
      __collection: 'xiai_seals',
      _id: sid,
      stamp_id: sid,
      seal_name: `甲印${i}`,
      dynasty: '汉',
      category: '吉语印',
      face_count: 1
    })
    rows.push({
      __collection: 'xiai_faces',
      _id: faceId,
      id: faceId,
      sealId: sid,
      kind: 'FACE',
      face_no: 1,
      is_primary: true,
      author_person_id: facePersonId
    })
    if (correctionValue !== undefined) {
      rows.push({
        __collection: 'xiai_corrections_public',
        _id: `${prefix}C${String(i).padStart(6, '0')}`,
        faceId,
        field: 'author',
        status: 'ACCEPTED',
        value: correctionValue
      })
    }
  }
  return { rows, stamps }
}
const personRow = (prId, cardId) => ({
  __collection: 'xiai_persons',
  _id: prId,
  id: prId,
  code: prId,
  card_id: cardId,
  family_name: '占位',
  given_name: '占位',
  alias_names: [],
  courtesy_names: [],
  art_names: []
})

/* ---- CA2 夹具：3 枚章，面行原值 `PR000000422`，勘误值 `PR000000101` ---- */
const ca2Seed = cardSeed({ prefix: 'SLCA', count: 3, facePersonId: 'PR000000422', correctionValue: 'PR000000101' })
const ca2Store = createStore([
  ...ca2Seed.rows,
  personRow('PR000000101', '100000073'),
  personRow('PR000000422', '100000003')
])
ops.setOpsDbProvider(ca2Store.provider)
const ca2Reply = await publicCall('listSealCards', { limit: 10 })
const ca2Rows = Array.isArray(ca2Reply.rows) ? ca2Reply.rows : []
check(
  'CA2',
  '三枚卡一次性校验（防「只对单行生效」）：勘误 `ACCEPTED value=PR000000101` 覆盖面行 `PR000000422` ⇒ 每卡 `author_person_id=PR000000101`、`author_card_id=100000073`（`PR000000422→100000003` 未被误用）',
  {
    ok: true,
    cards: 3,
    personIds: ['PR000000101', 'PR000000101', 'PR000000101'],
    cardIds: ['100000073', '100000073', '100000073'],
    writes: 0
  },
  {
    ok: ca2Reply.ok === true,
    cards: ca2Rows.length,
    personIds: ca2Rows.map((row) => row.author_person_id),
    cardIds: ca2Rows.map((row) => row.author_card_id),
    writes: ca2Store.stats.writes.length
  }
)

/* ===========================================================================
   CA3 · 索引未就绪 / 未命中 ⇒ 回落旧 `author` 文本（皆空 ⇒ 佚名；不沿用旧值）
   =========================================================================== */
section('CA3', '索引未就绪 / 未命中回落：旧 author 文本 ⇒ 皆空 佚名 ⇒ 且不沿用上一次解析值')
{
  /* ① 索引**未加载**（清快照）。 */
  personCards.resetPersonCardsCache()
  const unloaded = personCards.personIndexReady() === false
  const fallbackByCardId = db.resolveAuthorName({ author_card_id: '100000073', author_person_id: '', author: '舊作者甲' })
  const fallbackByPersonId = db.resolveAuthorName({ author_card_id: '', author_person_id: 'PR000000101', author: '舊作者乙' })
  /* ② **不得沿用上一次的值**：同一行（CA1 刚解析出 `陳巨來`）此刻必须回落，不是缓存值。 */
  const stale = db.resolveAuthorName(CA1_ROW)
  /* ③ 索引**已加载但未命中**（九位号 / `PR` 号都不在索引里）。 */
  const reload = await personCards.loadPersonIndex({ force: true })
  const loadedMissCard = db.resolveAuthorName({ author_card_id: '999999999', author: '舊作者丙' })
  const loadedMissPerson = db.resolveAuthorName({ author_card_id: '', author_person_id: 'PR000000999', author: '舊作者丁' })
  /* ④ 皆空 ⇒ `佚名`（**不回空串**）。 */
  const allEmpty = db.resolveAuthorName({ author_card_id: '', author_person_id: '', author: '' })
  const allMissing = db.resolveAuthorName(null)
  check(
    'CA3',
    '索引未加载 ⇒ 回落旧 `author`；已加载未命中 ⇒ 仍回落；皆空 ⇒ `佚名`；且**不沿用** CA1 刚解析出的 `陳巨來`（零缓存假值）',
    {
      unloaded: true,
      reloadOk: true,
      fallbackByCardId: '舊作者甲',
      fallbackByPersonId: '舊作者乙',
      stale: '佚名',
      staleNotCa1: true,
      loadedMissCard: '舊作者丙',
      loadedMissPerson: '舊作者丁',
      allEmpty: '佚名',
      allMissing: '佚名'
    },
    {
      unloaded,
      reloadOk: reload.ok === true,
      fallbackByCardId,
      fallbackByPersonId,
      stale,
      staleNotCa1: stale !== ca1Name,
      loadedMissCard,
      loadedMissPerson,
      allEmpty,
      allMissing
    }
  )
}

/* ===========================================================================
   CA4 · 值域门：人名形态的值**不进**指针两键（服务端）＋ 前端走旧文本回落
   =========================================================================== */
section('CA4', '值域门：人名形态值不进指针两键（服务端）／前端回落旧文本；面行原值是人名 ⇒ 两键皆空串')

/* ---- (a) ACCEPTED 值 ＝ 人名 `黃士陵` ⇒ 卡片行两键仍为**面行原值那对** ---- */
{
  const seed = cardSeed({ prefix: 'SLCB', count: 2, facePersonId: 'PR000000422', correctionValue: '黃士陵' })
  const store = createStore([...seed.rows, personRow('PR000000422', '100000003')])
  ops.setOpsDbProvider(store.provider)
  const reply = await publicCall('listSealCards', { limit: 10 })
  const rows = Array.isArray(reply.rows) ? reply.rows : []
  /* 前端：指针位被人名污染时**必须**走旧 `author` 文本回落（索引里那条 `person_id='黃士陵'`
     的污染行证明「门在挡」，不是「索引没这人」）。 */
  const polluted = personCards.personAttributesOf('黃士陵')
  const frontendName = db.resolveAuthorName({
    author_card_id: '',
    author_person_id: '黃士陵',
    author: '黃士陵'
  })
  check(
    'CA4a',
    'ACCEPTED 值为人名 `黃士陵` ⇒ 值域门当「没有这条勘误」：卡片两键**仍为面行原值那对** `PR000000422 / 100000003`（零人名污染）；前端 `resolveAuthorName` 走旧 `author` 文本回落 ＝ `黃士陵`（且索引里确有 `person_id=黃士陵` 的污染行 ⇒ 是门在挡）',
    {
      ok: true,
      cards: 2,
      personIds: ['PR000000422', 'PR000000422'],
      cardIds: ['100000003', '100000003'],
      nameHits: 0,
      pollutedIndexRow: true,
      frontendName: '黃士陵'
    },
    {
      ok: reply.ok === true,
      cards: rows.length,
      personIds: rows.map((row) => row.author_person_id),
      cardIds: rows.map((row) => row.author_card_id),
      nameHits: rows.reduce(
        (sum, row) => sum + (row.author_person_id === '黃士陵' || row.author_card_id === '黃士陵' ? 1 : 0),
        0
      ),
      pollutedIndexRow: !!polluted && polluted.family_name === '歐' && polluted.given_name === '陽',
      frontendName
    }
  )
}

/* ---- (b) 面行原值本身是人名形态 ⇒ 两键**皆空串**（键面仍恰 16 键） ---- */
{
  const seed = cardSeed({ prefix: 'SLCC', count: 2, facePersonId: '黃士陵' })
  const store = createStore(seed.rows)
  ops.setOpsDbProvider(store.provider)
  const reply = await publicCall('listSealCards', { limit: 10 })
  const rows = Array.isArray(reply.rows) ? reply.rows : []
  check(
    'CA4b',
    '面行原值 `author_person_id=黃士陵`（人名形态）⇒ 值域门视作解析不出 ⇒ 两键**皆空串**（不落 `null`、不删键）且**键面仍恰 16 键**',
    { ok: true, cards: 2, personIds: ['', ''], cardIds: ['', ''], counts: [16, 16] },
    {
      ok: reply.ok === true,
      cards: rows.length,
      personIds: rows.map((row) => row.author_person_id),
      cardIds: rows.map((row) => row.author_card_id),
      counts: rows.map((row) => Object.keys(row).length)
    }
  )
}

/* ===========================================================================
   CA5 · 键面：回包每枚卡恰 16 键、键名逐字 ＝ `CARD_ROW_KEYS`；14 键负样本判红
   =========================================================================== */
section('CA5', '键面：回包每枚卡恰 16 键且键名逐字 ＝ CARD_ROW_KEYS；删两键的 14 键行喂同一判据判红')

const CARD_ROW_KEYS = sealCards.CARD_ROW_KEYS
const cardRowShape = (row) => {
  const keys = Object.keys(row || {})
  return {
    count: keys.length,
    sameSet: JSON.stringify(keys.slice().sort()) === JSON.stringify(sorted([...CARD_ROW_KEYS])),
    ordered: JSON.stringify(keys) === JSON.stringify([...CARD_ROW_KEYS])
  }
}
const cardRowJudge = (row) => {
  const shape = cardRowShape(row)
  return shape.count === CARD_ROW_KEYS.length && shape.sameSet
}
{
  const shapes = ca2Rows.map((row) => cardRowShape(row))
  check(
    'CA5',
    '云函数回包每枚卡片**恰 16 键**、键名逐字 ＝ `CARD_ROW_KEYS`（集合与顺序双双命中）',
    { cards: 3, counts: [16, 16, 16], allSameSet: true, allOrdered: true, allJudge: true, frozenCount: 16 },
    {
      cards: ca2Rows.length,
      counts: shapes.map((shape) => shape.count),
      allSameSet: shapes.every((shape) => shape.sameSet),
      allOrdered: shapes.every((shape) => shape.ordered),
      allJudge: ca2Rows.every((row) => cardRowJudge(row)),
      frozenCount: CARD_ROW_KEYS.length
    }
  )
  /* **负样本**：把两键删掉成 14 键行喂**同一条**判据 ⇒ 必须判红（判据本体一字未改）。 */
  const source = ca2Rows[0] || {}
  const mutant14 = Object.assign({}, source)
  delete mutant14.author_card_id
  delete mutant14.author_person_id
  const mutantShape = cardRowShape(mutant14)
  check(
    'CA5n',
    '负样本：删掉两键的 **14 键行**喂 CA5 同一判据 ⇒ **判红**；16 键原行 ⇒ **判绿**',
    { mutantCount: 14, mutantRed: true, realGreen: true, missingKeys: ['author_card_id', 'author_person_id'] },
    {
      mutantCount: mutantShape.count,
      mutantRed: cardRowJudge(mutant14) === false,
      realGreen: cardRowJudge(source) === true,
      missingKeys: ['author_card_id', 'author_person_id'].filter((key) => !(key in mutant14))
    }
  )
}

/* ===========================================================================
   收针：清两道注入缝（不留全局态给后续脚本进程）
   =========================================================================== */
cloudbaseFn.setCloudFunctionTransport(null)
ops.setOpsDbProvider(null)

const total = results.length
const passed = results.filter((r) => r.pass).length
const failedIds = results.filter((r) => !r.pass).map((r) => r.id)
console.log(
  JSON.stringify({
    summary: { total, passed, failures },
    failed_ids: failedIds,
    note: '离线：前端 ESM 真源（localStorage/window 假体 ＋ import.meta.env 构建期假体 ＋ setCloudFunctionTransport 注入 listPersonCards 回包）＋ 云函数真实入口 main（createStore 内存假 DB 注入 setOpsDbProvider）；零网络、零云端、零库、零生产数据。'
  })
)
process.exit(failures === 0 ? 0 : 1)
