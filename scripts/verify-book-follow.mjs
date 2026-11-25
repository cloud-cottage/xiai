#!/usr/bin/env node
/**
 * 玺爱 · **新入册影像自动跟随同印面唯一印谱归属（`book_id`）** 离线自检套
 * ============================================================================
 * （`scripts/verify-book-follow.mjs` · Kevin 2026-11-24 选 A 后半 · 派单口径 Zang 裁定）
 *
 * **本地、离线**（内存假 DB ＋ 内存假读计数；零网络、零云端连接、零生产数据、零磁盘写）。
 * 被测件（唯一实现点全在 `cloudfunctions/xiai-user-token/lib/ops.js`）：
 *   · `isImageBookId` / `IMAGE_BOOK_ID_PATTERN` —— `book_id` 形态门（`^\d{5}$`）
 *   · `followedBookIdOf(stampId, kind, rows)` —— **纯函数**（去重后恰 1 个才回值）
 *   · `followedBookIdFrom(stampId, kind, rows)` —— **读取包装**（复用那次 `imageSeqsOf` 读）
 *   · `followBookIdInto(doc, stampId, kind, rows, ownRow)` —— **落地单点**
 *   · 接线点：`ADMIN_OPS.registerFaceImage` ／ `OPS.registerCorrectionImage` ／
 *     `ADMIN_OPS.replaceFaceImage`（三处均**复用既有那次组内读**）＋ `lib/importChannels.js::
 *     importFaceImages`（占位 `stamp_id` ⇒ 单点内**零读短路**）
 *
 * 断言面（本套 **32** 条：A 7 ／ B 11 ／ C 8 ／ D 6）：
 *   A 段 纯函数（7）：恰 1 ⇒ 同值 / 0 ⇒ 空 / 2 ⇒ 空（不猜）/ 脏值 `abc`·`1234`·`123456`
 *      不参与候选（且不把「唯一」挤成冲突）/ 只认 `FACE` / 防串组 / 空参与不抛。
 *   B 段 入册路（9，真实 `ADMIN_OPS.registerFaceImage` ＋ 内存假库）：① 同印面恰 1 个归属 ⇒
 *      新行同值；② 0 个 ⇒ **无 `book_id` 键**；③ 2 个不同归属 ⇒ **无键**（冲突不猜）；
 *      ⑤ 读失败 ⇒ **入册成功**（`ok:true`）且无键 ＋ `log.warn` 如实；⑦ 单次入册对同一
 *      `(stamp_id, kind)` 组**恰 1 次读**（冲突轮同样恰 1）；同 `id` 重写轮 **0 次读** 且
 *      原行 `book_id` 原值带走；`EDGE` 不参与；回包键面不变。
 *   C 段 落地单点（8）：⑥ 新行自身已有 `book_id`（显式传入 / 脏值）⇒ **不覆盖**；复用传入
 *      `rows` ⇒ **零读**；`rows = null` ⇒ 零读不写；`rows = undefined` ⇒ 内部**恰读 1 次**；
 *      读抛错 ⇒ 不写、**不抛**（入册不被阻断）；占位 `stamp_id` ⇒ **零读**；非 FACE ⇒ 零改动。
 *   D 段 静态纪律（6，剥注释读源码）：单实现点恰 1 处；接线地图（ops.js 4 含定义 ／
 *      importChannels 1 ／ 两个 AI 写点 0）；AI 产物行零改动；`book_id` 不进普通用户可见
 *      DTO（`books.js` ⑩）与 `buildDirectImageRow` 字段面；零新增 `reason`（`REASONS` 恰 13）。
 *
 * 纪律：断言失败 ⇒ 退出码 1；不打印任何明文密钥。
 */
/* **测试环境保护哨兵（硬防线）** —— 本套只跑离线假体：置 `XIAI_NO_REAL_CARD=1`。 */
process.env.XIAI_NO_REAL_CARD = '1'

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

/* 合成测试环境（缺省才写；**脚本内不写任何真实密钥**）。 */
process.env.XIAI_USER_SMS_CODE = String(process.env.XIAI_USER_SMS_CODE || '729341').trim()
if (!process.env.XIAI_USER_TOKEN_SECRET) {
  process.env.XIAI_USER_TOKEN_SECRET = 'verify-book-follow-secret-' + String(Date.now())
}
process.env.XIAI_USER_TOKEN_SECRET = String(process.env.XIAI_USER_TOKEN_SECRET).trim()
process.env.XIAI_ADMIN_PHONE = String(process.env.XIAI_ADMIN_PHONE || '13800000000').trim()

const ops = require_(path.join(FN_DIR, 'lib/ops.js'))
const { REASONS } = require_(path.join(FN_DIR, 'lib/config.js'))
const log = require_(path.join(FN_DIR, 'lib/log.js'))

/* --------------------------------------------------------------------------- *
   断言骨架（与既有 `verify-*.mjs` 同形）
 * --------------------------------------------------------------------------- */
const results = []
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
  const stat = sectionStats[currentSection] || (sectionStats[currentSection] = { total: 0, failed: 0 })
  stat.total += 1
  if (!pass) stat.failed += 1
  results.push({ id, desc, pass, expected, actual })
  console.log(JSON.stringify({ id, case: desc, pass, expected, actual }))
}

function section(id, title) {
  currentSection = id
  sectionStats[id] = sectionStats[id] || { total: 0, failed: 0 }
  console.log(JSON.stringify({ section: id, title }))
}

const textOf = (value) => String(value === undefined || value === null ? '' : value).trim()
const hasBookId = (doc) => Boolean(doc) && Object.prototype.hasOwnProperty.call(doc, 'book_id')
/** 剥注释（块注释 ＋ 行注释）⇒ 静态断言只看真代码。 */
const stripComments = (raw) =>
  String(raw)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

/* --------------------------------------------------------------------------- *
   内存假库（形状对齐真实 SDK 使用面）＋ **读计数 / 读失败注入**
 * --------------------------------------------------------------------------- */
const tick = () => new Promise((resolve) => setImmediate(resolve))
const rowMatches = (row, match) => Object.keys(match).every((key) => row[key] === match[key])

function createFakeDb() {
  const state = { rows: [], failGroup: false }
  const counters = { group: 0, byId: 0, other: 0, total: 0 }
  const warnSpy = []
  const db = {
    state,
    counters,
    warnSpy,
    collection() {
      const query = { where: null, limit: 0 }
      const api = {
        where(match) {
          query.where = match || {}
          return api
        },
        limit(count) {
          query.limit = Number(count) || 0
          return api
        },
        skip() {
          return api
        },
        orderBy() {
          return api
        },
        doc(id) {
          return {
            get: async () => ({ data: state.rows.find((row) => row.id === id || row._id === id) || null }),
            async set() {
              return { updated: 1 }
            },
            async update() {
              return { updated: 1 }
            }
          }
        },
        async get() {
          await tick()
          const match = query.where || {}
          const keys = Object.keys(match)
          const isGroup = keys.includes('stamp_id') && keys.includes('kind')
          const isById = keys.includes('id') || keys.includes('_id')
          counters.total += 1
          if (isGroup) {
            counters.group += 1
            if (state.failGroup) {
              /* **读失败注入**：只炸 `(stamp_id, kind)` 那一发（`imageSeqsOf` 自行降级空集）。 */
              throw new Error('FAKE_GROUP_READ_FAILURE')
            }
          } else if (isById) {
            counters.byId += 1
          } else {
            counters.other += 1
          }
          let hits = state.rows.filter((row) => rowMatches(row, match)).map((row) => Object.assign({}, row))
          if (query.limit > 0) hits = hits.slice(0, query.limit)
          return { data: hits }
        }
      }
      return api
    }
  }
  return db
}

/* `log.warn` 单点打桩（只记录、不打印 ⇒ 输出零噪声；`ops.js` 经 `log.warn(...)` 属性调用）。 */
const warns = []
const originalWarn = log.warn
log.warn = (event, fields) => {
  warns.push({ event, fields })
}

let fakeDb = createFakeDb()
ops.setOpsDbProvider(() => fakeDb)

const resetDb = (rows, options) => {
  fakeDb = createFakeDb()
  fakeDb.state.rows = Array.isArray(rows) ? rows : []
  fakeDb.state.failGroup = Boolean(options && options.failGroup)
  warns.length = 0
  return fakeDb
}

/* --------------------------------------------------------------------------- *
   A 段：纯函数 `followedBookIdOf`（7）
 * --------------------------------------------------------------------------- */
section('A', '纯函数：followedBookIdOf —— 恰 1 才回值、脏值不参与、只认 FACE、防串组')

const STAMP = 'XA-BF1'
const rowOf = (over) => Object.assign({ id: 'img-r', stamp_id: STAMP, kind: 'FACE' }, over)

check(
  'A1',
  '同印面恰 1 个合法归属 ⇒ 回该值（新行写同值的判据）',
  '00001',
  ops.followedBookIdOf(STAMP, 'FACE', [rowOf({ book_id: '00001' }), rowOf({ id: 'img-s' })])
)

check(
  'A2',
  '0 个归属（全无键 / 全 `null`）⇒ `null`（不写键、不猜）',
  { none: null, nulls: null },
  {
    none: ops.followedBookIdOf(STAMP, 'FACE', [rowOf({ id: 'img-a' }), rowOf({ id: 'img-b' })]),
    nulls: ops.followedBookIdOf(STAMP, 'FACE', [rowOf({ book_id: null }), rowOf({ book_id: '' })])
  }
)

check(
  'A3',
  '2 个不同归属 ⇒ `null`（多书冲突不猜、不抽、不取其一）',
  null,
  ops.followedBookIdOf(STAMP, 'FACE', [rowOf({ book_id: '00001' }), rowOf({ id: 'img-b', book_id: '00002' })])
)

check(
  'A4',
  '脏值 `abc` / `1234` / `123456` 不参与候选（既不回脏值，也不把「唯一合法」挤成冲突）',
  { dirtyOnly: null, mixed: '00007', sameValueTwice: '00007' },
  {
    dirtyOnly: ops.followedBookIdOf(STAMP, 'FACE', [
      rowOf({ book_id: 'abc' }),
      rowOf({ id: 'img-b', book_id: '1234' }),
      rowOf({ id: 'img-c', book_id: '123456' })
    ]),
    mixed: ops.followedBookIdOf(STAMP, 'FACE', [
      rowOf({ book_id: 'abc' }),
      rowOf({ id: 'img-b', book_id: '00007' }),
      rowOf({ id: 'img-c', book_id: '123456' })
    ]),
    /* 同值多行去重后仍「恰 1 个」。 */
    sameValueTwice: ops.followedBookIdOf(STAMP, 'FACE', [
      rowOf({ book_id: '00007' }),
      rowOf({ id: 'img-b', book_id: '00007' })
    ])
  }
)

check(
  'A5',
  '只影响 `kind:\'FACE\'`：`EDGE` / 空串 / 缺 `kind` ⇒ 一律 `null`（零改动）',
  { edge: null, empty: null, missing: null },
  {
    edge: ops.followedBookIdOf(STAMP, 'EDGE', [rowOf({ kind: 'EDGE', book_id: '00001' })]),
    empty: ops.followedBookIdOf(STAMP, '', [rowOf({ book_id: '00001' })]),
    missing: ops.followedBookIdOf(STAMP, undefined, [rowOf({ book_id: '00001' })])
  }
)

check(
  'A6',
  '防串组：**异 `stamp_id`** 行的合法归属不参与本组判定',
  null,
  ops.followedBookIdOf(STAMP, 'FACE', [rowOf({ stamp_id: 'XA-OTHER', book_id: '00009' })])
)

check(
  'A7',
  '空参与不抛：`undefined` / `null` / 非数组 / 混入非对象 ⇒ 一律 `null`（零 I/O、零自抛）',
  { undef: null, nul: null, obj: null, dirty: '00003' },
  {
    undef: ops.followedBookIdOf(STAMP, 'FACE', undefined),
    nul: ops.followedBookIdOf(STAMP, 'FACE', null),
    obj: ops.followedBookIdOf(STAMP, 'FACE', { 0: rowOf({ book_id: '00001' }) }),
    dirty: ops.followedBookIdOf(STAMP, 'FACE', [null, 42, 'x', rowOf({ book_id: '00003' })])
  }
)

/* --------------------------------------------------------------------------- *
   B 段：入册路（真实 `ADMIN_OPS.registerFaceImage` ＋ 内存假库）（9）
 * --------------------------------------------------------------------------- */
section('B', '入册路：registerFaceImage —— ①②③⑤⑦ ＋ 同 id 重写轮 ＋ EDGE ＋ 回包键面')

const ADMIN_IDENTITY = { uid: 'u-admin-book-follow', phone: '13800000000', role: 'admin' }
const ADMIN_CONTEXT = { adminPhone: '13800000000' }
const shaOf = (tag) => createHash('sha256').update(tag).digest('hex')
const payloadOf = (tag, over) =>
  Object.assign(
    {
      seal_id: STAMP,
      face_id: 'fc-bf1-f1',
      sha256: shaOf(tag),
      mime: 'image/tiff',
      storage_key: `xiai/images/${shaOf(tag).slice(0, 2)}/${shaOf(tag)}.tiff`,
      bytes: 12345,
      kind: 'FACE'
    },
    over || {}
  )

/** 从成功回包取「实际要落盘的那一行」（`plan` 是内部落盘计划，`index.js` 不外传）。 */
const plannedRow = (reply) =>
  reply && reply.plan && reply.plan.writes && reply.plan.writes[0] ? reply.plan.writes[0].doc : null

const register = (payload) => ops.ADMIN_OPS.registerFaceImage(payload, ADMIN_IDENTITY, ADMIN_CONTEXT)
/** 各轮计划行键面留档（B2b 用：0 归属轮键面 ＋ 恰一个 `book_id` ＝ 1 归属轮键面）。 */
const keyFaces = {}


/* 基线组（同印面、同 kind 的既有行）。 */
const groupRow = (id, over) =>
  Object.assign({ id, stamp_id: STAMP, kind: 'FACE', seq: 1, storage: 'server' }, over || {})

/* B1：恰 1 个归属 ⇒ 新行同值。 */
{
  resetDb([groupRow('img-g1', { book_id: '00001' })])
  const reply = await register(payloadOf('case-unique'))
  const doc = plannedRow(reply)
  keyFaces.unique = Object.keys(doc || {}).sort()
  check('B1', '① 同印面恰 1 个归属 ⇒ 新行 `book_id` 逐字同值', { ok: true, bookId: '00001', has: true }, {
    ok: reply.ok === true,
    bookId: doc ? textOf(doc.book_id) : 'NO_DOC',
    has: hasBookId(doc)
  })
}

/* B2：0 个归属 ⇒ 无键（键面与改前逐字相同）。 */
{
  resetDb([groupRow('img-g2'), groupRow('img-g3', { book_id: null })])
  const reply = await register(payloadOf('case-none'))
  const doc = plannedRow(reply)
  keyFaces.none = Object.keys(doc || {}).sort()
  check('B2', '② 0 个归属 ⇒ 新行**没有 `book_id` 键**（不猜、键面与改前逐字相同）', {
    ok: true,
    has: false,
    keys: keyFaces.none
  }, { ok: reply.ok === true, has: hasBookId(doc), keys: Object.keys(doc || {}).sort() })
  /* B2b：1 归属轮键面 ＝ 0 归属轮键面 ＋ 恰一个 `book_id`（**只多这一个键**）。 */
  check('B2b', '① 跟随只**追加** `book_id` 一个键（其余键面与 0 归属轮逐字相同 ⇒ 回包/行体键面不变）', {
    added: ['book_id'],
    same: true
  }, {
    added: keyFaces.unique.filter((key) => !keyFaces.none.includes(key)),
    same:
      keyFaces.unique.length === keyFaces.none.length + 1 &&
      keyFaces.none.every((key) => keyFaces.unique.includes(key))
  })
}

/* B3：2 个不同归属 ⇒ 无键（冲突不猜）。 */
{
  resetDb([groupRow('img-g4', { book_id: '00001' }), groupRow('img-g5', { book_id: '00002', seq: 2 })])
  const reply = await register(payloadOf('case-conflict'))
  const doc = plannedRow(reply)
  check('B3', '③ 同印面 2 个不同归属 ⇒ 新行**没有 `book_id` 键**（多书冲突不猜、不抽）', {
    ok: true,
    has: false
  }, { ok: reply.ok === true, has: hasBookId(doc) })
}

/* B4：读失败 ⇒ 入册成功 ＋ 无键 ＋ `log.warn` 如实（绝不阻断）。 */
{
  resetDb([groupRow('img-g6', { book_id: '00001' })], { failGroup: true })
  const reply = await register(payloadOf('case-readfail'))
  const doc = plannedRow(reply)
  const failedWarns = warns.filter((item) => item.event === 'imageSeqs.read.failed')
  check('B4', '⑤ 组读抛错 ⇒ **入册成功**（`ok:true`）、无 `book_id` 键、`log.warn` 如实记降级', {
    ok: true,
    has: false,
    warn: 1
  }, { ok: reply.ok === true, has: hasBookId(doc), warn: failedWarns.length })
  check('B4b', '⑤ 读失败轮**回包键面不变**（仍 `ok/image_id/plan`，零新增键、零新增 reason）', {
    keys: 'image_id,ok,plan',
    reason: undefined
  }, { keys: Object.keys(reply).sort().join(','), reason: reply.reason })
}

/* B5：单次入册对同一 `(stamp_id, kind)` 组**恰 1 次读**（⑦）。 */
{
  resetDb([groupRow('img-g7', { book_id: '00003' })])
  await register(payloadOf('case-count-unique'))
  check('B5', '⑦ 唯一归属轮：单次入册对同 `(stamp_id, kind)` 组**恰 1 次读**（复用那次读、零额外读）', 1, fakeDb.counters.group)
}

/* B6：冲突轮同样恰 1 次读（不因「不写键」而多读）。 */
{
  resetDb([groupRow('img-g8', { book_id: '00003' }), groupRow('img-g9', { book_id: '00004', seq: 2 })])
  await register(payloadOf('case-count-conflict'))
  check('B6', '⑦ 冲突轮：同样**恰 1 次**组读（不猜 ⇒ 也不多读）', 1, fakeDb.counters.group)
}

/* B7：同 `id` 重写轮（`sameSealExisting`）⇒ **0 次组读** ＋ 原行 `book_id` 原值带走。 */
{
  const payload = payloadOf('case-rewrite')
  const sameId = ops.buildDirectImageRow(
    {
      image_sha256: payload.sha256,
      image_bytes: payload.bytes,
      image_storage_key: payload.storage_key,
      kind: 'FACE'
    },
    '2026-11-24T00:00:00.000Z'
  ).id
  resetDb([
    groupRow(sameId, { book_id: '00042', seq: 3 }),
    groupRow('img-g10', { book_id: '00001', seq: 1 })
  ])
  const reply = await register(payload)
  const doc = plannedRow(reply)
  check('B7', '同 `id` 重写轮：**0 次组读**（本轮刻意不读）且原行 `book_id` 原值带走（不覆盖、不丢归属）', {
    ok: true,
    groupReads: 0,
    bookId: '00042'
  }, { ok: reply.ok === true, groupReads: fakeDb.counters.group, bookId: doc ? textOf(doc.book_id) : 'NO_DOC' })
}

/* B8：`kind:'EDGE'` 不参与本规则（无键）。 */
{
  resetDb([groupRow('img-g11', { book_id: '00001', kind: 'EDGE', seq: 5 })])
  const reply = await register(payloadOf('case-edge', { kind: 'EDGE' }))
  const doc = plannedRow(reply)
  check('B8', '只影响 `FACE`：`kind:\'EDGE\'` 新行**没有 `book_id` 键**', { ok: true, has: false }, {
    ok: reply.ok === true,
    has: hasBookId(doc)
  })
}

/* B9：成功回包键面不变。 */
{
  resetDb([])
  const reply = await register(payloadOf('case-readout'))
  check('B9', '成功回包键面与改前逐字相同（`image_id/ok/plan`；零新增键、零新增 reason）', 'image_id,ok,plan', Object.keys(reply).sort().join(','))
}

/* --------------------------------------------------------------------------- *
   C 段：落地单点 `followBookIdInto`（8）
 * --------------------------------------------------------------------------- */
section('C', '落地单点：followBookIdInto —— 不覆盖已有值 / 复用那次读 / 降级不阻断')

const stampOf = 'XA-BF-C'
const rowsOf = (over) =>
  Object.assign([], over || [ { id: 'img-c1', stamp_id: stampOf, kind: 'FACE', book_id: '00005' } ])

/* C1：新行自身已有 `book_id`（显式传入）⇒ 不覆盖、零读。 */
{
  resetDb([])
  const doc = { id: 'img-new-1', stamp_id: stampOf, kind: 'FACE', book_id: '00011' }
  const wrote = await ops.followBookIdInto(doc, stampOf, 'FACE', rowsOf())
  check('C1', '⑥ 新行自身已有 `book_id`（显式传入）⇒ **不覆盖**（值原样、零读）', {
    wrote: false,
    bookId: '00011',
    reads: 0
  }, { wrote, bookId: textOf(doc.book_id), reads: fakeDb.counters.group })
}

/* C2：新行自身是脏值 ⇒ 亦不覆盖（不猜、不纠错、不改既有值）。 */
{
  resetDb([])
  const doc = { id: 'img-new-2', stamp_id: stampOf, kind: 'FACE', book_id: 'abc' }
  const wrote = await ops.followBookIdInto(doc, stampOf, 'FACE', rowsOf())
  check('C2', '新行自身带脏值 `abc` ⇒ 也不覆盖（原值保留、零读）', { wrote: false, bookId: 'abc' }, {
    wrote,
    bookId: textOf(doc.book_id)
  })
}

/* C3：传入 `rows`（复用那次读）⇒ 写入且**零读**。 */
{
  resetDb([])
  const doc = { id: 'img-new-3', stamp_id: stampOf, kind: 'FACE' }
  const wrote = await ops.followBookIdInto(doc, stampOf, 'FACE', rowsOf())
  check('C3', '复用调用方那次 `imageSeqsOf` 读（传 `rows`）⇒ 写同值且**零再读**', {
    wrote: true,
    bookId: '00005',
    reads: 0
  }, { wrote, bookId: textOf(doc.book_id), reads: fakeDb.counters.group })
}

/* C4：`rows = null`（本轮刻意不读）⇒ 零读、不写键。 */
{
  resetDb([])
  const doc = { id: 'img-new-4', stamp_id: stampOf, kind: 'FACE' }
  const wrote = await ops.followBookIdInto(doc, stampOf, 'FACE', null)
  check('C4', '`rows = null`（调用方本轮刻意不读）⇒ **零读**、不写键', { wrote: false, has: false, reads: 0 }, {
    wrote,
    has: hasBookId(doc),
    reads: fakeDb.counters.group
  })
}

/* C5：`rows = undefined` ⇒ 内部**恰读 1 次** ⇒ 写入。 */
{
  resetDb([rowsOf()[0]])
  const doc = { id: 'img-new-5', stamp_id: stampOf, kind: 'FACE' }
  const wrote = await ops.followBookIdInto(doc, stampOf, 'FACE', undefined)
  check('C5', '调用方拿不到那份行 ⇒ 单点内部**恰读 1 次**（同组绝不读第二次）后写同值', {
    wrote: true,
    bookId: '00005',
    reads: 1
  }, { wrote, bookId: textOf(doc.book_id), reads: fakeDb.counters.group })
}

/* C6：读抛错 ⇒ 返回 `false`、**不抛**、warn 如实（入册不被阻断）。 */
{
  resetDb([], { failGroup: true })
  const doc = { id: 'img-new-6', stamp_id: stampOf, kind: 'FACE' }
  let threw = null
  let wrote = null
  try {
    wrote = await ops.followBookIdInto(doc, stampOf, 'FACE', undefined)
  } catch (error) {
    threw = error && error.message
  }
  const failedWarns = warns.filter((item) => item.event === 'imageSeqs.read.failed')
  check('C6', '读失败 ⇒ **不抛**、不写键、`log.warn` 如实（入册绝不被阻断）', {
    threw: null,
    wrote: false,
    has: false,
    warn: true
  }, {
    threw,
    wrote,
    has: hasBookId(doc),
    warn: failedWarns.length >= 1
  })
}

/* C7：占位 `stamp_id`（`imp-…`）⇒ **零读**、不写键。 */
{
  resetDb([rowsOf()[0]])
  const doc = { id: 'img-new-7', stamp_id: 'imp-0123456789abcdef', kind: 'FACE' }
  const wrote = await ops.followBookIdInto(doc, 'imp-0123456789abcdef', 'FACE', undefined)
  check('C7', '占位 `stamp_id`（`imp-…`，入册通道现状）⇒ **零读**、不写键（与改前逐字同）', {
    wrote: false,
    has: false,
    reads: 0
  }, { wrote, has: hasBookId(doc), reads: fakeDb.counters.group })
}

/* C8：非 FACE / 非对象行 ⇒ 零改动、零读。 */
{
  resetDb([rowsOf()[0]])
  const edgeDoc = { id: 'img-new-8', stamp_id: stampOf, kind: 'EDGE' }
  const wroteEdge = await ops.followBookIdInto(edgeDoc, stampOf, 'EDGE', undefined)
  const wroteNull = await ops.followBookIdInto(null, stampOf, 'FACE', undefined)
  check('C8', '非 `FACE` / 非对象行 ⇒ 零改动、零读（AI 产物行与 EDGE 行不参与本规则）', {
    edge: false,
    edgeHas: false,
    nul: false,
    reads: 0
  }, {
    edge: wroteEdge,
    edgeHas: hasBookId(edgeDoc),
    nul: wroteNull,
    reads: fakeDb.counters.group
  })
}

/* --------------------------------------------------------------------------- *
   D 段：静态纪律（6，剥注释读源码）
 * --------------------------------------------------------------------------- */
section('D', '静态纪律：单实现点 / 接线地图 / AI 产物行零改动 / DTO 不漏 / 零新增 reason')

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const opsSrc = readSrc('cloudfunctions/xiai-user-token/lib/ops.js')
const importSrc = readSrc('cloudfunctions/xiai-user-token/lib/importChannels.js')
const aiEnhanceSrc = readSrc('cloudfunctions/xiai-user-token/lib/aiEnhance.js')
const aiTasksSrc = readSrc('cloudfunctions/xiai-user-token/lib/aiEnhanceTasks.js')
const booksSrc = readSrc('cloudfunctions/xiai-user-token/lib/books.js')

const countOf = (haystack, needle) => String(haystack).split(needle).length - 1

/* D1：单实现点恰 1 处。 */
check('D1', '单实现点：`followedBookIdOf` 全仓**恰 1 处**定义（`lib/ops.js`；零第二套）', 1, countOf(stripComments(opsSrc), 'function followedBookIdOf('))

/* D2：接线地图（剥注释后 `followBookIdInto(` 计数）。 */
{
  const opsCalls = countOf(stripComments(opsSrc), 'followBookIdInto(')
  const importCalls = countOf(stripComments(importSrc), 'followBookIdInto(')
  check('D2', '接线地图：`lib/ops.js` 恰 4 处（1 定义 ＋ 3 调用：registerFaceImage / registerCorrectionImage / replaceFaceImage）＋ `importChannels.js` 恰 1 处', {
    ops: 4,
    import: 1
  }, { ops: opsCalls, import: importCalls })
}

/* D3：AI 产物行两写点零改动（不参与本规则）。 */
check(
  'D3',
  'AI 修复产物行两写点（`aiEnhance.js:533` / `aiEnhanceTasks.js:1133`）**零接线**（按源图继承，AC-893 不变）',
  { enhance: 0, tasks: 0 },
  {
    enhance: countOf(stripComments(aiEnhanceSrc), 'followBookIdInto('),
    tasks: countOf(stripComments(aiTasksSrc), 'followBookIdInto(')
  }
)

/* D4：`book_id` 不进普通用户可见 DTO（`books.js` ⑩）。 */
{
  const block = /const BOOK_ROW_KEYS = Object\.freeze\(\[[\s\S]*?\]\)/.exec(stripComments(booksSrc))
  check('D4', '`book_id` 不进普通用户可见行键面（`lib/books.js::BOOK_ROW_KEYS` ⑩ 冻结不变）', {
    found: true,
    hasBookId: false
  }, { found: Boolean(block), hasBookId: block ? block[0].includes('book_id') : true })
}

/* D5：零新增 `reason`（`REASONS` 恰 13、逐字冻结）。 */
{
  const frozen = [
    'FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE',
    'ALREADY_ENDORSED', 'DUPLICATE_VALUE', 'INSUFFICIENT_POINTS', 'KEY_INVALID', 'CONFIG_MISSING',
    'LIMIT_DAY', 'LIMIT_MINUTE', 'UPSTREAM_ERROR'
  ]
  check('D5', '零新增 `reason`：`REASONS` 恰 13 项且逐字等于冻结表（本单不加任何 reason）', {
    count: 13,
    same: true
  }, { count: Object.keys(REASONS).length, same: canon(Object.keys(REASONS)) === canon(frozen) })
}

/* D6：`book_id` 不进 `buildDirectImageRow` 字段面（行体由既有唯一规则点构造）。 */
{
  const fnStart = opsSrc.indexOf('function buildDirectImageRow(')
  let body = ''
  if (fnStart >= 0) {
    const open = opsSrc.indexOf('{', fnStart)
    let depth = 0
    for (let i = open; i < opsSrc.length; i += 1) {
      if (opsSrc[i] === '{') depth += 1
      else if (opsSrc[i] === '}') {
        depth -= 1
        if (depth === 0) {
          body = opsSrc.slice(fnStart, i + 1)
          break
        }
      }
    }
  }
  check('D6', '`buildDirectImageRow` 字段面零 `book_id`（新行键面只由本单在**落地单点**按判据追加）', {
    found: true,
    hasBookId: false
  }, { found: body.length > 0, hasBookId: stripComments(body).includes('book_id') })
}

/* --------------------------------------------------------------------------- *
   汇总
 * --------------------------------------------------------------------------- */
log.warn = originalWarn
const failedIds = results.filter((item) => !item.pass).map((item) => item.id)
console.log(
  JSON.stringify({
    summary: { total: results.length, passed: results.length - failedIds.length, failed: failedIds.length },
    sections: sectionStats,
    failed_ids: failedIds,
    note: '零网络、零 SDK、零真库、零磁盘写：内存假库 ＋ 内存读计数 ＋ `log.warn` 打桩；被测件＝真实 lib/ops.js（registerFaceImage / followBookIdInto 等）。'
  })
)
process.exit(Math.min(failedIds.length, 255))
