/**
 * 玺爱 · **值域收敛 op `migrateSealValueDomains` 自检**（本单｜幂等管理员 op）
 * ============================================================================
 * **本地、离线、零网络、零云端**（注入假 DB；跑的是**真实云函数体** `xiai-user-token/lib/ops.js`）。
 *
 * 逐条断言（可判负）：
 *   A. 契约面：`ADMIN_OPS` 含 `migrateSealValueDomains`（且**不在**用户写面 `OPS`）；
 *      扫描面恰 5 个 `(集合, 字段)`；载荷封闭键面 ＝ `['dry_run']`；四个真源长度逐字
 *      （15 / 9 / 23 / 3，本 op 的 domain **就是**这四个真源，无第二套常量）。
 *   B. **预演 `dry_run:true`（缺省）** ⇒ 零写入 ＋ 逐集合行数 ＋ **逐字段权威分布
 *      `distinct`**（库内旧值清单的唯一权威来源）＋ 真源外命中数 ＋ 抽样。
 *   C. **执行 `dry_run:false`** ⇒ **只把真源外值清空为 `''`**（本夹具恰 3 处：`dynasty='清'`、
 *      `seal_type='上古印'`、`face_style='某旧值'`）；**真源内值 / 空值 / 其它字段逐字不动**
 *      （全行逐字段快照对拍）。
 *   D. **重放** ⇒ `changed` 全 `0` ＋ `idempotent:true` ＋ **零写入**。
 *   E. **白名单门**：非白名单 ⇒ `FORBIDDEN` ＋ 零写入；缺 env ⇒ `STORAGE_UNAVAILABLE` ＋
 *      零写入；未知载荷键 ⇒ `INVALID_FIELD` ＋ 零写入；`dry_run` 非布林 ⇒ `INVALID_VALUE`
 *      ＋ 零写入（**零新增 `reason` 字面值**）。
 *
 * 纪律：不打印任何密钥 / 验证码 / 令牌原文；不碰任何服务 / 端口；断言失败 ⇒ 退出码非 0。
 * 环境变量缺省用**合成值**（非真实凭据；可用 env 覆盖）：XIAI_ADMIN_PHONE。
 *
 * 用法：node scripts/verify-seal-domain-migration.mjs
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const USER_FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

/* ---------------------------------------------------------------------------
   0. localStorage / window 假体（只为让真源模块在本机 Node 下可导入）
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
   1. 断言与读数（沿既有套件形态：check(id, desc, expected, actual)）
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
   2. 环境（**合成值**；脚本内零真实凭据字面值）
   --------------------------------------------------------------------------- */
const PHONE = String(process.env.XIAI_ADMIN_PHONE || '13000000001').trim()
const NON_WHITELIST_PHONE = '139' + String(0).repeat(8) + '1'
const FROZEN_REASONS = ['FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE']
const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const isDenial = (value) =>
  value && value.ok === false && shapeOf(value) === 'message,ok,reason' && FROZEN_REASONS.indexOf(value.reason) !== -1

/* ---------------------------------------------------------------------------
   3. 被测件（真实云函数体）＋ 假 DB
   --------------------------------------------------------------------------- */
const ops = require(path.join(USER_FN_DIR, 'lib/ops.js'))

function createStore(seed) {
  const collections = { xiai_seals: new Map(), xiai_faces: new Map() }
  const stats = { writes: [], reads: 0 }
  const load = (rows) => {
    Object.keys(collections).forEach((name) => collections[name].clear())
    ;(rows || []).forEach((row) => {
      const name = row.__collection || 'xiai_seals'
      ;(collections[name] = collections[name] || new Map()).set(row._id, Object.assign({}, row))
    })
    stats.writes.length = 0
    stats.reads = 0
  }
  const provider = () => ({
    collection(name) {
      const map = (collections[name] = collections[name] || new Map())
      return {
        where(match) {
          const hit = () =>
            [...map.values()].filter((row) => Object.keys(match).every((key) => String(row[key]) === String(match[key])))
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
  load(seed)
  return { collections, stats, provider, load }
}

/* 夹具：**恰 3 个真源外旧值**（`清` / `上古印` / `某旧值`）＋ 真源内值 / 空值 / 其它字段不动。 */
const SEED = [
  { __collection: 'xiai_seals', _id: 's1', id: 's1', dynasty: '清', seal_type: '官印' },
  { __collection: 'xiai_seals', _id: 's2', id: 's2', dynasty: '清初', seal_type: '上古印' },
  { __collection: 'xiai_seals', _id: 's3', id: 's3', dynasty: '', seal_type: '私印' },
  { __collection: 'xiai_seals', _id: 's4', id: 's4', dynasty: '戰國', seal_type: '' },
  { __collection: 'xiai_faces', _id: 'f1', id: 'f1', seal_type: '官印', face_style: '某旧值', seal_class: '古璽' },
  { __collection: 'xiai_faces', _id: 'f2', id: 'f2', seal_type: '官印', face_style: '三晉古璽', seal_class: '流派印' }
]
const store = createStore(SEED)
ops.setOpsDbProvider(store.provider)

const ADMIN_IDENTITY = { uid: 'u-admin-x', phone: PHONE, identity_source: 'SERVER_TOKEN' }
const ADMIN_CTX = { adminPhone: PHONE, nowSeconds: Math.floor(Date.now() / 1000) }
const findRow = (collection, id) => store.collections[collection].get(id) || {}
const snapAll = () =>
  ['xiai_seals', 'xiai_faces'].map((name) =>
    [...store.collections[name].values()]
      .map((row) => JSON.stringify(Object.keys(row).sort().reduce((acc, k) => { acc[k] = row[k]; return acc }, {})))
      .sort()
  )
const DOMAIN_SIZES = { dynasty: 15, seal_type: 9, face_style: 23, seal_class: 3 }

/* ===========================================================================
   A 段：契约面
   =========================================================================== */
console.log(JSON.stringify({ section: 'A', title: '契约面：op 注册 / 扫描面 / 真源长度' }))
check('A1', '`ADMIN_OPS` 含 `migrateSealValueDomains`', true,
  Object.prototype.hasOwnProperty.call(ops.ADMIN_OPS, 'migrateSealValueDomains'))
check('A2', '`migrateSealValueDomains` **不在**用户写面 `OPS`', false,
  Object.prototype.hasOwnProperty.call(ops.OPS, 'migrateSealValueDomains'))
check('A3', '扫描面恰 5 个 (集合, 字段) 且逐字', [
  ['xiai_seals', 'dynasty'],
  ['xiai_seals', 'seal_type'],
  ['xiai_faces', 'seal_type'],
  ['xiai_faces', 'face_style'],
  ['xiai_faces', 'seal_class']
], ops.SEAL_VALUE_DOMAIN_TARGETS.map((t) => [t.collection, t.field]))
check('A4', '载荷封闭键面 ＝ [dry_run]', ['dry_run'], ops.MIGRATE_ALLOWED_KEYS.slice())
check('A5', '四个真源长度逐字（15 / 9 / 23 / 3）', DOMAIN_SIZES, {
  dynasty: ops.DYNASTY_OPTIONS.length,
  seal_type: ops.FACE_CONTENT_OPTIONS.length,
  face_style: ops.FACE_STYLE_OPTIONS.length,
  seal_class: ops.SEAL_CLASS_OPTIONS.length
})
check('A6', '每个扫描面的 domain 逐字 ＝ 对应真源', true,
  ops.SEAL_VALUE_DOMAIN_TARGETS.every((t) => {
    const domain =
      t.field === 'dynasty' ? ops.DYNASTY_OPTIONS
        : t.field === 'face_style' ? ops.FACE_STYLE_OPTIONS
          : t.field === 'seal_class' ? ops.SEAL_CLASS_OPTIONS
            : ops.FACE_CONTENT_OPTIONS
    return t.domain === domain
  }))

/* ===========================================================================
   B 段：预演（dry_run 缺省 true）⇒ 零写入 ＋ 权威分布
   =========================================================================== */
console.log(JSON.stringify({ section: 'B', title: '预演：零写入 ＋ 逐字段权威分布' }))
const before = snapAll()
const dry = await ops.ADMIN_OPS.migrateSealValueDomains({ dry_run: true }, ADMIN_IDENTITY, ADMIN_CTX)
if (dry.plan) await ops.persist(dry.plan)
check('B1', '预演 ⇒ ok ＋ op ＋ dry_run:true', { ok: true, op: 'migrateSealValueDomains', dry_run: true },
  { ok: dry.ok, op: dry.op, dry_run: dry.dry_run })
check('B2', '预演 ⇒ scanned 逐集合行数', { seals: 4, faces: 2 }, { seals: dry.scanned.seals, faces: dry.scanned.faces })
check('B2b', '预演 ⇒ 逐字段权威分布（seals.dynasty）',
  { total: 4, empty: 1, distinct: { 清: 1, 清初: 1, 戰國: 1 }, cleared: 1 }, dry.scanned.distinct['seals.dynasty'])
check('B2c', '预演 ⇒ 逐字段权威分布（seals.seal_type）',
  { total: 4, empty: 1, distinct: { 官印: 1, 上古印: 1, 私印: 1 }, cleared: 1 }, dry.scanned.distinct['seals.seal_type'])
check('B2d', '预演 ⇒ 逐字段权威分布（faces.seal_type）',
  { total: 2, empty: 0, distinct: { 官印: 2 }, cleared: 0 }, dry.scanned.distinct['faces.seal_type'])
check('B2e', '预演 ⇒ 逐字段权威分布（faces.face_style）',
  { total: 2, empty: 0, distinct: { 某旧值: 1, 三晉古璽: 1 }, cleared: 1 }, dry.scanned.distinct['faces.face_style'])
check('B2f', '预演 ⇒ 逐字段权威分布（faces.seal_class）',
  { total: 2, empty: 0, distinct: { 古璽: 1, 流派印: 1 }, cleared: 0 }, dry.scanned.distinct['faces.seal_class'])
check('B3', '预演 ⇒ changed 逐字段真源外命中数', {
  'seals.dynasty': 1, 'seals.seal_type': 1, 'faces.seal_type': 0, 'faces.face_style': 1, 'faces.seal_class': 0
}, dry.changed)
check('B4', '预演 ⇒ idempotent:false（库内有真源外残留）', false, dry.idempotent)
check('B5', '预演 ⇒ **零写入**（无落盘计划 ＋ 零写次数）', { plan: undefined, writes: 0 },
  { plan: dry.plan, writes: store.stats.writes.length })
check('B6', '预演 ⇒ 全行逐字段快照不动', before, snapAll())
check('B7', '预演 ⇒ 抽样 from/to（清 / 上古印 / 某旧值 ⇒ 空）', true,
  dry.samples.length === 3 &&
    dry.samples.every((s) => s.to === '' && ['清', '上古印', '某旧值'].indexOf(s.from) !== -1))

/* ===========================================================================
   C 段：执行 ⇒ 只清真源外值；其余逐字不动
   =========================================================================== */
console.log(JSON.stringify({ section: 'C', title: '执行：只清真源外值' }))
store.load(SEED)
const run = await ops.ADMIN_OPS.migrateSealValueDomains({ dry_run: false }, ADMIN_IDENTITY, ADMIN_CTX)
if (run.plan) await ops.persist(run.plan)
check('C1', '执行 ⇒ changed 与预演一致', dry.changed, run.changed)
check('C2', '执行 ⇒ 真源外值被清空（seals.s1.dynasty 清 ⇒ 空）', '', findRow('xiai_seals', 's1').dynasty)
check('C3', '执行 ⇒ 真源外值被清空（seals.s2.seal_type 上古印 ⇒ 空）', '', findRow('xiai_seals', 's2').seal_type)
check('C4', '执行 ⇒ 真源外值被清空（faces.f1.face_style 某旧值 ⇒ 空）', '', findRow('xiai_faces', 'f1').face_style)
check('C5', '执行 ⇒ 真源内值一字不动（s1.seal_type / s2.dynasty / s3 / s4）',
  { s1_type: '官印', s2_dynasty: '清初', s3_dynasty: '', s3_type: '私印', s4_dynasty: '戰國', s4_type: '' },
  {
    s1_type: findRow('xiai_seals', 's1').seal_type,
    s2_dynasty: findRow('xiai_seals', 's2').dynasty,
    s3_dynasty: findRow('xiai_seals', 's3').dynasty,
    s3_type: findRow('xiai_seals', 's3').seal_type,
    s4_dynasty: findRow('xiai_seals', 's4').dynasty,
    s4_type: findRow('xiai_seals', 's4').seal_type
  })
check('C6', '执行 ⇒ faces 真源内值一字不动（f1.seal_class / f2 全行）',
  { f1_class: '古璽', f2: { seal_type: '官印', face_style: '三晉古璽', seal_class: '流派印' } },
  {
    f1_class: findRow('xiai_faces', 'f1').seal_class,
    f2: {
      seal_type: findRow('xiai_faces', 'f2').seal_type,
      face_style: findRow('xiai_faces', 'f2').face_style,
      seal_class: findRow('xiai_faces', 'f2').seal_class
    }
  })
check('C7', '执行 ⇒ 落盘数 ＝ 真源外命中数（3 处 update，逐字命中该行）',
  [{ collection: 'xiai_seals', match: { _id: 's1' } }, { collection: 'xiai_seals', match: { _id: 's2' } },
    { collection: 'xiai_faces', match: { _id: 'f1' } }],
  store.stats.writes.map((w) => ({ collection: w.collection, match: w.match })))
check('C8', '执行 ⇒ 全行逐字段快照恰 3 处单元格变化', true, (() => {
  const after = snapAll()
  const diff = before.flat().filter((row) => after.flat().indexOf(row) === -1).length
  return diff === 3
})())

/* ===========================================================================
   D 段：重放 ⇒ 幂等 ＋ 零写入
   =========================================================================== */
console.log(JSON.stringify({ section: 'D', title: '重放：幂等 ＋ 零写入' }))
const beforeReplay = store.stats.writes.length
const replay = await ops.ADMIN_OPS.migrateSealValueDomains({ dry_run: false }, ADMIN_IDENTITY, ADMIN_CTX)
if (replay.plan) await ops.persist(replay.plan)
check('D1', '重放 ⇒ changed 全 0', {
  'seals.dynasty': 0, 'seals.seal_type': 0, 'faces.seal_type': 0, 'faces.face_style': 0, 'faces.seal_class': 0
}, replay.changed)
check('D2', '重放 ⇒ idempotent:true', true, replay.idempotent)
check('D3', '重放 ⇒ **零写入**', 0, store.stats.writes.length - beforeReplay)

/* ===========================================================================
   E 段：白名单门 / 载荷门（**全部在写之前**；零新增 reason 字面值）
   =========================================================================== */
console.log(JSON.stringify({ section: 'E', title: '白名单门 / 载荷门（零写入）' }))
store.load(SEED)
const foreign = await ops.ADMIN_OPS.migrateSealValueDomains({ dry_run: false },
  { uid: 'u-x', phone: NON_WHITELIST_PHONE, identity_source: 'SERVER_TOKEN' }, ADMIN_CTX)
check('E1', '非白名单 ⇒ FORBIDDEN（恰 3 键）', true, isDenial(foreign) && foreign.reason === 'FORBIDDEN')
const noEnv = await ops.ADMIN_OPS.migrateSealValueDomains({ dry_run: false }, ADMIN_IDENTITY,
  { adminPhone: '', nowSeconds: ADMIN_CTX.nowSeconds })
check('E2', '缺 env ⇒ STORAGE_UNAVAILABLE（非 FORBIDDEN）', true, isDenial(noEnv) && noEnv.reason === 'STORAGE_UNAVAILABLE')
const badKey = await ops.ADMIN_OPS.migrateSealValueDomains({ nope: 1 }, ADMIN_IDENTITY, ADMIN_CTX)
check('E3', '未知载荷键 ⇒ INVALID_FIELD', true, isDenial(badKey) && badKey.reason === 'INVALID_FIELD')
const badDry = await ops.ADMIN_OPS.migrateSealValueDomains({ dry_run: 'yes' }, ADMIN_IDENTITY, ADMIN_CTX)
check('E4', '`dry_run` 非布林 ⇒ INVALID_VALUE', true, isDenial(badDry) && badDry.reason === 'INVALID_VALUE')
check('E5', 'E1〜E4 全程**零写入**', 0, store.stats.writes.length)
check('E6', 'E1〜E4 未改动任何行（逐字段快照不动）', SEED.map((r) => JSON.stringify(Object.keys(r).sort().reduce((acc, k) => { acc[k] = r[k]; return acc }, {}))).sort(),
  [...store.collections.xiai_seals.values(), ...store.collections.xiai_faces.values()]
    .map((r) => JSON.stringify(Object.keys(r).sort().reduce((acc, k) => { acc[k] = r[k]; return acc }, {}))).sort())

/* ===========================================================================
   汇总
   =========================================================================== */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id),
    db_writes_by_harness: store.stats.writes.length
  })
)
process.exit(failures === 0 ? 0 : 1)
