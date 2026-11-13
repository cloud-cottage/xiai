/**
 * 玺爱 · 启动引导
 * 把初始化收口到一处，避免 main.js 直接触碰 data 层。
 */

import { bootstrapSession as restoreSession } from './auth.js'
import { restoreTheme, setTheme } from '../data/session.js'
/* **§8.6 本地引用就地重算（窄單補未落項）**：启动引导阶段把本机镜像里的旧形态印章引用
   （`seallist-items.seal_id` ＝ `"N"` / `XA0000000N`）就地换算成新 `sid` —— 纯函数、幂等、
   不删行、不清库、不换命名空间（`resolveShare` / 夹内清单的投影由此一并收口）。 */
import { reconcileLocalSealRefs } from './drive.js'
/* **CloudBase 读取面（v1）**：启动引导（`main.js` 已在调用本文件的两个入口，
   且 `main.js` **不在本单接线面内**）⇒ 把「拉起云端快照」挂到既有的启动引导上。
   `hydrate` 是**一次性 fire-and-forget**：不阻塞挂载，快照到位后由数据层的响应式读数
   驱动页面重算（页面与组件零改动）。 */
import { ensureCloudBaseHydration } from '../data/cloudbase.js'
/* **人物属性读面切 CARD（本单）**：索引（`listPersonCards`，570 行 ≈ 33 KB gz）在启动引导里
   **预热一次**（fire-and-forget；进程内单例 ⇒ 之后无论多少人 / 多少组件读都零新增请求）。
   失败不阻断启动：读面自行退回本地属性字段（`personCards.personAttributesOf` 的 fallback）。 */
import { loadPersonIndex } from './personCards.js'

export function bootstrapSession() {
  ensureCloudBaseHydration()
  /* CARD 人物索引预热（不 await、不抛错；快照到位后由 `shallowRef` 驱动页面重算）。 */
  loadPersonIndex().catch(() => {})
  /* 旧引用换算失败**不阻断**启动引导（只读面仍照常工作；返回值供诊断读数）。 */
  reconcileLocalSealRefs()
  return restoreSession()
}

export function bootstrapTheme() {
  return restoreTheme()
}

export function switchTheme(theme) {
  setTheme(theme)
}
