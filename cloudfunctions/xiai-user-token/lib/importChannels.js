'use strict'
/**
 * 玺爱 · **批量导入通道（唯一实现点）**：`importFaceImages`（内容寻址影像行入册）
 * ＋ `importRelations`（`seal_link` / `person_relation` 两关联集合批量落库）
 * ============================================================================ *
 * 职责（本单范围）：两个**管理员批量通道**的业务逻辑只在此落地 —— 载荷封闭键面 / 逐条形态门 /
 * 对象字节自校 / 幂等去重 / 悬空判定 / 逐条落盘与如实计数；`lib/ops.js` 只做
 * **注册与薄委派**（不写第二套逻辑），`index.js` 只按 `op` 收窄透传读数键。
 *
 * 硬口径（逐条）：
 *  ① **管理员门在 `lib/ops.js` 的注册面第一行**（既有 `adminWhitelistDenial`；零读零写地拒）——
 *     本文件不再设第二道身份门（同一张门只有一处）。
 *  ② **载荷封闭**：`importFaceImages` 恰两键 `source` / `rows`（1〜200）；`importRelations`
 *     恰三键 `kind` / `source` / `rows`（1〜500）。未知键 ⇒ `INVALID_FIELD`；缺键 ⇒
 *     `MISSING_REQUIRED`；值域 / 形态不符 ⇒ `INVALID_VALUE`。**全部判定早于任何读写**。
 *  ③ **行级门在行内**：单行不合法 ⇒ 进 `failed[]`（`sha256` / `ref_id` ＋ `reason`）、
 *     **不中断整批**、不产生该行写入；`reason` **只用既有冻结值**（`MISSING_REQUIRED` /
 *     `INVALID_VALUE` / `STORAGE_UNAVAILABLE`）—— **零新增字面值**。
 *  ④ **集合名零字面**：一切集合经 `lib/ops.js` 的 `COLLECTIONS` 取（本文件零 `xiai_` 字面、
 *     零取库句柄字面、零 `.doc(` 调用）；读走 `ops.readRows`、写走 `ops.persist`、
 *     对象字节回读走 `ops.readArtifactBytes`。
 *  ⑤ **「集合不存在」按既有口径**：`lib/config.js::isCollectionNotExistError` 命中 ⇒ 读面视作
 *     零行（**幂等预查语义**：尚无行 = 尚无重复），真故障（ETIMEDOUT / 权限 / 5xx …）原样上抛
 *     并按该行 `STORAGE_UNAVAILABLE` 如实计数 —— **绝不把真故障吞成「无行」**。
 *  ⑥ **幂等**：影像按 `sha256`、关联按确定性行 `id`（`sl-` / `pr-` ＋ 组合摘要前 16 位）
 *     预查 ⇒ 已有行 ⇒ 计 `skipped`、**不改既有行**。
 *  ⑦ **悬空不拒收**（规范 §3.61.8 / AC-549）：关联 `ref` 未命中本体集合 ⇒ **照常落行**，
 *     行上记布尔 `unresolved: true`、`ref_name` 保留原值、回包计入 `unresolved` 计数。
 *  ⑧ **回包封闭**：`importFaceImages` 成功**恰 4 键**（`ok / written / skipped / failed`）、
 *     `importRelations` 成功**恰 5 键**（`ok / written / skipped / unresolved / failed`）；
 *     失败（含门拒）恒为**恰 3 键** `{ok:false, reason, message}`；**零新集合**（两新集合只在
 *     `ops.COLLECTIONS` 登记，**不进客户端云读面**）。
 *  ⑨ **不抛未捕获异常**：批级 `try/catch` 兜底，任何意外按 `STORAGE_UNAVAILABLE` 如实回报
 *     （文案带已写 / 已跳读数，**不谎称零写入**）。
 *
 * 存储 / 读点纪律：本文件**零集合名字面、零取库句柄字面**；单行失败的写入是**该行独立的一次
 * `persist`**（恰一个 `set` 步）⇒ 一行失败不影响他行。
 * ============================================================================ */

const crypto = require('crypto')
const { REASONS, deny, isCollectionNotExistError } = require('./config.js')
/* 实现单点在 `lib/ops.js`（读点 / 写点 / 对象字节回读 / 集合登记表 / 纯函数）；
   `lib/ops.js` 对本文件的依赖是**延迟 require**（薄委派内）⇒ 加载期无环。 */
const ops = require('./ops.js')

/* --------------------------------------------------------------------------- *
  常量面（封闭；客户端一律不可改）
 * --------------------------------------------------------------------------- */

/** `importFaceImages` 载荷封闭键面（恰两键）。 */
const FACE_IMAGE_IMPORT_ALLOWED_KEYS = Object.freeze(['source', 'rows'])

/** `importFaceImages` 单条影像行封闭键面（恰五键）。 */
const FACE_IMAGE_ROW_KEYS = Object.freeze(['sha256', 'bytes', 'mime', 'storage_key', 'kind'])

/** 单次入册条数下限 / 上限（1〜200）。 */
const FACE_IMAGE_MIN_ROWS = 1
const FACE_IMAGE_MAX_ROWS = 200

/** 影像类别取值（恰两值；**不静默归一**）。 */
const FACE_IMAGE_KINDS = Object.freeze(['FACE', 'EDGE'])

/** 成功回包键面（恰 4 键）。 */
const FACE_IMAGE_SUCCESS_KEYS = Object.freeze(['ok', 'written', 'skipped', 'failed'])

/** `importRelations` 载荷封闭键面（恰三键）。 */
const RELATION_IMPORT_ALLOWED_KEYS = Object.freeze(['kind', 'source', 'rows'])

/** 关联通道字面值（恰两值；**不静默归一**）。 */
const RELATION_KINDS = Object.freeze(['seal_link', 'person_relation'])

/** 单次落库条数下限 / 上限（1〜500）。 */
const RELATION_MIN_ROWS = 1
const RELATION_MAX_ROWS = 500

/** `seal_link` 单条行封闭键面（恰七键；规范 §4.1.21 传输面）。 */
const RELATION_SEAL_LINK_ROW_KEYS = Object.freeze([
  'source_seal_id',
  'link_kind',
  'ref_id',
  'ref_name',
  'bridge_item_id',
  'source_face',
  'seq'
])

/** `person_relation` 单条行封闭键面（恰四键；规范 §4.1.20 传输面）。 */
const RELATION_PERSON_ROW_KEYS = Object.freeze(['source_person_id', 'kind', 'ref_id', 'ref_name'])

/** 行 `id` 前缀（`seal_link` ＝ `sl-`、`person_relation` ＝ `pr-`）＋ 摘要位数。 */
const SEAL_LINK_ID_PREFIX = 'sl-'
const PERSON_RELATION_ID_PREFIX = 'pr-'
const RELATION_ID_HEX_LENGTH = 16

/** 成功回包键面（恰 5 键）。 */
const RELATION_SUCCESS_KEYS = Object.freeze(['ok', 'written', 'skipped', 'unresolved', 'failed'])

/**
 * 关联 `ref` 的**本体命中探测表**（kind 只决定**探测顺序**，不改变「命中任一在册键即算命中」）：
 *   · `xiai_items`   ← `source_item_id` / `as_book_id`（印谱侧两桥接键，见 §4.1.21 桥接列）；
 *   · `xiai_persons` ← `source_person_id` / `id`（印人侧）；
 *   · `xiai_seals`   ← `source_seal_id` / `id`（印章侧）。
 * 集合名一律经 `ops.COLLECTIONS` 取（本文件零集合名字面）。
 */
function relationRefProbesOf(relationKind, kindValue) {
  const items = { collection: ops.COLLECTIONS.items, fields: ['source_item_id', 'as_book_id'] }
  const persons = { collection: ops.COLLECTIONS.persons, fields: ['source_person_id', 'id'] }
  const seals = { collection: ops.COLLECTIONS.seals, fields: ['source_seal_id', 'id'] }
  const raw = ops.text(kindValue).toLowerCase()
  const isBookLike = raw === 'book' || raw.indexOf('book') !== -1 || raw.indexOf('item') !== -1 || raw.indexOf('譜') !== -1 || raw.indexOf('谱') !== -1
  const isSealLike = (raw.indexOf('seal') !== -1 || raw.indexOf('印') !== -1) && !isBookLike
  const isPersonLike = !isBookLike && !isSealLike
  let head = null
  if (relationKind === RELATION_KINDS[0]) {
    /* `seal_link`：`book` 印谱面 / 其余三值印人面。 */
    head = isBookLike ? items : persons
  } else if (isSealLike) {
    head = seals
  } else if (isPersonLike && (raw.indexOf('person') !== -1 || raw.indexOf('人') !== -1 || raw === 'yz' || raw.indexOf('zzkz') !== -1)) {
    head = persons
  } else {
    head = items
  }
  const rest = [items, persons, seals].filter((probe) => probe !== head)
  return [head, ...rest]
}

/* --------------------------------------------------------------------------- *
  公共小工具
 * --------------------------------------------------------------------------- */

/** 集合不存在 ⇒ 视作零行（既有判据单点）；其余错误**原样上抛**（由调用侧按行如实计数）。
 *  降级只如实告警**一次**（批内数百行时不刷屏）；文案繁體。 */
const warnedMissingCollections = new Set()
async function readRowsOrEmpty(collection, match, label) {
  try {
    return await ops.readRows(collection, match, { limit: 1 })
  } catch (error) {
    if (isCollectionNotExistError(error)) {
      if (!warnedMissingCollections.has(collection)) {
        warnedMissingCollections.add(collection)
        console.warn(
          `[xiai] ${label} 讀取時集合不存在 ⇒ 按零行繼續（冪等預查語義：尚無行 = 尚無重複）：`,
          ops.text(error && error.message)
        )
      }
      return []
    }
    throw error
  }
}

/** 结构化拒绝（恰 3 键；文案繁體）。 */
function fail(reason, message) {
  return deny(reason, message)
}

/** 单行失败项：**恰两键**（`sha256` / `ref_id` 在前、`reason` 在后；键序即回包序）。 */
function rowFailure(idValue, reason) {
  if (Object.prototype.hasOwnProperty.call(idValue, 'sha256')) return { sha256: idValue.sha256, reason }
  return { ref_id: idValue.ref_id, reason }
}

/** 行级键面门：形态 → 未知键 → 缺键。放行 ⇒ `null`；否则回 `{reason, message}`。 */
function rowShapeDenial(row, keys, label) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { reason: REASONS.INVALID_VALUE, message: `單條${label}必須是物件（封閉 ${keys.length} 鍵）；該條不落盤。` }
  }
  const unknown = Object.keys(row).filter((key) => keys.indexOf(key) === -1)
  if (unknown.length > 0) {
    return { reason: REASONS.INVALID_VALUE, message: `單條${label}含未知欄位：${unknown.join('、')}（封閉 ${keys.length} 鍵）；該條不落盤。` }
  }
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(row, key))
  if (missing.length > 0) {
    return { reason: REASONS.MISSING_REQUIRED, message: `單條${label}缺少欄位：${missing.join('、')}；該條不落盤。` }
  }
  return null
}

/** 行内值形态：只收 `string` / 有限 `number` / `null`（其余 ⇒ `{reason, message}`）。 */
function rowValueDenial(row, keys, label) {
  for (const key of keys) {
    const value = row[key]
    const type = typeof value
    if (type === 'string' || value === null) continue
    if (type === 'number' && Number.isFinite(value)) continue
    return { reason: REASONS.INVALID_VALUE, message: `單條${label}欄位（${key}）只能是文字 / 數字 / null；該條不落盤。` }
  }
  return null
}

/** 必填文本键（缺 / 空 ⇒ `MISSING_REQUIRED`；非字符串 ⇒ `INVALID_VALUE`）。 */
function requiredTextOf(source, key) {
  const value = source[key]
  if (value === undefined || value === null || ops.text(value) === '') {
    return { denial: fail(REASONS.MISSING_REQUIRED, `缺少必要欄位（${key}）；本次零寫入。`) }
  }
  if (typeof value !== 'string') {
    return { denial: fail(REASONS.INVALID_VALUE, `欄位（${key}）必須是字符串；本次零寫入。`) }
  }
  return { value }
}

/** `rows` 键面门（必有数组 ＋ 1〜max 条）。 */
function rowsDenial(rows, min, max) {
  if (rows === undefined || rows === null) return fail(REASONS.MISSING_REQUIRED, '缺少必要欄位（rows）；本次零寫入。')
  if (!Array.isArray(rows)) return fail(REASONS.INVALID_VALUE, '欄位（rows）必須是數組；本次零寫入。')
  if (rows.length < min || rows.length > max) {
    return fail(REASONS.INVALID_VALUE, `單批行數必須是 1〜${max} 條；本次零寫入。`)
  }
  return null
}

/** 服务端时戳（`context.nowSeconds` 优先；与其余 op 同一读法）。 */
function atOf(context) {
  const seconds = Number.isFinite(Number(context && context.nowSeconds))
    ? Math.floor(Number(context.nowSeconds))
    : Math.floor(Date.now() / 1000)
  return new Date(seconds * 1000).toISOString()
}

/* --------------------------------------------------------------------------- *
  通道一：`importFaceImages`（内容寻址影像行入册）
 * --------------------------------------------------------------------------- */

/** 单条影像行形态门（顺序逐字按派单口径：sha256 → bytes → mime → storage_key → kind）。 */
function faceImageRowDenial(row) {
  const shape = rowShapeDenial(row, FACE_IMAGE_ROW_KEYS, '影像行')
  if (shape) return shape
  const digest = row.sha256
  if (typeof digest !== 'string' || !ops.ARTIFACT_DIGEST_PATTERN.test(digest)) {
    return { reason: REASONS.INVALID_VALUE, message: '摘要（sha256）必須是 64 位小寫十六進制；該條不入册。' }
  }
  if (!Number.isInteger(row.bytes) || row.bytes <= 0) {
    return { reason: REASONS.INVALID_VALUE, message: '字節數（bytes）必須是正整數；該條不入册。' }
  }
  if (typeof row.mime !== 'string' || ops.text(row.mime).toLowerCase() !== ops.ARTIFACT_MIME) {
    return { reason: REASONS.INVALID_VALUE, message: '容器（mime）只收 image/tiff；該條不入册。' }
  }
  const key = row.storage_key
  if (typeof key !== 'string') {
    return { reason: REASONS.INVALID_VALUE, message: '對象鍵（storage_key）必須是字符串；該條不入册。' }
  }
  const matched = ops.ARTIFACT_OBJECT_KEY_PATTERN.exec(key)
  if (!matched) {
    return { reason: REASONS.INVALID_VALUE, message: '影像對象鍵形態不符（期望 xiai/images/<摘要前兩位>/<摘要>.tiff）；該條不入册。' }
  }
  if (matched[1] !== digest.slice(0, 2) || matched[2] !== digest) {
    return { reason: REASONS.INVALID_VALUE, message: '影像對象鍵內含的摘要與聲稱的 sha256 不一致；該條不入册。' }
  }
  if (typeof row.kind !== 'string' || FACE_IMAGE_KINDS.indexOf(row.kind) === -1) {
    return { reason: REASONS.INVALID_VALUE, message: '影像類別（kind）只能是 FACE 或 EDGE；該條不入册。' }
  }
  return null
}

/**
 * **批量影像入册**（管理员面）。
 * 顺序：载荷封闭两键 → `source` → `rows`（1〜200）→ 逐条：行级形态门 → 幂等预查（同
 * `sha256` 已有行 ⇒ `skipped`、不改既有行）→ **对象存在性与字节自校**（`ops.readArtifactBytes`
 * 回读、现算 sha256 与长度逐字比对）→ 内容寻址行落盘（**`stamp_id` / `seq` 本 op 不写**，
 * 留给采纳回填）→ 计数。单行失败进 `failed[]`、**不中断整批**。
 * @param {object} payload 封闭两键 `{source, rows}`
 * @param {{uid:string, phone:string}} identity 服务端派生身份（门已在注册面）
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<{ok:true, written:number, skipped:number, failed:Array<object>}|
 *                   {ok:false, reason:string, message:string}>}
 */
async function importFaceImages(payload, identity, context) {
  let written = 0
  let skipped = 0
  try {
    /* ① 载荷封闭恰两键（形态 → 未知键 / 身份类键）。 */
    const payloadDenial = ops.pointsPayloadDenial(payload, FACE_IMAGE_IMPORT_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    /* ② `source` 非空字符串。 */
    const sourceGate = requiredTextOf(payload, 'source')
    if (sourceGate.denial) return sourceGate.denial
    const source = sourceGate.value
    /* ③ `rows` 恰 1〜200 条。 */
    const rowsDenialResult = rowsDenial(payload.rows, FACE_IMAGE_MIN_ROWS, FACE_IMAGE_MAX_ROWS)
    if (rowsDenialResult) return rowsDenialResult
    const rows = payload.rows
    const at = atOf(context)
    const failed = []
    const seen = new Set()
    for (const row of rows) {
      const reportSha =
        row && typeof row === 'object' && !Array.isArray(row) && row.sha256 !== undefined && row.sha256 !== null
          ? String(row.sha256)
          : ''
      try {
        const denial = faceImageRowDenial(row)
        if (denial) {
          failed.push(rowFailure({ sha256: reportSha }, denial.reason))
          continue
        }
        const digest = row.sha256
        /* 幂等（批内 ＋ 库内同判）：同 `sha256` 已有行 ⇒ 计 skipped、**不改既有行**。 */
        if (seen.has(digest)) {
          skipped += 1
          continue
        }
        const existing = await readRowsOrEmpty(ops.COLLECTIONS.images, { sha256: digest }, '影像行集合')
        if (existing.length > 0) {
          seen.add(digest)
          skipped += 1
          continue
        }
        /* 对象存在性 ＋ 字节自校（复用既有回读单点；现算 sha256 与长度逐字比对）。 */
        const bytes = await ops.readArtifactBytes(row.storage_key)
        if (!bytes || bytes.length !== row.bytes) {
          failed.push(rowFailure({ sha256: digest }, REASONS.INVALID_VALUE))
          console.warn(
            `[xiai] importFaceImages 單條字節數不符（sha256：${digest.slice(0, 12)}…）⇒ 該條不入册（不中斷整批）。`
          )
          continue
        }
        const actual = crypto.createHash('sha256').update(bytes).digest('hex')
        if (actual !== digest) {
          failed.push(rowFailure({ sha256: digest }, REASONS.INVALID_VALUE))
          console.warn(
            `[xiai] importFaceImages 單條摘要不符（聲稱 ${digest.slice(0, 12)}… / 實算 ${actual.slice(0, 12)}…）⇒ 該條不入册（不中斷整批）。`
          )
          continue
        }
        /* 内容寻址行：`id` 取自既有唯一规则点（`buildDirectImageRow`）⇒ 同图恒同 `_id`。
           **`stamp_id` / `seq` 本 op 不写**（留给采纳回填，见 `reviewSealImport`）。 */
        const kind = row.kind
        const id = ops.buildDirectImageRow(
          { image_sha256: digest, image_bytes: row.bytes, image_storage_key: row.storage_key, kind },
          at
        ).id
        const doc = {
          sha256: digest,
          storage_key: row.storage_key,
          mime: ops.text(row.mime).toLowerCase(),
          bytes: row.bytes,
          kind,
          source,
          created_at: at,
          id,
          idem_key: `image:${digest}`
        }
        /* 单行独立一次 `persist`（恰一个 `set` 步；`_id` 由 `persist` 剔）⇒ 一行失败不拖累他行。 */
        await ops.persist({ writes: [{ kind: 'set', collection: ops.COLLECTIONS.images, id, doc }] })
        seen.add(digest)
        written += 1
      } catch (error) {
        failed.push(rowFailure({ sha256: reportSha }, REASONS.STORAGE_UNAVAILABLE))
        console.warn('[xiai] importFaceImages 單條失敗（不中斷整批）：', ops.text(error && error.message))
      }
    }
    return { ok: true, written, skipped, failed }
  } catch (error) {
    /* 批级兜底：**不抛未捕获异常**；文案带读数、**不谎称零写入**。 */
    return fail(
      REASONS.STORAGE_UNAVAILABLE,
      `批量影像入册中斷（已入册 ${written} 條、已跳過 ${skipped} 條）；請按回包讀數重放以自愈。（診斷：${ops.text(
        error && error.message
      )}）`
    )
  }
}

/* --------------------------------------------------------------------------- *
  通道二：`importRelations`（两关联集合批量落库；悬空不拒收）
 * --------------------------------------------------------------------------- */

/**
 * `ref` 本体命中判定（**纯判定、无写入**）：按 kind 决定的探测顺序逐个查，任一在册键命中 ⇒ `true`。
 * 「集合不存在」⇒ 该探测按零行（继续探测其余表）；真故障**原样上抛**（由行级 catch 计
 * `STORAGE_UNAVAILABLE`，绝不吞成「未命中」）。
 * @param {string} relationKind `seal_link` / `person_relation`
 * @param {string} kindValue 行内 `link_kind` / `kind`
 * @param {string} refId 被关联对象的来源内 id
 * @param {Map<string, boolean>} memo 批内探测记忆（同键只查一次）
 */
async function refResolved(relationKind, kindValue, refId, memo) {
  const probes = relationRefProbesOf(relationKind, kindValue)
  for (const probe of probes) {
    for (const field of probe.fields) {
      const memoKey = `${probe.collection}|${field}|${refId}`
      if (memo.has(memoKey)) {
        if (memo.get(memoKey)) return true
        continue
      }
      const rows = await readRowsOrEmpty(probe.collection, { [field]: refId }, '本體集合')
      const hit = rows.length > 0
      memo.set(memoKey, hit)
      if (hit) return true
    }
  }
  return false
}

/** 确定性行 `id`（前缀 ＋ 字段组合 sha256 前 16 位；组合逐字按规范；摘要走既有 `hash16` 单点）。 */
function relationIdOf(prefix, parts) {
  const joined = parts.map((value) => ops.text(value)).join('')
  return `${prefix}${ops.hash16(joined).slice(0, RELATION_ID_HEX_LENGTH)}`
}

/**
 * **批量关联落库**（管理员面；`xiai_seal_links` / `xiai_person_relations`）。
 * 顺序：载荷封闭三键 → `kind` 两值 → `source` → `rows`（1〜500）→ 逐条：行级键面与值形态门 →
 * 确定性行 `id` → **悬空判定**（未命中照常落行、行上 `unresolved: true`、`ref_name` 原值）→
 * 幂等预查（同 `id` 已有行 ⇒ `skipped`、不改既有行）→ 落盘 → 计数。
 * @param {object} payload 封闭三键 `{kind, source, rows}`
 * @param {{uid:string, phone:string}} identity 服务端派生身份（门已在注册面）
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<{ok:true, written:number, skipped:number, unresolved:number, failed:Array<object>}|
 *                   {ok:false, reason:string, message:string}>}
 */
async function importRelations(payload, identity, context) {
  let written = 0
  let skipped = 0
  let unresolved = 0
  try {
    /* ① 载荷封闭恰三键（形态 → 未知键 / 身份类键）。 */
    const payloadDenial = ops.pointsPayloadDenial(payload, RELATION_IMPORT_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    /* ② `kind` 恰两值（不静默归一）。 */
    const rawKind = payload.kind
    if (rawKind === undefined || rawKind === null || rawKind === '') {
      return fail(REASONS.MISSING_REQUIRED, '缺少必要欄位（kind）；本次零寫入。')
    }
    if (typeof rawKind !== 'string' || RELATION_KINDS.indexOf(rawKind) === -1) {
      return fail(REASONS.INVALID_VALUE, `關聯通道（kind）只能是 ${RELATION_KINDS.join(' / ')}；本次零寫入。`)
    }
    const relationKind = rawKind
    /* ③ `source` 非空字符串。 */
    const sourceGate = requiredTextOf(payload, 'source')
    if (sourceGate.denial) return sourceGate.denial
    const source = sourceGate.value
    /* ④ `rows` 恰 1〜500 条。 */
    const rowsDenialResult = rowsDenial(payload.rows, RELATION_MIN_ROWS, RELATION_MAX_ROWS)
    if (rowsDenialResult) return rowsDenialResult
    const rows = payload.rows
    const isSealLink = relationKind === RELATION_KINDS[0]
    const rowKeys = isSealLink ? RELATION_SEAL_LINK_ROW_KEYS : RELATION_PERSON_ROW_KEYS
    const rowLabel = isSealLink ? '印章關聯行' : '印人關聯行'
    const idPrefix = isSealLink ? SEAL_LINK_ID_PREFIX : PERSON_RELATION_ID_PREFIX
    const collection = isSealLink ? ops.COLLECTIONS.sealLinks : ops.COLLECTIONS.personRelations
    const at = atOf(context)
    const failed = []
    const probeMemo = new Map()
    for (const row of rows) {
      const reportRef =
        row && typeof row === 'object' && !Array.isArray(row) && row.ref_id !== undefined && row.ref_id !== null
          ? String(row.ref_id)
          : ''
      try {
        /* ⑤ 行级键面 ＋ 值形态门。 */
        const shape = rowShapeDenial(row, rowKeys, rowLabel)
        if (shape) {
          failed.push(rowFailure({ ref_id: reportRef }, shape.reason))
          continue
        }
        const valueDenial = rowValueDenial(row, rowKeys, rowLabel)
        if (valueDenial) {
          failed.push(rowFailure({ ref_id: reportRef }, valueDenial.reason))
          continue
        }
        /* 幂等键字段非空（缺键已在上面拦；此处拦「给了但空」）。 */
        const keyFields = isSealLink ? ['source_seal_id', 'link_kind', 'ref_id'] : ['source_person_id', 'kind', 'ref_id']
        const emptyKey = keyFields.find((key) => row[key] !== null && ops.text(row[key]) === '')
        if (emptyKey !== undefined) {
          failed.push(rowFailure({ ref_id: reportRef }, REASONS.MISSING_REQUIRED))
          continue
        }
        /* ⑥ 确定性行 `id`（组合逐字按规范）。 */
        const id = isSealLink
          ? relationIdOf(idPrefix, [source, row.source_seal_id, row.link_kind, row.ref_id])
          : relationIdOf(idPrefix, [source, row.source_person_id, row.kind, row.ref_id])
        /* ⑦ 悬空判定（先判后写 ⇒ 回包 `unresolved` 计的是**本批实际判定出的未命中行**）。
           **未命中一律不拒收**、`ref_name` 保留原值（§3.61.8 / AC-549）。 */
        const hit = await refResolved(relationKind, isSealLink ? row.link_kind : row.kind, ops.text(row.ref_id), probeMemo)
        const isUnresolved = !hit
        /* ⑧ 幂等：同 `id` 已有行 ⇒ 计 skipped、**不改既有行**。 */
        const existing = await readRowsOrEmpty(collection, { id }, rowLabel)
        if (existing.length > 0) {
          skipped += 1
          if (isUnresolved) unresolved += 1
          continue
        }
        const doc = Object.assign({}, row, {
          id,
          source,
          unresolved: isUnresolved,
          created_at: at
        })
        await ops.persist({ writes: [{ kind: 'set', collection, id, doc }] })
        written += 1
        if (isUnresolved) unresolved += 1
      } catch (error) {
        failed.push(rowFailure({ ref_id: reportRef }, REASONS.STORAGE_UNAVAILABLE))
        console.warn('[xiai] importRelations 單條失敗（不中斷整批）：', ops.text(error && error.message))
      }
    }
    return { ok: true, written, skipped, unresolved, failed }
  } catch (error) {
    /* 批级兜底：**不抛未捕获异常**；文案带读数、**不谎称零写入**。 */
    return fail(
      REASONS.STORAGE_UNAVAILABLE,
      `批量關聯落庫中斷（已落 ${written} 條、已跳過 ${skipped} 條）；請按回包讀數重放以自愈。（診斷：${ops.text(
        error && error.message
      )}）`
    )
  }
}

module.exports = {
  importFaceImages,
  importRelations,
  /* 键面 / 值域 / 回包键面（供离线自检直接断言；客户端不可改）。 */
  FACE_IMAGE_IMPORT_ALLOWED_KEYS,
  FACE_IMAGE_ROW_KEYS,
  FACE_IMAGE_KINDS,
  FACE_IMAGE_MIN_ROWS,
  FACE_IMAGE_MAX_ROWS,
  FACE_IMAGE_SUCCESS_KEYS,
  RELATION_IMPORT_ALLOWED_KEYS,
  RELATION_KINDS,
  RELATION_SEAL_LINK_ROW_KEYS,
  RELATION_PERSON_ROW_KEYS,
  RELATION_MIN_ROWS,
  RELATION_MAX_ROWS,
  RELATION_SUCCESS_KEYS,
  SEAL_LINK_ID_PREFIX,
  PERSON_RELATION_ID_PREFIX,
  /* 单条门（供离线自检逐条断言；与 op 内调用同一实现，零第二套）。 */
  faceImageRowDenial,
  relationIdOf
}
