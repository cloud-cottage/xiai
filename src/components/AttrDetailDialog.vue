<script setup>
/**
 * 屬性詳情模态框（2026-11-14 裁定 §三④）。
 * ---------------------------------------------------------------------------
 * 由属性列表的**行本体**（`data-action="attr-detail"` 的 `button`）打开；三栏内容与改造前的
 * 属性表格单元格**逐字一致**（當前展示值 / 來源 / 待審覈）——取值口径在调用方
 * （`SealDetailView.openAttrDetail`）按原判据拼装后传进来，本组件**只呈现、不派生**。
 * 底部：【勘誤】（单条 ⇒ 调用方打开字段已锁定的勘误弹窗，仍走既有 `submitCorrection`）＋ 關閉。
 *
 * 钩子一律 `data-action`（`attr-correction-detail` / `attr-detail-close`），**不进**
 * `[data-admin-action]` 族（该族取值集合已冻结）。
 * ESC ＝ 关闭：全仓单点实现 `useEscToClose`（本组件随 `v-if` 挂载 ⇒ 缺省恒为最上层）。
 */
import { useEscToClose } from '../utils/useEscToClose.js'

defineProps({
  /* 屬性名（如「作者」「印面內容」）。 */
  label: { type: String, required: true },
  /* 當前展示值（原表格同格文案，含作者单点派生链的结果）。 */
  value: { type: String, default: '' },
  /* 採納勘誤时的副行（「原始值：…」）；无则空串 ⇒ 不渲染。 */
  original: { type: String, default: '' },
  /* 來源（「平臺原始數據」/「已採納勘誤（N 條）」）。 */
  source: { type: String, default: '' },
  /* 待審覈（「N 條」）。 */
  pending: { type: String, default: '' }
})

const emit = defineEmits(['close', 'correction'])

/* ESC ＝ 取消（只关最上层；本框无提交中态 ⇒ 恒可关）。 */
useEscToClose({ onCancel: () => emit('close') })
</script>

<template>
  <div class="attr-detail-mask" role="dialog" aria-modal="true" aria-label="屬性詳情" data-attr-detail-dialog>
    <div class="attr-detail-box">
      <h3 class="attr-detail-box__title">屬性詳情</h3>
      <p class="attr-detail-box__label" data-attr-detail-label>{{ label }}</p>

      <dl class="attr-detail-box__cols">
        <div>
          <dt>當前展示值</dt>
          <dd data-attr-detail-value>{{ value || '未著錄' }}</dd>
          <dd v-if="original" class="attr-detail-box__origin" data-attr-detail-original>{{ original }}</dd>
        </div>
        <div>
          <dt>來源</dt>
          <dd data-attr-detail-source>{{ source }}</dd>
        </div>
        <div>
          <dt>待審覈</dt>
          <dd data-attr-detail-pending>{{ pending }}</dd>
        </div>
      </dl>

      <p class="attr-detail-box__hint">
        勘誤不會直接覆蓋原始數據；提交後進入待審覈，平臺彙總多條提交後擇可信者對外展示。
      </p>

      <div class="attr-detail-box__foot">
        <button class="btn btn--ghost" type="button" data-action="attr-detail-close" @click="emit('close')">
          關閉
        </button>
        <button class="btn btn--primary" type="button" data-action="attr-correction-detail" @click="emit('correction')">
          勘誤
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.attr-detail-mask {
  position: fixed;
  inset: 0;
  z-index: 42;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-overlay);
}

.attr-detail-box {
  width: 100%;
  max-width: 560px;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.attr-detail-box__title {
  margin-bottom: var(--s-2);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.attr-detail-box__label {
  margin-bottom: var(--s-3);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.attr-detail-box__cols {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--s-3);
  font-size: var(--t-sm);
}

.attr-detail-box__cols dt {
  margin-bottom: var(--s-1);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.attr-detail-box__cols dd {
  margin: 0;
  color: var(--c-text);
  overflow-wrap: anywhere;
}

.attr-detail-box__origin {
  margin-top: var(--s-1) !important;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.attr-detail-box__hint {
  margin-top: var(--s-4);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.attr-detail-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-4);
}
</style>
