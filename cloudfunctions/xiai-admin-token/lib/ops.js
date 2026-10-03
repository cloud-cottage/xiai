'use strict'
/**
 * 玺爱 · 管理员写面 · **权威落盘**（写面 Phase 2：勘误审核 `reviewCorrection`）
 * ----------------------------------------------------------------------------
 * 本文件是**本函数唯一的持久化路径**（静态扫描判据：`collection(` 只在本文件出现，
 * 且集合名一律 `^xiai_` ⇒ **绝不碰 liwu 集合**）。
 *
 * 硬口径（逐条）：
 *   ① **审核人身份以服务端为准** ✗ 不采信前端自称：`identity` 由 `index.js` 从**令牌声明**派生
 *      （`uid = uidOf(sub)`＝`u-<手机号>`、`phone = sub`），载荷里的任何身份类键一律 ⇒ `INVALID_FIELD`；
 *   ② **判定全部在写之前**（载荷键面 / 单号 / 决定值域 / 理由长度 / 私有行存在性 / 状态门 /
 *      采纳值域门 —— 任一不过 ⇒ 返回拒绝，**不触库写**）；读私有行不是写；
 *   ③ **落库用管理端凭据**（`@cloudbase/node-sdk` 在函数运行环境内取凭据，**不入仓、不下发前端**）；
 *      `xiai_corrections` 的 ACL 是 `PRIVATE` ⇒ **只能这样写**，前端直连 SDK 写必被拒；
 *      新公开集合 `xiai_corrections_public` 是**脱敏投影**（**零身份字段**：无 userId / user_id /
 *      user_phone / reviewer_id / identity_source / basis / created_at），供全站只读展示；
 *   ④ **本文件不写任何密钥 / 手机号 / 验证码字面值**；`reviewer_id` 只落**派生结果**（`u-<手机号>`）；
 *   ⑤ **失败一律结构化**、**不抛未捕获异常**（异常由 `index.js` 转 `STORAGE_UNAVAILABLE`，
 *      **绝不伪装 `FORBIDDEN`**）。
 */

const { REASONS, deny, normalizePhone } = require('./config.js')

/**
 * 集合白名单（封闭；**一律 `xiai_` 前缀**）。
 * 私有真源映射 ＝ `src/data/storage.js` 的 `STORAGE_KEYS.corrections`（'corrections'）＋ `xiai_` 前缀；
 * `correctionsPublic` 为本单**新增**的公开只读脱敏投影集合。
 */
const COLLECTIONS = Object.freeze({
  corrections: 'xiai_corrections',
  correctionsPublic: 'xiai_corrections_public'
})

/** 勘误三态（与 `src/services/corrections.js::CORRECTION_STATUS` **逐字同值**）。 */
const CORRECTION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED'
})

/** 旧决定字面值 → 规范值（与数据层 `LEGACY_CORRECTION_STATUS` **同口径**：`APPROVED` 按采纳兼容）。 */
const LEGACY_DECISION = Object.freeze({ APPROVED: 'ACCEPTED' })

/** 允许的两种终端决定（可迁移值；此外一律 `INVALID_VALUE` ＋ 零写入）。 */
const DECISIONS = Object.freeze(['ACCEPTED', 'REJECTED'])

/**
 * 可勘误字段表（键 → 上屏顯示名）。
 * **真源 ＝ `src/services/corrections.js::MARKABLE_FIELDS`**；本表是**服务端副本**
 * （服务端要自己填 `field_label`，不能采信客户端给的显示名）。
 * ⇒ 该「同值」由 `scripts/verify-admin-review-op.mjs` 的 `D2` **机械断言**（两表逐字相等），
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

/* ---------------------------------------------------------------------------
   值域真源副本（**采纳**时必须 ∈ 真源 —— 与数据层 `writeCorrectionDecision`
   的第二道门 R-20 / R-30 / R-31 同口径）。
   真源 ＝ `src/data/seed.js` 的 `DYNASTY_OPTIONS` / `FACE_CONTENT_OPTIONS` / `FACE_STYLE_OPTIONS`；
   本处是服务端副本，由 `scripts/verify-admin-review-op.mjs` 的 `D4` **逐字断言相等**（不让副本漂移）。
   --------------------------------------------------------------------------- */
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

/** 载荷允许键（**固定属性 / 身份类键都不在其中**）。 */
const ALLOWED_KEYS = Object.freeze(['correction_id', 'decision', 'note'])

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
  'reviewed_at',
  'reviewer_id',
  'rewarded_at',
  'identity_source',
  'review_note'
])

/**
 * **公开投影明令禁止的键**（真正的身份面 ＋ 用户自由文本 `basis`）。
 * 公开集合是「**零身份字段**」的脱敏投影 ⇒ 其键面必须与本表**交集为空**
 * （由 `scripts/verify-admin-review-op.mjs` 的 `D4` / `B2c` 机械断言）。
 * 与 `IDENTITY_KEYS` 的区别：后者是**载荷防御性登记**（面更宽，含 `status` / `reviewed_at`
 * 一类**服务端受控**键 —— 它们会正常出现在投影里，只是不接受载荷提供）；本表只取「身份 / 私密」面。
 */
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

/** 驳回理由上限（与数据层 `writeCorrectionDecision` / 服务层 `MAX_REVIEW_NOTE_LENGTH` **同值**）。 */
const MAX_NOTE_LENGTH = 200

/** 勘误单号上限（防无界；超限 ⇒ `INVALID_VALUE`）。 */
const MAX_ID_LENGTH = 128

/**
 * 公开只读投影行字段面（**封闭**；**零身份字段**）。
 * 由 `scripts/verify-admin-review-op.mjs` 的 `A?`/`D5` 机械断言：投影键集恒等本表，
 * 且与 `IDENTITY_KEYS` 交集为空（**任何身份字段都进不了公开集合**）。
 */
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

/** 公开投影 schema 版本（投影行的自述版本；读面据此判形态）。 */
const PUBLIC_SCHEMA = 'xiai-corrections-public-v1'

/** 公开投影行 id 前缀（`cp-<勘误单号>` ⇒ **确定性**，同单重放恒同一行 ⇒ 天然幂等 upsert）。 */
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

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/** 归一化一行 `where(...).get()` / `doc(...).get()` 的返回（兼容 `{data:[...]}` 与裸数组）。 */
function rowsOf(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.data)) return result.data
  if (result && result.data && typeof result.data === 'object') return [result.data]
  return []
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

/* ---------------------------------------------------------------------------
   读私有行（**只读、非写**）——审核判定的依据
   --------------------------------------------------------------------------- */

/**
 * 按勘误单号读**私有**行（`xiai_corrections`）。
 * 先按业务键 `id` 检索；未命中再按文档 `_id` 兜底（兼容以文档 id 直接落库的历史行）。
 * **只读**：不产生任何写入。
 * @param {string} correctionId
 * @returns {Promise<{row:object, match:object}|null>} `match` ＝ 命中所用的检索式（更新时复用同一检索式）
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

/* ---------------------------------------------------------------------------
   公开投影（**脱敏**：从源行的白名单字段重建，绝不透传整行）
   --------------------------------------------------------------------------- */

/**
 * 由私有行 + 决定构造**公开只读投影行**（**封闭键面**；**零身份字段**）。
 * 只取展示所需：所属印面 / 属性 / 值 / 决定 / 审核时间；身份类与用户自由文本（`basis`）一律**不投影**。
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
   op 注册面（本单新增 reviewCorrection；每个 op 只**产出落盘计划**，落库在 `persist()`）
   --------------------------------------------------------------------------- */

const OPS = Object.freeze({
  /**
   * 审核勘误（**管理员写路径**；两处落盘：私有状态 ＋ 公开脱敏投影）。
   * 判定顺序（**全部在写之前**）：① 载荷形态 / 键面 → ② 单号 / 决定值域 / 理由长度 →
   * ③ 审核人身份（服务端派生）→ ④ 读私有行 → ⑤ 存在性 / 状态门（仅 `PENDING` 可审）→
   * ⑥ 采纳值域门（R-20 / R-30 / R-31）。
   * @param {object} payload 载荷（允许键见 `ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份（唯一来源；载荷里的身份键无效）
   * @param {number} nowSeconds 服务端时钟（秒；本函数唯一时源）
   * @returns {Promise<{ok:true, op:string, row:object, projection:object,
   *          plan:{op:string, writes:Array<object>}}|{ok:false, reason:string, message:string}>}
   */
  async reviewCorrection(payload, identity, nowSeconds) {
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
    if (!identity || !identity.uid || !identity.phone) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的審核人身份；本次零寫入。')
    }

    /* ④ 读私有行（**只读**；网络 / 内部异常由此函数抛出，由 `index.js` 转 `STORAGE_UNAVAILABLE`）。 */
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
    /* ⑥ 采纳值域门（**写之前**）：被采纳的值必须 ∈ 冻结真源；不在 ⇒ 结构化拒绝 ＋ 零写入
       （旧勘误单里遗留的非值域值不得被采纳写回；建议管理员改判「驳回」）。 */
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

    /* 落盘计划：**先公开投影（派生、确定性 id ⇒ 幂等 upsert）、后私有状态（权威）**。
       公开写在先：其失败 ⇒ 私有零写入（干净零半成品）；私有写在后、且为权威判据。 */
    const at = new Date(Math.floor(Number(nowSeconds)) * 1000).toISOString()
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
            collection: COLLECTIONS.correctionsPublic,
            action: 'set',
            id: `${PUBLIC_ID_PREFIX}${correctionId}`,
            doc: projection
          },
          {
            collection: COLLECTIONS.corrections,
            action: 'update',
            match: found.match,
            doc: privatePatch,
            expectAtLeast: 1
          }
        ]
      }
    }
  }
})

/**
 * 落盘（**唯一写点**）。
 * 顺序执行计划里的写入；任一写失败 ⇒ 抛错（由调用方转 `STORAGE_UNAVAILABLE`）。
 * @param {{op:string, writes:Array<object>}} plan
 * @returns {Promise<Array<object>>} 逐写的读数（集合名 / 动作 / 受影响行数）
 */
async function persist(plan) {
  if (!plan || !Array.isArray(plan.writes) || plan.writes.length === 0) {
    throw new Error('empty-persist-plan')
  }
  const db = resolveDb()
  const readouts = []
  for (const write of plan.writes) {
    if (!write || typeof write !== 'object') throw new Error('malformed-persist-write')
    if (write.action === 'set') {
      await db.collection(write.collection).doc(write.id).set(write.doc)
      readouts.push({ collection: write.collection, action: 'set', id: write.id })
      continue
    }
    if (write.action === 'update') {
      const result = await db.collection(write.collection).where(write.match).update(write.doc)
      const updated = updatedCountOf(result)
      if (typeof write.expectAtLeast === 'number' && updated !== null && updated < write.expectAtLeast) {
        /* 命中 0 行 ⇒ 并发改动 / 单号不存在 ⇒ 结构化失败（**不伪装 FORBIDDEN**）。 */
        throw new Error(`update-matched-too-few:${updated}`)
      }
      readouts.push({ collection: write.collection, action: 'update', updated })
      continue
    }
    throw new Error(`unknown-persist-action:${String(write.action)}`)
  }
  return readouts
}

module.exports = {
  COLLECTIONS,
  CORRECTION_STATUS,
  LEGACY_DECISION,
  DECISIONS,
  MARKABLE_FIELDS,
  DYNASTY_OPTIONS,
  FACE_CONTENT_OPTIONS,
  FACE_STYLE_OPTIONS,
  VALUE_DOMAINS,
  ALLOWED_KEYS,
  IDENTITY_KEYS,
  IDENTITY_PROJECTION_KEYS,
  MAX_NOTE_LENGTH,
  MAX_ID_LENGTH,
  PUBLIC_PROJECTION_KEYS,
  PUBLIC_SCHEMA,
  PUBLIC_ID_PREFIX,
  OPS,
  setOpsDbProvider,
  opsDbInjected,
  resolveDb,
  readCorrectionRow,
  buildProjection,
  persist,
  normalizePhone
}
