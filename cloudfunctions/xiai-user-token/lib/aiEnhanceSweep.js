'use strict'
/**
 * 玺爱 · **AI 修復產物「無人認領清掃」（72h TTL）唯一实现点**
 * ============================================================================ *
 * 职责（本单范围）：定时任务（CloudBase `Timer` 触发器）跑一轮 —— 把**超期且无人认领**
 * 的 AI 修復產物行 **连同内容寻址存储对象一起清掉**。判定链（**一切读先于一切删**）：
 *   ① **读候选行（超期条件进查询 ＋ 码内双保险）**：`where({source, created_at: {$lt:
 *      cutoffIso}})`、单次上限 `SWEEP_SCAN_LIMIT`（200 行）⇒ **扫描本身也封顶**。
 *      **为什么超期必须进查询**：产物行一旦超过一页（200 行），只按 `source` 等值读会**每轮
 *      读到同一页**、更老的行永远轮不到 ⇒ 清扫卡死；`cutoffIso ＝ new Date(nowMs −
 *      SWEEP_RETENTION_MS).toISOString()`（仓内 `created_at` **一律 ISO 串** ⇒ **串比较即
 *      时间序**，`$lt` 是严格小于 ⇒ 72h 恰等边界不入候选）。
 *      **码内再判一次超期（双保险，保留）**：`created_at` 形态不合法 / 读不出时戳 ⇒ **判否
 *      ⇒ 本轮不删该行**（不猜、不倒推）—— 查询层若因任意原因放宽，码内这道仍拦得住；
 *   ② **引用三面全护（批量，零 N+1）**（任一命中 ⇒ **不删**，计入 `kept_referenced`）：
 *      面① 印面行 `face_image_id` ／ 面③ 印譜行 `cover_image_id`（**印譜封面，最容易漏的
 *      一面**）—— 对**全部候选编号**做 `$in` **分块批量查（每块 ≤ `REFERENCE_CHUNK_LIMIT`
 *      ＝ 50）**，语义与逐行等值读**逐字等价**（命中任一 ⇒ referenced）；面② 印面行
 *      `edge_image_ids` 数组包含 ⇒ `kind:'EDGE'` 行**一次性扫**后码内比对（数组包含无法用
 *      等值条件表达）。**每轮引用读次数上界 ＝ `ceil(n/50) × 2 + 1`**（n ＝ 候选编号数；
 *      逐行版是 `2n` ⇒ 200 行 400 读，属 N+1，已废）；
 *   ③ **删行 ＋ 删对象**：一律调用 `lib/aiEnhanceDiscard.js::deleteProductImageRow`
 *      （**弃除面与本清扫共用的单实现点** —— 本文件**禁止**出现第二套 dedupe 判定 / 对象键
 *      推导 / 摘要形态判据；对象键、同摘要去重、失败如实 `false` 全在那一处）；
 *   ④ **回包封闭恰 6 键** `{ok, scanned, deleted, kept_referenced, freed_bytes, objects_deleted}`
 *      —— **零新增对外 op、零新增 reason、零新集合**（本面不是 op，只由 `Timer` 事件分流进入）。
 *
 * **分流判据（`isTimerSweepEvent`，三层、写死顺序；`index.js` 只照它分流）**：
 *   · **第一层（硬否）＝带 `op` 恒不进**：`op` 有值 —— 含非字符串、含**同时**带 `Type` /
 *     `TriggerName` —— 任何情况下都不进清扫，且**先于**后两层判定 ⇒ **零客户端可传 op
 *     映射到清扫**；
 *   · **第二层（主判据）＝`event.Type === 'Timer'`** ⇒ 进清扫（CloudBase 定时触发器投递
 *     的事件形态 `{Type:'Timer', TriggerName:…, Time:…}`）；
 *   · **第三层（等价兜底）＝`event.TriggerName` 为非空字符串且无 `op`** ⇒ **亦进清扫**。
 *     这一层**宽于规范原文的字面表述**（规范只写 `Type==='Timer'`），保留它是防御性冗余：
 *     定时事件必带 `TriggerName`，即便平台只投递 `TriggerName` 而漏 `Type`，清扫也不会静默
 *     不跑；**规范侧已同步为「主判据 `Type==='Timer'` ＋ `TriggerName` 等价兜底 ＋ 带 `op`
 *     恒不进」的三层表述**，两侧同尺；
 *   · 其余（普通 `{action, op, payload}` 请求 / 非对象 / 空事件）⇒ **不进**（走原分发链）。
 *
 * 硬护栏（逐条；派单方 ①〜⑤）：
 *   · **只认 `source === 'ai_enhance'`**（常量取自 `lib/aiEnhanceDiscard.js::AI_ENHANCE_SOURCE`
 *     的既有导出，不另立字面值）：其它来源的行**根本不进读集**，码内再判一道；
 *   · **超期双保险**：查询层 `$lt` ＋ 码内 `createdAtMs` 复判（见判定链 ①）；
 *   · **摘要 / 对象键形态不合法 ⇒ 只删行不删对象**（沿弃除口径，逻辑在单实现点内）；
 *   · **读失败 ⇒ 本轮零删除**：候选行读、引用三面读**全部先于任何删除**完成；任一读抛错 ⇒
 *     `catch` 记 `log.error`、返回 `ok:false` ＋ 摘要（计数为已发生的事实），**绝不把
 *     「读不到」当成「无引用」**；
 *   · **停滞护栏**：`scanned === SWEEP_SCAN_LIMIT && deleted === 0` ⇒ 记
 *     `log.warn('aiEnhanceSweep.round.stalled', {scanned, kept_referenced})` —— 整页 200 行
 *     全是被引用的老行 ⇒ 现实里意味着**候选读被卡在这一页**（或引用面异常膨胀），**需人工
 *     介入**；正常轮（`deleted > 0` 或未满页）不打这条；
 *   · **逐行监管日志**：每删一行记 `aiEnhanceSweep.row.deleted`（字段必含 `_id` 与
 *     `freed_bytes`）；被引用保留的行记 `aiEnhanceSweep.row.kept`；整轮汇总
 *     `aiEnhanceSweep.round.done` / 失败 `aiEnhanceSweep.round.failed`（走 `lib/log.js`
 *     单点，本文件**零 `console.` 字面**）。
 *
 * 算子形态说明（`$lt` / `$in` 走 `ops.readRows` ⇒ `.where(match)` **wire 字面值**）：
 * `@cloudbase/database` 的查询序列化（`serializer/common.ts::flatten`）对**以 `$` 开头的键
 * `continue` 不改写** ⇒ 原样落到请求体 `{"created_at": {"$lt": …}}` / `{"face_image_id":
 * {"$in": […]}}`，与 `db.command.lt/in` 生成的是同一份 wire 形态（仓内先例：
 * `lib/sealCards.js` 的「wire 字面值 `{ $gte: 1 }`」回落）。本文件**零取库句柄字面**
 * （拿不到 `db.command`，故一律 wire 字面值）。
 *
 * 为什么是 72 小时：AI 修復任務行的期限恰 20 分钟（`lib/aiEnhanceTasks.js::
 * TASK_DEADLINE_MS`）—— 72 小时后**不可能**还有「待决」的產物；留三天只为给人类一个
 * 反悔窗口（误删的兜底代价远大于多存三天）。**常量单点、可调**（见 `SWEEP_RETENTION_MS`）。
 *
 * 存储 / 读点纪律：本文件**零集合名字面、零集合句柄调用字面、零摘要 / 对象键推导** ——
 * 读走 `ops.readRows`、删行走 `deleteProductImageRow`（删行与去重删对象两步全在那一处），
 * 集合名只活在 `lib/ops.js::COLLECTIONS`；静态门由
 * `scripts/verify-ai-enhance-sweep.mjs` 的 H 段机械断言。
 * ============================================================================ *
 */

const log = require('./log.js')
/* **单实现点复用**：删行 ＋ 内容寻址去重删对象，与管理员弃除面同一份（禁第二套）。 */
const { AI_ENHANCE_SOURCE, deleteProductImageRow } = require('./aiEnhanceDiscard.js')

/* --------------------------------------------------------------------------- *
  常量面（封闭；客户端一律不可改）
 * --------------------------------------------------------------------------- */

/**
 * **保留期（唯一定义点，可调）**：72 小时。只清 `created_at < now − SWEEP_RETENTION_MS` 的
 * 產物行。理由：AI 修復任務本身 20 分钟即到期 ⇒ 72 小时后**不可能**还有「待决」產物；
 * 三天是给人类留的反悔窗口（不删的代价只是存储，误删的代价不可逆）。
 * 调整只改本行一个数（毫秒）；不得在别处出现第二个保留期字面值。
 */
const SWEEP_RETENTION_MS = 72 * 3600 * 1000

/** 单轮扫描上限（**扫描也上限**，200 行）：既封候选行读取，也封本轮最多处理的行数。 */
const SWEEP_SCAN_LIMIT = 200

/** 引用面读取上限（口径同 `lib/aiEnhanceDiscard.js`：边款行扫描 1000 行；批量 `$in` 读同尺）。 */
const EDGE_SCAN_LIMIT = 1000

/**
 * **`$in` 分块大小（引用批量读的唯一块宽，50）**：面① `face_image_id` ／ 面③ `cover_image_id`
 * 按候选编号分块批量查 —— 每块 ≤ 50 ⇒ 单轮引用读次数上界 `ceil(n/50) × 2 + 1`（＋面② 那 1 次
 * 边款扫描）。为什么是 50：块越宽命中行越多、单次 `limit` 顶越高；50 编号 × 每编号至多寥寥几条
 * 引用 ≪ `REFERENCE_BATCH_LIMIT`（1000），**命中集不会被分页截断**（截断 ⇒ 漏判引用 ⇒ 误删，
 * 是本面最不可接受的失败）。**语义与逐行等值读逐字等价**（`$in` ＝「等于其中任一」）。
 */
const REFERENCE_CHUNK_LIMIT = 50

/** 批量引用读的单次行数上限（与 `EDGE_SCAN_LIMIT` 同尺；块宽 50 ⇒ 命中集远不至此顶）。 */
const REFERENCE_BATCH_LIMIT = 1000

/** 定时事件类型字面（CloudBase 定时触发器投递给函数的 `event.Type`）。 */
const SWEEP_TIMER_EVENT_TYPE = 'Timer'

/** 回包键面（**成功 / 失败同一张封闭表**，恰 6 键；零 `reason`、零 `refunded`、零新增键）。 */
const SWEEP_REPLY_KEYS = Object.freeze([
  'ok',
  'scanned',
  'deleted',
  'kept_referenced',
  'freed_bytes',
  'objects_deleted'
])

/* --------------------------------------------------------------------------- *
  小工具（纯函数；零 IO）
 * --------------------------------------------------------------------------- */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/**
 * 行的 `created_at` ⇒ 毫秒时戳（**形态容错、绝不自抛**）：ISO 字面优先；纯数字十位（秒）/
 * 十三位（毫秒）亦认；**认不出 ⇒ `NaN`** ⇒ 调用方判「非超期」⇒ **不删**（不猜、不倒推）。
 * @param {object} row 影像行
 * @returns {number} 毫秒时戳；形态不合法 ⇒ `NaN`
 */
function createdAtMs(row) {
  const raw = text(row && row.created_at)
  if (raw === '') return NaN
  if (/^\d{13}$/.test(raw)) return Number(raw)
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : NaN
}

/**
 * 行申报的字节数（**只取行内既有字段、不猜**）：`bytes` 优先，回落同文档的 `bytesLength`；
 * 两者都取不到 ⇒ `0`（**宁少记、不虚报** `freed_bytes`）。
 * @param {object} row 影像行
 * @returns {number} 字节数（非负整数）
 */
function rowBytesOf(row) {
  const pick = (value) => {
    if (value === undefined || value === null) return NaN
    if (typeof value === 'string' && value.trim() === '') return NaN
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : NaN
  }
  const primary = pick(row && row.bytes)
  if (Number.isFinite(primary)) return primary
  const fallback = pick(row && row.bytesLength)
  return Number.isFinite(fallback) ? fallback : 0
}

/**
 * **定时事件判据（三层、写死顺序；`index.js` 分流只照它）**——**带 `op` 的请求任何情况下
 * 都不进清扫**：
 *   · **第一层（硬否）**＝`op` 有值（含非字符串、只按 `String()` 归一后非空）⇒ **恒 `false`**
 *     （**先于**后两层判 ⇒ 客户端塞 `Type:'Timer'` / `TriggerName` 也进不来）；
 *   · **第二层（主判据）**＝`event.Type === 'Timer'` ⇒ `true`；
 *   · **第三层（等价兜底）**＝`event.TriggerName` 为非空字符串且无 `op` ⇒ `true`
 *     （**宽于规范原文**：规范只写 `Type==='Timer'`；保留此层为防御性冗余，规范侧已同步为
 *     「主判据 ＋ `TriggerName` 等价兜底 ＋ 带 `op` 恒不进」三层表述）；
 *   · 其余（普通 `{action, op, payload}` 请求 / 非对象）⇒ `false`。
 * @param {object} event 事件对象
 * @returns {boolean} 是否走清扫分支
 */
function isTimerSweepEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return false
  const rawOp = Object.prototype.hasOwnProperty.call(event, 'op') && event.op !== undefined && event.op !== null
    ? String(event.op).trim()
    : ''
  if (rawOp !== '') return false
  if (event.Type === SWEEP_TIMER_EVENT_TYPE) return true
  return typeof event.TriggerName === 'string' && event.TriggerName.trim() !== ''
}

/** 闭合回包（恰 `SWEEP_REPLY_KEYS` 6 键；`ok` 取真值）。 */
function replyOf(ok, counters) {
  return {
    ok: ok === true,
    scanned: counters.scanned,
    deleted: counters.deleted,
    kept_referenced: counters.kept_referenced,
    freed_bytes: counters.freed_bytes,
    objects_deleted: counters.objects_deleted
  }
}

/* --------------------------------------------------------------------------- *
  读点（一律经 `lib/ops.js` 的导出；延迟 require 打破加载环、供离线自检先注入假体）
 * --------------------------------------------------------------------------- */

function opsModule() {
  return require('./ops.js')
}

/**
 * **面② 读取**：所有印面行的 `edge_image_ids` 并集（一次读，`kind:'EDGE'` 行扫描 ＋ 码内
 * 比对 —— 数组包含无法用等值条件表达；口径与 `lib/aiEnhanceDiscard.js::referencedByFace` 同尺）。
 * 读抛错 ⇒ 原样上抛（由主流程 `catch` ⇒ **本轮零删除**）。
 * @param {object} ops `lib/ops.js` 模块
 * @returns {Promise<Set<string>>} 边款引用的影像编号集合
 */
async function readEdgeReferenceIds(ops) {
  const rows = await ops.readRows(ops.COLLECTIONS.faces, { kind: 'EDGE' }, { limit: EDGE_SCAN_LIMIT })
  const ids = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const list = Array.isArray(row && row.edge_image_ids) ? row.edge_image_ids : []
    for (const item of list) {
      const id = text(item)
      if (id !== '') ids.add(id)
    }
  }
  return ids
}

/**
 * **引用三面判定（批量；面① ＋ 面③ 走 `$in` 分块，面② 由调用方传入已读好的集合）**。
 * 语义与逐行等值读**逐字等价**：候选编号 ∈ 面① 的 `face_image_id` / 面③ 的 `cover_image_id`
 * （等值、任一命中）或 ∈ 面② 的 `edge_image_ids` 并集 ⇒ **referenced（不可删）**。
 * 读次数上界 ＝ `ceil(n/REFERENCE_CHUNK_LIMIT) × 2`（面② 的那 1 次边款扫描在调用方）——
 * **彻底消掉逐行版的 `2n` N+1**（200 行从 400 读降到 9 读）。
 * 读抛错 ⇒ 原样上抛（⇒ **本轮零删除**，绝不降级成「无引用」）。
 * @param {object} ops `lib/ops.js` 模块
 * @param {string[]} refIds 候选影像编号（调用方已去空）
 * @param {Set<string>} edgeIds 面② 已读好的边款引用集合
 * @returns {Promise<Set<string>>} 被任一引用面命中的编号集合
 */
async function collectReferencedIds(ops, refIds, edgeIds) {
  const referenced = new Set()
  const pending = []
  for (const id of refIds) {
    if (edgeIds.has(id)) referenced.add(id)
    else pending.push(id)
  }
  for (let start = 0; start < pending.length; start += REFERENCE_CHUNK_LIMIT) {
    const chunk = pending.slice(start, start + REFERENCE_CHUNK_LIMIT)
    if (chunk.length === 0) continue
    /* 面① 印面 `face_image_id` 批量等值。 */
    const byFace = await ops.readRows(
      ops.COLLECTIONS.faces,
      { face_image_id: { $in: chunk } },
      { limit: REFERENCE_BATCH_LIMIT }
    )
    for (const row of Array.isArray(byFace) ? byFace : []) {
      const id = text(row && row.face_image_id)
      if (id !== '') referenced.add(id)
    }
    /* 面③ 印譜 `cover_image_id` 批量等值（**最容易漏的一面**）。 */
    const byBookCover = await ops.readRows(
      ops.COLLECTIONS.books,
      { cover_image_id: { $in: chunk } },
      { limit: REFERENCE_BATCH_LIMIT }
    )
    for (const row of Array.isArray(byBookCover) ? byBookCover : []) {
      const id = text(row && row.cover_image_id)
      if (id !== '') referenced.add(id)
    }
  }
  return referenced
}

/* --------------------------------------------------------------------------- *
  主流程
 * --------------------------------------------------------------------------- */

/**
 * **扫一轮无人认领的 AI 修復產物**（行 ＋ 对象一起清）。
 * 两段式：**读段**（候选行 ＋ 引用三面，全部完成）→ **删段**（只处理判定完毕的行）；
 * 任一环节抛错 ⇒ `catch` 记 `log.error` 并返回 `ok:false` ＋ 当前事实计数（**绝不自抛**）。
 * @param {{nowMs?:number}} [context] `nowMs` 只为离线自检可注入（缺省 `Date.now()`）
 * @returns {Promise<object>} 恰 6 键（`SWEEP_REPLY_KEYS`）
 */
async function sweepUnclaimedProductImages(context) {
  const nowMs = Number.isFinite(context && context.nowMs) ? context.nowMs : Date.now()
  const cutoffMs = nowMs - SWEEP_RETENTION_MS
  /* 查询级超期条件（ISO 串比较即时间序；严格 `<` ⇒ 72h 恰等边界不入候选）。 */
  const cutoffIso = new Date(cutoffMs).toISOString()
  const counters = {
    scanned: 0,
    deleted: 0,
    kept_referenced: 0,
    freed_bytes: 0,
    objects_deleted: 0
  }

  try {
    const ops = opsModule()

    /* —— 读段① 候选行：**超期条件进查询**（`source` 等值 ⇒ 非 ai_enhance 来源根本不进读集；
       `created_at: {$lt: cutoffIso}` ⇒ 不满页时也不会把「还没到期」的行塞进这 200 的额度；
       单次上限 200 ⇒ 扫描本身也封顶）。只按 `source` 读会在行数 > 200 时**每轮读同一页**、
       更老的行永远轮不到 ⇒ 清扫卡死，故超期必须在查询层。 —— */
    const rows = await ops.readRows(
      ops.COLLECTIONS.images,
      { source: AI_ENHANCE_SOURCE, created_at: { $lt: cutoffIso } },
      { limit: SWEEP_SCAN_LIMIT }
    )
    const scannedRows = Array.isArray(rows) ? rows : []
    counters.scanned = scannedRows.length

    /* 码内**双保险**复判（保留）：硬护栏① 再判一次 source；硬护栏② 再判一次超期
       （形态不合法 / 读不出时戳 ⇒ 判否 ⇒ 不删 —— 不猜、不倒推）。 */
    const candidates = []
    for (const row of scannedRows) {
      if (text(row && row.source) !== AI_ENHANCE_SOURCE) continue
      const createdAt = createdAtMs(row)
      if (!Number.isFinite(createdAt)) {
        log.warn('aiEnhanceSweep.row.skipped', { _id: text(row && (row._id || row.id)), reason: 'created_at' })
        continue
      }
      if (createdAt >= cutoffMs) continue
      candidates.push(row)
    }

    if (candidates.length > 0) {
      /* 先归集编号（无编号行跳过 ⇒ 既不读引用面也不删）。 */
      const withIds = []
      for (const row of candidates) {
        const refId = text(row && row.id) || text(row && row._id)
        if (refId === '') {
          log.warn('aiEnhanceSweep.row.skipped', { reason: 'no-id' })
          continue
        }
        withIds.push({ row, refId })
      }

      if (withIds.length > 0) {
        /* —— 读段② 引用三面：面② 边款一次性扫 ＋ 面①③ 按候选编号 `$in` 分块批量查
           （读次数上界 `ceil(n/50) × 2 + 1`，零 N+1）；**对全部候选一次判完，一切读先于
           任何删**；任一读抛错 ⇒ 整轮零删除 —— 绝不把「读不到」当成「无引用」。 —— */
        const edgeIds = await readEdgeReferenceIds(ops)
        const referencedIds = await collectReferencedIds(
          ops,
          withIds.map((item) => item.refId),
          edgeIds
        )
        const plan = withIds.map((item) => ({
          row: item.row,
          refId: item.refId,
          referenced: referencedIds.has(item.refId)
        }))

        /* —— 删段：只处理读段已判定完毕的行（判定不再发生任何读以外的副作用）。 —— */
        for (const item of plan) {
          if (item.referenced) {
            counters.kept_referenced += 1
            log.info('aiEnhanceSweep.row.kept', { _id: item.refId, reason: 'referenced' })
            continue
          }

          /* **单实现点**：删行 ＋ 同摘要去重保护下删对象（禁在本文件复写第二套逻辑）。 */
          const rowBytes = rowBytesOf(item.row)
          const { docId, deletedObject } = await deleteProductImageRow(ops, item.row)
          const freed = deletedObject ? rowBytes : 0
          counters.deleted += 1
          counters.freed_bytes += freed
          if (deletedObject) counters.objects_deleted += 1
          /* 硬护栏④：逐行监管日志，必含 `_id` 与 `freed_bytes`。 */
          log.info('aiEnhanceSweep.row.deleted', { _id: docId, freed_bytes: freed, object_deleted: deletedObject })
        }
      }
    }

    /* —— 停滞护栏：**整页打满却一行没删** ⇒ 这一页全是被引用的老行 / 候选读被卡住 ⇒
       需人工介入（`log.warn`，不改回包、不中断）。正常轮（`deleted > 0` 或未满页）不打。 —— */
    if (counters.scanned === SWEEP_SCAN_LIMIT && counters.deleted === 0) {
      log.warn('aiEnhanceSweep.round.stalled', {
        scanned: counters.scanned,
        kept_referenced: counters.kept_referenced
      })
    }

    log.info('aiEnhanceSweep.round.done', {
      scanned: counters.scanned,
      deleted: counters.deleted,
      kept_referenced: counters.kept_referenced,
      freed_bytes: counters.freed_bytes,
      objects_deleted: counters.objects_deleted
    })
    return replyOf(true, counters)
  } catch (error) {
    /* 硬护栏③：读失败 / 任何内部异常 ⇒ 本轮不再删任何行；`ok:false` ＋ 已发生的事实计数。 */
    log.error('aiEnhanceSweep.round.failed', Object.assign({ error }, counters))
    return replyOf(false, counters)
  }
}

module.exports = {
  SWEEP_RETENTION_MS,
  SWEEP_SCAN_LIMIT,
  SWEEP_TIMER_EVENT_TYPE,
  SWEEP_REPLY_KEYS,
  REFERENCE_CHUNK_LIMIT,
  isTimerSweepEvent,
  sweepUnclaimedProductImages
}
