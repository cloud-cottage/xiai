'use strict'
/**
 * 玺爱 · **用户令牌云函数**（写面 Phase A｜CloudBase 事件型函数）
 * ============================================================================
 * 职责（本单范围）：**给普通用户发可验证登录令牌** ＋ **一条经云端校验的用户写路径**。
 *  ① `action:'issue'`  —— 服务端验证登录（手机号形态 ＋ 验证码 ∈ 环境变量）⇒ 签发**短 TTL 用户令牌**；
 *  ② `action:'verify'` —— 验签 → 有效期 → `role==='user'` → `op` 值域 / 字段门
 *      → **权威落盘（服务端以管理端凭据写 `xiai_*`，创建者身份取自令牌）** → **滑动续期**。
 *
 * **与管理员令牌共用同一套（逐条）** ✗ 不得另造第二套：
 *  · 签名 / 验签 / 时戳 / 版本判定 ⇒ **同一份 `lib/token.js`**（与 `xiai-admin-token/lib/token.js`
 *    **逐字节相同**，由 `scripts/verify-userwrite-pa.mjs` 的 `D1` 断言 sha256 恒等）；
 *  · 令牌形态 ⇒ `<base64url(payload)>.<base64url(hmac-sha256)>`、payload `{v,sub,role,iat,exp,jti,ver}`；
 *  · TTL 默认 900 s ＋ **滑动续期**（每次校验通过回吐新令牌，`exp = now + ttl`）；
 *  · 失败形态 ⇒ **恒为恰 3 键 `{ok:false, reason, message}`**，`reason` ∈ 既有冻结表（**新增字面值 0**）；
 *    内部判别码只进函数日志，**不回客户端**（防探测）。
 *
 * 硬口径（逐条）：
 *  · **密钥只在函数环境变量**（`XIAI_USER_TOKEN_SECRET`；**与管理员函数的密钥不是同一把**
 *    ⇒ 令牌**不跨函数通用**：用户令牌拿去调管理员函数必被白名单拒，管理员令牌拿来调本函数
 *    也过不了 `role==='user'` 那一道）；✗ 不入仓、✗ 不入构建产物、✗ 不进日志。
 *  · **服务端时钟是唯一判据**；客户端本地时间**不参与**任何判定。
 *  · **创建者身份由服务端记录**（`uid = u-<手机号>` 确定性派生；手机号来自已验签的令牌声明）
 *    ⇒ **不采信前端自称**（载荷里的 `userId` / `user_id` / `phone` / `role` … ⇒ `INVALID_FIELD` ＋ 零写入）。
 *  · **网络 / 内部失败不得伪装成 `FORBIDDEN`**（R-WF2）：未配置 / 存储不可用 / 内部异常
 *    一律 `STORAGE_UNAVAILABLE`；`FORBIDDEN` 只用于**真正的授权判定**。
 *  · **失败即终止、零半成品**：全部判定在落盘之前；落盘只有**一次单文档插入**（无多集合写）。
 *  · **不碰 liwu 任何集合 / 函数**；集合名一律 `^xiai_` 前缀（本单仅 `xiai_corrections`）。
 *
 * 风险登记（**不在本单代裁**）：验证码仍是**环境变量固定值** ⇒ 沿用 `W-43`（已接受风险，暂缓）；
 * 本函数把它做成注入点（工程内零字面值），一裁即可换成真实短信通道。
 */

const {
  REASONS,
  ENV_NAMES,
  deny,
  normalizePhone,
  isPhoneLike,
  uidOf,
  fingerprint,
  maskedPhone,
  readConfig
} = require('./lib/config.js')
const { TOKEN_DETAILS, issueToken, verifyToken } = require('./lib/token.js')
const { OPS, persist } = require('./lib/ops.js')

/** 对外文案（**繁體、如实、不泄漏内部标识**；按内部判别码映射，逐条一一对应）。 */
const DENIAL_MESSAGES = Object.freeze({
  /* 无令牌 / 格式错 / 验签失败 ⇒ **同一条文案**（不区分 ⇒ 防探测）。 */
  [TOKEN_DETAILS.MISSING]: '僅已登錄用戶可以執行此操作（未攜帶有效令牌）；本次零寫入。',
  [TOKEN_DETAILS.MALFORMED]: '僅已登錄用戶可以執行此操作（未攜帶有效令牌）；本次零寫入。',
  [TOKEN_DETAILS.BAD_SIGNATURE]: '僅已登錄用戶可以執行此操作（未攜帶有效令牌）；本次零寫入。',
  [TOKEN_DETAILS.EXPIRED]: '用戶登錄已過期，請重新登錄；本次零寫入。',
  [TOKEN_DETAILS.NOT_YET_VALID]: '用戶令牌尚未生效（時鐘異常），請重新登錄；本次零寫入。',
  [TOKEN_DETAILS.VERSION_MISMATCH]: '用戶登錄已失效（令牌已撤銷），請重新登錄；本次零寫入。',
  [TOKEN_DETAILS.SUBJECT_MISSING]: '僅已登錄用戶可以執行此操作（令牌缺少有效手機號）；本次零寫入。',
  SUBJECT_NOT_ALLOWED: '僅已登錄用戶可以執行此操作（令牌身份不符）；本次零寫入。',
  SECRET_MISSING: '用戶令牌服務未配置；本次零寫入。',
  CLOCK_UNAVAILABLE: '用戶令牌服務時鐘不可用；本次零寫入。',
  TTL_UNAVAILABLE: '用戶令牌服務未配置（TTL）；本次零寫入。'
})

/** 内部判别码 ⇒ 对外 reason（**一律落到既有冻结字面值**，不新增）。 */
const DENIAL_REASONS = Object.freeze({
  [TOKEN_DETAILS.MISSING]: REASONS.FORBIDDEN,
  [TOKEN_DETAILS.MALFORMED]: REASONS.FORBIDDEN,
  [TOKEN_DETAILS.BAD_SIGNATURE]: REASONS.FORBIDDEN,
  [TOKEN_DETAILS.EXPIRED]: REASONS.FORBIDDEN,
  [TOKEN_DETAILS.NOT_YET_VALID]: REASONS.FORBIDDEN,
  [TOKEN_DETAILS.VERSION_MISMATCH]: REASONS.FORBIDDEN,
  [TOKEN_DETAILS.SUBJECT_MISSING]: REASONS.FORBIDDEN,
  SUBJECT_NOT_ALLOWED: REASONS.FORBIDDEN,
  SECRET_MISSING: REASONS.STORAGE_UNAVAILABLE,
  CLOCK_UNAVAILABLE: REASONS.STORAGE_UNAVAILABLE,
  TTL_UNAVAILABLE: REASONS.STORAGE_UNAVAILABLE
})

/** 结构化审计日志（**不含令牌原文 / 不含密钥 / 不含手机号原文**）。 */
function audit(record) {
  try {
    console.log(JSON.stringify(Object.assign({ tag: 'xiai-user-token' }, record)))
  } catch {
    /* 日志失败不得影响判定结果 */
  }
}

function denialFor(detail) {
  return deny(
    DENIAL_REASONS[detail] || REASONS.FORBIDDEN,
    DENIAL_MESSAGES[detail] || DENIAL_MESSAGES[TOKEN_DETAILS.MISSING]
  )
}

function serverNowSeconds() {
  return Math.floor(Date.now() / 1000)
}

/**
 * 动作：签发（**服务端验证登录**）。
 * 判定顺序（**两条都必须在任何签发之前**）：① 手机号形态；② 验证码 ∈ 环境变量。
 * 两者不合一律 `FORBIDDEN`（**不区分「号不对」与「码不对」** ⇒ 防枚举）。
 */
function handleIssue(event, config) {
  const now = serverNowSeconds()
  const phone = normalizePhone(event.phone)
  const code = typeof event.code === 'string' ? event.code.trim() : ''
  const phoneOk = isPhoneLike(phone)
  const codeOk = code !== '' && code === config.smsCode
  if (!phoneOk || !codeOk) {
    audit({
      action: 'issue',
      outcome: REASONS.FORBIDDEN,
      phoneFingerprint: fingerprint(phone),
      phoneMasked: maskedPhone(phone),
      phoneOk,
      codeOk,
      serverNow: now
    })
    return deny(REASONS.FORBIDDEN, '手機號或驗證碼不正確；本次零寫入。')
  }
  const uid = uidOf(phone)
  const issued = issueToken({
    sub: phone,
    secret: config.secret,
    nowSeconds: now,
    ttlSeconds: config.ttlSeconds,
    version: config.version,
    role: 'user'
  })
  if (!issued.ok) return denialFor(issued.detail)
  audit({
    action: 'issue',
    outcome: 'ok',
    subFingerprint: fingerprint(phone),
    uid, // uid 是派生结果（非密钥），可入日志
    exp: issued.claims.exp,
    jti: issued.claims.jti,
    ver: issued.claims.ver,
    serverNow: now
  })
  return {
    ok: true,
    token: issued.token,
    sub: maskedPhone(phone),
    subFingerprint: fingerprint(phone),
    uid,
    issuedAt: issued.claims.iat,
    expiresAt: issued.claims.exp,
    ttlSeconds: config.ttlSeconds,
    ver: issued.claims.ver,
    serverNow: now
  }
}

/**
 * 动作：校验 ＋ **权威落盘** ＋ 滑动续期。
 * 顺序：① 验签（含格式 / 签名 / 版本）→ ② 有效期 → ③ 身份面（`sub` 须是合法手机号、`role` 须为 `user`
 *       ⇒ **uid 服务端派生**）→ ④ `op` 值域 / 字段门 → ⑤ 落盘 → ⑥ 滑动续期。
 * 任一环失败 ⇒ **结构化拒绝且零写入**（落盘在最后一步，前面任一步失败都到不了它）。
 */
async function handleVerify(event, config) {
  const now = serverNowSeconds()
  const op = typeof event.op === 'string' ? event.op.trim() : ''
  const checked = verifyToken({
    token: event.token,
    secret: config.secret,
    nowSeconds: now,
    leewaySeconds: config.leewaySeconds,
    version: config.version
  })
  if (!checked.ok) {
    audit({ action: 'verify', outcome: checked.detail, op, serverNow: now })
    return denialFor(checked.detail)
  }
  /* ③ 身份面：手机号必须合法，且令牌角色必须是 `user`（管理员令牌由另一把密钥签 ⇒ 到不了这里）。 */
  const phone = normalizePhone(checked.claims.sub)
  const role = String(checked.claims.role === undefined || checked.claims.role === null ? '' : checked.claims.role)
  if (!isPhoneLike(phone) || role !== 'user') {
    audit({ action: 'verify', outcome: 'SUBJECT_NOT_ALLOWED', op, role, serverNow: now })
    return denialFor('SUBJECT_NOT_ALLOWED')
  }
  /* **身份的唯一来源**：服务端从令牌声明派生（载荷里的身份类键在 op 门里被拒）。 */
  const identity = Object.freeze({ uid: uidOf(phone), phone })
  /* ④ op 面：未知 op ⇒ `INVALID_FIELD`（**不静默放行**）。 */
  const validator = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null
  if (!validator) {
    audit({ action: 'verify', outcome: REASONS.INVALID_FIELD, op, serverNow: now })
    return deny(REASONS.INVALID_FIELD, `未知的寫入操作（op）：${op || '（空）'}；本次零寫入。`)
  }
  const opResult = validator(event.payload, identity)
  if (!opResult.ok) {
    audit({ action: 'verify', outcome: opResult.reason, op, uid: identity.uid, serverNow: now })
    return opResult
  }
  /* ⑤ 落盘（**全部判定之后**；失败 ⇒ `STORAGE_UNAVAILABLE`，**绝不伪装 `FORBIDDEN`**）。 */
  let docId = ''
  try {
    docId = await persist(opResult.plan)
  } catch (error) {
    audit({
      action: 'verify',
      outcome: REASONS.STORAGE_UNAVAILABLE,
      op,
      uid: identity.uid,
      stage: 'persist',
      detail: (error && error.message) || 'unknown',
      serverNow: now
    })
    return deny(REASONS.STORAGE_UNAVAILABLE, '用戶寫入服務的權威存儲不可用；本次零寫入。')
  }
  if (!docId) {
    audit({ action: 'verify', outcome: REASONS.STORAGE_UNAVAILABLE, op, uid: identity.uid, stage: 'persist-id', serverNow: now })
    return deny(REASONS.STORAGE_UNAVAILABLE, '權威存儲未回傳文檔標識，無法確認寫入；本次零寫入。')
  }
  /* ⑥ 滑动续期：**只续期、不续权** —— 续期仍走完上面全部判定（本节即在其后）。 */
  const renewed = issueToken({
    sub: phone,
    secret: config.secret,
    nowSeconds: now,
    ttlSeconds: config.ttlSeconds,
    version: config.version,
    role: 'user'
  })
  if (!renewed.ok) return denialFor(renewed.detail)
  audit({
    action: 'verify',
    outcome: 'ok',
    op,
    uid: identity.uid,
    docId,
    jti: renewed.claims.jti,
    exp: renewed.claims.exp,
    ver: renewed.claims.ver,
    serverNow: now
  })
  return {
    ok: true,
    op,
    /** **服务端权威行**（前端拿到的就是它 ⇒ 本地只做镜像，不自建行）。 */
    row: opResult.row,
    docId,
    authority: 'SERVER',
    identity: {
      uid: identity.uid,
      phone: maskedPhone(phone),
      phoneFingerprint: fingerprint(phone)
    },
    serverNow: now,
    /* **滑动续期**：客户端应以此覆盖缓存中的令牌（只延长时效，不改变权限面）。 */
    renewedToken: renewed.token,
    renewedExpiresAt: renewed.claims.exp,
    renewedTtlSeconds: config.ttlSeconds,
    ver: renewed.claims.ver
  }
}

/**
 * 函数入口（CloudBase 事件型）。
 * **任何未预期异常一律转成结构化拒绝**（`STORAGE_UNAVAILABLE`）—— 不得抛未捕获异常、不得伪装 `FORBIDDEN`。
 * @param {object} event `{action:'issue'|'verify', ...}`
 */
exports.main = async function main(event) {
  const input = event && typeof event === 'object' ? event : {}
  const action = typeof input.action === 'string' ? input.action.trim() : ''
  let config = null
  try {
    config = readConfig()
  } catch {
    return deny(REASONS.STORAGE_UNAVAILABLE, '用戶令牌服務內部錯誤；本次零寫入。')
  }
  if (!config.ready) {
    audit({ action: action || '（空）', outcome: config.reason, serverNow: serverNowSeconds() })
    return deny(config.reason, config.message)
  }
  try {
    if (action === 'issue') return handleIssue(input, config)
    if (action === 'verify') return await handleVerify(input, config)
    return deny(REASONS.FORBIDDEN, `未知的操作（action）：${action || '（空）'}；本次零寫入。`)
  } catch {
    audit({ action: action || '（空）', outcome: REASONS.STORAGE_UNAVAILABLE, serverNow: serverNowSeconds() })
    return deny(REASONS.STORAGE_UNAVAILABLE, '用戶令牌服務內部錯誤；本次零寫入。')
  }
}

/* 供离线自检复用（同一函数体内的动作分发面与判定表）。 */
exports.OPS = OPS
exports.DENIAL_MESSAGES = DENIAL_MESSAGES
exports.DENIAL_REASONS = DENIAL_REASONS
exports.ENV_NAMES = ENV_NAMES
