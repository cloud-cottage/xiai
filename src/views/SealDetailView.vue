
<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AddSealFaceDialog from '../components/AddSealFaceDialog.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import FaceFixedAttributesDialog from '../components/FaceFixedAttributesDialog.vue'
import PlaceholderPanel from '../components/PlaceholderPanel.vue'
import SealFolderPicker from '../components/SealFolderPicker.vue'
import TextTransformButtons from '../components/TextTransformButtons.vue'
import SliceImage from '../components/SliceImage.vue'
import { pipelineNotice, runUploadPipeline } from '../components/uploadPipeline.js'
import { seals, corrections, endorsements, persons, photos as photoService, points, imageFaces, sealExport, aiEnhance, authorMatch, sealCards } from '../services/index.js'
import { DYNASTY_OPTIONS, FACE_CONTENT_OPTIONS, FACE_STYLE_OPTIONS, SEAL_CLASS_OPTIONS } from '../data/seed.js'
import { isLoggedIn, currentUser } from '../data/session.js'
import { formatBytes } from '../utils/format.js'
import { saveLocalBinary } from '../utils/file.js'
import { IMAGE_LIMITS, MIN_CROP_SIDE, describeBytes, exportSquareImage, loadImageFile } from '../utils/image.js'
/* 剪贴板一键粘贴图片（共用纯函数）：实物照片与替换印面图两处上传面共用判定内核。 */
import { PASTE_HINT, handleClipboardPaste } from '../utils/clipboardImage.js'
/* 受控诊断面（`?diag=1`）：读 / 写形态字符串的唯一判据（与 `MyCorrectionsView` 同一真源；
   同文件的直接引用先例见 `MyCorrectionsView.vue` 的 `isLocalImportFace`）。 */
import { diagFaceMode } from '../data/writeFaceMode.js'

const route = useRoute()
const router = useRouter()

/* ========================================================================
   **受控诊断面（`?diag=1`）**：仅 URL 带 `diag=1` 时渲染（无该参数 ⇒ `v-if` 恒
   false ⇒ DOM 零命中、零行为变化）。面板只读：不发请求、不写存储、不定时轮询。
   ======================================================================== */
const diagOn = computed(() => String(route.query.diag || '') === '1')
/** 服务层写完一条里程碑后 +1 ⇒ 面板重读观测缓冲（**无定时器**）。 */
const diagTick = ref(0)
/** 最近 20 条里程碑（服务层 `correctionsReadout()`，从旧到新）。 */
const diagLines = computed(() => {
  void diagTick.value
  return corrections.correctionsReadout()
})
/** 当前读 / 写形态（`cloud` / `local-dev` …）。 */
const diagMode = computed(() => diagFaceMode())
/** 主包文件名（`index-<hash>.js`）；取不到写 `unknown`（**不编造**）。 */
const diagBundle = computed(() => {
  void diagTick.value
  try {
    const script = document.querySelector('script[src*="/assets/index-"]')
    if (script) {
      const match = String(script.getAttribute('src') || '').match(/\/assets\/([^/?#]+)/)
      if (match) return match[1]
    }
    const entries = (typeof performance !== 'undefined' && performance.getEntriesByType('resource')) || []
    for (const entry of entries) {
      const name = String((entry && entry.name) || '')
      const bundle = name.match(/\/assets\/(index-[^/?#]+)/)
      if (bundle) return bundle[1]
      /* dev 形态没有 `/assets/index-*.js` ⇒ 主包是入口 `/src/main.js`（只认入口，不逐模块）。 */
      if (/\/src\/main\.js(?:[?#]|$)/.test(name)) return 'main.js'
    }
  } catch (err) {
    /* 取不到就写 unknown；诊断面永不抛错。 */
  }
  return 'unknown'
})
/** 「复制到剪贴板」的全文（包名 ＋ 形态 ＋ 里程碑）。 */
const diagText = computed(
  () => `bundle=${diagBundle.value}\nmode=${diagMode.value}\n${diagLines.value.join('\n')}`
)
/** 一键复制（`navigator.clipboard.writeText`；失败**不报错**、不上屏）。 */
async function copyDiagText() {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(diagText.value)
    }
  } catch (err) {
    /* 复制失败静默；诊断面零副作用。 */
  }
}

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

/* ============================================================================
   **瀏覽量計數（裁定件 §6 / §7｜本單）**
   ----------------------------------------------------------------------------
   · 觸發點：印章**真實解析成功**（`seal` 非空且帶 `stamp_id`）後**一次** —— 熱導航 / 水合落定
     使 `seal` 由 `null` 變有值時才觸發（這正是「打開即 +1」的時刻；硬導航首屏 `seal` 為空 ⇒ 不計）。
   · **只發一次**：`sealViewBumpedStampId` 記住已計過的編號 ⇒ 依賴面抖動（`dataVersion` / 屬性保存 /
     影像載入）**不會**重複發。
   · **靜默**：不上屏、不阻塞渲染、不改既有錯誤態、不 `console.error`；去重與降級都在服務層
     （`sealCards.bumpSealView` 永不拋出），本頁**零文案**。
   ============================================================================ */
let sealViewBumpedStampId = ''
watch(
  () => (seal.value ? String(seal.value.stamp_id || '').trim() : ''),
  (stampId) => {
    const id = stampId ? String(stampId) : ''
    if (!id || id === sealViewBumpedStampId) return
    sealViewBumpedStampId = id
    /* 計數是副作用：不 await（不拖渲染）、不改本頁任何狀態（結果無需上屏）。 */
    void sealCards.bumpSealView(id)
  },
  { immediate: true }
)

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

/* ============================================================================ *
   **逐影像 dataUrl 缓存的**作废口**（服务层唯一失效口登记）**
   ----------------------------------------------------------------------------
   · 本页持有的 dataUrl 缓存 = `imageUrls`（dataURL）＋ `imageVias`（分流读数）＋
     `imageErrors` / `imagePending`（一次性读数）—— 一律**按影像编号**作废。
   · 登记给 `seals.invalidateImageDataUrl(id)`：任何写面（**採納 AI 候選圖** / **刪除印面影像**）
     成功后按编号调一次 ⇒ 旧编号缓存立即失效、下次必重取（**不刷整页**）。
   · 组件卸载时注销（`onBeforeUnmount`），不给服务层留悬挂引用。
   ============================================================================ */
const unregisterImageDataUrlCache = seals.registerImageDataUrlCacheHolder((imageId) => {
  const id = String(imageId || '')
  if (!id) return
  delete imageUrls[id]
  delete imageVias[id]
  delete imageErrors[id]
  delete imagePending[id]
})

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
   **刪除印章（管理员面｜本单）**
   ----------------------------------------------------------------------------
   · 渲染条件＝服务层判定 `seals.canDeleteSeal`（普通用户 / 游客 ⇒ false ⇒ 不渲染，
     DOM 零命中；**不得** CSS 隐藏 / `disabled` 冒充）；钩子只用 `data-action="seal-delete"`
     （**不新增 `data-admin-action` 取值**，管理员钩子取值集合仍为规范冻结值）。
   · 二次确认复用 `ConfirmDialog`（显式、可取消、默认不通过）：文案**必须列明**
     将删印面数 / 影像数、**不可恢复**、**編號將被釋放**；可选理由 ≤200 字。
   · 成功 ⇒ 跳回广场（`/`）并带**一次性**提示（`?notice=seal-deleted`）；失败 ⇒ 本页上屏。
   ============================================================================ */
const canDeleteSeal = computed(() => seals.canDeleteSeal())
const sealDeleteOpen = ref(false)
const sealDeleteBusy = ref(false)
const sealDeleteReason = ref('')
const sealDeleteFeedback = ref('')

/** 本印引用的影像编号数（去重；印面图 ＋ 边款图）——**仅上屏读数**；实际删数以服务端回包为准。 */
const sealDeleteImageCount = computed(() => {
  const ids = new Set()
  faces.value.forEach((face) => {
    if (face.face_image_id) ids.add(String(face.face_image_id))
    ;(face.edge_image_ids || []).forEach((id) => {
      if (id) ids.add(String(id))
    })
  })
  return ids.size
})

/** 二次确认主文案（**必须列明**：印面数 / 影像数、不可恢复、編號將被釋放）。 */
const sealDeleteMessage = computed(
  () =>
    `將刪除本印的 ${faces.value.length} 個印面、${sealDeleteImageCount.value} 張影像（仍被其他印面共用者保留）；刪後不可恢復，印章與印面編號將被釋放。`
)

/** 打开二次确认（每次打开重置可选理由与旧反馈）。 */
function openSealDelete() {
  sealDeleteReason.value = ''
  sealDeleteFeedback.value = ''
  sealDeleteOpen.value = true
}

/** 确认刪除：过服务层管理员写面门；成功 ⇒ 跳广场并带一次性提示，失败 ⇒ 本页上屏。 */
async function confirmSealDelete() {
  if (sealDeleteBusy.value) return
  const target = seal.value
  const stampId = target ? String(target.stamp_id || '') : ''
  if (!stampId) {
    sealDeleteOpen.value = false
    sealDeleteFeedback.value = '未能取得本印編號（seal_id），本次零寫入。'
    return
  }
  sealDeleteBusy.value = true
  let result = null
  try {
    result = await seals.deleteSeal(null, stampId, sealDeleteReason.value)
  } catch {
    result = { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '刪除印章服務暫時不可用，請稍後再試。' }
  }
  sealDeleteBusy.value = false
  sealDeleteOpen.value = false
  if (!result || result.ok !== true) {
    sealDeleteFeedback.value = (result && result.message) || '刪除印章失敗，本次零寫入。'
    return
  }
  const nav = router.push({ name: 'square', query: { notice: 'seal-deleted' } })
  if (nav && typeof nav.catch === 'function') nav.catch(() => {})
}

/* ============================================================================ *
   **刪除印面影像（管理員面｜影像卡片入口｜本單）
   ----------------------------------------------------------------------------
   · Kevin 2026-11-07 定案：旧图**不自动删**；普通用户的【勘误】提交是下一轮，本单只做
     **管理员在影像卡片直接【刪除】**（云 op `deleteFaceImage`）。
   · 渲染条件＝服务层判定 `seals.canDeleteFaceImage`（普通用户 / 游客 ⇒ false ⇒ 不渲染，
     DOM 零命中；**不得** CSS 隐藏 / `disabled` 冒充）；钩子只用 `data-action="image-delete"`
     （**不新增 `data-admin-action` 取值**，管理员钩子取值集合仍为规范冻结值）。
   · 二次确认复用 `ConfirmDialog`（显式、可取消、默认不通过）：文案**必须列明**
     「刪除後該印面將無影像、不可恢復、物件一並刪除」。
   · 成功 ⇒ **就地刷新**（作废该编号 dataUrl 缓存 ＋ `dataVersion + 1` ＋ 云端快照重读
     `retryDataSource()`），**不刷整页**；失败 ⇒ 本页上屏（服务端原话一字不改写）。
   ============================================================================ */
const canDeleteFaceImage = computed(() => seals.canDeleteFaceImage())
const faceImageDeleteOpen = ref(false)
const faceImageDeleteBusy = ref(false)
const faceImageDeleteFeedback = ref('')
/** 待删目标 `{faceId, imageId}`（关窗即清，避免残留指向）。 */
const faceImageDeleteTarget = ref(null)

/** 二次确认主文案（**必须列明**：刪除後該印面將無影像、不可恢復、物件一並刪除）。 */
const faceImageDeleteMessage = computed(() => {
  const target = faceImageDeleteTarget.value
  if (!target) return '刪除本印面的影像。'
  return (
    `將刪除本印面（${target.faceId}）的影像編號 ${target.imageId}；` +
    '刪除後該印面將無影像、不可恢復，影像物件一並刪除。' +
    '（該影像若仍被其他印面引用，服務端會拒絕刪除並保持原狀。）'
  )
})

/** 打开二次确认（每次打开重置旧反馈）。 */
function openFaceImageDelete(face) {
  const imageId = face && face.face_image_id ? String(face.face_image_id) : ''
  if (!imageId) {
    faceImageDeleteFeedback.value = '本印面沒有影像編號，無從刪除。'
    return
  }
  faceImageDeleteFeedback.value = ''
  faceImageDeleteTarget.value = { faceId: String(face.id), imageId }
  faceImageDeleteOpen.value = true
}

/** 确认刪除：过服务层管理员写面门；成功 ⇒ 就地刷新，失败 ⇒ 本页上屏。 */
async function confirmFaceImageDelete() {
  if (faceImageDeleteBusy.value) return
  const target = faceImageDeleteTarget.value
  if (!target) {
    faceImageDeleteOpen.value = false
    return
  }
  faceImageDeleteBusy.value = true
  let result = null
  try {
    result = await seals.deleteFaceImage(target.faceId, target.imageId)
  } catch {
    result = { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '刪除印面影像服務暫時不可用，請稍後再試。' }
  }
  faceImageDeleteBusy.value = false
  faceImageDeleteOpen.value = false
  faceImageDeleteTarget.value = null
  if (!result || result.ok !== true) {
    /* 失败：服务端 `message` **原文上屏**（不吞真因、不改写）。 */
    faceImageDeleteFeedback.value = (result && result.message) || '刪除印面影像失敗，本次零寫入。'
    return
  }
  faceImageDeleteFeedback.value =
    `已刪除影像編號 ${result.image_id}（刪行 ${result.removed.rows} 件、刪對象 ${result.removed.objects} 件）；` +
    '該印面已無影像，舊影像不再顯示。'
  /* **就地刷新（不刷整页）**：作废该编号缓存（服务层单点）＋ 派生读数重算 ＋ 云端快照重读
     （印面指向由服务端清空 ⇒ 必须重读云端才不再指向已删影像）。 */
  seals.invalidateImageDataUrl(target.imageId)
  dataVersion.value += 1
  retryDataSource()
}

/* ============================================================================ *
   **普通用戶影像勘誤（§3.77）：并入合并弹窗的「影像」页签（本單：两个勘誤入口合一）
   ---------------------------------------------------------------------------- · **入口合一**：页面上只留「可標記屬性」区那一枚【勘誤】（字段勘误入口）；影像卡上的
     独立【勘誤】钮已撤，影像操作改在**同一弹窗的「影像」页签**内完成（默认停在「屬性」）。
     登录态判定不变（服务层 `seals.canSubmitCorrection()` ⇒ `canSubmit`；游客 ⇒ 页面入口不渲染、
     DOM 零命中；**不得** CSS 隐藏 / `disabled` 冒充）。管理员同样渲染
     （§3.77.1：普通用户【勘誤】与管理员【刪除】两条路径互不替代）。
   · 钩子只用 `data-action="image-correction"`（**不新增 `data-admin-action` 取值**；现挂在
     合并弹窗的「影像」页签钮上）；页签另带 `data-correction-tab="attr" | "image"`；
     弹窗内提交 / 取消钮按 §3.12.1 派生 `image-correction-submit` / `image-correction-cancel`）。
   · 弹窗＝二选一（刪除此影像 / 重新上傳新圖替換）＋ 备注（≤200 字，超限禁用提交并提示）；
     选「替換」必选图：先 `storeArtifactBytes` → `registerFaceImage` 入册拿 `image_id`
     → 才提交勘误；**任一步失败 ⇒ 硬报错、不编造 id、零提交、可重试**。
   · 成功 ⇒ 上屏「已提交影像勘誤（待審覈）」＋ 关弹窗 ＋ `dataVersion + 1`（刷新待审读数）；
     确认前零写入、取消零写入。
   ============================================================================ */
/* **勘誤弹窗页签（本單：两入口合一）** —— 页面上只留「可標記屬性」区那一枚【勘誤】，
   影像勘誤作为弹窗内的第二个页签；`attr` ＝ 屬性（**默认**）、`image` ＝ 影像。 */
const correctionTab = ref('attr')
const imageCorrectionBusy = ref(false)
/** 待勘誤目标 `{faceId, sealId, imageId, kind, label}`（关窗即清，避免残留指向）。 */
const imageCorrectionTarget = ref(null)
const imageCorrectionAction = ref('delete')
const imageCorrectionNote = ref('')
const imageCorrectionFile = ref(null)
/** 弹窗内失败文案（关窗即清；**失败优先、原样上屏**，不被成功文案覆盖）。 */
const imageCorrectionFeedback = ref('')
/** 页面级提示位（关弹窗后仍可见；重开弹窗时作废）。 */
const imageCorrectionNotice = ref('')
/* 提交成功文案（單點）：**明說「採納後才換圖」** —— 普通用戶提交後印面圖不會立刻變，
   不說清楚會被當成「上传/更新失败」（人類 2026-11-07 反饋）。 */
const IMAGE_CORRECTION_SUBMITTED_MESSAGE = '已提交影像勘誤（待審覈）；平臺審覈採納後才會更新印面圖片。'


/** 二次确认后果文案（列明后果；选「替換」按 §3.77.5 明示指向与旧图处置）。 */
const imageCorrectionConsequences = computed(() => {
  if (imageCorrectionAction.value === 'replace') {
    return (
      '審核通過後印面改指新圖、舊圖將被刪除（舊圖仍被其它印面引用時只改指向、不刪舊圖）；' +
      '審核通過前印面指向不改、影像不動。新圖必須先入冊（取得影像編號）才能提交。'
    )
  }
  return (
    '審核通過後刪除該影像：該印面將無影像、影像行與物件一併刪除（不可恢復）；' +
    '審核通過前影像不動、印面指向不改。若該影像仍被其它印面引用，服務端會拒絕刪除並保持原狀。'
  )
})

/** 备注字数（去首尾空白后计；与提交载荷同口径）。 */
const imageCorrectionNoteLength = computed(() => imageCorrectionNote.value.trim().length)
/** 备注超限 ⇒ 禁用提交并提示（**不**用 `maxlength` 硬截断，否则「超限」永不可现）。 */
const imageCorrectionNoteOver = computed(() => imageCorrectionNoteLength.value > corrections.MAX_IMAGE_CORRECTION_NOTE_LENGTH)
/** 已选文件名（未选 ⇒ 空串）。 */
const imageCorrectionFileName = computed(() => (imageCorrectionFile.value ? String(imageCorrectionFile.value.name || '') : ''))
/** 提交禁用：无目标 / 在飞 / 备注超限 / 选「替換」却未选图。 */
const imageCorrectionSubmitDisabled = computed(
  () =>
    !imageCorrectionTarget.value ||
    imageCorrectionBusy.value ||
    imageCorrectionNoteOver.value ||
    (imageCorrectionAction.value === 'replace' && !imageCorrectionFile.value)
)
/** 弹窗导语（目标读数；关窗时安全返回空串）。 */
const imageCorrectionLede = computed(() => {
  const target = imageCorrectionTarget.value
  if (!target) return ''
  return (
    `勘誤對象：${target.label}（影像編號 ${target.imageId}）。` +
    '提交後為「待審覈」，管理員審覈通過後才會生效；審核前影像與印面指向都不變。'
  )
})

/**
 * 装填影像勘誤目标（**登录门 / 空 id 判定与重置面逐字沿用**原入口，只把「开哪扇窗」
 * 交回调用方 ⇒ 合并弹窗的「影像」页签与原影像卡入口共用同一份装填逻辑）。
 * 成功 ⇒ 返回 `true`（目标 / 动作 / 备注 / 选图 / 旧反馈已清场）；否则返回 `false`。
 */
function prepareImageCorrection(face, imageId, kind) {
  const id = imageId ? String(imageId) : ''
  if (!id) {
    imageCorrectionNotice.value = '本印面沒有影像編號，無從提交影像勘誤。'
    return false
  }
  if (!canSubmit.value) {
    /* 游客不渲染入口（真条件）；此处兜底只作登录引导，不静默失败。 */
    goLogin()
    return false
  }
  const sealId = face && face.sealId ? String(face.sealId) : seal.value ? String(seal.value.stamp_id || '') : ''
  imageCorrectionTarget.value = {
    faceId: String(face && face.id ? face.id : ''),
    sealId,
    imageId: id,
    kind: kind === seals.FACE_KIND.EDGE ? seals.FACE_KIND.EDGE : seals.FACE_KIND.FACE,
    label: face ? faceLabel(face) : ''
  }
  imageCorrectionAction.value = 'delete'
  imageCorrectionNote.value = ''
  imageCorrectionFile.value = null
  imageCorrectionFeedback.value = ''
  imageCorrectionNotice.value = ''
  return true
}

/** 关闭弹窗（成功 / 取消共用；**零写入**）。合并后两页签共用同一扇窗 ⇒ 一并落回「屬性」页签。 */
function closeImageCorrection() {
  if (imageCorrectionBusy.value) return
  formOpen.value = false
  correctionTab.value = 'attr'
  imageCorrectionTarget.value = null
  imageCorrectionFeedback.value = ''
  imageCorrectionFile.value = null
}

/** 选图（本机文件；只登记，**零上传、零写入**）。 */
function onImageCorrectionFileChange(event) {
  const input = event && event.target
  const file = input && input.files && input.files.length ? input.files[0] : null
  imageCorrectionFile.value = file
  imageCorrectionFeedback.value = ''
}

/**
 * 一键粘贴（剪贴板图片）：与本机选图**共用同一处理体**（同上）。
 * `handleClipboardPaste` 文本优先不劫持：剪贴板含非空文字时放行默认粘贴。
 */
function onPasteImageCorrectionFile(event) {
  const decision = handleClipboardPaste(event, (file) => {
    imageCorrectionFile.value = file
    imageCorrectionFeedback.value = ''
  })
  if (decision.handled) event.preventDefault()
  else if (decision.reason !== 'TEXT_PRIORITY') imageCorrectionFeedback.value = decision.message
}

/** 提交：delete 直接提交；replace 先入册新图（失败 ⇒ 硬报错、**不发提交**）。 */
async function confirmImageCorrection() {
  if (imageCorrectionBusy.value || imageCorrectionSubmitDisabled.value) return
  const target = imageCorrectionTarget.value
  if (!target) return
  const action = imageCorrectionAction.value === 'replace' ? 'replace' : 'delete'
  const note = imageCorrectionNote.value.trim()
  if (note.length > corrections.MAX_IMAGE_CORRECTION_NOTE_LENGTH) {
    imageCorrectionFeedback.value =
      `備註超過 ${corrections.MAX_IMAGE_CORRECTION_NOTE_LENGTH} 字（當前 ${note.length} 字），請刪減後再提交；本次零寫入。`
    return
  }
  if (action === 'replace' && !imageCorrectionFile.value) {
    imageCorrectionFeedback.value = '請先選擇要替換的新圖；本次零寫入。'
    return
  }
  imageCorrectionBusy.value = true
  imageCorrectionFeedback.value = ''
  try {
    let newImage = null
    if (action === 'replace') {
      const file = imageCorrectionFile.value
      /* **本机只交 `File`**：解码 → 输入门 → 既有上传管线转「单页 8bit Deflate TIFF」容器
         全在 `prepareImageCorrectionReplacement` 内完成（与实物照片同一入口），视图不再自读字节。 */
      const prepared = await corrections.prepareImageCorrectionReplacement({
        sealId: target.sealId,
        faceId: target.faceId,
        kind: target.kind,
        file
      })
      /* **入册失败 ⇒ 硬报错、不编造 id、不发提交**（原样上屏服务端 / 上传通道文案）。 */
      if (!prepared || prepared.ok !== true) {
        imageCorrectionFeedback.value =
          (prepared && prepared.message) || '新圖上傳入冊失敗，本次零提交，請稍後重試。'
        return
      }
      newImage = prepared.new_image
    }
    const payload = {
      seal_id: target.sealId,
      face_id: target.faceId,
      image_id: target.imageId,
      action,
      note
    }
    if (newImage) payload.new_image = newImage
    const result = await corrections.submitImageCorrection(null, payload)
    if (!result || result.ok !== true) {
      imageCorrectionFeedback.value = (result && result.message) || '提交影像勘誤失敗，本次零寫入。'
      return
    }
    /* 成功 ⇒ 上屏固定文案 ＋ 关弹窗 ＋ 刷新待审读数（`dataVersion` 自增）。
       **同时在「可標記屬性」区顶部（用户操作处）落同一句** —— 弹窗一关，页面级底部提示
       常在视口之外（用户报「上传之后没有成功提示」的真因），故走既有单点
       `publishCorrectionNotice`，与勘误提交同一上屏位。 */
    imageCorrectionNotice.value = IMAGE_CORRECTION_SUBMITTED_MESSAGE
    publishCorrectionNotice(IMAGE_CORRECTION_SUBMITTED_MESSAGE, target.faceId)
    /* 提示位可能在视口之外（用户在影像卡处操作、提示落在属性区）⇒ **滚到可见处**，
       避免「提交了却什么都没看见」。 */
    void nextTick(() => {
      const node = document.querySelector('[data-correction-notice]') || document.querySelector('[data-image-correction-notice]')
      if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    formOpen.value = false
    correctionTab.value = 'attr'
    imageCorrectionTarget.value = null
    imageCorrectionFile.value = null
    imageCorrectionNote.value = ''
    dataVersion.value += 1
  } catch (error) {
    /* 传输层未预期异常 ⇒ 如实上屏 `STORAGE_UNAVAILABLE`，不伪装成别的 reason。 */
    imageCorrectionFeedback.value = `提交影像勘誤失敗（STORAGE_UNAVAILABLE）：${(error && error.message) || '未知錯誤'}`
  } finally {
    imageCorrectionBusy.value = false
  }
}

/* ============================================================================ *
   **清除本機資料（管理員面）＋ 孤兒印章行提示（Kevin 2026-11-06）**
   ----------------------------------------------------------------------------
   · 与广场页**同一入口**（钩子逐字 `data-action="local-db-clear"`；**不新增
     `data-admin-action` 取值**）；入口本体在广场页页头，本页只在**存在孤儿行**时
     给出同一入口按钮 ＋ 顶部一行提示。
   · 渲染条件 `seals.canClearLocalData()`（服务层判定；非管理员 / 游客 ⇒ 不渲染）。
   · 二次确认文案与广场页**逐字同一份**（清空范围 / 不可恢复 / 雲端資料不受影響）。
   · 成功 ⇒ 强制从云端重载（`seals.retryDataSource()`）并跳回广场带一次性提示；
     失败 ⇒ **本页如实上屏**（`clearFeedback`），不假报成功。
   · 孤儿行计数真源＝数据层 `localOrphanSealReadout()`；依赖面含数据源状态
     （云端水合晚到 / 重新加载后重算）。
   ============================================================================ */
const canClearLocal = computed(() => seals.canClearLocalData())
const orphanReadout = computed(() => {
  void dataVersion.value
  void dataSource.value.state
  return seals.localOrphanSealReadout()
})
const orphanCount = computed(() => orphanReadout.value.count)
const clearOpen = ref(false)
const clearBusy = ref(false)
const clearFeedback = ref('')

/** 二次确认主文案（与广场页逐字同一份；**必须列明**：清空范围、不可恢复、云端不受影响）。 */
const CLEAR_MESSAGE =
  '將清空本機全部印章、印面與影像行、影像二進制，以及其餘本機資料行；清除後不可恢復，雲端資料不受影響（登錄會話、帳號與主題會保留）。'

function askClearLocal() {
  clearFeedback.value = ''
  clearOpen.value = true
}

/** 确认清除：过服务层执行点；成功 ⇒ 强制从云端重载并回广场，失败 ⇒ 本页上屏。 */
async function confirmClearLocal() {
  if (clearBusy.value) return
  clearBusy.value = true
  let result = null
  try {
    result = await seals.clearLocalDatabase()
  } catch {
    result = { ok: false, messages: ['清除本機資料時發生未預期錯誤。'] }
  }
  clearBusy.value = false
  clearOpen.value = false
  if (!result || result.ok !== true) {
    /* **失败如实上屏**：取数据层 / 存储层原话，不假报成功。 */
    const detail = result && Array.isArray(result.messages) && result.messages.length ? `（${result.messages.join('；')}）` : ''
    clearFeedback.value = `清除本機資料失敗，本次未完成清除。${detail}`
    return
  }
  dataVersion.value += 1
  /* **强制从云端重载**（清完必须重读云端，不拿本机残留充数）。 */
  void seals.retryDataSource()
  const nav = router.push({ name: 'square', query: { notice: 'local-db-cleared' } })
  if (nav && typeof nav.catch === 'function') nav.catch(() => {})
}

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
     - 朝代 `dynasty` ⇒ `DYNASTY_OPTIONS`（15 类）；
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
async function submitSealAttributes() {
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
    result = await seals.updateSealAttributes(null, seal.value.stamp_id, patch)
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

/**
 * 属性表「當前展示值」单元格：**作者行走单点派生链**（`author_person_id` 命中 ⇒ 印人
 * `display_name` → 未命中 ⇒ 旧 `author` 自由文本 → 皆空 ⇒「佚名」），其余行沿用系统选中值
 * `item.display`。与卡片 / 导出 / 文本导出**同一单点**（`corrections.resolveAuthorDisplayName`
 * ——真源仍是数据层 `resolveAuthorName`），**不另写第二套名表**。
 */
function detailDisplayOf(face, item) {
  if (item && item.key === 'author') return corrections.resolveAuthorDisplayName(face) || '佚名'
  return item.display || '未著錄'
}

/* ============================================================================
   **採信**（本单新增）：详情页「可標記屬性」区里，就地列出**候选值**
   （值 ＋「N 人提交 / M 人採信」＋ 状态）与【採信】按钮。
   ----------------------------------------------------------------------------
   口径（人类冻结，逐条）：
     · 【採信】**只作佐证 / 可信度计数**（展示为「M 人採信」）；**生效仍由管理员采纳决定**
       —— 因此**已 `ACCEPTED` 的条目不再接受采信**（按钮隐藏，登记 `data-endorse-accepted`）。
     · **已 `REJECTED`** ⇒ 同样不出【採信】按钮（登记 `data-endorse-rejected`）；但**另给
       【重新提交】入口**（`data-action="correction-resubmit"`，本单）——服务层防重已排除
       `REJECTED` 行 ⇒ 重新提交本就被放行，只缺 UI 入口（详见下方 `onResubmitRejected`）。
     · **未登錄** ⇒ 按钮照渲染，点击走**登录引导**（`goLogin`）。
     · **自己的提交** ⇒ 不出按钮（登记 `data-endorse-self`）。
     · 数据经**云端公开只读集合** `xiai_correction_summaries`（**值级公开脱敏摘要面**：
       `submits` / `endorses` / `status` / `submitter_uids`；**零手机号**、uid 允许）全站一致
       ⇒ 他人在**另一浏览器**提交的 `PENDING` 值同样可列出并采信（跨浏览器成立）。
   判定是服务层的**纯函数** `endorsements.endorsementDecision`（视图不另写第二套）。
   ============================================================================ */
const viewer = computed(() => currentUser())
const endorseFeedback = reactive({})

function endorsementEntries(face) {
  return endorsements.endorsementEntriesOf(face, viewer.value)
}

function endorseFeedbackKey(face, entry) {
  return `${face.id}\u0001${entry.field}\u0001${entry.value}`
}

function endorseFeedbackOf(face, entry) {
  return endorseFeedback[endorseFeedbackKey(face, entry)] || ''
}

/* ============================================================================
   **简繁等价展示提示（§3.78）**：只做渲染提示 —— 不合并行、不改值、不置灰、不阻断提交
   ---------------------------------------------------------------------------- 判定单点 ＝ `corrections.cjkVariantPeersOf`（纯函数：字面不同而 `s2t` 归一后相等）：
     · **候選值列表**：某条与**同字段的其它候选**或**当前展示值**等价 ⇒ 该条**追加一行**提示；
     · **提交表单**：输入值与**同字段的既有候选值**等价 ⇒ 表单旁提示（**仍可直接提交**）。
   `s2t` 只出现在这两处比较里（**不进任何门**：防重 / 值域 / 長度 / 必填 / 採信冪等），
   提示**只作用于渲染**、不落库、不参与展示值裁决与採信计数。
   ============================================================================ */

/* 標記文案（§3.78.2 ③：**規範凍結字面原文＝「疑似同值（简/繁）」**，原文含簡體「简」；
   本處按硬約束「新文案一律繁體」取其繁體形上屏 ⇒ 過 `s2t(文案) === 文案`；
   標記是**附加文案**：不替換原值、不置灰、不折疊）。 */
const S2T_VARIANT_HINT = '疑似同值（簡/繁）'

/** 某印面某字段的**既有候选值**（候選值列表 ∪ 本機 / 公開提交分組；只读，不改任何行）。 */
function candidateValuesOf(face, field) {
  if (!face) return []
  const values = []
  endorsementEntries(face).forEach((entry) => {
    if (entry.field === field) values.push(entry.value)
  })
  corrections.submissionGroupsOfFace(face).forEach((group) => {
    if (group.field === field) values.push(group.value)
  })
  return values
}

/** 当前展示值（与属性表**同一单点**：`markableOf` ＋ `detailDisplayOf`；无该字段 ⇒ 空串）。 */
function markableDisplayValueOf(face, key) {
  if (!face) return ''
  const item = markableOf(face).find((row) => row.key === key)
  return item ? String(detailDisplayOf(face, item) || '') : ''
}

/**
 * 候選值行的提示文案（**只读渲染**）：命中 ⇒ `疑似同值（簡/繁）`，未命中 ⇒ 空串。
 * 判定（§3.78.2 ②）＝ 与同字段其它候选 / 当前展示值「**字面不同**而 `s2t` 归一后相等」。
 */
function s2tVariantHintOf(face, entry) {
  if (!face || !entry || !entry.value) return ''
  const values = candidateValuesOf(face, entry.field)
  const displayed = markableDisplayValueOf(face, entry.field)
  const peers = corrections.cjkVariantPeersOf(entry.value, displayed ? [...values, displayed] : values)
  return peers.length > 0 ? S2T_VARIANT_HINT : ''
}

/**
 * 提交表单旁的提示（§3.78.3）：返回首个「与输入值简繁等价的既有候选值」；无 ⇒ 空串。
 * **只提示**：不改输入值、不归一入参、**不禁用提交**（提交后仍走 §3.47 逐字判重）。
 */
function formS2tVariantPeer() {
  const face = formFace.value
  if (!face) return ''
  const keys = corrections.MARKABLE_FIELDS.map((item) => item.key)
  for (const key of keys) {
    const raw = form[key]
    const text = String(raw === undefined || raw === null ? '' : raw).trim()
    if (!text) continue
    const peers = corrections.cjkVariantPeersOf(text, candidateValuesOf(face, key))
    if (peers.length > 0) return peers[0]
  }
  return ''
}

async function onEndorse(face, entry) {
  const key = endorseFeedbackKey(face, entry)
  endorseFeedback[key] = ''
  /* 未登錄（`actionable:false`）⇒ 按钮已渲染，点击走登录引导（不静默）。 */
  if (!entry.actionable) {
    goLogin()
    return
  }
  const sealId = seal.value ? seal.value.stamp_id : face.sealId || ''
  const result = await endorsements.endorseCorrection({
    faceId: face.id,
    sealId,
    field: entry.field,
    value: entry.value
  })
  endorseFeedback[key] = result.message
  /* 成功 ⇒ +1 让「N 人採信」与列表立即重算（服务层读的是已落盘数据）。 */
  if (result.ok) dataVersion.value += 1
}

/* ============================================================================
   **重新提交**（本单）：已 `REJECTED` 的候選值**不再阻塞**重新提交。
   ----------------------------------------------------------------------------
   口径（逐条）：
     · 服务层防重**已排除 `REJECTED` 行** ⇒ 服务端本就放行；本处只补 **UI 入口**
       （此前已駁回的行只渲染一行「已駁回」文字，用户无从下手 ⇒ 觀感上像被卡死）。
     · 点击 ⇒ 把该 `(field, value)` **回填到既有勘误表单**（`form[item.key]`，与手工填写
       同一张表单），随后**直接走现有提交流程** `submitCorrection()` ⇒
       `corrections.submitCorrection` —— **零新增写口**、零新增服务层调用（与手工提交
       **同一路径**；只提交这一项，其余项随表单一并清空）。
     · 结果按现有口径上屏（**同一份文案落三处**：该候選值自身的 `data-endorse-feedback`
       ＋ 页面级 `data-correction-notice` ＋ 表单 `formFeedback`）：
         成功 ⇒「已重新提交（待審覈）」；服务端仍回 `DUPLICATE_VALUE` ⇒ 既有「跳过」文案；
         其它失败 ⇒ 服务端原话逐字上屏。
     · 未登錄 ⇒ 走既有登录引导（与【採信】同口径，不静默、不提交）。
     · 已採納（`ACCEPTED`）与自己的提交（`SELF`）**不加**本入口（渲染逻辑不动）。
   ============================================================================ */
const CORRECTION_RESUBMIT_OK_MESSAGE = '已重新提交（待審覈）'

async function onResubmitRejected(face, entry) {
  const key = endorseFeedbackKey(face, entry)
  endorseFeedback[key] = ''
  /* 未登錄 ⇒ 走既有登录引导（不回填、不提交）。 */
  if (!canSubmit.value) {
    goLogin()
    return
  }
  /* 回填既有勘误表单：其余项一并清空 ⇒ 本单只提交这一项（与 `openCorrection` 同一套清场）。 */
  corrections.MARKABLE_FIELDS.forEach((item) => {
    form[item.key] = ''
  })
  form.basis = ''
  formFaceId.value = face.id
  form[entry.field] = entry.value
  /* 走现有提交流程（与手工提交同一路径）；回包三态由 `submitCorrection` 如实回报。 */
  const outcome = (await submitCorrection()) || { accepted: 0, skipped: 0, message: '' }
  const message =
    outcome.accepted > 0 ? CORRECTION_RESUBMIT_OK_MESSAGE : outcome.message || CORRECTION_SKIP_ALL_MESSAGE
  /* 三处上屏同一份文案（表单 / 页面级提示位 / 该候選值自身反馈位）。 */
  formFeedback.value = message
  endorseFeedback[key] = message
  publishCorrectionNotice(message, face.id)
  /* 成功 ⇒ +1 让「N 人提交 / 待審覈」读数立即重算（服务层读的是已落盘数据）。 */
  if (outcome.accepted > 0) dataVersion.value += 1
}

/* ============================================================================ 
   **校驗作者（本單）**：作者行的「校驗作者」入口 ＋ 候选弹窗
   ---------------------------------------------------------------------------- 口径（逐条）：
     · 入口**一律渲染**（游客也可见、可达），点击走**既有登录门**：`!canSubmit ⇒ goLogin()`
       —— 与【勘誤】入口 `openCorrection` **同一门、同一引导**（不另造文案、不 CSS 隐藏）；
     · 有当前作者名 ⇒ 打开即按 `face_id` 查一次；无（空 /「佚名」）⇒ 弹窗里给输入框，
       由用户填姓名再查（只传 `name`，不替服务端猜匹配口径）；
     · 候选来自**公开只读 op `suggestAuthors`**（服务层 `authorMatch.suggestAuthorCandidates`）：
       失败 / 未配置云端 / 形状不可辨识 ⇒ **结构化失败原文上屏**，**不列空数组冒充「沒有合適人選」**；
       空态「暫無合適人選」只在**查询成功且零候选**时出现；
     · 选中一个 ⇒ **走既有勘误通道**（回填既有勘误表单 ⇒ 视图 `submitCorrection()` ⇒
       `corrections.submitCorrection`，与【重新提交】同一处置、**零新增写口**）：
       字段 ＝ `author`；**值 ＝ 所选 `person_id`** —— 现行口径下 `author` 是**引用型**
       （客户端 `FIELD_VALUE_DOMAINS.author` 与服务端 `readPersonRow` 双门都按**印人 id** 判，
       传 `display_name` 必被 `INVALID_VALUE` 拒）；`display_name` 只作上屏；
     · 文案**逐字沿用**现有提交回包（成功 / 跳过 / 失败三态），同时落弹窗内与页面级
       `data-correction-notice` ⇒ 成功、失败、已存在**三态都可见**，不静默。
   ============================================================================ */
/** 单次查询的 `limit`（契约缺省 5；1〜10 由服务层夹取）。 */
const AUTHOR_VERIFY_LIMIT = 5
const authorVerifyOpen = ref(false)
/** 查询 / 提交共用的在飞闸（同一时刻只允许一发，避免回包串台）。 */
const authorVerifyBusy = ref(false)
/** 目标印面（关窗即清，避免残留指向）。 */
const authorVerifyFaceId = ref('')
/** 查询词：有当前作者名 ⇒ 预填；否则为空，由用户手填。 */
const authorVerifyName = ref('')
/** 当前作者名为空 /「佚名」⇒ 弹窗里给输入框。 */
const authorVerifyNeedsName = ref(false)
/** 已发起过查询（空态只在查过之后才出现，不谎称「查不到」）。 */
const authorVerifySearched = ref(false)
const authorVerifyQueryLabel = ref('')
const authorVerifyCandidates = ref([])
/** 提交回包文案（成功 / 跳过 / 失败三态，逐字来自既有提交入口）。 */
const authorVerifyFeedback = ref('')
/** 查询失败文案（服务端 / 传输层原话；与提交反馈分位，互不覆盖）。 */
const authorVerifyError = ref('')
/** 弹窗导语的目标印面读数（关窗时安全返回空串；**不编造**）。 */
const authorVerifyFaceLabel = computed(() => {
  const face = faces.value.find((item) => item.id === authorVerifyFaceId.value)
  return face ? faceLabel(face) : ''
})

/** 目标印面的当前作者名（「佚名」按**无作者**处理 ⇒ 走输入框分支）。 */
function authorVerifyCurrentName(face) {
  const name = String(corrections.resolveAuthorDisplayName(face) || '').trim()
  return name === '佚名' ? '' : name
}

/** 打开弹窗（每次打开重置候选 / 反馈 / 查询态；有当前作者名即刻按 `face_id` 查）。 */
function openAuthorVerify(face) {
  /* 未登录 ⇒ 与【勘誤】同一登录门（`openCorrection` 的 `!canSubmit ⇒ goLogin`）。 */
  if (!canSubmit.value) {
    goLogin()
    return
  }
  const current = face ? authorVerifyCurrentName(face) : ''
  authorVerifyFaceId.value = face ? String(face.id) : ''
  authorVerifyName.value = current
  authorVerifyNeedsName.value = current === ''
  authorVerifyCandidates.value = []
  authorVerifySearched.value = false
  authorVerifyQueryLabel.value = ''
  authorVerifyFeedback.value = ''
  authorVerifyError.value = ''
  authorVerifyOpen.value = true
  if (current) void runAuthorSuggest({ faceId: authorVerifyFaceId.value })
}

/** 关闭弹窗（零写入；候选与反馈一并作废，避免下次打开残留）。 */
function closeAuthorVerify() {
  if (authorVerifyBusy.value) return
  authorVerifyOpen.value = false
  authorVerifyFaceId.value = ''
  authorVerifyCandidates.value = []
  authorVerifyFeedback.value = ''
  authorVerifyError.value = ''
  authorVerifySearched.value = false
  authorVerifyQueryLabel.value = ''
}

/** 跑一次候选查询（**失败原文上屏**；成功才落候选）。 */
async function runAuthorSuggest(input) {
  if (authorVerifyBusy.value) return
  authorVerifyBusy.value = true
  authorVerifyError.value = ''
  authorVerifyFeedback.value = ''
  authorVerifyCandidates.value = []
  authorVerifySearched.value = true
  try {
    const out = await authorMatch.suggestAuthorCandidates({ ...input, limit: AUTHOR_VERIFY_LIMIT })
    if (!out || out.ok !== true) {
      authorVerifyQueryLabel.value = ''
      authorVerifyError.value = (out && out.message) || '作者候選查詢失敗；本次未列出任何候選。'
      return
    }
    authorVerifyCandidates.value = out.candidates
    authorVerifyQueryLabel.value = String(out.normalized || input.name || input.faceId || '').trim()
  } catch (err) {
    authorVerifyError.value = `作者候選查詢失敗（${(err && err.message) || '未知原因'}）；本次未列出任何候選。`
  } finally {
    authorVerifyBusy.value = false
  }
}

/** 输入框分支的「查詢候選」（只按姓名查；空输入 ⇒ 可读提示，不发空查询）。 */
function onAuthorVerifySearch() {
  const name = String(authorVerifyName.value || '').trim()
  if (!name) {
    authorVerifyError.value = '請先輸入作者姓名，再查詢候選。'
    return
  }
  void runAuthorSuggest({ name })
}

/** 命中字段中文名（单点取服务层真源；视图不另写第二套字段名表）。 */
function authorVerifyFieldLabel(field) {
  return authorMatch.matchedFieldLabel(field)
}

/** 分数上屏：有限数字**原样**（不四舍五入、不换算百分比）；取不到 ⇒ `—`（不编造 0 分）。 */
function authorVerifyScoreText(score) {
  return typeof score === 'number' && Number.isFinite(score) ? String(score) : '—'
}

/**
 * 选中一个候选 ⇒ **走既有勘误通道提交**（回填既有表单后调视图 `submitCorrection()`，
 * 与【重新提交】同一路径 ⇒ `corrections.submitCorrection`，零新增写口）。
 * 成功 / 跳过（已存在）/ 失败三态文案**逐字沿用**既有回包，同时落弹窗内与页面级提示位。
 */
async function onAuthorVerifyPick(candidate) {
  if (authorVerifyBusy.value) return
  const face = faces.value.find((item) => item.id === authorVerifyFaceId.value) || null
  if (!face) {
    authorVerifyFeedback.value = '本印面已不可用，本次未提交任何內容。'
    return
  }
  /* 会话在弹窗打开后失效 ⇒ 与入口同一登录门（不静默、不提交）。 */
  if (!canSubmit.value) {
    goLogin()
    return
  }
  const personId = String((candidate && candidate.person_id) || '').trim()
  if (!personId) {
    authorVerifyFeedback.value = '該候選缺少印人編號（person_id），本次未提交。'
    return
  }
  authorVerifyBusy.value = true
  try {
    /* 回填既有勘误表单：其余项一并清空 ⇒ 本单只提交「作者」这一项。 */
    corrections.MARKABLE_FIELDS.forEach((item) => {
      form[item.key] = ''
    })
    form.basis = ''
    formFaceId.value = face.id
    form.author = personId
    const outcome = (await submitCorrection()) || { accepted: 0, skipped: 0, message: '' }
    /* 回包必须有文案（提交入口三态恒给一句）；万一为空 ⇒ 如实说明「未知」，**不谎称成功、不静默**。 */
    const message = String(outcome.message || '').trim() || '提交結果未取得回執，請到「我的勘誤記錄」確認本次是否入庫。'
    authorVerifyFeedback.value = message
    /* 同一份文案上屏到页面级提示位（弹窗关掉后仍可见）。 */
    publishCorrectionNotice(message, face.id)
    if (outcome.accepted > 0) dataVersion.value += 1
  } finally {
    authorVerifyBusy.value = false
  }
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
/* 【大類】（本单）＝印面级新键 `seal_class`（3 值封闭；无回落）。 */
const SEAL_CLASS_KEY = 'seal_class'

const FACE_CONTENT_READY = Array.isArray(FACE_CONTENT_OPTIONS) && FACE_CONTENT_OPTIONS.length > 0
const FACE_STYLE_READY = Array.isArray(FACE_STYLE_OPTIONS) && FACE_STYLE_OPTIONS.length > 0
const SEAL_CLASS_READY = Array.isArray(SEAL_CLASS_OPTIONS) && SEAL_CLASS_OPTIONS.length > 0
const FACE_CONTENT_MISSING_MESSAGE =
  '印面內容選項未就緒（真源常量 FACE_CONTENT_OPTIONS 不可用），暫時無法選擇印面內容，請稍後重試。'
const FACE_STYLE_MISSING_MESSAGE =
  '印面風格選項未就緒（真源常量 FACE_STYLE_OPTIONS 不可用），暫時無法選擇印面風格，請稍後重試。'
const SEAL_CLASS_MISSING_MESSAGE =
  '大類選項未就緒（真源常量 SEAL_CLASS_OPTIONS 不可用），暫時無法選擇大類，請稍後重試。'

const faceContentOptions = computed(() => (FACE_CONTENT_READY ? [...FACE_CONTENT_OPTIONS] : []))
const faceStyleOptions = computed(() => (FACE_STYLE_READY ? [...FACE_STYLE_OPTIONS] : []))
/* 大類的 3 值**引真源 `SEAL_CLASS_OPTIONS`**（不硬编码副本）。 */
const sealClassOptions = computed(() => (SEAL_CLASS_READY ? [...SEAL_CLASS_OPTIONS] : []))

/** 勘误登记面：服务层 `MARKABLE_FIELDS` 里是否已登记该键（未登记 ⇒ 服务层会结构化拒）。 */
function markableRegistered(key) {
  const list = Array.isArray(corrections.MARKABLE_FIELDS) ? corrections.MARKABLE_FIELDS : []
  return list.some((item) => item.key === key)
}

/** 每个印面各一份草稿（按印面 id 分桶；`''` ＝ 本次不提交该项）。 */
const faceEntryDraft = reactive({})
const faceEntryFeedback = reactive({})

/* ============================================================================
   勘误反馈的**页面级上屏位**（本单）：弹窗路径提交成功后 `formOpen = false` 把弹窗一起关掉 ⇒
   反馈文案 `formFeedback` 随弹窗消失，页面上看不到任何「已提交…待審覈」。故把**同一份文案**
   （一字不改，仍由 `correctionFeedbackOf` / `CORRECTION_SKIP_ALL_MESSAGE` / 首条失败文案拼装）
   同步写到「可標記屬性」区顶部的提示位（`data-correction-notice`）。弹窗内 `formFeedback` 原样保留。
   **不设自动消失**（无定时器，避免用户错过）：只在「重开勘误弹窗 / 切换印面 / 重新加载印面」时清空。
   ============================================================================ */
const correctionNotice = ref('')
/* 多印面同页渲染（`v-for="face in faces"`）⇒ 提示只在**提交来源那一块**呈现，不逐块复制。 */
const correctionNoticeFaceId = ref('')

/** 把最终反馈文案同时写到弹窗内（调用方自理）与页面级提示位。 */
function publishCorrectionNotice(text, faceId) {
  correctionNotice.value = text
  correctionNoticeFaceId.value = faceId || ''
  /* 受控诊断面：本函数是**所有勘误提交路径的收口**（表单 / 印面属性都在提交后调它）
     ⇒ 此刻 +1 让面板重读服务层刚记下的里程碑（无定时器、无请求）。 */
  diagTick.value += 1
}

/* 切换印章（路由 id 变）/ 重新加载印面（识别码、面集合或数据源状态变）⇒ 提示随之作废，
   不把上一枚印章 / 上一次加载的反馈带到新面。
   **按值比较（拼成字符串）而非数组引用**：`submitFaceEntry` 提交成功后会 `dataVersion + 1`，
   数组引用每次求值都不同 ⇒ 那样写会把刚写入的提示连带清掉（用户又看不到确认）。 */
watch(
  () =>
    [
      route.params.id,
      seal.value ? seal.value.stamp_id : '',
      faces.value.map((item) => item.id).join(','),
      seals.dataSourceState().state
    ].join('|'),
  () => {
    correctionNotice.value = ''
    correctionNoticeFaceId.value = ''
  }
)

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

/* 视图层「跳过」上屏文案（冻结口径 2026-11-02；一律繁體，须过 `s2t(文案) === 文案` 自检）。
   服务层 / 云函数的拒绝形状与回包键面**一字不变**（仍是 `ok:false` + `DUPLICATE_VALUE` + 原 message +
   零写入），跳过语义只在本视图层实现。 */
const CORRECTION_SKIP_ALL_MESSAGE =
  '所選項目已有相同提交，本次未新增勘誤。若你贊同該值，請改用【採信】為它佐證。'

/** 成功句（含金奖励句尾）在前；有跳过时把**部分跳过句**接在其后。 */
function correctionFeedbackOf(accepted, skipped, reward) {
  const success = `已提交 ${accepted} 條勘誤，平臺審覈採納後每條獎勵 ${reward} 金。`
  if (!skipped) return success
  return `${success}另有 ${skipped} 條已有相同提交（無需重複提交），本次未新增。`
}

/**
 * 提交本印面的【印面内容】/【印面风格】勘误（只提交**有选择**的项）。
 * 成功后 `dataVersion + 1` ⇒ 「待审核」计数与本块读数**不刷新即反映**。
 */
async function submitFaceEntry(face) {
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
    publishCorrectionNotice(faceEntryFeedback[face.id], face.id)
    return
  }
  const sealId = seal.value ? seal.value.stamp_id : face.sealId || ''
  /* 一次表单提交 ＝ 一个提交单号（R-B2）：本批 N 条共享同一 `batchId`。 */
  const batchId = corrections.newBatchId()
  let accepted = 0
  /* 冻结口径（2026-11-02）：重复字段按**跳过**处理（不新增行、不报错），不计入失败。 */
  let skipped = 0
  let firstError = ''
  /* OBS-1：`submitCorrection` 已改 `async`（经云函数验签后落盘）⇒ 本处由逐项并发
     改为**串行 `await`**（逐条独立成败，与改前语义一致：一条失败不影响其余）。 */
  for (const { field, label, value } of pairs) {
    const result = await corrections.submitCorrection({ faceId: face.id, sealId, field, value, batchId })
    if (result.ok) accepted += 1
    else if (result.reason === 'DUPLICATE_VALUE') skipped += 1
    else if (!firstError) firstError = result.message || `「${label}」提交失敗`
  }
  /* 口径 4：有真实失败 ⇒ 仍上屏**首个真实失败**文案（跳过不得覆盖失败）。 */
  if (accepted === 0 && firstError) {
    faceEntryFeedback[face.id] = firstError
    publishCorrectionNotice(faceEntryFeedback[face.id], face.id)
    return
  }
  faceEntryFeedback[face.id] =
    accepted === 0
      ? CORRECTION_SKIP_ALL_MESSAGE
      : correctionFeedbackOf(accepted, skipped, points.CORRECTION_REWARD)
  publishCorrectionNotice(faceEntryFeedback[face.id], face.id)
  /* 口径 5：接受数 ＋ 跳过数 === 本次填写项数 ⇒ 整单完成（清空草稿）。 */
  if (accepted + skipped === pairs.length) {
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
/* ============================================================================
   **勘誤弹窗「影像」页签的目标面（本單：入口合一）**
   ---------------------------------------------------------------------------- · 页面上的影像卡不再各挂一枚【勘誤】⇒ 目标影像改由**合并弹窗的影像页签**给出：
     候选 ＝ 本印面的印面图 ＋ 其全部边款图（**逐图可达**，与原影像卡逐枚入口同一集合）。
   · 只有多于一个候选时才上屏选择器；候选唯一 ⇒ 直接取它（不加多余控件）。
   · 装填仍走 `prepareImageCorrection`（登录门 / 重置面逐字沿用），提交仍走
     `confirmImageCorrection` ⇒ `corrections.submitImageCorrection`（**零新增写口**）。
   ============================================================================ */
/** 本印面可勘誤的影像候选 `{imageId, kind}`（印面图优先，随后边款图，顺序稳定）。 */
function imageCandidatesOf(face) {
  if (!face) return []
  const out = []
  if (face.face_image_id) out.push({ imageId: String(face.face_image_id), kind: seals.FACE_KIND.FACE })
  const edges = Array.isArray(face.edgeImages) ? face.edgeImages : []
  edges.forEach((image) => {
    if (image && image.id) out.push({ imageId: String(image.id), kind: seals.FACE_KIND.EDGE })
  })
  return out
}
const correctionImageCandidates = computed(() => imageCandidatesOf(formFace.value))
/** 影像页签当前选中的候选键 `kind:imageId`（开弹窗时按首选候选装填）。 */
const imageCorrectionChoice = ref('')
/** 换目标影像（选择器 `@change`）：只换目标，**不碰任何提交链路**。 */
function retargetCorrectionImage(event) {
  const key = String((event && event.target && event.target.value) || '') || imageCorrectionChoice.value
  imageCorrectionChoice.value = key
  const item = correctionImageCandidates.value.find((candidate) => `${candidate.kind}:${candidate.imageId}` === key)
  if (item) prepareImageCorrection(formFace.value, item.imageId, item.kind)
}
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

/* ============================================================================
   【作者】＝**引用型**检索 + 选人控件（person-model §4.1 / §4.3）
   ----------------------------------------------------------------------------
   - 「作者」字段改为**检索 + 选人**：选项只来自既有印人（`persons.listPersons` /
     `persons.searchPersons`）；`form.author` 承载所选印人 id（`author_person_id`）。
   - **不填 ⇒ 空**（作者仍选填）；填则**必须**指向既有印人（不得手输自由文本）。
   - **库中无此人 ⇒ 上屏引导去提交印人提案**（不是静默失败、不是放行自由文本）。
   - 提交提案＝任何登录用户；**入口一律渲染**，未登录点击走登录引导（不得 CSS 隐藏 / disabled 冒充）。
   ============================================================================ */
const authorKeyword = ref('')
const correctionAuthorOptions = computed(() => {
  const keyword = String(authorKeyword.value || '').trim()
  const rows = keyword ? persons.searchPersons(keyword) : persons.listPersons()
  return rows.map((row) => ({ id: String(row.id || ''), name: persons.personName(row) }))
})
/** 某印面「作者」的**对外展示名**（单点链：引用 → 旧文本 →「佚名」）。 */
function authorDisplayValue() {
  return formFace.value ? corrections.resolveAuthorDisplayName(formFace.value) : ''
}

/* ============================================================================
   **印人信息区（印人批 2｜§4.1.14 表下注（v1.54）／人类已拍 ②；本单新增）**
   ----------------------------------------------------------------------------
   展示该作者（引用型 `author_person_id` → 印人）的**籍貫 / 傳記** —— **只展示正字段（繁体）**；
   `native_place_chs` / `biography_chs` 副字段**不上屏**；作者显示名仍走**单点链**
   （`corrections.resolveAuthorDisplayName`）。**不可达 ⇒ 优雅降级**（整区不渲染，不报错、不编造）。
   ============================================================================ */
/** 取本印面的作者印人行（引用命中 ⇒ 行；未命中 / 无引用 ⇒ `null`，**不编造**）。 */
function authorPersonOf(face) {
  const id = face && face.author_person_id ? String(face.author_person_id) : ''
  if (!id) return null
  try {
    return persons.person(id) || null
  } catch {
    return null
  }
}
/** 印人信息区的可上屏内容（籍貫 / 傳記任一非空才返回；否则 `null` ⇒ 整区不渲染、优雅降级）。 */
function personInfoOf(face) {
  const person = authorPersonOf(face)
  if (!person) return null
  const nativePlace = String(person.native_place || '')
  const biography = String(person.biography || '')
  if (!nativePlace && !biography) return null
  return { name: corrections.resolveAuthorDisplayName(face) || '佚名', nativePlace, biography }
}

/* 印人提案（新增印人）**内联提交面**：仅当检索无命中时露出（§3.54.7 / §4.3）。 */
const proposalOpen = ref(false)
const proposalFeedback = ref('')
const proposalBusy = ref(false)
const proposal = reactive({
  familyName: '',
  givenName: '',
  courtesy: '',
  art: '',
  alias: '',
  birthYear: '',
  deathYear: '',
  cbdbId: '',
  /* **批 2（v1.54｜人类已拍 ①）**：提案表单亦收四扩字段（籍贯 / 传记 / 来源 / 来源 id）。 */
  nativePlace: '',
  biography: '',
  source: '',
  sourceId: '',
  note: ''
})

function resetProposal() {
  proposal.familyName = ''
  proposal.givenName = ''
  proposal.courtesy = ''
  proposal.art = ''
  proposal.alias = ''
  proposal.birthYear = ''
  proposal.deathYear = ''
  proposal.cbdbId = ''
  proposal.nativePlace = ''
  proposal.biography = ''
  proposal.source = ''
  proposal.sourceId = ''
  proposal.note = ''
}

function openPersonProposal() {
  proposalFeedback.value = ''
  if (!logged.value) {
    /* 未登录 ⇒ 入口已渲染，点击走**登录引导**（不得 CSS 隐藏 / disabled 冒充）。 */
    goLogin()
    return
  }
  proposalOpen.value = true
}

async function submitPersonProposalForm() {
  if (proposalBusy.value) return
  proposalBusy.value = true
  try {
    /* 写面接线（本单）：`submitPersonProposal` 已改 `async`（经写面门 `userWriteGate` 验签后落盘）⇒ 须 `await`。 */
    const result = await persons.submitPersonProposal({
      targetPersonId: null,
      familyName: proposal.familyName,
      givenName: proposal.givenName,
      courtesyNames: proposal.courtesy,
      artNames: proposal.art,
      aliasNames: proposal.alias,
      birthYear: proposal.birthYear,
      deathYear: proposal.deathYear,
      cbdbId: proposal.cbdbId,
      /* **四扩字段（正字段，繁体为正）**：逐字提交；**不强制、不拒收、不自动改写**。 */
      nativePlace: proposal.nativePlace,
      biography: proposal.biography,
      source: proposal.source,
      sourceId: proposal.sourceId,
      note: proposal.note
    })
    proposalFeedback.value = result.message
    if (result.ok) resetProposal()
  } finally {
    proposalBusy.value = false
  }
}

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
  /* 重开弹窗 ⇒ 页面级勘误提示作废（否则旧反馈会一直挂着，被当成新结果）。 */
  correctionNotice.value = ''
  correctionNoticeFaceId.value = ''
  /* 【作者】引用型选人控件：每次开表单重置检索关键字与提案子表单（不残留上次状态）。 */
  authorKeyword.value = ''
  proposalOpen.value = false
  proposalFeedback.value = ''
  resetProposal()
  formFaceId.value = face.id
  /* 合并弹窗（本單）：默认停在「屬性」页签；影像页签的目标一并装填 ——
     候选唯一 ⇒ 直取该图；多图 ⇒ 默认首图（页签内可换）；无图 ⇒ 目标留空，
     影像页签只上屏「無從提交」提示（**不发页面级提示、零写入面不变**）。 */
  correctionTab.value = 'attr'
  const candidates = imageCandidatesOf(face)
  imageCorrectionChoice.value = candidates.length ? `${candidates[0].kind}:${candidates[0].imageId}` : ''
  if (candidates.length) {
    prepareImageCorrection(face, candidates[0].imageId, candidates[0].kind)
  } else {
    imageCorrectionTarget.value = null
    imageCorrectionAction.value = 'delete'
    imageCorrectionNote.value = ''
    imageCorrectionFile.value = null
    imageCorrectionFeedback.value = ''
  }
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
 * 三動作轉換按鈕**只給自由文本字段**：封閉選擇框（朝代 / 【印面內容】/【印面風格】/ 【大類】）**不加**
 * （封閉項的值只能來自真源選項，轉換按鈕對它無意義、且會誘導出值域外的值）。
 * **本单修正**：【大類】`seal_class` 是**封閉下拉**（3 值）⇒ 不得再當自由文本渲染（也就不得挂
 * 三動作轉換按鈕）；否则它會以自由文本输入框的形态出现，用户可输入值域外值。
 */
function correctionFieldIsFreeText(key) {
  return key !== 'dynasty' && key !== FACE_CONTENT_KEY && key !== FACE_STYLE_KEY && key !== SEAL_CLASS_KEY && key !== 'author'
}

/* 提交回包的**结构化回报**（本单）：`submitCorrection` 由「无返回值」改为如实回报四态
   （`accepted` / `skipped` / `firstError` / `message`）——**循环体与上屏文案一字未动**
   （`verify-correction-duplicate-skip` C 段仍逐字命中三个锚），只把已经算出来的结果交还给
   调用方（【重新提交】入口要按三态选文案）。 */
async function submitCorrection() {
  if (!seal.value || !formFaceId.value) return { accepted: 0, skipped: 0, firstError: '', message: '' }
  const filled = corrections.MARKABLE_FIELDS.filter(
    (item) => correctionFieldVisible(item) && String(form[item.key] || '').trim() !== ''
  )
  if (filled.length === 0) {
    formFeedback.value = '請至少填寫一項需要勘誤的屬性'
    publishCorrectionNotice(formFeedback.value, formFaceId.value)
    return { accepted: 0, skipped: 0, firstError: '', message: formFeedback.value }
  }
  let accepted = 0
  /* 冻结口径（2026-11-02）：重复字段按**跳过**处理（不新增行、不报错），不计入失败。 */
  let skipped = 0
  let firstError = ''
  /* 一次表单提交 ＝ 一个提交单号（R-B2）：本批 N 条共享同一 `batchId`。 */
  const batchId = corrections.newBatchId()
  /* 写面 Phase A：`submitCorrection` 改为 `async`（经云函数验签后落盘）⇒ 本处由逐项并发
     改为**串行 `await`**（逐条过门、逐条独立成败，与改前语义一致：一条失败不影响其余）。 */
  for (const item of filled) {
    const result = await corrections.submitCorrection({
      faceId: formFaceId.value,
      sealId: seal.value.stamp_id,
      field: item.key,
      value: form[item.key],
      basis: form.basis,
      batchId
    })
    if (result.ok) accepted += 1
    else if (result.reason === 'DUPLICATE_VALUE') skipped += 1
    else if (!firstError) firstError = result.message
  }
  /* 口径 4：有真实失败 ⇒ 仍上屏**首个真实失败**文案（跳过不得覆盖失败）。 */
  if (accepted === 0 && firstError) {
    formFeedback.value = firstError || '提交失敗，請稍後重試'
    publishCorrectionNotice(formFeedback.value, formFaceId.value)
    return { accepted, skipped, firstError, message: formFeedback.value }
  }
  formFeedback.value =
    accepted === 0
      ? CORRECTION_SKIP_ALL_MESSAGE
      : correctionFeedbackOf(accepted, skipped, points.CORRECTION_REWARD)
  /* 同一份文案同时落到页面级提示位：下面关弹窗后，`formFeedback` 会随弹窗一起消失。 */
  publishCorrectionNotice(formFeedback.value, formFaceId.value)
  /* 口径 5：接受数 ＋ 跳过数 === 本次填写项数 ⇒ 整单完成（关闭弹窗）。 */
  if (accepted + skipped === filled.length) formOpen.value = false
  return { accepted, skipped, firstError, message: formFeedback.value }
}

/** 选图 / 粘贴**共用处理体**：把一个 File 走完「登录门 → 解码 → 上限校验 → 上传管线 → 入库」。 */
async function applyPhotoFile(file) {
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

/** 选图入口：取出本机文件 → 交同一「处理体」。 */
function onPickPhoto(event) {
  const file = event.target.files && event.target.files[0]
  event.target.value = ''
  void applyPhotoFile(file)
}

/** 一键粘贴入口：`handleClipboardPaste` 判定是否接管；**文本优先不劫持**（含文字则放行默认粘贴）。 */
function onPastePhoto(event) {
  const decision = handleClipboardPaste(event, (file) => {
    void applyPhotoFile(file)
  })
  if (decision.handled) event.preventDefault()
  else if (decision.reason !== 'TEXT_PRIORITY') uploadFeedback.value = decision.message
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

/** 选图 / 粘贴**共用处理体**：把一个 File 走完「解码 → 上限校验 → 取景 → 预导出」。 */
async function applyReplaceFile(file) {
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

/** 选图入口：取出本机文件 → 交同一「处理体」。 */
function onPickReplaceImage(event) {
  const file = event.target.files && event.target.files[0]
  event.target.value = ''
  void applyReplaceFile(file)
}

/** 一键粘贴入口：`handleClipboardPaste` 判定是否接管；**文本优先不劫持**（含文字则放行默认粘贴）。 */
function onPasteReplaceImage(event) {
  const decision = handleClipboardPaste(event, (file) => {
    void applyReplaceFile(file)
  })
  if (decision.handled) event.preventDefault()
  else if (decision.reason !== 'TEXT_PRIORITY') replaceFeedback.value = decision.message
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

/* ============================================================================
   管理員：**新增印面**（「印面列表」區塊入口 ＋ 彈窗｜本單）
   ----------------------------------------------------------------------------
   · 入口**恰一個**，掛在「印面列表」區塊標題旁、`v-for` **之外**（不逐塊複製 ⇒ N 個印面
     也只有 1 個按鈕）；鉤子只用 `data-action="add-seal-face"` —— **不進** `[data-admin-action]`
     族（該族取值集合已凍結計數，擴展即撞套件）。
   · 渲染條件＝服務層判定 `seals.canAddSealFace()`（遊客 / 普通使用者 ⇒ false ⇒ 不渲染，
     DOM 零命中；**不得** CSS 隱藏 / `disabled` 冒充）；資料層另有獨立拒絕（繞過 UI 直調亦被拒）。
   · 彈窗（`AddSealFaceDialog.vue`）承載**既有的同一條上傳管道**（`loadImageFile` →
     `seals.inputDenialOf` → `runUploadPipeline` 出單頁 8bit Deflate TIFF → 服務層
     `storeArtifactBytes` → `registerFaceImage` → `addSealFace`）與剪貼板粘貼單點；
     本頁只負責開窗 / 關窗、成功後**重取雲端快照**與**頁面級成功提示**。
   · 失敗文案由服務層如實給出（含「影像已入冊但印面未建立」），本頁**不改寫、不吞**。
   ============================================================================ */

/** 管理員門（與「編輯固定屬性」/「重新上傳印面圖」同一服務層判定）。 */
const canAddSealFace = computed(() => seals.canAddSealFace())
/** 彈窗開關（成功 / 取消即關；零 localStorage、零跨頁狀態）。 */
const addFaceOpen = ref(false)
/** 頁面級提示（成功 / 冪等命中寫這裡 —— 彈窗關閉後仍留在頁面上）。 */
const addFaceFeedback = ref('')
/** 頁面級成功提示的固定文案（繁體；`s2t(x) === x`，逐字對齊裁定件 §四）。 */
const ADD_FACE_SUCCESS_MESSAGE = '新印面已加入，印面圖與屬性可繼續編輯。'

function openAddSealFace() {
  if (!seal.value) return
  addFaceFeedback.value = ''
  addFaceOpen.value = true
}

function closeAddSealFace() {
  addFaceOpen.value = false
}

/**
 * 建面成功的收尾：關窗 → 頁面級提示 → **重取雲端快照**（與本頁既有寫面同一刷新路徑）。
 * 服務層已重拉一輪；此處再 `dataVersion +1` 讓派生讀數（印面塊 / 影像 / 面數）重算。
 * 若服務層回讀**未**在快照裡看到該面（`verifiedInSnapshot === false`），本頁再拉一輪並重算
 * —— 仍看不到時**不改寫**服務層的如實交代（面行以服務端為準）。
 */
async function onSealFaceAdded(result) {
  addFaceOpen.value = false
  addFaceFeedback.value = (result && result.message) || ADD_FACE_SUCCESS_MESSAGE
  dataVersion.value += 1
  if (result && result.verifiedInSnapshot === false) {
    try {
      await seals.retryDataSource()
    } catch (err) {
      /* 重取失敗不改變已成功的建面結論（文案已如實說明快照狀態）。 */
    }
    dataVersion.value += 1
  }
}

/* ============================================================================
   管理员：**人工智能修復**（印面影像；本单新增）
   ----------------------------------------------------------------------------
   - 入口：印面块管理员动作区按钮（`data-admin-action="ai-enhance-face"`，仅管理员渲染；
     仅**印面（FACE）且已有影像编号**可修 —— 无源图无从修）。
   - 通道：`services/aiEnhance.js` 的**异步三件套**（op `ai-enhance-submit` 提交载荷封闭
     **四键** image_id / seal_id / face_id / **request_id** ⇒ 立即回任务号；`ai-enhance-status`
     每 4 秒轮询；`ai-enhance-list` 列本印面任务）—— 与勘误 / 采纳同一用户令牌通道（含补签
     自愈）。**服务端是唯一判据**；legacy `ai-enhance-face`（同步长调用、网关约 60 秒必掐）
     **前端已不再调用**（常量保留）。
   - **开窗先续接（本单）**：`openAiEnhance` 立即调 `listCandidates(face.id)`（探测期间
     【開始修復】**禁点** ⇒ 不会在既有任务之上重复提交、重复扣金）：
     · 有 `SUBMITTED` / `RUNNING` ⇒ 进「進行中」并**续轮询同一个 task_id**；
     · 有 `READY` 且**尚未被本印面采纳** ⇒ 续接后落「已完成」（右格按 image_id 取图、
       【取】/【棄】可用）；
     · 读不到 / 只有 `FAILED` ⇒ 维持「待確認」（由用户按【開始修復】）。
     任务号按印面记在 `aiEnhanceTaskByFace`（**只在内存**：关窗再开窗能续接）。
   - 弹窗：左格「原圖」＝当前影像、右格「修復圖」＝回包候选影像（两者都走
     `seals.imageDisplaySourceOf`，不自写第二套取图路径）。
   - **先確認再扣金**（Kevin 亲定）：点入口按钮**只开窗、不调 op** —— 弹窗以「待確認」态打开
     （右格「尚未開始」＋ 成本一行明示）；点【開始修復】才真正发请求（**此时才扣金**）。
   - 计费明示：**每张 10 金**（`aiEnhance.AI_ENHANCE_COST`；调用前弹窗内一行小字；
     实际扣费以回包 `charge.amount` 爲准）。
   - 取消 / 关窗：**只停止等待**（`shouldCancel` 当场停掉轮询循环；`enhanceFaceImage` 回 `null`），
     **不撤回服务端任务** —— 任务号仍被记住，重开本窗可续接；在途那一发若已拿到终局回包
     仍被收取（序号不符 ⇒ 落 `aiEnhanceLateReply` 机械读数），**不在前端丢下已到手的回包**。
   - 【取】：**复用现有换图写面** `seals.updateSealFixedAttributes(null, faceId,
     { face_image_id })`（与「編輯固定屬性」同一入口 ⇒ 与 replace-face-image 同语义：
     只改印面指向、**旧行不删**）；**不新增写面 op、不新增影像行**。
   - 【棄】：op `ai-enhance-discard`（载荷封闭一键 image_id；经 `aiEnhance.discardFaceImage`
     **同一条**用户令牌通道；**不涉及退款** —— 修復金在上游成功时已花掉）。
     待办中禁点并显示「正在棄置…」；成功 ⇒ 顶部反馈＋关窗（`deleted_objects` 为真补一句
     「影像物件亦已清除」）；失败 ⇒ **弹窗内**原文透出服务端 message（`FORBIDDEN` /
     `INVALID_VALUE` 等一字不改写）、**不关窗、【取】仍可用**；已棄置态下【棄】disabled
     且文案「已棄置」（**绝不发第二次 discard**）。
   ============================================================================ */

/** 弹窗宿主印面（按 id 挂到 faces 上；空串 ⇒ 不渲染弹窗）。 */
const aiEnhanceFaceId = ref('')
const aiEnhanceFace = computed(() => faces.value.find((item) => item.id === aiEnhanceFaceId.value) || null)
/**
 * 弹窗状态（右格五态）：`confirm`（待確認：开窗未调用、零扣金）/ `running` / `done` / `failed`；
 * `cancelled` ＝ 调用中被取消。
 */
const aiEnhanceStatus = ref('confirm')
/** 回包成功读数（`aiEnhance.enhanceFaceImage` 的成功形状）。 */
const aiEnhanceResult = ref(null)
/** 失败可读文案（**含服务端 message 原文**）。 */
const aiEnhanceError = ref('')
/** 失败回包的 `refunded`（true ⇒ 明示「本次未消耗金」；只由服务端说了算）。 */
const aiEnhanceRefunded = ref(false)
/** 顶部 + 弹窗内的可读反馈（【取】成功 ⇒「影像編號 旧 → 新」；写面失败同样走这里）。 */
const aiEnhanceFeedback = ref('')
/** 【取】写面中（防重复点击）。 */
const aiEnhanceAccepting = ref(false)
/** 【棄】弃置中（待办中禁点、文案「正在棄置…」；防重复点击 ⇒ 绝不发第二次 discard）。 */
const aiEnhanceDiscarding = ref(false)
/** 【棄】失败可读文案（**含服务端 message 原文**；弹窗内可见位置上屏）。 */
const aiEnhanceDiscardError = ref('')
/** 【棄】已弃置（成功后置真 ⇒ 【棄】disabled 且文案「已棄置」；`discardAiEnhance` 首行再拦一道）。 */
const aiEnhanceDiscarded = ref(false)
/** 左格（原圖）/ 右格（修復圖）的取图读数：`{state, id, dataUrl, row, message}`。 */
const aiSourcePane = ref(null)
const aiCandidatePane = ref(null)
/** 在途请求序号：关窗 / 取消 ⇒ +1 ⇒ 在途回包不再改写界面（但**仍被收取**，见 `aiEnhanceLateReply`）。 */
let aiEnhanceRequestSeq = 0
/** 取消 / 关窗后仍在后台收到的回包（**机械读数**：证明回包未被前端丢下）。 */
const aiEnhanceLateReply = ref(null)
/** 开窗探测（`listCandidates`）在途：【開始修復】**禁点** —— 不在既有任务之上重复提交、重复扣金。 */
const aiEnhanceProbing = ref(false)
/**
 * 本组件记住的「印面編號 → 雲端任務號」（**只在内存**，非渲染态 ⇒ 不进响应式）：
 * 关窗 / 取消后重开同一印面仍能续接同一个 `task_id`；采纳（【取】）或弃置（【棄】）成功后清除
 * （下次【開始修復】才是新任务）。**零 localStorage**（与令牌同一「不落浏览器存储」口径）。
 * @type {Map<string, string>}
 */
const aiEnhanceTaskByFace = new Map()

/** 成本小字（调用前明示；实际扣费以回包 charge 爲准）。 */
const aiEnhanceCost = aiEnhance.AI_ENHANCE_COST

/** 管理员门：与「編輯固定屬性」同一服务层判定（`role === 'admin'`；非管理员 / 游客 ⇒ 不渲染）。 */
const canAiEnhanceFace = computed(() => seals.canEditFixedAttributes())

/** 【取】可用性：**仅回包成功**（`done` 且有修復影像编号）才可点。 */
const aiEnhanceAcceptable = computed(
  () => aiEnhanceStatus.value === 'done' && Boolean(aiEnhanceResult.value && aiEnhanceResult.value.imageId)
)

/**
 * 【棄】可用性：与【取】同一前提（**仅回包成功**才有候选件可弃）＋ 未在途 ＋ 未已弃置
 * （已弃置 ⇒ 按钮 disabled、文案「已棄置」，**绝不发第二次 discard**）。
 */
const aiEnhanceDiscardable = computed(
  () => aiEnhanceAcceptable.value && !aiEnhanceDiscarding.value && !aiEnhanceDiscarded.value
)

/** 【棄】按钮文案（待办 / 已弃置 / 默认三档；computed 化 ⇒ 模板零嵌套三元）。 */
const aiEnhanceDiscardLabel = computed(() => {
  if (aiEnhanceDiscarding.value) return '正在棄置…'
  if (aiEnhanceDiscarded.value) return '已棄置'
  return '棄'
})

/** 扣费读数（**不编造数字**：回包未附 charge ⇒ 如实写「未記載」）。 */
const aiEnhanceChargeText = computed(() => {
  const result = aiEnhanceResult.value
  if (!result || !result.charge) return '回包未附扣費記載（charge）；本次實際扣費以服務端記載爲準。'
  const amount = Number.isFinite(result.charge.amount) ? `${result.charge.amount} 金` : '（未記載）'
  const balance = Number.isFinite(result.charge.balance) ? `${result.charge.balance} 金` : '（未記載）'
  return `本次扣費 ${amount} · 扣後餘額 ${balance}`
})

/**
 * **传输层失败**的上屏判定：文案逐字 ＝ `aiEnhance.AI_ENHANCE_TRANSPORT_MESSAGE`
 * （服务层在传输层 / 形状失败时**换上的那句**，即全站共用传输文案的替代句）。
 * 命中 ⇒ 失败格**整句照抄该文案**（不加「修復失敗：」前缀、不接退款尾句）；
 * 未命中 ⇒ 一律「修復失敗：＋ 服务端 message」（退款尾句只在 `refunded` 为真时接）。
 */
const aiEnhanceTransport = computed(
  () => aiEnhanceStatus.value === 'failed' && aiEnhanceError.value === aiEnhance.AI_ENHANCE_TRANSPORT_MESSAGE
)

/** 取消后仍在后台收到的回包（**可见落点**：如实写「已收取」＋成败；证明未丢回包、未改指向）。 */
const aiEnhanceLateReplyTag = computed(() => {
  const reply = aiEnhanceLateReply.value
  if (!reply) return ''
  return reply.ok
    ? `回包已收取：修復成功（影像編號 ${reply.imageId}），本次未採用、印面指向未變。`
    : `回包已收取：修復失敗（${reply.reason || '未知原因'}），本次未採用、印面指向未變。`
})

/** 影像编号 → 弹窗格读数（**走 `seals.imageDisplaySourceOf`**；不自写第二套取图路径）。 */
async function aiPaneOf(imageId) {
  const id = String(imageId || '')
  if (!id) return { state: 'empty', id: '', dataUrl: '', row: null, message: '本印面沒有影像編號，無從修復。' }
  const out = await seals.imageDisplaySourceOf(id)
  const source = seals.imageSourceOf(id) || { row: null }
  if (!out.ok) {
    return { state: 'error', id, dataUrl: '', row: source.row || null, message: out.message || '影像暫時無法顯示。' }
  }
  /* digest 行（二进制在服务端权威库）无 dataURL ⇒ 交给 SliceImage 按 digest 取块面；
     其余（含云端展示件整件）有 dataURL ⇒ 直接 `<img>` 呈现。 */
  return {
    state: out.via === 'digest' ? 'digest' : 'ready',
    id,
    dataUrl: out.dataUrl || '',
    row: source.row || null,
    message: ''
  }
}

/**
 * 右格取候选图（**只走 `seals.imageDisplaySourceOf`**，不自写第二套取图路径）。
 *
 * 为什么要补一轮快照重拉：候选行**刚在服务端落库**（或本页水合在它之前）⇒ 云端快照里还没有
 * 该行 ⇒ 第一次取图会回「找不到」；这不是「没有这张图」⇒ `seals.retryDataSource()` 重拉一輪
 * 快照再取一次。仍取不到 ⇒ **如实交失败读数**（不假报成功、不编造 dataURL）。
 * @param {string} imageId 候选影像编号
 * @param {number} seq 发起时的在途序号（序号已变 ⇒ 不再改写界面）
 */
async function loadAiCandidatePane(imageId, seq) {
  const id = String(imageId || '')
  if (seq === aiEnhanceRequestSeq) {
    aiCandidatePane.value = { state: 'loading', id, dataUrl: '', row: null, message: '' }
  }
  let pane = await aiPaneOf(id)
  if (pane.state === 'error') {
    try {
      await seals.retryDataSource()
    } catch {
      /* 快照重拉失败 ⇒ 交原失败读数（**不改判、不编造**）。 */
    }
    pane = await aiPaneOf(id)
  }
  if (seq === aiEnhanceRequestSeq) aiCandidatePane.value = pane
}

/**
 * 发起 / **续接**一次修復（**只由【開始修復】或开窗续接触发**；新任务此时才扣金；
 * 弹窗内另有可取消入口 —— 取消只停止等待、**不撤回服务端任务**）。
 *
 * @param {object} face 印面
 * @param {{taskId?:string, sourceImageId?:string}} [resume] 续接既有任务（开窗探测命中 ⇒ 不再 submit）
 */
async function runAiEnhance(face, resume) {
  const held = resume || {}
  const seq = (aiEnhanceRequestSeq += 1)
  aiEnhanceStatus.value = 'running'
  aiEnhanceResult.value = null
  aiEnhanceError.value = ''
  aiEnhanceRefunded.value = false
  aiEnhanceLateReply.value = null
  aiEnhanceDiscarding.value = false
  aiEnhanceDiscardError.value = ''
  aiEnhanceDiscarded.value = false
  const sealId = seal.value ? seal.value.stamp_id : face.sealId || face.stamp_id || ''
  const reply = await aiEnhance.enhanceFaceImage(
    {
      image_id: face.face_image_id,
      seal_id: sealId,
      face_id: face.id
    },
    {
      taskId: held.taskId || '',
      sourceImageId: held.sourceImageId || '',
      /* 任务号一到手就记住（关窗 / 取消后重开仍可续接；本组件零存储）。 */
      onTask: (taskId) => {
        if (seq === aiEnhanceRequestSeq) aiEnhanceTaskByFace.set(face.id, String(taskId || ''))
      },
      /* 取消 / 关窗 / 卸载 ⇒ **只停止等待**（服务端任务不撤回）。 */
      shouldCancel: () => seq !== aiEnhanceRequestSeq
    }
  )
  /* 回包**一定被收取**（本 await 即收取动作，promise 终点有明确去处）——序号不符
     （已取消 / 已关窗）⇒ 只落机械读数（`null` ＝ 等待已被主动停止），不改界面。 */
  if (seq !== aiEnhanceRequestSeq) {
    aiEnhanceLateReply.value = reply || null
    return
  }
  /* `null` ＝ 用户主动停止等待（序号必已变，理论到不了这里；留一道防呆不碰任何状态）。 */
  if (!reply) return
  if (!reply.ok) {
    aiEnhanceStatus.value = 'failed'
    aiEnhanceError.value = reply.message
    aiEnhanceRefunded.value = reply.refunded === true
    /* 服务端已判死该任务（或提交根本没成）⇒ 清掉记住的任务号（下次【開始修復】才是新任务）；
       **传输层 / 逾时失败不清** —— 任务可能仍在云端跑，留着才能续接。 */
    if (reply.reason !== 'STORAGE_UNAVAILABLE') aiEnhanceTaskByFace.delete(face.id)
    return
  }
  aiEnhanceResult.value = reply
  aiEnhanceStatus.value = 'done'
  /* 右格按**新影像编号**取回展示源（同样走 `imageDisplaySourceOf`）。 */
  await loadAiCandidatePane(reply.imageId, seq)
}

/**
 * 开窗：**只开窗、不扣金** —— 弹窗以「待確認」态打开（右格「尚未開始」，
 * 左格原圖照常取图）。开窗同时**先探一次云端未完成任务**（`listCandidates`，见
 * `probeAiEnhance`）：命中 ⇒ 自动续接（**不再 submit、不再扣金**）；没命中 ⇒ 真正发请求仍由
 * 【開始修復】（`startAiEnhance`）触发。
 */
function openAiEnhance(face) {
  aiEnhanceFeedback.value = ''
  aiEnhanceResult.value = null
  aiEnhanceError.value = ''
  aiEnhanceRefunded.value = false
  aiEnhanceLateReply.value = null
  aiEnhanceDiscarding.value = false
  aiEnhanceDiscardError.value = ''
  aiEnhanceDiscarded.value = false
  aiEnhanceStatus.value = 'confirm'
  aiEnhanceProbing.value = true
  aiEnhanceFaceId.value = face.id
  /* 左格：当前影像（原圖，开窗即取）；右格：待確認态不取图（尚未發出任何請求）。 */
  aiSourcePane.value = { state: 'loading', id: String(face.face_image_id || ''), dataUrl: '', row: null, message: '' }
  aiCandidatePane.value = null
  void aiPaneOf(face.face_image_id).then((pane) => {
    if (aiEnhanceFaceId.value === face.id) aiSourcePane.value = pane
  })
  void probeAiEnhance(face)
}

/** 列表行的时间戳读数（`created_at` 可能是秒 / 毫秒 / ISO 串 ⇒ 统一成可比大小的数字；取不到 ⇒ 0）。 */
function aiTaskStamp(row) {
  const raw = row ? row.created_at : null
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && raw !== null && raw !== undefined && raw !== '') return numeric
  const parsed = Date.parse(String(raw === undefined || raw === null ? '' : raw))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * **开窗先探云端任务**（op `ai-enhance-list`）以**续接**未完成的修復 —— 只在「待確認」态发起，
 * 且**只由 `openAiEnhance` 触发**（绝不在 render 期发请求、不写响应式状态）。
 *
 * 分流（服务端行面为准）：
 *  · `SUBMITTED` / `RUNNING` ⇒ 进「進行中」并**续轮询同一个 `task_id`**（在途任务优先，
 *    否则会把跑着的任务晾在一边）；
 *  · `READY` 且 `image_id` **尚未被本印面采纳** ⇒ 续接后落「已完成」（右格按 image_id 取图、
 *    【取】/【棄】可用）—— 已采纳的候选**不接**（否则【棄】会指向当前印面图）；
 *  · 列表读不到（传输 / 形状失败）⇒ **退回本组件记住的任务号**（关窗前那次提交的）；
 *  · 列表读到但无可用行 ⇒ 维持「待確認」（由用户按【開始修復】）。
 */
async function probeAiEnhance(face) {
  const remembered = String(aiEnhanceTaskByFace.get(face.id) || '')
  try {
    const listed = await aiEnhance.listCandidates(face.id)
    /* 开窗态已变（关窗 / 已开始 / 换面）⇒ 不再改写任何界面状态。 */
    if (aiEnhanceFaceId.value !== face.id || aiEnhanceStatus.value !== 'confirm') return
    if (!listed || listed.ok !== true || !Array.isArray(listed.rows)) {
      /* 列表读不到 ⇒ 退回记住的任务号（服务端任务可能仍在跑；读不到 ≠ 没有任务）。 */
      if (remembered) runAiEnhance(face, { taskId: remembered })
      return
    }
    const adoptedId = face.face_image_id ? String(face.face_image_id) : ''
    const rows = listed.rows.filter((row) => row && typeof row === 'object')
    const idOf = (row) => (typeof row.task_id === 'string' ? row.task_id.trim() : '')
    const newest = (list) => list.slice().sort((a, b) => aiTaskStamp(b) - aiTaskStamp(a))[0] || null
    const pending = rows.filter(
      (row) => idOf(row) && (row.status === 'SUBMITTED' || row.status === 'RUNNING')
    )
    const ready = rows.filter(
      (row) => idOf(row) && row.status === 'READY' && String(row.image_id || '') !== adoptedId
    )
    const target = newest(pending) || newest(ready)
    const taskId = target ? idOf(target) : ''
    if (!taskId) return
    aiEnhanceTaskByFace.set(face.id, taskId)
    runAiEnhance(face, { taskId, sourceImageId: String(target.source_image_id || '') })
  } finally {
    /* 探测无论成败都放行【開始修復】（只在仍是本面的「待確認」态时改，避免覆盖续接后的状态）。 */
    if (aiEnhanceFaceId.value === face.id && aiEnhanceStatus.value === 'confirm') {
      aiEnhanceProbing.value = false
    }
  }
}

/** 【開始修復】：确认成本后才真正发起修復调用（**此时才扣金**；只在待確認态可点）。
 *  探测（`listCandidates`）在途 ⇒ **禁点**：不在既有任务之上重复提交、重复扣金。 */
function startAiEnhance() {
  const face = aiEnhanceFace.value
  if (!face || aiEnhanceStatus.value !== 'confirm' || aiEnhanceProbing.value) return
  aiCandidatePane.value = { state: 'loading', id: '', dataUrl: '', row: null, message: '' }
  runAiEnhance(face)
}

/** 取消：只停止等待（**服务端任务不撤回**）；在途那一发若已拿到终局回包仍被收取 ⇒ 不丢已到手的回包。 */
function cancelAiEnhanceRun() {
  aiEnhanceRequestSeq += 1
  aiEnhanceStatus.value = 'cancelled'
}

function closeAiEnhance() {
  /* 关窗同样只作废界面态：**停止等待**（轮询循环按 `shouldCancel` 当场停、服务端任务不撤回，
     任务号仍被记住 ⇒ 重开本窗可续接）；在途那一发若已拿到终局回包仍由 `runAiEnhance` 收取
     （序号不符 ⇒ 落机械读数）。 */
  aiEnhanceRequestSeq += 1
  aiEnhanceProbing.value = false
  aiEnhanceFaceId.value = ''
  aiSourcePane.value = null
  aiCandidatePane.value = null
}

/**
 * 【棄】：弃置刚得到的候选修復影像 —— op `ai-enhance-discard`（**载荷恰一键 image_id**；
 * 经 `aiEnhance.discardFaceImage` 走**同一条**用户令牌通道）。**不涉及退款**（修復金已在
 * 上游成功时花掉 ⇒ 文案里不承诺退金）。
 *  · 待办中：禁点 ＋ 文案「正在棄置…」（首行拦截 ⇒ **绝不发第二次 discard**）；
 *  · 成功（`ok === true`）：顶部反馈「候選圖已棄置（影像編號 X）」＋ `deleted_objects`
 *    为真补一句「影像物件亦已清除」⇒ **关窗**（印面指向不变 —— 候选件从未被【取】采纳）；
 *  · 失败：**弹窗内**原文透出服务端 `message`（`FORBIDDEN` / `INVALID_VALUE` 等一字不改写）、
 *    **不关窗**、【取】仍可用（候选影像行是否已被移除的判定权在服务端）。
 */
async function discardAiEnhance() {
  const result = aiEnhanceResult.value
  const imageId = result && result.imageId ? String(result.imageId) : ''
  /* 首行拦截：已弃置 / 在途 / 无候选编号 ⇒ 零请求（【關閉】永不触发本函数 ⇒ 关窗不会补发 discard）。 */
  if (!imageId || aiEnhanceDiscarding.value || aiEnhanceDiscarded.value) return
  aiEnhanceDiscarding.value = true
  aiEnhanceDiscardError.value = ''
  try {
    const reply = await aiEnhance.discardFaceImage(imageId)
    if (!reply.ok) {
      /* 失败：服务端 message **原文上屏**（不吞真因、不改写）；弹窗不关、【取】仍可用。 */
      aiEnhanceDiscardError.value = reply.message || '棄置候選圖未生效（請稍後再試）。'
      return
    }
    aiEnhanceDiscarded.value = true
    aiEnhanceFeedback.value = reply.deletedObjects
      ? `候選圖已棄置（影像編號 ${reply.imageId}）；影像物件亦已清除。印面指向未變。`
      : `候選圖已棄置（影像編號 ${reply.imageId}）。印面指向未變。`
    /* 候选件已弃置 ⇒ 清掉记住的任务号（下次【開始修復】才是新任务；重开本窗不再接它）。 */
    aiEnhanceTaskByFace.delete(aiEnhanceFaceId.value)
    /* 派生读数立即刷新（候选件已移除，右格不再渲染它）。 */
    dataVersion.value += 1
    closeAiEnhance()
  } finally {
    aiEnhanceDiscarding.value = false
  }
}

/**
 * 「全站共用传输 / 形状文案」**不得**出现在 AI 修復场景的失败上屏（本单硬口径）：【取】走的是
 * 全站共用写面（其传输文案 `cloudbaseFn.js::TRANSPORT_MESSAGES.*` 前缀「雲端校驗…」），而照抄它
 * 在此处是**假话**（修復任务可能已提交、扣金已预扣；指向写入也可能只差回读）⇒ 命中即换成本句。
 * **只换展示文案、不改判成败**（`ok` 仍由服务层说了算）。
 * @param {string} message 服务层原话
 * @returns {string}
 */
function aiWriteMessageOf(message) {
  const text = String(message === undefined || message === null ? '' : message)
  return text.includes('雲端校驗') ? '雲端連線失敗；印面指向未變，可稍後重試。' : text
}

/**
 * 【取】：把本印面 `face_image_id` 指向修復影像 —— **复用现有换图写面**
 * `seals.updateSealFixedAttributes(null, faceId, patch)`（与「編輯固定屬性」同一入口；
 * 与 replace-face-image 同语义：只改指向、**旧行不删**；**不新增写面 op**）。
 * 成功 ⇒ 顶部反馈「影像編號 旧 → 新；舊影像與二進制保留（可回溯）」＋
 * **① 作废旧编号 dataUrl 缓存**（服务层唯一失效口 `seals.invalidateImageDataUrl`）
 * ＋ **② 云端快照重读**（`retryDataSource()`：清一次性读数 ＋ 重拉云端 —— 印面指向已在
 * 服务端改写，只有重读云端 `faceImageIds` 才含新编号）＋ `dataVersion + 1`
 * ⇒ **不刷整页也立即显示新图**（旧图行与二进制仍保留、可回溯）。
 */
async function acceptAiEnhance() {
  const face = aiEnhanceFace.value
  const result = aiEnhanceResult.value
  if (!face || !result || !aiEnhanceAcceptable.value || aiEnhanceAccepting.value) return
  const previousId = face.face_image_id ? String(face.face_image_id) : ''
  const nextId = String(result.imageId)
  aiEnhanceAccepting.value = true
  try {
    const written = await seals.updateSealFixedAttributes(null, face.id, { face_image_id: nextId })
    if (!written || written.ok !== true) {
      aiEnhanceFeedback.value = `取用修復圖未生效：${aiWriteMessageOf((written && written.message) || '未知原因')}（印面指向未變）`
      return
    }
    aiEnhanceFeedback.value = `影像編號 ${previousId || '（原無）'} → ${nextId}；舊影像與二進制保留（可回溯）。`
    /* 该任务已被采纳 ⇒ 清掉记住的任务号（下次【開始修復】才是新任务；重开本窗也不再把它当候选）。 */
    aiEnhanceTaskByFace.delete(face.id)
    /* **强制失效旧 id 的 dataUrl 缓存**（服务层唯一失效口；页面登记的清理函数按编号清）。
       旧影像**本身不删** —— 作废的只是缓存条目，下次取它仍会照常读回。 */
    if (previousId) seals.invalidateImageDataUrl(previousId)
    /* **立即显示新图（不刷整页）**：派生读数重算 ＋ 清一次性读数（新编号若早先取字节失败，
       错误缓存会永久挡住它）＋ **云端快照重读**（服务端指向已改，重读后 `faceImageIds`
       才含新编号 ⇒ 才会去取新图）。 */
    dataVersion.value += 1
    retryDataSource()
    closeAiEnhance()
  } finally {
    aiEnhanceAccepting.value = false
  }
}

onBeforeUnmount(() => {
  releaseReplaceSource()
  /* 注销本页的逐影像 dataUrl 缓存持有者（不给服务层留悬挂引用）。 */
  unregisterImageDataUrlCache()
  /* 在途的 AI 修復请求：作废界面态（回包仍被收取，见 `runAiEnhance`）。 */
  aiEnhanceRequestSeq += 1
})
</script>

<template>
  <!-- 受控诊断面：**仅 `?diag=1`** 渲染（无该参数 ⇒ `v-if` 恒 false ⇒ DOM 零命中）。
       只读取证：包名 / 读写形态 / 勘误服务层最近 20 条里程碑 ＋ 一键复制。 -->
  <div
    v-if="diagOn"
    data-diag-panel
    class="notice detail__notice"
    style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5"
  >
    <div style="display: flex; gap: 8px; align-items: center; justify-content: space-between">
      <strong>診斷面（?diag=1）</strong>
      <button class="btn btn--ghost" type="button" @click="copyDiagText">複製到剪貼板</button>
    </div>
    <div>包名：{{ diagBundle }}</div>
    <div>讀寫形態：{{ diagMode }}</div>
    <div style="max-height: 240px; overflow: auto; white-space: pre">
      <div v-for="(line, index) in diagLines" :key="index">{{ line }}</div>
      <div v-if="!diagLines.length">（尚無里程碑）</div>
    </div>
  </div>
  <!-- **孤兒印章行提示（本頁頂部）**：本機有、雲端快照沒有的印章行已不再渲染，
       只提示一行 ＋ 給**與廣場頁同一入口**（`data-action="local-db-clear"`）；
       清除失敗的原話也在此上屏（不假報成功）。雲端未落定 ⇒ 計數 0 ⇒ 不渲染。 -->
  <div
    v-if="orphanCount > 0 || clearFeedback"
    class="notice detail__notice"
    data-local-orphan="detail"
  >
    <span v-if="orphanCount > 0">本機有 {{ orphanCount }} 枚印章不在雲端（已不再顯示）。</span>
    <span v-if="clearFeedback">{{ clearFeedback }}</span>
    <button
      v-if="canClearLocal && orphanCount > 0"
      class="btn btn--ghost"
      type="button"
      data-action="local-db-clear"
      @click="askClearLocal"
    >
      清除本機資料
    </button>
  </div>
  <section v-if="seal">
    <div class="page-head detail__head">
      <div>
        <h1>{{ corrections.resolveSealDisplayName(seal) }}</h1>
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
        <!-- 「刪除印章」（管理员专属｜本单）：非管理员 / 游客 ⇒ **不渲染**（DOM 零命中；
             不得 CSS 隐藏 / `disabled` 冒充）。钩子只用 `data-action="seal-delete"`
             （**不新增 `data-admin-action` 取值**，管理员钩子取值集合仍为规范冻结值）。 -->
        <button
          v-if="canDeleteSeal"
          class="btn btn--ghost"
          type="button"
          data-action="seal-delete"
          :disabled="sealDeleteBusy"
          @click="openSealDelete"
        >
          刪除印章
        </button>
      </div>
    </div>

    <!-- 刪除印章的可读反馈（**失败**上屏；成功已跳回广场并带一次性提示）。 -->
    <p v-if="sealDeleteFeedback" class="notice detail__notice" data-seal-delete-feedback>
      {{ sealDeleteFeedback }}
    </p>

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

    <!-- 人工智能修復的可读反馈（【取】成功 ⇒「影像編號 旧 → 新」；写面失败同样走这里）。 -->
    <p v-if="aiEnhanceFeedback" class="notice detail__notice" data-admin-feedback="ai-enhance-accept">
      {{ aiEnhanceFeedback }}
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

    <!-- **「印面列表」區塊標題 ＋ 新增入口（本單）**：入口**恰一個**，在 `v-for` 之外
         （不逐塊複製 ⇒ N 個印面也只有 1 個按鈕）；管理員專屬，遊客 / 普通使用者 ⇒ 不渲染
         （DOM 零命中，**不得** CSS 隱藏 / `disabled` 冒充）。鉤子只用
         `data-action="add-seal-face"` —— **不進** `[data-admin-action]` 族（該族取值集合已凍結）。 -->
    <div class="detail__faces-head" data-face-list-head>
      <h2 class="detail__faces-title">印面列表</h2>
      <button
        v-if="canAddSealFace"
        class="btn btn--ghost"
        type="button"
        data-action="add-seal-face"
        @click="openAddSealFace"
      >
        新增印面
      </button>
    </div>

    <!-- 新增印面的**頁面級**提示（成功 / 冪等命中；彈窗關閉後仍留在頁面上，繁體）。 -->
    <p v-if="addFaceFeedback" class="notice detail__notice" data-add-face-notice>
      {{ addFaceFeedback }}
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
          <span class="face-block__name">{{ corrections.resolveSealDisplayName(face) }}</span>
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
          <!-- 管理员专属（普通用户 / 游客 ⇒ 不渲染，DOM 零命中）：**人工智能修復**本印面的印面图。
               仅**印面（FACE）且已有影像编号**可修（无源图无从修 ⇒ 边款 / 无图印面不呈现此按钮）；
               管理员门沿用既有服务层判定（`canEditFixedAttributes`，role === 'admin'）。 -->
          <button
            v-if="canAiEnhanceFace && !face.isEdge && face.face_image_id"
            class="btn btn--ghost"
            type="button"
            data-admin-action="ai-enhance-face"
            :data-face-id="face.id"
            @click="openAiEnhance(face)"
          >
            人工智能修復
          </button>
        </div>
      </div>
      <div class="panel__body">
        <!-- 印面級識別編碼：該印面缺 `fid`（歷史/異常行）⇒ 整行不渲染（不佔位、不回落 `face.id`）。 -->
        <p v-if="face.fid" class="detail__id" :data-face-code="face.fid">編號 {{ face.fid }}</p>
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
          <figure v-if="face.face_image_id" class="face-block__figure" data-face-image-card>
            <figcaption>印面影像 {{ face.face_image_id }}</figcaption>
            <!-- 管理员专属【刪除】（普通用户 / 游客 ⇒ 不渲染，DOM 零命中；**不得** CSS 隐藏 /
                 `disabled` 冒充）：影像卡片上的**独立钩子** `data-action="image-delete"`
                 （**不新增 `data-admin-action` 取值**；与 `seal-delete` / `local-db-clear` 同族）。
                 旧图**不自动删** ⇒ 删只能由管理员在此显式点按（二次确认另挂
                 `image-delete-confirm` / `image-delete-cancel`）。 -->
            <button
              v-if="canDeleteFaceImage"
              class="btn btn--ghost"
              type="button"
              data-action="image-delete"
              :data-face-id="face.id"
              :data-image-id="face.face_image_id"
              :disabled="faceImageDeleteBusy"
              @click="openFaceImageDelete(face)"
            >
              刪除
            </button>
            <!-- 影像勘誤入口已**并入**「可標記屬性」区的**唯一**【勘誤】入口（本單：两个入口合一）：
                 本影像卡不再单列【勘誤】钮（页面上 `/^勘誤$/` 的可见按钮因此恰 1 个）；影像操作
                 移到合并弹窗的「影像」页签内完成，页签内保留 `data-action="image-correction"` 钩子
                 （**不新增 `data-admin-action` 取值**）；登录门 / 提交链路逐字不变。
                 管理员【刪除】路径（下钮）不受影响（两条路径互不替代）。 -->
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
              <!-- 影像勘誤入口已**并入**「可標記屬性」区的**唯一**【勘誤】钮（本單：两入口合一）：
                   本邊款影像卡不再单列【勘誤】；目标影像在合并弹窗「影像」页签内选（多图时给选择器）。 -->
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

        <!-- **印人信息区（印人批 2｜本单新增）**：展示该作者（引用型 `author_person_id` → 印人）
             的**籍貫 / 傳記**；**只展示正字段（繁体）**，`*_chs` 副字段不上屏；作者显示名仍走单点链。
             **不可达 ⇒ 优雅降级**（整区不渲染，不报错、不编造）。 -->
        <template v-if="personInfoOf(face)">
          <h3 class="face-block__sub">印人信息</h3>
          <dl class="detail__fixed" data-face-person-info>
            <div>
              <dt>印人</dt>
              <dd>{{ personInfoOf(face).name }}</dd>
            </div>
            <div v-if="personInfoOf(face).nativePlace">
              <dt>籍貫</dt>
              <dd data-face-person-native-place>{{ personInfoOf(face).nativePlace }}</dd>
            </div>
            <div v-if="personInfoOf(face).biography">
              <dt>傳記</dt>
              <dd data-face-person-biography>{{ personInfoOf(face).biography }}</dd>
            </div>
          </dl>
        </template>

        <h3 class="face-block__sub">可標記屬性</h3>
        <!-- 勘误反馈的**页面级上屏位**（本单）：弹窗提交成功即关 ⇒ 文案随弹窗消失 ⇒ 同一份
             文案（繁体一字不改）同步落在这里；只在提交来源那一块呈现，不逐块复制。
             **无定时器**：只在重开勘误弹窗 / 切换印面 / 重新加载印面时清空。 -->
        <p
          v-if="correctionNotice && correctionNoticeFaceId === face.id"
          class="notice detail__notice"
          data-correction-notice
        >
          {{ correctionNotice }}
        </p>
        <div class="face-block__sub-head">
          <button v-if="canSubmit" class="btn btn--ghost" type="button" @click="openCorrection(face)">勘誤</button>
          <span v-else class="detail__hint">登錄後可提交勘誤，審覈通過後每條獎勵 {{ points.CORRECTION_REWARD }} 金。</span>
          <!-- **印人提案入口（P1-3）**：**与登录态解耦** —— 一律渲染、可见可达（落点在「可標記屬性」区，
               **不埋进**登录后才展开的勘誤表单、**不用 CSS 隐藏 / disabled 冒充**）。
               未登录点击 ⇒ `openPersonProposal` 走**登录引导**（`goLogin`，不静默失败）；
               登录点击 ⇒ 就地展开下方提案表单。 -->
          <button
            class="btn btn--ghost"
            type="button"
            data-action="person-proposal-open"
            data-person-proposal-entry="detail-markable"
            @click="formFaceId = face.id; openPersonProposal(face)"
          >
            提交印人提案
          </button>
        </div>
        <!-- 印人提案内联表单（**唯一实例**：仅目标印面渲染，避免多印面重复；由 `proposalOpen` 控制，
             与登录态无关 —— 未登录时该表单不展开，但上方入口照常可见）。 -->
        <div v-if="proposalOpen && formFaceId === face.id" class="proposal-form" data-person-proposal-form>
          <h4 class="proposal-form__title">提交印人提案</h4>
          <div class="field">
            <label for="pp-family">姓</label>
            <input id="pp-family" v-model="proposal.familyName" type="text" data-person-proposal-family />
          </div>
          <div class="field">
            <label for="pp-given">名</label>
            <input id="pp-given" v-model="proposal.givenName" type="text" data-person-proposal-given />
          </div>
          <div class="field">
            <label for="pp-courtesy">字（多個以逗號分隔）</label>
            <input id="pp-courtesy" v-model="proposal.courtesy" type="text" data-person-proposal-courtesy />
          </div>
          <div class="field">
            <label for="pp-art">號（多個以逗號分隔）</label>
            <input id="pp-art" v-model="proposal.art" type="text" data-person-proposal-art />
          </div>
          <div class="field">
            <label for="pp-alias">別名（多個以逗號分隔）</label>
            <input id="pp-alias" v-model="proposal.alias" type="text" data-person-proposal-alias />
          </div>
          <div class="field">
            <label for="pp-birth">生年（公元，可空）</label>
            <input id="pp-birth" v-model="proposal.birthYear" type="text" data-person-proposal-birth />
          </div>
          <div class="field">
            <label for="pp-death">卒年（公元，可空）</label>
            <input id="pp-death" v-model="proposal.deathYear" type="text" data-person-proposal-death />
          </div>
          <div class="field">
            <label for="pp-cbdb">CBDB id（可空）</label>
            <input id="pp-cbdb" v-model="proposal.cbdbId" type="text" data-person-proposal-cbdb />
          </div>
          <!-- **批 2（v1.54｜人类已拍 ①③）**：提案表单亦收四扩字段（籍贯 / 传记 / 来源 / 来源 id）。
               繁體錄入 ＝ **變體 C**：**軟提示 ＋ 既有「一鍵轉繁」三動作鈕**（TextTransformButtons）；
               **不強制、不拒收、不自動改寫**（不得攔截提交 ⇒ 四字段全空亦可提交；
               提交值 ＝ 用戶所見的當前值，逐字，沿 §3.16「不轉用戶輸入」）。 -->
          <p class="proposal-form__trad-hint" data-person-proposal-trad-hint>
            建議使用繁體字填寫（不強制，留空亦可提交；系統不自動轉換）。
          </p>
          <div class="field">
            <label for="pp-native-place">籍貫</label>
            <input id="pp-native-place" v-model="proposal.nativePlace" type="text" data-person-proposal-native-place />
            <TextTransformButtons v-model="proposal.nativePlace" field-key="person-proposal:native_place" field-label="籍貫" />
          </div>
          <div class="field">
            <label for="pp-biography">傳記</label>
            <input id="pp-biography" v-model="proposal.biography" type="text" data-person-proposal-biography />
            <TextTransformButtons v-model="proposal.biography" field-key="person-proposal:biography" field-label="傳記" />
          </div>
          <div class="field">
            <label for="pp-source">來源</label>
            <input id="pp-source" v-model="proposal.source" type="text" data-person-proposal-source />
            <TextTransformButtons v-model="proposal.source" field-key="person-proposal:source" field-label="來源" />
          </div>
          <div class="field">
            <label for="pp-source-id">來源 id</label>
            <input id="pp-source-id" v-model="proposal.sourceId" type="text" data-person-proposal-source-id />
            <TextTransformButtons v-model="proposal.sourceId" field-key="person-proposal:source_id" field-label="來源 id" />
          </div>
          <div class="field">
            <label for="pp-note">依據（選填）</label>
            <input id="pp-note" v-model="proposal.note" type="text" data-person-proposal-note />
          </div>
          <p v-if="proposalFeedback" class="notice" data-person-proposal-feedback>{{ proposalFeedback }}</p>
          <div class="proposal-form__foot">
            <button
              class="btn btn--primary"
              type="button"
              data-action="person-proposal-submit"
              :disabled="proposalBusy"
              @click="submitPersonProposalForm"
            >
              提交提案
            </button>
          </div>
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
                <span class="detail__value">{{ detailDisplayOf(face, item) }}</span>
                <span v-if="item.source === 'CORRECTION'" class="detail__origin">
                  原始值：{{ item.original || '未著錄' }}
                </span>
                <!-- **校驗作者（本單）**：作者行旁的入口（钩子 `data-author-verify`）。
                     **一律渲染**（游客可见、可达）⇒ 点击走既有登录门（`openAuthorVerify` 的
                     `!canSubmit ⇒ goLogin`，与【勘誤】入口同一口径、不另造文案）；
                     不 CSS 隐藏、不用 disabled 冒充游客态。 -->
                <button
                  v-if="item.key === 'author'"
                  class="btn btn--ghost"
                  type="button"
                  data-author-verify
                  :disabled="authorVerifyBusy"
                  @click="openAuthorVerify(face)"
                >
                  校驗作者
                </button>
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

        <!-- **採信（本单新增）**：「可標記屬性」区 —— 就地列出**候选值**
             （值 ＋「N 人提交 / M 人採信」＋ 状态）与【採信】按钮；数据源 ＝ 值级公开摘要面
             （`xiai_correction_summaries` ⇒ 跨浏览器可见）。
             · 按钮一律用 `data-action`（**不得**用 `data-admin-action`，否则管理员钩子取值集合被撑破）；
             · 未登錄 ⇒ 按钮照渲染，点击走登录引导（`actionable:false`）；
             · 自己的提交 / 已 `ACCEPTED` / 已 `REJECTED` ⇒ 不出【採信】按钮
               （分别登记 `data-endorse-self` / `data-endorse-accepted` / `data-endorse-rejected`）；
             · **已 `REJECTED` 另给【重新提交】入口**（`data-action="correction-resubmit"`，
               **不得**用 `data-admin-action`）：回填该候选值到既有勘误表单后走现有提交路径
               （`onResubmitRejected` ⇒ `submitCorrection`，零新增写口），并附一句解释。 -->
        <div
          v-if="endorsementEntries(face).length"
          class="endorse"
          data-endorse-block
          :data-endorse-face="face.id"
        >
          <h4 class="endorse__title">候選值 · 可採信</h4>
          <ul class="endorse__list">
            <li
              v-for="entry in endorsementEntries(face)"
              :key="`${face.id}-${entry.field}-${entry.value}`"
              class="endorse__item"
              data-endorse-entry
              :data-endorse-field="entry.field"
              :data-endorse-status="entry.status"
            >
              <span class="endorse__field">{{ entry.label }}</span>
              <span class="endorse__value" data-endorse-value>{{ entry.value }}</span>
              <span class="endorse__count" data-endorse-count>{{ entry.submits }} 人提交 / {{ entry.count }} 人採信</span>
              <button
                v-if="entry.button"
                class="btn btn--ghost endorse__btn"
                type="button"
                data-action="endorse"
                @click="onEndorse(face, entry)"
              >
                採信
              </button>
              <span v-else-if="entry.reason === 'SELF'" class="detail__hint" data-endorse-self>你自己的提交</span>
              <span v-else-if="entry.reason === 'ACCEPTED'" class="detail__hint" data-endorse-accepted>已採納</span>
              <!-- **重新提交（本单）**：已 `REJECTED` 的候選值不再只有一行死文字 —— 除「已駁回」
                   外再给一个【重新提交】钩子（`data-action`，**不得**用 `data-admin-action`）；
                   点击 ⇒ 回填该候选值到既有勘误表单并走**与手工提交同一路径**（`onResubmitRejected`）。
                   解释句（繁體、过 `s2t` 恒等）常驻本行，说明「已駁回」不再阻塞重提。 -->
              <template v-else-if="entry.reason === 'REJECTED'">
                <span class="detail__hint" data-endorse-rejected>已駁回</span>
                <button
                  class="btn btn--ghost endorse__btn"
                  type="button"
                  data-action="correction-resubmit"
                  @click="onResubmitRejected(face, entry)"
                >
                  重新提交
                </button>
                <span class="detail__hint endorse__resubmit-hint" data-endorse-resubmit-hint>
                  已駁回的行不再阻塞重新提交，管理員會重新審覈。
                </span>
              </template>
              <span v-if="endorseFeedbackOf(face, entry)" class="detail__hint endorse__feedback" data-endorse-feedback>
                {{ endorseFeedbackOf(face, entry) }}
              </span>
              <!-- **简繁等价提示（§3.78）**：该条与同字段其它候选 / 当前展示值「字面不同而
                   `s2t` 归一后相等」⇒ **追加一行**（独立 `data-s2t-variant-hint`）。
                   只作用于渲染：**不合并行、不改值、不置灰、不阻断采信 / 提交**。 -->
              <span
                v-if="s2tVariantHintOf(face, entry)"
                class="detail__hint endorse__s2t-hint"
                data-s2t-variant-hint
              >{{ s2tVariantHintOf(face, entry) }}</span>
            </li>
          </ul>
        </div>

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

        <div class="detail__upload" tabindex="0" data-paste-zone="photo-upload" @paste="onPastePhoto">
          <label v-if="canUpload" class="btn btn--ghost detail__upload-btn">
            <input type="file" accept="image/*" :disabled="uploading" @change="onPickPhoto" />
            {{ uploading ? '正在處理…' : '上傳實物照片' }}
          </label>
          <button v-else class="btn btn--ghost" type="button" @click="goLogin">登錄後上傳實物照片</button>
          <!-- 剪贴板一键粘贴提示（繁體，可见）：与本区 `@paste` 同源。 -->
          <span class="detail__hint" data-paste-hint="photo-upload">{{ PASTE_HINT }}</span>
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

    <!-- 管理員專屬彈窗：**新增印面**（本單）。只由詳情頁「印面列表」入口開啟；
         彈窗內按鈕只用 `data-action`（**不新增**任何 `[data-admin-action]` 取值）。 -->
    <AddSealFaceDialog
      v-if="addFaceOpen && seal"
      :stamp-id="seal.stamp_id"
      :seal-title="corrections.resolveSealDisplayName(seal)"
      @close="closeAddSealFace"
      @added="onSealFaceAdded"
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
        <h3 class="seal-attr-box__title">編輯印章屬性 · {{ corrections.resolveSealDisplayName(seal) }}</h3>
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

        <div class="field" tabindex="0" data-paste-zone="replace-face-image" @paste="onPasteReplaceImage">
          <label for="replace-face-image-input">印面圖</label>
          <input
            id="replace-face-image-input"
            type="file"
            accept="image/*"
            data-replace-face-input
            :disabled="replaceBusy"
            @change="onPickReplaceImage"
          />
          <!-- 剪贴板一键粘贴提示（繁體，可见）：与本框 `@paste` 同源。 -->
          <span class="field__hint" data-paste-hint="replace-face-image">{{ PASTE_HINT }}</span>
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

    <!-- 管理员专属弹窗：**人工智能修復**（左格「原圖」／右格「修復圖」并列对比）。
         弹窗内按钮**只用 `data-action`**（**不得**复用 `data-admin-action`，否则取值集合被撑破）。
         开窗＝**待確認态**（右格「尚未開始」＋成本一行；零请求、零扣金）；【開始修復】才发起调用；
         回包成功后底部三粒【取】/【棄】/【關閉】；调用中的取消入口在右格内。 -->
    <div
      v-if="aiEnhanceFace"
      class="ai-face-mask"
      role="dialog"
      aria-modal="true"
      aria-label="人工智能修復"
      data-admin-dialog="ai-enhance-face"
    >
      <div class="ai-face-box">
        <h3 class="ai-face-box__title">人工智能修復 · {{ faceLabel(aiEnhanceFace) }}</h3>
        <p class="ai-face-box__lede">
          印面編號 {{ aiEnhanceFace.id }} · 當前影像編號 {{ aiEnhanceFace.face_image_id || '（暫無）' }}。
          修復在服務端進行，產出**新影像**；按【取】才把本印面指向新影像，**舊影像與二進制保留**（不刪除、可回溯）；
          不滿意可按【棄】棄置候選圖（**不涉及退款** —— 修復金已於修復成功時花掉）。
        </p>
        <!-- 成本明示（**调用前**一行小字）：确认后才扣金；每张 10 金；实际扣费以回包 charge 爲准。 -->
        <p class="ai-face-box__cost" data-ai-enhance-cost>
          本次修復將消耗 {{ aiEnhanceCost }} 金（失敗全額退回）；按下【開始修復】才會扣金與發出請求。
        </p>

        <div class="ai-face-compare">
          <!-- 左格：原圖（当前影像，走 `seals.imageDisplaySourceOf`）。 -->
          <section class="ai-face-pane" data-ai-enhance-pane="source">
            <h4 class="ai-face-pane__title">原圖</h4>
            <img
              v-if="aiSourcePane && aiSourcePane.dataUrl"
              class="ai-face-pane__img"
              :src="aiSourcePane.dataUrl"
              :alt="`原圖 ${aiSourcePane.id}`"
              data-ai-enhance-image="source"
            />
            <SliceImage
              v-else-if="aiSourcePane && aiSourcePane.row"
              class="ai-face-pane__img"
              :row="aiSourcePane.row"
              :alt="`原圖 ${aiSourcePane.id}`"
            />
            <p v-else-if="aiSourcePane && aiSourcePane.state === 'loading'" class="ai-face-pane__state">
              正在讀取原圖…
            </p>
            <p v-else-if="aiSourcePane && aiSourcePane.message" class="ai-face-pane__state ai-face-pane__state--error">
              {{ aiSourcePane.message }}
            </p>
            <p v-else class="ai-face-pane__state">原圖暫不可讀。</p>
            <p class="ai-face-pane__id" data-ai-enhance-image-id="source">
              影像編號 {{ aiSourcePane && aiSourcePane.id ? aiSourcePane.id : '（暫無）' }}
            </p>
          </section>

          <!-- 右格：修復圖（五态：待確認 / 调用中骨架 / 成功候选影像 / 失败可读文案 / 取消）。 -->
          <section class="ai-face-pane" data-ai-enhance-pane="candidate">
            <h4 class="ai-face-pane__title">修復圖</h4>
            <!-- 待確認：开窗即此态 —— **零请求、零扣金**；成本与请求都等【開始修復】。 -->
            <p v-if="aiEnhanceStatus === 'confirm'" class="ai-face-pane__state" data-ai-enhance-state="confirm">
              尚未開始。確認成本後按【開始修復】，才會發出請求並扣金。
            </p>
            <!-- 调用中：骨架 ＋ 可取消入口（取消只停止等待，**不撤回服务端请求**；回包仍被收取）。 -->
            <div v-else-if="aiEnhanceStatus === 'running'" class="ai-face-pane__skeleton" data-ai-enhance-state="running">
              <p class="ai-face-pane__state">修復進行中（已預扣 10 金，成功才落賬）；可先關窗，稍後重開本窗仍可續接結果。</p>
              <button class="btn btn--ghost" type="button" data-action="ai-enhance-cancel" @click="cancelAiEnhanceRun">
                取消
              </button>
            </div>
            <p v-else-if="aiEnhanceStatus === 'cancelled'" class="ai-face-pane__state" data-ai-enhance-state="cancelled">
              已停止等待（雲端任務仍在進行）；稍後重開本窗可續接結果。
              <span v-if="aiEnhanceLateReplyTag" class="ai-face-pane__meta" data-ai-enhance-late-reply>
                {{ aiEnhanceLateReplyTag }}
              </span>
            </p>
            <!-- 失败：**传输层**整句照抄 `aiEnhance.AI_ENHANCE_TRANSPORT_MESSAGE`；
                 **服务端失败**＝「修復失敗：」＋服务端 message 原文，`refunded` 为真才接退款尾句。 -->
            <p
              v-else-if="aiEnhanceStatus === 'failed'"
              class="ai-face-pane__state ai-face-pane__state--error"
              data-ai-enhance-state="failed"
            >
              <template v-if="aiEnhanceTransport">{{ aiEnhanceError }}</template><template v-else>修復失敗：{{ aiEnhanceError }}<span v-if="aiEnhanceRefunded" data-ai-enhance-refunded>；已全額退回 {{ aiEnhanceCost }} 金。</span></template>
            </p>
            <template v-else-if="aiEnhanceStatus === 'done'">
              <img
                v-if="aiCandidatePane && aiCandidatePane.dataUrl"
                class="ai-face-pane__img"
                :src="aiCandidatePane.dataUrl"
                :alt="`修復圖 ${aiCandidatePane.id}`"
                data-ai-enhance-image="candidate"
              />
              <SliceImage
                v-else-if="aiCandidatePane && aiCandidatePane.row"
                class="ai-face-pane__img"
                :row="aiCandidatePane.row"
                alt="修復圖"
              />
              <p
                v-else-if="aiCandidatePane && aiCandidatePane.state === 'loading'"
                class="ai-face-pane__state"
              >
                正在讀取修復圖…
              </p>
              <p
                v-else-if="aiCandidatePane && aiCandidatePane.message"
                class="ai-face-pane__state ai-face-pane__state--error"
              >
                {{ aiCandidatePane.message }}
              </p>
              <p v-else class="ai-face-pane__state">修復圖暫不可讀。</p>
              <p class="ai-face-pane__id" data-ai-enhance-image-id="candidate">
                影像編號 {{ aiEnhanceResult ? aiEnhanceResult.imageId : '' }}
              </p>
              <p class="ai-face-pane__meta" data-ai-enhance-charge>{{ aiEnhanceChargeText }}</p>
            </template>
            <p v-else class="ai-face-pane__state" data-ai-enhance-state="idle">修復尚未就緒（無可渲染的狀態）。</p>
          </section>
        </div>

        <!-- 【棄】失败：服务端 message **原文上屏**（FORBIDDEN / INVALID_VALUE 等一字不改写）；
             弹窗不关、【取】仍可用；**不承诺退金**（弃置不涉及退款）。 -->
        <p
          v-if="aiEnhanceDiscardError"
          class="ai-face-box__feedback ai-face-box__feedback--error"
          data-ai-enhance-discard-error
        >
          棄置候選圖未生效：{{ aiEnhanceDiscardError }}（候選圖仍在，可按【取】採用或再按【棄】重試。）
        </p>

        <p v-if="aiEnhanceFeedback" class="ai-face-box__feedback" data-admin-feedback="ai-enhance-dialog">
          {{ aiEnhanceFeedback }}
        </p>

        <div class="ai-face-box__foot">
          <!-- 待確認态：【開始修復】（确认成本后才扣金发请求）＋【關閉】（零请求退出）。
               探测（`listCandidates`）在途 ⇒ 【開始修復】禁点（不在既有任务之上重复扣金）。 -->
          <template v-if="aiEnhanceStatus === 'confirm'">
            <button class="btn btn--ghost" type="button" data-action="ai-enhance-close" @click="closeAiEnhance()">
              關閉
            </button>
            <button
              class="btn btn--primary"
              type="button"
              data-action="ai-enhance-start"
              :disabled="aiEnhanceProbing"
              @click="startAiEnhance"
            >
              開始修復
            </button>
          </template>
          <!-- 回包成功态：三粒【取】/【棄】/【關閉】。 -->
          <template v-else-if="aiEnhanceStatus === 'done'">
            <button class="btn btn--ghost" type="button" data-action="ai-enhance-close" @click="closeAiEnhance()">
              關閉
            </button>
            <!-- 【棄】：棄置候選影像（不退款）；待辦中禁點＋「正在棄置…」；已棄置 ⇒ disabled＋「已棄置」。 -->
            <button
              class="btn btn--ghost"
              type="button"
              data-action="ai-enhance-discard"
              :disabled="!aiEnhanceDiscardable"
              @click="discardAiEnhance"
            >
              {{ aiEnhanceDiscardLabel }}
            </button>
            <!-- 【取】：**仅回包成功可用**（复用现有换图写面改写 face_image_id；旧行不删）。
                 棄置在途 ⇒ 一并禁点（避免「正被删除的候选件」被改写指向）。 -->
            <button
              class="btn btn--primary"
              type="button"
              data-action="ai-enhance-accept"
              :disabled="!aiEnhanceAcceptable || aiEnhanceAccepting || aiEnhanceDiscarding"
              @click="acceptAiEnhance"
            >
              {{ aiEnhanceAccepting ? '正在取用…' : '取' }}
            </button>
          </template>
          <!-- 其余态（调用中 / 已取消 / 失败）：只有【關閉】（取消入口在右格内）。 -->
          <button v-else class="btn btn--ghost" type="button" data-action="ai-enhance-close" @click="closeAiEnhance()">
            關閉
          </button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-if="downloadOpen"
      title="下載高清原圖"
      :message="`本次下載將扣除 ${downloadCost} 金；同一枚印章在本次會話內只扣費一次。`"
      :detail="quoteDetail"
      hint="本機存有原檔時直出原檔；雲端暫無原檔時交付展示檔並註明。"
      confirm-text="確認下載"
      @confirm="confirmDownload"
      @cancel="downloadOpen = false"
    />

    <!-- **刪除印章的二次确认（本单新增）**：复用 `ConfirmDialog`（显式、可取消、默认不通过）。
         文案**必须列明**：将删印面数 / 影像数、**不可恢復**、**編號將被釋放**；
         可选理由（≤200 字）走正文插槽；确认 / 取消钮只挂 `data-action`
         （`seal-delete-confirm` / `seal-delete-cancel`，**不新增 `data-admin-action`**）。 -->
    <ConfirmDialog
      v-if="sealDeleteOpen"
      title="刪除印章"
      :message="sealDeleteMessage"
      hint="刪除為不可恢復操作：確認後本印將自藏品庫移除，印章與印面編號會被釋放回號源（可再次發放）。"
      confirm-text="確認刪除"
      confirm-action="seal-delete-confirm"
      cancel-action="seal-delete-cancel"
      @confirm="confirmSealDelete"
      @cancel="sealDeleteOpen = false"
    >
      <div class="seal-delete__note">
        <label for="seal-delete-reason">刪除理由（可選，最多 200 字）</label>
        <textarea
          id="seal-delete-reason"
          v-model="sealDeleteReason"
          class="seal-delete__reason"
          maxlength="200"
          rows="3"
          data-seal-delete-reason
        ></textarea>
      </div>
    </ConfirmDialog>

    <!-- **刪除印面影像的二次确认（本单新增）**：复用 `ConfirmDialog`（显式、可取消、默认不通过）。
         文案**必须列明**「刪除後該印面將無影像、不可恢復、物件一並刪除」；
         确认 / 取消钮只挂 `data-action`（`image-delete-confirm` / `image-delete-cancel`，
         **不新增 `data-admin-action`**）。 -->
    <ConfirmDialog
      v-if="faceImageDeleteOpen"
      title="刪除印面影像"
      :message="faceImageDeleteMessage"
      hint="刪除為不可恢復操作：該印面的影像與其物件會一併移除。"
      confirm-text="確認刪除"
      confirm-action="image-delete-confirm"
      cancel-action="image-delete-cancel"
      @confirm="confirmFaceImageDelete"
      @cancel="faceImageDeleteOpen = false"
    />

    <!-- **刪除印面影像的可读反馈（本页；成功 / 失败都上屏）。** -->
    <p v-if="faceImageDeleteFeedback" class="notice detail__notice" data-image-delete-feedback>
      {{ faceImageDeleteFeedback }}
    </p>

    <!-- **普通用戶影像勘誤（§3.77｜本單）的页面级提示位**：提交成功后弹窗即关 ⇒ 同一份
         文案（繁體一字不改）落在这里，重开弹窗 / 切换印面时作废。 -->
    <p v-if="imageCorrectionNotice" class="notice detail__notice" data-image-correction-notice>
      {{ imageCorrectionNotice }}
    </p>

    <!-- **影像勘誤表单已并入下方「提交勘誤」合并弹窗的「影像」页签**（本單：两个勘誤入口合一）。
         表单本体、两条取图路径（`type=file` / `data-paste-zone`）、后果文案、备注上限、
         提交钮钩子 `data-action="image-correction-submit"` / `image-correction-cancel` 与
         页面级提示位 `data-image-correction-notice` **逐字原样保留**，只换容器（页签面板，
         挂 `data-image-correction-dialog`）。写链路 `confirmImageCorrection` 零改动。 -->

    <!-- 「清除本機資料」二次确认（**与广场页逐字同一份文案**；默认不通过）。
         确认走 `confirmClearLocal`：成功 ⇒ 强制从云端重载并回广场带一次性提示；
         失败 ⇒ 本页顶部 `clearFeedback` 如实上屏。 -->
    <ConfirmDialog
      v-if="clearOpen"
      title="清除本機資料"
      :message="CLEAR_MESSAGE"
      hint="此操作只影響本機瀏覽器裡的資料；清除後需重新從雲端載入。"
      confirm-text="確認清除"
      @confirm="confirmClearLocal"
      @cancel="clearOpen = false"
    />

    <!-- **勘誤合并弹窗（本單：两个勘誤入口合一）** —— 页面上唯一那枚【勘誤】（「可標記屬性」区）
         打开这一扇窗；窗内用**页签**把两类操作分开呈现：「屬性」（**默认**，原字段勘误表单 ＋
         既有 `submitCorrection` 提交链）／「影像」（原影像卡【勘誤】表单 ＋ 既有
         `confirmImageCorrection` 提交链）。两套表单、两条提交通道**逐字沿用**（不改写库逻辑、
         不新增写口）；页签钩子 `data-correction-tab="attr" | "image"`，影像页签内保留
         `data-action="image-correction"`；弹窗内提交钮仍带 `data-correction="face-entry-submit"`。 -->
    <div v-if="formOpen" class="correction-mask" role="dialog" aria-modal="true" aria-label="提交勘誤">
      <div class="correction-box">
        <h3 class="correction-box__title">{{ correctionTab === 'image' ? '影像勘誤' : '提交勘誤' }}</h3>

        <!-- 页签（默认「屬性」）：两枚真按钮、可见可达；游客态入口与登录门仍在页面上（逐字未改）。 -->
        <div class="correction-box__tabs" role="tablist" aria-label="勘誤類別" data-correction-tabs>
          <button
            class="correction-box__tab"
            :class="{ 'is-active': correctionTab === 'attr' }"
            type="button"
            role="tab"
            :aria-selected="correctionTab === 'attr'"
            data-correction-tab="attr"
            @click="correctionTab = 'attr'"
          >
            屬性
          </button>
          <button
            class="correction-box__tab"
            :class="{ 'is-active': correctionTab === 'image' }"
            type="button"
            role="tab"
            :aria-selected="correctionTab === 'image'"
            data-correction-tab="image"
            data-action="image-correction"
            :data-face-id="formFaceId"
            :data-image-id="imageCorrectionTarget ? imageCorrectionTarget.imageId : ''"
            @click="correctionTab = 'image'"
          >
            影像
          </button>
        </div>

        <template v-if="correctionTab === 'attr'">
        <p class="correction-box__lede">
          勘誤對象：{{ formFaceLabel }}。只需填寫要更正的項目，留空的項目不會被提交。
        </p>

        <!-- 可标记属性：**按字段提供按需渲染器**（R-20 / R-30 / R-31 / R-43）。
             - 朝代 ⇒ 封闭选择框（真源 `DYNASTY_OPTIONS`，15 类）；
             - 【印面内容】⇒ 封闭选择框（真源 `FACE_CONTENT_OPTIONS`，9 值）；
             - 【印面风格】⇒ 封闭选择框（真源 `FACE_STYLE_OPTIONS`，23 值）；
             - 【大類】（本单）⇒ 封闭选择框（真源 `SEAL_CLASS_OPTIONS`，3 值；**不得**当自由文本 + s2t）；
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
            <select
              v-else-if="item.key === SEAL_CLASS_KEY"
              :id="`cr-${item.key}`"
              v-model="form[item.key]"
              data-seal-class-select="correction"
            >
              <option v-for="k in sealClassOptions" :key="k" :value="k">{{ k }}</option>
            </select>
            <!-- 【作者】＝**引用型**检索 + 选人（person-model §4.1 / §4.3）：只可选、不可填；
                 无命中 ⇒ 出「提交印人提案」引导（不静默、不放行自由文本）。 -->
            <template v-else-if="item.key === 'author'">
              <input
                id="cr-author-search"
                v-model="authorKeyword"
                type="text"
                placeholder="檢索印人（姓 / 名 / 字 / 號 / 別名），留空即列出全部"
                data-author-search="correction"
              />
              <select id="cr-author" v-model="form[item.key]" data-author-select="correction">
                <option value="">（不選，留空）</option>
                <option v-for="option in correctionAuthorOptions" :key="option.id" :value="option.id">{{ option.name }}</option>
              </select>
              <span class="field__hint">
                本印面當前作者：{{ authorDisplayValue() || '佚名' }}。作者選填：不選即不提交該項。
              </span>
              <template v-if="authorKeyword.trim() && !correctionAuthorOptions.length">
                <span class="field__hint" data-author-nomatch="correction">
                  庫中沒有匹配「{{ authorKeyword.trim() }}」的印人 ⇒ 不能手輸自由文本。
                </span>
                <button
                  class="btn btn--ghost"
                  type="button"
                  data-action="person-proposal-open"
                  @click="openPersonProposal(formFace.value); formOpen = false"
                >
                  提交印人提案
                </button>
                <span class="field__hint">
                  庫中無此人 ⇒ 可先提交印人提案（提交面在「可標記屬性」區，本彈窗將關閉），經管理員審覈通過後即可在此選中。
                </span>
              </template>
            </template>
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
              朝代固定 {{ dynastyOptions.length }} 類，只可選不可填；不填即不提交該項。
            </span>
            <span
              v-else-if="item.key === FACE_CONTENT_KEY"
              class="field__hint"
            >
              【印面內容】固定 {{ faceContentOptions.length }} 類，只可選不可填；不填即不提交該項。
              本印面當前展示值：{{ faceMarkableValue(formFace, FACE_CONTENT_KEY, formFace && formFace.seal_type) || '未著錄' }}。
            </span>
            <span v-else-if="item.key === FACE_STYLE_KEY" class="field__hint">
              【印面風格】固定 {{ faceStyleOptions.length }} 類，只可選不可填；不填即不提交該項。
              本印面當前展示值：{{ faceMarkableValue(formFace, FACE_STYLE_KEY, formFace && formFace.face_style) || '未著錄' }}。
            </span>
            <span v-else-if="item.key === SEAL_CLASS_KEY" class="field__hint">
              【大類】固定 {{ sealClassOptions.length }} 類，只可選不可填；不填即不提交該項。
              本印面當前展示值：{{ faceMarkableValue(formFace, SEAL_CLASS_KEY, formFace && formFace.seal_class) || '未著錄' }}。
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
            <span v-if="item.key === SEAL_CLASS_KEY && !SEAL_CLASS_READY" class="field__hint" data-seal-class-degraded="correction">
              {{ SEAL_CLASS_MISSING_MESSAGE }}
            </span>
          </div>
        </template>

        <div class="field">
          <label for="cr-basis">勘誤依據（選填）</label>
          <textarea id="cr-basis" v-model="form.basis" placeholder="可填寫著錄出處、比對印譜或旁證材料" />
          <TextTransformButtons v-model="form.basis" field-key="correction:basis" field-label="勘誤依據" />
        </div>

        <!-- **简繁等价提示（§3.78.3）**：输入值与同字段既有候选值「字面不同而 `s2t` 归一后
             相等」⇒ 表单旁提示（固定文案段带 `data-s2t-variant-hint`）。
             **只提示**：不禁用提交、不要求二次确认、不改值、不归一入参、不拦截 ——
             逐字不同 ⇒ 仍走 §3.47 既有判定、正常另计一条。 -->
        <p v-if="formS2tVariantPeer()" class="correction-box__s2t-hint">
          <span data-s2t-variant-hint>{{ S2T_VARIANT_HINT }}</span>
          已有繁/簡近似值「{{ formS2tVariantPeer() }}」；仍可直接提交（逐字不同會另計一條）。
        </p>

        <p v-if="formFeedback" class="correction-box__feedback">{{ formFeedback }}</p>

        <div class="correction-box__foot">
          <button class="btn btn--ghost" type="button" @click="formOpen = false">取消</button>
          <button
            class="btn btn--primary"
            type="button"
            data-correction="face-entry-submit"
            @click="submitCorrection"
          >
            提交勘誤
          </button>
        </div>
        </template>

        <template v-else>
        <!-- **「影像」页签（原影像卡【勘誤】表单原样搬入）**：二选一（刪除此影像 / 重新上傳新圖替換）
             ＋ 备注（≤200 字，超限禁用提交并提示）＋ 选「替換」时必选新图；后果文案列明
             「審核通過後印面改指新圖、舊圖將被刪除（舊圖仍被其它印面引用時只改指向、不刪舊圖）」；
             确认前零写入、取消零写入；面板内按钮**只用 `data-action`**（**不新增 `[data-admin-action]`
             取值**）。容器挂 `data-image-correction-dialog`（原弹窗钩子原地迁入）。 -->
          <div class="correction-box__panel" role="tabpanel" data-image-correction-dialog>
            <p v-if="imageCorrectionTarget" class="correction-box__lede">{{ imageCorrectionLede }}</p>

            <template v-if="imageCorrectionTarget">
              <!-- 多图印面（印面图 ＋ 边款图）：目标影像在此换；候选唯一 ⇒ 不上屏该控件。 -->
              <div v-if="correctionImageCandidates.length > 1" class="field">
                <label for="cr-image-pick">勘誤對象影像</label>
                <select
                  id="cr-image-pick"
                  v-model="imageCorrectionChoice"
                  data-correction-image-pick
                  @change="retargetCorrectionImage"
                >
                  <option
                    v-for="item in correctionImageCandidates"
                    :key="`${item.kind}:${item.imageId}`"
                    :value="`${item.kind}:${item.imageId}`"
                  >
                    {{ item.kind === seals.FACE_KIND.EDGE ? `邊款圖 ${item.imageId}` : `印面圖 ${item.imageId}` }}
                  </option>
                </select>
              </div>

              <fieldset class="imgcorr">
                <legend class="imgcorr__legend">選擇勘誤方式（二選一）</legend>
                <label class="imgcorr__option" data-image-correction-option="delete">
                  <input
                    v-model="imageCorrectionAction"
                    type="radio"
                    name="image-correction-action"
                    value="delete"
                    data-image-correction-action="delete"
                  />
                  刪除此影像
                </label>
                <label class="imgcorr__option" data-image-correction-option="replace">
                  <input
                    v-model="imageCorrectionAction"
                    type="radio"
                    name="image-correction-action"
                    value="replace"
                    data-image-correction-action="replace"
                  />
                  重新上傳新圖替換
                </label>
              </fieldset>

              <p class="imgcorr__consequences" data-image-correction-consequences>{{ imageCorrectionConsequences }}</p>

              <!-- 选「替換」⇒ 必须选图（未选 ⇒ 提交禁用 ＋ 提示；上传与入册都在提交时才发生）。
                   **两条取图路径同框并列**：① 選擇本機文件（`type=file`）；② 粘貼剪貼板圖片（本区 `@paste`）。 -->
              <div
                v-if="imageCorrectionAction === 'replace'"
                class="field"
                tabindex="0"
                data-paste-zone="image-correction-file"
                @paste="onPasteImageCorrectionFile"
              >
                <label for="image-correction-file">新圖（必選）</label>
                <input
                  id="image-correction-file"
                  type="file"
                  accept="image/*"
                  data-image-correction-file
                  @change="onImageCorrectionFileChange"
                />
                <!-- 剪贴板一键粘贴提示（繁體，可见）：与本框 `@paste` 同源。 -->
                <span class="field__hint" data-paste-hint="image-correction-file">{{ PASTE_HINT }}</span>
                <span v-if="imageCorrectionFileName" class="field__hint" data-image-correction-file-name>
                  已選：{{ imageCorrectionFileName }}（圖片已就緒，可提交）
                </span>
                <span v-else class="field__hint">必須先選擇一張新圖（JPG / PNG / WebP，或直接粘貼剪貼板圖片），否則不能提交。</span>
              </div>

              <div class="field">
                <label for="image-correction-note">備註（選填，最多 {{ corrections.MAX_IMAGE_CORRECTION_NOTE_LENGTH }} 字）</label>
                <textarea
                  id="image-correction-note"
                  v-model="imageCorrectionNote"
                  rows="3"
                  data-image-correction-note
                ></textarea>
                <span
                  class="field__hint"
                  :class="{ 'imgcorr__over': imageCorrectionNoteOver }"
                  data-image-correction-note-count
                >
                  {{ imageCorrectionNoteLength }} / {{ corrections.MAX_IMAGE_CORRECTION_NOTE_LENGTH }} 字
                  <template v-if="imageCorrectionNoteOver">（超出上限，請刪減後再提交，否則不能提交）</template>
                </span>
              </div>

              <!-- 失败文案优先、结构化失败原样上屏（**不被成功文案覆盖**）。 -->
              <p v-if="imageCorrectionFeedback" class="correction-box__feedback" data-image-correction-feedback>
                {{ imageCorrectionFeedback }}
              </p>
            </template>
            <p v-else class="correction-box__feedback" data-image-correction-no-image>
              <!-- 本印面无任何影像 ⇒ 只上屏既有那句提示（与原入口空 id 分支**逐字同一份**），零写入面不变。 -->
              本印面沒有影像編號，無從提交影像勘誤。
            </p>

            <div class="correction-box__foot">
              <button
                class="btn btn--ghost"
                type="button"
                data-action="image-correction-cancel"
                @click="closeImageCorrection"
              >
                取消
              </button>
              <button
                class="btn btn--primary"
                type="button"
                data-action="image-correction-submit"
                :disabled="imageCorrectionSubmitDisabled"
                @click="confirmImageCorrection"
              >
                {{ imageCorrectionBusy ? '提交中…' : '提交勘誤' }}
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- **校驗作者彈窗（本單）**：候选列表（姓名 / 朝代 / 命中字段中文名 / 分数）＋ 三态反馈。
         · 查询词：有当前作者名 ⇒ 打开即按 `face_id` 查；无 ⇒ 出输入框由用户填姓名再查；
         · 空态「暫無合適人選」只在**查询成功且零候选**时出现（查询失败走
           `data-author-verify-error`，**不以空列表冒充**）；
         · 选中 ⇒ 走既有勘误提交（`data-author-verify-pick`），回包文案逐字沿用既有提交入口。 -->
    <div v-if="authorVerifyOpen" class="correction-mask" role="dialog" aria-modal="true" aria-label="校驗作者">
      <div class="correction-box">
        <h3 class="correction-box__title">校驗作者</h3>
        <p class="correction-box__lede">
          校驗對象：{{ authorVerifyFaceLabel }}。候選來自平臺印人庫的匹配結果；選中一項後走既有【勘誤】通道提交，審覈採納後才改變對外展示的作者。
        </p>

        <div v-if="authorVerifyNeedsName" class="field">
          <label for="author-verify-name">作者姓名</label>
          <input
            id="author-verify-name"
            v-model="authorVerifyName"
            type="text"
            placeholder="輸入要校驗的作者姓名"
            data-author-verify-input
            @keyup.enter="onAuthorVerifySearch"
          />
        </div>

        <div class="correction-box__foot">
          <button
            class="btn btn--primary"
            type="button"
            data-author-verify-search
            :disabled="authorVerifyBusy"
            @click="onAuthorVerifySearch"
          >
            {{ authorVerifyBusy ? '查詢中…' : '查詢候選' }}
          </button>
          <button class="btn btn--ghost" type="button" data-author-verify-close @click="closeAuthorVerify">
            關閉
          </button>
        </div>

        <p v-if="authorVerifyQueryLabel" class="detail__hint" data-author-verify-query>
          查詢詞：{{ authorVerifyQueryLabel }}
        </p>
        <!-- 查询失败：服务端 / 传输层原话上屏（与提交反馈分位，互不覆盖）。 -->
        <p v-if="authorVerifyError" class="correction-box__feedback" data-author-verify-error>
          {{ authorVerifyError }}
        </p>
        <!-- 提交回包（成功 / 已存在跳过 / 失败三态，逐字来自既有提交入口）。 -->
        <p v-if="authorVerifyFeedback" class="correction-box__feedback" data-author-verify-feedback>
          {{ authorVerifyFeedback }}
        </p>

        <ul v-if="authorVerifyCandidates.length" class="author-verify__list" data-author-verify-candidates>
          <li
            v-for="candidate in authorVerifyCandidates"
            :key="candidate.person_id"
            class="author-verify__item"
            data-author-verify-candidate
            :data-author-verify-person="candidate.person_id"
            :data-author-verify-current="candidate.is_current ? '1' : '0'"
          >
            <span class="author-verify__name" data-author-verify-candidate-name>
              {{ candidate.display_name || '佚名' }}
            </span>
            <span class="author-verify__meta" data-author-verify-candidate-dynasty>
              {{ candidate.dynasty || '—' }}
            </span>
            <span class="author-verify__meta" data-author-verify-candidate-field>
              {{ authorVerifyFieldLabel(candidate.matched_field) }}
            </span>
            <span class="author-verify__meta" data-author-verify-candidate-value>
              {{ candidate.matched_value || '—' }}
            </span>
            <span class="author-verify__meta" data-author-verify-candidate-score>
              分數 {{ authorVerifyScoreText(candidate.score) }}
            </span>
            <span v-if="candidate.is_current" class="detail__hint" data-author-verify-current>當前作者</span>
            <button
              class="btn btn--ghost"
              type="button"
              data-author-verify-pick
              :disabled="authorVerifyBusy"
              @click="onAuthorVerifyPick(candidate)"
            >
              選為作者
            </button>
          </li>
        </ul>
        <!-- 空态：**仅查询成功且零候选**时出现（失败另有上面的错误位）。 -->
        <p
          v-else-if="authorVerifySearched && !authorVerifyBusy && !authorVerifyError"
          class="detail__hint"
          data-author-verify-empty
        >
          暫無合適人選
        </p>
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
    <router-link class="btn btn--ghost" :to="{ name: 'square' }">返回璽印匯類</router-link>
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

/* 「印面列表」區塊標題 ＋ 新增入口（本單）：標題在左、入口在右（入口恰一個，在 v-for 之外）。 */
.detail__faces-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  margin-bottom: var(--s-3);
}

.detail__faces-title {
  margin: 0;
  font-size: var(--t-lg);
  color: var(--c-text);
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

/* **採信（本单新增）**：他人提交的勘誤列表（可採信）。 */
.endorse {
  margin-top: var(--s-3);
}

.endorse__title {
  margin: 0 0 var(--s-2);
  font-size: var(--t-sm);
  color: var(--c-text-muted);
  font-weight: 500;
}

.endorse__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.endorse__item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--c-line);
  border-radius: var(--r-sm, 4px);
  font-size: var(--t-sm);
}

.endorse__field {
  color: var(--c-text-muted);
}

.endorse__value {
  color: var(--c-text);
}

.endorse__count {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.endorse__feedback {
  flex-basis: 100%;
}

/* 【重新提交】解释句（本单）：与反馈位同口径独占一行，不与读数挤在同一行。 */
.endorse__resubmit-hint {
  flex-basis: 100%;
}

/* 简繁等价提示（§3.78）：**追加的一行**，不替换原值、不置灰、不折疊候选行。 */
.endorse__s2t-hint {
  flex-basis: 100%;
}

/* **校驗作者（本單）**：弹窗内候选列表（与【候選值 · 可採信】列表同形，便于并排比对）。 */
.author-verify__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.author-verify__item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--c-line);
  border-radius: var(--r-sm, 4px);
  font-size: var(--t-sm);
}

.author-verify__name {
  color: var(--c-text);
  font-weight: 500;
}

.author-verify__meta {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

/* 同上（提交表单旁）：提示与反馈位同形，**不禁用提交、不改值**。 */
.correction-box__s2t-hint {
  margin-bottom: var(--s-3);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
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

/* ------------------ 勘誤合并弹窗页签（本單：两入口合一）：「屬性」默认 /「影像」 ------------------ */

.correction-box__tabs {
  display: flex;
  gap: var(--s-2);
  margin-bottom: var(--s-3);
  border-bottom: 1px solid var(--c-line-strong);
}

.correction-box__tab {
  appearance: none;
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  padding: var(--s-2) var(--s-3);
  font: inherit;
  font-size: var(--t-sm);
  color: var(--c-text-muted);
  cursor: pointer;
}

.correction-box__tab.is-active {
  border-bottom-color: var(--c-text);
  color: var(--c-text);
  font-weight: 600;
}

.correction-box__panel {
  display: block;
}

/* ------------------ 影像勘誤弹窗（§3.77）：二选一 ＋ 后果文案 ＋ 超限提示 ------------------ */

.imgcorr {
  margin: var(--s-3) 0;
  padding: var(--s-3);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
}

.imgcorr__legend {
  padding: 0 var(--s-2);
  font-size: var(--t-sm);
  color: var(--c-text);
}

.imgcorr__option {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-1) 0;
  font-size: var(--t-sm);
  color: var(--c-text);
  cursor: pointer;
}

.imgcorr__consequences {
  margin: var(--s-3) 0;
  font-size: var(--t-sm);
  line-height: 1.6;
  color: var(--c-text-muted);
}

.imgcorr__over {
  color: var(--c-danger);
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

/* ------------------ 人工智能修復：弹窗与并列对比格（本单新增） ------------------ */

.ai-face-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-overlay);
  overflow: auto;
}

.ai-face-box {
  width: 100%;
  max-width: 680px;
  max-height: 88vh;
  overflow: auto;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.ai-face-box__title {
  margin-bottom: var(--s-2);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.ai-face-box__lede {
  margin-bottom: var(--s-2);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

/* 成本小字（调用前明示）。 */
.ai-face-box__cost {
  margin-bottom: var(--s-3);
  color: var(--c-text-muted);
  font-size: var(--t-xs, var(--t-sm));
}

.ai-face-compare {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--s-3);
}

@media (max-width: 640px) {
  .ai-face-compare {
    grid-template-columns: minmax(0, 1fr);
  }
}

.ai-face-pane {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3);
  background: var(--c-surface-sunken);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
}

.ai-face-pane__title {
  margin: 0;
  font-size: var(--t-sm);
  color: var(--c-text);
}

.ai-face-pane__img {
  display: block;
  width: 100%;
  max-height: 320px;
  object-fit: contain;
  background: var(--c-surface);
  border: 1px solid var(--c-line);
  border-radius: var(--r-sm);
  -webkit-user-drag: none;
}

.ai-face-pane__skeleton {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--s-2);
  min-height: 160px;
  justify-content: center;
  border: 1px dashed var(--c-line-strong);
  border-radius: var(--r-sm);
}

.ai-face-pane__state {
  margin: 0;
  color: var(--c-text-muted);
  font-size: var(--t-sm);
  text-align: center;
}

.ai-face-pane__state--error {
  color: var(--c-danger);
}

.ai-face-pane__id,
.ai-face-pane__meta {
  margin: 0;
  color: var(--c-text);
  font-size: var(--t-xs, var(--t-sm));
}

.ai-face-box__feedback {
  margin-top: var(--s-3);
  margin-bottom: var(--s-3);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
}

/* 【棄】失败的弹窗内可见落点（服务端 message 原文上屏）。 */
.ai-face-box__feedback--error {
  color: var(--c-danger);
}

.ai-face-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
}

/* 印人提案（新增印人）内联提交面（仅检索无命中时露出）。 */
.proposal-form {
  flex: 1 1 100%;
  margin-top: var(--s-2);
  padding: var(--s-3) var(--s-4);
  background: var(--c-surface-sunken);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
}

.proposal-form__title {
  margin: 0 0 var(--s-2);
  font-size: var(--t-sm);
  color: var(--c-text);
}

.proposal-form__foot {
  display: flex;
  justify-content: flex-end;
}
</style>
