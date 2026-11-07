/**
 * 玺爱 · 勘误服务
 *
 * 勘误针对「可标记属性」：印文简体字、印文古字、朝代、**印面内容**（键 `seal_type`）、
 * **印面风格**（键 `face_style`，R-31）、作者、印文释义。
 * 勘误挂在**印面**上（canonical 字段含 `faceId` / `sealId`）；
 * 用户提交的勘误不直接覆盖原始数据，由平台按可信度汇总后对外展示。
 * 状态机三态冻结：`PENDING` / `ACCEPTED` / `REJECTED`（单向迁移，终态不回退）。
 * 提交、汇总、审核与奖励发放的闭环追加在文件末尾的「闭环补全」段。
 */

import {
  listCorrectionRows,
  saveCorrectionRows,
  normalizeCorrectionStatus,
  listPendingCorrectionRowsForAdmin,
  writeCorrectionDecision,
  markCorrectionRewarded,
  listUserRows,
  PermissionError,
  /* r2 读面接线：**公开只读投影集合**（`xiai_corrections_public`）的读 / 镜像写，与
     **显示名单点** `sealDisplayName`（链：采纳值 → 原始 seal_name → 佚名）。 */
  sealDisplayName,
  /* **印人（person-model §4.1）**：作者显示名解析单点（`resolveAuthorName`）＋ 引用值域门
     所用的存在性判定（`personExistsById`）。**不在此另立第二套名表**。 */
  resolveAuthorName,
  personExistsById,
  listPublicCorrectionRows,
  listPublicCorrectionMirrorRows,
  savePublicCorrectionRows,
  /* **值级公开摘要面（本单合并面）**：本机镜像的读 / 写 ＋ 采信私有行读（供本地重算）。 */
  listEndorsementRows,
  listCorrectionSummaryMirrorRows,
  saveCorrectionSummaryRows
} from '../data/db.js'
import { currentUser } from '../data/session.js'
/* 值域真源**复用**：朝代 15 类 = `seed.js` 的 `DYNASTY_OPTIONS` / `isKnownDynasty`（R-20）；
   印面内容 9 值 = `FACE_CONTENT_OPTIONS` / `isKnownFaceContent`（R-30）；
   印面风格 23 值 = `FACE_STYLE_OPTIONS` / `isKnownFaceStyle`（R-31）。
   （**不得在此自写第二套枚举**——第二套必然与真源漂移，且数据层判据是按字面值检索的。） */
import {
  DYNASTY_OPTIONS,
  isKnownDynasty,
  FACE_CONTENT_OPTIONS,
  FACE_STYLE_OPTIONS,
  SEAL_CLASS_OPTIONS,
  isKnownFaceContent,
  isKnownFaceStyle,
  isKnownSealClass
} from '../data/seed.js'
import { awardCorrectionReward, CORRECTION_REWARD } from './points.js'
/* **身份标识（uid）单点**：上屏短碼（`u-` ＋ sha256 前 16 位 ⇒ 前 6 位展示），**不得回退成手机号**。 */
import { uidShortOf } from '../data/uid.js'
/* **不可逆摘要（同步、跨环境）**：值级公开摘要行 `_id` 的 `value` 摘要 —— 与云函数 `hash16`
   （sha256 前 16 位）同构（`crypto.subtle` 非安全上下文不可用 ⇒ 复用自带同步实现）。 */
import { sha256Hex } from '../data/assetmeta.js'
import { getFaceById, primaryFaceOf, faceLabelOf, FACE_KIND, FACE_IMAGE_REGISTER_OP } from './seals.js'
/* **影像勘誤（§3.77）的替換新圖通道**：原始文件先经**既有单点**转成存储容器（单页 8bit
   Deflate TIFF）⇒ 字节再交**现有** `storeArtifactBytes`（内容寻址、幂等）拿
   `sha256` / `bytes` / `storage_key`，再调**现有** `registerCorrectionImage`（登录面）入册拿 `image_id`。
   ——本文件只**调用**既有单点，不改其口径。 */
import { storeArtifactBytes, artifactObjectKeyOf } from './imageAuthority.js'
/* **替换新圖的存儲容器（本單修）**：全站存儲容器恒为**单页 8bit Deflate TIFF**（`STORAGE_MIME`），
   而用户给的是**原始文件**（JPG / PNG / WebP…）⇒ 必须先经**既有单点**转成容器再入库：
   - 输入门：`utils/image.js::loadImageFile`（1 MB / 类型 / 解码；§3.12.10(c) 冻结 reason 与文案）；
   - 输入门抬升：`services/photos.js::inputDenialOf`（**与实物照片同一道输入门与文案**，本文件不另写第二套）；
   - 产物编码：`components/uploadPipeline.js::runUploadPipeline`（**与实物照片同一入口**，
     `kind: 'photo'` ⇒ `preparePhotoSource` 出 TIFF）—— **本文件不新写编码器、不另建管线**。
   本文件只**调用**既有单点，不改其口径。 */
import { IMAGE_LIMITS, STORAGE_MIME, loadImageFile } from '../utils/image.js'
import { inputDenialOf } from './photos.js'
import { runUploadPipeline } from '../components/uploadPipeline.js'
/* **写面 Phase A（用户写面切片）**：勘误提交经云函数 `xiai-user-token` 的 `action:'verify'`
   服务端验签后才落盘（落盘在**云端**，`xiai_corrections` 的 ACL 是 `PRIVATE` ⇒ 只能由云函数
   以管理端凭据写）；**创建者身份由服务端记录**（`uid = u-<手机号>` 从令牌声明派生），
   载荷里的身份类键一律被服务端拒（`INVALID_FIELD` ＋ 零写入）。 */
import { userWriteGate } from './userWrite.js'
/* **V3（管理员写面收敛）**：采纳 / 驳回**不再**经 `xiai-admin-token`（客户端对其零引用）；
   一律走**登录令牌写面门** `userWriteGate` —— 服务端在 `xiai-user-token` 上验签 ＋
   判「手机号 ∈ 管理员白名单（环境变量 `XIAI_ADMIN_PHONE`）」⇒ **零弹窗、不需要第二个码**。 */

/* **简繁等价展示提示（§3.78）**：s2t 归一**只读比较** —— 沿 §3.17.1 单一真源复用
   `src/utils/traditional.js` 的同步 s2t（逐字表）；**不新写字典、不移动工具位置、
   不新增第二个转换入口**；其结果**只作用于渲染**、不进任何门的判定。 */
import { toTraditionalText as s2t } from '../utils/traditional.js'

/* ============================================================================
   **受控诊断串观测缓冲（`?diag=1` 才上屏；本文件只记、不渲染）**
   ----------------------------------------------------------------------------
   为什么：用户浏览器上「提交了勘误却看不到任何提示」时，要能让他自己在 URL 加
   `?diag=1` 把真因取回来（面板渲染在 `SealDetailView.vue` / `MyCorrectionsView.vue`
   顶部；**不带该参数 ⇒ 面板 DOM 零命中、本段零渲染**）。

   本段纪律（**只读观测、零副作用**）：
     · 只是内存里的先进先出缓冲（上限 `CORRECTIONS_DIAG_LIMIT` 条），**不落盘、不发请求、
       不设定时器、不改任何读 / 写回包的形状与文案**；
     · **不记令牌、不记完整明文值**（值只留前 20 字 ＋ 总长）、不记手机号 / uid；
     · `correctionsReadout()` 返回**从旧到新**的**副本**（调用它不推进任何状态）。
   ============================================================================ */

/** 观测缓冲上限（只留最近 N 条；更旧的被挤出，**不持久化**）。 */
export const CORRECTIONS_DIAG_LIMIT = 20

/** 模块私有的观测缓冲（外部只能经 `correctionsReadout()` 拿副本）。 */
const diagLines = []

/**
 * 最近一次**写面门**的形态读数（`local-dev` / `cloud`；`''` ＝ 该次调用未过门）。
 * 为什么是模块变量：回包摘要在**包装层**记，而门在内层函数里 —— 同一时刻只有一条
 * 勘误读 / 写在飞（同会话形态恒定），串台不改变读数含义。
 */
let diagGateMode = ''

/** `HH:MM:SS`（只用于对表排序；不带日期、时区外标识或任何身份信息）。 */
function diagClock() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 值的脱敏读数：**前 20 字 ＋ 总长**（绝不记全文，也不记令牌）。 */
function diagValueOf(value) {
  const text = String(value === null || value === undefined ? '' : value)
  return `${text.slice(0, 20)}${text.length > 20 ? '…' : ''}(len=${text.length})`
}

/** 记一条里程碑（**永不外抛** —— 诊断面不得影响主流程）。 */
function diagNote(text) {
  try {
    diagLines.push(`${diagClock()} ${text}`)
    while (diagLines.length > CORRECTIONS_DIAG_LIMIT) diagLines.shift()
  } catch (err) {
    /* 观测失败即丢弃，不打扰调用方。 */
  }
}

/** 登记一次写面门的形态（供回包摘要的 `mode`；无门 ⇒ `''` ⇒ 摘要里显示 `—`）。 */
function diagMarkGate(gate) {
  diagGateMode = gate && gate.mode ? String(gate.mode) : ''
}

/** 本機鏡像行数读数（读失败 ⇒ `-1`，**不编造 0**）。 */
function diagLocalCount() {
  try {
    return listCorrectionRows().length
  } catch (err) {
    return -1
  }
}

/**
 * **观测缓冲读数（只读、无副作用）**。
 * @returns {string[]} 最近 `CORRECTIONS_DIAG_LIMIT` 条里程碑，**从旧到新**（新副本）
 */
export function correctionsReadout() {
  return diagLines.slice()
}

/** 勘误三态（规范冻结字面值）。 */
export const CORRECTION_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED'
}

/* ============================================================================
   **值级公开摘要面（本单新增 / 合并面）**：未采纳提交的公开脱敏摘要行
   ----------------------------------------------------------------------------
   为什么：本机 `corrections` 键只是**同一浏览器 profile 内的镜像**（A 浏览器提交的勘误，
   B 浏览器看不到 —— 在册缺口 W-54）⇒ 跨浏览器 / 跨用户的【採信】没有通道。本单新增
   值级公开摘要行（**零手机号**、uid 允许），由**服务端**在提交 / 采信 / 采纳后重算并
   幂等 upsert；前端详情页**只从它**渲染候选值列表 ⇒ 他人的 `PENDING` 值跨浏览器可见。
   行形状（与云函数 `cloudfunctions/xiai-user-token/lib/ops.js::buildCorrectionSummary` 同构）：
     `{ _id:'cs-<faceId>-<field>-<value 的 sha256 前 16 位>', faceId, sealId, stamp_id, field,
        value, submits, endorses, status, submitter_uids, updated_at, schema }`
   —— `submits` ＝ 未 REJECTED 的提交行**去重人数**、`endorses` ＝ 采信行**去重人数**、
   `status` ＝ 该值当前状态、`submitter_uids` ＝ 提交人 uid 去重列表（**不带昵称 / 手机号**）。
   本区块**只做摘要**：不改三态语义 / 不改显示名链（显示名仍只认 ACCEPTED）。
   ============================================================================ */

/** 值级公开摘要行的 schema 版本（与云函数 `ops.js::CORRECTION_SUMMARY_SCHEMA` 逐字同值）。 */
export const CORRECTION_SUMMARY_SCHEMA = 'xiai-correction-summaries-v1'

/** 值级公开摘要行文档键前缀（与云函数 `ops.js::CORRECTION_SUMMARY_ID_PREFIX` 逐字同值）。 */
export const CORRECTION_SUMMARY_ID_PREFIX = 'cs-'

/** 值级公开摘要行文档键：`cs-<faceId>-<field>-<value 的 sha256 前 16 位>`（与云函数同构）。 */
export function correctionSummaryIdOf(faceId, field, value) {
  return `${CORRECTION_SUMMARY_ID_PREFIX}${String(faceId)}-${String(field)}-${sha256Hex(String(value)).slice(0, 16)}`
}

/**
 * 由「提交行集合 ＋ 采信行集合」构造**值级公开摘要行**（纯函数；镜像云函数
 * `buildCorrectionSummary` —— 两侧同构，由 `scripts/verify-endorsement.mjs` 机械断言）。
 * @param {{faceId:string, sealId?:string, field:string, value:string,
 *   submissions?:Array<object>, endorsements?:Array<object>, at?:string}} input
 * @returns {object}
 */
export function buildCorrectionSummaryRow({ faceId, sealId = '', field, value, submissions, endorsements, at = '' }) {
  const statuses = []
  const submitterUids = []
  const seenSubmitters = new Set()
  ;(Array.isArray(submissions) ? submissions : []).forEach((row) => {
    const status = normalizeCorrectionStatus(row && row.status)
    statuses.push(status)
    if (status === CORRECTION_STATUS.REJECTED) return
    const uid = String((row && (row.user_id || row.userId)) || '')
    const identity = uid || String((row && (row.id || row._id)) || '')
    if (!identity || seenSubmitters.has(identity)) return
    seenSubmitters.add(identity)
    if (uid) submitterUids.push(uid)
  })
  const seenEndorsers = new Set()
  ;(Array.isArray(endorsements) ? endorsements : []).forEach((row) => {
    const uid = String((row && (row.user_id || row.userId)) || '')
    const identity = uid || String((row && (row._id || row.id)) || '')
    if (identity) seenEndorsers.add(identity)
  })
  const hasAccepted = statuses.indexOf(CORRECTION_STATUS.ACCEPTED) !== -1
  const allRejected = statuses.length > 0 && statuses.every((item) => item === CORRECTION_STATUS.REJECTED)
  const status = hasAccepted ? CORRECTION_STATUS.ACCEPTED : allRejected ? CORRECTION_STATUS.REJECTED : CORRECTION_STATUS.PENDING
  const normalizedSeal = String(sealId || '')
  return {
    _id: correctionSummaryIdOf(faceId, field, value),
    faceId: String(faceId || ''),
    sealId: normalizedSeal,
    stamp_id: normalizedSeal,
    field: String(field || ''),
    value: String(value === null || value === undefined ? '' : value),
    submits: seenSubmitters.size,
    endorses: seenEndorsers.size,
    status,
    submitter_uids: submitterUids,
    updated_at: String(at || ''),
    schema: CORRECTION_SUMMARY_SCHEMA
  }
}

/** **值级公开摘要行的本機鏡像幂等 upsert**（按 `_id` 覆盖；重复写不新增第二行）。 */
export function mirrorCorrectionSummaryRow(row) {
  if (!row || typeof row !== 'object') return null
  const id = String(row._id || '')
  const rows = listCorrectionSummaryMirrorRows()
  const exists = id !== '' ? rows.some((item) => String((item && item._id) || '') === id) : false
  const next = exists
    ? rows.map((item) => (String((item && item._id) || '') === id ? { ...item, ...row } : item))
    : [...rows, row]
  saveCorrectionSummaryRows(next)
  return row
}

/**
 * **本地 dev / 離線形態**：按本机提交行 ＋ 采信行重算并 upsert 值级公开摘要行（自愈：
 * 去重后计数，重置 / 重放不涨数）。**非正式写入路径** —— 云端形态由服务端重算后回传，
 * 前端只镜像（`mirrorCorrectionSummaryRow`）。
 * @returns {object} 摘要行
 */
export function syncLocalCorrectionSummary(faceId, sealId, field, value) {
  const key = (row) =>
    String((row && row.faceId) || '') === String(faceId) &&
    String((row && row.field) || '') === String(field) &&
    String((row && row.value) === null || (row && row.value) === undefined ? '' : row.value) === String(value)
  const submissions = listCorrectionRows().filter(key)
  const endorsements = listEndorsementRows().filter(key)
  const row = buildCorrectionSummaryRow({
    faceId,
    sealId,
    field,
    value,
    submissions,
    endorsements,
    at: new Date().toISOString()
  })
  return mirrorCorrectionSummaryRow(row)
}

/**
 * 可标记属性字段（与固定属性相对）。
 *
 * R-30 / R-31（2026-09-20）：
 *   - `seal_type` 的**显示名＝【印面内容】**（值是 9 值封闭集合，键名不变）；
 *   - 新增 `face_style` ＝【印面风格】（**新键**，印面级；23 值封闭集合）。
 *
 * 本单：新增 `seal_class` ＝【大類】（**新键**，**印面级**；3 值封闭集合 `古璽`/`流派印`/`雜項`）。
 * 真源＝`seed.js::SEAL_CLASS_OPTIONS`；服务端副本＝`cloudfunctions/xiai-user-token/lib/ops.js::MARKABLE_FIELDS`
 * （两表**逐字相等**由自检机械断言）。
 */
export const MARKABLE_FIELDS = [
  { key: 'seal_name', label: '印文' },
  { key: 'dynasty', label: '朝代' },
  { key: 'seal_type', label: '印面內容' },
  { key: 'face_style', label: '印面風格' },
  { key: 'seal_class', label: '大類' },
  { key: 'author', label: '作者' },
  { key: 'transcription', label: '印文釋義' }
]

/* ============================================================================
   **勘误只读面（本单｜W-54 收口）：本机镜像 ∪ 云端权威行**
   ----------------------------------------------------------------------------
   背景（既有缺口 W-54）：`xiai_corrections` 是 PRIVATE ACL、不进任何客户端读面 ⇒ 本机
   `localStorage` 镜像只看得到**本浏览器**提交的行（他人提交的行、本人换设备后的行都读不到）。
   本单新增两个**只读**云 op（云函数 `xiai-user-token` 的 `action:'verify'` 内派发、零写入）：
     · `listMyCorrections` —— 只回 `user_id` ＝ **服务端从令牌派生的 uid** 的行；
     · `listPendingCorrectionsForAdmin` —— 管理员白名单门后**跨用户**回待审行。
   读口径（逐条）：
     · **云端形态 ⇒ 云行 ∪ 本机镜像**（按行 id 去重、**本机行优先**）；
     · **local-dev / 离线 / 未登录 ⇒ 仅本机镜像**（行为与改前逐字一致）；
     · **云读失败 ⇒ 结构化失败 ＋ 可读降级文案**（**不静默、不以空集冒充**）；
     · 「可能還有更多」＝ 客户端按服务端 `count === limit`（单次上限 200）派生 ⇒ 回包零新键。
   ============================================================================ */

/** 只读 op 名（**须与云函数 `cloudfunctions/xiai-user-token/lib/ops.js` 的注册面逐字一致**）。 */
export const LIST_MY_CORRECTIONS_OP = 'listMyCorrections'

/** 同上（管理员待审面；落云函数 `ADMIN_OPS`）。 */
export const LIST_PENDING_CORRECTIONS_OP = 'listPendingCorrectionsForAdmin'

/** 单次云读上限（与云函数侧 `CORRECTION_ROWS_MAX_LIMIT` 同值；缺省亦为 200）。 */
export const CORRECTION_ROWS_LIMIT = 200

/** 行 id（云行 / 本机行同源：`id`，兜底 `_id`）。 */
function correctionRowKey(row) {
  return String((row && (row.id || row._id)) || '')
}

/** 按 `created_at` 倒序（与云函数侧同一口径）。 */
function sortCorrectionRows(list) {
  return list.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

/**
 * **云行 ∪ 本機鏡像**：按行 id 去重、**本机行优先**（本机行是提交时落的镜像，带 `batchId`
 * 等前端专有键）；无 id 的行原样保留（**不静默丢行**）。
 * @param {Array<object>} cloudRows 云端权威行
 * @param {Array<object>} localRows 本机镜像行
 * @returns {Array<object>} 已按 `created_at` 倒序的合并结果
 */
function mergeCorrectionRows(cloudRows, localRows) {
  const byKey = new Map()
  const withoutKey = []
  const put = (row, overwrite) => {
    const key = correctionRowKey(row)
    if (!key) {
      withoutKey.push(row)
      return
    }
    if (!overwrite && byKey.has(key)) return
    byKey.set(key, row)
  }
  ;(Array.isArray(cloudRows) ? cloudRows : []).forEach((row) => put(row, false))
  ;(Array.isArray(localRows) ? localRows : []).forEach((row) => put(row, true))
  return sortCorrectionRows([...byKey.values(), ...withoutKey])
}

/**
 * 云读门回包的结构化判读（**只认 `ok` / `rows`**；不改写真因、不编造假读数）。
 * @returns {null|{ok:false, reason:string, message:string}} `null` ＝ 放行
 */
function correctionRowsDenial(gate) {
  if (!gate || typeof gate !== 'object') {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '雲端回傳形狀不可辨識；本次零讀取。' }
  }
  if (gate.ok !== true) {
    return { ok: false, reason: gate.reason || 'STORAGE_UNAVAILABLE', message: gate.message || '雲端讀取被拒；本次零讀取。' }
  }
  if (!Array.isArray(gate.rows)) {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '雲端回傳未帶勘誤行（rows）；雲端讀數不可用。' }
  }
  return null
}

/** 由云读回包派生「可能還有更多」（`count === limit`；**不新增回包键**）。 */
function correctionRowsMaybeMore(gate, rows) {
  const raw = gate && gate.count !== undefined && gate.count !== null ? Number(gate.count) : NaN
  const cloudCount = Number.isFinite(raw) ? raw : rows.length
  return cloudCount === CORRECTION_ROWS_LIMIT
}

/** 诊断串包装：记「入参 / 回包摘要」**不改**回包（原样透传、原样外抛）。 */
export async function listMyCorrections() {
  const localBefore = diagLocalCount()
  diagGateMode = ''
  diagNote(
    `listMyCorrections 入參{limit:${CORRECTION_ROWS_LIMIT}, session:${currentUser() ? 'yes' : 'no'}, 本機鏡像:${localBefore}}`
  )
  let res
  try {
    res = await listMyCorrectionsInner()
  } catch (err) {
    diagNote(`listMyCorrections 回包{threw:${(err && err.message) || '未知錯誤'}}`)
    throw err
  }
  diagNote(
    `listMyCorrections 回包{ok:${!!(res && res.ok)}, reason:${(res && res.reason) || '—'}, ` +
      `rows:${res && Array.isArray(res.rows) ? res.rows.length : '—'}, mode:${diagGateMode || '—'}, 本機鏡像:${localBefore}}`
  )
  return res
}

async function listMyCorrectionsInner() {
  const user = currentUser()
  /* 未登录 ⇒ 与改前逐字一致：空集（零云端、零本机行）。 */
  if (!user) return { ok: true, rows: [], count: 0, maybeMore: false }
  const local = sortCorrectionRows(listCorrectionRows().filter((row) => row.user_id === user.id))
  /* 经登录令牌只读门（无令牌且有会话 ⇒ 先静默补签；与 `submitCorrection` 同一通道）。 */
  const gate = await userWriteGate(LIST_MY_CORRECTIONS_OP, { limit: CORRECTION_ROWS_LIMIT })
  diagMarkGate(gate)
  /* local-dev / 离线形态：门不发请求 ⇒ **仅本机镜像**（行为与改前逐字一致）。 */
  if (gate && gate.mode === 'local-dev') {
    return { ok: true, rows: local, count: local.length, maybeMore: false }
  }
  const denial = correctionRowsDenial(gate)
  if (denial) {
    /* 云读失败 ⇒ 结构化失败 ＋ 可读降级文案（**不静默**）；本机镜像随行返回供上屏，
       并在文案里写明「以下為本機鏡像」⇒ 不冒充云端读数。 */
    return {
      ok: false,
      reason: denial.reason,
      message: `雲端讀取我的勘誤記錄失敗：${denial.message}以下為本機鏡像，可能不完整。`,
      rows: local
    }
  }
  const merged = mergeCorrectionRows(gate.rows, local)
  return { ok: true, rows: merged, count: merged.length, maybeMore: correctionRowsMaybeMore(gate, gate.rows) }
}

export function summarizeCorrections(rows) {
  const list = Array.isArray(rows) ? rows : []
  return {
    total: list.length,
    pending: list.filter((r) => r.status === CORRECTION_STATUS.PENDING).length,
    accepted: list.filter((r) => r.status === CORRECTION_STATUS.ACCEPTED).length,
    rejected: list.filter((r) => r.status === CORRECTION_STATUS.REJECTED).length
  }
}


/* ============================================================================
   闭环补全（增量追加）
   ----------------------------------------------------------------------------
   上方既有的常量与只读查询签名、行为均未改动（仅把状态枚举字面值对齐规范）。
   以下为提交 / 汇总 / 审核的写入闭环。勘误**不覆盖**原始数据，
   对外的展示值由 resolveMarkable 汇总采纳结果后给出。
   ============================================================================ */

function makeId() {
  return `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * **提交单号工厂**（R-B2）：一次表单提交生成一次、N 条共享同一值。
 * 形如 `cb-<base36 時間>-<隨機>`，与勘误行 `cr-` 前缀**明确区分**（不会误当行 id）。
 * @returns {string}
 */
export function newBatchId() {
  return `cb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 提交单号上限（**服务层本地护栏**）：R-B2′ 下 `batchId` 是**前端专有字段**、
 * **绝不进提交载荷**（云函数键面封闭），故与云函数**无关**（云函数源码已回滚到 HEAD）。
 */
export const MAX_BATCH_ID_LENGTH = 64

/**
 * 旧数据回落窗口（R-B3）：无 `batchId` 的行按「提交人 ＋ 印面 ＋ `created_at` 60 秒窗」归批。
 * **服务层单点**实现，视图层不得另写第二套分组。
 */
export const LEGACY_BATCH_WINDOW_MS = 60000

/** 驳回理由上限（与数据层 `writeCorrectionDecision` / 视图弹窗 `maxlength` **同值**）。 */
export const MAX_REVIEW_NOTE_LENGTH = 200

function nowIso() {
  return new Date().toISOString()
}

function markableMeta(field) {
  return MARKABLE_FIELDS.find((item) => item.key === field) || null
}

/* ============================================================================
   勘误**提交侧**值域门（R-20 门 2 的缺口补全）
   ----------------------------------------------------------------------------
   为什么必须有：`submitCorrection` 原只校验「字段可勘误 + 值非空」，
   绕过 UI（选择框）直调服务层即可提交 `dynasty:'宋朝'` 这种 ∉ 15 类的 PENDING 勘误。
   值与真源：**复用** `seed.js` 的 `DYNASTY_OPTIONS` / `isKnownDynasty`，**不自写第二套**。
   判定时机：**写在写之前**。`saveCorrectionRows` 是**整集合覆盖写**且调用方不读返回值，
   所以「先写再靠返回值回滚」会**静默丢写入**（上一单已踩过）⇒ 本门一律在 `saveCorrectionRows`
   之前返回，天然零写入（勘误行数不变）。
   形态：表驱动（`field -> 值域描述`），便于将来其它字段封闭化；当前启用
   `dynasty`（R-20｜15 类）/ `seal_type`（R-30｜【印面内容】9 类）/ `face_style`（R-31｜【印面风格】23 类）；
   表里没有的字段 ⇒ 自由文本，一律放行（作者 / 印文等本轮不动）。
   ============================================================================ */

/**
 * **封闭值域表**（可扩展）：仅登记「取值必须来自封闭集合」的字段。
 * 未登记 ⇒ 自由文本（不拦）。
 *
 * 现有四项（**真源一律在 `src/data/seed.js`，不得自写第二套**）：
 *   - `dynasty`（R-20）：15 类，`DYNASTY_OPTIONS` / `isKnownDynasty`；
 *   - `seal_type`（R-30｜【印面内容】）：**9 值**，`FACE_CONTENT_OPTIONS` / `isKnownFaceContent`；
 *   - `face_style`（R-31｜【印面风格】）：**23 值**，`FACE_STYLE_OPTIONS` / `isKnownFaceStyle`；
 *   - `seal_class`（本单｜【大類】）：**3 值**，`SEAL_CLASS_OPTIONS` / `isKnownSealClass`。
 *
 * 拒绝形态＝结构化 `{ok:false, reason:'INVALID_VALUE', message}` ＋ **零写入**
 * （判定在写之前，见 `submitCorrection`）；**不得自写第二套**值域机制。
 *
 * ⚠️ **既有行的旧值不受本门约束**（R-21 / R-32）：库内旧值（`吉語印` / `鑒藏印` / `閒章`）
 * 照读不误；本门只拦**新提交 / 新写入**的值（换言之：旧值可以「读」，不可以「再写一遍」）。
 * @type {Record<string, {accepts:(text:string)=>boolean, denyMessage:(label:string, text:string)=>string}>}
 */
const FIELD_VALUE_DOMAINS = {
  /* 朝代（R-20）：真源＝`src/data/seed.js` 的 `DYNASTY_OPTIONS` / `isKnownDynasty`。 */
  dynasty: {
    accepts: (text) => isKnownDynasty(text),
    denyMessage: (label, text) =>
      `${label}「${text}」不在允許的 ${DYNASTY_OPTIONS.length} 類之內（${DYNASTY_OPTIONS.join('、')}），已拒絕提交；` +
      '請從給定選項中選擇。'
  },
  /* 【印面内容】（R-30）：真源＝`FACE_CONTENT_OPTIONS`（9 值；键名沿用 `seal_type`）。 */
  seal_type: {
    accepts: (text) => isKnownFaceContent(text),
    denyMessage: (label, text) =>
      `${label}「${text}」不在允許的 ${FACE_CONTENT_OPTIONS.length} 類之內（${FACE_CONTENT_OPTIONS.join('、')}），已拒絕提交；` +
      '請從給定選項中選擇。'
  },
  /* 【印面风格】（R-31）：真源＝`FACE_STYLE_OPTIONS`（23 值；新键 `face_style`）。 */
  face_style: {
    accepts: (text) => isKnownFaceStyle(text),
    denyMessage: (label, text) =>
      `${label}「${text}」不在允許的 ${FACE_STYLE_OPTIONS.length} 類之內（${FACE_STYLE_OPTIONS.join('、')}），已拒絕提交；` +
      '請從給定選項中選擇。'
  },
  /* 【大類】：真源＝`SEAL_CLASS_OPTIONS`（3 值；新键 `seal_class`，印面级）。 */
  seal_class: {
    accepts: (text) => isKnownSealClass(text),
    denyMessage: (label, text) =>
      `${label}「${text}」不在允許的 ${SEAL_CLASS_OPTIONS.length} 類之內（${SEAL_CLASS_OPTIONS.join('、')}），已拒絕提交；` +
      '請從給定選項中選擇。'
  },
  /* 【作者】（**person-model §4.2：自本模型起为引用型**）：载荷值是 `author_person_id`，
     值域门判**引用合法性**（指向的印人存在）；库中无此人 ⇒ 结构化拒绝（沿用既有字面值
     `INVALID_VALUE`；**不新增 reason**），并引导去提交印人提案。 */
  author: {
    accepts: (text) => personExistsById(text),
    denyMessage: (label, text) =>
      `${label}「${text}」在庫中沒有對應的印人 ⇒ 已拒絕提交；` +
      '請改選既有印人，或先提交印人提案、經管理員審覈通過後再選（不報錯即放行的自由文本已不再接受）。'
  }
}

/**
 * 值域门：字段落在封闭集合里且值 ∉ 真源 ⇒ 结构化拒绝（`INVALID_VALUE`，与数据层同字面值）。
 * @returns {null|{ok:false, reason:'INVALID_VALUE', message:string}} 放行 ⇒ `null`
 */
function domainValueDenial(field, label, text) {
  const domain = FIELD_VALUE_DOMAINS[field]
  if (!domain) return null // 未封闭的字段 ＝ 自由文本
  if (domain.accepts(text)) return null
  return { ok: false, reason: 'INVALID_VALUE', message: domain.denyMessage(label, text) }
}

/** 归属键：新数据用 `sealId`，旧数据只有 `stamp_id`（两者同值）。 */
function sealIdOf(row) {
  return row.sealId || row.stamp_id || ''
}

/** 某印面的勘误行；旧数据（无 `faceId`）按印章归属落到该印章的主印面。 */
function rowsOfFace(face) {
  if (!face) return []
  return listCorrectionRows().filter((row) => {
    if (row.faceId) return row.faceId === face.id
    return sealIdOf(row) === face.sealId && face.kind === FACE_KIND.FACE
  })
}

/* ============================================================================
   **公开投影面（r2 读面接线）**：已采纳勘误的**跨浏览器**来源
   ----------------------------------------------------------------------------
   为什么：本机 `corrections` 键只是**同一浏览器 profile 内的审核面镜像**（A 浏览器提交的
   勘误，B 浏览器看不到 —— 在册既有缺口 W-54）。「采纳后的标题修正要全站一致」就必须从
   **云端公开只读集合** `xiai_corrections_public` 取（`data/db.js::listPublicCorrectionRows`），
   且**只认已采纳**：公开集合是「已采纳投影」，`PENDING` 一律不参与展示。
   归并口径 = **本机勘误行（本地优先）∪ 公开投影行**，按**行身份**去重 ⇒ 同一条被采纳的
   勘误即使同时存在于本机镜像与云端投影也**只计一次**（不重复计数、不改变众数结论）。
   ============================================================================ */

/**
 * 行身份（去重键）：**规范单号优先**（`correction_id` → `id`，剥 `cp-` 前缀 ⇒
 * 本机勘误行 / 本机公开镜像行 / 云端公开投影行**归一到同一键**）；
 * 无单号时按「归属 ＋ 字段 ＋ 值」结构化拼键。
 */
function correctionIdentityOf(row) {
  const canonical = canonicalCorrectionIdOf(row)
  if (canonical) return `id:${canonical}`
  return `k:${sealIdOf(row)}|${String((row && row.faceId) || '')}|${String((row && row.field) || '')}|${String((row && row.value) || '')}`
}

/** 某印面的**公开投影**勘误行（已采纳；只看 `ACCEPTED`，`PENDING` / `REJECTED` 不参与展示）。 */
function publicRowsOfFace(face) {
  if (!face) return []
  return listPublicCorrectionRows().filter((row) => {
    if (normalizeCorrectionStatus(row.status) !== CORRECTION_STATUS.ACCEPTED) return false
    if (row.faceId) return row.faceId === face.id
    return sealIdOf(row) === face.sealId && face.kind === FACE_KIND.FACE
  })
}

/** **展示用**勘误行 = 本机勘误行（本地优先，含 PENDING —— 供 pendingCount）× 公开投影行；
    按行身份去重（本地行在前 ⇒ 同 id 时本地行胜出）。 */
function mergedRowsOfFace(face) {
  if (!face) return []
  const seen = new Set()
  const out = []
  ;[...rowsOfFace(face), ...publicRowsOfFace(face)].forEach((row) => {
    const key = correctionIdentityOf(row)
    if (seen.has(key)) return
    seen.add(key)
    out.push(row)
  })
  return out
}

/**
 * 某印面「**已被提交过的值**」分组（供详情页「可標記屬性」区的**采信（採信）列表**）。
 *
 * 分组键 ＝ `(field, value)`（**严格按值精确字符串比较、不做归一**：异体 / 标点差异都算不同的
 * 一段文字）。同一段文字由提交侧防重（`DUPLICATE_VALUE`）保证只对应一条提交；本函数只读，
 * 数据源 ＝ `mergedRowsOfFace`（本机勘误行 ∪ 公开投影行，按行身份去重）。
 *
 * 组的 `status`：组内**任一行**已采纳 ⇒ `ACCEPTED`，否则 `PENDING`
 * （已采纳的条目不接受采信 —— 见 `services/endorsements.js::endorsementDecision`）。
 * @param {object|null} face 印面（canonical）
 * @returns {Array<{field:string, label:string, value:string, status:string, submitterIds:string[]}>}
 */
export function submissionGroupsOfFace(face) {
  const groups = new Map()
  mergedRowsOfFace(face).forEach((row) => {
    const field = String((row && row.field) || '')
    const value = String((row && row.value) === null || (row && row.value) === undefined ? '' : row.value)
    if (!field || !value) return
    const key = `${field}\u0001${value}`
    if (!groups.has(key)) {
      const meta = markableMeta(field)
      groups.set(key, {
        field,
        value,
        label: meta ? meta.label : field,
        statuses: new Set(),
        submitterIds: new Set()
      })
    }
    const group = groups.get(key)
    group.statuses.add(normalizeCorrectionStatus(row.status))
    const submitter = String(row.user_id || row.userId || '')
    if (submitter) group.submitterIds.add(submitter)
  })
  return [...groups.values()].map((group) => ({
    field: group.field,
    value: group.value,
    label: group.label,
    status: group.statuses.has(CORRECTION_STATUS.ACCEPTED) ? CORRECTION_STATUS.ACCEPTED : CORRECTION_STATUS.PENDING,
    submitterIds: [...group.submitterIds]
  }))
}

/* ============================================================================
   **简繁等价展示提示（§3.78）**：纯函数比较面（只读、零副作用）
   ---------------------------------------------------------------------------- 口径（§3.78.1 / §3.78.4）：**防重 / 存储 / 比较三面一律不改** —— 本函数只做
   **只读比较**、结果只作用于渲染；`s2t` **不进入任何门**的判定（防重 / 值域 / 長度 /
   必填 / 採信冪等），也**不写库、不写入任何行字段**。
   归一 ＝ 仓内 `src/utils/traditional.js` 的同步 s2t（**不新写字典**）；「简繁等价」
   在此只是一個比較關係，不是新值域、不是新歸一化（判重仍逐字三鍵）。
   ============================================================================ */

/**
 * **纯函数**：返回与 `value` **字面不同、但 `s2t` 归一后相等**的候选值（去重、保持原序）。
 *
 * 判定（§3.78.2 ② / §3.78.3 ①）：候选 `c` 入选 ⇔ `c !== value` 且 `s2t(c) === s2t(value)`。
 * 因此**字面相同**的值不入选（防重面本就把它判作同一段文字）；**标点 / 异体 / 空白**
 * 差异在 s2t 下不折叠 ⇒ 自然不入选（`s2t` 不变 ⇒ 无提示，见 §3.78.2 ⑤ 不得反推）。
 * 入参容忍：`values` 非数组 ⇒ 空数组；`value` / 元素为空 / 非文字 ⇒ 归一成 `''`
 * （空串之间字面相等 ⇒ 恒返回 `[]`，即空值永不提示）。
 * **不改入参、不改任何数据、不抛错**。
 * @param {*} value 待比对的值（当前候选值 / 表单输入值）
 * @param {Array<*>} [values] 同字段的其它候选值（或含当前展示值）
 * @returns {Array<string>} 简繁等价且字面不同的候选值（去重、保持原序）
 */
export function cjkVariantPeersOf(value, values) {
  const text = value === null || value === undefined ? '' : String(value)
  const target = s2t(text)
  const seen = new Set()
  const peers = []
  ;(Array.isArray(values) ? values : []).forEach((item) => {
    const candidate = item === null || item === undefined ? '' : String(item)
    if (candidate === text) return // 字面相同 ⇒ 不是「疑似同值」（防重面已按同一段文字处理）
    if (s2t(candidate) !== target) return // s2t 归一后不等 ⇒ 不提示
    if (seen.has(candidate)) return // 去重、保持原序
    seen.add(candidate)
    peers.push(candidate)
  })
  return peers
}

/**
 * 提交勘误：一条勘误对应一个印面上的一个属性字段，状态自 PENDING 起。
 *
 * 拒绝形态一律**结构化**（`{ok:false, reason?, message}`），**不抛未捕获异常**：
 *   - 未登录 / 字段不可勘误 / 未指定印面 / 值为空 ⇒ 只有 `message`（无 `reason`，历史形态保留）；
 *   - **值域门（R-20 / R-30 / R-31）**：字段落在 `FIELD_VALUE_DOMAINS`
 *     （`dynasty` 15 类 / `seal_type` 9 类 / `face_style` 23 类）且值 ∉ 真源
 *     ⇒ `{ok:false, reason:'INVALID_VALUE', message}` + **零写入**（**写之前**判定）。
 *
 * **写面 Phase A 切片（2026-09-30）**：本入口由**同步**改为 **`async`**，判定顺序改为：
 *   ① 本地前置门（登录态 / 字段面 / 印面 / 空值 / 值域 —— 一律**在写之前**，拒绝即零写入）；
 *   ② **服务端门（云端形态下的唯一身份判据）**：`userGate('submitCorrection', payload)`
 *      ⇒ 云函数 `xiai-user-token` 验收用户令牌（HMAC 验签 → 有效期待 → `role==='user'`
 *      → `op` 值域 / 字段门）**并在云端落盘**（`xiai_corrections`，ACL `PRIVATE` ⇒ 只能由云函数写）；
 *      **创建者 uid / 手机号由服务端从令牌声明派生**（载荷里的身份类键被服务端拒 ⇒ `INVALID_FIELD`）；
 *      不过门 ⇒ **原样透传服务端结构化拒绝 ＋ 零写入**（传输层失败 ⇒ `STORAGE_UNAVAILABLE`，
 *      **绝不伪装 `FORBIDDEN`**）；
 *   ③ 过门后：**dev / 离线形态** ⇒ 本地落盘（**非正式写入路径**，身份仍是本地 `user.id`）；
 *      **云端形态** ⇒ 本地只写**服务端回传的那一行**（镜像；不是前端自建行）；回传缺行 ⇒
 *      `STORAGE_UNAVAILABLE`（**不冒充成功、不冒充越权**），返回 `authority` 供调用方区分。
 */
/** 诊断串包装：记「入参（值只留前 20 字 ＋ 长度）/ 回包摘要 ＋ 本机镜像行数变化」。 */
export async function submitCorrection(args = {}) {
  const { faceId = '', sealId = '', stampId = '', field, value, batchId = '' } = args || {}
  const localBefore = diagLocalCount()
  diagGateMode = ''
  diagNote(
    `submitCorrection 入參{faceId:${faceId || '—'}, sealId:${sealId || stampId || '—'}, ` +
      `field:${field === undefined || field === null ? '—' : field}, value:${diagValueOf(value)}, ` +
      `batchId:${batchId ? 'given' : 'auto'}, 本機鏡像:${localBefore}}`
  )
  let res
  try {
    res = await submitCorrectionInner(args)
  } catch (err) {
    diagNote(`submitCorrection 回包{threw:${(err && err.message) || '未知錯誤'}}`)
    throw err
  }
  const localAfter = diagLocalCount()
  diagNote(
    `submitCorrection 回包{ok:${!!(res && res.ok)}, reason:${(res && res.reason) || '—'}, ` +
      `authority:${(res && res.authority) || '—'}, ` +
      `message:${String((res && res.message) || '—').slice(0, 80)}, mode:${diagGateMode || '—'}, ` +
      `本機鏡像:${localBefore}→${localAfter}}`
  )
  return res
}

async function submitCorrectionInner({
  faceId = '',
  sealId = '',
  stampId = '',
  field,
  value,
  basis = '',
  batchId = ''
} = {}) {
  const user = currentUser()
  if (!user) return { ok: false, message: '請先登錄後再提交勘誤' }
  const meta = markableMeta(field)
  if (!meta) return { ok: false, message: '該屬性不支持勘誤' }

  /* 印面定位：优先 faceId；旧调用方只给印章编号时落到该印章的主印面。 */
  const targetSealId = sealId || stampId
  const face = faceId ? getFaceById(faceId) : targetSealId ? primaryFaceOf(targetSealId) : null
  if (!face) return { ok: false, message: '未指定印面' }

  const text = String(value === null || value === undefined ? '' : value).trim()
  if (!text) return { ok: false, message: `請填寫${meta.label}` }

  /* 提交单号（R-B2）：**判定在写之前** —— 传了非法值 ⇒ `INVALID_VALUE` ＋ 零写入；
     **未传 / 空串 ⇒ 服务层为该次调用生成一个**（一条一批），**不报错**。 */
  if (batchId !== undefined && batchId !== null && typeof batchId !== 'string') {
    return { ok: false, reason: 'INVALID_VALUE', message: '提交單號必須是文字；本次零寫入。' }
  }
  const rawBatch = batchId === undefined || batchId === null ? '' : String(batchId).trim()
  if (rawBatch.length > MAX_BATCH_ID_LENGTH) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `提交單號超出上限（${MAX_BATCH_ID_LENGTH} 字）；本次零寫入。`
    }
  }
  const batch = rawBatch || newBatchId()

  /* 值域门（R-20 / R-30 / R-31）：**写之前**判定，拒绝即零写入（不新增勘误行、不改动既有行）。
     看 `FIELD_VALUE_DOMAINS` 里登记了哪些封闭字段；未登记字段（作者 / 印文…）不受影响。 */
  const denied = domainValueDenial(field, meta.label, text)
  if (denied) return denied

  /* **提交侧防重（本单）**：同 `(faceId, field, value)` 已有提交行（本机前置门）⇒ `DUPLICATE_VALUE`
     ＋ 零写入。严格判据：值**逐字相同**即重复（含异体 / 标点差异 ⇒ 按**精确字符串比较**，不做归一）；
     同一段文字只允许一人提交 —— 第二人应改用【採信】。云端形态下另有服务端权威门（以服务端为准）。
     **防重只认未驳回行（冻结口径 2026-11-02）**：`status` 归一后为 `REJECTED` 的行**不参与防重**
     （被驳回的值允许再次提交 —— 与印人提案面「已有未驳回提案才判重复」同形）。 */
  const duplicate = rowsOfFace(face).some(
    (row) =>
      normalizeCorrectionStatus(row && row.status) !== CORRECTION_STATUS.REJECTED &&
      String((row && row.field) || '') === String(field) &&
      String((row && row.value) === null || (row && row.value) === undefined ? '' : row.value).trim() === text
  )
  if (duplicate) {
    return {
      ok: false,
      reason: 'DUPLICATE_VALUE',
      message: `該印面「${meta.label}」已有完全相同的提交值「${text}」⇒ 同一段文字只允許一人提交；若你贊同該值，請改用【採信】為它佐證。`
    }
  }

  /* **`batchId` 绝不进提交载荷**（R-B2′，生产事故级）：云函数 `ops.js` 的 `ALLOWED_KEYS`
     是**封闭键面**，载荷含未知键 ⇒ `INVALID_FIELD` ＋ 零写入 ⇒ 传 `batchId` 会打挂**线上
     所有**勘误提交。提交单号是**前端专有字段**，只在 local-dev 本地行 / 云端本地镜像行上落盘。 */
  const payload = {
    faceId: face.id,
    sealId: face.sealId,
    stampId: face.sealId,
    field,
    value: text,
    basis: String(basis || '').trim()
  }
  const faceLabel = faceLabelOf(face.id, face.sealId)

  /* ② **服务端门**（云端形态下唯一身份判据 ＋ 权威落盘）；经登录令牌写面门 ⇒
     **无令牌且有会话时先静默补签**（修「刷新后提交勘误必失败」）。 */
  const gate = await userWriteGate('submitCorrection', payload)
  diagMarkGate(gate)
  if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }

  if (gate.mode === 'local-dev') {
    /* ③-a dev / 離線形態：本地落盘（**非正式寫入路徑**）。 */
    const row = {
      id: makeId(),
      faceId: face.id, // 规范字段：勘误挂在印面上
      sealId: face.sealId, // 规范字段：所属印章
      stamp_id: face.sealId, // 兼容别名：＝sealId，勿删
      userId: user.id, // 规范字段：提交人（本地形态 ⇒ 本地身份）
      user_id: user.id, // 兼容别名：＝userId
      field,
      field_label: meta.label,
      value: text,
      basis: payload.basis,
      status: CORRECTION_STATUS.PENDING,
      created_at: nowIso(),
      reviewed_at: null,
      reviewer_id: null,
      rewarded_at: null,
      batchId: batch // 提交单号（一次表单提交共享一个；R-B2）
    }
    saveCorrectionRows([...listCorrectionRows(), row])
    /* **摘要行重算（本地 dev / 離線）**：upsert 该值级公开摘要行（**非正式寫入路徑**）。 */
    syncLocalCorrectionSummary(face.id, face.sealId, field, text)
    return {
      ok: true,
      row,
      authority: 'LOCAL_DEV',
      message: `已提交「${faceLabel}·${meta.label}」勘誤，待審覈（dev / 離線形態，非正式寫入路徑）`
    }
  }

  /* ③-b 雲端形態：**服務端已落盤** ⇒ 本地只寫服務端回傳的那一行（鏡像；身份／時間／狀態皆為服務端值）。
     本地镜像行 = `{ ...gate.row, batchId }` —— **只加这一个前端字段**（提交单号；云端权威行暂无该键：
     云函数键面封闭 ＋ 本单无合规部署通道 ⇒ 云端权威行不落 `batchId`），**其余键逐字仍为服务端权威值**。
     分组读面的 `batchId` 取自本机 localStorage 的该镜像行 ⇒ 云端形态**无功能差异**。 */
  const serverRow = gate.row
  if (!serverRow || typeof serverRow !== 'object') {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '雲端回傳缺少權威行，無法確認寫入內容；本機未鏡像（雲端是否已寫入未知）。'
    }
  }
  const row = { ...serverRow, batchId: batch }
  saveCorrectionRows([...listCorrectionRows(), row])
  /* **摘要行镜像（云端形态）**：服务端已重算值级公开摘要行 ⇒ 本地只镜像它（非前端自建）。 */
  mirrorCorrectionSummaryRow(gate.summary)
  return {
    ok: true,
    row,
    authority: 'SERVER',
    docId: gate.docId,
    message: `已提交「${faceLabel}·${meta.label}」勘誤，待審覈`
  }
}

export function listCorrectionsOfStamp(stampId) {
  return listCorrectionRows().filter((row) => sealIdOf(row) === stampId)
}

/** 某印面的全部勘误（含旧数据按印章归属的回落）。 */
export function listCorrectionsOfFace(faceId) {
  return rowsOfFace(getFaceById(faceId))
}

/** 审核队列（管理员用），默认按时间倒序。 */
export function listAllCorrections({ status = '' } = {}) {
  return listCorrectionRows()
    .filter((row) => (status ? row.status === status : true))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

/**
 * 汇总某印面的可标记属性对外展示值。
 * 可信度口径：同一字段的**已采纳**勘误里取出现次数最多的提交值；
 * 次数相同时取最近一条。采纳结果只影响展示，不写回原始数据。
 * 参数可以是印面（canonical）或印章（兼容：按主印面汇总）。
 * @returns {Array<{key:string,label:string,original:string,display:string,source:string,acceptedCount:number,pendingCount:number}>}
 */
export function resolveMarkable(target) {
  const face = target && target.kind ? target : target ? primaryFaceOf(target.stamp_id) : null
  /* 展示用行 = 本机勘误行 ∪ **公开投影行**（已采纳；跨浏览器一致）—— 见 `mergedRowsOfFace`。 */
  const rows = face ? mergedRowsOfFace(face) : []
  return MARKABLE_FIELDS.map((meta) => {
    const original = face ? face[meta.key] : ''
    const all = rows.filter((row) => row.field === meta.key)
    const accepted = all.filter((row) => row.status === CORRECTION_STATUS.ACCEPTED)
    const tally = new Map()
    accepted.forEach((row) => {
      const entry = tally.get(row.value) || { value: row.value, count: 0, at: '' }
      entry.count += 1
      if (String(row.reviewed_at || row.created_at) > entry.at) entry.at = String(row.reviewed_at || row.created_at)
      tally.set(row.value, entry)
    })
    const ranked = [...tally.values()].sort((a, b) => b.count - a.count || b.at.localeCompare(a.at))
    const winner = ranked[0] || null
    const raw = original === null || original === undefined ? '' : String(original)
    return {
      key: meta.key,
      label: meta.label,
      original: raw,
      display: winner ? winner.value : raw,
      source: winner ? 'CORRECTION' : 'ORIGINAL',
      acceptedCount: winner ? winner.count : 0,
      pendingCount: all.filter((row) => row.status === CORRECTION_STATUS.PENDING).length
    }
  })
}

/**
 * **印章 / 印面显示名的单点入口（r2 读面接线）**：
 *   **采纳值 → 原始 `seal_name` →「佚名」**（链的实现在 `data/db.js::sealDisplayName`）。
 *
 * 视图 / 服务层**一律**经本函数取名（不得再内联 `seal_name || '佚名'`）——
 * 「采纳后的标题修正」由此**全站一致**（采纳值来自本机勘误行 ∪ **云端公开投影集合**，
 * 见 `resolveMarkable` / `mergedRowsOfFace`）。
 *
 * 入参接受多种行形态（只做**只读**的归属推断，不改任何数据）：
 *   · 印面（视图模型 / 行，带 `kind`）⇒ 直接按其自身汇总；
 *   · 印章（视图模型 / 行，带 `stamp_id`）/ 雲盤簡報（带 `seal_id`）/ 照片行（带 `stamp_id`）
 *     ⇒ 取其**主印面**（`primaryFaceOf`，R-44 口径）汇总；
 *   · 认不出归属 ⇒ 退回原始 `seal_name` ⇒「佚名」（**不冒充**采纳值）。
 * @param {object|null} row 印章 / 印面 / 投影行
 * @returns {string} 采纳值 / 原始印文 /「佚名」
 */
export function resolveSealDisplayName(row) {
  const face = faceTargetOf(row)
  let accepted = ''
  if (face) {
    const item = resolveMarkable(face).find((meta) => meta.key === 'seal_name')
    if (item && item.source === 'CORRECTION') accepted = item.display
  }
  return sealDisplayName(row, accepted)
}

/**
 * **作者显示名（单点转发；person-model §4.1）**：卡片 / 详情 / 导出 / 文本导出**一律**经本函数。
 *
 * 链（真源仍是**数据层单点** `data/db.js::resolveAuthorName`，本函数**只转发、不另立第二套名表**）：
 *   `author_person_id` → **命中** ⇒ 印人 `display_name` → **未命中** ⇒ 旧 `author` 自由文本 →
 *   皆空 ⇒「佚名」。
 * **采纳值（若存在）按引用型解**：已采纳的 `author` 勘误值本身是一个 `author_person_id`
 * （§4.2），先并入再解链 ⇒ 采纳后的作者显示名与全站一致。
 * @param {object|null} row 印面 / 印章行（视图模型）
 * @returns {string} 作者显示名
 */
export function resolveAuthorDisplayName(row) {
  const face = faceTargetOf(row)
  let acceptedRef = ''
  if (face) {
    const item = resolveMarkable(face).find((meta) => meta.key === 'author')
    if (item && item.source === 'CORRECTION') acceptedRef = String(item.display || '').trim()
  }
  const merged = acceptedRef ? { ...(row || {}), author_person_id: acceptedRef } : row
  return resolveAuthorName(merged)
}

/** 由任意行形态推断「用于汇总的印面」（只读；认不出 ⇒ `null`）。 */
function faceTargetOf(row) {
  if (!row || typeof row !== 'object') return null
  if (row.kind) return row
  const sealId = String(row.sealId || row.stamp_id || row.seal_id || '').trim()
  if (!sealId) return null
  return primaryFaceOf(sealId)
}

/* ============================================================================
   审核勘误（v1.3｜载体改为「我的勘误记录」页内的「采纳 / 驳回」按钮）
   ----------------------------------------------------------------------------
   冻结给 UI 单的服务层 API：`listPendingForAdmin(actor)` / `review(actor, id, decision)`。
   发奖入口；采纳 +10 金且**每条只奖一次**（幂等由 `points.awardCorrectionReward` 承担）。
   非管理员一律**结构化拒绝**（`{ok:false, reason:'FORBIDDEN'}`，§3.12.10(c)：与数据层同字面值），
   不抛未捕获异常。
   ============================================================================ */

/** 当前（或指定）账号是否可审核勘误 —— 供 /my/corrections 决定是否渲染「采纳 / 驳回」。 */
export function canReviewCorrections(actor) {
  const who = actor || currentUser()
  return who !== null && who !== undefined && who.role === 'admin'
}

/**
 * **冻结 API ③**：管理员可见的审核队列 —— **全部用户的 `PENDING`**（不是仅自己的）。
 *
 * 与数据层同口径：非管理员一律**结构化拒绝**
 * `{ok:false, reason:'FORBIDDEN', message:'仅管理员可以查看全部用户的待审勘误'}`
 * （§3.12.10(c) 字面值与数据层同源；**不以空集冒充拒绝**，形状与写入口 `review()` 一致）；
 * 管理员 ⇒ `{ok:true, rows}`。两条路径均**不抛未捕获异常**。
 *
 * **本单（W-54）改为 `async` 云端读**：云端形态 ⇒ 云行 ∪ 本機鏡像（按行 id 去重、本机行优先）；
 * local-dev / 离线 ⇒ 仅本机镜像（行为与改前逐字一致）；云读失败 ⇒ **恰 3 键结构化拒绝**
 * （**不以本机镜像冒充待审读数**，由调用方上屏「讀數不可用」）。成功回包**增补**两个加性键
 * `count`（＝ `rows.length`）与 `maybeMore`（服务端 `count === limit` 派生；既有调用方不受影响）。
 *
 * 适配登记（2026-09-20 收口）：服务层读入口由「裸数组」改为「结构化结果」，**调用点同步适配**
 * —— 唯一产品侧调用点是 `src/views/MyCorrectionsView.vue`（队列读数读 `result.ok ? result.rows : []`，
 * 并把 `result.message` 作为可读文案渲染，**不静默**）。
 * @param {object|null} actor 操作者（须为管理员；缺省回落到当前登录态）
 * @returns {Promise<{ok:true, rows:Array<object>, count:number, maybeMore:boolean}
 *   |{ok:false, reason:string, message:string}>}
 *   `rows` 为 `PENDING` 勘误行（按提交时间倒序）
 */
/** 诊断串包装：记「入参 / 回包摘要（含本机镜像行数）」**不改**回包（原样透传、原样外抛）。 */
export async function listPendingForAdmin(actor) {
  const localBefore = diagLocalCount()
  diagGateMode = ''
  diagNote(
    `listPendingForAdmin 入參{status:${CORRECTION_STATUS.PENDING}, limit:${CORRECTION_ROWS_LIMIT}, ` +
      `actor:${canReviewCorrections(actor || currentUser()) ? 'admin' : 'non-admin'}, 本機鏡像:${localBefore}}`
  )
  let res
  try {
    res = await listPendingForAdminInner(actor)
  } catch (err) {
    diagNote(`listPendingForAdmin 回包{threw:${(err && err.message) || '未知錯誤'}}`)
    throw err
  }
  diagNote(
    `listPendingForAdmin 回包{ok:${!!(res && res.ok)}, reason:${(res && res.reason) || '—'}, ` +
      `rows:${res && Array.isArray(res.rows) ? res.rows.length : '—'}, mode:${diagGateMode || '—'}, 本機鏡像:${localBefore}}`
  )
  return res
}

async function listPendingForAdminInner(actor) {
  const who = actor || currentUser()
  /* 与写入口 `review` 同判定：非管理员**结构化拒绝**（不是空集）。 */
  if (!canReviewCorrections(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以查看全部用戶的待審勘誤' }
  }
  /* ① 本机镜像（与改前同一段逻辑；数据层拒绝 ⇒ **原样透传、不再发起云读**）。 */
  let res
  try {
    res = listPendingCorrectionRowsForAdmin(who)
  } catch (err) {
    /* 数据层已改为结构化拒绝；此兜底只为保证展示面不崩（如实回报，绝不外抛）。 */
    if (isPermissionError(err)) {
      return { ok: false, reason: 'FORBIDDEN', message: err.message || '僅管理員可以查看全部用戶的待審勘誤' }
    }
    return { ok: false, reason: 'INTERNAL_ERROR', message: `讀取待審勘誤失敗：${(err && err.message) || '未知錯誤'}` }
  }
  let local = null
  if (Array.isArray(res)) {
    local = res // 兼容：万一数据层回退成裸数组
  } else if (res && res.ok) {
    local = Array.isArray(res.rows) ? res.rows : []
  } else {
    /* 数据层结构化拒绝 ⇒ 原样透传（reason / message 同字面值），不吞成空集。 */
    return {
      ok: false,
      reason: (res && res.reason) || 'FORBIDDEN',
      message: (res && res.message) || '僅管理員可以查看全部用戶的待審勘誤'
    }
  }
  /* ② 云端只读（管理员白名单门在**服务端**判；缺 `XIAI_ADMIN_PHONE` ⇒ 结构化拒绝 ＋ 零读取）。 */
  const gate = await userWriteGate(LIST_PENDING_CORRECTIONS_OP, {
    status: CORRECTION_STATUS.PENDING,
    limit: CORRECTION_ROWS_LIMIT
  })
  diagMarkGate(gate)
  /* local-dev / 离线形态：门不发请求 ⇒ **仅本机镜像**（行为与改前逐字一致）。 */
  if (gate && gate.mode === 'local-dev') {
    return { ok: true, rows: local, count: local.length, maybeMore: false }
  }
  const denial = correctionRowsDenial(gate)
  if (denial) {
    /* 云读失败 ⇒ **恰 3 键结构化拒绝**（与写入口同形）；**不以本机镜像冒充待审读数**。 */
    return { ok: false, reason: denial.reason, message: `雲端讀取待審勘誤失敗：${denial.message}待審讀數不可用。` }
  }
  const merged = mergeCorrectionRows(gate.rows, local)
  return { ok: true, rows: merged, count: merged.length, maybeMore: correctionRowsMaybeMore(gate, gate.rows) }
}

function isPermissionError(err) {
  return err instanceof PermissionError || (err && err.name === 'PermissionError')
}

/** 采纳写面（V3）的**云端门 op 名**（须与云函数 `xiai-user-token/lib/ops.js::ADMIN_OPS` 的注册面逐字一致）。 */
export const REVIEW_OP = 'reviewCorrection'

/**
 * 采纳写面的**回包读数声明**（additive 透传；经 `userWriteGate` 第三参逐字上抛）。
 * `image_action` ＝ 云端对 **IMAGE 行**（§3.77 影像勘誤）采纳后的执行读数
 * `{action, removed:{rows,objects}, shared_kept}`；**字段型行回包不含该键**
 * ⇒ 声明它不改变既有任何回包（未声明的键永远不进回包）。
 */
export const REVIEW_READOUT_KEYS = Object.freeze(['image_action'])

/**
 * 采纳写面载荷的**封闭键面**（**须与云函数 `lib/ops.js::ALLOWED_KEYS` 逐字同值**）。
 *
 * 为什么必须逐字：云函数侧 `ALLOWED_KEYS` 是**服务端封闭面** —— 载荷里出现未登记键
 * ⇒ `INVALID_FIELD` ＋ **零写入**（明文不许静默丢键）。实测踩过：客户端曾用 `id`
 * 作单号键，而服务端登记的是 `correction_id` ⇒ **云端形态下采纳写面被全量拒绝**
 * （本地 dev 形态照样通过 ⇒ 本地绿、线上红）。密钥名对齐由
 * `scripts/verify-correction-display.mjs` 的 `D1` **机械断言**（两处逐字相等）。
 */
export const REVIEW_PAYLOAD_KEYS = ['correction_id', 'decision', 'note']

/**
 * **撤销采纳写面（本单）的云端门 op 名**（须与云函数
 * `cloudfunctions/xiai-user-token/lib/ops.js::ADMIN_OPS` 的注册面逐字一致）。
 */
export const REVOKE_OP = 'revokeCorrectionAcceptance'

/**
 * **撤销采纳载荷的封闭键面**（**须与云函数 `lib/ops.js::REVOKE_ALLOWED_KEYS` 逐字同值**）：
 * 恰两键 —— `correction_id`（必有）＋ `note`（可选，≤ `MAX_REVIEW_NOTE_LENGTH` 字）。
 *
 * **零 `decision`**：撤销的方向由**服务端 op** 钉死（只许 `ACCEPTED → REJECTED`），
 * 前端不选方向；**零身份类键**（身份永远由服务端从令牌 / 平台会话派生 ⇒ 夹带即 `INVALID_FIELD`
 * ＋ 零写入，与 `REVIEW_PAYLOAD_KEYS` 同一套服务端判据）。
 */
export const REVOKE_PAYLOAD_KEYS = ['correction_id', 'note']

/**
 * 公开只读投影行的**封闭键面**（**须与云函数 `lib/ops.js::PUBLIC_PROJECTION_KEYS` 逐字同值**；
 * 以 `_id` 作文档键 ⇒ 该键**不在**本表，单列在 `PUBLIC_ID_FIELD`）。
 * 身份 / 奖励 / 理由类字段**一律不在本表**（脱敏投影）。
 */
export const PUBLIC_PROJECTION_KEYS = [
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
]

/** 公开投影行的文档键名（云端落 `_id`；本機鏡像落同名字段 ⇒ 覆盖层可按 `_id` 配对）。 */
export const PUBLIC_ID_FIELD = '_id'

/** 公开投影 schema 版本（与云函数 `PUBLIC_SCHEMA` 逐字同值）。 */
export const PUBLIC_PROJECTION_SCHEMA = 'xiai-corrections-public-v1'

/** 公开投影行文档键前缀（与云函数 `PUBLIC_ID_PREFIX` 逐字同值）。 */
export const PUBLIC_ID_PREFIX = 'cp-'

/**
 * 勘误行的**规范单号**（公开投影行以 `correction_id` 为主；兼容只有 `id` 的历史行，
 * 并把云端投影文档键前缀 `cp-` 剥掉）。
 * 用途：让「本机勘误行（`id`）」「本机公开镜像行（`correction_id`）」与
 * 「云端公开投影行（`correction_id` ＋ `_id='cp-…'`）」**归一到同一个行身份**
 * （去重 / 覆盖层配对都靠它，见 `correctionIdentityOf`）。
 */
function canonicalCorrectionIdOf(row) {
  if (!row || typeof row !== 'object') return ''
  const explicit = String(row.correction_id || '').trim()
  if (explicit) return explicit
  return String(row.id || '').trim().replace(/^cp-/, '')
}

/**
 * 把一条**已采纳**勘误裁剪成**公开投影行**（只留展示所需字段）。
 * 身份（`user_id` / `reviewer_id`）/ 奖励（`rewarded_at`）/ 理由（`review_note`）**一律不落**——
 * 公开集合是匿名可读面，只承载「展示所需的最少字段」。
 *
 * **键面与云函数 `buildProjection` 逐字对齐**：主键用 `correction_id`（**不再用 `id`**），
 * 带 `schema` / `updated_at`；文档键 `_id` 由 `mirrorAcceptedToPublic` 统一补
 * `cp-<correction_id>`（与云端落盘形态一致 ⇒ 覆盖层可配对、去重可归一）。
 */
function publicProjectionOf(row, at = '') {
  const sealId = sealIdOf(row)
  const stamp = String((row && row.stamp_id) || sealId || '')
  return {
    correction_id: canonicalCorrectionIdOf(row),
    faceId: String((row && row.faceId) || ''),
    sealId,
    stamp_id: stamp,
    field: String((row && row.field) || ''),
    field_label: String((row && row.field_label) || ''),
    value: String((row && row.value) || ''),
    status: CORRECTION_STATUS.ACCEPTED,
    reviewed_at: String((row && row.reviewed_at) || at || ''),
    updated_at: String((row && row.updated_at) || (row && row.reviewed_at) || at || ''),
    schema: PUBLIC_PROJECTION_SCHEMA
  }
}

/**
 * 把已采纳勘误写进**公开投影的本機鏡像**（键 `xiai:v1:corrections-public`）。
 *
 * **幂等 upsert**：按**规范行身份**（`correction_id` → `id`，剥 `cp-` 前缀）覆盖既有行、
 * 无则追加（重复采纳 / 重放不会新增第二行；历史 `id` 形态的镜像行也能被覆盖）。
 * 只读 **本機鏡像**（`listPublicCorrectionMirrorRows`）——不把云端行一并写回本机键。
 *
 * **与云端落盘逐字对齐**：优先采用云函数回包的 `projection`（服务端权威公开行）；
 * 缺省（dev / 離線形態，无云端）才由 `publicProjectionOf` 本地派生。落盘统一补
 * `_id = 'cp-<correction_id>'`（与云端文档键同值）⇒ 云端形态下数据层覆盖层
 * （`db.js::withLocalOverlay`，按 `_id` 配对）会把本機鏡像与云端投影行**合成一行**，
 * 不产生「同一条勘误两行」的重复。
 * @param {object} row 已采纳的勘误行（本机权威行）
 * @param {object} [serverProjection] 云函数回包的公开投影行（可选；服务端权威形态）
 * @param {string} [status] 投影行目标状态（**缺省 `ACCEPTED`** ⇒ 既有采纳调用方逐字不变）；
 *   撤销采纳路传 `REJECTED` ⇒ 本机公开投影镜像与云端 `xiai_corrections_public` 投影行同状态
 *   （不改就会**以本机 `ACCEPTED` 盖掉云端 `REJECTED`** —— `db.js::withLocalOverlay` 是本地优先）。
 */
function mirrorAcceptedToPublic(row, serverProjection, status = CORRECTION_STATUS.ACCEPTED) {
  const source = serverProjection && typeof serverProjection === 'object' ? serverProjection : publicProjectionOf(row)
  const correctionId = canonicalCorrectionIdOf(source)
  if (!correctionId) return null
  const projection = {
    [PUBLIC_ID_FIELD]: `${PUBLIC_ID_PREFIX}${correctionId}`,
    correction_id: correctionId,
    faceId: String(source.faceId || ''),
    sealId: String(source.sealId || ''),
    stamp_id: String(source.stamp_id || source.sealId || ''),
    field: String(source.field || ''),
    field_label: String(source.field_label || ''),
    value: String(source.value || ''),
    status,
    reviewed_at: String(source.reviewed_at || ''),
    updated_at: String(source.updated_at || source.reviewed_at || ''),
    schema: String(source.schema || PUBLIC_PROJECTION_SCHEMA)
  }
  const identity = correctionIdentityOf(projection)
  const rows = listPublicCorrectionMirrorRows()
  const exists = rows.some((item) => correctionIdentityOf(item) === identity)
  const next = exists
    ? rows.map((item) => (correctionIdentityOf(item) === identity ? { ...item, ...projection } : item))
    : [...rows, projection]
  savePublicCorrectionRows(next)
  return projection
}

/**
 * **本机镜像更正（云端权威优先）** —— 服务端是权威、本机只是镜像。
 *
 * 触发场景：**云端门已成功落盘**（`gate.mode==='cloud'` ⇒ 云函数已写权威行），而本机
 * `writeCorrectionDecision` **未成功**（`!decided.ok`；常见成因 `ALREADY_REVIEWED` ——
 * 本机与云端状态不一致，或同一行在另一页签已本地采纳）⇒ **不得把它当失败返回**。
 * 做法：以**服务端回包的权威行**（`gate.row`：仅供「决定面」字段 status / reviewed_at /
 * reviewer_id / field_label / review_note）更正**本機鏡像行**（`corrections` 键），
 * 采纳时再同步**公开投影的本機鏡像**（`gate.projection` 为服务端权威投影行）。
 * **仅本地镜像写、不额外调云**（云端已由本 op 落盘）。
 *
 * 本机侧**只读 / 只写**「本机状态与云端状态不一致」这一层，**不改**勘误三态语义 / 幂等 /
 * +10 金奖励；本机行身份键（`row.id`）与本地专有字段（如 `batchId`）**原样保留**。
 * @param {string} correctionId 勘误单号（本机行身份键 `row.id`）
 * @param {object} authorityRow 服务端回包的权威行（`gate.row`）
 * @param {object} [projection] 服务端回包的公开投影行（`gate.projection`）
 * @returns {{row:object, status:string, accepted:boolean, existed:boolean}|null} 无法更正 ⇒ `null`
 */
function reconcileLocalMirrorFromAuthority(correctionId, authorityRow, projection) {
  const authority = authorityRow && typeof authorityRow === 'object' ? authorityRow : null
  if (!authority) return null
  const status = normalizeCorrectionStatus(authority.status)
  if (status !== CORRECTION_STATUS.ACCEPTED && status !== CORRECTION_STATUS.REJECTED) return null
  const rows = listCorrectionRows()
  const target = rows.find((row) => row.id === correctionId) || null
  /* 保留本机行专有字段（`id` / `batchId` / `rewarded_at` 等）；只覆盖「决定面」权威字段。 */
  const next = { ...(target || { id: correctionId }) }
  next.status = status
  if (authority.reviewed_at !== undefined && authority.reviewed_at !== null) next.reviewed_at = authority.reviewed_at
  if (authority.reviewer_id !== undefined && authority.reviewer_id !== null) next.reviewer_id = authority.reviewer_id
  if (authority.field_label !== undefined && authority.field_label !== '') next.field_label = authority.field_label
  if (authority.review_note !== undefined && authority.review_note !== '') next.review_note = authority.review_note
  else if (Object.prototype.hasOwnProperty.call(next, 'review_note')) delete next.review_note
  const existed = target !== null
  saveCorrectionRows(existed ? rows.map((row) => (row.id === correctionId ? next : row)) : [...rows, next])
  /* 采纳 ⇒ 公开投影的本机镜像一键 upsert（与服务端权威投影行同源）。 */
  if (status === CORRECTION_STATUS.ACCEPTED) mirrorAcceptedToPublic(next, projection)
  return { row: next, status, accepted: status === CORRECTION_STATUS.ACCEPTED, existed }
}

/**
 * **冻结 API ④**：审核一条勘误（采纳 / 驳回）。
 *
 * - 仅管理员；`decision` 取 `'ACCEPTED'`（采纳）或 `'REJECTED'`（驳回），
 *   旧字面值 `'APPROVED'` 由数据层归一为采纳（兼容既有调用）。
 * - 采纳 ⇒ 给**提交者**发放 10 金（`勘误奖励` 流水），**每条只奖一次**（重复审核被拒、
 *   重复采纳不二次发奖）；驳回 ⇒ 余额与流水均不变。
 * - 终态不回退：已审过的条目再调 ⇒ `{ok:false, reason:'ALREADY_REVIEWED'}`。
 * - 第 4 参 `note`（**可选，默认空串**）：**仅驳回且非空**时作为理由落盘（`review_note`，≤200 字）；
 *   单条驳回不传 ⇒ 行为逐字不变（**不写理由**）。
 *
 * **采纳写面（V3：登录令牌 ＋ 手机号白名单）＋ 同步本机镜像**——判定顺序：
 *   ① **登录令牌写面门**（`userWriteGate(REVIEW_OP, {correction_id, decision, note})`）：
 *      云端形态下这是**唯一授权判据**（服务端在 `xiai-user-token` 上验签 ＋
 *      「手机号 ∈ 管理员白名单」＋ op 值域 / 字段门，由服务端在云端落盘 / 写公开投影）；
 *      无令牌且有会话时**先静默补签**（刷新后令牌即丢的自愈）；**零弹窗、不需要第二个码**；
 *      拒絶 ⇒ **原样透传**（传输层失败 ⇒ `STORAGE_UNAVAILABLE`，**絕不偽裝 `FORBIDDEN`**）＋ **零写入**；
 *      dev / 離線形態 ⇒ 放行到本地判定（明確標注非正式寫入路徑）。
 *   ② **本機鏡像**：過門後仍走既有 `writeCorrectionDecision`（**三態語義 / 冪等 / 值域門 /
 *      零寫入紀律逐字不變**）—— dev / 離線形態下它就是本地權威；雲端形態下它是服務端權威的本機鏡像。
 *   ③ 已採納 ⇒ 同步**公開投影的本機鏡像**（`mirrorAcceptedToPublic`；標題 / 屬性表跨瀏覽器一致的來源）。
 *
 * ⇒ 本函式由**同步改為 `async`**（呼叫方須 `await`）；返回形狀與改前**逐字一致**。
 * @returns {Promise<{ok:boolean, status?:string, accepted?:boolean, reward?:object, row?:object,
 *   reason?:string, message:string}>}
 */
export async function review(actor, correctionId, decision, note = '', options = {}) {
  const who = actor || currentUser()
  if (!canReviewCorrections(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以審覈勘誤' }
  }
  /* ① **登录令牌写面门**（V3：唯一授权判据；dev / 離線形態返回放行標記）。
     经 `userWriteGate` ⇒ 无令牌且有会话时**先静默补签**（刷新后令牌即丢的自愈），再过云端门。
     载荷键面**逐字**取服务端封闭面（云函数 `xiai-user-token/lib/ops.js::REVIEW_ALLOWED_KEYS`
     ＝ `REVIEW_PAYLOAD_KEYS`）：`correction_id` / `decision` / `note`；
     键名不符（曾误用 `id`）会被服务端判 `INVALID_FIELD` ＋ 零写入。
     **additive 读数面（§3.77 影像勘誤）**：声明 `image_action`（云端只在 IMAGE 行回包里给，
     字段型行**不出现该键** ⇒ 既有回包逐字不变）。 */
  const gate = await userWriteGate(
    REVIEW_OP,
    {
      correction_id: String(correctionId === null || correctionId === undefined ? '' : correctionId),
      decision: String(decision === null || decision === undefined ? '' : decision),
      note: String(note === null || note === undefined ? '' : note)
    },
    { readoutKeys: REVIEW_READOUT_KEYS }
  )
  if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }
  /* **影像勘誤行（§3.77.4）**：云端权威行已执行完毕 ⇒ **本机零写入**
     （云模式不写本机库；IMAGE 行本来也不做本机镜像），不发奖、不同步公开投影 / 值级摘要，
     只把服务端回包的 `image_action` 读数原样交回调用方上屏。 */
  if (isImageCorrectionReviewTarget(correctionId, gate, options)) {
    return reviewImageCorrection(decision, gate)
  }
  /* ② 本機鏡像（dev / 離線 = 本地權威；雲端 = 服務端權威後的本機鏡像）。 */
  let decided
  try {
    decided = writeCorrectionDecision(who, correctionId, decision, note)
  } catch (err) {
    if (isPermissionError(err)) return { ok: false, reason: 'FORBIDDEN', message: err.message }
    decided = { ok: false, reason: 'ERROR', message: `審覈失敗：${(err && err.message) || '未知原因'}` }
  }
  /* ②-a **雲端權威優先**：雲端門已成功落盤（`gate.mode==='cloud'` 且帶回權威行），
     但本機 `writeCorrectionDecision` 未成功（`ALREADY_REVIEWED` / `NOT_FOUND` / 本地異常等）⇒
     **不得當失敗返回**：以服務端權威行（`gate.row` ＝ status/reviewed_at/reviewer_id…）
     更正本機鏡像行，並以 `ok:true` 如實呈現（「雲端已…；本機鏡像已按雲端權威更正」，**不謊稱本機首次採納**）。
     dev / 離線形態無服務端 ⇒ 不觸發本分支 ⇒ 既有本地行為逐字不變。 */
  if (!decided.ok) {
    if (gate.mode === 'cloud' && gate.row) {
      const reconciled = reconcileLocalMirrorFromAuthority(correctionId, gate.row, gate.projection)
      if (reconciled) {
        /* **摘要行同步（本单）**：服务端已重算 ⇒ 优先镜像；无服务端回包 ⇒ 本地重算。 */
        if (gate.summary && typeof gate.summary === 'object') mirrorCorrectionSummaryRow(gate.summary)
        else
          syncLocalCorrectionSummary(
            reconciled.row.faceId,
            sealIdOf(reconciled.row),
            reconciled.row.field,
            reconciled.row.value
          )
        let reward = { ok: true, awarded: false, message: '駁回不發獎' }
        if (reconciled.accepted) {
          const submitterId = reconciled.row.user_id || reconciled.row.userId || ''
          reward = awardCorrectionReward(submitterId, correctionId)
          if (reward.awarded) {
            try {
              markCorrectionRewarded(who, correctionId)
            } catch {
              /* 奖励已实际发放；标记失败不回滚（奖励幂等以流水为准，见 §7.4）。 */
            }
          }
        }
        const label = reconciled.row.field_label || (markableMeta(reconciled.row.field) || {}).label || '該屬性'
        const faceLabel = faceLabelOf(reconciled.row.faceId, sealIdOf(reconciled.row))
        const verb = reconciled.accepted ? '採納' : '駁回'
        return {
          ok: true,
          status: reconciled.status,
          accepted: reconciled.accepted,
          reward,
          row: reconciled.row,
          /* 明确标记「本次未在本机首次写入、而是按云端权威更正」⇒ 供取证区分。 */
          reconciled: true,
          message: `雲端已${verb}「${faceLabel}·${label}」勘誤；本機鏡像已按雲端權威更正。${
            reconciled.accepted ? reward.message : ''
          }`
        }
      }
    }
    return decided
  }
  /* ③ 已採納 ⇒ 同步公開投影的本機鏡像（冪等 upsert；雲端形態優先採用服務端回包的投影行）。 */
  if (decided.accepted) mirrorAcceptedToPublic(decided.row, gate.projection)
  /* **摘要行同步（本单）**：值级公开摘要行的 status 随采纳 / 驳回更新
     （云端正算 ⇒ 优先镜像；dev / 離線無服務端回包 ⇒ 本地重算）。 */
  if (gate.summary && typeof gate.summary === 'object') mirrorCorrectionSummaryRow(gate.summary)
  else syncLocalCorrectionSummary(decided.row.faceId, sealIdOf(decided.row), decided.row.field, decided.row.value)

  let reward = { ok: true, awarded: false, message: '駁回不發獎' }
  if (decided.accepted) {
    const submitterId = decided.row.user_id || decided.row.userId
    reward = awardCorrectionReward(submitterId, correctionId)
    if (reward.awarded) {
      try {
        markCorrectionRewarded(who, correctionId)
      } catch {
        /* 奖励已实际发放；标记失败不回滚（奖励幂等以流水为准，见 §7.4）。 */
      }
    }
  }
  const label = decided.row.field_label || (markableMeta(decided.row.field) || {}).label || '該屬性'
  const faceLabel = faceLabelOf(decided.row.faceId, sealIdOf(decided.row))
  return {
    ok: true,
    status: decided.status,
    accepted: decided.accepted,
    reward,
    row: decided.row,
    message: decided.accepted
      ? `已採納「${faceLabel}·${label}」勘誤。${reward.message}`
      : `已駁回「${faceLabel}·${label}」勘誤`
  }
}

/**
 * 兼容入口：既有调用方（管理员专区页）按「当前登录态」审核。
 * 行为与 `review` 一致，签名保持 `(id, decision)`（**勿改**，既有页面在用）——
 * **r2 起本函式亦为 `async`**（内部 `review` 已 async）。
 */
export async function reviewCorrection(id, decision) {
  const user = currentUser()
  if (!user || user.role !== 'admin') return { ok: false, message: '僅管理員可以審覈勘誤' }
  const rows = listCorrectionRows()
  const target = rows.find((row) => row.id === id)
  if (!target) return { ok: false, message: '未找到該勘誤' }
  if (normalizeCorrectionStatus(target.status) !== CORRECTION_STATUS.PENDING) {
    return { ok: false, message: '該勘誤已審覈，不可重複處理' }
  }
  return await review(user, id, decision)
}

/* ============================================================================
   **管理员撤销采纳（本单｜人类口径 2026-11-04）**
   ----------------------------------------------------------------------------
   为什么：采纳是**终态** —— 内容错误的勘误一旦被采纳（印文匹配到错印面），首页 / 详情页的
   展示值就跟着错，而既有面**没有任何撤回手段**。本段补**唯一**撤回路：服务端受控 op
   `revokeCorrectionAcceptance` 只把 `ACCEPTED` 目标行改判 `REJECTED`。

   硬口径（逐条）：
     · **先管理员判定、再走登录令牌写面门**（服务端 `adminWhitelistDenial` 才是唯一授权判据；
       非管理员 ⇒ `FORBIDDEN` ＋ **零发请求、零写入**）；
     · 载荷**封闭恰两键** `correction_id` / `note`（可选，≤ `MAX_REVIEW_NOTE_LENGTH` 字）；
     · **成功后用服务端权威行更新本机镜像**（`status` / `reviewed_at` / `reviewer_id` /
       `revoked` / `revoked_at` / `revoke_note`），**公开投影本机镜像同步为 `REJECTED`**，
       并**重算本机值级摘要**（服务端回 `summary` ⇒ 镜像权威值；dev / 離線 ⇒ 按本机行重算）；
     · **奖励不回滚**：已发的 `CORRECTION_REWARD` 金**不扣回**（本段**零触碰账本**；
       如需扣回另开单）—— 如实写进成功文案，不谎称「已退獎」；
     · **不改三态机 / 展示值裁决规则**：撤销后该行不再是 `ACCEPTED` ⇒ 自然不再计入
       （只认 `ACCEPTED`、取出现最多、同数取最近的裁决规则一字未改）；
     · 失败形状恒为 `{ok:false, reason, message}`（`reason` ⊆ 既有冻结字面值）。
   ============================================================================ */

/**
 * **以服务端权威行更正本机勘误镜像**（只覆盖决定面 / 撤销面；本机专有字段 `batchId` /
 * `rewarded_at` 等**原样保留**）。状态非 `REJECTED` ⇒ 不动本机行、回 `null`（**不写错状态**）。
 * @param {string} correctionId 勘误单号（本机行身份键 `row.id`）
 * @param {object} authorityRow 服务端回包的权威行（`gate.row`）或 dev 形态的本地派生行
 * @returns {object|null} 更正后的本机行
 */
function mirrorRevokedFromAuthority(correctionId, authorityRow) {
  const authority = authorityRow && typeof authorityRow === 'object' ? authorityRow : null
  if (!authority) return null
  const status = normalizeCorrectionStatus(authority.status)
  if (status !== CORRECTION_STATUS.REJECTED) return null
  const rows = listCorrectionRows()
  const target = rows.find((row) => row.id === correctionId) || null
  const next = { ...(target || { id: correctionId }) }
  next.status = status
  if (authority.reviewed_at !== undefined && authority.reviewed_at !== null) next.reviewed_at = authority.reviewed_at
  if (authority.reviewer_id !== undefined && authority.reviewer_id !== null) next.reviewer_id = authority.reviewer_id
  if (authority.revoked !== undefined && authority.revoked !== null) next.revoked = !!authority.revoked
  if (authority.revoked_at) next.revoked_at = authority.revoked_at
  if (authority.revoke_note) next.revoke_note = authority.revoke_note
  else if (Object.prototype.hasOwnProperty.call(next, 'revoke_note')) delete next.revoke_note
  const existed = target !== null
  saveCorrectionRows(existed ? rows.map((row) => (row.id === correctionId ? next : row)) : [...rows, next])
  return next
}

/**
 * **冻结 API ⑤**：管理员**撤销采纳**（`ACCEPTED → REJECTED`）。
 *
 * 判定顺序（全部在写之前）：① 客户端管理员判定（省一次往返；**服务端白名单门才是唯一授权判据**）
 * → ② 理由形态 / 长度（≤200 字）→ ③ **登录令牌写面门** `userWriteGate(REVOKE_OP, {correction_id, note})`
 * （服务端验签 ＋ 白名单 ＋ 封闭键面 ＋ 目标存在性 ＋ 状态门；拒绝 ⇒ **原样透传 ＋ 零写入**）
 * → ④ 服务端权威行回写本机镜像 ＋ 公开投影镜像 ＋ 本机摘要重算。
 *
 * **只改状态**：不动 `xiai_faces` / `xiai_seals` 原始行、不删行、不回滚奖励（`rewarded_at` 保留）。
 * @param {object|null} actor 操作者（须为管理员；缺省回落当前登录态）
 * @param {string} correctionId 勘误单号
 * @param {string} [note] 撤销理由（可选；≤ `MAX_REVIEW_NOTE_LENGTH` 字；空串 ⇒ 不落 `revoke_note`）
 * @returns {Promise<{ok:true, status:string, accepted:false, revoked:true, row:object,
 *   message:string}|{ok:false, reason:string, message:string}>}
 */
export async function revokeAcceptance(actor, correctionId, note = '') {
  const who = actor || currentUser()
  /* ① 客户端先判管理员（与 `review` 同口径 ⇒ 非管理员**零发请求、零写入**）。 */
  if (!canReviewCorrections(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以撤銷採納' }
  }
  const id = String(correctionId === null || correctionId === undefined ? '' : correctionId).trim()
  const rawNote = note === undefined || note === null ? '' : note
  if (typeof rawNote !== 'string') {
    return { ok: false, reason: 'INVALID_VALUE', message: '撤銷理由必須是文字；該勘誤狀態未變更。' }
  }
  const noteText = rawNote.trim()
  if (noteText.length > MAX_REVIEW_NOTE_LENGTH) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `撤銷理由不得超過 ${MAX_REVIEW_NOTE_LENGTH} 字；該勘誤狀態未變更。`
    }
  }
  /* ② 登录令牌写面门（必要时静默补签；dev / 離線形态放行到下面的本地判定）。 */
  const gate = await userWriteGate(REVOKE_OP, { correction_id: id, note: noteText })
  if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }
  /* **影像勘誤行（§3.77.4 撤销面）**：服务端只改状态与 `revoked` 审计标记 ⇒ 本机**零写入**
     （云模式不写本机库；IMAGE 行无本机镜像、不重建、不回滚影像面）。 */
  if (gate.row && typeof gate.row === 'object' && gate.row.kind === 'IMAGE') {
    const status = typeof gate.row.status === 'string' && gate.row.status ? normalizeCorrectionStatus(gate.row.status) : CORRECTION_STATUS.REJECTED
    return {
      ok: true,
      status,
      accepted: false,
      revoked: true,
      row: gate.row,
      message: `已撤銷採納該影像勘誤（狀態改判為駁回，印面與影像不再按該條執行）；已發放的 ${CORRECTION_REWARD} 金獎勵不扣回。`
    }
  }
  /* ③ 权威行：云端形态取服务端回包行；dev / 離線（或回包缺行）⇒ 本地按同一状态机判定后派生。 */
  let authority = gate.row && typeof gate.row === 'object' ? gate.row : null
  if (!authority) {
    const localRows = listCorrectionRows()
    const localTarget = localRows.find((row) => row.id === id) || null
    if (!localTarget) return { ok: false, reason: 'NOT_FOUND', message: '未找到該勘誤；本次零寫入。' }
    const localStatus = normalizeCorrectionStatus(localTarget.status)
    if (localStatus !== CORRECTION_STATUS.ACCEPTED) {
      return {
        ok: false,
        reason: 'INVALID_VALUE',
        message: `僅「已採納（ACCEPTED）」的勘誤可撤銷；該勘誤當前狀態：${localStatus}；本次零寫入。`
      }
    }
    const at = new Date().toISOString()
    authority = Object.assign({}, localTarget, {
      status: CORRECTION_STATUS.REJECTED,
      reviewed_at: at,
      reviewer_id: who.id,
      revoked: true,
      revoked_at: at
    })
    if (noteText !== '') authority.revoke_note = noteText
  }
  const mirrored = mirrorRevokedFromAuthority(id, authority)
  if (!mirrored) {
    return { ok: false, reason: 'INVALID_VALUE', message: '服務端回包的權威行不可辨識；該勘誤狀態未變更。' }
  }
  /* 公开投影的本机镜像同步为 `REJECTED`（与云端 `xiai_corrections_public` 投影行同状态）。 */
  mirrorAcceptedToPublic(mirrored, gate.projection, CORRECTION_STATUS.REJECTED)
  /* 本机值级摘要：服务端权威摘要优先镜像；无（dev / 離線）⇒ 按本机行**重算**。 */
  if (gate.summary && typeof gate.summary === 'object') mirrorCorrectionSummaryRow(gate.summary)
  else syncLocalCorrectionSummary(mirrored.faceId, sealIdOf(mirrored), mirrored.field, mirrored.value)

  const label = mirrored.field_label || (markableMeta(mirrored.field) || {}).label || '該屬性'
  const faceLabel = faceLabelOf(mirrored.faceId, sealIdOf(mirrored))
  return {
    ok: true,
    status: CORRECTION_STATUS.REJECTED,
    accepted: false,
    revoked: true,
    row: mirrored,
    /* **如实**：奖励不回滚（已发的 N 金不扣回）。 */
    message: `已撤銷採納「${faceLabel}·${label}」勘誤（狀態改判為駁回，展示值不再計入）；已發放的 ${CORRECTION_REWARD} 金獎勵不扣回。`
  }
}

/* ============================================================================
   按提交单（batch）批量审核（R-B1 〜 R-B8）
   ----------------------------------------------------------------------------
   分组口径**单点在此**（视图层不得另写第二套）：
     · 有 `batchId` 的行 ⇒ 同号一批（一次表单提交生成一次、N 条共享，见 `newBatchId`）；
     · 无 `batchId` 的旧行 ⇒ 按「提交人 ＋ 印面 ＋ `created_at` 60 秒窗」归批（`LEGACY_BATCH_WINDOW_MS`）。
   批量写 **逐条走既有 `review`**（＝ `writeCorrectionDecision` ＋ `awardCorrectionReward`）⇒
   逐条独立成败、幂等与发奖语义**逐字不变**；有一条成功即 `ok:true` 并如实回报失败条数。
   ============================================================================ */

/**
 * 提交人展示名（`暱稱（uid 短碼）`；查无账号 ⇒ 仍给 uid 短碼，完全认不出 ⇒「未知賬號」）。
 *
 * **人类口径 ④**：上屏**不得显示他人手机号** —— 一律改用**不透明 uid 的短碼**
 * （`src/data/uid.js::uidShortOf`，前 6 位十六进制）。自己看自己的手机号只允许从**本地会话**取
 * （`AppHeader` / `LoginView`），**不得从数据行取**。
 * @param {string} userId 提交人 uid（`u-<16 hex>`），或历史行的其它形态
 * @returns {string} 展示名
 */
export function submitterLabelOf(userId) {
  const id = String(userId === undefined || userId === null ? '' : userId)
  if (!id) return '未知賬號'
  const user = listUserRows().find((item) => item.id === id)
  const short = uidShortOf(id)
  if (user) return short ? `${user.nickname}（${short}）` : String(user.nickname || '未知賬號')
  return short ? `未知賬號（${short}）` : '未知賬號'
}

/** 印面归属键：优先 `faceId`；旧数据只有印章编号时回落 `sealId` / `stamp_id`。 */
function faceKeyOf(row) {
  return row.faceId || sealIdOf(row) || ''
}

function submitterIdOf(row) {
  return row.user_id || row.userId || ''
}

function createdAtMsOf(row) {
  const parsed = Date.parse(String(row.created_at || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

/** 批内稳定排序：先按 `MARKABLE_FIELDS` 声明序（字段），再按行 id（同字段多条时定序）。 */
function batchRowComparator(a, b) {
  const indexOf = (row) => {
    const index = MARKABLE_FIELDS.findIndex((meta) => meta.key === row.field)
    return index === -1 ? MARKABLE_FIELDS.length : index
  }
  return indexOf(a) - indexOf(b) || String(a.id).localeCompare(String(b.id))
}

/** 由一组行装配一个提交单（`createdAt` ＝ 批内最早提交时间）。 */
function makeBatch(key, batchId, group) {
  const rows = group.slice().sort(batchRowComparator)
  const first = rows[0]
  const createdAt = rows.reduce((acc, row) => {
    const at = String(row.created_at || '')
    if (!at) return acc
    return acc === '' || at < acc ? at : acc
  }, '')
  const sealId = sealIdOf(first)
  const faceId = first.faceId || ''
  const submitterId = submitterIdOf(first)
  return {
    key,
    batchId: batchId || '',
    submitterId,
    submitterLabel: submitterLabelOf(submitterId),
    sealId,
    faceId,
    faceLabel: faceLabelOf(faceId, sealId),
    createdAt,
    count: rows.length,
    rows
  }
}

/**
 * 把待审行归批（**服务层单点**；视图层不得另写第二套分组）。
 * @param {Array<object>} rows 待审勘误行
 * @returns {Array<object>} 批对象数组（按 `createdAt` 倒序；批内按字段稳定排序）
 */
function buildPendingBatches(rows) {
  const list = Array.isArray(rows) ? rows.slice() : []
  const batches = []
  const byBatchId = new Map()
  const legacyRows = []
  list.forEach((row) => {
    const id = row && row.batchId ? String(row.batchId) : ''
    if (id) {
      if (!byBatchId.has(id)) byBatchId.set(id, [])
      byBatchId.get(id).push(row)
    } else {
      legacyRows.push(row)
    }
  })
  byBatchId.forEach((group, batchId) => batches.push(makeBatch(`batch:${batchId}`, batchId, group)))

  /* 旧数据回落：按「提交人 ＋ 印面」分桶后，用 60 秒滑窗（相邻间隔 ≤ 窗口 ⇒ 同批）。 */
  const legacyBuckets = new Map()
  legacyRows.forEach((row) => {
    const bucketKey = `${submitterIdOf(row)}|${faceKeyOf(row)}`
    if (!legacyBuckets.has(bucketKey)) legacyBuckets.set(bucketKey, [])
    legacyBuckets.get(bucketKey).push(row)
  })
  legacyBuckets.forEach((group) => {
    group.sort((a, b) => createdAtMsOf(a) - createdAtMsOf(b) || String(a.id).localeCompare(String(b.id)))
    let current = []
    let previousMs = null
    const flush = () => {
      if (!current.length) return
      const first = current[0]
      const key = `legacy:${submitterIdOf(first)}|${faceKeyOf(first)}|${first.id}`
      batches.push(makeBatch(key, '', current))
      current = []
    }
    group.forEach((row) => {
      const ms = createdAtMsOf(row)
      if (previousMs !== null && ms - previousMs > LEGACY_BATCH_WINDOW_MS) flush()
      current.push(row)
      previousMs = ms
    })
    flush()
  })

  batches.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return batches
}

/**
 * **批量审核读入口（R-B4）**：管理员可见的**待审提交单**（按批分组）。
 *
 * 非管理员 ⇒ 与 `listPendingForAdmin` **同字面值**的结构化拒绝（`FORBIDDEN`、零读取面）；
 * 管理员 ⇒ `{ok:true, batches}`（批按时间倒序、批内按字段稳定排序）。
 * 落位：**复用** `listPendingForAdmin`（读面与逐条审核完全同源，不另开读路径）。
 *
 * **本单（W-54）随 `listPendingForAdmin` 改为 `async`**；第 2 参 `pending`（**可选**）用于
 * 「调用方已取过一次待审读数」时**复用同一次云读**（省一次云往返）——**不传则行为与传前逐字一致**
 * （内部自行 `await listPendingForAdmin`）。`pending` 形状须是该函数的结构化回包。
 * @param {object|null} actor 操作者（须为管理员；缺省回落到当前登录态）
 * @param {{ok:boolean, rows?:Array<object>, reason?:string, message?:string}} [pending]
 *   已取到的待审读数（可选；`undefined` ⇒ 自取）
 * @returns {Promise<{ok:true, batches:Array<object>}|{ok:false, reason:string, message:string}>}
 */
export async function listPendingBatchesForAdmin(actor, pending) {
  const who = actor || currentUser()
  if (!canReviewCorrections(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以查看全部用戶的待審勘誤' }
  }
  const source = pending !== undefined && pending !== null ? pending : await listPendingForAdmin(who)
  if (!source.ok) return source
  return { ok: true, batches: buildPendingBatches(source.rows || []) }
}

/**
 * 驳回理由归一（**写之前**判定）：非文字 / 去空白后超 200 字 ⇒ `INVALID_VALUE`。
 * @returns {{ok:true, note:string}|{ok:false, reason:'INVALID_VALUE', message:string}}
 */
function normalizeReviewNote(note) {
  const raw = note === undefined || note === null ? '' : note
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'INVALID_VALUE', message: '駁回理由必須是文字；本次零寫入。' }
  }
  const text = raw.trim()
  if (text.length > MAX_REVIEW_NOTE_LENGTH) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `駁回理由不得超過 ${MAX_REVIEW_NOTE_LENGTH} 字；本次零寫入。`
    }
  }
  return { ok: true, note: text }
}

/**
 * **批量审核写入口（R-B5）**：对一批 `ids` 逐条审核（采纳 / 驳回）。
 *
 * - 仅管理员；非管理员 ⇒ `FORBIDDEN` ＋ **零写入**。
 * - `ids` 非法 / 空 ⇒ 结构化拒绝（`INVALID_VALUE`）＋ 零写入。
 * - `note`（**可选**）非文字 / 超 200 字 ⇒ `INVALID_VALUE` ＋ 零写入（判定在**任何逐条写入之前**）。
 * - **逐条独立成败**：每条走既有 `review`（`writeCorrectionDecision` ＋ `awardCorrectionReward`），
 *   幂等 / 发奖语义**逐字不变**；有一条成功即 `ok:true` 并如实回报失败条数；全失败 ⇒ `ok:false`。
 * - **r2 起 `review` 为 `async`（采纳写面走云端门）⇒ 本函式亦为 `async`**：逐条**串行** `await`
 *   （不并发发门 —— 令牌滑动续期 / 逐条独立成败都要求串行、确定序）。
 * @param {object|null} actor 操作者（须为管理员）
 * @param {Array<string>} ids 勘误行 id 列表
 * @param {'ACCEPTED'|'REJECTED'} decision 审核决定
 * @param {string} [note=''] 驳回理由（≤200 字；仅驳回时落盘）
 * @returns {Promise<{ok:boolean, decided:{accepted:number, rejected:number}, failed:Array<{id:string,reason:string,message:string}>, message:string}>}
 */
export async function reviewBatch(actor, ids, decision, note = '') {
  const who = actor || currentUser()
  if (!canReviewCorrections(who)) {
    return {
      ok: false,
      reason: 'FORBIDDEN',
      decided: { accepted: 0, rejected: 0 },
      failed: [],
      message: '僅管理員可以審覈勘誤'
    }
  }
  const noteCheck = normalizeReviewNote(note)
  if (!noteCheck.ok) {
    return { ok: false, reason: noteCheck.reason, decided: { accepted: 0, rejected: 0 }, failed: [], message: noteCheck.message }
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      decided: { accepted: 0, rejected: 0 },
      failed: [],
      message: '缺少要審覈的勘誤標識；本次零寫入。'
    }
  }
  const list = ids
    .map((id) => String(id === null || id === undefined ? '' : id).trim())
    .filter((id) => id !== '')
  if (list.length === 0) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      decided: { accepted: 0, rejected: 0 },
      failed: [],
      message: '缺少要審覈的勘誤標識；本次零寫入。'
    }
  }
  const decided = { accepted: 0, rejected: 0 }
  const failed = []
  /* 逐条**串行** await（确定序；不并发发门）。 */
  for (const id of list) {
    const result = await review(who, id, decision, noteCheck.note)
    if (result && result.ok) {
      if (result.accepted) decided.accepted += 1
      else decided.rejected += 1
    } else {
      failed.push({
        id,
        reason: (result && result.reason) || 'ERROR',
        message: (result && result.message) || '審覈失敗'
      })
    }
  }
  const successCount = decided.accepted + decided.rejected
  const ok = successCount > 0
  const verb = decision === CORRECTION_STATUS.ACCEPTED ? '採納' : '駁回'
  const message = ok
    ? `已批量${verb} ${successCount} 條勘誤（採納 ${decided.accepted} 條，駁回 ${decided.rejected} 條）` +
      (failed.length ? `；${failed.length} 條未處理。` : '。')
    : `批量審覈未處理任何勘誤（失敗 ${failed.length} 條）。`
  return { ok, decided, failed, message }
}

/* ============================================================================
   普通用戶影像勘誤（§3.77｜本單）：提交入口 ＋ 替換新圖入册 ＋ 審核回包讀數
   ---------------------------------------------------------------------------- 本段**只改前端**：云端 op（`submitImageCorrection`；`reviewCorrection` 对 IMAGE 行的
   additive `image_action` 回包）由云函数侧注册，本文件按**冻结契约**先接：
     · 载荷封闭恰六键 `seal_id` ＋ `face_id` ＋ `image_id` ＋ `action`（恰二值
       `'delete'`｜`'replace'`）＋ `note`（≤ 200 字、缺省空串）＋ `new_image`（仅 replace：
       `sha256`／`bytes`／`mime`／`storage_key`）；**零未知键、零身份类键**；
     · **云模式零本机落盘**（IMAGE 行不做本机镜像；读面走既有 `listMyCorrections` /
       `listPendingCorrectionsForAdmin` 的「云行 ∪ 本机镜像」）；`local-dev` **如实拒绝**
       （本形态没有云端写面 ⇒ 不假装提交成功）；
     · 失败恒**恰 3 键** `{ok:false, reason, message}`（`reason` ⊆ 既有冻结 13 值）；
     · 替換必先入册：`storeArtifactBytes` → `registerFaceImage` → 才 `submitImageCorrection`；
       **任一步失败即硬报错、不编造 `image_id`、零提交、可重试**。
   ============================================================================ */

/** 影像勘誤提交的**云端门 op 名**（须与云函数侧注册面逐字一致）。 */
export const IMAGE_CORRECTION_OP = 'submitImageCorrection'

/** 提交回包的**additive 读数声明**（`skipped` ＝ 重复未驳回行按既有「重複跳過」语义不建行）。 */
export const IMAGE_CORRECTION_READOUT_KEYS = Object.freeze(['skipped'])

/** `action` 封闭二值（规范冻结）。 */
export const IMAGE_CORRECTION_ACTIONS = Object.freeze(['delete', 'replace'])

/** 提交载荷的**封闭六键面**（与冻结契约逐字一致）。 */
export const IMAGE_CORRECTION_PAYLOAD_KEYS = Object.freeze([
  'seal_id',
  'face_id',
  'image_id',
  'action',
  'note',
  'new_image'
])

/** `new_image` 封闭四键面（与冻结契约逐字一致）。 */
export const IMAGE_NEW_IMAGE_KEYS = Object.freeze(['sha256', 'bytes', 'mime', 'storage_key'])

/** 备注上限（与视图 `maxlength` / 提示文案**同值**）。 */
export const MAX_IMAGE_CORRECTION_NOTE_LENGTH = 200

/** `registerFaceImage` 的回包读数声明（与 `seals.js` 同键面；本文件零第二套口径）。 */
const IMAGE_REGISTER_READOUT_KEYS = Object.freeze(['image_id'])
/** 登录面影像入册 op（**非管理员门**）：影像勘误「替换」提交前用它把新图登记成内容寻址行。 */
const IMAGE_CORRECTION_REGISTER_OP = 'registerCorrectionImage'

/** 结构化拒绝（失败恒恰 3 键）。 */
function imageCorrectionDenial(reason, message) {
  return { ok: false, reason, message }
}

/**
 * 提交前的**本地封闭键面门**（判定在**任何请求 / 写入之前** ⇒ 拒绝即零写入）。
 * 服务端仍是唯一判据；本门只把「载荷形态必然被拒」的形挡在发包之前。
 * @returns {null|{ok:false, reason:string, message:string}} `null` ＝ 放行
 */
function imageCorrectionPayloadDenial(who, payload) {
  if (!who) {
    return imageCorrectionDenial('FORBIDDEN', '請先登錄後再提交影像勘誤；本次零寫入。')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return imageCorrectionDenial('INVALID_FIELD', '影像勘誤載荷必須是物件；本次零寫入。')
  }
  /* 未知键 / 身份类键（`phone` / `actor` / `uid` / `role` …）⇒ 同一条 `INVALID_FIELD`。 */
  const unknown = Object.keys(payload).find((key) => IMAGE_CORRECTION_PAYLOAD_KEYS.indexOf(key) === -1)
  if (unknown) {
    return imageCorrectionDenial('INVALID_FIELD', `影像勘誤載荷含未知鍵（${unknown}）；本次零寫入。`)
  }
  for (const key of ['seal_id', 'face_id', 'image_id']) {
    const value = payload[key]
    if (value === undefined || value === null || value === '') {
      return imageCorrectionDenial('MISSING_REQUIRED', `缺少必要欄位（${key}）；本次零寫入。`)
    }
    if (typeof value !== 'string') {
      return imageCorrectionDenial('INVALID_VALUE', `欄位（${key}）必須是字符串；本次零寫入。`)
    }
  }
  const action = payload.action
  if (typeof action !== 'string' || IMAGE_CORRECTION_ACTIONS.indexOf(action) === -1) {
    return imageCorrectionDenial('INVALID_VALUE', "勘誤動作（action）只能是 'delete' 或 'replace'；本次零寫入。")
  }
  const noteRaw = payload.note === undefined || payload.note === null ? '' : payload.note
  if (typeof noteRaw !== 'string') {
    return imageCorrectionDenial('INVALID_VALUE', '備註（note）必須是字符串；本次零寫入。')
  }
  if (noteRaw.length > MAX_IMAGE_CORRECTION_NOTE_LENGTH) {
    return imageCorrectionDenial(
      'INVALID_VALUE',
      `備註不得超過 ${MAX_IMAGE_CORRECTION_NOTE_LENGTH} 字（當前 ${noteRaw.length} 字）；本次零寫入。`
    )
  }
  if (action === 'delete') {
    if (Object.prototype.hasOwnProperty.call(payload, 'new_image')) {
      return imageCorrectionDenial('INVALID_FIELD', '「刪除」動作不得附 new_image；本次零寫入。')
    }
    return null
  }
  const newImage = payload.new_image
  if (newImage === undefined || newImage === null || typeof newImage !== 'object' || Array.isArray(newImage)) {
    return imageCorrectionDenial('MISSING_REQUIRED', '「替換」動作必須附 new_image（sha256 / bytes / mime / storage_key）；本次零寫入。')
  }
  const unknownNew = Object.keys(newImage).find((key) => IMAGE_NEW_IMAGE_KEYS.indexOf(key) === -1)
  if (unknownNew) {
    return imageCorrectionDenial('INVALID_FIELD', `new_image 含未知鍵（${unknownNew}）；本次零寫入。`)
  }
  for (const key of IMAGE_NEW_IMAGE_KEYS) {
    const value = newImage[key]
    if (value === undefined || value === null || value === '') {
      return imageCorrectionDenial('MISSING_REQUIRED', `缺少必要欄位（new_image.${key}）；本次零寫入。`)
    }
  }
  if (typeof newImage.sha256 !== 'string' || typeof newImage.mime !== 'string' || typeof newImage.storage_key !== 'string') {
    return imageCorrectionDenial('INVALID_VALUE', 'new_image 的 sha256 / mime / storage_key 必須是字符串；本次零寫入。')
  }
  if (!/^[0-9a-f]{64}$/.test(newImage.sha256.toLowerCase())) {
    return imageCorrectionDenial('INVALID_VALUE', 'new_image.sha256 必須是 64 位十六進制摘要；本次零寫入。')
  }
  if (!Number.isInteger(newImage.bytes) || newImage.bytes <= 0) {
    return imageCorrectionDenial('INVALID_VALUE', 'new_image.bytes 必須是正整數；本次零寫入。')
  }
  return null
}

/** 按封闭键面**逐字重建**提交载荷（键序即契约序；`note` 缺省空串；delete 不带 `new_image`）。 */
function buildImageCorrectionPayload(payload) {
  const body = {
    seal_id: String(payload.seal_id),
    face_id: String(payload.face_id),
    image_id: String(payload.image_id),
    action: String(payload.action),
    note: payload.note === undefined || payload.note === null ? '' : String(payload.note)
  }
  if (body.action === 'replace') {
    body.new_image = {
      sha256: String(payload.new_image.sha256),
      bytes: Number(payload.new_image.bytes),
      mime: String(payload.new_image.mime),
      storage_key: String(payload.new_image.storage_key)
    }
  }
  return body
}

/**
 * **提交影像勘誤**（冻结契约 `submitImageCorrection`）。
 *
 * @param {object|null} actor 操作者（缺省回落当前登录态；**身份不由载荷给**）
 * @param {{seal_id:string, face_id:string, image_id:string, action:'delete'|'replace',
 *   note?:string, new_image?:{sha256:string, bytes:number, mime:string, storage_key:string}}} payload
 * @returns {Promise<{ok:true, row:object|null, skipped?:boolean}
 *   |{ok:false, reason:string, message:string}>}
 *   **云模式零本机落盘**；`local-dev` 如实拒绝；失败恒恰 3 键。
 */
export async function submitImageCorrection(actor, payload = {}) {
  const who = actor || currentUser()
  diagGateMode = ''
  const denial = imageCorrectionPayloadDenial(who, payload)
  if (denial) {
    diagNote(`submitImageCorrection 拒絕{reason:${denial.reason}}`)
    return denial
  }
  const body = buildImageCorrectionPayload(payload)
  diagNote(
    `submitImageCorrection 入參{seal_id:${body.seal_id}, face_id:${body.face_id}, image_id:${body.image_id}, ` +
      `action:${body.action}, note:${diagValueOf(body.note)}, new_image:${body.new_image ? 'given' : '無'}}`
  )
  const gate = await userWriteGate(IMAGE_CORRECTION_OP, body, { readoutKeys: IMAGE_CORRECTION_READOUT_KEYS })
  diagMarkGate(gate)
  if (gate && gate.mode === 'local-dev') {
    diagNote('submitImageCorrection 回包{ok:false, reason:STORAGE_UNAVAILABLE, mode:local-dev}')
    return imageCorrectionDenial(
      'STORAGE_UNAVAILABLE',
      '本機為 dev / 離線形態（沒有雲端寫面）⇒ 影像勘誤只能在雲端形態提交；本次零寫入。'
    )
  }
  if (!gate || gate.ok !== true) {
    const reason = (gate && gate.reason) || 'STORAGE_UNAVAILABLE'
    const message = (gate && gate.message) || '影像勘誤提交服務暫時不可用，請稍後再試。'
    diagNote(`submitImageCorrection 回包{ok:false, reason:${reason}}`)
    return imageCorrectionDenial(reason, message)
  }
  const skipped = typeof gate.skipped === 'boolean' ? gate.skipped : undefined
  const row = gate.row && typeof gate.row === 'object' ? gate.row : null
  if (!row) {
    /* 「重複跳過」⇒ 不建新行 ⇒ 服务端可不回行（不计失败、不上屏为失败）；其余一律如实拒绝。 */
    if (skipped === true) {
      diagNote('submitImageCorrection 回包{ok:true, skipped:true, row:無（按「重複跳過」不建行）}')
      return { ok: true, row: null, skipped: true }
    }
    diagNote('submitImageCorrection 回包{ok:false, reason:STORAGE_UNAVAILABLE, row:缺}')
    return imageCorrectionDenial(
      'STORAGE_UNAVAILABLE',
      '雲端回傳缺少權威行，無法確認影像勘誤的寫入內容；本次零鏡像（雲端是否已寫入未知）。'
    )
  }
  const out = { ok: true, row }
  if (skipped !== undefined) out.skipped = skipped
  diagNote(`submitImageCorrection 回包{ok:true, row:${row.id || '—'}, skipped:${skipped === undefined ? '—' : skipped}}`)
  return out
}

/**
 * **替换用新图：先入册、再提交**（两步硬序的前一步）。
 *
 * 【容器口径（本單修）】全站存儲容器恒为**单页 8bit Deflate TIFF**（`STORAGE_MIME`）。
 * 线上恒失败的真因＝旧实现把**原始文件字节**（JPG / PNG / WebP）直接交 `storeArtifactBytes`
 * ⇒ 入册面按容器口径恒拒（`INVALID_VALUE`）。故本函数先经**既有单点**把输入转成容器：
 *   ① 输入门 `loadImageFile` → `inputDenialOf`（**与实物照片同一道输入门与文案**；拒绝即返，
 *      **零上传、零入册、零提交**）；
 *   ② 产物编码 `runUploadPipeline({ kind: 'photo', … })`（**与实物照片同一入口**，不新写编码器）
 *      → 失败 / 产物不是 `STORAGE_MIME` ⇒ 结构化拒「新圖處理失敗：…」（零上传）；
 *   ③ **兼容直通**：旧签名给的 `bytes` 且 `mime === 'image/tiff'` ＝已是容器字节 ⇒ 不重解、不重编。
 * 再走**现有** `storeArtifactBytes` 拿 `sha256` / `bytes` / `storage_key`（内容寻址、幂等），
 * 最后走**现有** `registerCorrectionImage`（**登录面**，非管理员面 `registerFaceImage`）入册拿 `image_id`。
 * 任一步失败 ⇒ **硬报错、不编造 `image_id`、零提交、可重试**（调用方据此不发 `submitImageCorrection`）。
 *
 * @param {{sealId?:string, faceId?:string, kind?:string, file?:File|Blob|null,
 *   bytes?:Uint8Array|ArrayBuffer|null, mime?:string}} input
 *   `file` ＝ 新口径（`File` / `Blob`）；`bytes` ＋ `mime` ＝ 旧签名兼容。
 * @returns {Promise<{ok:true, imageId:string, new_image:{sha256:string, bytes:number, mime:string, storage_key:string}}
 *   |{ok:false, reason:string, message:string}>}
 */
export async function prepareImageCorrectionReplacement({ sealId = '', faceId = '', kind = FACE_KIND.FACE, file = null, bytes = null, mime = '' } = {}) {
  const sealIdText = String(sealId === null || sealId === undefined ? '' : sealId).trim()
  const faceIdText = String(faceId === null || faceId === undefined ? '' : faceId).trim()
  if (!sealIdText || !faceIdText) {
    return imageCorrectionDenial('MISSING_REQUIRED', '入册新圖需要印面與所屬印章編號；本次零提交。')
  }
  const sourceFile = file && typeof file === 'object' ? file : null
  const body = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null
  const claimedMime = String(mime === null || mime === undefined ? '' : mime).trim().toLowerCase()
  /* ① 容器直通（旧签名兼容）：已是存储容器字节 ⇒ 原字节入库，不重解、不重编。 */
  const containerPassthrough = !sourceFile && !!body && body.length > 0 && claimedMime === STORAGE_MIME
  let artifactBytes = null
  let artifactMime = ''
  if (containerPassthrough) {
    artifactBytes = body
    artifactMime = STORAGE_MIME
  } else {
    /* 非容器字节（含旧签名给的 JPG / PNG / WebP / 文本）⇒ 包成 `Blob` 走**同一道**输入门，
       判据与文案一律取自 `loadImageFile`（本文件不另写第二套输入判据）。 */
    let source = sourceFile
    if (!source && body && body.length > 0) {
      source = typeof Blob === 'function' ? new Blob([body], { type: claimedMime }) : null
    }
    if (!source) {
      if (!body || body.length === 0) {
        return imageCorrectionDenial('EMPTY_CONTENT', '新圖內容為空，請重新選擇圖片文件；本次零提交。')
      }
      return imageCorrectionDenial('NOT_IMAGE', `所選文件不是圖片（${claimedMime || '類型未知'}）；本次零提交，請改選 JPG / PNG / WebP 圖片。`)
    }
    const loaded = await loadImageFile(source)
    /* 输入侧拒绝（超限 / 非图片 / 解码失败）⇒ 原样透传 reason 与文案；**零上传、零入册、零提交**。 */
    const denied = inputDenialOf(loaded)
    if (denied) {
      return imageCorrectionDenial(denied.reason || 'NOT_IMAGE', denied.message || '圖片不可用，請重新選擇文件')
    }
    /* 产物编码：**与实物照片同一入口**（`kind: 'photo'` ⇒ 单页 8bit Deflate TIFF）；
       不新写编码器、不另建第二套管线。 */
    const exported = await runUploadPipeline({
      kind: 'photo',
      bitmap: loaded.bitmap,
      options: { maxSide: IMAGE_LIMITS.maxSide, quality: IMAGE_LIMITS.quality }
    })
    if (!exported || exported.ok !== true) {
      return imageCorrectionDenial(
        'ENCODE_FAILED',
        `新圖處理失敗：${(exported && exported.message) || '本機未能編出存儲件'}（本次零上傳、零入册、零提交）`
      )
    }
    artifactBytes = exported.bytes
    artifactMime = String(exported.mime || '').trim().toLowerCase()
    /* 产物容器自检：必须等于 `STORAGE_MIME`（单页 8bit Deflate TIFF）；不符**如实拒**，绝不冒充。 */
    if (!artifactBytes || artifactBytes.length === 0 || artifactMime !== STORAGE_MIME) {
      return imageCorrectionDenial(
        'ENCODE_FAILED',
        `新圖處理失敗：產物不是存儲容器 ${STORAGE_MIME}（按字節魔數判定為 ${artifactMime || '認不出'}），已拒絕入册` +
          '（本次零上傳、零入册、零提交）。'
      )
    }
  }
  /* ① 现有上传通道（内容寻址、幂等；失败原样透传）。 */
  const stored = await storeArtifactBytes(artifactBytes)
  if (!stored || stored.ok !== true) {
    return imageCorrectionDenial(
      (stored && stored.reason) || 'STORAGE_UNAVAILABLE',
      (stored && stored.message) || '新圖上傳失敗；本次零提交，請稍後重試。'
    )
  }
  const sha256 = String(stored.sha256 || '').toLowerCase()
  const storageKey = String(stored.storageKey || stored.storage_key || '')
  const storedBytes = Number(stored.bytesLength)
  if (!sha256 || !storageKey || !Number.isInteger(storedBytes) || storedBytes <= 0) {
    return imageCorrectionDenial(
      'STORAGE_UNAVAILABLE',
      '新圖上傳回包缺少內容尋址讀數（sha256 / bytes / storage_key）；本次零入册、零提交，請重試。'
    )
  }
  if (storageKey !== artifactObjectKeyOf(sha256)) {
    return imageCorrectionDenial(
      'STORAGE_UNAVAILABLE',
      '新圖未產生雲端內容尋址對象鍵；本次零入册、零提交，請重試。'
    )
  }
  /* 存储回包的**容器自检**：入册声明的 mime 必须恒等于 `STORAGE_MIME`（单页 8bit Deflate TIFF）；
     回包按字节魔数报了别的容器 ⇒ **如实拒**，绝不把非容器冒充成容器（零入册、零提交）。 */
  const storedMime = String(stored.mime || '').trim().toLowerCase()
  if (storedMime && storedMime !== STORAGE_MIME) {
    return imageCorrectionDenial(
      'ENCODE_FAILED',
      `新圖處理失敗：入庫對象不是存儲容器 ${STORAGE_MIME}（按字節魔數判定為 ${storedMime}），已拒絕入册` +
        '（本次零入册、零提交）。'
    )
  }
  const imageMime = STORAGE_MIME
  /* ② 入册通道（拿 `image_id`；失败原样透传 ⇒ 调用方不发提交）。
     **用 `registerCorrectionImage`（登录面）而非 `registerFaceImage`（管理员面）** ——
     影面勘误是普通用户能力，管理员门会恒拒（FORBIDDEN）把替换功能锁死。 */
  const gate = await userWriteGate(
    IMAGE_CORRECTION_REGISTER_OP,
    {
      seal_id: sealIdText,
      sha256,
      bytes: storedBytes,
      mime: imageMime,
      storage_key: storageKey
    },
    { readoutKeys: IMAGE_REGISTER_READOUT_KEYS }
  )
  if (gate && gate.mode === 'local-dev') {
    return imageCorrectionDenial(
      'STORAGE_UNAVAILABLE',
      '本機為 dev / 離線形態（沒有雲端入册面）⇒ 替換用新圖無法入册；本次零提交。'
    )
  }
  if (!gate || gate.ok !== true) {
    return imageCorrectionDenial(
      (gate && gate.reason) || 'STORAGE_UNAVAILABLE',
      (gate && gate.message) || '新圖入册失敗；本次零提交，請稍後重試。'
    )
  }
  const fromReadout = typeof gate.image_id === 'string' ? gate.image_id.trim() : ''
  const fromDocId = typeof gate.docId === 'string' ? gate.docId.trim() : ''
  const imageId = fromReadout || fromDocId
  if (!imageId.startsWith('img-')) {
    return imageCorrectionDenial(
      'STORAGE_UNAVAILABLE',
      '雲端入冊回包形狀不可辨識（未附影像編號 image_id）；未編造編號，本次零提交，請重試。'
    )
  }
  return {
    ok: true,
    imageId,
    new_image: { sha256, bytes: storedBytes, mime: imageMime, storage_key: storageKey }
  }
}

/* ---------------------------------------------------------------------------- 审核面（IMAGE 行）：**云端权威、本机零写入** ＋ `image_action` 读数上抛
   -------------------------------------------------------------------------- */

/**
 * 是否为**影像勘誤行**（三处判据取或：调用方显式声明 / 云端权威行 / 本机镜像行）。
 * 只用于**决定走哪条审核路径**，不改变任何门禁与白名单。
 */
function isImageCorrectionReviewTarget(correctionId, gate, options) {
  if (options && options.image === true) return true
  const authority = gate && gate.row && typeof gate.row === 'object' ? gate.row : null
  if (authority && authority.kind === 'IMAGE') return true
  const id = String(correctionId === null || correctionId === undefined ? '' : correctionId)
  if (!id) return false
  const local = listCorrectionRows().find((row) => row && String(row.id) === id)
  return !!(local && local.kind === 'IMAGE')
}

/** IMAGE 行的审核执行回包（**零本机写**：不镜像、不发奖、不同步公开投影 / 值级摘要）。 */
function reviewImageCorrection(decision, gate) {
  if (gate && gate.mode === 'local-dev') {
    return imageCorrectionDenial(
      'STORAGE_UNAVAILABLE',
      '本機為 dev / 離線形態（沒有雲端審核面）⇒ 影像勘誤只能在雲端形態審覈；本次零寫入。'
    )
  }
  const authority = gate && gate.row && typeof gate.row === 'object' ? gate.row : null
  if (!authority) {
    return imageCorrectionDenial(
      'STORAGE_UNAVAILABLE',
      '雲端回傳缺少權威行，無法確認影像勘誤的審核結果；本次零寫入。'
    )
  }
  const fromRow = typeof authority.status === 'string' && authority.status ? normalizeCorrectionStatus(authority.status) : ''
  const status =
    fromRow === CORRECTION_STATUS.ACCEPTED || fromRow === CORRECTION_STATUS.REJECTED
      ? fromRow
      : normalizeCorrectionStatus(decision)
  const settled = status === CORRECTION_STATUS.ACCEPTED || status === CORRECTION_STATUS.REJECTED
  const accepted = status === CORRECTION_STATUS.ACCEPTED
  const action = String(authority.action || '') === 'replace' ? 'replace' : 'delete'
  const label = action === 'replace' ? '替換' : '刪除'
  const out = {
    ok: true,
    status,
    accepted,
    /* 奖励面**不在本版冻结范围**（§3.77.4）⇒ 如实不发奖，不谎称已发。 */
    reward: { ok: true, awarded: false, message: '影像勘誤行的獎勵口徑尚未凍結，本次不發獎。' },
    row: authority,
    message: !settled
      ? '雲端回包狀態仍為待審覈（PENDING）；影像面未執行，本次零寫入，請稍後重試。'
      : accepted
        ? `已採納影像勘誤（${label}影像）；影像面由服務端執行。`
        : `已駁回影像勘誤（${label}影像）；只改狀態，影像面零寫入。`
  }
  const imageAction = gate && gate.image_action && typeof gate.image_action === 'object' ? gate.image_action : null
  if (imageAction) out.image_action = imageAction
  diagNote(`review(IMAGE) 回包{ok:true, status:${status}, action:${action}, image_action:${imageAction ? 'given' : '無'}}`)
  return out
}

/* ---------------------------------------------------------------------------- 上屏读数单点（视图层不得另写第二套文案）
   -------------------------------------------------------------------------- */

/** 是否为**影像勘誤行**（`kind: 'IMAGE'`；字段型行一律 `false` ⇒ 既有展示一字不变）。 */
export function isImageCorrectionRow(row) {
  return !!row && typeof row === 'object' && row.kind === 'IMAGE'
}

/** 动作标签：「影像勘誤 · 刪除」／「影像勘誤 · 替換」（上屏文案，**非钩子取值**）。 */
export function imageCorrectionLabelOf(row) {
  if (!isImageCorrectionRow(row)) return ''
  const action = String((row && row.action) || '')
  if (action === 'replace') return '影像勘誤 · 替換'
  if (action === 'delete') return '影像勘誤 · 刪除'
  return '影像勘誤'
}

/** 目标影像读数：「目標影像 img-…」（replace 另列「新影像 img-…」）。 */
export function imageCorrectionTargetOf(row) {
  if (!isImageCorrectionRow(row)) return ''
  const imageId = String((row && row.image_id) || '').trim()
  const base = `目標影像 ${imageId || '（缺）'}`
  if (String((row && row.action) || '') !== 'replace') return base
  const newImageId = String((row && row.new_image_id) || '').trim()
  return newImageId ? `${base} · 新影像 ${newImageId}` : base
}

/** 备注（无 ⇒ 空串，由调用方决定是否渲染）。 */
export function imageCorrectionNoteOf(row) {
  if (!isImageCorrectionRow(row)) return ''
  const note = row && row.note
  return typeof note === 'string' ? note : ''
}

/**
 * 采纳后 `image_action` 读数的**上屏文案**（繁體；无该键 ⇒ 空串，**不编造读数**）。
 * @param {null|object} imageAction `{action, removed:{rows,objects}, shared_kept}`
 * @returns {string}
 */
export function imageCorrectionReadoutOf(imageAction) {
  if (!imageAction || typeof imageAction !== 'object') return ''
  if (imageAction.shared_kept === true) return '舊影像仍被其他印面引用，未刪'
  const removed = imageAction.removed
  if (!removed || typeof removed !== 'object') return ''
  const rows = Number(removed.rows)
  const objects = Number(removed.objects)
  if (!Number.isFinite(rows) && !Number.isFinite(objects)) return ''
  const rowCount = Number.isFinite(rows) ? rows : 0
  const objectCount = Number.isFinite(objects) ? objects : 0
  return `已刪除舊影像行 ${rowCount}、對象 ${objectCount}`
}
