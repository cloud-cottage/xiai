<script setup>
/**
 * 身份标记（唯一实现）—— 顶部账号菜单「徽号那一行」里**昵称之后、手机号 `·` 之前**的
 * 小印形标签（2–4 字宽，形如 `庫守〔掌書記使〕· 166****1656`）。
 *
 * 硬约束（纯展示，零判定）：
 *   · 取字走 `roleLabels.js` 的**唯一真点**（角色全称派生自 `ROLE_LABEL`，本文件零字面复制）；
 *     未知角色 / 空值 ⇒ 空串 ⇒ `v-if` 不渲染（普通用户**零渲染**，不占位、不留空框）；
 *   · `title` / `aria-label` 复用既有单点 `accountLabel(role)`，**不另写第二套身份文案**；
 *   · 描边 / 字色一律取既有令牌 ⇒ 三套主题自适应，不新造颜色变量；
 *   · **不是按钮**：无 hover 变色、无 `cursor: pointer`、**不用虚线边框**（虚线是
 *     `.btn--admin` 管理员按钮的专属语义），故不挂任何交互态样式。
 */
import { computed } from 'vue'
import { accountLabel, roleMarkText } from '../data/roleLabels.js'

const props = defineProps({
  /** 内部角色值（`admin` / `sub-admin` / …）—— **只用于取字**，不参与任何判定。 */
  role: { type: String, default: '' }
})

/** 上屏文字（空串 ⇒ 不渲染）。 */
const text = computed(() => roleMarkText(props.role))
/** 提示 / 无障碍名：与账号身份行同一口径（掌書記使賬號 / 掌書記賬號 / 普通用戶賬號）。 */
const identity = computed(() => accountLabel(props.role))
</script>

<template>
  <span v-if="text !== ''" class="role-mark" data-role-mark :title="identity" :aria-label="identity">{{ text }}</span>
</template>

<style scoped>
/* 小印形标签：两到四字宽、实线既有令牌描边；只做展示，不给任何可点暗示。 */
.role-mark {
  display: inline-block;
  margin-left: 4px;
  padding: 1px 4px;
  border: 1px solid var(--c-line);
  border-radius: 2px;
  color: var(--slot-panel-body-text);
  font-size: var(--t-xs);
  line-height: 1.4;
  vertical-align: middle;
  white-space: nowrap;
}
</style>
