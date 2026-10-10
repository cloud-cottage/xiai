/**
 * 玺爱 · 本地数据仓库（纯前端 mock，零后端、零外部请求）
 *
 * 职责：种子灌入与增量迁移、集合读写、以及**数据层级的权限拒绝**。
 * 注意：本文件是 services 层的下游；组件不得直接 import 本文件。
 *
 * 层级：印章 `seal` 1 对 N 印面 `face`；边款是 `kind = EDGE` 的特殊印面。
 * 属性归属（**R-32 起**）：
 *   - **印面级**固定属性（印面图片 / 边款图片 ID）写在**印面行**上；
 *   - **印章级**固定属性（形制 `shape` / 材质 `material`）写在**印章行**上
 *     （材质 R-32 自印面级移入；**既有印面行上的旧 `material` 值保留不改写**，
 *     读路径回落见 `sealMaterialValue`）；
 *   - 可标记属性（印文 / 朝代 / 印面内容 `seal_type` / 印面风格 `face_style` / 作者 /
 *     印文释义）在**印面**上；印章行上的同名字段只是**主印面镜像**。
 *     **R-59（2026-09-21）**：【印文简体字】字段已**整体退役** —— 印章行与印面行都不再有
 *     该键（新建行不写、既有行由 `migrateTraditionalData()` 一次性幂等清除）。
 */

import {
  readKey,
  writeKey,
  STORAGE_KEYS,
  /* **K4（收口单）**：回滚副本键族的**代际路径** —— 登记表 / 代际表 / 路由判据 / 逐代读，
     全部只在 `storage.js` 里有一份真源；本文件**只消费**，**不自造名字、不写死键名字面量**。 */
  migrationBackupWriteKey,
  readMigrationBackups,
  MIGRATION_BACKUP_GENERATIONS
} from './storage.js'
import {
  putBlob,
  getBlob,
  deleteBlob,
  hasBlob,
  assetBlobKey,
  photoBlobKey,
  listBlobKeys,
  blobstoreInfo
} from './blobstore.js'
import { normalizeImagePayload, bytesToDataUrl, dataUrlToBytes, imageSize, sha256Hex, toUint8Array } from './assetmeta.js'
/* **身份标识（uid）单点**：`u-` ＋ sha256(手机号) 前 16 位，不可反推手机号。 */
import { uidOf } from './uid.js'
/* **CloudBase 讀取面（v1）**：雲端快照的**唯一讀入口**（同步、零網絡）。
   本文件在 `readCollection` 裏**只讀它** —— 是否接管、接管到哪一步（pending / ready / failed）
   全部由 `cloudbase.js` 自己判；本文件**不碰** SDK、**不發**請求、**不自立**第二處判據。 */
import { cloudBaseReadOf, ensureCloudBaseHydration, CLOUD_COLLECTION_KEYS } from './cloudbase.js'
/* **K-P5b（2026-09-23｜寫入面切遠端）**：新增產物的容器 ＝ **單頁 8bit Deflate TIFF**（`STORAGE_MIME`，
   字面定義點仍恰 1 處 ＝ `utils/tiff.js::TIFF_MIME`，本處**只 import 轉口**、不另立同值字面量）。 */
import { STORAGE_MIME } from '../utils/image.js'
/* **K-P5b（2026-09-23｜寫入面切遠端）**：新增影像行的二進制一律先交**服務端權威存儲**
   （`POST /api/image/store`，經同源代理 ⇒ 不失為一處實現）；客戶端真源恰 1 處 ＝
   `src/services/imageAuthority.js`（本文件只調用，**不自建第二套端點 / 摘要口徑**）。 */
import { storeArtifactBytes, AUTHORITY_STORAGE_SERVER } from '../services/imageAuthority.js'
import {
  SEED_SEALS,
  SEED_FACES,
  SEED_IMAGES,
  SEED_USERS,
  FIXED_ATTR_FIELDS,
  FACE_KIND,
  ADMIN_PHONE,
  ADMIN_NICKNAME,
  DYNASTY_OPTIONS,
  FACE_CONTENT_OPTIONS,
  FACE_STYLE_OPTIONS,
  SEAL_CLASS_OPTIONS,
  SEAL_SHAPE_FIELD,
  SEAL_MATERIAL_FIELD,
  SEAL_FIXED_ATTR_FIELDS,
  SLICE_META_FIELD,
  isKnownDynasty,
  isKnownFaceContent,
  isKnownFaceStyle,
  isKnownSealClass,
  formatPersonCode
} from './seed.js'

/**
 * **切割 / 拼接真源＝TileSplicer 内核**（R-98）：本文件只**转调**（`metaFor` / `windowsOf`），
 * 不再自持切位派生、刀向序列、块阵或逐块几何（单一真源；`sliceMetaOf` / `sliceWindowsOf`
 * 的**导出名与签名逐字不变**，否则会打穿既有探针）。
 */
import * as TileSplicer from '../tilesplicer/index.js'

/**
 * 供服务层复用的**纯函数**转口（不碰任何浏览器存储）：
 * 摘要 / mime 嗅探 / 尺寸解析 / 字节归一。服务层只认 `db.js` 这一个数据层入口，
 * 不必（也不应）再 import `../data/assetmeta.js`。
 */
export { sha256Hex, sniffMime, imageSize, toUint8Array } from './assetmeta.js'

/**
 * 种子版本。v1 → v2 的迁移内容：
 *   ① 新增印面集合 `faces`（canonical 一等实体）；
 *   ② 影像集合按 id 增量补齐（只增不改，不丢已有行）；
 *   ③ 旧版挂在印章行上的固定属性搬到对应印面上；
 *   ④ 旧勘误状态字面值 `APPROVED` 归一为 `ACCEPTED`（见 listCorrectionRows）。
 * 迁移只做加法，不触碰用户数据（勘误 / 照片 / 积分 / 登录态）。
 */
const SEED_VERSION = 2

/** 旧枚举字面值 → 规范冻结值（规范冻结三态：PENDING / ACCEPTED / REJECTED）。 */
const LEGACY_CORRECTION_STATUS = { APPROVED: 'ACCEPTED' }

export function normalizeCorrectionStatus(status) {
  return LEGACY_CORRECTION_STATUS[status] || status
}

/** 旧版挂印章行上的固定属性 → 搬到对应印面（避免旧装的编辑结果变成“死数据”）。 */
function migrateLegacyFixedAttributes(sealRows, faceRows) {
  const next = faceRows.map((row) => ({ ...row }))
  /**
   * 取该印章**首个 `kind` 命中**的行下标（本迁移里只用于 `kind = EDGE` 的边款行）；无 ⇒ `-1`。
   *
   * **本函数与「主印面」口径无关**（Zang 裁定 / R-44 澄清）：主印面（`kind = FACE` 中
   * **存储顺序第一个**）**只在 `primaryFaceIn` 单点实现**；本函数只回答「边款影像该挂哪一行」，
   * 既不实现、也不代表「主印面」语义，**不得**被读成第二处主印面判定，**不得**被用来选主印面。
   */
  const firstIndexByKind = (sealId, kind) =>
    next.findIndex((row) => row.sealId === sealId && row.kind === kind)

  sealRows.forEach((seal) => {
    if (!seal || !seal.stamp_id) return
    /* **R-44（主印面单点实现）**：主印面**必须经 `primaryFaceIn` 取**（范围按 `sealId` 限定，
       下标用 `indexOf` 反查）—— 改前这里自写了一份 `findIndex(… kind === FACE)` 同义实现，
       现收敛到单点实现；行为逐行不变（`indexOf(首个 FACE)` ≡ `findIndex(首个 FACE)`）。 */
    const primary = primaryFaceIn(next.filter((row) => row.sealId === seal.stamp_id))
    if (!primary) return
    const faceIndex = next.indexOf(primary)
    const edgeIndex = firstIndexByKind(seal.stamp_id, FACE_KIND.EDGE)
    const patchOf = (index, patch) => {
      if (index < 0 || Object.keys(patch).length === 0) return
      next[index] = { ...next[index], ...patch }
    }
    const facePatch = {}
    if (seal.face_image_id && seal.face_image_id !== next[faceIndex].face_image_id) {
      facePatch.face_image_id = seal.face_image_id
    }
    if (typeof seal.material === 'string' && seal.material && seal.material !== next[faceIndex].material) {
      facePatch.material = seal.material
    }
    patchOf(faceIndex, facePatch)
    if (Array.isArray(seal.edge_image_ids) && seal.edge_image_ids.length > 0) {
      patchOf(edgeIndex >= 0 ? edgeIndex : faceIndex, { edge_image_ids: seal.edge_image_ids })
    }
  })
  return next
}

/* ---------------------- 管理员账号唯一性（老库就地纠正） ---------------------- */

/**
 * 按管理员手机号唯一真源（`seed.js` 的 `ADMIN_PHONE`）**就地纠正**已落盘的 `users`。
 *
 * 规则：
 *   ① 手机号 == `ADMIN_PHONE` 的账号 ⇒ `role` 强制 `admin`；该账号不存在则创建并写回；
 *   ② 手机号 ≠ `ADMIN_PHONE` 而 `role` 仍为 `admin` 的账号 ⇒ 降为 `user`。
 *
 * 兼容硬约束：**只改 `role` 一个字段**（必要时补建缺失的管理员账号），用户行本身不删，
 * 其它集合（勘误 / 照片 / 积分流水 / 登录态 / 已改过的印面）一律不碰
 * ⇒ 老库**就地纠正**，不依赖清库、不依赖升命名空间版本。
 * 幂等：纠正后再跑不产生任何写入。
 * @returns {Array<object>} 纠正后的用户行（发生过纠正时即落盘内容）。
 */
export function reconcileAdminRoles() {
  const raw = readKey(STORAGE_KEYS.users)
  /* 老库 users 缺失或为空（例如被手改空）时以种子重建，再走同一套纠正。 */
  const rebuild = !Array.isArray(raw) || raw.length === 0
  const users = (rebuild ? SEED_USERS : raw).map((row) => ({ ...row }))
  let changed = rebuild

  if (!users.some((row) => row && row.phone === ADMIN_PHONE)) {
    users.push({
      id: uidOf(ADMIN_PHONE),
      phone: ADMIN_PHONE,
      nickname: ADMIN_NICKNAME,
      role: 'admin',
      points: 50, // 与 services 层 GOLD_INITIAL（新账号初始金）一致
      created_at: new Date().toISOString()
    })
    changed = true
  }

  users.forEach((row) => {
    if (!row || !row.phone) return
    if (row.phone === ADMIN_PHONE) {
      if (row.role !== 'admin') {
        row.role = 'admin'
        changed = true
      }
      return
    }
    if (row.role === 'admin') {
      row.role = 'user'
      changed = true
    }
  })

  if (changed) writeKey(STORAGE_KEYS.users, users)
  return users
}

function ensureSeed() {
  const marker = readKey(STORAGE_KEYS.seeded)
  /* 种子版本已是最新时不再灌种子，但**仍要**走到末尾的角色纠正（老库同样要纠正）。 */
  if (!marker || marker.version !== SEED_VERSION) {
    if (!marker) {
      /* 全新安装：整套种子一次写入。
         **R-87**：影像行落盘时补 `slice_meta`（确定性派生；种子数组里不写字面量）。 */
      writeKey(STORAGE_KEYS.seals, SEED_SEALS)
      writeKey(STORAGE_KEYS.faces, SEED_FACES)
      writeKey(STORAGE_KEYS.images, withSliceMeta(SEED_IMAGES))
      writeKey(STORAGE_KEYS.users, SEED_USERS)
      writeKey(STORAGE_KEYS.corrections, [])
      writeKey(STORAGE_KEYS.photos, [])
      writeKey(STORAGE_KEYS.points, [])
      writeKey(STORAGE_KEYS.downloaded, [])
    } else {
      /* 旧安装：只补新集合与新影像，用户数据一律不动。 */
      const rawSeals = readKey(STORAGE_KEYS.seals)
      const sealRows = Array.isArray(rawSeals) && rawSeals.length > 0 ? rawSeals : SEED_SEALS
      if (!Array.isArray(rawSeals) || rawSeals.length === 0) writeKey(STORAGE_KEYS.seals, sealRows)

      const rawImages = readKey(STORAGE_KEYS.images)
      const imageRows = Array.isArray(rawImages) ? rawImages : []
      const missingImages = SEED_IMAGES.filter((seed) => !imageRows.some((row) => row.id === seed.id))
      /* **R-87**：补写的新影像行同样带 `slice_meta`；**既有影像行一字不动**
         （它们无需迁移 —— 派生即可复现，见 `sliceMetaOf`）。 */
      if (missingImages.length > 0) writeKey(STORAGE_KEYS.images, [...imageRows, ...withSliceMeta(missingImages)])

      const rawFaces = readKey(STORAGE_KEYS.faces)
      if (!Array.isArray(rawFaces) || rawFaces.length === 0) {
        writeKey(STORAGE_KEYS.faces, migrateLegacyFixedAttributes(sealRows, SEED_FACES))
      }
    }

    writeKey(STORAGE_KEYS.seeded, { at: 'seed', version: SEED_VERSION })
  }

  /* 无论种子版本是否最新，每次引导都按 ADMIN_PHONE 纠正一次角色（幂等）。 */
  reconcileAdminRoles()

  /* **R-56〜R-61**：繁体化与字段退役迁移（幂等；记账命中时只读一次记账即返回）。 */
  migrateTraditionalData()
}

/* ============================================================================
   **本地同 `_id` 覆盖层（v2 必修 3：云模式下「写后读可见」）**
   ----------------------------------------------------------------------------
   背景（质检实据）：云模式下写入仍落 localStorage，而读走云端快照 ⇒ 写后读**不可见**
   （管理员的编辑静默丢失）。口径（Zang 裁定，逐条执行）：
     · **只管读取面接管的集合**（`CLOUD_COLLECTION_KEYS` ＝ `seals` / `faces` / `images`
       ＋ 公开投影面 `correctionsPublic`）；
       其余 10 个集合的读 / 写路径**一律不变**（仍走既有本地实现）；
     · 读 = **云端快照 ∪ 本地同 `_id` 覆盖（本地优先）**：同 `_id` 的行**逐键合并、本地键优先**
       （本地行未携带的云端键保留 ⇒ 不会因为一条本地编辑而静默丢字段）；
     · 本地有、云端没有的行**也要能读到**（本地行；按本地形态原样交出，**不**再走云端归一器）；
     · **不得把本地种子数据混入云端集合**：与种子行**逐字（JSON 全等）相同**的本地行视为
       本机示范种子 ⇒ **不并入**；管理员改过 / 本地新建的行与种子行不等 ⇒ 照常可见。
   本层**只读**：不写 localStorage、不改云端行、不动其它集合。
   ============================================================================ */

/** 参与覆盖层的集合键（真源＝`cloudbase.js` 的 `CLOUD_COLLECTION_KEYS`，不另立一份字面量）。 */
const OVERLAY_COLLECTION_KEYS = CLOUD_COLLECTION_KEYS

const firstPresent = (...values) => values.find((value) => value !== undefined && value !== null)

/**
 * 行身份键（覆盖层的**唯一配对依据**）：`_id` 优先 ⇒ `id` ⇒ `stamp_id`。
 * 云端行一律带 `_id`（`normalizeSealRow` / `normalizeFaceRow` / `normalizeImageRow` 都落该键）；
 * 云模式下写回 localStorage 的行也是**云端行**（带 `_id`）⇒ 同 `_id` 配对成立。
 * 本地新建（本机生成 `XA…` / `fc-…`）的行没有 `_id` ⇒ 用 `id` 配对，恰好「云端无 ⇒ 本地行」。
 */
function overlayIdentityOf(row) {
  if (!row || typeof row !== 'object') return ''
  const raw = firstPresent(row._id, row.id, row.stamp_id)
  return raw === null || raw === undefined ? '' : String(raw)
}

/** 种子行的逐字指纹（＝**落盘形态**：影像行按 `withSliceMeta` 补 `slice_meta` 后再比）。 */
const SEED_FINGERPRINT_CACHE = new Map()
function seedFingerprints(key) {
  if (SEED_FINGERPRINT_CACHE.has(key)) return SEED_FINGERPRINT_CACHE.get(key)
  const rows =
    key === STORAGE_KEYS.seals
      ? SEED_SEALS
      : key === STORAGE_KEYS.faces
        ? SEED_FACES
        : key === STORAGE_KEYS.images
          ? /* 影像行两种历史形态都算种子：**落盘形态**（`ensureSeed` 补 `slice_meta`）与**种子原形**
               （`slice_meta` 是确定性派生键，缺它的历史行同属本机示范数据）。 */
            [...withSliceMeta(SEED_IMAGES), ...SEED_IMAGES]
          : []
  const fingerprints = new Set((Array.isArray(rows) ? rows : []).map((row) => JSON.stringify(row)))
  SEED_FINGERPRINT_CACHE.set(key, fingerprints)
  return fingerprints
}

/** 该本地行是否与种子行**逐字相同**（⇒ 本机示范种子，不得并入云端集合）。 */
function isVerbatimSeedRow(key, row) {
  return seedFingerprints(key).has(JSON.stringify(row))
}

/**
 * 云端行 ∪ 本地同 `_id` 覆盖（本地优先）。非覆盖层集合 ⇒ **原样返回云端行**。
 *
 * 读法（**确定性、与调用次序无关**）：先按云端行序输出（同 `_id` 的行逐键合并、本地优先），
 * 再把「本地有、云端没有」的行**按本地行序追加**在尾部。
 *
 * @param {string} key 集合键
 * @param {Array<object>} cloudRows 云端快照行
 * @returns {Array<object>} 合并后的行（**新数组**；云端行对象只在被覆盖时新建）
 */
function withLocalOverlay(key, cloudRows) {
  const cloud = Array.isArray(cloudRows) ? cloudRows : []
  if (!OVERLAY_COLLECTION_KEYS.includes(key)) return cloud
  /* **不调 `ensureSeed()`**：云模式下一行种子都不许写进 localStorage；这里只读**已有**的本地行。 */
  const local = readKey(key)
  if (!Array.isArray(local) || local.length === 0) return cloud
  const overlays = new Map()
  local.forEach((row) => {
    const id = overlayIdentityOf(row)
    if (!id) return
    if (isVerbatimSeedRow(key, row)) return // 本机示范种子 ⇒ 不并入（见本节头注）
    overlays.set(id, row)
  })
  if (overlays.size === 0) return cloud
  const out = []
  const matched = new Set()
  cloud.forEach((row) => {
    const id = overlayIdentityOf(row)
    if (id && overlays.has(id)) {
      matched.add(id)
      /* **本地优先**：同 `_id` ⇒ 逐键合并（本地行有的键取本地值；云端独有的键保留）。 */
      out.push({ ...row, ...overlays.get(id) })
      return
    }
    out.push(row)
  })
  /* 本地有、云端没有的行 ⇒ **照读**（本地行原样交出；本地行序稳定）。 */
  overlays.forEach((row, id) => {
    if (!matched.has(id)) out.push(row)
  })
  return out
}

/* ============================================================================
   **集合读入口（CloudBase 读取面 v2 的唯一接线点）**
   ----------------------------------------------------------------------------
   读序（**机械可判，三支互斥**）：
     ① 云端 `ready` ⇒ **云端快照 ∪ 本地同 `_id` 覆盖**（`seals` / `faces` / `images` 三个键；
        见上方「本地覆盖层」）；
     ② 云端已配置但快照未到（`pending`）⇒ **返回空集** ——
        此刻**绝不回落本地种子**：回落会让 24 枚本机示范印章先上屏、云端 79 枚再替换
        （先假后真，且会往 localStorage 里灌一份本机种子）。
        **v2 必修 1**：`pending` 带**超时护栏**（总预算，默认 8 秒）⇒ 超时即转 `failed` ⇒ 走 ③，
        页面**不会**长期停在空态；
     ③ 其余（未配置 `off` / 失败 `failed` / 非本层接管的键）⇒ **既有本地实现一字未改**
        （`ensureSeed()` ⇒ `readKey(key)`）。
   ============================================================================ */
function readCollection(key, fallback) {
  /* **启动兜底**：`main.js` 不在本单接线面内 ⇒ 首次读取顺带把水合拉起来（幂等；未配置时零成本）。
     这样即使启动引导链被改动，云端接管也不会静默失效。 */
  ensureCloudBaseHydration()
  const cloud = cloudBaseReadOf(key)
  if (cloud.state === 'ready' && Array.isArray(cloud.rows)) return withLocalOverlay(key, cloud.rows)
  if (cloud.state === 'pending') return []
  ensureSeed()
  const value = readKey(key)
  return Array.isArray(value) ? value : fallback
}

function writeCollection(key, rows) {
  ensureSeed()
  writeKey(key, rows)
  return rows
}

/** 读印面并回填兼容别名（`stamp_id` ＝ `sealId`）。 */
function readFaceCollection() {
  return readCollection(STORAGE_KEYS.faces, []).map((row) => ({
    ...row,
    stamp_id: row.sealId || row.stamp_id || '',
    updated_at: row.updated_at || row.created_at || ''
  }))
}

/* ============================================================================
   **R-56〜R-61（2026-09-21｜繁体化与字段退役｜数据面）**
   ----------------------------------------------------------------------------
   口径（逐字执行 Zang 冻结口径）：
     - **R-57 转换算法＝OpenCC `s2t`**（纯字形；**不用** `s2tw` / `s2twp`，不引入台湾词汇）。
       本文件与 `seed.js` 里**上屏的字符串字面量**已在**开发期**用 `s2t` **逐字面量**转换
       （不是整文件盲转；注释与 `docs/**` 未动）；库内既有**自由文本**在**运行期**由
       `toTraditionalText()` 转换 —— 它的表 `S2T_GLYPH_*` 同样出自 OpenCC（`STCharacters`
       的**逐字**条目，且只收「该字在繁→簡方向不变」的条目 ⇒ 绝不会改动已是繁体的字），
       并**剔除全部「上下文相关字」**（词组层才能定形 ⇒ 逐字会转错，实测 `里居`）；
       开发期生成、零运行时依赖（本工程不新增依赖）。
     - **R-58 三套枚举目标值＝`seed.js` 的三个真源常量**（本文件不另立第二套）；
       值域门（`dynastyValueDenial` / `faceContentValueDenial` / `faceStyleValueDenial`）
       引的就是它们。
     - **R-59「印文简体字」字段整体退役**：新建行不写该键；既有行（印章行 + 印面行）的该键
       由本段的迁移清除（Kevin 明确授权改写历史行，**本字段是唯一例外**）。
     - **R-60 旧值繁化的边界**：**枚举字段**一律走**显式值映射表** `LEGACY_ENUM_SOURCES`
       （＋各真源值本身的恒等项）——**不得**用 `s2t` 盲转字，因为 `s2t` 给的是 `鑑藏印`，
       而库内旧值是异体 `鑒藏印`；**自由文本**只转**非用户来源行**（无 `uploaded_by`），
     - **R-61 显示名链**＝`seal_name`（印文）⇒ 空则「佚名」（见 `sealDisplayName`）。
   纪律：迁移**幂等**（记账写进 `seeded` 的 `trad_migration`）、**逐条留痕**（`report.changes` /
   `report.unmapped`）、**先落一份回滚副本**（键 `TRAD_MIGRATION_BACKUP_KEY`，原始行数组）。
   ============================================================================ */

/** 退役字段（**R-59**）：迁移把既有印章行 / 印面行上的这些键**整体删除**（值一并清除）。 */
const RETIRED_FIELD_KEYS = ['transcription_simplified']

const TRAD_MIGRATION_VERSION = 3

/**
 * 回滚副本键（**R-60**：迁移动手前先落原始行数组）。
 *
 * 真源＝`storage.js` 的 `STORAGE_KEYS.migrationBackupTrad`（键登记表）；本常量只是它的
 * **对外别名**，字面值与登记前**逐字一致**（`migration-backup:r57trad`）⇒ 老库已落的
 * 副本键照旧可读。经 `storage.js` 的 `writeKey` 写入
 * （命名空间仍是 `xiai:v1:`，全工程唯一碰 localStorage 的模块仍是 `storage.js`）。
 * 单值有上限（见 `TRAD_MIGRATION_BACKUP_MAX_BYTES`）：超限时按比例保留前缀行并**如实登记**
 * 丢弃行数（`truncated` / `dropped`），绝不假装副本完整。
 */
export const TRAD_MIGRATION_BACKUP_KEY = STORAGE_KEYS.migrationBackupTrad

/** 回滚副本的单值上限（留出余量，避免单键值触到 64KiB 的存储判负线）。 */
const TRAD_MIGRATION_BACKUP_MAX_BYTES = 48 * 1024

/** 三套枚举字段 → 行内字段名 / 值域名（R-58 真源；迁移与值域门共用同一处）。 */
const ENUM_ROW_FIELDS = {
  seal: [
    ['dynasty', 'dynasty'],
    ['seal_type', 'seal_type'],
    ['category', 'seal_type'], // 印章行上的同一语义别名
    ['face_style', 'face_style']
  ],
  face: [
    ['dynasty', 'dynasty'],
    ['seal_type', 'seal_type'],
    ['face_style', 'face_style']
  ]
}

/** 值域真源（按域名字取；一律指向 `seed.js` 的常量，不复制值）。 */
const ENUM_DOMAINS = {
  dynasty: DYNASTY_OPTIONS,
  seal_type: FACE_CONTENT_OPTIONS,
  face_style: FACE_STYLE_OPTIONS
}

/**
 * **显式值映射表（R-60）**：来源侧＝库内既有的枚举旧形态，目标侧＝R-58 的新枚举值。
 *
 * 来源侧的每一行都是**逐一列出的既有旧值**，不是「盲转字」：
 *   - 各值的**简体来源形态**（由 `s2t` 的逆向 `t2s` 逐一得出，可复算）；
 *   - 库内实测的**异体**旧形态（`鑒藏印` ⇒ `鑑藏印` —— `s2t` 逐字转换**不会**得到该结果，
 *     故必须显式列入；这条正是本表存在的理由）。
 * 各真源值**自身**（如 `漢` / `吉語印` / `閒章`）由 `enumValueMap()` 以恒等项补齐，
 * 故本表只列**会真正改变字面**的来源形态。
 * **映射不到**的旧值（如朝代 `戰國` / `明` / `清` / `近現代`）**保留原样并登记**（禁猜）。
 */
const LEGACY_ENUM_SOURCES = {
  dynasty: {
    汉: '漢',
    魏晋: '魏晉',
    民国: '民國',
    新中国: '新中國',
    当代: '當代',
  },
  seal_type: {
    斋馆印: '齋館印',
    鉴藏印: '鑑藏印',
    吉语印: '吉語印',
    闲章: '閒章',
    鑒藏印: '鑑藏印',
  },
  face_style: {
    三晋古玺: '三晉古璽',
    楚古玺: '楚古璽',
    燕古玺: '燕古璽',
    齐古玺: '齊古璽',
    汉白文铸印: '漢白文鑄印',
    汉玉印: '漢玉印',
    将军急就章: '將軍急就章',
    汉朱文: '漢朱文',
    朱白相间印: '朱白相間印',
    魏晋印: '魏晉印',
    隋唐九叠篆印: '隋唐九疊篆印',
    邓派: '鄧派',
    吴让之印风: '吳讓之印風',
    赵之谦印风: '趙之謙印風',
    黄牧甫印风: '黃牧甫印風',
    吴昌硕印风: '吳昌碩印風',
    赵叔孺印风: '趙叔孺印風',
    陈巨来印风: '陳巨來印風',
    来楚生印风: '來楚生印風',
  }
}

/* --------------- **R-60 扩展（2026-09-21｜收口单 B）：迁移面扩到其它集合** ---------------
   首版（版本 1）只覆盖「印章行 + 印面行」。本段把迁移面扩到**其它「上屏且非用户来源」**的
   数据，三条纪律逐字执行：
     ① 枚举字段 / 系统字面值一律走**显式值映射表**（`SOURCE_TEXT_MAPS`）——**不盲转字**；
     ② **绝不转换任何用户输入文本**（用户改过的昵称、勘误依据 / 用户提交值……一律逐字不动）；
     ③ 幂等（记账版本 + 二次跑零写入）、逐条留痕（`report.changes` / `report.user_text_untouched`）、
        回滚副本（先落**原始**行数组，见 `TRAD_MIGRATION_BACKUP_KEY`）。

   逐集合判定（`report.collections` 里逐集合登记 scanned/changed，★＝本单新扩）：
     - ★ `users.nickname`（页头 / 登录页 / 我的勘误上屏）：**种子 / 系统来源才转**。
       判据＝当前值命中「已知系统昵称」＝`seed.js` 的 `ADMIN_NICKNAME` / `SEED_USERS[*].nickname`
       （含其旧形态）或系统生成形态 `印友<手机号后四位>`（`services/auth.js`）；
       一律不动」同口径）。本单实测旧形态只有 `库守 ⇒ 庫守`（`印友` 繁简同形）。
     - ★ `points.type` / `points.ref_label`（流水页直接上屏 `row.type`）：`type` 走映射表
       （`初始赠送/下载消耗/勘误奖励 ⇒ 初始贈送/下載消耗/勘誤獎勵`）。`ref_label` **只在系统来源下转**：
         · `ref_type = account`（系统字面值 `新用户初始赠送`）⇒ 走映射表；
         · `ref_type = seal` ⇒ 该值是**印章行自由文本的快照**，**仅当被引印章行非用户来源**时
           随印章行一道繁化（与印章行同一口径）；引不到该印章行 ⇒ 不转 + 登记；
         · `ref_type = correction` ⇒ 该行 `ref_label` 为空（`services/points.js` 未传）；
         · 其它情况 ⇒ 不转 + 登记（禁猜）。
     - ★ `corrections.field_label`（我的勘误上屏 `row.field_label || row.field`）：系统派生字段名
       ⇒ 走映射表（`印面内容/印面风格/印文释义 ⇒ 印面內容/印面風格/印文釋義`）。
     - `seals` / `faces`：首版已覆盖（清退役键 + 枚举映射 + 非用户行自由文本），本版沿用。
     - `photos`（**不转**）：`note` / `file_name` 是用户上传时填的 ⇒ 用户输入；`status` 是 ASCII 枚举；
       上屏文案（印章名 / 尺寸 / 时间）全来自其它集合 ⇒ 本集合零可转字段。
     - `downloaded`（**不转**）：`id` / `user_id` / `stamp_id` / `session_key` 是 ASCII 标识，
       `cost` 是数字 ⇒ 无上屏 CJK。
     - `images`（**不转**）：`id` / `stamp_id` / `kind` / `sha256` / `bytes` / 尺寸 / `color_mode`
       全是 ASCII 元数据 ⇒ 无上屏 CJK。
     - `session`（**不转**）：本工程只存 `{ userId }`（见 `session.js`）⇒ 无文本。
     - `theme` / `seeded`（**不转**）：主题代号与迁移记账，非展示文本。
   ---------------------------------------------------------------------------- */

/**
 * `services/points.js` 的 `LEDGER_TYPE` **只读字面值副本**。
 *
 * 为什么复制：数据层是服务层的**下游**（`services/**` 都 import 本文件）⇒ 本文件**不得**
 * 反向 import 服务层（会成环、且在模块求值时取到未初始化的绑定）。故这里的三个值与
 * `services/corrections.js` 的 `MARKABLE_FIELDS[*].label` 一样是**跨层只读引用**，
 * 由自测逐字断言两侧相等（`qa-recheck/kong-r7close-b-20260921/maps.json`）防漂移 ——
 * 这是本单**唯一的规范缺口**（跨层常量无编译期守恒手段）。
 */
const LEDGER_TYPE_CURRENT = {
  INITIAL: '初始贈送',
  DOWNLOAD: '下載消耗',
  CORRECTION_REWARD: '勘誤獎勵'
}

/** 初始赠送流水的系统 `ref_label`（`services/points.js` 的 `grantInitialGold`）。 */
const LEDGER_TYPE_INITIAL_LABEL = '新用戶初始贈送'

/** `services/corrections.js` 的 `MARKABLE_FIELDS[*].label` **只读字面值副本**（同上，跨层引用）。 */
const MARKABLE_FIELD_LABELS = ['印文', '朝代', '印面內容', '印面風格', '作者', '印文釋義']

/**
 * **显式值映射表（R-60 扩展）**：`集合 → 字段 → {旧形态: 目标形态}`。
 *
 * 表里**只列会真正改变字面**的旧形态；各字段的**恒等项**（＝当前形态）由
 * `sourceTextIdentity()` 从真源常量取（`user.nickname` 直接取 `seed.js`，不复制值）。
 * 表外的值一律**不转**（`unknown` ⇒ 登记，禁猜）——**尤其**：这些字段**不得**交给
 * `toTraditionalText()` 盲转（异体字与跨层称名都可能转错，与首版 `鑒藏印` 同理）。
 * 旧形态的取得方式：对当前形态做 `t2s`（OpenCC 繁→简）逐一得出、可复算。
 */
const SOURCE_TEXT_MAPS = {
  /** `users.nickname`：真源＝`seed.js` 的 `ADMIN_NICKNAME` / `SEED_USERS`。 */
  user: {
    nickname: {
      库守: '庫守'
    }
  },
  /** `points.type` / `points.ref_label`：真源＝`services/points.js` 的 `LEDGER_TYPE`。 */
  point: {
    type: {
      初始赠送: '初始贈送',
      下载消耗: '下載消耗',
      勘误奖励: '勘誤獎勵'
    },
    ref_label: {
      新用户初始赠送: '新用戶初始贈送'
    }
  },
  /** `corrections.field_label`：真源＝`services/corrections.js` 的 `MARKABLE_FIELDS`。 */
  correction: {
    field_label: {
      印面内容: '印面內容',
      印面风格: '印面風格',
      印文释义: '印文釋義'
    }
  }
}

/** 走显式值映射表的**系统来源**字段（集合 → 字段清单）。 */
const SOURCE_TEXT_FIELDS = {
  user: ['nickname'],
  point: ['type'],
  correction: ['field_label']
}

/**
 * 各 `集合|字段` 的**恒等值集合**（当前形态；命中 ⇒ 已是目标形态、零变更）。
 * `user.nickname` 直接取 `seed.js` 真源（可 import ⇒ 不复制值）；其余为跨层只读副本。
 */
function sourceTextIdentity(kind, field) {
  if (kind === 'user' && field === 'nickname') {
    return new Set([ADMIN_NICKNAME, ...SEED_USERS.map((row) => row.nickname)].filter(hasText))
  }
  if (kind === 'point' && field === 'type') return new Set(Object.values(LEDGER_TYPE_CURRENT))
  if (kind === 'point' && field === 'ref_label') return new Set([LEDGER_TYPE_INITIAL_LABEL])
  if (kind === 'correction' && field === 'field_label') return new Set(MARKABLE_FIELD_LABELS)
  return new Set()
}

/**
 * 单值映射（**只用于系统 / 种子来源**的文本）。
 * @returns {{state:'mapped'|'identity'|'unknown', to:string}} `mapped`=旧形态命中并改字；
 *   `identity`=已是目标形态（零变更）；`unknown`=表外值（**不转**，调用方登记）。
 */
function mapSourceText(kind, field, text) {
  const map = (SOURCE_TEXT_MAPS[kind] || {})[field]
  if (map && Object.prototype.hasOwnProperty.call(map, text)) return { state: 'mapped', to: map[text] }
  if (sourceTextIdentity(kind, field).has(text)) return { state: 'identity', to: text }
  return { state: 'unknown', to: text }
}

/**
 * 系统**生成**的昵称形态（`services/auth.js` 自动建号时写的 `印友<手机号后四位>`）。
 * 这些字繁简同形、又不在映射表里 ⇒ 判为「系统来源、零变更」，**不算**「映射不到的旧值」。
 */
const SYSTEM_NICKNAME_PATTERN = /^印友\d{4}$/

/**
 * 是否**种子 / 系统来源**昵称（＝非用户输入）。命中三类之一才算：
 * ① 已知系统昵称的**当前形态**（`ADMIN_NICKNAME` / `SEED_USERS`）；② 其**旧形态**（映射表键）；
 * ③ 系统生成形态 `印友<4 位数字>`（`services/auth.js` 自动建号）。其余 ⇒ 用户改过的昵称。
 */
function isSystemNickname(text) {
  const value = String(text)
  if (sourceTextIdentity('user', 'nickname').has(value)) return true
  const legacy = SOURCE_TEXT_MAPS.user.nickname
  if (Object.prototype.hasOwnProperty.call(legacy, value)) return true
  return SYSTEM_NICKNAME_PATTERN.test(value)
}

/** 迁移用的**完整映射表导出**（自测 / 质检：全表可枚举、可复算）。 */
export function tradSourceTextMaps() {
  const out = {}
  Object.keys(SOURCE_TEXT_MAPS).forEach((kind) => {
    Object.keys(SOURCE_TEXT_MAPS[kind]).forEach((field) => {
      const identity = [...sourceTextIdentity(kind, field)]
      const identityRows = identity.map((value) => ({ from: value, to: value, kind: 'identity' }))
      const legacyRows = Object.entries(SOURCE_TEXT_MAPS[kind][field]).map(([from, to]) => ({ from, to, kind: 'legacy' }))
      out[`${kind}.${field}`] = [...legacyRows, ...identityRows]
    })
  })
  return out
}

/**
 * **逐集合的「转 / 不转」清单**（自测 / 质检 / 报告用；判据与实现同处，不是另写一份说明）。
 * 只列**本单枚举过**的上屏集合；`converted` 为 `false` 的项在 `reason` 里写明为何不转。
 */
export function tradCollectionPlan() {
  return [
    { collection: 'seals', converted: true, reason: '首版已覆蓋：退役鍵 + 枚舉映射 + 非用戶來源行自由文本' },
    { collection: 'faces', converted: true, reason: '首版已覆蓋：退役鍵 + 枚舉映射 + 非用戶來源行自由文本' },
    { collection: 'users', converted: true, fields: ['nickname'], reason: '種子 / 系統來源暱稱走映射表；用戶改過的一律不動' },
    { collection: 'points', converted: true, fields: ['type', 'ref_label'], reason: 'type 走映射表；ref_label 僅系統來源（account 字面值 / 非用戶來源印章的快照）' },
    { collection: 'corrections', converted: true, fields: ['field_label'], reason: '系統派生字段名走映射表；value / basis 是用戶輸入，一律不動' },
    { collection: 'photos', converted: false, reason: 'note / file_name 是用戶上傳時填寫 ⇒ 用戶輸入；status 爲 ASCII 枚舉；展示文案來自其它集合' },
    { collection: 'downloaded', converted: false, reason: '全爲 ASCII 標識與數字（id / user_id / stamp_id / session_key / cost）⇒ 無上屏 CJK' },
    { collection: 'images', converted: false, reason: '全爲 ASCII 元數據（id / stamp_id / kind / sha256 / bytes / 尺寸 / color_mode）⇒ 無上屏 CJK' },
    { collection: 'session', converted: false, reason: '只存 { userId }（見 session.js）⇒ 無文本' },
    { collection: 'theme', converted: false, reason: '主題代號（a / b），非展示文本' },
    { collection: 'seeded', converted: false, reason: '種子與遷移記賬（本遷移自己寫）⇒ 非展示文本' }
  ]
}

/**
 * **简繁转换（逐字表 / 词组表 / 四个契约）已下沉到 `src/utils/traditional.js`**（R-8 trad 单）。
 *
 * 本文件**不再持有任何表**（**禁复制第二份** —— 表只此一份，即「单一真源」）：这里只
 * **import + re-export 转发**，`toTraditionalText()` 等对外名字与语义**完全不变**，
 * 调用方（本文件的迁移逻辑、服务层、另一单的界面）都不必改一行。
 *
 * 迁移仍然只用**同步的逐字表**口径（`toTraditionalText`，上下文相关字原样保留并登记）；
 * 词组层（`toTraditionalFull` / `toSimplifiedFull`）是**异步 + 按需加载**，与本迁移无关，
 * 故本文件的迁移行为**逐字未变**（对照证据见 `qa-recheck/kong-r8trad-20260921/`）。
 *
 * 层级说明：数据层此前不 import `utils/**`；本单按指令把「上屏文案繁化」这块**工具**
 * 下沉到 utils 作单一真源，故此处破例（已登记为规范缺口）。
 */
import {
  toTraditionalText,
  toSimplifiedText,
  toTraditionalFull,
  toSimplifiedFull,
  contextSensitiveCharsIn,
  s2tGlyphTableInfo,
  s2tGlyphTable
} from '../utils/traditional.js'

/** re-export 转发（保调用方不变；**不是**第二份实现）。 */
export {
  S2T_GLYPH_SOURCE,
  S2T_GLYPH_TARGET,
  S2T_CONTEXT_SENSITIVE_CHARS,
  toTraditionalText,
  toSimplifiedText,
  toTraditionalFull,
  toSimplifiedFull,
  contextSensitiveCharsIn,
  s2tGlyphTableInfo,
  s2tGlyphTable
} from '../utils/traditional.js'

/** 三套枚举的**完整**有效映射表（恒等项 + 显式映射项；自测 / 质检用）。 */
export function enumValueMapTable() {
  const out = {}
  Object.keys(ENUM_DOMAINS).forEach((domain) => {
    const rows = ENUM_DOMAINS[domain].map((value) => ({ from: value, to: value, kind: 'identity' }))
    Object.entries(LEGACY_ENUM_SOURCES[domain] || {}).forEach(([from, to]) => {
      rows.push({ from, to, kind: 'legacy' })
    })
    out[domain] = rows
  })
  return out
}

/** 单值映射：命中 ⇒ 目标值；未命中 ⇒ `null`（调用方据此登记「映射不到的旧值」）。 */
function mapEnumValue(domain, text) {
  const options = ENUM_DOMAINS[domain]
  if (!Array.isArray(options)) return null
  const source = String(text)
  if (options.includes(source)) return source // 恒等：旧值本身已是 R-58 目标值
  const legacy = LEGACY_ENUM_SOURCES[domain] || {}
  return Object.prototype.hasOwnProperty.call(legacy, source) ? legacy[source] : null
}

/** 自由文本字段（R-60）：**只转非用户来源行**（用户行一律不动）。 */
const FREE_TEXT_ROW_FIELDS = {
  seal: ['seal_name', 'name', 'author', 'transcription', 'seal_style', 'material', 'shape'],
  face: ['seal_name', 'author', 'transcription']
}

/**
 * 是否**用户创建行**（R-60 的判据＝有 `uploaded_by`）。
 * 用户行的**自由文本一律不动**（用户自行输入的内容不繁化）；枚举字段仍走映射表。
 */
function isUserSourceRow(row) {
  return !!(row && hasText(row.uploaded_by))
}

/**
 * 超限时的回滚副本构造：按比例保留各集合的**前缀行** + 如实登记丢弃行数。
 *
 * **本单扩展**：迁移面扩到 `users` / `points` / `corrections` 后，副本必须一并落这些集合
 * （否则「回滚」只回滚得了印章 / 印面）。集合清单由调用方传入 ⇒ 加集合不必再改本函数。
 * 各集合用**同一个比例**截断（口径统一、可复算），丢弃行数逐个集合如实登记。
 * @param {string} at 迁移时刻（ISO）
 * @param {Record<string, Array<object>>} source 集合名 → 原始行数组（集合名与 `STORAGE_KEYS` 同名）
 */
function buildTradMigrationBackup(at, source) {
  const names = Object.keys(source)
  const totals = {}
  const dropped = {}
  names.forEach((name) => {
    totals[name] = source[name].length
    dropped[name] = 0
  })
  const build = (keep) => ({
    at,
    version: TRAD_MIGRATION_VERSION,
    keys: names.map((name) => STORAGE_KEYS[name] || name),
    counts: { ...totals },
    truncated: names.some((name) => dropped[name] > 0),
    dropped: { ...dropped },
    ...keep
  })
  const sliceAt = (scale) => {
    const keep = {}
    names.forEach((name) => {
      keep[name] = source[name].slice(0, Math.floor(source[name].length * scale))
      dropped[name] = source[name].length - keep[name].length
    })
    return keep
  }
  const full = sliceAt(1)
  const fullText = JSON.stringify(build(full))
  if (fullText.length <= TRAD_MIGRATION_BACKUP_MAX_BYTES) return { payload: build(full), bytes: fullText.length }
  let low = 0
  let high = 1
  let keep = sliceAt(0)
  for (let step = 0; step < 12; step += 1) {
    const mid = (low + high) / 2
    const trial = sliceAt(mid)
    if (JSON.stringify(build(trial)).length <= TRAD_MIGRATION_BACKUP_MAX_BYTES) {
      keep = trial
      low = mid
    } else {
      high = mid
    }
  }
  names.forEach((name) => {
    dropped[name] = source[name].length - keep[name].length
  })
  const payload = build(keep)
  return { payload, bytes: JSON.stringify(payload).length }
}

/** 追加一条逐条留痕（`report.changes` 上限 200 条，其余只计数）。 */
const TRAD_REPORT_CHANGE_LIMIT = 200

function recordTradChange(report, kind, row, diffs) {
  report.changes_total += 1
  if (report.changes.length >= TRAD_REPORT_CHANGE_LIMIT) {
    report.changes_truncated = true
    return
  }
  report.changes.push({
    collection: kind,
    id: String(row.id || row.stamp_id || ''),
    diffs
  })
}

/** 登记「映射不到的枚举旧值」（按 `集合|字段|值` 去重，附计数与样例行号）。 */
function recordUnmappedEnum(report, kind, row, field, value) {
  const key = `${kind}|${field}|${value}`
  let entry = report.unmapped.find((item) => item.key === key)
  if (!entry) {
    entry = { key, collection: kind, field, value, count: 0, sample_ids: [] }
    report.unmapped.push(entry)
  }
  entry.count += 1
  const id = String(row.id || row.stamp_id || '')
  if (entry.sample_ids.length < 5 && !entry.sample_ids.includes(id)) entry.sample_ids.push(id)
}

/**
 * 登记「上下文相关字」（原样保留、未逐字转的字；按 `集合|字段|字` 去重）。
 * 留痕口径与 `recordUnmappedEnum` 同一套：计数 + 样例行号，便于逐条复核。
 */
function recordContextSensitive(report, kind, row, field, char) {
  const key = `${kind}|${field}|${char}`
  let entry = report.context_sensitive.find((item) => item.key === key)
  if (!entry) {
    entry = { key, collection: kind, field, char, count: 0, sample_ids: [] }
    report.context_sensitive.push(entry)
  }
  entry.count += 1
  const id = String(row.id || row.stamp_id || '')
  if (entry.sample_ids.length < 5 && !entry.sample_ids.includes(id)) entry.sample_ids.push(id)
}

/**
 * 登记「用户输入 ⇒ **故意未转**」的字段（逐条留痕，上限与 `report.changes` 同）。
 * 本单硬约束：**绝不转换用户输入文本** —— 不转也要留痕，便于质检逐条复核。
 */
function recordUserTextUntouched(report, kind, row, field, value, reason) {
  report.user_text_untouched_total += 1
  if (report.user_text_untouched.length >= TRAD_REPORT_CHANGE_LIMIT) {
    report.user_text_untouched_truncated = true
    return
  }
  report.user_text_untouched.push({
    collection: kind,
    id: String(row.id || row.stamp_id || ''),
    field,
    value,
    reason
  })
}

/**
 * `points.ref_label`（**本单扩展**）：该字段是「这条流水挂在什么上」的展示文案。
 * **只在系统来源下转**，用户输入的文案一律不动：
 *   - `ref_type = account`：系统字面值（`services/points.js` 传 `新用戶初始贈送`）⇒ 走映射表；
 *   - `ref_type = seal`：值是**印章行自由文本的快照**（`chargeSealDownload` 传 `sealName`）
 *     ⇒ **仅当被引印章行非用户来源**时随印章行一道繁化（与印章行同一口径）；
 *     被引印章行是用户上传的 ⇒ 用户输入，不转；引不到该印章行 ⇒ 来源不明，不转 + 登记；
 *   - 其余（含 `ref_type = correction`：该处 `ref_label` 为空串）⇒ 不转 + 登记（禁猜）。
 */
function migrateLedgerRefLabel(next, report, diffs, ctx) {
  const before = String(next.ref_label)
  const refType = String(next.ref_type || '')
  if (refType === 'account') {
    const mapped = mapSourceText('point', 'ref_label', before)
    if (mapped.state === 'unknown') {
      recordUnmappedEnum(report, 'point', next, 'ref_label', before)
      return
    }
    if (mapped.state === 'mapped') {
      next.ref_label = mapped.to
      report.source_text_mapped += 1
      diffs.push({ field: 'ref_label', from: before, to: mapped.to })
    }
    return
  }
  if (refType === 'seal') {
    const userOwned = ctx && ctx.sealSourceById instanceof Map ? ctx.sealSourceById.get(String(next.ref_id || '')) : undefined
    if (userOwned === true) {
      recordUserTextUntouched(report, 'point', next, 'ref_label', before, 'user-seal-label')
      return
    }
    if (userOwned !== false) {
      recordUnmappedEnum(report, 'point', next, 'ref_label', before)
      return
    }
    const after = toTraditionalText(before)
    if (after !== before) {
      next.ref_label = after
      report.free_text_converted += 1
      diffs.push({ field: 'ref_label', from: before, to: after })
    }
    contextSensitiveCharsIn(before).forEach((char) => recordContextSensitive(report, 'point', next, 'ref_label', char))
    return
  }
  recordUnmappedEnum(report, 'point', next, 'ref_label', before)
}

/**
 * 单行繁化（R-59 清键 + R-60 枚举映射 / 非用户行自由文本 + **本单扩展的集合**），
 * 返回新行与留痕。
 * @param {object} row 原始行
 * @param {'seal'|'face'|'user'|'point'|'correction'} kind 集合
 * @param {object} report 迁移报告（累加留痕）
 * @param {{sealSourceById?:Map<string,boolean>}} [ctx] 迁移上下文（`points.ref_label` 判来源用）
 */
function migrateTradRow(row, kind, report, ctx) {
  if (!row || typeof row !== 'object') return row
  const next = { ...row }
  const diffs = []

  /* ① R-59：退役字段整体删除（**含用户行** —— Kevin 明确授权改写历史行）。 */
  RETIRED_FIELD_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      const from = next[key]
      delete next[key]
      report.keys_removed += 1
      diffs.push({ field: key, from, to: null, removed: true })
    }
  })

  /* ② R-60：枚举字段走**显式值映射表**（所有行，含用户行 —— 枚举不是自由文本）。 */
  ;(ENUM_ROW_FIELDS[kind] || []).forEach(([field, domain]) => {
    const value = next[field]
    if (!hasText(value)) return
    const text = String(value)
    const mapped = mapEnumValue(domain, text)
    if (mapped === null) {
      recordUnmappedEnum(report, kind, next, field, text)
      return
    }
    if (mapped !== text) {
      next[field] = mapped
      report.enums_mapped += 1
      diffs.push({ field, from: text, to: mapped })
    }
  })

  /* ②b **本单扩展**：系统 / 种子来源的显式值映射
     （`users.nickname` / `points.type` / `corrections.field_label`）。
     用户昵称先判**来源**：不是种子 / 系统来源 ⇒ 用户自己改过 ⇒ **逐字不动 + 留痕**，绝不进映射表。 */
  ;(SOURCE_TEXT_FIELDS[kind] || []).forEach((field) => {
    if (!hasText(next[field])) return
    const before = String(next[field])
    if (kind === 'user' && !isSystemNickname(before)) {
      report.user_rows_skipped += 1
      recordUserTextUntouched(report, kind, next, field, before, 'user-edited-nickname')
      return
    }
    const mapped = mapSourceText(kind, field, before)
    if (mapped.state === 'unknown') {
      /* 系统生成形态（`印友<4 位数字>`）繁简同形、且无表项 ⇒ 零变更，不算「映射不到」。 */
      if (!(kind === 'user' && SYSTEM_NICKNAME_PATTERN.test(before))) {
        recordUnmappedEnum(report, kind, next, field, before)
      }
      return
    }
    if (mapped.state === 'mapped') {
      next[field] = mapped.to
      report.source_text_mapped += 1
      diffs.push({ field, from: before, to: mapped.to })
    }
  })

  /* ②c **本单扩展**：`points.ref_label`（只转系统来源；见函数注释）。 */
  if (kind === 'point' && hasText(next.ref_label)) migrateLedgerRefLabel(next, report, diffs, ctx)


  /* ③ R-60：自由文本 —— 只对**印章 / 印面行**做，且**只转非用户来源行**；
     用户行一律不动（逐字保留）。其它集合（users / points / corrections）的文本字段
     要么已在 ②b / ②c 按映射表或来源判过，要么是用户输入（本单不碰）。 */
  if (kind === 'seal' || kind === 'face') {
    if (isUserSourceRow(next)) {
      report.user_rows_skipped += 1
      if (diffs.length > 0) recordTradChange(report, kind, next, diffs)
      return diffs.length > 0 ? next : row
    }
    ;(FREE_TEXT_ROW_FIELDS[kind] || []).forEach((field) => {
      if (!hasText(next[field])) return
      const before = String(next[field])
      const after = toTraditionalText(before)
      if (after !== before) {
        next[field] = after
        report.free_text_converted += 1
        diffs.push({ field, from: before, to: after })
      }
      /* 上下文相关字：本迁移**不转**这些字（词组层才能定形）⇒ 逐条留痕，便于规范侧复核。 */
      contextSensitiveCharsIn(before).forEach((char) => recordContextSensitive(report, kind, next, field, char))
    })
    /* 来源追踪（`source`）里的字符串同属上屏自由文本：只转字符串值、结构不动。 */
    if (next.source && typeof next.source === 'object' && !Array.isArray(next.source)) {
      const source = { ...next.source }
      let sourceTouched = false
      Object.keys(source).forEach((key) => {
        if (typeof source[key] !== 'string') return
        const after = toTraditionalText(source[key])
        if (after !== source[key]) {
          diffs.push({ field: `source.${key}`, from: source[key], to: after })
          source[key] = after
          sourceTouched = true
          report.free_text_converted += 1
        }
        contextSensitiveCharsIn(source[key]).forEach((char) => recordContextSensitive(report, kind, next, `source.${key}`, char))
      })
      if (sourceTouched) next.source = source
    }
  }

  if (diffs.length > 0) {
    recordTradChange(report, kind, next, diffs)
    return next
  }
  return row
}

/**
 * **一次性、幂等**的繁体化与字段退役迁移（R-56〜R-61 + **R-60 扩展**）。由 `ensureSeed()`
 * 在每次引导时调用，记账命中即直接返回（**零写入**）。
 *
 * 迁移面（版本 2）：`seals` / `faces`（首版）+ **`users` / `points` / `corrections`**（本单扩展）；
 * 其余集合在**报告里逐个登记**为「判过、不转」（见 `report.collections` 与 `report.plan`）。
 * 动作顺序：**先落回滚副本（各集合原始行数组）→ 再逐行迁移（清退役键 + 枚举 / 系统字面值映射
 * + 非用户行自由文本繁化）→ 只在确有变更时写回**该集合** → 最后写记账**。
 * 幂等口径：二次调用返回 `{skipped:true, changed:0}` 且不产生任何写入。
 * @returns {{ok:boolean, skipped:boolean, changed:number, message:string, report?:object}}
 */
export function migrateTraditionalData() {
  const marker = readKey(STORAGE_KEYS.seeded)
  const book = marker && typeof marker === 'object' ? marker : {}
  if (Number(book.trad_migration || 0) >= TRAD_MIGRATION_VERSION) {
    return {
      ok: true,
      skipped: true,
      changed: 0,
      message: '繁體化遷移此前已完成，本次未做任何寫入'
    }
  }

  const rawSeals = readKey(STORAGE_KEYS.seals)
  const rawFaces = readKey(STORAGE_KEYS.faces)
  const rawUsers = readKey(STORAGE_KEYS.users)
  const rawPoints = readKey(STORAGE_KEYS.points)
  const rawCorrections = readKey(STORAGE_KEYS.corrections)
  const seals = Array.isArray(rawSeals) ? rawSeals : []
  const faces = Array.isArray(rawFaces) ? rawFaces : []
  const users = Array.isArray(rawUsers) ? rawUsers : []
  const points = Array.isArray(rawPoints) ? rawPoints : []
  const corrections = Array.isArray(rawCorrections) ? rawCorrections : []
  const at = nowIso()

  /* ① 回滚副本（**各集合的原始行数组**）—— 先落，再动任何一行。
     **K4**：落点不再写死 —— 真正落点＝`storage.js` 的**代际路由**结果
     （`migrationBackupWriteKey`；本文件不自造键名、不写死键名字面量）。
     v3 这一代落**本代自己的键**，旧代（v1 / v2）的副本留在它自己那一代 ⇒ 两代共存、旧代不被取代。 */
  const backup = buildTradMigrationBackup(at, { seals, faces, users, points, corrections })
  const backupKey = migrationBackupWriteKey(TRAD_MIGRATION_BACKUP_KEY, backup.payload) // **实落点**
  const backupGeneration = MIGRATION_BACKUP_GENERATIONS.find((gen) => gen.key === backupKey) || null
  /* 「取代」判据＝**实落点**那个键上此前有没有值（只有同键再写才谈得上取代）。
     路由到别的代 ⇒ 该键此前为空 ⇒ **不取代**（与「保留旧代」的实况一致）。 */
  const previousBackupAtTarget = readKey(backupKey)
  const previousBackupAtCallerKey = readKey(TRAD_MIGRATION_BACKUP_KEY)
  const backupWritten = writeKey(TRAD_MIGRATION_BACKUP_KEY, backup.payload)
  /* 兼容镜像：`storage.js::writeKey` 在「实落点 ≠ 调用方给的键」且**调用方那个键此刻为空**时
     补写同一份副本（已有值则**绝不覆盖**）⇒ 这里回读实况如实上报，不假定它一定写成功。 */
  const mirrorKey = backupKey === TRAD_MIGRATION_BACKUP_KEY ? null : TRAD_MIGRATION_BACKUP_KEY
  const backupsAfter = readMigrationBackups()
  const versionAt = (payload) =>
    payload && typeof payload === 'object' && payload.version !== undefined ? payload.version : null

  const report = {
    at,
    version: TRAD_MIGRATION_VERSION,
    /* **K4**：**实落点** —— 逐字等于本次在 localStorage 里真正写入的副本键名。 */
    backup_key: backupKey,
    /* 本代标签（取自 `storage.js` 的代际表；路由不到任何代 ⇒ `null`）＋调用方给的键。 */
    backup_generation: backupGeneration ? backupGeneration.label : null,
    backup_key_caller: TRAD_MIGRATION_BACKUP_KEY,
    /* 兼容镜像：写没写、写在哪个键。**判据＝写前调用方那个键为空**（已有值则 `storage.js`
       绝不覆盖 ⇒ 镜像没发生，那个键上的是旧代自己的副本）。 */
    backup_mirror_key: mirrorKey,
    backup_mirror_written: mirrorKey !== null && previousBackupAtCallerKey === null && backupsAfter[mirrorKey] !== null,
    /* 调用方那个键写前**已有旧代副本**（⇒ 镜像不发生、旧代副本原样保留）。 */
    backup_caller_key_preexisting: previousBackupAtCallerKey !== null && previousBackupAtCallerKey !== undefined,
    /* 本次写入后**逐代副本键的物理在位清单**（证明旧代副本仍在，不是只报一个新键就完事）。 */
    backup_keys_present_after: Object.keys(backupsAfter).filter(
      (key) => backupsAfter[key] !== null && backupsAfter[key] !== undefined
    ),
    backup_bytes: backup.bytes,
    backup_written: backupWritten === true,
    backup_truncated: backup.payload.truncated === true,
    backup_dropped: backup.payload.dropped,
    /* **K4 收口**：真实行为＝「**保留旧代 + 新代新键**」⇒ 旧副本**不被取代**。
       判据＝实落点那个键此前是否有值（见上）⇒ 本场景恒 `false`。字段名保留（既有消费方照旧可读），
       语义与实况一致（不再因「读到过旧副本」就谎报 `true`）。 */
    backup_supersedes_previous: previousBackupAtTarget !== null && previousBackupAtTarget !== undefined,
    /* 实落点键上**此前**的副本版本（＝真正被本键取代过的那个）；路由到新代 ⇒ `null`。 */
    previous_backup_version: versionAt(previousBackupAtTarget),
    /* 调用方给的键上**此前**的副本版本（老库＝v1 / v2 那一代；供排障对照，不参与取代判定）。 */
    previous_backup_version_caller: versionAt(previousBackupAtCallerKey),
    /* **逐集合** scanned / changed（本单要求：哪些集合转了、哪些不转，逐集合报回）。 */
    collections: {},
    rows_scanned: seals.length + faces.length + users.length + points.length + corrections.length,
    rows_changed: 0,
    keys_removed: 0,
    enums_mapped: 0,
    source_text_mapped: 0,
    free_text_converted: 0,
    user_rows_skipped: 0,
    user_text_untouched_total: 0,
    user_text_untouched_truncated: false,
    changes_total: 0,
    changes_truncated: false,
    changes: [],
    /* 用户输入 ⇒ 故意未转（逐条留痕；本单硬约束）。 */
    user_text_untouched: [],
    unmapped: [],
    /* 「上下文相关字」留痕：原样保留、未逐字转（词组层才能定形）。 */
    context_sensitive: [],
    /* 本次用到的**显式映射表全表**（逐字段：旧形态 + 恒等项）。 */
    maps: tradSourceTextMaps(),
    /* 逐集合「转 / 不转」清单（判据与实现同处，不是另写一份说明）。 */
    plan: tradCollectionPlan()
  }

  /** 逐集合迁移；`changed === 0` ⇒ 该集合**零写入**。逐集合登记 scanned / changed。 */
  const convert = (name, rows, kind, ctx) => {
    let changed = 0
    const next = rows.map((row) => {
      const out = migrateTradRow(row, kind, report, ctx)
      if (out !== row) changed += 1
      return out
    })
    report.collections[name] = { scanned: rows.length, changed, converted: true, kind }
    report.rows_changed += changed
    return { rows: next, changed }
  }

  /* `points.ref_label` 判来源用：印章行 id → 是否**用户上传**（`uploaded_by`）。 */
  const sealSourceById = new Map()
  seals.forEach((row) => {
    if (!row || typeof row !== 'object') return
    const id = String(row.stamp_id || row.sealId || row.id || '')
    if (id) sealSourceById.set(id, isUserSourceRow(row))
  })
  const ctx = { sealSourceById }

  const outSeals = convert('seals', seals, 'seal', ctx)
  const outFaces = convert('faces', faces, 'face', ctx)
  const outUsers = convert('users', users, 'user', ctx)
  const outPoints = convert('points', points, 'point', ctx)
  const outCorrections = convert('corrections', corrections, 'correction', ctx)

  /* ② 枚举过但**不转**的集合：只登记 scanned（证明逐集合判过，不是漏了）。 */
  ;['photos', 'downloaded', 'images', 'session', 'theme', 'seeded'].forEach((name) => {
    const raw = readKey(STORAGE_KEYS[name])
    report.collections[name] = {
      scanned: Array.isArray(raw) ? raw.length : raw === null || raw === undefined ? 0 : 1,
      changed: 0,
      converted: false
    }
  })

  /* ③ 只在**确有变更**时写回该集合（零变更 ⇒ 集合零写入）。 */
  if (outSeals.changed > 0) writeKey(STORAGE_KEYS.seals, outSeals.rows)
  if (outFaces.changed > 0) writeKey(STORAGE_KEYS.faces, outFaces.rows)
  if (outUsers.changed > 0) writeKey(STORAGE_KEYS.users, outUsers.rows)
  if (outPoints.changed > 0) writeKey(STORAGE_KEYS.points, outPoints.rows)
  if (outCorrections.changed > 0) writeKey(STORAGE_KEYS.corrections, outCorrections.rows)

  /* ④ 记账（幂等凭据）：保留 `seeded` 原有字段，只追加本迁移的版本与报告。 */
  const base = Object.keys(book).length > 0 ? book : { at: 'seed', version: SEED_VERSION }
  writeKey(STORAGE_KEYS.seeded, { ...base, trad_migration: TRAD_MIGRATION_VERSION, trad_report: report })

  const changedNames = Object.keys(report.collections).filter((name) => report.collections[name].changed > 0)
  return {
    ok: true,
    skipped: false,
    changed: report.rows_changed,
    report,
    message:
      report.rows_changed > 0
        ? `繁體化遷移完成（v${TRAD_MIGRATION_VERSION}）：${report.rows_changed} 行改動，涉及 ${changedNames.join('、') || '（無）'}（清退役鍵 ${report.keys_removed} 處、枚舉歸一 ${report.enums_mapped} 處、系統字面值歸一 ${report.source_text_mapped} 處、自由文本繁化 ${report.free_text_converted} 處；用戶輸入未動 ${report.user_rows_skipped} 行／${report.user_text_untouched_total} 處；映射不到的舊值 ${report.unmapped.length} 類；上下文相關字原樣保留 ${report.context_sensitive.length} 類）`
        : `繁體化遷移已執行（v${TRAD_MIGRATION_VERSION}）：本次無需改動任何行（二次執行零變更）`
  }
}

/** 读回到当前库的繁体化迁移报告（自测 / 质检；未跑过 ⇒ `null`）。 */
export function tradMigrationReport() {
  const marker = readKey(STORAGE_KEYS.seeded)
  return marker && typeof marker === 'object' && marker.trad_report ? marker.trad_report : null
}

/* ============================================================================
   **R-98（2026-09-21｜Kong-T1 内核收敛）**：切片元数据（切割 / 拼接真源）
   ----------------------------------------------------------------------------
   真源常量在 `seed.js`（`SLICE_META_FIELD`）；**切割 / 拼接的计算真源＝`src/tilesplicer/`
   （TileSplicer 内核）** —— 本文件**只转调，不再持有一份同义实现**（R-98「真源恰 1 处」）：
     - `sliceMetaOf(imageId, kind)`：**导出名 / 签名逐字不变**（既有探针 66/66、86/86 依赖其名），
       内部转调内核 `metaFor` —— 切位派生（`offsetRatio`）、刀向序列、刀数、`cols` / `rows`
       一律来自内核；**未登记类别按印面族（4 块）** 的历史容忍口径由内核的
       `tolerateUnregisteredKind` 选项承载（本文件**不**另写一套刀数策略）；
     - `sliceWindowsOf(meta)`：**导出名 / 签名逐字不变**，内部转调内核 `windowsOf`。
       相邻块**共用同一个边界数**值 ⇒ 天生**无缝隙、无重叠、并集＝整图**（R-87「拼接必须
       视觉无缝」的实现口径；前端现场切分 / 拼接按本函数口径即可）。
   纪律：**不得**在本文件再写切向序列 / 切位派生 / 逐块几何（单一真源）；**不抛未捕获异常**
   （非法输入一律走内核的确定性退化值）。
   ============================================================================ */

/**
 * **切片元数据（R-87 / R-88）：确定性派生**（纯函数，不碰任何存储）。
 *
 * 实现真源＝**TileSplicer 内核**（`src/tilesplicer/core.js::metaFor`）：本函数**只转调**，
 * 不含切位 / 刀向 / 块阵的任何计算。
 *
 * 形状**逐字冻结**为 `{directions, ratios, cols, rows, cuts}`（键序亦冻结）：
 *   - `directions`：刀向序列（刀 1 向 A、刀 2 ⊥A、**刀 3 回 A 向**）；
 *   - `ratios`：逐刀切位（`offsetRatio`，归一化 0〜1）；
 *   - `cols` / `rows`：块阵（由刀向序列推得）⇒ 印面 2×2（4 块）、实拍 4×2（8 块）；
 *   - `cuts`：刀数（＝`directions.length`）。
 *
 * **确定性**：只由 `imageId`（经 `sha256Hex` 摘要）与 `kind` 决定 —— 同一 id 连算 N 次结果
 * 全等，且**与时间 / 随机 / 调用顺序无关**；换 id ⇒ 切位必然另行派生。既有行**无需迁移**
 * （派生即可复现），新建影像行由 `insertImageRow` 落盘该键。
 *
 * **历史容忍（导出名 / 签名逐字不变的原因）**：未登记类别（含空值 / `null` / 未知字面值）
 * 一律按**印面族**口径派生（2 刀 / 4 块），**不抛错、不改返回形状** —— 既有探针与历史调用方
 * 依赖该行为；内核的严格值域（`UNKNOWN_KIND`）只在**冻结入口 `planFor`** 生效。
 *
 * @param {string} imageId 影像编号（`asset.id`）
 * @param {string} [kind] 切片类别（`FACE` 印面族 / `PHOTO` 实拍族；缺省按印面 4 块）
 * @returns {{directions:string[], ratios:number[], cols:number, rows:number, cuts:number}}
 */
export function sliceMetaOf(imageId, kind = FACE_KIND.FACE) {
  const id = imageId === null || imageId === undefined ? '' : String(imageId)
  /* 真源＝内核；`tolerateUnregisteredKind` ⇒ 未登记类别按印面族（历史口径，见函数注释）。 */
  const derived = TileSplicer.metaFor(id, kind, { tolerateUnregisteredKind: true })
  return derived.meta
}

/**
 * 由切片元数据派生**逐块窗口**（纯函数；归一化坐标 `x0/y0/x1/y1`，左上原点）。
 * 实现真源＝**TileSplicer 内核**（`src/tilesplicer/core.js::windowsOf`）：本函数**只转调**。
 *
 * 几何保证（R-87「拼接必须视觉无缝」的机械口径）：
 *   - **并集＝整图**：窗口覆盖 `[0,1] × [0,1]` 全幅；
 *   - **两两不交**：相邻块的边界**取同一个数**（同一数组元素）⇒ 既无缝隙也不重叠；
 *   - 顺序＝行主序（`index = row * cols + col`），`cols` / `rows` 与元数据一致。
 *
 * 非法 / 残缺元数据 ⇒ 走内核的确定性退化（缺失方向被忽略、切位夹到 `[0,1]`），**不抛错**。
 * @param {{directions?:string[], ratios?:number[]}} meta 切片元数据（`sliceMetaOf` 的产物）
 * @returns {Array<{index:number, col:number, row:number, x0:number, y0:number, x1:number, y1:number}>}
 */
export function sliceWindowsOf(meta) {
  return TileSplicer.windowsOf(meta)
}

/**
 * **补切片元数据（R-87 落盘口径）**：种子影像行在**落盘时**按同一派生函数补 `slice_meta`
 * （种子数组里**不写死字面量** ⇒ 「种子值」与「派生真源」不会两处漂移）；
 * **已有该键的行不覆盖**（落盘行＝真源，派生只负责补缺）。
 */
function withSliceMeta(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) =>
    row && Object.prototype.hasOwnProperty.call(row, SLICE_META_FIELD)
      ? row
      : {
          ...row,
          [SLICE_META_FIELD]: sliceMetaOf(
            row ? row.id : '',
            row && row.kind ? row.kind : FACE_KIND.FACE
          )
        }
  )
}

export function listSealRows() {
  return readCollection(STORAGE_KEYS.seals, [])
}

export function saveSealRows(rows) {
  return writeCollection(STORAGE_KEYS.seals, rows)
}

/* ---------------------------- 印面与影像 ---------------------------- */

export function listFaceRows() {
  return readFaceCollection()
}

export function saveFaceRows(rows) {
  return writeCollection(STORAGE_KEYS.faces, rows)
}

/*
 * **影像行（讀取面）** —— 真源容器 `slice_meta` 的**讀路徑補缺**。
 *
 * 為什麼要有：切分元數據（張數 / 刀向 / 切位）的真源恰一處 ＝ 行上的 `slice_meta`
 * （`SLICE_META_FIELD`，容器形狀由本檔的 `sliceMetaOf()` 由 `id` ＋ `kind` **確定性派生**）。
 * 落盤面（`ensureSeed()` / `insertImageRow()`）都會補這個鍵，但**雲端快照行不是本機落盤行**
 * （遷移進 `xiai_images` 的文檔只有 `kind` / `width` / `height` / `sha256` / `storage_key` 等
 * 機械欄位，沒有 `slice_meta`）⇒ 讀出來的行缺真源容器，展示層（`SliceImage.vue` 經
 * `sliceMetaOf()`）只能結構化拒絕 ⇒ **線上實據（2026-09-28）：詳情頁「印面影像」塊穩定顯示
 * 「影像暫時無法顯示」，而同桶同源的廣場卡片（走 `<img>` ＋ dataURL，不經切分元數據）能出圖**
 * —— 也就是說這不是桶 / 權限 / 時序問題，而是**讀出來的行缺真源**。
 *
 * 口徑：與落盤補缺**同一份派生函數**（`withSliceMeta`，**已有該鍵的行不覆蓋**）⇒ 種子值、
 * 落盤值、雲端行三者不會漂移；本函數**只讀**，不改寫 localStorage / 不動任何行。
 */
export function listImageRows() {
  return withSliceMeta(readCollection(STORAGE_KEYS.images, []))
}

export function saveImageRows(rows) {
  return writeCollection(STORAGE_KEYS.images, rows)
}

/* ============================================================================
   **影像色彩元数据的「读时现判」（K4 收口｜2026-09-21）**
   ----------------------------------------------------------------------------
   背景：`assetmeta.js::imageSize` 从 R-91 起就能给出 `colorType` / `bitDepth` /
   `paletteEntries` / `neutral`（索引色 PNG 可判「8 級灰 / 無彩色 / 位深 4」），
   但**既有影像行**是按老形态落盘的（只有 `colorMode` / `color_mode`）⇒ 落盘面上无字段可判。

   口径（本单硬约束，逐条执行）：
     - **既有行不回填**（不强制大迁移、不动历史值、不写任何一行）；
     - **读取时**若该行缺键 ⇒ **按字节现判**（从影像库取回二进制 → `imageSize`）；
     - **读不出就如实报 `unknown`**（二进制不在库 / 认不出的字节 ⇒ 四键一律 `null`），
     - `source` 字段如实标注该读数的**来历**：`'stored'`（行里已落盘，逐字读回）/
       `'derived'`（本次按字节现判）/ `'unknown'`（二进制不可得 ⇒ 四键全 `null`）。
   本段**只读**（`listImageRows` + `getImageBinary`），**不调用任何写入口**。
   ============================================================================ */

/** 影像色彩元数据的四个**可判键**（K4 落盘口径＝读时现判口径，同一组名字）。 */
export const IMAGE_COLOR_FACT_FIELDS = ['colorType', 'bitDepth', 'paletteEntries', 'neutral']

const ownsColorFact = (row, key) => Object.prototype.hasOwnProperty.call(row || {}, key)

/** 该行是否**四个键都在**（缺任一 ⇒ 视为「既有行」，走现判）。 */
function hasAllColorFacts(row) {
  return IMAGE_COLOR_FACT_FIELDS.every((key) => ownsColorFact(row, key))
}

/** 逐键读回已落盘的值（**缺键如实 `null`**，不用别的键顶替）。 */
function storedColorFacts(row) {
  const out = {}
  IMAGE_COLOR_FACT_FIELDS.forEach((key) => {
    out[key] = ownsColorFact(row, key) ? row[key] : null
  })
  return out
}

const emptyColorFacts = () => {
  const out = {}
  IMAGE_COLOR_FACT_FIELDS.forEach((key) => {
    out[key] = null
  })
  return out
}

/**
 * **单条影像行的色彩元数据读数**：行里已落盘 ⇒ 逐字读回（`source: 'stored'`）；
 * 缺键 ⇒ 按**字节现判**（`source: 'derived'`）；二进制取不回 ⇒ 四键 `null`（`source: 'unknown'`）。
 *
 * **只读**：不写回、不回填、不改任何历史值（本单硬约束）。
 * @param {string} assetId 影像 id（也接受 `stamp_id` 形态的唯一匹配）
 * @returns {Promise<{ok:boolean, id:string, source:'stored'|'derived'|'unknown', facts:object,
 *   reason?:string, message?:string, width?:number, height?:number, colorMode?:string,
 *   bytes?:number, mime?:string}>}
 */
export async function imageColorFacts(assetId) {
  const rows = listImageRows()
  const row = rows.find((item) => item && (item.id === assetId || item.assetId === assetId))
  if (!row) {
    return {
      ok: false,
      id: String(assetId || ''),
      source: 'unknown',
      facts: emptyColorFacts(),
      reason: 'NOT_FOUND',
      message: '影像行不存在，無法判定色彩元數據'
    }
  }
  const id = String(row.id || row.assetId || '')
  if (hasAllColorFacts(row)) {
    return {
      ok: true,
      id,
      source: 'stored',
      facts: storedColorFacts(row),
      width: row.width,
      height: row.height,
      colorMode: row.colorMode || row.color_mode || '',
      bytes: row.bytes,
      mime: row.mime || ''
    }
  }
  /* 既有行（缺键）⇒ 按**字节现判**。取不回二进制 ⇒ 如实 unknown，四键全 null（不猜）。 */
  const bin = await getImageBinary(id)
  if (!bin.ok || !bin.bytes) {
    return {
      ok: false,
      id,
      source: 'unknown',
      facts: emptyColorFacts(),
      reason: bin.reason || 'BINARY_UNAVAILABLE',
      message: '影像二進制不在本地存儲 ⇒ 四鍵如實爲 null（不猜）'
    }
  }
  const size = imageSize(bin.bytes)
  return {
    ok: true,
    id,
    source: 'derived',
    facts: {
      colorType: size.colorType,
      bitDepth: size.bitDepth,
      paletteEntries: size.paletteEntries,
      neutral: size.neutral
    },
    /* 现判出的其余读数一并交出，便于对拍（行里的历史值**一律不改**）。 */
    width: size.width,
    height: size.height,
    colorMode: size.colorMode,
    row_width: row.width,
    row_height: row.height,
    bytes: bin.bytesLength,
    mime: bin.mime || ''
  }
}

/**
 * **全量影像行的色彩元数据读数**（既有行**读时现判**，不回填）。逐行 `source` 如实标注，
 * 供「数据面是否可判」的自证与排障。
 * @returns {Promise<{ok:boolean, total:number, rows:object[], counts:object, unavailable:string[]}>}
 */
export async function listImageRowsWithColorFacts() {
  const rows = listImageRows()
  const out = []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    /* 顺序逐条（`await` 在循环内）⇒ 读数与行一一对应，不并发乱序。 */
    const facts = await imageColorFacts(row.id || row.assetId)
    out.push({
      id: String(row.id || row.assetId || ''),
      stamp_id: row.stamp_id || '',
      kind: row.kind || '',
      source: facts.source,
      facts: facts.facts,
      width: row.width,
      height: row.height,
      colorMode: row.colorMode || row.color_mode || '',
      reason: facts.reason || ''
    })
  }
  const counts = { stored: 0, derived: 0, unknown: 0 }
  out.forEach((item) => {
    counts[item.source] = (counts[item.source] || 0) + 1
  })
  return {
    ok: true,
    total: out.length,
    rows: out,
    counts,
    unavailable: out.filter((item) => item.source === 'unknown').map((item) => item.id)
  }
}

/* ============================================================================
   **读路径回落（R-30 / R-31 / R-32｜兼容旧数据，只读、绝不写）**
   ----------------------------------------------------------------------------
   为什么需要回落：库内既有行是按**旧形态**落盘的（印面行可能没有 `seal_type`、
   印章行可能没有 `material`、印面行一律没有 `face_style`）。回落**只改变读出的值**，
   回落方向（冻结契约）：
     - 【印面内容】印面行 `seal_type` 空 ⇒ 回落**该印章行**的 `seal_type` 镜像；仍空 ⇒ `''`；
     - 【印面风格】**无回落**（新字段；旧行一律 `''`）；
     - 【材质】印章行 `material` 空 ⇒ 回落**主印面**（`kind = FACE`，取第一个）的旧
       `material`；仍空 ⇒ `''`。
   三个函数都是**纯函数**（不读存储、不写存储），供 `services/seals.js` 的视图模型与
   聚合筛选复用同一套口径。

   印面中，**存储顺序第一个**」（＝既有实现的现状；旧数据下与「最早创建」结果一致，故数据
   不反向改写）。这条规则**只在本文件实现一次**（`primaryFaceIn`），五处消费方
   （`sealMaterialValue` / `writeFixedAttributes` / `services/seals.js::primaryFaceOf` /
   `services/seals.js::faceLabelOf` / `services/seals.js::listSeals`）一律调用它，
   ============================================================================ */

/** 非空判定：`null` / `undefined` / 仅空白 一律算「空」（空值才触发回落）。 */
function hasText(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

/** 取文本原值（**不去空白、不归一** —— 读路径不得改写既有值的形态）。 */
function rawText(value) {
  return value === null || value === undefined ? '' : String(value)
}

/**
 * 【印面内容】读值：印面行 `seal_type` 空 ⇒ 回落该印章行的 `seal_type` 镜像 ⇒ 仍空 ⇒ `''`。
 * **不做值域校验**（R-21 / R-32：旧值如 `吉語印` / `鑒藏印` / `閒章` 必须照读不误）。
 * @param {object|null} faceRow 印面行（缺失 ⇒ 只用印章行镜像）
 * @param {object|null} sealRow 所属印章行（镜像来源）
 */
export function faceContentValue(faceRow, sealRow) {
  const onFace = faceRow ? faceRow.seal_type : ''
  if (hasText(onFace)) return rawText(onFace)
  return rawText(sealRow ? sealRow.seal_type : '')
}

/**
 * 【印面风格】读值：**无回落** —— 只读印面行 `face_style`，缺失 / 空 ⇒ `''`
 * （旧行没有该字段；**不得**回落 `seal_style` 或印章行 —— 那是另一套口径的旧字段）。
 */
export function faceStyleValue(faceRow) {
  const onFace = faceRow ? faceRow.face_style : ''
  return hasText(onFace) ? rawText(onFace) : ''
}

/**
 * 【大類】读值：**无回落** —— 只读印面行 `seal_class`，缺失 / 空 ⇒ `''`
 * （**不得**从印章行或其它键取任何值 —— 那会等于编造；旧行一律无该键）。
 */
export function sealClassValue(faceRow) {
  const onFace = faceRow ? faceRow.seal_class : ''
  return hasText(onFace) ? rawText(onFace) : ''
}

/**
 * 主印面（**R-44 冻结口径**）：给定一串印面（**原始行或视图模型皆可**，只要带 `kind`），
 * 取**存储顺序第一个** `kind = 'FACE'` 者；一个 `FACE` 都没有 ⇒ `null`。
 *
 * 口径：**「存储顺序第一个 FACE」**。本函数**只做这一件事**（取第一个 FACE）——
 * 调用方自行负责把序列限定在该印章范围内。收敛的就是这条规则：
 * `sealMaterialValue` / `writeFixedAttributes` / `services/seals.js::primaryFaceOf` /
 * `services/seals.js::faceLabelOf` / `services/seals.js::listSeals` 五处一律调它，
 * **不得各自再写一份 `find(kind === 'FACE')`**。
 * @param {Array<object>} rows 印面序列（原始行 / 视图模型）
 * @returns {object|null} 主印面（无 `FACE` 时 `null`）
 */
export function primaryFaceIn(rows) {
  const list = Array.isArray(rows) ? rows : []
  return list.find((row) => row && row.kind === FACE_KIND.FACE) || null
}

/**
 * 【材质】读值（**印章级**，R-32）：印章行 `material` 空 ⇒ 回落**主印面**（`kind = FACE`
 * 的第一个）的旧 `material` ⇒ 仍空 ⇒ `''`。
 * @param {object|null} sealRow 印章行（真源）
 * @param {Array<object>} [faceRows] 该印章的印面行；缺省则自行按印章读取
 */
export function sealMaterialValue(sealRow, faceRows) {
  const onSeal = sealRow ? sealRow.material : ''
  if (hasText(onSeal)) return rawText(onSeal)
  const rows = Array.isArray(faceRows)
    ? faceRows
    : sealRow
      ? listFaceRows().filter((row) => (row.sealId || row.stamp_id) === (sealRow.stamp_id || sealRow.id))
      : []
  const primary = primaryFaceIn(rows)
  const onFace = primary ? primary.material : ''
  return hasText(onFace) ? rawText(onFace) : ''
}

/* -------------------------------- 用户 -------------------------------- */

export function listUserRows() {
  return readCollection(STORAGE_KEYS.users, [])
}

export function saveUserRows(rows) {
  return writeCollection(STORAGE_KEYS.users, rows)
}

/* ------------------------------ 业务集合 ------------------------------ */

/**
 * 读勘误。旧装里可能残留旧枚举字面值 `APPROVED`，
 * 这里统一归一为规范冻结的 `ACCEPTED` 并**回写落盘**，
 * 否则旧数据会变成不可识别的状态。
 */
export function listCorrectionRows() {
  const rows = readCollection(STORAGE_KEYS.corrections, [])
  let migrated = false
  const next = rows.map((row) => {
    const status = normalizeCorrectionStatus(row.status)
    if (status === row.status) return row
    migrated = true
    return { ...row, status, status_migrated_from: row.status }
  })
  if (migrated) writeCollection(STORAGE_KEYS.corrections, next)
  return next
}

export function saveCorrectionRows(rows) {
  return writeCollection(STORAGE_KEYS.corrections, rows)
}

/**
 * 读**公开勘误投影行**（云端公开只读集合 `xiai_corrections_public` 的读面）。
 *
 * 读序与既有集合一致（`readCollection`）：云端 `ready` ⇒ 云端快照 ∪ 本机同 `_id` 覆盖；
 * 其余 ⇒ 本机 `corrections-public` 键。行是**已采纳勘误的公开投影**（`status` 缺键按
 * `ACCEPTED` 归一，见 `cloudbase.js::normalizePublicCorrectionRow`），**只在展示面使用**。
 * 本函数**只读**（不灌种子、不写存储）。
 */
export function listPublicCorrectionRows() {
  return readCollection(STORAGE_KEYS.correctionsPublic, [])
}

/**
 * 读**公开投影行的本机镜像**（**只读本机 `corrections-public` 键**，不过云端快照）。
 * 用途：采纳写面同步镜像时做**幂等 upsert**（按 `id` 覆盖）——若走
 * `listPublicCorrectionRows()`（含云端行）会把云端行一并写回本机键，故此处只读本机。
 */
export function listPublicCorrectionMirrorRows() {
  const rows = readKey(STORAGE_KEYS.correctionsPublic)
  return Array.isArray(rows) ? rows : []
}

/** 写**公开投影行的本机镜像**（整键覆盖写；调用方负责先合并成幂等结果）。 */
export function savePublicCorrectionRows(rows) {
  return writeCollection(STORAGE_KEYS.correctionsPublic, rows)
}

/**
 * 读**采信（採信）私有行的本机镜像**（**只读本机 `endorsements` 键**）。
 * 用途：本机判定「我是否已对该 `(faceId, field, value)` 采信」（幂等 / 按钮态）；
 * 行是**本人**的采信行（含 `user_id`），**不是**公开面。云端权威行落在私有集合
 * `xiai_endorsements`（只能由云函数写）。
 */
export function listEndorsementRows() {
  const rows = readKey(STORAGE_KEYS.endorsements)
  return Array.isArray(rows) ? rows : []
}

/** 写**采信私有行的本机镜像**（整键覆盖写；调用方负责先合并成幂等结果）。 */
export function saveEndorsementRows(rows) {
  return writeCollection(STORAGE_KEYS.endorsements, rows)
}

/**
 * 读**值级公开摘要行**（云端公开只读集合 `xiai_correction_summaries` 的读面）。
 *
 * 读序与既有集合一致（`readCollection`）：云端 `ready` ⇒ 云端快照 ∪ 本机同 `_id` 覆盖；
 * 其余 ⇒ 本机 `correction-summaries` 键。行是**值级公开摘要**（`submits` / `endorses` /
 * `status` / `submitter_uids`；**零手机号**、uid 允许），**详情页候选值列表的唯一数据源**
 * ⇒ 跨浏览器可见（它不依赖本机 `corrections` 镜像）。本函数**只读**（不灌种子、不写存储）。
 */
export function listCorrectionSummaryRows() {
  return readCollection(STORAGE_KEYS.correctionSummaries, [])
}

/**
 * 读**值级公开摘要行的本机镜像**（**只读本机 `correction-summaries` 键**，不过云端快照）。
 * 用途：写面同步镜像时做**幂等 upsert**（按 `_id` / `(faceId,field,value)` 覆盖）。
 */
export function listCorrectionSummaryMirrorRows() {
  const rows = readKey(STORAGE_KEYS.correctionSummaries)
  return Array.isArray(rows) ? rows : []
}

/** 写**值级公开摘要行的本机镜像**（整键覆盖写；调用方负责先合并成幂等结果）。 */
export function saveCorrectionSummaryRows(rows) {
  return writeCollection(STORAGE_KEYS.correctionSummaries, rows)
}

/* ============================================================================
   **印人（person）集合读写（person-model-draft-v0.1 §2 / §3）**
   ----------------------------------------------------------------------------
   新增两集合：`xiai_persons`（正式印人 / A 支）与 `xiai_person_proposals`（提案 / 审核行）。
   **单写者（冻结）**：`xiai_persons` **只经采纳路径**产生（`services/persons.js` 的采纳分支）；
   **不开放任何直写入口**（含管理员直写 ⇒ `FORBIDDEN` ＋ 零写入）。
   显示名派生**恰一处**（`personDisplayName`）＋ 作者显示名链**恰一处**（`resolveAuthorName`）
   —— 卡片 / 详情 / 导出 / 文本导出**一律经它**，**零第二套名表**。
   **本机键登记（按现态校正）**：全工程「存储键登记表」的唯一落点 ＝ `data/storage.js::STORAGE_KEYS`
   —— 现态**已登记两枚新键**：`persons` 与 `personProposals`（真实键名 `persons` /
   `person-proposals`），登记表**共 23 项**（既往 21 ＋ 本模型 2）。本处本机键名常量与
   `STORAGE_KEYS` 同名同值；读写仍经 `readCollection` / `writeCollection`（键在 `xiai:v1:` 命名空间下）。
   ============================================================================ */

/** 正式印人本机集合键（真实键名 `xiai:v1:persons`；代际登记见本节头注）。 */
const PERSON_COLLECTION_KEY = 'persons'

/** 印人提案 / 审核行本机集合键（真实键名 `xiai:v1:person-proposals`）。 */
const PERSON_PROPOSAL_COLLECTION_KEY = 'person-proposals'

/** 读正式印人行（云模式 ⇒ 云端快照；否则本机）。 */
export function listPersonRows() {
  return readCollection(PERSON_COLLECTION_KEY, [])
}

/** 写正式印人行（**仅采纳路径调用**；低层无直写入口）。 */
export function savePersonRows(rows) {
  return writeCollection(PERSON_COLLECTION_KEY, rows)
}

/** 读印人提案行。 */
export function listPersonProposalRows() {
  return readCollection(PERSON_PROPOSAL_COLLECTION_KEY, [])
}

/** 写印人提案行。 */
export function savePersonProposalRows(rows) {
  return writeCollection(PERSON_PROPOSAL_COLLECTION_KEY, rows)
}

/* ---------------------------------------------------------------------------
   **印人批 2 前置（v1.54｜§3.54.14 〜 §3.54.16 / §4.1.16）：外部批量导入行 ＋ 单写者门**
   ---------------------------------------------------------------------------
   · `xiai_person_imports` 的**本机镜像**（键 `person-imports`）：只经「外部批量导入」通道与
     采纳路径写 —— 低层读取 / 写入助手**仅供该通道调用**，**不开放任何直写入口**；
   · 幂等键 ＝ `source_person_id`（采纳落 `xiai_persons` 时按它幂等；重复采纳**不改写既有行**）；
   · **直写门**：任何绕过导入通道 / 采纳路径的直写（含**管理员直写**）一律
     `FORBIDDEN` ＋ **零写入**（沿 §3.54.3 / §3.54.16）。
   --------------------------------------------------------------------------- */

/** 外部导入行本机集合键（真实键名 `xiai:v1:person-imports`）。 */
const PERSON_IMPORT_COLLECTION_KEY = 'person-imports'

/** 读外部导入行（云模式 ⇒ 云端快照；否则本机）。 */
export function listPersonImportRows() {
  return readCollection(PERSON_IMPORT_COLLECTION_KEY, [])
}

/** 写外部导入行（**仅外部导入通道与采纳路径调用**；低层无直写入口）。 */
export function savePersonImportRows(rows) {
  return writeCollection(PERSON_IMPORT_COLLECTION_KEY, rows)
}

/**
 * **两集合的单写者面（硬要求｜§3.54.3 / §3.54.14 / §3.54.16）**：`xiai_persons` 与
 * `xiai_person_imports` **均只经采纳路径 / 外部导入通道写** —— **不开放任何直写入口**
 * （**含管理员直写**）。任何试图「直接写这两集合」的入口经本门 ⇒ `FORBIDDEN` ＋ **零写入**。
 * 返回值恒为 `null`（该键不属单写者集合，交由既有读写路径）或结构化拒绝对象。
 * @param {string} collectionKey 集合键（`persons` / `person-imports`）
 * @returns {null|{ok:false, reason:'FORBIDDEN', message:string}} 放行 ⇒ `null`
 */
export function personDirectWriteDenial(collectionKey) {
  const key = collectionKey === null || collectionKey === undefined ? '' : String(collectionKey).trim()
  if (key === PERSON_COLLECTION_KEY || key === PERSON_IMPORT_COLLECTION_KEY) {
    return {
      ok: false,
      reason: 'FORBIDDEN',
      message:
        `集合（${key}）為單寫者：只經採納路徑 / 外部導入通道寫，不開放任何直寫入口` +
        '（含管理員直寫）⇒ 已拒絕；本次零寫入。'
    }
  }
  return null
}

/** 按 `source_person_id` 取正式印人行（**采纳幂等键**；未命中 ⇒ `null`）。 */
export function personBySourceId(sourcePersonId) {
  const id = sourcePersonId === null || sourcePersonId === undefined ? '' : String(sourcePersonId).trim()
  if (!id) return null
  return (
    listPersonRows().find((row) => row && String(row.source_person_id || '') === id) || null
  )
}

/** 按 `source_person_id` 取导入行（幂等 / 去重用；未命中 ⇒ `null`）。 */
export function personImportBySourceId(sourcePersonId) {
  const id = sourcePersonId === null || sourcePersonId === undefined ? '' : String(sourcePersonId).trim()
  if (!id) return null
  return (
    listPersonImportRows().find((row) => row && String(row.source_person_id || '') === id) || null
  )
}

/* ---------------------------------------------------------------------------
   **印章批 3 前置（v1.55｜§3.55 ＋ §4.1.17）：印章外部批量導入行 ＋ 單寫者門**
   ---------------------------------------------------------------------------
   · `xiai_seal_imports` 的**本機鏡像**（鍵 `seal-imports`）：只經「外部批量導入」通道與
     管理員採納路徑寫 —— 低層讀取 / 寫入助手**僅供該通道調用**，**不開放任何直寫入口**；
   · 冪等鍵 ＝ `source` ＋ `source_seal_id`（採納落 `xiai_seals` 時按它冪等；
     重複採納**不改寫既有行**）；
   · **直寫門**：任何繞過導入通道 / 採納路徑的直寫（含**管理員直寫**）一律
     `FORBIDDEN` ＋ **零寫入**（沿 §3.55.4 / §3.55.5 / §3.55.10）。
   --------------------------------------------------------------------------- */

/** 印章外部導入行本機集合鍵（真實鍵名 `xiai:v1:seal-imports`）。 */
const SEAL_IMPORT_COLLECTION_KEY = 'seal-imports'

/** 讀印章外部導入行（云模式 ⇒ 云端快照；否則本機）。 */
export function listSealImportRows() {
  return readCollection(SEAL_IMPORT_COLLECTION_KEY, [])
}

/** 寫印章外部導入行（**僅外部導入通道與管理員採納路徑調用**；低層無直寫入口）。 */
export function saveSealImportRows(rows) {
  return writeCollection(SEAL_IMPORT_COLLECTION_KEY, rows)
}

/**
 * **印章導入集合的單寫者面（硬要求｜§3.55.4 / §3.55.5 / §3.55.10）**：`xiai_seal_imports`
 * **只經管理員採納路徑 / 外部導入通道寫** —— **不開放任何直寫入口**（**含管理員直寫**）。
 * 任何試圖「直接寫本集合」的入口經本門 ⇒ `FORBIDDEN` ＋ **零寫入**。
 * 返回值恆為 `null`（該鍵不屬單寫者集合，交由既有讀寫路徑）或結構化拒絕對象。
 * @param {string} collectionKey 集合鍵（`seal-imports`）
 * @returns {null|{ok:false, reason:'FORBIDDEN', message:string}} 放行 ⇒ `null`
 */
export function sealImportDirectWriteDenial(collectionKey) {
  const key = collectionKey === null || collectionKey === undefined ? '' : String(collectionKey).trim()
  if (key === SEAL_IMPORT_COLLECTION_KEY) {
    return {
      ok: false,
      reason: 'FORBIDDEN',
      message:
        `集合（${key}）為單寫者：只經管理員採納路徑 / 外部導入通道寫，不開放任何直寫入口` +
        '（含管理員直寫）⇒ 已拒絕；本次零寫入。'
    }
  }
  return null
}

/** 冪等鍵归一：`{ source, sourceSealId }`（`source` 可空，`source_seal_id` 必有）。 */
function sealSourceKeyOf(source, sourceSealId) {
  const s = source === null || source === undefined ? '' : String(source).trim()
  const sid = sourceSealId === null || sourceSealId === undefined ? '' : String(sourceSealId).trim()
  return { source: s, sourceSealId: sid }
}

/** 按 `source` ＋ `source_seal_id` 取導入行（幂等 / 去重用；未命中 ⇒ `null`）。 */
export function sealImportBySourceKey(source, sourceSealId) {
  const { source: s, sourceSealId: sid } = sealSourceKeyOf(source, sourceSealId)
  if (!sid) return null
  return (
    listSealImportRows().find(
      (row) =>
        row &&
        String(row.source_seal_id || '') === sid &&
        String(row.source || '') === s
    ) || null
  )
}

/** 按 `source` ＋ `source_seal_id` 取已採納的正式印章行（採納冪等鍵；未命中 ⇒ `null`）。 */
export function sealBySourceKey(source, sourceSealId) {
  const { source: s, sourceSealId: sid } = sealSourceKeyOf(source, sourceSealId)
  if (!sid) return null
  return (
    listSealRows().find(
      (row) =>
        row &&
        String(row.source_seal_id || '') === sid &&
        String(row.source || '') === s
    ) || null
  )
}

/**
 * **影像引用存在性讀面（§3.55.6｜复用既有影像讀面、不新增第二套讀法）**：
 * 在**既有** `images` 讀面（`listImageRows`，即 `xiai_images`）中按（摘要 / 內容尋址鍵）
 * 查引用對象；命中 ⇒ 回該行，否則 ⇒ `null`（缺引用 ⇒ 採納時該條拒絕 ＋ 零寫入）。
 * @param {{image_sha256?:string, image_storage_key?:string}} ref 影像引用（鍵 / 摘要）
 * @returns {object|null}
 */
export function imageRowByRef(ref) {
  const r = ref && typeof ref === 'object' ? ref : {}
  const sha = String(r.image_sha256 === undefined || r.image_sha256 === null ? '' : r.image_sha256).trim()
  const key = String(r.image_storage_key === undefined || r.image_storage_key === null ? '' : r.image_storage_key).trim()
  if (!sha && !key) return null
  return (
    listImageRows().find(
      (row) =>
        row &&
        ((sha && String(row.sha256 || '') === sha) || (key && String(row.storage_key || '') === key))
    ) || null
  )
}

/* **採納路徑複用既有 id 派生（既有實現，非第二套）**：印章編號（`XA` ＋ 9 位零填充）與
   印面編號（`<stampId>-<FACE|EDGE><序>`）的派生真源仍在下方既有函數（本處只把它們導出，
   **不另寫一份**）。 */
export { nextSealStampId, nextFaceId }

/** 取数组首非空文本（`字` / `号` 等数组的取首值口径）。 */
function firstTextOf(list) {
  if (!Array.isArray(list)) return ''
  const hit = list.find((item) => hasText(item))
  return hit ? String(hit) : ''
}

/**
 * **印人显示名派生（单点，冻结；§2「派生不落盘」）**：
 *   `family_name + given_name` → 缺则 `courtesy_names[0]`（字）→ 缺则 `art_names[0]`（号）→
 *   皆空 ⇒ `''`（上屏一律回「佚名」）。
 * **落第二份显示名 ⇒ 判负**：本函数是**唯一**派生点，**不得**在 persons 行或印章行落
 * 第二份显示名 / 引用副本。
 * @param {object|null} row 印人行
 * @returns {string} 派生显示名（皆空 ⇒ `''`）
 */
export function personDisplayName(row) {
  if (!row || typeof row !== 'object') return ''
  const family = hasText(row.family_name) ? String(row.family_name) : ''
  const given = hasText(row.given_name) ? String(row.given_name) : ''
  const full = `${family}${given}`
  if (full) return full
  const courtesy = firstTextOf(row.courtesy_names)
  if (courtesy) return courtesy
  return firstTextOf(row.art_names)
}

/** 按 `id`（或 `code`）取正式印人行（未命中 ⇒ `null`）。 */
export function personById(personId) {
  const id = personId === null || personId === undefined ? '' : String(personId).trim()
  if (!id) return null
  return (
    listPersonRows().find(
      (row) => row && (String(row.id || '') === id || String(row.code || '') === id)
    ) || null
  )
}

/** 该 id 是否指向库中既有正式印人（**引用值域门**用；纯读）。 */
export function personExistsById(personId) {
  return personById(personId) !== null
}

/**
 * **作者引用值域门（§4.1｜写前判定 ＋ 零写入）**：非空引用必须指向库中**既有**正式印人。
 * 空值 ⇒ 合法（作者**选填**）。reason 取**既有冻结字面值**（`NOT_FOUND`）——**不新增任何
 * reason 字面值**（沿 §3.12.10 / §3.25.10 冻结表）。
 * @returns {null|{ok:false, reason:'NOT_FOUND', message:string}} 放行 ⇒ `null`
 */
export function personReferenceDenial(personId) {
  const id = personId === null || personId === undefined ? '' : String(personId).trim()
  if (!id) return null
  if (personExistsById(id)) return null
  return {
    ok: false,
    reason: 'NOT_FOUND',
    message:
      `作者所引用的印人（${id}）在庫中不存在 ⇒ 已拒絕寫入；` +
      '請改選既有印人，或先提交印人提案、經管理員審覈通過後再選。'
  }
}

/**
 * **作者显示名解析（§4.1｜单点，冻结）**：
 *   `author_person_id` → **命中**（印人存在且有派生显示名）⇒ `xiai_persons.display_name` →
 *   **未命中** ⇒ 旧 `author` 自由文本 → 皆空 ⇒「佚名」。
 * **解析恰一处、零第二套名表**；卡片 / 详情 / 导出（`sealExport.js`）/ 文本导出（`utils/file.js`）
 * **一律经本函数**取名，**不得各自再实现一套**。
 * @param {object|null} row 印面行 / 印章行（带可空 `author_person_id` 与历史 `author` 文本）
 * @returns {string} 印人显示名 / 旧作者文本 /「佚名」
 */
export function resolveAuthorName(row) {
  const pid = row ? row.author_person_id : ''
  const id = pid === null || pid === undefined ? '' : String(pid).trim()
  if (id) {
    const person = personById(id)
    const derived = person ? personDisplayName(person) : ''
    if (derived) return derived
  }
  const legacy = row ? row.author : ''
  return hasText(legacy) ? String(legacy) : '佚名'
}

/** 由既有印人行派生**下一个印人编号**：`PR` ＋ 9 位零填充（跳过已占用；只认 `^PR\d{9}$`）。 */
export function nextPersonCode(rows) {
  const list = Array.isArray(rows) ? rows : []
  let max = 0
  list.forEach((row) => {
    const matched = /^PR(\d{9})$/.exec(String((row && row.code) || ''))
    if (matched) max = Math.max(max, Number(matched[1]))
  })
  const taken = new Set(list.map((row) => String((row && row.code) || '')))
  let index = max + 1
  while (taken.has(formatPersonCode(index))) index += 1
  return formatPersonCode(index)
}

export function listPhotoRows() {
  return readCollection(STORAGE_KEYS.photos, [])
}

export function savePhotoRows(rows) {
  return writeCollection(STORAGE_KEYS.photos, rows)
}

/**
 * 读积分流水。
 *
 * **幂等比较的兼容判定（本单）**：`services/points.js` 的 `awardCorrectionReward` 用
 * `row.type === LEDGER_TYPE.CORRECTION_REWARD` 判「该勘误的奖励此前是否已发放」——
 * 该比较处**不在本单可改范围**（`services/**` 冻结），故这里在**数据层读路径**补一道
 * **兼容归一**：把历史行的旧 `type`（如 `勘误奖励`）按**同一张显式映射表**归一到现行值
 * （`勘誤獎勵`）并回写。
 *
 * 与既有的 `listCorrectionRows()` 把旧状态字面值 `APPROVED` 归一为 `ACCEPTED` 是**同一套做法**。
 * 两侧一致由此**两处**共同保证：① 迁移（`migrateTraditionalData`，版本 2）会把历史行一次性归一；
 * ② 万一迁移被跳过（记账被手改、或将来新增读取路径），读路径仍归一到同一值。
 * 归一用的表就是迁移那张（`SOURCE_TEXT_MAPS.point.type`）⇒ 只有一处值、不会漂移。
 */
export function listPointRows() {
  const rows = readCollection(STORAGE_KEYS.points, [])
  let changed = false
  const next = rows.map((row) => {
    if (!row || typeof row !== 'object') return row
    if (!hasText(row.type)) return row
    const before = String(row.type)
    const mapped = mapSourceText('point', 'type', before)
    if (mapped.state !== 'mapped') return row
    changed = true
    return { ...row, type: mapped.to, type_migrated_from: before }
  })
  if (changed) writeCollection(STORAGE_KEYS.points, next)
  return next
}

export function savePointRows(rows) {
  return writeCollection(STORAGE_KEYS.points, rows)
}

export function listDownloadRows() {
  return readCollection(STORAGE_KEYS.downloaded, [])
}

export function saveDownloadRows(rows) {
  return writeCollection(STORAGE_KEYS.downloaded, rows)
}

/* --------------------------- 数据层权限拒绝 --------------------------- */

export class PermissionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PermissionError'
  }
}

/**
 * 越权写的**数据层结构化拒绝**（§3.12.10(c)：`FORBIDDEN` 为数据层与服务层**同字面值**）。
 *
 * 为什么不再抛 `PermissionError`（2026-09-20 修｜质检 N-1 / AC-30）：AC-30 / §3.12.10(e)⑥ 的判负
 * 形态是「**拒绝路径抛未捕获异常（非结构化拒绝）**」。越权是**业务上的合法拒绝**（调用方据此渲染
 * 可读提示），不是程序错误 ⇒ 一律返回 `{ok:false, reason:'FORBIDDEN', message}`，零写入。
 * `PermissionError` 类**保留导出**（服务层既有导入方与自检仍 import，不删）。
 * @returns {null|{ok:false, reason:'FORBIDDEN', message:string}} 管理员 ⇒ `null`（放行）
 */
function forbiddenFor(actor, message) {
  if (actor && actor.role === 'admin') return null
  return { ok: false, reason: 'FORBIDDEN', message }
}

/**
 * 影像 reason 的**显式透传**（数据层｜2026-09-20 收口；依据规范 v1.6 `M-6`）。
 *
 * 上游 `normalizeImagePayload` 在部分形态下（载荷缺失 / 非 dataURL 字符串 / 空字节）只给 `message`
 * 而**不给 `reason`** ⇒ 此处**显式**回落到 §3.12.10(c) 冻结表**数据层**字面值 `UNRECOGNIZED_IMAGE`
 * （即表下注（v1.6 追加）② 的「正确形态：缺失时按本表回落」）。
 *
 * 为什么不再用「上游 `reason` ‖ 兜底默认值」的写法（2026-09-20 收口｜规范 v1.6 `M-6`）：那个兜底字面值已
 * **裁定退役**（与 `UNRECOGNIZED_IMAGE` / `NOT_IMAGE` 语义完全重叠 ＝ 同义异名，属 (c) 表冻结纪律所禁）
 * ——它**不得再作任何层的对外 reason**，**也不得再作 reason 透传的兜底默认值**。
 * 透传改写一律走本函数 ⇒ **显式且可审计**（(c) 表冻结纪律）。
 * @param {{reason?:string}} image 上游解析结果
 * @returns {string} 上游给出的 reason；缺失时回落数据层冻结值 `UNRECOGNIZED_IMAGE`
 */
function imageReasonOf(image) {
  return image && image.reason ? image.reason : 'UNRECOGNIZED_IMAGE'
}

/**
 * 写入口的**字段白名单校验**（＝ §3.12.10 表下注（v1.6 追加）① 冻结的 `INVALID_FIELD`）。
 *
 * 为何用 `INVALID_FIELD` 而不套用既有值（2026-09-20 收口｜规范 v1.6 `M-5`）：`UNRECOGNIZED_IMAGE`
 * 判的是「字节魔数认不出」（内容面）、`MISSING_REQUIRED` 判的是「该给的没给」（必填面），而本条判的是
 * 「**多给了不该给的键**」（字段面）⇒ 三者语义互不覆盖；规范明文该字面值**数据层与对外面同值**
 * （该类拒绝无跨层语义差）。同义异名（`BAD_FIELD` / `UNKNOWN_FIELD` 之流）即判负。
 *
 * 形态纪律（同上注）：**结构化拒绝、不得抛未捕获异常、不得静默、拒绝时零写入**。
 *
 * **R-49（2026-09-20｜低层写入口的两道门）**：上面这条「多给了不该给的键」之门，自本裁定起
 * **不限于固定属性入口** —— **凡低层写入口（实体级单表写）都要过它**，且在第 2 条「值域门」
 * 之前、在**任何写入之前**判定：**拒绝 ⇒ 整个调用零写入（不得部分写入）**；一经发现即
 * **一律不得静默丢弃键**（既不拒、又不落库＝禁止形态）。故本函数被提取为**通用键白名单门**，
 * 由各实体入口各传自己的键面（`scopeLabel` 用于拼出与既有句式一致的文案）：
 *   - 印章实体 ⇒ `SEAL_INSERT_INPUT_FIELDS`（`insertSealRow`）；
 *   - 印面实体 ⇒ `FACE_INSERT_INPUT_FIELDS`（`insertFaceRow`）；
 *   - 影像实体 ⇒ `IMAGE_INSERT_INPUT_FIELDS`（`insertImageRow`）；
 *   - 组合入口 ⇒ `SEAL_COMPOSITE_INPUT_FIELDS`（`createSealWithFaceRows`）；
 *   - 固定属性 ⇒ 既有 `FIXED_ATTR_FIELDS` / `SEAL_FIXED_ATTR_FIELDS`（两套互不覆盖，R-23）。
 * @param {object} patch 待写入的字段集合
 * @param {string[]} allowed 白名单（＝**该入口真正会写的键**；能收下却不写的键**不得**留在白名单里）
 * @returns {null|{ok:false, reason:'INVALID_FIELD', message:string}} 合法 ⇒ `null`（放行）
 */
function assertKnownKeys(patch, allowed, scopeLabel) {
  const unknown = Object.keys(patch || {}).filter((key) => !allowed.includes(key))
  if (unknown.length === 0) return null
  return {
    ok: false,
    reason: 'INVALID_FIELD',
    message: `${scopeLabel}之外的字段不可通過此入口寫入：${unknown.join('、')}`
  }
}

/**
 * 印面级 / 印章级**固定属性**的字段白名单门（**R-23 / R-32**：两套白名单互不覆盖）。
 * 实现与句式**同源** `assertKnownKeys`（R-25：同一语义不得多处各自实现）。
 * @returns {null|{ok:false, reason:'INVALID_FIELD', message:string}} 合法 ⇒ `null`（放行）
 */
function assertKnownFields(patch, allowed = FIXED_ATTR_FIELDS) {
  return assertKnownKeys(patch, allowed, '固定屬性')
}

/**
 * **朝代值域门**（R-20 / R-24 冻结字面值 `INVALID_VALUE`）：凡**写入** `dynasty` 的行都要过这道门。
 *
 * 语义边界（与另两个 reason 互不覆盖）：
 *   - 空值**不走本门**（「该给的没给」由 `MISSING_REQUIRED` 判，必填门在前）；
 *   - 非空且 ∉ 15 类 ⇒ `{ok:false, reason:'INVALID_VALUE'}` + **零写入** + 可读文案。
 *
 * **R-21 边界（务必遵守）**：本门只拦**写入**。**读路径、迁移、归一一律不调本门**，
 * 既有行的 `dynasty` **保留原样**（不映射、不归一、不重写）——否则旧值 `漢` / `戰國` / `明` /
 * `清` / `近現代` 会因新值域而读不出来（那等于编造 / 丢数据）。
 * @returns {null|{ok:false, reason:'INVALID_VALUE', message:string}} 放行 ⇒ `null`
 */
function dynastyValueDenial(value) {
  const text = value === null || value === undefined ? '' : String(value).trim()
  if (!text || isKnownDynasty(text)) return null
  return {
    ok: false,
    reason: 'INVALID_VALUE',
    message:
      `朝代「${text}」不在允許的 ${DYNASTY_OPTIONS.length} 類之內（${DYNASTY_OPTIONS.join('、')}），已拒絕寫入；` +
      '既有行的舊值保留原樣、不受影響。'
  }
}

/**
 * **印面内容值域门（R-30 / R-24 冻结字面值 `INVALID_VALUE`）**：凡**新写入**的
 * `seal_type`（印面内容）都必须 `∈` `FACE_CONTENT_OPTIONS`（9 值，真源＝`seed.js`）。
 *
 * 边界与朝代门同一套纪律：
 *   - 空值**不走本门**（「该给的没给」由 `MISSING_REQUIRED` 判，必填门在前）；
 *   - **只拦显式传入的值 / 采纳写回的值**：从既有印章行**继承**下来的旧值**原样照抄**
 *     （R-21 同款：旧值不改写，也不得因新值域而挡住「给旧印章加印面」）；
 *   - **读路径、迁移、归一一律不调本门**（旧值 `吉語印` / `鑒藏印` / `閒章` 照读不误）。
 * @returns {null|{ok:false, reason:'INVALID_VALUE', message:string}} 放行 ⇒ `null`
 */
function faceContentValueDenial(value) {
  const text = value === null || value === undefined ? '' : String(value).trim()
  if (!text || isKnownFaceContent(text)) return null
  return {
    ok: false,
    reason: 'INVALID_VALUE',
    message:
      `印面內容「${text}」不在允許的 ${FACE_CONTENT_OPTIONS.length} 類之內（${FACE_CONTENT_OPTIONS.join('、')}），已拒絕寫入；` +
      '既有行的舊值保留原樣、不受影響。'
  }
}

/**
 * **印面风格值域门（R-31 / R-24 冻结字面值 `INVALID_VALUE`）**：凡**新写入**的
 * `face_style` 都必须 `∈` `FACE_STYLE_OPTIONS`（23 值，真源＝`seed.js`）。
 * 空值不走本门（未填＝合法）；旧行无该字段 ⇒ 读值空串，不受影响。
 * @returns {null|{ok:false, reason:'INVALID_VALUE', message:string}} 放行 ⇒ `null`
 */
function faceStyleValueDenial(value) {
  const text = value === null || value === undefined ? '' : String(value).trim()
  if (!text || isKnownFaceStyle(text)) return null
  return {
    ok: false,
    reason: 'INVALID_VALUE',
    message:
      `印面風格「${text}」不在允許的 ${FACE_STYLE_OPTIONS.length} 類之內（${FACE_STYLE_OPTIONS.join('、')}），已拒絕寫入；` +
      '既有行的舊值保留原樣、不受影響。'
  }
}

/**
 * **印章大類值域门（3 值｜冻结字面值 `INVALID_VALUE`）**：凡**新写入**的
 * `seal_class` 都必须 `∈` `SEAL_CLASS_OPTIONS`（3 值，真源＝`seed.js`）。
 *
 * 口径与 `faceStyleValueDenial` 同一套纪律：
 *   - 空值不走本门（未填＝合法、落空串）；
 *   - 只拦**显式传入**的值（不采信任何回落；旧行无该键 ⇒ 读值空串，不受影响）；
 *   - **读路径、迁移、归一一律不调本门**。
 * @returns {null|{ok:false, reason:'INVALID_VALUE', message:string}} 放行 ⇒ `null`
 */
function sealClassValueDenial(value) {
  const text = value === null || value === undefined ? '' : String(value).trim()
  if (!text || isKnownSealClass(text)) return null
  return {
    ok: false,
    reason: 'INVALID_VALUE',
    message:
      `大類「${text}」不在允許的 ${SEAL_CLASS_OPTIONS.length} 類之內（${SEAL_CLASS_OPTIONS.join('、')}），已拒絕寫入；` +
      '既有行的舊值保留原樣、不受影響。'
  }
}

/**
 * 形制归一：**自由文本**，只做首尾去空白（**与「材质」同待遇**，不枚举、不查词表）。
 * 空值 / `null` ⇒ 空串（＝未设置；**不回落任何默认文字**）。
 */
function normalizeShape(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

/**
 * 材质归一（**R-32 起属印章级**）：口径与 `normalizeShape` **同一套** —— 自由文本、
 * 只去首尾空白、**不枚举、不查词表**（与旧印面级实现一字不差 ⇒ 既有值形态不变）；
 * 空值 / `null` ⇒ 空串（＝未设置，**不回落任何默认文字**）。
 */
function normalizeMaterial(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}


function normalizeEdgeIds(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value.split(/[、,，\s]+/).map((item) => item.trim()).filter(Boolean)
  }
  return []
}

export function writeFaceFixedAttributes(actor, faceId, patch) {
  const denied = forbiddenFor(actor, '僅管理員可以修改印面的固定屬性')
  if (denied) return denied
  /* 字段白名单不通过 ⇒ **结构化拒绝**（`INVALID_FIELD`），零写入、不抛错。 */
  const invalid = assertKnownFields(patch)
  if (invalid) return invalid
  const rows = readFaceCollection()
  const target = rows.find((row) => row.id === faceId)
  if (!target) throw new Error(`未找到該印面：${faceId}`)
  const clean = { ...patch }
  if ('edge_image_ids' in clean) clean.edge_image_ids = normalizeEdgeIds(clean.edge_image_ids)
  const next = rows.map((row) =>
    row.id === faceId
      ? { ...row, ...clean, stamp_id: row.sealId, updated_at: new Date().toISOString() }
      : row
  )
  saveFaceRows(next)
  return next.find((row) => row.id === faceId)
}

/**
 * 兼容入口：旧调用方按**印章编号**定位固定属性并一次提交。
 * 按印面归属拆分落库：`face_image_id` → 该印章的主印面（`kind = FACE`）；
 * `edge_image_ids` → 该印章的边款印面（`kind = EDGE`，缺失时退回主印面）；
 * **R-32 起 `material` 不再接受**（已不在印面级白名单内 ⇒ `INVALID_FIELD`）：材质是
 * **印章级**固定属性，请走 `writeSealFixedAttributes(actor, stampId, { material })`。
 * 单印面逐个编辑请用 `writeFaceFixedAttributes`。
 * @returns 更新后的主印面行（带 `stamp_id` 兼容别名）。
 */
export function writeFixedAttributes(actor, stampId, patch) {
  const denied = forbiddenFor(actor, '僅管理員可以修改印面的固定屬性')
  if (denied) return denied
  /* 先做整份 patch 的白名单校验：不通过 ⇒ **结构化拒绝**（`INVALID_FIELD`），零写入、不抛错。 */
  const invalid = assertKnownFields(patch)
  if (invalid) return invalid
  const rows = readFaceCollection()
  /* 主印面行选择**收敛到 `primaryFaceIn`（R-44）**：范围仍按 `sealId` 限定（与改前同谓词）。 */
  const face = primaryFaceIn(rows.filter((row) => row.sealId === stampId))
  if (!face) throw new Error(`未找到該印章的主印面：${stampId}`)
  const edge = rows.find((row) => row.sealId === stampId && row.kind === FACE_KIND.EDGE)
  /* 只有 `edge_image_ids` 归边款面；其余（`face_image_id` 一类）都落主印面。 */
  const { edge_image_ids: edgeIds, ...facePatch } = patch || {}
  if (Object.keys(facePatch).length > 0) writeFaceFixedAttributes(actor, face.id, facePatch)
  if (edgeIds !== undefined) {
    writeFaceFixedAttributes(actor, (edge || face).id, { edge_image_ids: edgeIds })
  }
  return listFaceRows().find((row) => row.id === face.id)
}

/* ----------------------------------------------------------------------------
   印章级固定属性（R-22 / R-23 / **R-32**）
   ----------------------------------------------------------------------------
   与上面**印面级**的 `writeFaceFixedAttributes` / `writeFixedAttributes` 并列，**互不覆盖**：
   形制与材质是「**整枚印章一个**」的属性，写在**印章行**上；印面级入口的白名单里没有 `shape`，
   `['shape','material']`（塞 `dynasty` / `seal_type` 等 ⇒ `INVALID_FIELD`）。
   ---------------------------------------------------------------------------- */

/**
 * 写入**印章级**固定属性（canonical 入口，按印章归属）。白名单 `['shape','material']`
 * （形制 R-22/R-23；**材质 R-32 自印面级移入本层**）。
 *
 * 权限：**仅管理员可改**——数据层硬拦截（不依赖 UI 隐藏入口），非管理员一律**结构化拒绝**
 * `{ok:false, reason:'FORBIDDEN'}` 且**零写入**。
 *
 * 拒绝形态（一律结构化、零写入、**不抛未捕获异常**，§3.12.10 表下注 ④）：
 *   非管理员 ⇒ `FORBIDDEN`；多给了不该给的键（如 `dynasty` / `seal_type` / `face_style`）
 *   ⇒ `INVALID_FIELD`；没给印章编号 ⇒ `MISSING_REQUIRED`；印章不存在 ⇒ `NOT_FOUND`。
 *
 * 口径：`shape` / `material` ＝**自由文本**（不强制枚举、不查词表），**首尾去空白**，
 * 允许空串（＝清空 / 未设置，**不回落任何默认文字**）；两者都不参与广场筛选。
 *
 * ⚠️ **旧值不改写（R-32）**：本入口**只写传入的键**，既不把印面行上的旧 `material`
 * 搬过来、也不清空它（移级＝移动真源与白名单，**不是**数据搬迁）。读路径的回落见
 * `sealMaterialValue`（印章行空 ⇒ 回落主印面旧值）。
 *
 * @param {object|null} actor 操作者（须为管理员）
 * @param {string} stampId 目标印章编号（`stamp_id` / `id` 同值）
 * @param {{shape?:string, material?:string}} patch 印章级固定属性（白名单 `SEAL_FIXED_ATTR_FIELDS`）
 * @returns {{ok:true, stampId:string, seal:object, shape:string, material:string, message:string}
 *   |{ok:false, reason:string, missing?:string[], message:string}}
 *   成功时 `seal` 为**落盘后的印章行**（`shape` / `material` 为写入后的现值）。
 */
export function writeSealFixedAttributes(actor, stampId, patch) {
  const denied = forbiddenFor(actor, '僅管理員可以修改印章的固定屬性（形制 / 材質）')
  if (denied) return denied
  /* 印章级白名单：不通过 ⇒ 结构化拒绝（`INVALID_FIELD`），零写入、不抛错。 */
  const invalid = assertKnownFields(patch, SEAL_FIXED_ATTR_FIELDS)
  if (invalid) return invalid
  const id = String(stampId || '').trim()
  if (!id) {
    return {
      ok: false,
      reason: 'MISSING_REQUIRED',
      missing: ['印章編號'],
      message: '請給出要修改的印章編號（patch 裏帶 stampId），本次未寫入任何內容'
    }
  }
  const rows = listSealRows()
  const index = rows.findIndex((row) => String((row && (row.stamp_id || row.id)) || '') === id)
  if (index < 0) return { ok: false, reason: 'NOT_FOUND', message: `未找到該印章：${id}` }

  const clean = {}
  if (Object.prototype.hasOwnProperty.call(patch || {}, SEAL_SHAPE_FIELD)) {
    clean[SEAL_SHAPE_FIELD] = normalizeShape(patch[SEAL_SHAPE_FIELD])
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, SEAL_MATERIAL_FIELD)) {
    clean[SEAL_MATERIAL_FIELD] = normalizeMaterial(patch[SEAL_MATERIAL_FIELD])
  }
  const readBack = (row) => ({
    shape: typeof row.shape === 'string' ? row.shape : '',
    material: typeof row.material === 'string' ? row.material : ''
  })
  /* 空 patch ⇒ 无字段可写：**不落盘**（零写入），如实回报当前值。 */
  if (Object.keys(clean).length === 0) {
    const current = rows[index]
    return {
      ok: true,
      stampId: String(current.stamp_id || current.id || id),
      seal: current,
      ...readBack(current),
      message: '本次未提交任何字段，印章固定屬性未變更'
    }
  }
  const next = rows.map((row, i) =>
    i === index ? { ...row, ...clean, updated_at: nowIso() } : row
  )
  saveSealRows(next)
  const updated = next[index]
  return {
    ok: true,
    stampId: String(updated.stamp_id || updated.id || id),
    seal: updated,
    ...readBack(updated),
    message: '印章固定屬性已保存'
  }
}

/* ============================================================================
   影像二进制（**数据层唯一出口**）
   ----------------------------------------------------------------------------
   分层纪律（§3.2 收口注 ① / §4.1.3 表下注）：**只有数据层碰浏览器存储**（含 IndexedDB）。
   二进制的唯一入口在本节；服务层只能调这里的导出，**不得**直接 import `./blobstore.js`。
   所有失败一律返回可读结果，**绝不向上抛未捕获异常**。
   ============================================================================ */

/** 影像二进制键口径（＝`asset:<影像 id>`，与 §4.1.3 的 `asset.id` 一一对应）。 */
export function imageBinaryKey(assetId) {
  return assetBlobKey(assetId)
}

export async function putImageBinary(assetId, data) {
  return putBlob(assetBlobKey(assetId), data)
}

export async function getImageBinary(assetId) {
  return getBlob(assetBlobKey(assetId))
}

export async function hasImageBinary(assetId) {
  return hasBlob(assetBlobKey(assetId))
}

export async function deleteImageBinary(assetId) {
  return deleteBlob(assetBlobKey(assetId))
}

/** 自测 / 排障：枚举影像库键（只读，不改数据）。 */
export async function listImageBinaryKeys() {
  return listBlobKeys()
}

/** 自测 / 排障：上报影像库可用性与库名（只读）。 */
export function imageStoreInfo() {
  return blobstoreInfo()
}

/**
 * 二进制 → dataURL。**仅供运行时渲染**（落盘一律走二进制，见 §4.1.3 表下注）。
 *
 * **字段语义（K-P4aF2 收口，2026-09-23）**：`bytes` ＝ **真实字节**（`Uint8Array`，与
 * `blobstore.getBlob()` 的 `bytes` 同物同义）；**长度只有一个出口** `bytesLength`（`number`）。
 * 修前此处把 `out.bytesLength`（一个 Number）交到 `bytes` 上，下游
 * `services/displayImage.js::transcodeStoredToDisplay` 的 `new Uint8Array(bytes || [])`
 * 会照该数字分配**等长全零缓冲** ⇒ 服务端 415 `NOT_IMAGE` ⇒ 凡存储件为 TIFF 的影像
 * （＝所有新上传印面）一律显示不出来。**不得**再把长度放进 `bytes`。
 */
export async function readImageDataUrl(assetId) {
  const out = await getImageBinary(assetId)
  if (!out.ok) return out
  return {
    ok: true,
    dataUrl: bytesToDataUrl(out.bytes, out.mime),
    bytes: out.bytes,
    bytesLength: out.bytesLength
  }
}

/* ----------------------------------------------------------------------------
   实物照片二进制（**只增不改**：与「印面 / 边款影像」同一套底座与同一个库，
   只是键前缀换成 `photo:`；上列 `*ImageBinary` 一族的行为与键口径一字未动）。
   ----------------------------------------------------------------------------
   为什么实物照片也必须走这里：AC-33 的唯一不通过项就是「整张照片 dataURL 直存
   `localStorage`」（`xiai:v1:photos` 单值 200.99 KiB ≥ 64 KiB 判负）。改为
   ---------------------------------------------------------------------------- */

/** 实物照片二进制键口径（＝`photo:<照片 id>`）。 */
export function photoBinaryKey(photoId) {
  return photoBlobKey(photoId)
}

export async function putPhotoBinary(photoId, data) {
  return putBlob(photoBlobKey(photoId), data)
}

export async function getPhotoBinary(photoId) {
  return getBlob(photoBlobKey(photoId))
}

export async function hasPhotoBinary(photoId) {
  return hasBlob(photoBlobKey(photoId))
}

export async function deletePhotoBinary(photoId) {
  return deleteBlob(photoBlobKey(photoId))
}

/**
 * 取回实物照片二进制并转 dataURL（**仅供运行时渲染**，落盘一律走二进制）。
 * `mime` 由调用方从**元数据行**传入（库里只存字节，不猜格式）。
 * 字段语义与 `readImageDataUrl` 一致（K-P4aF2）：`bytes` ＝ **真实字节**（`Uint8Array`）、
 * `bytesLength` ＝ **字节数**（`number`）。
 * @returns {Promise<{ok:boolean, dataUrl?:string, bytes?:Uint8Array, bytesLength?:number, mime?:string, message?:string}>}
 */
export async function readPhotoDataUrl(photoId, mime = '') {
  const out = await getPhotoBinary(photoId)
  if (!out.ok) return out
  /* **不伪造 mime**：元数据行 / Blob 都给不出 mime 时不再回落 `'image/webp'`（那是「认不出也冒充」
     的同类写法）；交给 `bytesToDataUrl` **按字节魔数如实得出**，认不出就是
     `application/octet-stream`（如实说明「不是已知图片」），绝不假装成某种图片格式。 */
  const claimed = String(mime || '').trim() || String(out.mime || '').trim()
  const dataUrl = bytesToDataUrl(out.bytes, claimed)
  /* 回报的 `mime` 与 dataURL 前缀**同源**（都出自 `bytesToDataUrl`），不另立第二套回落值。 */
  const actual = dataUrl.slice(5, dataUrl.indexOf(';'))
  return { ok: true, dataUrl, bytes: out.bytes, bytesLength: out.bytesLength, mime: actual }
}

/** 自测 / 排障：枚举实物照片二进制键（只读，不改数据）。 */
export async function listPhotoBinaryKeys() {
  const keys = await listBlobKeys()
  return keys.filter((key) => key.startsWith('photo:'))
}

/**
 * **旧行迁移专用的 mime 判定 —— 逐字保留「写入口径收紧前」的行为，不得随之一起改。**
 *
 * 为什么必须单独留一份（而不是直接改用 `sniffMime`）：迁移的**可观测行为**
 * （`migrated` / `total` / `leftovers` 计数、读回的 `mime`、幂等性）是本单硬约束。
 * 收紧前的 `sniffMime` 与新的 `sniffMime` 对**历史行**的判定会在两处不同：
 *   ① 认不出时：旧 `'image/png'` vs 新 `''`（垃圾字节的历史行读回值会变）；
 *   ② WebP 判定：旧只要求 `RIFF` + `[8] === 'W'`（`RIFF....WAVE` 会命中）vs 新要求
 *      `RIFF....WEBP` 四字节全中（`WAVE` 判为认不出）。
 * 历史行的二进制**早已在库**，把它们的 mime 判定「事后改口径」既拦不住新脏数据、
 * 又会改变读回值与迁移计数 ⇒ 无收益、有回归。**新写入**一律走
 * `normalizeImagePayload` 的字节魔数硬校验（认不出即拒，见 `assetmeta.js`）。
 */
function legacyMigrateMime(bytes) {
  const v = toUint8Array(bytes)
  if (v.length >= 8 && v[0] === 0x89 && v[1] === 0x50 && v[2] === 0x4e && v[3] === 0x47) return 'image/png'
  if (v.length >= 3 && v[0] === 0xff && v[1] === 0xd8 && v[2] === 0xff) return 'image/jpeg'
  if (v.length >= 6 && v[0] === 0x47 && v[1] === 0x49 && v[2] === 0x46) return 'image/gif'
  if (v.length >= 12 && v[0] === 0x52 && v[1] === 0x49 && v[2] === 0x46 && v[3] === 0x46 && v[8] === 0x57) return 'image/webp'
  return 'image/png'
}

/**
 * **老库就地纠正（AC-33 收口）**：把旧实现写下的「整张 dataURL 直存 `localStorage`」行迁到分层存储。
 *
 * 为什么必须做：AC-33 的判定方式之一是「全量枚举 `localStorage`，检索 value 是否含
 * `data:image/...;base64,`」。**旧库里的历史行不会因为新代码不再这么写而消失**——
 * 不迁移，则「老库」在质检里仍然判负（且画廊渲染拿到的是没有二进制的死行）。
 *
 * 口径（与「管理员手机号老库就地纠正」同一套纪律）：
 *   - **不删行、不清库、不动命名空间版本**（避免丢用户数据）；
 *   - 逐行把 `image`（dataURL）解码成字节 → 写入 IndexedDB（键 `photo:<照片 id>`）→
 *     行内改为**只留元数据**（`mime` / `width` / `height` / `bytes` / `sha256` / `storage` / `storage_key`），
 *     并留 `migrated_at` 时间戳与来源标记；
 *   - 解不开的 dataURL：**仍把 `image` 从行里摘掉**（它正是 AC-33 判负源）并留
 *     `migrated_note` 如实记明，**不静默装作成功**；
 *   - 二进制写入失败 ⇒ **保留原行不动**（宁可留旧行，也不丢照片），如实回报条数；
 *   - **幂等**：迁移后再跑不产生任何写入；
 *   - **mime 判定保持收紧前口径**（`legacyMigrateMime(bytes)`，见上函数注释）：
 *     本单只收紧**新写入**的写入口径，不动历史行的判定；
 *   - **`bytes` / `width` / `height` / `sha256` / `mime` 一律以二进制真值回填**（AC-43⑥，见下方循环内注释）：
 *     旧行自带值与真值不一致时以真值覆盖，其余字段不动 ⇒ 计数 / 幂等逐字不变。
 * @returns {Promise<{ok:boolean, migrated:number, total:number, leftovers:number, message:string}>}
 */
export async function migrateLegacyPhotoRows() {
  const rows = listPhotoRows()
  const next = []
  let migrated = 0
  let leftovers = 0

  for (const row of rows) {
    const legacy = row && typeof row.image === 'string' && row.image.startsWith('data:image')
    if (!legacy) {
      next.push(row)
      continue
    }
    const parsed = dataUrlToBytes(row.image)
    const { image, ...rest } = row
    if (!parsed.ok) {
      /* 解不开：摘掉 dataURL（判负源），如实留痕。 */
      next.push({ ...rest, migrated_at: new Date().toISOString(), migrated_note: `舊數據地址無法解析：${parsed.message}` })
      migrated += 1
      leftovers += 1
      continue
    }
    const stored = await putPhotoBinary(row.id, parsed.bytes)
    if (!stored.ok) {
      /* 写库失败：**保留原行**（不丢照片），由调用方决定是否重试。 */
      next.push(row)
      leftovers += 1
      continue
    }
    const size = imageSize(parsed.bytes)
    /* **以二进制真值为准回填**（2026-09-20 修｜质检 N-4 / AC-43⑥）：
       旧行自带的 `bytes` / `width` / `height` / `mime` / `sha256` 与二进制解析结果不一致时，
       `ph-legacy-3` 旧行自带 `bytes:1234` 而二进制实为 10,349 B，被 AC-43⑥
       「读回的 mime / bytes / sha256 与元数据不一致」判负）。
       纪律：**只覆盖这五个由二进制派生的字段**；`rest`（`note` / `user_id` / `created_at` / …）一律不动；
       `mime` 沿用**迁移专用**标签回落函数 `legacyMigrateMime`（§3.12.10(d) 历史行豁免口径未变）。 */
    next.push({
      ...rest,
      mime: legacyMigrateMime(parsed.bytes),
      width: size.width,
      height: size.height,
      bytes: parsed.bytes.length,
      sha256: sha256Hex(parsed.bytes),
      storage: 'indexeddb',
      storage_key: photoBinaryKey(row.id),
      migrated_at: new Date().toISOString(),
      migrated_from: 'localStorage:dataUrl'
    })
    migrated += 1
  }

  if (migrated > 0) savePhotoRows(next)
  return {
    ok: true,
    migrated,
    total: rows.length,
    leftovers,
    message:
      migrated > 0
        ? `已把 ${migrated} 條舊格式實物照片（整張 dataURL 直存 localStorage）遷入本地影像庫，localStorage 只留元數據`
        : '無需遷移：實物照片已全部爲「元數據 + 二進制分層」形態'
  }
}

/* ============================================================================
   上传印章（能力 6）：canonical 必填校验 + 防重 + `source` / `uploaded_by` /
   `created_at` 落位 + **五类写的权限拒绝**
   ----------------------------------------------------------------------------
   权限口径（§3.7 / §6.1 第 6 行，与第 5 行同规格）：**仅管理员**；游客与普通用户
   直调数据层写方法一律得到**结构化拒绝** `{ok:false, reason:'FORBIDDEN', message}`（**零写入**，
   不再是抛 `PermissionError` —— 见 `forbiddenFor` 的注释与 §3.12.10(c)/(e)⑥）。
   五类写 ＝ ① 新增印章 ② 新增印面 ③ 上传印面图 ④ 编辑固定属性 ⑤ 审核勘误。
   数据层不负责「入口不可见」（那是 UI 的事，见 §6.2 第 1 条两条独立要求）。
   ============================================================================ */

/** `source` 取值：管理员用「上传印章」新增（区别于斐萃汇入）。 */
export const MANUAL_SOURCE = 'manual'

/**
 * canonical 必填项（缺失即拒，**不产生半成品记录**；见 §4.1.1 表下注 ③ / AC-34）。
 *
 * 本单口径②：**「印章名称」概念删除，名称＝印文**。
 * ⇒ 印文（`seal_name`，与平台 `sealName` 同源）**不再必填**（可空；空则对外显示「佚名」）；
 * 必填仅剩 **朝代 / 分类**（广场筛选维度）；**印面图**的必填校验在组合写里单独做
 * （`createSealWithFaceRows` / `insertFaceRow`）。
 */
export const REQUIRED_SEAL_FIELDS = [
  { key: 'dynasty', label: '朝代', aliases: ['dynasty'] },
  { key: 'category', label: '分類', aliases: ['type', 'category', 'seal_type'] }
]

/**
 * **印章显示名（R-61 冻结链 ＋ r2 读面接线扩展）**：
 *   **采纳值 → 原始 `seal_name`（印文） → 「佚名」**。
 *
 * - `acceptedName`（第 2 参，**可选**）：由**勘误汇总单点**（`services/corrections.js::resolveMarkable`，
 *   只认 `ACCEPTED`；同值取出现次数最多、次数相同取最近）算出的「印文」采纳值；
 *   非空 ⇒ **优先于**原始 `seal_name`（这就是「采纳后的标题修正」）。缺省 / 空 ⇒ 走原始链。
 * - `seal_name` 的键名**不变**；链上**不再有**「印文简体字」这一环（该字段 R-59 起整体退役）。
 * - 本函数是**数据层显示名的单点实现**（对印章行与印面行同样适用 —— 两者都带 `seal_name`）；
 *   视图 / 服务层**不得**再内联 `seal_name || '佚名'`。
 * @param {object|null} row 印章行 / 印面行
 * @param {string} [acceptedName=''] 勘误汇总单点给出的「印文」采纳值（无采纳 ⇒ 空串）
 * @returns {string} 采纳值 / 原始印文；两者皆空则「佚名」
 */
export function sealDisplayName(row, acceptedName = '') {
  if (hasText(acceptedName)) return String(acceptedName)
  const name = row ? row.seal_name : ''
  return hasText(name) ? String(name) : '佚名'
}

/* ============================================================================
   **R-49（2026-09-20｜低层写入口的键面冻结）**：各实体入口「**真正会写的键**」清单
   ----------------------------------------------------------------------------
   为什么要有这份清单：缺陷根因是「入口把不认得的键**静默丢掉**」——
   调用方看见 `ok:true`，以为写上了，库里却一个字都没有（既不可判、也不可读）。
   自 R-49 起：**清单之外的键 ⇒ `{ok:false, reason:'INVALID_FIELD'}` ＋ 零写入**。
   纪律（务必遵守）：
     ① 清单是「**会写**」的键面 —— 收下却不写的键**不得**留在清单里（那仍是静默丢弃）；
     ② 别名（如 `type` / `category` / `seal_type`）可以并列，但都必须**真的被读到**；
     ③ 相邻实体 / 相邻层级的键**不得**混入（如印章实体的清单里不得有 `face_style` ——
        它是**印面实体**的键，`insertSealRow` 收到它必须判 `INVALID_FIELD`）。
   ============================================================================ */

/** **印章实体**输入键面（`insertSealRow` 会写的键；别名并列）。 */
const SEAL_INSERT_INPUT_FIELDS = [
  'seal_name', // 印文（旧键 `name` 为兼容别名）
  'name',
  'dynasty',
  'type', // 分类（印面内容）三写兼容：type / category / seal_type
  'category',
  'seal_type',
  'material', // 印章级固定属性（R-32 移入）
  'shape', // 印章级固定属性（R-22）
  /* ⚠️ **印章实体不接受 `author_person_id`（P1-2）**：引用只活在**印面行** ⇒ 该键属**印面实体**
     键面（`FACE_INSERT_INPUT_FIELDS`），**不在此清单**（印章行不落引用副本，避免双写漂移；
     R-49 明文「收下却不写的键不得留在清单里」）。组合入口仍收该键（见 `SEAL_COMPOSITE_INPUT_FIELDS`），
     由组合写把它派给**印面行**。旧 `author`（自由文本）保留作历史回落、不得被引用 id 污染。 */
  'author',
  'transcription',
  'seal_style', // 旧键：风格（与印面级 `face_style` 不是同一口径，R-31）
  'style'
]

/** **印面实体**输入键面（`insertFaceRow` 会写的键；含影像入参）。 */
const FACE_INSERT_INPUT_FIELDS = [
  'sealId', // 所属印章三写兼容：sealId / stampId / stamp_id
  'stampId',
  'stamp_id',
  'kind', // FACE / EDGE（值域门另判）
  'id', // 指定印面编号（缺省按口径派生）
  'faceImageId', // 指定既有影像编号（face_image_id 为规范名）
  'face_image_id',
  'faceImage', // 现传影像字节（别名为 image）
  'image',
  'edgeImageIds', // 边款影像编号（规范名 edge_image_ids）
  'edge_image_ids',
  'seal_name',
  'name',
  'dynasty',
  'type',
  'category',
  'seal_type',
  'face_style', // 【印面风格】R-31：**印面级**新键（别名为 faceStyle）
  'faceStyle',
  'seal_class', // 【大類】（**印面级**新键，别名为 sealClass）
  'sealClass',
  'author',
  'author_person_id', // **印面「作者」＝ 引用型（person-model §4.1）**：选填、填则必须指向既有印人
  'transcription'
]

/** **影像实体**输入键面（`insertImageRow` 会写的键）。 */
const IMAGE_INSERT_INPUT_FIELDS = [
  'sealId',
  'stampId',
  'stamp_id',
  'kind', // FACE / EDGE（值域门另判）
  'faceId', // 归属印面编号（仅记入元数据 ownerId）
  'image', // 影像字节（别名为 dataUrl）
  'dataUrl'
]

/**
 * **组合入口**（`createSealWithFaceRows`）输入键面＝**印章实体键 ∪ 印面级键 ∪ 影像入参键**。
 * 组合写把载荷分派给三个实体 ⇒ 它自己的键面是三者之并集（各实体的门仍各自再判一次）。
 */
const SEAL_COMPOSITE_INPUT_FIELDS = [
  ...SEAL_INSERT_INPUT_FIELDS,
  'author_person_id', // 印面级引用（P1-2）：落**印面行**；印章实体键面已不含它（见 `SEAL_INSERT_INPUT_FIELDS` 注）
  'face_style', // 印面级（落在印面上，R-31）
  'faceStyle',
  'seal_class', // 印面级（落印面，无回落）
  'sealClass',
  'faceImage', // 印面图入参（必填门另判）
  'image',
  'edgeImage' // 边款图入参（可选）
]

/** 从组合入口载荷里**只挑印章实体键**（其余键归印面 / 影像面，由组合写自己消费）。 */
function pickSealInsertPayload(payload) {
  const out = {}
  SEAL_INSERT_INPUT_FIELDS.forEach((key) => {
    if (payload && Object.prototype.hasOwnProperty.call(payload, key)) out[key] = payload[key]
  })
  return out
}

/**
 * **印面类别值域门**（R-49 第 2 条：键属该实体而值不在值域 ⇒ `INVALID_VALUE`）。
 * 真源＝`FACE_KIND`（`FACE` / `EDGE`）；空值＝未传 ⇒ 走既有缺省（**不判负**）。
 * 为什么必须有：改前 `kind` 是「**非 EDGE 一律当 FACE**」的**静默归一** ——
 * 传 `'edge'` / `'EDGE '` / 任意字符串都会被悄悄当成印面写下去。
 * @returns {null|{ok:false, reason:'INVALID_VALUE', message:string}} 放行 ⇒ `null`
 */
function faceKindValueDenial(value) {
  const text = value === null || value === undefined ? '' : String(value).trim()
  if (!text) return null
  if (text === FACE_KIND.FACE || text === FACE_KIND.EDGE) return null
  return {
    ok: false,
    reason: 'INVALID_VALUE',
    message:
      `印面類別「${text}」不在允許的 2 類之內（${FACE_KIND.FACE}、${FACE_KIND.EDGE}），已拒絕寫入；` +
      '本次未寫入任何內容。'
  }
}

function nowIso() {
  return new Date().toISOString()
}

function pickText(source, keys) {
  if (!source) return ''
  for (const key of keys) {
    const value = source[key]
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

/**
 * 归一上游（页面 / 服务层）传来的印章载荷：`type` / `category` / `seal_type` 三写兼容。
 * 印文键口径：**`seal_name` 为准**（与平台 `sealName` 同源），旧键 `name` 保留为兼容别名。
 *
 * **R-31（2026-09-20）**：新增【印面风格】`face_style`（**印面级新键**）—— 录入面按它赋值，
 * 落库时写在**印面行**上；它与旧键 `seal_style`（白文 / 朱文 之流）**不是同一口径**，
 * 互不覆盖、互不回落。
 */
function normalizeSealPayload(payload = {}) {
  return {
    seal_name: pickText(payload, ['seal_name', 'name']), // 印文（**可空**；空则显示「佚名」）
    dynasty: pickText(payload, ['dynasty']),
    category: pickText(payload, ['type', 'category', 'seal_type']), // 印面内容（R-30）
    material: pickText(payload, ['material']),
    /* 形制（R-22）：**印章级固定属性、自由文本**（与「材质」同待遇；可空）。 */
    shape: pickText(payload, ['shape']),
    author: pickText(payload, ['author']),
    /* **作者引用型（person-model §4.1）**：新键 `author_person_id`（印面级；选填）。
       值域门由各入口在写之前判（`personReferenceDenial`），此处只归一取值。 */
    authorPersonId: pickText(payload, ['author_person_id']),
    /* R-59：【印文简体字】已退役，本归一器不再产出该字段（入口键面里也已无该键
       ⇒ 调用方仍传会被 `assertKnownKeys` 判 `INVALID_FIELD`，不静默丢弃）。 */
    transcription: pickText(payload, ['transcription']),
    sealStyle: pickText(payload, ['seal_style', 'style']),
    /* 印面风格（R-31）：**新键 `face_style`**（印面级），与旧 `seal_style` 互不回落。 */
    faceStyle: pickText(payload, ['face_style', 'faceStyle']),
    /* 印章大類：**新键 `seal_class`**（印面级；**无回落**，与 `face_style` 同口型）。 */
    sealClass: pickText(payload, ['seal_class', 'sealClass'])
  }
}

/** 缺失的必填项标签（空数组 ⇒ 全部齐备）。 */
function missingSealFields(clean) {
  return REQUIRED_SEAL_FIELDS.filter((field) => !clean[field.key]).map((field) => field.label)
}

/* --------------------------- id 生成（不得与既有冲突，§4.1.1 表下注 ②） --------------------------- */

/**
 * 印章编号口径（本单口径①）：**`XA` + 9 位零填充序号**（例：第 1 枚 ⇒ `XA000000001`）。
 * **既有种子 `XAI-0001`…`XAI-0008` 保留、不得改写**，也不参与新序号的递增。
 */
const SEAL_STAMP_ID_PATTERN = /^XA(\d{9})$/
/** 旧口径 `XAI-<数字>`：**只用于容错识别**（不参与新序号递增）。 */
const LEGACY_STAMP_ID_PATTERN = /^XAI-(\d+)$/

/** 序号 → 编号：`XA` + 9 位零填充。 */
function formatSealStampId(serial) {
  return `XA${String(serial).padStart(9, '0')}`
}

function uniqueId(base, taken) {
  if (!taken.has(base)) return base
  let index = 2
  while (taken.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

/**
 * 下一个印章编号：`XA` + 9 位序号，**跳过已占用**。
 * 解析容错：**只把匹配 `^XA\d{9}$` 的既有行当序号参与递增**；
 * 旧 `XAI-000x` 一律不被误解析成序号（它们只是「已占用」集合里的一员）。
 */
function nextSealStampId(rows) {
  let max = 0
  rows.forEach((row) => {
    const matched = SEAL_STAMP_ID_PATTERN.exec(String((row && row.stamp_id) || ''))
    if (matched) max = Math.max(max, Number(matched[1]))
  })
  const taken = new Set(rows.map((row) => String((row && row.stamp_id) || '')))
  let index = max + 1
  while (taken.has(formatSealStampId(index))) index += 1
  return formatSealStampId(index)
}

/** 印章序号（用于派生印面 / 影像 id 的 `<序号>` 位，编号模板本身不变）。 */
function stampSerial(stampId) {
  const matched = SEAL_STAMP_ID_PATTERN.exec(String(stampId || ''))
  if (matched) return matched[1]
  const legacy = LEGACY_STAMP_ID_PATTERN.exec(String(stampId || ''))
  if (legacy) return legacy[1]
  return String(stampId || '').replace(/[^0-9A-Za-z]/g, '')
}

/** 印面 id：`fc-<印章序号>-<f|e><n>`（同类递增，冲突则继续挑）。 */
function nextFaceId(stampId, kind, taken) {
  const letter = kind === FACE_KIND.EDGE ? 'e' : 'f'
  const serial = stampSerial(stampId)
  let index = 1
  while (taken.has(`fc-${serial}-${letter}${index}`)) index += 1
  return `fc-${serial}-${letter}${index}`
}

/** 影像 id：`img-<印章序号><f|e>`（同类冲突则追加序号）。 */
function nextImageId(stampId, kind, taken) {
  const letter = kind === FACE_KIND.EDGE ? 'e' : 'f'
  return uniqueId(`img-${stampSerial(stampId)}${letter}`, taken)
}

/* ------------------------------- 内部工具 ------------------------------- */

function snapshotCollections() {
  return { seals: listSealRows(), faces: listFaceRows(), images: listImageRows() }
}

function restoreCollections(snapshot) {
  saveSealRows(snapshot.seals)
  saveFaceRows(snapshot.faces)
  saveImageRows(snapshot.images)
}

/** 回滚：把三个集合还原，并删掉本次新落盘的影像二进制（不留孤儿）。 */
async function rollbackTo(snapshot, beforeImageIds) {
  const fresh = listImageRows().filter((row) => !beforeImageIds.has(row.id))
  for (const row of fresh) {
    /* 只删本次新增行的二进制；复用既有影像行的情况不会出现在这里（不会新增行）。 */
    await deleteImageBinary(row.id)
  }
  restoreCollections(snapshot)
}

function imageRowSha(row, images) {
  if (!row) return ''
  const found = images.find((item) => item.id === row.face_image_id)
  return found ? String(found.sha256 || '') : ''
}

/**
 * **防重键（实现自选口径，规范只要求可机械判负）**：
 *   ① 印面级 ＝ `(sealId, kind, sha256(印面图二进制))` —— 语义等价的印面（同印章 · 同类别 · 同图内容）
 *      只保留 1 个；重复提交返回 `deduped: true`，**不新增印面行、不新增影像行、不重复落二进制**。
 *   ② 印章级 ＝ `(印文, 朝代, 分类, sha256(印面图))` —— 整枚印章意义上的语义等价（同一张图重复提交
 *      「上传印章」）同样不新增。**印文即 `seal_name`（本单口径②：名称概念删除、印文可空）**，
 *      印文为空串时按空串参与比较。
 *   ③ 二进制级 ＝ IndexedDB 键 `asset:<影像 id>`；同印章同 sha 命中既有影像行时**复用该行**，不重复写库。
 */
function findFaceByDedupe(sealId, kind, sha) {
  if (!sha) return null
  const images = listImageRows()
  return (
    listFaceRows().find(
      (row) =>
        (row.sealId || row.stamp_id) === sealId &&
        row.kind === kind &&
        imageRowSha(row, images) === sha
    ) || null
  )
}

function findEquivalentSeal(clean, sha) {
  const images = listImageRows()
  const faces = listFaceRows()
  /* 印章级防重键（本单口径②）：`(印文, 朝代, 分类, sha256(印面图))` —— **印文可为空串**。 */
  const seal = listSealRows().find(
    (row) =>
      String(row.seal_name || '') === clean.seal_name &&
      String(row.dynasty || '') === clean.dynasty &&
      String(row.seal_type || '') === clean.category
  )
  if (!seal) return null
  const face = faces.find(
    (row) =>
      (row.sealId || row.stamp_id) === seal.stamp_id &&
      row.kind === FACE_KIND.FACE &&
      imageRowSha(row, images) === sha
  )
  if (!face) return null
  const image = images.find((item) => item.id === face.face_image_id) || null
  return { seal, face, imageId: image ? image.id : '' }
}

/* --------------------------- ① 新增印章（管理员） --------------------------- */

/**
 * 新增印章行（数据层写方法①）。必填缺失即拒、**不落任何记录**。
 * `source = 'manual'` / `uploaded_by` / `created_at` 三处必落（§4.1.1 表下注 ①）。
 *
 * **R-49（2026-09-20｜键白名单门）**：本入口只写**印章实体**的键（`SEAL_INSERT_INPUT_FIELDS`）；
 * 其它键（典型：**印面级的 `face_style`**、`faceImage` 之流）⇒ 结构化
 * `{ok:false, reason:'INVALID_FIELD'}` ＋ **零写入**。改前它们是**静默丢弃**（`ok:true` 却什么都没写）
 * —— 缺陷根因；canonical 组合入口 `createSealWithFaceRows` 有门，故**只有低层单表入口漏了**。
 * 组合入口传进来的载荷已在 `pickSealInsertPayload` 里**只挑印章键**，故本门不影响它。
 * @returns {{ok:boolean, row?:object, stampId?:string, reason?:string, missing?:string[], message:string}}
 */
export function insertSealRow(actor, payload = {}) {
  const denied = forbiddenFor(actor, '僅管理員可以上傳印章（新增進藏品庫）')
  if (denied) return denied
  /* **R-49 第 1 条（键白名单门）**：在任何写入之前判定 ⇒ 拒绝即零写入。 */
  const invalidField = assertKnownKeys(payload, SEAL_INSERT_INPUT_FIELDS, '印章實體')
  if (invalidField) return invalidField
  const clean = normalizeSealPayload(payload)
  const missing = missingSealFields(clean)
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'MISSING_REQUIRED',
      missing,
      message: `請補全必填項：${missing.join('、')}`
    }
  }
  /* 第二道门（R-20）：朝代值域 —— 必填门在前（空值已按 `MISSING_REQUIRED` 拒），此处判“值在不在集合内”。 */
  const dynastyDenied = dynastyValueDenial(clean.dynasty)
  if (dynastyDenied) return dynastyDenied
  /* 第二道门（R-30）：**印面内容**值域 —— 新写入的 `seal_type` 必须 ∈ 9 类
     （既有行的旧值不受影响，本门只拦新写入）。 */
  const contentDenied = faceContentValueDenial(clean.category)
  if (contentDenied) return contentDenied
  /* ⚠️ **P1-2**：印章行**不落引用副本** ⇒ 本入口（印章实体）**不判**、不写 `author_person_id`
     —— 该键已不在 `SEAL_INSERT_INPUT_FIELDS`（传进来会先被键白名单门判 `INVALID_FIELD`）。
     引用的值域门（`personReferenceDenial`）由**印面级入口 / 组合入口**在写前判。 */
  const rows = listSealRows()
  const stampId = nextSealStampId(rows)
  const at = nowIso()
  const row = {
    sealGroupId: `g-${stampSerial(stampId)}`,
    stamp_id: stampId, // 兼容别名（既落盘视图按它定位），勿删
    id: stampId, // §4.1.1 规范字段名
    seal_name: clean.seal_name, // 印文（**可空**；空则对外显示「佚名」）
    name: clean.seal_name, // 兼容别名（＝印文）
    transcription: clean.transcription,
    dynasty: clean.dynasty, // 广场筛选维度（必填）
    seal_type: clean.category, // 广场筛选维度（必填）
    category: clean.category,
    seal_style: clean.sealStyle,
    material: clean.material,
    shape: clean.shape, // 印章级固定属性【形制】（R-22：自由文本，可空 ⇒ 视图模型给空串）
    asset_kind: 'SEAL',
    review_status: 'APPROVED', // 管理员上传即生效（与实物照片同口径，不进审核队列）
    /* R-59：不写【印文简体字】键（逐键输出无该键）。 */
    author: clean.author,
    /* ⚠️ **P1-2**：印章行**不落** `author_person_id`（引用只在**印面行**存在，避免双写漂移）；
       旧 `author`（自由文本）逐字保留作历史回落。 */
    source: MANUAL_SOURCE,
    uploaded_by: actor.id,
    created_at: at,
    updated_at: at
  }
  saveSealRows([...rows, row])
  return { ok: true, row, stampId, message: `已新增印章《${sealDisplayName(clean)}》（${stampId}）` }
}

/* --------------------------- ② 上传印面图（管理员） --------------------------- */

/**
 * 上传影像（数据层写方法②的影像一侧；`kind` 只取 `FACE` / `EDGE`）。
 * 二进制 → IndexedDB；**元数据（标量）→ localStorage**（§4.1.3 表下注）。
 * 同印章同内容（同 `sha256`）的影像**复用既有行**，不重复落库。
 *
 * **R-49**：① 键白名单门 —— 只收 `IMAGE_INSERT_INPUT_FIELDS`，其余键 ⇒ `INVALID_FIELD` ＋ 零写入；
 * ② 值域门 —— `kind` 不在 `FACE_KIND` 之内 ⇒ `INVALID_VALUE` ＋ 零写入（改前是**静默归一**成 `FACE`）。
 */
export async function insertImageRow(actor, payload = {}) {
  const denied = forbiddenFor(actor, '僅管理員可以上傳印面圖')
  if (denied) return denied
  /* **R-49 第 1 条**：键白名单门。 */
  const invalidField = assertKnownKeys(payload, IMAGE_INSERT_INPUT_FIELDS, '影像實體')
  if (invalidField) return invalidField
  /* **R-49 第 2 条**：`kind` 值域门（不在 `FACE_KIND` 之内 ⇒ 拒，不得静默当印面）。 */
  const kindDenied = faceKindValueDenial(payload.kind)
  if (kindDenied) return kindDenied
  const sealId = pickText(payload, ['sealId', 'stampId', 'stamp_id'])
  if (!sealId) {
    return { ok: false, reason: 'MISSING_REQUIRED', missing: ['所屬印章'], message: '請補全必填項：所屬印章' }
  }
  const kind = String(payload.kind || '').trim() === FACE_KIND.EDGE ? FACE_KIND.EDGE : FACE_KIND.FACE
  const input = payload.image !== undefined ? payload.image : payload.dataUrl
  const image = normalizeImagePayload(input)
  if (!image.ok) return { ok: false, reason: imageReasonOf(image), message: image.message }

  const images = listImageRows()
  const existing = images.find((row) => row.stamp_id === sealId && row.sha256 === image.sha256 && row.kind === kind)
  if (existing) {
    return {
      ok: true,
      deduped: true,
      row: existing,
      message: '該影像此前已上傳（內容相同），已複用既有影像，未重複落庫'
    }
  }

  const assetId = nextImageId(sealId, kind, new Set(images.map((row) => row.id)))
  /* ---------------------------------------------------------------------------
     **K-P5b（2026-09-23）｜寫入面切遠端**：
     新增產物（存儲件容器 ＝ 單頁 8bit Deflate TIFF）⇒ **先交服務端權威存儲**（內容尋址）
     取得 `sha256` / `bytesLength`，**行內只存 digest ＋ 體量 ＋ 容器**，
     **二進制不再寫 IndexedDB**（`storage` 如實記為 `server`）；
     **失敗 ⇒ 結構化失敗 ＋ 零寫入**（不落行、不落二進制、不產重複行 / 半寫行）。
     存量 / 非源面容器（含舊 8 色索引 PNG）⇒ **既有本機影像庫寫入路徑一行未改**。
     --------------------------------------------------------------------------- */
  const storedBytesLength = Number(image.bytesLength)
  let authority = null
  if (image.mime === STORAGE_MIME) {
    const remote = await storeArtifactBytes(image.bytes)
    if (!remote.ok) {
      return {
        ok: false,
        reason: remote.reason || 'STORAGE_UNAVAILABLE',
        message: `影像入庫失敗：${remote.message}（本次未寫入任何影像行 / 二進制，可重試）`
      }
    }
    authority = remote
  } else {
    const stored = await putImageBinary(assetId, image.bytes)
    if (!stored.ok) {
      return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: `影像庫寫入失敗：${stored.message}` }
    }
  }
  const digest = authority ? authority.sha256 : image.sha256
  const bytesLength = authority ? authority.bytesLength : storedBytesLength
  const at = nowIso()
  const row = {
    id: assetId, // §4.1.3 asset.id
    assetId,
    stamp_id: sealId, // 兼容别名（既落盘服务按它定位），勿删
    sealId,
    ownerType: 'face',
    ownerId: payload.faceId || '',
    kind, // 仍只取 FACE / EDGE（不因存储分层新增第三种）
    sha256: digest,
    bytes: bytesLength, // 既有语义（number）**未回退**
    /* **K-P5b**：显式体量键（与 `bytes` 同值同义，供读取面分流 / 取证直读）。 */
    bytesLength,
    width: image.width,
    height: image.height,
    colorMode: image.colorMode,
    color_mode: image.colorMode, // 兼容既落盘视图用字
    /* **K4 收口（2026-09-21）**：`assetmeta.js` 早已能从字节判出这四个键，但本行此前**只落**
       `colorMode`/`color_mode` ⇒ AC-96「数据面必须能判」只在**返回值**可判、**落盘不可判**。
       新建行**一并落这四个键**（来源＝`normalizeImagePayload` 从**字节**得出的统一形状，
       取不到即 `null` / `0` —— **不猜**）；与 `color_mode` 同处、同一份真源，不另立第二套判据。
       ⚠️ 这四个键是**影像编码口径**（像素怎么存的），**不是**印面上色信息（R-135 起
       「配色類型」整体退场、上色面随之退场）。 */
    colorType: image.colorType,
    bitDepth: image.bitDepth,
    paletteEntries: image.paletteEntries,
    neutral: image.neutral,
    mime: image.mime,
    /* **K-P5b**：二進制去向如實記 —— `server` ＝ 服務端權威庫（本單新寫入的行，**本機零二進制**）；
       `indexeddb` ＝ 既有本機影像庫（存量 / 非源面容器，路徑一字未改）。 */
    storage: authority ? AUTHORITY_STORAGE_SERVER : 'indexeddb',
    /* **M-1（2026-10-08）**：`storage_key` 由權威方的回包決定 ——
       A 路（本機權威庫）⇒ 回包 `storageKey` 為空串 ⇒ 行上仍 `''`（**既有口徑一字未改**）；
       B 路（客戶端直傳雲存儲）⇒ ＝ 對象鍵 `xiai/images/<sha 前兩位>/<sha>.tiff`
       （與既有展示件行的 `storage_key` 同族；**讀面仍只走既有那一族機制**）。 */
    storage_key: authority ? String(authority.storageKey || '') : assetBlobKey(assetId),
    /* **K-P5b**：權威庫的**相對路徑形狀**（`<sha256[:2]>/<sha256>.tiff`；**不含絕對路徑**）。 */
    authority_rel_path: authority ? authority.relPath : '',
    /* **R-87（2026-09-21｜Kong-I1）**：**切片元数据**（`{directions, ratios, cols, rows, cuts}`）
       —— 新建影像行**落盘**该键；内容由 `sliceMetaOf(assetId, kind)` **确定性派生**
       （同 id 必同结果 ⇒ 既有行无需迁移，派生即可复现；DB 仍只存**完整源图 + 元数据**，R-88）。 */
    [SLICE_META_FIELD]: sliceMetaOf(assetId, kind),
    source: MANUAL_SOURCE,
    uploaded_by: actor.id,
    created_at: at
  }
  saveImageRows([...images, row])
  return {
    ok: true,
    deduped: false,
    row,
    /* **上屏如實（§3.28.4）**：入庫面如實說出容器（單頁 8bit Deflate TIFF）與二進制去向。 */
    message: authority
      ? `印面圖已上傳（單頁 8bit Deflate TIFF 已交服務端權威存儲；影像行只存摘要 sha256、體量與容器類型，本機不再留存二進制）`
      : '印面圖已上傳（二進制已落本地影像庫）'
  }
}

export async function insertFaceRow(actor, payload = {}) {
  const denied = forbiddenFor(actor, '僅管理員可以在印章下新增印面')
  if (denied) return denied
  /* **R-49 第 1 条（键白名单门）**：先判 `material`（R-32 移级，有**更具体的指路文案**），
     再判通用键白名单 —— 两者都是 `INVALID_FIELD` ＋ 零写入。
  if (Object.prototype.hasOwnProperty.call(payload, 'material')) {
    const given = normalizeMaterial(payload.material)
    return {
      ok: false,
      reason: 'INVALID_FIELD',
      message:
        '【材質】屬印章級固定屬性（R-32 已從印面級移入印章級），印面級入口不接受該字段；' +
        `請改用印章級入口（writeSealFixedAttributes / services.updateSealAttributes）寫「${given === '' ? '（空值）' : given}」`
    }
  }
  const invalidField = assertKnownKeys(payload, FACE_INSERT_INPUT_FIELDS, '印面實體')
  if (invalidField) return invalidField
  /* **R-49 第 2 条（值域门）**：`kind` 不在 `FACE_KIND` 之内 ⇒ `INVALID_VALUE`（改前静默当 FACE）。 */
  const kindDenied = faceKindValueDenial(payload.kind)
  if (kindDenied) return kindDenied
  const sealId = pickText(payload, ['sealId', 'stampId', 'stamp_id'])
  if (!sealId) {
    return { ok: false, reason: 'MISSING_REQUIRED', missing: ['所屬印章'], message: '請補全必填項：所屬印章' }
  }
  const kind = String(payload.kind || '').trim() === FACE_KIND.EDGE ? FACE_KIND.EDGE : FACE_KIND.FACE
  const sealRow = listSealRows().find((row) => row.stamp_id === sealId)
  if (!sealRow) return { ok: false, reason: 'UNKNOWN_SEAL', message: `未找到該印章：${sealId}` }

  /* 第二道门（R-20）：**只判“显式传入”的朝代**（新值必须 ∈ 15 类）；
     继承自所属印章的旧值**原样照抄**（R-21：旧值不改写，不得因新值域而挡住既有印章加印面）。 */
  const explicitDynasty = pickText(payload, ['dynasty'])
  if (explicitDynasty) {
    const dynastyDenied = dynastyValueDenial(explicitDynasty)
    if (dynastyDenied) return dynastyDenied
  }
  /* 第二道门（R-30 / R-31）：**只判“显式传入”的印面内容与印面风格**（新值必须 ∈ 9 / 23 类）；
     继承自所属印章的旧 `seal_type` **原样照抄**（R-21 / R-32：旧值不改写，不得因新值域
     而挡住「给旧印章加印面」）；`face_style` 是新字段，旧行没有 ⇒ 无继承、只有显式传入。 */
  const explicitContent = pickText(payload, ['type', 'category', 'seal_type'])
  if (explicitContent) {
    const contentDenied = faceContentValueDenial(explicitContent)
    if (contentDenied) return contentDenied
  }
  const explicitFaceStyle = pickText(payload, ['face_style', 'faceStyle'])
  if (explicitFaceStyle) {
    const styleDenied = faceStyleValueDenial(explicitFaceStyle)
    if (styleDenied) return styleDenied
  }
  /* 第二道门（大類）：**只判“显式传入”的 `seal_class`**（新值必须 ∈ 3 类）；无回落、旧行无该键。 */
  const explicitSealClass = pickText(payload, ['seal_class', 'sealClass'])
  if (explicitSealClass) {
    const classDenied = sealClassValueDenial(explicitSealClass)
    if (classDenied) return classDenied
  }
  /* **R-32（材质移级）**：印面级已无 `material` 字段 —— 本入口在**开头**就已按「多给了
     不该给的键」判 `INVALID_FIELD` ＋ **零写入**（见函数首段；R-49 起改为**按键存在**判定）。

  /* 印面的可标记属性：显式传入优先，缺则继承所属印章。 */
  /* **P1-2 修正**：印章行**不落引用副本** ⇒ 引用继承源改为**该印章的主印面**的印面级引用
     （单点 `primaryFaceIn`），**不再读 `sealRow.author_person_id`**（该键已不存在）。 */
  const sealPrimaryFace = primaryFaceIn(
    listFaceRows().filter((row) => (row.sealId || row.stamp_id) === sealId)
  )
  const inherit = {
    seal_name: sealRow.seal_name, // 印文（可空）
    dynasty: sealRow.dynasty,
    type: sealRow.seal_type,
    author: sealRow.author,
    author_person_id: (sealPrimaryFace && sealPrimaryFace.author_person_id) || '',
    transcription: sealRow.transcription
  }
  const explicit = { ...payload }
  /* 旧键 `name` 仅作兼容别名：显式给了就按印文等同处理，且**优先于继承值**。 */
  if (explicit.seal_name === undefined && explicit.name !== undefined) explicit.seal_name = explicit.name
  const clean = normalizeSealPayload({ ...inherit, ...explicit })
  /* 第二道门（person-model §4.1）：**作者引用值域**（显式传入优先、缺则继承）——
     非空引用必须指向既有印人；写之前判定 ⇒ 拒绝即零写入。 */
  const personDenied = personReferenceDenial(clean.authorPersonId)
  if (personDenied) return personDenied
  const missing = missingSealFields(clean)
  if (missing.length > 0) {
    return { ok: false, reason: 'MISSING_REQUIRED', missing, message: `請補全必填項：${missing.join('、')}` }
  }

  /* 影像：现传 / 指定既有编号二选一；FACE 必须有图。 */
  const before = snapshotCollections()
  const beforeImageIds = new Set(before.images.map((row) => row.id))
  let faceImageId = pickText(payload, ['faceImageId', 'face_image_id'])
  let newImageRow = null
  const imageInput = payload.faceImage !== undefined ? payload.faceImage : payload.image
  if (imageInput !== undefined && imageInput !== null && imageInput !== '') {
    const stored = await insertImageRow(actor, { sealId, kind, image: imageInput, faceId: payload.id || '' })
    if (!stored.ok) return stored
    newImageRow = stored.row
    faceImageId = stored.row.id
  } else if (faceImageId && !listImageRows().some((row) => row.id === faceImageId)) {
    return { ok: false, reason: 'UNKNOWN_IMAGE', message: `未找到編號爲「${faceImageId}」的影像，無法作爲印面圖片` }
  }
  if (kind === FACE_KIND.FACE && !faceImageId) {
    return { ok: false, reason: 'MISSING_REQUIRED', missing: ['印面圖'], message: '請補全必填項：印面圖' }
  }

  /* 防重：同印章 · 同类别 · 同图内容 ⇒ 语义等价印面只保留 1 个。 */
  const images = listImageRows()
  const sha = newImageRow ? newImageRow.sha256 : imageRowSha({ face_image_id: faceImageId }, images)
  const duplicate = findFaceByDedupe(sealId, kind, sha)
  if (duplicate) {
    if (newImageRow) await rollbackTo(before, beforeImageIds)
    return {
      ok: true,
      deduped: true,
      row: duplicate,
      message: '該印面已存在（同一印章 · 同一類別 · 同一圖），本次未重複新增'
    }
  }

  const faces = listFaceRows()
  const faceId = uniqueId(pickText(payload, ['id']) || nextFaceId(sealId, kind, new Set(faces.map((row) => row.id))), new Set(faces.map((row) => row.id)))
  const at = nowIso()
  const row = {
    id: faceId,
    sealId,
    stamp_id: sealId, // 兼容别名，勿删
    kind,
    face_image_id: faceImageId || null,
    /* **R-32 / AC-67**：新建印面**不写印面级 `material` 键**（材质真源在印章行 ⇒
       **该键不出现在新建行里**，逐键输出无 `material`）；既有印面行上的旧值**保留不改写**。
       显式传 material 已在上方按「键存在」判 `INVALID_FIELD`。 */
    edge_image_ids: normalizeEdgeIds(
      /* **R-49**：规范名 `edge_image_ids` 与旧别名 `edgeImageIds` **都真读**（改前只读旧别名
         ⇒ 传规范名会被静默丢弃）。 */
      payload.edgeImageIds !== undefined ? payload.edgeImageIds : payload.edge_image_ids
    ),
    /* R-59：不写【印文简体字】键（逐键输出无该键）。 */
    seal_name: clean.seal_name,
    dynasty: clean.dynasty,
    seal_type: clean.category,
    face_style: clean.faceStyle, // 印面风格（R-31：新键，印面级）
    seal_class: clean.sealClass, // 印章大類（**印面级**新键；**无回落**，空值即落空串）
    author: clean.author,
    /* **作者引用型（person-model §4.1）**：印面行落可空引用（**旧 author 文本一字不改**）。 */
    author_person_id: clean.authorPersonId,
    transcription: clean.transcription,
    source: MANUAL_SOURCE,
    uploaded_by: actor.id,
    created_at: at,
    updated_at: at
  }
  saveFaceRows([...faces, row])
  return { ok: true, deduped: false, row, message: `已新增${kind === FACE_KIND.EDGE ? '邊款' : '印面'}（${faceId}）` }
}

/* ============================================================================
   印面影像替换（**原子**）：新增影像行 + 改印面指向，**旧影像一律保留**
   ----------------------------------------------------------------------------
   为什么是「新增 + 改指向」而不是「覆盖旧影像」：替换印面图是**不可逆**的外观改动，
   旧影像（行 + 二进制）是评审 / 回溯的唯一凭据 ⇒ 一律不删、不改写；
   本函数对既有集合**只增不改**（除目标印面自身的 `face_image_id` / `updated_at`）。
   去重口径沿用 `insertImageRow`（同印章 · 同类别 · 同 sha256 ⇒ 复用既有行，不重复落库）。
   ============================================================================ */

/**
 * **原子**替换某个印面的印面图。
 *
 * 顺序：**先校验（权限 / 印面存在 / 影像可解析）→ 再落盘**；落盘分两步
 * （① 新增影像行 + 二进制 ② 改印面 `face_image_id`），任一步失败 ⇒ **回滚**
 * （三个集合还原 + 删除**本次新增行**的二进制）⇒ 不留半成品影像行 / 半成品二进制。
 *
 * 权限：非管理员一律**结构化拒绝** `{ok:false, reason:'FORBIDDEN'}`，
 * 且**不写任何一行、不落任何二进制**（数据层独立拒绝越权写，不依赖 UI 隐藏入口）。
 *
 * 影像类别 `kind`：取目标印面自身的类别（`FACE` 印面 ⇒ `FACE` 影像 / 边款印面 ⇒ `EDGE` 影像），
 * 与「边款是 `kind = EDGE` 的特殊印面」的既有模型一致。
 *
 * 影像元数据（尺寸 / mime / 摘要 / 体量）一律**由字节解析得出**（`normalizeImagePayload`），
 * 不采信调用方的声称值；调用方传入的 `width` / `height` 如有出入，在 `message` 里如实并列。
 *
 * @param {object|null} actor 操作者（须为管理员）
 * @param {string} faceId 目标印面编号
 * @param {Uint8Array|ArrayBuffer|string|{bytes:Uint8Array, mime?:string, width?:number, height?:number}} imageInput
 *        影像内容（二进制 / `data:image/...;base64,...`；也接受带 `bytes` 的载荷对象）
 * @returns {Promise<{ok:boolean, faceImageId?:string, previousFaceImageId:string|null, faceId?:string,
 *   sealId?:string, face?:object, image?:object, deduped?:boolean,
 *   claimed?:{width:number,height:number}, reason?:string, message:string}>}
 *   - 成功：`faceImageId` ＝ 新指向的影像编号，`previousFaceImageId` ＝ 替换前的编号（原本无图则为 `null`）；
 *     旧影像行与二进制**仍然在库**（`previousFaceImageId` 可读回）。
 *   - 拒绝：非管理员 ⇒ `reason:'FORBIDDEN'`；印面不存在 ⇒ `UNKNOWN_FACE`；
 *     影像不可解析 ⇒ `UNRECOGNIZED_IMAGE`；二进制写库失败 ⇒ `STORAGE_UNAVAILABLE`（已回滚）。
 */
export async function replaceFaceImage(actor, faceId, imageInput) {
  /* ① 权限（数据层硬拦截）：非管理员 ⇒ **结构化拒绝**（`reason:'FORBIDDEN'`），**不产生任何写入**。 */
  const deniedByRole = forbiddenFor(actor, '僅管理員可以重新上傳印面圖')
  if (deniedByRole) {
    return { ...deniedByRole, previousFaceImageId: null }
  }

  const id = pickText({ faceId }, ['faceId'])
  if (!id) {
    return { ok: false, reason: 'MISSING_FACE', previousFaceImageId: null, message: '未指定要替換影像的印面' }
  }
  const target = readFaceCollection().find((row) => row.id === id)
  if (!target) {
    return { ok: false, reason: 'UNKNOWN_FACE', previousFaceImageId: null, message: `未找到該印面：${id}` }
  }
  const previousFaceImageId = target.face_image_id || null
  const sealId = target.sealId || target.stamp_id || ''
  if (!sealId) {
    return {
      ok: false,
      reason: 'UNKNOWN_SEAL',
      previousFaceImageId,
      message: `印面 ${id} 未掛到任何印章上，無法新增影像`
    }
  }

  /* ② 影像内容：**先解析（含必填 / 体积 / 形态校验）**，解析不过 ⇒ 一行都不写。 */
  const payload = imageInput && typeof imageInput === 'object' && !ArrayBuffer.isView(imageInput)
    ? imageInput
    : { bytes: imageInput }
  const claimed = {
    width: Number.isFinite(Number(payload.width)) ? Math.round(Number(payload.width)) : 0,
    height: Number.isFinite(Number(payload.height)) ? Math.round(Number(payload.height)) : 0
  }
  const raw = payload.bytes !== undefined ? payload.bytes : payload.dataUrl !== undefined ? payload.dataUrl : imageInput
  const image = normalizeImagePayload(raw)
  if (!image.ok) {
    return { ok: false, reason: imageReasonOf(image), previousFaceImageId, message: image.message }
  }

  /* ③ 落盘（原子）：新增影像行 → 改印面指向；任一步失败即回滚。 */
  const before = snapshotCollections()
  const beforeImageIds = new Set(before.images.map((row) => row.id))
  try {
    const stored = await insertImageRow(actor, {
      sealId,
      kind: target.kind === FACE_KIND.EDGE ? FACE_KIND.EDGE : FACE_KIND.FACE,
      image: image.bytes,
      faceId: id
    })
    if (!stored.ok) {
      await rollbackTo(before, beforeImageIds)
      return { ...stored, previousFaceImageId }
    }
    /* 元数据「写了但没落盘」的兜底（localStorage 满 / 被禁用时 `writeKey` 只返回 false，
       `insertImageRow` 无从察觉）：**回读校验**新影像行确实在库，否则回滚 ⇒
       绝不把印面指向一个不存在的影像行（「有指向无图」比失败更糟）。 */
    if (!listImageRows().some((row) => row.id === stored.row.id)) {
      /* 新行的二进制此刻**已经落盘**，但行没落盘 ⇒ 先按裸键删掉它（此时它不在任何集合里，
         `rollbackTo` 的「新增行」枚举不到它），再回滚集合 ⇒ 不留孤儿二进制。 */
      await deleteImageBinary(stored.row.id)
      await rollbackTo(before, beforeImageIds)
      return {
        ok: false,
        reason: 'STORAGE_UNAVAILABLE',
        previousFaceImageId,
        message: '影像元數據未能落盤（本地存儲不可寫），本次替換已回滾，未產生半成品影像'
      }
    }

    const written = writeFaceFixedAttributes(actor, id, { face_image_id: stored.row.id })
    const fresh = listImageRows().find((row) => row.id === stored.row.id) || stored.row
    const sameAsBefore = stored.deduped === true && previousFaceImageId === stored.row.id
    /* **K-P5b5（2026-09-23｜D2 修）**：尺寸的真源只有一个 ＝ 存储件的字節。
       `fresh.width` / `fresh.height` 为 0 ⇒ 语义是**本次没解析出尺寸**（容器不被字節解析器认
       得时的兜底值），**不是**「尺寸就是 0」。
       改前的文案在这一档上不实：既把 0 当尺寸印出来，又说「以解析值爲準」（把一个**没解析出来**
       的值说成已解析的裁决值）。⇒ 尺寸读数与「声称值对照」两处一律分档如实：
       解析出 ⇒ 印数字（双方不等时并列并可判「以解析值爲準」）；解析不出 ⇒ 明说未解析、不采任何一方。 */
    const parsedDims = fresh.width > 0 && fresh.height > 0
    const claimedGiven = claimed.width > 0 && claimed.height > 0
    const dimsNote = !claimedGiven
      ? ''
      : parsedDims
        ? (claimed.width !== fresh.width || claimed.height !== fresh.height
            ? `（調用方聲稱 ${claimed.width} × ${claimed.height}，按字節解析實爲 ${fresh.width} × ${fresh.height}，以解析值爲準）`
            : '')
        : `（調用方聲稱 ${claimed.width} × ${claimed.height}，但按字節未解析出尺寸（容器 ${fresh.mime || '認不出'}）——此行尺寸如實留待字節解析可用時再判，不採任何一方）`
    const dimsText = parsedDims ? `${fresh.width} × ${fresh.height}` : `尺寸未解析（容器 ${fresh.mime || '認不出'}）`
    return {
      ok: true,
      deduped: stored.deduped === true,
      sealId,
      faceId: id,
      faceImageId: stored.row.id,
      previousFaceImageId,
      image: fresh,
      face: written,
      claimed,
      message: sameAsBefore
        ? `本次所選圖與當前印面圖內容相同（影像編號 ${stored.row.id}），未新增影像行，印面指向未變`
        : `印面圖已替換：影像編號 ${previousFaceImageId || '（原無）'} → ${stored.row.id}；` +
          `舊影像行與二進制保留未刪。新影像 ${dimsText} · ${fresh.mime} · ${fresh.bytes} 字節${dimsNote}`
    }
  } catch (err) {
    await rollbackTo(before, beforeImageIds)
    return {
      ok: false,
      reason: 'ERROR',
      previousFaceImageId,
      message: `替換印面圖失敗：${(err && err.message) || '未知原因'}（已回滾，未產生半成品影像）`
    }
  }
}

/* ------------------ 组合写：新增印章 + 印面 + 印面图（原子，无半成品） ------------------ */

/**
 * 「上传印章」的一次性组合写（数据层入口，服务层 `seals.createSealWithFace` 调它）。
 * 顺序：**先校验（必填 / 防重 / 影像可解析）→ 再落盘**；中途任何失败**回滚**
 * （三个集合还原 + 删除本次新写的二进制）⇒ 不产生半成品记录（AC-34）。
 *
 * **R-49**：本入口是**组合入口**（一次写印章 / 印面 / 影像三个实体），键面＝三者之并集
 * （`SEAL_COMPOSITE_INPUT_FIELDS`）—— 之外的键 ⇒ `INVALID_FIELD` ＋ 零写入；
 * 分派给各实体时**由各实体入口各自再判一次自己的门**（`insertSealRow` 只收印章键，
 * 故这里用 `pickSealInsertPayload` 只挑印章键传下去，**不把印面级的键硬塞给印章级入口**）。
 */
export async function createSealWithFaceRows(actor, payload = {}) {
  const denied = forbiddenFor(actor, '僅管理員可以上傳印章（新增進藏品庫）')
  if (denied) return denied
  /* **R-49 第 1 条（键白名单门）**：在任何副作用（影像解析 / 落盘）之前拒绝（零写入）。 */
  const invalidField = assertKnownKeys(payload, SEAL_COMPOSITE_INPUT_FIELDS, '新增印章入口')
  if (invalidField) return invalidField
  const clean = normalizeSealPayload(payload)
  const missing = missingSealFields(clean)
  if (missing.length > 0) {
    return { ok: false, reason: 'MISSING_REQUIRED', missing, message: `請補全必填項：${missing.join('、')}` }
  }
  /* 第二道门（R-20）：朝代值域 —— 在任何副作用（影像解析 / 落盘）之前拒绝（零写入）。 */
  const dynastyDenied = dynastyValueDenial(clean.dynasty)
  if (dynastyDenied) return dynastyDenied
  /* 第二道门（R-30）：印面内容值域 —— 同样在任何副作用之前（零写入）。 */
  const contentDenied = faceContentValueDenial(clean.category)
  if (contentDenied) return contentDenied
  /* 第二道门（R-31）：印面风格值域 —— 只判**显式传入**的值（未填 ⇒ 合法、落空串）。 */
  if (clean.faceStyle) {
    const styleDenied = faceStyleValueDenial(clean.faceStyle)
    if (styleDenied) return styleDenied
  }
  /* 第二道门（大類）：印章大類值域 —— 只判**显式传入**的值（未填 ⇒ 合法、落空串）。 */
  if (clean.sealClass) {
    const classDenied = sealClassValueDenial(clean.sealClass)
    if (classDenied) return classDenied
  }
  /* 第二道门（person-model §4.1）：**作者引用值域** —— 非空 `author_person_id` 必须指向
     既有印人；在任何副作用（影像解析 / 落盘）之前判定 ⇒ 拒绝即零写入。 */
  const authorRefDenied = personReferenceDenial(clean.authorPersonId)
  if (authorRefDenied) return authorRefDenied
  const faceInput = payload.faceImage !== undefined ? payload.faceImage : payload.image
  if (faceInput === undefined || faceInput === null || faceInput === '') {
    return { ok: false, reason: 'MISSING_REQUIRED', missing: ['印面圖'], message: '請補全必填項：印面圖' }
  }
  const faceImage = normalizeImagePayload(faceInput)
  if (!faceImage.ok) return { ok: false, reason: imageReasonOf(faceImage), message: faceImage.message }
  let edgeInput = ''
  if (payload.edgeImage !== undefined && payload.edgeImage !== null && payload.edgeImage !== '') {
    const edgeImage = normalizeImagePayload(payload.edgeImage)
    if (!edgeImage.ok) return { ok: false, reason: imageReasonOf(edgeImage), message: `邊款圖：${edgeImage.message}` }
    edgeInput = payload.edgeImage
  }

  /* 防重（印章级）：语义等价的整枚印章不重复新增。 */
  const equivalent = findEquivalentSeal(clean, faceImage.sha256)
  if (equivalent) {
    return {
      ok: true,
      deduped: true,
      seal: equivalent.seal,
      face: equivalent.face,
      imageId: equivalent.imageId,
      message: '該印章與印面圖此前已上傳，本次未重複新增'
    }
  }

  const before = snapshotCollections()
  const beforeImageIds = new Set(before.images.map((row) => row.id))
  try {
    const sealWritten = insertSealRow(actor, pickSealInsertPayload(payload))
    if (!sealWritten.ok) return sealWritten
    const stampId = sealWritten.row.stamp_id
    const faceId = nextFaceId(stampId, FACE_KIND.FACE, new Set(listFaceRows().map((row) => row.id)))
    const edgeFaceId = edgeInput
      ? nextFaceId(stampId, FACE_KIND.EDGE, new Set([...listFaceRows().map((row) => row.id), faceId]))
      : ''

    const faceImageRow = await insertImageRow(actor, { sealId: stampId, kind: FACE_KIND.FACE, image: faceInput, faceId })
    if (!faceImageRow.ok) {
      await rollbackTo(before, beforeImageIds)
      return faceImageRow
    }
    let edgeImageRow = null
    if (edgeInput) {
      edgeImageRow = await insertImageRow(actor, { sealId: stampId, kind: FACE_KIND.EDGE, image: edgeInput, faceId: edgeFaceId })
      if (!edgeImageRow.ok) {
        await rollbackTo(before, beforeImageIds)
        return edgeImageRow
      }
    }

    const at = nowIso()
    const writeFace = (id, kind, faceImageId, edgeImageIds) => ({
      id,
      sealId: stampId,
      stamp_id: stampId,
      kind,
      face_image_id: faceImageId,
      /* **R-32 / AC-67（材质移级）**：新建印面**不写**印面级 `material` 键（真源＝印章行，
         见上面 `insertSealRow` 落下的 `material`）—— 新建行**逐键输出无 `material`**；
         既有印面行上的旧值**保留不改写**（读路径 `sealMaterialValue` 对「无该键」的行返回空串）。 */
      edge_image_ids: edgeImageIds,
      /* R-59：不写【印文简体字】键（新建行逐键输出无该键）。 */
      seal_name: clean.seal_name,
      dynasty: clean.dynasty, // 广场筛选维度：真实写入
      seal_type: clean.category, // 印面内容（R-30）：印面级真源
      face_style: clean.faceStyle, // 印面风格（R-31）：新键，印面级
      seal_class: clean.sealClass, // 印章大類（**印面级**新键；**无回落**）
      author: clean.author,
      /* **作者引用型（person-model §4.1）**：新建印面落可空引用。 */
      author_person_id: clean.authorPersonId,
      transcription: clean.transcription,
      source: MANUAL_SOURCE,
      uploaded_by: actor.id,
      created_at: at,
      updated_at: at
    })
    const faceRows = [writeFace(faceId, FACE_KIND.FACE, faceImageRow.row.id, [])]
    if (edgeImageRow) {
      faceRows.push(writeFace(edgeFaceId, FACE_KIND.EDGE, null, [edgeImageRow.row.id]))
    }
    saveFaceRows([...listFaceRows(), ...faceRows])

    const images = [...listImageRows()]
    return {
      ok: true,
      deduped: false,
      seal: sealWritten.row,
      face: faceRows[0],
      faces: faceRows,
      images: images.filter((row) => row.stamp_id === stampId),
      stampId,
      faceId,
      edgeFaceId: edgeFaceId || '',
      message: `已新增印章《${sealDisplayName(clean)}》（${stampId}）與 ${faceRows.length} 個印面`
    }
  } catch (err) {
    await rollbackTo(before, beforeImageIds)
    return {
      ok: false,
      reason: 'ERROR',
      message: `上傳印章失敗：${(err && err.message) || '未知原因'}（已回滾，未產生半成品記錄）`
    }
  }
}

/* --------------------------- ④ 审核勘误（管理员） --------------------------- */

/**
 * 全部用户的 `PENDING` 勘误（管理员审核队列）。
 *
 * **读入口改为结构化拒绝**（2026-09-20 收口｜Zang 裁定）：非管理员**不再抛 `PermissionError`**，
 * 改返回 `{ok:false, reason:'FORBIDDEN', message}` —— 依据 §3.12.10(c)（`FORBIDDEN` 为越权**唯一**
 * 字面值、服务层与数据层**同字面值**）＋ §3.12.10 表下注 ④（**一切拒绝须为结构化拒绝**，
 * 不得以未捕获异常替代）。
 *
 * 返回形状：**两个分支都是结构化的**（不是「数组 or 对象」的联合形态）。
 * 唯一消费方 `services/corrections.js::listPendingForAdmin` 已同步解包，**对外仍是数组**，
 * 故 `MyCorrectionsView.vue` 等调用点**不破**（逐处登记见 `qa-recheck/kong-fix2-20260920/`）。
 * @returns {{ok:true, rows:Array<object>}|{ok:false, reason:'FORBIDDEN', message:string}}
 */
export function listPendingCorrectionRowsForAdmin(actor) {
  if (!actor || actor.role !== 'admin') {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以查看全部用戶的待審勘誤' }
  }
  const rows = listCorrectionRows()
    .filter((row) => normalizeCorrectionStatus(row.status) === 'PENDING')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  return { ok: true, rows }
}

/**
 * 审核勘误的状态写（数据层写方法⑤）：仅管理员；只允许 `PENDING → ACCEPTED / REJECTED`。
 * **奖励的发放不在这里**（`points.awardCorrectionReward` 负责幂等，服务层 `review` 串起来）。
 *
 * 第 4 参 `note`（**可选，默认空串**）：**仅「驳回且有理由」**时把新键 `review_note` 写进行上；
 * 采纳 / 单条驳回不传理由 ⇒ 行上**不出现该键**（读路径须容忍「无 `review_note` 键」的行）。
 * `note` 非字符串 / 去空白后超 200 字 ⇒ `INVALID_VALUE` ＋ **零写入**（判定在任何写入之前）。
 * 既有三态语义 / 幂等 / reason 字面值 / 零写入纪律**逐字不变**。
 * @param {string} [note=''] 驳回理由（≤200 字；仅驳回时落盘）
 * @returns {{ok:boolean, row?:object, status?:string, accepted?:boolean, reason?:string, message:string}}
 */
export function writeCorrectionDecision(actor, correctionId, decision, note = '') {
  const denied = forbiddenFor(actor, '僅管理員可以審覈勘誤')
  if (denied) return denied
  /* 理由值域门（**写之前**）：非文字 / 超 200 字 ⇒ 结构化拒绝 ＋ 零写入。
     与「单条驳回不写理由」不冲突：默认空串放行，且空串不落 `review_note` 键。 */
  const rawNote = note === null || note === undefined ? '' : note
  if (typeof rawNote !== 'string') {
    return { ok: false, reason: 'INVALID_VALUE', message: '駁回理由必須是文字；該勘誤狀態未變更。' }
  }
  const noteText = rawNote.trim()
  if (noteText.length > 200) {
    return { ok: false, reason: 'INVALID_VALUE', message: '駁回理由不得超過 200 字；該勘誤狀態未變更。' }
  }
  const rows = listCorrectionRows()
  const target = rows.find((row) => row.id === correctionId)
  if (!target) return { ok: false, reason: 'NOT_FOUND', message: '未找到該勘誤' }
  if (normalizeCorrectionStatus(target.status) !== 'PENDING') {
    return { ok: false, reason: 'ALREADY_REVIEWED', message: '該勘誤已審覈，不可重複處理' }
  }
  /* **R-49 第 2 条（值域门）**：`decision` 不在冻结三态的可迁移值之内 ⇒ `INVALID_VALUE` ＋ 零写入。
     改前是 `normalizeCorrectionStatus(decision) === 'ACCEPTED'` 的**二者择一**写法 ⇒ 传
     `'ACEPTED'` 这类错字会被**静默当「驳回」写进去**（管理员以为采纳了，勘误却被驳回）——
     与「静默丢弃键」同族（**静默归一**），故一并纳入本单。 */
  const normalizedDecision = normalizeCorrectionStatus(
    decision === null || decision === undefined ? '' : String(decision).trim()
  )
  if (normalizedDecision !== 'ACCEPTED' && normalizedDecision !== 'REJECTED') {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message:
        `審覈決定「${String(decision === null || decision === undefined ? '' : decision)}」不在允許的 2 類之內` +
        '（ACCEPTED 採納 / REJECTED 駁回；舊字面值 APPROVED 按採納兼容），已拒絕寫入；該勘誤狀態未變更。'
    }
  }
  const accepted = normalizedDecision === 'ACCEPTED'
  /* 第二道门（R-20 / R-30 / R-31：勘误**采纳后写回**面）：被采纳的值必须 ∈ 真源。
     旧勘误单里遗留的非值域值（如朝代的 `漢`、印面内容的 `吉語印`）**不得**被采纳写回
     ⇒ 结构化拒绝 `INVALID_VALUE` + 零写入；管理员应改判「驳回」（驳回不受本门约束）。
     R-21 / R-32 保护的是**既有行的值**，不是新采纳值。 */
  if (accepted) {
    const field = String(target.field || '')
    const fieldDenial =
      field === 'dynasty'
        ? dynastyValueDenial(target.value)
        : field === 'seal_type'
          ? faceContentValueDenial(target.value)
          : field === 'face_style'
            ? faceStyleValueDenial(target.value)
            : null
    if (fieldDenial) {
      return {
        ok: false,
        reason: fieldDenial.reason,
        correctionId: target.id,
        field: target.field,
        value: String(target.value === undefined || target.value === null ? '' : target.value),
        message: `${fieldDenial.message}（該勘誤建議「駁回」）`
      }
    }
  }
  const status = accepted ? 'ACCEPTED' : 'REJECTED'
  const at = nowIso()
  /* **仅驳回且有理由**才落 `review_note`（采纳 / 空理由不出现该键）。 */
  const writeNote = !accepted && noteText !== ''
  const decidedRow = {
    ...target,
    status,
    reviewed_at: at,
    reviewer_id: actor.id,
    ...(writeNote ? { review_note: noteText } : {})
  }
  saveCorrectionRows(rows.map((row) => (row.id === correctionId ? decidedRow : row)))
  return {
    ok: true,
    row: decidedRow,
    status,
    accepted,
    message: accepted ? '已採納該勘誤' : '已駁回該勘誤'
  }
}

/** 给已采纳的勘误打「奖励已发」标记（同一勘误只发一次，见 §7.4）。 */
export function markCorrectionRewarded(actor, correctionId, at = nowIso()) {
  const denied = forbiddenFor(actor, '僅管理員可以審覈勘誤')
  if (denied) return denied
  const rows = listCorrectionRows()
  if (!rows.some((row) => row.id === correctionId)) {
    return { ok: false, reason: 'NOT_FOUND', message: '未找到該勘誤' }
  }
  saveCorrectionRows(rows.map((row) => (row.id === correctionId ? { ...row, rewarded_at: at } : row)))
  return { ok: true, message: '已記錄勘誤獎勵發放' }
}

export { ensureSeed }
