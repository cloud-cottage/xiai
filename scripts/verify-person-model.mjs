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

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

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
   5. 写路径清单与单写者门（P2-c：门的调用点 / 是否存在绕过门的写路径）
   ---------------------------------------------------------------------------
   取证口径（机械可复核；本段**只加断言**，不改任何既有断言）：
     · 两集合（`persons` / `person-imports`）的**唯一写入口** ＝ 数据层导出
       `savePersonRows` / `savePersonImportRows`；逐文件扫描证明除定义处 `src/data/db.js`
       与 `src/services/persons.js`（采纳路径 / 外部导入通道）外，**无任何产品模块调用**。
     · 数据层**不导出**任何「按任意键写入」的通用写口（`writeCollection` / `writeKey` 私有）。
     · 产品源码**不经原始 `writeKey` 原语**写这两键。
     · 云水合层 `cloudbase.js` **不持有文档写句柄**（无 `.doc(`）。
     · 门谓词对两集合键恒 `FORBIDDEN`、对其它键放行（`null`）；服务层转发逐字同值。
   结论：**不存在绕过门的写路径**（无通用直写入口可调用），门即单写者面的机械判据。
   ========================================================================== */
const srcWalk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name)
  return entry.isDirectory() ? srcWalk(full) : [full]
})
const relOf = (file) => path.relative(ROOT, file)
const srcFiles = [...srcWalk(path.join(ROOT, 'src')), ...srcWalk(path.join(ROOT, 'cloudfunctions'))].filter((file) => file.endsWith('.js') || file.endsWith('.vue') || file.endsWith('.mjs'))
const srcText = new Map(srcFiles.map((file) => [file, readFileSync(file, 'utf8')]))
const callersOf = (needles) => srcFiles
  .filter((file) => needles.some((needle) => srcText.get(file).includes(needle)))
  .map(relOf)
  .sort()

check('G1', 'P2-c 静态：数据层导出单写者门 `personDirectWriteDenial`', true, dbSrc.includes('export function personDirectWriteDenial('))
const personsSrc = readFileSync(path.join(ROOT, 'src/services/persons.js'), 'utf8')
{
  const at = personsSrc.indexOf('export function personSingleWriterDenial')
  const seg = at === -1 ? '' : personsSrc.slice(at, at + 200)
  check('G2', 'P2-c 静态：服务层 `personSingleWriterDenial` 存在且逐字转发数据层门', true, seg.includes('return personDirectWriteDenial(collectionKey)'))
}
check('G3', 'P2-c 静态：调用 `savePersonRows(` / `savePersonImportRows(` 的产品文件恰为 {db.js, services/persons.js}', ['src/data/db.js', 'src/services/persons.js'], callersOf(['savePersonRows(', 'savePersonImportRows(']))
check('G4', 'P2-c 静态：数据层未导出通用写口（`writeCollection` / `writeKey` 私有；无「按任意键写入」直写入口）', [], ['writeCollection', 'writeKey'].filter((name) => dbSrc.includes('export function ' + name + '(') || dbSrc.includes('export const ' + name + ' ')))
{
  const hits = []
  srcFiles.forEach((file) => {
    srcText.get(file).split('\n').forEach((line, i) => {
      const isWrite = line.includes('writeKey(') || line.includes('migrationBackupWriteKey(')
      const isPersonKey = line.includes('STORAGE_KEYS.persons') || line.includes('STORAGE_KEYS.personImports') || line.includes("'persons'") || line.includes("'person-imports'")
      if (isWrite && isPersonKey) hits.push(relOf(file) + ':' + (i + 1))
    })
  })
  check('G5', 'P2-c 静态：无产品源码经 `writeKey(` 原语直写 persons / person-imports 键', [], hits)
}
{
  const cbSrc = readFileSync(path.join(ROOT, 'src/data/cloudbase.js'), 'utf8')
  check('G6', 'P2-c 静态：云水合层 `cloudbase.js` 不持有文档写句柄（无 `.doc(`）', false, cbSrc.includes('.doc('))
}
/* 负对照 canary：证明上述静态扫描非空转。 */
{
  const canary = new Map(srcText)
  canary.set(path.join(ROOT, 'src/views/__canary__.vue'), "import { savePersonRows } from '../data/db.js'; savePersonRows([])")
  const withCanary = [...canary.keys()].filter((file) => ['savePersonRows(', 'savePersonImportRows('].some((needle) => canary.get(file).includes(needle))).map(relOf).sort()
  check('C3', '负对照 canary：新模块调用 `savePersonRows(` ⇒ G3 扫描会变红（多出该文件）', true, withCanary.length > 2)
}
{
  const mutated = dbSrc.replace('function writeCollection(key, rows) {', 'export function writeCollection(key, rows) {')
  check('C4', '负对照 canary：把 `writeCollection` 改成导出 ⇒ G4 扫描会变红', true, mutated.includes('export function writeCollection('))
}

/* 行为：门谓词（真函数体直调）＋ 服务层转发逐字同值。 */
{
  const personsSvc = await import(path.join(ROOT, 'src/services/persons.js'))
  const dPersons = db.personDirectWriteDenial('persons')
  const dImports = db.personDirectWriteDenial('person-imports')
  check('BG1', 'P2-c 行为：门对 `persons` ⇒ FORBIDDEN（ok:false）', true, !!dPersons && dPersons.ok === false && dPersons.reason === 'FORBIDDEN')
  check('BG2', 'P2-c 行为：门对 `person-imports` ⇒ FORBIDDEN（ok:false）', true, !!dImports && dImports.ok === false && dImports.reason === 'FORBIDDEN')
  check('BG3', 'P2-c 行为：门对非单写者键（`seals`）⇒ 放行（null；门面收窄）', null, db.personDirectWriteDenial('seals'))
  check('BG4', 'P2-c 行为：服务层转发 ≡ 数据层门（三键逐字同值）',
    [db.personDirectWriteDenial('persons'), db.personDirectWriteDenial('person-imports'), db.personDirectWriteDenial('seals')],
    [personsSvc.personSingleWriterDenial('persons'), personsSvc.personSingleWriterDenial('person-imports'), personsSvc.personSingleWriterDenial('seals')])
}

/* ===========================================================================
   D 段（本單新增）：導入行歸一化載荷擴 3 個 extraction 鍵（v1.57｜§3.54.19）
   ---------------------------------------------------------------------------
   判據 id ＝ `X1*` 〜 `XN`（**本單新增；既有 id 一字未動、既有斷言未刪未改**）。
   對應規範：AC-507（鍵面恰 21）/ AC-508（等長 ＋ 非空校驗）/ AC-509（缺鍵不拒收）/
            AC-510（採納不落 person 行 ＋ 回歸面）。
   手法：**注入式假 DB**（內存；「零寫入」判據 ＝ 是否產出 `plan`）交**真實雲函數體**
        `xiai-user-token/lib/ops.js`（封閉鍵面真源）。
   =========================================================================== */
const userOps = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))
const cloudbase = await import(path.join(ROOT, 'src/data/cloudbase.js'))
const EXTRACTION_KEYS = ['courtesy_names_extraction', 'art_names_extraction', 'alias_names_extraction']

/** 內存假 DB（形狀對齊 ops.js 的 `collection(name).where(match).get()` / `.get()` / `.doc(id).get()`）。 */
function makeFakeDb(seed = {}) {
  const collections = new Map()
  Object.keys(seed).forEach((name) => collections.set(name, new Map((seed[name] || []).map((row, i) => [String(row._id || row.id || `${name}-${i}`), row]))))
  return () => ({
    collection(name) {
      const map = collections.get(name) || new Map()
      collections.set(name, map)
      const list = () => [...map.values()].map((row) => Object.assign({}, row))
      return {
        where(match) {
          return { async get() { return { data: list().filter((row) => Object.keys(match).every((k) => row[k] === match[k])) } } }
        },
        async get() { return { data: list() } },
        doc(id) { return { async get() { const row = map.get(String(id)); return { data: row ? [Object.assign({}, row)] : [] } } } }
      }
    }
  })
}
const IMPORT_IDENT = { uid: 'u-import', phone: '13800000000' }
const ADMIN_IDENT = { uid: 'u-admin', phone: '13800000000' }
const ADMIN_CTX = { adminPhone: '13800000000', nowSeconds: 1700000000 }

/* AC-507：封閉鍵面恰 21（雲端）＋ 計數連帶（載荷 18 / PERSON_IMPORT_FIELDS 28 / 空載荷缺省 []）。 */
{
  const keys = userOps.PERSON_IMPORT_ALLOWED_KEYS
  check('X1a', 'AC-507 雲端 `PERSON_IMPORT_ALLOWED_KEYS` 恰 21 鍵（v1.57：18 → 21）', 21, keys.length)
  check('X1b', 'AC-507 3 個 extraction 鍵逐字 ∈ 鍵面', EXTRACTION_KEYS.slice().sort(), EXTRACTION_KEYS.filter((k) => keys.indexOf(k) !== -1).sort())
  check('X1c', '計數連帶：載荷字段恰 18（15 → 18）', 18, seed.PERSON_IMPORT_PAYLOAD_FIELDS.length)
  check('X1d', '計數連帶：`PERSON_IMPORT_FIELDS` 恰 28（行級 10 ＋ 載荷 18）', 28, seed.PERSON_IMPORT_FIELDS.length)
  const empty = seed.emptyPersonImportPayload()
  check('X1e', '空導入載荷：3 個 extraction 鍵缺省 `[]`', { c: [], a: [], l: [] }, { c: empty.courtesy_names_extraction, a: empty.art_names_extraction, l: empty.alias_names_extraction })
  check('X1f', '鍵面無重複（21 鍵去重後仍 21）', 21, new Set(keys).size)
  /* 負對照 canary：注入第 22 鍵 ⇒ 21 尺必報紅（證明非恆等於 21）。 */
  check('X1x', '負對照：注入第 22 鍵 ⇒ 21 尺必報紅', 22, keys.concat(['canary_extra_key']).length)
}

/* AC-509：缺鍵不拒收（舊 18 鍵形態 ⇒ ok:true）。 */
{
  userOps.setOpsDbProvider(makeFakeDb())
  const legacy = {
    batch_id: 'B-legacy', source: 'SRC', source_person_id: 'SP-legacy',
    name_full: '郭照', family_name: '郭', given_name: '照',
    courtesy_names: ['容光', '子青'], art_names: ['曉樓'], alias_names: ['郭容光'],
    birth_year: 1827, death_year: 1895, native_place: '浙江秀水（今嘉興）人。',
    native_place_chs: '浙江秀水（今嘉兴）人。', biography: '郭照(容光)。', biography_chs: '郭照(容光)。',
    nationality: '中國', cbdb_id: null, source_id: 'RW2132'
  }
  const res = await userOps.OPS.submitPersonImport(legacy, IMPORT_IDENT)
  check('X2', 'AC-509 缺鍵不拒收：舊 18 鍵載荷 ⇒ ok:true', true, res.ok === true)
  check('X2b', 'AC-509 該載荷鍵面恰 18（無 3 個 extraction 鍵）', 18, Object.keys(legacy).length)
  check('X2c', 'AC-509 落行 3 個 extraction 鍵為缺省 `[]`（不因缺鍵拒收）', { c: [], a: [], l: [] },
    { c: res.row && res.row.courtesy_names_extraction, a: res.row && res.row.art_names_extraction, l: res.row && res.row.alias_names_extraction })
}

/* AC-508（正）：等長 ＋ 非空 ⇒ ok:true；落行含 3 鍵且各與值陣列等長；值域不封閉。 */
{
  userOps.setOpsDbProvider(makeFakeDb())
  const good = {
    batch_id: 'B-ok', source: 'SRC', source_person_id: 'SP-ok', family_name: '郭', given_name: '照',
    courtesy_names: ['容光', '子青'], courtesy_names_extraction: ['rule-based', 'rule-based'],
    art_names: ['曉樓'], art_names_extraction: ['rule-based'],
    alias_names: ['郭容光'], alias_names_extraction: ['manual']
  }
  const res = await userOps.OPS.submitPersonImport(good, IMPORT_IDENT)
  const row = (res && res.row) || {}
  check('X3', 'AC-508 等長（2/1/1）⇒ ok:true', true, res.ok === true)
  check('X3b', 'AC-508 落行 3 鍵各與對應值陣列等長', { c: 2, a: 1, l: 1 },
    { c: (row.courtesy_names_extraction || []).length, a: (row.art_names_extraction || []).length, l: (row.alias_names_extraction || []).length })
  check('X3c', '值域不封閉：非 `rule-based` 取值（`manual`）仍被接受', ['manual'], row.alias_names_extraction)
  const readBack = cloudbase.normalizePersonImportRow(row)
  check('X3d', '讀面 `normalizePersonImportRow` 含 3 鍵、同形歸一', { c: ['rule-based', 'rule-based'], a: ['rule-based'], l: ['manual'] },
    { c: readBack.courtesy_names_extraction, a: readBack.art_names_extraction, l: readBack.alias_names_extraction })
}

/* AC-508（負）：不等長 / 空元素 / 非數組 ⇒ `INVALID_VALUE` ＋ 零寫入（無 plan）。 */
{
  userOps.setOpsDbProvider(makeFakeDb())
  const base = { batch_id: 'B-shape', source: 'SRC', family_name: '郭', given_name: '照', courtesy_names: ['容光', '子青'] }
  const uneven = await userOps.OPS.submitPersonImport({ ...base, source_person_id: 'SP-uneven', courtesy_names_extraction: ['rule-based', 'rule-based', 'rule-based'] }, IMPORT_IDENT)
  check('X4', 'AC-508 不等長（值 2 vs extraction 3）⇒ INVALID_VALUE', { ok: false, reason: 'INVALID_VALUE' }, { ok: uneven.ok, reason: uneven.reason })
  check('X4b', 'AC-508 不等長 ⇒ 零寫入（無 plan）', undefined, uneven.plan)
  const emptyEl = await userOps.OPS.submitPersonImport({ ...base, source_person_id: 'SP-empty', courtesy_names_extraction: ['rule-based', ''] }, IMPORT_IDENT)
  check('X5', 'AC-508 空元素 ⇒ INVALID_VALUE ＋ 零寫入', { reason: 'INVALID_VALUE', plan: undefined }, { reason: emptyEl.reason, plan: emptyEl.plan })
  const notArray = await userOps.OPS.submitPersonImport({ ...base, source_person_id: 'SP-str', courtesy_names_extraction: 'rule-based' }, IMPORT_IDENT)
  check('X5b', 'AC-508 非數組 ⇒ INVALID_VALUE ＋ 零寫入', { reason: 'INVALID_VALUE', plan: undefined }, { reason: notArray.reason, plan: notArray.plan })
}

/* AC-510：採納生成 `xiai_persons` 行**不帶** 3 個 extraction 鍵（一句話可改）。 */
{
  const importRow = {
    _id: 'pi-acc-1', id: 'pi-acc-1', batch_id: 'B-acc', source: 'SRC', source_person_id: 'SP-acc',
    status: 'PENDING', family_name: '郭', given_name: '照',
    courtesy_names: ['容光'], courtesy_names_extraction: ['rule-based'],
    art_names: ['曉樓'], art_names_extraction: ['rule-based'],
    alias_names: ['郭容光'], alias_names_extraction: ['manual']
  }
  userOps.setOpsDbProvider(makeFakeDb({ xiai_person_imports: [importRow] }))
  const res = await userOps.ADMIN_OPS.reviewPersonImport({ batch_id: 'B-acc', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
  const personWrite = ((res.plan && res.plan.writes) || []).find((w) => w.collection === 'xiai_persons')
  check('X6', 'AC-510 採納確生成 person 行（kind=set）', true, !!personWrite && personWrite.kind === 'set')
  const personDoc = (personWrite && personWrite.doc) || {}
  check('X6b', 'AC-510 person 行**不含** 3 個 extraction 鍵', [], EXTRACTION_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(personDoc, k)))
  check('X6c', 'AC-510 person 行仍帶值陣列（值面不受影響）', { c: ['容光'], art: ['曉樓'], alias: ['郭容光'] },
    { c: personDoc.courtesy_names, art: personDoc.art_names, alias: personDoc.alias_names })
  /* 迴歸面：集合總數未增（仍 19）；`[data-admin-action]` 未新增由既有 N-1 段/static-check 另判。 */
  const storageKeys = await import(path.join(ROOT, 'src/data/storage.js'))
  check('X7', 'AC-510 回歸面：`STORAGE_KEYS` 集合總數仍未增（25；本單不新增集合）', 25, Object.keys(storageKeys.STORAGE_KEYS).length)
}

/* ===========================================================================
   Y 段（本單新增）：**本地服務層**同口徑（`src/services/persons.js`；local-dev 形態）
   ---------------------------------------------------------------------------
   判據 id ＝ `Y1` 〜 `Y4`（本單新增）。同一 3 個 extraction 鍵的口徑在**服務層寫路**上
   逐條對齊雲端：缺鍵不拒收 / 不等長 `INVALID_VALUE` ＋ 零寫入 / 加成不破壞 / 採納落 person
   行不帶 3 鍵。
   =========================================================================== */
{
  const writeFaceMode = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
  writeFaceMode.setWriteFaceModeOverride('local-dev')
  const session = await import(path.join(ROOT, 'src/data/session.js'))
  const personsSvc2 = await import(path.join(ROOT, 'src/services/persons.js'))
  const actor = { id: 'u-admin', uid: 'u-admin', role: 'admin' }
  session.setUser(actor)

  const legacy = await personsSvc2.submitPersonImport({ batchId: 'B-LOC', source: 'SRC', sourcePersonId: 'LOC-1', payload: { family_name: '郭', given_name: '照', courtesy_names: ['a', 'b'], art_names: ['x'], alias_names: [] } })
  check('Y1', '服務層：缺鍵不拒收（舊 18 鍵載荷 ⇒ ok:true；本地行不擴鍵）', { ok: true, hasExt: false },
    { ok: legacy.ok, hasExt: legacy.row && Object.prototype.hasOwnProperty.call(legacy.row, 'courtesy_names_extraction') })

  const mismatch = await personsSvc2.submitPersonImport({ batchId: 'B-LOC', source: 'SRC', sourcePersonId: 'LOC-2', payload: { family_name: '郭', courtesy_names: ['a', 'b'], courtesy_names_extraction: ['rule-based'] } })
  check('Y2', '服務層：不等長（值 2 vs extraction 1）⇒ INVALID_VALUE ＋ 零寫入', { ok: false, reason: 'INVALID_VALUE' }, { ok: mismatch.ok, reason: mismatch.reason })

  const good = await personsSvc2.submitPersonImport({ batchId: 'B-LOC', source: 'SRC', sourcePersonId: 'LOC-3', payload: { family_name: '郭', courtesy_names: ['a'], courtesy_names_extraction: ['rule-based'], alias_names: ['z'], alias_names_extraction: ['manual'] } })
  check('Y3', '服務層：加成不破壞（等長 ⇒ ok:true；本地行含 3 鍵且值域不封閉）', { ok: true, c: ['rule-based'], a: ['manual'] },
    { ok: good.ok, c: good.row && good.row.courtesy_names_extraction, a: good.row && good.row.alias_names_extraction })

  const before = personsSvc2.listPersons().length
  const adopt = await personsSvc2.reviewPersonImport(actor, { batchId: 'B-LOC', decision: 'ACCEPTED' })
  const personRows = personsSvc2.listPersons()
  const adopted = personRows.find((r) => String(r.source_person_id) === 'LOC-3') || {}
  check('Y4', '服務層：採納落 `xiai_persons` 行**不含** 3 個 extraction 鍵', [], EXTRACTION_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(adopted, k)))
  check('Y4b', '服務層：採納確生成 person 行（恰 2：LOC-1 / LOC-3；LOC-2 被拒未落）', { ok: true, added: 2 }, { ok: adopt.ok, added: personRows.length - before })
}

/* 自證：本套件判據條數**只增不減**（基線 32 ＋ 本單新增；靜態計數，扣 `function check(` 定義 1）。 */
{
  const selfSrc = readFileSync(path.join(ROOT, 'scripts/verify-person-model.mjs'), 'utf8')
  const checkCalls = (selfSrc.match(/(^|[^\w])check\(/g) || []).length - 1
  console.log(JSON.stringify({ section: 'D', title: 'extraction 鍵（v1.57）', check_calls: checkCalls }))
  check('XN', '自證：本套件判據條數只增不減（基線 32 ＋ 本單新增）', true, checkCalls >= 51)
}

/* ---------------------------------------------------------------------------
   4. 汇总
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ summary: 'verify-person-model', failures }))
process.exit(failures > 0 ? 1 : 0)
