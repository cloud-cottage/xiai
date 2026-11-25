/**
 * 玺爱 · **水合逐集合降级（`publishers` 查询抛错）离线桩自检**
 * ===================================================================
 * 覆盖（本单读面接线）：
 *   ① `cloudbase.js::CLOUD_COLLECTIONS` 已登记 `publishers` ＝ `xiai_publishers`；
 *   ② `normalizePublisherRow`（照 `persons` 同形态）已导出，且登记面真吃它
 *      （第 2 轮 `counts.publishers === 1` 即 NORMALIZERS 跑通的实据）；
 *   ③ `publishers` 进「允许空集合」白名单 `CLOUD_EMPTY_VERDICT_EXEMPT`；
 *   ④ **水合逐集合降级**：`xiai_publishers` 查询抛错（集合不存在 / QUERY 失败）⇒
 *        · 该集合**置空集**（`counts.publishers === 0`、`snapshot.publishers` 恒 `[]`）；
 *        · 诊断量**置位**（`status.diagnostics.publishers_unavailable === 1` ＋
 *          `status.unavailable` 含 `publishers`）；
 *        · **整轮不回落本机**（`state === 'ready'`，**不是** `failed`）；
 *        · **不阻断其它集合**（seals / faces / images / persons / items … 行数照常交出）；
 *   ⑤ 负对照：放行该集合后诊断量归零、行数上来（尺子会响）；超时仍归总预算状态机（不被降级吞掉）。
 *
 * 桩形態（不联网、不碰任何服务、不建集合、不灌数据）：
 *   · `import.meta.env` 假体 ＝ 既有 `scripts/lib/import-meta-env-shim.mjs`（**不另造第二份**）；
 *   · SDK 假体走**既有注入缝** `cloudbaseSdk.js::setCloudBaseSdkProvider`（宿主显式注入，① 号来源）；
 *   · `database().collection(name).get()` 按集合分派：`xiai_publishers` 抛「集合不存在」，
 *     其余返回夹具行（分页按 `skip` 推进，空页收尾）。
 *
 * 纪律：只读 `src/**`；`XIAI_NO_REAL_CARD=1`；不新增依赖；任一断言失败 ⇒ 退出码非 0。
 * 用法：`node scripts/verify-publisher-hydration.mjs`
 */
process.env.XIAI_NO_REAL_CARD = '1'

import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* --------------------------------------------------------------------------- 0. 断言 --------------------------------------------------------------------------- */
const results = []
let failures = 0

function canon(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`)
    .join(',')}}`
}

function check(id, desc, expected, actual) {
  const pass = canon(expected) === canon(actual)
  if (!pass) failures += 1
  results.push({ id, desc, pass, expected, actual })
  console.log(JSON.stringify({ id, case: desc, pass, expected, actual }))
}

const section = (id, title) => console.log(JSON.stringify({ section: id, title }))

/* --------------------------------------------------------------------------- 1. 假体 --------------------------------------------------------------------------- */

/* 1.0 构建期 env 假体（**必须早于任何 `src/**` 的 `import()`**）。 */
globalThis.__XIAI_TEST_ENV__ = {
  VITE_XIAI_DATA_SOURCE: 'cloudbase',
  VITE_XIAI_CB_ENV_ID: 'xiai-selfcheck-env'
}
register(pathToFileURL(path.join(HERE, 'lib', 'import-meta-env-shim.mjs')).href)

/* 1.1 `localStorage / window` 假体（与 `scripts/verify-card-author.mjs` 头部同套）。 */
const memory = new Map()
const localStorageShim = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear()
}
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = localStorageShim
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}
globalThis.window.dispatchEvent = () => true

/* 1.2 夹具行：每个集合一行（`xiai_publishers` 由桩按轮次决定抛错 / 回行）。 */
const PUBLISHER_ROW = {
  _id: 'PB000000001',
  code: 'PB000000001',
  name: '商务印书馆',
  name_cht: '商務印書館',
  isbn_prefix: '978',
  isbn_group: '7',
  isbn_publisher_codes: [{ code: '5508', status: 'current' }],
  aliases: ['商务'],
  region: null,
  founded_year: 1897,
  note: null,
  created_at: '2026-11-26T00:00:00.000Z',
  created_by: 'ops',
  updated_at: '2026-11-26T00:00:00.000Z',
  org_type: 'publisher'
}

const FIXTURES = {
  xiai_seals: [{ _id: 's1', stamp_id: 'S1', seal_name: '印' }],
  xiai_faces: [{ _id: 'f1', sealId: 'S1', kind: 'FACE' }],
  xiai_images: [
    {
      _id: 'i1',
      stamp_id: 'S1',
      kind: 'FACE',
      storage: 'server',
      sha256: 'a'.repeat(64),
      storage_key: `xiai/images/aa/${'a'.repeat(64)}.png`,
      mime: 'image/png'
    }
  ],
  xiai_corrections_public: [],
  xiai_correction_summaries: [],
  xiai_persons: [{ _id: 'P1', code: 'P1', family_name: '陈', given_name: '巨来' }],
  xiai_person_proposals: [],
  xiai_items: [{ _id: 'IT1', source_item_id: 'IT1', title: '印譜' }],
  xiai_publishers: [PUBLISHER_ROW]
}

/* **被桩掐掉的集合**（按轮次切换：第 1 轮 ＝ `xiai_publishers` 抛「集合不存在」）。 */
let brokenCollections = new Set(['xiai_publishers'])

function makeQuery(name) {
  let offset = 0
  return {
    orderBy() {
      return this
    },
    skip(next) {
      offset = Number(next) || 0
      return this
    },
    limit() {
      return this
    },
    async get() {
      if (brokenCollections.has(name)) {
        throw new Error(`DATABASE_COLLECTION_NOT_EXIST: 集合 ${name} 不存在`)
      }
      const rows = FIXTURES[name] || []
      return { data: rows.slice(offset) }
    }
  }
}

const fakeSdk = {
  init(options) {
    return {
      env: options && options.env,
      auth() {
        return { currentUser: { userId: 'anon-selfcheck' } }
      },
      database() {
        return { collection: (name) => makeQuery(name) }
      }
    }
  }
}

/* 1.3 捕获 `console.warn`：断言「逐集合降级」日志真的留了痕（诊断通道本身不许抛错）。 */
const warnings = []
const originalWarn = console.warn
console.warn = (...args) => {
  warnings.push(args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' '))
  originalWarn(...args)
}

/* --------------------------------------------------------------------------- 2. 被测件 --------------------------------------------------------------------------- */
const cloudbaseSdk = await import(pathToFileURL(path.join(ROOT, 'src/data/cloudbaseSdk.js')).href)
cloudbaseSdk.setCloudBaseSdkProvider(async () => fakeSdk)

const cloudbase = await import(pathToFileURL(path.join(ROOT, 'src/data/cloudbase.js')).href)

/* =========================================================================== A · 登记面 =========================================================================== */
section('A', '登记面：CLOUD_COLLECTIONS / 归一函数 / 允许空集合白名单')

check('A1', 'CLOUD_COLLECTIONS.publishers ＝ xiai_publishers', 'xiai_publishers', cloudbase.CLOUD_COLLECTIONS.publishers)
check(
  'A2',
  'publishers 在 CLOUD_COLLECTION_KEYS（读面接管键）内',
  true,
  cloudbase.CLOUD_COLLECTION_KEYS.includes('publishers')
)
check(
  'A3',
  'normalizePublisherRow 已导出（登记面同源的行归一函数）',
  'function',
  typeof cloudbase.normalizePublisherRow
)
check(
  'A4',
  'publishers 在「允许空集合」白名单 CLOUD_EMPTY_VERDICT_EXEMPT 内（集合未建 ⇒ 诚实空态，不判可疑）',
  true,
  cloudbase.CLOUD_EMPTY_VERDICT_EXEMPT.includes('publishers')
)

/* =========================================================================== B · 归一形态 =========================================================================== */
section('B', '归一形态：normalizePublisherRow 照 persons 同形态（空值 / 数组 / 整数归一）')

const normalized = cloudbase.normalizePublisherRow({ _id: 'PB000000002', code: 'PB000000002', name: 'X' })
check('B1', '文本 NULL ⇒ 空串（name_cht / region / note）', ['', '', ''], [
  normalized.name_cht,
  normalized.region,
  normalized.note
])
check(
  'B2',
  '数组缺键 ⇒ []（aliases / isbn_publisher_codes）',
  [[], []],
  [normalized.aliases, normalized.isbn_publisher_codes]
)
check('B3', 'founded_year 缺键 ⇒ null（不设特值）', null, normalized.founded_year)
check(
  'B4',
  '零派生键（不产出 display_name / isbn_full）',
  [],
  Object.keys(normalized).filter((key) => key === 'display_name' || key === 'isbn_full')
)
check(
  'B5',
  '号段元素逐字保留（对象数组；非对象元素被滤掉）',
  ['5508'],
  cloudbase
    .normalizePublisherRow({ isbn_publisher_codes: [{ code: '5508', status: 'current' }, 'junk', null] })
    .isbn_publisher_codes.map((item) => item.code)
)
check('B6', '`_id = code` 恒等（缺 `_id` 时按 code 补、缺 code 时按 `_id` 补，不臆造）', ['PB1', 'PB1'], [
  cloudbase.normalizePublisherRow({ code: 'PB1' })._id,
  cloudbase.normalizePublisherRow({ _id: 'PB1' }).code
])

/* =========================================================================== C · 第 1 轮：publishers 查询抛错 =========================================================================== */
section('C', '第 1 轮：xiai_publishers 查询抛「集合不存在」⇒ 逐集合降级（桩）')

const round1 = await cloudbase.ensureCloudBaseHydration()
const status1 = cloudbase.cloudBaseStatus()

check('C1', '整轮落定为 ready（**不回落本机**：不是 failed / TIMEOUT / QUERY_FAILED）', 'ready', status1.state)
check('C2', 'reason ＝ OK', 'OK', status1.reason)
check(
  'C3',
  '诊断量置位：diagnostics.publishers_unavailable ＝ 1',
  1,
  status1.diagnostics && status1.diagnostics.publishers_unavailable
)
check(
  'C4',
  'unavailable 登记 publishers',
  true,
  Array.isArray(status1.unavailable) && status1.unavailable.includes('publishers')
)
check('C5', '被降级集合置空集：counts.publishers ＝ 0', 0, status1.counts.publishers)
check('C6', '快照 publishers ＝ 空集', [], cloudbase.cloudBaseSnapshot().publishers)
check(
  'C7',
  '读面：cloudBaseReadOf("publishers") ＝ ready + 空集（不抛、不回落种子）',
  ['ready', 0],
  (() => {
    const read = cloudbase.cloudBaseReadOf('publishers')
    return [read.state, Array.isArray(read.rows) ? read.rows.length : -1]
  })()
)
check(
  'C8',
  '**不阻断其它集合**：seals / faces / images / persons / items 行数照常交出',
  { seals: 1, faces: 1, images: 1, persons: 1, items: 1 },
  {
    seals: status1.counts.seals,
    faces: status1.counts.faces,
    images: status1.counts.images,
    persons: status1.counts.persons,
    items: status1.counts.items
  }
)
check(
  'C9',
  '其它集合的读面行同样交出（cloudBaseReadOf("seals") 1 行）',
  1,
  cloudbase.cloudBaseReadOf('seals').rows.length
)
check(
  'C10',
  '分页读数如实登记（被降级集合 pages ＝ 0，其余 ≥ 1）',
  { publishers: 0, sealsAtLeastOne: true },
  { publishers: status1.paging.publishers.pages, sealsAtLeastOne: status1.paging.seals.pages >= 1 }
)
check(
  'C11',
  '降级日志留痕（console.warn 含「逐集合降级」＋ xiai_publishers）',
  true,
  warnings.some((line) => line.includes('逐集合降级') && line.includes('xiai_publishers'))
)
check(
  'C12',
  '失败状态机未被触发（无 QUERY_FAILED / CLOUD_EMPTY_SUSPECT / TIMEOUT）',
  [],
  ['QUERY_FAILED', 'CLOUD_EMPTY_SUSPECT', 'TIMEOUT'].filter((reason) => reason === status1.reason)
)
check(
  'C13',
  '幂等：再次 ensureCloudBaseHydration 返回同一份结论（不重跑水合）',
  true,
  (await cloudbase.ensureCloudBaseHydration()) === round1
)

/* =========================================================================== D · 第 2 轮：负对照（publishers 读得到） =========================================================================== */
section('D', '负对照：第 2 轮放行 xiai_publishers 查询 ⇒ 诊断量必须归零、行数必须上来')

brokenCollections = new Set()
await cloudbase.retryCloudBaseHydration()
const status2 = cloudbase.cloudBaseStatus()

check('D1', '第 2 轮 ready', 'ready', status2.state)
check(
  'D2',
  '诊断量归零：diagnostics.publishers_unavailable 未置位',
  true,
  !status2.diagnostics || status2.diagnostics.publishers_unavailable === undefined
)
check('D3', 'unavailable 归零（空数组）', [], status2.unavailable)
check('D4', 'counts.publishers ＝ 1（行真的上来了 ＝ NORMALIZERS.publishers 跑通）', 1, status2.counts.publishers)
check(
  'D5',
  '读面交出 1 行且 `_id = code` 恒等',
  ['PB000000001', 'PB000000001'],
  (() => {
    const row = cloudbase.cloudBaseReadOf('publishers').rows[0]
    return [row._id, row.code]
  })()
)

/* =========================================================================== E · 超时不走降级（负对照） =========================================================================== */
section('E', '负对照：查询超时（CloudTimeoutError）仍归总预算状态机，不被降级吞掉')

check(
  'E1',
  'CloudTimeoutError 仍是本模块导出的超时类型（降级只接手非超时错误）',
  true,
  typeof cloudbase.CloudTimeoutError === 'function' && new cloudbase.CloudTimeoutError('query', 1).stage === 'query'
)
check(
  'E2',
  '降级分支内**先**上抛超时（`instanceof CloudTimeoutError ⇒ throw` 紧邻降级日志之前）',
  true,
  (() => {
    const src = readFileSync(path.join(ROOT, 'src/data/cloudbase.js'), 'utf8')
    const marker = src.indexOf('集合逐集合降级（仅该集合置空集')
    if (marker < 0) return false
    const head = src.slice(0, marker)
    const throwAt = head.lastIndexOf('if (err instanceof CloudTimeoutError) throw err')
    if (throwAt <= 0 || marker - throwAt >= 900) return false
    /* 上抛与降级日志之间**不得**夹着失败早退（`return fail(`）—— 否则超时会被降级吞掉。 */
    return !src.slice(throwAt, marker).includes('return fail(')
  })()
)

/* --------------------------------------------------------------------------- 收尾 --------------------------------------------------------------------------- */
console.warn = originalWarn

const summary = {
  total: results.length,
  passed: results.filter((item) => item.pass).length,
  failed: failures,
  round1: { state: status1.state, diagnostics: status1.diagnostics, unavailable: status1.unavailable, counts: status1.counts },
  round2: { state: status2.state, diagnostics: status2.diagnostics, counts: status2.counts }
}
console.log(JSON.stringify({ summary }))

if (failures > 0) {
  console.error(`\nverify-publisher-hydration: ${failures}/${results.length} 断言失败`)
  process.exit(1)
}
console.log(`\nverify-publisher-hydration: ${results.length}/${results.length} 通过`)
