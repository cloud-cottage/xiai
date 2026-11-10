'use strict'
/**
 * 玺爱 · **管理员「人工智能修復 · 异步两段式」（`ai-enhance-submit` / `ai-enhance-status` /
 * `ai-enhance-list`）唯一实现点**
 * ============================================================================
 * 背景（派单方实测真因）：旧的同步长调用（一次 HTTP 往返跑完「预扣 → 上游入队 → 轮询 90 秒
 * → 下载 / 转码 / 入库」，实测 24〜53 秒）会被 CloudBase 网关约 60 秒掐断回包，而云函数
 * （超时 900 秒）仍在继续跑并写成功 ⇒ 用户看到「本次未寫入」，实际已扣金、候选图已入库。
 * 本单把长任务拆成**两次快调用**：`ai-enhance-submit`（提交：预扣 + 上游入队，墙钟预算 25 秒）
 * 与 `ai-enhance-status`（单轮推进：查上游 + 取图 + 入册，整轮预算 45 秒 —— 三段一律用整轮剩余预算封顶），彻底绕开网关上限；
 * `ai-enhance-list` 为该印面下**未采纳**候选任务的只读清单。
 *
 * 职责（本单范围）：三 op 的载荷封闭键面 / 管理员门复核 / 幂等预查 / 图源取字节 / 上游配置 /
 * 预扣与退款 / 上游入队与单轮查询 / 取图与入册 / 任务行状态机与清单投影 —— 只在此落地；
 * `lib/ops.js` 只做**注册与薄委派**（不写第二套逻辑）。
 *
 * 冻结契约（逐条）：
 *  ① **新集合 `xiai_ai_enhance_tasks`（服务端专属）**：登记方式与 `lib/ledger.js` 的
 *     `xiai_balances` 同族 —— 集合名字面只活在本文件（`AI_ENHANCE_TASKS_COLLECTION`），
 *     **不进** `lib/ops.js::COLLECTIONS` 登记表、**更不进**前端 `CLOUD_COLLECTIONS` ⇒ 客户端零读面；
 *     读写一律经 `lib/ops.js` 的既有读点（`readRows`）与唯一写点（`persist`）。
 *     行字段（冻结）：`_id`（＝对外 `task_id` ＝ `aiet-` ＋ `sha256(uid 竖线 request_id)` 十六进制
 *     **前 16 位**）、`uid`、`request_id`、`source_image_id`、`seal_id`、`face_id`、`status`
 *     （**只允许** `SUBMITTED` / `RUNNING` / `READY` / `FAILED` 四个字面值）、`upstream_task_id`、
 *     `upstream_status`（数字）、`product_image_id`、`charge_amount`、`charge_state`
 *     （**恰两字面值** `PENDING`（已落行、尚未扣费）/ `CHARGED`（已扣费）；**读旧行缺该键 ⇒
 *     按 `CHARGED` 处理、历史行一行不改**）、`charge_balance_after`、
 *     `error_reason`、`error_message`、`refunded`（布尔）、`created_at`、`updated_at`、
 *     `deadline_at`；另按派单方明文点名补记 `elapsed_ms`（入册耗时）。
 *  ② **管理员门**：三 op 的**第一行**都是既有的 `ops.adminWhitelistDenial`（零读零写地拒；
 *     缺 env / 非白名单 ⇒ 结构化拒绝，**不因未配置而放行**）。
 *  ③ **`ai-enhance-submit`**：载荷封闭**恰四键** `image_id` / `seal_id` / `face_id` / `request_id`
 *     （多一键 / 少一键都拒；`request_id` 必须 8〜64 位字母数字或下划线横线，否则 `INVALID_VALUE`）
 *     → 幂等预查（同 uid 同 `request_id` 已有行 ⇒ **直接回放该行，零扣费零上游**；行是
 *     `charge_state:'PENDING'` 的中断残留 ⇒ **续做本跳**，不回放半成品）
 *     → 读源影像行与对象字节（与 `lib/aiEnhance.js` ④ 步**同一套拒绝面**，零扣费）
 *     → 解析上游配置（缺则零扣费）→ **先落任务行 `SUBMITTED`（`charge_state:'PENDING'` ＋
 *     `charge_amount:0`）→ 预扣 10 金 → 回写 `charge_amount:10 / charge_state:'CHARGED' /
 *     charge_balance_after`**（`idem_key` 形态沿用 `ai-enhance-<image_id>-<request_id>`）
 *     → 调上游 `POST /images/edits` 取异步任务号（**整段墙钟预算 25 秒**：读源字节 / 解配置 /
 *     落行 / 扣费 / 上游 POST 每步都在段内，超时即**先退款、再把行转 `FAILED(UPSTREAM_ERROR,
 *     「提交超過 25 秒…」)`**、**绝不等网关约 60 秒**；收尾写库另给 ≤10 秒宽限 ⇒ 总时长 ≤ 35 秒）
 *     → 行回写 `upstream_task_id`、`deadline_at` ＝ `created_at` ＋ 20 分钟。成功回包**恰五键**
 *     `ok / task_id / status / source_image_id / charge{amount,balance}`；失败回包**恰四键**
 *     `ok / reason / message / refunded`。上游是同步回图的老形态 ⇒ **submit 内直接完成入库并置
 *     `READY`**，回包形状不变（仍恰五键、**不带 `image_id`** —— `image_id` 只由 status op 给出）。
 *     **任何失败路径 ⇒ 行转 `FAILED` ＋ 退款**（沿用 `refundTen`，`refunded` 照实报；**本次未真扣费
 *     的路径零退款** —— 绝不凭空 +10 金）。
 *  ④ **`ai-enhance-status`**：载荷封闭**恰一键** `task_id` → 读任务行（不存在 ⇒ `INVALID_VALUE`，
 *     文案写明「該修復任務不存在」）→ 已是 `READY` / `FAILED` 终态 ⇒ **直接回放，零上游零扣费**
 *     → 否则**单轮推进**：查上游（单查预算 20 秒）；`pending` / `processing` ⇒ 行置 `RUNNING`
 *     并回 `RUNNING`；`completed` ⇒ 同轮内下载（预算 25 秒）＋ 判容器 ＋ 内容寻址上传 ＋
 *     影像行入册（整段预算 45 秒；`seq` 走既有单点 `nextImageSeqOf`，**绝不自算号**）⇒ 行置
 *     `READY`、记 `product_image_id` 与 `elapsed`；`failed` / `violation`、或已过 `deadline_at`、
 *     或整轮超过预算 ⇒ **退款（只退一次，行上 `refunded` 布尔为护栏）并置 `FAILED`**。
 *     回包三种形态封闭：`RUNNING` **恰四键** `ok / task_id / status / upstream_status`；
 *     `READY` **恰六键** `ok / task_id / status / image_id / preview{mime,sha256} /
 *     charge{amount,balance}`；`FAILED` **恰五键** `ok(false) / reason / message / refunded / status`。
 *  ⑤ **`ai-enhance-list`**（只读）：载荷封闭**恰一键** `face_id`；回**该印面下所有未采纳的候选
 *     任务**（`READY` 且 `product_image_id` 已被任一印面行 `face_image_id` / `edge_image_ids`
 *     引用者视为**已采纳**、不回）。成功**恰两键** `ok / rows`，每行**恰六键** `task_id / status /
 *     image_id / source_image_id / created_at / error_message`（无值一律空串）；失败**恰三键**。
 *     按 `created_at` 倒序、最多 20 行。
 *  ⑥ **`reason` 零新增**：只用既有冻结值 `UPSTREAM_ERROR` / `INVALID_VALUE` / `FORBIDDEN` /
 *     `MISSING_REQUIRED` / `INVALID_FIELD` / `INSUFFICIENT_POINTS` / `CONFIG_MISSING` /
 *     `STORAGE_UNAVAILABLE`；回包里**绝不出现 `plan` 等内部字段**。
 *  ⑦ **文案繁體**：一切上屏与 `console` 文案均为繁体（自检：简体转繁体后与原文相等）。
 *  ⑧ **写库纪律**：写行一律走 `ops.persist`（载荷不带 `_id`，`persist` 已剥）；读该集合命中
 *     「集合不存在」⇒ 按 `lib/config.js::isCollectionNotExistError` 的既有口径**降级为空集**；
 *     **写面失败绝不吞成成功**（一律结构化失败上报）。
 *  ⑨ **既有 `ai-enhance-face` / `ai-enhance-discard` 逐字不变**（本文件零改动那两个实现点、
 *     两文件互不 require 彼此的主流程）。
 *
 * 复用面（**不写第二套账本 / 第二套读写点**）：预扣与退款走 `lib/ledger.js` 的
 * `chargePoints` / `refundPoints`（＝ `lib/aiEnhance.js::chargeTen` / `refundTen` 的同一账本单点、
 * 同一 `idem_key` 形态）；行读走 `ops.readRows`、行写走 `ops.persist`、对象字节走
 * `ops.readArtifactBytes` / `ops.uploadDisplayArtifactBytes`、`seq` 单点走
 * `ops.nextImageSeqOf` / `ops.imageSeqsOf`、门走 `ops.adminWhitelistDenial`、上游配置走
 * `lib/aiUpstream.resolveUpstreamSecret`；魔数判容器 / 产物族 / 源键候选 / 幂等键 / 新影像行编号
 * 等纯函数一律取 `lib/aiEnhance.js` **已导出**的单点（`sniffImageMime` / `PRODUCT_MIME_EXT` /
 * `SOURCE_KEY_EXTS` / `SOURCE_KEY_PATTERN` / `SOURCE_MAX_BYTES` / `idemKeyOf` /
 * `imageIdOfIdemKey` / `AI_ENHANCE_SIZE` / `AI_ENHANCE_RESOLUTION` / `AI_ENHANCE_COST` /
 * `REF_TYPE_AI_IMAGE`）。上游 `POST /images/edits` 与 `GET /tasks/<id>` 的**单跳**取用
 * `lib/aiEnhance.js` ⑥ / ⑦ 的同一协议与同一常量（该文件不在本单写集 ⇒ 其内部封装未导出，
 * 此处按同一口径实现，**常量与纯函数全部复用其导出面**，不另立数值）。
 *
 * 存储 / 读点纪律：本文件**零集合句柄字面**（集合句柄调用 0 次；读写一律经 `lib/ops.js` 的
 * 既有导出）；上游明文 key 不打印、不日志、不进回包。
 * ============================================================================
 */

const crypto = require('crypto')
const { REASONS, deny, isCollectionNotExistError } = require('./config.js')
const { AI_ENHANCE_PROMPT } = require('./aiEnhancePrompt.js')
/* 纯函数与常量单点（已导出面）：产物族 / 源键形态 / 幂等键 / 新影像行编号 / 尺寸与分辨率 / 金额。 */
const aiEnhance = require('./aiEnhance.js')

/* --------------------------------------------------------------------------- *
  常量面（封闭；客户端一律不可改）
 * --------------------------------------------------------------------------- */

/** 三个 op 名（与 `lib/ops.js::ADMIN_OPS` 注册面逐字一致）。 */
const AI_ENHANCE_SUBMIT_OP = 'ai-enhance-submit'
const AI_ENHANCE_STATUS_OP = 'ai-enhance-status'
const AI_ENHANCE_LIST_OP = 'ai-enhance-list'

/** **新集合（服务端专属）**：登记方式同 `lib/ledger.js::LEDGER_COLLECTIONS`。 */
const AI_ENHANCE_TASKS_COLLECTION = 'xiai_ai_enhance_tasks'

/** 对外任务号前缀（＝ `_id` 前缀；`aiet-` ＋ 十六进制前 16 位）。 */
const TASK_ID_PREFIX = 'aiet-'

/** 任务状态（**只允许这四个字面值**）。 */
const TASK_STATUS = Object.freeze({
  SUBMITTED: 'SUBMITTED',
  RUNNING: 'RUNNING',
  READY: 'READY',
  FAILED: 'FAILED'
})

/** 单张修復成本（金）—— 唯一写值处沿规范 §3.67.2（引用 `lib/aiEnhance.js` 的导出常量）。 */
const AI_ENHANCE_COST = aiEnhance.AI_ENHANCE_COST

/** 任务期限：提交成功起 **20 分钟**（`deadline_at` ＝ 创建时刻 ＋ 本值）。 */
const TASK_DEADLINE_MS = 20 * 60 * 1000

/** `request_id` 形态：**8〜64 位**字母 / 数字 / 下划线 / 横线。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

/** 载荷封闭键面（各恰 N 键；未知键 ⇒ `INVALID_FIELD`、缺 / 空 ⇒ `MISSING_REQUIRED`）。 */
const SUBMIT_ALLOWED_KEYS = Object.freeze(['image_id', 'seal_id', 'face_id', 'request_id'])
const STATUS_ALLOWED_KEYS = Object.freeze(['task_id'])
const LIST_ALLOWED_KEYS = Object.freeze(['face_id'])

/** 回包键面（封闭）。 */
const SUBMIT_SUCCESS_KEYS = Object.freeze(['ok', 'task_id', 'status', 'source_image_id', 'charge'])
const SUBMIT_FAILURE_KEYS = Object.freeze(['ok', 'reason', 'message', 'refunded'])
const STATUS_RUNNING_KEYS = Object.freeze(['ok', 'task_id', 'status', 'upstream_status'])
const STATUS_READY_KEYS = Object.freeze(['ok', 'task_id', 'status', 'image_id', 'preview', 'charge'])
const STATUS_FAILED_KEYS = Object.freeze(['ok', 'reason', 'message', 'refunded', 'status'])
const LIST_SUCCESS_KEYS = Object.freeze(['ok', 'rows'])
const LIST_FAILURE_KEYS = Object.freeze(['ok', 'reason', 'message'])
const LIST_ROW_KEYS = Object.freeze(['task_id', 'status', 'image_id', 'source_image_id', 'created_at', 'error_message'])

/** 退款流水的幂等键后缀（与原 `CHARGE` 的 `idem_key` 区分；原行不删）。 */
const REFUND_IDEM_SUFFIX = '-refund'

/** 提交跳墙钟预算：**25 秒**（超时即退款并置 `FAILED`）。 */
const SUBMIT_POST_BUDGET_MS = 25000
/** 提交段**收尾写库**（退款 ＋ 行转 `FAILED`）宽限：**≤10 秒** —— 绝对截止 ＝ 段截止 ＋ 本值
 *  ⇒ 整段总时长 ≤ 35 秒（仍显著低于网关约 60 秒掐断线）。 */
const SUBMIT_CLEANUP_GRACE_MS = 10000
/** 任务行 `charge_state`（**恰两字面值**）：`PENDING` ＝ 已落行尚未扣费 / `CHARGED` ＝ 已扣费。
 *  **读旧行缺该键 ⇒ 按 `CHARGED` 处理**（历史行一行不改、照旧走退款护栏）。 */
const CHARGE_STATE = Object.freeze({ PENDING: 'PENDING', CHARGED: 'CHARGED' })

/** 单轮推进预算（status op）：单查 20 秒 / 下载 25 秒 / 入册段 45 秒 / **整轮 45 秒**
 *  （整轮 45 秒 ＝ 规范 §3.80.6 / `AC-698`「單次完成（下載 ＋ 轉碼 ＋ 入庫）整體控制在 45 秒以內」；
 *   显著低于 CloudBase 网关约 60 秒掐断线 —— 该上限并不精确（实测 53 秒可回、106 秒必被掐），
 *   故留足余量；**三段一律用整轮剩余预算封顶**（`min(段预算, 剩余预算)`），任何一段都不在
 *   整轮截止之后才发网络请求；整轮超预算 ⇒ 退款并置 `FAILED`）。 */
const STATUS_QUERY_BUDGET_MS = 20000
const STATUS_DOWNLOAD_BUDGET_MS = 25000
const STATUS_INGEST_BUDGET_MS = 45000
const STATUS_ROUND_BUDGET_MS = 45000
/** 开新一段（下载 / 入册）前的整轮剩余预算下限：不足 ⇒ **不退款、不改终态**，
 *  回 `RUNNING` 让下一轮续做（绝不因预算过小直接判死）。 */
const STATUS_MIN_STEP_BUDGET_MS = 5000

/** 整轮剩余预算（毫秒；**≤ 0 ＝ 整轮预算已尽**）。**每段开工前重查** —— 前段吃掉多少，后段就少多少。 */
function remainingRoundBudgetMs(roundStartedAt) {
  return STATUS_ROUND_BUDGET_MS - (Date.now() - roundStartedAt)
}

/** `ai-enhance-list`：返回上限 20 行；单次读取护栏 200 行（读回后服务端排序 / 截断）。 */
const LIST_MAX_ROWS = 20
const LIST_SCAN_LIMIT = 200

/** 引用扫描护栏（采纳判定用；口径同 `lib/aiEnhanceDiscard.js`）。 */
const FACE_REFERENCE_LIMIT = 64
const FACE_EDGE_SCAN_LIMIT = 1000

/** 摘要形态（64 位小写十六进制）。 */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** 上游认证方案词（HTTP `Authorization` 头的谓词；与 `lib/aiEnhance.js` ⑥ / ⑦ 逐字一致）。 */
const AUTH_SCHEME = 'Bearer'

/** 认证头名（**取值单点在 `authorizationValueOf`** —— 头名只在此登记一处）。 */
const AUTH_HEADER_NAME = 'Authorization'

/** 认证头取值（谓词 ＋ 空格 ＋ 解密后的 key；**明文 key 永不进回包、不打印**）。 */
function authorizationValueOf(upstream) {
  return [AUTH_SCHEME, text(upstream.key)].join(' ')
}

/** 认证头（`Content-Type` 可选 ＋ `Authorization` 恒在；取值单点见 `authorizationValueOf`）。 */
function authHeadersOf(upstream, contentType) {
  const headers = {}
  if (contentType) headers['Content-Type'] = contentType
  headers[AUTH_HEADER_NAME] = authorizationValueOf(upstream)
  return headers
}

/* --------------------------------------------------------------------------- *
  注入缝（离线自检 / 宿主用；生产不注入 ⇒ 走全局 `fetch`）
 * --------------------------------------------------------------------------- */

let fetchProvider = null

/**
 * 注入上游 HTTP 实现（`async (url, init) => Response`）；传非函数 ⇒ 清除注入。
 * **仅供离线自检 / 宿主**（回环测试把 `https` 改写成 `http` 再转发；生产走真实 `fetch`）。
 * @param {null|function(string, object):Promise<object>} fn
 */
function setTaskFetchProvider(fn) {
  fetchProvider = typeof fn === 'function' ? fn : null
}

/** 注入缝是否已注入（诊断读数用，**不含任何凭据**）。 */
function taskFetchInjected() {
  return fetchProvider !== null
}

/** 取上游 HTTP 实现（注入缝 → 全局 `fetch`；两者皆无 ⇒ 抛错 ⇒ 调用方转 `UPSTREAM_ERROR`）。 */
function resolveFetch() {
  if (fetchProvider) return fetchProvider
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis)
  throw new Error('AI_ENHANCE_TASK_FETCH_UNAVAILABLE')
}

/* --------------------------------------------------------------------------- *
  小工具（纯函数；零 I/O）
 * --------------------------------------------------------------------------- */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function nowIso() {
  return new Date().toISOString()
}

/** `data:` URL（上游输入图形态；**回包零 `data:` 前缀** —— 只在服务端内存流转）。 */
function dataUrlOf(mime, bytes) {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/**
 * **对外任务号（＝文档 `_id`）**：`aiet-` ＋ `sha256(uid 竖线 request_id)` 十六进制前 16 位。
 * 确性 ⇒ 同 uid 同 `request_id` 恒落同一行（幂等预查据此一次命中）。
 * @param {string} uid 服务端派生身份
 * @param {string} requestId 客户端请求号（已过 8〜64 位形态门）
 * @returns {string}
 */
function taskIdOf(uid, requestId) {
  return `${TASK_ID_PREFIX}${sha256Hex(Buffer.from(`${text(uid)}|${text(requestId)}`, 'utf8')).slice(0, 16)}`
}

/** 提交成功回包（**恰 5 键**；`charge` 是嵌套对象 —— 顶层键面即此 5 个）。 */
function submitSuccess(taskId, status, sourceImageId, balance) {
  return {
    ok: true,
    task_id: text(taskId),
    status: text(status),
    source_image_id: text(sourceImageId),
    charge: { amount: AI_ENHANCE_COST, balance: Number(balance) || 0 }
  }
}

/** 提交失败回包（**恰 4 键**；`refunded` 恒布尔）。 */
function submitFailure(reason, message, refunded) {
  return { ok: false, reason, message, refunded: refunded === true }
}

/** 状态失败回包（**恰 5 键**；`status` 恒在 —— 无行 / 被拒一律以终态 `FAILED` 收口，让客户端停止轮询）。 */
function statusFailure(reason, message, refunded, status) {
  return {
    ok: false,
    reason,
    message,
    refunded: refunded === true,
    status: text(status) === '' ? TASK_STATUS.FAILED : text(status)
  }
}

/** 清单失败回包（**恰 3 键**，零 `refunded`）。 */
function listFailure(reason, message) {
  return { ok: false, reason, message }
}

/** 诊断指纹（与 `index.js::errorFingerprint` 同形的最小版；**纯函数、绝不自抛、零密钥**）。 */
function diagnoseOf(error) {
  try {
    const source = error !== null && typeof error === 'object' ? error : {}
    const name = typeof source.name === 'string' && source.name !== '' ? source.name : 'unknown'
    const rawCode = source.code !== undefined && source.code !== null ? source.code : source.errCode
    const code = rawCode !== undefined && rawCode !== null && rawCode !== '' ? String(rawCode) : ''
    const rawMessage = typeof source.message === 'string' ? source.message : ''
    const message = rawMessage.replace(/[A-Za-z0-9+/=]{40,}/g, '<redacted>').slice(0, 60)
    return `${name} / code=${code} / ${message === '' ? 'unknown' : message}`
  } catch {
    return 'unknown'
  }
}

/* --------------------------------------------------------------------------- *
  读点 / 写点（一律经 `lib/ops.js` 的既有导出；本文件零集合句柄字面）
 * --------------------------------------------------------------------------- */

function opsModule() {
  /* 延迟 require：与 `lib/aiEnhance.js` 同法（打破加载环；离线自检不需要 SDK）。 */
  return require('./ops.js')
}

/**
 * 读任务行（按 `_id`；无行 ⇒ `null`）。
 * **读面降级口径**：命中「集合不存在」（`lib/config.js::isCollectionNotExistError` 的既有判据）
 * ⇒ 视作**空集**（首写前控制台未建集合时读面恒空）；**其余错误原样上抛**（绝不把真存储故障
 * 伪装成「无行」）。
 */
async function readTaskRow(taskId) {
  const ops = opsModule()
  try {
    const rows = await ops.readRows(AI_ENHANCE_TASKS_COLLECTION, { _id: text(taskId) }, { limit: 1 })
    return rows.length > 0 && rows[0] && typeof rows[0] === 'object' ? rows[0] : null
  } catch (error) {
    if (isCollectionNotExistError(error)) return null
    throw error
  }
}

/** 读某印面下的任务行（倒序、带单次护栏；「集合不存在」同降级为空集）。 */
async function readTaskRowsByFace(faceId) {
  const ops = opsModule()
  try {
    const rows = await ops.readRows(
      AI_ENHANCE_TASKS_COLLECTION,
      { face_id: text(faceId) },
      { limit: LIST_SCAN_LIMIT, orderByDesc: 'created_at' }
    )
    return Array.isArray(rows) ? rows : []
  } catch (error) {
    if (isCollectionNotExistError(error)) return []
    throw error
  }
}

/** 任务行落盘（`kind:'set'` ＝ 确定性 `_id` 幂等 upsert；载荷不带 `_id`，`persist` 已剥）。 */
async function persistTaskRow(taskId, doc) {
  const ops = opsModule()
  await ops.persist({
    writes: [{ kind: 'set', collection: AI_ENHANCE_TASKS_COLLECTION, id: text(taskId), doc }]
  })
}

/** 任务行局部更新（按 `_id`；命中 0 行 ⇒ `persist` 抛错 ⇒ 调用方如实上报，**不吞成成功**）。 */
async function updateTaskRow(taskId, doc) {
  const ops = opsModule()
  await ops.persist({
    writes: [
      {
        kind: 'update',
        collection: AI_ENHANCE_TASKS_COLLECTION,
        match: { _id: text(taskId) },
        doc,
        expectAtLeast: 1
      }
    ]
  })
}

/** 读影像行（按 `id` 字段；无行 ⇒ `null`）—— 提交跳 ④ 步拒绝面与终态回放 `preview` 共用此读点。 */
async function readImageRow(imageId) {
  const ops = opsModule()
  const rows = await ops.readRows(ops.COLLECTIONS.images, { id: text(imageId) }, { limit: 1 })
  return rows.length > 0 ? rows[0] : null
}

/* --------------------------------------------------------------------------- *
  资费（预扣 / 退款；单点 `lib/ledger.js` ＝ `lib/aiEnhance.js::chargeTen` / `refundTen` 同参同点）
 * --------------------------------------------------------------------------- */

/**
 * 预扣 10 金（`kind=CHARGE`、`ref_type=AI_IMAGE`、`idem_key` ＝
 * `ai-enhance-<image_id>-<request_id>` 三段封闭 —— 与同步面逐字同形态）。
 * @returns {Promise<{ok:true, balance:number, idempotent:boolean}|{ok:false, reason:string, message:string}>}
 */
async function chargeTen(uid, idemKey, refId) {
  const ops = opsModule()
  const charged = await ops.ledger.chargePoints({
    uid: text(uid),
    amount: AI_ENHANCE_COST,
    kind: 'CHARGE',
    ref_type: aiEnhance.REF_TYPE_AI_IMAGE,
    ref_id: text(refId),
    idem_key: text(idemKey)
  })
  if (!charged || charged.ok !== true) {
    return {
      ok: false,
      reason: (charged && charged.reason) || REASONS.STORAGE_UNAVAILABLE,
      message: (charged && charged.message) || '積分扣減失敗；本次零寫入。'
    }
  }
  return { ok: true, balance: charged.balance_after, idempotent: charged.idempotent === true }
}

/**
 * 全额退款（已预扣才调；原 `CHARGE` 行不删）。
 * @returns {Promise<boolean>} 退款是否成功（失败 ⇒ `refunded: false` 如实上报）
 */
async function refundTen(uid, idemKey, refId) {
  try {
    const ops = opsModule()
    const refunded = await ops.ledger.refundPoints({
      uid: text(uid),
      amount: AI_ENHANCE_COST,
      kind: 'REFUND',
      ref_type: aiEnhance.REF_TYPE_AI_IMAGE,
      ref_id: text(refId),
      idem_key: `${text(idemKey)}${REFUND_IDEM_SUFFIX}`
    })
    return !!(refunded && refunded.ok === true)
  } catch {
    return false
  }
}

/**
 * **读任务行的扣费状态**（读点单点；**缺键 / 未知值 ⇒ 一律按 `CHARGED` 处理** —— 历史行没有
 * `charge_state`、且它们**确实已扣过费** ⇒ 退款护栏照旧生效；本函数**只读不写**、不回填旧行）。
 * @param {object|null} row 已读到的任务行
 * @returns {'PENDING'|'CHARGED'}
 */
function chargeStateOf(row) {
  const value = row && typeof row.charge_state === 'string' ? row.charge_state.trim() : ''
  return value === CHARGE_STATE.PENDING ? CHARGE_STATE.PENDING : CHARGE_STATE.CHARGED
}

/* --------------------------------------------------------------------------- *
  上游调用（配置读取 → POST 取任务号 → 单查任务 → 取图）
 * 口径与 `lib/aiEnhance.js` ⑥ / ⑦ 逐条同（同一 URL / 头 / 体五键 / 状态取值 / 错误摘要）。
 * --------------------------------------------------------------------------- */

/** 上游失败摘要（**零敏感**：状态码 ＋（经抹除截长的）上游原话）。 */
function upstreamFailureMessage(status, detail) {
  const statusText = Number.isInteger(status) && status > 0 ? `HTTP ${status}` : '網絡 / 超時'
  return `AI 修復上游調用失敗（${statusText}${detail ? `：${detail}` : ''}）⇒ 本次未建候選影像行、未改印面指向。`
}

/** 上游非 2xx 错误体的可读摘要（同 `lib/aiEnhance.js::upstreamDetailOf` 口径的最小版）。 */
function upstreamDetailOf(rawText) {
  const LIMIT = 120
  const REDACT = /[A-Za-z0-9+/=]{40,}/g
  const cut = (value) => {
    const safe = String(value === undefined || value === null ? '' : value).replace(REDACT, '<redacted>')
    return safe.length > LIMIT ? safe.slice(0, LIMIT) : safe
  }
  try {
    const raw = String(rawText === undefined || rawText === null ? '' : rawText).trim()
    if (!raw) return 'body=empty'
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const errorObj = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error) ? parsed.error : null
      const candidates = [errorObj ? errorObj.message : undefined, parsed.message, parsed.msg, parsed.detail, errorObj ? undefined : parsed.error]
      for (const candidate of candidates) {
        if (typeof candidate !== 'string' && typeof candidate !== 'number' && typeof candidate !== 'boolean') continue
        const out = cut(candidate)
        if (out) return out
      }
    }
    return cut(raw).slice(0, 80)
  } catch {
    return 'unknown'
  }
}

/** 上游 2xx 回包的形状轮廓（只取键名、**零值泄露**；同 `lib/aiEnhance.js::upstreamShapeOf` 口径）。 */
function upstreamShapeOf(parsed) {
  const LIMIT = 240
  const keysOf = (value) => {
    if (!value || typeof value !== 'object') return null
    return Object.keys(value)
      .filter((key) => typeof key === 'string')
      .slice(0, 8)
      .map((key) => (key.length > 24 ? key.slice(0, 24) : key))
      .join(',')
  }
  const layerOf = (name, value) => {
    if (Array.isArray(value)) {
      if (value.length === 0) return `; ${name}[]`
      return `; ${name}[0] 鍵=（${keysOf(value[0]) || ''}）`
    }
    if (value && typeof value === 'object') return `; ${name} 鍵=（${keysOf(value) || ''}）`
    return ''
  }
  try {
    if (!parsed || typeof parsed !== 'object') return 'unknown'
    let out = keysOf(parsed)
    if (out === null) return 'unknown'
    for (const name of ['data', 'output', 'result', 'images']) {
      if (Object.prototype.hasOwnProperty.call(parsed, name)) out += layerOf(name, parsed[name])
    }
    return out.length > LIMIT ? out.slice(0, LIMIT) : out
  } catch {
    return 'unknown'
  }
}

/** 任务查询回包的**状态取值**（顶层 `status` ／ `data.status`（对象或数组首项）两形态；取不到 ⇒ 空串）。 */
function taskStatusOf(parsed) {
  const pick = (value) => {
    if (typeof value !== 'string' && typeof value !== 'number') return ''
    return text(value).toLowerCase()
  }
  try {
    if (!parsed || typeof parsed !== 'object') return ''
    const direct = pick(parsed.status)
    if (direct) return direct
    const data = parsed.data
    if (data && typeof data === 'object' && !Array.isArray(data)) return pick(data.status)
    if (Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === 'object') return pick(data[0].status)
    return ''
  } catch {
    return ''
  }
}

/** `completed` 任务的**产物 URL 列表**（顶层 / `data` 两形态；只收非空字符串项）。 */
function taskResultUrlsOf(parsed) {
  const pick = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '') : [])
  try {
    if (!parsed || typeof parsed !== 'object') return []
    const direct = pick(parsed.result_urls)
    if (direct.length > 0) return direct
    const data = parsed.data
    if (data && typeof data === 'object' && !Array.isArray(data)) return pick(data.result_urls)
    if (Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === 'object') return pick(data[0].result_urls)
    return []
  } catch {
    return []
  }
}

/** `failed` / `violation` 任务的**错误原话 `error_msg`**（顶层 / `data` 两形态；取不到 ⇒ 空串）。 */
function taskErrorOf(parsed) {
  const pick = (value) => (typeof value === 'string' || typeof value === 'number' ? text(value) : '')
  try {
    if (!parsed || typeof parsed !== 'object') return ''
    const direct = pick(parsed.error_msg)
    if (direct) return direct
    const data = parsed.data
    if (data && typeof data === 'object' && !Array.isArray(data)) return pick(data.error_msg)
    if (Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === 'object') return pick(data[0].error_msg)
    return ''
  } catch {
    return ''
  }
}

/**
 * 调上游 `POST <base_url>/images/edits` **取异步任务号**（提交跳；**墙钟预算 25 秒**）。
 * 请求体五键与同步面逐字同（`model` / `prompt`（`lib/aiEnhancePrompt.js` 逐字）/ `size` `1:1` /
 * `resolution` `1K` / `image` `data:` URL）；回包三分支：
 *   · `data[0].task_id` ＝ **异步入队回执** ⇒ 回 `{ok:true, task_id}`（**不轮询**）；
 *   · `data[0].b64_json` / `data[0].url` ＝ **同步回图的老形态** ⇒ 回 `{ok:true, bytes}`
 *     （调用方在 submit 内直接完成入库并置 `READY`）；
 *   · 两条都没有 / 非 2xx / 超时 / 网络错 ⇒ `{ok:false, reason: UPSTREAM_ERROR, message}`。
 * 明文 key 永不进回包、不打印。
 * @param {{base_url:string, model:string, key:string, timeout_ms:number}} upstream 解出的上游配置
 * @param {string} imageDataUrl 输入图 `data:` URL
 * @returns {Promise<{ok:true, task_id:string, status:number}|{ok:true, bytes:Buffer, status:number}|{ok:false, reason:string, message:string}>}
 */
async function submitUpstreamTask(upstream, imageDataUrl) {
  const startedAt = Date.now()
  const url = `${text(upstream.base_url).replace(/\/+$/, '')}/images/edits`
  const body = JSON.stringify({
    model: text(upstream.model),
    prompt: AI_ENHANCE_PROMPT,
    size: aiEnhance.AI_ENHANCE_SIZE,
    resolution: aiEnhance.AI_ENHANCE_RESOLUTION,
    image: imageDataUrl
  })
  const configured = Number(upstream.timeout_ms) > 0 ? Number(upstream.timeout_ms) : 60000
  const timeoutMs = Math.max(1000, Math.min(configured, SUBMIT_POST_BUDGET_MS))
  let status = 0
  try {
    const fetchImpl = resolveFetch()
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: authHeadersOf(upstream, 'application/json'),
      body,
      signal: AbortSignal.timeout(timeoutMs)
    })
    status = Number(response && response.status) || 0
    /* 墙钟预算 25 秒（**响应到手也超时即拒** —— 后续还要下载 / 落行，不能把预算吃光）。 */
    if (Date.now() - startedAt > SUBMIT_POST_BUDGET_MS) {
      return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: upstreamFailureMessage(status, `提交超過時限（${Math.round(SUBMIT_POST_BUDGET_MS / 1000)} 秒）`) }
    }
    if (!response || response.ok !== true) {
      let raw = ''
      try {
        raw = response && typeof response.text === 'function' ? await response.text() : ''
      } catch {
        raw = ''
      }
      return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: upstreamFailureMessage(status, upstreamDetailOf(raw)) }
    }
    const payload = await response.json()
    const first = payload && Array.isArray(payload.data) && payload.data.length > 0 ? payload.data[0] : null
    if (first && typeof first === 'object') {
      const taskId = text(first.task_id)
      if (taskId !== '') return { ok: true, task_id: taskId, status }
      if (typeof first.b64_json === 'string' && first.b64_json !== '') {
        const bytes = Buffer.from(first.b64_json, 'base64')
        if (bytes.length > 0) return { ok: true, bytes, status }
        return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: upstreamFailureMessage(status, '回圖字節為空') }
      }
      if (typeof first.url === 'string' && first.url !== '') {
        const remain = Math.max(1000, Math.min(STATUS_DOWNLOAD_BUDGET_MS, SUBMIT_POST_BUDGET_MS - (Date.now() - startedAt)))
        let download = null
        try {
          download = await fetchImpl(first.url, { signal: AbortSignal.timeout(remain) })
        } catch {
          download = null
        }
        if (!download || download.ok !== true) {
          return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: upstreamFailureMessage(status, '取圖下載失敗') }
        }
        let bytes = null
        try {
          bytes = Buffer.from(await download.arrayBuffer())
        } catch {
          bytes = null
        }
        if (!bytes || bytes.length === 0) {
          return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: upstreamFailureMessage(status, '取圖下載失敗') }
        }
        return { ok: true, bytes, status }
      }
    }
    return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: upstreamFailureMessage(status, `回包缺任務號（形狀＝${upstreamShapeOf(payload)}）`) }
  } catch (error) {
    const name = error && error.name ? String(error.name) : 'error'
    return {
      ok: false,
      reason: REASONS.UPSTREAM_ERROR,
      message: upstreamFailureMessage(0, name === 'AbortError' || name === 'TimeoutError' ? '超時' : name)
    }
  }
}

/**
 * **单查**上游任务（`GET <base_url>/tasks/<task_id>`；**单次预算 20 秒 ＋ 整轮剩余预算封顶**）。
 * @param {number} [budgetMs] 整轮剩余预算（毫秒；status 轮必传 ⇒ 与 20 秒取小者为超时上限）
 * @returns {Promise<{ok:true, state:string, resultUrls:string[], errorText:string, httpStatus:number}
 *          |{ok:false, reason:string, message:string}>}
 *   `state` ∈ `completed` / `failed` / `violation` / 其它（`pending` / `processing` / 读不懂）。
 */
async function queryUpstreamTask(upstream, upstreamTaskId, budgetMs) {
  const url = `${text(upstream.base_url).replace(/\/+$/, '')}/tasks/${encodeURIComponent(text(upstreamTaskId))}`
  const configured = Number(upstream.timeout_ms) > 0 ? Number(upstream.timeout_ms) : 60000
  const roundBudget = Number(budgetMs) > 0 ? Number(budgetMs) : STATUS_QUERY_BUDGET_MS
  const timeoutMs = Math.max(1000, Math.min(configured, STATUS_QUERY_BUDGET_MS, roundBudget))
  let status = 0
  try {
    const fetchImpl = resolveFetch()
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: authHeadersOf(upstream),
      signal: AbortSignal.timeout(timeoutMs)
    })
    status = Number(response && response.status) || 0
    if (!response || response.ok !== true) {
      let raw = ''
      try {
        raw = response && typeof response.text === 'function' ? await response.text() : ''
      } catch {
        raw = ''
      }
      return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: upstreamFailureMessage(status, upstreamDetailOf(raw)) }
    }
    const payload = await response.json()
    return {
      ok: true,
      state: taskStatusOf(payload),
      resultUrls: taskResultUrlsOf(payload),
      errorText: taskErrorOf(payload),
      httpStatus: status
    }
  } catch (error) {
    const name = error && error.name ? String(error.name) : 'error'
    return {
      ok: false,
      reason: REASONS.UPSTREAM_ERROR,
      message: upstreamFailureMessage(status, name === 'AbortError' || name === 'TimeoutError' ? '超時' : name)
    }
  }
}

/** 下载产物字节（**预算 25 秒**；失败 / 空字节 ⇒ `null`）。 */
async function downloadResultBytes(fetchImpl, resultUrl, budgetMs) {
  const timeoutMs = Math.max(1000, Math.min(STATUS_DOWNLOAD_BUDGET_MS, budgetMs))
  let response = null
  try {
    response = await fetchImpl(resultUrl, { signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    response = null
  }
  if (!response || response.ok !== true) return null
  try {
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes && bytes.length > 0 ? bytes : null
  } catch {
    return null
  }
}

/** 预算耗尽哨兵（`withinBudget` 到点返回；不与任何正常返回值冲突）。 */
const BUDGET_EXPIRED = Symbol('BUDGET_EXPIRED')

/**
 * **段内预算执行**：到点（`deadlineAt`，`Date.now()` 尺度）即**停止等待**并返回 `BUDGET_EXPIRED`。
 * 存储侧调用（`ops.*`）没有中止缝 ⇒ 只能停等待；配合**开工前查预算**（到点不再发新请求）保证
 * 整轮截止之后本函数不再新发网络请求；先挂处理者 ⇒ 迟到的拒绝不会变成未处理拒绝。
 * @param {Promise<any>} promise 段内调用
 * @param {number} deadlineAt 绝对截止时刻；非有限值 ⇒ 不设截止（原样等待）
 * @returns {Promise<any>|Promise<typeof BUDGET_EXPIRED>}
 */
function withinBudget(promise, deadlineAt) {
  if (!Number.isFinite(deadlineAt)) return promise
  const settle = promise.then((value) => ({ value }), (error) => ({ error }))
  const remainingMs = Math.max(0, deadlineAt - Date.now())
  let timer = null
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve(BUDGET_EXPIRED), remainingMs)
  })
  return Promise.race([settle, expiry]).then((outcome) => {
    clearTimeout(timer)
    if (outcome === BUDGET_EXPIRED) return BUDGET_EXPIRED
    if (outcome && outcome.error) throw outcome.error
    return outcome && outcome.value
  })
}

/* --------------------------------------------------------------------------- *
  产物入册（内容寻址上传 ＋ 影像行入册；`seq` 走既有单点，绝不自算号）
 * --------------------------------------------------------------------------- */

/**
 * 把上游产物字节入册成**新影像行**（与 `lib/aiEnhance.js` ⑧ / ⑨ 同一套：
 * 魔数判容器 → 内容寻址键 → 上传 → `seq` 单点取号 → `doc(id).set` 确定性幂等 upsert；
 * **不挂印面** —— 不写任何 `face_image_id`）。
 * @param {object} params 入册参数；`params.budgetDeadlineAt` ＝ **段内绝对截止时刻**
 *   （status 轮传整轮截止 `roundStartedAt + STATUS_ROUND_BUDGET_MS`；缺省 ⇒ 不设截止 ——
 *   submit 老形态同此）。到点 ⇒ **不再新发存储请求**、**停止等待**并回结构化失败。
 * @returns {Promise<{ok:true, image_id:string, mime:string, sha256:string, bytes:number, elapsed_ms:number}
 *          |{ok:false, reason:string, message:string}>}
 */
async function registerProductImage(params) {
  const ops = opsModule()
  const startedAt = Date.now()
  /* 段内截止（可选）：**开工前查预算**（到点不发新请求）＋ **赛跑到点停等待**（存储侧无中止缝）。 */
  const deadlineAt = Number(params.budgetDeadlineAt) > 0 ? Number(params.budgetDeadlineAt) : Infinity
  const budgetExhausted = () => Date.now() >= deadlineAt
  /* 整轮预算尽 ⇒ 结构化失败（退不退款由调用方按整轮预算裁决）。
     **不断言「未寫入」**（`AC-699`：赛跑期间存储侧可能仍在处理）⇒ 文案只说
     「可能仍在處理 / 稍後重新整理確認」；「未改印面指向」本函数任何路径都为真。 */
  const budgetFail = () => ({
    ok: false,
    reason: REASONS.UPSTREAM_ERROR,
    message: '入冊段在剩餘預算內未完成（整輪預算已盡；雲端可能仍在處理）⇒ 請稍後重新整理確認；本次未改印面指向。'
  })
  const bytes = params.bytes
  const mime = aiEnhance.sniffImageMime(bytes)
  const ext = aiEnhance.PRODUCT_MIME_EXT[mime]
  if (!ext) {
    return {
      ok: false,
      reason: REASONS.UPSTREAM_ERROR,
      message: '上游回圖字節不是本面入册的產物族（png / webp / jpeg）⇒ 本次未建候選影像行、未改印面指向。'
    }
  }
  const sha256 = sha256Hex(bytes)
  const storageKey = `xiai/images/${sha256.slice(0, 2)}/${sha256}.${ext}`
  /* ① 内容寻址上传（开工前查预算 ＋ 赛跑封顶）。 */
  if (budgetExhausted()) return budgetFail()
  try {
    const uploaded = await withinBudget(ops.uploadDisplayArtifactBytes(storageKey, bytes), deadlineAt)
    if (uploaded === BUDGET_EXPIRED) return budgetFail()
  } catch (error) {
    return { ok: false, reason: REASONS.STORAGE_UNAVAILABLE, message: `修復產物上傳失敗（雲端存儲不可用）⇒ 本次未建候選影像行、未改印面指向。（診斷：${diagnoseOf(error)}）` }
  }
  const imageId = aiEnhance.imageIdOfIdemKey(aiEnhance.idemKeyOf(text(params.sourceImageId), text(params.requestId)))
  const now = nowIso()
  /* ② `seq` 单点取号（同上：开工前查预算 ＋ 赛跑封顶；拒绝形态与原实现一致 —— 原样上抛）。 */
  if (budgetExhausted()) return budgetFail()
  const faceImageSeqs = await withinBudget(ops.imageSeqsOf(text(params.sealId), 'FACE'), deadlineAt)
  if (faceImageSeqs === BUDGET_EXPIRED) return budgetFail()
  const doc = {
    id: imageId,
    stamp_id: text(params.sealId),
    sealId: text(params.sealId),
    kind: 'FACE',
    /* `seq` 单点：同 `(stamp_id, kind)` 既有行最大值 + 1（本文件**不自算号**）。 */
    seq: ops.nextImageSeqOf(text(params.sealId), 'FACE', faceImageSeqs),
    storage: 'server',
    storage_key: storageKey,
    sha256,
    bytes: bytes.length,
    bytesLength: bytes.length,
    mime,
    width: null,
    height: null,
    source: 'ai_enhance',
    displayOnly: true,
    /* 服务端记载（供回放与诊断；不下发、不参与读面判定）。 */
    source_image_id: text(params.sourceImageId),
    charge_balance_after: Number(params.chargeBalanceAfter) || 0,
    upstream_status: Number(params.upstreamStatus) || 0,
    elapsed_ms: Number.isInteger(params.elapsedMs) ? params.elapsedMs : 0,
    created_at: now
  }
  /* ③ 影像行入册（同上：开工前查预算 ＋ 赛跑封顶）。 */
  if (budgetExhausted()) return budgetFail()
  try {
    const persisted = await withinBudget(ops.persist({ writes: [{ kind: 'set', collection: ops.COLLECTIONS.images, id: imageId, doc }] }), deadlineAt)
    if (persisted === BUDGET_EXPIRED) return budgetFail()
  } catch (error) {
    return { ok: false, reason: REASONS.STORAGE_UNAVAILABLE, message: `修復產物影像行入册失敗（權威存儲不可用）⇒ 本次未改印面指向，可重試本操作（同請求號不重複扣費）。（診斷：${diagnoseOf(error)}）` }
  }
  return { ok: true, image_id: imageId, mime, sha256, bytes: bytes.length, elapsed_ms: Date.now() - startedAt }
}

/* --------------------------------------------------------------------------- *
  终态机（退款只退一次：行上 `refunded` 布尔为护栏 ＋ 账本幂等键双保险）
 * --------------------------------------------------------------------------- */

/**
 * 置 `FAILED` ＋（未退过才）全额退款，回**恰 5 键**的失败回包。
 * 任务行状态写入失败 ⇒ **不谎报 `FAILED`**：回包 `status` 给出**库内实况**（原状态）、
 * `reason` 转 `STORAGE_UNAVAILABLE` 并在文案里带上原失败原因（退款结果照实报）。
 * **退款只对真扣过费的行发生**：`charge_state` 为 `PENDING`（已落行、扣费从未成功）⇒ **零退款**
 * （否则会给未扣费的行凭空 +10 金）；旧行缺该键 ⇒ 按 `CHARGED` 照旧退。
 */
async function failTask(taskId, row, reason, message) {
  const uid = text(row.uid)
  const idemKey = aiEnhance.idemKeyOf(text(row.source_image_id), text(row.request_id))
  const charged = chargeStateOf(row) === CHARGE_STATE.CHARGED
  const needsRefund = charged && row.refunded !== true
  let refunded = row.refunded === true
  if (needsRefund) refunded = await refundTen(uid, idemKey, text(taskId))
  /* **退款未成 ⇒ 不置终态**：行保持原状态 ⇒ 下一次 `ai-enhance-status` 重试退款
     （行上 `refunded` 仍为 `false` ⇒ 不会重复退；账本幂等键再加一道双保险）。
     `PENDING`（本就未扣费、`needsRefund:false`）不进本分支 —— 直接置终态、`refunded` 恒 `false`。 */
  if (needsRefund && !refunded) {
    return statusFailure(
      REASONS.STORAGE_UNAVAILABLE,
      `${message}（退款未能完成 ⇒ 本次**未置 FAILED**、行狀態維持「${text(row.status)}」；請重試本操作以補退款。）`,
      false,
      text(row.status)
    )
  }
  const now = nowIso()
  try {
    await updateTaskRow(taskId, {
      status: TASK_STATUS.FAILED,
      refunded: true,
      error_reason: reason,
      error_message: message,
      updated_at: now
    })
  } catch (error) {
    return statusFailure(
      REASONS.STORAGE_UNAVAILABLE,
      `${message}（任務行狀態寫入失敗 ⇒ 庫內仍為「${text(row.status)}」，可重試本操作；退款結果：已退。診斷：${diagnoseOf(error)}）`,
      true,
      text(row.status)
    )
  }
  return statusFailure(reason, message, true, TASK_STATUS.FAILED)
}

/** 终态回放（`READY`：**恰 6 键**）。`preview` 取候选影像行本体（读不到 ⇒ 结构化失败、可重试）。 */
async function readyReply(taskId, row) {
  const productImageId = text(row.product_image_id)
  let imageRow = null
  try {
    imageRow = productImageId === '' ? null : await readImageRow(productImageId)
  } catch (error) {
    return statusFailure(REASONS.STORAGE_UNAVAILABLE, `候選影像行讀取失敗（權威存儲不可用）；本次零扣費、零寫入，可稍後重試。（診斷：${diagnoseOf(error)}）`, false, TASK_STATUS.READY)
  }
  return {
    ok: true,
    task_id: text(taskId),
    status: TASK_STATUS.READY,
    image_id: productImageId,
    preview: { mime: text(imageRow && imageRow.mime), sha256: text(imageRow && imageRow.sha256) },
    charge: { amount: Number(row.charge_amount) || AI_ENHANCE_COST, balance: Number(row.charge_balance_after) || 0 }
  }
}

/** 终态回放（`FAILED`：**恰 5 键**，`ok:false`；`reason` 只取行上记载的冻结值）。 */
function failedReply(taskId, row) {
  return statusFailure(
    text(row.error_reason) || REASONS.UPSTREAM_ERROR,
    text(row.error_message) || '人工智能修復任務已失敗。',
    row.refunded === true,
    TASK_STATUS.FAILED
  )
}

/** 幂等回放（submit；**恰 5 键** —— 回放该行，零扣费零上游；**不带 `image_id`**）。 */
function submitReplay(taskId, row) {
  return submitSuccess(taskId, text(row.status) || TASK_STATUS.SUBMITTED, text(row.source_image_id), row.charge_balance_after)
}

/* --------------------------------------------------------------------------- *
  op ① · `ai-enhance-submit`
 * --------------------------------------------------------------------------- */

/**
 * **提交一次人工智能修復**（管理员面；会計費：单张 10 金；服务端裁决）。
 * 顺序（**判定全部在扣费 / 调上游之前**）：
 *  ⓪ 管理员门（**第一行**；零读零写地拒）→ ① 载荷封闭恰四键 → ② 幂等预查（已有行 ⇒ 回放；
 *     行是 `charge_state:'PENDING'` 的中断残留 ⇒ **续做本跳**）
 *  → ③ 读源影像行 / 拼对象键 / 取字节（拒绝面：零扣费）→ ④ 上游配置（缺 ⇒ 零扣费）
 *  → ⑤a **先落任务行 `SUBMITTED`**（`charge_state:'PENDING'` ＋ `charge_amount:0`）
 *     → ⑤b 预扣 10 金 → ⑤c 回写 `charge_amount:10 / charge_state:'CHARGED' / charge_balance_after`
 *  → ⑥ 调上游取任务号 → ⑦ 行回写 `upstream_task_id`（老形态同步回图 ⇒ 同步入册并置 `READY`）
 *  → ⑧ 成功回包恰 5 键。
 * **整段墙钟硬上限 25 秒**（函数入口取绝对截止 `submitDeadlineAt`）：读源字节 / 解配置 / 落行 /
 * 扣费 / 上游 POST **每步都经 `withinBudget` 封顶** ⇒ 超限即**先退款、再把行转
 * `FAILED(UPSTREAM_ERROR, 「提交超過 25 秒…」)`** 并返回失败（**绝不等网关约 60 秒**）；
 * 收尾写库（退款 ＋ 转 `FAILED`）另给 ≤10 秒宽限 ⇒ **整段总时长 ≤ 35 秒**。
 * **行未落 ⇒ 无失败行可转**（此时尚未扣费 ⇒ 回 4 键失败、`refunded:false`）；**本次未真扣费的
 * 失败路径一律零退款**（不给未扣费的行凭空 +10 金）。
 * @param {object} payload 载荷（封闭四键 `image_id` / `seal_id` / `face_id` / `request_id`）
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number, requestId?:string}} [context]
 * @returns {Promise<object>} 成功恰 5 键 / 失败恰 4 键
 */
async function submitEnhanceTask(payload, identity, context) {
  /* ⓪ 管理员门（既有单点；**第一行**，零读零写地拒）。 */
  const ops = opsModule()
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return submitFailure(identityDenial.reason, identityDenial.message, false)
  /* 本跳起始时刻（老形态同步回图路的 `elapsed_ms` 记账基准）＋ **整段墙钟硬上限 25 秒**
     （函数入口取绝对截止 ⇒ 读源字节 / 解配置 / 落行 / 扣费 / 上游 POST 每步都在其内）。 */
  const submitStartedAt = Date.now()
  const submitDeadlineAt = submitStartedAt + SUBMIT_POST_BUDGET_MS
  /* 收尾写库（退款 ＋ 行转 `FAILED`）另给 ≤10 秒宽限；绝对截止 ＝ 段截止 ＋ 宽限 ⇒ 总时长 ≤ 35 秒。 */
  const cleanupDeadlineAt = submitDeadlineAt + SUBMIT_CLEANUP_GRACE_MS
  /* 段内每一步：到点即停止等待（`BUDGET_EXPIRED` ＝ 超限哨兵；存储侧调用没有中止缝）。
     **开工前不另查预算** —— 段内任一步到点都会以哨兵收口，不再新发请求。 */
  const budgeted = (promise) => withinBudget(promise, submitDeadlineAt)
  const cleanupBudgeted = (promise) => withinBudget(promise, cleanupDeadlineAt)
  /* 段超限文案头（回包与行内 `error_message` 同源；**恒以「提交超過 25 秒」起头**）。 */
  const overBudgetHead = `提交超過 ${Math.round(SUBMIT_POST_BUDGET_MS / 1000)} 秒（整段牆鐘硬上限）`
  const overBudgetMessage = (refunded) =>
    refunded === true
      ? `${overBudgetHead} ⇒ 已全額退回 ${AI_ENHANCE_COST} 金；可重新提交。`
      : `${overBudgetHead} ⇒ 退款未能完成，請重試本操作以補退款。`
  /* 段超限且**行未落**（此前零扣费、零上游）。 */
  const overBudgetBeforeRow = () =>
    submitFailure(REASONS.UPSTREAM_ERROR, `${overBudgetHead} ⇒ 本次未扣費、未落任務行、未調上游。`, false)
  /* 写行结果 → 并入文案的诊断串（`BUDGET_EXPIRED` ＝ 收尾超限，不是抛错）。 */
  const writeNoteOf = (outcome) =>
    outcome === BUDGET_EXPIRED ? '（任務行落盤超過收尾寬限、未完成）' : text(outcome)

  /* ① 载荷封闭恰四键（形态 → 未知键 → 缺 / 空键 → 值域 → 请求号形态；全部早于任何读写）。 */
  if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return submitFailure(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零扣費、零寫入、未調上游。', false)
  }
  const unknown = Object.keys(payload).filter((key) => SUBMIT_ALLOWED_KEYS.indexOf(key) === -1)
  if (unknown.length > 0) {
    return submitFailure(
      REASONS.INVALID_FIELD,
      `載荷含未知欄位：${unknown.join('、')}（AI 修復提交入參封閉四鍵：image_id / seal_id / face_id / request_id；金額、prompt、size、resolution 一律由服務端給定）；本次零扣費、零寫入、未調上游。`,
      false
    )
  }
  const missing = SUBMIT_ALLOWED_KEYS.filter(
    (key) => !Object.prototype.hasOwnProperty.call(payload, key) || text(payload[key]) === ''
  )
  if (missing.length > 0) {
    return submitFailure(
      REASONS.MISSING_REQUIRED,
      `人工智能修復提交需要原圖影像編號（image_id）／印章編號（seal_id）／印面編號（face_id）／請求號（request_id）四鍵齊備（缺：${missing.join('、')}）；本次零扣費、零寫入、未調上游。`,
      false
    )
  }
  if (SUBMIT_ALLOWED_KEYS.some((key) => typeof payload[key] !== 'string')) {
    return submitFailure(REASONS.INVALID_VALUE, '四鍵必須都是字符串；本次零扣費、零寫入、未調上游。', false)
  }
  const imageId = text(payload.image_id)
  const sealId = text(payload.seal_id)
  const faceId = text(payload.face_id)
  const requestId = text(payload.request_id)
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    return submitFailure(
      REASONS.INVALID_VALUE,
      '請求號（request_id）必須是 8〜64 位的字母、數字、底線或橫線；本次零扣費、零寫入、未調上游。',
      false
    )
  }

  const uid = text(identity && identity.uid)
  const taskId = taskIdOf(uid, requestId)
  const idemKey = aiEnhance.idemKeyOf(imageId, requestId)

  /* ② 幂等预查（同 uid 同 request_id 已有行 ⇒ 直接回放该行：零扣费、零上游、零写入）。
     **例外**：行是「已落行、未扣费」的中断残留（`charge_state:'PENDING'` ＋ 无上游任务号 ＋ 非终态）
     ⇒ 视作**未完成的提交**、续做本跳（扣费 → 上游 → 行回写），不回放半成品。 */
  const existing = await budgeted(readTaskRow(taskId))
  if (existing === BUDGET_EXPIRED) return overBudgetBeforeRow()
  const resumable =
    existing &&
    chargeStateOf(existing) === CHARGE_STATE.PENDING &&
    text(existing.upstream_task_id) === '' &&
    text(existing.status) === TASK_STATUS.SUBMITTED &&
    existing.refunded !== true
  if (existing && !resumable) return submitReplay(taskId, existing)

  /* ③ 读源影像行 → 拼对象键 → 取字节（与同步面 ④ 步同一套拒绝面：全部零扣费、未调上游）。 */
  const sourceRow = await budgeted(readImageRow(imageId))
  if (sourceRow === BUDGET_EXPIRED) return overBudgetBeforeRow()
  if (!sourceRow) {
    return submitFailure(REASONS.INVALID_VALUE, '原圖影像編號（image_id）在影像行中不存在；本次零扣費、零寫入、未調上游。', false)
  }
  const digest = text(sourceRow.sha256).toLowerCase()
  if (!DIGEST_PATTERN.test(digest)) {
    return submitFailure(REASONS.INVALID_VALUE, '原圖影像行缺少合法摘要（sha256）⇒ 無從定位圖源；本次零扣費、零寫入、未調上游。', false)
  }
  const opsRead = opsModule()
  let sourceBytes = null
  let sourceExpired = false
  for (const ext of aiEnhance.SOURCE_KEY_EXTS) {
    const candidate = `xiai/images/${digest.slice(0, 2)}/${digest}${ext}`
    if (!aiEnhance.SOURCE_KEY_PATTERN.test(candidate)) continue
    try {
      const bytes = await budgeted(opsRead.readArtifactBytes(candidate))
      /* 段预算到点 ⇒ **停止尝试**（不再读下一个候选、不把哨兵当字节）。 */
      if (bytes === BUDGET_EXPIRED) {
        sourceExpired = true
        break
      }
      sourceBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
      break
    } catch {
      /* 该扩展名候选对象不存在 ⇒ 试下一个候选（`.tiff` 源件一律不在候选面内）。 */
    }
  }
  if (sourceExpired) return overBudgetBeforeRow()
  if (!sourceBytes) {
    return submitFailure(
      REASONS.STORAGE_UNAVAILABLE,
      '雲端展示件對象存儲不可用或圖源對象不存在（未讀到 png / webp / jpeg 展示件）；本次零扣費、零寫入、未調上游。',
      false
    )
  }
  const sourceMime = aiEnhance.sniffImageMime(sourceBytes)
  if (!sourceMime) {
    return submitFailure(REASONS.INVALID_VALUE, '圖源字節不是本面認可的影像容器（png / jpeg / webp）；本次零扣費、零寫入、未調上游。', false)
  }
  if (sourceBytes.length > aiEnhance.SOURCE_MAX_BYTES) {
    return submitFailure(
      REASONS.INVALID_VALUE,
      `圖源字節超出上限（${Math.round(aiEnhance.SOURCE_MAX_BYTES / 1024 / 1024)} MiB）；本次零扣費、零寫入、未調上游。`,
      false
    )
  }

  /* ④ 上游配置（缺 ⇒ `CONFIG_MISSING` ＋ 零扣费 —— 未预扣即拒）。 */
  const aiUpstream = require('./aiUpstream.js')
  const upstreamOutcome = await budgeted(aiUpstream.resolveUpstreamSecret())
  if (upstreamOutcome === BUDGET_EXPIRED) return overBudgetBeforeRow()
  const upstream = upstreamOutcome
  if (!upstream || upstream.ok === false) {
    return submitFailure(
      (upstream && upstream.reason) || REASONS.CONFIG_MISSING,
      `${(upstream && upstream.message) || 'AI 上游未配置'}；本次零扣費、零寫入、未調上游。`,
      false
    )
  }

  /* ⑤a **先落任务行**（`SUBMITTED` ＋ `charge_state:'PENDING'` ＋ `charge_amount:0`）—— 行在扣费之前，
     任何中断最多留下「有行无扣费 / 有行已扣费」，**绝不出现「已扣费却无行」**（后者正是孤儿流水的
     成因；由 `repairOrphanEnhanceCharges` 收口）。落行失败 ⇒ 本次不扣费、不调上游。 */
  const createdAt = nowIso()
  const rowDeadlineAt = new Date(Date.parse(createdAt) + TASK_DEADLINE_MS).toISOString()
  const pendingDoc = {
    uid,
    request_id: requestId,
    source_image_id: imageId,
    seal_id: sealId,
    face_id: faceId,
    status: TASK_STATUS.SUBMITTED,
    upstream_task_id: '',
    upstream_status: 0,
    product_image_id: '',
    charge_amount: 0,
    charge_state: CHARGE_STATE.PENDING,
    charge_balance_after: 0,
    error_reason: '',
    error_message: '',
    refunded: false,
    created_at: createdAt,
    updated_at: createdAt,
    deadline_at: rowDeadlineAt
  }
  try {
    const persisted = await budgeted(persistTaskRow(taskId, pendingDoc))
    if (persisted === BUDGET_EXPIRED) return overBudgetBeforeRow()
  } catch (error) {
    return submitFailure(
      REASONS.STORAGE_UNAVAILABLE,
      `任務行落盤失敗（權威存儲不可用）⇒ 本次未扣費、未調上游、未落行；可重試本操作。（診斷：${diagnoseOf(error)}）`,
      false
    )
  }

  /* 行已在场的失败收口：**先退款**（收尾宽限内；本次未真扣费 ⇒ 零退款）→ 行转 `FAILED` → 恰 4 键。
     `message` 可为字符串或 `(refunded) => string`（段超限文案要按退款结果定稿）。 */
  const failAfterRow = async ({ reason, message, charged, balance, chargeAmount, upstreamStatus }) => {
    let refunded = false
    if (charged) {
      const refundOutcome = await cleanupBudgeted(refundTen(uid, idemKey, taskId))
      refunded = refundOutcome === true
    }
    const finalMessage = typeof message === 'function' ? message(refunded) : message
    const rowNote = await cleanupBudgeted(
      writeFailedTaskRow(
        taskId,
        {
          uid,
          request_id: requestId,
          source_image_id: imageId,
          seal_id: sealId,
          face_id: faceId,
          upstream_status: Number(upstreamStatus) || 0,
          charge_balance_after: balance
        },
        reason,
        finalMessage,
        refunded,
        {
          amount: Number(chargeAmount) || 0,
          state: charged ? CHARGE_STATE.CHARGED : CHARGE_STATE.PENDING,
          balance
        }
      )
    )
    return submitFailure(reason, appendWriteNote(finalMessage, writeNoteOf(rowNote)), refunded)
  }

  /* ⑤b 预扣 10 金（`idem_key` 三段封闭；余额不足 ⇒ `INSUFFICIENT_POINTS` ＋ 零扣费）。 */
  const chargedOutcome = await budgeted(chargeTen(uid, idemKey, taskId))
  if (chargedOutcome === BUDGET_EXPIRED) {
    /* 扣费未在段内返回 ⇒ 结果未知：**先退款**（账本幂等键保证只退一次）再转 `FAILED`。 */
    return await failAfterRow({
      reason: REASONS.UPSTREAM_ERROR,
      message: overBudgetMessage,
      charged: true,
      balance: 0,
      chargeAmount: AI_ENHANCE_COST,
      upstreamStatus: 0
    })
  }
  const charged = chargedOutcome
  if (!charged.ok) {
    /* 扣费失败 ⇒ 行转 `FAILED`（`charge_amount:0` / `charge_state:'PENDING'` ＝ 未扣实况）、
       **零退款**（本次未扣过一分钱）、零上游。 */
    return await failAfterRow({
      reason: charged.reason,
      message: `${charged.message}（本次零扣費、未調上游）`,
      charged: false,
      balance: 0,
      chargeAmount: 0,
      upstreamStatus: 0
    })
  }
  /* 并发同请求号：另一路已持 charge（账本幂等）且**已把行推到扣费后状态** ⇒ 回放它的行（恰一路真跑）。
     行仍是本路写的 `PENDING` ⇒ 说明另一路尚未推进（或本路是 PENDING 残留的续做）⇒ 本路继续。 */
  if (charged.idempotent) {
    const raced = await budgeted(readTaskRow(taskId))
    if (raced === BUDGET_EXPIRED) {
      return await failAfterRow({
        reason: REASONS.UPSTREAM_ERROR,
        message: overBudgetMessage,
        charged: true,
        balance: charged.balance,
        chargeAmount: AI_ENHANCE_COST,
        upstreamStatus: 0
      })
    }
    if (raced && chargeStateOf(raced) === CHARGE_STATE.CHARGED && text(raced.status) !== TASK_STATUS.FAILED) {
      return submitReplay(taskId, raced)
    }
  }

  /* ⑤c 回写扣费实况（`charge_amount:10 / charge_state:'CHARGED' / charge_balance_after`）。
     回写失败 ⇒ **不谎报**：退款（收尾宽限）＋ 行转 `FAILED`（`writeFailedTaskRow` 整行落）。 */
  try {
    const updated = await budgeted(
      updateTaskRow(taskId, {
        charge_amount: AI_ENHANCE_COST,
        charge_state: CHARGE_STATE.CHARGED,
        charge_balance_after: charged.balance
      })
    )
    if (updated === BUDGET_EXPIRED) {
      return await failAfterRow({
        reason: REASONS.UPSTREAM_ERROR,
        message: overBudgetMessage,
        charged: true,
        balance: charged.balance,
        chargeAmount: AI_ENHANCE_COST,
        upstreamStatus: 0
      })
    }
  } catch (error) {
    return await failAfterRow({
      reason: REASONS.STORAGE_UNAVAILABLE,
      message: `扣費實況回寫失敗（權威存儲不可用）⇒ 本次已停止並全額退回 ${AI_ENHANCE_COST} 金；請重新提交。（診斷：${diagnoseOf(error)}）`,
      charged: true,
      balance: charged.balance,
      chargeAmount: AI_ENHANCE_COST,
      upstreamStatus: 0
    })
  }

  /* ⑥ 调上游取异步任务号（**整段墙钟 25 秒**：非 2xx / 超时 / 网络错 / 缺任务号 / 段超限
     ⇒ 先退款、再置 `FAILED` —— **绝不等网关约 60 秒**）。 */
  const imageDataUrl = dataUrlOf(sourceMime, sourceBytes)
  const postedOutcome = await budgeted(submitUpstreamTask(upstream, imageDataUrl))
  if (postedOutcome === BUDGET_EXPIRED) {
    return await failAfterRow({
      reason: REASONS.UPSTREAM_ERROR,
      message: overBudgetMessage,
      charged: true,
      balance: charged.balance,
      chargeAmount: AI_ENHANCE_COST,
      upstreamStatus: 0
    })
  }
  const posted = postedOutcome
  if (!posted.ok) {
    return await failAfterRow({
      reason: posted.reason,
      message: posted.message,
      charged: true,
      balance: charged.balance,
      chargeAmount: AI_ENHANCE_COST,
      upstreamStatus: 0
    })
  }

  /* ⑦ 行回写（**只补差量键**：行体由 ⑤a 落定，`created_at` / `deadline_at` 一字不改）。 */
  const chargePatch = {
    upstream_status: Number(posted.status) || 0,
    charge_amount: AI_ENHANCE_COST,
    charge_state: CHARGE_STATE.CHARGED,
    charge_balance_after: charged.balance,
    error_reason: '',
    error_message: '',
    refunded: false
  }

  /* ⑦a 异步入队（老形态不在场）：行回写 `SUBMITTED` ＋ 上游任务号。回写失败 ⇒ 全额退款
     （行上没有任务号 ⇒ 本面无从轮询）。 */
  if (posted.task_id) {
    try {
      const updated = await budgeted(
        updateTaskRow(
          taskId,
          Object.assign({ status: TASK_STATUS.SUBMITTED, upstream_task_id: posted.task_id, product_image_id: '' }, chargePatch)
        )
      )
      if (updated === BUDGET_EXPIRED) {
        return await failAfterRow({
          reason: REASONS.UPSTREAM_ERROR,
          message: overBudgetMessage,
          charged: true,
          balance: charged.balance,
          chargeAmount: AI_ENHANCE_COST,
          upstreamStatus: Number(posted.status) || 0
        })
      }
    } catch (error) {
      const refundOutcome = await cleanupBudgeted(refundTen(uid, idemKey, taskId))
      const refunded = refundOutcome === true
      return submitFailure(
        REASONS.STORAGE_UNAVAILABLE,
        `任務行落盤失敗（權威存儲不可用）⇒ ${refunded ? `已全額退回 ${AI_ENHANCE_COST} 金` : '退款未能完成'}；上游任務已入隊但行上未記任務號、本面不追蹤，請重新提交。（診斷：${diagnoseOf(error)}）`,
        refunded
      )
    }
    return submitSuccess(taskId, TASK_STATUS.SUBMITTED, imageId, charged.balance)
  }

  /* ⑦b 同步回图的老形态：**submit 内直接完成入库并置 `READY`**（回包形状不变、仍不带 `image_id`）。
     入册段吃**同一段预算**（到点即停等待 ⇒ 由下面统一按段超限收口）。 */
  const elapsedMs = Date.now() - submitStartedAt
  const ingestOutcome = await budgeted(
    registerProductImage({
      bytes: posted.bytes,
      sealId,
      sourceImageId: imageId,
      requestId,
      chargeBalanceAfter: charged.balance,
      upstreamStatus: Number(posted.status) || 0,
      elapsedMs,
      budgetDeadlineAt: submitDeadlineAt
    })
  )
  if (ingestOutcome === BUDGET_EXPIRED || !ingestOutcome.ok) {
    const expired = ingestOutcome === BUDGET_EXPIRED || Date.now() >= submitDeadlineAt
    return await failAfterRow({
      reason: expired ? REASONS.UPSTREAM_ERROR : ingestOutcome.reason,
      message: expired ? overBudgetMessage : ingestOutcome.message,
      charged: true,
      balance: charged.balance,
      chargeAmount: AI_ENHANCE_COST,
      upstreamStatus: Number(posted.status) || 0
    })
  }
  const ingested = ingestOutcome
  try {
    const updated = await budgeted(
      updateTaskRow(
        taskId,
        Object.assign(
          { status: TASK_STATUS.READY, upstream_task_id: '', product_image_id: ingested.image_id, elapsed_ms: ingested.elapsed_ms },
          chargePatch
        )
      )
    )
    if (updated === BUDGET_EXPIRED) {
      /* 候选影像行已入册（确定性 `_id` ⇒ 重放不建第二行）⇒ **不退款**：重放同 request_id 只补任务行。 */
      return submitFailure(
        REASONS.UPSTREAM_ERROR,
        `${overBudgetHead} ⇒ 候選影像行已入册但任務行落盤未完成；請重放本次提交（同請求號不重複扣費、不重複入册）。`,
        false
      )
    }
  } catch (error) {
    /* 候选影像行已入册（确定性 `_id` ⇒ 重放不建第二行）⇒ **不退款**：重放同 request_id 只补任务行。 */
    return submitFailure(
      REASONS.STORAGE_UNAVAILABLE,
      `候選影像行已入册但任務行落盤失敗（權威存儲不可用）⇒ 本次**未退款**；請重放本次提交（同請求號不重複扣費、不重複入册）。（診斷：${diagnoseOf(error)}）`,
      false
    )
  }
  return submitSuccess(taskId, TASK_STATUS.READY, imageId, charged.balance)
}

/** 失败路径的 `FAILED` 行落盘（尽力而为；失败 ⇒ 返回诊断串由调用方并入文案，**不吞成成功**）。
 * @param {{amount?:number, state?:string, balance?:number}} [charge] 行上扣费实况
 *   （缺省 ＝ `charge_amount:10 / CHARGED / balance 取 base` —— 即「已扣费」的老口径；
 *   **本次未真扣费的路径必传** `{amount:0, state:CHARGE_STATE.PENDING, balance:0}`）。 */
async function writeFailedTaskRow(taskId, base, reason, message, refunded, charge) {
  const now = nowIso()
  const chargeDoc = charge && typeof charge === 'object' ? charge : {}
  const charged = chargeDoc.state !== CHARGE_STATE.PENDING
  const doc = {
    uid: text(base.uid),
    request_id: text(base.request_id),
    source_image_id: text(base.source_image_id),
    seal_id: text(base.seal_id),
    face_id: text(base.face_id),
    status: TASK_STATUS.FAILED,
    upstream_task_id: '',
    upstream_status: Number(base.upstream_status) || 0,
    product_image_id: '',
    charge_amount: Number.isFinite(Number(chargeDoc.amount)) ? Number(chargeDoc.amount) : AI_ENHANCE_COST,
    charge_state: charged ? CHARGE_STATE.CHARGED : CHARGE_STATE.PENDING,
    charge_balance_after: Number.isFinite(Number(chargeDoc.balance)) ? Number(chargeDoc.balance) : Number(base.charge_balance_after) || 0,
    error_reason: reason,
    error_message: message,
    refunded: refunded === true,
    created_at: now,
    updated_at: now,
    deadline_at: new Date(Date.parse(now) + TASK_DEADLINE_MS).toISOString()
  }
  try {
    await persistTaskRow(taskId, doc)
    return ''
  } catch (error) {
    return `（任務行落盤失敗：${diagnoseOf(error)}）`
  }
}

/** 把「任务行落盘失败」的诊断并入失败文案（回包键面不变）。 */
function appendWriteNote(message, note) {
  if (!note) return message
  return `${message}${note}`
}

/* --------------------------------------------------------------------------- *
  op ② · `ai-enhance-status`
 * --------------------------------------------------------------------------- */

/**
 * **剩余预算不足以开新一段（下载 / 入册）** ⇒ **不退款、不改终态**：
 * 行置 `RUNNING` ＋ 把说明写进行内 `error_message`（繁体上屏；`READY` 落定的既有路径会清空、
 * `FAILED` 由 `failTask` 覆盖 ⇒ 说明不会漏进终态），回**恰 4 键**的 `RUNNING` ⇒ 客户端续轮询，
 * **下一轮（新预算）续做** —— 绝不因预算过小直接判死。
 * 说明写入失败 ⇒ 如实回**库内原状态**（不谎报 `RUNNING`；`SUBMITTED` / `RUNNING` 客户端都续轮询）。
 * @param {string} taskId 任务号
 * @param {object} row 已读到的任务行
 * @param {number} roundStartedAt 本轮起始时刻
 * @returns {Promise<object>} `RUNNING` 恰 4 键
 */
async function runningContinuation(taskId, row, roundStartedAt) {
  const leftSeconds = Math.round(Math.max(remainingRoundBudgetMs(roundStartedAt), 0) / 100) / 10
  const note = `本輪剩餘預算不足以開下一段（剩餘 ${leftSeconds} 秒）⇒ 本次未退款、未改終態；任務維持推進中，下一輪狀態查詢將續做。`
  try {
    await updateTaskRow(taskId, { status: TASK_STATUS.RUNNING, error_message: note, updated_at: nowIso() })
    return { ok: true, task_id: taskId, status: TASK_STATUS.RUNNING, upstream_status: Number(row.upstream_status) || 0 }
  } catch {
    /* 写入失败 ⇒ 回包给出库内原状态（不谎报）；`SUBMITTED` / `RUNNING` 客户端都续轮询。 */
    return { ok: true, task_id: taskId, status: text(row.status) || TASK_STATUS.RUNNING, upstream_status: Number(row.upstream_status) || 0 }
  }
}

/**
 * **单轮推进一次人工智能修復任务**（管理员面；**零扣费** —— 扣费只发生在 submit）。
 * 顺序：⓪ 管理员门（**第一行**）→ ① 载荷封闭恰一键 `task_id` → ② 读任务行（不存在 ⇒
 * `INVALID_VALUE`「該修復任務不存在」）→ ③ 终态回放（`READY` / `FAILED`：零上游零扣费）
 * → ④ 期限判定（已过 `deadline_at` ⇒ 退款置 `FAILED`）→ ⑤ 单查上游（单查 20 秒 ＋ 整轮剩余
 * 预算封顶）→ ⑥ 按状态分流：`pending` / `processing` ⇒ 置 `RUNNING`；`completed` ⇒ 下载
 * （25 秒 ＋ 剩余预算封顶）＋ 入册（45 秒段 ＋ 剩余预算封顶）⇒ 置 `READY`；`failed` /
 * `violation` ⇒ 退款置 `FAILED`；**整轮超预算（45 秒）⇒ 退款置 `FAILED`**；**开新一段前
 * 剩余预算 < 5 秒 ⇒ 不退款、不改终态，回 `RUNNING` 由下一轮续做**。
 * **退款只退一次**（行上 `refunded` 布尔为护栏 ＋ 账本幂等键双保险）。
 * @param {object} payload 载荷（封闭一键 `task_id`）
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<object>} `RUNNING` 恰 4 键 / `READY` 恰 6 键 / 失败（含 `FAILED`）恰 5 键
 */
async function statusEnhanceTask(payload, identity, context) {
  /* ⓪ 管理员门（既有单点；**第一行**，零读零写地拒）。 */
  const ops = opsModule()
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return statusFailure(identityDenial.reason, identityDenial.message, false, TASK_STATUS.FAILED)

  /* ① 载荷封闭恰一键（形态 → 未知键 → 缺 / 空键 → 值域；全部早于任何读写）。 */
  if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return statusFailure(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零扣費、零寫入。', false, TASK_STATUS.FAILED)
  }
  const unknown = Object.keys(payload).filter((key) => STATUS_ALLOWED_KEYS.indexOf(key) === -1)
  if (unknown.length > 0) {
    return statusFailure(
      REASONS.INVALID_FIELD,
      `載荷含未知欄位：${unknown.join('、')}（AI 修復狀態查詢入參封閉一鍵：task_id）；本次零扣費、零寫入。`,
      false,
      TASK_STATUS.FAILED
    )
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'task_id') || text(payload.task_id) === '') {
    return statusFailure(REASONS.MISSING_REQUIRED, '人工智能修復狀態查詢需要任務編號（task_id）；本次零扣費、零寫入。', false, TASK_STATUS.FAILED)
  }
  if (typeof payload.task_id !== 'string') {
    return statusFailure(REASONS.INVALID_VALUE, '任務編號（task_id）必須是字符串；本次零扣費、零寫入。', false, TASK_STATUS.FAILED)
  }
  const taskId = text(payload.task_id)

  /* ② 读任务行（不存在 ⇒ `INVALID_VALUE`，文案写明「該修復任務不存在」）。 */
  let row = null
  try {
    row = await readTaskRow(taskId)
  } catch (error) {
    return statusFailure(REASONS.STORAGE_UNAVAILABLE, `任務行讀取失敗（權威存儲不可用）；本次零扣費、零寫入，可稍後重試。（診斷：${diagnoseOf(error)}）`, false, TASK_STATUS.FAILED)
  }
  if (!row) {
    return statusFailure(REASONS.INVALID_VALUE, '該修復任務不存在；本次零扣費、零寫入、未調上游。', false, TASK_STATUS.FAILED)
  }

  /* ③ 终态回放（零上游、零扣费、零写入）。 */
  const current = text(row.status)
  if (current === TASK_STATUS.READY) return await readyReply(taskId, row)
  if (current === TASK_STATUS.FAILED) return failedReply(taskId, row)

  /* ④ 期限判定（已过 `deadline_at` ⇒ 退款置 `FAILED`；只退一次）。 */
  const deadlineAt = Date.parse(text(row.deadline_at))
  if (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
    return await failTask(
      taskId,
      row,
      REASONS.UPSTREAM_ERROR,
      `人工智能修復任務已過期限（deadline_at 已過）⇒ 已全額退回 ${AI_ENHANCE_COST} 金；可重新提交。`
    )
  }

  const upstreamTaskId = text(row.upstream_task_id)
  if (upstreamTaskId === '') {
    return statusFailure(
      REASONS.UPSTREAM_ERROR,
      '任務行缺少上游任務號（upstream_task_id）⇒ 無從查詢；本次未退款、未改狀態，可重新提交。',
      false,
      current
    )
  }

  /* ⑤ 上游配置（缺 ⇒ `CONFIG_MISSING`；**不退款不改状态** —— 任务仍可重试，期限兜底）。 */
  const aiUpstream = require('./aiUpstream.js')
  const upstream = await aiUpstream.resolveUpstreamSecret()
  if (!upstream || upstream.ok === false) {
    return statusFailure(
      (upstream && upstream.reason) || REASONS.CONFIG_MISSING,
      `${(upstream && upstream.message) || 'AI 上游未配置'}；本次未退款、未改狀態，可稍後重試。`,
      false,
      current
    )
  }

  const roundStartedAt = Date.now()
  const roundNote = () => `（本輪已用 ${Math.round((Date.now() - roundStartedAt) / 100) / 10} 秒）`

  /* ⑥ 单查上游（单查预算 20 秒 ＋ **整轮剩余预算封顶** —— 段预算与剩余预算取小者）。查询本身
     失败（超时 / 网络 / 坏 JSON / 非 2xx）⇒ **不退款不改状态**（状态未知 ⇒ 保持可重试；期限兜底），
     回结构化失败。 */
  const queried = await queryUpstreamTask(upstream, upstreamTaskId, remainingRoundBudgetMs(roundStartedAt))
  if (!queried.ok) {
    return statusFailure(queried.reason, `${queried.message}；本次未退款、未改狀態，可稍後重試。${roundNote()}`, false, current)
  }

  /* ⑥a `pending` / `processing` / 读不懂 ⇒ 行置 `RUNNING` 并回 `RUNNING`（恰 4 键）。 */
  if (queried.state !== 'completed' && queried.state !== 'failed' && queried.state !== 'violation') {
    if (current !== TASK_STATUS.RUNNING) {
      try {
        await updateTaskRow(taskId, { status: TASK_STATUS.RUNNING, updated_at: nowIso() })
      } catch (error) {
        return statusFailure(
          REASONS.STORAGE_UNAVAILABLE,
          `任務狀態寫入失敗（權威存儲不可用）；本次零扣費、零寫入，可稍後重試。（診斷：${diagnoseOf(error)}）`,
          false,
          current
        )
      }
    }
    return { ok: true, task_id: taskId, status: TASK_STATUS.RUNNING, upstream_status: Number(row.upstream_status) || 0 }
  }

  /* ⑥b 上游 `failed` / `violation` ⇒ 退款（只退一次）并置 `FAILED`（恰 5 键）。 */
  if (queried.state === 'failed' || queried.state === 'violation') {
    const errorText = queried.errorText
    const detail = errorText ? upstreamDetailOf(errorText) : '上游未給 error_msg'
    return await failTask(
      taskId,
      row,
      REASONS.UPSTREAM_ERROR,
      `上游修復任務失敗（狀態＝${queried.state}：${detail}）⇒ 已全額退回 ${AI_ENHANCE_COST} 金；可重新提交。`
    )
  }

  /* ⑥c `completed` ⇒ 同轮内下载 ＋ 入册。**每段开工前重查 `roundStartedAt`**：
     整轮预算已尽 ⇒ 走现有「整轮超预算」分支退款置 `FAILED`；
     剩余预算 < `STATUS_MIN_STEP_BUDGET_MS`（5 秒）⇒ **不退款、不改终态**，回 `RUNNING`
     让下一轮续做（绝不因预算过小直接判死）。 */
  if (remainingRoundBudgetMs(roundStartedAt) <= 0) {
    return await failTask(
      taskId,
      row,
      REASONS.UPSTREAM_ERROR,
      `人工智能修復任務單輪推進超過預算（${Math.round(STATUS_ROUND_BUDGET_MS / 1000)} 秒）⇒ 已全額退回 ${AI_ENHANCE_COST} 金；可重新提交。`
    )
  }
  const resultUrls = queried.resultUrls
  if (resultUrls.length === 0) {
    return await failTask(
      taskId,
      row,
      REASONS.UPSTREAM_ERROR,
      `上游任務已完成但缺 result_urls ⇒ 已全額退回 ${AI_ENHANCE_COST} 金；可重新提交。`
    )
  }
  /* 下载段（预算 25 秒）：**封顶 ＝ min(段预算, 整轮剩余)**（`downloadResultBytes` 内取小）。 */
  const beforeDownload = remainingRoundBudgetMs(roundStartedAt)
  if (beforeDownload < STATUS_MIN_STEP_BUDGET_MS) {
    return await runningContinuation(taskId, row, roundStartedAt)
  }
  let bytes = null
  try {
    const fetchImpl = resolveFetch()
    bytes = await downloadResultBytes(fetchImpl, resultUrls[0], beforeDownload)
  } catch {
    bytes = null
  }
  if (!bytes) {
    return await failTask(
      taskId,
      row,
      REASONS.UPSTREAM_ERROR,
      `取圖下載失敗 ⇒ 已全額退回 ${AI_ENHANCE_COST} 金；可重新提交。`
    )
  }
  /* 下载后重查（段间重查）：预算已尽 ⇒ 退款置 `FAILED`；仍不足 5 秒 ⇒ 回 `RUNNING` 续做。 */
  if (remainingRoundBudgetMs(roundStartedAt) <= 0) {
    return await failTask(
      taskId,
      row,
      REASONS.UPSTREAM_ERROR,
      `人工智能修復任務單輪推進超過預算（${Math.round(STATUS_ROUND_BUDGET_MS / 1000)} 秒）⇒ 已全額退回 ${AI_ENHANCE_COST} 金；可重新提交。`
    )
  }
  const beforeIngest = remainingRoundBudgetMs(roundStartedAt)
  if (beforeIngest < STATUS_MIN_STEP_BUDGET_MS) {
    return await runningContinuation(taskId, row, roundStartedAt)
  }

  /* 入册段（段预算 45 秒 ＋ **整轮剩余预算封顶**）：魔数判容器 → 内容寻址上传 → 影像行入册
     （`seq` 单点）。入册失败 ⇒ **不退款不改状态**（同 request_id 重放可自愈：影像行确定性幂等、
     任务行未动），回结构化失败；**整轮预算已尽 ⇒ 走现有超预算分支退款置 `FAILED`**
     （`refunded` 行上护栏 ＋ 账本幂等键 ⇒ 只退一次）；期限兜底会在超时后退款。 */
  const ingested = await registerProductImage({
    bytes,
    sealId: text(row.seal_id),
    sourceImageId: text(row.source_image_id),
    requestId: text(row.request_id),
    chargeBalanceAfter: Number(row.charge_balance_after) || 0,
    upstreamStatus: Number(row.upstream_status) || 0,
    elapsedMs: Date.now() - roundStartedAt,
    /* 段内绝对截止 ＝ min(入册段预算, 整轮预算) 自本轮起点计（两预算现同为 45 秒 ⇒ 同一时刻）。 */
    budgetDeadlineAt: roundStartedAt + Math.min(STATUS_INGEST_BUDGET_MS, STATUS_ROUND_BUDGET_MS)
  })
  if (!ingested.ok) {
    const overBudget = remainingRoundBudgetMs(roundStartedAt) <= 0 || Date.now() - roundStartedAt > STATUS_INGEST_BUDGET_MS
    if (overBudget) {
      return await failTask(
        taskId,
        row,
        ingested.reason,
        `${ingested.message}（入冊段超過 ${Math.round(STATUS_INGEST_BUDGET_MS / 1000)} 秒預算 ⇒ 已全額退回 ${AI_ENHANCE_COST} 金；可重新提交。）`
      )
    }
    return statusFailure(ingested.reason, `${ingested.message}${roundNote()}`, false, current)
  }

  /* 置 `READY` ＋ 记 `product_image_id` 与 `elapsed`（恰 6 键回包）。 */
  try {
    await updateTaskRow(taskId, {
      status: TASK_STATUS.READY,
      product_image_id: ingested.image_id,
      elapsed_ms: Number.isInteger(ingested.elapsed_ms) ? ingested.elapsed_ms : Date.now() - roundStartedAt,
      error_reason: '',
      error_message: '',
      updated_at: nowIso()
    })
  } catch (error) {
    /* 影像行已入册（确定性幂等）⇒ **不退款**：重放 status 只补任务行。 */
    return statusFailure(
      REASONS.STORAGE_UNAVAILABLE,
      `候選影像行已入册但任務行狀態寫入失敗（權威存儲不可用）⇒ 本次未退款；可重試本操作（同任務只入册一次）。（診斷：${diagnoseOf(error)}）`,
      false,
      current
    )
  }
  return await readyReply(taskId, Object.assign({}, row, {
    status: TASK_STATUS.READY,
    product_image_id: ingested.image_id,
    charge_amount: Number(row.charge_amount) || AI_ENHANCE_COST,
    charge_balance_after: Number(row.charge_balance_after) || 0
  }))
}

/* --------------------------------------------------------------------------- *
  op ③ · `ai-enhance-list`（只读）
 * --------------------------------------------------------------------------- */

/** 采纳判定：任一印面行的 `face_image_id` 命中，或任一 `EDGE` 行的 `edge_image_ids` 含该编号。 */
async function adoptedProductIds(productIds) {
  const ops = opsModule()
  const adopted = new Set()
  const pending = []
  for (const productId of productIds) {
    const hits = await ops.readRows(ops.COLLECTIONS.faces, { face_image_id: text(productId) }, { limit: FACE_REFERENCE_LIMIT })
    if (Array.isArray(hits) && hits.length > 0) adopted.add(text(productId))
    else pending.push(text(productId))
  }
  if (pending.length > 0) {
    const edgeRows = await ops.readRows(ops.COLLECTIONS.faces, { kind: 'EDGE' }, { limit: FACE_EDGE_SCAN_LIMIT })
    for (const row of Array.isArray(edgeRows) ? edgeRows : []) {
      const ids = Array.isArray(row && row.edge_image_ids) ? row.edge_image_ids : []
      for (const edgeId of ids) {
        const value = text(edgeId)
        if (pending.indexOf(value) !== -1) adopted.add(value)
      }
    }
  }
  return adopted
}

/** 行投影（**恰 6 键**；无值一律空串 —— 零内部字段、零 `plan`、零 `refunded`）。 */
function projectTaskRow(row) {
  return {
    task_id: text(row && (row._id !== undefined && row._id !== null ? row._id : row.id)),
    status: text(row && row.status),
    image_id: text(row && row.product_image_id),
    source_image_id: text(row && row.source_image_id),
    created_at: text(row && row.created_at),
    error_message: text(row && row.error_message)
  }
}

/**
 * **列出某印面下所有未采纳的候选任务**（管理员面；**只读、零扣费、零写入**）。
 * 顺序：⓪ 管理员门（**第一行**）→ ① 载荷封闭恰一键 `face_id` → ② 读任务行（「集合不存在」
 * 降级为空集；真存储故障 ⇒ 结构化失败，**不伪装成空集**）→ ③ 采纳过滤（`READY` 且产物影像已被
 * 任一印面引用者不回）→ ④ 按 `created_at` 倒序、最多 20 行 → ⑤ 回包恰 2 键。
 * @param {object} payload 载荷（封闭一键 `face_id`）
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<object>} 成功恰 2 键（`rows` 每行恰 6 键）/ 失败恰 3 键
 */
async function listEnhanceTasks(payload, identity, context) {
  /* ⓪ 管理员门（既有单点；**第一行**，零读零写地拒）。 */
  const ops = opsModule()
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return listFailure(identityDenial.reason, identityDenial.message)

  /* ① 载荷封闭恰一键（形态 → 未知键 → 缺 / 空键 → 值域）。 */
  if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return listFailure(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零讀取、零寫入。')
  }
  const unknown = Object.keys(payload).filter((key) => LIST_ALLOWED_KEYS.indexOf(key) === -1)
  if (unknown.length > 0) {
    return listFailure(
      REASONS.INVALID_FIELD,
      `載荷含未知欄位：${unknown.join('、')}（AI 修復候選清單入參封閉一鍵：face_id）；本次零讀取、零寫入。`
    )
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'face_id') || text(payload.face_id) === '') {
    return listFailure(REASONS.MISSING_REQUIRED, '人工智能修復候選清單需要印面編號（face_id）；本次零讀取、零寫入。')
  }
  if (typeof payload.face_id !== 'string') {
    return listFailure(REASONS.INVALID_VALUE, '印面編號（face_id）必須是字符串；本次零讀取、零寫入。')
  }
  const faceId = text(payload.face_id)

  /* ② 读任务行（「集合不存在」⇒ 空集；真存储故障 ⇒ 结构化失败）。 */
  let rows = []
  try {
    rows = await readTaskRowsByFace(faceId)
  } catch (error) {
    return listFailure(REASONS.STORAGE_UNAVAILABLE, `候選任務讀取失敗（權威存儲不可用）；本次零寫入，可稍後重試。（診斷：${diagnoseOf(error)}）`)
  }

  /* ③ 采纳过滤（只对 `READY` 且有产物影像的行做引用判定；引用读失败 ⇒ 结构化失败，不放行错结果）。 */
  const productIds = []
  for (const row of rows) {
    if (text(row && row.status) === TASK_STATUS.READY) {
      const productId = text(row && row.product_image_id)
      if (productId !== '' && productIds.indexOf(productId) === -1) productIds.push(productId)
    }
  }
  let adopted = new Set()
  if (productIds.length > 0) {
    try {
      adopted = await adoptedProductIds(productIds)
    } catch (error) {
      return listFailure(REASONS.STORAGE_UNAVAILABLE, `印面引用讀取失敗（權威存儲不可用）⇒ 無法判定採納狀態；本次零寫入，可稍後重試。（診斷：${diagnoseOf(error)}）`)
    }
  }

  /* ④ 未采纳过滤 → `created_at` 倒序（并列取 `_id` 字典序大者）→ 最多 20 行。 */
  const projected = rows
    .filter((row) => {
      if (text(row && row.status) !== TASK_STATUS.READY) return true
      const productId = text(row && row.product_image_id)
      return productId === '' || !adopted.has(productId)
    })
    .sort((left, right) => {
      const atLeft = text(left && left.created_at)
      const atRight = text(right && right.created_at)
      if (atLeft !== atRight) return atRight < atLeft ? -1 : 1
      const idLeft = text(left && (left._id !== undefined && left._id !== null ? left._id : left.id))
      const idRight = text(right && (right._id !== undefined && right._id !== null ? right._id : right.id))
      return idRight < idLeft ? -1 : 1
    })
    .slice(0, LIST_MAX_ROWS)
    .map(projectTaskRow)

  /* ⑤ 成功回包恰 2 键。 */
  return { ok: true, rows: projected }
}

/* --------------------------------------------------------------------------- *
  op ④ · 管理员运维两面（`ADMIN_OPS` 薄委派的**实现点**；本文件零第二套门 / 零新集合）
 *   · `probeAiUpstream`            —— 上游 `GET {base}/models` 连通探测：**零扣费、零写库**；
 *   · `repairOrphanEnhanceCharges` —— 孤儿扣费（`ref_id` ＝ `aiet-…` 却无任务行）补退款。
 * --------------------------------------------------------------------------- */

/** 探测载荷（**封闭恰零键** —— 目标 URL / 方法 / 次数一律服务端给定，客户端零入参）。 */
const PROBE_ALLOWED_KEYS = Object.freeze([])
/** 探测回包键面（**恰 5 键**）。 */
const PROBE_REPLY_KEYS = Object.freeze(['ok', 'http_status', 'elapsed_ms', 'error_class', 'base_host'])
/** 探测硬上限 **8 秒**（`withinBudget` ＝ `Promise.race`；到点即回、绝不拖到网关线）。 */
const PROBE_BUDGET_MS = 8000
/** `error_class` 值域（**封闭五值**；`OK` ＝ 2xx 到手）。 */
const PROBE_ERROR_CLASSES = Object.freeze(['OK', 'TIMEOUT', 'DNS', 'CONNECT', 'TLS', 'HTTP'])

/** 孤儿扣费修復载荷（**封闭恰二键**）。 */
const REPAIR_ORPHAN_ALLOWED_KEYS = Object.freeze(['dry_run', 'limit'])
/** `limit` 缺省 / 值域（1〜200）。 */
const REPAIR_ORPHAN_LIMIT_DEFAULT = 50
const REPAIR_ORPHAN_LIMIT_MAX = 200
/** 单次读 `CHARGE` 流水护栏（工程既有「limit ≤ 1000」惯例；超出存量由派单方调大常量分轮处理）。 */
const REPAIR_ORPHAN_SCAN_LIMIT = 1000
/** 孤儿行回包行面（**恰 3 键**；`amount` ＝ `Math.abs(delta)` —— 流水行**没有 `amount` 键**）。 */
const REPAIR_ORPHAN_ROW_KEYS = Object.freeze(['ref_id', 'idem_key', 'amount'])

/** 上游 `base_url` → **只回 host（可带端口）**；解析不了 ⇒ 空串（**零路径、零查询、零凭据**）。 */
function baseHostOf(baseUrl) {
  const raw = text(baseUrl)
  if (raw === '') return ''
  try {
    return new URL(raw).host
  } catch {
    return ''
  }
}

/**
 * 探测失败分类（**纯函数、零 I/O**；五值封闭 `TIMEOUT / TLS / DNS / CONNECT`，`OK` / `HTTP`
 * 由调用方按状态码给）。**零密钥、零完整路径、零响应体** —— 只吃错误对象的 name / code / message。
 * @param {any} error 上游 fetch 抛出的错误（或任何非 Response 的回值）
 * @returns {'TIMEOUT'|'DNS'|'CONNECT'|'TLS'}
 */
function probeErrorClassOf(error) {
  const name = text(error && error.name)
  const code = text(error && (error.code !== undefined && error.code !== null ? error.code : error.errCode))
  const message = text(error && error.message)
  const blob = `${name} ${code} ${message}`
  if (name === 'TimeoutError' || name === 'AbortError' || /ETIMEDOUT|CONNECT_TIMEOUT|timed?[ -]?out|timeout/i.test(blob)) {
    return 'TIMEOUT'
  }
  if (/ERR_TLS|ERR_SSL|EPROTO|CERT_[A-Z_]+|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED|TLS handshake|SSL routines/i.test(blob)) {
    return 'TLS'
  }
  if (/ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME|ENODATA|getaddrinfo|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_|network/i.test(blob)) {
    /* `EAI_*` ＝ DNS 解析族；`ECONN*` ＝ 连不上（连通层）⇒ 归 `CONNECT`。 */
    return /ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME|ENODATA|getaddrinfo|EAI_/.test(blob) ? 'DNS' : 'CONNECT'
  }
  return 'CONNECT'
}

/** 探测回包（**恰 5 键**；`error_class` 越值一律归 `CONNECT`，不把未知值漏出封闭值域）。 */
function probeReply(ok, httpStatus, elapsedMs, errorClass, baseHost) {
  return {
    ok: ok === true,
    http_status: Number.isInteger(httpStatus) ? httpStatus : 0,
    elapsed_ms: Number.isInteger(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0,
    error_class: PROBE_ERROR_CLASSES.indexOf(errorClass) === -1 ? 'CONNECT' : errorClass,
    base_host: text(baseHost)
  }
}

/**
 * **探测 AI 上游连通**（管理员面；**零扣费、零写库、零入参**）。
 * 顺序：⓪ 管理员门（**第一行**，零读零写地拒）→ ① 载荷封闭**恰零键** → ② 解上游配置
 * （缺 / `base_url` 非法 ⇒ 3 键拒绝面、**不发请求**）→ ③ 一次 `GET {base}/models`
 * （**硬上限 8 秒**：`withinBudget` ＝ `Promise.race` 到点即回，绝不等网关）→ ④ 回包**恰 5 键**
 * `ok / http_status / elapsed_ms / error_class / base_host`。
 * **零明文密钥**（认证头只在服务端内存流转）、**零完整路径**（只回 `host[:port]`）、
 * **零响应体**（不读 `body` / `json`，只看状态码）。
 * @param {object} payload 载荷（封闭恰零键；请传空对象 `{}`）
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<object>} 探测面恰 5 键 / 拒绝面恰 3 键（既有冻结 `reason`）
 */
async function probeAiUpstream(payload, identity, context) {
  /* ⓪ 管理员门（既有单点；**第一行**，零读零写地拒）。 */
  const ops = opsModule()
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ① 载荷封闭恰零键（未知键 ⇒ `INVALID_FIELD`；缺 / 非对象 ⇒ `MISSING_REQUIRED`）。 */
  if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload；探測入參封閉恰零鍵，請傳空物件）；本次零請求、零扣費、零寫入。')
  }
  const unknown = Object.keys(payload).filter((key) => PROBE_ALLOWED_KEYS.indexOf(key) === -1)
  if (unknown.length > 0) {
    return deny(
      REASONS.INVALID_FIELD,
      `載荷含未知欄位：${unknown.join('、')}（AI 上游連通探測入參封閉恰零鍵；目標、方法、次數一律由服務端給定）；本次零請求、零扣費、零寫入。`
    )
  }
  /* ② 解上游配置（缺 ⇒ 既有 `reason`；`base_url` 缺 / 非法 ⇒ `CONFIG_MISSING`；两者都**不发请求**）。 */
  const aiUpstream = require('./aiUpstream.js')
  const upstream = await aiUpstream.resolveUpstreamSecret()
  if (!upstream || upstream.ok === false) {
    return deny((upstream && upstream.reason) || REASONS.CONFIG_MISSING, `${(upstream && upstream.message) || 'AI 上游未配置'}；本次零請求、零扣費、零寫入。`)
  }
  const baseUrl = text(upstream.base_url)
  const baseHost = baseHostOf(baseUrl)
  if (baseUrl === '' || baseHost === '') {
    return deny(REASONS.CONFIG_MISSING, 'AI 上游 base_url 缺失或不是合法 URL ⇒ 無從探測；本次零請求、零扣費、零寫入。')
  }
  /* ③ 一次 `GET {base}/models`（**硬上限 8 秒**；到点即回、不等响应、不读响应体）。 */
  const startedAt = Date.now()
  const deadlineAt = startedAt + PROBE_BUDGET_MS
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  let outcome = null
  try {
    const fetchImpl = resolveFetch()
    outcome = await withinBudget(
      fetchImpl(url, { method: 'GET', headers: authHeadersOf(upstream), signal: AbortSignal.timeout(PROBE_BUDGET_MS) }),
      deadlineAt
    )
  } catch (error) {
    outcome = error
  }
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  /* ④ 到点 ⇒ `TIMEOUT`（零状态码）；有状态码 ⇒ `OK`（2xx）/ `HTTP`（非 2xx）；抛错 ⇒ 五值分类。 */
  if (outcome === BUDGET_EXPIRED) return probeReply(false, 0, elapsedMs, 'TIMEOUT', baseHost)
  const status = outcome && typeof outcome.status === 'number' ? Number(outcome.status) : null
  if (status === null) return probeReply(false, 0, elapsedMs, probeErrorClassOf(outcome), baseHost)
  const ok = status >= 200 && status < 300
  return probeReply(ok, status, elapsedMs, ok ? 'OK' : 'HTTP', baseHost)
}

/** 孤儿行投影（**恰 3 键**；`amount` ＝ `Math.abs(delta)` —— 流水行本身没有 `amount` 键）。 */
function projectOrphanChargeRow(row) {
  return {
    ref_id: text(row && row.ref_id),
    idem_key: text(row && row.idem_key),
    amount: Math.abs(Number(row && row.delta))
  }
}

/**
 * **补退孤儿扣费**（管理员面；`kind='CHARGE'` 且 `ref_id` 以 `aiet-` 开头的流水中：
 * `xiai_ai_enhance_tasks` **无该 `_id` 行** 且 该 `idem_key` **无 `REFUND` 流水** ⇒ 补退款）。
 * 顺序：⓪ 管理员门（**第一行**，零读零写地拒）→ ① 载荷封闭**恰二键**
 * `dry_run`（布林，**缺省 `true` ＝ 只读预览**）／ `limit`（1〜200 整数，**缺省 50**）
 * → ② 只读扫描（「集合不存在」按既有判据降级空集；真存储故障 ⇒ 结构化失败、不伪装）
 * → ③ 逐行判定（**有任务行 ⇒ 不选**；**已有 `REFUND` ⇒ 不选**；`delta` 非整数 ⇒ 不选 —— 不猜金额）
 * → ④ `dry_run:true` ⇒ **零写入**、回**恰 4 键** `ok / scanned / eligible / rows`；
 *    `dry_run:false` ⇒ 逐行 `ledger.refundPoints`（幂等键 ＝ 原 `idem_key` ＋ `-refund`、
 *    **必带 `ref_id`**）⇒ 回**恰 5 键** `ok / scanned / written / rows / failed`
 *    （`ok === (failed === 0)`；同键重放回 `idempotent:true` ⇒ **不计 `written` ⇒ 重跑 `written=0`**）。
 * **非 `aiet-` 前缀的流水一律不读不写**；`rows` 元素恒**恰 3 键** `ref_id / idem_key / amount`
 * 且条数 ≤ `limit`（`eligible` 仍报真实孤儿总数）；`reason` **零新增**、**零 `plan`**、**零新集合**。
 * @param {object} payload 载荷（封闭二键 `dry_run` / `limit`）
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<object>} dry_run 恰 4 键 / 真写恰 5 键 / 拒绝面恰 3 键
 */
async function repairOrphanEnhanceCharges(payload, identity, context) {
  /* ⓪ 管理员门（既有单点；**第一行**，零读零写地拒）。 */
  const ops = opsModule()
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ① 载荷封闭恰二键（形态 → 未知键 → 值域；全部早于任何读写）。 */
  if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
  }
  const unknown = Object.keys(payload).filter((key) => REPAIR_ORPHAN_ALLOWED_KEYS.indexOf(key) === -1)
  if (unknown.length > 0) {
    return deny(
      REASONS.INVALID_FIELD,
      `載荷含未知欄位：${unknown.join('、')}（AI 修復孤兒扣費補退入參封閉二鍵：dry_run / limit）；本次零寫入。`
    )
  }
  const dryRun = payload.dry_run === undefined ? true : payload.dry_run
  if (typeof dryRun !== 'boolean') {
    return deny(REASONS.INVALID_VALUE, 'dry_run 必須是布林值（缺省 true ＝ 只讀預覽）；本次零寫入。')
  }
  const limit = payload.limit === undefined ? REPAIR_ORPHAN_LIMIT_DEFAULT : payload.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > REPAIR_ORPHAN_LIMIT_MAX) {
    return deny(REASONS.INVALID_VALUE, `limit 必須是 1〜${REPAIR_ORPHAN_LIMIT_MAX} 之間的整數（缺省 ${REPAIR_ORPHAN_LIMIT_DEFAULT}）；本次零寫入。`)
  }
  /* ② 只读扫描 `CHARGE` 流水（「集合不存在」⇒ 空集；其余错误原样上抛为结构化失败）。 */
  const flowCollection = ops.ledger.LEDGER_COLLECTIONS.flow
  let chargeRows = []
  try {
    chargeRows = await ops.readRows(flowCollection, { kind: ops.ledger.FLOW_KINDS.CHARGE }, { limit: REPAIR_ORPHAN_SCAN_LIMIT })
  } catch (error) {
    if (!isCollectionNotExistError(error)) {
      return deny(REASONS.STORAGE_UNAVAILABLE, `積分流水讀取失敗（權威存儲不可用）；本次零寫入。（診斷：${diagnoseOf(error)}）`)
    }
    chargeRows = []
  }
  /* **范围收窄（先过滤再判定）**：`kind='CHARGE'` ∧ `ref_id` 以 `aiet-` 开头 —— 其余流水零接触。 */
  const scoped = (Array.isArray(chargeRows) ? chargeRows : []).filter(
    (row) => text(row && row.ref_id).indexOf(TASK_ID_PREFIX) === 0
  )
  /* ③ 逐行判定（有任务行 / 已有退款 / 金额不实 ⇒ 一律不选）。 */
  const eligible = []
  for (const row of scoped) {
    const refId = text(row.ref_id)
    const idemKey = text(row.idem_key)
    const delta = Number(row.delta)
    if (idemKey === '' || !Number.isInteger(delta) || delta === 0) continue
    const taskRow = await readTaskRow(refId)
    if (taskRow) continue /* 有任务行 ⇒ 不是孤儿（负对照：有行不选）。 */
    let refunds = []
    try {
      refunds = await ops.readRows(flowCollection, { idem_key: `${idemKey}${REFUND_IDEM_SUFFIX}` }, { limit: 1 })
    } catch (error) {
      if (!isCollectionNotExistError(error)) {
        return deny(REASONS.STORAGE_UNAVAILABLE, `積分流水讀取失敗（權威存儲不可用）；本次零寫入。（診斷：${diagnoseOf(error)}）`)
      }
      refunds = []
    }
    if (Array.isArray(refunds) && refunds.length > 0) continue /* 已有 `REFUND` ⇒ 不重复退。 */
    eligible.push({ row, refId, idemKey, amount: Math.abs(delta) })
  }
  /* ④a `dry_run` ⇒ **零写入**、恰 4 键（`rows` ≤ `limit`、`eligible` 报真实总数）。 */
  if (dryRun) {
    return {
      ok: true,
      scanned: scoped.length,
      eligible: eligible.length,
      rows: eligible.slice(0, limit).map((item) => projectOrphanChargeRow({ ref_id: item.refId, idem_key: item.idemKey, delta: item.row.delta }))
    }
  }
  /* ④b 真写：逐行补退款（幂等键 ＝ 原 `idem_key` ＋ `-refund`、`ref_id` 必带）⇒ 恰 5 键。 */
  const rows = []
  let written = 0
  let failed = 0
  for (const item of eligible.slice(0, limit)) {
    try {
      const refunded = await ops.ledger.refundPoints({
        uid: text(item.row.uid),
        amount: item.amount,
        kind: ops.ledger.FLOW_KINDS.REFUND,
        ref_type: text(item.row.ref_type) || aiEnhance.REF_TYPE_AI_IMAGE,
        ref_id: item.refId,
        idem_key: `${item.idemKey}${REFUND_IDEM_SUFFIX}`
      })
      /* 同键重放 ⇒ 账本回 `idempotent:true` ⇒ **本轮零新写**（重跑 `written=0`）。 */
      if (!refunded || refunded.ok !== true) {
        failed += 1
        continue
      }
      if (refunded.idempotent === true) continue
      written += 1
      rows.push({ ref_id: item.refId, idem_key: item.idemKey, amount: item.amount })
    } catch {
      /* 单行退款失败 ⇒ 如实计 `failed`（不中断整批、不吞成成功）。 */
      failed += 1
    }
  }
  return { ok: failed === 0, scanned: scoped.length, written, rows, failed }
}

module.exports = {
  AI_ENHANCE_SUBMIT_OP,
  AI_ENHANCE_STATUS_OP,
  AI_ENHANCE_LIST_OP,
  AI_ENHANCE_TASKS_COLLECTION,
  AI_ENHANCE_COST,
  TASK_ID_PREFIX,
  TASK_STATUS,
  TASK_DEADLINE_MS,
  REQUEST_ID_PATTERN,
  SUBMIT_ALLOWED_KEYS,
  STATUS_ALLOWED_KEYS,
  LIST_ALLOWED_KEYS,
  SUBMIT_SUCCESS_KEYS,
  SUBMIT_FAILURE_KEYS,
  STATUS_RUNNING_KEYS,
  STATUS_READY_KEYS,
  STATUS_FAILED_KEYS,
  LIST_SUCCESS_KEYS,
  LIST_FAILURE_KEYS,
  LIST_ROW_KEYS,
  SUBMIT_POST_BUDGET_MS,
  SUBMIT_CLEANUP_GRACE_MS,
  CHARGE_STATE,
  STATUS_QUERY_BUDGET_MS,
  STATUS_DOWNLOAD_BUDGET_MS,
  STATUS_INGEST_BUDGET_MS,
  STATUS_ROUND_BUDGET_MS,
  LIST_MAX_ROWS,
  /* **管理员运维两面（本单新增）**：键面 / 值域 / 预算常量 ＋ 实现点（供离线自检直接断言）。 */
  PROBE_ALLOWED_KEYS,
  PROBE_REPLY_KEYS,
  PROBE_BUDGET_MS,
  PROBE_ERROR_CLASSES,
  REPAIR_ORPHAN_ALLOWED_KEYS,
  REPAIR_ORPHAN_LIMIT_DEFAULT,
  REPAIR_ORPHAN_LIMIT_MAX,
  REPAIR_ORPHAN_ROW_KEYS,
  chargeStateOf,
  setTaskFetchProvider,
  taskFetchInjected,
  taskIdOf,
  projectTaskRow,
  submitEnhanceTask,
  statusEnhanceTask,
  listEnhanceTasks,
  probeAiUpstream,
  repairOrphanEnhanceCharges
}
