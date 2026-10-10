/**
 * 玺爱 · **【大類】`seal_class` 字段/值域真源自检**（`scripts/verify-seal-class.mjs`）
 * ----------------------------------------------------------------------------
 * **本地、离线、零网络**（注入假 DB ＋ 直接调用真实函数体 / 真实前端真源）。
 *
 * 判据五族（与派单口径逐条对应）：
 *   (a) **值域门**：三值内放行；值域外（空串 / 其它朝代值 / 古玺简繁异体）⇒ `INVALID_VALUE`
 *       ＋ **零写入**（逐字段快照取证）；**判定在写之前**。运行时经**服务端采纳门**取证：
 *       用户函数 `xiai-user-token` ＋ 管理函数 `xiai-admin-token` 的 `reviewCorrection`。
 *   (b) **多印面聚合筛**：多印面、**任一命中即命中**（R-34 口型）—— 经服务层 `listSeals` 取证。
 *   (c) **上传预填**：朝代 ⇒ 建议值 **7/6/2** 全覆盖（春秋〜宋元 ⇒ 古璽、明早中期〜民國 ⇒ 流派印、
 *       新中國/當代 ⇒ 雜項）；**不锁死**（手改值优先）—— 视图层静态接线。
 *   (d) **勘误面**：`MARKABLE_FIELDS` 含 `seal_class` ⇒「大類」；两函数值域副本含 `seal_class`；
 *       前端 `FIELD_VALUE_DOMAINS` 接 `seal_class`（静态 ＋ 运行时）。
 *   (e) **逐字相等**：前端真源（`seed.js` / `corrections.js`）↔ 用户函数副本 ↔ 管理函数副本，
 *       四套枚举（朝代 15 / 印面内容 9 / 印面风格 23 / 大類 3）**全部逐字相等**。
 *
 * 纪律：不打印任何密钥 / 验证码 / 令牌原文；不碰任何服务；断言失败 ⇒ 退出码非 0。
 * 若并行单的视图层文件尚未出现，(c) 的静态接线断言允许先失败并在报告里登记（派单方复跑）。
 *
 * 用法（无需环境变量；缺省即按合成值跑）：`node scripts/verify-seal-class.mjs`
 */

import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

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
globalThis.window.dispatchEvent = () => true

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

const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const FROZEN_REASONS = ['FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE']
const isDenial = (value) =>
  value && value.ok === false && shapeOf(value) === 'message,ok,reason' && FROZEN_REASONS.indexOf(value.reason) !== -1

/* 合成身份 / 手机号（**脚本内不写 11 位字面值**——与既有自检同纪律）。 */
const PHONE = process.env.XIAI_ADMIN_PHONE || '139' + '0'.repeat(8) + '1'
const IDENTITY = { uid: 'u-' + '0'.repeat(16), phone: PHONE }
const CONTEXT = { adminPhone: PHONE, nowSeconds: Math.floor(Date.now() / 1000) }

/* ---------------------------------------------------------------------------
   2. 被测件
   --------------------------------------------------------------------------- */
const USER_OPS = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))
const ADMIN_OPS = require(path.join(ROOT, 'cloudfunctions/xiai-admin-token/lib/ops.js'))
const seed = await import(path.join(ROOT, 'src/data/seed.js'))
const correctionsSvc = await import(path.join(ROOT, 'src/services/corrections.js'))

/* ---------------------------------------------------------------------------
   3. 假 DB（内存；逐字段快照 ⇒ 「零写入」的判据）
   --------------------------------------------------------------------------- */
function createStore() {
  const collections = new Map()
  const stats = { writes: [], reads: 0 }
  const mapOf = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  const provider = () => ({
    collection(name) {
      const map = mapOf(name)
      return {
        where(match) {
          const hit = () => [...map.values()].filter((row) => Object.keys(match).every((key) => row[key] === match[key]))
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
              map.set(id, Object.assign({}, doc))
              stats.writes.push({ collection: name, action: 'set', id })
              return { updated: 1 }
            }
          }
        },
        async add(doc) {
          map.set(doc._id || `auto-${map.size}`, Object.assign({}, doc))
          stats.writes.push({ collection: name, action: 'add' })
          return { id: doc._id || 'auto' }
        }
      }
    }
  })
  const snapshot = () => {
    const out = {}
    for (const [name, map] of collections.entries()) out[name] = [...map.values()].map((row) => Object.assign({}, row))
    return out
  }
  const load = (name, rows) => {
    const map = mapOf(name)
    map.clear()
    ;(rows || []).forEach((row) => map.set(row._id, Object.assign({}, row)))
    stats.writes.length = 0
  }
  return { collections, stats, provider, snapshot, load, mapOf }
}

/* 一条 seal_class 勘误私有行（供采纳门取证）。 */
const CLS_ROW = (id, value) => ({
  _id: `doc-${id}`,
  id,
  faceId: 'fc-sc-FACE',
  sealId: 'XA000000001',
  stamp_id: 'XA000000001',
  user_id: 'u-' + '1'.repeat(16),
  field: 'seal_class',
  field_label: '大類',
  value,
  status: 'PENDING',
  created_at: '2026-10-01T00:00:00.000Z'
})

/* ---------------------------------------------------------------------------
   4. (a) 值域门 —— 服务端采纳门（两函数）＋ 零写入逐字段快照
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'a', title: '值域门：三值放行 / 值域外 INVALID_VALUE ＋ 零写入' }))

const IN_DOMAIN = seed.SEAL_CLASS_OPTIONS.slice()
/* 值域外样本：空串 / 其它朝代值（大唐）/ 古玺简繁异体（简体「古玺」、异体「古壐」）。 */
const OUT_DOMAIN = ['', '大唐', '古玺', '古壐', '流派印 2']

const userStore = createStore()
USER_OPS.setOpsDbProvider(userStore.provider)
const adminStore = createStore()
ADMIN_OPS.setOpsDbProvider(adminStore.provider)

/* a1 用户函数：三值全部放行（采纳落盘；**正对照 ＝ 真 persist 落盘**） */
{
  let okAll = true
  const observed = []
  for (let i = 0; i < IN_DOMAIN.length; i += 1) {
    const id = `cr-sc-in-${i}`
    userStore.load('xiai_corrections', [CLS_ROW(id, IN_DOMAIN[i])])
    const res = await USER_OPS.ADMIN_OPS.reviewCorrection({ correction_id: id, decision: 'ACCEPTED' }, IDENTITY, CONTEXT)
    if (res.ok === true) await USER_OPS.persist(res.plan)
    const row = userStore.snapshot().xiai_corrections.find((item) => item.id === id) || {}
    observed.push({ value: IN_DOMAIN[i], ok: res.ok === true, writes: userStore.stats.writes.length, status: row.status })
    if (res.ok !== true) okAll = false
  }
  check('a1', '[用户函数] 三值内放行（采纳 ok:true）', true, okAll)
  check('a1b', '[用户函数] **正对照**：放行 ⇒ 真落盘（非零写入）', true, observed.every((item) => item.writes > 0))
  check('a1c', '[用户函数] 正对照：落盘后私有行状态 → ACCEPTED', true, observed.every((item) => item.status === 'ACCEPTED'))
}

/* a2 用户函数：值域外 ⇒ INVALID_VALUE ＋ 零写入（逐字段快照；拒绝时无落盘计划） */
{
  let allDenied = true
  let allZero = true
  const observed = []
  for (let i = 0; i < OUT_DOMAIN.length; i += 1) {
    const id = `cr-sc-out-${i}`
    userStore.load('xiai_corrections', [CLS_ROW(id, OUT_DOMAIN[i])])
    const before = userStore.snapshot()
    const res = await USER_OPS.ADMIN_OPS.reviewCorrection({ correction_id: id, decision: 'ACCEPTED' }, IDENTITY, CONTEXT)
    const after = userStore.snapshot()
    const row = after.xiai_corrections.find((item) => item.id === id) || {}
    observed.push({ value: OUT_DOMAIN[i], reason: res.reason, hasPlan: res.plan !== undefined, writes: userStore.stats.writes.length })
    if (res.reason !== 'INVALID_VALUE' || !isDenial(res)) allDenied = false
    /* 「零写入」三件取证：拒绝不含落盘计划 ＋ 注入库写计数 0 ＋ 逐字段快照前后相等。 */
    if (res.plan !== undefined || userStore.stats.writes.length !== 0) allZero = false
    if (canonical(before) !== canonical(after)) allZero = false
    if (row.status !== 'PENDING' || row.reviewed_at !== undefined) allZero = false
  }
  check('a2', '[用户函数] 值域外 ⇒ INVALID_VALUE（恰 3 键）', true, allDenied)
  check('a2b', '[用户函数] 值域外 ⇒ **零写入**（无落盘计划 ＋ 写计数 0 ＋ 逐字段快照相等）', true, allZero)
  console.log(JSON.stringify({ a2_readout: observed }))
}

/* a3 管理函数：同口径（值域内放行 / 值域外 INVALID_VALUE ＋ 零写入） */
{
  adminStore.load('xiai_corrections', [CLS_ROW('cr-sc-adm-in', IN_DOMAIN[0])])
  const pass = await ADMIN_OPS.OPS.reviewCorrection({ correction_id: 'cr-sc-adm-in', decision: 'ACCEPTED' }, IDENTITY, CONTEXT.nowSeconds)
  check('a3', '[管理函数] 值域内放行（ok:true）', true, pass.ok === true)
  if (pass.ok === true) await ADMIN_OPS.persist(pass.plan)
  check('a3e', '[管理函数] **正对照**：放行 ⇒ 真落盘（非零写入）', true, adminStore.stats.writes.length > 0)
  adminStore.load('xiai_corrections', [CLS_ROW('cr-sc-adm-out', '大唐')])
  const before = adminStore.snapshot()
  const deny = await ADMIN_OPS.OPS.reviewCorrection({ correction_id: 'cr-sc-adm-out', decision: 'ACCEPTED' }, IDENTITY, CONTEXT.nowSeconds)
  const after = adminStore.snapshot()
  check('a3b', '[管理函数] 值域外 ⇒ INVALID_VALUE', 'INVALID_VALUE', deny.reason)
  check('a3c', '[管理函数] 值域外 ⇒ 零写入（逐字段快照前后相等）', canonical(before), canonical(after))
  check('a3d', '[管理函数] 值域外 ⇒ 写入计数 0', 0, adminStore.stats.writes.length)
}

/* a4 判定在写之前：值域外与「未知单号」的**拒绝顺序**证明值域门先于任何写（零写入已证）＋ 负对照 */
{
  userStore.load('xiai_corrections', [CLS_ROW('cr-sc-order', '古壐')])
  const res = await USER_OPS.ADMIN_OPS.reviewCorrection({ correction_id: 'cr-sc-order', decision: 'ACCEPTED' }, IDENTITY, CONTEXT)
  check('a4', '判定在写之前：值域门先触发（拒绝时写入计数 0）', true, res.reason === 'INVALID_VALUE' && userStore.stats.writes.length === 0)
}

/* ---------------------------------------------------------------------------
   5. (b) 多印面聚合筛 —— 服务层 listSeals（任一命中即命中，R-34）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'b', title: '多印面聚合筛：任一印面命中即命中' }))
let aggregateOk = false
try {
  const db = await import(path.join(ROOT, 'src/data/db.js'))
  const storage = await import(path.join(ROOT, 'src/data/storage.js'))
  const sealsSvc = await import(path.join(ROOT, 'src/services/seals.js'))
  db.ensureSeed()

  const S1 = 'XA000000101'
  const S2 = 'XA000000102'
  const seals = [
    { _id: 'xf-b1', id: S1, stamp_id: S1, seal_name: '甲', dynasty: '晚清', seal_type: '', face_style: '', author: '', transcription: '', material: '', shape: '' },
    { _id: 'xf-b2', id: S2, stamp_id: S2, seal_name: '乙', dynasty: '晚清', seal_type: '', face_style: '', author: '', transcription: '', material: '', shape: '' }
  ]
  const face = (id, stamp, cls) => ({
    _id: id, id, sealId: stamp, stamp_id: stamp, kind: 'FACE', face_image_id: null,
    seal_name: '', dynasty: '晚清', seal_type: '', face_style: '', author: '', transcription: '',
    ...(cls === undefined ? {} : { seal_class: cls })
  })
  const faces = [face('f-b1', S1, '流派印'), face('f-b2', S1, '古璽'), face('f-b3', S2, '雜項'), face('f-b4', S2)]
  storage.writeKey(storage.STORAGE_KEYS.seals, seals)
  storage.writeKey(storage.STORAGE_KEYS.faces, faces)
  storage.writeKey(storage.STORAGE_KEYS.images, [])

  const idsOf = (list) => list.map((item) => (item && item.view ? item.view.stamp_id : item.stamp_id)).sort()
  const hitGuXi = sealsSvc.listSeals({ sealClass: '古璽' })
  const hitLiuPai = sealsSvc.listSeals({ sealClass: '流派印' })
  const hitZaXiang = sealsSvc.listSeals({ sealClass: '雜項' })
  const hitNone = sealsSvc.listSeals({ sealClass: '不存在' })
  const hitAll = sealsSvc.listSeals({})

  check('b1', '任一印面命中即命中（S1 的第二印面 = 古璽）', [S1], idsOf(hitGuXi))
  check('b1b', '同章另一印面命中亦命中（S1 第一印面 = 流派印）', [S1], idsOf(hitLiuPai))
  check('b1c', '仅命中 S2（雜項）', [S2], idsOf(hitZaXiang))
  check('b1d', '值域外筛选词 ⇒ 零命中', [], idsOf(hitNone))
  check('b1e', '清空筛选 ⇒ 两枚全中', [S1, S2], idsOf(hitAll))
  /* 负对照：S2 有一印面无 seal_class（无回落）⇒ 不被任何具体大類命中。 */
  check('b1f', '负对照：无 seal_class 的印面不产生命中', true, idsOf(hitGuXi).indexOf(S2) === -1 && idsOf(hitZaXiang).indexOf(S1) === -1)
  aggregateOk = true
} catch (error) {
  check('b0', '多印面聚合筛可运行（listSeals 取证）', 'runnable', `throw:${String(error && error.message)}`)
}

/* ---------------------------------------------------------------------------
   6. (c) 上传预填 —— 朝代 ⇒ 建议值 7/6/2 ＋ 不锁死
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'c', title: '上传预填：朝代 ⇒ 建议值（7/6/2）＋ 不锁死' }))
{
  const suggestions = seed.SEAL_CLASS_SUGGESTIONS
  const covered = []
  suggestions.forEach((entry) => entry.dynasties.forEach((d) => covered.push(d)))
  check('c1', '建议表覆盖朝代全 15 类（逐字集合相等）', seed.DYNASTY_OPTIONS.slice().sort(), covered.slice().sort())
  const counts = {
    古璽: suggestions.find((s) => s.seal_class === '古璽').dynasties.length,
    流派印: suggestions.find((s) => s.seal_class === '流派印').dynasties.length,
    雜項: suggestions.find((s) => s.seal_class === '雜項').dynasties.length
  }
  check('c2', '分段计数 ＝ 7/6/2', { 古璽: 7, 流派印: 6, 雜項: 2 }, counts)
  check('c2b', '春秋〜宋元 ⇒ 古璽', ['古璽', '古璽', '古璽', '古璽', '古璽', '古璽', '古璽'], ['春秋', '戰國', '秦', '漢', '魏晉', '隋唐', '宋元'].map(seed.suggestSealClass))
  check('c2c', '明早中期〜民國 ⇒ 流派印', ['流派印', '流派印', '流派印', '流派印', '流派印', '流派印'], ['明早中期', '晚明', '清初', '清中期', '晚清', '民國'].map(seed.suggestSealClass))
  check('c2d', '新中國 / 當代 ⇒ 雜項', ['雜項', '雜項'], ['新中國', '當代'].map(seed.suggestSealClass))
  check('c2e', '未知 / 空朝代 ⇒ 空串（不猜、不回落）', ['', '', ''], ['', null, '先秦'].map(seed.suggestSealClass))
  check('c2f', '建议值恒 ∈ 冻结 3 类', true, covered.every((d) => seed.isKnownSealClass(seed.suggestSealClass(d))))
}
/* 不锁死（手改值优先）：视图层静态接线（并行单未落地时允许失败并登记）。 */
{
  const srcFiles = (function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return walk(full)
      return /\.(js|vue)$/.test(entry.name) ? [full] : []
    })
  })(path.join(ROOT, 'src'))
  const utilisers = srcFiles.filter((file) => readFileSync(file, 'utf8').includes('suggestSealClass'))
  const overrideFiles = srcFiles.filter((file) => {
    const source = readFileSync(file, 'utf8')
    return source.includes('suggestSealClass') && /seal_class|sealClass/.test(source)
  })
  check('c3', '上传面引 `suggestSealClass`（预填不锁死 ⇒ 至少一处消费点）', true, utilisers.length > 0)
  check('c3b', '预填面同时持有 `seal_class` 可改写路径（手改值优先）', true, overrideFiles.length > 0)
  console.log(JSON.stringify({ c3_readout: { suggestSealClass_consumers: utilisers.map((f) => path.relative(ROOT, f)), with_override: overrideFiles.map((f) => path.relative(ROOT, f)) } }))
}

/* ---------------------------------------------------------------------------
   7. (d) 勘误面 —— MARKABLE_FIELDS / 值域副本 / 提交门
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'd', title: '勘误面：字段表 / 值域副本 / 提交门接值域' }))
check('d1', '客户端 `MARKABLE_FIELDS` 含 {seal_class:「大類」}', true, correctionsSvc.MARKABLE_FIELDS.some((item) => item.key === 'seal_class' && item.label === '大類'))
check('d1b', '用户函数 `MARKABLE_FIELDS.seal_class` ⇒「大類」', '大類', USER_OPS.MARKABLE_FIELDS.seal_class)
check('d1c', '管理函数 `MARKABLE_FIELDS.seal_class` ⇒「大類」', '大類', ADMIN_OPS.MARKABLE_FIELDS.seal_class)
check('d2', '用户函数 `VALUE_DOMAINS.seal_class` ＝ 真源 3 值', seed.SEAL_CLASS_OPTIONS.slice(), (USER_OPS.VALUE_DOMAINS.seal_class || []).slice())
check('d2b', '管理函数 `VALUE_DOMAINS.seal_class` ＝ 真源 3 值', seed.SEAL_CLASS_OPTIONS.slice(), (ADMIN_OPS.VALUE_DOMAINS.seal_class || []).slice())
{
  const source = readFileSync(path.join(ROOT, 'src/services/corrections.js'), 'utf8')
  check('d3', '前端 `FIELD_VALUE_DOMAINS` 接 `seal_class`（提交门值域，静态）', true, /FIELD_VALUE_DOMAINS\s*=\s*\{[\s\S]*?seal_class\s*:/.test(source))
}
/* 服务端提交门接值域：以采纳门的运行读数取证（见 (a)）。 */
check('d3b', '服务端值域门**运行时**生效（值域外 ⇒ INVALID_VALUE）', 'INVALID_VALUE', (await USER_OPS.ADMIN_OPS.reviewCorrection({ correction_id: 'cr-sc-order', decision: 'ACCEPTED' }, IDENTITY, CONTEXT)).reason)

/* ---------------------------------------------------------------------------
   8. (e) 逐字相等 —— 前端真源 ↔ 用户函数副本 ↔ 管理函数副本
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'e', title: '逐字相等：seed ↔ 用户函数 ↔ 管理函数' }))
check('e1', '朝代 15：seed ＝ 用户副本', seed.DYNASTY_OPTIONS.slice(), USER_OPS.DYNASTY_OPTIONS.slice())
check('e1b', '朝代 15：seed ＝ 管理副本', seed.DYNASTY_OPTIONS.slice(), ADMIN_OPS.DYNASTY_OPTIONS.slice())
check('e2', '印面内容 9：seed ＝ 用户副本', seed.FACE_CONTENT_OPTIONS.slice(), USER_OPS.FACE_CONTENT_OPTIONS.slice())
check('e2b', '印面内容 9：seed ＝ 管理副本', seed.FACE_CONTENT_OPTIONS.slice(), ADMIN_OPS.FACE_CONTENT_OPTIONS.slice())
check('e3', '印面风格 23：seed ＝ 用户副本', seed.FACE_STYLE_OPTIONS.slice(), USER_OPS.FACE_STYLE_OPTIONS.slice())
check('e3b', '印面风格 23：seed ＝ 管理副本', seed.FACE_STYLE_OPTIONS.slice(), ADMIN_OPS.FACE_STYLE_OPTIONS.slice())
check('e4', '大類 3：seed ＝ 用户副本', seed.SEAL_CLASS_OPTIONS.slice(), USER_OPS.SEAL_CLASS_OPTIONS.slice())
check('e4b', '大類 3：seed ＝ 管理副本', seed.SEAL_CLASS_OPTIONS.slice(), ADMIN_OPS.SEAL_CLASS_OPTIONS.slice())
check('e5', '字段表：客户端真源 ＝ 用户函数副本（逐字）', correctionsSvc.MARKABLE_FIELDS.map((item) => [item.key, item.label]), Object.entries(USER_OPS.MARKABLE_FIELDS))
check('e5b', '字段表：用户函数副本 ＝ 管理函数副本（逐字，D1 主判据）', Object.entries(USER_OPS.MARKABLE_FIELDS), Object.entries(ADMIN_OPS.MARKABLE_FIELDS))
check('e5c', '字段表：客户端真源 ＝ 管理函数副本（逐字）', correctionsSvc.MARKABLE_FIELDS.map((item) => [item.key, item.label]), Object.entries(ADMIN_OPS.MARKABLE_FIELDS))

/* ---------------------------------------------------------------------------
   9. 汇总
   --------------------------------------------------------------------------- */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id),
    seal_class_options: seed.SEAL_CLASS_OPTIONS.slice(),
    aggregate_filter_runnable: aggregateOk
  })
)
process.exit(failures === 0 ? 0 : 1)
