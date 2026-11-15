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
 *     `corrections_kept`）；读走 `ops.readRows` / `ops.readAllGuarded`（判定类读面**翻页取全**，
 *     见 ⑩）、删行走 `ops.deleteRow`、删对象走 `ops.deleteImageObjectsOfRow`（**候选单点**：
 *     `storage_key` 优先 → `sha` 派生后缀族逐个试 → 行内其它键、命中即停）、落盘走 `ops.persist`。
 *  ⑨ **審計載體 preflight（本單新增）**：**任何删行之前**先
 *     `await ops.ensureCollection(ops.COLLECTIONS.adminAudit)`（建集只在 `ops.js` 内做；
 *     **不新造集合名** —— 名称仍只活在 `ops.js::COLLECTIONS`，规范在册 §3.33.3 第 14 項 /
 *     AC-373）。抛错 ⇒ **直接 `STORAGE_UNAVAILABLE` ＋ 零写入**（此时尚未删任何行）；
 *     成功（`created` / `exists`）才继续删行确定序 —— **「審計載體沒有 ⇒ 就不刪」**。
 *  ⑩ **静默截断显式化 / 请求批量化 / 回执判据统一（2026-11-15 优化单 P0-2 / P1-5 / P1-6）**：
 *     · **判定类读面**（本印印面、全量印面共用分母、照片与勘误保留计数、同摘要去重）一律改
 *       `ops.readAllGuarded` **翻页取全**（硬上限 20000 行）；`truncated === true` ⇒
 *       `STORAGE_UNAVAILABLE` **结构化拒绝**（判据件 §P0-2：宁可拒绝，绝不拿漏行的集合给结论）。
 *       旧护栏 `REFERENCE_SCAN_LIMIT`(1000) / `IMAGE_REFERENCE_LIMIT`(64) **已撤除**。
 *     · **N+1 批量化**：影像行改 `id ∈ imageIds` **一次批量读 + `Map` 查表**（`imageRowsByIds`），
 *       删行 / 删对象两个循环内**零读库**。
 *     · **删后读回确认**：`deleted.images` / `deleted.faces` 不再「`deleteRow` resolve 即成功」——
 *       三面按**同一标识**（`_id ∈ 已删清单`）**批量重读**，任一行仍在 / 读失败 ⇒ 结构化失败
 *       （不报假成功）；确认点在审计行与编号释放**之前**。
 *     · **不变**：op 名 / 载荷与回包键面 / `reason` 字面值 / 删除语义（保留照片与勘误行、
 *       编号写 `released` 供复用）。
 *
 * 存储纪律：本文件**零集合名字面、零取库句柄字面**（一切读写经 `lib/ops.js` 的既有导出；
 * 集合名只活在 `ops.js` 的 `COLLECTIONS` 登记表与 `COUNTERS_COLLECTION` 导出面）；
 * **唯一例外（P1-5 批量读）**：`rowsByFieldIn` 经既有导出 `ops.resolveDb()` 只取**查询算子
 * `db.command.in`** 用于拼 `match`（不据此另建查询、不另立第二套行读 —— 查询仍交 `ops.readRows`；
 * 无 `in` 算子 ⇒ 退逐 key 窄读）。
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

/* **P0-2（2026-11-15 优化单｜静默截断 → 显式）**：旧护栏 `REFERENCE_SCAN_LIMIT`（1000）与
   `IMAGE_REFERENCE_LIMIT`（64）已**全线撤除** —— 它们正是「到顶即静默停」的来源：
   · 引用汇总漏行 ⇒ 少删本印印面 / 少计保留照片与勘误；
   · 同摘要判定漏行 ⇒ 误判「无他行共用」⇒ **误删他行仍在用的对象**。
   判定类读面一律改 `ops.readAllGuarded` **翻页取全**，取不全（`truncated === true`）⇒ 结构化拒绝。 */

/** **判定类翻页取全的硬上限**（与 `lib/ops.js::readAllGuarded` 的默认 `SCAN_HARD_CAP` 同值：20000 行）。 */
const SEAL_SCAN_CAP = 20000

/** **判定类读面「取不全」的拒绝文案**：逐字同 `lib/ops.js::TRUNCATED_SCAN_MESSAGE`（本单**不碰
 *  `ops.js`** ⇒ 同一字面在此登记；两处必须逐字一致，离线自检可直接对拍）。 */
const TRUNCATED_SCAN_MESSAGE = '集合行數超出可校驗範圍（>20000 行），本次零寫入；請縮小範圍後重試。'

/** **批量窄读**的单批键数（`where in` 一次查询；超出切批 ⇒ 读次仍为 O(n/100)，非逐行 N 次）。 */
const ID_BATCH_SIZE = 100

/** 摘要形态（64 位小写十六进制）。 */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** 对象键形态（内容寻址 `xiai/images/<摘要前两位>/<摘要>.<扩展名>`）—— **非集合名**：它在本文件
 *  只作**导出面**（`module.exports` 既有键，实现零改）；**删对象的候选展开单点在 `lib/ops.js**
 *  `deleteImageObjectsOfRow`**（本文件零第二套键推导）。 */
const IMAGE_OBJECT_KEY_PATTERN = /^xiai\/images\/[0-9a-f]{2}\/[0-9a-f]{64}\.(png|webp|jpg|jpeg)$/

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
 *
 * **P0-2（判定类）**：每一读点改 `ops.readAllGuarded` **翻页取全**（旧版单次 `limit: 1000`
 * 到顶即静默停 ⇒ 本印印面可能漏删、保留照片 / 勘误可能少计）。取不全 ⇒ 回 `truncated: true`，
 * 由调用方**结构化拒绝**（判定类宁可拒绝，绝不拿漏行的集合给结论）。
 * @param {object} ops `lib/ops.js` 模块
 * @param {string} collection 集合名（调用方一律经 `ops.COLLECTIONS` 取值）
 * @param {string[]} fields 检索字段族（兼容规范键与既落盘别名）
 * @param {string[]} keys 检索键族（该印的 `sid` / `stamp_id` / 行 `id` / 入参）
 * @returns {Promise<{ rows: object[], truncated: boolean }>} 去重后的行表 ＋ 是否取不全
 */
async function rowsReferencing(ops, collection, fields, keys) {
  const seen = new Map()
  let truncated = false
  for (let k = 0; k < keys.length; k += 1) {
    for (let f = 0; f < fields.length; f += 1) {
      const scan = await ops.readAllGuarded(collection, {
        match: { [fields[f]]: keys[k] },
        cap: SEAL_SCAN_CAP
      })
      if (scan.truncated) truncated = true
      scan.rows.forEach((row) => {
        const key = rowKeyOf(row) || `anon-${seen.size}`
        if (!seen.has(key)) seen.set(key, row)
      })
    }
  }
  return { rows: Array.from(seen.values()), truncated }
}

/* --------------------------------------------------------------------------- *
  **批量窄读（P1-5｜循环外一次批量取）** —— 读仍是 `ops.readRows`，本文件零第二套行读
 * --------------------------------------------------------------------------- */

/**
 * **`field ∈ values` 一次批量读**（`where in` 主路 ⇒ 逐 key 窄读退路）。
 *
 * 为什么需要退路：`db.command.in` 是**服务端算子**，注入式内存假体（离线自检）与个别 SDK
 * 版本没有它。「一次批量取」不得以牺牲可测性为代价 —— 故主路失败即退**逐 key 窄读**；
 * **真存储故障会在退路里再次抛出**（原样上抛，绝不吞成「零行」），故退路不掩错。
 * @param {object} ops `lib/ops.js` 模块
 * @param {string} collection 集合名
 * @param {string} field 检索字段（`id` / `_id`）
 * @param {string[]} values 检索键族（内部去重保序）
 * @returns {Promise<object[]>} 行表（可能少于键数：无行即无行）
 */
async function rowsByFieldIn(ops, collection, field, values) {
  const unique = uniqueTexts(values)
  if (unique.length === 0) return []
  const db = typeof ops.resolveDb === 'function' ? ops.resolveDb() : null
  const command = db && db.command
  if (command && typeof command.in === 'function') {
    try {
      const rows = await ops.readRows(collection, { [field]: command.in(unique) }, { limit: unique.length })
      return Array.isArray(rows) ? rows : []
    } catch (error) {
      /* 退路（**不吞真故障**）：算子不被支持 / 形态不符 ⇒ 逐 key 窄读；
         真故障会在下面这次读里再次抛出，仍由 `index.js` 转 `STORAGE_UNAVAILABLE`。 */
    }
  }
  const rows = []
  for (let index = 0; index < unique.length; index += 1) {
    const one = await ops.readRows(collection, { [field]: unique[index] }, { limit: 1 })
    one.forEach((row) => rows.push(row))
  }
  return rows
}

/**
 * **本印全部影像行（循环外一次批量取；分块 `ID_BATCH_SIZE`）**。
 *
 * 旧写法逐影像 id 串行读（N 次往返）⇒ 现按 `id ∈ imageIds` 批量读、建 `Map` 查表，
 * **循环内零读库**（`lib/ops.js` 的 P1-5 口径：`where in` 或一次读后 `Map` 查表）。
 * @param {object} ops `lib/ops.js` 模块
 * @param {string[]} imageIds 影像 id 表（去重保序）
 * @returns {Promise<Map<string, object>>} 影像 id ⇒ 行（无行则不在表内）
 */
async function imageRowsByIds(ops, imageIds) {
  const ids = uniqueTexts(imageIds)
  const byId = new Map()
  for (let start = 0; start < ids.length; start += ID_BATCH_SIZE) {
    const chunk = ids.slice(start, start + ID_BATCH_SIZE)
    const rows = await rowsByFieldIn(ops, ops.COLLECTIONS.images, 'id', chunk)
    rows.forEach((row) => {
      const key = text(row && row.id) || text(row && row._id)
      if (key !== '' && !byId.has(key)) byId.set(key, row)
    })
  }
  return byId
}

/**
 * **删后读回确认（P1-6）**：按 `_id ∈ docIds` **批量重读**，回**仍存在**的行 id 表。
 *
 * 判据统一口径（样板 ＝ `lib/books.js::setImageBook`）：**不得以写回执判成功** ——
 * `deleteRow` resolve 只说明「调用没抛」，不说明「行真没了」；本函数把「还看得见」逐条列出，
 * 由调用方**结构化失败**（读抛错亦由调用方转失败）。空表 ⇒ 确认已消失。
 * @param {object} ops `lib/ops.js` 模块
 * @param {string} collection 集合名
 * @param {string[]} docIds 已删行的文档 `_id` 表
 * @returns {Promise<string[]>} 仍在的行 `_id`（空表 ＝ 全部确认已消失）
 */
async function remainingRowIds(ops, collection, docIds) {
  const ids = uniqueTexts(docIds)
  const remaining = []
  for (let start = 0; start < ids.length; start += ID_BATCH_SIZE) {
    const chunk = ids.slice(start, start + ID_BATCH_SIZE)
    const rows = await rowsByFieldIn(ops, collection, '_id', chunk)
    rows.forEach((row) => {
      const id = text(row && row._id)
      if (id !== '' && chunk.indexOf(id) !== -1 && remaining.indexOf(id) === -1) remaining.push(id)
    })
  }
  return remaining
}

/* --------------------------------------------------------------------------- *
  主流程
 * --------------------------------------------------------------------------- */

/**
 * **刪一枚印章（＋編號釋放）**（管理员面；服务端裁决）。
 * 顺序（**判定全部早于删行**）：① 载荷形态 → ② 封闭键面 → ③ 管理员门（任何读之前）
 * → ④ `seal_id` / `reason` 值域 → ⑤ 印章行三形态检索 → ⑥ 引用汇总（印面 / 影像 / 共用判定
 * / 照片与勘误只读计数 / 计数器读；判定类读面**翻页取全**、取不全即结构化拒绝）→ ⑥⁺ **審計載體 preflight**
 * （`ops.ensureCollection`；**任何删行之前**；失败 ⇒ `STORAGE_UNAVAILABLE` ＋ 零写入）
 * → ⑦ 删非共用影像行 ＋ 删对象 → ⑧ 删全部印面行
 * → ⑨ 删印章行 → ⑨⁺ **删后读回确认**（`_id ∈ 已删清单` 批量重读；仍在 / 读失败 ⇒ 结构化失败）
 * → ⑩ 审计行 → ⑪ **編號釋放**（最后一步）→ ⑫ 成功回包恰 4 键。
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
     影像行 / 计数器（編號釋放的落点）。任一读失败 ⇒ 原样上抛 ⇒ 零写入。
     **P0-2（判定类，逐处归类）**：
       · `ownFaces` —— 判定类：**本印要删哪些印面行** ＋ 编号释放的 `face_no` 来源；
       · `allFaces` —— 判定类：**共用影像保护**（其它印面是否仍引用同影像）；
       · `photoRows` / `correctionRows` —— 计数回报（`skipped.photos_kept` / `corrections_kept`，
         永不驱动删行），本可容忍截断；但回包键面冻结（恰 4 键、`skipped` 三键）**无处安放
         「僅統計前 N 行」提示** ⇒ 按判定类**一并拒绝**：宁可拒绝，也不让审计行上的「保留数」
         与「上屏提示」互斥地失真（代价仅当单印引用 > 20000 行）。
     三处均 `truncated === true` ⇒ 结构化拒绝，且**此刻尚未删任何行** ⇒ 「本次零寫入」为真。 */
  const ownFaceScan = await rowsReferencing(ops, ops.COLLECTIONS.faces, ['sealId', 'stamp_id'], referenceKeys)
  if (ownFaceScan.truncated) return failure(REASONS.STORAGE_UNAVAILABLE, TRUNCATED_SCAN_MESSAGE)
  const ownFaces = ownFaceScan.rows
  const photoScan = await rowsReferencing(ops, ops.COLLECTIONS.photos, ['sealId', 'stamp_id'], referenceKeys)
  if (photoScan.truncated) return failure(REASONS.STORAGE_UNAVAILABLE, TRUNCATED_SCAN_MESSAGE)
  const photoRows = photoScan.rows
  const correctionScan = await rowsReferencing(
    ops,
    ops.COLLECTIONS.corrections,
    ['sealId', 'stamp_id'],
    referenceKeys
  )
  if (correctionScan.truncated) return failure(REASONS.STORAGE_UNAVAILABLE, TRUNCATED_SCAN_MESSAGE)
  const correctionRows = correctionScan.rows
  /* 全量印面（**共用判定的分母**）：旧写法 `readRows(faces, {}, { limit: 1000 })` 到顶即静默停 ⇒
     超 1000 面后「其它印面」这一侧失真 ⇒ 可能把**仍被引用**的影像判成「不共用」而删掉对象。
     判定类 ⇒ 翻页取全；取不全 ⇒ 拒绝（此时零写入）。 */
  const allFaceScan = await ops.readAllGuarded(ops.COLLECTIONS.faces, { cap: SEAL_SCAN_CAP })
  if (allFaceScan.truncated) return failure(REASONS.STORAGE_UNAVAILABLE, TRUNCATED_SCAN_MESSAGE)
  const allFaces = allFaceScan.rows
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

  /* 影像行（**P1-5：循环外一次批量取**；无行 ⇒ 无行可删，不计入任何删数 —— **不编造读数**）。
     旧写法 `for (imageIds) await readRows(images, { id }, { limit: 1 })` ＝ N 次串行往返
     （一印 1 主图 ＋ 2 图边 ⇒ 常态 3 次，整章图多时线性增长）；现按 `id ∈ imageIds` 批量读、
     建 `Map` 查表 ⇒ **读次 = ceil(n/100)**，且下面所有循环内**零读库**。 */
  const imageRows = await imageRowsByIds(ops, imageIds)

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

  /* ⑨-① 非共用影像行 ＋ 尽量删对象（**共用者保留**；删对象失败不阻断、如实计数）。
     **P1-5**：影像行已在上游**一次批量取**（`imageRowsByIds`）⇒ 本循环**零读库**（除同摘要判定外）。
     **P1-6**：删行后不再「以 resolve 记成功」—— 逐条登记已删 `_id`，删行确定序走完后
     **一次批量读回确认「行真没了」**（见 ⑨-④）。 */
  const deletedImageDocIds = []
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
    deletedImageDocIds.push(docId)
    const rawDigest = text(row.sha256)
    const digest = rawDigest.toLowerCase()
    if (DIGEST_PATTERN.test(digest)) {
      /* 内容寻址去重保护：本行删后再读同摘要，**尚有其它行 ⇒ 只删行**（对象与他行原封）。
         **P0-2（判定类）**：旧版 `{ limit: 64 }` 到顶即静默停 ⇒ 同摘要行超 64 时可能漏见他行
         ⇒ **误删他行仍在用的对象**（不可回退的数据丢失）。故改翻页取全；取不全 ⇒ 拒绝继续
         （不再删对象、不报成功）。 */
      const othersScan = await ops.readAllGuarded(ops.COLLECTIONS.images, {
        match: { sha256: rawDigest },
        cap: SEAL_SCAN_CAP
      })
      if (othersScan.truncated) {
        return failure(
          REASONS.STORAGE_UNAVAILABLE,
          `同摘要影像行取不全（>20000 行）⇒ 無法確認物件是否仍被他行引用，故未刪物件、不報成功；影像行可能已刪且不可回退，請人工核對（sha256：${digest}）。`
        )
      }
      const stillShared = othersScan.rows.some((other) => rowKeyOf(other) !== docId)
      if (!stillShared) {
        /* 删对象一律走**候选单点** `ops.deleteImageObjectsOfRow`（行内 `storage_key` 优先 →
           `sha` 派生后缀族逐个试 → 行内其它键、**命中一件即停**；失败不抛、不阻断）。
           `deleted.objects` ＝ **实际删成功件数**；一件没删掉 ⇒ 计入 `objects_failed`
           （如实计数，不谎报已删）。 */
        const removedObjects = await ops.deleteImageObjectsOfRow(row)
        deleted.objects += removedObjects
        if (removedObjects === 0) deleted.objects_failed += 1
      }
    }
  }

  /* ⑨-② 本印全部印面行（逐条登记已删 `_id`，供 ⑨-④ 读回确认）。 */
  const deletedFaceDocIds = []
  for (let index = 0; index < ownFaces.length; index += 1) {
    const docId = rowKeyOf(ownFaces[index])
    if (docId === '') continue
    await ops.deleteRow(ops.COLLECTIONS.faces, docId)
    deleted.faces += 1
    deletedFaceDocIds.push(docId)
  }

  /* ⑨-③ **最后**删印章行（照片行 / 勘误行一律保留：零删行）。 */
  const sealDocId = rowKeyOf(sealRow) || sealId
  await ops.deleteRow(ops.COLLECTIONS.seals, sealDocId)

  /* ⑨-④ **删后读回确认（P1-6｜判据统一）** —— 样板 ＝ `lib/books.js::setImageBook`：
     「写调用没抛」≠「行真没了」（`delete()` 对**不存在**的行也不抛、平台回 `deleted: 0`）。
     故按**同一标识**（`_id ∈ 已删清单`）**批量重读**三面：
       · 任一行**仍在** ⇒ 结构化失败（不报假成功）；`deleted.*` 只作诊断，不进回包；
       · 读抛错 ⇒ 同样结构化失败（**没有确认**就不许说成功）。
     位置：在 ⑩ 审计行 / ⑪ 编号释放**之前** ⇒ 确认未过则审计行不落盘（不留「成功审计」假账）。
     文案如实：此刻**已有行被删**（不可回退）⇒ 不写「本次零寫入」。 */
  let stillPresent
  try {
    stillPresent = {
      images: await remainingRowIds(ops, ops.COLLECTIONS.images, deletedImageDocIds),
      faces: await remainingRowIds(ops, ops.COLLECTIONS.faces, deletedFaceDocIds),
      seals: await remainingRowIds(ops, ops.COLLECTIONS.seals, [sealDocId])
    }
  } catch (error) {
    return failure(
      REASONS.STORAGE_UNAVAILABLE,
      `刪除已送出，但讀回校驗失敗（seal_id：${sealId}）⇒ 不報成功；部分行可能已刪除，請重新整理確認。（診斷：${
        (error && error.message) || 'unknown'
      }）`
    )
  }
  const leftover = stillPresent.images.concat(stillPresent.faces, stillPresent.seals)
  if (leftover.length > 0) {
    return failure(
      REASONS.STORAGE_UNAVAILABLE,
      `刪除讀回未確認：${leftover.length} 行仍在（${leftover.slice(0, 5).join('、')}${
        leftover.length > 5 ? ' 等' : ''
      }；seal_id：${sealId}）⇒ 不報成功，請重試或人工核對。`
    )
  }

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
  /* **P0-2 口径面（只增键、供离线自检直接对拍）**：判定类翻页取全的硬上限 ＋ 取不全的拒绝文案
     （后者必须与 `lib/ops.js::TRUNCATED_SCAN_MESSAGE` 逐字一致 —— 本单不碰 `ops.js`）。 */
  SEAL_SCAN_CAP,
  TRUNCATED_SCAN_MESSAGE,
  deleteSeal
}
