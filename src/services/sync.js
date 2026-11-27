/**
 * 玺爱 · **斐萃 → 玺爱 同步审阅服务**（`services/sync.js`｜本单新增）
 * ============================================================================
 * 背景（Kevin 2026-11-26 裁定）：feicui 影子库与 xiai 比对后，「feicui 领先 xiai」的部分
 * 要引导用户到 xiai web 审阅；**审阅口复用 `/my/corrections` 纠错流**（不新建 `/admin/sync`）。
 * **本期实体只 `books` / `persons` / `publishers`**（第四实体不在本单，见 `SYNC_ENTITIES`）。
 *
 * 本文件是前端**唯一**的同步审阅入口（`MyCorrectionsView.vue` 只经本服务，不直碰 `data/*`、
 * 不直调云函数）：
 *   · `listToXiai({entity, limit, cursor})` —— **只读**列出「feicui → xiai」差异
 *     （op ＝ `listDiff`，`direction` 恒 `'to-xiai'`；再经 `listQueue` 只读对齐**入队时间 /
 *     状态 / queue_id** —— 队列行是这三个读数的唯一真源，差异项本身不带它们）；
 *   · `approve(queueId)`   —— `approveQueue`（**载荷只带 `queue_id`**，逐项）；
 *   · `applyUp(queueId)`   —— `applyUp`（`to-xiai` 上行写入 xiai，单 `queue_id`）；
 *   · `reject(queueId)`    —— `rejectQueue`（单 `queue_id`）；
 *   · `approveAndApply(id, options)`—— 【通过并写入】两步编排：**任一步失败即停**，结构化
 *     reason 原样上抛；`options.currentStatus` ＝ 调用方读到的行状态（幂等判据输入，
 *     `CONFLICT` ＋ 该项已写入 ⇒ **幂等成功**、零 `applyUp`）；
 *   · `nextSyncRow(row, result)` —— **纯函数**的本地状态推进（失败 ⇒ 本地状态**逐字不变**）；
 *   · `canApproveSyncRow(row)` / `partitionSyncRows(rows)` —— **纯函数**状态门：
 *     只有 `PENDING` 行可动作（按钮按状态收窄的判据单点）；按状态分流 `{pending, settled}`
 *     （保序、不改原数组；「僅顯示待審」开关用）；
 *   · `canReviewSync()`    —— 审阅段的渲染门（**判权单点 ＝ `session.js::isAdmin`**）；
 *   · `parseSyncDeepLink(query)` —— 深链 `?from=feicui&entity=<books|persons|publishers>&key=<业务键>` 解析。
 *
 * 硬口径（逐条）：
 *   · **回包恒四键 `{ok, reason, msg, item}`**（成功 `reason:''`、失败 `msg` 带可读原因）；
 *     **不吞错** —— 服务端 / 传输层的 `reason` 原样透传，异常一律折成 `STORAGE_UNAVAILABLE`
 *     （**绝不伪装 `FORBIDDEN`**、绝不拿空集冒充成功）；
 *   · **逐项、不批量**：`approve` / `applyUp` / `reject` 的载荷**只收单个 `queue_id`**
 *     （数组 / 非串 / 空串 ⇒ `INVALID_VALUE` ＋ **零请求**）；本文件**没有**任何批量直通口
 *     （Kevin 红线：可批量列出、不许批量直通 —— 批量只有只读的 `listDiff` / `listQueue`）；
 *   · **零新云函数、零改 `cloudfunctions/`**：走既有 cloudbase 调用层
 *     `data/cloudbaseFn.js::callCloudFunction` 打同步面 op 通道（函数名 `feicui-shadow`，
 *     与 feicui 侧 `cloudfunctions/feicui-shadow` 同一个；本仓只消费、不改其部署态）；
 *   · **凭据**：同步面 op 是 **device + admin** 通道 ⇒ 复用既有签发面
 *     `services/feicui.js::issueDeviceToken()`（同 `SHADOW_TOKEN_SECRET` 的斐萃设备令牌，
 *     体字段 `deviceToken` 携带；**只存内存、零持久化、不进 URL、不打日志**）；
 *   · **客户端 admin 门只是前置短路**（省一次必然被拒的往返）：服务端 role 判定才是唯一判据；
 *   · **本期实体封闭**：`entity` 不在 `SYNC_ENTITIES` ⇒ `INVALID_VALUE` ＋ 零请求；
 *     列表结果里非本期实体的行**一律不进审阅表**（第四实体不在本单）。
 *
 * @module services/sync
 */

import { isAdmin } from '../data/session.js'
/* **同步面 op 通道**（既有 cloudbase 调用层；**不新建云函数**）。 */
import { callCloudFunction } from '../data/cloudbaseFn.js'
/* **设备令牌签发**（既有单点；本文件不自造第二套凭据通道）。 */
import { issueDeviceToken } from './feicui.js'

/* --------------------------------------------------------------------------- 常量 */

/** 同步面云函数名（与 feicui 侧 `cloudfunctions/feicui-shadow` 逐字同值）。 */
export const SYNC_FUNCTION_NAME = 'feicui-shadow'

/** 本单唯一方向：feicui 领先 ⇒ 待写入 xiai（`to-feicui` 下行不在本期审阅口）。 */
export const SYNC_DIRECTION = 'to-xiai'

/** **本期实体封闭三值**（Kevin 裁定：本期只 books / persons / publishers）。 */
export const SYNC_ENTITIES = Object.freeze(['books', 'persons', 'publishers'])

/* ---------------------------------------------------------------------------
   **实体名单/复数归一（跨边界必过这里）**
   ---------------------------------------------------------------------------
   云端 `feicui-shadow` 的 `listDiff` / `listQueue` 回的是**单数**（`book` / `person` /
   `publisher`，与云端 `SYNC_ENTITIES` 同源），而本单的键面是**复数**（`books` /
   `persons` / `publishers`）；斐萃侧深链历史上一度也写单数（`entity=book`）。
   实测（2026-11-27 真机）：审阅表「空着、零提示」——根因就是云端回的 `entity:'book'`
   被本文件的复数白名单`SYNC_ENTITIES.indexOf(name) === -1`**整行丢掉**（既不是 0 条数据，
   也不是权限，是名字对不上）。
   ⇒ **任何调用点都不得手写单/复数**：入参先 `syncEntityKeyOf`（→ 复数键），
   递云端前 `syncEntityCloudOf`（→ 单数）。 */
const ENTITY_CLOUD_OF = Object.freeze({ books: 'book', persons: 'person', publishers: 'publisher' })
const ENTITY_PLURAL_OF = Object.freeze({ book: 'books', person: 'persons', publisher: 'publishers' })

/**
 * 任意形态的实体名 → **本单复数键**（不在三值内 ⇒ 空串，调用方据此拒/跳）。
 * @param {unknown} raw `book` / `books` / `person` / …
 * @returns {string} `books` | `persons` | `publishers` | ''
 */
export function syncEntityKeyOf(raw) {
  const value = text(raw)
  if (SYNC_ENTITIES.indexOf(value) >= 0) return value
  return ENTITY_PLURAL_OF[value] || ''
}

/**
 * 本单实体键 → **云端单数名**（`listDiff` / `listQueue` 的 `entity` 入参）。
 * @param {unknown} raw
 * @returns {string} `book` | `person` | `publisher` | ''
 */
export function syncEntityCloudOf(raw) {
  const key = syncEntityKeyOf(raw)
  return key === '' ? '' : ENTITY_CLOUD_OF[key] || key
}

/** op 名（与同步面注册面逐字一致；**视图 / 组件不得另写 op 名字面值**）。 */
export const SYNC_OP = Object.freeze({
  listDiff: 'listDiff',
  listQueue: 'listQueue',
  approve: 'approveQueue',
  applyUp: 'applyUp',
  reject: 'rejectQueue'
})

/** 云队列状态值（冻结六态）。 */
export const SYNC_QUEUE_STATUS = Object.freeze([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'APPLIED',
  'FAILED',
  'CONFLICT'
])

/**
 * **唯一可动作状态**：六态里只有 `PENDING` 允许【通過並寫入】/【駁回】。
 * 已落定行（APPROVED · REJECTED · APPLIED · FAILED · CONFLICT）一律不可动作 ——
 * 对它们发写请求只会被服务端 CAS 门按「状态 ≠ PENDING」拒（`CONFLICT`，零写入）。
 */
export const SYNC_ACTIONABLE_STATUS = 'PENDING'

/** 深链标记值（feicui 侧生成 `?from=feicui&entity=…&key=…`）。 */
export const SYNC_DEEP_LINK_FROM = 'feicui'

/** `listDiff` 分页缺省 / 上限（同步面 `readLimit` 上限 ＝ 200；超上限服务端判 `INVALID_VALUE`）。 */
export const SYNC_LIMIT_DEFAULT = 50
export const SYNC_LIMIT_MAX = 200

/** `listQueue` 上限（同 200；它是**只读批量列出**，不是批量直通）。 */
export const SYNC_QUEUE_LIMIT = 200

/* --------------------------------------------------------------------------- 结果形态 */

/** 失败（恒四键；`item` 缺省 `null`）。 */
function fail(reason, msg, item) {
  return { ok: false, reason: String(reason || 'STORAGE_UNAVAILABLE'), msg: String(msg || ''), item: item === undefined ? null : item }
}

/** 成功（恒四键；`reason` 恒空串）。 */
function done(msg, item) {
  return { ok: true, reason: '', msg: String(msg || ''), item: item === undefined ? null : item }
}

/** 各 op 成功时的缺省上屏文案（服务端成功回包通常不带 `message`）。 */
const SUCCESS_MSG = Object.freeze({
  listDiff: '已取回斐萃待審變更。',
  listQueue: '已取回同步隊列。',
  approveQueue: '已通過（待寫入）。',
  applyUp: '已寫入 xiai。',
  rejectQueue: '已駁回。'
})

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

/* --------------------------------------------------------------------------- 判权与通道缝 */

/**
 * 审阅段渲染门（**判权单点 ＝ `data/session.js::isAdmin`**；本文件不自造第二套 role 判定）。
 * 非管理员 ⇒ `false` ⇒ 页面 `v-if` 恒 false ⇒ DOM 零命中（**不以 CSS 隐藏冒充**）。
 * @returns {boolean}
 */
export function canReviewSync() {
  return isAdmin.value === true
}

/** 传输注入缝（离线自检用；生产恒 `null` ⇒ 走真实 `callCloudFunction`）。 */
let transportOverride = null

/**
 * 注入 / 卸载传输（**只给离线自检**）：注入后**跳过设备令牌签发**（零网络），
 * 事件形态与真实路径逐字相同 ⇒ 自检判的是「服务层真发了什么」。
 * @param {Function|null} fn `(event) => Promise<reply>`；`null` ＝ 卸载
 */
export function setSyncTransport(fn) {
  transportOverride = typeof fn === 'function' ? fn : null
}

/** 卸载传输注入（回到真实通道）。 */
export function resetSyncTransport() {
  transportOverride = null
}

/** 传输诊断读数（**不含任何令牌**）。 */
export function syncTransportStatus() {
  return { injected: transportOverride !== null, function: SYNC_FUNCTION_NAME }
}

/* --------------------------------------------------------------------------- 凭据（内存态） */

/** 设备令牌内存缓存（**零持久化**：刷新即重取，与既有纪律一致）。 */
let deviceTokenCache = null

/** 清缓存（登出 / 令牌被拒时调用）。 */
export function clearSyncDeviceToken() {
  deviceTokenCache = null
}

/**
 * 取一枚可携带的斐萃设备令牌（同步面 `deviceToken` 体字段）。
 * 已缓存且未过期（留 60 秒余量）⇒ 零往返；否则经既有签发面 `issueDeviceToken()` 取。
 * 失败 ⇒ 结构化拒绝（**原样透传**取票侧 `{reason, message}`，不伪装、不编令牌）。
 * @returns {Promise<{ok:true, token:string}|{ok:false, reason:string, msg:string}>}
 */
async function syncDeviceToken() {
  if (deviceTokenCache && Number.isFinite(Date.parse(deviceTokenCache.expires_at))) {
    if (Date.parse(deviceTokenCache.expires_at) - Date.now() > 60000) {
      return { ok: true, token: deviceTokenCache.token }
    }
  }
  let issued = null
  try {
    issued = await issueDeviceToken()
  } catch (error) {
    return fail('STORAGE_UNAVAILABLE', `斐萃設備令牌取票異常：${(error && error.message) || '未知錯誤'}；本次零寫入。`)
  }
  if (!issued || issued.ok !== true) {
    return fail(
      (issued && issued.reason) || 'STORAGE_UNAVAILABLE',
      (issued && issued.message) || '斐萃設備令牌取票失敗；同步審閱不可用，本次零寫入。'
    )
  }
  const token = text(issued.token)
  if (token === '') {
    return fail('STORAGE_UNAVAILABLE', '斐萃設備令牌回包形狀不可辨識（無令牌）；本次零寫入。')
  }
  deviceTokenCache = { token, expires_at: text(issued.expires_at) }
  return { ok: true, token }
}

/* --------------------------------------------------------------------------- 单点请求 */

/** 回包归一（服务端拒绝 / 传输层失败 / 形状不可辨识，三路分别如实回）。 */
function normalizeReply(op, reply) {
  if (!reply || typeof reply !== 'object') {
    return fail('STORAGE_UNAVAILABLE', `同步面回包不可辨識（${op}）；本次零寫入。`)
  }
  /* 传输层拒绝（`callCloudFunction` 的 `{ok:false, reason, message}`）⇒ 原样透传。 */
  if (reply.ok === false && typeof reply.reason === 'string') {
    return fail(reply.reason, reply.message || '同步面請求被拒；本次零寫入。')
  }
  const body = Object.prototype.hasOwnProperty.call(reply, 'result') ? reply.result : reply
  if (!body || typeof body !== 'object') {
    return fail('STORAGE_UNAVAILABLE', `同步面回包缺業務體（${op}）；本次零寫入。`)
  }
  if (body.ok === false) {
    return fail(typeof body.reason === 'string' ? body.reason : 'STORAGE_UNAVAILABLE', body.message || '同步面拒絕；本次零寫入。')
  }
  if (body.ok !== true) {
    return fail('STORAGE_UNAVAILABLE', `同步面回包缺 ok:true（${op}）；本次零寫入。`)
  }
  return done(body.message || SUCCESS_MSG[op] || '已完成。', body)
}

/**
 * **同步面 op 请求单点**（服务层函数一律经它；视图不直调）。
 *
 * 信封逐字 `{action: op, payload, deviceToken?}` —— `action` 是 op 名、业务载荷只在 `payload`
 * （与同步面 `main()` 的读法一致）；`deviceToken` 只在**非空**时落键（注入缝下零凭据）。
 * @param {string} op op 名（见 `SYNC_OP`）
 * @param {object} payload 业务载荷
 * @returns {Promise<{ok:boolean, reason:string, msg:string, item:object|null}>}
 */
export async function request(op, payload) {
  if (!canReviewSync()) {
    return fail('FORBIDDEN', '僅管理員可以審閱斐萃同步變更；本次零寫入。')
  }
  const name = text(op)
  if (name === '') {
    return fail('INVALID_VALUE', 'op 名必須是非空字串；本次零寫入。')
  }
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}

  let token = ''
  if (transportOverride === null) {
    const credential = await syncDeviceToken()
    if (credential.ok !== true) return fail(credential.reason, credential.msg)
    token = credential.token
  }
  const event = { action: name, payload: body }
  if (token !== '') event.deviceToken = token

  let reply = null
  try {
    reply = transportOverride ? await transportOverride(event) : await callCloudFunction(SYNC_FUNCTION_NAME, event)
  } catch (error) {
    return fail('STORAGE_UNAVAILABLE', `同步面請求失敗（${name}）：${(error && error.message) || '未知錯誤'}；本次零寫入。`)
  }
  return normalizeReply(name, reply)
}

/* --------------------------------------------------------------------------- 读面 */

/** 单个 `queue_id` 归一（**逐项**：非串 / 空串 / 数组 ⇒ `null`，调用方零请求）。 */
function singleQueueId(queueId) {
  if (typeof queueId !== 'string') return null
  const id = queueId.trim()
  return id === '' ? null : id
}

/** `limit` 归一（非整数 / 越界 ⇒ `null`，**不静默夹取**）。 */
function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return SYNC_LIMIT_DEFAULT
  const num = Number(value)
  if (!Number.isInteger(num) || num < 1 || num > SYNC_LIMIT_MAX) return null
  return num
}

/** 差异项 → 审阅行（**列面**：实体 / 业务键 / 操作 / 差异字段数 / 入队时间 / 状态）。 */
function rowOf(diff, queueRow) {
  const changed = Array.isArray(diff.changed) ? diff.changed.map((key) => text(key)).filter((key) => key !== '') : []
  const after = diff.after && typeof diff.after === 'object' && !Array.isArray(diff.after) ? diff.after : {}
  const queued = queueRow && typeof queueRow === 'object' ? queueRow : null
  return {
    /* `queue_id` 只认**队列行**（差异项不带它；没有队列行 ⇒ 空串 ⇒ 逐项按钮禁用并如实提示）。 */
    queue_id: queued ? text(queued._id) : '',
    entity: text(diff.entity),
    key: text(diff.subject),
    subject_id: queued ? text(queued.subject_id) : text(diff.subject),
    op: text(diff.op),
    diff_count: changed.length > 0 ? changed.length : Object.keys(after).length,
    changed,
    queued_at: queued ? text(queued.requested_at) : '',
    status: queued ? text(queued.status) : ''
  }
}

/**
 * **列出「斐萃领先」的待审变更**（只读；op ＝ `listDiff`，`direction` 恒 `to-xiai`）。
 *
 * 两段只读：① `listDiff` 出差异项；② `listQueue`（**只读批量列出**，不是批量直通）对齐
 * `queue_id` / 入队时间 / 状态 —— 差异项本身没有这三个读数，**不编造**。
 * ②失败 ⇒ ①照常返回，行的 `queue_id` / `queued_at` / `status` 留空、`msg` 如实说明
 * （**不以空状态冒充「未入队」的成功读数**）。非本期实体的行一律剔除。
 *
 * @param {{entity?:string, limit?:number, cursor?:string}} [options]
 * @returns {Promise<{ok:boolean, reason:string, msg:string,
 *   item:{items:Array, count:number, next_cursor:string, queue_ok:boolean}|null}>}
 */
export async function listToXiai(options) {
  const opts = options && typeof options === 'object' ? options : {}
  const rawEntity = text(opts.entity)
  /* 单/复数都认（历史深链写单数），但**一律归一成本单复数键**；递云端时再换单数。 */
  const entity = rawEntity === '' ? '' : syncEntityKeyOf(rawEntity)
  if (rawEntity !== '' && entity === '') {
    return fail('INVALID_VALUE', `entity 只接受 ${SYNC_ENTITIES.join(' / ')}（本期三實體）；本次零寫入。`)
  }
  const limit = normalizeLimit(opts.limit)
  if (limit === null) {
    return fail('INVALID_VALUE', `limit 必須是 1〜${SYNC_LIMIT_MAX} 的整數；本次零寫入。`)
  }
  const cursor = text(opts.cursor)

  const payload = { direction: SYNC_DIRECTION, limit }
  /* 云端只认单数（`book` / `person` / `publisher`）⇒ 这里必须换形，否则恒 `INVALID_VALUE`。 */
  if (entity !== '') payload.entity = syncEntityCloudOf(entity)
  if (cursor !== '') payload.cursor = cursor

  const listed = await request(SYNC_OP.listDiff, payload)
  if (listed.ok !== true) return listed
  const body = listed.item && typeof listed.item === 'object' ? listed.item : {}
  const rawItems = Array.isArray(body.items) ? body.items : []

  const queued = await request(SYNC_OP.listQueue, { direction: SYNC_DIRECTION, limit: SYNC_QUEUE_LIMIT })
  const queueByKey = new Map()
  if (queued.ok === true && queued.item && Array.isArray(queued.item.items)) {
    queued.item.items.forEach((row) => {
      if (!row || typeof row !== 'object') return
      /* 队列行同样是**单数** ⇒ 归一后再建键，否则永远配不上差异行。 */
      queueByKey.set(`${syncEntityKeyOf(row.entity)}|${text(row.subject_id)}`, row)
    })
  }

  const rows = []
  rawItems.forEach((diff) => {
    if (!diff || typeof diff !== 'object') return
    /* **本期实体封闭**：第四实体不进审阅表；云端回的是**单数**，先归一再判。 */
    const name = syncEntityKeyOf(diff.entity)
    if (name === '') return
    /* 列面上统一成**本单复数键**（`books` / `persons` / `publishers`）：云端给的是单数，
       若原样上屏，实体标签与深链会两套名字并存。 */
    rows.push(rowOf({ ...diff, entity: name }, queueByKey.get(`${name}|${text(diff.subject)}`) || null))
  })

  const msg =
    queued.ok === true
      ? listed.msg
      : `${listed.msg}；隊列狀態未取回（${queued.reason}）：queue_id / 入隊時間 / 狀態留空，不編造。`
  return done(msg, {
    items: rows,
    count: rows.length,
    next_cursor: text(body.next_cursor),
    queue_ok: queued.ok === true,
    queue_count: queued.ok === true && queued.item ? Number(queued.item.count) || 0 : 0
  })
}

/* --------------------------------------------------------------------------- 写面（逐项） */

/**
 * **通过**（`approveQueue`｜载荷**只带 `queue_id`**，逐项；数组 / 非串 / 空串 ⇒ 零请求）。
 * @param {string} queueId
 * @returns {Promise<{ok:boolean, reason:string, msg:string, item:object|null}>}
 */
export async function approve(queueId) {
  const id = singleQueueId(queueId)
  if (id === null) {
    return fail('INVALID_VALUE', 'queue_id 必須是單一字串（逐項通過，不收數組、不夾帶業務資料）；本次零寫入。')
  }
  return request(SYNC_OP.approve, { queue_id: id })
}

/**
 * **写入 xiai**（`applyUp`｜`to-xiai` 上行；单 `queue_id`）。
 * @param {string} queueId
 * @returns {Promise<{ok:boolean, reason:string, msg:string, item:object|null}>}
 */
export async function applyUp(queueId) {
  const id = singleQueueId(queueId)
  if (id === null) {
    return fail('INVALID_VALUE', 'queue_id 必須是單一字串（逐項寫入，不收數組、不夾帶業務資料）；本次零寫入。')
  }
  return request(SYNC_OP.applyUp, { queue_id: id })
}

/**
 * **驳回**（`rejectQueue`｜单 `queue_id`；`reason` 不在本单载荷面内 ⇒ 只发 `queue_id`）。
 * @param {string} queueId
 * @returns {Promise<{ok:boolean, reason:string, msg:string, item:object|null}>}
 */
export async function reject(queueId) {
  const id = singleQueueId(queueId)
  if (id === null) {
    return fail('INVALID_VALUE', 'queue_id 必須是單一字串（逐項駁回，不收數組、不夾帶業務資料）；本次零寫入。')
  }
  return request(SYNC_OP.reject, { queue_id: id })
}

/**
 * **幂等判据（纯函数）**：`approve` 回 `CONFLICT` 且该项**其实已经写入** ⇒ 视作成功。
 * 真因（2026-11-28 生产现场）：用户点到一条早已 `APPLIED` 的行 ⇒ 服务端 CAS 门
 * （状态 ≠ `PENDING` 即拒、零写入）回 `CONFLICT`，而这不是失败 —— 项已经写过了。
 *  · 调用方给了 `options.currentStatus` ⇒ **以它为准**：`'APPLIED'` ⇒ 幂等；
 *    其它状态（如 `PENDING`）⇒ 真冲突，**不因 `msg` 字样放宽**；
 *  · 未给状态（无 `options` / `currentStatus` 非串或空）⇒ 退服务端读数：
 *    `msg` 含 `APPLIED` ⇒ 幂等；否则照旧失败。
 * **只认 `reason === 'CONFLICT'`**（其它 reason 即便状态是 APPLIED 也原样失败）。
 * @param {object|undefined} options `approveAndApply` 的可选参
 * @param {{reason:string, msg:string}} approved `approve` 步的结果
 * @returns {boolean}
 */
function isAlreadyApplied(options, approved) {
  if (!approved || approved.reason !== 'CONFLICT') return false
  const opts = options && typeof options === 'object' ? options : null
  const stated = opts && typeof opts.currentStatus === 'string' ? opts.currentStatus.trim() : ''
  if (stated !== '') return stated === 'APPLIED'
  return text(approved.msg).includes('APPLIED')
}

/**
 * **【通过并写入】两步编排**（`approveQueue` → `applyUp`）。
 * **任一步失败即停**并结构化上抛（`reason` ＝ 该步服务端 reason，`msg` 写明卡在哪一步），
 * **绝不**在 `applyUp` 失败后回 `ok:true`、也绝不把失败折成成功文案。
 *
 * **幂等例外（本单新增）**：`approve` 回 `CONFLICT` 且该项已写入（见 `isAlreadyApplied`）
 * ⇒ **幂等成功** `ok:true` ＋ `item.idempotent === true` ＋ `item.status === 'APPLIED'`，
 * **零 `applyUp`（只发一次 `approveQueue`）**、不重复写；其余 `CONFLICT` / 其它 `reason`
 * 仍原样失败（文案与 reason **一字不改**）。
 * @param {string} queueId
 * @param {{currentStatus?:string}} [options] 本行读到的队列状态（幂等判据的调用方读数）
 * @returns {Promise<{ok:boolean, reason:string, msg:string, item:{stage:string, queue_id:string, status:string, idempotent?:boolean}|null}>}
 */
export async function approveAndApply(queueId, options) {
  const id = singleQueueId(queueId)
  if (id === null) {
    return fail('INVALID_VALUE', 'queue_id 必須是單一字串（逐項通過，不收數組、不夾帶業務資料）；本次零寫入。')
  }
  const approved = await approve(id)
  if (approved.ok !== true) {
    /* **已写入 ⇒ 幂等成功**（停在 approve 步、零 `applyUp`、零重复写）。 */
    if (isAlreadyApplied(options, approved)) {
      return done('該項已寫入（無需重複操作）；本次未重複寫入。', {
        stage: 'done',
        queue_id: id,
        status: 'APPLIED',
        idempotent: true
      })
    }
    return fail(approved.reason, `通過失敗：${approved.msg}`, { stage: 'approve', queue_id: id, status: 'PENDING' })
  }
  const applied = await applyUp(id)
  if (applied.ok !== true) {
    return fail(applied.reason, `已通過但寫入失敗：${applied.msg}`, { stage: 'applyUp', queue_id: id, status: 'APPROVED' })
  }
  return done(applied.msg, { stage: 'done', queue_id: id, status: 'APPLIED' })
}

/**
 * **本地状态推进（纯函数）**：只有 `ok:true` 才改行；**失败 ⇒ 返回原行（逐字不变）**
 * —— 「applyUp 失败不改本地状态」的判据单点，离线自检直接钉这一条。
 * @param {object} row 审阅行
 * @param {{ok:boolean, item?:{status?:string}}} result 服务层结果
 * @returns {object} 下一状态的行（失败 ⇒ 同一个对象）
 */
export function nextSyncRow(row, result) {
  if (!row || typeof row !== 'object') return row
  if (!result || result.ok !== true) return row
  const status = result.item && typeof result.item.status === 'string' ? result.item.status : ''
  if (status === '' || status === row.status) return row
  return Object.assign({}, row, { status })
}

/* --------------------------------------------------------------------------- 状态门（纯函数） */

/**
 * **该行是否可动作（纯函数｜状态门单点）**：只有 `PENDING` 行能【通過並寫入】/【駁回】。
 * 非物件 / 空状态 / 已落定（`APPROVED` · `REJECTED` · `APPLIED` · `FAILED` · `CONFLICT`）
 * ⇒ `false` —— 面板据此**按状态收窄**两颗按钮，不再对已落定行发注定 `CONFLICT` 的写请求
 * （生产真因：面板把 PENDING 与 APPLIED 行一并列出 ⇒ 用户点到已写入行 ⇒ 服务端 CAS 门拒）。
 * @param {unknown} row 审阅行
 * @returns {boolean}
 */
export function canApproveSyncRow(row) {
  if (!row || typeof row !== 'object') return false
  return row.status === SYNC_ACTIONABLE_STATUS
}

/**
 * **按状态分流（纯函数｜「僅顯示待審」用）** ⇒ `{pending, settled}`：
 *  · **保序**（两桶各自维持入参顺序）、**不改入参数组**、**不改行**（只搬引用）；
 *  · 非 `PENDING`（含非物件元素）一律进 `settled`，两桶长度之和 ＝ 入参长度；
 *  · **非数组 ⇒ 两空数组**（不猜、不把物件当行）。
 * @param {unknown} rows 审阅行数组
 * @returns {{pending:Array, settled:Array}}
 */
export function partitionSyncRows(rows) {
  const pending = []
  const settled = []
  if (!Array.isArray(rows)) return { pending, settled }
  rows.forEach((row) => {
    if (canApproveSyncRow(row)) pending.push(row)
    else settled.push(row)
  })
  return { pending, settled }
}

/* --------------------------------------------------------------------------- 深链 */

/** 取查询值（vue-router 可能给数组 / 非串 ⇒ 逐个归一，取首个非空）。 */
function queryText(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const out = queryText(item)
      if (out !== '') return out
    }
    return ''
  }
  return text(value)
}

/**
 * **深链解析**（feicui 侧生成
 * `https://xiai.plus/my/corrections?from=feicui&entity=<books|persons|publishers>&key=<业务键>`）。
 * 三参齐备且实体在本期封闭面内才 `ok:true`；任一不合 ⇒ 结构化拒绝（**不猜、不放宽**）。
 * `NO_DEEP_LINK` 是**解析层**的「不是深链」信号（普通进页 / 别的来源 ⇒ 静默忽略），
 * **不是写面拒绝 reason**，不参与任何落盘判定。
 * @param {object} query `route.query`
 * @returns {{ok:boolean, reason:string, msg:string, item:{from:string, entity:string, key:string}|null}}
 */
export function parseSyncDeepLink(query) {
  const q = query && typeof query === 'object' ? query : {}
  const from = queryText(q.from)
  if (from !== SYNC_DEEP_LINK_FROM) {
    return fail('NO_DEEP_LINK', '不是斐萃深鏈（缺 from=feicui）。')
  }
  /* 单/复数都认：斐萃历史深链写的是单数（`entity=book`），新版本写复数；
     两者都必须能定位，否则「点过去没反应」会被误读成没数据。 */
  const entity = syncEntityKeyOf(queryText(q.entity))
  if (entity === '') {
    return fail('INVALID_VALUE', `深鏈 entity 只接受 ${SYNC_ENTITIES.join(' / ')}（單複數皆可）。`)
  }
  const key = queryText(q.key)
  if (key === '') {
    return fail('MISSING_REQUIRED', '深鏈缺 key（業務鍵）。')
  }
  return done('已解析斐萃深鏈。', { from, entity, key })
}

export default {
  SYNC_FUNCTION_NAME,
  SYNC_DIRECTION,
  SYNC_ENTITIES,
  syncEntityKeyOf,
  syncEntityCloudOf,
  SYNC_OP,
  SYNC_QUEUE_STATUS,
  SYNC_ACTIONABLE_STATUS,
  SYNC_DEEP_LINK_FROM,
  SYNC_LIMIT_DEFAULT,
  SYNC_LIMIT_MAX,
  SYNC_QUEUE_LIMIT,
  canReviewSync,
  setSyncTransport,
  resetSyncTransport,
  syncTransportStatus,
  clearSyncDeviceToken,
  request,
  listToXiai,
  approve,
  applyUp,
  reject,
  approveAndApply,
  nextSyncRow,
  canApproveSyncRow,
  partitionSyncRows,
  parseSyncDeepLink
}
