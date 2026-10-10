<script setup>
/**
 * 印家匯徵（`/persons`）—— Slice M1 新增页面。
 * ----------------------------------------------------------------------------
 * **名录区本期＝留空占位**（人类 2026-10-10 亲定「暂时留空，后续再做」；与【印風匯覽】同口径）：
 *   · **当前不渲染圆形节点图、不渲染节点弹层**；
 *   · 保留一个**语义清晰的容器**（`[data-person-roster]`）＋ **可读空态文案（繁體，不白屏）**；
 *   · 排布与「节点点击去向」的落点＝**本容器这**一处（下一轮只改这里即可；不在此预置任何
 *     未使用的常量，遵 AC-98）。
 * ⇒ 下一轮做名录时，把 `[data-person-roster]` 的内容替换为节点图 / 子组件即可。
 *
 * 徵集入口：**要求登录**。未登錄 ⇒ **入口照常渲染**，点击**引导登录**（带 `redirect` 回本页），
 * **不得** CSS 隐藏 / `disabled` 冒充；已登錄 ⇒ **走既有提案流**（本页**不重建第二个提案表单**，
 * 改为指引到既有提案入口；取舍已登记在交付报告）。
 *
 * 展示口径（下一轮做名录时适用；沿批 2）：**只展示正字段（繁体）**；`*_chs` 副字段不上屏。
 */
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { isLoggedIn } from '../data/session.js'
import PlaceholderPanel from '../components/PlaceholderPanel.vue'

const router = useRouter()
const route = useRoute()

/* ------------------------------ 徵集入口（要求登录；未登錄 ⇒ 引导登录） ------------------------------ */
const collectGuide = ref('')

function onCollect() {
  collectGuide.value = ''
  if (!isLoggedIn.value) {
    /* 未登錄 ⇒ 入口照常渲染，点击走**登录引导**（带 `redirect` 回本页），不静默失败。 */
    router.push({ name: 'login', query: { redirect: route.fullPath } })
    return
  }
  /* 已登錄 ⇒ **走既有提案流**：本页**不重建第二个提案表单**，改为**指引到既有提案入口**
     （任一印章詳情頁「可標記屬性」区的「提交印人提案」）。此取舍已登记在交付报告。 */
  collectGuide.value = '請進入任一印章詳情頁，於「可標記屬性」區點「提交印人提案」，即可提交新的印家資料。'
}
</script>

<template>
  <section>
    <div class="page-head">
      <h1>印家匯徵</h1>
      <p>收錄歷代印人；名錄內容將於稍後補充。</p>
    </div>

    <!--
      名录区：**本期留空占位**（人类 2026-10-10 亲定「暂时留空，后续再做」）。
      下一轮的**唯一落点** ＝ 本容器 `[data-person-roster]` 的内容：
        排布（默认拟「网格平铺」的圆形人物节点）与「节点点击去向」（默认拟「就地弹层」）
        均在此一处替换 / 接入子组件即可。**当前不渲染节点图 / 弹层**，只给可读空态（不白屏）。
    -->
    <section class="panel">
      <div class="panel__head">
        <h2>印家名錄</h2>
      </div>
      <div class="panel__body" data-person-roster>
        <PlaceholderPanel
          glyph="家"
          title="名錄暫留空"
          desc="印家名錄暫時留空，稍後補充；可先點下方「徵集印家」提交印人提案。"
        />
      </div>
    </section>

    <!-- 徵集入口：要求登录（未登錄仍渲染、点击引导登录）。 -->
    <section class="panel">
      <div class="panel__body persons__collect">
        <button
          class="btn btn--primary"
          type="button"
          data-collect-action="person-collect"
          @click="onCollect"
        >
          徵集印家
        </button>
        <p v-if="collectGuide" class="persons__guide" data-person-collect-guide>{{ collectGuide }}</p>
      </div>
    </section>
  </section>
</template>

<style scoped>
.persons__collect {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--s-2);
}

.persons__guide {
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}
</style>
