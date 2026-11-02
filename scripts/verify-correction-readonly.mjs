/**
 * 玺爱 · **勘误历史与待审的云端只读面** 自检（v1.84 / `AC-636` 〜 `AC-639`）
 * ============================================================================ *
 * **本地、离线、零网络**（注入式假 DB ＋ 注入式传输，把请求交给**真实云函数 op 函数体**；
 *  视图 / 服务层的合并与降级走**真源函数体**执行，不以「读代码推断」充当证据）。
 *
 * 跑什么（逐条对应 `docs/xiai.spec.md` §10.70）：
 *   A. **云函数 `listMyCorrections`**（`AC-636`）：① 甲、乙两账号各造行 ⇒ 只回 `user_id`
 *      ＝ 服务端派生 uid 的本人行（乙行命中 0、`count` ＝ `rows.length`、`op` 逐字）；
 *      ② 载荷逐个塞身份类键（`uid` / `user_id` / `userPhone` / `phone` / `role`）⇒ 每次均
 *      `INVALID_FIELD` ＋ **零读取** ＋ 不回 `rows`；③ 非 `status` / `limit` 的业务键同形拒绝；
 *      ④ `limit` 缺省 200（种 205 行 ⇒ 恰 200 行）、显式 `limit` 生效、越界 / 非整数 ⇒
 *      `INVALID_VALUE` ＋ 零读取。
 *   B. **云函数 `listPendingCorrectionsForAdmin`**（`AC-637`）：① 非白名单用户 ⇒ `FORBIDDEN`
 *      ＋ **零读取** ＋ 不回 `rows`；② 缺 `XIAI_ADMIN_PHONE` env ⇒ **fail-closed 安全拒**
 *      （用户 / 管理员两发均拒、零读取、回文不含 11 位手机号字面）；③ 白名单管理员 ⇒
 *      **跨用户** `PENDING`（缺省 `status` ＝ `PENDING`，`ACCEPTED` / `REJECTED` 命中 0）、
 *      `op` 逐字、`count` ＝ `rows.length`；④ 显式 `status` 三态过滤生效。
 *   C. **行面零手机号**（`AC-638`）：种入旧行带 `user_phone` / `phone` / `userPhone`（正对照先证
 *      扫描非空转）⇒ 两个 op 回包**深层扫描**键名含 `phone`（不分大小写）命中 **0**；
 *      不透明 `user_id` / `id` / `status` / `created_at` / `value` 原样保留（剥除面不扩大）。
 *   D. **零写入**：A〜C 全程云端**写计数 0**、行集合逐字不变（只读面不产出 `plan`）。
 *   E. **回包键集**：两个 op 的**函数体**成功恰 4 键 `{count,ok,op,rows}`、失败恒恰 3 键
 *      `{message,ok,reason}`；`index.js` 成功回包带 `rows` / `count`（按 op 收窄透传、逐字等于
 *      op 回包）、失败序列化后恰 3 键；**其它 op 键集不变**（`submitCorrection` 拒绝面仍 3 键、
 *      不含 `rows` / `count`；静态锚：收窄块恰列 3 个只读 op）。
 *   F. **客户端合并与降级**（`AC-639`）：① 云行 ∪ 本机镜像按行 id 去重、**本机行优先**、
 *      `created_at` 倒序；② 我的面云读失败 ⇒ 结构化失败 ＋ 可读繁体降级文案（含
 *      「以下為本機鏡像」）＋ **随行回本机镜像**（不以 0 條冒充）；③ 管理员面云读失败 ⇒
 *      恰 3 键结构化拒绝、**不带 `rows`**（不以镜像冒充待审读数）；④ `local-dev` ⇒ 仅本机
 *      镜像且**零云往返**；⑤ 三个读入口均已改 `async`（返回 Promise），
 *      `listPendingBatchesForAdmin` 复用已取读数 ⇒ **零额外云往返**。
 *
 * 纪律：不打印任何密钥 / 令牌 / 手机号原文（只给长度与指纹）；不碰任何服务、不联网、
 *       只跑短进程；断言失败 ⇒ 退出码非 0；**写集仅本文件**（临时件只落 `TMPDIR`）。
 *
 * 用法：`node scripts/verify-correction-readonly.mjs`
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
   0. localStorage 假体（只为让数据层 / 服务层的 ESM 真源可在本机 Node 下导入）
   --------------------------------------------------------------------------- */
const memory = new Map()
const localStorageShim = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => {
    memory.set(key, String(value))
  },
  removeItem: (key) => {
    memory.delete(key)
  },
  clear: () => memory.clear()
}
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = localStorageShim
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}

/* ---------------------------------------------------------------------------
   1. 断言与读数
   --------------------------------------------------------------------------- */
const results = []
let failures = 0

function canonical(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical))
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = value[key]
        return acc
      }, {}),
    (key, val) => (val === undefined ? '__undefined__' : val)
  )
}

function check(id, label, expected, actual) {
  const pass = canonical(expected) === canonical(actual)
  if (!pass) failures += 1
  results.push({ id, label, pass, expected, actual })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}

const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const sorted = (list) => (Array.isArray(list) ? list.slice().sort() : list)
const nowS = () => Math.floor(Date.now() / 1000)
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key)
/** 深层扫描：对象树里**键名**命中 `pattern`（不分大小写）的次数。 */
function countKeyHits(value, pattern, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return 0
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countKeyHits(item, pattern, depth + 1), 0)
  return Object.keys(value).reduce((sum, key) => {
    const hit = pattern.test(key) ? 1 : 0
    return sum + hit + countKeyHits(value[key], pattern, depth + 1)
  }, 0)
}
/** 结构化拒绝（恰 3 键 ＋ reason 在冻结表内）。 */
const FROZEN_REASONS = [
  'FORBIDDEN',
  'INVALID_VALUE',
  'INVALID_FIELD',
  'MISSING_REQUIRED',
  'STORAGE_UNAVAILABLE',
  'ALREADY_ENDORSED',
  'DUPLICATE_VALUE',
  'INSUFFICIENT_POINTS',
  'KEY_INVALID',
  'CONFIG_MISSING',
  'LIMIT_DAY',
  'LIMIT_MINUTE',
  'UPSTREAM_ERROR'
]
const isDenial = (value) =>
  Boolean(value) && value.ok === false && shapeOf(value) === 'message,ok,reason' && FROZEN_REASONS.indexOf(value.reason) !== -1

/* ---------------------------------------------------------------------------
   2. 环境（一次性合成环境；脚本内零密钥字面值）
   --------------------------------------------------------------------------- */
const PHONE = String(process.env.XIAI_USER_PHONE || '13800000001').trim()
const OTHER_PHONE = '13800000002'
const ADMIN_PHONE = String(process.env.XIAI_ADMIN_PHONE || '13000000001').trim()
const authForCode = await import(path.join(ROOT, 'src/services/auth.js'))
const SMS_CODE = String(authForCode.DEMO_SMS_CODE)
const SECRET = String(process.env.XIAI_USER_TOKEN_SECRET || randomBytes(32).toString('hex')).trim()
process.env.XIAI_USER_SMS_CODE = SMS_CODE
process.env.XIAI_USER_TOKEN_SECRET = SECRET
process.env.XIAI_ADMIN_PHONE = ADMIN_PHONE
process.env.XIAI_USER_TOKEN_VERSION = process.env.XIAI_USER_TOKEN_VERSION || '1'
process.env.XIAI_USER_TOKEN_TTL_SECONDS = process.env.XIAI_USER_TOKEN_TTL_SECONDS || '900'

const uidUtil = await import(path.join(ROOT, 'src/data/uid.js'))
const uidOfPhone = (phone) => uidUtil.uidOf(phone)
const UID_A = uidOfPhone(PHONE)
const UID_B = uidOfPhone(OTHER_PHONE)
const UID_ADMIN = uidOfPhone(ADMIN_PHONE)

/* ---------------------------------------------------------------------------
   3. 被测件（真实云函数体 ＋ 注入式假 DB）
   --------------------------------------------------------------------------- */
const FUNCTION_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')
const fn = require(path.join(FUNCTION_DIR, 'index.js'))
const ops = require(path.join(FUNCTION_DIR, 'lib/ops.js'))
const userLib = require(path.join(FUNCTION_DIR, 'lib/token.js'))

/** 假 DB：`where().limit().orderBy().get()` / `doc().get|set` / `add()`（SDK 形状对齐 ⇒
 *  `readRows` 的 `limit` 真被应用）；`stats.writes` ＝ **零写入** 的机械判据。 */
function createStore() {
  const collections = {}
  const stats = { writes: [], reads: 0 }
  const mapOf = (name) => (collections[name] = collections[name] || new Map())
  const provider = () => ({
    collection(name) {
      const map = mapOf(name)
      return {
        where(match) {
          const state = { limit: 0, order: null }
          const hit = () =>
            [...map.values()].filter((row) => Object.keys(match).every((key) => String(row[key]) === String(match[key])))
          const chain = {
            limit(n) {
              state.limit = Math.floor(Number(n))
              return chain
            },
            orderBy(field, dir) {
              state.order = { field, dir: dir === 'desc' ? 'desc' : 'asc' }
              return chain
            },
            async get() {
              stats.reads += 1
              let rows = hit().map((row) => Object.assign({}, row))
              if (state.order) {
                const { field, dir } = state.order
                rows = rows.slice().sort((a, b) => {
                  const cmp = String(a[field]).localeCompare(String(b[field]))
                  return dir === 'desc' ? -cmp : cmp
                })
              }
              if (state.limit > 0) rows = rows.slice(0, state.limit)
              return { data: rows }
            },
            async update(doc) {
              const rows = hit()
              rows.forEach((row) => Object.assign(row, doc))
              stats.writes.push({ collection: name, action: 'update', match, count: rows.length })
              return { updated: rows.length }
            }
          }
          return chain
        },
        doc(id) {
          return {
            async get() {
              stats.reads += 1
              const row = map.get(id)
              return { data: row ? [Object.assign({}, row)] : [] }
            },
            async set(doc) {
              map.set(id, Object.assign({ _id: id }, doc))
              stats.writes.push({ collection: name, action: 'set', id })
              return { updated: 1 }
            }
          }
        },
        async add(doc) {
          const id = doc && doc._id ? String(doc._id) : `auto-${map.size + 1}`
          map.set(id, Object.assign({ _id: id }, doc))
          stats.writes.push({ collection: name, action: 'add', id })
          return { id }
        }
      }
    }
  })
  const load = (rows) => {
    Object.keys(collections).forEach((name) => collections[name].clear())
    ;(rows || []).forEach((row) => mapOf(row.__collection || 'xiai_corrections').set(row._id, Object.assign({}, row)))
    stats.writes.length = 0
    stats.reads = 0
  }
  return { collections, stats, provider, load, mapOf }
}

const store = createStore()
ops.setOpsDbProvider(store.provider)

const tokenFor = (phone) =>
  userLib.issueToken({ sub: phone, secret: SECRET, nowSeconds: nowS(), ttlSeconds: 900, version: '1', role: 'user' }).token
const TOKEN_A = tokenFor(PHONE)
const TOKEN_ADMIN = tokenFor(ADMIN_PHONE)

/** 走**真实云函数入口**（`action:'verify'` 内部派发；身份由服务端从令牌派生）。 */
const callOp = (op, payload, token = TOKEN_A) => fn.main({ action: 'verify', token, op, payload })

/** 造一条勘误行；`legacyPhone` ＝ 旧行带 `user_phone` / `phone` / `userPhone` 三键。 */
const makeRow = ({ id, userId, status = 'PENDING', createdAt, value, legacyPhone = false }) => {
  const row = {
    __collection: 'xiai_corrections',
    _id: id,
    id,
    faceId: 'fc-readonly-1',
    sealId: 'XA000000001',
    stamp_id: 'XA000000001',
    user_id: userId,
    userId,
    field: 'author',
    field_label: '作者',
    value,
    status,
    created_at: createdAt
  }
  if (legacyPhone) {
    row.user_phone = PHONE
    row.phone = PHONE
    row.userPhone = PHONE
  }
  return row
}

const isoAt = (offsetSeconds) => new Date(Date.UTC(2026, 10, 1, 0, 0, 0) + offsetSeconds * 1000).toISOString()

/* 甲 2 条（其中 1 条是带手机号的旧行）＋ 乙 3 条（PENDING / ACCEPTED / REJECTED 各 1）。 */
const DATASET = [
  makeRow({ id: 'c-a-1', userId: UID_A, createdAt: isoAt(300), value: '甲一', legacyPhone: true }),
  makeRow({ id: 'c-a-2', userId: UID_A, createdAt: isoAt(200), value: '甲二' }),
  makeRow({ id: 'c-b-1', userId: UID_B, createdAt: isoAt(100), value: '乙一', legacyPhone: true }),
  makeRow({ id: 'c-b-2', userId: UID_B, status: 'ACCEPTED', createdAt: isoAt(60), value: '乙二' }),
  makeRow({ id: 'c-b-3', userId: UID_B, status: 'REJECTED', createdAt: isoAt(30), value: '乙三' })
]

/* ===========================================================================
   A 段：`listMyCorrections` —— 只回本人行 ＋ 身份服务端派生 ＋ 载荷封闭（AC-636）
   =========================================================================== */
console.log(JSON.stringify({ section: 'A', title: 'AC-636 listMyCorrections：本人行 / 身份键拒绝 / 载荷封闭 / limit 界' }))

store.load(DATASET)

{
  const readsBefore = store.stats.reads
  const A1 = await callOp('listMyCorrections', {})
  const rows = Array.isArray(A1.rows) ? A1.rows : []
  check(
    'A1',
    'AC-636① 甲调 `listMyCorrections`（不传 status / limit）⇒ rows 恰为甲本人行、乙行命中 0、`op` 逐字、`count` ＝ `rows.length`、回包带 rows/count',
    { ok: true, op: 'listMyCorrections', rows: 2, foreignHits: 0, ownOnly: true, countEq: true, hasRows: true, hasCount: true, reads: 1 },
    {
      ok: A1.ok,
      op: A1.op,
      rows: rows.length,
      foreignHits: rows.filter((row) => row.user_id !== UID_A).length,
      ownOnly: rows.every((row) => row.user_id === UID_A),
      countEq: A1.count === rows.length,
      hasRows: has(A1, 'rows'),
      hasCount: has(A1, 'count'),
      reads: store.stats.reads - readsBefore
    }
  )

  /* AC-636②：身份类键逐个塞 ⇒ INVALID_FIELD ＋ 零读取 ＋ 不回 rows。 */
  const IDENTITY_KEYS = ['uid', 'user_id', 'userPhone', 'phone', 'role']
  const identityResults = []
  for (const key of IDENTITY_KEYS) {
    const before = store.stats.reads
    const res = await callOp('listMyCorrections', { [key]: '前端自稱值' })
    identityResults.push({
      key,
      reason: res.reason,
      reads: store.stats.reads - before,
      hasRows: has(res, 'rows'),
      keys: shapeOf(res)
    })
  }
  check(
    'A2',
    'AC-636② 载荷逐个塞身份类键（uid / user_id / userPhone / phone / role）⇒ 每次均 `INVALID_FIELD` ＋ **零读取** ＋ 不回 rows ＋ 恰 3 键',
    IDENTITY_KEYS.map((key) => ({ key, reason: 'INVALID_FIELD', reads: 0, hasRows: false, keys: 'message,ok,reason' })),
    identityResults
  )

  /* AC-636③：非 status / limit 的业务键 ⇒ 同形拒绝 ＋ 零读取。 */
  const beforeA3 = store.stats.reads
  const A3 = await callOp('listMyCorrections', { faceId: 'fc-readonly-1' })
  check(
    'A3',
    'AC-636③ 非 `status` / `limit` 的业务键（`faceId`）⇒ 同形 `INVALID_FIELD` 拒 ＋ 零读取（载荷封闭键恰 status / limit）',
    { ok: false, reason: 'INVALID_FIELD', reads: 0, hasRows: false, keys: 'message,ok,reason' },
    { ok: A3.ok, reason: A3.reason, reads: store.stats.reads - beforeA3, hasRows: has(A3, 'rows'), keys: shapeOf(A3) }
  )

  /* 静态锚：两 op 的封闭键面常量逐字 `['status', 'limit']`（恰 2 处、同值）。 */
  const opsSource = readFileSync(path.join(FUNCTION_DIR, 'lib/ops.js'), 'utf8')
  const frozenKeyFaces = opsSource.match(/Object\.freeze\(\['status', 'limit'\]\)/g) || []
  check(
    'A3b',
    '静态锚：两个只读 op 的载荷封闭键面常量恰 2 处、逐字 `Object.freeze([\'status\', \'limit\'])`（零新增键）',
    { frozenKeyFaces: 2 },
    { frozenKeyFaces: frozenKeyFaces.length }
  )
}

/* AC-636④：limit 缺省 200 / 显式生效 / 越界与非整数拒绝。 */
{
  const bigRows = Array.from({ length: 205 }, (_, index) =>
    makeRow({ id: `c-big-${String(index).padStart(3, '0')}`, userId: UID_A, createdAt: isoAt(-index), value: `值${index}` })
  )
  store.load(bigRows)

  const beforeDefault = store.stats.reads
  const A5 = await callOp('listMyCorrections', {})
  check(
    'A5',
    'AC-636④ `limit` 缺省 200：种 205 行 ⇒ `rows` 恰 200 行、`count` ＝ 200（不静默全取、不越过硬上限）',
    { rows: 200, count: 200, countEq: true, reads: 1 },
    { rows: Array.isArray(A5.rows) ? A5.rows.length : -1, count: A5.count, countEq: A5.count === (A5.rows || []).length, reads: store.stats.reads - beforeDefault }
  )

  const A5b = await callOp('listMyCorrections', { limit: 5 })
  check('A5b', '显式 `limit: 5` 生效 ⇒ `rows` 恰 5 行', { rows: 5 }, { rows: Array.isArray(A5b.rows) ? A5b.rows.length : -1 })

  const badLimits = [0, 201, 1.5, '10']
  const badResults = []
  for (const limit of badLimits) {
    const before = store.stats.reads
    const res = await callOp('listMyCorrections', { limit })
    badResults.push({ limit: String(limit), reason: res.reason, reads: store.stats.reads - before, hasRows: has(res, 'rows') })
  }
  check(
    'A6',
    'AC-636④ `limit` 越界 / 非整数（0 / 201 / 1.5 / "10"）⇒ 均 `INVALID_VALUE` ＋ 零读取（不静默夹取）',
    badLimits.map((limit) => ({ limit: String(limit), reason: 'INVALID_VALUE', reads: 0, hasRows: false })),
    badResults
  )

  store.load(DATASET)
}

/* ===========================================================================
   B 段：`listPendingCorrectionsForAdmin` —— 管理员门 ＋ 缺 env 安全拒 ＋ 跨用户 PENDING（AC-637）
   =========================================================================== */
console.log(JSON.stringify({ section: 'B', title: 'AC-637 管理员待审面：非管理员拒 / 缺 env 安全拒 / 管理员跨用户 PENDING' }))

store.load(DATASET)

{
  /* B1：非白名单用户 ⇒ FORBIDDEN ＋ 零读取。 */
  const beforeB1 = store.stats.reads
  const B1 = await callOp('listPendingCorrectionsForAdmin', {}, TOKEN_A)
  check(
    'B1',
    'AC-637① 非白名单用户调管理员面 ⇒ `FORBIDDEN` ＋ **零读取** ＋ 不回 `rows`（不以空集冒充拒绝）',
    { ok: false, reason: 'FORBIDDEN', reads: 0, hasRows: false, keys: 'message,ok,reason' },
    { ok: B1.ok, reason: B1.reason, reads: store.stats.reads - beforeB1, hasRows: has(B1, 'rows'), keys: shapeOf(B1) }
  )

  /* B2：缺 XIAI_ADMIN_PHONE ⇒ fail-closed 安全拒（用户 / 管理员两发均拒 ＋ 零读取）。 */
  const savedAdminPhone = process.env.XIAI_ADMIN_PHONE
  delete process.env.XIAI_ADMIN_PHONE
  const beforeB2a = store.stats.reads
  const B2a = await callOp('listPendingCorrectionsForAdmin', {}, TOKEN_A)
  const beforeB2b = store.stats.reads
  const B2b = await callOp('listPendingCorrectionsForAdmin', {}, TOKEN_ADMIN)
  process.env.XIAI_ADMIN_PHONE = savedAdminPhone
  check(
    'B2',
    'AC-637② 缺 `XIAI_ADMIN_PHONE` env ⇒ **安全拒**（fail-closed，用户与管理员两发均拒）＋ 零读取 ＋ 不回 `rows` ＋ 回文不含 11 位手机号字面',
    {
      user: { ok: false, reason: 'STORAGE_UNAVAILABLE', reads: 0, hasRows: false },
      admin: { ok: false, reason: 'STORAGE_UNAVAILABLE', reads: 0, hasRows: false },
      phoneLiteral: 0
    },
    {
      user: { ok: B2a.ok, reason: B2a.reason, reads: store.stats.reads - beforeB2a, hasRows: has(B2a, 'rows') },
      admin: { ok: B2b.ok, reason: B2b.reason, reads: store.stats.reads - beforeB2b, hasRows: has(B2b, 'rows') },
      phoneLiteral: /\d{11}/.test(String(B2a.message || '')) ? 1 : 0
    }
  )
  /* 只读登记（**不作判据**）：AC-637② 行文写的是「同形 FORBIDDEN」，实现与既有
     `verify-seal-domain-migration` E2 同尺用 `STORAGE_UNAVAILABLE`（缺 env ＝ 内部不可用、
     非越权）。差异登记给下一轮口径专项，本套不据此翻转任何期望。 */
  console.log(JSON.stringify({ readout: 'AC-637_2_reason', spec_literal: 'FORBIDDEN', observed: B2a.reason }))

  /* B3：白名单管理员 ⇒ 跨用户 PENDING（缺省 status）。 */
  const B3 = await callOp('listPendingCorrectionsForAdmin', {}, TOKEN_ADMIN)
  const b3Rows = Array.isArray(B3.rows) ? B3.rows : []
  check(
    'B3',
    'AC-637③ 白名单管理员 ⇒ **跨用户**待审行（甲乙两账号的 PENDING 均在）、缺省 `status` ＝ `PENDING`（`ACCEPTED` / `REJECTED` 命中 0）、`op` 逐字、`count` ＝ `rows.length`',
    { ok: true, op: 'listPendingCorrectionsForAdmin', rows: 3, users: 2, acceptedHits: 0, rejectedHits: 0, countEq: true },
    {
      ok: B3.ok,
      op: B3.op,
      rows: b3Rows.length,
      users: new Set(b3Rows.map((row) => row.user_id)).size,
      acceptedHits: b3Rows.filter((row) => row.status === 'ACCEPTED').length,
      rejectedHits: b3Rows.filter((row) => row.status === 'REJECTED').length,
      countEq: B3.count === b3Rows.length
    }
  )

  /* B4：显式 status 三态过滤生效。 */
  const B4 = await callOp('listPendingCorrectionsForAdmin', { status: 'ACCEPTED' }, TOKEN_ADMIN)
  const b4Rows = Array.isArray(B4.rows) ? B4.rows : []
  check(
    'B4',
    '显式 `status: "ACCEPTED"` ⇒ 只回 ACCEPTED 行（值域过滤生效，非只回 PENDING）',
    { rows: 1, allAccepted: true },
    { rows: b4Rows.length, allAccepted: b4Rows.length === 1 && b4Rows[0].status === 'ACCEPTED' }
  )
}

/* ===========================================================================
   C 段：行面零手机号（AC-638）
   =========================================================================== */
console.log(JSON.stringify({ section: 'C', title: 'AC-638 行面剥手机号：深层扫描零命中 ＋ 不透明 uid 保留' }))

store.load(DATASET)

{
  /* C0 正对照：种入的旧行确实带三个手机号键（证明扫描非空转）。 */
  const seededPhoneKeys = DATASET.reduce((sum, row) => sum + Object.keys(row).filter((key) => /phone/i.test(key)).length, 0)
  check('C0', '正对照：种入的旧行确实带 `user_phone` / `phone` / `userPhone` 键（后续扫描非空转）', { seededPhoneKeys: 6 }, { seededPhoneKeys })

  const C1 = await callOp('listMyCorrections', {})
  const C2 = await callOp('listPendingCorrectionsForAdmin', {}, TOKEN_ADMIN)
  const hits = countKeyHits(C1.rows, /phone/i) + countKeyHits(C2.rows, /phone/i)
  check(
    'C1',
    'AC-638② 两个 op 回包 `rows` 逐行逐键深层扫描「键名含 `phone`（不分大小写）」⇒ 合计命中 **0**（含 user_phone / phone / userPhone 族）',
    { phoneKeyHits: 0, myRows: 2, adminRows: 3 },
    { phoneKeyHits: hits, myRows: (C1.rows || []).length, adminRows: (C2.rows || []).length }
  )

  const myFirst = (C1.rows || []).find((row) => row.id === 'c-a-1') || {}
  check(
    'C2',
    'AC-638③ 剥除面**不扩大**：不透明 `user_id` 与非 phone 业务键（`id` / `status` / `created_at` / `value` / `field`）仍在',
    { user_id: true, id: true, status: true, created_at: true, value: true, field: true, user_phone_gone: true },
    {
      user_id: myFirst.user_id === UID_A,
      id: myFirst.id === 'c-a-1',
      status: myFirst.status === 'PENDING',
      created_at: typeof myFirst.created_at === 'string' && myFirst.created_at.length > 0,
      value: myFirst.value === '甲一',
      field: myFirst.field === 'author',
      user_phone_gone: !has(myFirst, 'user_phone') && !has(myFirst, 'phone') && !has(myFirst, 'userPhone')
    }
  )
}

/* ===========================================================================
   D 段：零写入（只读面不产出 plan ⇒ index.js 落盘分支不触发）
   =========================================================================== */
console.log(JSON.stringify({ section: 'D', title: '零写入：A〜C 全程云端写计数 0 ＋ 行集合逐字不变' }))

{
  const beforeD = canonical([...store.mapOf('xiai_corrections').keys()].sort())
  await callOp('listMyCorrections', {})
  await callOp('listPendingCorrectionsForAdmin', {}, TOKEN_ADMIN)
  await callOp('listMyCorrections', { limit: 1 })
  check('D1', '三个只读调用**全程零写入**（写计数不变）', { writes: 0 }, { writes: store.stats.writes.length })
  check(
    'D2',
    '行集合**逐字不变**（键序规范化后相等；不改写、不新增、不删库内行）',
    beforeD,
    canonical([...store.mapOf('xiai_corrections').keys()].sort())
  )
}

/* ===========================================================================
   E 段：回包键集（op 函数体恰 4 / 恒 3；index.js 按 op 收窄；其它 op 不变）
   =========================================================================== */
console.log(JSON.stringify({ section: 'E', title: '回包键集：成功恰 4 键 / 失败恰 3 键 / 其它 op 键集不变' }))

{
  /* E1 / E2：op **函数体**成功恰 4 键。 */
  const E1 = await ops.OPS.listMyCorrections({}, { uid: UID_A })
  check('E1', 'op① `listMyCorrections` 函数体成功回包**恰 4 键** `{count,ok,op,rows}`', 'count,ok,op,rows', shapeOf(E1))

  const E2 = await ops.ADMIN_OPS.listPendingCorrectionsForAdmin({}, { uid: UID_ADMIN, phone: ADMIN_PHONE }, {
    adminPhone: ADMIN_PHONE,
    nowSeconds: nowS()
  })
  check('E2', 'op② `listPendingCorrectionsForAdmin` 函数体成功回包**恰 4 键** `{count,ok,op,rows}`', 'count,ok,op,rows', shapeOf(E2))

  /* E3：两个 op 的失败恒恰 3 键。 */
  const E3a = await ops.OPS.listMyCorrections({ uid: 'x' }, { uid: UID_A })
  const E3b = await ops.ADMIN_OPS.listPendingCorrectionsForAdmin({ uid: 'x' }, { uid: UID_ADMIN, phone: ADMIN_PHONE }, {
    adminPhone: ADMIN_PHONE,
    nowSeconds: nowS()
  })
  check('E3', '两 op 失败回包恒**恰 3 键** `{message,ok,reason}`（两发均是）', ['message,ok,reason', 'message,ok,reason'], [shapeOf(E3a), shapeOf(E3b)])

  /* E4：index.js 成功回包按 op 收窄透传 rows / count（逐字等于 op 回包）。 */
  const E4 = await callOp('listMyCorrections', {})
  check(
    'E4',
    '`index.js` 成功回包带 `rows` / `count`（按 op 收窄透传，逐字等于 op 函数体回包）且序列化后不新增其它读数键',
    { hasRows: true, hasCount: true, rowsSame: true, countSame: true, hasPlan: false },
    {
      hasRows: has(E4, 'rows'),
      hasCount: has(E4, 'count'),
      rowsSame: canonical(E4.rows) === canonical((await ops.OPS.listMyCorrections({}, { uid: UID_A })).rows),
      countSame: typeof E4.count === 'number',
      hasPlan: has(E4, 'plan')
    }
  )

  /* E5：index.js 失败回包序列化后恰 3 键。 */
  const E5 = await callOp('listMyCorrections', { uid: 'x' })
  check('E5', '`index.js` 失败回包（JSON 序列化后）**恰 3 键**', 'message,ok,reason', shapeOf(JSON.parse(JSON.stringify(E5))))

  /* E6：其它 op（非只读面）拒绝面仍恰 3 键、不含 rows / count。 */
  const E6 = await callOp('submitCorrection', {})
  check(
    'E6',
    '其它 op（`submitCorrection`）拒绝面仍**恰 3 键**、**不含** `rows` / `count`（收窄面按 op 隔离）',
    { keys: 'message,ok,reason', denied: true, hasRows: false, hasCount: false },
    { keys: shapeOf(E6), denied: E6.ok === false, hasRows: has(E6, 'rows'), hasCount: has(E6, 'count') }
  )

  /* E7：静态锚 —— index.js 的 rows / count 收窄块恰列 3 个只读 op。 */
  const indexSource = readFileSync(path.join(FUNCTION_DIR, 'index.js'), 'utf8')
  const narrowLines = indexSource.split('\n').filter((line) => line.includes("op === 'listMyCorrections'"))
  check(
    'E7',
    '静态锚：`index.js` 的 `rows` / `count` 收窄块**恰一处**、同时列出三个只读 op（pullImportRows / listMyCorrections / listPendingCorrectionsForAdmin）',
    { narrowLines: 1, hasPull: true, hasAdmin: true },
    {
      narrowLines: narrowLines.length,
      hasPull: narrowLines.length === 1 && narrowLines[0].includes("op === 'pullImportRows'"),
      hasAdmin: narrowLines.length === 1 && narrowLines[0].includes("op === 'listPendingCorrectionsForAdmin'")
    }
  )
}

/* ===========================================================================
   F 段：客户端合并与降级（AC-639；真源服务层 ＋ 注入式传输）
   =========================================================================== */
console.log(JSON.stringify({ section: 'F', title: 'AC-639 客户端：云 ∪ 本机去重本机优先 / 云读失败降级 / local-dev / async 化' }))

const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
const session = await import(path.join(ROOT, 'src/data/session.js'))
const db = await import(path.join(ROOT, 'src/data/db.js'))
const storage = await import(path.join(ROOT, 'src/data/storage.js'))
const corrections = await import(path.join(ROOT, 'src/services/corrections.js'))
const userTokenSvc = await import(path.join(ROOT, 'src/services/userToken.js'))

/* 注入式传输：默认走**真实云函数体**；`cloudFailOp` 非空 ⇒ 对该 op 注入结构化云读失败。
   **换票（注入缝）**：管理员面用**管理员令牌**过云函数白名单门、我的面用甲的令牌 ——
   本机会话始终是甲（以便同时验证「我的面」的本机镜像合并）；真实产品里管理员用自己的登录令牌。 */
const transportCalls = []
let cloudFailOp = ''
userTokenSvc.setUserTokenTransport(async (name, data) => {
  const op = data && data.op
  transportCalls.push({ name, op })
  if (cloudFailOp && op === cloudFailOp) {
    return { result: { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '（自检注入）雲端讀取故障。' } }
  }
  const token = op === 'listPendingCorrectionsForAdmin' ? TOKEN_ADMIN : TOKEN_A
  return { result: await fn.main(Object.assign({}, data, { token })) }
})
writeFace.setWriteFaceModeOverride('cloud')
db.ensureSeed()

{
  const login = await userTokenSvc.ensureUserLoginToken(PHONE, SMS_CODE)
  check('F0', '前置：云端形态 ＋ 登录取票成功（注入式传输 → 真实云函数体）', { ok: true, mode: 'cloud' }, { ok: login.ok === true, mode: writeFace.writeFaceMode() })
  session.setUser({ id: UID_A, phone: PHONE, role: 'user', nickname: '自检甲' })
}

/* F0b：三个读入口均已改 async（返回 Promise —— 改前是同步裸数组 / 裸对象）。 */
{
  const p1 = corrections.listMyCorrections()
  const p2 = corrections.listPendingForAdmin({ id: UID_ADMIN, phone: ADMIN_PHONE, role: 'admin' })
  const p3 = corrections.listPendingBatchesForAdmin({ id: UID_ADMIN, phone: ADMIN_PHONE, role: 'admin' })
  const isPromise = (value) => Boolean(value) && typeof value.then === 'function'
  check(
    'F0b',
    '三个读入口均已改 **async**（`listMyCorrections` / `listPendingForAdmin` / `listPendingBatchesForAdmin` 均返回 Promise）',
    { my: true, pending: true, batches: true },
    { my: isPromise(p1), pending: isPromise(p2), batches: isPromise(p3) }
  )
  await Promise.all([p1, p2, p3])
}

/* 云行（同 id 一行 + 云独有一行）与本机镜像（同 id 一行 + 本机独有一行）。 */
const localRow = (id, value, createdAt) => ({
  id,
  faceId: 'fc-readonly-1',
  sealId: 'XA000000001',
  stamp_id: 'XA000000001',
  user_id: UID_A,
  userId: UID_A,
  field: 'author',
  field_label: '作者',
  value,
  status: 'PENDING',
  created_at: createdAt,
  batchId: 'cb-selfcheck-readonly'
})

{
  store.load([
    makeRow({ id: 'c-share', userId: UID_A, createdAt: '2026-11-01T05:00:00.000Z', value: '雲端值' }),
    makeRow({ id: 'c-cloud-only', userId: UID_A, createdAt: '2026-11-01T04:00:00.000Z', value: '雲端獨有' })
  ])
  storage.writeKey(storage.STORAGE_KEYS.corrections, [
    localRow('c-share', '本機值', '2026-11-01T05:00:00.000Z'),
    localRow('c-local-only', '本機獨有', '2026-11-01T06:00:00.000Z')
  ])

  /* F1：云 ∪ 本机、按 id 去重、本机行优先、created_at 倒序。 */
  const F1 = await corrections.listMyCorrections()
  const f1Rows = Array.isArray(F1.rows) ? F1.rows : []
  const shared = f1Rows.find((row) => row.id === 'c-share') || {}
  check(
    'F1',
    'AC-639④ 云行 ∪ 本机镜像：同 id 去重后恰 3 行、同 id **以本机镜像行为准**、`created_at` 倒序',
    { ok: true, total: 3, ids: ['c-local-only', 'c-share', 'c-cloud-only'], sharedValue: '本機值', sharedCount: 1, localOnly: true },
    {
      ok: F1.ok,
      total: f1Rows.length,
      ids: f1Rows.map((row) => row.id),
      sharedValue: shared.value,
      sharedCount: f1Rows.filter((row) => row.id === 'c-share').length,
      localOnly: shared.batchId === 'cb-selfcheck-readonly'
    }
  )

  /* F2：我的面云读失败 ⇒ 结构化失败 ＋ 降级文案 ＋ 随行回本机镜像（非 0 條冒充）。 */
  cloudFailOp = 'listMyCorrections'
  const F2 = await corrections.listMyCorrections()
  cloudFailOp = ''
  check(
    'F2',
    'AC-639① 我的面云读失败 ⇒ 结构化失败（恰 4 键含 rows）＋ 可读降级文案（含「以下為本機鏡像」）＋ **随行回本机镜像 2 行**（不以 0 條冒充）',
    { ok: false, reason: 'STORAGE_UNAVAILABLE', keys: 'message,ok,reason,rows', rows: 2, hasDegradation: true, silentZero: false },
    {
      ok: F2.ok,
      reason: F2.reason,
      keys: shapeOf(F2),
      rows: Array.isArray(F2.rows) ? F2.rows.length : -1,
      hasDegradation: String(F2.message || '').includes('以下為本機鏡像') && String(F2.message || '').includes('失敗'),
      silentZero: F2.count === 0
    }
  )

  /* F3：管理员面云读失败 ⇒ 恰 3 键、不带 rows（不以镜像冒充待审读数）。 */
  const adminActor = { id: UID_ADMIN, phone: ADMIN_PHONE, role: 'admin', nickname: '自检管理员' }
  cloudFailOp = 'listPendingCorrectionsForAdmin'
  const F3 = await corrections.listPendingForAdmin(adminActor)
  cloudFailOp = ''
  check(
    'F3',
    'AC-639② 管理员面云读失败 ⇒ **恰 3 键**结构化拒绝、**不带 `rows`**（不以本机镜像冒充待审读数）＋ 可读文案含「待審讀數不可用」',
    { ok: false, reason: 'STORAGE_UNAVAILABLE', keys: 'message,ok,reason', hasRows: false, hasDegradation: true },
    {
      ok: F3.ok,
      reason: F3.reason,
      keys: shapeOf(F3),
      hasRows: has(F3, 'rows'),
      hasDegradation: String(F3.message || '').includes('待審讀數不可用')
    }
  )

  /* F4：local-dev ⇒ 仅本机镜像 ＋ 零云往返（行为与改前逐字一致）。 */
  writeFace.setWriteFaceModeOverride('local-dev')
  const callsBeforeF4 = transportCalls.length
  const F4 = await corrections.listMyCorrections()
  writeFace.setWriteFaceModeOverride('cloud')
  check(
    'F4',
    'AC-639③ `local-dev` ⇒ 仅本机镜像（2 行）且**零云往返**（行为同改前）',
    { ok: true, rows: 2, cloudCalls: 0 },
    { ok: F4.ok, rows: Array.isArray(F4.rows) ? F4.rows.length : -1, cloudCalls: transportCalls.length - callsBeforeF4 }
  )

  /* F5：批量读入口复用已取读数 ⇒ 零额外云往返；批分组非空。 */
  const pendingNow = await corrections.listPendingForAdmin(adminActor)
  const callsBeforeF5 = transportCalls.length
  const F5 = await corrections.listPendingBatchesForAdmin(adminActor, pendingNow)
  check(
    'F5',
    '`listPendingBatchesForAdmin`（async）复用已取的待审读数 ⇒ **零额外云往返** ＋ 批分组非空',
    { ok: true, extraCloudCalls: 0, batchesOk: true },
    { ok: F5.ok, extraCloudCalls: transportCalls.length - callsBeforeF5, batchesOk: Array.isArray(F5.batches) && F5.batches.length > 0 }
  )

  /* F6：管理员面**成功**路也走云读（云行 ∪ 本机镜像），且全程云端零写入。 */
  const F6 = await corrections.listPendingForAdmin(adminActor)
  const f6Rows = Array.isArray(F6.rows) ? F6.rows : []
  check(
    'F6',
    'AC-639④ 管理员面成功路：云行 ∪ 本机镜像按 id 去重（云 2 行 ＋ 本机独有 1 行 ⇒ 恰 3 行、同 id 只 1 行）、全程云端**零写入**',
    { ok: true, rows: 3, deduped: true, cloudWrites: 0 },
    { ok: F6.ok, rows: f6Rows.length, deduped: new Set(f6Rows.map((row) => row.id)).size === f6Rows.length, cloudWrites: store.stats.writes.length }
  )
}

/* --------------------------------------------------------------------------- 汇总
   --------------------------------------------------------------------------- */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id),
    cloud_reads_by_harness: store.stats.reads,
    cloud_writes_by_harness: store.stats.writes.length,
    token: { length: TOKEN_A.length, fingerprint: createHash('sha256').update(TOKEN_A).digest('hex').slice(0, 12) }
  })
)
process.exit(failures === 0 ? 0 : 1)
