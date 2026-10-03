
<script setup>
/**
 * 「编辑固定属性」表单（**管理员专属按钮**的载体，内嵌在印章详情页的印面区块内）。
 *
 * 能力 5：按**印面**逐项编辑固定属性 —— 印面图片（影像编号）/ 边款图片 ID。
 * 走冻结 API `seals.updateSealFixedAttributes(actor, faceId, patch)`：
 * `patch` 只允许这两个键，且只提交**发生改动**的键。
 *
 * **R-32（2026-09-20｜材质移级）**：【材质】`material` 已**从印面级固定属性移出**，
 * 移入**印章级**「印章固定属性」区（`shape` ＋ `material`，入口
 * `data-admin-action="edit-seal-attributes"`）。印面级白名单 `FIXED_ATTR_FIELDS`
 * 现为 `['face_image_id','edge_image_ids']` ⇒ 本对话框**不得**再提交 `material`
 * （塞进去会被数据层判 `INVALID_FIELD`，且旧值保留在印面行上**不改写**）。
 *
 * 拒绝形态一律读 `ok` / `reason` / `message` 并把 `message` 原文展示（不做 toast）。
 * 表单里出现的影像编号来自**本印章的影像清单**（服务层派生），不读写任何浏览器存储。
 */

import { computed, reactive, ref } from 'vue'
import { seals, corrections } from '../services/index.js'

const props = defineProps({
  face: { type: Object, required: true },
  seal: { type: Object, default: null }
})

const emit = defineEmits(['close', 'saved'])

const feedback = ref('')
const saving = ref(false)

const canEditFixed = computed(() => seals.canEditFixedAttributes())

/** 本印章的影像清单（用于挑选印面图片编号；编号仍在清单外时保留当前值）。 */
const imageOptions = computed(() => {
  const sealId = props.face.sealId || props.face.stamp_id || ''
  const rows = sealId ? seals.listImagesByStamp(sealId) : []
  const list = rows.map((row) => ({
    id: String(row.id),
    label: `${row.id}（${row.kind === seals.FACE_KIND.EDGE ? '邊款圖' : '印面圖'}）`
  }))
  const current = props.face.face_image_id ? String(props.face.face_image_id) : ''
  if (current && !list.some((item) => item.id === current)) {
    list.unshift({ id: current, label: `${current}（當前值）` })
  }
  return list
})

const edgeIdOptions = computed(() => {
  const sealId = props.face.sealId || props.face.stamp_id || ''
  const rows = sealId ? seals.listImagesByStamp(sealId) : []
  return rows
    .filter((row) => row.kind === seals.FACE_KIND.EDGE)
    .map((row) => String(row.id))
})

const base = computed(() => seals.fixedAttributesOf(props.face))

const form = reactive({
  face_image_id: base.value.face_image_id || '',
  edge_image_ids: base.value.edge_image_ids.join('、')
})

function edgeIdsOf(text) {
  return String(text || '')
    .split(/[、,，\s]+/)
    .filter(Boolean)
}

function submit() {
  if (saving.value) return
  saving.value = true
  feedback.value = ''
  try {
    const current = seals.fixedAttributesOf(props.face)
    const patch = {}
    if ((form.face_image_id || '') !== (current.face_image_id || '')) {
      patch.face_image_id = form.face_image_id || ''
    }
    if (edgeIdsOf(form.edge_image_ids).join('|') !== current.edge_image_ids.join('|')) {
      patch.edge_image_ids = edgeIdsOf(form.edge_image_ids)
    }
    if (Object.keys(patch).length === 0) {
      feedback.value = '沒有檢測到改動：請先修改要保存的項目。'
      return
    }
    const result = seals.updateSealFixedAttributes(null, props.face.id, patch)
    /* 数据层的拒绝文案**原文展示**（不做 toast、不吞 reason）：值域门 / 白名单门的可读说明都经此上屏。 */
    feedback.value = result.ok
      ? `${result.message || '印面固定屬性已保存。'}（已保存：${Object.keys(patch).join('、')}）`
      : `保存未生效：${result.message}`
    if (result.ok) {
      const fresh = seals.getFaceById(props.face.id)
      if (fresh) {
        const next = seals.fixedAttributesOf(fresh)
        form.face_image_id = next.face_image_id || ''
        form.edge_image_ids = next.edge_image_ids.join('、')
      }
      emit('saved', result)
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    class="fixed-mask"
    role="dialog"
    aria-modal="true"
    aria-label="編輯固定屬性"
    data-admin-dialog="edit-fixed-attributes"
  >
    <div class="fixed-box">
      <h3 class="fixed-box__title">編輯固定屬性</h3>
      <p class="fixed-box__lede">
        編輯對象：{{ corrections.resolveSealDisplayName(face) }} · {{ face.id }}（固定屬性按印面歸屬）。
        只提交發生改動的項目。
      </p>
      <p class="fixed-box__lede">
        本對話框只含「印面級」固定屬性（印面圖片 / 邊款圖片 ID）。
        材質已改爲「印章級」固定屬性，請到頁面頂部的「印章固定屬性」區編輯。
      </p>

      <div class="field">
        <label for="fixed-face-image">印面圖片（影像編號）</label>
        <select id="fixed-face-image" v-model="form.face_image_id">
          <option value="">（不設置印面圖片）</option>
          <option v-for="item in imageOptions" :key="item.id" :value="item.id">{{ item.label }}</option>
        </select>
        <span class="field__hint">可選編號來自本印章的影像清單；留空即清除印面圖。</span>
      </div>

      <div class="field">
        <label for="fixed-edge-ids">邊款圖片 ID</label>
        <input id="fixed-edge-ids" v-model="form.edge_image_ids" type="text" placeholder="多個編號用頓號分隔，如 img-0001e" />
        <span v-if="edgeIdOptions.length" class="field__hint">
          本印章現有邊款影像編號：{{ edgeIdOptions.join('、') }}
        </span>
        <span v-else class="field__hint">本印章暫無邊款影像；留空表示不登記邊款圖片 ID。</span>
      </div>

      <p v-if="feedback" class="fixed-box__feedback" data-admin-feedback="edit-fixed">{{ feedback }}</p>

      <div class="fixed-box__foot">
        <button class="btn btn--ghost" type="button" @click="emit('close')">關閉</button>
        <button
          class="btn btn--primary"
          type="button"
          data-action="edit-fixed-attributes-submit"
          :disabled="saving"
          @click="submit"
        >
          {{ saving ? '正在保存…' : '保存固定屬性' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fixed-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-overlay);
  overflow: auto;
}

.fixed-box {
  width: 100%;
  max-width: 480px;
  max-height: 88vh;
  overflow: auto;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.fixed-box__title {
  margin-bottom: var(--s-2);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.fixed-box__lede {
  margin-bottom: var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.fixed-box__feedback {
  margin-bottom: var(--s-3);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
}

.fixed-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
}
</style>
