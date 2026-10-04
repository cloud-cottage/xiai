/**
 * 玺爱 · **采信（採信）自检**（本单新增）
 * ============================================================================
 * **本地、离线、零网络**（注入假 DB ＋ 传输注入把请求交给**真实云函数体**）。
 *
 * 跑什么（逐条对应本单冻结机制）：
 *   A. **契约对齐**：客户端 `services/endorsements.js` 的 op 名 / 采信载荷封闭键面 / schema /
 *      文档键前缀 / 集合名 与云函数 `xiai-user-token/lib/ops.js` 的冻结面**逐字相等**；
 *      并配**负向对照**（服务端收到未登记键 ⇒ `INVALID_FIELD` ＋ 零写入）。
 *   B. **采信端到端（云函数本体 ＋ 假 DB）**：
 *      ① 首次采信**两处落盘**（私有采信行 ＋ 公开计数行 count=1）且公开行**零身份字段**；
 *      ② 重复采信 ⇒ `ALREADY_ENDORSED` ＋ 零写入、count 仍 1；
 *      ③ 自采 ⇒ 拒（`FORBIDDEN`）＋ 零写入；
 *      ④ 第二人同值提交勘误 ⇒ `DUPLICATE_VALUE` ＋ 零写入；
 *      ⑤ 不同值 / 不同字段不受影响（正对照）；
 *      ⑥ 计数幂等与自愈（重放后 count 不变）；
 *      ⑦ 未登录 ⇒ 拒（服务层本地门 ＋ 服务端无令牌面各一条）。
 *   C. **前端渲染逻辑**：纯函数 `endorsementDecision` ＋ 集成读数 `endorsementEntriesOf`：
 *      他人提交出按钮 / 自己的提交不出 / 已 ACCEPTED 不出 / 游客按钮渲染但点击走登录引导。
 *      （用服务层真源执行，**不以「读代码推断」充当证据**。）
 *   D. **机械扫描**：`[data-admin-action]` 去重集合不变（仍 8 值 / 7 类）；上屏文案繁體
 *      （正 / 负对照）；既有 `STORAGE_KEYS` 逐字未动。
 *
 * 纪律：**不打印任何密钥 / 验证码 / 令牌原文**（只给长度与指纹）；不碰任何服务；断言失败 ⇒ 退出码非 0。
 *
 * 用法（密钥 / 验证码可留空 ⇒ 脚本合成一份**一次性**假环境，绝不写进仓）：
 *   node scripts/verify-endorsement.mjs
 *   （可选覆盖：XIAI_USER_SMS_CODE / XIAI_USER_TOKEN_SECRET / XIAI_USER_PHONE）
 */

import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

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

const sorted = (list) => (Array.isArray(list) ? list.slice().sort() : list)
const nowS = () => Math.floor(Date.now() / 1000)
const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
/** 本单新增两个待规范单确认的 reason 字面值 ⇒ 冻结表取并集。 */
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
const IDENTITY_KEYS = ['user_id', 'user_phone', 'userId', 'phone', 'identity_source', 'reviewer_id', 'rewarded_at']

/* ---------------------------------------------------------------------------
   2. 环境（合成一次性假环境；也可由环境变量覆盖；**脚本内零密钥字面值**）
   --------------------------------------------------------------------------- */
const PHONE = String(process.env.XIAI_USER_PHONE || '13800000001').trim()
const OTHER_PHONE = '13800000002'
const THIRD_PHONE = '13800000003'
const SMS_CODE = String(process.env.XIAI_USER_SMS_CODE || randomBytes(4).toString('hex')).trim()
const SECRET = String(process.env.XIAI_USER_TOKEN_SECRET || randomBytes(32).toString('hex')).trim()
process.env.XIAI_USER_SMS_CODE = SMS_CODE
process.env.XIAI_USER_TOKEN_SECRET = SECRET
process.env.XIAI_USER_TOKEN_VERSION = process.env.XIAI_USER_TOKEN_VERSION || '1'
process.env.XIAI_USER_TOKEN_TTL_SECONDS = process.env.XIAI_USER_TOKEN_TTL_SECONDS || '900'
/* **uid 派生单点**：客户端 `src/data/uid.js::uidOf`（`u-` ＋ sha256(手机号) 前 16 位，不可反推手机号）。
   自检用**客户端实现**算，再与服务端 `config.uidOf` 逐字比对 ⇒ 机械证明「两侧同值」。 */
const uidUtil = await import(path.join(ROOT, 'src/data/uid.js'))
const uidOfPhone = (phone) => uidUtil.uidOf(phone)
const UID_ME = uidOfPhone(PHONE)
const UID_OTHER = uidOfPhone(OTHER_PHONE)
const UID_THIRD = uidOfPhone(THIRD_PHONE)

/* ---------------------------------------------------------------------------
   3. 加载被测件（云函数本体 ＋ 令牌库 ＋ 集合面）
   --------------------------------------------------------------------------- */
const FUNCTION_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')
const fn = require(path.join(FUNCTION_DIR, 'index.js'))
const ops = require(path.join(FUNCTION_DIR, 'lib/ops.js'))
const userLib = require(path.join(FUNCTION_DIR, 'lib/token.js'))
const config = require(path.join(FUNCTION_DIR, 'lib/config.js'))

/* 假 DB（内存；`where().get()` / `doc().set()` / `add()`；「零写入」的判据＝写计数）。 */
function createStore(seed) {
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
            }
          }
        },
        doc(id) {
          return {
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

const FACE_ID = 'fc-endorse-test'
const SEAL_ID = 'XA000000001'
const VALUE_OTHER_PENDING = '甲值'
const VALUE_MINE_PENDING = '乙值'
const VALUE_OTHER_ACCEPTED = '丙值'
const VALUE_OTHER_PENDING_ALT = '丁值'

const CLOUD_SEED = [
  {
    __collection: 'xiai_corrections',
    _id: 'c1',
    id: 'c1',
    faceId: FACE_ID,
    sealId: SEAL_ID,
    stamp_id: SEAL_ID,
    user_id: UID_OTHER,
    userId: UID_OTHER,
    field: 'author',
    field_label: '作者',
    value: VALUE_OTHER_PENDING,
    status: 'PENDING'
  },
  {
    __collection: 'xiai_corrections',
    _id: 'c2',
    id: 'c2',
    faceId: FACE_ID,
    sealId: SEAL_ID,
    stamp_id: SEAL_ID,
    user_id: UID_OTHER,
    userId: UID_OTHER,
    field: 'author',
    field_label: '作者',
    value: VALUE_OTHER_PENDING_ALT,
    status: 'PENDING'
  },
  {
    __collection: 'xiai_corrections',
    _id: 'c3',
    id: 'c3',
    faceId: FACE_ID,
    sealId: SEAL_ID,
    stamp_id: SEAL_ID,
    user_id: UID_OTHER,
    userId: UID_OTHER,
    field: 'transcription',
    field_label: '印文釋義',
    value: VALUE_OTHER_PENDING,
    status: 'PENDING'
  }
]
const store = createStore(CLOUD_SEED)
ops.setOpsDbProvider(store.provider)

/* 前端真源（数据层 / 服务层）与接线。 */
const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
const session = await import(path.join(ROOT, 'src/data/session.js'))
const db = await import(path.join(ROOT, 'src/data/db.js'))
const storage = await import(path.join(ROOT, 'src/data/storage.js'))
const cloudbase = await import(path.join(ROOT, 'src/data/cloudbase.js'))
const corrections = await import(path.join(ROOT, 'src/services/corrections.js'))
const endorsements = await import(path.join(ROOT, 'src/services/endorsements.js'))
const userTokenSvc = await import(path.join(ROOT, 'src/services/userToken.js'))

const calls = []
userTokenSvc.setUserTokenTransport(async (name, data) => {
  calls.push({ name, action: data && data.action, op: data && data.op })
  return { result: await fn.main(data) }
})
writeFace.setWriteFaceModeOverride('cloud')
/* 本地库前置：先让 `ensureSeed()` 落一次（写 `seeded` 标记）⇒ 之后手写夹具不会被种子覆盖。 */
db.ensureSeed()

/* 令牌（自签，避免依赖 `issue` 的验证码面；与线上同一份令牌库）。 */
const tokenFor = (phone) =>
  userLib.issueToken({ sub: phone, secret: SECRET, nowSeconds: nowS(), ttlSeconds: 900, version: '1', role: 'user' }).token
const TOKEN_ME = tokenFor(PHONE)
const TOKEN_OTHER = tokenFor(OTHER_PHONE)
const TOKEN_THIRD = tokenFor(THIRD_PHONE)
const endorsePayload = (value, field = 'author') => ({ faceId: FACE_ID, sealId: SEAL_ID, stampId: SEAL_ID, field, value })
const countRowsOf = (name) => [...store.mapOf(name).values()]
const countRowFor = (collection, faceId, field, value) =>
  countRowsOf(collection).find(
    (row) => String(row.faceId) === String(faceId) && String(row.field) === String(field) && String(row.value) === String(value)
  )

/* ---------------------------------------------------------------------------
   4. A 段：契约对齐（客户端封闭面 vs 云函数冻结面）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'A', title: '契约对齐：客户端封闭面 vs 云函数冻结面' }))
check('A1', 'op 名逐字一致且已注册在云函数 OPS 面', true, endorsements.ENDORSE_OP === 'endorseCorrection' && Object.prototype.hasOwnProperty.call(ops.OPS, endorsements.ENDORSE_OP))
check('A2', '采信载荷键面逐字 ＝ ops.ENDORSE_ALLOWED_KEYS', sorted(ops.ENDORSE_ALLOWED_KEYS), sorted(endorsements.ENDORSE_PAYLOAD_KEYS))
check('A2b', '采信载荷键面 ＝ [faceId,sealId,stampId,field,value]', ['faceId', 'field', 'sealId', 'stampId', 'value'], sorted(endorsements.ENDORSE_PAYLOAD_KEYS))
check('A3', '公开计数 schema 逐字相等', ops.ENDORSEMENT_SCHEMA, endorsements.ENDORSEMENT_SCHEMA)
check('A4', '计数行文档键前缀逐字相等', ops.ENDORSEMENT_COUNT_ID_PREFIX, endorsements.ENDORSEMENT_COUNT_ID_PREFIX)
check('A5', '采信行文档键前缀逐字相等', ops.ENDORSEMENT_ID_PREFIX, endorsements.ENDORSEMENT_ID_PREFIX)
check('A6', '计数集合名逐字相等（云函数 ＝ CDN 读面）', ops.COLLECTIONS.endorsementCounts, cloudbase.CLOUD_COLLECTIONS.endorsementCounts)
check('A6b', '计数集合名 ＝ xiai_endorsement_counts', 'xiai_endorsement_counts', cloudbase.CLOUD_COLLECTIONS.endorsementCounts)
check('A7', '采信私有集合名 ＝ 本地镜像键（storage.js 登记）', 'xiai_endorsements', `xiai_${storage.STORAGE_KEYS.endorsements}`)
check('A8', '服务端字段表与前端真源逐字相等（副本不漂移）', corrections.MARKABLE_FIELDS.map((item) => [item.key, item.label]), Object.entries(ops.MARKABLE_FIELDS))
check('A9', '新增 reason 字面值已登记（待规范单确认）', ['ALREADY_ENDORSED', 'DUPLICATE_VALUE'], ['ALREADY_ENDORSED', 'DUPLICATE_VALUE'].filter((r) => Object.values(config.REASONS).indexOf(r) !== -1))
check('A10', '集合白名单全部 ^xiai_ 前缀', true, Object.values(ops.COLLECTIONS).every((name) => /^xiai_/.test(name)))

/* A11／A11b：键面相关性的**负向 / 正向对照**（服务端直调）。 */
store.load(CLOUD_SEED)
{
  const legacyKey = await fn.main({ action: 'verify', token: TOKEN_ME, op: 'endorseCorrection', payload: { id: 'c1', decision: 'ACCEPTED' } })
  check('A11', '**旧 / 未登记键面** `{id:…,decision:…}` ⇒ 服务端 INVALID_FIELD（A2 负向对照）', true, isDenial(legacyKey) && legacyKey.reason === 'INVALID_FIELD')
  check('A11b', '未登记键面被拒 ⇒ 零写入', 0, store.stats.writes.length)
  const identityKey = await fn.main({ action: 'verify', token: TOKEN_ME, op: 'endorseCorrection', payload: { ...endorsePayload(VALUE_OTHER_PENDING), user_id: UID_ME, user_phone: PHONE } })
  check('A11c', '载荷夹带身份类键 ⇒ INVALID_FIELD ＋ 零写入', true, isDenial(identityKey) && identityKey.reason === 'INVALID_FIELD' && store.stats.writes.length === 0)
}

/* ---------------------------------------------------------------------------
   5. B 段：采信端到端（核心）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'B', title: '采信端到端：两处落盘 / 幂等 / 自采 / 防重 / 计数' }))

/* ① 首次采信（我 → 他人的 PENDING 值）：两处落盘 + 公开行零身份字段。 */
store.load(CLOUD_SEED)
const w0 = store.stats.writes.length
const first = await fn.main({ action: 'verify', token: TOKEN_ME, op: 'endorseCorrection', payload: endorsePayload(VALUE_OTHER_PENDING) })
check('B1', '首次采信成功（ok:true / authority SERVER）', true, first.ok === true && first.authority === 'SERVER')
check('B2', '恰落盘 2 处', 2, store.stats.writes.length - w0)
check('B3', '落盘顺序：先采信行（私有）、后公开计数行', ['xiai_endorsements', 'xiai_endorsement_counts'], store.stats.writes.slice(w0).map((w) => w.collection))
check('B3b', '两处皆为确定性 `set`（幂等 upsert）', ['set', 'set'], store.stats.writes.slice(w0).map((w) => w.action))
const endorseRow = countRowFor('xiai_endorsements', FACE_ID, 'author', VALUE_OTHER_PENDING)
check('B4', '采信行身份 ＝ 服务端派生 uid（**非前端自称**）', UID_ME, endorseRow.user_id)
check('B4b', '**采信私有行不落手机号**：**无 `user_phone` 键**（人类口径 ②）', false, Object.prototype.hasOwnProperty.call(endorseRow, 'user_phone'))
check('B4b2', '采信私有行任一字段值不含 11 位手机号（uid 允许）', false, /\b1[3-9]\d{9}\b/.test(JSON.stringify(endorseRow)))
check('B4c', '采信行身份来源标记', 'SERVER_TOKEN', endorseRow.identity_source)
const pubRow = countRowFor('xiai_endorsement_counts', FACE_ID, 'author', VALUE_OTHER_PENDING)
check('B5', '公开计数行 count ＝ 1', 1, pubRow.count)
check('B5b', '公开计数行 schema', 'xiai-endorsement-counts-v1', pubRow.schema)
check('B5c', '公开计数行文档键形态 `e-<faceId>-<field>-<sha256(value)前16>`', `e-${FACE_ID}-author-` + createHash('sha256').update(VALUE_OTHER_PENDING, 'utf8').digest('hex').slice(0, 16), pubRow._id)
check('B5d', '**公开计数行零身份字段**（服务端落盘面）', [], Object.keys(pubRow).filter((key) => IDENTITY_KEYS.includes(key)))
check('B5d2', '**公开计数行零手机号**（含 11 位数字正则；uid 允许）', false, /\b1[3-9]\d{9}\b/.test(JSON.stringify(pubRow)))
check('B5e', '**回包 projection 零身份字段**（服务端下发面）', [], Object.keys(first.projection || {}).filter((key) => IDENTITY_KEYS.includes(key)))
check('B5e2', '**回包 projection 亦零手机号**（含 11 位数字正则）', false, /\b1[3-9]\d{9}\b/.test(JSON.stringify(first.projection || {})))
check('B5f', '回包 row ＝ 服务端权威采信行', true, first.row && first.row._id === endorseRow._id)

/* ② 重复采信（我 → 同键）：ALREADY_ENDORSED ＋ 零写入、count 仍 1。 */
const w1 = store.stats.writes.length
const again = await fn.main({ action: 'verify', token: TOKEN_ME, op: 'endorseCorrection', payload: endorsePayload(VALUE_OTHER_PENDING) })
check('B6', '重复采信 ⇒ ALREADY_ENDORSED（形状恰 3 键）', true, isDenial(again) && again.reason === 'ALREADY_ENDORSED')
check('B6b', '重复采信 ⇒ 零写入', w1, store.stats.writes.length)
check('B6c', '重复采信后 count 仍 1（不涨数）', 1, countRowFor('xiai_endorsement_counts', FACE_ID, 'author', VALUE_OTHER_PENDING).count)

/* ③ 自采（他人 → 我提交的值）：拒 ＋ 零写入。 */
/* 先让「我」提交一个值，再由「我」自己采信它 ⇒ 必被拒。 */
store.load(CLOUD_SEED)
{
  const wSelf = store.stats.writes.length
  const mineSubmit = await fn.main({ action: 'verify', token: TOKEN_ME, op: 'submitCorrection', payload: { faceId: FACE_ID, sealId: SEAL_ID, stampId: SEAL_ID, field: 'author', value: VALUE_MINE_PENDING, basis: '' } })
  check('B7', '前置：我为该印面提交了一个值', true, mineSubmit.ok === true && store.stats.writes.length === wSelf + 1)
  /* **业务行不落手机号**（人类口径 ②）：服务端权威勘误私有行无 `user_phone` 键、零 11 位数字。 */
  const mySubmitRow = [...store.mapOf('xiai_corrections').values()].find((row) => row.value === VALUE_MINE_PENDING) || {}
  check('B7b', '服务端落盘的勘误私有行**无 `user_phone` 键**', false, Object.prototype.hasOwnProperty.call(mySubmitRow, 'user_phone'))
  check('B7c', '该勘误私有行任一字段值不含 11 位手机号（uid 允许）', false, /\b1[3-9]\d{9}\b/.test(JSON.stringify(mySubmitRow)))
  const wSelf2 = store.stats.writes.length
  const selfEndorse = await fn.main({ action: 'verify', token: TOKEN_ME, op: 'endorseCorrection', payload: endorsePayload(VALUE_MINE_PENDING) })
  check('B8', '自采（同值为本人提交）⇒ 拒（FORBIDDEN；待规范单确认的新字面值，暂用 FORBIDDEN）', true, isDenial(selfEndorse) && selfEndorse.reason === 'FORBIDDEN')
  check('B8b', '自采 ⇒ 零写入', wSelf2, store.stats.writes.length)
}

/* ④ 第二人同值提交勘误 ⇒ DUPLICATE_VALUE ＋ 零写入。 */
store.load(CLOUD_SEED)
{
  const wDup = store.stats.writes.length
  /* c1 是「他人（A）」提交的 (FACE_ID, author, 甲值)；这里我（B）重复提交同值 ⇒ 必被拒。 */
  const dup = await fn.main({ action: 'verify', token: TOKEN_ME, op: 'submitCorrection', payload: { faceId: FACE_ID, sealId: SEAL_ID, stampId: SEAL_ID, field: 'author', value: VALUE_OTHER_PENDING, basis: '' } })
  check('B9', '第二人同值提交勘误 ⇒ DUPLICATE_VALUE', true, isDenial(dup) && dup.reason === 'DUPLICATE_VALUE')
  check('B9b', '防重 ⇒ 零写入', wDup, store.stats.writes.length)
}

/* ⑤ 正对照：不同值 / 不同字段不受影响。 */
store.load(CLOUD_SEED)
{
  const wOk = store.stats.writes.length
  const okSubmit = await fn.main({ action: 'verify', token: TOKEN_ME, op: 'submitCorrection', payload: { faceId: FACE_ID, sealId: SEAL_ID, stampId: SEAL_ID, field: 'author', value: '戊值', basis: '' } })
  check('B10', '正对照：**不同值** 提交 ⇒ 放行（恰 1 处写入）', true, okSubmit.ok === true && store.stats.writes.length === wOk + 1)
}
store.load(CLOUD_SEED)
{
  /* 不同值采信 ⇔ 计数各自独立（author/丁值 与 author/甲值 互不影响）。 */
  const e1 = await fn.main({ action: 'verify', token: TOKEN_ME, op: 'endorseCorrection', payload: endorsePayload(VALUE_OTHER_PENDING) })
  const e2 = await fn.main({ action: 'verify', token: TOKEN_ME, op: 'endorseCorrection', payload: endorsePayload(VALUE_OTHER_PENDING_ALT) })
  check('B11', '正对照：**不同值** 均可采信', true, e1.ok === true && e2.ok === true)
  check('B11b', '同字段不同值 ⇒ 计数行各自独立（均 1）', [1, 1], [
    countRowFor('xiai_endorsement_counts', FACE_ID, 'author', VALUE_OTHER_PENDING).count,
    countRowFor('xiai_endorsement_counts', FACE_ID, 'author', VALUE_OTHER_PENDING_ALT).count
  ])
  /* 不同字段：同值在 transcription 上另起一键。 */
  const e3 = await fn.main({ action: 'verify', token: TOKEN_ME, op: 'endorseCorrection', payload: endorsePayload(VALUE_OTHER_PENDING, 'transcription') })
  check('B11c', '正对照：**不同字段** 同值可采信（另起一键）', true, e3.ok === true)
  check('B11d', '不同字段 ⇒ 计数互不影响（author 仍 1，transcription 为 1）', [1, 1], [
    countRowFor('xiai_endorsement_counts', FACE_ID, 'author', VALUE_OTHER_PENDING).count,
    countRowFor('xiai_endorsement_counts', FACE_ID, 'transcription', VALUE_OTHER_PENDING).count
  ])
}

/* ⑥ 计数幂等与自愈：同键重放（不同用户 / 同一用户）后 count 不乱涨。 */
store.load(CLOUD_SEED)
{
  await fn.main({ action: 'verify', token: TOKEN_ME, op: 'endorseCorrection', payload: endorsePayload(VALUE_OTHER_PENDING) })
  const c1 = countRowFor('xiai_endorsement_counts', FACE_ID, 'author', VALUE_OTHER_PENDING).count
  /* 重放同一用户：ALREADY_ENDORSED ⇒ 零写入 ⇒ count 不变。 */
  await fn.main({ action: 'verify', token: TOKEN_ME, op: 'endorseCorrection', payload: endorsePayload(VALUE_OTHER_PENDING) })
  const c2 = countRowFor('xiai_endorsement_counts', FACE_ID, 'author', VALUE_OTHER_PENDING).count
  check('B12', '重放后 count 不变（幂等 / 自愈）', c1, c2)
  /* 第二位不同用户采信同值 ⇒ count 升至 2（证明计数会随真实新增而增长，非恒 1）。
     该用户**不是**该值的提交人（提交人是 UID_OTHER）⇒ 可采信（不能自采）。 */
  await fn.main({ action: 'verify', token: TOKEN_THIRD, op: 'endorseCorrection', payload: endorsePayload(VALUE_OTHER_PENDING) })
  const c3 = countRowFor('xiai_endorsement_counts', FACE_ID, 'author', VALUE_OTHER_PENDING).count
  check('B12b', '正对照：第二位用户采信同值 ⇒ count 升至 2（探针能数出 >1）', 2, c3)
  check('B12c', '第二位用户采信 ⇒ 采信行也恰 2 行', 2, countRowsOf('xiai_endorsements').filter((row) => row.faceId === FACE_ID && row.field === 'author' && row.value === VALUE_OTHER_PENDING).length)
}

/* ⑦ 未登录 ⇒ 拒（服务端无令牌面 ＋ 服务层本地门）。 */
store.load(CLOUD_SEED)
{
  const w7 = store.stats.writes.length
  const noToken = await fn.main({ action: 'verify', token: '', op: 'endorseCorrection', payload: endorsePayload(VALUE_OTHER_PENDING) })
  check('B13', '无令牌 ⇒ FORBIDDEN ＋ 恰 3 键', true, isDenial(noToken) && noToken.reason === 'FORBIDDEN')
  check('B13b', '无令牌 ⇒ 零写入', w7, store.stats.writes.length)
}
{
  session.setUser(null)
  const guest = await endorsements.endorseCorrection({ faceId: FACE_ID, sealId: SEAL_ID, field: 'author', value: VALUE_OTHER_PENDING })
  check('B14', '未登錄 ⇒ 服务层本地门拒（ok:false）', false, guest.ok)
  check('B14b', '未登錄 ⇒ 文案引导登录（繁體）', true, String(guest.message).includes('登錄'))
}

/* ---------------------------------------------------------------------------
   6. C 段：前端渲染逻辑（纯函数 ＋ 集成读数）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'C', title: '前端渲染逻辑：他人出按钮 / 自己不出 / ACCEPTED 不出 / 游客走登录' }))
const VIEWER_ME = { id: UID_ME }

/* C1：纯函数判定（可直接执行 —— 不以「读代码推断」充当证据）。 */
check('C1', '他人 PENDING ＋ 已登錄 ⇒ 出按钮且可点', { button: true, actionable: true, reason: 'OK' }, (({ button, actionable, reason }) => ({ button, actionable, reason }))(endorsements.endorsementDecision({ status: 'PENDING', mine: false }, VIEWER_ME)))
check('C2', '自己的提交 ⇒ 不出按钮（SELF）', { button: false, actionable: false, reason: 'SELF' }, (({ button, actionable, reason }) => ({ button, actionable, reason }))(endorsements.endorsementDecision({ status: 'PENDING', mine: true }, VIEWER_ME)))
check('C3', '已 ACCEPTED ⇒ 不出按钮（ACCEPTED，登记）', { button: false, actionable: false, reason: 'ACCEPTED' }, (({ button, actionable, reason }) => ({ button, actionable, reason }))(endorsements.endorsementDecision({ status: 'ACCEPTED', mine: false }, VIEWER_ME)))
check('C4', '游客（无 viewer）＋ 他人 PENDING ⇒ 按钮渲染但点击走登录引导', { button: true, actionable: false, reason: 'LOGIN_REQUIRED' }, (({ button, actionable, reason }) => ({ button, actionable, reason }))(endorsements.endorsementDecision({ status: 'PENDING', mine: false }, null)))

/* C2：集成读数 —— 真源服务层 `endorsementEntriesOf`（读本机勘误行 ∪ 公开投影行 ＋ 计数行）。 */
const FACE = { id: FACE_ID, sealId: SEAL_ID, stamp_id: SEAL_ID, kind: 'FACE', seal_name: '', dynasty: '', seal_type: '', face_style: '', author: '', transcription: '' }
function resetLocalCorrections() {
  storage.writeKey(storage.STORAGE_KEYS.faces, [FACE])
  storage.writeKey(storage.STORAGE_KEYS.corrections, [
    { id: 'c-other-pending', faceId: FACE_ID, sealId: SEAL_ID, stamp_id: SEAL_ID, user_id: UID_OTHER, field: 'author', value: VALUE_OTHER_PENDING, status: 'PENDING', created_at: '2026-10-01T00:00:00.000Z' },
    { id: 'c-mine-pending', faceId: FACE_ID, sealId: SEAL_ID, stamp_id: SEAL_ID, user_id: UID_ME, field: 'author', value: VALUE_MINE_PENDING, status: 'PENDING', created_at: '2026-10-02T00:00:00.000Z' },
    { id: 'c-other-accepted', faceId: FACE_ID, sealId: SEAL_ID, stamp_id: SEAL_ID, user_id: UID_OTHER, field: 'author', value: VALUE_OTHER_ACCEPTED, status: 'ACCEPTED', created_at: '2026-10-03T00:00:00.000Z' }
  ])
  storage.writeKey(storage.STORAGE_KEYS.correctionsPublic, [])
  storage.writeKey(storage.STORAGE_KEYS.endorsementCounts, [
    { _id: `e-${FACE_ID}-author-x1`, faceId: FACE_ID, sealId: SEAL_ID, stamp_id: SEAL_ID, field: 'author', value: VALUE_OTHER_PENDING, count: 3, updated_at: '2026-10-03T00:00:00.000Z', schema: 'xiai-endorsement-counts-v1' },
    { _id: `e-${FACE_ID}-author-x2`, faceId: FACE_ID, sealId: SEAL_ID, stamp_id: SEAL_ID, field: 'author', value: VALUE_MINE_PENDING, count: 1, updated_at: '2026-10-03T00:00:00.000Z', schema: 'xiai-endorsement-counts-v1' }
  ])
}
resetLocalCorrections()
{
  const entries = endorsements.endorsementEntriesOf(FACE, VIEWER_ME)
  const pick = (value) => entries.find((item) => item.value === value) || {}
  check('C5', '集成：他人 PENDING ⇒ 出按钮（可点）', { button: true, actionable: true, mine: false }, (({ button, actionable, mine }) => ({ button, actionable, mine }))(pick(VALUE_OTHER_PENDING)))
  check('C5b', '集成：**N 人採信** 计数来自公开计数行（3）', 3, pick(VALUE_OTHER_PENDING).count)
  check('C6', '集成：**自己的提交** ⇒ 不出按钮（SELF）', { button: false, reason: 'SELF' }, (({ button, reason }) => ({ button, reason }))(pick(VALUE_MINE_PENDING)))
  check('C7', '集成：**已 ACCEPTED** ⇒ 不出按钮（ACCEPTED，登记）', { button: false, reason: 'ACCEPTED' }, (({ button, reason }) => ({ button, reason }))(pick(VALUE_OTHER_ACCEPTED)))
  const guestEntries = endorsements.endorsementEntriesOf(FACE, null)
  const guest = guestEntries.find((item) => item.value === VALUE_OTHER_PENDING) || {}
  check('C8', '集成：游客 ⇒ 他人 PENDING 条目仍渲染按钮（actionable:false ⇒ 点击走登录引导）', { button: true, actionable: false }, (({ button, actionable }) => ({ button, actionable }))(guest))
}
/* 计数为 0 的键（未有任何采信）⇒ 展示 0 而非冒充有计数。 */
{
  storage.writeKey(storage.STORAGE_KEYS.endorsementCounts, [])
  const entries = endorsements.endorsementEntriesOf(FACE, VIEWER_ME)
  const pick = (value) => entries.find((item) => item.value === value) || {}
  check('C9', '无计数行 ⇒ 「0 人採信」（不冒充有计数）', 0, pick(VALUE_OTHER_PENDING).count)
}

/* ---------------------------------------------------------------------------
   7. D 段：机械扫描
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'D', title: '机械扫描：admin 钩子 / 繁體 / 存储键' }))

/* D1：`[data-admin-action]` 去重集合不变（仍 8 值 / 7 类）。 */
function walkFiles(dir, out = []) {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(vue|js)$/.test(entry.name)) out.push(full)
  })
  return out
}
const ADMIN_ACTION_EXPECTED = [
  'upload-seal',
  'edit-fixed-attributes',
  'replace-face-image',
  'correction-accept',
  'correction-reject',
  'edit-seal-attributes',
  'edit-invite-reward',
  'export-seal-data'
]
{
  const found = new Set()
  walkFiles(path.join(ROOT, 'src')).forEach((file) => {
    const body = readFileSync(file, 'utf8')
    const matches = body.match(/data-admin-action="([^"]+)"/g) || []
    matches.forEach((m) => found.add(m.replace(/^data-admin-action="/, '').replace(/"$/, '')))
  })
  check('D1', '`[data-admin-action]` 去重取值集合逐字 ＝ 规范现值（8 值）', sorted(ADMIN_ACTION_EXPECTED), sorted([...found]))
  /* 归并 7 类：correction-accept / correction-reject 合一。 */
  const classes = [...found].map((v) => (v.startsWith('correction-') ? 'correction-accept|reject' : v))
  check('D1b', '按归并表归并后 ＝ 7 类', 7, new Set(classes).size)
  /* 本单新增的采信钮一律用 `data-action`，**不得**带 `data-admin-action`。 */
  const endorseBlock = readFileSync(path.join(ROOT, 'src/views/SealDetailView.vue'), 'utf8')
  check('D1c', '采信钮用 `data-action="endorse"`（未新增 admin 钩子取值）', true, /data-action="endorse"/.test(endorseBlock))
}

/* D2：上屏文案繁體（正 / 负对照）。 */
/** 去注释（**JS 块 / 行注释** ＋ **HTML 注释**）—— 「不得据源码注释判负」。 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}
const SIMPLIFIED_ONLY = [
  '误', '采', '纳', '录', '赞', '据', '态', '员', '审', '选', '数', '条', '页', '码',
  '账', '帐', '证', '认', '这', '为', '会', '个', '须', '标', '签', '项', '备', '处',
  '确', '历', '验', '权', '传', '镜', '线', '写', '记', '该', '请', '择', '试', '档'
]
const hasSimplified = (text) => SIMPLIFIED_ONLY.some((ch) => String(text).includes(ch))
check('D2p', '繁體判据**正向对照**（含简化字「误」⇒ 必须命中）', true, hasSimplified('錯誤的误写'))
check('D2n', '繁體判据**负向对照**（繁體「誤」⇒ 不命中）', false, hasSimplified('錯誤的誤寫'))
{
  const targets = [
    'src/services/endorsements.js',
    'src/services/corrections.js',
    'cloudfunctions/xiai-user-token/lib/ops.js',
    'cloudfunctions/xiai-user-token/lib/config.js',
    'src/views/SealDetailView.vue'
  ]
  const hits = targets.filter((rel) => hasSimplified(stripComments(readFileSync(path.join(ROOT, rel), 'utf8'))))
  check('D2', '本单新增 / 触及文件（去注释）上屏文案无简化字', [], hits)
}

/* D3：既有 `STORAGE_KEYS` 逐字未动 ＋ 恰新增两个键。 */
{
  const expectedExisting = {
    seals: 'seals',
    faces: 'faces',
    images: 'images',
    users: 'users',
    corrections: 'corrections',
    photos: 'photos',
    points: 'points',
    session: 'session',
    downloaded: 'downloaded',
    seeded: 'seeded',
    theme: 'theme',
    seallists: 'seallists',
    seallistItems: 'seallist-items',
    shares: 'shares',
    invites: 'invites',
    inviteReward: 'invite-reward',
    migrationBackupTrad: 'migration-backup:r57trad',
    migrationBackupPalette: 'migration-backup:r83palette',
    correctionsPublic: 'corrections-public'
  }
  const wrong = Object.entries(expectedExisting).filter(([k, v]) => storage.STORAGE_KEYS[k] !== v)
  check('D3', '既有 19 键逐字未动', [], wrong)
  check('D3b', '恰新增两个键（endorsements / endorsementCounts）', { endorsements: 'endorsements', endorsementCounts: 'endorsement-counts' }, {
    endorsements: storage.STORAGE_KEYS.endorsements,
    endorsementCounts: storage.STORAGE_KEYS.endorsementCounts
  })
  check('D3c', '键总数 ＝ 21（19 ＋ 2）', 21, Object.keys(storage.STORAGE_KEYS).length)
}

/* D4：静态唯一性（云函数持久化路径仍在 ops.js；集合名 ^xiai_）。 */
{
  const files = walkFiles(FUNCTION_DIR)
  const withCollection = files.filter((file) => /collection\s*\(/.test(readFileSync(file, 'utf8'))).map((f) => path.relative(ROOT, f))
  check('D4', '**唯一持久化路径**：`collection(` 只出现在 lib/ops.js', ['cloudfunctions/xiai-user-token/lib/ops.js'], withCollection)
  const literals = files.map((f) => readFileSync(f, 'utf8')).join('\n').match(/'([A-Za-z0-9_]+)'/g) || []
  const suspect = literals
    .map((item) => item.replace(/'/g, ''))
    .filter((name) => /^[a-z][a-z0-9_]*s$/.test(name) && name.indexOf('xiai_') !== 0 && name !== 'dependencies')
    .filter((name) => name.indexOf('_') !== -1 || name.endsWith('users'))
  check('D4b', '无 xiai_ 前缀以外的集合式字面值', [], suspect)
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
