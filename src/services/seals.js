/**
 * 玺爱 · 印章与印面读取服务
 *
 * 层级（canonical）：印章 `seal` 1 对 N 印面 `face`；边款是 `kind = EDGE` 的特殊印面。
 * 三类属性按**印面**归属：可标记属性（印文简体字 / 印文古字 / 朝代 / **印面内容 `seal_type`** /
 * **印面风格 `face_style`** / 作者 / 印文释义）、影像属性（实物照片，见 photos.js）、
 * 印面级固定属性（印面图片 / 边款图片 ID）。
 * **R-32（2026-09-20）**：【材质】`material` 自印面级移入**印章级**固定属性
 * （真源＝印章行；印章级入口 `updateSealAttributes`；旧印面行的值保留不改写，读值按
 * 「印章行 ⇒ 主印面旧值 ⇒ 空串」回落）。
 * **R-30 / R-31**：【印面内容】键仍是 `seal_type`（印面级真源；印章行同名字段＝主印面镜像，
 * 仅在印面行空时作为读值回落）；【印面风格】是新键 `face_style`（印面级，无回落）。
 * **R-34**：`listSeals` 的 `content` / `style` **按印面聚合**筛（任一印面命中即命中）。
 * **R-44**：主印面口径 ＝ 「该印章 `kind = 'FACE'` 的印面中，**存储顺序第一个**」。
 * 该规则**由数据层单点实现**（`db.primaryFaceIn`），本服务只消费，
 * **不自写第二份 `find(kind === 'FACE')`**（契约纪律 R-25：同一语义不得多处各自实现）。
 *
 * 兼容说明：印面行同时带规范字段名 `id` / `sealId` / `kind` 与既落盘视图在用的
 * `stamp_id` 别名（＝`sealId`）；印章行保留 `stamp_id`，并另给规范字段名
 * `id` / `name` / `category` 作别名。
 */

import {
  listSealRows,
  listFaceRows,
  listImageRows,
  createSealWithFaceRows,
  /* **上傳成功後的雲端快照併入（本單唯一併入點）**：`finishSealWithFace` 成功收口時把
     服務端下發的 seal / face / image 行寫進當前內存快照 ⇒ 新章立即可開（不等下一輪水合）。 */
  mergeCloudSnapshotRows,
  writeFaceFixedAttributes,
  writeSealFixedAttributes as dbWriteSealFixedAttributes,
  replaceFaceImage as dbReplaceFaceImage,
  readImageDataUrl,
  toUint8Array,
  /* 读路径回落（R-30 / R-31 / R-32）：口径真源在数据层，本服务只消费，**不自写第二套回落**。 */
  faceContentValue,
  faceStyleValue,
  sealClassValue,
  sealMaterialValue,
  /* 主印面口径（R-44）单点实现也在数据层：本服务只消费，不自写第二份 `find(kind === 'FACE')`。 */
  primaryFaceIn,
  /* **作者显示名单点（§3.54.9）**：`author_person_id` → 印人 display_name → 旧 `author` →
     「佚名」的真源函数（数据层单点）。本服务只**消费**它派生视图模型的 `author_display`
     （供卡片以外的读面 / 文本导出同链取名），**不自写第二套名表**。 */
  resolveAuthorName,
  sliceMetaOf as dataSliceMetaOf, // 切片元数据**确定性派生**（同 id 必同结果）——本服务不自写切位
  sliceWindowsOf as dataSliceWindowsOf, // 由元数据派生**逐块归一化窗口**（几何唯一真源）
  /* **印章批 3（v1.55｜§3.55 ＋ §4.1.17）**：印章外部導入行的讀 / 寫 ＋ 冪等鍵 ＋ 影像引用讀面
     ＋ 單寫者門 ＋ id 派生（既有實現，轉口復用）。 */
  listSealImportRows,
  saveSealImportRows,
  sealImportBySourceKey,
  sealBySourceKey,
  imageRowByRef,
  sealImportDirectWriteDenial,
  nextFaceId,
  /* **識別編碼四鍵（窄單補未落項）**：導入採納的本機鏡像行也要補 `seal_no` / `sid` / `face_no` / `fid`
     ⇒ 號源規劃**複用數據層單點**（`reserveSealNo` / `planFaceNumbers`，不自寫第二套）。
     （原導入的 `nextSealStampId` 已被 `reserveSealNo` ＋ `encodeSealCode` 取代 ⇒ 不再導入。） */
  reserveSealNo,
  planFaceNumbers,
  saveSealRows,
  saveFaceRows,
  /* **清除本機資料（Kevin 2026-11-06）**：執行點與孤兒印章行讀數都只在數據層有一份，
     本服務只轉口（視圖一律經服務層，不直碰 `data/*`）。 */
  clearLocalDatabase as dbClearLocalDatabase,
  localOrphanSealReadout as dbLocalOrphanSealReadout,
  /* **上傳即入册（本單）**：影像行 `id` 改寫成雲端內容尋址編號時的整表落盤
     （與 `insertImageRow` 同一寫入口，不另立第二套存儲寫）。 */
  saveImageRows,
  /* **上傳印章即上雲（本單）**：寫前校驗面（雲端 / 本地共用同一道門）＋ 鏡像行落盤要用的
     `MANUAL_SOURCE` 與顯示名單點（不自寫第二套名表 / 第二套門）。 */
  planSealWithFaceInput,
  MANUAL_SOURCE,
  sealDisplayName,
  PermissionError
} from '../data/db.js'
/* **識別編碼（sid / fid）純函數**：`src/utils/codeId.js`（與雲函數副本**逐字節相同**）。
   該文件是**雙端同段代碼**（不寫 `export`，見其文件頭「雙端可載紀律」）⇒ 前端只能**副作用導入**、
   API 掛 `globalThis.__XIAI_CODE_ID__`。 */
import '../utils/codeId.js'
const CODE_ID = globalThis.__XIAI_CODE_ID__ || {}
import { currentUser } from '../data/session.js'
import {
  FACE_KIND,
  SLICE_META_FIELD,
  /* **印章批 3（v1.55｜§3.55 ＋ §4.1.17）**：印章導入行三態 / 鍵前綴 / 字段真源 / 指紋。 */
  SEAL_IMPORT_STATUS,
  SEAL_IMPORT_IMAGE_STATUS,
  SEAL_IMPORT_ID_PREFIX,
  SEAL_IMPORT_SEAL_FIELDS,
  SEAL_IMPORT_FACE_FIELDS,
  /* **源側擴面（51 鍵｜本單 E-1）**：既有 8 鍵之外的源側字段真源 ＋ 形態門分類表。 */
  SEAL_IMPORT_SOURCE_FIELDS,
  SEAL_IMPORT_SEAL_LEVEL_FIELDS,
  SEAL_IMPORT_SOURCE_INT_FIELDS,
  SEAL_IMPORT_SOURCE_OBJECT_FIELDS,
  SEAL_IMPORT_SOURCE_RAW_FIELDS,
  emptySealImportFields,
  emptySealImportFace,
  emptySealImportSourceFields,
  sealImportFingerprint,
  /* **佔位圖（影像例外｜本單新增）**：佔位鍵 / 登記面 / 來源判據 / 來源門（提交門與採納門共用）。 */
  SEAL_PLACEHOLDER_IMAGE_KEY,
  SEAL_PLACEHOLDER_IMAGE,
  isSealBankSource,
  sealPlaceholderRefDenial
} from '../data/seed.js'
import {
  IMAGE_LIMITS,
  STORED_MAX_BYTES,
  STORAGE_MIME,
  describeBytes,
  sniffBytesMime,
  exportStoredTiff,
  windowsToPixelRects,
  rectSeamReport,
  renderSliceTiles,
  composeSliceTiles,
  decodeImageInput
} from '../utils/image.js'
import { displayDataUrlOf } from './displayImage.js'
/* **CloudBase 读取面（v1）**：云端行的展示件**服务端不可用面**下走「整件展示件」——
   判据（`cloudBaseObjectKeyOf`）/ 临时链接 / 字节取回全部收口在 `data/cloudbase.js`，
   本层只消费，**不自立第二份对象键解析**。 */
import {
  cloudBaseActive,
  cloudBaseConfigured,
  cloudBaseObjectKeyOf,
  cloudBaseReadOf,
  cloudBaseStatus,
  cloudObjectBytesOfRow,
  retryCloudBaseHydration
} from '../data/cloudbase.js'
import { bytesToDataUrl } from '../data/assetmeta.js'
/* **占位圖（本單新增｜影像例外）**：`placeholder/seal-no-image` 的字节只在**随包资产**里；
   判据（登记键）与字节读取收口在 `sealPlaceholderAsset.js`，本层只消费。 */
import { isSealPlaceholderImageRow, loadSealPlaceholderBytes } from './sealPlaceholderAsset.js'
/* **K-P5b（2026-09-23｜讀取面雙路分流）**：行級分流判據的唯一真源在 `imageAuthority.js`
   （行內有 digest 且二進制在服務端權威庫 ⇒ `digest`；否則 ⇒ `local`）。本層只消費，不自立第二把尺子。 */
import { digestOfRow, readViaOfRow, artifactObjectKeyOf, storeArtifactBytes, AUTHORITY_STORAGE_SERVER } from './imageAuthority.js'
/* **搜索面扩展（§3.54.9｜单点）**：关键字面扩到印人「姓 / 名 / 字 / 号 / 别名 / cbdb_id」——
   复用印人检索的**唯一实现** `persons.searchPersons`（**不另造第二套同名逻辑**）；命中印人 ⇒
   该印人（`author_person_id`）名下的印章一并命中。 */
import { searchPersons } from './persons.js'
/* **印章批 3（v1.55）**：印章導入 / 採納 op 走**同一登錄令牌寫面門** `userWriteGate`
   （與 `corrections` / `persons` **同一通道**：含令牌自愈 / dev·離線 與 雲端 兩形態 /
   失敗零寫入 / 本機鏡像回寫）。 */
import { userWriteGate } from './userWrite.js'
/* **E-4/E-5（阶段乙｜2026-10-12）**：写面形态真源（`local-dev` ⇒ 本机面 ＝ 本机权威；
   `cloud` ⇒ 只认服务端回包）。**不自造第二套判据**。 */
import { WRITE_FACE_MODES, writeFaceMode } from '../data/writeFaceMode.js'

export { FACE_KIND }

/* ============================================================================
   **面角色（口徑真源：`docs/face-layer-ruling-2026-11-14.md` §三 / §四｜單點）**
   ----------------------------------------------------------------------------
   上屏只有兩個詞，**判定只用 `is_primary`**：`is_primary === true` ⇒ `base face`；
   其餘**所有**面 —— 不論 DB 內 `kind` 是 `FACE` 還是 `EDGE` —— ⇒ `side face`。
   `kind` 從此只是內部實現細節（不參與上屏分類、不作篩選 / 標籤 / 彈窗選項；數據值
   `FACE` / `EDGE` 一字不動，零遷移）。**角色判定 / 標籤文案 / 面塊次序都只在本檔實現**，
   視圖只消費，不得自寫第二份。
   ============================================================================ */

/** 上屏面角色字面值（全站只此兩個；`SealDetailView` / 彈窗一律引用本常量）。 */
export const FACE_ROLE_BASE = 'base face'
export const FACE_ROLE_SIDE = 'side face'

const ORDINALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/** `is_primary` 真值三形態（服務端 `true` / 舊行字符串 `'true'` / 數值 `1`）。 */
function isPrimaryFlagged(row) {
  if (!row) return false
  return row.is_primary === true || row.is_primary === 'true' || row.is_primary === 1
}

/** 可标记属性（勘误对象）在印面上的键名（R-30：`seal_type` ＝【印面内容】）。 */
const MARKABLE_KEYS = [
  'seal_name',
  'dynasty',
  'seal_type',
  'author',
  'transcription'
]

/**
 * 面角色（`base face` / `side face`）—— **判定單點**（裁定件 §三）。
 *
 * · `is_primary === true`（三形態真值）⇒ `base face`；
 * · 其餘一律 `side face` —— **含 DB 內 `kind = 'EDGE'` 的行**（`kind` 不參與上屏分類）；
 * · 兜底（僅當整章**都沒** `is_primary`：本機示範資料 / 極舊行）⇒ 按數據層既有主面口徑
 *   `primaryFaceIn` 取一枚作 `base face`，**不另立第二套判據**。
 *
 * @param {object} face 印面（原始行 / 視圖模型皆可）
 * @param {Array<object>} [siblings] 同章印面集合（兜底分支用；缺省 ⇒ 只按 `is_primary` 判）
 * @returns {string} `base face` | `side face`
 */
export function faceRoleOf(face, siblings) {
  if (isPrimaryFlagged(face)) return FACE_ROLE_BASE
  const list = Array.isArray(siblings) ? siblings.filter(Boolean) : []
  if (list.length && !list.some(isPrimaryFlagged)) {
    const primary = primaryFaceIn(list)
    if (primary && face && String(primary.id) === String(face.id)) return FACE_ROLE_BASE
  }
  return FACE_ROLE_SIDE
}

/**
 * 面標籤（**上屏單點**）：`base face` / `side face 一`、`side face 二`（序號按**同角色**計，
 * 次序與面塊顯示次序同源）。視圖不得自寫第二份標籤拼裝。
 *
 * @param {object} face 印面
 * @param {Array<object>} [siblings] 同章印面集合（次序即 `sortFacesForDisplay` 的產物）
 */
export function faceLabelOn(face, siblings) {
  const list = Array.isArray(siblings) ? siblings.filter(Boolean) : []
  const role = faceRoleOf(face, list)
  if (role === FACE_ROLE_BASE) return FACE_ROLE_BASE
  const sameRole = list.filter((item) => faceRoleOf(item, list) === role)
  const index = sameRole.findIndex((item) => String(item.id) === String(face && face.id))
  return `${role} ${ORDINALS[index] || String(index + 1)}`
}

/**
 * 面塊顯示次序（裁定件 §四｜**全站唯一排序點**）：`base face` 最先 ⇒ 其餘按 `face_no` 升序
 * （無 `face_no` 的行排在同組末尾，彼此保持原序 ⇒ 同章穩定）。
 */
export function compareFaceDisplayOrder(a, b) {
  const rankA = isPrimaryFlagged(a) ? 0 : 1
  const rankB = isPrimaryFlagged(b) ? 0 : 1
  if (rankA !== rankB) return rankA - rankB
  const noA = Number(a && a.face_no)
  const noB = Number(b && b.face_no)
  const hasA = Number.isFinite(noA)
  const hasB = Number.isFinite(noB)
  if (hasA && hasB) {
    if (noA === noB) return 0
    return noA < noB ? -1 : 1
  }
  if (hasA) return -1
  if (hasB) return 1
  return 0
}

/** 排序入口（**不就地改動入參**；唯一調用點見 `listFacesOf`）。 */
export function sortFacesForDisplay(faces) {
  return (Array.isArray(faces) ? faces.slice() : []).sort(compareFaceDisplayOrder)
}

/* -------------------------------- 印面 -------------------------------- */

/**
 * 把一行印面组装为视图模型。
 * 固定属性里指向影像的编号会在这里解析成影像行；解析不到的编号单独列出，
 * 供页面给出**可读空态**（不得静默忽略）。
 *
 * **R-30 / R-31 / R-32（2026-09-20）**：
 *   - `seal_type`（【印面内容】）在本视图模型上给的是**读值**：印面行原值；印面行为空 ⇒
 *     回落该印章行的镜像值（老数据常见形态）；仍空 ⇒ 空串。**落盘值一个字都不动**；
 *   - `face_style`（【印面风格】新键）：**无回落** —— 印面行没有该字段 ⇒ 空串
 *     （不从 `seal_style` / 印章行取任何值）；
 *   - `material`（材质）**不在本视图模型上做回落**（R-32 起它是**印章级**属性）：
 *     印面行上的 `material` 是历史遗留值，如实回读，印章级读值见印章视图模型 / `fixedAttributesOf`。
 */
export function faceViewModel(row) {
  const images = listImageRows()
  const byId = (id) => images.find((img) => img.id === id) || null
  const sealId = row.sealId || row.stamp_id || ''
  const edgeIds = Array.isArray(row.edge_image_ids) ? row.edge_image_ids.map((id) => String(id)) : []
  const edgeImages = edgeIds.map(byId).filter(Boolean)
  const sealRow = sealId
    ? listSealRows().find((item) => String(item.stamp_id || item.id || '') === sealId) || null
    : null
  return {
    ...row,
    id: row.id, // 规范字段：印面主键
    sealId, // 规范字段：所属印章
    stamp_id: sealId, // 兼容别名：＝sealId，勿删
    kind: row.kind, // FACE＝印面 / EDGE＝边款
    isEdge: row.kind === FACE_KIND.EDGE,
    /* 【印面内容】读值（R-30）：印面行 `seal_type` 空 ⇒ 回落印章行镜像 ⇒ 仍空 ⇒ 空串。 */
    seal_type: faceContentValue(row, sealRow),
    /* 【印面风格】读值（R-31）：新键，**无回落**（旧行 ⇒ 空串）。 */
    face_style: faceStyleValue(row),
    /* 【大類】读值：**印面级新键、无回落**（旧行 ⇒ 空串；不从印章行或其它键取任何值）。 */
    seal_class: sealClassValue(row),
    faceImage: byId(row.face_image_id), // 固定属性「印面图片」解析结果
    edgeImages, // 固定属性「边款图片 ID」解析结果
    /* **作者显示名（§3.54.9｜单点派生）**：`author_person_id` → 印人 display_name → 旧 `author`
       →「佚名」；供文本导出等按印面取名（**同一单点**，不另写名表）。 */
    author_display: resolveAuthorName(row),
    missingEdgeIds: edgeIds.filter((id) => !byId(id)) // 解析不到的编号 ⇒ 页面出空态
  }
}

/**
 * 某印章的全部印面 —— **顯示次序的唯一定序點**（裁定件 §四）：`base face` 最先 ⇒ 其餘按
 * `face_no` 升序。全部讀面（詳情頁面塊 / 卡片 / 導出）都經本函數 ⇒ 不得到各處再排一遍。
 */
export function listFacesOf(sealId) {
  return sortFacesForDisplay(
    listFaceRows()
      .filter((row) => (row.sealId || row.stamp_id) === sealId)
      .map(faceViewModel)
  )
}

export function getFaceById(faceId) {
  const row = listFaceRows().find((item) => item.id === faceId)
  return row ? faceViewModel(row) : null
}

/**
 * 主印面（**R-44 冻结口径**：`kind = 'FACE'` 的印面中**存储顺序第一个**）。
 * 无 `FACE` ⇒ 退回**存储顺序第一个印面**；一个印面都没有 ⇒ `null`。
 *
 * 规则本身由数据层 `primaryFaceIn` **单点实现**，本函数只做「取该印章的印面序列 + 兜底」。
 */
export function primaryFaceOf(sealId) {
  const faces = listFacesOf(sealId)
  return primaryFaceIn(faces) || faces[0] || null
}

/** 印面标签（**上屏單點**）：`base face` / `side face 一`（同角色序號；裁定件 §三 / §四）。 */
export function faceLabelOf(faceId, sealId = '') {
  const rows = listFaceRows()
  if (faceId) {
    const row = rows.find((item) => item.id === faceId)
    if (row) {
      const sealKey = row.sealId || row.stamp_id
      /* 同章全部面（**保持存儲序** ⇒ 序號穩定；次序本身由 `listFacesOf` 單點負責）。 */
      const siblings = rows.filter((item) => (item.sealId || item.stamp_id) === sealKey)
      return faceLabelOn(row, siblings)
    }
  }
  if (sealId) {
    /* 主印面行选择收敛到 `primaryFaceIn`（R-44），范围按该印章限定（与改前同谓词）。 */
    const primary = primaryFaceIn(
      rows.filter((item) => (item.sealId || item.stamp_id) === sealId)
    )
    if (primary) return faceLabelOf(primary.id)
  }
  return '印面歸屬待考'
}

/* -------------------------------- 印章 -------------------------------- */

/** 印面级取值，缺值时回落到印章行（兼容既落盘种子）。 */
function markableValue(primary, sealRow, key) {
  const faceValue = primary ? primary[key] : ''
  if (faceValue !== undefined && faceValue !== null && faceValue !== '') return faceValue
  const sealValue = sealRow ? sealRow[key] : ''
  return sealValue === undefined || sealValue === null ? '' : sealValue
}

/**
 * **整枚印章圖**（裁定件 §三｜單點）：`xiai_images` 中 `stamp_id` 指向本印章、且**未被任何面行**
 * 的 `face_image_id` / `edge_image_ids` 引用的影像行 —— 按影像行 `seq` **升序**（§3.89.4 ＋ AC-751）。
 * 頁面把它排在所有面塊**之後**（無面掛載的圖排最後，裁定件 §一.3）。
 *
 * @param {Array<object>} faces 本章印面（原始行 / 視圖模型皆可）
 * @param {Array<object>} images 本章影像行（`xiai_images`，已按 `stamp_id` 限定）
 * @returns {Array<object>} 未被任何面引用的影像行
 */
export function wholeSealImagesOf(faces, images) {
  const referenced = new Set()
  ;(Array.isArray(faces) ? faces : []).forEach((face) => {
    if (!face) return
    if (face.face_image_id) referenced.add(String(face.face_image_id))
    const ids = Array.isArray(face.edge_image_ids) ? face.edge_image_ids : []
    ids.forEach((id) => {
      if (id) referenced.add(String(id))
    })
  })
  /* **排序口徑（§3.89.4 ＋ AC-751）**：按影像行 `seq` **升序**（不是 `id` 的字典序 —— 內容尋址
     `img-<sha16>` 與 `seq` 無關，按 `id` 排會讓 seq 2 的圖落到 seq 9 之後）。
     · `seq` 缺失 / 非整數 ⇒ **排到最後**（不丟行 —— 不丟圖是硬要求），組內以 `id` 升序；
     · `seq` 相同 ⇒ 以 `id` 升序作穩定次級鍵（排序結果可重現，不依賴 V8 的穩定排序實作細節）。 */
  const seqOf = (row) => {
    const raw = row ? row.seq : undefined
    if (raw === null || raw === undefined) return null
    if (typeof raw === 'string' && raw.trim() === '') return null
    const value = typeof raw === 'number' ? raw : Number(raw)
    return Number.isInteger(value) ? value : null
  }
  return (Array.isArray(images) ? images : [])
    .filter((row) => row && row.id && !referenced.has(String(row.id)))
    .slice()
    .sort((a, b) => {
      const leftSeq = seqOf(a)
      const rightSeq = seqOf(b)
      if (leftSeq !== null && rightSeq !== null && leftSeq !== rightSeq) return leftSeq - rightSeq
      /* 一方缺 `seq` ⇒ 缺者靠後（非對稱判，避免兩者都缺時誤排） */
      if (leftSeq === null && rightSeq !== null) return 1
      if (leftSeq !== null && rightSeq === null) return -1
      const left = String(a.id)
      const right = String(b.id)
      if (left === right) return 0
      return left < right ? -1 : 1
    })
}

/**
 * 将印章行与印面、影像组装为页面视图模型，并按筛选条件过滤。
 *
 * **R-34（2026-09-20｜按印面聚合筛）**：参数名逐字＝`{ dynasty, content, style, keyword }`。
 *   - `dynasty`：**仍按印章行**判（`row.dynasty`；读路径不做值域校验，旧值可筛）；
 *   - `content`（【印面内容】）/ `style`（【印面风格】）：**按该印章的任一印面命中即算命中**
 *     —— 逐印面取读值（＝印面行 `seal_type`（空则回落印章行镜像）/ 印面行 `face_style`），
 *     只要有一个印面的读值等于所筛值即命中。**印章行上的 `seal_type` 镜像不单独参与命中**
 *     （它只通过「印面行空 ⇒ 回落」这条路径进入命中判定）；
 *   - `keyword`：**搜索面不变**（印文 / 印文简体字 / 作者 / 印章编号 / 各印面印文与简体字）；
 *   - 兼容别名：**旧参数名 `sealType`**（旧调用点仍在用）同义于 `content`；两者都非空时
 *     `content` 优先。新调用点**一律用 `content` / `style`**。
 *
 * 视图模型新增 / 变更的字段（R-30 / R-31 / R-32）：
 *   - `material`：**印章级**材质读值（印章行 `material`；空 ⇒ 回落主印面（`kind = FACE`）旧值）；
 *   - `face_style`：主印面的【印面风格】读值（无回落 ⇒ 旧行空串）；
 *   - `seal_type` / `category`：沿用既有口径（印面级真源读值，空则回落印章行镜像）。
 */
export function listSeals({ dynasty = '', content = '', style = '', sealClass = '', sealType = '', keyword = '' } = {}) {
  const kw = String(keyword || '').trim()
  const wantContent = String(content || sealType || '').trim()
  const wantStyle = String(style || '').trim()
  const wantClass = String(sealClass || '').trim()

  /* **搜索面扩展（§3.54.9｜单点）**：关键字命中印人的「姓 / 名 / 字 / 号 / 别名 / cbdb_id」⇒
     该印人（`author_person_id`）名下的印章一并命中。印人检索**单点复用** `persons.searchPersons`
     （**不另造第二套同名逻辑**）；空关键字 ⇒ 不检索（`null`，零取数）。 */
  const matchedPersonIds = kw
    ? new Set(
        searchPersons(kw)
          .map((row) => String((row && (row.id || row.code)) || ''))
          .filter(Boolean)
      )
    : null

  return listSealRows()
    .map((row) => {
      const faces = listFacesOf(row.stamp_id)
      const primary = primaryFaceIn(faces) || faces[0] || null
      const edges = faces.filter((face) => face.kind === FACE_KIND.EDGE)
      const edgeImages = edges.reduce((acc, face) => acc.concat(face.edgeImages), [])
      /* 本章影像行（`xiai_images`）—— 整枚印章圖 與影像讀數共用同一份集合（**只讀一次**）。 */
      const stampImages = listImageRows().filter((img) => img.stamp_id === row.stamp_id)
      const resolved = {}
      MARKABLE_KEYS.forEach((key) => {
        resolved[key] = markableValue(primary, row, key)
      })
      /* 聚合判据（R-34）：逐印面取**读值**（视图模型上的 `seal_type` / `face_style` 已是读值，
         印面行为空时已回落印章行镜像）。边款（kind = EDGE）是「特殊印面」，同样参与聚合。 */
      const faceContents = faces
        .map((face) => (face.seal_type === undefined || face.seal_type === null ? '' : String(face.seal_type)))
        .filter(Boolean)
      const faceStyles = faces
        .map((face) => (face.face_style === undefined || face.face_style === null ? '' : String(face.face_style)))
        .filter(Boolean)
      /* 【大類】聚合判据：逐印面取**读值**（无回落 ⇒ 印面行原值），任一命中即命中（R-34 同口径）。 */
      const faceClasses = faces
        .map((face) => (face.seal_class === undefined || face.seal_class === null ? '' : String(face.seal_class)))
        .filter(Boolean)
      /* **作者显示名（§3.54.9｜单点派生）**：`author_person_id` → 印人 display_name → 旧 `author`
         →「佚名」；卡片 / 详情 / 导出 / 文本导出**同一单点**（数据层 `resolveAuthorName`），
         本服务不另写第二套名表。 */
      const authorDisplay = resolveAuthorName({
        author: resolved.author,
        author_person_id: (primary && primary.author_person_id) || ''
      })
      return {
        view: {
          ...row,
          id: row.stamp_id, // §4.1.1 规范字段名（印章主键）
          name: row.seal_name, // 兼容别名（＝印文 `seal_name`；「印章名称」概念已删，可空）
          category: row.seal_type, // §4.1.1 规范字段名（分类＝印面内容）
          /* 印章级固定属性【形制】（R-22）：**如实读**；既有行没有该字段 ⇒ **空串**
             （**不得**回落成任何默认文字 / 编造值，展示层的「未设置」由 UI 决定）。 */
          shape: typeof row.shape === 'string' ? row.shape : '',
          /* 印章级固定属性【材质】（R-32）：真源＝印章行；空 ⇒ 回落主印面旧值；仍空 ⇒ 空串。 */
          material: sealMaterialValue(row, faces),
          /* 【印面风格】（R-31）：主印面读值，**无回落**（旧行 ⇒ 空串）。 */
          face_style: primary ? faceStyleValue(primary) : '',
          faces, // 印面集合（印章 1 对 N 印面）
          faceCount: faces.length,
          faceImage: (primary && primary.faceImage) || null,
          edgeFaces: edges,
          edgeImages,
          hasEdge: edges.length > 0,
          images: stampImages,
          /* **整枚印章圖（裁定件 §三）**：`stamp_id` 指向本章、且未被任何面行引用的影像行
             ⇒ 詳情頁在**所有面塊之後**單獨成區（無此圖 ⇒ 該區塊不渲染）。 */
          wholeSealImages: wholeSealImagesOf(faces, stampImages),
          /* **作者显示名（单点派生）**：供文本导出等按印章取名（**同一单点**，不另写名表）。 */
          author_display: authorDisplay,
          /* **作者引用型（person-model §4.1）**：印章行**不落引用副本**（P1-2）⇒ 印章视图模型的
             `author_person_id` 一律取**主印面的印面级引用**（单点派生，**不是**印章行自带值）——
             卡片 / 详情经单点取名（`resolveAuthorDisplayName(seal)`）因此不再依赖印章行上的引用。 */
          author_person_id: (primary && primary.author_person_id) || '',
          ...resolved
        },
        /* 判定用的**印章行原值**（不落进视图模型）：R-34 明文「dynasty 仍按印章行判」。 */
        rowDynasty: String(row.dynasty || ''),
        faceContents,
        faceStyles,
        faceClasses,
        /* **搜索面扩展（§3.54.9）**：该印章的印人引用键集合（印面级 `author_person_id`）
           ＋ 作者显示名（**单点派生** `resolveAuthorName`，与卡片 / 导出 / 文本导出同链）。 */
        authorPersonIds: faces
          .map((face) => String((face && face.author_person_id) || ''))
          .filter(Boolean),
        authorDisplay: authorDisplay
      }
    })
    .filter((item) => (dynasty ? item.rowDynasty === dynasty : true))
    .filter((item) => (wantContent ? item.faceContents.includes(wantContent) : true))
    .filter((item) => (wantStyle ? item.faceStyles.includes(wantStyle) : true))
    .filter((item) => (wantClass ? item.faceClasses.includes(wantClass) : true))
    .filter((item) => {
      if (!kw) return true
      const seal = item.view
      /* **命中印人 ⇒ 出該印人的印章（§3.54.9）**：关键字命中印人（姓 / 名 / 字 / 号 / 别名 /
         cbdb_id）⇒ 该印人（`author_person_id`）名下的印章一并命中；此处只读已算好的键集合，
         检索本身仍是单点 `persons.searchPersons`。 */
      if (matchedPersonIds && item.authorPersonIds.some((id) => matchedPersonIds.has(id))) return true
      const haystack = [
        seal.seal_name,
        seal.author,
        /* **作者显示名（单点派生）**：卡片 / 导出上屏的作者显示值同样可搜。 */
        item.authorDisplay,
        seal.stamp_id,
        ...seal.faces.map((face) => face.seal_name)
      ]
        .filter(Boolean)
        .join(' ')
      return haystack.includes(kw)
    })
    .map((item) => item.view)
}

export function getSealById(stampId) {
  return listSeals().find((seal) => seal.stamp_id === stampId) || null
}

/**
 * **按識別編碼精確查**（口径件 §5；本單新增的唯一精確入口）。
 *
 * · **判型**：首字符為數字 ⇒ `fid`（8 位）；否則 ⇒ `sid`（5 位字母）。解碼失敗 ⇒
 *   `{ok:false, reason:'INVALID_VALUE', message}`（**不解碼成功就絕不進入任何模糊路徑**）。
 * · **匹配**：decode ⇒ 按 `no` **精確等值**匹配（`seal_no` / `face_no`，或等值 `stamp_id` / `fid`）。
 *   **只做等值比較**：**不回落關鍵詞 `q`、不做子串 / 近似 / 模糊匹配**。
 * · **查無** ⇒ `{ok:false, reason:'NOT_FOUND', message:'查無此印'}`（上屏即「查無此印」空態）。
 * · 旧纯数字 / 旧 `XA…` 码在此**天然解码失败**（R-6：旧码不受理，不加任何兼容分支）。
 * @param {string} raw 識別編碼（可含小寫 / 前後空白；內部歸一大寫）
 * @returns {{ok:true, seal:object, face:object|null, code:string}
 *          |{ok:false, reason:'INVALID_VALUE'|'NOT_FOUND', message:string}}
 */
export function findSealByCode(raw) {
  const input = String(raw === undefined || raw === null ? '' : raw).trim().toUpperCase()
  if (!input) return { ok: false, reason: 'INVALID_VALUE', message: '請輸入識別編碼。' }
  if (typeof CODE_ID.decodeSealCode !== 'function') {
    return { ok: false, reason: 'INVALID_VALUE', message: '識別編碼模塊未就緒，請稍後重試。' }
  }
  const first = input.charAt(0)
  const isDigitFirst = first >= '0' && first <= '9'
  const decoded = isDigitFirst ? CODE_ID.decodeFaceCode(input) : CODE_ID.decodeSealCode(input)
  if (!decoded.ok) return { ok: false, reason: decoded.reason, message: decoded.message }
  if (isDigitFirst) {
    const face =
      listFaceRows().find(
        (row) => Number(row && row.face_no) === decoded.no || String((row && row.fid) || '') === input
      ) || null
    if (!face) return { ok: false, reason: 'NOT_FOUND', message: '查無此印' }
    const sealId = String((face && (face.stamp_id || face.sealId)) || '')
    const seal = listSealRows().find((row) => String((row && row.stamp_id) || '') === sealId) || null
    if (!seal) return { ok: false, reason: 'NOT_FOUND', message: '查無此印' }
    return { ok: true, seal, face, code: input }
  }
  const seal =
    listSealRows().find(
      (row) => Number(row && row.seal_no) === decoded.no || String((row && row.stamp_id) || '') === input
    ) || null
  if (!seal) return { ok: false, reason: 'NOT_FOUND', message: '查無此印' }
  return { ok: true, seal, face: null, code: input }
}

export function listImagesByStamp(stampId) {
  return listImageRows().filter((img) => img.stamp_id === stampId)
}

/**
 * 固定属性（**按印面归属**；**R-32 起「材质」属印章级**）。
 * 传入印面 → 该印面的两项印面级固定属性（印面图片 / 边款图片 ID），外加 `material`
 *   = **印面行上的历史遗留值**（如实回读、**不做回落、不改写**；新写入已不再落到印面级）；
 * 传入印章（兼容旧调用）→ 该印章主印面的两项印面级固定属性，外加 `material`
 *   = **印章级**读值（印章行 `material`；空 ⇒ 回落主印面旧值 ⇒ 仍空 ⇒ 空串）。
 * @returns {{face_id:string|null, face_image_id:string|null, material:string, edge_image_ids:string[]}}
 */
export function fixedAttributesOf(target) {
  const empty = { face_id: null, face_image_id: null, material: '', edge_image_ids: [] }
  if (!target) return empty
  if (target.kind) {
    /* 印面级：两项印面级固定属性；`material` 只如实回读**印面行**上的旧值
       （R-32：印面级白名单已无 `material`，此处不回落印章级 —— 印章级读值见下分支）。 */
    return {
      face_id: target.id,
      face_image_id: target.face_image_id || null,
      material: target.material || '',
      edge_image_ids: Array.isArray(target.edge_image_ids) ? target.edge_image_ids.map((id) => String(id)) : []
    }
  }
  const primary = primaryFaceOf(target.stamp_id)
  const base = primary ? fixedAttributesOf(primary) : { ...empty }
  /* 印章级分支：材质按 R-32 的读路径回落（印章行 ⇒ 主印面旧值 ⇒ 空串）。 */
  return { ...base, material: sealMaterialValue(target) }
}

/* ------------------------------ 权限判定 ------------------------------ */

/* ============================================================================
   **資料源讀數（唯讀、響應式）** —— 硬導航首屏用的「水合是否已落定」
   ----------------------------------------------------------------------------
   為什麼要有：水合是**一次性 fire-and-forget**（啟動引導拉起；快照到位後由數據層的響應式
   讀數驅動頁面重算）。硬導航（直接打開 / 刷新 `/seal/<id>`）時**首屏必然先於快照渲染** ⇒
   `getSealById()` 返回 `null`。此時若視圖直接渲染「未找到這枚印章」這類**終態**文案，
   就是在斷言一件**還沒讀到**的事（線上實據 2026-09-28：等 14 秒仍顯示「未找到這枚印章」，
   而同一份構建在本地能出內容）。
   ⇒ 視圖一律據本讀數：`pending` ⇒ 渲染**載入態**；落定（`ready` / `failed` / `off`）後才渲染
   終態。分層：狀態與判據都在數據層（`data/cloudbase.js` 的 `cloudBaseStatus()`），
   本層只**投影**成視圖可用的形狀，**不自立第二處判據**（R-25）；讀數經 `shallowRef`
   天然可追蹤 ⇒ 在視圖的 `computed` 裡讀它，水合落定時視圖自動重算（組件零手動刷新）。
   ============================================================================ */

/**
 * 當前數據源狀態（**唯讀、響應式、零 I/O**）。
 * @returns {{state:'off'|'pending'|'ready'|'failed', pending:boolean, ready:boolean,
 *   failed:boolean, off:boolean, retrying:boolean, reason:string, message:string,
 *   timeoutStage:string, attempt:number, counts:object}}
 *   - `pending`（含 `retrying`）⇒ 雲端讀取面**接管中但快照未到**：視圖**必須**渲染載入態，
 *     不得把「暫無資料」渲染成終態（未找到 / 沒有符合條件的印章）；
 *   - `ready` / `off` ⇒ 數據已可按既有語義判終態（找到 / 未找到 / 空集）；
 *   - `failed` ⇒ 已回落本地實現：**「找不到」不再是雲端的事實**，視圖應給可重試的失敗態。
 */
export function dataSourceState() {
  const status = cloudBaseStatus() || {}
  const state = typeof status.state === 'string' && status.state ? status.state : 'off'
  return {
    state,
    pending: state === 'pending',
    ready: state === 'ready',
    failed: state === 'failed',
    off: state === 'off',
    retrying: state === 'pending' && status.reason === 'HYDRATING_RETRY',
    reason: typeof status.reason === 'string' ? status.reason : '',
    message: typeof status.message === 'string' ? status.message : '',
    timeoutStage: typeof status.timeoutStage === 'string' ? status.timeoutStage : '',
    attempt: Number(status.attempt) || 0,
    counts: status.counts || { seals: 0, faces: 0, images: 0 }
  }
}

/**
 * **重新讀取雲端資料**（失敗態 / 載入過久時由界面觸發；數據層自理預算與回落規則）。
 * @returns {Promise<object>} 新一輪水合的結論（狀態讀數）
 */
export function retryDataSource() {
  return retryCloudBaseHydration()
}

export function canBrowse() {
  return true
}

export function canSubmitCorrection() {
  return currentUser() !== null
}

export function canUploadPhoto() {
  return currentUser() !== null
}

export function canDownloadHd() {
  return currentUser() !== null
}

export function canEditFixedAttributes() {
  const user = currentUser()
  return user !== null && user.role === 'admin'
}

/**
 * 当前（或指定）账号是否可**编辑印章级固定属性（形制）** —— 供详情页决定按钮是否渲染（R-22）。
 *
 * 判定口径与 `canEditFixedAttributes` / `canUploadSeal` **同一套**（项目内管理员判定的既有口径：
 * `role === 'admin'`；缺省回落到当前登录态）。**仅管理员** ⇒ 普通用户 / 游客入口不渲染，
 * 数据层另有独立拒绝（越权即便绕过 UI 也写不进去）。
 */
export function canEditSealAttributes(actor) {
  const user = actor || currentUser()
  return user !== null && user !== undefined && user.role === 'admin'
}

/** 当前（或指定）账号是否可**重新上传印面图** —— 供详情页决定按钮是否渲染。 */
export function canReplaceFaceImage(actor) {
  const user = actor || currentUser()
  return user !== null && user !== undefined && user.role === 'admin'
}

/** 当前（或指定）账号是否可**删除印章** —— 供详情页决定入口是否渲染（管理员专属）。 */
export function canDeleteSeal(actor) {
  const user = actor || currentUser()
  return user !== null && user !== undefined && user.role === 'admin'
}

/* ============================================================================ *
   **清除本機資料（管理員面｜Kevin 2026-11-06「本地不要留數據庫了」）**
   ----------------------------------------------------------------------------
   · 能力判定 `canClearLocalData`：与 `canDeleteSeal` / `canEditSealAttributes`
     **同一套**口径（`role === 'admin'`；缺省回落当前登录态）——**不另造第二把尺子**。
   · 钩子取值一律 `data-action="local-db-clear"`（**不新增 `data-admin-action` 取值**）。
   · 執行點唯一 ＝ `data/db.js::clearLocalDatabase()`（清 localStorage 資料鍵 ＋
     IndexedDB 全部物件倉），本服務只轉口；**雲端零請求、零寫入**（雲端資料不受影響）。
   · 孤兒印章行讀數 `localOrphanSealReadout()` 同理只轉口（真源在數據層覆蓋層）。
   ============================================================================ */

/** 当前（或指定）账号是否可**清除本机资料** —— 供广场 / 详情页决定入口是否渲染（管理员专属）。 */
export function canClearLocalData(actor) {
  const user = actor || currentUser()
  return user !== null && user !== undefined && user.role === 'admin'
}

/**
 * **本机有、云端快照没有**的印章行读数（顶部提示「本机有 N 枚印章不在云端」用）。
 * @returns {{count:number, ids:string[]}}
 */
export function localOrphanSealReadout() {
  return dbLocalOrphanSealReadout()
}

/**
 * **清除本机资料**（管理员入口的唯一执行点）。
 * @returns {Promise<{ok:boolean, keys:object, idb:object, messages:string[]}>}
 */
export function clearLocalDatabase() {
  return dbClearLocalDatabase()
}

/* ============================================================================ *
   **刪除印章（管理員面｜本單）**
   ----------------------------------------------------------------------------
   · 能力判定 `canDeleteSeal`：与 `canEditSealAttributes` / `canReplaceFaceImage`
     **同一套**口径（`role === 'admin'`；缺省回落当前登录态）——**不另造第二把尺子**。
   · 通道（唯一、不另造第二条）：`userWrite.js::userWriteGate` → `token.js::userGate`
     → `data/cloudbaseFn.js::callCloudFunction('xiai-user-token', …)`，与勘误 / 采纳 /
     AI 弃候选图**同一条**用户令牌写面通道；本文件不直连、不自建装载。
   · **`local-dev` / 離線形態 ⇒ 结构化拒绝 `STORAGE_UNAVAILABLE`**（照
     `aiEnhance.discardFaceImage` 先例：门放行但**未经云端** ⇒ **不做本地假成功**、
     **不编造**删数与释放读数）。
   · 成功返回**恰 4 键** `{ok:true, deleted, skipped, released}`（读数逐字取自服务端，
     零补编、零派生）；失败**原样透传**（`reason` / `message` 一字不改写）。
   ============================================================================ */

/** 雲端 op 名（与 `lib/ops.js` 注册面逐字一致）。 */
const SEAL_DELETE_OP = 'deleteSeal'

/**
 * 刪印章回包读数键面：`value` 是云函数信封的**通用读数位**（服务端把
 * `deleted` / `skipped` / `released` 三组放在这里带到前端）；后三键为直取位
 * （服务端若直接回出即原样叠出）。两处同源、**以服务端回包为准**，本文件零派生。
 */
const SEAL_DELETE_READOUT_KEYS = Object.freeze(['value', 'deleted', 'skipped', 'released'])

/**
 * **刪除一枚印章（＋編號釋放）**（仅管理员；服务端裁决）。
 *
 * 判定顺序（**全部在发出请求之前**，拒绝即零网络、零写入）：
 * ① 管理员门（`canDeleteSeal`）→ ② 印章编号形态（缺 ⇒ `INVALID_INPUT`）
 * → ③ 理由长度（>200 ⇒ `INVALID_INPUT`）→ ④ 过云端写面门（服务端再判白名单 /
 * 键面 / 行存在性）→ ⑤ `local-dev` 形态如实拒绝 → ⑥ 回包形状校验（缺读数 ⇒ 如实拒绝，
 * **不编造**删数 / 释放读数）。
 *
 * @param {{role?:string}|null} [actor] 操作者（缺省回落当前登录态）
 * @param {string} sealId 印章编号（`stamp_id` / `sid` / 行 `id` 任一形态）
 * @param {string} [reason] 删除理由（可选，≤200 字；服务端同口径复判）
 * @returns {Promise<{ok:true, deleted:object, skipped:object, released:object}
 *          |{ok:false, reason:string, message:string}>}
 */
export async function deleteSeal(actor, sealId, reason) {
  if (!canDeleteSeal(actor)) {
    return {
      ok: false,
      reason: 'NOT_ADMIN',
      message: '僅管理員可以刪除印章（前端前置；未發出任何請求、零寫入）。'
    }
  }
  const id = String(sealId === undefined || sealId === null ? '' : sealId).trim()
  if (!id) {
    return {
      ok: false,
      reason: 'INVALID_INPUT',
      message: '刪除印章需要印章編號（seal_id），本次未發出任何請求。'
    }
  }
  const note = String(reason === undefined || reason === null ? '' : reason).trim()
  if (note.length > 200) {
    return {
      ok: false,
      reason: 'INVALID_INPUT',
      message: '刪除理由最多 200 字，本次未發出任何請求。'
    }
  }
  const payload = { seal_id: id }
  if (note !== '') payload.reason = note

  const gate = await userWriteGate(SEAL_DELETE_OP, payload, { readoutKeys: SEAL_DELETE_READOUT_KEYS })
  /* 傳輸層 / 補簽 / 服務端結構化拒絕 ⇒ **原樣透傳**（`reason` / `message` 一字不改寫）。 */
  if (!gate || gate.ok !== true) {
    if (gate && typeof gate === 'object') return gate
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '刪除印章服務暫時不可用，請稍後再試。'
    }
  }
  if (gate.dev === true || gate.mode === 'local-dev') {
    /* dev / 離線形態：門放行但**未經雲端** ⇒ 如實結構化拒絕（不編造已刪除 / 已釋放假讀數）。 */
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: 'dev / 離線形態：未經雲端驗證，刪除印章不可用（非正式路徑；本次零寫入）。'
    }
  }
  /* **回包形状校验**：三组读数是「删了什么 / 放了什么号」的唯一凭据 ⇒ 缺位即如实拒绝。 */
  const readout = gate.value && typeof gate.value === 'object' ? gate.value : gate
  const deleted = readout.deleted
  const skipped = readout.skipped
  const released = readout.released
  if (!deleted || typeof deleted !== 'object' || !skipped || typeof skipped !== 'object' || !released || typeof released !== 'object') {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '刪除印章回包形狀不可辨識（未附刪數與編號釋放讀數），請刷新後再試。'
    }
  }
  return { ok: true, deleted, skipped, released }
}

/* ============================================================================ *
   **刪除印面影像（管理員面｜影像卡片入口｜本單）
   ----------------------------------------------------------------------------
   · Kevin 2026-11-07 定案：**换图 / 採納 AI 候選圖一律不自动删旧图**（旧行与二进制保留），
     只有管理员在**影像卡片**上显式点【刪除】才删 —— 本函数就是那一口的前端服务层。
   · 能力判定 `canDeleteFaceImage`：与 `canDeleteSeal` / `canReplaceFaceImage` **同一套**口径
     （`role === 'admin'`；缺省回落当前登录态）——**不另造第二把尺子**。
   · 通道（唯一、不另造第二条）：`userWrite.js::userWriteGate` → `token.js::userGate`
     → `data/cloudbaseFn.js::callCloudFunction('xiai-user-token', …)`，与勘误 / 删印 /
     AI 弃候选图**同一条**用户令牌写面通道。
   · **`local-dev` / 離線形態 ⇒ 结构化拒绝 `STORAGE_UNAVAILABLE`**（照 `deleteSeal` 先例：
     门放行但**未经云端** ⇒ 不做本地假成功、不编造删数）。
   · 服务端三步写入确定序（清引用 → 删行 → 删对象）与归属 / 共用 / 占位图判定**全由服务端裁决**；
     本层零判定、零补编；成功回**恰 4 键** `{ok:true, face_id, image_id, removed:{rows, objects}}`。
   · 成功即调 `invalidateImageDataUrl(imageId)` 作废该编号的 dataUrl 缓存（服务层唯一失效口）。
   ============================================================================ */

/** 雲端 op 名（与 `lib/ops.js` 注册面逐字一致）。 */
const FACE_IMAGE_DELETE_OP = 'deleteFaceImage'

/** 回包读数键面（与云函数 `index.js` 的按 op 收窄透传**逐字同集**；本文件零派生）。 */
const FACE_IMAGE_DELETE_READOUT_KEYS = Object.freeze(['face_id', 'image_id', 'removed'])

/** 当前（或指定）账号是否可**删除印面影像** —— 供详情页影像卡片决定入口是否渲染（管理员专属）。 */
export function canDeleteFaceImage(actor) {
  const user = actor || currentUser()
  return user !== null && user !== undefined && user.role === 'admin'
}

/**
 * **删除本印面那一张影像**（仅管理员；服务端裁决；**不删其它印面共用的影像**）。
 *
 * 判定顺序（**全部在发出请求之前**，拒绝即零网络、零写入）：
 * ① 管理员门（`canDeleteFaceImage`）→ ② 两编号形态（缺 ⇒ `INVALID_INPUT`）
 * → ③ 过云端写面门（服务端再判白名单 / 键面 / 归属 / 共用 / 占位图）→ ④ `local-dev`
 * 形态如实拒绝 → ⑤ 回包形状校验（缺 `removed` 读数 ⇒ 如实拒绝，**不编造**删数）。
 *
 * @param {string} faceId 印面编号（`face.id`）
 * @param {string} imageId 影像编号（`face.face_image_id`）
 * @returns {Promise<{ok:true, face_id:string, image_id:string, removed:{rows:number, objects:number}}|
 *          |{ok:false, reason:string, message:string}>}
 */
export async function deleteFaceImage(faceId, imageId) {
  if (!canDeleteFaceImage()) {
    return {
      ok: false,
      reason: 'NOT_ADMIN',
      message: '僅管理員可以刪除印面影像（前端前置；未發出任何請求、零寫入）。'
    }
  }
  const face = String(faceId === undefined || faceId === null ? '' : faceId).trim()
  const image = String(imageId === undefined || imageId === null ? '' : imageId).trim()
  if (!face || !image) {
    return {
      ok: false,
      reason: 'INVALID_INPUT',
      message: '刪除印面影像需要印面編號（face_id）與影像編號（image_id），本次未發出任何請求。'
    }
  }
  const gate = await userWriteGate(
    FACE_IMAGE_DELETE_OP,
    { face_id: face, image_id: image },
    { readoutKeys: FACE_IMAGE_DELETE_READOUT_KEYS }
  )
  /* 傳輸層 / 補簽 / 服務端結構化拒絕 ⇒ **原樣透傳**（`reason` / `message` 一字不改寫）。 */
  if (!gate || gate.ok !== true) {
    if (gate && typeof gate === 'object') return gate
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '刪除印面影像服務暫時不可用，請稍後再試。'
    }
  }
  if (gate.dev === true || gate.mode === 'local-dev') {
    /* dev / 離線形態：門放行但**未經雲端** ⇒ 如實結構化拒絕（不編造已刪讀數）。 */
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: 'dev / 離線形態：未經雲端驗證，刪除印面影像不可用（非正式路徑；本次零寫入）。'
    }
  }
  /* **回包形状校验**：`removed` 是「删了什么」的唯一凭据 ⇒ 缺位即如实拒绝（不补编 0）。 */
  const removed = gate.removed && typeof gate.removed === 'object' ? gate.removed : null
  if (!removed || typeof removed.rows !== 'number' || typeof removed.objects !== 'number') {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '刪除印面影像回包形狀不可辨識（未附 removed 刪數讀數），請刷新後再試。'
    }
  }
  const faceIdOut = typeof gate.face_id === 'string' ? gate.face_id : face
  const imageIdOut = typeof gate.image_id === 'string' ? gate.image_id : image
  /* 该编号的 dataUrl 缓存**立即作废**（服务层唯一失效口；缓存不再冒充现值）。 */
  invalidateImageDataUrl(imageIdOut)
  return {
    ok: true,
    face_id: faceIdOut,
    image_id: imageIdOut,
    removed: { rows: removed.rows, objects: removed.objects }
  }
}

/* ============================================================================
   **整枚印章圖刪除（管理員面｜裁定件 v2 §四｜本單）**
   ----------------------------------------------------------------------------
   · 口徑（裁定件 v2 §一.2 / §四）：整枚印章圖 ＝ `stamp_id` 指向本章、且**未被任何面行**
     （`face_image_id` / `edge_image_ids`）引用的影像行 ⇒ 展示 ＋ 上傳 ＋ **刪除**（本函數）。
   · 能力判定 `canDeleteWholeSealImage`：與 `canDeleteFaceImage` / `canDeleteSeal` **同一把尺子**
     （`role === 'admin'`；缺省回落當前登錄態）——**不另造第二把尺子**。
   · 通道（唯一、不另造第二條）：`userWrite.js::userWriteGate` → 雲端 op `deleteWholeSealImage`，
     與勘誤 / 刪印 / 刪印面影像**同一條**令牌寫面通道。
   · **本地先擋**（全部在發請求之前，拒絕即零網絡、零寫入）：管理員門 → 兩編號形態
     （缺 ⇒ `INVALID_INPUT`）→ `local-dev` / 離線形態結構化拒絕 → 回包形狀校驗
     （缺讀數 ⇒ 如實拒絕，**不編造**刪數）。
   · 服務端判定（全部早於寫）由服務端裁決：影像行存在、`stamp_id` 相符（防跨章誤刪）、
     **未被任何面行引用**（已被引用 ⇒ `INVALID_VALUE`，行與對象均不變）。本層零判定、零補編、
     **零新增 reason 字面值**。
   · 成功 ⇒ 該編號 dataUrl 緩存立即作廢 ＋ 重取雲端快照（與既有寫面同一刷新路徑）。
   ============================================================================ */

/** 雲端 op 名（與雲函數 `ADMIN_OPS` 註冊面逐字一致；本文件唯一出現處）。 */
const WHOLE_SEAL_IMAGE_DELETE_OP = 'deleteWholeSealImage'

/** 回包讀數鍵面（按 op 收窄透傳**逐字同集**；本文件零派生）。 */
const WHOLE_SEAL_IMAGE_DELETE_READOUT_KEYS = Object.freeze(['image_id', 'deleted_rows', 'deleted_objects'])

/** 當前（或指定）賬號是否可**刪除整枚印章圖** —— 供詳情頁該區塊決定入口是否渲染（管理員專屬）。 */
export function canDeleteWholeSealImage(actor) {
  const user = actor || currentUser()
  return user !== null && user !== undefined && user.role === 'admin'
}

/**
 * **刪除一張整枚印章圖**（僅管理員；服務端裁決；已被印面引用者服務端拒刪且保持原狀）。
 *
 * @param {{stamp_id?:string, stampId?:string, image_id?:string, imageId?:string}} [payload]
 * @returns {Promise<{ok:true, image_id:string, deleted_rows:number, deleted_objects:number}
 *          |{ok:false, reason:string, message:string}>}
 */
export async function deleteWholeSealImage(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {}
  if (!canDeleteWholeSealImage()) {
    return {
      ok: false,
      reason: 'NOT_ADMIN',
      message: '僅管理員可以刪除整枚印章圖（前端前置；未發出任何請求、零寫入）。'
    }
  }
  const stampId = String(source.stamp_id ?? source.stampId ?? '').trim()
  const imageId = String(source.image_id ?? source.imageId ?? '').trim()
  if (!stampId || !imageId) {
    return {
      ok: false,
      reason: 'INVALID_INPUT',
      message: '刪除整枚印章圖需要印章編號（stamp_id）與影像編號（image_id），本次未發出任何請求。'
    }
  }
  const gate = await userWriteGate(
    WHOLE_SEAL_IMAGE_DELETE_OP,
    { stamp_id: stampId, image_id: imageId },
    { readoutKeys: WHOLE_SEAL_IMAGE_DELETE_READOUT_KEYS }
  )
  /* 傳輸層 / 補簽 / 服務端結構化拒絕 ⇒ **原樣透傳**（`reason` / `message` 一字不改寫）。 */
  if (!gate || gate.ok !== true) {
    if (gate && typeof gate === 'object') return gate
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '刪除整枚印章圖服務暫時不可用，請稍後再試。'
    }
  }
  if (gate.dev === true || gate.mode === 'local-dev') {
    /* dev / 離線形態：門放行但**未經雲端** ⇒ 如實結構化拒絕（不編造已刪讀數）。 */
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: 'dev / 離線形態：未經雲端驗證，刪除整枚印章圖不可用（非正式路徑；本次零寫入）。'
    }
  }
  /* **回包形狀校驗**：兩個刪數是「刪了什麼」的唯一憑據 ⇒ 缺位即如實拒絕（不補編 0）。 */
  const imageIdOut = typeof gate.image_id === 'string' && gate.image_id.trim() ? gate.image_id.trim() : imageId
  const deletedRows = Number(gate.deleted_rows)
  const deletedObjects = Number(gate.deleted_objects)
  if (!Number.isFinite(deletedRows) || !Number.isFinite(deletedObjects)) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '刪除整枚印章圖回包形狀不可辨識（未附 deleted_rows / deleted_objects 讀數），請刷新後再試。'
    }
  }
  /* 该编号缓存**立即作废**（服务层唯一失效口；缓存不再冒充现值）。 */
  invalidateImageDataUrl(imageIdOut)
  /* 重取雲端快照（與本頁既有寫面**同一刷新路徑**；失敗不改變刪除結論）。 */
  try {
    await retryDataSource()
  } catch (err) {
    /* 快照重取失敗不改寫刪除讀數（行以服務端為準）。 */
  }
  return {
    ok: true,
    image_id: imageIdOut,
    deleted_rows: deletedRows,
    deleted_objects: deletedObjects
  }
}

/* ============================================================================
   **切換 base face（管理員面｜裁定件 v2 §五｜本單）**
   ----------------------------------------------------------------------------
   · 口徑（裁定件 v2 §一.3 / §五）：base face **可切換**，仍保證**每章恰一枚**（`is_primary`）。
   · 能力判定 `canSetBaseFace`：與上面同一把尺子（`role === 'admin'`）。
   · 通道：`userWrite.js::userWriteGate` → 雲端 op `setBaseFace`（同一條令牌寫面通道）。
   · **本地先擋**：管理員門 → 兩編號形態（缺 ⇒ `INVALID_INPUT`）→ `local-dev` 形態結構化拒絕
     → 回包形狀校驗（缺 `face_id` ⇒ 如實拒絕）。
   · 服務端判定 / 寫序由其裁決：目標面屬該章、`kind` 必須是 `FACE`；同參 ⇒ **零寫**（冪等，
     `previous_base_face_id` 等於目標）；否則先舊 base 置 `false`、再目標置 `true`。
     本層零判定、零補編、**零新增 reason 字面值**。
   · 成功 ⇒ 重取雲端快照（面塊的 base 徽標 / 封面圖隨之更新）。
   ============================================================================ */

/** 雲端 op 名（與雲函數 `ADMIN_OPS` 註冊面逐字一致；本文件唯一出現處）。 */
const SET_BASE_FACE_OP = 'setBaseFace'

/** 回包讀數鍵面（按 op 收窄透傳**逐字同集**；本文件零派生）。 */
const SET_BASE_FACE_READOUT_KEYS = Object.freeze(['face_id', 'previous_base_face_id'])

/** 當前（或指定）賬號是否可**切換 base face** —— 供詳情頁面塊決定入口是否渲染（管理員專屬）。 */
export function canSetBaseFace(actor) {
  const user = actor || currentUser()
  return user !== null && user !== undefined && user.role === 'admin'
}

/**
 * **把某一枚印面設為本章的 base face**（僅管理員；每章仍恰一枚）。
 *
 * @param {{stamp_id?:string, stampId?:string, face_id?:string, faceId?:string}} [payload]
 * @returns {Promise<{ok:true, face_id:string, previous_base_face_id:string}
 *          |{ok:false, reason:string, message:string}>}
 *   `previous_base_face_id` 逐字取服務端回包（同參冪等時等於目標面編號）。
 */
export async function setBaseFace(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {}
  if (!canSetBaseFace()) {
    return {
      ok: false,
      reason: 'NOT_ADMIN',
      message: '僅管理員可以切換主印面（前端前置；未發出任何請求、零寫入）。'
    }
  }
  const stampId = String(source.stamp_id ?? source.stampId ?? '').trim()
  const faceId = String(source.face_id ?? source.faceId ?? '').trim()
  if (!stampId || !faceId) {
    return {
      ok: false,
      reason: 'INVALID_INPUT',
      message: '切換主印面需要印章編號（stamp_id）與印面編號（face_id），本次未發出任何請求。'
    }
  }
  const gate = await userWriteGate(
    SET_BASE_FACE_OP,
    { stamp_id: stampId, face_id: faceId },
    { readoutKeys: SET_BASE_FACE_READOUT_KEYS }
  )
  /* 傳輸層 / 補簽 / 服務端結構化拒絕 ⇒ **原樣透傳**（`reason` / `message` 一字不改寫）。 */
  if (!gate || gate.ok !== true) {
    if (gate && typeof gate === 'object') return gate
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '切換主印面服務暫時不可用，請稍後再試。'
    }
  }
  if (gate.dev === true || gate.mode === 'local-dev') {
    /* dev / 離線形態：門放行但**未經雲端** ⇒ 如實結構化拒絕（不造假已切換讀數）。 */
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: 'dev / 離線形態：未經雲端驗證，切換主印面不可用（非正式路徑；本次零寫入）。'
    }
  }
  const faceIdOut = typeof gate.face_id === 'string' && gate.face_id.trim() ? gate.face_id.trim() : faceId
  if (!faceIdOut) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '切換主印面回包形狀不可辨識（未附印面編號 face_id），請刷新後再試。'
    }
  }
  const previous = typeof gate.previous_base_face_id === 'string' ? gate.previous_base_face_id.trim() : ''
  /* 重取雲端快照（與本頁既有寫面**同一刷新路徑**；失敗不改變切換結論）。 */
  try {
    await retryDataSource()
  } catch (err) {
    /* 快照重取失敗不改寫切換讀數（面行以服務端為準）。 */
  }
  return { ok: true, face_id: faceIdOut, previous_base_face_id: previous }
}

/* ============================================================================
   能力 6「上传印章（新增进藏品库）」（v1.3｜口径 B）

/** 当前（或指定）账号是否可上传印章 —— 供广场页决定按钮是否渲染。 */
export function canUploadSeal(actor) {
  const user = actor || currentUser()
  return user !== null && user !== undefined && user.role === 'admin'
}

function deniedResult(message) {
  return { ok: false, reason: 'FORBIDDEN', message }
}

function isPermissionError(err) {
  return err instanceof PermissionError || (err && err.name === 'PermissionError')
}

/* ============================================================================
   能力 6 · 雲端形態「上傳印章即上雲」（`writeFaceMode() === 'cloud'`）
   --------------------------------------------------------------------------
   線上實證真因：「上傳印章」此前**只寫本機**（`db.js::createSealWithFaceRows` 純本地落盤 ＋
   本機號源 `nextSealNo` 發 `seal_no`）⇒ 乾淨瀏覽器查不到該印、AI 修復按 `image_id` 嚴格查行
   必報「原圖影像編號不存在」、刪除也刪不到雲端。本分支把它收口為：

   ① 與本地形態**共用同一道寫前校驗**（`planSealWithFaceInput`，零副作用、零寫入）；
   ② 影像二進制經**現有** `storeArtifactBytes` 交權威存儲（拿 `sha256` / `bytesLength` / 對象鍵）；
   ③ 調雲函數 **`createSealUpload`**（**服務端發號**；本機**不調** `nextSealNo` / `reserveSealNo`）；
   ④ 成功 ⇒ 用**服務端下發的 id / 號**寫本機鏡像行（`saveSealRows` / `saveFaceRows` /
      `saveImageRows` 現有單點；行形狀與本地路徑逐鍵同構）；
   ⑤ **入雲失敗 ⇒ 硬失敗**：`ok:false` ＋ 如實文案、**不落任何本機行**
      （禁止誕生「只有本機看得到」的印章）。

   本地 dev（`local-dev`）**顯式走舊本地路徑**（見下方 `createSealWithFace` 的分支），
   兩形態互不濛混。
   ========================================================================== */

/** 雲函數上傳 op 名（**唯一字面值落點**；雲端 `ADMIN_OPS` 註冊面同名）。 */
const CLOUD_SEAL_UPLOAD_OP = 'createSealUpload'

/** 每次提交一枚的冪等鍵（與雲端 `client_request_id` 形態門同尺：非空字符串、≤128 字）。 */
function newClientRequestId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return `csu-${globalThis.crypto.randomUUID()}`
    }
  } catch {
    /* 無 `randomUUID` ⇒ 落時間戳 + 隨機兜底（同一提交內唯一即可）。 */
  }
  return `csu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** 雲端上傳的**硬失敗**（入雲失敗 ⇒ 零本機行；`reason` 只用既有凍結字面值）。 */
function cloudUploadFail(reason, message) {
  return { ok: false, reason: reason || 'STORAGE_UNAVAILABLE', message }
}

/**
 * 雲端形態的「上傳印章」：**先校驗 → 再入雲 → 成功才落本機鏡像行**。
 * 返回形狀與 `createSealWithFaceRows` **同構**（由 `createSealWithFace` 的收口統一處理）。
 * @param {{id:string, role:string}} actor 管理員（寫前校驗面會獨立再判一次權限）
 * @param {object} payload 組合入口載荷（鍵面 `SEAL_COMPOSITE_INPUT_FIELDS`）
 * @returns {Promise<object>} 成功 / 防重 ⇒ `ok:true`；任何失敗 ⇒ `ok:false` ＋ 零本機行
 */
async function createSealWithFaceViaCloud(actor, payload = {}) {
  /* ① 與本地形態**同一道**寫前校驗（鍵白名单 / 必填 / 值域 / 引用 / 影像可解析；零副作用）。 */
  const planned = planSealWithFaceInput(actor, payload)
  if (!planned.ok) return planned
  const { clean, faceImage, edgeImage, equivalent } = planned
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
  /* ② 影像二進制交權威存儲（內容尋址；拿 sha / bytes / 對象鍵）。**入雲前失敗 ⇒ 零本機行**。 */
  const faceStored = await storeArtifactBytes(faceImage.bytes)
  if (!faceStored.ok) {
    return cloudUploadFail(faceStored.reason, `上傳印章失敗：${faceStored.message}（入雲前中止；本次未寫入任何本機行）`)
  }
  let edgeStored = null
  if (edgeImage) {
    edgeStored = await storeArtifactBytes(edgeImage.bytes)
    if (!edgeStored.ok) {
      return cloudUploadFail(edgeStored.reason, `上傳印章失敗（side face 圖）：${edgeStored.message}（入雲前中止；本次未寫入任何本機行）`)
    }
  }
  const faceKey = faceStored.storageKey || artifactObjectKeyOf(faceStored.sha256)
  const edgeKey = edgeStored ? edgeStored.storageKey || artifactObjectKeyOf(edgeStored.sha256) : ''
  if (!faceKey || (edgeStored && !edgeKey)) {
    return cloudUploadFail('STORAGE_UNAVAILABLE', '上傳印章失敗：權威對象鍵缺席，無法入雲；本次未寫入任何本機行。')
  }
  /* ③ 載荷（**封閉鍵面**：印章級 8 鍵沿用 `SEAL_IMPORT_SEAL_FIELDS` 白名单；每面 4 必給鍵 ＋ 7 可選文本鍵）。
     作者引用的**權威鍵是 `author_person_id`**（印面級；與本機路徑 `faceRows` 的
     `author_person_id: clean.authorPersonId` 同源同義）—— 服務端 `createSealUpload` 硬門要求
     **逐面 trim 非空且命中 `xiai_persons`**，缺它 ⇒ `MISSING_REQUIRED`、指向不存在 ⇒ `INVALID_VALUE`。
     `author` 仍**保留**：它是**歷史自由文本**字段（服務端照收，作展示回落），**引用權威鍵是
     `author_person_id`**，兩者不互為回落、不互相兜底。
     空引用 ⇒ **本載荷不帶該鍵**（前端提交門已攔：`UploadSealDialog` 作者必選 ＋ `sealNameDenial`；
     不靠服務端兜底，也不把空串當引用送上去）。 */
  const faceText = {
    seal_name: clean.seal_name,
    dynasty: clean.dynasty,
    seal_type: clean.category,
    face_style: clean.faceStyle,
    seal_class: clean.sealClass,
    author: clean.author,
    ...(clean.authorPersonId ? { author_person_id: clean.authorPersonId } : {}),
    transcription: clean.transcription
  }
  const faces = [
    {
      kind: FACE_KIND.FACE,
      image_sha256: faceStored.sha256,
      image_bytes: faceStored.bytesLength,
      image_storage_key: faceKey,
      ...faceText
    }
  ]
  if (edgeStored) {
    faces.push({
      kind: FACE_KIND.EDGE,
      image_sha256: edgeStored.sha256,
      image_bytes: edgeStored.bytesLength,
      image_storage_key: edgeKey,
      ...faceText
    })
  }
  const gate = await userWriteGate(
    CLOUD_SEAL_UPLOAD_OP,
    {
      seal_name: clean.seal_name,
      dynasty: clean.dynasty,
      seal_type: clean.category,
      seal_style: clean.sealStyle,
      material: clean.material,
      shape: clean.shape,
      author: clean.author,
      transcription: clean.transcription,
      faces,
      client_request_id: newClientRequestId()
    },
    { readoutKeys: ['stamp_id', 'face_ids', 'image_ids'] }
  )
  if (!gate || gate.ok !== true) {
    if (gate && (gate.dev === true || gate.mode === WRITE_FACE_MODES.LOCAL_DEV)) {
      return cloudUploadFail(
        'STORAGE_UNAVAILABLE',
        '上傳印章失敗：雲端形態未取得服務端回包（未經雲端驗證，本地門不算授權）；本次未寫入任何本機行。'
      )
    }
    return cloudUploadFail(
      gate && gate.reason,
      `上傳印章失敗：${(gate && gate.message) || '雲端服務暫時不可用'}（本次未寫入任何本機行）`
    )
  }
  if (gate.dev === true || gate.mode === WRITE_FACE_MODES.LOCAL_DEV) {
    return cloudUploadFail(
      'STORAGE_UNAVAILABLE',
      '上傳印章失敗：雲端形態未取得服務端回包（未經雲端驗證，本地門不算授權）；本次未寫入任何本機行。'
    )
  }
  /* ④ 回包形狀門：服務端下發的 id / 號是本機鏡像行的**唯一來源**（缺位即硬失敗、零本機行）。 */
  const readouts = gate.row && typeof gate.row === 'object' ? gate.row : {}
  const stampId = String(readouts.stamp_id || gate.stamp_id || '')
  const sealNo = Number(readouts.seal_no)
  const faceIds = Array.isArray(readouts.face_ids) ? readouts.face_ids : gate.face_ids
  const imageIds = Array.isArray(readouts.image_ids) ? readouts.image_ids : gate.image_ids
  const faceNos = Array.isArray(readouts.face_nos) ? readouts.face_nos : []
  const shaped =
    stampId !== '' &&
    Number.isInteger(sealNo) &&
    sealNo > 0 &&
    Array.isArray(faceIds) &&
    Array.isArray(imageIds) &&
    Array.isArray(faceNos) &&
    faceIds.length > 0 &&
    faceIds.length === imageIds.length &&
    faceIds.length === faceNos.length &&
    faceIds.every((value) => typeof value === 'string' && value !== '') &&
    imageIds.every((value) => typeof value === 'string' && value !== '') &&
    faceNos.every((value) => Number.isInteger(value) && value > 0)
  if (!shaped) {
    return cloudUploadFail(
      'STORAGE_UNAVAILABLE',
      '上傳印章失敗：雲端回包形狀不可辨識（缺 id / 號讀數）；本次未寫入任何本機行。'
    )
  }
  /* ⑤ 本機鏡像行（**號 / id 一律取服務端回包；本機不發號**）—— 行形狀與本地路徑逐鍵同構。 */
  const at = new Date().toISOString()
  const seal = {
    seal_no: sealNo,
    sid: stampId,
    sealGroupId: `g-${stampId}`,
    stamp_id: stampId,
    id: stampId,
    seal_name: clean.seal_name,
    name: clean.seal_name,
    transcription: clean.transcription,
    dynasty: clean.dynasty,
    seal_type: clean.category,
    category: clean.category,
    seal_style: clean.sealStyle,
    material: clean.material,
    shape: clean.shape,
    asset_kind: 'SEAL',
    review_status: 'APPROVED',
    author: clean.author,
    source: MANUAL_SOURCE,
    uploaded_by: actor.id,
    created_at: at,
    updated_at: at
  }
  /* `faces` 與三個讀數數組**按面序一一對應**（雲端按載荷序回包）。 */
  const faceRows = faces.map((def, index) => ({
    id: faceIds[index],
    sealId: stampId,
    stamp_id: stampId,
    kind: def.kind,
    face_no: faceNos[index],
    /* `fid` 由 `face_no` **恆重算**（雙端同一份 `codeId` 純函數；不是本機發號）。 */
    fid: CODE_ID.encodeFaceCode(faceNos[index]).code,
    face_image_id: def.kind === FACE_KIND.FACE ? imageIds[index] : null,
    edge_image_ids: def.kind === FACE_KIND.EDGE ? [imageIds[index]] : [],
    seal_name: clean.seal_name,
    dynasty: clean.dynasty,
    seal_type: clean.category,
    face_style: clean.faceStyle,
    seal_class: clean.sealClass,
    author: clean.author,
    author_person_id: clean.authorPersonId,
    transcription: clean.transcription,
    source: MANUAL_SOURCE,
    uploaded_by: actor.id,
    created_at: at,
    updated_at: at
  }))
  const imageRows = faces.map((def, index) => {
    const stored = index === 0 ? faceStored : edgeStored
    const normalized = index === 0 ? faceImage : edgeImage
    const id = imageIds[index]
    return {
      id,
      assetId: id,
      stamp_id: stampId,
      sealId: stampId,
      ownerType: 'face',
      ownerId: '',
      kind: def.kind,
      sha256: stored.sha256,
      bytes: stored.bytesLength,
      bytesLength: stored.bytesLength,
      width: normalized.width,
      height: normalized.height,
      colorMode: normalized.colorMode,
      color_mode: normalized.colorMode,
      colorType: normalized.colorType,
      bitDepth: normalized.bitDepth,
      paletteEntries: normalized.paletteEntries,
      neutral: normalized.neutral,
      mime: normalized.mime,
      storage: AUTHORITY_STORAGE_SERVER,
      storage_key: def.image_storage_key,
      authority_rel_path: stored.relPath || '',
      [SLICE_META_FIELD]: dataSliceMetaOf(id, def.kind),
      source: MANUAL_SOURCE,
      uploaded_by: actor.id,
      created_at: at
    }
  })
  /* ⑥ 本機鏡像三表落盤（**入雲已成功**；任一表寫失敗 ⇒ 還原三表，不留半成品本機行）。 */
  const before = { seals: listSealRows(), faces: listFaceRows(), images: listImageRows() }
  let step = ''
  try {
    step = '印章行'
    if (saveSealRows([...before.seals, seal]) === false) throw new Error('saveSealRows')
    step = '印面行'
    if (saveFaceRows([...before.faces, ...faceRows]) === false) throw new Error('saveFaceRows')
    step = '影像行'
    if (saveImageRows([...before.images, ...imageRows]) === false) throw new Error('saveImageRows')
  } catch {
    saveSealRows(before.seals)
    saveFaceRows(before.faces)
    saveImageRows(before.images)
    return cloudUploadFail(
      'STORAGE_UNAVAILABLE',
      `上傳印章失敗：本機鏡像行寫入中斷（${step}）⇒ 已還原本機三個集合、未產生半成品；` +
        '雲端正式行已建立，刷新後可見（本次本機零新增行）。'
    )
  }
  return {
    ok: true,
    deduped: false,
    seal,
    face: faceRows[0],
    faces: faceRows,
    images: imageRows,
    stampId,
    faceId: faceRows[0].id,
    edgeFaceId: faceRows.length > 1 ? faceRows[1].id : '',
    /* **如實回顯識別編碼**：號源＝服務端計數器（`number_source` 標明權威來源）。 */
    code: {
      seal_no: sealNo,
      sid: stampId,
      number_source: 'SERVER_COUNTER',
      faces: faceRows.map((row) => ({ id: row.id, face_no: row.face_no, fid: row.fid }))
    },
    message: `已新增印章《${sealDisplayName(clean)}》（${stampId}）與 ${faceRows.length} 個印面`
  }
}

/** 失敗回包收口（**兩個形態共用**；形狀逐字一致 ⇒ 調用方零分叉）。 */
function failSealWithFace(written) {
  return {
    ok: false,
    reason: written.reason || 'ERROR',
    missing: written.missing || [],
    message: written.message
  }
}

/** 成功回包收口（**兩個形態共用**；形狀逐字一致 ⇒ 調用方零分叉）。 */
function finishSealWithFace(written) {
  const stampId = written.stampId || (written.seal && (written.seal.stamp_id || written.seal.id)) || ''
  const faceId = written.faceId || (written.face && written.face.id) || ''
  /* **上傳成功 ⇒ 併入當前雲端快照（本單唯一併入點）**：把服務端下發的 seal / face / image 行
     寫進內存快照 —— 否則雲端 `ready` 讀序下新章被 `withLocalOverlay` 判成**孤兒行**、不渲染
     ⇒ 立刻點 `/seal/<新號>` 會看到「未找到這枚印章」，非得手動刷新（等下一輪水合）。
     併入是**空操作安全**的：快照缺席（未配置 / 未落定 / 已回落）⇒ 直接返回，本地讀路徑照舊。
     `deduped` ⇒ 本次**沒有新增任何行**（行早已在庫）⇒ **不併**：既不動快照，也避免把
     「只有本機看得到」的行當成雲端行上屏（雲端是唯一權威，見 `withLocalOverlay` 孤兒口徑）。 */
  if (written.deduped !== true) {
    mergeCloudSnapshotRows({
      seals: written.seal ? [written.seal] : [],
      faces: Array.isArray(written.faces) ? written.faces : written.face ? [written.face] : [],
      images: Array.isArray(written.images) ? written.images : []
    })
  }
  return {
    ok: true,
    deduped: written.deduped === true,
    id: stampId,
    stampId,
    faceId,
    seal: getSealById(stampId) || written.seal || null,
    face: faceId ? getFaceById(faceId) : null,
    faces: listFacesOf(stampId),
    images: listImagesByStamp(stampId),
    message: written.message
  }
}

/**
 * **冻结 API ①**：管理员新增一枚印章（含 1 个印面 + 印面图，可选边款图）。
 *
 * @param {object|null} actor 操作者（须为管理员；缺省回落到当前登录态）
 * @param {object} payload
 *   - `seal_name`（**选填**，印文；旧键 `name` 保留为兼容别名。**可空 ⇒ 对外显示「佚名」**）
 *   - `dynasty`（**必填**，朝代 —— 广场筛选维度）
 *   - `type`（**必填**，分类 —— 广场筛选维度；也接受 `category` / `seal_type`）
 *   - `material`（可选，**印章级**固定属性 —— R-32 自印面级移入，写在**印章行**上）、
 *     `shape`（**可选**，形制 —— **印章级**固定属性、自由文本，R-22）、
 *     `face_style`（**可选**，【印面风格】R-31 —— **印面级**新键，须 ∈ 23 值真源）、
 *     `author` / `transcription` / `transcription_simplified` / `seal_style`（可选）
 *   - `faceImage`（**必填**，二进制（`Uint8Array` / `ArrayBuffer`）或 `data:image/...;base64,...`）
 *   - `edgeImage`（可选，同上）
 * @returns {Promise<{ok:boolean, deduped?:boolean, seal?:object, face?:object, faces?:Array, images?:Array,
 *   id?:string, stampId?:string, faceId?:string, reason?:string, missing?:string[], message:string}>}
 *   - 成功：`seal` / `face` 为视图模型（含 `stamp_id` / `id` / `faces` / `faceImage`），
 *     `images` 为**影像元数据**行（二进制在 IndexedDB，见 `loadImageDataUrl`）；
 *     `deduped: true` 表示**语义等价的印章此前已上传**，本次未新增（AC-35）。
 *   - 拒绝：非管理员 ⇒ `{ok:false, reason:'FORBIDDEN'}`（§3.12.10(c)：与数据层同字面值）；
 *     必填缺失 ⇒ `{ok:false, reason:'MISSING_REQUIRED', missing:[...]}` 且**无半成品记录**（AC-34）。
 */
export async function createSealWithFace(actor, payload = {}) {
  const who = actor || currentUser()
  /* **雲端形態（`cloud`）＝上傳即上雲**：服務端發號；**入雲失敗 ⇒ 硬失敗、零本機行**。 */
  if (writeFaceMode() === WRITE_FACE_MODES.CLOUD) {
    const written = await createSealWithFaceViaCloud(who, payload)
    return written.ok ? finishSealWithFace(written) : failSealWithFace(written)
  }
  /* **本機 dev / 離線形態（`local-dev`）＝顯式本地分支**：舊本地路徑一字不改（含本機號源）。
     兩分支之外的形態一律硬失敗（**不讓雲端形態濛混到本地、也不讓未知形態靜默落本機行**）。 */
  if (writeFaceMode() !== WRITE_FACE_MODES.LOCAL_DEV) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      missing: [],
      message: '未識別的寫入形態（既非雲端亦非本機 dev）；本次未寫入任何內容。'
    }
  }
  let written
  try {
    written = await createSealWithFaceRows(who, payload)
  } catch (err) {
    if (isPermissionError(err)) return deniedResult(err.message)
    return { ok: false, reason: 'ERROR', message: `上傳印章失敗：${(err && err.message) || '未知原因'}` }
  }
  if (!written.ok) return failSealWithFace(written)
  return finishSealWithFace(written)
}

/* ============================================================================
   印章级固定属性（【形制】`shape` ＋ **【材质】`material`（R-32 移入）**）—— R-22 / R-23 / R-25 / R-32

/**
 * 编辑**印章级**固定属性（形制 / 材质）—— R-25 独立命名入口（**唯一**印章级写法）。
 *
 * 权限：**仅管理员**；非管理员由数据层独立拒绝（结构化 `FORBIDDEN`，零写入），本层不自行放行。
 * 返回值与既有固定属性入口同一形状（结构化）：成功 ⇒
 * `{ok:true, stampId, seal, shape, material, message}`；
 * 拒绝 ⇒ `{ok:false, reason, message, missing?}`（`reason` 逐字透传数据层字面值：
 * `FORBIDDEN` / `INVALID_FIELD` / `MISSING_REQUIRED` / `NOT_FOUND`）。**从不抛未捕获异常**。
 *
 * ⚠️ 与**印面级**入口 `updateSealFixedAttributes(actor, faceId, patch)` **不再同名**（R-25）：
 * 形制 / 材质是印章级属性，**不得**走印面级入口（R-23 / R-32，会被判 `INVALID_FIELD`）。
 *
 * ⚠️ **不按调用形态派发**（R-25 判定方式 ③：函数体内以「参数个数 / 入参键存在性」选分支即命中）：
 * 目标印章**只从第 2 个参数 `stampId` 取**，本函数**不检查 `patch` 的键来决定语义**。
 * `patch` 里多给键 ⇒ 交给数据层按印章级白名单判 `INVALID_FIELD`（结构化 + 零写入），不在此处猜。
 *
 * @param {object|null} actor 操作者（须为管理员；缺省回落到当前登录态）
 * @param {string} stampId 目标印章编号（**必给**；空 ⇒ 结构化 `MISSING_REQUIRED`、零写入）
 * @param {{shape?:string, material?:string}} patch 印章级固定属性（自由文本，可空＝清空）
 */

/* **雲端寫面 op 名**（與雲函數 `lib/ops.js` 註冊面逐字一致；未部署 ⇒ 回「未知的寫入操作」）。 */
const SEAL_ATTRIBUTES_OP = 'updateSealAttributes'
const FACE_ATTRIBUTES_OP = 'updateFaceAttributes'

/** 雲函數「未知 op」拒絕的服務端字面（`index.js`：`未知的寫入操作（op）：…；本次零寫入。`）。 */
const CLOUD_OP_UNKNOWN_MARKER = '未知的寫入操作'

/** 該 op 未接通雲端寫入時的**硬拒兜底**文案（雲函數尚未部署 ⇒ 明示未儲存，絕不靜默成功）。 */
const CLOUD_OP_UNWIRED_MESSAGE = '此操作暫未接通雲端寫入；本次未儲存'

/**
 * 雲端寫面失敗 ⇒ **恰 3 鍵**結構化回出（`ok:false` / `reason` / `message`）。
 *
 * `reason` / `message` **逐字透傳**服務端原文（調用方直接上屏）；
 * 唯一改寫：「未知 op」（op 未在雲函數註冊面內 ⇒ 未部署）⇒ 換**硬拒兜底**文案。
 * @param {object|null} gate `userWriteGate` 的失敗回包
 * @param {string} fallback 回包無可讀 `message` 時的通用文案
 * @returns {{ok:false, reason:string, message:string}}
 */
function cloudWriteFailure(gate, fallback) {
  const raw = gate && typeof gate.message === 'string' ? gate.message : ''
  return {
    ok: false,
    reason: (gate && typeof gate.reason === 'string' && gate.reason) || 'STORAGE_UNAVAILABLE',
    message: raw.indexOf(CLOUD_OP_UNKNOWN_MARKER) !== -1 ? CLOUD_OP_UNWIRED_MESSAGE : raw || fallback
  }
}

export async function updateSealAttributes(actor, stampId, patch = {}) {
  const who = actor || currentUser()
  const target = String(stampId === undefined || stampId === null ? '' : stampId).trim()
  /* **雲端形態（`cloud`）＝服務端落權威行**：經同一登錄令牌寫面門（`userWriteGate`），
     成功**只認回包 `row`**並按它重建視圖（**本機庫零寫入** —— 停寫鏡像後不得再把鏡像寫回來）。
     失敗**結構化回出原文**（`reason` / `message` 一字不改寫；調用方直接上屏）；
     回包為「未知 op」（雲函數尚未部署該 op）⇒ **硬拒兜底文案**，絕不靜默成功。 */
  if (writeFaceMode() === WRITE_FACE_MODES.CLOUD) {
    let gate
    try {
      gate = await userWriteGate(SEAL_ATTRIBUTES_OP, { seal_id: target, patch: patch || {} })
    } catch (err) {
      return {
        ok: false,
        reason: 'STORAGE_UNAVAILABLE',
        message: (err && err.message) || '印章固定屬性保存失敗（雲端寫入通道異常）'
      }
    }
    if (!gate || gate.ok !== true) return cloudWriteFailure(gate, '印章固定屬性保存失敗')
    const row = gate.row && typeof gate.row === 'object' ? gate.row : null
    if (!row) {
      return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '雲端回包未帶更新後的印章行（row）；本次未儲存。' }
    }
    const stamp = String(row.stamp_id || row.id || target)
    const shape = typeof row.shape === 'string' ? row.shape : ''
    const material = typeof row.material === 'string' ? row.material : ''
    /* 視圖按回包 `row` 重建（`row` 的權威鍵覆蓋其上；快照已有的派生面如印面集合原樣保留）。 */
    const base = getSealById(stamp)
    return {
      ok: true,
      stampId: stamp,
      seal: base ? { ...base, ...row, id: stamp, stamp_id: stamp } : { ...row, id: stamp, stamp_id: stamp },
      shape,
      material,
      message: '印章固定屬性已保存'
    }
  }
  try {
    const row = dbWriteSealFixedAttributes(who, target, patch)
    /* 数据层为**结构化拒绝**（不抛错）⇒ 显式透传，不能把它当成印章行走下去。 */
    if (row && row.ok === false) {
      return {
        ok: false,
        reason: row.reason || 'FORBIDDEN',
        message: row.message,
        ...(Array.isArray(row.missing) ? { missing: row.missing } : {})
      }
    }
    const stamp = row.stampId || target
    return {
      ok: true,
      stampId: stamp,
      seal: getSealById(stamp) || row.seal || null,
      shape: typeof row.shape === 'string' ? row.shape : '',
      material: typeof row.material === 'string' ? row.material : '',
      message: row.message || '印章固定屬性已保存'
    }
  } catch (err) {
    if (isPermissionError(err)) return deniedResult(err.message)
    return { ok: false, reason: 'ERROR', message: (err && err.message) || '印章固定屬性保存失敗' }
  }
}

/**
 * **冻结 API ②（纯印面级，R-25 已恢复）**：编辑**印面**的固定属性
 * （印面图片 / 材质 / 边款图片 ID），签名 `(actor, faceId, patch)`。
 *
 * R-25 变更（消除同名不同义）：「按调用形态派发」的**同名派发器已删除** ——
 *   - 本函数**只有印面级语义**，不再接受 `(patch = { stampId, shape })` 的单参形态；
 *   - 印章级（形制）一律走独立命名入口 `updateSealAttributes(actor, stampId, patch)`；
 *   - 传 ≥2 个参数且 patch 带 `shape` ⇒ 数据层按印面级白名单判 `INVALID_FIELD`（R-23）。
 *
 * 调用点：`src/components/FaceFixedAttributesDialog.vue`（`(null, face.id, patch)` 形态，
 * `actor` 传 `null` 走当前会话 —— 与项目现有取法一致）。`patch` 只认
 * `face_image_id` / `edge_image_ids`（**R-32**：`material` 已移出印面级白名单，传它 ⇒
 * 数据层判 `INVALID_FIELD` 且零写入；材质请走印章级入口 `updateSealAttributes`）。
 * @returns {{ok:boolean, reason?:string, message:string, face?:object}}
 */
export async function updateSealFixedAttributes(actor, faceId, patch = {}) {
  const who = actor || currentUser()
  const facePatch = patch || {}
  /* **雲端形態（`cloud`）**：印面固定屬性同樣上雲（op `updateFaceAttributes`），
     成功按回包 `row` 重建印面視圖（**本機庫零寫入**）；失敗結構化回出原文
     （「未知 op」⇒ 硬拒兜底文案，絕不靜默成功）。 */
  if (writeFaceMode() === WRITE_FACE_MODES.CLOUD) {
    const target = String(faceId === undefined || faceId === null ? '' : faceId).trim()
    let gate
    try {
      gate = await userWriteGate(FACE_ATTRIBUTES_OP, { face_id: target, patch: facePatch })
    } catch (err) {
      return {
        ok: false,
        reason: 'STORAGE_UNAVAILABLE',
        message: (err && err.message) || '固定屬性保存失敗（雲端寫入通道異常）'
      }
    }
    if (!gate || gate.ok !== true) return cloudWriteFailure(gate, '固定屬性保存失敗')
    const row = gate.row && typeof gate.row === 'object' ? gate.row : null
    if (!row) {
      return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '雲端回包未帶更新後的印面行（row）；本次未儲存。' }
    }
    return { ok: true, face: faceViewModel(row), message: '固定屬性已保存' }
  }
  try {
    const row = writeFaceFixedAttributes(who, faceId, facePatch)
    if (row && row.ok === false) {
      return { ok: false, reason: row.reason || 'FORBIDDEN', message: row.message }
    }
    return { ok: true, face: faceViewModel(row), message: '固定屬性已保存' }
  } catch (err) {
    if (isPermissionError(err)) return deniedResult(err.message)
    return { ok: false, reason: 'ERROR', message: (err && err.message) || '固定屬性保存失敗' }
  }
}

/* ---------------------------------------------------------------------------
   **影像行就緒門檻（2026-09-28｜本單 M1）**：行「查不到」有兩種截然不同的成因
   ---------------------------------------------------------------------------
   `listImageRows()` 在雲端讀取面**未落定**（狀態 `pending`）時一律回空集
   （`db.js::readCollection` 的 `pending` 分支）⇒ 此刻 `find(...)` 得 `null` 並**不代表**
   「本機影像庫沒有這張圖」。兩者必須分開：
     · `pending`（**未定**）⇒ 調用方一律拿**非終態**讀數，**不得**寫進錯誤緩存、**不得**恆不重試；
     · 其餘（`ready` / `failed` / `off` ＝ 已落定）⇒ 既有終態文案與行為**一字不改**。
   為什麼非判不可（線上實據的機械口徑）：詳情頁「印面影像」塊在 `face_image_id` 一變非空
   （＝印章集合剛水合那一刻）就取字節；若此刻影像集合尚未落定 ⇒ 行查不到 ⇒
   `cloudBaseObjectKeyOf(null)` 為空 ⇒ **雲端分支被跳過** ⇒ 落本機路徑取不到字節 ⇒ 回終態失敗；
   而詳情頁把該失敗記進 `imageErrors` 且迴圈開頭 `continue` ⇒ **永久緩存、永不重試** ⇒ 穩定不出圖。
   同桶同源的廣場卡片走進視口懶加載（水合早已完成）⇒ 有圖。
   判據本身**同步、零 I/O**（讀數據層狀態讀數），不靠等待、不靠輪詢、不靠猜。
   --------------------------------------------------------------------------- */
function imageRowsUnsettled() {
  const status = cloudBaseStatus() || {}
  return status.state === 'pending'
}

/** **未落定**的結構化讀數（`ok:false` ＋ `pending:true`；**不是**終態失敗 ⇒ 調用方不得緩存為錯誤）。 */
function imageRowsPendingReadout(extra = {}) {
  return {
    ok: false,
    pending: true,
    reason: 'IMAGE_ROWS_PENDING',
    message: '影像資料仍在讀取中（雲端資料尚未落定），就緒後會自動重試',
    ...extra
  }
}

/**
 * **雲端快照行按編號查找（本單｜第二道查找面）**：本機鏡像無行時，再從雲端快照找一次。
 *
 * 為什麼需要：雲模式下本機行**停寫**（提交 `b98bc47`）⇒ `listImageRows()` 裏可能還沒有
 * 剛在服務端落庫的候選行（內存補位未生效 / 快照未帶該集合 / 頁面剛刷新），而服務端**已落庫**
 * ⇒ 此刻**不能**判「本機沒有這張圖」。**只讀、零網路**；雲端讀取面未落定 ⇒ 快照行未到位
 * ⇒ `null`（調用方照舊走 `imageRowsUnsettled()` 的 pending 判定，語義不變）。
 * @param {string} imageId 影像編號
 * @returns {object|null} 雲端快照裡的該行；找不到 ⇒ `null`
 */
function findCloudImageRow(imageId) {
  const id = imageId === null || imageId === undefined ? '' : String(imageId)
  if (id === '') return null
  /* 雲集合鍵 ＝ 本機鏡像鍵（`images` 同名；真源＝`cloudbase.js::CLOUD_COLLECTION_KEYS`）。 */
  const cloud = cloudBaseReadOf('images')
  if (cloud.state !== 'ready' || !Array.isArray(cloud.rows)) return null
  return cloud.rows.find((row) => row && (row.id === id || row._id === id)) || null
}

/* ============================================================================
   **影像 dataUrl 缓存失效（本單新增｜服务层**唯一失效口**）
   ----------------------------------------------------------------------------
   · 页面级**逐影像 dataUrl 缓存**（详情页 `imageUrls` / `imageVias` / `imageErrors` /
     `imagePending`）由页面持有 —— 服务层不代管页面缓存，但提供**唯一失效口**：
     页面在 setup 里用 `registerImageDataUrlCacheHolder(holder)` 登记自己的清理函数
     （组件卸载时用返回的句柄注销）；此后**任何换图 / 採納 AI 候選圖 / 刪除影像**的写面
     成功，只要调 `invalidateImageDataUrl(id)` ⇒ 该编号的 dataUrl 一律作废、下次必重取。
   · 为什么必须单点：失效必须与写面同处收口 —— 散在各视图里必漏一处，漏一处就等于
     **页面继续拿旧字节冒充现值**（「采纳后仍显示旧图」正是这么来的）。
   · **旧影像本身不删**（Kevin 2026-11-07 定案：旧行与二进制保留、可回溯）；这里作废的
     只是**缓存条目**，与「删图」是两件事。
   ============================================================================ */

/** 页面登记的缓存清理函数（**只在本文件被调用**；页面零第二套失效判据）。 */
const imageDataUrlCacheHolders = new Set()

/**
 * 登记一个「逐影像 dataUrl 缓存」清理函数（页面在 setup 调用一次）。
 * @param {(imageId:string)=>void} holder 收到影像编号即清掉该编号的缓存条目
 * @returns {()=>void} 注销句柄（组件卸载时调用；重复调用幂等）
 */
export function registerImageDataUrlCacheHolder(holder) {
  if (typeof holder !== 'function') return () => {}
  imageDataUrlCacheHolders.add(holder)
  return () => {
    imageDataUrlCacheHolders.delete(holder)
  }
}

/**
 * **作废某编号的 dataUrl 缓存**（服务层唯一失效口；写面成功后调用）。
 * 空编号 ⇒ 零动作回 `false`（不误伤）；某个 holder 抛错 ⇒ **不阻断**其余 holder
 * （缓存清理失败只影响「下次是否重取」，绝不把已成功的写面改判成失败）。
 * @param {string} imageId 影像编号
 * @returns {boolean} 是否真按编号发起了一轮作废
 */
export function invalidateImageDataUrl(imageId) {
  const id = String(imageId === undefined || imageId === null ? '' : imageId).trim()
  if (id === '') return false
  imageDataUrlCacheHolders.forEach((holder) => {
    try {
      holder(id)
    } catch {
      /* 单个 holder 失败静默：缓存作废是**卫生动作**，不改写写面结论。 */
    }
  })
  return true
}

/**
 * **附加能力（非冻结项，UI 单可直接用）**：按影像编号取回二进制并转 dataURL（**仅运行时渲染**）。
 * 二进制只在 IndexedDB，页面要用 `<img>` 显示时必须走这里（不得直接读 IndexedDB，§3.2 收口注）。
 * @returns {Promise<{ok:boolean, dataUrl?:string, bytes?:Uint8Array, meta?:object, message:string}>}
 */

/**
 * 取回某影像的**展示用** dataURL（页面显示的唯一入口；页面不得自行读写浏览器存储）。
 *
 * 面别（案 C）：**存储件是 TIFF** ⇒ 交 `xiai-api` 转出展示件（有损 WebP 0.92）后给页面；
 * **其余容器**（含**存量旧 8 色索引 PNG**）⇒ **原字节**交浏览器原生解码。
 * 失败一律**结构化 ＋ 可读文案**（不静默、不拿空值冒充成功）。
 * **`bytes` 的语义（本单订正 JSDoc，行为未改）**：`bytes` ＝ **真字节数组**（`Uint8Array`，数组长度即字节数）；
 * `bytesLength`（`number`）只出现在**数据层读入口**（`db.js::readImageDataUrl` / `readPhotoDataUrl`），本服务不转口。
 * @param {string} imageId 影像编号
 * @returns {Promise<{ok:boolean, dataUrl?:string, bytes?:Uint8Array, mime?:string, transcoded?:boolean,
 *          meta?:object, message:string}>}
 */
export async function loadImageDataUrl(imageId) {
  let meta = listImageRows().find((row) => row.id === imageId) || null
  /* **雲端快照第二道查找（本單）**：本機鏡像無行 ＋ 雲端讀取面在場 ⇒ 再按編號從雲端快照找一次
     （雲模式本機停寫；找到即走下面既有的雲端展示件分支，**不改任何取字節口徑**）。 */
  if (!meta && cloudBaseActive()) meta = findCloudImageRow(imageId)
  /* **就緒門檻（M1）**：行查不到 ＋ 讀取面未落定 ⇒ **非終態**（「還沒讀到」不是「沒有這張圖」）。 */
  if (!meta && imageRowsUnsettled()) return imageRowsPendingReadout({ meta: null })
  /* **占位圖（本單新增｜影像例外）**：`placeholder/seal-no-image` 不是内容寻址键（云端桶无此对象），
     其字节来源＝**仓内随包资产**（零转码）。**只在登记键上命中** ⇒ 不触碰通用内容寻址判据。 */
  if (isSealPlaceholderImageRow(meta)) {
    const bundled = await loadSealPlaceholderBytes()
    if (!bundled.ok) return { ok: false, message: bundled.message, meta }
    return {
      ok: true,
      dataUrl: bytesToDataUrl(bundled.bytes, bundled.mime),
      bytes: bundled.bytes,
      mime: bundled.mime,
      transcoded: false,
      meta,
      message: ''
    }
  }
  /* **CloudBase 讀取面（v1）**：雲端行 ⇒ 取**已遷的展示件**（PNG / WebP，mapping.md §3
     的 `storage_key`）的**臨時鏈接** ⇒ 整件字節 ⇒ dataURL。**零轉碼、零切塊**：
     交出去的就是遷移時那一份字節（容器按字節如實判定，不採信自稱值）。 */
  if (cloudBaseActive() && cloudBaseObjectKeyOf(meta)) {
    const cloud = await cloudObjectBytesOfRow(meta)
    if (!cloud.ok) return { ok: false, message: cloud.message, meta }
    return {
      ok: true,
      dataUrl: bytesToDataUrl(cloud.bytes, cloud.mime || String((meta && meta.mime) || '').toLowerCase()),
      bytes: cloud.bytes,
      mime: cloud.mime || String((meta && meta.mime) || '').toLowerCase(),
      transcoded: false,
      meta,
      message: ''
    }
  }
  const out = await readImageDataUrl(imageId)
  if (!out.ok) {
    return { ok: false, message: out.message || '本機影像庫中暫無該編號的圖象文件' }
  }
  const storedMime = sniffBytesMime(meta && meta.mime ? meta.mime : '') || String((meta && meta.mime) || '').toLowerCase()
  const display = await displayDataUrlOf({
    dataUrl: out.dataUrl,
    mime: storedMime,
    bytes: out.bytes
  })
  if (!display.ok) {
    return { ok: false, message: display.message, meta, bytes: out.bytes }
  }
  return {
    ok: true,
    dataUrl: display.dataUrl,
    bytes: out.bytes,
    mime: display.mime || storedMime,
    transcoded: display.transcoded === true,
    meta,
    message: ''
  }
}

/**
 * **存储件字节读取（零转码面）**：只把本机影像库里的**原始存储件字节**与**按字节判定的容器**
 * 交回调用方 —— **不触发任何展示面转码**（与 `loadImageDataUrl` 的区别：后者对 TIFF 会调用
 * 展示面端点换一份 WebP 展示件）。
 *
 * 用途 ＝ **直出面（下載面 / 縮略面 / 塊面）的字節來源**：这三面消费的是**存储件本身**
 * （原字节面 byte-verbatim；块面 / 缩略面由服务端从源字节转出），不是展示件。
 *
 * @param {string} imageId 影像编号
 * @returns {Promise<{ok:boolean, bytes?:Uint8Array, mime?:string, sha256?:string, row?:object, message:string}>}
 */
export async function loadStoredImage(imageId) {
  const row = listImageRows().find((item) => item.id === imageId) || null
  /* **就緒門檻（M1）**：同上 —— 未落定 ⇒ 非終態讀數（不冒充「本機沒有」）。 */
  if (!row && imageRowsUnsettled()) return imageRowsPendingReadout({ row: null })
  /* **占位圖（本單新增｜影像例外）**：同上 —— 交出随包资产字节，面别如实登记
     `displayOnly + source:'bundled_placeholder'`（**不是**原图、**不是**云对象）。 */
  if (isSealPlaceholderImageRow(row)) {
    const bundled = await loadSealPlaceholderBytes()
    if (!bundled.ok) return { ok: false, message: bundled.message, row }
    return {
      ok: true,
      bytes: bundled.bytes,
      mime: bundled.mime,
      sha256: String((row && row.sha256) || ''),
      row,
      displayOnly: true,
      source: 'bundled_placeholder',
      message: ''
    }
  }
  /* **CloudBase 讀取面（v1）**：雲端行 ⇒ 交出**已遷的展示件整件字節**。
     面别如实登记（不冒充）：這**不是** TIFF 存儲件，也**不是**權威庫的「原字節面」；
     `mime` 一律**按字節如實**判定（不採信行上自稱值）。 */
  if (cloudBaseActive() && cloudBaseObjectKeyOf(row)) {
    const cloud = await cloudObjectBytesOfRow(row)
    if (!cloud.ok) return { ok: false, message: cloud.message, row }
    return {
      ok: true,
      bytes: cloud.bytes,
      mime: cloud.mime || String((row && row.mime) || '').toLowerCase(),
      sha256: (row && row.sha256) || '',
      row,
      /* **R-F3（雲端接管態｜語義如實，2026-09-30）**：此處交出的是**雲端展示件整件字節**
         （PNG / WebP）—— **不是**存儲件的原檔字節。為什麼結構上必無原檔：雲端對象鍵只認
         `xiai/images/<sha 前兩位>/<sha>.<png|webp>`（`IMAGE_OBJECT_KEY_PATTERN`），
         **不含 TIFF**。⇒ 面别**如實登記**（`displayOnly` / `source`），下載面據此標「非原圖」，
         **不得**再拿「字節與自己比對」得出的摘要一致冒充原檔（見 `originalDownloadOf`）。
         本判據只影響**雲端接管時的雲端行**；本機行（dev 5163 + 5191）逐字不變。 */
      displayOnly: true,
      source: 'cloud_display',
      message: ''
    }
  }
  const out = await readImageDataUrl(imageId)
  if (!out.ok) {
    return { ok: false, message: out.message || '本機影像庫中暫無該編號的圖象文件', row }
  }
  const bytes = toUint8Array(out.bytes)
  /* mime 一律**按字节如实**判定（不采信自称值）—— §3.12.10(b) 同族纪律。 */
  const mime = sniffBytesMime(bytes) || String((row && row.mime) || '').toLowerCase()
  return {
    ok: true,
    bytes,
    mime,
    sha256: (row && row.sha256) || '',
    row,
    /* **R-F3 對照面（本機面）**：本機面拿到的就是**本機存儲的原檔字節**（面别不變、逐字不變）。 */
    displayOnly: false,
    source: 'stored',
    message: ''
  }
}

/**
 * **影像行的讀取面分流讀數（K-P5b｜同步、零 I/O）**：以行內是否有 digest 判定 ——
 *   · `via === 'digest'` ⇒ 三面走**按 digest 引用**的形態（`?sha256=`），不需要本機字節；
 *   · `via === 'local'` ⇒ **存量 / 本機二進制行**（含舊 8 色索引 PNG）⇒ 既有本機路徑、**零 api**。
 * @param {string} imageId 影像編號
 * @returns {{row:object|null, via:'digest'|'local'|'', digest:string}}
 */
export function imageSourceOf(imageId) {
  const row = listImageRows().find((item) => item.id === imageId) || null
  /* **就緒門檻（M1）**：未落定 ⇒ `pending:true`（分流讀數的第三態：既非 digest、也非 local）。 */
  if (!row) return { row: null, via: '', digest: '', pending: imageRowsUnsettled() }
  /* **CloudBase 讀取面（v1）**：雲端行（對象在 CloudBase 對象存儲）⇒ 一律 **`local`**。
     理由（機械可判）：`digest` 分流的前置是「二進制在**本機 5191 權威庫**」（三面 ＝
     原字節 / 縮略 / 塊全部由該服務端按 digest 引用輸出）；雲端形態下**沒有**該服務端
     （Vercel 上不存在 `/api/image/*`），按 digest 引用只會得到一次 404 ⇒ 展示面另走
     「整件展示件」（`loadImageDataUrl` / `loadStoredImage` 的雲端分支），**可見、不假成功**。
     本判據只影響**雲端接管時**的雲端行；本機行（dev 5163 + 5191）逐字不變。 */
  if (cloudBaseActive() && cloudBaseObjectKeyOf(row)) return { row, via: 'local', digest: '' }
  const via = readViaOfRow(row)
  return { row, via, digest: via === 'digest' ? digestOfRow(row) : '' }
}

/** 行內 digest（**分流判據的便捷讀數**；無 / 形態不符 / 存量行 ⇒ 空串）。 */
export function imageDigestOf(imageId) {
  return imageSourceOf(imageId).digest
}

/**
 * **詳情頁展示源（K-P5b）**：digest 行 ⇒ 展示走**塊面**（api 按 digest 引用）⇒ 本機不需要 dataURL；
 * 存量 / 本機行 ⇒ 既有 `loadImageDataUrl`（非 TIFF 原生解碼、TIFF 經展示面轉碼）**一字未改**。
 * @param {string} imageId 影像編號
 * @returns {Promise<{ok:boolean, via:'digest'|'local'|'', digest:string, dataUrl:string, message:string}>}
 */
export async function imageDisplaySourceOf(imageId) {
  const source = imageSourceOf(imageId)
  /* **就緒門檻（M1）**：未落定 ⇒ **非終態**（詳情頁據此保持載入態、不寫錯誤緩存；落定後自動重試）。 */
  if (source.pending) return imageRowsPendingReadout({ via: '', digest: '', dataUrl: '' })
  if (source.via === 'digest') {
    return { ok: true, via: 'digest', digest: source.digest, dataUrl: '', message: '' }
  }
  const out = await loadImageDataUrl(imageId)
  if (!out.ok) return { ok: false, via: '', digest: '', dataUrl: '', message: out.message }
  return { ok: true, via: 'local', digest: '', dataUrl: out.dataUrl, message: '' }
}

/**
 * **附加能力（非冻结项）**：广场筛选的朝代 / 分类选项 —— **由已入库数据派生**
 * （所以「上传印章」新写入的朝代 / 分类会立即出现在筛选条里，AC-28 的端到端筛选才成立）。
 */
export function listDynastyOptions() {
  return [...new Set(listSeals().map((seal) => seal.dynasty).filter(Boolean))]
}

export function listSealTypeOptions() {
  return [...new Set(listSeals().map((seal) => seal.seal_type).filter(Boolean))]
}

/* ============================================================================
   「重新上传印面图」（管理员，按印面逐个）—— 冻结给 UI 单的服务层 API

/**
 * **产物侧**入库字节上限（＝ `utils/image.js` 的 `STORED_MAX_BYTES` ＝ `IMAGE_LIMITS.maxStoredBytes`，4 MiB）。
 *
 * 与 `photos.js` 的 `PHOTO_ARTIFACT_MAX_BYTES` **同源**（同一个导入常量，**不另写一份数值**）。
 * 为什么不能用 1 MB 闸产物：回退 PNG 的 2048² 实测 2.70–2.72 MiB（见 `utils/image.js` 注释），
 * 拿输入闸拒自家产物＝把**没传大图**的用户拒掉。
 */
export const FACE_IMAGE_ARTIFACT_MAX_BYTES = STORED_MAX_BYTES

/**
 * @deprecated 兼容别名（旧调用方仍在 import，**保留不删**）。
 * **语义已变**：历史上它＝**产物闸**（1 MB，`IMAGE_LIMITS.maxInputBytes`），
 * 即「拿输入上限闸处理后的二进制」这个病根本身；现更正为**输入侧**的文件字节上限
 * （`IMAGE_LIMITS.maxInputBytes`，1 MB）。输入侧判在 `utils/image.js` 的 `loadImageFile`；
 * **产物侧一律用 `FACE_IMAGE_ARTIFACT_MAX_BYTES`**（4 MiB）。新代码请直接读上面两个具名常量。
 */
export const FACE_IMAGE_MAX_BYTES = IMAGE_LIMITS.maxInputBytes

/**
 * **输入侧**（用户所选原始文件）拒绝的结构化 reason 透传 —— 服务层**不得只回文案**。
 *
 * 冻结口径（§3.12.10(c)）：**输入侧超限 = `TOO_LARGE`**（仅输入侧用；产物侧一律
 * `ARTIFACT_TOO_LARGE`，两者不得互相复用）。输入侧上限（1 MB，判**原始文件字节**）判在
 * `utils/image.js` 的 `loadImageFile`；本服务**不重复判**、也**不得**拿该数值去闸产物。
 * 本函数把管线结果里的输入侧 `reason` 原样抬到服务层（reason 与文案**同源**），
 * 上传口（印面图 / 实物照片）在渲染提示时都走它。
 * @param {{ok?:boolean, reason?:string, message?:string}} loaded `loadImageFile` 的返回值
 * @returns {null|{ok:false, reason:string, message:string}} 输入通过 ⇒ `null`
 */
export function inputDenialOf(loaded) {
  if (!loaded || loaded.ok) return null
  return {
    ok: false,
    reason: loaded.reason || 'NOT_IMAGE',
    message: loaded.message || '圖片不可用，請重新選擇文件'
  }
}

/* ============================================================================
   **上傳即入册（A 層收口｜本單）：本地寫成功後入雲端影像行 ＋ 身份統一改寫
   ---------------------------------------------------------------------------- 線上真因（Kevin 實測）：`dbReplaceFaceImage` 只把字節交權威存儲、**從未在雲端 `xiai_images`
   建行**，而本機鏡像的影像行 id 是序號式（`img-<印章序號>f`）⇒ 雲端按 id 嚴格查行必然查不到
   ⇒ 人工智能修復恒報「原圖影像編號在影像行中不存在」。
   本段在**本地寫成功之後**調雲 op `registerFaceImage`（管理員門 ／ 封閉鍵面 ／ 內容尋址 `_id` ／
   `seq` 單點 ／ 冪等），成功即把**本機影像行 `id` 與印面 `face_image_id`（含 `edge_image_ids`）
   一併改寫成雲端 `image_id`** —— 一圖一身份，不留 `img-AAADQf` 與 `img-<sha16>` 兩個身份。
   硬口徑（逐條）：
   ① **入册失敗絕不編造 id**：本地行**保留**、印面指向**不動**，回 `ok:false` ＋ 可讀文案
      ＋「重新上傳同一張圖即可重試入册（內容相同不會重複建行）」——**不得靜默降級**；
   ② **無雲端對象可入册**（`storage_key` 非內容尋址 ⇒ 字節只在本機權威庫 / 本機影像庫）
      ⇒ **不發請求**（發了也必被服務端形態門拒）、**不改寫 id**，並在文案裡**如實點名**
      「未入雲端影像行 ⇒ 該圖暫不可人工智能修復」——不靜默、不編造；
   ③ **dev / 離線形態**（`writeFaceMode() === local-dev`）**沒有雲端** ⇒ 不發請求、不改寫，
      成功文案裡如實標明（該形態人工智能修復本就不可用，不存在「靜默降級」）；
   ④ 回包 `image_id` 只取**服務端信封**：`gate.image_id`（若透傳）⇒ 逐字採用；否則 `gate.docId`
      ＝ `persist` 回的 `set` 文檔標識（本 op 單步 `set` ⇒ 逐字即該行 `_id`）；**兩者皆空 ⇒
      如實拒絕、不按規則自行推導**；
   ⑤ 改寫只在**雲端入册成功後**發生；改寫失敗 ⇒ 回 `ok:false`（本地行與指向保持改寫前狀態）。
   ============================================================================ */

/** 雲端入册 op 名（與雲函數 `ADMIN_OPS` 註册面逐字一致；本文件唯一出現處）。 */
export const FACE_IMAGE_REGISTER_OP = 'registerFaceImage'

/** 雲端回包讀數鍵面（`gate()` 的 additive 透傳聲明；真源＝雲函數成功回包的非信封鍵）。 */
const FACE_IMAGE_REGISTER_READOUT_KEYS = Object.freeze(['image_id'])

/**
 * 把剛寫好的本機影像行**入册到雲端 `xiai_images`**（不改任何本地行 —— 改寫交給調用方）。
 *
 * @param {{sealId:string, faceId:string, image:object}} input
 * @returns {Promise<{ok:true, imageId:string, localId:string, dev?:boolean, note?:string}
 *          |{ok:false, reason:string, message:string, localId:string}>}
 *   - `ok:true` ＋ `dev:true` ＝ dev / 離線形態（**未經雲端**、未入册、id 不改寫）；
 *   - `ok:true`（非 dev）＝ 雲端已建 / 已覆寫該行，`imageId` ＝ 服務端給的 `image_id`。
 */
async function registerFaceImageOnCloud({ sealId, faceId, image }) {
  const row = image && typeof image === 'object' ? image : {}
  const localId = String(row.id || '')
  const sha256 = String(row.sha256 || '').trim()
  const storageKey = String(row.storage_key || '').trim()
  const bytes = Number(row.bytes)
  const kind = row.kind === FACE_KIND.EDGE ? FACE_KIND.EDGE : FACE_KIND.FACE
  const gate = await userWriteGate(
    FACE_IMAGE_REGISTER_OP,
    {
      seal_id: String(sealId || ''),
      face_id: String(faceId || ''),
      sha256,
      bytes,
      mime: String(row.mime || ''),
      storage_key: storageKey,
      kind
    },
    { readoutKeys: FACE_IMAGE_REGISTER_READOUT_KEYS }
  )
  if (gate && gate.dev === true) {
    /* dev / 離線形態：門放行但**未經雲端** ⇒ 如實登記為「未入册」，id 不改寫。 */
    return { ok: true, dev: true, imageId: localId, localId }
  }
  if (!gate || gate.ok !== true) {
    /* 服務端結構化拒絕 / 傳輸失敗 ⇒ **原樣透傳**（reason / message 一個都不改寫）。 */
    return {
      ok: false,
      reason: (gate && gate.reason) || 'STORAGE_UNAVAILABLE',
      message: (gate && gate.message) || '雲端入冊服務暫時不可用，請稍後再試。',
      localId
    }
  }
  /* **回包形狀校驗**：`image_id`（未透傳時取信封 `docId` ＝ `persist` 回的 set 文檔標識）
     缺位 / 形態不可辨 ⇒ 如實拒絕，**不按規則自行推導影像編號**。 */
  const fromReadout = typeof gate.image_id === 'string' ? gate.image_id.trim() : ''
  const fromDocId = typeof gate.docId === 'string' ? gate.docId.trim() : ''
  const imageId = fromReadout || fromDocId
  if (!imageId.startsWith('img-')) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '雲端入冊回包形狀不可辨識（未附影像編號 image_id）；本地影像行與印面指向保持不變，請稍後重試。',
      localId
    }
  }
  return { ok: true, imageId, localId }
}

/**
 * 把**本機鏡像影像行**的 `id` 改寫成雲端內容尋址編號，並把**所有指向它的印面**
 * （`face_image_id` ／ `edge_image_ids`）一併改過去 ——「一圖一身份」的唯一收口點。
 *
 * 硬口徑：改影像行**先**、改印面**後**；後者失敗 ⇒ **把影像行編號改回**（不留
 * 「行在新號、印面指舊號」的半成品）；兩步都做**回讀校驗**（`writeCollection` 不回報
 * 寫入失敗 ⇒ 只能靠回讀判，與 `dbReplaceFaceImage` 同尺）。
 *
 * @param {object|null} actor 操作者（須為管理員；沿數據層既有門）
 * @param {string} fromId 原影像編號（本機序號式）
 * @param {string} toId 目標編號（雲端內容尋址 `img-<sha16>`）
 * @returns {{ok:boolean, changed:boolean, reason?:string, message:string}}
 */
function reassignLocalImageIdentity(actor, fromId, toId) {
  const from = String(fromId === undefined || fromId === null ? '' : fromId).trim()
  const to = String(toId === undefined || toId === null ? '' : toId).trim()
  if (!from || !to) {
    return { ok: false, changed: false, reason: 'STORAGE_UNAVAILABLE', message: '改寫影像編號需要原編號與目標編號（均非空）；本次未改寫。' }
  }
  if (from === to) return { ok: true, changed: false, message: '影像編號已是雲端編號，無需改寫。' }
  const images = listImageRows()
  const index = images.findIndex((row) => row && row.id === from)
  if (index < 0) {
    return { ok: false, changed: false, reason: 'STORAGE_UNAVAILABLE', message: `未找到本機影像行 ${from}，無法改寫編號；本次未改寫。` }
  }
  const source = images[index]
  const occupiedIndex = images.findIndex((row, i) => i !== index && row && row.id === to)
  if (occupiedIndex >= 0) {
    /* 目標編號已被另一行佔用：內容相同 ⇒ 複用該行（**絕不製造兩個同 id 行**）；
       內容不同 ⇒ 如實拒絕（內容尋址下不應發生）。 */
    if (String(images[occupiedIndex].sha256 || '') !== String(source.sha256 || '')) {
      return { ok: false, changed: false, reason: 'STORAGE_UNAVAILABLE', message: `目標影像編號 ${to} 已被另一影像行佔用（內容不同）；本次未改寫。` }
    }
    const reuse = repointFaceImageRefs(actor, from, to)
    if (!reuse.ok) return reuse
    return { ok: true, changed: false, message: `同內容影像行已在（${to}），印面指向已改為該編號。` }
  }
  const kind = source.kind === FACE_KIND.EDGE ? FACE_KIND.EDGE : FACE_KIND.FACE
  const renamed = { ...source, id: to, assetId: to, [SLICE_META_FIELD]: sliceMetaOf(to, kind) }
  const nextImages = images.map((row, i) => (i === index ? renamed : row))
  saveImageRows(nextImages)
  if (!listImageRows().some((row) => row && row.id === to)) {
    return { ok: false, changed: false, reason: 'STORAGE_UNAVAILABLE', message: '影像行編號改寫未能落盤（本地存儲不可寫）；本次未改寫。' }
  }
  const repointed = repointFaceImageRefs(actor, from, to)
  if (!repointed.ok) {
    /* 印面指向沒改成 ⇒ 把影像行編號改回，避免半成品。 */
    saveImageRows(images.map((row, i) => (i === index ? { ...source, id: from, assetId: from, [SLICE_META_FIELD]: sliceMetaOf(from, kind) } : row)))
    return repointed
  }
  return { ok: true, changed: true, message: `影像編號已改寫：${from} → ${to}` }
}

/**
 * 把所有指向 `fromId` 的印面指向改成 `toId`（`face_image_id` ＋ `edge_image_ids` 兩處）。
 * 落盤走**既有單點** `writeFaceFixedAttributes`（白名单 / 權限門 / `updated_at` 一字不另立）。
 * @returns {{ok:boolean, reason?:string, message:string}}
 */
function repointFaceImageRefs(actor, fromId, toId) {
  const faces = listFaceRows()
  const affected = faces.filter((row) => {
    if (!row) return false
    if (row.face_image_id === fromId) return true
    return Array.isArray(row.edge_image_ids) && row.edge_image_ids.indexOf(fromId) !== -1
  })
  if (affected.length === 0) return { ok: true, message: '無印面引用該影像編號，無需改指向。' }
  for (const face of affected) {
    const patch = {}
    if (face.face_image_id === fromId) patch.face_image_id = toId
    if (Array.isArray(face.edge_image_ids) && face.edge_image_ids.indexOf(fromId) !== -1) {
      patch.edge_image_ids = face.edge_image_ids.map((value) => (value === fromId ? toId : value))
    }
    let written = null
    try {
      written = writeFaceFixedAttributes(actor, face.id, patch)
    } catch (err) {
      return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: `印面指向改寫失敗：${(err && err.message) || '未知原因'}；本次未改寫。` }
    }
    if (!written || written.ok === false) {
      return { ok: false, reason: (written && written.reason) || 'STORAGE_UNAVAILABLE', message: (written && written.message) || '印面指向改寫失敗；本次未改寫。' }
    }
  }
  const after = listFaceRows()
  const stillOld = affected.some((face) => {
    const fresh = after.find((row) => row && row.id === face.id)
    if (!fresh) return true
    if (fresh.face_image_id === fromId) return true
    return Array.isArray(fresh.edge_image_ids) && fresh.edge_image_ids.indexOf(fromId) !== -1
  })
  if (stillOld) {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '印面指向改寫未能落盤（本地存儲不可寫）；本次未改寫。' }
  }
  return { ok: true, message: '印面指向已改寫。' }
}

/* ============================================================================
   **雲端模式「重新上傳印面圖」分流（本單）
   ---------------------------------------------------------------------------- 線上真因（Kevin 2026-11-07 實測）：雲模式（`writeFaceMode() === 'cloud'`，生產即此）下
   `dbReplaceFaceImage` 的**本地落盘回读校验必空** ⇒ 該路徑 **100% 失敗**、永遠到不了雲端入册。
   本段把雲端模式分流到**服務端原子替換 op `replaceFaceImage`**（管理員面）：
     ① `storeArtifactBytes`（既有單點）拿 `sha256` / `storage_key`（內容尋址、冪等）；
     ② 經既有寫面門 `userWriteGate` 調 op `replaceFaceImage`（服務端原子入册影像行 ＋ 改面行指向）；
     ③ 用回包 `image_id` 做**讀回校驗** —— **只讀雲端快照 / 既有讀口，絕不靠本機鏡像**；
     ④ `faceImageId` 回雲端編號、`registered: true`，`previousFaceImageId` ＝ 服務端回的
        `previous_image_id`（**舊圖與舊指向如實透出；舊影像行與二進制一律保留**）。
   硬口徑：雲端模式**一行本機都不寫**（`dbReplaceFaceImage` / `saveImageRows` /
   `writeFaceFixedAttributes` 一律不碰）；**dev / 離線形態走下面既有本地路徑，一字不改**；
   失敗文案**不吞上游原話**（服務端 `message` 原文並列），且一律**繁體**（`s2t` 不變）。
   ============================================================================ */

/** 雲端替换 op 名（與雲函數 `ADMIN_OPS` 註册面逐字一致；本文件唯一出現處）。 */
export const FACE_IMAGE_REPLACE_OP = 'replaceFaceImage'

/** 雲端回包讀數鍵面（`userWriteGate` 的 additive 透传声明；真源＝雲函數成功回包的非信封鍵）。 */
const FACE_IMAGE_REPLACE_READOUT_KEYS = Object.freeze(['image_id', 'previous_image_id'])

/**
 * **雲端快照裡該印面是否已指向 `imageId`**（只讀雲端快照 `faces`，**不讀本機鏡像**）。
 * 快照未落定 / 找不到該面 ⇒ `false`（**不拿本機行冒充雲端行**）。
 * @param {string} faceId 印面编号
 * @param {string} imageId 影像编号
 * @returns {boolean}
 */
function cloudFacePointsAt(faceId, imageId) {
  const cloud = cloudBaseReadOf('faces')
  if (cloud.state !== 'ready' || !Array.isArray(cloud.rows)) return false
  const row = cloud.rows.find(
    (item) => item && (String(item.id || '') === faceId || String(item._id || '') === faceId)
  )
  if (!row) return false
  if (String(row.face_image_id || '') === imageId) return true
  return Array.isArray(row.edge_image_ids) && row.edge_image_ids.some((value) => String(value || '') === imageId)
}

/**
 * **讀回校驗（雲端模式）**：按回包 `image_id` 從**雲端快照**確認「影像行在 ＋ 印面指向已改」。
 *
 * 为什么必然要刷新：雲端快照在**寫入之前**就已拉取 ⇒ 剛在服務端落庫的行 / 剛改的指向不在其中
 * （本機鏡像在雲模式下停寫，**更不能**拿它充數）⇒ 命中不了時走**既有讀口**
 * `retryDataSource()`（＝ `cloudbase.js::retryCloudBaseHydration`）重拉一輪雲端快照，再讀一次；
 * 仍確認不到 ⇒ **如實回失敗**（不把「未讀到」當成功、不編造已替換）。
 * @param {string} faceId 印面编号
 * @param {string} imageId 雲端內容尋址影像編號
 * @returns {Promise<{ok:true, row:object, refreshed:boolean}|{ok:false, state:string, message:string,
 *                    rowFound:boolean, pointed:boolean}>}
 */
async function readBackCloudReplace(faceId, imageId) {
  const direct = findCloudImageRow(imageId)
  if (direct && cloudFacePointsAt(faceId, imageId)) return { ok: true, row: direct, refreshed: false }
  let status = null
  try {
    status = await retryDataSource()
  } catch (err) {
    return {
      ok: false,
      state: 'failed',
      message: (err && err.message) || '未知原因',
      rowFound: Boolean(findCloudImageRow(imageId)),
      pointed: cloudFacePointsAt(faceId, imageId)
    }
  }
  const fresh = findCloudImageRow(imageId)
  const pointed = cloudFacePointsAt(faceId, imageId)
  if (fresh && pointed) return { ok: true, row: fresh, refreshed: true }
  const statusState = status && typeof status.state === 'string' ? status.state : ''
  return {
    ok: false,
    state: statusState || (cloudBaseStatus() || {}).state || 'unknown',
    message: (status && status.message) || '',
    rowFound: Boolean(fresh),
    pointed
  }
}

/**
 * **雲端模式的替換本體**（`replaceFaceImage` 的 `cloud` 分支；**零本機寫入**）。
 * 判定樹：① 取所屬印章編號 → ② 字節交權威存儲 → ③ 容器 / 內容尋址自检 → ④ 調雲端 op →
 * ⑤ 回包形狀校验 → ⑥ **雲端回讀校验** → ⑦ 成功（`registered: true`）。任一步失敗 ⇒ 結構化
 * 失敗 ＋ 如實文案（**上游原話不吞**），且**印面指向保持不變**。
 * @param {{faceId:string, faceRow:object|null, bytes:Uint8Array, previousFaceImageId:string|null}} input
 * @returns {Promise<{ok:boolean, faceImageId?:string, previousFaceImageId?:string|null, face?:object|null,
 *   image?:object|null, sealId?:string, deduped?:boolean, registered?:boolean,
 *   reason?:string, message:string}>}
 */
async function replaceFaceImageViaCloud({ faceId, faceRow, bytes, previousFaceImageId }) {
  try {
    const source = faceRow && typeof faceRow === 'object' ? faceRow : {}
    const sealId = String(source.sealId || source.stamp_id || '').trim()
    /* ① 所屬印章編號取不到 ⇒ 不發請求（缺它服務端必判 `MISSING_REQUIRED`），如實報因。 */
    if (!sealId) {
      return {
        ok: false,
        reason: 'UNKNOWN_FACE',
        previousFaceImageId,
        message:
          `未找到該印面（face_id：${faceId}）或它未掛到任何印章 ⇒ 無法取得所屬印章編號；` +
          '本次未提交任何內容、印面指向未改動（雲端資料可能尚未載入完成，請稍後重試）。'
      }
    }
    /* ② 字节交权威存储（既有单点；内容寻址、幂等；失败原样抬 reason 与文案）。 */
    const stored = await storeArtifactBytes(bytes)
    if (!stored || stored.ok !== true) {
      return {
        ok: false,
        reason: (stored && stored.reason) || 'STORAGE_UNAVAILABLE',
        previousFaceImageId,
        message: `印面圖上傳失敗：${(stored && stored.message) || '權威存儲暫時不可用'}；本次未建立任何雲端影像行、印面指向未改動。`
      }
    }
    const sha256 = String(stored.sha256 || '').toLowerCase()
    const storageKey = String(stored.storageKey || stored.storage_key || '')
    const storedBytes = Number(stored.bytesLength)
    /* ③a 內容尋址讀數齊全 ＋ 鍵 ≡ 摘要（与 `corrections.js` 同一条自检口径）。 */
    if (!sha256 || !storageKey || !Number.isInteger(storedBytes) || storedBytes <= 0 || storageKey !== artifactObjectKeyOf(sha256)) {
      return {
        ok: false,
        reason: 'STORAGE_UNAVAILABLE',
        previousFaceImageId,
        message:
          `印面圖上傳回包缺少內容尋址讀數（sha256 / bytes / storage_key；storage_key＝${storageKey || '空'}）` +
          '⇒ 未產生雲端內容尋址對象鍵；本次未入雲端影像行、印面指向未改動，請重試。'
      }
    }
    /* ③b 存储回包的容器自检（不是存儲容器 ⇒ 如实拒，绝不把非容器冒充成容器）。 */
    const storedMime = String(stored.mime || '').trim().toLowerCase()
    if (storedMime && storedMime !== STORAGE_MIME) {
      return {
        ok: false,
        reason: 'ENCODE_FAILED',
        previousFaceImageId,
        message:
          `印面圖處理失敗：入庫對象不是存儲容器 ${STORAGE_MIME}（按字節魔數判定為 ${storedMime}）` +
          '⇒ 已拒絕入冊；本次未建立任何雲端影像行、印面指向未改動。'
      }
    }
    /* ④ 調雲端原子替換 op（管理員面；本機一行不寫）。 */
    const gate = await userWriteGate(
      FACE_IMAGE_REPLACE_OP,
      {
        face_id: faceId,
        seal_id: sealId,
        sha256,
        bytes: storedBytes,
        mime: storedMime || STORAGE_MIME,
        storage_key: storageKey,
        kind: FACE_KIND.FACE
      },
      { readoutKeys: FACE_IMAGE_REPLACE_READOUT_KEYS }
    )
    if (gate && gate.dev === true) {
      /* 形态判定已在此之上判过（cloud）⇒ 此支只作兜底：**不做本机假成功**。 */
      return {
        ok: false,
        reason: 'STORAGE_UNAVAILABLE',
        previousFaceImageId,
        message: '本機為 dev / 離線形態（沒有雲端替換面）⇒ 本次未提交任何內容、印面指向未改動。'
      }
    }
    if (!gate || gate.ok !== true) {
      /* **服务端原话原样透传**（reason / message 一字不改写），并如实交代旧图与指向未动。 */
      const upstream = gate && typeof gate === 'object' ? gate : null
      return {
        ok: false,
        reason: (upstream && upstream.reason) || 'STORAGE_UNAVAILABLE',
        previousFaceImageId,
        message:
          `雲端替換失敗：${(upstream && upstream.message) || '替換服務暫時不可用，請稍後再試。'}` +
          `（舊影像 ${previousFaceImageId || '（原無）'} 與印面指向保持不變，可重試）`
      }
    }
    /* ⑤ 回包形状校验：`image_id` 只取服务端信封，**不按规则自行推导**。 */
    const imageId = typeof gate.image_id === 'string' ? gate.image_id.trim() : ''
    if (!imageId.startsWith('img-')) {
      return {
        ok: false,
        reason: 'STORAGE_UNAVAILABLE',
        previousFaceImageId,
        message: '雲端替換回包形狀不可辨識（未附影像編號 image_id）；印面指向以服務端為準，請重新整理後重試。'
      }
    }
    /* **旧指向以服务端为准**：回包确有 `previous_image_id` ⇒ 逐字采用（`null` ＝ 原本无图）；
       服务端未回该键（旧部署）⇒ 退回本机读数并照实标出。 */
    const hasServerPrevious = Object.prototype.hasOwnProperty.call(gate, 'previous_image_id')
    const previousFaceImageIdNext = hasServerPrevious
      ? typeof gate.previous_image_id === 'string' && gate.previous_image_id !== ''
        ? gate.previous_image_id
        : null
      : previousFaceImageId
    /* ⑥ **读回校验（云端快照 / 既有读口；不靠本机镜像）**。 */
    const verified = await readBackCloudReplace(faceId, imageId)
    if (!verified.ok) {
      const missing = []
      if (!verified.rowFound) missing.push('該影像行')
      if (!verified.pointed) missing.push('印面指向')
      return {
        ok: false,
        reason: 'STORAGE_UNAVAILABLE',
        previousFaceImageId: previousFaceImageIdNext,
        message:
          `雲端已回報替換成功（影像編號 ${imageId}），但雲端回讀未確認到${missing.join('與')}` +
          `（雲端資料狀態：${verified.state}${verified.message ? `；${verified.message}` : ''}）；` +
          '印面指向以服務端為準，請稍後重新整理再試（重複提交會按冪等回放，不會重複建行）。'
      }
    }
    /* ⑦ 成功：`faceImageId` ＝ 雲端編號、`registered: true`、舊指向如實透出。 */
    return {
      ok: true,
      deduped: previousFaceImageIdNext === imageId,
      sealId,
      faceId,
      registered: true,
      face: getFaceById(faceId),
      faceImageId: imageId,
      previousFaceImageId: previousFaceImageIdNext,
      image: verified.row,
      message:
        `印面圖已替換：影像編號 ${previousFaceImageIdNext || '（原無）'} → ${imageId}；` +
        `舊影像行與二進制保留未刪；已入雲端影像行並經雲端回讀校驗` +
        `${verified.refreshed ? '（重拉雲端資料快照後確認）' : '（雲端快照）'}。`
    }
  } catch (err) {
    if (isPermissionError(err)) {
      return { ok: false, reason: 'FORBIDDEN', previousFaceImageId, message: err.message }
    }
    return {
      ok: false,
      reason: 'ERROR',
      previousFaceImageId,
      message: `替換印面圖失敗：${(err && err.message) || '未知原因'}（本次未確認替換結果，請重新整理後重試）`
    }
  }
}

/**
 * 重新上传某个印面的印面图（管理员专属；旧影像行与二进制保留）。
 *
 * @param {string} faceId 目标印面编号（如 `fc-0001-f1`）
 * @param {{bytes:Uint8Array|ArrayBuffer, mime?:string, width?:number, height?:number}} payload
 *        `bytes` ＝ 浏览器端处理后的图片字节（方形 WebP）；`mime` / `width` / `height`
 *        仅为调用方的声称值（**入库元数据以字节解析为准**，出入会在 `message` 里如实并列）。
 * @returns {Promise<{ok:boolean, faceImageId?:string, previousFaceImageId?:string|null, face?:object,
 *   image?:object, sealId?:string, deduped?:boolean, registered?:boolean, reason?:string, message:string}>}
 *   - **雲端分流（本單｜`writeFaceMode() === 'cloud'` 即生產）**：**不走**本机路径
 *     （`dbReplaceFaceImage` 的本地落盘回读在云模式必空 ⇒ 那条路 100% 失败），改走云 op
 *     `replaceFaceImage`：`storeArtifactBytes` → 服务端原子入册影像行 ＋ 改面行指向 →
 *     **云端回读校验**（云端快照 / 既有读口，不靠本机镜像）。成功 ⇒ `registered: true`、
 *     `faceImageId` ＝ 云端编号、`previousFaceImageId` ＝ 服务端 `previous_image_id`
 *     （**旧影像行与二进制保留未删**）；**dev / 離線形態走本机路径，判定树一字不改**。
 *   - 成功：`face` 为**替换后**的印面视图模型（`faceImage` / `face_image_id` 已指向新影像），
 *     详情页据此重读即可显示新图（刷新后一致）。
 *   - **上傳即入册（本單）**：本地写成功后调云 op `registerFaceImage` 入云端 `xiai_images`，
 *     成功即把本机影像行 `id` 与印面 `face_image_id` 统一改写成云端 `image_id`（`registered: true`，
 *     `faceImageId` ＝ 云端编号）；`registered: false` ＝ **未入册**（dev / 離線形態，或本机权威库
 *     路径未产生云端对象键）⇒ 编号保持本机原值，`message` 如实点名「未入雲端影像行」。
 *   - 拒绝路径（均可读、均有 `reason`）：未登录 ⇒ `UNAUTHENTICATED`；非管理员 ⇒ `FORBIDDEN`；
 *     未指定印面 ⇒ `MISSING_FACE`；内容空 ⇒ `EMPTY_CONTENT`；
 *     **产物超上限（4 MiB）⇒ `ARTIFACT_TOO_LARGE`**（文案＝「本机影像生成失败」，与输入侧分开）；
 *     非图片字节 ⇒ `NOT_IMAGE`；印面不存在 ⇒ `UNKNOWN_FACE`；影像库写失败 ⇒ `STORAGE_UNAVAILABLE`；
 *     **云入册失败 ⇒ 服务端原样 `reason`**（本地行与印面指向**保留不动**、不编造编号、可重试）。
 */
export async function replaceFaceImage(faceId, payload = {}) {
  const id = String(faceId || '').trim()
  const before = id ? listFaceRows().find((row) => row.id === id) || null : null
  const previousFaceImageId = before ? before.face_image_id || null : null

  const user = currentUser()
  if (!user) {
    return {
      ok: false,
      reason: 'UNAUTHENTICATED',
      previousFaceImageId,
      message: '請先登錄管理員賬號後再重新上傳印面圖'
    }
  }
  if (!canReplaceFaceImage(user)) {
    return {
      ok: false,
      reason: 'FORBIDDEN',
      previousFaceImageId,
      message: '僅管理員可以重新上傳印面圖'
    }
  }
  if (!id) {
    return { ok: false, reason: 'MISSING_FACE', previousFaceImageId, message: '未指定要替換影像的印面' }
  }

  const bytes = toUint8Array(payload.bytes)
  if (!bytes || bytes.length === 0) {
    return {
      ok: false,
      reason: 'EMPTY_CONTENT',
      previousFaceImageId,
      message: '印面圖內容爲空，請重新選擇圖片文件'
    }
  }
  /* 产物侧兜底：判的是**处理后的二进制**（`FACE_IMAGE_ARTIFACT_MAX_BYTES`＝4 MiB），
     **不是**输入文件的 1 MB —— 后者判在 `utils/image.js` 的 `loadImageFile`（本服务不重复判）。
     文案必须与输入侧分开：这里说「本机影像生成失败」，**不得**再说「请换一张更小的图…」
     （用户没传大图，旧实现就是把这句话甩给回退 PNG 的用户）。 */
  if (bytes.length > FACE_IMAGE_ARTIFACT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'ARTIFACT_TOO_LARGE',
      previousFaceImageId,
      message:
        `本機影像生成失敗：印面圖處理後 ${describeBytes(bytes.length)} 超過入庫上限 ` +
        `${describeBytes(FACE_IMAGE_ARTIFACT_MAX_BYTES)}。` +
        '這與「所選文件 ≤ 1 MB」的輸入上限是兩回事；請重試，或改用支持 WebP 編碼的瀏覽器後再上傳。'
    }
  }
  /* 如实口径：格式按**字节魔数**判定；认不出 ⇒ 可读拒绝，绝不把非图片内容入库。 */
  const actualMime = sniffBytesMime(bytes)
  if (!actualMime) {
    const claimed = String(payload.mime || '').trim().toLowerCase()
    return {
      ok: false,
      reason: 'NOT_IMAGE',
      previousFaceImageId,
      message:
        '這不是可用的圖片內容（無法識別圖片格式），請重新選擇 JPG / PNG / WebP 圖片'
        + (claimed ? `（聲稱類型 ${claimed}）` : '')
    }
  }

  /* ---------------------------------------------------------------------------
     **雲端分流点（本單｜唯一一处）**：云模式 ⇒ 走服务端原子替换 op，**一行本机都不写**；
     dev / 離線形態 ⇒ 下面既有本地路径（`dbReplaceFaceImage` ＋ 云入册判定树）**一字不改**。
     ---------------------------------------------------------------------------- */
  if (writeFaceMode() === WRITE_FACE_MODES.CLOUD) {
    return replaceFaceImageViaCloud({ faceId: id, faceRow: before, bytes, previousFaceImageId })
  }

  try {
    const written = await dbReplaceFaceImage(user, id, {
      bytes,
      mime: actualMime,
      width: payload.width,
      height: payload.height
    })
    if (!written.ok) {
      return {
        ok: false,
        reason: written.reason || 'ERROR',
        previousFaceImageId: written.previousFaceImageId ?? previousFaceImageId,
        message: written.message
      }
    }

    /* ------------------------------------------------------------------
       **上傳即入册（本單 A 層）**：本地寫成功後 —— ① 入雲端影像行；② 把本機影像行 `id`
       與印面指向統一改寫成雲端 `image_id`（一圖一身份）。判定樹與硬口徑見本文件頭
       「上傳即入册」段；**入册失敗絕不編造 id**（本地行保留、指向不動、明確報錯可重試）。 */
    const localImage = written.image || null
    const localImageId = String((localImage && localImage.id) || written.faceImageId || '')
    const localSha = String((localImage && localImage.sha256) || '').trim()
    const localKey = String((localImage && localImage.storage_key) || '').trim()
    /* ① 無雲端對象可入册（字節只在本機權威庫 / 本機影像庫 ⇒ 內容尋址鍵缺席）⇒ **不發請求**
       （發了也必被服務端形態門拒）、**不改寫 id**，並在文案裡如實點名「未入雲端影像行」。 */
    if (localSha === '' || localKey !== artifactObjectKeyOf(localSha)) {
      const devNote = writeFaceMode() === WRITE_FACE_MODES.LOCAL_DEV ? '（dev / 離線形態：本來就沒有雲端寫入面）' : ''
      return {
        ok: true,
        deduped: written.deduped === true,
        sealId: written.sealId || '',
        faceId: id,
        registered: false,
        face: getFaceById(id),
        faceImageId: localImageId,
        previousFaceImageId: written.previousFaceImageId ?? previousFaceImageId,
        image: localImage,
        message:
          `${written.message}；未入雲端影像行（本機權威庫路徑未產生雲端對象鍵）${devNote}` +
          '⇒ 該圖暫不可人工智能修復；本地影像行與印面指向保持不變。'
      }
    }
    const registration = await registerFaceImageOnCloud({
      sealId: written.sealId || '',
      faceId: id,
      image: localImage
    })
    /* ② dev / 離線形態：門放行但未經雲端 ⇒ 如實告知（不改寫 id、不入册）。 */
    if (registration.ok && registration.dev === true) {
      return {
        ok: true,
        deduped: written.deduped === true,
        sealId: written.sealId || '',
        faceId: id,
        registered: false,
        face: getFaceById(id),
        faceImageId: localImageId,
        previousFaceImageId: written.previousFaceImageId ?? previousFaceImageId,
        image: localImage,
        message:
          `${written.message}（dev / 離線形態：未經雲端入册，本機影像編號未改寫；` +
          '該形態人工智能修復本就不可用）'
      }
    }
    /* ③ 入册失敗 ⇒ **不編造 id**：本地行與印面指向原樣保留，明確報錯＋可重試。 */
    if (!registration.ok) {
      return {
        ok: false,
        reason: registration.reason,
        previousFaceImageId: written.previousFaceImageId ?? previousFaceImageId,
        message:
          `印面圖已寫入本機，但雲端入冊失敗：${registration.message} ` +
          '本地影像行與印面指向保持不變（未編造影像編號）；' +
          '請重新上傳同一張圖重試入冊（內容相同不會重複建行）。'
      }
    }
    /* ④ 成功 ⇒ 本機影像行 `id` 與印面指向統一改寫成雲端 `image_id`。 */
    let finalImageId = registration.imageId
    let registeredNote = `；已入雲端影像行（image_id: ${registration.imageId}）`
    if (registration.imageId !== localImageId) {
      const moved = reassignLocalImageIdentity(user, localImageId, registration.imageId)
      if (!moved.ok) {
        return {
          ok: false,
          reason: moved.reason || 'STORAGE_UNAVAILABLE',
          previousFaceImageId: written.previousFaceImageId ?? previousFaceImageId,
          message:
            `雲端入冊成功（image_id: ${registration.imageId}），但本機影像編號改寫失敗：${moved.message} ` +
            '請重新整理後重試（本機影像行仍為原編號，未產生半成品指向）。'
        }
      }
      registeredNote =
        `；已入雲端影像行（image_id: ${registration.imageId}），` +
        '本機影像行編號與印面指向已統一改為該編號'
    }
    return {
      ok: true,
      deduped: written.deduped === true,
      sealId: written.sealId || '',
      faceId: id,
      registered: true,
      /* 视图模型按**当前库态**重建 ⇒ `faceImage` / `face_image_id` 立即反映替换结果
         （身份改寫之後重建 ⇒ 指向已是雲端編號）。 */
      face: getFaceById(id),
      faceImageId: finalImageId,
      previousFaceImageId: written.previousFaceImageId ?? previousFaceImageId,
      image: listImageRows().find((row) => row && row.id === finalImageId) || localImage,
      message: `${written.message}${registeredNote}`
    }
  } catch (err) {
    if (isPermissionError(err)) {
      return { ok: false, reason: 'FORBIDDEN', previousFaceImageId, message: err.message }
    }
    return {
      ok: false,
      reason: 'ERROR',
      previousFaceImageId,
      message: `替換印面圖失敗：${(err && err.message) || '未知原因'}`
    }
  }
}

/* ============================================================================
   **管理員「新增印面」（詳情頁入口 ＋ 彈窗｜本單）**
   ----------------------------------------------------------------------------
   契約真源 ＝ `docs/add-seal-face-ruling-2026-11-14.md` §三 / §四。本層只做**編排 ＋ 如實回報**，
   管道與寫面的每一段都是既有單點，本函數**不自寫第二套**：
     ① 形參門（登錄 → 管理員 → 印章編號 → 類別 → 印文長度 → 字節非空 → 產物上限 → 真圖片容器）；
     ② `storeArtifactBytes`（既有單點）⇒ `sha256` / `bytesLength` / `storageKey` / `mime`；
     ③ 內容尋址 ＋ 容器自檢（對象鍵 ≡ 摘要；容器 ＝ 單頁 8bit Deflate TIFF `STORAGE_MIME`）；
     ④ `registerFaceImage`（既有雲 op，管理員面）先入冊，拿 `image_id`；
     ⑤ `addSealFace`（本單雲 op）載荷**封閉恰 7 鍵**
        `stamp_id / kind / sha256 / bytes / mime / storage_key / seal_name`；
     ⑥ **重取雲端快照**（既有讀口 `retryDataSource()`）＋ 只讀回讀（該面行是否已在快照裡）。
   硬口徑（逐條）：
     · **雲端模式**（`writeFaceMode() === 'cloud'`，生產即此）才走雲 op；**dev / 離線形態沒有雲端
       建面寫面** ⇒ 結構化拒絕 ＋ 零寫入 —— 面行 id / `face_no` / `fid` 由服務端單點發號
       （`nextFaceIdOf` / `issueCodeNumberAvoiding` / `codeId.encodeFaceCode`），本機自造就等於
       第二套口徑，**本層一行本機都不寫**（不碰 localStorage / IndexedDB 行 / 本機鏡像）。
     · **影像先入冊、面後建**：建面失敗時**如實**回「影像已入冊但印面未建立」，不得謊稱零寫入；
       並點明「重試同一張圖不會重複建影像行（內容尋址）」。
     · `reason` **零新增字面值**（只用既有集合：`UNAUTHENTICATED` / `FORBIDDEN` / `MISSING_REQUIRED` /
       `INVALID_VALUE` / `EMPTY_CONTENT` / `NOT_IMAGE` / `ENCODE_FAILED` / `ARTIFACT_TOO_LARGE` /
       `STORAGE_UNAVAILABLE` / `ERROR`）。
   ============================================================================ */

/** 雲端建面 op 名（與雲函數 `ADMIN_OPS` 註冊面逐字一致；本文件唯一出現處）。 */
export const FACE_ADD_OP = 'addSealFace'

/** 雲端回包讀數鍵面（`userWriteGate` 的 additive 透傳聲明；真源＝雲函數成功回包的非信封鍵）。 */
const FACE_ADD_READOUT_KEYS = Object.freeze(['face_id', 'face_no', 'fid', 'kind', 'face_count', 'skipped'])

/** 可建的面類別（缺省 `FACE`；`EDGE` ＝ 邊款，屬同章的特殊印面）。 */
export const FACE_ADD_ALLOWED_KINDS = Object.freeze([FACE_KIND.FACE, FACE_KIND.EDGE])

/** 印章編號上限（與雲 op 的 `stamp_id` 門同值：trim 後 ≤ 64）。 */
export const FACE_ADD_STAMP_ID_MAX = 64

/** 印文上限（與雲函數 `MAX_TEXT_LENGTH` 同值：≤ 500 字；**不硬截斷**，超限即拒）。 */
export const FACE_ADD_SEAL_NAME_MAX = 500

/**
 * 建面時的影像入冊佔位面號 —— **只為過 `registerFaceImage` 的必填門**，不代表任何真實面號。
 *
 * 為什麼需要：`registerFaceImage` 的必填五串含 `face_id`，而本單的目標面**尚未存在**（面號由
 * 服務端 `addSealFace` 依 `nextFaceIdOf` 發號）。該 op 只用 `face_id` 過必填 / 字符串門
 * （行體按**內容尋址** `_id` 建、**不含**面引用），故事先給一個**顯式命名為 pending** 的佔位值，
 * **不冒充**任何真實面號、也不落盤到面行。
 */
export const FACE_REGISTER_PENDING_FACE_ID = 'fc-pending-add-face'

/** 當前（或指定）賬號是否可**新增印面** —— 與 `canReplaceFaceImage` / `canDeleteSeal` 同一套門。 */
export function canAddSealFace(actor) {
  const user = actor || currentUser()
  return user !== null && user !== undefined && user.role === 'admin'
}

/**
 * 雲端快照裡是否已有該面行（只讀快照，**不讀本機鏡像**、不推導）。
 * @param {string} faceId 印面編號
 * @returns {{found:boolean, state:string, row:object|null}}
 */
function cloudFaceRowOf(faceId) {
  const cloud = cloudBaseReadOf('faces')
  const state = cloud && typeof cloud.state === 'string' ? cloud.state : 'unknown'
  if (!cloud || cloud.state !== 'ready' || !Array.isArray(cloud.rows)) return { found: false, state, row: null }
  const row = cloud.rows.find(
    (item) => item && (String(item.id || '') === faceId || String(item._id || '') === faceId)
  )
  return { found: Boolean(row), state, row: row || null }
}

/**
 * **新增一個印面**（管理員專屬；詳情頁「印面列表」入口的唯一業務入口）。
 *
 * @param {{stampId?:string, stamp_id?:string, kind?:string, sealName?:string, seal_name?:string,
 *          bytes?:Uint8Array|ArrayBuffer, mime?:string, width?:number, height?:number}} [payload]
 *   `bytes` ＝ 瀏覽器端處理後的**存儲件**（單頁 8bit Deflate TIFF；**不得**是原始 PNG / JPG 字節）。
 * @returns {Promise<{ok:boolean, faceId?:string, faceNo?:number, fid?:string, kind?:string,
 *   faceCount?:number, skipped?:boolean, imageId?:string, registered?:boolean,
 *   verifiedInSnapshot?:boolean, snapshotState?:string, reason?:string, message:string}>}
 *   - 成功：`faceId` / `faceNo` / `fid` / `kind` / `faceCount` 逐字取**服務端回包**；
 *     `skipped === true` ＝ 冪等命中（同章 ＋ 同類 ＋ 同摘要的面行已存在，未建第二行）。
 *   - 失敗：`ok:false` ＋ 既有 `reason` ＋ 可讀繁體 `message`；
 *     `registered === true` ⇒ **影像已入冊但印面未建立**（文案如實點明，不謊稱零寫入）。
 */
export async function addSealFace(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {}
  const stampId = String(source.stampId ?? source.stamp_id ?? '').trim()
  const kindRaw = String(source.kind ?? '').trim() || FACE_KIND.FACE
  const sealName = String(source.sealName ?? source.seal_name ?? '').trim()

  /* ① 形參門 —— 全部判在任何請求 / 任何寫入之前。 */
  const user = currentUser()
  if (!user) {
    return { ok: false, reason: 'UNAUTHENTICATED', message: '請先登錄管理員賬號後再新增印面（本次未提交任何內容）。' }
  }
  if (!canAddSealFace(user)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以新增印面（本次未提交任何內容）。' }
  }
  if (!stampId) {
    return { ok: false, reason: 'MISSING_REQUIRED', message: '未指定要新增印面的印章（缺少 stamp_id）；本次未提交任何內容。' }
  }
  if (stampId.length > FACE_ADD_STAMP_ID_MAX) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `印章編號（stamp_id）超過 ${FACE_ADD_STAMP_ID_MAX} 個字符；本次未提交任何內容。`
    }
  }
  if (FACE_ADD_ALLOWED_KINDS.indexOf(kindRaw) === -1) {
    return { ok: false, reason: 'INVALID_VALUE', message: '印面類別（kind）取值不合法；本次未提交任何內容。' }
  }
  if (sealName.length > FACE_ADD_SEAL_NAME_MAX) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `印文超過 ${FACE_ADD_SEAL_NAME_MAX} 字上限（現 ${sealName.length} 字）；本次未提交任何內容。`
    }
  }
  const bytes = toUint8Array(source.bytes)
  if (!bytes || bytes.length === 0) {
    return { ok: false, reason: 'EMPTY_CONTENT', message: '印面圖內容爲空，請先選擇本機圖片文件或粘貼剪貼板圖片；本次未提交任何內容。' }
  }
  /* 產物側兜底：判的是**處理後的二進制**（4 MiB），不是輸入文件的 1 MB（後者判在 `loadImageFile`）。 */
  if (bytes.length > FACE_IMAGE_ARTIFACT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'ARTIFACT_TOO_LARGE',
      message:
        `本機影像生成失敗：印面圖存儲件 ${describeBytes(bytes.length)} 超過入庫上限 ` +
        `${describeBytes(FACE_IMAGE_ARTIFACT_MAX_BYTES)}；本次未提交任何內容。`
    }
  }
  /* 容器門（真源＝字節魔數）：入冊對象**只認單頁 8bit Deflate TIFF**；原始 PNG / JPG 直接拒。 */
  const actualMime = sniffBytesMime(bytes)
  if (!actualMime) {
    return { ok: false, reason: 'NOT_IMAGE', message: '這不是可用的圖片內容（無法識別圖片格式）；本次未提交任何內容。' }
  }
  if (actualMime !== STORAGE_MIME) {
    return {
      ok: false,
      reason: 'ENCODE_FAILED',
      message:
        `入庫對象必須是存儲容器 ${STORAGE_MIME}（按字節魔數判定為 ${actualMime}）⇒ 已拒絕提交；` +
        '本次未建立任何影像行、未建立印面（原始 PNG / JPG 字節不得直接入冊，請經影像管線處理後再提交）。'
    }
  }

  /* ② 形態分流點（唯一一處）：雲端模式才走雲 op；dev / 離線形態如實拒絕，**不造本機面行**。 */
  if (writeFaceMode() !== WRITE_FACE_MODES.CLOUD) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message:
        '本機為 dev / 離線形態（沒有雲端建面寫面）：面號與印面編號由服務端發號，本機不自行建面；' +
        '本次未提交任何內容、未建立任何印面。'
    }
  }

  /* ③ 字節交權威存儲（既有單點；內容尋址、冪等）。 */
  const stored = await storeArtifactBytes(bytes)
  if (!stored || stored.ok !== true) {
    return {
      ok: false,
      reason: (stored && stored.reason) || 'STORAGE_UNAVAILABLE',
      message: `印面圖上傳失敗：${(stored && stored.message) || '權威存儲暫時不可用'}；本次未建立任何雲端影像行、未建立印面。`
    }
  }
  const sha256 = String(stored.sha256 || '').toLowerCase()
  const storageKey = String(stored.storageKey || stored.storage_key || '')
  const storedBytes = Number(stored.bytesLength)
  const storedMime = String(stored.mime || '').trim().toLowerCase()
  if (!sha256 || !storageKey || !Number.isInteger(storedBytes) || storedBytes <= 0 || storageKey !== artifactObjectKeyOf(sha256)) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message:
        `印面圖上傳回包缺少內容尋址讀數（sha256 / bytes / storage_key；storage_key＝${storageKey || '空'}）` +
        '⇒ 未產生雲端內容尋址對象鍵；本次未入雲端影像行、未建立印面。'
    }
  }
  if (storedMime && storedMime !== STORAGE_MIME) {
    return {
      ok: false,
      reason: 'ENCODE_FAILED',
      message:
        `入庫對象不是存儲容器 ${STORAGE_MIME}（按字節魔數判定為 ${storedMime}）⇒ 已拒絕入冊；` +
        '本次未建立任何雲端影像行、未建立印面。'
    }
  }
  const mime = storedMime || STORAGE_MIME

  /* ④ 先入冊（既有雲 op `registerFaceImage`；管理員面、封閉鍵面、內容尋址 `_id`、冪等）。 */
  let registration = null
  try {
    registration = await userWriteGate(
      FACE_IMAGE_REGISTER_OP,
      {
        seal_id: stampId,
        /* 佔位面號：目標面尚未存在（面號由 `addSealFace` 發號）；該 op 只用它過必填門、行體不含面引用。 */
        face_id: FACE_REGISTER_PENDING_FACE_ID,
        sha256,
        bytes: storedBytes,
        mime,
        storage_key: storageKey,
        kind: kindRaw
      },
      { readoutKeys: FACE_IMAGE_REGISTER_READOUT_KEYS }
    )
  } catch (err) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: `影像入冊請求失敗：${(err && err.message) || '未知原因'}；本次未建立印面（面行零寫入）。`
    }
  }
  if (registration && registration.dev === true) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '本機為 dev / 離線形態（沒有雲端影像入冊面）⇒ 本次未建立印面（面行零寫入）。'
    }
  }
  if (!registration || registration.ok !== true) {
    return {
      ok: false,
      reason: (registration && registration.reason) || 'STORAGE_UNAVAILABLE',
      message:
        `印面圖存儲件已就位，但影像入冊失敗：${(registration && registration.message) || '入冊服務暫時不可用'}；` +
        '本次未建立印面（面行零寫入），可重試（同一張圖不會重複建影像行）。'
    }
  }
  const registeredFromReadout = typeof registration.image_id === 'string' ? registration.image_id.trim() : ''
  const registeredFromDocId = typeof registration.docId === 'string' ? registration.docId.trim() : ''
  const imageId = registeredFromReadout || registeredFromDocId
  if (!imageId.startsWith('img-')) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '影像入冊回包形狀不可辨識（未附影像編號 image_id）；本次未建立印面（面行零寫入），請稍後重試。'
    }
  }

  /* ⑤ 建面（雲 op；載荷**封閉恰 7 鍵**，逐字對齊裁定件 §三）。 */
  let gate = null
  try {
    gate = await userWriteGate(
      FACE_ADD_OP,
      {
        stamp_id: stampId,
        kind: kindRaw,
        sha256,
        bytes: storedBytes,
        mime,
        storage_key: storageKey,
        seal_name: sealName
      },
      { readoutKeys: FACE_ADD_READOUT_KEYS }
    )
  } catch (err) {
    return {
      ok: false,
      reason: 'ERROR',
      imageId,
      registered: true,
      message:
        `影像已入冊但印面未建立：建面請求異常（${(err && err.message) || '未知原因'}）；` +
        `影像編號 ${imageId} 已入冊（內容尋址），重試同一張圖不會重複建影像行。`
    }
  }
  if (!gate || gate.ok !== true) {
    /* **如實交代**：影像行已入冊（上面那一步成功），面行零寫入 ⇒ 不得謊稱「零寫入」。 */
    return {
      ok: false,
      reason: (gate && gate.reason) || 'STORAGE_UNAVAILABLE',
      imageId,
      registered: true,
      message:
        `影像已入冊但印面未建立：${(gate && gate.message) || '新增印面服務暫時不可用，請稍後再試。'}` +
        `（影像編號 ${imageId} 已入冊、內容尋址；重試同一張圖不會重複建影像行，本次未建立任何面行）`
    }
  }
  /* ⑥ 回包讀數逐字取用（**不按規則自行推導**面號 / 印面編號）。 */
  const faceId = typeof gate.face_id === 'string' ? gate.face_id.trim() : ''
  const faceNo = Number(gate.face_no)
  const fid = typeof gate.fid === 'string' ? gate.fid.trim() : ''
  const kindOut = typeof gate.kind === 'string' && gate.kind.trim() ? gate.kind.trim() : kindRaw
  const faceCount = Number.isFinite(Number(gate.face_count)) ? Number(gate.face_count) : null
  const skipped = gate.skipped === true
  if (!faceId) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      imageId,
      registered: true,
      message:
        '雲端建面回包形狀不可辨識（未附印面編號 face_id）；面行以服務端為準，請重新整理後確認，' +
        `影像編號 ${imageId} 已入冊。`
    }
  }

  /* ⑦ 重取雲端快照（與本頁既有寫面同一刷新路徑）＋ 只讀回讀。 */
  try {
    await retryDataSource()
  } catch (err) {
    /* 重取失敗不改變建面結論（面行已由服務端建好）；下面的回讀讀數會如實反映快照狀態。 */
  }
  const readback = cloudFaceRowOf(faceId)
  const countText = faceCount === null ? '' : `；本印章現有 ${faceCount} 個印面`
  /* **上屏面角色（裁定件 §三）**：回包不含 `is_primary` ⇒ 按面數如實推定 ——
     本輪建的是本章**第一枚**面（`face_count === 1`）⇒ `base face`，其餘 ⇒ `side face`；
     `kind = 'EDGE'` 的行一律 `side face`（`kind` 不參與上屏分類）。 */
  const kindText =
    kindOut !== FACE_KIND.EDGE && Number(faceCount) === 1 ? FACE_ROLE_BASE : FACE_ROLE_SIDE
  const base = {
    ok: true,
    faceId,
    faceNo: Number.isFinite(faceNo) && faceNo > 0 ? faceNo : 0,
    fid,
    kind: kindOut,
    faceCount,
    skipped,
    imageId,
    registered: true,
    verifiedInSnapshot: readback.found,
    snapshotState: readback.state
  }
  const head = skipped
    ? `該印面已存在（同印章、同類別、同影像），未重複建立：印面編號 ${faceId}（${kindText}${base.faceNo ? `，面號 ${base.faceNo}` : ''}）`
    : `新印面已加入：印面編號 ${faceId}（${kindText}${base.faceNo ? `，面號 ${base.faceNo}` : ''}）`
  const tail = readback.found
    ? `${countText}；印面圖與屬性可繼續編輯。`
    : `${countText}；雲端快照暫未見該印面（快照狀態：${readback.state}），請稍後重新整理確認（面行以服務端為準）。`
  return { ...base, message: `${head}${tail}` }
}

/* ============================================================================
   **管理員「整枚印章圖」入冊（裁定件 §五｜第三選項：不建面）**
   ----------------------------------------------------------------------------
   口徑：整枚印章圖**不屬於任何面** ⇒ **不調 `addSealFace`**、不建面行、`face_count` 不變；
   只跑既有管道（`storeArtifactBytes` → `registerFaceImage`）建影像行，且**不被任何面引用**
   ⇒ 詳情頁「整枚印章圖」區塊可見（`xiai_images` 已在讀面集合 ⇒ 零新增 op、零新 reason）。
   硬口徑（逐條）：
     · **零新增 op**：入冊走既有 `registerFaceImage`（`ADMIN_OPS` 集合不變）；
     · `face_id` 必填門沿用既有**佔位串** `FACE_REGISTER_PENDING_FACE_ID`（該 op 只用它過必填 /
       字符串門、行體不含面引用）；佔位值**顯式命名為 pending**，不冒充任何真實面號；
     · `kind` 上送 `FACE`（影像族容器口徑）；該行不出現在任何面行的 `face_image_id` /
       `edge_image_ids` 裡 ⇒ 不參與 base / side 分類；
     · dev / 離線形態沒有雲端入冊面 ⇒ 結構化拒絕 ＋ 零寫入（不造假行）；
     · 成功 ⇒ 重取雲端快照 ＋ 只讀回讀（影像行是否已在快照裡），如實上屏。
   ============================================================================ */

/**
 * **整枚印章圖入冊**（管理員專屬；`AddSealFaceDialog` 第三選項的唯一業務入口）。
 *
 * @param {{stampId?:string, stamp_id?:string, bytes?:Uint8Array|ArrayBuffer,
 *          mime?:string, width?:number, height?:number}} [payload]
 *   `bytes` ＝ 瀏覽器端處理後的**存儲件**（單頁 8bit Deflate TIFF；不得是原始 PNG / JPG 字節）。
 * @returns {Promise<{ok:boolean, imageId?:string, registered?:boolean, wholeSeal?:boolean,
 *   verifiedInSnapshot?:boolean, snapshotState?:string, reason?:string, message:string}>}
 */
export async function registerWholeSealImage(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {}
  const stampId = String(source.stampId ?? source.stamp_id ?? '').trim()

  /* ① 形參門 —— 全部判在任何請求 / 任何寫入之前（與 `addSealFace` 同門、同 reason 集合）。 */
  const user = currentUser()
  if (!user) {
    return { ok: false, reason: 'UNAUTHENTICATED', message: '請先登錄管理員賬號後再加入整枚印章圖（本次未提交任何內容）。' }
  }
  if (!canAddSealFace(user)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以加入整枚印章圖（本次未提交任何內容）。' }
  }
  if (!stampId) {
    return { ok: false, reason: 'MISSING_REQUIRED', message: '未指定要加入整枚印章圖的印章（缺少 stamp_id）；本次未提交任何內容。' }
  }
  if (stampId.length > FACE_ADD_STAMP_ID_MAX) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `印章編號（stamp_id）超過 ${FACE_ADD_STAMP_ID_MAX} 個字符；本次未提交任何內容。`
    }
  }
  const bytes = toUint8Array(source.bytes)
  if (!bytes || bytes.length === 0) {
    return { ok: false, reason: 'EMPTY_CONTENT', message: '整枚印章圖內容爲空，請先選擇本機圖片文件或粘貼剪貼板圖片；本次未提交任何內容。' }
  }
  if (bytes.length > FACE_IMAGE_ARTIFACT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'ARTIFACT_TOO_LARGE',
      message:
        `本機影像生成失敗：整枚印章圖存儲件 ${describeBytes(bytes.length)} 超過入庫上限 ` +
        `${describeBytes(FACE_IMAGE_ARTIFACT_MAX_BYTES)}；本次未提交任何內容。`
    }
  }
  const actualMime = sniffBytesMime(bytes)
  if (!actualMime) {
    return { ok: false, reason: 'NOT_IMAGE', message: '這不是可用的圖片內容（無法識別圖片格式）；本次未提交任何內容。' }
  }
  if (actualMime !== STORAGE_MIME) {
    return {
      ok: false,
      reason: 'ENCODE_FAILED',
      message:
        `入庫對象必須是存儲容器 ${STORAGE_MIME}（按字節魔數判定為 ${actualMime}）⇒ 已拒絕提交；` +
        '本次未建立任何影像行（原始 PNG / JPG 字節不得直接入冊，請經影像管線處理後再提交）。'
    }
  }

  /* ② 形態分流點（唯一一處）：雲端模式才走雲 op（本機不造假影像行）。 */
  if (writeFaceMode() !== WRITE_FACE_MODES.CLOUD) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message:
        '本機為 dev / 離線形態（沒有雲端影像入冊面）：整枚印章圖只入雲端影像行，本機不自行建行；' +
        '本次未提交任何內容。'
    }
  }

  /* ③ 字節交權威存儲（既有單點；內容尋址、冪等）。 */
  const stored = await storeArtifactBytes(bytes)
  if (!stored || stored.ok !== true) {
    return {
      ok: false,
      reason: (stored && stored.reason) || 'STORAGE_UNAVAILABLE',
      message: `整枚印章圖上傳失敗：${(stored && stored.message) || '權威存儲暫時不可用'}；本次未建立任何雲端影像行。`
    }
  }
  const sha256 = String(stored.sha256 || '').toLowerCase()
  const storageKey = String(stored.storageKey || stored.storage_key || '')
  const storedBytes = Number(stored.bytesLength)
  const storedMime = String(stored.mime || '').trim().toLowerCase()
  if (!sha256 || !storageKey || !Number.isInteger(storedBytes) || storedBytes <= 0 || storageKey !== artifactObjectKeyOf(sha256)) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message:
        `整枚印章圖上傳回包缺少內容尋址讀數（sha256 / bytes / storage_key；storage_key＝${storageKey || '空'}）` +
        '⇒ 未產生雲端內容尋址對象鍵；本次未入雲端影像行。'
    }
  }
  if (storedMime && storedMime !== STORAGE_MIME) {
    return {
      ok: false,
      reason: 'ENCODE_FAILED',
      message:
        `入庫對象不是存儲容器 ${STORAGE_MIME}（按字節魔數判定為 ${storedMime}）⇒ 已拒絕入冊；` +
        '本次未建立任何雲端影像行。'
    }
  }
  const mime = storedMime || STORAGE_MIME

  /* ④ 入冊（既有雲 op `registerFaceImage`；**不建面**）。 */
  let registration = null
  try {
    registration = await userWriteGate(
      FACE_IMAGE_REGISTER_OP,
      {
        seal_id: stampId,
        face_id: FACE_REGISTER_PENDING_FACE_ID,
        sha256,
        bytes: storedBytes,
        mime,
        storage_key: storageKey,
        kind: FACE_KIND.FACE
      },
      { readoutKeys: FACE_IMAGE_REGISTER_READOUT_KEYS }
    )
  } catch (err) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: `整枚印章圖入冊請求失敗：${(err && err.message) || '未知原因'}；本次未建立任何影像行。`
    }
  }
  if (registration && registration.dev === true) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '本機為 dev / 離線形態（沒有雲端影像入冊面）⇒ 本次未建立任何影像行。'
    }
  }
  if (!registration || registration.ok !== true) {
    return {
      ok: false,
      reason: (registration && registration.reason) || 'STORAGE_UNAVAILABLE',
      message:
        `整枚印章圖存儲件已就位，但影像入冊失敗：${(registration && registration.message) || '入冊服務暫時不可用'}；` +
        '本次未建立任何影像行，可重試（同一張圖不會重複建影像行）。'
    }
  }
  const registeredFromReadout = typeof registration.image_id === 'string' ? registration.image_id.trim() : ''
  const registeredFromDocId = typeof registration.docId === 'string' ? registration.docId.trim() : ''
  const imageId = registeredFromReadout || registeredFromDocId
  if (!imageId.startsWith('img-')) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '影像入冊回包形狀不可辨識（未附影像編號 image_id）；本次未建立任何影像行，請稍後重試。'
    }
  }

  /* ⑤ 重取雲端快照 ＋ 只讀回讀（影像行是否已在快照裡；**面行零改動**）。 */
  try {
    await retryDataSource()
  } catch (err) {
    /* 重取失敗不改變入冊結論（行已由服務端建好）；下面的回讀讀數會如實反映快照狀態。 */
  }
  const snapshot = cloudBaseReadOf('images')
  const snapshotState = snapshot && typeof snapshot.state === 'string' ? snapshot.state : 'unknown'
  const verified = Boolean(findCloudImageRow(imageId))
  const tail = verified
    ? '詳情頁「整枚印章圖」區塊即可見（該圖不屬於任何面，印面數不變）。'
    : `雲端快照暫未見該影像（快照狀態：${snapshotState}），請稍後重新整理確認（影像行以服務端為準）。`
  return {
    ok: true,
    imageId,
    registered: true,
    wholeSeal: true,
    verifiedInSnapshot: verified,
    snapshotState,
    message: `整枚印章圖已入冊：影像編號 ${imageId}（不建立面、不改變印面數）；${tail}`
  }
}

/* ============================================================================
   **R-83 〜 R-88（2026-09-21｜Kong-I2 图像管线单）**
   印面源图 = 8 级灰索引色 PNG ／ 切片窗口消费（几何全在数据层）／ 双色调导出（webp）


/**
 * 印面源图产物的 mime ＝ **存储容器**（单页 8bit Deflate TIFF —— 两类影像一律同一容器，
 * 不按面类分流；字节魔数由管线按字节如实给出）。展示容器另名（`DISPLAY_MIME`，webp 0.92）。
 */
export const FACE_SOURCE_MIME = STORAGE_MIME

/** 切片类别字面值：`FACE`＝印面族（影像行 `kind` 为 `FACE` / `EDGE`，均按**印面 4 块**）。 */
export const SLICE_KIND_FACE = FACE_KIND.FACE

/**
 * 数据层的切片元数据（**消费真源，绝不自己算切位**）：
 *   ① 行上已持久化的 `slice_meta`（R-87：数据层确定性派生并持久化）⇒ **逐字采用**；
 *   ② 行上没有该键（既有行**无需迁移**）⇒ 调**数据层的同一派生函数** `db.sliceMetaOf(id, kind)`。
 * @returns {{meta:object, source:'row'|'derived', id:string}}
 */
function sliceMetaOfRow(row, kind, fallbackId = '') {
  const persisted = row && typeof row === 'object' ? row[SLICE_META_FIELD] : null
  if (persisted && typeof persisted === 'object' && !Array.isArray(persisted)) {
    return { meta: persisted, source: 'row', id: (row && row.id) || fallbackId }
  }
  const id = (row && row.id) || fallbackId || ''
  return { meta: dataSliceMetaOf(id, kind), source: 'derived', id }
}

/**
 * 某个影像的**切片计划**（块数 / 刀向 / 切位 / 逐窗坐标全部来自数据层）。
 * @param {string} imageId 影像编号
 * @param {string} [kind] 切片类别（`FACE` 印面族 / `PHOTO` 实拍族）
 * @returns {{ok:boolean, imageId:string, kind:string, source:string, meta:object|null,
 *            windows:Array<object>, rects:Array<object>, report:object|null,
 *            width:number, height:number, message:string}}
 */
export function slicePlanOfImage(imageId, kind = SLICE_KIND_FACE) {
  const id = String(imageId || '').trim()
  const row = id ? listImageRows().find((item) => item.id === id) || null : null
  const { meta, source } = sliceMetaOfRow(row, kind, id)
  const windows = dataSliceWindowsOf(meta)
  const width = row ? Math.round(Number(row.width) || 0) : 0
  const height = row ? Math.round(Number(row.height) || 0) : 0
  const converted = width > 0 && height > 0 ? windowsToPixelRects(windows, width, height) : null
  const rects = converted ? converted.rects : []
  const report = converted && converted.ok ? rectSeamReport(rects, width, height) : null
  return {
    ok: windows.length > 0,
    imageId: id,
    kind,
    source,
    meta,
    windows,
    rects,
    report,
    width,
    height,
    message: windows.length > 0
      ? `切片元數據（來源 ${source === 'row' ? `行上 ${SLICE_META_FIELD}` : '數據層派生'}）：${windows.length} 塊` +
        (report ? `；無縫校驗：面積相等 ${report.areaEqualsSource ? '是' : '否'}、兩兩不交 ${report.noOverlap ? '是' : '否'}` : '')
      : '切片元數據不可用（影像不存在或尺寸元數據缺失）'
  }
}

/**
 * 按数据层切窗**逐块裁剪**某个影像（展示层拼接用；`options.encodeMime` 给了就连块编码）。
 * @param {string} imageId 影像编号
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap 影像二进制解出的可绘制源
 * @param {{kind?:string, encodeMime?:string, quality?:number}} [options]
 */
export async function faceSliceTiles(imageId, bitmap, options = {}) {
  const plan = slicePlanOfImage(imageId, options.kind || SLICE_KIND_FACE)
  if (plan.windows.length === 0) {
    return { ok: false, tiles: [], rects: [], report: null, plan, reason: 'SLICE_META_UNAVAILABLE', message: plan.message }
  }
  const rendered = await renderSliceTiles(bitmap, plan.windows, {
    encodeMime: options.encodeMime,
    quality: options.quality
  })
  return { ...rendered, plan }
}

/**
 * **印面源圖（存儲件）**：把浏览器端可绘制源编成 **单页 8bit Deflate TIFF**。
 *
 * 容器口径（§3.22.1 四条 ＋ §3.25.2「单页」）：RGB 8-bit 连续取样 / `Compression = 8`
 * （Deflate，zlib 流）/ 不透明则省 Alpha（`SamplesPerPixel = 3`）/ 单页；
 * **保留原色**（不再灰度化、不再 8 级量化、不再要求无彩色）。本条与实拍面**同一入口口径**
 * （容器定义点恰 1 处 ＝ `utils/tiff.js`），**不按面类分流**。
 * 产物**自证标签**后才交付（影像页数 / 压缩 / 位深 / 取样 / 平面配置任一不符 ⇒ 结构化拒绝，
 * 绝不冒充）。
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap
 * @param {{crop?:object, maxSide?:number, maxBytes?:number}} [options]
 * @returns {Promise<{ok:boolean, bytes:Uint8Array|null, mime:string, width:number, height:number,
 *          tiff:object|null, stripCount:number, deflate:string, initialBytes:number,
 *          reencodeRounds:number, reason?:string, message:string}>}
 */
export async function prepareFaceImageSource(bitmap, options = {}) {
  const maxBytesRaw = Number(options.maxBytes)
  const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? Math.round(maxBytesRaw) : FACE_IMAGE_ARTIFACT_MAX_BYTES
  const encoded = await exportStoredTiff(bitmap, {
    crop: options.crop,
    maxSide: options.maxSide,
    maxBytes
  })
  const base = {
    ok: false,
    bytes: null,
    mime: '',
    width: encoded.width || 0,
    height: encoded.height || 0,
    tiff: encoded.tiff || null,
    stripCount: encoded.stripCount || 0,
    deflate: encoded.deflate || '',
    initialBytes: encoded.initialBytes || 0,
    reencodeRounds: encoded.reencodeRounds || 0,
    reason: '',
    message: ''
  }
  if (!encoded.ok) {
    return { ...base, reason: encoded.reason || 'ENCODE_FAILED', message: encoded.message }
  }
  /* 产物侧上限（**与既有 `replaceFaceImage` 同一常量**；管线内已按最长边有界降采样重编）。 */
  if (encoded.bytes.length > maxBytes) {
    return {
      ...base,
      reason: 'ARTIFACT_TOO_LARGE',
      message:
        `本機影像生成失敗：印面圖存儲件 ${describeBytes(encoded.bytes.length)} 超過入庫上限 ${describeBytes(maxBytes)}。` +
        '這與「所選文件 ≤ 1 MB」的輸入上限是兩回事。'
    }
  }
  /* mime 以**字节魔数**为准（不采信任何声称值）。 */
  const mime = sniffBytesMime(encoded.bytes)
  if (mime !== FACE_SOURCE_MIME) {
    return {
      ...base,
      reason: 'SELFCHECK_FAILED',
      message: `印面源圖自檢未通過：產物字節魔數爲 ${mime || '認不出'}（期望 ${FACE_SOURCE_MIME}），已拒絕交付`
    }
  }
  /* 自证容器标签：单页 ＋ Compression=8 ＋ BitsPerSample=[8,8,8] ＋ RGB ＋ 三通道 ＋ chunky。 */
  const facts = encoded.tiff
  const tagOk = !!facts && facts.ok &&
    facts.imagePages === 1 &&
    facts.compression === 8 &&
    facts.photometricInterpretation === 2 &&
    facts.samplesPerPixel === 3 &&
    facts.planarConfiguration === 1 &&
    facts.bitsPerSample.join(',') === '8,8,8'
  if (!tagOk) {
    return {
      ...base,
      reason: 'SELFCHECK_FAILED',
      message:
        '印面源圖自檢未通過（期望單頁 / Compression=8 / BitsPerSample=[8,8,8] / PhotometricInterpretation=2 / ' +
        `SamplesPerPixel=3 / PlanarConfiguration=1；實測 ${facts ? `${facts.imagePages} 頁 / ${facts.compression} / ` +
        `[${facts.bitsPerSample.join(',')}] / ${facts.photometricInterpretation} / ${facts.samplesPerPixel} / ` +
        `${facts.planarConfiguration}` : '標籤讀不出'}）`
    }
  }
  return {
    ...base,
    ok: true,
    bytes: encoded.bytes,
    mime,
    width: facts.width,
    height: facts.height,
    message:
      `印面源圖：單頁 8bit Deflate TIFF ${facts.width}×${facts.height}，Compression=8、` +
      `BitsPerSample=[${facts.bitsPerSample.join(',')}]、PhotometricInterpretation=${facts.photometricInterpretation}、` +
      `SamplesPerPixel=${facts.samplesPerPixel}、影像頁 ${facts.imagePages}、strip ${facts.stripByteCounts.length} 條，` +
      `${describeBytes(encoded.bytes.length)}`
  }
}

/**
 * 印面图上传闭环（R-83）：**编 8 色索引 PNG → 交给既有 `replaceFaceImage` 入库**。
 *
 * 既有不回退面**全部照旧**：输入侧 1 MB 判**原始文件字节**（判在 `utils/image.js`）、
 * 产物侧 4 MiB ＋ 有界降质重编、mime 按**字节魔数**、localStorage 只存元数据、二进制进 IndexedDB、
 * 认不出即拒 —— 本函数**不新增也不放宽**任何一条。
 * @param {string} faceId 目标印面编号
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap
 * @param {{crop?:object, maxSide?:number}} [options]
 */
/**
 * 印面图上传闭环：**编单页 8bit Deflate TIFF → 交给既有 `replaceFaceImage` 入库**。
 *
 * 既有不回退面**全部照旧**：输入侧 1 MB 判**原始文件字节**（判在 `utils/image.js`）、
 * 产物侧 4 MiB ＋ 有界降采样重编、mime 按**字节魔数**、localStorage 只存元数据、二进制进 IndexedDB、
 * 认不出即拒 —— 本函数**不新增也不放宽**任何一条。
 * @param {string} faceId 目标印面编号
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap
 * @param {{crop?:object, maxSide?:number}} [options]
 */
export async function uploadFaceImageSource(faceId, bitmap, options = {}) {
  const prepared = await prepareFaceImageSource(bitmap, options)
  if (!prepared.ok) {
    return {
      ok: false,
      reason: prepared.reason,
      message: prepared.message,
      tiff: prepared.tiff
    }
  }
  const replaced = await replaceFaceImage(faceId, {
    bytes: prepared.bytes,
    mime: prepared.mime,
    width: prepared.width,
    height: prepared.height
  })
  return {
    ...replaced,
    /* 源图口径随上传结果一并回报（取证 / 排障用；**不进元数据行**）。 */
    source: {
      mime: prepared.mime,
      bytes: prepared.bytes.length,
      width: prepared.width,
      height: prepared.height,
      pages: prepared.tiff ? prepared.tiff.imagePages : 0,
      compression: prepared.tiff ? prepared.tiff.compression : 0,
      bitsPerSample: prepared.tiff ? prepared.tiff.bitsPerSample : [],
      stripCount: prepared.stripCount,
      deflate: prepared.deflate,
      reencodeRounds: prepared.reencodeRounds
    }
  }
}








/** 把逐块画布按原坐标拼回整图（拼接自证 / 导出；把数据层窗口的几何原样喂回去）。 */
export { composeSliceTiles }

/* ============================================================================
   **印章批 3 前置（v1.55｜§3.55 ＋ §4.1.17）：印章外部批量導入通道 ＋ 管理員採納通道**
   ----------------------------------------------------------------------------
   · 導入（提交）＝ **外部批量導入通道**：經 `userWriteGate('submitSealImport', …)` 落
     `xiai_seal_imports` 的 `PENDING` 行（**冪等鍵 `source` ＋ `source_seal_id`**；重複導入不改寫既有行）。
   · 採納 / 駁回 ＝ **管理員**（登錄令牌 ＋ 手機號白名單，沿 §3.48；缺 env ⇒ 安全拒 ＋ 零寫入）。
     `ACCEPTED` ⇒ **整條**冪等落 `xiai_seals`（印章級）＋ `xiai_faces`（印面級，含邊款 `kind=EDGE`），
     且**同置** `review_status='APPROVED'`（按 `source` ＋ `source_seal_id` 冪等；**重複採納不改寫既有行**，
     讀回比對，**不以 updated>=1 判成功** —— 沿 liwu 數據層硬口徑）；`REJECTED` ⇒ **零寫入**（僅導入行狀態）。
   · **兩字段分列**：`imports.status` 與 `seals.review_status` **不是一個東西**（採納時兩者同時推進、
     不得互相替代）；存量 `review_status` **逐字保留、不遷移、不改寫**。
   · **逐條獨立**：失敗行**保持 `PENDING` 且零寫入**，成功行落庫；成功面**可重放且冪等**；不得半條落庫。
   · **影像引用校驗**：採納時**逐條校驗引用對象存在**（缺失 ⇒ 該條拒絕 ＋ 零寫入）——
     校驗**複用既有讀面** `imageRowByRef`（**不新增第二套讀法**）。
   · **內容指紋僅作軟提示**：指紋相同**不得拒收**（只在返回體隨附疑似重複標記）。
   · **零新增 `reason` 字面值**（一律沿用既有凍結表）。
   寫面門**沿用**：與 `persons` / `corrections` **同一通道**（`userWriteGate`：含令牌自愈 /
   `dev`·離線 與 雲端 兩形態 / 失敗零寫入 / 本機鏡像回寫）。雲端命中：
   `submitSealImport` ∈ `xiai-user-token` 的 `OPS`；`reviewSealImport` ∈ 同函數 `ADMIN_OPS`
   （登錄令牌 ＋ 手機號白名單）。兩 `index.js` 皆為 `hasOwnProperty` 動態派發 ⇒ **未動雲函數**。
   · **未覆蓋（如實登記）**：`xiai_seal_imports` 尚待人工新建（雲控制台動作）⇒ **雲端落庫路徑不可達**；
     故雲端形態端到端**當前不可驗**（依賴未建集合 / 未部署）。本機（dev / 離線）形態可驗。
   ============================================================================ */

/** 導入行三態（轉發真源 `seed.js::SEAL_IMPORT_STATUS`；單向、終態不回退）。 */
export const SEAL_IMPORT_STATUS_EXPORT = SEAL_IMPORT_STATUS

/** 導入單號 / 冪等鍵上限（服務層本地護欄；與印人導入同規格）。 */
export const MAX_SEAL_IMPORT_ID_LENGTH = 128
/** 駁回理由上限（與勘誤 / 印人導入同值 200 字）。 */
export const MAX_SEAL_REVIEW_NOTE_LENGTH = 200

function importNowIso() {
  return new Date().toISOString()
}

function makeSealImportId() {
  return `${SEAL_IMPORT_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 導入狀態歸一（舊 / 缺值 ⇒ `PENDING`）。 */
export function normalizeSealImportStatus(status) {
  const text = String(status || '').trim()
  if (text === SEAL_IMPORT_STATUS.ACCEPTED || text === SEAL_IMPORT_STATUS.REJECTED) return text
  return SEAL_IMPORT_STATUS.PENDING
}

/** 審核決定歸一：`ACCEPTED` / `REJECTED` 之外 ⇒ `''`（非法，調用方結構化拒絕）。 */
function normalizeSealDecision(decision) {
  const text = String(decision === null || decision === undefined ? '' : decision).trim()
  return text === SEAL_IMPORT_STATUS.ACCEPTED || text === SEAL_IMPORT_STATUS.REJECTED ? text : ''
}

/** 文本歸一（缺值 ⇒ 空串；**不 trim 自由文本** —— 值逐字保留）。 */
function importText(value) {
  return String(value === undefined || value === null ? '' : value)
}

/**
 * 歸一單印面 → `SEAL_IMPORT_FACE_FIELDS` 面（`kind` 默認 `FACE`、`image_bytes` 默認 `0`、其餘文本）。
 * **邊款 `kind=EDGE` 須在列、不得排除**。
 */
export function normalizeSealImportFace(face) {
  const f = face && typeof face === 'object' ? face : {}
  const out = emptySealImportFace()
  SEAL_IMPORT_FACE_FIELDS.forEach((key) => {
    if (key === 'kind') {
      out[key] = String(f.kind || '').trim() === FACE_KIND.EDGE ? FACE_KIND.EDGE : FACE_KIND.FACE
      return
    }
    if (key === 'image_bytes') {
      const n = Number(f.image_bytes)
      out[key] = Number.isFinite(n) && n > 0 ? Math.round(n) : 0
      return
    }
    out[key] = importText(f[key])
  })
  return out
}

/** 歸一印章級字段面 → `SEAL_IMPORT_SEAL_FIELDS`（值逐字保留；缺鍵 ⇒ 空串）。 */
export function normalizeSealImportSealFields(payload) {
  const src = payload && typeof payload === 'object' ? payload : {}
  const out = emptySealImportFields()
  SEAL_IMPORT_SEAL_FIELDS.forEach((key) => {
    out[key] = importText(src[key])
  })
  return out
}

/**
 * 源側擴面**單值歸一**（**逐字保留、不臆造**）：字符串 / 整數原樣；`null` / 缺鍵 ⇒ `null`；
 * `misc` ⇒ 對象（拷貝）或 `null`；其它形態（布爾 / 數組 / 別的對象）⇒ `null`。
 * **`audit_status` 原樣收**（不歸一、不據它過濾）。
 */
function sealSourceValueOf(key, value) {
  if (value === undefined || value === null) return null
  if (SEAL_IMPORT_SOURCE_OBJECT_FIELDS.indexOf(key) !== -1) {
    return typeof value === 'object' && !Array.isArray(value) ? { ...value } : null
  }
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

/**
 * **源側擴面形態門（E-1；判定恒在寫之前）**：新面字段只允許「**字符串（非空）/ 整數（非 `0`）/
 * `null`**」；`misc` ⇒ **對象或 `null`**；`audit_status` **原樣收**（字符串或數字）。
 * 違形態 ⇒ `INVALID_VALUE` ＋ **零寫入**（`reason` **零新增** —— 一律沿用既有凍結字面值）；
 * **不為新面造值域門**（既不比對 `seal_ys_label` 等源側碼表，也不往既有域裡塞）。
 * @returns {null|{ok:false, reason:'INVALID_VALUE', message:string}}
 */
export function sealImportSourceDenial(payload) {
  const src = payload && typeof payload === 'object' ? payload : {}
  for (const key of SEAL_IMPORT_SOURCE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    const value = src[key]
    if (value === null || value === undefined) continue
    if (SEAL_IMPORT_SOURCE_OBJECT_FIELDS.indexOf(key) !== -1) {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reason: 'INVALID_VALUE', message: `${key} 必須是對象或 null；本次零寫入。` }
      }
      continue
    }
    if (typeof value === 'string') {
      if (value === '') {
        return { ok: false, reason: 'INVALID_VALUE', message: `${key} 不得為空串（源側無值請用 null）；本次零寫入。` }
      }
      continue
    }
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value === 0) {
        return { ok: false, reason: 'INVALID_VALUE', message: `${key} 必須是整數或 null（不得 0 / 空串等特值）；本次零寫入。` }
      }
      continue
    }
    return { ok: false, reason: 'INVALID_VALUE', message: `${key} 只允許字符串 / 整數 / null；本次零寫入。` }
  }
  return null
}

/**
 * 歸一源側擴面 → `SEAL_IMPORT_SOURCE_FIELDS`（**恰 51 鍵**；缺鍵 ⇒ `null`；`source_seal_id` ⇒ 文本）。
 * @returns {object} 源側擴面（**不含 `id` / `status` / 身份 / 時間戳 / `raw_json`**）
 */
export function normalizeSealImportSourceFields(payload) {
  const src = payload && typeof payload === 'object' ? payload : {}
  const out = emptySealImportSourceFields()
  SEAL_IMPORT_SOURCE_FIELDS.forEach((key) => {
    if (key === 'source_seal_id') {
      out[key] = importText(src[key])
      return
    }
    out[key] = sealSourceValueOf(key, src[key])
  })
  return out
}

/** 當前（或指定）賬號是否可審核印章外部導入批次 —— 供 `/my/corrections` 決定是否渲染採納 / 駁回。 */
export function canReviewSealImports(actor) {
  const who = actor || currentUser()
  return who !== null && who !== undefined && who.role === 'admin'
}

/** 當前（或指定）賬號是否可提交印章外部導入行（任何登錄用戶）。 */
export function canSubmitSealImport(actor) {
  return (actor || currentUser()) !== null
}

/* --------------------------- 導入：提交（外部通道） --------------------------- */

/**
 * **提交印章外部導入行**（外部批量導入通道；任何登錄用戶。§3.55.3 / §3.55.5）。
 *
 * 判定順序（**全部在寫之前**，拒絕即零寫入）：① 登錄門 → ② 批次 / 冪等鍵（`source_seal_id`）形態 →
 * ③ `faces[]` 至少 1 條（1..N，含邊款）→ ④ **源側擴面形態門（E-1）** → ⑤ **冪等**（同 `source` ＋
 * `source_seal_id` 已有行 ⇒ 原樣返回、**不改寫既有行**）→ ⑥ **寫面門**（`userWriteGate('submitSealImport', …)`）。
 *
 * **內容指紋僅作軟提示**：指紋與既有未駁回導入行相同 ⇒ 隨返回體給疑似重複標記（`suspect_duplicate`），
 * **不構成拒收理由**（沿 §3.55.5）。
 * @param {{batchId?:string, source?:string, sourceSealId?:string, payload?:object, faces?:Array<object>}} [options]
 * @returns {Promise<{ok:true, row:object, authority:string, idempotent?:boolean, suspect_duplicate?:boolean,
 *   duplicate_of?:string, message:string}|{ok:false, reason?:string, message:string}>}
 */
export async function submitSealImport({
  batchId = '',
  source = '',
  sourceSealId = '',
  payload = {},
  faces = [],
  rawJson = null
} = {}) {
  const user = currentUser()
  if (!user) return { ok: false, message: '請先登錄後再提交印章外部導入行' }

  const batch = String(batchId || '').trim()
  if (batch.length > MAX_SEAL_IMPORT_ID_LENGTH) {
    return { ok: false, reason: 'INVALID_VALUE', message: `導入批次號超出上限（${MAX_SEAL_IMPORT_ID_LENGTH} 字）；本次零寫入。` }
  }
  const src = String(source || '').trim()
  const payloadObj = payload && typeof payload === 'object' ? payload : {}
  const sourceId = String(sourceSealId || payloadObj.source_seal_id || '').trim()
  if (!sourceId) {
    return { ok: false, reason: 'MISSING_REQUIRED', message: '缺少外部冪等鍵（source_seal_id）⇒ 拒絕導入；本次零寫入。' }
  }
  if (sourceId.length > MAX_SEAL_IMPORT_ID_LENGTH) {
    return { ok: false, reason: 'INVALID_VALUE', message: `外部冪等鍵超出上限（${MAX_SEAL_IMPORT_ID_LENGTH} 字）；本次零寫入。` }
  }
  /* **行級缺圖標記門**（值域恰二值；缺省 ⇒ `present`）：值域外 ⇒ `INVALID_VALUE` ＋ 零寫入。 */
  const imageStatus = sealImportImageStatusOf(payloadObj)
  if (imageStatus === null) {
    return { ok: false, reason: 'INVALID_VALUE', message: 'image_status 只允許 present / source_no_image（缺省視為 present）；本次零寫入。' }
  }
  const faceRows = Array.isArray(faces) ? faces.map(normalizeSealImportFace) : []
  /* **佔位圖來源門**（本單新增｜影像例外）：佔位鍵僅 sealbank（feicui）家族可引用；
     其餘來源 ⇒ `INVALID_VALUE` ＋ 零寫入。通用影像引用校驗一字未改（本門只認這一個鍵）。 */
  const placeholderDenial = sealPlaceholderRefDenial(src || payloadObj.source, faceRows)
  if (placeholderDenial) return { ok: false, reason: 'INVALID_VALUE', message: placeholderDenial }
  if (faceRows.length === 0 && imageStatus !== SEAL_IMPORT_IMAGE_STATUS.SOURCE_NO_IMAGE) {
    return {
      ok: false,
      reason: 'MISSING_REQUIRED',
      message: '導入行請至少帶一個印面（faces[] 1..N；源側無圖之印章可帶 image_status=source_no_image 例外）；本次零寫入。'
    }
  }

  /* **源側擴面形態門（E-1）**：任一違規 ⇒ `INVALID_VALUE` ＋ 零寫入（在寫之前、亦在冪等判定之前）。 */
  const denial = sealImportSourceDenial(payloadObj)
  if (denial) return denial
  const sealFields = {
    ...normalizeSealImportSealFields(payloadObj),
    ...normalizeSealImportSourceFields({ ...payloadObj, source_seal_id: sourceId }),
    /* 行級冪等鍵為權威（參數優先；`sealFields` 內同名鍵同值）。 */
    source_seal_id: sourceId
  }
  const sourceRaw = rawJson !== null && rawJson !== undefined ? rawJson : (payloadObj.raw_json === undefined ? null : payloadObj.raw_json)
  /* **只在載荷宣告時落該鍵**（未提供 ⇒ 不落鍵，既有帶 faces 之載荷行為一字不變）。 */
  const imageStatusDeclared = payloadObj.image_status !== undefined && payloadObj.image_status !== null

  /* **冪等**（§3.55.5）：同 `source` ＋ `source_seal_id` 已有導入行 ⇒ 原樣返回（不改寫既有行）。 */
  const existing = sealImportBySourceKey(src, sourceId)
  if (existing) {
    return {
      ok: true,
      row: existing,
      authority: 'LOCAL_IDEMPOTENT',
      idempotent: true,
      message: '該外部冪等鍵（source ＋ source_seal_id）已存在導入行 ⇒ 未改寫（冪等）。'
    }
  }

  /* **內容指紋（軟提示）**：相同指紋**不得拒收** —— 只隨返回體給疑似重複標記。 */
  const fingerprint = sealImportFingerprint(sealFields)
  const duplicate = listSealImportRows().find(
    (row) =>
      String((row && row.content_fingerprint) || '') === fingerprint &&
      normalizeSealImportStatus(row && row.status) !== SEAL_IMPORT_STATUS.REJECTED
  )
  const suspect = duplicate ? { suspect_duplicate: true, duplicate_of: String((duplicate && duplicate.id) || '') } : {}

  const writePayload = {
    batch_id: batch,
    source: src,
    source_seal_id: sourceId,
    ...sealFields,
    faces: faceRows,
    ...(imageStatusDeclared ? { image_status: imageStatus } : {}),
    /* `raw_json` **只落導入行**（正式集合不帶）。 */
    raw_json: sourceRaw
  }
  const gate = await userWriteGate('submitSealImport', writePayload)
  if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }

  if (gate.mode === 'local-dev') {
    const at = importNowIso()
    const row = {
      id: makeSealImportId(),
      batch_id: batch,
      source: src,
      source_seal_id: sourceId,
      status: SEAL_IMPORT_STATUS.PENDING,
      ...sealFields,
      faces: faceRows,
      ...(imageStatusDeclared ? { image_status: imageStatus } : {}),
      /* `raw_json` **只落導入行**（正式集合不帶；不參與任何判定）。 */
      raw_json: sourceRaw,
      content_fingerprint: fingerprint,
      imported_by: user.id, // **不透明 uid；零手機號**
      imported_at: at,
      reviewed_at: null,
      reviewer_id: null,
      review_note: ''
    }
    saveSealImportRows([...listSealImportRows(), row])
    return {
      ok: true,
      row,
      authority: 'LOCAL_DEV',
      ...suspect,
      message: '已提交印章外部導入行，待管理員審覈（dev / 離線形態，非正式寫入路徑）'
    }
  }

  const serverRow = gate.row
  if (!serverRow || typeof serverRow !== 'object') {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '雲端回傳缺少權威行，無法確認寫入內容；本機未鏡像（雲端是否已寫入未知）。' }
  }
  saveSealImportRows([...listSealImportRows(), serverRow])
  return { ok: true, row: serverRow, authority: 'SERVER', docId: gate.docId, ...suspect, message: '已提交印章外部導入行，待管理員審覈' }
}

/* --------------------------- 導入：讀面（管理員） --------------------------- */

/**
 * **管理員可見的待審印章外部導入行**（全部用戶的 `PENDING`）。
 * 非管理員 ⇒ **結構化拒絕**（`FORBIDDEN`；不以空集冒充拒絕）。
 *
 * **不靜默顯示 0**（与印人导入读面同口径）：云读取面已配置但**未落定 / 读取失败**时，
 * **零行**不再是「事实空集」⇒ 显式回可读降级文案（`ok:false` ＋ `message`），由视图既有
 * `sealImportNotice` 位渲染；有任何本机镜像行可列时**照常返回**。`reason` 不新增字面值。
 * @returns {{ok:true, rows:Array<object>}|{ok:false, reason:string, message:string}}
 */
export function listPendingSealImportsForAdmin(actor) {
  const who = actor || currentUser()
  if (!canReviewSealImports(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以查看全部用戶的印章外部導入批次' }
  }
  const rows = listSealImportRows()
    .filter((row) => normalizeSealImportStatus(row && row.status) === SEAL_IMPORT_STATUS.PENDING)
    .sort((a, b) => String(b.imported_at).localeCompare(String(a.imported_at)))
  if (rows.length === 0) {
    const degraded = sealImportReadDegradedMessage()
    if (degraded) return { ok: false, reason: cloudBaseStatus().reason || '', message: degraded }
  }
  return { ok: true, rows }
}

/** 数据源未落定 / 读取失败时的可读降级文案（正常 / 未配置 ⇒ `''`；判据收口在数据层）。 */
function sealImportReadDegradedMessage() {
  if (!cloudBaseConfigured()) return ''
  const status = cloudBaseStatus() || {}
  if (status.state === 'pending') return '雲端資料載入中，待審印章導入批次稍後自動出現；請稍候再試。'
  if (status.state === 'failed') {
    return `雲端資料讀取失敗（${status.message || '未知原因'}），暫時無法列出全部待審印章導入批次；請稍後重試。`
  }
  return ''
}

/* --------------------------- E-3 取行（本機面｜只讀、僅內存） --------------------------- */

/* ============================================================================
   **E-3 取行（本機面｜K-乙-4｜2026-10-12｜形态①）**：雲端待審導入行**單向取回**，**僅駐內存**
   ----------------------------------------------------------------------------
   与 `persons.js` / `items.js` 的取行口**同一形态**（同一 op、同一门、同一失败形态）；差别只有
   `collection` 字面（**逐字** `sealImports`）。
   · 判据：经 `userWriteGate('pullImportRows', …)`（**同一通道**：令牌自愈 / dev·離線 与云 两形态）。
   · **只讀**：雲函數側不產出 `plan` ⇒ 零寫入；本層**不寫任何本地集合**（**無** localStorage /
     IndexedDB 落點 —— R-8：3,679 行 ≈16 MB > 配額，且 `storage.writeKey` 的 catch 會靜默吞掉）。
   · **分頁**：單次 `limit` ≤ 1000（雲側硬上限）；逐輪按行 `id` 去重（有效新行為 0 ⇒ 停），
     最多 10 輪；取滿 ⇒ 如實標 `maybeMore: true`（**不得報成全部**）。
   · `rows` / `count` 鍵名**逐字凍結**；`rows` 缺席 ⇒ `STORAGE_UNAVAILABLE`（不臆造空集）。
   ============================================================================ */

/** 本機面取行的集合鍵（**逐字**；雲函數值域恰三選一）。 */
export const SEAL_IMPORT_COLLECTION_KEY = 'sealImports'

/** 取行單次上限（沿雲側硬上限 `IMPORT_REPAIR_SCAN_LIMIT` ＝ 1000）。 */
export const PULL_IMPORT_ROWS_LIMIT = 1000

/** 取行輪數上限（護欄；見上「分頁」注 —— 無偏移面時第 2 輪即停）。 */
const PULL_IMPORT_ROWS_MAX_ROUNDS = 10

/**
 * 取行門回包的結構化判讀（**只認 `ok` / `rows`**；不改寫真因、不編造假讀數）。
 * @returns {null|{ok:false, reason:string, message:string}} `null` ＝ 放行
 */
function pullSealImportRowsDenial(gate) {
  if (!gate || typeof gate !== 'object') {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '取行回傳形狀不可辨識；本次零讀取。' }
  }
  if (gate.ok !== true) {
    return { ok: false, reason: gate.reason || 'STORAGE_UNAVAILABLE', message: gate.message || '取行被拒；本次零讀取。' }
  }
  if (gate.mode === WRITE_FACE_MODES.LOCAL_DEV) {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '本機寫入形態下無服務端可讀（取行需雲數據源）；本次零讀取。' }
  }
  if (!Array.isArray(gate.rows)) {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '雲端回包未帶取行結果（rows）；本次零讀取。' }
  }
  return null
}

/**
 * **取回印章外部導入行（本機面｜只讀、僅內存）**。
 *
 * 載荷鍵面**封閉**（雲側恰認 `batch_id` / `collection` / `status` / `limit`）：`status` 只在
 * **非空**時落鍵（送空串會被雲側判 `INVALID_VALUE`）；`limit` 恒为 1 〜 1000 的整數。
 * @param {{id?:string, role?:string}|null} actor 管理員
 * @param {{batchId?:string, status?:string, limit?:number}} [options]
 * @returns {Promise<{ok:true, rows:Array<object>, count:number, maybeMore:boolean, limit:number, collection:string}
 *   |{ok:false, reason:string, message:string}>}
 */
export async function pullSealImportRows(actor, options = {}) {
  const who = actor || currentUser()
  if (!canReviewSealImports(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以取回全部用戶的印章外部導入批次' }
  }
  const batch = String((options && options.batchId) || '').trim()
  const statusText = String((options && options.status) || '').trim()
  const requested =
    options && options.limit !== undefined && options.limit !== null ? Number(options.limit) : PULL_IMPORT_ROWS_LIMIT
  const limit =
    Number.isInteger(requested) && requested > 0 ? Math.min(requested, PULL_IMPORT_ROWS_LIMIT) : PULL_IMPORT_ROWS_LIMIT
  const seen = new Set()
  const rows = []
  let full = false
  for (let round = 0; round < PULL_IMPORT_ROWS_MAX_ROUNDS; round += 1) {
    const payload = { collection: SEAL_IMPORT_COLLECTION_KEY, batch_id: batch, limit }
    if (statusText) payload.status = statusText
    const gate = await userWriteGate('pullImportRows', payload)
    const denial = pullSealImportRowsDenial(gate)
    if (denial) return denial
    const page = gate.rows
    let fresh = 0
    page.forEach((row) => {
      const id = String((row && (row.id || row._id)) || '')
      if (id && seen.has(id)) return
      if (id) seen.add(id)
      rows.push(row)
      fresh += 1
    })
    full = page.length >= limit
    /* 未取滿 ⇒ 已取完；取滿 ⇒ 可能还有更多（故如實標 `maybeMore`）；有效新行為 0 ⇒ 再取無益 ⇒ 停。 */
    if (!full || fresh === 0) break
  }
  return { ok: true, rows, count: rows.length, maybeMore: full, limit, collection: SEAL_IMPORT_COLLECTION_KEY }
}

/* --------------------------- 導入：採納 / 駁回（管理員） --------------------------- */

/** 影像引用存在性判讀（**複用既有讀面** `imageRowByRef`，不新增第二套讀法）。 */
function importFaceImageRow(face) {
  const sha = String((face && face.image_sha256) || '').trim()
  const key = String((face && face.image_storage_key) || '').trim()
  if (!sha && !key) return { hasRef: false, row: null }
  return { hasRef: true, row: imageRowByRef({ image_sha256: sha, image_storage_key: key }) }
}

/**
 * **行級鍵 `image_status` 取値**：未提供（`undefined` / `null`）⇒ `present`（向後兼容）；
 * 已提供 ⇒ 逐字取值，**值域外 ⇒ `null`**（调用方据此 `INVALID_VALUE` ＋ 零写入）。
 * 与雲函數 `ops.js::sealImportImageStatusOf` / `seed.js::SEAL_IMPORT_IMAGE_STATUS` 同口徑。
 * @returns {string|null} `present` / `source_no_image` / `null`（非法）
 */
function sealImportImageStatusOf(payload) {
  const src = payload && typeof payload === 'object' ? payload : {}
  const raw = src.image_status
  if (raw === undefined || raw === null) return SEAL_IMPORT_IMAGE_STATUS.PRESENT
  const value = String(raw).trim()
  if (value === SEAL_IMPORT_IMAGE_STATUS.PRESENT || value === SEAL_IMPORT_IMAGE_STATUS.SOURCE_NO_IMAGE) return value
  return null
}

/**
 * 由導入行取**源側擴面（51 鍵）** —— 採納時**整條落正式行** `xiai_seals`（E-3）；
 * **原樣**（字符串 / 整數 / `null`；`misc` 對象），缺值 ⇒ `null`；`source_seal_id` ⇒ 文本。
 */
function sealSourceFieldsOf(row) {
  const src = row && typeof row === 'object' ? row : {}
  const out = {}
  SEAL_IMPORT_SOURCE_FIELDS.forEach((key) => {
    out[key] = key === 'source_seal_id' ? importText(src[key]) : sealSourceValueOf(key, src[key])
  })
  return out
}

/**
 * 由導入行**構造**整條正式印章產物（印章行 ＋ 印面行）；**先校驗、後派生** ⇒ 拒絕即零寫入、不落半條。
 *
 * 影像引用校驗（§3.55.6）：**逐條**校驗引用對象存在 —— 宣告了引用卻解析不到 ⇒ 該條拒絕；
 * `kind=FACE` 的印面**必須**有可解析的影像引用（沿用既有「印面圖必填」口徑）。
 *
 * **識別編碼四鍵（口徑件 §3｜R-5，窄單補未落項）**：本函數補齊 `seal_no` / `sid`（印章行）與
 * `face_no` / `fid`（印面行）—— 號源一律走**數據層單點**（`reserveSealNo` / `planFaceNumbers`），
 * `sid` / `fid` 由號**恆重算**（`CODE_ID` 純函數）；號域越界 ⇒ 結構化拒絕 ＋ **零寫入**。
 * @param {object} importRow 導入行
 * @param {Array<object>} seals 既有正式印章行（含同批先前已構造的行 ⇒ 號不重複）
 * @param {Array<object>} faces 既有印面行（含同批先前已構造的行 ⇒ `face_no` 不重複）
 * @param {Set<string>} takenFaceIds 已佔用的印面內部 id
 * @param {{id:string}} actor 審核人
 * @param {string} at ISO 時戳
 * @returns {{ok:true, seal:object, faceRows:Array<object>}|{ok:false, reason:string, message:string}}
 */
function buildAcceptedSeal(importRow, seals, faces, takenFaceIds, actor, at) {
  const faceDefs = Array.isArray(importRow && importRow.faces) ? importRow.faces : []
  /* **佔位圖來源門 ＋ 摘要門**（本單新增｜影像例外；與雲函數 `ops.js` 同判）：
     佔位鍵僅 sealbank（feicui）家族可引用；指向佔位鍵者其摘要必須 ≡ 登記摘要。 */
  const placeholderDenial = sealPlaceholderRefDenial(String((importRow && importRow.source) || ''), faceDefs)
  if (placeholderDenial) {
    return { ok: false, reason: 'INVALID_VALUE', message: `${placeholderDenial}本行保持 PENDING。` }
  }
  const resolved = []
  for (const raw of faceDefs) {
    const face = normalizeSealImportFace(raw)
    const probe = importFaceImageRow(face)
    if (probe.hasRef && !probe.row) {
      return {
        ok: false,
        reason: 'NOT_FOUND',
        message:
          `印面影像引用缺失（sha256=${String(face.image_sha256 || '') || '（空）'} / ` +
          `key=${String(face.image_storage_key || '') || '（空）'}）⇒ 未採納；本行保持 PENDING。`
      }
    }
    if (String(face.image_storage_key || '') === SEAL_PLACEHOLDER_IMAGE_KEY) {
      const declared = String(face.image_sha256 || '')
      const rowSha = String((probe.row && probe.row.sha256) || '')
      if ((declared && declared !== SEAL_PLACEHOLDER_IMAGE.sha256) || (rowSha && rowSha !== SEAL_PLACEHOLDER_IMAGE.sha256)) {
        return {
          ok: false,
          reason: 'INVALID_VALUE',
          message: `佔位圖摘要與登記值不符（宣告 ${declared || '（空）'} / 行 ${rowSha || '（空）'}）⇒ 未採納；本行保持 PENDING。`
        }
      }
    }
    if (!probe.hasRef && face.kind === FACE_KIND.FACE) {
      return { ok: false, reason: 'MISSING_REQUIRED', message: '印面（kind=FACE）缺少影像引用 ⇒ 未採納；本行保持 PENDING。' }
    }
    resolved.push({ face, image: probe.row })
  }

  /* **識別編碼（口徑件 §3｜R-2 / R-5）**：`seal_no` 由**數據層號源單點** `reserveSealNo` 認領
     （既有 `seal_no` 與可識別舊序號取最大 ＋1、撞號順延）；`sid` ＝ `encodeSealCode(seal_no)`
     **恆重算**；`stamp_id` 的值 **＝ `sid`**（舊 `XA…` / 純數字形態不再產生）。
     號域越界 ⇒ 結構化拒絕 ＋ **零寫入**（判定在任何寫入之前）。 */
  const sealNo = reserveSealNo(seals, null)
  const sealCode = CODE_ID.encodeSealCode ? CODE_ID.encodeSealCode(sealNo) : { ok: false }
  if (!sealCode.ok) {
    return { ok: false, reason: 'INVALID_VALUE', message: `印章自增號越界（seal_no=${sealNo}）⇒ 未採納；本行保持 PENDING。` }
  }
  const stampId = sealCode.code
  const serialMatch = /^XA(\d{9})$/.exec(stampId)
  const source = String((importRow && importRow.source) || '')
  const sealName = String((importRow && importRow.seal_name) || '')
  const seal = {
    /* **源側擴面 51 鍵整條落正式行**（E-3）；`category` 之別名語義見下（平台既有口徑不改）。 */
    ...sealSourceFieldsOf(importRow),
    /* **識別編碼（§3｜R-5）**：`seal_no` ＝ 權威自增號（本機號源單點認領）；`sid` ＝ 由其恆重算。 */
    seal_no: sealNo,
    sid: stampId,
    sealGroupId: `g-${serialMatch ? serialMatch[1] : stampId}`,
    stamp_id: stampId, // 兼容別名（既落盤視圖按它定位），勿刪
    id: stampId, // §4.1.1 規範字段名
    seal_name: sealName,
    name: sealName, // 兼容別名（＝印文）
    transcription: String((importRow && importRow.transcription) || ''),
    dynasty: String((importRow && importRow.dynasty) || ''),
    seal_type: String((importRow && importRow.seal_type) || ''),
    /* `category` 為**平台既有別名**（＝ `seal_type`，印面內容，沿 §4.1.2 读面归一）；
       源側 `category`（印章 / 印譜）只留導入行 ⇒ 不覆蓋別名語義。 */
    category: String((importRow && importRow.seal_type) || ''),
    seal_style: String((importRow && importRow.seal_style) || ''),
    material: String((importRow && importRow.material) || ''),
    shape: String((importRow && importRow.shape) || ''),
    asset_kind: 'SEAL',
    /* **同置**：採納 ⇒ 正式行 `review_status='APPROVED'`（與導入行 `status='ACCEPTED'` **同時推進**）。 */
    review_status: 'APPROVED',
    author: String((importRow && importRow.author) || ''),
    /* **冪等鍵溯源**：`source` ＋ `source_seal_id` 落正式行 ⇒ 重複採納可讀回、不改寫既有行。 */
    source,
    source_seal_id: String((importRow && importRow.source_seal_id) || ''),
    uploaded_by: actor && actor.id ? actor.id : '',
    created_at: at,
    updated_at: at
  }

  const taken = new Set(takenFaceIds)
  const faceRows = []
  /* **識別編碼（印面側｜§3）**：**寫之前**一次算清本批要落的 `face_no`（撞號順延、號域越界
     ⇒ 結構化拒絕 ＋ 零寫入），`fid` 由 `face_no` **恆重算**。規劃基數 ＝ `faces`
     （**含同批先前已構造的印面行** —— 調用方逐條把 `faceRows` 追加進同一批數組）⇒ 不重號、不空洞。 */
  const plannedFaceNos = planFaceNumbers(faces, null, resolved.length)
  if (!plannedFaceNos.ok) {
    return {
      ok: false,
      reason: plannedFaceNos.reason || 'INVALID_VALUE',
      message: `${plannedFaceNos.message || '印面自增號規劃失敗'} ⇒ 未採納；本行保持 PENDING。`
    }
  }
  resolved.forEach(({ face, image }, faceIndex) => {
    const faceId = nextFaceId(stampId, face.kind, taken)
    taken.add(faceId)
    const isEdge = face.kind === FACE_KIND.EDGE
    const faceNo = plannedFaceNos.nos[faceIndex]
    faceRows.push({
      id: faceId,
      sealId: stampId,
      stamp_id: stampId, // 兼容別名，勿刪
      /* **識別編碼（§3｜R-5）**：`face_no` ＝ 權威自增號；`fid` ＝ 由其恆重算（8 位十進制）。 */
      face_no: faceNo,
      fid: CODE_ID.encodeFaceCode(faceNo).code,
      kind: face.kind,
      face_image_id: !isEdge && image ? image.id : null,
      edge_image_ids: isEdge && image ? [image.id] : [],
      seal_name: face.seal_name || sealName,
      dynasty: face.dynasty || String((importRow && importRow.dynasty) || ''),
      seal_type: face.seal_type,
      face_style: face.face_style,
      seal_class: face.seal_class,
      author: face.author,
      author_person_id: face.author_person_id,
      transcription: face.transcription,
      /* **影面新增鍵**（`yt` / `ytsw` / `yzbk`；原樣收、值域不封閉）。 */
      image_source_kind: importText(face.image_source_kind),
      source,
      uploaded_by: actor && actor.id ? actor.id : '',
      created_at: at,
      updated_at: at
    })
  })
  return { ok: true, seal, faceRows }
}

/* ============================================================================
   **E-4 / E-5（阶段乙｜2026-10-12）**：审核＝**回包真值 ＋ 循环推进**；本机镜像写入**不得静默**
   ----------------------------------------------------------------------------
   · E-4：服务端按 `op` 收窄透传顶层键 `accepted_ids` / `rejected_ids` / `skipped` / `failed` /
     `done` / `remaining`（**键名逐字冻结，不改名**）。云端模式下**只认回包**报数，
     **不得**再用本机全量判定冒充对外读数；到达 `remaining == 0` 即该批处理完毕。
   · E-5：本机镜像写入**只落本批行**（只改动回包权威给出的那一批行）⇒ 写后**回读校验**
     （比条数 ＋ JSON 长度）；不一致 ⇒ 结构化 `STORAGE_UNAVAILABLE` ＋ 如实上屏，
     **本次写入结果以服务端回包为准**（`storage.js` 是全工程唯一落点，**本单不改它**）。
   ============================================================================ */

/** **E-5**：本机镜像写入失败的结构化拒绝（**不得静默**）。 */
const IMPORT_MIRROR_WRITE_FAILED = Object.freeze({
  ok: false,
  reason: 'STORAGE_UNAVAILABLE',
  message: '本機鏡像寫入未生效（可能超出瀏覽器儲存配額）；本次寫入結果以服務端回包為準。'
})

/**
 * **E-5**：写本机镜像并**回读校验**（只落本批行 ⇒ 逐轮只改动回包权威给出的那一批行）。
 * 读回比较「**条数 ＋ JSON 长度**」；一致 ⇒ `null`（放行）；不一致 ⇒ 结构化拒绝。
 * 读写仍经数据层单点（`saveSealImportRows` / `listSealImportRows` ⇒ 底层 `readKey`），
 * **不自立第二处存储访问**（R-25）。
 * @param {Array<object>} nextRows 合并后的镜像行（仅本批行被改动；其余行**原样**）
 * @returns {null|{ok:false, reason:'STORAGE_UNAVAILABLE', message:string}}
 */
function sealImportMirrorWriteDenial(nextRows) {
  const rows = Array.isArray(nextRows) ? nextRows : []
  const expectedCount = rows.length
  const expectedLength = JSON.stringify(rows).length
  saveSealImportRows(rows)
  const back = listSealImportRows()
  if (Array.isArray(back) && back.length === expectedCount && JSON.stringify(back).length === expectedLength) return null
  return { ...IMPORT_MIRROR_WRITE_FAILED }
}

/**
 * **E-4**：服务端回包读数（键名逐字冻结）。
 * 回包可能落在门的**顶层**或 `value` 容器（管道透传槽）—— 两处都认（**不改键名、不臆造**）；
 * 缺席 ⇒ `hasAny:false`（调用方**如实回报、不虚构计数**）。
 */
function sealImportReviewEnvelopeOf(gate) {
  const top = gate && typeof gate === 'object' ? gate : {}
  const value = top.value && typeof top.value === 'object' && !Array.isArray(top.value) ? top.value : {}
  const KEYS = ['accepted_ids', 'rejected_ids', 'skipped', 'failed', 'done', 'remaining']
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)
  const pick = (key) => (has(top, key) ? top[key] : has(value, key) ? value[key] : undefined)
  const asIds = (v) => (Array.isArray(v) ? v.map((item) => String(item)) : [])
  const asNum = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  return {
    hasAny: KEYS.some((key) => has(top, key) || has(value, key)),
    serverMessage: String(top.message || value.message || '').trim(),
    accepted_ids: asIds(pick('accepted_ids')),
    rejected_ids: asIds(pick('rejected_ids')),
    skipped: asIds(pick('skipped')),
    failed: Array.isArray(pick('failed')) ? pick('failed') : [],
    done: asNum(pick('done')),
    remaining: asNum(pick('remaining'))
  }
}

/** **E-4**：云端模式下由回包权威 id **就地更新**本机镜像（终态不回退；只改本批行）。 */
function syncSealImportMirrorFromEnvelope(who, env) {
  const decided = new Map()
  env.accepted_ids.forEach((id) => decided.set(id, SEAL_IMPORT_STATUS.ACCEPTED))
  env.rejected_ids.forEach((id) => decided.set(id, SEAL_IMPORT_STATUS.REJECTED))
  if (decided.size === 0) return { ok: true, rows: [] }
  const at = importNowIso()
  const next = listSealImportRows().map((row) => {
    const id = String((row && row.id) || '')
    if (!decided.has(id)) return row
    if (String((row && row.status) || SEAL_IMPORT_STATUS.PENDING) !== SEAL_IMPORT_STATUS.PENDING) return row
    return { ...row, status: decided.get(id), reviewed_at: at, reviewer_id: (who && who.id) || '' }
  })
  const denial = sealImportMirrorWriteDenial(next)
  if (denial) return denial
  return { ok: true, rows: next.filter((row) => decided.has(String((row && row.id) || ''))) }
}

/**
 * **本地採納 / 駁回判定（不經寫面門）**：供 `reviewSealImport` 過門後回寫本機鏡像 /
 * 在 dev·離線 形態作**本地權威**。
 *
 * 採納粒度：按批次（`batchId`）或按單行（`importId`）二選一（**兩個入口都實現**，沿 W-84 擬案）。
 * **逐條獨立**：失敗行保持 `PENDING` 且零寫入；成功行落庫；成功面**可重放且冪等**；不落半條。
 * @returns {{ok:boolean, accepted?:boolean, accepted_ids?:string[], rejected_ids?:string[], skipped?:string[],
 *   failed?:Array<object>, done?:number, remaining?:number, rows?:Array<object>, reason?:string, message:string}}
 */
function applySealImportDecision(who, { batchId = '', importId = '', decision = '', note = '' } = {}) {
  const rawNote = note === null || note === undefined ? '' : note
  if (typeof rawNote !== 'string') {
    return { ok: false, reason: 'INVALID_VALUE', message: '駁回理由必須是文字；本次零寫入。' }
  }
  const noteText = rawNote.trim()
  if (noteText.length > MAX_SEAL_REVIEW_NOTE_LENGTH) {
    return { ok: false, reason: 'INVALID_VALUE', message: `駁回理由不得超過 ${MAX_SEAL_REVIEW_NOTE_LENGTH} 字；本次零寫入。` }
  }
  const batch = String(batchId || '').trim()
  const single = String(importId || '').trim()
  if (!batch && !single) {
    return { ok: false, reason: 'MISSING_REQUIRED', message: '缺少導入批次號（batch_id）或導入行號（import_id）⇒ 拒絕審覈；本次零寫入。' }
  }
  const normalized = normalizeSealDecision(decision)
  if (!normalized) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message:
        `審覈決定「${String(decision === null || decision === undefined ? '' : decision)}」不在允許的 2 類之內` +
        '（ACCEPTED 採納 / REJECTED 駁回）；本次零寫入。'
    }
  }
  const accepted = normalized === SEAL_IMPORT_STATUS.ACCEPTED
  const at = importNowIso()
  const imports = listSealImportRows()
  /* 選目標：單行優先（指定 `importId`）；否則全批次內的行。 */
  const targets = imports.filter((row) => {
    if (!row) return false
    if (single) return String(row.id || '') === single
    return String(row.batch_id || '') === batch
  })
  if (targets.length === 0) {
    return { ok: false, reason: 'NOT_FOUND', message: '未找到匹配的印章外部導入行（批次 / 單行）；本次零寫入。' }
  }

  const acceptedIds = []
  const rejectedIds = []
  const skipped = []
  const failed = []
  const nextSeals = listSealRows().slice()
  const nextFaces = listFaceRows().slice()
  const takenFaceIds = new Set(nextFaces.map((row) => String((row && row.id) || '')))
  const decidedById = new Map()

  targets.forEach((row) => {
    const rid = String((row && row.id) || '')
    const current = normalizeSealImportStatus(row && row.status)
    if (current !== SEAL_IMPORT_STATUS.PENDING) {
      /* 終態不回退：已審行**跳過**（冪等重放 / 部分失敗場景均不改寫既有終態）。 */
      skipped.push(rid)
      return
    }
    if (!accepted) {
      rejectedIds.push(rid)
      decidedById.set(rid, {
        ...row,
        status: SEAL_IMPORT_STATUS.REJECTED,
        reviewed_at: at,
        reviewer_id: who.id,
        review_note: noteText !== '' ? noteText : row.review_note || ''
      })
      return
    }
    /* **ACCEPTED**：按 `source` ＋ `source_seal_id` 冪等落 `xiai_seals` ＋ `xiai_faces`。 */
    const sourceId = String((row && row.source_seal_id) || '').trim()
    if (!sourceId) {
      failed.push({ id: rid, reason: 'MISSING_REQUIRED', message: '該導入行缺少冪等鍵（source_seal_id）⇒ 未採納；本行保持 PENDING。' })
      return
    }
    const existingSeal =
      /* 讀回比對既有正式行（**冪等鍵查詢面單點** `sealBySourceKey`）。 */
      sealBySourceKey(String((row && row.source) || ''), sourceId) ||
      /* 同批內先前條目已構造但尚未落盤的同行 ⇒ 亦算命中（不生成第二枚；批次內冪等）。 */
      nextSeals.find(
        (item) =>
          String((item && item.source_seal_id) || '') === sourceId &&
          String((item && item.source) || '') === String((row && row.source) || '')
      ) ||
      null
    if (!existingSeal) {
      const built = buildAcceptedSeal(row, nextSeals, nextFaces, takenFaceIds, who, at)
      if (!built.ok) {
        /* 失敗行：**保持 PENDING 且零寫入**（不動 seals / faces、不改本行）。 */
        failed.push({ id: rid, reason: built.reason, message: built.message })
        return
      }
      nextSeals.push(built.seal)
      built.faceRows.forEach((faceRow) => {
        nextFaces.push(faceRow)
        takenFaceIds.add(String(faceRow.id))
      })
    }
    acceptedIds.push(rid)
    decidedById.set(rid, {
      ...row,
      status: SEAL_IMPORT_STATUS.ACCEPTED,
      reviewed_at: at,
      reviewer_id: who.id,
      review_note: row.review_note || ''
    })
  })

  /* **成功面**：先落採納產物（冪等）—— 再落導入行狀態；兩者都在本地（dev / 離線 ＝ 本地權威）。 */
  if (acceptedIds.length > 0) {
    saveSealRows(nextSeals)
    saveFaceRows(nextFaces)
  }
  const done = acceptedIds.length + rejectedIds.length
  /* **剩余（E-4）**：本批（或該單行）内**仍为 `PENDING`** 的行数 —— 失败行保持 `PENDING`
     ⇒ 如实计入「剩餘」（视图据此循环推进，**不虚报整批已完成**）。 */
  const remaining = targets.filter((row) => {
    const id = String((row && row.id) || '')
    if (decidedById.has(id)) return false
    return normalizeSealImportStatus(row && row.status) === SEAL_IMPORT_STATUS.PENDING
  }).length
  const resultRows = targets.map((row) => decidedById.get(String((row && row.id) || '')) || row)
  if (decidedById.size > 0) {
    /* **E-5**：只改本批行 ＋ 写后**回读校验**；未生效 ⇒ 结构化 `STORAGE_UNAVAILABLE`
       （**不得静默**），但仍如实回报本批计数供上屏。 */
    const denial = sealImportMirrorWriteDenial(
      imports.map((row) => {
        const id = String((row && row.id) || '')
        return decidedById.has(id) ? decidedById.get(id) : row
      })
    )
    if (denial) {
      return { ...denial, accepted, accepted_ids: acceptedIds, rejected_ids: rejectedIds, skipped, failed, rows: resultRows, done, remaining }
    }
  }
  return {
    ok: true,
    accepted,
    accepted_ids: acceptedIds,
    rejected_ids: rejectedIds,
    skipped,
    failed,
    done,
    remaining,
    rows: resultRows,
    message: accepted
      ? `已採納 ${acceptedIds.length} 條印章外部導入行並冪等整條落正式印章（失敗 ${failed.length} / 跳過 ${skipped.length}）`
      : `已駁回 ${rejectedIds.length} 條印章外部導入行（跳過 ${skipped.length}）`
  }
}

/**
 * **審核印章外部導入行（採納 / 駁回）**（管理員；§3.55.4 / §3.55.5）。
 *
 * 判定順序（**全部在寫之前**）：① 管理員門（非管理員 ⇒ `FORBIDDEN` ＋ 零寫入）→
 * ② 經登錄令牌寫面門 `userWriteGate('reviewSealImport', …)`（缺 env ⇒ 安全拒 ＋ 零寫入）。
 * `ACCEPTED` ⇒ 冪等整條落 `xiai_seals` ＋ `xiai_faces`（按 `source` ＋ `source_seal_id`）；
 * `REJECTED` ⇒ 零寫入。**兩個入口都實現**：按批次（`batchId`）與按單行（`importId`）。
 *
 * **E-4（阶段乙｜2026-10-12）**：按**写面形态**分派 ——
 *   · `local-dev`（本机面）⇒ **本机权威**：`applySealImportDecision`（本机一次處理完整批）；
 *   · `cloud`（公网面）⇒ **只認服務端回包**：把 `accepted_ids` / `rejected_ids` / `skipped` /
 *     `failed` / `done` / `remaining` **逐字透傳**給調用方，並由回包權威 id **就地更新**本機鏡像；
 *     **不再**用本機全量判定當對外報數（那是「假成功」的病根）。
 * @param {{id?:string, role?:string}|null} actor 管理員
 * @param {{batchId?:string, importId?:string, decision?:string, note?:string}} [options]
 * @returns {Promise<{ok:boolean, accepted?:boolean, accepted_ids?:string[], rejected_ids?:string[],
 *   skipped?:string[], failed?:Array<object>, done?:number, remaining?:number|null, rows?:Array<object>, reason?:string, message:string}>}
 */
export async function reviewSealImport(actor, options = {}) {
  const who = actor || currentUser()
  if (!canReviewSealImports(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以審覈印章外部導入批次' }
  }
  const gate = await userWriteGate('reviewSealImport', {
    batch_id: String((options && options.batchId) || ''),
    import_id: String((options && options.importId) || ''),
    decision: String((options && options.decision) || ''),
    note: String((options && options.note) || '')
  })
  if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }
  /* **本机面（local-dev）**：本机即权威 ⇒ 走本机判定（一次处理完整批）。 */
  if (gate.mode === WRITE_FACE_MODES.LOCAL_DEV) {
    return applySealImportDecision(who, options)
  }
  /* **公网面（cloud）**：**只认服务端回包**（本机镜像只做映射，**不重算对外读数**）。 */
  const accepted = String((options && options.decision) || '') === SEAL_IMPORT_STATUS.ACCEPTED
  const env = sealImportReviewEnvelopeOf(gate)
  const sync = syncSealImportMirrorFromEnvelope(who, env)
  if (!sync.ok) {
    /* **E-5**：本机镜像未生效 ⇒ **不得静默**；仍带回归包权威计数供上屏。 */
    return { ...sync, accepted, accepted_ids: env.accepted_ids, rejected_ids: env.rejected_ids, skipped: env.skipped, failed: env.failed, done: env.done, remaining: env.remaining }
  }
  const tail = env.remaining === null ? '' : ` / 剩餘 ${env.remaining}`
  return {
    ok: true,
    accepted,
    accepted_ids: env.accepted_ids,
    rejected_ids: env.rejected_ids,
    skipped: env.skipped,
    failed: env.failed,
    done: env.done,
    remaining: env.remaining,
    rows: sync.rows,
    message: env.serverMessage || (accepted
      ? `已採納 ${env.accepted_ids.length} 條印章外部導入行（失敗 ${env.failed.length} / 跳過 ${env.skipped.length}${tail}）`
      : `已駁回 ${env.rejected_ids.length} 條印章外部導入行（跳過 ${env.skipped.length}${tail}）`)
  }
}

/** 單寫者門轉發（供視圖 / 自檢直調；`xiai_seal_imports` 不開放任何直寫入口，含管理員直寫）。 */
export function sealImportSingleWriterDenial(collectionKey) {
  return sealImportDirectWriteDenial(collectionKey)
}

/** 導入行提交人展示 uid（**零手機號**；此處只回 uid，避免第二套名表）。 */
export function sealImportSubmitterId(row) {
  return String((row && row.imported_by) || '')
}
