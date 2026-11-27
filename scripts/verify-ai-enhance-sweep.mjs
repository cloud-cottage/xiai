/**
 * 玺爱 · **自检：AI 修復產物「無人認領清掃」（72h TTL｜本单新增）**
 * ============================================================================ *
 * **本地、离线**（自造 DB 假体 ＋ 注入对象存储删除缝；零外部网络、零云端连接、零生产数据）。
 * 被测件：
 *   · `cloudfunctions/xiai-user-token/lib/aiEnhanceSweep.js`（清扫单实现点：
 *     `sweepUnclaimedProductImages` ＋ 分流判据 `isTimerSweepEvent`）
 *   · `cloudfunctions/xiai-user-token/lib/aiEnhanceDiscard.js::deleteProductImageRow`
 *     （**删行 ＋ 内容寻址去重删对象的单实现点** —— 弃除面与清扫共用，本套顺带证明「未复写
 *     第二套 dedupe / 对象键推导」）
 *   · `cloudfunctions/xiai-user-token/index.js` 的**定时分流**（`exports.main` ／
 *     `exports.isTimerSweepEvent`）
 *
 * 断言面（覆盖派单方点名的 ①〜⑨ ＋ 静态门）：
 *   A. 超期未被引用 ⇒ 行与对象**都删**（`freed_bytes` / `objects_deleted` 如实；含推导键、
 *      摘要形态不合法 ⇒ **只删行**、`bytesLength` 回落三种口）。
 *   B. 被 `face_image_id` / `edge_image_ids` / `cover_image_id` **任一**引用 ⇒ 不删、
 *      计入 `kept_referenced`（三面各一条 ＋ 混合轮）。
 *   C. 未超期 ⇒ 不删（含 72h **边界恰等**、`created_at` 形态不合法 ⇒ 判否不删）。
 *   D. 同 `sha256` 另有行 ⇒ **只删行不删对象**（`objects_deleted: 0`、`freed_bytes: 0`）。
 *   E. **读失败 ⇒ 本轮零删除**（候选行读 / 印面读 / 印譜读三种；回包 `ok:false` ＋ 记
 *      `log.error`）。
 *   F. 非 `ai_enhance` 来源 ⇒ **不进候选**（`scanned: 0`、行与对象原封）。
 *   G. 单次上限 **200** 生效（种 250 ⇒ `scanned: 200`、`deleted: 200`、余 50 行）。
 *   H. **回包键面封闭**（成功 / 失败同一张恰 6 键表）＋ 静态门（零集合名字面、零第二套
 *      dedupe、保留期单点 72h、零新增 op / reason / 读数键、`cloudbaserc.json` triggers
 *      七段 cron、逐行监管日志含 `_id` 与 `freed_bytes`、全程零计费）。
 *   I. **分流**：`event.Type === 'Timer'` 进清扫；`TriggerName` 无 `op` 进清扫；
 *      **任何带 `op` 的请求（含同时带 `Type` / `TriggerName`、含非字符串 op）都不进**。
 *
 * 纪律：断言失败 ⇒ 退出码 1；全程零计费、零生产写入。
 */
/* **测试环境保护哨兵（硬防线）** —— 本套件只跑离线假体：置 `XIAI_NO_REAL_CARD=1`。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

/* 合成测试环境（缺省才写；**脚本内不写任何真实密钥**）。 */
process.env.XIAI_ADMIN_PHONE = String(process.env.XIAI_ADMIN_PHONE || '13800000000').trim()

const ops = require(path.join(FN_DIR, 'lib/ops.js'))
const ledger = require(path.join(FN_DIR, 'lib/ledger.js'))
const userConfig = require(path.join(FN_DIR, 'lib/config.js'))
const aiEnhanceDiscard = require(path.join(FN_DIR, 'lib/aiEnhanceDiscard.js'))
const sweep = require(path.join(FN_DIR, 'lib/aiEnhanceSweep.js'))
const fn = require(path.join(FN_DIR, 'index.js'))

/* --------------------------------------------------------------------------- *
  断言 / 读数（与既有 verify-*.mjs 同形）
 * --------------------------------------------------------------------------- */
let total = 0
let passed = 0
const failedIds = []
const sectionStats = {}

function section(name, title) {
  if (!sectionStats[name]) sectionStats[name] = { total: 0, passed: 0 }
  console.log(JSON.stringify({ section: name, title }))
}

function check(id, title, expected, actual) {
  total += 1
  const sec = id.slice(0, 1)
  if (!sectionStats[sec]) sectionStats[sec] = { total: 0, passed: 0 }
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (pass) passed += 1
  else failedIds.push(id)
  sectionStats[sec].total += 1
  if (pass) sectionStats[sec].passed += 1
  console.log(JSON.stringify({ id, case: title, pass, expected, actual }))
}

const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const countIn = (text, needle) => String(text).split(needle).length - 1
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
const digestOf = (tag) => sha256Hex(Buffer.from(`sweep-fixture-${tag}`, 'utf8'))
const keyOf = (digest, ext = 'png') => `xiai/images/${digest.slice(0, 2)}/${digest}.${ext}`
const objectKey = (digest) => keyOf(digest)

/** 回包键面（恰 6 键；成功 / 失败同一张表）。 */
const REPLY_KEYS = ['deleted', 'freed_bytes', 'kept_referenced', 'objects_deleted', 'ok', 'scanned']
const replyShape = (reply) => Object.keys(reply || {}).sort().join(',')

/** 固定时点：72h 保留期的判定基准（直接调清扫面时注入，免受真实时钟漂移影响）。 */
const NOW = Date.now()
const H = 3600 * 1000
const SWEEP_OPTS = { nowMs: NOW }

/* --------------------------------------------------------------------------- *
  内存假 DB（形状对齐真实 SDK 使用面；可注入「读失败」与整世界复位）
 * --------------------------------------------------------------------------- */
const tick = () => new Promise((resolve) => setImmediate(resolve))

/**
 * 等值 ＋ **wire 算子**匹配（`$in` / `$eq` / `$lt` / `$lte` / `$gt` / `$gte`）—— 与
 * `ops.readRows(...).where(match)` 收到的形态同尺：算子对象（键全以 `$` 开头）逐算子求与；
 * **比较类只认 ISO 串**（仓内 `created_at` 一律 ISO 串 ⇒ **串比较即时间序**）；**缺字段 /
 * 类型不符 ⇒ 恒假**（同真库：无该字段的行不进 `$lt` 结果集）。未知算子 ⇒ **抛错**（不让假体
 * 静默放宽成全命中）。
 */
function matchValue(actual, expected) {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    const operators = Object.keys(expected)
    if (operators.length > 0 && operators.every((op) => op.charAt(0) === '$')) {
      return operators.every((op) => {
        if (op === '$in') return Array.isArray(expected[op]) && expected[op].indexOf(actual) !== -1
        if (op === '$eq') return actual === expected[op]
        if (typeof actual !== 'string' || typeof expected[op] !== 'string') return false
        if (op === '$lt') return actual < expected[op]
        if (op === '$lte') return actual <= expected[op]
        if (op === '$gt') return actual > expected[op]
        if (op === '$gte') return actual >= expected[op]
        throw new Error(`SDB_UNSUPPORTED_OPERATOR:${op}`)
      })
    }
  }
  return actual === expected
}
const rowMatches = (row, match) => Object.keys(match).every((key) => matchValue(row[key], match[key]))

/** 读失败注入：落在这些集合上的 `.get()` 一律抛错（模拟权威存储不可用）。 */
const failCollections = new Set()

/** 每次 `where(match)` 的**逐字捕获**（集合名 ＋ match 深拷贝）—— 断言查询条件用。 */
const whereCalls = []

/** 每个集合的 `.get()` **读次数**（含失败那次；断言批量读次数上界用）。 */
const readCounts = {}

function createFakeDb() {
  const buckets = new Map()
  const bucketOf = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    return buckets.get(name)
  }
  function makeQuery(map, state, collName) {
    return {
      limit(count) {
        if (state.entry) state.entry.limit = count
        return makeQuery(map, Object.assign({}, state, { limit: count }), collName)
      },
      async get() {
        await tick()
        readCounts[collName] = (readCounts[collName] || 0) + 1
        if (failCollections.has(collName)) throw new Error('SDB_FAKE_READ_FAILED')
        const rows = [...map.values()].filter((row) => rowMatches(row, state.match || {})).map((row) => Object.assign({}, row))
        return { data: state.limit ? rows.slice(0, state.limit) : rows }
      }
    }
  }
  return {
    bucketOf,
    allBuckets: () => [...buckets.values()],
    collection(name) {
      const map = bucketOf(name)
      return {
        doc(id) {
          return {
            async get() {
              await tick()
              const row = map.get(id)
              return { data: row ? Object.assign({}, row) : null }
            },
            async set(doc) {
              await tick()
              map.set(id, Object.assign({ _id: id }, doc))
              return { updated: 1 }
            },
            async delete() {
              await tick()
              deleteCalls.push({ collection: name, id })
              const existed = map.delete(id)
              return { deleted: existed ? 1 : 0 }
            }
          }
        },
        where(match) {
          /* **逐字捕获查询条件**（深拷贝 ＋ 事后补记的 `limit`；断言 `$lt` / `$in` / 上限用）。 */
          const entry = { collection: name, match: JSON.parse(JSON.stringify(match)), limit: 0 }
          whereCalls.push(entry)
          return makeQuery(map, { match, entry }, name)
        }
      }
    }
  }
}

const deleteCalls = []
const fakeDb = createFakeDb()
const imagesMap = () => fakeDb.bucketOf('xiai_images')
const facesMap = () => fakeDb.bucketOf('xiai_faces')
const booksMap = () => fakeDb.bucketOf('xiai_books')
const rowDeletesOn = (collection) => deleteCalls.filter((call) => call.collection === collection).length

ops.setOpsDbProvider(() => fakeDb)

/* --------------------------------------------------------------------------- *
  假对象存储：**删除缝**（记录每次删对象调用；真删假体里的对象字节）
 * --------------------------------------------------------------------------- */
const storageObjects = new Map()
const storageDeletes = []
ops.setOpsStorageDeleteProvider(async (cloudPath) => {
  storageDeletes.push(cloudPath)
  storageObjects.delete(cloudPath)
})
const objectPresent = (cloudPath) => storageObjects.has(cloudPath)

/* --------------------------------------------------------------------------- *
  计费 spy（清扫面**零计费**：本套全程 charge / refund 零调用）
 * --------------------------------------------------------------------------- */
const chargeSpy = { calls: 0 }
const refundSpy = { calls: 0 }
const realChargePoints = ledger.chargePoints
const realRefundPoints = ledger.refundPoints
ledger.chargePoints = (params) => {
  chargeSpy.calls += 1
  return realChargePoints(params)
}
ledger.refundPoints = (params) => {
  refundSpy.calls += 1
  return realRefundPoints(params)
}

/* --------------------------------------------------------------------------- *
  结构化日志采集（`lib/log.js` 落 `console.*`；只在被测调用窗口内接管 ⇒ 输出不刷屏）
 * --------------------------------------------------------------------------- */
const logLines = []
async function withLogCapture(run) {
  const original = { log: console.log, warn: console.warn, error: console.error }
  const sink = (line) => {
    const text = String(line)
    if (!text.startsWith('{')) return
    try {
      logLines.push(JSON.parse(text))
    } catch {
      logLines.push({ raw: text })
    }
  }
  console.log = (...args) => (args.length === 1 ? sink(args[0]) : original.log(...args))
  console.warn = (...args) => (args.length === 1 ? sink(args[0]) : original.warn(...args))
  console.error = (...args) => (args.length === 1 ? sink(args[0]) : original.error(...args))
  try {
    /* **必须 await**：窗口要覆盖整个异步调用（否则日志在补丁窗口外落地、既丢采集也刷屏）。 */
    return await run()
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
}
const runSweep = (options = SWEEP_OPTS) => withLogCapture(() => sweep.sweepUnclaimedProductImages(options))
const runMain = (event) => withLogCapture(() => fn.main(event))
const logsSince = (mark) => logLines.slice(mark)

/* --------------------------------------------------------------------------- *
  复位与种行
 * --------------------------------------------------------------------------- */
function resetWorld() {
  for (const map of fakeDb.allBuckets()) map.clear()
  deleteCalls.length = 0
  storageObjects.clear()
  storageDeletes.length = 0
  failCollections.clear()
  logLines.length = 0
  whereCalls.length = 0
  for (const key of Object.keys(readCounts)) delete readCounts[key]
}

/** 本轮读次数（按集合；`.get()` 调用数，含失败那一次）。 */
const readsOf = (collection) => readCounts[collection] || 0
/** 本轮某集合上带指定算子的 `where` 捕获（深拷贝数组）。 */
const whereCallsOf = (collection) => whereCalls.filter((call) => call.collection === collection)

/**
 * 种一行 AI 修復產物（＋内容寻址对象字节）。
 * @param {string} imageId 行编号
 * @param {{tag?:string, digest?:string, source?:string, bytes?:number, bytesLength?:number,
 *          createdAt?:string, storageKey?:string, mime?:string, withObject?:boolean}} [options]
 */
function seedProduct(imageId, options = {}) {
  const digest = options.digest || digestOf(options.tag || imageId)
  const mime = options.mime || 'image/png'
  const storageKey = Object.prototype.hasOwnProperty.call(options, 'storageKey')
    ? options.storageKey
    : keyOf(digest, mime === 'image/webp' ? 'webp' : mime === 'image/jpeg' ? 'jpg' : 'png')
  const row = {
    _id: imageId,
    id: imageId,
    kind: 'FACE',
    storage: 'server',
    mime,
    sha256: options.digest === null ? '' : digest,
    storage_key: storageKey,
    source: options.source || 'ai_enhance',
    displayOnly: true,
    created_at: options.createdAt || new Date(NOW - 73 * H).toISOString()
  }
  if (options.digest) row.sha256 = options.digest
  if (Object.prototype.hasOwnProperty.call(options, 'bytes')) row.bytes = options.bytes
  if (Object.prototype.hasOwnProperty.call(options, 'bytesLength')) row.bytesLength = options.bytesLength
  imagesMap().set(imageId, row)
  if (options.withObject !== false && storageKey) storageObjects.set(storageKey, Buffer.from(`fixture-${digest}`, 'utf8'))
  return { digest, key: storageKey }
}

/* ===========================================================================
  A 段：超期未被引用 ⇒ 行与对象都删（①）
  =========================================================================== */
section('A', '超期且无人认领 ⇒ 行＋存储对象一起清掉（freed_bytes / objects_deleted 如实）')

/* A1：摘要独享 ⇒ 删行 ＋ 删对象、freed_bytes ＝ 行内 bytes。 */
resetWorld()
{
  const seed = seedProduct('img-sweep-a1', { bytes: 4096 })
  const reply = await runSweep()
  check('A1', '① 超期 73h ＋ 三面零引用 ⇒ **行与对象都删**（`deleted:1`、`objects_deleted:1`、`freed_bytes` ＝ 行 `bytes` 4096）、回包恰 6 键、删的正是内容寻址键', {
    keys: REPLY_KEYS.join(','),
    ok: true,
    scanned: 1,
    deleted: 1,
    kept_referenced: 0,
    freed_bytes: 4096,
    objects_deleted: 1,
    rowGone: true,
    objectGone: true,
    storageDeletes: [seed.key],
    rowDeletes: 1
  }, {
    keys: replyShape(reply),
    ok: reply.ok,
    scanned: reply.scanned,
    deleted: reply.deleted,
    kept_referenced: reply.kept_referenced,
    freed_bytes: reply.freed_bytes,
    objects_deleted: reply.objects_deleted,
    rowGone: !imagesMap().has('img-sweep-a1'),
    objectGone: !objectPresent(seed.key),
    storageDeletes: storageDeletes.slice(),
    rowDeletes: rowDeletesOn('xiai_images')
  })
}

/* A2：行无 `storage_key` ⇒ 对象键按摘要 ＋ mime 推导（.webp），独享 ⇒ 删对象。 */
resetWorld()
{
  const digest = digestOf('webp-content')
  const seed = seedProduct('img-sweep-a2', { digest, mime: 'image/webp', storageKey: '', bytes: 1024 })
  const reply = await runSweep()
  check('A2', '① 行缺 `storage_key` ⇒ 对象键按 `sha256` ＋ `mime` 推导（`.webp`）、独享 ⇒ `objects_deleted:1` 且删的正是推导键、`freed_bytes:1024`', {
    deleted: 1,
    objects_deleted: 1,
    freed_bytes: 1024,
    derivedKey: keyOf(digest, 'webp'),
    storageDeletes: [keyOf(digest, 'webp')],
    objectGone: true
  }, {
    deleted: reply.deleted,
    objects_deleted: reply.objects_deleted,
    freed_bytes: reply.freed_bytes,
    derivedKey: keyOf(digest, 'webp'),
    storageDeletes: storageDeletes.slice(),
    objectGone: !objectPresent(keyOf(digest, 'webp'))
  })
}

/* A3：摘要 / 对象键形态不合法 ⇒ **只删行不删对象**（沿弃除口）＋ freed_bytes 记 0。 */
resetWorld()
{
  const foreignDigest = digestOf('foreign-object')
  const foreignKey = keyOf(foreignDigest)
  imagesMap().set('img-sweep-a3', {
    _id: 'img-sweep-a3',
    id: 'img-sweep-a3',
    kind: 'FACE',
    storage: 'server',
    mime: 'image/png',
    sha256: 'not-a-digest',
    storage_key: foreignKey,
    source: 'ai_enhance',
    bytes: 7777,
    created_at: new Date(NOW - 73 * H).toISOString()
  })
  storageObjects.set(foreignKey, Buffer.from('foreign', 'utf8'))
  const reply = await runSweep()
  check('A3', '⑦② 摘要形态不合法 ⇒ **只删行、对象原封**（`objects_deleted:0`、`freed_bytes:0`，不谎报已释放）', {
    ok: true,
    scanned: 1,
    deleted: 1,
    objects_deleted: 0,
    freed_bytes: 0,
    rowGone: true,
    objectStillThere: true,
    storageDeletes: 0
  }, {
    ok: reply.ok,
    scanned: reply.scanned,
    deleted: reply.deleted,
    objects_deleted: reply.objects_deleted,
    freed_bytes: reply.freed_bytes,
    rowGone: !imagesMap().has('img-sweep-a3'),
    objectStillThere: objectPresent(foreignKey),
    storageDeletes: storageDeletes.length
  })
}

/* A4：行无 `bytes` ⇒ 回落同文档 `bytesLength`（**只取行内字段、不猜**）。 */
resetWorld()
{
  seedProduct('img-sweep-a4', { bytesLength: 2048 })
  const reply = await runSweep()
  check('A4', '① 行缺 `bytes` ⇒ `freed_bytes` 回落 `bytesLength`（2048）；对象仍删、`objects_deleted:1`', {
    deleted: 1,
    objects_deleted: 1,
    freed_bytes: 2048
  }, {
    deleted: reply.deleted,
    objects_deleted: reply.objects_deleted,
    freed_bytes: reply.freed_bytes
  })
}

/* ===========================================================================
  B 段：引用三面全护 ⇒ 不删、计 kept_referenced（②）
  =========================================================================== */
section('B', '引用保护：face_image_id / edge_image_ids / books.cover_image_id 任一命中 ⇒ 不删，计 kept_referenced')

resetWorld()
{
  const ids = ['img-sweep-b1', 'img-sweep-b2', 'img-sweep-b3']
  ids.forEach((id) => seedProduct(id, { bytes: 1000 }))
  facesMap().set('fc-b1', { _id: 'fc-b1', kind: 'FACE', face_image_id: ids[0], sealId: 's-1' })
  facesMap().set('fe-b2', { _id: 'fe-b2', kind: 'EDGE', edge_image_ids: ['img-unrelated', ids[1]], sealId: 's-2' })
  booksMap().set('bk-b3', { _id: 'bk-b3', id: '00001', cover_image_id: ids[2] })
  const reply = await runSweep()
  check('B1', '② **三面各命中一条**（面① `face_image_id`／面② `edge_image_ids` 数组包含／面③ 印譜 `cover_image_id`）⇒ 三条全保留：`deleted:0`、`kept_referenced:3`、零删行零删对象', {
    ok: true,
    scanned: 3,
    deleted: 0,
    kept_referenced: 3,
    objects_deleted: 0,
    freed_bytes: 0,
    rowsStillThere: 3,
    objectsStillThere: 3,
    rowDeletes: 0,
    storageDeletes: 0
  }, {
    ok: reply.ok,
    scanned: reply.scanned,
    deleted: reply.deleted,
    kept_referenced: reply.kept_referenced,
    objects_deleted: reply.objects_deleted,
    freed_bytes: reply.freed_bytes,
    rowsStillThere: ids.filter((id) => imagesMap().has(id)).length,
    objectsStillThere: ids.filter((id) => objectPresent(keyOf(digestOf(id)))).length,
    rowDeletes: rowDeletesOn('xiai_images'),
    storageDeletes: storageDeletes.length
  })
}

resetWorld()
{
  seedProduct('img-sweep-b4')
  seedProduct('img-sweep-b5')
  booksMap().set('bk-b5', { _id: 'bk-b5', id: '00002', cover_image_id: 'img-sweep-b5' })
  const reply = await runSweep()
  check('B2', '② 混合轮：**被印譜封面引用的保留、未被引用的照清**（`deleted:1` ＋ `kept_referenced:1`；被引用行与对象原封）', {
    scanned: 2,
    deleted: 1,
    kept_referenced: 1,
    keptRowStillThere: true,
    keptObjectStillThere: true,
    unclaimedGone: true
  }, {
    scanned: reply.scanned,
    deleted: reply.deleted,
    kept_referenced: reply.kept_referenced,
    keptRowStillThere: imagesMap().has('img-sweep-b5'),
    keptObjectStillThere: objectPresent(keyOf(digestOf('img-sweep-b5'))),
    unclaimedGone: !imagesMap().has('img-sweep-b4')
  })
}

/* ===========================================================================
  C 段：未超期 / 形态不合法 ⇒ 不删（③）
  =========================================================================== */
section('C', '保留期：72h 内 ⇒ 不删；恰等边界（< 为严格）⇒ 不删；created_at 形态不合法 ⇒ 判否不删')

resetWorld()
{
  seedProduct('img-sweep-c1', { createdAt: new Date(NOW - 71 * H).toISOString() })
  const reply = await runSweep()
  check('C1', '③ 超期前 71h（**未到 72h**）⇒ **查询层就被 `$lt` 拦在候选之外**（`scanned:0`、`deleted:0`、行与对象原封 —— 未到期的行也不占 200 的扫描额度）', {
    ok: true,
    scanned: 0,
    deleted: 0,
    kept_referenced: 0,
    rowStillThere: true,
    objectStillThere: true,
    rowDeletes: 0,
    storageDeletes: 0
  }, {
    ok: reply.ok,
    scanned: reply.scanned,
    deleted: reply.deleted,
    kept_referenced: reply.kept_referenced,
    rowStillThere: imagesMap().has('img-sweep-c1'),
    objectStillThere: objectPresent(keyOf(digestOf('img-sweep-c1'))),
    rowDeletes: rowDeletesOn('xiai_images'),
    storageDeletes: storageDeletes.length
  })
}

resetWorld()
{
  seedProduct('img-sweep-c2', { createdAt: new Date(NOW - sweep.SWEEP_RETENTION_MS).toISOString() })
  const reply = await runSweep({ nowMs: NOW })
  check('C2', '③ **边界恰等**：`created_at` ＝ `now − 72h` ⇒ 查询 `$lt` 与码内复判**都是严格小于** ⇒ 不入候选、**不删**（`scanned:0`、`deleted:0`）', {
    deleted: 0,
    scanned: 0,
    rowStillThere: true
  }, {
    deleted: reply.deleted,
    scanned: reply.scanned,
    rowStillThere: imagesMap().has('img-sweep-c2')
  })
}

resetWorld()
{
  imagesMap().set('img-sweep-c3', {
    _id: 'img-sweep-c3',
    id: 'img-sweep-c3',
    kind: 'FACE',
    storage: 'server',
    mime: 'image/png',
    sha256: digestOf('c3'),
    storage_key: keyOf(digestOf('c3')),
    source: 'ai_enhance',
    /* **字典序小于 cutoff（`0…` < `2…`）⇒ 查询 `$lt` 会放行这行**，但 `Date.parse` 出不来
       ⇒ **正好落到码内复判那道双保险上**（查询层放行 ≠ 判超期）。 */
    created_at: '0000-99-99'
  })
  storageObjects.set(keyOf(digestOf('c3')), Buffer.from('c3', 'utf8'))
  const reply = await runSweep()
  check('C3', '③ `created_at` **形态不合法但字典序过关** ⇒ 查询放行（`scanned:1`）、**码内复判拦下**（`Date.parse` 不出 ⇒ 判非超期 ⇒ `deleted:0`、行与对象原封）—— 双保险实证', {
    deleted: 0,
    scanned: 1,
    rowStillThere: true,
    objectStillThere: true,
    rowDeletes: 0
  }, {
    deleted: reply.deleted,
    scanned: reply.scanned,
    rowStillThere: imagesMap().has('img-sweep-c3'),
    objectStillThere: objectPresent(keyOf(digestOf('c3'))),
    rowDeletes: rowDeletesOn('xiai_images')
  })
}

/* ===========================================================================
  D 段：同 sha256 另有行 ⇒ 只删行不删对象（④）
  =========================================================================== */
section('D', '内容寻址去重：同摘要另有存活行 ⇒ 只删行、对象与他行原封（走单实现点）')

resetWorld()
{
  const digest = digestOf('shared-content')
  seedProduct('img-sweep-d1', { digest, bytes: 512 })
  seedProduct('img-sweep-d2', { digest, bytes: 512, createdAt: new Date(NOW - 1 * H).toISOString() })
  const reply = await runSweep()
  check('D1', '④ 同 `sha256` 另有行（未超期那条 —— **被查询 `$lt` 挡在候选外** ⇒ `scanned:1`）⇒ `deleted:1`、**`objects_deleted:0` ＋ `freed_bytes:0`**（对象不删、他行原封）', {
    ok: true,
    scanned: 1,
    deleted: 1,
    objects_deleted: 0,
    freed_bytes: 0,
    targetGone: true,
    peerStillThere: true,
    objectStillThere: true,
    storageDeletes: 0
  }, {
    ok: reply.ok,
    scanned: reply.scanned,
    deleted: reply.deleted,
    objects_deleted: reply.objects_deleted,
    freed_bytes: reply.freed_bytes,
    targetGone: !imagesMap().has('img-sweep-d1'),
    peerStillThere: imagesMap().has('img-sweep-d2'),
    objectStillThere: objectPresent(keyOf(digest)),
    storageDeletes: storageDeletes.length
  })
}

/* ===========================================================================
  E 段：读失败 ⇒ 本轮零删除（⑤）
  =========================================================================== */
section('E', '读失败（候选行读 / 印面读 / 印譜读）⇒ ok:false ＋ 记 log.error ＋ 本轮零删除')

resetWorld()
{
  const seed = seedProduct('img-sweep-e1', { bytes: 4096 })
  failCollections.add('xiai_images')
  const mark = logLines.length
  const reply = await runSweep()
  const errors = logsSince(mark).filter((line) => line.event === 'aiEnhanceSweep.round.failed')
  check('E1', '⑤ **候选行读失败** ⇒ `ok:false`、`scanned:0`、**零删行零删对象零释放**（行与对象原封）、记 `log.error`（`aiEnhanceSweep.round.failed` ＋ `errorName`）', {
    keys: REPLY_KEYS.join(','),
    ok: false,
    scanned: 0,
    deleted: 0,
    objects_deleted: 0,
    freed_bytes: 0,
    rowStillThere: true,
    objectStillThere: true,
    rowDeletes: 0,
    errorLogged: true
  }, {
    keys: replyShape(reply),
    ok: reply.ok,
    scanned: reply.scanned,
    deleted: reply.deleted,
    objects_deleted: reply.objects_deleted,
    freed_bytes: reply.freed_bytes,
    rowStillThere: imagesMap().has('img-sweep-e1'),
    objectStillThere: objectPresent(seed.key),
    rowDeletes: rowDeletesOn('xiai_images'),
    errorLogged: errors.length === 1 && errors[0].level === 'error' && Boolean(errors[0].errorName)
  })
}

resetWorld()
{
  seedProduct('img-sweep-e2', { bytes: 100 })
  seedProduct('img-sweep-e3', { bytes: 100 })
  failCollections.add('xiai_faces')
  const reply = await runSweep()
  check('E2', '⑤ **印面引用读失败** ⇒ `ok:false`、候选已读到（`scanned:2`）但**本轮零删除**（绝不把「读不到」当「无引用」）', {
    ok: false,
    scanned: 2,
    deleted: 0,
    kept_referenced: 0,
    objects_deleted: 0,
    freed_bytes: 0,
    rowsStillThere: 2,
    rowDeletes: 0,
    storageDeletes: 0
  }, {
    ok: reply.ok,
    scanned: reply.scanned,
    deleted: reply.deleted,
    kept_referenced: reply.kept_referenced,
    objects_deleted: reply.objects_deleted,
    freed_bytes: reply.freed_bytes,
    rowsStillThere: ['img-sweep-e2', 'img-sweep-e3'].filter((id) => imagesMap().has(id)).length,
    rowDeletes: rowDeletesOn('xiai_images'),
    storageDeletes: storageDeletes.length
  })
}

resetWorld()
{
  seedProduct('img-sweep-e4', { bytes: 100 })
  facesMap().set('fe-e4', { _id: 'fe-e4', kind: 'EDGE', edge_image_ids: [] })
  failCollections.add('xiai_books')
  const reply = await runSweep()
  check('E3', '⑤ **印譜封面读失败**（面③）⇒ `ok:false`、**本轮零删除**（`scanned:1`、行与对象原封）', {
    ok: false,
    scanned: 1,
    deleted: 0,
    objects_deleted: 0,
    rowStillThere: true,
    objectStillThere: true,
    rowDeletes: 0
  }, {
    ok: reply.ok,
    scanned: reply.scanned,
    deleted: reply.deleted,
    objects_deleted: reply.objects_deleted,
    rowStillThere: imagesMap().has('img-sweep-e4'),
    objectStillThere: objectPresent(keyOf(digestOf('img-sweep-e4'))),
    rowDeletes: rowDeletesOn('xiai_images')
  })
}

/* ===========================================================================
  F 段：非 ai_enhance 来源 ⇒ 不进候选（⑥）
  =========================================================================== */
section('F', '归属：非 ai_enhance 来源 ⇒ 根本不进候选（scanned:0）且行 / 对象原封')

resetWorld()
{
  const seed = seedProduct('img-sweep-f1', { source: 'upload', bytes: 4096 })
  const reply = await runSweep()
  check('F1', '⑥ `source: upload`（即使超期、即使无人引用）⇒ **不进读集**：`scanned:0`、`deleted:0`、零删行零删对象', {
    ok: true,
    scanned: 0,
    deleted: 0,
    kept_referenced: 0,
    objects_deleted: 0,
    freed_bytes: 0,
    rowStillThere: true,
    objectStillThere: true,
    rowDeletes: 0,
    storageDeletes: 0
  }, {
    ok: reply.ok,
    scanned: reply.scanned,
    deleted: reply.deleted,
    kept_referenced: reply.kept_referenced,
    objects_deleted: reply.objects_deleted,
    freed_bytes: reply.freed_bytes,
    rowStillThere: imagesMap().has('img-sweep-f1'),
    objectStillThere: objectPresent(seed.key),
    rowDeletes: rowDeletesOn('xiai_images'),
    storageDeletes: storageDeletes.length
  })
}

resetWorld()
{
  seedProduct('img-sweep-f2', { source: 'ai_enhance' })
  const reply = await runSweep()
  check('F2', '⑥ 对照（正向 canary）：同一轮里 `ai_enhance` 那条**照清** ⇒ 证明 F1 的零删除不是「读不到行」', {
    scanned: 1,
    deleted: 1,
    rowGone: true
  }, {
    scanned: reply.scanned,
    deleted: reply.deleted,
    rowGone: !imagesMap().has('img-sweep-f2')
  })
}

/* ===========================================================================
  G 段：单次上限 200 生效（⑦）
  =========================================================================== */
section('G', '扫描与处理上限：种 250 条超期未引用 ⇒ scanned 200 / deleted 200 / 余 50 行')

resetWorld()
{
  for (let i = 0; i < 250; i += 1) {
    const id = `img-sweep-g-${String(i).padStart(3, '0')}`
    seedProduct(id, { tag: `g-${i}`, bytes: 1000 })
  }
  const reply = await runSweep()
  const remaining = [...imagesMap().keys()].length
  check('G1', '⑦ 单次上限 **200** 同时封「扫描」与「处理」：`scanned:200`、`deleted:200`、`objects_deleted:200`、`freed_bytes:200000`、库内仍余 50 行（不长跑、不整库清空）', {
    ok: true,
    scanned: 200,
    deleted: 200,
    kept_referenced: 0,
    objects_deleted: 200,
    freed_bytes: 200000,
    remainingRows: 50,
    rowDeletes: 200
  }, {
    ok: reply.ok,
    scanned: reply.scanned,
    deleted: reply.deleted,
    kept_referenced: reply.kept_referenced,
    objects_deleted: reply.objects_deleted,
    freed_bytes: reply.freed_bytes,
    remainingRows: remaining,
    rowDeletes: rowDeletesOn('xiai_images')
  })
}

/* G2（① 派单补断言）：**查询条件确实带上 `created_at: {$lt: cutoffIso}`** —— 读注入逐字捕获
   `where` 的 match ＋ `limit`，静态面另验算子字面在场。 */
resetWorld()
{
  seedProduct('img-sweep-g2-a', { bytes: 10 })
  seedProduct('img-sweep-g2-b', { bytes: 10 })
  const reply = await runSweep({ nowMs: NOW })
  const sweepSource = readFileSync(path.join(FN_DIR, 'lib', 'aiEnhanceSweep.js'), 'utf8')
  const imageCalls = whereCallsOf('xiai_images')
  const candidateCalls = imageCalls.filter((call) => call.match && Object.prototype.hasOwnProperty.call(call.match, 'source'))
  const captured = candidateCalls.length === 1 ? candidateCalls[0].match : null
  const expectedMatch = { source: 'ai_enhance', created_at: { $lt: new Date(NOW - sweep.SWEEP_RETENTION_MS).toISOString() } }
  check('G2', "① **查询级超期过滤**：候选读 `where` 被逐字捕获 ＝ `{source:'ai_enhance', created_at:{$lt: cutoffIso}}`、`limit:200`（cutoffIso ＝ `new Date(nowMs − 72h).toISOString()`）；且**候选读恰 1 次、每次都带 `$lt`**；静态面 `$lt` / `$in` 算子字面均在场", {
    capturedMatch: expectedMatch,
    limit: 200,
    candidateReads: 1,
    everyCandidateHasLt: true,
    ok: true,
    scanned: 2,
    deleted: 2,
    ltLiteral: true,
    inLiteral: true
  }, {
    capturedMatch: captured,
    limit: candidateCalls.length === 1 ? candidateCalls[0].limit : -1,
    candidateReads: candidateCalls.length,
    everyCandidateHasLt: candidateCalls.length > 0 && candidateCalls.every((call) =>
      call.match.created_at && typeof call.match.created_at.$lt === 'string'),
    ok: reply.ok,
    scanned: reply.scanned,
    deleted: reply.deleted,
    ltLiteral: countIn(sweepSource, '$lt') >= 1,
    inLiteral: countIn(sweepSource, '$in') >= 1
  })
}

/* G3（③ 派单补断言）：**停滞护栏** —— 整页 200 行全是被引用老行 ⇒ 记 `log.warn`。 */
resetWorld()
{
  const ids = []
  for (let i = 0; i < 200; i += 1) {
    const id = `img-sweep-g3-${String(i).padStart(3, '0')}`
    seedProduct(id, { tag: `g3-${i}`, bytes: 100 })
    ids.push(id)
  }
  /* 面②：一条 EDGE 行把 200 个编号全引用（`edge_image_ids` 数组包含）。 */
  facesMap().set('fe-g3', { _id: 'fe-g3', kind: 'EDGE', edge_image_ids: ids })
  const mark = logLines.length
  const reply = await runSweep()
  const stalled = logsSince(mark).filter((line) => line.event === 'aiEnhanceSweep.round.stalled')
  check('G3', "③ **停滞护栏**：`scanned:200 && deleted:0`（整页全是被引用老行）⇒ 记 `log.warn('aiEnhanceSweep.round.stalled')` 恰 1 条、level=`warn`、字段恰 `{scanned:200, kept_referenced:200}`；回包键面不变、零删行零删对象", {
    scanned: 200,
    deleted: 0,
    kept_referenced: 200,
    keys: REPLY_KEYS.join(','),
    rowDeletes: 0,
    storageDeletes: 0,
    stalledLines: 1,
    stalledLevel: 'warn',
    stalledFields: { scanned: 200, kept_referenced: 200 }
  }, {
    scanned: reply.scanned,
    deleted: reply.deleted,
    kept_referenced: reply.kept_referenced,
    keys: replyShape(reply),
    rowDeletes: rowDeletesOn('xiai_images'),
    storageDeletes: storageDeletes.length,
    stalledLines: stalled.length,
    stalledLevel: stalled.length === 1 ? stalled[0].level : null,
    stalledFields: stalled.length === 1
      ? { scanned: stalled[0].scanned, kept_referenced: stalled[0].kept_referenced }
      : null
  })
}

/* ===========================================================================
  H 段：回包键面封闭 ＋ 静态门 ＋ 监管日志 ＋ 零计费（⑧）
  =========================================================================== */
section('H', '回包恰 6 键封闭（成败同表）/ 零集合名字面 / 零第二套 dedupe / 保留期单点 72h / 零新增 op·reason·读数键 / triggers 七段 cron / 逐行监管日志 / 零计费')

/* H1：空轮回包键面（成功）。 */
resetWorld()
{
  const reply = await runSweep()
  check('H1', '⑧ 成功回包**恰 6 键**（`ok, scanned, deleted, kept_referenced, freed_bytes, objects_deleted`；零 `reason`、零 `refunded`、零新增键）', {
    keys: REPLY_KEYS.join(','),
    ok: true,
    scanned: 0,
    deleted: 0,
    kept_referenced: 0,
    freed_bytes: 0,
    objects_deleted: 0
  }, {
    keys: replyShape(reply),
    ok: reply.ok,
    scanned: reply.scanned,
    deleted: reply.deleted,
    kept_referenced: reply.kept_referenced,
    freed_bytes: reply.freed_bytes,
    objects_deleted: reply.objects_deleted
  })
}

/* H2：失败轮回包键面（与成功同一张表）。 */
resetWorld()
{
  seedProduct('img-sweep-h2')
  failCollections.add('xiai_faces')
  const reply = await runSweep()
  check('H2', '⑧ **失败回包与成功同一张键面表**（恰同 6 键，只翻 `ok`；`reason` / `message` 一个都不加 ⇒ 零新增对外 reason）', {
    keys: REPLY_KEYS.join(','),
    ok: false
  }, {
    keys: replyShape(reply),
    ok: reply.ok
  })
}

/* H3：静态门 —— 清扫实现点纪律。 */
{
  const sweepSource = readFileSync(path.join(FN_DIR, 'lib', 'aiEnhanceSweep.js'), 'utf8')
  const discardSource = readFileSync(path.join(FN_DIR, 'lib', 'aiEnhanceDiscard.js'), 'utf8')
  const opsSource = readFileSync(path.join(FN_DIR, 'lib', 'ops.js'), 'utf8')
  check('H3', '⑦ 静态门：清扫实现点**零集合名字面 / 零集合句柄调用字面 / 零摘要·对象键推导**（`xiai_` 0、`collection(` 0、`.doc(` 0、`deleteArtifactObject` 0、`DIGEST_PATTERN` 0、内容寻址键前缀 0）；**恰一处** `require(./aiEnhanceDiscard.js)` ＋ 调用 `deleteProductImageRow(ops, …)` ⇒ **复用单实现点、未复写第二套 dedupe**', {
    collectionNameLiterals: 0,
    collectionCalls: 0,
    docCalls: 0,
    objectDeleteCalls: 0,
    digestPattern: 0,
    objectKeyPrefix: 0,
    discardRequire: 1,
    sharedCall: true,
    sharedExported: true
  }, {
    collectionNameLiterals: countIn(sweepSource, 'xiai_'),
    collectionCalls: countIn(sweepSource, 'collection('),
    docCalls: countIn(sweepSource, '.doc('),
    objectDeleteCalls: countIn(sweepSource, 'deleteArtifactObject'),
    digestPattern: countIn(sweepSource, 'DIGEST_PATTERN'),
    objectKeyPrefix: countIn(sweepSource, 'xiai/images/'),
    discardRequire: countIn(sweepSource, "require('./aiEnhanceDiscard.js')"),
    sharedCall: countIn(sweepSource, 'deleteProductImageRow(ops,') >= 1,
    sharedExported: typeof aiEnhanceDiscard.deleteProductImageRow === 'function'
  })
  check('H4', '⑦ 单实现点仍在弃除文件内且被两面共用：`aiEnhanceDiscard.js` 里 `deleteProductImageRow` 定义恰 1 处、`discardCandidate` 内**调用**它（零第二套）；`ops.js` 注册面未新增（`ai-enhance-discard` 成员仍恰 1、`require(./aiEnhanceDiscard.js)` 仍恰 1）', {
    defined: 1,
    calledInDiscard: true,
    opsMember: 1,
    opsRequire: 1
  }, {
    defined: countIn(discardSource, 'async function deleteProductImageRow'),
    calledInDiscard: countIn(discardSource, 'await deleteProductImageRow(ops, row)') === 1,
    opsMember: countIn(opsSource, "'ai-enhance-discard'"),
    opsRequire: countIn(opsSource, "require('./aiEnhanceDiscard.js')")
  })
}

/* H5：保留期单点 72h（唯一常量、可调）。 */
{
  const sweepSource = readFileSync(path.join(FN_DIR, 'lib', 'aiEnhanceSweep.js'), 'utf8')
  check('H5', '① 保留期**单点常量** ＝ `SWEEP_RETENTION_MS = 72*3600*1000`（源内恰 1 处该算式、零第二个保留期字面值）', {
    retentionMs: 72 * 3600 * 1000,
    constant: sweep.SWEEP_RETENTION_MS,
    literalSites: 1,
    scanLimit: 200,
    limitConstant: sweep.SWEEP_SCAN_LIMIT
  }, {
    retentionMs: 72 * 3600 * 1000,
    constant: sweep.SWEEP_RETENTION_MS,
    literalSites: countIn(sweepSource, '72 * 3600 * 1000'),
    scanLimit: 200,
    limitConstant: sweep.SWEEP_SCAN_LIMIT
  })
}

/* H6：零新增 op / reason / 读数键 / 集合。 */
{
  const indexSource = readFileSync(path.join(FN_DIR, 'index.js'), 'utf8')
  const sweepOps = Object.keys(ops.ADMIN_OPS).filter((name) => name.includes('sweep'))
  const frozenReasons = ['FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE', 'ALREADY_ENDORSED', 'DUPLICATE_VALUE', 'INSUFFICIENT_POINTS', 'KEY_INVALID', 'CONFIG_MISSING', 'LIMIT_DAY', 'LIMIT_MINUTE', 'UPSTREAM_ERROR']
  check('H6', '③ 零新增对外面：`ADMIN_OPS` 仍 **56** 项且**零 sweep op**；`REASONS` 仍 **13** 值逐字冻结；`AI_ENHANCE_READOUT_KEYS` 仍 **8** 项；`index.js` 两个 AI op 名各仍恰 1 处（未重复注册）', {
    adminOps: 56,
    sweepOps: [],
    reasons: 13,
    reasonList: frozenReasons.slice(),
    readoutKeys: 8,
    enhanceFaceInIndex: 1,
    discardInIndex: 1
  }, {
    adminOps: Object.keys(ops.ADMIN_OPS).length,
    sweepOps,
    reasons: Object.keys(userConfig.REASONS).length,
    reasonList: Object.keys(userConfig.REASONS),
    readoutKeys: fn.AI_ENHANCE_READOUT_KEYS.length,
    enhanceFaceInIndex: countIn(indexSource, "'ai-enhance-face'"),
    discardInIndex: countIn(indexSource, "'ai-enhance-discard'")
  })
}

/* H7：cloudbaserc.json 定时触发器配置（七段 cron）。 */
{
  const rc = JSON.parse(readFileSync(path.join(ROOT, 'cloudbaserc.json'), 'utf8'))
  const userToken = rc.functions.find((item) => item.name === 'xiai-user-token')
  const trigger = (userToken && userToken.triggers && userToken.triggers[0]) || {}
  const cronFields = String(trigger.config || '').trim().split(/\s+/)
  check('H7', "⑥ `cloudbaserc.json` 挂 `functions[].triggers`：元素恰三键 `{name:'ai-enhance-sweep-daily', type:'timer', config:'0 0 4 * * * *'}`（**7 段 cron**：秒 分 时 日 月 星期 年 ＝ 每日 04:00）；函数仍 4 个、其余三函数无 triggers", {
    functions: 4,
    triggerShape: ['config', 'name', 'type'],
    type: 'timer',
    cron: '0 0 4 * * * *',
    cronFields: 7,
    others: 0
  }, {
    functions: rc.functions.length,
    triggerShape: Object.keys(trigger).sort(),
    type: trigger.type,
    cron: trigger.config,
    cronFields: cronFields.length,
    others: rc.functions.filter((item) => item.name !== 'xiai-user-token' && item.triggers).length
  })
}

/* H8：逐行监管日志（`_id` ＋ `freed_bytes`）＋ 整轮汇总。 */
resetWorld()
{
  seedProduct('img-sweep-h8a', { bytes: 111 })
  seedProduct('img-sweep-h8b', { bytes: 222 })
  seedProduct('img-sweep-h8c', { bytes: 333 })
  facesMap().set('fc-h8c', { _id: 'fc-h8c', kind: 'FACE', face_image_id: 'img-sweep-h8c' })
  const mark = logLines.length
  const reply = await runSweep()
  const lines = logsSince(mark)
  const deletedLines = lines.filter((line) => line.event === 'aiEnhanceSweep.row.deleted')
  const keptLines = lines.filter((line) => line.event === 'aiEnhanceSweep.row.kept')
  const doneLines = lines.filter((line) => line.event === 'aiEnhanceSweep.round.done')
  const stalledLines = lines.filter((line) => line.event === 'aiEnhanceSweep.round.stalled')
  check('H8', '⑦④ **逐行监管日志**：每删一行记 `aiEnhanceSweep.row.deleted` 且字段必含 **`_id` 与 `freed_bytes`**（2 行 ⇒ 2 条，值如实 111 / 222）；保留行记 `aiEnhanceSweep.row.kept`；整轮记 `aiEnhanceSweep.round.done` 汇总 6 计数；未满页（scanned:3）⇒ **零 `stalled` 日志**', {
    deletedLines: 2,
    keptLines: 1,
    doneLines: 1,
    ids: ['img-sweep-h8a', 'img-sweep-h8b'],
    freed: [111, 222],
    done: { scanned: 3, deleted: 2, kept_referenced: 1, freed_bytes: 333, objects_deleted: 2 },
    replyDeleted: 2,
    replyKept: 1,
    stalledLines: 0
  }, {
    deletedLines: deletedLines.length,
    keptLines: keptLines.length,
    doneLines: doneLines.length,
    ids: deletedLines.map((line) => line._id),
    freed: deletedLines.map((line) => line.freed_bytes),
    done: doneLines.length === 1
      ? {
        scanned: doneLines[0].scanned,
        deleted: doneLines[0].deleted,
        kept_referenced: doneLines[0].kept_referenced,
        freed_bytes: doneLines[0].freed_bytes,
        objects_deleted: doneLines[0].objects_deleted
      }
      : null,
    replyDeleted: reply.deleted,
    replyKept: reply.kept_referenced,
    stalledLines: stalledLines.length
  })
}

/* H9：全程零计费（清扫面零扣费零退款）。 */
{
  check('H9', '⑦ 全套**零计费**（`ledger.chargePoints` / `refundPoints` 全程零调用）', { charges: 0, refunds: 0 }, { charges: chargeSpy.calls, refunds: refundSpy.calls })
}

/* ===========================================================================
  I 段：分流 —— Type/TriggerName 进清扫、**带 op 一律不进**（⑨）
  =========================================================================== */
section('I', '分流：event.Type === TriggerName 且无 op ⇒ 进清扫；任何带 op 的请求（含非字符串、含 Timer/TriggerName）都不进')

/* I1：判据矩阵（纯函数，逐格）。 */
{
  const matrix = [
    { event: { Type: 'Timer', TriggerName: 'ai-enhance-sweep-daily', Time: '1700000000000' }, expect: true },
    { event: { Type: 'Timer' }, expect: true },
    { event: { TriggerName: 'ai-enhance-sweep-daily' }, expect: true },
    { event: { action: 'verify', op: 'ai-enhance-discard' }, expect: false },
    { event: { op: 'ai-enhance-face', payload: {} }, expect: false },
    { event: { Type: 'Timer', op: 'anything' }, expect: false },
    { event: { Type: 'Timer', op: '' }, expect: true },
    { event: { TriggerName: 't', op: 'listBooks' }, expect: false },
    { event: { TriggerName: 't', op: 123 }, expect: false },
    { event: { action: 'public', op: 'listSealCards' }, expect: false },
    { event: { action: 'verify' }, expect: false },
    { event: {}, expect: false },
    { event: null, expect: false },
    { event: 'Timer', expect: false }
  ]
  const actual = matrix.map((item) => fn.isTimerSweepEvent(item.event))
  check('I1', "⑨ 分流判据矩阵（14 格）：`Type:'Timer'` ／ `TriggerName` 无 `op` ⇒ `true`；**带 `op`（含非字符串 op、含同时带 `Type` / `TriggerName`）恒 `false`**；普通请求 / 非对象 ⇒ `false`", matrix.map((item) => item.expect), actual)
}

/* I2：行为 —— `Type:'Timer'` 真进清扫并删行。 */
resetWorld()
{
  const seed = seedProduct('img-sweep-i2', { bytes: 4096 })
  const reply = await runMain({ Type: 'Timer', TriggerName: 'ai-enhance-sweep-daily', Time: String(NOW) })
  check('I2', '⑨ `exports.main({Type:\'Timer\', TriggerName:…})` ⇒ **走清扫**：恰 6 键、`ok:true`、行与对象都删（`scanned:1`、`deleted:1`、`freed_bytes:4096`）', {
    keys: REPLY_KEYS.join(','),
    ok: true,
    scanned: 1,
    deleted: 1,
    objects_deleted: 1,
    freed_bytes: 4096,
    rowGone: true,
    objectGone: true
  }, {
    keys: replyShape(reply),
    ok: reply.ok,
    scanned: reply.scanned,
    deleted: reply.deleted,
    objects_deleted: reply.objects_deleted,
    freed_bytes: reply.freed_bytes,
    rowGone: !imagesMap().has('img-sweep-i2'),
    objectGone: !objectPresent(seed.key)
  })
}

/* I3：行为 —— 仅 `TriggerName`（无 `Type`、无 `op`）也进清扫。 */
resetWorld()
{
  seedProduct('img-sweep-i3')
  const reply = await runMain({ TriggerName: 'ai-enhance-sweep-daily' })
  check('I3', '⑨ `exports.main({TriggerName:…})`（无 `Type`、无 `op`）⇒ 走清扫（`ok:true`、`deleted:1`）', {
    keys: REPLY_KEYS.join(','),
    deleted: 1,
    rowGone: true
  }, {
    keys: replyShape(reply),
    deleted: reply.deleted,
    rowGone: !imagesMap().has('img-sweep-i3')
  })
}

/* I4：行为 —— 带 op 的请求一律不进（四条路各一）。 */
resetWorld()
{
  seedProduct('img-sweep-i4', { bytes: 4096 })
  const cases = [
    { label: 'action:verify ＋ op', event: { action: 'verify', op: 'ai-enhance-discard', payload: { image_id: 'img-sweep-i4' } } },
    { label: 'Timer ＋ op', event: { Type: 'Timer', op: 'anything' } },
    { label: 'TriggerName ＋ op', event: { TriggerName: 'ai-enhance-sweep-daily', op: 'anything' } },
    { label: '公开读 op', event: { action: 'public', op: 'listSealCards' } },
    { label: '空 action（普通请求）', event: {} }
  ]
  const readouts = []
  for (const item of cases) {
    const reply = await runMain(item.event)
    readouts.push({ label: item.label, hasScanned: Object.prototype.hasOwnProperty.call(reply, 'scanned'), isSweepShape: replyShape(reply) === REPLY_KEYS.join(',') })
  }
  check('I4', '⑨ **任何带 `op` 的请求任何情况下都不进清扫**（四条 op 路 ＋ 普通空请求）：回包**都不含 `scanned`**、都不是清扫 6 键形态；且**期间零删行零删对象**（种入的行与对象原封）', {
    notSweep: [{ label: 'action:verify ＋ op', hasScanned: false, isSweepShape: false }, { label: 'Timer ＋ op', hasScanned: false, isSweepShape: false }, { label: 'TriggerName ＋ op', hasScanned: false, isSweepShape: false }, { label: '公开读 op', hasScanned: false, isSweepShape: false }, { label: '空 action（普通请求）', hasScanned: false, isSweepShape: false }],
    rowStillThere: true,
    objectStillThere: true,
    rowDeletes: 0,
    storageDeletes: 0
  }, {
    notSweep: readouts,
    rowStillThere: imagesMap().has('img-sweep-i4'),
    objectStillThere: objectPresent(keyOf(digestOf('img-sweep-i4'))),
    rowDeletes: rowDeletesOn('xiai_images'),
    storageDeletes: storageDeletes.length
  })
}

/* ===========================================================================
  J 段：批量引用读次数上界（② 派单补断言；n ＝ 1 / 50 / 120 三例）
  =========================================================================== */
section('J', '引用三面批量读（$in 分块 ≤50 ＋ 边款一次性扫）：读次数 = ceil(n/50)×2+1（n=1 / 50 / 120）；块覆盖全量候选、每块 ≤50、语义与逐行等价（全清干净）')

for (const n of [1, 50, 120]) {
  resetWorld()
  for (let i = 0; i < n; i += 1) {
    const id = `img-sweep-j-${n}-${String(i).padStart(4, '0')}`
    seedProduct(id, { tag: `j-${n}-${i}`, bytes: 10 })
  }
  const reply = await runSweep({ nowMs: NOW })
  const chunks = Math.ceil(n / sweep.REFERENCE_CHUNK_LIMIT)
  const faceCalls = whereCallsOf('xiai_faces')
  const edgeCalls = faceCalls.filter((call) => call.match && call.match.kind === 'EDGE')
  const faceInCalls = faceCalls.filter((call) => call.match && call.match.face_image_id && Array.isArray(call.match.face_image_id.$in))
  const bookInCalls = whereCallsOf('xiai_books').filter((call) => call.match && call.match.cover_image_id && Array.isArray(call.match.cover_image_id.$in))
  const faceUnion = faceInCalls.flatMap((call) => call.match.face_image_id.$in)
  const bookUnion = bookInCalls.flatMap((call) => call.match.cover_image_id.$in)
  const maxChunk = Math.max(0, ...faceInCalls.map((call) => call.match.face_image_id.$in.length), ...bookInCalls.map((call) => call.match.cover_image_id.$in.length))
  check(`J${n}`, `② n=${n}：引用读次数 ＝ ceil(${n}/50)×2＋1 ＝ ${chunks * 2 + 1}（faces ${chunks + 1} ＝ 1 次边款扫描 ＋ ${chunks} 块；books ${chunks} 块）；` + '`$in` 块数恰 ' + `${chunks}、每块 ≤50、块并集覆盖全部 ${n} 个候选编号；语义与逐行等价 ⇒ ${n} 行全清（deleted:${n}、kept:0）`, {
    deleted: n,
    kept: 0,
    referenceReads: chunks * 2 + 1,
    facesReads: chunks + 1,
    booksReads: chunks,
    edgeScans: 1,
    faceChunks: chunks,
    bookChunks: chunks,
    maxChunk: Math.min(n, sweep.REFERENCE_CHUNK_LIMIT),
    faceUnion: n,
    bookUnion: n
  }, {
    deleted: reply.deleted,
    kept: reply.kept_referenced,
    referenceReads: readsOf('xiai_faces') + readsOf('xiai_books'),
    facesReads: readsOf('xiai_faces'),
    booksReads: readsOf('xiai_books'),
    edgeScans: edgeCalls.length,
    faceChunks: faceInCalls.length,
    bookChunks: bookInCalls.length,
    maxChunk,
    faceUnion: faceUnion.length,
    bookUnion: bookUnion.length
  })
}

/* =========================================================================== *
  收尾
 * =========================================================================== */
console.log(
  JSON.stringify({
    summary: { total, passed, failed: total - passed },
    sections: sectionStats,
    failed_ids: failedIds,
    note: '离线自检：不连云端、不写生产数据；注入缝＝ops DB 缝（含读失败注入）＋ ops 对象存储删除缝；全程零计费。'
  })
)
process.exit(total === passed ? 0 : 1)
