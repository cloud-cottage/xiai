/**
 * 玺爱 · **印人信息补充 / 编辑（`updatePerson`）离线自检**
 * ============================================================================
 * **本地、离线、零网络、零生产读写**：注入**假 DB**（内存行 + 写计数）＋ **本地现签管理员令牌**
 * 直接驱动云函数 `cloudfunctions/xiai-admin-token` 的真实入口 `index.js::main`（＋ 直调
 * `lib/ops.js::OPS.updatePerson` 取 `plan` 读数），**不 require 任何 SDK、不发任何请求**。
 *
 * 覆盖（逐条硬口）：
 *   A  **越权零写入**：非白名单手机号令牌 / 无令牌 / 身份不可用 ⇒ `FORBIDDEN`，
 *      读面与写面**都无 DB 调用**（零读、零写、行原封不动）。
 *   B  **封闭键面**：未知键 ⇒ `INVALID_FIELD`；`card_id` / `created_by` / `_id` /
 *      `name_source` / `proposal_id` ⇒ 拒且**逐字指名**、零写入；缺 `person_id` ⇒ `MISSING_REQUIRED`。
 *   C  **逐字段长度边界**：11 个单值字段「恰上限 ⇒ 写入成功 / 上限 +1 ⇒ 拒且零写入」。
 *   D  **控制字符与尖括号（实测行为）**：换行只在 `biehao_text` / `biography` 放行；
 *      制表符一律放行；`<` / `>` 与其余 C0 控制字符一律拒（数组项不允许多行）。
 *   E  **数组**：去重保序 ＋ 空项剔除；20 项 / 40 字项边界 ok，21 项 / 41 字项拒且零写入。
 *   F  **空串 · `null` ＝ 清除；未传的键一字不改**（二者严格区分）。
 *   G  **`created_at` / `created_by` / 禁写键不变；`updated_at` 推前**（服务端时钟）。
 *   H  **无实质变化** ⇒ `ok:true` ＋ `changed:[]` ＋ `plan:null` ＋ 零写入。
 *   I  **回包形状**：`plan` **零外传**；`row` 只带 13 白名单字段 ＋ `_id` ＋ `updated_at`。
 *   J  **静态接线**：客户端写面单点恰 1 处（`updatePersonInfo` / `canEditPersonInfo`），
 *      服务端白名单与 `PERSON_EDITABLE_FIELDS` 逐字同集（不立第二套）。
 *
 * 纪律：**不打印任何密钥 / 令牌 / 手机号原文**（只给长度与 sha256 摘要前 12 位）；
 * 密钥缺失时本进程**自签一枚离线密钥**（仅内存、从不落盘、从不打印）⇒ 套件恒可离线跑通；
 * 断言失败 ⇒ 退出码 1。
 */
/* **测试环境保护哨兵（硬防线）**：本套件只跑假 DB ＋ 注入路径，绝不碰真实 CARD / 云端。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
/* **本地现签管理员令牌**（真源算法单点；密钥只从环境变量读，缺则本进程自签一枚离线密钥）。 */
import { signAdminToken } from './lib/sign-test-token.mjs'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FUNCTION_DIR = path.join(ROOT, 'cloudfunctions/xiai-admin-token')

/* --------------------------------------------------------------------------- 0. 断言骨架 */
let total = 0
let passed = 0
const failedIds = []

function canon(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`)
    .join(',')}}`
}

function check(id, testCase, expected, actual) {
  total += 1
  const pass = canon(expected) === canon(actual)
  if (pass) passed += 1
  else failedIds.push(id)
  console.log(JSON.stringify({ id, case: testCase, pass, expected, actual }))
}

const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
const fingerprint = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
const DENIAL_SHAPE = 'message,ok,reason'

/* --------------------------------------------------------------------------- 1. 环境（离线）
   手机号 / 密钥**只从环境变量读**；缺 ⇒ 本进程自签一枚**离线密钥**（randomBytes，仅内存、
   从不打印、从不落盘）—— 本套件测的是**判定与回包形状**，不是密钥材料 ⇒ 恒可离线跑通。 */
const PHONE = String(process.env.XIAI_ADMIN_PHONE || '13000000001').trim()
/* 合成「非白名单」号（形态合法 11 位；与白名单号必不同）。 */
let OUTSIDER = '139' + '0'.repeat(7) + '7'
if (OUTSIDER === PHONE) OUTSIDER = '139' + '0'.repeat(7) + '8'
if (String(process.env.XIAI_ADMIN_TOKEN_SECRET || '').trim() === '') {
  /* 离线自签：随机 32 字符，仅存在于本进程内存（从不打印、从不落盘、不参与任何生产判定）。 */
  process.env.XIAI_ADMIN_TOKEN_SECRET = randomBytes(24).toString('base64url')
}
process.env.XIAI_ADMIN_PHONE = PHONE
process.env.XIAI_ADMIN_TOKEN_VERSION = process.env.XIAI_ADMIN_TOKEN_VERSION || '1'
process.env.XIAI_ADMIN_TOKEN_TTL_SECONDS = process.env.XIAI_ADMIN_TOKEN_TTL_SECONDS || '900'
/* 合成环境 Id：`readConfig` 只做形态门；本套件零网络 ⇒ 无副作用。 */
process.env.TCB_ENV = process.env.TCB_ENV || 'offline-harness-env'
/* 会话优先开关（V6-a）：本套件**恒走令牌路** ⇒ 显式关掉，避免依赖宿主 shell 的开关态。 */
process.env.XIAI_SESSION_AUTHORITY = 'off'

const ADMIN_TOKEN = signAdminToken({ phone: PHONE }).token
const OUTSIDER_TOKEN = signAdminToken({ phone: OUTSIDER }).token
console.log(
  JSON.stringify({
    harness: {
      secretSource: process.env.XIAI_ADMIN_TOKEN_SECRET.length >= 32 ? 'offline-synthesized' : 'env',
      adminTokenFingerprint: fingerprint(ADMIN_TOKEN),
      outsiderTokenFingerprint: fingerprint(OUTSIDER_TOKEN)
    }
  })
)

/* --------------------------------------------------------------------------- 2. 加载被测件 */
const fn = require(path.join(FUNCTION_DIR, 'index.js'))
const ops = require(path.join(FUNCTION_DIR, 'lib/ops.js'))
const configLib = require(path.join(FUNCTION_DIR, 'lib/config.js'))

const PERSON_ID = 'PR-OFFLINE-0001'
const STORE_ID = 'doc-person-1'

/** 基准行（含溯源 / 固定属性键，供「禁写键一字不动」取数）。 */
const BASE = {
  _id: STORE_ID,
  id: PERSON_ID,
  code: 'PR900000001',
  card_id: '900000001',
  name: '黃士陵',
  name_cht: '黃士陵',
  dynasty: '清',
  courtesy_name: '牧甫',
  courtesy_alt_names: ['季廣'],
  art_name: '匋齋',
  zhaihao: '師慎軒',
  zhaihao_alts: ['漢廬'],
  biehao_text: '別號一\n別號二',
  native_place: '安徽黟縣',
  birth_year: '1849',
  death_year: '1908',
  biography: '小傳原文。',
  created_at: '2026-01-01T00:00:00.000Z',
  created_by: 'u-offline-seed',
  updated_at: '2026-01-02T00:00:00.000Z',
  source: 'seed',
  name_source: 'seed',
  proposal_id: 'pp-seed-1'
}

/* --------------------------------------------------------------------------- 3. 假 DB（内存）
   「零写入」的判据 = `stats.writes.length`；「零读」= `stats.reads`。**唯一写点**仍是被测件
   `lib/ops.js::persist()`（本假体只提供 SDK 同形的 `where().update()` / `doc().set()`）。 */
function createStore(seedRows) {
  const collections = {}
  const stats = { writes: [], reads: 0 }
  const reset = (rows) => {
    collections.xiai_persons = new Map()
    ;(rows || []).forEach((row) => collections.xiai_persons.set(row._id, structuredClone(row)))
    stats.writes.length = 0
    stats.reads = 0
  }
  const begin = () => {
    stats.writes.length = 0
    stats.reads = 0
  }
  const provider = () => ({
    collection(name) {
      const map = (collections[name] = collections[name] || new Map())
      return {
        where(match) {
          const hit = () => [...map.values()].filter((row) => Object.keys(match).every((key) => row[key] === match[key]))
          return {
            async get() {
              stats.reads += 1
              return { data: hit().map((row) => structuredClone(row)) }
            },
            async update(doc) {
              const rows = hit()
              rows.forEach((row) => Object.assign(row, doc))
              stats.writes.push({ collection: name, action: 'update', match, count: rows.length })
              return { updated: rows.length }
            }
          }
        },
        doc(id) {
          return {
            async get() {
              stats.reads += 1
              const row = map.get(id)
              return { data: row ? [structuredClone(row)] : [] }
            },
            async set(doc) {
              map.set(id, structuredClone(doc))
              stats.writes.push({ collection: name, action: 'set', id })
              return { updated: 1 }
            }
          }
        }
      }
    }
  })
  reset(seedRows)
  return {
    stats,
    provider,
    reset,
    begin,
    row: () => structuredClone(collections.xiai_persons.get(STORE_ID))
  }
}

const store = createStore([BASE])
ops.setOpsDbProvider(store.provider)

const nowS = () => Math.floor(Date.now() / 1000)
const ADMIN_IDENTITY = Object.freeze({
  uid: 'u-offline-admin',
  phone: PHONE,
  role: 'admin',
  identity_source: ops.IDENTITY_SOURCES.SERVER_TOKEN
})

/** 云函数入口调用（令牌路；`op:'updatePerson'`）。 */
const call = (payload, token) =>
  fn.main({ action: 'verify', token: token === undefined ? ADMIN_TOKEN : token, op: 'updatePerson', payload })
/** 直调 op 本体（取 `plan` 读数 —— `plan` 由 `index.js` 消费，外层回包恒不带）。 */
const direct = (payload, identity) => ops.OPS.updatePerson(payload, identity === undefined ? ADMIN_IDENTITY : identity, nowS())

/** 一次场景的干净起点：重置行 + 清零读写计数。 */
const fresh = (rows) => store.reset(rows === undefined ? [BASE] : rows)

/* ===========================================================================
   A. 越权 ⇒ FORBIDDEN 且**零写入**（读面 / 写面都无 DB 写调用）
   =========================================================================== */
console.log(JSON.stringify({ section: 'A', title: '越权零写入：非管理员 / 无令牌 / 身份不可用' }))
fresh()
const A1 = await call({ person_id: PERSON_ID, name: '篡改' }, OUTSIDER_TOKEN)
check('A1', '非白名单手机号令牌 ⇒ FORBIDDEN', 'FORBIDDEN', A1.reason)
check('A2', '拒绝形状恰 3 键', DENIAL_SHAPE, shapeOf(A1))
check('A3', '零读零写（读面 / 写面都无 DB 调用）', { reads: 0, writes: 0 }, { reads: store.stats.reads, writes: store.stats.writes.length })
check('A4', '行原封未动（零写入的行证）', canon(BASE), canon(store.row()))

store.begin()
const A5 = await call({ person_id: PERSON_ID, name: '篡改' }, '')
check('A5', '无令牌 ⇒ FORBIDDEN', 'FORBIDDEN', A5.reason)
check('A6', '无令牌 ⇒ 零读零写', { reads: 0, writes: 0 }, { reads: store.stats.reads, writes: store.stats.writes.length })

store.begin()
const A7 = await direct({ person_id: PERSON_ID, name: '篡改' }, null)
check('A7', '身份不可用（非管理员身份）⇒ FORBIDDEN', 'FORBIDDEN', A7.reason)
check('A8', '身份门在读行之前 ⇒ 读面 / 写面零 DB 调用', { reads: 0, writes: 0 }, { reads: store.stats.reads, writes: store.stats.writes.length })
check('A9', '拒绝形状恰 3 键 ＋ reason ∈ 冻结表', true, shapeOf(A7) === DENIAL_SHAPE && configLib.REASONS[A7.reason] !== undefined)

store.begin()
const A10 = await call({ person_id: PERSON_ID, name: '篡改', uid: 'u-spoof' }, OUTSIDER_TOKEN)
check('A10', '载荷夹带身份类键（`uid`）＋ 非管理员 ⇒ 仍 FORBIDDEN 且零写入', { reason: 'FORBIDDEN', writes: 0 }, { reason: A10.reason, writes: store.stats.writes.length })

/* ===========================================================================
   B. 封闭键面：未知键 / 明令禁写键 ⇒ INVALID_FIELD ＋ 零写入（逐字指名）
   =========================================================================== */
console.log(JSON.stringify({ section: 'B', title: '封闭键面：未知键与禁写键一律拒且零写入' }))
const FORBIDDEN_SAMPLE = ['card_id', 'created_by', '_id', 'name_source', 'proposal_id']
for (const key of FORBIDDEN_SAMPLE) {
  fresh()
  const result = await call({ person_id: PERSON_ID, name: '改', [key]: 'spoof' })
  check(`B-${key}`, `禁写键 \`${key}\` ⇒ INVALID_FIELD 且零写入`, { reason: 'INVALID_FIELD', writes: 0 }, { reason: result.reason, writes: store.stats.writes.length })
  check(`B-${key}-named`, `拒绝文案**逐字指名** \`${key}\`（不静默丢键）`, true, String(result.message).includes(key))
}
fresh()
const B_unknown = await call({ person_id: PERSON_ID, totally_unknown: 1 })
check('B-unknown', '未知键 ⇒ INVALID_FIELD 且零写入', { reason: 'INVALID_FIELD', writes: 0 }, { reason: B_unknown.reason, writes: store.stats.writes.length })
fresh()
const B_noId = await call({ name: '改' })
check('B-no-id', '缺 `person_id` ⇒ MISSING_REQUIRED 且零写入', { reason: 'MISSING_REQUIRED', writes: 0 }, { reason: B_noId.reason, writes: store.stats.writes.length })
check('B-face', '静态：封闭键面 ＝ 身份键 ＋ 13 可写字段（14）；回包白名单恰 13', { allowed: 14, row: 13 }, { allowed: ops.PERSON_EDIT_ALLOWED_KEYS.length, row: ops.PERSON_EDIT_ROW_KEYS.length })
check('B-forbidden-static', '静态：五个必拒键全部登记在 `PERSON_EDIT_FORBIDDEN_KEYS`', true, FORBIDDEN_SAMPLE.every((key) => ops.PERSON_EDIT_FORBIDDEN_KEYS.indexOf(key) !== -1))

/* ===========================================================================
   C. 逐字段长度边界（11 个单值字段 × 恰上限 ok / 上限+1 拒）
   =========================================================================== */
console.log(JSON.stringify({ section: 'C', title: '长度边界：恰上限写入成功、上限+1 拒且零写入' }))
for (const [key, limit] of Object.entries(ops.PERSON_EDIT_STRING_LIMITS)) {
  fresh()
  const atLimit = '字'.repeat(limit)
  const okResult = await call({ person_id: PERSON_ID, [key]: atLimit })
  check(
    `C-${key}-ok`,
    `${key} 恰 ${limit} 字 ⇒ 写入成功且回写到位`,
    { ok: true, changed: true, stored: atLimit },
    { ok: okResult.ok === true, changed: Array.isArray(okResult.changed) && okResult.changed.indexOf(key) !== -1, stored: store.row()[key] }
  )
  fresh()
  const overResult = await call({ person_id: PERSON_ID, [key]: '字'.repeat(limit + 1) })
  check(
    `C-${key}-over`,
    `${key} ${limit + 1} 字 ⇒ INVALID_VALUE 且零写入`,
    { reason: 'INVALID_VALUE', writes: 0 },
    { reason: overResult.reason, writes: store.stats.writes.length }
  )
}

/* ===========================================================================
   D. 控制字符与尖括号（**实测行为**）
   =========================================================================== */
console.log(JSON.stringify({ section: 'D', title: '控制字符 / 尖括号：换行只在多行字段放行、尖括号一律拒' }))
const D_CASES = [
  ['D1', 'name 含换行 ⇒ INVALID_VALUE（单行字段禁换行）', { name: '甲\n乙' }, 'INVALID_VALUE'],
  ['D2', 'name 含制表符 ⇒ **放行**（实测：制表符一律允许）', { name: '甲\t乙' }, 'ok'],
  ['D3', 'biography 含换行 ⇒ **放行**（多行字段）', { biography: '甲\n乙' }, 'ok'],
  ['D4', 'biehao_text 含换行 / 回车 ⇒ **放行**（多行字段）', { biehao_text: '甲\r\n乙' }, 'ok'],
  ['D5', 'biography 含 `<` ⇒ INVALID_VALUE（尖括号一律拒）', { biography: '甲<乙' }, 'INVALID_VALUE'],
  ['D6', 'name 含 `>` ⇒ INVALID_VALUE（尖括号一律拒）', { name: '甲>乙' }, 'INVALID_VALUE'],
  ['D7', 'biography 含 C0 控制字符（BEL）⇒ INVALID_VALUE', { biography: '甲\u0007乙' }, 'INVALID_VALUE'],
  ['D8', '数组项含换行 ⇒ INVALID_VALUE（数组项不允许多行）', { courtesy_alt_names: ['甲\n乙'] }, 'INVALID_VALUE'],
  ['D9', '数组项含 `<` ⇒ INVALID_VALUE', { courtesy_alt_names: ['甲<乙'] }, 'INVALID_VALUE']
]
for (const [id, title, patch, want] of D_CASES) {
  fresh()
  const result = await call(Object.assign({ person_id: PERSON_ID }, patch))
  const actual = want === 'ok' ? (result.ok === true ? 'ok' : result.reason) : result.reason
  check(id, title, want, actual)
  if (want === 'INVALID_VALUE') {
    check(`${id}-zero-write`, `${id}：值域拒绝 ⇒ 零写入`, 0, store.stats.writes.length)
  }
}

/* ===========================================================================
   E. 数组：去重保序 ＋ 去空项 ＋ 项数 / 项长边界
   =========================================================================== */
console.log(JSON.stringify({ section: 'E', title: '数组：去重保序、空项剔除、>20 项 / 41 字项拒' }))
fresh()
const E1 = await call({ person_id: PERSON_ID, courtesy_alt_names: ['乙', '甲', '', '乙', '丙', '   '] })
check('E1', '数组去重保序 ＋ 空项剔除 ⇒ 落库 `["乙","甲","丙"]`', ['乙', '甲', '丙'], store.row().courtesy_alt_names)
check('E1b', '回包 `changed` 含 `courtesy_alt_names`', true, Array.isArray(E1.changed) && E1.changed.indexOf('courtesy_alt_names') !== -1)

fresh()
const E2 = await call({ person_id: PERSON_ID, courtesy_alt_names: Array.from({ length: 20 }, (_, i) => `別${i}`) })
check('E2', '恰 20 项 ⇒ ok（项数边界）', true, E2.ok === true && store.row().courtesy_alt_names.length === 20)

fresh()
const E3 = await call({ person_id: PERSON_ID, courtesy_alt_names: Array.from({ length: 21 }, (_, i) => `別${i}`) })
check('E3', '21 项 ⇒ INVALID_VALUE 且零写入', { reason: 'INVALID_VALUE', writes: 0 }, { reason: E3.reason, writes: store.stats.writes.length })

fresh()
const E4 = await call({ person_id: PERSON_ID, courtesy_alt_names: ['字'.repeat(40)] })
check('E4', '单项恰 40 字 ⇒ ok（项长边界）', true, E4.ok === true && store.row().courtesy_alt_names[0].length === 40)

fresh()
const E5 = await call({ person_id: PERSON_ID, courtesy_alt_names: ['字'.repeat(41)] })
check('E5', '单项 41 字 ⇒ INVALID_VALUE 且零写入', { reason: 'INVALID_VALUE', writes: 0 }, { reason: E5.reason, writes: store.stats.writes.length })

fresh()
const E6 = await call({ person_id: PERSON_ID, zhaihao_alts: Array.from({ length: 21 }, (_, i) => `齋${i}`) })
check('E6', '`zhaihao_alts` 21 项 ⇒ INVALID_VALUE 且零写入', { reason: 'INVALID_VALUE', writes: 0 }, { reason: E6.reason, writes: store.stats.writes.length })

fresh()
const E7 = await call({ person_id: PERSON_ID, courtesy_alt_names: '不是陣列' })
check('E7', '数组字段传非数组 ⇒ INVALID_VALUE 且零写入', { reason: 'INVALID_VALUE', writes: 0 }, { reason: E7.reason, writes: store.stats.writes.length })

fresh()
const E8 = await call({ person_id: PERSON_ID, courtesy_alt_names: null })
check('E8', '数组传 `null` ＝ 清除 ⇒ 落 `[]`', [], store.row().courtesy_alt_names)

/* ===========================================================================
   F. 空串 ＝ 清除；未传 ＝ 一字不改（严格区分）
   =========================================================================== */
console.log(JSON.stringify({ section: 'F', title: '空串清除 / 未传不改' }))
fresh()
const F1 = await call({ person_id: PERSON_ID, name: '' })
check('F1', '空串 ⇒ 清除字段（落 `null`）', { stored: null, changed: true }, { stored: store.row().name, changed: Array.isArray(F1.changed) && F1.changed.indexOf('name') !== -1 })

fresh()
const F2 = await call({ person_id: PERSON_ID, name: null })
check('F2', '`null` 与空串同义 ⇒ 清除', null, store.row().name)

fresh()
const F3 = await call({ person_id: PERSON_ID, courtesy_alt_names: [] })
check('F3', '空数组 ⇒ 清除（落 `[]`）', [], store.row().courtesy_alt_names)

fresh()
await call({ person_id: PERSON_ID, name: '改名' })
const untouchedKeys = Object.keys(BASE).filter((key) => key !== 'name' && key !== 'updated_at')
const drift = untouchedKeys.filter((key) => canon(store.row()[key]) !== canon(BASE[key]))
check('F4', '只传 `name` ⇒ 其余字段（含 `dynasty` / `biography` / 数组 / 溯源键）**一字不改**', [], drift)

fresh()
await call({ person_id: PERSON_ID, dynasty: '' })
check('F5', '空串清除与「未传不改」严格区分：`dynasty` 清空而 `name` 仍是原值', { dynasty: null, name: BASE.name }, { dynasty: store.row().dynasty, name: store.row().name })

/* ===========================================================================
   G. 时间戳与禁写键
   =========================================================================== */
console.log(JSON.stringify({ section: 'G', title: '`created_at` / `created_by` 不变、`updated_at` 推前、禁写键不动' }))
fresh()
const G1 = await call({ person_id: PERSON_ID, name: '改名後' })
const G_ROW = store.row()
check('G1', '`created_at` 与种子逐字相同', BASE.created_at, G_ROW.created_at)
check('G2', '`created_by` 与种子逐字相同', BASE.created_by, G_ROW.created_by)
check(
  'G3',
  '`updated_at` 取服务端时钟：ISO 形态且**推前**于种子',
  true,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(G_ROW.updated_at)) && String(G_ROW.updated_at) > String(BASE.updated_at)
)
check('G4', '回包 `row.updated_at` 与落库行同值（服务端权威）', G_ROW.updated_at, G1.row && G1.row.updated_at)
const IMMUTABLE = ['_id', 'id', 'code', 'card_id', 'source', 'name_source', 'proposal_id', 'created_at', 'created_by']
check('G5', '固定属性 / 溯源键全部与种子逐字相同', [], IMMUTABLE.filter((key) => canon(G_ROW[key]) !== canon(BASE[key])))

/* ===========================================================================
   H. 无实质变化 ⇒ ok:true ＋ changed:[] ＋ plan:null ＋ 零写入
   =========================================================================== */
console.log(JSON.stringify({ section: 'H', title: '无实质变化：不谎报写入、不推 updated_at' }))
fresh()
const H1 = await direct({ person_id: PERSON_ID, name: BASE.name })
check('H1', '同值写入 ⇒ `ok:true`', true, H1.ok === true)
check('H2', '`changed` 恰 `[]`', [], H1.changed)
check('H3', '`plan` 恰 `null`（无落盘计划）', null, H1.plan)
fresh()
const H4 = await direct({ person_id: PERSON_ID, name: BASE.name, courtesy_alt_names: ['季廣'] })
check('H4', '数组同值（归一后同形）⇒ 仍无变化', { ok: true, changed: [], plan: null }, { ok: H4.ok === true, changed: H4.changed, plan: H4.plan })
check('H5', '两种无变化路径均零写入', 0, store.stats.writes.length)
fresh()
const H6 = await call({ person_id: PERSON_ID, name: BASE.name })
check('H6', '云函数入口：无变化 ⇒ `ok:true` ＋ `changed:[]` ＋ 回包**无 `plan` 键** ＋ 零写入', { ok: true, changed: [], hasPlan: false, writes: 0 }, { ok: H6.ok === true, changed: H6.changed, hasPlan: 'plan' in H6, writes: store.stats.writes.length })
check('H7', '无变化不推 `updated_at`（行未被碰）', canon(BASE), canon(store.row()))

/* ===========================================================================
   I. 回包形状：`plan` 零外传、`row` 只带白名单字段
   =========================================================================== */
console.log(JSON.stringify({ section: 'I', title: '回包形状：plan 恒不外传、row 白名单封闭' }))
fresh()
const I1 = await call({ person_id: PERSON_ID, name: '改名後' })
check('I1', '成功回包**无 `plan` 键**（`plan` 由 `index.js` 消费）', false, 'plan' in I1)
const EXPECTED_ROW_KEYS = [...ops.PERSON_EDIT_ROW_KEYS, '_id', 'updated_at'].sort()
check('I2', '`row` 键面恰 ＝ 13 白名单字段 ＋ `_id` ＋ `updated_at`', EXPECTED_ROW_KEYS, Object.keys(I1.row || {}).sort())
const LEAK_KEYS = ['code', 'card_id', 'created_by', 'created_at', 'source', 'name_source', 'proposal_id', 'id']
check('I3', '`row` 零内部 / 溯源 / 身份键', [], LEAK_KEYS.filter((key) => key in (I1.row || {})))
check('I4', '`changed` 只含白名单字段名（⊆ 13 字段面）', true, (I1.changed || []).every((key) => ops.PERSON_EDIT_ROW_KEYS.indexOf(key) !== -1))
fresh()
const I5 = await call({ person_id: PERSON_ID, name: '字'.repeat(9999) })
check('I5', '拒绝回包无 `row` / 无 `plan`（恰 3 键）', { hasRow: false, hasPlan: false, shape: DENIAL_SHAPE }, { hasRow: 'row' in I5, hasPlan: 'plan' in I5, shape: shapeOf(I5) })
check('I6', '成功回包带 `authority` ＝ `SERVER`（服务端权威行）', 'SERVER', I1.authority)

/* ===========================================================================
   J. 静态接线：客户端写面单点 ＋ 两侧白名单同集（不立第二套）
   =========================================================================== */
console.log(JSON.stringify({ section: 'J', title: '静态接线：写面单点、判定单点、两侧键面同集' }))
const PERSONS_SRC = read('src/services/persons.js')
const ADMIN_SRC = read('src/services/admin.js')
const VIEW_SRC = read('src/views/PersonDetailView.vue')

function countOf(text, needle) {
  return text.split(needle).length - 1
}

/** 剥注释（`<!-- -->` / `/* *\/` / 行首 `//`、`*`）—— 产品件注释里逐字写着这些标识符，
    不剥会把说明当实码（口径照本仓既有套件 `verify-admin-buttons.mjs`）。 */
function stripComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}
const PERSONS_CLEAN = stripComments(PERSONS_SRC)
const VIEW_CLEAN = stripComments(VIEW_SRC)
check('J1', '`updatePersonInfo` 定义恰 1 处（`src/services/persons.js`）', ['src/services/persons.js'], filesWith(/export async function updatePersonInfo\(/))
check('J2', '`canEditPersonInfo` 定义恰 1 处（同一文件）', ['src/services/persons.js'], filesWith(/export function canEditPersonInfo\(/))
check(
  'J3',
  '调用点只有详情页（剥注释后 `persons.updatePersonInfo(` / `persons.canEditPersonInfo(` 恰 1 ＋ 1，零第二处调用）',
  { update: 1, edit: 1, files: ['src/views/PersonDetailView.vue'] },
  {
    update: countOf(VIEW_CLEAN, 'persons.updatePersonInfo('),
    edit: countOf(VIEW_CLEAN, 'persons.canEditPersonInfo('),
    files: filesWith(/persons\.(updatePersonInfo|canEditPersonInfo)\(/)
  }
)
check('J4', '写面单点：只经 `admin.js::adminWriteGate(\'updatePerson\')`，无第二条通道', { gate: 1, directChannel: 0 }, { gate: countOf(PERSONS_CLEAN, "adminWriteGate('updatePerson'"), directChannel: countOf(PERSONS_CLEAN, 'adminTokenChannel.gate(') })
check('J5', '`readoutKeys` 只声明 `changed`（`plan` 恒不索取、`gate.plan` 零读）', { readout: true, planLeak: 0 }, { readout: PERSONS_SRC.includes("readoutKeys: ['changed']"), planLeak: countOf(PERSONS_SRC, 'gate.plan') + countOf(PERSONS_SRC, "readoutKeys: ['plan']") })
const CLIENT_FIELDS = (() => {
  const start = PERSONS_SRC.indexOf('PERSON_EDITABLE_FIELDS = Object.freeze([')
  if (start === -1) return null
  const end = PERSONS_SRC.indexOf('])', start)
  return (PERSONS_SRC.slice(start, end).match(/'([a-z_]+)'/g) || []).map((x) => x.slice(1, -1))
})()
check('J6', '客户端 `PERSON_EDITABLE_FIELDS`（13）与服务端 `PERSON_EDIT_ROW_KEYS` **逐字同集**', { count: 13, same: true }, { count: (CLIENT_FIELDS || []).length, same: canon((CLIENT_FIELDS || []).slice().sort()) === canon(ops.PERSON_EDIT_ROW_KEYS.slice().sort()) })
check('J7', '服务层越权文案经 `ADMIN_LABEL` 插值（零硬编码身份词）', { adminJs: true, personsJs: true }, { adminJs: ADMIN_SRC.includes('${ADMIN_LABEL}寫入服務暫不可用'), personsJs: PERSONS_SRC.includes('${ADMIN_LABEL}寫入服務暫不可用') })
check('J8', '详情页入口 `data-action="person-edit"` 恰 1 处 ＋ `useEscToClose` 接线', { action: 1, esc: 1 }, { action: countOf(VIEW_SRC, 'data-action="person-edit"'), esc: countOf(VIEW_SRC, 'useEscToClose(') })
check('J9', '静态：样式补齐（遮罩 / 框 / 四组 / 错误行 / 就地反馈九类选择器齐备）', true, [
  '.person-edit-mask',
  '.person-edit-box {',
  '.person-edit-box__title',
  '.person-edit-box__lede',
  '.person-edit-box__error',
  '.person-edit-box__foot',
  '.person-edit-group {',
  '.person-edit-group__legend',
  '.person__edit-feedback'
].every((needle) => VIEW_SRC.includes(needle)))

/** 全 `src/**` 扫命中某正则的文件（零依赖、递归）。 */
function filesWith(pattern) {
  const hits = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(js|vue|mjs)$/.test(name) && pattern.test(readFileSync(full, 'utf8'))) {
        hits.push(path.relative(ROOT, full).split(path.sep).join('/'))
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  return hits.sort()
}

/* --------------------------------------------------------------------------- 汇总 */
ops.setOpsDbProvider(null)
console.log(JSON.stringify({ summary: { total, passed, failed: total - passed, failed_ids: failedIds } }))
if (failedIds.length > 0) process.exit(1)
