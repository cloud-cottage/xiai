/**
 * 玺爱 · **令牌管道（通用）**（写面 Phase A：由 `adminToken.js` 泛化而来）
 * ============================================================================
 * 唯一职责：**取票 → 缓存 → 携带 → 滑动续期 → 失败形态**。**它自己不是判据**。
 *
 * 为什么泛化（而不是复制一份）：管理员写面（Phase 1 已上线）与用户写面（Phase A）
 * 用的是**同一套**令牌机制 —— 同形态令牌、同 TTL、同滑动续期、同失败形态 ⇒ 复制一份必然漂移。
 * 本文件把「通道」抽成 `createTokenChannel(profile)`，两条通道只在**函数名**与**文案主语**上不同：
 *   · `adminChannel` ⇒ `xiai-admin-token`（管理员写面）
 *   · `userChannel`  ⇒ `xiai-user-token`（普通用户写面）
 * `src/services/adminToken.js` 因此退化为**兼容转口**（`export * from './token.js'`），
 * `src/services/userToken.js` 是用户侧的薄转口。
 *
 * 硬口径（**两条通道逐条相同**，Phase 1 已裁、Phase A 沿用）：
 *   · **服务端验签是唯一判据**（R-WF1）：本文件从不产出「可以写」的结论 ——
 *     每一次写操作都拿云函数的回传当判据；本地 `role` **不参与**任何放行判定。
 *   · **前端永不下发写权限判据** ✓：密钥 / 白名单手机号 / 签名算法**一概不在前端**；
 *     前端只负责**携带**令牌（`token` 字段）与**呈现**拒绝文案。
 *   · **网络失败不得伪装成 `FORBIDDEN`** ✓：传输层失败一律 `STORAGE_UNAVAILABLE`（见 `data/cloudbaseFn.js`）；
 *     **服务端的业务拒绝原样透传**（本文件不改写 `reason` / `message`）。
 *   · **身份不由前端自称**：令牌里只带**服务端验签过的手机号**（`sub`），uid 由服务端派生；
 *     载荷里的身份类键由服务端拒（`INVALID_FIELD`）。
 *
 * 存储位置：**只在内存**（每条通道一个模块级闭包变量）。
 *   理由（Phase 1 口径，本单沿用且不扩大）：`src/data/storage.js` 是全工程**唯一**允许直接触碰
 *   浏览器存储的模块，而令牌**不进 `localStorage` / `sessionStorage`** 是硬约束
 *   （减少 XSS 长期驻留面）⇒ 页面刷新即重新取票（已登记为「未覆盖项」）。
 *
 * 时钟：**不在客户端判时效**（本地时间只用于「要不要先取票」的体验判断，不作判据）；
 *   令牌是否过期**一律以云函数回传为准**（过期 ⇒ 服务端 `FORBIDDEN` + 明确文案）。
 */

import { callCloudFunction, setCloudFunctionTransport } from '../data/cloudbaseFn.js'
import { writeFaceMode, WRITE_FACE_MODES } from '../data/writeFaceMode.js'
import { currentUser } from '../data/session.js'

/** 云函数名（**唯一一处定义点**；`adminToken.js` / `userToken.js` 从这里转口）。 */
export const ADMIN_TOKEN_FUNCTION = 'xiai-admin-token'
export const USER_TOKEN_FUNCTION = 'xiai-user-token'

/** 动作字面值（与两个云函数 `index.js` 的 `action` 逐字一致）。 */
export const TOKEN_ACTIONS = Object.freeze({ ISSUE: 'issue', VERIFY: 'verify' })

/** 形态标注（上屏 / 报告用）。 */
export const TOKEN_MODES = Object.freeze({ CLOUD: 'cloud', LOCAL_DEV: 'local-dev' })

/* 兼容别名（Phase 1 的既有导出名；**不得删** —— 既有导入方与 58 条自检在用）。 */
export const ADMIN_TOKEN_ACTIONS = TOKEN_ACTIONS
export const ADMIN_TOKEN_MODES = TOKEN_MODES

/** 不可逆诊断指纹（FNV-1a 32 位十六进制）；**只用于读数，绝不用于判定**。 */
function fingerprint(value) {
  let hash = 0x811c9dc5
  const text = String(value)
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function trimmed(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/**
 * 建一条令牌通道（**同一套机制 / 同一套失败形态**）。
 * @param {{functionName:string, subject:string, candidate?:string}} profile
 *   `functionName` ＝ 云函数名；`subject` ＝ 文案主语（`管理員` / `用戶`）；
 *   `candidate` ＝ dev / 离线形态下「本地角色门」允许的角色候选（管理员通道用；用户通道为空）
 * @returns {object} 通道（方法见下）
 */
export function createTokenChannel(profile) {
  const functionName = profile.functionName
  const subject = profile.subject

  /** 令牌缓存（**内存**；`token` 不对外暴露原文）。 */
  const state = {
    token: '',
    expiresAt: 0,
    ver: '',
    sub: '',
    uid: '',
    issuedAt: 0,
    renewals: 0,
    lastReason: ''
  }

  /** 令牌读数（**不含令牌原文**；只有长度与指纹 ⇒ 可直接进报告 / 日志）。 */
  function snapshot() {
    const remaining = state.token ? Math.max(0, state.expiresAt - nowSeconds()) : 0
    return {
      channel: functionName,
      mode: writeFaceMode(),
      present: state.token !== '',
      /* 体验层判断（**不是判据**）：本地时间粗算的剩余秒数。 */
      remainingSeconds: remaining,
      expiresAt: state.expiresAt,
      issuedAt: state.issuedAt,
      ver: state.ver,
      sub: state.sub,
      /* uid 是**服务端派生结果**（非密钥、非凭据）⇒ 可作读数。 */
      uid: state.uid,
      tokenLength: state.token.length,
      tokenFingerprint: state.token ? fingerprint(state.token) : '',
      slidingRenewals: state.renewals,
      lastReason: state.lastReason
    }
  }

  function present() {
    return state.token !== ''
  }

  /** 清空缓存令牌（登出 / 授权判定失败时调用）。 */
  function clear() {
    state.token = ''
    state.expiresAt = 0
    state.ver = ''
    state.sub = ''
    state.uid = ''
    state.issuedAt = 0
    return snapshot()
  }

  /** 传输层 / 协议层失败（**不得伪装 `FORBIDDEN`**；沿用既有冻结字面值）。 */
  function shapeDenial() {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '雲端校驗回傳形狀不可辨識，無法確認寫入權限；本次零寫入。'
    }
  }

  /**
   * 取票：手机号 + 验证码 ⇒ 短期令牌（**服务端验签是唯一判据 ⇒ 这里只做携带**）。
   * @param {{phone?:string, code?:string}} credentials
   * @returns {Promise<{ok:true, expiresAt:number, ttlSeconds:number, sub:string, uid:string, ver:string,
   *                    serverNow:number, tokenLength:number, tokenFingerprint:string}
   *                  |{ok:false, reason:string, message:string}>}
   */
  async function request(credentials = {}) {
    const reply = await callCloudFunction(functionName, {
      action: TOKEN_ACTIONS.ISSUE,
      phone: trimmed(credentials.phone),
      code: trimmed(credentials.code)
    })
    /* 传输层失败 ⇒ 原样（`STORAGE_UNAVAILABLE`）；业务拒绝 ⇒ 原样透传。 */
    if (!reply.ok) return reply
    const result = reply.result
    /* **服务端结构化拒绝原样透传**（`reason` / `message` 一个都不改写）—— 与 `gate()` 的同一分支
       **逐条同形**：服务端的「业务拒绝」（如签发时手机号 / 验证码不符 ⇒ `FORBIDDEN`）**不是**
       「回传形状不可辨識」⇒ 不得折叠成 `STORAGE_UNAVAILABLE` ＋ `shapeDenial()` 文案（否则真因被
       吞掉、上屏文案变假，且与 `gate()` 对同类回传的处置自相矛盾）。`shapeDenial()` 自此**只**覆盖
       「既非放行、也非结构化拒绝」的真不可辨认形状。 */
    if (result && result.ok === false && typeof result.reason === 'string' && typeof result.message === 'string') {
      state.lastReason = result.reason
      return { ok: false, reason: result.reason, message: result.message }
    }
    if (!result || result.ok !== true || typeof result.token !== 'string' || result.token === '') return shapeDenial()
    state.token = result.token
    state.expiresAt = Number(result.expiresAt) || 0
    state.issuedAt = Number(result.issuedAt) || 0
    state.ver = typeof result.ver === 'string' ? result.ver : ''
    state.sub = typeof result.sub === 'string' ? result.sub : ''
    state.uid = typeof result.uid === 'string' ? result.uid : ''
    state.renewals = 0
    state.lastReason = ''
    return {
      ok: true,
      /* **不回吐令牌原文**（调用方无需它；减少误打印面）。 */
      expiresAt: state.expiresAt,
      ttlSeconds: Number(result.ttlSeconds) || 0,
      sub: state.sub,
      uid: state.uid,
      ver: state.ver,
      serverNow: Number(result.serverNow) || 0,
      tokenLength: state.token.length,
      tokenFingerprint: fingerprint(state.token)
    }
  }

  /**
   * 保证「本次写操作有一枚可携带的令牌」——给页面用的最小入口（云端模式下才需要）。
   * @param {{code?:string, phone?:string}} input 验证码**必要时**才需要（已有未过期令牌 ⇒ 直接复用）
   */
  async function ensureWriteSession(input = {}) {
    if (writeFaceMode() === WRITE_FACE_MODES.LOCAL_DEV) {
      return {
        ok: true,
        mode: TOKEN_MODES.LOCAL_DEV,
        reused: false,
        expiresAt: 0,
        message: 'dev / 離線形態：未經雲端驗簽（**非正式寫入路徑**）。'
      }
    }
    if (state.token !== '' && state.expiresAt - nowSeconds() > 0) {
      return {
        ok: true,
        mode: TOKEN_MODES.CLOUD,
        reused: true,
        expiresAt: state.expiresAt,
        message: '沿用既有令牌（未過期）。'
      }
    }
    const user = currentUser()
    const target = trimmed(input.phone || (user && user.phone) || '')
    const issued = await request({ phone: target, code: input.code })
    if (!issued.ok) return issued
    return {
      ok: true,
      mode: TOKEN_MODES.CLOUD,
      reused: false,
      expiresAt: issued.expiresAt,
      uid: issued.uid,
      message: '已取得寫入令牌。'
    }
  }

  /**
   * 写操作的服务端门：**云端形态下必须由云函数回 `ok:true` 才算过门**。
   * @param {string} op 写操作名（须在云函数的 `OPS` 注册面内）
   * @param {object} payload 载荷（**身份类键由服务端拒**）
   */
  async function gate(op, payload) {
    if (writeFaceMode() === WRITE_FACE_MODES.LOCAL_DEV) {
      /* dev / 离线形态：**没有服务端** ⇒ 本门放行「到服务层自己的判定」为止；
         **明文：这条分支不算授权** —— 调用方仍须跑它自己的本地角色门，
         且本形态**明确标注为非正式写入路径**（见 `writeFaceModeLabel()`）。 */
      return { ok: true, mode: TOKEN_MODES.LOCAL_DEV, dev: true, message: 'dev / 離線形態：未經雲端驗簽。' }
    }
    /* 云端形态：**不预判、不短路** —— 一律把请求交给云函数（前端不产出授权结论）。 */
    const reply = await callCloudFunction(functionName, {
      action: TOKEN_ACTIONS.VERIFY,
      token: state.token,
      op: trimmed(op),
      payload: payload === undefined ? null : payload
    })
    if (!reply.ok) {
      /* 传输层失败 ⇒ `STORAGE_UNAVAILABLE`（**绝不伪装 `FORBIDDEN`**）；令牌**不清**（「未知」≠「无效」）。 */
      state.lastReason = reply.reason
      return reply
    }
    const result = reply.result
    if (result && result.ok === true) {
      /* **滑动续期**：服务端每次校验通过都回吐新令牌 ⇒ 覆盖缓存（只延长时效，不改变权限面）。 */
      if (typeof result.renewedToken === 'string' && result.renewedToken !== '') {
        state.token = result.renewedToken
        state.expiresAt = Number(result.renewedExpiresAt) || state.expiresAt
        state.ver = typeof result.ver === 'string' ? result.ver : state.ver
        state.renewals += 1
      }
      if (result.identity && typeof result.identity.uid === 'string') state.uid = result.identity.uid
      state.lastReason = ''
      return {
        ok: true,
        mode: TOKEN_MODES.CLOUD,
        op: typeof result.op === 'string' ? result.op : trimmed(op),
        value: result.value,
        /* **服务端权威行**（只有「经云端落盘」的 op 才有；本地只做镜像）。 */
        row: result.row,
        /* **服务端公开投影行**（`reviewCorrection` 等带公开投影的 op 才有；逐字采用、不在前端重建）。 */
        projection: result.projection,
        /* **服务端值级公开摘要行**（`submitCorrection` / `endorseCorrection` / `reviewCorrection`）；
           本机只镜像、不在前端重建。 */
        summary: result.summary,
        docId: typeof result.docId === 'string' ? result.docId : '',
        authority: typeof result.authority === 'string' ? result.authority : '',
        uid: result.identity && typeof result.identity.uid === 'string' ? result.identity.uid : '',
        expiresAt: state.expiresAt,
        serverNow: Number(result.serverNow) || 0,
        renewals: state.renewals,
        message: ''
      }
    }
    if (result && result.ok === false && typeof result.reason === 'string' && typeof result.message === 'string') {
      /* **服务端结构化拒绝原样透传**（`reason` / `message` 一个都不改写）。 */
      state.lastReason = result.reason
      if (result.reason === 'FORBIDDEN') clear()
      return { ok: false, reason: result.reason, message: result.message }
    }
    return shapeDenial()
  }

  return { functionName, subject, snapshot, present, clear, request, ensureWriteSession, gate }
}

/* ---------------------------------------------------------------------------
   两条通道（**同一份实现**；只有函数名与文案主语不同）
   --------------------------------------------------------------------------- */

/** 管理员写面通道（Phase 1 已上线口径，逐字沿用）。 */
export const adminTokenChannel = createTokenChannel({ functionName: ADMIN_TOKEN_FUNCTION, subject: '管理員' })

/** 普通用户写面通道（Phase A 新增；机制 / 失败形态与管理员通道**共用同一份实现**）。 */
export const userTokenChannel = createTokenChannel({ functionName: USER_TOKEN_FUNCTION, subject: '用戶' })

/* ---------------------------------------------------------------------------
   传输注入缝（**两条通道共用同一条缝** —— 同一个云函数调用层；离线自检 / 宿主用）
   --------------------------------------------------------------------------- */

/**
 * 注入传输实现（**仅供离线自检 / 宿主**）。
 * @param {null|function(string, object, object): Promise<object>} fn
 */
export function setAdminTokenTransport(fn) {
  setCloudFunctionTransport(fn)
}

/** 同上（用户通道走**同一条**传输缝 ⇒ 不是第二套装载逻辑）。 */
export function setUserTokenTransport(fn) {
  setCloudFunctionTransport(fn)
}

/* ---------------------------------------------------------------------------
   兼容导出（Phase 1 的既有 API 名**逐字保留** ⇒ 既有导入方与 58 条自检零改动）
   --------------------------------------------------------------------------- */

export function adminTokenSnapshot() {
  return adminTokenChannel.snapshot()
}

export function hasAdminToken() {
  return adminTokenChannel.present()
}

export function clearAdminToken() {
  return adminTokenChannel.clear()
}

export function requestAdminToken(phone, code) {
  return adminTokenChannel.request({ phone, code })
}

export function ensureAdminWriteSession(code, phone) {
  return adminTokenChannel.ensureWriteSession({ code, phone })
}

export function adminGate(op, payload) {
  return adminTokenChannel.gate(op, payload)
}

/** 诊断读数（**不含密钥 / 不含令牌原文**）。 */
export function adminTokenStatus() {
  return {
    functionName: ADMIN_TOKEN_FUNCTION,
    mode: writeFaceMode(),
    snapshot: adminTokenChannel.snapshot()
  }
}

/* 用户侧的对应导出（同一套实现；命名与管理员侧对称）。 */

export function userTokenSnapshot() {
  return userTokenChannel.snapshot()
}

export function hasUserToken() {
  return userTokenChannel.present()
}

export function clearUserToken() {
  return userTokenChannel.clear()
}

export function requestUserToken(phone, code) {
  return userTokenChannel.request({ phone, code })
}

export function ensureUserWriteSession(code, phone) {
  return userTokenChannel.ensureWriteSession({ code, phone })
}

export function userGate(op, payload) {
  return userTokenChannel.gate(op, payload)
}

export function userTokenStatus() {
  return {
    functionName: USER_TOKEN_FUNCTION,
    mode: writeFaceMode(),
    snapshot: userTokenChannel.snapshot()
  }
}
