#!/usr/bin/env node
/**
 * 玺爱 · **公开只读面自检**（`PUBLIC_OPS` ＝ `listSealCards` ＋ `suggestAuthors`）
 * ============================================================================ *
 * **本地、离线、零网络、零云端、零生产数据**：注入式内存假 DB，跑的是
 * `cloudfunctions/xiai-user-token/index.js` 的**真实入口**（`main`）与
 * `lib/sealCards.js` / `lib/authorMatch.js` 的**真实函数体**。
 *
 * 断言面（六组；每条可机械判负）：
 *   P0. **七张冻结常量逐字**（唯一真源，直接引用被测件导出、不重抄）：
 *       `LIST_SEAL_CARDS_ALLOWED_KEYS`(6) / `LIST_SEAL_CARDS_SUCCESS_KEYS`(5：
 *       ok,rows,next_cursor,has_more,total) / `CARD_ROW_KEYS`(14) /
 *       `SUGGEST_AUTHORS_ALLOWED_KEYS`(3：face_id,name,limit) /
 *       `SUGGEST_AUTHORS_SUCCESS_KEYS`(4：ok,query,normalized,candidates) /
 *       `AUTHOR_CANDIDATE_KEYS`(7) / `MATCHED_FIELDS`(5：name,alias,courtesy,art,contains)。
 *   P1. `PUBLIC_OPS` **恰 2 成员**（`listSealCards` / `suggestAuthors`，皆函数）；
 *       表外 op（含一切管理员 op）走 `action:'public'` ⇒ `FORBIDDEN` ＋ 零读。
 *   P2. **两 op 载荷封闭**：未知键 / **身份类键**（`user_id` / `phone`）⇒ `INVALID_FIELD`
 *       ＋ 恰 3 键拒绝 ＋ 零读（判定早于任何读）。
 *   P3. `listSealCards` 回包**恰 5 键**、`rows` 每元素**恰 14 键**。
 *   P4. `suggestAuthors` 回包**恰 4 键**、候选每元素**恰 7 键**、`matched_field` 封闭五值。
 *   P5. **0 面印章不进 `rows`**（数据层允许、展示层不列；`total` 仍计它）。
 *   P6. **匿名可调**（`main({action:'public', op})` 无令牌即成功）；**非 public action 仍被拦**
 *       （无令牌 ⇒ 结构化拒绝、不回读面）；全程**零写入**。
 *
 * 纪律：不打印任何密钥 / 令牌；不碰任何服务；断言失败 ⇒ 退出码非 0。
 *
 * 用法：node scripts/verify-public-ops.mjs
 */

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
   2. 注入式内存假 DB（`createStore` 形态：`collection(name).where(match).get()` ＋ 计数探针）
   --------------------------------------------------------------------------- */
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
  const provider = () => ({
    collection(name) {
      const map = mapOf(name)
      const all = () => [...map.values()].map((row) => Object.assign({}, row))
      const hit = (match) => all().filter((row) => Object.keys(match || {}).every((k) => row[k] === match[k]))
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
  return {
    stats,
    provider,
    rows: (name) => [...mapOf(name).values()].map((row) => Object.assign({}, row))
  }
}

/* ---------------------------------------------------------------------------
   3. 载入被测件 ＋ 注入假 DB（**离线进程内设值**；生产真源 ＝ 云函数环境变量）
   --------------------------------------------------------------------------- */
const ops = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))
const sealCards = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/sealCards.js'))
const authorMatch = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/authorMatch.js'))
const fn = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/index.js'))

/* 种子：2 枚印章（其一 **0 面**）＋ 2 个印面（FACE ＋ EDGE）＋ 2 个印人。 */
const SEAL_ONE = 'SL000000001'
const SEAL_ZERO_FACE = 'SL000000002'
const FACE_SHA = 'a1'.repeat(32)
const store = createStore([
  { __collection: 'xiai_seals', _id: SEAL_ONE, stamp_id: SEAL_ONE, seal_name: '甲印', dynasty: '汉', category: '吉语印' },
  { __collection: 'xiai_seals', _id: SEAL_ZERO_FACE, stamp_id: SEAL_ZERO_FACE, seal_name: '零面印', dynasty: '汉', category: '吉语印' },
  {
    __collection: 'xiai_faces',
    _id: 'fc-0001',
    id: 'fc-0001',
    sealId: SEAL_ONE,
    kind: 'FACE',
    face_no: 1,
    is_primary: true,
    face_image_id: 'img-0001',
    image_sha256: FACE_SHA,
    image_mime: 'image/png'
  },
  { __collection: 'xiai_faces', _id: 'fc-0002', id: 'fc-0002', sealId: SEAL_ONE, kind: 'EDGE', face_no: 2 },
  {
    __collection: 'xiai_persons',
    _id: 'p-0001',
    id: 'p-0001',
    family_name: '王',
    given_name: '文',
    alias_names: [],
    courtesy_names: [],
    art_names: [],
    dynasty: '清'
  },
  {
    __collection: 'xiai_persons',
    _id: 'p-0002',
    id: 'p-0002',
    family_name: '李',
    given_name: '白',
    alias_names: ['青蓮'],
    courtesy_names: [],
    art_names: [],
    dynasty: '唐'
  }
])
ops.setOpsDbProvider(store.provider)

/* 匿名调用（**不设任何令牌 / 身份 env**）。 */
const publicCall = (op, payload) => fn.main({ action: 'public', op, payload })

/* ===========================================================================
   P0：七张冻结常量逐字（唯一真源；直接引用被测件导出）
   =========================================================================== */
section('P0', '冻结常量逐字：载荷 / 回包 / 卡片行 / 候选行 / 命中字段七张表')
check('P0', '七张冻结常量逐字 ＝ 契约值（6 / 5 / 14 / 3 / 4 / 7 / 5）', {
  listAllowed: ['category', 'cursor', 'dynasty', 'face_style', 'limit', 'seal_type'],
  listSuccess: ['has_more', 'next_cursor', 'ok', 'rows', 'total'],
  cardRow: [
    'category',
    'display_key',
    'dynasty',
    'edge_count',
    'face_count',
    'height',
    'image_id',
    'image_mime',
    'image_sha256',
    'primary_face_id',
    'seal_name',
    'stamp_id',
    'thumb_key',
    'width'
  ],
  suggestAllowed: ['face_id', 'limit', 'name'],
  suggestSuccess: ['candidates', 'normalized', 'ok', 'query'],
  candidate: [
    'display_name',
    'dynasty',
    'is_current',
    'matched_field',
    'matched_value',
    'person_id',
    'score'
  ],
  matchedFields: ['alias', 'art', 'contains', 'courtesy', 'name'],
  sizes: [6, 5, 14, 3, 4, 7, 5]
}, {
  listAllowed: sorted(sealCards.LIST_SEAL_CARDS_ALLOWED_KEYS),
  listSuccess: sorted(sealCards.LIST_SEAL_CARDS_SUCCESS_KEYS),
  cardRow: sorted(sealCards.CARD_ROW_KEYS),
  suggestAllowed: sorted(authorMatch.SUGGEST_AUTHORS_ALLOWED_KEYS),
  suggestSuccess: sorted(authorMatch.SUGGEST_AUTHORS_SUCCESS_KEYS),
  candidate: sorted(authorMatch.AUTHOR_CANDIDATE_KEYS),
  matchedFields: sorted(authorMatch.MATCHED_FIELDS),
  sizes: [
    sealCards.LIST_SEAL_CARDS_ALLOWED_KEYS.length,
    sealCards.LIST_SEAL_CARDS_SUCCESS_KEYS.length,
    sealCards.CARD_ROW_KEYS.length,
    authorMatch.SUGGEST_AUTHORS_ALLOWED_KEYS.length,
    authorMatch.SUGGEST_AUTHORS_SUCCESS_KEYS.length,
    authorMatch.AUTHOR_CANDIDATE_KEYS.length,
    authorMatch.MATCHED_FIELDS.length
  ]
})

/* ===========================================================================
   P1：`PUBLIC_OPS` 恰 2 成员 ＋ 表外 op 走 public ⇒ FORBIDDEN ＋ 零读
   =========================================================================== */
section('P1', 'PUBLIC_OPS 恰 2（listSealCards / suggestAuthors）；表外 op ⇒ FORBIDDEN')
{
  const keys = Object.keys(sealCards.PUBLIC_OPS)
  const readsBefore = store.stats.reads
  const denied = await publicCall('repairPrimaryFace', {})
  check('P1', '`PUBLIC_OPS` **恰 2 成员**（`listSealCards` / `suggestAuthors`，皆函数）', {
    count: 2,
    keys: ['listSealCards', 'suggestAuthors'],
    types: ['function', 'function']
  }, {
    count: keys.length,
    keys: sorted(keys),
    types: sorted(keys.map((key) => typeof sealCards.PUBLIC_OPS[key]))
  })
  check('P1b', '表外 op（管理员 op `repairPrimaryFace`）走 `action:"public"` ⇒ `FORBIDDEN` 恰 3 键 ＋ **零读**', {
    ok: false,
    reason: 'FORBIDDEN',
    keys: 'message,ok,reason',
    reads: 0
  }, {
    ok: denied.ok,
    reason: denied.reason,
    keys: shapeOf(denied),
    reads: store.stats.reads - readsBefore
  })
}

/* ===========================================================================
   P2：两 op 载荷封闭（未知键 / 身份类键 ⇒ INVALID_FIELD；判定早于任何读）
   =========================================================================== */
section('P2', '载荷封闭：未知键与身份类键一律 INVALID_FIELD（恰 3 键拒绝、零读）')
{
  const cases = [
    ['P2a', 'listSealCards 载荷含**未知键** `bogus` ⇒ `INVALID_FIELD`', { limit: 10, bogus: 1 }],
    ['P2b', 'listSealCards 载荷含**身份类键** `user_id` ⇒ `INVALID_FIELD`（服务端派生、不采信前端自称）', { limit: 10, user_id: 'u-x' }],
    ['P2c', 'suggestAuthors 载荷含**未知键** `bogus` ⇒ `INVALID_FIELD`', { name: '王文', bogus: 1 }],
    ['P2d', 'suggestAuthors 载荷含**身份类键** `phone` ⇒ `INVALID_FIELD`', { name: '王文', phone: '13900000000' }]
  ]
  for (const [id, desc, payload] of cases) {
    const op = id === 'P2a' || id === 'P2b' ? 'listSealCards' : 'suggestAuthors'
    const readsBefore = store.stats.reads
    const reply = await publicCall(op, payload)
    check(id, desc, { ok: false, reason: 'INVALID_FIELD', keys: 'message,ok,reason', reads: 0 }, {
      ok: reply.ok,
      reason: reply.reason,
      keys: shapeOf(reply),
      reads: store.stats.reads - readsBefore
    })
  }
}

/* ===========================================================================
   P3：`listSealCards` 回包恰 5 键 ＋ `rows` 每元素恰 14 键
   =========================================================================== */
section('P3', 'listSealCards：回包恰 5 键 / rows 每元素恰 14 键 / total 与 rows 同尺')
{
  const reply = await publicCall('listSealCards', { limit: 10 })
  const rows = Array.isArray(reply.rows) ? reply.rows : []
  check('P3', '`listSealCards` 成功回包**恰 5 键**、`rows` 每元素**恰 14 键**（＝ `CARD_ROW_KEYS`）', {
    keys: 'has_more,next_cursor,ok,rows,total',
    ok: true,
    rowCount: 1,
    rowShapes: ['category,display_key,dynasty,edge_count,face_count,height,image_id,image_mime,image_sha256,primary_face_id,seal_name,stamp_id,thumb_key,width'],
    thumbIsContentAddressed: true
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    rowCount: rows.length,
    rowShapes: rows.map((row) => shapeOf(row)),
    thumbIsContentAddressed: rows.every((row) => row.thumb_key === `xiai/images/${FACE_SHA.slice(0, 2)}/${FACE_SHA}.png`)
  })
}

/* ===========================================================================
   P4：`suggestAuthors` 回包恰 4 键 ＋ 候选恰 7 键 ＋ `matched_field` 封闭五值
   =========================================================================== */
section('P4', 'suggestAuthors：回包恰 4 键 / 候选恰 7 键 / matched_field 五值封闭')
{
  const reply = await publicCall('suggestAuthors', { name: '王文', limit: 5 })
  const candidates = Array.isArray(reply.candidates) ? reply.candidates : []
  const badFields = candidates.map((c) => c.matched_field).filter((field) => authorMatch.MATCHED_FIELDS.indexOf(field) === -1)
  check('P4', '`suggestAuthors` 成功回包**恰 4 键**、候选每元素**恰 7 键**、`matched_field` 封闭五值（`name` 精确命中、score 100）', {
    keys: 'candidates,normalized,ok,query',
    ok: true,
    query: '王文',
    normalized: '王文',
    candidateCount: 1,
    candidateShapes: ['display_name,dynasty,is_current,matched_field,matched_value,person_id,score'],
    badFields: [],
    top: { person_id: 'p-0001', matched_field: 'name', score: 100, is_current: false }
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    query: reply.query,
    normalized: reply.normalized,
    candidateCount: candidates.length,
    candidateShapes: candidates.map((row) => shapeOf(row)),
    badFields,
    top: candidates[0] && {
      person_id: candidates[0].person_id,
      matched_field: candidates[0].matched_field,
      score: candidates[0].score,
      is_current: candidates[0].is_current
    }
  })
}

/* ===========================================================================
   P5：0 面印章不进 `rows`（数据层允许、展示层不列；`total` 仍计它）
   =========================================================================== */
section('P5', '0 面印章：不进 rows，但计入 total')
{
  const reply = await publicCall('listSealCards', { limit: 10 })
  const stampIds = (Array.isArray(reply.rows) ? reply.rows : []).map((row) => row.stamp_id)
  check('P5', '0 面印章**不进 `rows`**（`total` 仍计它 ⇒ total 2 / rows 1）', {
    hasZeroFaceInRows: false,
    stampIds: [SEAL_ONE],
    total: 2,
    rowCount: 1
  }, {
    hasZeroFaceInRows: stampIds.indexOf(SEAL_ZERO_FACE) !== -1,
    stampIds,
    total: reply.total,
    rowCount: stampIds.length
  })
}

/* ===========================================================================
   P6：匿名可调 ＋ 非 public action 仍被拦 ＋ 全程零写入
   =========================================================================== */
section('P6', '匿名可调（无令牌即成功）/ 非 public action 仍被拦 / 全程零写入')
{
  const anonList = await publicCall('listSealCards', { limit: 5 })
  const anonSuggest = await publicCall('suggestAuthors', { name: '王文' })
  const verifyBlocked = await fn.main({ action: 'verify', op: 'listSealCards', payload: { limit: 5 } })
  const adminBlocked = await fn.main({ action: 'admin', op: 'suggestAuthors', payload: { name: '王文' } })
  check('P6', '**匿名可调**（`main({action:"public", op})` 零令牌即成功、回包恰契约键面）；**非 public action 仍被拦**（`verify` / `admin` 无令牌 ⇒ 结构化拒绝、**不回读面键**）；全程**零写入**', {
    anonList: 'has_more,next_cursor,ok,rows,total',
    anonSuggest: 'candidates,normalized,ok,query',
    verifyOk: false,
    verifyKeys: 'message,ok,reason',
    adminOk: false,
    adminHasRows: false,
    adminHasCandidates: false,
    writes: 0
  }, {
    anonList: shapeOf(anonList),
    anonSuggest: shapeOf(anonSuggest),
    verifyOk: verifyBlocked.ok,
    verifyKeys: shapeOf(verifyBlocked),
    adminOk: adminBlocked.ok,
    adminHasRows: Object.prototype.hasOwnProperty.call(adminBlocked, 'rows'),
    adminHasCandidates: Object.prototype.hasOwnProperty.call(adminBlocked, 'candidates'),
    writes: store.stats.writes.length
  })
}

/* ===========================================================================
   收尾
   =========================================================================== */
const passed = results.filter((r) => r.pass).length
console.log(JSON.stringify({ summary: { total: results.length, passed, failures } }))
if (failures > 0) {
  console.error(`FAILED: ${failures} / ${results.length}`)
  process.exit(1)
}
