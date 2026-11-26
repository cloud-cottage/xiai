/**
 * 玺爱 · **自检：「金」余额上屏统一到云端权威账本**（本單）
 * ============================================================================
 * **本地、离线**（注入 `setCloudFunctionTransport` 缝 ＋ `setWriteFaceModeOverride('cloud')`，
 * 零云端、零真实网络）：直接驱动 `src/services/points.js` 的服务层单点，
 * 按「未登录 / 请求失败 / 云端回 0」三态逐条判，并静态核对上屏接线。
 *
 *   A  **未登录**：`loadCloudPoints()` **零请求**回 `{ok:false}`；`displayPoints()` 显 0（guest）。
 *   B  **已登录 · 云端回 0**：`loadCloudPoints()` 成功；`displayPoints()` 显 **0**（cloud）
 *      —— 本机 `users` 行仍是 170（**零写入**），证明页头不会再显 170。
 *   C  **已登录 · 云端请求失败**：`loadCloudPoints()` `{ok:false}`（不抛、不弹窗）；
 *      `displayPoints()` 回落本机 170 ＋ `本機記錄（未取得雲端餘額）` 标注。
 *   D  **换账号**：上一位的云端读数不串号（uid 不匹配 ⇒ 回落本行）。
 *   E  **回包缺读数**：`ok:true` 但无 `points` ⇒ **不编造 0**，按「没取到」回落。
 *   F  **静态接线**：页头 / 積分中心 / 我的名刺只经 `displayPoints()`；`getPointsBalance`
 *      字面值只落在服务层单点；页头与積分中心源码零直读本机余额。
 *
 * 纪律：断言失败 ⇒ 退出码 1；不打印任何明文密钥 / 令牌；本套件**零写入**被测账本。
 */
/* **测试环境保护哨兵（硬防线）**：本套件只跑注入缝，绝不碰真实 CARD / 云端。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const { setCloudFunctionTransport } = await load('src/data/cloudbaseFn.js')
const { setWriteFaceModeOverride, WRITE_FACE_MODES } = await load('src/data/writeFaceMode.js')
const session = await load('src/data/session.js')
const points = await load('src/services/points.js')

/* --------------------------------------------------------------------------- 0. 断言 / 读数 */
let total = 0
let passed = 0
const failedIds = []

function check(id, title, expected, actual) {
  total += 1
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (pass) passed += 1
  else failedIds.push(id)
  console.log(JSON.stringify({ id, case: title, pass, expected, actual }))
}

const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

/** 云端账本「真值」回包（Kevin 实测：uid `u-91c5c051ff4eb59d` 最新 `balance_after = 0`）。 */
const CLOUD_ZERO = { ok: true, op: 'getPointsBalance', points: 0, updated_at: '2026-11-26T04:10:18Z' }
const LOCAL_USER = {
  id: 'u-91c5c051ff4eb59d',
  phone: '13800000000',
  nickname: '印友0000',
  role: 'user',
  points: 170,
  created_at: '2026-11-20T00:00:00.000Z'
}
const FALLBACK_NOTE = '本機記錄（未取得雲端餘額）'

/** 记录每一次云函数调用（name / data），供「零请求」「载荷封闭零键」判据取数。 */
let wire = []
function recordTransport(replyFactory) {
  setCloudFunctionTransport((name, data) => {
    wire.push({ name, data })
    return replyFactory()
  })
}
const okReply = (result) => () => ({ result })

/* ===========================================================================
   A. 未登录 ⇒ 不请求、显 0
   =========================================================================== */
setWriteFaceModeOverride(WRITE_FACE_MODES.CLOUD)
wire = []
session.setUser(null)
recordTransport(okReply(CLOUD_ZERO))

const A1 = await points.loadCloudPoints()
const A2 = points.displayPoints()
check('A1', '未登录 ⇒ `loadCloudPoints()` 回 `{ok:false}` 且**零请求**（transport 零命中）', { ok: false, calls: 0 }, { ok: A1.ok, calls: wire.length })
check('A2', '未登录 ⇒ `displayPoints()` 显 0（guest、无标注；页头 `v-if=logged` 不渲染金钮）', { points: 0, source: 'guest', fallback: false, note: '' }, { points: A2.points, source: A2.source, fallback: A2.fallback, note: A2.note })

/* ===========================================================================
   C. 已登录 · 云端请求失败 ⇒ 回落本机 ＋ 标注（不抛、不弹窗）
   （先跑 C 再跑 B：服务层失败**不清**上一次成功读数，故 C 必须在「从未成功」的态上判）
   =========================================================================== */
wire = []
session.setUser({ ...LOCAL_USER })
recordTransport(() => ({ ok: false, reason: 'STORAGE_UNAVAILABLE', message: '雲端校驗請求失敗（網路異常），本次未寫入。' }))

let C1 = null
let C1Threw = false
try {
  C1 = await points.loadCloudPoints()
} catch {
  C1Threw = true
}
const C2 = points.displayPoints()
check('C1', '请求失败 ⇒ 零抛错、回 `{ok:false}`（服务端/传输层原话透传），请求已发出 1 次', { threw: false, ok: false, reason: 'STORAGE_UNAVAILABLE', calls: 1 }, { threw: C1Threw, ok: C1 && C1.ok, reason: C1 && C1.reason, calls: wire.length })
check('C2', '请求失败 ⇒ 回落本机 170 ＋ `本機記錄（未取得雲端餘額）` 标注（fallback=true）', { points: 170, source: 'local', fallback: true, note: FALLBACK_NOTE }, { points: C2.points, source: C2.source, fallback: C2.fallback, note: C2.note })
check('C3', '失败请求走**既有用户令牌通道**（函数 `xiai-user-token` ＋ `action:verify` ＋ op `getPointsBalance` ＋ 载荷零键）', { fn: 'xiai-user-token', action: 'verify', op: 'getPointsBalance', payloadKeys: 0 }, { fn: wire[0] && wire[0].name, action: wire[0] && wire[0].data && wire[0].data.action, op: wire[0] && wire[0].data && wire[0].data.op, payloadKeys: wire[0] && wire[0].data && wire[0].data.payload ? Object.keys(wire[0].data.payload).length : -1 })

/* ===========================================================================
   E. 回包 `ok:true` 但缺 `points` 读数 ⇒ 不编造 0（按「没取到」回落）
   （同样排在「从未成功」的态上：共享读数一旦成功过就按设计保留最后一次成功值）
   =========================================================================== */
wire = []
recordTransport(okReply({ ok: true, op: 'getPointsBalance' }))
const E1 = await points.loadCloudPoints()
const E2 = points.displayPoints()
check('E1', '回包缺 `points` 读数 ⇒ `{ok:false}`（**绝不把「没取到」写成 0**）', { ok: false, reason: 'STORAGE_UNAVAILABLE' }, { ok: E1.ok, reason: E1.reason })
check('E2', '缺读数 ⇒ 共享读数未被污染，仍回落本机 170 ＋ 标注', { points: 170, source: 'local', fallback: true, note: FALLBACK_NOTE }, { points: E2.points, source: E2.source, fallback: E2.fallback, note: E2.note })

/* ===========================================================================
   B. 已登录 · 云端回 0 ⇒ 页头显 **0 金**（本机 170 原封不动、零写入）
   =========================================================================== */
wire = []
recordTransport(okReply(CLOUD_ZERO))
const B1 = await points.loadCloudPoints()
const B2 = points.displayPoints()
check('B1', '云端回 0 ⇒ `loadCloudPoints()` `{ok:true, points:0, updated_at}`', { ok: true, points: 0, updated_at: CLOUD_ZERO.updated_at }, { ok: B1.ok, points: B1.points, updated_at: B1.updated_at })
check('B2', '云端读数可用 ⇒ `displayPoints()` 显 **0**（cloud、无回落标注）—— 不再是本机 170', { points: 0, source: 'cloud', fallback: false, note: '' }, { points: B2.points, source: B2.source, fallback: B2.fallback, note: B2.note })
check('B3', '本机 `users` 行 `points` 仍 170（服务层**零写入**、零补记；只改展示口径）', 170, session.sessionState.user && session.sessionState.user.points)
check('B4', '共享读数归当前 uid（`cloudPoints.uid` ＝ 本机行 id）', LOCAL_USER.id, points.cloudPoints.uid)

/* ===========================================================================
   D. 换账号 ⇒ 上一位的云端读数不串号（回落本行 ＋ 标注）
   =========================================================================== */
session.setUser({ ...LOCAL_USER, id: 'u-other', points: 88 })
const D1 = points.displayPoints()
check('D1', '换账号（云端读数属上一位 uid）⇒ 回落本机 88 ＋ 标注，**不显示上一位的 0**', { points: 88, source: 'local', fallback: true, note: FALLBACK_NOTE }, { points: D1.points, source: D1.source, fallback: D1.fallback, note: D1.note })

/* ===========================================================================
   F. 静态接线（上屏只经一个派生；服务层单点只此一处）
   =========================================================================== */
const ALL_SRC = ['src/components/AppHeader.vue', 'src/views/PointsView.vue', 'src/views/MeView.vue']
const srcText = ALL_SRC.map(read).join('\n')

/* 调用点＝`computed(() => …displayPoints())` 形态的真调用（注释里的字面提法不计）。 */
const callSites = srcText.split('\n').filter((line) => /computed\(\(\)\s*=>[^\n]*displayPoints\(/.test(line)).length
check('F1', '页头 / 積分中心 / 我的名刺**都调** `displayPoints()`（调用点恰 3、定义恰 1 处且在服务层）', { calls: 3, defs: 1 }, { calls: callSites, defs: (read('src/services/points.js').match(/export function displayPoints\(/g) || []).length })
check('F2', '页头 / 積分中心源码**零直读**本机余额（无 `goldBalance` / `state.user.points` / `getBalance()`）', [], ALL_SRC.flatMap((rel) => read(rel).split('\n').map((line, i) => ({ rel, line: i + 1, text: line })).filter((row) => /goldBalance|state\.user\.points|getBalance\(/.test(row.text)).map((row) => `${row.rel}:${row.line}`)))
check('F3', '`getPointsBalance` 字面值只落在服务层单点 `src/services/points.js`（调用经 `userGate`，非字面）', ['src/services/points.js'], [...new Set(scanOpLiteral())].sort())

/** 全 `src/**` 扫 `getPointsBalance` 字面值所在文件（零依赖、递归）。 */
function scanOpLiteral() {
  const hits = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(js|vue|mjs)$/.test(name) && readFileSync(full, 'utf8').includes('getPointsBalance')) {
        hits.push(path.relative(ROOT, full).split(path.sep).join('/'))
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  return hits
}

/* --------------------------------------------------------------------------- 汇总 */
setCloudFunctionTransport(null)
setWriteFaceModeOverride(null)
console.log(JSON.stringify({ summary: { total, passed, failed: total - passed, failed_ids: failedIds } }))
if (failedIds.length > 0) process.exit(1)
