/**
 * 玺爱 · **管理员写面 Phase 2 自检**（勘误审核 `reviewCorrection` 权威落盘两处）
 * ----------------------------------------------------------------------------
 * **本地、离线、零网络**（注入假 DB ＋ 直接调用真实函数体 / 真实私有判据）。
 *
 * 跑什么：
 *   A. **云函数本体**（`cloudfunctions/xiai-admin-token`）：签发 / 校验的全部判定分支
 *      （无令牌 / 签名错 / 过期 / 白名单外 / 版本撤銷 / 未知 op / 未知 action），并断言
 *      **失败形状恒为恰 3 键** `{ok,reason,message}` 且 `reason` ⊆ `lib/config.js` 的冻结表。
 *   B. **`reviewCorrection` 写面**（核心）：服务端验签后**权威落盘两处** —— 私有集合
 *      `xiai_corrections` 的状态 ＋ 新公开只读集合 `xiai_corrections_public` 的**脱敏投影行**；
 *      逐条负向断言「**判定在写之前 ⇒ 拒绝零写入**」（身份夹带 / 未知单号 / 已审 / 值域外 /
 *      错字决定 / 超长理由），以及「**网络 / 内部失败一律 `STORAGE_UNAVAILABLE` ≠ `FORBIDDEN`**」。
 *      另断言 `setInviteReward`（Phase 1）行为**逐字不变**（成功但不落盘）。
 *   C. **静态扫描**：唯一持久化路径（`collection(` / `database(` 只在 `lib/ops.js`）／集合名一律
 *      `^xiai_` ／零密钥 / 手机号 / 验证码字面值 ／**Phase 1 三文件不含任何持久化痕迹**（守住
 *      `verify-writeface-p1.mjs` 的 A15 判据）。
 *   D. **机械对账**（不让服务端副本静默漂移）：字段表 / 三张值域真源 / 三态枚举与前端真源
 *      **逐字相等**；公开投影键面**封闭**且与身份键**交集为空**；`reviewer_id` 派生与用户写面同约定。
 *
 * 纪律：**不打印任何密钥 / 验证码 / 令牌原文**（只给长度与指纹）；不碰任何服务；断言失败 ⇒ 退出码非 0。
 *
 * 用法（手机号 / 验证码 / 密钥只从**环境变量**传入，脚本内零字面值）：
 *   XIAI_ADMIN_PHONE=… XIAI_ADMIN_SMS_CODE=… XIAI_ADMIN_TOKEN_SECRET=… \
 *     node scripts/verify-admin-review-op.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FUNCTION_DIR = path.join(ROOT, 'cloudfunctions/xiai-admin-token')

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

/* ---------------------------------------------------------------------------
   2. 环境（**手机号 / 验证码 / 密钥只从环境变量来；脚本内零字面值**）
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

const NON_WHITELIST_PHONE = '139' + String(0).repeat(8) + '1' // 合成「非白名单」号；不写成 11 位字面值
const FROZEN_REASONS = ['FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE']
const uidOfPhone = (phone) => `u-${String(phone).replace(/[^0-9]/g, '')}`
const nowS = () => Math.floor(Date.now() / 1000)
const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const isDenial = (value) => value && value.ok === false && shapeOf(value) === 'message,ok,reason' && FROZEN_REASONS.indexOf(value.reason) !== -1
const fingerprint = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)

/* ---------------------------------------------------------------------------
   3. 加载被测件
   --------------------------------------------------------------------------- */
const fn = require(path.join(FUNCTION_DIR, 'index.js'))
const ops = require(path.join(FUNCTION_DIR, 'lib/ops.js'))
const adminConfig = require(path.join(FUNCTION_DIR, 'lib/config.js'))
const adminTokenLib = require(path.join(FUNCTION_DIR, 'lib/token.js'))
const userConfig = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/config.js'))

/* 假 DB（内存；可注入失败）——「零写入」的判据就是它的写计数。 */
function createStore(seed) {
  const collections = { xiai_corrections: new Map(), xiai_corrections_public: new Map() }
  const stats = { writes: [], reads: 0, failRead: false, failSet: false, failUpdate: false }
  const load = (rows) => {
    collections.xiai_corrections.clear()
    collections.xiai_corrections_public.clear()
    ;(rows || []).forEach((row) => collections.xiai_corrections.set(row._id, Object.assign({}, row)))
    stats.writes.length = 0
    stats.reads = 0
    stats.failRead = false
    stats.failSet = false
    stats.failUpdate = false
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
              if (stats.failRead) throw new Error('injected-read-failure')
              return { data: hit().map((row) => Object.assign({}, row)) }
            },
            async update(doc) {
              if (stats.failUpdate) {
                stats.failUpdate = false
                throw new Error('injected-update-failure')
              }
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
              if (stats.failRead) throw new Error('injected-read-failure')
              const row = map.get(id)
              return { data: row ? [Object.assign({}, row)] : [] }
            },
            async set(doc) {
              if (stats.failSet) {
                stats.failSet = false
                throw new Error('injected-set-failure')
              }
              map.set(id, Object.assign({}, doc))
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

const SEED = [
  { _id: 'doc-pend', id: 'cr-pend', faceId: 'fc-fx1-FACE', sealId: '1', stamp_id: '1', user_id: uidOfPhone(PHONE), field: 'dynasty', field_label: '朝代', value: '晚清', status: 'PENDING', created_at: '2026-10-01T00:00:00.000Z' },
  { _id: 'doc-name', id: 'cr-name', faceId: 'fc-fx1-FACE', sealId: '1', stamp_id: '1', user_id: uidOfPhone(PHONE), field: 'seal_name', field_label: '印文', value: '黃士陵印', status: 'PENDING' },
  { _id: 'doc-badd', id: 'cr-badd', faceId: 'fc-fx1-FACE', sealId: '1', field: 'dynasty', value: '大唐', status: 'PENDING' },
  { _id: 'doc-badf', id: 'cr-badf', faceId: 'fc-fx1-FACE', sealId: '1', field: 'face_style', value: '不存在風格', status: 'PENDING' },
  { _id: 'doc-done', id: 'cr-done', faceId: 'fc-fx1-FACE', sealId: '1', field: 'author', value: '黃士陵', status: 'ACCEPTED' },
  { _id: 'cr-docid-only', faceId: 'fc-fx1-FACE', sealId: '1', field: 'author', value: '某作者', status: 'PENDING' }
]
const store = createStore(SEED)
ops.setOpsDbProvider(store.provider)

/* ---------------------------------------------------------------------------
   4. A 段：云函数本体（签发 / 校验判定）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'A', title: '云函数 xiai-admin-token 本体：签发 / 校验判定' }))

/* A0 配置缺失 ⇒ STORAGE_UNAVAILABLE（**不得伪装 FORBIDDEN**） */
{
  const saved = process.env.XIAI_ADMIN_TOKEN_SECRET
  delete process.env.XIAI_ADMIN_TOKEN_SECRET
  const missing = await fn.main({ action: 'issue', phone: PHONE, code: CODE })
  process.env.XIAI_ADMIN_TOKEN_SECRET = saved
  check('A0', '环境变量缺失 ⇒ STORAGE_UNAVAILABLE（≠ FORBIDDEN）', 'STORAGE_UNAVAILABLE', missing.reason)
  check('A0b', '环境变量缺失 ⇒ 形状恰 3 键', 'message,ok,reason', shapeOf(missing))
}

/* A1 签发成功（TTL 900） */
const issued = await fn.main({ action: 'issue', phone: PHONE, code: CODE })
check('A1', '签发成功', true, issued.ok === true)
check('A1b', 'TTL ＝ 900 s', 900, issued.expiresAt - issued.issuedAt)
console.log(JSON.stringify({ A1_readout: { token: { length: issued.token.length, fingerprint: fingerprint(issued.token) }, expiresAt: issued.expiresAt } }))

/* A2 验证码错 / 手机号不符 ⇒ FORBIDDEN 且同一条文案（防枚举） */
const badCode = await fn.main({ action: 'issue', phone: PHONE, code: `${CODE}x` })
const badPhone = await fn.main({ action: 'issue', phone: NON_WHITELIST_PHONE, code: CODE })
check('A2', '验证码错 ⇒ FORBIDDEN', 'FORBIDDEN', badCode.reason)
check('A2b', '手机号不符 ⇒ FORBIDDEN', 'FORBIDDEN', badPhone.reason)
check('A2c', '两者**同一条文案**（防枚举）', badCode.message, badPhone.message)

/* A3 五种令牌面拒绝（含与「无令牌」同文案的防探测） */
const tokenOk = issued.token
const noToken = await fn.main({ action: 'verify', token: '', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } })
const tampered = await fn.main({ action: 'verify', token: `${tokenOk.slice(0, -1)}${tokenOk.slice(-1) === 'A' ? 'B' : 'A'}`, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } })
const expired = await fn.main({ action: 'verify', token: adminTokenLib.issueToken({ sub: PHONE, secret: SECRET, nowSeconds: nowS() - 7200, ttlSeconds: 900, version: '1', role: 'admin' }).token, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } })
const foreign = await fn.main({ action: 'verify', token: adminTokenLib.issueToken({ sub: NON_WHITELIST_PHONE, secret: SECRET, nowSeconds: nowS(), ttlSeconds: 900, version: '1', role: 'admin' }).token, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } })
const revoked = await fn.main({ action: 'verify', token: adminTokenLib.issueToken({ sub: PHONE, secret: SECRET, nowSeconds: nowS(), ttlSeconds: 900, version: '999', role: 'admin' }).token, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } })
check('A3', '无令牌 ⇒ FORBIDDEN', 'FORBIDDEN', noToken.reason)
check('A3b', '**签名错与无令牌同文案**（防探测）', noToken.message, tampered.message)
check('A3c', '过期 ⇒ FORBIDDEN', 'FORBIDDEN', expired.reason)
check('A3d', '手机号非白名单（合法签名）⇒ FORBIDDEN', 'FORBIDDEN', foreign.reason)
check('A3e', '版本不符（撤销）⇒ FORBIDDEN', 'FORBIDDEN', revoked.reason)
check('A3f', '五种拒绝形状全部恰 3 键 ＋ reason ∈ 冻结表', true, [noToken, tampered, expired, foreign, revoked].every(isDenial))
check('A3g', '令牌面拒绝 ⇒ 零写入（假 DB 无任何写）', 0, store.stats.writes.length)

/* A4 未知 op / 未知 action / 缺载荷 */
const unknownOp = await fn.main({ action: 'verify', token: tokenOk, op: 'delete-everything', payload: {} })
const unknownAction = await fn.main({ action: 'zzz' })
const nullPayload = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: null })
check('A4', '未知 op ⇒ INVALID_FIELD', 'INVALID_FIELD', unknownOp.reason)
check('A4b', '未知 action ⇒ FORBIDDEN', 'FORBIDDEN', unknownAction.reason)
check('A4c', '载荷非对象 ⇒ MISSING_REQUIRED', 'MISSING_REQUIRED', nullPayload.reason)
check('A4d', '以上拒绝形状全部恰 3 键', true, [unknownOp, unknownAction, nullPayload].every(isDenial))

/* ---------------------------------------------------------------------------
   5. B 段：reviewCorrection 权威落盘（核心）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'B', title: 'reviewCorrection：私有状态 + 公开脱敏投影（两处落盘）' }))

/* B1 采纳成功：私有状态落盘 */
store.load(SEED)
const accepted = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } })
check('B1', '采纳 ⇒ ok:true ＋ authority ＝ SERVER', true, accepted.ok === true && accepted.authority === 'SERVER')
check('B1b', '私有行状态 → ACCEPTED', 'ACCEPTED', store.collections.xiai_corrections.get('doc-pend').status)
check('B1c', '私有行 reviewer_id ＝ 服务端派生 u-<手机号>', uidOfPhone(PHONE), store.collections.xiai_corrections.get('doc-pend').reviewer_id)
check('B1d', '私有行 reviewed_at 为 ISO 时间戳', true, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(store.collections.xiai_corrections.get('doc-pend').reviewed_at)))
check('B1e', '落盘恰 2 次写（公开投影 + 私有状态）', 2, store.stats.writes.length)
check('B1f', '两次写的集合面', ['xiai_corrections_public', 'xiai_corrections'], store.stats.writes.map((w) => w.collection))
check('B1g', '响应身份读数（phone 脱敏）', true, accepted.identity && accepted.identity.uid === uidOfPhone(PHONE) && accepted.identity.phone.indexOf('*') !== -1)

/* B2 公开投影：键面封闭 ＋ 零身份字段 ＋ 确定性 id（幂等） */
const projected = store.collections.xiai_corrections_public.get(`cp-cr-pend`)
check('B2', '公开投影存在且确定性 id ＝ cp-<单号>', true, !!projected)
check('B2b', '公开投影键集恒等注册的封闭字段面', ops.PUBLIC_PROJECTION_KEYS.slice().sort(), Object.keys(projected || {}).slice().sort())
check(
  'B2c',
  '**零身份字段**（键集 ∩ 身份 / 私密键面 ＝ ∅）',
  [],
  Object.keys(projected || {}).filter((key) => ops.IDENTITY_PROJECTION_KEYS.indexOf(key) !== -1)
)
check('B2d', '公开投影无 userId / user_id / user_phone / basis / created_at', [], ['userId', 'user_id', 'user_phone', 'basis', 'created_at'].filter((key) => key in (projected || {})))
check('B2e', '公开投影业务值（correction_id / status / faceId）', ['cr-pend', 'ACCEPTED', 'fc-fx1-FACE'], [projected.correction_id, projected.status, projected.faceId])
check('B2f', '公开投影 schema 版本标记', ops.PUBLIC_SCHEMA, projected.schema)

/* B3 载荷夹带身份类键 ⇒ INVALID_FIELD ＋ 零写入 */
store.load(SEED)
const spoof = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED', reviewer_id: 'u-' + NON_WHITELIST_PHONE, status: 'ACCEPTED', user_id: 'u-' + NON_WHITELIST_PHONE, phone: NON_WHITELIST_PHONE } })
check('B3', '载荷夹带身份类键 ⇒ INVALID_FIELD', 'INVALID_FIELD', spoof.reason)
check('B3b', '身份类键的拒绝文案点明「不採信前端自稱」', true, String(spoof.message).includes('不採信前端自稱'))
check('B3c', '零写入（夹带身份 ⇒ 假 DB 无任何写）', 0, store.stats.writes.length)

/* B4 未知单号 / 已审终态 ⇒ INVALID_VALUE ＋ 零写入 */
store.load(SEED)
const notFound = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'no-such-id', decision: 'ACCEPTED' } })
const already = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-done', decision: 'ACCEPTED' } })
check('B4', '未知单号 ⇒ INVALID_VALUE', 'INVALID_VALUE', notFound.reason)
check('B4b', '已审终态（ACCEPTED 再审）⇒ INVALID_VALUE（终态不回退）', 'INVALID_VALUE', already.reason)
check('B4c', '两条零写入', 0, store.stats.writes.length)

/* B5 缺单号 / 错字决定 / 非文字理由 / 超长理由 ⇒ 结构化拒绝 ＋ 零写入 */
store.load(SEED)
const noId = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { decision: 'ACCEPTED' } })
const typo = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACEPTED' } })
const badNoteType = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'REJECTED', note: 123 } })
const longNote = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'REJECTED', note: 'x'.repeat(ops.MAX_NOTE_LENGTH + 1) } })
check('B5', '缺单号 ⇒ MISSING_REQUIRED', 'MISSING_REQUIRED', noId.reason)
check('B5b', '错字决定（ACEPTED）⇒ INVALID_VALUE（不得静默当驳回）', 'INVALID_VALUE', typo.reason)
check('B5c', '非文字理由 ⇒ INVALID_VALUE', 'INVALID_VALUE', badNoteType.reason)
check('B5d', '超长理由 ⇒ INVALID_VALUE', 'INVALID_VALUE', longNote.reason)
check('B5e', '以上全部零写入', 0, store.stats.writes.length)
check('B5f', '以上拒绝形状全部恰 3 键', true, [noId, typo, badNoteType, longNote].every(isDenial))

/* B6 采纳值域门（R-20 / R-30 / R-31）⇒ INVALID_VALUE ＋ 零写入 */
store.load(SEED)
const badDynasty = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-badd', decision: 'ACCEPTED' } })
const badStyle = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-badf', decision: 'ACCEPTED' } })
check('B6', '采纳值域外（朝代「大唐」）⇒ INVALID_VALUE', 'INVALID_VALUE', badDynasty.reason)
check('B6b', '采纳值域外（印面风格）⇒ INVALID_VALUE', 'INVALID_VALUE', badStyle.reason)
check('B6c', '值域门零写入', 0, store.stats.writes.length)
/* 驳回**不受**值域门约束（旧勘误单遗留值可被驳回） */
const rejectBadValue = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-badd', decision: 'REJECTED' } })
check('B6d', '驳回不受值域门约束（遗留非值域值可驳回）', true, rejectBadValue.ok === true)

/* B7 驳回带理由：仅驳回且非空才落 review_note；采纳 / 空理由不出现该键 */
store.load(SEED)
const rejected = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-name', decision: 'REJECTED', note: '印文不符' } })
check('B7', '驳回 ⇒ 私有状态 REJECTED', 'REJECTED', store.collections.xiai_corrections.get('doc-name').status)
check('B7b', '驳回带理由 ⇒ review_note 落盘', '印文不符', store.collections.xiai_corrections.get('doc-name').review_note)
check('B7c', '驳回 ⇒ 公开投影 status ＝ REJECTED', 'REJECTED', store.collections.xiai_corrections_public.get('cp-cr-name').status)
store.load(SEED)
await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-name', decision: 'ACCEPTED', note: '不应落盘' } })
check('B7d', '采纳（即使带理由）⇒ 私有行**无** review_note 键', false, 'review_note' in store.collections.xiai_corrections.get('doc-name'))
store.load(SEED)
await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-name', decision: 'REJECTED' } })
check('B7e', '空理由驳回 ⇒ 私有行**无** review_note 键', false, 'review_note' in store.collections.xiai_corrections.get('doc-name'))

/* B8 旧字面值 APPROVED 按采纳兼容 */
store.load(SEED)
const approved = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'APPROVED' } })
check('B8', '旧字面值 APPROVED ⇒ 按采纳落盘', 'ACCEPTED', store.collections.xiai_corrections.get('doc-pend').status)
check('B8b', 'APPROVED 兼容 ⇒ ok:true', true, approved.ok === true)

/* B9 按文档 _id 兜底检索（历史行只有 _id 时仍可审） */
store.load(SEED)
const byDocId = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-docid-only', decision: 'ACCEPTED' } })
check('B9', '无业务 id 的历史行按 _id 兜底可审', true, byDocId.ok === true)
check('B9b', '兜底命中后私有行被更新', 'ACCEPTED', store.collections.xiai_corrections.get('cr-docid-only').status)

/* B10 读失败 / 落盘失败 ⇒ STORAGE_UNAVAILABLE（**绝不伪装 FORBIDDEN**）＋ 零写入 */
store.load(SEED)
store.stats.failRead = true
const readFail = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } })
check('B10', '读私有行失败 ⇒ STORAGE_UNAVAILABLE', 'STORAGE_UNAVAILABLE', readFail.reason)
check('B10b', '读失败 ≠ FORBIDDEN ＋ 恰 3 键', true, readFail.reason !== 'FORBIDDEN' && isDenial(readFail))
check('B10c', '读失败 ⇒ 零写入', 0, store.stats.writes.length)
store.load(SEED)
store.stats.failSet = true
const setFail = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } })
check('B10d', '公开投影写失败 ⇒ STORAGE_UNAVAILABLE（≠ FORBIDDEN）', true, setFail.reason === 'STORAGE_UNAVAILABLE' && isDenial(setFail))
check('B10e', '公开投影写失败 ⇒ 私有状态未被写（干净零半成品）', 'PENDING', store.collections.xiai_corrections.get('doc-pend').status)
/* 两处落盘的**部分失败**登记：公开写在前 ⇒ 若随后的私有写失败，公开行已存在、私有仍 PENDING。
   这是**已知行为**（跨集合无事务），自检如实登记 —— 重放同单会以确定性 id 覆盖公开行、再补私有写。 */
store.load(SEED)
store.stats.failUpdate = true
const updateFail = await fn.main({ action: 'verify', token: tokenOk, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } })
check('B10f', '私有写失败（公开已写）⇒ STORAGE_UNAVAILABLE（≠ FORBIDDEN）', true, updateFail.reason === 'STORAGE_UNAVAILABLE')
check('B10g', '部分失败如实登记：公开行已存在、私有仍 PENDING', true, !!store.collections.xiai_corrections_public.get('cp-cr-pend') && store.collections.xiai_corrections.get('doc-pend').status === 'PENDING')

/* B11 setInviteReward（Phase 1）行为逐字不变：成功但**不落盘** */
store.load(SEED)
const legacyOk = await fn.main({ action: 'verify', token: tokenOk, op: 'setInviteReward', payload: { value: 7 } })
const legacyBad = await fn.main({ action: 'verify', token: tokenOk, op: 'setInviteReward', payload: { value: -1 } })
check('B11', 'setInviteReward 成功 ⇒ ok:true ＋ value', true, legacyOk.ok === true && legacyOk.value === 7)
check('B11b', 'setInviteReward **不落盘**（零写入）', 0, store.stats.writes.length)
check('B11c', 'setInviteReward 响应不含 row / projection（Phase 1 字段面不变）', true, !('row' in legacyOk) && !('projection' in legacyOk))
check('B11d', 'setInviteReward 值域门仍生效（-1）⇒ INVALID_VALUE', 'INVALID_VALUE', legacyBad.reason)

/* ---------------------------------------------------------------------------
   6. C 段：静态扫描（唯一持久化路径 / 零字面值 / Phase-1 判据不破）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'C', title: '静态扫描' }))
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}
const functionFiles = walk(FUNCTION_DIR).filter((file) => file.endsWith('.js'))
const rel = (file) => path.relative(ROOT, file)
const sources = new Map(functionFiles.map((file) => [file, readFileSync(file, 'utf8')]))
const hits = (pattern) => functionFiles.filter((file) => pattern.test(sources.get(file))).map(rel)

check('C1', '**唯一持久化路径**：`collection(` 只出现在 lib/ops.js', ['cloudfunctions/xiai-admin-token/lib/ops.js'], hits(/collection\s*\(/))
check('C2', '`database(` 只在 lib/ops.js（取句柄单点）', ['cloudfunctions/xiai-admin-token/lib/ops.js'], hits(/database\s*\(/))
check('C3', "云数据库 SDK 只在 lib/ops.js 延迟 require", ['cloudfunctions/xiai-admin-token/lib/ops.js'], hits(/require\(['"]@cloudbase\/node-sdk['"]\)/))
check('C4', '无 `require(fs)` / `writeFile`（不得旁路落盘 / 读盘）', [], hits(/require\(['"]fs['"]\)|writeFile/))
check('C5', '取句柄的 envId **不写死**（无硬编码环境 id 字面值）', [], hits(/liwu-|env-[0-9a-z]{10,}/i))
{
  /* 守住 verify-writeface-p1.mjs 的 A15：Phase 1 三文件仍不含任何持久化痕迹。 */
  const legacyFiles = ['index.js', 'lib/token.js', 'lib/config.js']
  const forbidden = ['node-sdk', "require('fs')", 'require("fs")', 'writeFile', 'collection(', 'database()', 'insertOne', 'updateOne']
  const legacyHits = []
  legacyFiles.forEach((relativeName) => {
    const source = readFileSync(path.join(FUNCTION_DIR, relativeName), 'utf8')
    forbidden.forEach((token) => {
      if (source.includes(token)) legacyHits.push(`${relativeName}:${token}`)
    })
  })
  check('C6', 'Phase 1 三文件（index/config/token）零持久化痕迹（守卫 A15 判据）', [], legacyHits)
}
{
  const allSource = [...sources.values()].join('\n')
  const elevenDigits = allSource.match(/\b\d{11}\b/g) || []
  check('C7', '函数源码内**零手机号字面值**（无 11 位数字）', [], elevenDigits)
  const hexLike = allSource.match(/\b[0-9a-f]{64}\b/g) || []
  check('C8', '函数源码内**零密钥字面值**（无 64 位十六进制）', [], hexLike)
  const secretAssign = allSource.match(/(SECRET|CODE|SMS_CODE)\s*=\s*'[^']+'/g) || []
  check('C9', '函数源码内零密钥 / 验证码赋值字面值', [], secretAssign)
}
check('C10', '集合名字面值全部 `^xiai_` 前缀', true, Object.values(ops.COLLECTIONS).every((name) => /^xiai_/.test(name)))

/* ---------------------------------------------------------------------------
   7. D 段：机械对账（服务端副本 vs 前端真源；不让副本静默漂移）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'D', title: '机械对账' }))
const correctionsSvc = await import(path.join(ROOT, 'src/services/corrections.js'))
const seed = await import(path.join(ROOT, 'src/data/seed.js'))
{
  const clientMarkable = correctionsSvc.MARKABLE_FIELDS.map((item) => [item.key, item.label])
  const serverMarkable = Object.entries(ops.MARKABLE_FIELDS)
  check('D1', '服务端字段表与前端真源**逐字相等**', clientMarkable, serverMarkable)
}
check('D2', '朝代 14 类与真源逐字相等', seed.DYNASTY_OPTIONS.slice(), ops.DYNASTY_OPTIONS.slice())
check('D2b', '印面内容 9 类与真源逐字相等', seed.FACE_CONTENT_OPTIONS.slice(), ops.FACE_CONTENT_OPTIONS.slice())
check('D2c', '印面风格 23 类与真源逐字相等', seed.FACE_STYLE_OPTIONS.slice(), ops.FACE_STYLE_OPTIONS.slice())
check('D3', '勘误三态与前端真源逐字相等', correctionsSvc.CORRECTION_STATUS, ops.CORRECTION_STATUS)
check('D4', '公开投影键面与身份 / 私密键面**交集为空**', [], ops.PUBLIC_PROJECTION_KEYS.filter((key) => ops.IDENTITY_PROJECTION_KEYS.indexOf(key) !== -1))
check('D5', 'reviewer_id 派生与用户写面同约定（u-<手机号>）', true, adminConfig.uidOf(PHONE) === uidOfPhone(PHONE) && adminConfig.uidOf(PHONE) === userConfig.uidOf(PHONE))
{
  /* reason 字面值判据：配置面 REASONS 值表 ＋ 源码内 `reason:'…'` 直写，全部 ⊆ 冻结表。 */
  const fromTable = Object.values(adminConfig.REASONS)
  const inline = [
    ...new Set(
      functionFiles
        .map((file) => readFileSync(file, 'utf8').match(/reason:\s*'([A-Z_]+)'/g) || [])
        .flat()
        .map((item) => item.replace(/reason:\s*'/, '').replace(/'$/, ''))
    )
  ]
  check('D6', '配置面 REASONS ⊆ 冻结表（新增 reason 字面值 0）', [], fromTable.filter((item) => FROZEN_REASONS.indexOf(item) === -1))
  check('D6b', "源码内直写的 `reason:'…'` ⊆ 冻结表", [], inline.filter((item) => FROZEN_REASONS.indexOf(item) === -1))
}
{
  const allSource = [...sources.values()].join('\n')
  check('D7', '鉴权 / 写面**零域名 / Origin / Referer 字面值**（不与具体域名硬绑定）', false, /https?:\/\/|\bOrigin\b|\bReferer\b/i.test(allSource))
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
    db_writes_by_harness: store.stats.writes.length
  })
)
process.exit(failures === 0 ? 0 : 1)
