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
  PermissionError
} from '../data/db.js'
import { currentUser } from '../data/session.js'
import { FACE_KIND, SLICE_META_FIELD } from '../data/seed.js'
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
  cloudBaseObjectKeyOf,
  cloudBaseStatus,
  cloudObjectBytesOfRow,
  retryCloudBaseHydration
} from '../data/cloudbase.js'
import { bytesToDataUrl } from '../data/assetmeta.js'
/* **K-P5b（2026-09-23｜讀取面雙路分流）**：行級分流判據的唯一真源在 `imageAuthority.js`
   （行內有 digest 且二進制在服務端權威庫 ⇒ `digest`；否則 ⇒ `local`）。本層只消費，不自立第二把尺子。 */
import { digestOfRow, readViaOfRow } from './imageAuthority.js'
/* **搜索面扩展（§3.54.9｜单点）**：关键字面扩到印人「姓 / 名 / 字 / 号 / 别名 / cbdb_id」——
   复用印人检索的**唯一实现** `persons.searchPersons`（**不另造第二套同名逻辑**）；命中印人 ⇒
   该印人（`author_person_id`）名下的印章一并命中。 */
import { searchPersons } from './persons.js'

export { FACE_KIND }

const KIND_LABELS = {
  [FACE_KIND.FACE]: '印面',
  [FACE_KIND.EDGE]: '邊款'
}

const ORDINALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/** 可标记属性（勘误对象）在印面上的键名（R-30：`seal_type` ＝【印面内容】）。 */
const MARKABLE_KEYS = [
  'seal_name',
  'dynasty',
  'seal_type',
  'author',
  'transcription'
]

export function faceKindLabel(kind) {
  return KIND_LABELS[kind] || KIND_LABELS[FACE_KIND.FACE]
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

/** 某印章的全部印面（按种子顺序，含边款）。 */
export function listFacesOf(sealId) {
  return listFaceRows()
    .filter((row) => (row.sealId || row.stamp_id) === sealId)
    .map(faceViewModel)
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

/** 印面标签：所属印章内**同类别**序号 + 类别，如「印面二」「边款一」。 */
export function faceLabelOf(faceId, sealId = '') {
  const rows = listFaceRows()
  if (faceId) {
    const row = rows.find((item) => item.id === faceId)
    if (row) {
      const sealKey = row.sealId || row.stamp_id
      const siblings = rows.filter(
        (item) => (item.sealId || item.stamp_id) === sealKey && item.kind === row.kind
      )
      const index = siblings.findIndex((item) => item.id === faceId)
      return `${faceKindLabel(row.kind)}${ORDINALS[index] || String(index + 1)}`
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
          images: listImageRows().filter((img) => img.stamp_id === row.stamp_id),
          /* **作者显示名（单点派生）**：供文本导出等按印章取名（**同一单点**，不另写名表）。 */
          author_display: authorDisplay,
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
  let written
  try {
    written = await createSealWithFaceRows(who, payload)
  } catch (err) {
    if (isPermissionError(err)) return deniedResult(err.message)
    return { ok: false, reason: 'ERROR', message: `上傳印章失敗：${(err && err.message) || '未知原因'}` }
  }
  if (!written.ok) {
    return {
      ok: false,
      reason: written.reason || 'ERROR',
      missing: written.missing || [],
      message: written.message
    }
  }
  const stampId = written.stampId || (written.seal && (written.seal.stamp_id || written.seal.id)) || ''
  const faceId = written.faceId || (written.face && written.face.id) || ''
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
export function updateSealAttributes(actor, stampId, patch = {}) {
  const who = actor || currentUser()
  const target = String(stampId === undefined || stampId === null ? '' : stampId).trim()
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
export function updateSealFixedAttributes(actor, faceId, patch = {}) {
  const who = actor || currentUser()
  const facePatch = patch || {}
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
  const meta = listImageRows().find((row) => row.id === imageId) || null
  /* **就緒門檻（M1）**：行查不到 ＋ 讀取面未落定 ⇒ **非終態**（「還沒讀到」不是「沒有這張圖」）。 */
  if (!meta && imageRowsUnsettled()) return imageRowsPendingReadout({ meta: null })
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

/**
 * 重新上传某个印面的印面图（管理员专属；旧影像行与二进制保留）。
 *
 * @param {string} faceId 目标印面编号（如 `fc-0001-f1`）
 * @param {{bytes:Uint8Array|ArrayBuffer, mime?:string, width?:number, height?:number}} payload
 *        `bytes` ＝ 浏览器端处理后的图片字节（方形 WebP）；`mime` / `width` / `height`
 *        仅为调用方的声称值（**入库元数据以字节解析为准**，出入会在 `message` 里如实并列）。
 * @returns {Promise<{ok:boolean, faceImageId?:string, previousFaceImageId?:string|null, face?:object,
 *   image?:object, sealId?:string, deduped?:boolean, reason?:string, message:string}>}
 *   - 成功：`face` 为**替换后**的印面视图模型（`faceImage` / `face_image_id` 已指向新影像），
 *     详情页据此重读即可显示新图（刷新后一致）。
 *   - 拒绝路径（均可读、均有 `reason`）：未登录 ⇒ `UNAUTHENTICATED`；非管理员 ⇒ `FORBIDDEN`；
 *     未指定印面 ⇒ `MISSING_FACE`；内容空 ⇒ `EMPTY_CONTENT`；
 *     **产物超上限（4 MiB）⇒ `ARTIFACT_TOO_LARGE`**（文案＝「本机影像生成失败」，与输入侧分开）；
 *     非图片字节 ⇒ `NOT_IMAGE`；印面不存在 ⇒ `UNKNOWN_FACE`；影像库写失败 ⇒ `STORAGE_UNAVAILABLE`。
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
    return {
      ok: true,
      deduped: written.deduped === true,
      sealId: written.sealId || '',
      faceId: id,
      /* 视图模型按**当前库态**重建 ⇒ `faceImage` / `face_image_id` 立即反映替换结果。 */
      face: getFaceById(id),
      faceImageId: written.faceImageId,
      previousFaceImageId: written.previousFaceImageId ?? previousFaceImageId,
      image: written.image || null,
      message: written.message
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
