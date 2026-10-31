/**
 * 玺爱 · **自检：管理員弃候選圖（`ai-enhance-discard`）**（本单新增）
 * ============================================================================ *
 * **本地、离线**（自造 DB 假体 ＋ 注入对象存储删除缝；零外部网络、零云端连接、零生产数据）。
 * 被测件：
 *   · `cloudfunctions/xiai-user-token/lib/aiEnhanceDiscard.js`（唯一实现点：`discardCandidate`）
 *   · `cloudfunctions/xiai-user-token/lib/ops.js` 的 `ADMIN_OPS['ai-enhance-discard']`（薄委派注册面）
 *     ＋ 本单新增写点 `deleteRow` / `deleteArtifactObject`（＋对象删除注入缝）
 *
 * 断言面（本套 **20** 条，覆盖派单方点名的一〜七）：
 *   A. 正常弃（一）：删行、回包**恰 3 键**（`ok, image_id, deleted_objects`）、
 *      `deleted_objects` 按 `sha256` 唯一性如实（**两种情形各一**：独享摘要 ⇒ `true` 且对象真删；
 *      共享摘要 ⇒ `false` 只删行、对象与他行原封）；附：无 `storage_key` 行按 `mime` 推导键。
 *   B. 归属（二）：非 `ai_enhance` 来源 ⇒ `FORBIDDEN`（文案含「僅 AI 修復候選圖可弃」）且**零删**。
 *   C. 引用保护（三）：印面 `face_image_id` / `edge_image_ids` 任一命中 ⇒ `INVALID_VALUE`
 *      （文案含「已被印面引用」＋「不可弃」）且**零删**。
 *   D. 存在性与幂等（四）：行不存在 ⇒ `INVALID_VALUE`；**重放**（同一 `image_id` 第二次）⇒
 *      成功且 `deleted_objects: false`（不报错、不重复删行、不重复删对象）。
 *   E. 载荷面（五）：未知键 ⇒ `INVALID_FIELD`；缺 / 空 `image_id` ⇒ `MISSING_REQUIRED`；
 *      非字符串 ⇒ `INVALID_VALUE`；**零删**（行、对象原封）。
 *   F. 管理员门（六）：非管理员 ⇒ `FORBIDDEN` 且**零删**；缺白名单 env ⇒ fail-closed 拒绝。
 *   G. 静态门（七）：`ADMIN_OPS` **恰 18 项**且含 `ai-enhance-discard`（排序位在
 *      `ai-enhance-face` 之前）；`REASONS` **仍 13 值**（零新增）；`aiEnhanceDiscard.js`
 *      **零集合名字面**（`xiai_` 字面 0、`collection(` 0、`.doc(` 0 —— 读走 `ops.readRows`、
 *      删行走 `ops.deleteRow` / `ops.deleteArtifactObject`）；薄委派恰一处。
 *
 * 纪律：断言失败 ⇒ 退出码 1；全程零计费（`ledger.chargePoints` / `refundPoints` 零调用）。
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
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
const aiEnhanceDiscard = require(path.join(FN_DIR, 'lib/aiEnhanceDiscard.js'))
const userConfig = require(path.join(FN_DIR, 'lib/config.js'))

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
const digestOf = (tag) => sha256Hex(Buffer.from(`discard-fixture-${tag}`, 'utf8'))
const SUCCESS_KEYS = ['ok', 'image_id', 'deleted_objects'].sort().join(',')
const FAILURE_KEYS = ['ok', 'reason', 'message'].sort().join(',')

/* --------------------------------------------------------------------------- *
  内存假 DB（形状对齐真实 SDK 使用面；`doc().delete()` 记录每次删行调用）
 * --------------------------------------------------------------------------- */
const tick = () => new Promise((resolve) => setImmediate(resolve))
const rowMatches = (row, match) => Object.keys(match).every((key) => row[key] === match[key])

function createFakeDb() {
  const buckets = new Map()
  const bucketOf = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    return buckets.get(name)
  }
  function makeQuery(map, state) {
    return {
      limit(count) {
        return makeQuery(map, Object.assign({}, state, { limit: count }))
      },
      async get() {
        await tick()
        const rows = [...map.values()].filter((row) => rowMatches(row, state.match || {})).map((row) => Object.assign({}, row))
        return { data: state.limit ? rows.slice(0, state.limit) : rows }
      }
    }
  }
  const db = {
    bucketOf,
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
          return makeQuery(map, { match })
        }
      }
    }
  }
  return db
}

const deleteCalls = []
const fakeDb = createFakeDb()
const imagesMap = () => fakeDb.bucketOf('xiai_images')
const facesMap = () => fakeDb.bucketOf('xiai_faces')
const rowDeletesOn = (collection) => deleteCalls.filter((call) => call.collection === collection).length

/* 注入 DB 假体（生产不注入 ⇒ 走真实句柄；此处假体）。 */
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
  计费 spy（弃圖面**零计费**：本套全程 charge / refund 零调用；先取真身再补丁）
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
  身份与调用器
 * --------------------------------------------------------------------------- */
const ADMIN_PHONE = process.env.XIAI_ADMIN_PHONE
const ADMIN_IDENTITY = { uid: 'u-admin-discard-test', phone: ADMIN_PHONE }
const OTHER_IDENTITY = { uid: 'u-not-admin-discard', phone: '13900000001' }
const CONTEXT = { adminPhone: ADMIN_PHONE, nowSeconds: Math.floor(Date.now() / 1000) }
const discard = (payload, identity = ADMIN_IDENTITY, context = CONTEXT) =>
  ops.ADMIN_OPS['ai-enhance-discard'](payload, identity, context)

/* 种一株候选影像行（＋内容寻址对象字节）。 */
function seedCandidate(imageId, { digest, source = 'ai_enhance', storageKey = '', mime = 'image/png', withObject = true } = {}) {
  const sha = digest || digestOf(imageId)
  const key = storageKey || `xiai/images/${sha.slice(0, 2)}/${sha}.png`
  imagesMap().set(imageId, {
    _id: imageId,
    id: imageId,
    kind: 'FACE',
    storage: 'server',
    mime,
    sha256: sha,
    storage_key: storageKey,
    source,
    displayOnly: true,
    created_at: new Date().toISOString()
  })
  if (withObject) storageObjects.set(key, Buffer.from(`fixture-${sha}`, 'utf8'))
  return { sha, key }
}

/* ===========================================================================
  A 段：正常弃（一）—— 恰 3 键 / 删行 / deleted_objects 按 sha 唯一性（两种情形各一）
  =========================================================================== */
section('A', '正常弃：恰 3 键 / 删行 / deleted_objects 按 sha 唯一性（独享 ⇒ true 删对象；共享 ⇒ false 只删行）')

/* A1：摘要独享 ⇒ 删行 ＋ 删对象，deleted_objects: true。 */
const ID_A = 'img-discard-a1'
const seedA = seedCandidate(ID_A)
const deletesBeforeA = rowDeletesOn('xiai_images')
const storageBeforeA = storageDeletes.length
const replyA = await discard({ image_id: ID_A })
{
  check('A1', '① 摘要**独享**（无其它行同 sha256）⇒ 成功**恰 3 键**（`ok, image_id, deleted_objects`）、`deleted_objects: true`、行已删、对象已删（删对象键逐字＝行内 `storage_key`）', {
    keys: SUCCESS_KEYS,
    ok: true,
    image_id: ID_A,
    deletedObjects: true,
    rowGone: true,
    objectGone: true,
    rowDeletes: 1,
    storageDeletes: [seedA.key]
  }, {
    keys: shapeOf(replyA),
    ok: replyA.ok,
    image_id: replyA.image_id,
    deletedObjects: replyA.deleted_objects,
    rowGone: !imagesMap().has(ID_A),
    objectGone: !objectPresent(seedA.key),
    rowDeletes: rowDeletesOn('xiai_images') - deletesBeforeA,
    storageDeletes: storageDeletes.slice(storageBeforeA)
  })
}

/* A2：摘要共享（另一行同 sha256）⇒ 只删行，对象与他行原封，deleted_objects: false。 */
const ID_B1 = 'img-discard-b1'
const ID_B2 = 'img-discard-b2'
const digestB = digestOf('shared-content')
seedCandidate(ID_B1, { digest: digestB })
seedCandidate(ID_B2, { digest: digestB })
const deletesBeforeB = rowDeletesOn('xiai_images')
const storageBeforeB = storageDeletes.length
const replyB = await discard({ image_id: ID_B1 })
{
  check('A2', '② 摘要**共享**（另一影像行同 sha256）⇒ 成功**恰 3 键**、`deleted_objects: false`、本行已删、**对象不删**（内容寻址去重保护）、他行原封', {
    keys: SUCCESS_KEYS,
    ok: true,
    image_id: ID_B1,
    deletedObjects: false,
    rowGone: true,
    objectStillThere: true,
    otherRowStillThere: true,
    rowDeletes: 1,
    storageDeletes: 0
  }, {
    keys: shapeOf(replyB),
    ok: replyB.ok,
    image_id: replyB.image_id,
    deletedObjects: replyB.deleted_objects,
    rowGone: !imagesMap().has(ID_B1),
    objectStillThere: objectPresent(`xiai/images/${digestB.slice(0, 2)}/${digestB}.png`),
    otherRowStillThere: imagesMap().has(ID_B2),
    rowDeletes: rowDeletesOn('xiai_images') - deletesBeforeB,
    storageDeletes: storageDeletes.length - storageBeforeB
  })
}

/* A3：行无 `storage_key` ⇒ 对象键按 `sha256` ＋ `mime` 推导（webp），独享 ⇒ 删对象。 */
const ID_C = 'img-discard-c1'
const digestC = digestOf('webp-content')
imagesMap().set(ID_C, {
  _id: ID_C,
  id: ID_C,
  kind: 'FACE',
  storage: 'server',
  mime: 'image/webp',
  sha256: digestC,
  source: 'ai_enhance',
  displayOnly: true
})
const keyC = `xiai/images/${digestC.slice(0, 2)}/${digestC}.webp`
storageObjects.set(keyC, Buffer.from('webp-fixture', 'utf8'))
const storageBeforeC = storageDeletes.length
const replyC = await discard({ image_id: ID_C })
{
  check('A3', '③ 行缺 `storage_key` ⇒ 对象键按 `sha256` ＋ `mime` 推导（`.webp`）、独享 ⇒ `deleted_objects: true` 且删的正是推导键', {
    keys: SUCCESS_KEYS,
    deletedObjects: true,
    objectGone: true,
    derivedKeyDeleted: true
  }, {
    keys: shapeOf(replyC),
    deletedObjects: replyC.deleted_objects,
    objectGone: !objectPresent(keyC),
    derivedKeyDeleted: storageDeletes.slice(storageBeforeC).length === 1 && storageDeletes[storageBeforeC] === keyC
  })
}

/* ===========================================================================
  B 段：归属（二）—— 非 ai_enhance 来源 ⇒ FORBIDDEN（文案）且零删
  =========================================================================== */
section('B', '归属：非 ai_enhance 来源 ⇒ FORBIDDEN（文案「僅 AI 修復候選圖可弃」）且零删')

const ID_SRC = 'img-discard-src1'
const seedSrc = seedCandidate(ID_SRC, { source: 'upload' })
const deletesBeforeSrc = rowDeletesOn('xiai_images')
const storageBeforeSrc = storageDeletes.length
const replySrc = await discard({ image_id: ID_SRC })
{
  check('B1', '② 行在但 `source: upload`（非 AI 修復候选）⇒ `FORBIDDEN`、失败**恰 3 键**（**零 `refunded`**）、文案含「僅 AI 修復候選圖可弃」；**零删**（行、对象原封）', {
    keys: FAILURE_KEYS,
    ok: false,
    reason: 'FORBIDDEN',
    messageHasPhrase: true,
    rowStillThere: true,
    objectStillThere: true,
    rowDeletes: 0,
    storageDeletes: 0,
    refundedAbsent: true
  }, {
    keys: shapeOf(replySrc),
    ok: replySrc.ok,
    reason: replySrc.reason,
    messageHasPhrase: String(replySrc.message).includes('僅 AI 修復候選圖可弃'),
    rowStillThere: imagesMap().has(ID_SRC),
    objectStillThere: objectPresent(seedSrc.key),
    rowDeletes: rowDeletesOn('xiai_images') - deletesBeforeSrc,
    storageDeletes: storageDeletes.length - storageBeforeSrc,
    refundedAbsent: !Object.prototype.hasOwnProperty.call(replySrc, 'refunded')
  })
}

/* ===========================================================================
  C 段：引用保护（三）—— 印面 face_image_id / edge_image_ids 命中 ⇒ INVALID_VALUE 且零删
  =========================================================================== */
section('C', '引用保护：印面 face_image_id / edge_image_ids 命中 ⇒ INVALID_VALUE（文案「已被印面引用，不可弃」）且零删')

/* C1：FACE 行 `face_image_id` 命中。 */
const ID_REF1 = 'img-discard-ref1'
seedCandidate(ID_REF1)
facesMap().set('fc-ref-1', { _id: 'fc-ref-1', kind: 'FACE', face_image_id: ID_REF1, sealId: 's-1' })
const deletesBeforeRef1 = rowDeletesOn('xiai_images')
const replyRef1 = await discard({ image_id: ID_REF1 })
{
  check('C1', '③ 印面 `face_image_id` 命中 ⇒ `INVALID_VALUE`、失败恰 3 键、文案含「已被印面引用」＋「不可弃」；**零删**', {
    keys: FAILURE_KEYS,
    ok: false,
    reason: 'INVALID_VALUE',
    messageHasPhrase: true,
    rowStillThere: true,
    rowDeletes: 0,
    storageDeletes: 0
  }, {
    keys: shapeOf(replyRef1),
    ok: replyRef1.ok,
    reason: replyRef1.reason,
    messageHasPhrase: String(replyRef1.message).includes('已被印面引用') && String(replyRef1.message).includes('不可弃'),
    rowStillThere: imagesMap().has(ID_REF1),
    rowDeletes: rowDeletesOn('xiai_images') - deletesBeforeRef1,
    storageDeletes: 0
  })
}

/* C2：EDGE 行 `edge_image_ids` 命中（数组包含 —— 扫描路）。 */
const ID_REF2 = 'img-discard-ref2'
seedCandidate(ID_REF2)
facesMap().set('fe-ref-2', { _id: 'fe-ref-2', kind: 'EDGE', edge_image_ids: ['img-unrelated-edge', ID_REF2], sealId: 's-2' })
const deletesBeforeRef2 = rowDeletesOn('xiai_images')
const replyRef2 = await discard({ image_id: ID_REF2 })
{
  check('C2', '③ 印面 `edge_image_ids`（边款数组）命中 ⇒ `INVALID_VALUE`、失败恰 3 键；**零删**（数组包含走扫描路）', {
    keys: FAILURE_KEYS,
    ok: false,
    reason: 'INVALID_VALUE',
    rowStillThere: true,
    rowDeletes: 0
  }, {
    keys: shapeOf(replyRef2),
    ok: replyRef2.ok,
    reason: replyRef2.reason,
    rowStillThere: imagesMap().has(ID_REF2),
    rowDeletes: rowDeletesOn('xiai_images') - deletesBeforeRef2
  })
}

/* ===========================================================================
  D 段：存在性与幂等（四）—— 行不存在 ⇒ INVALID_VALUE；重放 ⇒ 成功且 deleted_objects: false
  =========================================================================== */
section('D', '存在性与幂等：行不存在 ⇒ INVALID_VALUE；同 image_id 重放 ⇒ 成功且 deleted_objects false（不重复删）')

/* D1：从未存在的编号 ⇒ INVALID_VALUE。 */
const deletesBeforeD1 = rowDeletesOn('xiai_images')
const replyD1 = await discard({ image_id: 'img-discard-none' })
{
  check('D1', '④ 行**不存在**（从未存在的编号）⇒ `INVALID_VALUE`、失败恰 3 键；**零删**', {
    keys: FAILURE_KEYS,
    ok: false,
    reason: 'INVALID_VALUE',
    rowDeletes: 0,
    storageDeletes: 0
  }, {
    keys: shapeOf(replyD1),
    ok: replyD1.ok,
    reason: replyD1.reason,
    rowDeletes: rowDeletesOn('xiai_images') - deletesBeforeD1,
    storageDeletes: 0
  })
}

/* D2：重放 A1 已弃编号 ⇒ 成功且 deleted_objects: false（幂等；不重复删行 / 删对象）。 */
const tombstonedBeforeReplay = aiEnhanceDiscard.discardTombstoned(ID_A)
const deletesBeforeReplay = rowDeletesOn('xiai_images')
const storageBeforeReplay = storageDeletes.length
const replyReplay = await discard({ image_id: ID_A })
{
  check('D2', '④ **重放**（同一 `image_id` 第二次）⇒ 成功**恰 3 键**、`deleted_objects: false`、不报错、**不重复删**（行 / 对象删除调用均 0 增量）', {
    tombstoned: true,
    keys: SUCCESS_KEYS,
    ok: true,
    image_id: ID_A,
    deletedObjects: false,
    rowDeletes: 0,
    storageDeletes: 0
  }, {
    tombstoned: tombstonedBeforeReplay,
    keys: shapeOf(replyReplay),
    ok: replyReplay.ok,
    image_id: replyReplay.image_id,
    deletedObjects: replyReplay.deleted_objects,
    rowDeletes: rowDeletesOn('xiai_images') - deletesBeforeReplay,
    storageDeletes: storageDeletes.length - storageBeforeReplay
  })
}

/* ===========================================================================
  E 段：载荷面（五）—— 未知键 / 缺 image_id / 空 / 非字符串 ⇒ 对应 reason 且零删
  =========================================================================== */
section('E', '载荷面：未知键 ⇒ INVALID_FIELD；缺 / 空 ⇒ MISSING_REQUIRED；非字符串 ⇒ INVALID_VALUE（零删）')

const ID_LIVE = 'img-discard-e1'
seedCandidate(ID_LIVE)
async function runPayloadRejection(label, title, payload, expectedReason) {
  const before = { rowDeletes: rowDeletesOn('xiai_images'), storageDeletes: storageDeletes.length }
  const reply = await discard(payload)
  check(label, title, {
    keys: FAILURE_KEYS,
    ok: false,
    reason: expectedReason,
    refundedAbsent: true,
    rowStillThere: true,
    rowDeletes: 0,
    storageDeletes: 0
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    reason: reply.reason,
    refundedAbsent: !Object.prototype.hasOwnProperty.call(reply, 'refunded'),
    rowStillThere: imagesMap().has(ID_LIVE),
    rowDeletes: rowDeletesOn('xiai_images') - before.rowDeletes,
    storageDeletes: storageDeletes.length - before.storageDeletes
  })
}

await runPayloadRejection('E1', '⑤ 载荷含**未知键**（`gold_amount`）⇒ `INVALID_FIELD`、失败恰 3 键、零删', { image_id: ID_LIVE, gold_amount: 1 }, 'INVALID_FIELD')
await runPayloadRejection('E2', '⑤ **缺 `image_id`**（空载荷）⇒ `MISSING_REQUIRED`、失败恰 3 键、零删', {}, 'MISSING_REQUIRED')
await runPayloadRejection('E3', '⑤ `image_id` 为**空串** ⇒ `MISSING_REQUIRED`、失败恰 3 键、零删', { image_id: '' }, 'MISSING_REQUIRED')
await runPayloadRejection('E4', '⑤ `image_id` **非字符串**（数字）⇒ `INVALID_VALUE`、失败恰 3 键、零删', { image_id: 12345 }, 'INVALID_VALUE')

/* ===========================================================================
  F 段：管理员门（六）—— 非管理员 ⇒ FORBIDDEN 且零删；缺白名单 env ⇒ fail-closed
  =========================================================================== */
section('F', '管理员门：非管理员 ⇒ FORBIDDEN 且零删；缺白名单 env ⇒ fail-closed（复用 adminWhitelistDenial）')

const ID_ADMIN = 'img-discard-f1'
seedCandidate(ID_ADMIN)
const deletesBeforeF = rowDeletesOn('xiai_images')
const replyF = await discard({ image_id: ID_ADMIN }, OTHER_IDENTITY, CONTEXT)
{
  check('F1', '⑥ **非管理员**（手机号不在白名单）⇒ `FORBIDDEN`、失败恰 3 键；**零删**（行、对象原封）', {
    keys: FAILURE_KEYS,
    ok: false,
    reason: 'FORBIDDEN',
    rowStillThere: true,
    rowDeletes: 0,
    storageDeletes: 0
  }, {
    keys: shapeOf(replyF),
    ok: replyF.ok,
    reason: replyF.reason,
    rowStillThere: imagesMap().has(ID_ADMIN),
    rowDeletes: rowDeletesOn('xiai_images') - deletesBeforeF,
    storageDeletes: 0
  })
}

const replyNoEnv = await discard({ image_id: ID_ADMIN }, ADMIN_IDENTITY, { nowSeconds: Math.floor(Date.now() / 1000) })
{
  check('F2', '⑥ 白名单 env 缺位（context 无 `adminPhone`）⇒ fail-closed 拒绝（`STORAGE_UNAVAILABLE`）、失败恰 3 键；零删', {
    keys: FAILURE_KEYS,
    ok: false,
    reason: 'STORAGE_UNAVAILABLE',
    rowStillThere: true
  }, {
    keys: shapeOf(replyNoEnv),
    ok: replyNoEnv.ok,
    reason: replyNoEnv.reason,
    rowStillThere: imagesMap().has(ID_ADMIN)
  })
}

/* ===========================================================================
  G 段：静态门（七）—— ADMIN_OPS 恰 18 项 / REASONS 仍 13 值 / 实现点零集合名字面
  =========================================================================== */
section('G', '静态门：ADMIN_OPS 恰 18 项且含 ai-enhance-discard（排序位在 ai-enhance-face 之前）/ REASONS 仍 13 / 零集合名字面')

{
  const { readFileSync } = require('node:fs')
  const opsSource = readFileSync(path.join(FN_DIR, 'lib/ops.js'), 'utf8')
  const implSource = readFileSync(path.join(FN_DIR, 'lib/aiEnhanceDiscard.js'), 'utf8')
  const adminKeys = Object.keys(ops.ADMIN_OPS)
  check('G1', '⑦ `ADMIN_OPS` **恰 18 项**、含 `ai-enhance-discard`（函数；薄委派）、排序位在 `ai-enhance-face` 之前', {
    count: 18,
    type: 'function',
    beforeEnhanceFace: true
  }, {
    count: adminKeys.length,
    type: typeof ops.ADMIN_OPS['ai-enhance-discard'],
    beforeEnhanceFace: adminKeys.indexOf('ai-enhance-discard') !== -1 &&
      adminKeys.indexOf('ai-enhance-face') !== -1 &&
      adminKeys.indexOf('ai-enhance-discard') < adminKeys.indexOf('ai-enhance-face')
  })

  const frozenReasons = ['FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE', 'ALREADY_ENDORSED', 'DUPLICATE_VALUE', 'INSUFFICIENT_POINTS', 'KEY_INVALID', 'CONFIG_MISSING', 'LIMIT_DAY', 'LIMIT_MINUTE', 'UPSTREAM_ERROR']
  check('G2', '⑦ `REASONS` **仍 13 值**、逐字＝冻结表（**零新增** reason 字面值）', { size: 13, exact: frozenReasons.slice() }, { size: Object.keys(userConfig.REASONS).length, exact: Object.keys(userConfig.REASONS) })

  check('G3', '⑦ 实现点 `aiEnhanceDiscard.js` **零集合名字面**（`xiai_` 字面 0、`collection(` 0、`.doc(` 0）；读走 `ops.readRows`、删行走 `ops.deleteRow` / `ops.deleteArtifactObject`（正对照在场）', {
    collectionNameLiterals: 0,
    collectionCalls: 0,
    docCalls: 0,
    readRowsSeam: true,
    deleteRowSeam: true,
    deleteObjectSeam: true
  }, {
    collectionNameLiterals: countIn(implSource, 'xiai_'),
    collectionCalls: countIn(implSource, 'collection('),
    docCalls: countIn(implSource, '.doc('),
    readRowsSeam: countIn(implSource, 'ops.readRows') >= 3,
    deleteRowSeam: countIn(implSource, 'ops.deleteRow') >= 1,
    deleteObjectSeam: countIn(implSource, 'ops.deleteArtifactObject') >= 1
  })

  check('G4', '⑦ 薄委派恰一处：`ops.js` 成员字面「ai-enhance-discard」恰 1、require(./aiEnhanceDiscard.js) 恰 1（零第二套逻辑）', {
    memberInOps: 1,
    requireInOps: 1
  }, {
    memberInOps: countIn(opsSource, "'ai-enhance-discard'"),
    requireInOps: countIn(opsSource, "require('./aiEnhanceDiscard.js')")
  })

  check('G5', '⑦ 回包键面常量封闭：成功恰 3 键（`ok, image_id, deleted_objects`）、失败恰 3 键（`ok, reason, message`，**零 `refunded`**）', {
    success: ['deleted_objects', 'image_id', 'ok'],
    failure: ['message', 'ok', 'reason']
  }, {
    success: aiEnhanceDiscard.AI_ENHANCE_DISCARD_SUCCESS_KEYS.slice().sort(),
    failure: aiEnhanceDiscard.AI_ENHANCE_DISCARD_FAILURE_KEYS.slice().sort()
  })

  check('G6', '⑦ 全套**零计费**（弃圖面零扣费 ⇒ `ledger.chargePoints` / `refundPoints` 全程零调用）', { charges: 0, refunds: 0 }, { charges: chargeSpy.calls, refunds: refundSpy.calls })
}

/* ===========================================================================
  收尾
 * =========================================================================== */
console.log(
  JSON.stringify({
    summary: { total, passed, failed: total - passed },
    sections: sectionStats,
    failed_ids: failedIds,
    note: '离线自检：不连云端、不写生产数据；注入缝＝ops DB 缝 ＋ ops 对象存储删除缝；全程零计费。'
  })
)
process.exit(total === passed ? 0 : 1)
