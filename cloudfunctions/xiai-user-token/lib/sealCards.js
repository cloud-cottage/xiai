'use strict'
/**
 * 玺爱 · **首页印章卡片分页聚合读面（`listSealCards`）＋ 主印面回填（`repairPrimaryFace`）**
 * ============================================================================
 * 背景（线上实测）：首页曾一次性水合全库（1,251 印章 ＋ 1,741 印面 ＋ 6,439 影像 ≈ 11,800 行）
 * ⇒ 首屏 28〜42 秒。本模块把「读面」改成**服务端分页 ＋ 聚合 DTO**：
 *   · 一页只回 ≤60 枚**卡片**（每枚恰 14 键的扁平 DTO），**不回 URL、不回字节**；
 *   · 缩略图 / 展示件键由服务端**按主印面影像行的真实 `storage_key` 派生**（**不是**一律 `.png`）：
 *       - `storage !== 'server'`（如 bundled 占位行 `placeholder/seal-no-image`）⇒
 *         `display_key` / `thumb_key` **皆空串**（云端桶里没有这个对象 ⇒ 前端自渲染本地占位图）；
 *       - `storage_key` 以 `.tiff` 结尾（源件行）⇒ `display_key = xiai/images/<sha 前兩位>/<sha>.png`
 *         （既有派生规则，一字不变）；
 *       - 其余扩展名（`.png` / `.jpg` / `.jpeg` / `.webp`）⇒ `display_key = storage_key` **原样**；
 *       - `thumb_key = xiai/thumb/<sha 前兩位>/<sha>.webp`（**仅当 `display_key` 非空**；
 *         该对象**允许不存在** ⇒ 前端负责三级回落 thumb → display → 本地占位图；
 *         **无真实 `storage_key` 的派生路除外**：两键同为派生 `.png`，见 `coverKeysOf` ④）；
 *       - **无影像行（或行上无 `storage_key`）且面行无 `image_storage_key`** ⇒ 面行仍带
 *         `image_sha256` 时沿用既有派生 `.png`（改前口径不变），连摘要也没有 ⇒ 两键皆空串；
 *     客户端据此自行取图 ⇒ 页面不再需要全库影像行；
 *   · 0 面印章（数据层允许、展示层不列）**一律不进 `rows`**。
 *
 * 契约（**已冻结，一个字不得改**）：
 *   ① 公开读 action：`listSealCards`（**匿名可调**，不验 token）
 *      载荷封闭键面 `{ limit, cursor, dynasty, seal_type, face_style, category }`
 *        · `limit` 整数 1〜60、缺省 48；越界 / 非整数 ⇒ `INVALID_VALUE`（**零读**）
 *        · `cursor` 上一页最后一枚的 `stamp_id`（升序、**不含**）；空串＝首页
 *        · 四个筛选键：空串＝不限；`dynasty` / `category` 过滤 `xiai_seals`，
 *          `seal_type` / `face_style` 过滤**主印面**（`xiai_faces`）
 *      回包键面封闭 `{ ok:true, rows, next_cursor, has_more, total }`；`ok:false` ⇒ 恰 3 键
 *      `{ ok:false, reason, message }`（`reason` 只用 `lib/config.js::REASONS` 冻结值）。
 *      `rows` 每枚**恰 14 键**：`stamp_id / seal_name / dynasty / category / primary_face_id /
 *      face_count / edge_count / image_id / image_sha256 / image_mime / width / height /
 *      thumb_key / display_key`（**键名与键数冻结**；`thumb_key` / `display_key` 的**取值规则**
 *      见本文件头部「按影像行真实 `storage_key` 派生」五条 —— bundled 占位行与**无引用的**
 *      无影像行两键皆空串，由前端渲染本地占位图）。
 *   ② 管理员 op：`repairPrimaryFace`（落 `ADMIN_OPS`）—— 扫「有 FACE 面但无任何
 *      `is_primary=true`」的章，把 `face_no` 最小的 FACE 行置 `is_primary:true`；`EDGE` 永不置；
 *      幂等（已有 primary 的章不碰）；`dry_run`（缺省 true）**零写**；回包恰 6 键
 *      `{ ok, scanned, eligible, written, samples, next_cursor }`（`dry_run` 与真写**同形**、
 *      `dry_run` 时 `written` 恒 0；`samples` ≤ 5 条、元素恰 3 键
 *      `{ row_id, face_id, face_no }`）。
 *      载荷封闭**恰 3 键** `{ dry_run, limit, cursor }`：`cursor` ＝ 上轮回包的 `next_cursor`
 *      （字符串、缺省 ＝ 从头；非空长度 1〜64；非字符串 ⇒ `INVALID_VALUE`；未知键 ⇒ `INVALID_FIELD`）；
 *      窗口 ＝ 印章行按 **`_id` 升序、严格大于 `cursor`** 的前 `limit` 行；`next_cursor` ＝
 *      **本窗口最后一条被扫描行的 `_id`**（不是最后一条被写的）、窗口扫空 ⇒ 空串。
 *   ③ 公开读 op：`suggestAuthors`（**匿名可调**，`PUBLIC_OPS` 第 2 成员；§3.82.4）
 *      —— 载荷封闭恰 3 键 `{face_id, name, limit}`、回包恰 4 键 `{ok, query, normalized,
 *      candidates}`（候选元素恰 7 键）；**零写、零扣费**；无命中 ⇒ `ok:true` ＋ `[]`。
 *   ④ 管理员 op：`repairAuthorPersonId`（落 `ADMIN_OPS`；§3.82.5）—— 只扫 `kind='FACE'`
 *      且无 `author_person_id` 的行，四道匹配**阈值 80** 回填 `author_person_id` ＋
 *      `author_match`（恰 5 键）＋ 印章级 `xiai_seal_links` 补条（幂等）；`EDGE` 一律不处理；
 *      `dry_run` 回包恰 6 键 `{ok, scanned, eligible, matched, samples, next_cursor}`、
 *      真写恰 7 键 `{ok, scanned, eligible, matched, written, failed, next_cursor}`
 *      （`samples` ≤ 5 条、元素恰 4 键 `{row_id, query, person_id, score}`；
 *      `failed` 元素恰 2 键 `{_id, reason}`）；**不产 `plan`**。
 *
 * 性能口径（**本模块的硬约束**）：
 *   · **零全表扫描做分页** —— 分页一律交给 DB（`cursor` ＋ 升序 ＋ `limit`），服务端只在内存里
 *     处理「一页 ＋ 一个缓冲窗口」；
 *   · 单次请求的集合查询面固定且小：无面筛选 ⇒ 2 次（印章页 ＋ 该页印面）；有面筛选 ⇒ 3 次
 *     （印面候选 ＋ 印章页 ＋ 该页印面）；另有 **1 次 `count()`**（`total`，服务端计数、不传行）
 *     与 **1 次按主印面 `image_id` 的小批量影像读**（≤ `limit` 枚；只为取摘要 / 容器 / 像素尺寸，
 *     **不读字节、不读全库**）。影像读在「每枚卡片都自带 `image_sha256` **与**
 *     `image_storage_key`」时不发生（两样都齐 ⇒ 封面键可由面行直接派生，不必读影像行）。
 *   · `has_more` **不由客户端推算**：本轮多取 1 枚卡片（`limit + 1`）作为判据；窗口耗尽且无
 *     多余枚 ⇒ `false`。
 *
 * 主印面口径：`is_primary === true` 的 FACE 面；**无标记时兼容**取 `face_no` 最小的 FACE 面
 * （历史行未回填）。`EDGE`（边款）**永不**参与主印面判定。
 */

const { REASONS, deny, isCollectionNotExistError } = require('./config.js')
/* **作者校验（§3.82）实现单点**：归一 / 四道匹配 / 载荷与回包键面的**纯函数引擎**在
   `lib/authorMatch.js`（零 DB、零写点）；本文件只做**读写接线**（与 `repairPrimaryFace` 同法）。 */
const authorMatch = require('./authorMatch.js')

/** 延迟取 `lib/ops.js`（打破加载环；离线自检不需要 SDK）。 */
function opsOf() {
  return require('./ops.js')
}

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/** 读响应里的行数组（形态容错；认不出 ⇒ `[]`，**明确空集、不猜**）。 */
function rowsOfReply(reply) {
  if (!reply) return []
  if (Array.isArray(reply)) return reply
  if (Array.isArray(reply.data)) return reply.data
  const data = reply.data || reply.result || null
  if (data && Array.isArray(data.list)) return data.list
  if (data && Array.isArray(data.data)) return data.data
  if (Array.isArray(reply.list)) return reply.list
  return []
}

/* --------------------------------------------------------------------------
 * 冻结键面（**唯一真源**；`index.js` 的按 op 收窄透传与离线自检都引这里）
 * -------------------------------------------------------------------------- */

/** `listSealCards` 载荷封闭键面（**恰 6 键**）。 */
const LIST_SEAL_CARDS_ALLOWED_KEYS = Object.freeze([
  'limit',
  'cursor',
  'dynasty',
  'seal_type',
  'face_style',
  'category'
])

/** 卡片行封闭键面（**恰 14 键**；顺序即回包顺序）。 */
const CARD_ROW_KEYS = Object.freeze([
  'stamp_id',
  'seal_name',
  'dynasty',
  'category',
  'primary_face_id',
  'face_count',
  'edge_count',
  'image_id',
  'image_sha256',
  'image_mime',
  'width',
  'height',
  'thumb_key',
  'display_key'
])

/** `listSealCards` 成功回包键面（**恰 5 键**）。 */
const LIST_SEAL_CARDS_SUCCESS_KEYS = Object.freeze(['ok', 'rows', 'next_cursor', 'has_more', 'total'])

const LIST_SEAL_CARDS_DEFAULT_LIMIT = 48
const LIST_SEAL_CARDS_MAX_LIMIT = 60

/** `repairPrimaryFace` 载荷封闭键面（**恰 3 键**：`dry_run` / `limit` / `cursor`）。 */
const REPAIR_PRIMARY_FACE_ALLOWED_KEYS = Object.freeze(['dry_run', 'limit', 'cursor'])
const REPAIR_PRIMARY_FACE_DEFAULT_LIMIT = 200
const REPAIR_PRIMARY_FACE_MAX_LIMIT = 500
/** `cursor` 长度上界（非空串 1〜64；空串 ＝ 从头、与缺省同义；越界 ⇒ `INVALID_VALUE`）。 */
const REPAIR_PRIMARY_FACE_MAX_CURSOR_LENGTH = 64
/**
 * `repairPrimaryFace` **回包键面（恰 6 键，`dry_run` 与真写同形）**：
 * `{ok, scanned, eligible, written, samples, next_cursor}` —— 本常量**逐字即该 6 键**
 * （含 `ok`；`ok` 与信封同值、`index.js` 叠之幂等）。`index.js` 按 op 收窄透传引这里。
 * 诊断键 `samples` 是排障唯一入口，**不得为凑键数而牺牲**（裁定一）。
 */
const REPAIR_PRIMARY_FACE_READOUT_KEYS = Object.freeze([
  'ok',
  'scanned',
  'eligible',
  'written',
  'samples',
  'next_cursor'
])
/** `repairPrimaryFace` 回包 `samples` 元素封闭键面（**恰 3 键**、最多 5 条）。 */
const REPAIR_PRIMARY_FACE_SAMPLE_KEYS = Object.freeze(['row_id', 'face_id', 'face_no'])

/** 一页印章的读取窗口：`limit + 1` 枚卡片之外再留缓冲（0 面印章 / 面筛选不中的会被跳过）。 */
const CARD_SEAL_WINDOW_FACTOR = 3
const CARD_SEAL_WINDOW_MAX = 180
/** 窗口补读轮数（窗口内可展示卡片不足时再读一轮；**上限固定**，绝不循环到全表）。 */
const CARD_SEAL_WINDOW_ROUNDS = 2
/** 面筛选用候选面窗口（只用 `sealId` 排序取子集，**不读全库影像**）。 */
const CARD_FACE_CANDIDATE_CHUNK = 400
/** 单批影像读上限（＝一页卡片的主印面数；`limit ≤ 60`）。 */
const CARD_IMAGE_BATCH_MAX = 60
/** 退路读面（假体无 `command` / `orderBy` / `skip`）的单次扫描上限（**只服务离线自检**）。 */
const CARD_FALLBACK_SCAN_CAP = 5000

/** 展示件 / 缩略图对象键的**唯一**派生处（形如 `xiai/images/<sha 前兩位>/<sha>.png`）。 */
const CARD_OBJECT_KEY_PREFIX = 'xiai/images'
/** 缩略件对象键前缀（与 `tools/display-artifacts/transcode.mjs::DEFAULT_THUMB_PREFIX` 逐字同值）。 */
const CARD_THUMB_KEY_PREFIX = 'xiai/thumb'
/** 缩略件扩展名（工具侧恒 webp：长边 ≤256 单件）。 */
const CARD_THUMB_KEY_EXT = 'webp'
/** 影像行 `storage` 的唯一真值（mapping.md §3；其它值 ⇒ 云端桶里没有这个对象）。 */
const CARD_IMAGE_SERVER_STORAGE = 'server'
/** 源件容器（只在源件行上出现；其余容器一律**原样回出**，不转码不改写）。 */
const CARD_SOURCE_TIFF_EXT = /\.tiff$/i
/** 非源件行允许原样回出的展示件扩展名族（与 `IMAGE_OBJECT_KEY_PATTERN` 末位分支同族）。 */
const CARD_DISPLAY_EXT = /\.(png|jpe?g|webp)$/i

/* --------------------------------------------------------------------------
 * 字段存取（行形态容错；**零第二套编号规则**）
 * -------------------------------------------------------------------------- */

/** 印章行 ⇒ 卡片主键（`stamp_id` → `sid` → `id` → `_id`；与其余读面同序）。 */
function sealKeyOf(row) {
  if (!row || typeof row !== 'object') return ''
  return text(row.stamp_id) || text(row.sid) || text(row.id) || text(row._id)
}

/** 印面行 ⇒ 所属印章键（`sealId` 为主 —— 建行侧两键同值同写）。 */
function faceSealKeyOf(row) {
  if (!row || typeof row !== 'object') return ''
  return text(row.sealId) || text(row.stamp_id) || text(row.seal_id)
}

function isEdgeFace(row) {
  return text(row && row.kind) === 'EDGE'
}

function faceNoOf(row) {
  const no = Number(row && row.face_no)
  return Number.isFinite(no) ? no : Number.POSITIVE_INFINITY
}

function faceRowKeyOf(row) {
  if (!row || typeof row !== 'object') return ''
  return text(row._id) || text(row.id)
}

/**
 * 该章的主印面：`is_primary === true` 的 FACE 面（多枚被标记时取 `face_no` 最小者）；
 * **无标记 ⇒ 兼容**取 `face_no` 最小的 FACE 面。`EDGE` 永不入选；无 FACE ⇒ `null`。
 * @param {Array<object>} faces 该章全部印面行
 * @returns {object|null}
 */
function primaryFaceOf(faces) {
  const source = Array.isArray(faces) ? faces.filter((row) => row && typeof row === 'object' && !isEdgeFace(row)) : []
  if (source.length === 0) return null
  const ordered = source.slice().sort((a, b) => faceNoOf(a) - faceNoOf(b))
  const flagged = ordered.find((row) => row.is_primary === true)
  return flagged || ordered[0]
}

/** 摘要 ⇒ 对象键（空摘要 ⇒ 空串；**不拼 URL、不回字节**）。 */
function objectKeyOfDigest(sha256) {
  const sha = text(sha256)
  if (sha === '') return ''
  return `${CARD_OBJECT_KEY_PREFIX}/${sha.slice(0, 2)}/${sha}.png`
}

/** 64 位小写十六进制摘要（空 / 畸形 ⇒ `''`；**不猜、不补零**）。 */
function digestOf(value) {
  const sha = text(value).toLowerCase()
  return /^[0-9a-f]{64}$/.test(sha) ? sha : ''
}

/** 摘要 ⇒ 缩略件对象键（`xiai/thumb/<sha 前兩位>/<sha>.webp`；空摘要 ⇒ 空串）。 */
function thumbKeyOfDigest(sha256) {
  const sha = digestOf(sha256)
  if (sha === '') return ''
  return `${CARD_THUMB_KEY_PREFIX}/${sha.slice(0, 2)}/${sha}.${CARD_THUMB_KEY_EXT}`
}

/**
 * 对象键内嵌的内容寻址摘要（`xiai/images|thumb/<sha 前兩位>/<sha>.<ext>` 且前两位 ≡ 摘要 ⇒ 摘要；
 * 其余形态（含 bundled 占位键 `placeholder/seal-no-image`）⇒ `''`，**不猜**）。
 */
function digestOfObjectKey(key) {
  const matched = /^xiai\/(?:images|thumb)\/([0-9a-f]{2})\/([0-9a-f]{64})\.[a-z0-9]+$/i.exec(text(key))
  if (!matched) return ''
  const sha = matched[2].toLowerCase()
  return matched[1].toLowerCase() === sha.slice(0, 2) ? sha : ''
}

/**
 * **主印面封面两键的唯一派生处**（按影像行**真实** `storage_key`，不是一律 `.png`）。
 *
 * 判序（逐条互斥，任一判不过 ⇒ 两键皆空串）：
 *   ① 影像行在场且 `storage !== 'server'`（bundled 占位行）⇒ 两键皆 `''`
 *      （云端桶里没有这个对象；前端渲染本地占位图）；
 *   ② `storage_key` 以 `.tiff` 结尾（源件行）⇒ `display_key` ＝ 既有派生 `.png`；
 *   ③ 其余扩展名（`.png` / `.jpg` / `.jpeg` / `.webp`）⇒ `display_key` ＝ `storage_key` **原样**；
 *   ④ 其它扩展名（`.gif` / 无扩展名）⇒ 两键皆 `''`（不造键）；**无行无键** ⇒ 面行自带摘要
 *      时沿用既有派生 `.png`（改前口径，`verify-public-ops` P3 钉住；**此路两键同键**），
 *      连摘要也没有 ⇒ 两键皆 `''`；
 *   ⑤ 有真实 `storage_key` 且 `display_key` 非空 ⇒ `thumb_key = xiai/thumb/<sha 前兩位>/<sha>.webp`
 *      （该对象**允许不存在** ⇒ 前端负责三级回落）；取不到摘要 ⇒ `thumb_key` 亦 `''`。
 * 影像行缺席时回落到**面行自带的影像引用**（`image_storage_key` / `image_sha256`）；
 * 连面行引用也没有 ⇒ `''`（**无行无摘要 ＝ 无从派生**，不编造对象键）。
 *
 * @param {object|null} image 主印面影像行（读到才传；缺席传 `null`）
 * @param {object|null} face 主印面行（`image_storage_key` / `image_sha256`）
 * @param {string} digest 卡片级摘要（`image.sha256` ／ 面行 `image_sha256` 已在调用方合并）
 * @returns {{displayKey:string, thumbKey:string}}
 */
function coverKeysOf(image, face, digest) {
  const empty = { displayKey: '', thumbKey: '' }
  const row = image && typeof image === 'object' ? image : null
  /* ① 非 `server` 行（bundled 占位行等）：桶里没有对象 ⇒ 两键皆空。 */
  if (row && text(row.storage).trim().toLowerCase() !== CARD_IMAGE_SERVER_STORAGE) return empty
  /* 键真源：影像行 `storage_key` 优先；行缺席 / 行上无键 ⇒ 面行自带引用。 */
  const storageKey = (row && text(row.storage_key)) || text(face && face.image_storage_key)
  const keySha = digestOfObjectKey(storageKey)
  const rowSha = digestOf(row && row.sha256) || digestOf(digest)
  if (keySha !== '' && rowSha !== '' && keySha !== rowSha) return empty // 键与摘要不一致 ⇒ 不猜不拼
  const sha = keySha || rowSha
  if (storageKey === '') {
    /* ④ 无行无键 ⇒ 面行自带摘要时**沿用既有派生 `.png`**（本模块改前口径；`verify-public-ops` P3
       钉住此形态）；连摘要也没有 ⇒ 两键皆 `''`（**无从派生，不编造对象键**）。
       此路 `thumb_key` 与 `display_key` **同键**（＝派生 `.png`）：只有摘要、没有真实 `storage_key`
       ⇒ **不足以断言** `xiai/thumb/` 产物键面（缩略件由离线转码工具上传，未必跑过这一枚）。 */
    const derived = objectKeyOfDigest(sha)
    return derived === '' ? empty : { displayKey: derived, thumbKey: derived }
  }
  if (CARD_SOURCE_TIFF_EXT.test(storageKey)) {
    /* ② 源件行 ⇒ 派生 `.png`（既有派生规则不变）。 */
    if (sha === '') return empty
    const displayKey = `${CARD_OBJECT_KEY_PREFIX}/${sha.slice(0, 2)}/${sha}.png`
    return { displayKey, thumbKey: thumbKeyOfDigest(sha) }
  }
  if (!CARD_DISPLAY_EXT.test(storageKey)) return empty /* ④ 非展示件族（含 bundled 占位键）。 */
  /* ③ 展示件行 ⇒ `storage_key` 原样；⑤ 摘要在场才给 thumb（允许对象不存在）。 */
  return { displayKey: storageKey, thumbKey: thumbKeyOfDigest(sha) }
}

/** 像素尺寸（未知 ⇒ `null`；**不假装 0**）。 */
function dimensionOf(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.round(num) : null
}

/* --------------------------------------------------------------------------
 * DB 适配（主路交给 DB 排序 / 游标；退路只服务离线假体，**绝不改变语义**）
 * -------------------------------------------------------------------------- */

function dbOf() {
  return opsOf().resolveDb()
}

function commandOf(db) {
  const command = db && db.command
  return command && typeof command.gt === 'function' ? command : null
}

/**
 * 退路读面：假体没有 `command` / `orderBy` / `skip` 时，把该集合的分页读回（**上限固定**），
 * 供调用方在内存里做「等值筛选 → 游标 → 排序 → 切片」。**只在注入式假体上发生**；
 * 生产 SDK 恒走主路（服务端排序 ＋ 游标）。
 */
async function readAllBounded(db, collection, cap) {
  const probe = db.collection(collection).where({})
  if (!probe || typeof probe.get !== 'function') throw new Error('DB_QUERY_UNSUPPORTED')
  const limit = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Math.floor(Number(cap)) : CARD_FALLBACK_SCAN_CAP
  if (typeof probe.skip !== 'function') return rowsOfReply(await probe.get()).slice(0, limit)
  const collected = []
  let offset = 0
  for (let page = 0; page < 50; page += 1) {
    let chain = db.collection(collection).where({})
    if (typeof chain.orderBy === 'function') chain = chain.orderBy('_id', 'asc')
    if (offset > 0 && typeof chain.skip === 'function') chain = chain.skip(offset)
    if (typeof chain.limit === 'function') chain = chain.limit(1000)
    const rows = rowsOfReply(await chain.get())
    if (rows.length === 0) break
    collected.push(...rows)
    if (collected.length >= limit) break
    if (rows.length < 1000) break
    offset += rows.length
  }
  return collected.slice(0, limit)
}

/**
 * **有序窗口读**（唯一读点）：按 `idField` 升序、**严格大于 `after`** 取前 `limit` 行。
 * @param {object} db DB 句柄
 * @param {string} collection 集合名（`^xiai_`）
 * @param {object} options `{ match, idField, after, limit, idIn }`
 */
async function readOrderedWindow(db, collection, options) {
  const match = options && options.match && typeof options.match === 'object' ? options.match : {}
  const idField = text(options && options.idField) || '_id'
  const after = text(options && options.after)
  const limit = Math.max(1, Math.floor(Number(options && options.limit) || 1))
  const idIn = Array.isArray(options && options.idIn) ? options.idIn.map((value) => text(value)).filter((value) => value !== '') : null
  const command = commandOf(db)
  if (command) {
    const where = Object.assign({}, match)
    let clientFiltered = false
    if (idIn && idIn.length > 0 && typeof command.in === 'function') {
      where[idField] = command.in(idIn)
      clientFiltered = after !== ''
    } else if (after !== '') {
      where[idField] = command.gt(after)
    } else if (idIn && idIn.length > 0) {
      /* 无 `in` 命令 ⇒ 走退路，条件由内存判。 */
      return readOrderedWindowFallback(db, collection, { match, idField, after, limit, idIn })
    }
    let chain = db.collection(collection).where(where)
    if (chain && typeof chain.orderBy === 'function') chain = chain.orderBy(idField, 'asc')
    if (chain && typeof chain.limit === 'function') chain = chain.limit(clientFiltered ? Math.max(limit, idIn.length) : limit)
    const rows = rowsOfReply(await chain.get())
    return sortedWindowOf(rows, idField, after, limit, idIn)
  }
  return readOrderedWindowFallback(db, collection, { match, idField, after, limit, idIn })
}

/** 退路：整桶（有上限）读回后按同尺收口。 */
async function readOrderedWindowFallback(db, collection, options) {
  const rows = await readAllBounded(db, collection, CARD_FALLBACK_SCAN_CAP)
  return sortedWindowOf(rows, options.idField, options.after, options.limit, options.idIn)
}

/** 内存收口（**与主路同尺**：等值条件 → `idIn` → 游标 → 升序 → 切片）。 */
function sortedWindowOf(rows, idField, after, limit, idIn) {
  const cursor = text(after)
  const allow = Array.isArray(idIn) && idIn.length > 0 ? new Set(idIn) : null
  const filtered = (Array.isArray(rows) ? rows : []).filter((row) => {
    const key = text(row && row[idField]) || text(row && row._id)
    if (key === '') return false
    if (allow && !allow.has(key)) return false
    if (cursor !== '' && !(key > cursor)) return false
    return true
  })
  filtered.sort((a, b) => {
    const left = text(a && a[idField]) || text(a && a._id)
    const right = text(b && b[idField]) || text(b && b._id)
    return left < right ? -1 : left > right ? 1 : 0
  })
  return filtered.slice(0, Math.max(1, Math.floor(Number(limit) || 1)))
}

/**
 * 等值筛选（**只用纯值条件**；主路交给 DB，退路在内存判 —— 两条路同一张匹配表）。
 * @param {Array<object>} rows 候选行
 * @param {object} match 等值条件
 */
function matchRows(rows, match) {
  const keys = Object.keys(match || {})
  if (keys.length === 0) return Array.isArray(rows) ? rows.slice() : []
  return (Array.isArray(rows) ? rows : []).filter((row) => keys.every((key) => text(row && row[key]) === text(match[key])))
}

/** 服务端计数（`total` 口径；**不传行**）。计数不可用时退路为按上限读回后计数。 */
async function countRows(db, collection, match) {
  const where = match && typeof match === 'object' ? match : {}
  try {
    const chain = db.collection(collection).where(where)
    if (chain && typeof chain.count === 'function') {
      const reply = await chain.count()
      const total = reply && (reply.total !== undefined ? reply.total : reply.data && reply.data.total)
      const num = Number(total)
      if (Number.isFinite(num) && num >= 0) return Math.floor(num)
    }
  } catch (error) {
    /* 计数面失败**不影响读页**：退路在下面按上限读回后计数（不把真故障伪装成 0）。 */
  }
  const rows = await readAllBounded(db, collection, CARD_FALLBACK_SCAN_CAP)
  return matchRows(rows, where).length
}

/* --------------------------------------------------------------------------
 * 载荷门（**全部判定早于任何读**）
 * -------------------------------------------------------------------------- */

function payloadShapeDenial(payload, allowedKeys) {
  if (payload === undefined || payload === null) return null
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return deny(REASONS.INVALID_FIELD, '載荷形態不合法（應為物件）；本次零讀取。')
  }
  const unknown = Object.keys(payload).filter((key) => allowedKeys.indexOf(key) === -1)
  if (unknown.length > 0) {
    return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（如實報回，不靜默丟鍵）；本次零讀取。`)
  }
  return null
}

/**
 * `listSealCards` 载荷解析（缺省值见契约；**任一不合 ⇒ 结构化拒绝 ＋ 零读**）。
 * @param {object} [payload] 载荷
 * @returns {{ok:true, value:{limit:number, cursor:string, dynasty:string, seal_type:string, face_style:string, category:string}}|{ok:false, reason:string, message:string}}
 */
function parseListSealCardsPayload(payload) {
  const shapeDenial = payloadShapeDenial(payload, LIST_SEAL_CARDS_ALLOWED_KEYS)
  if (shapeDenial) return shapeDenial
  const input = payload && typeof payload === 'object' ? payload : {}
  let limit = LIST_SEAL_CARDS_DEFAULT_LIMIT
  if (Object.prototype.hasOwnProperty.call(input, 'limit')) {
    const raw = input.limit
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > LIST_SEAL_CARDS_MAX_LIMIT) {
      return deny(REASONS.INVALID_VALUE, `\`limit\` 必須是 1〜${LIST_SEAL_CARDS_MAX_LIMIT} 的整數；本次零讀取。`)
    }
    limit = raw
  }
  let cursor = ''
  if (Object.prototype.hasOwnProperty.call(input, 'cursor')) {
    if (typeof input.cursor !== 'string') {
      return deny(REASONS.INVALID_VALUE, '`cursor` 必須是字符串（上一頁末枚的 `stamp_id`）；本次零讀取。')
    }
    cursor = input.cursor.trim()
  }
  const filters = { dynasty: '', seal_type: '', face_style: '', category: '' }
  for (const key of Object.keys(filters)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    if (typeof input[key] !== 'string') {
      return deny(REASONS.INVALID_VALUE, `\`${key}\` 必須是字符串（空串＝不限）；本次零讀取。`)
    }
    filters[key] = input[key].trim()
  }
  return {
    ok: true,
    value: {
      limit,
      cursor,
      dynasty: filters.dynasty,
      seal_type: filters.seal_type,
      face_style: filters.face_style,
      category: filters.category
    }
  }
}

/* --------------------------------------------------------------------------
 * 卡片组装（**唯一一处**：字段面 / 主印面 / 对象键）
 * -------------------------------------------------------------------------- */

/**
 * 一页印章 ⇒ 卡片 DTO 列表（**0 面印章一律不出**）。
 * @param {object} db DB 句柄
 * @param {Array<object>} sealRows 本页印章行（已按 `stamp_id` 升序）
 * @returns {Promise<Array<object>>} 卡片（每枚恰 14 键）
 */
async function cardsOfSealRows(db, sealRows) {
  const detailed = await cardDetailsOfSealRows(db, sealRows)
  return detailed.map((entry) => entry.card)
}

/**
 * 同尺但**带上该章的面行**（面筛选校验用 —— 避免为每枚卡片再打一次面读）。
 * @returns {Promise<Array<{card:object, faces:Array<object>}>>}
 */
async function cardDetailsOfSealRows(db, sealRows) {
  const ops = opsOf()
  const rows = Array.isArray(sealRows) ? sealRows.filter((row) => row && typeof row === 'object') : []
  if (rows.length === 0) return []
  const ids = rows.map(sealKeyOf).filter((id) => id !== '')
  if (ids.length === 0) return []
  /* ① 该页全部印面（**唯一一次面读**；主印面 ＋ 计数同源 ⇒ 不会自相矛盾）。 */
  const faceRows = await readOrderedWindow(db, ops.COLLECTIONS.faces, {
    match: {},
    idField: 'sealId',
    idIn: ids,
    limit: Math.max(ids.length * 6, 60)
  })
  const facesBySeal = new Map()
  for (const doc of faceRows) {
    const sealId = faceSealKeyOf(doc)
    if (sealId === '') continue
    if (!facesBySeal.has(sealId)) facesBySeal.set(sealId, [])
    facesBySeal.get(sealId).push(doc)
  }
  /* ② 主印面影像行（**只按 `image_id` 小批量读；不读字节**）。面行已自带
     `image_sha256` ＋ `image_storage_key`（封面键可由面行直接派生）时才不读。 */
  const pending = []
  for (const sealRow of rows) {
    const faces = facesBySeal.get(sealKeyOf(sealRow)) || []
    const primary = primaryFaceOf(faces)
    const imageId = text(primary && primary.face_image_id)
    if (imageId === '') continue
    if (text(primary && primary.image_sha256) !== '' && text(primary && primary.image_storage_key) !== '') continue
    pending.push(imageId)
  }
  const imageById = new Map()
  if (pending.length > 0) {
    const unique = [...new Set(pending)].slice(0, CARD_IMAGE_BATCH_MAX)
    const imageRows = await readOrderedWindow(db, ops.COLLECTIONS.images, {
      match: {},
      idField: 'id',
      idIn: unique,
      limit: unique.length
    })
    for (const doc of imageRows) {
      const key = text(doc && doc.id) || text(doc && doc._id)
      if (key !== '') imageById.set(key, doc)
    }
  }
  const detailed = []
  for (const sealRow of rows) {
    const stampId = sealKeyOf(sealRow)
    const faces = facesBySeal.get(stampId) || []
    const faceCount = faces.filter((doc) => !isEdgeFace(doc)).length
    if (faceCount < 1) continue // 0 面印章：展示层不列（数据层允许）
    const primary = primaryFaceOf(faces)
    const imageId = text(primary && primary.face_image_id)
    const image = imageId !== '' ? imageById.get(imageId) || null : null
    const sha256 = text(image && image.sha256) || text(primary && primary.image_sha256)
    /* 封面两键：**按影像行真实 `storage_key` 派生**（唯一派生处 `coverKeysOf`）。 */
    const cover = coverKeysOf(image, primary, sha256)
    detailed.push({
      faces,
      card: {
        stamp_id: stampId,
        seal_name: text(sealRow.seal_name) || text(sealRow.name),
        dynasty: text(sealRow.dynasty),
        category: text(sealRow.category),
        primary_face_id: text(primary && (primary.id || primary._id)),
        face_count: faceCount,
        edge_count: faces.filter((doc) => isEdgeFace(doc)).length,
        image_id: imageId,
        image_sha256: sha256,
        image_mime: text(image && image.mime) || text(primary && primary.image_mime),
        width: dimensionOf(image && image.width),
        height: dimensionOf(image && image.height),
        thumb_key: cover.thumbKey,
        display_key: cover.displayKey
      }
    })
  }
  return detailed
}

/** 主印面筛选命中（空筛选 ⇒ 恒真；`EDGE` 从不参与）。 */
function primaryMatches(faces, faceMatch) {
  const keys = Object.keys(faceMatch || {})
  if (keys.length === 0) return true
  const primary = primaryFaceOf(faces)
  if (!primary) return false
  return keys.every((key) => text(primary[key]) === text(faceMatch[key]))
}

/**
 * **面维度筛选的候选印章键**（按 `sealId` 升序、严格大于 `cursor` 取一段）。
 * 只取「`kind=FACE` 且命中面筛选」的面行所属印章 —— **不读影像、不读全表**。
 * @returns {Promise<string[]>} 升序去重的印章键（≤ `CARD_FACE_CANDIDATE_CHUNK`）
 */
async function candidateSealKeysOf(db, faceMatch, cursor) {
  const ops = opsOf()
  const match = Object.assign({ kind: 'FACE' }, faceMatch)
  const rows = await readOrderedWindow(db, ops.COLLECTIONS.faces, {
    match,
    idField: 'sealId',
    after: cursor,
    limit: CARD_FACE_CANDIDATE_CHUNK
  })
  const seen = new Set()
  const keys = []
  for (const doc of rows) {
    const key = faceSealKeyOf(doc)
    if (key === '' || seen.has(key)) continue
    if (cursor !== '' && !(key > cursor)) continue
    seen.add(key)
    keys.push(key)
  }
  keys.sort()
  return keys
}

/* --------------------------------------------------------------------------
 * 公开读 op：`listSealCards`
 * -------------------------------------------------------------------------- */

/**
 * **首页印章卡片分页读（匿名可调｜只读｜零写入）**。
 * @param {object} [payload] 封闭 6 键（缺省值见契约）
 * @returns {Promise<{ok:true, rows:Array<object>, next_cursor:string, has_more:boolean, total:number}|
 *                   {ok:false, reason:string, message:string}>}
 */
async function listSealCards(payload) {
  const parsed = parseListSealCardsPayload(payload)
  if (!parsed.ok) return parsed
  const input = parsed.value
  const ops = opsOf()
  const db = dbOf()
  const sealMatch = {}
  if (input.dynasty !== '') sealMatch.dynasty = input.dynasty
  if (input.category !== '') sealMatch.category = input.category
  const faceMatch = {}
  if (input.seal_type !== '') faceMatch.seal_type = input.seal_type
  if (input.face_style !== '') faceMatch.face_style = input.face_style
  const hasFaceFilter = Object.keys(faceMatch).length > 0
  const wanted = input.limit + 1 // 多取 1 枚 ⇒ `has_more` 有判据，不靠客户端推算
  const windowSize = Math.min(CARD_SEAL_WINDOW_MAX, wanted * CARD_SEAL_WINDOW_FACTOR)
  const cards = []
  let lastCursor = input.cursor
  let exhausted = false

  if (hasFaceFilter) {
    /* 面筛选路：① 面候选（`sealId` 升序、游标截断）→ ② 印章页（`in`）→ ③ 该页印面（与卡片同源）。
       候选用完仍不足 ⇒ 再取一段（**轮数固定上限**，绝不退化成全表扫描）。
       主印面校验只用 ③ 已读回的面行（**不为每枚卡片补读**）。 */
    const candidates = await candidateSealKeysOf(db, faceMatch, input.cursor)
    let candidateAt = 0
    for (let round = 0; round < CARD_SEAL_WINDOW_ROUNDS && cards.length < wanted; round += 1) {
      if (candidateAt >= candidates.length) {
        exhausted = true
        break
      }
      const sliceIds = candidates.slice(candidateAt, candidateAt + windowSize)
      candidateAt += sliceIds.length
      const sealRows = await readOrderedWindow(db, ops.COLLECTIONS.seals, {
        match: sealMatch,
        idField: 'stamp_id',
        idIn: sliceIds,
        limit: sliceIds.length
      })
      if (sealRows.length === 0) continue
      const details = await cardDetailsOfSealRows(db, sealRows)
      for (const entry of details) {
        if (!primaryMatches(entry.faces, faceMatch)) continue
        if (cards.length >= wanted) break
        cards.push(entry.card)
      }
      if (candidateAt >= candidates.length && cards.length < wanted) exhausted = true
    }
    if (candidateAt < candidates.length && cards.length < wanted) exhausted = false
  } else {
    /* 无面筛选：印章页（升序 ＋ 游标）→ 该页印面 → 卡片；窗口不足再读一轮。 */
    for (let round = 0; round < CARD_SEAL_WINDOW_ROUNDS && cards.length < wanted; round += 1) {
      const sealRows = await readOrderedWindow(db, ops.COLLECTIONS.seals, {
        match: sealMatch,
        idField: 'stamp_id',
        after: lastCursor,
        limit: windowSize
      })
      if (sealRows.length === 0) {
        exhausted = true
        break
      }
      lastCursor = sealKeyOf(sealRows[sealRows.length - 1]) || lastCursor
      if (sealRows.length < windowSize) exhausted = true
      const pageCards = await cardsOfSealRows(db, sealRows)
      for (const card of pageCards) {
        if (cards.length >= wanted) break
        cards.push(card)
      }
    }
  }

  /* `has_more`：多取到第 `limit+1` 枚 ⇒ `true`；未取到但**窗口轮数用尽而候选未尽** ⇒ 也按 `true`
     如实上报（下一轮以 `next_cursor` 续取，最多出现一个空页，绝不谎报「已到底」）。 */
  const hasMore = cards.length > input.limit || (!exhausted && cards.length >= input.limit)
  const pageRows = cards.slice(0, input.limit)
  const nextCursor = hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1].stamp_id : ''
  /* `total`：命中**印章侧**筛选的印章数（服务端计数、不传行）。面维度筛选只决定 `rows` 与
     `has_more`，不参与 `total`（0 面印章计入 `total`、不进 `rows` —— 数据层允许 0 面、
     展示层不列；若需 `total` 与 `rows` 严格等数，须另开聚合计数单）。 */
  const total = await countRows(db, ops.COLLECTIONS.seals, sealMatch)
  return {
    ok: true,
    rows: pageRows,
    next_cursor: nextCursor,
    has_more: hasMore,
    total
  }
}

/* --------------------------------------------------------------------------
 * 管理员 op：`repairPrimaryFace`（回填 `is_primary`）
 * -------------------------------------------------------------------------- */

/**
 * **主印面回填（幂等管理员 op）**：扫「有 FACE 面但无任何 `is_primary=true`」的章，把
 * `face_no` 最小的 FACE 行置 `is_primary:true`。`EDGE` 永不置；已有 primary 的章不碰。
 *
 * 载荷封闭 `{ dry_run?:boolean, limit?:number, cursor?:string }`（**恰 3 键**）：
 *   · `dry_run` 缺省 `true`（给了但非布林 ⇒ `INVALID_VALUE`）；
 *   · `limit` 1〜500 整数、缺省 200（＝本轮**扫描的印章数**；越界 / 非整数 ⇒ `INVALID_VALUE`）；
 *   · `cursor` ＝ 上轮回包的 `next_cursor`（**缺省 ＝ 从头**；给了但非字符串 ⇒ `INVALID_VALUE`；
 *     非空长度 1〜64、越界 ⇒ `INVALID_VALUE`；空串与缺省同义 ＝ 从头）。
 * 回包恰 6 键 `{ ok, scanned, eligible, written, samples, next_cursor }`
 * （**`dry_run` 与真写同形**；`dry_run` 时 `written` 恒 0）：
 *   · `scanned` ＝ 本轮扫描的印章行数；`eligible` ＝ 其中「有 FACE 但无 primary」的章数；
 *   · `written` ＝ **读回确认为 `is_primary:true` 的目标行数**（`dry_run` 恒 0）；
 *   · `samples` ＝ 本窗口 eligible 目标的诊断样本（**最多 5 条**、元素恰 3 键
 *     `{row_id, face_id, face_no}` ＝ 被扫描印章行 id ／ 将被置主的面行 id ／ 其 `face_no`；
 *     无 eligible ⇒ `[]`）——**排障唯一入口，任何一轮都不得省略**；
 *   · `next_cursor` ＝ **本窗口最后一条被扫描行的 `_id`**（**不是**最后一条被写的；
 *     窗口扫空 ⇒ 空串）；下一轮把上轮回包的 `next_cursor` 原样回传即得**严格递增**的下一窗口。
 *     **幂等**：已修好的章不再 `eligible` ⇒ 同参重放 `written === 0`。
 * @param {object} [payload] `{dry_run?:boolean, limit?:number, cursor?:string}`
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 */
async function repairPrimaryFace(payload, identity, context) {
  const ops = opsOf()
  /* ① 管理员门（**第一行**；缺 env / 非白名单 ⇒ 结构化拒 ＋ 零读零写）。 */
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ② 载荷门（全部判定早于任何读）。 */
  const shapeDenial = payloadShapeDenial(payload, REPAIR_PRIMARY_FACE_ALLOWED_KEYS)
  if (shapeDenial) return shapeDenial
  const input = payload && typeof payload === 'object' ? payload : {}
  let dryRun = true
  if (Object.prototype.hasOwnProperty.call(input, 'dry_run')) {
    if (typeof input.dry_run !== 'boolean') {
      return deny(REASONS.INVALID_VALUE, '`dry_run` 必須是布林值（true / false）；本次零寫入。')
    }
    dryRun = input.dry_run
  }
  let limit = REPAIR_PRIMARY_FACE_DEFAULT_LIMIT
  if (Object.prototype.hasOwnProperty.call(input, 'limit')) {
    const raw = input.limit
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > REPAIR_PRIMARY_FACE_MAX_LIMIT) {
      return deny(REASONS.INVALID_VALUE, `\`limit\` 必須是 1〜${REPAIR_PRIMARY_FACE_MAX_LIMIT} 的整數；本次零寫入。`)
    }
    limit = raw
  }
  /* `cursor`：字符串（上轮回包 `next_cursor`）；缺省 / 空串 ＝ 从头；非字符串 ⇒ `INVALID_VALUE`；
     非空长度 1〜64、越界 ⇒ `INVALID_VALUE`。**全部判定仍早于任何读。** */
  let cursor = ''
  if (Object.prototype.hasOwnProperty.call(input, 'cursor')) {
    const rawCursor = input.cursor
    if (typeof rawCursor !== 'string') {
      return deny(REASONS.INVALID_VALUE, '`cursor` 必須是字符串（上一輪回包的 `next_cursor`）；本次零讀取。')
    }
    cursor = rawCursor.trim()
    if (cursor.length > REPAIR_PRIMARY_FACE_MAX_CURSOR_LENGTH) {
      return deny(
        REASONS.INVALID_VALUE,
        `\`cursor\` 非空時長度必須在 1〜${REPAIR_PRIMARY_FACE_MAX_CURSOR_LENGTH} 之間（空串 ＝ 從頭；上一輪回包的 \`next_cursor\`）；本次零讀取。`
      )
    }
  }
  const seconds = Number.isFinite(Number(context && context.nowSeconds))
    ? Math.floor(Number(context.nowSeconds))
    : Math.floor(Date.now() / 1000)
  const at = new Date(seconds * 1000).toISOString()
  const db = dbOf()
  /* ③ 扫描窗口：印章行按 **`_id` 升序、严格大于 `cursor`** 的前 `limit` 行
     （服务端 `command.gt` ＋ `orderBy('_id','asc')` ＋ `limit`；假体无 `command` ⇒ 走退路，
      **同一游标推进式**；零全表扫描）。 */
  const sealRows = await readOrderedWindow(db, ops.COLLECTIONS.seals, {
    match: {},
    idField: '_id',
    after: cursor,
    limit
  })
  const scanned = sealRows.length
  /* `next_cursor` ＝ **本窗口最后一条被扫描行的 `_id`**（不是最后一条被写的）；窗口扫空 ⇒ 空串。 */
  const nextCursor = scanned > 0 ? text(sealRows[scanned - 1] && sealRows[scanned - 1]._id) : ''
  if (scanned === 0) return { ok: true, scanned: 0, eligible: 0, written: 0, samples: [], next_cursor: '' }
  const ids = sealRows.map(sealKeyOf).filter((id) => id !== '')
  const faceRows = await readOrderedWindow(db, ops.COLLECTIONS.faces, {
    match: {},
    idField: 'sealId',
    idIn: ids,
    limit: Math.max(ids.length * 6, 60)
  })
  const facesBySeal = new Map()
  for (const doc of faceRows) {
    const sealId = faceSealKeyOf(doc)
    if (sealId === '') continue
    if (!facesBySeal.has(sealId)) facesBySeal.set(sealId, [])
    facesBySeal.get(sealId).push(doc)
  }
  /* ④ 判定：有 FACE 面、且**没有任何** `is_primary===true` 的 FACE 行 ⇒ eligible。
     目标 ＝ `face_no` 最小的 FACE 行（`EDGE` 永不入选）。 */
  const targets = []
  for (const sealRow of sealRows) {
    const sealId = sealKeyOf(sealRow)
    const faces = facesBySeal.get(sealId) || []
    const faceOnly = faces.filter((doc) => doc && typeof doc === 'object' && !isEdgeFace(doc))
    if (faceOnly.length === 0) continue
    if (faceOnly.some((doc) => doc.is_primary === true)) continue
    const target = faceOnly.slice().sort((a, b) => faceNoOf(a) - faceNoOf(b))[0]
    const rowKey = faceRowKeyOf(target)
    if (rowKey === '') continue
    targets.push({
      rowKey,
      sealId,
      /* 诊断样本用：被扫描印章行 id（`_id` 优先）＋ 目标面 `face_no` 原值（缺 ⇒ `null`，键不落空）。 */
      sealRowId: text(sealRow._id) || sealId,
      faceNo: target.face_no === undefined ? null : target.face_no
    })
  }
  const eligible = targets.length
  /* `samples` ＝ 本窗口 eligible 目标的诊断样本（**最多 5 条**、元素恰 3 键
     `{row_id, face_id, face_no}`；`dry_run` 与真写**同形** —— 诊断键是排障唯一入口）。 */
  const samples = targets.slice(0, 5).map((target) => ({
    row_id: target.sealRowId,
    face_id: target.rowKey,
    face_no: target.faceNo
  }))
  if (dryRun || eligible === 0) {
    /* 预演 / 无事可做 ⇒ **零写入**（`written` 恒 0，不谎报；`samples` 照回）。 */
    return { ok: true, scanned, eligible, written: 0, samples, next_cursor: nextCursor }
  }
  /* ⑤ 真写：逐行 `update`（`is_primary:true` ＋ `updated_at`）；单行失败不中断整批。
     读数**以读回为准**：写完按同一批印章重读面行，只数「目标行的 `is_primary` 已为 true」。 */
  const attempted = []
  for (const target of targets) {
    attempted.push(target)
    try {
      await ops.persist({
        writes: [
          {
            kind: 'update',
            collection: ops.COLLECTIONS.faces,
            match: { _id: target.rowKey },
            doc: { is_primary: true, updated_at: at },
            expectAtLeast: 1
          }
        ]
      })
    } catch (error) {
      console.warn(
        `[xiai] repairPrimaryFace 單行寫回報失敗（讀回定真偽；面行：${target.rowKey}；不中斷整批）：`,
        text(error && error.message)
      )
    }
  }
  let written = 0
  try {
    const after = await readOrderedWindow(db, ops.COLLECTIONS.faces, {
      match: {},
      idField: 'sealId',
      idIn: targets.map((target) => target.sealId),
      limit: Math.max(targets.length * 6, 60)
    })
    const stateByKey = new Map()
    for (const doc of after) stateByKey.set(faceRowKeyOf(doc), doc)
    for (const target of attempted) {
      const row = stateByKey.get(target.rowKey)
      if (row && row.is_primary === true) written += 1
      else console.warn(`[xiai] repairPrimaryFace 單行未生效（讀回非 is_primary:true；面行：${target.rowKey}）`)
    }
  } catch (error) {
    /* 读回失败 ⇒ **不敢称写入**（宁报 0 不虚报）。 */
    console.warn('[xiai] repairPrimaryFace 讀回失敗（本輪 written 按 0 如實上報）：', text(error && error.message))
    written = 0
  }
  /* 回包恰 6 键（`dry_run` 与真写同形）；`next_cursor` ＝ 本窗口最后一条被扫描行的 `_id`（不是最后一条被写的）。 */
  return { ok: true, scanned, eligible, written, samples, next_cursor: nextCursor }
}

/* ---------------------------------------------------------------------------
 * 作者校验（§3.82）：公开只读 op `suggestAuthors` ＋ 管理员 op `repairAuthorPersonId`
 * ---------------------------------------------------------------------------
 * 归一 / 四道匹配 / 载荷与回包键面的**纯函数单点 ＝ `lib/authorMatch.js`**；本节只做
 * **读写接线**（读走 `readOrderedWindow` / `ops.readRows`，写走 `ops.persist` 逐行 ＋
 * **整窗读回定真伪** —— 不拿 persist 回报冒充成功）。两个 op 的键面真源都在
 * `lib/authorMatch.js`（`index.js` 按 op 收窄透传引那里）。
 * ------------------------------------------------------------------------ */

/** 印人行读取窗口（分页读全量印人；**有界**，绝不无界循环）。 */
const PERSON_PAGE_SIZE = 500
const PERSON_SCAN_CAP = 5000

/**
 * 按印面编号读面行（`_id` → `id` 两形态；皆不中 ⇒ `null`，**不猜**）。
 * @returns {Promise<object|null>}
 */
async function readFaceRowOf(db, faceId) {
  const ops = opsOf()
  const id = text(faceId)
  if (id === '') return null
  const byPrimaryKey = await ops.readRows(ops.COLLECTIONS.faces, { _id: id }, { limit: 1 })
  if (byPrimaryKey.length > 0) return byPrimaryKey[0]
  const byAppId = await ops.readRows(ops.COLLECTIONS.faces, { id }, { limit: 1 })
  return byAppId.length > 0 ? byAppId[0] : null
}

/**
 * 按印章键读印章行（`stamp_id` → `_id` → `id`；与 `sealKeyOf` 的取键序同尺）。
 * @returns {Promise<object|null>}
 */
async function readSealRowOf(db, sealId) {
  const ops = opsOf()
  const id = text(sealId)
  if (id === '') return null
  const attempts = [{ stamp_id: id }, { _id: id }, { id }]
  for (const match of attempts) {
    const rows = await ops.readRows(ops.COLLECTIONS.seals, match, { limit: 1 })
    if (rows.length > 0) return rows[0]
  }
  return null
}

/**
 * 读全量印人行（`_id` 升序分页；**有界** `PERSON_SCAN_CAP`）—— 匹配面没有服务端检索
 * 索引，四道匹配必须逐人比对 ⇒ 这是本 op 唯一的全集合读（**只读、零写**）。
 * @returns {Promise<Array<object>>}
 */
async function readAllPersons(db) {
  const ops = opsOf()
  const rows = []
  let after = ''
  while (rows.length < PERSON_SCAN_CAP) {
    const want = Math.min(PERSON_PAGE_SIZE, PERSON_SCAN_CAP - rows.length)
    const page = await readOrderedWindow(db, ops.COLLECTIONS.persons, {
      match: {},
      idField: '_id',
      after,
      limit: want
    })
    if (page.length === 0) break
    for (const row of page) rows.push(row)
    const last = text(page[page.length - 1] && page[page.length - 1]._id)
    if (last === '' || last === after) break
    after = last
    if (page.length < want) break
  }
  return rows
}

/**
 * **回源取作者名**（只给 `face_id` 时的查询串）：
 * `faces.author` → 印章 `seal_yz_person_name` → 印章 `author`；三者皆空 ⇒ 空串。
 */
async function authorTextFromFaceOf(db, face) {
  const direct = text(face && face.author)
  if (direct !== '') return direct
  const seal = await readSealRowOf(db, faceSealKeyOf(face))
  if (!seal) return ''
  return text(seal.seal_yz_person_name) || text(seal.author)
}

/**
 * **公开只读 op `suggestAuthors`（匿名可调｜零写零扣费）**：
 * 给姓名（`name`）或印面（`face_id`）⇒ 回一批候选（人 / 朝代 / 命中字段 / 分数）。
 * **无命中不报错**（`ok:true` ＋ `candidates: []`）。
 *
 * 载荷封闭恰 3 键 `{face_id, name, limit}`（未知 / 身份类键 ⇒ `INVALID_FIELD`；
 * `limit` 1〜10 整数缺省 5、越界 ⇒ `INVALID_VALUE`；两键皆空 ⇒ `MISSING_REQUIRED`；
 * **以上判定全部早于任何读**）。回包**恰 4 键** `{ok, query, normalized, candidates}`：
 * `query` ＝ 最终用于匹配的**原文**（入参 `name` 非空 ⇒ 其原文；只给 `face_id` ⇒ 回源取值）、
 * `normalized` ＝ §3.82.1 五步归一形；候选元素**恰 7 键**、`matched_field` 封闭五值。
 * @param {object} [payload] 封闭 3 键
 * @returns {Promise<{ok:true, query:string, normalized:string, candidates:Array<object>}|
 *                   {ok:false, reason:string, message:string}>}
 */
async function suggestAuthors(payload) {
  const parsed = authorMatch.parseSuggestAuthorsPayload(payload)
  if (!parsed.ok) return parsed
  const input = parsed.value
  const db = dbOf()
  let queryRaw = ''
  let currentPersonId = ''
  if (input.name.trim() !== '') {
    /* 入参 `name` 非空 ⇒ `query` ＝ 其**原文**（逐字）。 */
    queryRaw = input.name
  } else {
    const face = await readFaceRowOf(db, input.face_id)
    if (!face) return deny(REASONS.INVALID_VALUE, '該印面不存在；本次零讀取。')
    /* `is_current` ＝ 该人是否为**当前这枚印面的作者引用**（由真源派生、不编造）。 */
    currentPersonId = text(face.author_person_id)
    queryRaw = await authorTextFromFaceOf(db, face)
    if (queryRaw === '') {
      return deny(REASONS.MISSING_REQUIRED, '該印面與其所屬印章皆無作者名 ⇒ 無從匹配；本次零讀取。')
    }
  }
  const normalized = authorMatch.normalizeAuthorName(queryRaw)
  const persons = await readAllPersons(db)
  const candidates = authorMatch.buildCandidates(normalized, persons, input.limit, currentPersonId)
  return { ok: true, query: queryRaw, normalized, candidates }
}

/**
 * **管理员 op `repairAuthorPersonId`（一次性回填；`ADMIN_OPS` 成员）**：
 * 扫 `xiai_faces` 中 **`kind='FACE'` 且 `author_person_id` 空且 `author` 非空** 的行，
 * 按归一后的作者名做四道匹配；**阈值 80**（`name`/`alias`/`courtesy` 命中才回填，
 * `art`(70) / `contains`(50) 只进候选不回填）；`EDGE` 一律不处理。
 *
 * 载荷封闭恰 3 键 `{dry_run:true, limit:200, cursor:''}`（未知 / 身份类键 ⇒
 * `INVALID_FIELD`；`limit` 1〜500 整数缺省 200；判定早于任何读）。
 * 回包（**诊断键保留**）：`dry_run` 恰 6 键 `{ok, scanned, eligible, matched, samples,
 * next_cursor}`；真写恰 7 键 `{ok, scanned, eligible, matched, written, failed,
 * next_cursor}`（`written` ＝ **整窗读回**确认已落的行数；同参重放 ⇒ `written = 0`，幂等）。
 * `samples` ≤ 5 条、元素恰 4 键 `{row_id, query, person_id, score}`（＝本窗口**命中**的目标）；
 * `failed` ＝ 读回**未确认生效**的目标，元素恰 2 键 `{_id, reason}`（`reason` 只用既有冻结值）；
 * 自洽：`written + failed.length === matched`。
 * **`next_cursor` ＝ 本窗口最后一条被扫描行的 `_id`**（**不是**最后一条被写的；
 * 窗口扫空 ⇒ 空串）—— 上轮回包原样回传即得**严格递增**的下一窗口，
 * 逐轮续扫直到 `next_cursor === ''`（`scanned === 0` 时同样回空串、零读零写）。
 *
 * 写面（逐条）：① 面行 `author_person_id` ＋ `author_match`（**恰 5 键**
 * `{field, score, query, normalized, at}`），逐行一次 `persist`（`update` ＋
 * `expectAtLeast:1`）；② 读回确认后，为每个命中的面补**印章级** `xiai_seal_links`
 * 行（`kind:'印人'`、`unresolved:false`；同 (`source_seal_id`, `ref_id`, `kind`) 已有行
 * ⇒ 零新增、幂等）。**seals 行一个字不写**（引用只活在印面行 / 关联行，P1-2）；
 * **不产 `plan`**；`reason` 零新增、零新集合。
 * @param {object} [payload] 封闭 3 键
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 */
async function repairAuthorPersonId(payload, identity, context) {
  const ops = opsOf()
  /* ① 管理员门（**第一行**；缺 env / 非白名单 ⇒ 结构化拒 ＋ 零读零写）。 */
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ② 载荷门（全部判定早于任何读）。 */
  const parsed = authorMatch.parseRepairAuthorPersonIdPayload(payload)
  if (!parsed.ok) return parsed
  const input = parsed.value
  const seconds = Number.isFinite(Number(context && context.nowSeconds))
    ? Math.floor(Number(context.nowSeconds))
    : Math.floor(Date.now() / 1000)
  const at = new Date(seconds * 1000).toISOString()
  const db = dbOf()
  /* ③ 扫描窗口：`kind='FACE'` 且 `_id` 严格大于 `cursor` 的前 `limit` 行（服务端排序）。
     退路读面（注入式假体）不带 `match` ⇒ 这里**再判一次 `kind`**（防御，不改语义）。 */
  const window = await readOrderedWindow(db, ops.COLLECTIONS.faces, {
    match: { kind: 'FACE' },
    idField: '_id',
    after: input.cursor,
    limit: input.limit
  })
  const faceRows = window.filter((row) => row && typeof row === 'object' && text(row.kind) === 'FACE')
  const scanned = faceRows.length
  /* `next_cursor` ＝ **本窗口最后一条被扫描行（`kind='FACE'`）的 `_id`**（不是最后一条被写的）；
     窗口扫空 ⇒ 空串。主路窗口在 DB 侧已按 `_id` 升序 ＋ `gt(cursor)` 收口 ⇒ 严格递增、
     无跳行无重行；退路（假体）先按 `_id` 取窗再滤 `kind` ⇒ 仍以最后一条 `FACE` 行定游标，
     下一窗从它之后起 ⇒ 已扫过的 `FACE` 行不会重复、也不会被跳过。 */
  const nextCursor = scanned > 0 ? text(faceRows[scanned - 1] && faceRows[scanned - 1]._id) : ''
  /* ④ 判定：`author_person_id` 空 ＋ `author` 非空 ⇒ 待回填（**已有引用的行一律不碰**）。 */
  const eligibleRows = faceRows.filter(
    (row) => text(row.author_person_id) === '' && text(row.author) !== ''
  )
  const eligible = eligibleRows.length
  if (scanned === 0) {
    return input.dry_run
      ? { ok: true, scanned: 0, eligible: 0, matched: 0, samples: [], next_cursor: '' }
      : { ok: true, scanned: 0, eligible: 0, matched: 0, written: 0, failed: [], next_cursor: '' }
  }
  const persons = await readAllPersons(db)
  const targets = []
  for (const row of eligibleRows) {
    const rowId = text(row._id) || text(row.id)
    if (rowId === '') continue
    const queryRaw = text(row.author)
    const normalized = authorMatch.normalizeAuthorName(queryRaw)
    const hit = authorMatch.bestMatchOf(normalized, persons)
    /* **阈值 80**：`art`(70) / `contains`(50) 命中不进回填面（只可能出现在候选读面）。 */
    if (!hit || hit.score < authorMatch.BACKFILL_MIN_SCORE) continue
    targets.push({
      rowId,
      sealId: faceSealKeyOf(row),
      queryRaw,
      normalized,
      personId: hit.person_id,
      displayName: hit.display_name,
      field: hit.field,
      score: hit.score
    })
  }
  const matched = targets.length
  /* `samples` ＝ 本窗口**命中**目标的诊断样本（**最多 5 条**、元素恰 4 键；
     **只在 `dry_run` 回** —— 真写轮回 `failed`，两形各 6 / 7 键）。 */
  const samples = targets.slice(0, 5).map((target) => ({
    row_id: target.rowId,
    query: target.queryRaw,
    person_id: target.personId,
    score: target.score
  }))
  /* ⑤ 预演轮：**零写入**（回包恰 6 键；`next_cursor` ＝ 本窗口最后一条被扫描行的 `_id`）。 */
  if (input.dry_run) {
    return { ok: true, scanned, eligible, matched, samples, next_cursor: nextCursor }
  }
  /* ⑥ 真写：逐行一次 `persist`（`update` ＋ `match:{_id}` ＋ `expectAtLeast:1`）；
     单行失败不中断整批。**读数以整窗读回为准**（persist 回报 ≠ 行的终态）。 */
  const attempted = []
  for (const target of targets) {
    attempted.push(target)
    try {
      await ops.persist({
        writes: [
          {
            kind: 'update',
            collection: ops.COLLECTIONS.faces,
            match: { _id: target.rowId },
            doc: {
              author_person_id: target.personId,
              author_match: {
                field: target.field,
                score: target.score,
                query: target.queryRaw,
                normalized: target.normalized,
                at
              }
            },
            expectAtLeast: 1
          }
        ]
      })
    } catch (error) {
      /* **此处不下真伪结论**：回报失败 ≠ 没写成 ⇒ 由下方读回定。 */
      console.warn(
        `[xiai] repairAuthorPersonId 單行寫回報失敗（讀回定真偽；面行：${target.rowId}；不中斷整批）：`,
        text(error && error.message)
      )
    }
  }
  let written = 0
  /* `failed` ＝ 读回**未确认生效**的已尝试目标（元素恰 2 键 `{_id, reason}`；`reason` 只用
     既有冻结值 `STORAGE_UNAVAILABLE` —— **零新增 `reason` 字面值**）。自洽：
     `written + failed.length === matched`。 */
  const failed = []
  const writtenTargets = []
  try {
    /* 整窗读回（**唯一判据**）：同一窗口语义重读 ⇒ 逐行看终态。 */
    const after = await readOrderedWindow(db, ops.COLLECTIONS.faces, {
      match: { kind: 'FACE' },
      idField: '_id',
      after: input.cursor,
      limit: input.limit
    })
    const stateById = new Map()
    for (const row of after) stateById.set(text(row._id) || text(row.id), row)
    for (const target of attempted) {
      const row = stateById.get(target.rowId)
      const match = row && row.author_match
      const confirmed =
        row &&
        text(row.author_person_id) === target.personId &&
        match &&
        text(match.field) === target.field &&
        Number(match.score) === target.score
      if (confirmed) {
        written += 1
        writtenTargets.push(target)
      } else {
        failed.push({ _id: target.rowId, reason: REASONS.STORAGE_UNAVAILABLE })
        console.warn(`[xiai] repairAuthorPersonId 單行未生效（讀回不符回填終態；面行：${target.rowId}）`)
      }
    }
  } catch (error) {
    /* 读回失败 ⇒ **不敢称写入**（宁报 0 不虚报；已尝试行逐条如实进 `failed` ＋ 告警）。 */
    console.warn('[xiai] repairAuthorPersonId 讀回失敗（本輪 written 按 0 如實上報）：', text(error && error.message))
    written = 0
    for (const target of attempted) {
      failed.push({ _id: target.rowId, reason: REASONS.STORAGE_UNAVAILABLE })
      console.warn(`[xiai] repairAuthorPersonId 未確認生效（讀回不可得；面行：${target.rowId}）`)
    }
  }
  /* ⑦ 印章级补条（**幂等**）：只补**读回确认已回填**的面；同 (印章, 印人, `kind`) 已有 ⇒ 零新增。 */
  for (const target of writtenTargets) {
    await ensureSealLinkOf(db, target, at)
  }
  /* 回包恰 7 键；`next_cursor` ＝ 本窗口最后一条被扫描行的 `_id`（不是最后一条被写的）。 */
  return { ok: true, scanned, eligible, matched, written, failed, next_cursor: nextCursor }
}

/**
 * 印章级 `xiai_seal_links` 补条（**幂等**；行面 ＝ `importRelations` 七键 ＋
 * `id`/`source`/`unresolved`/`created_at` ＋ 标记键 `kind:'印人'`）。
 * 幂等判据 ＝ 同 (`source_seal_id`, `ref_id`, `kind='印人'`) 已有行 ⇒ 零新增。
 * 单条失败**不中断整批**（面行回填是主面；补条失败如实告警）。
 */
async function ensureSealLinkOf(db, target, at) {
  const ops = opsOf()
  if (target.sealId === '' || target.personId === '') return
  let existing = []
  try {
    existing = await ops.readRows(ops.COLLECTIONS.sealLinks, { source_seal_id: target.sealId }, { limit: 500 })
  } catch (error) {
    if (!isCollectionNotExistError(error)) {
      console.warn(`[xiai] repairAuthorPersonId 補條預查失敗（印章：${target.sealId}）：`, text(error && error.message))
      return
    }
    /* 集合尚未创建 ⇒ 视作零行（幂等预查语义：尚无行 = 尚无重复）。 */
    existing = []
  }
  const duplicate = existing.some(
    (row) => row && text(row.ref_id) === target.personId && text(row.kind) === authorMatch.SEAL_LINK_KIND
  )
  if (duplicate) return
  const id =
    authorMatch.SEAL_LINK_ID_PREFIX +
    ops
      .hash16(authorMatch.sealLinkIdInputOf(target.sealId, target.personId))
      .slice(0, authorMatch.SEAL_LINK_ID_HEX_LENGTH)
  const doc = authorMatch.sealLinkRowOf({
    sealId: target.sealId,
    personId: target.personId,
    refName: target.displayName,
    id,
    at
  })
  try {
    await ops.persist({ writes: [{ kind: 'set', collection: ops.COLLECTIONS.sealLinks, id, doc }] })
  } catch (error) {
    console.warn(
      `[xiai] repairAuthorPersonId 補條失敗（印章：${target.sealId}、印人：${target.personId}；不中斷整批）：`,
      text(error && error.message)
    )
  }
}

/* ---------------------------------------------------------------------------
 * 导出（公开 op 表 ＋ 冻结键面；`index.js` 只做分流与按 op 收窄透传）
 * -------------------------------------------------------------------------- */

/**
 * **匿名可调的公开 op 表**（`index.js` 在令牌校验**之前**按这张表分流；
 * 表外的一切 op 仍必须验 token）。**只读**：这里的 op 一律零写。
 * **恰 2 成员**（§3.81.5 追加注 v1.100：`listSealCards` ＋ `suggestAuthors`）。
 */
const PUBLIC_OPS = Object.freeze({
  listSealCards,
  suggestAuthors
})

module.exports = {
  PUBLIC_OPS,
  listSealCards,
  suggestAuthors,
  repairPrimaryFace,
  repairAuthorPersonId,
  /* 冻结键面（供 `index.js` 透传与离线自检直接断言） */
  LIST_SEAL_CARDS_ALLOWED_KEYS,
  LIST_SEAL_CARDS_SUCCESS_KEYS,
  CARD_ROW_KEYS,
  LIST_SEAL_CARDS_DEFAULT_LIMIT,
  LIST_SEAL_CARDS_MAX_LIMIT,
  REPAIR_PRIMARY_FACE_ALLOWED_KEYS,
  REPAIR_PRIMARY_FACE_READOUT_KEYS,
  REPAIR_PRIMARY_FACE_SAMPLE_KEYS,
  REPAIR_PRIMARY_FACE_DEFAULT_LIMIT,
  REPAIR_PRIMARY_FACE_MAX_LIMIT,
  /* 纯函数（供离线自检直接断言） */
  parseListSealCardsPayload,
  primaryFaceOf,
  objectKeyOfDigest,
  sealKeyOf,
  faceSealKeyOf
}
