
<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import TextTransformButtons from './TextTransformButtons.vue'
import { DYNASTY_OPTIONS, FACE_CONTENT_OPTIONS, FACE_STYLE_OPTIONS, SEAL_CLASS_OPTIONS, isKnownSealClass, suggestSealClass } from '../data/seed.js'
import { seals } from '../services/index.js'
import { pipelineNotice, runUploadPipeline } from './uploadPipeline.js'
import { IMAGE_LIMITS, loadImageFile } from '../utils/image.js'
import { formatBytes } from '../utils/format.js'

const emit = defineEmits(['close', 'uploaded'])

/** 预览容器最长边（CSS px）；只缩不放，避免小图被拉糊。 */
const PREVIEW_MAX = 240
/** 方形框最小边长（原图像素；与管线内的同口径约束一致，防手抖拖成 0）。 */
const MIN_CROP_SIDE = 16
/** 上传端管线上屏提示：入口不可调用时给可读繁体降级说明（就绪时为空串 ⇒ 界面零噪声）。 */
const FACE_PIPELINE_NOTICE = pipelineNotice('face')
/** 解码能力逐个核对（`loadImageFile`）＋ **唯一具名入口可调用** 才放行，否则给可读降级提示。 */
const PIPELINE_READY = typeof loadImageFile === 'function' && !FACE_PIPELINE_NOTICE
const PIPELINE_MISSING_MESSAGE = FACE_PIPELINE_NOTICE ||
  '圖像處理模塊未就緒（utils/image.js 的 loadImageFile 不可用），暫時無法在本機處理印面圖，請稍後重試。'

const form = reactive({
  seal_name: '', // 印文（选填）
  dynasty: '',
  faceContent: '', // 【印面内容】（R-30，键名 seal_type；必填、封闭 9 值）
  faceStyle: '', // 【印面风格】（R-31，键名 face_style；选填、封闭 23 值）
  sealClass: '', // 【大類】（本单，键名 seal_class；**印面级**、封闭 3 值、按朝代预填建议）
  material: '', // 材质（**印章级**固定属性，R-32/R-40；自由文本、选填）
  shape: '', // 形制（选填；**印章级**固定属性，自由文本）
  author: '',
  transcription: ''
})

/** 已选原图：`{ bitmap, width, height, originalBytes, originalMime, name, previewUrl }`。 */
const source = ref(null)
/** 取景方形框（**原图像素坐标**）：`{ cx, cy, side }`。 */
const crop = ref(null)
/** 最近一次导出结果：`{ bytes, mime, width, height }`（仅用于展示，提交时重新导出）。 */
const exported = ref(null)
const feedback = ref('')
const submitting = ref(false)
const dragging = ref(null)

const limitLabel = formatBytes(IMAGE_LIMITS.maxInputBytes)
const maxSideLabel = `${IMAGE_LIMITS.maxSide}px`

/* 朝代 = **封闭选择框**：选项**只来自真源常量** `DYNASTY_OPTIONS`（R-20）。
   - **不再** `unionOptions(DYNASTY_OPTIONS, seals.listDynastyOptions())`（旧形态已废除）；
   - 真源缺位时**不回落**成库内派生值（那会重新打开自由值面），而是给可读降级提示。 */
const DYNASTY_READY = Array.isArray(DYNASTY_OPTIONS) && DYNASTY_OPTIONS.length > 0
const DYNASTY_MISSING_MESSAGE =
  '朝代選項模塊未就緒（真源常量 DYNASTY_OPTIONS 不可用），暫時無法選擇朝代，請稍後重試。'
const dynastyOptions = computed(() => (DYNASTY_READY ? [...DYNASTY_OPTIONS] : []))

/* 【印面内容】（R-30，键名 `seal_type`）= **封闭选择框**：选项**只来自真源常量**
   `FACE_CONTENT_OPTIONS`（逐字 9 值、顺序即真源顺序）。**不 ∪ 库内派生值、无自由文本、
   无占位项**（选项数逐字＝真源长度）；真源缺位 ⇒ 可读降级提示（不自写第二套常量）。 */
const FACE_CONTENT_READY = Array.isArray(FACE_CONTENT_OPTIONS) && FACE_CONTENT_OPTIONS.length > 0
const FACE_CONTENT_MISSING_MESSAGE =
  '印面內容選項未就緒（真源常量 FACE_CONTENT_OPTIONS 不可用），暫時無法選擇印面內容，請稍後重試。'
const faceContentOptions = computed(() => (FACE_CONTENT_READY ? [...FACE_CONTENT_OPTIONS] : []))

/* 【印面风格】（R-31，键名 `face_style`）= **封闭选择框**（本单新增）：选项**只来自真源常量**
   `FACE_STYLE_OPTIONS`（逐字 23 值、顺序即真源顺序）；同样不追加占位项、无自由文本。 */
const FACE_STYLE_READY = Array.isArray(FACE_STYLE_OPTIONS) && FACE_STYLE_OPTIONS.length > 0
const FACE_STYLE_MISSING_MESSAGE =
  '印面風格選項未就緒（真源常量 FACE_STYLE_OPTIONS 不可用），暫時無法選擇印面風格，請稍後重試。'
const faceStyleOptions = computed(() => (FACE_STYLE_READY ? [...FACE_STYLE_OPTIONS] : []))

/* 【大類】（本单，键名 `seal_class`，**印面级**）= **封闭选择框**：选项**只来自真源常量**
   `SEAL_CLASS_OPTIONS`（逐字 3 值、顺序即真源顺序）；不追加占位项、无自由文本。
   **按朝代预填建议**（唯一真源 `suggestSealClass(dynasty)`，本组件不自写第二套映射）：
   - 朝代变更时**重算建议**并写入 —— 但**仅当用户尚未手动改选**（`sealClassTouched` 为假）；
   - **不锁死**：用户手改后**以用户所选为准**，之后朝代变动**不得覆盖**（这是本单判据双向点）。 */
const SEAL_CLASS_READY = Array.isArray(SEAL_CLASS_OPTIONS) && SEAL_CLASS_OPTIONS.length > 0
const SEAL_CLASS_MISSING_MESSAGE =
  '大類選項未就緒（真源常量 SEAL_CLASS_OPTIONS 不可用），暫時無法選擇大類，請稍後重試。'
const sealClassOptions = computed(() => (SEAL_CLASS_READY ? [...SEAL_CLASS_OPTIONS] : []))

/** 用户是否**已手动改选**过大類（改过 ⇒ 以用户所选为准，朝代变动不得覆盖）。 */
const sealClassTouched = ref(false)

/** 由朝代重算的建议值（仅供提示；`touched` 时不代表当前落盘值）。 */
const sealClassSuggested = computed(() => suggestSealClass(form.dynasty))

/* 朝代变更 ⇒ 重算建议；**仅未手动改选时**才把建议写进 `form.sealClass`（不覆盖用户手选值）。 */
watch(
  () => form.dynasty,
  () => {
    if (sealClassTouched.value) return
    form.sealClass = sealClassSuggested.value
  }
)

/** 用户在「大類」下拉里手动选择 ⇒ 标记 touched（此后朝代变动不再覆盖）。 */
function onSealClassChange() {
  sealClassTouched.value = true
}

/* 【大類】**必填**（人类裁定）：提交前校验 —— 未选（或空串）⇒ 拒；选了但不在真源 3 类内 ⇒ 拒。
   真源判定走 `isKnownSealClass`（seed.js，唯一真源；逐字相等、不做归一）。
   返回**可读繁體提示**（空串 ＝ 放行）；**不新增任何 reason 字面值**（本组件只上屏文案）。 */
function sealClassDenial() {
  const value = String(form.sealClass || '').trim()
  if (!value) {
    return SEAL_CLASS_READY
      ? `大類爲必填項，請先選擇一項（${SEAL_CLASS_OPTIONS.join('、')}）後再提交。`
      : SEAL_CLASS_MISSING_MESSAGE
  }
  if (!isKnownSealClass(value)) {
    return `大類「${value}」不在允許的 3 類之內（${SEAL_CLASS_OPTIONS.join('、')}），請重新選擇後再提交。`
  }
  return ''
}


/* ------------------------------ 取景框几何 ------------------------------ */

function clamp(value, min, max) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/** 中心最大正方形（边长＝短边）＝默认取景；与管线内 `crop` 省略时的口径一致。 */
function centerCrop(width, height) {
  const side = Math.max(1, Math.round(Math.min(width, height)))
  return {
    cx: Math.round((width - side) / 2),
    cy: Math.round((height - side) / 2),
    side
  }
}

/** 预览显示尺寸（等比缩到 PREVIEW_MAX 以内，不放大）。 */
const geom = computed(() => {
  const src = source.value
  if (!src) return null
  const scale = Math.min(PREVIEW_MAX / src.width, PREVIEW_MAX / src.height, 1)
  return {
    scale,
    viewW: Math.max(1, Math.round(src.width * scale)),
    viewH: Math.max(1, Math.round(src.height * scale))
  }
})

const frameStyle = computed(() => {
  const g = geom.value
  const c = crop.value
  if (!g || !c) return null
  return {
    left: `${Math.round(c.cx * g.scale)}px`,
    top: `${Math.round(c.cy * g.scale)}px`,
    width: `${Math.max(8, Math.round(c.side * g.scale))}px`,
    height: `${Math.max(8, Math.round(c.side * g.scale))}px`
  }
})

/* ------------------------------ 导出（预览读数） ------------------------------ */

let exportToken = 0

/** 用当前取景框导出「入库用」字节，并把尺寸 / 体量 / mime 读数回填到预览。 */
async function runExport() {
  const src = source.value
  if (!src || !src.bitmap || !crop.value) {
    exported.value = null
    return
  }
  const token = (exportToken += 1)
  try {
    /* 预导出走**同一个单一具名入口**（与提交时同源，不另写第二套编码）。 */
    const result = await runUploadPipeline({
      kind: 'face',
      bitmap: src.bitmap,
      options: { crop: crop.value, maxSide: IMAGE_LIMITS.maxSide }
    })
    if (token !== exportToken) return
    if (!result.ok) {
      exported.value = null
      feedback.value = `印面圖處理失敗：${result.message}`
      return
    }
    exported.value = {
      bytes: result.bytes,
      mime: result.mime,
      width: result.width,
      height: result.height
    }
    /* 管线服务层给出产物口径的如实说明（索引色 / 位深 / 调色板项数 / 体量）⇒ 原样展示。 */
    if (result.notice || result.message) feedback.value = `${result.notice ? `${result.notice} ` : ''}${result.message || ''}`.trim()
  } catch (err) {
    if (token !== exportToken) return
    exported.value = null
    feedback.value = `印面圖處理失敗：${(err && err.message) || '未知原因'}`
  }
}

/* ------------------------------ 选图 / 取景交互 ------------------------------ */

function releaseSource() {
  const src = source.value
  if (src && src.previewUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
    try {
      URL.revokeObjectURL(src.previewUrl)
    } catch {
      /* 释放失败不影响后续流程。 */
    }
  }
  source.value = null
  crop.value = null
  exported.value = null
  dragging.value = null
  exportToken += 1
}

async function onPickFace(event) {
  const file = event.target.files && event.target.files[0]
  event.target.value = ''
  if (!file) return

  releaseSource()
  feedback.value = ''

  if (!PIPELINE_READY) {
    feedback.value = PIPELINE_MISSING_MESSAGE
    return
  }

  const loaded = await loadImageFile(file)
  const denied = seals.inputDenialOf(loaded)
  if (denied) {
    /* 输入侧 reason 由**服务层结构化透传**（输入超限 ⇒ `TOO_LARGE`，§3.12.10(c)），
       提示文案与它同源；超限时再把**真实上限**与**所选文件实际体量**一并写进提示（不靠猜、不静默）。 */
    const detail = denied.reason === 'TOO_LARGE'
      ? `（所選文件 ${formatBytes(loaded.originalBytes)}，上限 ${formatBytes(IMAGE_LIMITS.maxInputBytes)}）`
      : ''
    feedback.value = `${denied.message}${detail}`
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

  source.value = {
    bitmap: loaded.bitmap,
    width: loaded.width,
    height: loaded.height,
    originalBytes: loaded.originalBytes,
    originalMime: loaded.originalMime,
    name: file.name || '已選圖片',
    previewUrl
  }
  crop.value = centerCrop(loaded.width, loaded.height)
  await runExport()
}

function startDrag(event, mode) {
  const g = geom.value
  const c = crop.value
  if (!g || !c) return
  dragging.value = {
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

function onDragMove(event) {
  const drag = dragging.value
  const src = source.value
  const g = geom.value
  if (!drag || !src || !g || g.scale <= 0) return
  /* 屏幕位移 → 原图像素位移。 */
  const dx = (event.clientX - drag.x) / g.scale
  const dy = (event.clientY - drag.y) / g.scale

  if (drag.mode === 'move') {
    crop.value = {
      cx: Math.round(clamp(drag.cx + dx, 0, src.width - drag.side)),
      cy: Math.round(clamp(drag.cy + dy, 0, src.height - drag.side)),
      side: drag.side
    }
    return
  }

  /* 缩放：锚定方框左上角，边长随位移增大（取两轴较大者，手感更跟手）。 */
  const room = Math.min(src.width - drag.cx, src.height - drag.cy)
  const side = Math.round(clamp(drag.side + Math.max(dx, dy), Math.min(MIN_CROP_SIDE, room), room))
  crop.value = { cx: drag.cx, cy: drag.cy, side: Math.max(1, side) }
}

function endDrag(event) {
  if (!dragging.value) return
  const target = event && event.currentTarget
  if (target && event.pointerId !== undefined && typeof target.releasePointerCapture === 'function') {
    try {
      target.releasePointerCapture(event.pointerId)
    } catch {
      /* 未捕获时释放会抛，忽略即可。 */
    }
  }
  dragging.value = null
  runExport()
}

function resetCrop() {
  const src = source.value
  if (!src) return
  crop.value = centerCrop(src.width, src.height)
  runExport()
}

function buildPayload(faceBytes) {
  const payload = {
    seal_name: form.seal_name.trim(), // 印文（可空 ⇒ 显示「佚名」）
    dynasty: form.dynasty,
    /* 【印面内容】（R-30）：`type` 经数据层归一为 `seal_type`（印面级＋印章行镜像）。 */
    type: form.faceContent,
    /* 【印面风格】（R-31）：**新键 `face_style`**，随印章创建一并**写入印面行**。
       未选择 ⇒ 空串 ⇒ 数据层落空串（不回落任何值）。 */
    face_style: form.faceStyle.trim(),
    /* 【大類】（本单）：**新键 `seal_class`**，随印章创建一并**写入印面行**（印面级）。 */
    seal_class: form.sealClass.trim(),
    material: form.material.trim(), // 材质（**印章级**固定属性，R-32；写印章行）
    shape: form.shape.trim(), // 形制（印章级固定属性；自由文本，可空）
    author: form.author.trim(),
    transcription: form.transcription.trim(),
    /* 已处理字节（单页 8bit Deflate TIFF；mime 由数据层按字节魔数如实判定）或 null（缺必填由服务层拒）。 */
    faceImage: faceBytes
  }
  return payload
}

async function submit() {
  if (submitting.value) return
  submitting.value = true
  feedback.value = ''
  try {
    /* 【大類】必填（人类裁定）：未选 / 非法值 ⇒ **阻止提交**（不跑影像管线、不调服务层）
       ＋ 可见繁體提示；本分支只上屏文案，**不新增 reason 字面值**。 */
    const classDenied = sealClassDenial()
    if (classDenied) {
      feedback.value = classDenied
      return
    }

    if (!PIPELINE_READY && source.value) {
      /* 模块不可用但用户已选图 ⇒ 不提交任何内容（绝不静默用原图冒充）。
         未选图时照旧落到服务层，由它给出「请选择印面图片」的可读拒绝。 */
      feedback.value = PIPELINE_MISSING_MESSAGE
      return
    }

    const src = source.value
    let faceBytes = null
    if (src && src.bitmap && crop.value) {
      /* 提交前**重新导出一次**（同一具名入口 `prepareFaceImageSource`），
         确保入库字节就是当前取景框的产物。 */
      const result = await runUploadPipeline({
        kind: 'face',
        bitmap: src.bitmap,
        options: { crop: crop.value, maxSide: IMAGE_LIMITS.maxSide }
      })
      if (!result.ok) {
        exported.value = null
        feedback.value = `印面圖處理失敗：${result.message}（本次未提交任何內容）`
        return
      }
      exported.value = {
        bytes: result.bytes,
        mime: result.mime,
        width: result.width,
        height: result.height
      }
      faceBytes = result.bytes
    }

    const result = await seals.createSealWithFace(null, buildPayload(faceBytes))
    feedback.value = result.message || (result.ok ? '已提交' : '上傳失敗，請稍後重試')
    if (result.ok) emit('uploaded', result)
  } finally {
    submitting.value = false
  }
}

onBeforeUnmount(() => {
  releaseSource()
})
</script>

<template>
  <div class="upload-mask" role="dialog" aria-modal="true" aria-label="上傳印章" data-admin-dialog="upload-seal">
    <div class="upload-box">
      <h3 class="upload-box__title">上傳印章</h3>
      <p class="upload-box__lede">
        新增一枚印章並同時新增 1 個印面與 1 張印面圖。朝代、印面內容、大類、印面圖爲必填項；
        朝代、印面內容、印面風格、大類都是封閉選擇框（只可選不可填），前兩者也是璽印匯類的篩選維度。
        印文可留空（空則顯示「佚名」）。
        形制與材質爲印章級固定屬性（自由文本，選填）。
      </p>

      <div class="field">
        <label for="upload-seal-name">印文（選填）</label>
        <input id="upload-seal-name" v-model="form.seal_name" type="text" placeholder="例：某某之印；留空即顯示「佚名」" />
        <!-- 三動作轉換（R-73/R-74/R-75）：**只在點按時**轉換；提交路徑不轉（提交值＝用戶所見的當前值）。 -->
        <TextTransformButtons v-model="form.seal_name" field-key="upload:seal_name" field-label="印文" />
      </div>

      <div class="field">
        <label for="upload-seal-dynasty">朝代</label>
        <!-- 封闭选择框：选项只来自真源常量 DYNASTY_OPTIONS（共 14 项，逐字规范顺序）；
             无「∪ 库内派生值」、无自定义输入项。 -->
        <select id="upload-seal-dynasty" v-model="form.dynasty" data-dynasty-select="upload-seal">
          <option v-for="item in dynastyOptions" :key="item" :value="item">{{ item }}</option>
        </select>
        <span class="field__hint">
          朝代固定 14 類（本框共 {{ dynastyOptions.length }} 項），只可選不可填。
        </span>
        <span v-if="!form.dynasty" class="field__hint" data-dynasty-unselected="upload-seal">
          尚未選擇朝代（必填）。
        </span>
        <span v-if="!DYNASTY_READY" class="field__hint" data-dynasty-degraded="upload-seal">
          {{ DYNASTY_MISSING_MESSAGE }}
        </span>
      </div>

      <div class="field">
        <label for="upload-seal-type">印面內容</label>
        <!-- 封闭选择框（R-30）：选项只来自真源常量 FACE_CONTENT_OPTIONS（共 9 值，逐字规范顺序）；
             无「∪ 库内派生值」、无自定义输入项、**不追加占位项**（选项数逐字＝真源长度）⇒
             `form.faceContent` 空值时不匹配任何 option（select 显示空），不会静默替用户取值。 -->
        <select id="upload-seal-type" v-model="form.faceContent" data-face-content-select="upload-seal">
          <option v-for="item in faceContentOptions" :key="item" :value="item">{{ item }}</option>
        </select>
        <span class="field__hint">
          印面內容固定 9 類（本框共 {{ faceContentOptions.length }} 項），只可選不可填；是廣場篩選維度。
        </span>
        <span v-if="!form.faceContent" class="field__hint" data-face-content-unselected="upload-seal">
          尚未選擇印面內容（必填）。
        </span>
        <span v-if="!FACE_CONTENT_READY" class="field__hint" data-face-content-degraded="upload-seal">
          {{ FACE_CONTENT_MISSING_MESSAGE }}
        </span>
      </div>

      <div class="field">
        <label for="upload-seal-style">印面風格（選填）</label>
        <!-- 封闭选择框（R-31）：选项只来自真源常量 FACE_STYLE_OPTIONS（共 23 值，逐字规范顺序）；
             无「∪ 库内派生值」、无自定义输入项、不追加占位项。 -->
        <select id="upload-seal-style" v-model="form.faceStyle" data-face-style-select="upload-seal">
          <option v-for="item in faceStyleOptions" :key="item" :value="item">{{ item }}</option>
        </select>
        <span class="field__hint">
          印面風格固定 23 類（本框共 {{ faceStyleOptions.length }} 項），只可選不可填；不選即不寫入該項。
        </span>
        <span v-if="!FACE_STYLE_READY" class="field__hint" data-face-style-degraded="upload-seal">
          {{ FACE_STYLE_MISSING_MESSAGE }}
        </span>
      </div>

      <div class="field">
        <label for="upload-seal-class">大類</label>
        <!-- 【大類】（本单）：封闭选择框，选项只来自真源常量 SEAL_CLASS_OPTIONS（共 3 值，逐字规范顺序）；
             不追加占位项、无自由文本。**必填**（未选 ⇒ 提交被拒 ＋ 可见繁體提示）。
             **按朝代预填建议**（suggestSealClass），**不锁死**：
             用户手改（@change）后以用户所选为准，朝代变动不再覆盖。 -->
        <select
          id="upload-seal-class"
          v-model="form.sealClass"
          data-seal-class-select="upload-seal"
          @change="onSealClassChange"
        >
          <option v-for="item in sealClassOptions" :key="item" :value="item">{{ item }}</option>
        </select>
        <span class="field__hint">
          大類固定 3 類（本框共 {{ sealClassOptions.length }} 項），只可選不可填（必填）；按朝代自動預填建議，可手動改選（手改後以你的選擇為準）。
        </span>
        <span v-if="!form.sealClass" class="field__hint" data-seal-class-unselected="upload-seal">
          尚未選擇大類（必填）。
        </span>
        <span
          v-if="sealClassSuggested && !sealClassTouched"
          class="field__hint"
          data-seal-class-suggestion="upload-seal"
        >
          依所選朝代建議為「{{ sealClassSuggested }}」，可自行改選。
        </span>
        <span v-if="!SEAL_CLASS_READY" class="field__hint" data-seal-class-degraded="upload-seal">
          {{ SEAL_CLASS_MISSING_MESSAGE }}
        </span>
      </div>

      <div class="field">
        <label for="upload-seal-material">材質（選填）</label>
        <!-- 材质＝**印章级**固定属性（R-32/R-40；真源＝印章行 `material`）：自由文本、选填。
             印面行不再写材质（新建印面的该键为空串，由数据层保证）。 -->
        <input id="upload-seal-material" v-model="form.material" type="text" placeholder="例：青田石" />
        <TextTransformButtons v-model="form.material" field-key="upload:material" field-label="材質" />
        <span class="field__hint">整枚印章一個（印章級，不是印面級）；自由文本，不參與廣場篩選。</span>
      </div>

      <div class="field">
        <label for="upload-seal-shape">形制（選填）</label>
        <!-- 形制＝**印章级**固定属性（与「材质」同待遇）：自由文本、不强制枚举、不参与广场筛选。 -->
        <input id="upload-seal-shape" v-model="form.shape" type="text" placeholder="例：方形／長方形／圓形／隨形" />
        <TextTransformButtons v-model="form.shape" field-key="upload:shape" field-label="形制" />
        <span class="field__hint">整枚印章一個（不是印面級）；自由文本，不參與廣場篩選。</span>
      </div>

      <div class="field">
        <label for="upload-seal-author">作者（選填）</label>
        <input id="upload-seal-author" v-model="form.author" type="text" placeholder="例：鄧石如" />
        <TextTransformButtons v-model="form.author" field-key="upload:author" field-label="作者" />
      </div>

      <div class="field">
        <label for="upload-seal-transcription">印文釋義（選填）</label>
        <input id="upload-seal-transcription" v-model="form.transcription" type="text" placeholder="例：某某之印，白文" />
        <TextTransformButtons v-model="form.transcription" field-key="upload:transcription" field-label="印文釋義" />
      </div>

      <div class="field">
        <label for="upload-seal-face">印面圖（必填）</label>
        <input id="upload-seal-face" type="file" accept="image/*" @change="onPickFace" />
        <span class="field__hint">
          本機圖片文件（JPG / PNG / WebP），單張不超過 <b>{{ limitLabel }}</b>（{{ IMAGE_LIMITS.maxInputBytes }} 字節）。
          選定後在本機取方形，入庫爲 TIFF 影像（單頁 8bit Deflate）；頁面預覽以 WebP 呈現，頁面只保留運行時預覽。
        </span>

        <div v-if="source" class="cropper" data-upload-preview="seal-face">
          <div class="cropper__view" :style="{ width: `${geom.viewW}px`, height: `${geom.viewH}px` }">
            <img v-if="source.previewUrl" class="cropper__img" :src="source.previewUrl" alt="印面圖預覽" />
            <div v-else class="cropper__img cropper__img--missing">預覽不可用（原圖仍可處理）</div>
            <div
              v-if="frameStyle"
              class="cropper__frame"
              data-crop-frame="seal-face"
              :style="frameStyle"
              @pointerdown="startDrag($event, 'move')"
              @pointermove="onDragMove"
              @pointerup="endDrag"
              @pointercancel="endDrag"
            >
              <span
                class="cropper__handle"
                data-crop-handle="seal-face"
                @pointerdown.stop="startDrag($event, 'resize')"
                @pointermove="onDragMove"
                @pointerup="endDrag"
                @pointercancel="endDrag"
              ></span>
            </div>
          </div>
          <p class="cropper__hint">拖動方框移動取景；拖右下角方塊縮放方框。方框內即爲入庫的印面。</p>
          <button class="btn btn--ghost cropper__reset" type="button" @click="resetCrop">恢復居中方框</button>
          <p class="cropper__summary" data-upload-summary="seal-face">
            已選 {{ source.name }} · 原圖 {{ source.width }} × {{ source.height }} · 原文件 {{ formatBytes(source.originalBytes) }}
            ⇒ 入庫印面
            <template v-if="exported">
              {{ exported.width }} × {{ exported.height }} · {{ exported.mime }} · {{ formatBytes(exported.bytes.length) }}
            </template>
            <template v-else>處理中…</template>
            （最長邊 ≤ {{ maxSideLabel }}、質量 {{ IMAGE_LIMITS.quality }}）
          </p>
        </div>
        <span v-else class="field__hint">選擇本機圖片文件（JPG / PNG / WebP），不上傳任何外部地址。</span>
      </div>

      <p v-if="feedback" class="upload-box__feedback" data-admin-feedback="upload-seal">{{ feedback }}</p>
      <!-- 上传端管线的**可读降级提示**（唯一具名入口不可调用时上屏；就绪 ⇒ 空串 ⇒ 零渲染）。 -->
      <p v-if="FACE_PIPELINE_NOTICE && !feedback" class="upload-box__feedback" data-pipeline-degraded="upload-seal">
        {{ FACE_PIPELINE_NOTICE }}
      </p>

      <div class="upload-box__foot">
        <button class="btn btn--ghost" type="button" @click="emit('close')">取消</button>
        <button
          class="btn btn--primary"
          type="button"
          data-action="upload-seal-submit"
          :disabled="submitting"
          @click="submit"
        >
          {{ submitting ? '正在上傳…' : '確認上傳' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.upload-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-overlay);
  overflow: auto;
}

.upload-box {
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

.upload-box__title {
  margin-bottom: var(--s-2);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.upload-box__lede {
  margin-bottom: var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.cropper {
  margin-top: var(--s-3);
}

.cropper__view {
  position: relative;
  max-width: 100%;
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--c-surface-sunken);
  touch-action: none;
  user-select: none;
}

.cropper__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  -webkit-user-drag: none;
}

.cropper__img--missing {
  display: grid;
  place-items: center;
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.cropper__frame {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid var(--slot-gold-text);
  box-shadow: 0 0 0 9999px var(--c-mask-strong);
  cursor: move;
  touch-action: none;
}

.cropper__handle {
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

.cropper__hint {
  margin-top: var(--s-2);
  color: var(--c-text-muted);
  font-size: var(--t-xs, var(--t-sm));
}

.cropper__reset {
  margin-top: var(--s-2);
}

.cropper__summary {
  margin-top: var(--s-2);
  color: var(--c-text);
  font-size: var(--t-sm);
}

.upload-box__feedback {
  margin-top: var(--s-3);
  margin-bottom: var(--s-3);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
}

.upload-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
}
</style>
