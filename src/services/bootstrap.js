/**
 * 玺爱 · 启动引导
 * 把初始化收口到一处，避免 main.js 直接触碰 data 层。
 */

import { bootstrapSession as restoreSession } from './auth.js'
import { restoreTheme, setTheme } from '../data/session.js'
/* **CloudBase 读取面（v1）**：启动引导（`main.js` 已在调用本文件的两个入口，
   且 `main.js` **不在本单接线面内**）⇒ 把「拉起云端快照」挂到既有的启动引导上。
   `hydrate` 是**一次性 fire-and-forget**：不阻塞挂载，快照到位后由数据层的响应式读数
   驱动页面重算（页面与组件零改动）。 */
import { ensureCloudBaseHydration } from '../data/cloudbase.js'

export function bootstrapSession() {
  ensureCloudBaseHydration()
  return restoreSession()
}

export function bootstrapTheme() {
  return restoreTheme()
}

export function switchTheme(theme) {
  setTheme(theme)
}
