'use strict'
/**
 * 玺爱 · 用户写面 · **权威落盘**（写面 Phase A）
 * ----------------------------------------------------------------------------
 * 本文件是**本函数唯一的持久化路径**（静态扫描判据：`collection(` 只在本文件出现，
 * 且集合名一律 `^xiai_` ⇒ **绝不碰 liwu 集合**）。
 *
 * 硬口径（逐条）：
 *   ① **创建者身份以服务端为准** ✗ 不采信前端自称：`identity` 由 `index.js` 从**令牌声明**派生
 *      （`uid = uidOf(sub)`、`phone = sub`），载荷里的任何身份类键一律 ⇒ `INVALID_FIELD` ＋ 零写入；
 *   ② **判定全部在写之前**（缺字段 / 值域 / 字段面任一不过 ⇒ 返回拒绝，**不触库**）；
 *   ③ **落库用管理端凭据**（`@cloudbase/node-sdk` 在函数运行环境内取凭据，**不入仓、不下发前端**）；
 *      `xiai_corrections` 的 ACL 是 `PRIVATE` ⇒ **只能这样写**，前端直连 SDK 写必被拒；
 *   ④ **本文件不写任何密钥 / 手机号字面值**；`row` 里只落**派生结果**（uid / 手机号）。
 */

const { REASONS, deny, uidOf, normalizePhone } = require('./config.js')

/**
 * 集合白名单（封闭；**一律 `xiai_` 前缀**）。
 * 映射真源 ＝ `src/data/storage.js` 的 `STORAGE_KEYS.corrections`（'corrections'）＋ `xiai_` 前缀。
 */
const COLLECTIONS = Object.freeze({
  corrections: 'xiai_corrections'
})

/**
 * 可勘误字段表（键 → 上屏顯示名）。
 * **真源 ＝ `src/services/corrections.js::MARKABLE_FIELDS`**；本表是**服务端副本**
 * （服务端要自己填 `field_label`，不能采信客户端给的显示名）。
 * ⇒ 该「同值」由 `scripts/verify-userwrite-pa.mjs` 的 `D4` **机械断言**（两表逐字相等），
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

/** 载荷允许键（**固定属性 / 身份类键都不在其中**）。 */
const ALLOWED_KEYS = Object.freeze(['faceId', 'sealId', 'stampId', 'field', 'value', 'basis'])

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

/* ---------------------------------------------------------------------------
   op 注册面（Phase A 只登记一个 op；每个 op 只**产出落盘计划**，落库在 `persist()`）
   --------------------------------------------------------------------------- */

const OPS = Object.freeze({
  /**
   * 提交勘误（**用户写路径**；单集合插入）。
   * @param {object} payload 载荷（允许键见 `ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份（唯一来源；载荷里的身份键无效）
   * @returns {{ok:true, op:string, row:object, plan:{collection:string, doc:object}}|{ok:false, reason:string, message:string}}
   */
  submitCorrection(payload, identity) {
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
    const row = {
      id: makeId(),
      faceId,
      sealId: sealId || stampId, // 规范字段：所属印章
      stamp_id: sealId || stampId, // 兼容别名：＝sealId，勿删
      userId: identity.uid, // 规范字段：提交人（**服务端派生**）
      user_id: identity.uid, // 兼容别名：＝userId（**服务端派生**）
      user_phone: normalizePhone(identity.phone), // **服务端记录**的提交人手机号
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
  }
})

/**
 * 落盘（**唯一写点**）。
 * @param {{collection:string, doc:object}} plan
 * @returns {Promise<string>} 文档标识（`add()` 的 `id`）；失败 ⇒ 抛错（由调用方转 `STORAGE_UNAVAILABLE`）
 */
async function persist(plan) {
  const db = resolveDb()
  const result = await db.collection(plan.collection).add(plan.doc)
  const id = result && (result.id || result._id || (result.data && result.data.id))
  return id ? String(id) : ''
}

module.exports = {
  COLLECTIONS,
  MARKABLE_FIELDS,
  ALLOWED_KEYS,
  IDENTITY_KEYS,
  MAX_TEXT_LENGTH,
  CORRECTION_PENDING,
  OPS,
  setOpsDbProvider,
  opsDbInjected,
  resolveDb,
  persist
}
