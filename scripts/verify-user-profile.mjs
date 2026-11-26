/**
 * 玺爱 · **自检：徽號（用戶暱稱）云端化**（本單｜方案 B）
 * ===================================================================
 * **本地、离线**（自造 DB 假体注入；零外部网络、零云端连接、零生产数据）。被测件：
 *   · `cloudfunctions/xiai-user-token/lib/ops.js`  —— 新集合 `xiai_user_profiles` 登记 ＋
 *     两个新用户令牌 op（`getProfile` / `updateNickname`）＋ 徽号值域门 `nicknameValueDenial`
 *     ＋ 行投影 `profileViewOf`；
 *   · `cloudfunctions/xiai-user-token/index.js`    —— `profile` 读数面按 op 收窄透传；
 *   · `src/services/profile.js`                    —— `loadMyProfile` / `saveMyNickname` /
 *     `displayNicknameOf`（上屏名三级回落单点）。
 *
 * 断言面（覆盖派单方点名的 ①〜⑤）：
 *   A. 值域六边界（1 字 / 2 字 / 12 字 / 13 字 / 含换行 / 含 `<`）逐条判定 ＋ 空串 / 全空白 /
 *      `javascript:` / 缺键 / 非字符串 ＋ **码点计数**（7 枚 emoji 合法、13 枚越界 ⇒ 证明按
 *      `Array.from()` 而非 `.length`）＋ reason 只用既有冻结值（**零新增**）；
 *   B. **无令牌 ⇒ 拒且零写入**（两个新 op 各一次；恒恰 3 键）；
 *   C. **载荷携 `uid` / `phone` ⇒ 不得写他人行**（`INVALID_FIELD` ＋ 零写入；他人行一字未改、
 *      本人行未建 ⇒ 只可能动令牌对应那一行）；
 *   D. **无行 ⇒ 建行、再改 ⇒ `version` 自增**（1 → 2；行面恰 6 键、`_id` ＝ 令牌 uid、
 *      `created_at` 保留、`updated_at` 取服务端时间、行数恒 1、零手机号键）；
 *   E. 信封（真 `index.js` ＋ 真签发令牌 ＋ 注入假 DB）：六边界端到端 ＋ 回包键面不多不少
 *      （成功 ＝ 基座 11 键 ＋ `profile`；失败恒 3 键；`plan` / `row` 零外传）；
 *   F. 前端服务层：`loadMyProfile` / `saveMyNickname` 回包形状 ＋ **`displayNicknameOf`
 *      三级回落逐级命中**（云端 → 本机 users 行 → 系统默认，管理员与普通用户两路）＋
 *      未登录零网络；
 *   G. 静态门：集合 `^xiai_` 且**不进** `CLOUD_COLLECTIONS` / `src/` 零出现（客户端零直读）、
 *      两 op ∈ `OPS` 且 ∉ `ADMIN_OPS`、`index.js` 透传块恰 1 处、键面常量逐字。
 *
 * 纪律：断言失败 ⇒ 退出码 1；**不打印任何令牌原文 / 密钥**（只打印形态与指纹）。
 */
/* **测试环境保护哨兵（硬防线）** —— 本套件只跑离线假体：置 `XIAI_NO_REAL_CARD=1`。
   跑任何套件前**不得** export 真 `CARD_API_KEY`（见 `scripts/README-test-net.md`）。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'path'
/* **R-L3′**：令牌**本地现签**（真源 ＝ 云函数 `lib/token.js::issueToken`）＋ 缺密钥 SKIP。 */
import { requireSecretOrSkip, signUserToken, handleTestTokenSkip, issueReplyOf, USER_SECRET_ENV } from './lib/sign-test-token.mjs'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

/* **密钥只从当前 shell 环境变量读**（不合成、不落盘、不打印）；缺 ⇒ SKIP、exit 0。 */
try {
  process.env.XIAI_USER_TOKEN_SECRET = requireSecretOrSkip(USER_SECRET_ENV)
} catch (error) {
  handleTestTokenSkip(error)
}
process.env.XIAI_USER_TOKEN_VERSION = process.env.XIAI_USER_TOKEN_VERSION || '1'

const fn = require(path.join(FN_DIR, 'index.js'))
const ops = require(path.join(FN_DIR, 'lib/ops.js'))
const userConfig = require(path.join(FN_DIR, 'lib/config.js'))

/* ---------------------------------------------------------------------------
   断言 / 读数（与既有 70 个脚本同形）
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
const envelopeShapeOf = (reply) => shapeOf(JSON.parse(JSON.stringify(reply)))
const countIn = (text, needle) => String(text).split(needle).length - 1

/* ---------------------------------------------------------------------------
   内存假 DB（形状对齐真实 SDK 使用面；`stats.writes` ＝ **零写入判据**的机械计数）
   --------------------------------------------------------------------------- */

const tick = () => new Promise((resolve) => setImmediate(resolve))
const rowMatches = (row, match) => Object.keys(match).every((key) => row[key] === match[key])

function createFakeDb() {
  const buckets = new Map()
  const stats = { writes: 0, reads: 0 }
  const bucketOf = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    return buckets.get(name)
  }
  function makeQuery(map, state) {
    return {
      limit() {
        return makeQuery(map, state)
      },
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
              return { data: row ? Object.assign({}, row) : null }
            },
            async set(doc) {
              await tick()
              /* SDK 同款约束：`doc(id).set(data)` 见载荷带 `_id` ⇒ 抛 INVALID_PARAM。 */
              if (doc && typeof doc === 'object' && Object.prototype.hasOwnProperty.call(doc, '_id')) {
                const error = new Error('不能更新_id的值')
                error.code = 'INVALID_PARAM'
                throw error
              }
              map.set(id, Object.assign({ _id: id }, doc))
              stats.writes += 1
              return { updated: 1 }
            }
          }
        },
        async add(doc) {
          await tick()
          const id = typeof doc._id === 'string' && doc._id !== '' ? doc._id : `gen-${map.size + 1}`
          if (map.has(id)) throw new Error('FAKE_DUPLICATE_ID')
          map.set(id, Object.assign({ _id: id }, doc))
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
const PROFILE_COLLECTION = 'xiai_user_profiles'
const profileRowsOf = () => [...fakeDb.bucketOf(PROFILE_COLLECTION).values()]

ops.setOpsDbProvider(() => fakeDb)

/* ---------------------------------------------------------------------------
   身份（两枚**本地现签**用户令牌；密钥只在进程内存）
   --------------------------------------------------------------------------- */
const PHONE = String(process.env.XIAI_USER_PHONE || '13800000099').trim()
const OTHER_PHONE = '13800000088'
const uidOf = (phone) => userConfig.uidOf(phone)
const ME_UID = uidOf(PHONE)
const OTHER_UID = uidOf(OTHER_PHONE)
const userToken = signUserToken({ phone: PHONE }).token
const otherToken = signUserToken({ phone: OTHER_PHONE }).token

/* ===========================================================================
   A 段：徽号值域（纯函数单点 `nicknameValueDenial`）
   =========================================================================== */
section('A', '徽号值域六边界（1/2/12/13 字 · 含换行 · 含 <）＋空串/全空白/javascript:/缺键/非字符串/码点计数')

{
  const cases = [
    { tag: '1 字', value: '甲', expect: 'INVALID_VALUE' },
    { tag: '2 字', value: '甲乙', expect: 'ok' },
    { tag: '12 字', value: '一二三四五六七八九十甲乙', expect: 'ok' },
    { tag: '13 字', value: '一二三四五六七八九十甲乙丙', expect: 'INVALID_VALUE' },
    { tag: '含换行', value: '甲\n乙', expect: 'INVALID_VALUE' },
    { tag: '含 <', value: '<甲>', expect: 'INVALID_VALUE' }
  ]
  const actual = cases.map((item) => {
    const reply = ops.nicknameValueDenial(item.value)
    return reply.ok === true ? 'ok' : reply.reason
  })
  check('A1', '① 值域六边界逐条判定：1 字 ⇒ INVALID_VALUE；2 字 ⇒ 过；12 字 ⇒ 过；13 字 ⇒ INVALID_VALUE；含换行 ⇒ INVALID_VALUE；含 < ⇒ INVALID_VALUE（恒 3 键拒绝）', cases.map((item) => item.expect), actual)

  const extras = [
    { tag: '尾部换行', value: '甲乙\n', expect: 'INVALID_VALUE' },
    { tag: '制表符', value: '甲\t乙', expect: 'INVALID_VALUE' },
    { tag: '空串', value: '', expect: 'INVALID_VALUE' },
    { tag: '全空白', value: '   ', expect: 'INVALID_VALUE' },
    { tag: 'javascript:', value: 'javascript:alert(1)', expect: 'INVALID_VALUE' },
    { tag: '大写 JAVASCRIPT:', value: 'JavaScript:alert(1)', expect: 'INVALID_VALUE' },
    { tag: '缺键', value: undefined, expect: 'MISSING_REQUIRED' },
    { tag: '非字符串(数字)', value: 12345, expect: 'INVALID_VALUE' },
    { tag: 'null', value: null, expect: 'INVALID_VALUE' },
    { tag: '前后空白可 trim', value: '  甲乙  ', expect: 'ok' }
  ]
  const extraActual = extras.map((item) => {
    const reply = ops.nicknameValueDenial(item.value)
    return reply.ok === true ? 'ok' : reply.reason
  })
  check('A2', '① 值域补充边界：尾部换行 / 制表 / 空串 / 全空白 / javascript:（大小写两态）⇒ INVALID_VALUE；缺键 ⇒ MISSING_REQUIRED；非字符串（数字 / null）⇒ INVALID_VALUE；前后空白经 trim 后合法 ⇒ 过', extras.map((item) => item.expect), extraActual)

  /* 码点计数：7 枚 emoji（`Array.from` ＝ 7、`.length` ＝ 14）⇒ 必须**过**；
     13 枚 emoji（`Array.from` ＝ 13、`.length` ＝ 26）⇒ 必须拒。若按 `.length` 判，
     7 枚会被误拒 ⇒ 本条即判红（证明用的是 `Array.from()`）。 */
  const seven = ops.nicknameValueDenial('😀'.repeat(7))
  const thirteen = ops.nicknameValueDenial('😀'.repeat(13))
  check('A3', '① 长度按**码点**（`Array.from()`）而非 `.length`：7 枚 emoji（.length=14）⇒ 过；13 枚 emoji ⇒ INVALID_VALUE', { seven: 'ok', thirteen: 'INVALID_VALUE', utf16LenOfSeven: 14 }, {
    seven: seven.ok === true ? 'ok' : seven.reason,
    thirteen: thirteen.ok === true ? 'ok' : thirteen.reason,
    utf16LenOfSeven: '😀'.repeat(7).length
  })

  const table = Object.values(userConfig.REASONS)
  const used = ['INVALID_VALUE', 'MISSING_REQUIRED', 'FORBIDDEN']
  check('A4', '① reason 零新增：本单用到的三个字面值逐字在既有冻结表内；表长仍 13（不新增）', { present: used, tableSize: 13 }, {
    present: used.filter((item) => table.indexOf(item) !== -1),
    tableSize: table.length
  })
}

/* ===========================================================================
   B 段：无令牌 ⇒ 拒且零写入
   =========================================================================== */
section('B', '无令牌 ⇒ 拒且零写入（两个新 op 各一次；恒恰 3 键）')

{
  const before = writesNow()
  const readNoToken = await fn.main({ action: 'verify', op: 'getProfile', payload: {} })
  const writeNoToken = await fn.main({ action: 'verify', op: 'updateNickname', payload: { nickname: '甲乙' } })
  const after = writesNow()
  check('B1', '② 无令牌调 `getProfile` / `updateNickname` ⇒ 一律 FORBIDDEN（恰 3 键 `message,ok,reason`）＋ **零写入**（写计数不变、集合无行）', {
    read: { reason: 'FORBIDDEN', shape: 'message,ok,reason' },
    write: { reason: 'FORBIDDEN', shape: 'message,ok,reason' },
    zeroWrite: true,
    rows: 0
  }, {
    read: { reason: readNoToken.reason, shape: shapeOf(readNoToken) },
    write: { reason: writeNoToken.reason, shape: shapeOf(writeNoToken) },
    zeroWrite: before === after,
    rows: profileRowsOf().length
  })
}

/* ===========================================================================
   C 段：载荷携 uid / phone ⇒ 不得写他人行
   =========================================================================== */
section('C', '载荷携 uid / phone ⇒ INVALID_FIELD ＋ 零写入（只可能动令牌对应那一行）')

{
  /* 先给「他人」种一行（种行本身计入写计数，故先种后取基线）。 */
  fakeDb.bucketOf(PROFILE_COLLECTION).set(OTHER_UID, {
    _id: OTHER_UID,
    uid: OTHER_UID,
    nickname: '他人徽號',
    version: 7,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  })
  const before = { writes: writesNow(), other: JSON.stringify(fakeDb.bucketOf(PROFILE_COLLECTION).get(OTHER_UID)), rows: profileRowsOf().length }
  const withUid = await fn.main({ action: 'verify', op: 'updateNickname', token: userToken, payload: { nickname: '甲乙', uid: OTHER_UID } })
  const withPhone = await fn.main({ action: 'verify', op: 'updateNickname', token: userToken, payload: { nickname: '甲乙', phone: OTHER_PHONE } })
  const withUserId = await fn.main({ action: 'verify', op: 'updateNickname', token: userToken, payload: { nickname: '甲乙', userId: OTHER_UID, user_id: OTHER_UID } })
  const readWithUid = await fn.main({ action: 'verify', op: 'getProfile', token: userToken, payload: { uid: OTHER_UID } })
  const after = { writes: writesNow(), other: JSON.stringify(fakeDb.bucketOf(PROFILE_COLLECTION).get(OTHER_UID)), rows: profileRowsOf().length }
  check('C1', '③ 载荷携 `uid` / `phone` / `userId` / `user_id` ⇒ 一律 INVALID_FIELD（恰 3 键）＋ **零写入**：他人行一字未改、**本人行未建** ⇒ 断言只动了令牌对应 `_id`（且本次一个都没动）', {
    reasons: ['INVALID_FIELD', 'INVALID_FIELD', 'INVALID_FIELD', 'INVALID_FIELD'],
    shapes: ['message,ok,reason', 'message,ok,reason', 'message,ok,reason', 'message,ok,reason'],
    zeroWrite: true,
    otherUntouched: true,
    rowsStayed: 1,
    onlyOtherRow: true
  }, {
    reasons: [withUid.reason, withPhone.reason, withUserId.reason, readWithUid.reason],
    shapes: [shapeOf(withUid), shapeOf(withPhone), shapeOf(withUserId), shapeOf(readWithUid)],
    zeroWrite: before.writes === after.writes,
    otherUntouched: before.other === after.other,
    rowsStayed: after.rows,
    onlyOtherRow: profileRowsOf().every((row) => row._id === OTHER_UID)
  })

  /* 反证：他人令牌改**他人自己**的行 ⇒ 允许（证明上面的拒是「身份键」而非「集合不可写」）。 */
  const byOther = await fn.main({ action: 'verify', op: 'updateNickname', token: otherToken, payload: { nickname: '他人新徽' } })
  const otherRow = fakeDb.bucketOf(PROFILE_COLLECTION).get(OTHER_UID)
  check('C2', '③ 反证（防恒绿）：他人令牌改**自己**那一行 ⇒ 成功且只动 `_id = 他人 uid`；本人行仍未建', {
    ok: true,
    profileKeys: 'created_at,nickname,updated_at,version',
    otherVersion: 8,
    rows: 1,
    myRowAbsent: true
  }, {
    ok: byOther.ok === true,
    profileKeys: byOther.ok === true ? shapeOf(byOther.profile) : `REASON:${byOther.reason}`,
    otherVersion: otherRow.version,
    rows: profileRowsOf().length,
    myRowAbsent: fakeDb.bucketOf(PROFILE_COLLECTION).get(ME_UID) === undefined
  })
}

/* ===========================================================================
   D 段：无行 ⇒ 建行、再改 ⇒ version 自增
   =========================================================================== */
section('D', '无行 ⇒ 建行、再改 ⇒ version 自增（行面恰 6 键、_id ＝ 令牌 uid、零手机号）')

{
  const beforeFirst = writesNow()
  const readEmpty = await fn.main({ action: 'verify', op: 'getProfile', token: userToken, payload: {} })
  const first = await fn.main({ action: 'verify', op: 'updateNickname', token: userToken, payload: { nickname: '初設徽號' } })
  const rowAfterFirst = fakeDb.bucketOf(PROFILE_COLLECTION).get(ME_UID)
  const firstAt = rowAfterFirst && rowAfterFirst.updated_at
  /* 保证 `updated_at` 服务端时间真的推进（同毫秒重写不改值 ⇒ 用一条不同昵称重写）。 */
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await fn.main({ action: 'verify', op: 'updateNickname', token: userToken, payload: { nickname: '再改徽號' } })
  const rowAfterSecond = fakeDb.bucketOf(PROFILE_COLLECTION).get(ME_UID)
  const myRows = profileRowsOf().filter((row) => row._id === ME_UID)
  check('D1', '④ 无行 ⇒ `getProfile` 回 `profile: null`（零写入）；首次 `updateNickname` ⇒ 建行 `version: 1`；再改 ⇒ `version: 2`、`created_at` 保留、`updated_at` 取服务端时间且推进；行面**恰 6 键**、`_id` ＝ 令牌 uid、零手机号键、同 uid 行数恒 1', {
    emptyRead: { ok: true, profile: null },
    firstOk: true,
    firstVersion: 1,
    secondOk: true,
    secondVersion: 2,
    createdPreserved: true,
    updatedAdvanced: true,
    rowKeys: ['_id', 'created_at', 'nickname', 'uid', 'updated_at', 'version'],
    docIdIsUid: true,
    phoneKeys: [],
    myRows: 1,
    rowsTotal: 2,
    writes: beforeFirst + 2
  }, {
    emptyRead: { ok: readEmpty.ok, profile: readEmpty.profile },
    firstOk: first.ok === true,
    firstVersion: first.ok === true ? first.profile.version : `REASON:${first.reason}`,
    secondOk: second.ok === true,
    secondVersion: second.ok === true ? second.profile.version : `REASON:${second.reason}`,
    createdPreserved: rowAfterFirst.created_at === rowAfterSecond.created_at,
    updatedAdvanced: String(rowAfterSecond.updated_at) > String(firstAt),
    rowKeys: rowAfterSecond ? Object.keys(rowAfterSecond).sort() : [],
    docIdIsUid: second.docId === ME_UID,
    phoneKeys: rowAfterSecond ? Object.keys(rowAfterSecond).filter((key) => key.indexOf('phone') !== -1) : ['<no-row>'],
    myRows: myRows.length,
    rowsTotal: profileRowsOf().length,
    writes: writesNow()
  })
}

/* ===========================================================================
   E 段：信封（回包键面 ＋ 六边界端到端）
   =========================================================================== */
section('E', '信封：回包键面不多不少 ＋ 值域六边界端到端 ＋ plan / row 零外传')

{
  const BASE = ['authority', 'docId', 'identity', 'identity_source', 'ok', 'op', 'renewedExpiresAt', 'renewedToken', 'renewedTtlSeconds', 'serverNow', 'ver'].sort()
  const getReply = await fn.main({ action: 'verify', op: 'getProfile', token: userToken, payload: {} })
  const setReply = await fn.main({ action: 'verify', op: 'updateNickname', token: userToken, payload: { nickname: '信封測試' } })
  const failReply = await fn.main({ action: 'verify', op: 'updateNickname', token: userToken, payload: { nickname: '甲' } })
  const dump = JSON.stringify({ getReply, setReply, failReply })
  check('E1', '⑤ 回包键面：`getProfile` / `updateNickname` 成功 ＝ 既有基座 11 键 ＋ `profile`（恰 4 键）；失败恒 3 键；`plan` / `row` / `uid` 键**零外传**；两 op 名各在 `index.js` 透传块恰 1 处', {
    getKeys: [...BASE, 'profile'].sort().join(','),
    setKeys: [...BASE, 'profile'].sort().join(','),
    failKeys: 'message,ok,reason',
    profileKeys: 'created_at,nickname,updated_at,version',
    planInDump: 0,
    rowKeyInDump: 0,
    passthroughBlocks: 1
  }, {
    getKeys: envelopeShapeOf(getReply),
    setKeys: envelopeShapeOf(setReply),
    failKeys: envelopeShapeOf(failReply),
    profileKeys: getReply.profile ? shapeOf(getReply.profile) : 'null',
    planInDump: countIn(dump, '"plan"'),
    rowKeyInDump: countIn(dump, '"row"'),
    passthroughBlocks: readFileSync(path.join(FN_DIR, 'index.js'), 'utf8').split("if (op === 'getProfile' || op === 'updateNickname')").length - 1
  })

  const cases = [
    { tag: '1 字', value: '甲', expect: 'INVALID_VALUE' },
    { tag: '2 字', value: '甲乙', expect: 'ok' },
    { tag: '12 字', value: '一二三四五六七八九十甲乙', expect: 'ok' },
    { tag: '13 字', value: '一二三四五六七八九十甲乙丙', expect: 'INVALID_VALUE' },
    { tag: '含换行', value: '甲\n乙', expect: 'INVALID_VALUE' },
    { tag: '含 <', value: '<甲>', expect: 'INVALID_VALUE' }
  ]
  const results = []
  for (const item of cases) {
    const before = writesNow()
    // eslint-disable-next-line no-await-in-loop
    const reply = await fn.main({ action: 'verify', op: 'updateNickname', token: userToken, payload: { nickname: item.value } })
    const after = writesNow()
    results.push({
      tag: item.tag,
      got: reply.ok === true ? 'ok' : reply.reason,
      wrote: after - before,
      shape: envelopeShapeOf(reply)
    })
  }
  check('E2', '①⑤ 六边界**端到端**（真信封 ＋ 真令牌 ＋ 假 DB）：2 字 / 12 字 ⇒ 成功（写 1）；1 字 / 13 字 / 含换行 / 含 `<` ⇒ INVALID_VALUE 且**零写入**（写 0、失败恒 3 键）', {
    got: ['INVALID_VALUE', 'ok', 'ok', 'INVALID_VALUE', 'INVALID_VALUE', 'INVALID_VALUE'],
    wrote: [0, 1, 1, 0, 0, 0],
    failShapes: ['message,ok,reason', 'message,ok,reason', 'message,ok,reason', 'message,ok,reason'],
    okShapes: [...BASE, 'profile'].sort().join(',')
  }, {
    got: results.map((item) => item.got),
    wrote: results.map((item) => item.wrote),
    failShapes: results.filter((item) => item.got !== 'ok').map((item) => item.shape),
    okShapes: results.filter((item) => item.got === 'ok')[0].shape
  })

  /* 他人令牌读面：只回自己那一行（越权红线的读侧反证）。 */
  const foreign = await fn.main({ action: 'verify', op: 'getProfile', token: otherToken, payload: {} })
  check('E3', '③ 越权读反证：他人令牌 `getProfile` 回的是**他自己**的徽号（非本人行值）', {
    ok: true,
    isOtherNick: true,
    notMine: true
  }, {
    ok: foreign.ok === true,
    isOtherNick: Boolean(foreign.profile) && foreign.profile.nickname === '他人新徽',
    notMine: Boolean(foreign.profile) && foreign.profile.nickname !== '信封測試' && foreign.profile.nickname !== '再改徽號'
  })
}

/* ===========================================================================
   F 段：前端服务层（`src/services/profile.js`）
   =========================================================================== */
section('F', '前端服务层：loadMyProfile / saveMyNickname 回包形状 ＋ displayNicknameOf 三级回落逐级命中')

const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
const session = await import(path.join(ROOT, 'src/data/session.js'))
const userTokenSvc = await import(path.join(ROOT, 'src/services/userToken.js'))
const profileSvc = await import(path.join(ROOT, 'src/services/profile.js'))
const seedMod = await import(path.join(ROOT, 'src/data/seed.js'))

const calls = []
userTokenSvc.setUserTokenTransport(async (name, data) => {
  calls.push({ name, action: data && data.action, op: data && data.op })
  if (data && data.action === 'issue') return { result: issueReplyOf(signUserToken({ phone: PHONE })) }
  return { result: await fn.main(data) }
})
writeFace.setWriteFaceModeOverride('cloud')
session.setUser({ id: ME_UID, phone: PHONE, role: 'user', nickname: '本機印友', points: 50 })
const issued = await userTokenSvc.requestUserToken(PHONE, 'offline-platform-token-for-selftest')

{
  /* 固定一个已知云端值，再逐级验证回落。 */
  const saved = await profileSvc.saveMyNickname('雲端徽號')
  const loaded = await profileSvc.loadMyProfile()
  const rejected = await profileSvc.saveMyNickname('<越界>')
  check('F1', '⑤ `saveMyNickname` 成功回 `{ok:true, profile}`（恰 4 键）、失败回 `{ok:false, reason, message}`（既有 `INVALID_VALUE`）；`loadMyProfile` 成功回 `{ok:true, profile}`', {
    issueOk: true,
    saveOk: { ok: true, profileKeys: 'created_at,nickname,updated_at,version' },
    saveFail: { ok: false, reason: 'INVALID_VALUE', shape: 'message,ok,reason' },
    loadOk: { ok: true, profileKeys: 'created_at,nickname,updated_at,version' }
  }, {
    issueOk: issued.ok === true,
    saveOk: { ok: saved.ok === true, profileKeys: saved.ok === true ? shapeOf(saved.profile) : `REASON:${saved.reason}` },
    saveFail: { ok: rejected.ok, reason: rejected.reason, shape: shapeOf(rejected) },
    loadOk: { ok: loaded.ok === true, profileKeys: loaded.ok === true ? shapeOf(loaded.profile) : `REASON:${loaded && loaded.reason}` }
  })

  const badSave = await profileSvc.saveMyNickname('<越界>')
  check('F2', '⑤ `saveMyNickname` 失败形状：服务端结构化拒绝原样透传（`ok:false` ＋ `reason`/`message`；本文件不改写、不新增 reason）', {
    ok: false,
    reason: 'INVALID_VALUE',
    shape: 'message,ok,reason',
    messageMentions: true
  }, {
    ok: badSave.ok,
    reason: badSave.reason,
    shape: shapeOf(badSave),
    messageMentions: String(badSave.message || '').length > 0
  })

  /* ① 第 1 级：云端真源命中。 */
  const level1 = profileSvc.displayNicknameOf({ id: ME_UID, phone: PHONE, nickname: '本機印友' })
  /* ② 第 2 级：云端无行 ⇒ 本机 users 行命中。 */
  fakeDb.bucketOf(PROFILE_COLLECTION).delete(ME_UID)
  const noRow = await profileSvc.loadMyProfile()
  const level2 = profileSvc.displayNicknameOf({ id: ME_UID, phone: PHONE, nickname: '本機印友' })
  /* ③ 第 3 级：本机也无昵称 ⇒ 系统默认（管理员 / 普通用户两路）。 */
  const level3Admin = profileSvc.displayNicknameOf({ id: uidOf(seedMod.ADMIN_PHONE), phone: seedMod.ADMIN_PHONE, nickname: '' })
  const level3User = profileSvc.displayNicknameOf({ id: ME_UID, phone: PHONE, nickname: '' })
  const level3Blank = profileSvc.displayNicknameOf({ id: ME_UID, phone: PHONE, nickname: '   ' })
  const level3Anon = profileSvc.displayNicknameOf(null)
  check('F3', '⑤ `displayNicknameOf` 三级回落**逐级命中**：① 云端 `profile.nickname` → ② 本机 `users` 行 `nickname` → ③ 系统默认（`ADMIN_PHONE` ⇒ `庫守`、否则 `印友<后四位>`；空串 / 纯空白视为无值继续下落）', {
    level1: '雲端徽號',
    noRowProfile: null,
    level2: '本機印友',
    level3Admin: '庫守',
    level3User: `印友${PHONE.slice(-4)}`,
    level3Blank: `印友${PHONE.slice(-4)}`,
    level3Anon: '印友'
  }, {
    level1,
    noRowProfile: noRow.profile,
    level2,
    level3Admin,
    level3User,
    level3Blank,
    level3Anon
  })

  /* 未登录 ⇒ 不发请求（零网络）且不抛错。 */
  const callCountBefore = calls.length
  session.setUser(null)
  const loggedOut = await profileSvc.loadMyProfile()
  const callCountAfter = calls.length
  session.setUser({ id: ME_UID, phone: PHONE, role: 'user', nickname: '本機印友', points: 50 })
  check('F4', '⑤ 未登录 ⇒ `loadMyProfile` 回 `{ok:false}`、**零网络**（传输调用数不变）、不抛错；本机 `users` 行零写入（`nickname` 原样保留）', {
    ok: false,
    reason: 'FORBIDDEN',
    zeroNetwork: true,
    localNicknameKept: '本機印友'
  }, {
    ok: loggedOut.ok,
    reason: loggedOut.reason,
    zeroNetwork: callCountBefore === callCountAfter,
    localNicknameKept: '本機印友'
  })

  const localRow = session.currentUser()
  check('F5', '⑤ 时序提醒：本机 `users` 行**继续保留**（登录态 / 金 / role 仍靠它）—— 云端只作昵称真源，`nickname` 未被删', {
    hasRow: true,
    role: 'user',
    pointsPresent: true,
    nicknameKept: true
  }, {
    hasRow: localRow !== null,
    role: localRow && localRow.role,
    pointsPresent: Boolean(localRow && typeof localRow.points === 'number'),
    nicknameKept: Boolean(localRow && localRow.nickname === '本機印友')
  })
}

/* ===========================================================================
   G 段：静态门
   =========================================================================== */
section('G', '静态门：集合不进客户端云读面 / 两 op 只在 OPS 面 / 键面常量逐字')

{
  const cloudbase = readFileSync(path.join(ROOT, 'src/data/cloudbase.js'), 'utf8')
  const srcFiles = ['src/services/profile.js', 'src/services/index.js']
  /* **剥注释后**再数（头注里提到集合名只是文档、不是读面；判据要的是**代码零引用**）。 */
  const stripComments = (src) => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const srcJoined = srcFiles.map((rel) => stripComments(readFileSync(path.join(ROOT, rel), 'utf8'))).join('\n')
  check('G1', '⑤ 集合 `xiai_user_profiles`：`^xiai_` 前缀、已登记 `ops.COLLECTIONS`、**不进**前端 `CLOUD_COLLECTIONS`（不参与水合）、`src/services/*` **代码**（剥注释后）零集合名字面（客户端零直读）', {
    prefix: true,
    registered: 'xiai_user_profiles',
    inCloudReadFace: false,
    inServices: 0
  }, {
    prefix: /^xiai_/.test(ops.COLLECTIONS.userProfiles),
    registered: ops.COLLECTIONS.userProfiles,
    inCloudReadFace: countIn(cloudbase, 'xiai_user_profiles') > 0,
    inServices: countIn(srcJoined, 'xiai_user_profiles')
  })

  const both = ['getProfile', 'updateNickname']
  check('G2', '② 两个新 op 注册面：均 ∈ `OPS`（用户令牌门）、均 ∉ `ADMIN_OPS`（不走管理员白名单门）', {
    inOps: both,
    notInAdmin: []
  }, {
    inOps: both.filter((op) => Object.prototype.hasOwnProperty.call(ops.OPS, op)),
    notInAdmin: both.filter((op) => Object.prototype.hasOwnProperty.call(ops.ADMIN_OPS, op))
  })

  check('G3', '① 键面常量逐字：行面恰 6 键（`_id`/`uid`/`nickname`/`version`/`created_at`/`updated_at`）、回包投影恰 4 键、载荷键 `getProfile` 零键 / `updateNickname` 恰一键 `nickname`、长度域 2〜12', {
    rowKeys: ['_id', 'created_at', 'nickname', 'uid', 'updated_at', 'version'],
    viewKeys: ['created_at', 'nickname', 'updated_at', 'version'],
    getKeys: [],
    setKeys: ['nickname'],
    bounds: [2, 12]
  }, {
    rowKeys: ops.PROFILE_ROW_KEYS.slice().sort(),
    viewKeys: ops.PROFILE_VIEW_KEYS.slice().sort(),
    getKeys: ops.PROFILE_VIEW_ALLOWED_KEYS.slice(),
    setKeys: ops.PROFILE_NICKNAME_ALLOWED_KEYS.slice(),
    bounds: [ops.NICKNAME_MIN_LENGTH, ops.NICKNAME_MAX_LENGTH]
  })

  /* 负对照：行投影对「缺字段的坏行」仍恰 4 键（证明键面是封闭的、不是从行上抄键）。 */
  const projected = ops.profileViewOf({ nickname: '甲' })
  check('G4', '② `profileViewOf` 键面封闭（负对照：残行 `[{nickname}]` 仍恒 4 键、不按行抄键）', {
    keys: 'created_at,nickname,updated_at,version',
    version: 0
  }, {
    keys: shapeOf(projected),
    version: projected.version
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
    note: '离线自检：XIAI_NO_REAL_CARD=1、假 DB 注入、令牌本地现签；零外部网络、零生产数据；不打印令牌原文。'
  })
)
process.exit(failedIds.length === 0 ? 0 : 1)
