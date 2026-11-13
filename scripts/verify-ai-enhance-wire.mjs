/**
 * 玺爱 · **自检：AI 修復讀數面穿透（index.js additive 透传线）**（本单新增）
 * ============================================================================
 * **本地、离线**（零网络、零云端连接、零生产数据；不调用任何 op 实现、不落盘）。被测件：
 *   · `cloudfunctions/xiai-user-token/index.js` 的纯函数 `pickAiEnhanceReadouts(op, opResult)`
 *     ＋ 白名单常量 `AI_ENHANCE_READOUT_KEYS`（两者均自 index.js 直接 import）；
 *     W5〜W12 另对 index.js `handleVerify` 内的**异步三 op 穿透块**做**源码级执行**
 *     （锚点切出真实函数体、按原参签名跑 —— 不复制实现）＋ `lib/aiEnhanceTasks.js` 键面常量。
 *
 * 背景（§3.68 讀數面）：`lib/aiEnhance.js`（`ai-enhance-face`）成功回包恰 8 键、
 * `lib/aiEnhanceDiscard.js`（`ai-enhance-discard`）成功回包恰 3 键 —— 键名真源在那两个 lib；
 * 但 `index.js` 组装 success response 时用**固定白名单**（ok / op / row / projection / summary /
 * value / artifact / display / docId / …）⇒ 读数键全被丢掉 ⇒ 客户端拿不到 `image_id`。
 * 本套钉住穿透面：**存在性驱动、按 op 收窄、逐字透传**。
 *
 * 断言面（本套 **12** 条 —— W1〜W4 既有 ＋ W5〜W12 异步三 op 穿透收窄，本单新增）：
 *   W1 ① `op = ai-enhance-face`、`opResult` 含 8 键 ⇒ response 含
 *      `image_id / source_image_id / preview / charge / upstream_status / elapsed_ms / idempotent`
 *      且**逐字相等**（深比较）；`ok` 不被覆盖；`opResult` 没有的白名单键（`deleted_objects`）
 *      **不出现**（存在性驱动，非全量白名单灌入）。
 *   W2 ② `op = ai-enhance-discard`、`opResult` 含 `image_id / deleted_objects` ⇒ response 恰含这两键
 *      且逐字相等；face 专属键（`preview` 等）不出现。
 *   W3 ③ `op = submitCorrection`（其它 op）、`opResult` 勉强带 `image_id` ⇒ 纯函数回 `null`、
 *      response **不得出现 `image_id`**（证明是**按 op 名收窄**、不是全量透传）。
 *   W4 ④ 静态门：index.js 源文本中两个 op 名**各恰 1 处**（不重复注册、不第二处硬编码）；
 *      `AI_ENHANCE_READOUT_KEYS` **恰 8 项**且与约定清单逐字一致；调用点恰 1 处。
 *   W5〜W10 **异步三 op 穿透收窄**（`ai-enhance-submit` / `ai-enhance-status` / `ai-enhance-list`
 *      各一条正例 ＋ 一条 `submitCorrection` 负例）—— **在 index.js 的真实穿透块上跑**
 *      （把 `pickAiEnhanceReadouts` 调用点 → `return response` 这段源码原样取出、按原参签名
 *      执行；不复制实现）：
 *      · submit 只透出 `task_id / status / source_image_id / charge`（恰四键、逐字）；
 *      · status `READY` 只透出 `task_id / status / image_id / preview / charge`（恰五键、逐字）；
 *        `RUNNING` 只透出 `task_id / status / upstream_status`（恰三键、逐字）；
 *      · list 只透出 `rows`（逐字、行面不改写）；
 *      · 三负例：同一份回包换 `submitCorrection` 打 ⇒ 这些键**一律不出现**。
 *   W12 ⑫ 静态门：穿透块锚点在场（本套能取出执行）；submit/status 守卫、list 守卫各恰 1 处；
 *      白名单逐字取自源码且**不含契约外键**（`plan` / `row` / `refunded`）、覆盖 submit 与
 *      `READY` 两态契约键；存在性驱动（`hasOwnProperty`）；`rows` 只在 list 守卫下挂载；
 *      纯函数对三新 op 一律回 `null`（新透传只经按 op 守卫块）。
 *
 * 纪律：断言失败 ⇒ 退出码 1；零密钥、零令牌原文、零生产数据。
 */
/* **测试环境保护哨兵（硬防线）** —— 本套件只跑离线假 CARD：置 `XIAI_NO_REAL_CARD=1`。
   若哪个调用点漏注入假传输，`lib/cardApi.js` 会**当场抛错、零请求**（绝不悄悄打生产 CARD）。
   跑任何套件前**不得** export 真 `CARD_API_KEY`（见 `scripts/README-test-net.md`）。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

/* 被测件：index.js 本体（纯函数与常量随模块导出；index.js 零 SDK 字面 ⇒ 可直接 require）。 */
const fn = require(path.join(FN_DIR, 'index.js'))
const { readFileSync } = require('node:fs')

/* ---------------------------------------------------------------------------
   断言 / 读数（与既有 verify-*.mjs 同形）
 * --------------------------------------------------------------------------- */
let total = 0
let passed = 0
const failedIds = []
const sectionStats = {}

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

/** 模拟 verify 成功回包的**固定白名单组装**（与 `index.js` 的 response 键面同形；
 *  其余键填样例值 —— 只为证明「穿透块只叠自己那几个键、不动既有键」）。 */
function baseResponse(op) {
  return {
    ok: true,
    op,
    row: { _id: 'row-fixture' },
    projection: undefined,
    summary: undefined,
    value: undefined,
    artifact: undefined,
    display: undefined,
    docId: 'doc-fixture',
    authority: 'SERVER',
    identity_source: 'SERVER_TOKEN',
    identity: { uid: 'u-fixture', phone: '', phoneFingerprint: '', identity_source: 'SERVER_TOKEN' },
    serverNow: 1790000000,
    ver: '1'
  }
}

/** 按 index.js 调用点同形叠键（存在性驱动：纯函数回 null ⇒ 零叠键）。 */
function wireResponse(op, opResult) {
  const response = baseResponse(op)
  const picked = fn.pickAiEnhanceReadouts(op, opResult)
  if (picked) {
    for (const key of Object.keys(picked)) response[key] = picked[key]
  }
  return response
}

console.log(JSON.stringify({ section: 'W', title: 'AI 修復讀數面穿透：存在性驱动 · 按 op 收窄 · 逐字透传' }))

/* --------------------------------------------------------------------------- *
   W1 ① ai-enhance-face：8 键 opResult ⇒ 7 个读数键逐字穿透（`ok` 不被覆盖）
 * --------------------------------------------------------------------------- */
{
  const opResult = {
    ok: true,
    image_id: 'img-8a28a520',
    source_image_id: 'img-b1fdf240',
    preview: { mime: 'image/jpeg', sha256: 'b1fdf240c0ffee' },
    charge: { amount: 10, balance: 40 },
    upstream_status: 200,
    elapsed_ms: 35210,
    idempotent: false
  }
  const response = wireResponse('ai-enhance-face', opResult)
  const readoutKeys = ['image_id', 'source_image_id', 'preview', 'charge', 'upstream_status', 'elapsed_ms', 'idempotent']
  check('W1', '① `ai-enhance-face`：response 含 7 个读数键且**逐字相等**（深比较）；`ok` 仍为 true；白名单里 opResult 没有的键（`deleted_objects`）不出现', {
    present: readoutKeys,
    verbatim: true,
    okUntouched: true,
    absentKeys: ['deleted_objects'],
    existingUntouched: true
  }, {
    present: readoutKeys.filter((k) => Object.prototype.hasOwnProperty.call(response, k)),
    verbatim: readoutKeys.every((k) => deepEqual(response[k], opResult[k])),
    okUntouched: response.ok === true,
    absentKeys: ['deleted_objects'].filter((k) => !Object.prototype.hasOwnProperty.call(response, k)),
    existingUntouched: deepEqual(response.row, { _id: 'row-fixture' }) && response.docId === 'doc-fixture' && response.authority === 'SERVER'
  })
}

/* --------------------------------------------------------------------------- *
   W2 ② ai-enhance-discard：image_id + deleted_objects ⇒ 恰两键穿透
 * --------------------------------------------------------------------------- */
{
  const opResult = { ok: true, image_id: 'img-8a28a520', deleted_objects: true }
  const response = wireResponse('ai-enhance-discard', opResult)
  check('W2', '② `ai-enhance-discard`：response 含 `image_id` / `deleted_objects` 且逐字相等；face 专属键（`preview` 等）不出现', {
    imageId: 'img-8a28a520',
    deletedObjects: true,
    faceOnlyAbsent: true
  }, {
    imageId: response.image_id,
    deletedObjects: response.deleted_objects,
    faceOnlyAbsent: ['preview', 'source_image_id', 'upstream_status', 'elapsed_ms'].every((k) => !Object.prototype.hasOwnProperty.call(response, k))
  })
}

/* --------------------------------------------------------------------------- *
   W3 ③ 其它 op（submitCorrection）：opResult 勉强带 image_id ⇒ response 零出现
 * --------------------------------------------------------------------------- */
{
  const opResult = { ok: true, row: { _id: 'c-1' }, image_id: 'img-should-not-leak' }
  const response = wireResponse('submitCorrection', opResult)
  const picked = fn.pickAiEnhanceReadouts('submitCorrection', opResult)
  check('W3', '③ 其它 op（`submitCorrection`）：纯函数回 `null`、response **不得出现 `image_id`**（证明按 op 名收窄、非全量透传）', {
    picked: null,
    imageIdAbsent: true,
    noReadoutKeys: true
  }, {
    picked,
    imageIdAbsent: !Object.prototype.hasOwnProperty.call(response, 'image_id'),
    noReadoutKeys: ['image_id', 'source_image_id', 'preview', 'charge', 'upstream_status', 'elapsed_ms', 'idempotent', 'deleted_objects'].every((k) => !Object.prototype.hasOwnProperty.call(response, k))
  })
}

/* --------------------------------------------------------------------------- *
   W4 ④ 静态门：两个 op 名在 index.js 各恰 1 处；白名单恰 8 项；调用点恰 1 处
 * --------------------------------------------------------------------------- */
{
  const indexSource = readFileSync(path.join(FN_DIR, 'index.js'), 'utf8')
  const EXPECTED = ['image_id', 'source_image_id', 'preview', 'charge', 'upstream_status', 'elapsed_ms', 'idempotent', 'deleted_objects']
  const exportedKeys = Array.isArray(fn.AI_ENHANCE_READOUT_KEYS) ? Array.from(fn.AI_ENHANCE_READOUT_KEYS) : null
  check('W4', '④ 静态门：index.js 两个 op 名各恰 1 处（不重复注册）＋ `AI_ENHANCE_READOUT_KEYS` 恰 8 项且逐字＝约定清单 ＋ 调用点恰 1 处', {
    faceOps: 1,
    discardOps: 1,
    keyCount: 8,
    keyList: EXPECTED,
    callSites: 1
  }, {
    faceOps: countIn(indexSource, "'ai-enhance-face'"),
    discardOps: countIn(indexSource, "'ai-enhance-discard'"),
    keyCount: exportedKeys ? exportedKeys.length : -1,
    keyList: exportedKeys,
    callSites: countIn(indexSource, 'const aiEnhanceReadouts = pickAiEnhanceReadouts(op, opResult)')
  })
}

/* ========================================================================== *
   W5〜W12：**异步三 op 穿透收窄**（submit / status / list 各一正一负 ＋ 静态门）
   —— 被测件＝ `index.js` 的**真实穿透块**（锚点 `pickAiEnhanceReadouts` 调用点 →
   `return response`；源码原样取出、按原参签名执行，**不复制实现**）
 * ========================================================================== */
const tasks = require(path.join(FN_DIR, 'lib/aiEnhanceTasks.js'))
const wireSource = readFileSync(path.join(FN_DIR, 'index.js'), 'utf8')
const WIRE_ANCHOR = 'const aiEnhanceReadouts = pickAiEnhanceReadouts(op, opResult)'
const WIRE_RETURN = 'return response'
const sortedKeys = (list) => Array.from(list).sort()
const hasKey = (obj, key) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key)
/** response 相对基线**新增**的键（＝ 本 op 的透出面；按名排序）。 */
const addedKeysOf = (response, base) =>
  Object.keys(response).filter((key) => !Object.prototype.hasOwnProperty.call(base, key)).sort()

/** 取出真实穿透块（锚点切不到 ⇒ `null` ⇒ 各读数自然判负）。 */
function wireBlockSource() {
  const start = wireSource.indexOf(WIRE_ANCHOR)
  if (start === -1) return null
  const end = wireSource.indexOf(WIRE_RETURN, start)
  if (end === -1) return null
  return wireSource.slice(start, end + WIRE_RETURN.length)
}

/** 在真实源码块上跑一次穿透（`response` 就地叠键后原样回吐）。 */
function realWireResponse(op, opResult) {
  const block = wireBlockSource()
  if (block === null) return null
  const response = baseResponse(op)
  const run = new Function('op', 'opResult', 'response', 'pickAiEnhanceReadouts', `${block}\nreturn response`)
  return run(op, opResult, response, fn.pickAiEnhanceReadouts)
}

/* 三 op 的**裁定键面**（只透出这些；服务端键面真源 ＝ `lib/aiEnhanceTasks.js`）。 */
const SUBMIT_PICKED = ['charge', 'source_image_id', 'status', 'task_id']
const STATUS_READY_PICKED = ['charge', 'image_id', 'preview', 'status', 'task_id']
const STATUS_RUNNING_PICKED = ['status', 'task_id', 'upstream_status']
const LIST_PICKED = ['rows']

/* --------------------------------------------------------------------------- *
   W5 ⑤ submit 正例：恰四键逐字透出；内部键 / 他态键不外泄
 * --------------------------------------------------------------------------- */
{
  const opResult = {
    ok: true,
    task_id: 'aiet-0f24ace91b3d5701',
    status: 'SUBMITTED',
    source_image_id: 'img-src000001',
    charge: { amount: 10, balance: 40 },
    plan: [{ kind: 'upload' }]
  }
  const response = realWireResponse('ai-enhance-submit', opResult)
  const picked = response ? addedKeysOf(response, baseResponse('ai-enhance-submit')) : null
  check('W5', '⑤ `ai-enhance-submit`：真实穿透块**只透出** `task_id / status / source_image_id / charge`（恰四键、逐字相等）；白名单外内部键 `plan` 与他态 / 他 op 专属键（`image_id` / `preview` / `upstream_status` / `rows`）不出现；服务端契约键面逐字 ＝ `SUBMIT_SUCCESS_KEYS`，`ok` 不被覆盖', {
    contractKeys: 'charge,ok,source_image_id,status,task_id',
    picked: SUBMIT_PICKED,
    verbatim: true,
    internalAbsent: true,
    foreignAbsent: true,
    okUntouched: true
  }, {
    contractKeys: sortedKeys(tasks.SUBMIT_SUCCESS_KEYS).join(','),
    picked,
    verbatim: Boolean(response) && SUBMIT_PICKED.every((key) => deepEqual(response[key], opResult[key])),
    internalAbsent: Boolean(response) && !hasKey(response, 'plan'),
    foreignAbsent: Boolean(response) && ['image_id', 'preview', 'upstream_status', 'rows'].every((key) => !hasKey(response, key)),
    okUntouched: Boolean(response) && response.ok === true
  })
}

/* --------------------------------------------------------------------------- *
   W6 ⑥ submit 负例：换 `submitCorrection` 打同一份回包 ⇒ 四键零出现
 * --------------------------------------------------------------------------- */
{
  const opResult = {
    ok: true,
    task_id: 'aiet-0f24ace91b3d5701',
    status: 'SUBMITTED',
    source_image_id: 'img-src000001',
    charge: { amount: 10, balance: 40 },
    plan: [{ kind: 'upload' }]
  }
  const response = realWireResponse('submitCorrection', opResult)
  const picked = response ? addedKeysOf(response, baseResponse('submitCorrection')) : null
  check('W6', '⑥ 负例：拿 `submitCorrection` 打**同一份** submit 回包 ⇒ 纯函数回 `null`、真实块**零叠键** —— `task_id / status / source_image_id / charge / plan` 一律不出现（按 op 名收窄，非全量透传）', {
    purePicked: null,
    added: '',
    keysAbsent: true
  }, {
    purePicked: fn.pickAiEnhanceReadouts('submitCorrection', opResult),
    added: picked ? picked.join(',') : null,
    keysAbsent: Boolean(response) && ['task_id', 'status', 'source_image_id', 'charge', 'plan'].every((key) => !hasKey(response, key))
  })
}

/* --------------------------------------------------------------------------- *
   W7 ⑦ status 正例 · `READY`：恰五键逐字透出（契约外键不外泄）
 * --------------------------------------------------------------------------- */
{
  const opResult = {
    ok: true,
    task_id: 'aiet-0f24ace91b3d5701',
    status: 'READY',
    image_id: 'img-ready00000001',
    preview: { mime: 'image/png', sha256: 'ab'.padEnd(64, '0') },
    charge: { amount: 10, balance: 40 },
    plan: [{ kind: 'ingest' }]
  }
  const response = realWireResponse('ai-enhance-status', opResult)
  const picked = response ? addedKeysOf(response, baseResponse('ai-enhance-status')) : null
  check('W7', '⑦ `ai-enhance-status::READY`：真实穿透块**只透出** `task_id / status / image_id / preview / charge`（恰五键、逐字相等、无契约外键）；服务端契约键面逐字 ＝ `STATUS_READY_KEYS`，`ok` 不被覆盖', {
    contractKeys: 'charge,image_id,ok,preview,status,task_id',
    picked: STATUS_READY_PICKED,
    verbatim: true,
    internalAbsent: true,
    okUntouched: true
  }, {
    contractKeys: sortedKeys(tasks.STATUS_READY_KEYS).join(','),
    picked,
    verbatim: Boolean(response) && STATUS_READY_PICKED.every((key) => deepEqual(response[key], opResult[key])),
    internalAbsent: Boolean(response) && !hasKey(response, 'plan') && !hasKey(response, 'upstream_status'),
    okUntouched: Boolean(response) && response.ok === true
  })
}

/* --------------------------------------------------------------------------- *
   W8 ⑧ status 正例 · `RUNNING`：恰三键逐字透出（含 `upstream_status`）
 * --------------------------------------------------------------------------- */
{
  const opResult = { ok: true, task_id: 'aiet-0f24ace91b3d5701', status: 'RUNNING', upstream_status: 200 }
  const response = realWireResponse('ai-enhance-status', opResult)
  const picked = response ? addedKeysOf(response, baseResponse('ai-enhance-status')) : null
  check('W8', '⑧ `ai-enhance-status::RUNNING`：真实穿透块**只透出** `task_id / status / upstream_status`（恰三键、逐字相等 —— 客户端 `STATUS_READOUT_KEYS` 声明的 `upstream_status` 必须真到手）；服务端契约键面逐字 ＝ `STATUS_RUNNING_KEYS`', {
    contractKeys: 'ok,status,task_id,upstream_status',
    picked: STATUS_RUNNING_PICKED,
    verbatim: true,
    okUntouched: true
  }, {
    contractKeys: sortedKeys(tasks.STATUS_RUNNING_KEYS).join(','),
    picked,
    verbatim: Boolean(response) && STATUS_RUNNING_PICKED.every((key) => hasKey(response, key) && deepEqual(response[key], opResult[key])),
    okUntouched: Boolean(response) && response.ok === true
  })
}

/* --------------------------------------------------------------------------- *
   W9 ⑨ status 负例：换 `submitCorrection` 打同一份回包 ⇒ 六键零出现
 * --------------------------------------------------------------------------- */
{
  const opResult = {
    ok: true,
    task_id: 'aiet-0f24ace91b3d5701',
    status: 'READY',
    image_id: 'img-ready00000001',
    preview: { mime: 'image/png', sha256: 'ab'.padEnd(64, '0') },
    charge: { amount: 10, balance: 40 },
    upstream_status: 200
  }
  const response = realWireResponse('submitCorrection', opResult)
  const picked = response ? addedKeysOf(response, baseResponse('submitCorrection')) : null
  check('W9', '⑨ 负例：拿 `submitCorrection` 打**同一份** status 回包 ⇒ 纯函数回 `null`、真实块**零叠键** —— `task_id / status / upstream_status / image_id / preview / charge` 一律不出现', {
    purePicked: null,
    added: '',
    keysAbsent: true
  }, {
    purePicked: fn.pickAiEnhanceReadouts('submitCorrection', opResult),
    added: picked ? picked.join(',') : null,
    keysAbsent: Boolean(response) && ['task_id', 'status', 'upstream_status', 'image_id', 'preview', 'charge'].every((key) => !hasKey(response, key))
  })
}

/* --------------------------------------------------------------------------- *
   W10 ⑩ list 正例：只透出 `rows`（逐字、行面不改写）
 * --------------------------------------------------------------------------- */
{
  const rows = [
    { task_id: 'aiet-0f24ace91b3d5701', status: 'READY', image_id: 'img-ready00000001', source_image_id: 'img-src000001', created_at: '2026-11-08T01:00:00.000Z', error_message: '' },
    { task_id: 'aiet-0f24ace91b3d5702', status: 'RUNNING', image_id: '', source_image_id: 'img-src000001', created_at: '2026-11-08T02:00:00.000Z', error_message: '' }
  ]
  const opResult = { ok: true, rows }
  const response = realWireResponse('ai-enhance-list', opResult)
  const picked = response ? addedKeysOf(response, baseResponse('ai-enhance-list')) : null
  const responseRowShapes = response && Array.isArray(response.rows)
    ? [...new Set(response.rows.map((row) => Object.keys(row).sort().join(',')))].sort()
    : null
  check('W10', '⑩ `ai-enhance-list`：真实穿透块**只透出 `rows` 一键**、`rows` 与 `opResult` **逐字相等**（行面恰六键、不改写、不补键）；服务端契约键面逐字 ＝ `LIST_SUCCESS_KEYS`、行面逐字 ＝ `LIST_ROW_KEYS`；`task_id` / `charge` 等不作为顶层键外泄', {
    contractKeys: 'ok,rows',
    contractRowKeys: 'created_at,error_message,image_id,source_image_id,status,task_id',
    picked: LIST_PICKED,
    rowsVerbatim: true,
    rowShapes: ['created_at,error_message,image_id,source_image_id,status,task_id'],
    topLevelAbsent: true,
    okUntouched: true
  }, {
    contractKeys: sortedKeys(tasks.LIST_SUCCESS_KEYS).join(','),
    contractRowKeys: sortedKeys(tasks.LIST_ROW_KEYS).join(','),
    picked,
    rowsVerbatim: Boolean(response) && deepEqual(response.rows, rows),
    rowShapes: responseRowShapes,
    topLevelAbsent: Boolean(response) && ['task_id', 'status', 'image_id', 'source_image_id', 'preview', 'charge', 'upstream_status', 'plan'].every((key) => !hasKey(response, key)),
    okUntouched: Boolean(response) && response.ok === true
  })
}

/* --------------------------------------------------------------------------- *
   W11 ⑪ list 负例：换 `submitCorrection` 打同一份回包 ⇒ `rows` 零出现
 * --------------------------------------------------------------------------- */
{
  const rows = [{ task_id: 'aiet-0f24ace91b3d5701', status: 'READY', image_id: 'img-ready00000001', source_image_id: 'img-src000001', created_at: '2026-11-08T01:00:00.000Z', error_message: '' }]
  const opResult = { ok: true, rows }
  const response = realWireResponse('submitCorrection', opResult)
  const picked = response ? addedKeysOf(response, baseResponse('submitCorrection')) : null
  check('W11', '⑪ 负例：拿 `submitCorrection` 打**同一份** list 回包 ⇒ 纯函数回 `null`、真实块**零叠键** —— `rows` 与一切任务键一律不出现', {
    purePicked: null,
    added: '',
    rowsAbsent: true
  }, {
    purePicked: fn.pickAiEnhanceReadouts('submitCorrection', opResult),
    added: picked ? picked.join(',') : null,
    rowsAbsent: Boolean(response) && !hasKey(response, 'rows')
  })
}

/* --------------------------------------------------------------------------- *
   W12 ⑫ 静态门：锚点在场 / 守卫逐字 / 白名单取自源码且不越契约 / 存在性驱动 /
          `rows` 只在 list 守卫下挂载 / 纯函数对三新 op 一律 null
 * --------------------------------------------------------------------------- */
{
  const block = wireBlockSource()
  const matched = block ? block.match(/const AI_ENHANCE_TASK_READOUT_KEYS = \[([^\]]*)\]/) : null
  const whitelist = matched
    ? matched[1]
        .split(',')
        .map((token) => token.trim().replace(/^'|'$/g, ''))
        .filter((token) => token !== '')
    : null
  const CONTRACT_UNION = ['task_id', 'status', 'source_image_id', 'image_id', 'preview', 'charge', 'upstream_status']
  const newOps = ['ai-enhance-submit', 'ai-enhance-status', 'ai-enhance-list']
  check('W12', '⑫ 静态门：穿透块**锚点在场**（本套能取出执行）；submit/status 守卫、list 守卫**各恰 1 处**；白名单**逐字取自源码**、**零契约外键**（`plan` / `row` / `refunded` / `ok` 不在内）且覆盖 submit 与 `READY` 两态契约键；**存在性驱动**（`hasOwnProperty`）；`rows` **只在 list 守卫下**挂载；纯函数对三新 op **一律回 `null`**（新透传只经按 op 守卫块）', {
    anchor: 1,
    guardSubmit: 1,
    guardList: 1,
    rowsAttach: 1,
    existenceDriven: true,
    whitelistInContract: true,
    whitelistCoversSubmit: true,
    whitelistCoversReady: true,
    pureNullForNewOps: true
  }, {
    anchor: block === null ? 0 : 1,
    guardSubmit: countIn(wireSource, "if (op === 'ai-enhance-submit' || op === 'ai-enhance-status')"),
    guardList: countIn(wireSource, "if (op === 'ai-enhance-list')"),
    rowsAttach: countIn(String(block), 'response.rows = opResult.rows'),
    existenceDriven: Boolean(block) && countIn(block, 'Object.prototype.hasOwnProperty.call(opResult, key)') >= 1,
    whitelistInContract: Boolean(whitelist) && whitelist.length > 0 && whitelist.every((key) => CONTRACT_UNION.indexOf(key) !== -1),
    whitelistCoversSubmit: Boolean(whitelist) && ['task_id', 'status', 'source_image_id', 'charge'].every((key) => whitelist.indexOf(key) !== -1),
    whitelistCoversReady: Boolean(whitelist) && ['task_id', 'status', 'image_id', 'preview', 'charge'].every((key) => whitelist.indexOf(key) !== -1),
    pureNullForNewOps: newOps.every(
      (op) =>
        fn.pickAiEnhanceReadouts(op, {
          ok: true,
          task_id: 't',
          status: 'READY',
          source_image_id: 's',
          image_id: 'i',
          preview: {},
          charge: {},
          upstream_status: 200,
          rows: []
        }) === null
    )
  })
}

/* ===========================================================================
   收尾
 * ========================================================================== */
console.log(
  JSON.stringify({
    summary: { total, passed, failed: total - passed },
    sections: sectionStats,
    failed_ids: failedIds,
    note: '离线自检：只 import index.js 的纯函数与常量 ＋ lib/aiEnhanceTasks.js 的键面常量，并对 index.js 的真实穿透块做源码级执行（零 SDK、零网络、零落盘）；不调用任何 op 实现。'
  })
)
process.exit(total === passed ? 0 : 1)
