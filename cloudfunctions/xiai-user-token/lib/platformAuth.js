'use strict'
/**
 * 玺爱 · 用户令牌 · **平台会话验签（服务端权威取手机号）**
 * ============================================================================
 * 契约来源：**Zang 裁定 R-L1（冻结，2026-11-15）**
 *   `issue` 入参由 `{phone, code}` 改为 `{phone, platformAccessToken}`；服务端**不信客户端自报**，
 *   而是拿云开发平台的 `access_token` 去平台 auth 端点换回**该会话的真实手机号**，与客户端声明的
 *   手机号**双向一致**才签 xiai 令牌。⇒ 客户端无法冒充任意手机号（含管理员白名单号）。
 *
 * 判定链（逐条，与裁定逐字对应）：
 *   ① `GET https://<envId>.<region>.tcb-api.tencentcloudapi.com/auth/v1/user/me?client_id=<envId>`
 *      （`envId` 由 `lib/config.js::readEnvId` 读；`region` 由 **R-L9** 区域参数化给出
 *      —— `lib/config.js::readAuthRegion` 读 `XIAI_AUTH_REGION` / 回退 `TCB_REGION` / 默认
 *      `ap-shanghai`；**两者都不写死**）；
 *      ⇒ **必须是 GET**：该端点只实现 GET；2026-11-15 实测「以 POST 并显式声明零长度请求体」
 *      会回 HTTP 501 `{"code":"UNIMPLEMENTED"}`（被误判成内部不可用）。故一律 GET，
 *      且**不再发送任何长度头**；
 *   ② 请求头 `Authorization: Bearer <platformAccessToken>`（**只进请求头，绝不进日志 / 回包**）；
 *   ③ 从回体取 `phone_number`（形态可能带 `+86 ` 前缀与空格）⇒ 归一为 11 位大陆手机号；
 *   ④ 由调用方（`index.js::handleIssue`）与服务端 `normalizePhone(event.phone)` **严格相等**才继续。
 *
 * 硬口径（逐条）：
 *  · **纯函数 / 绝不自抛**：一切失败返回 `{ok:false, detail:'<内部判别码>'}`；`detail` 只在函数
 *    内部与日志里用，**绝不原样回客户端**（对外仍是冻结的 `FORBIDDEN` / `STORAGE_UNAVAILABLE`）。
 *  · **回体带 `code` 且 HTTP 200 也是失败**：平台对无效凭证回 **HTTP 200 ＋** `{"code":"INVALID_ACCESS_TOKEN"}`
 *    （2026-11-15 实测，命令见交付报告）⇒ 必须当成「判否」，**不得当成成功、也不得抛异常**。
 *  · **凭证无效 ≠ 内部不可用**：平台明确判凭证无效族 ⇒ `PLATFORM_AUTH_REJECTED`（由调用方映射
 *    `FORBIDDEN`）；网络 / 超时 / 5xx / 未知错误码（如 `INVALID_ENV`）/ 回体不可解 ⇒
 *    `PLATFORM_UNAVAILABLE`（由调用方映射 `STORAGE_UNAVAILABLE`）。**绝不把内部故障说成「号或码不对」**。
 *  · **零密钥**：本模块不含任何密钥字面值，也不向平台出示任何 secret（`client_id` 即 envId；
 *    2026-11-15 探针已证实该端点无 secret 需求）。
 *  · **零日志**：本模块**不打印任何东西**（含错误对象）；判别码由调用方按既有审计字段落点。
 *  · **零依赖**：只用 Node 内置 `https`（云函数运行时不保证 `fetch`，也不引第三方 http 库）。
 *  · **区域参数化（R-L9，2026-11-15）**：host 只由 `AUTH_HOST_SUFFIX`（唯一域名常量）＋
 *    `envId` ＋ `region` 拼出；区域来自环境变量，默认 `ap-shanghai`。**区域不是判定输入**
 *    （它只决定打到哪个区域的 auth 端点）⇒ 合法性的唯一后果是「换到了本环境所在的区域」。
 */

const https = require('https')

/**
 * 平台 auth 端点**域名后缀（不含区域、不含 envId）** —— **R-L9 区域参数化**（2026-11-15）。
 * host 恒由 `envId` ＋ `region` ＋ 本常量三段拼出（本常量是**唯一**的域名常量；
 * `authHostOf` 是**唯一**的拼接点）—— envId / region 都不写死。
 */
const AUTH_HOST_SUFFIX = '.tcb-api.tencentcloudapi.com'

/** 区域**默认值**（＝参数化之前硬编码的生产区域 ⇒ 不配环境变量时行为逐字等价）。 */
const DEFAULT_REGION = 'ap-shanghai'

/** 区域候选环境变量（按序取第一个非空、形态成立的；**只影响 host 拼接，不参与任何判定**）。 */
const REGION_ENV_NAMES = Object.freeze(['XIAI_AUTH_REGION', 'TCB_REGION'])

/** 区域形态（小写字母 / 数字 / 连字符；**不含点与斜杠** ⇒ 拼不出别的域）。 */
const REGION_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 取「本人会话」的路径（契约逐字）。 */
const ME_PATH = '/auth/v1/user/me'

/** 默认超时（毫秒）：平台 auth 端点在区域内，2 s 足够；超时 ⇒ `PLATFORM_UNAVAILABLE`。 */
const DEFAULT_TIMEOUT_MS = 2000

/** envId 形态（小写字母 / 数字 / 连字符；**不含点与斜杠** ⇒ 不可能拼出别的域）。 */
const ENV_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/

/** 大陆手机号形态（与 `lib/config.js::PHONE_PATTERN` **逐字同正则**）。 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/

/**
 * 内部判别码（**只在函数内部 / 日志里出现**，取值面封闭；新增值须同轮登记）。
 */
const DETAILS = Object.freeze({
  /** 服务端 evnId 缺失 / 形态非法 ⇒ 内部配置故障（**不是**凭证问题）。 */
  ENV_MISSING: 'PLATFORM_ENV_MISSING',
  /** 凭证字面为空 ⇒ 等价「无凭证」（调用方前置门已拦，此处为纵深防御）。 */
  TOKEN_MISSING: 'PLATFORM_TOKEN_MISSING',
  /** 平台**明确**判该凭证不成立（无效 / 过期 / 未认证）。 */
  AUTH_REJECTED: 'PLATFORM_AUTH_REJECTED',
  /** 凭证成立但回体里没有手机号（或形态不成立）⇒ 无法确认归属 ⇒ 判否（**不放行**）。 */
  PHONE_MISSING: 'PLATFORM_PHONE_MISSING',
  /** 网络 / 超时 / 非零状态 / 未知错误码 / 回体不可解 ⇒ 内部不可用。 */
  UNAVAILABLE: 'PLATFORM_UNAVAILABLE',
  /** 区域参数形态不成立（R-L9；显式传入的 `region` 非法）⇒ 内部配置故障（**不是**凭证问题）。 */
  REGION_INVALID: 'PLATFORM_REGION_INVALID'
})

/**
 * 平台回体里**表示「凭证不成立」的错误码族**（只认逐字值，**不做文本匹配**）。
 * 说明：`UNAUTHENTICATED` 是「未带 Authorization」时（HTTP 401）的回体码；
 * `INVALID_ACCESS_TOKEN` 是「带了但无效」时（HTTP 200）的回体码 —— 两者都由本模块统一归口。
 */
const AUTH_FAILURE_CODES = Object.freeze([
  'INVALID_ACCESS_TOKEN',
  'UNAUTHENTICATED',
  'ACCESS_TOKEN_EXPIRED',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'UNAUTHORIZED',
  'PERMISSION_DENIED'
])

/**
 * 手机号归一（**契约第 ③ 步**）：去掉一切非数字、去掉 `+86` / `86` 国家码，只留 11 位。
 * 不做任何「猜格式」（如补零、改首位、容忍 10 位）；形态不成立 ⇒ 回空串。
 * @param {*} value 平台回体里的 `phone_number`（可能带 `+86 ` 与空格）
 * @returns {string} 11 位大陆手机号；不合格 ⇒ `''`
 */
function normalizePlatformPhone(value) {
  const digits = String(value === undefined || value === null ? '' : value).replace(/[^0-9]/g, '')
  if (digits.length === 13 && digits.startsWith('86')) return PHONE_PATTERN.test(digits.slice(2)) ? digits.slice(2) : ''
  if (digits.length === 11 && PHONE_PATTERN.test(digits)) return digits
  return ''
}

/** 手机号形态判定（归一后逐个匹配；**不猜格式**）。 */
function isMainlandPhone(value) {
  return PHONE_PATTERN.test(normalizePlatformPhone(value))
}

/**
 * 平台回体里的手机号字段（**主字段＝契约逐字 `phone_number`**）。
 * 兼容候选只在「同一已验签回体」内换键名（平台 SDK / 版本漂移），**不改变权威性**：
 * 无论取到哪个键，都是平台按已验签的 `access_token` 回给**该会话本人**的号。
 * @param {object} body 平台回体（已 JSON 解析）
 * @returns {string} 原样字段值（未归一）；取不到 ⇒ `''`
 */
function pickPhoneNumber(body) {
  if (!body || typeof body !== 'object') return ''
  const candidates = [
    body.phone_number,
    body.phoneNumber,
    body.phone,
    body.user && body.user.phone_number,
    body.user && body.user.phoneNumber,
    body.data && body.data.phone_number
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return ''
}

/**
 * 默认传输（Node 内置 `https`）：**纯 I/O、不自抛**，一切异常收敛成 `{ok:false}`。
 * @param {{url:string, method:string, headers:object, timeoutMs:number}} request
 * @returns {Promise<{ok:true, status:number, body:any}|{ok:false, detail:string}>}
 */
function httpsJsonRequest(request) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let req = null
    try {
      req = https.request(
        request.url,
        { method: request.method, headers: request.headers },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            let body = null
            try {
              body = raw === '' ? null : JSON.parse(raw)
            } catch {
              /* 回体不是 JSON（网关 HTML / 空回体）⇒ 交调用方按「不可用」处理。 */
              settle({ ok: false, detail: DETAILS.UNAVAILABLE })
              return
            }
            settle({ ok: true, status: res.statusCode || 0, body })
          })
          res.on('error', () => settle({ ok: false, detail: DETAILS.UNAVAILABLE }))
        }
      )
      req.setTimeout(request.timeoutMs, () => {
        try {
          req.destroy()
        } catch {
          /* 已毁则不重复处置 */
        }
        settle({ ok: false, detail: DETAILS.UNAVAILABLE })
      })
      req.on('error', () => settle({ ok: false, detail: DETAILS.UNAVAILABLE }))
      req.end()
    } catch {
      try {
        if (req) req.destroy()
      } catch {
        /* 忽略 */
      }
      settle({ ok: false, detail: DETAILS.UNAVAILABLE })
    }
  })
}

/**
 * **区域解析（R-L9）**：按序读 `XIAI_AUTH_REGION` → 回退 `TCB_REGION` → 默认 `DEFAULT_REGION`。
 *
 * 形态不成立（带点 / 斜杠 / 大写以外怪字符 …）⇒ **跳过该候选**，最终回落默认值 ——
 * **绝不**把不合格串拼进 host（宁可回落既有生产区域，也不拼出一个陌生域）。
 * **纯函数、零 I/O、绝不自抛**。
 * @param {object} [env] 环境（缺省 `process.env`；自测可注入）
 * @returns {string} 区域（恒为非空且形态成立）
 */
function resolveAuthRegion(env) {
  const source = env && typeof env === 'object' ? env : (typeof process !== 'undefined' ? process.env : {}) || {}
  for (const name of REGION_ENV_NAMES) {
    const raw = source[name]
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (value === '') continue
    if (REGION_PATTERN.test(value)) return value
  }
  return DEFAULT_REGION
}

/**
 * **host 拼接（单点）**：`<envId>.<region><AUTH_HOST_SUFFIX>` —— 不含协议、不含路径。
 * 两个入参在调用前均已过各自形态门（`ENV_ID_PATTERN` / `REGION_PATTERN`）。
 * @param {string} envId 运行期环境 Id
 * @param {string} region 区域
 * @returns {string} host
 */
function authHostOf(envId, region) {
  return `${envId}.${region}${AUTH_HOST_SUFFIX}`
}

/**
 * **区域的唯一取值入口**：显式 `region` 参数（来自 `lib/config.js::readConfig().authRegion`）
 * 优先；缺省 ⇒ 读环境（`resolveAuthRegion`）。显式参数**形态非法 ⇒ 回空串** ⇒ 调用方判
 * `REGION_INVALID`（配置故障，与「凭证不对」严格分开）。
 * @param {*} candidate 显式区域参数（可缺省）
 * @param {object} [env] 环境（可缺省）
 * @returns {string} 形态成立的区域；非法 / 缺失且无可用环境值 ⇒ `''`
 */
function regionOf(candidate, env) {
  const fromParam = typeof candidate === 'string' ? candidate.trim().toLowerCase() : ''
  if (fromParam !== '') return REGION_PATTERN.test(fromParam) ? fromParam : ''
  return resolveAuthRegion(env)
}

/**
 * **验签平台会话并取回手机号**（契约 R-L1 的服务端权威判定本体）。
 *
 * 返回面**恰三键语义**：成功 `{ok:true, phone}`、失败 `{ok:false, detail}`（`detail` ∈ `DETAILS`）。
 * **绝不自抛**：任何输入畸形 / 网络异常 / 回体不可解都收敛成结构化失败。
 *
 * @param {object} params
 * @param {string} params.envId 运行期环境 Id（`lib/config.js::readEnvId` 读；缺 / 非法 ⇒ 内部不可用）
 * @param {string} params.accessToken 平台 `access_token`（**只进请求头**；缺 ⇒ 判否）
 * @param {number} [params.timeoutMs] 超时毫秒（缺省 2000）
 * @param {string} [params.region] 区域（**R-L9**；缺省 ⇒ 读 `XIAI_AUTH_REGION` / `TCB_REGION`，
 *   再缺省 ⇒ `ap-shanghai`）。只在 host 拼接处出现，**不参与任何判定**。
 * @param {object} [params.env] 环境（**自测注入用**；生产不传 ⇒ `process.env`）
 * @param {Function} [params.transport] **仅供离线自测注入**的传输实现（生产不传 ⇒ 内置 https）
 * @returns {Promise<{ok:true, phone:string}|{ok:false, detail:string}>}
 */
async function verifyPlatformSession(params) {
  try {
    const source = params && typeof params === 'object' ? params : {}
    const envId = typeof source.envId === 'string' ? source.envId.trim() : ''
    const accessToken = typeof source.accessToken === 'string' ? source.accessToken.trim() : ''
    if (!ENV_ID_PATTERN.test(envId)) return { ok: false, detail: DETAILS.ENV_MISSING }
    if (accessToken === '') return { ok: false, detail: DETAILS.TOKEN_MISSING }
    const timeoutMs = Number.isFinite(source.timeoutMs) && source.timeoutMs > 0 ? Math.floor(source.timeoutMs) : DEFAULT_TIMEOUT_MS
    const transport = typeof source.transport === 'function' ? source.transport : httpsJsonRequest

    /* **区域（R-L9）**：显式 `region` 参数优先（＝ `lib/config.js::readConfig().authRegion`），
       缺省 ⇒ 环境变量（`XIAI_AUTH_REGION` → `TCB_REGION`），再缺省 ⇒ `ap-shanghai`。
       区域非法 ⇒ `REGION_INVALID`（内部配置故障 ⇒ 调用方映射 `STORAGE_UNAVAILABLE`，
       **不得**说成「号或码不对」）。 */
    const region = regionOf(source.region, source.env)
    if (region === '') return { ok: false, detail: DETAILS.REGION_INVALID }
    const url = `https://${authHostOf(envId, region)}${ME_PATH}?client_id=${envId}`
    const response = await transport({
      url,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      },
      timeoutMs
    })

    if (!response || response.ok !== true) return { ok: false, detail: DETAILS.UNAVAILABLE }
    const status = Number(response.status)
    const body = response.body

    /* 平台**业务错误码**优先判（HTTP 200 也可能带 code；实测 `INVALID_ACCESS_TOKEN` / `INVALID_ENV`）。 */
    const bodyCode = body && typeof body === 'object' && typeof body.code === 'string' ? body.code.trim() : ''
    if (bodyCode !== '') {
      if (AUTH_FAILURE_CODES.indexOf(bodyCode) !== -1) return { ok: false, detail: DETAILS.AUTH_REJECTED }
      /* 未知错误码（`INVALID_ENV` / `INVALID_PARAM` / 平台内部错误码 …）⇒ 内部不可用，不判「号不对」。 */
      return { ok: false, detail: DETAILS.UNAVAILABLE }
    }

    /* 无业务码：只认 2xx；401 / 403 视为凭证不成立，其余非 2xx 视为内部不可用。 */
    if (!(status >= 200 && status < 300)) {
      if (status === 401 || status === 403) return { ok: false, detail: DETAILS.AUTH_REJECTED }
      return { ok: false, detail: DETAILS.UNAVAILABLE }
    }

    const phone = normalizePlatformPhone(pickPhoneNumber(body))
    if (phone === '') return { ok: false, detail: DETAILS.PHONE_MISSING }
    return { ok: true, phone }
  } catch {
    /* 纯函数纪律：**绝不把异常抛给调用方**（异常可能夹带请求对象里的凭证）。 */
    return { ok: false, detail: DETAILS.UNAVAILABLE }
  }
}

module.exports = {
  AUTH_HOST_SUFFIX,
  DEFAULT_REGION,
  REGION_ENV_NAMES,
  REGION_PATTERN,
  ME_PATH,
  DEFAULT_TIMEOUT_MS,
  PHONE_PATTERN,
  DETAILS,
  AUTH_FAILURE_CODES,
  normalizePlatformPhone,
  isMainlandPhone,
  pickPhoneNumber,
  resolveAuthRegion,
  authHostOf,
  regionOf,
  verifyPlatformSession
}
