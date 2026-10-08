/**
 * 玺爱 · **影像写入面「双路」自检**（M-1：本机权威存储 api ／ 客户端直传云存储 ＋ `registerArtifact` 回读覆核）
 * ============================================================================
 * **本地、离线、零网络**（传输 / 对象存储 / DB 全部注入；跑的是**真实函数体与真实服务层代码**）。
 *
 * 跑什么：
 *   A. **云函数 op 本体**（`cloudfunctions/xiai-user-token` 的 `registerArtifact`）：
 *      正/负对照（摘要不符 / 字节数不符 / 路径与摘要不符 / 未知键 / 对象不存在 / 非 TIFF / 空对象），
 *      每条负向都机械断言「**结构化拒绝 ＋ 零写入**」；正向断言扁平回包形状与 `idempotent` 语义。
 *   B. **客户端双路**（`src/services/imageAuthority.js::storeArtifactBytes`）：
 *      ① A 路可达 ⇒ 走原路（**对象存储与云函数一次都不碰**，正对照）；
 *      ② A 路不可达 / 200 HTML（线上 Vercel 实况）⇒ 自动走 B 路（直传 ＋ 注册），成功；
 *      ③ 服务业界拒绝（非回落集）⇒ 原样上抛、**不改走 B 路**（负对照）；
 *      ④ B 路的一切「未取得云端回读覆核」形态 ⇒ 结构化失败（dev 放行 / 回读值被篡改）；
 *      ⑤ 两条路的回包**形状逐字段一致**，且都 ⊇ 旧路冻结形状。
 *   C. **静态扫描**：新增 `reason` 字面值 0；新 op 不产出落盘计划；持久化路径仍恰 1 处。
 *
 * 纪律：**不打印任何密钥 / 令牌原文**（只给长度与指纹）；不碰任何服务；断言失败 ⇒ 退出码非 0。
 *
 * 用法（可选环境变量；缺省 ⇒ 脚本自造一次性合成环境，绝不写进仓）：
 *   XIAI_USER_TOKEN_SECRET=… node scripts/verify-artifact-cloud-write.mjs
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
   2. 环境（密钥只从环境变量来；缺省合成一次性假环境）
   --------------------------------------------------------------------------- */
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
  'ALREADY_ENDORSED',
  'DUPLICATE_VALUE'
]

const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const isDenial = (value) => value && value.ok === false && shapeOf(value) === 'message,ok,reason' && FROZEN_REASONS.indexOf(value.reason) !== -1
const fp = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 12)
const sha256Of = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex')

/** 造一份**最小但形态合法**的存儲件字節（TIFF 墨數 ＋ 可辨體：`II*\0` ＋ 少量字節）。 */
function makeTiffBytes(seed, extra = 0) {
  const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])
  const body = Buffer.alloc(24 + extra, seed & 0xff)
  return Buffer.concat([head, body])
}

/* ---------------------------------------------------------------------------
   3. 加载被测件（云函数本体 ＋ op 面 ＋ 服务层）
   --------------------------------------------------------------------------- */
const fnPath = path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js')
const fn = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/index.js'))
const ops = require(fnPath)

/* 假 DB：只记录调用（`registerArtifact` 应当一次都不碰） */
const dbCalls = []
function fakeDbProvider() {
  const map = new Map()
  return {
    collection(name) {
      dbCalls.push({ op: 'collection', name })
      return {
        async where(match) {
          dbCalls.push({ op: 'where', name, match })
          return {
            async get() {
              dbCalls.push({ op: 'get', name })
              return { data: [] }
            },
            async update(doc) {
              dbCalls.push({ op: 'update', name, doc })
              return { updated: 1 }
            }
          }
        },
        doc(id) {
          return {
            async set(doc) {
              dbCalls.push({ op: 'set', name, id, doc })
              map.set(id, doc)
            },
            async get() {
              dbCalls.push({ op: 'doc.get', name, id })
              return { data: map.get(id) ? [map.get(id)] : [] }
            }
          }
        },
        async add(doc) {
          dbCalls.push({ op: 'add', name, doc })
          const id = `doc-${dbCalls.length}`
          map.set(id, doc)
          return { id }
        }
      }
    }
  }
}
ops.setOpsDbProvider(fakeDbProvider)

/** 假对象存储（服务端回读面） */
const bucket = new Map()
let bucketReads = []
let bucketFailMode = ''
ops.setOpsStorageProvider(async (cloudPath) => {
  bucketReads.push(cloudPath)
  if (bucketFailMode === 'throw') throw new Error('injected-object-missing')
  if (!bucket.has(cloudPath)) throw new Error('injected-object-missing')
  return bucket.get(cloudPath)
})

/* 客户端侧：传输注入（直接打真实函数体）＋ fetch 桩 ＋ 直传注入 */
const cloudbaseFn = await import(path.join(ROOT, 'src/data/cloudbaseFn.js'))
const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
const imageAuthority = await import(path.join(ROOT, 'src/services/imageAuthority.js'))
const userTokenSvc = await import(path.join(ROOT, 'src/services/userToken.js'))
const db = await import(path.join(ROOT, 'src/data/db.js'))

let fnCalls = []
let transportMutate = null
userTokenSvc.setUserTokenTransport(async (name, data) => {
  fnCalls.push({ name, data })
  if (name !== 'xiai-user-token') return { ok: false, reason: 'FORBIDDEN', message: 'harness: wrong function' }
  const result = await fn.main(data)
  return { result: transportMutate ? transportMutate(result) : result }
})

/** 直传注入（客户端对象存储写面） */
let uploads = []
let uploadExistedBefore = false
let uploadShape = ''
imageAuthority.setArtifactStorageProvider(async ({ cloudPath, fileID, bytes }) => {
  uploadShape = shapeOf({ cloudPath, fileID, bytes })
  if (!cloudPath || !fileID || !bytes) return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: 'harness: bad request shape' }
  uploads.push({ cloudPath, fileID, length: bytes.length, digest: sha256Of(bytes) })
  if (!bucket.has(cloudPath)) bucket.set(cloudPath, Buffer.from(bytes))
  return { ok: true, existedBefore: uploadExistedBefore }
})

/** fetch 桩（A 路：本机权威存储 api） */
class FakeHeaders {
  constructor(map) {
    this.map = Object.assign({}, map)
  }
  get(name) {
    return this.map[String(name).toLowerCase()] || null
  }
}
const fetchCalls = []
let fetchMode = 'ok'
let fetchPayload = null
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), method: init && init.method, bytes: init && init.body ? init.body.length : 0 })
  if (fetchMode === 'throw') throw new TypeError('Failed to fetch')
  if (fetchMode === 'html') {
    /* 线上 Vercel 实况：SPA 兜底回 **200 text/html** ⇒ `reply.ok === true` 但 `json()` 抛错。 */
    return { ok: true, status: 200, headers: new FakeHeaders({}), json: async () => { throw new SyntaxError('Unexpected token <') } }
  }
  if (fetchMode === 'reject') {
    return { ok: false, status: 413, headers: new FakeHeaders({}), json: async () => ({ ok: false, reason: 'TOO_LARGE', message: 'too large' }) }
  }
  if (fetchMode === 'reject-plain') {
    return { ok: false, status: 500, headers: new FakeHeaders({}), json: async () => { throw new SyntaxError('not json') } }
  }
  /* `ok` 模式：真实权威回包（摘要与体量按**本地字节**算，由调用方现算后塞进 fetchPayload）。 */
  return { ok: true, status: 200, headers: new FakeHeaders({ 'x-xiai-idempotent': fetchPayload.idempotent }), json: async () => fetchPayload.body }
}

/* 令牌：先经真实函数签发（走注入传输），供 `userWriteGate` 携带 */
writeFace.setWriteFaceModeOverride('cloud')
const login = await userTokenSvc.requestUserToken(PHONE, SMSCode)
check('Z0', 'harness：经真实函数体取得用户令牌（不打印原文）', true, login.ok === true)
console.log(JSON.stringify({ Z0_readout: { token: { length: userTokenSvc.userTokenSnapshot().tokenLength }, mode: writeFace.writeFaceMode() } }))

const TIFF = makeTiffBytes(0x5a, 0)
const TIFF_DIGEST = sha256Of(TIFF)
const localDigest = (await import(path.join(ROOT, 'src/data/assetmeta.js'))).sha256Hex(TIFF)
const CLOUD_PATH = imageAuthority.artifactObjectKeyOf(TIFF_DIGEST)
const REL_PATH = imageAuthority.artifactRelPathOf(TIFF_DIGEST)

check('Z1', '客户端摘要算法 与 Node `crypto` 的 sha256 **逐字一致**（同一把尺子）', TIFF_DIGEST, localDigest)
check('Z2', '对象键形态 ＝ xiai/images/<摘要前两位>/<摘要>.tiff', true, /^xiai\/images\/[0-9a-f]{2}\/[0-9a-f]{64}\.tiff$/.test(CLOUD_PATH))
check('Z2b', '对象键前两位 ≡ 摘要前两位', TIFF_DIGEST.slice(0, 2), CLOUD_PATH.split('/')[2])

/* ---------------------------------------------------------------------------
   4. A 段：云函数 op 本体（正/负对照）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'A', title: '云函数 op registerArtifact（回读覆核）' }))

const issued = await fn.main({ action: 'issue', phone: PHONE, code: SMSCode })
const token = issued.token
const callOp = (payload) => fn.main({ action: 'verify', token, op: 'registerArtifact', payload })

/* A0 正向：桶内字节与声称值逐字一致 ⇒ ok ＋ 扁平回包 */
bucket.set(CLOUD_PATH, TIFF)
const beforeA0 = dbCalls.length
const okOp = await callOp({ cloudPath: CLOUD_PATH, sha256: TIFF_DIGEST, bytesLength: TIFF.length })
const opDirect = await ops.OPS.registerArtifact({ cloudPath: CLOUD_PATH, sha256: TIFF_DIGEST, bytesLength: TIFF.length })
check('A0', '一致 ⇒ ok:true', true, okOp.ok === true && opDirect.ok === true)
check('A0b', 'op 回包键面 ＝ brief 冻结的扁平六键 ＋ 分组视图', 'artifact,bytesLength,idempotent,mime,ok,sha256,storageKey', shapeOf(opDirect))
check('A0c', '回读值 ＝ 声称值（逐字）', { sha256: TIFF_DIGEST, bytesLength: TIFF.length }, { sha256: okOp.artifact.sha256, bytesLength: okOp.artifact.bytesLength })
check('A0d', '容器按字节判定 ＝ image/tiff', 'image/tiff', okOp.artifact.mime)
check('A0e', 'storageKey ＝ 对象键（＝ 行上 storage_key 的取值）', CLOUD_PATH, okOp.artifact.storageKey)
check('A0f', 'idempotent ＝ true（本 op 零写入、重放等结果）', true, okOp.artifact.idempotent)
check('A0g', '分组视图 `artifact` 与扁平五键同源同值', { sha256: TIFF_DIGEST, bytesLength: TIFF.length, mime: 'image/tiff', storageKey: CLOUD_PATH, idempotent: true }, okOp.artifact)
check('A0h', '**零写入**：op 本体一次都不碰 DB（`plan` 未产出）', 0, dbCalls.length - beforeA0)
check('A0i', 'op 回包**无 `plan` 键**（`index.js` 的落盘分支不触发）', false, Object.prototype.hasOwnProperty.call(okOp, 'plan'))
/* 经 `index.js` 信封调用（客户端实际走的那条） */
const envOp = await fn.main({ action: 'verify', token, op: 'registerArtifact', payload: { cloudPath: CLOUD_PATH, sha256: TIFF_DIGEST, bytesLength: TIFF.length } })
check('A0j', '信封层 `artifact` 原样透传（＝ op 回包的分组视图）', okOp.artifact, envOp.artifact)

/* A1 负向：桶内字节 ≠ 声称摘要（**摘要不符**）⇒ 结构化拒绝 ＋ 零写入 */
const TAMPERED = makeTiffBytes(0x11, 4)
bucket.set(CLOUD_PATH, TAMPERED)
const beforeA1 = dbCalls.length
const digestMismatch = await callOp({ cloudPath: CLOUD_PATH, sha256: TIFF_DIGEST, bytesLength: TIFF.length })
check('A1', '摘要不符 ⇒ INVALID_VALUE ＋ 恰 3 键', true, isDenial(digestMismatch) && digestMismatch.reason === 'INVALID_VALUE')
check('A1b', '摘要不符 ⇒ **零写入**', 0, dbCalls.length - beforeA1)
check('A1c', '回包**不吐真值**（不把本 op 变成探测器）', false, /[0-9a-f]{64}/.test(JSON.stringify(digestMismatch)))

/* A2 负向：字节数不符 ⇒ 结构化拒绝 ＋ 零写入 */
bucket.set(CLOUD_PATH, TIFF)
const beforeA2 = dbCalls.length
const sizeMismatch = await callOp({ cloudPath: CLOUD_PATH, sha256: TIFF_DIGEST, bytesLength: TIFF.length + 1 })
check('A2', '字节数不符 ⇒ INVALID_VALUE ＋ 恰 3 键', true, isDenial(sizeMismatch) && sizeMismatch.reason === 'INVALID_VALUE')
check('A2b', '字节数不符 ⇒ **零写入**', 0, dbCalls.length - beforeA2)

/* A3 负向：对象键内摘要 ≠ 声称摘要（**读取之前就拒**） */
const beforeA3 = bucketReads.length
const pathMismatch = await callOp({ cloudPath: imageAuthority.artifactObjectKeyOf(sha256Of(TAMPERED)), sha256: TIFF_DIGEST, bytesLength: TIFF.length })
check('A3', '路径摘要 ≠ 声称摘要 ⇒ INVALID_VALUE ＋ 恰 3 键', true, isDenial(pathMismatch) && pathMismatch.reason === 'INVALID_VALUE')
check('A3b', '该形态**连对象都不读**（判定在回读之前）', 0, bucketReads.length - beforeA3)

/* A4 负向：未知键 / 身份类键 ⇒ INVALID_FIELD ＋ 零写入 */
const beforeA4 = dbCalls.length
const unknownKey = await callOp({ cloudPath: CLOUD_PATH, sha256: TIFF_DIGEST, bytesLength: TIFF.length, userId: 'u-x' })
check('A4', '载荷含未知（身份类）键 ⇒ INVALID_FIELD ＋ 恰 3 键', true, isDenial(unknownKey) && unknownKey.reason === 'INVALID_FIELD')
check('A4b', '未知键 ⇒ **零写入**', 0, dbCalls.length - beforeA4)

/* A5 负向：对象不存在 ⇒ STORAGE_UNAVAILABLE（**不伪装 FORBIDDEN**） */
const MISSING_PATH = imageAuthority.artifactObjectKeyOf(sha256Of(Buffer.from('missing')))
const beforeA5 = dbCalls.length
const missing = await callOp({ cloudPath: MISSING_PATH, sha256: sha256Of(Buffer.from('missing')), bytesLength: 7 })
check('A5', '对象不存在 ⇒ STORAGE_UNAVAILABLE（≠ FORBIDDEN）', true, isDenial(missing) && missing.reason === 'STORAGE_UNAVAILABLE')
check('A5b', '对象不存在 ⇒ **零写入**', 0, dbCalls.length - beforeA5)

/* A6 负向：非 TIFF 容器 / 空对象 ⇒ INVALID_VALUE（不新增 reason 字面值） */
const NOT_TIFF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const NOT_TIFF_PATH = imageAuthority.artifactObjectKeyOf(sha256Of(NOT_TIFF))
bucket.set(NOT_TIFF_PATH, NOT_TIFF)
const notTiff = await callOp({ cloudPath: NOT_TIFF_PATH, sha256: sha256Of(NOT_TIFF), bytesLength: NOT_TIFF.length })
check('A6', '非 TIFF 容器 ⇒ INVALID_VALUE ＋ 恰 3 键', true, isDenial(notTiff) && notTiff.reason === 'INVALID_VALUE')
const EMPTY = Buffer.alloc(0)
const EMPTY_PATH = imageAuthority.artifactObjectKeyOf(sha256Of(EMPTY))
bucket.set(EMPTY_PATH, EMPTY)
const emptyObj = await callOp({ cloudPath: EMPTY_PATH, sha256: sha256Of(EMPTY), bytesLength: 1 })
check('A6b', '空对象 / 声称体量非法 ⇒ INVALID_VALUE', true, isDenial(emptyObj) && emptyObj.reason === 'INVALID_VALUE')

/* A7 负向：无令牌 / 未知 op ⇒ 既有拒绝面（本 op 未放宽任何门） */
const noToken = await fn.main({ action: 'verify', token: '', op: 'registerArtifact', payload: { cloudPath: CLOUD_PATH, sha256: TIFF_DIGEST, bytesLength: TIFF.length } })
check('A7', '无令牌 ⇒ FORBIDDEN（未携带有效令牌）＋ 恰 3 键', true, isDenial(noToken) && noToken.reason === 'FORBIDDEN')

/* ---------------------------------------------------------------------------
   5. B 段：客户端双路
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'B', title: '客户端双路 storeArtifactBytes' }))

const resetCounters = () => {
  fnCalls = []
  uploads = []
  bucketReads = []
  fetchCalls.length = 0
  transportMutate = null
}

/* B0 正向对照：A 路可达 ⇒ 走原路；**对象存储与云函数一次都不碰** */
resetCounters()
fetchMode = 'ok'
fetchPayload = { body: { ok: true, sha256: TIFF_DIGEST, bytesLength: TIFF.length, relPath: REL_PATH }, idempotent: 'true' }
const viaApi = await imageAuthority.storeArtifactBytes(TIFF)
check('B0', 'A 路可达 ⇒ ok:true', true, viaApi.ok === true)
check('B0b', 'A 路回包：sha256/bytesLength/mime/relPath 与旧口径逐字一致', { sha256: TIFF_DIGEST, bytesLength: TIFF.length, mime: 'image/tiff', relPath: REL_PATH }, { sha256: viaApi.sha256, bytesLength: viaApi.bytesLength, mime: viaApi.mime, relPath: viaApi.relPath })
check('B0c', 'A 路 `storageKey` 为空串（＝ 行上 `storage_key` 仍空字串，**既有口径一字未改**）', '', viaApi.storageKey)
check('B0d', 'A 路 `idempotent` 取 `X-Xiai-Idempotent` 头', true, viaApi.idempotent)
check('B0e', 'A 路命中 ⇒ **直传 0 次**（正对照）', 0, uploads.length)
check('B0f', 'A 路命中 ⇒ **云函数 0 次**（正对照）', 0, fnCalls.length)
check('B0g', 'A 路请求打到既有唯一端點 `/image/store`', true, fetchCalls.length === 1 && /\/image\/store$/.test(fetchCalls[0].url))

/* B1 正向：A 路不可达（fetch 抛错）⇒ 自动走 B 路（直传 ＋ 注册）且成功 */
resetCounters()
fetchMode = 'throw'
bucket.set(CLOUD_PATH, TIFF)
uploadExistedBefore = false
const viaCloud = await imageAuthority.storeArtifactBytes(TIFF)
check('B1', 'A 路不可达 ⇒ B 路成功', true, viaCloud.ok === true)
check('B1b', '直传恰 1 次，打到内容寻址键', [{ cloudPath: CLOUD_PATH, digest: TIFF_DIGEST, length: TIFF.length }], uploads.map((item) => ({ cloudPath: item.cloudPath, digest: item.digest, length: item.length })))
check('B1c', 'fileID 由**既有唯一构造点**产出（`cloud://` ＋ 桶段 ＋ 对象键）', true, /^cloud:\/\/.*\.tiff$/.test(uploads[0].fileID) && uploads[0].fileID.endsWith(`/${CLOUD_PATH}`))
check('B1d', '注册恰 1 次、op 名逐字 ＝ registerArtifact', true, fnCalls.length === 1 && fnCalls[0].data.op === 'registerArtifact' && fnCalls[0].data.action === 'verify')
check('B1e', '注册载荷键面逐字 ＝ {cloudPath,sha256,bytesLength}', 'bytesLength,cloudPath,sha256', shapeOf(fnCalls[0].data.payload))
check('B1f', 'B 路回包：sha256/bytesLength/mime/relPath', { sha256: TIFF_DIGEST, bytesLength: TIFF.length, mime: 'image/tiff', relPath: REL_PATH }, { sha256: viaCloud.sha256, bytesLength: viaCloud.bytesLength, mime: viaCloud.mime, relPath: viaCloud.relPath })
check('B1g', 'B 路 `storageKey` ＝ 对象键（＝ 行上 `storage_key`）', CLOUD_PATH, viaCloud.storageKey)
check('B1h', 'B 路成功时**未携带任何身份类键**（身份由令牌派生）', false, /userId|user_id|user_phone|"phone"/.test(JSON.stringify(fnCalls[0].data.payload)))

/* B2 正向：A 路回 200 HTML（线上 Vercel 实况）⇒ 同样回落 B 路 */
resetCounters()
fetchMode = 'html'
const viaHtml = await imageAuthority.storeArtifactBytes(TIFF)
check('B2', 'A 路回 200 HTML（SPA 兜底）⇒ 回落 B 路成功', true, viaHtml.ok === true)
check('B2b', '该形态下直传 1 次、注册 1 次', [1, 1], [uploads.length, fnCalls.length])

/* B3 负对照：A 路给**业务性**拒绝（不在回落集内）⇒ 原样上抛，**不改走 B 路** */
resetCounters()
fetchMode = 'reject'
const business = await imageAuthority.storeArtifactBytes(TIFF)
check('B3', 'A 路业务拒绝 ⇒ 原样透传 reason（不换路）', true, business.ok === false && business.reason === 'TOO_LARGE')
check('B3b', 'A 路失败文案沿用旧口径（本单未改动 A 路任何字面值）', imageAuthority.AUTHORITY_MESSAGES.storeFail, business.message)
check('B3c', '业务拒绝 ⇒ 直传 0 次 / 云函数 0 次（**不换路**）', [0, 0], [uploads.length, fnCalls.length])

/* B4 负对照：`idempotent` 语义（B 路 ＝ 「本轮之前对象是否已存在」） */
resetCounters()
fetchMode = 'throw'
uploadExistedBefore = true
const repeat = await imageAuthority.storeArtifactBytes(TIFF)
check('B4', 'B 路：对象本轮之前已存在 ⇒ idempotent ＝ true', true, repeat.ok === true && repeat.idempotent === true)
resetCounters()
uploadExistedBefore = false
const fresh = await imageAuthority.storeArtifactBytes(TIFF)
check('B4b', 'B 路：对象本轮之前不存在 ⇒ idempotent ＝ false（与 A 路语义一致）', true, fresh.ok === true && fresh.idempotent === false)
uploadExistedBefore = false

/* B5 负向：服务端回读**摘要不符**（篡改回包）⇒ 客户端必须失败且零写入（正/负对照） */
resetCounters()
fetchMode = 'throw'
transportMutate = (result) => {
  if (result && result.artifact) return Object.assign({}, result, { artifact: Object.assign({}, result.artifact, { sha256: sha256Of(TAMPERED) }) })
  return result
}
const beforeB5 = dbCalls.length
const echoTampered = await imageAuthority.storeArtifactBytes(TIFF)
check('B5', '回读摘要与本地不符 ⇒ 结构化失败（不报成功）', true, echoTampered.ok === false && echoTampered.reason === 'UNRECOGNIZED_IMAGE')
check('B5b', '该形态下**零写入**（不落任何影像行）', 0, dbCalls.length - beforeB5)
/* 正对照：去掉篡改 ⇒ 同一路径成功（证明探针能区分「真成功」与「假成功」） */
resetCounters()
transportMutate = null
const beforeB5p = dbCalls.length
const echoOk = await imageAuthority.storeArtifactBytes(TIFF)
check('B5c', '正对照：同一路径去掉篡改 ⇒ 成功', true, echoOk.ok === true)
check('B5d', '正对照：成功路径同样零 DB 写入（本层不落行，行由数据层写）', 0, dbCalls.length - beforeB5p)

/* B6 负向：服务端结构化拒绝（对象缺失）⇒ 原样透传 reason ＋ 零写入 */
resetCounters()
fetchMode = 'throw'
uploadExistedBefore = false
/* 直传注入改成「不落桶」⇒ 服务端回读必失败 */
imageAuthority.setArtifactStorageProvider(async ({ cloudPath, bytes }) => ({ ok: true, existedBefore: false, cloudPath, length: bytes.length }))
const beforeB6 = dbCalls.length
const orphan = await imageAuthority.storeArtifactBytes(Buffer.from(makeTiffBytes(0x77, 8)))
check('B6', '服务端回读不到对象 ⇒ 原样透传 STORAGE_UNAVAILABLE ＋ 零写入', true, orphan.ok === false && orphan.reason === 'STORAGE_UNAVAILABLE' && dbCalls.length - beforeB6 === 0)
/* 复原注入 */
imageAuthority.setArtifactStorageProvider(async ({ cloudPath, fileID, bytes }) => {
  uploads.push({ cloudPath, fileID, length: bytes.length, digest: sha256Of(bytes) })
  if (!bucket.has(cloudPath)) bucket.set(cloudPath, Buffer.from(bytes))
  return { ok: true, existedBefore: uploadExistedBefore }
})
void 0

/* B7 负向：dev / 离线形态（无云端覆核）⇒ 结构化失败（**不得只信客户端自报**） */
resetCounters()
writeFace.setWriteFaceModeOverride('local-dev')
const beforeB7 = dbCalls.length
const devMode = await imageAuthority.storeArtifactBytes(TIFF)
check('B7', 'dev / 离线形态 ⇒ 未取得云端回读覆核 ⇒ 结构化失败', true, devMode.ok === false && devMode.reason === 'STORAGE_UNAVAILABLE')
check('B7b', '该形态下零写入', 0, dbCalls.length - beforeB7)
writeFace.setWriteFaceModeOverride('cloud')

/* B8 形状一致性：两条路的回包**键集合逐字相同**，且都 ⊇ 旧路冻结形状 */
const OLD_SHAPE = ['bytesLength', 'idempotent', 'message', 'mime', 'ok', 'relPath', 'sha256']
check('B8', '两条路的回包键集合**逐字相同**', shapeOf(viaCloud), shapeOf(viaApi))
check('B8b', '两条路的回包都 ⊇ 旧路冻结形状（旧消费方零改动）', true, OLD_SHAPE.every((key) => Object.prototype.hasOwnProperty.call(viaCloud, key) && Object.prototype.hasOwnProperty.call(viaApi, key)))
check('B8c', 'B 路新增的唯一键 ＝ `storageKey`（行上 `storage_key` 的来源）', ['bytesLength', 'idempotent', 'message', 'mime', 'ok', 'relPath', 'sha256', 'storageKey'], Object.keys(viaCloud).sort())
check('B8d', '两条路失败形态同为恰 3 键 `{ok,reason,message}`', 'message,ok,reason', shapeOf(business))

/* B9 双路选择表（逐条机械断言） */
check('B9', '回落集恰 4 值（不可达 / 形状不可辨；业务拒绝不在内）', ['EMPTY_CONTENT', 'NOT_IMAGE', 'STORAGE_UNAVAILABLE', 'UNRECOGNIZED_IMAGE'], [...imageAuthority.ARTIFACT_FALLBACK_REASONS].sort())
/* **不新增 reason 字面值**：回落集里的每个值都必须在**本单之前**就已存在（逐值给出处文件）。 */
const PREEXISTING_SERVICE_REASONS = Object.freeze({
  UNRECOGNIZED_IMAGE: 'src/data/assetmeta.js（既有数据层「认不出」字面值）',
  NOT_IMAGE: 'src/services/displayImage.js（既有服务层对外值）',
  EMPTY_CONTENT: 'src/services/displayImage.js（既有服务层对外值）'
})
const unknownReason = imageAuthority.ARTIFACT_FALLBACK_REASONS.filter(
  (item) => FROZEN_REASONS.indexOf(item) === -1 && !Object.prototype.hasOwnProperty.call(PREEXISTING_SERVICE_REASONS, item)
)
check('B9b', '回落集**不引入任何新字面值**（其余 ∈ 冻结表 / 既有服务层值）', [], unknownReason)
const preexistingEvidence = Object.entries(PREEXISTING_SERVICE_REASONS).map(([literal, file]) => {
  const text = readFileSync(path.join(ROOT, file.split('（')[0]), 'utf8')
  return `${literal}@${file.split('（')[0]}:${text.includes(`'${literal}'`) ? 'present' : 'MISSING'}`
})
check('B9c', '出处正对照：三个既有服务层字面值在各自文件里确有定义（非本单新造）', true, preexistingEvidence.every((item) => item.endsWith('present')))

/* ---------------------------------------------------------------------------
   6. C 段：静态扫描（新增 reason 字面值 0 / op 零落盘 / 持久化路径恰 1 处）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'C', title: '静态扫描' }))

const TOUCHED = [
  'src/services/imageAuthority.js',
  'src/services/token.js',
  'src/data/db.js',
  'src/data/cloudbaseFn.js',
  'cloudfunctions/xiai-user-token/index.js',
  'cloudfunctions/xiai-user-token/lib/ops.js'
]
const fromReasonTable = Object.values(require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/config.js')).REASONS)
check('C1', '配置面 REASONS 取值 ⊆ 既有冻结表（**新增 reason 字面值 0**）', [], fromReasonTable.filter((item) => FROZEN_REASONS.indexOf(item) === -1))

/* **与 HEAD 逐文件对照**：本单改动的文件**不得新增任何 `reason` 字面值**（读 `git show`，只读）。 */
const { execFileSync } = await import('node:child_process')
const literalPattern = /reason:\s*'([A-Z_]+)'/g
const literalsOf = (text) => [...text.matchAll(literalPattern)].map((matched) => matched[1])
const headTextOf = (rel) => execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const newLiterals = {}
for (const rel of TOUCHED) {
  const before = literalsOf(headTextOf(rel))
  const added = literalsOf(readFileSync(path.join(ROOT, rel), 'utf8')).filter((item) => before.indexOf(item) === -1)
  if (added.length > 0) newLiterals[rel] = added
}
check('C1b', '本单改动文件**未新增任何 `reason:` 字面值**（与 HEAD 逐文件对照）', {}, newLiterals)
check('C1c', '对照判据正对照（HEAD 版本的被检文件里确有命中）', true, literalsOf(headTextOf('src/services/imageAuthority.js')).length > 0)

const opsSource = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'), 'utf8')
const collectionHits = []
for (const rel of ['cloudfunctions/xiai-user-token/index.js', 'cloudfunctions/xiai-user-token/lib/token.js', 'cloudfunctions/xiai-user-token/lib/config.js']) {
  if (/collection\(/.test(readFileSync(path.join(ROOT, rel), 'utf8'))) collectionHits.push(rel)
}
check('C2', '持久化路径仍恰 1 处（`collection(` 只在 `lib/ops.js`）', [], collectionHits)
check('C2b', '正对照：`lib/ops.js` 自身命中 `collection(`', true, /collection\(/.test(opsSource))
const opStart = opsSource.indexOf('async registerArtifact(')
const opEnd = opsSource.indexOf('\n  }\n})', opStart)
const opBody = opStart >= 0 && opEnd > opStart ? opsSource.slice(opStart, opEnd) : ''
check('C3', '新 op 本体（切片）不含任何落盘计划（`plan:` 命中 0）', [false, true], [opBody.includes('plan:'), opBody.includes('readArtifactBytes')])

const dbSource = readFileSync(path.join(ROOT, 'src/data/db.js'), 'utf8')
check('C4', '行 `storage_key` 由权威方回包决定（A 路空串不变 / B 路 ＝ 对象键）', true, /storage_key: authority \? String\(authority\.storageKey \|\| ''\) : assetBlobKey\(assetId\)/.test(dbSource))
check('C5', '读面**只**走既有机制：`IMAGE_OBJECT_KEY_PATTERN` / `cloudBaseObjectKeyOf` 未被本单改动', true, /IMAGE_OBJECT_KEY_PATTERN = \/\^xiai\\\/images\\\/\(\[0-9a-f\]\{2\}\)\\\/\(\[0-9a-f\]\{64\}\)\\\.\(png\|webp\)\$\//.test(readFileSync(path.join(ROOT, 'src/data/cloudbase.js'), 'utf8')))
const readFaceChanged = ['src/data/cloudbase.js'].filter((rel) => {
  const text = readFileSync(path.join(ROOT, rel), 'utf8')
  return /tiff/i.test(text.split('IMAGE_OBJECT_KEY_PATTERN')[1] ? text.split('IMAGE_OBJECT_KEY_PATTERN')[1].split('\n')[0] : '')
})
check('C5b', '对象键模式行内**不含** tiff（读面口径一字未改）', [], readFaceChanged)

/* ---------------------------------------------------------------------------
   7. 汇总
   --------------------------------------------------------------------------- */
const summary = { total: results.length, passed: results.length - failures, failed: failures }
console.log(JSON.stringify({ summary, failed_ids: results.filter((item) => !item.pass).map((item) => item.id), wire_calls: fnCalls.length }))
if (failures > 0) process.exitCode = 1
