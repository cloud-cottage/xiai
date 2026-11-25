#!/usr/bin/env node
/**
 * 玺爱 · **公开只读面自检**（`PUBLIC_OPS` ＝ `listSealCards` ＋ `suggestAuthors`）
 * ============================================================================ *
 * **本地、离线、零网络、零云端、零生产数据**：注入式内存假 DB，跑的是
 * `cloudfunctions/xiai-user-token/index.js` 的**真实入口**（`main`）与
 * `lib/sealCards.js` / `lib/authorMatch.js` 的**真实函数体**。
 *
 * 断言面（十组；每条可机械判负）：
 *   P0. **七张冻结常量逐字**（唯一真源，直接引用被测件导出、不重抄）：
 *       `LIST_SEAL_CARDS_ALLOWED_KEYS`(7：`limit,cursor,dynasty,seal_type,face_style,category,q`) /
 *       `LIST_SEAL_CARDS_SUCCESS_KEYS`(5：
 *       ok,rows,next_cursor,has_more,total) / `CARD_ROW_KEYS`(16) /
 *       `SUGGEST_AUTHORS_ALLOWED_KEYS`(3：face_id,name,limit) /
 *       `SUGGEST_AUTHORS_SUCCESS_KEYS`(4：ok,query,normalized,candidates) /
 *       `AUTHOR_CANDIDATE_KEYS`(7) / `MATCHED_FIELDS`(5：name,alias,courtesy,art,contains)。
 *   P1. `PUBLIC_OPS` **恰 7 成员**（`listSealCards` / `suggestAuthors` / `listPersonCards` /
 *       `getPersonCard` / `catalogStats` / `listSealCovers` / `listSealImages`（v1.130 新增：
 *       搜索结果页影像瀑布流，恒零写），皆函数）；表外 op（含一切管理员 op）走 `action:'public'` ⇒ `FORBIDDEN` ＋ 零读。
 *   P2. **两 op 载荷封闭**：未知键 / **身份类键**（`user_id` / `phone`）⇒ `INVALID_FIELD`
 *       ＋ 恰 3 键拒绝 ＋ 零读（判定早于任何读）。
 *   P3. `listSealCards` 回包**恰 5 键**、`rows` 每元素**恰 16 键**。
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
 *       `rows.length===48`、`has_more===true`（`rows` 按命中集分页，与 `total` 同尺）；
 *       `next_cursor` **形态为 `off:<n>` 偏移量**（v1.110 起语义变更：＝ `off:` ＋（`offset` ＋
 *       `rows.length`）＝ 本页**已发卡片数**的累进位次，**不再是**「本页末枚 `stamp_id`」）。
 *   P10. **影像读面 `listSealImages`**（v1.130 新增：搜索结果页影像瀑布流，恒零写）：
 *       载荷门（未知键 ⇒ `INVALID_FIELD`；`q` trim 后 41 字 / `limit` 97 ⇒ `INVALID_VALUE`，
 *       三发皆**零读零写**）；成功回包**恰 5 键**且**键序固定**（`ok,rows,next_cursor,has_more,total`）；
 *       `rows` 每元素**恰 13 键**且**键序固定**；`hidden` 影像与非 `server`（bundled 占位行）
 *       **整条不出**；游标**三页走完不重不漏**且每页 ≤ `limit`；DB 不可用 ⇒ 回**恰 5 键降级包**
 *       且**不抛异常**；**P10k 主路复筛回归**（`createStore(p10Seed, {commandGte:true})` 的带
 *       `command` 假 DB ⇒ `sealMatch.face_count` 为命令对象、走主路）：同一命令对象 DB 侧判得过
 *       （4 枚）而内存判定器判不过（`[]`，＝修复前恒 0 行的机制）⇒ 修复后整页 `rows` 恰 9、
 *       游标续拉 `rows` 恰 3；本节全程**零写入**。
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
   与 `command.gt` / `command.in` / `command.gte`（仅 `options.commandGte`）哨兵 —— 即 `db.command`
   在场时 `readOrderedWindow` 下发给 DB 的 `where` 片段，假体**逐条同判**（关键词 `q` 的行级命中
   因此在本套件里可观测；无 `command` 时被测件走退路 `readOrderedWindowFallback`，只按 idIn /
   游标收口、**不判 match**）。被测件内存判定器（`rowMatchesQuery`）**只认 wire 形态** ⇒
   命令对象喂它恒 0 命中 —— 这正是「主路复筛把整窗滤空」的机制，P10k 用它做负对照。
   --------------------------------------------------------------------------- */
function createStore(seedRows, options) {
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
     只要假体自己的匹配器认得（与 `db.RegExp` 同法：句柄没有 ⇒ 落 wire 字面值）。
     `gte`（印章侧 `face_count >= 1`）**只在 `options.commandGte` 时给**：缺省仍无 ⇒
     `faceCountMatchOf` 落 wire 字面值 `{ $gte: 1 }`（**既有 wire 形态断言一字不动**）；
     P10k 的「带 command 假 DB」才要它。哨兵刻意**不用** `$gte` —— 内存判定器认得 `$gte`
     ⇒ 主路复筛恒过、回归测不出「命令对象被复筛滤空」。 */
  const command = {
    gt: (value) => ({ __op: 'gt', value }),
    in: (values) => ({ __op: 'in', values: Array.isArray(values) ? values.slice() : [] }),
    ...(options && options.commandGte === true ? { gte: (value) => ({ __op: 'gte', value }) } : {})
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
        if (expected.__op === 'gte') {
          /* 数值下界（`options.commandGte` 假 DB 的 `db.command.gte(1)` 命令对象形态；
             口径与 `expected.$gte` 分支逐字一致：缺字段 / 非数值 ⇒ 恒假）。 */
          const num = Number(row[key])
          return Number.isFinite(num) && num >= Number(expected.value)
        }
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
            async count() {
              /* 真 SDK 形态：`where(match).count() ⇒ {total}`（`catalogStats` 三计数走这条） */
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
/* 卡片行冻结表（**16 键、字典序**；本单 14 → 16 追加 `author_card_id` / `author_person_id`，
   a 开头按字典序排在 `category` 前）。P0 与下方 P0n 负对照共用同一字面，避免两处各抄一份。 */
const P0_CARD_ROW = [
  'author_card_id',
  'author_person_id',
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
]
check('P0', '七张冻结常量逐字 ＝ 契约值（7 / 5 / 16 / 3 / 4 / 7 / 5）', {
  listAllowed: ['category', 'cursor', 'dynasty', 'face_style', 'limit', 'q', 'seal_type'],
  listSuccess: ['has_more', 'next_cursor', 'ok', 'rows', 'total'],
  cardRow: P0_CARD_ROW,
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
  sizes: [7, 5, 16, 3, 4, 7, 5]
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
/* **P0n 负对照（本单 14 → 16 的键面类正/负对照）**：把两键从冻结表删掉成 14 键行喂**同一条**
   `JSON.stringify` 判据 ⇒ 必须判红；16 键全表 ⇒ 判绿。判据本体一字未改（只换喂进去的样本）。 */
{
  const cardRowActual = sorted(sealCards.CARD_ROW_KEYS)
  const cardRowMutant14 = P0_CARD_ROW.filter((key) => key !== 'author_card_id' && key !== 'author_person_id')
  check('P0n', '负对照：卡片行 14 键（删两键）喂 P0 同一判据 ⇒ **判红**；16 键全表 ⇒ **判绿**', {
    mutantRed: true,
    realGreen: true,
    mutantCount: 14,
    realCount: 16
  }, {
    mutantRed: JSON.stringify(cardRowMutant14) !== JSON.stringify(cardRowActual),
    realGreen: JSON.stringify(P0_CARD_ROW) === JSON.stringify(cardRowActual),
    mutantCount: cardRowMutant14.length,
    realCount: cardRowActual.length
  })
}

/* ===========================================================================
   P1：`PUBLIC_OPS` 恰 7 成员 ＋ 表外 op 走 public ⇒ FORBIDDEN ＋ 零写
   =========================================================================== */
section('P1', 'PUBLIC_OPS 恰 7（listSealCards / suggestAuthors / listPersonCards / getPersonCard / catalogStats / listSealCovers / listSealImages〔v1.130〕）；表外 op ⇒ FORBIDDEN')
{
  const keys = Object.keys(sealCards.PUBLIC_OPS)
  const readsBefore = store.stats.reads
  const denied = await publicCall('repairPrimaryFace', {})
  check('P1', '`PUBLIC_OPS` **恰 7 成员**（`listSealCards` / `suggestAuthors` / `listPersonCards` / `getPersonCard` / `catalogStats` / `listSealCovers` / `listSealImages`（v1.130 新增：搜索结果页影像瀑布流，恒零写），皆函数）', {
    count: 7,
    keys: ['catalogStats', 'getPersonCard', 'listPersonCards', 'listSealCards', 'listSealCovers', 'listSealImages', 'suggestAuthors'],
    types: ['function', 'function', 'function', 'function', 'function', 'function', 'function']
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

  /* P1c：新 op `catalogStats` 的**回包键面**与**计数口径**（匿名可调、恒零写）。
     seed 行数：`xiai_seals` 2 ／ `xiai_faces` 2 ／ `xiai_images` 0（本套件未种影像）——
     计数＝**集合总行数**（零面章也算，与列表页「共 N 枚」不同尺）。 */
  const writesBefore = store.stats.writes.length
  const statsReply = await publicCall('catalogStats', {})
  check('P1c', '`catalogStats` 匿名可调：回包**恰 4 鍵** `{ok,seals,faces,images}` ＋ 计数＝集合行数（2 / 2 / 0，含零面章）＋ **零写**', {
    ok: true,
    keys: 'faces,images,ok,seals',
    seals: 2,
    faces: 2,
    images: 0,
    writes: 0
  }, {
    ok: statsReply.ok,
    reason: statsReply.reason,
    keys: shapeOf(statsReply),
    seals: statsReply.seals,
    faces: statsReply.faces,
    images: statsReply.images,
    writes: store.stats.writes.length - writesBefore
  })

  /* P1d：载荷封闭 —— 任何参数（含空数组以外的形态）一律 `INVALID_VALUE` ＋ 零读。 */
  const readsBeforePayload = store.stats.reads
  const statsDenied = await publicCall('catalogStats', { limit: 1 })
  check('P1d', '`catalogStats` 載荷**封閉**：帶任何參數（`{limit:1}`）⇒ `INVALID_VALUE` ＋ **零讀**', {
    ok: false,
    reason: 'INVALID_VALUE',
    keys: 'message,ok,reason',
    reads: 0
  }, {
    ok: statsDenied.ok,
    reason: statsDenied.reason,
    keys: shapeOf(statsDenied),
    reads: store.stats.reads - readsBeforePayload
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
   P3：`listSealCards` 回包恰 5 键 ＋ `rows` 每元素恰 16 键
   =========================================================================== */
section('P3', 'listSealCards：回包恰 5 键 / rows 每元素恰 16 键 / total 与 rows 同尺')
{
  const reply = await publicCall('listSealCards', { limit: 10 })
  const rows = Array.isArray(reply.rows) ? reply.rows : []
  check('P3', '`listSealCards` 成功回包**恰 5 键**、`rows` 每元素**恰 16 键**（＝ `CARD_ROW_KEYS`）', {
    keys: 'has_more,next_cursor,ok,rows,total',
    ok: true,
    rowCount: 1,
    rowShapes: ['author_card_id,author_person_id,category,display_key,dynasty,edge_count,face_count,height,image_id,image_mime,image_sha256,primary_face_id,seal_name,stamp_id,thumb_key,width'],
    thumbIsContentAddressed: true
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    rowCount: rows.length,
    rowShapes: rows.map((row) => shapeOf(row)),
    thumbIsContentAddressed: rows.every((row) => row.thumb_key === `xiai/images/${FACE_SHA.slice(0, 2)}/${FACE_SHA}.png`)
  })
  /* **P3n 负对照（键面类）**：把两键从形状串里删掉成 14 键行喂**同一条**判据 ⇒ 必须判红；
     16 键形状串 ⇒ 判绿。判据本体一字未改（只换喂进去的样本）。 */
  const shape16 = 'author_card_id,author_person_id,category,display_key,dynasty,edge_count,face_count,height,image_id,image_mime,image_sha256,primary_face_id,seal_name,stamp_id,thumb_key,width'
  const shape14 = shape16.replace('author_card_id,author_person_id,', '')
  const actualShapes = rows.map((row) => shapeOf(row))
  check('P3n', '负对照：14 键行形状串喂 P3 同一判据 ⇒ **判红**；16 键形状串 ⇒ **判绿**', {
    mutantRed: true,
    realGreen: true,
    mutantShapeHas14: true
  }, {
    mutantRed: actualShapes.length === 1 && actualShapes[0] !== shape14,
    realGreen: actualShapes.length === 1 && actualShapes[0] === shape16,
    mutantShapeHas14: shape14.split(',').length === 14
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
  check('P9', '`q` 有关键词时 `total` ＝ **命中总数 60**（**不是**已载入的 48）、`rows` 恰 48、`has_more` 为真、`next_cursor` ＝ `off:(offset + rows.length)` ＝ `off:48`（**v1.110 偏移量语义**，不再是末枚 `stamp_id`）＋ **零写**', {
    ok: true,
    keys: 'has_more,next_cursor,ok,rows,total',
    total: 60,
    rowCount: 48,
    has_more: true,
    nextCursor: 'off:' + (0 + 48),
    writes: 0
  }, {
    ok: reply.ok,
    keys: shapeOf(reply),
    total: reply.total,
    rowCount: rows.length,
    has_more: reply.has_more,
    nextCursor: reply.next_cursor,
    writes: p9Store.stats.writes.length - writesBefore
  })
})

/* ===========================================================================
   P10：影像读面 `listSealImages`（v1.130 新增：搜索结果页影像瀑布流；`PUBLIC_OPS` 第 7 成员）
   ---------------------------------------------------------------------------
   全离线：本节自带注入式假 DB（`p10Store`）—— 4 枚命中印章（各 1 枚 FACE 主面）
   ＋ 11 行影像（9 行可见 `server` ＋ 1 行 `visibility:"hidden"` ＋ 1 行 `storage:"bundled"`）。
   十条判据一律**严格等值**（键数 / 键序 / id 全集 / 游标原文 / 计数逐字；不写「至少 / 非空」）。
   =========================================================================== */
const p10Sha = (sealNo, imageNo) => `${sealNo}${imageNo}`.repeat(32)
const p10CoverKey = (sha) => `xiai/images/${sha.slice(0, 2)}/${sha}.png`
const P10_SEALS = ['SI000000001', 'SI000000002', 'SI000000003', 'SI000000004']
const P10_HIDDEN_ID = 'img-si4-1'
const P10_BUNDLED_ID = 'img-si4-2'
const P10_VISIBLE_IDS = []
const p10Seed = []
P10_SEALS.forEach((stamp, index) => {
  const sealNo = index + 1
  p10Seed.push({
    __collection: 'xiai_seals',
    _id: stamp,
    stamp_id: stamp,
    seal_name: `影瀑印${sealNo}`,
    dynasty: '汉',
    category: '吉语印',
    face_count: 1
  })
  p10Seed.push({
    __collection: 'xiai_faces',
    _id: `fc-si${sealNo}`,
    id: `fc-si${sealNo}`,
    sealId: stamp,
    kind: 'FACE',
    face_no: 1,
    is_primary: true,
    face_image_id: `img-si${sealNo}-1`,
    image_sha256: p10Sha(sealNo, 1),
    image_mime: 'image/png'
  })
  if (sealNo <= 3) {
    for (let k = 1; k <= 3; k += 1) {
      const imageId = `img-si${sealNo}-${k}`
      P10_VISIBLE_IDS.push(imageId)
      p10Seed.push({
        __collection: 'xiai_images',
        _id: imageId,
        id: imageId,
        stamp_id: stamp,
        storage: 'server',
        visibility: 'visible',
        sha256: p10Sha(sealNo, k),
        mime: 'image/png',
        width: 640,
        height: 480
      })
    }
  }
})
/* 第 4 章两行：一行 `hidden`（读面闸门）、一行 `bundled` 占位（桶里没有对象）——
   两行都必须**整条不出**，但印章本身仍计 `total`（命中印章数与影像可见性无关）。 */
p10Seed.push({
  __collection: 'xiai_images',
  _id: P10_HIDDEN_ID,
  id: P10_HIDDEN_ID,
  stamp_id: 'SI000000004',
  storage: 'server',
  visibility: 'hidden',
  sha256: p10Sha(4, 1),
  mime: 'image/png',
  width: 640,
  height: 480
})
p10Seed.push({
  __collection: 'xiai_images',
  _id: P10_BUNDLED_ID,
  id: P10_BUNDLED_ID,
  stamp_id: 'SI000000004',
  storage: 'bundled',
  visibility: 'visible',
  sha256: p10Sha(4, 2),
  mime: 'image/png',
  width: 640,
  height: 480
})
const p10Store = createStore(p10Seed)
section('P10', '影像读面 listSealImages（v1.130）：载荷门零读 / 回包恰 5 键且键序固定 / 行恰 13 键且键序固定 / hidden 与 bundled 整条不出 / 三页不重不漏 / DB 不可用降级 / 主路复筛回归（带 command 假 DB）/ 全程零写')
await withInjectedStore(p10Store, async () => {
  const P10_REPLY_KEYS = 'has_more,next_cursor,ok,rows,total'
  const P10_REPLY_ORDER = 'ok,rows,next_cursor,has_more,total'
  const P10_ROW_ORDER = 'image_id,stamp_id,seal_name,dynasty,category,face_id,face_kind,width,height,image_sha256,image_mime,thumb_key,display_key'

  /* P10a / P10b / P10c：载荷门三发（判定早于任何读 ⇒ 每发皆零读零写）。 */
  const p10Gates = [
    ['P10a', '载荷含**未知键** `bogus`', { limit: 10, bogus: 1 }, 'INVALID_FIELD'],
    ['P10b', '`q` **trim 后 41 字**（越 40 字上界，不静默截断）', { limit: 10, q: 'x'.repeat(41) }, 'INVALID_VALUE'],
    ['P10c', '`limit: 97`（上界 96 之外，不静默夹取）', { limit: 97 }, 'INVALID_VALUE']
  ]
  for (const [id, label, payload, reason] of p10Gates) {
    const readsBefore = p10Store.stats.reads
    const writesBefore = p10Store.stats.writes.length
    const reply = await publicCall('listSealImages', payload)
    check(id, `\`listSealImages\` ${label} ⇒ \`${reason}\` ＋ 恰 3 键 ＋ **零读** ＋ **零写**`, {
      ok: false,
      reason,
      keys: 'message,ok,reason',
      reads: 0,
      writes: 0
    }, {
      ok: reply.ok,
      reason: reply.reason,
      keys: shapeOf(reply),
      reads: p10Store.stats.reads - readsBefore,
      writes: p10Store.stats.writes.length - writesBefore
    })
  }

  /* P10d：成功回包 ＝ 恰 5 键且**键序固定**；`total` ＝ 命中印章数（4，含只藏不可见影像的第 4 章）。 */
  const full = await publicCall('listSealImages', { limit: 96 })
  const fullRows = Array.isArray(full.rows) ? full.rows : []
  check('P10d', '成功回包**恰 5 键**且**键序固定**（`ok,rows,next_cursor,has_more,total`，与冻结常量 `LIST_SEAL_IMAGES_SUCCESS_KEYS` 同序）＋ `total` ＝ **命中印章数 4**（面维度筛选不参与、影像可见性不参与）＋ `rows` 恰 9 枚 ＋ 已到底（`has_more:false` / `next_cursor:\"\"`）＋ 零写', {
    keys: P10_REPLY_KEYS,
    keyOrder: P10_REPLY_ORDER,
    frozenOrder: P10_REPLY_ORDER,
    ok: true,
    total: 4,
    rowCount: 9,
    hasMore: false,
    nextCursor: '',
    writes: 0
  }, {
    keys: shapeOf(full),
    keyOrder: Object.keys(full).join(','),
    frozenOrder: sealCards.LIST_SEAL_IMAGES_SUCCESS_KEYS.join(','),
    ok: full.ok,
    total: full.total,
    rowCount: fullRows.length,
    hasMore: full.has_more,
    nextCursor: full.next_cursor,
    writes: p10Store.stats.writes.length
  })

  /* P10e：`rows` 每元素 ＝ 恰 13 键且**键序固定**（＝ `LIST_SEAL_IMAGES_ROW_KEYS` 冻结序）。 */
  const p10RowOrders = [...new Set(fullRows.map((row) => Object.keys(row).join(',')))]
  const p10First = fullRows[0] || {}
  check('P10e', '`rows` 每元素**恰 13 键**且**键序固定**（＝ 冻结常量 `LIST_SEAL_IMAGES_ROW_KEYS` 同序；两种键序 / 多一种键序即判红）＋ 首行派生逐字（面引用 / 尺寸 / 摘要 / 内容寻址 cover 键）＋ 零写', {
    rowKeyCounts: [13],
    rowOrders: [P10_ROW_ORDER],
    frozenOrder: P10_ROW_ORDER,
    first: {
      image_id: 'img-si1-1',
      stamp_id: 'SI000000001',
      seal_name: '影瀑印1',
      dynasty: '汉',
      category: '吉语印',
      face_id: 'fc-si1',
      face_kind: 'FACE',
      width: 640,
      height: 480,
      image_sha256: p10Sha(1, 1),
      image_mime: 'image/png',
      thumb_key: p10CoverKey(p10Sha(1, 1)),
      display_key: p10CoverKey(p10Sha(1, 1))
    },
    writes: 0
  }, {
    rowKeyCounts: [...new Set(fullRows.map((row) => Object.keys(row).length))],
    rowOrders: p10RowOrders,
    frozenOrder: sealCards.LIST_SEAL_IMAGES_ROW_KEYS.join(','),
    first: {
      image_id: p10First.image_id,
      stamp_id: p10First.stamp_id,
      seal_name: p10First.seal_name,
      dynasty: p10First.dynasty,
      category: p10First.category,
      face_id: p10First.face_id,
      face_kind: p10First.face_kind,
      width: p10First.width,
      height: p10First.height,
      image_sha256: p10First.image_sha256,
      image_mime: p10First.image_mime,
      thumb_key: p10First.thumb_key,
      display_key: p10First.display_key
    },
    writes: p10Store.stats.writes.length
  })

  /* P10f / P10g：两条过滤线各一行（**种子里确有该行** ＋ 回包里确无该行 —— 一正一负防假绿）。 */
  const p10FullIds = fullRows.map((row) => row.image_id)
  const p10SeededHidden = p10Store
    .rows('xiai_images')
    .filter((row) => row.visibility === 'hidden')
    .map((row) => row.id)
  check('P10f', '`visibility:\"hidden\"` 影像**整条不出**（不置空、不降级）：种子里确有该行（防假绿）＋ 9 枚回包行里确无该行 ＋ 该章仍计 `total`（4）', {
    seededHidden: [P10_HIDDEN_ID],
    inRows: false,
    total: 4
  }, {
    seededHidden: p10SeededHidden,
    inRows: p10FullIds.indexOf(P10_HIDDEN_ID) !== -1,
    total: full.total
  })
  const p10SeededBundled = p10Store
    .rows('xiai_images')
    .filter((row) => String(row.storage).trim().toLowerCase() !== 'server')
    .map((row) => row.id)
  check('P10g', '非 `server`（`storage:\"bundled\"` 占位行）**整条不出**（桶里没有该对象 ⇒ 不冒充可展示影像）；`rows` 全集**逐字等于** 9 枚可见影像 id（顺序亦同）', {
    seededBundled: [P10_BUNDLED_ID],
    inRows: false,
    visibleIds: P10_VISIBLE_IDS
  }, {
    seededBundled: p10SeededBundled,
    inRows: p10FullIds.indexOf(P10_BUNDLED_ID) !== -1,
    visibleIds: p10FullIds
  })

  /* P10h：游标三页走完（`limit:3`）—— 不重不漏、每页 ≤ limit、游标原文逐字。 */
  const p10CursorOf = (sealId, imageId) =>
    Buffer.from(JSON.stringify({ seal_id: sealId, image_id: imageId }), 'utf8').toString('base64')
  const p10Pages = []
  let p10Cursor = ''
  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const reply = await publicCall('listSealImages', { limit: 3, cursor: p10Cursor })
    p10Pages.push({ reply, rows: Array.isArray(reply.rows) ? reply.rows : [] })
    p10Cursor = reply.next_cursor
  }
  const p10IdsOf = (page) => page.rows.map((row) => row.image_id)
  const p10AllIds = p10Pages.flatMap(p10IdsOf)
  const p10UniqueIds = [...new Set(p10AllIds)]
  const p10Intersects = []
  for (let i = 0; i < p10Pages.length; i += 1) {
    for (let j = i + 1; j < p10Pages.length; j += 1) {
      const left = new Set(p10IdsOf(p10Pages[i]))
      p10IdsOf(p10Pages[j]).forEach((id) => {
        if (left.has(id)) p10Intersects.push(id)
      })
    }
  }
  check('P10h', '游标三页（`limit:3`）走完 **不重不漏**（三页 id 并集逐字 ＝ 9 枚可见影像、两两交集空）＋ **每页 ≤ limit**（三页各恰 3）＋ `has_more` 依次 `true/true/false` ＋ 末页 `next_cursor:\"\"` ＋ 游标原文 ＝ `base64(JSON{seal_id,image_id})` 逐字 ＋ `total` 三页恒 4 ＋ 零写', {
    pageSizes: [3, 3, 3],
    withinLimit: true,
    unionCount: 9,
    union: P10_VISIBLE_IDS,
    intersects: [],
    hasMore: [true, true, false],
    cursors: [p10CursorOf('SI000000001', 'img-si1-3'), p10CursorOf('SI000000002', 'img-si2-3'), ''],
    totals: [4, 4, 4],
    writes: 0
  }, {
    pageSizes: p10Pages.map((page) => page.rows.length),
    withinLimit: p10Pages.every((page) => page.rows.length <= 3),
    unionCount: p10UniqueIds.length,
    union: p10UniqueIds,
    intersects: p10Intersects,
    hasMore: p10Pages.map((page) => page.reply.has_more),
    cursors: p10Pages.map((page) => page.reply.next_cursor),
    totals: p10Pages.map((page) => page.reply.total),
    writes: p10Store.stats.writes.length
  })

  /* P10i：DB 不可用（provider 当场抛错）⇒ 恰 5 键降级包、不抛异常、不加 `message` 键。 */
  let p10Degraded = null
  let p10Threw = false
  ops.setOpsDbProvider(() => {
    throw new Error('DB unavailable：离线降级探针')
  })
  try {
    p10Degraded = await publicCall('listSealImages', { limit: 5 })
  } catch (error) {
    p10Threw = true
  } finally {
    ops.setOpsDbProvider(p10Store.provider)
  }
  check('P10i', 'DB 不可用（provider 当场抛错）⇒ 回**恰 5 键降级包** `{ok:false,rows:[],next_cursor:\"\",has_more:false,total:0}` ＋ **键序固定** ＋ **不抛异常** ＋ 不加 `message` 键 ＋ 零写', {
    keys: P10_REPLY_KEYS,
    keyOrder: P10_REPLY_ORDER,
    ok: false,
    rowCount: 0,
    nextCursor: '',
    hasMore: false,
    total: 0,
    threw: false,
    writes: 0
  }, {
    keys: p10Degraded ? shapeOf(p10Degraded) : null,
    keyOrder: p10Degraded ? Object.keys(p10Degraded).join(',') : null,
    ok: p10Degraded && p10Degraded.ok,
    rowCount: p10Degraded && Array.isArray(p10Degraded.rows) ? p10Degraded.rows.length : -1,
    nextCursor: p10Degraded ? p10Degraded.next_cursor : null,
    hasMore: p10Degraded ? p10Degraded.has_more : null,
    total: p10Degraded ? p10Degraded.total : null,
    threw: p10Threw,
    writes: p10Store.stats.writes.length
  })

  /* P10j：本节全程零写入（P10a〜P10i 八发调用合共一字不写）。 */
  check('P10j', '本节 P10a〜P10i **八发调用全程零写入**（假 DB 写账恒 0；`listSealImages` 恒零写）', 0, p10Store.stats.writes.length)

  /* P10k：**主路复筛回归**（带 `command` 的假 DB —— `db.command.gte` 在场 ⇒ `listSealImages`
     走**主路**，`sealMatch.face_count` 是 `db.command.gte(1)` 的**命令对象**、不再是 wire 字面值）。
     线上真因复刻：主路读回印章窗后若再用 `rowMatchesQuery` 复筛，命令对象不在判定器的 wire
     认知内 ⇒ 整窗被滤空（`rows` 恒 0，而 `total` / `has_more` 正常）。三段读数：
       · 正对照 `dbSideHits`：同一命令对象喂**假 DB 匹配器**（＝ DB 侧 `where`）⇒ 恰 4 枚命中；
       · 负对照 `memoryHits`：同一命令对象喂被测件内存判定器（`sealCards.matchRows`）⇒ **`[]`**
         ⇒ **修复前**该形态主路逐行复筛恒 0 行（这就是回归判据成立的原因）；
       · 修复后：整页 `rows` 恰 9 ＋ 游标续拉（站点①续读 ＋ 站点②窗口复筛两处）`rows` 恰 3、
         两页 `total` 恒 4、回包与行键序不变、零写。
     既有 wire 形态（`createStore` 缺省无 `gte` ⇒ `{ $gte: 1 }`）断言 P10a〜P10j 一字未动。 */
  const p10kStore = createStore(p10Seed, { commandGte: true })
  const p10kDb = p10kStore.provider()
  const p10kGte = typeof p10kDb.command.gte === 'function' ? p10kDb.command.gte(1) : null
  const p10kDbSide = await p10kDb.collection('xiai_seals').where({ face_count: p10kGte }).get()
  const p10kMemoryHits = sealCards.matchRows(p10kStore.rows('xiai_seals'), { face_count: p10kGte })
  const p10kCursor = Buffer.from(JSON.stringify({ seal_id: 'SI000000001', image_id: 'img-si1-3' }), 'utf8').toString('base64')
  let p10kFull = null
  let p10kResume = null
  ops.setOpsDbProvider(p10kStore.provider)
  try {
    p10kFull = await publicCall('listSealImages', { limit: 96 })
    p10kResume = await publicCall('listSealImages', { limit: 3, cursor: p10kCursor })
  } finally {
    ops.setOpsDbProvider(p10Store.provider)
  }
  const p10kFullRows = p10kFull && Array.isArray(p10kFull.rows) ? p10kFull.rows : []
  const p10kResumeRows = p10kResume && Array.isArray(p10kResume.rows) ? p10kResume.rows : []
  check('P10k', '**主路复筛回归**（`createStore(p10Seed, {commandGte:true})` ⇒ `db.command.gte` 在场、`sealMatch.face_count` 为命令对象、`listSealImages` 走主路）：同一命令对象 DB 侧判得过（4 枚）＋ 内存判定器判不过（`[]`，＝**修复前恒 0 行**的机制）⇒ 修复后整页 `rows` 恰 9、游标续拉 `rows` 恰 3（续读点与窗口复筛两处）＋ 两页 `total` 恒 4 ＋ 键序不变 ＋ 零写', {
    gteIsFunction: true,
    dbSideHits: 4,
    memoryHits: [],
    fullKeys: 'has_more,next_cursor,ok,rows,total',
    fullOrder: 'ok,rows,next_cursor,has_more,total',
    fullRowOrders: [P10_ROW_ORDER],
    fullRowCount: 9,
    fullTotal: 4,
    fullHasMore: false,
    fullNextCursor: '',
    resumeRowCount: 3,
    resumeIds: ['img-si2-1', 'img-si2-2', 'img-si2-3'],
    resumeTotal: 4,
    resumeHasMore: true,
    resumeNextCursor: p10CursorOf('SI000000002', 'img-si2-3'),
    writes: 0
  }, {
    gteIsFunction: typeof p10kDb.command.gte === 'function',
    dbSideHits: Array.isArray(p10kDbSide.data) ? p10kDbSide.data.length : -1,
    memoryHits: p10kMemoryHits,
    fullKeys: shapeOf(p10kFull),
    fullOrder: p10kFull ? Object.keys(p10kFull).join(',') : null,
    fullRowOrders: [...new Set(p10kFullRows.map((row) => Object.keys(row).join(',')))],
    fullRowCount: p10kFullRows.length,
    fullTotal: p10kFull ? p10kFull.total : null,
    fullHasMore: p10kFull ? p10kFull.has_more : null,
    fullNextCursor: p10kFull ? p10kFull.next_cursor : null,
    resumeRowCount: p10kResumeRows.length,
    resumeIds: p10kResumeRows.map((row) => row.image_id),
    resumeTotal: p10kResume ? p10kResume.total : null,
    resumeHasMore: p10kResume ? p10kResume.has_more : null,
    resumeNextCursor: p10kResume ? p10kResume.next_cursor : null,
    writes: p10kStore.stats.writes.length
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
