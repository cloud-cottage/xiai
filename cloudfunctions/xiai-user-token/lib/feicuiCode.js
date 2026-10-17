'use strict'
/**
 * 玺爱 · **斐萃（feicui）桌面端换身份 · 一次性授权码**（纯函数面）
 * ============================================================================
 * 落点为什么在这里：本模块**零 SDK / 零 IO / 零时钟依赖**（随机源与时戳一律由调用方递入或
 * 由 `crypto` 直供），因此既能被 `lib/ops.js`（服务端签发）引用，也能被离线自检直接执行。
 * 硬口径：
 *   ① **码面封闭**：`ALPHABET`（32 字）**剔除易混淆字符 `0` / `O` / `1` / `I`**，长度 6
 *      ⇒ 32^6 ≈ 1.07e9 空间；**大写**（比对前统一 `toUpperCase`，不猜小写变体）；
 *   ② **一次性**：行形 `{_id:<code>, uid, role, issued_at, expires_at, used_at, used_by}`，
 *      `used_at === null` ⇒ 未用；核销由**服务端条件更新**完成（见 `api/auth/feicui-exchange.js`）；
 *   ③ **TTL 默认 600 s（10 分钟）**；时戳一律 **ISO 8601（UTC, `Z`）** 字符串 —— 与仓内行
 *      （`issued_at` / `submitted_at` 等）同一形态，比较前由消费方 `Date.parse`；
 *   ④ **本文件不产生任何密钥 / 令牌**：码只是「一次性票据」，凭它换到的是 uid（身份），
 *      不是可复用的写权限。
 */

const crypto = require('crypto')

/** 码字符集：32 字，**按人类口径剔除 0 / O / 1 / I**（易混淆）。 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** 码长（6 位；与 `api/` 路由侧正则同一常量口径）。 */
const CODE_LENGTH = 6

/** 默认 TTL：10 分钟（600 s）。 */
const DEFAULT_TTL_SECONDS = 600

/** 码形态（**唯一正则定义点**；路由侧 import 本常量，不另抄一份）。 */
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`)

/** 撞码重试上限（只防并发小概率撞车；不做无限重试）。 */
const MAX_COLLISION_RETRIES = 5

/** 码形态判定（**先归一大小写再判**；空 / 非串 ⇒ false）。 */
function isCodeLike(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toUpperCase()
  return CODE_PATTERN.test(raw)
}

/** 归一码（形态不合 ⇒ 空串；调用方据此统一回 `CODE_INVALID`，不区分原因）。 */
function normalizeCode(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toUpperCase()
  return CODE_PATTERN.test(raw) ? raw : ''
}

/**
 * 生成一枚码（`crypto.randomInt` ⇒ 密码学随机、无模偏）。
 * @param {function(number,number):number} [randomInt] 随机源注入（离线自检用；缺省 `crypto.randomInt`）
 * @returns {string}
 */
function generateCode(randomInt) {
  const pick = typeof randomInt === 'function' ? randomInt : crypto.randomInt
  let out = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    out += CODE_ALPHABET[pick(0, CODE_ALPHABET.length - 1)]
  }
  return out
}

/** ISO 8601（UTC）字符串。 */
function isoOf(epochMs) {
  return new Date(epochMs).toISOString()
}

/**
 * 构造授权码行（**落库行形，逐键与契约一致**；不含手机号、不含令牌）。
 * @param {{code:string, uid:string, role:string, nowMs:number, ttlSeconds?:number}} input
 * @returns {{_id:string, uid:string, role:string, issued_at:string, expires_at:string, used_at:null, used_by:null}}
 */
function buildRow(input) {
  const code = normalizeCode(input && input.code)
  const uid = String((input && input.uid) || '').trim()
  const role = String((input && input.role) || '').trim()
  const nowMs = Number(input && input.nowMs)
  const ttlSeconds =
    Number.isFinite(input && input.ttlSeconds) && input.ttlSeconds > 0
      ? Math.floor(input.ttlSeconds)
      : DEFAULT_TTL_SECONDS
  if (!code || !uid || !Number.isFinite(nowMs)) return null
  return {
    _id: code,
    uid,
    role,
    issued_at: isoOf(nowMs),
    expires_at: isoOf(nowMs + ttlSeconds * 1000),
    used_at: null,
    used_by: null
  }
}

module.exports = {
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_PATTERN,
  DEFAULT_TTL_SECONDS,
  MAX_COLLISION_RETRIES,
  isCodeLike,
  normalizeCode,
  generateCode,
  buildRow
}
