'use strict'
/**
 * 玺爱 · 用户积分（「金」）**云端权威账本**（唯一账本实现点）
 * ============================================================================
 * 职责（本单范围）：把「金」从本机 localStorage mock 收拢为**服务端权威 ＋ 服务端原子扣减**。
 * 本文件是账本的**唯一实现点**：余额读取 / 扣费 / 退款 / 发奖 / 流水清单 / 初始幂等发放
 * 六件事全部只在此落地；调用方（`lib/ops.js` 的 `getPointsBalance` / `listPointsFlow`
 * 与后续扣费类业务 op）一律经本文件的函数走账，**不自写第二套**。
 *
 * 集合（**服务端专属私有**；参照 `xiai_counters` 先例：**不进** 本函数 `lib/ops.js` 的
 * `COLLECTIONS` 读写面登记表，**更不进**前端 `src/data/cloudbase.js` 的
 * `CLOUD_COLLECTIONS` / `CLOUD_COLLECTION_KEYS` / `CLOUD_KEY_OF_LOCAL` ⇒ 客户端零读面；
 * 单一读写点＝本文件 ⇒ 单点即审计点）：
 *   · `xiai_balances`  ＝ 余额行；`_id` ＝ `bl-` ＋ uid；**键面恰 4 键**
 *     `{_id, uid, points(整数), updated_at}`（**不落版本号** ⇒ 乐观锁锁在 `points` 旧值上）。
 *   · `xiai_points_flow`＝ 流水行；`_id` ＝ `pf-` ＋ `sha256(idem_key)` 前 32 位十六进制
 *     （**幂等键决定性派生 ⇒ 同键恒同 `_id` ⇒ 并发下只有一路 `add` 成功**）；**键面恰 9 键**
 *     `{_id, uid, delta(整数), kind, ref_type, ref_id, idem_key, balance_after(整数), created_at}`。
 *
 * 硬口径（逐条）：
 *  ① **原子性 ＝ 读-比-写 ＋ 单文档条件更新（乐观锁）＋ 重试**（与 `lib/ops.js` 的
 *     `issueCodeNumber`〔识别编码号源〕**同一裁决机制**）：写余额时以
 *     `where({_id, points: 旧值}).update({points: 新值})` 让**平台的单文档更新**裁决谁赢 ——
 *     过滤条件锁住旧值 ⇒ 两路同旧值并发时恰一路 `updated === 1`；`0` ＝并发抢先 ⇒ 重读重试、
 *     `null`（计数读不出）⇒ 一律按失败重试。**不依赖 `db.command.inc`**（旧值过滤已在单文档
 *     更新层裁决原子性；`inc` 只有在无旧值过滤时才有意义，本实现不走那条路）。
 *     离线证据见 `scripts/verify-points-ledger.mjs`（同 uid 并发两笔各 5 金、初始 50 ⇒ 恒 40）
 *     与其中的**负对照**（同交错下的朴素读改写 ⇒ 45 ⇒ 证明测试台真能测出丢更新）。
 *  ② **幂等**：`idem_key` 唯一 ⇒ 同键重复调用**返回首次结果**、不重复扣、**不新增第二行流水**。
 *     实现：流水行 `_id` 由 `idem_key` 确定性派生（①的 `_id`）⇒ 预留行 `add` 冲突即幂等裁决；
 *     已结算（`balance_after` 为整数）⇒ 直接回首次结果；未结算（`balance_after === null`）⇒
 *     重放方轮询等待在飞写方结算，超时才接管（**接管窗口登记为已知限制**，见报告）。
 *  ③ **余额不足** ⇒ `INSUFFICIENT_POINTS` 且**零写入**（预检在**任何流水写入之前**；
 *     流水行数不变、余额不变）。内部重入路径（接管未结算预留行时再遇不足）同 reason，
 *     且该路径本单亦零新增写入（预留行是此前中断写入留下的，非本调用所写）。
 *  ④ **退款不删原行**：`refundPoints` 只**新增**一条 `kind=REFUND` 的正向流水（`ref_id` 与原
 *     `CHARGE` 相同）；原扣费流水行与其余历史行**一字不改、一行不删**。
 *  ⑤ **新用户初始 50 金 ＝ 服务端首次读时幂等发放**（`ensureBalance`；流水
 *     `kind=REWARD`＋`ref_type=INITIAL`＋`idem_key=initial:<uid>` ⇒ 同 uid 无论并发 / 重放
 *     都只发一次）；**不采信前端自报**（前端没有任何入口能指定初始值）。
 *  ⑥ **拒绝形态恒为恰 3 键** `{ok:false, reason, message}`；`reason` 只用配置面冻结表
 *     （`lib/config.js::REASONS`）字面值 —— 本文件新增的唯一字面值是**派单方已裁定**的
 *     `INSUFFICIENT_POINTS`（登记在 `REASONS` 表内，此处只引用常量、不写字面量）。
 *  ⑦ **回包零 uid**：`listFlow` 逐行投影为恰 6 键
 *     `{delta, kind, ref_type, ref_id, balance_after, created_at}` ⇒ **无 `uid`、无 `_id`**。
 *  ⑧ **不变式**：任一时刻 `balance.points === 50〔INITIAL〕 + Σ(已结算流水.delta)`；
 *     未结算（`balance_after === null`）的预留行**不进** `listFlow` 回包。
 *
 * 与本机旧口径的关系（登记，不在本单迁移）：本机 mock（`src/services/points.js`）的
 * `GOLD_INITIAL=50 / DOWNLOAD_COST=5 / CORRECTION_REWARD=10` 与本文件
 * `DEFAULT_INITIAL_POINTS=50` **同值**；旧流水的中文类型标签（`初始贈送` / `下載消耗` /
 * `勘誤獎勵` / `邀請註冊`）与新口径枚举（`INITIAL` / `CHARGE` / `REWARD` …）**并存**，
 * 本机旧行**不读、不改、不清、不换命名空间**；切换时机由派单方裁定。
 */

const crypto = require('crypto')
const { REASONS, deny, isDocNotExistError } = require('./config.js')

/* ---------------------------------------------------------------------------
   常量面（封闭）
   --------------------------------------------------------------------------- */

/** 集合名（**服务端专属私有**；不进 `COLLECTIONS`、不进任何前端云读面）。 */
const LEDGER_COLLECTIONS = Object.freeze({ balances: 'xiai_balances', flow: 'xiai_points_flow' })

/** 余额行文档键前缀（`bl-` ＋ uid）。 */
const BALANCE_ID_PREFIX = 'bl-'

/** 流水行文档键前缀（`pf-` ＋ 32 位十六进制）。 */
const FLOW_ID_PREFIX = 'pf-'
const FLOW_ID_HEX_LENGTH = 32

/** 流水类型枚举（封闭）。 */
const FLOW_KINDS = Object.freeze({ CHARGE: 'CHARGE', REFUND: 'REFUND', REWARD: 'REWARD', ADJUST: 'ADJUST' })
const FLOW_KIND_VALUES = Object.freeze(['CHARGE', 'REFUND', 'REWARD', 'ADJUST'])

/** 流水参照类型枚举（封闭）。 */
const REF_TYPES = Object.freeze({
  AI_IMAGE: 'AI_IMAGE',
  SEAL_DOWNLOAD: 'SEAL_DOWNLOAD',
  CORRECTION_ACCEPT: 'CORRECTION_ACCEPT',
  INVITE: 'INVITE',
  INITIAL: 'INITIAL',
  ADMIN_ADJUST: 'ADMIN_ADJUST'
})
const REF_TYPE_VALUES = Object.freeze(['AI_IMAGE', 'SEAL_DOWNLOAD', 'CORRECTION_ACCEPT', 'INVITE', 'INITIAL', 'ADMIN_ADJUST'])

/** 新用户初始金（与本机 mock `GOLD_INITIAL=50` 同值；**服务端唯一写值处**）。 */
const DEFAULT_INITIAL_POINTS = 50

/** 流水清单分页护栏（沿用工程既有 `limit ≤ 1000` 惯例；越界 ⇒ `INVALID_VALUE`，不静默夹取）。 */
const LIST_FLOW_DEFAULT_LIMIT = 100
const LIST_FLOW_MAX_LIMIT = 1000

/** CAS（读-比-写乐观锁）重试上限；超限 ⇒ 结构化拒绝（同键重放可自愈）。 */
const CAS_MAX_ATTEMPTS = 16

/** 同键并发时，「重放方」等待在飞写方结算的轮询预算（4 × 25 ms）。 */
const SETTLE_POLL_ATTEMPTS = 4
const SETTLE_POLL_DELAY_MS = 25

/** 幂等键 / 参照键长度上限（超出 ⇒ `INVALID_VALUE`，不静默截断）。 */
const IDEM_KEY_MAX_LENGTH = 160
const REF_ID_MAX_LENGTH = 200

/** 初始发放的幂等键（确定性 ⇒ 同 uid 只发一次）。 */
const INITIAL_IDEM_PREFIX = 'initial:'

/** 余额行键面（恰 4 键；**不落版本号**）。 */
const BALANCE_ROW_KEYS = Object.freeze(['_id', 'uid', 'points', 'updated_at'])

/** 流水行存储键面（恰 9 键）。 */
const FLOW_ROW_KEYS = Object.freeze(['_id', 'uid', 'delta', 'kind', 'ref_type', 'ref_id', 'idem_key', 'balance_after', 'created_at'])

/** 流水回包投影键面（恰 6 键；**零 uid、零 _id**）。 */
const FLOW_PROJECTION_KEYS = Object.freeze(['balance_after', 'created_at', 'delta', 'kind', 'ref_id', 'ref_type'])

/* ---------------------------------------------------------------------------
   DB 句柄缝（离线自检注入用；生产不注入 ⇒ 经 `lib/ops.js::resolveLedgerStore` 取真句柄）
   —— 静态纪律（守既有静态门 A8 / A8b / D4）：**取集合句柄与取库句柄的调用字面**
   只允许落在 `lib/ops.js`，本文件只持有**已取到的句柄**。
   --------------------------------------------------------------------------- */

let storeProvider = null

/**
 * 注入账本存储实现（`() => {balances, flow}`；传非函数 ⇒ 清除注入）。**仅供离线自检 / 宿主**。
 * @param {null|function():object} fn
 */
function setLedgerStoreProvider(fn) {
  storeProvider = typeof fn === 'function' ? fn : null
}

/** 存储缝是否已注入（诊断读数用，**不含任何凭据**）。 */
function ledgerStoreInjected() {
  return storeProvider !== null
}

/**
 * 取账本存储句柄。
 * 顺序：① 注入缝（离线自检）→ ② `lib/ops.js::resolveLedgerStore`（生产单点：它是本函数内
 * 唯一允许出现集合句柄调用字面的地方；懒加载避免循环依赖在装载期发生）。
 * 两路都拿不到 ⇒ 抛错 ⇒ 由调用方转结构化拒绝（**绝不伪装 `FORBIDDEN`**）。
 */
function resolveStore() {
  if (storeProvider) return storeProvider()
  /* 懒加载：`lib/ops.js` 装载期会先 require 本文件；此处只在**调用期**回取，无环。 */
  const ops = require('./ops.js')
  const store = ops && typeof ops.resolveLedgerStore === 'function' ? ops.resolveLedgerStore() : null
  if (!store || !store.balances || !store.flow) throw new Error('LEDGER_STORE_UNAVAILABLE')
  return store
}

/* ---------------------------------------------------------------------------
   小工具
   --------------------------------------------------------------------------- */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/** 归一化一行读回（兼容 `{data:[…]}` / `{data:{…}}` / 裸数组；认不出 ⇒ `[]`，明确空集、不猜）。 */
function rowsOf(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.data)) return result.data
  if (result && result.data && typeof result.data === 'object') return [result.data]
  return []
}

/** 归一化 `where(...).update(...)` 的「受影响行数」（读不出 ⇒ `null` ⇒ 一律按失败重试）。 */
function updatedCountOf(result) {
  if (!result || typeof result !== 'object') return null
  const candidates = [result.updated, result.modified, result.matched, result.data && result.data.updated]
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  }
  return null
}

function nowIso() {
  return text(new Date().toISOString())
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 余额行文档键（`bl-` ＋ uid）。 */
function balanceIdOf(uid) {
  return `${BALANCE_ID_PREFIX}${text(uid)}`
}

/** 流水行文档键（`pf-` ＋ `sha256(idem_key)` 前 32 位；**幂等键决定性派生**）。 */
function flowIdOf(idemKey) {
  return `${FLOW_ID_PREFIX}${crypto.createHash('sha256').update(String(idemKey), 'utf8').digest('hex').slice(0, FLOW_ID_HEX_LENGTH)}`
}

/** 初始发放的幂等键（确定性 ⇒ 同 uid 只发一次）。 */
function initialIdemKeyOf(uid) {
  return `${INITIAL_IDEM_PREFIX}${text(uid)}`
}

/** 流水回包投影（**恰 6 键；零 uid、零 `_id`**）。 */
function projectFlowRow(row) {
  const source = row && typeof row === 'object' ? row : {}
  const after = source.balance_after
  return {
    delta: Number(source.delta),
    kind: text(source.kind),
    ref_type: text(source.ref_type),
    ref_id: text(source.ref_id),
    balance_after: typeof after === 'number' && Number.isInteger(after) ? after : null,
    created_at: text(source.created_at)
  }
}

/* ---------------------------------------------------------------------------
   读点
   --------------------------------------------------------------------------- */

/**
 * 按确定性文档键读**余额行**（无行 ⇒ `null`；**只读**）。
 *
 * **存在性语义**：`doc(id).get()` 在**文档不存在**时 CloudBase node-sdk 会**抛错**
 * （服务端回 404 ⇒ `TcbError.code === 404`），而不是回 `{data:[]}`。
 * 故这里**不依赖 `doc().get()` 的存在性语义**：`try/catch` 包住，**仅**把「文档不存在」类错误
 * 当空（判据见 `lib/config.js::isDocNotExistError`），**其它错误照旧上抛**（真存储故障绝不吞成「无行」）。
 */
async function readBalanceRow(uid) {
  const store = resolveStore()
  let rows = []
  try {
    rows = rowsOf(await store.balances.doc(balanceIdOf(uid)).get())
  } catch (error) {
    /* 只吞「文档不存在」；其余（连接 / 权限 / 5xx …）照旧上抛。 */
    if (!isDocNotExistError(error)) throw error
  }
  return rows.length > 0 ? rows[0] : null
}

/**
 * 按确定性文档键读**流水行**（无行 ⇒ `null`；**只读**）。
 *
 * **存在性语义**：同 `readBalanceRow` —— `doc(id).get()` 在文档不存在时抛错而非回空，
 * 故 `try/catch` 包住，**仅**把「文档不存在」类错误当空，**其它错误照旧上抛**。
 */
async function readFlowRow(flowId) {
  const store = resolveStore()
  let rows = []
  try {
    rows = rowsOf(await store.flow.doc(flowId).get())
  } catch (error) {
    /* 只吞「文档不存在」；其余（连接 / 权限 / 5xx …）照旧上抛。 */
    if (!isDocNotExistError(error)) throw error
  }
  return rows.length > 0 ? rows[0] : null
}

/* ---------------------------------------------------------------------------
   写点（全部经下列三处；无旁路）
   --------------------------------------------------------------------------- */

/**
 * **幂等插入流水行**（预留锁）：`_id` 由 `idem_key` 确定性派生 ⇒ 同键并发下恰一路 `add` 成功。
 * 冲突（`_id` 已存在）⇒ 回 `'exists'`（**不覆盖、不改写既有行**）；真存储故障 ⇒ 抛错。
 * @returns {Promise<'inserted'|'exists'>}
 */
async function insertFlowRow(row) {
  const store = resolveStore()
  try {
    await store.flow.add(row)
    return 'inserted'
  } catch (error) {
    const existing = await readFlowRow(row._id)
    if (existing) return 'exists'
    throw error
  }
}

/**
 * **CAS 扣减/增加余额**（唯一余额写点）：`where({_id, points: 旧值}).update({points: 新值})`
 * —— 过滤条件锁住旧值 ⇒ 并发下恰一路 `updated === 1`；`0` ＝ 抢先 ⇒ 重读重试；
 * `null` ⇒ 按失败重试。返回成功时的新余额（＝`balance_after`）。
 * @param {string} uid
 * @param {number} delta 正＝加、负＝减
 * @returns {Promise<{ok:true, points:number}|{ok:false, reason:string, message:string}>}
 */
async function casApplyDelta(uid, delta) {
  const store = resolveStore()
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
    const row = await readBalanceRow(uid)
    if (!row) {
      /* 余额行不存在（理论上已被 ensureBalance 兜住）⇒ 重新幂等建行后重试。 */
      const ensured = await ensureBalance(uid, DEFAULT_INITIAL_POINTS)
      if (!ensured.ok) return ensured
      continue
    }
    const current = Number(row.points)
    if (!Number.isInteger(current)) throw new Error('LEDGER_BALANCE_SHAPE_INVALID')
    const next = current + delta
    if (next < 0) {
      return deny(
        REASONS.INSUFFICIENT_POINTS,
        `金餘額不足：本次需要 ${-delta} 金，當前 ${current} 金；本次不再寫入。`
      )
    }
    const reply = await store.balances
      .where({ _id: balanceIdOf(uid), points: current })
      .update({ points: next, updated_at: nowIso() })
    const updated = updatedCountOf(reply)
    if (updated === 1) return { ok: true, points: next }
    /* `0` ＝ 并发抢先；`null` ＝ 计数读不出 —— 两者都重读重试（宁可多试，绝不丢单）。 */
  }
  return deny(REASONS.STORAGE_UNAVAILABLE, '積分餘額更新競爭超時；請以同一冪等鍵重試（同鍵重放不會重複扣）。')
}

/** 结算预留流水行（把 `balance_after` 落成整数；**带旧值过滤** ⇒ 只有一路能结算）。 */
async function settleFlowRow(flowId, balanceAfter) {
  const store = resolveStore()
  const reply = await store.flow.where({ _id: flowId, balance_after: null }).update({ balance_after: balanceAfter })
  return updatedCountOf(reply)
}

/* ---------------------------------------------------------------------------
   对外：初始发放（幂等）
   --------------------------------------------------------------------------- */

/**
 * **幂等确保存在余额行**：无行 ⇒ 发 `initial` 金 ＋ 落一条 `INITIAL` 流水（同 uid 只发一次，
 * 并发 / 重放都收敛到一行流水、一份初始值）。有行 ⇒ 原样返回（**不改写既有行**）。
 * 写序：**先流水、后建行** —— 流水行的确定性 `_id` 是并发裁决点（只有 `add` 成功的那路
 * 是发放者），建行冲突 ⇒ 重读既有行 ⇒ 两侧都收敛。
 * @param {string} uid
 * @param {number} initial 初始金（调用方给；缺省路径统一传 `DEFAULT_INITIAL_POINTS`）
 * @returns {Promise<{ok:true, uid:string, points:number, updated_at:string, created:boolean}
 *          |{ok:false, reason:string, message:string}>}
 */
async function ensureBalance(uid, initial) {
  const id = text(uid)
  if (!id) return deny(REASONS.MISSING_REQUIRED, '缺少用戶標識（uid）；本次零寫入。')
  const grant = Number(initial)
  if (!Number.isInteger(grant) || grant < 0) {
    return deny(REASONS.INVALID_VALUE, '初始金額（initial）必須是非負整數；本次零寫入。')
  }
  const store = resolveStore()
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
    const existing = await readBalanceRow(id)
    if (existing) {
      return {
        ok: true,
        uid: id,
        points: Number(existing.points),
        updated_at: text(existing.updated_at),
        created: false
      }
    }
    /* 首次：① INITIAL 流水（确定性 `_id` ＝ `initial:<uid>` ⇒ 并发只写一行）② 建余额行。 */
    const at = nowIso()
    const idemKey = initialIdemKeyOf(id)
    await insertFlowRow({
      _id: flowIdOf(idemKey),
      uid: id,
      delta: grant,
      kind: FLOW_KINDS.REWARD,
      ref_type: REF_TYPES.INITIAL,
      ref_id: '',
      idem_key: idemKey,
      balance_after: grant,
      created_at: at
    })
    try {
      await store.balances.add({ _id: balanceIdOf(id), uid: id, points: grant, updated_at: at })
      return { ok: true, uid: id, points: grant, updated_at: at, created: true }
    } catch (error) {
      /* 建行冲突 ＝ 并发建行 ⇒ 重读既有行（INITIAL 流水那行已幂等，不会重发）。 */
      const raced = await readBalanceRow(id)
      if (raced) continue
      throw error
    }
  }
  return deny(REASONS.STORAGE_UNAVAILABLE, '積分餘額行建立競爭超時；本次零寫入。')
}

/**
 * **读余额**（服务端权威；**首次读即幂等发初始 50 金** —— 不采信前端自报）。
 * @param {string} uid
 * @returns {Promise<{ok:true, points:number, updated_at:string}
 *          |{ok:false, reason:string, message:string}>}
 */
async function readBalance(uid) {
  const ensured = await ensureBalance(uid, DEFAULT_INITIAL_POINTS)
  if (!ensured.ok) return ensured
  return { ok: true, points: ensured.points, updated_at: ensured.updated_at }
}

/* ---------------------------------------------------------------------------
   对外：扣费 / 退款 / 发奖（同一条 mutate 通路）
   --------------------------------------------------------------------------- */

/**
 * 入参值域门（**全部判定在任何写入之前**；任一不过 ⇒ 结构化拒绝 ＋ 零写入）。
 * @param {object} params `{uid, amount, kind?, ref_type, ref_id?, idem_key}`
 * @param {{values:ReadonlyArray<string>, defaultKind:string, refIdRequired:boolean}} policy
 * @returns {null|{ok:false, reason:string, message:string}}
 */
function validateMutation(params, policy) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（params）；本次零寫入。')
  }
  if (!text(params.uid)) return deny(REASONS.MISSING_REQUIRED, '缺少用戶標識（uid）；本次零寫入。')
  if (!isPositiveInteger(params.amount)) {
    return deny(REASONS.INVALID_VALUE, '金額（amount）必須是正整數；本次零寫入。')
  }
  const kind = params.kind === undefined || params.kind === null || text(params.kind) === '' ? policy.defaultKind : text(params.kind)
  if (policy.values.indexOf(kind) === -1) {
    return deny(REASONS.INVALID_VALUE, `流水類型（kind）值域外：${kind}；本次零寫入。`)
  }
  const refType = text(params.ref_type)
  if (REF_TYPE_VALUES.indexOf(refType) === -1) {
    return deny(REASONS.INVALID_VALUE, `流水參照類型（ref_type）值域外：${refType || '（空）'}；本次零寫入。`)
  }
  const refId = params.ref_id === undefined || params.ref_id === null ? '' : text(params.ref_id)
  if (refId.length > REF_ID_MAX_LENGTH) {
    return deny(REASONS.INVALID_VALUE, `流水參照鍵（ref_id）超出上限（${REF_ID_MAX_LENGTH} 字）；本次零寫入。`)
  }
  if (policy.refIdRequired && !refId) {
    return deny(REASONS.MISSING_REQUIRED, '退款必須帶原扣費流水的參照鍵（ref_id）；本次零寫入。')
  }
  const idemKey = text(params.idem_key)
  if (!idemKey) return deny(REASONS.MISSING_REQUIRED, '缺少冪等鍵（idem_key）；本次零寫入。')
  if (idemKey.length > IDEM_KEY_MAX_LENGTH) {
    return deny(REASONS.INVALID_VALUE, `冪等鍵（idem_key）超出上限（${IDEM_KEY_MAX_LENGTH} 字）；本次零寫入。`)
  }
  return null
}

/**
 * **账本唯一变更通路**（扣费 / 退款 / 发奖共用；`delta` 的符号由各入口给定）。
 * 顺序：① 内存态幂等首查（已结算 ⇒ 回首次结果、零写入）→ ② 确保存在余额行（缺失 ⇒ 幂等发
 * 初始 50）→ ③ 扣费方向余额不足预检（**在任何流水写入之前** ⇒ 零写入）→ ④ 预留流水行
 * （确定性 `_id` ＝ 并发幂等裁决）→ ⑤ CAS 扣减余额（乐观锁重试）→ ⑥ 结算预留行
 * （`balance_after` 落整数；带 `null` 旧值过滤 ⇒ 恰一路结算成功）。
 * 失败路径：⑤ 之前失败 ⇒ 零写入；⑤ 成功而 ⑥ 冲突 ⇒ 说明另一路已结算 ⇒ 回其结果（本路
 * 的余额写入已被 ⑤ 的 CAS 语义保护：两路不可能同旧值同时成功）。
 * @returns {Promise<{ok:true, points:number, balance_after:number, delta:number, kind:string,
 *          ref_type:string, ref_id:string, flow_id:string, created_at:string, idempotent:boolean}
 *          |{ok:false, reason:string, message:string}>}
 */
async function mutatePoints(params, policy) {
  const denial = validateMutation(params, policy)
  if (denial) return denial
  const uid = text(params.uid)
  const amount = params.amount
  const kind = params.kind === undefined || params.kind === null || text(params.kind) === '' ? policy.defaultKind : text(params.kind)
  const refType = text(params.ref_type)
  const refId = params.ref_id === undefined || params.ref_id === null ? '' : text(params.ref_id)
  const idemKey = text(params.idem_key)
  const flowId = flowIdOf(idemKey)
  const delta = policy.direction > 0 ? amount : -amount

  /* ① 幂等首查：同键**已结算** ⇒ 回首次结果（不重复扣、不新增第二行流水、零写入）。 */
  const prior = await readFlowRow(flowId)
  if (prior && typeof prior.balance_after === 'number' && Number.isInteger(prior.balance_after)) {
    return {
      ok: true,
      points: prior.balance_after,
      balance_after: prior.balance_after,
      delta: Number(prior.delta),
      kind: text(prior.kind),
      ref_type: text(prior.ref_type),
      ref_id: text(prior.ref_id),
      flow_id: flowId,
      created_at: text(prior.created_at),
      idempotent: true
    }
  }

  /* ② 确保存在余额行（新用户首次触达 ⇒ 幂等发初始 50）。 */
  const ensured = await ensureBalance(uid, DEFAULT_INITIAL_POINTS)
  if (!ensured.ok) return ensured

  /* ③ 扣费方向：余额不足 ⇒ 拒绝且**零写入**（预检早于任何流水写入）。 */
  if (delta < 0 && ensured.points < -delta) {
    return deny(
      REASONS.INSUFFICIENT_POINTS,
      `金餘額不足：本次需要 ${-delta} 金，當前 ${ensured.points} 金；本次零寫入。`
    )
  }

  /* ④ 预留流水行（`balance_after: null` ＝ 未结算；确定性 `_id` ⇒ 同键并发只有一路 `inserted`）。 */
  const flowCreatedAt = nowIso()
  const reservation = await insertFlowRow({
    _id: flowId,
    uid,
    delta,
    kind,
    ref_type: refType,
    ref_id: refId,
    idem_key: idemKey,
    balance_after: null,
    created_at: flowCreatedAt
  })

  if (reservation === 'exists') {
    /* ④b 同键在飞 / 已结算：轮询等在飞写方结算；确已中断（超时仍未结算）⇒ 接管自愈。
       【已知限制登记】接管窗口内若原写方仍在飞，存在理论上的双扣可能（无跨文档事务）；
       正常重放（串行 3 连击）与同键并发（一路 inserted、一路轮询）都在本窗口之外。 */
    for (let poll = 0; poll < SETTLE_POLL_ATTEMPTS; poll += 1) {
      const current = await readFlowRow(flowId)
      if (current && typeof current.balance_after === 'number' && Number.isInteger(current.balance_after)) {
        return {
          ok: true,
          points: current.balance_after,
          balance_after: current.balance_after,
          delta: Number(current.delta),
          kind: text(current.kind),
          ref_type: text(current.ref_type),
          ref_id: text(current.ref_id),
          flow_id: flowId,
          created_at: text(current.created_at),
          idempotent: true
        }
      }
      await sleep(SETTLE_POLL_DELAY_MS)
    }
  }

  /* ⑤ CAS 扣减余额（乐观锁重试）。 */
  const applied = await casApplyDelta(uid, delta)
  if (!applied.ok) return applied

  /* ⑥ 结算预留行（带 `null` 旧值过滤 ⇒ 恰一路结算成功；冲突 ⇒ 另一路已结算 ⇒ 回其结果）。 */
  const settled = await settleFlowRow(flowId, applied.points)
  if (settled !== 1) {
    const winner = await readFlowRow(flowId)
    if (winner && typeof winner.balance_after === 'number' && Number.isInteger(winner.balance_after)) {
      return {
        ok: true,
        points: winner.balance_after,
        balance_after: winner.balance_after,
        delta: Number(winner.delta),
        kind: text(winner.kind),
        ref_type: text(winner.ref_type),
        ref_id: text(winner.ref_id),
        flow_id: flowId,
        created_at: text(winner.created_at),
        idempotent: true
      }
    }
    /* 结算读不出 ⇒ 如实报错（余额已变、流水未结算 ⇒ 同键重放会重试结算，不丢单）。 */
    return deny(REASONS.STORAGE_UNAVAILABLE, '積分流水結算未確認；請以同一冪等鍵重試（同鍵重放不會重複扣）。')
  }

  return {
    ok: true,
    points: applied.points,
    balance_after: applied.points,
    delta,
    kind,
    ref_type: refType,
    ref_id: refId,
    flow_id: flowId,
    created_at: flowCreatedAt,
    idempotent: false
  }
}

const CHARGE_POLICY = Object.freeze({ values: FLOW_KIND_VALUES, defaultKind: FLOW_KINDS.CHARGE, direction: -1, refIdRequired: false })
const REFUND_POLICY = Object.freeze({ values: FLOW_KIND_VALUES, defaultKind: FLOW_KINDS.REFUND, direction: 1, refIdRequired: true })
const AWARD_POLICY = Object.freeze({ values: Object.freeze([FLOW_KINDS.REWARD, FLOW_KINDS.ADJUST]), defaultKind: FLOW_KINDS.REWARD, direction: 1, refIdRequired: false })

/**
 * **扣费**（`amount` 为正整数；流水 `delta = -amount`、`kind = CHARGE`）。
 * @param {{uid:string, amount:number, kind?:string, ref_type:string, ref_id?:string, idem_key:string}} params
 */
function chargePoints(params) {
  return mutatePoints(params, CHARGE_POLICY)
}

/**
 * **退款**（`amount` 为正整数；流水 `delta = +amount`、`kind = REFUND`；**不删原行** ——
 * `ref_id` 与原 `CHARGE` 相同，由调用方带入；原扣费行与其余历史行一字不改）。
 * @param {{uid:string, amount:number, kind?:string, ref_type:string, ref_id:string, idem_key:string}} params
 */
function refundPoints(params) {
  return mutatePoints(params, REFUND_POLICY)
}

/**
 * **发奖**（`amount` 为正整数；流水 `delta = +amount`、`kind` ∈ {REWARD, ADJUST}）。
 * @param {{uid:string, amount:number, kind?:string, ref_type:string, ref_id?:string, idem_key:string}} params
 */
function awardPoints(params) {
  return mutatePoints(params, AWARD_POLICY)
}

/* ---------------------------------------------------------------------------
   对外：流水清单（分页；回包零 uid）
   --------------------------------------------------------------------------- */

/**
 * **流水清单**（本人；按 `created_at` 倒序；`limit` 1〜1000、`cursor` ＝ 非负整数偏移）。
 * 逐行投影为**恰 6 键**（`{delta, kind, ref_type, ref_id, balance_after, created_at}`）⇒
 * **回包零 `uid`、零 `_id`**；未结算（`balance_after === null`）的预留行**不下发**。
 * @param {string} uid
 * @param {{limit?:number, cursor?:number|string}} [options]
 * @returns {Promise<{ok:true, rows:Array<object>, count:number}
 *          |{ok:false, reason:string, message:string}>}
 */
async function listFlow(uid, options) {
  const id = text(uid)
  if (!id) return deny(REASONS.MISSING_REQUIRED, '缺少用戶標識（uid）；本次零寫入。')
  const rawLimit = options && options.limit !== undefined && options.limit !== null ? options.limit : LIST_FLOW_DEFAULT_LIMIT
  if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit <= 0 || rawLimit > LIST_FLOW_MAX_LIMIT) {
    return deny(REASONS.INVALID_VALUE, `單次取行上限（limit）必須是 1 〜 ${LIST_FLOW_MAX_LIMIT} 之間的整數；本次零寫入。`)
  }
  const rawCursor = options && options.cursor !== undefined && options.cursor !== null ? options.cursor : 0
  const offset = typeof rawCursor === 'number' ? rawCursor : Number(text(rawCursor))
  if (!Number.isInteger(offset) || offset < 0) {
    return deny(REASONS.INVALID_VALUE, '分頁游標（cursor）必須是非負整數；本次零寫入。')
  }
  const store = resolveStore()
  let chain = store.flow.where({ uid: id })
  if (chain && typeof chain.orderBy === 'function') chain = chain.orderBy('created_at', 'desc')
  if (offset > 0 && chain && typeof chain.skip === 'function') chain = chain.skip(offset)
  if (chain && typeof chain.limit === 'function') chain = chain.limit(rawLimit)
  const rows = rowsOf(await chain.get())
  const projected = rows
    .filter((row) => row && typeof row.balance_after === 'number' && Number.isInteger(row.balance_after))
    .map(projectFlowRow)
  return { ok: true, rows: projected, count: projected.length }
}

module.exports = {
  LEDGER_COLLECTIONS,
  BALANCE_ID_PREFIX,
  FLOW_ID_PREFIX,
  FLOW_KINDS,
  FLOW_KIND_VALUES,
  REF_TYPES,
  REF_TYPE_VALUES,
  DEFAULT_INITIAL_POINTS,
  LIST_FLOW_DEFAULT_LIMIT,
  LIST_FLOW_MAX_LIMIT,
  CAS_MAX_ATTEMPTS,
  BALANCE_ROW_KEYS,
  FLOW_ROW_KEYS,
  FLOW_PROJECTION_KEYS,
  balanceIdOf,
  flowIdOf,
  initialIdemKeyOf,
  projectFlowRow,
  setLedgerStoreProvider,
  ledgerStoreInjected,
  readBalanceRow,
  readFlowRow,
  ensureBalance,
  readBalance,
  chargePoints,
  refundPoints,
  awardPoints,
  listFlow
}
