<script setup>
/**
 * 玺爱 · 詳情頁「新增印面」彈窗（管理員專屬｜本單）
 * ============================================================================
 * 契約真源 ＝ `docs/add-seal-face-ruling-2026-11-14.md` §四（前端契约）。硬口徑：
 *   1. **圖必填**，兩條並列路徑：① 選擇本機文件；② 粘貼剪貼板 —— 判定內核**只**用
 *      `utils/clipboardImage.js` 的 `PASTE_HINT` / `handleClipboardPaste`（**不另寫貼圖解析**）；
 *      兩條路徑共用**同一處理體** `applyFile(file)`（解碼 / 上限校驗 / 導出全站只有一份）。
 *   2. 上傳管道只走既有單點：`loadImageFile` → `seals.inputDenialOf` → `runUploadPipeline`
 *      （產出**單頁 8bit Deflate TIFF**）→ 交服務層 `seals.addSealFace`（內部 `storeArtifactBytes`
 *      → `registerFaceImage` → `addSealFace`）。**不**拿原始 PNG / JPG 字節入冊。
 *   3. 彈窗口徑：`role="dialog"` ＋ `aria-label`；**一次性提交守衛**（`submitting` / `submitted`）；
 *      提交中按鈕 disabled；成功 ⇒ 上抛 `added`（頁面級提示 ＋ 重取快照由宿主頁做）。
 *   4. 失敗**如實上屏**（服務層 `message` 原文，不吞成一句）；服務層回 `registered:true` 時文案
 *      本身即「影像已入冊但印面未建立」，本組件不另行改寫。
 *   本組件**不掛** `data-admin-action`（該族取值集合已凍結）：彈窗按鈕只用 `data-action`。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import TextTransformButtons from './TextTransformButtons.vue'
import { pipelineNotice, runUploadPipeline } from './uploadPipeline.js'
import { seals } from '../services/index.js'
import { IMAGE_LIMITS, loadImageFile } from '../utils/image.js'
import { formatBytes } from '../utils/format.js'
/* 剪貼板一鍵粘貼圖片（共用純函數）：與本框 `@paste` 同源，不另寫貼圖解析。 */
import { PASTE_HINT, handleClipboardPaste } from '../utils/clipboardImage.js'

/* 面類別字面值（`FACE` / `EDGE`）的唯一真源：經服務層已導出的 `FACE_KIND` 取用，
   本組件不自寫第二份字面值（`services/index.js` 不轉出該常量，故由 `seals` 命名空間取）。 */
const FACE_KIND = seals.FACE_KIND

const props = defineProps({
  /** 目標印章的藏品編號（`stamp_id`；建面時作 `stamp_id` 上送）。 */
  stampId: { type: String, required: true },
  /** 頁面顯示名（只用于標題旁的人類可讀交代；不参与任何請求）。 */
  sealTitle: { type: String, default: '' }
})
const emit = defineEmits(['close', 'added'])

/** 印文上限（與服務層 / 雲函數同一值；本組件不自寫第二個數字）。 */
const SEAL_NAME_MAX = seals.FACE_ADD_SEAL_NAME_MAX || 500
/** 上傳端管線降級讀數：入口不可調用時給可讀繁體說明（就緒 ⇒ 空串 ⇒ 零噪聲）。 */
const PIPELINE_NOTICE = pipelineNotice('face')
const PIPELINE_READY = typeof loadImageFile === 'function' && !PIPELINE_NOTICE
const PIPELINE_MISSING_MESSAGE =
  PIPELINE_NOTICE ||
  '圖像處理模塊未就緒（utils/image.js 的 loadImageFile 不可用），暫時無法在本機處理印面圖，請稍後重試。'

const KIND_OPTIONS = [
  { value: FACE_KIND.FACE, label: '印面' },
  { value: FACE_KIND.EDGE, label: '邊款' }
]

/** 面類別（缺省 `FACE`；`EDGE` ＝ 邊款，屬同章的特殊印面）。 */
const kind = ref(FACE_KIND.FACE)
/** 印文（**選填**，≤ 既有上限）。 */
const sealName = ref('')
/** 已選原圖：`{ bitmap, width, height, originalBytes, originalMime, name, previewUrl }`。 */
const source = ref(null)
/** 最近一次導出讀數：`{ bytes, mime, width, height }`（僅供展示；提交時重新導出）。 */
const exported = ref(null)
/** 可讀反饋（處理中 / 失敗 / 「影像已入冊但印面未建立」）。 */
const feedback = ref('')
/** 提交中（防重複提交；按鈕 disabled）。 */
const submitting = ref(false)
/** 一次性提交守衛：成功後不得再發第二次（即使宿主尚未關窗）。 */
const submitted = ref(false)
/** 服務層回 `registered:true` 的失敗 ⇒ 影像已入冊（上屏用不同鉤子，語義不混）。 */
const imageRegistered = ref(false)

const limitLabel = formatBytes(IMAGE_LIMITS.maxInputBytes)
const sealNameTooLong = computed(() => sealName.value.trim().length > SEAL_NAME_MAX)

function releaseSource() {
  const src = source.value
  if (src && src.previewUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
    try {
      URL.revokeObjectURL(src.previewUrl)
    } catch {
      /* 釋放失敗不影響後續流程。 */
    }
  }
  source.value = null
  exported.value = null
}

/** 預導出：用**同一個單一具名入口**（與提交時同源，不另寫第二套編碼）。 */
async function runExport() {
  const src = source.value
  if (!src || !src.bitmap) {
    exported.value = null
    return
  }
  try {
    const result = await runUploadPipeline({
      kind: 'face',
      bitmap: src.bitmap,
      options: { maxSide: IMAGE_LIMITS.maxSide }
    })
    if (source.value !== src) return
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
    if (result.notice) feedback.value = result.notice
  } catch (err) {
    if (source.value !== src) return
    exported.value = null
    feedback.value = `印面圖處理失敗：${(err && err.message) || '未知原因'}`
  }
}

/** 選圖 / 粘貼**共用處理體**：解碼 → 輸入側上限（服務層結構化透傳）→ 預導出。 */
async function applyFile(file) {
  if (!file || submitting.value) return
  releaseSource()
  feedback.value = ''
  imageRegistered.value = false

  if (!PIPELINE_READY) {
    feedback.value = PIPELINE_MISSING_MESSAGE
    return
  }
  const loaded = await loadImageFile(file)
  const denied = seals.inputDenialOf(loaded)
  if (denied) {
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
  await runExport()
}

/** ① 選擇本機文件。 */
function onPickFile(event) {
  const file = event.target.files && event.target.files[0]
  event.target.value = ''
  void applyFile(file)
}

/** ② 粘貼剪貼板：`handleClipboardPaste` 判定是否接管；**文字優先不劫持**（含文字則放行默認粘貼）。 */
function onPaste(event) {
  const decision = handleClipboardPaste(event, (file) => {
    void applyFile(file)
  })
  if (decision.handled) event.preventDefault()
  else if (decision.reason !== 'TEXT_PRIORITY') feedback.value = decision.message
}

function close() {
  if (submitting.value) return
  releaseSource()
  emit('close')
}

/** 提交：**提交前重新導出一次**（確保入冊字節就是當前處理結果）→ 交服務層建面。 */
async function submit() {
  if (submitting.value || submitted.value) return
  feedback.value = ''
  imageRegistered.value = false
  if (!source.value || !source.value.bitmap) {
    feedback.value = '請先選擇一張本機圖片文件，或把游標置於圖片區粘貼剪貼板中的圖片（印面圖必填）。'
    return
  }
  if (sealNameTooLong.value) {
    feedback.value = `印文超過 ${SEAL_NAME_MAX} 字上限，請縮短後再提交。`
    return
  }
  const stampId = String(props.stampId || '').trim()
  if (!stampId) {
    feedback.value = '未取得本印章的藏品編號，暫時無法新增印面（請重新整理後再試）。'
    return
  }
  submitting.value = true
  try {
    const result = await runUploadPipeline({
      kind: 'face',
      bitmap: source.value.bitmap,
      options: { maxSide: IMAGE_LIMITS.maxSide }
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
    const added = await seals.addSealFace({
      stampId,
      kind: kind.value,
      sealName: sealName.value.trim(),
      bytes: result.bytes,
      mime: result.mime,
      width: result.width,
      height: result.height
    })
    if (!added.ok) {
      /* 如實上屏：服務層文案原文（含「影像已入冊但印面未建立」的如實交代），不吞成一句。 */
      imageRegistered.value = added.registered === true
      feedback.value = added.message
      return
    }
    submitted.value = true
    releaseSource()
    emit('added', added)
  } catch (err) {
    feedback.value = `新增印面失敗：${(err && err.message) || '未知原因'}（本次未確認結果，請重新整理後再試）`
  } finally {
    submitting.value = false
  }
}

onBeforeUnmount(() => {
  releaseSource()
})
</script>

<template>
  <div
    class="add-face-mask"
    role="dialog"
    aria-modal="true"
    aria-label="新增印面"
    data-add-face-dialog
  >
    <div class="add-face-box">
      <h3 class="add-face-box__title">新增印面</h3>
      <p class="add-face-box__lede">
        爲本印章新增一個印面（或一個邊款）。印面圖必填；印文選填，可稍後在「編輯固定屬性」補齊。
        <template v-if="sealTitle">當前印章：{{ sealTitle }}<template v-if="stampId">（藏品編號 {{ stampId }}）</template>。</template>
      </p>

      <div class="field">
        <label>類型</label>
        <div class="add-face-kinds">
          <label v-for="option in KIND_OPTIONS" :key="option.value" class="add-face-kind">
            <input
              v-model="kind"
              type="radio"
              name="add-seal-face-kind"
              :value="option.value"
              :disabled="submitting"
              data-add-face-kind
            />
            <span>{{ option.label }}</span>
          </label>
        </div>
        <span class="field__hint">
          印面（FACE）會計入本印章的印面數；邊款（EDGE）是其中的特殊印面，不計入印面數。
        </span>
      </div>

      <div class="field">
        <label for="add-seal-face-name">印文（選填）</label>
        <input
          id="add-seal-face-name"
          v-model="sealName"
          type="text"
          :maxlength="SEAL_NAME_MAX"
          :disabled="submitting"
          placeholder="例：某某之印（可不填，建面後仍可編輯）"
          data-add-face-seal-name
        />
        <TextTransformButtons v-model="sealName" field-key="add-seal-face:seal_name" field-label="印文" />
        <span class="field__hint">
          上限 {{ SEAL_NAME_MAX }} 字；留空亦可提交（屬性可在「編輯固定屬性」補）。
        </span>
      </div>

      <div class="field" tabindex="0" data-paste-zone="add-seal-face" @paste="onPaste">
        <label for="add-seal-face-image">印面圖（必填）</label>
        <input
          id="add-seal-face-image"
          type="file"
          accept="image/*"
          :disabled="submitting"
          data-add-face-file
          @change="onPickFile"
        />
        <span class="field__hint" data-paste-hint="add-seal-face">{{ PASTE_HINT }}</span>
        <span class="field__hint">
          本機圖片文件（JPG / PNG / WebP），單張不超過 <b>{{ limitLabel }}</b>（{{ IMAGE_LIMITS.maxInputBytes }} 字節）。
          選定後在本機處理爲單頁 8bit Deflate TIFF 後入庫；頁面只保留運行時預覽。
        </span>

        <div v-if="source" class="add-face-preview" data-add-face-preview>
          <img v-if="source.previewUrl" class="add-face-preview__img" :src="source.previewUrl" alt="印面圖預覽" />
          <div v-else class="add-face-preview__img add-face-preview__img--missing">預覽不可用（原圖仍可處理）</div>
          <p class="add-face-preview__summary" data-add-face-summary>
            已選 {{ source.name }} · 原圖 {{ source.width }} × {{ source.height }} · 原文件 {{ formatBytes(source.originalBytes) }}
            ⇒ 入庫
            <template v-if="exported">
              {{ exported.width }} × {{ exported.height }} · {{ exported.mime }} · {{ formatBytes(exported.bytes.length) }}
            </template>
            <template v-else>處理中…</template>
          </p>
        </div>
        <p v-else class="field__hint" data-add-face-image-missing>尚未選圖（印面圖必填）。</p>
      </div>

      <p v-if="feedback" class="notice" :data-add-face-feedback="imageRegistered ? 'image-registered' : 'plain'">
        {{ feedback }}
      </p>

      <div class="add-face-box__foot">
        <button
          class="btn btn--ghost"
          type="button"
          data-action="add-seal-face-cancel"
          :disabled="submitting"
          @click="close"
        >
          取消
        </button>
        <button
          class="btn btn--primary"
          type="button"
          data-action="add-seal-face-submit"
          :disabled="submitting || submitted"
          @click="submit"
        >
          {{ submitting ? '提交中…' : '提交' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.add-face-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-overlay);
  overflow: auto;
}

.add-face-box {
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

.add-face-box__title {
  margin-bottom: var(--s-2);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.add-face-box__lede {
  margin-bottom: var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.add-face-kinds {
  display: flex;
  gap: var(--s-4);
  align-items: center;
}

.add-face-kind {
  display: inline-flex;
  gap: var(--s-1);
  align-items: center;
  cursor: pointer;
}

.add-face-preview {
  margin-top: var(--s-3);
  display: flex;
  gap: var(--s-3);
  align-items: flex-start;
}

.add-face-preview__img {
  max-width: 160px;
  max-height: 160px;
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
  object-fit: contain;
}

.add-face-preview__img--missing {
  display: grid;
  place-items: center;
  width: 160px;
  height: 120px;
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.add-face-preview__summary {
  margin: 0;
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.add-face-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-4);
}
</style>
