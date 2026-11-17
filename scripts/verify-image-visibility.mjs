#!/usr/bin/env node
/**
 * 玺爱 · **影像可见性（`xiai_images.visibility`）** 离线自检套
 * ============================================================================
 * 被测实现（上一单已落盘，本单只补测试、不改逻辑）：
 *   · `cloudfunctions/xiai-user-token/lib/ops.js`
 *       —— 白名单 `FACE_IMAGE_REGISTER_ALLOWED_KEYS`（7 → 8，只加 `visibility`）＋
 *          值域门 `imageVisibilityOf`（封闭二值、非法值 `INVALID_VALUE` ＋ 零写入）＋
 *          `registerFaceImage` 落行恒带该键（缺省 `visible`）；
 *   · `src/data/cloudbase.js`
 *       —— `imageVisibilityOf` / `isHiddenImageRow` / `filterImageRowsForViewer`（读面单点）；
 *   · `src/data/db.js`
 *       —— `listImageRows` 交出前按角色过滤 ＋ `isImageRowHidden`（投影侧判据，不吃读面过滤）；
 *   · `src/services/drive.js`
 *       —— `resolveShare` 投影里零 `hidden` 影像行（非管理员拿到的 `image_id` 为空串）。
 *
 * 判据口径（照本仓既有套件）：
 *   · **零联网、零 SDK、零真库**：`localStorage` 用内存 `Map` 桩撑起（`window.localStorage`
 *     同形），生产云模式不接管（未配置 `VITE_XIAI_CB_ENV_ID` ⇒ 云状态 `off`）；
 *   · 写面（C）用 `setOpsDbProvider` 注入**内存假库**（只实现 `collection().where/limit/get`），
 *     跑的是真实 `lib/ops.js` 的 `ADMIN_OPS.registerFaceImage`；
 *   · **每条判据可判负**：期望值与实读数逐条 `canon` 比对，任一不等 ⇒ 该条红、退出码计数；
 *   · **零副作用**：只写内存桩，不碰磁盘上的任何数据文件、不写云端、不动 git。
 *
 * 分段：
 *   A 纯函数（7）：`hidden` / `visible` / **缺键** / `null` 四态 ＋ 表外值（`'HIDDEN'` 大写、
 *     `'secret'`、非字符串）＋ 空行。**判定口径写死**：读面**只有逐字 `'hidden'` 才藏**；
 *     缺键、`null`、表外值一律**当 `visible`**（不是拒绝、不是抛错）——「宁可露出也不能凭空少一张」。
 *   B 读面（7）：非管理员不返回 `hidden`；管理员全返回；缺键旧行不消失；组内「无 visible 但有
 *     hidden」⇒ 自动提升序号最小的一张为 `visible` 且**原行不就地改写**；`isImageRowHidden`
 *     四态（不吃读面过滤）；**准入门两条（2026-11-17 `marked` 口径）：未标记行对非管理员
 *     不可见 / 标记后即可见**。
 *   C 写面（4）：未传 `visibility` 默认 `visible`；非法值 ⇒ `INVALID_VALUE` 零写入；`hidden`
 *     能写进；白名单**只**多这一个键（静态 9 键〔含 `marked`，2026-11-17 准入裁定 8 → 9〕＋
 *     未登记键仍 `INVALID_FIELD`）。
 *   D 分享投影（2）：投影里零 `hidden` 行；游客与登录非管理员集合一致、管理员不同。
 *
 * **本套的适配（2026-11-17，**不改被测逻辑**）**：读面自准入裁定起会**先按 `marked` 裁掉未标记
 * 行**再按 `visibility` 过滤 ⇒ B 段基线不能再取 `listImageRows()`（非管理员视图恒 0 行），
 * 改由 `readKey(STORAGE_KEYS.images)` 取**未过滤集合**，并在造数时给种子行补 `marked: true`
 * （＝既有种子影像「已回填」口径）。断言强度只增不减：另补 B6 / B7 两条准入断言。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const require_ = createRequire(import.meta.url)

const CF_REL = 'cloudfunctions/xiai-user-token'
const OPS_REL = `${CF_REL}/lib/ops.js`

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
   A 纯函数（7）：四态 ＋ 表外值 ＋ 空行
   ----------------------------------------------------------------------------
   **判定口径（写死在这里）**：读面只认**逐字** `'hidden'`；其余一切（缺键 / `null` /
   大写 `'HIDDEN'` / `'secret'` / 数字）**一律当 `visible`** —— 读面**不拒收、不抛错**
   （拒收是写面 C 段的事：那边非法值 `INVALID_VALUE` ＋ 零写入）。
   ============================================================================ */
section('A', '纯函数：isHiddenImageRow / imageVisibilityOf 四态 ＋ 表外值')

const cloudbase = await importSrc('src/data/cloudbase.js')
const { isHiddenImageRow, imageVisibilityOf, filterImageRowsForViewer } = cloudbase

check(
  'A1',
  '`visibility: hidden` ⇒ 判 `hidden`（唯一能藏的那一个字面）',
  { hidden: true, normalized: 'hidden' },
  (() => {
    const row = { id: 'r1', visibility: 'hidden' }
    return { hidden: isHiddenImageRow(row), normalized: imageVisibilityOf(row) }
  })()
)

check(
  'A2',
  '`visibility: visible` ⇒ 判 `visible`（不藏）',
  { hidden: false, normalized: 'visible' },
  (() => {
    const row = { id: 'r2', visibility: 'visible' }
    return { hidden: isHiddenImageRow(row), normalized: imageVisibilityOf(row) }
  })()
)

check(
  'A3',
  '**缺键**（旧行：`visibility` 键尚未写入）⇒ 当 `visible`（不藏、不消失）',
  { hasKey: false, hidden: false, normalized: 'visible' },
  (() => {
    const row = { id: 'r3', stamp_id: 'XAI-0001', kind: 'FACE' }
    return {
      hasKey: Object.prototype.hasOwnProperty.call(row, 'visibility'),
      hidden: isHiddenImageRow(row),
      normalized: imageVisibilityOf(row)
    }
  })()
)

check(
  'A4',
  '`visibility: null` ⇒ 当 `visible`（不藏）',
  { hidden: false, normalized: 'visible' },
  (() => {
    const row = { id: 'r4', visibility: null }
    return { hidden: isHiddenImageRow(row), normalized: imageVisibilityOf(row) }
  })()
)

check(
  'A5',
  '非法值 `\'HIDDEN\'`（大写）⇒ **当 `visible`、不拒收**（读面只有逐字小写 `hidden` 才藏）',
  { hidden: false, normalized: 'visible' },
  (() => {
    const row = { id: 'r5', visibility: 'HIDDEN' }
    return { hidden: isHiddenImageRow(row), normalized: imageVisibilityOf(row) }
  })()
)

check(
  'A6',
  '表外字号 / 非字符串（`\'secret\'`、`1`、`{}`）⇒ 一律当 `visible`、零抛错',
  { secretHidden: false, secretNormalized: 'visible', numberHidden: false, objectHidden: false },
  {
    secretHidden: isHiddenImageRow({ visibility: 'secret' }),
    secretNormalized: imageVisibilityOf({ visibility: 'secret' }),
    numberHidden: isHiddenImageRow({ visibility: 1 }),
    objectHidden: isHiddenImageRow({ visibility: {} })
  }
)

check(
  'A7',
  '空行（`null` / `undefined` / 无参）⇒ 判 `visible`、零抛错（防御性：读面不因脏行崩）',
  { nullHidden: false, undefinedHidden: false, noArgHidden: false, nullNormalized: 'visible' },
  {
    nullHidden: isHiddenImageRow(null),
    undefinedHidden: isHiddenImageRow(undefined),
    noArgHidden: isHiddenImageRow(),
    nullNormalized: imageVisibilityOf(null)
  }
)

/* ============================================================================
   B 读面（5）：真实 `listImageRows()` ＋ 真实本机镜像（内存桩）
   ----------------------------------------------------------------------------
   种子（`ensureSeed()`）先跑一次拿到 13 行影像；随后**只用 `writeKey`** 改 `visibility`
   （写盘即递增存储代数 ⇒ 读缓存按既有判据自然失效，不额外开洞）。
   ============================================================================ */
section('B', '读面：listImageRows 按角色过滤 ＋ 组内提升 ＋ 原行不改写')

const session = await importSrc('src/data/session.js')
const storage = await importSrc('src/data/storage.js')
const db = await importSrc('src/data/db.js')
const { writeKey, readKey, STORAGE_KEYS } = storage

/* 首读触发种子（全新安装 ⇒ 整套种子一次写入）。 */
db.listImageRows()

/* **基线改由未过滤集合取**（2026-11-17 准入裁定后）：`listImageRows()` 对非管理员**先按
   `marked` 裁掉未标记行**，而种子影像行都没有 `marked` 键 ⇒ 用它当基线会读成 0 行（B1/B2/B3
   恒红的真因）。种子有几行只由**落盘集合**决定 ⇒ 直读 `readKey`。 */
const SEED_ROWS = readKey(STORAGE_KEYS.images) || []
/* 造数：种子行补 `marked: true`（＝既有种子影像「已回填」口径；生产同口径见
   `scripts/backfill-image-marked.mjs`）。**只补这一键**，`visibility` 一律不碰 —— B 段判的
   仍然是 `visibility`，准入由 B6 / B7 单独判。 */
writeKey(
  STORAGE_KEYS.images,
  SEED_ROWS.map((row) => ({ ...row, marked: true }))
)
const SEED_COUNT = SEED_ROWS.length

/** 把指定 id 的行改成 `hidden`（其余行一字不动）。 */
function hideImages(ids) {
  const rows = readKey(STORAGE_KEYS.images)
  const wanted = new Set(ids)
  writeKey(
    STORAGE_KEYS.images,
    rows.map((row) => (wanted.has(row.id) ? { ...row, visibility: 'hidden' } : row))
  )
}

const idsOf = (rows) => rows.map((row) => row.id).sort()
const rowById = (rows, id) => rows.find((row) => row.id === id) || null

/* B1 / B2 / B3 同一批数据：只藏 `img-0001g`（同组 `XAI-0001|FACE` 里 `img-0001f` 仍 visible）。 */
hideImages(['img-0001g'])

session.setUser({ id: 'u-plain-1', role: 'user' })
const guestRows = db.listImageRows()

check(
  'B1',
  '非管理员：`hidden` 行**不返回**（`img-0001g` 缺席，同组另一张仍在）',
  { hasHidden: false, hasSibling: true, count: SEED_COUNT - 1 },
  { hasHidden: idsOf(guestRows).includes('img-0001g'), hasSibling: idsOf(guestRows).includes('img-0001f'), count: guestRows.length }
)

session.setUser({ id: 'u-admin-1', role: 'admin' })
const adminRows = db.listImageRows()

check(
  'B2',
  '管理员：`hidden` 行**照旧全取**（`img-0001g` 在，且 `visibility` 逐字 `hidden`）',
  { hasHidden: true, visibility: 'hidden', count: SEED_COUNT },
  { hasHidden: idsOf(adminRows).includes('img-0001g'), visibility: textOf(rowById(adminRows, 'img-0001g').visibility), count: adminRows.length }
)

session.setUser({ id: 'u-plain-1', role: 'user' })
const plainAgain = db.listImageRows()
const missingKeyCount = plainAgain.filter(
  (row) => !Object.prototype.hasOwnProperty.call(row, 'visibility') || textOf(row.visibility) === ''
).length

check(
  'B3',
  '**缺键旧行不消失**：非管理员读数恰 ＝ 种子数 − 1（只少了那 1 张 hidden；缺键行零丢失）',
  { count: SEED_COUNT - 1, lossVsSeed: 1, missingKeyRowsKept: SEED_COUNT - 1 },
  { count: plainAgain.length, lossVsSeed: SEED_COUNT - plainAgain.length, missingKeyRowsKept: missingKeyCount }
)

check(
  'B5',
  '`isImageRowHidden`（投影侧判据，**不吃读面过滤**）四态：hidden⇒true / visible⇒false / 未知 id⇒false / 空串⇒false',
  { hidden: true, visible: false, unknownId: false, empty: false },
  {
    hidden: db.isImageRowHidden('img-0001g'),
    visible: db.isImageRowHidden('img-0001f'),
    unknownId: db.isImageRowHidden('img-does-not-exist'),
    empty: db.isImageRowHidden('')
  }
)

/* B4 提升：把 `XAI-0001|FACE` 组内两张**全藏** ⇒ 非管理员仍须看到恰 1 张（序号最小），
   且**落盘原行一字未改**（交出的只是副本）。 */
hideImages(['img-0001f', 'img-0001g'])
session.setUser({ id: 'u-plain-1', role: 'user' })
const storageBefore = canon(readKey(STORAGE_KEYS.images))
const promotedRows = db.listImageRows()
const promotedStorage = canon(readKey(STORAGE_KEYS.images))
const groupHits = promotedRows.filter(
  (row) => textOf(row.stamp_id) === 'XAI-0001' && (textOf(row.kind) === 'EDGE' ? 'EDGE' : 'FACE') === 'FACE'
)

check(
  'B4',
  '组内「无 visible 但有 hidden」⇒ 自动提升序号最小的一张（`img-0001f`）为 `visible`；落盘原行**零改写**',
  { groupSize: 1, id: 'img-0001f', visibility: 'visible', storageUnchanged: true },
  {
    groupSize: groupHits.length,
    id: groupHits.length === 1 ? textOf(groupHits[0].id) : groupHits.map((row) => row.id).join(','),
    visibility: groupHits.length === 1 ? textOf(groupHits[0].visibility) : '',
    storageUnchanged: storageBefore === promotedStorage
  }
)

/* B6 / B7：**准入门本身的两条断言**（2026-11-17 `marked` 口径）——
   ① 未标记行对非管理员不可见；② 标记后即可见（同一行、只翻 `marked` 一个键）。 */
const patchImages = (ids, patch) => {
  const rows = readKey(STORAGE_KEYS.images)
  const wanted = new Set(ids)
  writeKey(
    STORAGE_KEYS.images,
    rows.map((row) => (wanted.has(row.id) ? { ...row, ...patch } : row))
  )
}

/* 造数：同组两张都 `visible`、都**未标记**（B4 把两张都藏了 ⇒ 先复位展示形态）。 */
patchImages(['img-0001f', 'img-0001g'], { visibility: 'visible', marked: false })
session.setUser({ id: 'u-plain-1', role: 'user' })
const unmarkedPlain = db.listImageRows()
session.setUser({ id: 'u-admin-1', role: 'admin' })
const unmarkedAdmin = db.listImageRows()

check(
  'B6',
  '**未标记行对非管理员不可见**：同组两张都 `visible` 且都 `marked:false` ⇒ 非管理员 0 张（不是「提升成可显示」）；管理员照旧 2 张',
  { plainGroupSize: 0, adminGroupSize: 2, plainTotal: SEED_COUNT - 2, adminTotal: SEED_COUNT },
  {
    plainGroupSize: unmarkedPlain.filter((row) => textOf(row.stamp_id) === 'XAI-0001' && textOf(row.kind) !== 'EDGE').length,
    adminGroupSize: unmarkedAdmin.filter((row) => textOf(row.stamp_id) === 'XAI-0001' && textOf(row.kind) !== 'EDGE').length,
    plainTotal: unmarkedPlain.length,
    adminTotal: unmarkedAdmin.length
  }
)

/* 只把 `img-0001f` 标上（`img-0001g` 仍未标记），其他一字不动。 */
patchImages(['img-0001f'], { marked: true })
session.setUser({ id: 'u-plain-1', role: 'user' })
const markedPlain = db.listImageRows()
const markedIds = idsOf(markedPlain)
const storedMarked = textOf((rowById(readKey(STORAGE_KEYS.images), 'img-0001f') || {}).marked)

check(
  'B7',
  '**标记后即可见**：只把 `img-0001f` 的 `marked` 改 `true` ⇒ 非管理员立刻看到那张；同组未标记的 `img-0001g` 仍不可见（准入按行判、不按组）',
  {
    newRowVisible: true,
    siblingStillHidden: false,
    plainTotal: SEED_COUNT - 1,
    storedMarked: 'true'
  },
  {
    newRowVisible: markedIds.includes('img-0001f'),
    siblingStillHidden: markedIds.includes('img-0001g'),
    plainTotal: markedPlain.length,
    storedMarked
  }
)

/* ============================================================================
   C 写面（4）：真实 `lib/ops.js::ADMIN_OPS.registerFaceImage` ＋ 内存假库
   ----------------------------------------------------------------------------
   假库只实现远端读链（`collection(name).where(match).limit(n).get()` ⇒ `{data: rows}`）：
   本 op 的可见性门**判在任何读之前** ⇒ 非法值那条零读零写；合法值那条拿到 `plan`（落盘计划）。
   ============================================================================ */
section('C', '写面：registerFaceImage 白名单 ＋ 值域门 ＋ 落行')

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

const ADMIN_IDENTITY = { uid: 'u-admin-1', phone: '13800000000', role: 'admin' }
const ADMIN_CONTEXT = { adminPhone: '13800000000' }
const DIGEST = 'a'.repeat(64)
const BASE_PAYLOAD = Object.freeze({
  seal_id: 'XAI-0001',
  face_id: 'fc-0001-f1',
  sha256: DIGEST,
  mime: 'image/tiff',
  storage_key: `xiai/images/aa/${DIGEST}.tiff`,
  bytes: 12345,
  kind: 'FACE'
})

const register = (payload) => ops.ADMIN_OPS.registerFaceImage(payload, ADMIN_IDENTITY, ADMIN_CONTEXT)
/** 从成功回包里取「实际要落盘的那一行」（`plan` 是内部面，`index.js` 不外传）。 */
const plannedRow = (reply) =>
  reply && reply.plan && reply.plan.writes && reply.plan.writes[0] ? reply.plan.writes[0].doc : null

const defaultReply = await register({ ...BASE_PAYLOAD })
const defaultRow = plannedRow(defaultReply)

check(
  'C1',
  '未传 `visibility` ⇒ 落行**恒带该键**且值 `visible`（不落空串、不落 `null`）',
  { ok: true, visibility: 'visible', hasKey: true },
  {
    ok: defaultReply.ok === true,
    visibility: defaultRow ? defaultRow.visibility : '',
    hasKey: defaultRow ? Object.prototype.hasOwnProperty.call(defaultRow, 'visibility') : false
  }
)

const badReply = await register({ ...BASE_PAYLOAD, visibility: 'HIDDEN' })

check(
  'C2',
  '非法值 `\'HIDDEN\'`（大写）⇒ `INVALID_VALUE` ＋ **零写入**（无 `plan`、回包恰 3 键）',
  { denied: true, reason: 'INVALID_VALUE', hasPlan: false, keys: ['message', 'ok', 'reason'] },
  {
    denied: badReply.ok === false,
    reason: textOf(badReply.reason),
    hasPlan: Object.prototype.hasOwnProperty.call(badReply, 'plan'),
    keys: Object.keys(badReply).sort()
  }
)

const hiddenReply = await register({ ...BASE_PAYLOAD, visibility: 'hidden' })
const hiddenRow = plannedRow(hiddenReply)

check(
  'C3',
  '`hidden` 能写进：落行 `visibility` 逐字 `hidden`（同 `id` 覆写计划，不建第二行）',
  { ok: true, visibility: 'hidden', writeKind: 'set', writes: 1 },
  {
    ok: hiddenReply.ok === true,
    visibility: hiddenRow ? hiddenRow.visibility : '',
    writeKind: hiddenReply.plan && hiddenReply.plan.writes[0] ? hiddenReply.plan.writes[0].kind : '',
    writes: hiddenReply.plan && Array.isArray(hiddenReply.plan.writes) ? hiddenReply.plan.writes.length : 0
  }
)

/* C4：白名单**只**多这一键 —— 静态（源码字面恰 9 键、含 `visibility` **与** `marked`
   〔2026-11-17 准入裁定 8 → 9〕）＋ 行为（未登记键仍拒）。 */
const opsSource = fs.readFileSync(path.join(ROOT, OPS_REL), 'utf8')
const allowBlock = /const FACE_IMAGE_REGISTER_ALLOWED_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(opsSource)
const staticKeys = allowBlock ? Array.from(allowBlock[1].matchAll(/'([^']+)'/g)).map((m) => m[1]).sort() : []
const extraKeyReply = await register({ ...BASE_PAYLOAD, book_id: '00001' })

check(
  'C4',
  '服务端白名单**只**多 `visibility` ＋ `marked` 两键：静态恰 9 键（其余 7 键一字未动；`marked_by`/`marked_at` 不在内）＋ 未登记键（`book_id`）仍 `INVALID_FIELD` 零写入',
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

/* ============================================================================
   D 分享投影（2）：真实 `resolveShare(code)`（横幅档 ≤ 3 项 ⇒ 游客与登录非管理员同集合）
   ----------------------------------------------------------------------------
   造数：一枚印（`XAI-0001`）的主面指向**被藏**的 `img-0001f`（同组 `img-0001g` 仍 visible
   ⇒ 不触发读面提升），另两枚正常；资料夹恰 3 项（＝游客预览上限）⇒ 两侧可比同一集合。
   ============================================================================ */
section('D', '分享投影：resolveShare 零 hidden 行 ＋ 游客／非管理员／管理员三态')

const HIDDEN_IMAGE_ID = 'img-0001f'
/* 复位：只藏 `img-0001f`（`img-0001g` 保持缺键 ⇒ 该组恒有 visible，不触发提升）。
   准入一并复位为 `true`（B6 / B7 动过 `marked`）—— **D 段只判 `visibility`**。 */
const seedImages = readKey(STORAGE_KEYS.images).map((row) => {
  const next = { ...row, marked: true }
  delete next.visibility
  if (next.id === HIDDEN_IMAGE_ID) next.visibility = 'hidden'
  return next
})
writeKey(STORAGE_KEYS.images, seedImages)

const NOW_ISO = '2026-11-15T00:00:00.000Z'
const EXPIRES_ISO = '2026-12-15T00:00:00.000Z'
writeKey(STORAGE_KEYS.seallists, [
  { id: 'sl-share-1', code: 'SL000000001', owner_user_id: 'u-owner-1', name: '影像可見性測試夾', created_at: NOW_ISO, updated_at: NOW_ISO }
])
writeKey(STORAGE_KEYS.seallistItems, [
  { id: 'it-1', seallist_id: 'sl-share-1', seal_id: 'XAI-0001', added_at: '2026-01-03T00:00:00.000Z' },
  { id: 'it-2', seallist_id: 'sl-share-1', seal_id: 'XAI-0002', added_at: '2026-01-02T00:00:00.000Z' },
  { id: 'it-3', seallist_id: 'sl-share-1', seal_id: 'XAI-0003', added_at: '2026-01-01T00:00:00.000Z' }
])
writeKey(STORAGE_KEYS.shares, [
  { id: 'sh-1', seallist_id: 'sl-share-1', code: 'abcd1234', owner_user_id: 'u-owner-1', created_at: NOW_ISO, expires_at: EXPIRES_ISO, revoked_at: null }
])

const drive = await importSrc('src/services/drive.js')

session.setUser(null)
const guestProjection = drive.resolveShare('abcd1234')
session.setUser({ id: 'u-plain-2', role: 'user' })
const plainProjection = drive.resolveShare('abcd1234')
session.setUser({ id: 'u-admin-2', role: 'admin' })
const adminProjection = drive.resolveShare('abcd1234')

const hiddenItemOf = (projection) =>
  (projection.visible_items || []).find((item) => textOf(item.seal_id) === 'XAI-0001') || null
const hiddenIdIn = (projection) => JSON.stringify(projection).includes(HIDDEN_IMAGE_ID)

check(
  'D1',
  '投影里**零 `hidden` 行**：游客与非管理员投影中不出现被藏影像 id（该印 `image_id` 为空串，同键同形状）',
  { guestHasHiddenId: false, plainHasHiddenId: false, guestImageId: '', plainImageId: '' },
  {
    guestHasHiddenId: hiddenIdIn(guestProjection),
    plainHasHiddenId: hiddenIdIn(plainProjection),
    guestImageId: textOf(hiddenItemOf(guestProjection) && hiddenItemOf(guestProjection).image_id),
    plainImageId: textOf(hiddenItemOf(plainProjection) && hiddenItemOf(plainProjection).image_id)
  }
)

check(
  'D2',
  '游客与登录非管理员**集合一致**（逐字相等）；管理员**不同**（拿到真影像 id）',
  {
    guestEqualsPlain: true,
    adminHasHiddenId: true,
    adminImageId: HIDDEN_IMAGE_ID,
    guestItemCount: 3,
    plainItemCount: 3,
    adminItemCount: 3
  },
  {
    guestEqualsPlain: canon(guestProjection.visible_items) === canon(plainProjection.visible_items),
    adminHasHiddenId: hiddenIdIn(adminProjection),
    adminImageId: textOf(hiddenItemOf(adminProjection) && hiddenItemOf(adminProjection).image_id),
    guestItemCount: guestProjection.item_count,
    plainItemCount: plainProjection.item_count,
    adminItemCount: adminProjection.item_count
  }
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
      'lib/ops.js::ADMIN_OPS.registerFaceImage；零真实数据读写、零部署、零 git 操作。'
  })
)
process.exit(Math.min(failedIds.length, 255))
