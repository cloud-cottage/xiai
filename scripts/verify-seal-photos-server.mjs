/**
 * 玺爱 · **自检：實物照片云端化（服务端五 op）**
 * ===================================================================
 * **本地、离线**（自造 DB 假体注入 `ops.setOpsDbProvider` ＋ 令牌本地现签 `lib/sign-test-token.mjs`
 * ＋ 静态门 ＋ 两条内存变异负对照；零外部网络、零云端连接、零生产数据）。被测件：
 *   · `cloudfunctions/xiai-user-token/lib/ops.js`    —— 集合登记 `xiai_sealPhotos`（22 → 23）、
 *     `OPTIONAL_READ_COLLECTIONS` 白名单、四张载荷封闭键面、行面 / 公开投影键面、值域与上限常量、
 *     `sealPhotoDocId`（确定性文档键）／`sealPhotoRowOf`／`sealPhotoPublicRowOf`／
 *     `sortSealPhotoRows`／`listSealPhotoRows`（公开面与管理面**同一读取单点**）／
 *     `sealPhotoCreateValueDenial`／`sealPhotoIdDenial`、`OPS.createSealPhoto`、
 *     三个 `ADMIN_OPS`（`listSealPhotosAdmin` / `setSealPhotoHidden` / `deleteSealPhoto`）；
 *   · `cloudfunctions/xiai-user-token/lib/sealCards.js` —— `PUBLIC_OPS` 7 → 8（`listSealPhotos` 薄委派）；
 *   · `cloudfunctions/xiai-user-token/index.js`       —— 两个按 op 收窄的读数透传块
 *     （`listSealPhotosAdmin` → `rows`/`count`/`truncated`；`deleteSealPhoto` → `deleted`/`object_retained`）。
 *
 * 断言面（覆盖派单方点名的全部条目）：
 *   A. 匿名 `listSealPhotos`：可用、**只回 `hidden !== true`**、公开投影**不含 `created_by`**、
 *      恰 12 键、按 `created_at` **升序**、`seal_id` 过滤、缺键 ⇒ `MISSING_REQUIRED` 零读、
 *      超 200 如实 `truncated: true`（不静默截断）；
 *   B. 管理员 `listSealPhotosAdmin`：全量含 `hidden`、每行恰 13 键**含 `created_by`**、同上限；
 *      非管理员 ⇒ `FORBIDDEN`（管理员门在第一行 ⇒ 零写）；
 *   C. `createSealPhoto`：未登录 ⇒ `FORBIDDEN` 零写；`sha256` 非 64 位小写 hex ／
 *      `bytes`·`width`·`height` 非正整数 ／ `mime` 非逐字 `image/tiff` ／ `note` 超 200 ／
 *      缺必填 ⇒ 各拒且**零写入零行**；先直调出 `plan`（零写）→ 端到端落行 →
 *      **同 seal+sha 重传幂等**（行数不变、同 `_id`、回包**无 `plan`**）；
 *   D. `setSealPhotoHidden`：非管理员拒且零写；切 `hidden` 后**公开列表消失、管理列表仍在**；
 *      行不存在 ⇒ 既有 `INVALID_VALUE`（`REASONS` 冻结 13 值、**无 `NOT_FOUND`** —— 已登记取舍）；
 *      切回 `false` 公开列表恢复（双向开关）；
 *   E. `deleteSealPhoto`：非管理员拒；行不存在 ⇒ `INVALID_VALUE`；成功后行消失、
 *      op 级回包**恰** `{ok:true,deleted:true,object_retained:true}`；端到端信封只多两个读数键；
 *   F. 静态门：集合登记恰 23 成员且 `sealPhotos` ＝ `xiai_seal_photos`、
 *      `OPTIONAL_READ_COLLECTIONS` 含 `sealPhotos`、`PUBLIC_OPS` 恰 8 员、`ADMIN_OPS` 恰 56 员、
 *      五 op 注册面（`OPS` / `ADMIN_OPS` / `PUBLIC_OPS` 互斥分派）、`index.js` 两个透传块各恰 1 处、
 *      行面 13 键 / 公开投影 12 键＝行面 − `created_by`（键面封闭负对照）、值域常量逐字；
 *   G. **两条内存变异负对照（磁盘零改动）**：① 去掉 `hidden !== true` 过滤 ⇒
 *      公开可见性断言**判红**；② `sealPhotoDocId` 派生加随机数 ⇒ 幂等断言**判红**。
 *
 * 纪律：断言失败 ⇒ 退出码 1；**不打印任何令牌原文 / 密钥**；缺 `XIAI_USER_TOKEN_SECRET`
 * ⇒ 打印 `SKIP（缺 …）`、exit 0（仓内惯例，不假绿）。
 */
/* **测试环境保护哨兵（硬防线）** —— 本套件只跑离线假体：置 `XIAI_NO_REAL_CARD=1`。
   跑任何套件前**不得** export 真 `CARD_API_KEY`（见 `scripts/README-test-net.md`）。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { createRequire } from 'node:module'
import Module from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'path'
/* **R-L3′**：令牌**本地现签**（真源 ＝ 云函数 `lib/token.js::issueToken`）＋ 缺密钥 SKIP。 */
import { requireSecretOrSkip, signUserToken, handleTestTokenSkip, USER_SECRET_ENV } from './lib/sign-test-token.mjs'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')
const OPS_PATH = path.join(FN_DIR, 'lib/ops.js')
const INDEX_PATH = path.join(FN_DIR, 'index.js')

/* ---------------------------------------------------------------------------
   身份（合成值；**先置白名单手机号再 require 配置 / 云函数** —— `readConfig` 只认这一次）
   --------------------------------------------------------------------------- */
const synth = (head, tail) => head + String(0).repeat(11 - head.length - tail.length) + tail
const ADMIN_PHONE = String(process.env.XIAI_ADMIN_PHONE || synth('130', '1')).trim()
let USER_PHONE = synth('138', '9')
let OTHER_PHONE = synth('139', '8')
if (USER_PHONE === ADMIN_PHONE) USER_PHONE = synth('136', '9')
if (OTHER_PHONE === ADMIN_PHONE || OTHER_PHONE === USER_PHONE) OTHER_PHONE = synth('135', '8')
process.env.XIAI_ADMIN_PHONE = ADMIN_PHONE

/* **密钥只从当前 shell 环境变量读**（不合成、不落盘、不打印）；缺 ⇒ SKIP、exit 0。 */
try {
  const userSecretValue = requireSecretOrSkip(USER_SECRET_ENV)
  process.env[USER_SECRET_ENV] = userSecretValue
} catch (error) {
  handleTestTokenSkip(error)
}
process.env.XIAI_USER_TOKEN_VERSION = process.env.XIAI_USER_TOKEN_VERSION || '1'

const fn = require(path.join(FN_DIR, 'index.js'))
const ops = require(OPS_PATH)
const sealCards = require(path.join(FN_DIR, 'lib/sealCards.js'))
const userConfig = require(path.join(FN_DIR, 'lib/config.js'))

/* ---------------------------------------------------------------------------
   断言 / 读数（与既有 70+ 个脚本同形；`canonical` 递归按键排序 ⇒ 键序不参与判定）
   --------------------------------------------------------------------------- */

let total = 0
let passed = 0
const failedIds = []
const sectionStats = {}

function section(name, title) {
  if (!sectionStats[name]) sectionStats[name] = { total: 0, passed: 0 }
  console.log(JSON.stringify({ section: name, title }))
}

function canonical(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical))
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = value[key]
        return acc
      }, {})
  )
}

function check(id, title, expected, actual) {
  total += 1
  const sec = id.slice(0, 1)
  if (!sectionStats[sec]) sectionStats[sec] = { total: 0, passed: 0 }
  const pass = canonical(expected) === canonical(actual)
  if (pass) passed += 1
  else failedIds.push(id)
  sectionStats[sec].total += 1
  if (pass) sectionStats[sec].passed += 1
  console.log(JSON.stringify({ id, case: title, pass, expected, actual }))
}

const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const envelopeShapeOf = (reply) => shapeOf(JSON.parse(JSON.stringify(reply)))
const countIn = (text, needle) => String(text).split(needle).length - 1
const sorted = (list) => list.slice().sort()
const reasonsOf = (reply) => (reply && reply.ok === true ? 'ok' : reply && reply.reason)

/* ---------------------------------------------------------------------------
   内存假 DB（形状对齐真实 SDK 使用面；`stats.writes` ＝ **零写入判据** 的机械计数）
   --------------------------------------------------------------------------- */

const tick = () => new Promise((resolve) => setImmediate(resolve))
const rowMatches = (row, match) => Object.keys(match).every((key) => row[key] === match[key])

function createFakeDb() {
  const buckets = new Map()
  const stats = { writes: 0, reads: 0 }
  const bucketOf = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    return buckets.get(name)
  }
  function makeQuery(map, state) {
    return {
      limit() {
        return makeQuery(map, state)
      },
      async get() {
        await tick()
        stats.reads += 1
        const rows = [...map.values()].filter((row) => rowMatches(row, state.match || {})).map((row) => Object.assign({}, row))
        return { data: rows }
      },
      async update(patch) {
        await tick()
        let updated = 0
        for (const row of map.values()) {
          if (rowMatches(row, state.match || {})) {
            Object.assign(row, patch)
            updated += 1
          }
        }
        stats.writes += 1
        return { updated }
      }
    }
  }
  return {
    stats,
    bucketOf,
    collection(name) {
      const map = bucketOf(name)
      return {
        doc(id) {
          return {
            async get() {
              await tick()
              stats.reads += 1
              const row = map.get(id)
              return { data: row ? Object.assign({}, row) : null }
            },
            async set(doc) {
              await tick()
              /* SDK 同款约束：`doc(id).set(data)` 见载荷带 `_id` ⇒ 抛 INVALID_PARAM。 */
              if (doc && typeof doc === 'object' && Object.prototype.hasOwnProperty.call(doc, '_id')) {
                const error = new Error('不能更新_id的值')
                error.code = 'INVALID_PARAM'
                throw error
              }
              map.set(id, Object.assign({ _id: id }, doc))
              stats.writes += 1
              return { updated: 1 }
            },
            async delete() {
              await tick()
              const existed = map.delete(id)
              stats.writes += 1
              return { deleted: existed ? 1 : 0 }
            }
          }
        },
        async add(doc) {
          await tick()
          const id = typeof doc._id === 'string' && doc._id !== '' ? doc._id : `gen-${map.size + 1}`
          if (map.has(id)) throw new Error('FAKE_DUPLICATE_ID')
          map.set(id, Object.assign({ _id: id }, doc))
          stats.writes += 1
          return { _id: id }
        },
        where(match) {
          return makeQuery(map, { match })
        }
      }
    }
  }
}

const fakeDb = createFakeDb()
const writesNow = () => fakeDb.stats.writes
const readsNow = () => fakeDb.stats.reads
const PHOTOS = ops.COLLECTIONS.sealPhotos
const photoRowsOf = (sealId) => {
  const rows = [...fakeDb.bucketOf(PHOTOS).values()]
  return sealId === undefined ? rows : rows.filter((row) => row.seal_id === sealId)
}
const seedPhoto = (row) => {
  fakeDb.bucketOf(PHOTOS).set(row._id, Object.assign({}, row))
  return row
}

ops.setOpsDbProvider(() => fakeDb)

/* ---------------------------------------------------------------------------
   身份（三枚**本地现签**用户令牌；密钥只在进程内存；管理员 op 走**手机号白名单**判据）
   --------------------------------------------------------------------------- */
const uidOf = (phone) => userConfig.uidOf(phone)
const ADMIN_TOKEN = signUserToken({ phone: ADMIN_PHONE }).token
const USER_TOKEN = signUserToken({ phone: USER_PHONE }).token
const OTHER_TOKEN = signUserToken({ phone: OTHER_PHONE }).token
const userIdentity = { uid: uidOf(USER_PHONE), phone: USER_PHONE }
const adminIdentity = { uid: uidOf(ADMIN_PHONE), phone: ADMIN_PHONE }
const adminContext = { adminPhone: ADMIN_PHONE, nowSeconds: Math.floor(Date.now() / 1000) }

const publicCall = (op, payload) => fn.main({ action: 'public', op, payload })
const verifyCall = (op, payload, token) => fn.main({ action: 'verify', op, token, payload })

/* ---------------------------------------------------------------------------
   行构造（13 键面逐键给值；种子行与写面行同一形状）
   --------------------------------------------------------------------------- */
const SHA_OK = 'a'.repeat(64)
const SHA_SEED = 'b'.repeat(64)
const isoAt = (index) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 86400000).toISOString()

function photoRow(init) {
  return Object.assign(
    {
      _id: '',
      seal_id: '',
      stamp_id: 'STAMP-SEED',
      sha256: SHA_SEED,
      bytes: 2048,
      mime: 'image/tiff',
      width: 100,
      height: 100,
      note: '',
      hidden: false,
      created_by: 'u-seed',
      created_at: isoAt(0),
      updated_at: isoAt(0)
    },
    init
  )
}

const SEAL_A = 'SEAL-A'
const SEAL_B = 'SEAL-B'
const SEAL_T = 'SEAL-T'
const SEAL_M = 'SEAL-M'

/* 先种数据（直接落 bucket，**不计入写计数** —— 写计数只记 op / persist 的落盘步）。 */
seedPhoto(photoRow({ _id: 'ph-a1', seal_id: SEAL_A, created_at: isoAt(1), updated_at: isoAt(1), created_by: 'u-user', note: '甲' }))
seedPhoto(photoRow({ _id: 'ph-a2', seal_id: SEAL_A, created_at: isoAt(2), updated_at: isoAt(2), created_by: 'u-user', hidden: true, note: '隱' }))
seedPhoto(photoRow({ _id: 'ph-a3', seal_id: SEAL_A, created_at: isoAt(3), updated_at: isoAt(3), created_by: 'u-admin', note: '丙' }))
seedPhoto(photoRow({ _id: 'ph-b1', seal_id: SEAL_B, created_at: isoAt(4), updated_at: isoAt(4), note: '乙' }))
/* 超上限样本：201 行全可见（`created_at` 严格升序 ⇒ 首 200 行确定）。 */
for (let i = 0; i <= 200; i += 1) {
  seedPhoto(
    photoRow({
      _id: `ph-t${String(i).padStart(3, '0')}`,
      seal_id: SEAL_T,
      created_at: new Date(Date.UTC(2026, 1, 1, 0, 0, 0) + i * 60000).toISOString(),
      updated_at: new Date(Date.UTC(2026, 1, 1, 0, 0, 0) + i * 60000).toISOString()
    })
  )
}

const PUBLIC_ROW_KEYS = sorted(ops.SEAL_PHOTO_PUBLIC_ROW_KEYS)
const FULL_ROW_KEYS = sorted(ops.SEAL_PHOTO_ROW_KEYS)
const ascending = (rows) => rows.every((row, index) => index === 0 || String(rows[index - 1].created_at) <= String(row.created_at))

/* ===========================================================================
   A 段：匿名公开面 `listSealPhotos`
   =========================================================================== */
section('A', '匿名 listSealPhotos：只回可见行 / 公开投影零 created_by / created_at 升序 / 超 200 如实 truncated')

{
  const before = { writes: writesNow(), reads: readsNow() }
  const reply = await publicCall('listSealPhotos', { seal_id: SEAL_A })
  const rows = Array.isArray(reply.rows) ? reply.rows : []
  check('A1', '① 匿名可调：`count` 恰 2（**只回 `hidden !== true`**、`ph-a2` 不在场）、`truncated:false`、每行**恰 12 键**且**无 `created_by`**、`created_at` **升序**、`seal_id` 过滤只回本印、恒零写', {
    ok: true,
    count: 2,
    truncated: false,
    ids: ['ph-a1', 'ph-a3'],
    ascending: true,
    hiddenGone: true,
    createdByGone: true,
    rowKeys: PUBLIC_ROW_KEYS.join(','),
    sealFiltered: true,
    writes: 0
  }, {
    ok: reply.ok === true,
    count: reply.count,
    truncated: reply.truncated,
    ids: rows.map((row) => row._id),
    ascending: ascending(rows),
    hiddenGone: rows.every((row) => row.hidden !== true),
    createdByGone: rows.every((row) => !Object.prototype.hasOwnProperty.call(row, 'created_by')),
    rowKeys: rows.length > 0 ? shapeOf(rows[0]) : '<no-row>',
    sealFiltered: rows.every((row) => row.seal_id === SEAL_A),
    writes: writesNow() - before.writes
  })

  /* 载荷门（封闭恰一键）：缺 `seal_id` ⇒ `MISSING_REQUIRED` ＋ **零读**（判定早于任何读）。 */
  const missBefore = { writes: writesNow(), reads: readsNow() }
  const missing = await publicCall('listSealPhotos', {})
  const missReads = readsNow() - missBefore.reads
  const missWrites = writesNow() - missBefore.writes
  const otherSeal = await publicCall('listSealPhotos', { seal_id: SEAL_B })
  check('A2', '① 载荷门：缺 `seal_id` ⇒ `MISSING_REQUIRED`（恰 3 键）且**零读零写**；`seal_id` 过滤：`SEAL-B` 恰 1 行 `ph-b1`、`truncated:false`', {
    miss: { reason: 'MISSING_REQUIRED', shape: 'message,ok,reason', reads: 0, writes: 0 },
    other: { ok: true, count: 1, ids: ['ph-b1'], truncated: false }
  }, {
    miss: {
      reason: missing.reason,
      shape: shapeOf(missing),
      reads: missReads,
      writes: missWrites
    },
    other: {
      ok: otherSeal.ok === true,
      count: otherSeal.count,
      ids: (otherSeal.rows || []).map((row) => row._id),
      truncated: otherSeal.truncated
    }
  })

  /* 超 200：**如实报** `truncated: true`、恰回 200 行（不静默截断、不多报）。 */
  const truncBefore = { writes: writesNow(), reads: readsNow() }
  const big = await publicCall('listSealPhotos', { seal_id: SEAL_T })
  const bigRows = Array.isArray(big.rows) ? big.rows : []
  check('A3', '① 超上限：201 行 ⇒ `count:200`、`truncated:**true**`（多读一枚作判据、**不静默截断**）、首行 `ph-t000` 末行 `ph-t199`（升序前 200）、恒零写', {
    ok: true,
    count: 200,
    truncated: true,
    first: 'ph-t000',
    last: 'ph-t199',
    ascending: true,
    writes: 0
  }, {
    ok: big.ok === true,
    count: big.count,
    truncated: big.truncated,
    first: bigRows.length > 0 ? bigRows[0]._id : '<no-row>',
    last: bigRows.length > 0 ? bigRows[bigRows.length - 1]._id : '<no-row>',
    ascending: ascending(bigRows),
    writes: writesNow() - truncBefore.writes
  })
}

/* ===========================================================================
   B 段：管理员面 `listSealPhotosAdmin`
   =========================================================================== */
section('B', 'listSealPhotosAdmin：全量含 hidden ＋ 13 键含 created_by；非管理员 ⇒ FORBIDDEN')

{
  const before = { writes: writesNow() }
  const admin = await verifyCall('listSealPhotosAdmin', { seal_id: SEAL_A }, ADMIN_TOKEN)
  const adminRows = Array.isArray(admin.rows) ? admin.rows : []
  check('B1', '② 管理员可调：`count` 恰 3（**全量含 `hidden`** —— `ph-a2` 在场）、每行**恰 13 键**且**含 `created_by`**、`created_at` 升序、`truncated:false`、恒零写', {
    ok: true,
    count: 3,
    truncated: false,
    ids: ['ph-a1', 'ph-a2', 'ph-a3'],
    hiddenPresent: true,
    createdByGone: false,
    rowKeys: FULL_ROW_KEYS.join(','),
    ascending: true,
    writes: 0
  }, {
    ok: admin.ok === true,
    count: admin.count,
    truncated: admin.truncated,
    ids: adminRows.map((row) => row._id),
    hiddenPresent: adminRows.some((row) => row.hidden === true),
    createdByGone: adminRows.some((row) => !Object.prototype.hasOwnProperty.call(row, 'created_by')),
    rowKeys: adminRows.length > 0 ? shapeOf(adminRows[0]) : '<no-row>',
    ascending: ascending(adminRows),
    writes: writesNow() - before.writes
  })

  const gateBefore = { writes: writesNow() }
  const denied = await verifyCall('listSealPhotosAdmin', { seal_id: SEAL_A }, OTHER_TOKEN)
  check('B2', '② 非管理员 ⇒ `FORBIDDEN`（白名单是真授权判据；管理员门在第一行 ⇒ 恒零写）', {
    ok: false,
    reason: 'FORBIDDEN',
    shape: 'message,ok,reason',
    writes: 0
  }, {
    ok: denied.ok,
    reason: denied.reason,
    shape: shapeOf(denied),
    writes: writesNow() - gateBefore.writes
  })

  const truncBefore = { writes: writesNow() }
  const bigAdmin = await verifyCall('listSealPhotosAdmin', { seal_id: SEAL_T }, ADMIN_TOKEN)
  check('B3', '② 管理面与公开面**同一上限**：201 行 ⇒ `count:200`、`truncated:true`、恒零写', {
    ok: true,
    count: 200,
    truncated: true,
    writes: 0
  }, {
    ok: bigAdmin.ok === true,
    count: bigAdmin.count,
    truncated: bigAdmin.truncated,
    writes: writesNow() - truncBefore.writes
  })
}

/* ===========================================================================
   C 段：`createSealPhoto`（登录门 / 值域门零写入 / 确定性 `_id` 幂等）
   =========================================================================== */
section('C', 'createSealPhoto：未登录拒 / 值域六类各拒零写 / plan 只在新建轮 / 同 seal+sha 重传幂等')

{
  /* C1：未登录 ⇒ FORBIDDEN ＋ 零写零行。 */
  const before = { writes: writesNow() }
  const anon = await verifyCall('createSealPhoto', Object.assign({}, { seal_id: SEAL_A }), undefined)
  check('C1', '③ 未登录 ⇒ `FORBIDDEN`（恰 3 键）＋ **零写入**、集合零新行', {
    reason: 'FORBIDDEN',
    shape: 'message,ok,reason',
    writes: 0,
    rowsSealA: 3
  }, {
    reason: anon.reason,
    shape: shapeOf(anon),
    writes: writesNow() - before.writes,
    rowsSealA: photoRowsOf(SEAL_A).length
  })

  /* C2：值域门逐条（每条单独一次端到端调用；全部零写零行）。 */
  const basePayload = () => ({
    seal_id: 'SEAL-C',
    stamp_id: 'STAMP-C',
    sha256: SHA_OK,
    bytes: 204800,
    mime: 'image/tiff',
    width: 300,
    height: 300,
    note: '入冊測試'
  })
  const valueCases = [
    { tag: 'sha256 大写 64 位', patch: { sha256: 'A'.repeat(64) }, expect: 'INVALID_VALUE' },
    { tag: 'sha256 长度 63', patch: { sha256: 'a'.repeat(63) }, expect: 'INVALID_VALUE' },
    { tag: 'sha256 含非 hex', patch: { sha256: 'a'.repeat(63) + 'g' }, expect: 'INVALID_VALUE' },
    { tag: 'bytes = 0', patch: { bytes: 0 }, expect: 'INVALID_VALUE' },
    { tag: 'bytes 字符串', patch: { bytes: '204800' }, expect: 'INVALID_VALUE' },
    { tag: 'width = -1', patch: { width: -1 }, expect: 'INVALID_VALUE' },
    { tag: 'height = 1.5', patch: { height: 1.5 }, expect: 'INVALID_VALUE' },
    { tag: 'mime = image/png', patch: { mime: 'image/png' }, expect: 'INVALID_VALUE' },
    { tag: 'note 超 200 字', patch: { note: '甲'.repeat(201) }, expect: 'INVALID_VALUE' },
    { tag: '缺 stamp_id', patch: null, omit: ['stamp_id'], expect: 'MISSING_REQUIRED' },
    { tag: '缺 sha256', patch: null, omit: ['sha256'], expect: 'MISSING_REQUIRED' }
  ]
  const valueRows = []
  for (const item of valueCases) {
    const payload = basePayload()
    if (item.patch) Object.assign(payload, item.patch)
    if (item.omit) for (const key of item.omit) delete payload[key]
    const rowBefore = { writes: writesNow(), rows: photoRowsOf('SEAL-C').length }
    // eslint-disable-next-line no-await-in-loop
    const reply = await verifyCall('createSealPhoto', payload, USER_TOKEN)
    valueRows.push({
      tag: item.tag,
      got: reasonsOf(reply),
      shape: shapeOf(reply),
      writes: writesNow() - rowBefore.writes,
      rows: photoRowsOf('SEAL-C').length - rowBefore.rows
    })
  }
  check('C2', '③ 值域门逐条：sha256（大写 / 63 位 / 非 hex）、bytes（0 / 字符串）、width（-1）、height（1.5）、mime（非逐字 `image/tiff`）、note（201 字 > 200）⇒ `INVALID_VALUE`；缺 `stamp_id` / `sha256` ⇒ `MISSING_REQUIRED`；每条**恰 3 键、零写入、零新行**', {
    got: valueCases.map((item) => item.expect),
    shapes: valueCases.map(() => 'message,ok,reason'),
    writes: valueCases.map(() => 0),
    rows: valueCases.map(() => 0)
  }, {
    got: valueRows.map((row) => row.got),
    shapes: valueRows.map((row) => row.shape),
    writes: valueRows.map((row) => row.writes),
    rows: valueRows.map((row) => row.rows)
  })

  /* C3：直调首建 —— 产 `plan`（kind:set、id ＝ 确定性 `_id`）且**零写**（落盘在 index.js 唯一写点）。 */
  const directBefore = { writes: writesNow(), rows: photoRowsOf('SEAL-C').length }
  const firstOp = await ops.OPS.createSealPhoto(basePayload(), userIdentity)
  check('C3', '③ 首建直调：回包含 `plan`（`kind:"set"`、`collection` ＝ `xiai_seal_photos`、`id` ＝ `row._id`）、`row` 恰 13 键、`created_by` ＝ 令牌派生 uid、`hidden:false`；op 内**零写入零行**', {
    keys: 'ok,plan,row',
    kind: 'set',
    collection: 'xiai_seal_photos',
    idIsRowId: true,
    rowKeys: FULL_ROW_KEYS.join(','),
    createdByIsUid: true,
    hidden: false,
    writes: 0,
    rows: 0
  }, {
    keys: shapeOf(firstOp),
    kind: firstOp.plan && firstOp.plan.writes && firstOp.plan.writes[0] && firstOp.plan.writes[0].kind,
    collection: firstOp.plan && firstOp.plan.writes && firstOp.plan.writes[0] && firstOp.plan.writes[0].collection,
    idIsRowId: Boolean(firstOp.plan && firstOp.plan.writes && firstOp.plan.writes[0] && firstOp.plan.writes[0].id === firstOp.row._id),
    rowKeys: shapeOf(firstOp.row),
    createdByIsUid: firstOp.row.created_by === uidOf(USER_PHONE),
    hidden: firstOp.row.hidden,
    writes: writesNow() - directBefore.writes,
    rows: photoRowsOf('SEAL-C').length - directBefore.rows
  })

  /* C4：端到端首建（真信封 ＋ 真令牌 ＋ 假 DB ⇒ persist 唯一写点落 1 行）。 */
  const buildBefore = { writes: writesNow(), rows: photoRowsOf('SEAL-C').length }
  const built = await verifyCall('createSealPhoto', basePayload(), USER_TOKEN)
  check('C4', '③ 端到端首建：`ok:true`、信封 `docId` ＝ `row._id`、`row` 恰 13 键、`created_by` ＝ 本人 uid、恰落 1 行 1 写、信封**无 `plan`**（内部落盘计划零外传）', {
    ok: true,
    docIdIsRowId: true,
    rowKeys: FULL_ROW_KEYS.join(','),
    createdByIsUid: true,
    rows: 1,
    writes: 1,
    planInEnvelope: 0
  }, {
    ok: built.ok === true,
    docIdIsRowId: built.docId === (built.row && built.row._id),
    rowKeys: built.row ? shapeOf(built.row) : '<no-row>',
    createdByIsUid: Boolean(built.row) && built.row.created_by === uidOf(USER_PHONE),
    rows: photoRowsOf('SEAL-C').length - buildBefore.rows,
    writes: writesNow() - buildBefore.writes,
    planInEnvelope: countIn(JSON.stringify(built), '"plan"')
  })

  /* C5：同 seal+sha 重传 ⇒ 幂等：行数不变、同 `_id`、回包无 `plan`（端到端 ＋ op 级双证）。 */
  const redoBefore = { writes: writesNow(), rows: photoRowsOf('SEAL-C').length }
  const redo = await verifyCall('createSealPhoto', basePayload(), USER_TOKEN)
  const redoOp = await ops.OPS.createSealPhoto(basePayload(), userIdentity)
  check('C5', '③ 重传幂等：端到端重传 ⇒ 行数不变（1 → 1）、**零写**、同 `_id`、信封无 `plan`；op 级二调回包**恰 2 键 `ok,row`**（已存在 ⇒ 不产 `plan`）', {
    ok: true,
    rows: 1,
    writes: 0,
    sameId: true,
    planInEnvelope: 0,
    redoOpKeys: 'ok,row',
    redoOpSameId: true,
    rowsAfterOp: 1
  }, {
    ok: redo.ok === true,
    rows: photoRowsOf('SEAL-C').length,
    writes: writesNow() - redoBefore.writes,
    sameId: Boolean(redo.row) && redo.row._id === firstOp.row._id,
    planInEnvelope: countIn(JSON.stringify(redo), '"plan"'),
    redoOpKeys: shapeOf(redoOp),
    redoOpSameId: Boolean(redoOp.row) && redoOp.row._id === firstOp.row._id,
    rowsAfterOp: photoRowsOf('SEAL-C').length
  })
}

/* ===========================================================================
   D 段：`setSealPhotoHidden`（管理员门 / 可见性双向开关 / 行不存在取舍）
   =========================================================================== */
section('D', 'setSealPhotoHidden：非管理员零写拒 / 切 hidden 后公开消失管理仍在 / 不存在 ⇒ INVALID_VALUE')

{
  /* D1：非管理员 ⇒ FORBIDDEN ＋ 零写 ＋ 行未变。 */
  const before = { writes: writesNow(), hidden: fakeDb.bucketOf(PHOTOS).get('ph-a1').hidden }
  const denied = await verifyCall('setSealPhotoHidden', { photo_id: 'ph-a1', hidden: true }, OTHER_TOKEN)
  check('D1', '④ 非管理员 ⇒ `FORBIDDEN`（恰 3 键）＋ **零写入**、`ph-a1` 原样未动（`hidden` 仍 `false`）', {
    reason: 'FORBIDDEN',
    shape: 'message,ok,reason',
    writes: 0,
    unchanged: true,
    hidden: false
  }, {
    reason: denied.reason,
    shape: shapeOf(denied),
    writes: writesNow() - before.writes,
    unchanged: fakeDb.bucketOf(PHOTOS).get('ph-a1').hidden === before.hidden,
    hidden: fakeDb.bucketOf(PHOTOS).get('ph-a1').hidden
  })

  /* D2：管理员切 hidden=true ⇒ 回**公开投影行**（恰 12 键、无 created_by）、落 1 写。 */
  const setBefore = { writes: writesNow() }
  const set = await verifyCall('setSealPhotoHidden', { photo_id: 'ph-a1', hidden: true }, ADMIN_TOKEN)
  check('D2', '④ 管理员切 `hidden:true` ⇒ `ok:true`、回包 `row` 恰 **12 键公开投影**（无 `created_by`、`hidden:true`）、恰 1 写、行内 `hidden` 已生效', {
    ok: true,
    rowKeys: PUBLIC_ROW_KEYS.join(','),
    rowHidden: true,
    writes: 1,
    storedHidden: true
  }, {
    ok: set.ok === true,
    rowKeys: set.row ? shapeOf(set.row) : '<no-row>',
    rowHidden: Boolean(set.row) && set.row.hidden === true,
    writes: writesNow() - setBefore.writes,
    storedHidden: fakeDb.bucketOf(PHOTOS).get('ph-a1').hidden === true
  })

  /* D3：可见性开关生效 —— 公开列表消失、管理列表仍在。 */
  const pub = await publicCall('listSealPhotos', { seal_id: SEAL_A })
  const adm = await verifyCall('listSealPhotosAdmin', { seal_id: SEAL_A }, ADMIN_TOKEN)
  const pubIds = (pub.rows || []).map((row) => row._id)
  const admRows = adm.rows || []
  check('D3', '④ 切 `hidden` 后：公开列表**只剩 `ph-a3`**（`ph-a1` 消失、`ph-a2` 原本即隐）；管理列表**仍在 3 行**且 `ph-a1.hidden:true`', {
    publicIds: ['ph-a3'],
    publicCount: 1,
    adminCount: 3,
    adminHasPhA1: true,
    adminPhA1Hidden: true
  }, {
    publicIds: pubIds,
    publicCount: pub.count,
    adminCount: adm.count,
    adminHasPhA1: admRows.some((row) => row._id === 'ph-a1'),
    adminPhA1Hidden: admRows.some((row) => row._id === 'ph-a1' && row.hidden === true)
  })

  /* D4：行不存在 ⇒ 既有 `INVALID_VALUE`（`REASONS` 无 `NOT_FOUND` 的登记取舍）＋ 零写。 */
  const ghostBefore = { writes: writesNow() }
  const ghost = await verifyCall('setSealPhotoHidden', { photo_id: 'ph-nope', hidden: true }, ADMIN_TOKEN)
  check('D4', '④ 行不存在 ⇒ `INVALID_VALUE`（**函数 REASONS 冻结 13 值、无 `NOT_FOUND`** ⇒ 一律回落既有值；恰 3 键）＋ 零写入', {
    reason: 'INVALID_VALUE',
    shape: 'message,ok,reason',
    writes: 0
  }, {
    reason: ghost.reason,
    shape: shapeOf(ghost),
    writes: writesNow() - ghostBefore.writes
  })

  /* D5：切回 false ⇒ 公开列表恢复（双向开关，防「只会隐不会显」）。 */
  const backBefore = { writes: writesNow() }
  const back = await verifyCall('setSealPhotoHidden', { photo_id: 'ph-a1', hidden: false }, ADMIN_TOKEN)
  const pubBack = await publicCall('listSealPhotos', { seal_id: SEAL_A })
  check('D5', '④ 切回 `hidden:false` ⇒ 公开列表恢复 2 行（`ph-a1` 重新可见）、恰 1 写', {
    ok: true,
    publicIds: ['ph-a1', 'ph-a3'],
    writes: 1
  }, {
    ok: back.ok === true,
    publicIds: (pubBack.rows || []).map((row) => row._id),
    writes: writesNow() - backBefore.writes
  })
}

/* ===========================================================================
   E 段：`deleteSealPhoto`（管理员门 / 恰 3 键回包 / 行消失）
   =========================================================================== */
section('E', 'deleteSealPhoto：非管理员拒 / 不存在 ⇒ INVALID_VALUE / 成功恰 {ok,deleted,object_retained}')

{
  /* E1：非管理员 ⇒ FORBIDDEN ＋ 零写 ＋ 行仍在。 */
  const before = { writes: writesNow(), rows: photoRowsOf(SEAL_A).length }
  const denied = await verifyCall('deleteSealPhoto', { photo_id: 'ph-a1' }, OTHER_TOKEN)
  check('E1', '⑤ 非管理员 ⇒ `FORBIDDEN`（恰 3 键）＋ **零写入**、行仍在（3 行）', {
    reason: 'FORBIDDEN',
    shape: 'message,ok,reason',
    writes: 0,
    rows: 3
  }, {
    reason: denied.reason,
    shape: shapeOf(denied),
    writes: writesNow() - before.writes,
    rows: photoRowsOf(SEAL_A).length
  })

  /* E2：行不存在 ⇒ 既有 `INVALID_VALUE` ＋ 零删行。 */
  const ghostBefore = { writes: writesNow(), rows: photoRowsOf(SEAL_A).length }
  const ghost = await verifyCall('deleteSealPhoto', { photo_id: 'ph-nope' }, ADMIN_TOKEN)
  check('E2', '⑤ 行不存在 ⇒ `INVALID_VALUE`（同 `setSealPhotoHidden` 取舍）＋ 零写入、行数不变', {
    reason: 'INVALID_VALUE',
    shape: 'message,ok,reason',
    writes: 0,
    rows: 3
  }, {
    reason: ghost.reason,
    shape: shapeOf(ghost),
    writes: writesNow() - ghostBefore.writes,
    rows: photoRowsOf(SEAL_A).length
  })

  /* E3：op 级成功 —— 回包**恰 3 键**、行消失、恰 1 写（`deleteRow` 自带读回比对）。 */
  const delBefore = { writes: writesNow(), rows: photoRowsOf(SEAL_A).length }
  const deleted = await ops.ADMIN_OPS.deleteSealPhoto({ photo_id: 'ph-a1' }, adminIdentity, adminContext)
  check('E3', '⑤ op 级成功回包**恰 3 键 `{ok:true, deleted:true, object_retained:true}`**（对象本体不删、如实告知）、`ph-a1` 行消失（3 → 2）、恰 1 写', {
    keys: 'deleted,object_retained,ok',
    ok: true,
    deleted: true,
    objectRetained: true,
    rows: 2,
    writes: 1
  }, {
    keys: shapeOf(deleted),
    ok: deleted.ok === true,
    deleted: deleted.deleted === true,
    objectRetained: deleted.object_retained === true,
    rows: photoRowsOf(SEAL_A).length,
    writes: writesNow() - delBefore.writes
  })

  /* E4：端到端（真信封）—— `index.js` 按 op 收窄透传 `deleted` / `object_retained`；
     信封＝既有基座 11 键 ＋ 恰 2 个读数键（`rows`/`count`/`truncated` **零泄漏**）。 */
  const e2eBefore = { writes: writesNow() }
  const e2e = await verifyCall('deleteSealPhoto', { photo_id: 'ph-a3' }, ADMIN_TOKEN)
  const pubAfter = await publicCall('listSealPhotos', { seal_id: SEAL_A })
  const admAfter = await verifyCall('listSealPhotosAdmin', { seal_id: SEAL_A }, ADMIN_TOKEN)
  check('E4', '⑤ 端到端删行：信封**恰 13 键**（基座 11 ＋ `deleted`/`object_retained` 两读数）、两值皆 `true`、零 `rows`/`count`/`truncated` 泄漏；`ph-a3` 行消失（`SEAL-A` 仅余隐藏 `ph-a2` ＝ 1 行）、恰 1 写；公开列表剩 0 行、管理列表仍 1 行', {
    envelope: 'authority,deleted,docId,identity,identity_source,object_retained,ok,op,renewedExpiresAt,renewedToken,renewedTtlSeconds,serverNow,ver',
    deleted: true,
    objectRetained: true,
    rows: 1,
    writes: 1,
    publicCount: 0,
    adminCount: 1
  }, {
    envelope: envelopeShapeOf(e2e),
    deleted: e2e.deleted === true,
    objectRetained: e2e.object_retained === true,
    rows: photoRowsOf(SEAL_A).length,
    writes: writesNow() - e2eBefore.writes,
    publicCount: pubAfter.count,
    adminCount: admAfter.count
  })
}

/* ===========================================================================
   F 段：静态门
   =========================================================================== */
section('F', '静态门：集合登记 22→23 / 可选读白名单 / PUBLIC_OPS 8 / ADMIN_OPS 56 / 透传块 / 键面常量')

{
  const collections = Object.keys(ops.COLLECTIONS)
  check('F1', '⑥ 集合登记：`COLLECTIONS` **恰 23 成员**（22 → 23）、`sealPhotos` ＝ `xiai_seal_photos`、全部 `^xiai_` 前缀', {
    count: 23,
    sealPhotos: 'xiai_seal_photos',
    prefix: true
  }, {
    count: collections.length,
    sealPhotos: ops.COLLECTIONS.sealPhotos,
    prefix: collections.every((key) => /^xiai_/.test(ops.COLLECTIONS[key]))
  })

  /* `OPTIONAL_READ_COLLECTIONS` 未进导出面 ⇒ 按源码块解析（块首到块尾）。 */
  const opsSource = readFileSync(OPS_PATH, 'utf8')
  const optionalStart = opsSource.indexOf('const OPTIONAL_READ_COLLECTIONS = Object.freeze([')
  const optionalEnd = opsSource.indexOf('])', optionalStart)
  const optionalBlock = optionalStart === -1 || optionalEnd === -1 ? '' : opsSource.slice(optionalStart, optionalEnd)
  check('F2', '⑥ `OPTIONAL_READ_COLLECTIONS` 白名单**含 `COLLECTIONS.sealPhotos`**（「集合不存在 ≡ 零行」的可选读面；块内恰 7 个 `COLLECTIONS.*` 成员）', {
    parsed: true,
    hasSealPhotos: true,
    members: 7
  }, {
    parsed: optionalStart !== -1 && optionalEnd !== -1,
    hasSealPhotos: optionalBlock.indexOf('COLLECTIONS.sealPhotos') !== -1,
    members: (optionalBlock.match(/COLLECTIONS\./g) || []).length
  })

  const publicKeys = Object.keys(sealCards.PUBLIC_OPS)
  check('F3', '⑥ `PUBLIC_OPS` **恰 8 成员**（… `listSealImages` ＋ `listSealPhotos`〔本單〕）、全为函数、`listSealPhotos` 在表内', {
    count: 8,
    keys: ['catalogStats', 'getPersonCard', 'listPersonCards', 'listSealCards', 'listSealCovers', 'listSealImages', 'listSealPhotos', 'suggestAuthors'],
    allFunctions: true
  }, {
    count: publicKeys.length,
    keys: sorted(publicKeys),
    allFunctions: publicKeys.every((key) => typeof sealCards.PUBLIC_OPS[key] === 'function')
  })

  const adminKeys = Object.keys(ops.ADMIN_OPS)
  const userKeys = Object.keys(ops.OPS)
  check('F4', '⑥ 注册面分派：`ADMIN_OPS` **恰 56 员** 且含三个新 op；`createSealPhoto` ∈ `OPS` 且 ∉ `ADMIN_OPS`；三管理员 op ∉ `OPS`；`listSealPhotos` ∈ `PUBLIC_OPS` 且 ∉ `OPS`', {
    adminCount: 56,
    threeInAdmin: ['deleteSealPhoto', 'listSealPhotosAdmin', 'setSealPhotoHidden'],
    createInOps: true,
    createNotInAdmin: true,
    adminNotInOps: [],
    listNotInOps: true
  }, {
    adminCount: adminKeys.length,
    threeInAdmin: sorted(['deleteSealPhoto', 'listSealPhotosAdmin', 'setSealPhotoHidden'].filter((op) => Object.prototype.hasOwnProperty.call(ops.ADMIN_OPS, op))),
    createInOps: Object.prototype.hasOwnProperty.call(ops.OPS, 'createSealPhoto'),
    createNotInAdmin: !Object.prototype.hasOwnProperty.call(ops.ADMIN_OPS, 'createSealPhoto'),
    adminNotInOps: ['deleteSealPhoto', 'listSealPhotosAdmin', 'setSealPhotoHidden'].filter((op) => Object.prototype.hasOwnProperty.call(ops.OPS, op)),
    listNotInOps: !Object.prototype.hasOwnProperty.call(ops.OPS, 'listSealPhotos')
  })

  const indexSource = readFileSync(INDEX_PATH, 'utf8')
  check('F5', '⑥ `index.js` 两个读数透传块**各恰 1 处**且键名逐字：`listSealPhotosAdmin` → `rows`/`count`/`truncated`；`deleteSealPhoto` → `deleted`/`object_retained`', {
    adminBlock: 1,
    deleteBlock: 1,
    adminKeys: true,
    deleteKeys: true
  }, {
    adminBlock: indexSource.split("if (op === 'listSealPhotosAdmin')").length - 1,
    deleteBlock: indexSource.split("if (op === 'deleteSealPhoto')").length - 1,
    adminKeys: indexSource.indexOf("SEAL_PHOTO_ADMIN_LIST_READOUT_KEYS = ['rows', 'count', 'truncated']") !== -1,
    deleteKeys: indexSource.indexOf("SEAL_PHOTO_DELETE_READOUT_KEYS = ['deleted', 'object_retained']") !== -1
  })

  /* 键面封闭：行面 13 ＝ 公开 12 ＋ `created_by`；投影对残行仍封闭（不按行抄键）。 */
  const stubRow = ops.sealPhotoRowOf({ note: 'x' })
  const stubPublic = ops.sealPhotoPublicRowOf({ note: 'x' })
  check('F6', '⑥ 键面常量逐字：行面恰 13 键、公开投影恰 12 键 ＝ 行面 − `created_by`；两投影**键面封闭**（残行 `[{note}]` 仍恒 13 / 12 键、不按行抄键、公开投影无 `created_by`）', {
    rowKeys: ['_id', 'bytes', 'created_at', 'created_by', 'height', 'hidden', 'mime', 'note', 'seal_id', 'sha256', 'stamp_id', 'updated_at', 'width'],
    publicKeys: ['_id', 'bytes', 'created_at', 'height', 'hidden', 'mime', 'note', 'seal_id', 'sha256', 'stamp_id', 'updated_at', 'width'],
    rowCount: 13,
    publicCount: 12,
    closedRow: 13,
    closedPublic: 12,
    closedPublicHasCreatedBy: false
  }, {
    rowKeys: ops.SEAL_PHOTO_ROW_KEYS.slice().sort(),
    publicKeys: ops.SEAL_PHOTO_PUBLIC_ROW_KEYS.slice().sort(),
    rowCount: ops.SEAL_PHOTO_ROW_KEYS.length,
    publicCount: ops.SEAL_PHOTO_PUBLIC_ROW_KEYS.length,
    closedRow: Object.keys(stubRow).length,
    closedPublic: Object.keys(stubPublic).length,
    closedPublicHasCreatedBy: Object.prototype.hasOwnProperty.call(stubPublic, 'created_by')
  })

  const shaLow = ops.sealPhotoDocId('SEAL-C', SHA_OK)
  check('F7', '⑥ 值域与上限常量逐字：列表上限 200、note 上限 200、mime 逐字 `image/tiff`、前缀 `ph-`、sha256 只认 64 位小写 hex、确定性文档键（同入参同键、改 sha 即换键）', {
    maxRows: 200,
    noteMax: 200,
    mime: 'image/tiff',
    prefix: 'ph-',
    shaLower64: true,
    shaUpper64: false,
    shaShort63: false,
    docIdStable: true,
    docIdVaries: true
  }, {
    maxRows: ops.SEAL_PHOTO_LIST_MAX_ROWS,
    noteMax: ops.SEAL_PHOTO_NOTE_MAX_LENGTH,
    mime: ops.SEAL_PHOTO_MIME,
    prefix: ops.SEAL_PHOTO_ID_PREFIX,
    shaLower64: ops.SEAL_PHOTO_SHA256_PATTERN.test(SHA_OK),
    shaUpper64: ops.SEAL_PHOTO_SHA256_PATTERN.test('A'.repeat(64)),
    shaShort63: ops.SEAL_PHOTO_SHA256_PATTERN.test('a'.repeat(63)),
    docIdStable: ops.sealPhotoDocId('SEAL-C', SHA_OK) === shaLow,
    docIdVaries: ops.sealPhotoDocId('SEAL-C', SHA_OK) !== ops.sealPhotoDocId('SEAL-C', 'c'.repeat(64))
  })
}

/* ===========================================================================
   G 段：两条**内存变异负对照**（磁盘零改动；证明上面的断言真的会红）
   =========================================================================== */
section('G', '变异负对照：① 去掉 hidden 过滤 ⇒ 可见性断言红；② _id 派生加随机 ⇒ 幂等断言红')

{
  const diskBefore = createHash('sha256')
    .update(readFileSync(OPS_PATH, 'utf8'))
    .update('\u0000')
    .update(readFileSync(INDEX_PATH, 'utf8'))
    .digest('hex')

  const NodeModule = typeof Module === 'function' ? Module : Module.default
  const opsSourceAtStart = readFileSync(OPS_PATH, 'utf8')
  const hitsOf = (needle) => opsSourceAtStart.split(needle).length - 1
  /** **内存变异**：改 `ops.js` 源码字符串后用 `Module._compile` 在进程内实例化 —— 磁盘零改动。 */
  function loadMutatedOps(mutate) {
    const mutated = mutate(opsSourceAtStart)
    const mod = new NodeModule(OPS_PATH)
    mod.filename = OPS_PATH
    mod.paths = NodeModule._nodeModulePaths(path.dirname(OPS_PATH))
    mod._compile(mutated, OPS_PATH)
    return mod.exports
  }

  /* 变异 ①：去掉公开面可见性闸门 `ordered.filter((row) => row.hidden !== true)`。 */
  seedPhoto(photoRow({ _id: 'ph-m1', seal_id: SEAL_M, created_at: isoAt(5), updated_at: isoAt(5), created_by: 'u-user' }))
  seedPhoto(photoRow({ _id: 'ph-m2', seal_id: SEAL_M, created_at: isoAt(6), updated_at: isoAt(6), created_by: 'u-user', hidden: true }))
  const M1_NEEDLE = 'ordered.filter((row) => row.hidden !== true)'
  const mutant1 = loadMutatedOps((source) => source.replace(M1_NEEDLE, 'ordered'))
  mutant1.setOpsDbProvider(() => fakeDb)
  const realVisible = (await ops.listSealPhotoRows({ seal_id: SEAL_M }, false)).rows.map((row) => row._id)
  const mutantVisible = (await mutant1.listSealPhotoRows({ seal_id: SEAL_M }, false)).rows.map((row) => row._id)
  const m1DiskUnchanged =
    createHash('sha256')
      .update(readFileSync(OPS_PATH, 'utf8'))
      .update('\u0000')
      .update(readFileSync(INDEX_PATH, 'utf8'))
      .digest('hex') === diskBefore
  check('G1', '⑦ 负对照①（内存变异、磁盘零改动）：去掉 `hidden !== true` 过滤 ⇒ 隐藏行 `ph-m2` 混入公开列表 ⇒ **A1 的可见性断言判红**（真源：真实实现恒不回它）', {
    needleHits: 1,
    realIds: ['ph-m1'],
    mutantIds: ['ph-m1', 'ph-m2'],
    wouldBeRed: true,
    diskUnchanged: true
  }, {
    needleHits: hitsOf(M1_NEEDLE),
    realIds: realVisible,
    mutantIds: mutantVisible,
    wouldBeRed: mutantVisible.indexOf('ph-m2') !== -1 && realVisible.indexOf('ph-m2') === -1,
    diskUnchanged: m1DiskUnchanged
  })

  /* 变异 ②：`sealPhotoDocId` 派生加随机数 ⇒ 同 seal+sha 两次不同键 ⇒ 幂等失效。 */
  const M2_NEEDLE = 'hash16(JSON.stringify([sealId, sha256]))'
  const mutant2 = loadMutatedOps((source) => source.replace(M2_NEEDLE, "hash16(JSON.stringify([sealId, sha256])) + '-' + Math.random()"))
  const mutantDb = createFakeDb()
  mutant2.setOpsDbProvider(() => mutantDb)
  const mutantPayload = {
    seal_id: 'SEAL-C',
    stamp_id: 'STAMP-C',
    sha256: SHA_OK,
    bytes: 204800,
    mime: 'image/tiff',
    width: 300,
    height: 300,
    note: '入冊測試'
  }
  const mutantFirst = await mutant2.OPS.createSealPhoto(mutantPayload, userIdentity)
  await mutant2.persist(mutantFirst.plan)
  const mutantSecond = await mutant2.OPS.createSealPhoto(mutantPayload, userIdentity)
  const mutantIdsDiffer = mutantFirst.row._id !== mutantSecond.row._id
  await mutant2.persist(mutantSecond.plan)
  const mutantRows = [...mutantDb.bucketOf(PHOTOS).values()].length
  /* 真源对照（此刻仍在）：同载荷二调不产 `plan`、行数恒 1。 */
  const realSecond = await ops.OPS.createSealPhoto(mutantPayload, userIdentity)
  const realNoPlan = !Object.prototype.hasOwnProperty.call(realSecond, 'plan')
  const realRows = photoRowsOf('SEAL-C').length
  const m2DiskUnchanged =
    createHash('sha256')
      .update(readFileSync(OPS_PATH, 'utf8'))
      .update('\u0000')
      .update(readFileSync(INDEX_PATH, 'utf8'))
      .digest('hex') === diskBefore
  check('G2', '⑦ 负对照②（内存变异、磁盘零改动）：`sealPhotoDocId` 派生加随机数 ⇒ 重传落**第二行**、二调仍产 `plan` ⇒ **C5 的幂等断言判红**（真源：真实实现行数恒 1、二调零 `plan`）', {
    needleHits: 1,
    mutantHasPlanAgain: true,
    mutantIdsDiffer: true,
    mutantRows: 2,
    realNoPlan: true,
    realRows: 1,
    wouldBeRed: true,
    diskUnchanged: true
  }, {
    needleHits: hitsOf(M2_NEEDLE),
    mutantHasPlanAgain: Object.prototype.hasOwnProperty.call(mutantSecond, 'plan'),
    mutantIdsDiffer: mutantIdsDiffer,
    mutantRows: mutantRows,
    realNoPlan: realNoPlan,
    realRows: realRows,
    wouldBeRed:
      Object.prototype.hasOwnProperty.call(mutantSecond, 'plan') &&
      mutantIdsDiffer &&
      mutantRows === 2 &&
      realNoPlan &&
      realRows === 1,
    diskUnchanged: m2DiskUnchanged
  })
}

/* ===========================================================================
   收尾
   =========================================================================== */
console.log(
  JSON.stringify({
    summary: { total, passed, failed: total - passed },
    sections: sectionStats,
    failed_ids: failedIds,
    note: '离线自检：XIAI_NO_REAL_CARD=1、假 DB 注入、令牌本地现签、两条内存变异负对照；零外部网络、零生产数据；不打印令牌原文。'
  })
)
process.exit(failedIds.length === 0 ? 0 : 1)
