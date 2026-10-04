/**
 * 玺爱 · 管理员专区服务
 *
 * 权限口径：普通用户不可见编辑入口，且数据层也须拒绝越权写。
 * 因此本服务在调用仓库前先做一次角色判定，仓库内再做一次硬拦截（双层防守）。
 *
 * 固定属性**按印面**编辑（canonical）：管理员先在印章下选定印面，再改该印面的
 * 印面图片 / 边款图片 ID。
 * 材质**不在印面级**（R-32 起为**印章级**固定属性，走印章行 `material`；
 * 印面级白名单 `['face_image_id','edge_image_ids']` 已不含 `material`，塞进去 ⇒ `INVALID_FIELD`）。
 *
 * **拒绝形态（2026-09-20 收口｜Zang 裁定；依据规范 v1.6 §3.12.10(c) ＋ §10.8 v1.6 修正注）**：
 * 本服务的一切越权判定 —— **写入口（本文件两个写方法）＋ 管理员专属读入口（本文件两个读方法）** ——
 * 一律返回**结构化拒绝** `{ok:false, reason:'FORBIDDEN', message}`：
 *   - **不再抛 `PermissionError`**（§3.12.10(e)⑥：拒绝路径抛未捕获异常即判负）；
 *   - **不得以空集 / `null` / 静默降级冒充拒绝**（§10.8 v1.6 修正注明文封堵）。
 * `FORBIDDEN` 逐字为越权**唯一**字面值（服务层与数据层**同字面值**）；`message` 文案逐字保留。
 */

import {
  listSealRows,
  writeFaceFixedAttributes,
  writeFixedAttributes
} from '../data/db.js'
import { writeInviteRewardSetting } from '../data/drive.js'
import { currentUser } from '../data/session.js'
import { FIXED_ATTR_FIELDS } from '../data/seed.js'
import { listFacesOf } from './seals.js'
/* **V3（管理员写面收敛）**：本文件**不再经 `xiai-admin-token`**（客户端对其零引用）——
   `setInviteReward` 与采纳 / 驳回共用**登录令牌写面门** `userWriteGate`：云端形态下把
   「这次写是否合法」交给云函数 `xiai-user-token` 判定（服务端验签 ＋ 手机号白名单 ＋ 值域门）；
   **本地 `role` 不再是授权依据**（见 §四 / R-WF1）；**无令牌且有会话时先静默补签**（自愈）。
   dev / 离线形态（无云写入面）下 `userWriteGate` 放行到本文件自己的本地角色门，且该形态
   **明确标注为非正式写入路径**（`src/data/writeFaceMode.js`）。 */
import { userWriteGate } from './userWrite.js'

export { FIXED_ATTR_FIELDS }
/* `PermissionError` 类**保留转口**（规范明文：保留导出、不删；既有导入方与自检仍可 import）——
   本服务的越权判定已**不再抛它**。 */
export { PermissionError } from '../data/db.js'

/**
 * 越权**结构化拒绝**（§3.12.10(c)：`FORBIDDEN` 为服务层与数据层**同字面值**）。
 * 本文件所有越权判定统一走这里 ⇒ 拒绝形态唯一、可机械判定。
 * @returns {{ok:false, reason:'FORBIDDEN', message:string}}
 */
function forbidden(message) {
  return { ok: false, reason: 'FORBIDDEN', message }
}

export function isAdminSession() {
  const user = currentUser()
  return user !== null && user.role === 'admin'
}

/**
 * 管理员专属读入口：全部印章行。
 * 非管理员 ⇒ **结构化拒绝**（原「返回空集」形态已按 §10.8 v1.6 收口：空集 / `null` 不得冒充拒绝）。
 * @returns {{ok:true, rows:Array<object>}|{ok:false, reason:'FORBIDDEN', message:string}}
 */
export function listSealsForAdmin() {
  if (!isAdminSession()) return forbidden('僅管理員可以查看全部印章')
  return { ok: true, rows: listSealRows() }
}

export const FIXED_ATTR_LABELS = {
  face_image_id: '印面圖片',
  edge_image_ids: '邊款圖片 ID',
}

/**
 * **印章级**固定属性的中文标签表（键与 `SEAL_FIXED_ATTR_FIELDS` 一一对应，
 * R-32 起【材质】归此层，与【形制】同处）。
 */
export const SEAL_FIXED_ATTR_LABELS = {
  shape: '形制',
  material: '材質'
}

/**
 * 管理员可编辑的印面（含三类属性的解析结果）。
 * 非管理员 ⇒ **结构化拒绝**（同上；返回形状与数据层读入口 `listPendingCorrectionRowsForAdmin` 一致）。
 * @returns {{ok:true, rows:Array<object>}|{ok:false, reason:'FORBIDDEN', message:string}}
 */
export function listFacesForAdmin(sealId) {
  if (!isAdminSession()) return forbidden('僅管理員可以查看印面的固定屬性')
  return { ok: true, rows: listFacesOf(sealId) }
}

/** 写入**印面**固定属性（canonical 入口，按印面归属）。 */
export function updateFaceFixedAttributes(faceId, patch) {
  if (!isAdminSession()) return forbidden('僅管理員可以修改印面的固定屬性')
  return writeFaceFixedAttributes(currentUser(), faceId, patch)
}

/**
 * 兼容入口：旧调用方按印章编号一次提交三项固定属性。
 * 数据层会按印面归属拆分落库（见 data/db.js 同名函数）。
 */
export function updateFixedAttributes(stampId, patch) {
  if (!isAdminSession()) return forbidden('僅管理員可以修改印面的固定屬性')
  return writeFixedAttributes(currentUser(), stampId, patch)
}

/* ============================================================================
   **編輯邀請獎勵（v1.21 新增｜R-113｜规范 §3.21.8 ＋ §4.1.12 表下注 ＋ §5.5 ＋ §6.3）**
   ----------------------------------------------------------------------------
   两条独立要求（缺一即判负，沿用 §3.12.1 口径）：① 非管理员**入口不渲染**（DOM 零命中，
   含 CSS 隐藏 / `disabled`）—— 该条属 UI 面（K-2）；② **数据层独立拒绝越权写**（本入口）。
   本入口的判定顺序（**两条判定都必须在任何写入之前，拒绝 ⇒ 零写入**）：
     ① **管理员门**：写者不是管理员 ⇒ `{ok:false, reason:'FORBIDDEN'}`（服务层与数据层同字面值）；
     ② **值域门**：值不是非负整数 ⇒ `{ok:false, reason:'INVALID_VALUE'}`；
     ③ 过门后才真正写站点配置键（`xiai:v1:invite-reward`）。
   历史不改写：本入口**只写配置键这一个键** —— 既有 `invite` 行与既有积分流水一字不动
   （改值只影响之后的结算）。
   ============================================================================ */

/**
 * 写邀请奖励数值（管理员专属）。
 *
 * **写面（V3：登录令牌 ＋ 手机号白名单）**：本入口为 **`async`**，判定顺序：
 *   ① **服务端门（唯一授权判据）**：`userWriteGate('setInviteReward', { value })`
 *      ⇒ 云函数 `xiai-user-token` 验收**登录令牌**（HMAC 验签 → 有效期待 → `role==='user'`
 *      → 手机号 ∈ 管理员白名单（`XIAI_ADMIN_PHONE`）→ 值域 / 字段门）；
 *      **无令牌且有会话时先静默补签**（刷新后令牌即丢的自愈）；**零弹窗、不需要第二个码**；
 *      **不过门 ⇒ 原样透传服务端结构化拒绝 ＋ 零写入**（传输层失败 ⇒ `STORAGE_UNAVAILABLE`，**不伪装 `FORBIDDEN`**）；
 *   ② **dev / 离线形态的本地角色门**（**仅该形态生效**；生产写路径不得只依赖它）；
 *   ③ **值域门**：值不是非负整数 ⇒ `INVALID_VALUE`（本地兜底；云端形态服务端已先判过一次）；
 *   ④ 过门后才真正落盘站点配置键（`xiai:v1:invite-reward`）。
 *
 * 历史不改写：本入口**只写配置键这一个键** —— 既有 `invite` 行与既有积分流水一字不动
 * （改值只影响之后的结算）。**成功态返回值形状与改前逐字一致**（`{ok:true, key, value}`）。
 *
 * @param {{id?:string, role?:string, phone?:string}|null} actor 写者（缺省时取当前登录用户；**不作授权判据**）
 * @param {number} value 目标值（非负整数）
 * @returns {Promise<{ok:true, key:string, value:number}|{ok:false, reason:'FORBIDDEN'|'INVALID_VALUE'|string, message:string}>}
 */
export async function setInviteReward(actor, value) {
  const user = actor && actor.id ? actor : currentUser()
  /* ① 服务端门（**云端形态下这是唯一授权判据**；dev / 离线形态返回放行标记）；经登录令牌
     写面门 ⇒ 无令牌且有会话时先静默补签（修「刷新后写必失败」）。 */
  const gate = await userWriteGate('setInviteReward', { value })
  if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }
  /* ② dev / 离线形态：沿用改前的本地角色门（**不得**当作正式写入路径）。 */
  if (gate.mode === 'local-dev' && (!user || user.role !== 'admin')) {
    return forbidden('僅管理員可以修改邀請獎勵數值；本次零寫入。')
  }
  /* ③ 值域门（本地兜底，判定在**任何写入之前**）。 */
  if (!Number.isInteger(value) || value < 0) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `邀請獎勵必須是「非負整數」（非整數 / 負數 / 非數字一律拒收，實測 ${JSON.stringify(value)}）；本次零寫入。`
    }
  }
  /* ④ 过门后才落盘（落盘点仍是本地配置键；迁移到云端权威存储属 Phase 2）。 */
  return writeInviteRewardSetting(value)
}

/* ============================================================================
   **V3 撤除「校驗碼彈窗」编排**（2026-10-04）
   ----------------------------------------------------------------------------
   上一轮为「弹校驗碼」加的 `isCloudWriteFace()` / `needsAdminWriteCode()` /
   `runWithAdminWriteSession()` **整体删除**（零死代码、零死钩子）：
   管理员写面已收敛到「一枚登录令牌 ＋ 手机号白名单」⇒ 采纳 / 驳回、改邀请奖励
   **不再需要第二个码、不再有弹窗**；令牌的「取 / 补签」收口在**单点** `userWrite.js`
   （`ensureUserTokenForWrite` / `userWriteGate`），页面与服务只调服务层，不再各自判形态。
   ============================================================================ */

