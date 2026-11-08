/**
 * 玺爱 · **自检：AI 候選行本地鏡像**（`scripts/verify-ai-enhance-mirror.mjs`）
 * ============================================================================ *
 * **本地、离线**（注入假云函数传输 ＋ 注入假镜像存储；零网络、零云端连接、零生产数据）。
 * 被测件：`src/services/aiEnhance.js::enhanceFaceImage` 的两段异步路（submit → status）
 * ＋ 注入缝 `setAiEnhanceMirrorStore`。
 *
 * 背景（**本单裁定，冻结语义**）：`ai-enhance-status` 的 `READY` 回包是**冻结契约恰六键**
 * `ok / task_id / status / image_id / preview / charge` —— **不含 `row`**。因此客户端镜像步
 * （`mirrorCandidateRow(gate.row)`）在异步路恒得 `mirror: false` 是**设计结果、不是缺陷**：
 * 界面靠**云端快照**取图（详情页另有 `retryDataSource` 回落）。本套据此断言**新语义**，
 * 不再要求镜像成功。
 *
 * 假传输按 `action` / `op` **分派**（`issue` 出令牌；`ai-enhance-submit` 回恰五键；
 * `ai-enhance-status` 回恰六键 `READY`；未知 op 结构化拒绝）—— 旧「一切非 issue 动作都回
 * 同步旧形状」的假传输正是上一版 M1〜M4 全红的真因。
 *
 * 断言面（本套 **5** 条 —— M1〜M4 按裁定重写 ＋ 一条静态门）：
 *   M1 异步第一段：`ai-enhance-submit` 回包**恰五键** `ok/task_id/status/source_image_id/charge`
 *      且**无 `row`** ⇒ 客户端不崩、镜像零追加、仍 `ok: true`；`imageId` 取自后续
 *      `ai-enhance-status` 的 `READY.image_id`；`mirror: false`（两段各恰 1 发）。
 *   M2 **同 `request_id` 重放**（钉住 id 生成两发同一号）⇒ 服务端**只扣一次**、回同一
 *      `task_id`、第二次回包 `charge.balance` 与第一次逐字相同；镜像步零追加。
 *   M3 `READY` **恰六键且无 `row`**（冻结契约）⇒ 零抛错、镜像一字未动（零读零写）、
 *      `ok: true`、`mirror: false`、`imageId` 逐字 ＝ `READY.image_id`。
 *   M4 镜像存储配置为「读 / 写即抛」⇒ `READY` 分支回包与 M3 **逐字相同**、`ok: true`、
 *      `mirror: false`、镜像一字未动（抛错只降级、零触发，**绝不把成功改判成失败**）。
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
const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const hasKey = (value, key) => Boolean(value) && Object.prototype.hasOwnProperty.call(value, key)

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
  夹具读数（异步两段契约；**回包里恒无 `row`** —— 冻结语义）
 * --------------------------------------------------------------------------- */
const SHA = 'ab'.padEnd(64, '0')
const SOURCE_IMAGE_ID = 'img-src000001'
const TASK_ID = 'aiet-0f24ace91b3d5701' /* `aiet-` ＋ 16 位十六进制（与服务端形态逐字同形）。 */
const READY_IMAGE_ID = 'img-ready00000001'
const CHARGE_AMOUNT = 10
const START_BALANCE = 50

/** 镜像里**已有**的既有行（证明镜像步即便发生也不会覆盖旧数据；新语义下它恒原样）。 */
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
  注入缝 ①：假云函数传输 —— **按 `action` / `op` 分派**的异步回包
  （`issue` 出令牌；`ai-enhance-submit` 恰五键；`ai-enhance-status` 恰六键 READY；
   未知 op ⇒ 结构化拒绝；**任何 op 都不回 `row`**）
 * --------------------------------------------------------------------------- */
const TRANSPORT_TOKEN = 'offline-selfcheck-token-not-a-secret'
let transportCalls = []

/* 服务端假账本（幂等判据：同 `request_id` 只扣一次、只回原回包）。 */
let serverBalance = START_BALANCE
const submitLedger = new Map()
const submits = [] /* `{request_id, task_id, balance}` —— 逐发登记。 */
const statusReplies = []
let statusCalls = 0

function resetServerState() {
  serverBalance = START_BALANCE
  submitLedger.clear()
  submits.length = 0
  statusReplies.length = 0
  statusCalls = 0
}

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
  const op = data && typeof data.op === 'string' ? data.op : ''
  const payload = (data && data.payload) || {}

  if (op === 'ai-enhance-submit') {
    /* 恰五键 `ok / task_id / status / source_image_id / charge`（**无 `row`**）；
       同 `request_id` ⇒ 幂等回放（原回包原样回吐，零新增扣费）。 */
    const requestId = String(payload.request_id === undefined || payload.request_id === null ? '' : payload.request_id)
    let entry = submitLedger.get(requestId)
    if (!entry) {
      serverBalance -= CHARGE_AMOUNT
      entry = {
        task_id: TASK_ID,
        balance: serverBalance,
        reply: {
          ok: true,
          task_id: TASK_ID,
          status: 'SUBMITTED',
          source_image_id: String(payload.image_id === undefined || payload.image_id === null ? '' : payload.image_id),
          charge: { amount: CHARGE_AMOUNT, balance: serverBalance }
        }
      }
      submitLedger.set(requestId, entry)
    }
    submits.push({ request_id: requestId, task_id: entry.task_id, balance: entry.balance, reply: entry.reply })
    return { result: Object.assign({}, entry.reply) }
  }

  if (op === 'ai-enhance-status') {
    /* 恰六键 `ok / task_id / status / image_id / preview / charge`（**无 `row`** —— 冻结契约）。 */
    statusCalls += 1
    const reply = {
      ok: true,
      task_id: String(payload.task_id === undefined || payload.task_id === null ? '' : payload.task_id),
      status: 'READY',
      image_id: READY_IMAGE_ID,
      preview: { mime: 'image/png', sha256: SHA },
      charge: { amount: CHARGE_AMOUNT, balance: serverBalance }
    }
    statusReplies.push(reply)
    return { result: reply }
  }

  /* 未知 op（含 `issue` 之外的一切）⇒ 结构化拒绝（不拿旧同步形状糊弄过去）。 */
  return { result: { ok: false, reason: 'INVALID_VALUE', message: `離線自檢：未知 op（${op || '（空）'}）`, refunded: false } }
})

/* --------------------------------------------------------------------------- *
  注入缝 ②：假镜像存储（`list` / `save`；`listThrows` / `saveThrows` 模拟读 / 写抛错）
 * --------------------------------------------------------------------------- */
let mirrorRows = []
let saveThrows = false
let listThrows = false
let saveCalls = 0
let listCalls = 0
aiEnhance.setAiEnhanceMirrorStore({
  list: () => {
    listCalls += 1
    if (listThrows) throw new Error('MIRROR_READ_FAILED')
    return mirrorRows.slice()
  },
  save: (rows) => {
    saveCalls += 1
    if (saveThrows) throw new Error('MIRROR_WRITE_FAILED')
    mirrorRows = rows.slice()
    return mirrorRows
  }
})

const enhance = () =>
  aiEnhance.enhanceFaceImage({ image_id: SOURCE_IMAGE_ID, seal_id: 's-1', face_id: 'f-1' })

/**
 * **钉住 `request_id` 生成**（`makeRequestId()` 只吃 `Date.now` / `Math.random`）：
 * 两次调用各包一次、常量逐字相同 ⇒ 产出**同一个 `request_id`**（服务端据此幂等）。
 * 只在本次调用期间生效，`finally` 立即还原 —— **不留全局态**。
 * @returns {Promise<object>}
 */
async function stableEnhance() {
  const originalRandom = Math.random
  const originalNow = Date.now
  const FIXED_NOW = 1793000000000
  Math.random = () => 0.987654321
  Date.now = () => FIXED_NOW
  try {
    return await enhance()
  } finally {
    Math.random = originalRandom
    Date.now = originalNow
  }
}

/* =========================================================================== *
   M 段：异步两段（submit → status READY）下的镜像语义
 * =========================================================================== */
section('M', 'AI 候選行本地鏡像：异步两段（submit 恰五键无 row → status READY 恰六键无 row）⇒ 镜像零追加、mirror 恒 false 是设计结果')

/* M1 ① submit 恰五键、无 row ⇒ 客户端不崩、镜像零追加、imageId 取自 READY。 */
{
  resetServerState()
  mirrorRows = [PREEXIST]
  const savesBefore = saveCalls
  const listsBefore = listCalls
  let reply = null
  let threw = false
  try {
    reply = await stableEnhance()
  } catch {
    threw = true
  }
  const submit = submits[0] || null
  const ready = statusReplies[0] || null
  check('M1', '① 异步第一段 `ai-enhance-submit` 回包**恰五键** `ok/task_id/status/source_image_id/charge` 且**无 `row`** ⇒ 客户端不崩（零抛错）、镜像零追加；两段各恰 1 发；返回仍 `ok: true`、`mirror: false`，`imageId` **取自后续** `ai-enhance-status` 的 `READY.image_id`', {
    submitKeys: 'charge,ok,source_image_id,status,task_id',
    submitHasRow: false,
    readyKeys: 'charge,image_id,ok,preview,status,task_id',
    readyHasRow: false,
    submitCalls: 1,
    statusCalls: 1,
    threw: false,
    ok: true,
    mirror: false,
    imageId: READY_IMAGE_ID,
    mirrorCount: 1,
    mirrorWrites: 0,
    mirrorReads: 0
  }, {
    submitKeys: submit ? shapeOf(submit.reply) : '(no submit)',
    submitHasRow: submit ? hasKey(submit.reply, 'row') : null,
    readyKeys: ready ? shapeOf(ready) : '(no status)',
    readyHasRow: ready ? hasKey(ready, 'row') : null,
    submitCalls: submits.length,
    statusCalls,
    threw,
    ok: reply && reply.ok,
    mirror: reply && reply.mirror,
    imageId: reply && reply.imageId,
    mirrorCount: mirrorRows.length,
    mirrorWrites: saveCalls - savesBefore,
    mirrorReads: listCalls - listsBefore
  })
}

/* M2 ② 同 `request_id` 重放 ⇒ 服务端只扣一次、回同一 task_id；镜像步零追加。 */
{
  const mirrorBefore = mirrorRows.length
  const snapshot = JSON.stringify(mirrorRows)
  const savesBefore = saveCalls
  const first = submits[0] || null
  let reply = null
  let threw = false
  try {
    reply = await stableEnhance()
  } catch {
    threw = true
  }
  const second = submits[1] || null
  check('M2', '② **同 `request_id` 重放**（两段异步各再走一遍）：两次 submit 载荷的 `request_id` **逐字相同**且形态合服务端封闭面（8〜64 位字母数字 / 下划线）⇒ 服务端**只扣一次**、回同一 `task_id`，第二次回包 `charge.balance` 与第一次**逐字相同**（零重复扣费）；客户端仍 `ok: true`、`mirror: false`，镜像步**零追加**（行数与内容逐字不变）', {
    submitCalls: 2,
    requestIdsSame: true,
    requestIdShape: true,
    chargedOnce: true,
    sameTaskId: true,
    balanceUnchanged: true,
    threw: false,
    ok: true,
    mirror: false,
    imageId: READY_IMAGE_ID,
    mirrorCount: 1,
    mirrorUnchanged: true,
    mirrorWrites: 0
  }, {
    submitCalls: submits.length,
    requestIdsSame: Boolean(first && second && first.request_id !== '' && first.request_id === second.request_id),
    requestIdShape: Boolean(first && second) && [first.request_id, second.request_id].every((id) => /^[A-Za-z0-9_]{8,64}$/.test(id)),
    chargedOnce: submitLedger.size === 1,
    sameTaskId: Boolean(first && second && first.task_id === second.task_id),
    balanceUnchanged: Boolean(first && second && first.balance === second.balance),
    threw,
    ok: reply && reply.ok,
    mirror: reply && reply.mirror,
    imageId: reply && reply.imageId,
    mirrorCount: mirrorRows.length,
    mirrorUnchanged: mirrorRows.length === mirrorBefore && JSON.stringify(mirrorRows) === snapshot,
    mirrorWrites: saveCalls - savesBefore
  })
}

/* M3 ③ READY 恰六键且无 row（冻结契约）⇒ 零抛错、镜像一字未动、ok:true、mirror:false。 */
let m3Reply = null
{
  resetServerState()
  const mirrorBefore = mirrorRows.length
  const snapshot = JSON.stringify(mirrorRows)
  const savesBefore = saveCalls
  const listsBefore = listCalls
  let reply = null
  let threw = false
  try {
    reply = await enhance()
  } catch {
    threw = true
  }
  m3Reply = reply
  const ready = statusReplies[0] || null
  check('M3', '③ `ai-enhance-status::READY` **恰六键** `ok/task_id/status/image_id/preview/charge` 且**无 `row`**（冻结契约 ⇒ 界面靠云端快照取图）⇒ 零抛错、镜像**一字未动**（零读零写）、返回仍 `ok: true`、`mirror: false`，`imageId` 逐字 ＝ `READY.image_id`', {
    readyKeys: 'charge,image_id,ok,preview,status,task_id',
    readyHasRow: false,
    threw: false,
    ok: true,
    mirror: false,
    imageId: READY_IMAGE_ID,
    mirrorCount: 1,
    mirrorUnchanged: true,
    mirrorWrites: 0,
    mirrorReads: 0
  }, {
    readyKeys: ready ? shapeOf(ready) : '(no status)',
    readyHasRow: ready ? hasKey(ready, 'row') : null,
    threw,
    ok: reply && reply.ok,
    mirror: reply && reply.mirror,
    imageId: reply && reply.imageId,
    mirrorCount: mirrorRows.length,
    mirrorUnchanged: mirrorRows.length === mirrorBefore && JSON.stringify(mirrorRows) === snapshot,
    mirrorWrites: saveCalls - savesBefore,
    mirrorReads: listCalls - listsBefore
  })
}

/* M4 ④ 镜像存储读 / 写即抛 ⇒ READY 分支回包与 M3 逐字相同、仍成功、镜像一字未动。 */
{
  resetServerState()
  saveThrows = true
  listThrows = true
  const mirrorBefore = mirrorRows.length
  const snapshot = JSON.stringify(mirrorRows)
  const savesBefore = saveCalls
  const listsBefore = listCalls
  let reply = null
  let threw = false
  try {
    reply = await enhance()
  } catch {
    threw = true
  }
  saveThrows = false
  listThrows = false
  check('M4', '④ 镜像存储配置为「读 / 写即抛」：`READY` 分支（回包无 `row` ⇒ 镜像步零读零写、抛错**零触发**）回包与 M3 **逐字相同** ⇒ 仍 `ok: true`、`mirror: false`、`imageId` 照常回、镜像**一字未动** —— 失败只降级，**绝不把成功改判成失败**', {
    threw: false,
    ok: true,
    mirror: false,
    imageId: READY_IMAGE_ID,
    replySameAsM3: true,
    storeTouched: false,
    mirrorCount: 1,
    mirrorUnchanged: true
  }, {
    threw,
    ok: reply && reply.ok,
    mirror: reply && reply.mirror,
    imageId: reply && reply.imageId,
    replySameAsM3: deepEqual(reply, m3Reply),
    storeTouched: saveCalls > savesBefore || listCalls > listsBefore,
    mirrorCount: mirrorRows.length,
    mirrorUnchanged: mirrorRows.length === mirrorBefore && JSON.stringify(mirrorRows) === snapshot
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
    note: '离线自检：注入 setCloudFunctionTransport（按 action/op 分派的异步回包，零 row）＋ setAiEnhanceMirrorStore（假镜像存储）；零网络、零云端、零生产数据；不打印任何令牌原文。'
  })
)
process.exit(total === passed ? 0 : 1)
