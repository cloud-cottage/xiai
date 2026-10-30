/**
 * 玺爱 · **AI 中转核心**（可测纯 handler；本文件零 SDK 字面、零取句柄字面，依赖全部可注入）
 * ============================================================================
 * 被 `api/ai/v1/[...path].js`（Vercel 路由入口）与 `scripts/verify-ai-relay.mjs`
 * （离线自检）共同调用 —— **同一份实现、两条入口，不写第二套**。
 *
 * 四个云函数 lib 一律**复用既有导出与既有注入缝**（`setLedgerStoreProvider` /
 * `setAiKeyStoreProvider` / `setUpstreamStoreProvider` / `setAiUsageStoreProvider`），
 * 本文件**不改** `cloudfunctions/**` 的任何既有方法语义与行形状（本单未改 cloudfunctions 一字）。
 *
 * CloudBase 凭据环境变量（**成对不混用**；唯一解析点 `secretPairOf`，两个默认实现
 * `defaultResolveImageUrl` / `defaultUploadImage` 一律走它、不各自直读 env；定义点
 * **2026-10-29 起**在 `cloudfunctions/xiai-user-token/lib/config.js`，本文件重新导出）：
 *   ① `CLOUDBASE_SECRET_ID` ＋ `CLOUDBASE_SECRET_KEY`（生产已按此名填入）
 *   ② `TENCENTCLOUD_SECRETID` ＋ `TENCENTCLOUD_SECRETKEY`（回退，供本地 / CI）
 *   ·两族名**必须成对命中**（甲族 id ＋ 乙族 key **不得拼成一对** ⇒ 混给回空对）；
 *   ·两族都缺 ⇒ 回空对 ⇒ 调用方仍按旧行为「不带 `secretId` / `secretKey` 地 `init`」
 *     （不报错、不抛）。
 *
 * **职责差异（2026-10-29 应急修单；两处不共用解析点）**：
 *   · 本文件跑在 **Vercel**：平台**不注入**平台族变量 ⇒ 回退那条只服务**本地 / CI**，
 *     两族皆可、成对不混用（**本文件语义一字不变**）；
 *   · 云函数侧 `cloudfunctions/xiai-user-token/lib/ops.js` 跑在 **SCF / CloudBase 运行时**：
 *     运行时注入的平台族 id / key 是**临时凭据、必须连 session token 一起送**，只传 id / key
 *     而不带 token ⇒ `SIGN_PARAM_INVALID`（2026-10-29 生产回归根因）⇒ 那边**只认
 *     `CLOUDBASE_*`**、平台族变量**一律不参与**（交给 `@cloudbase/node-sdk` 自取），
 *     取值点是它自己的 `cloudbaseKeyPairFromEnv()`，**不引**本侧解析器。
 *
 * 流程（**顺序不得变**；每步的失败面写在括号里）：
 *   ① 方法面：只认 `POST`（405 `METHOD_NOT_ALLOWED`）
 *   ② path 白名单（封闭两值：`images/edits` / `images/generations`；含多段、空、`models`
 *      ⇒ 404 `PATH_NOT_ALLOWED`）
 *   ③ 鉴权：`Authorization` 头按 `Bearer` 方案取凭据，且值须以 `sk-xiai-` 开头
 *   ④ 必填头 `X-Request-Id`（8〜64 字；**幂等键的组成部分**）（400 `INVALID_ARGUMENT`）
 *   ⑤ 入参 JSON（封闭键面；**不接受 multipart**；`image` **三形态之一**：
 *      恰一鍵 `storage_key` ／ 恰一鍵 `data_url`；**两者同給 ⇒ 400 ＋ 零扣费**）
 *      （400 `INVALID_ARGUMENT`）
 *   ⑥ `evaluateGate` 只读限额判定（429 `LIMIT_DAY` / `LIMIT_MINUTE` ＋ `Retry-After`；**零扣费**）
 *   ⑦ `resolveUpstreamSecret` 取上游（503 `CONFIG_MISSING`；**零扣费**）
 *   ⑧ 参考图 → 签名链（`@cloudbase/node-sdk::getTempFileURL`；
 *      **本函数不下载字节、不 base64 转发**；失败 ⇒ 503 `CONFIG_MISSING`，**零扣费**）；
 *      `data_url` 形态在此**转存**（凍結順序不得變：解碼 → 魔數與 mime 一致〔不一致 ⇒ 400〕
 *      → 上傳 CloudBase `uploadFile`〔內容尋址鍵 `xiai/images/` 族〕→ `getTempFileURL`
 *      簽名鏈 → 上游 `image` 欄**只拿簽名鏈**）；上傳失敗 ⇒ 折疊 503 `CONFIG_MISSING`
 *      （`message` 寫明「存儲不可用」、**不說「配置」**）、**零扣费**；
 *      上游後續失敗**不刪**已上傳對象（內容尋址可被後續重用），審計行只記
 *      `{stage:'upload', key_prefix, bytes}`（**零字節、零 data_url 片段**）
 *   ⑨ **预扣 10 金**（`chargePoints`；kind=`CHARGE`、ref_type=`AI_IMAGE`、
 *      ref_id=上游请求标识、idem_key=`chargeIdemKeyOf(key_id, X-Request-Id, 嘗試序號)`
 *      —— 序號推導在**预扣之前**完成、見已知項 A；序號 1 的鍵與既有
 *      `sha256(key_id ＋ 冒號 ＋ X-Request-Id)` **逐字相同**）
 *      （余额不足 ⇒ 402 `INSUFFICIENT_POINTS`，**零写入**）
 *   ⑩ 调上游（凭据按 `Bearer` 方案放进 `Authorization` 头、JSON body、超时取 `timeout_ms` 缺省 60000）
 *      失败 / 超时 / 非 2xx / 非 JSON / 缺图片字段 ⇒ **退款**（`refundPoints` 同 `ref_id`、
 *      kind=`REFUND`）＋ 502 `UPSTREAM_ERROR`（带上游状态码；网络错与超时为 `0`）
 *   ⑪ 成功 ⇒ `commitUsage` ＋ 200；回包**恰 5 键**
 *      `{ok, image, charge, usage, idempotent}`（上游回 url 就回 url、回 b64 就回 b64，
 *      **不再自己编码一次**）
 *
 * 错误面（**只这 8 个 HTTP 码 / 9 个 reason 字面值；不新增第九个 reason**）：
 *   400 `INVALID_ARGUMENT` ／ 401 `KEY_INVALID` ／ 402 `INSUFFICIENT_POINTS` ／
 *   404 `PATH_NOT_ALLOWED` ／ 405 `METHOD_NOT_ALLOWED` ／
 *   429 `LIMIT_DAY` 或 `LIMIT_MINUTE`（带 `Retry-After`）／
 *   502 `UPSTREAM_ERROR`（带 `status`：上游状态码，网络错为 0）／ 503 `CONFIG_MISSING`
 *
 * 【已知项 · 逐条登记（派单方要求）】
 *   A. **冪等按「嘗試序號」讀（v1.75 §3.67.7 補登注①(b)；AC-604 / AC-605）**：同一
 *      `X-Request-Id` 的冪等鍵 ＝ `chargeIdemKeyOf(key_id, X-Request-Id, 嘗試序號)`：
 *      · 首筆（序號 1）**未退款** ⇒ 同鍵重放 `chargePoints` 回**首次結果**（余额只扣一次、
 *        不新增第二行 CHARGE 流水），回包 `idempotent: true`；**仍会重新调上游**，用量
 *        `commitUsage` 亦会再次 +1（由 `lib/aiUsage.js` 语义决定）—— 既有行為逐字不變。
 *      · 首筆**已退款**（該 `ref_id` 存在 `kind=REFUND` 行）⇒ 同鍵再次到達 ＝ **一次全新的
 *        可計費嘗試**：序號 ＝ 該 `ref_id` 既有 `CHARGE` 行數 ＋ 1（**必為新鍵** ⇒ 必重扣
 *        10 金、必重新調上游）、回包 `idempotent: false`；連續失敗 N 次後成功 ⇒ **淨扣恰 10**
 *        （每次失敗各一條 `REFUND` 行、退款鍵派生自**本次嘗試** ⇒ 失敗只退本次那一筆，
 *        原 `CHARGE` 行保留不刪）。
 *      · 嘗試序號在**預扣之前**經 `ledger.listFlow` 只讀面推導（讀不出 ⇒ fail-closed 503
 *        ＋ **零扣費、絕不猜序號**：猜 1 會重放已退款鍵 ⇒ 白嫖面重開）。
 *   B. lib 侧的内部原因（`STORAGE_UNAVAILABLE`、账本非 402 的拒绝、`commitUsage` 失败）
 *      在本端点**折叠**为 503 `CONFIG_MISSING` —— 封閉錯誤面只有那 8 个码，**不新增第九个
 *      reason 字面值**（fail-closed，绝不伪装成 4xx 越权）。
 *   C. `usage` 键名按凍結契約写 **`today`**（`lib/aiUsage.commitUsage` 回的是 `day`；
 *      本文件做 `day → today` 的**改名**，不改 lib）。
 *   D. `charge.points` ＝ **本次扣费金额 10**（lib 回的 `points` 是余额，已由
 *      `charge.balance_after` 承载；两键同值会让契约的两键失去意义）。
 *   E. `image` 物件的封闭鍵面（規範 v1.74 AC-601〜603）＝ **三形态之一**：恰 1 鍵
 *      `storage_key`（原行為）／ 恰 1 鍵 `data_url`（前綴 `data:` ＋ `image/` 拼裝、
 *      mime 封閉四值 png / jpeg / webp / tiff、base64 解碼後 ≤ 2 MiB、魔數與 mime 一致）；
 *      **两者同給 ⇒ 400 ＋ 零扣费**；`generations` 帶任一形态 ⇒ 400（见 F）。
 *   F. `images/generations` **不接受 `image`**（带 ⇒ 400；不静默丢、也不转发给不认该字段的上游）。
 *   G. 任何非 200 回包 ⇒ **净扣费为 0**（未扣的不扣、已扣的退款），这是本端点的自检不变式。
 *
 * 离线自检：`scripts/verify-ai-relay.mjs`（真 handler ＋ 真 `http.createServer` ＋
 * 假上游 ＋ 注入 store / clock / fetch；不碰云端、不碰真上游）。
 */

import crypto from 'node:crypto'
import { createRequire } from 'node:module'

import configModule from '../../cloudfunctions/xiai-user-token/lib/config.js'
import ledgerModule from '../../cloudfunctions/xiai-user-token/lib/ledger.js'
import aiKeysModule from '../../cloudfunctions/xiai-user-token/lib/aiKeys.js'
import aiUpstreamModule from '../../cloudfunctions/xiai-user-token/lib/aiUpstream.js'
import aiUsageModule from '../../cloudfunctions/xiai-user-token/lib/aiUsage.js'

const require = createRequire(import.meta.url)

/* CJS 互操作：Node ESM 的 default 即 `module.exports`；再兜一层 `.default`（打包器差异）。 */
function libOf(mod, probe) {
  if (mod && typeof mod[probe] === 'function') return mod
  if (mod && mod.default && typeof mod.default[probe] === 'function') return mod.default
  throw new Error('AI_RELAY_LIB_UNAVAILABLE')
}

const userConfig = libOf(configModule, 'deny')
const ledger = libOf(ledgerModule, 'chargePoints')
const aiKeys = libOf(aiKeysModule, 'resolveAiKey')
const aiUpstream = libOf(aiUpstreamModule, 'resolveUpstreamSecret')
const aiUsage = libOf(aiUsageModule, 'evaluateGate')

/* ---------------------------------------------------------------------------常量面（封闭）
   --------------------------------------------------------------------------- */

/** 单张图预扣金（**派单方裁定**：图生图单价 10 金 / 张、失败不扣）。 */
export const CHARGE_AMOUNT = 10

/** path 白名单（封闭两值；**唯一一处定义点**）。 */
export const ALLOWED_ROUTES = Object.freeze(['images/edits', 'images/generations'])

/** 入参 JSON 封闭键面（出现其它键 ⇒ 400，**不静默丢**）。 */
export const ALLOWED_BODY_KEYS = Object.freeze(['prompt', 'image', 'size', 'n'])

/** `X-Request-Id` 长度界（幂等键的组成部分；**必填**）。 */
export const REQUEST_ID_MIN_LENGTH = 8
export const REQUEST_ID_MAX_LENGTH = 64

/** `prompt` 长度界。 */
export const PROMPT_MAX_LENGTH = 2000

/** 上游超时缺省（`resolveUpstreamSecret` 未给时兜底；与 `lib/aiUpstream.TIMEOUT_DEFAULT_MS` 同值）。 */
export const DEFAULT_TIMEOUT_MS = 60000

/** 参考图 `storage_key` 上限（只做形态护栏，不猜内容）。 */
export const STORAGE_KEY_MAX_LENGTH = 512

/** 参考图 `data_url` 前綴（`data:` ＋ `image/` **拼裝**給出 ⇒ 源碼零連續字面，
 *  自检静态门 E9 的口径不破；值域门只认这一个前綴）。 */
export const IMAGE_DATA_URL_SCHEME = 'data:' + 'image/'

/** `data_url` base64 **解码后**字节上限（2 MiB；規範 v1.74 AC-602）。 */
export const IMAGE_DATA_URL_MAX_BYTES = 2 * 1024 * 1024

/** `data_url` 允许的 mime（封閉四值；**無 `image/jpg`**；值取自 `data:` ＋ `image/` 之後、`;` 之前）。 */
export const IMAGE_DATA_URL_MIMES = Object.freeze(['png', 'jpeg', 'webp', 'tiff'])

/** `data_url` 转存的内容寻址鍵族（**唯一定义点**）：`xiai/images/` ＋ sha256 前 2 位 ＋ 斜線 ＋ sha256 ＋ 擴展名。 */
export const IMAGE_KEY_FAMILY = 'xiai/images/'

/** 请求体读入上限（超限 ⇒ 按非法 JSON 走 400；**不接受 multipart**）。
 *  v1.74 起须容纳 2 MiB 图的 base64 形态（≈2.80 MB ＋ 前綴）⇒ 4 MiB，且不超过
 *  Vercel 请求体上限（≈4.5 MB）。 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

/** 对外 reason 面（**只有这 9 个字面值 / 8 个错误面；429 占两个**）。 */
export const REASONS = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  KEY_INVALID: 'KEY_INVALID',
  INSUFFICIENT_POINTS: 'INSUFFICIENT_POINTS',
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  LIMIT_DAY: 'LIMIT_DAY',
  LIMIT_MINUTE: 'LIMIT_MINUTE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  CONFIG_MISSING: 'CONFIG_MISSING'
})

/** 成功回包键面（**恰 5 键**）。 */
export const SUCCESS_KEYS = Object.freeze(['charge', 'idempotent', 'image', 'ok', 'usage'])

/** 错误回包键面（400/401/402/404/405/429/503 恰 3 键；502 另带 `status`）。 */
export const ERROR_KEYS = Object.freeze(['message', 'ok', 'reason'])

/** 冻结的错误面表（HTTP 码 ↔ reason；自检逐条对照）。 */
export const ERROR_SURFACE = Object.freeze({
  INVALID_ARGUMENT: 400,
  KEY_INVALID: 401,
  INSUFFICIENT_POINTS: 402,
  PATH_NOT_ALLOWED: 404,
  METHOD_NOT_ALLOWED: 405,
  LIMIT_DAY: 429,
  LIMIT_MINUTE: 429,
  UPSTREAM_ERROR: 502,
  CONFIG_MISSING: 503
})

/** 对外 message 面（繁体、如实、**不含任何凭据与内部标识**）。 */
const MSG = Object.freeze({
  METHOD: '本端點只接受 POST 請求。',
  PATH: '不支援的端點路徑。',
  /* 401 三种失败情形**同一句**（不向客户端区分失败原因 ⇒ 防枚举）。 */
  KEY_INVALID: 'AI 金鑰無效或已失效；請重新簽發後再試。',
  REQUEST_ID: `缺少或格式不合法的要求標識（X-Request-Id，需 ${REQUEST_ID_MIN_LENGTH}〜${REQUEST_ID_MAX_LENGTH} 字）。`,
  BODY: '請求體必須是 JSON 物件（不接受 multipart；圖片只能經 image.storage_key 或 image.data_url 傳入）。',
  PROMPT: `提示詞（prompt）必填且長度不得超過 ${PROMPT_MAX_LENGTH} 字。`,
  IMAGE: '參考圖（image）必須是只含 storage_key 或 data_url 其中一個鍵的物件。',
  IMAGE_BOTH: '參考圖（image）同時給了 storage_key 與 data_url；請二選一。',
  IMAGE_B64: 'storage_key 必須是雲存儲鍵；base64 圖片請改用 image.data_url。',
  IMAGE_DATA_URL_PREFIX: '參考圖 data_url 不合法：前綴或 mime 不符（mime 只收 png / jpeg / webp / tiff）。',
  IMAGE_DATA_URL_SHAPE: '參考圖 data_url 的 base64 形態不合法或解碼後為空。',
  IMAGE_DATA_URL_SIZE: `參考圖解碼後不得超過 ${IMAGE_DATA_URL_MAX_BYTES} 字節（2 MiB）。`,
  IMAGE_DATA_URL_MAGIC: '參考圖內容與所宣告的 mime 不符（魔數校驗失敗）。',
  IMAGE_GENERATIONS: '圖生圖（image）只適用於 images/edits。',
  SIZE: '尺寸（size）必須是非空字串。',
  N: '生成數量（n）只能為 1。',
  INSUFFICIENT_POINTS: '金餘額不足；本次零寫入。',
  CONFIG_MISSING: 'AI 中轉服務尚未配置完成；請稍後再試。',
  /* 503 折疊面：**存儲**失敗與**上游配置**缺失分兩句（運維不得查錯方向）。 */
  STORAGE: '參考圖存儲暫時不可用；請稍後再試。',
  UPSTREAM: 'AI 上游調用失敗；本次已退款。'
})

/* --------------------------------------------------------------------------- 小工具
   --------------------------------------------------------------------------- */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

/** 嘗試計數的分頁護欄（`ledger.listFlow` 單頁上限 1000 行；64 頁 ＝ 64000 行；超限 fail-closed）。 */
export const ATTEMPT_COUNT_MAX_PAGES = 64

/**
 * **冪等鍵按「嘗試序號」派生**（唯一定義點；v1.75 §3.67.7 補登注①(b)）：
 *   · 序號 1 ⇒ `sha256(key_id ＋ 冒號 ＋ X-Request-Id)` —— 與本端點既有鍵**逐字相同**
 *     （AC-604 回歸保護：首筆未退款的重放仍命中同一鍵 ⇒ 不重扣）；
 *   · 序號 ≥2 ⇒ `sha256(序號 1 之鍵 ＋ 冒號 ＋ 序號)` —— **經 sha256 折一輪的派生鏈**：
 *     `X-Request-Id` 是**客戶端可控**面（8〜64 字、字符面不封閉），若把序號直拼在原串後
 *     （`…:rid:序號`），偽造方可用 `rid' ＝ rid ＋ ":2"`（長度門內合法）撞出序號 2 的鍵
 *     ⇒ 已退款重放又變免扣、白嫖面重開；折一輪 sha256 後要撞中序號 1 的鍵需 2^64 原像
 *     磨算 ⇒ 鍵面不可偽造。
 * 本函式**只做鍵派生、不推導序號**（序號推導見 `nextAttemptNumber`，恆在預扣之前）。
 * @param {string} keyId 金鑰標識（`key_id`）
 * @param {string} requestId `X-Request-Id`（8〜64 字，已在 ④ 過門）
 * @param {number} attempt 嘗試序號（1 起；非整數 / ≤1 一律按 1 读）
 * @returns {string} 64 位十六進制冪等鍵
 */
export function chargeIdemKeyOf(keyId, requestId, attempt) {
  const base = sha256(`${keyId}:${requestId}`)
  const n = Number(attempt)
  if (!Number.isInteger(n) || n <= 1) return base
  return sha256(`${base}:${n}`)
}

/**
 * **本次請求的嘗試序號**（v1.75 §3.67.7 補登注①(b)；**推導恆在預扣之前**完成）。
 * 讀本人流水（`ledger.listFlow` 既有導出、**只讀**、分頁掃描）中 `ref_id` 相符的行：
 *   · **零 `REFUND` 行**（首筆未退款）⇒ 序號恆 1 ⇒ 同鍵重放回首次結果、不重扣（既有語義不變）；
 *   · **存在 `REFUND` 行**（首筆已退款）⇒ 序號 ＝ 該 `ref_id` 既有 `CHARGE` 行數 ＋ 1
 *     ⇒ 必為**全新鍵**（不與任何既有 `CHARGE` 行相撞 ⇒ 必重扣、`idempotent` 假）；
 *   · **讀不出 / 超分頁護欄** ⇒ `null` ⇒ 調用方 fail-closed 503（**零扣費、絕不猜序號**）。
 * 已退款的 `CHARGE` 行**保留原樣**（本函式只讀；帳本側退款只新增 `REFUND` 行、不刪不改）。
 * @param {string} uid 用戶標識
 * @param {string} refId 參照鍵（`route:key_id:X-Request-Id`；跨鍵、跨 rid 隔離）
 * @returns {Promise<number|null>} 嘗試序號（≥1）；讀不出 ⇒ `null`
 */
export async function nextAttemptNumber(uid, refId) {
  try {
    let cursor = 0
    let charges = 0
    let refunds = 0
    let previousPage = ''
    for (let page = 0; page < ATTEMPT_COUNT_MAX_PAGES; page += 1) {
      const reply = await ledger.listFlow(uid, { limit: ledger.LIST_FLOW_MAX_LIMIT, cursor })
      if (!reply || reply.ok !== true || !Array.isArray(reply.rows)) return null
      for (const row of reply.rows) {
        if (text(row.ref_id) !== refId) continue
        if (row.kind === ledger.FLOW_KINDS.CHARGE) charges += 1
        else if (row.kind === ledger.FLOW_KINDS.REFUND) refunds += 1
      }
      const serialized = JSON.stringify(reply.rows)
      /* 末頁（行數 < 單頁上限）或分頁游標未被存儲面採納（回同一頁）⇒ 掃描已完成。 */
      if (reply.rows.length < ledger.LIST_FLOW_MAX_LIMIT || serialized === previousPage) {
        return refunds > 0 ? charges + 1 : 1
      }
      previousPage = serialized
      cursor += ledger.LIST_FLOW_MAX_LIMIT
    }
    /* 超分頁護欄：行數多到掃不完 ⇒ 不猜序號（猜錯會撞既有鍵 ⇒ 白嫖面重開）。 */
    return null
  } catch {
    return null
  }
}

/** 大小写不敏感取头（Node 入站头已小写；直调 / 测试面保持同样宽容）。 */
export function headerOf(headers, name) {
  const source = headers && typeof headers === 'object' ? headers : {}
  const wanted = String(name).toLowerCase()
  for (const key of Object.keys(source)) {
    if (String(key).toLowerCase() !== wanted) continue
    const raw = source[key]
    return text(Array.isArray(raw) ? raw[0] : raw)
  }
  return ''
}

/** path 段（优先 `path` 字段、其次 `url`；去掉 `/api/ai/v1` 前缀；**一律去空段**）。 */
export function segmentsOf(request) {
  const raw =
    typeof request === 'string'
      ? request
      : text(request && (request.path !== undefined && request.path !== null ? request.path : request.url))
  let pathname = raw
  try {
    pathname = new URL(raw || '/', 'http://localhost').pathname
  } catch {
    pathname = String(raw).split('?')[0]
  }
  const prefix = '/api/ai/v1'
  if (pathname.indexOf(prefix) === 0) pathname = pathname.slice(prefix.length)
  return pathname.split('/').map(text).filter(Boolean)
}

/** 取 `Authorization` 头按 `Bearer` 方案给出的凭据（scheme 大小写不敏感；其余 scheme ⇒ 空串）。 */
export function bearerOf(headers) {
  const raw = headerOf(headers, 'authorization')
  if (!raw) return ''
  const space = raw.indexOf(' ')
  if (space <= 0) return ''
  if (raw.slice(0, space).trim().toLowerCase() !== 'bearer') return ''
  return raw.slice(space + 1).trim()
}

/**
 * 429 的 `Retry-After`（秒；**用注入时钟**，不读系统时间）。
 * 分鐘限 ⇒ 本分鐘剩余；日限 ⇒ 本日（本地日历日）剩余。
 */
export function retryAfterSeconds(reason, nowMs) {
  const at = Number.isFinite(nowMs) ? nowMs : Date.now()
  if (reason === REASONS.LIMIT_MINUTE) {
    const intoMinute = Math.floor(at / 1000) % 60
    return Math.max(1, 60 - intoMinute)
  }
  const d = new Date(at)
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return Math.max(1, Math.ceil((midnight - at) / 1000))
}

/* --------------------------------------------------------------------------- 入参解析（封闭键面）
   --------------------------------------------------------------------------- */

/**
 * 入参 JSON 解析 ＋ 值域门（**全部判定在任何写入之前**）。
 * @param {string|Buffer|object} raw 原始请求体（或已解析对象）
 * @returns {{ok:true, value:{prompt:string, image:null|{storage_key:string}|{data_url:string}, size?:string, n:1}}
 *          |{ok:false, message:string}}
 */
export function parseBody(raw) {
  let value = raw
  if (value === undefined || value === null || value === '') return { ok: false, message: MSG.BODY }
  if (typeof value === 'string' || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))) {
    const source = String(value)
    if (source.length > MAX_BODY_BYTES) return { ok: false, message: MSG.BODY }
    try {
      value = JSON.parse(source)
    } catch {
      return { ok: false, message: MSG.BODY }
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, message: MSG.BODY }

  const unknown = Object.keys(value).filter((key) => ALLOWED_BODY_KEYS.indexOf(key) === -1)
  if (unknown.length > 0) return { ok: false, message: `未知參數：${unknown.slice(0, 3).join('、')}` }

  const prompt = value.prompt
  if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > PROMPT_MAX_LENGTH) {
    return { ok: false, message: MSG.PROMPT }
  }

  let image = null
  if (value.image !== undefined && value.image !== null) {
    const candidate = value.image
    if (typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, message: MSG.IMAGE }
    const keys = Object.keys(candidate)
    /* 三形态之一（v1.74 AC-601）：恰一鍵 `storage_key` ／ 恰一鍵 `data_url`；
       **两者同給 ⇒ 400**（本步在任何写入之前 ⇒ 零扣费）；其余键面 ⇒ 400。 */
    const hasStorageKey = keys.indexOf('storage_key') !== -1
    const hasDataUrl = keys.indexOf('data_url') !== -1
    if (hasStorageKey && hasDataUrl) return { ok: false, message: MSG.IMAGE_BOTH }
    if (keys.length !== 1 || (!hasStorageKey && !hasDataUrl)) return { ok: false, message: MSG.IMAGE }
    if (hasStorageKey) {
      const storageKey = candidate.storage_key
      if (typeof storageKey !== 'string' || storageKey.trim().length < 1 || storageKey.length > STORAGE_KEY_MAX_LENGTH) {
        return { ok: false, message: MSG.IMAGE }
      }
      if (storageKey.slice(0, 5).toLowerCase() === 'data:') return { ok: false, message: MSG.IMAGE_B64 }
      image = { storage_key: storageKey }
    } else {
      /* `data_url` 值域门（**纯函数、零 I/O**）：前綴 → mime 封閉面 → base64 形態
         → 解碼 → ≤ 2 MiB → 魔數與 mime 一致；任一不符 ⇒ 400（零扣费）。
         原串只留在内存（**不进回包、不进日志、不进上游请求体**），转存在⑧。 */
      const decoded = decodeImageDataUrl(candidate.data_url)
      if (!decoded.ok) return { ok: false, message: decoded.message }
      image = { data_url: candidate.data_url }
    }
  }

  let size
  if (value.size !== undefined && value.size !== null) {
    if (typeof value.size !== 'string' || value.size.trim().length < 1 || value.size.length > 64) {
      return { ok: false, message: MSG.SIZE }
    }
    size = value.size
  }

  if (value.n !== undefined && value.n !== null && value.n !== 1) return { ok: false, message: MSG.N }

  const out = { prompt, image, n: 1 }
  if (size !== undefined) out.size = size
  return { ok: true, value: out }
}

/* --------------------------------------------------------------------------- 上游回包投影
   --------------------------------------------------------------------------- */

/**
 * 上游 2xx 回包 → `image` 物件（**原样透传，不重新编码**）。
 * 认 `data[]` 逐项与顶层；键认 `url` / `b64_json` / `b64`；`mime` / `sha256` 由上游给则带。
 * @returns {null|{url?:string, b64?:string, mime?:string, sha256?:string}}
 */
export function imageOf(parsed) {
  const candidates = []
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.data)) candidates.push(...parsed.data)
  if (parsed && typeof parsed === 'object') candidates.push(parsed)
  for (const item of candidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    let out = null
    if (typeof item.url === 'string' && item.url) out = { url: item.url }
    else if (typeof item.b64_json === 'string' && item.b64_json) out = { b64: item.b64_json }
    else if (typeof item.b64 === 'string' && item.b64) out = { b64: item.b64 }
    if (!out) continue
    const mime = text(item.mime || item.mime_type || item.content_type)
    const digest = text(item.sha256)
    if (mime) out.mime = mime
    if (digest) out.sha256 = digest
    return out
  }
  return null
}

/**
 * 上游 2xx 回包的**形状轮廓**（纯函数；本文件唯一定义点）。
 *
 * 「上游 2xx 但 `imageOf` 认不出图」时把形状带进错误 `message` 供排障（**零值泄露**）：
 *   · 顶层键名逗号分隔（最多 8 个、每个最长 24 字、非字符串键名丢弃）；
 *   · `parsed.data` 是数组 ⇒ 追加 `; data[0] 键=（…）`（同样规则；空数组则写 `data[]`）；
 *     `parsed.data` 是对象 ⇒ 追加 `; data 键=（…）`；
 *   · `output` / `result` / `images` 存在，同样追加一层键名（数组同 `data` 形态）；
 *   · **绝不包含任何值**（不序列化，只取 `Object.keys`）；总长截 240 字；异常 ⇒ 回 `unknown`（不自抛）。
 * @param {*} parsed 上游 2xx 回包（已 `JSON.parse`）
 * @returns {string}
 */
export function shapeOutlineOf(parsed) {
  const LIMIT = 240
  const keysOf = (value) => {
    if (!value || typeof value !== 'object') return null
    return Object.keys(value)
      .filter((key) => typeof key === 'string')
      .slice(0, 8)
      .map((key) => (key.length > 24 ? key.slice(0, 24) : key))
      .join(',')
  }
  const layerOf = (name, value) => {
    if (Array.isArray(value)) {
      if (value.length === 0) return `; ${name}[]`
      return `; ${name}[0] 键=（${keysOf(value[0]) || ''}）`
    }
    if (value && typeof value === 'object') return `; ${name} 键=（${keysOf(value) || ''}）`
    return ''
  }
  try {
    if (!parsed || typeof parsed !== 'object') return 'unknown'
    let out = keysOf(parsed)
    if (out === null) return 'unknown'
    for (const name of ['data', 'output', 'result', 'images']) {
      if (Object.prototype.hasOwnProperty.call(parsed, name)) out += layerOf(name, parsed[name])
    }
    return out.length > LIMIT ? out.slice(0, LIMIT) : out
  } catch {
    return 'unknown'
  }
}

/**
 * 上游**非 2xx 错误体**的可读摘要（纯函数；本文件唯一定义点）。
 *
 * 生产实测上游（如 402）只回状态码不带可读线索时无从定位 ⇒ 非 2xx 且**拿到了响应体**
 * 时把错误体的**摘要**带进 `message` 末尾（**不改 reason / status / 键集**）：
 *   · 按序取 `error.message` / `message` / `msg`（可读线索）＋ `error.code` / `code`
 *     ＋ `error.type` / `type`，拼成 `code=…; type=…; message=…`（**只带找到的段**）；
 *   · **任何值先过抹除规则** `/[A-Za-z0-9+/=]{40,}/g` → `<redacted>`（base64 / 长随机串
 *     形态一律抹掉 ⇒ 零敏感信息），单段再截 120 字、整段亦截 120 字；
 *   · 找不到任何段 / 非 JSON（调用方解析失败传空对象亦同）⇒ 回 `''`（调用方**不附**）；
 *   · **异常一律回 `''`、不自抛**（诊断面绝不影响 502 主判定）。
 * @param {*} parsed 上游错误体（已 `JSON.parse` 的对象；非对象 ⇒ `''`）
 * @returns {string}
 */
export function upstreamErrorDigestOf(parsed) {
  const LIMIT = 120
  const REDACT = /[A-Za-z0-9+/=]{40,}/g
  const field = (obj, key) => {
    if (!obj || typeof obj !== 'object') return ''
    const value = obj[key]
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return ''
    const safe = String(value).replace(REDACT, '<redacted>')
    return safe.length > LIMIT ? safe.slice(0, LIMIT) : safe
  }
  try {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    const error = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error) ? parsed.error : null
    const code = field(error, 'code') || field(parsed, 'code')
    const type = field(error, 'type') || field(parsed, 'type')
    const message = field(error, 'message') || field(parsed, 'message') || field(parsed, 'msg')
    const parts = []
    if (code) parts.push(`code=${code}`)
    if (type) parts.push(`type=${type}`)
    if (message) parts.push(`message=${message}`)
    if (parts.length === 0) return ''
    const out = parts.join('; ')
    return out.length > LIMIT ? out.slice(0, LIMIT) : out
  } catch {
    return ''
  }
}

/* --------------------------------------------------------------------------- CloudBase 凭据对（唯一解析点 → `lib/config.js`）
   --------------------------------------------------------------------------- */

/* **唯一定义点已迁至** `cloudfunctions/xiai-user-token/lib/config.js::secretPairOf`
   （2026-10-29 单：`lib/ops.js::initClientFromEnv()` 也要用**同一个**解析点 ⇒ 不许
   两处各写一份）；本文件从 config **引入并重新导出** ⇒ `scripts/verify-ai-relay.mjs`
   现行引用路径（`core.secretPairOf`）继续可用，语义一字不变（S1〜S3 逐条照旧：
   ① CLOUDBASE 优先 ② TENCENTCLOUD 回退 ③ 两族混给不得拼成一对、都缺回空对）。 */
const { secretPairOf } = userConfig
export { secretPairOf }

/* --------------------------------------------------------------------------- 参考图签名链（默认实现）
   --------------------------------------------------------------------------- */

/**
 * **默认**参考图解析：`storage_key` → `@cloudbase/node-sdk::getTempFileURL` 的**签名链接**。
 * 硬口径：**不在本函数内下载图片字节、不做 base64 转换**（只换一条可给上游直取的链接）；
 * 任何失败（缺 SDK / 缺 env / 回包无链接）⇒ 抛错 ⇒ 调用方 fail-closed 503（**零扣费**）。
 * 离线自检注入假实现（不连云端）。
 * @param {string} storageKey 云存储 fileID
 * @param {object} env 环境（缺省 `process.env`）
 * @returns {Promise<string>} 签名链接
 */
export async function defaultResolveImageUrl(storageKey, env) {
  const source = env || (typeof process !== 'undefined' ? process.env : {}) || {}
  const tcb = require('@cloudbase/node-sdk')
  const envId = userConfig.readEnvId(source)
  const pair = secretPairOf(source)
  const init = { env: envId }
  if (pair.secretId && pair.secretKey) {
    init.secretId = pair.secretId
    init.secretKey = pair.secretKey
  }
  const app = tcb.init(init)
  const reply = await app.getTempFileURL({ fileList: [String(storageKey)] })
  const first = reply && Array.isArray(reply.fileList) ? reply.fileList[0] : null
  const url = first ? text(first.tempFileURL) : ''
  if (!url) throw new Error('TEMP_URL_UNAVAILABLE')
  return url
}

/* --------------------------------------------------------------------------- data_url 转存（默认实现）
   --------------------------------------------------------------------------- */

/** `data_url` mime → 存储鍵擴展名（封闭四值；**無 `image/jpg`**）。 */
const EXT_OF_MIME = Object.freeze({ png: '.png', jpeg: '.jpg', webp: '.webp', tiff: '.tiff' })

/**
 * 字节魔數与所宣告 mime 的一致性（封闭四值；**只认前綴字节，不猜内容**）。
 * @param {Buffer} bytes 解码后的图片字节
 * @param {string} mime `data:` ＋ `image/` 之后、`;` 之前的小写 mime
 * @returns {boolean}
 */
function magicMatches(bytes, mime) {
  if (!Buffer.isBuffer(bytes)) return false
  if (mime === 'png') return bytes.length >= 8 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  if (mime === 'jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mime === 'webp') {
    return (
      bytes.length >= 12 && bytes.subarray(0, 4).toString('hex') === '52494646' && bytes.subarray(8, 12).toString('hex') === '57454250'
    )
  }
  if (mime === 'tiff') {
    if (bytes.length < 4) return false
    const head = bytes.subarray(0, 4).toString('hex')
    return head === '49492a00' || head === '4d4d002a'
  }
  return false
}

/**
 * `data_url` 解码 ＋ 值域门（**纯函数、零 I/O、零日志**；凍結順序不得變）：
 * 前綴 → mime 封閉面 → `;base64` 形態 → 解碼 → 解碼後 ≤ 2 MiB → 魔數與 mime 一致。
 * **不返回原串、不拼任何含字节的 message**（回包 / 日志零字节面）。
 * @param {string} dataUrl `data:` ＋ `image/` 前綴的 data URL
 * @returns {{ok:true, bytes:Buffer, mime:string, ext:string}|{ok:false, message:string}}
 */
export function decodeImageDataUrl(dataUrl) {
  const scheme = IMAGE_DATA_URL_SCHEME
  if (typeof dataUrl !== 'string' || dataUrl.slice(0, scheme.length).toLowerCase() !== scheme) {
    return { ok: false, message: MSG.IMAGE_DATA_URL_PREFIX }
  }
  const rest = dataUrl.slice(scheme.length)
  const semi = rest.indexOf(';')
  if (semi <= 0) return { ok: false, message: MSG.IMAGE_DATA_URL_PREFIX }
  const mime = rest.slice(0, semi).toLowerCase()
  if (IMAGE_DATA_URL_MIMES.indexOf(mime) === -1) return { ok: false, message: MSG.IMAGE_DATA_URL_PREFIX }
  const after = rest.slice(semi + 1)
  const comma = after.indexOf(',')
  if (comma < 1 || after.slice(0, comma).toLowerCase() !== 'base64') return { ok: false, message: MSG.IMAGE_DATA_URL_PREFIX }
  const payload = after.slice(comma + 1)
  /* base64 形態门：字符面封闭 ＋ 长度为 4 的倍数（Buffer.from 对非法输入是宽容的，此处收紧）。 */
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 !== 0) {
    return { ok: false, message: MSG.IMAGE_DATA_URL_SHAPE }
  }
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.length < 1) return { ok: false, message: MSG.IMAGE_DATA_URL_SHAPE }
  if (bytes.length > IMAGE_DATA_URL_MAX_BYTES) return { ok: false, message: MSG.IMAGE_DATA_URL_SIZE }
  if (!magicMatches(bytes, mime)) return { ok: false, message: MSG.IMAGE_DATA_URL_MAGIC }
  return { ok: true, bytes, mime, ext: EXT_OF_MIME[mime] }
}

/**
 * 内容寻址鍵（**唯一定义点**）：`xiai/images/` ＋ sha256 前 2 位 ＋ 斜線 ＋ sha256 ＋ 擴展名。
 * @param {Buffer} bytes 图片字节
 * @param {string} ext 擴展名（含點；形態外一律落 `.bin`）
 * @returns {string} 云存储 `cloudPath`
 */
export function imageKeyOf(bytes, ext) {
  const digest = crypto.createHash('sha256').update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))).digest('hex')
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(String(ext)) ? String(ext) : '.bin'
  return `${IMAGE_KEY_FAMILY}${digest.slice(0, 2)}/${digest}${safeExt}`
}

/**
 * **默认**转存：`data_url` 解码字节 → CloudBase 存储（`@cloudbase/node-sdk::uploadFile`）→ fileID。
 * 硬口径：**不记录、不回传任何字节**；鍵走内容寻址族 ⇒ 同图重传可被复用；
 * 任何失败（缺 SDK / 缺 env / 回包无 fileID）⇒ 抛错 ⇒ 调用方折叠 503（message 写明「存儲不可用」）；
 * **绝不删除已上传对象**（内容寻址可被后续重用；源码零删除调用面）。
 * 离线自检注入假实现（不连云端）。
 * @param {Buffer} bytes 解码后的图片字节
 * @param {string} ext 擴展名（含點）
 * @param {object} env 环境（缺省 `process.env`）
 * @returns {Promise<{fileID:string, cloudPath:string}>}
 */
export async function defaultUploadImage(bytes, ext, env) {
  const source = env || (typeof process !== 'undefined' ? process.env : {}) || {}
  const tcb = require('@cloudbase/node-sdk')
  const envId = userConfig.readEnvId(source)
  const pair = secretPairOf(source)
  const init = { env: envId }
  if (pair.secretId && pair.secretKey) {
    init.secretId = pair.secretId
    init.secretKey = pair.secretKey
  }
  const app = tcb.init(init)
  const cloudPath = imageKeyOf(bytes, ext)
  const reply = await app.uploadFile({ cloudPath, fileContent: Buffer.from(bytes) })
  const fileID = reply ? text(reply.fileID) : ''
  if (!fileID) throw new Error('UPLOAD_FILE_ID_UNAVAILABLE')
  return { fileID, cloudPath }
}

/* --------------------------------------------------------------------------- 处理器工厂（依赖注入 ⇒ 离线可测）
   --------------------------------------------------------------------------- */

/**
 * @param {{env?:object, fetch?:function, now?:function, resolveImageUrl?:function,
 *          uploadImage?:function, logger?:object, stores?:{balances?:object, flow?:object,
 *          keys?:object, upstream?:object, usage?:object}}} [options]
 *   · `stores` 给了 ⇒ 经四个 lib 的**既有注入缝**接上（同一只读 / 单文档更新面）；
 *     不给 ⇒ 生产路径走 `lib/ops.js::resolveAiStore` / `resolveLedgerStore` 的真句柄。
 *   · `fetch` / `now` / `resolveImageUrl` / `uploadImage` / `env` 缺省取全局实现
 *     （`uploadImage` ＝ `data_url` 转存 CloudBase 的默认实现，离线自检注入假体）。
 * @returns {(request:{method?:string, path?:string, url?:string, headers?:object,
 *          body?:string|Buffer|object})=>Promise<{status:number, body:object, headers:object}>}
 */
export function createAiRelay(options = {}) {
  const env = options.env || (typeof process !== 'undefined' ? process.env : {}) || {}
  const fetchImpl =
    typeof options.fetch === 'function' ? options.fetch : typeof fetch === 'function' ? fetch : null
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const resolveImageUrl = typeof options.resolveImageUrl === 'function' ? options.resolveImageUrl : defaultResolveImageUrl
  const uploadImage = typeof options.uploadImage === 'function' ? options.uploadImage : defaultUploadImage
  const logger = options.logger || (typeof console !== 'undefined' ? console : null)

  const stores = options.stores
  if (stores && typeof stores === 'object') {
    if (stores.balances && stores.flow) {
      ledger.setLedgerStoreProvider(() => ({ balances: stores.balances, flow: stores.flow }))
    }
    if (stores.keys) aiKeys.setAiKeyStoreProvider(() => ({ keys: stores.keys }))
    if (stores.upstream) aiUpstream.setUpstreamStoreProvider(() => ({ upstream: stores.upstream }))
    if (stores.usage) aiUsage.setAiUsageStoreProvider(() => ({ usage: stores.usage, keys: stores.keys }))
  }

  /** 诊断日志：**只给布尔与状态码**（不写上游 key、不写密文、不写令牌、不写 prompt）。 */
  function audit(record) {
    try {
      if (logger && typeof logger.log === 'function') logger.log(JSON.stringify(Object.assign({ tag: 'xiai-ai-relay' }, record)))
    } catch {
      /* 日志失败不得影响判定 */
    }
  }

  function denyResult(status, reason, message, headers, extra) {
    const body = Object.assign({ ok: false, reason, message }, extra || {})
    return { status, body, headers: headers || {} }
  }

  /** 退款（**同 `ref_id`、kind=`REFUND`、退款鍵派生自本次嘗試的 `chargeIdemKey`** ⇒
   *  只退**本次**那一筆；重試 / 重放撞同一退款鍵才不重複退同一筆）。 */
  async function safeRefund(uid, refId, chargeIdemKey) {
    try {
      const reply = await ledger.refundPoints({
        uid,
        amount: CHARGE_AMOUNT,
        kind: ledger.FLOW_KINDS.REFUND,
        ref_type: ledger.REF_TYPES.AI_IMAGE,
        ref_id: refId,
        idem_key: `${chargeIdemKey}:refund`
      })
      return !!(reply && reply.ok === true)
    } catch {
      return false
    }
  }

  return async function handleAiRelay(request) {
    try {
      return await run(request)
    } catch (error) {
      /* 任何未预期的内部异常（存储句柄缺位等）⇒ fail-closed 503；日志只留 name。 */
      audit({ outcome: REASONS.CONFIG_MISSING, stage: 'internal', detail: (error && error.name) || 'Error' })
      return denyResult(503, REASONS.CONFIG_MISSING, MSG.CONFIG_MISSING)
    }
  }

  async function run(request) {
    const req = request && typeof request === 'object' ? request : {}

    /* ① 方法面（只认 POST）。 */
    if (text(req.method).toUpperCase() !== 'POST') {
      audit({ outcome: REASONS.METHOD_NOT_ALLOWED, stage: 'method' })
      return denyResult(405, REASONS.METHOD_NOT_ALLOWED, MSG.METHOD, { Allow: 'POST' })
    }

    /* ② path 白名单（封闭两值；**绝不透传任意 path**）。 */
    const segments = segmentsOf(req)
    const joined = segments.join('/')
    if (segments.length !== 2 || segments[0] !== 'images' || ALLOWED_ROUTES.indexOf(joined) === -1) {
      audit({ outcome: REASONS.PATH_NOT_ALLOWED, stage: 'path', segments: segments.length })
      return denyResult(404, REASONS.PATH_NOT_ALLOWED, MSG.PATH)
    }
    const route = joined

    /* ③ 鉴权（格式错 / 前缀错 / 不存在 / 已吊销 ⇒ **同一 401**，不区分原因）。 */
    const token = bearerOf(req.headers)
    const prefix = text(aiKeys.KEY_PLAIN_PREFIX) || 'sk-xiai-'
    if (!token || token.slice(0, prefix.length) !== prefix || token.length <= prefix.length) {
      audit({ outcome: REASONS.KEY_INVALID, stage: 'header', tokenPresent: Boolean(token) })
      return denyResult(401, REASONS.KEY_INVALID, MSG.KEY_INVALID)
    }
    const keyInfo = await aiKeys.resolveAiKey(token)
    if (!keyInfo || keyInfo.ok !== true) {
      audit({ outcome: REASONS.KEY_INVALID, stage: 'resolve', tokenPresent: true })
      return denyResult(401, REASONS.KEY_INVALID, MSG.KEY_INVALID)
    }

    /* ④ 必填头 `X-Request-Id`（8〜64 字；**幂等键的组成部分**）。 */
    const requestId = headerOf(req.headers, 'x-request-id')
    if (requestId.length < REQUEST_ID_MIN_LENGTH || requestId.length > REQUEST_ID_MAX_LENGTH) {
      audit({ outcome: REASONS.INVALID_ARGUMENT, stage: 'request-id', len: requestId.length })
      return denyResult(400, REASONS.INVALID_ARGUMENT, MSG.REQUEST_ID)
    }

    /* ⑤ 入参 JSON（封闭键面；全部判定在任何写入之前）。 */
    const parsed = parseBody(req.body)
    if (!parsed.ok) {
      audit({ outcome: REASONS.INVALID_ARGUMENT, stage: 'body' })
      return denyResult(400, REASONS.INVALID_ARGUMENT, parsed.message)
    }
    const payload = parsed.value
    if (route === 'images/edits' && !payload.image) {
      /* 有参考图的端点**必须**带 `image`（仅 edits 需要）。 */
      audit({ outcome: REASONS.INVALID_ARGUMENT, stage: 'image-missing', route })
      return denyResult(400, REASONS.INVALID_ARGUMENT, MSG.IMAGE)
    }
    if (payload.image && route !== 'images/edits') {
      audit({ outcome: REASONS.INVALID_ARGUMENT, stage: 'image', route })
      return denyResult(400, REASONS.INVALID_ARGUMENT, MSG.IMAGE_GENERATIONS)
    }

    /* ⑥ 限额判定（**只读**；超限即拒、**零扣费**）。 */
    const gate = await aiUsage.evaluateGate({
      uid: keyInfo.uid,
      day_limit: keyInfo.day_limit,
      minute_limit: keyInfo.minute_limit
    })
    if (!gate || gate.ok !== true) {
      const reason = gate && gate.reason === REASONS.LIMIT_MINUTE ? REASONS.LIMIT_MINUTE : gate && gate.reason === REASONS.LIMIT_DAY ? REASONS.LIMIT_DAY : null
      if (!reason) {
        audit({ outcome: REASONS.CONFIG_MISSING, stage: 'gate' })
        return denyResult(503, REASONS.CONFIG_MISSING, MSG.CONFIG_MISSING)
      }
      const seconds = retryAfterSeconds(reason, Number(now()))
      audit({ outcome: reason, stage: 'gate', retryAfter: seconds })
      return denyResult(429, reason, gate.message, { 'Retry-After': String(seconds) })
    }

    /* ⑦ 上游配置（fail-closed；**零扣费**）。 */
    const resolved = await aiUpstream.resolveUpstreamSecret(env)
    const upstreamReady =
      !!resolved && typeof resolved.key === 'string' && resolved.key !== '' && typeof resolved.base_url === 'string' && resolved.base_url !== ''
    if (!upstreamReady) {
      audit({ outcome: REASONS.CONFIG_MISSING, stage: 'upstream-config' })
      return denyResult(503, REASONS.CONFIG_MISSING, MSG.CONFIG_MISSING)
    }

    /* ⑧ 参考图 → 签名链（**不下载字节、不 base64 转发**；失败 ⇒ 503、零扣费）。
       `data_url` 形态在此**转存**（凍結順序不得變：解碼 → 魔數與 mime 一致〔不一致 ⇒ 400〕
       → 上傳 CloudBase → `getTempFileURL` 簽名鏈 → 上游 `image` 欄只拿簽名鏈）：
       解碼與魔數已在⑤ 的值域門判過（400 全在任何写入之前），此處重跑只为取字節；
       上傳失敗 ⇒ **折疊 503**（reason 仍是 `CONFIG_MISSING`，`message` 寫明「存儲不可用」
       而**非**「未配置」，運維不查錯方向）、**零扣费**；
       **上游後續失敗不刪已上傳對象**（內容尋址可被後續重用；源碼零刪除調用面），
       審計行恆記 `{stage:'upload', key_prefix, bytes}`（**零字節、零 data_url 片段**）。 */
    let imageUrl = ''
    if (payload.image) {
      let storageKey = payload.image.storage_key || ''
      if (payload.image.data_url) {
        const decoded = decodeImageDataUrl(payload.image.data_url)
        if (!decoded.ok) {
          /* 防御面：⑤ 已判过 ⇒ 正常不可达；真到这一步仍在任何写入之前 ⇒ 400 零扣费。 */
          audit({ outcome: REASONS.INVALID_ARGUMENT, stage: 'image-decode' })
          return denyResult(400, REASONS.INVALID_ARGUMENT, decoded.message)
        }
        const uploadKey = imageKeyOf(decoded.bytes, decoded.ext)
        const keyPrefix = uploadKey.slice(0, IMAGE_KEY_FAMILY.length + 2)
        let stored = null
        try {
          stored = await uploadImage(decoded.bytes, decoded.ext, env)
        } catch (error) {
          audit({ outcome: REASONS.CONFIG_MISSING, stage: 'upload', key_prefix: keyPrefix, bytes: decoded.bytes.length, detail: (error && error.name) || 'upload-failed' })
          return denyResult(503, REASONS.CONFIG_MISSING, MSG.STORAGE)
        }
        const fileID = stored ? text(stored.fileID) : ''
        if (!fileID) {
          audit({ outcome: REASONS.CONFIG_MISSING, stage: 'upload', key_prefix: keyPrefix, bytes: decoded.bytes.length, detail: 'no-file-id' })
          return denyResult(503, REASONS.CONFIG_MISSING, MSG.STORAGE)
        }
        audit({ outcome: 'OK', stage: 'upload', key_prefix: keyPrefix, bytes: decoded.bytes.length })
        storageKey = fileID
      }
      try {
        imageUrl = text(await resolveImageUrl(storageKey, env))
      } catch {
        imageUrl = ''
      }
      if (!imageUrl) {
        audit({ outcome: REASONS.CONFIG_MISSING, stage: 'image-url' })
        return denyResult(503, REASONS.CONFIG_MISSING, MSG.CONFIG_MISSING)
      }
    }

    if (typeof fetchImpl !== 'function') {
      audit({ outcome: REASONS.CONFIG_MISSING, stage: 'fetch' })
      return denyResult(503, REASONS.CONFIG_MISSING, MSG.CONFIG_MISSING)
    }

    /* ⑨ 预扣 10 金（**冪等鍵按嘗試序號派生**，見 `chargeIdemKeyOf` ／ 已知項 A；
       序號推導**在预扣之前**完成，讀不出 ⇒ fail-closed 503 零扣費；余额不足 ⇒ 402 零写入）。 */
    const refId = `${route}:${keyInfo.key_id}:${requestId}`
    const attempt = await nextAttemptNumber(keyInfo.uid, refId)
    if (!Number.isInteger(attempt) || attempt < 1) {
      /* 嘗試序號讀不出 ⇒ **絕不猜**（猜序號 1 會重放已退款鍵 ⇒ 白嫖面重開）；零扣費。 */
      audit({ outcome: REASONS.CONFIG_MISSING, stage: 'attempt-count' })
      return denyResult(503, REASONS.CONFIG_MISSING, MSG.CONFIG_MISSING)
    }
    const chargeIdemKey = chargeIdemKeyOf(keyInfo.key_id, requestId, attempt)
    const charge = await ledger.chargePoints({
      uid: keyInfo.uid,
      amount: CHARGE_AMOUNT,
      kind: ledger.FLOW_KINDS.CHARGE,
      ref_type: ledger.REF_TYPES.AI_IMAGE,
      ref_id: refId,
      idem_key: chargeIdemKey
    })
    if (!charge || charge.ok !== true) {
      if (charge && charge.reason === userConfig.REASONS.INSUFFICIENT_POINTS) {
        audit({ outcome: REASONS.INSUFFICIENT_POINTS, stage: 'charge', charged: false })
        return denyResult(402, REASONS.INSUFFICIENT_POINTS, MSG.INSUFFICIENT_POINTS)
      }
      audit({ outcome: REASONS.CONFIG_MISSING, stage: 'charge', charged: false })
      return denyResult(503, REASONS.CONFIG_MISSING, MSG.CONFIG_MISSING)
    }

    /* ⑩ 调上游（**失败一律退款 ＋ 502**，绝不伪装成功）。 */
    const upstreamUrl = `${resolved.base_url.replace(/\/+$/, '')}/${route}`
    const upstreamBody = { prompt: payload.prompt, model: text(resolved.model), n: 1 }
    if (payload.size !== undefined) upstreamBody.size = payload.size
    if (imageUrl) upstreamBody.image = imageUrl
    const timeoutMs = Number(resolved.timeout_ms) > 0 ? Number(resolved.timeout_ms) : DEFAULT_TIMEOUT_MS
    /* 凭据只在此组装、只进上游请求头；**不进日志、不进回包**。 */
    const upstreamAuth = ['Bearer', resolved.key].join(' ')

    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    let response = null
    try {
      response = await fetchImpl(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: upstreamAuth
        },
        body: JSON.stringify(upstreamBody),
        signal: controller ? controller.signal : undefined
      })
    } catch (error) {
      if (timer) clearTimeout(timer)
      const refunded = await safeRefund(keyInfo.uid, refId, chargeIdemKey)
      audit({ outcome: REASONS.UPSTREAM_ERROR, stage: 'fetch', status: 0, refunded, detail: (error && error.name) || 'fetch-failed' })
      return denyResult(502, REASONS.UPSTREAM_ERROR, MSG.UPSTREAM, {}, { status: 0 })
    }
    if (timer) clearTimeout(timer)

    const upstreamStatus = Number(response && response.status) || 0
    const failUpstream = async (stage, status, message) => {
      const refunded = await safeRefund(keyInfo.uid, refId, chargeIdemKey)
      audit({ outcome: REASONS.UPSTREAM_ERROR, stage, status, refunded })
      return denyResult(502, REASONS.UPSTREAM_ERROR, message || MSG.UPSTREAM, {}, { status })
    }

    let raw = ''
    try {
      raw = await response.text()
    } catch {
      return failUpstream('read', upstreamStatus)
    }
    if (!response || upstreamStatus < 200 || upstreamStatus >= 300) {
      /* 非 2xx：拿到响应体就把**错误体摘要**附在 message 末尾（`upstreamErrorDigestOf`
         零敏感：长随机串/base64 一律抹除、截 120 字；非 JSON ⇒ 摘要空 ⇒ **不附**、
         现有文案逐字不变；超时/网络错走上面的 fetch catch，本就不带体、文案亦不变）。 */
      let digest = ''
      try {
        digest = upstreamErrorDigestOf(JSON.parse(raw))
      } catch {
        digest = ''
      }
      return failUpstream(
        'status',
        upstreamStatus,
        digest ? `${MSG.UPSTREAM}（診斷：上游 ${upstreamStatus}；${digest}）` : undefined
      )
    }
    let upstreamJson = null
    try {
      upstreamJson = JSON.parse(raw)
    } catch {
      return failUpstream('non-json', upstreamStatus)
    }
    const image = imageOf(upstreamJson)
    if (!image) {
      /* 2xx 但无图：message 末尾附**键名轮廓**诊断（`shapeOutlineOf` 零值泄露；键集不变）。 */
      return failUpstream(
        'no-image',
        upstreamStatus,
        `${MSG.UPSTREAM}（診斷：上游 200 但無圖；形狀＝${shapeOutlineOf(upstreamJson)}）`
      )
    }

    /* ⑪ 成功：`commitUsage`（日 / 分鐘各 +1）→ 200。commitUsage 失败 ⇒ 退款 ＋ 503（已知项 B/G）。 */
    const usage = await aiUsage.commitUsage({ uid: keyInfo.uid })
    if (!usage || usage.ok !== true) {
      const refunded = await safeRefund(keyInfo.uid, refId, chargeIdemKey)
      audit({ outcome: REASONS.CONFIG_MISSING, stage: 'commit-usage', refunded })
      return denyResult(503, REASONS.CONFIG_MISSING, MSG.CONFIG_MISSING)
    }
    audit({ outcome: 'OK', stage: 'done', status: 200, idempotent: charge.idempotent === true })
    return {
      status: 200,
      body: {
        ok: true,
        image,
        charge: { points: CHARGE_AMOUNT, balance_after: charge.balance_after },
        usage: { today: usage.day, minute: usage.minute },
        idempotent: charge.idempotent === true
      },
      headers: {}
    }
  }
}

/** Vercel / 生产缺省实例（真 env ＋ 真 fetch ＋ 默认签名链实现）。 */
export default createAiRelay()