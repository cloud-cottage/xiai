'use strict'
/**
 * 玺爱 · 管理员令牌云函数（写面 Phase 1｜CloudBase 事件型函数）
 * ============================================================================
 * 职责（本单范围）两条，**只此两条**：
 *   ① **签发**：校验「手机号 ∈ 白名单（环境变量注入）」＋「验证码 ＝ 环境变量注入的码」之后，
 *      签发一枚 **HMAC-SHA256 签名 + 15 分钟 TTL** 的短期令牌；**滑动续期**（每次校验通过回吐新令牌）。
 *   ② **校验**：供**写函数复用**（本单：同一函数的 `verify` 动作即 Phase-1 垂直切片的服务端判据；
 *      判定逻辑抽在 `lib/token.js` ⇒ Phase 2 的写函数直接 `require` 它即可，不必复制）。
 *
 * 硬口径（逐条，与设计单 / Zang 裁定对齐）：
 *   · **密钥只在函数环境变量**（`XIAI_ADMIN_TOKEN_SECRET`）✗ 不入仓、✗ 不入构建产物、✗ 不进日志。
 *   · **服务端时钟是唯一判据**：`nowSeconds` ＝ 本函数时钟；客户端本地时间**不参与**任何判定。
 *   · **服务端验签是唯一授权判据**（R-WF1）：本函数的 `verify` 不看调用方任何身份，
 *     只看自己签发的令牌 ⇒ 伪造本地 `role` 不产生任何效力。
 *   · **网络 / 内部失败不得伪装成 `FORBIDDEN`**（R-WF2）：未配置 / 内部异常一律 `STORAGE_UNAVAILABLE`；
 *     `FORBIDDEN` 只用于**真正的授权判定**（无令牌 / 验签失败 / 过期 / 手机号不符 / 已撤销）。
 *   · **Phase 1 的 `setInviteReward` 不做任何持久化写入**（授权面与持久化面分离）⇒ **其负向调用天然零写入**；
 *     落盘发生在客户端**且仅在 `ok:true` 之后**（见 `src/services/admin.js::setInviteReward`）。
 *   · **Phase 2 新增写面 `reviewCorrection`（勘误审核）**：服务端验签后**权威落盘两处** ——
 *     ① 私有集合 `xiai_corrections` 的状态（`status` / `reviewed_at` / `reviewer_id`，驳回另加 `review_note`）；
 *     ② 新公开只读集合 `xiai_corrections_public` 的**脱敏投影行**（**零身份字段**，供全站只读展示）。
 *     **判定全部在写之前**（拒绝 ⇒ 零写入）；落库经 `lib/ops.js` 的**唯一写点** `persist()`，
 *     用函数运行环境的管理端凭据（云数据库 SDK 延迟 require，不入仓 / 不下发前端）。
 *   · **失败形状恒为 `{ok:false, reason, message}`（恰 3 键）**：不加旁路诊断字段；
 *     内部判别码（`detail`）**只进函数日志**，不回客户端（防探测）。
 *   · **不碰 liwu 任何集合 / 函数**（R-WF4）；Phase 1 零外部依赖，Phase 2 写面按需延迟 require 云数据库 SDK。
 */

const {
  REASONS,
  ENV_NAMES,
  deny,
  normalizePhone,
  uidOf,
  fingerprint,
  maskedPhone,
  readConfig
} = require('./lib/config.js')
const { TOKEN_DETAILS, issueToken, verifyToken } = require('./lib/token.js')
const { OPS: ADMIN_OPS, persist, readRoleRow } = require('./lib/ops.js')
/* **V6-a**：调用者平台会话身份判权（additive）；`IDENTITY_SOURCES` / `ROLE` 单点自 `sessionAuthority.js`；
   **V6-a 加固（修订）**：只读诊断 op `sessionProbe`（无令牌可调、context 形状诊断：布尔-only ＋ 零值回显）亦单点自同份文件。 */
const { resolveSessionAuthority, IDENTITY_SOURCES, ROLE, sessionProbe, isSessionProbe } = require('./lib/sessionAuthority.js')

/** 对外文案（**繁體、如实、不泄漏内部标识**；按内部判别码映射，逐条一一对应）。 */
const DENIAL_MESSAGES = Object.freeze({
  /* 无令牌：与「验签失败」**同文案**（不区分 ⇒ 防探测）。 */
  [TOKEN_DETAILS.MISSING]: '僅管理員可以執行此操作（未攜帶有效令牌）；本次零寫入。',
  [TOKEN_DETAILS.MALFORMED]: '僅管理員可以執行此操作（未攜帶有效令牌）；本次零寫入。',
  [TOKEN_DETAILS.BAD_SIGNATURE]: '僅管理員可以執行此操作（未攜帶有效令牌）；本次零寫入。',
  [TOKEN_DETAILS.EXPIRED]: '管理員會話已過期，請重新驗證；本次零寫入。',
  [TOKEN_DETAILS.NOT_YET_VALID]: '管理員令牌尚未生效（時鐘異常），請重新驗證；本次零寫入。',
  [TOKEN_DETAILS.VERSION_MISMATCH]: '管理員會話已失效（令牌已撤銷），請重新驗證；本次零寫入。',
  [TOKEN_DETAILS.SUBJECT_MISSING]: '僅管理員可以執行此操作（令牌缺少手機號）；本次零寫入。',
  SECRET_MISSING: '管理員令牌服務未配置；本次零寫入。',
  CLOCK_UNAVAILABLE: '管理員令牌服務時鐘不可用；本次零寫入。',
  TTL_UNAVAILABLE: '管理員令牌服務未配置（TTL）；本次零寫入。'
})

/** 内部判别码 ⇒ 对外 reason（**一律落到既有冻结字面值**，不新增）。 */
const DENIAL_REASONS = Object.freeze({
  [TOKEN_DETAILS.EXPIRED]: REASONS.FORBIDDEN,
  [TOKEN_DETAILS.NOT_YET_VALID]: REASONS.FORBIDDEN,
  [TOKEN_DETAILS.VERSION_MISMATCH]: REASONS.FORBIDDEN,
  [TOKEN_DETAILS.SUBJECT_MISSING]: REASONS.FORBIDDEN,
  [TOKEN_DETAILS.MISSING]: REASONS.FORBIDDEN,
  [TOKEN_DETAILS.MALFORMED]: REASONS.FORBIDDEN,
  [TOKEN_DETAILS.BAD_SIGNATURE]: REASONS.FORBIDDEN,
  SECRET_MISSING: REASONS.STORAGE_UNAVAILABLE,
  CLOCK_UNAVAILABLE: REASONS.STORAGE_UNAVAILABLE,
  TTL_UNAVAILABLE: REASONS.STORAGE_UNAVAILABLE
})

/**
 * **写操作注册面（Phase 1 只登记一个 op）**：本单垂直切片 ＝ `setInviteReward`（只写一个配置键）。
 * 每个 op 的服务端职责：**值域 / 字段面门**（拒绝 ⇒ 零写入）。Phase 2 的写函数在此表上追加各自 op。
 * 明文：本函数**不把 op 的落库动作放在这里**（Phase 1 不做持久化；见文件头）。
 */
const OPS = Object.freeze({
  setInviteReward(payload) {
    if (payload === undefined || payload === null || typeof payload !== 'object') {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => key !== 'value')
    if (unknown.length > 0) {
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（如實報回，不靜默丟鍵）；本次零寫入。`)
    }
    const value = payload.value
    if (!Number.isInteger(value) || value < 0) {
      return deny(
        REASONS.INVALID_VALUE,
        `邀請獎勵必須是「非負整數」（非整數 / 負數 / 非數字一律拒收）；本次零寫入。`
      )
    }
    return { ok: true, value }
  }
})

/** 结构化审计日志（**不含令牌原文 / 不含密钥 / 不含手机号原文**）。 */
function audit(record) {
  try {
    console.log(JSON.stringify(Object.assign({ tag: 'xiai-admin-token' }, record)))
  } catch {
    /* 日志失败不得影响判定结果 */
  }
}

function denialFor(detail) {
  return deny(DENIAL_REASONS[detail] || REASONS.FORBIDDEN, DENIAL_MESSAGES[detail] || DENIAL_MESSAGES[TOKEN_DETAILS.MISSING])
}

function serverNowSeconds() {
  return Math.floor(Date.now() / 1000)
}

/**
 * 动作：签发。
 * 判定顺序（**两条都必须在任何签发之前**）：① 手机号白名单；② 验证码。
 * 两者不合一律 `FORBIDDEN`（**不区分「号不对」与「码不对」** ⇒ 防枚举）。
 */
function handleIssue(event, config) {
  const now = serverNowSeconds()
  const phone = normalizePhone(event.phone)
  const code = typeof event.code === 'string' ? event.code.trim() : ''
  const phoneOk = phone !== '' && phone === config.phone
  const codeOk = code !== '' && code === config.smsCode
  if (!phoneOk || !codeOk) {
    audit({
      action: 'issue',
      outcome: REASONS.FORBIDDEN,
      phoneFingerprint: fingerprint(phone),
      phoneMasked: maskedPhone(phone),
      phoneMatch: phoneOk,
      codeMatch: codeOk,
      serverNow: now
    })
    return deny(REASONS.FORBIDDEN, '僅管理員可以取得寫入令牌（手機號或驗證碼不正確）；本次零寫入。')
  }
  const issued = issueToken({
    sub: config.phone,
    secret: config.secret,
    nowSeconds: now,
    ttlSeconds: config.ttlSeconds,
    version: config.version,
    role: 'admin'
  })
  if (!issued.ok) return denialFor(issued.detail)
  audit({
    action: 'issue',
    outcome: 'ok',
    subFingerprint: fingerprint(config.phone),
    exp: issued.claims.exp,
    jti: issued.claims.jti,
    ver: issued.claims.ver,
    serverNow: now
  })
  return {
    ok: true,
    token: issued.token,
    sub: maskedPhone(config.phone),
    subFingerprint: fingerprint(config.phone),
    issuedAt: issued.claims.iat,
    expiresAt: issued.claims.exp,
    ttlSeconds: config.ttlSeconds,
    ver: issued.claims.ver,
    serverNow: now
  }
}

/**
 * 动作：校验（**供写函数复用的那一层**）。
 * 顺序：① 验签（含格式 / 签名 / 版本）→ ② 有效期 → ③ 手机号 ∈ 白名单 →
 *      ④ op 值域 / 字段门（legacy）或「读私有行 → 状态门 → 值域门」（persistent）→
 *      ⑤ **权威落盘**（仅 persistent op；`reviewCorrection` 写私有状态 ＋ 公开脱敏投影）。
 * **任一环失败 ⇒ 结构化拒绝且零写入**；落盘失败 ⇒ `STORAGE_UNAVAILABLE`（**绝不伪装 `FORBIDDEN`**）；
 * 成功 ⇒ **滑动续期**（回吐新令牌，`exp = now + ttl`）。
 */
async function handleVerify(event, config, callContext) {
  const now = serverNowSeconds()
  const op = typeof event.op === 'string' ? event.op.trim() : ''
  /* **V6-a 加固（修订）**：只读诊断 op `sessionProbe` —— **无令牌可调**、**context 形状诊断**
     （布尔-only ＋ 零值回显：候选容器存在性 / uidPresent / uidKind / anonymousMarker / mode）、
     **零写入**；**在任何鉴权 / 开关 / 会话 / 令牌判定之前**短路返回（递入 `context` 供形状诊断）。 */
  if (isSessionProbe(op)) return sessionProbe(callContext)
  /* **V6-a：优先取调用者平台会话身份**（additive）：会话在场 ⇒ 查 `xiai_roles`（**要求 admin 角色**）
     判权（fail-closed、零写入；读失败 ⇒ `STORAGE_UNAVAILABLE`，**不伪装 FORBIDDEN**）；拿不到会话 ⇒
     **回落既有令牌路**（下面那一段逐字不变）。 */
  const authority = await resolveSessionAuthority({
    context: callContext,
    readRole: readRoleRow,
    requiredRoles: [ROLE.ADMIN]
  })
  if (!authority.ok) {
    audit({ action: 'verify', outcome: authority.reason, op, stage: 'session-authority', serverNow: now })
    return authority
  }
  let identity = null
  let subject = ''
  let checked = null
  if (authority.obtained) {
    /* 会话路：身份 ＝ 平台会话 uid ＋ `xiai_roles` 角色（要求 admin；手机号不参与判定）。 */
    identity = Object.freeze({
      uid: authority.uid,
      phone: '',
      role: authority.role,
      identity_source: IDENTITY_SOURCES.SESSION
    })
  } else {
    checked = verifyToken({
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
    /* ③ 白名单（**服务端是唯一判据**；令牌里的 `sub` 必须逐字等于注入的白名单手机号）。 */
    subject = normalizePhone(checked.claims.sub)
    if (subject === '' || subject !== config.phone) {
      audit({
        action: 'verify',
        outcome: 'SUBJECT_NOT_ALLOWED',
        op,
        subFingerprint: fingerprint(subject),
        serverNow: now
      })
      return deny(REASONS.FORBIDDEN, '僅管理員可以執行此操作（手機號不在白名單）；本次零寫入。')
    }
    identity = Object.freeze({
      uid: uidOf(subject),
      phone: subject,
      role: 'admin',
      identity_source: IDENTITY_SOURCES.SERVER_TOKEN
    })
  }
  /* ④ op 面：未知 op ⇒ `INVALID_FIELD`（**不静默放行**）。两个注册面：
     · `OPS`（Phase 1 遗留，`setInviteReward`；**不产落盘计划** ⇒ 行为逐字不变）；
     · `ADMIN_OPS`（Phase 2 写面，`reviewCorrection`；产落盘计划 ⇒ 由本函数权威落盘）。 */
  const legacyValidator = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null
  const persistentValidator = Object.prototype.hasOwnProperty.call(ADMIN_OPS, op) ? ADMIN_OPS[op] : null
  if (!legacyValidator && !persistentValidator) {
    audit({ action: 'verify', outcome: REASONS.INVALID_FIELD, op, serverNow: now })
    return deny(REASONS.INVALID_FIELD, `未知的寫入操作（op）：${op || '（空）'}；本次零寫入。`)
  }
  /* ⑤ **动笔之前的全部判定**：op 值域 / 字段门（legacy）或「读私有行 → 状态门 → 值域门」（persistent）。
     身份已在上面定妥（令牌路＝服务端从**已验签令牌声明**派生；会话路＝平台注入 uid ＋ `xiai_roles`；
     载荷里的身份类键在 op 门里被拒）。 */
  let opResult = null
  try {
    opResult = legacyValidator ? legacyValidator(event.payload) : await persistentValidator(event.payload, identity, now)
  } catch (error) {
    /* 读私有行失败（网络 / 内部）⇒ `STORAGE_UNAVAILABLE`，**绝不伪装 `FORBIDDEN`**。 */
    audit({
      action: 'verify',
      outcome: REASONS.STORAGE_UNAVAILABLE,
      op,
      stage: 'prepare',
      detail: (error && error.message) || 'unknown',
      serverNow: now
    })
    return deny(REASONS.STORAGE_UNAVAILABLE, '管理員寫入服務的權威存儲不可用；本次零寫入。')
  }
  if (!opResult.ok) {
    audit({ action: 'verify', outcome: opResult.reason, op, serverNow: now })
    return opResult
  }
  /* ⑥ 权威落盘（**仅当 op 产出了落盘计划**；`setInviteReward` 无计划 ⇒ 不做持久化，逐字不变）。
     失败 ⇒ `STORAGE_UNAVAILABLE`（**绝不伪装 `FORBIDDEN`**）。 */
  if (opResult.plan) {
    try {
      opResult.wrote = await persist(opResult.plan)
    } catch (error) {
      audit({
        action: 'verify',
        outcome: REASONS.STORAGE_UNAVAILABLE,
        op,
        stage: 'persist',
        detail: (error && error.message) || 'unknown',
        serverNow: now
      })
      return deny(REASONS.STORAGE_UNAVAILABLE, '管理員寫入服務的權威存儲不可用；本次零寫入。')
    }
  }
  /* ⑦ 滑动续期：**只续期、不续权**（**仅令牌路** —— 会话路无令牌可续）；续期仍走完上面全部判定。 */
  const renewed = checked
    ? issueToken({
        sub: config.phone,
        secret: config.secret,
        nowSeconds: now,
        ttlSeconds: config.ttlSeconds,
        version: config.version,
        role: 'admin'
      })
    : null
  if (renewed && !renewed.ok) return denialFor(renewed.detail)
  audit({
    action: 'verify',
    outcome: 'ok',
    op,
    identitySource: identity.identity_source,
    subFingerprint: fingerprint(subject),
    jti: renewed ? renewed.claims.jti : '-',
    exp: renewed ? renewed.claims.exp : 0,
    ver: renewed ? renewed.claims.ver : config.version,
    serverNow: now
  })
  const response = {
    ok: true,
    op,
    sub: checked ? maskedPhone(config.phone) : '',
    subFingerprint: checked ? fingerprint(config.phone) : '',
    /* **身份来源标记（additive）**：`SESSION`（平台会话路）/ `SERVER_TOKEN`（既有令牌路）。 */
    identity_source: identity.identity_source,
    serverNow: now,
    ver: renewed ? renewed.claims.ver : config.version
  }
  /* **滑动续期**（仅令牌路）：客户端应以此覆盖缓存中的令牌（只延长时效，不改变权限面）。 */
  if (renewed) {
    response.renewedToken = renewed.token
    response.renewedExpiresAt = renewed.claims.exp
    response.renewedTtlSeconds = config.ttlSeconds
  }
  /* `setInviteReward`（Phase 1，无持久化）：保持原成功态自述（回吐 `value`，字段面不变）。 */
  if (opResult.value !== undefined) response.value = opResult.value
  /* `reviewCorrection`（Phase 2，已持久化）：回吐**服务端权威行** ＋ 公开投影行 ＋ 落盘读数。 */
  if (opResult.row !== undefined) {
    response.authority = 'SERVER'
    response.row = opResult.row
    response.projection = opResult.projection
    response.wrote = opResult.wrote
    response.identity = {
      uid: identity.uid,
      phone: identity.phone ? maskedPhone(identity.phone) : '',
      phoneFingerprint: identity.phone ? fingerprint(identity.phone) : '',
      identity_source: identity.identity_source
    }
  }
  return response
}

/**
 * 函数入口（CloudBase 事件型）。
 * **任何未预期异常一律转成结构化拒绝**（`STORAGE_UNAVAILABLE`）—— 不得抛未捕获异常、不得伪装 `FORBIDDEN`。
 * @param {object} event `{action:'issue'|'verify', ...}`
 */
exports.main = async function main(event, context) {
  const input = event && typeof event === 'object' ? event : {}
  const action = typeof input.action === 'string' ? input.action.trim() : ''
  let config = null
  try {
    config = readConfig()
  } catch {
    return deny(REASONS.STORAGE_UNAVAILABLE, '管理員令牌服務內部錯誤；本次零寫入。')
  }
  if (!config.ready) {
    audit({ action: action || '（空）', outcome: config.reason, serverNow: serverNowSeconds() })
    return deny(config.reason, config.message)
  }
  try {
    if (action === 'issue') return handleIssue(input, config)
    if (action === 'verify') return await handleVerify(input, config, context)
    return deny(REASONS.FORBIDDEN, `未知的操作（action）：${action || '（空）'}；本次零寫入。`)
  } catch {
    /* 内部异常 ⇒ **不得伪装 FORBIDDEN**（R-WF2）；如实报 `STORAGE_UNAVAILABLE`。 */
    audit({ action: action || '（空）', outcome: REASONS.STORAGE_UNAVAILABLE, serverNow: serverNowSeconds() })
    return deny(REASONS.STORAGE_UNAVAILABLE, '管理員令牌服務內部錯誤；本次零寫入。')
  }
}

/* 供测试 / Phase 2 的写函数复用（同一函数内的动作分发面）。 */
exports.OPS = OPS
exports.ADMIN_OPS = ADMIN_OPS
exports.DENIAL_MESSAGES = DENIAL_MESSAGES
exports.ENV_NAMES = ENV_NAMES
