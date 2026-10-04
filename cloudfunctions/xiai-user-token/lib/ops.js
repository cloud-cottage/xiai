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
 *   · `endorsements`       ＝ **采信私有行**（本单新增；含 user_id / user_phone ⇒ PRIVATE）；
 *   · `endorsementCounts`  ＝ **公开计数行**（本单新增；脱敏：**零身份字段**、匿名可读）。
 */
const COLLECTIONS = Object.freeze({
  corrections: 'xiai_corrections',
  endorsements: 'xiai_endorsements',
  endorsementCounts: 'xiai_endorsement_counts'
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
   *   `{ _id, faceId, sealId, stamp_id, field, value, user_id, user_phone, identity_source:'SERVER_TOKEN', created_at }`
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
      user_phone: normalizePhone(identity.phone),
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
      } else {
        const result = await db.collection(step.collection).add(step.doc)
        const id = result && (result.id || result._id || (result.data && result.data.id))
        if (!primary) primary = id ? String(id) : ''
      }
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
  OPS,
  setOpsDbProvider,
  opsDbInjected,
  resolveDb,
  persist
}
