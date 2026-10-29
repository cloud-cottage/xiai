'use strict'
/**
 * 玺爱 · **AI 上游配置**（唯一上游配置实现点）
 * ============================================================================
 * 职责（本单范围）：中转面要打的**上游 base_url / 模型 / 上游金鑰 / 超时**四件事只在此落地；
 * 读公共面（`getUpstreamPublic`）/ 写配置面（`setUpstream`）/ 服务端内部取明文
 * （`resolveUpstreamSecret`）三件事**只在此实现**，调用方不自写第二套。
 *
 * 集合（**服务端专属私有**；参照 `xiai_balances` 先例：**不进** `lib/ops.js` 的 `COLLECTIONS`
 * 读写面登记表、**更不进**前端任何云读面 ⇒ 客户端零读面；单点即审计点）：
 *   · `xiai_ai_upstream` ＝ 上游配置行；`_id` 固定 `upstream-default`（**恰一行**）；
 *     **键面恰 10 键** `{_id, base_url, model, key_cipher, key_iv, key_tag, key_mask,
 *       timeout_ms, updated_at, updated_by_uid}`。
 *
 * 硬口径（逐条）：
 *  ① **上游金鑰绝不落明文**：`aes-256-gcm`（12 字节 iv、16 字节 auth tag），主密钥取自环境
 *     变量 `XIAI_AI_UPSTREAM_SECRET`，以 `crypto.createHash('sha256').update(secret).digest()`
 *     派生 32 字节金鑰（**零第三方库**）；`key_cipher` / `key_iv` / `key_tag` **三件均 base64**。
 *  ② **缺主密钥 ⇒ `CONFIG_MISSING` ＋ 零写入**（**不得静默用空密钥、不得明文落库**）——
 *     `setUpstream` 在**任何写入之前**就判定 env；`resolveUpstreamSecret` 同判、fail-closed。
 *  ③ **公共面零密文**：`getUpstreamPublic` 只回 `{base_url, model, key_mask, timeout_ms,
 *     updated_at}` —— **绝不带 `key_cipher` / `key_iv` / `key_tag`，更不带明文**。
 *  ④ **`resolveUpstreamSecret` 的返回值永远不得进入任何 op 回包**（明文只在服务端内部 /
 *     中转面内存中流转）；本文件不打印、不日志任何密文或明文。
 *  ⑤ `key_mask` ＝ 前 3 字元 ＋ `****` ＋ 後 4 位（例：`sk-****xxxx`）；不足 7 字元 ⇒ `***`。
 *  ⑥ **写入形态**：`_id` 固定 `upstream-default`，整行 `doc(id).set(…)`（**恒为恰 10 键**，
 *     不留旧键残留）；`updated_by_uid` ＝ 服务端派生的管理员 uid（**不由载荷自称**）。
 *  ⑦ **值域门全部在写之前**：`base_url` 必须 https 协议（`https:` 加 `//`）开头且 host 非空
 *     （否则 `INVALID_VALUE`）；
 *     `timeout_ms` ∈ [1000,120000]、缺省 60000（越界 / 非整数 ⇒ `INVALID_VALUE`，零写入）；
 *     `key` 可省 ⇒ **沿用旧密文**（无旧密文时首次配置必须给，⇒ `MISSING_REQUIRED`）。
 *  ⑧ **拒绝形态恒为恰 3 键** `{ok:false, reason, message}`；`reason` 只用 `lib/config.js::REASONS`
 *     冻结表字面值（本文件不写字面量，只引用常量）。
 */

const crypto = require('crypto')
const { REASONS, deny, isDocNotExistError } = require('./config.js')

/* ---------------------------------------------------------------------------
  常量面（封闭）
  --------------------------------------------------------------------------- */

/** 集合名（**服务端专属私有**）。 */
const AI_UPSTREAM_COLLECTION = 'xiai_ai_upstream'

/** 配置行文档键（**恰一行**）。 */
const UPSTREAM_ID = 'upstream-default'

/** 主密钥环境变量名（**只登记名字，本文件不写值**）。 */
const UPSTREAM_SECRET_ENV = 'XIAI_AI_UPSTREAM_SECRET'

/** 上游配置行键面（恰 10 键）。 */
const UPSTREAM_ROW_KEYS = Object.freeze([
  '_id',
  'base_url',
  'model',
  'key_cipher',
  'key_iv',
  'key_tag',
  'key_mask',
  'timeout_ms',
  'updated_at',
  'updated_by_uid'
])

/** 公共面键面（恰 5 键；**零密文、零明文**）。 */
const UPSTREAM_PUBLIC_KEYS = Object.freeze(['base_url', 'model', 'key_mask', 'timeout_ms', 'updated_at'])

/** 超时：缺省值与值域。 */
const TIMEOUT_DEFAULT_MS = 60000
const TIMEOUT_MIN_MS = 1000
const TIMEOUT_MAX_MS = 120000

/** 算法面（封闭；不引第三方库）。 */
const CIPHER_ALGORITHM = 'aes-256-gcm'
const CIPHER_IV_BYTES = 12
const CIPHER_TAG_BYTES = 16
const CIPHER_KEY_BYTES = 32
const CIPHER_ENCODING = 'base64'

/** `key_mask` 形态：前 3 字元 ＋ `****` ＋ 後 4 位。 */
const MASK_HEAD_LENGTH = 3
const MASK_TAIL_LENGTH = 4
const MASK_FILLER = '****'
const MASK_MIN_LENGTH = 7

/* ---------------------------------------------------------------------------
  存储缝（离线自检注入用；生产不注入 ⇒ 经 `lib/ops.js::resolveAiStore` 取真句柄）
  —— 取集合句柄的调用字面**只允许落在 `lib/ops.js`**，本文件只持有已取到的句柄。
  --------------------------------------------------------------------------- */

let storeProvider = null

/**
 * 注入上游配置存储实现（`() => {upstream}`；传非函数 ⇒ 清除注入）。**仅供离线自检 / 宿主**。
 * @param {null|function():object} fn
 */
function setUpstreamStoreProvider(fn) {
  storeProvider = typeof fn === 'function' ? fn : null
}

/** 存储缝是否已注入（诊断读数用，**不含任何凭据**）。 */
function upstreamStoreInjected() {
  return storeProvider !== null
}

function resolveStore() {
  if (storeProvider) return storeProvider()
  const ops = require('./ops.js')
  const store = ops && typeof ops.resolveAiStore === 'function' ? ops.resolveAiStore() : null
  if (!store || !store.upstream) throw new Error('AI_UPSTREAM_STORE_UNAVAILABLE')
  return store
}

/* ---------------------------------------------------------------------------
  小工具
  --------------------------------------------------------------------------- */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function rowsOf(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.data)) return result.data
  if (result && result.data && typeof result.data === 'object') return [result.data]
  return []
}

function nowIso() {
  return text(new Date().toISOString())
}

function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value)
}

/** 读主密钥（缺 / 空 ⇒ `''` ⇒ 由调用方 fail-closed 转 `CONFIG_MISSING`）。 */
function readSecret(env) {
  const source = env || process.env
  const raw = source ? source[UPSTREAM_SECRET_ENV] : undefined
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 主密钥 ⇒ 32 字节金鑰（`sha256(secret)`）。 */
function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest()
}

/** 12 字节 iv。 */
function mintIv() {
  return crypto.randomBytes(CIPHER_IV_BYTES)
}

/** 加密：明文 ⇒ `{cipher, iv, tag}`（三件均 base64）。 */
function encryptSecret(plain, key) {
  const iv = mintIv()
  const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, key, iv)
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    cipher: body.toString(CIPHER_ENCODING),
    iv: iv.toString(CIPHER_ENCODING),
    tag: tag.toString(CIPHER_ENCODING)
  }
}

/** 解密：行上的三件 base64 ⇒ 明文（完整性校验失败 ⇒ 抛错 ⇒ 调用方转结构化拒绝）。 */
function decryptSecret(row, key) {
  const iv = Buffer.from(text(row && row.key_iv), CIPHER_ENCODING)
  const tag = Buffer.from(text(row && row.key_tag), CIPHER_ENCODING)
  if (iv.length !== CIPHER_IV_BYTES || tag.length !== CIPHER_TAG_BYTES) {
    throw new Error('AI_UPSTREAM_CIPHER_SHAPE_INVALID')
  }
  const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(Buffer.from(text(row && row.key_cipher), CIPHER_ENCODING)), decipher.final()]).toString('utf8')
}

/** `key_mask`：前 3 字元 ＋ `****` ＋ 後 4 位（不足 7 字元 ⇒ `***`）。 */
function maskOf(plain) {
  const value = text(plain)
  if (value.length < MASK_MIN_LENGTH) return '***'
  return `${value.slice(0, MASK_HEAD_LENGTH)}${MASK_FILLER}${value.slice(-MASK_TAIL_LENGTH)}`
}

/** 公共面投影（**恰 5 键；零密文、零明文**）。 */
function projectPublic(row) {
  const source = row && typeof row === 'object' ? row : {}
  return {
    base_url: text(source.base_url),
    model: text(source.model),
    key_mask: text(source.key_mask),
    timeout_ms: Number(source.timeout_ms) || TIMEOUT_DEFAULT_MS,
    updated_at: text(source.updated_at)
  }
}

/** `base_url` 值域门：`https` 协议（`https:` 加 `//`）开头且 host 非空（不猜、不自动补协议）。
 *  明文：协议常量由 `https:` 与 `//` **两段拼出**（源码内不出现整串域名形态字面值 —— 守
 *  `verify-userwrite-pa` D4「鉴权面零域名字面值」同一把尺）。 */
const URL_SCHEME_HTTPS = 'https:'
const URL_PROTOCOL_PREFIX = `${URL_SCHEME_HTTPS}//`

function baseUrlDenial(value) {
  const url = text(value)
  if (url.slice(0, URL_PROTOCOL_PREFIX.length).toLowerCase() !== URL_PROTOCOL_PREFIX) {
    return deny(REASONS.INVALID_VALUE, '上游地址（base_url）必須是 https 協議（https: 加兩個斜槓）開頭；本次零寫入。')
  }
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    return deny(REASONS.INVALID_VALUE, '上游地址（base_url）不是合法 URL；本次零寫入。')
  }
  if (!host) {
    return deny(REASONS.INVALID_VALUE, '上游地址（base_url）缺少主機名；本次零寫入。')
  }
  return null
}

/* ---------------------------------------------------------------------------
  读点
  --------------------------------------------------------------------------- */

/**
 * 读**恰一行**配置（无行 ⇒ `null`；**只读**）。
 *
 * **存在性语义（本单修生产缺陷）**：`doc(id).get()` 在**文档不存在**时 CloudBase node-sdk 会**抛错**
 * （服务端回 404 ⇒ `TcbError.code === 404`），而不是回 `{data:[]}` ⇒ 首次配置（库里无行）必抛，
 * 被上层 catch 折成 `STORAGE_UNAVAILABLE`。故这里**不依赖 `doc().get()` 的存在性语义**：
 *   · `doc().get()` 只当**快路径**，用 `try/catch` 包住，**仅**把「文档不存在」类错误当空
 *     （判据见 `lib/config.js::isDocNotExistError` —— 只看错误码 / errCode，不做 message 文本匹配），
 *     **其它错误照旧上抛**（真存储故障绝不吞成「未配置」）；
 *   · 命中「不存在」或快路径空 ⇒ 落到 `where({ _id })` 兜底 —— `where().get()` 不命中回**空数组**
 *     ⇒ 天然安全，恒不因「行不存在」抛错。
 * 两条读**任一**抛出非「不存在」类错误都直接上抛（不掩盖真故障）。
 */
async function readUpstreamRow() {
  const store = resolveStore()
  try {
    const byDoc = rowsOf(await store.upstream.doc(UPSTREAM_ID).get())
    if (byDoc.length > 0) return byDoc[0]
  } catch (error) {
    /* 只吞「文档不存在」；其余（连接 / 权限 / 5xx …）照旧上抛。 */
    if (!isDocNotExistError(error)) throw error
  }
  const all = rowsOf(await store.upstream.where({ _id: UPSTREAM_ID }).get())
  return all.length > 0 ? all[0] : null
}

/* ---------------------------------------------------------------------------
  对外：公共面（**零密文、零明文**）
  --------------------------------------------------------------------------- */

/**
 * **读上游公共配置**（**只读、零写入**）。回**恰 5 键**
 * `{base_url, model, key_mask, timeout_ms, updated_at}` —— **绝不带 `key_cipher` / `key_iv` /
 * `key_tag`，更不带明文**；尚未配置过 ⇒ 回**空值视图**（`base_url` / `model` / `key_mask` /
 * `updated_at` 为空串、`timeout_ms` 取缺省）—— 「还没填」不是错误，交给管理面去填。
 * @returns {Promise<{base_url:string, model:string, key_mask:string, timeout_ms:number, updated_at:string}>}
 */
async function getUpstreamPublic() {
  const row = await readUpstreamRow()
  return projectPublic(row)
}

/* ---------------------------------------------------------------------------
  对外：写入（**先判 env、再判值域、后整行 set**）
  --------------------------------------------------------------------------- */

/**
 * **写上游配置**（唯一写点；整行 `doc('upstream-default').set(…)` ⇒ 键面恒为恰 10 键）。
 * 判定顺序（**全部在任何写入之前**）：① 主密钥 env 在场（缺 ⇒ `CONFIG_MISSING` ＋ 零写入）
 * → ② `actor_uid` 非空 → ③ `base_url` 值域 → ④ `model` 非空 → ⑤ `timeout_ms` 值域
 * → ⑥ `key` 给则加密、省则沿用旧密文（无旧密文 ⇒ `MISSING_REQUIRED`）→ ⑦ 整行 set。
 * @param {{actor_uid:string, base_url:string, model:string, key?:string, timeout_ms?:number}} params
 * @param {object} [env] 环境（缺省 `process.env`；离线自检可注入以模拟「缺主密钥」）
 * @returns {Promise<{ok:true, base_url:string, model:string, key_mask:string, timeout_ms:number,
 *          updated_at:string}|{ok:false, reason:string, message:string}>}
 */
async function setUpstream(params, env) {
  /* ① 缺主密钥 ⇒ fail-closed（**不得静默用空密钥、不得明文落库**）。 */
  const secret = readSecret(env)
  if (!secret) {
    return deny(
      REASONS.CONFIG_MISSING,
      `AI 上游未配置（缺環境變量：${UPSTREAM_SECRET_ENV}）⇒ 拒絕寫入；本次零寫入。`
    )
  }
  const input = params && typeof params === 'object' ? params : {}
  const actorUid = text(input.actor_uid)
  if (!actorUid) return deny(REASONS.MISSING_REQUIRED, '缺少操作者標識（actor_uid）；本次零寫入。')
  const denial = baseUrlDenial(input.base_url)
  if (denial) return denial
  const model = text(input.model)
  if (!model) return deny(REASONS.MISSING_REQUIRED, '缺少模型名（model）；本次零寫入。')
  const rawTimeout = input.timeout_ms === undefined || input.timeout_ms === null ? TIMEOUT_DEFAULT_MS : input.timeout_ms
  if (!isInteger(rawTimeout) || rawTimeout < TIMEOUT_MIN_MS || rawTimeout > TIMEOUT_MAX_MS) {
    return deny(
      REASONS.INVALID_VALUE,
      `超時（timeout_ms）必須是 ${TIMEOUT_MIN_MS} 〜 ${TIMEOUT_MAX_MS} 之間的整數；本次零寫入。`
    )
  }
  const plainKey = input.key === undefined || input.key === null ? '' : String(input.key).trim()
  const existing = await readUpstreamRow()
  let cipherBody = ''
  let ivBody = ''
  let tagBody = ''
  let mask = ''
  const key32 = deriveKey(secret)
  if (plainKey) {
    const sealed = encryptSecret(plainKey, key32)
    cipherBody = sealed.cipher
    ivBody = sealed.iv
    tagBody = sealed.tag
    mask = maskOf(plainKey)
  } else if (existing && text(existing.key_cipher)) {
    /* key 可省 ⇒ **沿用旧密文**（三件一字不改；`key_mask` 亦沿用）。 */
    cipherBody = text(existing.key_cipher)
    ivBody = text(existing.key_iv)
    tagBody = text(existing.key_tag)
    mask = text(existing.key_mask)
  } else {
    return deny(REASONS.MISSING_REQUIRED, '首次配置 AI 上游必須提供金鑰（key）；本次零寫入。')
  }
  const at = nowIso()
  const row = {
    _id: UPSTREAM_ID,
    base_url: text(input.base_url),
    model,
    key_cipher: cipherBody,
    key_iv: ivBody,
    key_tag: tagBody,
    key_mask: mask,
    timeout_ms: rawTimeout,
    updated_at: at,
    updated_by_uid: actorUid
  }
  const store = resolveStore()
  await store.upstream.doc(UPSTREAM_ID).set(row)
  return {
    ok: true,
    base_url: row.base_url,
    model: row.model,
    key_mask: row.key_mask,
    timeout_ms: row.timeout_ms,
    updated_at: row.updated_at
  }
}

/* ---------------------------------------------------------------------------
  对外：服务端内部取明文（**永不进 op 回包**）
  --------------------------------------------------------------------------- */

/**
 * **服务端内部解出上游明文**（中转面用；**只读、零写入**）。回
 * `{base_url, model, key(明文), timeout_ms}` —— **该返回值永远不得进入任何 op 回包**。
 * 缺 env / 缺配置行 / 密文字段缺失 ⇒ `CONFIG_MISSING`（fail-closed，**绝不用空密钥解**）；
 * 密文完整性校验失败 ⇒ `STORAGE_UNAVAILABLE`（如实报内部不可用，**不伪装 FORBIDDEN**）。
 * @param {object} [env] 环境（缺省 `process.env`）
 * @returns {Promise<{base_url:string, model:string, key:string, timeout_ms:number}
 *          |{ok:false, reason:string, message:string}>}
 */
async function resolveUpstreamSecret(env) {
  const secret = readSecret(env)
  if (!secret) {
    return deny(
      REASONS.CONFIG_MISSING,
      `AI 上游未配置（缺環境變量：${UPSTREAM_SECRET_ENV}）⇒ 拒絕上游調用。`
    )
  }
  const row = await readUpstreamRow()
  if (!row || !text(row.key_cipher)) {
    return deny(REASONS.CONFIG_MISSING, 'AI 上游尚未配置金鑰 ⇒ 拒絕上游調用。')
  }
  try {
    return {
      base_url: text(row.base_url),
      model: text(row.model),
      key: decryptSecret(row, deriveKey(secret)),
      timeout_ms: Number(row.timeout_ms) || TIMEOUT_DEFAULT_MS
    }
  } catch {
    /* 密文 / iv / tag 不匹配（改过 env 或被改写）⇒ 如实报内部不可用。 */
    return deny(REASONS.STORAGE_UNAVAILABLE, 'AI 上游金鑰密文不可解（主密鑰或密文已變）；請重新配置。')
  }
}

module.exports = {
  AI_UPSTREAM_COLLECTION,
  UPSTREAM_ID,
  UPSTREAM_SECRET_ENV,
  UPSTREAM_ROW_KEYS,
  UPSTREAM_PUBLIC_KEYS,
  TIMEOUT_DEFAULT_MS,
  TIMEOUT_MIN_MS,
  TIMEOUT_MAX_MS,
  CIPHER_ALGORITHM,
  CIPHER_IV_BYTES,
  CIPHER_TAG_BYTES,
  CIPHER_KEY_BYTES,
  CIPHER_ENCODING,
  MASK_HEAD_LENGTH,
  MASK_TAIL_LENGTH,
  MASK_FILLER,
  deriveKey,
  encryptSecret,
  decryptSecret,
  maskOf,
  projectPublic,
  readUpstreamRow,
  setUpstreamStoreProvider,
  upstreamStoreInjected,
  getUpstreamPublic,
  setUpstream,
  resolveUpstreamSecret
}
