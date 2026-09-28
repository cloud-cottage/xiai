
<script setup>
/**
 * 广场筛选条 —— **三维度**（R-30〜R-32 / R-34）：
 *   ① 朝代（`dynasty`）② 印面内容（`seal_type`，显示名【印面内容】）③ 印面风格（`face_style`）。
 *
 * 值集口径（与 SquareView 一致；本组件只渲染 + 抛事件，**不自造任何选项值**）：
 *   真源常量（规范顺序，在前）＋ **库内旧值**（去重、追加于后）—— 旧值必须仍可筛到。
 * 维度用 `data-filter-dimension` / 选项用 `data-filter-option` 标注，便于机械取证。
 */
defineProps({
  dynasties: { type: Array, default: () => [] },
  contents: { type: Array, default: () => [] },
  styles: { type: Array, default: () => [] },
  dynasty: { type: String, default: '' },
  content: { type: String, default: '' },
  style: { type: String, default: '' },
  total: { type: Number, default: 0 },
  /* 真源常量未就绪时的**可读降级提示**（空串 ⇒ 不渲染）。 */
  degraded: { type: String, default: '' }
})

const emit = defineEmits(['update:dynasty', 'update:content', 'update:style', 'reset'])
</script>

<template>
  <section class="filter-bar">
    <div class="filter-bar__row" data-filter-dimension="dynasty">
      <span class="filter-bar__label">朝代</span>
      <div class="filter-bar__chips">
        <button
          type="button"
          class="filter-chip"
          data-filter-option=""
          :class="{ 'is-active': dynasty === '' }"
          @click="emit('update:dynasty', '')"
        >
          全部
        </button>
        <button
          v-for="d in dynasties"
          :key="d"
          type="button"
          class="filter-chip"
          :data-filter-option="d"
          :class="{ 'is-active': dynasty === d }"
          @click="emit('update:dynasty', dynasty === d ? '' : d)"
        >
          {{ d }}
        </button>
      </div>
    </div>

    <div class="filter-bar__row" data-filter-dimension="content">
      <span class="filter-bar__label">印面內容</span>
      <div class="filter-bar__chips">
        <button
          type="button"
          class="filter-chip"
          data-filter-option=""
          :class="{ 'is-active': content === '' }"
          @click="emit('update:content', '')"
        >
          全部
        </button>
        <button
          v-for="c in contents"
          :key="c"
          type="button"
          class="filter-chip"
          :data-filter-option="c"
          :class="{ 'is-active': content === c }"
          @click="emit('update:content', content === c ? '' : c)"
        >
          {{ c }}
        </button>
      </div>
    </div>

    <div class="filter-bar__row" data-filter-dimension="style">
      <span class="filter-bar__label">印面風格</span>
      <div class="filter-bar__chips">
        <button
          type="button"
          class="filter-chip"
          data-filter-option=""
          :class="{ 'is-active': style === '' }"
          @click="emit('update:style', '')"
        >
          全部
        </button>
        <button
          v-for="s in styles"
          :key="s"
          type="button"
          class="filter-chip"
          :data-filter-option="s"
          :class="{ 'is-active': style === s }"
          @click="emit('update:style', style === s ? '' : s)"
        >
          {{ s }}
        </button>
      </div>
    </div>

    <!-- 真源常量未就绪 ⇒ **可读降级提示**（不静默、不拿库内派生值冒充值集）。 -->
    <p v-if="degraded" class="filter-bar__degraded" data-filter-degraded>{{ degraded }}</p>

    <div class="filter-bar__foot">
      <span>共 {{ total }} 枚</span>
      <button type="button" class="filter-bar__reset" @click="emit('reset')">重置篩選</button>
    </div>
  </section>
</template>

<style scoped>
.filter-bar {
  padding: var(--s-4) var(--s-5);
  background: var(--slot-filter-bg);
  border: 1px solid var(--slot-filter-line);
  border-radius: var(--r-lg);
}

.filter-bar__row {
  display: flex;
  align-items: flex-start;
  gap: var(--s-4);
  padding: var(--s-2) 0;
}

.filter-bar__label {
  flex: 0 0 56px;
  padding-top: var(--s-1);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.filter-bar__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
}

.filter-chip {
  padding: var(--s-1) var(--s-4);
  min-height: 30px;
  background: var(--slot-chip-bg);
  border: 1px solid var(--slot-chip-line);
  border-radius: var(--r-round);
  color: var(--slot-chip-text);
  cursor: pointer;
  font-size: var(--t-sm);
}

.filter-chip:hover {
  border-color: var(--c-gold);
}

.filter-chip.is-active {
  background: var(--slot-chip-active-bg);
  border-color: var(--slot-chip-active-bg);
  color: var(--slot-chip-active-text);
  font-weight: 600;
}

.filter-bar__degraded {
  margin-top: var(--s-2);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.filter-bar__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--s-3);
  padding-top: var(--s-3);
  border-top: 1px solid var(--slot-filter-line);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.filter-bar__reset {
  background: none;
  border: 0;
  padding: 0;
  color: var(--slot-btn-ghost-text);
  cursor: pointer;
  font-size: var(--t-sm);
  text-decoration: underline;
}
</style>
