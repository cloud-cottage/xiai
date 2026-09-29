
<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import FaceFixedAttributesDialog from '../components/FaceFixedAttributesDialog.vue'
import PlaceholderPanel from '../components/PlaceholderPanel.vue'
import SealFolderPicker from '../components/SealFolderPicker.vue'
import TextTransformButtons from '../components/TextTransformButtons.vue'
import SliceImage from '../components/SliceImage.vue'
import { pipelineNotice, runUploadPipeline } from '../components/uploadPipeline.js'
import { seals, corrections, photos as photoService, points, imageFaces, sealExport } from '../services/index.js'
import { DYNASTY_OPTIONS, FACE_CONTENT_OPTIONS, FACE_STYLE_OPTIONS } from '../data/seed.js'
import { isLoggedIn } from '../data/session.js'
import { formatBytes } from '../utils/format.js'
import { saveLocalBinary } from '../utils/file.js'
import { IMAGE_LIMITS, MIN_CROP_SIDE, describeBytes, exportSquareImage, loadImageFile } from '../utils/image.js'

const route = useRoute()
const router = useRouter()

const ORDINALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/* 固定属性保存后 +1，使下面的派生读数与影像都重新读取。 */
const dataVersion = ref(0)

const seal = computed(() => {
  void dataVersion.value
  return seals.getSealById(route.params.id)
})
/** 印面是属性归属的载体：固定属性、可标记属性都按印面分块展示。 */
const faces = computed(() => (seal.value ? seal.value.faces : []))
const gallery = computed(() => (seal.value ? photoService.listPhotosByStamp(seal.value.stamp_id) : []))

/* ---------------------- 影像：二进制只在 IndexedDB ---------------------- */
/* 页面**只能**经服务层取回二进制（`seals.loadImageDataUrl`），不得自行读写浏览器存储。 */
const imageUrls = reactive({})
const imageErrors = reactive({})
/* **未落定（`pending`）的逐影像讀數（本單 M1）**：它不是錯誤 —— 是「還沒讀到」。留一個顯式的
   非終態讀數，讓面板顯示載入態、且**不妨礙**落定後的重試（錯誤緩存才是永久阻斷的成因）。 */
const imagePending = reactive({})
/* **K-P5b（2026-09-23｜讀取面雙路分流）**：逐影像的來源讀數 —— `digest` ⇒ 二進制在服務端權威庫
   （展示走**塊面**：`POST /api/image/slices?sha256=`，**本機不需要 dataURL**）；
   `local` ⇒ 存量 / 本機二進制行（既有路徑一字未改；非 TIFF 走瀏覽器原生解碼、**零 api**）。 */
const imageVias = reactive({})

const faceImageIds = computed(() => {
  const ids = []
  faces.value.forEach((face) => {
    if (face.face_image_id) ids.push(String(face.face_image_id))
    ;(face.edge_image_ids || []).forEach((id) => ids.push(String(id)))
  })
  return [...new Set(ids)]
})

/** 该影像是否已可展示（`digest` 行无需 dataURL ⇒ 也要渲染，否则塊面根本不被请求）。 */
function imageReadyOf(imageId) {
  if (!imageId) return false
  const id = String(imageId)
  return Boolean(imageUrls[id]) || imageVias[id] === 'digest'
}

async function loadFaceImages() {
  for (const id of faceImageIds.value) {
    if (imageUrls[id] || imageVias[id] === 'digest' || imageErrors[id]) continue
    const out = await seals.imageDisplaySourceOf(id)
    if (!out.ok) {
      /* **未落定 ⇒ 保持載入態、**不寫**錯誤緩存（本單 M1）**：寫進去就會被迴圈開頭的
         `continue` 永久擋住 ⇒ 永遠不再試（線上實據的穩定不出圖）。落定後由下面的 watch
         依賴面（數據源狀態）觸發重試。 */
      if (out.pending) {
        imagePending[id] = out.message
        continue
      }
      delete imagePending[id]
      imageErrors[id] = out.message
      continue
    }
    delete imagePending[id]
    imageVias[id] = out.via
    if (out.via === 'local') imageUrls[id] = out.dataUrl
  }
}

/**
 * 逐影像的**非終態**提示（載入態面板文案）：未落定 ⇒ 讀取中；其餘 ⇒ 既有字面值（一字未改）。
 * @param {string} imageId 影像編號
 * @returns {string} 上屏文案
 */
function imagePendingHintOf(imageId) {
  const id = imageId ? String(imageId) : ''
  return (id && imagePending[id]) || '正在讀取本機影像庫…'
}

watch(
  /* **T3（依賴面缺一項）**：依賴面必須含**逐影像編號**（`faceImageIds`）——
     硬導航 / 雲端水合下，首屏求值時 `seal` 還是 `null` ⇒ 編號集合為空、迴圈跑零次；
     而依賴面若只有 `route.params.id` + `dataVersion`，水合落定後**這個 watch 永不重跑**
     ⇒ 印面圖永遠停在「正在讀取本機影像庫…」（線上實據：詳情頁其餘欄位已渲染、只有圖不出）。
     與實物照片的 watch **同形**（那裡本來就帶 `gallery…map(id).join(',')`）。
     `loadFaceImages()` 對已取到的編號會 `continue` ⇒ 重跑是安全的（不重複取字節）。
   **本單 M1（就緒門檻的重試面）**：依賴面再加**數據源狀態**（`pending` / `ready` / `failed` / `off`）——
     未落定時取字節只會拿回「還沒讀到」的非終態讀數（見 `services/seals.js` 的就緒門檻），
     必須在**狀態一變**就重試一次；否則同一批編號會停在載入態永不重試（這正是線上那條缺陷的
     另一半：錯誤被緩存 ⇒ 不重試）。這裡**不猜、不等**：讀的就是數據源狀態本身（同步只讀）。 */
  () => [route.params.id, dataVersion.value, faceImageIds.value.join(','), seals.dataSourceState().state],
  loadFaceImages,
  { immediate: true }
)

/* ---------------------- 數據源狀態（硬導航首屏不得顯示終態） ---------------------- */
/* **線上實據（2026-09-28）**：直接打開 / 刷新 `/seal/1` 時，雲端快照尚未落定 ⇒
   `seals.getSealById()` 返回 `null`。此刻若渲染「未找到這枚印章」，等於把「還沒讀到」
   說成「不存在」（實據：等 14 秒仍是「未找到」，而同一構建在本地／快照到位後能出內容）。
   ⇒ 一律讀**數據層的數據源讀數**：`pending` ⇒ 載入態；`failed` ⇒ 可重試的失敗態；
   落定（`ready` / `off`）後才允許「未找到」這類終態文案。讀數是響應式的
   （數據層 `shallowRef`）⇒ 水合落定時本頁自動重算，無需手動刷新。 */
const dataSource = computed(() => seals.dataSourceState())
const sealLoading = computed(() => !seal.value && dataSource.value.pending)
const sealUnavailable = computed(() => !seal.value && dataSource.value.failed)

/**
 * 清掉逐影像的**一次性讀數**（終態錯誤 ＋ 未落定標記）。
 * **重試必須真的有牙齒（本單 M1／M4）**：`loadFaceImages()` 迴圈開頭對 `imageErrors[id]` 一律
 * `continue` ⇒ 不清就是「錯誤永久緩存」——重試輪跑完也取不回圖。
 */
function clearImageReadouts() {
  Object.keys(imageErrors).forEach((id) => {
    delete imageErrors[id]
  })
  Object.keys(imagePending).forEach((id) => {
    delete imagePending[id]
  })
}

function retryDataSource() {
  clearImageReadouts()
  void seals.retryDataSource()
}

/* ---------------------- 实物照片：二进制只在 IndexedDB ---------------------- */
/* 画廊**不再依赖行内的 dataURL**（AC-33：整张 dataURL 不得进 localStorage），
   一律按照片 id 经服务层取回二进制渲染。 */
const photoUrls = reactive({})
const photoErrors = reactive({})

async function loadPhotoImages() {
  /* 老库就地纠正：先把旧格式（整张 dataURL 直存 localStorage）的历史行迁进影像库，
     再按 id 取回二进制（迁移幂等，无可迁时零写入）。 */
  await photoService.ensurePhotoStorageMigrated()
  for (const row of gallery.value) {
    if (photoUrls[row.id] || photoErrors[row.id]) continue
    const out = await photoService.loadPhotoDataUrl(row.id)
    if (out.ok) photoUrls[row.id] = out.dataUrl
    else photoErrors[row.id] = out.message
  }
}

watch(() => [route.params.id, dataVersion.value, gallery.value.map((row) => row.id).join(',')], loadPhotoImages, {
  immediate: true
})

const logged = isLoggedIn
const canSubmit = computed(() => seals.canSubmitCorrection())
const canUpload = computed(() => seals.canUploadPhoto())
const canDownload = computed(() => seals.canDownloadHd())
/* 管理员专属按钮的渲染条件（服务层判定；普通用户 / 游客 ⇒ false ⇒ 不渲染）。 */
const canEditFixed = computed(() => seals.canEditFixedAttributes())
/* 「一键导出印章数据」的渲染条件（同样是服务层判定；非管理员 ⇒ false ⇒ 按钮根本不渲染）。 */
const canExportSeal = computed(() => sealExport.canExportSealData())

/* ============================================================================
   影像展示（R-85 / R-87 / R-88）：**印面图 4 块 / 实拍图 8 块**，张数与切位一律读元数据
   ----------------------------------------------------------------------------
   - 切分与拼接在 `SliceImage.vue` 内完成（前端现场切分 → 拼接 → 对外展示输出 webp）；
   - 影像**一律按原色**呈现（R-135：上色面整体退场 ⇒ 无任何上色 / 双色调 / 量化分支）；
   - 本页只做「取回二进制 → 把行（元数据载体）交给组件」，**不自写第二套切分实现**。
   ============================================================================ */

/* ============================================================================
   勘误表单的**封闭选择框**（R-20 / R-30 / R-31 / R-43）
   ----------------------------------------------------------------------------
   选项**只来自真源常量**（顺序即真源顺序，不追加占位项 / 库内派生值）：
     - 朝代 `dynasty` ⇒ `DYNASTY_OPTIONS`（14 类）；
     - 【印面内容】`seal_type` ⇒ `FACE_CONTENT_OPTIONS`（9 值）；
     - 【印面风格】`face_style` ⇒ `FACE_STYLE_OPTIONS`（23 值）。
   其余可标记属性（印文简体/古字、作者、印文释义）**仍是自由文本**（本次不动）。
   真源缺位 ⇒ 可读降级提示，**不回落**成任何库内派生值 / 自写常量。
   ============================================================================ */
const DYNASTY_READY = Array.isArray(DYNASTY_OPTIONS) && DYNASTY_OPTIONS.length > 0
const DYNASTY_MISSING_MESSAGE =
  '朝代選項模塊未就緒（真源常量 DYNASTY_OPTIONS 不可用），暫時無法選擇朝代，請稍後重試。'
const dynastyOptions = computed(() => (DYNASTY_READY ? [...DYNASTY_OPTIONS] : []))

/* ============================================================================
   印章级固定属性（【形制】＋【材质】）—— 详情页**顶部**独立区块
   ----------------------------------------------------------------------------
   - 粒度＝**整枚印章一个**（**不是**印面级）：所以本区块**不在**任何印面块内，
     这两项**也不得**塞进印面级的 `FaceFixedAttributesDialog`（R-22/R-23/R-32）。
   - **R-32（材质移级）**：【材质】`material` 自**印面级**移入本层（印章级真源＝印章行
     `material`）。印面级白名单 `FIXED_ATTR_FIELDS` 现为 `['face_image_id','edge_image_ids']`，
     印章级白名单 `SEAL_FIXED_ATTR_FIELDS` 现为 `['shape','material']`。
   - 展示口径：按印章视图模型的 `shape` / `material` **如实展示**；无值（空串）⇒ 显示
     「未设置」，**不得**回落成任何默认文字 / 编造值。
   - 权限：**仅管理员**可改 —— 非管理员 / 游客 ⇒ 按钮**根本不渲染**（DOM 零命中）。
   - 服务层契约（冻结，R-22/R-23/R-25/R-32）：`canEditSealAttributes(actor?)`、
     `updateSealAttributes(actor, stampId, patch = { shape, material })`（结构化返回
     `{ok, reason?, message}`）。调用点先写好；契约未就绪 ⇒ 可读降级提示，
   ============================================================================ */
const SEAL_ATTR_READY =
  typeof seals.canEditSealAttributes === 'function' &&
  typeof seals.updateSealAttributes === 'function' &&
  /* R-25：印章级已**独立命名**，不再与印面级同名 ⇒ 不再需要「按 arity 区分同名」那套守卫。
     只把签名形状核一遍（`(actor, stampId, patch)`，arity ≥ 2），避免误调到印面级入口。 */
  seals.updateSealAttributes.length >= 2
const SEAL_ATTR_MISSING_MESSAGE =
  '印章屬性模塊未就緒（服務層 canEditSealAttributes / 印章級 updateSealAttributes 尚未就緒），暫時無法編輯印章固定屬性。'

const canEditSealAttrs = computed(() => (SEAL_ATTR_READY ? Boolean(seals.canEditSealAttributes()) : false))
/** 形制：**无值 ⇒ 空串**（不回落默认文字；模板里显示「未设置」）。 */
const sealShape = computed(() => {
  const value = seal.value ? seal.value.shape : ''
  return typeof value === 'string' ? value : ''
})
/** 材质（**印章级**，R-32）：**无值 ⇒ 空串**（不回落；模板里显示「未设置」）。 */
const sealMaterial = computed(() => {
  const value = seal.value ? seal.value.material : ''
  return typeof value === 'string' ? value : ''
})

const sealAttrsFeedback = ref('')
const sealAttrsOpen = ref(false)
const shapeDraft = ref('')
const materialDraft = ref('')

function openSealAttributes() {
  sealAttrsFeedback.value = ''
  shapeDraft.value = sealShape.value
  materialDraft.value = sealMaterial.value
  sealAttrsOpen.value = true
}

function closeSealAttributes() {
  sealAttrsOpen.value = false
}

/**
 * 提交**印章级**固定属性（【形制】＋【材质】，R-22/R-23/R-32）。
 * 结构化结果一律读 `message` 原文展示，不静默。
 *
 * 印章级白名单自 R-32 起为 `['shape','material']` ⇒ **一次提交**即可（本单已删除旧的
 * 「先只提交 shape、再二次提交 material」降级分支：那是白名单尚未含 `material` 时的
 * 过渡兼容代码，现为**死分支**，按仓库纪律不得留存）。
 */
function submitSealAttributes() {
  if (!SEAL_ATTR_READY) {
    sealAttrsFeedback.value = SEAL_ATTR_MISSING_MESSAGE
    return
  }
  const nextShape = String(shapeDraft.value || '').trim()
  const nextMaterial = String(materialDraft.value || '').trim()
  const patch = {}
  if (nextShape !== String(sealShape.value || '').trim()) patch.shape = nextShape
  if (nextMaterial !== String(sealMaterial.value || '').trim()) patch.material = nextMaterial
  if (Object.keys(patch).length === 0) {
    sealAttrsFeedback.value = '沒有檢測到改動：請先修改要保存的項目。'
    return
  }

  let result
  try {
    /* 契约（R-22/R-23/R-25/R-32）：印章级入口 `updateSealAttributes(actor, stampId, patch)`。
       `actor` 传 `null` 走当前会话 —— 与项目现有取法一致（`FaceFixedAttributesDialog.vue` 同口径）。
       `stampId` 是**第 2 个位置参数**；空 ⇒ 结构化 MISSING_REQUIRED、零写入。
       印章级白名单自 R-32 起为 `['shape','material']` ⇒ 两键可**一次**提交。 */
    result = seals.updateSealAttributes(null, seal.value.stamp_id, patch)
  } catch (err) {
    /* 契约要求结构化返回、不抛未捕获异常；这里仍兜一道，避免异常中断界面。 */
    result = { ok: false, message: `印章固定屬性保存失敗：${(err && err.message) || '未知原因'}` }
  }

  sealAttrsFeedback.value =
    (result && result.message) || (result && result.ok ? '印章固定屬性已保存' : '印章固定屬性保存失敗')
  if (result && result.ok) {
    sealAttrsOpen.value = false
    /* 成功后本页立即重读（无需刷新即反映新值）。 */
    dataVersion.value += 1
  }
}

const fixedFeedback = ref('')
const editingFaceId = ref('')
const editingFace = computed(() => faces.value.find((item) => item.id === editingFaceId.value) || null)

function openFixedEditor(face) {
  fixedFeedback.value = ''
  editingFaceId.value = face.id
}

function onFixedSaved(result) {
  fixedFeedback.value = result.message
  dataVersion.value += 1
}

function imageUrlOf(imageId) {
  return imageId ? imageUrls[String(imageId)] || '' : ''
}

function imageErrorOf(imageId) {
  return imageId ? imageErrors[String(imageId)] || '' : ''
}

/**
 * **影像摘要的上屏文本（K-P5b4｜缺字段時優雅降級）**
 * ----------------------------------------------------------------------------
 * 行內摘要（`sha256`）缺失 / 非字串時**不得**直接解引用（`undefined.slice` 會在渲染期
 * 未捕獲拋錯，Vue 中止該層渲染 ⇒ 整個印面塊不渲染），也不得渲染成「摘要 …」這種空殼
 * （讀者會以為摘要是空串）。⇒ 缺字段時給一句可讀的降級說法；欄位齊備時上屏文字
 * **與改前逐字相同**（`摘要 <前 12 位>…`）。
 * ⚠️ 本函數**只影響展示**，不改任何分流語義：讀取面分流的唯一判據仍在
 * `services/imageAuthority.js::readViaOfRow`（本檔不新增任何分流條件）。
 */
function digestTextOf(image) {
  const digest = image && typeof image.sha256 === 'string' ? image.sha256 : ''
  return digest ? `摘要 ${digest.slice(0, 12)}…` : '摘要 暫無（該影像行未留存摘要）'
}

function ordinal(index) {
  return ORDINALS[index] || String(index + 1)
}

/** 印面标签，如「印面一」「边款一」（序号按同类别印面计）。 */
function faceLabel(face) {
  const sameKind = faces.value.filter((item) => item.kind === face.kind)
  const index = sameKind.findIndex((item) => item.id === face.id)
  return `${seals.faceKindLabel(face.kind)}${ordinal(index)}`
}

/** 该印面的可标记属性（勘误对象）当前对外展示值，按印面自身汇总。 */
function markableOf(face) {
  return corrections.resolveMarkable(face)
}

/* ============================================================================
   【印面内容】（R-30，键名 `seal_type`）与【印面风格】（R-31，键名 `face_style`）
   —— 每个**印面（FACE）块**各一组**封闭选择框**
   ----------------------------------------------------------------------------
   - **仅印面（FACE）呈现**；**边款（EDGE）不呈现**（沿用「边款块不呈现」的既有处置；
     条件里带实体类别判据，不只按容器逐块渲染）。
   - 这两项属「**可标记属性**」面（普通用户可提勘误）⇒ 走**勘误路径**：
     `corrections.submitCorrection({faceId, sealId, field, value})`，提交的是 `PENDING`
     勘误，平台审核采纳后才改变对外展示值（与「固定属性」的直写路径不同）。
   - 选项**只来自真源常量**（`FACE_CONTENT_OPTIONS` 9 值 / `FACE_STYLE_OPTIONS` 23 值），
     真源缺位 ⇒ **可读降级提示**，**不自写第二套常量**。
   - `face_style` 的读值：**无回落**（不从 `seal_style` / 印章行取任何值 ⇒ 空串 ⇒「未著录」）。
   ============================================================================ */
const FACE_CONTENT_KEY = 'seal_type' // 【印面内容】＝印面级 `seal_type`
const FACE_STYLE_KEY = 'face_style' // 【印面风格】＝印面级新键 `face_style`

const FACE_CONTENT_READY = Array.isArray(FACE_CONTENT_OPTIONS) && FACE_CONTENT_OPTIONS.length > 0
const FACE_STYLE_READY = Array.isArray(FACE_STYLE_OPTIONS) && FACE_STYLE_OPTIONS.length > 0
const FACE_CONTENT_MISSING_MESSAGE =
  '印面內容選項未就緒（真源常量 FACE_CONTENT_OPTIONS 不可用），暫時無法選擇印面內容，請稍後重試。'
const FACE_STYLE_MISSING_MESSAGE =
  '印面風格選項未就緒（真源常量 FACE_STYLE_OPTIONS 不可用），暫時無法選擇印面風格，請稍後重試。'

const faceContentOptions = computed(() => (FACE_CONTENT_READY ? [...FACE_CONTENT_OPTIONS] : []))
const faceStyleOptions = computed(() => (FACE_STYLE_READY ? [...FACE_STYLE_OPTIONS] : []))

/** 勘误登记面：服务层 `MARKABLE_FIELDS` 里是否已登记该键（未登记 ⇒ 服务层会结构化拒）。 */
function markableRegistered(key) {
  const list = Array.isArray(corrections.MARKABLE_FIELDS) ? corrections.MARKABLE_FIELDS : []
  return list.some((item) => item.key === key)
}

/** 每个印面各一份草稿（按印面 id 分桶；`''` ＝ 本次不提交该项）。 */
const faceEntryDraft = reactive({})
const faceEntryFeedback = reactive({})

function faceEntryDraftOf(face) {
  if (!faceEntryDraft[face.id]) faceEntryDraft[face.id] = { content: '', style: '' }
  return faceEntryDraft[face.id]
}

/** 某印面上某可标记属性的**对外展示值**（优先取采纳勘误后的展示值，否则回落到印面原值）。 */
function faceMarkableValue(face, key, raw) {
  const item = markableOf(face).find((row) => row.key === key)
  const display = item ? item.display : ''
  return display || raw || ''
}

/**
 * 提交本印面的【印面内容】/【印面风格】勘误（只提交**有选择**的项）。
 * 成功后 `dataVersion + 1` ⇒ 「待审核」计数与本块读数**不刷新即反映**。
 */
function submitFaceEntry(face) {
  const draft = faceEntryDraftOf(face)
  const pairs = []
  if (String(draft.content || '').trim()) {
    pairs.push({ field: FACE_CONTENT_KEY, label: '印面內容', value: draft.content })
  }
  if (String(draft.style || '').trim()) {
    pairs.push({ field: FACE_STYLE_KEY, label: '印面風格', value: draft.style })
  }
  if (!pairs.length) {
    faceEntryFeedback[face.id] = '請先從「印面內容」或「印面風格」中至少選擇一項，再提交勘誤。'
    return
  }
  const sealId = seal.value ? seal.value.stamp_id : face.sealId || ''
  let accepted = 0
  let firstError = ''
  pairs.forEach(({ field, label, value }) => {
    const result = corrections.submitCorrection({ faceId: face.id, sealId, field, value })
    if (result.ok) accepted += 1
    else if (!firstError) firstError = result.message || `「${label}」提交失敗`
  })
  if (accepted === 0) {
    faceEntryFeedback[face.id] = firstError
    return
  }
  faceEntryFeedback[face.id] =
    `已提交 ${accepted} 條勘誤，平臺審覈採納後每條獎勵 ${points.CORRECTION_REWARD} 金。`
  if (accepted === pairs.length) {
    draft.content = ''
    draft.style = ''
  }
  /* 无需刷新：服务层读的是已落盘数据，+1 让「待审核」计数与本块读数立即重算。 */
  dataVersion.value += 1
}

const downloadCost = points.DOWNLOAD_COST
const downloadOpen = ref(false)
const downloadFeedback = ref('')
/* 下載面的機械讀數（**不上屏技術標識**：以 `data-*` 屬性承載，供取證 / 自證讀取）。 */
const downloadReport = ref(null)
const downloadBusy = ref(false)
const quote = computed(() => {
  if (!seal.value) return null
  return points.quoteDownload(seal.value.stamp_id, points.downloadSessionKey())
})
const quoteDetail = computed(() => {
  if (!quote.value) return ''
  if (quote.value.charged) {
    return `本次會話已爲該印章計費，不再扣除金，當前金餘額 ${quote.value.balance} 金。`
  }
  if (!quote.value.ok) {
    return `金餘額不足：下載需要 ${downloadCost} 金，當前 ${quote.value.balance} 金。`
  }
  return `當前金餘額 ${quote.value.balance} 金，確認後剩餘 ${quote.value.balance - downloadCost} 金。`
})

const formOpen = ref(false)
const formFeedback = ref('')
const formFaceId = ref('')
/** 勘误对象印面（用于**边款不呈现**两类封闭项的判据，R-37 / R-43）。 */
const formFace = computed(() => faces.value.find((item) => item.id === formFaceId.value) || null)
const formFaceIsEdge = computed(() => Boolean(formFace.value && formFace.value.isEdge))
const formFaceLabel = computed(() => {
  const face = faces.value.find((item) => item.id === formFaceId.value)
  return face ? faceLabel(face) : ''
})
const form = reactive({
  /* R-59：【印文简体字】（`transcription_simplified`）已整体删除 ⇒ 本录入面不再有该字段。 */
  seal_name: '',
  dynasty: '',
  seal_type: '',
  author: '',
  transcription: '',
  basis: ''
})

const uploadFeedback = ref('')
const uploading = ref(false)

function goLogin() {
  router.push({ name: 'login', query: { redirect: route.fullPath } })
}

function openDownload() {
  downloadFeedback.value = ''
  if (!canDownload.value) {
    downloadFeedback.value = '登錄後可下載高清原圖；同一枚印章每次會話只扣費一次。'
    goLogin()
    return
  }
  downloadOpen.value = true
}

/* ============================================================================
   保存入口②（詳情頁操作钮，v1.21 新增｜规范 §3.21.4 / §3.21.11 / §3.21.12）
   ----------------------------------------------------------------------------
   与保存入口① **钩子取值逐字相同**（均挂 `data-drive-action="save-seal"`）；
   未登錄点击 ⇒ 逐字引导（§3.21.12 第 14 行）＋ 跳 `/login`（带 `redirect`）；
   登錄点击 ⇒ 打开**同一个**轻量选择器（`SealFolderPicker.vue`）——
   ============================================================================ */
const SAVE_GUIDE = '登錄後即可把印章存入資料夾。'
const driveSaveFeedback = ref('')
const saveOpen = ref(false)

function openSaveToDrive() {
  driveSaveFeedback.value = ''
  if (!logged.value) {
    driveSaveFeedback.value = SAVE_GUIDE
    goLogin()
    return
  }
  saveOpen.value = true
}

/** 保存反馈由选择器内给出（成功 / 幂等 / 失败三类逐字）；此处只保留选择器打开态。 */
function onDriveSealSaved() {}

/* ============================================================================
   一键导出印章数据（管理员专属）
   ----------------------------------------------------------------------------
   按钮落点＝详情页操作区（与「存入雲盤」「下載高清原圖」同列）；非管理员 ⇒ **不渲染**。
   点击 ⇒ 服务层 `sealExport.exportSealData()`：**恰好一个工作表**的 `.xlsx`
   （层级分组：印章级固定属性 → 印面级固定属性 → 可勘误属性的系统选中值 → 影像内嵌 PNG）。
   失败即取消（服务层保证零半成品文件）；本页只把结果如实上屏（可读文案 ＋ 结构化读数）。
   ============================================================================ */
const exportFeedback = ref('')
const exportReport = ref(null)
const exporting = ref(false)

async function runSealExport() {
  if (exporting.value) return
  exportFeedback.value = ''
  exportReport.value = null
  exporting.value = true
  try {
    const result = await sealExport.exportSealData(route.params.id)
    exportReport.value = result
    exportFeedback.value = result.message
  } catch (err) {
    exportReport.value = { ok: false, reason: 'UNEXPECTED', message: (err && err.message) || '未知原因' }
    exportFeedback.value = `導出失敗（${(err && err.message) || '未知原因'}）；本次未產出任何文件。`
  } finally {
    exporting.value = false
  }
}

function confirmDownload() {
  const sealRow = seal.value
  if (!sealRow) return
  const result = points.chargeSealDownload(sealRow.stamp_id, points.downloadSessionKey(), sealRow.seal_name)
  if (!result.ok) {
    downloadFeedback.value = result.message
    downloadOpen.value = false
    return
  }
  void runOriginalDownload(sealRow)
}

/* ============================================================================
   下載面（「下載高清原圖」｜规范 §3.26 / §3.24.3 ②）
   ----------------------------------------------------------------------------
   产物 ＝ **存儲件的原字節直出**（`image/tiff`；不加水印；不經切分內核；零轉碼 ⇒ byte-verbatim）。
   **權限與扣費流程不變**（`points.chargeSealDownload` 會話計費：同一枚印章同一次會話只扣一次）；
   扣費通過後才取件；取件失敗 ⇒ 對話框保持打開、提示可見，重試不再扣費（不得重複扣費 / 不得重複行）。
   ============================================================================ */
async function runOriginalDownload(sealRow) {
  if (downloadBusy.value) return
  downloadBusy.value = true
  const out = await imageFaces.downloadOriginalFor(sealRow.stamp_id)
  downloadBusy.value = false
  downloadReport.value = out.report
  downloadFeedback.value = out.message
  if (out.ok) {
    /* 字節原樣落盤（`saveLocalBinary` 不做任何轉碼 / 加水印）。 */
    saveLocalBinary(out.filename, out.bytes, out.mime)
    downloadOpen.value = false
  }
}

function openCorrection(face) {
  if (!canSubmit.value) {
    goLogin()
    return
  }
  corrections.MARKABLE_FIELDS.forEach((item) => {
    form[item.key] = ''
  })
  form.basis = ''
  formFeedback.value = ''
  formFaceId.value = face.id
  formOpen.value = true
}

/**
 * R-43：**边款（EDGE）印面不呈现**【印面内容】/【印面风格】两项（其余可标记字段保持现状）。
 * 判据带**实体类别**，不只按容器逐块渲染（与详情页印面块的既有处置同口径）。
 */
function correctionFieldVisible(item) {
  const closedOnFace = item.key === FACE_CONTENT_KEY || item.key === FACE_STYLE_KEY
  return !(closedOnFace && formFaceIsEdge.value)
}

/**
 * 該可標記字段是否為**自由文本**（＝ `v-else` 分支渲染的那幾個）。
 * 三動作轉換按鈕**只給自由文本字段**：封閉選擇框（朝代 / 【印面內容】/【印面風格】）**不加**
 * （封閉項的值只能來自真源選項，轉換按鈕對它無意義、且會誘導出值域外的值）。
 */
function correctionFieldIsFreeText(key) {
  return key !== 'dynasty' && key !== FACE_CONTENT_KEY && key !== FACE_STYLE_KEY
}

function submitCorrection() {
  if (!seal.value || !formFaceId.value) return
  const filled = corrections.MARKABLE_FIELDS.filter(
    (item) => correctionFieldVisible(item) && String(form[item.key] || '').trim() !== ''
  )
  if (filled.length === 0) {
    formFeedback.value = '請至少填寫一項需要勘誤的屬性'
    return
  }
  let accepted = 0
  let firstError = ''
  filled.forEach((item) => {
    const result = corrections.submitCorrection({
      faceId: formFaceId.value,
      sealId: seal.value.stamp_id,
      field: item.key,
      value: form[item.key],
      basis: form.basis
    })
    if (result.ok) accepted += 1
    else if (!firstError) firstError = result.message
  })
  if (accepted === 0) {
    formFeedback.value = firstError || '提交失敗，請稍後重試'
    return
  }
  formFeedback.value = `已提交 ${accepted} 條勘誤，平臺審覈採納後每條獎勵 ${points.CORRECTION_REWARD} 金。`
  if (accepted === filled.length) formOpen.value = false
}

async function onPickPhoto(event) {
  const file = event.target.files && event.target.files[0]
  event.target.value = ''
  if (!canUpload.value) {
    uploadFeedback.value = '登錄後可上傳印章實物照片'
    return
  }
  if (!file || !seal.value) return
  uploading.value = true
  /* 处理全部在浏览器端：解码 → 方形化（中心最大正方形）→ 降采样 → 入库编码
     （单页 8bit Deflate TIFF）；展示 / 预览面另经展示件转码（有损 WebP 0.92）。
     不调任何后端端点；二进制进 IndexedDB，localStorage 只存元数据。 */
  const loaded = await loadImageFile(file)
  const denied = photoService.inputDenialOf(loaded)
  if (denied) {
    /* 输入侧 reason 由**服务层结构化透传**（输入超限 ⇒ `TOO_LARGE`，§3.12.10(c)），文案同源。 */
    uploadFeedback.value = denied.message
    uploading.value = false
    return
  }
  /* 上传端走**单一具名入口**（R-86 原提 AVIF 源文件；现行容器口径＝单页 8bit Deflate TIFF
     ⇒ `preparePhotoSource`）；入口不可调用 / 调用失败 / 产物形状不符 ⇒ 可读繁体提示，
     且**不提交任何内容**。 */
  const exported = await runUploadPipeline({
    kind: 'photo',
    bitmap: loaded.bitmap,
    options: { maxSide: IMAGE_LIMITS.maxSide, quality: IMAGE_LIMITS.quality }
  })
  if (!exported.ok) {
    uploadFeedback.value = `照片處理失敗：${exported.message}`
    uploading.value = false
    return
  }
  const result = await photoService.uploadPhoto({
    stampId: seal.value.stamp_id,
    bytes: exported.bytes,
    mime: exported.mime,
    width: exported.width,
    height: exported.height,
    fileName: file.name
  })
  uploadFeedback.value = result.ok
    ? `${result.message}（${describeBytes(loaded.originalBytes)} → ${describeBytes(exported.bytes.length)}，${exported.width} × ${exported.height}，${exported.mime}），已歸入本印章實物照片。${exported.notice ? ` ${exported.notice}` : ''}`
    : result.message
  if (result.ok) {
    dataVersion.value += 1
    await loadPhotoImages()
  }
  uploading.value = false
}
/* ============================================================================
   管理员：重新上传印面图（**按印面逐个**）
   ----------------------------------------------------------------------------
   交互与「上传印章」弹窗同一口径：选本机图片（1 MB 上限，判据＝原始文件字节）→ 解码 →
   在**可拖拽 / 缩放的方形取景框**里取景 → `runUploadPipeline`（`prepareFaceImageSource`）出单页 8bit Deflate TIFF →
   交服务层 `seals.replaceFaceImage(faceId, {bytes, mime, width, height})`。
   - **只调 `utils/image.js`，不自写 canvas 处理**；**不调斐萃 5196 的 square-crop**。
   - 旧影像**不删**：数据层「新增影像行 + 改印面指向」，UI 如实回报「影像编号 旧 → 新」。
   - 成功后立即按**新影像编号**经服务层取回二进制渲染 ⇒ **无需刷新**即显示新图。
   - 失败一律可读：解码失败 / 超限 / 越权（FORBIDDEN）/ 存储失败。
   ============================================================================ */

/** 预览容器最长边（CSS px）；只缩不放，避免小图被拉糊（与「上传印章」同口径）。 */
const PREVIEW_MAX = 240
/** 冻结契约的接口名逐个核对；任一缺位 ⇒ 可读降级提示，而不是静默放行。 */
const PIPELINE_READY = typeof loadImageFile === 'function' && typeof exportSquareImage === 'function'
const PIPELINE_MISSING_MESSAGE =
  '圖像處理模塊未就緒（utils/image.js 的 loadImageFile / exportSquareImage 不可用），暫時無法在本機處理印面圖，請稍後重試。'

/* 新管线（R-83 印面 8 色索引 PNG / R-86 实拍 AVIF）就绪读数：入口不可调用 ⇒ 可读繁体降级提示，
   **不静默**、**不自写第二套编码**（单一具名调用见 `components/uploadPipeline.js`；R-95）。 */
const facePipelineNotice = pipelineNotice('face')
const photoPipelineNotice = pipelineNotice('photo')

/** 管理员专属：按钮的渲染条件（服务层判定；普通用户 / 游客 ⇒ false ⇒ **不渲染**，DOM 零命中）。 */
const canReplaceFaceImage = computed(() => seals.canReplaceFaceImage())
const limitLabel = formatBytes(IMAGE_LIMITS.maxInputBytes)
const maxSideLabel = `${IMAGE_LIMITS.maxSide}px`

const replaceFeedback = ref('')
const replaceFaceId = ref('')
const replaceFace = computed(() => faces.value.find((item) => item.id === replaceFaceId.value) || null)
/** 已选原图：`{ bitmap, width, height, originalBytes, originalMime, name, previewUrl }`。 */
const replaceSource = ref(null)
/** 取景方形框（**原图像素坐标**）：`{ cx, cy, side }`。 */
const replaceCrop = ref(null)
/** 最近一次导出读数：`{ bytes, mime, width, height }`（仅用于展示；提交时重新导出）。 */
const replaceExported = ref(null)
const replaceBusy = ref(false)
const replaceDragging = ref(null)
let replaceExportToken = 0

function replaceClamp(value, min, max) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/** 中心最大正方形（边长＝短边）＝默认取景（与管线内 `crop` 省略时的口径一致）。 */
function centerSquare(width, height) {
  const side = Math.max(1, Math.round(Math.min(width, height)))
  return { cx: Math.round((width - side) / 2), cy: Math.round((height - side) / 2), side }
}

const replaceGeom = computed(() => {
  const src = replaceSource.value
  if (!src) return null
  const scale = Math.min(PREVIEW_MAX / src.width, PREVIEW_MAX / src.height, 1)
  return {
    scale,
    viewW: Math.max(1, Math.round(src.width * scale)),
    viewH: Math.max(1, Math.round(src.height * scale))
  }
})

const replaceFrameStyle = computed(() => {
  const g = replaceGeom.value
  const c = replaceCrop.value
  if (!g || !c) return null
  return {
    left: `${Math.round(c.cx * g.scale)}px`,
    top: `${Math.round(c.cy * g.scale)}px`,
    width: `${Math.max(8, Math.round(c.side * g.scale))}px`,
    height: `${Math.max(8, Math.round(c.side * g.scale))}px`
  }
})

/** 用当前取景框导出「入库用」字节，并把尺寸 / 体量 / mime 读数回填到预览。 */
async function runReplaceExport() {
  const src = replaceSource.value
  if (!src || !src.bitmap || !replaceCrop.value) {
    replaceExported.value = null
    return
  }
  const token = (replaceExportToken += 1)
  try {
    /* 上传端走**单一具名入口**（R-83：印面源文件＝8 色索引 PNG ⇒ `prepareFaceImageSource`）。 */
    const result = await runUploadPipeline({
      kind: 'face',
      bitmap: src.bitmap,
      options: {
        crop: replaceCrop.value,
        maxSide: IMAGE_LIMITS.maxSide
      }
    })
    if (token !== replaceExportToken) return
    if (!result.ok) {
      replaceExported.value = null
      replaceFeedback.value = `印面圖處理失敗：${result.message}`
      return
    }
    replaceExported.value = {
      bytes: result.bytes,
      mime: result.mime,
      width: result.width,
      height: result.height
    }
    /* 管线服务层会给出产物口径的如实说明（索引色 / 位深 / 调色板项数 / 体量）⇒ 原样展示；
       入口不可调用时的降级说明同源。 */
    if (result.notice || result.message) replaceFeedback.value = `${result.notice ? `${result.notice} ` : ''}${result.message || ''}`.trim()
  } catch (err) {
    if (token !== replaceExportToken) return
    replaceExported.value = null
    replaceFeedback.value = `印面圖處理失敗：${(err && err.message) || '未知原因'}`
  }
}

function releaseReplaceSource() {
  const src = replaceSource.value
  if (src && src.previewUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
    try {
      URL.revokeObjectURL(src.previewUrl)
    } catch {
      /* 释放失败不影响后续流程。 */
    }
  }
  replaceSource.value = null
  replaceCrop.value = null
  replaceExported.value = null
  replaceDragging.value = null
  replaceExportToken += 1
}

function openFaceImageReplace(face) {
  replaceFeedback.value = ''
  releaseReplaceSource()
  replaceFaceId.value = face.id
}

function closeFaceImageReplace() {
  releaseReplaceSource()
  replaceFaceId.value = ''
}

async function onPickReplaceImage(event) {
  const file = event.target.files && event.target.files[0]
  event.target.value = ''
  if (!file) return

  releaseReplaceSource()
  replaceFeedback.value = ''

  if (!PIPELINE_READY) {
    replaceFeedback.value = PIPELINE_MISSING_MESSAGE
    return
  }

  const loaded = await loadImageFile(file)
  const denied = seals.inputDenialOf(loaded)
  if (denied) {
    /* 输入侧 reason 由**服务层结构化透传**（输入超限 ⇒ `TOO_LARGE`，§3.12.10(c)）；
       超限时再把**真实上限**与**所选文件实际体量**一并写进提示（不靠猜、不静默）。 */
    const detail = denied.reason === 'TOO_LARGE'
      ? `（所選文件 ${formatBytes(loaded.originalBytes)}，上限 ${formatBytes(IMAGE_LIMITS.maxInputBytes)}）`
      : ''
    replaceFeedback.value = `${denied.message}${detail}`
    return
  }

  let previewUrl = ''
  if (typeof URL !== 'undefined' && URL.createObjectURL) {
    try {
      previewUrl = URL.createObjectURL(file)
    } catch {
      previewUrl = ''
    }
  }

  replaceSource.value = {
    bitmap: loaded.bitmap,
    width: loaded.width,
    height: loaded.height,
    originalBytes: loaded.originalBytes,
    originalMime: loaded.originalMime,
    name: file.name || '已選圖片',
    previewUrl
  }
  replaceCrop.value = centerSquare(loaded.width, loaded.height)
  await runReplaceExport()
}

function startReplaceDrag(event, mode) {
  const g = replaceGeom.value
  const c = replaceCrop.value
  if (!g || !c) return
  replaceDragging.value = {
    mode,
    x: event.clientX,
    y: event.clientY,
    cx: c.cx,
    cy: c.cy,
    side: c.side
  }
  const target = event.currentTarget
  if (target && typeof target.setPointerCapture === 'function') {
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      /* 指针捕获失败不影响拖动（事件仍会冒到元素上）。 */
    }
  }
  event.preventDefault()
}

function onReplaceDragMove(event) {
  const drag = replaceDragging.value
  const src = replaceSource.value
  const g = replaceGeom.value
  if (!drag || !src || !g || g.scale <= 0) return
  const dx = (event.clientX - drag.x) / g.scale
  const dy = (event.clientY - drag.y) / g.scale

  if (drag.mode === 'move') {
    replaceCrop.value = {
      cx: Math.round(replaceClamp(drag.cx + dx, 0, src.width - drag.side)),
      cy: Math.round(replaceClamp(drag.cy + dy, 0, src.height - drag.side)),
      side: drag.side
    }
    return
  }

  /* 缩放：锚定方框左上角，边长随位移增大（取两轴较大者，手感更跟手）。 */
  const room = Math.min(src.width - drag.cx, src.height - drag.cy)
  const side = Math.round(replaceClamp(drag.side + Math.max(dx, dy), Math.min(MIN_CROP_SIDE, room), room))
  replaceCrop.value = { cx: drag.cx, cy: drag.cy, side: Math.max(1, side) }
}

function endReplaceDrag(event) {
  if (!replaceDragging.value) return
  const target = event && event.currentTarget
  if (target && event.pointerId !== undefined && typeof target.releasePointerCapture === 'function') {
    try {
      target.releasePointerCapture(event.pointerId)
    } catch {
      /* 未捕获时释放会抛，忽略即可。 */
    }
  }
  replaceDragging.value = null
  runReplaceExport()
}

function resetReplaceCrop() {
  const src = replaceSource.value
  if (!src) return
  replaceCrop.value = centerSquare(src.width, src.height)
  runReplaceExport()
}

/**
 * 提交替换：**提交前重新导出一次**，确保入库字节就是当前取景框的产物；
 * 成功后按新影像编号取回二进制并立即渲染（无需刷新），再让派生读数重算。
 */
async function submitReplaceFaceImage() {
  if (replaceBusy.value) return
  const face = replaceFace.value
  if (!face) return
  replaceBusy.value = true
  try {
    if (!PIPELINE_READY) {
      replaceFeedback.value = PIPELINE_MISSING_MESSAGE
      return
    }
    const src = replaceSource.value
    if (!src || !src.bitmap || !replaceCrop.value) {
      replaceFeedback.value = '請先選擇一張本機圖片文件（JPG / PNG / WebP）'
      return
    }
    /* 提交前重新导出一次（**单一具名入口** `prepareFaceImageSource`；不回落任何既有管线）。 */
    const exported = await runUploadPipeline({
      kind: 'face',
      bitmap: src.bitmap,
      options: {
        crop: replaceCrop.value,
        maxSide: IMAGE_LIMITS.maxSide
      }
    })
    if (!exported.ok) {
      replaceExported.value = null
      replaceFeedback.value = `印面圖處理失敗：${exported.message}（本次未提交任何內容）`
      return
    }
    replaceExported.value = {
      bytes: exported.bytes,
      mime: exported.mime,
      width: exported.width,
      height: exported.height
    }

    const result = await seals.replaceFaceImage(face.id, {
      bytes: exported.bytes,
      mime: exported.mime,
      width: exported.width,
      height: exported.height
    })
    if (!result.ok) {
      replaceFeedback.value = `替換失敗：${result.message}`
      return
    }

    /* 立即显示新图：按**新影像编号**取回二进制（二进制只在 IndexedDB，页面只经服务层读）。 */
    const newId = String(result.faceImageId || '')
    if (newId && !imageUrls[newId] && imageVias[newId] !== 'digest') {
      const loaded = await seals.imageDisplaySourceOf(newId)
      if (!loaded.ok) {
        imageErrors[newId] = loaded.message
      } else {
        imageVias[newId] = loaded.via
        if (loaded.via === 'local') imageUrls[newId] = loaded.dataUrl
      }
    }
    replaceFeedback.value = result.message
    dataVersion.value += 1
    /* 关窗后顶部通知仍保留这条可读反馈（含「影像编号 旧 → 新」）。 */
    closeFaceImageReplace()
  } catch (err) {
    replaceFeedback.value = `替換失敗：${(err && err.message) || '未知原因'}`
  } finally {
    replaceBusy.value = false
  }
}

onBeforeUnmount(() => {
  releaseReplaceSource()
})
</script>

<template>
  <section v-if="seal">
    <div class="page-head detail__head">
      <div>
        <h1>{{ seal.seal_name || '佚名' }}</h1>
        <p>
          <span class="detail__tag detail__tag--era">{{ seal.dynasty }}</span>
          <span class="detail__tag">{{ seal.seal_type }}</span>
          <span v-if="seal.hasEdge" class="detail__tag detail__tag--edge">含邊款</span>
          <span class="detail__id">藏品編號 {{ seal.stamp_id }}</span>
          <span class="detail__id">共 {{ faces.length }} 個印面</span>
        </p>
      </div>
      <div class="detail__acts">
        <!-- 保存入口②：詳情頁操作钮（v1.21 新增）。**未登錄仍渲染**（不得 CSS 隐藏 / disabled 冒充）；
             钩子取值与廣場卡片内那处**逐字相同**（`data-drive-action="save-seal"`）。 -->
        <button
          class="btn btn--ghost"
          type="button"
          data-drive-action="save-seal"
          @click="openSaveToDrive"
        >
          存入雲盤
        </button>
        <button class="btn btn--primary" type="button" @click="openDownload">下載高清原圖</button>
        <!-- 「一鍵導出印章數據」（管理员专属）：非管理员 / 游客 ⇒ **不渲染**（DOM 零命中；
             不得用 CSS 隐藏 / `disabled` 冒充）。钩子字面值 `export-seal-data`。 -->
        <button
          v-if="canExportSeal"
          class="btn btn--ghost"
          type="button"
          data-admin-action="export-seal-data"
          @click="runSealExport"
        >
          一鍵導出印章數據
        </button>
      </div>
    </div>

    <!-- **O-1**：雲讀失敗已回落本機示範資料（此刻 `seal` 來自示範集）⇒ 顯式提示 ＋ 重試入口。 -->
    <p v-if="dataSource.failed" class="notice detail__notice" data-source-fallback="seal-detail">
      雲端資料暫時未能讀取，目前顯示的是本機示範資料；可按「重新讀取」再試一次。
      <button class="btn btn--ghost" type="button" @click="retryDataSource">重新讀取</button>
    </p>
    <p v-if="driveSaveFeedback" class="notice detail__notice" data-drive-feedback="save-seal">
      {{ driveSaveFeedback }}
    </p>

    <p v-if="downloadFeedback" class="notice detail__notice" :data-download-report="downloadReport ? JSON.stringify(downloadReport) : null">{{ downloadFeedback }}</p>

    <!-- 一键导出印章数据的可读反馈 ＋ 结构化读数（成功 / 失败都走这里；失败即取消、零产出）。 -->
    <p
      v-if="exportFeedback"
      class="notice detail__notice"
      :data-export-report="exportReport ? JSON.stringify(exportReport) : null"
    >
      {{ exportFeedback }}
    </p>

    <p v-if="fixedFeedback" class="notice detail__notice" data-admin-feedback="fixed-attributes">
      {{ fixedFeedback }}
    </p>

    <!-- 替换印面图的可读反馈（含「影像编号 旧 → 新」；成功 / 失败都走这里）。 -->
    <p v-if="replaceFeedback" class="notice detail__notice" data-admin-feedback="replace-face-image">
      {{ replaceFeedback }}
    </p>

    <!-- 印面图上传端的**可读降级提示**（R-93：本常量必须真渲染，不得只定义不用）。
         唯一具名入口 `services/seals.js` 的 `prepareFaceImageSource` 不可调用时上屏；
         就绪时为空串 ⇒ `v-if` 判假 ⇒ 界面零噪声（DOM 零命中）。 -->
    <p v-if="facePipelineNotice" class="notice detail__notice" data-pipeline-degraded="face-upload">
      {{ facePipelineNotice }}
    </p>

    <!-- 印章级固定属性（**整枚印章一个**，故**不在**任何印面块内；含【形制】＋【材质】
         两项，R-32 把材质自印面级移入本层）。二者自由文本、**不参与广场筛选**。 -->
    <section class="panel seal-attrs" data-seal-attributes>
      <div class="panel__head">
        <h2>印章固定屬性</h2>
        <!-- 管理员专属（非管理员 / 游客 ⇒ 不渲染，DOM 零命中）。第 5 类能力 / 第 6 个字面值。 -->
        <button
          v-if="canEditSealAttrs"
          class="btn btn--ghost"
          type="button"
          data-admin-action="edit-seal-attributes"
          @click="openSealAttributes"
        >
          編輯印章屬性
        </button>
      </div>
      <div class="panel__body">
        <dl class="detail__fixed">
          <div>
            <dt>形制</dt>
            <!-- 无值 ⇒ 如实展示「未设置」（不得回落成任何默认文字）。 -->
            <dd data-seal-attribute="shape">{{ sealShape || '未設置' }}</dd>
          </div>
          <div>
            <dt>材質</dt>
            <!-- R-32：材质是**印章级**固定属性（真源＝印章行 `material`）；无值 ⇒ 「未设置」。 -->
            <dd data-seal-attribute="material">{{ sealMaterial || '未設置' }}</dd>
          </div>
        </dl>
        <p class="detail__hint">
          形制與材質是印章級固定屬性（整枚印章各一個），自由文本且不參與廣場篩選。
        </p>
        <p v-if="!SEAL_ATTR_READY" class="detail__hint" data-seal-attributes-degraded>
          {{ SEAL_ATTR_MISSING_MESSAGE }}
        </p>
        <p v-if="sealAttrsFeedback" class="notice detail__notice" data-admin-feedback="seal-attributes">
          {{ sealAttrsFeedback }}
        </p>
      </div>
    </section>

    <p class="detail__hint detail__lede">
      一枚印章可含多個印面，邊款是其中的特殊印面；下列屬性均按印面歸屬。
    </p>

    <section
      v-for="face in faces"
      :key="face.id"
      class="panel face-block"
      :data-face-kind="face.isEdge ? 'EDGE' : 'FACE'"
      :data-face-id="face.id"
    >
      <div class="panel__head">
        <h2 class="face-block__title">
          <span class="face-block__badge" :class="{ 'face-block__badge--edge': face.isEdge }">
            {{ faceLabel(face) }}
          </span>
          <span class="face-block__name">{{ face.seal_name || '佚名' }}</span>
          <span class="face-block__id">{{ face.id }}</span>
        </h2>
        <div class="face-block__admin-actions">
          <button
            v-if="canEditFixed"
            class="btn btn--ghost"
            type="button"
            data-admin-action="edit-fixed-attributes"
            @click="openFixedEditor(face)"
          >
            編輯固定屬性
          </button>
          <!-- 管理员专属（普通用户 / 游客 ⇒ 不渲染，DOM 零命中）：替换**本印面**的印面图。
               仅印面（FACE）可换；边款（EDGE）不呈现此按钮（数据层未拦 EDGE，见规范登记）。 -->
          <button
            v-if="canReplaceFaceImage && !face.isEdge"
            class="btn btn--ghost"
            type="button"
            data-admin-action="replace-face-image"
            :data-face-id="face.id"
            @click="openFaceImageReplace(face)"
          >
            重新上傳印面圖
          </button>
        </div>
      </div>
      <div class="panel__body">
        <h3 class="face-block__sub">固定屬性</h3>
        <dl class="detail__fixed">
          <div>
            <dt>印面圖片</dt>
            <dd>{{ face.face_image_id ? `影像編號 ${face.face_image_id}` : '暫缺' }}</dd>
          </div>
          <div>
            <dt>邊款圖片 ID</dt>
            <dd>{{ face.edge_image_ids.length ? face.edge_image_ids.join('、') : '無' }}</dd>
          </div>
        </dl>
        <!-- R-32：【材质】已自印面级固定属性**移出**（移入顶部「印章固定属性」区）⇒
             本块不再呈现材质行；白名单现为 ['face_image_id','edge_image_ids']（R-135：上色面退场）。 -->

        <div class="face-block__media">
          <figure v-if="face.face_image_id" class="face-block__figure">
            <figcaption>印面影像 {{ face.face_image_id }}</figcaption>
            <!-- R-87 / R-88：按元数据切分（印面族 4 块）→ 前端拼接展示（按原色，无上色）。 -->
            <SliceImage
              v-if="imageReadyOf(face.face_image_id)"
              class="face-block__img"
              :src="imageUrlOf(face.face_image_id)"
              :row="face.faceImage"
              :alt="`${faceLabel(face)}印面影像`"
              :caption="`印面圖 ${face.face_image_id}`"
              data-face-image
            />
            <p v-else-if="imageErrorOf(face.face_image_id)" class="detail__hint">
              {{ imageErrorOf(face.face_image_id) }}（本機影像庫中暫無該編號的圖象文件。）
            </p>
            <p v-else class="detail__hint">{{ imagePendingHintOf(face.face_image_id) }}</p>
            <p v-if="face.faceImage">
              {{ face.faceImage.width }} × {{ face.faceImage.height }} · {{ formatBytes(face.faceImage.bytes) }} · {{ face.faceImage.color_mode }}
            </p>
            <p v-if="face.faceImage" class="detail__sha">{{ digestTextOf(face.faceImage) }}</p>
          </figure>
          <p v-else-if="!face.isEdge" class="detail__hint">本印面暫無印面影像。</p>

          <template v-if="face.isEdge">
            <div v-for="image in face.edgeImages" :key="image.id" class="face-block__figure">
              <p class="face-block__figure-title">邊款影像 {{ image.id }}</p>
              <SliceImage
                v-if="imageReadyOf(image.id)"
                class="face-block__img"
                :src="imageUrlOf(image.id)"
                :row="image"
                alt="邊款影像"
                :caption="`邊款圖 ${image.id}`"
                data-face-image
              />
              <p v-else-if="imageErrorOf(image.id)" class="detail__hint">{{ imageErrorOf(image.id) }}</p>
              <p>{{ image.width }} × {{ image.height }} · {{ formatBytes(image.bytes) }} · {{ image.color_mode }}</p>
              <p class="detail__sha">{{ digestTextOf(image) }}</p>
            </div>
            <p v-if="face.missingEdgeIds.length" class="face-block__empty">
              影像庫中暫無編號「{{ face.missingEdgeIds.join('、') }}」對應的影像，請覈對邊款圖片 ID。
            </p>
            <p v-else-if="face.edge_image_ids.length === 0" class="detail__hint">本邊款尚未登記邊款圖片 ID。</p>
          </template>
        </div>

        <p v-if="face.source" class="detail__hint">
          來源追蹤：{{ face.source.book || '—' }}{{ face.source.page ? ` · ${face.source.page}` : '' }}
        </p>
        <p v-else class="detail__hint">來源追蹤：暫無</p>

        <h3 class="face-block__sub">可標記屬性</h3>
        <div class="face-block__sub-head">
          <button v-if="canSubmit" class="btn btn--ghost" type="button" @click="openCorrection(face)">勘誤</button>
          <span v-else class="detail__hint">登錄後可提交勘誤，審覈通過後每條獎勵 {{ points.CORRECTION_REWARD }} 金。</span>
        </div>

        <!-- 【印面内容】（R-30，9 值）/【印面风格】（R-31，23 值）：**封闭选择框**，每个印面块各一组。
             这两项属「**可标记属性**」面 ⇒ 走**勘误路径**（提交 PENDING 勘误，审核采纳后才改对外展示值）。
             选项**只来自真源常量**（顺序即真源顺序），**不追加任何占位项 / 库内派生值**。 -->
        <div v-if="!face.isEdge" class="face-entry" data-face-entry>
          <div class="field">
            <label :for="`face-content-${face.id}`">印面內容</label>
            <select
              :id="`face-content-${face.id}`"
              v-model="faceEntryDraftOf(face).content"
              data-face-content-select
            >
              <option v-for="value in faceContentOptions" :key="value" :value="value">{{ value }}</option>
            </select>
            <span class="field__hint">
              印面內容固定 {{ faceContentOptions.length }} 類（只可選不可填）；本印面當前展示值：{{ faceMarkableValue(face, 'seal_type', face.seal_type) || '未著錄' }}。
            </span>
            <span v-if="!FACE_CONTENT_READY" class="field__hint" data-face-content-degraded>
              {{ FACE_CONTENT_MISSING_MESSAGE }}
            </span>
          </div>

          <div class="field">
            <label :for="`face-style-${face.id}`">印面風格</label>
            <select
              :id="`face-style-${face.id}`"
              v-model="faceEntryDraftOf(face).style"
              data-face-style-select
            >
              <option v-for="value in faceStyleOptions" :key="value" :value="value">{{ value }}</option>
            </select>
            <span class="field__hint">
              印面風格固定 {{ faceStyleOptions.length }} 類（只可選不可填）；本印面當前展示值：{{ faceMarkableValue(face, 'face_style', face.face_style) || '未著錄' }}。
            </span>
            <span v-if="!FACE_STYLE_READY" class="field__hint" data-face-style-degraded>
              {{ FACE_STYLE_MISSING_MESSAGE }}
            </span>
          </div>

          <div class="face-entry__foot">
            <button
              v-if="canSubmit"
              class="btn btn--ghost"
              type="button"
              data-action="face-entry-submit"
              @click="submitFaceEntry(face)"
            >
              提交勘誤
            </button>
            <span v-else class="detail__hint">登錄後可提交勘誤。</span>
            <span class="detail__hint">只提交已選擇的一項；未選擇即不提交。</span>
          </div>
          <p v-if="faceEntryFeedback[face.id]" class="notice detail__notice" data-face-entry-feedback>
            {{ faceEntryFeedback[face.id] }}
          </p>
        </div>

        <table class="detail__table">
          <thead>
            <tr>
              <th>屬性</th>
              <th>當前展示值</th>
              <th>來源</th>
              <th>待審覈</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in markableOf(face)" :key="`${face.id}-${item.key}`">
              <td>{{ item.label }}</td>
              <td>
                <span class="detail__value">{{ item.display || '未著錄' }}</span>
                <span v-if="item.source === 'CORRECTION'" class="detail__origin">
                  原始值：{{ item.original || '未著錄' }}
                </span>
              </td>
              <td>
                <span v-if="item.source === 'CORRECTION'" class="detail__badge detail__badge--adopted">
                  已採納勘誤（{{ item.acceptedCount }} 條）
                </span>
                <span v-else class="detail__badge">平臺原始數據</span>
              </td>
              <td>{{ item.pendingCount }} 條</td>
            </tr>
          </tbody>
        </table>
        <p class="detail__hint">勘誤不會直接覆蓋原始數據，平臺彙總多條提交後擇可信者對外展示。</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>實物照片</h2>
        <span class="detail__hint">共 {{ gallery.length }} 張</span>
      </div>
      <div class="panel__body">
        <div v-if="gallery.length" class="detail__gallery">
          <figure v-for="photo in gallery" :key="photo.id" class="detail__photo">
            <!-- R-87 / R-88：实拍图按元数据切分（实拍族 8 块）→ 前端拼接展示（按原色）。 -->
            <SliceImage
              v-if="photoUrls[photo.id]"
              :src="photoUrls[photo.id]"
              :row="photo"
              cut-hint="photo"
              alt="印章實物照片"
              :caption="`實拍圖 ${photo.id}`"
              data-photo-slice
            />
            <p v-else class="detail__hint">{{ photoErrors[photo.id] || '正在讀取照片…' }}</p>
            <figcaption>
              {{ formatBytes(photo.bytes) }}<template v-if="photo.mime"> · {{ photo.mime }}</template>
            </figcaption>
          </figure>
        </div>
        <p v-else class="detail__hint">暫無實物照片。</p>

        <div class="detail__upload">
          <label v-if="canUpload" class="btn btn--ghost detail__upload-btn">
            <input type="file" accept="image/*" :disabled="uploading" @change="onPickPhoto" />
            {{ uploading ? '正在處理…' : '上傳實物照片' }}
          </label>
          <button v-else class="btn btn--ghost" type="button" @click="goLogin">登錄後上傳實物照片</button>
          <span class="detail__hint">
            單張上限 1 MB（按原始文件字節數判定）；瀏覽器端自動裁方形，入庫爲 TIFF 影像（單頁 8bit Deflate）；頁面預覽以 WebP 呈現。
          </span>
          <!-- 上传端接新管线的**可读降级提示**（Kong-I2 就绪后自动消失，界面零噪声）。 -->
          <span v-if="photoPipelineNotice" class="detail__hint" data-pipeline-degraded="photo-upload">
            {{ photoPipelineNotice }}
          </span>
          <span v-if="uploadFeedback" class="detail__hint">{{ uploadFeedback }}</span>
        </div>
      </div>
    </section>

    <FaceFixedAttributesDialog
      v-if="editingFace"
      :face="editingFace"
      :seal="seal"
      @close="editingFaceId = ''"
      @saved="onFixedSaved"
    />

    <!-- 管理员专属弹窗：编辑**印章级**固定属性（形制）。
         弹窗内提交钮用 `data-action`（**不得**复用 `data-admin-action`，否则取值集合会被撑破）。 -->
    <div
      v-if="sealAttrsOpen"
      class="seal-attr-mask"
      role="dialog"
      aria-modal="true"
      aria-label="編輯印章屬性"
      data-admin-dialog="edit-seal-attributes"
    >
      <div class="seal-attr-box">
        <h3 class="seal-attr-box__title">編輯印章屬性 · {{ seal.seal_name || '佚名' }}</h3>
        <p class="seal-attr-box__lede">
          藏品編號 {{ seal.stamp_id }}。形制與材質都是印章級固定屬性（整枚印章各一個）：
          自由文本、不強制枚舉、不參與廣場篩選。留空即清除已有值（改爲「未設置」）。
        </p>

        <div class="field">
          <label for="seal-shape-input">形制</label>
          <input
            id="seal-shape-input"
            v-model="shapeDraft"
            type="text"
            placeholder="例：方形／長方形／圓形／隨形"
            data-seal-shape-input
          />
          <!-- 三動作轉換（R-73/R-74/R-75）：印章級固定屬性同屬自由文本、同口徑接上。 -->
          <TextTransformButtons v-model="shapeDraft" field-key="seal-attributes:shape" field-label="形制" />
        </div>

        <div class="field">
          <label for="seal-material-input">材質</label>
          <input
            id="seal-material-input"
            v-model="materialDraft"
            type="text"
            placeholder="例：青田石／青銅"
            data-seal-material-input
          />
          <TextTransformButtons v-model="materialDraft" field-key="seal-attributes:material" field-label="材質" />
          <span class="field__hint">
            材質自 R-32 起爲「印章級」固定屬性（印面級對話框已不再含此字段）；
            舊行的印面級舊值保留不改寫。
          </span>
        </div>

        <p v-if="sealAttrsFeedback" class="seal-attr-box__feedback" data-admin-feedback="seal-attributes-dialog">
          {{ sealAttrsFeedback }}
        </p>

        <div class="seal-attr-box__foot">
          <button class="btn btn--ghost" type="button" @click="closeSealAttributes()">取消</button>
          <button
            class="btn btn--primary"
            type="button"
            data-action="edit-seal-attributes-submit"
            @click="submitSealAttributes"
          >
            保存
          </button>
        </div>
      </div>
    </div>

    <!-- 管理员专属弹窗：替换**本印面**的印面图（每块一个按钮；与「上传印章」同一取景交互口径）。 -->
    <div
      v-if="replaceFace"
      class="replace-face-mask"
      role="dialog"
      aria-modal="true"
      aria-label="重新上傳印面圖"
      data-admin-dialog="replace-face-image"
    >
      <div class="replace-face-box">
        <h3 class="replace-face-box__title">重新上傳印面圖 · {{ faceLabel(replaceFace) }}</h3>
        <p class="replace-face-box__lede">
          印面編號 {{ replaceFace.id }} · 當前影像編號 {{ replaceFace.face_image_id || '（暫無）' }}。
          替換會**新增**一張影像並把本印面指向新影像，**舊影像與二進制保留**（不刪除，可回溯）。
          處理全部在本機完成：方形取景 → 入庫爲 TIFF 影像（單頁 8bit Deflate）→ 寫入本地影像庫；頁面預覽以 WebP 呈現，不訪問任何外部地址。
        </p>

        <div class="field">
          <label for="replace-face-image-input">印面圖</label>
          <input
            id="replace-face-image-input"
            type="file"
            accept="image/*"
            data-replace-face-input
            :disabled="replaceBusy"
            @change="onPickReplaceImage"
          />
          <span class="field__hint">
            本機圖片文件（JPG / PNG / WebP），單張不超過 <b>{{ limitLabel }}</b>（{{ IMAGE_LIMITS.maxInputBytes }} 字節，
            按原始文件字節數判定）。選定後在本機取方形，入庫爲 TIFF 影像（單頁 8bit Deflate）；頁面預覽以 WebP 呈現。
          </span>

          <div v-if="replaceSource" class="replace-cropper" data-replace-face-preview="seal-face">
            <div class="replace-cropper__view" :style="{ width: `${replaceGeom.viewW}px`, height: `${replaceGeom.viewH}px` }">
              <img v-if="replaceSource.previewUrl" class="replace-cropper__img" :src="replaceSource.previewUrl" alt="印面圖預覽" />
              <div v-else class="replace-cropper__img replace-cropper__img--missing">預覽不可用（原圖仍可處理）</div>
              <div
                v-if="replaceFrameStyle"
                class="replace-cropper__frame"
                data-crop-frame="replace-face-image"
                :style="replaceFrameStyle"
                @pointerdown="startReplaceDrag($event, 'move')"
                @pointermove="onReplaceDragMove"
                @pointerup="endReplaceDrag"
                @pointercancel="endReplaceDrag"
              >
                <span
                  class="replace-cropper__handle"
                  data-crop-handle="replace-face-image"
                  @pointerdown.stop="startReplaceDrag($event, 'resize')"
                  @pointermove="onReplaceDragMove"
                  @pointerup="endReplaceDrag"
                  @pointercancel="endReplaceDrag"
                ></span>
              </div>
            </div>
            <p class="replace-cropper__hint">拖動方框移動取景；拖右下角方塊縮放方框。方框內即爲入庫的印面。</p>
            <button class="btn btn--ghost replace-cropper__reset" type="button" @click="resetReplaceCrop">恢復居中方框</button>
            <p class="replace-cropper__summary" data-replace-face-summary>
              已選 {{ replaceSource.name }} · 原圖 {{ replaceSource.width }} × {{ replaceSource.height }} · 原文件 {{ formatBytes(replaceSource.originalBytes) }}
              ⇒ 入庫印面
              <template v-if="replaceExported">
                {{ replaceExported.width }} × {{ replaceExported.height }} · {{ replaceExported.mime }} · {{ describeBytes(replaceExported.bytes.length) }}
              </template>
              <template v-else>處理中…</template>
              （最長邊 ≤ {{ maxSideLabel }}、質量 {{ IMAGE_LIMITS.quality }}）
            </p>
          </div>
          <span v-else class="field__hint">選擇本機圖片文件（JPG / PNG / WebP），不上傳任何外部地址。</span>
        </div>

        <p v-if="replaceFeedback" class="replace-face-box__feedback" data-admin-feedback="replace-face-dialog">
          {{ replaceFeedback }}
        </p>

        <div class="replace-face-box__foot">
          <button class="btn btn--ghost" type="button" @click="closeFaceImageReplace()">取消</button>
          <button
            class="btn btn--primary"
            type="button"
            data-action="replace-face-image-submit"
            :disabled="replaceBusy"
            @click="submitReplaceFaceImage"
          >
            {{ replaceBusy ? '正在替換…' : '確認替換' }}
          </button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-if="downloadOpen"
      title="下載高清原圖"
      :message="`本次下載將扣除 ${downloadCost} 金；同一枚印章在本次會話內只扣費一次。`"
      :detail="quoteDetail"
      hint="下載件爲該印面在本機存儲的原檔字節（不加水印、不轉碼），下載後即與存檔件做摘要核對。"
      confirm-text="確認下載"
      @confirm="confirmDownload"
      @cancel="downloadOpen = false"
    />

    <div v-if="formOpen" class="correction-mask" role="dialog" aria-modal="true" aria-label="提交勘誤">
      <div class="correction-box">
        <h3 class="correction-box__title">提交勘誤</h3>
        <p class="correction-box__lede">
          勘誤對象：{{ formFaceLabel }}。只需填寫要更正的項目，留空的項目不會被提交。
        </p>

        <!-- 可标记属性：**按字段提供按需渲染器**（R-20 / R-30 / R-31 / R-43）。
             - 朝代 ⇒ 封闭选择框（真源 `DYNASTY_OPTIONS`，14 类）；
             - 【印面内容】⇒ 封闭选择框（真源 `FACE_CONTENT_OPTIONS`，9 值）；
             - 【印面风格】⇒ 封闭选择框（真源 `FACE_STYLE_OPTIONS`，23 值）；
             - **边款（EDGE）印面不呈现【印面内容】/【印面风格】**（R-37 / R-43）；
               其余可标记字段（印文简体字 / 印文古字 / 作者 / 印文释义）**保持现状**（自由文本）。
             - 留空 ⇒ 该项不提交。 -->
        <template v-for="item in corrections.MARKABLE_FIELDS" :key="item.key">
          <div v-if="correctionFieldVisible(item)" class="field">
            <label :for="`cr-${item.key}`">{{ item.label }}</label>
            <select
              v-if="item.key === 'dynasty'"
              :id="`cr-${item.key}`"
              v-model="form[item.key]"
              data-dynasty-select="correction"
            >
              <option v-for="d in dynastyOptions" :key="d" :value="d">{{ d }}</option>
            </select>
            <select
              v-else-if="item.key === FACE_CONTENT_KEY"
              :id="`cr-${item.key}`"
              v-model="form[item.key]"
              data-face-content-select="correction"
            >
              <option v-for="c in faceContentOptions" :key="c" :value="c">{{ c }}</option>
            </select>
            <select
              v-else-if="item.key === FACE_STYLE_KEY"
              :id="`cr-${item.key}`"
              v-model="form[item.key]"
              data-face-style-select="correction"
            >
              <option v-for="s in faceStyleOptions" :key="s" :value="s">{{ s }}</option>
            </select>
            <input
              v-else
              :id="`cr-${item.key}`"
              v-model="form[item.key]"
              type="text"
              :placeholder="`填寫你認爲正確的${item.label}`"
            />
            <!-- 三動作轉換（R-73/R-74/R-75）：**只給自由文本字段**
                 （封閉選擇框＝朝代 /【印面內容】/【印面風格】不加 ⇒ `correctionFieldIsFreeText`；
                 邊款（EDGE）側不呈現的那兩項因此天然不受影響）。 -->
            <TextTransformButtons
              v-if="correctionFieldIsFreeText(item.key)"
              v-model="form[item.key]"
              :field-key="`correction:${item.key}`"
              :field-label="item.label"
            />
            <span v-if="item.key === 'dynasty'" class="field__hint">
              朝代固定 14 類（本框共 {{ dynastyOptions.length }} 項），只可選不可填；不填即不提交該項。
            </span>
            <span
              v-else-if="item.key === FACE_CONTENT_KEY"
              class="field__hint"
            >
              【印面內容】固定 9 類（本框共 {{ faceContentOptions.length }} 項），只可選不可填；不填即不提交該項。
              本印面當前展示值：{{ faceMarkableValue(formFace, FACE_CONTENT_KEY, formFace && formFace.seal_type) || '未著錄' }}。
            </span>
            <span v-else-if="item.key === FACE_STYLE_KEY" class="field__hint">
              【印面風格】固定 23 類（本框共 {{ faceStyleOptions.length }} 項），只可選不可填；不填即不提交該項。
              本印面當前展示值：{{ faceMarkableValue(formFace, FACE_STYLE_KEY, formFace && formFace.face_style) || '未著錄' }}。
            </span>
            <span v-if="item.key === 'dynasty' && !DYNASTY_READY" class="field__hint" data-dynasty-degraded="correction">
              {{ DYNASTY_MISSING_MESSAGE }}
            </span>
            <span v-if="item.key === FACE_CONTENT_KEY && !FACE_CONTENT_READY" class="field__hint" data-face-content-degraded="correction">
              {{ FACE_CONTENT_MISSING_MESSAGE }}
            </span>
            <span v-if="item.key === FACE_STYLE_KEY && !FACE_STYLE_READY" class="field__hint" data-face-style-degraded="correction">
              {{ FACE_STYLE_MISSING_MESSAGE }}
            </span>
          </div>
        </template>

        <div class="field">
          <label for="cr-basis">勘誤依據（選填）</label>
          <textarea id="cr-basis" v-model="form.basis" placeholder="可填寫著錄出處、比對印譜或旁證材料" />
          <TextTransformButtons v-model="form.basis" field-key="correction:basis" field-label="勘誤依據" />
        </div>

        <p v-if="formFeedback" class="correction-box__feedback">{{ formFeedback }}</p>

        <div class="correction-box__foot">
          <button class="btn btn--ghost" type="button" @click="formOpen = false">取消</button>
          <button class="btn btn--primary" type="button" @click="submitCorrection">提交勘誤</button>
        </div>
      </div>
    </div>

    <!-- 保存入口②的轻量选择器（与入口①**同一个组件**；保存必经选择器，不静默存入）。 -->
    <SealFolderPicker
      v-if="saveOpen"
      :seal-id="seal.stamp_id"
      :seal-name="seal.seal_name"
      @close="saveOpen = false"
      @saved="onDriveSealSaved"
    />
  </section>

  <!-- **資料尚未到位（硬導航首屏）⇒ 載入態**：水合未完成時**不得**顯示「未找到這枚印章」
       這類終態（它是在斷言一件還沒讀到的事）。水合落定後本元件自動重算。 -->
  <PlaceholderPanel
    v-else-if="sealLoading"
    glyph="候"
    title="正在讀取藏品資料"
    desc="雲端藏品資料載入中，就緒後會自動顯示這枚印章。"
  />
  <!-- **雲端讀取失敗（已回落本機示範資料）⇒ 可重試的失敗態**：同樣不宣稱「這枚印章不存在」
       —— 此刻資料源是本地示範集，判不出雲端的真實歸屬。重試走數據層既有那一輪水合。 -->
  <PlaceholderPanel
    v-else-if="sealUnavailable"
    glyph="阻"
    title="藏品資料暫時無法讀取"
    desc="雲端資料暫時未能讀取（目前顯示的是本機示範資料），無法確認這枚印章是否存在。"
  >
    <button class="btn btn--ghost" type="button" @click="retryDataSource">重新讀取</button>
  </PlaceholderPanel>
  <PlaceholderPanel
    v-else
    glyph="空"
    title="未找到這枚印章"
    desc="它可能已被移出藏品，或編號有誤。"
  >
    <router-link class="btn btn--ghost" :to="{ name: 'square' }">返回藏品廣場</router-link>
  </PlaceholderPanel>
</template>

<style scoped>
.detail__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-4);
}

/* 詳情頁操作钮（v1.21 追加：下載鈕旁並列「存入雲盤」；两钮同行不换行即自适应换行）。 */
.detail__acts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
}

.detail__tag {
  display: inline-block;
  margin-right: var(--s-2);
  padding: 1px var(--s-2);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-sm);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.detail__tag--era {
  background: var(--c-brand);
  border-color: var(--c-brand);
  color: var(--slot-tag-text);
}

.detail__tag--edge {
  background: var(--c-gold-soft);
  border-color: var(--c-gold);
  color: var(--c-gold-strong);
}

.detail__id {
  display: inline-block;
  margin-right: var(--s-3);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.detail__notice {
  margin-bottom: var(--s-4);
}

.detail__lede {
  margin-bottom: var(--s-4);
}

.face-block__title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--s-2);
}

.face-block__badge {
  padding: 1px var(--s-2);
  border: 1px solid var(--c-brand);
  border-radius: var(--r-sm);
  background: var(--c-brand);
  color: var(--slot-badge-text);
  font-size: var(--t-xs);
  font-weight: 600;
}

.face-block__badge--edge {
  background: var(--c-gold-soft);
  border-color: var(--c-gold);
  color: var(--c-gold-strong);
}

.face-block__name {
  font-size: var(--t-lg);
  color: var(--c-text);
}

.face-block__id {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

/* 管理员按钮组（编辑固定属性 / 重新上传印面图）：同一行右对齐。 */
.face-block__admin-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--s-2);
}

.face-block__sub {
  margin: var(--s-4) 0 var(--s-3);
  padding-bottom: var(--s-1);
  border-bottom: 1px solid var(--c-line);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
  font-weight: 500;
}

.face-block__sub:first-child {
  margin-top: 0;
}

.face-block__sub-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--s-3);
  margin-bottom: var(--s-3);
}

/* 【印面内容】/【印面风格】封闭选择框的容器（**仅印面块**呈现）。 */
.face-entry {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3) var(--s-5);
  margin: var(--s-2) 0 var(--s-4);
  padding: var(--s-3) var(--s-4);
  background: var(--c-surface-sunken);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
}

.face-entry .field {
  flex: 1 1 220px;
  min-width: 0;
}

.face-entry__foot {
  flex: 1 1 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--s-3);
}

.face-block__media {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3);
  margin-top: var(--s-3);
}

.face-block__figure {
  margin: 0;
  padding: var(--s-3);
  min-width: 220px;
  background: var(--c-surface-sunken);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.face-block__figure-title,
.face-block__figure figcaption {
  margin-bottom: var(--s-1);
  color: var(--c-text);
  font-size: var(--t-sm);
}

.face-block__img {
  display: block;
  width: 100%;
  max-width: 320px;
  margin: var(--s-2) 0;
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
  background: var(--c-surface);
  object-fit: contain;
}

.face-block__empty {
  padding: var(--s-2) var(--s-3);
  background: var(--c-gold-soft);
  border: 1px solid var(--c-gold);
  border-radius: var(--r-md);
  color: var(--c-gold-strong);
  font-size: var(--t-xs);
}

.detail__fixed {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--s-3);
  font-size: var(--t-sm);
}

.detail__fixed div {
  display: flex;
  gap: var(--s-3);
}

.detail__fixed dt {
  flex: 0 0 92px;
  color: var(--c-text-muted);
}

.detail__fixed dd {
  margin: 0;
  color: var(--c-text);
}

.detail__hint {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.detail__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--t-sm);
}

.detail__table th,
.detail__table td {
  padding: var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--c-line);
  text-align: left;
  vertical-align: top;
}

.detail__table th {
  color: var(--c-text-muted);
  font-weight: 500;
}

.detail__value {
  display: block;
  color: var(--c-text);
}

.detail__origin {
  display: block;
  margin-top: var(--s-1);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.detail__badge {
  display: inline-block;
  padding: 1px var(--s-2);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-sm);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
  white-space: nowrap;
}

.detail__badge--adopted {
  background: var(--c-gold-soft);
  border-color: var(--c-gold);
  color: var(--c-gold-strong);
}

.detail__gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--s-3);
}

.detail__photo {
  margin: 0;
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--c-surface-sunken);
}

.detail__photo img {
  display: block;
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
}

.detail__photo figcaption {
  padding: var(--s-1) var(--s-2);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.detail__upload {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  margin-top: var(--s-4);
}

.detail__upload-btn {
  position: relative;
  overflow: hidden;
}

.detail__upload-btn input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.detail__sha {
  font-family: var(--font-sans);
}

.correction-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-overlay);
  overflow: auto;
}

.correction-box {
  width: 100%;
  max-width: 520px;
  max-height: 88vh;
  overflow: auto;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.correction-box__title {
  margin-bottom: var(--s-2);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.correction-box__lede {
  margin-bottom: var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.correction-box__feedback {
  margin-bottom: var(--s-3);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
}

.correction-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
}

/* ------------------ 重新上传印面图：弹窗与取景框（与「上传印章」同口径） ------------------ */

.replace-face-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-overlay);
  overflow: auto;
}

.replace-face-box {
  width: 100%;
  max-width: 520px;
  max-height: 88vh;
  overflow: auto;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.replace-face-box__title {
  margin-bottom: var(--s-2);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.replace-face-box__lede {
  margin-bottom: var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.replace-face-box__feedback {
  margin-top: var(--s-3);
  margin-bottom: var(--s-3);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
}

.replace-face-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
}

.replace-cropper {
  margin-top: var(--s-3);
}

.replace-cropper__view {
  position: relative;
  max-width: 100%;
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--c-surface-sunken);
  touch-action: none;
  user-select: none;
}

.replace-cropper__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  -webkit-user-drag: none;
}

.replace-cropper__img--missing {
  display: grid;
  place-items: center;
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.replace-cropper__frame {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid var(--slot-gold-text);
  box-shadow: 0 0 0 9999px var(--c-mask-strong);
  cursor: move;
  touch-action: none;
}

.replace-cropper__handle {
  position: absolute;
  right: -7px;
  bottom: -7px;
  width: 16px;
  height: 16px;
  background: var(--c-surface);
  border: 2px solid var(--slot-gold-text);
  border-radius: 3px;
  cursor: nwse-resize;
  touch-action: none;
}

.replace-cropper__hint {
  margin-top: var(--s-2);
  color: var(--c-text-muted);
  font-size: var(--t-xs, var(--t-sm));
}

.replace-cropper__reset {
  margin-top: var(--s-2);
}

.replace-cropper__summary {
  margin-top: var(--s-2);
  color: var(--c-text);
  font-size: var(--t-sm);
}

/* ------------------ 印章级固定属性区 + 「编辑印章属性」弹窗（本单新增） ------------------ */

.seal-attrs {
  margin-bottom: var(--s-4);
}

.seal-attr-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-overlay);
  overflow: auto;
}

.seal-attr-box {
  width: 100%;
  max-width: 520px;
  max-height: 88vh;
  overflow: auto;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.seal-attr-box__title {
  margin-bottom: var(--s-2);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.seal-attr-box__lede {
  margin-bottom: var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.seal-attr-box__feedback {
  margin-top: var(--s-3);
  margin-bottom: var(--s-3);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
}

.seal-attr-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
}
</style>
