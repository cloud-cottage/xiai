<script setup>
/**
 * 印風匯覽（`/styles`）—— Slice M1 新增页面。
 * ----------------------------------------------------------------------------
 * 人类明确要求：**内容留空，以后再定** ⇒ 本页只承担「**可达 ＋ 标题 ＋ 内容区占位**」三件事：
 *   · **不为填空造无意义内容**；
 *   · **不定义任何 UI 常量**（AC-98：不得存在「已定义未使用」的 UI 常量）；
 *   · **零数据接线**（不读任何集合 / 服务面，故无空态逻辑、无加载态）。
 * 后续内容落点：把下方 `PlaceholderPanel` 替换为真实内容即可，本页其余部分无需改动。
 */
import PlaceholderPanel from '../components/PlaceholderPanel.vue'
</script>

<template>
  <section>
    <div class="page-head">
      <h1>印風匯覽</h1>
    </div>

    <!-- 内容区：留空 / 占位（人类要求「以后再定」）。 -->
    <PlaceholderPanel glyph="風" title="內容待定" desc="此頁內容留空，稍後補充。" />
  </section>
</template>
