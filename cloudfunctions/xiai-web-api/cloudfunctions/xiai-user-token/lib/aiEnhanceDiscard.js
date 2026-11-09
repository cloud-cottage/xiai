'use strict'
/**
 * 玺爱 · **管理员「弃候選圖」（`ai-enhance-discard`）唯一实现点**
 * ============================================================================ *
 * 职责（本单范围）：AI 修復候选图的**弃除**业务逻辑只在此落地 —— 载荷封闭键面 / 管理员门复核
 * / 影像行存在性与归属 / 印面引用保护 / 删行 / 内容寻址去重保护下的删对象 / 幂等回放；
 * `lib/ops.js` 只做**注册与薄委派**（不写第二套逻辑）。**与修復面（`lib/aiEnhance.js`）零交集**：
 * 本文件不读图源字节、不调上游、不计费、不退款（**零账本触点**）；两文件互不 require、互不改动。
 *
 * 硬口径（逐条；派单方冻结契约 ①〜⑨）：
 *  ① **载荷封闭恰一键** `image_id`（字符串）：未知键 ⇒ `INVALID_FIELD`；缺键 / trim 后为空 ⇒
 *     `MISSING_REQUIRED`；非字符串 ⇒ `INVALID_VALUE`。以上均在任何读写之前 ⇒ **零删行、零删对象**。
 *  ② **管理员门复用既有单点**（`ops.adminWhitelistDenial`；非管理员 ⇒ `FORBIDDEN` ＋ 零删行）。
 *  ③ **行存在性与归属**：按 `image_id` 读影像行（经 `ops.readRows` ＋ `ops.COLLECTIONS.images`；
 *     **本文件零集合名字面**）；无行且未弃过 ⇒ `INVALID_VALUE`；行在但 `source` 非 `ai_enhance` ⇒
 *     `FORBIDDEN`（文案「僅 AI 修復候選圖可弃」）—— 只有 AI 修復产物候选图可弃。
 *  ④ **印面引用保护**：任何印面行（经 `ops.readRows` ＋ `ops.COLLECTIONS.faces`）的
 *     `face_image_id` 或 `edge_image_ids` 命中该影像编号 ⇒ `INVALID_VALUE`（文案「已被印面引用，
 *     不可弃」）；**判定全部早于删行**。
 *  ⑤ **删行**：经 `ops.deleteRow` 删该影像行（文档 `_id` 优先、回落 `id`）。
 *  ⑥ **删对象（内容寻址去重保护）**：仅当同 `sha256` 在影像行集合中**再无其它行**时才经
 *     `ops.deleteArtifactObject` 删对象（对象键：行内 `storage_key` 合法则用之，否则按
 *     `sha256` ＋ `mime` 推导；行无合法摘要 ⇒ 只删行）；否则**只删行**。回包 `deleted_objects`
 *     恒为布尔（对象删除抛错 ⇒ 如实 `false`，**不谎报已删**）。
 *  ⑦ **回包封闭**：成功恰 3 键（`ok, image_id, deleted_objects`）；失败恰 3 键（`ok, reason,
 *     message`）—— **零 `refunded`**（本面零计费 ⇒ 零退款面；与修復面的 4 键失败回包不同）。
 *  ⑧ **幂等**：同一 `image_id` 重放 ⇒ 行已不存在 ⇒ **成功回放** `deleted_objects: false`
 *     （不报错、不重复删）；判定用**本实例内的弃除註记**（module 级 Set，读点
 *     `discardTombstoned`）—— 冷实例上重放会落回 `INVALID_VALUE`（**零写入、无害**；契约 ③ 的
 *     「无行 ⇒ `INVALID_VALUE`」在该情形照旧成立，不建墓碑行、不开新集合）。
 *  ⑨ **reason 零新增**（只用 `lib/config.js::REASONS` 既有冻结值）、**零新集合**（读走
 *     `ops.readRows`、删行走 `ops.deleteRow`、删对象走 `ops.deleteArtifactObject`）。
 *
 * 存储 / 读点纪律：本文件**零集合名字面、零取库句柄字面**（一切经 `lib/ops.js` 的既有导出与
 * 本单新增写点取得 ⇒ 集合名仍只活在 `ops.js`）；静态门由
 * `scripts/verify-ai-enhance-discard.mjs` 的 G 段机械断言。
 * ============================================================================ *
 */

const { REASONS } = require('./config.js')

/* --------------------------------------------------------------------------- *
  常量面（封闭；客户端一律不可改）
 * --------------------------------------------------------------------------- */

/** op 名（与 `lib/ops.js` 注册面逐字一致）。 */
const AI_ENHANCE_DISCARD_OP = 'ai-enhance-discard'

/** 可弃来源（＝ `lib/aiEnhance.js` 入册行的 `source` 值；其它来源一律 `FORBIDDEN`）。 */
const AI_ENHANCE_SOURCE = 'ai_enhance'

/** 载荷封闭键面（恰一键）。 */
const DISCARD_ALLOWED_KEYS = Object.freeze(['image_id'])

/** 成功回包键面（恰 3 键；`deleted_objects` 恒布尔）。 */
const AI_ENHANCE_DISCARD_SUCCESS_KEYS = Object.freeze(['ok', 'image_id', 'deleted_objects'])

/** 失败回包键面（恰 3 键；**零 `refunded`**）。 */
const AI_ENHANCE_DISCARD_FAILURE_KEYS = Object.freeze(['ok', 'reason', 'message'])

/** 摘要形态（64 位小写十六进制）。 */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** 对象键形态（内容寻址 `xiai/images/<摘要前两位>/<摘要>.<扩展名>`）—— **非集合名**：它是
 *  对象存储路径（校验行内 `storage_key` / 推导删对象键用），本文件不把它当集合用。 */
const IMAGE_OBJECT_KEY_PATTERN = /^xiai\/images\/[0-9a-f]{2}\/[0-9a-f]{64}\.(png|webp|jpg|jpeg)$/

/** `mime` ⇒ 对象键扩展名（AI 候选图产物族只有 png / webp；`image/jpeg` 兜底）。 */
const MIME_EXT = Object.freeze({ 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' })

/** 引用 / 去重读取上限（单次读取护栏；口径同 `migrateCodeNumbers` 的单次 1000 行上限）。 */
const IMAGE_REFERENCE_LIMIT = 64
const FACE_EDGE_SCAN_LIMIT = 1000

/* --------------------------------------------------------------------------- *
  幂等註记（本实例内；见文件头 ⑧ —— 零存储、零新集合）
 * --------------------------------------------------------------------------- */

const DISCARDED = new Set()

/** 记录一次已发生的弃除（删行成功后调用；**不写任何存储**）。 */
function noteDiscarded(imageId) {
  DISCARDED.add(imageId)
}

/**
 * 该影像编号是否在**本实例**被弃除过（幂等回放判定读点；诊断 / 自检用，**零 IO**）。
 * @param {string} imageId 影像编号
 * @returns {boolean}
 */
function discardTombstoned(imageId) {
  return DISCARDED.has(text(imageId))
}

/* --------------------------------------------------------------------------- *
  小工具
 * --------------------------------------------------------------------------- */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/** 失败回包（**恰 3 键**；**零 `refunded`** —— 本面零计费）。 */
function failure(reason, message) {
  return { ok: false, reason, message }
}

/** 成功回包（**恰 3 键**；`deleted_objects` 恒布尔 —— 服务端说了算）。 */
function success(imageId, deletedObjects) {
  return { ok: true, image_id: imageId, deleted_objects: deletedObjects === true }
}

/* --------------------------------------------------------------------------- *
  读点 / 写点（一律经 `lib/ops.js` 的导出；本文件零集合名字面、零取库句柄字面）
 * --------------------------------------------------------------------------- */

function opsModule() {
  /* 延迟 require：与 `lib/aiEnhance.js` 同法（打破加载环；离线自检不需要 SDK）。 */
  return require('./ops.js')
}

/** 读影像行（按 `id` 字段；无行 ⇒ `null`）。 */
async function readImageRow(imageId) {
  const ops = opsModule()
  const rows = await ops.readRows(ops.COLLECTIONS.images, { id: text(imageId) }, { limit: 1 })
  return rows.length > 0 ? rows[0] : null
}

/**
 * 印面引用保护：任一印面行的 `face_image_id` 或 `edge_image_ids` 命中该影像编号 ⇒ `true`。
 * 两读：① `face_image_id` 等值检索（精确）；② `kind: 'EDGE'` 行扫描 `edge_image_ids`（数组
 * 包含无法用等值条件表达 ⇒ 读回后在码内逐个比对；单次限量护栏在场）。
 */
async function referencedByFace(imageId) {
  const ops = opsModule()
  const id = text(imageId)
  const byFaceImage = await ops.readRows(ops.COLLECTIONS.faces, { face_image_id: id }, { limit: IMAGE_REFERENCE_LIMIT })
  if (byFaceImage.length > 0) return true
  const edgeRows = await ops.readRows(ops.COLLECTIONS.faces, { kind: 'EDGE' }, { limit: FACE_EDGE_SCAN_LIMIT })
  return edgeRows.some(
    (row) => Array.isArray(row && row.edge_image_ids) && row.edge_image_ids.some((edgeId) => text(edgeId) === id)
  )
}

/** 同摘要去重保护：除 `excludeDocId` 外是否仍有其它行共享该摘要（按行内原值等值检索）。 */
async function digestSharedByOtherRow(rawDigest, excludeDocId) {
  const ops = opsModule()
  const rows = await ops.readRows(ops.COLLECTIONS.images, { sha256: rawDigest }, { limit: IMAGE_REFERENCE_LIMIT })
  return rows.some((row) => text(row && (row._id || row.id)) !== excludeDocId)
}

/** 对象键：行内 `storage_key` 合法则用之；否则按 `sha256` ＋ `mime` 推导；推不出 ⇒ `''`（只删行）。 */
function objectKeyOf(row, digest) {
  const declared = text(row && row.storage_key)
  if (IMAGE_OBJECT_KEY_PATTERN.test(declared)) return declared
  const ext = MIME_EXT[text(row && row.mime)]
  if (!ext) return ''
  const derived = `xiai/images/${digest.slice(0, 2)}/${digest}.${ext}`
  return IMAGE_OBJECT_KEY_PATTERN.test(derived) ? derived : ''
}

/* --------------------------------------------------------------------------- *
  主流程
 * --------------------------------------------------------------------------- */

/**
 * **弃一张 AI 修復候选图**（管理员面；**零计费**；服务端裁决）。
 * 顺序（**判定全部早于删行 / 删对象**）：① 载荷封闭一键 → ② 管理员门 → ③ 行存在性（幂等
 * 回放预查）→ ④ 归属（仅 `ai_enhance`）→ ⑤ 印面引用保护 → ⑥ 删行 → ⑦ 去重保护下删对象
 * → ⑧ 幂等註记 ＋ 成功回包恰 3 键。
 * @param {object} payload 载荷（封闭一键 `image_id`）
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<object>} 成功恰 3 键 / 失败恰 3 键（**零 `refunded`**）
 */
async function discardCandidate(payload, identity, context) {
  /* ① 载荷形态（早于一切读写）。 */
  if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return failure(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零刪行、零刪對象。')
  }
  /* ② 封闭键面（未知键 ⇒ `INVALID_FIELD`；金额 / 判定一律由服务端给定）。 */
  const unknown = Object.keys(payload).filter((key) => DISCARD_ALLOWED_KEYS.indexOf(key) === -1)
  if (unknown.length > 0) {
    return failure(
      REASONS.INVALID_FIELD,
      `載荷含未知欄位：${unknown.join('、')}（弃候選圖入參封閉一鍵：image_id）；本次零刪行、零刪對象。`
    )
  }
  /* ③ `image_id` 值域（缺 / 空 ⇒ `MISSING_REQUIRED`；非字符串 ⇒ `INVALID_VALUE`）。 */
  if (!Object.prototype.hasOwnProperty.call(payload, 'image_id') || text(payload.image_id) === '') {
    return failure(REASONS.MISSING_REQUIRED, '弃候選圖需要影像編號（image_id）；本次零刪行、零刪對象。')
  }
  if (typeof payload.image_id !== 'string') {
    return failure(REASONS.INVALID_VALUE, '影像編號（image_id）必須是字符串；本次零刪行、零刪對象。')
  }
  const imageId = text(payload.image_id)

  /* ④ 管理员门（复用既有单点；非管理员 / 缺 env ⇒ 结构化拒绝 ＋ 零删行）。 */
  const ops = opsModule()
  const denial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (denial) return failure(denial.reason, denial.message)

  /* ⑤ 行存在性（幂等回放：本实例弃过 ⇒ 成功回放；无行且未弃过 ⇒ `INVALID_VALUE`）。 */
  const row = await readImageRow(imageId)
  if (!row) {
    if (discardTombstoned(imageId)) return success(imageId, false)
    return failure(REASONS.INVALID_VALUE, '影像編號（image_id）在影像行中不存在；本次零刪行、零刪對象。')
  }

  /* ⑥ 归属：只弃 AI 修復候选图（其它来源 ⇒ `FORBIDDEN`，文案说清「僅 AI 修復候選圖可弃」）。 */
  if (text(row.source) !== AI_ENHANCE_SOURCE) {
    return failure(
      REASONS.FORBIDDEN,
      `僅 AI 修復候選圖可弃（該影像行的 source＝「${text(row.source) || '（空）'}」，非 ai_enhance）；本次零刪行、零刪對象。`
    )
  }

  /* ⑦ 印面引用保护（`face_image_id` / `edge_image_ids` 任一命中 ⇒ 拒；零删行）。 */
  if (await referencedByFace(imageId)) {
    return failure(
      REASONS.INVALID_VALUE,
      '該影像已被印面引用，不可弃（任何印面行的 face_image_id / edge_image_ids 命中本編號）；本次零刪行、零刪對象。'
    )
  }

  /* ⑧ 删行（文档 `_id` 优先、回落 `image_id` —— 修復面入册行两值同字）。 */
  const docId = text(row._id) || imageId
  await ops.deleteRow(ops.COLLECTIONS.images, docId)

  /* ⑨ 删对象（内容寻址去重保护：同摘要仍有其它行 ⇒ 只删行；对象删除抛错 ⇒ 如实 `false`）。 */
  let deletedObjects = false
  const rawDigest = text(row.sha256)
  const digest = rawDigest.toLowerCase()
  if (DIGEST_PATTERN.test(digest)) {
    const shared = await digestSharedByOtherRow(rawDigest, docId)
    const objectKey = objectKeyOf(row, digest)
    if (!shared && objectKey) {
      try {
        await ops.deleteArtifactObject(objectKey)
        deletedObjects = true
      } catch {
        deletedObjects = false
      }
    }
  }

  /* ⑩ 幂等註记 ＋ 成功回包（恰 3 键）。 */
  noteDiscarded(imageId)
  return success(imageId, deletedObjects)
}

module.exports = {
  AI_ENHANCE_DISCARD_OP,
  AI_ENHANCE_SOURCE,
  DISCARD_ALLOWED_KEYS,
  AI_ENHANCE_DISCARD_SUCCESS_KEYS,
  AI_ENHANCE_DISCARD_FAILURE_KEYS,
  IMAGE_OBJECT_KEY_PATTERN,
  discardTombstoned,
  discardCandidate
}
