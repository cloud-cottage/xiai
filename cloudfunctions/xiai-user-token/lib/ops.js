'use strict'
/**
 * 玺爱 · 用户写面 · **权威落盘**（写面 Phase A ＋ 本单新增「採信」）
 * ----------------------------------------------------------------------------
 * 本文件是**本函数唯一的持久化路径**（静态扫描判据：`collection(` 只在本文件出现，
 * 且集合名一律 `^xiai_` ⇒ **绝不碰 liwu 集合**）。
 *
 * 硬口径（逐条）：
 *   ① **创建者身份以服务端为准** ✗ 不采信前端自称：`identity` 由 `index.js` 从**令牌声明**派生
 *      （`uid = uidOf(sub)`、`phone = sub`），载荷里的任何身份类键一律 ⇒ `INVALID_FIELD` ＋ 零写入；
 *      **落盘行只落不透明 uid（`u-`＋sha256 前 16 位），不落手机号**（人类口径 ①②）。
 *   ② **判定全部在写之前**（缺字段 / 值域 / 字段面任一不过 ⇒ 返回拒绝，**不触库写**）；
 *   ③ **落库用管理端凭据**（`@cloudbase/node-sdk` 在函数运行环境内取凭据，**不入仓、不下发前端**）；
 *      `xiai_corrections` / `xiai_endorsements` 的 ACL 是 `PRIVATE` ⇒ **只能这样写**，前端直连 SDK 写必被拒；
 *   ④ **本文件不写任何密钥 / 手机号字面值**；`row` 里只落**派生结果**（uid / 手机号）。
 *
 * 本单（採信）追加的冻结机制：
 *   · **采信目标键 ＝ `(faceId, field, value)`**（严格防重 ⇒ 同值恒指同一条提交；按值精确字符串
 *     比较，**不做任何归一**：异体 / 标点差异都算不同的一段文字）；
 *   · **提交侧防重**：`submitCorrection` 在**任何写入之前**检查同 `(faceId, field, value)` 是否已有行
 *     （含云端：以服务端为准）⇒ 已有 ⇒ `DUPLICATE_VALUE` ＋ 零写入；
 *   · **新 op `endorseCorrection`**：幂等（同 `(faceId, field, value, user_id)` ⇒ `ALREADY_ENDORSED`
 *     ＋ 零写入）、**不得自采**（同值的提交人就是本人 ⇒ 拒）、成功时**两处落盘**
 *     （采信行 `xiai_endorsements`［私有］＋ 公开计数行 `xiai_endorsement_counts`［脱敏、零身份字段］）；
 *     计数由服务端**重算**并幂等 upsert（自愈：重试 / 重放不涨数）。
 *   · **公开计数面零身份字段**：`xi` 一律不下发 `user_id` / `user_phone`（本文件构造的计数行里根本没有）。
 */

const crypto = require('crypto')
const { REASONS, deny, normalizePhone } = require('./config.js')

/**
 * 集合白名单（封闭；**一律 `xiai_` 前缀**）。
 * 映射真源 ＝ `src/data/storage.js` 的 `STORAGE_KEYS`（＋ `xiai_` 前缀）。
 *   · `corrections`        ＝ 勘误私有行（既有）；
 *   · `endorsements`       ＝ **采信私有行**（本单新增；含 user_id［不透明 uid］⇒ PRIVATE；**不落 user_phone**）；
 *   · `endorsementCounts`  ＝ **公开计数行**（本单新增；脱敏：**零身份字段**、匿名可读）；
 *   · `correctionsPublic`  ＝ **公开只读脱敏投影集合**（V3 新增；＝ 已采纳勘误的跨浏览器投影，
 *     `_id='cp-<勘误单号>'`、键面封闭、**零身份字段**）。
 */
const COLLECTIONS = Object.freeze({
  corrections: 'xiai_corrections',
  endorsements: 'xiai_endorsements',
  endorsementCounts: 'xiai_endorsement_counts',
  correctionsPublic: 'xiai_corrections_public'
})

/**
 * 可勘误字段表（键 → 上屏顯示名）。
 * **真源 ＝ `src/services/corrections.js::MARKABLE_FIELDS`**；本表是**服务端副本**
 * （服务端要自己填 `field_label`，不能采信客户端给的显示名）。
 * ⇒ 该「同值」由 `scripts/verify-userwrite-pa.mjs` 的 `D2` **机械断言**（两表逐字相等），
 *   新增字段时两处必须同改，否则断言立即失败（**不让副本静默漂移**）。
 */
const MARKABLE_FIELDS = Object.freeze({
  seal_name: '印文',
  dynasty: '朝代',
  seal_type: '印面內容',
  face_style: '印面風格',
  author: '作者',
  transcription: '印文釋義'
})

/** 勘误提交载荷允许键（**固定属性 / 身份类键都不在其中**）。 */
const ALLOWED_KEYS = Object.freeze(['faceId', 'sealId', 'stampId', 'field', 'value', 'basis'])

/** 采信载荷允许键（**封闭键面**：`['faceId','sealId','stampId','field','value']`；身份类键一律拒）。 */
const ENDORSE_ALLOWED_KEYS = Object.freeze(['faceId', 'sealId', 'stampId', 'field', 'value'])

/**
 * 明令不可由载荷提供的业务键（防御性登记 ⇒ 报告里可逐字列出；不在 `ALLOWED_KEYS` 里即已拒绝，
 * 本表用于**把「身份类键」与「普通未知键」在文案上分开**，便于排障与取证）。
 */
const IDENTITY_KEYS = Object.freeze([
  'userId',
  'user_id',
  'user_phone',
  'uid',
  'phone',
  'role',
  'status',
  'created_at',
  'reviewer_id',
  'rewarded_at'
])

/** 自由文本上限（防无界写入；超限 ⇒ `INVALID_VALUE`）。 */
const MAX_TEXT_LENGTH = 500

/** 勘误初态（与 `src/services/corrections.js::CORRECTION_STATUS.PENDING` 逐字同值）。 */
const CORRECTION_PENDING = 'PENDING'

/** 公开计数行的 schema 版本（与 `src/services/endorsements.js::ENDORSEMENT_SCHEMA` 逐字同值）。 */
const ENDORSEMENT_SCHEMA = 'xiai-endorsement-counts-v1'

/** 采信行身份来源标记（取证用：本行的身份来自服务端令牌，不由前端自称）。 */
const ENDORSEMENT_IDENTITY_SOURCE = 'SERVER_TOKEN'

/** 采信行文档键前缀（确定性 ⇒ 重放落同一行）。 */
const ENDORSEMENT_ID_PREFIX = 'en-'

/** 公开计数行文档键前缀（确定性 ⇒ 同值恒指同一行）。 */
const ENDORSEMENT_COUNT_ID_PREFIX = 'e-'

/* ---------------------------------------------------------------------------
   管理员写面（V3：收敛到「登录令牌 ＋ 服务端手机号白名单」）
   ---------------------------------------------------------------------------
   本单把管理员写面（`reviewCorrection` / `setInviteReward`）从 `xiai-admin-token`
   搬到**用户令牌函数**：服务端接受**登录令牌**（本函数 `action:'issue'` 签发的用户令牌）
   ＋「令牌声明里的手机号 ∈ 管理员白名单（环境变量 `XIAI_ADMIN_PHONE`，挂在**本函数**上）」
   ⇒ 采纳 / 驳回、改邀请奖励**永不需要第二个码、零弹窗**。
   硬口径（逐条）：
     · **白名单真源 ＝ `XIAI_ADMIN_PHONE`**；手机号取自**服务端从令牌声明派生的
       `identity.phone`**，**绝不采信前端自称**；
     · **缺 / 空 env ⇒ 安全默认**：所有管理员类 op 一律**结构化拒绝 ＋ 零写入**
       （不得因未配置而放行、不得静默）；
     · **判定（身份白名单 ＋ 值域）全部在写之前**；
     · 失败形状恒为恰 3 键 `{ok:false, reason, message}`。
   真源副本（与 `cloudfunctions/xiai-admin-token/lib/ops.js` **逐字同值**，由
   `scripts/verify-admin-write-via-login.mjs` 机械断言相等 ⇒ 不让副本静默漂移）。
   --------------------------------------------------------------------------- */

/** 勘误三态（与 `src/services/corrections.js::CORRECTION_STATUS` 逐字同值）。 */
const CORRECTION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED'
})

/** 旧决定字面值 → 规范值（`APPROVED` 按采纳兼容；与管理员函数 `LEGACY_DECISION` 同口径）。 */
const LEGACY_DECISION = Object.freeze({ APPROVED: 'ACCEPTED' })

/** 允许的两种终端决定（此外一律 `INVALID_VALUE` ＋ 零写入）。 */
const DECISIONS = Object.freeze(['ACCEPTED', 'REJECTED'])

/* 采纳值域真源副本（真源 ＝ `src/data/seed.js`；与管理员函数 `VALUE_DOMAINS` 逐字同值）。 */
const DYNASTY_OPTIONS = Object.freeze([
  '先秦',
  '秦',
  '漢',
  '魏晉',
  '隋唐',
  '宋元',
  '明中期',
  '晚明',
  '清初',
  '清中期',
  '晚清',
  '民國',
  '新中國',
  '當代'
])

const FACE_CONTENT_OPTIONS = Object.freeze([
  '官印',
  '私印',
  '姓名印',
  '齋館印',
  '鑑藏印',
  '吉語印',
  '肖形印',
  '花押印',
  '閒章'
])

const FACE_STYLE_OPTIONS = Object.freeze([
  '三晉古璽',
  '楚古璽',
  '燕古璽',
  '齊古璽',
  '秦印',
  '漢白文鑄印',
  '漢玉印',
  '將軍急就章',
  '漢朱文',
  '朱白相間印',
  '魏晉印',
  '隋唐九疊篆印',
  '元朱文',
  '浙派',
  '鄧派',
  '歙派',
  '吳讓之印風',
  '趙之謙印風',
  '黃牧甫印風',
  '吳昌碩印風',
  '趙叔孺印風',
  '陳巨來印風',
  '來楚生印風'
])

/** 需值域门约束的字段 → 冻结真源（逐字段一对一；其余字段不受第二道门约束）。 */
const VALUE_DOMAINS = Object.freeze({
  dynasty: DYNASTY_OPTIONS,
  seal_type: FACE_CONTENT_OPTIONS,
  face_style: FACE_STYLE_OPTIONS
})

/** 审核载荷允许键（**封闭键面**；与 `src/services/corrections.js::REVIEW_PAYLOAD_KEYS` 逐字同值）。 */
const REVIEW_ALLOWED_KEYS = Object.freeze(['correction_id', 'decision', 'note'])

/** 邀请奖励载荷允许键（**封闭键面**：只有 `value`）。 */
const REWARD_ALLOWED_KEYS = Object.freeze(['value'])

/** 审核载荷里明令不可由前端提供的身份类键（防御性登记 ⇒ 文案上把「身份类」与「普通未知键」分开）。 */
const REVIEW_IDENTITY_KEYS = Object.freeze([
  'userId',
  'user_id',
  'user_phone',
  'uid',
  'phone',
  'role',
  'status',
  'created_at',
  'reviewed_at',
  'reviewer_id',
  'rewarded_at',
  'identity_source',
  'review_note'
])

/** 驳回理由上限（与数据层 `writeCorrectionDecision` / 管理员函数 `MAX_NOTE_LENGTH` 同值）。 */
const MAX_NOTE_LENGTH = 200

/** 勘误单号上限（防无界；超限 ⇒ `INVALID_VALUE`）。 */
const MAX_ID_LENGTH = 128

/** 公开只读投影行字段面（**封闭**；**零身份字段**；与管理员函数 `PUBLIC_PROJECTION_KEYS` 逐字同值）。 */
const PUBLIC_PROJECTION_KEYS = Object.freeze([
  'correction_id',
  'faceId',
  'sealId',
  'stamp_id',
  'field',
  'field_label',
  'value',
  'status',
  'reviewed_at',
  'updated_at',
  'schema'
])

/** 公开投影明令禁止的键（身份面 ＋ 用户自由文本 `basis`）；与投影键面交集必须为空。 */
const IDENTITY_PROJECTION_KEYS = Object.freeze([
  'userId',
  'user_id',
  'user_phone',
  'uid',
  'phone',
  'reviewer_id',
  'identity_source',
  'basis'
])

/** 公开投影 schema 版本（与管理员函数 `PUBLIC_SCHEMA` 逐字同值）。 */
const PUBLIC_SCHEMA = 'xiai-corrections-public-v1'

/** 公开投影行 id 前缀（`cp-<勘误单号>` ⇒ 确定性，同单重放恒同一行 ⇒ 幂等 upsert）。 */
const PUBLIC_ID_PREFIX = 'cp-'

/* ---------------------------------------------------------------------------
   DB 注入缝（**离线自检 / 宿主用**；生产不注入 ⇒ 走真实 `@cloudbase/node-sdk`）
   --------------------------------------------------------------------------- */

let dbProvider = null

/**
 * 注入 DB 实现（`() => database`；传非函数 ⇒ 清除注入）。
 * @param {null|function():object} fn
 */
function setOpsDbProvider(fn) {
  dbProvider = typeof fn === 'function' ? fn : null
}

/** 是否已注入（诊断读数用，**不含任何凭据**）。 */
function opsDbInjected() {
  return dbProvider !== null
}

/**
 * 取 DB 句柄。
 * 凭据来源：**函数运行环境注入的角色凭据**（node-sdk 自行读取）——本文件**不传任何密钥**；
 * envId 取运行期环境变量（缺位 ⇒ 交给 SDK 的「当前环境」语义，**不写死**）。
 */
function resolveDb() {
  if (dbProvider) return dbProvider()
  /* 延迟 require：离线自检（注入 DB）时**不需要**装 `@cloudbase/node-sdk`。 */
  const tcb = require('@cloudbase/node-sdk')
  const envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE || process.env.CLOUDBASE_ENV_ID || ''
  const app = envId ? tcb.init({ env: envId }) : tcb.init()
  return app.database()
}

function makeId() {
  return `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/** 不可逆摘要前 16 位（确定性文档键的**唯一**来源；不用于任何授权判定）。 */
function hash16(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16)
}

/** 采信行文档键：`(faceId, field, value, user_id)` 确定性派生 ⇒ 重放落同一行（幂等）。 */
function endorsementDocId(faceId, field, value, uid) {
  return `${ENDORSEMENT_ID_PREFIX}${hash16(JSON.stringify([faceId, field, value, uid]))}`
}

/** 公开计数行文档键：`e-<faceId>-<field>-<value 的 sha256 前 16 位>`（与前端 / 规范同构）。 */
function endorsementCountDocId(faceId, field, value) {
  return `${ENDORSEMENT_COUNT_ID_PREFIX}${faceId}-${field}-${hash16(value)}`
}

/**
 * 取查询响应里的行数组（形态容错；认不出 ⇒ `[]`，**明确空集、不猜**）。
 * 与 `src/data/cloudbase.js::rowsOfReply` 同口径（只读；本文件是服务端唯一读点）。
 */
function rowsOfReply(reply) {
  if (!reply) return []
  if (Array.isArray(reply)) return reply
  if (Array.isArray(reply.data)) return reply.data
  const data = reply.data || reply.result || null
  if (data && Array.isArray(data.list)) return data.list
  if (data && Array.isArray(data.data)) return data.data
  if (Array.isArray(reply.list)) return reply.list
  return []
}

/**
 * **读**（**唯一读点**）：按等值条件读某集合的行。
 * 失败 ⇒ 抛错（由 `index.js` 统一转 `STORAGE_UNAVAILABLE`，**绝不伪装 `FORBIDDEN`**）。
 * `collection(` 只在本文件出现 ⇒ 静态判据仍成立。
 * @param {string} collection 集合名（`^xiai_`）
 * @param {object} match 等值条件
 * @returns {Promise<Array<object>>}
 */
async function readRows(collection, match) {
  const db = resolveDb()
  const query = db.collection(collection)
  if (!query || typeof query.where !== 'function') throw new Error('DB_QUERY_UNSUPPORTED')
  return rowsOfReply(await query.where(match).get())
}

/* ---------------------------------------------------------------------------
   管理员写面：白名单门 ＋ 读数（**全部只读 / 判定，不触写**）
   --------------------------------------------------------------------------- */

/**
 * **管理员白名单门**（V3 唯一授权判据之一；**写之前**判定）。
 * 手机号取自**服务端从令牌声明派生的 `identity.phone`**（`index.js` 唯一来源）——
 * 这里只做「逐字等于 `XIAI_ADMIN_PHONE`」的比对，**绝不采信前端自称**。
 * 缺 / 空 env ⇒ **结构化拒绝 ＋ 零写入**（安全默认；**不因未配置而放行**）。
 * @param {{uid:string, phone:string}|null|undefined} identity 服务端派生身份
 * @param {string} adminPhone 白名单手机号（来自 `readConfig().adminPhone`；缺 / 空 ⇒ `''`）
 * @returns {null|{ok:false, reason:string, message:string}} 放行 ⇒ `null`
 */
function adminWhitelistDenial(identity, adminPhone) {
  const expected = normalizePhone(adminPhone)
  if (!expected) {
    /* 未配置 ⇒ **内部不可用**（不是「越权」）⇒ 与工程口径一致用 `STORAGE_UNAVAILABLE`；
       明文：**不得**因未配置而放行，也不得静默。 */
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      '管理員寫入面未配置（缺環境變量：XIAI_ADMIN_PHONE）⇒ 拒絕所有管理員類操作；本次零寫入。'
    )
  }
  if (!identity || !identity.phone) {
    return deny(REASONS.FORBIDDEN, '缺少可驗證的管理員身份；本次零寫入。')
  }
  if (normalizePhone(identity.phone) !== expected) {
    return deny(REASONS.FORBIDDEN, '僅管理員可以執行此操作（手機號不在白名單）；本次零寫入。')
  }
  return null
}

/** 归一化 `where(...).update(...)` 的返回为「受影响行数」（读不出 ⇒ `null`，不作强判）。 */
function updatedCountOf(result) {
  if (!result || typeof result !== 'object') return null
  const candidates = [result.updated, result.modified, result.matched, result.data && result.data.updated]
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  }
  return null
}

/** 归一化一行 `where(...).get()` / `doc(...).get()` 的返回（兼容 `{data:[...]}` 与裸数组）。 */
function rowsOf(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.data)) return result.data
  if (result && result.data && typeof result.data === 'object') return [result.data]
  return []
}

/**
 * 按勘误单号读**私有**行（`xiai_corrections`）。
 * 先按业务键 `id` 检索；未命中再按文档 `_id` 兜底（兼容以文档 id 直接落库的历史行）。
 * **只读**：不产生任何写入。与管理员函数 `readCorrectionRow` **同口径**。
 * @param {string} correctionId
 * @returns {Promise<{row:object, match:object}|null>} `match` ＝ 命中所用的检索式（更新时复用）
 */
async function readCorrectionRow(correctionId) {
  const db = resolveDb()
  const collection = db.collection(COLLECTIONS.corrections)
  const byId = await collection.where({ id: correctionId }).get()
  const rowsById = rowsOf(byId)
  if (rowsById.length > 0) return { row: rowsById[0], match: { id: correctionId } }
  const byDoc = await collection.doc(correctionId).get()
  const rowsByDoc = rowsOf(byDoc)
  if (rowsByDoc.length > 0) return { row: rowsByDoc[0], match: { _id: correctionId } }
  return null
}

/**
 * 由私有行 + 决定构造**公开只读投影行**（**封闭键面**；**零身份字段**）。
 * 与管理员函数 `buildProjection` **逐字同形**。
 */
function buildProjection(row, decision, at, correctionId) {
  const field = text(row.field)
  return {
    correction_id: text(row.id) || text(correctionId),
    faceId: text(row.faceId),
    sealId: text(row.sealId || row.stamp_id),
    stamp_id: text(row.stamp_id || row.sealId),
    field,
    field_label: text(row.field_label) || MARKABLE_FIELDS[field] || '',
    value: text(row.value),
    status: decision,
    reviewed_at: at,
    updated_at: at,
    schema: PUBLIC_SCHEMA
  }
}

/* ---------------------------------------------------------------------------
   op 注册面（每个 op 只**产出落盘计划**，落库在 `persist()`）
   --------------------------------------------------------------------------- */

const OPS = Object.freeze({
  /**
   * 提交勘误（**用户写路径**；单集合插入）。
   * **本单追加防重门**：在任何写入之前，若同 `(faceId, field, value)` 已有行 ⇒ `DUPLICATE_VALUE`
   * ＋ 零写入（同一段文字只允许一人提交，第二人应改用【採信】）。
   * @param {object} payload 载荷（允许键见 `ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份（唯一来源；载荷里的身份键无效）
   * @returns {Promise<{ok:true, op:string, row:object, plan:{collection:string, doc:object}}|{ok:false, reason:string, message:string}>}
   */
  async submitCorrection(payload, identity) {
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const faceId = text(payload.faceId)
    const sealId = text(payload.sealId)
    const stampId = text(payload.stampId)
    const field = text(payload.field)
    const value = text(payload.value)
    const basis = text(payload.basis)
    if (!faceId) return deny(REASONS.MISSING_REQUIRED, '缺少印面（faceId）⇒ 拒絕提交；本次零寫入。')
    if (Object.prototype.hasOwnProperty.call(MARKABLE_FIELDS, field) !== true) {
      return deny(REASONS.INVALID_FIELD, `該屬性不支持勘誤（field）：${field || '（空）'}；本次零寫入。`)
    }
    if (!value) return deny(REASONS.MISSING_REQUIRED, '缺少勘誤值（value）⇒ 拒絕提交；本次零寫入。')
    if (value.length > MAX_TEXT_LENGTH || basis.length > MAX_TEXT_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `勘誤文字超出上限（${MAX_TEXT_LENGTH} 字）⇒ 拒絕提交；本次零寫入。`)
    }
    if (!identity || !identity.uid || !identity.phone) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的提交人身份；本次零寫入。')
    }
    /* **提交侧防重（本单追加）**：同 `(faceId, field, value)` 已有行（含云端：以服务端为准）
       ⇒ 同一段文字只允许一人提交；第二人应改用【採信】。**判定在任何写入之前**（只读）。 */
    const duplicate = await readRows(COLLECTIONS.corrections, { faceId, field, value })
    if (duplicate.length > 0) {
      return deny(
        REASONS.DUPLICATE_VALUE,
        `該印面「${MARKABLE_FIELDS[field]}」已有完全相同的提交值「${value}」⇒` +
          '同一段文字只允許一人提交；若你贊同該值，請改用【採信】為它佐證；本次零寫入。'
      )
    }
    const row = {
      id: makeId(),
      faceId,
      sealId: sealId || stampId, // 规范字段：所属印章
      stamp_id: sealId || stampId, // 兼容别名：＝sealId，勿删
      userId: identity.uid, // 规范字段：提交人（**服务端派生、不可反推手机号**）
      user_id: identity.uid, // 兼容别名：＝userId（**服务端派生**）
      /* **业务行不再落手机号**（人类口径 ②）：新行无 `user_phone` 键；
         旧行保留不改、读路径容忍缺键（**不得据旧行仍含 `user_phone` 判负**）。 */
      identity_source: 'SERVER_TOKEN', // 取证用：本行的提交人身份来自服务端令牌，不由前端自称
      field,
      field_label: MARKABLE_FIELDS[field],
      value,
      basis,
      status: CORRECTION_PENDING,
      created_at: new Date().toISOString(),
      reviewed_at: null,
      reviewer_id: null,
      rewarded_at: null
    }
    return { ok: true, op: 'submitCorrection', row, plan: { collection: COLLECTIONS.corrections, doc: row } }
  },

  /**
   * **採信**（用户写路径；本单新增 op）：对他人同 `(faceId, field, value)` 的提交点「採信」，
   * 只作**佐证 / 可信度计数**，不改变对外展示（生效仍由管理员采纳决定）。
   *
   * 顺序（**全部判定与读取都在写入之前**）：
   *   ① 载荷键面（封闭：`ENDORSE_ALLOWED_KEYS`；身份类键 ⇒ `INVALID_FIELD`）；
   *   ② 值域门：字段 ∈ `MARKABLE_FIELDS`、faceId 非空、value 非空且 ≤ 500 字；
   *   ③ **不得自采**：同 `(faceId, field, value)` 的**提交人就是本人** ⇒ 拒（`FORBIDDEN`；
   *      理由用**待规范单确认的新字面值**，暂用 `FORBIDDEN` 并逐字登记）；
   *   ④ **幂等**：同 `(faceId, field, value, user_id)` 已有采信行 ⇒ `ALREADY_ENDORSED` ＋ 零写入；
   *   ⑤ 成功 ⇒ 两处落盘：采信行（私有）＋ 公开计数行（**重算 count**、幂等 upsert、零身份字段）。
   *
   * 采信行形状（服务端落盘、私有集合 `xiai_endorsements`）：
   *   `{ _id, faceId, sealId, stamp_id, field, value, user_id, identity_source:'SERVER_TOKEN', created_at }`
   *   （**不落手机号**：`user_id` 是不透明 uid；人类口径 ②）
   * 公开计数行形状（`xiai_endorsement_counts`、**零身份字段**）：
   *   `{ _id:`e-<faceId>-<field>-<value 的 sha256 前 16 位>`, faceId, sealId, stamp_id, field, value, count, updated_at, schema }`
   * @param {object} payload 载荷（允许键见 `ENDORSE_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   */
  async endorseCorrection(payload, identity) {
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => ENDORSE_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const faceId = text(payload.faceId)
    const sealId = text(payload.sealId)
    const stampId = text(payload.stampId)
    const field = text(payload.field)
    const value = text(payload.value)
    if (!faceId) return deny(REASONS.MISSING_REQUIRED, '缺少印面（faceId）⇒ 拒絕採信；本次零寫入。')
    if (Object.prototype.hasOwnProperty.call(MARKABLE_FIELDS, field) !== true) {
      return deny(REASONS.INVALID_FIELD, `該屬性不支持採信（field）：${field || '（空）'}；本次零寫入。`)
    }
    if (!value) return deny(REASONS.MISSING_REQUIRED, '缺少採信值（value）⇒ 拒絕採信；本次零寫入。')
    if (value.length > MAX_TEXT_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `採信文字超出上限（${MAX_TEXT_LENGTH} 字）⇒ 拒絕採信；本次零寫入。`)
    }
    if (!identity || !identity.uid || !identity.phone) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的採信人身份；本次零寫入。')
    }
    /* ③ **不得自采**：读同值的提交行，若提交人就是本人 ⇒ 拒（待规范单确认的**新字面值**，
       暂用 `FORBIDDEN` 并逐字登记 ⇒ 便于规范侧改名）。 */
    const submissions = await readRows(COLLECTIONS.corrections, { faceId, field, value })
    const submitters = submissions
      .map((item) => text(item && (item.user_id || item.userId)))
      .filter((id) => id !== '')
    if (submitters.indexOf(identity.uid) !== -1) {
      return deny(
        REASONS.FORBIDDEN,
        '該值就是你自己的提交，不能對自己的提交採信；本次零寫入。'
      )
    }
    /* ④ **幂等**：同 `(faceId, field, value, user_id)` 已有采信行 ⇒ 拒 ＋ 零写入。 */
    const mine = await readRows(COLLECTIONS.endorsements, {
      faceId,
      field,
      value,
      user_id: identity.uid
    })
    if (mine.length > 0) {
      return deny(
        REASONS.ALREADY_ENDORSED,
        '你已經採信過該值（同一段文字只記一次）；本次零寫入。'
      )
    }
    /* ⑤ 成功：构造两处落盘计划（采信行 ＋ 公开计数行）。 */
    const normalizedSeal = sealId || stampId
    const at = new Date().toISOString()
    const endorsementId = endorsementDocId(faceId, field, value, identity.uid)
    const countId = endorsementCountDocId(faceId, field, value)
    const row = {
      _id: endorsementId,
      faceId,
      sealId: normalizedSeal,
      stamp_id: normalizedSeal,
      field,
      value,
      user_id: identity.uid,
      /* **业务行不再落手机号**（人类口径 ②）：采信私有行只落不透明 uid。 */
      identity_source: ENDORSEMENT_IDENTITY_SOURCE,
      created_at: at
    }
    /* **计数重算（自愈）**：读该键的全部采信行，按 `_id` 去重后计数（含本次新增的那一行）
       ⇒ 重试 / 重放 / 并发落同一 `_id` 都不会把 count 涨多；**绝不**用「原 count ＋ 1」。 */
    const all = await readRows(COLLECTIONS.endorsements, { faceId, field, value })
    const ids = new Set(all.map((item) => text(item && (item._id || item.id))).filter((id) => id !== ''))
    ids.add(endorsementId)
    const count = ids.size
    const countRow = {
      _id: countId,
      faceId,
      sealId: normalizedSeal,
      stamp_id: normalizedSeal,
      field,
      value,
      count,
      updated_at: at,
      schema: ENDORSEMENT_SCHEMA
    }
    return {
      ok: true,
      op: 'endorseCorrection',
      row,
      /* 公开计数行（**零身份字段**；服务端下发面 ⇒ 前端只做镜像，不在前端重建）。 */
      projection: countRow,
      plan: {
        writes: [
          { kind: 'set', collection: COLLECTIONS.endorsements, id: endorsementId, doc: row },
          { kind: 'set', collection: COLLECTIONS.endorsementCounts, id: countId, doc: countRow }
        ]
      }
    }
  }
})

/* ---------------------------------------------------------------------------
   管理员写面 op 注册面（V3 新增；**登录令牌 ＋ 手机号白名单**）
   ---------------------------------------------------------------------------
   调用形状：`ADMIN_OPS[op](payload, identity, context)`，其中
     · `identity` ＝ **服务端从令牌声明派生**（`{uid:'u-'+sha256(手机号)前16位, phone:'<11 位>'}`）；
     · `context`  ＝ `{adminPhone:'<白名单手机号>', nowSeconds:<服务端秒>}`。
   `adminPhone` 来自 `readConfig().adminPhone`（**缺 / 空 ⇒ 白名单门结构化拒绝**）；
   `nowSeconds` 是**服务端唯一时源**（`reviewed_at` 由它派生）。
   每个 op 只**产出落盘计划**（或成功回包），落库一律在 `persist()`。
   --------------------------------------------------------------------------- */

const ADMIN_OPS = Object.freeze({
  /**
   * 审核勘误（**管理员写路径**；两处落盘：先公开脱敏投影、后私有状态）。
   * 判定顺序（**全部在写之前**）：① 管理员白名单门 → ② 载荷形态 / 键面 →
   * ③ 单号 / 决定值域 / 理由长度 → ④ 读私有行 → ⑤ 存在性 / 状态门（仅 `PENDING` 可审）→
   * ⑥ 采纳值域门（R-20 / R-30 / R-31）。
   * @param {object} payload 载荷（允许键见 `REVIEW_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份（唯一来源）
   * @param {{adminPhone?:string, nowSeconds?:number}} [context] 白名单手机号 ＋ 服务端时钟（秒）
   * @returns {Promise<{ok:true, op:string, row:object, projection:object,
   *          plan:{op:string, writes:Array<object>}}|{ok:false, reason:string, message:string}>}
   */
  async reviewCorrection(payload, identity, context) {
    /* ① 管理员白名单门（**身份判据，写之前**；缺 env ⇒ 结构化拒绝 ＋ 零写入）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => REVIEW_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => REVIEW_IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const correctionId = text(payload.correction_id)
    if (!correctionId) {
      return deny(REASONS.MISSING_REQUIRED, '缺少勘誤單號（correction_id）⇒ 拒絕審覈；本次零寫入。')
    }
    if (correctionId.length > MAX_ID_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `勘誤單號超出上限（${MAX_ID_LENGTH} 字）⇒ 拒絕審覈；本次零寫入。`)
    }
    const rawDecision = text(payload.decision)
    const decision = LEGACY_DECISION[rawDecision] || rawDecision
    if (DECISIONS.indexOf(decision) === -1) {
      return deny(
        REASONS.INVALID_VALUE,
        `審覈決定「${rawDecision || '（空）'}」不在允許的 2 類之內（ACCEPTED 採納 / REJECTED 駁回；` +
          '舊字面值 APPROVED 按採納兼容）⇒ 拒絕寫入；本次零寫入。'
      )
    }
    const rawNote = payload.note === undefined || payload.note === null ? '' : payload.note
    if (typeof rawNote !== 'string') {
      return deny(REASONS.INVALID_VALUE, '駁回理由必須是文字 ⇒ 拒絕審覈；本次零寫入。')
    }
    const noteText = rawNote.trim()
    if (noteText.length > MAX_NOTE_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `駁回理由不得超過 ${MAX_NOTE_LENGTH} 字 ⇒ 拒絕審覈；本次零寫入。`)
    }
    /* ④ 读私有行（**只读**；网络 / 内部异常由此抛出 ⇒ `index.js` 转 `STORAGE_UNAVAILABLE`）。 */
    const found = await readCorrectionRow(correctionId)
    if (!found) {
      return deny(REASONS.INVALID_VALUE, `未找到該勘誤單（correction_id）：${correctionId}；本次零寫入。`)
    }
    const row = found.row
    const currentStatus = text(row.status)
    if (currentStatus !== CORRECTION_STATUS.PENDING) {
      return deny(
        REASONS.INVALID_VALUE,
        `該勘誤已審覈（當前狀態：${currentStatus || '（空）'}）⇒ 不可重複處理（終態不回退）；本次零寫入。`
      )
    }
    const accepted = decision === CORRECTION_STATUS.ACCEPTED
    /* ⑥ 采纳值域门（**写之前**）：被采纳的值必须 ∈ 冻结真源；不在 ⇒ 结构化拒绝 ＋ 零写入。 */
    if (accepted) {
      const domain = Object.prototype.hasOwnProperty.call(VALUE_DOMAINS, text(row.field))
        ? VALUE_DOMAINS[text(row.field)]
        : null
      if (domain && domain.indexOf(text(row.value)) === -1) {
        return deny(
          REASONS.INVALID_VALUE,
          `採納被拒：建議值不在「${MARKABLE_FIELDS[text(row.field)] || text(row.field)}」的凍結值域內（該勘誤建議「駁回」）；本次零寫入。`
        )
      }
    }
    /* 落盘计划：**先公开投影（派生、确定性 id ⇒ 幂等 upsert）、后私有状态（权威）**。 */
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const at = new Date(seconds * 1000).toISOString()
    const projection = buildProjection(row, decision, at, correctionId)
    const privatePatch = {
      status: decision,
      reviewed_at: at,
      reviewer_id: identity.uid
    }
    /* **僅駁回且有理由**才落 `review_note`（采納 / 空理由不出现该键）。 */
    if (!accepted && noteText !== '') privatePatch.review_note = noteText
    const decidedRow = Object.assign({}, row, privatePatch)
    return {
      ok: true,
      op: 'reviewCorrection',
      row: decidedRow,
      projection,
      plan: {
        op: 'reviewCorrection',
        writes: [
          {
            kind: 'set',
            collection: COLLECTIONS.correctionsPublic,
            id: `${PUBLIC_ID_PREFIX}${correctionId}`,
            doc: projection
          },
          {
            kind: 'update',
            collection: COLLECTIONS.corrections,
            match: found.match,
            doc: privatePatch,
            expectAtLeast: 1
          }
        ]
      }
    }
  },

  /**
   * 设置邀请奖励数值（**管理员写路径**；值域门 ＋ 白名单门，**均在任何写入之前**）。
   * 明文：**本 op 不产出云落盘计划** —— 站点配置键（`xiai:v1:invite-reward`）活在客户端
   * localStorage（链路 `admin.js → drive.js → storage.js`，与管理员函数 Phase 1 同口径）；
   * 本 op 的职责只是「服务端判身份 ＋ 判值域」，过门后才由**客户端**写该配置键。
   * @param {object} payload 载荷（允许键见 `REWARD_ALLOWED_KEYS`：只有 `value`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   * @param {{adminPhone?:string}} [context] 白名单手机号
   * @returns {{ok:true, op:string, value:number}|{ok:false, reason:string, message:string}}
   */
  setInviteReward(payload, identity, context) {
    /* ① 管理员白名单门（**身份判据，写之前**；缺 env ⇒ 结构化拒绝 ＋ 零写入）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => REWARD_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => REVIEW_IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const value = payload.value
    if (!Number.isInteger(value) || value < 0) {
      return deny(
        REASONS.INVALID_VALUE,
        '邀請獎勵必須是「非負整數」（非整數 / 負數 / 非數字一律拒收）；本次零寫入。'
      )
    }
    return { ok: true, op: 'setInviteReward', value }
  }
})

/**
 * 落盘（**唯一写点**）。
 *
 * 两种计划形态（互斥）：
 *   · `{collection, doc}`        ⇒ 单文档 `add()`（既有 `submitCorrection` 逐字沿用）；
 *   · `{writes:[{kind:'set', collection, id, doc} | {kind:'add', collection, doc}]}`
 *     ⇒ 按序执行（本单 `endorseCorrection` 的两处落盘；`set` ＝ 确定性文档键 upsert ⇒ 幂等）。
 *
 * **原子性说明（如实登记）**：CloudBase 无跨文档事务面（本工程既有 op 亦为单写）。
 * 本单把「采信行 → 公开计数行」排成**确定序**，且两键皆**确定性 `_id` ＋ 幂等 upsert**
 * ⇒ 任一步在重试后可自愈（不会重复计数、不会产生第二行）；中途失败 ⇒ 抛错，由 `index.js`
 * 转 `STORAGE_UNAVAILABLE`（**不伪装成功、不伪装 `FORBIDDEN`**）。
 * @param {{collection?:string, doc?:object, writes?:Array<object>}} plan
 * @returns {Promise<string>} 首要文档标识；失败 ⇒ 抛错
 */
async function persist(plan) {
  const db = resolveDb()
  if (plan && Array.isArray(plan.writes)) {
    let primary = ''
    for (const step of plan.writes) {
      if (step && step.kind === 'set') {
        await db.collection(step.collection).doc(step.id).set(step.doc)
        if (!primary) primary = String(step.id)
        continue
      }
      if (step && step.kind === 'update') {
        /* 按检索式 `update`（V3 管理员写面：私有行状态）；命中 0 行（并发改动 / 单号不存在）
           ⇒ 抛错 ⇒ 由 `index.js` 转 `STORAGE_UNAVAILABLE`（**不伪装成功 / 不伪装 FORBIDDEN**）。 */
        const result = await db.collection(step.collection).where(step.match).update(step.doc)
        const updated = updatedCountOf(result)
        if (typeof step.expectAtLeast === 'number' && updated !== null && updated < step.expectAtLeast) {
          throw new Error(`update-matched-too-few:${updated}`)
        }
        if (!primary) {
          const hit = await db.collection(step.collection).where(step.match).get()
          const rows = rowsOf(hit)
          if (rows.length > 0) primary = text(rows[0]._id) || text(rows[0].id)
        }
        continue
      }
      const result = await db.collection(step.collection).add(step.doc)
      const id = result && (result.id || result._id || (result.data && result.data.id))
      if (!primary) primary = id ? String(id) : ''
    }
    return primary
  }
  const result = await db.collection(plan.collection).add(plan.doc)
  const id = result && (result.id || result._id || (result.data && result.data.id))
  return id ? String(id) : ''
}

module.exports = {
  COLLECTIONS,
  MARKABLE_FIELDS,
  ALLOWED_KEYS,
  ENDORSE_ALLOWED_KEYS,
  IDENTITY_KEYS,
  MAX_TEXT_LENGTH,
  CORRECTION_PENDING,
  ENDORSEMENT_SCHEMA,
  ENDORSEMENT_IDENTITY_SOURCE,
  ENDORSEMENT_ID_PREFIX,
  ENDORSEMENT_COUNT_ID_PREFIX,
  /* V3 管理员写面（登录令牌 ＋ 手机号白名单）。 */
  CORRECTION_STATUS,
  LEGACY_DECISION,
  DECISIONS,
  DYNASTY_OPTIONS,
  FACE_CONTENT_OPTIONS,
  FACE_STYLE_OPTIONS,
  VALUE_DOMAINS,
  REVIEW_ALLOWED_KEYS,
  REWARD_ALLOWED_KEYS,
  REVIEW_IDENTITY_KEYS,
  MAX_NOTE_LENGTH,
  MAX_ID_LENGTH,
  PUBLIC_PROJECTION_KEYS,
  IDENTITY_PROJECTION_KEYS,
  PUBLIC_SCHEMA,
  PUBLIC_ID_PREFIX,
  OPS,
  ADMIN_OPS,
  setOpsDbProvider,
  opsDbInjected,
  resolveDb,
  adminWhitelistDenial,
  readCorrectionRow,
  buildProjection,
  persist
}
