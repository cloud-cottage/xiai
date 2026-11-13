#!/usr/bin/env node
/**
 * 玺爱 · **印章浏览量 `view_count` ＋ 首页热度排序**自检（v1.110 / §3.87 ＋ §10.94 `AC-731` 〜 `AC-737`）
 * ============================================================================
 * **本地、离线、零网络、零云端、零生产数据**：注入式内存假 DB，跑的是
 * `cloudfunctions/xiai-user-token/index.js` 的**真实入口**（`main`）与
 * `lib/sealCards.js` / `lib/ops.js` 的**真实函数体**。
 *
 * 口径正本：`docs/seal-view-count-ruling-2026-11-14.md` ＋ `docs/xiai.spec.md` §3.87.1 〜 §3.87.7。
 *
 * 断言面（七组 `V1` 〜 `V7`；每条可机械判负，**正反成对**）：
 *   V1. **三页无重无漏**（`AC-731` / `AC-732`）：60 枚构成三页（`limit=20`）——
 *       三页 `stamp_id` 并集大小 ＝ 60、两两交集为空、`next_cursor` 形态 `off:<n>`
 *       （页 1 ＝ `off:20`、页 2 ＝ `off:40`、末页空串 ＋ `has_more:false`）。
 *   V2. **排序可判负**（`AC-731`）：`view_count` 降序；**同值按 `created_at` 降序**（3 行同值不同时间）；
 *       **`view_count` 缺失行排在有值行之后**（2 行缺失）。任一键序错 ⇒ 本组必红。
 *   V3. **非法游标 ⇒ `INVALID_VALUE` ＋ 零读取**（`AC-732`）：旧 `stamp_id` 形态 / `off:-1` /
 *       `off:12345678`（8 位）/ `S-1` / `off:abc` / `off:`（缺 `n`）/ 含空格 —— 逐发断言
 *       `reason` / 恰 3 键 / **假体 `stats.reads` 一字不增** / **零写**。
 *   V4. **`bumpSealView` 契约**（`AC-735`）：合法 ⇒ 该行 `view_count` **＋1（回读）** 且写面是
 *       `command.inc(1)`（原子哨兵）；未知键 ⇒ `INVALID_FIELD`；非字符串 / `trim` 后空 / 65 字
 *       ⇒ `INVALID_VALUE`；印章不存在 ⇒ `INVALID_VALUE` ＋ 回包**恰 3 键**；
 *       `PUBLIC_WRITE_OPS` **恰 1 成员**；表外 op 走 `public-write` ⇒ `FORBIDDEN` ＋ 零读写。
 *   V5. **双表分离**（`AC-734`）：`PUBLIC_OPS` 仍**恰 4 成员**且**其 op 零写入**（四个读 op 各打一发，
 *       `stats.writes` 一字不增）；两表交集为空、`bumpSealView` 不在 `PUBLIC_OPS` 内。
 *   V6. **回填 `repairSealViewCount`**（`AC-736`）：`dry_run` 不写；真写后 `view_count` 回读为 `0`
 *       且 `written` ＝ `eligible`；**同参重放 `written === 0`（幂等）**；回包**恒恰 5 键**；
 *       非管理员 ⇒ 拒 ＋ 零读写。
 *   V7. **卡片 DTO 仍恰 14 键且不含 `view_count`**（`AC-733`）。
 *
 * 纪律：不打印任何密钥 / 令牌；不碰任何服务；断言失败 ⇒ 退出码非 0。
 *
 * 用法：node scripts/verify-seal-view-count.mjs
 */

/* **测试环境保护哨兵（硬防线）** —— 本套件只跑离线假 CARD：置 `XIAI_NO_REAL_CARD=1`。
   若哪个调用点漏注入假传输，`lib/cardApi.js` 会**当场抛错、零请求**（绝不悄悄打生产 CARD）。
   跑任何套件前**不得** export 真 `CARD_API_KEY`（见 `scripts/README-test-net.md`）。 */
process.env.XIAI_NO_REAL_CARD = '1'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
   0. localStorage / window 假体（只为让 ESM 真源在本机 Node 下可导入；本套件不读它们）
   --------------------------------------------------------------------------- */
const memory = new Map()
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear()
}
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}

/* ---------------------------------------------------------------------------
   1. 断言
   --------------------------------------------------------------------------- */
const results = []
let failures = 0
function check(id, desc, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual)
  if (!ok) failures += 1
  results.push({ id, pass: ok })
  console.log(JSON.stringify({ id, case: desc, pass: ok, expected, actual }))
}
const sorted = (list) => list.slice().sort()
const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const section = (name, title) => console.log(JSON.stringify({ section: name, title }))

/* ---------------------------------------------------------------------------
   2. 注入式内存假 DB
   · 认等值键、`$or` / `$and` / `$nor`、`$regularExpression` / `$gte`、
     `command.gt` / `command.in` / **`command.inc`**（写面原子哨兵，`update` 时按数值累加）。
   · 链面 `where → orderBy×N / skip / limit / count / get / update`：**主路（服务端排序＋skip）
     与退路（内存同序）共用同一序**（`readSortedOffsetWindow` 的主路在本假体上真被走到）。
   · `stats.reads` / `stats.writes` 是**零读取 / 零写入**判据的读数源。
   --------------------------------------------------------------------------- */
function createStore(seedRows) {
  const collections = new Map()
  const stats = { writes: [], reads: 0 }
  const mapOf = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  const seedRow = (row) => {
    const name = row.__collection
    const copy = Object.assign({}, row)
    delete copy.__collection
    const map = mapOf(name)
    const key = String(copy._id || copy.id || `${name}-${map.size + 1}`)
    map.set(key, Object.assign({ _id: key }, copy))
    return key
  }
  ;(seedRows || []).forEach(seedRow)
  const command = {
    gt: (value) => ({ __op: 'gt', value }),
    in: (values) => ({ __op: 'in', values: Array.isArray(values) ? values.slice() : [] }),
    /* **原子自增哨兵**：`bumpSealView` 的唯一写面算子（`db.command.inc(1)`）。 */
    inc: (value) => ({ __op: 'inc', value: Number(value) })
  }
  const literal = (value) => (value === undefined || value === null ? '' : String(value))
  const matches = (row, match) =>
    Object.keys(match || {}).every((key) => {
      const expected = match[key]
      if (key === '$or') return Array.isArray(expected) && expected.some((clause) => matches(row, clause))
      if (key === '$and') return Array.isArray(expected) && expected.every((clause) => matches(row, clause))
      if (key === '$nor') return Array.isArray(expected) && expected.every((clause) => !matches(row, clause))
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        if (expected.$regularExpression) {
          const spec = expected.$regularExpression
          try {
            return new RegExp(String(spec.pattern), String(spec.options || '')).test(literal(row[key]))
          } catch (error) {
            return false
          }
        }
        if (expected.__op === 'gt') return literal(row[key]) > literal(expected.value)
        if (expected.__op === 'in') return expected.values.map((value) => String(value)).indexOf(String(row[key])) !== -1
        if (expected.__op === 'inc') return false /* 哨兵只出现在写面 doc 里，不参与匹配。 */
        if (expected.$gte !== undefined) {
          const num = Number(row[key])
          return Number.isFinite(num) && num >= Number(expected.$gte)
        }
      }
      return row[key] === expected
    })
  const compareOf = (sorts) => (left, right) => {
    for (const [field, direction] of sorts) {
      const a = left[field]
      const b = right[field]
      const missingA = a === undefined || a === null || a === ''
      const missingB = b === undefined || b === null || b === ''
      if (missingA || missingB) {
        if (missingA && missingB) continue
        /* 缺失当「最低档」：与生产 DB 把缺失视同 `null` 同向（升序在前、降序在后）。 */
        const cmp = missingA ? -1 : 1
        return direction === 'asc' ? cmp : -cmp
      }
      if (typeof a === 'number' && typeof b === 'number') {
        if (a === b) continue
        const cmp = a < b ? -1 : 1
        return direction === 'asc' ? cmp : -cmp
      }
      const sa = String(a)
      const sb = String(b)
      if (sa === sb) continue
      const cmp = sa < sb ? -1 : 1
      return direction === 'asc' ? cmp : -cmp
    }
    return 0
  }
  const provider = () => ({
    command,
    collection(name) {
      const map = mapOf(name)
      const all = () => [...map.values()].map((row) => Object.assign({}, row))
      const hit = (match) => all().filter((row) => matches(row, match))
      const chainOf = (match) => {
        const state = { sorts: [], skip: 0, limit: 0 }
        const api = {
          orderBy(field, direction) {
            state.sorts.push([field, String(direction || 'asc').toLowerCase()])
            return api
          },
          skip(n) {
            state.skip = Math.max(0, Math.floor(Number(n) || 0))
            return api
          },
          limit(n) {
            state.limit = Math.max(0, Math.floor(Number(n) || 0))
            return api
          },
          async count() {
            stats.reads += 1
            return { total: hit(match).length }
          },
          async get() {
            stats.reads += 1
            let rows = hit(match)
            if (state.sorts.length > 0) rows = rows.slice().sort(compareOf(state.sorts))
            if (state.skip > 0) rows = rows.slice(state.skip)
            if (state.limit > 0) rows = rows.slice(0, state.limit)
            return { data: rows }
          },
          async update(doc) {
            const rows = hit(match)
            for (const row of rows) {
              const key = String(row._id || row.id)
              const current = Object.assign({}, map.get(key))
              for (const field of Object.keys(doc || {})) {
                const value = doc[field]
                if (value && typeof value === 'object' && value.__op === 'inc') {
                  current[field] = Number(current[field] || 0) + Number(value.value)
                } else {
                  current[field] = value
                }
              }
              map.set(key, current)
            }
            stats.writes.push({ collection: name, action: 'update', match, doc, count: rows.length })
            return { updated: rows.length }
          }
        }
        return api
      }
      return {
        where: (match) => chainOf(match),
        doc(id) {
          return {
            async get() {
              stats.reads += 1
              const row = map.get(String(id))
              return { data: row ? [Object.assign({}, row)] : [] }
            },
            async set(doc) {
              map.set(String(id), Object.assign({ _id: String(id) }, doc))
              stats.writes.push({ collection: name, action: 'set', id: String(id) })
              return { updated: 1 }
            },
            async remove() {
              map.delete(String(id))
              stats.writes.push({ collection: name, action: 'remove', id: String(id) })
              return { deleted: 1 }
            }
          }
        },
        async add(doc) {
          const id = String(doc && doc._id ? doc._id : `auto-${map.size + 1}`)
          map.set(id, Object.assign({ _id: id }, doc))
          stats.writes.push({ collection: name, action: 'add', id })
          return { id }
        }
      }
    }
  })
  return {
    stats,
    provider,
    rows: (name) => [...mapOf(name).values()].map((row) => Object.assign({}, row)),
    row: (name, id) => Object.assign({}, mapOf(name).get(String(id)) || {})
  }
}

/* ---------------------------------------------------------------------------
   3. 载入被测件 ＋ 注入假 DB（**离线进程内设值**；生产真源 ＝ 云函数环境变量）
   --------------------------------------------------------------------------- */
const ops = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))
const sealCards = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/sealCards.js'))
const fn = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/index.js'))

const FACE_SHA = 'b7'.repeat(32)
const PHONE = '13000000002' /* 合成管理员号（非真实凭据）。 */
const ADMIN_IDENTITY = { uid: 'u-admin-view-count', phone: PHONE, identity_source: 'SERVER_TOKEN' }
const ADMIN_CTX = () => ({ adminPhone: PHONE, nowSeconds: Math.floor(Date.now() / 1000) })

/** 一枚印章 ＋ 其主印面的种子（`face_count >= 1` ⇒ 才进命中集）。 */
function sealSeedRows(list) {
  const rows = []
  list.forEach((item, index) => {
    const stamp = item.stamp_id
    const seal = {
      __collection: 'xiai_seals',
      _id: stamp,
      stamp_id: stamp,
      seal_name: item.seal_name || `浏览量印${index + 1}`,
      dynasty: '汉',
      category: '吉语印',
      face_count: 1
    }
    if (item.view_count !== undefined) seal.view_count = item.view_count
    if (item.created_at !== undefined) seal.created_at = item.created_at
    rows.push(seal)
    rows.push({
      __collection: 'xiai_faces',
      _id: `fc-${stamp}`,
      id: `fc-${stamp}`,
      sealId: stamp,
      kind: 'FACE',
      face_no: 1,
      is_primary: true,
      face_image_id: `img-${stamp}`,
      image_sha256: FACE_SHA,
      image_mime: 'image/png',
      image_storage_key: `xiai/images/${FACE_SHA.slice(0, 2)}/${FACE_SHA}.png`
    })
  })
  return rows
}

let activeStore = null
const withStore = async (target, run) => {
  activeStore = target
  ops.setOpsDbProvider(target.provider)
  try {
    return await run()
  } finally {
    activeStore = null
    ops.setOpsDbProvider(null)
  }
}

/* 匿名读 / 匿名写调用面（**不设任何令牌 / 身份 env**）。 */
const publicCall = (op, payload) => fn.main({ action: 'public', op, payload })
const publicWriteCall = (op, payload) => fn.main({ action: 'public-write', op, payload })
const isDenial = (reply) => !!reply && reply.ok === false && typeof reply.reason === 'string' && reply.message !== undefined

/* ===========================================================================
   V1：三页无重无漏（60 枚 / limit=20）
   =========================================================================== */
section('V1', '三页无重无漏：60 枚 + limit=20 ⇒ 三页并集 60 / 交集空 / next_cursor 形态 off:<n>')
{
  const stamps = []
  for (let i = 1; i <= 60; i += 1) stamps.push({ stamp_id: `SV${String(i).padStart(7, '0')}`, view_count: 0, created_at: '2026-01-01T00:00:00.000Z' })
  const v1Store = createStore(sealSeedRows(stamps))
  await withStore(v1Store, async () => {
    const pages = []
    let cursor = ''
    for (let page = 0; page < 3; page += 1) {
      const reply = await publicCall('listSealCards', { limit: 20, cursor })
      const rows = Array.isArray(reply.rows) ? reply.rows : []
      pages.push({ reply, rows, cursor })
      cursor = reply.next_cursor
    }
    const idsOf = (page) => page.rows.map((row) => row.stamp_id)
    const all = pages.flatMap(idsOf)
    const uniqueAll = [...new Set(all)]
    const intersects = []
    for (let i = 0; i < pages.length; i += 1) {
      for (let j = i + 1; j < pages.length; j += 1) {
        const left = new Set(idsOf(pages[i]))
        idsOf(pages[j]).forEach((id) => {
          if (left.has(id)) intersects.push(id)
        })
      }
    }
    check('V1a', '三页各 20 枚（`rows.length` 三页同为 20）', [20, 20, 20], pages.map((page) => page.rows.length))
    check('V1b', '三页 `stamp_id` **并集大小 ＝ 60**（无漏）', 60, uniqueAll.length)
    check('V1c', '三页 `stamp_id` **两两交集为空**（无重）', [], intersects)
    check('V1d', '`next_cursor` 形态恒为 `off:<1〜7 位十进制非负整数>`（页 1 `off:20`、页 2 `off:40`、末页空串）；末页空串同理放行', {
      cursors: ['off:20', 'off:40', ''],
      forms: [true, true, true]
    }, {
      cursors: pages.map((page) => page.reply.next_cursor),
      forms: pages.map((page) => {
        const cursor = String(page.reply.next_cursor || '')
        return cursor === '' ? page.reply.has_more === false : sealCards.LIST_SEAL_CARDS_CURSOR_PATTERN.test(cursor)
      })
    })
    check('V1e', '`has_more` 三页依次 `true` / `true` / `false`（末页如实「已到底」）', [true, true, false], pages.map((page) => page.reply.has_more))
    check('V1f', '`total` 三页恒 ＝ 命中总数 60（口径不变）', [60, 60, 60], pages.map((page) => page.reply.total))
    check('V1g', '三页全流程 **零写入**', 0, v1Store.stats.writes.length)
  })
}

/* ===========================================================================
   V2：排序可判负（view_count desc → created_at desc；缺失行排在有值行之后）
   =========================================================================== */
section('V2', '排序三键：view_count 降序 → 同值按 created_at 降序；view_count 缺失行排在所有有值行之后')
{
  /* 5 行有值（其中 3 行同值 5、时间递增）＋ 2 行**缺 view_count**（时间递增）。 */
  const seeds = [
    { stamp_id: 'SV-A', view_count: 5, created_at: '2026-01-01T00:00:00.000Z' },
    { stamp_id: 'SV-B', view_count: 5, created_at: '2026-02-01T00:00:00.000Z' },
    { stamp_id: 'SV-C', view_count: 5, created_at: '2026-03-01T00:00:00.000Z' },
    { stamp_id: 'SV-D', view_count: 9, created_at: '2025-12-01T00:00:00.000Z' },
    { stamp_id: 'SV-E', view_count: 1, created_at: '2026-04-01T00:00:00.000Z' },
    { stamp_id: 'SV-F', created_at: '2026-05-01T00:00:00.000Z' },
    { stamp_id: 'SV-G', created_at: '2026-06-01T00:00:00.000Z' }
  ]
  const v2Store = createStore(sealSeedRows(seeds))
  await withStore(v2Store, async () => {
    const reply = await publicCall('listSealCards', { limit: 10 })
    const rows = Array.isArray(reply.rows) ? reply.rows : []
    const order = rows.map((row) => row.stamp_id)
    /* 卡片 DTO **不带** `view_count`（恰 14 键，AC-733）⇒ 序的判据取「种子值 → 编号」映射
       （不是从回包里读，回包里本就没有这个字段）。 */
    const seedValueOf = new Map(seeds.map((item) => [item.stamp_id, item.view_count]))
    const orderValues = order.map((id) => seedValueOf.get(id))
    const nonIncreasing = orderValues.every((value, index) => index === 0 || (value === undefined ? true : (orderValues[index - 1] === undefined ? false : orderValues[index - 1] >= value)))
    check('V2a', '`view_count` **严格降序**（9 → 5 → 5 → 5 → 1 → 缺 → 缺）——顺序与逐枚读数一并判负', {
      order: ['SV-D', 'SV-C', 'SV-B', 'SV-A', 'SV-E', 'SV-G', 'SV-F'],
      viewCounts: [9, 5, 5, 5, 1, undefined, undefined],
      nonIncreasing: true
    }, {
      order,
      viewCounts: orderValues,
      nonIncreasing
    })
    check('V2b', '**同 `view_count` 按 `created_at` 降序**（三行同为 5：03 > 02 > 01 ⇒ C / B / A）', ['SV-C', 'SV-B', 'SV-A'], order.filter((id) => ['SV-A', 'SV-B', 'SV-C'].indexOf(id) !== -1))
    check('V2c', '`view_count` **缺失行排在所有有值行之后**（有值 5 枚全在前，缺失 2 枚在后），且缺失行内部仍按 `created_at` 降序（G 06 > F 05）', {
      valuedFirst: true,
      missingTail: ['SV-G', 'SV-F']
    }, {
      valuedFirst: order.slice(0, 5).every((id) => ['SV-F', 'SV-G'].indexOf(id) === -1),
      missingTail: order.slice(5)
    })
    check('V2d', '排序键真源逐字 ＝ 三键 `view_count desc → created_at desc → stamp_id desc`（第三键只为稳定序）', [
      { field: 'view_count', direction: 'desc', numeric: true },
      { field: 'created_at', direction: 'desc', numeric: false },
      { field: 'stamp_id', direction: 'desc', numeric: false }
    ], sealCards.CARD_SEAL_SORT_KEYS.map((key) => ({ field: key.field, direction: key.direction, numeric: key.numeric })))
  })
}

/* ===========================================================================
   V3：非法游标 ⇒ INVALID_VALUE ＋ 零读取
   =========================================================================== */
section('V3', '非法游标（旧 stamp_id 形态 / off:-1 / off:12345678 / S-1 / off:abc / off: / 含空格）⇒ INVALID_VALUE ＋ 零读取')
{
  const seeds = [
    { stamp_id: 'SV000000001', view_count: 3, created_at: '2026-01-01T00:00:00.000Z' },
    { stamp_id: 'SV000000002', view_count: 2, created_at: '2026-01-02T00:00:00.000Z' },
    { stamp_id: 'SV000000003', view_count: 1, created_at: '2026-01-03T00:00:00.000Z' }
  ]
  const v3Store = createStore(sealSeedRows(seeds))
  await withStore(v3Store, async () => {
    const cases = [
      ['V3a', '旧 `stamp_id` 形态（`SV000000001`）', 'SV000000001'],
      ['V3b', '旧面候选形态（`fc-SV000000001-FACE`）', 'fc-SV000000001-FACE'],
      ['V3c', '负数偏移（`off:-1`）', 'off:-1'],
      ['V3d', '8 位偏移（`off:12345678`，超 7 位）', 'off:12345678'],
      ['V3e', '非本单形态（`S-1`）', 'S-1'],
      ['V3f', '非数字偏移（`off:abc`）', 'off:abc'],
      ['V3g', '缺数字（`off:`）', 'off:'],
      ['V3h', '含空格（`off: 48`）', 'off: 48']
    ]
    for (const [id, label, cursor] of cases) {
      const readsBefore = v3Store.stats.reads
      const writesBefore = v3Store.stats.writes.length
      const reply = await publicCall('listSealCards', { limit: 10, cursor })
      check(id, `非法游标${label} ⇒ \`INVALID_VALUE\` ＋ 恰 3 键 ＋ **零读取** ＋ 零写`, {
        ok: false,
        reason: 'INVALID_VALUE',
        keys: 'message,ok,reason',
        reads: 0,
        writes: 0
      }, {
        ok: reply.ok,
        reason: reply.reason,
        keys: shapeOf(reply),
        reads: v3Store.stats.reads - readsBefore,
        writes: v3Store.stats.writes.length - writesBefore
      })
    }
    /* 正对照：合法偏移确实读（否则「零读取」断言可能因整条路径不走 DB 而假绿）。 */
    const readsBeforeOk = v3Store.stats.reads
    const legal = await publicCall('listSealCards', { limit: 2, cursor: 'off:1' })
    check('V3i', '**正对照**：合法游标 `off:1` ⇒ 成功（5 键）＋ **确有读取**（读数 > 0）＋ 首枚为第 2 位（`view_count` 序的 `SV000000002`）', {
      ok: true,
      keys: 'has_more,next_cursor,ok,rows,total',
      readHappened: true,
      first: 'SV000000002'
    }, {
      ok: legal.ok,
      keys: shapeOf(legal),
      readHappened: v3Store.stats.reads - readsBeforeOk > 0,
      first: (legal.rows || [])[0] && (legal.rows || [])[0].stamp_id
    })
  })
}

/* ===========================================================================
   V4：bumpSealView 契约（公开写面）
   =========================================================================== */
section('V4', 'bumpSealView：合法 ⇒ view_count ＋1（回读；写面是 command.inc(1)）；载荷门 / 不存在 / 表外 op')
{
  const seeds = [
    { stamp_id: 'SV000000010', view_count: 4, created_at: '2026-01-01T00:00:00.000Z' },
    { stamp_id: 'SV000000011', view_count: 0, created_at: '2026-01-02T00:00:00.000Z' }
  ]
  const v4Store = createStore(sealSeedRows(seeds))
  await withStore(v4Store, async () => {
    /* ④ 表结构：`PUBLIC_WRITE_OPS` 恰 1 成员。 */
    const writeKeys = Object.keys(sealCards.PUBLIC_WRITE_OPS)
    check('V4a', '`PUBLIC_WRITE_OPS` **恰 1 成员** `bumpSealView`（函数）', { count: 1, keys: ['bumpSealView'], type: 'function' }, {
      count: writeKeys.length,
      keys: sorted(writeKeys),
      type: typeof sealCards.PUBLIC_WRITE_OPS.bumpSealView
    })
    /* ① 合法调用 ⇒ ＋1（回读，非「请求 200」）。 */
    const before = Number(v4Store.row('xiai_seals', 'SV000000010').view_count)
    const okReply = await publicWriteCall('bumpSealView', { stamp_id: 'SV000000010' })
    const after = Number(v4Store.row('xiai_seals', 'SV000000010').view_count)
    check('V4b', '合法 `stamp_id` ⇒ 成功回包**恰 1 键** `{ok:true}`，且该行 `view_count` **回读 ＋1**（4 → 5）', {
      ok: true,
      keys: 'ok',
      before: 4,
      after: 5
    }, {
      ok: okReply.ok,
      keys: shapeOf(okReply),
      before,
      after
    })
    const lastWrite = v4Store.stats.writes[v4Store.stats.writes.length - 1] || {}
    check('V4c', '写面是 **`command.inc(1)`（原子自增）**，不是「读值 → 写绝对值」（写 doc 的 `view_count` 为 inc 哨兵）', {
      collection: 'xiai_seals',
      action: 'update',
      incValue: 1,
      matched: 1
    }, {
      collection: lastWrite.collection,
      action: lastWrite.action,
      incValue: lastWrite.doc && lastWrite.doc.view_count && lastWrite.doc.view_count.__op === 'inc' ? lastWrite.doc.view_count.value : null,
      matched: lastWrite.count
    })
    /* ② 无幂等：连打 3 次 ⇒ ＋3（去重职责在客户端）。 */
    const before3 = Number(v4Store.row('xiai_seals', 'SV000000011').view_count)
    for (let i = 0; i < 3; i += 1) await publicWriteCall('bumpSealView', { stamp_id: 'SV000000011' })
    check('V4d', '**无幂等**：同一枚连打 3 次 ⇒ `view_count` ＋3（0 → 3；服务端不得按 uid / 时间窗去重）', 3, Number(v4Store.row('xiai_seals', 'SV000000011').view_count) - before3)
    /* ③ 载荷门：未知键 ⇒ 载荷封闭 `INVALID_FIELD`（与全部既有 op 同口径；裁定 §6 只把三种
       `stamp_id` 值形态归 `INVALID_VALUE`）＋ 恰 3 键 ＋ 零读零写。 */
    const gates = [
      ['V4e', '未知键（`{stamp_id, extra}`）⇒ 载荷封闭 **`INVALID_FIELD`**', { stamp_id: 'SV000000010', extra: 1 }, 'INVALID_FIELD'],
      ['V4f', '非字符串（`stamp_id: 42`）⇒ `INVALID_VALUE`', { stamp_id: 42 }, 'INVALID_VALUE'],
      ['V4g', '`trim` 后空（`"   "`）⇒ `INVALID_VALUE`', { stamp_id: '   ' }, 'INVALID_VALUE'],
      ['V4h', '超 64 字（65 字）⇒ `INVALID_VALUE`', { stamp_id: 'S'.repeat(65) }, 'INVALID_VALUE'],
      ['V4i', '缺 `stamp_id` ⇒ `INVALID_VALUE`（空载荷不当作合法）', {}, 'INVALID_VALUE']
    ]
    for (const [id, label, payload, reason] of gates) {
      const readsBefore = v4Store.stats.reads
      const writesBefore = v4Store.stats.writes.length
      const reply = await publicWriteCall('bumpSealView', payload)
      check(id, `${label} ＋ 恰 3 键 ＋ **零读取** ＋ **零写入**`, {
        ok: false,
        reason,
        keys: 'message,ok,reason',
        reads: 0,
        writes: 0
      }, {
        ok: reply.ok,
        reason: reply.reason,
        keys: shapeOf(reply),
        reads: v4Store.stats.reads - readsBefore,
        writes: v4Store.stats.writes.length - writesBefore
      })
    }
    /* 边界正例：恰 64 字（trim 后）⇒ 形态门放行、因行不存在而落 `INVALID_VALUE` 的「不存在」分支
       （证 64 不被误拒成「超长」）。 */
    {
      const reply = await publicWriteCall('bumpSealView', { stamp_id: 'S'.repeat(64) })
      check('V4j', '边界正例：恰 64 字 ⇒ **不是超长拒绝**（`message` 指向「該印章不存在」而非长度）', {
        ok: false,
        reason: 'INVALID_VALUE',
        notFoundMessage: true
      }, {
        ok: reply.ok,
        reason: reply.reason,
        notFoundMessage: String(reply.message || '').indexOf('不存在') !== -1
      })
    }
    /* ⑤ 印章不存在 ⇒ `INVALID_VALUE` ＋ 回包**恰 3 键**（不得 `NOT_FOUND`、不得 2 键）。 */
    {
      const writesBefore = v4Store.stats.writes.length
      const reply = await publicWriteCall('bumpSealView', { stamp_id: 'ZZZZZ' })
      check('V4k', '印章不存在（`ZZZZZ`）⇒ `reason:"INVALID_VALUE"` ＋ 文案含「不存在」＋ 回包**恰 3 键** ＋ 零写（**不得 `NOT_FOUND`**）', {
        ok: false,
        reason: 'INVALID_VALUE',
        keys: 'message,ok,reason',
        notFoundMessage: true,
        writes: 0
      }, {
        ok: reply.ok,
        reason: reply.reason,
        keys: shapeOf(reply),
        notFoundMessage: String(reply.message || '').indexOf('不存在') !== -1,
        writes: v4Store.stats.writes.length - writesBefore
      })
    }
    /* ⑥ 表外 op 走 `public-write` ⇒ `FORBIDDEN` ＋ 零读零写（含公开读 op 与管理员 op）。 */
    for (const [id, label, op] of [
      ['V4l', '公开读 op `listSealCards`', 'listSealCards'],
      ['V4m', '管理员 op `repairSealViewCount`', 'repairSealViewCount'],
      ['V4n', '空 op', '']
    ]) {
      const readsBefore = v4Store.stats.reads
      const writesBefore = v4Store.stats.writes.length
      const reply = await publicWriteCall(op, { limit: 5, dry_run: true })
      check(id, `表外 op（${label}）走 \`public-write\` ⇒ \`FORBIDDEN\` ＋ 恰 3 键 ＋ 零读零写`, {
        ok: false,
        reason: 'FORBIDDEN',
        keys: 'message,ok,reason',
        reads: 0,
        writes: 0
      }, {
        ok: reply.ok,
        reason: reply.reason,
        keys: shapeOf(reply),
        reads: v4Store.stats.reads - readsBefore,
        writes: v4Store.stats.writes.length - writesBefore
      })
    }
  })
}

/* ===========================================================================
   V5：双表分离 —— PUBLIC_OPS 仍恰 4 成员且恒零写
   =========================================================================== */
section('V5', '双表分离：PUBLIC_OPS 仍恰 4 成员、四 op 各打一发零写入；与 PUBLIC_WRITE_OPS 交集为空')
{
  const seeds = [
    { stamp_id: 'SV000000020', view_count: 2, created_at: '2026-01-01T00:00:00.000Z' },
    { stamp_id: 'SV000000021', view_count: 1, created_at: '2026-01-02T00:00:00.000Z' }
  ]
  const v5Store = createStore([
    ...sealSeedRows(seeds),
    /* 印人行带 `card_id`（九位数字）⇒ `getPersonCard` 在 CARD 不可用时按本地行降级出数。 */
    { __collection: 'xiai_persons', _id: 'p-v5', id: 'p-v5', card_id: '000000789', family_name: '王', given_name: '文', alias_names: [], courtesy_names: [], art_names: [], dynasty: '清' }
  ])
  await withStore(v5Store, async () => {
    const readKeys = Object.keys(sealCards.PUBLIC_OPS)
    check('V5a', '`PUBLIC_OPS` **仍恰 4 成员**（`listSealCards` / `suggestAuthors` / `listPersonCards` / `getPersonCard`）', {
      count: 4,
      keys: ['getPersonCard', 'listPersonCards', 'listSealCards', 'suggestAuthors']
    }, {
      count: readKeys.length,
      keys: sorted(readKeys)
    })
    check('V5b', '两表**交集为空**、`bumpSealView` **不在** `PUBLIC_OPS` 内、`listSealCards` **不在** `PUBLIC_WRITE_OPS` 内', {
      intersect: [],
      bumpInRead: false,
      listInWrite: false
    }, {
      intersect: readKeys.filter((key) => Object.prototype.hasOwnProperty.call(sealCards.PUBLIC_WRITE_OPS, key)),
      bumpInRead: Object.prototype.hasOwnProperty.call(sealCards.PUBLIC_OPS, 'bumpSealView'),
      listInWrite: Object.prototype.hasOwnProperty.call(sealCards.PUBLIC_WRITE_OPS, 'listSealCards')
    })
    const writesBefore = v5Store.stats.writes.length
    const calls = [
      await publicCall('listSealCards', { limit: 5 }),
      await publicCall('suggestAuthors', { name: '王' }),
      await publicCall('listPersonCards', { include_biehao: false }),
      await publicCall('getPersonCard', { person_id: '000000789' })
    ]
    check('V5c', '四个公开读 op **各打一发、回包形态合规**（`ok:true` 且无 `reason`；逐 op 键面由既有套件断言）', [
      { ok: true, reason: '' },
      { ok: true, reason: '' },
      { ok: true, reason: '' },
      { ok: true, reason: '' }
    ], calls.map((reply) => ({ ok: reply.ok, reason: reply.reason || '' })))
    check('V5d', '四个公开读 op 合共 **零写入**（`PUBLIC_OPS` 恒零写，一字不动）', 0, v5Store.stats.writes.length - writesBefore)
  })
}

/* ===========================================================================
   V6：回填 repairSealViewCount（dry_run 不写 / 真写 ＋ 幂等 / 恰 5 键 / 非管理员拒）
   =========================================================================== */
section('V6', 'repairSealViewCount：dry_run 零写、真写后回读 view_count=0、重放 written=0（幂等）、回包恒恰 5 键')
{
  const seeds = [
    { stamp_id: 'SV000000030', created_at: '2026-01-01T00:00:00.000Z' }, /* 缺 view_count */
    { stamp_id: 'SV000000031', view_count: '3', created_at: '2026-01-02T00:00:00.000Z' }, /* 非整数（字符串） */
    { stamp_id: 'SV000000032', view_count: -2, created_at: '2026-01-03T00:00:00.000Z' }, /* < 0 */
    { stamp_id: 'SV000000033', view_count: 7, created_at: '2026-01-04T00:00:00.000Z' } /* 已合法 ⇒ 不动 */
  ]
  /* 种子行上非数值 `view_count` 走字符串，故先确认假体原样保留。 */
  const v6Store = createStore(sealSeedRows(seeds))
  const runRepair = (payload, identity, context) => ops.ADMIN_OPS.repairSealViewCount(payload, identity, context)
  await withStore(v6Store, async () => {
    const readFive = shapeOf({ ok: true, scanned: 1, eligible: 1, written: 1, next_cursor: 'x' })
    /* ② `dry_run` 缺省 true（`{}`）⇒ 零写、回包恰 5 键。 */
    const dryDefault = await runRepair({}, ADMIN_IDENTITY, ADMIN_CTX())
    check('V6a', '`{dry_run}` 缺省 ⇒ **演算（零写入）**；回包**恰 5 键** `{ok,scanned,eligible,written,next_cursor}`；`written` 恒 0', {
      ok: true,
      keys: readFive,
      scanned: 4,
      eligible: 3,
      written: 0,
      writes: 0
    }, {
      ok: dryDefault.ok,
      keys: shapeOf(dryDefault),
      scanned: dryDefault.scanned,
      eligible: dryDefault.eligible,
      written: dryDefault.written,
      writes: v6Store.stats.writes.length
    })
    /* ③ 显式 `dry_run:true` 同形、同零写。 */
    const dryExplicit = await runRepair({ dry_run: true }, ADMIN_IDENTITY, ADMIN_CTX())
    check('V6b', '显式 `dry_run:true` ⇒ 与缺省**同形同读**（恰 5 键、`written` 0、零写）', {
      keys: readFive,
      eligible: 3,
      written: 0,
      writes: 0
    }, {
      keys: shapeOf(dryExplicit),
      eligible: dryExplicit.eligible,
      written: dryExplicit.written,
      writes: v6Store.stats.writes.length
    })
    /* ④ 真写：`written` ＝ `eligible`，且回读该窗三行全为整数 0、已合法的行一字不动。 */
    const writesBefore = v6Store.stats.writes.length
    const real = await runRepair({ dry_run: false, limit: 500 }, ADMIN_IDENTITY, ADMIN_CTX())
    const afterRows = v6Store.rows('xiai_seals')
    const byId = (id) => afterRows.find((row) => row._id === id) || {}
    check('V6c', '`dry_run:false` ⇒ 真写：`written === eligible === 3`、回包恰 5 键、`scanned` ＝ 本窗扫描行数', {
      keys: readFive,
      scanned: 4,
      eligible: 3,
      written: 3
    }, {
      keys: shapeOf(real),
      scanned: real.scanned,
      eligible: real.eligible,
      written: real.written
    })
    check('V6d', '真写后**回读**：三条历史行 `view_count` **逐行落到整数 0**（缺字段 / 字符串 "3" / -2 三态全部回填）', [0, 0, 0, 7], [
      byId('SV000000030').view_count,
      byId('SV000000031').view_count,
      byId('SV000000032').view_count,
      byId('SV000000033').view_count
    ])
    check('V6e', '真写**只写 `view_count` 一个键**（其余字段一字未动：`seal_name` / `dynasty` / `face_count`）', {
      name: '浏览量印1',
      dynasty: '汉',
      faceCount: 1
    }, {
      name: byId('SV000000030').seal_name,
      dynasty: byId('SV000000030').dynasty,
      faceCount: byId('SV000000030').face_count
    })
    check('V6f', '真写恰好落 3 次写（已合法的第 4 行**一个字不写**）', 3, v6Store.stats.writes.length - writesBefore)
    /* ⑤ 幂等：同参重放 ⇒ eligible 0 / written 0 / 零写。 */
    const writesBeforeReplay = v6Store.stats.writes.length
    const replay = await runRepair({ dry_run: false, limit: 500 }, ADMIN_IDENTITY, ADMIN_CTX())
    check('V6g', '**同参重放（幂等）**：`eligible === 0`、`written === 0`、**零写**、回包仍恰 5 键', {
      keys: readFive,
      eligible: 0,
      written: 0,
      writes: 0
    }, {
      keys: shapeOf(replay),
      eligible: replay.eligible,
      written: replay.written,
      writes: v6Store.stats.writes.length - writesBeforeReplay
    })
    /* ⑥ 载荷门：`dry_run` 非布林 / `limit` 越界 / 未知键 ⇒ 拒 ＋ 零写（恰 3 键）。 */
    for (const [id, label, payload, reason] of [
      ['V6h', '`dry_run:"yes"`（非布林）', { dry_run: 'yes' }, 'INVALID_VALUE'],
      ['V6i', '`limit:0`（下界外）', { limit: 0 }, 'INVALID_VALUE'],
      ['V6j', '`limit:501`（上界外）', { limit: 501 }, 'INVALID_VALUE'],
      ['V6k', '未知键（`{nope:1}`）⇒ 载荷封闭 `INVALID_FIELD`', { nope: 1 }, 'INVALID_FIELD']
    ]) {
      const writesBeforeGate = v6Store.stats.writes.length
      const reply = await runRepair(payload, ADMIN_IDENTITY, ADMIN_CTX())
      check(id, `${label} ⇒ \`${reason}\` ＋ 恰 3 键 ＋ **零写**`, {
        ok: false,
        reason,
        keys: 'message,ok,reason',
        writes: 0
      }, {
        ok: reply.ok,
        reason: reply.reason,
        keys: shapeOf(reply),
        writes: v6Store.stats.writes.length - writesBeforeGate
      })
    }
    /* ⑦ 非管理员 ⇒ `FORBIDDEN` ＋ 零读写（门在**第一行**）。 */
    {
      const writesBeforeGate = v6Store.stats.writes.length
      const foreign = await runRepair({ dry_run: false }, { uid: 'u-x', phone: '13900000009', identity_source: 'SERVER_TOKEN' }, ADMIN_CTX())
      check('V6l', '非白名单身份 ⇒ `FORBIDDEN` ＋ 恰 3 键 ＋ **零读写**（管理员门在第一行）', {
        ok: false,
        reason: 'FORBIDDEN',
        keys: 'message,ok,reason',
        writes: 0
      }, {
        ok: foreign.ok,
        reason: foreign.reason,
        keys: shapeOf(foreign),
        writes: v6Store.stats.writes.length - writesBeforeGate
      })
    }
    /* ⑧ 缺 `XIAI_ADMIN_PHONE`（`context.adminPhone` 空）⇒ 安全拒（`STORAGE_UNAVAILABLE`，非 FORBIDDEN）＋ 零写。 */
    {
      const writesBeforeGate = v6Store.stats.writes.length
      const unconfigured = await runRepair({ dry_run: false }, ADMIN_IDENTITY, { adminPhone: '', nowSeconds: Math.floor(Date.now() / 1000) })
      check('V6m', '管理员面未配置（缺 phone）⇒ `STORAGE_UNAVAILABLE`（≠ `FORBIDDEN`）＋ 恰 3 键 ＋ **零写**', {
        ok: false,
        reason: 'STORAGE_UNAVAILABLE',
        keys: 'message,ok,reason',
        writes: 0
      }, {
        ok: unconfigured.ok,
        reason: unconfigured.reason,
        keys: shapeOf(unconfigured),
        writes: v6Store.stats.writes.length - writesBeforeGate
      })
    }
    /* ⑨ 冻结键面常量逐字。 */
    check('V6n', '冻结键面常量逐字：载荷恰 3 键 / 回包恰 5 键 / 回填值 0', {
      allowed: ['cursor', 'dry_run', 'limit'],
      readout: ['eligible', 'next_cursor', 'ok', 'scanned', 'written'],
      fill: 0
    }, {
      allowed: sorted(sealCards.REPAIR_SEAL_VIEW_COUNT_ALLOWED_KEYS),
      readout: sorted(sealCards.REPAIR_SEAL_VIEW_COUNT_READOUT_KEYS),
      fill: sealCards.REPAIR_SEAL_VIEW_COUNT_FILL_VALUE
    })
  })
}

/* ===========================================================================
   V7：卡片 DTO 仍恰 14 键且不含 view_count
   =========================================================================== */
section('V7', '卡片 DTO 仍恰 14 键、零 `view_count` 键、零 `view_count` 值（浏览数不上屏）')
{
  const v7Store = createStore(sealSeedRows([{ stamp_id: 'SV000000040', view_count: 12, created_at: '2026-01-01T00:00:00.000Z' }]))
  await withStore(v7Store, async () => {
    const reply = await publicCall('listSealCards', { limit: 5 })
    const row = (reply.rows || [])[0] || {}
    const cardKeys = [
      'category',
      'display_key',
      'dynasty',
      'edge_count',
      'face_count',
      'height',
      'image_id',
      'image_mime',
      'image_sha256',
      'primary_face_id',
      'seal_name',
      'stamp_id',
      'thumb_key',
      'width'
    ]
    check('V7a', '`rows` 每元素**恰 14 键**且键名逐字 ＝ 冻结表（`CARD_ROW_KEYS`）', {
      count: 14,
      keys: cardKeys
    }, {
      count: Object.keys(row).length,
      keys: sorted(Object.keys(row))
    })
    check('V7b', '卡片行**零 `view_count`**（既无键、也无值；热度序只影响顺序、不上屏）', {
      hasKey: false,
      values: 0
    }, {
      hasKey: Object.prototype.hasOwnProperty.call(row, 'view_count'),
      values: Object.keys(row).filter((key) => key === 'view_count').length
    })
    check('V7c', '该行在库内确有 `view_count:12`（证「不上屏」不是「没数据」造成的假绿）', 12, v7Store.row('xiai_seals', 'SV000000040').view_count)
  })
}

/* ===========================================================================
   收尾
   =========================================================================== */
const passed = results.filter((r) => r.pass).length
console.log(JSON.stringify({ summary: { total: results.length, passed, failures } }))
if (failures > 0) {
  console.error(`FAILED: ${failures} / ${results.length}`)
  process.exit(1)
}
