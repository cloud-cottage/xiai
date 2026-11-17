#!/usr/bin/env node
/**
 * 玺爱 · **影像准入（`xiai_images.marked`）** 离线自检套
 * ============================================================================
 * 裁定（Kevin 2026-11-17）：影像需要**独立的审核字段**，与 `visibility` 分开 ——
 *   · `visibility` ＝ **展示形态**（主图 `hidden`、精修件 `visible`）；
 *   · `marked`     ＝ **准入**（**xiai 只读取已标记的影像**；未标记对 xiai 等同「暂无影像」）。
 * 字段契约（冻结）：`marked`（boolean，缺键一律 `false`）／`marked_by`（不透明 uid）／
 * `marked_at`（ISO）。**哨兵豁免**：`storage === 'bundled'`（`img-placeholder-seal-no-image`）
 * 恒视为已标记（UI 兜底不得消失）。
 *
 * 被测实现（四个文件，本单改动）：
 *   · `src/data/cloudbase.js` —— `imageMarkedOf` / `isMarkedImageRow` / `isBundledImageRow`
 *       ＋ `filterImageRowsForViewer` 的**准入门先于可见性提升**；
 *   · `src/data/db.js` —— `listImageRows` 交出前同一条过滤单点 ＋ `imageRowMarkedStateOf`
 *       （投影侧三态判据，**不吃读面过滤**）；
 *   · `src/services/drive.js` —— `resolveShare` / `sealBriefOf` 投影里零未标记影像；
 *   · `cloudfunctions/xiai-user-token/lib/ops.js` —— 白名单 8 → 9（只加 `marked`）＋
 *       布尔值域门（非布尔 `INVALID_VALUE` 零写入）＋ 落行恒带 `marked`/`marked_by`/`marked_at`
 *       （**by/at 从服务端身份与时钟取，客户端不得递**）。
 *
 * 判据口径（照本仓既有套件）：
 *   · **零联网、零 SDK、零真库**：`localStorage` 用内存 `Map` 桩撑起；生产云模式不接管
 *     （未配置 `VITE_XIAI_CB_ENV_ID` ⇒ 云状态 `off` ⇒ 走本机镜像）；
 *   · 写面（C）用 `setOpsDbProvider` 注入**内存假库**，跑的是真实 `lib/ops.js`
 *     ｜`ADMIN_OPS.registerFaceImage`；
 *   · **每条判据可判负**：期望值与实读数逐条 `canon` 比对，任一不等 ⇒ 该条红、退出码计数；
 *   · **零副作用**：只写内存桩，不碰磁盘数据文件、不写云端、不动 git。
 *
 * 分段：
 *   A 纯函数（5）：`marked` 布尔三态 ＋ 非布尔一律 `false` ＋ 哨兵豁免 ＋ 空行
 *   B 读面（6）：非管理员看不到未标记 / 管理员全取 / 缺键行不可见 / 哨兵行可见 /
 *     `visibility × marked` 四组合 / **组内提升不得越过准入门**
 *   C 写面（6）：缺省 `false` 三键齐 / 非布尔 `INVALID_VALUE` 零写入 / `true` 落 by·at /
 *     客户端递 by·at `INVALID_FIELD` / 白名单静态恰 9 键 / 非管理员 `FORBIDDEN`
 *   D 分享投影（3）：游客零未标记 / 三态一致 / 哨兵影像不被摘
 *   E 写面缺口（10）：**换图 `replaceFaceImage` 继承准入**（true→true / false→false / 无键⇒false /
 *     行不存在⇒false / 哨兵前身⇒已标记 / 共用行不得降级 / 客户端递键 `INVALID_FIELD`）＋
 *     **修正图 `registerCorrectionImage` 恒 `false`**（＋ 客户端递键 `INVALID_FIELD` ＋
 *     不得撤回既有准入）
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const require_ = createRequire(import.meta.url)

const OPS_REL = 'cloudfunctions/xiai-user-token/lib/ops.js'
const CLOUDBASE_REL = 'src/data/cloudbase.js'
const DB_REL = 'src/data/db.js'
const DRIVE_REL = 'src/services/drive.js'

/* ---------------------------------------------------------------- 断言骨架 */
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

/* ------------------------------------------------- 内存 localStorage 桩（唯一真源） */
const MEMORY_STORE = new Map()
globalThis.localStorage = {
  getItem: (key) => (MEMORY_STORE.has(key) ? MEMORY_STORE.get(key) : null),
  setItem: (key, value) => MEMORY_STORE.set(key, String(value)),
  removeItem: (key) => MEMORY_STORE.delete(key),
  clear: () => MEMORY_STORE.clear(),
  key: (index) => Array.from(MEMORY_STORE.keys())[index] ?? null,
  get length() {
    return MEMORY_STORE.size
  }
}
globalThis.window = globalThis
globalThis.sessionStorage = globalThis.localStorage

const importSrc = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

/* ============================================================================
   A 纯函数（5）
   ----------------------------------------------------------------------------
   判定口径写死在这里：**准入只认布尔 `true`**；缺键 / `false` / 非布尔（`'true'` / `1` /
   `{}` / `null`）一律 `false`（＝ 对 xiai「暂无影像」）。**唯一例外**：哨兵行
   `storage === 'bundled'` 恒 `true`（UI 兜底不得消失）。
   ============================================================================ */
section('A', '纯函数：imageMarkedOf / isMarkedImageRow 三态 ＋ 非布尔 ＋ 哨兵豁免')

const cloudbase = await importSrc(CLOUDBASE_REL)
const { imageMarkedOf, isMarkedImageRow, isBundledImageRow, filterImageRowsForViewer } = cloudbase

check(
  'A1',
  '`marked: true` ⇒ 判已标记（唯一能放行的布尔字面）',
  { marked: true, isMarked: true },
  (() => {
    const row = { id: 'r1', marked: true }
    return { marked: imageMarkedOf(row), isMarked: isMarkedImageRow(row) }
  })()
)

check(
  'A2',
  '`marked: false` ⇒ 判未标记（不隐藏、不抛错；只是对 xiai 等同暂无影像）',
  { marked: false, isMarked: false },
  (() => {
    const row = { id: 'r2', marked: false }
    return { marked: imageMarkedOf(row), isMarked: isMarkedImageRow(row) }
  })()
)

check(
  'A3',
  '**缺 `marked` 键**（旧行 6444 条 TIFF 的那一态）⇒ 一律当 `false`（契约明文，非「默认放行」）',
  { hasKey: false, marked: false, isMarked: false },
  (() => {
    const row = { id: 'r3', stamp_id: 'XAI-0001', kind: 'FACE', storage: 'server' }
    return {
      hasKey: Object.prototype.hasOwnProperty.call(row, 'marked'),
      marked: imageMarkedOf(row),
      isMarked: isMarkedImageRow(row)
    }
  })()
)

check(
  'A4',
  '非布尔（`\'true\'` / `1` / `{}` / `null` / `undefined`）⇒ 一律 `false`、零抛错（只认布尔 `true`）',
  {
    stringMarked: false,
    numberMarked: false,
    objectMarked: false,
    nullMarked: false,
    undefinedMarked: false,
    emptyMarked: false
  },
  {
    stringMarked: imageMarkedOf({ marked: 'true' }),
    numberMarked: imageMarkedOf({ marked: 1 }),
    objectMarked: imageMarkedOf({ marked: {} }),
    nullMarked: imageMarkedOf({ marked: null }),
    undefinedMarked: imageMarkedOf(undefined),
    emptyMarked: imageMarkedOf(null)
  }
)

check(
  'A5',
  '**哨兵豁免**：`storage === \'bundled\'` 且**无** `marked` 键 ⇒ 恒判已标记（UI 兜底不得消失）',
  { bundledNoKey: true, bundledFalse: true, serverNoKey: false, isBundled: true, plainIsBundled: false },
  (() => {
    const sentinel = { id: 'img-placeholder-seal-no-image', storage: 'bundled' }
    return {
      bundledNoKey: imageMarkedOf(sentinel),
      bundledFalse: imageMarkedOf({ ...sentinel, marked: false }),
      serverNoKey: imageMarkedOf({ id: 'x', storage: 'server' }),
      isBundled: isBundledImageRow(sentinel),
      plainIsBundled: isBundledImageRow({ id: 'x', storage: 'server' })
    }
  })()
)

/* ============================================================================
   B 读面（6）：真实 `listImageRows()` ＋ 真实本机镜像（内存桩）
   ----------------------------------------------------------------------------
   造数用 `writeKey` 直写影像集合（只写内存桩）：每张图一个确定性场景。
   `SEQ` 用来验证「组内提升」不会把**未标记**的 hidden 行提升成「面有图可显示」。
   ============================================================================ */
section('B', '读面：listImageRows 准入门 ＋ 与 visibility 叠加 ＋ 哨兵豁免')

const session = await importSrc('src/data/session.js')
const storage = await importSrc('src/data/storage.js')
const db = await importSrc(DB_REL)
const { writeKey, readKey, STORAGE_KEYS } = storage

/* 先触发一次种子（全新安装 ⇒ 整套种子写入），再整体替换影像集合。 */
db.listImageRows()

const IMG_ROWS = [
  /* ① 组 XA-T1：已标记 + 未标记（同组，验证「未标记不可见」且提升不乱）。 */
  { id: 'img-t1-a', stamp_id: 'XA-T1', kind: 'FACE', seq: 1, marked: true, visibility: 'visible', sha256: 'a1', bytes: 1 },
  { id: 'img-t1-b', stamp_id: 'XA-T1', kind: 'FACE', seq: 2, marked: false, visibility: 'visible', sha256: 'a2', bytes: 1 },
  /* ② 组 XA-T2：**缺 `marked` 键**的旧行（唯一一张）。 */
  { id: 'img-t2-a', stamp_id: 'XA-T2', kind: 'FACE', seq: 1, visibility: 'visible', sha256: 'a3', bytes: 1 },
  /* ③ 哨兵行：`storage: 'bundled'`、无 `marked` 键（恒可展示）。 */
  { id: 'img-placeholder-seal-no-image', stamp_id: 'imp-placeholder', kind: 'FACE', storage: 'bundled', sha256: 'a4', bytes: 1 },
  /* ④ `visibility × marked` 四组合（两组，各含一张 visible 兄弟 ⇒ 不触发提升）。 */
  { id: 'img-t5-hm', stamp_id: 'XA-T5', kind: 'FACE', seq: 1, marked: true, visibility: 'hidden', sha256: 'a5', bytes: 1 },
  { id: 'img-t5-vm', stamp_id: 'XA-T5', kind: 'FACE', seq: 2, marked: true, visibility: 'visible', sha256: 'a6', bytes: 1 },
  { id: 'img-t6-hu', stamp_id: 'XA-T6', kind: 'FACE', seq: 1, marked: false, visibility: 'hidden', sha256: 'a7', bytes: 1 },
  { id: 'img-t6-vu', stamp_id: 'XA-T6', kind: 'FACE', seq: 2, marked: false, visibility: 'visible', sha256: 'a8', bytes: 1 },
  /* ⑤ 提升越权陷阱：整组只有一张 **hidden + 未标记** ⇒ 非管理员必须一行都看不到。 */
  { id: 'img-t7-a', stamp_id: 'XA-T7', kind: 'FACE', seq: 1, marked: false, visibility: 'hidden', sha256: 'a9', bytes: 1 }
]
writeKey(STORAGE_KEYS.images, IMG_ROWS)

const idsOf = (rows) => rows.map((row) => row.id).sort()
const viewerRows = (user) => {
  session.setUser(user)
  return db.listImageRows()
}

session.setUser({ id: 'u-plain-marked', role: 'user' })
const plainRows = db.listImageRows()
const plainIds = idsOf(plainRows)

check(
  'B1',
  '非管理员：`marked: false` 的行**不返回**（同组已标记兄弟仍在 ⇒ 不是把整组抹掉）',
  { hasUnmarked: false, hasMarkedSibling: true },
  { hasUnmarked: plainIds.includes('img-t1-b'), hasMarkedSibling: plainIds.includes('img-t1-a') }
)

session.setUser({ id: 'u-admin-marked', role: 'admin' })
const adminRows = db.listImageRows()
const adminIds = idsOf(adminRows)

check(
  'B2',
  '管理员：**全取**（未标记行照旧在，且 `marked` 逐字 `false` —— 管理员读面不做准入裁剪）',
  { hasUnmarked: true, marked: false, count: IMG_ROWS.length },
  { hasUnmarked: adminIds.includes('img-t1-b'), marked: adminIds.includes('img-t1-b') ? db.listImageRows().find((r) => r.id === 'img-t1-b').marked : 'MISSING', count: adminRows.length }
)

check(
  'B3',
  '**缺 `marked` 键的旧行**对非管理员不可见（落盘原行仍无该键 ⇒ 不是被就地补写）',
  { visibleToPlain: false, storageStillKeyless: true },
  {
    visibleToPlain: plainIds.includes('img-t2-a'),
    storageStillKeyless: !Object.prototype.hasOwnProperty.call(
      (readKey(STORAGE_KEYS.images) || []).find((row) => row.id === 'img-t2-a') || {},
      'marked'
    )
  }
)

check(
  'B4',
  '**哨兵行**（`storage: \'bundled\'`、无 `marked` 键）即使未标记也对非管理员可见',
  { visibleToPlain: true },
  { visibleToPlain: plainIds.includes('img-placeholder-seal-no-image') }
)

/* B5：`visibility × marked` 四组合 —— 非管理员只剩 `marked` 那些，且 hidden 的仍被 `visibility` 挡。 */
check(
  'B5',
  '与 `visibility` 叠加：`visible+marked` ✅ / `hidden+marked` ✗（visibility 挡） / `visible+未标记` ✗ / `hidden+未标记` ✗；管理员四行全见',
  {
    plainVisibleMarked: true,
    plainHiddenMarked: false,
    plainVisibleUnmarked: false,
    plainHiddenUnmarked: false,
    adminAllFour: true
  },
  {
    plainVisibleMarked: plainIds.includes('img-t5-vm'),
    plainHiddenMarked: plainIds.includes('img-t5-hm'),
    plainVisibleUnmarked: plainIds.includes('img-t6-vu'),
    plainHiddenUnmarked: plainIds.includes('img-t6-hu'),
    adminAllFour: ['img-t5-hm', 'img-t5-vm', 'img-t6-hu', 'img-t6-vu'].every((id) => adminIds.includes(id))
  }
)

/* B6：提升不得越过准入门 —— 组内只有一张 hidden + 未标记。 */
const t7Plain = plainRows.filter((row) => textOf(row.stamp_id) === 'XA-T7')
const t7Admin = adminRows.filter((row) => textOf(row.stamp_id) === 'XA-T7')

check(
  'B6',
  '**组内提升不得越过准入门**：整组只有一张 `hidden + 未标记` ⇒ 非管理员 0 行（不是「提升成 visible」）；管理员 1 行',
  { plainT7Rows: 0, adminT7Rows: 1 },
  { plainT7Rows: t7Plain.length, adminT7Rows: t7Admin.length }
)

/* B7：投影侧三态判据 `imageRowMarkedStateOf`（不吃读面过滤）。 */
session.setUser({ id: 'u-plain-marked', role: 'user' })

check(
  'B7',
  '`imageRowMarkedStateOf`（投影侧、**不吃读面过滤**）四态：true / false / 缺键⇒false / 未知 id⇒`found:false`（**查不到 ≠ 未标记**）',
  {
    marked: { found: true, marked: true },
    unmarked: { found: true, marked: false },
    keyless: { found: true, marked: false },
    sentinel: { found: true, marked: true },
    unknown: { found: false, marked: false },
    empty: { found: false, marked: false }
  },
  {
    marked: db.imageRowMarkedStateOf('img-t1-a'),
    unmarked: db.imageRowMarkedStateOf('img-t1-b'),
    keyless: db.imageRowMarkedStateOf('img-t2-a'),
    sentinel: db.imageRowMarkedStateOf('img-placeholder-seal-no-image'),
    unknown: db.imageRowMarkedStateOf('img-does-not-exist'),
    empty: db.imageRowMarkedStateOf('')
  }
)

/* ============================================================================
   C 写面（6）：真实 `lib/ops.js::ADMIN_OPS.registerFaceImage` ＋ 内存假库
   ----------------------------------------------------------------------------
   假库只实现远端读链（`collection(name).where(match).limit(n).get()`）。
   值域门**判在任何读之前** ⇒ 非布尔那几条零读零写；合法值那条只拿 `plan`（落盘计划）。
   ============================================================================ */
section('C', '写面：registerFaceImage 白名单（8→9）＋ 布尔门 ＋ marked_by/marked_at 服务端取')

const ops = require_(path.join(ROOT, OPS_REL))

function makeFakeDb(rows) {
  return {
    collection() {
      const state = { where: null, limit: 0 }
      const api = {
        where(match) {
          state.where = match || {}
          return api
        },
        limit(count) {
          state.limit = Number(count) || 0
          return api
        },
        skip() {
          return api
        },
        orderBy() {
          return api
        },
        doc(id) {
          return { get: async () => ({ data: rows.find((row) => row.id === id) || null }) }
        },
        async get() {
          let hits = rows.filter((row) =>
            Object.entries(state.where || {}).every(([key, value]) => row[key] === value)
          )
          if (state.limit > 0) hits = hits.slice(0, state.limit)
          return { data: hits }
        }
      }
      return api
    }
  }
}

const FAKE_ROWS = []
ops.setOpsDbProvider(() => makeFakeDb(FAKE_ROWS))

const ADMIN_IDENTITY = { uid: 'u-admin-marked-1', phone: '13800000000', role: 'admin' }
const ADMIN_CONTEXT = { adminPhone: '13800000000' }
const DIGEST = 'b'.repeat(64)
const BASE_PAYLOAD = Object.freeze({
  seal_id: 'XA-C1',
  face_id: 'fc-c1-f1',
  sha256: DIGEST,
  mime: 'image/tiff',
  storage_key: `xiai/images/bb/${DIGEST}.tiff`,
  bytes: 12345,
  kind: 'FACE'
})

const register = (payload, identity = ADMIN_IDENTITY, context = ADMIN_CONTEXT) =>
  ops.ADMIN_OPS.registerFaceImage(payload, identity, context)
/** 从成功回包里取「实际要落盘的那一行」（`plan` 是内部面，`index.js` 不外传）。 */
const plannedRow = (reply) =>
  reply && reply.plan && reply.plan.writes && reply.plan.writes[0] ? reply.plan.writes[0].doc : null

const defaultReply = await register({ ...BASE_PAYLOAD })
const defaultRow = plannedRow(defaultReply)

check(
  'C1',
  '不传 `marked` ⇒ 落行恒带**三键**：`marked:false`（缺省即未标记）＋ `marked_by:""` / `marked_at:""`（**不给「谁标记的」留假归属**）',
  { ok: true, marked: false, hasMarked: true, markedBy: '', markedAt: '' },
  {
    ok: defaultReply.ok === true,
    marked: defaultRow ? defaultRow.marked : 'MISSING',
    hasMarked: defaultRow ? Object.prototype.hasOwnProperty.call(defaultRow, 'marked') : false,
    markedBy: defaultRow ? textOf(defaultRow.marked_by) : 'MISSING',
    markedAt: defaultRow ? textOf(defaultRow.marked_at) : 'MISSING'
  }
)

const nonBooleanValues = ['true', 'false', 1, 0, null, '', {}]
const nonBooleanReplies = []
for (const value of nonBooleanValues) {
  nonBooleanReplies.push(await register({ ...BASE_PAYLOAD, marked: value }))
}

check(
  'C2',
  '非布尔（`\'true\'` / `\'false\'` / `1` / `0` / `null` / `\'\'` / `{}`）⇒ 每条 `INVALID_VALUE` ＋ **零写入**（无 `plan`、回包恰 3 键）',
  {
    count: nonBooleanValues.length,
    allDenied: true,
    reasons: nonBooleanValues.map(() => 'INVALID_VALUE'),
    plans: nonBooleanValues.map(() => false),
    keySets: nonBooleanValues.map(() => ['message', 'ok', 'reason'])
  },
  {
    count: nonBooleanReplies.length,
    allDenied: nonBooleanReplies.every((reply) => reply && reply.ok === false),
    reasons: nonBooleanReplies.map((reply) => textOf(reply && reply.reason)),
    plans: nonBooleanReplies.map((reply) => Object.prototype.hasOwnProperty.call(reply || {}, 'plan')),
    keySets: nonBooleanReplies.map((reply) => Object.keys(reply || {}).sort())
  }
)

const markedReply = await register({ ...BASE_PAYLOAD, marked: true })
const markedRow = plannedRow(markedReply)
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

check(
  'C3',
  '`marked: true` ⇒ 落 `true`；`marked_by` ＝ **服务端身份 uid**、`marked_at` ＝ ISO（服务端时钟，客户端零参与）',
  { ok: true, marked: true, markedBy: ADMIN_IDENTITY.uid, markedAtIsIso: true },
  {
    ok: markedReply.ok === true,
    marked: markedRow ? markedRow.marked : 'MISSING',
    markedBy: markedRow ? textOf(markedRow.marked_by) : 'MISSING',
    markedAtIsIso: markedRow ? ISO_PATTERN.test(textOf(markedRow.marked_at)) : false
  }
)

const forgedByReply = await register({ ...BASE_PAYLOAD, marked: true, marked_by: 'u-attacker' })
const forgedAtReply = await register({ ...BASE_PAYLOAD, marked: true, marked_at: '1999-01-01T00:00:00.000Z' })

check(
  'C4',
  '客户端递 `marked_by` / `marked_at` ⇒ `INVALID_FIELD` ＋ **零写入**（身份与时钟只能服务端取 ⇒ 不可伪造归属）',
  { byDenied: true, byReason: 'INVALID_FIELD', byHasPlan: false, atDenied: true, atReason: 'INVALID_FIELD', atHasPlan: false },
  {
    byDenied: forgedByReply.ok === false,
    byReason: textOf(forgedByReply.reason),
    byHasPlan: Object.prototype.hasOwnProperty.call(forgedByReply, 'plan'),
    atDenied: forgedAtReply.ok === false,
    atReason: textOf(forgedAtReply.reason),
    atHasPlan: Object.prototype.hasOwnProperty.call(forgedAtReply, 'plan')
  }
)

/* C5：白名单**只**多这一个键 —— 静态（源码字面恰 9 键、含 `marked`，且 by/at 不在内）＋ 行为。 */
const opsSource = fs.readFileSync(path.join(ROOT, OPS_REL), 'utf8')
const allowBlock = /const FACE_IMAGE_REGISTER_ALLOWED_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(opsSource)
const staticKeys = allowBlock ? Array.from(allowBlock[1].matchAll(/'([^']+)'/g)).map((m) => m[1]).sort() : []
const extraKeyReply = await register({ ...BASE_PAYLOAD, marked: true, book_id: '00001' })

check(
  'C5',
  '服务端白名单**只**多 `marked` 一键：静态恰 9 键（`marked_by`/`marked_at` **不在内**）＋ 未登记键（`book_id`）仍 `INVALID_FIELD` 零写入',
  {
    staticKeys: ['bytes', 'face_id', 'kind', 'marked', 'mime', 'seal_id', 'sha256', 'storage_key', 'visibility'],
    extraDenied: true,
    extraReason: 'INVALID_FIELD',
    extraHasPlan: false
  },
  {
    staticKeys,
    extraDenied: extraKeyReply.ok === false,
    extraReason: textOf(extraKeyReply.reason),
    extraHasPlan: Object.prototype.hasOwnProperty.call(extraKeyReply, 'plan')
  }
)

/* C6：改回 / 改标只能由管理员（授权者）—— 本 op 的管理员门判在任何读写之前。 */
const plainIdentityReply = await register({ ...BASE_PAYLOAD, marked: true }, { uid: 'u-plain-1', phone: '13900000000', role: 'user' })
const noEnvReply = await register({ ...BASE_PAYLOAD, marked: true }, ADMIN_IDENTITY, {})

check(
  'C6',
  '**标记 / 改回只能由管理员**：非白名单身份 ⇒ `FORBIDDEN`＋零写入；缺 `XIAI_ADMIN_PHONE` env ⇒ 结构化拒绝＋零写入（客户端无法自行改标）',
  {
    plainDenied: true,
    plainReason: 'FORBIDDEN',
    plainHasPlan: false,
    noEnvDenied: true,
    noEnvHasPlan: false
  },
  {
    plainDenied: plainIdentityReply.ok === false,
    plainReason: textOf(plainIdentityReply.reason),
    plainHasPlan: Object.prototype.hasOwnProperty.call(plainIdentityReply, 'plan'),
    noEnvDenied: noEnvReply.ok === false,
    noEnvHasPlan: Object.prototype.hasOwnProperty.call(noEnvReply, 'plan')
  }
)

/* ============================================================================
   D 分享投影（3）：真实 `resolveShare(code)`
   ----------------------------------------------------------------------------
   造数：三枚印的主面分别指向 ①**未标记**影像 ②已标记影像 ③**哨兵**影像（bundled、无 marked）。
   资料夹恰 3 项（＝游客预览上限）⇒ 三态同集合可比。
   ============================================================================ */
section('D', '分享投影：resolveShare 零未标记影像 ＋ 哨兵不被摘 ＋ 三态')

const PROJECTION_IMAGES = [
  { id: 'img-d-unmarked', stamp_id: 'XAI-0001', kind: 'FACE', seq: 1, marked: false, visibility: 'visible', sha256: 'd1', bytes: 1 },
  { id: 'img-d-marked', stamp_id: 'XAI-0002', kind: 'FACE', seq: 1, marked: true, visibility: 'visible', sha256: 'd2', bytes: 1 },
  { id: 'img-d-sentinel', stamp_id: 'XAI-0003', kind: 'FACE', seq: 1, storage: 'bundled', visibility: 'visible', sha256: 'd3', bytes: 1 }
]
writeKey(STORAGE_KEYS.images, PROJECTION_IMAGES)

/* 面行：只改三枚印**首个 FACE 行**的 `face_image_id`（其余面行原样保留）。
   注：种子面行**没有 `face_no`**（`primaryFaceIn` 走「存储顺序第一个 FACE」的兜底分支）。 */
const faceRowsSeed = readKey(STORAGE_KEYS.faces) || []
const FACE_TARGETS = [
  { sealId: 'XAI-0001', imageId: 'img-d-unmarked' },
  { sealId: 'XAI-0002', imageId: 'img-d-marked' },
  { sealId: 'XAI-0003', imageId: 'img-d-sentinel' }
]
const repointed = new Set()
writeKey(
  STORAGE_KEYS.faces,
  faceRowsSeed.map((row) => {
    const seal = textOf(row.sealId || row.stamp_id)
    const target = FACE_TARGETS.find((item) => item.sealId === seal)
    if (!target || repointed.has(seal) || textOf(row.kind) === 'EDGE') return row
    repointed.add(seal)
    return { ...row, face_image_id: target.imageId }
  })
)

const NOW_ISO = '2026-11-17T00:00:00.000Z'
const EXPIRES_ISO = '2026-12-17T00:00:00.000Z'
writeKey(STORAGE_KEYS.seallists, [
  { id: 'sl-marked-1', code: 'SL000000901', owner_user_id: 'u-owner-1', name: '影像准入測試夾', created_at: NOW_ISO, updated_at: NOW_ISO }
])
writeKey(STORAGE_KEYS.seallistItems, [
  { id: 'it-m1', seallist_id: 'sl-marked-1', seal_id: 'XAI-0001', added_at: '2026-01-03T00:00:00.000Z' },
  { id: 'it-m2', seallist_id: 'sl-marked-1', seal_id: 'XAI-0002', added_at: '2026-01-02T00:00:00.000Z' },
  { id: 'it-m3', seallist_id: 'sl-marked-1', seal_id: 'XAI-0003', added_at: '2026-01-01T00:00:00.000Z' }
])
writeKey(STORAGE_KEYS.shares, [
  { id: 'sh-m1', seallist_id: 'sl-marked-1', code: 'mk123456', owner_user_id: 'u-owner-1', created_at: NOW_ISO, expires_at: EXPIRES_ISO, revoked_at: null }
])

const drive = await importSrc(DRIVE_REL)

session.setUser(null)
const guestProjection = drive.resolveShare('mk123456')
session.setUser({ id: 'u-plain-proj', role: 'user' })
const plainProjection = drive.resolveShare('mk123456')
session.setUser({ id: 'u-admin-proj', role: 'admin' })
const adminProjection = drive.resolveShare('mk123456')

const itemOf = (projection, sealId) =>
  (projection.visible_items || []).find((item) => textOf(item.seal_id) === sealId) || null
const imageIdOf = (projection, sealId) => textOf(itemOf(projection, sealId) && itemOf(projection, sealId).image_id)

check(
  'D1',
  '**游客投影零未标记影像**：未标记那张的 `image_id` 为空串、其 id 不出现在投影 JSON 里（同键同形状，不是少一项）',
  { guestImageId: '', guestHasId: false, plainImageId: '', plainHasId: false, itemCount: 3 },
  {
    guestImageId: imageIdOf(guestProjection, 'XAI-0001'),
    guestHasId: JSON.stringify(guestProjection).includes('img-d-unmarked'),
    plainImageId: imageIdOf(plainProjection, 'XAI-0001'),
    plainHasId: JSON.stringify(plainProjection).includes('img-d-unmarked'),
    itemCount: guestProjection.item_count
  }
)

check(
  'D2',
  '游客与登录非管理员**逐字一致**；已标记那张照常交出；管理员与两侧**相同**（准入与 `visibility` 同口径：管理员全取）',
  {
    guestEqualsPlain: true,
    guestMarkedImageId: 'img-d-marked',
    plainMarkedImageId: 'img-d-marked',
    adminUnmarkedImageId: 'img-d-unmarked'
  },
  {
    guestEqualsPlain: canon(guestProjection.visible_items) === canon(plainProjection.visible_items),
    guestMarkedImageId: imageIdOf(guestProjection, 'XAI-0002'),
    plainMarkedImageId: imageIdOf(plainProjection, 'XAI-0002'),
    adminUnmarkedImageId: imageIdOf(adminProjection, 'XAI-0001')
  }
)

check(
  'D3',
  '**哨兵影像不被摘**：面指向 `storage: \'bundled\'`、无 `marked` 键的行 ⇒ 游客投影仍交出该 id（兜底图不得消失）',
  { guestImageId: 'img-d-sentinel', plainImageId: 'img-d-sentinel' },
  { guestImageId: imageIdOf(guestProjection, 'XAI-0003'), plainImageId: imageIdOf(plainProjection, 'XAI-0003') }
)

/* ============================================================================
   E 两处**写面缺口**（9）：真实 `lib/ops.js` 的 `ADMIN_OPS.replaceFaceImage` ＋
   `OPS.registerCorrectionImage`，跑在**可写**内存假库上（set / update / delete 齐备）
   ----------------------------------------------------------------------------
   缺口（本单补）：两个 op 此前**都不写准入三键** ⇒ 换完图 / 提交完修正图，新行缺 `marked`
   ⇒ 读面按「缺键一律 `false`」口径**全站不可见**。
   口径（本单固化）：
     · 换图（管理员）：新行 `marked` ＝ **被替换行**的准入态（true→true / false→false /
       **无该键或行不存在 ⇒ false**）；`marked_by` / `marked_at` **继承保留原值**，未继承 ⇒ 空串；
       哨兵前身（`storage:'bundled'`）恒已标记；共用内容行**不得降级**（只增不减）。
     · 修正图（登录用户）：**恒 `false`** ＋ `marked_by:''`（用户提交件必须经审核）；
       共用内容行**已准入不得被撤回**（同上单向）。
     · 两者**都不得让客户端递** `marked` / `marked_by` / `marked_at`（递 ⇒ `INVALID_FIELD` 零写）。
   ============================================================================ */
section('E', '写面缺口：replaceFaceImage 继承 marked ＋ registerCorrectionImage 恒 false')

function makeWritableDb() {
  const store = new Map()
  const rowsOf = (name) => {
    if (!store.has(name)) store.set(name, [])
    return store.get(name)
  }
  const matches = (row, match) => Object.entries(match || {}).every(([key, value]) => row[key] === value)
  const collection = (name) => {
    const state = { where: {}, limit: 0 }
    const api = {
      where(match) {
        state.where = match || {}
        return api
      },
      limit(count) {
        state.limit = Number(count) || 0
        return api
      },
      skip() {
        return api
      },
      orderBy() {
        return api
      },
      doc(docId) {
        return {
          get: async () => ({ data: rowsOf(name).find((row) => row._id === docId || row.id === docId) || null }),
          set: async (doc) => {
            const rows = rowsOf(name)
            const at = rows.findIndex((row) => row._id === docId || row.id === docId)
            const next = { ...doc, _id: docId }
            if (at === -1) rows.push(next)
            else rows[at] = next
            return { updated: 1 }
          },
          delete: async () => {
            const rows = rowsOf(name)
            const at = rows.findIndex((row) => row._id === docId || row.id === docId)
            if (at !== -1) rows.splice(at, 1)
            return { deleted: at === -1 ? 0 : 1 }
          }
        }
      },
      add: async (doc) => {
        rowsOf(name).push({ ...doc })
        return { id: doc._id || doc.id }
      },
      async get() {
        let hits = rowsOf(name).filter((row) => matches(row, state.where))
        if (state.limit > 0) hits = hits.slice(0, state.limit)
        return { data: hits }
      },
      async update(doc) {
        const hits = rowsOf(name).filter((row) => matches(row, state.where))
        hits.forEach((row) => Object.assign(row, doc))
        return { updated: hits.length }
      }
    }
    return api
  }
  return { db: { collection }, rowsOf }
}

const IMAGES_COLLECTION = 'xiai_images'
const FACES_COLLECTION = 'xiai_faces'
const CORRECTION_IDENTITY = { uid: 'u-plain-correction-1', phone: '13900000001', role: 'user' }

/** 造一个「被替换行 + 面行指向它」的场景，返回假库与调用器。 */
function replacedScene(previousRow) {
  const fake = makeWritableDb()
  ops.setOpsDbProvider(() => fake.db)
  if (previousRow) fake.rowsOf(IMAGES_COLLECTION).push({ ...previousRow })
  fake.rowsOf(FACES_COLLECTION).push({
    _id: 'fc-e-scene',
    id: 'fc-e-scene',
    sealId: 'XA-E1',
    stamp_id: 'XA-E1',
    kind: 'FACE',
    face_image_id: previousRow ? previousRow.id : ''
  })
  return fake
}

/** 换图载荷（摘要 / 字节 / 存储键三者自洽；`kind` 缺省 `FACE`）。 */
const replacePayloadOf = (letter, sealId) => {
  const digest = letter.repeat(64)
  return {
    face_id: 'fc-e-scene',
    seal_id: sealId || 'XA-E1',
    sha256: digest,
    mime: 'image/tiff',
    storage_key: `xiai/images/${digest.slice(0, 2)}/${digest}.tiff`,
    bytes: 20480
  }
}
const imageRowOf = (fake, imageId) => fake.rowsOf(IMAGES_COLLECTION).find((row) => row.id === imageId) || null
const faceImageIdOf = (fake) => textOf((fake.rowsOf(FACES_COLLECTION)[0] || {}).face_image_id)

/* E1：**已标记 → 已标记**（继承准入态，by/at 原值照抄）。 */
const e1 = replacedScene({
  _id: 'img-prev-marked',
  id: 'img-prev-marked',
  stamp_id: 'XA-E1',
  kind: 'FACE',
  seq: 1,
  storage: 'server',
  marked: true,
  marked_by: 'u-admin-orig',
  marked_at: '2026-11-01T02:03:04.000Z'
})
const e1Reply = await ops.ADMIN_OPS.replaceFaceImage(replacePayloadOf('c'), ADMIN_IDENTITY, ADMIN_CONTEXT)
const e1Row = e1Reply.ok === true ? imageRowOf(e1, e1Reply.image_id) : null
const e1FaceStillOnNew = faceImageIdOf(e1) === textOf(e1Reply.image_id)

check(
  'E1',
  '换图 **true → true**：新影像行 `marked:true`、`marked_by` / `marked_at` **照抄被替换行**（准入态随图继承）；面行指向已换新',
  { ok: true, marked: true, markedBy: 'u-admin-orig', markedAt: '2026-11-01T02:03:04.000Z', faceRepointed: true },
  {
    ok: e1Reply.ok === true,
    marked: e1Row ? e1Row.marked : 'MISSING',
    markedBy: e1Row ? textOf(e1Row.marked_by) : 'MISSING',
    markedAt: e1Row ? textOf(e1Row.marked_at) : 'MISSING',
    faceRepointed: e1FaceStillOnNew
  }
)

/* E2：**未标记 → 未标记**（false→false，by/at 空串）。 */
const e2 = replacedScene({
  _id: 'img-prev-unmarked',
  id: 'img-prev-unmarked',
  stamp_id: 'XA-E1',
  kind: 'FACE',
  seq: 1,
  storage: 'server',
  marked: false
})
const e2Reply = await ops.ADMIN_OPS.replaceFaceImage(replacePayloadOf('d'), ADMIN_IDENTITY, ADMIN_CONTEXT)
const e2Row = e2Reply.ok === true ? imageRowOf(e2, e2Reply.image_id) : null

check(
  'E2',
  '换图 **false → false**：新影像行 `marked:false` ＋ by/at 空串（不因管理员操作自动准入）',
  { ok: true, marked: false, markedBy: '', markedAt: '', hasMarked: true },
  {
    ok: e2Reply.ok === true,
    marked: e2Row ? e2Row.marked : 'MISSING',
    markedBy: e2Row ? textOf(e2Row.marked_by) : 'MISSING',
    markedAt: e2Row ? textOf(e2Row.marked_at) : 'MISSING',
    hasMarked: e2Row ? Object.prototype.hasOwnProperty.call(e2Row, 'marked') : false
  }
)

/* E3：**无 `marked` 键**（旧行）→ false。 */
const e3 = replacedScene({
  _id: 'img-prev-keyless',
  id: 'img-prev-keyless',
  stamp_id: 'XA-E1',
  kind: 'FACE',
  seq: 1,
  storage: 'server'
})
const e3Reply = await ops.ADMIN_OPS.replaceFaceImage(replacePayloadOf('e'), ADMIN_IDENTITY, ADMIN_CONTEXT)
const e3Row = e3Reply.ok === true ? imageRowOf(e3, e3Reply.image_id) : null

check(
  'E3',
  '换图 **无键 → false**：被替换行缺 `marked`（旧行那一态）⇒ 新行落 `false`（缺键不等于已标记）',
  { ok: true, marked: false, beforeKeyless: true },
  {
    ok: e3Reply.ok === true,
    marked: e3Row ? e3Row.marked : 'MISSING',
    beforeKeyless: !Object.prototype.hasOwnProperty.call(e3.rowsOf(IMAGES_COLLECTION)[0], 'marked')
  }
)

/* E3b：**被替换行不存在**（面行 `face_image_id` 指向已删行）⇒ false。 */
const e3b = makeWritableDb()
ops.setOpsDbProvider(() => e3b.db)
e3b.rowsOf(FACES_COLLECTION).push({ _id: 'fc-e3b', id: 'fc-e3b', stamp_id: 'XA-E3B', kind: 'FACE', face_image_id: 'img-gone' })
const e3bReply = await ops.ADMIN_OPS.replaceFaceImage(
  { ...replacePayloadOf('f'), face_id: 'fc-e3b', seal_id: 'XA-E3B' },
  ADMIN_IDENTITY,
  ADMIN_CONTEXT
)
const e3bRow = e3bReply.ok === true ? imageRowOf(e3b, e3bReply.image_id) : null

check(
  'E3b',
  '换图 **行不存在 → false**：面行指向的旧影像行已查不到 ⇒ 新行 `marked:false`（不据此判「已标记」）',
  { ok: true, marked: false, previousImageId: 'img-gone' },
  {
    ok: e3bReply.ok === true,
    marked: e3bRow ? e3bRow.marked : 'MISSING',
    previousImageId: textOf(e3bReply.previous_image_id)
  }
)

/* E4：**哨兵前身**（随包占位图、无 `marked`）换图 ⇒ 新图仍已标记（兜底图不得因换图消失）。 */
const e4 = replacedScene({
  _id: 'img-placeholder-seal-no-image',
  id: 'img-placeholder-seal-no-image',
  stamp_id: 'XA-E1',
  kind: 'FACE',
  seq: 1,
  storage: 'bundled'
})
const e4Reply = await ops.ADMIN_OPS.replaceFaceImage(replacePayloadOf('a'), ADMIN_IDENTITY, ADMIN_CONTEXT)
const e4Row = e4Reply.ok === true ? imageRowOf(e4, e4Reply.image_id) : null

check(
  'E4',
  '换图 **哨兵前身（`storage:\'bundled\'`、无 `marked`）⇒ 已标记**：随包兜底图不得因换图而消失',
  { ok: true, marked: true, markedBy: '' },
  { ok: e4Reply.ok === true, marked: e4Row ? e4Row.marked : 'MISSING', markedBy: e4Row ? textOf(e4Row.marked_by) : 'MISSING' }
)

/* E5：**共用内容行不得降级** —— 同一张图已被别的印面引用且已准入。 */
const e5 = replacedScene({
  _id: 'img-prev-unmarked-2',
  id: 'img-prev-unmarked-2',
  stamp_id: 'XA-E1',
  kind: 'FACE',
  seq: 1,
  storage: 'server',
  marked: false
})
const e5Payload = replacePayloadOf('b')
/* 先按「别处已入册且已标记」放一行同内容行（内容寻址 ⇒ 同 `id`；`img-` ＋ 摘要前 16 位）。 */
e5.rowsOf(IMAGES_COLLECTION).push({
  _id: 'img-bbbbbbbbbbbbbbbb',
  id: 'img-bbbbbbbbbbbbbbbb',
  stamp_id: 'XA-OTHER',
  kind: 'FACE',
  seq: 1,
  storage: 'server',
  marked: true,
  marked_by: 'u-admin-other',
  marked_at: '2026-11-02T00:00:00.000Z',
  sha256: e5Payload.sha256
})
const e5Reply = await ops.ADMIN_OPS.replaceFaceImage(e5Payload, ADMIN_IDENTITY, ADMIN_CONTEXT)

check(
  'E5',
  '**共用内容行不得降级**：同 `id` 行已被别的印面准入 ⇒ 换图覆写后仍 `marked:true` / 原 by·at（闸门只增不减）',
  { ok: true, marked: true, markedBy: 'u-admin-other' },
  (() => {
    const hit = e5.rowsOf(IMAGES_COLLECTION).find((row) => row.id === textOf(e5Reply.image_id)) || {}
    return { ok: e5Reply.ok === true, marked: hit.marked, markedBy: textOf(hit.marked_by) }
  })()
)

/* E6：**客户端不得递准入键** —— 换图载荷带 `marked` ⇒ `INVALID_FIELD` ＋ 零写。 */
const e6 = replacedScene({
  _id: 'img-prev-unmarked-3',
  id: 'img-prev-unmarked-3',
  stamp_id: 'XA-E1',
  kind: 'FACE',
  seq: 1,
  storage: 'server',
  marked: false
})
const e6Before = canon(e6.rowsOf(IMAGES_COLLECTION))
const e6Reply = await ops.ADMIN_OPS.replaceFaceImage(
  { ...replacePayloadOf('1'), marked: true },
  ADMIN_IDENTITY,
  ADMIN_CONTEXT
)
const e6ByReply = await ops.ADMIN_OPS.replaceFaceImage(
  { ...replacePayloadOf('1'), marked_by: 'u-attacker' },
  ADMIN_IDENTITY,
  ADMIN_CONTEXT
)

check(
  'E6',
  '换图：客户端递 `marked` / `marked_by` ⇒ `INVALID_FIELD` ＋ **零写入**（准入只能由服务端从被替换行继承）',
  {
    markedDenied: true,
    markedReason: 'INVALID_FIELD',
    byDenied: true,
    byReason: 'INVALID_FIELD',
    imagesUnchanged: true,
    faceUnchanged: true
  },
  {
    markedDenied: e6Reply.ok === false,
    markedReason: textOf(e6Reply.reason),
    byDenied: e6ByReply.ok === false,
    byReason: textOf(e6ByReply.reason),
    imagesUnchanged: canon(e6.rowsOf(IMAGES_COLLECTION)) === e6Before,
    faceUnchanged: faceImageIdOf(e6) === 'img-prev-unmarked-3'
  }
)

/* E7 / E8：修正图（登录用户提交）—— **恒 false** ＋ 客户端不得递准入键。 */
const CORRECTION_DIGEST = '9'.repeat(64)
const CORRECTION_PAYLOAD = {
  sha256: CORRECTION_DIGEST,
  mime: 'image/tiff',
  storage_key: `xiai/images/99/${CORRECTION_DIGEST}.tiff`,
  bytes: 30720,
  seal_id: 'XA-E7'
}

const e7 = makeWritableDb()
ops.setOpsDbProvider(() => e7.db)
const e7Reply = await ops.OPS.registerCorrectionImage({ ...CORRECTION_PAYLOAD }, CORRECTION_IDENTITY)
const e7Row = e7Reply.ok === true && e7Reply.plan ? e7Reply.plan.writes[0].doc : null

check(
  'E7',
  '修正图**恒 `false`**：登录用户提交的新图入册 ⇒ `marked:false` ＋ `marked_by:""` / `marked_at:""`（必须经审核，不得自动准入）',
  { ok: true, marked: false, markedBy: '', markedAt: '', hasMarked: true, writeKind: 'set' },
  {
    ok: e7Reply.ok === true,
    marked: e7Row ? e7Row.marked : 'MISSING',
    markedBy: e7Row ? textOf(e7Row.marked_by) : 'MISSING',
    markedAt: e7Row ? textOf(e7Row.marked_at) : 'MISSING',
    hasMarked: e7Row ? Object.prototype.hasOwnProperty.call(e7Row, 'marked') : false,
    writeKind: e7Reply.plan && e7Reply.plan.writes[0] ? e7Reply.plan.writes[0].kind : ''
  }
)

const e8 = makeWritableDb()
ops.setOpsDbProvider(() => e8.db)
const e8Replies = []
for (const extra of [{ marked: true }, { marked_by: 'u-attacker' }, { marked_at: '1999-01-01T00:00:00.000Z' }]) {
  e8Replies.push(await ops.OPS.registerCorrectionImage({ ...CORRECTION_PAYLOAD, ...extra }, CORRECTION_IDENTITY))
}

check(
  'E8',
  '修正图：客户端递 `marked` / `marked_by` / `marked_at` ⇒ 每条 `INVALID_FIELD` ＋ **零写入**（回包恰 3 键、无 `plan`）',
  {
    count: 3,
    reasons: ['INVALID_FIELD', 'INVALID_FIELD', 'INVALID_FIELD'],
    plans: [false, false, false],
    keySets: [['message', 'ok', 'reason'], ['message', 'ok', 'reason'], ['message', 'ok', 'reason']]
  },
  {
    count: e8Replies.length,
    reasons: e8Replies.map((reply) => textOf(reply && reply.reason)),
    plans: e8Replies.map((reply) => Object.prototype.hasOwnProperty.call(reply || {}, 'plan')),
    keySets: e8Replies.map((reply) => Object.keys(reply || {}).sort())
  }
)

/* E9：**修正图不得撤回既有准入** —— 同内容行已被管理员标记 ⇒ 覆写保持 `true`（闸门单向下行同口径）。 */
const e9 = makeWritableDb()
ops.setOpsDbProvider(() => e9.db)
e9.rowsOf(IMAGES_COLLECTION).push({
  _id: 'img-9999999999999999',
  id: 'img-9999999999999999',
  stamp_id: 'XA-E9',
  kind: 'FACE',
  seq: 1,
  storage: 'server',
  marked: true,
  marked_by: 'u-admin-review',
  marked_at: '2026-11-03T00:00:00.000Z',
  sha256: CORRECTION_DIGEST
})
const e9Reply = await ops.OPS.registerCorrectionImage({ ...CORRECTION_PAYLOAD, seal_id: 'XA-E9' }, CORRECTION_IDENTITY)
const e9Row = e9Reply.ok === true && e9Reply.plan ? e9Reply.plan.writes[0].doc : null

check(
  'E9',
  '修正图**不得撤回既有准入**：同 `id` 行已被管理员标记 ⇒ 用户提交覆写保持 `marked:true` / 原 by·at（撤销只走 `registerFaceImage`）',
  { ok: true, marked: true, markedBy: 'u-admin-review' },
  { ok: e9Reply.ok === true, marked: e9Row ? e9Row.marked : 'MISSING', markedBy: e9Row ? textOf(e9Row.marked_by) : 'MISSING' }
)

/* ---------------------------------------------------------------- 收尾 */
session.setUser(null)

const total = results.length
const failedIds = results.filter((item) => !item.pass).map((item) => item.id)
console.log(
  JSON.stringify({
    summary: { total, passed: total - failedIds.length, failed: failedIds.length },
    sections: sectionStats,
    failed_ids: failedIds,
    note:
      '全离线：localStorage 用内存 Map 桩（云状态 off，零联网零 SDK）＋ 写面经 setOpsDbProvider 注入内存假库跑真实 ' +
      'lib/ops.js::ADMIN_OPS.registerFaceImage / replaceFaceImage ＋ OPS.registerCorrectionImage；' +
      '零真实数据读写、零部署、零 git 操作。'
  })
)
process.exit(Math.min(failedIds.length, 255))
