/**
 * 玺爱 · **印人引用落点自检（person-model §4.1 / P1-1 / P1-2）**（`scripts/verify-person-model.mjs`）
 * ----------------------------------------------------------------------------
 * **本地、离线、零网络**（假 localStorage ＋ 直调数据层真源 / 静态读源）。
 *
 * 判据（与派单口径逐条对应）：
 *   P1-1 上传创建路径：**选了印人 ⇒ 落盘行 `author_person_id` 命中、`author` 不被写为 id**；
 *                      **不选 ⇒ 两键皆空**。（行为：`insertSealRow` ＋ `insertFaceRow` 真源；
 *                      静态：`UploadSealDialog.buildPayload` 写的是 `author_person_id` 键。）
 *   P1-2 **印章行不得落引用副本**（行为：`insertSealRow` 落下的印章行**无** `author_person_id`；
 *                      静态：锚定 db.js 印章行写入段 —— 把该键加回去 ⇒ 本条变红，附正/负对照）。
 *   附带：显示名单点链（引用命中 ⇒ 印人名；旧文本 ⇒ 旧文本；皆空 ⇒ 佚名）。
 *
 * 纪律：不打印任何密钥 / 令牌原文；不碰任何服务；任一断言失败 ⇒ 退出码非 0。
 * 用法：`node scripts/verify-person-model.mjs`
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
   0. localStorage 假体（只为让数据层 ESM 真源在本机 Node 下可导入）
   --------------------------------------------------------------------------- */
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

/* ---------------------------------------------------------------------------
   1. 断言与读数
   --------------------------------------------------------------------------- */
let failures = 0
function check(id, label, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (!pass) failures += 1
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}
const has = (value) => Object.prototype.hasOwnProperty.call(value, 'author_person_id')

/* ---------------------------------------------------------------------------
   2. 静态断言（含正 / 负对照 canary）—— 让「把键改回去」这种变异变红
   --------------------------------------------------------------------------- */
const dbSrc = readFileSync(path.join(ROOT, 'src/data/db.js'), 'utf8')
const uploadSrc = readFileSync(path.join(ROOT, 'src/components/UploadSealDialog.vue'), 'utf8')

/* P1-2 静态：锚定 `insertSealRow` 的印章行写入段 —— 不得出现 `author_person_id:`。 */
const segStart = dbSrc.indexOf('export function insertSealRow')
const segEnd = dbSrc.indexOf('saveSealRows([...rows, row])', segStart)
const sealRowSegment = dbSrc.slice(segStart, segEnd)
check('S1', 'P1-2 静态：insertSealRow 印章行写入段**无** `author_person_id:`', false, /author_person_id\s*:/.test(sealRowSegment))
check('S1', 'P1-2 静态锚点可定位（insertSealRow…saveSealRows 段非空）', true, segStart > 0 && segEnd > segStart)

/* P1-2 静态：印章实体键面也不含该键（引用属印面实体）。 */
const wlStart = dbSrc.indexOf('const SEAL_INSERT_INPUT_FIELDS')
const wlEnd = dbSrc.indexOf(']', wlStart)
const whitelistSegment = dbSrc.slice(wlStart, wlEnd)
check('S2', 'P1-2 静态：`SEAL_INSERT_INPUT_FIELDS` 不含 `author_person_id` 条目（单引号键）', false, /'author_person_id'/.test(whitelistSegment))

/* P1-1 静态：buildPayload 写 `author_person_id`、不写 `author: form.author`。 */
const bpStart = uploadSrc.indexOf('function buildPayload')
const bpEnd = uploadSrc.indexOf('return payload', bpStart)
const buildSegment = uploadSrc.slice(bpStart, bpEnd)
check('S3', 'P1-1 静态：buildPayload 写 `author_person_id` 键', true, /author_person_id\s*:/.test(buildSegment))
check('S4', 'P1-1 静态：buildPayload **不**把 id 写进旧 `author` 键', false, /author\s*:\s*form\.author/.test(buildSegment))

/* 正 / 负对照（canary）：把变异体喂给同一条正则 ⇒ 必须变红（证明判负非空转）。 */
const sealRowMutated = sealRowSegment.replace(
  '    author: clean.author,',
  '    author: clean.author,\n    author_person_id: clean.authorPersonId,'
)
check('C1', '负对照 canary：印章行**加回** `author_person_id:` ⇒ 静态断言会变红', true, /author_person_id\s*:/.test(sealRowMutated))
const buildMutated = buildSegment.replace('author_person_id:', 'author:')
check('C2', '负对照 canary：buildPayload **改回** `author: form.author` ⇒ 静态断言会变红', true, /author\s*:\s*form\.author/.test(buildMutated) && !/author_person_id\s*:/.test(buildMutated))

/* ---------------------------------------------------------------------------
   3. 行为断言：数据层真源（insertSealRow / insertFaceRow / listSeals）
   --------------------------------------------------------------------------- */
const db = await import(path.join(ROOT, 'src/data/db.js'))
const storage = await import(path.join(ROOT, 'src/data/storage.js'))
const seed = await import(path.join(ROOT, 'src/data/seed.js'))
const sealsSvc = await import(path.join(ROOT, 'src/services/seals.js'))

db.ensureSeed()

/* 种一枚正式印人（供引用命中）。 */
const PERSON_ID = 'PR000000001'
storage.writeKey(storage.STORAGE_KEYS.persons, [
  { id: PERSON_ID, code: PERSON_ID, family_name: '黃', given_name: '士陵', courtesy_names: [], art_names: [], alias_names: [] }
])

const ACTOR = { id: 'u-admin', uid: 'u-admin', role: 'admin' }
const DYNASTY = seed.DYNASTY_OPTIONS[0]
const CONTENT = seed.FACE_CONTENT_OPTIONS[0]
let seq = 500
const imageIdFor = (stampId, n) => `img-${stampId}-${n}`
async function seedSealAndFace({ personId = '', legacyAuthor = '' } = {}) {
  const seal = db.insertSealRow(ACTOR, { seal_name: `測試${seq}`, dynasty: DYNASTY, type: CONTENT })
  seq += 1
  const stamp = seal.row.stamp_id
  const imgId = imageIdFor(stamp, 1)
  storage.writeKey(storage.STORAGE_KEYS.images, [
    ...(storage.readKey(storage.STORAGE_KEYS.images) || []),
    { id: imgId, stamp_id: stamp, kind: 'FACE', sha256: 'a'.repeat(64) }
  ])
  const face = await db.insertFaceRow(ACTOR, {
    sealId: stamp, kind: 'FACE', faceImageId: imgId,
    ...(personId ? { author_person_id: personId } : {}),
    ...(legacyAuthor ? { author: legacyAuthor } : {})
  })
  return { stamp, sealRow: seal.row, faceRow: face.row, faceOk: face.ok }
}

/* P1-2 行为：印章行**无**引用副本（键不存在）、旧 `author` 为空串（未被 id 污染）。 */
{
  const { sealRow } = await seedSealAndFace({ personId: PERSON_ID })
  check('B1', 'P1-2 行为：印章行**无** `author_person_id` 键（undefined）', false, has(sealRow))
  check('B2', 'P1-2 行为：印章行 `author_person_id` 为 undefined', 'undefined', String(sealRow.author_person_id))
  check('B3', 'P1-2 行为：印章行旧 `author` 未被写为引用 id', '', sealRow.author)
}

/* P1-1 行为：选了印人 ⇒ **印面行** `author_person_id` 命中、`author` 不被写为 id。 */
{
  const { faceRow, faceOk } = await seedSealAndFace({ personId: PERSON_ID })
  check('B4', 'P1-1 行为：选了印人 ⇒ 印面创建成功', true, faceOk === true)
  check('B5', 'P1-1 行为：印面行 `author_person_id` 命中所选印人 id', PERSON_ID, faceRow.author_person_id)
  check('B6', 'P1-1 行为：印面行 `author` **不是** id（保持空串）', '', faceRow.author)
}

/* P1-1 行为：不选印人 ⇒ 印面行两键皆空。 */
{
  const { faceRow } = await seedSealAndFace({})
  check('B7', 'P1-1 行为：不选印人 ⇒ 印面行 `author_person_id` 空', '', faceRow.author_person_id)
  check('B8', 'P1-1 行为：不选印人 ⇒ 印面行 `author` 空', '', faceRow.author)
}

/* 显示名单点链：引用命中 ⇒ 印人名；旧文本 ⇒ 旧文本；皆空 ⇒ 佚名。 */
{
  const withRef = await seedSealAndFace({ personId: PERSON_ID })
  const legacy = await seedSealAndFace({ legacyAuthor: '舊文本作者' })
  const none = await seedSealAndFace({})
  const find = (stamp) => sealsSvc.listSeals().find((row) => row.stamp_id === stamp)
  const vRef = find(withRef.stamp)
  const vLegacy = find(legacy.stamp)
  const vNone = find(none.stamp)
  check('B9', '显示链：引用命中 ⇒ 印人 display_name', '黃士陵', vRef && vRef.author_display)
  check('B10', '显示链：仅旧文本 ⇒ 旧文本', '舊文本作者', vLegacy && vLegacy.author_display)
  check('B11', '显示链：皆空 ⇒ 佚名', '佚名', vNone && vNone.author_display)
  /* 视图模型 `author_person_id` 取**主印面**（印章行无该键仍正确）。 */
  check('B12', '视图模型 author_person_id ＝ 主印面引用', PERSON_ID, vRef && vRef.author_person_id)
  check('B13', '视图模型 author_person_id 于无引用印章 ⇒ 空', '', vNone && vNone.author_person_id)
}

/* ---------------------------------------------------------------------------
   4. 汇总
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ summary: 'verify-person-model', failures }))
process.exit(failures > 0 ? 1 : 0)
