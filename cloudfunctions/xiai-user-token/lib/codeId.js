/**
 * 玺爱 · 印章 / 印面**识别编码**（sid / fid）纯函数 —— **仓内唯一实现、双副本逐字节相同**
 * =============================================================================
 * 【双副本纪律】本文件在仓内**恰两份**：
 *   · `src/utils/codeId.js`（前端）
 *   · `cloudfunctions/xiai-user-token/lib/codeId.js`（云函数）
 * 两份必须**逐字节相同**（`scripts/verify-code-id.mjs` 机械 cmp 断言；同 `MARKABLE_FIELDS` 纪律）。
 * 改一处必须同改另一处，否则自检立即判红。
 *
 * 【双端可载纪律（本文件的硬约束）】本文件必须用**两端共同的语法子集**写成：
 *   · Node CJS：`require('./codeId.js')` ⇒ 直接拿到 API 对象（云函数 `lib/ops.js` 这样用）；
 *   · 浏览器 ESM：`import './codeId.js'`（副作用导入）⇒ API 挂在 `globalThis.__XIAI_CODE_ID__`
 *     （前端 `src/**` 这样用；Vite 源码目录不认 `module.exports`，也不能出现 `export`
 *      —— 出现 `export` 云函数 `require` 即语法错，两份就再也做不到逐字节相同）。
 * ⇒ 本文件**不得**出现 `export` / `import` 语句；`module` 只许出现在 `typeof module` 守卫内。
 *
 * 【编码口径（唯一真源 = docs/seal-face-code-plan-2026-10-27.md §2）】
 *   · 字母表 22 位逐字：`ABCDEFGHJKMNPQRSTVWXYZ`（**不含 I / L / O / U** ⇒ 与 0/1 天然不混淆）。
 *   · **sid**：`n` 的 **base-22 展开**（A 顺序、大端、定长 5 位、高位补 `A`）：
 *     `1 → AAAAB`、`22 → AAABA`；码空间容量 `22^5 = 5,153,632` 个码 ⇒ 号域
 *     `n ∈ [1, SID_MAX - 1] = [1, 5,153,631]`，`5,153,631 → ZZZZZ`。
 *   · **fid**：`n` 的十进制定长 8 位零填充：`1 → 00000001`；码空间容量 `10^8` 个码
 *     ⇒ 号域 `n ∈ [1, FID_MAX - 1] = [1, 99,999,999]`。
 *   · **号域为何是开区间（如实登记）**：口径件 §2 写的「`n ∈ [1, 5153632]` ⇒ `5153632 → ZZZZZ`」
 *     与同条的 `1 → AAAAB` **算术上不可兼得** —— `ZZZZZ = 22^5 − 1 = 5,153,631`，而
 *     `1 → AAAAB` 已钉死「编码 ＝ n 的 base-22 展开、无偏移」（同条 fid 的 `1 → 00000001`
 *     也是**无偏移**的十进制展开，两处互证）。判据面 §6.2 要求 `0 / 5,153,633 / 10^8`
 *     **结构化拒绝**，与开区间口径一致 ⇒ 本实现取**无偏移展开 ＋ 容量开区间**：
 *     `encode(5153632)` 与 `encode(100000000)` 一律结构化拒绝（不静默回绕）。
 *   · 双向均为纯函数、零表、O(1)；`decode(encode(n)) === n` 对号域内一切 n 成立。
 *
 * 【reason 字面值】只取既有三值 `INVALID_VALUE` / `INVALID_FIELD` / `NOT_FOUND`，**零新增**。
 */

/* ------------------------------- 常数（冻结面） ------------------------------- */

/** 22 字母表（无 I / L / O / U）——**唯一字母真源**，禁止在别处另抄一份字母表。 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ'
/** 字母表基数（＝ 22；机械断言面）。 */
const CODE_ALPHABET_SIZE = CODE_ALPHABET.length
/** sid 定长位数（5）。 */
const SID_LENGTH = 5
/** fid 定长位数（8）。 */
const FID_LENGTH = 8
/** sid 码空间容量（＝ 22⁵ ＝ 5,153,632 个码）；**可编码号域 ＝ [1, SID_MAX − 1]**。 */
const SID_MAX = 5153632
/** sid 最大可编码号（5,153,631 ⇒ `ZZZZZ`）。 */
const SID_LAST = SID_MAX - 1
/** fid 码空间容量（＝ 10⁸ 个码）；**可编码号域 ＝ [1, FID_MAX − 1]**。 */
const FID_MAX = 100000000
/** fid 最大可编码号（99,999,999 ⇒ `99999999`）。 */
const FID_LAST = FID_MAX - 1
/** sid 形态门（实测展开恰为上述 22 字母；**不是** `[A-HJ-NP-TV-Z]`——那会放进 L）。 */
const SID_PATTERN = /^[A-HJ-KM-NP-TV-Z]{5}$/
/** fid 形态门（8 位十进制）。 */
const FID_PATTERN = /^\d{8}$/
/** 结构化拒绝字面值（既有三值；**零新增**）。 */
const REASON_INVALID_VALUE = 'INVALID_VALUE'
const REASON_INVALID_FIELD = 'INVALID_FIELD'
const REASON_NOT_FOUND = 'NOT_FOUND'

/* --------------------------------- 内部工具 --------------------------------- */

/** 归一入号：整数数字或纯数字串（去空白）⇒ 整数；其余（含小数 / 空 / 非数字）⇒ `null`。 */
function toInteger(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) return null
    const parsed = Number(trimmed)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function denial(message) {
  return { ok: false, reason: REASON_INVALID_VALUE, message }
}

/* --------------------------------- 编码（no → 码） --------------------------------- */

/**
 * 印章识别编码：`seal_no` → sid（定长 5 位 base-22，大端、高位补 `A`）。
 * @param {number|string} no 自增号（整数或纯数字串）
 * @returns {{ok:true, code:string}|{ok:false, reason:'INVALID_VALUE', message:string}}
 */
function encodeSealCode(no) {
  const value = toInteger(no)
  if (value === null || value < 1 || value > SID_LAST) {
    return denial(
      `識別編碼號域越界（sid 可編碼號域為 1…${SID_LAST} 的整數，容量 ${SID_MAX} 碼）；已結構化拒絕、未寫入任何內容。`
    )
  }
  let rest = value
  let out = ''
  for (let index = 0; index < sidWidth(); index += 1) {
    out = CODE_ALPHABET.charAt(rest % CODE_ALPHABET_SIZE) + out
    rest = Math.floor(rest / CODE_ALPHABET_SIZE)
  }
  return { ok: true, code: out }
}

/**
 * 印面识别编码：`face_no` → fid（十进制定长 8 位零填充）。
 * @param {number|string} no 自增号（整数或纯数字串）
 * @returns {{ok:true, code:string}|{ok:false, reason:'INVALID_VALUE', message:string}}
 */
function encodeFaceCode(no) {
  const value = toInteger(no)
  if (value === null || value < 1 || value > FID_LAST) {
    return denial(
      `識別編碼號域越界（fid 可編碼號域為 1…${FID_LAST} 的整數，容量 ${FID_MAX} 碼）；已結構化拒絕、未寫入任何內容。`
    )
  }
  return { ok: true, code: String(value).padStart(FID_LENGTH, '0') }
}

function sidWidth() {
  return SID_LENGTH
}

/* --------------------------------- 解码（码 → no） --------------------------------- */

/**
 * 解码 sid：5 位字母 → `seal_no`。形态不符 / 号域越界 ⇒ 结构化拒绝。
 * 入码先 `trim` ＋转大写（上屏由 OTP 组件保证大写；此处只做归一，不做任何纠错映射）。
 * @param {string} code 5 位字母码
 * @returns {{ok:true, no:number}|{ok:false, reason:'INVALID_VALUE', message:string}}
 */
function decodeSealCode(code) {
  const raw = typeof code === 'string' ? code.trim().toUpperCase() : ''
  if (!SID_PATTERN.test(raw)) {
    return denial(
      '識別編碼形態不符（sid 需 5 位英文字母，字母表不含 I / L / O / U，且不含數字）；請重新輸入。'
    )
  }
  let value = 0
  for (let index = 0; index < sidWidth(); index += 1) {
    const digit = CODE_ALPHABET.indexOf(raw.charAt(index))
    if (digit < 0) {
      return denial('識別編碼含字母表以外的字符；請重新輸入。')
    }
    value = value * CODE_ALPHABET_SIZE + digit
  }
  if (value < 1 || value > SID_LAST) {
    return denial(`識別編碼號域越界（sid 可編碼號域為 1…${SID_LAST}）；請重新輸入。`)
  }
  return { ok: true, no: value }
}

/**
 * 解码 fid：8 位数字 → `face_no`。形态不符 / 号域越界 ⇒ 结构化拒绝。
 * @param {string} code 8 位数字码
 * @returns {{ok:true, no:number}|{ok:false, reason:'INVALID_VALUE', message:string}}
 */
function decodeFaceCode(code) {
  const raw = typeof code === 'string' ? code.trim() : ''
  if (!FID_PATTERN.test(raw)) {
    return denial('識別編碼形態不符（fid 需 8 位數字）；請重新輸入。')
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > FID_LAST) {
    return denial(`識別編碼號域越界（fid 可編碼號域為 1…${FID_LAST}）；請重新輸入。`)
  }
  return { ok: true, no: value }
}

/* --------------------------------- 导出面 --------------------------------- */

/** API 冻结对象（两端共用的唯一入口）。 */
const CODE_ID = Object.freeze({
  CODE_ALPHABET,
  CODE_ALPHABET_SIZE,
  SID_LENGTH,
  FID_LENGTH,
  SID_MAX,
  SID_LAST,
  FID_MAX,
  FID_LAST,
  SID_PATTERN,
  FID_PATTERN,
  encodeSealCode,
  decodeSealCode,
  encodeFaceCode,
  decodeFaceCode
})

/* 浏览器 ESM 侧（前端 `src/**`）：副作用导入后从这里取 API。 */
if (typeof globalThis !== 'undefined' && globalThis) {
  globalThis.__XIAI_CODE_ID__ = CODE_ID
}
/* Node CJS 侧（云函数 `lib/ops.js`）：`require('./codeId.js')` 直接拿到 API。 */
if (typeof module !== 'undefined' && module && typeof module.exports === 'object') {
  module.exports = CODE_ID
}
