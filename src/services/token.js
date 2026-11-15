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
 * 存储位置（**R-L10 / P3，2026-11-15 起**）：**内存 ＋ 持久化**（每条通道一份）。
 *   · 内存：模块级闭包 `state`（本文件，与改前同一处）；
 *   · 持久化：**键与读写都只在本文件**（`TOKEN_PERSIST_KEYS` 是唯一键表）；真正触碰浏览器存储仍
 *     只经 `src/data/storage.js`（全工程唯一底座）⇒ 落点为 `xiai:v1:user-token` /
 *     `xiai:v1:admin-token`，值恒为 `{token, expiresAt, sub, ver}`；
 *   · 读回**只信形态与本地时效**（坏 JSON / 缺字段 / 已过期 ⇒ **整条丢弃、绝不抛错**），
 *     是否真成立**仍一律以云函数回传为准**（本地读回只省一次取票，不产出任何授权结论）；
 *   · TTL 30 天（**服务端 TTL 由环境变量控制 ⇒ 前端不自作主张放宽**：持久化里的 `expiresAt`
 *     恒以服务端回包为准；每次 `verify` 成功按回包的 `renewedExpiresAt` 滑动续期并回写）；
 *   · 撤销面不变：`XIAI_USER_TOKEN_VERSION` / `XIAI_ADMIN_TOKEN_VERSION` 一改即全体旧令牌失效；
 *     前端遇撤销类拒绝（`FORBIDDEN` / `TOKEN_INVALID` …）⇒ **清持久化 ＋ 引导重新登录**，
 *     **不得**用同一枚令牌无限重试；
 *   · 登出（`services/auth.js::logout`）**清持久化**（`clear()` 是唯一清点）。
 *
 * 时钟：**不在客户端判时效**（本地时间只用于「要不要先取票 / 读回的值是否还值得留」的体验判断，
 *   不作判据）；令牌是否过期**一律以云函数回传为准**（过期 ⇒ 服务端 `FORBIDDEN` + 明确文案）。
 */

import { callCloudFunction, setCloudFunctionTransport } from '../data/cloudbaseFn.js'
/* **R-L10 / P3**：令牌持久化的**唯一**存储通道（`src/data/storage.js` 是全工程唯一底座
   ⇒ 本文件不直接触碰 `window.localStorage`）。`readKey` 对坏 JSON 恒回 `null`（内部 try/catch）。 */
import { readKey, writeKey, removeKey, hasKey } from '../data/storage.js'
import { writeFaceMode, WRITE_FACE_MODES } from '../data/writeFaceMode.js'
import { currentUser } from '../data/session.js'
/* **P1c（管理面收口，2026-11-15）**：管理员通道的签发凭据改為「當前登入會話的平台 `access_token`」
   ⇒ 这里只取**憑證串**（`otpAuth()` 的 `getSession()`），**不打印、不落盤、不上屏**。 */
import { otpSessionAccessToken } from '../data/cloudbaseAuth.js'

/** 云函数名（**唯一一处定义点**；`adminToken.js` / `userToken.js` 从这里转口）。 */
export const ADMIN_TOKEN_FUNCTION = 'xiai-admin-token'
export const USER_TOKEN_FUNCTION = 'xiai-user-token'

/** 动作字面值（与两个云函数 `index.js` 的 `action` 逐字一致）。 */
export const TOKEN_ACTIONS = Object.freeze({ ISSUE: 'issue', VERIFY: 'verify' })

/**
 * **公开写面的 `action` 字面值**（与 `xiai-user-token/index.js` 的 `action === 'public-write'`
 * 分流逐字一致；位置与 `action === 'public'` 同级、在令牌 / 会话 / 配置判定**之前**）。
 *
 * 它与 `TOKEN_ACTIONS` **分开一处**：`issue` / `verify` 是**带令牌的**两态，`public-write`
 * 是**匿名、无令牌、无 `verify` 前置**的第三态 ⇒ 不塞进同一个冻结对象（既有两个收窄分支的键集
 * 逐字不动）。本文件**零 op 名字面值**：op 名由调用方（`services/sealCards.js`）逐字传入。
 */
export const PUBLIC_WRITE_ACTION = 'public-write'

/** 形态标注（上屏 / 报告用）。 */
export const TOKEN_MODES = Object.freeze({ CLOUD: 'cloud', LOCAL_DEV: 'local-dev' })

/**
 * **令牌持久化键表（R-L10 单点定义 —— 全工程只此一处）**。
 *
 * 键值是交给 `src/data/storage.js` 的**命名空间内键名**（真正落点 ＝ `xiai:v1:<键值>`）；
 * 值是 `{token, expiresAt, sub, ver}` 四键信封（**不含 uid / 手机号原文**：`sub` 已是服务端
 * 验签过的手机号，与令牌本体同密级）。
 * 两条通道**各占一个键** ⇒ 管理员令牌不会覆盖用户令牌、反之亦然。
 */
export const TOKEN_PERSIST_KEYS = Object.freeze({
  [USER_TOKEN_FUNCTION]: 'user-token',
  [ADMIN_TOKEN_FUNCTION]: 'admin-token'
})

/**
 * **撤销类 reason**（服务端判「令牌不成立 / 已过期 / 版本已被撤销」时的落点）：
 * 一旦收到，**清内存 ＋ 清持久化 ＋ 引导重新登录**，且**不得**拿同一枚令牌重试。
 * 取值面只收既有冻结字面值（`FORBIDDEN` 是云函数对全部令牌侧失败的统一落点；
 * `TOKEN_INVALID` 系只读会话验签面（`lib/verifySession.js` / `lib/feicuiToken.js`）的同义落点）。
 * **`STORAGE_UNAVAILABLE` 不在表内**：「内部不可用」≠「令牌无效」⇒ 不清任何令牌。
 */
export const TOKEN_REVOKE_REASONS = Object.freeze(['FORBIDDEN', 'TOKEN_INVALID'])

/** 撤销类判定（纯函数、零副作用）。 */
function isRevokeReason(reason) {
  return typeof reason === 'string' && TOKEN_REVOKE_REASONS.indexOf(reason) !== -1
}

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
 * `action:'issue'` 的**默認**入參構造。
 *
 * **P1c（管理面收口，2026-11-15）**：改前的逐字形態是 `{ phone, code }`（`code` ＝ 服務端環境變數裡的
 * 全站固定碼）—— 那等於「任何知道碼的人都能換管理員令牌」⇒ 已作廢。現在**兩條通道同形**：
 * `{ phone, platformAccessToken }`（平台短訊登錄簽發的 `access_token`；服務端拿去驗簽取號，
 * **前端不持有任何固定碼**）。`code` 一概不再出現在任何請求體裡。
 * @param {{phone?:string, platformAccessToken?:string}} credentials
 * @returns {{phone:string, platformAccessToken:string}}
 */
function defaultIssueBody(credentials) {
  return { phone: trimmed(credentials.phone), platformAccessToken: trimmed(credentials.platformAccessToken) }
}

/**
 * 建一条令牌通道（**同一套机制 / 同一套失败形态**）。
 * @param {{functionName:string, subject:string, candidate?:string, persistKey?:string,
 *          issueBody?:(credentials:object)=>{phone:string, platformAccessToken:string},
 *          resolvePlatformSession?:()=>Promise<string>}} profile
 *   `functionName` ＝ 云函数名；`subject` ＝ 文案主语（`管理員` / `用戶`）；
 *   `candidate` ＝ dev / 离线形态下「本地角色门」允许的角色候选（管理员通道用；用户通道为空）；
 *   `issueBody` ＝ `action:'issue'` 的入参构造（**缺省与两条通道一律** `{phone, platformAccessToken}`）；
 *   `resolvePlatformSession` ＝ **凭据兜底取数器**（P1c）：调用方没显式给
 *   `platformAccessToken` 时，就地取「當前登入會話」的平台凭證（管理员通道 ＝ `otpSessionAccessToken`）。
 *   **取不到 ⇒ 结构化拒绝 ＋ 重新登入引导，绝不回退任何固定码**。用户通道不声明它
 *   （登录流程本就拿着刚签下的凭證，P1b 行为逐字不变）。
 *   `persistKey` ＝ **持久化键**（R-L10；缺省按 `TOKEN_PERSIST_KEYS` 由 `functionName` 查出；
 *   空串 ⇒ 该通道不持久化）。
 * @returns {object} 通道（方法见下）
 */
export function createTokenChannel(profile) {
  const functionName = profile.functionName
  const subject = profile.subject
  const issueBodyOf = typeof profile.issueBody === 'function' ? profile.issueBody : defaultIssueBody
  const resolvePlatformSession = typeof profile.resolvePlatformSession === 'function' ? profile.resolvePlatformSession : null
  const persistKey = typeof profile.persistKey === 'string'
    ? profile.persistKey
    : (Object.prototype.hasOwnProperty.call(TOKEN_PERSIST_KEYS, functionName) ? TOKEN_PERSIST_KEYS[functionName] : '')

  /** 令牌缓存（**内存**；`token` 不对外暴露原文）。 */
  const state = {
    token: '',
    expiresAt: 0,
    ver: '',
    sub: '',
    uid: '',
    issuedAt: 0,
    renewals: 0,
    lastReason: '',
    /* 本次进程是否已尝试过读回（**只读一次**：读回失败也记为已读 ⇒ 不反复打存储）。 */
    restored: false,
    /* 当前这枚令牌是否来自持久化读回（诊断读数用，**不作判据**）。 */
    restoredFromStorage: false
  }

  /**
   * **持久化回写**（R-L10）：`{token, expiresAt, sub, ver}` 四键信封。
   * **恒不抛**（`storage.js::writeKey` 内部 try/catch）—— 持久化失败等于「下次刷新要重新取票」，
   * 属**降级**而非错误，故不改变任何调用方语义。
   * @returns {boolean} 是否写成功（`false` ⇒ 本次仅内存）
   */
  function persistNow() {
    if (persistKey === '' || state.token === '') return false
    return writeKey(persistKey, {
      token: state.token,
      expiresAt: Math.floor(state.expiresAt),
      sub: state.sub,
      ver: state.ver
    })
  }

  /**
   * **读回持久化令牌**（R-L10；本进程只尝试一次）。
   *
   * 校验四件事，任一不成立即**整条丢弃并删键**（**绝不抛错** —— 坏数据只等于「没有令牌」）：
   *   ① 形态：值必须是普通对象（数组 / 标量 / 坏 JSON ⇒ `storage.js::readKey` 回 `null`）；
   *   ② `token` 必须是非空字符串；
   *   ③ `expiresAt` 必须是有限数字且**尚未过期**（本地时间只在体验层，判据仍是服务端）；
   *   ④ `sub` / `ver` 只在是字符串时采纳（缺省为空串 —— 不猜、不补）。
   * 读回**不产出任何授权结论**：过门仍必须由云函数回 `ok:true`。
   */
  function restoreOnce() {
    if (state.restored) return
    state.restored = true
    if (persistKey === '') return
    /* 内存里已有令牌（同进程刚签发过）⇒ 持久化不会更权威，跳过读回。 */
    if (state.token !== '') return
    const stored = readKey(persistKey)
    if (stored === null || stored === undefined) {
      /* `readKey` 对**坏 JSON** 与**键不存在**都回 `null` ⇒ 用 `hasKey` 区分：
         键在、内容不可解析 ⇒ **当场删掉**（垃圾不留；等于「无令牌」）。 */
      if (hasKey(persistKey)) removeKey(persistKey)
      return
    }
    if (typeof stored !== 'object' || Array.isArray(stored)) {
      removeKey(persistKey)
      return
    }
    const token = typeof stored.token === 'string' ? stored.token.trim() : ''
    const expiresAt = Number(stored.expiresAt)
    const sub = typeof stored.sub === 'string' ? stored.sub : ''
    const ver = typeof stored.ver === 'string' ? stored.ver : ''
    const usable = token !== '' && Number.isFinite(expiresAt) && Math.floor(expiresAt) > nowSeconds()
    if (!usable) {
      removeKey(persistKey)
      return
    }
    state.token = token
    state.expiresAt = Math.floor(expiresAt)
    state.sub = sub
    state.ver = ver
    state.restoredFromStorage = true
  }

  /** 令牌读数（**不含令牌原文**；只有长度与指纹 ⇒ 可直接进报告 / 日志）。 */
  function snapshot() {
    restoreOnce()
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
      lastReason: state.lastReason,
      /* **持久化面（R-L10 读数）**：是否有持久化键 / 本枚令牌是否读回自持久化。 */
      persisted: persistKey !== '',
      restoredFromStorage: state.restoredFromStorage
    }
  }

  function present() {
    restoreOnce()
    return state.token !== ''
  }

  /**
   * 清空令牌（**内存 ＋ 持久化**；登出 / 撤销类拒绝时调用 —— 本函数是全文件唯一的清点）。
   */
  function clear() {
    state.token = ''
    state.expiresAt = 0
    state.ver = ''
    state.sub = ''
    state.uid = ''
    state.issuedAt = 0
    state.restoredFromStorage = false
    /* 持久化同清（**登出/撤销后不得留任何可复用凭据**）；`removeKey` 恒不抛。 */
    if (persistKey !== '') removeKey(persistKey)
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
   * 取票：手机号 + 凭据 ⇒ 短期令牌（**服务端验签是唯一判据 ⇒ 这里只做携带**）。
   *
   * 凭据形态**按通道**（`issueBodyOf`）：**P1c 起两条通道同形** ——
   * `{ phone, platformAccessToken }`（平台原生会话的 `access_token`；**不再有任何固定码**）。
   * 通道声明了 `resolvePlatformSession` 且调用方没给凭据 ⇒ 就地取当前会话凭證；
   * 取不到 ⇒ **结构化拒绝 ＋ 重新登入引导**（**零请求、零固定码回退**）。
   * @param {{phone?:string, platformAccessToken?:string}} credentials
   * @returns {Promise<{ok:true, expiresAt:number, ttlSeconds:number, sub:string, uid:string, ver:string,
   *                    serverNow:number, tokenLength:number, tokenFingerprint:string}
   *                  |{ok:false, reason:string, message:string}>}
   */
  async function request(credentials = {}) {
    const source = credentials && typeof credentials === 'object' ? credentials : {}
    const body = issueBodyOf(source)
    if (resolvePlatformSession && trimmed(body.platformAccessToken) === '') {
      /* **凭据兜底**：只取「當前登入會話」的凭證；取不到就拒绝（**不發請求、不回退固定碼**）。 */
      let resolved = ''
      try {
        resolved = await resolvePlatformSession()
      } catch {
        resolved = ''
      }
      if (trimmed(resolved) === '') {
        return {
          ok: false,
          reason: 'FORBIDDEN',
          message: `未取得平台登入會話，無法換取${subject}令牌；請以手機號＋短訊驗證碼重新登入後再試；本次零寫入。`
        }
      }
      body.platformAccessToken = trimmed(resolved)
    }
    const reply = await callCloudFunction(functionName, {
      action: TOKEN_ACTIONS.ISSUE,
      ...body
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
    state.restoredFromStorage = false
    /* **R-L10**：签发成功即回写持久化（下次刷新免重登）；写失败只降级、不影响本次结果。 */
    persistNow()
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
   * @param {{phone?:string, platformAccessToken?:string}} input
   *   凭据**必要時**才需要（已有未过期令牌 ⇒ 直接复用）；形态按通道（`issueBodyOf`）。
   *   **P1c 起没有任何 `code` 入参**（固定码已退出授权判定）。
   */
  async function ensureWriteSession(input = {}) {
    /* **R-L10**：先尝试读回持久化令牌（失败/过期/坏数据 ⇒ 视为无令牌，继续走取票）。 */
    restoreOnce()
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
    /* **P1c**：只带 `{ phone, platformAccessToken }`；没带凭證时由通道的 `resolvePlatformSession` 兜底。 */
    const issued = await request({ phone: target, platformAccessToken: input.platformAccessToken })
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
   * @param {{readoutKeys?:Array<string>, timeoutMs?:number}} [options] **additive 透传声明（本單「我的 API」新增）**：
   *   `readoutKeys` ＝ 调用方**逐字声明**的回包读数键面（如 AI 金鑰 / 用量 / 上游配置面的
   *   `key` / `rows` / `points` / `today` / `minute` / `key_mask` …）。本函数**只按声明的键名**
   *   把「云函数回包（`result`）**确有**的键」逐字叠进出参；未声明 ⇒ 行为逐字不变，
   *   **其余任何 op 一律不出现这些键**（与 `pullImportRows` / review 两段收窄透传同族口径）。
   *   **本文件不含任何 op 名字面值**（鍵面真源 ＝ `src/services/aiAccess.js`）。
   *   `timeoutMs` ＝ **按 op 放宽超时的唯一通道**（本單「超時預算」）：调用方逐字声明本次云函数
   *   调用的总预算（毫秒）；**未声明 ⇒ 传 `undefined` ⇒ `callCloudFunction` 内部回落全局默认
   *   `CLOUD_FUNCTION_TIMEOUT_MS`（15000 ms，本單逐字不改）** —— 全局默认不变，只有显式
   *   声明的 op（如 `ai-enhance-face`）才拿到更长预算；本文件不硬编码任何 op 的超时数字。
   */
  async function gate(op, payload, options) {
    if (writeFaceMode() === WRITE_FACE_MODES.LOCAL_DEV) {
      /* dev / 离线形态：**没有服务端** ⇒ 本门放行「到服务层自己的判定」为止；
         **明文：这条分支不算授权** —— 调用方仍须跑它自己的本地角色门，
         且本形态**明确标注为非正式写入路径**（见 `writeFaceModeLabel()`）。 */
      return { ok: true, mode: TOKEN_MODES.LOCAL_DEV, dev: true, message: 'dev / 離線形態：未經雲端驗簽。' }
    }
    /* **R-L10**：云端形态先尝试读回持久化令牌（刷新后免重登）；读回的值只当「待验令牌」，
       过门仍必须由云函数回 `ok:true`。 */
    restoreOnce()
    /* 云端形态：**不预判、不短路** —— 一律把请求交给云函数（前端不产出授权结论）。
       **超时透传（本單「超時預算」）**：`options.timeoutMs` 逐字下传 —— 这是「按 op 放宽超时」
       的**唯一通道**；未传 ⇒ `undefined` ⇒ `callCloudFunction` 内部回落全局默认 15000 ms
       （既有行为逐字不变；全局默认 `CLOUD_FUNCTION_TIMEOUT_MS` 本單不改）。 */
    const reply = await callCloudFunction(functionName, {
      action: TOKEN_ACTIONS.VERIFY,
      token: state.token,
      op: trimmed(op),
      payload: payload === undefined ? null : payload
    }, { timeoutMs: options && options.timeoutMs })
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
        state.restoredFromStorage = false
      } else if (Number.isFinite(Number(result.renewedExpiresAt)) && Number(result.renewedExpiresAt) > state.expiresAt) {
        /* 极端兼容：服务端只回了新时效（未回新令牌）⇒ **只往后延**，绝不由前端自行放宽。 */
        state.expiresAt = Math.floor(Number(result.renewedExpiresAt))
      }
      /* **R-L10**：续期成功后**回写持久化**（TTL 恒以服务端回包为准 —— 前端不自行放宽）。 */
      if (state.token !== '') persistNow()
      if (result.identity && typeof result.identity.uid === 'string') state.uid = result.identity.uid
      state.lastReason = ''
      const envelope = {
        ok: true,
        mode: TOKEN_MODES.CLOUD,
        op: typeof result.op === 'string' ? result.op : trimmed(op),
        value: result.value,
        /* **回讀驗證面（本单）**：`registerArtifact` 的分组回读结果
           （`{sha256,bytesLength,mime,storageKey,idempotent}`）原样上抛（逐字、本文件不改写）。 */
        artifact: result.artifact,
        /* **服务端权威行**（只有「经云端落盘」的 op 才有；本地只做镜像）。 */
        row: result.row,
        /* **服务端公开投影行**（`reviewCorrection` 等带公开投影的 op 才有；逐字采用、不在前端重建）。 */
        projection: result.projection,
        /* **服务端值级公开摘要行**（`submitCorrection` / `endorseCorrection` / `reviewCorrection`）；
           本机只镜像、不在前端重建。 */
        summary: result.summary,
        /* 【本单｜展示件读数】`ensureDisplayArtifact` 的 `display` 分组
           （`{sha256,displayKey,bytesLength,width,height}`）原样上抛（逐字、本文件不改写）——
           与 `index.js` 信封的 display 透传**逐字同构**；服务端未回 `display` ⇒ 此键为
           `undefined`（**不编造分组、不派生假读数**；就地派生属调用方职责面，不属门）。 */
        display: result.display,
        docId: typeof result.docId === 'string' ? result.docId : '',
        authority: typeof result.authority === 'string' ? result.authority : '',
        uid: result.identity && typeof result.identity.uid === 'string' ? result.identity.uid : '',
        expiresAt: state.expiresAt,
        serverNow: Number(result.serverNow) || 0,
        renewals: state.renewals,
        message: ''
      }
      /* **只读行面（additive 透传｜**按 `op` 收窄**｜E-3 ＋ 勘误只读面）**：`rows` / `count` **仅当
         `op` ∈ 三只读取行 op（`pullImportRows` ／ `listMyCorrections` ／ `listPendingCorrectionsForAdmin`）
         且云函数回包（`result`）确有该键时**才逐字叠进出参；
         服务端未回 ⇒ 本键**缺席**（调用方读到 `undefined`），**不得默认成 `[]` / `0`**。
         其余任何 op 一律不出现这 2 个键（既有回包逐字不变）。 */
      if (trimmed(op) === 'pullImportRows' || trimmed(op) === 'listMyCorrections' || trimmed(op) === 'listPendingCorrectionsForAdmin') {
        const PULL_READOUT_KEYS = ['rows', 'count']
        for (const key of PULL_READOUT_KEYS) {
          if (Object.prototype.hasOwnProperty.call(result, key)) envelope[key] = result[key]
        }
      }
      /* **審核計數面（additive 透传｜**按 `op` 收窄**｜E-4）**：`accepted_ids` / `rejected_ids` /
         `skipped` / `failed` / `done` / `remaining` **仅当 `op` ∈ 三 review op 且云函数回包确有该键时**
         才逐字透传给服务层（`{seals,persons,items}.js` 与视图循环推进据此报数 / 推进）；
         **键名 / 值逐字不改写、不编造分组、不派生假读数**（`remaining` 读失败时云函数**不放该键**
         ⇒ 这里同样缺席 ⇒ 调用方读到 `undefined`，**绝不填 `0` 冒充**）。
         其余任何 op 一律不出现这 6 个键（既有回包逐字不变）—— 与云函数 `index.js` 的收窄面**逐条同形**。 */
      if (trimmed(op) === 'reviewPersonImport' || trimmed(op) === 'reviewSealImport' || trimmed(op) === 'reviewItemImport') {
        const IMPORT_REVIEW_READOUT_KEYS = ['accepted_ids', 'rejected_ids', 'skipped', 'failed', 'done', 'remaining']
        for (const key of IMPORT_REVIEW_READOUT_KEYS) {
          if (Object.prototype.hasOwnProperty.call(result, key)) envelope[key] = result[key]
        }
      }
      /* **調用方聲明的讀數面（additive 透傳｜按聲明收窄｜本單「我的 API」）**：只把
         `options.readoutKeys` 里**云函数回包确有的键**逐字叠进出参（键名 / 值一个都不改写、
         不编造、不派生）；未声明 ⇒ 本段零行为（既有回包逐字不变）。**本文件零 op 名字面值**
         —— 键面真源 ＝ `src/services/aiAccess.js`（唯一业务入口）。 */
      const declaredReadouts = options && Array.isArray(options.readoutKeys) ? options.readoutKeys : []
      for (const readoutKey of declaredReadouts) {
        if (Object.prototype.hasOwnProperty.call(result, readoutKey)) envelope[readoutKey] = result[readoutKey]
      }
      return envelope
    }
    if (result && result.ok === false && typeof result.reason === 'string' && typeof result.message === 'string') {
      /* **服务端结构化拒绝原样透传**（`reason` / `message` 一个都不改写）。 */
      state.lastReason = result.reason
      /* **撤销面（R-L10 第 3 条）**：`FORBIDDEN` / `TOKEN_INVALID` ⇒ **内存 ＋ 持久化全清**
         （`clear()` 是唯一清点）⇒ 下一次写会因「无令牌」被 `ensureUserTokenForWrite` 结构性拒绝，
         **不会**拿同一枚废令牌无限重试。`STORAGE_UNAVAILABLE`（内部不可用）**不清**。 */
      if (isRevokeReason(result.reason)) clear()
      const denial = { ok: false, reason: result.reason, message: result.message }
      /* **`refunded` additive 透传（本单「人工智能修復」）**：失败回包**确有该键**（布尔）才逐字
         叠出 —— 退费与否只由服务端说了算（如 `ai-enhance-face` 的失败回包带 `refunded`）。
         服务端未回该键 ⇒ 本键缺席（调用方读到 `undefined`），**既有任何 op 的失败回包逐字不变**
         （与 `rows` / `count`、`readoutKeys` 的 additive 口径同族；本文件仍零 op 名字面值）。 */
      if (typeof result.refunded === 'boolean') denial.refunded = result.refunded
      return denial
    }
    return shapeDenial()
  }

  /**
   * **公開寫面（`action:'public-write'`）的收窄信封**（与 `gate()` **同形**：同一套失败形态、
   * 同一套「服务端原话透传」口径；**无令牌、无 `verify` 前置、无滑动续期**）。
   *
   * 为什么另立一条而不是复用 `gate()`：`gate()` 恒发 `action:'verify'` ＋ 携带 `token`，
   * 而公开写面**匿名**（也**不得**携带任何令牌面）。硬口径逐条照搬：
   *   · 传输层失败 ⇒ **原样**（`data/cloudbaseFn.js` 的 `STORAGE_UNAVAILABLE`），**不**伪装 `FORBIDDEN`；
   *     令牌**不动**（未参与本次调用）；
   *   · 服务端结构化拒绝（`ok:false` ＋ `reason`/`message` 双串）⇒ **原样透传**，一个字都不改写；
   *   · 成功 ⇒ **按 op 收窄**：公开写面白名单只有一只 op（`bumpSealView`），其成功回包**恰 1 键**
   *     `ok:true` ⇒ 本分支只回 `{ok, mode, op}`，**不派生任何假读数**（不编造 `value` / `row`）；
   *   · 既非放行也非结构化拒绝 ⇒ `shapeDenial()`（与 `gate()` 同一处、**不新增文案**）。
   *
   * @param {string} op 公开写 op 名（须在云函数 `PUBLIC_WRITE_OPS` 白名单内；本文件零 op 名字面值）
   * @param {object} payload 载荷（**封闭键面由 op 侧定**；本函數原樣下傳、不增删键）
   * @returns {Promise<{ok:true, mode:string, op:string}
   *                  |{ok:false, reason:string, message:string}>}
   */
  async function publicWrite(op, payload) {
    const opName = trimmed(op)
    const reply = await callCloudFunction(functionName, {
      action: PUBLIC_WRITE_ACTION,
      op: opName,
      payload: payload === undefined ? null : payload
    })
    if (!reply.ok) {
      /* 传输层失败 ⇒ `STORAGE_UNAVAILABLE`（**绝不伪装 `FORBIDDEN`**）。 */
      state.lastReason = reply.reason
      return reply
    }
    const result = reply.result
    if (result && result.ok === true) {
      state.lastReason = ''
      return { ok: true, mode: TOKEN_MODES.CLOUD, op: opName }
    }
    if (result && result.ok === false && typeof result.reason === 'string' && typeof result.message === 'string') {
      /* **服务端结构化拒绝原样透传**（`reason` / `message` 一个都不改写；不清令牌 —— 本次未用到令牌）。 */
      state.lastReason = result.reason
      return { ok: false, reason: result.reason, message: result.message }
    }
    return shapeDenial()
  }

  return { functionName, subject, snapshot, present, clear, request, ensureWriteSession, gate, publicWrite }
}

/* ---------------------------------------------------------------------------
   两条通道（**同一份实现**；只有函数名与文案主语不同）
   --------------------------------------------------------------------------- */

/**
 * 管理员写面通道。
 *
 * **P1c（管理面收口，2026-11-15）**：`issue` 入参由 `{phone, code}`（全站固定码）改为
 * `{ phone, platformAccessToken }` —— 与用户通道**同形、同判据**（服务端验签取号 ＋ 白名单）；
 * 没显式给凭證时经 `resolvePlatformSession`（＝ `otpSessionAccessToken`）取**當前登入會話**的
 * 平台 `access_token`；取不到 ⇒ 结构化拒绝 ＋ 重新登入引导（**零固定码回退**）。
 */
export const adminTokenChannel = createTokenChannel({
  functionName: ADMIN_TOKEN_FUNCTION,
  subject: '管理員',
  resolvePlatformSession: otpSessionAccessToken,
  issueBody: (credentials) => ({
    phone: trimmed(credentials.phone),
    platformAccessToken: trimmed(credentials.platformAccessToken)
  })
})

/**
 * 普通用户写面通道（Phase A 新增；机制 / 失败形态与管理员通道**共用同一份实现**）。
 *
 * **冻结契约 R-L1（P1b）**：`xiai-user-token` 的 `action:'issue'` 入参改为
 * `{ phone, platformAccessToken }`（**不再收 `code`**：驗證碼驗在平台側，服務端只認平台簽發的令牌）。
 * **P1c 起管理员通道同形**（同一份 `issueBody`、同一判据）；两条通道的差别只剩
 * 函数名 / 文案主语，以及管理员通道多一个「凭據兜底取數器」（`resolvePlatformSession`）。
 */
export const userTokenChannel = createTokenChannel({
  functionName: USER_TOKEN_FUNCTION,
  subject: '用戶',
  issueBody: (credentials) => ({
    phone: trimmed(credentials.phone),
    platformAccessToken: trimmed(credentials.platformAccessToken)
  })
})

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

/**
 * 取管理员令牌（**P1c**：`issue` 收 `{phone, platformAccessToken}`；**不再有 `code`**）。
 * @param {string} phone 手機號
 * @param {string} [platformAccessToken] 平台會話凭證；**省略 ⇒ 自動取當前登入會話的凭證**
 */
export function requestAdminToken(phone, platformAccessToken) {
  return adminTokenChannel.request({ phone, platformAccessToken })
}

/**
 * 保证管理员写面有令牌（**P1c：入参只剩手機號** —— 校驗碼入参已撤除）。
 * @param {string} [phone] 手機號（省略 ⇒ 取本地會話裡的當前用戶號）
 */
export function ensureAdminWriteSession(phone) {
  return adminTokenChannel.ensureWriteSession({ phone })
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

/**
 * 取用户令牌（**冻结契约 R-L1**：`issue` 收 `{phone, platformAccessToken}`）。
 * @param {string} phone 手機號
 * @param {string} platformAccessToken 平台原生會話的 `access_token`（**憑證，不打印、不落盤**）
 */
export function requestUserToken(phone, platformAccessToken) {
  return userTokenChannel.request({ phone, platformAccessToken })
}

/**
 * 保证用户写面有令牌（**位置参数顺序同族于管理员侧**：凭据在前、手机号在后）。
 * @param {string} platformAccessToken 平台原生會話的 `access_token`
 * @param {string} phone 手機號
 */
export function ensureUserWriteSession(platformAccessToken, phone) {
  return userTokenChannel.ensureWriteSession({ platformAccessToken, phone })
}

export function userGate(op, payload, options) {
  /* `options`（如 `readoutKeys` 的 additive 透傳聲明）**原樣透傳**給通道 —— 漏掉第三參會讓
     調用方（`aiAccess.js`）声明的讀數面被靜默丟掉（鍵名在、值恆 undefined）。 */
  return userTokenChannel.gate(op, payload, options)
}

/**
 * **公开写面入口（匿名）**：`{action:'public-write', op, payload}` ⇒ 收窄信封。
 *
 * 只走**用户侧通道**（`xiai-user-token`）—— 公开写面挂在用户云函数上，管理员云函数**没有**这条分流
 * （越界即被服务端按未知 `action` 拒）。调用方是 `services/sealCards.js::bumpSealView`。
 * @param {string} op 公开写 op 名（白名单内）
 * @param {object} [payload] 载荷（封闭键面由 op 侧定）
 */
export function publicWrite(op, payload) {
  return userTokenChannel.publicWrite(op, payload)
}

export function userTokenStatus() {
  return {
    functionName: USER_TOKEN_FUNCTION,
    mode: writeFaceMode(),
    snapshot: userTokenChannel.snapshot()
  }
}
