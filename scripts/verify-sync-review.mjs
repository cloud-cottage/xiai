/**
 * 玺爱 · **斐萃同步审阅段** 离线自检（`scripts/verify-sync-review.mjs`｜零网络、零副作用）
 * ============================================================================
 * 被测实现：`src/services/sync.js`（新）＋ `src/views/MyCorrectionsView.vue`（**只追加**一段）
 *           ＋ `src/services/index.js`（门面挂载）。
 *
 * 覆盖（任务 C 验收四条，逐条可判负；每段带变异 / canary 负对照证明尺子会响）：
 *   A  **非 admin 看不到该段**：`canReviewSync()` 只认 `session.js::isAdmin`；非 admin ⇒
 *      恒 false ＋ **零请求**（服务层前置拒）；静态面：审阅段开标签逐字
 *      `<section v-if="canSyncReview" … data-sync-review>`（**不是 `v-show`**）、
 *      段内零 `data-admin-action`（不污染全仓 12 值冻结集合）。
 *   B  **approve 只传 `queue_id`**：注入传输收真事件 ⇒ `action='approveQueue'`、
 *      `payload` 恰一键 `{queue_id}`（`applyUp` / `rejectQueue` 同尺）；
 *      非串 / 空串 / 数组 ⇒ `INVALID_VALUE` ＋ **零请求**。
 *   C  **applyUp 失败不改本地状态**：`approveQueue` 成功 → `applyUp` 回 `CONFLICT`
 *      ⇒ `approveAndApply` 结构化失败（`reason` 原样）且 `nextSyncRow` **返回原行**；
 *      正对照：`applyUp` 成功时状态才推进到 `APPLIED`。
 *   D  **深链参数解析**：`https://xiai.plus/my/corrections?from=feicui&entity=…&key=…`
 *      ⇒ 定位成功；缺参 / 非本期实体 / 非 feicui 来源 ⇒ 结构化拒绝。
 *   E  **列表列面**：`listToXiai` 只回本期三实体、列面（实体 / 业务键 / 操作 / 差异字段数 /
 *      入队时间 / 状态）齐、`queue_id` 只认队列行（不编造）。
 *   F  **红线静态面**：路由表零 `/admin/sync`（审阅口复用 `/my/corrections`）、
 *      审阅段零全选一键通过入口。
 *   G  **状态门与幂等（本单）**：`canApproveSyncRow` 逐态（`PENDING` ⇒ true；其余五态 /
 *      空 / 非物件 ⇒ false）；`approveAndApply` 幂等门（`CONFLICT` ＋ 该项已写入 ⇒ `ok:true`
 *      ＋ `item.idempotent:true` ＋ **只发一次 `approveQueue`**；`CONFLICT` ＋
 *      `currentStatus=PENDING` ⇒ 仍 `ok:false`）；`partitionSyncRows` 保序 / 不改原数组 /
 *      非数组 ⇒ 两空数组。
 *   H  **面板静态面 ＋ 变异负对照**：两颗按钮带 `row.status === 'PENDING'` 条件、非待审行渲染
 *      `data-sync-settled` 状态字样、「僅顯示待審」开关与 `data-sync-settled-count` 钩子；
 *      M1〜M3（剥掉按钮 status 条件 ⇒ 同一把尺子翻红）、M4〜M7（幂等分支是红绿分界）。
 *
 * 纪律：只读 `src/**`；不发网络请求（传输注入缝）；不新增依赖；断言失败 ⇒ 退出码非 0。
 */
process.env.XIAI_NO_REAL_CARD = '1'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import * as sync from '../src/services/sync.js'
import { isAdmin, setUser } from '../src/data/session.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* --------------------------------------------------------------------------- 断言骨架 */
const results = []
let failures = 0

function canon(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`)
    .join(',')}}`
}

function check(id, desc, expected, actual) {
  const pass = canon(expected) === canon(actual)
  if (!pass) failures += 1
  results.push({ id, desc, pass, expected, actual })
  console.log(JSON.stringify({ id, case: desc, pass, expected, actual }))
}

const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')

/** 去注释（`<!-- -->` / `/* *\\/` / script 段行尾 `//`）—— 注释里写的字不算实现。 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/** 登录态注入（只在本进程内存；`setUser` 的持久化面由 storage 层的 catch 兜住）。 */
function signIn(role) {
  setUser(role ? { id: 'u-verify-sync', role, points: 0, phone: '13800000000' } : null)
}

/** 传输注入：把事件记进 `log`，按 `handler(action, event)` 出回包。 */
function installTransport(log, handler) {
  sync.setSyncTransport(async (event) => {
    log.push(event)
    return handler(event)
  })
}

/* ===========================================================================
   A 段 · 非 admin 看不到该段（运行时门 ＋ 静态渲染门）
   =========================================================================== */
console.log(JSON.stringify({ section: 'A', title: '非 admin 看不到该段' }))
signIn(null)
check('A1', '未登录 ⇒ canReviewSync() === false', false, sync.canReviewSync())
signIn('user')
check('A2', '普通用户 ⇒ canReviewSync() === false', false, sync.canReviewSync())
signIn('sub-admin')
check('A3', 'sub-admin ⇒ canReviewSync() === false（判权单点只认 admin）', false, sync.canReviewSync())
signIn('admin')
check('A4', '管理员 ⇒ canReviewSync() === true', true, sync.canReviewSync())
check('A5', 'isAdmin 单点同步为真（同一份状态）', true, isAdmin.value)

/* A6〜A8：非 admin 下服务层**零请求**（传输一次都不该被调到）。 */
{
  const log = []
  installTransport(log, () => ({ ok: true, items: [], count: 0 }))
  signIn('user')
  const listed = await sync.listToXiai({})
  check('A6', '非 admin 调 listToXiai ⇒ FORBIDDEN ＋ 零请求', { ok: false, reason: 'FORBIDDEN', calls: 0 }, { ok: listed.ok, reason: listed.reason, calls: log.length })
  const approved = await sync.approve('q-1')
  check('A7', '非 admin 调 approve ⇒ FORBIDDEN ＋ 零请求', { ok: false, reason: 'FORBIDDEN', calls: 0 }, { ok: approved.ok, reason: approved.reason, calls: log.length })
  signIn(null)
  const rejected = await sync.reject('q-1')
  check('A8', '未登录调 reject ⇒ FORBIDDEN ＋ 零请求', { ok: false, reason: 'FORBIDDEN', calls: 0 }, { ok: rejected.ok, reason: rejected.reason, calls: log.length })
  sync.resetSyncTransport()
}

/* A9〜A12：静态渲染门（审阅段必须由 `v-if` 条件渲染，不得 `v-show` 冒充）。 */
{
  const src = stripComments(read('src/views/MyCorrectionsView.vue'))
  const openTag = '<section v-if="canSyncReview" class="panel" data-sync-review>'
  check('A9', '审阅段开标签逐字（v-if 条件渲染）', true, src.includes(openTag))
  check('A10', '审阅段零 v-show（不以 CSS 隐藏冒充）', 0, (src.match(/<section[^>]*data-sync-review[^>]*>/g) || []).filter((tag) => tag.includes('v-show')).length)
  check('A11', '渲染门来自服务层单点 sync.canReviewSync()', true, src.includes('const canSyncReview = computed(() => sync.canReviewSync())'))
  /* 段内零 `data-admin-action`（全仓 12 值冻结集合不因本单增员）。 */
  const block = (src.match(/<section v-if="canSyncReview"[\s\S]*?<\/section>/) || [''])[0]
  check('A12', '审阅段内 data-admin-action 取值 0（不污染冻结集合）', 0, (block.match(/data-admin-action=/g) || []).length)
  check('A12b', '审阅段已渲染（段体非空、含逐项按钮）', true, block.includes('data-action="sync-approve"') && block.includes('data-action="sync-reject"'))
}

/* ===========================================================================
   B 段 · approve 只传 queue_id（逐项；零批量直通）
   =========================================================================== */
console.log(JSON.stringify({ section: 'B', title: 'approve 只传 queue_id' }))
signIn('admin')
{
  const log = []
  installTransport(log, (event) => {
    if (event.action === 'approveQueue') return { ok: true, queue_id: event.payload.queue_id, status: 'APPROVED' }
    if (event.action === 'applyUp') return { ok: true, queue_id: event.payload.queue_id, status: 'APPLIED', applied: 1, conflict: 0 }
    if (event.action === 'rejectQueue') return { ok: true, queue_id: event.payload.queue_id, status: 'REJECTED' }
    return { ok: false, reason: 'NOT_FOUND', message: 'unexpected op' }
  })

  const approved = await sync.approve('q-abc123')
  check('B1', 'approve 成功回 {ok:true, reason:"", msg, item}', { ok: true, reason: '' }, { ok: approved.ok, reason: approved.reason })
  check('B2', 'approve 事件 action ＝ approveQueue', 'approveQueue', log[0] && log[0].action)
  check('B3', 'approve 载荷**恰一键** {queue_id}', ['queue_id'], Object.keys((log[0] && log[0].payload) || {}))
  check('B4', 'approve 载荷值逐字', { queue_id: 'q-abc123' }, (log[0] && log[0].payload) || null)

  const applied = await sync.applyUp('q-abc123')
  check('B5', 'applyUp 载荷**恰一键** {queue_id}', ['queue_id'], Object.keys((log[1] && log[1].payload) || {}))
  check('B6', 'applyUp 事件 action ＝ applyUp', 'applyUp', log[1] && log[1].action)
  check('B7', 'applyUp 结构化回包（item.status 透传）', 'APPLIED', (applied.item && applied.item.status) || '')

  const rejected = await sync.reject('q-abc123')
  check('B8', 'reject 载荷**恰一键** {queue_id}', ['queue_id'], Object.keys((log[2] && log[2].payload) || {}))
  check('B9', 'reject 事件 action ＝ rejectQueue', 'rejectQueue', log[2] && log[2].action)

  /* 形态门：非串 / 空串 / 数组 ⇒ INVALID_VALUE ＋ **零请求**（零写入的最前一道）。 */
  const before = log.length
  const badArray = await sync.approve(['q-a', 'q-b'])
  const badEmpty = await sync.approve('   ')
  const badType = await sync.approve({ queue_id: 'q-a' })
  check('B10', '数组 / 空串 / 对象 ⇒ INVALID_VALUE', ['INVALID_VALUE', 'INVALID_VALUE', 'INVALID_VALUE'], [badArray.reason, badEmpty.reason, badType.reason])
  check('B11', '形态门零请求（不发必然被拒的载荷）', before, log.length)

  /* canary：直接打单点 `request` 夹带第二个键 ⇒ 传输**确实收得到**（证明 B3 的「恰一键」是真判据）。 */
  const canaryLog = []
  installTransport(canaryLog, () => ({ ok: true, queue_id: 'q-x', status: 'APPROVED' }))
  await sync.request('approveQueue', { queue_id: 'q-x', entity: 'books' })
  check('B12', 'canary：绕过 approve() 夹带业务键 ⇒ 传输收到 2 键（判据非恒等）', 2, Object.keys((canaryLog[0] && canaryLog[0].payload) || {}).length)
  sync.resetSyncTransport()
}

/* ===========================================================================
   C 段 · applyUp 失败不改本地状态（两步任一失败即停）
   =========================================================================== */
console.log(JSON.stringify({ section: 'C', title: 'applyUp 失败不改本地状态' }))
{
  const log = []
  installTransport(log, (event) => {
    if (event.action === 'approveQueue') return { ok: true, queue_id: event.payload.queue_id, status: 'APPROVED' }
    if (event.action === 'applyUp') return { ok: false, reason: 'CONFLICT', message: 'xiai 行已被他人改动（before_hash 不一致）' }
    return { ok: false, reason: 'NOT_FOUND', message: 'unexpected op' }
  })
  const row = { queue_id: 'q-1', entity: 'books', key: 'BK00001', subject_id: 'BK00001', op: 'update', diff_count: 2, changed: ['title'], queued_at: '2026-11-26T00:00:00.000Z', status: 'PENDING' }
  const snapshot = JSON.stringify(row)

  const result = await sync.approveAndApply('q-1')
  check('C1', 'applyUp 失败 ⇒ 整体 ok:false', false, result.ok)
  check('C2', 'reason 原样透传服务端（不吞错）', 'CONFLICT', result.reason)
  check('C3', 'msg 写明卡在写入步（前缀「已通過但寫入失敗：」）', true, String(result.msg).startsWith('已通過但寫入失敗：'))
  check('C4', '失败 item.stage ＝ applyUp（approve 已成功、applyUp 停手）', 'applyUp', result.item && result.item.stage)
  check('C5', '两步各发一次、失败后**不再发第三发**', ['approveQueue', 'applyUp'], log.map((event) => event.action))
  check('C6', 'nextSyncRow(失败) 返回原行（状态仍 PENDING）', { unchanged: true, status: 'PENDING' }, { unchanged: JSON.stringify(sync.nextSyncRow(row, result)) === snapshot, status: sync.nextSyncRow(row, result).status })
  check('C7', '原行对象未被就地改写（纯函数、零副作用）', snapshot, JSON.stringify(row))

  /* approve 步失败 ⇒ 连 applyUp 都不发（失败即停的另一半）。
     注：本单起「CONFLICT ＋ 该项已写入（msg 含 APPLIED）」改判**幂等成功**（见 G11 / G20）
     ⇒ 这里的冲突回包换用**非 APPLIED** 的状态，钉的仍是「失败即停、reason 原样透传」。 */
  const log2 = []
  installTransport(log2, () => ({ ok: false, reason: 'CONFLICT', message: '队列项当前状态为 REJECTED，只允许从 PENDING 迁移；本次零寫入。' }))
  const failed = await sync.approveAndApply('q-2')
  check('C8', 'approve 失败 ⇒ ok:false ＋ reason 透传', { ok: false, reason: 'CONFLICT' }, { ok: failed.ok, reason: failed.reason })
  check('C9', 'approve 失败 ⇒ 零 applyUp（恰 1 发）', ['approveQueue'], log2.map((event) => event.action))

  /* 正对照：applyUp 成功时状态才推进（证明尺子会动，C6 不是恒等断言）。 */
  const log3 = []
  installTransport(log3, (event) =>
    event.action === 'approveQueue'
      ? { ok: true, queue_id: event.payload.queue_id, status: 'APPROVED' }
      : { ok: true, queue_id: event.payload.queue_id, status: 'APPLIED', applied: 1, conflict: 0 }
  )
  const okResult = await sync.approveAndApply('q-3')
  const next = sync.nextSyncRow({ queue_id: 'q-3', status: 'PENDING' }, okResult)
  check('C10', '正对照：两步皆成 ⇒ ok:true 且状态推进到 APPLIED', { ok: true, status: 'APPLIED' }, { ok: okResult.ok, status: next.status })
  check('C11', '正对照：成功两步顺序 ＝ approveQueue → applyUp', ['approveQueue', 'applyUp'], log3.map((event) => event.action))
  sync.resetSyncTransport()
}

/* ===========================================================================
   D 段 · 深链参数解析（feicui 侧生成的 URL 必须能定位到该行）
   =========================================================================== */
console.log(JSON.stringify({ section: 'D', title: '深链参数解析' }))
{
  const queryOf = (search) => {
    const params = new URLSearchParams(search)
    const out = {}
    params.forEach((value, key) => {
      out[key] = value
    })
    return out
  }

  const feicuiUrl = 'https://xiai.plus/my/corrections?from=feicui&entity=books&key=BK00001'
  const fromUrl = sync.parseSyncDeepLink(queryOf(new URL(feicuiUrl).search))
  check('D1', 'feicui 真实外链（from=feicui&entity=books&key=BK00001）⇒ 定位成功', { ok: true, entity: 'books', key: 'BK00001' }, { ok: fromUrl.ok, entity: fromUrl.item && fromUrl.item.entity, key: fromUrl.item && fromUrl.item.key })

  const persons = sync.parseSyncDeepLink({ from: 'feicui', entity: 'persons', key: 'p-42' })
  const publishers = sync.parseSyncDeepLink({ from: 'feicui', entity: 'publishers', key: 'PB000000001' })
  check('D2', '本期实体 persons ⇒ ok', true, persons.ok)
  check('D3', '本期实体 publishers ⇒ ok', true, publishers.ok)

  check('D4', '缺 from ⇒ NO_DEEP_LINK（普通进页静默忽略）', 'NO_DEEP_LINK', sync.parseSyncDeepLink({ entity: 'books', key: 'BK1' }).reason)
  check('D5', 'from 非 feicui ⇒ NO_DEEP_LINK', 'NO_DEEP_LINK', sync.parseSyncDeepLink({ from: 'other', entity: 'books', key: 'BK1' }).reason)
  check('D6', '非本期实体 seals ⇒ INVALID_VALUE（不放宽）', 'INVALID_VALUE', sync.parseSyncDeepLink({ from: 'feicui', entity: 'seals', key: 'S1' }).reason)
  check('D7', '缺 entity ⇒ INVALID_VALUE', 'INVALID_VALUE', sync.parseSyncDeepLink({ from: 'feicui', key: 'BK1' }).reason)
  check('D8', '缺 key ⇒ MISSING_REQUIRED', 'MISSING_REQUIRED', sync.parseSyncDeepLink({ from: 'feicui', entity: 'books' }).reason)
  check('D9', '空 key ⇒ MISSING_REQUIRED', 'MISSING_REQUIRED', sync.parseSyncDeepLink({ from: 'feicui', entity: 'books', key: '   ' }).reason)
  check('D10', 'query 缺失（undefined）⇒ 结构化拒绝且不抛', false, sync.parseSyncDeepLink(undefined).ok)
  check('D11', '数组形 query 值（vue-router 重复参）⇒ 取首个非空', { ok: true, key: 'BK1' }, (() => {
    const parsed = sync.parseSyncDeepLink({ from: ['feicui'], entity: ['books'], key: ['BK1'] })
    return { ok: parsed.ok, key: parsed.item && parsed.item.key }
  })())
  /* canary：解析器不是恒返回 ok 的空壳 —— 同参去掉 from 必须翻红。 */
  check('D12', 'canary：三参齐 vs 去掉 from ⇒ 结果必须不同', true, sync.parseSyncDeepLink({ from: 'feicui', entity: 'books', key: 'BK1' }).ok !== sync.parseSyncDeepLink({ entity: 'books', key: 'BK1' }).ok)
}

/* ===========================================================================
   E 段 · 列表列面（本期三实体 ＋ 六列 ＋ queue_id 只认队列行）
   =========================================================================== */
console.log(JSON.stringify({ section: 'E', title: 'listToXiai 列面' }))
{
  const log = []
  installTransport(log, (event) => {
    if (event.action === 'listDiff') {
      return {
        ok: true,
        items: [
          { entity: 'books', subject: 'BK00001', direction: 'to-xiai', op: 'update', changed: ['title', 'year'], after: { title: 'x', year: 1999 } },
          { entity: 'seals', subject: 'S1', direction: 'to-xiai', op: 'create', changed: ['name'], after: { name: 'y' } },
          { entity: 'publishers', subject: 'PB000000001', direction: 'to-xiai', op: 'create', changed: ['name'], after: { name: 'z' } }
        ],
        count: 3,
        next_cursor: 'books|BK00002'
      }
    }
    if (event.action === 'listQueue') {
      return {
        ok: true,
        items: [{ _id: 'q-9', entity: 'books', subject_id: 'BK00001', direction: 'to-xiai', status: 'PENDING', requested_at: '2026-11-26T01:02:03.000Z' }],
        count: 1
      }
    }
    return { ok: false, reason: 'NOT_FOUND', message: 'unexpected op' }
  })

  const listed = await sync.listToXiai({})
  check('E1', 'listToXiai 成功', true, listed.ok)
  check('E2', '方向恒 to-xiai（第一发）', { direction: 'to-xiai', limit: 50 }, { direction: log[0].payload.direction, limit: log[0].payload.limit })
  check('E3', '两发只读：listDiff → listQueue', ['listDiff', 'listQueue'], log.map((event) => event.action))
  const rows = (listed.item && listed.item.items) || []
  check('E4', '非本期实体（seals）被剔除 ⇒ 恰 2 行', 2, rows.length)
  check('E5', '行面六列齐（实体 / 业务键 / 操作 / 差异字段数 / 入队时间 / 状态）', ['queue_id', 'entity', 'key', 'op', 'diff_count', 'queued_at', 'status'], Object.keys(rows[0] || {}).filter((key) => ['queue_id', 'entity', 'key', 'op', 'diff_count', 'queued_at', 'status'].includes(key)))
  check('E6', '队列行对齐：queue_id / 入队时间 / 状态', { queue_id: 'q-9', queued_at: '2026-11-26T01:02:03.000Z', status: 'PENDING' }, { queue_id: rows[0].queue_id, queued_at: rows[0].queued_at, status: rows[0].status })
  check('E7', '差异字段数 ＝ changed 长度', 2, rows[0].diff_count)
  check('E8', '无队列行 ⇒ queue_id 空串（不编造）', { queue_id: '', status: '' }, { queue_id: rows[1].queue_id, status: rows[1].status })
  check('E9', '深链业务键与行 key 同面（可定位）', 'BK00001', rows[0].key)

  /* 形态门：非本期实体 / 越界 limit ⇒ INVALID_VALUE ＋ 零请求。 */
  const before = log.length
  const badEntity = await sync.listToXiai({ entity: 'pdf' })
  const badLimit = await sync.listToXiai({ limit: 999 })
  check('E10', 'entity=pdf（非本期）⇒ INVALID_VALUE', 'INVALID_VALUE', badEntity.reason)
  check('E11', 'limit=999（越界）⇒ INVALID_VALUE', 'INVALID_VALUE', badLimit.reason)
  check('E12', '两道形态门零请求', before, log.length)
  sync.resetSyncTransport()
}

/* ===========================================================================
   F 段 · 红线静态面（不新建路由 / 不批量直通 / 零新云函数）
   =========================================================================== */
console.log(JSON.stringify({ section: 'F', title: '红线静态面' }))
{
  const routerSrc = stripComments(read('src/router/index.js'))
  check('F1', '路由表零 `/admin/sync`（审阅口复用 /my/corrections）', 0, (routerSrc.match(/admin\/sync/g) || []).length)
  check('F2', '`/my/corrections` 仍在路由表（复用既有纠错流）', true, routerSrc.includes('/my/corrections'))

  const viewSrc = stripComments(read('src/views/MyCorrectionsView.vue'))
  const block = (viewSrc.match(/<section v-if="canSyncReview"[\s\S]*?<\/section>/) || [''])[0]
  check('F3', '审阅段零「全选 / 一键通过 / 批量直通」入口', 0, (block.match(/sync-approve-all|approveAll|批量通過|全選/g) || []).length)
  check('F4', '审阅段动作键全集（刷新 / 清定位 / 逐项通过 / 逐项驳回）', ['sync-approve', 'sync-clear-target', 'sync-refresh', 'sync-reject'], [...new Set((block.match(/data-action="(sync-[a-z-]+)"/g) || []).map((raw) => raw.replace(/data-action="|"/g, '')))].sort())
  check('F5', '每行按钮绑同一行 queue_id（逐项、不是全表一个动作）', true, block.includes(':data-sync-queue-id="row.queue_id"'))

  const syncSrc = read('src/services/sync.js')
  check('F6', '服务层零新建云函数（只打既有 feicui-shadow op 通道）', 'feicui-shadow', sync.SYNC_FUNCTION_NAME)
  check('F7', '服务层零 cloudfunctions 导入（不改 / 不直连云函数部署面）', 0, (syncSrc.match(/from '\.\.\/cloudfunctions/g) || []).length)
  check('F8', '本期实体封闭三值', ['books', 'persons', 'publishers'], [...sync.SYNC_ENTITIES])
  check('F9', '云队列状态六态冻结', ['APPLIED', 'APPROVED', 'CONFLICT', 'FAILED', 'PENDING', 'REJECTED'], [...sync.SYNC_QUEUE_STATUS].sort())

  /* 门面挂载（页面经 `services/index.js` 取，不直碰 `data/*`）。 */
  const indexSrc = read('src/services/index.js')
  check('F10', 'services/index.js 已挂 sync 门面', true, indexSrc.includes("import * as sync from './sync.js'"))
}

/* ===========================================================================
   G 段 · 状态门与幂等（本单：只有 `PENDING` 可动作 ＋ `CONFLICT`+APPLIED ⇒ 幂等成功）
   =========================================================================== */
console.log(JSON.stringify({ section: 'G', title: '状态门与幂等' }))
signIn('admin')

/* G1〜G10：`canApproveSyncRow` 逐态断言（六态 ＋ 空 ＋ 非物件）。 */
check('G1', 'SYNC_ACTIONABLE_STATUS ＝ PENDING（六态里唯一可动作态）', 'PENDING', sync.SYNC_ACTIONABLE_STATUS)
check('G2', 'PENDING ⇒ true', true, sync.canApproveSyncRow({ status: 'PENDING' }))
check('G3', 'APPROVED ⇒ false', false, sync.canApproveSyncRow({ status: 'APPROVED' }))
check('G4', 'REJECTED ⇒ false', false, sync.canApproveSyncRow({ status: 'REJECTED' }))
check('G5', 'APPLIED ⇒ false', false, sync.canApproveSyncRow({ status: 'APPLIED' }))
check('G6', 'FAILED ⇒ false', false, sync.canApproveSyncRow({ status: 'FAILED' }))
check('G7', 'CONFLICT ⇒ false', false, sync.canApproveSyncRow({ status: 'CONFLICT' }))
check('G8', '空状态 / 缺状态 / 空物件 ⇒ false', { a: false, b: false, c: false }, {
  a: sync.canApproveSyncRow({ status: '' }),
  b: sync.canApproveSyncRow({}),
  c: sync.canApproveSyncRow(null)
})
check('G9', '非物件（undefined / 字串 / 数字 / 数组）⇒ false', [false, false, false, false], [
  sync.canApproveSyncRow(undefined),
  sync.canApproveSyncRow('PENDING'),
  sync.canApproveSyncRow(42),
  sync.canApproveSyncRow(['PENDING'])
])
check('G10', 'canary：判据非恒真（PENDING 与 APPLIED 读数必须不同）', true, sync.canApproveSyncRow({ status: 'PENDING' }) !== sync.canApproveSyncRow({ status: 'APPLIED' }))

/* G11〜G26：`approveAndApply` 幂等门（**假 transport 计数** ⇒ 零网络、零库）。 */
{
  const appliedMsg = '队列项当前状态为 APPLIED，只允许从 PENDING 迁移；本次零寫入。'

  /* ① CONFLICT ＋ currentStatus=APPLIED ⇒ 幂等成功，且只发一次 approveQueue。 */
  const log = []
  installTransport(log, (event) =>
    event.action === 'approveQueue'
      ? { ok: false, reason: 'CONFLICT', message: appliedMsg }
      : { ok: true, queue_id: event.payload.queue_id, status: 'APPLIED' }
  )
  const idem = await sync.approveAndApply('q-idem', { currentStatus: 'APPLIED' })
  check('G11', 'CONFLICT ＋ currentStatus=APPLIED ⇒ 幂等成功（ok:true、reason 空）', { ok: true, reason: '' }, { ok: idem.ok, reason: idem.reason })
  check('G12', '幂等回包 item 恰四键 {stage,queue_id,status,idempotent}', { stage: 'done', queue_id: 'q-idem', status: 'APPLIED', idempotent: true }, idem.item)
  check('G13', '幂等文案逐字（該項已寫入（無需重複操作）；本次未重複寫入。）', '該項已寫入（無需重複操作）；本次未重複寫入。', idem.msg)
  check('G14', '只发一次 approveQueue（**零 applyUp**、零重复写）', ['approveQueue'], log.map((event) => event.action))
  check('G15', '幂等回包 ⇒ nextSyncRow 把行推到 APPLIED（视图上屏不报错）', 'APPLIED', sync.nextSyncRow({ queue_id: 'q-idem', status: 'PENDING' }, idem).status)

  /* ② CONFLICT ＋ currentStatus=PENDING ⇒ 仍失败（**显式状态为准**，不因 msg 含 APPLIED 放宽）。 */
  const log2 = []
  installTransport(log2, () => ({ ok: false, reason: 'CONFLICT', message: appliedMsg }))
  const conflict = await sync.approveAndApply('q-pending', { currentStatus: 'PENDING' })
  check('G16', 'CONFLICT ＋ currentStatus=PENDING ⇒ 仍 ok:false ＋ reason 透传', { ok: false, reason: 'CONFLICT' }, { ok: conflict.ok, reason: conflict.reason })
  check('G17', '该失败文案前缀「通過失敗：」一字未改', true, String(conflict.msg).startsWith('通過失敗：'))
  check('G18', '该失败仍零 applyUp（恰 1 发）', ['approveQueue'], log2.map((event) => event.action))
  check('G19', '该失败 item.stage ＝ approve（失败即停）', 'approve', conflict.item && conflict.item.stage)

  /* ③ 未给状态 ⇒ 退服务端读数：msg 含 APPLIED ⇒ 幂等。 */
  const log3 = []
  installTransport(log3, (event) =>
    event.action === 'approveQueue'
      ? { ok: false, reason: 'CONFLICT', message: appliedMsg }
      : { ok: true, queue_id: event.payload.queue_id, status: 'APPLIED' }
  )
  const sniff = await sync.approveAndApply('q-sniff')
  check('G20', '未给 options ＋ 服务端 msg 含 APPLIED ⇒ 幂等成功（服务端读数兜底）', { ok: true, idempotent: true }, { ok: sniff.ok, idempotent: !!(sniff.item && sniff.item.idempotent === true) })
  check('G21', '该幂等同样零 applyUp', ['approveQueue'], log3.map((event) => event.action))

  /* ④ 显式给了非 APPLIED 状态 ⇒ 即便 msg 含 APPLIED 也不放宽。 */
  const log4 = []
  installTransport(log4, () => ({ ok: false, reason: 'CONFLICT', message: appliedMsg }))
  const notApplied = await sync.approveAndApply('q-rej', { currentStatus: 'REJECTED' })
  check('G22', 'CONFLICT ＋ currentStatus=REJECTED ⇒ 仍失败（显式状态为准）', { ok: false, reason: 'CONFLICT' }, { ok: notApplied.ok, reason: notApplied.reason })
  check('G23', '该分支零 applyUp', ['approveQueue'], log4.map((event) => event.action))

  /* ⑤ 幂等门只认 CONFLICT（别的 reason 即便 currentStatus=APPLIED 也原样失败）。 */
  const log5 = []
  installTransport(log5, () => ({ ok: false, reason: 'FORBIDDEN', message: '僅管理員可以審閱斐萃同步變更；本次零寫入。' }))
  const forbidden = await sync.approveAndApply('q-forbid', { currentStatus: 'APPLIED' })
  check('G24', '非 CONFLICT（FORBIDDEN）＋ currentStatus=APPLIED ⇒ 仍失败', { ok: false, reason: 'FORBIDDEN' }, { ok: forbidden.ok, reason: forbidden.reason })

  /* ⑥ 正常两步成功不受影响，且回包**不带** idempotent 键。 */
  const log6 = []
  installTransport(log6, (event) =>
    event.action === 'approveQueue'
      ? { ok: true, queue_id: event.payload.queue_id, status: 'APPROVED' }
      : { ok: true, queue_id: event.payload.queue_id, status: 'APPLIED' }
  )
  const normal = await sync.approveAndApply('q-ok', { currentStatus: 'PENDING' })
  check('G25', '正常两步成功 ⇒ ok:true 且回包不带 idempotent 键', { ok: true, hasIdempotent: false }, { ok: normal.ok, hasIdempotent: !!(normal.item && 'idempotent' in normal.item) })
  check('G26', '正常两步顺序 ＝ approveQueue → applyUp（幂等分支不影响正路）', ['approveQueue', 'applyUp'], log6.map((event) => event.action))
  sync.resetSyncTransport()
}

/* G27〜G33：`partitionSyncRows`（保序 / 不改原数组 / 非数组 ⇒ 两空数组）。 */
{
  const rows = [
    { queue_id: 'q-1', status: 'PENDING' },
    { queue_id: 'q-2', status: 'APPLIED' },
    { queue_id: 'q-3', status: 'PENDING' },
    { queue_id: 'q-4', status: 'REJECTED' },
    { queue_id: 'q-5', status: 'APPLIED' }
  ]
  const snapshot = JSON.stringify(rows)
  const parts = sync.partitionSyncRows(rows)
  check('G27', 'pending 只含 PENDING（逐 id）', ['q-1', 'q-3'], parts.pending.map((row) => row.queue_id))
  check('G28', 'settled 保序（非 PENDING 按原序）', ['q-2', 'q-4', 'q-5'], parts.settled.map((row) => row.queue_id))
  check('G29', '原数组逐字未被改动（纯函数、零副作用）', snapshot, JSON.stringify(rows))
  check('G30', '两桶是新数组（不复用入参引用）', { pending: false, settled: false }, { pending: parts.pending === rows, settled: parts.settled === rows })
  check('G31', '两桶长度之和 ＝ 入参长度（不丢行）', rows.length, parts.pending.length + parts.settled.length)
  check('G32', '非数组（null / undefined / 物件 / 字串）⇒ 两空数组', [{ p: 0, s: 0 }, { p: 0, s: 0 }, { p: 0, s: 0 }, { p: 0, s: 0 }], [null, undefined, {}, 'x'].map((input) => {
    const out = sync.partitionSyncRows(input)
    return { p: out.pending.length, s: out.settled.length }
  }))
  check('G33', 'canary：混合输入两桶不等长（判据非恒等）', true, parts.pending.length !== parts.settled.length)
}

/* ===========================================================================
   H 段 · 面板状态门静态面 ＋ 变异负对照（按钮按 PENDING 收窄 / 开关 / 两条新钩子）
   =========================================================================== */
console.log(JSON.stringify({ section: 'H', title: '面板状态门静态面' }))
{
  const src = stripComments(read('src/views/MyCorrectionsView.vue'))
  const block = (src.match(/<section v-if="canSyncReview"[\s\S]*?<\/section>/) || [''])[0]
  const PENDING_GUARD = 'v-if="row.status === \'PENDING\'"'
  const NOT_PENDING_GUARD = 'v-if="row.status !== \'PENDING\'"'
  const actionButtons = (text) => text.match(/<button[^>]*data-action="sync-(?:approve|reject)"[^>]*>/g) || []

  check('H1', '审阅列恰两颗逐项按钮（通過並寫入 / 駁回）', 2, actionButtons(block).length)
  check('H2', '两颗按钮标签内都含 `row.status === \'PENDING\'` 条件', 2, actionButtons(block).filter((tag) => tag.includes(PENDING_GUARD)).length)
  check('H3', '非待审行渲染状态字样（`data-sync-settled` 恰 1 处、不置灰按钮不占位）', 1, (block.match(/data-sync-settled(?![-\w])/g) || []).length)
  check('H4', '状态字样按 `row.status !== \'PENDING\'` 渲染', 1, (block.match(/<[^>]*data-sync-settled(?![-\w])[^>]*>/g) || []).filter((tag) => tag.includes(NOT_PENDING_GUARD)).length)
  check('H5', '状态字样复用 syncStatusLabel（不另造文案）', true, block.includes('{{ syncStatusLabel(row.status) }}'))
  check('H6', '「僅顯示待審」开关钩子 `data-sync-pending-only` 恰 1 处', 1, (src.match(/data-sync-pending-only(?![-\w])/g) || []).length)
  check('H7', '开关默认开（ref(true)）', true, src.includes('const syncPendingOnly = ref(true)'))
  check('H8', '上屏行经服务层 partitionSyncRows 分流（开 ⇒ 只列 pending）', true, src.includes('sync.partitionSyncRows(syncRows.value)') && src.includes('syncPartition.value.pending'))
  check('H9', '已处理计数钩子 `data-sync-settled-count` 恰 1 处', 1, (src.match(/data-sync-settled-count/g) || []).length)
  check('H10', '计数行文案如实（「另有 N 條已處理」）', true, block.includes('另有 {{ syncSettledCount }} 條已處理'))
  check('H11', '计数行只在开关开且 N>0 时上屏', true, block.includes('v-if="syncPendingOnly && syncSettledCount > 0"'))
  check('H12', '通过并写入带上本行状态读数（幂等判据输入）', true, src.includes('sync.approveAndApply(id, { currentStatus: row.status })'))
  check('H13', '幂等回包不报错（上屏「該項已寫入（無需重複操作）」）', true, src.includes('\'該項已寫入（無需重複操作）\''))
  check('H14', '幂等回包按 nextSyncRow 推进行（行落 APPLIED）', true, src.includes('sync.nextSyncRow(item, result)'))
  check('H15', '表只列上屏行（v-for 走 syncVisibleRows）', true, block.includes('v-for="row in syncVisibleRows"'))
  check('H16', '段内 data-admin-action 取值仍 0（不污染冻结集合）', 0, (block.match(/data-admin-action=/g) || []).length)
  check('H17', '段内 data-action 取值集仍恰四值（开关不新增 data-action）', ['sync-approve', 'sync-clear-target', 'sync-refresh', 'sync-reject'], [...new Set((block.match(/data-action="(sync-[a-z-]+)"/g) || []).map((raw) => raw.replace('data-action="', '').replace('"', '')))].sort())

  /* ---- 变异负对照①：剥掉按钮上的 status 条件 ⇒ 同一把尺子必须翻红 ---- */
  const mutatedView = block.replace(/v-if="row\.status === 'PENDING'"/g, '')
  check('M1', '变异①基线：原源两颗按钮守卫命中 2', 2, actionButtons(block).filter((tag) => tag.includes(PENDING_GUARD)).length)
  check('M2', '变异①：剥掉 status 条件后同一把尺子命中 0 ⇒ 静态断言必红', 0, actionButtons(mutatedView).filter((tag) => tag.includes(PENDING_GUARD)).length)
  check('M3', '变异①：变异源确实被改到（守卫 2 → 0）', 2, (block.match(/v-if="row\.status === 'PENDING'"/g) || []).length - (mutatedView.match(/v-if="row\.status === 'PENDING'"/g) || []).length)

  /* ---- 变异负对照②：幂等分支是红绿分界（同一 CONFLICT+APPLIED 回包、判据不成立 ⇒ 必须红） ---- */
  const syncSrc = stripComments(read('src/services/sync.js'))
  check('M4', '变异②基线：幂等分支在服务层源码（剥注释后命中）', true, syncSrc.includes('isAlreadyApplied(options, approved)'))
  const mLog = []
  installTransport(mLog, () => ({ ok: false, reason: 'CONFLICT', message: '队列项当前状态为 APPLIED，只允许从 PENDING 迁移；本次零寫入。' }))
  const mConflict = await sync.approveAndApply('q-mutant', { currentStatus: 'PENDING' })
  check('M5', '变异②：判据不成立时同一回包回旧口径失败（ok:false，与 G11 的 ok:true 分界）', false, mConflict.ok)
  check('M6', '变异②：失败侧 reason 仍 CONFLICT（不吞错）', 'CONFLICT', mConflict.reason)
  check('M7', '变异②：失败侧零 applyUp', ['approveQueue'], mLog.map((event) => event.action))
  sync.resetSyncTransport()
}

/* --------------------------------------------------------------------------- 汇总 */
const summary = {
  total: results.length,
  passed: results.filter((item) => item.pass).length,
  failed: failures,
  ids: results.map((item) => item.id)
}
console.log(JSON.stringify({ summary }))
if (failures > 0) {
  console.error(`FAIL ${failures}/${results.length}`)
  process.exit(1)
}
console.log(`PASS ${summary.passed}/${summary.total}`)
