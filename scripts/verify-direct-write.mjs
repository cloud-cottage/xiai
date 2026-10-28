#!/usr/bin/env node
/**
 * 玺爱 · **无审核直写面自检**（`createSealWithFaceDirect` ＋ `querySealByFingerprint`）
 * ============================================================================
 * **本地、离线、零网络、零云端**：注入式内存假 DB，跑的是
 * `cloudfunctions/xiai-user-token/lib/ops.js` 的**真实函数体**（与 `index.js` 同一注册面）。
 *
 * 跑什么（六段；每条可机械判负）：
 *   A. **新建**：单面印 ⇒ `sid` 5 位 / `fid` 8 位 / `seal_no` / `face_no`；plan 顺序
 *      （影像登记行 → 印章行 → 面行）；**面行落 `image_sha256`、印章行不落**；
 *      影像登记行字段面 ＋ 读面派生展示键；多面印（FACE＋EDGE）`faces[]` 两条且 `fid` 不同；
 *      同图被另一枚印引用 ⇒ 影像行**不增**（内容寻址去重）。
 *   B. **幂等**：同 `source` ＋ `source_seal_id` 二次调用 ⇒ `idempotent:true`、`sid` 相同、
 *      **集合行数不变**、无 `plan`；换图重放（同键）⇒ 仍幂等、新图**不落**。
 *   C. **对照三态**：`FULL` / `IMAGE_DIFF` / `NONE` 各一例 ＋ 回包键面恰含 ＋ 只读零写。
 *   D. **硬门**：非直写身份 / 缺 `XIAI_DIRECT_WRITE_PHONE` / 缺 `XIAI_DIRECT_WRITE_SOURCES` /
 *      source 不在表内 / 该身份调 `review*` 系（S1 分权）/ 会话路 / 载荷失败面 16 类 ——
 *      **全部恰 3 键拒绝 ＋ 零写入**。
 *   E. **号域**：`seal_no` 推到 5,153,632（越界）⇒ 结构化拒绝 ＋ 零写入；face 号源同款。
 *   F. **面与纪律**：`ADMIN_OPS` 恰 14 项且**未混入 `OPS`**；`reason` **零新增字面值**；
 *      `index.js` **未为新 op 开特判**（⇒ 回包走通用 `row` 通道、未改全局回包白名单）；
 *      `config.js::ENV_NAMES` **只登记名字**；占位图门**未被放宽**。
 *
 * 纪律：不打印任何密钥 / 令牌；不碰任何服务；断言失败 ⇒ 退出码非 0。
 *
 * 用法：node scripts/verify-direct-write.mjs
 */

import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const fileUrl = (p) => pathToFileURL(`${ROOT}/${p}`).href
const require = createRequire(`${ROOT}/package.json`)

/* ---------------------------------------------------------------------------
   0. localStorage / window 假体（只为让 ESM 真源在本机 Node 下可导入）
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
   1. 断言（沿既有套件形态：check(id, desc, expected, actual)）
   --------------------------------------------------------------------------- */
const results = []
let failures = 0
function check(id, desc, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual)
  if (!ok) failures += 1
  results.push({ id, pass: ok })
  console.log(JSON.stringify({ id, case: desc, pass: ok, expected, actual }))
}
const text = (v) => (v === undefined || v === null ? '' : String(v))
const sorted = (list) => list.slice().sort()
const note = (id, desc, value) => console.log(JSON.stringify({ id, case: desc, value }))

/* ---------------------------------------------------------------------------
   2. 注入式内存假 DB（与既有套件同形；无 `db.command` ⇒ 发号走「旧值 + 1」回退）
   --------------------------------------------------------------------------- */
const PLATFORM_GET_CAP = 100
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
      const hit = (match) => all().filter((row) => Object.keys(match).every((k) => row[k] === match[k]))
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
              return { data: limit > 0 ? rows.slice(0, limit) : rows.slice(0, PLATFORM_GET_CAP) }
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
          return { data: all().slice(0, PLATFORM_GET_CAP) }
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
    rows: (name) => [...mapOf(name).values()].map((row) => Object.assign({}, row)),
    counts: () => ({
      seals: mapOf('xiai_seals').size,
      faces: mapOf('xiai_faces').size,
      images: mapOf('xiai_images').size,
      counters: mapOf('xiai_counters').size
    })
  }
}

/* ---------------------------------------------------------------------------
   3. 载入真源 ＋ 注入假 DB ＋ env（**本文件只在离线进程内设值**；生产真源 ＝ 云函数环境变量）
   --------------------------------------------------------------------------- */
const ops = require(`${ROOT}/cloudfunctions/xiai-user-token/lib/ops.js`)
const config = require(`${ROOT}/cloudfunctions/xiai-user-token/lib/config.js`)
const codeId = require(`${ROOT}/cloudfunctions/xiai-user-token/lib/codeId.js`)

const DIRECT_PHONE = '13900000001'
const ADMIN_PHONE = '13800000000'
const OTHER_PHONE = '13900000002'
const SOURCE = 'feicui-local-dist'
const NOW = 1761600000
const CONTEXT = { adminPhone: ADMIN_PHONE, nowSeconds: NOW }
const IDENTITY = { uid: 'u-direct', phone: DIRECT_PHONE, role: 'user', identity_source: 'SERVER_TOKEN' }
const ADMIN_IDENTITY = { uid: 'u-admin', phone: ADMIN_PHONE, role: 'user', identity_source: 'SERVER_TOKEN' }
const OTHER_IDENTITY = { uid: 'u-other', phone: OTHER_PHONE, role: 'user', identity_source: 'SERVER_TOKEN' }
const SESSION_IDENTITY = { uid: 'u-session', phone: '', role: 'admin', identity_source: 'SESSION' }

function setDirectEnv(phone, sources) {
  if (phone === null) delete process.env.XIAI_DIRECT_WRITE_PHONE
  else process.env.XIAI_DIRECT_WRITE_PHONE = phone
  if (sources === null) delete process.env.XIAI_DIRECT_WRITE_SOURCES
  else process.env.XIAI_DIRECT_WRITE_SOURCES = sources
}
setDirectEnv(DIRECT_PHONE, `${SOURCE},sealbank-local`)

/* 主库：号源**先播种** ⇒ 跳过「以既有行最大号播种」分支 ⇒ 号从 1 起，确定性。 */
let store = createStore([
  { __collection: 'xiai_counters', _id: 'seal', seq: 0 },
  { __collection: 'xiai_counters', _id: 'face', seq: 0 }
])
ops.setOpsDbProvider(store.provider)

const digestOf = (tag) => createHash('sha256').update(tag, 'utf8').digest('hex')
const keyOf = (sha) => `xiai/images/${sha.slice(0, 2)}/${sha}.tiff`

function faceDef(kind, tag, extra) {
  const sha = digestOf(tag)
  return Object.assign(
    {
      kind,
      seal_name: '直寫印',
      dynasty: '清中期',
      seal_type: '私印',
      face_style: '浙派',
      seal_class: '流派印',
      author: '趙之謙',
      transcription: '直寫釋文甲',
      image_storage_key: keyOf(sha),
      image_sha256: sha,
      image_bytes: 2048,
      image_mime: 'image/tiff',
      image_source_kind: 'yt'
    },
    extra || {}
  )
}
function payloadOf(sourceSealId, faces, extra) {
  /* 印章级键面 ＝ 导入行 8 键（`face_style` / `seal_class` **只在印面级** —— 封闭键面同 `submitSealImport`）。 */
  return Object.assign(
    {
      source: SOURCE,
      source_seal_id: sourceSealId,
      seal_name: '直寫印',
      dynasty: '清中期',
      seal_type: '私印',
      seal_style: '浙派',
      material: '石',
      shape: '方形',
      author: '趙之謙',
      transcription: '直寫釋文甲',
      faces
    },
    extra || {}
  )
}
const run = (payload, identity, ctx) =>
  ops.ADMIN_OPS.createSealWithFaceDirect(payload, identity || IDENTITY, ctx || CONTEXT)
const query = (payload, identity, ctx) =>
  ops.ADMIN_OPS.querySealByFingerprint(payload, identity || IDENTITY, ctx || CONTEXT)
const isDenial = (res) => res && res.ok === false && Object.keys(res).length === 3
const seenReasons = new Set()
const denyReason = (res) => {
  if (res && res.ok === false) seenReasons.add(res.reason)
  return res && res.reason
}
const rawReason = (res) => (res && res.reason) || ''

/* ===========================================================================
   A 段：新建（单面印 → 多面印 → 同图去重）
   =========================================================================== */
console.log(JSON.stringify({ section: 'A', title: '新建：号面齐 ＋ 面行落 image_sha256 ＋ plan 顺序' }))
const SHA_A = digestOf('face-A')
const first = await run(payloadOf('src-001', [faceDef('FACE', 'face-A')]))
check('A1', '新建 ok:true', true, first.ok === true)
check('A2', '`row` 业务键面**恰含** 9 键（走 row 透传，不改 index.js 白名单）', sorted(ops.DIRECT_WRITE_ROW_KEYS), sorted(Object.keys(first.row)))
check('A3', '`sid` 恰 5 位且在号域内（1 → AAAAB）', { sid: 'AAAAB', pattern: true }, { sid: first.row.sid, pattern: codeId.SID_PATTERN.test(first.row.sid) })
check('A4', '`fid` 恰 8 位零填充（1 → 00000001）', { fid: '00000001', pattern: true }, { fid: first.row.fid, pattern: codeId.FID_PATTERN.test(first.row.fid) })
check('A5', 'seal_no / face_no 齐（1 / 1）', { seal_no: 1, face_no: 1 }, { seal_no: first.row.seal_no, face_no: first.row.face_no })
check('A6', 'face_id ＝ fc-<印章序号>-f1', 'fc-AAAAB-f1', first.row.face_id)
check('A7', 'image_id ＝ 影像登记行 id（img- ＋摘要前 16 位）', `img-${SHA_A.slice(0, 16)}`, first.row.image_id)
check('A8', '新建 idempotent:false', false, first.row.idempotent)
check('A9', 'faces[] 恰 1 条且单条键面恰含 5 键', { n: 1, keys: sorted(ops.DIRECT_WRITE_FACE_KEYS) }, { n: first.row.faces.length, keys: sorted(Object.keys(first.row.faces[0])) })
check('A10', 'plan 写序：影像登记行 → 印章行 → 印面行（全部 kind=set）', ['xiai_images', 'xiai_seals', 'xiai_faces'], first.plan.writes.map((w) => w.collection))
check('A11', 'plan 首写 id ＝ 影像登记行 id（`docId` 由 persist 首个 set 派生）', `img-${SHA_A.slice(0, 16)}`, first.plan.writes[0].id)
await ops.persist(first.plan)
const faceRowA = store.rows('xiai_faces')[0]
const sealRowA = store.rows('xiai_seals')[0]
const imageRowA = store.rows('xiai_images')[0]
check('A12', '**面行落 `image_sha256`**（口径③：面行必落）', SHA_A, faceRowA.image_sha256)
check('A13', '**印章行不落** `image_sha256`（口径③：印章行不必）', false, Object.prototype.hasOwnProperty.call(sealRowA, 'image_sha256'))
check('A14', '印章行 review_status ＝ APPROVED（无审核直写落在既有值上）', 'APPROVED', sealRowA.review_status)
check('A15', '印章行 stamp_id ＝ sid ＝ id', true, sealRowA.stamp_id === sealRowA.sid && sealRowA.id === sealRowA.sid)
check('A16', '印章行**不落** batch_id / raw_json / image_status（直写不经暂存行）', [], Object.keys(sealRowA).filter((k) => ['batch_id', 'raw_json', 'image_status'].indexOf(k) !== -1))
check('A17', '影像登记行字段面恰含设计件 §3.2 ⑤ 的 11 键', ['bytes', 'height', 'id', 'kind', 'mime', 'sha256', 'storage', 'storage_key', 'stamp_id', 'updated_at', 'width'].sort(), sorted(Object.keys(imageRowA).filter((k) => k !== '_id')))
check('A18', '影像登记行 storage=server / mime=image/tiff / 摘要 ≡ 键内摘要', { storage: 'server', mime: 'image/tiff', match: true }, { storage: imageRowA.storage, mime: imageRowA.mime, match: imageRowA.storage_key === keyOf(SHA_A) && imageRowA.sha256 === SHA_A })
check('A19', '影像登记行 stamp_id 回填 ＝ sid', sealRowA.stamp_id, imageRowA.stamp_id)
check('A20', '面行 face_image_id ＝ 影像登记行 id', `img-${SHA_A.slice(0, 16)}`, faceRowA.face_image_id)
const cloudbase = await import(fileUrl('src/data/cloudbase.js'))
check('A21', '读面 `cloudBaseObjectKeyOf(登记行)` 派生 `.png` 展示键（.tiff 原图不下发前端）', keyOf(SHA_A).replace(/\.tiff$/, '.png'), cloudbase.cloudBaseObjectKeyOf(imageRowA))

/* A 段续：多面印（FACE ＋ 带图 EDGE）。 */
const SHA_B = digestOf('face-B')
const SHA_C = digestOf('edge-C')
const two = await run(payloadOf('src-002', [faceDef('FACE', 'face-B'), faceDef('EDGE', 'edge-C')]))
check('A22', '多面印 ok:true', true, two.ok === true)
check('A23', '`faces[]` 恰 2 条且 `fid` **不同**', true, two.row.faces.length === 2 && two.row.faces[0].fid !== two.row.faces[1].fid)
check('A24', '两面 `face_no` 递增（2 / 3）且 `kind` 齐（FACE / EDGE）', [{ no: 2, kind: 'FACE' }, { no: 3, kind: 'EDGE' }], two.row.faces.map((f) => ({ no: f.face_no, kind: f.kind })))
check('A25', '顶层 `fid` / `face_id` / `image_id` ＝ **首个 FACE 面**', { fid: two.row.faces[0].fid, face_id: two.row.faces[0].face_id, image_id: two.row.faces[0].image_id }, { fid: two.row.fid, face_id: two.row.face_id, image_id: two.row.image_id })
check('A26', 'EDGE 面 `face_id` 用 `e` 序号', 'fc-AAAAC-e1', two.row.faces[1].face_id)
await ops.persist(two.plan)
check('A27', '两面印落 2 条面行 / 2 条印章行 / 3 条影像行', { seals: 2, faces: 3, images: 3 }, { seals: store.counts().seals, faces: store.counts().faces, images: store.counts().images })
const edgeRow = store.rows('xiai_faces').find((r) => r.kind === 'EDGE')
check('A28', 'EDGE 面**也落** `image_sha256`（面行必落）＋ `edge_image_ids` 有值', { sha: SHA_C, hasEdge: true }, { sha: edgeRow.image_sha256, hasEdge: edgeRow.edge_image_ids.length === 1 })
check('A29', '发号连续不重号（seal_no 1/2、face_no 1/2/3）', { seals: [1, 2], faces: [1, 2, 3] }, { seals: store.rows('xiai_seals').map((r) => r.seal_no).sort(), faces: store.rows('xiai_faces').map((r) => r.face_no).sort() })

/* A 段续：同一张图被另一枚印引用 ⇒ 影像行不增（内容寻址去重）。 */
const countsBeforeSameImage = store.counts()
const same = await run(payloadOf('src-003', [faceDef('FACE', 'face-B')]))
await ops.persist(same.plan)
check('A30', '同图另一枚印 ⇒ 影像行**不增**（内容寻址 `img-<sha16>` 幂等覆写）', { images: countsBeforeSameImage.images, seals: countsBeforeSameImage.seals + 1 }, { images: store.counts().images, seals: store.counts().seals })
check('A31', '第三枚印拿到新 sid（AAAAD）', 'AAAAD', same.row.sid)

/* ===========================================================================
   B 段：幂等（同 source ＋ source_seal_id）
   =========================================================================== */
console.log(JSON.stringify({ section: 'B', title: '幂等：二次调用零新增行、不改写既有行、无 plan' }))
const countsBeforeIdem = store.counts()
const sealRowBefore = JSON.stringify(store.rows('xiai_seals').find((r) => r.source_seal_id === 'src-001'))
const idem = await run(payloadOf('src-001', [faceDef('FACE', 'face-A')]))
check('B1', '幂等回包 ok:true ＋ `idempotent:true`', { ok: true, idempotent: true }, { ok: idem.ok, idempotent: idem.row && idem.row.idempotent })
check('B2', '`sid` / `fid` / `seal_no` / `face_no` 与首次**逐字相同**', { sid: first.row.sid, fid: first.row.fid, seal_no: 1, face_no: 1 }, { sid: idem.row.sid, fid: idem.row.fid, seal_no: idem.row.seal_no, face_no: idem.row.face_no })
check('B3', '幂等路**无 `plan`**（index.js 恒 shouldPersist=false）', false, Object.prototype.hasOwnProperty.call(idem, 'plan'))
check('B4', '**集合行数不变**（seals / faces / images / counters 全同）', countsBeforeIdem, store.counts())
check('B5', '既有印章行**逐字节未被改写**', sealRowBefore, JSON.stringify(store.rows('xiai_seals').find((r) => r.source_seal_id === 'src-001')))
check('B6', '幂等回包 `row` 键面仍恰含 9 键', sorted(ops.DIRECT_WRITE_ROW_KEYS), sorted(Object.keys(idem.row)))
const countsBeforeReplay = store.counts()
const replay = await run(payloadOf('src-001', [faceDef('FACE', 'face-A-RETAKE')]))
check('B7', '同键换图 ⇒ 仍幂等、新图**不落**（行数全同）', { idempotent: true, counts: countsBeforeReplay }, { idempotent: replay.row && replay.row.idempotent, counts: store.counts() })
check('B8', '换图不改写既有面行摘要', SHA_A, store.rows('xiai_faces').find((r) => r.kind === 'FACE').image_sha256)

/* ===========================================================================
   C 段：对照三态（FULL / IMAGE_DIFF / NONE）
   =========================================================================== */
console.log(JSON.stringify({ section: 'C', title: 'querySealByFingerprint：三态一次回齐 ＋ 只读零写' }))
const countsBeforeQuery = store.counts()
const TEXT = { transcription: '直寫釋文甲', dynasty: '清中期', author: '趙之謙' }
const full = await query(Object.assign({ image_sha256: SHA_B }, TEXT))
check('C1', '同三元组同 sha ⇒ `FULL`', 'FULL', full.row.match)
check('C2', 'FULL 命中**多面印**（faces[] 两条）', { sid: two.row.sid, n: 2 }, { sid: full.row.sid, n: full.row.faces.length })
check('C3', 'FULL 命中行 `sid/fid/face_id/seal_name/image_id/image_sha256` 齐', { sid: two.row.sid, fid: two.row.fid, face_id: two.row.face_id, seal_name: '直寫印', image_id: two.row.image_id, image_sha256: SHA_B }, { sid: full.row.sid, fid: full.row.fid, face_id: full.row.face_id, seal_name: full.row.seal_name, image_id: full.row.image_id, image_sha256: full.row.image_sha256 })
check('C4', 'FULL 回包 `row` 键面**恰含** 8 键', sorted(ops.SEAL_FINGERPRINT_ROW_KEYS), sorted(Object.keys(full.row)))
check('C5', 'FULL `faces[]` 单条键面恰含 4 键', sorted(ops.SEAL_FINGERPRINT_FACE_KEYS), sorted(Object.keys(full.row.faces[0])))
check('C6', '单面印亦判 `FULL`', { match: 'FULL', sid: first.row.sid, fid: first.row.fid }, { match: (await query(Object.assign({ image_sha256: SHA_A }, TEXT))).row.match, sid: (await query(Object.assign({ image_sha256: SHA_A }, TEXT))).row.sid, fid: (await query(Object.assign({ image_sha256: SHA_A }, TEXT))).row.fid })
const diff = await query(Object.assign({ image_sha256: digestOf('face-A-OTHER') }, TEXT))
check('C7', '同三元组改 sha ⇒ `IMAGE_DIFF`', 'IMAGE_DIFF', diff.row.match)
check('C8', 'IMAGE_DIFF 回首枚命中印的 `sid`（不新增行）', first.row.sid, diff.row.sid)
check('C9', 'IMAGE_DIFF `faces[]` 逐面回**面行上的** `image_sha256`（服务端判据，前端不自拼）', true, diff.row.faces.length === 1 && diff.row.faces[0].image_sha256 === SHA_A)
const none = await query({ transcription: '不存在的釋文', dynasty: '清中期', image_sha256: SHA_A })
check('C10', '改释文 ⇒ `NONE` ＋ 空 `sid` ＋ 空 `faces[]`', { match: 'NONE', sid: '', faces: [] }, { match: none.row.match, sid: none.row.sid, faces: none.row.faces })
check('C11', '三态互不相同（唯一判据键 `match`）', ['FULL', 'IMAGE_DIFF', 'NONE'], [full.row.match, diff.row.match, none.row.match])
check('C12', '**只读零写**（查询前后四集合计数全同）', countsBeforeQuery, store.counts())
check('C13', '查询无 `plan`（恒 shouldPersist=false）', false, Object.prototype.hasOwnProperty.call(full, 'plan'))
check('C14', '管理员身份亦可查询（读面二选一放行）', 'FULL', (await query(Object.assign({ image_sha256: SHA_B }, TEXT), ADMIN_IDENTITY)).row.match)
check('C15', '三元组一个都不给 ⇒ MISSING_REQUIRED（恰 3 键）', { ok: false, reason: 'MISSING_REQUIRED', keys: 3 }, { ok: (await query({ image_sha256: SHA_B })).ok, reason: denyReason(await query({ image_sha256: SHA_B })), keys: Object.keys(await query({ image_sha256: SHA_B })).length })
check('C16', '不给 sha ⇒ 命中即 `IMAGE_DIFF`（「同图」无判据 ⇒ 不谎报 FULL）', 'IMAGE_DIFF', (await query({ transcription: '直寫釋文甲' })).row.match)
{
  const foreign = await query(Object.assign({ image_sha256: SHA_B }, TEXT), OTHER_IDENTITY)
  check('C17', '非白名单身份 ⇒ FORBIDDEN（恰 3 键）', true, isDenial(foreign) && foreign.reason === 'FORBIDDEN')
}
check('C18', '载荷未知键 / 身份类键 ⇒ INVALID_FIELD', 'INVALID_FIELD', denyReason(await query(Object.assign({ uid: 'u-fake' }, TEXT, { image_sha256: SHA_B }))))

/* ===========================================================================
   D 段：硬门（S1/S2 ＋ 载荷失败面；全部恰 3 键 ＋ 零写入）
   =========================================================================== */
console.log(JSON.stringify({ section: 'D', title: '硬门：S1 分权 ＋ S2 来源白名单 ＋ 载荷失败面（零写入）' }))
const gatePayload = () => payloadOf('src-gate', [faceDef('FACE', 'face-gate')])
const beforeD = store.counts()
{
  const d1 = await run(gatePayload(), OTHER_IDENTITY)
  check('D1', '非 `XIAI_DIRECT_WRITE_PHONE` ⇒ FORBIDDEN（恰 3 键）', { ok: false, reason: 'FORBIDDEN', keys: 3 }, { ok: d1.ok, reason: denyReason(d1), keys: Object.keys(d1).length })

  setDirectEnv(null, SOURCE)
  check('D2', '缺 `XIAI_DIRECT_WRITE_PHONE` ⇒ **fail-closed**（STORAGE_UNAVAILABLE，不是放行）', 'STORAGE_UNAVAILABLE', denyReason(await run(gatePayload())))
  setDirectEnv(DIRECT_PHONE, null)
  check('D3', '缺 `XIAI_DIRECT_WRITE_SOURCES` ⇒ **fail-closed 拒所有直写**（STORAGE_UNAVAILABLE）', 'STORAGE_UNAVAILABLE', denyReason(await run(gatePayload())))
  setDirectEnv(DIRECT_PHONE, '  ,  ')
  check('D4', '来源白名单全空白（无有效项）⇒ 同样 fail-closed', 'STORAGE_UNAVAILABLE', denyReason(await run(gatePayload())))
  setDirectEnv(DIRECT_PHONE, `${SOURCE},sealbank-local`)

  check('D5', 'source 不在白名单表内 ⇒ FORBIDDEN', 'FORBIDDEN', denyReason(await run(payloadOf('src-gate', [faceDef('FACE', 'face-gate')], { source: 'not-in-table' }))))

  /* S1 分权：该手机号**同时**在管理员白名单里（泄漏面）⇒ `review*` 系 5 op 全拒。
     `LEAK_CONTEXT.adminPhone` 逐字 ＝ 该手机号 ⇒ 管理员白名单门**先放行** ⇒ 只有 S1 门能拦。 */
  const LEAK_CONTEXT = { adminPhone: DIRECT_PHONE, nowSeconds: NOW }
  const reviewOps = ['reviewCorrection', 'reviewPersonProposal', 'reviewPersonImport', 'reviewSealImport', 'reviewItemImport']
  const reviewReasons = []
  for (const op of reviewOps) {
    const res = await ops.ADMIN_OPS[op]({ batch_id: 'B-X', import_id: 'x', correction_id: 'x', decision: 'ACCEPTED', note: '' }, IDENTITY, LEAK_CONTEXT)
    reviewReasons.push({ op, ok: res.ok, reason: res.reason, keys: Object.keys(res).length })
  }
  check('D6', '直写身份调 `review*` 系 5 op **全拒**（S1 分权；恰 3 键 FORBIDDEN）', reviewOps.map((op) => ({ op, ok: false, reason: 'FORBIDDEN', keys: 3 })), reviewReasons)
  const stillAllowed = await run(gatePayload())
  check('D7', '同一身份调直写 op **仍放行**（分权不是拉黑；且 op 只产 plan ⇒ 本条零写入）', { ok: true, hasPlan: true }, { ok: stillAllowed.ok, hasPlan: Object.prototype.hasOwnProperty.call(stillAllowed, 'plan') })
  const notForbidden = await ops.ADMIN_OPS.reviewSealImport({ batch_id: 'B-X', decision: 'ACCEPTED' }, ADMIN_IDENTITY, CONTEXT)
  check('D8', '管理员身份**不受 S1 误伤**（走到既有取行分支、reason ≠ FORBIDDEN）', { ok: false, notForbidden: true }, { ok: notForbidden.ok, notForbidden: rawReason(notForbidden) !== 'FORBIDDEN' })
  check('D9', '平台会话路（无手机号）⇒ FORBIDDEN（直写面只认分权白名单手机号，fail-closed）', 'FORBIDDEN', denyReason(await run(gatePayload(), SESSION_IDENTITY)))
  check('D10', '占位图门未被放宽：`feicui-local-dist` 引用占位键 ⇒ `INVALID_VALUE`（零写入）', 'INVALID_VALUE', denyReason(await run(payloadOf('src-gate', [{ kind: 'FACE', seal_name: 'x', image_storage_key: ops.SEAL_PLACEHOLDER_IMAGE_KEY, image_sha256: ops.SEAL_PLACEHOLDER_IMAGE.sha256, image_bytes: ops.SEAL_PLACEHOLDER_IMAGE.bytes }]))))

  /* 载荷失败面（16 类）。 */
  const fails = []
  const grab = async (label, payload, identity) => {
    const res = await run(payload, identity)
    fails.push({ label, ok: res.ok, reason: res.reason, keys: Object.keys(res).length })
    return res
  }
  await grab('载荷非对象', null)
  await grab('未知键', payloadOf('src-x', [faceDef('FACE', 'face-x')], { nope: 1 }))
  await grab('身份类键', payloadOf('src-x', [faceDef('FACE', 'face-x')], { uid: 'u-fake' }))
  await grab('缺 source_seal_id', payloadOf('', [faceDef('FACE', 'face-x')]))
  await grab('faces 空', payloadOf('src-x', []))
  await grab('FACE 无影像引用', payloadOf('src-x', [{ kind: 'FACE', seal_name: 'x' }]))
  await grab('摘要形态不符', payloadOf('src-x', [faceDef('FACE', 'face-x', { image_sha256: 'nope' })]))
  await grab('对象键形态不符', payloadOf('src-x', [faceDef('FACE', 'face-x', { image_storage_key: 'xiai/images/aa/bb.png' })]))
  await grab('键内摘要 ≠ 声称摘要', payloadOf('src-x', [faceDef('FACE', 'face-x', { image_storage_key: keyOf(digestOf('other')) })]))
  await grab('体量超限（> 4 MiB）', payloadOf('src-x', [faceDef('FACE', 'face-x', { image_bytes: 5 * 1024 * 1024 })]))
  await grab('体量缺失', payloadOf('src-x', [faceDef('FACE', 'face-x', { image_bytes: 0 })]))
  await grab('源侧形态门（空串）', payloadOf('src-x', [faceDef('FACE', 'face-x')], { seal_org: '' }))
  await grab('自由文本超长（印章级）', payloadOf('src-x', [faceDef('FACE', 'face-x')], { seal_name: 'x'.repeat(501) }))
  await grab('自由文本超长（印面级）', payloadOf('src-x', [faceDef('FACE', 'face-x', { transcription: 'x'.repeat(501) })]))
  await grab('值域外（dynasty）', payloadOf('src-x', [faceDef('FACE', 'face-x')], { dynasty: '北朝' }))
  await grab('值域外（faces[].seal_class）', payloadOf('src-x', [faceDef('FACE', 'face-x', { seal_class: '宮印' })]))
  note('D11a', '16 类失败面读数（label / reason / keys）', fails.map((f) => ({ label: f.label, reason: f.reason, keys: f.keys })))
  check('D11', '16 类载荷失败面**全部**结构化拒绝 ＋ 恰 3 键', true, fails.length === 16 && fails.every((f) => f.ok === false && f.keys === 3))
  check('D12', '失败 reason 只在冻结表内（3 值；**零新增字面值**）', ['INVALID_FIELD', 'INVALID_VALUE', 'MISSING_REQUIRED'], sorted([...new Set(fails.map((f) => f.reason))]))
  check('D13', '**D 段零写入**（16 类失败面 ＋ 5 道硬门 ＋ 2 条只产 plan 的成功路 ⇒ 集合计数不变）', beforeD, store.counts())
}

/* ===========================================================================
   E 段：号域越界（结构化拒绝 ＋ 零写入）
   =========================================================================== */
console.log(JSON.stringify({ section: 'E', title: '号域：seal_no 推到 5,153,632 ⇒ 结构化拒绝、零写入' }))
{
  const beforeE = store.counts()
  note('E0', '号源基线读数（主库 seal / face 当前 seq；**空洞合法**：号在 plan 组装期即消耗，未落盘只留洞、不重号）', store.rows('xiai_counters').map((r) => ({ _id: r._id, seq: r.seq })))

  /* seal 号源满：`seq = SID_MAX - 1 = 5,153,631` ⇒ 下一号 5,153,632 越界。 */
  const capSealStore = createStore([
    { __collection: 'xiai_counters', _id: 'seal', seq: codeId.SID_MAX - 1 },
    { __collection: 'xiai_counters', _id: 'face', seq: 0 }
  ])
  ops.setOpsDbProvider(capSealStore.provider)
  const sealFull = await run(payloadOf('src-cap', [faceDef('FACE', 'face-cap')]))
  check('E1', 'seal 号源满 ⇒ `INVALID_VALUE`（恰 3 键）', { ok: false, reason: 'INVALID_VALUE', keys: 3 }, { ok: sealFull.ok, reason: denyReason(sealFull), keys: Object.keys(sealFull).length })
  check('E2', 'seal 号源满 ⇒ **零写入**（四集合计数全 0，且无 `plan`）', { seals: 0, faces: 0, images: 0, plan: false }, { seals: capSealStore.counts().seals, faces: capSealStore.counts().faces, images: capSealStore.counts().images, plan: Object.prototype.hasOwnProperty.call(sealFull, 'plan') })

  /* face 号源满：seal 发号成功、面发号越界 ⇒ 构造器回 `{ok:false}` ⇒ op 转结构化拒绝。 */
  const capFaceStore = createStore([
    { __collection: 'xiai_counters', _id: 'seal', seq: 0 },
    { __collection: 'xiai_counters', _id: 'face', seq: codeId.FID_MAX - 1 }
  ])
  ops.setOpsDbProvider(capFaceStore.provider)
  const faceFull = await run(payloadOf('src-cap2', [faceDef('FACE', 'face-cap2')]))
  check('E3', 'face 号源满 ⇒ `INVALID_VALUE`（构造器失败面转结构化拒绝）', 'INVALID_VALUE', denyReason(faceFull))
  check('E4', 'face 号源满 ⇒ **零写入**（四集合计数全 0，且无 `plan`）', { seals: 0, faces: 0, images: 0, plan: false }, { seals: capFaceStore.counts().seals, faces: capFaceStore.counts().faces, images: capFaceStore.counts().images, plan: Object.prototype.hasOwnProperty.call(faceFull, 'plan') })

  ops.setOpsDbProvider(store.provider)
  check('E5', '主库**未被号域测试污染**（计数与 E 段开始时一致）', beforeE, store.counts())
}

/* ===========================================================================
   F 段：注册面 ＋ 回包纪律 ＋ env 只登记名字
   =========================================================================== */
console.log(JSON.stringify({ section: 'F', title: '注册面 / 回包纪律 / reason 零新增' }))
check('F1', '`ADMIN_OPS` 恰含 16 项（原 12 ＋ 直写两 op ＋ AI 上游两 op）', sorted([
  'createSealWithFaceDirect',
  'getAiUpstream',
  'issueFeicuiToken',
  'migrateCodeNumbers',
  'migrateDynastyValues',
  'migrateSealValueDomains',
  'pullImportRows',
  'querySealByFingerprint',
  'repairImportAcceptance',
  'reviewCorrection',
  'reviewItemImport',
  'reviewPersonImport',
  'reviewPersonProposal',
  'reviewSealImport',
  'setAiUpstream',
  'setInviteReward'
]), sorted(Object.keys(ops.ADMIN_OPS)))
check('F2', '两个新 op **未混入**用户写面 `OPS`（不开新的用户级面）', { direct: false, query: false }, { direct: Object.prototype.hasOwnProperty.call(ops.OPS, 'createSealWithFaceDirect'), query: Object.prototype.hasOwnProperty.call(ops.OPS, 'querySealByFingerprint') })
check('F3', '负对照（必红）：`ADMIN_OPS` 抽掉一个新 op ⇒ 与现实值不等', false, sorted(Object.keys(ops.ADMIN_OPS).filter((op) => op !== 'createSealWithFaceDirect')).join() === sorted(Object.keys(ops.ADMIN_OPS)).join())
const indexSource = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/index.js'), 'utf8')
check('F4', '`index.js` **未为新 op 开特判**（源文本不含两个 op 名 ⇒ 回包走通用 `row` 通道、全局回包白名单一字未改）', { direct: 0, query: 0 }, { direct: indexSource.split('createSealWithFaceDirect').length - 1, query: indexSource.split('querySealByFingerprint').length - 1 })
check('F5', '`index.js` 成功回包 `row` 仍逐字透传（零过滤）＋ `plan` 不在外传键面', true, /row: opResult\.row/.test(indexSource) && !/plan: opResult\.plan/.test(indexSource))
check('F6', '`config.js::ENV_NAMES` 只登记**名字**（两键在册）', { phone: 'XIAI_DIRECT_WRITE_PHONE', sources: 'XIAI_DIRECT_WRITE_SOURCES' }, { phone: config.ENV_NAMES.DIRECT_WRITE_PHONE, sources: config.ENV_NAMES.DIRECT_WRITE_SOURCES })
check('F7', '新 env 名与管理员函数 env 名**不重名**（令牌 / 权限不跨函数通用）', true, [config.ENV_NAMES.DIRECT_WRITE_PHONE, config.ENV_NAMES.DIRECT_WRITE_SOURCES].every((n) => n !== config.ENV_NAMES.ADMIN_PHONE))
const configSource = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/config.js'), 'utf8')
check('F8', '`config.js` **不写值**（无 11 位手机号字面值）', [], (configSource.match(/\d{11}/g) || []))
check('F9', 'env 读数纯函数：空 env ⇒ 空 phone ＋ 空表（fail-closed 前提）', { phone: '', sources: [] }, ops.directWriteEnvOf({}))
check('F10', 'env 读数纯函数：逗号表归一（去空白、滤空项、手机号归一）', { phone: '13900000001', sources: ['a', 'b'] }, ops.directWriteEnvOf({ XIAI_DIRECT_WRITE_PHONE: ' 139-0000-0001 ', XIAI_DIRECT_WRITE_SOURCES: ' a , ,b ' }))
check('F11', '`reason` **零新增字面值**（本套件出现的拒绝 reason 全在 `config.REASONS` 冻结表内）', true, [...seenReasons].every((r) => Object.keys(config.REASONS).indexOf(r) !== -1))

/* ===========================================================================
   收尾
   =========================================================================== */
const passed = results.filter((r) => r.pass).length
console.log(JSON.stringify({ summary: { total: results.length, passed, failures } }))
if (failures > 0) {
  console.error(`FAILED: ${failures} / ${results.length}`)
  process.exit(1)
}
console.log(`ALL GREEN: ${passed} / ${results.length}`)
