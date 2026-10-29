/**
 * 玺爱 · **自检：积分（「金」）云端权威账本**（本单新增）
 * ============================================================================
 * **本地、离线**（自造 DB 假体注入；零外部网络、零云端连接）。被测件：
 *   · `cloudfunctions/xiai-user-token/lib/ledger.js`（唯一账本实现点）
 *   · `cloudfunctions/xiai-user-token/lib/ops.js` 的两个新 op
 *     （`getPointsBalance` / `listPointsFlow`；走既有登录令牌门）
 *   · `cloudfunctions/xiai-user-token/index.js` 信封（op 收窄的 additive 透传）
 *
 * 断言面（≥ 10；本套 28 条：A 段 15 ＋ B 段 4 ＋ C 段 9）：
 *   A. 账本单点（注入假存储，直接跑真函数）
 *      ① 同 uid **并发**两笔 charge 各 5 金、初始 50 ⇒ **恒 40（不得 45）** —— 并附
 *         **负对照**（同一交错下朴素读改写 ⇒ 45 ⇒ 证明测试台真能测出丢更新）；
 *      ② 同一 `idem_key` 连打 3 次 ⇒ 流水 +1、余额只减一次、后续调用回首次结果；
 *         同键**并发**两路 ⇒ 一路写、一路轮询回放，仍只减一次；
 *      ③ 余额不足 ⇒ `INSUFFICIENT_POINTS` ＋ **零写入**（流水行数 / 余额均不变）；
 *      ④ 退款不删原行（`REFUND` 正向流水、`ref_id` 与原 `CHARGE` 相同、余额复原）；
 *      ⑤ 初始 50 幂等发放（串行 / 并发都只发一次，带 `INITIAL` 流水）；
 *      ⑥ 回包键集不多不少（余额行恰 4 键、流水行恰 9 键、流水回包恰 6 键且**零 uid**）；
 *      ⑦ 值域门（amount / kind / ref_type / idem_key / ref_id）⇒ 结构化拒绝 ＋ 零写入；
 *      ⑧ 写入中断自愈（未结算预留行同键重放 ⇒ 恰一次扣减、不新增行）；
 *      ⑨ 流水清单分页（`limit` 上界 1000、`cursor` 偏移、两页并集无重叠）。
 *   B. 信封（真 `index.js` 本体 ＋ 真签发令牌 ＋ 注入假 DB）：
 *      新 op 走登录令牌门、回包形状、非白名单键 ⇒ `INVALID_FIELD` ＋ 零写入、
 *      未知 op ⇒ 结构化拒、无令牌 ⇒ `FORBIDDEN`。
 *   C. 静态门：账本文件**零取句柄字面**（守既有 A8 / A8b / D4 同尺）、两个新集合
 *      **不进** `COLLECTIONS` / `CLOUD_COLLECTIONS` / `CLOUD_COLLECTION_KEYS`（仍 8 键）、
 *      新 reason 字面值逐字登记、`index.js` 透传块按 op 收窄；
 *      **＋ C7（2026-10-29 单新增；应急修单加严）**：`lib/ops.js` 客户端初始化**单点门** ——
 *      `tcb.init(` 的每个调用点都经同一个本地函数 `initClientFromEnv()`（全文件恰 1 处、
 *      只在该函数体内；无裸 `tcb.init({ env: envId })`）、`secretId` / `secretKey` 显式
 *      赋值语句在场（无密钥对 ⇒ 不带凭据 init ⇒ 云函数环境行为不变）；**加严**：`lib/ops.js`
 *      全文零命中 `TENCENTCLOUD_`、`CLOUDBASE_SECRET_ID` / `CLOUDBASE_SECRET_KEY`
 *      各恰 1 处且就在 `process.env.` 取值处、取值单点 `cloudbaseKeyPairFromEnv()`
 *      定义／调用各恰 1、旧解析器引用 0（云函数侧只认 `CLOUDBASE_*`：平台族凭据是
 *      **临时凭据、需 session token**，只传 id / key ⇒ `SIGN_PARAM_INVALID`）；
 *      **＋ C8 负对照**：真源码副本注入一行平台族变量取值 ⇒ **同一扫描谓词必判红**
 *      （判据非恒绿）；**＋ C9 取值面**：导出的 `cloudbaseKeyPairFromEnv()` 直接跑
 *      （两族均在成对／只给平台族空对／两族各半空对／全缺空对）。
 *
 * 纪律：断言失败 ⇒ 退出码 1；不打印任何密钥 / 令牌原文。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

/* 合成测试环境（缺省才写；**脚本内不写任何真实密钥** —— secret 走运行期随机）。 */
process.env.XIAI_USER_SMS_CODE = String(process.env.XIAI_USER_SMS_CODE || '729341').trim()
if (!process.env.XIAI_USER_TOKEN_SECRET) process.env.XIAI_USER_TOKEN_SECRET = randomBytesHex()
process.env.XIAI_USER_TOKEN_SECRET = String(process.env.XIAI_USER_TOKEN_SECRET).trim()
process.env.XIAI_USER_TOKEN_VERSION = process.env.XIAI_USER_TOKEN_VERSION || '1'

function randomBytesHex() {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex')
}

const ledger = require(path.join(FN_DIR, 'lib/ledger.js'))
const ops = require(path.join(FN_DIR, 'lib/ops.js'))
const userConfig = require(path.join(FN_DIR, 'lib/config.js'))
const fn = require(path.join(FN_DIR, 'index.js'))

/* ---------------------------------------------------------------------------
   断言 / 读数（与既有 24 个脚本同形）
   --------------------------------------------------------------------------- */

let total = 0
let passed = 0
const failedIds = []
const sectionStats = {}

function section(name, title) {
  if (!sectionStats[name]) sectionStats[name] = { total: 0, passed: 0 }
  console.log(JSON.stringify({ section: name, title }))
}

function check(id, title, expected, actual) {
  total += 1
  const sec = id.slice(0, 1)
  if (!sectionStats[sec]) sectionStats[sec] = { total: 0, passed: 0 }
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (pass) {
    passed += 1
    sectionStats[sec].passed += 1
  } else {
    failedIds.push(id)
  }
  sectionStats[sec].total += 1
  console.log(JSON.stringify({ id, case: title, pass, expected, actual }))
}

const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const isDenial = (value) => value && value.ok === false && shapeOf(value) === 'message,ok,reason'

/* ---------------------------------------------------------------------------
   内存假 DB（形状对齐真实 SDK 的使用面；**每次操作前让出事件循环** ⇒ 真并发交错）
   —— `where(...).update(...)` 在**执行时**按过滤条件匹配（＝单文档条件更新语义）。
   --------------------------------------------------------------------------- */

const tick = () => new Promise((resolve) => setImmediate(resolve))
const rowMatches = (row, match) => Object.keys(match).every((key) => row[key] === match[key])

function createFakeDb() {
  const buckets = new Map()
  const bucketOf = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    return buckets.get(name)
  }
  function makeQuery(map, state) {
    return {
      orderBy(field, direction) {
        return makeQuery(map, Object.assign({}, state, { order: { field, direction } }))
      },
      skip(count) {
        return makeQuery(map, Object.assign({}, state, { skip: count }))
      },
      limit(count) {
        return makeQuery(map, Object.assign({}, state, { limit: count }))
      },
      async get() {
        await tick()
        let rows = [...map.values()].filter((row) => rowMatches(row, state.match || {})).map((row) => Object.assign({}, row))
        if (state.order) {
          const { field, direction } = state.order
          rows = rows.sort((a, b) => {
            const left = a[field]
            const right = b[field]
            const cmp = left < right ? -1 : left > right ? 1 : 0
            return direction === 'desc' ? -cmp : cmp
          })
        }
        if (state.skip) rows = rows.slice(state.skip)
        if (state.limit) rows = rows.slice(0, state.limit)
        return { data: rows }
      },
      async update(patch) {
        await tick()
        let updated = 0
        for (const row of map.values()) {
          if (rowMatches(row, state.match || {})) {
            Object.assign(row, patch)
            updated += 1
          }
        }
        return { updated }
      }
    }
  }
  const db = {
    bucketOf,
    collection(name) {
      const map = bucketOf(name)
      return {
        doc(id) {
          return {
            async get() {
              await tick()
              const row = map.get(id)
              return { data: row ? Object.assign({}, row) : null }
            },
            async update(patch) {
              await tick()
              const row = map.get(id)
              if (!row) return { updated: 0 }
              Object.assign(row, patch)
              return { updated: 1 }
            },
            async set(doc) {
              await tick()
              map.set(id, Object.assign({ _id: id }, doc))
              return { updated: 1 }
            }
          }
        },
        async add(doc) {
          await tick()
          const id = typeof doc._id === 'string' && doc._id !== '' ? doc._id : `gen-${map.size + 1}-${Math.random().toString(36).slice(2, 8)}`
          if (map.has(id)) throw new Error('FAKE_DUPLICATE_ID')
          map.set(id, Object.assign({ _id: id }, doc))
          return { _id: id }
        },
        where(match) {
          return makeQuery(map, { match })
        }
      }
    }
  }
  return db
}

const fakeDb = createFakeDb()
const balanceMapOf = (uid) => fakeDb.bucketOf('xiai_balances').get(`bl-${uid}`) || null
const flowRowsOf = (uid) => [...fakeDb.bucketOf('xiai_points_flow').values()].filter((row) => row.uid === uid)
const flowCount = (uid) => flowRowsOf(uid).length
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* 账本函数直接注入假存储（生产不注入 ⇒ 走 ops.resolveLedgerStore 的真句柄）。 */
ledger.setLedgerStoreProvider(() => ({
  balances: fakeDb.collection('xiai_balances'),
  flow: fakeDb.collection('xiai_points_flow')
}))

/* ===========================================================================
   A 段：账本单点（真函数 ＋ 注入假存储）
   =========================================================================== */
section('A', '账本单点：并发不丢更新 / 冪等 / 零写入 / 退款 / 初始幂等 / 键面 / 值域门 / 自愈 / 分页')

const KEY = (label) => `idem-${label}-${Math.random().toString(36).slice(2, 8)}`

/* A1：初始 50 幂等发放（串行两次）＋ 键面恰 4 键 / 9 键。 */
{
  const uid = 'u-a1test'
  const first = await ledger.ensureBalance(uid, ledger.DEFAULT_INITIAL_POINTS)
  const second = await ledger.ensureBalance(uid, ledger.DEFAULT_INITIAL_POINTS)
  const row = balanceMapOf(uid)
  const initialRows = flowRowsOf(uid).filter((r) => r.ref_type === 'INITIAL')
  check('A1', '初始 50 幂等发放：首发放 / 再调不发；余额行键面恰 4 键；INITIAL 流水恰 1 行（键面恰 9 键、_id=pf- 前缀）',
    { created: [true, false], points: 50, balanceKeys: ['_id', 'points', 'uid', 'updated_at'], initialRows: 1, flowKeys: ['_id', 'balance_after', 'created_at', 'delta', 'idem_key', 'kind', 'ref_id', 'ref_type', 'uid'], flowPrefix: true },
    {
      created: [first.created, second.created],
      points: row.points,
      balanceKeys: Object.keys(row).sort(),
      initialRows: initialRows.length,
      flowKeys: Object.keys(initialRows[0]).sort(),
      flowPrefix: initialRows[0]._id.startsWith('pf-') && row._id === `bl-${uid}`
    })
}

/* A2 ＋ A3：并发不丢更新（真账本 ⇒ 40）＋ 负对照（朴素读改写 ⇒ 45，证明测试台交错真实）。 */
{
  const uid = 'u-a2test'
  /* 先把余额行立起来（初始 50），再让两路朴素读改写去撞。 */
  await ledger.ensureBalance(uid, 50)
  /* 负对照：与账本同形的「读-等-写」朴素实现（无条件更新旧值）。 */
  const naiveCharge = async (amount) => {
    const map = fakeDb.bucketOf('xiai_balances')
    const row = map.get(`bl-${uid}`)
    await tick()
    map.set(row._id, Object.assign({}, row, { points: row.points - amount }))
  }
  await Promise.all([naiveCharge(5), naiveCharge(5)])
  const naiveFinal = balanceMapOf(uid) ? balanceMapOf(uid).points : null
  /* 负对照已把余额写脏 ⇒ 换一个干净 uid 跑真账本。 */
  const uidReal = 'u-a2real'
  await Promise.all([
    ledger.chargePoints({ uid: uidReal, amount: 5, kind: 'CHARGE', ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA000000001', idem_key: KEY('a2-a') }),
    ledger.chargePoints({ uid: uidReal, amount: 5, kind: 'CHARGE', ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA000000002', idem_key: KEY('a2-b') })
  ])
  const rows = flowRowsOf(uidReal)
  const charges = rows.filter((r) => r.kind === 'CHARGE')
  check('A2', '【并发硬证】同 uid 并发两笔 charge 各 5 金、初始 50 ⇒ 最终必须 40（不得 45）；流水恰 3 行（INITIAL+2 CHARGE）；两笔 balance_after 为 45/40',
    { finalPoints: 40, rows: 3, charges: 2, deltas: [-5, -5], afters: [40, 45] },
    (() => {
      const balance = balanceMapOf(uidReal)
      return {
        finalPoints: balance.points,
        rows: rows.length,
        charges: charges.length,
        deltas: charges.map((r) => r.delta).sort(),
        afters: charges.map((r) => r.balance_after).sort()
      }
    })())
  check('A3', '负对照（测试台自证）：同一交错下朴素读改写两笔 5 金 ⇒ 丢更新成 45 ⇒ A2 的 40 非恒绿',
    { naiveFinal: 45 },
    { naiveFinal })
}

/* A4：同一 idem_key 连打 3 次 ⇒ 流水 +1、余额只减一次、后两次回首次结果。 */
{
  const uid = 'u-a4test'
  const idem = KEY('a4')
  const call = () => ledger.chargePoints({ uid, amount: 5, kind: 'CHARGE', ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA000000001', idem_key: idem })
  const r1 = await call()
  const r2 = await call()
  const r3 = await call()
  check('A4', '冪等：同键 3 连击 ⇒ 流水只 +1 行、余额只减一次（50→45）、后两次 idempotent 且回首次 balance_after',
    { points: [45, 45, 45], idempotent: [false, true, true], flowRows: 2, chargeRows: 1 },
    {
      points: [r1.points, r2.points, r3.points],
      idempotent: [r1.idempotent, r2.idempotent, r3.idempotent],
      flowRows: flowCount(uid),
      chargeRows: flowRowsOf(uid).filter((r) => r.kind === 'CHARGE').length
    })
}

/* A5：同键并发两路 ⇒ 一路写、一路轮询回放；仍只减一次。 */
{
  const uid = 'u-a5test'
  const idem = KEY('a5')
  const call = () => ledger.chargePoints({ uid, amount: 5, kind: 'CHARGE', ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA000000001', idem_key: idem })
  const results = await Promise.all([call(), call()])
  check('A5', '冪等（并发面）：同键并发两路 ⇒ 恰一行 CHARGE 流水、余额只减一次、两路都回 45',
    { bothOk: true, points: [45, 45], chargeRows: 1, finalPoints: 45 },
    {
      bothOk: results.every((r) => r.ok),
      points: results.map((r) => r.points).sort(),
      chargeRows: flowRowsOf(uid).filter((r) => r.kind === 'CHARGE').length,
      finalPoints: balanceMapOf(uid).points
    })
}

/* A6：余额不足 ⇒ INSUFFICIENT_POINTS ＋ 零写入（恰 3 键拒绝）。 */
{
  const uid = 'u-a6test'
  await ledger.chargePoints({ uid, amount: 5, kind: 'CHARGE', ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA1', idem_key: KEY('a6-1') })
  const before = { points: balanceMapOf(uid).points, rows: flowCount(uid) }
  const denied = await ledger.chargePoints({ uid, amount: 60, kind: 'CHARGE', ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA1', idem_key: KEY('a6-2') })
  const after = { points: balanceMapOf(uid).points, rows: flowCount(uid) }
  check('A6', '余额不足 ⇒ reason=INSUFFICIENT_POINTS、拒绝恰 3 键、**零写入**（流水行数 / 余额均不变）',
    { ok: false, reason: 'INSUFFICIENT_POINTS', shape: 'message,ok,reason', unchanged: true },
    { ok: denied.ok, reason: denied.reason, shape: shapeOf(denied), unchanged: JSON.stringify(before) === JSON.stringify(after) })
}

/* A7：退款不删原行（REFUND 正向流水、ref_id 同原 CHARGE、余额复原）。 */
{
  const uid = 'u-a7test'
  const charge = await ledger.chargePoints({ uid, amount: 5, kind: 'CHARGE', ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA000000001', idem_key: KEY('a7-c') })
  const refund = await ledger.refundPoints({ uid, amount: 5, ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA000000001', idem_key: KEY('a7-r') })
  const rows = flowRowsOf(uid)
  const chargeRow = rows.find((r) => r.kind === 'CHARGE')
  const refundRow = rows.find((r) => r.kind === 'REFUND')
  check('A7', '退款不删原行：REFUND 正向流水（delta=+5）、ref_id 与原 CHARGE 相同、原 CHARGE 行仍在且未被改写、余额复原 50',
    { refundedPoints: 50, delta: 5, kind: 'REFUND', sameRef: true, originalKept: true, rows: 3 },
    {
      refundedPoints: refund.points,
      delta: refundRow.delta,
      kind: refundRow.kind,
      sameRef: refundRow.ref_id === chargeRow.ref_id && chargeRow.ref_id === 'XA000000001',
      originalKept: chargeRow.balance_after === 45 && rows.filter((r) => r.kind === 'CHARGE').length === 1,
      rows: rows.length
    })
  check('A7b', 'charge 成功回包键面恰 9 键（ok/points/balance_after/delta/kind/ref_type/ref_id/flow_id/created_at/idempotent 中不含 uid）',
    ['balance_after', 'created_at', 'delta', 'flow_id', 'idempotent', 'kind', 'ok', 'points', 'ref_id', 'ref_type'],
    Object.keys(charge).sort())
}

/* A8：发奖（REWARD / CORRECTION_ACCEPT）。 */
{
  const uid = 'u-a8test'
  const award = await ledger.awardPoints({ uid, amount: 10, ref_type: 'CORRECTION_ACCEPT', ref_id: 'cr-0001', idem_key: KEY('a8') })
  const row = flowRowsOf(uid).find((r) => r.ref_type === 'CORRECTION_ACCEPT')
  check('A8', '发奖：awardPoints +10（kind=REWARD、ref_type=CORRECTION_ACCEPT）⇒ 余额 60、流水 delta=+10',
    { points: 60, delta: 10, kind: 'REWARD' },
    { points: award.points, delta: row.delta, kind: row.kind })
}

/* A9：值域门（amount / kind / ref_type / idem_key / ref_id）⇒ 结构化拒绝 ＋ 零写入。 */
{
  const uid = 'u-a9test'
  await ledger.chargePoints({ uid, amount: 5, kind: 'CHARGE', ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA1', idem_key: KEY('a9-0') })
  const before = { points: balanceMapOf(uid).points, rows: flowCount(uid) }
  const cases = [
    ['amount 0', await ledger.chargePoints({ uid, amount: 0, ref_type: 'SEAL_DOWNLOAD', idem_key: KEY('a9-1') })],
    ['amount 3.5', await ledger.chargePoints({ uid, amount: 3.5, ref_type: 'SEAL_DOWNLOAD', idem_key: KEY('a9-2') })],
    ['amount 非数', await ledger.chargePoints({ uid, amount: '5', ref_type: 'SEAL_DOWNLOAD', idem_key: KEY('a9-3') })],
    ['kind 值域外', await ledger.chargePoints({ uid, amount: 5, kind: 'BOGUS', ref_type: 'SEAL_DOWNLOAD', idem_key: KEY('a9-4') })],
    ['ref_type 值域外', await ledger.chargePoints({ uid, amount: 5, ref_type: 'BOGUS', idem_key: KEY('a9-5') })],
    ['缺 idem_key', await ledger.chargePoints({ uid, amount: 5, ref_type: 'SEAL_DOWNLOAD' })],
    ['退款缺 ref_id', await ledger.refundPoints({ uid, amount: 5, ref_type: 'SEAL_DOWNLOAD', idem_key: KEY('a9-6') })],
    ['缺 uid', await ledger.chargePoints({ amount: 5, ref_type: 'SEAL_DOWNLOAD', idem_key: KEY('a9-7') })]
  ]
  const after = { points: balanceMapOf(uid).points, rows: flowCount(uid) }
  check('A9', '值域门：8 类非法入参全部结构化拒绝（reason 均 ∈ 冻结表）且**零写入**',
    { denied: 8, reasons: ['INVALID_VALUE', 'INVALID_VALUE', 'INVALID_VALUE', 'INVALID_VALUE', 'INVALID_VALUE', 'MISSING_REQUIRED', 'MISSING_REQUIRED', 'MISSING_REQUIRED'], frozen: true, unchanged: true, allDenialShapes: true },
    {
      denied: cases.filter(([, r]) => r.ok === false).length,
      reasons: cases.map(([, r]) => r.reason),
      frozen: cases.every(([, r]) => userConfig.REASONS[r.reason] === r.reason),
      unchanged: JSON.stringify(before) === JSON.stringify(after),
      allDenialShapes: cases.every(([, r]) => isDenial(r))
    })
}

/* A10：流水清单（投影 6 键 / 零 uid / 分页 / limit 上界）。 */
{
  const uid = 'u-a10test'
  await ledger.chargePoints({ uid, amount: 5, kind: 'CHARGE', ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA1', idem_key: KEY('a10-1') })
  await ledger.refundPoints({ uid, amount: 5, ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA1', idem_key: KEY('a10-2') })
  await ledger.awardPoints({ uid, amount: 10, ref_type: 'CORRECTION_ACCEPT', ref_id: 'cr-1', idem_key: KEY('a10-3') })
  const all = await ledger.listFlow(uid)
  const page1 = await ledger.listFlow(uid, { limit: 2 })
  const page2 = await ledger.listFlow(uid, { limit: 2, cursor: 2 })
  const overLimit = await ledger.listFlow(uid, { limit: 1001 })
  const zeroLimit = await ledger.listFlow(uid, { limit: 0 })
  const badCursor = await ledger.listFlow(uid, { cursor: -1 })
  const keySets = [...new Set(all.rows.map((row) => Object.keys(row).sort().join(',')))]
  const union = [...page1.rows, ...page2.rows]
  const unionKeys = union.map((row) => `${row.kind}|${row.ref_id}|${row.delta}`)
  check('A10', '流水清单：行投影恰 6 键（零 uid、零 _id）；count=rows 数；limit 1001 / 0 与负 cursor 均 INVALID_VALUE；两页并集无重叠且覆盖全部 4 行',
    { keys: ['balance_after', 'created_at', 'delta', 'kind', 'ref_id', 'ref_type'], count: 4, zeroIdentity: true, overLimit: 'INVALID_VALUE', zeroLimit: 'INVALID_VALUE', badCursor: 'INVALID_VALUE', pages: [2, 2, 4, 0] },
    {
      keys: keySets.length === 1 ? keySets[0].split(',') : keySets,
      count: all.count,
      zeroIdentity: all.rows.every((row) => !('uid' in row) && !('_id' in row)),
      overLimit: overLimit.reason,
      zeroLimit: zeroLimit.reason,
      badCursor: badCursor.reason,
      pages: [page1.rows.length, page2.rows.length, unionKeys.length, unionKeys.length - new Set(unionKeys).size]
    })
}

/* A11：写入中断自愈（未结算预留行同键重放 ⇒ 恰一次扣减、不新增行）。 */
{
  const uid = 'u-a11test'
  await ledger.chargePoints({ uid, amount: 5, kind: 'CHARGE', ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA1', idem_key: KEY('a11-0') })
  /* 模拟「预留行已落、余额未扣」的中断现场（balance_after: null ＝ 未结算）。 */
  const idem = 'idem-a11-resume'
  fakeDb.bucketOf('xiai_points_flow').set(ledger.flowIdOf(idem), {
    _id: ledger.flowIdOf(idem),
    uid,
    delta: -5,
    kind: 'CHARGE',
    ref_type: 'SEAL_DOWNLOAD',
    ref_id: 'XA1',
    idem_key: idem,
    balance_after: null,
    created_at: new Date().toISOString()
  })
  const before = { points: balanceMapOf(uid).points, rows: flowCount(uid) }
  const replay = await ledger.chargePoints({ uid, amount: 5, kind: 'CHARGE', ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA1', idem_key: idem })
  check('A11', '中断自愈：同键重放未结算预留行 ⇒ 恰一次扣减（45→40）、不新增流水行、balance_after 结算为整数',
    { points: 40, rowsBefore: before.rows, rowsAfter: flowCount(uid), settled: true },
    { points: replay.points, rowsBefore: before.rows, rowsAfter: flowCount(uid), settled: Number.isInteger(flowRowsOf(uid).find((r) => r.idem_key === idem).balance_after) })
}

/* A12：并发初始发放（两路 ensureBalance 同一新 uid ⇒ 只发一次）。 */
{
  const uid = 'u-a12test'
  const results = await Promise.all([
    ledger.ensureBalance(uid, 50),
    ledger.ensureBalance(uid, 50)
  ])
  check('A12', '初始发放（并发面）：两路 ensureBalance 同一新 uid ⇒ 恰一路 created=true、INITIAL 流水恰 1 行、余额 50',
    { createdCount: 1, initialRows: 1, points: 50, bothOk: true },
    {
      createdCount: results.filter((r) => r.created).length,
      initialRows: flowRowsOf(uid).filter((r) => r.ref_type === 'INITIAL').length,
      points: balanceMapOf(uid).points,
      bothOk: results.every((r) => r.ok)
    })
}

/* A13：读余额（首次读即发初始 50；回包恰 3 键）。 */
{
  const uid = 'u-a13test'
  const balance = await ledger.readBalance(uid)
  const again = await ledger.readBalance(uid)
  check('A13', 'readBalance：新用户首次读即幂等发初始 50（INITIAL 流水 1 行）；回包恰 3 键 {ok,points,updated_at}',
    { points: 50, keys: ['ok', 'points', 'updated_at'], initialRows: 1, stable: 50 },
    { points: balance.points, keys: Object.keys(balance).sort(), initialRows: flowRowsOf(uid).length, stable: again.points })
}

/* A14（本单新增 · 「读不存在的文档会抛错」收尾）：readBalanceRow / readFlowRow 在 doc().get()
   抛「不存在」类（code 404；生产 SDK 真实形态：文档不存在 ⇒ HTTP 404 ⇒ TcbError.code === 404）
   时**不抛、回 null**；非不存在类（code 500）仍照旧上抛（不吞真存储故障）。 */
{
  const notExistCollection = (real, docError) => ({
    doc() {
      return {
        async get() {
          await tick()
          throw docError
        }
      }
    },
    where(match) {
      return real.where(match)
    }
  })
  const notExist404 = Object.assign(new Error('404 Not Found | [synthetic]'), { code: 404 })
  const realFault500 = Object.assign(new Error('storage internal error | [synthetic]'), { code: 500 })
  const throwingStore = (docError) => () => ({
    balances: notExistCollection(fakeDb.collection('xiai_balances'), docError),
    flow: notExistCollection(fakeDb.collection('xiai_points_flow'), docError)
  })
  ledger.setLedgerStoreProvider(throwingStore(notExist404))
  const balanceRow = await ledger.readBalanceRow('u-a14-no-such-user')
  const flowRow = await ledger.readFlowRow('pf-no-such-flow')
  ledger.setLedgerStoreProvider(throwingStore(realFault500))
  let caught = null
  try {
    await ledger.readBalanceRow('u-a14-no-such-user')
  } catch (error) {
    caught = error
  }
  ledger.setLedgerStoreProvider(() => ({
    balances: fakeDb.collection('xiai_balances'),
    flow: fakeDb.collection('xiai_points_flow')
  }))
  check('A14', 'doc().get() 抛不存在类（code 404）⇒ readBalanceRow / readFlowRow 回 null（不抛）；抛非不存在类（code 500）⇒ 照旧上抛',
    { balance: null, flow: null, faultRethrown: 500 },
    { balance: balanceRow, flow: flowRow, faultRethrown: caught === null ? null : caught.code })
}

/* ===========================================================================
   B 段：信封（真 index.js 本体 ＋ 真签发令牌 ＋ 注入假 DB；走既有登录令牌门）
   =========================================================================== */
section('B', '信封：新 op 走令牌门 / 回包形状 / 非白名单键零写入 / 未知 op 结构化拒')

ledger.setLedgerStoreProvider(null) /* 清除账本直注 ⇒ 走 ops.resolveLedgerStore（同一假 DB）。 */
ops.setOpsDbProvider(() => fakeDb)

const PHONE = String(process.env.XIAI_USER_PHONE || '13800000099').trim()
const issued = await fn.main({ action: 'issue', phone: PHONE, code: process.env.XIAI_USER_SMS_CODE })
const token = issued.token
const envelopeUid = issued.uid

/* B0：先经账本给该用户落一笔扣费（制造多行流水）。 */
await ledger.chargePoints({ uid: envelopeUid, amount: 5, kind: 'CHARGE', ref_type: 'SEAL_DOWNLOAD', ref_id: 'XA000000007', idem_key: KEY('b0') })

/* B1：getPointsBalance 经信封。 */
{
  const first = await fn.main({ action: 'verify', op: 'getPointsBalance', token, payload: {} })
  const again = await fn.main({ action: 'verify', op: 'getPointsBalance', token, payload: {} })
  const wire = JSON.parse(JSON.stringify(first))
  check('B1', 'getPointsBalance（信封）：ok=true、points/updated_at 透传、首读已发初始 50、二次读稳定；INITIAL 流水恰 1 行',
    { ok: true, points: 45, again: 45, hasPoints: true, hasUpdatedAt: true, initialRows: 1, op: 'getPointsBalance' },
    {
      ok: first.ok,
      points: first.points,
      again: again.points,
      hasPoints: typeof wire.points === 'number',
      hasUpdatedAt: typeof wire.updated_at === 'string' && wire.updated_at !== '',
      initialRows: flowRowsOf(envelopeUid).filter((r) => r.ref_type === 'INITIAL').length,
      op: first.op
    })
}

/* B2：listPointsFlow 经信封（回包零 uid）。 */
{
  const reply = await fn.main({ action: 'verify', op: 'listPointsFlow', token, payload: {} })
  const wire = JSON.parse(JSON.stringify(reply))
  check('B2', 'listPointsFlow（信封）：rows 恰 6 键逐行、count=rows 数、行内零 uid / 零 _id；INITIAL+CHARGE 两行在列',
    { ok: true, count: 2, rows: 2, keys: ['balance_after', 'created_at', 'delta', 'kind', 'ref_id', 'ref_type'], zeroIdentity: true },
    {
      ok: reply.ok,
      count: reply.count,
      rows: Array.isArray(wire.rows) ? wire.rows.length : null,
      keys: Array.isArray(wire.rows) && wire.rows.length > 0 ? Object.keys(wire.rows[0]).sort() : [],
      zeroIdentity: Array.isArray(wire.rows) ? wire.rows.every((row) => !('uid' in row) && !('_id' in row)) : false
    })
}

/* B3 / B4：非白名单键 ⇒ INVALID_FIELD ＋ 零写入。 */
{
  const before = { points: balanceMapOf(envelopeUid).points, rows: flowCount(envelopeUid) }
  const balanceHack = await fn.main({ action: 'verify', op: 'getPointsBalance', token, payload: { points: 999 } })
  const flowHack = await fn.main({ action: 'verify', op: 'listPointsFlow', token, payload: { user_id: 'u-evil', limit: 10 } })
  const after = { points: balanceMapOf(envelopeUid).points, rows: flowCount(envelopeUid) }
  check('B3', '非白名单键 ⇒ INVALID_FIELD ＋ 零写入：getPointsBalance 塞 {points:999} / listPointsFlow 塞 {user_id} 均被拒（身份类键提示不采信）',
    { balance: { ok: false, reason: 'INVALID_FIELD' }, flow: { ok: false, reason: 'INVALID_FIELD' }, unchanged: true, identityHint: true },
    {
      balance: { ok: balanceHack.ok, reason: balanceHack.reason },
      flow: { ok: flowHack.ok, reason: flowHack.reason },
      unchanged: JSON.stringify(before) === JSON.stringify(after),
      identityHint: String(flowHack.message || '').includes('不採信前端自稱')
    })
}

/* B5 / B6 / B7：未知 op 结构化拒；无令牌 FORBIDDEN；limit 越界 INVALID_VALUE。 */
{
  const unknown = await fn.main({ action: 'verify', op: 'chargeGold', token, payload: {} })
  const noToken = await fn.main({ action: 'verify', op: 'getPointsBalance', payload: {} })
  const overLimit = await fn.main({ action: 'verify', op: 'listPointsFlow', token, payload: { limit: 1001 } })
  check('B4', '未知 op ⇒ INVALID_FIELD 结构化拒绝（恰 3 键）；新 op 无令牌 ⇒ FORBIDDEN（走既有登录令牌门）；limit 1001 ⇒ INVALID_VALUE',
    { unknown: { ok: false, reason: 'INVALID_FIELD', shape: 'message,ok,reason' }, noToken: { ok: false, reason: 'FORBIDDEN' }, overLimit: 'INVALID_VALUE' },
    {
      unknown: { ok: unknown.ok, reason: unknown.reason, shape: shapeOf(unknown) },
      noToken: { ok: noToken.ok, reason: noToken.reason },
      overLimit: overLimit.reason
    })
}

/* ===========================================================================
   C 段：静态门
   =========================================================================== */
section('C', '静态门：账本零取句柄字面 / 两集合不进任何云读面 / reason 逐字登记 / 透传块按 op 收窄 / 凭据名只认 CLOUDBASE_*（＋负对照＋取值面）')

{
  const ledgerSource = readFileSync(path.join(FN_DIR, 'lib/ledger.js'), 'utf8')
  const forbidden = /collection\s*\(|database\s*\(|writeFile|require\(['"]fs['"]\)|@cloudbase/
  check('C1', '账本文件零取库 / 取集合句柄字面、零 fs / SDK 依赖（守既有静态门 A8 / A8b / D4 同尺）',
    { forbiddenHits: 0 },
    { forbiddenHits: (ledgerSource.match(new RegExp(forbidden.source, 'g')) || []).length })
  const values = Object.values(ops.COLLECTIONS)
  check('C2', '两个新集合**不进** ops.COLLECTIONS 登记表、**不进**前端云读面（src/ 零出现）',
    { inOpsCollections: [], inSrc: [] },
    {
      inOpsCollections: ['xiai_balances', 'xiai_points_flow'].filter((name) => values.indexOf(name) !== -1),
      inSrc: ['xiai_balances', 'xiai_points_flow'].filter((name) => {
        const cloudbase = readFileSync(path.join(ROOT, 'src/data/cloudbase.js'), 'utf8')
        const storage = readFileSync(path.join(ROOT, 'src/data/storage.js'), 'utf8')
        const dbjs = readFileSync(path.join(ROOT, 'src/data/db.js'), 'utf8')
        return `${cloudbase}${storage}${dbjs}`.includes(name)
      })
    })
  check('C3', '集合命名：两集合均 `^xiai_` 前缀；账本模块导出的集合名逐字为 xiai_balances / xiai_points_flow',
    { prefix: true, names: ['xiai_balances', 'xiai_points_flow'] },
    {
      prefix: Object.values(ledger.LEDGER_COLLECTIONS).every((name) => name.indexOf('xiai_') === 0),
      names: [ledger.LEDGER_COLLECTIONS.balances, ledger.LEDGER_COLLECTIONS.flow]
    })
  /* 【AI 金鑰單 合法过期（2026-10-28）】配置面冻结表扩至 12 键（新增 4 个由派单方凍結契約
     逐字点名的字面值：KEY_INVALID / CONFIG_MISSING / LIMIT_DAY / LIMIT_MINUTE）；
     本判据的**机制一字未动**（仍钉 INSUFFICIENT_POINTS 逐字在表 ＋ 钉表长）。 */
  check('C4', 'reason 字面值：INSUFFICIENT_POINTS 逐字登记于配置面冻结表（本单唯一新字面值）',
    { value: 'INSUFFICIENT_POINTS', tableSize: 12 },
    { value: userConfig.REASONS.INSUFFICIENT_POINTS, tableSize: Object.keys(userConfig.REASONS).length })
  const indexSource = readFileSync(path.join(FN_DIR, 'index.js'), 'utf8')
  check('C5', 'index.js 透传块按 op 收窄（两 op 名各恰 1 处）且既有判据未动（动态派发 / row 透传 / plan 不外传 / 空计划守门仍在）',
    { balanceBlocks: 1, flowBlocks: 1, dispatch: true, rowPassthrough: true, planGate: true },
    {
      balanceBlocks: indexSource.split("if (op === 'getPointsBalance')").length - 1,
      flowBlocks: indexSource.split("if (op === 'listPointsFlow')").length - 1,
      dispatch: indexSource.includes('hasOwnProperty.call(OPS, op)') && indexSource.includes('hasOwnProperty.call(ADMIN_OPS, op)'),
      rowPassthrough: /row: opResult\.row/.test(indexSource) && !/plan: opResult\.plan/.test(indexSource),
      planGate: indexSource.includes('const planWrites =') && indexSource.includes('planWrites > 0')
    })
  const sha = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex')
  check('C6', '文档键派生：流水 _id ＝ pf- + sha256(idem_key) 前 32 位；余额 _id ＝ bl- + uid（确定性 ⇒ 幂等裁决的根基）',
    { flowId: `pf-${sha('k1').slice(0, 32)}`, flowLen: 35, balanceId: 'bl-u-0123456789abcdef' },
    { flowId: ledger.flowIdOf('k1'), flowLen: ledger.flowIdOf('k1').length, balanceId: ledger.balanceIdOf('u-0123456789abcdef') })
  /* 【2026-10-29 单 · Vercel 凭据显式传入】客户端初始化**单点门**（新增，只增不减）：
     `lib/ops.js` 内 `tcb.init(` 的**每个**调用点都经同一个本地初始化函数
     `initClientFromEnv()` —— 全文件 `tcb.init(` 恰 1 处、且该处就在 `initClientFromEnv()`
     函数体内；**不允许**再出现裸 `tcb.init({ env: envId })` 形态（四处消费点：会话探针
     通道 `.auth()` ＋ `const app = initClientFromEnv()` 恰 3 处〔存储回读 / 存储上传 /
     取 DB〕）；envId 名解析（`process.env.TCB_ENV ||`）第二套计数 0（一律走
     `config.readEnvId`）；`@cloudbase/node-sdk` 的 require 落点恰 1 处（内聚于该函数）；
     `secretId` / `secretKey` **显式赋值语句**两条在场（有密钥对才显式传入 ⇒ 无密钥对时
     不带凭据 init、云函数环境行为不变）。
     **【2026-10-29 应急修单 · 加严（只增不减）】云函数侧凭据名只认 `CLOUDBASE_*`**：
     · `lib/ops.js` 全文**零命中平台族变量前缀**（`TENCENTCLOUD_` ＝ 0）—— SCF / CloudBase
       运行时注入的平台族 id / key 是**临时凭据、需 session token**，只传 id / key 而不带
       token ⇒ `SIGN_PARAM_INVALID`（本次生产回滚的根因）；
     · `CLOUDBASE_SECRET_ID` 与 `CLOUDBASE_SECRET_KEY` 各**恰命中 1 处、且就在取值处**
       （`process.env.` 直读各恰 1 处 ⇒ 不再经带回退的 config 解析器）；
     · 取值单点 `function cloudbaseKeyPairFromEnv(` 恰 1 处、调用点恰 1 处、
       对旧解析器的引用 0 处；`tcb.init(` **仍恰 1 处**。
     整块读数由**同一个**扫描谓词产出（C8 的负对照喂同一谓词 ⇒ 证明判据非恒绿）。 */
  const opsInitSource = readFileSync(path.join(FN_DIR, 'lib/ops.js'), 'utf8')
  const countIn = (text, needle) => text.split(needle).length - 1

  /* **扫描谓词（单点）**：真实源码（C7）与负对照人造源码（C8）都喂它 —— 同一份判据。 */
  const scanCloudFunctionCreds = (text) => {
    const initFnStart = text.indexOf('function initClientFromEnv(')
    const initFnEnd = initFnStart >= 0 ? text.indexOf('\n}', initFnStart) : -1
    const initFnBody = initFnEnd > initFnStart ? text.slice(initFnStart, initFnEnd) : ''
    const readings = {
      tcbInitCallSites: countIn(text, 'tcb.init('),
      tcbInitInsideInitFn: countIn(initFnBody, 'tcb.init('),
      initFnDefs: countIn(text, 'function initClientFromEnv('),
      channelCallSites: countIn(text, 'initClientFromEnv().auth()'),
      appCallSites: countIn(text, 'const app = initClientFromEnv()'),
      bareEnvInit: countIn(text, 'tcb.init({ env'),
      secondNameResolution: countIn(text, 'process.env.TCB_ENV ||'),
      sdkRequireSites: countIn(text, "require('@cloudbase/node-sdk')"),
      secretAssignments: countIn(text, 'init.secretId = pair.secretId') + countIn(text, 'init.secretKey = pair.secretKey'),
      envKeyWhenNoEnvId: countIn(text, 'const init = envId ? { env: envId } : {}'),
      keyPairFnDefs: countIn(text, 'function cloudbaseKeyPairFromEnv('),
      keyPairCallSites: countIn(text, 'const pair = cloudbaseKeyPairFromEnv()'),
      cloudbaseIdHits: countIn(text, 'CLOUDBASE_SECRET_ID'),
      cloudbaseIdReads: countIn(text, 'process.env.CLOUDBASE_SECRET_ID'),
      cloudbaseKeyHits: countIn(text, 'CLOUDBASE_SECRET_KEY'),
      cloudbaseKeyReads: countIn(text, 'process.env.CLOUDBASE_SECRET_KEY'),
      tencentcloudRefs: countIn(text, 'TENCENTCLOUD_'),
      legacyPairResolverRefs: countIn(text, 'secretPairOf')
    }
    const green = readings.tcbInitCallSites === 1
      && readings.tcbInitInsideInitFn === 1
      && readings.initFnDefs === 1
      && readings.channelCallSites === 1
      && readings.appCallSites === 3
      && readings.bareEnvInit === 0
      && readings.secondNameResolution === 0
      && readings.sdkRequireSites === 1
      && readings.secretAssignments === 2
      && readings.envKeyWhenNoEnvId === 1
      && readings.keyPairFnDefs === 1
      && readings.keyPairCallSites === 1
      && readings.cloudbaseIdHits === 1
      && readings.cloudbaseIdReads === 1
      && readings.cloudbaseKeyHits === 1
      && readings.cloudbaseKeyReads === 1
      && readings.tencentcloudRefs === 0
      && readings.legacyPairResolverRefs === 0
    return { ...readings, verdict: green ? 'green' : 'red' }
  }
  const scan = scanCloudFunctionCreds(opsInitSource)
  check('C7', '客户端初始化单点（2026-10-29）＋ 应急修单加严：ops.js 内 `tcb.init(` 恰 1 处且只在 `initClientFromEnv()` 函数体内；四处消费点全经它（探针 `.auth()` 1 ＋ `const app = initClientFromEnv()` 3）；无裸 `tcb.init({ env: … })`、无第二套 envId 名解析、SDK require 落点恰 1；`init.secretId = pair.secretId` / `init.secretKey = pair.secretKey` 显式赋值在场；**平台族变量前缀全文零命中**（`TENCENTCLOUD_`＝0）；`CLOUDBASE_SECRET_ID` / `CLOUDBASE_SECRET_KEY` 各恰 1 处且就在 `process.env.` 取值处；取值单点 `cloudbaseKeyPairFromEnv()` 定义／调用各恰 1、旧解析器引用 0 ⇒ 整体判绿',
    { tcbInitCallSites: 1, tcbInitInsideInitFn: 1, initFnDefs: 1, channelCallSites: 1, appCallSites: 3, bareEnvInit: 0, secondNameResolution: 0, sdkRequireSites: 1, secretAssignments: 2, envKeyWhenNoEnvId: 1, keyPairFnDefs: 1, keyPairCallSites: 1, cloudbaseIdHits: 1, cloudbaseIdReads: 1, cloudbaseKeyHits: 1, cloudbaseKeyReads: 1, tencentcloudRefs: 0, legacyPairResolverRefs: 0, verdict: 'green' },
    scan)

  /* C8 **负对照**（证明判据非恒绿）：把**一行**平台族变量取值注入真源码的副本 ⇒ 同一个
     谓词必判红；除该门以外的读数与真源码**逐项相同** ⇒ 红点确实由「零命中平台族」这道门
     产生。夹具只是内存字符串：不读 git / HEAD、不写任何文件。 */
  const injectedLegacySource = `${opsInitSource}\nconst leakedLegacyId = process.env.TENCENTCLOUD_SECRETID\n`
  const injectedScan = scanCloudFunctionCreds(injectedLegacySource)
  const readingsWithoutLegacyGate = (s) => JSON.stringify({ ...s, verdict: undefined, tencentcloudRefs: 0 })
  check('C8', '负对照（判据非恒绿）：真源码副本注入一行 `process.env.TENCENTCLOUD_SECRETID` ⇒ 同一扫描谓词必判红（tencentcloudRefs 0→1、其余读数逐项不变）；真源码仍判绿',
    { real: { verdict: 'green', tencentcloudRefs: 0 }, injected: { verdict: 'red', tencentcloudRefs: 1 }, otherReadingsUnchanged: true },
    { real: { verdict: scan.verdict, tencentcloudRefs: scan.tencentcloudRefs }, injected: { verdict: injectedScan.verdict, tencentcloudRefs: injectedScan.tencentcloudRefs }, otherReadingsUnchanged: readingsWithoutLegacyGate(scan) === readingsWithoutLegacyGate(injectedScan) })

  /* C9 **取值面**（导出的 `cloudbaseKeyPairFromEnv()` 直接跑；env 存取即用即还）：
     · 两族均在 ⇒ 成对；· **只给平台族（生产运行时的危险形态）⇒ 空对** ⇒ 调用方不带
     `secretId` / `secretKey` 地 init（与旧版一致、且不触发 `SIGN_PARAM_INVALID`）；
     · 两族各半 ⇒ 空对（成对不混用）；· 全缺 ⇒ 空对。 */
  const savedCredsEnv = { id: process.env.CLOUDBASE_SECRET_ID, key: process.env.CLOUDBASE_SECRET_KEY, legacyId: process.env.TENCENTCLOUD_SECRETID, legacyKey: process.env.TENCENTCLOUD_SECRETKEY }
  const setCredsEnv = (id, key, legacyId, legacyKey) => {
    const pairs = [['CLOUDBASE_SECRET_ID', id], ['CLOUDBASE_SECRET_KEY', key], ['TENCENTCLOUD_SECRETID', legacyId], ['TENCENTCLOUD_SECRETKEY', legacyKey]]
    for (const [name, value] of pairs) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  setCredsEnv('offline-cloudbase-id', 'offline-cloudbase-key', undefined, undefined)
  const pairBoth = ops.cloudbaseKeyPairFromEnv()
  setCredsEnv(undefined, undefined, 'offline-legacy-id', 'offline-legacy-key')
  const pairLegacyOnly = ops.cloudbaseKeyPairFromEnv()
  setCredsEnv('offline-cloudbase-id', undefined, undefined, undefined)
  const pairHalfCb = ops.cloudbaseKeyPairFromEnv()
  setCredsEnv(undefined, 'offline-cloudbase-key', undefined, undefined)
  const pairHalfOther = ops.cloudbaseKeyPairFromEnv()
  setCredsEnv(undefined, undefined, undefined, undefined)
  const pairNone = ops.cloudbaseKeyPairFromEnv()
  setCredsEnv(savedCredsEnv.id, savedCredsEnv.key, savedCredsEnv.legacyId, savedCredsEnv.legacyKey)
  check('C9', '取值面（导出的 `cloudbaseKeyPairFromEnv()` 直接跑、env 即用即还）：两族均在 ⇒ 成对；**只给平台族 ⇒ 空对**（⇒ 不带凭据 init、不触发 SIGN_PARAM_INVALID）；两族各半 ⇒ 空对；全缺 ⇒ 空对',
    { both: { secretId: 'offline-cloudbase-id', secretKey: 'offline-cloudbase-key' }, legacyOnly: { secretId: '', secretKey: '' }, halfCb: { secretId: '', secretKey: '' }, halfOther: { secretId: '', secretKey: '' }, none: { secretId: '', secretKey: '' } },
    { both: pairBoth, legacyOnly: pairLegacyOnly, halfCb: pairHalfCb, halfOther: pairHalfOther, none: pairNone })
}

/* ===========================================================================
   汇总
   =========================================================================== */
console.log(JSON.stringify({ summary: { total, passed, failed: total - passed }, sections: sectionStats, failed_ids: failedIds }))
process.exit(total === passed ? 0 : 1)
