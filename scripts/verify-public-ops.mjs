#!/usr/bin/env node
/**
 * 玺爱 · **公开只读面自检**（`PUBLIC_OPS` ＝ `listSealCards` ＋ `suggestAuthors`）
 * ============================================================================ *
 * **本地、离线、零网络、零云端、零生产数据**：注入式内存假 DB，跑的是
 * `cloudfunctions/xiai-user-token/index.js` 的**真实入口**（`main`）与
 * `lib/sealCards.js` / `lib/authorMatch.js` 的**真实函数体**。
 *
 * 断言面（九组；每条可机械判负）：
 *   P0. **七张冻结常量逐字**（唯一真源，直接引用被测件导出、不重抄）：
 *       `LIST_SEAL_CARDS_ALLOWED_KEYS`(7：`limit,cursor,dynasty,seal_type,face_style,category,q`) /
 *       `LIST_SEAL_CARDS_SUCCESS_KEYS`(5：
 *       ok,rows,next_cursor,has_more,total) / `CARD_ROW_KEYS`(14) /
 *       `SUGGEST_AUTHORS_ALLOWED_KEYS`(3：face_id,name,limit) /
 *       `SUGGEST_AUTHORS_SUCCESS_KEYS`(4：ok,query,normalized,candidates) /
 *       `AUTHOR_CANDIDATE_KEYS`(7) / `MATCHED_FIELDS`(5：name,alias,courtesy,art,contains)。
 *   P1. `PUBLIC_OPS` **恰 4 成员**（`listSealCards` / `suggestAuthors` / `listPersonCards` /
 *       `getPersonCard`，皆函数）；表外 op（含一切管理员 op）走 `action:'public'` ⇒ `FORBIDDEN` ＋ 零读。
 *   P2. **两 op 载荷封闭**：未知键 / **身份类键**（`user_id` / `phone`）⇒ `INVALID_FIELD`
 *       ＋ 恰 3 键拒绝 ＋ 零读（判定早于任何读）。
 *   P3. `listSealCards` 回包**恰 5 键**、`rows` 每元素**恰 14 键**。
 *   P4. `suggestAuthors` 回包**恰 4 键**、候选每元素**恰 7 键**、`matched_field` 封闭五值。
 *   P5. **0 面印章不进 `rows`，也不计 `total`**（印章侧 where 恒带 `face_count >= 1` ⇒ 零面章在数据层即被排除）。
 *   P6. **匿名可调**（`main({action:'public', op})` 无令牌即成功）；**非 public action 仍被拦**
 *       （无令牌 ⇒ 结构化拒绝、不回读面）；全程**零写入**。
 *   P7. **关键词 `q` 门**（四发，均**零写入**、两发拒绝**零读**）：非字符串 ⇒ `INVALID_VALUE`；
 *       trim 后 41 字 ⇒ `INVALID_VALUE`；40 字 ⇒ 放行（成功回包 5 键）；空白串 ⇒ **等同不检索**
 *       （与不带 `q` 的回包逐字节相同）。
 *   P8. **关键词转义**（三发）：`q='*'` / `q='（'` / `q='a.b'` 皆**不抛错、不被拒**，且**只命中**
 *       含该字面量的那一行（假 DB 3 行：一行含三字面量、两行不含 ⇒ `total===1`、`rows` 恰 1 枚）。
 *   P9. **`total` ＝ 命中总数**（不是已载入数）：60 行命中 ＋ `limit=48` ⇒ `total===60`、
 *       `rows.length===48`、`has_more===true`（`rows` 按命中集分页，与 `total` 同尺）。
 *
 * 纪律：不打印任何密钥 / 令牌；不碰任何服务；断言失败 ⇒ 退出码非 0。
 *
 * 用法：node scripts/verify-public-ops.mjs
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
   2. 注入式内存假 DB（`createStore` 形态：`collection(name).where(match).get()` ＋ 计数探针）
   匹配器与**主路同尺**：认等值键、`$or` / `$and` / `$nor` 组、`$regularExpression` 关键词子句
   与 `command.gt` / `command.in` 哨兵 —— 即 `db.command` 在场时 `readOrderedWindow` 下发给
   DB 的 `where` 片段，假体**逐条同判**（关键词 `q` 的行级命中因此在本套件里可观测；
   无 `command` 时被测件走退路 `readOrderedWindowFallback`，只按 idIn / 游标收口、**不判 match**）。
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
  /* DB 命令面（`commandOf` 只认 `gt`；`readOrderedWindow` 另认 `in`）。哨兵形态自定 ——
     只要假体自己的匹配器认得（与 `db.RegExp` 同法：句柄没有 ⇒ 落 wire 字面值）。 */
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
            return false /* 畸形正则 ⇒ 不猜、不命中（与被测件内存判同口径）。 */
          }
        }
        if (expected.__op === 'gt') return literal(row[key]) > literal(expected.value)
        if (expected.__op === 'in') return expected.values.map((value) => String(value)).indexOf(String(row[key])) !== -1
        if (expected.$gte !== undefined) {
          /* 数值下界（`listSealCards` 印章侧 `face_count >= 1` 的 wire 字面值形态；
             口径与被测件 `rowMatchesQuery` 逐字一致：缺字段 / 非数值 ⇒ 恒假）。 */
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
  { __collection: 'xiai_seals', _id: SEAL_ONE, stamp_id: SEAL_ONE, seal_name: '甲印', dynasty: '汉', category: '吉语印', face_count: 1 },
  { __collection: 'xiai_seals', _id: SEAL_ZERO_FACE, stamp_id: SEAL_ZERO_FACE, seal_name: '零面印', dynasty: '汉', category: '吉语印', face_count: 0 },
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
check('P0', '七张冻结常量逐字 ＝ 契约值（7 / 5 / 14 / 3 / 4 / 7 / 5）', {
  listAllowed: ['category', 'cursor', 'dynasty', 'face_style', 'limit', 'q', 'seal_type'],
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
  sizes: [7, 5, 14, 3, 4, 7, 5]
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
   P1：`PUBLIC_OPS` 恰 4 成员 ＋ 表外 op 走 public ⇒ FORBIDDEN ＋ 零读
   =========================================================================== */
section('P1', 'PUBLIC_OPS 恰 4（listSealCards / suggestAuthors / listPersonCards / getPersonCard）；表外 op ⇒ FORBIDDEN')
{
  const keys = Object.keys(sealCards.PUBLIC_OPS)
  const readsBefore = store.stats.reads
  const denied = await publicCall('repairPrimaryFace', {})
  check('P1', '`PUBLIC_OPS` **恰 4 成员**（`listSealCards` / `suggestAuthors` / `listPersonCards` / `getPersonCard`，皆函数）', {
    count: 4,
    keys: ['getPersonCard', 'listPersonCards', 'listSealCards', 'suggestAuthors'],
    types: ['function', 'function', 'function', 'function']
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
   P5：0 面印章不进 `rows`、也不计 `total`（where 恒带 face_count >= 1）
   =========================================================================== */
section('P5', '0 面印章：不进 rows，也不计入 total')
{
  const reply = await publicCall('listSealCards', { limit: 10 })
  const stampIds = (Array.isArray(reply.rows) ? reply.rows : []).map((row) => row.stamp_id)
  check('P5', '0 面印章**不进 `rows`、也不计 `total`**（where 恒带 `face_count >= 1` ⇒ total 1 / rows 1）', {
    hasZeroFaceInRows: false,
    stampIds: [SEAL_ONE],
    total: 1,
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

/* 换注入跑专项（跑完**必然还原主种子**：P3 / P5 的读数以主种子为准）。 */
const withInjectedStore = async (target, run) => {
  ops.setOpsDbProvider(target.provider)
  try {
    return await run()
  } finally {
    ops.setOpsDbProvider(store.provider)
  }
}

/* ===========================================================================
   P7：关键词 `q` 载荷门（非字符串 / trim>40 ⇒ INVALID_VALUE 零读；40 字放行；空白串 ＝ 不检索）
   =========================================================================== */
section('P7', 'q 关键词门：非字符串与 trim 后 41 字 ⇒ INVALID_VALUE（零读）、40 字放行、空白串等同不检索')
{
  const gates = [
    ['P7a', '`q` **非字符串**（数字 42）⇒ `INVALID_VALUE` ＋ 恰 3 键 ＋ **零读** ＋ **零写**', { limit: 10, q: 42 }],
    [
      'P7b',
      '`q` **trim 后 41 字**（越 40 字上界）⇒ `INVALID_VALUE` ＋ 恰 3 键 ＋ **零读** ＋ **零写**（不静默截断）',
      { limit: 10, q: 'x'.repeat(41) }
    ]
  ]
  for (const [id, desc, payload] of gates) {
    const readsBefore = store.stats.reads
    const writesBefore = store.stats.writes.length
    const reply = await publicCall('listSealCards', payload)
    check(id, desc, { ok: false, reason: 'INVALID_VALUE', keys: 'message,ok,reason', reads: 0, writes: 0 }, {
      ok: reply.ok,
      reason: reply.reason,
      keys: shapeOf(reply),
      reads: store.stats.reads - readsBefore,
      writes: store.stats.writes.length - writesBefore
    })
  }
  /* P7c：**40 字 ⇒ 放行**（上界内的最长关键词）：成功回包恰 5 键；关键词无命中 ⇒ total 0。 */
  {
    const writesBefore = store.stats.writes.length
    const reply = await publicCall('listSealCards', { limit: 10, q: 'x'.repeat(40) })
    check('P7c', '`q` **trim 后恰 40 字** ⇒ 放行（成功回包恰 5 键、无命中 ⇒ `total` 0）＋ **零写**', {
      ok: true,
      keys: 'has_more,next_cursor,ok,rows,total',
      total: 0,
      rowCount: 0,
      writes: 0
    }, {
      ok: reply.ok,
      keys: shapeOf(reply),
      total: reply.total,
      rowCount: Array.isArray(reply.rows) ? reply.rows.length : -1,
      writes: store.stats.writes.length - writesBefore
    })
  }
  /* P7d：**空白串 ＝ 不检索** ⇒ 与不带 `q` 的回包**逐字节相同**。 */
  {
    const writesBefore = store.stats.writes.length
    const plain = await publicCall('listSealCards', { limit: 10 })
    const blank = await publicCall('listSealCards', { limit: 10, q: '   ' })
    check('P7d', '`q` **空白串** ⇒ **等同不检索**（回包与不带 `q` 逐字节相同）＋ **零写**', {
      identicalToNoQuery: true,
      ok: true,
      total: 1,
      rowCount: 1,
      writes: 0
    }, {
      identicalToNoQuery: JSON.stringify(plain) === JSON.stringify(blank),
      ok: blank.ok,
      total: blank.total,
      rowCount: Array.isArray(blank.rows) ? blank.rows.length : -1,
      writes: store.stats.writes.length - writesBefore
    })
  }
}

/* ===========================================================================
   P8：关键词正则转义（`*` `（` `.` 三形态）—— 假 DB 3 行造数据（首行含三字面量、其余两行不含）
   =========================================================================== */
const P8_HIT = 'SLQ000000001'
const p8Store = createStore([
  {
    __collection: 'xiai_seals',
    _id: P8_HIT,
    stamp_id: P8_HIT,
    seal_name: '元 *（a.b）印',
    dynasty: '汉',
    category: '吉语印',
    face_count: 1,
    seal_wen: '長樂未央',
    seal_wen_chs: '长乐未央*'
  },
  { __collection: 'xiai_seals', _id: 'SLQ000000002', stamp_id: 'SLQ000000002', seal_name: '乙印', dynasty: '汉', category: '吉语印', face_count: 1 },
  { __collection: 'xiai_seals', _id: 'SLQ000000003', stamp_id: 'SLQ000000003', seal_name: '丙印', dynasty: '汉', category: '吉语印', face_count: 1 },
  {
    __collection: 'xiai_faces',
    _id: 'fc-q1',
    id: 'fc-q1',
    sealId: P8_HIT,
    kind: 'FACE',
    face_no: 1,
    is_primary: true,
    face_image_id: 'img-q1',
    image_sha256: FACE_SHA,
    image_mime: 'image/png'
  },
  {
    __collection: 'xiai_faces',
    _id: 'fc-q2',
    id: 'fc-q2',
    sealId: 'SLQ000000002',
    kind: 'FACE',
    face_no: 1,
    is_primary: true,
    face_image_id: 'img-q2',
    image_sha256: FACE_SHA,
    image_mime: 'image/png'
  },
  {
    __collection: 'xiai_faces',
    _id: 'fc-q3',
    id: 'fc-q3',
    sealId: 'SLQ000000003',
    kind: 'FACE',
    face_no: 1,
    is_primary: true,
    face_image_id: 'img-q3',
    image_sha256: FACE_SHA,
    image_mime: 'image/png'
  }
])
section('P8', '关键词转义：q = `*` / `（` / `a.b` 不抛错、不当通配符、只命中含字面量的那 1 行')
await withInjectedStore(p8Store, async () => {
  const escapes = [
    ['P8a', "`q='*'` ⇒ **不抛错**（`nothing to repeat`）**不当通配符** ⇒ 只命中含字面量 `*` 的第 1 行", '*'],
    ['P8b', "`q='（'` ⇒ **不抛错**、**不当元字符** ⇒ 只命中含字面量 `（` 的第 1 行", '（'],
    ['P8c', "`q='a.b'` ⇒ `.` **转义为字面量** ⇒ 只命中 `a.b` 那 1 行（`乙印`/`丙印` 不因通配误中）", 'a.b']
  ]
  for (const [id, desc, keyword] of escapes) {
    const writesBefore = p8Store.stats.writes.length
    const reply = await publicCall('listSealCards', { limit: 10, q: keyword })
    const rows = Array.isArray(reply.rows) ? reply.rows : []
    check(id, desc, {
      ok: true,
      keys: 'has_more,next_cursor,ok,rows,total',
      total: 1,
      stampIds: [P8_HIT],
      has_more: false,
      writes: 0
    }, {
      ok: reply.ok,
      keys: shapeOf(reply),
      total: reply.total,
      stampIds: rows.map((row) => row.stamp_id),
      has_more: reply.has_more,
      writes: p8Store.stats.writes.length - writesBefore
    })
  }
})

/* ===========================================================================
   P9：`total` ＝ **命中总数**（不是已载入数）—— 60 行命中 ＋ `limit=48`
   =========================================================================== */
const P9_COUNT = 60
const P9_LIMIT = 48
const p9Rows = []
for (let i = 1; i <= P9_COUNT; i += 1) {
  const stamp = `SLB${String(i).padStart(7, '0')}` /* 字典序 == 数值序 */
  p9Rows.push({
    __collection: 'xiai_seals',
    _id: stamp,
    stamp_id: stamp,
    seal_name: `满页印${i}`,
    dynasty: '汉',
    category: '吉语印',
    face_count: 1 /* 60 行各 1 面（`face_count >= 1` 才进命中集）。 */,
    seal_wen_chs: '长乐未央' /* 60 行**全部命中**关键词 `长乐`。 */
  })
  p9Rows.push({
    __collection: 'xiai_faces',
    _id: `fc-b${i}`,
    id: `fc-b${i}`,
    sealId: stamp,
    kind: 'FACE',
    face_no: 1,
    is_primary: true,
    face_image_id: `img-b${i}`,
    image_sha256: FACE_SHA,
    image_mime: 'image/png'
  })
}
const p9Store = createStore(p9Rows)
section('P9', 'total ＝ 命中总数（非已载入数）：60 行命中 + limit=48 ⇒ total 60 / rows 48 / has_more true')
await withInjectedStore(p9Store, async () => {
  const writesBefore = p9Store.stats.writes.length
  const reply = await publicCall('listSealCards', { limit: P9_LIMIT, q: '长乐' })
  const rows = Array.isArray(reply.rows) ? reply.rows : []
  check('P9', '`q` 有关键词时 `total` ＝ **命中总数 60**（**不是**已载入的 48）、`rows` 恰 48、`has_more` 为真、`next_cursor` 指向本页末枚 ＋ **零写**', {
    ok: true,
    keys: 'has_more,next_cursor,ok,rows,total',
    total: 60,
    rowCount: 48,
    has_more: true,
    nextCursorIsLastLoaded: true,
    writes: 0
  }, {
    ok: reply.ok,
    keys: shapeOf(reply),
    total: reply.total,
    rowCount: rows.length,
    has_more: reply.has_more,
    nextCursorIsLastLoaded: rows.length > 0 && reply.next_cursor === rows[rows.length - 1].stamp_id,
    writes: p9Store.stats.writes.length - writesBefore
  })
})

/* ===========================================================================
   收尾
   =========================================================================== */
const passed = results.filter((r) => r.pass).length
console.log(JSON.stringify({ summary: { total: results.length, passed, failures } }))
if (failures > 0) {
  console.error(`FAILED: ${failures} / ${results.length}`)
  process.exit(1)
}
