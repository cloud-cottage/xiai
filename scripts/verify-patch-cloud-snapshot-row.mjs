/**
 * 离线自检 · **雲端快照行就地改寫單點**（`src/data/db.js::patchCloudSnapshotRow`）
 * =============================================================================
 * 被测件（本单 V3 新增的**同族单点**，与 `mergeCloudSnapshotRows` 并排）：
 *   按行身份（`overlayIdentityOf`：`_id` ⇒ `id` ⇒ `stamp_id`）把**单行的若干键**就地盖进
 *   当前内存云端快照的**既有行** —— 不追加新行、不写 localStorage、不发网络、不置 pending。
 * 判据（**零网络、零 dev server、零写入**；断言失败 ⇒ 退出码非 0）：
 *   S1 已存在行 ⇒ **逐键覆盖**（`face_image_id` 换新值）且**其它键不变**、同集合其它行
 *      **逐字不变**、**不追加行**，且**换了集合数组身份**（读缓存 `cloudRows` 判据据此失效）
 *   S2 身份键三形态都能配对：`_id` / `id` / `stamp_id` 各自独立成行 ⇒ 各自的补丁都命中
 *   S3 快照缺席 ⇒ **空操作、不抛错**：快照 `null` / 缺该集合 / 行不在快照 / 未知集合键 /
 *      行无身份，五支一律 `{patched:false}`；**真模块**在快照缺席下同样空操作（真导出直调）
 *   S4 重复调用**幂等**：第二次同参调用 ⇒ `patched:false`（内容没变 ⇒ 不换数组身份），
 *      行内容与第一次调用后逐字相同、行数不增
 *   F  导出面与被测源码**逐字一致**（真模块 `patchCloudSnapshotRow.toString()` ＝ 从
 *      `src/data/db.js` 抽出的源码）—— 证明下面跑的就是仓里那份实现，不是抄本
 * 抽取方式：按「声明起点 → 首个列 0 的 `}`」切块（`db.js` 顶层函数的既有排版），并在
 * 抽取后用 `F` 段与真模块 `toString()` 对账 —— 抽取漂移会当场转红，不会静默测到旧码。
 * 为什么不用「注入快照后直调真模块」：`cloudbase.js::snapshotRef` 是模块私有（唯一写点在
 * 水合里），**不为测试另开第二套写口**（单点原则）⇒ 行为段用抽出的真源码 ＋ 注入的
 * `cloudBaseSnapshot()` 跑，导出面与空操作段用真模块跑。
 */
/* **测试环境保护哨兵（硬防线）** —— 本套件只跑离线自检：置 `XIAI_NO_REAL_CARD=1`。
   跑任何套件前**不得** export 真 `CARD_API_KEY`（见 `scripts/README-test-net.md`）。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DB_PATH = path.join(ROOT, 'src/data/db.js')

/* --------------------------------------------------------------------------- */
/* 断言 / 读数（与既有 verify-*.mjs 同形）                                      */
/* --------------------------------------------------------------------------- */
const results = []
let failures = 0

function check(id, label, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (!pass) failures += 1
  results.push({ id, label, pass, expected, actual })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}

/* --------------------------------------------------------------------------- */
/* 1. 从 `src/data/db.js` 抽出被测源码（真源，不是抄本）                        */
/* --------------------------------------------------------------------------- */
const source = readFileSync(DB_PATH, 'utf8')

/** 取「声明起点 → 首个列 0 的 `}`」的整块（`db.js` 顶层函数排版既有约定）。 */
function extractBlock(marker) {
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`抽取失败：找不到标记 ${marker}`)
  const end = source.indexOf('\n}', start)
  if (end < 0) throw new Error(`抽取失败：${marker} 后没有列 0 的收尾 }`)
  return source.slice(start, end + 2)
}

/** 取单行 `const … = …`（`firstPresent` 是一行箭头函数）。 */
function extractLine(prefix) {
  const start = source.indexOf(prefix)
  if (start < 0) throw new Error(`抽取失败：找不到 ${prefix}`)
  const end = source.indexOf('\n', start)
  return source.slice(start, end)
}

const firstPresentSrc = extractLine('const firstPresent =')
const overlayIdentityOfSrc = extractBlock('function overlayIdentityOf(')
const patchSrc = extractBlock('export function patchCloudSnapshotRow(')

/* `export ` 前缀去掉后才进 `new Function` 作用域（真模块的 `toString()` 也不含它）。 */
const patchCallableSrc = patchSrc.replace(/^export\s+/, '')

/* --------------------------------------------------------------------------- */
/* 2. 行为段：抽出的真源码 ＋ 注入的 `cloudBaseSnapshot()`（快照由本脚本给）     */
/* --------------------------------------------------------------------------- */
/** 造一份「水合已落定」形态的快照（行形状对齐 `cloudbase.js::normalizeFaceRow`）。 */
function makeSnapshot() {
  return {
    faces: [
      { _id: 'oid-0001', id: 'fc-0001', sealId: 'S001', stamp_id: 'S001', kind: 'FACE', face_image_id: 'img-old', seal_name: '舊印甲' },
      { _id: 'oid-0002', id: 'fc-0002', sealId: 'S001', stamp_id: 'S001', kind: 'FACE', face_image_id: 'img-b', seal_name: '舊印乙' }
    ],
    seals: [{ _id: 'oid-0100', id: 'S001', stamp_id: 'S001', seal_name: '舊印甲', material: '壽山石' }]
  }
}

/** 工厂：把抽出的三段真源码放进程作用域，`cloudBaseSnapshot` / `CLOUD_COLLECTION_KEYS` 由外注入。 */
function makeUnit(cloudBaseSnapshot, cloudKeys) {
  const factory = new Function(
    'cloudBaseSnapshot',
    'CLOUD_COLLECTION_KEYS',
    `${firstPresentSrc}\n${overlayIdentityOfSrc}\n${patchCallableSrc}\nreturn { patchCloudSnapshotRow, overlayIdentityOf }`
  )
  return factory(cloudBaseSnapshot, cloudKeys)
}

const CLOUD_KEYS = ['seals', 'faces', 'images']

/* ---- S1 已存在行 ⇒ 逐键覆盖、其它键不变、不追加行、换数组身份 ---- */
{
  const snapshot = makeSnapshot()
  const facesBefore = snapshot.faces
  const sealsBefore = snapshot.seals
  const row1Before = JSON.stringify(snapshot.faces[1])
  const unit = makeUnit(() => snapshot, CLOUD_KEYS)
  const out = unit.patchCloudSnapshotRow('faces', {
    _id: 'oid-0001',
    id: 'fc-0001',
    face_image_id: 'img-new'
  })
  const row0 = snapshot.faces[0]
  check('S1a', '已存在行 ⇒ patched:true', { patched: true }, out)
  check('S1b', '目标键被覆盖（face_image_id 换新值）', 'img-new', row0.face_image_id)
  check(
    'S1c',
    '其它键不变（seal_name / kind / sealId / stamp_id / id / _id 逐字原样）',
    { seal_name: '舊印甲', kind: 'FACE', sealId: 'S001', stamp_id: 'S001', id: 'fc-0001', _id: 'oid-0001' },
    { seal_name: row0.seal_name, kind: row0.kind, sealId: row0.sealId, stamp_id: row0.stamp_id, id: row0.id, _id: row0._id }
  )
  check('S1d', '同集合其它行逐字不变', row1Before, JSON.stringify(snapshot.faces[1]))
  check('S1e', '不追加行（行数仍 2）', 2, snapshot.faces.length)
  check('S1f', '集合数组身份被替换（读缓存 cloudRows 判据据此失效）', true, snapshot.faces !== facesBefore)
  check('S1g', '同集合只换这一行（第 0 行对象身份也换了）', true, snapshot.faces[0] !== facesBefore[0])
  check('S1h', '未点名的集合不动（seals 数组身份不变）', true, snapshot.seals === sealsBefore)
}

/* ---- S2 身份键三形态都能配对（同一把尺 `overlayIdentityOf`） ---- */
{
  /* `_id` 形态：补丁只带 `_id`。 */
  const byOid = makeSnapshot()
  const unitOid = makeUnit(() => byOid, CLOUD_KEYS)
  const outOid = unitOid.patchCloudSnapshotRow('faces', { _id: 'oid-0002', face_image_id: 'img-oid' })
  check('S2a', '身份键 `_id` 形态配对 ⇒ 覆盖生效', { patched: true, value: 'img-oid' }, { patched: outOid.patched, value: byOid.faces[1].face_image_id })

  /* `id` 形态：行没有 `_id`。 */
  const byId = {
    faces: [{ id: 'fc-0009', sealId: 'S002', stamp_id: 'S002', face_image_id: 'img-id-old' }]
  }
  const unitId = makeUnit(() => byId, CLOUD_KEYS)
  const outId = unitId.patchCloudSnapshotRow('faces', { id: 'fc-0009', face_image_id: 'img-id-new' })
  check('S2b', '身份键 `id` 形态配对 ⇒ 覆盖生效', { patched: true, value: 'img-id-new' }, { patched: outId.patched, value: byId.faces[0].face_image_id })

  /* `stamp_id` 形态：行既无 `_id` 也无 `id`（身份尺第三档）。 */
  const byStamp = {
    faces: [{ stamp_id: 'S009', sealId: 'S009', face_image_id: 'img-st-old' }]
  }
  const unitStamp = makeUnit(() => byStamp, CLOUD_KEYS)
  const outStamp = unitStamp.patchCloudSnapshotRow('faces', { stamp_id: 'S009', face_image_id: 'img-st-new' })
  check('S2c', '身份键 `stamp_id` 形态配对 ⇒ 覆盖生效', { patched: true, value: 'img-st-new' }, { patched: outStamp.patched, value: byStamp.faces[0].face_image_id })

  /* 反例：身份对不上 ⇒ 不改（正对照，证明上面的命中不是恒真）。 */
  const miss = makeSnapshot()
  const unitMiss = makeUnit(() => miss, CLOUD_KEYS)
  const outMiss = unitMiss.patchCloudSnapshotRow('faces', { _id: 'oid-not-here', face_image_id: 'img-x' })
  check('S2d', '身份对不上 ⇒ 空操作（正对照）', false, outMiss.patched)
  check('S2e', '身份对不上 ⇒ 行数与内容都没动', [2, 'img-old'], [miss.faces.length, miss.faces[0].face_image_id])
}

/* ---- S3 快照缺席 ⇒ 空操作、不抛错 ---- */
{
  const cases = [
    ['S3a', '快照 null（未配置 / 未落定 / 已回落）', null, 'faces', { _id: 'oid-0001', face_image_id: 'x' }],
    ['S3b', '快照缺该集合', {}, 'faces', { _id: 'oid-0001', face_image_id: 'x' }],
    ['S3c', '行不在快照里（不追加半截行）', makeSnapshot(), 'faces', { _id: 'oid-404', face_image_id: 'x' }],
    ['S3d', '未知集合键（不往快照塞野键）', makeSnapshot(), 'notACollection', { _id: 'oid-0001', face_image_id: 'x' }],
    ['S3e', '行无身份（不臆造 `_id`）', makeSnapshot(), 'faces', { face_image_id: 'x' }],
    ['S3f', 'row 非对象', makeSnapshot(), 'faces', null]
  ]
  for (const [id, label, snapshot, key, row] of cases) {
    let out = null
    let threw = false
    try {
      out = makeUnit(() => snapshot, CLOUD_KEYS).patchCloudSnapshotRow(key, row)
    } catch (err) {
      threw = true
    }
    check(id, `${label} ⇒ {patched:false} 且不抛错`, { threw: false, patched: false }, { threw, patched: out && out.patched })
  }
}

/* ---- S4 重复调用幂等 ---- */
{
  const snapshot = makeSnapshot()
  const unit = makeUnit(() => snapshot, CLOUD_KEYS)
  const args = ['faces', { _id: 'oid-0001', id: 'fc-0001', face_image_id: 'img-new' }]
  const first = unit.patchCloudSnapshotRow(...args)
  const afterFirst = JSON.stringify(snapshot.faces)
  const afterFirstLen = snapshot.faces.length
  const second = unit.patchCloudSnapshotRow(...args)
  const afterSecond = JSON.stringify(snapshot.faces)
  check('S4a', '第一次：真改写', { patched: true }, first)
  check('S4b', '第二次同参：内容没变 ⇒ 空操作', { patched: false }, second)
  check('S4c', '两次调用后行内容逐字相同（幂等）', afterFirst, afterSecond)
  check('S4d', '两次调用后行数不增', [afterFirstLen, afterFirstLen], [snapshot.faces.length, snapshot.faces.length])
}

/* --------------------------------------------------------------------------- */
/* 3. 导出面：真模块直调（快照缺席 ⇒ 空操作）＋ 源码逐字对账                    */
/* --------------------------------------------------------------------------- */
const db = await import(pathToFileURL(DB_PATH).href)

check('F1', '真模块导出 `patchCloudSnapshotRow`（函数）', 'function', typeof db.patchCloudSnapshotRow)
{
  let out = null
  let threw = false
  try {
    /* 真模块的快照此刻是 `null`（水合未跑）⇒ 正好就是 S3 的「快照缺席」真源直调。 */
    out = db.patchCloudSnapshotRow('faces', { _id: 'oid-0001', face_image_id: 'x' })
  } catch (err) {
    threw = true
  }
  check('F2', '真模块在快照缺席下空操作且不抛错', { threw: false, patched: false }, { threw, patched: out && out.patched })
}
check(
  'F3',
  '被测源码与真模块导出逐字一致（跑的就是仓里那份实现）',
  db.patchCloudSnapshotRow.toString(),
  patchCallableSrc
)
check(
  'F4',
  '实现只经同一把尺 `overlayIdentityOf` 配对 ＋ 同一读口 `cloudBaseSnapshot()` 取快照（不另立第二套）',
  { ruler: true, port: true },
  {
    ruler: /overlayIdentityOf\(item\)/.test(patchCallableSrc),
    port: /cloudBaseSnapshot\(\)/.test(patchCallableSrc)
  }
)

/* --------------------------------------------------------------------------- */
console.log(
  JSON.stringify({
    suite: 'verify-patch-cloud-snapshot-row',
    total: results.length,
    passed: results.length - failures,
    failed: failures
  })
)
if (failures > 0) process.exit(1)
