#!/usr/bin/env node
/**
 * 玺爱 · **无审核直写面自检**（`createSealWithFaceDirect` ＋ `querySealByFingerprint`）
 * ============================================================================
 * **本地、离线、零网络、零云端**：注入式内存假 DB，跑的是
 * `cloudfunctions/xiai-user-token/lib/ops.js` 的**真实函数体**（与 `index.js` 同一注册面）。
 *
 * 跑什么（七段；每条可机械判负）：
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
 *   G. **【取】同面归档（2026-11-25 Kevin 拍板 A）**：`updateFaceAttributes` 换图（`face_image_id`
 *      A → B，A / B 皆非空且不等）⇒ 写步**恰 3 条、顺序即契约**「① 面行指向 → ② 新图 B
 *      `visibility:'visible'` ＋ `marked:true`（`marked_by` / `marked_at` 只从服务端取）→ ③ 旧图 A
 *      `visibility:'hidden'`」；B 与 A 同值 / B 空 ⇒ **恰 1 条**（零额外写）；第 3 步失败 ⇒
 *      如实回包（**不谎报零写入**）＋ 半分态读数 ＋ 重试幂等 ＋ 回退后同一次【取】补齐归档。
 *
 * 纪律：不打印任何密钥 / 令牌；不碰任何服务；断言失败 ⇒ 退出码非 0。
 *
 * 用法：node scripts/verify-direct-write.mjs
 */


/* **测试环境保护哨兵（硬防线）** —— 本套件只跑离线假 CARD：置 `XIAI_NO_REAL_CARD=1`。
   若哪个调用点漏注入假传输，`lib/cardApi.js` 会**当场抛错、零请求**（绝不悄悄打生产 CARD）。
   跑任何套件前**不得** export 真 `CARD_API_KEY`（见 `scripts/README-test-net.md`）。 */
process.env.XIAI_NO_REAL_CARD = '1'
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
check('A4', '`fid` 恰 8 位 base-22（1 → AAAAAAAB，与 sid 同一字母表）', { fid: 'AAAAAAAB', pattern: true }, { fid: first.row.fid, pattern: codeId.FID_PATTERN.test(first.row.fid) })
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
check('A17', '影像登记行字段面恰含设计件 §3.2 ⑤ 的 11 键 ＋ `seq`（`xiai_images` 唯一索引 `ux_stamp_id_kind_seq` 要求同印同类内 seq 互不重复）', ['bytes', 'height', 'id', 'kind', 'mime', 'seq', 'sha256', 'storage', 'storage_key', 'stamp_id', 'updated_at', 'width'].sort(), sorted(Object.keys(imageRowA).filter((k) => k !== '_id')))
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
check('F1', '`ADMIN_OPS` 恰含 52 项（2026-11-17 AI 候選圖可见性回填單增 `repairAiCandidateVisibility`（字典序位在 `registerFaceImage` 之後、`repairAuthorPersonId` 之前；函數、薄委派本文件实现点、零新 reason）⇒ 51 → 52；2026-11-15 印譜單 +3：`createBook` / `listBooks` / `setImageBook`，薄委派 `lib/books.js`；2026-11-14 1B/2C/3B face 層三 op `deleteWholeSealImage` / `migrateEdgeFaces` / `setBaseFace` 带入 41 → 44，均為函數、薄委派 `lib/faceLayerOps.js`、零新 reason；addSealFace ＋ 原 12 ＋ 直写两 op ＋ AI 上游两 op ＋ §3.68 ai-enhance-face ＋ ai-enhance-discard 管理员弃候选图＋ 勘误待审只读面 listPendingCorrectionsForAdmin〔2026-11-02 v1.84：管理员白名单门、跨用户 PENDING、零写入〕；来源说明：2026-10-31 弃候选图单新增 —— 管理员可【弃】不满意的 AI 修復候选图，零计费、零新集合）；2026-11-07 云模式印面圖替換增 replaceFaceImage（管理员原子入册影像行＋改面行指向，旧图与字节保留、零新 reason）；2026-11-08 异步两段式增 ai-enhance-list / ai-enhance-status / ai-enhance-submit（三 op 均落 `ADMIN_OPS`、字典序位在 `ai-enhance-face` 之后、`backfillAcceptedCorrections` 之前；提交即预扣、四态任务行、`status` / `list` 只读零写入、`reason` 零新增）；2026-11-09 云导入增 importFaceImages / importRelations（两 op 均落 `ADMIN_OPS`、字典序位在 `getAiUpstream` 之后、`issueFeicuiToken` 之前、零新 reason）；2026-11-10 影像行 storage 修复增 repairImageStorage（落 `ADMIN_OPS`、字典序位在 `registerFaceImage` 之后、`repairImportAcceptance` 之前、零新 reason）；2026-11-10 AI 修復提交段重排增 probeAiUpstream / repairOrphanEnhanceCharges（两 op 均落 `ADMIN_OPS`、字典序位分别在 `migrateSealValueDomains` 之后、`pullImportRows` 之前与 `repairImportAcceptance` 之后、`replaceFaceImage` 之前、函数、零新 reason）；2026-11-12 修复运维两 op 增 repairAuthorPersonId / repairPrimaryFace（字典序位分别在 `repairImageStorage` 之前与 `repairOrphanEnhanceCharges` 之后、`replaceFaceImage` 之前、函数、零新 reason）；2026-11-12 印面数修复单增 repairSealFaceCount（字典序位在 `repairPrimaryFace` 之后、`replaceFaceImage` 之前、函数、零新 reason）；2026-11-14 印章瀏覽量單增 repairSealViewCount（字典序位在 `repairSealFaceCount` 之後、`replaceFaceImage` 之前、函數、零新 reason）；2026-11-14 詳情頁新增印面單增 addSealFace（**字典序位在首位 —— 先於 `ai-enhance-discard`**、函數、薄委派 `lib/addSealFace.js`、零新 reason ⇒ 40 → 41）；2026-11-17 印譜封面 / 改名單增 `updateBook` / `setBookCover` / `listBookCovers`（均為函數、薄委派 `lib/books.js`、零新 reason；字典序位分别在 `setInviteReward` 之後、`setBaseFace` 之後 / `setImageBook` 之前、`listBooks` 之前 ⇒ 48 → 51）', sorted([
  'addSealFace',
  'ai-enhance-discard',
  'ai-enhance-face',
  'ai-enhance-list',
  'ai-enhance-status',
  'ai-enhance-submit',
  'backfillAcceptedCorrections',
  'createBook',
  'createSealUpload',
  'createSealWithFaceDirect',
  'deleteFaceImage',
  'deleteSeal',
  'deleteWholeSealImage',
  'getAiUpstream',
  'importFaceImages',
  'importRelations',
  'issueFeicuiToken',
  'listBookCovers',
  'listBooks',
  'listPendingCorrectionsForAdmin',
  'migrateCodeNumbers',
  'migrateDynastyValues',
  'migrateEdgeFaces',
  'migrateSealValueDomains',
  'probeAiUpstream',
  'pullImportRows',
  'querySealByFingerprint',
  'registerFaceImage',
  'repairAiCandidateVisibility',
  'repairAuthorPersonId',
  'repairImageStorage',
  'repairImportAcceptance',
  'repairOrphanEnhanceCharges',
  'repairPrimaryFace',
  'repairSealFaceCount',
  'repairSealViewCount',
  'replaceFaceImage',
  'reviewCorrection',
  'reviewItemImport',
  'reviewPersonImport',
  'reviewPersonProposal',
  'reviewSealImport',
  'revokeCorrectionAcceptance',
  'searchBookImages',
  'setAiUpstream',
  'setBaseFace',
  'setBookCover',
  'setImageBook',
  'setInviteReward',
  'updateBook',
  'updateFaceAttributes',
  'updateSealAttributes'
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
   G 段（本单新增 · 【取】同面归档）：`updateFaceAttributes` 换图三写步
   —— ① 面行指向 → ② 新图 `visible`＋`marked`（by/at 服务端取）→ ③ 旧图 `hidden`
   写序与写体全部走**记账包装 provider**（`writeLog`）逐条读回，不靠目测。
   =========================================================================== */
console.log(JSON.stringify({ section: 'G', title: '【取】同面归档：换图三写步 ＋ 幂等零额外写 ＋ 半分态如实' }))
{
  const SWAP_FACE_ID = 'fc-swap-g'
  const IMG_A = 'img-g-original'
  const IMG_B = 'img-g-ai'
  const IMG_SEAL = 'img-g-wholeseal'
  const seedSwap = () => [
    { __collection: 'xiai_faces', _id: SWAP_FACE_ID, id: SWAP_FACE_ID, seal_name: '換圖印', face_image_id: IMG_A },
    /* 旧图 A：普通原图、已 `visible` ＋ 已 `marked`（归档只该动 `visibility`）。 */
    { __collection: 'xiai_images', _id: IMG_A, id: IMG_A, source: 'original', storage: 'server', visibility: 'visible', marked: true, marked_by: 'u-legacy', marked_at: '2026-01-01T00:00:00.000Z' },
    /* 新图 B：AI 修復产物，入库即 `hidden` ＋ 未 `marked`（本单要补的两笔）。 */
    { __collection: 'xiai_images', _id: IMG_B, id: IMG_B, source: 'ai_enhance', storage: 'server', visibility: 'hidden', marked: false },
    /* 整枚章图（**非本面引用**）：归档绝不能碰到它。 */
    { __collection: 'xiai_images', _id: IMG_SEAL, id: IMG_SEAL, source: 'original', storage: 'server', visibility: 'visible', marked: true, marked_by: 'u-legacy', marked_at: '2026-01-01T00:00:00.000Z' }
  ]
  const writeLog = []
  /* 记账包装：只包 `where().update()`（本 op 全部写步都是它），读路径原样透传。 */
  const loggingProvider = (real, options) => () => ({
    collection(name) {
      const collection = real.collection(name)
      return Object.assign({}, collection, {
        where(match) {
          const api = collection.where(match)
          return Object.assign({}, api, {
            async update(doc) {
              if (options && options.failOn && options.failOn(name, match)) {
                throw Object.assign(new Error('synthetic: update refused'), { code: 500 })
              }
              const result = await api.update(doc)
              writeLog.push({ collection: name, match: match, doc: doc })
              return result
            }
          })
        }
      })
    }
  })
  const steps = () => writeLog.map((w) => `${w.collection}:${(w.match && (w.match._id || w.match.id)) || ''}`)
  const imageRow = (store, id) => store.rows('xiai_images').find((row) => row.id === id) || {}
  const faceRowOf = (store, id) => store.rows('xiai_faces').find((row) => row.id === id) || {}

  /* ---------------- 场景①：取 AI 候选（B 未 visible / 未 marked；A 存在且 visible） -------- */
  const swapStore = createStore(seedSwap())
  ops.setOpsDbProvider(loggingProvider(swapStore.provider()))
  const swapTake = (patch) => ops.ADMIN_OPS.updateFaceAttributes({ face_id: SWAP_FACE_ID, patch }, ADMIN_IDENTITY, CONTEXT)
  const first = await swapTake({ face_image_id: IMG_B })
  check('G1', '场景① 取 AI 候选 ⇒ ok:true（成功恰 2 键 {ok,row}）', { ok: true, keys: ['ok', 'row'] }, { ok: first.ok, keys: Object.keys(first).sort() })
  check('G2', '场景① 写步**恰 3 条且顺序即契约**：① 面行指向 → ② 新图 B → ③ 旧图 A', [`xiai_faces:${SWAP_FACE_ID}`, `xiai_images:${IMG_B}`, `xiai_images:${IMG_A}`], steps())
  check('G3', '场景① 第 ② 步写体恰 4 键 `marked / marked_by / marked_at / visibility`（不碰其它字段）', ['marked', 'marked_at', 'marked_by', 'visibility'], Object.keys(writeLog[1].doc).sort())
  check('G4', '场景① 第 ③ 步写体**恰 1 键** `visibility`＝`hidden`（只归档旧图、不碰 marked）', { visibility: 'hidden' }, writeLog[2].doc)
  check('G5', '场景① 回读 B ＝ `visible` ＋ `marked:true`', { visibility: 'visible', marked: true }, { visibility: imageRow(swapStore, IMG_B).visibility, marked: imageRow(swapStore, IMG_B).marked })
  check('G6', '场景① B 的 `marked_by` / `marked_at` **只从服务端取**（`identity.uid` ＋ `context.nowSeconds`；载荷只递 `face_image_id`）', { by: ADMIN_IDENTITY.uid, at: new Date(NOW * 1000).toISOString() }, { by: imageRow(swapStore, IMG_B).marked_by, at: imageRow(swapStore, IMG_B).marked_at })
  check('G7', '场景① 回读 A ＝ `hidden`（同面原图自动归档）且 `marked` 三键逐字未动', { visibility: 'hidden', marked: true, by: 'u-legacy', at: '2026-01-01T00:00:00.000Z' }, { visibility: imageRow(swapStore, IMG_A).visibility, marked: imageRow(swapStore, IMG_A).marked, by: imageRow(swapStore, IMG_A).marked_by, at: imageRow(swapStore, IMG_A).marked_at })
  check('G8', '场景① 面行指向已落 B', IMG_B, faceRowOf(swapStore, SWAP_FACE_ID).face_image_id)
  check('G9', '场景① **不归档非本面引用的影像**（整枚章图仍 `visible` ＋ 零写）', { visibility: 'visible', touched: false }, { visibility: imageRow(swapStore, IMG_SEAL).visibility, touched: writeLog.some((w) => w.match && (w.match._id === IMG_SEAL || w.match.id === IMG_SEAL)) })

  /* ---------------- 场景②：B 与 A 同值（重放同一次【取】）⇒ 恰 1 条写步（零额外写） ------- */
  writeLog.length = 0
  const replay = await swapTake({ face_image_id: IMG_B })
  check('G10', '场景② B 与 A 同值 ⇒ ok:true ＋ **恰 1 条写步**（零额外写：不重抬 visible、不重写 marked）', { ok: true, steps: [`xiai_faces:${SWAP_FACE_ID}`] }, { ok: replay.ok, steps: steps() })

  /* ---------------- 场景③：B 为空（只改其它属性）⇒ 恰 1 条写步 -------------------------- */
  writeLog.length = 0
  const otherOnly = await swapTake({ seal_name: '只改名不換圖' })
  check('G11', '场景③ 不带 `face_image_id`（只改其它属性）⇒ ok:true ＋ **恰 1 条写步**', { ok: true, steps: [`xiai_faces:${SWAP_FACE_ID}`] }, { ok: otherOnly.ok, steps: steps() })
  check('G12', '场景③ 影像行零改动（B / A / 章图三行 visibility 全不动）', { b: 'visible', a: 'hidden', seal: 'visible' }, { b: imageRow(swapStore, IMG_B).visibility, a: imageRow(swapStore, IMG_A).visibility, seal: imageRow(swapStore, IMG_SEAL).visibility })

  /* ---------------- 场景④：第 3 步失败 ⇒ 如实回包 ＋ 半分态 ＋ 重试幂等 ＋ 回退后补齐 ---- */
  writeLog.length = 0
  const failStore = createStore(seedSwap())
  ops.setOpsDbProvider(loggingProvider(failStore.provider(), { failOn: (name, match) => name === 'xiai_images' && !!match && (match._id === IMG_A || match.id === IMG_A) }))
  const broken = await swapTake({ face_image_id: IMG_B })
  check('G13', '场景④ 第 3 步失败 ⇒ 结构化拒绝（`STORAGE_UNAVAILABLE`、恰 3 键、reason 在冻结表内）', { ok: false, reason: 'STORAGE_UNAVAILABLE', keys: 3, inTable: true }, { ok: broken.ok, reason: denyReason(broken), keys: Object.keys(broken).length, inTable: Object.keys(config.REASONS).indexOf('STORAGE_UNAVAILABLE') !== -1 })
  check('G14', '场景④ 回包**如实**：不谎报「本次零寫入」，且点名第 3 / 3 步失败（`非零寫入`）', { zeroWriteClaim: false, failedStep: true }, { zeroWriteClaim: String(broken.message).indexOf('本次零寫入') !== -1, failedStep: String(broken.message).indexOf('第 3 / 3 步失敗') !== -1 && String(broken.message).indexOf('非零寫入') !== -1 })
  check('G15', '场景④ 半分态如实：面行已指 B、B 已 `visible`＋`marked`、**A 仍 `visible`**（写账恰 2 条、第 3 步未执行）', { face: IMG_B, b: 'visible/true', a: 'visible', writes: 2 }, { face: faceRowOf(failStore, SWAP_FACE_ID).face_image_id, b: `${imageRow(failStore, IMG_B).visibility}/${imageRow(failStore, IMG_B).marked}`, a: imageRow(failStore, IMG_A).visibility, writes: writeLog.length })
  /* 重试（注入解除）：面行已指 B ⇒ 换图信号消失 ⇒ 恰 1 条写步、B 零重写（幂等，不把已 visible 的再写一遍）。 */
  writeLog.length = 0
  ops.setOpsDbProvider(loggingProvider(failStore.provider()))
  const retry = await swapTake({ face_image_id: IMG_B })
  check('G16', '场景④ 重试同一次【取】⇒ ok:true ＋ **恰 1 条写步**（面行同值；B 已 visible/marked ⇒ 零重写 ⇒ 幂等）', { ok: true, steps: [`xiai_faces:${SWAP_FACE_ID}`] }, { ok: retry.ok, steps: steps() })
  /* 自愈闭环：把半分态的面行**指回取前值 A**（＝撤销本次指向）后重跑同一次【取】⇒ 归档补齐。 */
  writeLog.length = 0
  await failStore.provider().collection('xiai_faces').where({ _id: SWAP_FACE_ID }).update({ face_image_id: IMG_A })
  writeLog.length = 0
  const heal = await swapTake({ face_image_id: IMG_B })
  check('G17', '场景④ 回退半分态指向后重跑同一次【取】⇒ ok:true ＋ 写步**恰 2 条**（面行 ＋ 旧图 A 归档；B 已 visible/marked **零重写**）', { ok: true, steps: [`xiai_faces:${SWAP_FACE_ID}`, `xiai_images:${IMG_A}`] }, { ok: heal.ok, steps: steps() })
  check('G18', '场景④ 归档终态补齐：A ＝ `hidden`、B ＝ `visible`＋`marked:true`、章图仍 `visible`', { a: 'hidden', b: 'visible/true', seal: 'visible' }, { a: imageRow(failStore, IMG_A).visibility, b: `${imageRow(failStore, IMG_B).visibility}/${imageRow(failStore, IMG_B).marked}`, seal: imageRow(failStore, IMG_SEAL).visibility })

  ops.setOpsDbProvider(store.provider) /* 恢复主库注入（本段自建库，不污染后续读数）。 */
  note('G19', 'G 段写序读数（场景① 三条 ＋ 场景④ 半分态两条）', steps())
}

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
