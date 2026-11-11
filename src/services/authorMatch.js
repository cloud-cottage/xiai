/**
 * 玺爱 · **作者校验候选匹配服务**（`suggestAuthors` 公開只讀 action 的**唯一消费点**）
 * ============================================================================
 * 【为什么有这一层】印章详情页的作者区只显示名字（或「佚名」），校对者无从下手。本层把
 *   **后端已冻结的匹配契约**包成一个前端可直接消费的函数：给印面（`face_id`）或给姓名
 *   （`name`），回一批候选（人 / 朝代 / 命中字段 / 分数），由视图渲染成「校驗作者」弹窗。
 *   **本层只读、零写入** —— 选中后的提交一律走**既有勘误通道**（`corrections.submitCorrection`），
 *   本文件不碰任何库写口。
 *
 * 【凍結契約（本文件只消费，不自造字段）】
 *   调用面（与 `listSealCards` 同一公开只读通道）：
 *     `callCloudFunction('xiai-user-token', { action:'public', op:'suggestAuthors', payload })`
 *   载荷：`{ face_id?, name?, limit? }`（`limit` 1〜10、缺省 5；`face_id` / `name` 至少给一个）
 *   回包：`{ ok, query, normalized, candidates:[…] }`，候选元素**恰 7 键**：
 *     `person_id, display_name, dynasty, matched_field, matched_value, score, is_current`
 *   `matched_field ∈ {'name','alias','courtesy','art','contains'}`（**封闭五值**，越界不猜义）。
 *
 * 【失败即如实（不得伪造候选）】未配置云端 / 传输层失败 / 服务端结构化拒绝 / 回包形状不可辨识
 *   ⇒ 一律回 `{ok:false, reason, message}`（`reason` 取工程既有冻结字面值：`STORAGE_UNAVAILABLE`
 *   / `MISSING_REQUIRED` / `BAD_REPLY` / 服务端原话），**绝不**用空数组冒充「沒有合適人選」。
 *
 * 【分层纪律】本文件属 services 層：只消费 `data/*`；视图只经 `services/index.js` 门面进来。
 *   上屏文案（含命中字段中文名）在此单点给出，视图不另写第二套字段名表。
 */

import { callCloudFunction } from '../data/cloudbaseFn.js'
import { cloudBaseConfigured } from '../data/cloudbase.js'

/* ---------------------------------------------------------------------------
 * 1. 契约常量（唯一真源；改值只改这里）
 * ------------------------------------------------------------------------- */

/** 承载公开只读 action 的云函数名（与 `sealCards.js::SEAL_CARDS_FUNCTION_NAME` 同值）。 */
export const AUTHOR_MATCH_FUNCTION_NAME = 'xiai-user-token'

/** 公开只读通道的 `action` 字面值（云函数 `index.js::handlePublic` 的分流判据）。 */
export const AUTHOR_MATCH_ACTION = 'public'

/** 公开只读 op 名（须与云函数 `PUBLIC_OPS` 注册面逐字一致）。 */
export const AUTHOR_MATCH_OP = 'suggestAuthors'

/** 契约 `limit` 缺省值。 */
export const AUTHOR_MATCH_LIMIT_DEFAULT = 5

/** 契约 `limit` 值域（1〜10；越界在本层夹取 ⇒ 不把越域请求发出去）。 */
export const AUTHOR_MATCH_LIMIT_MIN = 1
export const AUTHOR_MATCH_LIMIT_MAX = 10

/** `matched_field` 封闭五值（契约逐字；越界值**不猜义**、原样保留并按原文上屏）。 */
export const MATCHED_FIELDS = Object.freeze(['name', 'alias', 'courtesy', 'art', 'contains'])

/**
 * 命中字段的**上屏中文名**（单点；视图不得另写第二套）。
 * 未登记的取值 ⇒ `matchedFieldLabel` 原样回落（不编造含义）。
 */
export const MATCHED_FIELD_LABELS = Object.freeze({
  name: '姓名',
  alias: '別名',
  courtesy: '字',
  art: '號',
  contains: '包含匹配'
})

/** 候选元素的**恰 7 键**（顺序即契约顺序；取证可逐字比对）。 */
export const AUTHOR_CANDIDATE_KEYS = Object.freeze([
  'person_id',
  'display_name',
  'dynasty',
  'matched_field',
  'matched_value',
  'score',
  'is_current'
])

/** 上屏用：命中字段中文名（未登记 ⇒ 原文）。 */
export function matchedFieldLabel(field) {
  const key = textOf(field).trim()
  return Object.prototype.hasOwnProperty.call(MATCHED_FIELD_LABELS, key) ? MATCHED_FIELD_LABELS[key] : key
}

function textOf(value) {
  return value === undefined || value === null ? '' : String(value)
}

function denial(reason, message) {
  return { ok: false, reason: textOf(reason) || 'STORAGE_UNAVAILABLE', message: textOf(message) }
}

/* ---------------------------------------------------------------------------
 * 2. 请求组装与回包收窄（纯函数；可离线自检）
 * ------------------------------------------------------------------------- */

/**
 * 由视图入参组出请求 payload（`face_id` / `name` **只在非空时给**；`limit` 恒给且夹在 1〜10）。
 * 两键皆空 ⇒ 仍返回该 payload（由调用方按 `MISSING_REQUIRED` 拒绝 ⇒ **不发空查询**）。
 * @param {{faceId?:string, name?:string, limit?:number}} input
 * @returns {{limit:number, face_id?:string, name?:string}}
 */
export function suggestAuthorRequestOf(input = {}) {
  const source = input || {}
  const raw = Number(source.limit)
  const limit = Number.isFinite(raw) && raw > 0
    ? Math.min(AUTHOR_MATCH_LIMIT_MAX, Math.max(AUTHOR_MATCH_LIMIT_MIN, Math.floor(raw)))
    : AUTHOR_MATCH_LIMIT_DEFAULT
  const payload = { limit }
  const faceId = textOf(source.faceId).trim()
  const name = textOf(source.name).trim()
  if (faceId) payload.face_id = faceId
  if (name) payload.name = name
  return payload
}

/**
 * 把一个候选**收窄成恰 7 键**（型别归一；不新增、不改名、不补编造值）。
 * @returns {object|null} 收不下（非物件 / 无 `person_id`）⇒ `null`
 *   （无 `person_id` 的候选**不可提交**（勘误 `author` 值＝引用）⇒ 不上屏，避免点了才报错）
 */
export function normalizeAuthorCandidate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const personId = textOf(raw.person_id).trim()
  if (!personId) return null
  const scoreRaw = raw.score
  const scoreNum = scoreRaw === '' || scoreRaw === null || scoreRaw === undefined ? NaN : Number(scoreRaw)
  return {
    person_id: personId,
    display_name: textOf(raw.display_name).trim(),
    dynasty: textOf(raw.dynasty).trim(),
    matched_field: textOf(raw.matched_field).trim(),
    matched_value: textOf(raw.matched_value),
    /* 分数：**只认有限数字**，取不到 ⇒ `null`（视图显示「—」；不把 0 当「没有分数」编造）。 */
    score: Number.isFinite(scoreNum) ? scoreNum : null,
    is_current: raw.is_current === true || raw.is_current === 1 || raw.is_current === 'true'
  }
}

/**
 * 回包取值（**同时认服务端信封的三种合理落点**：顶层数 / `value` / `data` —— 与
 * `sealCards.js::sealCardsReadoutsOf` 同一处置：云函数成功回包是固定白名单，新 op 的读数键
 * 若没被白名单放行就会被静默丢到 `value` 位）。
 * @returns {object|null} 带 `candidates` 数组的那一层；认不出 ⇒ `null`
 */
export function authorSuggestReadoutsOf(result) {
  const candidates = [result, result && result.value, result && result.data]
  for (const layer of candidates) {
    if (layer && typeof layer === 'object' && Array.isArray(layer.candidates)) return layer
  }
  return null
}

/* ---------------------------------------------------------------------------
 * 3. 读入口（视图唯一消费点）
 * ------------------------------------------------------------------------- */

/**
 * 查询作者候选。
 *
 * 读序（逐支互斥、失败恒结构化）：
 *   ① **查询条件两键皆空** ⇒ `MISSING_REQUIRED` ＋ 零请求；
 *   ② **未配置云端**（`cloudBaseConfigured() === false`）⇒ `STORAGE_UNAVAILABLE` ＋ 零请求
 *      （**不做本地候选兜底** —— 本机没有印人匹配索引，凑数即伪造）；
 *   ③ 已配置 ⇒ 调公开只读 op `suggestAuthors`：
 *        · 回包可辨识 ⇒ 收窄成恰 7 键的候选（保序、原样透传分数 / 命中值）；
 *        · 服务端结构化拒绝 ⇒ **原样透传** `reason` / `message`；
 *        · 传输层失败 / 形状不可辨识 ⇒ `{ok:false, reason, message}`（**不以空数组冒充无候选**）。
 *
 * @param {{faceId?:string, name?:string, limit?:number}} input
 * @returns {Promise<{ok:true, query:{face_id:string,name:string}, normalized:string,
 *           candidates:Array<object>}
 *          |{ok:false, reason:string, message:string}>}
 */
export async function suggestAuthorCandidates(input = {}) {
  const payload = suggestAuthorRequestOf(input)
  if (!payload.face_id && !payload.name) {
    return denial('MISSING_REQUIRED', '缺少查詢條件（印面編號或作者姓名）；本次零讀取。')
  }
  if (!cloudBaseConfigured()) {
    return denial('STORAGE_UNAVAILABLE', '未配置雲端讀取面，作者候選暫不可用；本次零讀取。')
  }
  const reply = await callCloudFunction(AUTHOR_MATCH_FUNCTION_NAME, {
    action: AUTHOR_MATCH_ACTION,
    op: AUTHOR_MATCH_OP,
    payload
  })
  if (!reply || reply.ok !== true) {
    return denial(
      (reply && reply.reason) || 'STORAGE_UNAVAILABLE',
      (reply && reply.message) || '作者候選查詢失敗（雲端暫不可用）；本次零讀取。'
    )
  }
  const result = reply.result || {}
  if (result.ok === false) {
    return denial(
      textOf(result.reason) || 'STORAGE_UNAVAILABLE',
      textOf(result.message) || '作者候選查詢被雲端拒絕；本次零讀取。'
    )
  }
  const readouts = authorSuggestReadoutsOf(result)
  if (!readouts) {
    return denial('BAD_REPLY', '雲端回傳形狀不可辨識（未帶候選列表）；本次未列出任何候選。')
  }
  const candidates = (Array.isArray(readouts.candidates) ? readouts.candidates : [])
    .map(normalizeAuthorCandidate)
    .filter(Boolean)
  return {
    ok: true,
    query: { face_id: textOf(payload.face_id), name: textOf(payload.name) },
    /* 服务端归一后的查询词（契约键；缺省 ⇒ 空串，**不代填**）。 */
    normalized: textOf(readouts.normalized),
    candidates
  }
}
