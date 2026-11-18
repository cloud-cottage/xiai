#!/usr/bin/env node
/**
 * 玺爱 · **掌書記（`sub-admin`）身份自检**（本轮续单：只补测试，零权限改动）
 * ============================================================================
 * 背景（Kevin 2026-11-18 裁定）：`sub-admin`（上屏「掌書記」）是 xiai 侧的**真实身份**，
 * 真源是服务端 `xiai_roles` 行。它**不是** admin 的变体，也**不是**普通用户。
 *
 * 一句话口径（本脚本守的就是这一句）：
 *   **认得 `sub-admin` ≠ 放行 `sub-admin`** —— 身份文案三值化，授权判据一字不动。
 *
 * 判据分段（共 26 条）：
 *   A 映射面（4 条）：`ROLE_LABEL` 键面恰 2；`roleLabel()` 两值逐字；`accountLabel()`
 *     三值投影（`admin` ⇒ 掌書記使賬號 / `sub-admin` ⇒ 掌書記賬號 / 其余 ⇒ 普通用戶賬號）。
 *   B 数据层（6 条）：`db.reconcileAdminRoles()` **真函数 + 临时 storage 夹具** ——
 *     ① `sub-admin` 原样保留（不洗成 user）；② `ADMIN_PHONE` 强制 `admin`（旧规则不变）；
 *     ③ 非管理员手机号冒用 `admin` ⇒ 降 `user`（旧规则不变）；④ 表外值 ⇒ 降 `user`；
 *     ⑤ 纠正结果**已回写**（持久化面与返回值同口径）；⑥ **变异负对照** —— 把真函数源码里的
 *     「`sub-admin` 保留」改成「`sub-admin` → `user`」后，判据①必红（只在内存里做，不写被测件）。
 *   C 登录态合并（5 条）：`mergeServerRole()` 只认三值、只覆盖 `role`（其余字段逐字保留）、
 *     **不持久化**、表外值不写、未登录回 `null`。
 *   D 服务端读面（6 条）：`services/roles.js::fetchMyRole()` —— 未登录 ⇒ `null` 且**零请求**；
 *     传输失败 / 结构化拒绝 / 回包无角色 / 表外值 / 传输抛错 ⇒ 一律 `null`，**绝不默认 admin**。
 *   E 授权面（1 条）：`isAdmin` 对 `sub-admin` 为 **false**（`admin` 为 true、游客 false 作对照）。
 *   F 静态门（3 条）：`src/**` 剥注释后 —— ① `role === 'admin'` 处**零** `sub-admin`（权限不放大）；
 *     ② `role === 'user'` 命中 **0**（没人拿「低权字面值」当判据）；③ `session.js::isAdmin`
 *     表达式逐字仍是 `state.user !== null && state.user.role === 'admin'`。
 *
 * 纪律：本地、离线、零网络、零生产读写；不打印任何密钥 / 令牌；断言失败 ⇒ 退出码非 0。
 *
 * 用法：
 *   node scripts/verify-subadmin-role.mjs
 */
/* **测试环境保护哨兵（硬防线）** —— 本套件零网络、零生产读写；置 `XIAI_NO_REAL_CARD=1`
   与全仓 `scripts/verify-*.mjs` 一致（守则见 `scripts/README-test-net.md` §1）。 */
process.env.XIAI_NO_REAL_CARD = '1'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = path.join(ROOT, 'src')

/* ---------------------------------------------------------------------------
   0. localStorage 假体（只为让数据层 / 服务层的 ESM 真源在本机 Node 下可导入）
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
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`
}

function check(id, label, expected, actual) {
  const pass = canonical(expected) === canonical(actual)
  if (!pass) failures += 1
  results.push({ id, label, pass, expected, actual })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}

const section = (id, title) => console.log(JSON.stringify({ section: id, title }))

/* ---------------------------------------------------------------------------
   2. 剥注释（引号感知；`.js` 剥 // 与 /* *\/，`.vue` 另剥 <!-- -->）
   --------------------------------------------------------------------------- */
function stripJsComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i)
      i = j < 0 ? n : j
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2)
      i = j < 0 ? n : j + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      let j = i + 1
      while (j < n) {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === quote) break
        if (src[j] === '\n' && quote !== '`') break
        j += 1
      }
      out += src.slice(i, j + 1)
      i = j + 1
      continue
    }
    out += c
    i += 1
  }
  return out
}

function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => '\n'.repeat(m.split('\n').length - 1))
}

function stripComments(file, text) {
  if (file.endsWith('.js') || file.endsWith('.mjs')) return stripJsComments(text)
  if (file.endsWith('.css')) return stripHtmlComments(stripJsComments(text))
  if (!file.endsWith('.vue')) return text
  let out = ''
  let i = 0
  while (i < text.length) {
    const open = text.slice(i).search(/<(script|style)\b/)
    if (open < 0) {
      out += stripHtmlComments(text.slice(i))
      break
    }
    const start = i + open
    out += stripHtmlComments(text.slice(i, start))
    const tagEnd = text.indexOf('>', start)
    const closeTag = text.slice(start).startsWith('<style') ? '</style>' : '</script>'
    const close = text.indexOf(closeTag, tagEnd)
    if (tagEnd < 0 || close < 0) {
      out += text.slice(start)
      break
    }
    const head = text.slice(start, tagEnd + 1)
    const body = text.slice(tagEnd + 1, close)
    out += head + (closeTag === '</style>' ? stripHtmlComments(stripJsComments(body)) : stripJsComments(body)) + closeTag
    i = close + closeTag.length
  }
  return out
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (/\.(js|mjs|vue|css)$/.test(entry.name)) acc.push(full)
  }
  return acc
}

const rel = (abs) => path.relative(ROOT, abs)

/* ---------------------------------------------------------------------------
   3. 真源（**动态导入**：假体必须先就位）
   --------------------------------------------------------------------------- */
const labelsMod = await import(path.join(SRC, 'data/roleLabels.js'))
const storageMod = await import(path.join(SRC, 'data/storage.js'))
const sessionMod = await import(path.join(SRC, 'data/session.js'))
const dbMod = await import(path.join(SRC, 'data/db.js'))
const seedMod = await import(path.join(SRC, 'data/seed.js'))
const uidMod = await import(path.join(SRC, 'data/uid.js'))
const modeMod = await import(path.join(SRC, 'data/writeFaceMode.js'))
const rolesMod = await import(path.join(SRC, 'services/roles.js'))
const userTokenMod = await import(path.join(SRC, 'services/userToken.js'))

const { ROLE_LABEL, roleLabel, accountLabel, ADMIN_LABEL, SUB_ADMIN_LABEL } = labelsMod
const { STORAGE_KEYS, readKey, writeKey } = storageMod
const { setUser, currentUser, isAdmin, mergeServerRole } = sessionMod
const { reconcileAdminRoles } = dbMod
const { SEED_USERS, ADMIN_PHONE, ADMIN_NICKNAME } = seedMod
const { fetchMyRole } = rolesMod
const { setWriteFaceModeOverride, WRITE_FACE_MODES } = modeMod
const { setUserTokenTransport } = userTokenMod
const { uidOf } = uidMod

/* 合成手机号（不写字面 11 位真号）。 */
const synthPhone = (tail) => '137' + String(0).repeat(7) + String(tail)
const PHONE_SUB = synthPhone(2)
const PHONE_FAKE = synthPhone(3)
const PHONE_ODD = synthPhone(4)

/* ===========================================================================
   A. 映射面
   =========================================================================== */
section('A', '映射面：角色值 → 上屏文案（三值投影）')
check('A1', 'ROLE_LABEL 键面恰 [admin, sub-admin]', ['admin', 'sub-admin'], Object.keys(ROLE_LABEL).sort())
check(
  'A2',
  'roleLabel() 两值逐字（admin ⇒ 掌書記使 / sub-admin ⇒ 掌書記；表外值回落原文）',
  ['掌書記使', '掌書記', 'user'],
  [roleLabel('admin'), roleLabel('sub-admin'), roleLabel('user')]
)
check(
  'A3',
  'accountLabel() 三值投影（含 null / 未知值 ⇒ 普通用戶賬號；子管理员不得显示成普通用戶）',
  ['掌書記使賬號', '掌書記賬號', '普通用戶賬號', '普通用戶賬號', '普通用戶賬號'],
  [accountLabel('admin'), accountLabel('sub-admin'), accountLabel('user'), accountLabel(null), accountLabel('owner')]
)
/* 派生的上屏常量与映射同源（防第二份文案）。 */
check('A3b', '派生常量与 ROLE_LABEL 同源', [ROLE_LABEL.admin, ROLE_LABEL['sub-admin']], [ADMIN_LABEL, SUB_ADMIN_LABEL])

/* ===========================================================================
   B. 数据层：reconcileAdminRoles（真函数 + 临时 storage 夹具）
   =========================================================================== */
section('B', '数据层：reconcileAdminRoles() 保留 sub-admin（真函数）')

function seedUsersFixture() {
  const fixture = [
    { id: uidOf(ADMIN_PHONE), phone: ADMIN_PHONE, nickname: ADMIN_NICKNAME, role: 'user', points: 0 },
    { id: 'u-fixture-sub', phone: PHONE_SUB, nickname: '夹具掌書記', role: 'sub-admin', points: 0 },
    { id: 'u-fixture-fake', phone: PHONE_FAKE, nickname: '夹具冒用', role: 'admin', points: 0 },
    { id: 'u-fixture-odd', phone: PHONE_ODD, nickname: '夹具表外', role: 'owner', points: 0 }
  ]
  writeKey(STORAGE_KEYS.users, fixture)
  return fixture
}
const roleOf = (rows, id) => (rows.find((row) => row && row.id === id) || {}).role

/* 夹具先落盘，再**调用真函数**（顺序是判据的一部分：不是拿夹具原文对答案）。 */
seedUsersFixture()
const real = reconcileAdminRoles()
check('B1', 'sub-admin 行**原样保留**（不被洗成 user）', 'sub-admin', roleOf(real, 'u-fixture-sub'))
check('B2', '旧规则①：ADMIN_PHONE 强制 admin（夹具里先写成 user）', 'admin', roleOf(real, uidOf(ADMIN_PHONE)))
check('B3', '旧规则②：非管理员手机号冒用 admin ⇒ 降 user', 'user', roleOf(real, 'u-fixture-fake'))
check('B4', '表外值（owner）⇒ 降到最低权 user', 'user', roleOf(real, 'u-fixture-odd'))
check(
  'B5',
  '纠正结果已回写持久化（读回 storage 与返回值同口径）',
  'sub-admin',
  roleOf(readKey(STORAGE_KEYS.users) || [], 'u-fixture-sub')
)

/* ⑥ 变异负对照：把真函数源码里的「sub-admin 保留」改成「sub-admin → user」。
   只在内存里改文本 + `new Function` 求值 ⇒ **不写被测件**；真实模块保持原样。 */
function extractFunctionSource(fileText, name) {
  const anchor = fileText.indexOf(`function ${name}(`)
  if (anchor < 0) return ''
  const brace = fileText.indexOf('{', anchor)
  let depth = 0
  for (let i = brace; i < fileText.length; i += 1) {
    if (fileText[i] === '{') depth += 1
    else if (fileText[i] === '}') {
      depth -= 1
      if (depth === 0) return fileText.slice(anchor, i + 1)
    }
  }
  return ''
}

const DB_SRC = fs.readFileSync(path.join(SRC, 'data/db.js'), 'utf8')
const REAL_FN = extractFunctionSource(DB_SRC, 'reconcileAdminRoles')
const MUTANT_FN = REAL_FN.replace(
  "if (row.role === 'sub-admin') return",
  "if (row.role === 'sub-admin') {\n        row.role = 'user'\n        changed = true\n        return\n      }"
)
/* 变异命中判据：源码里那一行存在、且被改掉了（否则负对照是假响）。 */
const mutationApplied = REAL_FN !== '' && MUTANT_FN !== REAL_FN

/* 夹具专用 storage（与上文的 memory 隔离，互不污染）。 */
const mutantStore = new Map()
const mutantReadKey = (key) => {
  const raw = mutantStore.has(key) ? mutantStore.get(key) : null
  try {
    return raw === null ? null : JSON.parse(raw)
  } catch {
    return null
  }
}
const mutantWriteKey = (key, value) => mutantStore.set(key, JSON.stringify(value))

function runMutant(fixtureRows) {
  mutantStore.clear()
  mutantWriteKey(STORAGE_KEYS.users, fixtureRows)
  const factory = new Function(
    'readKey',
    'writeKey',
    'STORAGE_KEYS',
    'SEED_USERS',
    'ADMIN_PHONE',
    'ADMIN_NICKNAME',
    'uidOf',
    `${MUTANT_FN}\nreturn reconcileAdminRoles()`
  )
  return { rows: factory(mutantReadKey, mutantWriteKey, STORAGE_KEYS, SEED_USERS, ADMIN_PHONE, ADMIN_NICKNAME, uidOf), store: mutantStore }
}

const mutantFixture = [
  { id: uidOf(ADMIN_PHONE), phone: ADMIN_PHONE, nickname: ADMIN_NICKNAME, role: 'admin', points: 0 },
  { id: 'u-fixture-sub', phone: PHONE_SUB, nickname: '夹具掌書記', role: 'sub-admin', points: 0 }
]
/* 同一份夹具分别喂**真函数**与**变异体**：真函数保留、变异体降权 ⇒ 判据对这次改动敏感。 */
writeKey(STORAGE_KEYS.users, mutantFixture)
const realOnSameFixture = reconcileAdminRoles()
const mutantRows = mutationApplied ? runMutant(mutantFixture).rows : []

check(
  'B6',
  '变异负对照：把「sub-admin 保留」改成「sub-admin → user」⇒ 判据必红（真函数保留 / 变异体降权）',
  [true, 'sub-admin', 'user'],
  [mutationApplied, roleOf(realOnSameFixture, 'u-fixture-sub'), roleOf(mutantRows, 'u-fixture-sub')]
)

/* ===========================================================================
   C. 登录态合并：mergeServerRole
   =========================================================================== */
section('C', '登录态：mergeServerRole() 只认三值、只覆盖 role、不持久化')

memory.clear()
const baseUser = { id: 'u-merge-1', phone: PHONE_SUB, nickname: 'merge', role: 'user', points: 7 }
setUser(baseUser)
const merged = mergeServerRole('sub-admin')
const after = currentUser()
check('C1', '三值之一 sub-admin ⇒ 合并成功', ['sub-admin', 'sub-admin'], [merged, after.role])
check('C2', '只覆盖 role：id / phone / nickname / points 逐字保留', [baseUser.id, baseUser.phone, baseUser.nickname, baseUser.points], [after.id, after.phone, after.nickname, after.points])
check('C3', '不持久化角色（session 存储里只有 userId）', { userId: baseUser.id }, readKey(STORAGE_KEYS.session))

const beforeOdd = currentUser().role
const oddMerged = mergeServerRole('owner')
check('C4', '表外值 / 空值 ⇒ 不写（返回当前值）', [beforeOdd, beforeOdd, beforeOdd], [oddMerged, mergeServerRole(''), mergeServerRole(null)])
const trimmed = mergeServerRole('  admin  ')
check('C5', '三值带空白 ⇒ trim 后仍认（admin）', ['admin', 'admin'], [trimmed, currentUser().role])

setUser(null)
check('C6', '未登录 ⇒ null（零副作用）', null, mergeServerRole('sub-admin'))

/* ===========================================================================
   D. 服务端读面：fetchMyRole（只读、失败即 null、绝不默认 admin）
   =========================================================================== */
section('D', '服务端读面：fetchMyRole() 失败 / 未登录 / 表外值 ⇒ null（不默认 admin）')

/* 注入形态：`cloud`（否则 gate 走 dev 分支、永远拿不到 value）。 */
setWriteFaceModeOverride(WRITE_FACE_MODES.CLOUD)

let transportCalls = 0
let transportReply = null
setUserTokenTransport(async (name, data) => {
  transportCalls += 1
  return typeof transportReply === 'function' ? transportReply(name, data) : transportReply
})

/* D1：未登录 ⇒ null 且**零请求**。 */
setUser(null)
transportCalls = 0
const guestRole = await fetchMyRole()
check('D1', '未登录 ⇒ null 且零请求', [null, 0], [guestRole, transportCalls])

/* 后续用例：以普通用户登录。 */
const loginUser = { id: 'u-role-1', phone: PHONE_SUB, nickname: 'role', role: 'user', points: 0 }
setUser(loginUser)

/* D2：成功 —— 服务端回 sub-admin。 */
transportReply = { result: { ok: true, value: { role: 'sub-admin' } } }
const okRole = await fetchMyRole()
check('D2', '回包 role=sub-admin ⇒ sub-admin 且已并入登录态', ['sub-admin', 'sub-admin'], [okRole, currentUser().role])

/* D3：结构化拒绝（传输层回 ok:false）⇒ null，角色不动。 */
setUser({ ...loginUser })
transportReply = { ok: false, reason: 'FORBIDDEN', message: 'denied' }
const deniedRole = await fetchMyRole()
check('D3', 'FORBIDDEN 回包 ⇒ null，登录态角色不变（=user，**不是 admin**）', [null, 'user'], [deniedRole, currentUser().role])

/* D4：表外值 ⇒ null，角色不动。 */
setUser({ ...loginUser })
transportReply = { result: { ok: true, value: { role: 'owner' } } }
const offTableRole = await fetchMyRole()
check('D4', '表外值 owner ⇒ null 且不写登录态（**不默认 admin**）', [null, 'user'], [offTableRole, currentUser().role])

/* D5：回包无角色字段 ⇒ null。 */
setUser({ ...loginUser })
transportReply = { result: { ok: true, value: {} } }
const emptyRole = await fetchMyRole()
check('D5', '回包无 role 字段 ⇒ null', [null, 'user'], [emptyRole, currentUser().role])

/* D6：传输层抛错 ⇒ null（服务层不抛给页面）。 */
setUser({ ...loginUser })
transportReply = () => {
  throw new Error('offline')
}
const thrownRole = await fetchMyRole()
check('D6', '传输抛错 ⇒ null（不 reject、不默认 admin）', [null, 'user'], [thrownRole, currentUser().role])

/* ===========================================================================
   E. 授权面：sub-admin 不获得管理员能力
   =========================================================================== */
section('E', '授权面：isAdmin 对 sub-admin 为 false（权限零放大）')
setUser({ ...loginUser, role: 'sub-admin' })
const subIsAdmin = isAdmin.value
setUser({ ...loginUser, role: 'admin' })
const adminIsAdmin = isAdmin.value
setUser(null)
const guestIsAdmin = isAdmin.value
check('E1', 'isAdmin：sub-admin ⇒ false（对照 admin ⇒ true、游客 ⇒ false）', [false, true, false], [subIsAdmin, adminIsAdmin, guestIsAdmin])

/* ===========================================================================
   F. 静态门（剥注释后判，逐文件点名）
   =========================================================================== */
section('F', '静态门：src/** 权限判据零放大')

const files = walk(SRC)
const adminLinesWithSub = []
let userEqHits = 0
for (const file of files) {
  const text = stripComments(file, fs.readFileSync(file, 'utf8'))
  text.split('\n').forEach((line, index) => {
    if (/role\s*===\s*'admin'/.test(line) && line.includes('sub-admin')) adminLinesWithSub.push(`${rel(file)}:${index + 1}`)
    const matches = line.match(/role\s*===\s*'user'/g)
    if (matches) userEqHits += matches.length
  })
}
check('F1', "静态门：`role === 'admin'` 处零 sub-admin（权限判据未放宽）", [], adminLinesWithSub)
check('F2', "静态门：`role === 'user'` 命中 0", 0, userEqHits)

const sessionSrc = fs.readFileSync(path.join(SRC, 'data/session.js'), 'utf8')
check(
  'F3',
  'session.js::isAdmin 表达式逐字未动（sub-admin 不进管理员判据）',
  true,
  sessionSrc.includes("export const isAdmin = computed(() => state.user !== null && state.user.role === 'admin')")
)

/* ---------------------------------------------------------------------------
   收尾
   --------------------------------------------------------------------------- */
const passed = results.length - failures
console.log(JSON.stringify({ summary: { total: results.length, passed, failed: failures } }))
if (failures > 0) {
  console.log(JSON.stringify({ verdict: 'FAIL', failedIds: results.filter((r) => !r.pass).map((r) => r.id) }))
  process.exit(1)
}
console.log(JSON.stringify({ verdict: 'PASS', note: '掌書記＝真實身份；授權判據一字不動（sub-admin 拿不到任何管理員能力）。' }))
