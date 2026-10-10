/**
 * 玺爱 · **印章外部批量導入通道自检**（批 3 · Slice B′ 收編｜v1.55 §3.55 ＋ §4.1.17 ＋ §10.54）
 * ============================================================================
 * **本地、离线、零网络、零云端**；强制 dev / 離线形态（`writeFaceMode = 'local-dev'`）。
 * 本套件由 A′ 的自证脚本（`batch3-selfproof.mjs`，36 PASS / 0 FAIL）**收编为正式套件**：
 * 逐条对应当前冻结机制（① ＞ ⑧ ＋ 附），并**补两类新判据**：
 *   · **影像引用语义三条**：宣告了引用但解析不到 ⇒ 該條拒 ＋ 零寫入（IR1，原 ⑤）；
 *     `kind=FACE` 無任何引用 ⇒ 拒（IR2）；`kind=EDGE` 無引用 ⇒ **放行**（IR3，沿 canonical：邊款圖可選）。
 *   · **`AC-493` 〜 `AC-500` 里可機械判定的項**（C493 〜 C500 段）：集合名單一真源 / 三態單向 /
 *     冪等鍵 ＝ `source` ＋ `source_seal_id` / `imports.status` 與 `seals.review_status` 雙字段不混用 /
 *     存量 `review_status` 逐字節不遷移 / 白名單缺 env safe-reject ＋ 零寫入、非白名單 `FORBIDDEN` ＋
 *     零寫入 / `reason` 零新增（並附**負對照**證明尺會響）。
 *
 * 纪律：**不打印任何密钥 / 验证码 / 令牌原文**；不碰任何服务；断言失败 ⇒ 退出码非 0。
 *
 * 用法：node scripts/verify-seal-imports.mjs
 */

import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
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
   1. 断言与读数（沿既有套件形态：check(id, desc, expected, actual)）
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

/* ---------------------------------------------------------------------------
   2. 導入真源
   --------------------------------------------------------------------------- */
const writeFaceMode = await import(fileUrl('src/data/writeFaceMode.js'))
writeFaceMode.setWriteFaceModeOverride('local-dev')

const seed = await import(fileUrl('src/data/seed.js'))
const db = await import(fileUrl('src/data/db.js'))
const session = await import(fileUrl('src/data/session.js'))
const storage = await import(fileUrl('src/data/storage.js'))
const seals = await import(fileUrl('src/services/seals.js'))
const userOps = require(`${ROOT}/cloudfunctions/xiai-user-token/lib/ops.js`)

const FACE = 'FACE'
const EDGE = 'EDGE'
const ADMIN = { id: 'u-admin', phone: '13800000000', role: 'admin', nickname: '管理員' }
session.setUser(ADMIN)

/* 取一枚**真实存在**的种子影像摘要（采纳时影像引用校验用之）。 */
const seedImages = db.listImageRows()
const VALID_SHA = text(seedImages[0] && seedImages[0].sha256)
const DANGLING_SHA = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

console.log(JSON.stringify({ section: 'base', title: '基點與寫集現狀讀數' }))
console.log(JSON.stringify({
  seedImages: seedImages.length,
  validSha: VALID_SHA.slice(0, 12) + '…',
  seedSeals: db.listSealRows().length,
  seedFaces: db.listFaceRows().length,
  storageKeys: Object.keys(storage.STORAGE_KEYS).length
}))
/* K1 / K2：两条与既有套件（verify-endorsement D3c / verify-admin-write-via-login A1）同源的现态读数。 */
check('K1', 'STORAGE_KEYS 鍵總數 ＝ 27（v1.61：25 → 27，新增 items / itemImports）', 27, Object.keys(storage.STORAGE_KEYS).length)
check('K2', '`ADMIN_OPS` 含 `reviewSealImport`（v1.55 新增印章導入審核 op）', true, Object.prototype.hasOwnProperty.call(userOps.ADMIN_OPS, 'reviewSealImport'))

/* ---------------------------------------------------------------------------
   3. 存量快照（⑧ 用）＋ 導入行構造幫手
   --------------------------------------------------------------------------- */
const legacyReviewStatus = {}
db.listSealRows().forEach((row) => {
  legacyReviewStatus[text(row.stamp_id || row.id)] = text(row.review_status)
})
const legacyPending = Object.entries(legacyReviewStatus).filter(([, v]) => v === 'PENDING').map(([k]) => k).sort()

/* 構造導入行（本機鏡像行；繞過 submit 的冪等鍵去重以造同鍵雙行等場景） */
let seq = 0
function faceOf(sha, kind = FACE, extra = {}) {
  return {
    kind,
    seal_name: '測試印面',
    dynasty: '清初',
    seal_type: '私印',
    face_style: '三晉古璽',
    seal_class: '流派印',
    author: '',
    author_person_id: '',
    transcription: '測試',
    image_storage_key: '',
    image_sha256: sha,
    image_bytes: 1024,
    image_mime: 'image/tiff',
    ...extra
  }
}
function importRow({ batchId, source = 'SRC', sourceSealId, faces }) {
  seq += 1
  return {
    id: `si-test-${seq}`,
    batch_id: batchId,
    source,
    source_seal_id: sourceSealId,
    status: 'PENDING',
    seal_name: `導入印 ${sourceSealId}`,
    dynasty: '清初',
    seal_type: '私印',
    seal_style: '',
    material: '石',
    shape: '方形',
    author: '',
    transcription: '導入釋義',
    faces,
    content_fingerprint: '',
    imported_by: 'u-admin',
    imported_at: new Date().toISOString(),
    reviewed_at: null,
    reviewer_id: null,
    review_note: ''
  }
}
function pushImports(rows) {
  db.saveSealImportRows([...db.listSealImportRows(), ...rows])
}
const snapSeals = () => db.listSealRows().map((r) => JSON.stringify(r)).sort()
const snapFaces = () => db.listFaceRows().map((r) => JSON.stringify(r)).sort()

/* 觀測到的 reason 字面值（C500 用）。 */
const OBSERVED_REASONS = []
const noteReason = (res) => {
  if (res && typeof res.reason === 'string' && res.reason !== '') OBSERVED_REASONS.push(res.reason)
  return res
}

/* ===========================================================================
   ① 同一 source_seal_id 重複採納 ⇒ 既有 xiai_seals 行不改寫（冪等）
   =========================================================================== */
{
  pushImports([
    importRow({ batchId: 'B1', sourceSealId: 'S1', faces: [faceOf(VALID_SHA)] }),
    importRow({ batchId: 'B1', sourceSealId: 'S1', faces: [faceOf(VALID_SHA)] })
  ])
  const beforeSeals = snapSeals().length
  const first = await seals.reviewSealImport(ADMIN, { batchId: 'B1', decision: 'ACCEPTED' })
  const seal1 = db.sealBySourceKey('SRC', 'S1')
  const sealSnapshot1 = JSON.stringify(seal1)
  const sealsAfterFirst = snapSeals().length
  check('1a', '同鍵雙行同批採納：恰新增 1 枚正式印章（第二行冪等命中、不新增）', 1, sealsAfterFirst - beforeSeals)
  check('1b', '採納成功：accepted_ids 含雙行', ['si-test-1', 'si-test-2'], first.accepted_ids.slice().sort())

  /* 重放：把兩行狀態重置回 PENDING（模擬「導入行狀態未推進」的重放場景）⇒ 再採納。 */
  db.saveSealImportRows(db.listSealImportRows().map((row) =>
    ['si-test-1', 'si-test-2'].includes(text(row.id)) ? { ...row, status: 'PENDING' } : row
  ))
  const replay = await seals.reviewSealImport(ADMIN, { batchId: 'B1', decision: 'ACCEPTED' })
  const sealSnapshot2 = JSON.stringify(db.sealBySourceKey('SRC', 'S1'))
  check('1c', '重複採納後既有 xiai_seals 行前後快照逐字不變', sealSnapshot1, sealSnapshot2)
  check('1d', '重複採納未新增第二枚印章', 1, snapSeals().length - beforeSeals)
  check('1e', '重放仍報採納成功（可重放且冪等）', true, replay.accepted === true && replay.accepted_ids.length === 2)
}

/* ===========================================================================
   ② 駁回 ⇒ 零寫入（僅導入行狀態）
   =========================================================================== */
{
  pushImports([importRow({ batchId: 'B2', sourceSealId: 'S2', faces: [faceOf(VALID_SHA)] })])
  const sealsBefore = snapSeals()
  const facesBefore = snapFaces()
  const res = await seals.reviewSealImport(ADMIN, { batchId: 'B2', decision: 'REJECTED', note: '資料不足' })
  const row = db.listSealImportRows().find((r) => text(r.batch_id) === 'B2')
  check('2a', '駁回：accepted=false / rejected_ids 含該行', { accepted: false, rejected: ['si-test-3'] }, { accepted: res.accepted, rejected: res.rejected_ids })
  check('2b', '駁回 ⇒ seals 零寫入（前後快照逐字相同）', sealsBefore, snapSeals())
  check('2c', '駁回 ⇒ faces 零寫入（前後快照逐字相同）', facesBefore, snapFaces())
  check('2d', '駁回 ⇒ 導入行 status=REJECTED（單向）', 'REJECTED', text(row && row.status))
}

/* ===========================================================================
   ③ 直寫（含管理員直寫）⇒ FORBIDDEN ＋ 零寫入
   =========================================================================== */
{
  const importsBefore = db.listSealImportRows().length
  const d1 = db.sealImportDirectWriteDenial('seal-imports')
  const d2 = seals.sealImportSingleWriterDenial('seal-imports')
  const d3 = db.sealImportDirectWriteDenial('seals') // 非單寫者鍵 ⇒ 放行 null
  noteReason(d1)
  noteReason(d2)
  check('3a', '數據層直寫門（seal-imports）⇒ FORBIDDEN', { ok: false, reason: 'FORBIDDEN' }, { ok: d1 && d1.ok, reason: d1 && d1.reason })
  check('3b', '服務層直寫門轉發（seal-imports）⇒ FORBIDDEN', { ok: false, reason: 'FORBIDDEN' }, { ok: d2 && d2.ok, reason: d2 && d2.reason })
  check('3c', '門面收窄：非單寫者鍵（seals）⇒ 放行 null', null, d3)
  check('3d', '直寫被拒 ⇒ 零寫入（導入行數不變）', importsBefore, db.listSealImportRows().length)
}

/* ===========================================================================
   ④ 缺 env（白名單未配置）⇒ 安全拒 ＋ 零寫入 ／ 非白名單 ⇒ FORBIDDEN ＋ 零寫入（AC-497）
   =========================================================================== */
{
  const tokenIdentity = { uid: 'u-token', phone: '13800000000' } // 無 identity_source ⇒ 令牌路
  const res = await userOps.ADMIN_OPS.reviewSealImport(
    { batch_id: 'B-nope', decision: 'ACCEPTED' },
    tokenIdentity,
    { adminPhone: '', nowSeconds: 1700000000 }
  )
  noteReason(res)
  check('4a', '缺 env（adminPhone 空）⇒ 安全拒（STORAGE_UNAVAILABLE）', { ok: false, reason: 'STORAGE_UNAVAILABLE' }, { ok: res.ok, reason: res.reason })
  check('4b', '缺 env ⇒ 零寫入（無 plan / 無 writes）', undefined, res.plan)
  /* 正對照：非白名單手機號 ⇒ FORBIDDEN ＋ 零寫入。 */
  const res2 = await userOps.ADMIN_OPS.reviewSealImport(
    { batch_id: 'B-nope', decision: 'ACCEPTED' },
    { uid: 'u-other', phone: '13900000000' },
    { adminPhone: '13800000000', nowSeconds: 1700000000 }
  )
  noteReason(res2)
  check('4c', '非白名單手機號 ⇒ FORBIDDEN ＋ 零寫入', { ok: false, reason: 'FORBIDDEN', plan: undefined }, { ok: res2.ok, reason: res2.reason, plan: res2.plan })
}

/* ===========================================================================
   ⑤（＝ IR1）影像引用缺失 ⇒ 該條拒絕 ＋ 零寫入（宣告了引用但解析不到）
   =========================================================================== */
{
  pushImports([importRow({ batchId: 'B5', sourceSealId: 'S5', faces: [faceOf(DANGLING_SHA)] })])
  const sealsBefore = snapSeals()
  const facesBefore = snapFaces()
  const res = await seals.reviewSealImport(ADMIN, { batchId: 'B5', decision: 'ACCEPTED' })
  res.failed.forEach(noteReason)
  const row = db.listSealImportRows().find((r) => text(r.batch_id) === 'B5')
  check('5a', 'IR1 影像引用缺失（宣告了引用、解析不到）⇒ 該條計入 failed / 不計入 accepted', { accepted_ids: [], failedIds: ['si-test-4'] }, { accepted_ids: res.accepted_ids, failedIds: res.failed.map((f) => f.id) })
  check('5b', 'IR1 影像引用缺失 ⇒ seals 零寫入', sealsBefore, snapSeals())
  check('5c', 'IR1 影像引用缺失 ⇒ faces 零寫入', facesBefore, snapFaces())
  check('5d', 'IR1 影像引用缺失 ⇒ 導入行保持 PENDING（零寫入）', 'PENDING', text(row && row.status))
}

/* ===========================================================================
   ⑥ 部分失敗逐條獨立 ⇒ 成功行已落、失敗行仍 PENDING
   =========================================================================== */
{
  pushImports([
    importRow({ batchId: 'B6', sourceSealId: 'S6-OK', faces: [faceOf(VALID_SHA)] }),
    importRow({ batchId: 'B6', sourceSealId: 'S6-BAD', faces: [faceOf(DANGLING_SHA)] })
  ])
  const sealsBefore = snapSeals().length
  const facesBefore = snapFaces().length
  const res = await seals.reviewSealImport(ADMIN, { batchId: 'B6', decision: 'ACCEPTED' })
  res.failed.forEach(noteReason)
  const rows = db.listSealImportRows().filter((r) => text(r.batch_id) === 'B6')
  const okRow = rows.find((r) => text(r.source_seal_id) === 'S6-OK')
  const badRow = rows.find((r) => text(r.source_seal_id) === 'S6-BAD')
  check('6a', '部分失敗：恰 1 成功 / 1 失敗（不整批崩）', { accepted: 1, failed: 1 }, { accepted: res.accepted_ids.length, failed: res.failed.length })
  check('6b', '成功行已落正式印章（seals +1）', 1, snapSeals().length - sealsBefore)
  check('6c', '成功行已落印面（faces +1）', 1, snapFaces().length - facesBefore)
  check('6d', '成功行 status=ACCEPTED；失敗行 status=PENDING（零寫入）', { ok: 'ACCEPTED', bad: 'PENDING' }, { ok: text(okRow && okRow.status), bad: text(badRow && badRow.status) })
}

/* ===========================================================================
   ⑦ 採納後 review_status='APPROVED' 且狀態雙字段同時推進（AC-499）
   =========================================================================== */
{
  const seal7 = db.sealBySourceKey('SRC', 'S1')
  const row7 = db.listSealImportRows().find((r) => text(r.source_seal_id) === 'S1')
  check('7a', '正式行 review_status=APPROVED', 'APPROVED', text(seal7 && seal7.review_status))
  check('7b', '導入行 status=ACCEPTED（兩字段分列、同時推進）', 'ACCEPTED', text(row7 && row7.status))
  check('7c', '兩字段未被互相替代（值分屬不同鍵）', { importsStatus: 'ACCEPTED', sealsReview: 'APPROVED' }, { importsStatus: text(row7 && row7.status), sealsReview: text(seal7 && seal7.review_status) })
  /* 邊款 kind=EDGE 落印面（kind=EDGE 須在列） */
  const faces7 = db.listFaceRows().filter((r) => text(r.sealId || r.stamp_id) === text(seal7 && seal7.stamp_id))
  check('7d', '採納整條落印面（含 kind 逐字保留）', [FACE], faces7.map((r) => text(r.kind)))
}

/* ===========================================================================
   ⑧ 存量舊行 review_status 逐字節不變（不遷移）
   =========================================================================== */
{
  const after = {}
  db.listSealRows().forEach((row) => {
    const id = text(row.stamp_id || row.id)
    if (id in legacyReviewStatus) after[id] = text(row.review_status)
  })
  check('8a', '存量舊行 review_status 逐字節不變', Object.fromEntries(Object.entries(legacyReviewStatus).filter(([k]) => k in after)), after)
  check('8b', '存量 PENDING 行未遷移（仍 PENDING）', legacyPending, Object.entries(after).filter(([, v]) => v === 'PENDING').map(([k]) => k).sort())
}

/* ===========================================================================
   附：內容指紋僅作軟提示（指紋相同 ⇒ 不得拒收）＋ 非管理員讀面 FORBIDDEN
   =========================================================================== */
{
  session.setUser(ADMIN)
  const p1 = await seals.submitSealImport({ batchId: 'B7', source: 'SRC', sourceSealId: 'S7-A', payload: { seal_name: '指紋印', dynasty: '清初', seal_type: '私印' }, faces: [faceOf(VALID_SHA)] })
  const p2 = await seals.submitSealImport({ batchId: 'B7', source: 'SRC', sourceSealId: 'S7-B', payload: { seal_name: '指紋印', dynasty: '清初', seal_type: '私印' }, faces: [faceOf(VALID_SHA)] })
  check('H1', '指紋相同 ⇒ 不得拒收（第二次仍 ok:true）', { ok1: true, ok2: true }, { ok1: p1.ok, ok2: p2.ok })
  check('H2', '指紋相同 ⇒ 隨體附疑似重複軟提示（不阻塞）', true, p2.suspect_duplicate === true && text(p2.duplicate_of) !== '')
  /* 同鍵重複提交 ⇒ 冪等返回、不改寫既有行。 */
  const p3 = await seals.submitSealImport({ batchId: 'B7', source: 'SRC', sourceSealId: 'S7-A', payload: { seal_name: '改過的印' }, faces: [faceOf(VALID_SHA)] })
  check('H3', '同鍵重複提交 ⇒ 冪等未改寫（原樣返回既有行）', { idempotent: true, sameId: true, name: '指紋印' }, { idempotent: p3.idempotent, sameId: text(p3.row && p3.row.id) === text(p1.row && p1.row.id), name: text(p3.row && p3.row.seal_name) })
  /* 非管理員讀面 ⇒ FORBIDDEN。 */
  const nonAdmin = noteReason(seals.listPendingSealImportsForAdmin({ id: 'u-user', role: 'user' }))
  check('H4', '非管理員讀待審面 ⇒ FORBIDDEN（不以空集冒充）', { ok: false, reason: 'FORBIDDEN' }, { ok: nonAdmin.ok, reason: nonAdmin.reason })
}

/* ===========================================================================
   IR2 / IR3（本單新增）：影像引用語義 —— kind=FACE 無引用 ⇒ 拒；kind=EDGE 無引用 ⇒ 放行
   =========================================================================== */
{
  /* IR2：kind=FACE 無任何引用 ⇒ 該條拒 ＋ 零寫入。 */
  pushImports([importRow({ batchId: 'B-IR2', sourceSealId: 'S-IR2', faces: [faceOf('', FACE)] })])
  const sealsBefore2 = snapSeals()
  const facesBefore2 = snapFaces()
  const res2 = await seals.reviewSealImport(ADMIN, { batchId: 'B-IR2', decision: 'ACCEPTED' })
  res2.failed.forEach(noteReason)
  const row2 = db.listSealImportRows().find((r) => text(r.batch_id) === 'B-IR2')
  check('IR2a', 'IR2 kind=FACE 無任何影像引用 ⇒ 該條拒（計入 failed、不計入 accepted）', { accepted: [], failed: 1 }, { accepted: res2.accepted_ids, failed: res2.failed.length })
  check('IR2b', 'IR2 ⇒ seals 零寫入（前後快照逐字相同）', sealsBefore2, snapSeals())
  check('IR2c', 'IR2 ⇒ faces 零寫入（前後快照逐字相同）', facesBefore2, snapFaces())
  check('IR2d', 'IR2 ⇒ 導入行保持 PENDING（零寫入）', 'PENDING', text(row2 && row2.status))

  /* IR3：kind=EDGE 無引用 ⇒ 放行（沿 canonical：邊款圖可選）。 */
  pushImports([importRow({ batchId: 'B-IR3', sourceSealId: 'S-IR3', faces: [faceOf('', EDGE)] })])
  const sealsBefore3 = snapSeals().length
  const facesBefore3 = snapFaces().length
  const res3 = await seals.reviewSealImport(ADMIN, { batchId: 'B-IR3', decision: 'ACCEPTED' })
  res3.failed.forEach(noteReason)
  const edgeRow = db.listSealImportRows().find((r) => text(r.batch_id) === 'B-IR3')
  const seal3 = db.sealBySourceKey('SRC', 'S-IR3')
  const edgeFaces = db.listFaceRows().filter((r) => text(r.sealId || r.stamp_id) === text(seal3 && seal3.stamp_id))
  check('IR3a', 'IR3 kind=EDGE 無引用 ⇒ 放行（該條計入 accepted）', ['si-test-8'], res3.accepted_ids)
  check('IR3b', 'IR3 ⇒ seals +1 / faces +1（整條落）', { seals: 1, faces: 1 }, { seals: snapSeals().length - sealsBefore3, faces: snapFaces().length - facesBefore3 })
  check('IR3c', 'IR3 ⇒ 導入行 status=ACCEPTED', 'ACCEPTED', text(edgeRow && edgeRow.status))
  check('IR3d', 'IR3 ⇒ 邊款印面 kind=EDGE 落印面（無引用 ⇒ edge_image_ids 為空、不落半條）', { kinds: [EDGE], edgeIds: [[]] }, { kinds: edgeFaces.map((r) => text(r.kind)), edgeIds: edgeFaces.map((r) => (r.edge_image_ids || []).slice()) })
}

/* ===========================================================================
   AC-493（集合名與單一真源）：逐字集合名 ＋ `xiai_` 前綴 ＋ 恰一承載 ＋ 正式落點仍既有
   =========================================================================== */
{
  const opsSrc = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'), 'utf8')
  const regStart = opsSrc.indexOf('const COLLECTIONS')
  const reg = opsSrc.slice(regStart, opsSrc.indexOf('})', regStart))
  const names = [...reg.matchAll(/:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1])
  check('C493a', '集合名逐字 ＝ `xiai_seal_imports`（新增恰一集合）', 'xiai_seal_imports', seed.XIAI_SEAL_IMPORTS_COLLECTION)
  check('C493b', '恰一承載「印章批量導入」的集合名（無第二承載集合）', ['xiai_seal_imports'], names.filter((n) => /seal.?import/i.test(n)))
  check('C493c', '集合名一律 `xiai_` 前綴（`COLLECTIONS` 登記表逐值）', [], names.filter((n) => n.indexOf('xiai_') !== 0))
  check('C493d', '本機鏡像鍵 ＝ `seal-imports`（`storage.STORAGE_KEYS.sealImports`）', 'seal-imports', storage.STORAGE_KEYS.sealImports)
  check('C493e', '正式落點仍為既有 `xiai_seals` / `xiai_faces`（不另立正式集合）', ['xiai_faces', 'xiai_seals'], ['xiai_seals', 'xiai_faces'].filter((n) => names.indexOf(n) !== -1).sort())
  /* 負對照（本單新增）：注入非 `xiai_` 前綴集合名 ⇒ 前綴尺必紅（證明非恆綠）。 */
  const injectedNames = [...names, 'xl_seal_imports']
  check('C493x', '負對照：注入非 `xiai_` 前綴集合名 ⇒ 前綴尺必報紅', ['xl_seal_imports'], injectedNames.filter((n) => n.indexOf('xiai_') !== 0))
}

/* ===========================================================================
   AC-494（導入行字段面與權限）：faces[] 1..N 含邊款 / 影像引用為鍵・摘要（非二進制）/ imported_by 為 uid（零手機號）
   =========================================================================== */
{
  check('C494a', '印面字段面含 `kind`，`kind=EDGE` 未被排除（normalizeSealImportFace 保留 EDGE）', { hasKind: true, edge: EDGE, faceDefault: FACE }, { hasKind: seed.SEAL_IMPORT_FACE_FIELDS.includes('kind'), edge: seals.normalizeSealImportFace({ kind: EDGE }).kind, faceDefault: seals.normalizeSealImportFace({}).kind })
  check('C494b', '影像引用為（鍵 / 摘要）二元組 —— 導入行只存引用', ['image_storage_key', 'image_sha256', 'image_bytes', 'image_mime'], seed.SEAL_IMPORT_IMAGE_REF_FIELDS)
  check('C494c', '導入行字段面無二進制字段（無 blob / binary / file / raw / data 類二進制鍵）', [], seed.SEAL_IMPORT_FIELDS.filter((k) => /^(blob|binary|file|raw|data)$/i.test(k)))
  /* imported_by 為不透明 uid（零手機號）：現取一枚新提交行。 */
  const probe = await seals.submitSealImport({ batchId: 'B-C494', source: 'SRC', sourceSealId: 'S-C494', payload: { seal_name: '探針印' }, faces: [faceOf(VALID_SHA)] })
  check('C494d', '導入行 `imported_by` 為不透明 uid（零手機號）', { imported_by: 'u-admin', hasPhone: false }, { imported_by: text(probe.row && probe.row.imported_by), hasPhone: /\b1[3-9]\d{9}\b/.test(JSON.stringify(probe.row)) })
  check('C494e', '導入行 `faces[]` 至少 1 條（1..N）', true, Array.isArray(probe.row && probe.row.faces) && probe.row.faces.length >= 1)
}

/* ===========================================================================
   AC-495 / AC-496（逐條獨立 ＋ 冪等鍵）：三態單向（終態不回退）／冪等鍵 ＝ source ＋ source_seal_id
   =========================================================================== */
{
  /* 三態單向：已 REJECTED 行重放採納 ⇒ 跳過且不回退（終態不回退）。 */
  const replay = await seals.reviewSealImport(ADMIN, { batchId: 'B2', decision: 'ACCEPTED' })
  const rowB2 = db.listSealImportRows().find((r) => text(r.batch_id) === 'B2')
  check('C495a', '三態單向 / 終態不回退：已 REJECTED 行重放採納 ⇒ 跳過、狀態仍 REJECTED', { skipped: true, status: 'REJECTED' }, { skipped: replay.skipped.length > 0, status: text(rowB2 && rowB2.status) })
  /* 冪等鍵 ＝ source ＋ source_seal_id。 */
  check('C496a', '冪等鍵 ＝ `source` ＋ `source_seal_id`（命中既有導入行）', true, !!db.sealImportBySourceKey('SRC', 'S1'))
  check('C496b', '未知冪等鍵 ⇒ 未命中（不誤命中）', null, db.sealImportBySourceKey('SRC', 'NO-SUCH-KEY'))
  const acceptedSeal = db.sealBySourceKey('SRC', 'S1')
  check('C496c', '正式行可溯冪等鍵（`source` ＋ `source_seal_id` 落正式行）', { source: 'SRC', source_seal_id: 'S1' }, { source: text(acceptedSeal && acceptedSeal.source), source_seal_id: text(acceptedSeal && acceptedSeal.source_seal_id) })
}

/* ===========================================================================
   AC-499（雙字段不混用 ＋ 存量不遷移）：兩字段分屬不同鍵、值分屬不同域
   =========================================================================== */
{
  const s1Seal = db.sealBySourceKey('SRC', 'S1')
  const s1Imp = db.listSealImportRows().find((r) => text(r.source_seal_id) === 'S1')
  check('C499a', '雙字段不同鍵、同時推進（導入行 `status` ≠ 正式行 `review_status`）', true, ('status' in s1Imp) && ('review_status' in s1Seal) && s1Imp.status === 'ACCEPTED' && s1Seal.review_status === 'APPROVED')
  check('C499b', '導入行三態域與正式行 `review_status` 值域分列（不互相替代）', { imports: 'ACCEPTED', seals: 'APPROVED' }, { imports: text(s1Imp && s1Imp.status), seals: text(s1Seal && s1Seal.review_status) })
}

/* ===========================================================================
   AC-500（集合清單現態 ＋ 回歸面）：`reason` 零新增（并附負對照）
   =========================================================================== */
{
  /* 追加一批可機械觸發的否定回包，補齊 reason 觀測面。 */
  noteReason(await seals.submitSealImport({ batchId: 'B-R', source: 'SRC', sourceSealId: '', faces: [faceOf(VALID_SHA)] }))
  noteReason(await seals.submitSealImport({ batchId: 'B-R', source: 'SRC', sourceSealId: 'S-R', faces: [] }))
  noteReason(await seals.reviewSealImport(ADMIN, { batchId: 'B1', decision: 'MAYBE' }))
  noteReason(await seals.reviewSealImport(ADMIN, { decision: 'ACCEPTED' }))
  noteReason(await seals.reviewSealImport({ id: 'u-user', role: 'user' }, { batchId: 'B1', decision: 'ACCEPTED' }))

  const FROZEN_REASONS = ['FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE', 'NOT_FOUND']
  const outside = (arr) => [...new Set(arr)].filter((r) => FROZEN_REASONS.indexOf(r) === -1)
  console.log(JSON.stringify({ observed_reasons: [...new Set(OBSERVED_REASONS)].sort() }))
  check('C500a', '印章導入通道觀測到的 `reason` 字面值全部 ∈ 既有凍結表（零新增）', [], outside(OBSERVED_REASONS))
  /* 負對照（本單新增）：注入新 `reason` 字面值 ⇒ 尺必紅（證明非恆綠）。 */
  check('C500x', '負對照：注入新 `reason` 字面值 ⇒ 零新增尺必報紅', ['TOTALLY_NEW_REASON'], outside([...OBSERVED_REASONS, 'TOTALLY_NEW_REASON']))
}

/* ===========================================================================
   E 段（本單新增）：印章導入通道**鍵面擴面**（E-1 印章級 51 鍵 / E-2 印面新鍵 / E-3 採納整條落）
   ---------------------------------------------------------------------------
   ① 51 鍵**逐字**在允許面（本段自持一份**獨立尺子** `SOURCE_51`，與 seed / 雲函數副本三方對拍）；
   ② 字符串 `""` 與數字 `0` ⇒ 拒（`INVALID_VALUE` ＋ **零寫入**）；
   ③ `audit_status` **四值**（`'0'` / `'1'` / `'2'` / `'9'` —— 源包實讀分布）均放行、**原樣收**；
   ④ 印面新鍵 `image_source_kind` 存在、**值域不封閉**（非白名單值亦放行）；
   ⑤ 既有 8 鍵仍可用（兩來源並存、互不覆蓋）；
   ＋ 採納：源側 51 鍵整條落 `xiai_seals`（`null` / 整數原樣）、`raw_json` 只落導入行。
   =========================================================================== */
{
  /* **獨立尺子**（逐字；本段自持，不從 seed 生成 —— 避免「用自己的尺量自己」）。 */
  const SOURCE_51 = [
    'source_seal_id', 'seal_uri', 'category', 'seal_wen', 'seal_wen_chs', 'seal_wen_pinyin',
    'seal_wen_wzly', 'seal_wen_wzly_chs', 'seal_wen_yssw', 'seal_wen_yssw_chs', 'seal_wen_wyz',
    'seal_wen_zjsw', 'seal_wen_zjsw_chs', 'seal_ys_xz', 'seal_ys_label', 'seal_ys_kf',
    'seal_ys_st', 'seal_zyz', 'seal_yz', 'seal_yz_person_name', 'seal_yz_person_name_chs',
    'seal_yz_name', 'seal_yz_ref_id', 'seal_yzzkz', 'seal_yzzkz_chs', 'seal_yzzkz_id',
    'seal_bk', 'seal_bk_chs', 'seal_bkzkz', 'seal_bkzkz_chs', 'seal_bkzkz_id', 'as_book_id',
    'related_book', 'seal_yt_url', 'seal_ytsw_url', 'seal_yzbk_url', 'seal_yzqt_url',
    'seal_threed_url', 'seal_title', 'seal_title_chs', 'seal_org', 'seal_org_name', 'seal_cz',
    'seal_cc', 'seal_ly', 'seal_yn', 'seal_yksj_lsjn', 'seal_yksj_lsjn_chs', 'seal_yksj_gyjn',
    'audit_status', 'misc'
  ]
  const EXISTING_8 = ['seal_name', 'dynasty', 'seal_type', 'seal_style', 'material', 'shape', 'author', 'transcription']
  const T = (id, desc, expected, actual) => check(id, desc, expected, actual)
  /** 源側擴面（51 鍵；缺值 ⇒ `null`、`source_seal_id` ⇒ 文本）—— 本段造行用。 */
  const srcFaceOf = (sourceSealId, overrides = {}) => ({
    ...seed.emptySealImportSourceFields(),
    ...overrides,
    source_seal_id: sourceSealId
  })

  /* ⑤-a 存量面快照（本段全程不得改动既有印章 / 印面行）。 */
  const legacySealsSnap = snapSeals()
  const legacyFacesSnap = snapFaces()
  const legacyImportsCount = db.listSealImportRows().length

  /* ① 51 鍵逐字 / 三方對拍 / 恰 51 / 允許面覆蓋。 */
  T('E1a', 'E-1 源側擴面恰 51 鍵（逐字、有序；seed 真源）', SOURCE_51, seed.SEAL_IMPORT_SOURCE_FIELDS)
  T('E1b', 'E-1 雲函數副本與 seed 真源**逐字相等**（同一把尺子）', SOURCE_51, userOps.SEAL_IMPORT_SOURCE_FIELDS)
  T('E1c', 'E-1 恰 51 鍵（非範圍、非子集、不比大小）', 51, seed.SEAL_IMPORT_SOURCE_FIELDS.length)
  T('E1d', 'E-1 51 鍵全數 ∈ 允許鍵面（雲函數 `SEAL_IMPORT_ALLOWED_KEYS`）', [],
    SOURCE_51.filter((k) => userOps.SEAL_IMPORT_ALLOWED_KEYS.indexOf(k) === -1))
  T('E1e', 'E-1 51 鍵全數 ∈ 導入行字段全集（seed `SEAL_IMPORT_FIELDS`）', [],
    SOURCE_51.filter((k) => seed.SEAL_IMPORT_FIELDS.indexOf(k) === -1))
  T('E1f', 'E-1 允許鍵面恰 63 鍵（batch_id / source / raw_json ＋ 既有 8 ＋ 源側 51 ＋ faces）', 63,
    userOps.SEAL_IMPORT_ALLOWED_KEYS.length)
  T('E1g', 'E-1 印章級鍵面恰 59 鍵（既有 8 ＋ 源側 51；無重複）', { len: 59, dup: [] },
    { len: seed.SEAL_IMPORT_SEAL_LEVEL_FIELDS.length, dup: seed.SEAL_IMPORT_SEAL_LEVEL_FIELDS.filter((k, i, a) => a.indexOf(k) !== i) })
  T('E1h', 'E-1 指紋面恰 58 鍵（印章級鍵面減行級冪等鍵 `source_seal_id`）', 58, seed.SEAL_IMPORT_FINGERPRINT_FIELDS.length)
  T('E1i', 'E-1 `raw_json` **只落導入行**（在行級面、不在印章級鍵面 / 正式面）', { inRow: true, inSealLevel: false },
    { inRow: seed.SEAL_IMPORT_ROW_FIELDS.includes('raw_json'), inSealLevel: seed.SEAL_IMPORT_SEAL_LEVEL_FIELDS.includes('raw_json') })
  T('E1j', 'E-1 未為新面造值域門（`SEAL_IMPORT_SOURCE_FIELDS` 只 1 個整數鍵、`seal_ys_label` 不在任何既有域常量裡）', { ints: 1, inStyle: false },
    { ints: seed.SEAL_IMPORT_SOURCE_INT_FIELDS.length, inStyle: seed.SEAL_TYPE_OPTIONS.includes('seal_ys_label') })
  T('E1k', 'E-1 既有 8 鍵逐字保留（兩來源並存的面）', EXISTING_8, seed.SEAL_IMPORT_SEAL_FIELDS)

  /* ② 形態門：空串 / 數字 0 ⇒ 拒 ＋ 零寫入；正對照 ⇒ 放行。 */
  const mkFaces = () => [faceOf(VALID_SHA, FACE, { image_source_kind: 'yt' })]
  const submitsBefore = db.listSealImportRows().length
  const badEmpty = noteReason(await seals.submitSealImport({ batchId: 'B-E1', source: 'SRC', sourceSealId: 'E-EMPTY', payload: { seal_wen: '' }, faces: mkFaces() }))
  const badZero = noteReason(await seals.submitSealImport({ batchId: 'B-E1', source: 'SRC', sourceSealId: 'E-ZERO', payload: { seal_ys_xz: 0 }, faces: mkFaces() }))
  const badMisc = noteReason(await seals.submitSealImport({ batchId: 'B-E1', source: 'SRC', sourceSealId: 'E-MISC', payload: { misc: 'not-an-object' }, faces: mkFaces() }))
  const badBool = noteReason(await seals.submitSealImport({ batchId: 'B-E1', source: 'SRC', sourceSealId: 'E-BOOL', payload: { seal_wen: true }, faces: mkFaces() }))
  T('E2a', 'E-2 空串（`seal_wen=""`）⇒ `INVALID_VALUE` ＋ 零寫入', { ok: false, reason: 'INVALID_VALUE' }, { ok: badEmpty.ok, reason: badEmpty.reason })
  T('E2b', 'E-2 數字 `0`（`seal_ys_xz=0`）⇒ `INVALID_VALUE` ＋ 零寫入', { ok: false, reason: 'INVALID_VALUE' }, { ok: badZero.ok, reason: badZero.reason })
  T('E2c', 'E-2 `misc` 非對象（字符串）⇒ `INVALID_VALUE` ＋ 零寫入', { ok: false, reason: 'INVALID_VALUE' }, { ok: badMisc.ok, reason: badMisc.reason })
  T('E2d', 'E-2 布爾值（`seal_wen=true`）⇒ `INVALID_VALUE` ＋ 零寫入', { ok: false, reason: 'INVALID_VALUE' }, { ok: badBool.ok, reason: badBool.reason })
  T('E2e', 'E-2 四條違形態提交 ⇒ **零寫入**（導入行數不變）', submitsBefore, db.listSealImportRows().length)
  T('E2f', 'E-2 明確給 `null` ⇒ 放行（源側無值用 `null`、不強轉空串）', true,
    (await seals.submitSealImport({ batchId: 'B-E1', source: 'SRC', sourceSealId: 'E-NULL', payload: { seal_wen: null, misc: null, seal_ys_xz: null }, faces: mkFaces() })).ok === true)
  /* 雲函數側同一把門（同一違規在 ops 側亦拒 ＋ 零寫入）。 */
  const cloudBad = noteReason(await userOps.OPS.submitSealImport(
    { source_seal_id: 'E-CLOUD-BAD', source: 'SRC', seal_wen: '', faces: [{ kind: 'FACE', image_sha256: VALID_SHA }] },
    { uid: 'u-token', phone: '13800000000' }
  ))
  T('E2g', 'E-2 雲函數側同一形態門（空串 ⇒ `INVALID_VALUE` ＋ 無落盤計劃）', { ok: false, reason: 'INVALID_VALUE', plan: undefined },
    { ok: cloudBad.ok, reason: cloudBad.reason, plan: cloudBad.plan })

  /* ③ `audit_status` 四值（源包實讀 `'0'` / `'1'` / `'2'` / `'9'`）均放行、原樣收。 */
  const AUDIT_4 = ['0', '1', '2', '9']
  const auditResults = []
  for (const value of AUDIT_4) {
    const res = await seals.submitSealImport({ batchId: 'B-E3', source: 'SRC', sourceSealId: `E-AUDIT-${value}`, payload: { audit_status: value }, faces: mkFaces() })
    auditResults.push({ value, ok: res.ok === true, stored: text(res.row && res.row.audit_status) })
  }
  T('E3a', 'E-3 `audit_status` 四值（`0`/`1`/`2`/`9`）**均放行**', [{ value: '0', ok: true }, { value: '1', ok: true }, { value: '2', ok: true }, { value: '9', ok: true }],
    auditResults.map((r) => ({ value: r.value, ok: r.ok })))
  T('E3b', 'E-3 `audit_status` **原樣收**（逐字落行、不得歸一 / 不得過濾）', AUDIT_4, auditResults.map((r) => r.stored))
  T('E3c', 'E-3 `audit_status` 數字形態亦放行（原樣收：字符串或數字均可）', { ok: true, stored: 2 },
    await seals.submitSealImport({ batchId: 'B-E3', source: 'SRC', sourceSealId: 'E-AUDIT-NUM', payload: { audit_status: 2 }, faces: mkFaces() })
      .then((res) => ({ ok: res.ok === true, stored: res.row && res.row.audit_status })))
  T('E3d', 'E-3 `audit_status` **不得據以過濾**（四值行全部真落行、非 PENDING 過濾掉）', 5,
    db.listSealImportRows().filter((r) => text(r.source_seal_id).indexOf('E-AUDIT') === 0).length)

  /* ④ 印面新鍵 `image_source_kind`：存在、值域不封閉。 */
  const FACE_14 = ['kind', 'seal_name', 'dynasty', 'seal_type', 'face_style', 'seal_class', 'author', 'author_person_id', 'transcription', 'image_storage_key', 'image_sha256', 'image_bytes', 'image_mime', 'image_source_kind']
  T('E4a', 'E-2 印面字段面 ＝ 既有 13 鍵 ＋ `image_source_kind`（恰 14 鍵、逐字）', FACE_14, seed.SEAL_IMPORT_FACE_FIELDS)
  T('E4b', 'E-2 既有 13 鍵一字未改（前 13 位逐字）', FACE_14.slice(0, 13), seed.SEAL_IMPORT_FACE_FIELDS.slice(0, 13))
  const faceKinds = ['yt', 'ytsw', 'yzbk', 'NOT-IN-ANY-LIST']
  T('E4c', 'E-2 值域**不封閉**（枚舉外值原樣放行；`normalizeSealImportFace` 不裁剪）', faceKinds,
    faceKinds.map((k) => seals.normalizeSealImportFace({ kind: FACE, image_source_kind: k }).image_source_kind))
  T('E4d', 'E-2 未為該鍵造值域常量（seed / 雲函數副本皆無 `IMAGE_SOURCE_*` 枚舉）', { seed: [], ops: [] },
    { seed: Object.keys(seed).filter((k) => /IMAGE_SOURCE/.test(k)), ops: Object.keys(userOps).filter((k) => /IMAGE_SOURCE/.test(k)) })
  T('E4e', 'E-2 影面鍵原樣落印面（採納後 `xiai_faces` 行帶 `yt`）', 'yt',
    (await seals.submitSealImport({ batchId: 'B-E4', source: 'SRC', sourceSealId: 'E-ISK', payload: {}, faces: [faceOf(VALID_SHA, FACE, { image_source_kind: 'yt' })] })).row.faces[0].image_source_kind)

  /* ⑤ 既有 8 鍵仍可用（未被新面取代 / 不互作回落）。 */
  const legacySubmit = await seals.submitSealImport({ batchId: 'B-E5', source: 'SRC', sourceSealId: 'E-LEGACY8', payload: { seal_name: '併存印', dynasty: '清初', seal_type: '私印', seal_style: '白文', material: '石', shape: '方形', author: '丁敬', transcription: '併存釋義' }, faces: mkFaces() })
  T('E5a', 'E-5 既有 8 鍵仍可用（提交放行）', true, legacySubmit.ok === true)
  T('E5b', 'E-5 既有 8 鍵逐字落行（8 鍵面原樣保留）', { seal_name: '併存印', dynasty: '清初', seal_type: '私印', seal_style: '白文', material: '石', shape: '方形', author: '丁敬', transcription: '併存釋義' },
    (({ seal_name, dynasty, seal_type, seal_style, material, shape, author, transcription }) => ({ seal_name, dynasty, seal_type, seal_style, material, shape, author, transcription }))(legacySubmit.row))
  T('E5c', 'E-5 兩來源**互不覆蓋**（同一行同時帶既有 8 鍵與源側擴面鍵；源側缺值 ⇒ `null` 不落空串）',
    { eight: true, sourceKey: true, nullNotBlank: true },
    { eight: seed.SEAL_IMPORT_SEAL_FIELDS.every((k) => text(legacySubmit.row[k]) !== ''), sourceKey: 'seal_wen' in legacySubmit.row, nullNotBlank: legacySubmit.row.seal_wen === null })

  /* ⑥ 採納：源側 51 鍵整條落 `xiai_seals`；`raw_json` 只留導入行；既有行零改動。 */
  const SRC_ROW_A = { seal_uri: 'a23f8f65-bf89-40c4-a128-c34967a8eb91', category: '印章', seal_wen: '委曲', seal_wen_chs: '委曲', seal_wen_yssw: '委曲', seal_ys_xz: 5, seal_ys_label: '白文長方印', seal_zyz: '1', as_book_id: '0892', related_book: '臥韜軒藏黃朗村詩品印譜', seal_yt_url: '19_1000_1', audit_status: '2', misc: { auditLogSeqid: '2532', cache: 'False' } }
  pushImports([importRow({
    batchId: 'B-E6', source: 'SRC', sourceSealId: 'E-ACC-1',
    faces: [faceOf(VALID_SHA, FACE, { image_source_kind: 'yt' })]
  })])
  const rowE6 = db.listSealImportRows().find((r) => text(r.source_seal_id) === 'E-ACC-1')
  db.saveSealImportRows(db.listSealImportRows().map((r) => (text(r.id) === text(rowE6.id) ? { ...r, ...srcFaceOf('E-ACC-1', SRC_ROW_A), raw_json: { list: { seqid: 1000 } } } : r)))
  const sealsBeforeE6 = snapSeals().length
  const acc = await seals.reviewSealImport(ADMIN, { batchId: 'B-E6', decision: 'ACCEPTED' })
  const adopted = db.sealBySourceKey('SRC', 'E-ACC-1')
  const adoptedFace = db.listFaceRows().find((r) => text(r.sealId || r.stamp_id) === text(adopted && adopted.stamp_id))
  T('E6a', 'E-3 採納 ⇒ `xiai_seals` 恰 +1 / 導入行 `ACCEPTED`', { seals: 1, status: 'ACCEPTED' }, { seals: snapSeals().length - sealsBeforeE6, status: text((db.listSealImportRows().find((r) => text(r.source_seal_id) === 'E-ACC-1') || {}).status) })
  T('E6b', 'E-3 源側 51 鍵整條落正式行（逐鍵在場）', [], SOURCE_51.filter((k) => !(k in (adopted || {}))))
  T('E6c', 'E-3 值**原樣**落正式行（字符串 / 整數 / `null` / `misc` 對象）', { wen: '委曲', xz: 5, label: '白文長方印', asBook: '0892', audit: '2', miscSeqid: '2532', bk: null },
    { wen: (adopted || {}).seal_wen, xz: (adopted || {}).seal_ys_xz, label: (adopted || {}).seal_ys_label, asBook: (adopted || {}).as_book_id, audit: (adopted || {}).audit_status, miscSeqid: ((adopted || {}).misc || {}).auditLogSeqid, bk: (adopted || {}).seal_bk })
  T('E6d', 'E-3 `raw_json` **只留導入行**（正式行無此鍵）', { importHas: true, sealHas: false },
    { importHas: 'raw_json' in (db.listSealImportRows().find((r) => text(r.source_seal_id) === 'E-ACC-1') || {}), sealHas: 'raw_json' in adopted })
  T('E6e', 'E-3 影面鍵隨採納落印面（`image_source_kind=yt`；`kind=FACE` 未變）', { isk: 'yt', kind: FACE },
    { isk: text(adoptedFace && adoptedFace.image_source_kind), kind: text(adoptedFace && adoptedFace.kind) })
  T('E6f', 'E-3 正式行 `review_status=APPROVED`（與導入行 `ACCEPTED` 同時推進）', { review: 'APPROVED', status: 'ACCEPTED' },
    { review: text((adopted || {}).review_status), status: text((db.listSealImportRows().find((r) => text(r.source_seal_id) === 'E-ACC-1') || {}).status) })
  const adoptedSnap = JSON.stringify(adopted)
  await seals.reviewSealImport(ADMIN, { batchId: 'B-E6', decision: 'ACCEPTED' })
  T('E6g', 'E-3 重複採納 ⇒ 不改寫既有正式行（冪等；逐字快照不變）', adoptedSnap, JSON.stringify(db.sealBySourceKey('SRC', 'E-ACC-1')))
  T('E6h', 'E-3 去重鍵仍為 `(source_seal_id, source)`（未改）', true, !!db.sealBySourceKey('SRC', 'E-ACC-1'))

  /* ⑤-b 既有行（本段開頭快照）逐字不變。 */
  const legacyNow = snapSeals().filter((row) => legacySealsSnap.includes(row))
  T('E7a', '既有印章行逐字不變（本段新增行除外；79 枚面不受影響）', legacySealsSnap, legacyNow)
  T('E7b', '既有印面行逐字不變（本段新增行除外）', legacyFacesSnap, snapFaces().filter((row) => legacyFacesSnap.includes(row)))
  T('E7c', '既有導入行未被本段新增改寫（前後條數與逐字快照可比）', true, db.listSealImportRows().length > legacyImportsCount)
}

/* ---------------------------------------------------------------------------
   匯總
   --------------------------------------------------------------------------- */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id)
  })
)
process.exit(failures === 0 ? 0 : 1)
