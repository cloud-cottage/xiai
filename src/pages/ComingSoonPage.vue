<template>
  <div class="container" style="padding-top:64px;padding-bottom:64px;">
    <p class="eyebrow">即将开放</p>
    <h1 style="font-size:32px;letter-spacing:2px;margin-bottom:12px;">{{ title }}</h1>

    <NoticeBar variant="status">
      <b>{{ title }} 即将开放</b> —— 该功能正在建设中，上线后可直接在本页使用。
    </NoticeBar>

    <div class="card">
      <h3>开放后可用的能力</h3>
      <ul style="margin-top:8px;">
        <li
          v-for="item in highlights"
          :key="item"
          style="font-size:14px;color:var(--ink-2);padding:6px 0;"
        >{{ item }}</li>
      </ul>
    </div>

    <div class="card" style="margin-top:18px;">
      <h3>现在可以做什么</h3>
      <ul style="margin-top:8px;">
        <li style="font-size:14px;color:var(--ink-2);padding:6px 0;">
          先使用已开放的功能：了解产品与计费规则，或进入控制台管理密钥与用量。
        </li>
        <li style="font-size:14px;color:var(--ink-2);padding:6px 0;">
          希望提前评估的机构，可先申请演示环境，我们会在人工受理后与你联系。
        </li>
      </ul>
    </div>

    <div class="modal-acts" style="margin-top:22px;">
      <router-link class="btn sm" to="/">回首页</router-link>
      <router-link class="btn ghost sm" to="/pricing">查看计费规则</router-link>
      <EntryLink class="btn ghost sm" to="/console/overview">去控制台</EntryLink>
      <button class="btn ghost sm" type="button" @click="notify">申请演示环境</button>
    </div>
  </div>
</template>

<script setup>
/**
 * 「即将开放」占位页（§1.2：M2/M3 页面的导航骨架与路由占位先于内容存在）。
 *
 * 对客口径（§1.6 / AC-88）：本页**只描述用户能得到什么**——
 * 不出现路由 / 入口 / 里程碑编号等内部规划口径，不回显任何配置位或实现文件名，
 * 也不渲染任何「实现者口吻」的字段（如内部规划备注、占位说明）。
 * 页面文案来自路由 meta 的 `highlights`（对客能力描述），缺失时用通用兜底句。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import EntryLink from '@/components/EntryLink.vue'
import NoticeBar from '@/components/NoticeBar.vue'
import { toastNotConnected } from '@/composables/useToast.js'

const route = useRoute()
const title = computed(() => route.meta?.title || '即将开放')
const highlights = computed(() => {
  const list = route.meta?.highlights
  return Array.isArray(list) && list.length ? list : ['该功能正在建设中，上线后可在本页直接使用。']
})

function notify() {
  toastNotConnected('演示环境：该功能未接入')
}
</script>
