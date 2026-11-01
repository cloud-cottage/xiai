/**
 * 玺爱 · **自检：AI 候選行本地鏡像**（`scripts/verify-ai-enhance-mirror.mjs`，本单新增）
 * ============================================================================ *
 * **本地、离线**（注入假云函数传输 ＋ 注入假镜像存储；零网络、零云端连接、零生产数据）。
 * 被测件：`src/services/aiEnhance.js::enhanceFaceImage` 的成功路镜像步 ＋ 注入缝
 * `setAiEnhanceMirrorStore`。
 *
 * 背景（本单根因）：服务端已建影像行（`storage=server`、`storage_key` 自洽），但**客户端本地
 * 镜像里没有这一行** ⇒ `seals.js::loadImageDataUrl` 的云端分支不成立 ⇒ 回落本地 blobstore ⇒
 * 右格报「影像二進制不在本地存儲中」。修法＝服务端成功回包带 `row`、客户端按仓内既有范式
 * （`db.js::insertImageRow`：先读现有行再 append、`saveImageRows` 落盘）把它镜像回本机。
 *
 * 断言面（本套 **5** 条 —— 覆盖派单方点名的 ①〜④ ＋ 一条静态门）：
 *   M1 ① 成功且回包 `row` 在场 ⇒ 镜像里**多出该行**（行数 1 → 2）且该行与回包 `row`
 *      **字段逐字**（整行 JSON 相等）；既有行原样保留；`ok: true`、`mirror: true`、
 *      `imageId` 逐字 ＝ `row._id`。
 *   M2 ② **幂等**：同一 `row` 再追一次 ⇒ 行数**不变**（仍 2、零重复），`mirror: true`。
 *   M3 ③ 回包 `row` **缺席** ⇒ 不崩、**零追加**（镜像逐字不变）、返回仍 `ok: true`、
 *      `imageId` 照常回；`mirror: false`（本机没镜像到 ⇒ UI 可据此提示刷新）。
 *   M4 ④ 镜像**写入抛错** ⇒ 整体仍 `ok: true`（仍回 `image_id`）、`mirror: false`、
 *      镜像内容**一字未动**（失败只降级，绝不把成功改判成失败）。
 *   M5 静态门：客户端源文本里镜像调用点恰 1 处、`setAiEnhanceMirrorStore` 导出恰 1 处、
 *      `mirrorCandidateRow` 定义恰 1 处（不第二处硬编码、不直连 `localStorage`）。
 *
 * 纪律：断言失败 ⇒ 退出码 1；不打印任何明文密钥 / 令牌（令牌只登记长度）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

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

const countIn = (text, needle) => String(text).split(needle).length - 1
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* --------------------------------------------------------------------------- *
  浏览端全局假体（`storage.js` / `session.js` 只认 `window.localStorage`）
  —— Node 22 起 `navigator` / `localStorage` 是内置只读 getter ⇒ 赋值必须容错
  （拿不到就用内置的；本套只用 localStorage，不用 clipboard）。
 * --------------------------------------------------------------------------- */
const memory = new Map()
const ls = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => void memory.set(key, String(value)),
  removeItem: (key) => void memory.delete(key),
  clear: () => memory.clear()
}
function defineGlobal(key, value) {
  try {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    return true
  } catch {
    return false
  }
}
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = ls
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}
defineGlobal('localStorage', ls)
defineGlobal('navigator', { clipboard: { writeText: async () => {} } })

/* --------------------------------------------------------------------------- *
  被测件（ESM；先设全局再 import —— 模块求值期可能读存储）
 * --------------------------------------------------------------------------- */
const cloudbaseFn = await import(pathToFileURL(path.join(ROOT, 'src/data/cloudbaseFn.js')).href)
const session = await import(pathToFileURL(path.join(ROOT, 'src/data/session.js')).href)
const writeFaceMode = await import(pathToFileURL(path.join(ROOT, 'src/data/writeFaceMode.js')).href)
const userTokenSvc = await import(pathToFileURL(path.join(ROOT, 'src/services/userToken.js')).href)
const aiEnhance = await import(pathToFileURL(path.join(ROOT, 'src/services/aiEnhance.js')).href)

/* 云端形态（否则 `writeFaceMode()` 回落 local-dev ⇒ 门直接拒，测不到镜像步）＋ 已登录管理员。 */
writeFaceMode.setWriteFaceModeOverride(writeFaceMode.WRITE_FACE_MODES.CLOUD)
session.setUser({ id: 'u-mirror-selfcheck-0001', phone: '13800000000', role: 'admin' })
userTokenSvc.clearUserToken()

/* --------------------------------------------------------------------------- *
  服务端回包夹具（与 `lib/aiEnhance.js` 新成功回包同形：原 8 键 ＋ `row`）
 * --------------------------------------------------------------------------- */
const SHA = 'ab'.padEnd(64, '0')
const baseReply = () => ({
  ok: true,
  image_id: servedRow._id,
  source_image_id: 'img-src000001',
  preview: { mime: 'image/png', sha256: SHA },
  charge: { amount: 10, balance: 40 },
  upstream_status: 200,
  elapsed_ms: 1234,
  idempotent: false
})

/** 服务端「已落库的那一行本身」（键面 ＝ persist 的那一行 ＋ SDK 补的 `_id`）。 */
const ROW = {
  _id: 'img-mirror001',
  id: 'img-mirror001',
  stamp_id: 's-1',
  sealId: 's-1',
  kind: 'FACE',
  storage: 'server',
  storage_key: `xiai/images/${SHA.slice(0, 2)}/${SHA}.png`,
  sha256: SHA,
  bytes: 1024,
  bytesLength: 1024,
  mime: 'image/png',
  width: null,
  height: null,
  source: 'ai_enhance',
  displayOnly: true,
  source_image_id: 'img-src000001',
  charge_balance_after: 40,
  upstream_status: 200,
  elapsed_ms: 1234,
  created_at: '2026-11-02T00:00:00.000Z'
}
/** M4 用的另一枚候選行（不同 id ⇒ 必须真去写 ⇒ 撞上抛错的写入）。 */
const SHA2 = 'cd'.padEnd(64, '2')
const ROW_OTHER = Object.assign({}, ROW, {
  _id: 'img-mirror002',
  id: 'img-mirror002',
  sha256: SHA2,
  storage_key: `xiai/images/${SHA2.slice(0, 2)}/${SHA2}.png`
})
/** 镜像里**已有**的既有行（证明「先读现有行再 append」不覆盖旧数据）。 */
const PREEXIST = {
  id: 'img-pre000001',
  kind: 'FACE',
  storage: 'indexeddb',
  storage_key: 'blob:pre000001',
  sha256: 'de'.padEnd(64, '1'),
  mime: 'image/png',
  created_at: '2026-10-01T00:00:00.000Z'
}

/* --------------------------------------------------------------------------- *
  注入缝 ①：假云函数传输（`issue` 给令牌、`verify` 给成功回包；`row` 可开关）
 * --------------------------------------------------------------------------- */
let withRow = true
let servedRow = ROW
const TRANSPORT_TOKEN = 'offline-selfcheck-token-not-a-secret'
let transportCalls = []

cloudbaseFn.setCloudFunctionTransport(async (name, data) => {
  transportCalls.push({ name, action: data && data.action, op: data && data.op })
  const action = data && typeof data.action === 'string' ? data.action : ''
  if (action === 'issue') {
    /* 取票回包（`token.js::request` 要求 `token` 为非空字符串，否则判「形状不可辨識」）。 */
    const now = Math.floor(Date.now() / 1000)
    return {
      result: {
        ok: true,
        token: TRANSPORT_TOKEN,
        expiresAt: now + 900,
        issuedAt: now,
        ttlSeconds: 900,
        ver: '1',
        sub: 'user',
        uid: 'u-mirror-selfcheck-0001',
        serverNow: now
      }
    }
  }
  const result = Object.assign(baseReply(), { identity: { uid: 'u-mirror-selfcheck-0001' }, serverNow: 0 })
  if (withRow) result.row = servedRow
  return { result }
})

/* --------------------------------------------------------------------------- *
  注入缝 ②：假镜像存储（`list` / `save`；`saveThrows` 模拟写入抛错）
 * --------------------------------------------------------------------------- */
let mirrorRows = []
let saveThrows = false
let saveCalls = 0
aiEnhance.setAiEnhanceMirrorStore({
  list: () => mirrorRows.slice(),
  save: (rows) => {
    saveCalls += 1
    if (saveThrows) throw new Error('MIRROR_WRITE_FAILED')
    mirrorRows = rows.slice()
    return mirrorRows
  }
})

const enhance = () =>
  aiEnhance.enhanceFaceImage({ image_id: 'img-src000001', seal_id: 's-1', face_id: 'f-1' })

/* =========================================================================== *
   M 段：成功回包 `row` ⇒ 本地镜像（① 追加逐字 ② 幂等 ③ 缺席 ④ 写抛错）
 * =========================================================================== */
section('M', 'AI 候選行本地鏡像：成功且 row 在场 ⇒ 追加逐字 / 幂等不重复 / 缺席不追加 / 写抛错只降级')

/* M1 ① 成功且回包 `row` 在场 ⇒ 镜像多出该行且字段逐字。 */
{
  mirrorRows = [PREEXIST]
  const before = mirrorRows.length
  const reply = await enhance()
  const appended = mirrorRows.length === before + 1 ? mirrorRows[mirrorRows.length - 1] : null
  check('M1', '① 成功且回包 `row` 在场 ⇒ 镜像**多出该行**（1 → 2）、该行与回包 `row` **字段逐字**（整行 JSON 相等）、既有行原样保留；返回仍 `ok: true` 且 `mirror: true`、`imageId` 逐字 ＝ `row._id`', {
    ok: true,
    mirror: true,
    countBefore: 1,
    countAfter: 2,
    appendedVerbatim: true,
    preexistingKept: true,
    imageId: ROW._id
  }, {
    ok: reply.ok,
    mirror: reply.mirror,
    countBefore: before,
    countAfter: mirrorRows.length,
    appendedVerbatim: !!appended && deepEqual(appended, ROW),
    preexistingKept: mirrorRows.length > 0 && deepEqual(mirrorRows[0], PREEXIST),
    imageId: reply.imageId
  })
}

/* M2 ② 幂等：同一 `row` 再追一次 ⇒ 行数不变。 */
{
  const before = mirrorRows.length
  const snapshot = JSON.stringify(mirrorRows)
  const reply = await enhance()
  check('M2', '② **幂等**：同一 `row` 再追一次 ⇒ 行数**不变**（仍 2、零重复行）、镜像逐字不变；返回仍 `ok: true`、`mirror: true`', {
    ok: true,
    mirror: true,
    countUnchanged: 2,
    verbatimUnchanged: true
  }, {
    ok: reply.ok,
    mirror: reply.mirror,
    countUnchanged: mirrorRows.length === before ? mirrorRows.length : -1,
    verbatimUnchanged: JSON.stringify(mirrorRows) === snapshot
  })
}

/* M3 ③ 回包 `row` 缺席 ⇒ 不崩、不追加、返回仍 ok。 */
{
  withRow = false
  const before = mirrorRows.length
  const snapshot = JSON.stringify(mirrorRows)
  let reply = null
  let threw = false
  try {
    reply = await enhance()
  } catch {
    threw = true
  }
  withRow = true
  check('M3', '③ 回包 `row` **缺席** ⇒ 不崩（零抛错）、**零追加**（镜像逐字不变）、返回仍 `ok: true` 且照常回 `imageId`；`mirror: false`（本机没镜像到 ⇒ UI 可提示刷新）', {
    threw: false,
    ok: true,
    mirror: false,
    countUnchanged: 2,
    verbatimUnchanged: true,
    imageId: ROW._id
  }, {
    threw,
    ok: reply && reply.ok,
    mirror: reply && reply.mirror,
    countUnchanged: reply && mirrorRows.length === before ? mirrorRows.length : -1,
    verbatimUnchanged: reply && JSON.stringify(mirrorRows) === snapshot,
    imageId: reply && reply.imageId
  })
}

/* M4 ④ 镜像写入抛错 ⇒ 整体仍 ok 且 mirror:false。 */
{
  servedRow = ROW_OTHER
  saveThrows = true
  const before = mirrorRows.length
  const snapshot = JSON.stringify(mirrorRows)
  const savesBefore = saveCalls
  let reply = null
  let threw = false
  try {
    reply = await enhance()
  } catch {
    threw = true
  }
  saveThrows = false
  servedRow = ROW
  check('M4', '④ 镜像**写入抛错** ⇒ 整体仍 `ok: true`（仍回 `image_id`）、`mirror: false`、镜像内容**一字未动**（失败只降级，绝不把成功改判成失败）', {
    threw: false,
    ok: true,
    mirror: false,
    imageId: ROW_OTHER._id,
    writeAttempted: true,
    countUnchanged: 2,
    verbatimUnchanged: true
  }, {
    threw,
    ok: reply && reply.ok,
    mirror: reply && reply.mirror,
    imageId: reply && reply.imageId,
    writeAttempted: saveCalls > savesBefore,
    countUnchanged: reply && mirrorRows.length === before ? mirrorRows.length : -1,
    verbatimUnchanged: reply && JSON.stringify(mirrorRows) === snapshot
  })
}

/* M5 静态门：镜像调用点恰 1 处、注入缝导出恰 1 处、helper 定义恰 1 处（零 localStorage 字面值）。 */
{
  const source = readFileSync(path.join(ROOT, 'src/services/aiEnhance.js'), 'utf8')
  check('M5', '静态门：`mirrorCandidateRow` 定义恰 1 处且调用点恰 1 处（唯一镜像步）、`setAiEnhanceMirrorStore` 导出恰 1 处（唯一注入缝）、镜像读写只经 `listImageRows` / `saveImageRows` 两个 db 入口、本文件零 `localStorage.` 访问', {
    mirrorDefs: 1,
    mirrorCallSites: 1,
    seamExports: 1,
    dbEntries: 2,
    localStorageAccess: 0
  }, {
    mirrorDefs: countIn(source, 'function mirrorCandidateRow('),
    mirrorCallSites: countIn(source, 'mirrorCandidateRow(gate.row)'),
    seamExports: countIn(source, 'export function setAiEnhanceMirrorStore('),
    dbEntries: countIn(source, 'return listImageRows()') + countIn(source, 'return saveImageRows('),
    localStorageAccess: countIn(source, 'localStorage.')
  })
}

/* 收针：清两道注入缝（不留全局态给后续脚本进程）。 */
cloudbaseFn.setCloudFunctionTransport(null)
aiEnhance.setAiEnhanceMirrorStore(null)

/* =========================================================================== *
   收尾
 * =========================================================================== */
console.log(
  JSON.stringify({
    summary: { total, passed, failed: total - passed },
    sections: sectionStats,
    failed_ids: failedIds,
    note: '离线自检：注入 setCloudFunctionTransport（假云函数回包）＋ setAiEnhanceMirrorStore（假镜像存储）；零网络、零云端、零生产数据；不打印任何令牌原文。'
  })
)
process.exit(total === passed ? 0 : 1)
