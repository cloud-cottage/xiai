'use strict'
/**
 * 玺爱 · **face 层三 op 实现面**（管理员写面）
 * ============================================================================
 * 口径真源：`docs/face-layer-ruling-v2-2026-11-14.md`（commit 9ce894b；Kevin 2026-11-14 CST
 * 复答 **1B / 2C / 3B**）＋ 背景件 `docs/face-layer-ruling-2026-11-14.md`。
 * 三个 op 全部落 `ADMIN_OPS`（41 → 44），本文件是它们的**唯一实现点**；`lib/ops.js` 里那三处
 * 是**薄委派**（延迟 `require` 打破加载环，照 `repairSealViewCount` 的写法），本文件不持有
 * 第二套判定 / 第二套回包。
 *
 * 复用单点（**不得第二套**；全部经 `lib/ops.js` 的既有导出）：
 *   · 管理员门 ＝ `adminWhitelistDenial`（**第一行即判**；缺 env / 非白名单 ⇒ 结构化拒 ＋ 零读写）；
 *   · 载荷封闭键面 ＝ `pointsPayloadDenial`（形态 ＋ 未知键 / 身份类键 ⇒ `INVALID_FIELD`）；
 *   · 读 ＝ `readRows`（可选集合降级 / 排序退路全在那一处）、写 ＝ `persist`（`kind:'update'`
 *     ＋ `expectAtLeast:1`）、删行 ＝ `deleteRow`、删对象候选单点 ＝ `deleteImageObjectsOfRow`；
 *   · 集合名单 ＝ `COLLECTIONS`（本文件**零集合名字面**）。
 *
 * ---------------------------------------------------------------------------
 * **A｜`migrateEdgeFaces`（EDGE → FACE｜本批只迁数据）**
 * ---------------------------------------------------------------------------
 * 硬口径（逐条，与 v2 §三逐字对齐）：
 *  ① **管理员门第一行即判**（零读零写地拒）；
 *  ② 载荷**封闭恰 3 键** `{dry_run, limit, cursor}`：`dry_run` 缺省 `true`（给了但非布林 ⇒
 *     `INVALID_VALUE`）；`limit` 1〜500 整数、缺省 200（越界 / 非整数 ⇒ `INVALID_VALUE`）；
 *     `cursor` ＝ 上轮 `next_cursor`（缺省 / 空串 ＝ 从头；非字符串 ⇒ `INVALID_VALUE`；
 *     非空长度 ≤ 64）；**全部判定早于任何读**；
 *  ③ 窗口 ＝ `xiai_faces` 按 `_id` **升序**、**严格大于 `cursor`**、**只取 `kind === 'EDGE'`** 的
 *     前 `limit` 行（**全经 `lib/ops.js` 的升序游标窗口读单点 `readAscendingWindowOf`**：主路
 *     范围查询 ＋ 退路内存同尺两路都在那一处；本文件**零自建集合句柄**、零窗口纯函数）；
 *  ④ 写序（**逐行、确定序**）：① 记下 `edge_image_ids` 首项 → ② 更新面行
 *     （`kind:'FACE'`、`face_image_id` ＝ 首项、`edge_image_ids: []`、`is_primary: false`
 *     —— **只这 4 个键**、不写 `updated_at`、不碰 `fid` / `face_no` / 面行 id）→
 *     ③ **重算该章 `face_count`**（读该章全部面行、数 `kind === 'FACE'` 的条数；写体**只含
 *     `face_count` 一个键**，与 `repairSealFaceCount` 的写体逐字同尺）；
 *  ⑤ 回包**恒恰 7 键** `{ok, scanned, eligible, written, failed, samples, next_cursor}`
 *     （`dry_run` 与真写**同形**、键数不因模式变化）：
 *       · `scanned` ＝ 本窗口扫描到的 EDGE 行数；`eligible` ＝ 其中**应当迁移**的行数（同值）；
 *       · `written` ＝ **整窗读回**判定的已迁移行数（不得由 `persist` 的 resolve 驱动；
 *         `dry_run` 恒 0）；
 *       · `failed` ＝ 元素恰 2 键 `{_id, reason}`（`reason` **只用既有冻结值**）；
 *       · `samples` ≤ 5 条、元素恰 3 键 `{row_id, seal_id, moved_image_id}`（**`dry_run` 也给**
 *         —— 裁定 §八.1 要拿它核对 `moved_image_id` 与面行原 `edge_image_ids[0]` 一致）；
 *       · `next_cursor` ＝ 本窗口**最后一条被扫描行**的 `_id`（不是最后一条被写的；扫空 ⇒ 空串）；
 *  ⑥ **幂等**：无 EDGE 行 ⇒ `eligible 0 / written 0`；重放不重复搬图（`edge_image_ids` 已空、
 *     `kind` 已 `FACE` ⇒ 不再入窗）；
 *  ⑦ **零删行、零新集合、`reason` 零新增**；既有 `kind === 'EDGE'` 的代码分支**本批一律保留**
 *     （迁移后成死代码，保留无害 —— 删分支是下一批的独立清理单，风险隔离）。
 *
 * ---------------------------------------------------------------------------
 * **B｜`deleteWholeSealImage`（删整章图｜2C）**
 * ---------------------------------------------------------------------------
 *  ① 管理员门第一行即判；② 载荷**封闭恰 2 键** `{stamp_id, image_id}`（缺 / 空 ⇒
 *     `MISSING_REQUIRED`；非字符串 ⇒ `INVALID_VALUE`）；
 *  ③ 判定（**全部早于写**）：影像行存在（`id` → `_id` 两形态；无行 ⇒ `INVALID_VALUE`
 *     「該影像不存在」）→ 行上 `stamp_id` 等于载荷（防跨章误删）→ **未被任何面行引用**
 *     （`face_image_id` 等值 **或** 任一 `edge_image_ids` 含它 ⇒ `INVALID_VALUE`
 *     「該影像已被印面引用，請改用印面級刪除」）；
 *  ④ 写序：删影像行（`deleteRow`）→ **尽力**删对象（复用候选单点 `deleteImageObjectsOfRow`：
 *     `storage_key` 优先 → `sha` 派生后缀族逐个试 → 行内其它键、命中即停；失败不抛、回实删件数）；
 *  ⑤ 回包**恰 4 键** `{ok, image_id, deleted_rows, deleted_objects}`（删数如实、零补编）；
 *     失败恰 3 键 `{ok, reason, message}`。**不写流水、不计费、不写审计行新增集合**。
 *
 * ---------------------------------------------------------------------------
 * **C｜`setBaseFace`（切主印面｜3B）**
 * ---------------------------------------------------------------------------
 *  ① 管理员门第一行即判；② 载荷**封闭恰 2 键** `{stamp_id, face_id}`（同 B 的形态门）；
 *  ③ 判定：面行存在且**属该章**（行上 `sealId` / `stamp_id` 等值；两者都空 ⇒ 退回编号约定
 *     `fc-<stamp_id>-…`）→ 该行 `kind` **必须是 `FACE`**（迁移后恒成立；非 FACE ⇒
 *     `INVALID_VALUE`）；
 *  ④ 写序：读该章现有 base（`is_primary === true`）——
 *       · 目标**已是** base ⇒ **零写**、回 `previous_base_face_id` ＝ 目标（幂等）；
 *       · 否则**先把旧 base 置 `false`、再把目标置 `true`**（两次写）；目标写失败 ⇒
 *         **回滚旧 base 为 `true`**，并如实回报回滚成败（**绝不留零 base 或多 base**）；
 *  ⑤ 回包**恰 3 键** `{ok, face_id, previous_base_face_id}`（原本无 base ⇒ `null`）；失败恰 3 键；
 *  ⑥ **不写 `face_count`、不动 `face_no`、不删行、零新集合、`reason` 零新增**。
 *
 * @module faceLayerOps
 */

const { REASONS, deny } = require('./config.js')

/** 延迟取 `lib/ops.js`（打破加载环；离线自检不需要 SDK）—— 与 `lib/addSealFace.js` 同法。 */
function opsOf() {
  return require('./ops.js')
}

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function hasKey(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key)
}

/** 行键（`_id` 优先、`id` 兜底；都没有 ⇒ 空串）。 */
function rowKeyOf(row) {
  return text(row && row._id) || text(row && row.id)
}

/** 建档：`kind === 'FACE'`（迁移后唯一合法值；`EDGE` 只作历史值）。 */
function isFaceRow(row) {
  return text(row && row.kind) === 'FACE'
}

/** 面行可迁移的影像编号 ＝ `edge_image_ids` 首个非空项（无 ⇒ 空串）。 */
function movableEdgeImageIdOf(row) {
  const ids = Array.isArray(row && row.edge_image_ids) ? row.edge_image_ids : []
  for (const item of ids) {
    const value = text(item)
    if (value !== '') return value
  }
  return ''
}

/** 面行引用的全部影像编号（`face_image_id` ＋ `edge_image_ids[]`；统一 `text()` 归一、滤空）。 */
function referencedImageIdsOf(row) {
  const ids = []
  const faceImageId = text(row && row.face_image_id)
  if (faceImageId !== '') ids.push(faceImageId)
  if (Array.isArray(row && row.edge_image_ids)) {
    for (const item of row.edge_image_ids) {
      const value = text(item)
      if (value !== '') ids.push(value)
    }
  }
  return ids
}

/* --------------------------------------------------------------------------- *
 * 载荷 / 回包键面（`index.js` 按 op 收窄透传的键名真源；**一处定义，零第二套**）
 * --------------------------------------------------------------------------- */

/** A：迁移载荷**封闭恰 3 键**。 */
const MIGRATE_EDGE_FACES_ALLOWED_KEYS = Object.freeze(['dry_run', 'limit', 'cursor'])
/** A：`limit` 缺省值（＝ 本轮最多扫描的 EDGE 行数）。 */
const MIGRATE_EDGE_FACES_DEFAULT_LIMIT = 200
/** A：`limit` 上界（1〜500；裁定 §三，不得放宽）。 */
const MIGRATE_EDGE_FACES_MAX_LIMIT = 500
/** A：`cursor` 非空时长度上限（与其余游标类 op 同尺）。 */
const MIGRATE_EDGE_FACES_MAX_CURSOR_LENGTH = 64
/** A：`samples` 条数上限（裁定 §三：≤ 5）。 */
const MIGRATE_EDGE_FACES_SAMPLE_LIMIT = 5
/** A：成功回包**恒恰 7 键**（`dry_run` 与真写同形）。 */
const MIGRATE_EDGE_FACES_READOUT_KEYS = Object.freeze([
  'ok',
  'scanned',
  'eligible',
  'written',
  'failed',
  'samples',
  'next_cursor'
])

/** B：删整章图载荷**封闭恰 2 键**。 */
const DELETE_WHOLE_SEAL_IMAGE_ALLOWED_KEYS = Object.freeze(['stamp_id', 'image_id'])
/** B：成功回包**恰 4 键**。 */
const DELETE_WHOLE_SEAL_IMAGE_READOUT_KEYS = Object.freeze([
  'ok',
  'image_id',
  'deleted_rows',
  'deleted_objects'
])

/** C：切主印面载荷**封闭恰 2 键**。 */
const SET_BASE_FACE_ALLOWED_KEYS = Object.freeze(['stamp_id', 'face_id'])
/** C：成功回包**恰 3 键**。 */
const SET_BASE_FACE_READOUT_KEYS = Object.freeze(['ok', 'face_id', 'previous_base_face_id'])

/** 章内 / 全库面行扫描护栏（口径同仓内既有 1000 行护栏）。 */
const FACE_LAYER_FACE_SCAN_LIMIT = 1000
/** `stamp_id` / `image_id` / `face_id` 长度上限（与其余 id 类载荷同尺）。 */
const FACE_LAYER_MAX_ID_LENGTH = 64

/* --------------------------------------------------------------------------- *
 * A 的扫描窗口（**只取 `kind === 'EDGE'`**；`_id` 升序、严格大于 cursor）
 * --------------------------------------------------------------------------- */

/**
 * 取本轮**待迁 EDGE 行**窗口（只读）：**全经 `lib/ops.js` 的升序游标窗口读单点**
 * `readAscendingWindowOf(集合名, {kind:'EDGE'}, cursor, limit)` —— 主路范围查询 ＋ 退路内存
 * 同尺两路都在那一处（**本文件零自建集合句柄**，`verify-endorsement` D4 持久化路径封闭）。
 * 任一路抛错都**原样上抛**（由 `index.js` 转 `STORAGE_UNAVAILABLE`，**绝不吞成 0 行**）。
 * @param {object} ops `lib/ops.js` 导出面
 * @param {string} after 游标（上轮回包 `next_cursor`；空串 ⇒ 从头）
 * @param {number} windowSize 窗口上限（＝ `limit`）
 * @returns {Promise<Array<object>>}
 */
async function readEdgeFaceWindow(ops, after, windowSize) {
  return ops.readAscendingWindowOf(ops.COLLECTIONS.faces, { kind: 'EDGE' }, text(after), windowSize)
}

/* --------------------------------------------------------------------------- *
 * 章内面行读点（三 op 共用；`sealId` 为主、空集再按 `stamp_id` 兜底）
 * --------------------------------------------------------------------------- */

/** 读该章全部面行（`sealId` → `stamp_id` 两形态；空集 ⇒ 空数组，**不抛**）。 */
async function readChapterFaceRows(ops, stampId) {
  let rows = await ops.readRows(ops.COLLECTIONS.faces, { sealId: stampId }, { limit: FACE_LAYER_FACE_SCAN_LIMIT })
  if (rows.length === 0) {
    rows = await ops.readRows(ops.COLLECTIONS.faces, { stamp_id: stampId }, { limit: FACE_LAYER_FACE_SCAN_LIMIT })
  }
  return rows
}

/**
 * **重算并写回该章 `face_count`**（A 的第 ③ 步）：读该章全部面行、数 `kind === 'FACE'` 的条数，
 * 写体**只含 `face_count` 一个键**（不碰其它字段、不写 `updated_at`）。
 * 章行不存在 / 写失败 ⇒ **抛错**（由调用方如实记 `failed`，不吞、不编造）。
 * @returns {Promise<number>} 写回的 `face_count`
 */
async function rewriteFaceCountOfSeal(ops, stampId) {
  const sealRow = await ops.readSealRowByAnyId(stampId)
  if (sealRow === null) throw new Error(`SEAL_ROW_MISSING:${stampId}`)
  const faces = await readChapterFaceRows(ops, stampId)
  const faceCount = faces.filter((row) => isFaceRow(row)).length
  const sealDocId = text(sealRow._id)
  const match = sealDocId !== '' ? { _id: sealDocId } : { stamp_id: stampId }
  await ops.persist({
    writes: [
      {
        kind: 'update',
        collection: ops.COLLECTIONS.seals,
        match,
        doc: { face_count: faceCount },
        expectAtLeast: 1
      }
    ]
  })
  return faceCount
}

/* --------------------------------------------------------------------------- *
 * A｜`migrateEdgeFaces`
 * --------------------------------------------------------------------------- */

/**
 * **EDGE → FACE 数据迁移（管理员 op；`ADMIN_OPS` 41 → 44 之一）**。
 * @param {object} [payload] `{dry_run?:boolean, limit?:number, cursor?:string}`
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<object>} 成功恒恰 7 键；失败恒恰 3 键 `{ok:false, reason, message}`
 */
async function migrateEdgeFaces(payload, identity, context) {
  const ops = opsOf()
  /* ① 管理员门（**第一行**；缺 env / 非白名单 ⇒ 结构化拒 ＋ 零读零写）。 */
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ② 载荷封闭键面（形态 ＋ 未知键 / 身份类键 ⇒ `INVALID_FIELD`）。 */
  const keyDenial = ops.pointsPayloadDenial(payload, MIGRATE_EDGE_FACES_ALLOWED_KEYS)
  if (keyDenial) return keyDenial
  const input = payload && typeof payload === 'object' ? payload : {}
  /* `dry_run` 缺省 `true`（给了但非布林 ⇒ `INVALID_VALUE`）。 */
  let dryRun = true
  if (hasKey(input, 'dry_run')) {
    if (typeof input.dry_run !== 'boolean') {
      return deny(REASONS.INVALID_VALUE, '`dry_run` 必須是布林值（true / false）；本次零寫入。')
    }
    dryRun = input.dry_run
  }
  /* `limit` 1〜500 整数、缺省 200。 */
  let limit = MIGRATE_EDGE_FACES_DEFAULT_LIMIT
  if (hasKey(input, 'limit')) {
    const raw = input.limit
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MIGRATE_EDGE_FACES_MAX_LIMIT) {
      return deny(
        REASONS.INVALID_VALUE,
        `\`limit\` 必須是 1〜${MIGRATE_EDGE_FACES_MAX_LIMIT} 的整數；本次零寫入。`
      )
    }
    limit = raw
  }
  /* `cursor`：字符串（上轮回包 `next_cursor`）；缺省 / 空串 ＝ 从头；非字符串 / 超长 ⇒ `INVALID_VALUE`。 */
  let cursor = ''
  if (hasKey(input, 'cursor')) {
    const rawCursor = input.cursor
    if (typeof rawCursor !== 'string') {
      return deny(REASONS.INVALID_VALUE, '`cursor` 必須是字符串（上一輪回包的 `next_cursor`）；本次零讀取。')
    }
    cursor = rawCursor.trim()
    if (cursor.length > MIGRATE_EDGE_FACES_MAX_CURSOR_LENGTH) {
      return deny(
        REASONS.INVALID_VALUE,
        `\`cursor\` 非空時長度必須在 1〜${MIGRATE_EDGE_FACES_MAX_CURSOR_LENGTH} 之間（空串 ＝ 從頭；上一輪回包的 \`next_cursor\`）；本次零讀取。`
      )
    }
  }
  /* ③ 窗口：只取 `kind === 'EDGE'` 的行（`_id` 升序、严格大于 cursor）。 */
  const edgeRows = await readEdgeFaceWindow(ops, cursor, limit)
  const scanned = edgeRows.length
  /* `next_cursor` ＝ **本窗口最后一条被扫描行**的 `_id`（不是最后一条被写的）；扫空 ⇒ 空串。 */
  const nextCursor = scanned > 0 ? text(edgeRows[scanned - 1] && edgeRows[scanned - 1]._id) : ''
  const eligible = scanned
  const samples = []
  const failed = []
  if (scanned === 0) {
    return { ok: true, scanned: 0, eligible: 0, written: 0, failed: [], samples: [], next_cursor: '' }
  }
  /* ④ 逐行备料：① 记下 `edge_image_ids` 首项；`dry_run` 也给 `samples`（裁定 §八.1 要用）。 */
  const targets = []
  for (const row of edgeRows) {
    const rowId = text(row && row._id)
    const sealId = text(row && row.sealId) || text(row && row.stamp_id)
    const movedImageId = movableEdgeImageIdOf(row)
    /* 缺 `_id` / 章键 / 可搬影像 ⇒ 该行**永远迁不动**（不是写失败，也不可能成功）⇒ 如实进 `failed`。 */
    if (rowId === '' || sealId === '' || movedImageId === '') {
      failed.push({ _id: rowId || '（缺 _id）', reason: REASONS.INVALID_VALUE })
      continue
    }
    targets.push({ rowId, sealId, movedImageId })
  }
  for (const target of targets) {
    if (samples.length >= MIGRATE_EDGE_FACES_SAMPLE_LIMIT) break
    samples.push({ row_id: target.rowId, seal_id: target.sealId, moved_image_id: target.movedImageId })
  }
  if (dryRun) {
    /* `dry_run` ⇒ **零写**、`written` 恒 0（不得虚报）；回包仍恒恰 7 键。 */
    return { ok: true, scanned, eligible, written: 0, failed, samples, next_cursor: nextCursor }
  }
  /* ⑤ 真写：逐行「改面行 → 重算该章 face_count」；单行失败不中断整批。 */
  for (const target of targets) {
    try {
      await ops.persist({
        writes: [
          {
            kind: 'update',
            collection: ops.COLLECTIONS.faces,
            match: { _id: target.rowId },
            /* 只这 4 个键：`fid` / `face_no` / 面行 id / 其它属性一律不动。 */
            doc: {
              kind: 'FACE',
              face_image_id: target.movedImageId,
              edge_image_ids: [],
              is_primary: false
            },
            expectAtLeast: 1
          }
        ]
      })
    } catch (error) {
      console.warn(
        `[xiai] migrateEdgeFaces 面行遷移失敗（印章：${target.sealId}；面行：${target.rowId}；不中斷整批）：`,
        text(error && error.message)
      )
      failed.push({ _id: target.rowId, reason: REASONS.STORAGE_UNAVAILABLE })
      continue
    }
    try {
      await rewriteFaceCountOfSeal(ops, target.sealId)
    } catch (error) {
      /* 面行已迁、章行计数未落 ⇒ **如实进 `failed`**（不谎称成功）。 */
      console.warn(
        `[xiai] migrateEdgeFaces 章行 face_count 重算失敗（印章：${target.sealId}；面行：${target.rowId}）：`,
        text(error && error.message)
      )
      failed.push({ _id: target.rowId, reason: REASONS.STORAGE_UNAVAILABLE })
    }
  }
  /* ⑥ `written` **由整窗读回判定**（`persist` 的 resolve 不等于行已落）：逐行重读该面行，
     终态满足「`kind === 'FACE'` ＋ `face_image_id` ＝ 搬入影像 ＋ `edge_image_ids` 空」才计 1；
     读回失败 ⇒ **宁报 0 不虚报**。 */
  let written = 0
  const failedIds = new Set(failed.map((item) => item._id))
  try {
    for (const target of targets) {
      const rows = await ops.readRows(ops.COLLECTIONS.faces, { _id: target.rowId }, { limit: 1 })
      const row = rows.length > 0 ? rows[0] : null
      const migrated =
        row !== null &&
        isFaceRow(row) &&
        text(row.face_image_id) === target.movedImageId &&
        Array.isArray(row.edge_image_ids) &&
        row.edge_image_ids.length === 0
      if (migrated) {
        written += 1
        continue
      }
      console.warn(`[xiai] migrateEdgeFaces 單行未生效（讀回不符實況；面行：${target.rowId}）`)
      if (!failedIds.has(target.rowId)) {
        failedIds.add(target.rowId)
        failed.push({ _id: target.rowId, reason: REASONS.STORAGE_UNAVAILABLE })
      }
    }
  } catch (error) {
    console.warn('[xiai] migrateEdgeFaces 讀回失敗（本輪 written 按 0 如實上報）：', text(error && error.message))
    written = 0
  }
  /* 回包恒恰 7 键（`dry_run` 与真写同形）。 */
  return { ok: true, scanned, eligible, written, failed, samples, next_cursor: nextCursor }
}

/* --------------------------------------------------------------------------- *
 * B｜`deleteWholeSealImage`
 * --------------------------------------------------------------------------- */

/** 逐一校验必填 id 类键（缺 / 空 ⇒ `MISSING_REQUIRED`；非字符串 ⇒ `INVALID_VALUE`；零写入）。 */
function requiredIdDenial(payload, keys) {
  for (const key of keys) {
    const value = payload[key]
    if (value === undefined || value === null || text(value) === '') {
      return deny(REASONS.MISSING_REQUIRED, `缺少必要欄位（${key}）；本次零寫入。`)
    }
    if (typeof value !== 'string') {
      return deny(REASONS.INVALID_VALUE, `欄位（${key}）必須是字符串；本次零寫入。`)
    }
    if (text(value).length > FACE_LAYER_MAX_ID_LENGTH) {
      return deny(
        REASONS.INVALID_VALUE,
        `欄位（${key}）長度必須在 1〜${FACE_LAYER_MAX_ID_LENGTH} 之間；本次零寫入。`
      )
    }
  }
  return null
}

/**
 * **删整枚印章圖（无面归属的章级影像；管理员 op）**：删影像行 ＋ 尽力删对象。
 * 判定全部早于写；被任何面行引用 ⇒ 拒（改用印面级删除）。
 * @param {object} payload `{stamp_id, image_id}`（封闭恰 2 键）
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<object>} 成功恰 4 键；失败恰 3 键
 */
async function deleteWholeSealImage(payload, identity, context) {
  const ops = opsOf()
  /* ① 管理员门（**第一行**；零读零写地拒）。 */
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ② 载荷封闭键面 ＋ 必填 id 形态门（全部判定早于任何读）。 */
  const keyDenial = ops.pointsPayloadDenial(payload, DELETE_WHOLE_SEAL_IMAGE_ALLOWED_KEYS)
  if (keyDenial) return keyDenial
  const shapeDenial = requiredIdDenial(payload, ['stamp_id', 'image_id'])
  if (shapeDenial) return shapeDenial
  const stampId = text(payload.stamp_id)
  const imageId = text(payload.image_id)
  /* ③-① 影像行必须存在（`id` → `_id` 两形态；无行 ⇒ `INVALID_VALUE`）。 */
  let imageRow = null
  for (const probe of ['id', '_id']) {
    const rows = await ops.readRows(ops.COLLECTIONS.images, { [probe]: imageId }, { limit: 1 })
    if (rows.length > 0) {
      imageRow = rows[0]
      break
    }
  }
  if (imageRow === null) {
    return deny(REASONS.INVALID_VALUE, `該影像不存在（image_id：${imageId}）；本次零寫入。`)
  }
  /* ③-② 行上 `stamp_id` 必须逐字等于载荷（防跨章误删）。 */
  if (text(imageRow.stamp_id) !== stampId) {
    return deny(
      REASONS.INVALID_VALUE,
      `該影像不屬於此印章（image_id：${imageId}；行上 stamp_id：${text(imageRow.stamp_id) || '（空）'}，載荷 stamp_id：${stampId}）；本次零寫入。`
    )
  }
  /* ③-③ **未被任何面行引用**（`face_image_id` 等值 或 任一 `edge_image_ids` 含它）⇒ 才可删。 */
  const allFaces = await ops.readRows(ops.COLLECTIONS.faces, {}, { limit: FACE_LAYER_FACE_SCAN_LIMIT })
  const referencedByFace = allFaces.some((row) => referencedImageIdsOf(row).indexOf(imageId) !== -1)
  if (referencedByFace) {
    return deny(
      REASONS.INVALID_VALUE,
      `該影像已被印面引用，請改用印面級刪除（image_id：${imageId}）；本次零寫入。`
    )
  }
  /* ④ 写序：① 删影像行 → ② **尽力**删对象（候选单点；失败不阻断、回实删件数）。 */
  const imageDocId = text(imageRow._id) || imageId
  try {
    await ops.deleteRow(ops.COLLECTIONS.images, imageDocId)
  } catch (error) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `影像行刪除失敗（image_id：${imageId}）；對象未刪除、影像行仍在，可重試。（診斷：${
        text(error && error.message) || 'unknown'
      }）`
    )
  }
  const deletedObjects = await ops.deleteImageObjectsOfRow(imageRow)
  /* ⑤ 成功恰 4 键（删数如实、零补编）。 */
  return { ok: true, image_id: imageId, deleted_rows: 1, deleted_objects: deletedObjects }
}

/* --------------------------------------------------------------------------- *
 * C｜`setBaseFace`
 * --------------------------------------------------------------------------- */

/** 面行是否属该章（行上 `sealId` / `stamp_id` 等值；两者都空 ⇒ 退回编号约定 `fc-<sid>-…`）。 */
function faceBelongsToStamp(faceRow, stampId) {
  const declared = text(faceRow && (faceRow.sealId || faceRow.stamp_id))
  if (declared !== '') return declared === stampId
  const faceId = rowKeyOf(faceRow)
  return stampId !== '' && faceId.indexOf(`fc-${stampId}`) === 0
}

/**
 * **切主印面（base face；管理员 op）**：每章**恰一枚** `is_primary === true`。
 * 目标已是 base ⇒ 零写并回 `previous_base_face_id` ＝ 目标（幂等）；否则先旧 base 置 `false`、
 * 再目标置 `true`，失败回滚旧 base（绝不留零 base / 多 base）。
 * @param {object} payload `{stamp_id, face_id}`（封闭恰 2 键）
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<object>} 成功恰 3 键；失败恰 3 键
 */
async function setBaseFace(payload, identity, context) {
  const ops = opsOf()
  /* ① 管理员门（**第一行**；零读零写地拒）。 */
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ② 载荷封闭键面 ＋ 必填 id 形态门（全部判定早于任何读）。 */
  const keyDenial = ops.pointsPayloadDenial(payload, SET_BASE_FACE_ALLOWED_KEYS)
  if (keyDenial) return keyDenial
  const shapeDenial = requiredIdDenial(payload, ['stamp_id', 'face_id'])
  if (shapeDenial) return shapeDenial
  const stampId = text(payload.stamp_id)
  const faceId = text(payload.face_id)
  /* ③-① 面行必须存在（`id` → `_id` 两形态；无行 ⇒ `INVALID_VALUE`）。 */
  let faceRow = null
  for (const probe of ['id', '_id']) {
    const rows = await ops.readRows(ops.COLLECTIONS.faces, { [probe]: faceId }, { limit: 1 })
    if (rows.length > 0) {
      faceRow = rows[0]
      break
    }
  }
  if (faceRow === null) {
    return deny(REASONS.INVALID_VALUE, `未找到該印面（face_id：${faceId}）；本次零寫入。`)
  }
  /* ③-② 必须属该章（否则跨章改主印面 ⇒ 拒 ＋ 零写）。 */
  if (!faceBelongsToStamp(faceRow, stampId)) {
    return deny(
      REASONS.INVALID_VALUE,
      `該印面不屬於此印章（face_id：${faceId}；stamp_id：${stampId}）；本次零寫入。`
    )
  }
  /* ③-③ `kind` 必须是 `FACE`（迁移后恒成立；非 FACE ⇒ 拒 ＋ 零写）。 */
  if (!isFaceRow(faceRow)) {
    return deny(
      REASONS.INVALID_VALUE,
      `該印面不是 FACE 面（kind：${text(faceRow.kind) || '（空）'}）⇒ 不可設為主印面；本次零寫入。`
    )
  }
  const targetKey = rowKeyOf(faceRow)
  const targetMatch = text(faceRow._id) ? { _id: text(faceRow._id) } : { id: rowKeyOf(faceRow) }
  /* ④-① 目标**已是** base ⇒ **零写**、`previous_base_face_id` ＝ 目标（幂等）。 */
  if (faceRow.is_primary === true) {
    return { ok: true, face_id: faceId, previous_base_face_id: faceId }
  }
  /* ④-② 读该章现有 base（同一读点读全章 ⇒ 判据不自相矛盾）。 */
  const chapterFaces = await readChapterFaceRows(ops, stampId)
  const previousBases = chapterFaces.filter(
    (row) => rowKeyOf(row) !== targetKey && row && row.is_primary === true
  )
  const previousBaseFaceId = previousBases.length > 0 ? rowKeyOf(previousBases[0]) : null
  const writeFlagOf = (row, value) => {
    const rowDocId = text(row && row._id)
    const match = rowDocId !== '' ? { _id: rowDocId } : { id: rowKeyOf(row) }
    return ops.persist({
      writes: [
        {
          kind: 'update',
          collection: ops.COLLECTIONS.faces,
          match,
          doc: { is_primary: value },
          expectAtLeast: 1
        }
      ]
    })
  }
  /* ④-③ 先关旧 base（**逐个** `false`；数据异常出现多枚 true 时一并关掉 ⇒ 恢复「恰一枚」）。 */
  const cleared = []
  for (const row of previousBases) {
    try {
      await writeFlagOf(row, false)
      cleared.push(row)
    } catch (error) {
      const diagnosis = text(error && error.message) || 'unknown'
      /* 关旧 base 中途失败 ⇒ 把**已关掉的**还原成 `true`，回到调用前的状态。 */
      const unrestored = []
      for (const done of cleared) {
        try {
          await writeFlagOf(done, true)
        } catch {
          unrestored.push(rowKeyOf(done))
        }
      }
      if (unrestored.length > 0) {
        return deny(
          REASONS.STORAGE_UNAVAILABLE,
          `舊主印面（${rowKeyOf(row)}）關閉失敗，且回滾未完全成功（未還原：${unrestored.join('、')}）⇒ 該章可能暫無主印面，請重放本操作自愈。（診斷：${diagnosis}）`
        )
      }
      return deny(
        REASONS.STORAGE_UNAVAILABLE,
        `舊主印面（${rowKeyOf(row)}）關閉失敗 ⇒ 已回滾到原狀（主印面未變），本次未切換、可重試。（診斷：${diagnosis}）`
      )
    }
  }
  /* ④-④ 再把目标置 `true`；失败 ⇒ **回滚旧 base 为 `true`**（绝不留零 base）。 */
  try {
    await writeFlagOf(faceRow, true)
  } catch (error) {
    const diagnosis = text(error && error.message) || 'unknown'
    const unrestored = []
    for (const row of cleared) {
      try {
        await writeFlagOf(row, true)
      } catch {
        unrestored.push(rowKeyOf(row))
      }
    }
    if (unrestored.length > 0) {
      return deny(
        REASONS.STORAGE_UNAVAILABLE,
        `主印面切換失敗（face_id：${faceId}），且回滾舊主印面未完全成功（未還原：${unrestored.join('、')}）⇒ 該章可能暫無主印面，請重放本操作自愈。（診斷：${diagnosis}）`
      )
    }
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `主印面切換失敗（face_id：${faceId}）⇒ 已把舊主印面回滾為 true、主印面未變，可重試。（診斷：${diagnosis}）`
    )
  }
  /* ⑤ 成功恰 3 键。 */
  return { ok: true, face_id: faceId, previous_base_face_id: previousBaseFaceId }
}

module.exports = {
  migrateEdgeFaces,
  deleteWholeSealImage,
  setBaseFace,
  MIGRATE_EDGE_FACES_ALLOWED_KEYS,
  MIGRATE_EDGE_FACES_DEFAULT_LIMIT,
  MIGRATE_EDGE_FACES_MAX_LIMIT,
  MIGRATE_EDGE_FACES_READOUT_KEYS,
  DELETE_WHOLE_SEAL_IMAGE_ALLOWED_KEYS,
  DELETE_WHOLE_SEAL_IMAGE_READOUT_KEYS,
  SET_BASE_FACE_ALLOWED_KEYS,
  SET_BASE_FACE_READOUT_KEYS,
  /* 纯函数（供离线自检直接断言） */
  faceBelongsToStamp
}
