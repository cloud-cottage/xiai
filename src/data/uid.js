/**
 * 玺爱 · **身份标识（uid）派生 · 单点真源**（可公开、不可反推手机号）
 * ============================================================================
 * 口径（人类 Kevin 逐条亲定）：
 *   ① **uid 不得可反推手机号**：旧形态 `u-<11 位手机号>` 把手机号原样写进每一行
 *      ⇒ 本身就是泄露源。现行形态 ＝ **`u-` ＋ `sha256(手机号).hex` 的前 16 位**
 *      （单向、可复算、**明文登记为「非保密」** —— 它的作用只是「不把手机号写进
 *      数据行 / 不直接露出」，**不是密码学保密**）。
 *   ② **单点**：本文件是**客户端**的唯一派生点；服务端（`cloudfunctions/xiai-*-token/lib/config.js`
 *      的 `uidOf`）用 node `crypto` 实现**同一算法**（同一输入 ⇒ 同一输出，由自检脚本
 *      机械断言两侧逐字同值）。除这三处外**不得**再有第四处派生。
 *   ③ **手机号只活在服务端环境变量 / 本人本地会话**：业务行（勘误 / 采信 / 公开投影 /
 *      计数）一律不落手机号；上屏不显示他人手机号。
 *
 * sha256 复用既有实现 `src/data/assetmeta.js::sha256Hex`（**自带、同步、跨环境**，
 * 不依赖 `crypto.subtle`（非安全上下文不可用）⇒ 本模块可在浏览器与 node 自检里同样跑）。
 */

import { sha256Hex } from './assetmeta.js'

/** uid 前缀（与云函数两副本 `UID_PREFIX` 逐字同值）。 */
export const UID_PREFIX = 'u-'

/** 摘要十六进制取前多少位（与云函数两副本 `UID_HEX_LENGTH` 逐字同值）。 */
export const UID_HEX_LENGTH = 16

/** uid 形态（`u-` ＋ 16 位小写十六进制）。 */
export const UID_PATTERN = /^u-[0-9a-f]{16}$/

/** 手机号形态（与云函数两副本 `PHONE_PATTERN` **逐字同正则**）。 */
export const PHONE_PATTERN = /^1[3-9]\d{9}$/

/** 上屏短碼取多少位十六进制（仅用于展示，不参与任何判定）。 */
export const UID_SHORT_LENGTH = 6

/** 手机号归一（只留数字）：比对前先归一，**不猜格式、不做模糊匹配**。 */
export function normalizePhone(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[^0-9]/g, '')
}

/** 手机号形态判定（归一后逐个匹配；**不猜格式**）。 */
export function isPhoneLike(value) {
  return PHONE_PATTERN.test(normalizePhone(value))
}

/**
 * **客户端唯一的 uid 派生**：`u-` ＋ `sha256(手机号).hex` 的前 16 位。
 * 非手机号形态 ⇒ 空串（调用方据此判「无法派生」）。
 * @param {string} value 手机号
 * @returns {string} uid（`u-<16 hex>`）或空串
 */
export function uidOf(value) {
  const digits = normalizePhone(value)
  if (!PHONE_PATTERN.test(digits)) return ''
  return `${UID_PREFIX}${sha256Hex(digits).slice(0, UID_HEX_LENGTH)}`
}

/**
 * uid 的**上屏短碼**（默认前 6 位十六进制；仅用于展示，不参与任何判定）。
 * 非 uid 形态 ⇒ 空串（调用方据此回落，**不得**回退成手机号）。
 * @param {string} uid
 * @param {number} [length=UID_SHORT_LENGTH]
 * @returns {string}
 */
export function uidShortOf(uid, length = UID_SHORT_LENGTH) {
  const text = String(uid === undefined || uid === null ? '' : uid)
  if (!UID_PATTERN.test(text)) return ''
  return text.slice(UID_PREFIX.length, UID_PREFIX.length + length)
}
