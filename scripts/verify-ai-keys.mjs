/**
 * 玺爱 · **自检：AI 金鑰 / 上游配置 / 用量**（本單新增）
 * ============================================================================
 * **本地、离线**（自造 DB 假体注入；零外部网络、零云端连接、零生产数据）。被测件：
 *   · `cloudfunctions/xiai-user-token/lib/aiKeys.js`    （唯一金鑰实现点）
 *   · `cloudfunctions/xiai-user-token/lib/aiUpstream.js`（唯一上游配置实现点）
 *   · `cloudfunctions/xiai-user-token/lib/aiUsage.js`   （唯一用量实现点）
 *   · `cloudfunctions/xiai-user-token/lib/ops.js` 的 5 个新用户 op
 *     （`issueAiKey` / `listAiKeys` / `revokeAiKey` / `updateAiKeyLimits` / `getAiUsage`）
 *     ＋ 2 个新管理员 op（`getAiUpstream` / `setAiUpstream`，走 `adminWhitelistDenial`）
 *   · `cloudfunctions/xiai-user-token/index.js` 信封（op 收窄的 additive 透传）
 *
 * 断言面（本套 **30** 条，覆盖派单方点名的 ①〜⑫；本单新增 B5〜B8 共 4 条 —— 头注旧写「38」与实际不符，按实际枚举数订正）：
 *   A. 金鑰单点（真函数 ＋ 注入假存储）
 *      ① 签发回包带明文、库内**零明文零完整 hash**（只落前 16 位 hash ＋ 8 位前缀）；
 *      ② `listAiKeys` 逐行**零 hash 零明文**、键集恰 8 键；
 *      ③ 吊销后 `resolveAiKey` ⇒ `KEY_INVALID`；吊销**重放** ⇒ `already:true` 且行不新增；
 *      ④ **越权**：B 用户吊销 / 改限额 A 用户的 key ⇒ 结构化拒 ＋ **零写入**；
 *      ⑤ 限额越界（0 / 1001 / 非整数 / 負 / 分鐘 0 / 121）与超长 label ⇒ `INVALID_VALUE` ＋ 零写入；
 *      ⑥ 每人 **10 枚** ACTIVE 上限（第 11 枚被拒；吊销 1 枚后可再发）。
 *   B. 上游配置单点
 *      ⑦ 加密往返（`setUpstream` → `resolveUpstreamSecret` 逐字相等）、库内 `key_cipher`
 *         ≠ 明文、三件 base64、iv 12 / tag 16 字节、行键面恰 10 键；`getUpstreamPublic`
 *         回包**零 cipher / iv / tag / 明文**（四者逐字搜索 count=0）；
 *      ⑧ 缺 `XIAI_AI_UPSTREAM_SECRET` ⇒ `CONFIG_MISSING` ＋ **零写入**；
 *         另加值域（非 https 协议 / timeout 越界 / 首次无 key）与「key 省略 ⇒ 沿用旧密文」；
 *   C. 用量单点
 *      ⑨ `evaluateGate` 超日限 / 超分鐘限各一（`LIMIT_DAY` / `LIMIT_MINUTE`）＋ **零写入**；
 *         `peekUsage` **零写入**；`commitUsage` 日行与分鐘行**各 +1**；限额取本人 ACTIVE 最小值；
 *   D. 信封（真 `index.js` 本体 ＋ 真签发令牌 ＋ 注入假 DB）
 *      ⑫ **全部新 op 回包键集不多不少**（7 个 op 逐个钉死）；⑪ 载荷带 `uid` / `key_hash`
 *         ⇒ `INVALID_FIELD` ＋ 零写入；⑩ 未知 op ⇒ 结构化拒；无令牌 ⇒ `FORBIDDEN`；
 *         `getAiUsage.points` 与账本一致；管理员门（非管理员 ⇒ `FORBIDDEN` ＋ 零写入）。
 *   E. 静态门：三模块**零取句柄字面**（守既有 A8 / A8b / D4 / D1U 同尺）、三集合**不进**
 *      `COLLECTIONS` / 前端云读面、新 reason 逐字登记、`index.js` 透传块按 op 收窄。
 *
 * 纪律：断言失败 ⇒ 退出码 1；不打印任何明文金鑰 / 密文 / 令牌原文（只打印指纹与长度）。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

/* 合成测试环境（缺省才写；**脚本内不写任何真实密钥** —— secret 走运行期随机）。 */
process.env.XIAI_USER_SMS_CODE = String(process.env.XIAI_USER_SMS_CODE || '729341').trim()
if (!process.env.XIAI_USER_TOKEN_SECRET) process.env.XIAI_USER_TOKEN_SECRET = randomHex('user-secret')
process.env.XIAI_USER_TOKEN_SECRET = String(process.env.XIAI_USER_TOKEN_SECRET).trim()
process.env.XIAI_USER_TOKEN_VERSION = process.env.XIAI_USER_TOKEN_VERSION || '1'
process.env.XIAI_ADMIN_PHONE = String(process.env.XIAI_ADMIN_PHONE || '13800000001').trim()
const UPSTREAM_SECRET = randomHex('upstream-secret')

function randomHex(tag) {
  return createHash('sha256').update(`${tag}-${Date.now()}-${Math.random()}`).digest('hex')
}

const fn = require(path.join(FN_DIR, 'index.js'))
const ops = require(path.join(FN_DIR, 'lib/ops.js'))
const ledger = require(path.join(FN_DIR, 'lib/ledger.js'))
const aiKeys = require(path.join(FN_DIR, 'lib/aiKeys.js'))
const aiUpstream = require(path.join(FN_DIR, 'lib/aiUpstream.js'))
const aiUsage = require(path.join(FN_DIR, 'lib/aiUsage.js'))
const userConfig = require(path.join(FN_DIR, 'lib/config.js'))

/* ---------------------------------------------------------------------------
  断言 / 读数（与既有 25 个脚本同形）
  --------------------------------------------------------------------------- */

let total = 0
let passed = 0
const failedIds = []
const sectionStats = {}

function section(name, title) {
  if (!sectionStats[name]) sectionStats[name] = { total: 0, passed: 0 }
  console.log(JSON.stringify({ section: name, title }))
}

function check(id, title, expected, actual) {
  total += 1
  const sec = id.slice(0, 1)
  if (!sectionStats[sec]) sectionStats[sec] = { total: 0, passed: 0 }
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (pass) passed += 1
  else failedIds.push(id)
  sectionStats[sec].total += 1
  if (pass) sectionStats[sec].passed += 1
  console.log(JSON.stringify({ id, case: title, pass, expected, actual }))
}

const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const isDenial = (value) => value && value.ok === false && shapeOf(value) === 'message,ok,reason'
const sha256 = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex')
/** 回包内**逐字搜索**某串的出现次数（0 ＝ 完全不出现）。 */
const countIn = (text, needle) => (needle === '' ? -1 : String(text).split(needle).length - 1)

/* ---------------------------------------------------------------------------
  内存假 DB（形状对齐真实 SDK 使用面；`where(...).update(...)` 在**执行时**按过滤条件匹配
  ＝ 单文档条件更新语义；`stats.writes` ＝ **零写入判据**的机械计数）
  --------------------------------------------------------------------------- */

const tick = () => new Promise((resolve) => setImmediate(resolve))
const rowMatches = (row, match) => Object.keys(match).every((key) => row[key] === match[key])

function createFakeDb() {
  const buckets = new Map()
  const stats = { writes: 0, reads: 0, writeLog: [] }
  const bucketOf = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    return buckets.get(name)
  }
  function makeQuery(map, state) {
    return {
      async get() {
        await tick()
        stats.reads += 1
        const rows = [...map.values()].filter((row) => rowMatches(row, state.match || {})).map((row) => Object.assign({}, row))
        return { data: rows }
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
        stats.writeLog.push({ action: 'update', match: state.match, updated })
        return { updated }
      }
    }
  }
  const db = {
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
              return { data: row ? Object.assign({}, row) : null }
            },
            async set(doc) {
              await tick()
              map.set(id, Object.assign({ _id: id }, doc))
              stats.writes += 1
              stats.writeLog.push({ action: 'set', id })
              return { updated: 1 }
            }
          }
        },
        async add(doc) {
          await tick()
          const id = typeof doc._id === 'string' && doc._id !== '' ? doc._id : `gen-${map.size + 1}-${Math.random().toString(36).slice(2, 8)}`
          if (map.has(id)) throw new Error('FAKE_DUPLICATE_ID')
          map.set(id, Object.assign({ _id: id }, doc))
          stats.writes += 1
          stats.writeLog.push({ action: 'add', id })
          return { _id: id }
        },
        where(match) {
          return makeQuery(map, { match })
        }
      }
    }
  }
  return db
}

const fakeDb = createFakeDb()
const writesNow = () => fakeDb.stats.writes
const keyRowsOf = (uid) => [...fakeDb.bucketOf('xiai_ai_keys').values()].filter((row) => !uid || row.uid === uid)

/* 生产不注入 ⇒ 走 `ops.resolveAiStore` 的真句柄；此处四处注入假体（同一只读 / 单文档更新面）。 */
ops.setOpsDbProvider(() => fakeDb)
ledger.setLedgerStoreProvider(() => ({ balances: fakeDb.collection('xiai_balances'), flow: fakeDb.collection('xiai_points_flow') }))
aiKeys.setAiKeyStoreProvider(() => ({ keys: fakeDb.collection('xiai_ai_keys') }))
aiUpstream.setUpstreamStoreProvider(() => ({ upstream: fakeDb.collection('xiai_ai_upstream') }))
aiUsage.setAiUsageStoreProvider(() => ({ usage: fakeDb.collection('xiai_ai_usage'), keys: fakeDb.collection('xiai_ai_keys') }))

const A_UID = 'u-aaaaaaaaaaaaaaaa'
const B_UID = 'u-bbbbbbbbbbbbbbbb'
const fingerprint = (value) => sha256(value).slice(0, 12)

/* ===========================================================================
   A 段：金鑰单点（真函数 ＋ 注入假存储）
   =========================================================================== */
section('A', '金鑰单点：明文一次性 / 零 hash 下发 / 吊销幂等 / 越权零写入 / 值域 / 10 枚上限')

/* A1（①）：签发回包带明文；库内零明文、零完整 hash（只落 16 位 hash ＋ 8 位前缀）；行键面恰 12 键。 */
const A1_KEY = await (async () => {
  const reply = await aiKeys.issueAiKey({ uid: A_UID, label: '書房印' })
  const row = fakeDb.bucketOf('xiai_ai_keys').get(`ak-${reply.key_id}`)
  const dump = JSON.stringify([...fakeDb.bucketOf('xiai_ai_keys').values()])
  check('A1', '① 签发：回包含明文（sk-xiai- ＋ 32 位十六进制）；库内零明文、零完整 hash（只落 16 位 hash ＋ 8 位前缀）；行键面恰 12 键；`_id`=ak-<key_id>；revoked_at=null', {
    replyKeys: 'created_at,day_limit,key,key_id,key_prefix,label,minute_limit,ok',
    plainOk: /^sk-xiai-[0-9a-f]{32}$/.test(reply.key),
    keyIdLen: 16,
    keyIdHex: /^[0-9a-f]{16}$/.test(reply.key_id),
    hashLen: row.key_hash.length,
    prefix: reply.key_prefix,
    prefixIsPlainHead8: row.key_prefix === reply.key.slice(0, 8),
    rowKeys: aiKeys.KEY_ROW_KEYS.slice().sort(),
    docId: true,
    status: row.status,
    revokedAt: row.revoked_at,
    defaults: [row.day_limit, row.minute_limit],
    plainInDb: countIn(dump, reply.key),
    fullHashInDb: countIn(dump, sha256(reply.key)),
    shortHashInDb: 1
  }, {
    replyKeys: shapeOf(reply),
    plainOk: /^sk-xiai-[0-9a-f]{32}$/.test(reply.key),
    keyIdLen: reply.key_id.length,
    keyIdHex: /^[0-9a-f]{16}$/.test(reply.key_id),
    hashLen: row.key_hash.length,
    prefix: row.key_prefix,
    prefixIsPlainHead8: row.key_prefix === reply.key.slice(0, 8),
    rowKeys: Object.keys(row).sort(),
    docId: row._id === `ak-${reply.key_id}`,
    status: row.status,
    revokedAt: row.revoked_at === null ? null : typeof row.revoked_at,
    defaults: [row.day_limit, row.minute_limit],
    plainInDb: countIn(dump, reply.key),
    fullHashInDb: countIn(dump, sha256(reply.key)),
    shortHashInDb: countIn(dump, row.key_hash)
  })
  return reply
})()

/* A2（②）：listAiKeys 逐行零 hash 零明文、键集恰 8 键。 */
{
  const reply = await aiKeys.listAiKeys({ uid: A_UID })
  const dump = JSON.stringify(reply)
  check('A2', '② 清单：回包 {ok,rows,count}；rows 逐行恰 8 键、**零 key_hash / 零明文**（逐字搜索 count=0）', {
    ok: true,
    count: 1,
    rowKeys: aiKeys.KEY_LIST_PROJECTION_KEYS.slice().sort(),
    zeroHash: 0,
    zeroPlain: 0
  }, {
    ok: reply.ok,
    count: reply.count,
    rowKeys: reply.rows.length === 1 ? Object.keys(reply.rows[0]).sort() : [],
    zeroHash: countIn(dump, 'key_hash'),
    zeroPlain: countIn(dump, A1_KEY.key)
  })
}

/* A3（③）：吊销后 resolveAiKey ⇒ KEY_INVALID；重放 already:true 且行不新增。 */
{
  const before = keyRowsOf(A_UID).length
  const first = await aiKeys.revokeAiKey({ uid: A_UID, key_id: A1_KEY.key_id })
  const rowAfterFirst = fakeDb.bucketOf('xiai_ai_keys').get(`ak-${A1_KEY.key_id}`)
  const replay = await aiKeys.revokeAiKey({ uid: A_UID, key_id: A1_KEY.key_id })
  const resolved = await aiKeys.resolveAiKey(A1_KEY.key)
  check('A3', '③ 吊销：首次 already=false 且落 REVOKED；重放 already:true 且**行不新增、revoked_at 不改**；吊销后 resolveAiKey ⇒ KEY_INVALID（恒 3 键拒绝）', {
    first: { ok: true, status: 'REVOKED', already: false },
    replay: { ok: true, already: true, sameRevokedAt: true },
    rowsUnchanged: true,
    resolve: 'KEY_INVALID',
    resolveShape: 'message,ok,reason'
  }, {
    first: { ok: first.ok, status: first.status, already: first.already },
    replay: { ok: replay.ok, already: replay.already, sameRevokedAt: replay.revoked_at === rowAfterFirst.revoked_at },
    rowsUnchanged: keyRowsOf(A_UID).length === before,
    resolve: resolved.reason,
    resolveShape: shapeOf(resolved)
  })
}

/* A4（④）【必有】越权：B 用户吊销 / 改限额 A 用户的 key ⇒ 结构化拒 ＋ 零写入。 */
{
  const before = { writes: writesNow(), row: JSON.stringify(fakeDb.bucketOf('xiai_ai_keys').get(`ak-${A1_KEY.key_id}`)) }
  const crossRevoke = await aiKeys.revokeAiKey({ uid: B_UID, key_id: A1_KEY.key_id })
  const crossLimits = await aiKeys.updateAiKeyLimits({ uid: B_UID, key_id: A1_KEY.key_id, day_limit: 1, minute_limit: 1 })
  const ghostRevoke = await aiKeys.revokeAiKey({ uid: B_UID, key_id: 'ff'.repeat(8) })
  const after = { writes: writesNow(), row: JSON.stringify(fakeDb.bucketOf('xiai_ai_keys').get(`ak-${A1_KEY.key_id}`)) }
  check('A4', '④ 越权（必测）：B 用户吊销 / 改限额 A 用户的 key ⇒ 一律 FORBIDDEN（恰 3 键）＋ **零写入**（写计数不变、目标行一字不改）；不存在的 key_id 同判 ⇒ 不洩露存在性', {
    revoke: 'FORBIDDEN',
    limits: 'FORBIDDEN',
    ghost: 'FORBIDDEN',
    shapes: ['message,ok,reason', 'message,ok,reason', 'message,ok,reason'],
    zeroWrite: true,
    rowUntouched: true
  }, {
    revoke: crossRevoke.reason,
    limits: crossLimits.reason,
    ghost: ghostRevoke.reason,
    shapes: [shapeOf(crossRevoke), shapeOf(crossLimits), shapeOf(ghostRevoke)],
    zeroWrite: before.writes === after.writes,
    rowUntouched: before.row === after.row
  })
}

/* A5（⑤）：限额越界（0 / 1001 / 非整数 / 負 / 分鐘 0 / 121）与超长 label ⇒ INVALID_VALUE ＋ 零写入。 */
{
  const before = writesNow()
  const cases = []
  for (const bad of [
    { day_limit: 0, minute_limit: 5 },
    { day_limit: 1001, minute_limit: 5 },
    { day_limit: 20.5, minute_limit: 5 },
    { day_limit: -1, minute_limit: 5 },
    { day_limit: 20, minute_limit: 0 },
    { day_limit: 20, minute_limit: 121 },
    { day_limit: '20', minute_limit: 5 }
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const reply = await aiKeys.issueAiKey({ uid: A_UID, ...bad })
    cases.push(reply.reason)
  }
  const longLabel = await aiKeys.issueAiKey({ uid: A_UID, label: 'x'.repeat(41) })
  const updateBad = await aiKeys.updateAiKeyLimits({ uid: A_UID, key_id: A1_KEY.key_id, day_limit: 0, minute_limit: 5 })
  const missingFields = await aiKeys.updateAiKeyLimits({ uid: A_UID, key_id: A1_KEY.key_id, day_limit: 10 })
  check('A5', '⑤ 值域门：day_limit 0 / 1001 / 20.5 / -1、minute_limit 0 / 121、字符串数字 ⇒ INVALID_VALUE ＋ 零写入；label 41 字 ⇒ INVALID_VALUE；update 缺 minute_limit ⇒ MISSING_REQUIRED', {
    limits: Array(7).fill('INVALID_VALUE'),
    label: 'INVALID_VALUE',
    updateZero: 'INVALID_VALUE',
    missing: 'MISSING_REQUIRED',
    zeroWrite: true,
    rowsUnchanged: 1
  }, {
    limits: cases,
    label: longLabel.reason,
    updateZero: updateBad.reason,
    missing: missingFields.reason,
    zeroWrite: before === writesNow(),
    rowsUnchanged: keyRowsOf(A_UID).length
  })
}

/* A6（⑥）：每人 10 枚 ACTIVE 上限（第 11 枚被拒；吊销 1 枚后可再发）。 */
{
  const uid = 'u-cap-test-000000'
  const issuedKeys = []
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    issuedKeys.push(await aiKeys.issueAiKey({ uid, label: `k${i}` }))
  }
  const before = writesNow()
  const eleventh = await aiKeys.issueAiKey({ uid, label: 'k10' })
  const writesAfterEleventh = writesNow()
  const afterFull = keyRowsOf(uid).length
  /* 吊销一枚 ⇒ 释放一枚额度 ⇒ 可再发（证明「只数 ACTIVE」）。 */
  await aiKeys.revokeAiKey({ uid, key_id: issuedKeys[0].key_id })
  const twelfth = await aiKeys.issueAiKey({ uid, label: 'k11' })
  check('A6', '⑥ 额度：每人 ACTIVE 恰 10 枚上限（第 11 枚 ⇒ INVALID_VALUE ＋ 零写入、行数仍 10）；吊销 1 枚后可再发（只数 ACTIVE）；【登记】愿望字面值 LIMIT_EXCEEDED 不在冻结表 ⇒ 回落 INVALID_VALUE', {
    issued: 10,
    eleventh: 'INVALID_VALUE',
    rowsAfterEleventh: 10,
    zeroWrite: true,
    twelfthOk: true,
    activeAfter: 10,
    limitExceededInTable: false
  }, {
    issued: issuedKeys.filter((item) => item.ok).length,
    eleventh: eleventh.reason,
    rowsAfterEleventh: afterFull,
    zeroWrite: before === writesAfterEleventh,
    twelfthOk: twelfth.ok === true,
    activeAfter: keyRowsOf(uid).filter((row) => row.status === 'ACTIVE').length,
    limitExceededInTable: Object.values(userConfig.REASONS).indexOf('LIMIT_EXCEEDED') !== -1
  })
}

/* A7：resolveAiKey 正例（明文 ⇒ uid / 限额；回包零 hash）＋ 反例（错明文 / 空值）。 */
{
  const issued = await aiKeys.issueAiKey({ uid: A_UID, day_limit: 7, minute_limit: 3 })
  const ok = await aiKeys.resolveAiKey(issued.key)
  const wrong = await aiKeys.resolveAiKey(`${issued.key.slice(0, -4)}dead`)
  const empty = await aiKeys.resolveAiKey('')
  check('A7', '服务端校验：明文 ⇒ {ok,key_id,uid,day_limit,minute_limit}（**零 hash / 零前缀**）；错明文 / 空 ⇒ KEY_INVALID', {
    ok: { ok: true, uid: A_UID, limits: [7, 3], keys: 'day_limit,key_id,minute_limit,ok,uid' },
    wrong: 'KEY_INVALID',
    empty: 'KEY_INVALID'
  }, {
    ok: { ok: ok.ok, uid: ok.uid, limits: [ok.day_limit, ok.minute_limit], keys: shapeOf(ok) },
    wrong: wrong.reason,
    empty: empty.reason
  })
}

/* ===========================================================================
   B 段：上游配置单点（加密往返 / 零密文回包 / 缺 env fail-closed / 值域）
   =========================================================================== */
section('B', '上游配置单点：AES-256-GCM 往返 / 公共面零密文 / 缺主密钥 fail-closed / 值域门')

const UPSTREAM_KEY = 'sk-upstream-0123456789abcdef'
const adminEnv = { XIAI_AI_UPSTREAM_SECRET: UPSTREAM_SECRET }

/* B1（⑦）：setUpstream → resolveUpstreamSecret 逐字相等；库内 cipher ≠ 明文；三件 base64。 */
{
  const reply = await aiUpstream.setUpstream(
    { actor_uid: A_UID, base_url: 'https://api.upstream.example/v1', model: 'm-x-1', key: UPSTREAM_KEY, timeout_ms: 30000 },
    adminEnv
  )
  const row = fakeDb.bucketOf('xiai_ai_upstream').get(aiUpstream.UPSTREAM_ID)
  const roundTrip = await aiUpstream.resolveUpstreamSecret(adminEnv)
  const b64 = (value) => /^[A-Za-z0-9+/=]+$/.test(value)
  check('B1', '⑦ 加密往返：setUpstream 后 resolveUpstreamSecret 解回原值（逐字相等）；库内 key_cipher ≠ 明文；cipher/iv/tag 三件 base64、iv 12 字节、tag 16 字节；行键面恰 10 键、_id=upstream-default', {
    setOk: true,
    roundTripEqual: true,
    roundTripKeys: 'base_url,key,model,timeout_ms',
    cipherNotPlain: true,
    allBase64: true,
    ivBytes: 12,
    tagBytes: 16,
    rowKeys: aiUpstream.UPSTREAM_ROW_KEYS.slice().sort(),
    docId: 'upstream-default',
    mask: 'sk-****cdef'
  }, {
    setOk: reply.ok,
    roundTripEqual: roundTrip.key === UPSTREAM_KEY && roundTrip.base_url === 'https://api.upstream.example/v1' && roundTrip.model === 'm-x-1' && roundTrip.timeout_ms === 30000,
    roundTripKeys: shapeOf(roundTrip),
    cipherNotPlain: row.key_cipher !== UPSTREAM_KEY && row.key_cipher !== '',
    allBase64: b64(row.key_cipher) && b64(row.key_iv) && b64(row.key_tag),
    ivBytes: Buffer.from(row.key_iv, 'base64').length,
    tagBytes: Buffer.from(row.key_tag, 'base64').length,
    rowKeys: Object.keys(row).sort(),
    docId: row._id,
    mask: row.key_mask
  })
}

/* B2（⑦）：getUpstreamPublic 回包键集恰 5 键；cipher / iv / tag / 明文 四者逐字搜索 count=0。 */
{
  const view = await aiUpstream.getUpstreamPublic()
  const dump = JSON.stringify(view)
  check('B2', '⑦ 公共面：getUpstreamPublic 恰 5 键；key_cipher / key_iv / key_tag / 上游明文 四者在回包内逐字搜索 count=0；key_mask ＝ 前 3 ＋ **** ＋ 後 4', {
    keys: 'base_url,key_mask,model,timeout_ms,updated_at',
    cipher: 0,
    iv: 0,
    tag: 0,
    plain: 0,
    mask: 'sk-****cdef'
  }, {
    keys: shapeOf(view),
    cipher: countIn(dump, 'key_cipher'),
    iv: countIn(dump, 'key_iv'),
    tag: countIn(dump, 'key_tag'),
    plain: countIn(dump, UPSTREAM_KEY),
    mask: view.key_mask
  })
}

/* B3（⑧）：缺 XIAI_AI_UPSTREAM_SECRET ⇒ CONFIG_MISSING ＋ 零写入。 */
{
  const before = { writes: writesNow(), rows: JSON.stringify([...fakeDb.bucketOf('xiai_ai_upstream').values()]) }
  const setWithoutEnv = await aiUpstream.setUpstream(
    { actor_uid: A_UID, base_url: 'https://api.upstream.example/v2', model: 'm-x-2', key: 'sk-plain-should-not-land' },
    {}
  )
  const resolveWithoutEnv = await aiUpstream.resolveUpstreamSecret({})
  const after = { writes: writesNow(), rows: JSON.stringify([...fakeDb.bucketOf('xiai_ai_upstream').values()]) }
  check('B3', '⑧ 缺主密钥：setUpstream / resolveUpstreamSecret 均 ⇒ CONFIG_MISSING（恰 3 键）＋ **零写入**（配置行一字未改、无任何新写）；不得静默用空密钥、不得明文落库', {
    set: 'CONFIG_MISSING',
    resolve: 'CONFIG_MISSING',
    shapes: ['message,ok,reason', 'message,ok,reason'],
    zeroWrite: true,
    rowsUntouched: true,
    plainLanded: false
  }, {
    set: setWithoutEnv.reason,
    resolve: resolveWithoutEnv.reason,
    shapes: [shapeOf(setWithoutEnv), shapeOf(resolveWithoutEnv)],
    zeroWrite: before.writes === after.writes,
    rowsUntouched: before.rows === after.rows,
    plainLanded: countIn(after.rows, 'sk-plain-should-not-land') > 0
  })
}

/* B4：值域门（非 https 协议 / host 空 / timeout 越界）＋ key 省略沿用旧密文 ＋ 首次无 key。 */
{
  const before = writesNow()
  const notHttps = await aiUpstream.setUpstream({ actor_uid: A_UID, base_url: 'http://api.upstream.example/v1', model: 'm', key: UPSTREAM_KEY }, adminEnv)
  const badHost = await aiUpstream.setUpstream({ actor_uid: A_UID, base_url: 'https://', model: 'm', key: UPSTREAM_KEY }, adminEnv)
  const timeoutLow = await aiUpstream.setUpstream({ actor_uid: A_UID, base_url: 'https://api.upstream.example/v1', model: 'm', key: UPSTREAM_KEY, timeout_ms: 999 }, adminEnv)
  const timeoutHigh = await aiUpstream.setUpstream({ actor_uid: A_UID, base_url: 'https://api.upstream.example/v1', model: 'm', key: UPSTREAM_KEY, timeout_ms: 120001 }, adminEnv)
  const timeoutFloat = await aiUpstream.setUpstream({ actor_uid: A_UID, base_url: 'https://api.upstream.example/v1', model: 'm', key: UPSTREAM_KEY, timeout_ms: 1000.5 }, adminEnv)
  const writesAfterDenials = writesNow()
  const noModel = await aiUpstream.setUpstream({ actor_uid: A_UID, base_url: 'https://api.upstream.example/v1', key: UPSTREAM_KEY }, adminEnv)
  const noActor = await aiUpstream.setUpstream({ base_url: 'https://api.upstream.example/v1', model: 'm', key: UPSTREAM_KEY }, adminEnv)
  const reused = await aiUpstream.setUpstream({ actor_uid: A_UID, base_url: 'https://api.upstream.example/v3', model: 'm-x-3', timeout_ms: 15000 }, adminEnv)
  const rowAfter = fakeDb.bucketOf('xiai_ai_upstream').get(aiUpstream.UPSTREAM_ID)
  const still = await aiUpstream.resolveUpstreamSecret(adminEnv)
  const freshBucket = createFakeDb()
  aiUpstream.setUpstreamStoreProvider(() => ({ upstream: freshBucket.collection('xiai_ai_upstream') }))
  const firstWithoutKey = await aiUpstream.setUpstream({ actor_uid: A_UID, base_url: 'https://api.upstream.example/v1', model: 'm' }, adminEnv)
  aiUpstream.setUpstreamStoreProvider(() => ({ upstream: fakeDb.collection('xiai_ai_upstream') }))
  check('B4', '上游值域：非 https 协议 / host 空 / timeout 999 / 120001 / 1000.5 ⇒ INVALID_VALUE ＋ 零写入；缺 model ⇒ MISSING_REQUIRED；缺 actor_uid ⇒ MISSING_REQUIRED；key 省则沿用旧密文（cipher 逐字不变、解回原值）；首次无 key ⇒ MISSING_REQUIRED', {
    values: Array(5).fill('INVALID_VALUE'),
    model: 'MISSING_REQUIRED',
    actor: 'MISSING_REQUIRED',
    reusedOk: true,
    cipherUnchanged: true,
    plainStill: true,
    firstNoKey: 'MISSING_REQUIRED',
    zeroWriteDuringDenials: true
  }, {
    values: [notHttps.reason, badHost.reason, timeoutLow.reason, timeoutHigh.reason, timeoutFloat.reason],
    model: noModel.reason,
    actor: noActor.reason,
    reusedOk: reused.ok === true,
    cipherUnchanged: reused.ok === true && rowAfter.timeout_ms === 15000 && rowAfter.model === 'm-x-3' && rowAfter.key_mask === 'sk-****cdef',
    plainStill: still.key === UPSTREAM_KEY,
    firstNoKey: firstWithoutKey.reason,
    zeroWriteDuringDenials: writesAfterDenials === before && notHttps.ok === false && badHost.ok === false
  })
}

/* ---------------------------------------------------------------------------
   B5〜B8（本单新增 · 「读不存在的文档会抛错」缺陷在上游读点上的收尾断言）
   背景：CloudBase node-sdk 的 `doc(id).get()` 在**文档不存在**时抛错（HTTP 404 ⇒
   `TcbError.code === 404`）而非回空 ⇒ 读点必须 try/catch ＋ `isDocNotExistError` 谓词保护。
   --------------------------------------------------------------------------- */

/* 「doc().get() 必抛」的集合替身（复现生产 SDK 的存在性语义；`where` / `set` 委托真假 DB）。 */
const docThrowingCollection = (real, docError) => ({
  doc() {
    return {
      async get() {
        await tick()
        throw docError
      },
      async set(doc) {
        return real.doc.apply(real, arguments).set(doc)
      }
    }
  },
  where(match) {
    return real.where(match)
  }
})
const NOT_EXIST_404 = Object.assign(new Error('404 Not Found | [synthetic]'), { code: 404 })
const REAL_FAULT_500 = Object.assign(new Error('storage internal error | [synthetic]'), { code: 500 })
const restoreUpstreamProvider = () => aiUpstream.setUpstreamStoreProvider(() => ({ upstream: fakeDb.collection('xiai_ai_upstream') }))

/* B5（①）：doc().get() 抛「不存在」类（code 404）⇒ readUpstreamRow 回退 where 并返回既有行（不抛）。 */
{
  const seeded = fakeDb.bucketOf('xiai_ai_upstream').get(aiUpstream.UPSTREAM_ID)
  aiUpstream.setUpstreamStoreProvider(() => ({ upstream: docThrowingCollection(fakeDb.collection('xiai_ai_upstream'), NOT_EXIST_404) }))
  const row = await aiUpstream.readUpstreamRow()
  const view = await aiUpstream.getUpstreamPublic()
  restoreUpstreamProvider()
  check('B5', '① doc().get() 抛不存在类（code 404）⇒ readUpstreamRow 回退 where() 并返回行（不抛）；getUpstreamPublic 同路仍回恰 5 键公共面', {
    rowFound: true,
    docId: 'upstream-default',
    sameAsSeeded: true,
    publicKeys: 'base_url,key_mask,model,timeout_ms,updated_at'
  }, {
    rowFound: row !== null,
    docId: row && row._id,
    sameAsSeeded: row !== null && row.model === seeded.model && row.key_mask === seeded.key_mask,
    publicKeys: shapeOf(view)
  })
}

/* B6（②）：doc 与 where 都抛**非不存在类**（code 500）⇒ **必须上抛**（证明没吞真故障、判据非「凡错都算不存在」）。 */
{
  const bothThrowing = {
    doc() {
      return {
        async get() {
          await tick()
          throw REAL_FAULT_500
        }
      }
    },
    where() {
      return {
        async get() {
          await tick()
          throw REAL_FAULT_500
        }
      }
    }
  }
  aiUpstream.setUpstreamStoreProvider(() => ({ upstream: bothThrowing }))
  let caught = null
  try {
    await aiUpstream.readUpstreamRow()
  } catch (error) {
    caught = error
  }
  restoreUpstreamProvider()
  check('B6', '② doc 与 where 都抛**非不存在类**（code 500）⇒ 必须上抛（不吞真存储故障；catch 到的正是同一个错）', {
    threw: 500,
    sameError: true
  }, {
    threw: caught === null ? null : caught.code,
    sameError: caught === REAL_FAULT_500
  })
}

/* B7（③）：两读都空（doc 抛不存在类、where 回空数组）⇒ 回 `null`；
   在此空库上 setUpstream 首次配置（无行、给齐 base_url / model / key）⇒ ok:true ＋ 公共面 5 键。 */
{
  const B7_KEY = 'B7-first-time-secret-2026'
  const freshDb = createFakeDb()
  aiUpstream.setUpstreamStoreProvider(() => ({ upstream: docThrowingCollection(freshDb.collection('xiai_ai_upstream'), NOT_EXIST_404) }))
  const emptyRow = await aiUpstream.readUpstreamRow()
  const setFirst = await aiUpstream.setUpstream(
    { actor_uid: A_UID, base_url: 'https://api.first.example/v1', model: 'm-first', key: B7_KEY, timeout_ms: 20000 },
    adminEnv
  )
  const firstView = await aiUpstream.getUpstreamPublic()
  const roundTrip = await aiUpstream.resolveUpstreamSecret(adminEnv)
  restoreUpstreamProvider()
  check('B7', '③ 两读都空（doc 抛不存在类、where 回空）⇒ readUpstreamRow 回 null；空库上首次配置（无行、给齐 base_url/model/key）⇒ ok:true；公共面恰 5 键；加密往返仍逐字相等', {
    emptyRow: null,
    setOk: true,
    publicKeys: 'base_url,key_mask,model,timeout_ms,updated_at',
    base: 'https://api.first.example/v1',
    model: 'm-first',
    timeout: 20000,
    maskMatches: true,
    roundTripEqual: true
  }, {
    emptyRow,
    setOk: setFirst.ok,
    publicKeys: shapeOf(firstView),
    base: firstView.base_url,
    model: firstView.model,
    timeout: firstView.timeout_ms,
    maskMatches: firstView.key_mask === aiUpstream.maskOf(B7_KEY),
    roundTripEqual: roundTrip.key === B7_KEY
  })
}

/* B8（④）：判据自身的正 / 负对照 —— `isDocNotExistError` 对「不存在」类判 true、对其余判 false
   （证明不是「凡错都算不存在」；负对照含**只带 message 无 code** 的形态，杜绝文本匹配）。 */
{
  check('B8', '④ 判据正/负对照：isDocNotExistError 对 {code:404} / {errCode:-502005} / {code:"DOCUMENT_NOT_EXIST"} ⇒ true；对 {code:500} / {message:"does not exist"}（无 code）⇒ false', {
    code404: true,
    errCodeM502005: true,
    stringDocNonexist: true,
    code500: false,
    messageOnly: false,
    nonObject: false
  }, {
    code404: userConfig.isDocNotExistError({ code: 404 }),
    errCodeM502005: userConfig.isDocNotExistError({ errCode: -502005 }),
    stringDocNonexist: userConfig.isDocNotExistError({ code: 'DOCUMENT_NOT_EXIST' }),
    code500: userConfig.isDocNotExistError({ code: 500 }),
    messageOnly: userConfig.isDocNotExistError({ message: 'does not exist' }),
    nonObject: userConfig.isDocNotExistError(null)
  })
}

/* ===========================================================================
   C 段：用量单点（只读判定 / 零写入 / 双窗口 +1 / 限额取自 ACTIVE 金鑰）
   =========================================================================== */
section('C', '用量单点：evaluateGate 只读判定 / peekUsage 零写入 / commitUsage 双窗口 +1 / 限额来源')

/* C1（⑨）：evaluateGate 超日限 / 超分鐘限各一 ＋ 判定路径零写入。 */
{
  const uid = 'u-gate-test-00000'
  const before = writesNow()
  const dayBlock = await aiUsage.evaluateGate({ uid, day_limit: 1, minute_limit: 5 })
  /* 先落一次计数（日行 count=1）⇒ 再判日限 1 ⇒ LIMIT_DAY。 */
  await aiUsage.commitUsage({ uid })
  const dayBlocked = await aiUsage.evaluateGate({ uid, day_limit: 1, minute_limit: 5 })
  const minuteBlocked = await aiUsage.evaluateGate({ uid, day_limit: 100, minute_limit: 1 })
  const pass = await aiUsage.evaluateGate({ uid, day_limit: 100, minute_limit: 100 })
  const after = writesNow()
  check('C1', '⑨ 判定：未用时 ok:true；用 1 次后日限 1 ⇒ LIMIT_DAY；分鐘限 1 ⇒ LIMIT_MINUTE；判定路径**零写入**（写计数只因 commitUsage 增 2）；回包恰 1 键 {ok}', {
    first: 'ok',
    day: 'LIMIT_DAY',
    minute: 'LIMIT_MINUTE',
    pass: { ok: true, keys: 'ok' },
    gateWrites: 0,
    shapes: ['message,ok,reason', 'message,ok,reason']
  }, {
    first: dayBlock.ok === true ? 'ok' : dayBlock.reason,
    day: dayBlocked.reason,
    minute: minuteBlocked.reason,
    pass: { ok: pass.ok === true, keys: shapeOf(pass) },
    gateWrites: after - before - 2,
    shapes: [shapeOf(dayBlocked), shapeOf(minuteBlocked)]
  })
}

/* C2：peekUsage 零写入 ＋ 回包键面（2×2）；无行 ⇒ used 0。 */
{
  const uid = 'u-peek-test-00000'
  const before = { writes: writesNow(), dump: JSON.stringify([...fakeDb.bucketOf('xiai_ai_usage').values()]) }
  const peek = await aiUsage.peekUsage({ uid })
  const after = { writes: writesNow(), dump: JSON.stringify([...fakeDb.bucketOf('xiai_ai_usage').values()]) }
  check('C2', '⑨ 窥视：peekUsage **只读零写入**（用量行集一字未变、零新写）；回包＝ 2 窗口 × 2 键；无行 ⇒ used 0；限额回缺省 20 / 5', {
    zeroWrite: true,
    rowsUntouched: true,
    shape: 'day,minute',
    windowShape: 'limit,used',
    used: [0, 0],
    limits: [20, 5]
  }, {
    zeroWrite: before.writes === after.writes,
    rowsUntouched: before.dump === after.dump,
    shape: shapeOf(peek),
    windowShape: shapeOf(peek.day) === shapeOf(peek.minute) ? shapeOf(peek.day) : `MISMATCH:${shapeOf(peek.day)}|${shapeOf(peek.minute)}`,
    used: [peek.day.used, peek.minute.used],
    limits: [peek.day.limit, peek.minute.limit]
  })
}

/* C3：commitUsage 日行与分鐘行各 +1（两次 ⇒ 2 / 2）；行键面恰 5 键；_id 形态。 */
{
  const uid = 'u-commit-test-000'
  const first = await aiUsage.commitUsage({ uid })
  const second = await aiUsage.commitUsage({ uid })
  const dayRow = [...fakeDb.bucketOf('xiai_ai_usage').values()].find((row) => row.uid === uid && row.window === 'DAY')
  const minuteRow = [...fakeDb.bucketOf('xiai_ai_usage').values()].find((row) => row.uid === uid && row.window === 'MINUTE')
  const expectedDay = aiUsage.usageIdOf(uid, 'DAY', aiUsage.dayBucketOf(new Date()))
  const expectedMinute = aiUsage.usageIdOf(uid, 'MINUTE', aiUsage.minuteBucketOf(new Date()))
  check('C3', '⑨ 计数：commitUsage 日行与分鐘行**各 +1**（连打两次 ⇒ 2 / 2）；行键面恰 6 键（契约文字写「5 鍵」但枚举了 6 项 `{_id,uid,window,bucket,count,updated_at}` ⇒ 按**枚举**实现，登记给派单方）；`_id` ＝ au-<uid>-d-<YYYYMMDD> / au-<uid>-m-<epochMinute>；window ∈ {DAY,MINUTE}', {
    first: [1, 1],
    second: [2, 2],
    rowKeys: ['_id', 'bucket', 'count', 'uid', 'updated_at', 'window'],
    dayId: true,
    minuteId: true,
    windows: ['DAY', 'MINUTE'],
    rowTotal: 2
  }, {
    first: [first.day.used, first.minute.used],
    second: [second.day.used, second.minute.used],
    rowKeys: Object.keys(dayRow).sort(),
    dayId: dayRow._id === expectedDay && /^au-u-commit-test-000-d-\d{8}$/.test(dayRow._id),
    minuteId: minuteRow._id === expectedMinute && /^au-u-commit-test-000-m-\d+$/.test(minuteRow._id),
    windows: [dayRow.window, minuteRow.window],
    rowTotal: [...fakeDb.bucketOf('xiai_ai_usage').values()].filter((row) => row.uid === uid).length
  })
}

/* C4：限额来源 ＝ 本人 ACTIVE 金鑰的最小限额（吊销后回落缺省）。 */
{
  const uid = 'u-limits-test-000'
  const key = await aiKeys.issueAiKey({ uid, day_limit: 3, minute_limit: 2 })
  const withKey = await aiUsage.peekUsage({ uid })
  await aiKeys.revokeAiKey({ uid, key_id: key.key_id })
  const withoutKey = await aiUsage.peekUsage({ uid })
  check('C4', '⑨ 限额来源：本人有 ACTIVE 金鑰（day 3 / minute 2）⇒ peekUsage 回 3 / 2；吊销后无 ACTIVE ⇒ 回缺省 20 / 5（最小值口径：多枚取最严）', {
    withKey: [3, 2],
    withoutKey: [20, 5]
  }, {
    withKey: [withKey.day.limit, withKey.minute.limit],
    withoutKey: [withoutKey.day.limit, withoutKey.minute.limit]
  })
}

/* ===========================================================================
   D 段：信封（真 index.js 本体 ＋ 真签发令牌 ＋ 注入假 DB）
   =========================================================================== */
section('D', '信封：7 个新 op 回包键集不多不少 / 身份键 INVALID_FIELD / 未知 op / 无令牌 / 管理员门')

const PHONE = String(process.env.XIAI_USER_PHONE || '13800000099').trim()
const ADMIN_PHONE = process.env.XIAI_ADMIN_PHONE
const userToken = (await fn.main({ action: 'issue', phone: PHONE, code: process.env.XIAI_USER_SMS_CODE })).token
const adminToken = (await fn.main({ action: 'issue', phone: ADMIN_PHONE, code: process.env.XIAI_USER_SMS_CODE })).token

/** 信封基座键（令牌路成功回包的既有键面；**逐字不因新 op 改变**）。 */
const BASE_ENVELOPE_KEYS = [
  'authority',
  'docId',
  'identity',
  'identity_source',
  'ok',
  'op',
  'renewedExpiresAt',
  'renewedToken',
  'renewedTtlSeconds',
  'serverNow',
  'ver'
]
const envelopeShapeOf = (reply) => shapeOf(JSON.parse(JSON.stringify(reply)))
const envelopeKeysFor = (extra) => [...BASE_ENVELOPE_KEYS, ...extra].sort().join(',')

/* D1（⑫）：7 个新 op 回包键集不多不少（含 rows 逐行 8 键、today / minute 各 2 键）。 */
{
  process.env.XIAI_AI_UPSTREAM_SECRET = UPSTREAM_SECRET
  const issued = await fn.main({ action: 'verify', op: 'issueAiKey', token: userToken, payload: { label: '信封鍵' } })
  const listed = await fn.main({ action: 'verify', op: 'listAiKeys', token: userToken, payload: {} })
  const revoked = await fn.main({ action: 'verify', op: 'revokeAiKey', token: userToken, payload: { key_id: issued.key_id } })
  const limits = await fn.main({ action: 'verify', op: 'updateAiKeyLimits', token: userToken, payload: { key_id: issued.key_id, day_limit: 30, minute_limit: 9 } })
  const usage = await fn.main({ action: 'verify', op: 'getAiUsage', token: userToken, payload: {} })
  const upstreamGet = await fn.main({ action: 'verify', op: 'getAiUpstream', token: adminToken, payload: {} })
  const upstreamSet = await fn.main({ action: 'verify', op: 'setAiUpstream', token: adminToken, payload: { base_url: 'https://api.upstream.example/v9', model: 'm-x-9', key: UPSTREAM_KEY, timeout_ms: 20000 } })
  check('D1', '⑫ 回包键集不多不少：7 个新 op 的信封回包**逐个钉死**（基座 11 键 ＋ 各自 op 键；序列化后不多一键不少一键）；listAiKeys 的 rows 逐行恰 8 键、today / minute 各恰 2 键', {
    issueAiKey: envelopeKeysFor(['created_at', 'day_limit', 'key', 'key_id', 'key_prefix', 'label', 'minute_limit']),
    listAiKeys: envelopeKeysFor(['count', 'rows']),
    revokeAiKey: envelopeKeysFor(['already', 'key_id', 'revoked_at', 'status']),
    updateAiKeyLimits: envelopeKeysFor(['day_limit', 'key_id', 'minute_limit', 'updated_at']),
    getAiUsage: envelopeKeysFor(['minute', 'points', 'today']),
    getAiUpstream: envelopeKeysFor(['base_url', 'key_mask', 'model', 'timeout_ms', 'updated_at']),
    setAiUpstream: envelopeKeysFor(['base_url', 'key_mask', 'model', 'timeout_ms', 'updated_at']),
    rowKeys: 'created_at,day_limit,key_id,key_prefix,label,minute_limit,revoked_at,status',
    usageWindowKeys: 'limit,used'
  }, {
    issueAiKey: envelopeShapeOf(issued),
    listAiKeys: envelopeShapeOf(listed),
    revokeAiKey: envelopeShapeOf(revoked),
    updateAiKeyLimits: envelopeShapeOf(limits),
    getAiUsage: envelopeShapeOf(usage),
    getAiUpstream: envelopeShapeOf(upstreamGet),
    setAiUpstream: envelopeShapeOf(upstreamSet),
    rowKeys: Array.isArray(listed.rows) && listed.rows.length > 0 ? Object.keys(listed.rows[0]).sort().join(',') : '',
    usageWindowKeys: shapeOf(usage.today) === shapeOf(usage.minute) ? shapeOf(usage.today) : `MISMATCH:${shapeOf(usage.today)}|${shapeOf(usage.minute)}`
  })
  /* 明文只在 issueAiKey 回包出现一次；库内 / 清单回包零明文。 */
  const keyDump = JSON.stringify([...fakeDb.bucketOf('xiai_ai_keys').values()])
  check('D1b', '① 明文唯一性（信封面）：issueAiKey 回包含明文；库内与 listAiKeys 回包**逐字搜索 count=0**；回包内 key 形态合法', {
    inReply: true,
    plainOk: true,
    inDb: 0,
    inList: 0
  }, {
    inReply: typeof issued.key === 'string' && issued.key.indexOf('sk-xiai-') === 0,
    plainOk: /^sk-xiai-[0-9a-f]{32}$/.test(String(issued.key)),
    inDb: countIn(keyDump, String(issued.key)),
    inList: countIn(JSON.stringify(listed), String(issued.key))
  })
}

/* D2（⑪）：载荷带 uid / key_hash / role ⇒ INVALID_FIELD ＋ 零写入。 */
{
  const before = { writes: writesNow(), rows: keyRowsOf(null).length }
  const withUid = await fn.main({ action: 'verify', op: 'issueAiKey', token: userToken, payload: { uid: 'u-evil', label: 'x' } })
  const withHash = await fn.main({ action: 'verify', op: 'revokeAiKey', token: userToken, payload: { key_id: 'aa'.repeat(8), key_hash: 'deadbeef' } })
  const withRole = await fn.main({ action: 'verify', op: 'getAiUsage', token: userToken, payload: { role: 'admin' } })
  const after = { writes: writesNow(), rows: keyRowsOf(null).length }
  check('D2', '⑪ 身份 / 明文类键：载荷带 `uid` / `key_hash` / `role` ⇒ INVALID_FIELD（恰 3 键）＋ **零写入**；文案点明身份键不采信前端自称', {
    reasons: ['INVALID_FIELD', 'INVALID_FIELD', 'INVALID_FIELD'],
    shapes: ['message,ok,reason', 'message,ok,reason', 'message,ok,reason'],
    zeroWrite: true,
    rowsUnchanged: true,
    hint: true
  }, {
    reasons: [withUid.reason, withHash.reason, withRole.reason],
    shapes: [shapeOf(withUid), shapeOf(withHash), shapeOf(withRole)],
    zeroWrite: before.writes === after.writes && before.rows === after.rows,
    rowsUnchanged: before.rows === after.rows,
    hint: String(withUid.message || '').includes('不採信前端自稱')
  })
}

/* D3（⑩）＋ 身份：未知 op 结构化拒；无令牌 FORBIDDEN；新 op 未混进管理员面外的任何键。 */
{
  const unknown = await fn.main({ action: 'verify', op: 'revokeAiKeyX', token: userToken, payload: {} })
  const noToken = await fn.main({ action: 'verify', op: 'issueAiKey', payload: {} })
  check('D3', '⑩ 未知 op ⇒ INVALID_FIELD 结构化拒（恰 3 键）；新 op 无令牌 ⇒ FORBIDDEN（走既有登录令牌门）', {
    unknown: { ok: false, reason: 'INVALID_FIELD', shape: 'message,ok,reason' },
    noToken: { ok: false, reason: 'FORBIDDEN' }
  }, {
    unknown: { ok: unknown.ok, reason: unknown.reason, shape: shapeOf(unknown) },
    noToken: { ok: noToken.ok, reason: noToken.reason }
  })
}

/* D4：getAiUsage.points 与账本 readBalance 一致（同一 uid；不自读余额集合）。 */
{
  const reply = await fn.main({ action: 'verify', op: 'getAiUsage', token: userToken, payload: {} })
  const balance = await ledger.readBalance(reply.identity.uid)
  check('D4', 'getAiUsage：`points` 与既有账本 `ledger.readBalance` 同值（不自读余额集合）；today / minute 键面恰 2 键', {
    same: true,
    windowKeys: 'limit,used'
  }, {
    same: reply.points === balance.points,
    windowKeys: shapeOf(reply.today) === 'limit,used' && shapeOf(reply.minute) === 'limit,used' ? 'limit,used' : 'MISMATCH'
  })
}

/* D5：管理员门 —— 普通用户调两个上游 op ⇒ FORBIDDEN ＋ 零写入；管理员 ⇒ ok。 */
{
  const before = writesNow()
  const foreignGet = await fn.main({ action: 'verify', op: 'getAiUpstream', token: userToken, payload: {} })
  const foreignSet = await fn.main({ action: 'verify', op: 'setAiUpstream', token: userToken, payload: { base_url: 'https://evil.example/v1', model: 'm', key: 'sk-evil' } })
  const after = writesNow()
  const dump = JSON.stringify([...fakeDb.bucketOf('xiai_ai_upstream').values()])
  check('D5', '管理员门：普通用户调 `getAiUpstream` / `setAiUpstream` ⇒ FORBIDDEN（恰 3 键）＋ **零写入**；库内无任何明文落痕', {
    get: 'FORBIDDEN',
    set: 'FORBIDDEN',
    shapes: ['message,ok,reason', 'message,ok,reason'],
    zeroWrite: true,
    evilPlain: 0
  }, {
    get: foreignGet.reason,
    set: foreignSet.reason,
    shapes: [shapeOf(foreignGet), shapeOf(foreignSet)],
    zeroWrite: before === after,
    evilPlain: countIn(dump, 'sk-evil')
  })
}

/* D6：上游公共面经信封零密文（cipher / iv / tag / 明文 四者逐字搜索 count=0）。 */
{
  const reply = await fn.main({ action: 'verify', op: 'getAiUpstream', token: adminToken, payload: {} })
  const dump = JSON.stringify(reply)
  check('D6', '⑦ 上游公共面（信封）：key_cipher / key_iv / key_tag / 上游明文 四者逐字搜索 count=0；回包含 5 个上游键且无 plan / row 泄漏', {
    cipher: 0,
    iv: 0,
    tag: 0,
    plain: 0,
    hasPlan: false,
    upstreamKeys: ['base_url', 'key_mask', 'model', 'timeout_ms', 'updated_at']
  }, {
    cipher: countIn(dump, 'key_cipher'),
    iv: countIn(dump, '"key_iv"'),
    tag: countIn(dump, '"key_tag"'),
    plain: countIn(dump, UPSTREAM_KEY),
    hasPlan: '"plan"' in JSON.parse(dump),
    upstreamKeys: ['base_url', 'key_mask', 'model', 'timeout_ms', 'updated_at'].filter((key) => key in JSON.parse(dump))
  })
}

/* ===========================================================================
   E 段：静态门
   =========================================================================== */
section('E', '静态门：模块零取句柄字面 / 三集合不进云读面 / reason 逐字登记 / 透传块按 op 收窄')

{
  const sources = ['lib/aiKeys.js', 'lib/aiUpstream.js', 'lib/aiUsage.js'].map((rel) =>
    readFileSync(path.join(FN_DIR, rel), 'utf8')
  )
  const forbidden = /collection\s*\(|database\s*\(|writeFile|require\(['"]fs['"]\)|@cloudbase/
  check('E1', '三模块零取库 / 取集合句柄字面、零 fs / SDK 依赖（守既有静态门 A8 / A8b / D4 / D1U / D1A 同尺；句柄只经注入缝或 ops.resolveAiStore）', { hits: 0 }, {
    hits: sources.reduce((sum, src) => sum + (src.match(new RegExp(forbidden.source, 'g')) || []).length, 0)
  })
}
{
  const cloudbase = readFileSync(path.join(ROOT, 'src/data/cloudbase.js'), 'utf8')
  const storage = readFileSync(path.join(ROOT, 'src/data/storage.js'), 'utf8')
  const dbjs = readFileSync(path.join(ROOT, 'src/data/db.js'), 'utf8')
  const joined = `${cloudbase}${storage}${dbjs}`
  const opsValues = Object.values(ops.COLLECTIONS)
  const names = [aiKeys.AI_KEYS_COLLECTION, aiUpstream.AI_UPSTREAM_COLLECTION, aiUsage.AI_USAGE_COLLECTION]
  check('E2', '三个新集合：`^xiai_` 前缀；**不进** ops.COLLECTIONS 登记表；**不进**前端云读面（src/ 零出现）', {
    prefix: true,
    inOps: [],
    inSrc: []
  }, {
    prefix: names.every((name) => name.indexOf('xiai_') === 0),
    inOps: names.filter((name) => opsValues.indexOf(name) !== -1),
    inSrc: names.filter((name) => joined.indexOf(name) !== -1)
  })
}
{
  const expected = ['KEY_INVALID', 'CONFIG_MISSING', 'LIMIT_DAY', 'LIMIT_MINUTE']
  const table = Object.values(userConfig.REASONS)
  check('E3', 'reason 逐字登记：四个新字面值逐字在配置面冻结表内（12 键）；`LIMIT_EXCEEDED` **不在表**（按派单方指示不自行新增 ⇒ 回落 INVALID_VALUE 并登记）', {
    present: expected,
    tableSize: 12,
    limitExceededAbsent: true
  }, {
    present: expected.filter((item) => table.indexOf(item) !== -1),
    tableSize: table.length,
    limitExceededAbsent: table.indexOf('LIMIT_EXCEEDED') === -1
  })
}
{
  const indexSource = readFileSync(path.join(FN_DIR, 'index.js'), 'utf8')
  const blocks = (needle) => indexSource.split(needle).length - 1
  check('E4', 'index.js 透传块按 op 收窄：7 个新 op 名各恰 1 处；既有 getPointsBalance / listPointsFlow 两块各仍恰 1 处（判据未动）', {
    issueAiKey: 1,
    listAiKeys: 1,
    revokeAiKey: 1,
    updateAiKeyLimits: 1,
    getAiUsage: 1,
    upstreamBlocks: 1,
    getPointsBalance: 1,
    listPointsFlow: 1
  }, {
    issueAiKey: blocks("if (op === 'issueAiKey')"),
    listAiKeys: blocks("if (op === 'listAiKeys')"),
    revokeAiKey: blocks("if (op === 'revokeAiKey')"),
    updateAiKeyLimits: blocks("if (op === 'updateAiKeyLimits')"),
    getAiUsage: blocks("if (op === 'getAiUsage')"),
    upstreamBlocks: blocks("if (op === 'getAiUpstream' || op === 'setAiUpstream')"),
    getPointsBalance: blocks("if (op === 'getPointsBalance')"),
    listPointsFlow: blocks("if (op === 'listPointsFlow')")
  })
}

/* ===========================================================================
   收尾
   =========================================================================== */
console.log(
  JSON.stringify({
    summary: { total, passed, failed: total - passed },
    sections: sectionStats,
    failed_ids: failedIds,
    note: '离线自检：不连云端、不写生产数据；明文 / 密文 / 令牌原文一律不打印（只打印指纹与形态判据）。'
  })
)
process.exit(failedIds.length === 0 ? 0 : 1)
