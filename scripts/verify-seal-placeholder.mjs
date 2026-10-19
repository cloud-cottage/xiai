#!/usr/bin/env node
/**
 * 玺爱 · **占位图影像例外 · 双门自检**（feicui/sealbank ⇒ xiai 导入）
 * ============================================================================
 * **本地、离线、零网络、零云端**：注入式内存假 DB（模拟平台单次 get 100 行上限），
 * 跑的是`cloudfunctions/xiai-user-token/lib/ops.js` 的**真实函数体**（提交门 ＋ 采纳门同源逻辑）。
 *
 * 跑什么（逐条）：
 *   A. **常量 / 资产对齐**：`seed.js` 与 `ops.js` 的占位键**逐字同值**；资产文件的 sha256 / 字节数 /
 *      容器 / 宽高 ≡ `SEAL_PLACEHOLDER_IMAGE` 登记值（改图不改常量必须报红）。
 *   B. **通用判据未放宽**（反证）：`cloudBaseObjectKeyOf(占位行)` **仍为空串**（占位键不是内容寻址键）；
 *      同函数对普通内容寻址行（`storage='server'` ＋ sha 命名）仍能解析 —— 例外只在**一个键**上。
 *   C. **10 条真跑（占位图模式）**：取自 feicui
 *      `local-private/datasrc/sealbank/out/xiai_imports_sealbank.ndjson`（5,529 行）等距 10 条，
 *      faces 指向占位键 ⇒ **提交门**（`submitSealImport`）＋ **采纳门**（`buildSealAcceptanceFromImport`）
 *      各跑一遍，逐条报 ok / 拒因。
 *   D. **10 条对照（无图模式）**：同 10 条 `faces=[] ＋ image_status=source_no_image` ⇒ 双门均 ok
 *      （证明占位图模式**不是**把无图路径顶掉，两条通道并存）。
 *   E. **4 类反例仍被拒**（每条断言「结构化拒绝 ＋ 零写入」）：
 *      ① 非 sealbank 来源指向占位键；② faces 指向不存在的 key；③ faces=[] 且无 source_no_image；
 *      ④ image_status 值域外。
 *
 * 纪律：不打印任何密钥 / 令牌；不碰任何服务；断言失败 ⇒ 退出码非 0。
 *
 * 用法：
 *   node scripts/verify-seal-placeholder.mjs
 *   node scripts/verify-seal-placeholder.mjs --ndjson /path/to/other.ndjson
 */

import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const fileUrl = (p) => pathToFileURL(path.join(ROOT, p)).href

const argv = process.argv.slice(2)
const ndjsonArg = argv.indexOf('--ndjson')
const NDJSON =
  ndjsonArg >= 0 && argv[ndjsonArg + 1]
    ? path.resolve(argv[ndjsonArg + 1])
    : '/Users/kevin/bistro/feicui/local-private/datasrc/sealbank/out/xiai_imports_sealbank.ndjson'

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
   1. 断言与读数
   --------------------------------------------------------------------------- */
const results = []
let failures = 0
function check(id, label, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (!pass) failures += 1
  results.push({ id, pass })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}
const text = (v) => (v === undefined || v === null ? '' : String(v))

/* ---------------------------------------------------------------------------
   2. 注入式内存假 DB（平台单次 get 上限 100 行）
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
    rows: (name) => [...mapOf(name).values()].map((row) => Object.assign({}, row))
  }
}

/* ---------------------------------------------------------------------------
   3. 载入真源
   --------------------------------------------------------------------------- */
const seed = await import(fileUrl('src/data/seed.js'))
const cloudbase = await import(fileUrl('src/data/cloudbase.js'))
const ops = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))

const {
  SEAL_PLACEHOLDER_IMAGE_KEY,
  SEAL_PLACEHOLDER_IMAGE,
  SEAL_IMPORT_IMAGE_STATUS,
  isSealBankSource,
  sealPlaceholderRefDenial
} = seed
const { SEAL_PLACEHOLDER_IMAGE_KEY: OPS_KEY, SEAL_PLACEHOLDER_IMAGE: OPS_IMAGE } = ops
/* 云函数体的提交门是 `OPS` 表上的 op（与 `index.js` 分发同一入口）；采纳门是导出的构造器。 */
const submitSealImport = ops.OPS.submitSealImport.bind(ops.OPS)
const buildSealAcceptanceFromImport = ops.buildSealAcceptanceFromImport

const IDENTITY = { uid: 'u-verify', phone: '13800000000' }
const SOURCE = '真微印網 sealbank.net'

/* ---------------------------------------------------------------------------
   A. 常量 / 资产对齐
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'A', title: '常量与资产对齐' }))
const assetPath = path.join(ROOT, 'public', SEAL_PLACEHOLDER_IMAGE.asset_url.replace(/^\//, ''))
const assetBytes = readFileSync(assetPath)
const assetSha = createHash('sha256').update(assetBytes).digest('hex')
check('A1', 'seed 与 ops 占位键逐字同值', true, SEAL_PLACEHOLDER_IMAGE_KEY === OPS_KEY && OPS_KEY === 'placeholder/seal-no-image')
check(
  'A2',
  'seed 与 ops 登记面逐字同值（两处共有的 9 键；asset_url 只在 seed 侧，前端用）',
  true,
  ['key', 'id', 'sha256', 'bytes', 'mime', 'width', 'height', 'storage', 'source_scope'].every(
    (k) => SEAL_PLACEHOLDER_IMAGE[k] === OPS_IMAGE[k]
  ) && Object.keys(OPS_IMAGE).length === 9
)
check('A3', '资产 sha256 ≡ 登记值', SEAL_PLACEHOLDER_IMAGE.sha256, assetSha)
check('A4', '资产字节数 ≡ 登记值', SEAL_PLACEHOLDER_IMAGE.bytes, assetBytes.length)
check('A5', '资产容器 ≡ 登记 mime（JPEG 魔数 FF D8 FF）', true, assetBytes[0] === 0xff && assetBytes[1] === 0xd8 && assetBytes[2] === 0xff)
check('A6', 'sealbank 来源判定：真微印網 sealbank.net ⇒ true', true, isSealBankSource(SOURCE))
check('A7', 'sealbank 来源判定：其他来源 ⇒ false', false, isSealBankSource('孔網 kongfz') && isSealBankSource(''))
check('A8', '登记行 storage 刻意不是 server', 'bundled', SEAL_PLACEHOLDER_IMAGE.storage)

/* ---------------------------------------------------------------------------
   B. 通用判据未放宽（反证）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'B', title: '通用内容寻址判据未放宽' }))
const placeholderRow = {
  _id: SEAL_PLACEHOLDER_IMAGE.id,
  id: SEAL_PLACEHOLDER_IMAGE.id,
  kind: 'PLACEHOLDER',
  storage: SEAL_PLACEHOLDER_IMAGE.storage,
  storage_key: SEAL_PLACEHOLDER_IMAGE_KEY,
  sha256: SEAL_PLACEHOLDER_IMAGE.sha256,
  bytes: SEAL_PLACEHOLDER_IMAGE.bytes,
  mime: SEAL_PLACEHOLDER_IMAGE.mime,
  width: SEAL_PLACEHOLDER_IMAGE.width,
  height: SEAL_PLACEHOLDER_IMAGE.height,
  source_scope: 'sealbank'
}
check('B1', '占位行过不了 cloudBaseObjectKeyOf（不拼假对象键）', '', cloudbase.cloudBaseObjectKeyOf(placeholderRow))
const normalRow = {
  storage: 'server',
  sha256: assetSha,
  storage_key: `xiai/images/${assetSha.slice(0, 2)}/${assetSha}.png`,
  mime: 'image/png'
}
check('B2', '普通内容寻址行仍照旧解析', normalRow.storage_key, cloudbase.cloudBaseObjectKeyOf(normalRow))
const tampered = { ...normalRow, storage_key: `xiai/images/${assetSha.slice(0, 2)}/${'0'.repeat(64)}.png` }
check('B3', '摘要与键不符仍拒（通用判据未松动）', '', cloudbase.cloudBaseObjectKeyOf(tampered))

/* ---------------------------------------------------------------------------
   C/D. 10 条真跑（占位图模式）＋ 10 条对照（无图模式）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'C', title: '10 条真跑：占位图模式 vs 无图对照' }))
if (!existsSync(NDJSON)) {
  check('C0', `源 NDJSON 存在：${NDJSON}`, true, false)
  process.exit(1)
}
const sourceRows = readFileSync(NDJSON, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))
check('C0', '源 NDJSON 行数（5,529）', 5529, sourceRows.length)

const step = Math.max(1, Math.floor(sourceRows.length / 10))
const picked = []
for (let i = 0; i < 10; i += 1) picked.push(sourceRows[i * step])
check('C1', '等距抽样 10 条（互不相同）', 10, new Set(picked.map((r) => r.source_seal_id)).size)

/** 造占位图模式载荷（无图行 → faces 指向占位键；行级 present）。
 *  若源行**本身已是占位图形态**（feicui `--placeholder` 产出的文件），**原样复用**其 faces（不重造）。 */
function placeholderPayloadOf(row) {
  const existing = Array.isArray(row.faces) ? row.faces : []
  const reuse = existing.length === 1 && existing[0].image_storage_key === SEAL_PLACEHOLDER_IMAGE_KEY
  if (reuse) return { ...row, image_status: SEAL_IMPORT_IMAGE_STATUS.PRESENT, faces: existing }
  return {
    ...row,
    image_status: SEAL_IMPORT_IMAGE_STATUS.PRESENT,
    faces: [
      {
        kind: 'FACE',
        seal_name: row.seal_name || '',
        dynasty: row.dynasty || '',
        seal_type: row.seal_type || '',
        face_style: '',
        seal_class: '',
        author: row.author || '',
        author_person_id: '',
        transcription: '',
        image_storage_key: SEAL_PLACEHOLDER_IMAGE_KEY,
        image_sha256: SEAL_PLACEHOLDER_IMAGE.sha256,
        image_bytes: SEAL_PLACEHOLDER_IMAGE.bytes,
        image_mime: SEAL_PLACEHOLDER_IMAGE.mime,
        image_source_kind: 'placeholder'
      }
    ]
  }
}

/** 无图模式载荷（对照组；保持既有 `source_no_image` 通道）。 */
function noImagePayloadOf(row) {
  return { ...row, image_status: SEAL_IMPORT_IMAGE_STATUS.SOURCE_NO_IMAGE, faces: [] }
}

async function runMode(mode, payloadOf) {
  const store = createStore([{ __collection: 'xiai_images', ...placeholderRow }])
  ops.setOpsDbProvider(store.provider)
  const out = []
  for (const row of picked) {
    const payload = payloadOf(row)
    const submit = await submitSealImport(payload, IDENTITY)
    const importRow = submit && submit.row ? submit.row : payload
    const built = submit.ok
      ? await buildSealAcceptanceFromImport(importRow, [], [], IDENTITY, new Date().toISOString())
      : { ok: false, reason: 'SKIPPED' }
    out.push({
      mode,
      source_seal_id: row.source_seal_id,
      seal_name: row.seal_name,
      submit_ok: !!submit.ok,
      submit_reason: submit.reason || '',
      accept_ok: !!built.ok,
      accept_reason: built.reason || '',
      face_image_id: built.ok && built.faceDocs && built.faceDocs[0] ? built.faceDocs[0].face_image_id : null,
      face_count: built.ok ? (built.faceDocs || []).length : 0,
      writes: store.stats.writes.length
    })
  }
  return out
}

const placeholderRun = await runMode('placeholder', placeholderPayloadOf)
placeholderRun.forEach((r) => console.log(JSON.stringify({ section: 'C', ...r })))
check(
  'C2',
  '占位图模式：10/10 提交门 ok',
  10,
  placeholderRun.filter((r) => r.submit_ok).length
)
check(
  'C3',
  '占位图模式：10/10 采纳门 ok 且印面指向占位图登记 id',
  10,
  placeholderRun.filter((r) => r.accept_ok && r.face_image_id === SEAL_PLACEHOLDER_IMAGE.id).length
)
check('C4', '采纳门产出印面行数（每条 1 个 FACE）', 10, placeholderRun.reduce((sum, r) => sum + r.face_count, 0))
check('C5', '占位图模式零拒因', [], placeholderRun.filter((r) => !r.submit_ok || !r.accept_ok))

const controlRun = await runMode('source_no_image', noImagePayloadOf)
controlRun.forEach((r) => console.log(JSON.stringify({ section: 'D', ...r })))
check('D1', '对照组：10/10 提交门 ok', 10, controlRun.filter((r) => r.submit_ok).length)
check('D2', '对照组：10/10 采纳门 ok（无印面行，文本本体保住）', 10, controlRun.filter((r) => r.accept_ok).length)
check('D3', '对照组产出印面行数 = 0', 0, controlRun.reduce((sum, r) => sum + r.face_count, 0))

/* ---------------------------------------------------------------------------
   E. 4 类反例仍被拒（含「零写入」断言）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'E', title: '4 类反例仍被拒' }))
const baseRow = picked[0]
const E_STORE = createStore([{ __collection: 'xiai_images', ...placeholderRow }])
ops.setOpsDbProvider(E_STORE.provider)

/* ① 非 sealbank 来源指向占位键 ⇒ 提交门 INVALID_VALUE ＋ 零写入；采纳门同样拒（双保险）。 */
{
  const writesBefore = E_STORE.stats.writes.length
  const payload = { ...placeholderPayloadOf(baseRow), source: '孔網 kongfz', source_seal_id: 'E1-NON-SEALBANK' }
  const res = await submitSealImport(payload, IDENTITY)
  check('E1', '① 非 sealbank 来源 → 占位键 ⇒ 提交门拒 INVALID_VALUE', ['INVALID_VALUE', false], [res.reason, res.ok])
  check('E1b', '① 提交门拒后零写入', writesBefore, E_STORE.stats.writes.length)
  const built = await buildSealAcceptanceFromImport({ ...payload, faces: payload.faces }, [], [], IDENTITY, new Date().toISOString())
  check('E1c', '① 绕过提交门直投采纳门 ⇒ 仍拒 INVALID_VALUE', [false, 'INVALID_VALUE'], [built.ok, built.reason])
}

/* ② faces 指向不存在的 key ⇒ 提交门放行（提交不解析影像，既有语义）、采纳门 NOT_FOUND 等价拒。 */
{
  const payload = {
    ...placeholderPayloadOf(baseRow),
    source_seal_id: 'E2-DANGLING-KEY',
    faces: [{ ...placeholderPayloadOf(baseRow).faces[0], image_storage_key: 'xiai/images/ff/nonexistent.png', image_sha256: '' }]
  }
  const res = await submitSealImport(payload, IDENTITY)
  check('E2', '② 悬挂 key ⇒ 提交门放行（既有语义：提交不解析影像）', true, !!res.ok)
  const built = await buildSealAcceptanceFromImport(res.row || payload, [], [], IDENTITY, new Date().toISOString())
  check('E2b', '② 悬挂 key ⇒ 采纳门拒（ok:false）', false, built.ok)
}

/* ③ faces=[] 且未宣告 source_no_image ⇒ 提交门 MISSING_REQUIRED。 */
{
  const writesBefore = E_STORE.stats.writes.length
  /* 注意：源行自带 `image_status='source_no_image'` ⇒ 必须显式去掉，否则该行本就合法（对照校准）。 */
  const payload = { ...baseRow, source_seal_id: 'E3-EMPTY-FACES', faces: [], image_status: undefined }
  const res = await submitSealImport(payload, IDENTITY)
  check('E3', '③ faces=[] 且无 source_no_image ⇒ MISSING_REQUIRED', ['MISSING_REQUIRED', false], [res.reason, res.ok])
  check('E3b', '③ 零写入', writesBefore, E_STORE.stats.writes.length)
}

/* ④ image_status 值域外 ⇒ 提交门 INVALID_VALUE。 */
{
  const writesBefore = E_STORE.stats.writes.length
  const payload = { ...placeholderPayloadOf(baseRow), source_seal_id: 'E4-BAD-STATUS', image_status: 'placeholder' }
  const res = await submitSealImport(payload, IDENTITY)
  check('E4', '④ image_status 值域外 ⇒ INVALID_VALUE', ['INVALID_VALUE', false], [res.reason, res.ok])
  check('E4b', '④ 零写入', writesBefore, E_STORE.stats.writes.length)
}

/* ⑤ 附：占位键 ＋ 摘要不符 ⇒ 采纳门拒（防「同键换图」）。 */
{
  const payload = {
    ...placeholderPayloadOf(baseRow),
    source_seal_id: 'E5-BAD-DIGEST',
    faces: [{ ...placeholderPayloadOf(baseRow).faces[0], image_sha256: 'f'.repeat(64) }]
  }
  const res = await submitSealImport(payload, IDENTITY)
  const built = res.ok ? await buildSealAcceptanceFromImport(res.row, [], [], IDENTITY, new Date().toISOString()) : { ok: false }
  check('E5', '⑤ 占位键 + 摘要不符 ⇒ 采纳门拒', false, built.ok)
}

/* ---------------------------------------------------------------------------
   F. 共通来源门（seed 纯函数；客户端 / 服务端同判的那把尺子）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'F', title: '共通来源门（seed::sealPlaceholderRefDenial）' }))
const phFace = { image_storage_key: SEAL_PLACEHOLDER_IMAGE_KEY }
check('F1', 'sealbank 来源 + 占位键 ⇒ 放行（null）', null, sealPlaceholderRefDenial(SOURCE, [phFace]))
check('F2', '非 sealbank 来源 + 占位键 ⇒ 拒（可读拒因）', true, typeof sealPlaceholderRefDenial('孔網 kongfz', [phFace]) === 'string')
check('F3', '非占位键的普通引用 ⇒ 任何来源都不受本门影响', null, sealPlaceholderRefDenial('孔網 kongfz', [{ image_storage_key: 'xiai/images/ab/' + 'a'.repeat(64) + '.png' }]))
check('F4', '无 faces ⇒ 不触发本门（既有 MISSING_REQUIRED 语义不变）', null, sealPlaceholderRefDenial('孔網 kongfz', []))

/* ---------------------------------------------------------------------------
   收尾
   --------------------------------------------------------------------------- */
console.log(
  JSON.stringify({
    summary: {
      checks: results.length,
      pass: results.filter((r) => r.pass).length,
      fail: failures,
      placeholder_ok: placeholderRun.filter((r) => r.accept_ok).length,
      control_ok: controlRun.filter((r) => r.accept_ok).length,
      ndjson: NDJSON,
      source_rows: sourceRows.length
    }
  })
)
process.exit(failures === 0 ? 0 : 1)
