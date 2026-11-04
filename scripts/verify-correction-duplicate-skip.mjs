/**
 * 玺爱 · **勘误重复提交按字段跳过 ＋ 防重只认未驳回行** 自检（v1.83 / `AC-632` 〜 `AC-635`）
 * ============================================================================
 * **本地、离线、零网络**（注入式假体：自造传输 ＋ 自造存储 / DB，把请求交给**真实云函数体**；
 *  视图层两处循环**提取真源执行**，不以「读代码推断」充当证据）。
 *
 * 跑什么（逐条对应 `docs/xiai.spec.md` §10.69）：
 *   A. **云函数本体**（`cloudfunctions/xiai-user-token/lib/ops.js`，真实函数体 ＋ 假 DB）：
 *      ① 同 `(faceId, field, value)` 已有 `PENDING` 行 ⇒ 重提回包恰
 *         `{ ok:false, reason:'DUPLICATE_VALUE', message }`（键集不变）＋ **零写入**
 *         （行集合与行数前后逐字不变）；② 判定面静态锚（恰三键 ＋ `REJECTED` 过滤）；
 *      ③ 同三键已有 `REJECTED` 行 ⇒ 重提受理成功、新增恰 1 行、原 `REJECTED` 行不被改写 /
 *         删除；对照组（改回 `PENDING`）仍拒；④ `ACCEPTED` 仍参与防重（反向封堵）；
 *      ⑤ 负例：跨印面 / 跨字段 / 值改一个字（标点、全半角）**均不判重**。
 *   B. **服务层本地前置门**（`src/services/corrections.js::submitCorrection`，云端形态端到端）：
 *      本机镜像 `REJECTED` 行不参与防重 ⇒ 放行到服务端受理；改回 `PENDING` ⇒ 本地门拒
 *      （恰 3 键 ＋ 零写入 ＋ **零往返**）；值逐字比较（标点变体不判重）。
 *   C. **视图层两处循环**（`SealDetailView.vue::submitFaceEntry` / `submitCorrection`，
 *      提取函数体真源后以注入依赖执行）：部分跳过 / 全部跳过 / 真实失败 / 0 跳过 四态上屏**逐字**；
 *      两条跳过文案 `s2t(x) === x` 恒等 ＋「失敗 / 错误」族字样命中数 ＝ 0；
 *      表单收尾（`accepted + skipped === 填写项数` ⇒ 清空草稿 / 关闭弹窗）。
 *   D. **回包信封不变量**：`submitCorrection` 拒绝面恰 3 键；`endorseCorrection` /
 *      `reviewCorrection` 的响应键集与**改前（`83cceb0^`）**逐字相同（改前模块由
 *      `git show` 取出到一次性目录后**实跑**对拍，另配冻结字面值双锚）。
 *
 * 纪律：不打印任何密钥 / 验证码 / 令牌原文（只给长度与指纹）；不碰任何服务、不联网、
 *       只跑短进程；断言失败 ⇒ 退出码非 0；写集仅本文件（临时件只落 `TMPDIR`）。
 *
 * 用法：`node scripts/verify-correction-duplicate-skip.mjs`
 */

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, cpSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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

/** 冻结 reason 表（并集；`DUPLICATE_VALUE` 为本单判据面字面值，零新增）。 */
const FROZEN_REASONS = [
  'FORBIDDEN',
  'INVALID_VALUE',
  'INVALID_FIELD',
  'MISSING_REQUIRED',
  'STORAGE_UNAVAILABLE',
  'ALREADY_ENDORSED',
  'DUPLICATE_VALUE'
]
const isDenial = (value) =>
  value && value.ok === false && shapeOf(value) === 'message,ok,reason' && FROZEN_REASONS.indexOf(value.reason) !== -1
/** 恰 3 键的结构化拒绝（回包信封不变量的判据）。 */
const DENIAL_KEYS = ['message', 'ok', 'reason']

/* ---------------------------------------------------------------------------
   2. 环境（一次性合成环境；脚本内零密钥字面值）
   --------------------------------------------------------------------------- */
const PHONE = String(process.env.XIAI_USER_PHONE || '13800000001').trim()
const OTHER_PHONE = '13800000002'
const ADMIN_PHONE = String(process.env.XIAI_ADMIN_PHONE || '13000000001').trim()
/* 验证码取**客户端公开演示码**（`auth.js::DEMO_SMS_CODE`；生产不变量，非放宽）。 */
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
const UID_ME = uidOfPhone(PHONE)
const UID_OTHER = uidOfPhone(OTHER_PHONE)

/* ---------------------------------------------------------------------------
   3. 加载被测件（云函数本体 ＋ 令牌库）
   --------------------------------------------------------------------------- */
const FUNCTION_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')
const fn = require(path.join(FUNCTION_DIR, 'index.js'))
const ops = require(path.join(FUNCTION_DIR, 'lib/ops.js'))
const userLib = require(path.join(FUNCTION_DIR, 'lib/token.js'))

/** 假 DB（内存；`where().get()` / `where().update()` / `doc().set()` / `add()`；
 *  「零写入」的判据 ＝ 写计数 ＋ 行集合快照双保险）。 */
function createStore() {
  const collections = {}
  const stats = { writes: [], reads: 0 }
  const mapOf = (name) => (collections[name] = collections[name] || new Map())
  const provider = () => ({
    collection(name) {
      const map = mapOf(name)
      return {
        where(match) {
          const hit = () =>
            [...map.values()].filter((row) => Object.keys(match).every((key) => String(row[key]) === String(match[key])))
          return {
            async get() {
              stats.reads += 1
              return { data: hit().map((row) => Object.assign({}, row)) }
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

/* 常量面（A 段用）。 */
const FACE_A = 'fc-dup-skip-a'
const FACE_B = 'fc-dup-skip-b'
const SEAL_A = 'XA000000001'
const FIELD_FREE = 'transcription'
const FIELD_OTHER = 'seal_name'
const V_PENDING = '玄同甲'
const V_REJECTED = '玄同乙'
const V_ACCEPTED = '玄同丙'
const V_PUNCT = '玄同丁。'
const V_HALFWIDTH = 'ABC123'
const V_FULLWIDTH = 'ＡＢＣ１２３'

const tokenFor = (phone) =>
  userLib.issueToken({ sub: phone, secret: SECRET, nowSeconds: nowS(), ttlSeconds: 900, version: '1', role: 'user' }).token
const TOKEN_ME = tokenFor(PHONE)
const TOKEN_ADMIN = tokenFor(ADMIN_PHONE)

/** 造一条勘误行（`status` 由调用方给）。 */
const makeRow = ({ id, faceId = FACE_A, field = FIELD_FREE, value, status, userId = UID_OTHER }) => ({
  __collection: 'xiai_corrections',
  _id: id,
  id,
  faceId,
  sealId: SEAL_A,
  stamp_id: SEAL_A,
  user_id: userId,
  userId,
  field,
  field_label: '印文釋義',
  value,
  status,
  created_at: '2026-11-01T00:00:00.000Z'
})

/** `xiai_corrections` 行集合快照（按 `_id` 排序 ＋ 键序规范化 ⇒ 可做「逐字」比较）。 */
function correctionsSnapshot() {
  const rows = [...store.mapOf('xiai_corrections').values()].map((row) => canonical(Object.assign({}, row)))
  rows.sort()
  return rows
}
const rowCount = () => store.mapOf('xiai_corrections').size

/** 提交一枚（真实云函数体）。 */
const submit = (payload, token = TOKEN_ME) =>
  fn.main({ action: 'verify', token, op: 'submitCorrection', payload })

/* ---------------------------------------------------------------------------
   4. A 段：云函数本体（`AC-632` / `AC-633` 服务端面）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'A', title: '云函数 submitCorrection：PENDING 零写入 / REJECTED 放行 / 三键判定面' }))

/* A1：同三键已有 PENDING 行 ⇒ 结构化拒绝 ＋ 零写入 ＋ 行集合逐字不变。 */
store.load([makeRow({ id: 'c-pending-1', value: V_PENDING, status: 'PENDING' })])
{
  const beforeRows = correctionsSnapshot()
  const beforeCount = rowCount()
  const beforeWrites = store.stats.writes.length
  const dup = await submit({ faceId: FACE_A, sealId: SEAL_A, stampId: SEAL_A, field: FIELD_FREE, value: V_PENDING })
  check('A1', 'AC-632① 同 (faceId,field,value) 已有 PENDING 行 ⇒ 重提回包恰 3 键 {ok,reason,message}', DENIAL_KEYS, Object.keys(dup).sort())
  check('A1b', 'AC-632① reason 字面值 ＝ 冻结值 DUPLICATE_VALUE（零新增）', 'DUPLICATE_VALUE', dup.reason)
  check('A1c', 'AC-632① 回包 ok ＝ false 且 message 为非空文本', true, dup.ok === false && typeof dup.message === 'string' && dup.message.length > 0)
  check('A1d', 'AC-632① 零写入（写计数不变）', beforeWrites, store.stats.writes.length)
  check('A1e', 'AC-632① 零写入（行数不变）', beforeCount, rowCount())
  check('A1f', 'AC-632① 行集合前后**逐字不变**（快照 canonical 相等）', beforeRows, correctionsSnapshot())
}

/* A2：判定面静态锚 —— 判定源码恰三键 ＋ 滤掉 REJECTED（`AC-632` 取证方式 ②）。 */
{
  const opsSrc = readFileSync(path.join(FUNCTION_DIR, 'lib/ops.js'), 'utf8')
  const tripleAnchor = /readRows\(\s*COLLECTIONS\.corrections\s*,\s*\{\s*faceId\s*,\s*field\s*,\s*value\s*\}\s*\)/.test(opsSrc)
  const filterAnchor =
    /const duplicate = duplicateAll\.filter\(\s*\(row\)\s*=>\s*text\(row && row\.status\) !== CORRECTION_STATUS\.REJECTED\s*\)/.test(opsSrc)
  check('A2', 'AC-632② 防重判定读行**恰三键** (faceId, field, value)（无归一、无附加键）', true, tripleAnchor)
  check('A2b', 'AC-632② / AC-633① 判定前**滤掉 REJECTED 行**（未驳回行才参与防重）', true, filterAnchor)
}

/* A3：同三键已有 REJECTED 行 ⇒ 受理成功 ＋ 新增恰 1 行 ＋ 原行不被改写 / 删除。 */
store.load([makeRow({ id: 'c-rejected-1', value: V_REJECTED, status: 'REJECTED' })])
{
  const beforeRows = correctionsSnapshot()
  const beforeCount = rowCount()
  const beforeWrites = store.stats.writes.length
  const resubmit = await submit({ faceId: FACE_A, sealId: SEAL_A, stampId: SEAL_A, field: FIELD_FREE, value: V_REJECTED })
  check('A3', 'AC-633② 同三键 REJECTED 行 ⇒ 重提受理成功（非 DUPLICATE_VALUE 拒绝）', true, resubmit.ok === true && resubmit.reason === undefined)
  check('A3b', 'AC-633② 恰新增 1 行（行数 ＋1）', beforeCount + 1, rowCount())
  check('A3c', 'AC-633② 落盘恰两处（勘误私有行 add ＋ 值级摘要行 set）', ['xiai_correction_summaries', 'xiai_corrections'], sorted(store.stats.writes.slice(beforeWrites).map((w) => w.collection)))
  const kept = store.mapOf('xiai_corrections').get('c-rejected-1')
  const original = beforeRows.find((row) => row.includes('c-rejected-1'))
  check('A3d', 'AC-633② 原 REJECTED 行**未被改写**（逐字）', original, canonical(Object.assign({}, kept)))
  check('A3e', 'AC-633② 原 REJECTED 行**未被删除**（仍在集合内）', true, rowCount() === beforeCount + 1 && !!kept && kept.status === 'REJECTED')
}

/* A3d 对照组：同一三键改造成 PENDING ⇒ 仍拒 ＋ 零写入。 */
store.load([makeRow({ id: 'c-control-1', value: V_PENDING, status: 'PENDING' })])
{
  const beforeRows = correctionsSnapshot()
  const beforeWrites = store.stats.writes.length
  const control = await submit({ faceId: FACE_A, sealId: SEAL_A, stampId: SEAL_A, field: FIELD_FREE, value: V_PENDING })
  check('A3f', 'AC-633③ 对照组：同三键 PENDING ⇒ 仍 DUPLICATE_VALUE', true, isDenial(control) && control.reason === 'DUPLICATE_VALUE')
  check('A3g', 'AC-633③ 对照组 ⇒ 零写入 ＋ 行集合逐字不变', true, store.stats.writes.length === beforeWrites && canonical(correctionsSnapshot()) === canonical(beforeRows))
}

/* A4（反向封堵）：ACCEPTED 行**仍参与**防重（不得读作「可再次提交」）。 */
store.load([makeRow({ id: 'c-accepted-1', value: V_ACCEPTED, status: 'ACCEPTED' })])
{
  const beforeWrites = store.stats.writes.length
  const acceptedRow = await submit({ faceId: FACE_A, sealId: SEAL_A, stampId: SEAL_A, field: FIELD_FREE, value: V_ACCEPTED })
  check('A4', 'AC-633 封堵：ACCEPTED 行仍参与防重 ⇒ DUPLICATE_VALUE ＋ 零写入', true, isDenial(acceptedRow) && acceptedRow.reason === 'DUPLICATE_VALUE' && store.stats.writes.length === beforeWrites)
}

/* A5〜A7：负例 —— 跨印面 / 跨字段 / 值改一个字（标点、全半角）均不判重。 */
{
  /* 跨印面：同 field 同 value 落在另一印面 ⇒ 受理。 */
  store.load([makeRow({ id: 'c-face-a', value: V_PENDING, status: 'PENDING' })])
  const wFace = store.stats.writes.length
  const crossFace = await submit({ faceId: FACE_B, sealId: SEAL_A, stampId: SEAL_A, field: FIELD_FREE, value: V_PENDING })
  check('A5', 'AC-632③ 跨印面（同 field/value，另一 faceId）⇒ 不判重、正常受理', true, crossFace.ok === true && store.stats.writes.length === wFace + 2)

  /* 跨字段：同 face 同 value 换字段 ⇒ 受理。 */
  store.load([makeRow({ id: 'c-field-a', value: V_PENDING, status: 'PENDING' })])
  const wField = store.stats.writes.length
  const crossField = await submit({ faceId: FACE_A, sealId: SEAL_A, stampId: SEAL_A, field: FIELD_OTHER, value: V_PENDING })
  check('A6', 'AC-632③ 跨字段（同 face/value，另一 field）⇒ 不判重、正常受理', true, crossField.ok === true && store.stats.writes.length === wField + 2)

  /* 值改一个字：标点。 */
  store.load([makeRow({ id: 'c-punct-a', value: V_PENDING, status: 'PENDING' })])
  const wPunct = store.stats.writes.length
  const punct = await submit({ faceId: FACE_A, sealId: SEAL_A, stampId: SEAL_A, field: FIELD_FREE, value: V_PUNCT })
  check('A7', 'AC-632③ 值改一个字（标点：`玄同甲` vs `玄同甲。`）⇒ 不判重、正常受理', true, punct.ok === true && store.stats.writes.length === wPunct + 2)

  /* 值改一个字：全半角。 */
  store.load([makeRow({ id: 'c-width-a', value: V_HALFWIDTH, status: 'PENDING' })])
  const wWidth = store.stats.writes.length
  const width = await submit({ faceId: FACE_A, sealId: SEAL_A, stampId: SEAL_A, field: FIELD_FREE, value: V_FULLWIDTH })
  check('A7b', 'AC-632③ 值改一个字（全半角：`ABC123` vs `ＡＢＣ１２３`）⇒ 不判重、正常受理', true, width.ok === true && store.stats.writes.length === wWidth + 2)
}

/* ---------------------------------------------------------------------------
   5. B 段：服务层本地前置门（`src/services/corrections.js`，云端形态端到端）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'B', title: '服务层本地前置防重：REJECTED 不参与 / PENDING 参与 / 逐字比较' }))

const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
const session = await import(path.join(ROOT, 'src/data/session.js'))
const db = await import(path.join(ROOT, 'src/data/db.js'))
const storage = await import(path.join(ROOT, 'src/data/storage.js'))
const corrections = await import(path.join(ROOT, 'src/services/corrections.js'))
const userTokenSvc = await import(path.join(ROOT, 'src/services/userToken.js'))

const transportCalls = []
userTokenSvc.setUserTokenTransport(async (name, data) => {
  transportCalls.push({ name, action: data && data.action, op: data && data.op })
  return { result: await fn.main(data) }
})
writeFace.setWriteFaceModeOverride('cloud')
db.ensureSeed()

const login = await userTokenSvc.ensureUserLoginToken(PHONE, SMS_CODE)
check('B0', '前置：云端形态 ＋ 登录取票成功（注入式传输 → 真实云函数体）', true, login.ok === true && writeFace.writeFaceMode() === 'cloud')

const USER = { id: UID_ME, phone: PHONE, role: 'user', nickname: '自檢用戶' }
session.setUser(USER)
const face = db.listFaceRows()[0]
check('B0b', '前置：本机有可提交的印面', true, !!face && !!face.id)

const B_FIELD = 'transcription'
const B_VALUE = '玄同乙'
const seedLocal = (status) =>
  storage.writeKey(storage.STORAGE_KEYS.corrections, [
    {
      id: 'c-local-1',
      faceId: face.id,
      sealId: face.sealId,
      stamp_id: face.sealId,
      user_id: UID_OTHER,
      userId: UID_OTHER,
      field: B_FIELD,
      field_label: '印文釋義',
      value: B_VALUE,
      status,
      created_at: '2026-11-01T00:00:00.000Z'
    }
  ])
const seedCloud = (status) =>
  store.load([
    makeRow({ id: 'c-cloud-1', faceId: face.id, field: B_FIELD, value: B_VALUE, status, userId: UID_OTHER })
  ])
const localSnapshot = () => {
  const rows = (storage.readKey(storage.STORAGE_KEYS.corrections) || []).map((row) => canonical(Object.assign({}, row)))
  rows.sort()
  return rows
}

/* B1：本机镜像 ＋ 云端同三键均为 REJECTED ⇒ 重提受理成功（两道门都放行）。 */
seedLocal('REJECTED')
seedCloud('REJECTED')
{
  const localBefore = localSnapshot()
  const cloudRowsBefore = correctionsSnapshot()
  const cloudWritesBefore = store.stats.writes.length
  const okRes = await corrections.submitCorrection({ faceId: face.id, sealId: face.sealId, field: B_FIELD, value: B_VALUE })
  check('B1', 'AC-633② 本机 ＋ 云端同三键 REJECTED ⇒ 服务层受理成功（ok:true）', true, okRes.ok === true)
  check('B1b', 'AC-633② 云端恰新增 1 行（行数 ＋1）', cloudRowsBefore.length + 1, correctionsSnapshot().length)
  check('B1c', 'AC-633② 落盘恰两处（私有行 ＋ 摘要行）', 2, store.stats.writes.length - cloudWritesBefore)
  const localAfter = storage.readKey(storage.STORAGE_KEYS.corrections) || []
  check('B1d', 'AC-633② 本机镜像原 REJECTED 行未被改写 / 未被删除（首行逐字不变）', localBefore[0], canonical(Object.assign({}, localAfter[0])))
  check('B1e', 'AC-633② 本机镜像新增恰 1 行', 2, localAfter.length)
}

/* B2：同一三键改回 PENDING ⇒ 服务层**本地前置门**拒（恰 3 键 ＋ 零写入 ＋ 零往返）。 */
seedLocal('PENDING')
seedCloud('PENDING')
{
  const localBefore = localSnapshot()
  const cloudBefore = correctionsSnapshot()
  const cloudWritesBefore = store.stats.writes.length
  const callsBefore = transportCalls.length
  const dupRes = await corrections.submitCorrection({ faceId: face.id, sealId: face.sealId, field: B_FIELD, value: B_VALUE })
  check('B2', 'AC-632① 本机同三键 PENDING ⇒ 服务层拒：恰 3 键 ＋ DUPLICATE_VALUE', true, isDenial(dupRes) && dupRes.reason === 'DUPLICATE_VALUE')
  check('B2b', 'AC-632① 本地门拒 ⇒ 云端零写入（写计数 ＋ 行集合均不变）', true, store.stats.writes.length === cloudWritesBefore && canonical(correctionsSnapshot()) === canonical(cloudBefore))
  check('B2c', 'AC-632① 本地门拒 ⇒ 本机镜像零写入（逐字不变）', localBefore, localSnapshot())
  check('B2d', 'AC-632① 本地门拒 ⇒ **零往返**（传输调用数不变 ⇒ 判定在任何写 / 任何网络之前）', callsBefore, transportCalls.length)
}

/* B3：本地门判定面静态锚 —— `normalizeCorrectionStatus(...) !== REJECTED` 在防重判定内。 */
{
  const src = readFileSync(path.join(ROOT, 'src/services/corrections.js'), 'utf8')
  const anchor =
    /normalizeCorrectionStatus\(row && row\.status\) !== CORRECTION_STATUS\.REJECTED\s*&&\s*String\(\(row && row\.field\) \|\| ''\) === String\(field\)/.test(
      src.replace(/\s+/g, ' ')
    )
  check('B3', 'AC-632② / AC-633① 服务层防重判定先滤 REJECTED 再逐字比 field / value（静态锚）', true, anchor)
}

/* B4：值逐字比较（标点变体）在本地门同样不判重 ⇒ 放行到服务端受理。 */
seedLocal('PENDING')
store.load([])
{
  const callsBefore = transportCalls.length
  const punctRes = await corrections.submitCorrection({
    faceId: face.id,
    sealId: face.sealId,
    field: B_FIELD,
    value: `${B_VALUE}。`
  })
  check('B4', 'AC-632③ 本地门值逐字比较（`玄同乙` vs `玄同乙。`）⇒ 不判重、受理成功', true, punctRes.ok === true && transportCalls.length > callsBefore)
}

/* ---------------------------------------------------------------------------
   6. C 段：视图层两处循环（提取 `SealDetailView.vue` 函数体真源后注入执行）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'C', title: '视图层：部分跳过 / 全部跳过 / 真实失败 / 表单收尾（逐字上屏）' }))

const VUE_PATH = path.join(ROOT, 'src/views/SealDetailView.vue')
const vueSrc = readFileSync(VUE_PATH, 'utf8')

/** 跳过字符串字面量（处理转义与模板串 `${…}`）。返回下一个下标。 */
function skipString(src, i) {
  const quote = src[i]
  let j = i + 1
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (quote === '`' && c === '$' && src[j + 1] === '{') {
      j = skipBraced(src, j + 1)
      continue
    }
    if (c === quote) return j + 1
    if (quote !== '`' && c === '\n') return j
    j += 1
  }
  throw new Error('视图源提取：字符串未闭合')
}
/** 跳过以 `{` 开头的块（模板表达式 / 普通块），返回 `}` 之后的下标。 */
function skipBraced(src, i) {
  let depth = 0
  let j = i
  while (j < src.length) {
    const c = src[j]
    if (c === "'" || c === '"' || c === '`') {
      j = skipString(src, j)
      continue
    }
    if (c === '/' && src[j + 1] === '/') {
      const nl = src.indexOf('\n', j)
      j = nl < 0 ? src.length : nl
      continue
    }
    if (c === '/' && src[j + 1] === '*') {
      j = src.indexOf('*/', j) + 2
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return j + 1
    }
    j += 1
  }
  throw new Error('视图源提取：块未闭合')
}
/** 提取 `function <name>(…){…}` / `async function <name>(…){…}` 全文（花括号配对 ＋ 注释 / 字符串感知）。 */
function extractFunction(src, name, isAsync = false) {
  const marker = `${isAsync ? 'async ' : ''}function ${name}(`
  const start = src.indexOf(marker)
  if (start < 0) throw new Error(`视图源提取：找不到 ${marker}`)
  let i = start + marker.length - 1
  let paren = 0
  let bodyOpen = -1
  while (i < src.length) {
    const c = src[i]
    if (c === '(') paren += 1
    else if (c === ')') paren -= 1
    else if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i)
      continue
    } else if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? src.length : nl
      continue
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i) + 2
      continue
    } else if (c === '{' && paren === 0) {
      bodyOpen = i
      break
    }
    i += 1
  }
  if (bodyOpen < 0) throw new Error(`视图源提取：${name} 找不到函数体`)
  const end = skipBraced(src, bodyOpen)
  return src.slice(start, end)
}

const FACE_ENTRY_SRC = extractFunction(vueSrc, 'submitFaceEntry', true)
const FORM_SRC = extractFunction(vueSrc, 'submitCorrection', true)
/* 两处循环依赖的**模块级**真源一并提取（成功句 / 部分跳过句 / 全部跳过句）。 */
const FEEDBACK_HELPER_SRC = extractFunction(vueSrc, 'correctionFeedbackOf', false)
const SKIP_ALL_CONST_SRC = (vueSrc.match(/const CORRECTION_SKIP_ALL_MESSAGE =\s*'[^']*'/) || [''])[0]
check('C0', '两处提交循环 ＋ 文案常量 / 成功句函数均从视图真源提取成功（不以读代码推断充当证据）', true, FACE_ENTRY_SRC.length > 500 && FORM_SRC.length > 500 && FEEDBACK_HELPER_SRC.length > 100 && SKIP_ALL_CONST_SRC.includes('CORRECTION_SKIP_ALL_MESSAGE ='))

const FACE_CONTENT_KEY = (vueSrc.match(/const FACE_CONTENT_KEY = '([^']+)'/) || [])[1]
const FACE_STYLE_KEY = (vueSrc.match(/const FACE_STYLE_KEY = '([^']+)'/) || [])[1]
check('C0b', '常量锚：FACE_CONTENT_KEY / FACE_STYLE_KEY 仍为 seal_type / face_style', ['seal_type', 'face_style'], [FACE_CONTENT_KEY, FACE_STYLE_KEY])

const points = await import(path.join(ROOT, 'src/services/points.js'))
const trad = await import(path.join(ROOT, 'src/utils/traditional.js'))
check('C0c', '奖励常量 R ＝ 10（文案里的 R 取真源）', 10, points.CORRECTION_REWARD)

const makeViewRunner = () =>
  new Function(
    'corrections',
    'points',
    'faceEntryFeedback',
    'faceEntryDraftOf',
    'FACE_CONTENT_KEY',
    'FACE_STYLE_KEY',
    'seal',
    'dataVersion',
    'form',
    'formFaceId',
    'formFeedback',
    'formOpen',
    'correctionFieldVisible',
    `const publishCorrectionNotice = () => {};\n${SKIP_ALL_CONST_SRC}\n${FEEDBACK_HELPER_SRC}\n${FACE_ENTRY_SRC}\n${FORM_SRC}\nreturn { submitFaceEntry, submitCorrection }`
  )

const SKIP_ALL_MESSAGE = '所選項目已有相同提交，本次未新增勘誤。若你贊同該值，請改用【採信】為它佐證。'
const FAIL_MESSAGE = '該印面「印面內容」值域不符；本次零寫入。'
const FAIL_MESSAGE_FORM = '「印文釋義」值域不符；本次零寫入。'
const dupResult = () => ({ ok: false, reason: 'DUPLICATE_VALUE', message: '該印面「印文釋義」已有完全相同的提交值 ⇒ 同一段文字只允許一人提交。' })
const okResult = () => ({ ok: true, authority: 'SERVER' })
const failResult = (message) => ({ ok: false, reason: 'INVALID_VALUE', message })

const runner = makeViewRunner()
check('C0d', '从视图真源提取的「全部跳过」文案常量逐字 ＝ 冻结期望（`AC-635②` 去向句）', SKIP_ALL_MESSAGE, (SKIP_ALL_CONST_SRC.match(/'([^']*)'/) || [])[1])

/** 跑一次 `submitFaceEntry`（faceEntry 两字段：content ＋ style）。 */
async function runFaceEntry(script, draftInit) {
  let i = 0
  const calls = []
  const fake = {
    MARKABLE_FIELDS: corrections.MARKABLE_FIELDS,
    newBatchId: () => 'qa-batch-view-1',
    submitCorrection: async (args) => {
      calls.push(args)
      const step = script[i]
      if (!step) throw new Error('视图脚本用尽（多调了一次 submitCorrection）')
      i += 1
      return step
    }
  }
  const draft = Object.assign({ content: '', style: '' }, draftInit)
  const faceEntryFeedback = {}
  const env = {
    corrections: fake,
    points,
    faceEntryFeedback,
    faceEntryDraftOf: () => draft,
    FACE_CONTENT_KEY,
    FACE_STYLE_KEY,
    seal: { value: { stamp_id: SEAL_A } },
    dataVersion: { value: 0 },
    form: {},
    formFaceId: { value: '' },
    formFeedback: { value: '' },
    formOpen: { value: false },
    correctionFieldVisible: () => true
  }
  const api = runner(env.corrections, env.points, env.faceEntryFeedback, env.faceEntryDraftOf, env.FACE_CONTENT_KEY, env.FACE_STYLE_KEY, env.seal, env.dataVersion, env.form, env.formFaceId, env.formFeedback, env.formOpen, env.correctionFieldVisible)
  await api.submitFaceEntry({ id: 'fc-view-1', sealId: SEAL_A })
  return { feedback: faceEntryFeedback['fc-view-1'], draft, calls }
}

/** 跑一次表单 `submitCorrection`（`filled` ＝ 非空表单项）。 */
async function runForm(script, formInit) {
  let i = 0
  const calls = []
  const fake = {
    MARKABLE_FIELDS: corrections.MARKABLE_FIELDS,
    newBatchId: () => 'qa-batch-view-2',
    submitCorrection: async (args) => {
      calls.push(args)
      const step = script[i]
      if (!step) throw new Error('视图脚本用尽（多调了一次 submitCorrection）')
      i += 1
      return step
    }
  }
  const form = Object.assign({ basis: '' }, formInit)
  const formFeedback = { value: '' }
  const formOpen = { value: true }
  const api = runner(
    fake,
    points,
    {},
    () => ({ content: '', style: '' }),
    FACE_CONTENT_KEY,
    FACE_STYLE_KEY,
    { value: { stamp_id: SEAL_A } },
    { value: 0 },
    form,
    { value: 'fc-view-2' },
    formFeedback,
    formOpen,
    () => true
  )
  await api.submitCorrection()
  return { feedback: formFeedback.value, formOpen: formOpen.value, calls }
}

const expectedPartial = (accepted, skipped) =>
  `已提交 ${accepted} 條勘誤，平臺審覈採納後每條獎勵 ${points.CORRECTION_REWARD} 金。另有 ${skipped} 條已有相同提交（無需重複提交），本次未新增。`

/* C1：`submitFaceEntry` —— 2 项中 1 跳过。 */
{
  const out = await runFaceEntry([okResult(), dupResult()], { content: '內容甲', style: '風格甲' })
  check('C1', 'AC-635① 印面块部分跳过（N=2 / K=1）上屏**逐字**', expectedPartial(1, 1), out.feedback)
  check('C1b', 'AC-635① 跳过条数如实（M ＝ 1，不多报不少报）', true, out.feedback.includes('另有 1 條'))
  check('C1c', 'AC-635 表单收尾：accepted(1) ＋ skipped(1) ＝ 填写项数(2) ⇒ 草稿清空', ['', ''], [out.draft.content, out.draft.style])
}
/* C2：`submitFaceEntry` —— 全部跳过。 */
{
  const out = await runFaceEntry([dupResult(), dupResult()], { content: '內容乙', style: '風格乙' })
  check('C2', 'AC-635② 全部跳过上屏**逐字**（含【採信】去向）', SKIP_ALL_MESSAGE, out.feedback)
  check('C2b', 'AC-635 表单收尾：全部跳过（0＋2 ＝ 2）⇒ 草稿清空', ['', ''], [out.draft.content, out.draft.style])
}
/* C3：`submitFaceEntry` —— 有真实失败（跳过不覆盖失败）。 */
{
  const out = await runFaceEntry([dupResult(), failResult(FAIL_MESSAGE)], { content: '內容丙', style: '風格丙' })
  check('C3', 'AC-634 判负面：真实失败时上屏**失败原文**（跳过不覆盖失败）', FAIL_MESSAGE, out.feedback)
  check('C3b', 'AC-635 表单收尾：存在真实失败（1＋0 ≠ 2）⇒ 草稿**不清空**', ['內容丙', '風格丙'], [out.draft.content, out.draft.style])
}
/* C4：`submitFaceEntry` —— 0 项重复（对照）。 */
{
  const out = await runFaceEntry([okResult(), okResult()], { content: '內容丁', style: '風格丁' })
  const expected = `已提交 2 條勘誤，平臺審覈採納後每條獎勵 ${points.CORRECTION_REWARD} 金。`
  check('C4', 'AC-635③ 0 项重复 ⇒ 只上屏成功句（**不出现跳过提示**）', expected, out.feedback)
  check('C4b', 'AC-635③ 0 项重复 ⇒ 无【採信】引导、无「另有」句', false, out.feedback.includes('另有') || out.feedback.includes('所選項目'))
  check('C4c', 'AC-635 表单收尾：2＋0 ＝ 2 ⇒ 草稿清空', ['', ''], [out.draft.content, out.draft.style])
}

/* C5：表单 `submitCorrection` —— 3 项中 2 跳过（跳过条数如实）。 */
{
  const out = await runForm([okResult(), dupResult(), dupResult()], { seal_name: '印文甲', seal_class: '姓名', transcription: '釋義甲' })
  check('C5', 'AC-635① 表单部分跳过（N=3 / K=2）上屏**逐字**', expectedPartial(1, 2), out.feedback)
  check('C5b', 'AC-635 表单收尾：1＋2 ＝ 3 ⇒ 关闭弹窗', false, out.formOpen)
}
/* C6：表单 —— 全部跳过。 */
{
  const out = await runForm([dupResult(), dupResult()], { seal_name: '印文乙', transcription: '釋義乙' })
  check('C6', 'AC-635② 表单全部跳过上屏**逐字**（含【採信】去向）', SKIP_ALL_MESSAGE, out.feedback)
  check('C6b', 'AC-635 表单收尾：0＋2 ＝ 2 ⇒ 关闭弹窗', false, out.formOpen)
}
/* C7：表单 —— 有真实失败（跳过不覆盖失败）。 */
{
  const out = await runForm([dupResult(), failResult(FAIL_MESSAGE_FORM)], { seal_name: '印文丙', transcription: '釋義丙' })
  check('C7', 'AC-634 判负面：表单真实失败时上屏**失败原文**', FAIL_MESSAGE_FORM, out.feedback)
  check('C7b', 'AC-635 表单收尾：存在真实失败（1＋0 ≠ 2）⇒ 弹窗**不关**', true, out.formOpen)
}
/* C8：表单 —— 0 项重复（对照）。 */
{
  const out = await runForm([okResult(), okResult()], { seal_name: '印文丁', transcription: '釋義丁' })
  const expected = `已提交 2 條勘誤，平臺審覈採納後每條獎勵 ${points.CORRECTION_REWARD} 金。`
  check('C8', 'AC-635③ 表单 0 项重复 ⇒ 只上屏成功句（不出现跳过提示）', expected, out.feedback)
  check('C8b', 'AC-635 表单收尾：2＋0 ＝ 2 ⇒ 关闭弹窗', false, out.formOpen)
}

/* C9：两条跳过文案 —— `s2t(x) === x` 恒等 ＋「失敗 / 错误」族字样命中数 ＝ 0。 */
{
  const partial = expectedPartial(1, 1)
  const skipTexts = [partial, SKIP_ALL_MESSAGE]
  const s2tIdentity = skipTexts.map((text) => trad.toTraditionalText(text) === text)
  check('C9', 'AC-634② 两条跳过文案过 `s2t(x) === x` 恒等（繁體）', [true, true], s2tIdentity)
  check('C9b', 'AC-634② 恒等检测**正向对照**（注入简体字必被 s2t 改写 ⇒ 探针非恒绿）', false, trad.toTraditionalText('错误的误写') === '错误的误写')
  const FAMILY = ['失敗', '失败', '錯誤', '错误']
  const hits = skipTexts.map((text) => FAMILY.reduce((sum, token) => sum + text.split(token).length - 1, 0))
  check('C9c', 'AC-634③ 「失敗 / 错误」族字样在两条跳过文案上命中数 ＝ 0', [0, 0], hits)
  const failedWord = skipTexts.map((text) => text.toLowerCase().split('failed').length - 1)
  check('C9d', 'AC-634③ 「failed」族字样命中数 ＝ 0', [0, 0], failedWord)
}

/* C10：静态锚 —— 两处循环都把 `DUPLICATE_VALUE` 计入 skipped（而非失败）。 */
{
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  const faceBody = strip(FACE_ENTRY_SRC)
  const formBody = strip(FORM_SRC)
  const anchorOf = (body) =>
    /else if \(result\.reason === 'DUPLICATE_VALUE'\) skipped \+= 1/.test(body) &&
    /if \(accepted === 0 && firstError\)/.test(body) &&
    /accepted \+ skipped === /.test(body)
  check('C10', '两处循环均：`DUPLICATE_VALUE` ⇒ skipped＋1 / 失败判定不被跳过覆盖 / 收尾用 accepted＋skipped', [true, true], [anchorOf(faceBody), anchorOf(formBody)])
}

/* ---------------------------------------------------------------------------
   7. D 段：回包信封不变量（改前 `83cceb0^` 实跑对拍）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'D', title: '回包信封：拒绝面恰 3 键 / 其它 op 响应键集与改前逐字相同' }))

/* D1：`submitCorrection` 拒绝面恒为恰 3 键（取 A1 / A3f / B2 三个拒绝样本重跑一遍）。 */
{
  const samples = []
  store.load([
    makeRow({ id: 'c-envelope-1', value: V_PENDING, status: 'PENDING' }),
    makeRow({ id: 'c-envelope-2', value: V_ACCEPTED, status: 'ACCEPTED' })
  ])
  samples.push(await submit({ faceId: FACE_A, sealId: SEAL_A, stampId: SEAL_A, field: FIELD_FREE, value: V_PENDING }))
  samples.push(await submit({ faceId: FACE_A, sealId: SEAL_A, stampId: SEAL_A, field: FIELD_FREE, value: V_ACCEPTED }))
  store.load([])
  samples.push(await submit({ faceId: FACE_A, sealId: SEAL_A, stampId: SEAL_A, field: FIELD_FREE, value: '   ' }))
  check('D1', 'AC-632 拒绝面回包形状恒为恰 3 键 message,ok,reason（三个拒绝样本）', ['message,ok,reason', 'message,ok,reason', 'message,ok,reason'], samples.map(shapeOf))
}

/* D2：改前模块 —— `git show 83cceb0^` 的云函数本体在一次性目录里实跑，对拍其它 op 的键集。 */
const PRECHANGE_KEYS = [
  'artifact',
  'authority',
  'display',
  'docId',
  'identity',
  'identity_source',
  'ok',
  'op',
  'projection',
  'renewedExpiresAt',
  'renewedToken',
  'renewedTtlSeconds',
  'row',
  'serverNow',
  'summary',
  'value',
  'ver'
]
{
  const scratchRoot = path.join(process.env.TMPDIR || path.join(ROOT, '.qa-tmp'), 'qa-correction-duplicate-skip')
  mkdirSync(scratchRoot, { recursive: true })
  const preDir = path.join(scratchRoot, 'pre-fn')
  if (existsSync(preDir)) rmSync(preDir, { recursive: true, force: true })
  cpSync(FUNCTION_DIR, preDir, { recursive: true })
  const preOpsSource = execFileSync('git', ['-C', ROOT, 'show', '83cceb0^:cloudfunctions/xiai-user-token/lib/ops.js'], {
    maxBuffer: 1 << 26
  })
  writeFileSync(path.join(preDir, 'lib/ops.js'), preOpsSource)
  const preFn = require(path.join(preDir, 'index.js'))
  const preOps = require(path.join(preDir, 'lib/ops.js'))

  const seedFor = (target) => {
    target.load([makeRow({ id: 'c-env-1', value: V_PENDING, status: 'PENDING' })])
    target.mapOf('xiai_persons').set('玄同甲', { _id: '玄同甲', id: '玄同甲', code: 'PR000000001', display_name: '印人甲' })
  }
  const runPair = async (module, opsModule) => {
    const local = createStore()
    opsModule.setOpsDbProvider(local.provider)
    seedFor(local)
    const endorse = await module.main({
      action: 'verify',
      token: TOKEN_ME,
      op: 'endorseCorrection',
      payload: { faceId: FACE_A, sealId: SEAL_A, stampId: SEAL_A, field: FIELD_FREE, value: V_PENDING }
    })
    const local2 = createStore()
    opsModule.setOpsDbProvider(local2.provider)
    seedFor(local2)
    const review = await module.main({
      action: 'verify',
      token: TOKEN_ADMIN,
      op: 'reviewCorrection',
      payload: { correction_id: 'c-env-1', decision: 'ACCEPTED' }
    })
    return { endorse, review }
  }

  const before = await runPair(preFn, preOps)
  /* 改后：把 provider 指回**当前**被测件的假 DB（随后无更多云函数用例，恢复仅为自洽）。 */
  ops.setOpsDbProvider(store.provider)
  const after = await runPair(fn, ops)

  check('D2', 'endorseCorrection 响应键集与**改前（83cceb0^ 实跑）**逐字相同', sorted(Object.keys(before.endorse || {})), sorted(Object.keys(after.endorse || {})))
  check('D2b', 'reviewCorrection 响应键集与**改前（83cceb0^ 实跑）**逐字相同', sorted(Object.keys(before.review || {})), sorted(Object.keys(after.review || {})))
  check('D2c', '改前模块跑通（endorse ok:true）—— 保证对拍有效', true, !!(before.endorse && before.endorse.ok === true))
  check('D2d', '改前模块跑通（review ok:true）—— 保证对拍有效', true, !!(before.review && before.review.ok === true))
  check('D3', '其它 op 键集亦 ＝ 冻结字面值（17 键，双锚）', PRECHANGE_KEYS, sorted(Object.keys(after.endorse || {})))
  check('D3b', '其它 op 键集亦 ＝ 冻结字面值（17 键，双锚；review）', PRECHANGE_KEYS, sorted(Object.keys(after.review || {})))
  check('D4', '本单改动**未新增回包键**：改后 endorse / review 键数仍 ＝ 改前', true, sorted(Object.keys(before.endorse || {})).length === sorted(Object.keys(after.endorse || {})).length && sorted(Object.keys(before.review || {})).length === sorted(Object.keys(after.review || {})).length)
}

/* ---------------------------------------------------------------------------
   8. 汇总
   --------------------------------------------------------------------------- */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id),
    db_reads_by_harness: store.stats.reads,
    token: { length: TOKEN_ME.length, fingerprint: createHash('sha256').update(TOKEN_ME).digest('hex').slice(0, 12) }
  })
)
process.exit(failures === 0 ? 0 : 1)
