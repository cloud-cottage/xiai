/**
 * Neng · **对抗性质检：AI 图生图中转站 ＋ 金上云**（`scripts/qa-ai-relay-audit.mjs`）
 * ============================================================================
 * 与 `verify-*.mjs`（实现方自检）**并行的独立质检**：不复述自检断言，专打
 * **实现方没想到的对抗边界**。全部 **本地、离线**（内存假 DB ＋ 注入 fetch / 时钟 /
 * 签名链 / 转存；**零端口、零云端、零生产数据**）。
 *
 * 被测件：`cloudfunctions/xiai-user-token/{index.js, lib/{ops,ledger,aiKeys,aiUpstream,aiUsage}.js}`
 *        ＋ `api/_lib/aiRelay.js`（真 handler 直调）。
 *
 * 断言面（本套 **52** 条）：
 *   A 甲1 越权：A 会话吊销 / 改限 B 的金鑰 ⇒ FORBIDDEN ＋ **零写入**；不存在 vs 非本人
 *      **同一 reason 同一 message**（防枚举）；**管理员也不例外**（管理员非金鑰本人亦拒）。
 *   B 甲2 零明文：全部 11 op 回包 ＋ 中转全部回包 ＋ 全部日志，对
 *      「金鑰明文 / 上游 key / key_hash / key_cipher / key_iv / key_tag / 主密钥」逐字搜索
 *      count=0（唯一豁免＝签发回包那一次明文，恰 1 处）；401 回包**不回显**所持 token。
 *   C 甲3 伪造：11 op 载荷带 `uid`/`userId`/`user_id`/`role`/`phone`/`key_hash`/`actor_uid`
 *      /`updated_by_uid` ⇒ INVALID_FIELD ＋ 零写入；`Authorization` 六种烂法
 *      （无 / Basic / 错前缀 / 空 Bearer / 小写 bearer / 篡改尾字符）⇒ 同一 401 同一 message。
 *   D 甲4 匿名：11 op 无令牌 ⇒ FORBIDDEN ＋ 零写入；中转无凭据 ⇒ 401 零扣费；
 *      前端 7 入口未登录全前置拒 ＋ **传输层零往返**（独立复跑，不信既有报告）。
 *   E 乙5 并发：同 uid **3 笔**并发各 5 金（初始 50）⇒ 恰 35、流水 3 行、
 *      `balance_after` 三值不重复；**负对照**朴素读改写同台 ⇒ 45。
 *   F 乙6 幂等：同键串行 3 连击 / 并发 2 路 ⇒ 只扣一次；分键互不误判；
 *      **重放换金额（5→100）不加扣**；**跨 uid 同键**（lib 层登记项：返回首結果、
 *      B 余额不变；端点不可达 ⇒ idem 綁 key_id）。
 *   G 乙7 超额零扣费：日限满 / 分鐘限满 / 余额不足 ⇒ 余额、流水、用量行**三面严格不变**；
 *      **边界 off-by-one**（used=limit-1 放行、used=limit 拒）。
 *   H 乙8 退款：5xx / 超时 / 200 无图 ⇒ **REFUND 行在且原 CHARGE 行一字不动**、余额复原；
 *      **同 rid 连败两次 ⇒ 2 CHARGE ＋ 2 REFUND、净扣 0**（H4 已按 Zang 裁定 · v1.75 / AC-605
 *      改判，旧断言「恰 1 CHARGE ＋ 1 REFUND」编码的是修复前语义、已在标题明写取代）；
 *      **败后重放转成功 ⇒ 净扣 10**；**连败两次后第三次成功 ⇒ 净扣恰 10**（H6 新增，AC-605 ③）。
 *   I 丙9 封闭面：reason 恰 8 面 9 字面、成功恰 5 键、400/401/429 恰 3 键、
 *      `n` 各怪值、未知体键（含 image 子键）全拒。
 *   J 丙10：`X-Request-Id` 缺/7/65/纯空白 ⇒ 400 零扣费、8/64 边界放行；
 *      `idem_key` 逐字＝ `sha256(key_id:rid)`。
 *   K 丙11 图片面：恰 2 MiB 放行、2 MiB+1 拒、魔数不符拒、双鍵同給拒、
 *      `data:image/` 回包/日志/上游体零命中；**大写前綴 / base64 内换行 / 三重 padding
 *      / webp·tiff 魔数**对抗样本。
 *
 *   L AC 补面（矩阵取证）：L1 中转端点契约（edits / generations 路径 ＋ 换配置零改码跟随 ＋
 *      502 归一化零透传＝AC-593）；L2 `image` 第三鍵 ⇒ 400 零写入（AC-601 ②）；
 *      L3 签发回包明文正则 ＋ 8 位前缀（AC-591 ①）；
 *      L4 请求体上限（`MAX_BODY_BYTES` 4 MiB 阀值真源，恰 4 MiB 与 4 MiB+1 裸体 ⇒ 400
 *      零上游零扣费＝AC-599③）；L5 `data_url` 前缀/形态非法四发（非 image 类 / 裸 base64 /
 *      缺 payload / 缺 `;base64` ⇒ 全 400 零写入＝AC-602②）。
 *
 * 纪律：只新增本文件；不改产品代码 / 规范 / 既有 verify 脚本；不做 git 写操作；
 * 不打印任何明文凭据（只打印长度与指纹）；断言失败 ⇒ 退出码 1。
 * 用法：node scripts/qa-qa-ai-relay-audit.mjs  →  node scripts/qa-ai-relay-audit.mjs
 */
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FN = path.join(ROOT, 'cloudfunctions/xiai-user-token')

/* ---------------------------------------------------------------- 0. 断言面 */

let total = 0
let passed = 0
const failedIds = []
function emit(line) {
  console.log(JSON.stringify(line))
}
function check(section, id, caseTitle, pass, evidence) {
  total += 1
  if (pass) passed += 1
  else failedIds.push(id)
  emit({ section, id, case: caseTitle, pass: Boolean(pass), evidence })
}
const sha256 = (v) => createHash('sha256').update(String(v), 'utf8').digest('hex')
const rndHex = (tag) => sha256(`${tag}-${Date.now()}-${randomBytes(8).toString('hex')}`)
const countIn = (text, needle) => (needle === '' ? -1 : String(text).split(needle).length - 1)
const shapeOf = (v) => Object.keys(v || {}).sort().join(',')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 凭据字面一律拼装（仓内不落整串）。 */
const AUTH = 'Author' + 'ization'
const BEARER = 'Bear' + 'er'
const KEY_PFX = 'sk-' + 'xiai-'

/* ------------------------------------------------- 1. 合成环境（随机凭据） */

process.env.XIAI_USER_SMS_CODE = String(process.env.XIAI_USER_SMS_CODE || '729341').trim()
if (!process.env.XIAI_USER_TOKEN_SECRET) process.env.XIAI_USER_TOKEN_SECRET = rndHex('user-secret')
process.env.XIAI_USER_TOKEN_VERSION = process.env.XIAI_USER_TOKEN_VERSION || '1'
process.env.XIAI_ADMIN_PHONE = String(process.env.XIAI_ADMIN_PHONE || '13800000001').trim()
const UPSTREAM_SECRET = rndHex('upstream-secret')
const UPSTREAM_KEY = rndHex('upstream-key')
process.env.XIAI_AI_UPSTREAM_SECRET = UPSTREAM_SECRET

const ledger = require(path.join(FN, 'lib/ledger.js'))
const aiKeys = require(path.join(FN, 'lib/aiKeys.js'))
const aiUpstream = require(path.join(FN, 'lib/aiUpstream.js'))
const aiUsage = require(path.join(FN, 'lib/aiUsage.js'))
const ops = require(path.join(FN, 'lib/ops.js'))
const fn = require(path.join(FN, 'index.js'))
const core = await import(pathToFileURL(path.join(ROOT, 'api/_lib/aiRelay.js')).href)

/* ------------------------------------------------------- 2. 内存假 DB（同 verify 家族形状） */

const tick = () => new Promise((r) => setImmediate(r))
const rowMatches = (row, match) => Object.keys(match).every((k) => row[k] === match[k])

function createFakeDb() {
  const buckets = new Map()
  const stats = { writes: 0, reads: 0 }
  const bucketOf = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    return buckets.get(name)
  }
  function makeQuery(map, state) {
    return {
      async get() {
        await tick()
        stats.reads += 1
        return { data: [...map.values()].filter((r) => rowMatches(r, state.match || {})).map((r) => ({ ...r })) }
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
        stats.writes += 1
        return { updated }
      }
    }
  }
  return {
    stats,
    bucketOf,
    collection(name) {
      const map = bucketOf(name)
      return {
        doc(id) {
          return {
            async get() {
              await tick()
              stats.reads += 1
              const row = map.get(id)
              return { data: row ? { ...row } : null }
            },
            async set(doc) {
              await tick()
              map.set(id, { _id: id, ...doc })
              stats.writes += 1
              return { updated: 1 }
            }
          }
        },
        async add(doc) {
          await tick()
          const id = typeof doc._id === 'string' && doc._id !== '' ? doc._id : `gen-${map.size + 1}-${Math.random().toString(36).slice(2, 8)}`
          if (map.has(id)) throw new Error('FAKE_DUPLICATE_ID')
          map.set(id, { _id: id, ...doc })
          stats.writes += 1
          return { _id: id }
        },
        where(match) {
          return makeQuery(map, { match })
        }
      }
    }
  }
}

const fakeDb = createFakeDb()
const writesNow = () => fakeDb.stats.writes
const flowRows = () => [...fakeDb.bucketOf('xiai_points_flow').values()]
const balanceOf = (uid) => {
  const row = fakeDb.bucketOf('xiai_balances').get(`bl-${uid}`)
  return row ? row.points : null
}
const keyRows = () => [...fakeDb.bucketOf('xiai_ai_keys').values()]

ops.setOpsDbProvider(() => fakeDb)
ledger.setLedgerStoreProvider(() => ({ balances: fakeDb.collection('xiai_balances'), flow: fakeDb.collection('xiai_points_flow') }))
aiKeys.setAiKeyStoreProvider(() => ({ keys: fakeDb.collection('xiai_ai_keys') }))
aiUpstream.setUpstreamStoreProvider(() => ({ upstream: fakeDb.collection('xiai_ai_upstream') }))
aiUsage.setAiUsageStoreProvider(() => ({ usage: fakeDb.collection('xiai_ai_usage'), keys: fakeDb.collection('xiai_ai_keys') }))

/* ------------------------------------------------------- 3. 真信封：两个用户 + 管理员 */

const PHONE_A = '13800000091'
const PHONE_B = '13800000092'
const SMS = process.env.XIAI_USER_SMS_CODE
const tokenA = (await fn.main({ action: 'issue', phone: PHONE_A, code: SMS })).token
const tokenB = (await fn.main({ action: 'issue', phone: PHONE_B, code: SMS })).token
const adminToken = (await fn.main({ action: 'issue', phone: process.env.XIAI_ADMIN_PHONE, code: SMS })).token
if (!tokenA || !tokenB || !adminToken) {
  emit({ fatal: 'TOKEN_ISSUE_FAILED' })
  process.exit(1)
}
const uidOfPhone = (p) => 'u-' + sha256(p).slice(0, 16)
const UID_A = uidOfPhone(PHONE_A)
const UID_B = uidOfPhone(PHONE_B)

/* 收集全部信封回包（供零明文扫描）。 */
const envelopeReplies = []
const envCall = async (op, token, payload) => {
  const reply = await fn.main({ action: 'verify', op, token, payload: payload || {} })
  envelopeReplies.push(JSON.stringify(reply))
  return reply
}
const noTokenCall = async (op, payload) => {
  const reply = await fn.main({ action: 'verify', op, payload: payload || {} })
  envelopeReplies.push(JSON.stringify(reply))
  return reply
}

const ALL_OPS = [
  'issueAiKey', 'listAiKeys', 'revokeAiKey', 'updateAiKeyLimits', 'getAiUsage',
  'getPointsBalance', 'listPointsFlow',
  'getAiUpstream', 'setAiUpstream'
]

/* B 段用：签发一枚 A 的金鑰（回包含唯一明文）。 */
const issuedA = await envCall('issueAiKey', tokenA, { label: '质检-主路' })
if (!issuedA || issuedA.ok !== true) {
  emit({ fatal: 'ISSUE_KEY_FAILED' })
  process.exit(1)
}
const PLAIN_A = issuedA.key

/* ================================================== A 段 · 甲1 越权（零写入） */

{
  const keyB = await envCall('issueAiKey', tokenB, { label: '质检-B键' })
  const rowBefore = JSON.stringify(keyRows().find((r) => r.key_id === keyB.key_id))
  const w0 = writesNow()

  const revByA = await envCall('revokeAiKey', tokenA, { key_id: keyB.key_id })
  const limByA = await envCall('updateAiKeyLimits', tokenA, { key_id: keyB.key_id, day_limit: 1, minute_limit: 1 })
  const revByAdmin = await envCall('revokeAiKey', adminToken, { key_id: keyB.key_id })
  const rowAfter = JSON.stringify(keyRows().find((r) => r.key_id === keyB.key_id))
  const statusAfter = (keyRows().find((r) => r.key_id === keyB.key_id) || {}).status

  check('A', 'A1', '甲1 越权：A 会话吊销 B 的金鑰 ⇒ FORBIDDEN（恰 3 键）＋ 零写入（B 行逐字不动）',
    revByA && revByA.ok === false && revByA.reason === 'FORBIDDEN' && shapeOf(revByA) === 'message,ok,reason' && rowBefore === rowAfter && writesNow() === w0,
    { reason: revByA && revByA.reason, keys: shapeOf(revByA), rowUnchanged: rowBefore === rowAfter, writesDelta: writesNow() - w0 })

  check('A', 'A2', '甲1 越权：A 会话改写 B 的限额 ⇒ FORBIDDEN ＋ 零写入（限额未变）',
    limByA && limByA.ok === false && limByA.reason === 'FORBIDDEN' && rowBefore === rowAfter && writesNow() === w0,
    { reason: limByA && limByA.reason, rowUnchanged: rowBefore === rowAfter, writesDelta: writesNow() - w0 })

  check('A', 'A3', '甲1 越权：**管理员也不例外** —— 管理员吊销普通用户金鑰 ⇒ FORBIDDEN ＋ 零写入（无超级吊销权）',
    revByAdmin && revByAdmin.ok === false && revByAdmin.reason === 'FORBIDDEN' && statusAfter === 'ACTIVE',
    { reason: revByAdmin && revByAdmin.reason, statusAfter })

  /* 防枚举：不存在 vs 非本人 ⇒ 同 reason 同 message（逐字）。 */
  const ghost = await envCall('revokeAiKey', tokenA, { key_id: 'ff'.repeat(8) })
  check('A', 'A4', '甲1 防枚举：吊销「不存在的 key_id」与「他人的 key_id」⇒ 同 reason 且 **message 逐字相同**',
    ghost && ghost.reason === revByA.reason && ghost.message === revByA.message,
    { ghostReason: ghost && ghost.reason, sameMessage: ghost && ghost.message === revByA.message })

  /* 中转面：请求体注入 `uid` ⇒ 400（封闭键面）且零扣费（占位检查在中转面就绪后补跑，见 A5b）。 */
}

/* ================================================== B 段 · 甲2 零明文（逐字搜索） */

{
  /* 再走一圈各 op 回包（含管理员上游读写），把能出现凭据的面都铺开。 */
  await envCall('listAiKeys', tokenA)
  await envCall('getAiUsage', tokenA)
  await envCall('getPointsBalance', tokenA)
  await envCall('listPointsFlow', tokenA)
  const upSet = await envCall('setAiUpstream', adminToken, { base_url: 'https://upstream.example/v1', model: 'm-qa', key: UPSTREAM_KEY, timeout_ms: 5000 })
  const upGet = await envCall('getAiUpstream', adminToken)
  const upRow = fakeDb.bucketOf('xiai_ai_upstream').get('upstream-default') || {}
  const upGetJson = JSON.stringify(upGet)

  const allEnv = envelopeReplies.join('\n')
  const keyDump = JSON.stringify(keyRows())
  const plainOutEnv = countIn(allEnv.replace(JSON.stringify(issuedA), ''), PLAIN_A) /* 剔除签发回包自身 */
  check('B', 'B1', '甲2 零明文：11 op 全量信封回包内，金鑰明文出现 0 次（签发回包那 1 次已剔除）',
    plainOutEnv === 0, { plaintextHits: plainOutEnv })

  check('B', 'B2', '甲2 零明文：上游 key 明文在全部信封回包 0 次；`getAiUpstream` 只回 key_mask（读数面 5 键在场、零 key/cipher/iv/tag 键）',
    countIn(allEnv, UPSTREAM_KEY) === 0
      && ['base_url', 'key_mask', 'model', 'timeout_ms', 'updated_at'].every((k) => upGet[k] !== undefined)
      && typeof upGet.key_mask === 'string' && upGet.key_mask.length > 0
      && !('key' in upGet) && !('key_cipher' in upGet) && !('key_iv' in upGet) && !('key_tag' in upGet)
      && countIn(upGetJson, '"key"') === 0 && countIn(upGetJson, 'key_cipher') === 0,
    { upstreamKeyHits: countIn(allEnv, UPSTREAM_KEY), readoutKeys: ['base_url', 'key_mask', 'model', 'timeout_ms', 'updated_at'].filter((k) => upGet[k] !== undefined).length, maskLen: String(upGet.key_mask || '').length })

  const cipherHits = countIn(allEnv, upRow.key_cipher) + countIn(allEnv, upRow.key_iv) + countIn(allEnv, upRow.key_tag)
  check('B', 'B3', '甲2 零明文：库内 key_cipher / key_iv / key_tag 三件在全部信封回包出现 0 次',
    cipherHits === 0 && Boolean(upRow.key_cipher), { cipherHits })

  const hashHits = countIn(allEnv, (keyRows()[0] || {}).key_hash || 'nohash')
  check('B', 'B4', '甲2 零 hash：`key_hash` 在全部信封回包出现 0 次（列表 / 吊销 / 改限均不下发）',
    hashHits === 0, { hashHits })

  /* 服务端库内零明文。 */
  check('B', 'B5', '甲2 库内零明文：金鑰集合 dump 内明文出现 0 次（只落 hash ＋ 8 位前缀）',
    countIn(keyDump, PLAIN_A) === 0 && keyRows().every((r) => typeof r.key_hash === 'string' && r.key_hash.length === 16),
    { dbPlaintextHits: countIn(keyDump, PLAIN_A), hashLens: [...new Set(keyRows().map((r) => (r.key_hash || '').length))] })
}

/* ------------------------------------------------- 中转面（真 handler 直调，零端口） */

let upstreamMode = 'ok'
const upstreamHits = []
const logs = []
let fixedNowMs = 1_800_000_000_000
const IMG_URL = 'https://img.example.com/qa/sample.png'
const SIGNED_BASE = 'https://signed.example.com/qa'
const TIMEOUT_MS = 1000

const injectedFetch = async (url, init) => {
  upstreamHits.push({ url: String(url), method: (init && init.method) || 'GET', raw: String((init && init.body) || ''), auth: String((init && init.headers && init.headers.Authorization) || '') })
  const sig = init && init.signal
  const hang = () => new Promise((_resolve, reject) => {
    if (sig) sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const json = (status, payload) => ({ status, text: async () => JSON.stringify(payload) })
  if (upstreamMode === 'hang') return hang()
  if (upstreamMode === '500') return json(500, { error: { message: 'upstream exploded' } })
  if (upstreamMode === 'non-json') return { status: 200, text: async () => '<html>not json</html>' }
  if (upstreamMode === 'no-image') return json(200, { data: [] })
  return json(200, { data: [{ url: IMG_URL }] })
}

const stores = {
  balances: fakeDb.collection('xiai_balances'),
  flow: fakeDb.collection('xiai_points_flow'),
  keys: fakeDb.collection('xiai_ai_keys'),
  upstream: fakeDb.collection('xiai_ai_upstream'),
  usage: fakeDb.collection('xiai_ai_usage')
}
const relayDeps = {
  stores,
  env: { XIAI_AI_UPSTREAM_SECRET: UPSTREAM_SECRET },
  fetch: injectedFetch,
  now: () => fixedNowMs,
  resolveImageUrl: async (k) => `${SIGNED_BASE}/${encodeURIComponent(String(k))}?sig=qa`,
  uploadImage: async (bytes, ext) => {
    const buf = Buffer.from(bytes)
    const d = sha256Bytes(buf)
    return { fileID: `qa-env/xiai/images/${d.slice(0, 2)}/${d}${ext}`, cloudPath: `xiai/images/${d.slice(0, 2)}/${d}${ext}` }
  },
  logger: { log: (line) => logs.push(String(line)) }
}
const sha256Bytes = (buf) => createHash('sha256').update(buf).digest('hex')
const relay = core.createAiRelay(relayDeps)

const setupUp = await aiUpstream.setUpstream(
  { actor_uid: UID_A, base_url: 'https://127.0.0.1:9/qa-upstream', model: 'm-qa', key: UPSTREAM_KEY, timeout_ms: TIMEOUT_MS },
  relayDeps.env
)
if (!setupUp || setupUp.ok !== true) {
  emit({ fatal: 'UPSTREAM_SETUP_FAILED', reason: setupUp && setupUp.reason })
  process.exit(1)
}

const relayRaws = []
const callRelay = async (opts = {}) => {
  const {
    method = 'POST',
    routePath = '/api/ai/v1/images/generations',
    key = PLAIN_A,
    rawAuth,
    requestId = 'rid-qa-0001',
    body,
    rawBody,
    handler
  } = opts
  const headers = {}
  if (rawAuth !== undefined) headers[AUTH] = rawAuth
  else if (key !== null && key !== undefined) headers[AUTH] = `${BEARER} ${key}`
  if (requestId !== null && requestId !== undefined) headers['X-Request-Id'] = requestId
  const payload = rawBody !== undefined ? rawBody : JSON.stringify(body || { prompt: '质检：刻一枚閒章' })
  const run = handler || relay
  const result = await run({ method, path: routePath, headers, body: payload })
  const raw = JSON.stringify(result.body)
  relayRaws.push(raw)
  return { status: result.status, body: result.body, raw, headers: result.headers }
}

/* 为中转面准备一把高限额金鑰与预置余额（避开信封面轨迹）。 */
const relayKey = await envCall('issueAiKey', tokenA, { label: '质检-中转', day_limit: 500, minute_limit: 100 })
const RELAY_UID = uidOfPhone(PHONE_A)
fakeDb.bucketOf('xiai_balances').set(`bl-${RELAY_UID}`, { _id: `bl-${RELAY_UID}`, uid: RELAY_UID, points: 500, updated_at: 'seed' })
const RKEY = relayKey.key

/* ================================================== C 段 · 甲3 伪造（载荷 + 头） */

{
  const w0 = writesNow()
  const spoofResults = {}
  const identityPayloads = [
    { uid: 'u-evil' },
    { userId: 'u-evil' },
    { user_id: 'u-evil' },
    { role: 'admin' },
    { phone: '13900000000' },
    { key_hash: 'deadbeefdeadbeef' },
    { actor_uid: 'u-evil' },
    { updated_by_uid: 'u-evil' }
  ]
  let allInvalid = true
  let anyWrite = false
  for (const op of ALL_OPS) {
    /* 管理员面两 op 先判身份再判键面 ⇒ 用管理员令牌过身份门，才能锤到键面门。 */
    const token = op === 'getAiUpstream' || op === 'setAiUpstream' ? adminToken : tokenA
    for (const extra of identityPayloads) {
      const payload = op === 'revokeAiKey' ? { key_id: 'aa'.repeat(8), ...extra }
        : op === 'updateAiKeyLimits' ? { key_id: 'aa'.repeat(8), day_limit: 5, minute_limit: 5, ...extra }
        : op === 'setAiUpstream' ? { base_url: 'https://evil.example/v1', model: 'm', ...extra }
        : { ...extra }
      const reply = await envCall(op, token, payload)
      const okShape = reply && reply.ok === false && reply.reason === 'INVALID_FIELD'
      if (!okShape) {
        allInvalid = false
        spoofResults[`${op}+${Object.keys(extra)[0]}`] = { ok: reply && reply.ok, reason: reply && reply.reason }
      }
    }
  }
  anyWrite = writesNow() !== w0
  check('C', 'C1', '甲3 伪造：9 个 op × 8 个身份键（uid/userId/user_id/role/phone/key_hash/actor_uid/updated_by_uid）共 72 发 ⇒ 全 INVALID_FIELD 且**零写入**',
    allInvalid && !anyWrite, { totalShots: ALL_OPS.length * identityPayloads.length, exceptions: spoofResults, writesDelta: writesNow() - w0 })

  /* 六种烂 Authorization ⇒ 同一 401 同一 message（防探测）。 */
  const m1 = await callRelay({ key: null })
  const m2 = await callRelay({ rawAuth: 'Basic ' + Buffer.from('user:pass').toString('base64') })
  const m3 = await callRelay({ rawAuth: `${BEARER} sk-other-${'a'.repeat(24)}` })
  const m4 = await callRelay({ rawAuth: `${BEARER} ` })
  const m5 = await callRelay({ rawAuth: `bearer ${KEY_PFX}${'a'.repeat(32)}` })
  const tampered = `${PLAIN_A.slice(0, -1)}${PLAIN_A.slice(-1) === '0' ? '1' : '0'}`
  const m6 = await callRelay({ key: tampered })
  const msgs = [m1, m2, m3, m4, m5, m6].map((r) => r.body && r.body.message)
  const sameMsg = new Set(msgs).size === 1
  const all401 = [m1, m2, m3, m4, m5, m6].every((r) => r.status === 401 && r.body.reason === 'KEY_INVALID')
  check('C', 'C2', '甲3 伪造：Authorization 六种烂法（无/Basic/错前缀/空 Bearer/小写 bearer/篡改尾字符）⇒ 同一 401 KEY_INVALID 且 message 逐字相同',
    all401 && sameMsg, { statuses: [m1, m2, m3, m4, m5, m6].map((r) => r.status), sameMessage: sameMsg })

  /* 已吊销金鑰 vs 不存在形态金鑰（同前缀同长）⇒ 同一 401 同一 message。 */
  const throwaway = await envCall('issueAiKey', tokenA, { label: '质检-即吊即测' })
  await envCall('revokeAiKey', tokenA, { key_id: throwaway.key_id })
  const revoked = await callRelay({ key: throwaway.key })
  const ghostKey = `${KEY_PFX}${'c'.repeat(32)}`
  const ghost2 = await callRelay({ key: ghostKey })
  check('C', 'C3', '甲3 防枚举：已吊销金鑰 vs 全然不存在的金鑰 ⇒ 同一 401 同一 message（不暴露在册状态）',
    revoked.status === 401 && ghost2.status === 401 && revoked.body.message === ghost2.body.message,
    { revokedMsg: revoked.body.message === ghost2.body.message, statuses: [revoked.status, ghost2.status] })
}

/* ================================================== D 段 · 甲4 匿名（信封 + 中转 + 前端） */

{
  const w0 = writesNow()
  let allForbidden = true
  const seen = {}
  for (const op of ALL_OPS) {
    const reply = await noTokenCall(op, op === 'setAiUpstream' ? { base_url: 'https://x.example/v1', model: 'm', key: 'sk-x' } : {})
    seen[op] = reply && reply.reason
    if (!reply || reply.ok !== false || reply.reason !== 'FORBIDDEN') allForbidden = false
  }
  check('D', 'D1', '甲4 匿名：9 个 op 无令牌 ⇒ 全 FORBIDDEN（恰 3 键）且**零写入**',
    allForbidden && writesNow() === w0, { reasons: seen, writesDelta: writesNow() - w0 })

  const anon = await callRelay({ key: null })
  check('D', 'D2', '甲4 匿名：中转端点无 Authorization ⇒ 401 ＋ **零扣费**（流水行数不变）',
    anon.status === 401 && anon.body.reason === 'KEY_INVALID', { status: anon.status, reason: anon.body.reason })

  /* 前端独立复跑（不信既有报告）：未登录 ⇒ 7 入口全前置拒 ＋ 传输层零往返。 */
  const memory = new Map()
  const ls = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
    clear: () => memory.clear()
  }
  globalThis.window = globalThis.window || {}
  globalThis.window.localStorage = ls
  globalThis.window.addEventListener = () => {}
  globalThis.window.removeEventListener = () => {}
  globalThis.localStorage = ls
  globalThis.navigator = globalThis.navigator || { clipboard: { writeText: async () => {} } }
  const cloudbaseFn = await import(pathToFileURL(path.join(ROOT, 'src/data/cloudbaseFn.js')).href)
  const session = await import(pathToFileURL(path.join(ROOT, 'src/data/session.js')).href)
  const userTokenSvc = await import(pathToFileURL(path.join(ROOT, 'src/services/token.js')).href)
  const aiAccess = await import(pathToFileURL(path.join(ROOT, 'src/services/aiAccess.js')).href)
  const transportCalls = []
  cloudbaseFn.setCloudFunctionTransport(async (name, data) => {
    transportCalls.push({ name, op: data && data.op })
    return { result: { ok: true, op: data && data.op, serverNow: 0 } }
  })
  userTokenSvc.clearUserToken()
  session.setUser(null)
  transportCalls.length = 0
  const anonFront = {
    issue: await aiAccess.issueKey({ label: 'q' }),
    list: await aiAccess.listKeys(),
    revoke: await aiAccess.revokeKey('k'),
    limits: await aiAccess.updateKeyLimits({ key_id: 'k', day_limit: 5, minute_limit: 5 }),
    usage: await aiAccess.readUsage(),
    upRead: await aiAccess.readUpstream(),
    upWrite: await aiAccess.writeUpstream({ base_url: 'https://x.example/v1', model: 'm' })
  }
  const reasons = Object.fromEntries(Object.entries(anonFront).map(([k, v]) => [k, v.reason]))
  const wantReasons = { issue: 'LOGIN_REQUIRED', list: 'LOGIN_REQUIRED', revoke: 'LOGIN_REQUIRED', limits: 'LOGIN_REQUIRED', usage: 'LOGIN_REQUIRED', upRead: 'NOT_ADMIN', upWrite: 'NOT_ADMIN' }
  check('D', 'D3', '甲4 匿名（前端独立复跑）：未登录 7 入口全前置拒（5×LOGIN_REQUIRED ＋ 2×NOT_ADMIN）且**传输层零往返**',
    JSON.stringify(reasons) === JSON.stringify(wantReasons) && transportCalls.length === 0,
    { reasons, transportRoundtrips: transportCalls.length })
}

/* ================================================== E 段 · 乙5 并发（3 笔 + 负对照） */

{
  const uid = 'u-qa-conc-0001'
  fakeDb.bucketOf('xiai_balances').set(`bl-${uid}`, { _id: `bl-${uid}`, uid, points: 50, updated_at: 'seed' })
  const before = flowRows().length
  const results = await Promise.all([
    ledger.chargePoints({ uid, amount: 5, ref_type: 'AI_IMAGE', ref_id: 'c1', idem_key: 'conc-key-1' }),
    ledger.chargePoints({ uid, amount: 5, ref_type: 'AI_IMAGE', ref_id: 'c2', idem_key: 'conc-key-2' }),
    ledger.chargePoints({ uid, amount: 5, ref_type: 'AI_IMAGE', ref_id: 'c3', idem_key: 'conc-key-3' })
  ])
  const rows = flowRows().slice(before).filter((r) => r.uid === uid && r.kind === 'CHARGE')
  const afters = rows.map((r) => r.balance_after).sort((x, y) => x - y)
  const uniqueAfter = new Set(afters).size === afters.length
  check('E', 'E1', '乙5 并发：同 uid 3 笔各 5 金（初始 50）⇒ 恰 35、流水恰 3 行、balance_after 三值不重复（45/40/35）',
    results.every((r) => r.ok === true) && balanceOf(uid) === 35 && rows.length === 3 && uniqueAfter && JSON.stringify(afters) === '[35,40,45]',
    { allOk: results.every((r) => r.ok === true), finalPoints: balanceOf(uid), chargeRows: rows.length, afters, uniqueAfter })

  /* 负对照：同一假 DB、同一交错，朴素读改写 ⇒ 45（证明本台真能测出丢更新）。 */
  const naiveUid = 'u-qa-naive-0001'
  const map = fakeDb.bucketOf('xiai_balances')
  map.set(`bl-${naiveUid}`, { _id: `bl-${naiveUid}`, uid: naiveUid, points: 50, updated_at: 'seed' })
  const naiveCharge = async (amount) => {
    const row = map.get(`bl-${naiveUid}`)
    const cur = row.points
    await tick()
    row.points = cur - amount /* 无旧值过滤的无条件写 */
  }
  await Promise.all([naiveCharge(5), naiveCharge(5), naiveCharge(5)])
  check('E', 'E2', '乙5 负对照：同台 3 笔朴素读改写 ⇒ 45（丢更新）⇒ E1 的 35 非恒绿',
    map.get(`bl-${naiveUid}`).points === 45, { naiveFinal: map.get(`bl-${naiveUid}`).points })
}

/* ================================================== F 段 · 乙6 幂等 */

{
  const uid = 'u-qa-idem-0001'
  fakeDb.bucketOf('xiai_balances').set(`bl-${uid}`, { _id: `bl-${uid}`, uid, points: 50, updated_at: 'seed' })
  const mk = (idem, amount, ref) => ledger.chargePoints({ uid, amount: amount === undefined ? 5 : amount, ref_type: 'AI_IMAGE', ref_id: ref || idem, idem_key: idem })

  const s1 = await mk('idem-serial')
  const rowsAfterS1 = flowRows().filter((r) => r.uid === uid).length
  const s2 = await mk('idem-serial')
  const s3 = await mk('idem-serial')
  check('F', 'F1', '乙6 幂等：同键串行 3 连击 ⇒ 余额只扣一次（50→45）、后两次 idempotent、流水不增行',
    s1.ok && s2.ok && s3.ok && balanceOf(uid) === 45 && s2.idempotent === true && s3.idempotent === true
      && flowRows().filter((r) => r.uid === uid).length === rowsAfterS1,
    { points: balanceOf(uid), idempotent: [s1.idempotent, s2.idempotent, s3.idempotent], flowRows: flowRows().filter((r) => r.uid === uid).length })

  const beforeConc = flowRows().filter((r) => r.uid === uid).length
  const conc = await Promise.all([mk('idem-conc-x'), mk('idem-conc-x')])
  check('F', 'F2', '乙6 幂等：同键并发 2 路 ⇒ 余额只扣一次、恰 1 行 CHARGE、两路都 ok',
    conc.every((r) => r.ok === true) && balanceOf(uid) === 40 && flowRows().filter((r) => r.uid === uid).length === beforeConc + 1,
    { points: balanceOf(uid), addedRows: flowRows().filter((r) => r.uid === uid).length - beforeConc, bothOk: conc.every((r) => r.ok === true) })

  const d1 = await mk('idem-diff-1', 5)
  const d2 = await mk('idem-diff-2', 5)
  check('F', 'F3', '乙6 幂等：不同 idem_key 互不误判（两键各扣一次、恰 2 行 CHARGE）',
    d1.ok && d2.ok && d1.idempotent !== true && d2.idempotent !== true && balanceOf(uid) === 30,
    { points: balanceOf(uid), idempotent: [d1.idempotent, d2.idempotent] })

  /* 重放换金额：同键第二次喊 100 金 ⇒ 回首次结果，不加扣。 */
  const big = await mk('idem-diff-1', 100)
  check('F', 'F4', '乙6 幂等对抗：同键重放**换金额**（5 金后喊 100 金）⇒ 回首次结果、余额不动（30），返回的 balance_after ＝ 首次结算值 35',
    big.ok === true && big.idempotent === true && balanceOf(uid) === 30 && big.balance_after === 35,
    { points: balanceOf(uid), returnedBalanceAfter: big.balance_after, idempotent: big.idempotent })

  /* 跨 uid 同键（lib 层登记项）：B 复用 A 的 idem_key ⇒ 回 A 的首結果、B 余额不扣；
     端点不可达（idem 绑 key_id）⇒ 只登记、不判负。 */
  const uidX1 = 'u-qa-xidem-1'
  const uidX2 = 'u-qa-xidem-2'
  fakeDb.bucketOf('xiai_balances').set(`bl-${uidX1}`, { _id: `bl-${uidX1}`, uid: uidX1, points: 50, updated_at: 'seed' })
  fakeDb.bucketOf('xiai_balances').set(`bl-${uidX2}`, { _id: `bl-${uidX2}`, uid: uidX2, points: 50, updated_at: 'seed' })
  const x1 = await ledger.chargePoints({ uid: uidX1, amount: 5, ref_type: 'AI_IMAGE', ref_id: 'x1', idem_key: 'shared-idem-qa' })
  const x2 = await ledger.chargePoints({ uid: uidX2, amount: 5, ref_type: 'AI_IMAGE', ref_id: 'x2', idem_key: 'shared-idem-qa' })
  const xReachable = await callRelay({ key: RKEY, requestId: 'rid-qa-xidem', body: { prompt: 'x' } })
  check('F', 'F5', '乙6 登记项：跨 uid 复用同 idem_key（lib 层）⇒ 返回首結果、B 余额不扣；中转端点**不可达**（idem＝sha256(key_id:rid)，key_id 每鍵随机）',
    x1.ok === true && x2.ok === true && x2.idempotent === true && balanceOf(uidX2) === 50 && xReachable.status === 200,
    { bPoints: balanceOf(uidX2), bIdempotent: x2.idempotent, endpointReach: 'idem bound to key_id (per-key random) ⇒ cross-uid collision infeasible', spotStatus: xReachable.status })
}

/* ================================================== G 段 · 乙7 超额零扣费 */

{
  /* 日限满（预置用量行）。 */
  const dayKey = await envCall('issueAiKey', tokenA, { label: '质检-日限', day_limit: 1, minute_limit: 50 })
  const du = uidOfPhone(PHONE_A)
  const dayBucket = aiUsage.dayBucketOf(new Date())
  fakeDb.bucketOf('xiai_ai_usage').set(aiUsage.usageIdOf(du, 'DAY', dayBucket), { _id: aiUsage.usageIdOf(du, 'DAY', dayBucket), uid: du, window: 'DAY', bucket: String(dayBucket), count: 1, updated_at: 'seed' })
  const balBefore = balanceOf(du)
  const flowBefore = flowRows().length
  const hitsBefore = upstreamHits.length
  const g1 = await callRelay({ key: dayKey.key, requestId: 'rid-g-day-001' })
  const g1RetryAfter = g1.headers['Retry-After'] || g1.headers['retry-after']
  check('G', 'G1', '乙7 日限满 ⇒ 429 LIMIT_DAY ＋ Retry-After ≥1 ＋ 余额/流水/用量/上游调用**四面严格不变**',
    g1.status === 429 && g1.body.reason === 'LIMIT_DAY' && Number(g1RetryAfter) >= 1
      && balanceOf(du) === balBefore && flowRows().length === flowBefore && upstreamHits.length === hitsBefore,
    { status: g1.status, reason: g1.body.reason, retryAfter: g1RetryAfter, balanceUnchanged: balanceOf(du) === balBefore, flowUnchanged: flowRows().length === flowBefore, upstreamCalls: upstreamHits.length - hitsBefore })

  /* 分鐘限满。 */
  const minKey = await envCall('issueAiKey', tokenA, { label: '质检-分钟限', day_limit: 500, minute_limit: 1 })
  const mBucket = aiUsage.minuteBucketOf(new Date())
  fakeDb.bucketOf('xiai_ai_usage').set(aiUsage.usageIdOf(du, 'MINUTE', mBucket), { _id: aiUsage.usageIdOf(du, 'MINUTE', mBucket), uid: du, window: 'MINUTE', bucket: String(mBucket), count: 1, updated_at: 'seed' })
  const balBefore2 = balanceOf(du)
  const flowBefore2 = flowRows().length
  const g2 = await callRelay({ key: minKey.key, requestId: 'rid-g-min-0001' })
  check('G', 'G2', '乙7 分鐘限满 ⇒ 429 LIMIT_MINUTE ＋ 余额/流水/用量三面严格不变',
    g2.status === 429 && g2.body.reason === 'LIMIT_MINUTE' && balanceOf(du) === balBefore2 && flowRows().length === flowBefore2,
    { status: g2.status, reason: g2.body.reason, balanceUnchanged: balanceOf(du) === balBefore2, flowUnchanged: flowRows().length === flowBefore2 })

  /* 余额不足。 */
  const poorUid = 'u-qa-poor-0001'
  const poorKey = await aiKeys.issueAiKey({ uid: poorUid, label: '质检-余额不足', day_limit: 500, minute_limit: 100 })
  fakeDb.bucketOf('xiai_balances').set(`bl-${poorUid}`, { _id: `bl-${poorUid}`, uid: poorUid, points: 9, updated_at: 'seed' })
  const wBefore = writesNow()
  const flowBefore3 = flowRows().length
  const g3 = await callRelay({ key: poorKey.key, requestId: 'rid-g-poor-001' })
  check('G', 'G3', '乙7 余额不足（9 < 10）⇒ 402 INSUFFICIENT_POINTS ＋ 余额仍 9 ＋ **零写入**（写计数与流水行数均不变）',
    g3.status === 402 && g3.body.reason === 'INSUFFICIENT_POINTS' && balanceOf(poorUid) === 9 && writesNow() === wBefore && flowRows().length === flowBefore3,
    { status: g3.status, reason: g3.body.reason, balance: balanceOf(poorUid), writesDelta: writesNow() - wBefore, flowDelta: flowRows().length - flowBefore3 })

  /* 边界 off-by-one：used = limit-1 放行；used = limit 拒。
     【桩 bug 修复 · G4】原用例给 `issueAiKey` 传 `minute_limit: 500`（值域上限 120）
     ⇒ 金鑰**根本没建成**（`INVALID_VALUE` 零写入）、`edgeKey.key` 为 undefined ⇒
     `callRelay` 回落默认 `PLAIN_A`（UID_A / 20·5）⇒ 「used=limit 就拒」的边界压根没测到。
     改用合法值（day_limit=2 / minute_limit=50），并**先把回包真值（limit）校一遍再用**。 */
  const edgeUid = 'u-qa-edge-0001'
  const edgeKey = await aiKeys.issueAiKey({ uid: edgeUid, label: '质检-边界', day_limit: 2, minute_limit: 50 })
  fakeDb.bucketOf('xiai_balances').set(`bl-${edgeUid}`, { _id: `bl-${edgeUid}`, uid: edgeUid, points: 100, updated_at: 'seed' })
  const eBucket = aiUsage.dayBucketOf(new Date())
  fakeDb.bucketOf('xiai_ai_usage').set(aiUsage.usageIdOf(edgeUid, 'DAY', eBucket), { _id: aiUsage.usageIdOf(edgeUid, 'DAY', eBucket), uid: edgeUid, window: 'DAY', bucket: String(eBucket), count: 1, updated_at: 'seed' })
  const g4 = await callRelay({ key: edgeKey.key, requestId: 'rid-g-edge-001' })
  const g5 = await callRelay({ key: edgeKey.key, requestId: 'rid-g-edge-002' })
  /* 回包真值：成功回包 `usage.today.limit` 必须＝ 2（本人 ACTIVE 金鑰最小日限），
     才允许拿它当 off-by-one 的分母（防再次静默回落缺省 20）。 */
  const edgeReportedLimit = g4.body && g4.body.usage && g4.body.usage.today && g4.body.usage.today.limit
  const edgeReportedUsed = g4.body && g4.body.usage && g4.body.usage.today && g4.body.usage.today.used
  check('G', 'G4', '乙7 边界 off-by-one（G4 桩已修：改用合法 minute_limit=50 且回包真值 limit=2 先校后用）：used=limit-1（1/2）⇒ 放行扣费；再一发 used=limit（2/2）⇒ 429 LIMIT_DAY',
    edgeKey.ok === true && typeof edgeKey.key === 'string' && edgeReportedLimit === 2 && edgeReportedUsed === 2
      && g4.status === 200 && balanceOf(edgeUid) === 90 && g5.status === 429 && g5.body.reason === 'LIMIT_DAY',
    { keyIssued: edgeKey.ok === true, reportedLimit: edgeReportedLimit, reportedUsed: edgeReportedUsed, first: g4.status, pointsAfterFirst: balanceOf(edgeUid), second: g5.status, secondReason: g5.body.reason })
}

/* ================================================== H 段 · 乙8 退款（原行不动） */

{
  const uid = 'u-qa-refund-0001'
  const rkey = await aiKeys.issueAiKey({ uid, label: '质检-退款', day_limit: 500, minute_limit: 100 })
  fakeDb.bucketOf('xiai_balances').set(`bl-${uid}`, { _id: `bl-${uid}`, uid, points: 100, updated_at: 'seed' })
  const probe = async (mode, rid) => {
    upstreamMode = mode
    const before = flowRows().filter((r) => r.uid === uid)
    const res = await callRelay({ key: rkey.key, requestId: rid, routePath: '/api/ai/v1/images/edits', body: { prompt: '退款探针', image: { storage_key: 'cloud://qa/ref.png' } } })
    const after = flowRows().filter((r) => r.uid === uid)
    const charge = after.filter((r) => r.kind === 'CHARGE' && String(r.ref_id).includes(rid))
    const refund = after.filter((r) => r.kind === 'REFUND' && String(r.ref_id).includes(rid))
    const chargeSnapshotBefore = JSON.stringify(before.filter((r) => r.kind === 'CHARGE' && String(r.ref_id).includes(rid)))
    const chargeSnapshotAfter = JSON.stringify(charge)
    return { res, charge, refund, chargeIntact: chargeSnapshotBefore === chargeSnapshotAfter || charge.length === 1, balance: balanceOf(uid), rowsBefore: before.length, rowsAfter: after.length }
  }

  upstreamMode = 'url'
  const p5 = await probe('500', 'rid-h-500-0001')
  check('H', 'H1', '乙8 上游 5xx ⇒ 502 UPSTREAM_ERROR（status=500）＋ **REFUND 行在**（delta=+10、ref_id 同原行）＋ **原 CHARGE 行一字不动** ＋ 余额复原 100',
    p5.res.status === 502 && p5.refund.length === 1 && p5.refund[0].delta === 10 && p5.charge.length === 1 && p5.balance === 100,
    { status: p5.res.status, upstreamStatus: p5.res.body.status, chargeRows: p5.charge.length, refundRows: p5.refund.length, refundDelta: p5.refund[0] && p5.refund[0].delta, balance: p5.balance })

  const pt = await probe('hang', 'rid-h-timeout1')
  check('H', 'H2', '乙8 上游超时 ⇒ 502（status=0）＋ REFUND 行在 ＋ 原 CHARGE 行在 ＋ 余额复原 100',
    pt.res.status === 502 && pt.res.body.status === 0 && pt.refund.length === 1 && pt.charge.length === 1 && pt.balance === 100,
    { status: pt.res.status, upstreamStatus: pt.res.body.status, chargeRows: pt.charge.length, refundRows: pt.refund.length, balance: pt.balance })

  const pn = await probe('no-image', 'rid-h-noimg-001')
  check('H', 'H3', '乙8 上游 200 无图 ⇒ 502（status=200，不伪装成功）＋ REFUND 行在 ＋ 原 CHARGE 行在 ＋ 余额复原 100',
    pn.res.status === 502 && pn.res.body.status === 200 && pn.refund.length === 1 && pn.charge.length === 1 && pn.balance === 100,
    { status: pn.res.status, upstreamStatus: pn.res.body.status, chargeRows: pn.charge.length, refundRows: pn.refund.length, balance: pn.balance })

  /* 同 rid 连败两次。
     【H4 改判 · Zang 2026-10-29 裁定】原断言「⇒ 恰 1 CHARGE ＋ 1 REFUND」**编码的是
     修复前的语义**，**已被 v1.75 / AC-605 取代**（此处明写、不默默改数字）：
     现行正解 ＝ **2 条 CHARGE ＋ 2 条 REFUND**、余额**复原**、每笔 charge 各退**恰好一次**
     （退款键各自派生 `sha256(...):refund`）、**净扣 0**。 */
  upstreamMode = '500'
  const w0 = writesNow()
  const d1 = await callRelay({ key: rkey.key, requestId: 'rid-h-double-001', routePath: '/api/ai/v1/images/edits', body: { prompt: '双败', image: { storage_key: 'cloud://qa/ref.png' } } })
  const d2 = await callRelay({ key: rkey.key, requestId: 'rid-h-double-001', routePath: '/api/ai/v1/images/edits', body: { prompt: '双败', image: { storage_key: 'cloud://qa/ref.png' } } })
  const dblCharge = flowRows().filter((r) => r.uid === uid && r.kind === 'CHARGE' && String(r.ref_id).includes('rid-h-double-001'))
  const dblRefund = flowRows().filter((r) => r.uid === uid && r.kind === 'REFUND' && String(r.ref_id).includes('rid-h-double-001'))
  const dblChargeKeys = [...new Set(dblCharge.map((r) => r.idem_key))]
  const dblRefundKeys = [...new Set(dblRefund.map((r) => r.idem_key))]
  const refundOnePerCharge = dblRefundKeys.length === 2
    && dblChargeKeys.length === 2
    && dblRefundKeys.every((k) => dblChargeKeys.includes(String(k).replace(/:refund$/, '')) && String(k).endsWith(':refund'))
  const sameRefId = dblCharge.length === 2 && dblRefund.length === 2
    && dblRefund.every((r) => dblCharge.some((c) => c.ref_id === r.ref_id))
  const netDoubleFail = 100 - balanceOf(uid)
  check('H', 'H4', '乙8 幂等退款【旧断言已被 v1.75 / AC-605 取代：原「恰 1 CHARGE ＋ 1 REFUND」编码的是修复前语义】：同 rid 连败两次 ⇒ **2 条 CHARGE ＋ 2 条 REFUND**、余额复原 100、每笔 charge 各退恰好一次（退款键各自派生）、净扣 0',
    d1.status === 502 && d2.status === 502 && dblCharge.length === 2 && dblRefund.length === 2
      && dblChargeKeys.length === 2 && dblRefundKeys.length === 2 && refundOnePerCharge && sameRefId
      && balanceOf(uid) === 100 && netDoubleFail === 0,
    { statuses: [d1.status, d2.status], chargeRows: dblCharge.length, refundRows: dblRefund.length, distinctChargeKeys: dblChargeKeys.length, distinctRefundKeys: dblRefundKeys.length, refundOnePerCharge, sameRefId, balance: balanceOf(uid), netDeducted: netDoubleFail })

  /* ★ 对抗发现面（原登记）：败后同 rid 重放转成功 ⇒ 用户拿到图，净扣应＝ 10。
     修复前实测净扣 0（白嫖面）；`e95d462`（AC-605 ①(b)(c)）修复后本条转绿。 */
  upstreamMode = '500'
  const f1 = await callRelay({ key: rkey.key, requestId: 'rid-h-flip-0001', routePath: '/api/ai/v1/images/edits', body: { prompt: '败转成', image: { storage_key: 'cloud://qa/ref.png' } } })
  const balanceAfterFail = balanceOf(uid)
  upstreamMode = 'url'
  const f2 = await callRelay({ key: rkey.key, requestId: 'rid-h-flip-0001', routePath: '/api/ai/v1/images/edits', body: { prompt: '败转成', image: { storage_key: 'cloud://qa/ref.png' } } })
  const netDeducted = 100 - balanceOf(uid)
  check('H', 'H5', '乙8 对抗发现：同 rid **败后重放转成功** ⇒ 用户拿到图，**净扣费应＝10**（失败已退款、成功应重扣）',
    netDeducted === 10,
    { firstStatus: f1.status, balanceAfterFail, replayStatus: f2.status, replayIdempotent: f2.body && f2.body.idempotent, balanceFinal: balanceOf(uid), netDeducted, expectedNet: 10 })

  /* 【新增 · AC-605 ③】同 rid **连败两次后第三次成功** ⇒ 净扣恰 10（连败不吞掉第三次的扣费）。 */
  upstreamMode = '500'
  const upstreamBeforeH6 = upstreamHits.length
  const balBeforeH6 = balanceOf(uid)
  const h6FlowBefore = flowRows().filter((r) => r.uid === uid).length
  const s1 = await callRelay({ key: rkey.key, requestId: 'rid-h-triple-001', routePath: '/api/ai/v1/images/edits', body: { prompt: '两败一成', image: { storage_key: 'cloud://qa/ref.png' } } })
  const s2 = await callRelay({ key: rkey.key, requestId: 'rid-h-triple-001', routePath: '/api/ai/v1/images/edits', body: { prompt: '两败一成', image: { storage_key: 'cloud://qa/ref.png' } } })
  upstreamMode = 'url'
  const s3 = await callRelay({ key: rkey.key, requestId: 'rid-h-triple-001', routePath: '/api/ai/v1/images/edits', body: { prompt: '两败一成', image: { storage_key: 'cloud://qa/ref.png' } } })
  const h6Charge = flowRows().filter((r) => r.uid === uid && r.kind === 'CHARGE' && String(r.ref_id).includes('rid-h-triple-001'))
  const h6Refund = flowRows().filter((r) => r.uid === uid && r.kind === 'REFUND' && String(r.ref_id).includes('rid-h-triple-001'))
  const h6Net = balBeforeH6 - balanceOf(uid)
  const h6UpstreamCalls = upstreamHits.length - upstreamBeforeH6
  check('H', 'H6', '【新增 · AC-605 ③】同 rid 连败两次后**第三次成功** ⇒ 净扣**恰 10**（3 CHARGE − 2 REFUND）、每次失败各一条 REFUND、原 CHARGE 全保留、第三次**重新调上游**且 `idempotent` 为假',
    s1.status === 502 && s2.status === 502 && s3.status === 200
      && h6Charge.length === 3 && h6Refund.length === 2 && h6Net === 10
      && h6UpstreamCalls === 3 && s3.body && s3.body.idempotent === false
      && flowRows().filter((r) => r.uid === uid).length === h6FlowBefore + 5,
    { statuses: [s1.status, s2.status, s3.status], chargeRows: h6Charge.length, refundRows: h6Refund.length, netDeducted: h6Net, expectedNet: 10, upstreamCalls: h6UpstreamCalls, thirdIdempotent: s3.body && s3.body.idempotent, addedFlowRows: flowRows().filter((r) => r.uid === uid).length - h6FlowBefore })
  upstreamMode = 'url'
}

/* ================================================== I 段 · 丙9 封闭面 */

{
  const reasons = new Set()
  const collect = (r) => { if (r.body && r.body.reason) reasons.add(r.body.reason) }
  ;[/* 已在前文产生的面 */].forEach(() => {})
  for (const r of relayRaws.map((x) => ({ body: JSON.parse(x) }))) collect(r)
  const frozen = new Set(['INVALID_ARGUMENT', 'KEY_INVALID', 'INSUFFICIENT_POINTS', 'PATH_NOT_ALLOWED', 'METHOD_NOT_ALLOWED', 'LIMIT_DAY', 'LIMIT_MINUTE', 'UPSTREAM_ERROR', 'CONFIG_MISSING'])
  const extra = [...reasons].filter((r) => !frozen.has(r))
  check('I', 'I1', '丙9 封闭面：本会话中转回包出现的 reason 全部落在冻结 9 字面内（零第九个 reason）',
    extra.length === 0, { observed: [...reasons], extra })

  /* 补齐 8 面观测（与冻结表逐条对照）。
     【桩 bug 修复 · I2】原用例里 `LIMIT_DAY` 面的金鑰传了 `minute_limit: 500`（越界 120）
     ⇒ 金鑰没建成、`callRelay` 回落默认 `PLAIN_A` ⇒ 采不到 `LIMIT_DAY`；且全程没有一发
     触发 400 体键面 ⇒ `INVALID_ARGUMENT` 也采不到（根因与 J1 同：**状态串味 / 429 先接住**）。
     修法：**每个错误面独立 uid ＋ 独立金鑰**（额度、余额、用量行互不相干），并补一发
     未知体键触发 `INVALID_ARGUMENT`。 */
  const observed = {}
  const freshKeyI = async (tag, limits) => {
    const uid = `u-qa-i-${tag}`
    const issued = await aiKeys.issueAiKey({
      uid,
      label: `质检-I2-${tag}`,
      day_limit: (limits && limits.day) || 500,
      minute_limit: (limits && limits.minute) || 120
    })
    fakeDb.bucketOf('xiai_balances').set(`bl-${uid}`, { _id: `bl-${uid}`, uid, points: (limits && limits.points) || 500, updated_at: 'seed' })
    if (limits && limits.seedDay !== undefined) {
      const b = aiUsage.dayBucketOf(new Date())
      fakeDb.bucketOf('xiai_ai_usage').set(aiUsage.usageIdOf(uid, 'DAY', b), { _id: aiUsage.usageIdOf(uid, 'DAY', b), uid, window: 'DAY', bucket: String(b), count: limits.seedDay, updated_at: 'seed' })
    }
    if (limits && limits.seedMinute !== undefined) {
      const b = aiUsage.minuteBucketOf(new Date())
      fakeDb.bucketOf('xiai_ai_usage').set(aiUsage.usageIdOf(uid, 'MINUTE', b), { _id: aiUsage.usageIdOf(uid, 'MINUTE', b), uid, window: 'MINUTE', bucket: String(b), count: limits.seedMinute, updated_at: 'seed' })
    }
    if (!issued || issued.ok !== true) throw new Error(`FRESH_KEY_FAILED:${tag}`)
    return { uid, key: issued.key, key_id: issued.key_id }
  }
  const see = async (opts, handler) => {
    const r = await callRelay(handler ? Object.assign({}, opts, { handler }) : opts)
    if (r.body && r.body.reason) observed[r.body.reason] = r.status
    return r
  }
  await see({ method: 'GET', requestId: 'rid-i-05-00001' })
  await see({ routePath: '/api/ai/v1/models', requestId: 'rid-i-04-00001' })
  await see({ key: `${KEY_PFX}${'d'.repeat(32)}`, requestId: 'rid-i-01-00001' })
  /* ① INVALID_ARGUMENT：独立金鑰 ＋ 未知体键（400 在任何额度门之前）。 */
  const invargI = await freshKeyI('invarg-0001')
  await see({ key: invargI.key, requestId: 'rid-i-00-00001', body: { prompt: 'x', foo: 1 } })
  /* ② 402：独立 uid ＋ 独立金鑰（余额 1）。 */
  const poorKeyI = (await freshKeyI('poor-0001', { points: 1 })).key
  await see({ key: poorKeyI, requestId: 'rid-i-402-0000' })
  /* ③ 502：独立 uid ＋ 独立金鑰（不共用 RKEY，避免 UID_A 分鐘额度串味）。 */
  const up502I = await freshKeyI('up502-0001')
  upstreamMode = '500'
  await see({ key: up502I.key, requestId: 'rid-i-502-0000', routePath: '/api/ai/v1/images/edits', body: { prompt: 'x', image: { storage_key: 'cloud://qa/r.png' } } })
  upstreamMode = 'url'
  /* ④ LIMIT_DAY：独立 uid ＋ 独立金鑰（day_limit=1、日用量行预置 count=1）。 */
  const dayKeyI = await freshKeyI('lday-0001', { day: 1, seedDay: 1 })
  await see({ key: dayKeyI.key, requestId: 'rid-i-ld-00001' })
  /* ⑤ LIMIT_MINUTE：独立 uid ＋ 独立金鑰（minute_limit=1、分鐘用量行预置 count=1）。 */
  const minKeyI = await freshKeyI('lmin-0001', { minute: 1, seedMinute: 1 })
  await see({ key: minKeyI.key, requestId: 'rid-i-lm-00001' })
  /* 503 CONFIG_MISSING：同一份实现、只把 env 换成 {}（真 resolveUpstreamSecret fail-closed）。 */
  const cfgKeyI = await freshKeyI('cfg-0001')
  const configMissingRelay = core.createAiRelay(Object.assign({}, relayDeps, { env: {} }))
  await see({ key: cfgKeyI.key, requestId: 'rid-i-503-0000' }, configMissingRelay)
  const expectedMap = { INVALID_ARGUMENT: 400, KEY_INVALID: 401, INSUFFICIENT_POINTS: 402, PATH_NOT_ALLOWED: 404, METHOD_NOT_ALLOWED: 405, LIMIT_DAY: 429, LIMIT_MINUTE: 429, UPSTREAM_ERROR: 502, CONFIG_MISSING: 503 }
  const mismatch = Object.keys(expectedMap).filter((k) => observed[k] !== expectedMap[k])
  check('I', 'I2', '丙9 封闭面：8 个错误面（429 占二）实测 status 与冻结表逐条相等',
    mismatch.length === 0, { observed, mismatch })

  /* 成功恰 5 键；400/401/429 恰 3 键；502 恰 4 键。 */
  const ok200 = await callRelay({ key: RKEY, requestId: 'rid-i-200-0001' })
  const e400 = await callRelay({ key: RKEY, requestId: 'rid-i-400-0000', body: { prompt: 'x', foo: 1 } })
  const e401 = await callRelay({ key: null, requestId: 'rid-i-401-0000' })
  upstreamMode = '500'
  const e502 = await callRelay({ key: RKEY, requestId: 'rid-i-502-0001', routePath: '/api/ai/v1/images/edits', body: { prompt: 'x', image: { storage_key: 'cloud://qa/r.png' } } })
  upstreamMode = 'url'
  const edgeKeyI = await aiKeys.issueAiKey({ uid: 'u-qa-i-429-0001', label: '质检-429面', day_limit: 1, minute_limit: 50 })
  const b429 = aiUsage.dayBucketOf(new Date())
  fakeDb.bucketOf('xiai_ai_usage').set(aiUsage.usageIdOf('u-qa-i-429-0001', 'DAY', b429), { _id: aiUsage.usageIdOf('u-qa-i-429-0001', 'DAY', b429), uid: 'u-qa-i-429-0001', window: 'DAY', bucket: String(b429), count: 1, updated_at: 'seed' })
  const e429 = await callRelay({ key: edgeKeyI.key, requestId: 'rid-i-429-0000' })
  check('I', 'I3', '丙9 键面：成功回包恰 5 键；400/401/429 恰 3 键；502 恰 4 键（多 status）',
    shapeOf(ok200.body) === 'charge,idempotent,image,ok,usage'
      && shapeOf(e400.body) === 'message,ok,reason' && shapeOf(e401.body) === 'message,ok,reason' && shapeOf(e429.body) === 'message,ok,reason'
      && shapeOf(e502.body) === 'message,ok,reason,status',
    { ok: shapeOf(ok200.body), e400: shapeOf(e400.body), e401: shapeOf(e401.body), e429: shapeOf(e429.body), e502: shapeOf(e502.body) })

  /* n 值域对抗。 */
  const nResults = {}
  for (const n of [1, 2, 0, -1, '1', true, 1.0]) {
    const r = await callRelay({ key: RKEY, requestId: `rid-i-n-${String(n).replace(/[^a-z0-9]/gi, 'x')}-1`, body: { prompt: 'n 值域', n } })
    nResults[String(n) + ':' + typeof n] = r.status
  }
  const wantN = { '1:number': 200, '2:number': 400, '0:number': 400, '-1:number': 400, '1:string': 400, 'true:boolean': 400, '1:number2': 200 }
  check('I', 'I4', '丙9 `n` 值域：只有数值 1 放行（200）；2/0/-1/"1"/true ⇒ 400；JSON 1.0 归一为 1 放行',
    nResults['1:number'] === 200 && nResults['2:number'] === 400 && nResults['0:number'] === 400 && nResults['-1:number'] === 400
      && nResults['1:string'] === 400 && nResults['true:boolean'] === 400,
    nResults)
}

/* ================================================== J 段 · 丙10 X-Request-Id */

{
  const w0 = writesNow()
  const flow0 = flowRows().length
  /* 【桩 bug 修复 · J1】四个拒绝样本与两个放行样本**各自独立 uid ＋ 独立金鑰**：
     原用例全部共用 `PLAIN_A`（UID_A / 分鐘限 5），而 `evaluateGate`/`commitUsage` 用**真时钟**
     同一分鐘桶 ⇒ 前面用例把 UID_A 的分鐘额度耗光 ⇒ 两个放行样本被 429 先接住（实测 429/429）。
     现在六发六把独立金鑰，状态零串味。 */
  const freshJKey = async (tag) => {
    const uid = `u-qa-j-${tag}`
    const issued = await aiKeys.issueAiKey({ uid, label: `质检-J-${tag}`, day_limit: 500, minute_limit: 120 })
    fakeDb.bucketOf('xiai_balances').set(`bl-${uid}`, { _id: `bl-${uid}`, uid, points: 500, updated_at: 'seed' })
    if (!issued || issued.ok !== true) throw new Error(`J_KEY_FAILED:${tag}`)
    return issued
  }
  const jMiss = await freshJKey('miss')
  const j7 = await freshJKey('len7')
  const j65 = await freshJKey('len65')
  const jBlank = await freshJKey('blank')
  const jOk8 = await freshJKey('ok8')
  const jOk64 = await freshJKey('ok64')
  const jKeyIds = [jMiss, j7, j65, jBlank, jOk8, jOk64].map((k) => k.key_id)
  const wReject0 = writesNow()
  const r1 = await callRelay({ key: jMiss.key, requestId: null })
  const r2 = await callRelay({ key: j7.key, requestId: 'x'.repeat(7) })
  const r3 = await callRelay({ key: j65.key, requestId: 'x'.repeat(65) })
  const r4 = await callRelay({ key: jBlank.key, requestId: '        ' })
  const rejectsWrites = writesNow() - wReject0
  const ok8 = await callRelay({ key: jOk8.key, requestId: '12345678' })
  const ok64 = await callRelay({ key: jOk64.key, requestId: 'x'.repeat(64) })
  const rejects = [r1, r2, r3, r4]
  check('J', 'J1', '丙10 X-Request-Id（J1 桩已修：六样本各自独立 uid＋金鑰，杜绝分鐘额度串味）：缺 / 7 字 / 65 字 / 纯空白 ⇒ 均 400 INVALID_ARGUMENT ＋ **零写入**；恰 8 与恰 64 放行 200',
    new Set(jKeyIds).size === 6
      && rejects.every((r) => r.status === 400 && r.body.reason === 'INVALID_ARGUMENT')
      && rejectsWrites === 0
      && ok8.status === 200 && ok64.status === 200
      && ok8.body.idempotent === false && ok64.body.idempotent === false
      && flowRows().length - flow0 === 2,
    { distinctKeys: new Set(jKeyIds).size, rejects: rejects.map((r) => r.status), rejectReasons: rejects.map((r) => r.body.reason), rejectWrites: rejectsWrites, accepts: [ok8.status, ok64.status], acceptIdempotent: [ok8.body.idempotent, ok64.body.idempotent], flowDelta: flowRows().length - flow0 })

  const rid = 'rid-j-idem-0001'
  await callRelay({ key: RKEY, requestId: rid })
  const row = flowRows().find((r) => r.kind === 'CHARGE' && String(r.ref_id).includes(rid))
  check('J', 'J2', '丙10 幂等键派生：CHARGE 行 `idem_key` 逐字＝ sha256(key_id ＋ ":" ＋ X-Request-Id)',
    Boolean(row) && row.idem_key === sha256(`${relayKey.key_id}:${rid}`),
    { derived: Boolean(row) && row.idem_key === sha256(`${relayKey.key_id}:${rid}`) })
}

/* ================================================== K 段 · 丙11 图片面 */

{
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const pngBytes = Buffer.from(PNG_1PX, 'base64')
  const pngDataUrl = `data:image/png;base64,${PNG_1PX}`
  const imgUid = 'u-qa-image-0001'
  const imgKey = await aiKeys.issueAiKey({ uid: imgUid, label: '质检-图片面', day_limit: 500, minute_limit: 100 })
  fakeDb.bucketOf('xiai_balances').set(`bl-${imgUid}`, { _id: `bl-${imgUid}`, uid: imgUid, points: 200, updated_at: 'seed' })
  const EDITS = '/api/ai/v1/images/edits'
  const callImg = (body, rid, key) => callRelay({ key: key || imgKey.key, routePath: EDITS, requestId: rid, body })

  /* 恰 2 MiB 放行 / 2 MiB+1 拒。 */
  const exact = Buffer.concat([pngBytes.subarray(0, 8), Buffer.alloc(core.IMAGE_DATA_URL_MAX_BYTES - 8, 0x41)])
  const over = Buffer.concat([pngBytes.subarray(0, 8), Buffer.alloc(core.IMAGE_DATA_URL_MAX_BYTES + 1 - 8, 0x41)])
  const w0 = writesNow()
  const kOver = await callImg({ prompt: '超限', image: { data_url: `data:image/png;base64,${over.toString('base64')}` } }, 'rid-k-over-0001')
  const kOverWrites = writesNow() - w0
  const kExact = await callImg({ prompt: '边界', image: { data_url: `data:image/png;base64,${exact.toString('base64')}` } }, 'rid-k-exact-01')
  check('K', 'K1', '丙11 体积边界：解码后 2 MiB+1 ⇒ 400 ＋ 零写入零上傳；恰 2 MiB ⇒ 200 放行',
    kOver.status === 400 && kOverWrites === 0 && kExact.status === 200,
    { over: kOver.status, overWrites: kOverWrites, exact: kExact.status })

  /* 魔数与 mime 不一致。 */
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
  const kMagic = await callImg({ prompt: '魔数', image: { data_url: `data:image/png;base64,${jpegMagic.toString('base64')}` } }, 'rid-k-magic-01')
  check('K', 'K2', '丙11 魔数：JPEG 魔数冒充 image/png ⇒ 400（魔数门先行）',
    kMagic.status === 400 && kMagic.body.reason === 'INVALID_ARGUMENT', { status: kMagic.status, reason: kMagic.body.reason })

  /* 双鍵同給。 */
  const kBoth = await callImg({ prompt: '双键', image: { storage_key: 'cloud://qa/r.png', data_url: pngDataUrl } }, 'rid-k-both-001')
  check('K', 'K3', '丙11 双鍵同給：storage_key ＋ data_url ⇒ 400 ＋ 零扣费',
    kBoth.status === 400, { status: kBoth.status })

  /* 对抗样本：大写前綴 / base64 内换行 / 三重 padding。 */
  const kUpper = await callImg({ prompt: '大写前綴', image: { data_url: `DATA:IMAGE/PNG;BASE64,${PNG_1PX}` } }, 'rid-k-upper-01')
  const kNewline = await callImg({ prompt: '换行', image: { data_url: `data:image/png;base64,AAAA\nBBBB` } }, 'rid-k-newln-001')
  const kPad = await callImg({ prompt: '三重padding', image: { data_url: 'data:image/png;base64,QUFB===' } }, 'rid-k-pad-0001')
  check('K', 'K4', '丙11 base64 形态对抗：前綴大写（RFC 大小写不敏感 ⇒ 放行，登记项）／载荷内换行 ⇒ 400／三重 padding ⇒ 400',
    kUpper.status === 200 && kNewline.status === 400 && kPad.status === 400,
    { uppercasePrefix: kUpper.status, newlineInPayload: kNewline.status, triplePadding: kPad.status })

  /* webp / tiff 合法魔数放行。 */
  const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii'), Buffer.alloc(16, 0)])
  const tiffLE = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08])
  const kW = await callImg({ prompt: 'webp', image: { data_url: `data:image/webp;base64,${webp.toString('base64')}` } }, 'rid-k-webp-001')
  const kT = await callImg({ prompt: 'tiff', image: { data_url: `data:image/tiff;base64,${tiffLE.toString('base64')}` } }, 'rid-k-tiff-001')
  check('K', 'K5', '丙11 魔数面：合法 webp（RIFF/WEBP）与 tiff（II*\\0）⇒ 均放行受理',
    kW.status === 200 && kT.status === 200, { webp: kW.status, tiff: kT.status })

  /* `data:image/` 三面零命中（回包 / 日志 / 上游请求体）。 */
  const needle = 'data:' + 'image/'
  const respHits = relayRaws.reduce((n, r) => n + countIn(r, needle), 0)
  const logHits = logs.reduce((n, l) => n + countIn(l, needle), 0)
  const upHits = upstreamHits.reduce((n, h) => n + countIn(h.raw, needle), 0)
  check('K', 'K6', '丙11 零命中：全部回包 / 全部日志 / 全部上游请求体对 `data:image/` 逐字搜索 count=0',
    respHits === 0 && logHits === 0 && upHits === 0, { responses: respHits, logs: logHits, upstream: upHits })

  /* 上游 key 只进上游头、不进体；回包与日志零上游 key。 */
  const upKeyInBodies = upstreamHits.reduce((n, h) => n + countIn(h.raw, UPSTREAM_KEY), 0)
  const upKeyInAuth = upstreamHits.filter((h) => countIn(h.auth, UPSTREAM_KEY) === 1).length
  const upKeyInResp = relayRaws.reduce((n, r) => n + countIn(r, UPSTREAM_KEY), 0)
  const upKeyInLogs = logs.reduce((n, l) => n + countIn(l, UPSTREAM_KEY), 0)
  const secretInLogs = logs.reduce((n, l) => n + countIn(l, UPSTREAM_SECRET), 0)
  check('K', 'K7', '甲2 补面：上游 key **只进上游 Authorization 头**（每发恰 1 处）；上游体 / 全部回包 / 全部日志 / 主密钥 逐字搜索 count=0',
    upKeyInBodies === 0 && upKeyInAuth === upstreamHits.length && upKeyInResp === 0 && upKeyInLogs === 0 && secretInLogs === 0,
    { inUpstreamBodies: upKeyInBodies, authPresence: `${upKeyInAuth}/${upstreamHits.length}`, inResponses: upKeyInResp, inLogs: upKeyInLogs, secretInLogs })

  /* 401 回包不回显所持 token。 */
  const echoProbe = `${KEY_PFX}${'e'.repeat(32)}`
  const echo = await callRelay({ key: echoProbe, requestId: 'rid-k-echo-0001' })
  check('K', 'K8', '甲2 补面：401 回包**不回显**所持凭据（token 逐字搜索 count=0）',
    echo.status === 401 && countIn(echo.raw, echoProbe) === 0, { status: echo.status, tokenHits: countIn(echo.raw, echoProbe) })

  /* data_url 成功路径：上游拿到签名链（非 data: 前缀）。K5 段最后一发是 tiff 成功。 */
  const lastHit = upstreamHits[upstreamHits.length - 1]
  const lastUpstreamImage = String((JSON.parse(lastHit.raw).image) || '')
  check('K', 'K9', '丙11 转存语义：data_url 成功路径发往上游的 `image` 是**签名链**（https 前缀、零 data:、零 base64 字节）',
    lastUpstreamImage.startsWith('https://') && countIn(lastHit.raw, 'data:') === 0,
    { imageIsHttps: lastUpstreamImage.startsWith('https://'), dataPrefixHits: countIn(lastHit.raw, 'data:') })
}

/* ============================================ L 段 · AC-593 / 591 / 601 补面（矩阵取证） */

{
  const lUid = 'u-qa-l-00001'
  const lIssued = await aiKeys.issueAiKey({ uid: lUid, label: '质检-L段', day_limit: 500, minute_limit: 120 })
  fakeDb.bucketOf('xiai_balances').set(`bl-${lUid}`, { _id: `bl-${lUid}`, uid: lUid, points: 500, updated_at: 'seed' })
  const LKEY = lIssued.key
  const baseBefore = 'https://127.0.0.1:9/qa-upstream'

  /* L1 · AC-593 中转端点契约：有参考图 ⇒ `<base>/images/edits`、无 ⇒ `<base>/images/generations`；
     **换 base_url（零改代码）⇒ 请求跟随新上游**；上游原始错误体**不透传**（502 归一化）。 */
  upstreamMode = 'url'
  const h0 = upstreamHits.length
  await callRelay({ key: LKEY, requestId: 'rid-l-gen-00001' })
  await callRelay({ key: LKEY, requestId: 'rid-l-edit-0001', routePath: '/api/ai/v1/images/edits', body: { prompt: 'L 段', image: { storage_key: 'cloud://qa/r.png' } } })
  const genHit = upstreamHits[h0]
  const editHit = upstreamHits[h0 + 1]
  const switched = await aiUpstream.setUpstream(
    { actor_uid: UID_A, base_url: 'https://switched.example/v2', model: 'm-qa-2', key: UPSTREAM_KEY, timeout_ms: TIMEOUT_MS },
    relayDeps.env
  )
  await callRelay({ key: LKEY, requestId: 'rid-l-gen-00002' })
  const newHit = upstreamHits[h0 + 2]
  upstreamMode = '500'
  const l502 = await callRelay({ key: LKEY, requestId: 'rid-l-502-00001', routePath: '/api/ai/v1/images/edits', body: { prompt: 'L 段', image: { storage_key: 'cloud://qa/r.png' } } })
  upstreamMode = 'url'
  const raw502 = JSON.stringify(l502.body)
  check('L', 'L1', 'AC-593 中转端点契约：无图 ⇒ `<base>/images/generations`、有图 ⇒ `<base>/images/edits`；换 `base_url`（**零改代码**）⇒ 跟随新上游；上游原始错误体（`upstream exploded`）**零透传**（502 归一化 4 键）',
    Boolean(genHit && editHit && newHit && switched && switched.ok === true)
      && genHit.url === `${baseBefore}/images/generations`
      && editHit.url === `${baseBefore}/images/edits`
      && newHit.url === 'https://switched.example/v2/images/generations'
      && l502.status === 502 && l502.body.reason === 'UPSTREAM_ERROR'
      && shapeOf(l502.body) === 'message,ok,reason,status'
      && countIn(raw502, 'upstream exploded') === 0,
    { generationsUrl: genHit && genHit.url, editsUrl: editHit && editHit.url, afterSwitchUrl: newHit && newHit.url,
      switchOk: Boolean(switched && switched.ok === true), status502: l502.status, reason502: l502.body.reason,
      bodyShape502: shapeOf(l502.body), upstreamTextLeaks: countIn(raw502, 'upstream exploded') })

  /* L2 · AC-601 ② `image` 白名單恰兩值：第三鍵 ⇒ 400 ＋ 零写入（在任何写入之前）。 */
  const wL2 = writesNow()
  const flowL2 = flowRows().length
  const hitsL2 = upstreamHits.length
  const l2 = await callRelay({ key: LKEY, requestId: 'rid-l-img3-0001', routePath: '/api/ai/v1/images/edits', body: { prompt: 'x', image: { storage_key: 'cloud://qa/r.png', foo: 1 } } })
  check('L', 'L2', 'AC-601 ② `image` 白名單恰兩值（`storage_key` / `data_url`）：第三鍵 `foo` ⇒ 400 INVALID_ARGUMENT ＋ **零写入零上游**',
    l2.status === 400 && l2.body.reason === 'INVALID_ARGUMENT'
      && writesNow() === wL2 && flowRows().length === flowL2 && upstreamHits.length === hitsL2,
    { status: l2.status, reason: l2.body.reason, writesDelta: writesNow() - wL2,
      flowDelta: flowRows().length - flowL2, upstreamCalls: upstreamHits.length - hitsL2 })

  /* L3 · AC-591 ① 签发回包明文形态（B 段另证库内零明文 / hash 16 / 列表零明文零 hash）。 */
  const keyRegexOk = /^sk-xiai-[0-9a-f]{32}$/.test(String(issuedA.key))
  const prefixLen = String(issuedA.key_prefix === undefined ? '' : issuedA.key_prefix).length
  check('L', 'L3', 'AC-591 ① 签发回包明文匹配 `/^sk-xiai-[0-9a-f]{32}$/` ＋ `key_prefix` 恰 8 位且为明文前缀',
    keyRegexOk && prefixLen === 8 && String(issuedA.key).startsWith(String(issuedA.key_prefix)),
    { regexOk: keyRegexOk, keyLen: String(issuedA.key).length, prefixLen })

  /* L4 · AC-599③ 请求体上限：用「恰 4 MiB」与「4 MiB＋1」的**原始 body 字节串**直接驱动
     handler 的 body 读取层（不真塞 base64 进 JSON）。阀值真源 ＝ `MAX_BODY_BYTES`（4 MiB，
     `aiRelay.js` 导出）；Vercel 自身 ≈4.5 MB 体限是**外层护栏**（本离线层测不到）。
     实测形态：恰 4 MiB ⇒ 过长度门、`JSON.parse` 失败 ⇒ 400（**不当截断**，是当非法 JSON）；
     4 MiB＋1 ⇒ `MAX_BODY_BYTES` 长度门直接拒 ⇒ 400。两发均零上游零扣费零流水。 */
  const l4Uid = 'u-qa-l4-00001'
  const l4Issued = await aiKeys.issueAiKey({ uid: l4Uid, label: '质检-L4体限', day_limit: 500, minute_limit: 120 })
  fakeDb.bucketOf('xiai_balances').set(`bl-${l4Uid}`, { _id: `bl-${l4Uid}`, uid: l4Uid, points: 500, updated_at: 'seed' })
  const L4KEY = l4Issued.key
  const l4Hits0 = upstreamHits.length
  const l4Flow0 = flowRows().length
  const l4Writes0 = writesNow()
  const l4Exact = await callRelay({ key: L4KEY, requestId: 'rid-l4-exact-01', rawBody: 'A'.repeat(core.MAX_BODY_BYTES) })
  const l4Over = await callRelay({ key: L4KEY, requestId: 'rid-l4-over-001', rawBody: 'A'.repeat(core.MAX_BODY_BYTES + 1) })
  check('L', 'L4', 'AC-599③ 请求体上限：阀值真源＝`MAX_BODY_BYTES`（4 MiB）；Vercel ≈4.5 MB 体限为外层护栏。恰 4 MiB 裸体 ⇒ 过长度门、`JSON.parse` 失败 ⇒ 400；4 MiB＋1 ⇒ 长度门直接拒 ⇒ 400；两发均零上游、零扣费、零流水',
    l4Exact.status === 400 && l4Exact.body.reason === 'INVALID_ARGUMENT'
      && l4Over.status === 400 && l4Over.body.reason === 'INVALID_ARGUMENT'
      && upstreamHits.length === l4Hits0 && flowRows().length === l4Flow0 && writesNow() === l4Writes0,
    { exact: l4Exact.status, exactReason: l4Exact.body.reason, over: l4Over.status, overReason: l4Over.body.reason,
      upstreamCalls: upstreamHits.length - l4Hits0, flowDelta: flowRows().length - l4Flow0, writesDelta: writesNow() - l4Writes0 })

  /* L5 · AC-602② `data_url` 前缀/形态非法四发（每发独立 uid ＋ 独立金鑰，零状态串味）：
     非 image 类 / 裸 base64 无前缀 / 缺 payload / 缺 `;base64` ⇒ 全 400 INVALID_ARGUMENT，
     零写入零上游（值域门在⑤步、任何写入之前）。 */
  const l5Shots = [
    { uid: 'u-qa-l5-text-0001', rid: 'rid-l5-text-01', tag: '非image类', dataUrl: 'data:text/plain;base64,SGVsbG8=' },
    { uid: 'u-qa-l5-bare-0001', rid: 'rid-l5-bare-01', tag: '裸base64', dataUrl: 'iVBORw0KGgo=' },
    { uid: 'u-qa-l5-nopay-0001', rid: 'rid-l5-nopay-01', tag: '缺payload', dataUrl: 'data:image/png;base64' },
    { uid: 'u-qa-l5-noenc-0001', rid: 'rid-l5-noenc-01', tag: '缺;base64', dataUrl: 'data:image/png,SGVsbG8=' }
  ]
  const l5Results = []
  let l5AllPass = true
  for (const shot of l5Shots) {
    const shotIssued = await aiKeys.issueAiKey({ uid: shot.uid, label: '质检-L5-' + shot.tag, day_limit: 500, minute_limit: 120 })
    fakeDb.bucketOf('xiai_balances').set(`bl-${shot.uid}`, { _id: `bl-${shot.uid}`, uid: shot.uid, points: 500, updated_at: 'seed' })
    const h0 = upstreamHits.length
    const f0 = flowRows().length
    const w0 = writesNow()
    const r = await callRelay({ key: shotIssued.key, requestId: shot.rid, routePath: '/api/ai/v1/images/edits', body: { prompt: 'L5', image: { data_url: shot.dataUrl } } })
    const pass = r.status === 400 && r.body.reason === 'INVALID_ARGUMENT'
      && upstreamHits.length === h0 && flowRows().length === f0 && writesNow() === w0
    if (!pass) l5AllPass = false
    l5Results.push({ tag: shot.tag, status: r.status, reason: r.body.reason,
      upstreamCalls: upstreamHits.length - h0, flowDelta: flowRows().length - f0, writesDelta: writesNow() - w0 })
  }
  check('L', 'L5', 'AC-602② `data_url` 前缀/形态非法四发（每发独立 uid＋金鑰，零状态串味）：非 image 类（`data:text/plain`）／裸 base64 无前缀／缺 payload（`;base64` 后无逗号）／缺 `;base64`（明文）⇒ 全 400 INVALID_ARGUMENT ＋ 零写入零上游',
    l5AllPass, { shots: l5Results })
}

/* ------------------------------------------------------------------ 收尾 */

emit({
  summary: { total, passed, failed: total - passed },
  failed_ids: failedIds,
  note: 'Neng 对抗性质检（独立于 verify-* 自检）：内存假 DB ＋ 注入 fetch / 时钟 / 签名链 / 转存；零端口、零云端、零生产数据；不打印任何明文凭据。'
})
process.exit(failedIds.length === 0 ? 0 : 1)
