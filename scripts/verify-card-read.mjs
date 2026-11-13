#!/usr/bin/env node
/**
 * 玺爱 · **人物卡片读面自检**（`PUBLIC_OPS` 2 → 4：`listPersonCards` / `getPersonCard`
 * ＋ 两个匹配面改吃 CARD 索引）
 * ============================================================================
 * **本地、离线、零网络、零云端、零生产数据**：注入式内存假 DB ＋ **假 CARD**（`scripts/fixtures/
 * fake-card.mjs`，行面投影与生产 `card-api::getIndex` 同法），跑的是
 * `cloudfunctions/xiai-user-token/index.js` 的**真实入口 `main`** 与
 * `lib/sealCards.js` / `lib/cardApi.js` 的**真实函数体**。
 *
 * 断言面（十三组；每条可机械判负）：
 *   R0. 冻结键面逐字：`PUBLIC_OPS` 恰 4 成员；两个新 op 的载荷 / 回包键面（1 / 4 / 1 / 2）；
 *       索引行基面 10 键 ＋ 別號追加 2 键；`source` 字面值 `local-fallback`。
 *   R1. `listPersonCards` **CARD 路**：573 行 × 10 键、回包恰 4 键（**无 `source`**）、
 *       `count === rows.length`、`generated_at` 即上游值（**零写**）。
 *   R2. `include_biehao:true` ⇒ 行 **12 键**（＋ `biehao_text` / `zhaihao_alts`），別號原文在。
 *   R3. **CARD 超时（abort）** ⇒ 降级本地：570 行、10 键、`source:'local-fallback'`、
 *       回包恰 5 键（**不冒充 CARD 结果、不回空数组冒充成功**）。
 *   R4. `getPersonCard({person_id:'PR000000310'})` ⇒ **本地编号经 `card_id` 映射**命中赵之谦
 *       （`courtesy_name` ＝ `撝叔`），回包恰 2 键。
 *   R5. `getPersonCard({person_id:'900000310'})`（九位号）⇒ **同一人**（同号同人）。
 *   R6. 不存在的编号（本地无行 / CARD 无此人）⇒ `ok:false` ＋ `INVALID_VALUE`
 *       （云函数 `REASONS` 冻结表无 `NOT_FOUND` ⇒ 按规范口径落 `INVALID_VALUE`），恰 3 键、**零写**；
 *       **读面按实情定界**（`reads:0` 不成立）：`PR…` 无本地映射 ⇒ **CARD 调用恰 0**（无从问）、
 *       本地四形态 1〜4 次；九位号 ⇒ **CARD `getPerson` 1〜2 次**（不真问一次就无从断言「CARD 也无此人」）。
 *   R7. `suggestAuthors` **候选来自 CARD**：只在 CARD 有的人（`錢坫`）能命中，且候选
 *       `person_id` 是 CARD 九位号（四道匹配 / 分数面 / 阈值未改）。
 *   R8. **CARD 不可用时 `suggestAuthors` 仍能工作**（降级本地：`趙之謙` 命中）；同刻
 *       「只在 CARD 有的人」**查不到**（负对照 ⇒ 证明当前候选源确实是本地）。
 *   R9. **索引缓存生效**：`resetCardIndexCache()` 后连打两次 ⇒ `getIndex` **只调 1 次**；
 *       `include_biehao` 两个键面**各一份**（互不顶替）。
 *   R10. **错误结果不入缓存**：CARD 失败（降级）后恢复 ⇒ 下一次立刻再打 CARD 并回到 CARD 路。
 *   R11. `getPersonCard` 在 **CARD 不可用**时降级本地（`source:'local-fallback'`，恰 3 键）。
 *   R12. 载荷门：未知键 / 身份类键 ⇒ `INVALID_FIELD`；`include_biehao` 非布尔 ⇒ `INVALID_VALUE`；
 *       缺 `person_id` ⇒ `MISSING_REQUIRED`；**判定早于任何读**（读计数 0、CARD 调用 0）。
 *   R13. 全程**零写入**（假 DB 的写账恒 0）。
 *
 * 纪律：不打印任何密钥 / 令牌；不碰任何服务；断言失败 ⇒ 退出码非 0。
 *
 * 用法：`env -u CARD_API_KEY node scripts/verify-card-read.mjs`
 * （套件自带哨兵 `XIAI_NO_REAL_CARD=1` ＋ 假传输；即使 shell 导出了真密钥也**不会**打生产。）
 */

/* **测试环境保护哨兵（硬防线）** —— 本套件只跑离线假 CARD：置 `XIAI_NO_REAL_CARD=1`。
   若哪个调用点漏注入假传输，`lib/cardApi.js` 会**当场抛错、零请求**（绝不悄悄打生产 CARD）。
   跑任何套件前**不得** export 真 `CARD_API_KEY`（见 `scripts/README-test-net.md`）。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
   0. localStorage / window 假体（只为让 ESM 真源在本机 Node 下可导入；本套件不读它们）
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
   1. 断言（与既有 verify-*.mjs 同形）
   --------------------------------------------------------------------------- */
const results = []
let failures = 0
function check(id, desc, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual)
  if (!ok) failures += 1
  results.push({ id, pass: ok })
  console.log(JSON.stringify({ id, case: desc, pass: ok, expected, actual }))
}
const sorted = (list) => list.slice().sort()
const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const section = (name, title) => console.log(JSON.stringify({ section: name, title }))

/* ---------------------------------------------------------------------------
   2. 注入式内存假 DB（`collection(name).where(match).get()` ＋ 读写账）
   匹配器与本仓既有套件同尺：认等值键 ＋ `command.gt` / `command.in` 哨兵
   （`readOrderedWindow` 主路下发的就是这两种；`readAllBounded` 的退路用 `where({})`）。
   --------------------------------------------------------------------------- */
function createStore(seedRows) {
  const collections = new Map()
  const stats = { writes: [], reads: 0 }
  const mapOf = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  ;(seedRows || []).forEach((row) => {
    const name = row.__collection
    const copy = Object.assign({}, row)
    delete copy.__collection
    const map = mapOf(name)
    const key = String(copy._id || copy.id || `${name}-${map.size + 1}`)
    map.set(key, Object.assign({ _id: key }, copy))
  })
  const command = {
    gt: (value) => ({ __op: 'gt', value }),
    in: (values) => ({ __op: 'in', values: Array.isArray(values) ? values.slice() : [] })
  }
  const literal = (value) => (value === undefined || value === null ? '' : String(value))
  const matches = (row, match) =>
    Object.keys(match || {}).every((key) => {
      const expected = match[key]
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        if (expected.__op === 'gt') return literal(row[key]) > literal(expected.value)
        if (expected.__op === 'in') return expected.values.map((value) => String(value)).indexOf(String(row[key])) !== -1
        return false
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
  return { stats, provider, rows: (name) => [...mapOf(name).values()].map((row) => Object.assign({}, row)) }
}

/* ---------------------------------------------------------------------------
   3. 载入被测件 ＋ 假 CARD ＋ 假 DB
   --------------------------------------------------------------------------- */
const ops = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))
const sealCards = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/sealCards.js'))
const authorMatch = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/authorMatch.js'))
const cardApi = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/cardApi.js'))
const fn = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/index.js'))
const { createFakeCard, installFakeCard } = await import(path.join(HERE, 'fixtures/fake-card.mjs'))

/**
 * 种子规模（**离线段的口径**：真库现盘 CARD 573 行 / 本地镜像 570 行，差 3 行＝只在 CARD
 * 的人 —— 这正是本单要解决的问题，故这里照抄这个基数：570 面镜 ＋ 3 只属 CARD）。
 */
const LOCAL_COUNT = 570
const ZHAO_LOCAL_ID = 'PR000000310'
const ZHAO_CARD_ID = '900000310'
const ZHAO_COURTESY = '撝叔'
const CARD_ONLY_ID = '900000571'

const pad = (n) => String(n).padStart(9, '0')
const cardIdOf = (n) => pad(900000000 + n)

/* 本地 `xiai_persons`（570）：`id` / `code` ＝ `PR…`，`card_id` ＝ CARD 九位号（镜像回填）。
   第 310 号是**赵之谦**（4 / 11 两例的主体）。 */
const localRows = []
for (let n = 1; n <= LOCAL_COUNT; n += 1) {
  const cardId = cardIdOf(n)
  const base = {
    __collection: 'xiai_persons',
    _id: `PR${pad(n)}`,
    id: `PR${pad(n)}`,
    code: `PR${pad(n)}`,
    family_name: '測',
    given_name: `人${n}`,
    courtesy_names: [],
    art_names: [],
    alias_names: [],
    dynasty: '清',
    tags: [],
    cbdb_id: '',
    card_id: cardId
  }
  if (n === 310) {
    Object.assign(base, {
      family_name: '趙',
      given_name: '之謙',
      courtesy_names: [ZHAO_COURTESY],
      courtesy_name: ZHAO_COURTESY,
      art_names: ['悲盦'],
      art_name: '悲盦',
      alias_names: ['冷君', '憨寮'],
      biehao_text: '冷君\n憨寮',
      birth_year: 1829,
      death_year: 1884,
      native_place: '浙江會稽人。',
      biography: '趙之謙，字撝叔。'
    })
  }
  localRows.push(base)
}

/* CARD 侧（573）：570 面镜 ＋ 3 只在 CARD（`錢坫` 等）。 */
const cardRows = []
for (let n = 1; n <= LOCAL_COUNT; n += 1) {
  const row = {
    person_id: cardIdOf(n),
    name: `測人${n}`,
    family_name: '測',
    given_name: `人${n}`,
    courtesy_name: '',
    art_name: '',
    zhaihao: '',
    dynasty: '清',
    tags: [],
    cbdb_id: ''
  }
  if (n === 310) {
    Object.assign(row, {
      name: '趙之謙',
      family_name: '趙',
      given_name: '之謙',
      courtesy_name: ZHAO_COURTESY,
      art_name: '悲盦',
      zhaihao: '二金蜨堂',
      biehao_text: '冷君\n憨寮',
      zhaihao_alts: ['勇廬'],
      birth_year: 1829,
      death_year: 1884,
      native_place: '浙江會稽人。',
      native_place_chs: '浙江会稽人。',
      biography: '趙之謙，字撝叔。',
      biography_chs: '赵之谦，字撝叔。',
      tags: ['清代'],
      cbdb_id: '17696'
    })
  }
  cardRows.push(row)
}
cardRows.push({
  person_id: CARD_ONLY_ID,
  name: '錢坫',
  family_name: '錢',
  given_name: '坫',
  courtesy_name: '獻之',
  art_name: '十蘭',
  zhaihao: '篆秋艸堂',
  biehao_text: '別號一\n別號二',
  zhaihao_alts: [],
  dynasty: '清',
  tags: [],
  cbdb_id: ''
})
cardRows.push({ person_id: '900000572', name: '測外二', family_name: '測', given_name: '外二', courtesy_name: '', art_name: '', zhaihao: '', dynasty: '清', tags: [], cbdb_id: '' })
cardRows.push({ person_id: '900000573', name: '測外三', family_name: '測', given_name: '外三', courtesy_name: '', art_name: '', zhaihao: '', dynasty: '清', tags: [], cbdb_id: '' })

const store = createStore(localRows)
ops.setOpsDbProvider(store.provider)
const fakeCard = installFakeCard(createFakeCard({ persons: cardRows }))

/* 匿名调用（**不设任何令牌 / 身份 env**）。 */
const publicCall = (op, payload) => fn.main({ action: 'public', op, payload })
const indexCalls = () => fakeCard.state.calls.filter((call) => call.op === 'getIndex').length
const getPersonCalls = () => fakeCard.state.calls.filter((call) => call.op === 'getPerson').length

/* ===========================================================================
   R0：冻结键面逐字（唯一真源；直接引用被测件导出）
   =========================================================================== */
section('R0', '冻结键面：PUBLIC_OPS 恰 4 ／ 两 op 载荷与回包 ／ 索引行 10＋2 键')
{
  const publicKeys = Object.keys(sealCards.PUBLIC_OPS)
  check('R0', '`PUBLIC_OPS` **恰 4 成员**（listSealCards / suggestAuthors / listPersonCards / getPersonCard，皆函数）', {
    count: 4,
    keys: ['getPersonCard', 'listPersonCards', 'listSealCards', 'suggestAuthors'],
    types: ['function', 'function', 'function', 'function']
  }, {
    count: publicKeys.length,
    keys: sorted(publicKeys),
    types: sorted(publicKeys.map((key) => typeof sealCards.PUBLIC_OPS[key]))
  })
  check('R0b', '两个新 op 的载荷 / 回包键面逐字（1 / 4 ／ 1 / 2）＋ 索引行 10 键 ＋ 別號 2 键 ＋ 降级字面值', {
    listAllowed: ['include_biehao'],
    listSuccess: ['count', 'generated_at', 'ok', 'rows'],
    getAllowed: ['person_id'],
    getSuccess: ['ok', 'person'],
    rowKeys: ['art_name', 'cbdb_id', 'courtesy_name', 'dynasty', 'family_name', 'given_name', 'name', 'person_id', 'tags', 'zhaihao'],
    biehaoKeys: ['biehao_text', 'zhaihao_alts'],
    fallback: 'local-fallback'
  }, {
    listAllowed: sorted(sealCards.LIST_PERSON_CARDS_ALLOWED_KEYS),
    listSuccess: sorted(sealCards.LIST_PERSON_CARDS_SUCCESS_KEYS),
    getAllowed: sorted(sealCards.GET_PERSON_CARD_ALLOWED_KEYS),
    getSuccess: sorted(sealCards.GET_PERSON_CARD_SUCCESS_KEYS),
    rowKeys: sorted(sealCards.PERSON_CARD_ROW_KEYS),
    biehaoKeys: sorted(sealCards.PERSON_CARD_BIEHAO_KEYS),
    fallback: sealCards.PERSON_CARD_SOURCE_LOCAL
  })
}

/* ===========================================================================
   R1：listPersonCards —— CARD 路（573 行 × 10 键、回包恰 4 键、无 source）
   =========================================================================== */
section('R1', 'listPersonCards（CARD 路）：573 行 × 10 键、count 与 rows 同尺、零写')
let writesBefore = store.stats.writes.length
{
  fakeCard.setMode('ok')
  cardApi.resetCardIndexCache()
  const reply = await publicCall('listPersonCards')
  const rows = Array.isArray(reply.rows) ? reply.rows : []
  check('R1', '`listPersonCards` **CARD 路**：573 行、每行**恰 10 键**、回包**恰 4 键**（**无 `source`**）、`generated_at` 即上游值', {
    keys: 'count,generated_at,ok,rows',
    ok: true,
    generatedAt: '2026-11-13T00:00:00.000Z',
    count: 573,
    rowCount: 573,
    countEqualsRows: true,
    rowShapes: ['art_name,cbdb_id,courtesy_name,dynasty,family_name,given_name,name,person_id,tags,zhaihao']
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    generatedAt: reply.generated_at,
    count: reply.count,
    rowCount: rows.length,
    countEqualsRows: reply.count === rows.length,
    rowShapes: [...new Set(rows.map((row) => shapeOf(row)))]
  })
}

/* ===========================================================================
   R2：include_biehao:true ⇒ 12 键（別號原文字段在位）
   =========================================================================== */
section('R2', 'include_biehao:true ⇒ 行 12 键（biehao_text / zhaihao_alts）＋ 別號原文')
{
  const reply = await publicCall('listPersonCards', { include_biehao: true })
  const rows = Array.isArray(reply.rows) ? reply.rows : []
  const zhao = rows.find((row) => row.person_id === ZHAO_CARD_ID) || null
  check('R2', '`include_biehao:true` ⇒ 每行 **12 键**（基 10 ＋ `biehao_text` / `zhaihao_alts`）、赵之谦行的別號原文为 `冷君\\n憨寮`', {
    keys: 'count,generated_at,ok,rows',
    count: 573,
    rowKeyCount: 12,
    zhaoBiehao: '冷君\n憨寮',
    zhaoZhaihaoAlts: ['勇廬']
  }, {
    keys: shapeOf(reply),
    count: reply.count,
    rowKeyCount: rows.length > 0 ? Object.keys(rows[0]).length : 0,
    zhaoBiehao: zhao && zhao.biehao_text,
    zhaoZhaihaoAlts: zhao && zhao.zhaihao_alts
  })
}

/* ===========================================================================
   R3：CARD 超时 ⇒ 降级本地（570 行、10 键、source:'local-fallback'、恰 5 键）
   =========================================================================== */
section('R3', 'CARD 超时（abort）⇒ 降级本地 570 行 ＋ source="local-fallback"（不冒充 CARD）')
{
  fakeCard.setMode('abort')
  cardApi.resetCardIndexCache()
  const reply = await publicCall('listPersonCards')
  const rows = Array.isArray(reply.rows) ? reply.rows : []
  check('R3', '`listPersonCards` **CARD 超时** ⇒ 降级本地：**570 行 × 10 键**、回包**恰 5 键**（＋`source`）、`source="local-fallback"`、`count === rows.length`', {
    keys: 'count,generated_at,ok,rows,source',
    ok: true,
    source: 'local-fallback',
    count: 570,
    rowCount: 570,
    countEqualsRows: true,
    rowShapes: ['art_name,cbdb_id,courtesy_name,dynasty,family_name,given_name,name,person_id,tags,zhaihao']
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    source: reply.source,
    count: reply.count,
    rowCount: rows.length,
    countEqualsRows: reply.count === rows.length,
    rowShapes: [...new Set(rows.map((row) => shapeOf(row)))]
  })
  fakeCard.setMode('ok')
  cardApi.resetCardIndexCache()
}

/* ===========================================================================
   R4 / R5：getPersonCard —— 本地编号映射（PR…）／九位号直连（同一人）
   =========================================================================== */
section('R4', 'getPersonCard：PR… 经本地 card_id 映射 ⇒ 赵之谦（撝叔）；九位号 ⇒ 同一人')
{
  const byLocalId = await publicCall('getPersonCard', { person_id: ZHAO_LOCAL_ID })
  check('R4', '`getPersonCard({person_id:"PR000000310"})` ⇒ 命中**赵之谦**（`courtesy_name="撝叔"`）、回包**恰 2 键**', {
    keys: 'ok,person',
    ok: true,
    personId: ZHAO_CARD_ID,
    name: '趙之謙',
    courtesy: ZHAO_COURTESY,
    hasBiography: true
  }, {
    keys: shapeOf(byLocalId),
    ok: byLocalId.ok,
    personId: byLocalId.person && byLocalId.person.person_id,
    name: byLocalId.person && byLocalId.person.name,
    courtesy: byLocalId.person && byLocalId.person.courtesy_name,
    hasBiography: Boolean(byLocalId.person && byLocalId.person.biography)
  })
  const byCardId = await publicCall('getPersonCard', { person_id: ZHAO_CARD_ID })
  check('R5', '`getPersonCard({person_id:"900000310"})`（九位号）⇒ **同一人**（同号、同字）', {
    ok: true,
    personId: ZHAO_CARD_ID,
    samePersonAsLocalId: true
  }, {
    ok: byCardId.ok,
    personId: byCardId.person && byCardId.person.person_id,
    samePersonAsLocalId: JSON.stringify(byCardId.person) === JSON.stringify(byLocalId.person)
  })
}

/* ===========================================================================
   R6：不存在的编号 ⇒ INVALID_VALUE（云函数 REASONS 无 NOT_FOUND）
   ---------------------------------------------------------------------------
   修（原「零读」预期写错了）：判「不存在」本身就要读 —— 两条路各有下限：
     · `PR…` 且本地无此映射 ⇒ **映射不出 `card_id` ⇒ CARD 一次都不问**（`getPerson` ＝ 0），
       但「本地有没有这一行」只能读库判（`readLocalPersonOf` 依次试 `id` / `_id` / `code` /
       `card_id` 四形态）⇒ 本地读 1〜4 次；
     · 九位号 ⇒ **必须真问一次 CARD** 才能断言「CARD 也无此人」（`reads:0` 不可能成立）⇒
       `getPerson` 1〜2 次（同一 id 不得重复读）；CARD 落空后本地兜底两轮 × 四形态 ≤ 8 次。
   `INVALID_VALUE` ＋「該印人不存在」＋ 恰 3 键 ＋ **零写** 三条断言保留不动。
   =========================================================================== */
section('R6', '不存在的编号 ⇒ ok:false ＋ INVALID_VALUE（恰 3 键；读面按下限／上限定界）')
{
  const cases = [
    {
      id: 'R6a',
      desc: '本地无此 `PR…`（没有 `card_id` 可映射）',
      payload: { person_id: 'PR999999999' },
      cardReads: [0, 0], // 映射不出 `card_id` ⇒ 连 CARD 都不用问（**恰 0**）
      localReads: [1, 4] // 本地四形态各一次判「无此行」
    },
    {
      id: 'R6b',
      desc: '九位号既不在 CARD 也不在本地镜像',
      payload: { person_id: '999999999' },
      cardReads: [1, 2], // 必须真问一次 CARD；同一 id 不得重复读（≤ 2）
      localReads: [1, 8] // CARD 落空后本地兜底：两轮 × 四形态
    }
  ]
  for (const item of cases) {
    const localReadsBefore = store.stats.reads
    const cardReadsBefore = getPersonCalls()
    const reply = await publicCall('getPersonCard', item.payload)
    const localReads = store.stats.reads - localReadsBefore
    const cardReads = getPersonCalls() - cardReadsBefore
    const writesBeforeCase = store.stats.writes.length
    check(
      item.id,
      `\`getPersonCard\` ${item.desc} ⇒ \`INVALID_VALUE\` ＋「該印人不存在」＋ 恰 3 键 ＋ **零写** ＋ ` +
        `CARD 读 ${item.cardReads[0]}〜${item.cardReads[1]} 次 / 本地读 ${item.localReads[0]}〜${item.localReads[1]} 次` +
        `（**不再断言「零读」**：判「不存在」本身必须读）`,
      {
        ok: false,
        reason: 'INVALID_VALUE',
        keys: 'message,ok,reason',
        mentionsMissing: true,
        cardReadsInBounds: true,
        localReadsInBounds: true,
        writes: 0
      },
      {
        ok: reply.ok,
        reason: reply.reason,
        keys: shapeOf(reply),
        mentionsMissing: String(reply.message || '').indexOf('不存在') !== -1,
        cardReadsInBounds: cardReads >= item.cardReads[0] && cardReads <= item.cardReads[1],
        localReadsInBounds: localReads >= item.localReads[0] && localReads <= item.localReads[1],
        writes: store.stats.writes.length - writesBeforeCase
      }
    )
    /* 读数（诊断行，不进断言）：证明上下界是如实量出来的，不是凑绿。 */
    console.log(JSON.stringify({ diag: item.id, cardReads, localReads }))
  }
}

/* ===========================================================================
   R7：suggestAuthors 候选来自 CARD（只在 CARD 有的人能命中）
   =========================================================================== */
section('R7', 'suggestAuthors 候选源 ＝ CARD 索引：只在 CARD 有的人（錢坫）能命中')
{
  cardApi.resetCardIndexCache()
  fakeCard.setMode('ok')
  const reply = await publicCall('suggestAuthors', { name: '錢坫', limit: 5 })
  const candidates = Array.isArray(reply.candidates) ? reply.candidates : []
  const top = candidates[0] || null
  check('R7', '`suggestAuthors({name:"錢坫"})` ⇒ 命中**只在 CARD 有的人**（本地镜像里没有）：候选 `person_id` ＝ CARD 九位号、`matched_field="name"`、`score=100`', {
    keys: 'candidates,normalized,ok,query',
    ok: true,
    query: '錢坫',
    candidateCount: 1,
    top: { person_id: CARD_ONLY_ID, matched_field: 'name', score: 100, display_name: '錢坫' }
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    query: reply.query,
    candidateCount: candidates.length,
    top: top && { person_id: top.person_id, matched_field: top.matched_field, score: top.score, display_name: top.display_name }
  })
}

/* ===========================================================================
   R8：CARD 不可用时 suggestAuthors 仍能工作（降级本地）＋ 负对照
   =========================================================================== */
section('R8', 'CARD 不可用 ⇒ suggestAuthors 降级本地（趙之謙 命中；只在 CARD 的人查不到）')
{
  fakeCard.setMode('down')
  cardApi.resetCardIndexCache()
  const reply = await publicCall('suggestAuthors', { name: '趙之謙', limit: 5 })
  const candidates = Array.isArray(reply.candidates) ? reply.candidates : []
  const top = candidates[0] || null
  check('R8', '`suggestAuthors` 在 **CARD 不可用**时仍工作（降级本地 `xiai_persons`）：`趙之謙` 命中、`person_id` 取本地行的 `card_id`', {
    ok: true,
    query: '趙之謙',
    candidateCount: 1,
    top: { person_id: ZHAO_CARD_ID, matched_field: 'name', score: 100 }
  }, {
    ok: reply.ok,
    query: reply.query,
    candidateCount: candidates.length,
    top: top && { person_id: top.person_id, matched_field: top.matched_field, score: top.score }
  })
  const onlyCardPerson = await publicCall('suggestAuthors', { name: '錢坫', limit: 5 })
  check('R8b', '负对照：同刻「只在 CARD 有的人」（`錢坫`）**查不到** ⇒ 证明当前候选源确实是本地镜像（不是 CARD 缓存）', {
    ok: true,
    candidateCount: 0,
    candidates: []
  }, {
    ok: onlyCardPerson.ok,
    candidateCount: (onlyCardPerson.candidates || []).length,
    candidates: onlyCardPerson.candidates || []
  })
  fakeCard.setMode('ok')
  cardApi.resetCardIndexCache()
}

/* ===========================================================================
   R9：缓存生效（60s 内只调 1 次 CARD；include_biehao 两个键面各一份）
   =========================================================================== */
section('R9', '索引缓存：连打两次 ⇒ getIndex 只调 1 次；include_biehao 两键面各一份')
{
  cardApi.resetCardIndexCache()
  fakeCard.resetCalls()
  await publicCall('listPersonCards')
  await publicCall('listPersonCards')
  const afterTwo = indexCalls()
  await publicCall('listPersonCards', { include_biehao: true })
  const afterBiehao = indexCalls()
  await publicCall('listPersonCards', { include_biehao: true })
  const afterBiehaoTwice = indexCalls()
  check('R9', '**60s 缓存生效**：同键面连打两次 ⇒ `getIndex` **只调 1 次**；`include_biehao` 是**另一个缓存键**（第 1 次另起 1 次、第 2 次复用）', {
    afterTwoCalls: 1,
    afterBiehaoCalls: 2,
    afterBiehaoTwiceCalls: 2
  }, {
    afterTwoCalls: afterTwo,
    afterBiehaoCalls: afterBiehao,
    afterBiehaoTwiceCalls: afterBiehaoTwice
  })
}

/* ===========================================================================
   R10：错误结果不入缓存（失败后恢复 ⇒ 下一次立刻再打 CARD 并回 CARD 路）
   =========================================================================== */
section('R10', '失败不缓存：CARD 失败降级后恢复 ⇒ 下一次立刻打 CARD 并回 CARD 路')
{
  cardApi.resetCardIndexCache()
  fakeCard.resetCalls()
  fakeCard.setMode('down')
  const degraded = await publicCall('listPersonCards')
  const afterFail = indexCalls()
  fakeCard.setMode('ok')
  const recovered = await publicCall('listPersonCards')
  const afterRecover = indexCalls()
  check('R10', '**错误结果不入缓存**：失败轮降级（`source` 在位）后立刻恢复 ⇒ 下一轮**重新请求 CARD**（调用数 1 → 2）并回到 CARD 路（**无 `source`**、573 行）', {
    degradedSource: 'local-fallback',
    degradedRows: 570,
    afterFailCalls: 1,
    recoveredKeys: 'count,generated_at,ok,rows',
    recoveredRows: 573,
    afterRecoverCalls: 2
  }, {
    degradedSource: degraded.source,
    degradedRows: (degraded.rows || []).length,
    afterFailCalls: afterFail,
    recoveredKeys: shapeOf(recovered),
    recoveredRows: (recovered.rows || []).length,
    afterRecoverCalls: afterRecover
  })
  cardApi.resetCardIndexCache()
}

/* ===========================================================================
   R11：getPersonCard 在 CARD 不可用时降级本地（source:'local-fallback'）
   =========================================================================== */
section('R11', 'getPersonCard 在 CARD 不可用时降级本地（恰 3 键 ＋ source）')
{
  fakeCard.setMode('down')
  cardApi.resetCardIndexCache()
  const reply = await publicCall('getPersonCard', { person_id: ZHAO_LOCAL_ID })
  check('R11', '`getPersonCard`（CARD 不可用）⇒ 降级本地行投影：`source="local-fallback"`、恰 3 键、`courtesy_name="撝叔"`、`person_id` 仍为九位号', {
    keys: 'ok,person,source',
    ok: true,
    source: 'local-fallback',
    personId: ZHAO_CARD_ID,
    courtesy: ZHAO_COURTESY,
    hasBiography: true
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    source: reply.source,
    personId: reply.person && reply.person.person_id,
    courtesy: reply.person && reply.person.courtesy_name,
    hasBiography: Boolean(reply.person && reply.person.biography)
  })
  fakeCard.setMode('ok')
  cardApi.resetCardIndexCache()
}

/* ===========================================================================
   R12：载荷门（判定早于任何读 / 任何 CARD 调用）
   =========================================================================== */
section('R12', '载荷门：未知键与身份键 ⇒ INVALID_FIELD；include_biehao 非布尔 ⇒ INVALID_VALUE；缺 person_id ⇒ MISSING_REQUIRED')
{
  const cases = [
    ['R12a', 'listPersonCards 未知键 `bogus`', 'listPersonCards', { bogus: 1 }, 'INVALID_FIELD'],
    ['R12b', 'listPersonCards 身份类键 `user_id`', 'listPersonCards', { user_id: 'u-x' }, 'INVALID_FIELD'],
    ['R12c', 'listPersonCards `include_biehao` 非布尔（`"yes"`）', 'listPersonCards', { include_biehao: 'yes' }, 'INVALID_VALUE'],
    ['R12d', 'getPersonCard 缺 `person_id`', 'getPersonCard', {}, 'MISSING_REQUIRED'],
    ['R12e', 'getPersonCard 身份类键 `phone`', 'getPersonCard', { person_id: ZHAO_LOCAL_ID, phone: '13900000000' }, 'INVALID_FIELD']
  ]
  cardApi.resetCardIndexCache()
  fakeCard.resetCalls()
  for (const [id, desc, op, payload, reason] of cases) {
    const readsBefore = store.stats.reads
    const reply = await publicCall(op, payload)
    check(id, `\`${desc}\` ⇒ \`${reason}\` ＋ 恰 3 键 ＋ **零读**`, {
      ok: false,
      reason,
      keys: 'message,ok,reason',
      reads: 0
    }, {
      ok: reply.ok,
      reason: reply.reason,
      keys: shapeOf(reply),
      reads: store.stats.reads - readsBefore
    })
  }
  check('R12f', '载荷门**先于**任何 CARD 调用：五发非法载荷后 `getIndex` / `getPerson` 调用数皆 0', { index: 0, person: 0 }, {
    index: indexCalls(),
    person: getPersonCalls()
  })
}

/* ===========================================================================
   R13：全程零写入
   =========================================================================== */
section('R13', '零写入：人物读面全程不写任何集合')
check('R13', '本套件全程**零写入**（假 DB 写账在 R1 之后未再增长；`PUBLIC_OPS` 是只读面）', 0, store.stats.writes.length - writesBefore)

/* ===========================================================================
   汇总
   =========================================================================== */
console.log(JSON.stringify({ summary: { total: results.length, passed: results.length - failures, failures } }))
if (failures > 0) {
  console.log(`FAILED: ${failures} / ${results.length}`)
  process.exit(1)
}
console.log('OK: all checks passed')
