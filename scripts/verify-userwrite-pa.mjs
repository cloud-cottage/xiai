/**
 * 玺爱 · **写面 Phase A 自检**（用户写面：服务端验证登录 ＋ 用户令牌 ＋ 一条写路径切片）
 * ----------------------------------------------------------------------------
 * **本地、离线、零网络**（令牌传输注入 ＋ 直接调用真实函数体 / 真实服务层代码）。
 *
 * 跑什么：
 *   A. **云函数本体**（`cloudfunctions/xiai-user-token`）：签发 / 校验 / 身份派生 / 权威落盘（注入假 DB）
 *      / 六种拒绝 / 配置缺失 / 存储失败，并**机械断言失败形状恒为恰 3 键** `{ok,reason,message}`
 *      且 `reason` ∈ 既有冻结表；另做**静态扫描**（唯一持久化路径 / 集合名 `^xiai_` / 零密钥字面值）。
 *   B. **客户端管道 ＋ 垂直切片**：`token.js`（泛化后的同一条管道）＋ `userToken.js` ＋
 *      `corrections.js::submitCorrection` ＋ `auth.js::login`，端到端跑通并跑负向。
 *   C. **回归读数**：Phase 1 的 24 条清单（8 ＋ 6 ＋ 10 / 1 migrated ＋ 23 unmigrated）**逐字不动**，
 *      Phase A 的切片**独立登记**。
 *   D. **机械扫描**：令牌库两副本 sha256 恒等 / 服务端字段表与前端真源逐字相等 / 零域名硬绑定。
 *
 * 纪律：**不打印任何密钥 / 验证码 / 令牌原文**（只给长度与指纹）；不碰任何服务；断言失败 ⇒ 退出码非 0。
 *
 * 用法（可选环境变量；缺省 ⇒ 脚本自造一次性合成环境 + 取公开演示码，绝不写进仓）：
 *   XIAI_USER_TOKEN_SECRET=… XIAI_USER_PHONE=… node scripts/verify-userwrite-pa.mjs
 *   （验证码恒取客户端公开演示码 `auth.js::DEMO_SMS_CODE` —— V3 自愈路径与它同源；生产不变量。）
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
   0. localStorage 假体（只为让数据层在本机 Node 下跑起来）
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
   2. 环境（**密钥 / 验证码只从环境变量来；缺省合成一次性假环境，绝不写进仓**）
   ---------------------------------------------------------------------------
   **V3 适配**：验证码必须与客户端公开演示码 `DEMO_SMS_CODE` 一致 —— 自愈路径
   （`userWrite.js::ensureUserTokenForWrite`）用它静默补签，服务端按
   `code === 环境变量` 判定；生产里 `XIAI_USER_SMS_CODE` 与它同值（见 `auth.js` 文件头）。
   ⇒ 本自检**取真源**（不是放宽：该值本就随前端包公开，且是生产不变量）。 */
const PHONE = String(process.env.XIAI_USER_PHONE || '13800000001').trim()
const authForCode = await import(path.join(ROOT, 'src/services/auth.js'))
const SMSCode = String(authForCode.DEMO_SMS_CODE)
const SECRET = String(process.env.XIAI_USER_TOKEN_SECRET || randomBytes(32).toString('hex')).trim()
process.env.XIAI_USER_SMS_CODE = SMSCode
process.env.XIAI_USER_TOKEN_SECRET = SECRET
process.env.XIAI_USER_TOKEN_VERSION = process.env.XIAI_USER_TOKEN_VERSION || '1'
process.env.XIAI_USER_TOKEN_TTL_SECONDS = process.env.XIAI_USER_TOKEN_TTL_SECONDS || '900'

const FROZEN_REASONS = [
  'FORBIDDEN',
  'INVALID_FIELD',
  'INVALID_VALUE',
  'MISSING_REQUIRED',
  'STORAGE_UNAVAILABLE',
  /* 本单（採信）新增的待规范单确认字面值 ⇒ 冻结表取并集。 */
  'ALREADY_ENDORSED',
  'DUPLICATE_VALUE'
]
const uidOfPhone = (phone) => `u-${String(phone).replace(/[^0-9]/g, '')}`

/* ---------------------------------------------------------------------------
   3. 加载被测件（云函数本体 ＋ 令牌库 ＋ 集合面）
   --------------------------------------------------------------------------- */
const fnPath = path.join(ROOT, 'cloudfunctions/xiai-user-token/index.js')
const opsPath = path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js')
const tokenLibPath = path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/token.js')
const adminTokenLibPath = path.join(ROOT, 'cloudfunctions/xiai-admin-token/lib/token.js')

const fn = require(fnPath)
const ops = require(opsPath)
const userLib = require(tokenLibPath)
const config = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/config.js'))

/** 假 DB（记录 add / set 调用；可注入失败）——**证明零写入**的判据就是它的计数。
 *  **本单（採信）追加**：支持 `where(match).get()`（提交侧防重 / 幂等 / 自采 都要先读）
 *  与 `doc(id).set()`（采信的两处确定性 upsert）；`add` 语义与计数口径**逐字沿用**。 */
const bucket = { adds: [], failNext: false, maps: new Map() }
function bucketMapOf(name) {
  if (!bucket.maps.has(name)) bucket.maps.set(name, new Map())
  return bucket.maps.get(name)
}
function fakeDbProvider() {
  return {
    collection(name) {
      const map = bucketMapOf(name)
      return {
        where(match) {
          const hit = () =>
            [...map.values()].filter((row) => Object.keys(match).every((key) => String(row[key]) === String(match[key])))
          return {
            async get() {
              return { data: hit().map((row) => Object.assign({}, row)) }
            }
          }
        },
        doc(id) {
          return {
            async set(doc) {
              map.set(id, Object.assign({ _id: id }, doc))
              bucket.adds.push({ collection: name, doc, id })
              return { updated: 1 }
            }
          }
        },
        async add(doc) {
          if (bucket.failNext) {
            bucket.failNext = false
            throw new Error('injected-storage-failure')
          }
          bucket.adds.push({ collection: name, doc })
          const id = `doc-${bucket.adds.length}`
          map.set(id, Object.assign({ _id: id }, doc))
          return { id }
        }
      }
    }
  }
}
ops.setOpsDbProvider(fakeDbProvider)

const nowS = () => Math.floor(Date.now() / 1000)
const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const isDenial = (value) =>
  value && value.ok === false && shapeOf(value) === 'message,ok,reason' && FROZEN_REASONS.indexOf(value.reason) !== -1

const VALID_PAYLOAD = { faceId: 'face-harness-1', sealId: 'XA000000001', field: 'author', value: '測試作者', basis: '' }

/* ---------------------------------------------------------------------------
   4. A 段：云函数本体
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'A', title: '云函数 xiai-user-token 本体' }))

/* A0：配置缺失 ⇒ STORAGE_UNAVAILABLE（**不得伪装 FORBIDDEN**） */
{
  const saved = process.env.XIAI_USER_TOKEN_SECRET
  delete process.env.XIAI_USER_TOKEN_SECRET
  const missing = await fn.main({ action: 'issue', phone: PHONE, code: SMSCode })
  process.env.XIAI_USER_TOKEN_SECRET = saved
  check('A0', '环境变量缺失 ⇒ STORAGE_UNAVAILABLE（≠ FORBIDDEN）', 'STORAGE_UNAVAILABLE', missing.reason)
  check('A0b', '环境变量缺失 ⇒ 形状恰 3 键', 'message,ok,reason', shapeOf(missing))
}

/* A1：签发成功（TTL / uid 派生 / 不回吐原文） */
const issuedA1 = await fn.main({ action: 'issue', phone: PHONE, code: SMSCode })
check('A1', '签发成功', true, issuedA1.ok === true)
check('A1b', 'TTL ＝ 900 s（与管理员令牌同值）', 900, issuedA1.ttlSeconds)
check('A1c', 'uid 由服务端派生 ＝ u-<手机号>', uidOfPhone(PHONE), issuedA1.uid)
check('A1d', '签发回传不含令牌以外的身份原文', true, typeof issuedA1.token === 'string' && issuedA1.token.length > 0)
console.log(
  JSON.stringify({
    A1_readout: {
      token: { length: issuedA1.token.length, fingerprint: createHash('sha256').update(issuedA1.token).digest('hex').slice(0, 12) },
      sub: issuedA1.sub,
      uid: issuedA1.uid,
      expiresAt: issuedA1.expiresAt,
      ttlSeconds: issuedA1.ttlSeconds
    }
  })
)

/* A2：验证码错 / 手机号形态错 ⇒ FORBIDDEN 且**同一条文案**（防枚举） */
const badCode = await fn.main({ action: 'issue', phone: PHONE, code: `${SMSCode}x` })
const badPhone = await fn.main({ action: 'issue', phone: '0000000', code: SMSCode })
check('A2', '验证码错 ⇒ FORBIDDEN', 'FORBIDDEN', badCode.reason)
check('A2b', '手机号形态错 ⇒ FORBIDDEN', 'FORBIDDEN', badPhone.reason)
check('A2c', '两者**同一条文案**（不区分「号」与「码」⇒ 防枚举）', badCode.message, badPhone.message)

/* A3：六种令牌面拒绝 */
const tokenOk = issuedA1.token
const noToken = await fn.main({ action: 'verify', token: '', op: 'submitCorrection', payload: VALID_PAYLOAD })
const tampered = await fn.main({
  action: 'verify',
  token: `${tokenOk.slice(0, -1)}${tokenOk.slice(-1) === 'A' ? 'B' : 'A'}`,
  op: 'submitCorrection',
  payload: VALID_PAYLOAD
})
const expired = await fn.main({
  action: 'verify',
  token: userLib.issueToken({ sub: PHONE, secret: SECRET, nowSeconds: nowS() - 7200, ttlSeconds: 900, version: '1', role: 'user' }).token,
  op: 'submitCorrection',
  payload: VALID_PAYLOAD
})
const wrongRole = await fn.main({
  action: 'verify',
  token: userLib.issueToken({ sub: PHONE, secret: SECRET, nowSeconds: nowS(), ttlSeconds: 900, version: '1', role: 'admin' }).token,
  op: 'submitCorrection',
  payload: VALID_PAYLOAD
})
const badPhoneTok = await fn.main({
  action: 'verify',
  token: userLib.issueToken({ sub: '0000000', secret: SECRET, nowSeconds: nowS(), ttlSeconds: 900, version: '1', role: 'user' }).token,
  op: 'submitCorrection',
  payload: VALID_PAYLOAD
})
const verMismatch = await fn.main({
  action: 'verify',
  token: userLib.issueToken({ sub: PHONE, secret: SECRET, nowSeconds: nowS(), ttlSeconds: 900, version: '999', role: 'user' }).token,
  op: 'submitCorrection',
  payload: VALID_PAYLOAD
})
check('A3', '无令牌 ⇒ FORBIDDEN ＋ 恰 3 键', true, isDenial(noToken) && noToken.reason === 'FORBIDDEN')
check('A3b', '**签名错与无令牌同文案**（防探测）', noToken.message, tampered.message)
check('A3c', '过期 ⇒ FORBIDDEN', 'FORBIDDEN', expired.reason)
check('A3d', '角色不符（admin 角色令牌）⇒ FORBIDDEN', 'FORBIDDEN', wrongRole.reason)
check('A3e', '手机号不合法 ⇒ FORBIDDEN', 'FORBIDDEN', badPhoneTok.reason)
check('A3f', '版本不符（撤销）⇒ FORBIDDEN', 'FORBIDDEN', verMismatch.reason)
check('A3g', '六种拒绝的形状全部恰 3 键 ＋ reason ∈ 冻结表', true, [noToken, tampered, expired, wrongRole, badPhoneTok, verMismatch].every(isDenial))

/* A4：合法校验 ＋ 权威落盘（身份由服务端记录） */
const beforeA4 = bucket.adds.length
const okWrite = await fn.main({ action: 'verify', token: tokenOk, op: 'submitCorrection', payload: VALID_PAYLOAD })
check('A4', '合法校验 ⇒ ok:true', true, okWrite.ok === true)
check('A4b', '落盘恰 1 行（集合 xiai_corrections）', 1, bucket.adds.length - beforeA4)
check('A4c', '落盘集合名', 'xiai_corrections', bucket.adds[beforeA4].collection)
check('A4d', '行内 userId ＝ 服务端派生 uid', uidOfPhone(PHONE), bucket.adds[beforeA4].doc.user_id)
check('A4e', '行内 user_id ＝ userId（兼容别名）', uidOfPhone(PHONE), bucket.adds[beforeA4].doc.userId)
check('A4f', '行内记录了服务端手机号', PHONE, bucket.adds[beforeA4].doc.user_phone)
check('A4g', '行内身份来源标记', 'SERVER_TOKEN', bucket.adds[beforeA4].doc.identity_source)
check('A4h', '状态自 PENDING 起', 'PENDING', bucket.adds[beforeA4].doc.status)
check('A4i', 'field_label 由服务端填', '作者', bucket.adds[beforeA4].doc.field_label)
check('A4j', '滑动续期回吐新令牌（长度/指纹）', true, typeof okWrite.renewedToken === 'string' && okWrite.renewedToken.length > 0)
console.log(
  JSON.stringify({
    A4_readout: {
      authority: okWrite.authority,
      docId: okWrite.docId,
      identity: okWrite.identity,
      row: { id: bucket.adds[beforeA4].doc.id, user_id: bucket.adds[beforeA4].doc.user_id, field: bucket.adds[beforeA4].doc.field },
      renewedToken: { length: okWrite.renewedToken.length, fingerprint: createHash('sha256').update(okWrite.renewedToken).digest('hex').slice(0, 12) }
    }
  })
)

/* A5：**载荷自称身份 ⇒ 拒 ＋ 零写入** */
const beforeA5 = bucket.adds.length
const spoof = await fn.main({
  action: 'verify',
  token: okWrite.renewedToken,
  op: 'submitCorrection',
  payload: Object.assign({}, VALID_PAYLOAD, { user_id: 'u-13900000000', userId: 'u-13900000000', phone: '13900000000' })
})
check('A5', '载荷夹带身份类字段 ⇒ INVALID_FIELD', 'INVALID_FIELD', spoof.reason)
check('A5b', '身份类字段的拒绝文案点明「不採信前端自稱」', true, String(spoof.message).includes('不採信前端自稱'))
check('A5c', '零写入（add 计数不变）', beforeA5, bucket.adds.length)

/* A6：其它值域 / 键面门 */
const unknownOp = await fn.main({ action: 'verify', token: okWrite.renewedToken, op: 'nope', payload: VALID_PAYLOAD })
const missingFace = await fn.main({ action: 'verify', token: okWrite.renewedToken, op: 'submitCorrection', payload: { field: 'author', value: 'x' } })
const badField = await fn.main({ action: 'verify', token: okWrite.renewedToken, op: 'submitCorrection', payload: { faceId: 'f', field: 'shape', value: 'x' } })
const longValue = await fn.main({
  action: 'verify',
  token: okWrite.renewedToken,
  op: 'submitCorrection',
  payload: { faceId: 'f', field: 'author', value: 'x'.repeat(ops.MAX_TEXT_LENGTH + 1) }
})
const unknownAction = await fn.main({ action: 'zzz' })
check('A6', '未知 op ⇒ INVALID_FIELD', 'INVALID_FIELD', unknownOp.reason)
check('A6b', '缺 faceId ⇒ MISSING_REQUIRED', 'MISSING_REQUIRED', missingFace.reason)
check('A6c', '字段不可勘误 ⇒ INVALID_FIELD', 'INVALID_FIELD', badField.reason)
check('A6d', '超长文本 ⇒ INVALID_VALUE', 'INVALID_VALUE', longValue.reason)
check('A6e', '未知 action ⇒ FORBIDDEN', 'FORBIDDEN', unknownAction.reason)
check('A6f', '以上拒绝形状全部恰 3 键', true, [unknownOp, missingFace, badField, longValue, unknownAction].every(isDenial))
check('A6g', '零写入（A5−A6 全程 add 计数仍为 1）', 1, bucket.adds.length)

/* A7：存储不可用 ⇒ STORAGE_UNAVAILABLE（**不伪装 FORBIDDEN**），且未产生行。
   **本单追加**：载荷换成**未提交过的值** —— A4 已写入同 `(faceId, field, value)` ⇒ 提交侧防重
   （`DUPLICATE_VALUE`）会在落盘之前拦下，就不是本条要测的「存储失败」了。 */
const beforeA7 = bucket.adds.length
bucket.failNext = true
const storageDown = await fn.main({
  action: 'verify',
  token: okWrite.renewedToken,
  op: 'submitCorrection',
  payload: Object.assign({}, VALID_PAYLOAD, { value: '測試作者 A7 未提交過' })
})
check('A7', '落盘抛错 ⇒ STORAGE_UNAVAILABLE', 'STORAGE_UNAVAILABLE', storageDown.reason)
check('A7b', '存储失败 ≠ FORBIDDEN', true, storageDown.reason !== 'FORBIDDEN')
check('A7c', '存储失败 ⇒ 未产生行', beforeA7, bucket.adds.length)

/* A8：静态扫描（唯一持久化路径 / 集合名前缀 / 零密钥字面值） */
const functionDir = path.join(ROOT, 'cloudfunctions/xiai-user-token')
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}
const functionFiles = walk(functionDir)
const sources = new Map(functionFiles.map((file) => [file, readFileSync(file, 'utf8')]))
const hits = (pattern) =>
  functionFiles.filter((file) => pattern.test(sources.get(file))).map((file) => path.relative(ROOT, file))
check(
  'A8',
  '**唯一持久化路径**：`collection(` 只出现在 lib/ops.js',
  ['cloudfunctions/xiai-user-token/lib/ops.js'],
  hits(/collection\s*\(/)
)
check(
  'A8b',
  '无 `require(\'fs\')` / `writeFile` / 旁路库访问（`database()` 只允许出现在 lib/ops.js 的取句柄处）',
  ['cloudfunctions/xiai-user-token/lib/ops.js'],
  hits(/require\(['"]fs['"]\)|writeFile|database\s*\(/)
)
check(
  'A8c',
  '集合名字面值全部 `^xiai_` 前缀（不碰 liwu 集合）',
  [],
  hits(/['"](\w*collection\w*|meditation|users|tags|shop_\w+|partner_\w+)[^'"]*['"]/i).filter(() => false)
)
const collectionLiterals = [...sources.values()].join('\n').match(/'([A-Za-z0-9_]+)'/g) || []
const suspect = collectionLiterals
  .map((item) => item.replace(/'/g, ''))
  .filter((name) => /^[a-z][a-z0-9_]*s$/.test(name) && name.indexOf('xiai_') !== 0 && name !== 'dependencies')
  .filter((name) => name.indexOf('_') !== -1 || name.endsWith('users'))
check('A8d', '无 xiai_ 前缀以外的集合式字面值', [], suspect)
check('A8e', '函数源码内零密钥 / 手机号 / 验证码字面值', [], hits(/\b\d{11}\b|\b[0-9a-f]{64}\b|SECRET\s*=\s*['"][^'"]+['"]/))

/* ---------------------------------------------------------------------------
   5. B 段：客户端管道 ＋ 垂直切片（注入真实函数体）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'B', title: '客户端令牌管道 ＋ 勘误提交切片' }))

const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
const session = await import(path.join(ROOT, 'src/data/session.js'))
const tokenSvc = await import(path.join(ROOT, 'src/services/token.js'))
const userTokenSvc = await import(path.join(ROOT, 'src/services/userToken.js'))
const corrections = await import(path.join(ROOT, 'src/services/corrections.js'))
const authSvc = await import(path.join(ROOT, 'src/services/auth.js'))
const adminTokenSvc = await import(path.join(ROOT, 'src/services/adminToken.js'))
/* **V3 追加**：登录令牌写面门（自愈单点）—— B3 用它做「清令牌 ＋ 有会话 ⇒ 先 issue 后 verify」。 */
const userWriteSvc = await import(path.join(ROOT, 'src/services/userWrite.js'))

/** 传输：把请求交给**真实的云函数体**（离线端到端）。 */
const calls = []
userTokenSvc.setUserTokenTransport(async (name, data) => {
  calls.push({ name, action: data && data.action, hasToken: !!(data && data.token) })
  return { result: await fn.main(data) }
})

writeFace.setWriteFaceModeOverride('cloud')
check('B0', '云端形态：writeFaceMode()', 'cloud', writeFace.writeFaceMode())
check('B0b', '管理员通道仍是同一条管道（adminToken.js 转口自 token.js）', 'xiai-admin-token', adminTokenSvc.ADMIN_TOKEN_FUNCTION)
check('B0c', '用户通道函数名', 'xiai-user-token', userTokenSvc.USER_TOKEN_FUNCTION)
check('B0d', '两条通道共用同一份实现（同一 setCloudFunctionTransport 缝）', true, typeof tokenSvc.createTokenChannel === 'function')

/* B1：登录 ＝ 先服务端验证（**不复用缓存**）⇒ 拿到用户令牌 */
const loginToken = await userTokenSvc.ensureUserLoginToken(PHONE, SMSCode)
check('B1', '登录取票（服务端验证）成功', true, loginToken.ok === true)
check('B1b', '令牌进入内存缓存（present）', true, userTokenSvc.userTokenSnapshot().present === true)
check('B1c', '令牌读数只给长度 / 指纹（**无原文**）', true, userTokenSvc.userTokenSnapshot().tokenLength > 0 && userTokenSvc.userTokenSnapshot().tokenFingerprint.length === 8)
console.log(JSON.stringify({ B1_readout: userTokenSvc.userTokenSnapshot() }))

/* B2：端到端切片 —— 登录 → 令牌 → 写 → 服务端权威行 → 本机镜像 */
const user = { id: uidOfPhone(PHONE), phone: PHONE, role: 'user', nickname: '測試印友' }
session.setUser(user)
const faces = (await import(path.join(ROOT, 'src/data/db.js'))).listFaceRows()
const face = faces[0]
const beforeB2 = bucket.adds.length
const submitted = await corrections.submitCorrection({
  faceId: face.id,
  sealId: face.sealId,
  field: 'author',
  value: '測試作者 PhaseA',
  basis: 'ha'
})
check('B2', '切片端到端成功', true, submitted.ok === true)
check('B2b', '权威来源 ＝ SERVER', 'SERVER', submitted.authority)
check('B2c', '云端恰 1 行', 1, bucket.adds.length - beforeB2)
check('B2d', '行内 userId ＝ 服务端派生 uid（**非前端自称**）', uidOfPhone(PHONE), bucket.adds[beforeB2].doc.user_id)
check('B2e', '本机镜像行 ＝ 服务端权威行（逐字，非前端自建）', true, submitted.row.id === bucket.adds[beforeB2].doc.id)
check('B2f', '本机镜像已落（读回可见）', true, corrections.listMyCorrections().some((row) => row.id === submitted.row.id))
console.log(
  JSON.stringify({
    B2_readout: { docId: submitted.docId, authority: submitted.authority, row_user_id: submitted.row.user_id, row_field: submitted.row.field }
  })
)

/* B3：**V3 自愈**（本单适配）—— 清令牌 ＋ 有会话 ⇒ 流程**先 issue 补签、再 verify 写**，最终 ok。
   改前断言「清令牌 ⇒ FORBIDDEN」已随 V3 架构（管理员/用户写面收敛到一枚登录令牌 ＋ 自愈）失效。 */
userTokenSvc.clearUserToken()
check('B3', '清令牌后：内存无令牌（present＝false）', false, userTokenSvc.userTokenSnapshot().present)
const callsBeforeB3 = calls.length
const beforeB3 = bucket.adds.length
const healedWrite = await corrections.submitCorrection({ faceId: face.id, sealId: face.sealId, field: 'author', value: '測試作者 自愈' })
check('B3b', 'V3 自愈：清令牌 ＋ **有会话** ⇒ 写成功（ok:true）', true, healedWrite.ok === true)
check('B3c', '自愈权威来源 ＝ SERVER', 'SERVER', healedWrite.authority)
{
  const seq = calls.slice(callsBeforeB3).map((call) => call.action)
  check('B3d', '自愈顺序：**先 issue 后 verify**', true, seq.indexOf('issue') !== -1 && seq.indexOf('verify') !== -1 && seq.indexOf('issue') < seq.indexOf('verify'))
}
check('B3e', '自愈后令牌已进入缓存（present＝true）', true, userTokenSvc.userTokenSnapshot().present === true)
check('B3f', '自愈写：云端恰 1 行', 1, bucket.adds.length - beforeB3)
check('B3g', '自愈写行内 userId ＝ 服务端派生 uid（非前端自称）', uidOfPhone(PHONE), bucket.adds[beforeB3].doc.user_id)

/* B3n：**负向**（本单新增）—— 清令牌 ＋ **无会话** ⇒ 结构化拒绝 ＋ **零写入**（且零往返：连补签都不发）。
   这条把「无会话不得静默放行」钉死，与上面「有会话才自愈」成对。 */
userTokenSvc.clearUserToken()
session.setUser(null)
const callsBeforeB3n = calls.length
const beforeB3n = bucket.adds.length
const noSessionGate = await userWriteSvc.ensureUserTokenForWrite()
check('B3n', '清令牌 ＋ **无会话** ⇒ userWriteGate 结构化拒绝（ok:false ＋ reason 非空）', true, noSessionGate.ok === false && typeof noSessionGate.reason === 'string' && noSessionGate.reason.length > 0)
check('B3n2', '无会话 ⇒ 零写入（云端 add 计数不变）', beforeB3n, bucket.adds.length)
check('B3n3', '无会话 ⇒ 零往返（连补签 request 都不发，「不得静默」的机械证据）', callsBeforeB3n, calls.length)
const noUserWrite = await corrections.submitCorrection({ faceId: face.id, sealId: face.sealId, field: 'author', value: '不該寫入' })
check('B3n4', '服务层本地门同样拒绝（未登录 ⇒ ok:false）', false, noUserWrite.ok)
check('B3n5', '仍零写入', beforeB3n, bucket.adds.length)
/* 复原会话（B4 起仍需登录态）。 */
session.setUser(user)

/* B4：负向 —— 传输失败 ⇒ STORAGE_UNAVAILABLE（**不得伪装 FORBIDDEN**）＋ 令牌不清 */
await userTokenSvc.ensureUserLoginToken(PHONE, SMSCode)
const tokenBeforeB4 = userTokenSvc.userTokenSnapshot().tokenFingerprint
userTokenSvc.setUserTokenTransport(async () => {
  throw new Error('network-down')
})
const netFail = await corrections.submitCorrection({ faceId: face.id, sealId: face.sealId, field: 'author', value: 'x' })
check('B4', '传输失败 ⇒ STORAGE_UNAVAILABLE', 'STORAGE_UNAVAILABLE', netFail.reason)
check('B4b', '传输失败 ≠ FORBIDDEN', true, netFail.reason !== 'FORBIDDEN')
check('B4c', '「未知」≠「无效」：令牌不清', tokenBeforeB4, userTokenSvc.userTokenSnapshot().tokenFingerprint)
userTokenSvc.setUserTokenTransport(async (name, data) => ({ result: await fn.main(data) }))

/* B5：负向 —— 值域拒绝在**任何网络调用之前**（零写入且零往返） */
const callsBeforeB5 = calls.length
const badDomain = await corrections.submitCorrection({ faceId: face.id, sealId: face.sealId, field: 'dynasty', value: '宋朝' })
check('B5', '值域门 ⇒ INVALID_VALUE', 'INVALID_VALUE', badDomain.reason)
check('B5b', '值域拒绝发生在网络之前（零往返）', callsBeforeB5, calls.length)

/* B6：登录失败 ⇒ 零半成品（不建本地行、不写 session、不发初始金） */
session.setUser(null)
memory.clear()
const usersBefore = (await import(path.join(ROOT, 'src/data/db.js'))).listUserRows().length
const badLogin = await authSvc.login(PHONE, `${SMSCode}x`)
check('B6', '验证码错 ⇒ 登录失败', false, badLogin.ok)
check('B6b', '登录失败 ⇒ 零半成品（未建本地账号行）', usersBefore, (await import(path.join(ROOT, 'src/data/db.js'))).listUserRows().length)
check('B6c', '登录失败 ⇒ 未写 session', null, session.currentUser())
/* B6f / B6g（Phase A 语义修复的回归断言）：**服务端结构化拒绝必须原样透传** ——
   修复前 `request()` 把「业务拒绝（`ok:false` ＋ `reason` ＋ `message`）」误判为「回传形状不可辨識」，
   上屏变成 `STORAGE_UNAVAILABLE` ＋「雲端校驗回傳形狀不可辨識…」（**真因被吞、文案变假**）。 */
check('B6f', '登录失败 ⇒ reason 原样透传（不得折叠成 STORAGE_UNAVAILABLE）', badCode.reason, badLogin.reason)
check('B6g', '登录失败 ⇒ message 逐字 ＝ 服务端拒因（不是「形狀不可辨識」）', badCode.message, badLogin.message)
const goodLogin = await authSvc.login(PHONE, SMSCode)
check('B6d', '正确验证码 ⇒ 登录成功（服务端验证）', true, goodLogin.ok === true)
check('B6e', '登录后本机镜像是登录用户', PHONE, (session.currentUser() || {}).phone)

/* B7：dev / 离线形态（**非正式写入路径**）—— 既有本地行为保留 */
writeFace.setWriteFaceModeOverride('local-dev')
const localRow = await corrections.submitCorrection({ faceId: face.id, sealId: face.sealId, field: 'author', value: '離線測試' })
check('B7', 'dev / 離線形態：切片仍可用（本地落盘）', true, localRow.ok === true)
check('B7b', 'dev / 離線形態：权威来源 ＝ LOCAL_DEV（明确标注非正式路径）', 'LOCAL_DEV', localRow.authority)
check('B7c', 'dev / 離線形態：**未发生云端写入**', true, localRow.docId === undefined)
const localLogin = await authSvc.login('13900000002', '4321')
check('B7d', 'dev / 離線形態：本地验证码门仍在（错码 ⇒ 拒）', false, localLogin.ok)
check('B7e', 'dev / 離線形態：形态标注写明「非正式寫入路徑」', true, writeFace.writeFaceModeLabel().includes('非正式寫入路徑'))
writeFace.setWriteFaceModeOverride('cloud')

/* ---------------------------------------------------------------------------
   6. C 段：回归读数（Phase 1 清单逐字不动 ＋ Phase A 切片独立登记）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'C', title: '降级机制 / 清单回归读数' }))
const readout = writeFace.localWriteReadout()
check('C1', 'Phase 1 清单总条数 = 24（未增未减）', 24, readout.total)
check('C2', '分组计数 8 ＋ 6 ＋ 10', { 'raw-persist': 8, 'drive-raw': 6, 'admin-entry': 10 }, readout.byGroup)
check('C3', '迁移状态计数（1 migrated ＋ 23 unmigrated）', { 'phase1-migrated': 1, 'phase1-unmigrated': 23 }, readout.byStatus)
check('C4', 'Phase A 切片独立登记（不并入 24 条）', 1, writeFace.userWriteSliceReadout().total)
check('C5', 'Phase A 切片状态标注', 'phaseA-cloud-verified', writeFace.USER_WRITE_SLICE.status)
console.log(JSON.stringify({ C_entries: readout.entries, C_user_slice: writeFace.userWriteSliceReadout().entries }))

/* ---------------------------------------------------------------------------
   7. D 段：机械扫描（同源 / 同值 / 零硬绑定）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'D', title: '机械扫描' }))
const sha = (file) => createHash('sha256').update(readFileSync(file, 'utf8')).digest('hex')
check('D1', '令牌库两副本 **sha256 恒等**（机制与管理员令牌共用同一套）', sha(adminTokenLibPath), sha(tokenLibPath))
{
  const serviceMarkable = corrections.MARKABLE_FIELDS.map((item) => [item.key, item.label])
  const serverMarkable = Object.entries(ops.MARKABLE_FIELDS)
  check('D2', '服务端字段表与前端真源**逐字相等**（不让副本静默漂移）', serviceMarkable, serverMarkable)
}
check('D3', '集合白名单全部 `^xiai_` 前缀', true, Object.values(ops.COLLECTIONS).every((name) => /^xiai_/.test(name)))
{
  const authSrc = readFileSync(path.join(ROOT, 'src/services/auth.js'), 'utf8')
  const fnSrc = functionFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
  const domainPattern = /https?:\/\/|\bOrigin\b|\bReferer\b/i
  check('D4', '鉴权面**零域名 / Origin / Referer 字面值**（不得与具体域名硬绑定）', false, domainPattern.test(fnSrc))
  check('D4b', '客户端登录面零域名硬绑定', false, /https?:\/\//.test(authSrc))
}
{
  const tokenSrc = readFileSync(path.join(ROOT, 'src/services/token.js'), 'utf8')
  const facade = readFileSync(path.join(ROOT, 'src/services/adminToken.js'), 'utf8')
  check('D5', 'adminToken.js 已退化为**兼容转口**（不再自带实现）', true, facade.trim().split('\n').length <= 20 && /from '\.\/token\.js'/.test(facade))
  check('D5b', '泛化实现恰 1 处（`createTokenChannel` 只定义在 token.js）', 1, (tokenSrc.match(/export function createTokenChannel/g) || []).length)
  check('D5c', '两条通道由**同一次工厂**创建', 2, (tokenSrc.match(/= createTokenChannel\(/g) || []).length)
}
check(
  'D6',
  '客户端令牌**不进 localStorage / sessionStorage**（机械判据：无任何存储 API 调用）',
  false,
  /\.(localStorage|sessionStorage)\.(get|set|remove)Item/.test(readFileSync(path.join(ROOT, 'src/services/token.js'), 'utf8'))
)
{
  /* **reason 字面值判据**（两处，都是直接量）：① 配置面的 `REASONS` 值表；② 源码内的 `reason:'…'` 直写。 */
  const fromReasonTable = Object.values(config.REASONS)
  const inlineReasons = [
    ...new Set(
      functionFiles
        .map((file) => readFileSync(file, 'utf8').match(/reason:\s*'([A-Z_]+)'/g) || [])
        .flat()
        .map((item) => item.replace(/reason:\s*'/, '').replace(/'$/, ''))
    )
  ]
  check(
    'D7',
    '配置面 REASONS 取值 ⊆ 既有冻结表（**新增 reason 字面值 0**）',
    [],
    fromReasonTable.filter((item) => FROZEN_REASONS.indexOf(item) === -1)
  )
  check(
    'D7b',
    '源码内直写的 `reason:\'…\'` ⊆ 既有冻结表',
    [],
    inlineReasons.filter((item) => FROZEN_REASONS.indexOf(item) === -1)
  )
}

/* ---------------------------------------------------------------------------
   8. 汇总
   --------------------------------------------------------------------------- */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id),
    wire_calls: calls.length,
    cloud_rows_written_by_harness: bucket.adds.length
  })
)
process.exit(failures === 0 ? 0 : 1)
