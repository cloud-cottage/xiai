/**
 * 玺爱 · **自检：AI 修復讀數面穿透（index.js additive 透传线）**（本单新增）
 * ============================================================================
 * **本地、离线**（零网络、零云端连接、零生产数据；不调用任何 op 实现、不落盘）。被测件：
 *   · `cloudfunctions/xiai-user-token/index.js` 的纯函数 `pickAiEnhanceReadouts(op, opResult)`
 *     ＋ 白名单常量 `AI_ENHANCE_READOUT_KEYS`（两者均自 index.js 直接 import）。
 *
 * 背景（§3.68 讀數面）：`lib/aiEnhance.js`（`ai-enhance-face`）成功回包恰 8 键、
 * `lib/aiEnhanceDiscard.js`（`ai-enhance-discard`）成功回包恰 3 键 —— 键名真源在那两个 lib；
 * 但 `index.js` 组装 success response 时用**固定白名单**（ok / op / row / projection / summary /
 * value / artifact / display / docId / …）⇒ 读数键全被丢掉 ⇒ 客户端拿不到 `image_id`。
 * 本套钉住穿透面：**存在性驱动、按 op 收窄、逐字透传**。
 *
 * 断言面（本套 **4** 条 —— 覆盖派单方点名的 ①〜④）：
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
 *
 * 纪律：断言失败 ⇒ 退出码 1；零密钥、零令牌原文、零生产数据。
 */
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

/* ===========================================================================
   收尾
 * ========================================================================== */
console.log(
  JSON.stringify({
    summary: { total, passed, failed: total - passed },
    sections: sectionStats,
    failed_ids: failedIds,
    note: '离线自检：只 import index.js 的纯函数与常量（零 SDK、零网络、零落盘）；不调用任何 op 实现。'
  })
)
process.exit(total === passed ? 0 : 1)
