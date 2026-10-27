/**
 * 离线自检 · 识别编码器（sid / fid 纯函数双副本）
 * =============================================================================
 * 判据面 = `docs/seal-face-code-plan-2026-10-27.md` §2 / §6.1 / §6.2（零网络、零库、零 SDK）。
 * 本脚本**只新增、不改动任何既有 `scripts/**`**。红 ⇒ exit 1。
 *
 * 覆盖：
 *   C1 **三副本**逐字节相同（`src/utils/codeId.js` / `cloudfunctions/xiai-user-token/lib/codeId.js`
 *      / `cloudfunctions/xiai-admin-token/lib/codeId.js`（2026-10-27 第三份，admin-token 同改发 sid））
 *   C2 三端可载形态：三份都**不含 `export` / `import` 语句**；CJS `require` 拿到 API；
 *      纯脚本形态（模拟浏览器 ESM 副作用导入：`node:vm` 无 `module` 的上下文）⇒ `globalThis.__XIAI_CODE_ID__`
 *   C3 字母表恰 22、逐字正确、无重复、**不含 I / L / O / U**；`SID_PATTERN` 展开恰为这 22 字母
 *   C4 已知向量：`1 → AAAAB`、`22 → AAABA`、`5153631 → ZZZZZ`、`1 → 00000001`、`99999999 → 99999999`
 *   C5 独立实现对账：sid 用 `Number.prototype.toString(22)` 另算一路（抽样比对）
 *   C6 双射抽样：`decode(encode(n)) === n` 对边界与抽样号成立（两端各自）
 *   C7 越界结构化拒绝：`0 / −1 / 1.5 / 非数字 / SID_MAX / SID_MAX+1 / FID_MAX / FID_MAX+1`
 *   C8 形态门：`I / L / O / U`、数字、长度不符、`00000000` 一律拒绝（**零纠错映射**）
 *   C9 `reason` 字面值**零新增**（只许 `INVALID_VALUE` / `INVALID_FIELD` / `NOT_FOUND`）
 *   N  **负例注入（临时副本；跑完删）**：① 字母表改 21 位 ② 迁移 `mapping` 少一行
 *      ⇒ 同一条判据必须**转红**（`false`），并各带正对照（真源 ⇒ 绿）证明探针能分真假。
 *      注入只在 `os.tmpdir()` 下的临时副本里造，**禁改 `src/**` / `cloudfunctions/**`**。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const FRONT = path.join(ROOT, 'src/utils/codeId.js')
const SERVER = path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/codeId.js')
const ADMIN = path.join(ROOT, 'cloudfunctions/xiai-admin-token/lib/codeId.js')

const results = []
function check(id, title, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  results.push({ id, title, pass, expected, actual })
  return pass
}

/* ---------------------------------------------------------------- C1 三副本 */
const frontBytes = readFileSync(FRONT)
const serverBytes = readFileSync(SERVER)
const adminBytes = readFileSync(ADMIN)
check('C1a', '三副本逐字节相同（byte-length 两两相等）', [frontBytes.length, frontBytes.length], [serverBytes.length, adminBytes.length])
check('C1b', '三副本逐字节相同（与 `src/utils/codeId.js` 的 Buffer.compare 均为 0）', [0, 0], [Buffer.compare(frontBytes, serverBytes), Buffer.compare(frontBytes, adminBytes)])

/* ---------------------------------------------------------------- C2 双端可载 */
const source = serverBytes.toString('utf8')
check('C2a', '双副本不含 `export ` 语句（CJS `require` 不炸）', 0, (source.match(/^\s*export\s/gm) || []).length)
check('C2b', '双副本不含 `import ` 语句', 0, (source.match(/^\s*import\s/gm) || []).length)

const requireFromRoot = createRequire(path.join(ROOT, 'package.json'))
const api = requireFromRoot('./cloudfunctions/xiai-user-token/lib/codeId.js')
const adminApi = requireFromRoot('./cloudfunctions/xiai-admin-token/lib/codeId.js')
check('C1c', '第三份副本（admin-token）`require()` 可载且 API 表面 ＝ 云函数副本', Object.keys(api), Object.keys(adminApi))
check('C2c', '云函数副本 `require()` 直接给出 4 个纯函数', ['function', 'function', 'function', 'function'], [
  typeof api.encodeSealCode,
  typeof api.decodeSealCode,
  typeof api.encodeFaceCode,
  typeof api.decodeFaceCode
])

/* 浏览器形态：无 `module` 的全新上下文里执行同一段源码 ⇒ 只能靠副作用挂到 globalThis。 */
const sandbox = {}
vm.runInNewContext(source, sandbox, { filename: 'codeId.front.js' })
const webApi = sandbox.__XIAI_CODE_ID__
check('C2d', '浏览器形态：`globalThis.__XIAI_CODE_ID__` 拿到同一 API', ['function', 'function', 'function', 'function'], webApi
  ? [typeof webApi.encodeSealCode, typeof webApi.decodeSealCode, typeof webApi.encodeFaceCode, typeof webApi.decodeFaceCode]
  : [typeof undefined, typeof undefined, typeof undefined, typeof undefined])
check('C2e', '两副本 API 表面一致（键序与数量）', Object.keys(api), webApi ? Object.keys(webApi) : [])

/* ---------------------------------------------------------------- C3 字母表 / 形态门 */
const EXPECTED_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ'
check('C3a', '字母表恰 22 位且逐字正确', 22, api.CODE_ALPHABET.length)
check('C3b', '字母表 ＝ 期望字面值', EXPECTED_ALPHABET, api.CODE_ALPHABET)
check('C3c', '字母表无重复字符', 22, new Set(api.CODE_ALPHABET.split('')).size)
check('C3d', '字母表不含 I / L / O / U', [], [...'ILOU'].filter((ch) => api.CODE_ALPHABET.includes(ch)))
check('C3e', 'SID_PATTERN 正则字面 ＝ /^[A-HJ-KM-NP-TV-Z]{5}$/', '^[A-HJ-KM-NP-TV-Z]{5}$', api.SID_PATTERN.source)
check(
  'C3f',
  'SID_PATTERN 展开恰 ＝ 22 字母（A–Z 逐个过门）',
  [...EXPECTED_ALPHABET],
  [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter((ch) => api.SID_PATTERN.test(ch.repeat(5))).map((ch) => ch[0]).filter((ch, i, arr) => true).length === 22
    ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter((ch) => api.SID_PATTERN.test(ch.repeat(5)))
    : `展开 ${[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter((ch) => api.SID_PATTERN.test(ch.repeat(5))).length} 个`
)

/* ---------------------------------------------------------------- C4 已知向量 */
check('C4a', 'encodeSealCode(1) ＝ AAAAB', 'AAAAB', api.encodeSealCode(1).code)
check('C4b', 'encodeSealCode(22) ＝ AAABA', 'AAABA', api.encodeSealCode(22).code)
check('C4c', 'encodeSealCode(5153631) ＝ ZZZZZ', 'ZZZZZ', api.encodeSealCode(api.SID_LAST).code)
check('C4d', 'encodeFaceCode(1) ＝ 00000001', '00000001', api.encodeFaceCode(1).code)
check('C4e', 'encodeFaceCode(99999999) ＝ 99999999', '99999999', api.encodeFaceCode(api.FID_LAST).code)
check('C4f', '常数读数（22 / 5 / 8 / 5153632 / 100000000）', [22, 5, 8, 5153632, 100000000], [
  api.CODE_ALPHABET_SIZE,
  api.SID_LENGTH,
  api.FID_LENGTH,
  api.SID_MAX,
  api.FID_MAX
])

/* ---------------------------------------------------------------- C5 独立实现对账（toString(22) 另算一路） */
function independentSid(n) {
  const digits = n.toString(22).split('').map((ch) => {
    const code = ch.charCodeAt(0)
    if (code >= 48 && code <= 57) return code - 48 // 0-9
    return 10 + (code - 97) // a=10 …
  })
  const padded = [...Array(5 - digits.length).fill(0), ...digits]
  if (padded.length !== 5) return null
  return padded.map((d) => EXPECTED_ALPHABET[d]).join('')
}
const c5samples = [1, 2, 21, 22, 23, 79, 484, 485, 10648, 234256, 1124055, 4000000, api.SID_LAST]
const c5bad = c5samples.filter((n) => api.encodeSealCode(n).code !== independentSid(n))
check('C5', 'sid 与 `toString(22)` 独立实现逐点相等（抽样）', [], c5bad)

/* ---------------------------------------------------------------- C6 双射抽样 */
const bounds = [1, 2, 21, 22, 23, 79, 100, 999, api.SID_LAST - 1, api.SID_LAST]
const stride = []
for (let n = 1; n <= api.SID_LAST; n += 9973) stride.push(n)
const sidSamples = [...new Set([...bounds, ...stride])]
const sidRoundTripBad = sidSamples.filter((n) => {
  const enc = api.encodeSealCode(n)
  if (!enc.ok) return true
  const dec = api.decodeSealCode(enc.code)
  return !dec.ok || dec.no !== n || api.encodeSealCode(dec.no).code !== enc.code
})
check('C6a', `sid 双射抽样（${sidSamples.length} 个号）`, [], sidRoundTripBad)

const fidBounds = [1, 2, 9, 10, 99999999 - 1, 99999999]
const fidStride = []
for (let n = 1; n <= api.FID_LAST; n += 997303) fidStride.push(n)
const fidSamples = [...new Set([...fidBounds, ...fidStride])]
const fidRoundTripBad = fidSamples.filter((n) => {
  const enc = api.encodeFaceCode(n)
  if (!enc.ok) return true
  const dec = api.decodeFaceCode(enc.code)
  return !dec.ok || dec.no !== n || api.encodeFaceCode(dec.no).code !== enc.code
})
check('C6b', `fid 双射抽样（${fidSamples.length} 个号）`, [], fidRoundTripBad)

/* ---------------------------------------------------------------- C7 越界结构化拒绝 */
const reasonsSeen = new Set()
function rejectionOf(fn, input) {
  const res = fn(input)
  if (res && res.reason) reasonsSeen.add(res.reason)
  return res.ok === false && res.reason === 'INVALID_VALUE' ? 'INVALID_VALUE' : `NOT_REJECTED:${JSON.stringify(res)}`
}
const c7 = {
  sid0: rejectionOf(api.encodeSealCode, 0),
  sidNegative: rejectionOf(api.encodeSealCode, -1),
  sidDecimal: rejectionOf(api.encodeSealCode, 1.5),
  sidNaNString: rejectionOf(api.encodeSealCode, 'abc'),
  sidCapacity: rejectionOf(api.encodeSealCode, api.SID_MAX),
  sidOverCapacity: rejectionOf(api.encodeSealCode, api.SID_MAX + 1),
  fid0: rejectionOf(api.encodeFaceCode, 0),
  fidCapacity: rejectionOf(api.encodeFaceCode, api.FID_MAX),
  fidOverCapacity: rejectionOf(api.encodeFaceCode, api.FID_MAX + 1),
  decodeZeroCode: rejectionOf(api.decodeSealCode, 'AAAAA'),
  decodeFidZero: rejectionOf(api.decodeFaceCode, '00000000')
}
check('C7', '越界一律结构化拒绝 `INVALID_VALUE`（含 0 / 容量 / 容量+1 / 10⁸）', {
  sid0: 'INVALID_VALUE',
  sidNegative: 'INVALID_VALUE',
  sidDecimal: 'INVALID_VALUE',
  sidNaNString: 'INVALID_VALUE',
  sidCapacity: 'INVALID_VALUE',
  sidOverCapacity: 'INVALID_VALUE',
  fid0: 'INVALID_VALUE',
  fidCapacity: 'INVALID_VALUE',
  fidOverCapacity: 'INVALID_VALUE',
  decodeZeroCode: 'INVALID_VALUE',
  decodeFidZero: 'INVALID_VALUE'
}, c7)

/* ---------------------------------------------------------------- C8 形态门（零纠错映射） */
const badCodes = [
  'AAAAI', 'AAAAL', 'AAAAO', 'AAAAU', // 字母表禁字
  '12345', 'AAAA0', 'AAAA1', // 数字
  'AAAA', 'AAAAAA', 'AAA', // 长度
  '', 'AAAAA ', // 空 / 空白（`AAAAA ` trim 后 ＝ AAAAA ⇒ 号域 0 ⇒ 拒）
  'AA AA', 'AAA-A'
]
const c8 = badCodes.filter((code) => api.decodeSealCode(code).ok !== false)
check('C8a', 'sid 形态门：禁字 / 数字 / 长度 / 标点一律拒绝', [], c8)
check('C8b', 'decode 归一：小写入码接受且得同号', { ok: true, no: 1 }, api.decodeSealCode('aaaab'))
check('C8c', 'fid 形态门：9 位 / 含字母一律拒绝', [], [
  '123456789', '0000000A', '1234567', ''
].filter((code) => api.decodeFaceCode(code).ok !== false))

/* ---------------------------------------------------------------- C9 reason 字面值零新增 */
;[api.decodeSealCode('x'), api.decodeFaceCode('x'), api.encodeSealCode(0)].forEach((res) => {
  if (res && res.reason) reasonsSeen.add(res.reason)
})
const ALLOWED_REASONS = ['INVALID_VALUE', 'INVALID_FIELD', 'NOT_FOUND']
check('C9', 'reason 字面值零新增', [], [...reasonsSeen].filter((r) => ALLOWED_REASONS.indexOf(r) === -1))

/* ---------------------------------------------------------------- N 负例注入（临时副本；跑完删） */
console.log(JSON.stringify({ section: 'N', title: '负例注入：① 字母表 21 位 ② 迁移 mapping 少一行（临时副本，必红）' }))
const NEG_TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'xiai-codeid-neg-'))

/* ① 把字母表改成 21 位：**复制前端真源到临时副本**（禁改 `src/**` / `cloudfunctions/**`），
   只削掉末位 `Z` ⇒ 同一条 C3 判据必须转红。 */
const ALPHABET_LINE = "const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ'"
const mutatedSource = readFileSync(FRONT, 'utf8').replace(ALPHABET_LINE, "const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXY'")
const mutatedPath = path.join(NEG_TMP_ROOT, 'codeId.alphabet21.js')
writeFileSync(mutatedPath, mutatedSource)
const mutatedApi = requireFromRoot(mutatedPath)
const c3Verdict = (mod) =>
  !!mod &&
  mod.CODE_ALPHABET.length === 22 &&
  mod.CODE_ALPHABET === EXPECTED_ALPHABET &&
  new Set(mod.CODE_ALPHABET.split('')).size === 22 &&
  [...'ILOU'].every((ch) => !mod.CODE_ALPHABET.includes(ch)) &&
  mod.SID_PATTERN.source === '^[A-HJ-KM-NP-TV-Z]{5}$'
check('N1a', '注入体自证：临时副本字母表恰 21 位（注入真的生效）', 21, mutatedApi.CODE_ALPHABET.length)
check('N1p', '正对照：真源副本过同一条 C3 判据（绿）', true, c3Verdict(api))
check('N1', '负例注入①（必红）：字母表改 21 位 ⇒ 同一条 C3 判据转红（actual 必须为 false）', false, c3Verdict(mutatedApi))

/* ② 把迁移 `mapping` 少一行：先用**内存假体 DB**（零网零库）跑真干跑拿到完整 `mapping`，
   再在**临时副本**上抽掉一行 ⇒ 同一条完整性判据必须转红。 */
const negOps = requireFromRoot('./cloudfunctions/xiai-user-token/lib/ops.js')
function makeNegDb(seed) {
  const store = new Map()
  Object.keys(seed).forEach((name) => {
    const table = new Map()
    seed[name].forEach((row) => table.set(row._id, { ...row }))
    store.set(name, table)
  })
  const matches = (row, match) => Object.keys(match).every((key) => row[key] === match[key])
  return {
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
                  Object.assign(row, doc)
                  updated += 1
                }
              }
              return { updated }
            }
          }
          return chain
        },
        doc(id) {
          return {
            get: async () => (rows.has(id) ? { data: [{ ...rows.get(id) }] } : { data: [] }),
            set: async (doc) => {
              rows.set(id, { ...doc, _id: id })
              return { updated: 1 }
            }
          }
        },
        async add(doc) {
          const id = doc._id || `neg-${rows.size + 1}`
          rows.set(id, { ...doc, _id: id })
          return { id }
        }
      }
    }
  }
}
const NC = negOps.COLLECTIONS
const negDb = makeNegDb({
  [NC.seals]: [1, 2, 3].map((n) => ({ _id: `seal-${n}`, stamp_id: String(n), id: String(n), seal_name: `印${n}`, sealGroupId: `g-${n}`, dynasty: '戰國' })),
  [NC.faces]: [1, 2, 3].map((n) => ({ _id: `fc-fx${n}-FACE`, id: `fc-fx${n}-FACE`, stamp_id: String(n), sealId: String(n), kind: 'FACE', seal_name: `印${n}`, face_style: '白文' })),
  [NC.images]: [],
  [NC.corrections]: [],
  [NC.correctionsPublic]: []
})
negOps.setOpsDbProvider(() => negDb)
const NEG_PHONE = String(process.env.XIAI_ADMIN_PHONE || '13900000000').trim()
const negDry = await negOps.ADMIN_OPS.migrateCodeNumbers(
  { dry_run: true },
  { uid: 'u-admin', phone: NEG_PHONE, identity_source: 'SERVER_TOKEN' },
  { adminPhone: NEG_PHONE, nowSeconds: Math.floor(Date.now() / 1000) }
)
const realMapping = (negDry && negDry.mapping) || { seals: [], faces: [] }
const brokenMapping = { seals: realMapping.seals.slice(0, -1), faces: realMapping.faces }
const mappingVerdict = (mapping) =>
  !!mapping && Array.isArray(mapping.seals) && Array.isArray(mapping.faces) && mapping.seals.length === 3 && mapping.faces.length === 3
check('N2a', '真干跑（内存假体 DB）产出完整 mapping ＝ 3 印 ＋ 3 面', { seals: 3, faces: 3 }, { seals: realMapping.seals.length, faces: realMapping.faces.length })
check('N2b', '注入体自证：临时副本 mapping 恰少 1 行（3 → 2）', [3, 2], [realMapping.seals.length, brokenMapping.seals.length])
check('N2p', '正对照：完整 mapping 过同一条完整性判据（绿）', true, mappingVerdict(realMapping))
check('N2', '负例注入②（必红）：迁移 mapping 少一行 ⇒ 同一条完整性判据转红（actual 必须为 false）', false, mappingVerdict(brokenMapping))

/* 清场：临时副本跑完即删（`src/**` / `cloudfunctions/**` 全程只读）。 */
rmSync(NEG_TMP_ROOT, { recursive: true, force: true })
check('N3', '临时副本已删除（跑完清场）', false, existsSync(NEG_TMP_ROOT))

/* ---------------------------------------------------------------- 汇总 */
const failed = results.filter((r) => !r.pass)
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id} ${r.title}${r.pass ? '' : ` | expected=${JSON.stringify(r.expected)} actual=${JSON.stringify(r.actual)}`}`)
}
console.log(JSON.stringify({
  script: 'verify-code-id',
  files: {
    front: 'src/utils/codeId.js',
    server: 'cloudfunctions/xiai-user-token/lib/codeId.js',
    bytes: frontBytes.length
  },
  vectors: { s1: api.encodeSealCode(1).code, s22: api.encodeSealCode(22).code, s79: api.encodeSealCode(79).code, sLast: api.encodeSealCode(api.SID_LAST).code, f1: api.encodeFaceCode(1).code, fLast: api.encodeFaceCode(api.FID_LAST).code },
  samples: { sid: sidSamples.length, fid: fidSamples.length },
  rejected: Object.keys(c7).length + c8.length,
  pass: results.length - failed.length,
  fail: failed.length
}))
process.exit(failed.length > 0 ? 1 : 0)
