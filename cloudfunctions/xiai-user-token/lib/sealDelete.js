'use strict'
/**
 * 玺爱 · **管理員「刪除印章 ＋ 編號釋放」（`deleteSeal`）唯一实现点**
 * ============================================================================
 * 职责（本单范围）：删印业务逻辑只在此落地 —— 载荷封闭键面 / 管理员门 / 印章行三形态检索
 * / 印面与影像引用汇总 / **共用影像保护** / 删行确定序 / 管理员审计行 / **編號釋放**；
 * `lib/ops.js` 只做**注册与薄委派**（零第二套逻辑）。
 *
 * 硬口径（逐条；派单方冻结契约）：
 *  ① **管理员门在任何读之前**（`ops.adminWhitelistDenial`；非管理员 / 缺白名单 env ⇒
 *     结构化拒绝 ＋ **零写入**）。
 *  ② **载荷封闭键面 `['seal_id', 'reason']`**：未知键（含任何身份类键）⇒ `INVALID_FIELD`；
 *     `seal_id` 缺 / 空 ⇒ `MISSING_REQUIRED`、非字符串 ⇒ `INVALID_VALUE`；
 *     `reason` 非字符串或长度 > 200 ⇒ `INVALID_VALUE`。以上均早于任何读写 ⇒ **零写入**。
 *  ③ **印章行检索（三形态依次）**：`seal_id` 可接 `stamp_id` / `sid` / 行 `id` 任一形态，
 *     按序三读；无行 ⇒ `INVALID_VALUE`（文案含「未找到該印章」＋「本次零寫入」）＋**零写入**。
 *  ④ **共用影像保护**：本印引用的影像（`face_image_id` ＋ `edge_image_ids[]`）若仍被
 *     **其它印面**引用 ⇒ **保留不删**，计入 `skipped.images_shared`。
 *  ⑤ **删行确定序**（先后即契约）：① 非共用影像行（＋尽量删对象）→ ② 本印全部印面行
 *     → ③ 印章行 → ④ 管理员审计行（`ops.persist` 的 `kind:'add'`）→ ⑤ **最后一步**
 *     把该印 `seal_no` 与全部 `face_no` 并入计数器集合对应文档的 `released`
 *     （`kind:'set'`；**doc 不带 `_id`**；`released` 去重、升序）。
 *  ⑥ **对象删除受内容寻址去重保护**：同摘要在影像行中**尚有其它行** ⇒ 只删行；
 *     删对象失败 ⇒ **不阻断**，计入 `deleted.objects_failed`（**如实计数，不谎报已删**）。
 *  ⑦ **回包**：成功**恰 4 键**（`ok, deleted, skipped, released`）；失败**恰 3 键**
 *     （`ok, reason, message`）；`reason` **零新增**（只用 `lib/config.js::REASONS` 既有冻结值）。
 *  ⑧ **零新集合、零删照片行、零删勘误行**：照片 / 勘误**只读计数**（`photos_kept` /
 *     `corrections_kept`）；读走 `ops.readRows`、删行走 `ops.deleteRow`、
 *     删对象走 `ops.deleteArtifactObject`、落盘走 `ops.persist`。
 *  ⑨ **審計載體 preflight（本單新增）**：**任何删行之前**先
 *     `await ops.ensureCollection(ops.COLLECTIONS.adminAudit)`（建集只在 `ops.js` 内做；
 *     **不新造集合名** —— 名称仍只活在 `ops.js::COLLECTIONS`，规范在册 §3.33.3 第 14 項 /
 *     AC-373）。抛错 ⇒ **直接 `STORAGE_UNAVAILABLE` ＋ 零写入**（此时尚未删任何行）；
 *     成功（`created` / `exists`）才继续删行确定序 —— **「審計載體沒有 ⇒ 就不刪」**。
 *
 * 存储纪律：本文件**零集合名字面、零取库句柄字面**（一切读写经 `lib/ops.js` 的既有导出；
 * 集合名只活在 `ops.js` 的 `COLLECTIONS` 登记表与 `COUNTERS_COLLECTION` 导出面）；
 * **所有字符串一律繁體**。
 * ============================================================================ *
 */

const { REASONS } = require('./config.js')

/* --------------------------------------------------------------------------- *
  常量面（封闭；客户端一律不可改）
 * --------------------------------------------------------------------------- */

/** op 名（与 `lib/ops.js` 注册面逐字一致）。 */
const SEAL_DELETE_OP = 'deleteSeal'

/** 载荷封闭键面（恰两键；未知 / 身份类键 ⇒ `INVALID_FIELD`）。 */
const SEAL_DELETE_ALLOWED_KEYS = Object.freeze(['seal_id', 'reason'])

/** `reason` 长度上限（上屏面同值 200）。 */
const SEAL_DELETE_REASON_MAX_LENGTH = 200

/** 成功回包键面（恰 4 键）。 */
const SEAL_DELETE_SUCCESS_KEYS = Object.freeze(['ok', 'deleted', 'skipped', 'released'])

/** 失败回包键面（恰 3 键；**零 `refunded`** —— 本面零计费）。 */
const SEAL_DELETE_FAILURE_KEYS = Object.freeze(['ok', 'reason', 'message'])

/** 印章行三形态检索的单次读取上限（形如「命中即取首行」的窄读）。 */
const SEAL_ROW_SCAN_LIMIT = 8

/** 引用面 / 全量印面扫描护栏（单次读取上限；口径同仓内既有 1000 行护栏）。 */
const REFERENCE_SCAN_LIMIT = 1000

/** 同摘要去重扫描护栏（口径同候選圖弃除面）。 */
const IMAGE_REFERENCE_LIMIT = 64

/** 摘要形态（64 位小写十六进制）。 */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** 对象键形态（内容寻址 `xiai/images/<摘要前两位>/<摘要>.<扩展名>`）—— **非集合名**：
 *  它是对象存储路径（校验行内 `storage_key` / 推导删对象键用）。 */
const IMAGE_OBJECT_KEY_PATTERN = /^xiai\/images\/[0-9a-f]{2}\/[0-9a-f]{64}\.(png|webp|jpg|jpeg)$/

/** `mime` ⇒ 对象键扩展名（印面族产物 png / webp；`image/jpeg` 兜底）。 */
const MIME_EXT = Object.freeze({ 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' })

/* --------------------------------------------------------------------------- *
  小工具（纯函数；零 IO）
 * --------------------------------------------------------------------------- */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/** 失败回包（**恰 3 键**）。 */
function failure(reason, message) {
  return { ok: false, reason, message }
}

/** 行的文档标识（`_id` 优先、回落行内 `id`）。 */
function rowKeyOf(row) {
  return text(row && (row._id || row.id))
}

/** 去重保序的非空字符串表（检索键归一）。 */
function uniqueTexts(values) {
  const out = []
  values.forEach((value) => {
    const item = text(value)
    if (item !== '' && out.indexOf(item) === -1) out.push(item)
  })
  return out
}

/** 非负整数归一（`NaN` / 小数 / 负数 ⇒ `null`）。 */
function positiveIntOf(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 服务端时间（`context.nowSeconds` 优先；缺省取本机时钟，与其它管理员面同口径）。 */
function nowIso(context) {
  const seconds = context && context.nowSeconds !== undefined ? Number(context.nowSeconds) : NaN
  const date = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date()
  return date.toISOString()
}

/**
 * 成功回包（**恰 4 键**：`ok, deleted, skipped, released`）。
 *
 * 另以**不可枚举**别名 `value` 承载同三组读数 —— 为什么：`index.js` 的成功信封只按
 * **按 op 收窄的白名单**叠键，而本单**不改 `index.js`**（纪律：只动注册面与实现面）；
 * `response.value` 是信封的**通用读数位**（`setInviteReward` 同位）。不可枚举 ⇒
 * `Object.keys` / `JSON.stringify(本回包)` 仍**只见恰 4 键**（回包键面契约不破），
 * 云上仍能经既有 `value` 位把三组读数带到前端（前端零补编、零派生）。
 */
function success(deleted, skipped, released) {
  const result = { ok: true, deleted, skipped, released }
  Object.defineProperty(result, 'value', { value: { deleted, skipped, released }, enumerable: false })
  return result
}

/* --------------------------------------------------------------------------- *
  读点（一律经 `lib/ops.js` 的导出；零集合名字面、零取库句柄字面）
 * --------------------------------------------------------------------------- */

function opsModule() {
  /* 延迟 require：与 `lib/aiEnhanceDiscard.js` 同法（打破加载环；离线自检不需要 SDK）。 */
  return require('./ops.js')
}

/**
 * 按「字段族 × 检索键族」取回**去重后**的引用行（印章 / 照片 / 勘误三面共用同一读法，
 * **不另造第二套**）。任一读抛错 ⇒ 原样上抛（由 `index.js` 转 `STORAGE_UNAVAILABLE`，
 * **绝不吞成「零行」**）。
 * @param {object} ops `lib/ops.js` 模块
 * @param {string} collection 集合名（调用方一律经 `ops.COLLECTIONS` 取值）
 * @param {string[]} fields 检索字段族（兼容规范键与既落盘别名）
 * @param {string[]} keys 检索键族（该印的 `sid` / `stamp_id` / 行 `id` / 入参）
 * @param {number} limit 单次读取上限
 * @returns {Promise<object[]>} 去重后的行表
 */
async function rowsReferencing(ops, collection, fields, keys, limit) {
  const seen = new Map()
  for (let k = 0; k < keys.length; k += 1) {
    for (let f = 0; f < fields.length; f += 1) {
      const rows = await ops.readRows(collection, { [fields[f]]: keys[k] }, { limit })
      rows.forEach((row) => {
        const key = rowKeyOf(row) || `anon-${seen.size}`
        if (!seen.has(key)) seen.set(key, row)
      })
    }
  }
  return Array.from(seen.values())
}

/** 对象键：行内 `storage_key` 合法则用之；否则按 `sha256` ＋ `mime` 推导；推不出 ⇒ `''`。 */
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
 * **刪一枚印章（＋編號釋放）**（管理员面；服务端裁决）。
 * 顺序（**判定全部早于删行**）：① 载荷形态 → ② 封闭键面 → ③ 管理员门（任何读之前）
 * → ④ `seal_id` / `reason` 值域 → ⑤ 印章行三形态检索 → ⑥ 引用汇总（印面 / 影像 / 共用判定
 * / 照片与勘误只读计数 / 计数器读）→ ⑥⁺ **審計載體 preflight**（`ops.ensureCollection`；
 * **任何删行之前**；失败 ⇒ `STORAGE_UNAVAILABLE` ＋ 零写入）
 * → ⑦ 删非共用影像行 ＋ 删对象 → ⑧ 删全部印面行
 * → ⑨ 删印章行 → ⑩ 审计行 → ⑪ **編號釋放**（最后一步）→ ⑫ 成功回包恰 4 键。
 * @param {object} payload 载荷（封闭两键 `seal_id` / `reason`）
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<object>} 成功恰 4 键 / 失败恰 3 键
 */
async function deleteSeal(payload, identity, context) {
  const ops = opsModule()

  /* ① 载荷形态（早于一切读写）。 */
  if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return failure(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
  }

  /* ② 封闭键面（未知键 / 身份类键 ⇒ `INVALID_FIELD`；**零写入**）。 */
  const unknown = Object.keys(payload).filter((key) => SEAL_DELETE_ALLOWED_KEYS.indexOf(key) === -1)
  if (unknown.length > 0) {
    return failure(
      REASONS.INVALID_FIELD,
      `載荷含未知欄位：${unknown.join('、')}（刪除印章入參封閉兩鍵：seal_id / reason）；本次零寫入。`
    )
  }

  /* ③ 管理员门（**任何读之前**；非管理员 / 缺白名单 env ⇒ 结构化拒绝 ＋ 零写入）。 */
  const denial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (denial) return failure(denial.reason, denial.message)

  /* ④ `seal_id` 值域（缺 / 空 ⇒ `MISSING_REQUIRED`；非字符串 ⇒ `INVALID_VALUE`）。 */
  if (!Object.prototype.hasOwnProperty.call(payload, 'seal_id') || text(payload.seal_id) === '') {
    return failure(REASONS.MISSING_REQUIRED, '刪除印章需要印章編號（seal_id）；本次零寫入。')
  }
  if (typeof payload.seal_id !== 'string') {
    return failure(REASONS.INVALID_VALUE, '印章編號（seal_id）必須是字符串；本次零寫入。')
  }
  const sealId = text(payload.seal_id)

  /* ⑤ `reason`（**可选**；非字符串 / 超长 ⇒ `INVALID_VALUE`；**零新增 reason 字面值**）。 */
  const reasonRaw = payload.reason === undefined || payload.reason === null ? '' : payload.reason
  if (typeof reasonRaw !== 'string') {
    return failure(REASONS.INVALID_VALUE, '刪除理由（reason）必須是字符串；本次零寫入。')
  }
  const reason = text(reasonRaw)
  if (reason.length > SEAL_DELETE_REASON_MAX_LENGTH) {
    return failure(
      REASONS.INVALID_VALUE,
      `刪除理由（reason）最多 ${SEAL_DELETE_REASON_MAX_LENGTH} 字；本次零寫入。`
    )
  }

  /* ⑥ 印章行检索（`stamp_id` → `sid` → 行 `id` 三形态依次；无行 ⇒ `INVALID_VALUE` ＋ 零写入）。 */
  const sealProbeKeys = ['stamp_id', 'sid', 'id']
  let sealRow = null
  for (let index = 0; index < sealProbeKeys.length && sealRow === null; index += 1) {
    const rows = await ops.readRows(
      ops.COLLECTIONS.seals,
      { [sealProbeKeys[index]]: sealId },
      { limit: SEAL_ROW_SCAN_LIMIT }
    )
    if (rows.length > 0) sealRow = rows[0]
  }
  if (sealRow === null) {
    return failure(REASONS.INVALID_VALUE, `未找到該印章（seal_id：${sealId}）；本次零寫入。`)
  }

  /* ⑦ 引用键族（该印的 `sid` / `stamp_id` / 行 `id` ＋ 入参；去重保序）。 */
  const stampId = text(sealRow.stamp_id) || text(sealRow.id) || sealId
  const referenceKeys = uniqueTexts([text(sealRow.sid), stampId, text(sealRow.id), sealId])
  const at = nowIso(context)

  /* ⑧ **只读**汇总（全部早于任何删行）：印面 / 照片计数 / 勘误计数 / 全量印面（共用判定）/
     影像行 / 计数器（編號釋放的落点）。任一读失败 ⇒ 原样上抛 ⇒ 零写入。 */
  const ownFaces = await rowsReferencing(
    ops,
    ops.COLLECTIONS.faces,
    ['sealId', 'stamp_id'],
    referenceKeys,
    REFERENCE_SCAN_LIMIT
  )
  const photoRows = await rowsReferencing(
    ops,
    ops.COLLECTIONS.photos,
    ['sealId', 'stamp_id'],
    referenceKeys,
    REFERENCE_SCAN_LIMIT
  )
  const correctionRows = await rowsReferencing(
    ops,
    ops.COLLECTIONS.corrections,
    ['sealId', 'stamp_id'],
    referenceKeys,
    REFERENCE_SCAN_LIMIT
  )
  const allFaces = await ops.readRows(ops.COLLECTIONS.faces, {}, { limit: REFERENCE_SCAN_LIMIT })
  const ownRowIds = new Set(ownFaces.map(rowKeyOf).filter((id) => id !== ''))
  const otherFaces = allFaces.filter((row) => {
    const rowId = rowKeyOf(row)
    if (rowId !== '' && ownRowIds.has(rowId)) return false
    return !referenceKeys.some(
      (key) => text(row && row.sealId) === key || text(row && row.stamp_id) === key
    )
  })

  /* 影像引用面（本印全部印面的 `face_image_id` ＋ `edge_image_ids[]`，去重保序）。 */
  const imageIds = []
  const pushImageId = (value) => {
    const id = text(value)
    if (id !== '' && imageIds.indexOf(id) === -1) imageIds.push(id)
  }
  ownFaces.forEach((row) => {
    pushImageId(row && row.face_image_id)
    const edges = Array.isArray(row && row.edge_image_ids) ? row.edge_image_ids : []
    edges.forEach(pushImageId)
  })

  /* 影像行逐个读（无行 ⇒ 无行可删；不计入任何删数 —— **不编造读数**）。 */
  const imageRows = new Map()
  for (let index = 0; index < imageIds.length; index += 1) {
    const rows = await ops.readRows(ops.COLLECTIONS.images, { id: imageIds[index] }, { limit: 1 })
    if (rows.length > 0) imageRows.set(imageIds[index], rows[0])
  }

  /* **共用判定**：影像 id 出现在**其它印面行**（`face_image_id` / `edge_image_ids`）⇒ 保留。 */
  const sharedIds = imageIds.filter((imageId) =>
    otherFaces.some(
      (row) =>
        text(row && row.face_image_id) === imageId ||
        (Array.isArray(row && row.edge_image_ids) &&
          row.edge_image_ids.some((edgeId) => text(edgeId) === imageId))
    )
  )

  /* 編號釋放面：该印 `seal_no` ＋ 本印全部 `face_no`（去重升序在 `normalizeReleased` 单点）。 */
  const sealNo = positiveIntOf(sealRow.seal_no)
  const faceNos = ownFaces
    .map((row) => positiveIntOf(row && row.face_no))
    .filter((no) => no !== null)
  const released = {
    seal_no: sealNo,
    face_nos: ops.normalizeReleased(faceNos)
  }
  /* 计数器**预读（fail-fast）**：此时**尚未删任何行** ⇒ 读失败 ⇒ 整笔零写入
     （`index.js` 转 `STORAGE_UNAVAILABLE` 时「本次零寫入」为真）。
     **组稿不在这里**：`kind:'set'` 是**整文档覆盖** ⇒ 必须用**当时最新**的 `seq` / `released`
     组稿，否则会把并发中的发号自增 / 释放号认领**回滚** ⇒ 造出重号（AC §6.4 红线）。
     真正的落盘文档在删行之后（⑪）**再读一次**再组。 */
  const counterSpecs = [
    { kind: 'seal', nos: sealNo === null ? [] : [sealNo] },
    { kind: 'face', nos: released.face_nos }
  ]
  for (let index = 0; index < counterSpecs.length; index += 1) {
    if (counterSpecs[index].nos.length === 0) continue
    await ops.readRows(ops.COUNTERS_COLLECTION, { _id: ops.COUNTER_IDS[counterSpecs[index].kind] }, { limit: 1 })
  }

  /* ⑧-後 **審計載體 preflight（本單新增）**：`ops.COLLECTIONS.adminAudit` 是 ⑩ 审计行
     （`kind:'add'`）的落点 —— 集合不在库 ⇒ 该步必失败 ⇒ `persist` 整批原子回滚（生产真因：
     规范在册、注册在册、**库里从未建过** ⇒ 管理员点「確認刪除」恒零写入、功能死锁）。
     故在**管理员门（③）之后、任何删行（⑨-①）之前**先确保集合存在：
     `ops.ensureCollection`（`createCollection`；已存在 ⇒ 视作成功、不重复建）。
     · 抛错 ⇒ **直接 `STORAGE_UNAVAILABLE` 失败**（此时尚未删除任何行 ⇒ 恰 3 键、零写入）；
     · 成功（`created` / `exists`）才继续下面的删行确定序 —— **「審計載體沒有 ⇒ 就不刪」**，
       绝不出现「删了但审计落不下」。 */
  try {
    await ops.ensureCollection(ops.COLLECTIONS.adminAudit)
  } catch {
    return failure(
      REASONS.STORAGE_UNAVAILABLE,
      `管理員審計集合（${ops.COLLECTIONS.adminAudit}）不可用 ⇒ 拒絕刪除印章；本次尚未刪除任何行、零寫入。`
    )
  }

  /* ⑨ 计数器（读）已毕 ⇒ 进入写面。删行确定序见文件头 ⑤。 */
  const deleted = { faces: 0, images: 0, objects: 0, objects_failed: 0 }
  const skipped = {
    images_shared: 0,
    photos_kept: photoRows.length,
    corrections_kept: correctionRows.length
  }

  /* ⑨-① 非共用影像行 ＋ 尽量删对象（**共用者保留**；删对象失败不阻断、如实计数）。 */
  for (let index = 0; index < imageIds.length; index += 1) {
    const imageId = imageIds[index]
    if (sharedIds.indexOf(imageId) !== -1) {
      skipped.images_shared += 1
      continue
    }
    const row = imageRows.get(imageId)
    if (!row) continue
    const docId = rowKeyOf(row) || imageId
    await ops.deleteRow(ops.COLLECTIONS.images, docId)
    deleted.images += 1
    const rawDigest = text(row.sha256)
    const digest = rawDigest.toLowerCase()
    if (DIGEST_PATTERN.test(digest)) {
      /* 内容寻址去重保护：本行删后再读同摘要，**尚有其它行 ⇒ 只删行**（对象与他行原封）。 */
      const others = await ops.readRows(
        ops.COLLECTIONS.images,
        { sha256: rawDigest },
        { limit: IMAGE_REFERENCE_LIMIT }
      )
      const stillShared = others.some((other) => rowKeyOf(other) !== docId)
      const objectKey = objectKeyOf(row, digest)
      if (!stillShared && objectKey) {
        try {
          await ops.deleteArtifactObject(objectKey)
          deleted.objects += 1
        } catch {
          deleted.objects_failed += 1
        }
      }
    }
  }

  /* ⑨-② 本印全部印面行。 */
  for (let index = 0; index < ownFaces.length; index += 1) {
    const docId = rowKeyOf(ownFaces[index])
    if (docId === '') continue
    await ops.deleteRow(ops.COLLECTIONS.faces, docId)
    deleted.faces += 1
  }

  /* ⑨-③ **最后**删印章行（照片行 / 勘误行一律保留：零删行）。 */
  await ops.deleteRow(ops.COLLECTIONS.seals, rowKeyOf(sealRow) || sealId)

  /* ⑩ 审计行（`kind:'add'`，封闭键面）＋ ⑪ **編號釋放**（`kind:'set'`，doc 不带 `_id`）——
     两步同交 `ops.persist` 按序执行 ⇒ 「釋放」恒为**最后一步**。
     **⑪ 组稿在删行之后**（与 `ops.js` 播种注释「删印后补建」逐字同口径）：每个号别**再读一次**
     当前文档 ——
     · 文档在 ⇒ `set` 整文档覆盖 ⇒ **必须带上最新 `seq`**（否则把并发发号自增回滚 ⇒ 重号）；
     · 文档不在 ⇒ **补建**：`seq` 播种单点 `counterSeedBaseOf`（与发号器同一份实现）；
     · `released` ＝ 现名单 ∪ 本次釋放号，**去重升序**（归一单点 `normalizeReleased`）。 */
  const counterWrites = []
  for (let index = 0; index < counterSpecs.length; index += 1) {
    const spec = counterSpecs[index]
    if (spec.nos.length === 0) continue
    const counterId = ops.COUNTER_IDS[spec.kind]
    const rows = await ops.readRows(ops.COUNTERS_COLLECTION, { _id: counterId }, { limit: 1 })
    const current = rows.length > 0 ? ops.normalizeReleased(rows[0].released) : []
    const doc = { released: ops.normalizeReleased(current.concat(spec.nos)), updated_at: at }
    const seqNow = rows.length > 0 ? Number(rows[0].seq) : NaN
    if (rows.length > 0 && Number.isInteger(seqNow) && seqNow >= 0) {
      doc.seq = seqNow
    } else {
      doc.seq = await ops.counterSeedBaseOf(spec.kind)
    }
    counterWrites.push({ kind: 'set', collection: ops.COUNTERS_COLLECTION, id: counterId, doc })
  }

  const auditDoc = {
    op: SEAL_DELETE_OP,
    actor_uid: text(identity && identity.uid),
    at,
    seal_snapshot: {
      stamp_id: stampId,
      sid: text(sealRow.sid) || stampId,
      seal_no: sealNo,
      seal_name: text(sealRow.seal_name) || text(sealRow.name),
      dynasty: text(sealRow.dynasty) || text(ownFaces[0] && ownFaces[0].dynasty),
      seal_class: text(sealRow.seal_class) || text(ownFaces[0] && ownFaces[0].seal_class)
    },
    deleted,
    skipped,
    released,
    reason
  }
  await ops.persist({
    writes: [{ kind: 'add', collection: ops.COLLECTIONS.adminAudit, doc: auditDoc }].concat(counterWrites)
  })

  return success(deleted, skipped, released)
}

module.exports = {
  SEAL_DELETE_OP,
  SEAL_DELETE_ALLOWED_KEYS,
  SEAL_DELETE_REASON_MAX_LENGTH,
  SEAL_DELETE_SUCCESS_KEYS,
  SEAL_DELETE_FAILURE_KEYS,
  DIGEST_PATTERN,
  IMAGE_OBJECT_KEY_PATTERN,
  deleteSeal
}
