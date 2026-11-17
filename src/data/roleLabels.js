/**
 * 角色对外文案 —— **全仓唯一真源**（展示层只读本文件，不得别处硬编码）。
 *
 * 口径（Kevin 裁定，2026-11-18）：
 *   · `admin`     ⇒ 掌書記使
 *   · `sub-admin` ⇒ 掌書記
 *
 * 铁律：
 *   1. **只改展示文案**：内部角色值、存储、令牌声明、权限判定（`role === 'admin'` /
 *      `isAdmin()` / 服务端白名单）**一字不动** —— 本文件只做「角色值 → 上屏字串」的
 *      单向映射，不参与任何判定。
 *   2. 一切展示处（模板文本 / 按钮 / 提示语 / 弹窗 / toast / 占位符 / 无障碍名）一律经
 *      `ROLE_LABEL`（或其派生常量）取值；两串**只在本文件出现一次**。
 *   3. 上屏为繁体，且**不加**书名号 / 方括号（裁定件里的【】只用于强调）。
 *   4. 未知角色**回落原文**（不抛错、不改写）：展示层永远不会因缺键而空白或报错。
 */

/** 角色值 → 上屏文案（繁体；**全仓唯一定义点**）。 */
export const ROLE_LABEL = Object.freeze({
  admin: '掌書記使',
  'sub-admin': '掌書記'
})

/**
 * 取角色上屏文案。
 *
 * @param {string|null|undefined} role 内部角色值（`admin` / `sub-admin` / …）
 * @returns {string} 上屏文案；未知角色回落原文，`null` / `undefined` 回落空串
 */
export function roleLabel(role) {
  const key = role == null ? '' : String(role)
  return ROLE_LABEL[key] || key
}

/** 管理员（`admin`）上屏文案 —— 模板 / 字面量里直接插值用（派生自 `ROLE_LABEL`）。 */
export const ADMIN_LABEL = ROLE_LABEL.admin

/** 子管理员（`sub-admin`）上屏文案 —— 同上（派生自 `ROLE_LABEL`）。 */
export const SUB_ADMIN_LABEL = ROLE_LABEL['sub-admin']
