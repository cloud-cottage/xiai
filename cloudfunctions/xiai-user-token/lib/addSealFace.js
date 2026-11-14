'use strict'
/**
 * 玺爱 · **印章详情页「新增印面」面（管理员 op `addSealFace`）**
 * ============================================================================
 * 口径真源：`docs/add-seal-face-ruling-2026-11-14.md` §3（Kevin 2026-11-14 选 A 方案）。
 * 场景：详情页每个印面块只有「編輯固定屬性 / 重新上傳印面圖 / 人工智能修復」三个管理员入口，
 * **没有任何建面入口** ⇒ 一枚章永远只有上传时带的那一面。本 op 就是「给已有印章新增 FACE / EDGE 面」
 * 的那一口（**只建面行 ＋ 维护章行 `face_count`**，不建章、不发印章号、不写流水、不计费）。
 *
 * 硬口径（逐条，与裁定件逐字对齐）：
 *  ① **管理员面**：`adminWhitelistDenial` 门**第一行**即判（缺 env / 非白名单 ⇒ 结构化拒 ＋
 *     **零读零写**）。
 *  ② **载荷封闭恰 7 键** `ADD_SEAL_FACE_ALLOWED_KEYS`：`stamp_id` / `kind` / `sha256` / `bytes` /
 *     `mime` / `storage_key` / `seal_name`；未知键与身份类键 ⇒ `INVALID_FIELD`（**既有冻结 reason，
 *     零新增**）。
 *  ③ **值域门**（全部纯判定、早于任何读）：`stamp_id` trim 非空且 ≤ 64；`kind` 缺省 `FACE`、只接受
 *     `FACE` / `EDGE`（给出即不静默归一）；影像四道形态门**与 `registerFaceImage` 同一张表、
 *     同一条文案** —— 摘要 64 位小写十六进制 → 对象键形态 `xiai/images/<摘要前两位>/<摘要>.tiff`
 *     → 键内摘要 ≡ 声称摘要 → `bytes` ∈ 1〜`ARTIFACT_MAX_BYTES` 整数 → `mime` ＝ 服务端存储容器常量
 *     `ARTIFACT_MIME`。任一不符 ⇒ `INVALID_VALUE` ＋ **零写入**。
 *  ④ **影像必须已入册**：`sha256` 对应的 `xiai_images` 行必须已存在（前端先调 `registerFaceImage`
 *     入册）⇒ 未入册 ⇒ `INVALID_VALUE`，文案点名「請先經 registerFaceImage 入冊」。
 *  ⑤ **写序（单事务语义，逐步落盘）**：① 读章行 ＋ 现有面行 → ② 幂等预查 → ③ 发面行 id
 *     （`nextFaceIdOf`）→ ④ 发 `face_no`（`issueCodeNumberAvoiding`，避让**全库**已占号）→
 *     ⑤ 算 `fid`（`codeId.encodeFaceCode`）→ ⑥ 建面行 → ⑦ 更新章行 `face_count`。任一步失败 ⇒
 *     结构化失败、**不留半成品面行**（已建则 `deleteRow` 回滚；`face_count` 未改）。
 *  ⑥ **面行键集逐字照「补缺失面」构造点**（`lib/ops.js::buildMissingFaceDocsOfExistingSeal`）：
 *     `id / sealId / stamp_id / face_no / fid / kind / face_image_id（FACE）or edge_image_ids（EDGE，
 *     恰 1 项）/ seal_name / dynasty / seal_type / face_style / seal_class / author /
 *     author_person_id / transcription / image_source_kind / source / uploaded_by / created_at /
 *     updated_at / is_primary（仅 FACE）`。**属性留白**（`author_person_id` / `transcription` 空串，
 *     `seal_type` / `face_style` / `seal_class` / `author` 空串），建后由既有「編輯固定屬性」补；
 *     `dynasty` 取**本章自己的** `dynasty`（与构造点的回落同尺）；`source` / `image_source_kind`
 *     留空 —— 本 op 不是任何导入 / 直写通道，**不冒充来源**。
 *  ⑦ **`is_primary`**：章**已有任一 FACE 面** ⇒ 新面 `false`（不抢既有主印面）；章**尚无 FACE 面**
 *     且新面是 `FACE` ⇒ `true`；`EDGE` **永不落该键**。
 *  ⑧ **`face_count`**：新面是 `FACE` ⇒ 章行 `face_count + 1`；`EDGE` ⇒ **不变**（只数非 `EDGE`）。
 *     写体**只含 `face_count` 一个键**（不碰其它字段、不写 `updated_at` —— 与 `repairSealFaceCount`
 *     的写体逐字同尺），`expectAtLeast: 1`。
 *  ⑨ **幂等**：同 `(stamp_id, kind, sha256)` 已存在面行 ⇒ **不建第二行**、不发号、不写章行，
 *     回 `{ ok:true, face_id, skipped:true, face_count }`（`skipped` 是 additive 键，
 *     `index.js` 按 op 收窄透传）。
 *  ⑩ **回包**：成功 `{ ok, face_id, face_no, fid, kind, face_count }`（本 op 自有读数）；
 *     失败恒**恰 3 键** `{ ok:false, reason, message }`，`reason` **零新增字面值**。
 *  ⑪ **零新集合、零 `plan`**（写步在本函数内按确定序执行 ⇒ `index.js` 没有内部落盘计划可外传）、
 *     **零全表扫描**（只按 `stamp_id` 窄读面行、按摘要窄读影像行）；本文件**零集合句柄** ——
 *     读写一律经 `lib/ops.js` 的既有封装（`readRows` / `persist` / `deleteRow`）。
 *
 * 复用单点（**不得第二套**）：面行 id ＝ `lib/ops.js::nextFaceIdOf`；`face_no` ＝
 * `issueCodeNumberAvoiding('face')`（避让全库已占号、释放号优先）；`fid` ＝
 * `lib/codeId.js::encodeFaceCode`；形态门常量 ＝ `lib/ops.js` 的 `ARTIFACT_*` / `FACE_IMAGE_REGISTER_KINDS`；
 * 影像行查存在 ＝ `readRegisteredImageByDigest`；管理员门 ＝ `adminWhitelistDenial`；写 ＝ `persist` /
 * `deleteRow`。本文件不持有任何集合句柄（不出现 SDK 的取集合调用），一律经 `lib/ops.js` 的读写封装。
 * @module addSealFace
 */

const { REASONS, deny } = require('./config.js')
/* 识别编码：`fid` 由 `face_no` **恒重算**（与全部建面路径同一份编码器）。 */
const codeId = require('./codeId.js')

/** 延迟取 `lib/ops.js`（打破加载环；离线自检不需要 SDK）—— 与 `lib/sealCards.js` 同法。 */
function opsOf() {
  return require('./ops.js')
}

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/** 新增印面载荷**封闭恰 7 键**（身份类键一律拒 —— 与其余 op 同一张表、同一条文案）。 */
const ADD_SEAL_FACE_ALLOWED_KEYS = Object.freeze([
  'stamp_id',
  'kind',
  'sha256',
  'bytes',
  'mime',
  'storage_key',
  'seal_name'
])

/**
 * 新增印面成功回包**读数键面**（`index.js` 按 op 收窄透传的键面真源；**存在性驱动** ⇒
 * 建面轮回 `face_id / face_no / fid / kind / face_count`、幂等轮回 `face_id / skipped / face_count`）。
 */
const ADD_SEAL_FACE_READOUT_KEYS = Object.freeze(['face_id', 'face_no', 'fid', 'kind', 'face_count', 'skipped'])

/** `stamp_id` 长度上限（裁定件 §3：trimg 非空、≤ 64）。 */
const ADD_SEAL_FACE_MAX_STAMP_ID_LENGTH = 64

/** 面行 id 检索键序（`sealId` 为主、空集再按 `stamp_id` 兜底 —— 与既有面行读点同一取键序）。 */
async function readFaceRowsOf(ops, stampId) {
  let rows = await ops.readRows(ops.COLLECTIONS.faces, { sealId: stampId }, { limit: ops.EXISTING_FACE_SCAN_LIMIT })
  if (rows.length === 0) {
    rows = await ops.readRows(ops.COLLECTIONS.faces, { stamp_id: stampId }, { limit: ops.EXISTING_FACE_SCAN_LIMIT })
  }
  return rows
}

/** 行键（`_id` 优先、`id` 兜底；都没有 ⇒ 空串）。 */
function rowKeyOf(row) {
  return text(row && row._id) || text(row && row.id)
}

/** 面行是否非 `EDGE`（`kind` 在写入侧只有 `FACE` / `EDGE` 两值 ⇒ 非 `EDGE` ≡ `FACE`）。 */
function isFaceKind(row) {
  return text(row && row.kind) !== 'EDGE'
}

/** 该面行引用的影像编号（`FACE` ⇒ `face_image_id`；`EDGE` ⇒ `edge_image_ids[]` 首项；无 ⇒ 空串）。 */
function faceImageIdOf(row, kind) {
  if (text(kind) === 'EDGE') {
    const ids = Array.isArray(row && row.edge_image_ids) ? row.edge_image_ids : []
    return text(ids.find((id) => text(id) !== ''))
  }
  return text(row && row.face_image_id)
}

/**
 * 本 op 的**唯一实现点**（`ADMIN_OPS.addSealFace` 薄委派到这里）。
 * @param {object} payload 载荷（封闭 7 键，见 `ADD_SEAL_FACE_ALLOWED_KEYS`）
 * @param {{uid:string, phone:string, role?:string}} identity **服务端派生**的身份（唯一来源）
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<{ok:true, face_id:string, face_no:number, fid:string, kind:string, face_count:number}|
 *                   {ok:true, face_id:string, skipped:true, face_count:number}|
 *                   {ok:false, reason:string, message:string}>}
 */
async function addSealFace(payload, identity, context) {
  const ops = opsOf()
  /* ① 管理员门（**第一行即判**；缺 env / 非白名单 ⇒ 结构化拒 ＋ 零读零写）。 */
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ② 载荷封闭恰 7 键（未知键 / 身份类键 ⇒ `INVALID_FIELD`；判定早于任何读）。 */
  const payloadDenial = ops.pointsPayloadDenial(payload, ADD_SEAL_FACE_ALLOWED_KEYS)
  if (payloadDenial) return payloadDenial
  /* ③ 必填串门：`stamp_id` / `sha256` / `mime` / `storage_key`（缺 / 空 ⇒ `MISSING_REQUIRED`；
     非字符串 ⇒ `INVALID_VALUE`；`seal_name` 可选，给出即必须是字符串）。 */
  for (const key of ['stamp_id', 'sha256', 'mime', 'storage_key']) {
    const value = payload[key]
    if (value === undefined || value === null || text(value) === '') {
      return deny(REASONS.MISSING_REQUIRED, `缺少必要欄位（${key}）；本次零寫入。`)
    }
    if (typeof value !== 'string') {
      return deny(REASONS.INVALID_VALUE, `欄位（${key}）必須是字符串；本次零寫入。`)
    }
  }
  if (payload.seal_name !== undefined && payload.seal_name !== null && typeof payload.seal_name !== 'string') {
    return deny(REASONS.INVALID_VALUE, '欄位（seal_name）必須是字符串；本次零寫入。')
  }
  const stampIdIn = text(payload.stamp_id)
  if (stampIdIn.length > ADD_SEAL_FACE_MAX_STAMP_ID_LENGTH) {
    return deny(
      REASONS.INVALID_VALUE,
      `欄位（stamp_id）長度必須在 1〜${ADD_SEAL_FACE_MAX_STAMP_ID_LENGTH} 之間；本次零寫入。`
    )
  }
  /* ④ 体量门（`bytes` 缺 ⇒ `MISSING_REQUIRED`；非 1〜上限整数 ⇒ `INVALID_VALUE`）。 */
  const claimedBytes = payload.bytes
  if (claimedBytes === undefined || claimedBytes === null) {
    return deny(REASONS.MISSING_REQUIRED, '缺少必要欄位（bytes）；本次零寫入。')
  }
  if (!Number.isInteger(claimedBytes) || claimedBytes <= 0 || claimedBytes > ops.ARTIFACT_MAX_BYTES) {
    return deny(
      REASONS.INVALID_VALUE,
      `字節數（bytes）必須是 1 〜 ${ops.ARTIFACT_MAX_BYTES} 之間的整數；本次零寫入。`
    )
  }
  const digest = text(payload.sha256).toLowerCase()
  const storageKey = text(payload.storage_key)
  /* ⑤ 影像四道形态门（与 `registerFaceImage` **同一张表、同一条文案**）：对象键形态 →
     摘要形态 → 键内摘要 ≡ 声称摘要 → 容器常量。 */
  const matched = ops.ARTIFACT_OBJECT_KEY_PATTERN.exec(storageKey)
  if (!matched) {
    return deny(
      REASONS.INVALID_VALUE,
      '影像對象鍵形態不符（期望 xiai/images/<摘要前兩位>/<摘要>.tiff）；本次零寫入。'
    )
  }
  if (!ops.ARTIFACT_DIGEST_PATTERN.test(digest)) {
    return deny(REASONS.INVALID_VALUE, '摘要（sha256）必須是 64 位小寫十六進制；本次零寫入。')
  }
  if (matched[2] !== digest || matched[1] !== digest.slice(0, 2)) {
    return deny(REASONS.INVALID_VALUE, '影像對象鍵內含的摘要與聲稱的 sha256 不一致；本次零寫入。')
  }
  if (text(payload.mime) !== ops.ARTIFACT_MIME) {
    return deny(
      REASONS.INVALID_VALUE,
      `源件容器（mime）必須是服務端存儲容器常量（${ops.ARTIFACT_MIME}）；本次零寫入。`
    )
  }
  /* ⑥ 类别门（缺省 `FACE`；给出即必须 `FACE` / `EDGE`，**不静默归一**；值域表与
        `registerFaceImage` 同一份）。 */
  let kind = 'FACE'
  if (Object.prototype.hasOwnProperty.call(payload, 'kind') && payload.kind !== undefined && payload.kind !== null) {
    if (typeof payload.kind !== 'string' || ops.FACE_IMAGE_REGISTER_KINDS.indexOf(payload.kind) === -1) {
      return deny(REASONS.INVALID_VALUE, '印章面類別（kind）只能是 FACE 或 EDGE；本次零寫入。')
    }
    kind = payload.kind
  }
  /* ⑦ 读章行（`stamp_id` → `sid` → `id` → `_id` 四形态；无行 ⇒ `INVALID_VALUE` ＋ 裁定件文案）。 */
  const sealRow = await ops.readSealRowByAnyId(stampIdIn)
  if (!sealRow) {
    return deny(REASONS.INVALID_VALUE, `該印章不存在（stamp_id：${stampIdIn}）；本次零寫入。`)
  }
  const stampId = text(sealRow.stamp_id) || text(sealRow.sid) || text(sealRow.id) || stampIdIn
  /* ⑧ **必须已入册**：`sha256` 对应的 `xiai_images` 行必须已存在（前端先走 `registerFaceImage`）。 */
  const imageRow = await ops.readRegisteredImageByDigest(digest)
  if (!imageRow) {
    return deny(
      REASONS.INVALID_VALUE,
      `影像尚未入冊（sha256：${digest.slice(0, 12)}…；請先經 registerFaceImage 入冊）⇒ 拒絕建立印面；本次零寫入。`
    )
  }
  const imageId = rowKeyOf(imageRow)
  if (imageId === '') {
    /* 入册行没有可用编号 ⇒ 不能指向任何影像（**不猜、不补编**）。 */
    return deny(
      REASONS.INVALID_VALUE,
      `影像行缺可用編號（sha256：${digest.slice(0, 12)}…）；請重新經 registerFaceImage 入冊；本次零寫入。`
    )
  }
  /* ⑨ 读本章现有面行（随后做幂等预查 ＋ `is_primary` / `face_count` 判定）。 */
  const faceRows = await readFaceRowsOf(ops, stampId)
  const faceRowCount = faceRows.reduce((total, row) => (isFaceKind(row) ? total + 1 : total), 0)
  /* ⑩ **幂等预查**：同 `(stamp_id, kind, sha256)` 已存在面行 ⇒ 不建第二行、不发号、不写章行。
       判据两路等价（内容寻址影像编号 / 行内摘要），命中任一即算命中。 */
  const duplicate = faceRows.find(
    (row) =>
      text(row && row.kind) === kind &&
      (faceImageIdOf(row, kind) === imageId || (digest !== '' && text(row && row.image_sha256) === digest))
  )
  if (duplicate) {
    return { ok: true, face_id: rowKeyOf(duplicate), skipped: true, face_count: faceRowCount }
  }
  /* ⑪ 发面行 id（既有单点；同章同类递增、跳过已占用）。 */
  const taken = new Set(faceRows.map(rowKeyOf).filter((key) => key !== ''))
  const faceId = ops.nextFaceIdOf(stampId, kind, taken)
  /* ⑫ 发 `face_no`（既有单点；**避让全库已占号**、释放号优先）。 */
  const usedFaceNos = await ops.occupiedNosOf('face')
  const issued = await ops.issueCodeNumberAvoiding('face', (no) => usedFaceNos.has(no))
  if (!issued.ok) return { ok: false, reason: issued.reason, message: issued.message }
  /* ⑬ 算 `fid`（由 `face_no` 恒重算；编码器拒绝 ⇒ 号源异常，**零写入**）。 */
  const faceCode = codeId.encodeFaceCode(issued.no)
  if (!faceCode.ok) {
    return deny(REASONS.STORAGE_UNAVAILABLE, '印面編碼（fid）由 face_no 重算失敗（號源異常）；本次零寫入。')
  }
  /* ⑭ 建面行（键集**逐字照**「补缺失面」构造点；`EDGE` 永不落 `is_primary`）。 */
  const seconds = Number.isFinite(Number(context && context.nowSeconds))
    ? Math.floor(Number(context.nowSeconds))
    : Math.floor(Date.now() / 1000)
  const at = new Date(seconds * 1000).toISOString()
  const isEdge = kind === 'EDGE'
  const hasFaceAlready = faceRowCount > 0
  const sealName = text(payload.seal_name) || text(sealRow.seal_name)
  const faceDoc = {
    id: faceId,
    sealId: stampId,
    stamp_id: stampId,
    face_no: issued.no, // 识别编码：印面自增号（服务端计数器发号）
    fid: faceCode.code, // 识别编码：由 `face_no` 恒重算
    kind,
    face_image_id: isEdge ? null : imageId,
    edge_image_ids: isEdge ? [imageId] : [],
    seal_name: sealName,
    dynasty: text(sealRow.dynasty),
    seal_type: '',
    face_style: '',
    seal_class: '',
    author: '',
    author_person_id: '',
    transcription: '',
    image_source_kind: '',
    source: '',
    uploaded_by: text(identity && identity.uid),
    created_at: at,
    updated_at: at,
    /* 主印面标记：章已有任一 FACE 面 ⇒ `false`；章尚无 FACE 面 ⇒ `true`；`EDGE` 不落该键。 */
    ...(isEdge ? {} : { is_primary: !hasFaceAlready })
  }
  try {
    await ops.persist({ writes: [{ kind: 'set', collection: ops.COLLECTIONS.faces, id: faceId, doc: faceDoc }] })
  } catch (error) {
    /* 面行没落成 ⇒ 章行一个字未动（发出去的 `face_no` 不回退：号源单调、留空洞不允许重号）。 */
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `印面行落盤失敗（印面 id：${faceId}；face_no：${issued.no}）；章行 face_count 未改動，可重試。（診斷：${
        (error && error.message) || 'unknown'
      }）`
    )
  }
  /* ⑮ 更新章行 `face_count`（**只写这一个键**；`EDGE` ⇒ 不变、零写步）。 */
  const faceCount = isEdge ? faceRowCount : faceRowCount + 1
  if (!isEdge) {
    try {
      await ops.persist({
        writes: [
          {
            kind: 'update',
            collection: ops.COLLECTIONS.seals,
            match: { _id: text(sealRow._id) || stampId },
            doc: { face_count: faceCount },
            expectAtLeast: 1
          }
        ]
      })
    } catch (error) {
      /* ⑮′ **回滚**：删掉本轮新建的面行（`face_count` 未改），再如实报「回滚成败」。 */
      let rollbackText = ''
      try {
        await ops.deleteRow(ops.COLLECTIONS.faces, faceId)
        rollbackText = '本輪新建的印面行已刪除（回滾完成）。'
      } catch (rollbackError) {
        rollbackText =
          `本輪新建的印面行刪除失敗（face_id：${faceId}；該行仍在，可經既有刪面路徑處理）。` +
          `（回滾診斷：${(rollbackError && rollbackError.message) || 'unknown'}）`
      }
      return deny(
        REASONS.STORAGE_UNAVAILABLE,
        `章行 face_count 更新失敗（face_id：${faceId}）⇒ ${rollbackText}章行其它欄位未動，可重試。（診斷：${
          (error && error.message) || 'unknown'
        }）`
      )
    }
  }
  /* ⑯ 成功回包（本 op 自有读数；`index.js` 按 `ADD_SEAL_FACE_READOUT_KEYS` 收窄透传）。 */
  return { ok: true, face_id: faceId, face_no: issued.no, fid: faceCode.code, kind, face_count: faceCount }
}

module.exports = {
  addSealFace,
  ADD_SEAL_FACE_ALLOWED_KEYS,
  ADD_SEAL_FACE_READOUT_KEYS
}
