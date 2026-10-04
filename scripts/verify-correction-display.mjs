/**
 * 玺爱 · **r2 读面接线自检**（勘误采纳值的展示链：契约对齐 / 公开投影 / 单点显示名）
 * ----------------------------------------------------------------------------
 * **本地、离线、零网络**（注入假 DB ＋ 传输注入把请求交给**真实云函数体**）。
 *
 * 跑什么：
 *   A. **契约对齐（①）**：客户端 `services/corrections.js` 的 op 名 / 采纳载荷键面 /
 *      公开投影键面 / schema / 文档键前缀与云函数 `lib/ops.js` 的**冻结面逐字相等**；
 *      并配**负向对照**（服务端收到旧键面 `{id:…}` ⇒ `INVALID_FIELD` ＋ 零写入）证明
 *      「键名对齐」是**载荷相关**的（不是恒真判断）。
 *   B. **端到端采纳 ＋ 展示链（②）**：`corrections.review()` → `userWriteGate` → **真实云函数体**
 *      → 假 DB（两处落盘：公开脱敏投影 `xiai_corrections_public` ＋ 私有状态）→ 本机镜像 →
 *      `resolveSealDisplayName()`。逐条断言：
 *        · 传输载荷键面**恰＝** `ops.REVIEW_ALLOWED_KEYS`（实测抓到的那一次）；
 *        · 公开投影文档键面**恰＝** `ops.PUBLIC_PROJECTION_KEYS` 且与身份键**交集为空**；
 *        · **只有 ACCEPTED 参与展示**（PENDING 本机行 / REJECTED 公开行都不参与）；
 *        · **行身份去重归一**：同一条勘误同时以「云端投影行（`id='cp-…'` ＋ `correction_id`）」
 *          与「本机镜像行（`correction_id` ＋ `_id='cp-…'`）」存在时**只计一次**
 *          （并配**负向对照**：再加一条**不同**的采纳勘误 ⇒ 计数必须变成 2，证明计数不是恒 1）；
 *        · **跨浏览器一致**：清空本机勘误行后，仅凭**公开投影行**仍能显示采纳值；
 *        · **幂等 upsert**：同一条勘误重复采纳不产生第二行。
 *   C. **写面负向 ＋ 形态**：非管理员 / 传输失败（≠ FORBIDDEN）/ 值域外采纳（服务端拒 ＋ 零写入）
 *      / dev 離線形态（本地权威 ＋ 仍写公开镜像）。
 *   D. **机械扫描**：审阅调用点键面（静态）／**内联点清零**（`seal_name || '佚名'` 在
 *      `src/**` 的**非注释**码面命中 0，配正负对照）／显示名**单点**（定义恰 1 处）。
 *
 * 纪律：不打印任何密钥 / 验证码 / 令牌原文（只给长度与指纹）；不碰任何服务；断言失败 ⇒ 退出码非 0。
 *
 * 用法（手机号 / 验证码 / 密钥只从**环境变量**传入）：
 *   XIAI_ADMIN_PHONE=… XIAI_ADMIN_SMS_CODE=… XIAI_ADMIN_TOKEN_SECRET=… \
 *     node scripts/verify-correction-display.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
/* **R-2 适配**：采纳写面（`reviewCorrection`）已从 `xiai-admin-token` 迁到 `xiai-user-token`
   ⇒ 注入面随之迁移（传输按云函数名路由、user ops 注入同一假 DB、env 设 `XIAI_USER_*`）。 */
const FUNCTION_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

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

/* ---------------------------------------------------------------------------
   2. 环境（手机号 / 验证码 / 密钥只从环境变量来；脚本内零字面值）
   --------------------------------------------------------------------------- */
const PHONE = String(process.env.XIAI_ADMIN_PHONE || '').trim()
const CODE = String(process.env.XIAI_ADMIN_SMS_CODE || '').trim()
const SECRET = String(process.env.XIAI_ADMIN_TOKEN_SECRET || '').trim()
if (PHONE === '' || CODE === '' || SECRET === '') {
  console.log(
    JSON.stringify({
      fatal: 'MISSING_TEST_ENV',
      need: ['XIAI_ADMIN_PHONE', 'XIAI_ADMIN_SMS_CODE', 'XIAI_ADMIN_TOKEN_SECRET'],
      note: '三个值只从环境变量读入；本脚本绝不回显它们的值，也不把它们写进脚本'
    })
  )
  process.exit(2)
}
process.env.XIAI_ADMIN_PHONE = PHONE
process.env.XIAI_ADMIN_SMS_CODE = CODE
process.env.XIAI_ADMIN_TOKEN_SECRET = SECRET
process.env.XIAI_ADMIN_TOKEN_VERSION = process.env.XIAI_ADMIN_TOKEN_VERSION || '1'
process.env.XIAI_ADMIN_TOKEN_TTL_SECONDS = process.env.XIAI_ADMIN_TOKEN_TTL_SECONDS || '900'
/* **R-2 适配**：把同一组值映射到**用户函数**的环境变量名（`XIAI_USER_*` ＋ 白名单 `XIAI_ADMIN_PHONE`）。
   采纳写面已迁到 `xiai-user-token`：服务端验签用户（登录）令牌 ＋「手机号 ∈ `XIAI_ADMIN_PHONE`」。 */
process.env.XIAI_USER_SMS_CODE = CODE
process.env.XIAI_USER_TOKEN_SECRET = SECRET
process.env.XIAI_USER_TOKEN_VERSION = process.env.XIAI_USER_TOKEN_VERSION || '1'
process.env.XIAI_USER_TOKEN_TTL_SECONDS = process.env.XIAI_USER_TOKEN_TTL_SECONDS || '900'

const FROZEN_REASONS = ['FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE']
/* **uid 派生单点**：客户端 `src/data/uid.js::uidOf`（`u-` ＋ sha256(手机号) 前 16 位，不可反推手机号）。
   自检用**客户端实现**算，再与服务端 `config.uidOf` 逐字比对 ⇒ 机械证明「两侧同值」。 */
const uidUtil = await import(path.join(ROOT, 'src/data/uid.js'))
const uidOfPhone = (phone) => uidUtil.uidOf(phone)
const nowS = () => Math.floor(Date.now() / 1000)
const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const isDenial = (value) =>
  value && value.ok === false && shapeOf(value) === 'message,ok,reason' && FROZEN_REASONS.indexOf(value.reason) !== -1
const fingerprint = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
const NON_WHITELIST_PHONE = '139' + String(0).repeat(8) + '1'

/* ---------------------------------------------------------------------------
   3. 加载被测件（云函数本体 ＋ 令牌库 ＋ 集合面）
   --------------------------------------------------------------------------- */
const fn = require(path.join(FUNCTION_DIR, 'index.js'))
const ops = require(path.join(FUNCTION_DIR, 'lib/ops.js'))
/* 用户（登录）令牌库（`xiai-user-token/lib/token.js`；与管理员令牌库逐字节相同）。 */
const userLib = require(path.join(FUNCTION_DIR, 'lib/token.js'))

/* 假 DB（内存；按 `doc(id).set()` 的 CloudBase 语义补 `_id`）——「零写入」的判据就是它的写计数。 */
function createStore(seed) {
  const collections = { xiai_corrections: new Map(), xiai_corrections_public: new Map() }
  const stats = { writes: [], reads: 0 }
  const load = (rows) => {
    collections.xiai_corrections.clear()
    collections.xiai_corrections_public.clear()
    ;(rows || []).forEach((row) => collections.xiai_corrections.set(row._id, Object.assign({}, row)))
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
              /* CloudBase 的 `doc(id).set(doc)` 落盘后文档**必带 `_id = id`** ⇒ 假体如实补上。 */
              map.set(id, Object.assign({ _id: id }, doc))
              stats.writes.push({ collection: name, action: 'set', id })
              return { updated: 1 }
            }
          }
        }
      }
    }
  })
  load(seed)
  return { collections, stats, provider, load }
}

const SEAL_ID = '1'
const FACE_ID = 'fc-fx1-FACE'
const ACCEPTED_NAME = '黃士陵印'
const CLOUD_SEED = [
  {
    _id: 'doc-name',
    id: 'cr-name',
    faceId: FACE_ID,
    sealId: SEAL_ID,
    stamp_id: SEAL_ID,
    user_id: uidOfPhone(PHONE),
    field: 'seal_name',
    field_label: '印文',
    value: ACCEPTED_NAME,
    basis: '印譜對勘',
    status: 'PENDING',
    created_at: '2026-10-01T00:00:00.000Z'
  },
  {
    _id: 'doc-dyn',
    id: 'cr-dyn',
    faceId: FACE_ID,
    sealId: SEAL_ID,
    stamp_id: SEAL_ID,
    user_id: uidOfPhone(PHONE),
    field: 'dynasty',
    field_label: '朝代',
    value: '大唐',
    status: 'PENDING'
  }
]
const store = createStore(CLOUD_SEED)
ops.setOpsDbProvider(store.provider)

/* ---------------------------------------------------------------------------
   4. 加载前端真源（服务层 / 数据层）并接线
   --------------------------------------------------------------------------- */
const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
const session = await import(path.join(ROOT, 'src/data/session.js'))
const db = await import(path.join(ROOT, 'src/data/db.js'))
const storage = await import(path.join(ROOT, 'src/data/storage.js'))
const cloudbase = await import(path.join(ROOT, 'src/data/cloudbase.js'))
const corrections = await import(path.join(ROOT, 'src/services/corrections.js'))
/* **R-2 适配**：客户端采纳写面经用户令牌通道（云函数 `xiai-user-token`），不再是 `adminTokenSvc`。 */
const userTokenSvc = await import(path.join(ROOT, 'src/services/userToken.js'))
const sealsSvc = await import(path.join(ROOT, 'src/services/seals.js'))

/* 本地库前置：先让 `ensureSeed()` 落一次（写 `seeded` 标记）⇒ 之后手写夹具不会被种子覆盖。 */
db.ensureSeed()
const SEAL_ROW = {
  _id: 'xf-1',
  id: SEAL_ID,
  stamp_id: SEAL_ID,
  seal_name: '', // 线上实测：印章 `seal_name=''` ⇒ 未采纳时显示「佚名」
  dynasty: '晚清',
  seal_type: '姓名印',
  face_style: '黃牧甫印風',
  author: '黃士陵',
  transcription: '',
  material: '',
  shape: ''
}
const FACE_ROW = {
  _id: FACE_ID,
  id: FACE_ID,
  sealId: SEAL_ID,
  stamp_id: SEAL_ID,
  kind: 'FACE',
  face_image_id: null,
  seal_name: '',
  dynasty: '晚清',
  seal_type: '姓名印',
  face_style: '黃牧甫印風',
  author: '黃士陵',
  transcription: ''
}
const LOCAL_CORRECTION = {
  id: 'cr-name',
  faceId: FACE_ID,
  sealId: SEAL_ID,
  stamp_id: SEAL_ID,
  user_id: uidOfPhone(PHONE),
  field: 'seal_name',
  field_label: '印文',
  value: ACCEPTED_NAME,
  basis: '印譜對勘',
  status: 'PENDING',
  created_at: '2026-10-01T00:00:00.000Z',
  reviewed_at: null,
  reviewer_id: null,
  rewarded_at: null
}
function resetLocal() {
  storage.writeKey(storage.STORAGE_KEYS.seals, [SEAL_ROW])
  storage.writeKey(storage.STORAGE_KEYS.faces, [FACE_ROW])
  storage.writeKey(storage.STORAGE_KEYS.corrections, [Object.assign({}, LOCAL_CORRECTION)])
  storage.writeKey(storage.STORAGE_KEYS.correctionsPublic, [])
  storage.writeKey(storage.STORAGE_KEYS.points, [])
}
resetLocal()

const ADMIN = { id: uidOfPhone(PHONE), phone: PHONE, role: 'admin', nickname: '管理員' }
const USER = { id: 'u-13800000002', phone: '13800000002', role: 'user', nickname: '印友' }

/** 传输：把请求交给**真实的云函数体**（离线端到端）；记录每次请求的载荷键面。 */
const calls = []
let transportMode = 'fn'
userTokenSvc.setUserTokenTransport(async (name, data) => {
  calls.push({ name, action: data && data.action, token: data && data.token, op: data && data.op, payloadKeys: data && data.payload ? sorted(Object.keys(data.payload)) : null })
  if (transportMode === 'down') throw new Error('network-down')
  return { result: await fn.main(data) }
})

writeFace.setWriteFaceModeOverride('cloud')
session.setUser(ADMIN)
const issued = await userTokenSvc.ensureUserWriteSession(CODE, PHONE)
if (!issued.ok) {
  console.log(JSON.stringify({ fatal: 'TOKEN_ISSUE_FAILED', reason: issued.reason, message: issued.message }))
  process.exit(2)
}

/* ---------------------------------------------------------------------------
   5. A 段：契约对齐（客户端封闭面 vs 云函数冻结面）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'A', title: '契约对齐：客户端封闭面 vs 云函数冻结面' }))
check('A1', 'op 名逐字一致且已注册在云函数 **ADMIN_OPS** 面（V3：迁到用户函数）', true, corrections.REVIEW_OP === 'reviewCorrection' && Object.prototype.hasOwnProperty.call(ops.ADMIN_OPS, corrections.REVIEW_OP))
check('A2', '采纳载荷键面逐字 ＝ ops.**REVIEW_ALLOWED_KEYS**', sorted(ops.REVIEW_ALLOWED_KEYS), sorted(corrections.REVIEW_PAYLOAD_KEYS))
check('A3', '公开投影键面逐字 ＝ ops.PUBLIC_PROJECTION_KEYS', ops.PUBLIC_PROJECTION_KEYS.slice(), corrections.PUBLIC_PROJECTION_KEYS.slice())
check('A4', '公开投影 schema 逐字 ＝ ops.PUBLIC_SCHEMA', ops.PUBLIC_SCHEMA, corrections.PUBLIC_PROJECTION_SCHEMA)
check('A5', '公开投影文档键前缀逐字 ＝ ops.PUBLIC_ID_PREFIX', ops.PUBLIC_ID_PREFIX, corrections.PUBLIC_ID_PREFIX)
check('A6', '公开投影键面与身份 / 私密键面交集为空', [], ops.PUBLIC_PROJECTION_KEYS.filter((key) => ops.IDENTITY_PROJECTION_KEYS.indexOf(key) !== -1))
console.log(JSON.stringify({ A_readout: { REVIEW_ALLOWED_KEYS: ops.REVIEW_ALLOWED_KEYS, PUBLIC_PROJECTION_KEYS: ops.PUBLIC_PROJECTION_KEYS, schema: ops.PUBLIC_SCHEMA, idPrefix: ops.PUBLIC_ID_PREFIX } }))

/* A7／A8：键面相关性的**负向 / 正向对照**（服务端直调，用同环境自签**用户**令牌）。 */
const tokenSnap = userTokenSvc.userTokenSnapshot()
check('A7c', '令牌已进入内存缓存（读数不含令牌原文）', true, tokenSnap.present === true && tokenSnap.tokenLength > 0 && typeof tokenSnap.tokenFingerprint === 'string')
{
  store.load(CLOUD_SEED)
  const direct = userLib.issueToken({ sub: PHONE, secret: SECRET, nowSeconds: nowS(), ttlSeconds: 900, version: '1', role: 'user' })
  /* 负向：客户端**曾用的旧键面** `{id:…}` ⇒ 服务端 INVALID_FIELD ＋ 零写入。 */
  const legacyKey = await fn.main({ action: 'verify', token: direct.token, op: 'reviewCorrection', payload: { id: 'cr-name', decision: 'ACCEPTED' } })
  check('A8', '**旧键面** `{id:…}` ⇒ 服务端 INVALID_FIELD（A2 的负向对照）', true, isDenial(legacyKey) && legacyKey.reason === 'INVALID_FIELD')
  check('A8b', '旧键面被拒 ⇒ 零写入', 0, store.stats.writes.length)
  /* 载荷非对象 ⇒ 键面判定之前的 MISSING_REQUIRED（同一令牌，证明上面不是被令牌面拦下）。 */
  const nullPayload = await fn.main({ action: 'verify', token: direct.token, op: 'reviewCorrection', payload: null })
  check('A7', '载荷非对象 ⇒ MISSING_REQUIRED（形状恰 3 键）', true, isDenial(nullPayload) && nullPayload.reason === 'MISSING_REQUIRED')
  check('A7b', '非法载荷 ⇒ 零写入', 0, store.stats.writes.length)
  /* 正向对照：新键面放行且确有落盘。 */
  const newKey = await fn.main({ action: 'verify', token: direct.token, op: 'reviewCorrection', payload: { correction_id: 'cr-name', decision: 'ACCEPTED' } })
  check('A8c', '**新键面** `{correction_id:…}` ⇒ 服务端放行（正向对照）', true, newKey.ok === true)
  check('A8d', '正向对照确有落盘（恰 2 处：公开投影 ＋ 私有状态）', 2, store.stats.writes.length)
  check('A8e', '落盘顺序：先公开投影、后私有状态', ['xiai_corrections_public', 'xiai_corrections'], store.stats.writes.map((w) => w.collection))
}

/* ---------------------------------------------------------------------------
   6. B 段：端到端采纳 ＋ 展示链（核心）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'B', title: '端到端采纳 → 公开投影 → 单点显示名' }))
store.load(CLOUD_SEED)
resetLocal()
calls.length = 0
userTokenSvc.clearUserToken()
await userTokenSvc.ensureUserWriteSession(CODE, PHONE)

const sealBefore = sealsSvc.getSealById(SEAL_ID)
const faceBefore = sealsSvc.getFaceById(FACE_ID)
check('B0', '夹具可见（服务层视图模型）', true, !!sealBefore && !!faceBefore && faceBefore.kind === 'FACE')
check('B1', '未采纳时显示名 ＝「佚名」（`seal_name` 为空）', '佚名', corrections.resolveSealDisplayName(sealBefore))
{
  const item = corrections.resolveMarkable(faceBefore).find((meta) => meta.key === 'seal_name')
  check('B1b', '待审行**不参与展示**（source ＝ ORIGINAL，display 空）', { source: 'ORIGINAL', display: '', acceptedCount: 0 }, { source: item.source, display: item.display, acceptedCount: item.acceptedCount })
  check('B1c', '待审计数如实（pendingCount ＝ 1）', 1, item.pendingCount)
}

/* B2：采纳（走真实云函数体 ＋ 假 DB） */
const beforeWrites = store.stats.writes.length
const reviewed = await corrections.review(ADMIN, 'cr-name', 'ACCEPTED')
check('B2', '采纳成功（ok:true / accepted:true）', { ok: true, accepted: true, status: 'ACCEPTED' }, { ok: reviewed.ok, accepted: reviewed.accepted, status: reviewed.status })
check('B2b', '**传输载荷键面恰 ＝ ops.REVIEW_ALLOWED_KEYS**（键名对齐的运行时证据）', sorted(ops.REVIEW_ALLOWED_KEYS), calls[calls.length - 1].payloadKeys)
check('B2c', '服务端恰落盘 2 处', 2, store.stats.writes.length - beforeWrites)
const publicWrite = store.stats.writes[beforeWrites]
check('B2d', '第 1 处落盘 ＝ 公开投影 `doc(cp-cr-name).set(…)`', { collection: 'xiai_corrections_public', action: 'set', id: 'cp-cr-name' }, { collection: publicWrite.collection, action: publicWrite.action, id: publicWrite.id })
const publicDoc = store.collections.xiai_corrections_public.get('cp-cr-name')
check('B2e', '公开投影文档键面恰 ＝ PUBLIC_PROJECTION_KEYS（`_id` 为文档键，不在表内）', sorted(ops.PUBLIC_PROJECTION_KEYS), sorted(Object.keys(publicDoc).filter((key) => key !== '_id')))
check('B2f', '公开投影**零身份字段**（与身份面交集为空）', [], Object.keys(publicDoc).filter((key) => ops.IDENTITY_PROJECTION_KEYS.indexOf(key) !== -1))
check('B2g', '公开投影自述 schema / 状态', { schema: ops.PUBLIC_SCHEMA, status: 'ACCEPTED' }, { schema: publicDoc.schema, status: publicDoc.status })

/* B3：本机镜像 ＋ 展示链 */
const mirrorRows = storage.readKey(storage.STORAGE_KEYS.correctionsPublic)
check('B3', '本机公开镜像恰 1 行', 1, Array.isArray(mirrorRows) ? mirrorRows.length : -1)
check('B3b', '镜像文档键 `_id` ＝ `cp-` ＋ 勘误单号（与云端文档键**同值** ⇒ 覆盖层可配对）', 'cp-cr-name', mirrorRows[0]._id)
check('B3c', '镜像键面 ＝ 公开投影键面 ＋ `_id`（**无 `id` 键**）', sorted([...ops.PUBLIC_PROJECTION_KEYS, '_id']), sorted(Object.keys(mirrorRows[0])))
check('B3d', '镜像**零身份字段**', [], Object.keys(mirrorRows[0]).filter((key) => ops.IDENTITY_PROJECTION_KEYS.indexOf(key) !== -1))
check('B3e', '采纳后显示名 ＝ 采纳值（全站单点读法）', ACCEPTED_NAME, corrections.resolveSealDisplayName(sealsSvc.getSealById(SEAL_ID)))
{
  const item = corrections.resolveMarkable(sealsSvc.getFaceById(FACE_ID)).find((meta) => meta.key === 'seal_name')
  check('B3f', '属性表读数与标题**恒等**（同一读法）', { source: 'CORRECTION', display: ACCEPTED_NAME, acceptedCount: 1, pendingCount: 0 }, { source: item.source, display: item.display, acceptedCount: item.acceptedCount, pendingCount: item.pendingCount })
  check('B3g', '标题读数 ＝ 属性表展示值', item.display, corrections.resolveSealDisplayName(sealsSvc.getSealById(SEAL_ID)))
}

/* B4：幂等 upsert（同一条勘误重复采纳 ⇒ 不产生第二行） */
store.load(CLOUD_SEED)
storage.writeKey(storage.STORAGE_KEYS.corrections, [Object.assign({}, LOCAL_CORRECTION)])
const reviewedAgain = await corrections.review(ADMIN, 'cr-name', 'ACCEPTED')
const mirrorRows2 = storage.readKey(storage.STORAGE_KEYS.correctionsPublic)
check('B4', '重放仍成功', true, reviewedAgain.ok === true && reviewedAgain.accepted === true)
check('B4b', '本机公开镜像仍恰 1 行（幂等 upsert，未新增第二行）', 1, Array.isArray(mirrorRows2) ? mirrorRows2.length : -1)

/* B5：跨浏览器一致（清空本机勘误行 ⇒ 仅凭公开投影行仍显示采纳值） */
const cloudPublicRow = cloudbase.normalizePublicCorrectionRow(store.collections.xiai_corrections_public.get('cp-cr-name'))
check('B5a', '云端读面归一后仍认得出勘误单号（`correction_id` 在行内）', 'cr-name', cloudPublicRow.correction_id)
storage.writeKey(storage.STORAGE_KEYS.corrections, [])
storage.writeKey(storage.STORAGE_KEYS.correctionsPublic, [cloudPublicRow])
check('B5', '清空本机勘误行后，仅凭**公开投影行**仍显示采纳值（跨浏览器一致）', ACCEPTED_NAME, corrections.resolveSealDisplayName(sealsSvc.getSealById(SEAL_ID)))
{
  const item = corrections.resolveMarkable(sealsSvc.getFaceById(FACE_ID)).find((meta) => meta.key === 'seal_name')
  check('B5b', '准入判据＝已采纳（source ＝ CORRECTION）', 'CORRECTION', item.source)
}

/* B6：行身份去重归一（本机镜像行 ＋ 云端投影行 ⇒ 只计一次） */
const localMirror = { _id: 'cp-cr-name', correction_id: 'cr-name', faceId: FACE_ID, sealId: SEAL_ID, stamp_id: SEAL_ID, field: 'seal_name', field_label: '印文', value: ACCEPTED_NAME, status: 'ACCEPTED', reviewed_at: '2026-10-02T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z', schema: ops.PUBLIC_SCHEMA }
storage.writeKey(storage.STORAGE_KEYS.correctionsPublic, [cloudPublicRow, localMirror])
{
  const item = corrections.resolveMarkable(sealsSvc.getFaceById(FACE_ID)).find((meta) => meta.key === 'seal_name')
  check('B6', '同一条勘误的「云端投影行 ＋ 本机镜像行」去重后**只计一次**', 1, item.acceptedCount)
}
{
  /* 负向对照：再加一条**不同**的采纳勘误 ⇒ 计数必须变成 2（证明探针能数出 >1，不是恒 1）。 */
  const second = { _id: 'cp-cr-name2', correction_id: 'cr-name2', faceId: FACE_ID, sealId: SEAL_ID, stamp_id: SEAL_ID, field: 'seal_name', field_label: '印文', value: ACCEPTED_NAME, status: 'ACCEPTED', reviewed_at: '2026-10-03T00:00:00.000Z', updated_at: '2026-10-03T00:00:00.000Z', schema: ops.PUBLIC_SCHEMA }
  storage.writeKey(storage.STORAGE_KEYS.correctionsPublic, [cloudPublicRow, localMirror, second])
  const item = corrections.resolveMarkable(sealsSvc.getFaceById(FACE_ID)).find((meta) => meta.key === 'seal_name')
  check('B6b', '负向对照：**不同**勘误另加一条 ⇒ 计数 2（探针能数出 >1）', 2, item.acceptedCount)
}

/* B7：待审 / 驳回一律不参与展示 */
{
  const rejected = { _id: 'cp-cr-rej', correction_id: 'cr-rej', faceId: FACE_ID, sealId: SEAL_ID, stamp_id: SEAL_ID, field: 'seal_name', field_label: '印文', value: '不該出現的值', status: 'REJECTED', reviewed_at: '2026-10-03T00:00:00.000Z', updated_at: '2026-10-03T00:00:00.000Z', schema: ops.PUBLIC_SCHEMA }
  const pendingLocal = Object.assign({}, LOCAL_CORRECTION, { id: 'cr-pending-2', value: '待審不該出現' })
  storage.writeKey(storage.STORAGE_KEYS.corrections, [pendingLocal])
  storage.writeKey(storage.STORAGE_KEYS.correctionsPublic, [cloudPublicRow, localMirror, rejected])
  const item = corrections.resolveMarkable(sealsSvc.getFaceById(FACE_ID)).find((meta) => meta.key === 'seal_name')
  check('B7', '驳回（REJECTED）公开行不参与展示', 1, item.acceptedCount)
  check('B7b', '待审（PENDING）本机行不参与展示（只进 pendingCount）', { display: ACCEPTED_NAME, pending: 1 }, { display: item.display, pending: item.pendingCount })
  check('B7c', '展示值未被待审 / 驳回值污染', ACCEPTED_NAME, corrections.resolveSealDisplayName(sealsSvc.getSealById(SEAL_ID)))
}

/* ---------------------------------------------------------------------------
   7. C 段：写面负向 ＋ 形态
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'C', title: '写面负向 / 形态' }))
/* C1：非管理员 ⇒ FORBIDDEN ＋ 零写入（不进云端门） */
store.load(CLOUD_SEED)
resetLocal()
const callsBeforeC1 = calls.length
const writesBeforeC1 = store.stats.writes.length
const byUser = await corrections.review(USER, 'cr-name', 'ACCEPTED')
check('C1', '非管理员 ⇒ FORBIDDEN', 'FORBIDDEN', byUser.reason)
check('C1b', '非管理员 ⇒ 零往返（等价零写入）', { calls: callsBeforeC1, writes: writesBeforeC1 }, { calls: calls.length, writes: store.stats.writes.length })

/* C2：传输失败 ⇒ STORAGE_UNAVAILABLE（**不得伪装 FORBIDDEN**）＋ 零写入 */
transportMode = 'down'
const netFail = await corrections.review(ADMIN, 'cr-name', 'ACCEPTED')
transportMode = 'fn'
check('C2', '传输失败 ⇒ STORAGE_UNAVAILABLE', 'STORAGE_UNAVAILABLE', netFail.reason)
check('C2b', '传输失败 ≠ FORBIDDEN', true, netFail.reason !== 'FORBIDDEN')
check('C2c', '传输失败 ⇒ 零写入', writesBeforeC1, store.stats.writes.length)

/* C3：值域外采纳 ⇒ 服务端 INVALID_VALUE ＋ 零写入（客户端诚实透传） */
store.load(CLOUD_SEED)
const badDomain = await corrections.review(ADMIN, 'cr-dyn', 'ACCEPTED')
check('C3', '值域外采纳 ⇒ INVALID_VALUE', 'INVALID_VALUE', badDomain.reason)
check('C3b', '值域拒绝 ⇒ 零写入', 0, store.stats.writes.length)

/* C4：dev / 離線形态 ⇒ 本地权威，仍写公开镜像（非正式写入路径） */
writeFace.setWriteFaceModeOverride('local-dev')
store.load(CLOUD_SEED)
resetLocal()
const localCallBefore = calls.length
const devReviewed = await corrections.review(ADMIN, 'cr-name', 'ACCEPTED')
check('C4', 'dev / 離線形態仍可采纳（本地权威）', true, devReviewed.ok === true && devReviewed.accepted === true)
check('C4b', 'dev / 離線形態：**无云端往返**', localCallBefore, calls.length)
check('C4c', 'dev / 離線形態：仍写公开投影本机镜像', ACCEPTED_NAME, corrections.resolveSealDisplayName(sealsSvc.getSealById(SEAL_ID)))
writeFace.setWriteFaceModeOverride('cloud')

/* ---------------------------------------------------------------------------
   8. D 段：机械扫描
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'D', title: '机械扫描：调用点键面 / 内联点清零 / 单点' }))
const correctionsSrc = readFileSync(path.join(ROOT, 'src/services/corrections.js'), 'utf8')
check('D1', '審覈调用点用 `correction_id:`（静态）', true, /correction_id:\s*String\(correctionId/.test(correctionsSrc))
check('D1b', '審覈调用点**不再**用 `id:` 作单号键（静态；V3 后写面门为 `userWriteGate`）', false, /userWriteGate\(REVIEW_OP,\s*\{\s*id:/.test(correctionsSrc))

/** 去注释（块注释 ＋ 行注释）后计数——「不得据源码注释判负」。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}
function walkFiles(dir, out = []) {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(vue|js)$/.test(entry.name)) out.push(full)
  })
  return out
}
const INLINE_PATTERN = /seal_name\s*\|\|\s*'佚名'/
check('D2p', '内联判据**正向对照**（已知含该形态的样本必须命中 1）', 1, (stripComments("const x = seal.seal_name || '佚名'").match(INLINE_PATTERN) || []).length)
check('D2n', '内联判据**负向对照**（已改用单点的形态必须命中 0）', 0, (stripComments("const x = rawName || '佚名'").match(INLINE_PATTERN) || []).length)
{
  const hits = []
  walkFiles(path.join(ROOT, 'src')).forEach((file) => {
    const body = stripComments(readFileSync(file, 'utf8'))
    if (INLINE_PATTERN.test(body)) hits.push(path.relative(ROOT, file))
  })
  check('D2', '`src/**` 码面（去注释）内联「seal_name || 佚名」形态命中 **0**', [], hits)
}
{
  const dbSrc = readFileSync(path.join(ROOT, 'src/data/db.js'), 'utf8')
  const svcSrc = correctionsSrc
  check('D3', '显示名链**数据层单点**恰 1 处（`db.js::sealDisplayName`）', 1, (dbSrc.match(/export function sealDisplayName\(/g) || []).length)
  check('D3b', '显示名链**服务层单点**恰 1 处（`corrections.js::resolveSealDisplayName`）', 1, (svcSrc.match(/export function resolveSealDisplayName\(/g) || []).length)
}

/* ---------------------------------------------------------------------------
   9. 汇总
   --------------------------------------------------------------------------- */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id),
    db_reads_by_harness: store.stats.reads,
    db_writes_by_harness: store.stats.writes.length,
    token: { length_fingerprint: fingerprint('present') }
  })
)
process.exit(failures === 0 ? 0 : 1)
