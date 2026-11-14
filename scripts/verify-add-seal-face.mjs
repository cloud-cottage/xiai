#!/usr/bin/env node
/**
 * 玺爱 · **详情页新增印面（`addSealFace`）**自检（v1.111 / §3.88 ＋ §10.95 `AC-738` 〜 `AC-747`）
 * ============================================================================
 * **本地、离线、零网络、零云端、零生产数据**：注入式内存假 DB，跑的是
 * `cloudfunctions/xiai-user-token/lib/ops.js` 的 `ADMIN_OPS.addSealFace`（薄委派）与
 * `lib/addSealFace.js` 的**真实函数体**，外加 `index.js` 的**静态收窄门**。
 *
 * 口径正本：`docs/add-seal-face-ruling-2026-11-14.md` §三 ＋ `docs/xiai.spec.md` §3.88 / §10.95。
 *
 * 断言面（八组 `A` 〜 `H`；每条可机械判负）：
 *   A. **载荷封闭恰 7 键**（`AC-738`）：合法 7 键 / 缺可选键 ⇒ 通过；逐次加送未知键
 *      （`admin` / `role` / `note`）与身份类键（`uid` / `phone`）⇒ `INVALID_FIELD` ＋ 恰 3 键 ＋
 *      **假体 `stats.reads` 一字不增**（判定早于任何读）＋ 零写。
 *   B. **三类 `INVALID_VALUE`**（`AC-739`）：印章不存在 / `sha256` 未入册 / 非法 `kind`
 *      —— 三类各 `INVALID_VALUE`、恰 3 键、零写；后两类判定早于写步；禁 `NOT_FOUND`。
 *   C. **`is_primary` ＋ `face_count` ＋ 行键集**（`AC-741` / `AC-742`）：无面章建 `FACE`
 *      ⇒ `is_primary:true`、`face_count` 1；再建 `FACE` ⇒ `false`、`face_count` 2；
 *      建 `EDGE` ⇒ `face_count` **不变**、行上**无 `is_primary` 键**、`edge_image_ids` 恰 1 项、
 *      `face_image_id` 为空。
 *   D. **幂等**（`AC-740`）：同 `(stamp_id, kind, sha256)` 重放 ⇒ `skipped:true`、面行数不变、
 *      `face_count` 不变、零写、不发号（下一次建面的 `face_no` 仍只 +1）。
 *   E. **管理员门第一行**（`AC-743`）：非白名单手机号 / 缺 `adminPhone`（env 缺省）/
 *      平台会话非管理员 —— 三者各拒、**零读零写**。
 *   F. **回包键面**（`AC-744`）：成功恰 6 键 `{ok, face_id, face_no, fid, kind, face_count}`、
 *      幂等轮恰 4 键 `{ok, face_id, skipped, face_count}`、失败恒恰 3 键；`REASONS` 仍 13 值；
 *      `index.js` 的 6 键透传**按 `op === 'addSealFace'` 收窄**（静态）。
 *   G. **前端静态门**（`AC-745`）：`[data-admin-action]` 取值集合**仍恰 12 值**（逐字，本单不得扩）；
 *      钩子逐字 `data-action="add-seal-face"` 在仓内命中 ≥1；该值**不得**出现在 `data-admin-action` 族。
 *   H. **编号唯一**（`AC-742` / §6.4 无重号）：同一假体连建 3 面后，**`face_no` 全库无重复**、
 *      **面行 id 全库无重复**、`fid` 与 `face_no` 重算一致。
 *
 * 纪律：零外部网络、零生产写入；不打印任何密钥 / 令牌；断言失败 ⇒ 退出码非 0。
 *
 * 用法：node scripts/verify-add-seal-face.mjs
 */

/* **测试环境保护哨兵（硬防线）** —— 本套件只跑离线假 DB / 假 CARD：置 `XIAI_NO_REAL_CARD=1`。
   若哪个调用点漏注入假传输，`lib/cardApi.js` 会**当场抛错、零请求**（绝不悄悄打生产 CARD）。
   跑任何套件前**不得** export 真 `CARD_API_KEY`（见 `scripts/README-test-net.md`）。 */
process.env.XIAI_NO_REAL_CARD = '1'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

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
   1. 断言
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
const isDenial = (reply) => !!reply && reply.ok === false && typeof reply.reason === 'string' && typeof reply.message === 'string'

/* ---------------------------------------------------------------------------
   2. 注入式内存假 DB
   · `where(match).get()/limit()/update()`、`doc(id).get()/set()/delete()`、`add()`；
   · `command.inc(n)`（号源 CAS 自增算子在写面被走到时按数值累加）；
   · `stats.reads` / `stats.writes` 是**零读取 / 零写入**判据的读数源。
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
  const command = { inc: (value) => ({ __op: 'inc', value: Number(value) }) }
  const sameValue = (left, right) => {
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.length === right.length && left.every((item, index) => String(item) === String(right[index]))
    }
    return left === right
  }
  const matches = (row, match) =>
    Object.keys(match || {}).every((key) => {
      const expected = match[key]
      if (expected && typeof expected === 'object' && expected.__op === 'inc') return false
      return sameValue(row[key], expected)
    })
  const provider = () => ({
    command,
    collection(name) {
      const map = mapOf(name)
      const all = () => [...map.values()].map((row) => JSON.parse(JSON.stringify(row)))
      const hit = (match) => all().filter((row) => matches(row, match))
      const chainOf = (match) => {
        const state = { limit: 0 }
        const api = {
          limit(n) {
            state.limit = Math.max(0, Math.floor(Number(n) || 0))
            return api
          },
          async count() {
            stats.reads += 1
            return { total: hit(match).length }
          },
          async get() {
            stats.reads += 1
            let rows = hit(match)
            if (state.limit > 0) rows = rows.slice(0, state.limit)
            return { data: rows }
          },
          async update(doc) {
            const rows = hit(match)
            for (const row of rows) {
              const key = String(row._id || row.id)
              const current = Object.assign({}, map.get(key))
              for (const field of Object.keys(doc || {})) {
                const value = doc[field]
                if (value && typeof value === 'object' && value.__op === 'inc') {
                  current[field] = Number(current[field] || 0) + Number(value.value)
                } else {
                  current[field] = value
                }
              }
              map.set(key, current)
            }
            stats.writes.push({ collection: name, action: 'update', match, doc, count: rows.length })
            return { updated: rows.length }
          }
        }
        return api
      }
      return {
        where: (match) => chainOf(match),
        doc(id) {
          return {
            async get() {
              stats.reads += 1
              const row = map.get(String(id))
              return { data: row ? [JSON.parse(JSON.stringify(row))] : [] }
            },
            async set(doc) {
              map.set(String(id), Object.assign({ _id: String(id) }, JSON.parse(JSON.stringify(doc))))
              stats.writes.push({ collection: name, action: 'set', id: String(id) })
              return { updated: 1 }
            },
            async delete() {
              map.delete(String(id))
              stats.writes.push({ collection: name, action: 'delete', id: String(id) })
              return { deleted: 1 }
            }
          }
        },
        async add(doc) {
          const id = String(doc && doc._id ? doc._id : `auto-${map.size + 1}`)
          if (map.has(id)) throw new Error('E11000 duplicate key')
          map.set(id, Object.assign({ _id: id }, JSON.parse(JSON.stringify(doc))))
          stats.writes.push({ collection: name, action: 'add', id })
          return { id }
        }
      }
    }
  })
  return {
    stats,
    provider,
    rows: (name) => [...mapOf(name).values()].map((row) => JSON.parse(JSON.stringify(row))),
    row: (name, id) => JSON.parse(JSON.stringify(mapOf(name).get(String(id)) || {}))
  }
}

/* ---------------------------------------------------------------------------
   3. 载入被测件 ＋ 注入假 DB（**离线进程内设值**；生产真源 ＝ 云函数环境变量）
   --------------------------------------------------------------------------- */
const ops = require(path.join(FN_DIR, 'lib/ops.js'))
const config = require(path.join(FN_DIR, 'lib/config.js'))
const codeId = require(path.join(FN_DIR, 'lib/codeId.js'))
const addSealFaceModule = require(path.join(FN_DIR, 'lib/addSealFace.js'))

const PHONE = '13000000011' /* 合成管理员号（非真实凭据）。 */
const NON_WHITELIST_PHONE = '13900000099'
const ADMIN_IDENTITY = { uid: 'u-admin-add-seal-face', phone: PHONE, identity_source: 'SERVER_TOKEN' }
const ADMIN_CTX = (extra) => Object.assign({ adminPhone: PHONE, nowSeconds: 1794000000 }, extra || {})

/** 两个合法摘要（`xiai/images/<前两位>/<摘要>.tiff` 形态门要求键内摘要 ≡ 声称摘要）。 */
const SHA_A = '6a'.repeat(32)
const SHA_B = '6b'.repeat(32)
const SHA_C = '6c'.repeat(32)

function imageRowOf(sha) {
  const id = `img-${sha.slice(0, 16)}`
  return {
    __collection: 'xiai_images',
    _id: id,
    id,
    sha256: sha,
    storage_key: `xiai/images/${sha.slice(0, 2)}/${sha}.tiff`,
    storage: 'server',
    mime: 'image/tiff'
  }
}

/** 章 ＋ 若干面行。`faces` 传 `[]` ⇒ 零面章（测 `is_primary:true` 分支）。 */
function sealSeedRows(stampId, faces) {
  const rows = [
    {
      __collection: 'xiai_seals',
      _id: stampId,
      stamp_id: stampId,
      sid: stampId,
      seal_name: '測試印章',
      dynasty: '清',
      category: '吉語印',
      face_count: (faces || []).filter((face) => face.kind !== 'EDGE').length
    }
  ]
  ;(faces || []).forEach((face, index) => {
    const faceNo = face.face_no || 2000 + index + 1
    const faceCode = codeId.encodeFaceCode(faceNo)
    rows.push(
      Object.assign(
        {
          __collection: 'xiai_faces',
          _id: face.id || `fc-${stampId}-f${index + 1}`,
          id: face.id || `fc-${stampId}-f${index + 1}`,
          sealId: stampId,
          stamp_id: stampId,
          face_no: faceNo,
          fid: faceCode.ok === true ? faceCode.code : '',
          kind: face.kind || 'FACE',
          seal_name: '測試印章'
        },
        face.kind === 'EDGE'
          ? { edge_image_ids: ['img-seeded-edge'], face_image_id: null }
          : { face_image_id: face.image_id || `img-${SHA_A.slice(0, 16)}`, is_primary: face.is_primary !== false }
      )
    )
  })
  return rows
}

/** 合法载荷（恰 7 键）。 */
const payloadOf = (overrides) =>
  Object.assign(
    {
      stamp_id: 'ASF001',
      kind: 'FACE',
      sha256: SHA_A,
      bytes: 1024,
      mime: 'image/tiff',
      storage_key: `xiai/images/${SHA_A.slice(0, 2)}/${SHA_A}.tiff`,
      seal_name: ''
    },
    overrides || {}
  )

let activeStore = null
const withStore = async (target, run) => {
  activeStore = target
  ops.setOpsDbProvider(target.provider)
  try {
    return await run()
  } finally {
    activeStore = null
    ops.setOpsDbProvider(null)
  }
}
const addFace = (payload, identity, context) =>
  ops.ADMIN_OPS.addSealFace(payload, identity || ADMIN_IDENTITY, context === undefined ? ADMIN_CTX() : context)

/* ===========================================================================
   A：载荷封闭恰 7 键（AC-738）—— 未知键 / 身份类键 ⇒ INVALID_FIELD ＋ 零读取
   =========================================================================== */
section('A', '载荷恰 7 键（AC-738）：合法 7 / 6 键通过；未知键与身份类键 ⇒ INVALID_FIELD ＋ 恰 3 键 ＋ 零读取')
{
  check('A1', '载荷白名单常量逐字恰 7 键（字典序）', ['bytes', 'kind', 'mime', 'seal_name', 'sha256', 'stamp_id', 'storage_key'], sorted(addSealFaceModule.ADD_SEAL_FACE_ALLOWED_KEYS.slice()))

  const store = createStore([...sealSeedRows('ASF001', []), imageRowOf(SHA_A), imageRowOf(SHA_B)])
  await withStore(store, async () => {
    const full = await addFace(payloadOf({ sha256: SHA_A, storage_key: `xiai/images/${SHA_A.slice(0, 2)}/${SHA_A}.tiff` }))
    check('A2', '恰 7 键的合法载荷 ⇒ `ok:true`（正面对照：拒绝门未误杀）', { ok: true, kind: 'FACE' }, { ok: full.ok, kind: full.kind })
    /* `seal_name` 是**可选**键 ⇒ 6 键同样合法（缺键不等于多键）。 */
    const withoutOptional = payloadOf({ sha256: SHA_B, storage_key: `xiai/images/${SHA_B.slice(0, 2)}/${SHA_B}.tiff` })
    delete withoutOptional.seal_name
    const sixKey = await addFace(withoutOptional)
    check('A3', '缺可选键 `seal_name`（恰 6 键）⇒ 仍 `ok:true`（可选键不强制）', true, sixKey.ok === true)

    const probes = [
      ['admin', 'INVALID_FIELD'],
      ['role', 'INVALID_FIELD'],
      ['note', 'INVALID_FIELD'],
      ['uid', 'INVALID_FIELD'],
      ['phone', 'INVALID_FIELD']
    ]
    const seen = []
    for (const [key, expectedReason] of probes) {
      const readsBefore = store.stats.reads
      const writesBefore = store.stats.writes.length
      const reply = await addFace(payloadOf(Object.assign({ [key]: 'x' }, {})))
      seen.push({
        key,
        reason: reply.reason,
        keys: shapeOf(reply),
        zeroRead: store.stats.reads === readsBefore,
        zeroWrite: store.stats.writes.length === writesBefore,
        expectedReason
      })
    }
    check('A4', '逐次加送未知键 / 身份类键（admin / role / note / uid / phone）⇒ 一律 `INVALID_FIELD` ＋ 恰 3 键 ＋ **零读取** ＋ 零写（键面判定早于任何读）', true, seen.every((item) => item.reason === item.expectedReason && item.keys === 'message,ok,reason' && item.zeroRead && item.zeroWrite))
    check('A5', '逐键读数（键名 / reason / 键面 / 零读取 / 零写）', probes.map((item) => item[0]).sort(), seen.map((item) => item.key).sort())
  })
}

/* ===========================================================================
   B：三类 INVALID_VALUE（AC-739）—— 章不存在 / 未入册 / 非法 kind
   =========================================================================== */
section('B', '三类 INVALID_VALUE（AC-739）：印章不存在 / sha256 未入册 / 非法 kind —— 各恰 3 键、零写、禁 NOT_FOUND')
{
  const store = createStore([...sealSeedRows('ASF001', []), imageRowOf(SHA_A)])
  await withStore(store, async () => {
    const writesBefore = store.stats.writes.length

    const missingSeal = await addFace(payloadOf({ stamp_id: 'ZZZ-NOT-EXIST' }))
    check('B1', '① `stamp_id` 不存在 ⇒ `INVALID_VALUE`（禁 `NOT_FOUND`）＋ 恰 3 键 ＋ 文案「該印章不存在」', {
      reason: 'INVALID_VALUE',
      keys: 'message,ok,reason',
      namesSeal: true
    }, {
      reason: missingSeal.reason,
      keys: shapeOf(missingSeal),
      namesSeal: String(missingSeal.message || '').indexOf('該印章不存在') !== -1
    })

    const notRegistered = await addFace(payloadOf({ sha256: SHA_C, storage_key: `xiai/images/${SHA_C.slice(0, 2)}/${SHA_C}.tiff` }))
    check('B2', '② `sha256` 未入册 ⇒ `INVALID_VALUE` ＋ 恰 3 键 ＋ 文案点名「請先經 registerFaceImage 入冊」', {
      reason: 'INVALID_VALUE',
      keys: 'message,ok,reason',
      namesRegister: true
    }, {
      reason: notRegistered.reason,
      keys: shapeOf(notRegistered),
      namesRegister: String(notRegistered.message || '').indexOf('registerFaceImage') !== -1
    })

    const badKindReads = store.stats.reads
    const badKind = await addFace(payloadOf({ kind: 'SEAL' }))
    check('B3', '③ `kind` 非法（`SEAL`）⇒ `INVALID_VALUE` ＋ 恰 3 键 ＋ **零读取**（值域门早于读章行）＋ 零写', {
      reason: 'INVALID_VALUE',
      keys: 'message,ok,reason',
      zeroRead: true
    }, {
      reason: badKind.reason,
      keys: shapeOf(badKind),
      zeroRead: store.stats.reads === badKindReads
    })

    const badKindEmpty = await addFace(payloadOf({ kind: '' }))
    check('B4', '③b `kind` 空串同样拒（不静默归一成 `FACE`）⇒ `INVALID_VALUE`', 'INVALID_VALUE', badKindEmpty.reason)

    check('B5', '三类拒绝**零写**（面行 / 章行 / 计数器一字未动）', writesBefore, store.stats.writes.length)
  })
}

/* ===========================================================================
   C：is_primary 两分支 ＋ EDGE 不落键 ＋ face_count 仅 FACE +1（AC-741 / AC-742）
   =========================================================================== */
section('C', 'is_primary / face_count / 行键集（AC-741 / AC-742）：无面章 FACE ⇒ true、再建 FACE ⇒ false、EDGE ⇒ 计数不变且无 is_primary 键')
{
  const store = createStore([...sealSeedRows('ASF002', []), imageRowOf(SHA_A), imageRowOf(SHA_B), imageRowOf(SHA_C)])
  await withStore(store, async () => {
    const first = await addFace(payloadOf({ stamp_id: 'ASF002' }))
    const firstRow = store.row('xiai_faces', first.face_id)
    const sealsAfterFirst = store.rows('xiai_seals')
    check('C1', '① 无面章建 **FACE** ⇒ 行上 `is_primary:true`、章行 `face_count` ＝ 1', {
      ok: true,
      isPrimary: true,
      faceCount: 1
    }, {
      ok: first.ok,
      isPrimary: firstRow.is_primary,
      faceCount: (sealsAfterFirst[0] || {}).face_count
    })
    check('C1b', '①b FACE 面行**逐字键集**（22 键：共用 21 ＋ `is_primary`；与既有「补缺失面」构造点逐字同形 —— **`face_image_id` 与 `edge_image_ids` 同时在场、各自留空/null**，规范 §3.88.4 按「或」计作 21 键，计数差 1 属既有构造点口径，见报告）', [
      'author',
      'author_person_id',
      'created_at',
      'dynasty',
      'edge_image_ids',
      'face_image_id',
      'face_no',
      'face_style',
      'fid',
      'id',
      'image_source_kind',
      'is_primary',
      'kind',
      'sealId',
      'seal_class',
      'seal_name',
      'seal_type',
      'source',
      'stamp_id',
      'transcription',
      'updated_at',
      'uploaded_by'
    ], sorted(Object.keys(firstRow).filter((key) => key !== '_id')))
    check('C1c', '①c 面行身份键：`id` / `sealId` / `stamp_id` / `kind` / `face_image_id` / `edge_image_ids`', {
      idIsFaceId: true,
      sealId: 'ASF002',
      stampId: 'ASF002',
      kind: 'FACE',
      faceImageId: `img-${SHA_A.slice(0, 16)}`,
      edgeEmpty: true
    }, {
      idIsFaceId: firstRow.id === first.face_id,
      sealId: firstRow.sealId,
      stampId: firstRow.stamp_id,
      kind: firstRow.kind,
      faceImageId: firstRow.face_image_id,
      edgeEmpty: Array.isArray(firstRow.edge_image_ids) && firstRow.edge_image_ids.length === 0
    })

    const second = await addFace(payloadOf({ stamp_id: 'ASF002', sha256: SHA_B, storage_key: `xiai/images/${SHA_B.slice(0, 2)}/${SHA_B}.tiff` }))
    const secondRow = store.row('xiai_faces', second.face_id)
    const sealAfterSecond = store.rows('xiai_seals')[0] || {}
    check('C2', '② 再建 **FACE**（章已有 1 面）⇒ 新面 `is_primary:false`、章行 `face_count` ＝ 2、原面 `is_primary` **仍 true**（不抢主印面）', {
      isPrimary: false,
      faceCount: 2,
      oldStillPrimary: true,
      primaryCount: 1
    }, {
      isPrimary: secondRow.is_primary,
      faceCount: sealAfterSecond.face_count,
      oldStillPrimary: store.row('xiai_faces', first.face_id).is_primary === true,
      primaryCount: store.rows('xiai_faces').filter((row) => row.is_primary === true).length
    })

    const writesBeforeEdge = store.stats.writes.length
    const edge = await addFace(payloadOf({ stamp_id: 'ASF002', kind: 'EDGE', sha256: SHA_C, storage_key: `xiai/images/${SHA_C.slice(0, 2)}/${SHA_C}.tiff` }))
    const edgeRow = store.row('xiai_faces', edge.face_id)
    const sealAfterEdge = store.rows('xiai_seals')[0] || {}
    check('C3', '③ 建 **EDGE** ⇒ 章行 `face_count` **不变（仍 2）**、行上**无 `is_primary` 键**（不是 `false`）、`edge_image_ids` 恰 1 项且 `face_image_id` 为空', {
      ok: true,
      kind: 'EDGE',
      faceCount: 2,
      hasPrimaryKey: false,
      edgeIds: [`img-${SHA_C.slice(0, 16)}`],
      faceImageIdEmpty: true
    }, {
      ok: edge.ok,
      kind: edge.kind,
      faceCount: sealAfterEdge.face_count,
      hasPrimaryKey: Object.prototype.hasOwnProperty.call(edgeRow, 'is_primary'),
      edgeIds: Array.isArray(edgeRow.edge_image_ids) ? edgeRow.edge_image_ids : null,
      faceImageIdEmpty: edgeRow.face_image_id === null || edgeRow.face_image_id === ''
    })
    check('C3b', '③b EDGE 面行**逐字键集**（21 键：共用 21、**无 `is_primary`** —— 比 FACE 少一键）', 21, Object.keys(edgeRow).filter((key) => key !== '_id').length)
    check('C3c', '③c EDGE 轮**不碰章行**（`xiai_seals` 零写）且面行只落一次（写面 = 计数器发号 ＋ 面行 `set`）', {
      sealWrites: 0,
      faceSets: 1
    }, {
      sealWrites: store.stats.writes.slice(writesBeforeEdge).filter((item) => item.collection === 'xiai_seals').length,
      faceSets: store.stats.writes.slice(writesBeforeEdge).filter((item) => item.collection === 'xiai_faces' && item.action === 'set').length
    })
    check('C4', '④ 章行只被写过 `face_count` 一个键（其它字段逐字未动）', { seal_name: '測試印章', dynasty: '清', category: '吉語印' }, {
      seal_name: sealAfterEdge.seal_name,
      dynasty: sealAfterEdge.dynasty,
      category: sealAfterEdge.category
    })
  })
}

/* ===========================================================================
   D：幂等（AC-740）—— 同 (stamp_id, kind, sha256) 重放 ⇒ skipped、面行数不变
   =========================================================================== */
section('D', '幂等（AC-740）：同 stamp_id ＋ kind ＋ sha256 重放 ⇒ skipped:true、面行数不变、零写、不发号')
{
  const store = createStore([...sealSeedRows('ASF003', []), imageRowOf(SHA_A), imageRowOf(SHA_B)])
  await withStore(store, async () => {
    const first = await addFace(payloadOf({ stamp_id: 'ASF003' }))
    const faceRowsAfterFirst = store.rows('xiai_faces').length
    const sealAfterFirst = store.rows('xiai_seals')[0] || {}

    const writesBeforeReplay = store.stats.writes.length
    const replay = await addFace(payloadOf({ stamp_id: 'ASF003' }))
    check('D1', '① 同图重放 ⇒ `skipped:true` 且 `face_id` ＝ 首次那行（不建第二行）', {
      ok: true,
      skipped: true,
      sameFaceId: true
    }, {
      ok: replay.ok,
      skipped: replay.skipped,
      sameFaceId: replay.face_id === first.face_id
    })
    check('D2', '② 面行数 **不变**、`face_count` **不变**（幂等命中不改计数）、**零写**', {
      faceRows: faceRowsAfterFirst,
      faceCount: sealAfterFirst.face_count,
      writes: 0
    }, {
      faceRows: store.rows('xiai_faces').length,
      faceCount: (store.rows('xiai_seals')[0] || {}).face_count,
      writes: store.stats.writes.length - writesBeforeReplay
    })

    /* 不发号：紧接着建一个**不同图**的 FACE，`face_no` 应只比首次 +1（重放若偷偷发了号，
       这里会跳到 +2）。 */
    const third = await addFace(payloadOf({ stamp_id: 'ASF003', sha256: SHA_B, storage_key: `xiai/images/${SHA_B.slice(0, 2)}/${SHA_B}.tiff` }))
    check('D3', '③ 幂等命中**未偷偷发号**：其后新建面的 `face_no` 恰 ＝ 首次 + 1', first.face_no + 1, third.face_no)
    check('D4', '④ 幂等判据跨 `kind`：同图改建 **EDGE** 是**另一行**（不判重复）', { kind: 'EDGE', newFaceId: true }, {
      kind: (await addFace(payloadOf({ stamp_id: 'ASF003', kind: 'EDGE', sha256: SHA_A, storage_key: `xiai/images/${SHA_A.slice(0, 2)}/${SHA_A}.tiff` }))).kind,
      newFaceId: store.rows('xiai_faces').length === faceRowsAfterFirst + 2
    })
  })
}

/* ===========================================================================
   E：管理员门第一行（AC-743）—— 三类非管理员 ⇒ 拒 ＋ 零读零写
   =========================================================================== */
section('E', '管理员门第一行（AC-743）：非白名单手机号 / 缺 adminPhone（env 缺省）/ 会话非管理员 ⇒ 拒 ＋ 零读零写')
{
  const store = createStore([...sealSeedRows('ASF004', []), imageRowOf(SHA_A)])
  await withStore(store, async () => {
    const probes = [
      ['E1', '① 非白名单手机号（已配置 env）⇒ `FORBIDDEN`', { uid: 'u-plain', phone: NON_WHITELIST_PHONE }, ADMIN_CTX(), 'FORBIDDEN'],
      ['E2', '② 缺 `XIAI_ADMIN_PHONE`（`adminPhone` 为空）⇒ 安全拒 `STORAGE_UNAVAILABLE`（fail-closed）', ADMIN_IDENTITY, ADMIN_CTX({ adminPhone: '' }), 'STORAGE_UNAVAILABLE'],
      ['E3', '③ 平台会话身份但角色非管理员 ⇒ `FORBIDDEN`', { uid: 'u-sess', identity_source: 'PLATFORM_SESSION', role: 'user' }, ADMIN_CTX(), 'FORBIDDEN']
    ]
    for (const [id, label, identity, context, expectedReason] of probes) {
      const readsBefore = store.stats.reads
      const writesBefore = store.stats.writes.length
      const reply = await addFace(payloadOf({ stamp_id: 'ASF004' }), identity, context)
      check(id, label, {
        reason: expectedReason,
        keys: 'message,ok,reason',
        zeroRead: true,
        zeroWrite: true
      }, {
        reason: reply.reason,
        keys: shapeOf(reply),
        zeroRead: store.stats.reads === readsBefore,
        zeroWrite: store.stats.writes.length === writesBefore
      })
    }
    check('E4', '④ 面行 / 章行仍一字未写（三次拒后库面零变化）', { faceRows: 0, faceCount: 0 }, {
      faceRows: store.rows('xiai_faces').length,
      faceCount: (store.rows('xiai_seals')[0] || {}).face_count
    })
  })
}

/* ===========================================================================
   F：回包键面（AC-744）—— 成功恰 6 / 幂等恰 4 / 失败恒恰 3 ＋ index.js 按 op 收窄
   =========================================================================== */
section('F', '回包键面（AC-744）：成功恰 6 键 / 幂等恰 4 键 / 失败恒恰 3 键；REASONS 仍 13；index.js 透传按 op 收窄')
{
  const store = createStore([...sealSeedRows('ASF005', []), imageRowOf(SHA_A)])
  await withStore(store, async () => {
    const ok = await addFace(payloadOf({ stamp_id: 'ASF005' }))
    check('F1', '① 成功回包**恰 6 键** `ok / face_id / face_no / fid / kind / face_count`', ['face_count', 'face_id', 'face_no', 'fid', 'kind', 'ok'], sorted(Object.keys(ok)))
    check('F1b', '①b 成功回包无来历不明键（`skipped` 缺席、`plan` 零外泄、`seal_id` / `stamp_id` 等零出现）', { skipped: false, plan: false, stamp: false }, {
      skipped: Object.prototype.hasOwnProperty.call(ok, 'skipped'),
      plan: Object.prototype.hasOwnProperty.call(ok, 'plan'),
      stamp: Object.prototype.hasOwnProperty.call(ok, 'stamp_id') || Object.prototype.hasOwnProperty.call(ok, 'seal_id')
    })
    const idem = await addFace(payloadOf({ stamp_id: 'ASF005' }))
    check('F2', '② 幂等轮**恰 4 键** `ok / face_id / skipped / face_count`（§3.88.5）', ['face_count', 'face_id', 'ok', 'skipped'], sorted(Object.keys(idem)))
    const failures = [
      await addFace(payloadOf({ stamp_id: 'ASF005', nope: 1 })),
      await addFace(payloadOf({ stamp_id: 'NOPE-X' })),
      await addFace(payloadOf({ stamp_id: 'ASF005' }), { uid: 'u-x', phone: NON_WHITELIST_PHONE })
    ]
    check('F3', '③ 失败恒**恰 3 键** `ok / reason / message`（键面 / 值域 / 门拒三类各一发）', ['message,ok,reason', 'message,ok,reason', 'message,ok,reason'], failures.map(shapeOf))
    check('F4', '④ `REASONS` 仍**恰 13 值**（本 op 零新增字面值）', 13, Object.keys(config.REASONS).length)
    check('F4b', '④b 回包读数键面真源逐字恰 6 键', ['face_count', 'face_id', 'face_no', 'fid', 'kind', 'skipped'], sorted(addSealFaceModule.ADD_SEAL_FACE_READOUT_KEYS.slice()))
  })

  /* **index.js 按 op 收窄**（静态）：6 键透传必须写在 `if (op === 'addSealFace')` 分支内，
     否则 `replaceFaceImage` 的 `face_id` / `submitImageCorrection` 的 `skipped` 会一并外泄。 */
  const indexSource = readFileSync(path.join(FN_DIR, 'index.js'), 'utf8')
  const guardAt = indexSource.indexOf("if (op === 'addSealFace')")
  const loopAt = indexSource.indexOf('for (const key of ADD_SEAL_FACE_READOUT_KEYS)')
  check('F5', '⑤ `index.js` 的 6 键透传**按 `op === \'addSealFace\'` 收窄**（守卫在前、键面循环在其后）', true, guardAt !== -1 && loopAt !== -1 && loopAt > guardAt)
  check('F5b', '⑤b 键面真源来自 `lib/addSealFace.js`（`index.js` 不另立第二套键表）', true, indexSource.indexOf("require('./lib/addSealFace.js')") !== -1)
}

/* ===========================================================================
   G：前端静态门（AC-745）—— data-admin-action 仍 12 值 / 新钩子不进该族
   =========================================================================== */
section('G', '前端静态门（AC-745）：[data-admin-action] 仍恰 12 值（逐字）＋ data-action="add-seal-face" 命中 ≥1 且不进该族')
{
  const ADMIN_ACTION_VALUES = [
    'ai-enhance-face',
    'correction-accept',
    'correction-reject',
    'edit-ai-upstream',
    'edit-fixed-attributes',
    'edit-invite-reward',
    'edit-seal-attributes',
    'export-seal-data',
    'person-import-review',
    'person-proposal-review',
    'replace-face-image',
    'upload-seal'
  ]
  /* 递归读 `src/`（只认 `.vue` / `.js`；逐文件读，不引第三方。 */
  const walk = (dir, out) => {
    for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, out)
      else if (/\.(vue|js)$/.test(entry.name)) out.push(full)
    }
    return out
  }
  const files = walk(path.join(ROOT, 'src'), [])
  const adminActions = new Set()
  let addSealFaceHooks = 0
  let addSealFaceInAdminFamily = 0
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const hit of source.matchAll(/data-admin-action="([a-z-]+)"/g)) adminActions.add(hit[1])
    for (const hit of source.matchAll(/data-action="(add-seal-face)"/g)) addSealFaceHooks += 1
    for (const hit of source.matchAll(/data-admin-action="(add-seal-face)"/g)) addSealFaceInAdminFamily += 1
  }
  check('G1', '① `[data-admin-action]` 取值集合**仍恰 12 值且逐字等于冻结表**（本单不得扩）', ADMIN_ACTION_VALUES, sorted([...adminActions]))
  check('G2', '② 钩子逐字 `data-action="add-seal-face"` 在 `src/` 命中 **≥1**', true, addSealFaceHooks >= 1)
  check('G3', '③ 该值**未混入** `[data-admin-action]` 族（命中 0）', 0, addSealFaceInAdminFamily)
  const viewSourceRaw = readFileSync(path.join(ROOT, 'src/views/SealDetailView.vue'), 'utf8')
  /* 剥 HTML 注释后再数钩子（注释里也写了这个字面值 ⇒ 若不剥，计数会把说明文字当成第二个入口）。 */
  const viewSource = viewSourceRaw.replace(/<!--[\s\S]*?-->/g, '')
  const entryAt = viewSource.indexOf('<button\n        v-if="canAddSealFace"')
  check('G4', '④ 入口按钮 `v-if="canAddSealFace"`（管理员专属条件渲染，非 CSS 隐藏 / `disabled` 冒充）且钩子与 `@click="openAddSealFace"` 同在一枚按钮上', true, entryAt !== -1 && /data-action="add-seal-face"\s*\n?\s*@click="openAddSealFace"/.test(viewSource))
  check('G4b', '④b 入口在「印面列表」区块头（`data-face-list-head`）内、`v-for` 之外且**恰一枚按钮**（不逐块复制）', true, (() => {
    const headAt = viewSource.indexOf('data-face-list-head')
    const loopAt = viewSource.indexOf('v-for="face in faces"', entryAt)
    const buttonHooks = (viewSource.match(/<button[\s\S]{0,400}?data-action="add-seal-face"/g) || []).length
    return headAt !== -1 && entryAt !== -1 && headAt < entryAt && loopAt !== -1 && entryAt < loopAt && buttonHooks === 1
  })())
}

/* ===========================================================================
   H：编号唯一（AC-742 / §6.4 无重号）
   =========================================================================== */
section('H', '编号唯一：同一章连建 3 面 ⇒ `face_no` 全库无重复、面行 id 全库无重复、`fid` 与 `face_no` 重算一致')
{
  const store = createStore([...sealSeedRows('ASF006', [{ kind: 'FACE', face_no: 2193, image_id: 'img-seeded-primary' }]), imageRowOf(SHA_A), imageRowOf(SHA_B), imageRowOf(SHA_C)])
  await withStore(store, async () => {
    const created = []
    created.push(await addFace(payloadOf({ stamp_id: 'ASF006', sha256: SHA_A, storage_key: `xiai/images/${SHA_A.slice(0, 2)}/${SHA_A}.tiff` })))
    created.push(await addFace(payloadOf({ stamp_id: 'ASF006', kind: 'EDGE', sha256: SHA_B, storage_key: `xiai/images/${SHA_B.slice(0, 2)}/${SHA_B}.tiff` })))
    created.push(await addFace(payloadOf({ stamp_id: 'ASF006', sha256: SHA_C, storage_key: `xiai/images/${SHA_C.slice(0, 2)}/${SHA_C}.tiff` })))
    const rows = store.rows('xiai_faces')
    const faceNos = rows.map((row) => Number(row.face_no))
    const ids = rows.map((row) => String(row.id))
    check('H1', '① 三次建面均 `ok:true`（正面支撑：下面两条唯一性不是空集上的空断言）', [true, true, true], created.map((item) => item.ok === true))
    check('H2', '② 全库 `face_no` **无重复**（含预置 2193 ⇒ 4 行 4 个不同号，且新建号递增）', {
      unique: 4,
      total: 4,
      increasing: true
    }, {
      unique: new Set(faceNos).size,
      total: faceNos.length,
      increasing: created[0].face_no > 2193 && created[1].face_no === created[0].face_no + 1 && created[2].face_no === created[1].face_no + 1
    })
    check('H3', '③ 面行 id **全库无重复**（`nextFaceIdOf` 发号跳过已占用）', { unique: 4, total: 4 }, { unique: new Set(ids).size, total: ids.length })
    check('H4', '④ `fid` 与 `face_no` **重算一致**（`codeId.encodeFaceCode` 单点，不自造编码）', true, rows.every((row) => {
      const recomputed = codeId.encodeFaceCode(Number(row.face_no))
      return recomputed.ok === true && recomputed.code === row.fid
    }))
    check('H5', '⑤ 章行 `face_count` ＝ 该章非 EDGE 面行数（预置 1 个 FACE ＋ 本轮 2 个 FACE ＝ 3；EDGE 不计）', 3, (store.rows('xiai_seals')[0] || {}).face_count)
  })
}

/* ===========================================================================
   收尾
   =========================================================================== */
const passed = results.length - failures
console.log(JSON.stringify({ summary: { total: results.length, passed, failed: failures }, failed_ids: results.filter((item) => !item.pass).map((item) => item.id) }))
process.exit(failures === 0 ? 0 : 1)
