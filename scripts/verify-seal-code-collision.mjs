#!/usr/bin/env node
/**
 * 玺爱 · **印章撞码 / 整行覆盖 自检**（`scripts/verify-seal-code-collision.mjs`）
 * ============================================================================
 * 对应 2026-11-27 生产事故：新建印章【下里巴人】把既有幽灵章行 `AAADS` **整行覆盖**。
 *
 * **本地、离线、零网络、零云端**：注入式内存假 DB ＋ 真实云函数体
 * `cloudfunctions/xiai-user-token/lib/ops.js`（`index.js` 同一注册面）。**绝不碰生产库**。
 *
 * 四层防御里本套件逐层可判负：
 *   A. **第 1 层（避让谓词看码）**：遗留行占着码 `AAADS`（`encodeSealCode(81) === 'AAADS'`）
 *      而 `seal_no` 缺失 / 不等 ⇒ 新建**必须跳过该码**，且该行**逐字不变**（前后快照对拍）。
 *      三个变体：① `_id:'AAADS'`（事故形态）；② `_id` / `seal_no` / 码三者一致的既有行；
 *      ③ **码被占但 `_id` 不同**（只有第 1 层看得见 —— 变异负对照 ① 的靶子）。
 *   B. **第 2 层（写前存在性硬校验）**：印面行 `_id` 已在扫描行集里 ⇒ 换号（`f1` → `f2`）。
 *   C. **第 3 层（`kind:'create'` 不 upsert）**：已存在 `_id` 上的 `create` 写步 ⇒ 抛
 *      `DUPLICATE_ID`、**零写入**、既有行逐字不变；落到不存在 id ⇒ 正常落盘（正对照）。
 *      四条创建路径（`reviewSealImport` / `repairImportAcceptance` /
 *      `createSealWithFaceDirect` / `createSealUpload`）的印章行 / 印面行写步**恒为 `create`**，
 *      且其 plan 打到「计划期之后才出现的既有行」上时 **persist 必拒**。
 *   D. **第 4 层（静态）**：源文本 `kind: 'create'` 恰 8 处、避让谓词码判据在位、
 *      `persist` 的 `create` 分派在位。
 *
 * **变异负对照（≥2，必红）**：
 *   ① 把避让谓词改回「只看 `seal_no`」⇒ 撞码用例（A③）必红；
 *   ② 把创建写步改回 `kind:'set'` ⇒ 覆盖用例（C）必红。
 *   两次变异都把 `ops.js` 源**拷到临时目录**（改写 `require` 为绝对路径）再加载 —— **不改仓库里的
 *   任何文件**；变异没打中锚点 ⇒ 直接抛错（不静默）。
 *
 * 纪律：不打印任何密钥 / 令牌；不碰任何服务；断言失败 ⇒ 退出码非 0。
 * 用法：`node scripts/verify-seal-code-collision.mjs`
 */
process.env.XIAI_NO_REAL_CARD = '1'

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { createFakeCard, installFakeCard } from './fixtures/fake-card.mjs'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CF_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')
const OPS_PATH = path.join(CF_DIR, 'lib', 'ops.js')
const codeId = require(path.join(CF_DIR, 'lib', 'codeId.js'))

/* 哨兵 ＋ 假 CARD（本套件零真网；任何漏注入的调用当场抛、绝不联网）。 */
installFakeCard(createFakeCard())

/* --------------------------------------------------------------------------- *
   0. 断言收集（可复用：主跑逐条打印；变异跑只回读数）
   --------------------------------------------------------------------------- */
function makeRun(verbose) {
  const items = []
  let failed = 0
  const check = (id, desc, expected, actual) => {
    const pass = JSON.stringify(expected) === JSON.stringify(actual)
    if (!pass) failed += 1
    items.push({ id, desc, pass })
    if (verbose) console.log(JSON.stringify({ id, case: desc, pass, expected, actual }))
    return pass
  }
  return {
    check,
    get total() {
      return items.length
    },
    get failed() {
      return failed
    },
    failedIds: () => items.filter((item) => !item.pass).map((item) => item.id)
  }
}

const text = (v) => (v === undefined || v === null ? '' : String(v))
/** 递归按键排序的稳定序列化 —— 逐字对拍用（键序 / 值 / 键集任一变化即不等）。 */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`
}
const countOf = (haystack, needle) => haystack.split(needle).length - 1

/* --------------------------------------------------------------------------- *
   1. 注入式内存假 DB（与既有套件同形：平台单次 get 上限 100 ＋ 显式 limit/skip/orderBy；
      `doc(id).get()` 回 `{data:[…]}`；`set` 带 `_id` ⇒ 同 SDK 抛 INVALID_PARAM）
   --------------------------------------------------------------------------- */
const PLATFORM_GET_CAP = 100
function createStore(seedRows) {
  const collections = new Map()
  const stats = { writes: [], reads: 0 }
  const mapOf = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  const clone = (row) => JSON.parse(JSON.stringify(row))
  const seedRow = (row) => {
    const name = row.__collection
    const copy = Object.assign({}, row)
    delete copy.__collection
    const map = mapOf(name)
    const key =
      copy._id !== undefined && copy._id !== null
        ? String(copy._id)
        : copy.id !== undefined && copy.id !== null
          ? String(copy.id)
          : `${name}-${map.size + 1}`
    map.set(key, Object.assign({ _id: key }, copy))
    return key
  }
  ;(seedRows || []).forEach(seedRow)

  const provider = () => ({
    collection(name) {
      const map = mapOf(name)
      const all = () => [...map.values()].map(clone)
      const hit = (match) => all().filter((row) => Object.keys(match || {}).every((k) => row[k] === match[k]))
      return {
        limit(n) {
          const capped = Math.min(Number(n) || PLATFORM_GET_CAP, PLATFORM_GET_CAP)
          return { async get() { stats.reads += 1; return { data: all().slice(0, capped) } } }
        },
        async get() {
          stats.reads += 1
          return { data: all().slice(0, PLATFORM_GET_CAP) }
        },
        where(match) {
          let limit = 0
          let offset = 0
          let order = null
          const api = {
            limit(n) {
              limit = Number(n)
              return api
            },
            skip(n) {
              offset = Number(n)
              return api
            },
            orderBy(field, dir) {
              order = { field, dir }
              return api
            },
            async get() {
              stats.reads += 1
              let rows = hit(match)
              if (order) {
                rows = rows.slice().sort((a, b) => {
                  const av = text(a[order.field])
                  const bv = text(b[order.field])
                  const cmp = av < bv ? -1 : av > bv ? 1 : 0
                  return order.dir === 'desc' ? -cmp : cmp
                })
              }
              if (offset > 0) rows = rows.slice(offset)
              rows = limit > 0 ? rows.slice(0, limit) : rows.slice(0, PLATFORM_GET_CAP)
              return { data: rows }
            },
            async update(doc) {
              const rows = hit(match)
              rows.forEach((row) => {
                const key = String(row._id || row.id)
                map.set(key, Object.assign({}, map.get(key), doc))
              })
              stats.writes.push({ collection: name, action: 'update', match, count: rows.length })
              return { updated: rows.length }
            }
          }
          return api
        },
        doc(id) {
          return {
            async get() {
              stats.reads += 1
              const row = map.get(String(id))
              return { data: row ? [clone(row)] : [] }
            },
            async set(doc) {
              if (doc && typeof doc === 'object' && Object.prototype.hasOwnProperty.call(doc, '_id')) {
                const error = new Error('不能更新_id的值')
                error.code = 'INVALID_PARAM'
                throw error
              }
              map.set(String(id), Object.assign({ _id: String(id) }, doc))
              stats.writes.push({ collection: name, action: 'set', id: String(id) })
              return { updated: 1 }
            }
          }
        },
        async add(doc) {
          const id = String(doc && doc._id !== undefined && doc._id !== null ? doc._id : `auto-${map.size + 1}`)
          map.set(id, Object.assign({ _id: id }, doc))
          stats.writes.push({ collection: name, action: 'add', id })
          return { id }
        }
      }
    }
  })

  return {
    provider,
    stats,
    seed: (row) => seedRow(row),
    row: (collection, id) => {
      const found = mapOf(collection).get(String(id))
      return found ? clone(found) : null
    },
    count: (collection) => mapOf(collection).size,
    rows: (collection) => [...mapOf(collection).values()].map(clone)
  }
}

/* --------------------------------------------------------------------------- *
   2. 身份 / env（与 `verify-direct-write` 同尺）
   --------------------------------------------------------------------------- */
const ADMIN_PHONE = '13800000000'
const DIRECT_PHONE = '13900000001'
const SOURCE = 'feicui-local-dist'
const NOW = 1761600000
process.env.XIAI_DIRECT_WRITE_PHONE = DIRECT_PHONE
process.env.XIAI_DIRECT_WRITE_SOURCES = `${SOURCE},sealbank-local`

const ADMIN_IDENT = { uid: 'u-admin', phone: ADMIN_PHONE, role: 'admin', identity_source: 'SERVER_TOKEN' }
const DIRECT_IDENT = { uid: 'u-direct', phone: DIRECT_PHONE, role: 'user', identity_source: 'SERVER_TOKEN' }
const CTX = { adminPhone: ADMIN_PHONE, nowSeconds: NOW }

/* 号源：`seq:80` ⇒ 下一个发出的号恒 81 ⇒ `encodeSealCode(81) === 'AAADS'`（事故码）。 */
const COUNTER_SEED = [
  { __collection: 'xiai_counters', _id: 'seal', seq: 80 },
  { __collection: 'xiai_counters', _id: 'face', seq: 0 }
]
const shaOf = (tag) => createHash('sha256').update(String(tag), 'utf8').digest('hex')
const keyOf = (sha) => `xiai/images/${sha.slice(0, 2)}/${sha}.tiff`

/** 遗留幽灵章（事故形态：`_id` ＝ 码、`seal_name` / `seal_wen` / `author` 全空、无 `seal_no`）。 */
function ghostRow(extra) {
  return Object.assign(
    {
      __collection: 'xiai_seals',
      _id: 'AAADS',
      stamp_id: 'AAADS',
      sid: 'AAADS',
      seal_name: '',
      seal_wen: '',
      author: '',
      created_at: '2026-11-07T03:11:22.000Z',
      updated_at: '2026-11-07T03:11:22.000Z'
    },
    extra || {}
  )
}

function directFace(tag) {
  const sha = shaOf(tag)
  return {
    kind: 'FACE',
    seal_name: '撞碼印',
    dynasty: '清中期',
    seal_type: '私印',
    face_style: '浙派',
    seal_class: '流派印',
    author: '趙之謙',
    transcription: '撞碼釋文甲',
    image_storage_key: keyOf(sha),
    image_sha256: sha,
    image_bytes: 2048,
    image_mime: 'image/tiff',
    image_source_kind: 'yt'
  }
}
function directPayload(sourceSealId, tag) {
  return {
    source: SOURCE,
    source_seal_id: sourceSealId,
    seal_name: '撞碼印',
    dynasty: '清中期',
    seal_type: '私印',
    seal_style: '浙派',
    material: '石',
    shape: '方形',
    author: '趙之謙',
    transcription: '撞碼釋文甲',
    faces: [directFace(tag)]
  }
}

/* --------------------------------------------------------------------------- *
   3. 四条创建路径的 plan 构造（各起一个干净假库；只读 op 返回，不落盘）
   --------------------------------------------------------------------------- */
async function planOfDirect(ops, seedRows) {
  const store = createStore(seedRows)
  ops.setOpsDbProvider(store.provider)
  const res = await ops.ADMIN_OPS.createSealWithFaceDirect(directPayload('SS-C1', 'tag-c1'), DIRECT_IDENT, CTX)
  return { store, res }
}
async function planOfReview(ops) {
  const sha = shaOf('review-1')
  const store = createStore([
    ...COUNTER_SEED,
    {
      __collection: 'xiai_seal_imports',
      _id: 'si-1',
      id: 'si-1',
      batch_id: 'B-CC',
      status: 'PENDING',
      source: 'sealbank',
      source_seal_id: 'SS-R1',
      seal_name: '撞碼印',
      faces: [{ kind: 'FACE', image_sha256: sha, image_storage_key: keyOf(sha), image_bytes: 2048 }]
    },
    { __collection: 'xiai_images', _id: 'img-cc-1', sha256: sha, storage_key: keyOf(sha) }
  ])
  ops.setOpsDbProvider(store.provider)
  const res = await ops.ADMIN_OPS.reviewSealImport({ import_id: 'si-1', decision: 'ACCEPTED' }, ADMIN_IDENT, CTX)
  return { store, res }
}
async function planOfRepair(ops) {
  const store = createStore([
    {
      __collection: 'xiai_seal_imports',
      _id: 'si-2',
      id: 'si-2',
      batch_id: 'B-ORPH',
      status: 'ACCEPTED',
      source: 'sealbank',
      source_seal_id: 'SS-O1',
      seal_name: '孤兒印'
    }
  ])
  ops.setOpsDbProvider(store.provider)
  const res = await ops.ADMIN_OPS.repairImportAcceptance({ dry_run: false }, ADMIN_IDENT, CTX)
  return { store, res }
}
async function planOfUpload(ops) {
  const sha = shaOf('upload-1')
  const store = createStore([
    ...COUNTER_SEED,
    {
      __collection: 'xiai_persons',
      _id: 'PR000000310',
      id: 'PR000000310',
      code: 'PR000000310',
      card_id: '100000531',
      source: 'seed'
    }
  ])
  ops.setOpsDbProvider(store.provider)
  const res = await ops.ADMIN_OPS.createSealUpload(
    {
      seal_name: '上傳印',
      dynasty: '清中期',
      seal_type: '私印',
      seal_style: '浙派',
      material: '石',
      shape: '方形',
      author: '趙之謙',
      transcription: '上傳釋文甲',
      client_request_id: 'req-cc-1',
      faces: [
        {
          kind: 'FACE',
          seal_name: '上傳印',
          dynasty: '清中期',
          seal_type: '私印',
          author: '趙之謙',
          author_person_id: 'PR000000310',
          transcription: '上傳釋文甲',
          image_sha256: sha,
          image_bytes: 2048,
          image_storage_key: keyOf(sha)
        }
      ]
    },
    ADMIN_IDENT,
    CTX
  )
  return { store, res }
}

const writesOf = (res) => (res && res.plan && Array.isArray(res.plan.writes) ? res.plan.writes : [])
/** 四条路径的写步 kind 断言：印章行 / 印面行恒 `create`，影像行恒 `set`。 */
function assertCreateKinds(check, prefix, res) {
  const writes = writesOf(res)
  const sealWrites = writes.filter((w) => w.collection === 'xiai_seals')
  const faceWrites = writes.filter((w) => w.collection === 'xiai_faces')
  const imageWrites = writes.filter((w) => w.collection === 'xiai_images')
  check(`${prefix}k1`, `${prefix}：印章行写步恒 \`kind:'create'\``, ['create'], sealWrites.map((w) => w.kind))
  check(
    `${prefix}k2`,
    `${prefix}：印面行写步恒 \`kind:'create'\``,
    faceWrites.length > 0 ? ['create'] : [],
    faceWrites.map((w) => w.kind)
  )
  check(
    `${prefix}k3`,
    `${prefix}：影像登记行写步仍 \`kind:'set'\`（内容寻址幂等，未改）`,
    imageWrites.length > 0 ? ['set'] : [],
    imageWrites.map((w) => w.kind)
  )
}

/** 第 3 层行为：把「计划期之后才出现的既有行」塞进目标 `_id` ⇒ persist 必拒、行逐字不变。 */
async function assertNoOverwrite(check, prefix, ops, store, res) {
  const sealWrite = writesOf(res).find((w) => w.collection === 'xiai_seals')
  if (!sealWrite) {
    check(`${prefix}o0`, `${prefix}：plan 里确有印章行写步`, true, false)
    return
  }
  store.seed({
    __collection: 'xiai_seals',
    _id: sealWrite.id,
    stamp_id: sealWrite.id,
    sid: sealWrite.id,
    seal_name: '幽靈章',
    seal_wen: '',
    author: '',
    created_at: '2026-11-07T03:11:22.000Z',
    updated_at: '2026-11-07T03:11:22.000Z'
  })
  const before = store.row('xiai_seals', sealWrite.id)
  const beforeCount = store.count('xiai_seals')
  let thrown = null
  try {
    await ops.persist(res.plan)
  } catch (error) {
    thrown = error
  }
  const after = store.row('xiai_seals', sealWrite.id)
  check(
    `${prefix}o1`,
    `${prefix}：撞既有 \`_id\` ⇒ 抛 \`DUPLICATE_ID\`（不静默覆盖）`,
    true,
    !!thrown && String(thrown.message).indexOf('DUPLICATE_ID') !== -1
  )
  check(`${prefix}o2`, `${prefix}：既有行**逐字不变**（快照对拍）`, stable(before), stable(after))
  check(`${prefix}o3`, `${prefix}：既有行仍是「幽靈章」（未被改名）`, '幽靈章', after && after.seal_name)
  check(`${prefix}o4`, `${prefix}：印章行数不变（零新增）`, beforeCount, store.count('xiai_seals'))
}

/* --------------------------------------------------------------------------- *
   4. 主套件（对给定 ops 模块跑一遍；sourcePath 供静态断言用 —— 变异跑传变异文件）
   --------------------------------------------------------------------------- */
async function runSuite(ops, options) {
  const opts = options || {}
  const run = makeRun(opts.verbose === true)
  const check = run.check
  const sourcePath = opts.sourcePath || OPS_PATH

  /* A. 第 1 层：避让谓词看码（三个变体）。 */
  const encoded81 = codeId.encodeSealCode(81)
  check('A0', '前置：`encodeSealCode(81) === AAADS`（事故码，单点编码器）', 'AAADS', encoded81.ok && encoded81.code)

  /* A① 事故形态：`_id` / `stamp_id` 都是 `AAADS`、无 `seal_no`。 */
  {
    const store = createStore([...COUNTER_SEED, ghostRow()])
    ops.setOpsDbProvider(store.provider)
    const before = store.row('xiai_seals', 'AAADS')
    const res = await planOfDirectSeed(ops, store)
    check('A1', '① 幽灵章（`_id=AAADS`、无 `seal_no`）⇒ 直写新建成功', true, res.ok === true)
    check('A1b', '① 新建的 `sid` 必须**跳过** `AAADS`', true, res.ok === true && text(res.row && res.row.sid) !== 'AAADS')
    const writes = writesOf(res)
    check(
      'A1c',
      '① plan 写步 kind 恰为 `set`(影像) → `create`(印章) → `create`(印面)',
      ['set', 'create', 'create'],
      writes.map((w) => w.kind)
    )
    check('A1d', '① plan 的印章写步 `_id` 不是既有行的 `_id`', false, writes.some((w) => w.id === 'AAADS'))
    await persistQuiet(ops, res.plan)
    check('A1e', '① 遗留行**逐字不变**（persist 前后快照对拍）', stable(before), stable(store.row('xiai_seals', 'AAADS')))
    check('A1f', '① 新章已另起一行（印章行数 1 → 2）', 2, store.count('xiai_seals'))
    check('A1g', '① 新章名 = 下里巴人侧写入值（非幽灵行被改写）', '撞碼印', ((store.row('xiai_seals', text(res.row.sid)) || {})).seal_name)
  }

  /* A② 既有行 `_id` / `seal_no` / 码三者一致 ⇒ 同样不得覆盖。 */
  {
    const store = createStore([...COUNTER_SEED, ghostRow({ seal_no: 81, seal_name: '幽靈章' })])
    ops.setOpsDbProvider(store.provider)
    const before = store.row('xiai_seals', 'AAADS')
    const res = await planOfDirectSeed(ops, store)
    check('A2', '② 一致行（`seal_no=81`）⇒ 新建成功且跳过 `AAADS`', true, res.ok === true && text(res.row.sid) !== 'AAADS')
    await persistQuiet(ops, res.plan)
    check('A2b', '② 既有行**逐字不变**', stable(before), stable(store.row('xiai_seals', 'AAADS')))
  }

  /* A③ 码被占但 `_id` 不同（只有第 1 层谓词看得见 —— 变异 ① 的靶子）。 */
  {
    const store = createStore([
      ...COUNTER_SEED,
      ghostRow({ _id: 'ghost-0007', stamp_id: 'AAADS', sid: 'AAADS', seal_no: 7, seal_name: '幽靈章' })
    ])
    ops.setOpsDbProvider(store.provider)
    const before = store.row('xiai_seals', 'ghost-0007')
    const res = await planOfDirectSeed(ops, store)
    check('A3', '③ 码被 `stamp_id` 占（`_id` 不同、`seal_no=7`）⇒ 必须跳过 `AAADS`', true,
      res.ok === true && text(res.row && res.row.sid) !== 'AAADS')
    await persistQuiet(ops, res.plan)
    check('A3b', '③ 占码行**逐字不变**', stable(before), stable(store.row('xiai_seals', 'ghost-0007')))
  }

  /* B. 第 2 层：印面行 `_id` 已在扫描行集 ⇒ 换号（`f1` → `f2`）。 */
  {
    /* 幽灵章占 `AAADS` ⇒ 新章落 `AAADT` ⇒ 印面本该是 `fc-AAADT-f1`；该 `_id` 已被遗留面行占。 */
    const store = createStore([
      ...COUNTER_SEED,
      ghostRow(),
      { __collection: 'xiai_faces', _id: 'fc-AAADT-f1', seal_name: '遺留面' }
    ])
    ops.setOpsDbProvider(store.provider)
    const before = store.row('xiai_faces', 'fc-AAADT-f1')
    const res = await planOfDirectSeed(ops, store)
    const faceWrite = writesOf(res).find((w) => w.collection === 'xiai_faces')
    check('B1', '印面行 `_id` 已占 ⇒ 计划面 id **换号**（`fc-AAADT-f1` → `fc-AAADT-f2`）', 'fc-AAADT-f2',
      faceWrite && faceWrite.id)
    await persistQuiet(ops, res.plan)
    check('B2', '遗留面行**逐字不变**', stable(before), stable(store.row('xiai_faces', 'fc-AAADT-f1')))
  }

  /* C. 第 3 层：`kind:'create'` 在已存在 id 上 ⇒ 抛错、零写入；不存在 ⇒ 正常落盘。 */
  {
    const store = createStore([ghostRow({ seal_name: '幽靈章' })])
    ops.setOpsDbProvider(store.provider)
    const before = store.row('xiai_seals', 'AAADS')
    let thrown = null
    try {
      await ops.persist({
        op: 'unit-create',
        writes: [{ kind: 'create', collection: 'xiai_seals', id: 'AAADS', doc: { seal_name: '下里巴人', created_at: '2026-11-27T14:45:23.000Z' } }]
      })
    } catch (error) {
      thrown = error
    }
    check('C1', '已存在 `_id` 上的 `create` 写步 ⇒ 抛错', true, !!thrown)
    check('C2', '错误链含 `DUPLICATE_ID` 与 `WRITE_STEP_FAILED`（结构化、可定位）', true,
      !!thrown && String(thrown.message).indexOf('DUPLICATE_ID') !== -1 && String(thrown.message).indexOf('WRITE_STEP_FAILED') !== -1)
    check('C3', '**零写入**（写账 0）', 0, store.stats.writes.length)
    check('C4', '既有行**逐字不变**', stable(before), stable(store.row('xiai_seals', 'AAADS')))

    const fresh = createStore([])
    ops.setOpsDbProvider(fresh.provider)
    let ok = true
    try {
      await fresh && (await ops.persist({
        op: 'unit-create-ok',
        writes: [{ kind: 'create', collection: 'xiai_seals', id: 'ZZZZZ', doc: { seal_name: '新章' } }]
      }))
    } catch (error) {
      ok = false
    }
    check('C5', '正对照：不存在 `_id` 上的 `create` ⇒ 正常落盘', true, ok)
    check('C6', '正对照：行已落、内容正确', '新章', fresh.row('xiai_seals', 'ZZZZZ') && fresh.row('xiai_seals', 'ZZZZZ').seal_name)
    check('C7', '正对照：落盘走 `set` 路（写账恰 1 条 set）', ['set'], fresh.stats.writes.map((w) => w.action))
  }

  /* D. 第 3 层 · 四条创建路径：写步 kind ＋ 撞既有行必拒。 */
  {
    const direct = await planOfDirect(ops, [...COUNTER_SEED])
    check('D1', 'createSealWithFaceDirect ok', true, direct.res.ok === true)
    assertCreateKinds(check, 'D1', direct.res)
    await assertNoOverwrite(check, 'D1', ops, direct.store, direct.res)

    const review = await planOfReview(ops)
    check('D2', 'reviewSealImport ok', true, review.res.ok === true)
    assertCreateKinds(check, 'D2', review.res)
    check('D2k4', 'reviewSealImport：导入行状态翻转仍 `kind:"update"`（未改）', ['update'],
      writesOf(review.res).filter((w) => w.collection === 'xiai_seal_imports').map((w) => w.kind))
    await assertNoOverwrite(check, 'D2', ops, review.store, review.res)

    const repair = await planOfRepair(ops)
    check('D3', 'repairImportAcceptance ok', true, repair.res.ok === true)
    assertCreateKinds(check, 'D3', repair.res)
    await assertNoOverwrite(check, 'D3', ops, repair.store, repair.res)

    const upload = await planOfUpload(ops)
    check('D4', 'createSealUpload ok', true, upload.res.ok === true)
    assertCreateKinds(check, 'D4', upload.res)
    await assertNoOverwrite(check, 'D4', ops, upload.store, upload.res)
  }

  /* E. 第 4 层：静态源断言（读的是**本模块实际加载的那份源**）。 */
  {
    const source = readFileSync(sourcePath, 'utf8')
    check('E1', "源文本 `kind: 'create'` 恰 8 处（四条路径 × 印章行 / 印面行）", 8, countOf(source, "kind: 'create'"))
    /* **E2 断言修正（与实现真实行为对齐；判据只收紧、不放宽）**：`persist` 的 `create` 分派
       在源里**恰是两处**（旧断言数裸子串 `step.kind === 'create'`、期望 1 ⇒ 与实现不符恒红）：
         ① 写前**存在性预检** `if (step && step.kind === 'create')`；
         ② **落盘分派** `step.kind === 'set' || step.kind === 'create'`。
       故拆成两条**各自钉死恰 1 处**的断言（两处都在 ⇒ 才算分派在位）。 */
    check('E2a', "源文本 `create` 写前存在性预检分派恰 1 处", 1,
      countOf(source, "if (step && step.kind === 'create')"))
    check('E2b', "源文本 `set || create` 落盘分派恰 1 处", 1,
      countOf(source, "step.kind === 'set' || step.kind === 'create'"))
    check('E3', '避让谓词的**码判据**（stamp_id / sid / _id）在位', 1,
      countOf(source, "text(item && item.stamp_id) === code || text(item && item.sid) === code || text(item && item._id) === code"))
    check('E4', '避让谓词仍含 `seal_no` 原判据（未被改坏）', true,
      source.indexOf('sealCodeOccupiedBy') !== -1 && source.indexOf('Number(item && item.seal_no) === candidate') !== -1)
    check('E5', '创建路径已无 `kind:\'add\'`（旧的事后 E11000 拦法退场）', 0,
      countOf(source, "kind: 'add',\n            collection: COLLECTIONS.seals") + countOf(source, "kind: 'add',\n            collection: COLLECTIONS.faces"))
  }

  return run
}

/** 在给定 store 上跑一次直写新建（A 段三变体共用）。
 *  **必须走「本 run 正在被检验的那个 ops 模块」**（`runSuite` 的入参）—— 旧版读模块级
 *  `currentOps`（恒 = 仓库真源）⇒ 变异负对照跑 A/B 段时**仍在跑未变异实现**，
 *  变异 ① 的靶子 A3 永远红不了、而 B1 会因「计划用真源、落盘用变异体」的错位假红。 */
async function planOfDirectSeed(ops, store) {
  return await ops.ADMIN_OPS.createSealWithFaceDirect(directPayload(`SS-${Math.random().toString(36).slice(2, 8)}`, `tag-${Math.random().toString(36).slice(2, 8)}`), DIRECT_IDENT, CTX)
}

/** A / B 段的 `persist` 薄封装：**只把「抛错」变成可断言读数，绝不吞判据** ——
 *  变异负对照下 plan 会打到既有 `_id` 上（`create` 必抛 `DUPLICATE_ID`），裸 `await`
 *  会让套件崩在栈上、读不出变异读数；断言（A1e 快照 / A1f 行数 / A1g 新章名 / A3b …）
 *  一条不改、照旧判红。 */
async function persistQuiet(ops, plan) {
  try {
    await ops.persist(plan)
    return null
  } catch (error) {
    return error
  }
}

/* --------------------------------------------------------------------------- *
   5. 变异负对照（源拷到临时目录；**不改仓库文件**）
   --------------------------------------------------------------------------- */
const CODE_PREDICATE =
  "text(item && item.stamp_id) === code || text(item && item.sid) === code || text(item && item._id) === code"

function loadMutated(tag, mutate) {
  const base = readFileSync(OPS_PATH, 'utf8')
  const mutated = mutate(base)
  if (mutated === base) throw new Error(`mutation-${tag}: anchor not applied`)
  const dir = path.join(process.env.TMPDIR || os.tmpdir(), `xiai-seal-code-collision-${tag}`)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'ops.js')
  /* 相对 / 裸 `require` 一律改写成绝对路径 ⇒ 变异副本可从临时目录加载且依赖同一份真源模块。 */
  const rewritten = mutated.replace(/require\((['"])([^'"]+)\1\)/g, (match, quote, spec) => {
    if (spec.startsWith('.')) return `require(${JSON.stringify(path.resolve(path.dirname(OPS_PATH), spec))})`
    try {
      return `require(${JSON.stringify(require.resolve(spec, { paths: [path.dirname(OPS_PATH)] }))})`
    } catch {
      return match
    }
  })
  writeFileSync(file, rewritten)
  return { file, ops: require(file) }
}

/* --------------------------------------------------------------------------- *
   6. 跑：主套件 ＋ 两条变异
   --------------------------------------------------------------------------- */
const REAL_OPS = require(OPS_PATH)

const main = await runSuite(REAL_OPS, { verbose: true, sourcePath: OPS_PATH })
console.log(JSON.stringify({ summary: { total: main.total, passed: main.total - main.failed, failures: main.failed } }))
if (main.failed > 0) console.log(JSON.stringify({ failed_ids: main.failedIds() }))

const mutations = []

/* 变异 ①：避让谓词改回「只看 `seal_no`」⇒ 撞码用例（A3）必红。 */
{
  const loaded = loadMutated('predicate-seal-no-only', (source) => {
    if (source.indexOf(CODE_PREDICATE) === -1) throw new Error('mutation-1: predicate anchor not found')
    return source.replace(CODE_PREDICATE, 'false')
  })
  const run = await runSuite(loaded.ops, { verbose: false, sourcePath: loaded.file })
  const failedIds = run.failedIds()
  const red = failedIds.indexOf('A3') !== -1
  mutations.push({ id: 1, desc: '把避让谓词改回只看 seal_no', failures: run.failed, failed_ids: failedIds, red })
  console.log(JSON.stringify({ mutation: mutations[mutations.length - 1] }))
}

/* 变异 ②：创建写步改回 `kind:'set'` ⇒ 覆盖用例（C / D 段）必红。 */
{
  const loaded = loadMutated('create-step-to-set', (source) => {
    const hits = countOf(source, "kind: 'create'")
    if (hits !== 8) throw new Error(`mutation-2: expected 8 anchors, got ${hits}`)
    return source.split("kind: 'create'").join("kind: 'set'")
  })
  const run = await runSuite(loaded.ops, { verbose: false, sourcePath: loaded.file })
  const failedIds = run.failedIds()
  const red = failedIds.indexOf('C1') !== -1 || failedIds.some((id) => /^D\d+o1$/.test(id))
  mutations.push({ id: 2, desc: "把创建写步改回 kind:'set'", failures: run.failed, failed_ids: failedIds, red })
  console.log(JSON.stringify({ mutation: mutations[mutations.length - 1] }))
}

const allRed = mutations.every((m) => m.red)
console.log(JSON.stringify({ script: 'verify-seal-code-collision', mutations_red: allRed, mutations: mutations.map((m) => ({ id: m.id, red: m.red, failures: m.failures })) }))
if (!allRed) {
  console.log(JSON.stringify({ error: '变异负对照未报红 ⇒ 套件失去判负能力' }))
}
process.exit(main.failed > 0 || !allRed ? 1 : 0)
