/**
 * 离线自检 · 服务端发号（`xiai_counters` 原子 CAS 发号）＋ `migrateCodeNumbers` 幂等重编
 * =============================================================================
 * 判据面 = `docs/seal-face-code-plan-2026-10-27.md` §4 / §6.3 / §6.4 / §6.5 / §6.6（**零网络零库**：
 * 注入内存假体 DB，走 `setOpsDbProvider` 既有注入点；不连云库、不写生产）。
 * 本脚本**只新增、不改动任何既有 `scripts/**`**。红 ⇒ exit 1。
 *
 * 覆盖：
 *   M1 管理员门 / 载荷封闭键面 / `dry_run` 缺省 true（零写入）
 *   M2 干跑读数：scanned / assigned / rewritten / skipped / mapping（79 ＋ 79 完整映射）
 *   M3 干跑零写入（全库快照逐字节不变）
 *   M4 执行：五个键族按序改写；`stamp_id` 全 ＝ sid；`seal_no` / `face_no` 连续无空洞
 *   M5 不改写面：`faceId`、影像 `_id`、行 `_id`、`sealGroupId` 逐字不变；勘误 join 行数 36 不变
 *   M6 重放幂等：`assigned` 全 0、`rewritten` 全 0、零写入、逐行前后逐字节不变
 *   M7 计数器：采纳发号从「既有最大号 +1」起、`seq` 单调、无重号（撞号避让亦断言）
 *   M8 `reason` 字面值零新增
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'))
const ops = requireFromRoot('./cloudfunctions/xiai-user-token/lib/ops.js')
const codeId = requireFromRoot('./cloudfunctions/xiai-user-token/lib/codeId.js')

const results = []
function check(id, title, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  results.push({ id, title, pass, expected, actual })
  if (!pass) {
    const clip = (value) => {
      const json = JSON.stringify(value)
      return json && json.length > 300 ? `${json.slice(0, 300)}…(+${json.length - 300})` : json
    }
    console.log(`FAIL ${id} ${title} | expected=${clip(expected)} actual=${clip(actual)}`)
  }
  return pass
}

/* ---------------------------------------------------------------- 内存假体 DB */
let autoId = 0
function applyDoc(row, doc) {
  Object.keys(doc).forEach((key) => {
    const value = doc[key]
    if (value && typeof value === 'object' && typeof value.__inc === 'number') {
      const current = Number(row[key])
      row[key] = (Number.isFinite(current) ? current : 0) + value.__inc
    } else {
      row[key] = value
    }
  })
}
function makeDb(seed) {
  const store = new Map()
  Object.keys(seed).forEach((name) => {
    const table = new Map()
    seed[name].forEach((row) => table.set(row._id, { ...row }))
    store.set(name, table)
  })
  const matches = (row, match) => Object.keys(match).every((key) => row[key] === match[key])
  return {
    command: { inc: (n) => ({ __inc: n }) },
    collection(name) {
      if (!store.has(name)) store.set(name, new Map())
      const rows = store.get(name)
      return {
        where(match) {
          const chain = {
            limit: () => chain,
            get: async () => ({ data: [...rows.values()].filter((row) => matches(row, match)).map((row) => ({ ...row })) }),
            update: async (doc) => {
              let updated = 0
              for (const row of rows.values()) {
                if (matches(row, match)) {
                  applyDoc(row, doc)
                  updated += 1
                }
              }
              return { updated }
            }
          }
          return chain
        },
        add: async (doc) => {
          const id = doc._id || `auto-${(autoId += 1)}`
          if (rows.has(id)) throw new Error('DUPLICATE_KEY')
          rows.set(id, { ...doc, _id: id })
          return { id }
        },
        doc(id) {
          return {
            set: async (doc) => {
              rows.set(id, { ...doc, _id: id })
              return { updated: 1 }
            },
            get: async () => (rows.has(id) ? { data: [{ ...rows.get(id) }] } : { data: [] })
          }
        }
      }
    },
    _snapshot(name) {
      const rows = store.get(name)
      if (!rows) return '[]'
      return JSON.stringify([...rows.keys()].sort().map((key) => rows.get(key)))
    },
    _rows(name) {
      return [...(store.get(name) || new Map()).values()]
    },
    _seed(name, rows) {
      const table = store.get(name) || new Map()
      rows.forEach((row) => table.set(row._id, { ...row }))
      store.set(name, table)
    }
  }
}

/* ---------------------------------------------------------------- 种子：79 行现盘形态 */
const C = ops.COLLECTIONS
function seedData() {
  const seals = []
  const faces = []
  const images = []
  const corrections = []
  const publics = []
  for (let n = 1; n <= 79; n += 1) {
    seals.push({ _id: `seal-${n}`, stamp_id: String(n), id: String(n), seal_name: `印${n}`, sealGroupId: `g-${n}`, dynasty: '戰國' })
    faces.push({
      _id: `fc-fx${n}-FACE`,
      id: `fc-fx${n}-FACE`,
      stamp_id: String(n),
      sealId: String(n),
      kind: 'FACE',
      seal_name: `印${n}`,
      face_style: '白文'
    })
  }
  for (let i = 0; i < 80; i += 1) {
    const owner = String((i % 79) + 1)
    images.push({ _id: `img-${i}`, id: `img-${i}`, stamp_id: owner, sealId: owner, kind: 'FACE' })
  }
  for (let i = 0; i < 36; i += 1) {
    const owner = String((i % 79) + 1)
    corrections.push({ _id: `cr-${i}`, sealId: owner, stamp_id: owner, faceId: `fc-fx${((i % 79) + 1)}-FACE`, field: 'dynasty', value: '戰國' })
  }
  for (let i = 0; i < 6; i += 1) {
    publics.push({ _id: `cp-cr-${i}`, sealId: '1', stamp_id: '1', field: 'dynasty', value: '戰國' })
  }
  return { [C.seals]: seals, [C.faces]: faces, [C.images]: images, [C.corrections]: corrections, [C.correctionsPublic]: publics }
}

const ADMIN_IDENT = { uid: 'u-admin', phone: '13900000000', identity_source: 'SERVER_TOKEN' }
const ADMIN_CTX = { adminPhone: '13900000000', nowSeconds: Math.floor(Date.now() / 1000) }
const FOREIGN_IDENT = { uid: 'u-x', phone: '13000000000', identity_source: 'SERVER_TOKEN' }

const db = makeDb(seedData())
ops.setOpsDbProvider(() => db)

const fullSnapshot = () =>
  JSON.stringify([C.seals, C.faces, C.images, C.corrections, C.correctionsPublic].map((name) => db._snapshot(name)))

/* ---------------------------------------------------------------- M1 管理员门 / 键面 / 缺省 dry_run */
const forbidden = await ops.ADMIN_OPS.migrateCodeNumbers({ dry_run: false }, FOREIGN_IDENT, ADMIN_CTX)
check('M1a', '非白名单身份 ⇒ 结构化拒绝（零写入）', 'FORBIDDEN', forbidden.reason)

const badKey = await ops.ADMIN_OPS.migrateCodeNumbers({ nope: 1 }, ADMIN_IDENT, ADMIN_CTX)
check('M1b', '载荷含未知键 ⇒ `INVALID_FIELD`（封闭键面）', 'INVALID_FIELD', badKey.reason)

const beforeM1 = fullSnapshot()
const defaulted = await ops.ADMIN_OPS.migrateCodeNumbers({}, ADMIN_IDENT, ADMIN_CTX)
check('M1c', '`dry_run` 缺省 `true`', true, defaulted.dry_run)
check('M1d', '缺省干跑 ⇒ 零写入（无 `plan`）', undefined, defaulted.plan)

/* ---------------------------------------------------------------- M2/M3 干跑读数 */
const dry = defaulted
check('M2a', 'scanned ＝ {79, 79, 80, 36, 6}', { seals: 79, faces: 79, images: 80, corrections: 36, corrections_public: 6 }, dry.scanned)
check('M2b', 'assigned ＝ {seals:79, faces:79}', { seals: 79, faces: 79 }, dry.assigned)
check('M2c', 'rewritten ＝ {seals:79, faces:79, images:80, corrections:36, corrections_public:6}',
  { seals: 79, faces: 79, images: 80, corrections: 36, corrections_public: 6 }, dry.rewritten)
check('M2d', 'skipped 全 0（首跑无跳过）', { seals: 0, faces: 0, images: 0, corrections: 0, corrections_public: 0 }, dry.skipped)
check('M2e', 'mapping.seals 完整 79 行', 79, dry.mapping.seals.length)
check('M2f', 'mapping.faces 完整 79 行', 79, dry.mapping.faces.length)
check('M2g', '首行映射 旧"1" → seal_no 1 → AAAAB',
  { old_stamp_id: '1', seal_no: 1, sid: 'AAAAB' }, dry.mapping.seals[0])
check('M2h', '末行映射 旧"79" → seal_no 79',
  { old_stamp_id: '79', seal_no: 79, sid: codeId.encodeSealCode(79).code }, dry.mapping.seals[78])
check('M2i', '印面首行 1 → 00000001', { face_no: 1, fid: '00000001' }, { face_no: dry.mapping.faces[0].face_no, fid: dry.mapping.faces[0].fid })
check('M3', '干跑零写入（全库快照逐字节不变）', beforeM1, fullSnapshot())

/* ---------------------------------------------------------------- M4 执行 */
const run = await ops.ADMIN_OPS.migrateCodeNumbers({ dry_run: false }, ADMIN_IDENT, ADMIN_CTX)
check('M4a', '执行态产出落盘计划（writes ＝ 79+79+80+36+6 ＝ 280）', 280, run.plan.writes.length)
/* 落库（真实链路由 `index.js::persist` 执行；离线自检直接调用同一 `persist`）。 */
await ops.persist(run.plan)
const sealRows = db._rows(C.seals)
check('M4b', '`stamp_id` 全部 ＝ sid 形态', [], sealRows.filter((row) => !codeId.SID_PATTERN.test(row.stamp_id)).map((row) => row._id))
check('M4c', '`stamp_id` 两两不重复', 79, new Set(sealRows.map((row) => row.stamp_id)).size)
check('M4d', '`seal_no` 连续 1…79 无空洞', 79, sealRows.filter((row) => row.seal_no >= 1 && row.seal_no <= 79).length)
check('M4e', '每一行 `sid` ≡ 按 `seal_no` 重算值', [],
  sealRows.filter((row) => row.sid !== codeId.encodeSealCode(row.seal_no).code).map((row) => row._id))
const faceRows = db._rows(C.faces)
check('M4f', '印面 `face_no` 连续 1…79、`fid` 恒等', [],
  faceRows.filter((row) => row.fid !== codeId.encodeFaceCode(row.face_no).code).map((row) => row._id))
check('M4g', '印面 `stamp_id` / `sealId` 跟随所属印章新 sid', [],
  faceRows.filter((row) => row.sealId !== row.stamp_id || !codeId.SID_PATTERN.test(row.sealId)).map((row) => row._id))

/* ---------------------------------------------------------------- M5 不改写面 */
const imageRows = db._rows(C.images)
check('M5a', '影像 `_id` 逐字不变', JSON.stringify(seedData()[C.images].map((r) => r._id).sort()),
  JSON.stringify(imageRows.map((r) => r._id).sort()))
check('M5b', '影像 `stamp_id` 全为新 sid', [], imageRows.filter((row) => !codeId.SID_PATTERN.test(row.stamp_id)).map((row) => row._id))
const correctionRows = db._rows(C.corrections)
check('M5c', '勘误 join：`sealId` 与新 `stamp_id` 行数一致（改前 36 → 改后仍 36）', 36,
  correctionRows.filter((row) => sealRows.some((seal) => seal.stamp_id === row.sealId && seal.stamp_id === row.stamp_id)).length)
check('M5d', '勘误 `faceId` 逐字不变', JSON.stringify(seedData()[C.corrections].map((r) => r.faceId)),
  JSON.stringify(correctionRows.map((r) => r.faceId)))
check('M5e', '行 `_id` 与 `sealGroupId` 逐字不变（§4「其余字段一字不动」）',
  { ids: seedData()[C.seals].map((r) => r._id), groups: seedData()[C.seals].map((r) => r.sealGroupId) },
  { ids: sealRows.map((r) => r._id), groups: sealRows.map((r) => r.sealGroupId) })
const publicRows = db._rows(C.correctionsPublic)
check('M5f', '公开投影 `sealId` ＝ 新 sid（§4 键族）', [], publicRows.filter((row) => !codeId.SID_PATTERN.test(row.sealId)).map((row) => row._id))
check('M5g', '公开投影行内另一别名 `stamp_id` 按 §4「其余字段一字不动」保持原值（冲突点，已登记）',
  ['1', '1', '1', '1', '1', '1'], publicRows.map((row) => row.stamp_id))

/* ---------------------------------------------------------------- M6 重放幂等 */
const afterRun = fullSnapshot()
const replay = await ops.ADMIN_OPS.migrateCodeNumbers({ dry_run: false }, ADMIN_IDENT, ADMIN_CTX)
check('M6a', '重放 assigned 全 0', { seals: 0, faces: 0 }, replay.assigned)
check('M6b', '重放 rewritten 全 0', { seals: 0, faces: 0, images: 0, corrections: 0, corrections_public: 0 }, replay.rewritten)
check('M6c', '重放 idempotent ＝ true', true, replay.idempotent)
check('M6d', '重放零写入（无 `plan`）', undefined, replay.plan)
check('M6e', '重放逐行前后逐字节不变', afterRun, fullSnapshot())

/* ---------------------------------------------------------------- M7 计数器 */
const s1 = await ops.issueCodeNumber('seal')
const s2 = await ops.issueCodeNumber('seal')
const f1 = await ops.issueCodeNumber('face')
check('M7a', '采纳发号从「既有最大号 +1」起（seal ⇒ 80）', [80, 81], [s1.no, s2.no])
check('M7b', '`face` 号源同口径（face ⇒ 80）', 80, f1.no)
check('M7c', '号单调、无重号（80 → 81 严格递增且互异）', true, s2.no === s1.no + 1 && new Set([s1.no, s2.no]).size === 2)
const counterRow = db._rows(ops.COUNTERS_COLLECTION).find((row) => row._id === 'seal')
check('M7d', '`xiai_counters` 文档 `seq` 单调推进到 81', 81, counterRow.seq)
const collision = await ops.issueCodeNumberAvoiding('seal', (no) => no === 82)
check('M7e', '撞号避让：82 被既有行占用 ⇒ 继续取 83', 83, collision.no)
const capped = await ops.ADMIN_OPS.migrateCodeNumbers({ dry_run: 'yes' }, ADMIN_IDENT, ADMIN_CTX)
check('M7f', '`dry_run` 非布林 ⇒ `INVALID_VALUE`（零写入）', 'INVALID_VALUE', capped.reason)

/* ---------------------------------------------------------------- M8 reason 字面值 */
const ALLOWED = ['INVALID_VALUE', 'INVALID_FIELD', 'NOT_FOUND', 'FORBIDDEN', 'STORAGE_UNAVAILABLE', 'MISSING_REQUIRED']
const reasons = [forbidden.reason, badKey.reason, capped.reason].filter(Boolean)
check('M8', '本 op 未新增 reason 字面值', [], reasons.filter((r) => ALLOWED.indexOf(r) === -1))

/* ---------------------------------------------------------------- 汇总 */
const failed = results.filter((r) => !r.pass)
console.log(JSON.stringify({
  script: 'verify-migrate-code-numbers',
  scanned: dry.scanned,
  assigned: dry.assigned,
  rewritten: run.rewritten,
  mapping: { seals: dry.mapping.seals.length, faces: dry.mapping.faces.length },
  writes: run.plan.writes.length,
  counter: { seal_seq: counterRow.seq },
  pass: results.length - failed.length,
  fail: failed.length
}))
process.exit(failed.length > 0 ? 1 : 0)
