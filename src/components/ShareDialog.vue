
<script setup>
/**
 * 分享弹窗（**資料夾的分享短链**｜v1.21 新增｜K-2）。
 *
 * 依据：规范 §3.21.5（分享短链：`/s/<8 位短碼>`、默認 30 天過期、重新生成作废旧链）
 * ＋ §3.21.11（钩子族：`share-folder` / `regenerate-link` / `copy-link`）
 * ＋ §3.21.12（逐字文案表第 20 ～ 24 行）。
 * 契约：**只消费 K-1 的 `services/drive.js`**（本组件不直接 import `../data/*`，
 * 也不读写任何浏览器存储；短码 / 有效期一律取自服务层常量，**不硬编码数值**）。
 *
 * 链接形态（§3.21.5(b)）：`<origin>/s/<code>` —— `<origin>` 取当前站 origin
 * （dev 下即 `http://127.0.0.1:5163`；本组件不自造域名）。
 *
 * 上屏文案一律繁体（`s2t(x) === x`），且**零「切分」措辞**。
 */
import { computed, onMounted, ref } from 'vue'
import { drive } from '../services/index.js'

const props = defineProps({
  /** 資料夾行（含 `id` / `name` / `owner_user_id`；**分享仅限拥有者**）。 */
  folder: { type: Object, required: true },
  /** 当前用户是否即该夹拥有者（非拥有者 ⇒ 重新生成入口**不渲染** ＋ 给可读引导）。 */
  isOwner: { type: Boolean, default: true }
})
const emit = defineEmits(['close', 'changed'])

/** 有效期说明的数值走服务层常量（`720 小时 / 24 = 30 天`）—— **不硬编码**。 */
const ttlDays = drive.SHARE_TTL_HOURS / 24

const share = ref(null)
const notice = ref('')
const copyState = ref('')
/** 短码生成失败（服务层结构化拒绝）时给可读文案，仍可重试。 */
const failed = ref(false)

const code = computed(() => (share.value && share.value.code) || '')
const link = computed(() => {
  if (!code.value) return ''
  const origin = typeof window !== 'undefined' && window.location ? window.location.origin : ''
  return `${origin}/s/${code.value}`
})

/** 打开弹窗即确保存在一条有效分享（已有有效分享 ⇒ 服务层直接沿用，不新生成链）。 */
function ensureShare() {
  const out = drive.createShare(props.folder.id)
  if (!out.ok) {
    failed.value = true
    notice.value = out.message || '分享連結暫不可用，請稍後再試。'
    return
  }
  failed.value = false
  share.value = out.row
  notice.value = out.message
  if (out.created) emit('changed', out)
}

onMounted(ensureShare)

/** 重新生成（钩子 `regenerate-link`）：**旧連結立即失效**（服务层把旧行落 `revoked_at`、不删行）。 */
function regenerate() {
  const out = drive.regenerateShare(props.folder.id)
  if (!out.ok) {
    failed.value = true
    notice.value = out.message || '重新生成失敗，請稍後再試。'
    return
  }
  failed.value = false
  share.value = out.row
  notice.value = out.message
  copyState.value = ''
  emit('changed', out)
}

/** 复制連結（钩子 `copy-link`）：优先用剪贴板 API，不可用时回落文本域选取复制。 */
async function copyLink() {
  copyState.value = ''
  const text = link.value
  if (!text) {
    copyState.value = '連結尚未就緒，請稍後再試。'
    return
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      copyState.value = '連結已複製。'
      return
    }
  } catch (err) {
    /* 落到下面的回落路径。 */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'readonly')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand && document.execCommand('copy')
    document.body.removeChild(area)
    copyState.value = ok ? '連結已複製。' : '複製未成功，請手動選中連結後複製。'
  } catch (err) {
    copyState.value = '複製未成功，請手動選中連結後複製。'
  }
}
</script>

<template>
  <div
    class="share-mask"
    role="dialog"
    aria-modal="true"
    aria-label="分享資料夾"
    data-drive-dialog="share-folder"
  >
    <div class="share-box">
      <h3 class="share-box__title">分享資料夾</h3>
      <p class="share-box__lede">
        分享對象：{{ folder.name }}（{{ folder.code || folder.id }}）。任何人憑本連結即可查看，
        有效期內有效。
      </p>

      <div class="field">
        <label for="drive-share-link">分享連結</label>
        <input id="drive-share-link" :value="link" type="text" readonly data-drive-link="share-folder" />
        <span class="field__hint">連結有效期 {{ ttlDays }} 天，過期後自動失效。</span>
      </div>

      <p v-if="notice" class="share-box__notice" data-drive-feedback="share-folder">{{ notice }}</p>
      <p v-if="copyState" class="share-box__copy" data-drive-feedback="copy-link">{{ copyState }}</p>

      <p v-if="isOwner" class="share-box__warn" data-drive-regenerate-hint="share-folder">
        重新生成後，舊連結立即失效。
      </p>
      <p v-else class="share-box__warn" data-drive-owner-hint="share-folder">
        只有資料夾的所有者可以重新生成連結。
      </p>

      <div class="share-box__foot">
        <button
          class="btn btn--ghost"
          type="button"
          data-drive-action="copy-link"
          @click="copyLink"
        >
          複製連結
        </button>
        <button
          v-if="isOwner"
          class="btn btn--ghost"
          type="button"
          data-drive-action="regenerate-link"
          @click="regenerate"
        >
          重新生成連結
        </button>
        <button class="btn btn--primary" type="button" @click="emit('close')">關閉</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.share-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-overlay);
  overflow: auto;
}

.share-box {
  width: 100%;
  max-width: 460px;
  max-height: 88vh;
  overflow: auto;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.share-box__title {
  margin-bottom: var(--s-2);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.share-box__lede {
  margin-bottom: var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.share-box__notice,
.share-box__copy {
  margin-top: var(--s-3);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
}

.share-box__warn {
  margin-top: var(--s-3);
  color: var(--c-warn);
  font-size: var(--t-xs);
}

.share-box__foot {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-5);
}
</style>
