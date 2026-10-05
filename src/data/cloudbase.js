/**
 * 玺爱 · **CloudBase 数据源（读取面 v1：xiai_seals / xiai_faces / xiai_images 237 行 + 影像展示件）**
 * ----------------------------------------------------------------------------
 * 口径（逐字遵守冻结件，见 `scratch/xiai-cb-migrate/mapping.md` 与 `collections.md`）：
 *   · 环境与 liwu **同源**；envId **不在代码里写死**（唯一真源仍 `liwu/cloudbaserc.json`），
 *     前端只从构建期变量 `VITE_XIAI_CB_ENV_ID` 取；缺省/空 ⇒ **视为未配置 ⇒ 回落本地实现**；
 *   · 集合只碰 `xiai_` 前缀的三个（本单读取面）。安全规则由 Zang 侧落（匿名可读 / 管理员写）；
 *   · 鉴权：**匿名登录**（游客可读）。管理员写面**不在本单**；
 *   · 行形状**按 mapping.md**：源值逐字保留（含旧值 `战国` / `秦汉` / `UNKNOWN` / `DRAFT`），
 *     本层**不做任何业务值改写**（`ZHU_WEN→朱文` 一类是迁移脚本的活，不是读取面的活）；
 *     只做两件事：① NULL → 文本字段 `''`（数字/时间/对象列保 `null`）；② 补齐 xiai 侧既有别名键；
 *   · `provenance` 归档区（内含逐字 `record_json`）**默认不载入内存**（§2.2 明文「不做查询面」），
 *     如需可开 `VITE_XIAI_CB_KEEP_PROVENANCE`；
 *   · 影像展示件：**不做转码、不做切块** —— 直接取**已迁的展示件对象**（PNG / WebP）的临时链接，
 *     取回**整件字节**交给既有本机展示路径（块面 / 缩略面 / TIFF 转码面**另开单**）。
 *
 * 为什么这里 import `vue` 的 `shallowRef`：本单硬约束是「**页面与组件零改动**」，而页面读数据是
 * **同步**的（如 `SquareView` 的 `computed(() => seals.listSeals())`，服务层同步返回数组）。
 * 把云端快照放进一个 `shallowRef`：页面的 computed 求值时经由数据层读到它 ⇒ **依赖被自然追踪**，
 * 快照到位时页面**自动重算**，无需任何页面改动（这是本层唯一的响应式职责）。
 *
 * 失败一律**结构化 + 回落**（`{state, reason, message}`）：绝不拿空值 / 假数据冒充成功。
 */

import { shallowRef } from 'vue'
import { loadCloudBaseSdk } from './cloudbaseSdk.js'
/* **可疑空集判定（§3c）**要读**本地同集合**的现有行数：**只读**、零写入。
   `storage.js` 是全工程唯一碰 localStorage 的模块 ⇒ 本文件**只消费**它，
   **不自立**第二处存储访问实现（R-25）。 */
import { readKey, STORAGE_KEYS } from './storage.js'
/* 容器判定**不自立第二份实现**（R-25）：按字节魔数的那把尺子仍恰 1 处 ＝ `utils/image.js`。 */
import { sniffBytesMime } from '../utils/image.js'

/* ---------------------------------------------------------------------------
   1. 集合与口径常量（唯一一处定义点）
   --------------------------------------------------------------------------- */

/** 本单读取面涉及的四个集合（应用名 → CloudBase 集合名；**逐字**，见 mapping.md §0）。
 *  第 4 个 `correctionsPublic` ＝ **公开只读投影集合**（已采纳勘误的公开投影，
 *  匿名可读；本机镜像键见 `storage.js` 的 `correctionsPublic`）—— 它是「已采纳的勘误值
 *  全站一致展示」的唯一跨浏览器来源（`seals` / `faces` / `images` 三个键的口径一字未改）。 */
export const CLOUD_COLLECTIONS = Object.freeze({
  seals: 'xiai_seals',
  faces: 'xiai_faces',
  images: 'xiai_images',
  correctionsPublic: 'xiai_corrections_public',
  /* **值级公开摘要集合（本单合并面）**：一行 ＝ 一个 `(faceId, field, value)` 键的**值级摘要** ——
     `submits`（未 REJECTED 的提交人数）/ `endorses`（采信人数）/ `status` / `submitter_uids`（不透明
     uid 去重列表）；**零手机号**、uid 允许。它让「未采纳提交的公开摘要面」跨浏览器可见（他人在另一
     浏览器提交的 `PENDING` 值也能被列出并【採信】）；本机镜像键见 `storage.js` 的 `correctionSummaries`。
     取代此前尚未上线的 `xiai_endorsement_counts`（**不留两套公开面**）。 */
  correctionSummaries: 'xiai_correction_summaries'
})

/** 本层接管的本地集合键（其余键**一字不动**，仍走 `data/db.js` 既有本地实现）。 */
export const CLOUD_COLLECTION_KEYS = Object.freeze(Object.keys(CLOUD_COLLECTIONS))

/**
 * 分页页宽（CloudBase 客户端 `.get()` 有默认条数上限 ⇒ **必须分页**，不能假设「一次读完」）。
 * 取 100：任何已知上限（20 / 100 / 1000）下都不会漏行 —— 每页按**实际返回条数**推进游标。
 */
export const CLOUD_PAGE_SIZE = 100

/** 分页护栏（防止服务端异常时死循环；100 × 100 = 10000 行封顶，远大于 237）。 */
export const CLOUD_MAX_PAGES = 100

/* **v2 必修 2（分頁穩定次序）**：分頁**每一頁**都帶穩定次序 —— 按 `_id` 升序。
   為什麼非有不可：`skip/limit` 只在**全序**上才保證「窗口不重不漏」；不帶次序時服務端
   的構造次序一旦抖動，窗口就會重合 / 錯位（質檢實據：237 行讀成 223 唯一 / 14 重 / 14 漏）。 */
export const CLOUD_ORDER_FIELD = '_id'
export const CLOUD_ORDER_DIRECTION = 'asc'

/* **v2 必修 1（超時護欄）／v3 T1 調預算**：水合的**總預算**（預設 20 秒；可由構建期變數
   `VITE_XIAI_CB_TIMEOUT_MS` 配）。覆蓋「SDK 裝載 / `init` / 匿名登錄 / 每一頁查詢」全部階段：
   **任一階段超預算 ⇒ 判失敗**（`reason: 'TIMEOUT'`）—— 與 `SDK_UNAVAILABLE` /
   `ANONYMOUS_LOGIN_FAILED` **同一條失敗狀態機** ⇒ 數據層自動回落本地實現。
   **不得讓頁面無限 pending**（質檢實據：400 ms 後仍 pending ⇒ 長期空態）。

   **為什麼由 8 秒調到 20 秒（線上 E2E 實據 2026-09-28）**：冷緩存首次加載的**最壞路徑**
   ＝「獨立 SDK 塊（實測 758,535 B ＝ 750.5 KiB，另存 `assets/index.esm-*.js`，與主 bundle 分離）
   ＋ `init` ＋ 匿名登錄 ＋ 三集合分頁（每頁 79 行、服務端上限 20 ⇒ 4 頁/集合，共 12 次查詢）」。
   750 KiB 在 3 Mbit/s（≈375 KiB/s）的移動網上**光下載就 ~2 s**、在 1 Mbit/s（≈125 KiB/s）上
   **~6 s**、在 500 kbit/s（≈62 KiB/s）上 **~12 s**；再疊 TLS/HTTP2 建連（0.2–2 s）、
   `init`（<50 ms）、匿名登錄（0.3–2 s）、12 次分頁查詢（每次 0.1–0.8 s ⇒ 1.2–9.6 s）
   ⇒ **典型 3–10 s、冷緩存弱網 15–25 s**。8 秒預算會把「本來能成功」的加載判成 TIMEOUT
   ⇒ 靜默回落 8 行本機示範資料（線上實據：廣場穩定顯示「共 8 枚」而雲端實有 79 枚）。
   20 秒 = 上述最壞路徑的**上四分位再加餘量**，同時仍是**有界**的（不會無限 pending）。
   取值參照不是猜的：`VITE_XIAI_CB_TIMEOUT_MS` 由構建期注入，`cloudBaseTimeoutMs()` 只認
   正數有限值（見該函數），配置缺失 / 非法一律回落到本常量。 */
export const CLOUD_HYDRATE_TIMEOUT_MS = 20000

/**
 * **按階段預算（v3 T1）** —— 讓「SDK 塊下載 / 匿名登錄 / 單頁查詢」**各自不被誤判為整體超時**。
 *
 * 形態：`每階段的實際等待上限 ＝ min(該階段預算, 本輪總預算剩餘)`。
 *   · 為什麼要分階段：8 秒總預算的失敗**幾乎總發生在 SDK 塊下載**（最大、最慢、冷緩存），
 *     而後面的登錄與查詢根本沒機會跑；只報一句「整體超時」也分不出是**慢**還是**壞**。
 *     分階段後：`CloudTimeoutError.stage`（`sdk-load` / `anonymous-login` / `<集合>@<游標>`）
 *     與狀態上的 `timeoutStage` 直接把**是哪一段**寫清楚。
 *   · 為什麼仍受總預算約束：每階段的上限還要 **min 上「本輪剩餘」** ⇒ 總牆鐘仍被總預算釘住
 *     （不會因為「每階段各自 12 秒」把一次加載拖成 3 分鐘）。
 *   · 取值：`sdk-load` 12000（750 KiB ⇒ 62 KiB/s 的鏈路仍能在本階段內下完）、
 *     `anonymous-login` 8000（匿名登錄是單次往返，8 秒足夠；超過即視為鑑權面異常）、
 *     `query` 8000（**單頁**查詢；4 頁 × 8000 不會發生 —— 總預算會先到）。
 */
export const CLOUD_STAGE_BUDGET_MS = Object.freeze({
  'sdk-load': 12000,
  'anonymous-login': 8000,
  query: 8000
})

/**
 * **冷啟動自動重試（v3 T1）**：`sdk-load` 階段超時 ⇒ **自動再來一輪**（預算見下），
 * 且**這一輪不寫 `failed`**（狀態維持 `pending / HYDRATING_RETRY` ⇒ 視圖維持載入態，
 * **不回落本地種子**）。為什麼只認 `sdk-load`、只重試一次：
 *   · SDK 塊是**可緩存的靜態資源** ⇒ 第一次超時時那次下載**仍在後台繼續**（`withBudget`
 *     只放棄等待、不取消請求），第二輪多半命中瀏覽器 HTTP 緩存 ⇒ **第二輪是更便宜的一輪**；
 *   · 登錄 / 查詢超時代表**服務端或鑑權面異常**，重試只是把等待翻倍（**不重試**：
 *     立即走既有 `failed / TIMEOUT` ⇒ 回落本地，這正是「不把立即失敗拖成長等待」的守則）；
 *   · 只一次：最壞牆鐘 ＝ 首輪 `sdk-load` 上限 12 s ＋ 等待 0.8 s ＋ 重試輪 12 s ≈ **25 s**，
 *     之後仍是既有的 `failed / TIMEOUT` 回落（有界，不會無限重試 / 無限 pending）。
 */
export const CLOUD_HYDRATE_RETRY_BUDGET_MS = 12000
export const CLOUD_HYDRATE_RETRY_DELAY_MS = 800
/** 只有這幾個階段的超時會觸發自動重試（見上）。 */
export const CLOUD_RETRYABLE_TIMEOUT_STAGES = Object.freeze(['sdk-load'])

/* **Zang 實測裁定（fileID 形態）**：
   ✅ 成功形態 ＝ `cloud://<envId>.<bucket>/<對象鍵>`（真瀏覽器實測：SUCCESS + 簽名鏈接 + `<img>` 真載入）；
   ❌ 失敗形態 ＝ `cloud://<envId>/<對象鍵>` 與**裸對象鍵** ⇒ `STORAGE_FILE_NONEXIST`
   （報的是「文件不存在」而非權限錯 ⇒ 極易被誤當「無圖」靜默吞掉）。
   ⇒ 本層**一律按「envId + bucket + 對象鍵」構造**；bucket **走配置**（`VITE_XIAI_CB_STORAGE_BUCKET`），
   默認值 ＝ 下面這個**唯一一處**字面量（全倉只此一處，散落多處即判負）。 */
export const CLOUD_STORAGE_BUCKET_DEFAULT = '6c69-liwu-d8gek6jjdab1d087c-1463728495'

/** 影像展示件对象键形态（mapping.md §3：`xiai/images/` 加 sha 前两位 加 `/` 加 sha 加 点加扩展名）。 */
export const IMAGE_OBJECT_KEY_PATTERN = /^xiai\/images\/([0-9a-f]{2})\/([0-9a-f]{64})\.(png|webp)$/

/** 展示件容器 ↔ 扩展名（校验 storage_key 与行内 mime 是否自洽；**不改写**，只判）。 */
export const IMAGE_EXT_MIME = Object.freeze({ png: 'image/png', webp: 'image/webp' })

/** 对象字节内存缓存条数上限（同一枚印章的卡片 + 详情页会各取一次 ⇒ 免重复下载）。 */
export const CLOUD_OBJECT_CACHE_LIMIT = 64

/* ---------------------------------------------------------------------------
   2. 构建期配置（字面量取值 ⇒ Vite 静态替换认得；Node 下缺 `import.meta.env` 不报错）
   --------------------------------------------------------------------------- */

function readEnv() {
  const env = import.meta.env || {}
  return {
    source: typeof env.VITE_XIAI_DATA_SOURCE === 'string' ? env.VITE_XIAI_DATA_SOURCE.trim() : '',
    envId: typeof env.VITE_XIAI_CB_ENV_ID === 'string' ? env.VITE_XIAI_CB_ENV_ID.trim() : '',
    region: typeof env.VITE_XIAI_CB_REGION === 'string' ? env.VITE_XIAI_CB_REGION.trim() : '',
    /** 可选：`cloud://<envId>.<bucket>/` **完整前缀覆盖**（最高优先；配了就用它，不再拼 bucket）。 */
    storagePrefix:
      typeof env.VITE_XIAI_CB_STORAGE_PREFIX === 'string' ? env.VITE_XIAI_CB_STORAGE_PREFIX.trim() : '',
    /** bucket 的**原始读数**（`undefined` ＝ 未提供 ⇒ 走默认桶；`''`/空白 ＝ **显式置空 ⇒ 配置错误**）。 */
    storageBucket: env.VITE_XIAI_CB_STORAGE_BUCKET,
    /** 可选：水合总预算（毫秒，字符串取回；解析见 `cloudBaseTimeoutMs()`）。 */
    timeoutMs: typeof env.VITE_XIAI_CB_TIMEOUT_MS === 'string' ? env.VITE_XIAI_CB_TIMEOUT_MS.trim() : '',
    keepProvenance: String(env.VITE_XIAI_CB_KEEP_PROVENANCE || '').toLowerCase() === 'true'
  }
}

/** 配置读数（**不含任何密钥**；envId 不是密钥，但也不在代码里写死 —— 只从构建期变量取）。 */
export function cloudBaseConfig() {
  const env = readEnv()
  return {
    source: env.source === 'cloudbase' ? 'cloudbase' : 'local',
    envId: env.envId,
    region: env.region,
    storagePrefix: env.storagePrefix === '' ? '' : env.storagePrefix.replace(/\/*$/, '/'),
    storageBucket: env.storageBucket,
    timeoutMs: env.timeoutMs,
    keepProvenance: env.keepProvenance
  }
}

/**
 * 影像存储配置读数（**fileID 构造的唯一真源**；诊断 / 取证 / 自检都可读）。
 *
 * 口径（Zang 实测裁定）：
 *   · `VITE_XIAI_CB_STORAGE_PREFIX` 显式给出 ⇒ **完整前缀覆盖**（`source: 'prefix'`），最高优先；
 *   · 否则 ⇒ `cloud://<envId>.<bucket>/`，bucket 取 `VITE_XIAI_CB_STORAGE_BUCKET`
 *     （`source: 'bucket-env'`）或**默认桶** `CLOUD_STORAGE_BUCKET_DEFAULT`（`source: 'bucket-default'`）；
 *   · **bucket 被显式置空 / 空白 ⇒ 配置错误**（`error: 'STORAGE_BUCKET_MISSING'`）：
 *     此时 `cloudBaseFileIdOf()` 返回 `''`、影像读取走**显式结构化失败**（绝不静默成「无图」），
 *     并把该错误**上报到状态**（`cloudBaseStatus().storage.error`），便于线上排障。
 *   · envId 缺位 ⇒ 整体视为未配置（水合根本不启动）。
 * @returns {{envId:string, bucket:string, prefix:string, source:string, error:string, message:string}}
 */
export function cloudBaseStorageConfig() {
  const env = readEnv()
  const explicitPrefix = env.storagePrefix === '' ? '' : env.storagePrefix.replace(/\/*$/, '/')
  if (explicitPrefix) {
    return { envId: env.envId, bucket: '', prefix: explicitPrefix, source: 'prefix', error: '', message: '' }
  }
  const provided = typeof env.storageBucket === 'string'
  const raw = provided ? env.storageBucket.trim() : ''
  if (provided && raw === '') {
    return {
      envId: env.envId,
      bucket: '',
      prefix: '',
      source: 'bucket-env',
      error: 'STORAGE_BUCKET_MISSING',
      message: '影像儲存空間未配置（bucket 被置空），影像暫時無法顯示；請檢查 VITE_XIAI_CB_STORAGE_BUCKET'
    }
  }
  const bucket = raw || CLOUD_STORAGE_BUCKET_DEFAULT
  return {
    envId: env.envId,
    bucket,
    prefix: `cloud://${env.envId}.${bucket}/`,
    source: provided ? 'bucket-env' : 'bucket-default',
    error: '',
    message: ''
  }
}

/**
 * 影像存储配置错误的**结构化拒绝**（`null` ＝ 无错误 ⇒ 放行）。
 * 用途：影像读取路径在**构造 fileID 之前**先过这道门 ⇒ 配置错误**显式失败**，不静默成「无图」。
 * @returns {null|{ok:false, reason:'STORAGE_BUCKET_MISSING', message:string}}
 */
export function cloudBaseFileIdDenial() {
  const storage = cloudBaseStorageConfig()
  if (!storage.error) return null
  return { ok: false, reason: storage.error, message: storage.message }
}

/**
 * 水合总预算（毫秒）。口径：`VITE_XIAI_CB_TIMEOUT_MS` 缺失 / 非正数 / 非数字 ⇒
 * 回落默认 `CLOUD_HYDRATE_TIMEOUT_MS`（20 秒；为什么是 20 s 见该常量的头注）；**不设「0 ＝ 無限」的暗门**
 * （那样的配置错误会让页面又变回「无限 pending」）。
 */
export function cloudBaseTimeoutMs() {
  const raw = cloudBaseConfig().timeoutMs
  const parsed = Number(raw)
  if (raw === '' || !Number.isFinite(parsed) || parsed <= 0) return CLOUD_HYDRATE_TIMEOUT_MS
  return Math.round(parsed)
}

/** 是否**已配置** CloudBase 读取面（开关打开 **且** envId 非空）⇒ 未配置即回落本地实现。 */
export function cloudBaseConfigured() {
  const config = cloudBaseConfig()
  return config.source === 'cloudbase' && config.envId !== ''
}

/* ---------------------------------------------------------------------------
   3. 状态（响应式；页面零改动所需）
   --------------------------------------------------------------------------- */

const stateRef = shallowRef('off') /* off | pending | ready | failed */
const snapshotRef = shallowRef(null)
const statusRef = shallowRef({
  state: 'off',
  reason: 'NOT_CONFIGURED',
  message: '未配置 CloudBase 数据源，使用本地实现',
  envId: '',
  counts: { seals: 0, faces: 0, images: 0, correctionsPublic: 0, correctionSummaries: 0 },
  /* **空集诊断（§3c）**：`emptyVerified` ＝ 诚实空态（云端 0 行 + 本地也空 ⇒ 不回落）；
     `emptySuspect` ＝ 可疑空集（云端 0 行 + 本地有数据 ⇒ 已走失败状态机回落本地）。 */
  emptyVerified: [],
  emptySuspect: [],
  /* **v3 T1（阶段预算 / 冷启动重试）读数**：`attempt` ＝ 本轮是第几轮（1 首轮 / 2 自动重试轮）；
     `timeoutStage` ＝ **最近一次阶段超时的阶段名**（`sdk-load` / `anonymous-login` / `<集合>@<游标>`）。
     生命周期（**与实现的真实取值序列逐字对齐**；读数见 `qa/probes/probe-c-timeoutstage.mjs` 的
     ①②③④ 四处采样，本字段**不采信旧口径**）：
       ① 阶段超时**即写入** —— `scheduleHydrationRetry()`（重试窗口内）与 `fail('TIMEOUT')`（终态）都带它；
       ② **重试窗口内仍看得到**「是哪个阶段触发了本次重试」（如 `sdk-load`）；
       ③ **新一轮起跑即被本轮清空** —— `hydrate()` 的 `pending` 状态写入自带 `timeoutStage: ''`
          ⇒ 重试轮进行中该字段为 `''`（此时归因由 `reason: 'HYDRATING_RETRY'` ＋ `attempt: 2` 承载）；
       ④ 被下一次超时**覆盖**；成功落定（`ready`）或 `resetCloudBaseSource()` 亦清空；
          终态 `failed / TIMEOUT` 上**保留**触发该次失败的那个阶段（排障要看的就是它）。
     空串 ⇒ 当下不在「重试窗口 / 超时终态」位置，或自上次清空以来没有发生过阶段超时。 */
  attempt: 0,
  timeoutStage: '',
  fetchedAt: ''
})

function setStatus(state, patch = {}) {
  stateRef.value = state
  const storage = cloudBaseStorageConfig()
  /* **影像存储配置随状态一并上报**（Zang 裁定）：bucket 被显式置空 ⇒
     `cloudBaseStatus().storage.error === 'STORAGE_BUCKET_MISSING'` 在**每个**状态读数上都看得见
     （不必等「图没出来」才反推；也绝不让配置错误静默成「无图」）。 */
  statusRef.value = {
    ...statusRef.value,
    state,
    storage,
    warnings: storage.error ? [`${storage.error}: ${storage.message}`] : [],
    ...patch
  }
}

/** 数据源状态读数（**响应式**；诊断 / 取证 / 页面空态均可读）。 */
export function cloudBaseStatus() {
  return statusRef.value
}

/** 读取面是否由云端接管（`pending` 也算接管 ⇒ 不回落到本地种子，见 `db.js::readCollection`）。 */
export function cloudBaseActive() {
  const state = stateRef.value
  return state === 'pending' || state === 'ready'
}

/**
 * **数据层读取入口**（`data/db.js` 只消费这一个函数；**同步、零网络**）。
 * @param {string} collectionKey 本地集合键（`seals` / `faces` / `images`）
 * @returns {{state:string, rows:Array<object>|null}} `ready` ⇒ 云端行；其余 ⇒ `rows: null`
 */
export function cloudBaseReadOf(collectionKey) {
  if (!CLOUD_COLLECTION_KEYS.includes(collectionKey)) return { state: 'off', rows: null }
  const state = stateRef.value
  if (state !== 'ready') return { state, rows: null }
  const snapshot = snapshotRef.value
  if (!snapshot) return { state, rows: null }
  const rows = snapshot[collectionKey]
  return { state, rows: Array.isArray(rows) ? rows : [] }
}

/** 云端快照（`ready` 后可用；**只读**）。 */
export function cloudBaseSnapshot() {
  return snapshotRef.value
}

/* ---------------------------------------------------------------------------
   3b. **超时护栏（v2 必修 1 ／ v3 T1 分阶段）**：预算内必须落定；超时即判失败 ⇒ 归入既有失败状态机
   ---------------------------------------------------------------------------
   形态纪律：`withBudget()` 包住**每一个**可能不落定的 await（SDK 装载 / 匿名登录 / 单页查询），
   每阶段的等待上限 ＝ **min(该阶段预算, 总预算剩余)** ⇒ ① 单阶段不会被误判成整体超时
   （见 `CLOUD_STAGE_BUDGET_MS`），② 总墙钟仍被总预算钉住（量级上）＋ 少量计时器开销。
   超时**不向外抛**：`startHydrationRound()` 的 catch 把它转成 `failed / TIMEOUT`
   （`sdk-load` 阶段先自动重试一轮，见 `CLOUD_HYDRATE_RETRY_*`），
   与 `SDK_UNAVAILABLE` / `ANONYMOUS_LOGIN_FAILED` 走**同一条**回落路径（数据层 ⇒ 本地实现）。
   --------------------------------------------------------------------------- */

/** 超时判负的专用错误（**不向外抛**给调用方；只在内部被转成结构化 `failed` 状态）。 */
export class CloudTimeoutError extends Error {
  constructor(stage, budgetMs) {
    super(`CloudBase 階段「${stage}」超時（上限 ${budgetMs} ms）`)
    this.name = 'CloudTimeoutError'
    this.stage = stage
    this.budgetMs = budgetMs
  }
}

/**
 * **阶段预算解析（纯函数，可单测）**：`min(该阶段预算, 本轮总预算剩余)`。
 *
 * 阶段名口径：`sdk-load` / `anonymous-login` / 其余一律按**单页查询**（`<集合>@<游标>`，如
 * `xiai_seals@0`）⇒ 取 `query` 预算。
 * @param {string} stage 阶段名
 * @param {number} remainingMs 本轮的剩余预算（毫秒）
 * @returns {number} 该阶段实际等待上限（毫秒；≤ 0 ⇒ 调用方**立刻**判超时、不发起该阶段）
 */
export function cloudStageBudgetMs(stage, remainingMs) {
  const left = Number(remainingMs)
  if (!Number.isFinite(left) || left <= 0) return 0
  const name = String(stage || '')
  const key = name === 'sdk-load' || name === 'anonymous-login' ? name : 'query'
  const cap = CLOUD_STAGE_BUDGET_MS[key]
  return Math.min(Number.isFinite(cap) && cap > 0 ? cap : left, left)
}

/**
 * 在**阶段预算 ∧ 总预算剩余**内等待某阶段（等待上限见 `cloudStageBudgetMs()`）。
 * 剩余不足（≤ 0）⇒ **立刻**判超时、**不发起**该阶段（避免"超时后还继续发请求"）。
 * `deadline === 0` ⇒ 视为未设预算（不设限；只在测试里出现）。
 */
function withBudget(promise, deadline, stage) {
  if (!deadline) return Promise.resolve(promise)
  const ms = cloudStageBudgetMs(stage, deadline - Date.now())
  if (ms <= 0) return Promise.reject(new CloudTimeoutError(stage, 0))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CloudTimeoutError(stage, ms)), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/* ---------------------------------------------------------------------------
   3c. **可疑空集（CLOUD_EMPTY_SUSPECT）**：云端 0 行 ⇒ 必须**分辨**「真空」还是「被挡」
   ---------------------------------------------------------------------------
   为什么非有不可（真环境实测 + TCB 行为）：CloudBase 数据库**安全规则对未授权读不报错，
   而是静默返回 0 行**；而本层原先只在 `QUERY_FAILED`（真抛错）时回落 ⇒ 万一根权限被改 /
   环境配错，线上会稳定显示**空广场且无错误信号**（静默失败面，比报错更难查）。
   判据（机械可判，只看两个读数 —— 云端行数 / 本地同集合行数）：
     · 云端某集合读到 **0 行** 且**本地同集合有数据** ⇒ 判为**可疑** ⇒ reason
       `CLOUD_EMPTY_SUSPECT` ⇒ **走既有失败状态机回落本地实现**（与 `QUERY_FAILED` **同一路径**：
       `fail()` ⇒ `failed` ⇒ `db.js::readCollection` 的非 ready 分支），并把诊断字段
       （集合名 / 云端行数 / 本地行数）**上报到状态**（`status.emptySuspect`）；
     · 云端 **0 行** 且**本地同集合也为空** ⇒ **诚实空态**：`ready`、该集合 0 行、
       **不回落**（本地无数据可信、回落只会把**本机种子数据**当云端数据交出 ⇒ 禁止）；
       只在状态里留痕（`status.emptyVerified`）。
   纪律：本判定**只读不写** —— 读本地走 `readKey()`，**不调** `ensureSeed()`、**不灌**种子、
   **不写** localStorage；不改变 v2 既有语义（超时护栏 / fileID 形态 / 分页稳定次序 /
   本地同 `_id` 覆盖层**一字未动**）；只影响 `seals` / `faces` / `images` 三个集合。
   **例外（r2 读面接线）**：公开投影集合 `correctionsPublic` **豁免**本判定（见
   `CLOUD_EMPTY_VERDICT_EXEMPT`）—— 它的本机行只是自写的展示缓存，云端 0 行是合法空态，
   不得据此判可疑、更不得让整站回落本地。
   --------------------------------------------------------------------------- */

/** 可疑空集的**结构化 reason**（与 `QUERY_FAILED` 共用同一条失败状态机）。 */
export const CLOUD_EMPTY_SUSPECT = 'CLOUD_EMPTY_SUSPECT'

/**
 * **不参与「可疑空集 ⇒ 回落」判定的集合**（r2 读面接线新增）。
 *
 * 为什么：`seals` / `faces` / `images` 是**藏品本体**——云端 0 行而本机有数据，意味着
 * 读权限 / 配置被挡（可疑），必须回落本地而不是显示空广场。而 `correctionsPublic` 是
 * **公开投影面**：它的「本机数据」只是我们自己写的**展示缓存**（采纳镜像），云端 0 行
 * 是**合法空态**（还没有任何采纳，或投影集合尚未建立）⇒ 若按同一判据判可疑，会把
 * 「本机缓存有一行、云端还没同步」误判成权限事故、进而**让整站回落本地种子**（把三个
 * 本体集合一起拖下水）。故本集合**恒走诚实空态**（不回落、不冒充）。
 */
export const CLOUD_EMPTY_VERDICT_EXEMPT = Object.freeze(['correctionsPublic', 'correctionSummaries'])

/**
 * 本地同集合的**现有行数**（**只读**：不灌种子、不写存储、不碰其它集合）。
 * @param {string} collectionKey 本地集合键（`seals` / `faces` / `images`）
 * @returns {number} 行数（非本层接管的键 / 非数组 / 缺键 ⇒ 0）
 */
export function cloudBaseLocalRowCount(collectionKey) {
  if (!CLOUD_COLLECTION_KEYS.includes(collectionKey)) return 0
  const storageKey = STORAGE_KEYS[collectionKey]
  if (!storageKey) return 0
  const rows = readKey(storageKey)
  return Array.isArray(rows) ? rows.length : 0
}

/**
 * 云端读数的**空集裁定**（诊断字段：集合名 / 云端行数 / 本地行数）。
 *
 * `exempt`：本集合是否**豁免**可疑判定（见 `CLOUD_EMPTY_VERDICT_EXEMPT` —— 公开投影面
 * 恒走诚实空态）。豁免集合 `suspect` 恒为 `false`。
 * @param {string} collectionKey 本地集合键
 * @param {Array<object>} cloudRows 本次云端读回的行
 * @returns {{key:string, collection:string, cloud:number, local:number, suspect:boolean, exempt:boolean}}
 *   `suspect === true` ⇒ 云端 0 行而本地有数据（可疑 ⇒ 回落）；`cloud === 0 && !suspect`
 *   ⇒ 诚实空态（不回落）。
 */
export function cloudEmptyVerdict(collectionKey, cloudRows) {
  const cloud = Array.isArray(cloudRows) ? cloudRows.length : 0
  const local = cloudBaseLocalRowCount(collectionKey)
  const exempt = CLOUD_EMPTY_VERDICT_EXEMPT.includes(collectionKey)
  return {
    key: collectionKey,
    collection: CLOUD_COLLECTIONS[collectionKey] || '',
    cloud,
    local,
    suspect: !exempt && cloud === 0 && local > 0,
    exempt
  }
}

/* ---------------------------------------------------------------------------
   4. 行形状归一（**按 mapping.md**；只做空值与别名，不做业务值改写）
   --------------------------------------------------------------------------- */

const text = (value) => (value === null || value === undefined ? '' : String(value))
/** 取第一个**确实有值**的键（注意：`0` 是合法值 ⇒ 不得用 `||` 兜底把它吃掉）。 */
const firstOf = (...values) => values.find((value) => value !== undefined && value !== null)
const num = (value) => (value === null || value === undefined || value === '' ? null : Number(value))
const intOrNull = (value) => {
  const parsed = num(value)
  return parsed === null || !Number.isFinite(parsed) ? null : Math.round(parsed)
}
const boolOrFalse = (value) => value === true

/** 归档区（`provenance`）按开关剥离；**其余键逐字保留**。 */
function withoutArchive(doc, keepProvenance) {
  if (keepProvenance) return { ...doc }
  const out = { ...doc }
  delete out.provenance
  return out
}

/**
 * 印章行（`xiai_seals` → 本地 `seals` 行形状，见 mapping.md §2.1）。
 * `stamp_id` / `id` 一律字符串；文本 NULL ⇒ `''`；`shape` / `author` 缺列 ⇒ `''`（**不臆造**）。
 */
export function normalizeSealRow(doc, options = {}) {
  const row = withoutArchive(doc || {}, options.keepProvenance === true)
  const stampId = text(firstOf(row.stamp_id, row.id))
  return {
    ...row,
    _id: text(row._id),
    stamp_id: stampId,
    id: stampId,
    sealGroupId: text(row.sealGroupId),
    seal_name: text(row.seal_name),
    name: text(row.seal_name),
    transcription: text(row.transcription),
    dynasty: text(row.dynasty),
    seal_type: text(row.seal_type),
    category: text(row.seal_type),
    seal_style: text(row.seal_style),
    material: text(row.material),
    shape: text(row.shape),
    author: text(row.author),
    asset_kind: text(row.asset_kind),
    review_status: text(row.review_status),
    source: text(row.source),
    uploaded_by: text(row.uploaded_by),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at)
  }
}

/** 印面行（`xiai_faces` → 本地 `faces` 行形状，见 mapping.md §4）。 */
export function normalizeFaceRow(doc, options = {}) {
  const row = withoutArchive(doc || {}, options.keepProvenance === true)
  const sealId = text(firstOf(row.sealId, row.stamp_id))
  const id = text(firstOf(row.id, row._id))
  return {
    ...row,
    _id: text(row._id),
    id,
    sealId,
    stamp_id: sealId,
    kind: text(row.kind),
    face_image_id: row.face_image_id === null || row.face_image_id === undefined ? null : String(row.face_image_id),
    edge_image_ids: Array.isArray(row.edge_image_ids) ? row.edge_image_ids.map((item) => String(item)) : [],
    material: text(row.material),
    seal_name: text(row.seal_name),
    dynasty: text(row.dynasty),
    seal_type: text(row.seal_type),
    transcription: text(row.transcription),
    face_style: text(row.face_style),
    author: text(row.author),
    created_at: text(row.created_at),
    updated_at: text(firstOf(row.updated_at, row.created_at))
  }
}

/**
 * 影像行（`xiai_images` → 本地 `images` 行形状，见 mapping.md §3）。
 * 关键读取面字段**逐字读回**：`storage`（既有取值 `server`）、`storage_key`、`binary_migrated`、
 * `authority_rel_path`（空串）、`sha256`（digest 锚）；缺列的四个色彩事实键 ⇒ `null`（**不猜**）。
 */
export function normalizeImageRow(doc, options = {}) {
  const row = withoutArchive(doc || {}, options.keepProvenance === true)
  const stampId = text(firstOf(row.stamp_id, row.sealId))
  const id = text(row.id || row._id)
  return {
    ...row,
    _id: text(row._id),
    id,
    stamp_id: stampId,
    sealId: stampId,
    kind: text(row.kind),
    seq: intOrNull(row.seq),
    sha256: text(row.sha256),
    bytes: num(row.bytes),
    bytesLength: num(firstOf(row.bytesLength, row.bytes)),
    width: num(row.width),
    height: num(row.height),
    colorMode: text(firstOf(row.colorMode, row.color_mode)),
    color_mode: text(firstOf(row.color_mode, row.colorMode)),
    colorType: row.colorType === undefined ? null : row.colorType,
    bitDepth: row.bitDepth === undefined ? null : row.bitDepth,
    paletteEntries: row.paletteEntries === undefined ? null : row.paletteEntries,
    neutral: row.neutral === undefined ? null : row.neutral,
    mime: text(row.mime),
    ownerType: text(row.ownerType),
    ownerId: text(row.ownerId),
    storage: text(row.storage),
    storage_key: text(row.storage_key),
    authority_rel_path: text(row.authority_rel_path),
    binary_migrated: boolOrFalse(row.binary_migrated),
    source: text(row.source),
    uploaded_by: text(row.uploaded_by),
    created_at: text(row.created_at)
  }
}

/**
 * **公开勘误投影行**（`xiai_corrections_public` → 本机 `corrections-public` 行形状）。
 *
 * 口径：本集合是**已采纳勘误的公开投影**（匿名可读、只读），行只承载展示所需的最少字段；
 * 身份 / 奖励 / 审阅人等敏感字段**不在本集合**（由写入侧裁剪，读面不臆造）。
 * 归一（只做空值与别名，不做业务值改写）：
 *   · `faceId` / `sealId` / `stamp_id` 三个归属键补别名（同值）；
 *   · 文本 NULL ⇒ `''`；`reviewed_at` 空 ⇒ 回落 `created_at`；
 *   · `status` **缺键 ⇒ 按 `'ACCEPTED'` 归一**（本集合的契约就是「已采纳投影」；
 *     显式给了别的状态值则**逐字保留** ⇒ 展示侧仍按 `ACCEPTED` 过滤，`PENDING` 不参与）。
 */
export function normalizePublicCorrectionRow(doc, options = {}) {
  const row = withoutArchive(doc || {}, options.keepProvenance === true)
  const id = text(firstOf(row.id, row._id))
  const faceId = text(firstOf(row.faceId, row.face_id))
  const sealId = text(firstOf(row.sealId, row.seal_id, row.stamp_id))
  return {
    ...row,
    _id: text(row._id),
    id,
    faceId,
    face_id: faceId,
    sealId,
    seal_id: sealId,
    stamp_id: text(firstOf(row.stamp_id, sealId)),
    field: text(row.field),
    field_label: text(row.field_label),
    value: text(row.value),
    status: text(firstOf(row.status, 'ACCEPTED')),
    reviewed_at: text(firstOf(row.reviewed_at, row.updated_at, row.created_at)),
    created_at: text(row.created_at)
  }
}

/**
 * **值级公开摘要行**（`xiai_correction_summaries` → 本机 `correction-summaries` 行形状）。
 *
 * 口径：本集合是**未采纳提交的公开脱敏摘要面**（匿名可读、只读），一行 ＝ 一个
 * `(faceId, field, value)` 键的**值级摘要**（`submits` / `endorses` / `status` / `submitter_uids`）；
 * **零手机号**、uid 允许（`submitter_uids` 是不透明 uid 列表，由写入侧裁剪，读面不臆造）。
 * 归一（只做空值与别名，不做业务值改写）：
 *   · `faceId` / `sealId` / `stamp_id` 三个归属键补别名（同值）；
 *   · 文本 NULL ⇒ `''`；`submits` / `endorses` 缺键 / 非数 ⇒ `0`（**正向数值护栏**，不冒充有计数）；
 *   · `submitter_uids` 归一为字符串数组（缺键 / 非数组 ⇒ `[]`）；
 *   · `status` 缺键 ⇒ `'PENDING'`；`schema` 缺键 ⇒ `'xiai-correction-summaries-v1'`。
 */
export function normalizeCorrectionSummaryRow(doc, options = {}) {
  const row = withoutArchive(doc || {}, options.keepProvenance === true)
  const faceId = text(firstOf(row.faceId, row.face_id))
  const sealId = text(firstOf(row.sealId, row.seal_id, row.stamp_id))
  const submits = Number(row.submits)
  const endorses = Number(row.endorses)
  const uids = Array.isArray(row.submitter_uids)
    ? row.submitter_uids.map((item) => text(item)).filter((item) => item !== '')
    : []
  return {
    ...row,
    _id: text(row._id),
    faceId,
    face_id: faceId,
    sealId,
    seal_id: sealId,
    stamp_id: text(firstOf(row.stamp_id, sealId)),
    field: text(row.field),
    value: text(row.value),
    submits: Number.isFinite(submits) && submits > 0 ? Math.round(submits) : 0,
    endorses: Number.isFinite(endorses) && endorses > 0 ? Math.round(endorses) : 0,
    status: text(firstOf(row.status, 'PENDING')),
    submitter_uids: uids,
    updated_at: text(firstOf(row.updated_at, row.created_at)),
    schema: text(firstOf(row.schema, 'xiai-correction-summaries-v1'))
  }
}

const NORMALIZERS = Object.freeze({
  seals: normalizeSealRow,
  faces: normalizeFaceRow,
  images: normalizeImageRow,
  correctionsPublic: normalizePublicCorrectionRow,
  correctionSummaries: normalizeCorrectionSummaryRow
})

/* ---------------------------------------------------------------------------
   5. 查询（分页读全表；响应形状容错）
   --------------------------------------------------------------------------- */

/**
 * 从 SDK 的查询响应里取行数组。合法形态：`{data: [...]}` / `{data: {list: [...]}}` /
 * `{result: {data: [...]}}` / `[...]`；认不出 ⇒ `[]`（**明确空集，不猜**）。
 */
export function rowsOfReply(reply) {
  if (!reply) return []
  if (Array.isArray(reply)) return reply
  if (Array.isArray(reply.data)) return reply.data
  const data = reply.data || reply.result || null
  if (data && Array.isArray(data.list)) return data.list
  if (data && Array.isArray(data.data)) return data.data
  if (Array.isArray(reply.list)) return reply.list
  return []
}

/**
 * 分页读某个集合的**全部**行（**v2 必修 2：稳定次序**）。
 *
 * 次序口径：**每一页**都带 `orderBy(_id, asc)`。理由（机械可判）：`skip/limit` 的分页窗口
 * 只有在**全序**上才「无重无漏」——不帶次序时服务端的构造次序一旦抖动，各页窗口会重合
 * （重复）或错位（漏行）。质检实据：237 行读成 **223 唯一 / 14 重复 / 14 漏行**。
 * `orderBy` 是**每次查询**的属性 ⇒ 每页都要重新带上（只在第一页带是无效写法）。
 *
 * **去重网（按 `_id`）**：只收拾「服务端仍越界重发」的残余情况（如跨 skip 页边界重叠）——
 * 它**不是**稳定次序的替代品（去重救不了漏行）；判据以 `ordered === true` 为准。
 * 行无 `_id` ⇒ 不参与去重（无从判重，如实保留）。
 *
 * 收尾判据仍是**空页**（不看「少于页宽」）；游标按**实际返回条数**推进
 * ⇒ 服务端上限低于页宽时也能读全。每页的等待上限＝总预算剩余（超时 ⇒ `CloudTimeoutError`）。
 *
 * @param {object} db `app.database()`
 * @param {string} collectionName 集合名
 * @param {{deadline?:number}} [options] `deadline` ＝ 总预算到点时刻（毫秒时间戳；0 ⇒ 不设限）
 * @returns {Promise<{rows:Array<object>, pages:number, duplicatesRemoved:number, ordered:boolean, uniqueIds:number}>}
 */
export async function fetchAllRowsDetailed(db, collectionName, options = {}) {
  const rows = []
  const seen = new Set()
  let duplicatesRemoved = 0
  let offset = 0
  let pages = 0
  let ordered = false
  const deadline = Number(options.deadline) > 0 ? Number(options.deadline) : 0
  for (let page = 0; page < CLOUD_MAX_PAGES; page += 1) {
    let query = db.collection(collectionName)
    /* ① **稳定次序（每页都带）**：拿不到 `orderBy`（形状不对）⇒ 如实记 `ordered: false`
       （不假装有序）；此时仍走去重网，但「无漏行」不再有保证 ⇒ 由调用方如实上报。 */
    if (typeof query.orderBy === 'function') {
      const ordered0 = query.orderBy(CLOUD_ORDER_FIELD, CLOUD_ORDER_DIRECTION)
      if (ordered0 && typeof ordered0.get === 'function') {
        query = ordered0
        ordered = true
      }
    }
    if (offset > 0 && typeof query.skip === 'function') query = query.skip(offset)
    if (typeof query.limit === 'function') query = query.limit(CLOUD_PAGE_SIZE)
    const reply = await withBudget(query.get(), deadline, `${collectionName}@${offset}`)
    const batch = rowsOfReply(reply)
    pages += 1
    /* 收尾判据 ＝ **空页**（不看「少于请求页宽」）：服务端有自己的条数上限（客户端 `.get()`
       常见上限 20），拿「页宽比较」当收尾在**上限低于页宽**时会把第一页就当末页 ⇒ **漏行**。
       游标按**实际返回条数**推进 ⇒ 无论服务端上限多少（10 / 20 / 100 / 1000）都能读全。 */
    if (batch.length === 0) break
    batch.forEach((row) => {
      const id = row && row._id !== undefined && row._id !== null ? String(row._id) : ''
      if (id && seen.has(id)) {
        duplicatesRemoved += 1
        return
      }
      if (id) seen.add(id)
      rows.push(row)
    })
    offset += batch.length
  }
  return { rows, pages, duplicatesRemoved, ordered, uniqueIds: seen.size }
}

/** 兼容入口（既有调用方 / 探针按数组读）：只取行数组。 */
export async function fetchAllRows(db, collectionName, options = {}) {
  const detailed = await fetchAllRowsDetailed(db, collectionName, options)
  return detailed.rows
}

/* ---------------------------------------------------------------------------
   6. 匿名登录（**逐句按 liwu 既有口径**：`packages/shared-utils/cloudbase-auth-runtime.js`）
   --------------------------------------------------------------------------- */

async function resolveCurrentUser(auth) {
  if (!auth) return null
  if (auth.currentUser) return auth.currentUser
  if (typeof auth.getCurrentUser === 'function') {
    try {
      return (await auth.getCurrentUser()) || null
    } catch {
      return null
    }
  }
  return null
}

/**
 * 确保处于（匿名）登录态：已有用户 ⇒ 直接用；已有登录态 ⇒ 解析用户；
 * 都没有 ⇒ `signInAnonymously()`。**并发去重**（同一份 promise）。
 */
export async function ensureAnonymousLogin(auth) {
  const existing = await resolveCurrentUser(auth)
  if (existing) return existing
  let loginState = null
  try {
    loginState =
      typeof auth.hasLoginState === 'function'
        ? auth.hasLoginState()
        : typeof auth.getLoginState === 'function'
          ? await auth.getLoginState()
          : null
  } catch {
    loginState = null
  }
  if (loginState) return await resolveCurrentUser(auth)
  await auth.signInAnonymously()
  return await resolveCurrentUser(auth)
}

/* ---------------------------------------------------------------------------
   7. 影像展示件：对象键 → 临时链接 → 字节（**不做转码、不做切块**）
   --------------------------------------------------------------------------- */

/**
 * 影像行的**展示件对象键**（机械可判）：
 *   · 行 `storage` 必须**逐字**等于既有取值 `server`（mapping.md §3）；
 *   · 行内 `sha256` 必须 64 位小写十六进制；
 *   · `storage_key` 必须匹配 `xiai/images/<sha 前两位>/<sha>.<png|webp>`，且 sha 段 ≡ 行内 sha256
 *     （不一致 ⇒ **拒绝**，返回空串 —— 不猜、不拼）。
 * @param {object|null} row 影像行
 * @returns {string} 对象键；判不过 ⇒ `''`
 */
export function cloudBaseObjectKeyOf(row) {
  if (!row || typeof row !== 'object') return ''
  if (String(row.storage || '').trim().toLowerCase() !== 'server') return ''
  const digest = String(row.sha256 || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(digest)) return ''
  const key = String(row.storage_key || '').trim()
  const matched = IMAGE_OBJECT_KEY_PATTERN.exec(key)
  if (!matched) return ''
  if (matched[2] !== digest || matched[1] !== digest.slice(0, 2)) return ''
  const declared = String(row.mime || '').trim().toLowerCase()
  if (declared && IMAGE_EXT_MIME[matched[3]] !== declared) return ''
  return key
}

/**
 * 对象键 → CloudBase **fileID**（**唯一构造点**；形态由 Zang 真浏览器实测钉死）。
 *
 * 形态：`cloud://<envId>.<bucket>/<对象键>`（默认桶见 `CLOUD_STORAGE_BUCKET_DEFAULT`）。
 *   · `VITE_XIAI_CB_STORAGE_PREFIX` 显式配了 ⇒ 用它的**完整前缀**（`source: 'prefix'`）；
 *   · bucket 被显式置空 ⇒ **配置错误** ⇒ 返回 `''`（调用方必须走 `cloudBaseFileIdDenial()` 的**显式失败**）；
 *   · 入参已是 `cloud://` 开头的串 ⇒ **原样返回**（不做二次拼装）。
 * **反面形态永不产出**（实测皆 `STORAGE_FILE_NONEXIST` ⇒ 会被误当「无图」）：裸对象键 / `cloud://<envId>/<键>`。
 * @param {string} objectKey 对象键（如 `xiai/images/ab/<sha>.png`）
 * @returns {string} fileID；空键 / 配置错误 ⇒ `''`（**绝不回落成裸键**）
 */
export function cloudBaseFileIdOf(objectKey) {
  const key = String(objectKey || '').trim()
  if (!key) return ''
  if (/^cloud:\/\//.test(key)) return key
  const storage = cloudBaseStorageConfig()
  if (storage.error || !storage.prefix) return ''
  return `${storage.prefix}${key}`
}

let appRef = null
const tempUrlCache = new Map()
const objectCache = new Map()

function cachePut(cache, key, value, limit) {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) cache.delete(cache.keys().next().value)
}

/**
 * 取展示件对象的**临时链接**（js-sdk `app.getTempFileURL`）。**桶 ACL 保持 PRIVATE 不动**
 * （Zang 实测：匿名临时链接可用，展示件游客可看 ⇒ 无需放宽 ACL）。
 *
 * **配置门在取链接之前**：bucket 被显式置空 ⇒ 直接返回结构化失败 `STORAGE_BUCKET_MISSING`
 * （＋状态上报 `cloudBaseStatus().storage.error`），**绝不当成「无图」静默吞掉**。
 * @returns {Promise<{ok:boolean, url?:string, fileID?:string, reason?:string, message:string}>}
 */
export async function cloudTempUrlOfObjectKey(objectKey) {
  const key = String(objectKey || '').trim()
  if (!key) return { ok: false, reason: 'MISSING_REQUIRED', message: '影像對象鍵缺位，暫時無法顯示' }
  const denial = cloudBaseFileIdDenial()
  if (denial) return denial
  if (tempUrlCache.has(key)) return { ok: true, url: tempUrlCache.get(key), fileID: cloudBaseFileIdOf(key), message: '' }
  if (!appRef || typeof appRef.getTempFileURL !== 'function') {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '影像暫時無法顯示，請稍後再試' }
  }
  let reply = null
  try {
    reply = await appRef.getTempFileURL({ fileList: [cloudBaseFileIdOf(key)] })
  } catch {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '影像暫時無法顯示，請稍後再試' }
  }
  const list = (reply && (reply.fileList || (reply.data && reply.data.fileList))) || []
  const first = list[0] || null
  const url = String((first && (first.tempFileURL || first.download_url || first.downloadUrl)) || '').trim()
  if (!url) {
    /* **「文件不存在」必须与「权限 / 网络问题」分开报**（Zang 实测提醒：两者在服务端都表现成「取不到」，
       而 `STORAGE_FILE_NONEXIST` 会被误当「无图」静默吞掉）⇒ 按 SDK 回的 code **显式区分**。 */
    const code = String((first && (first.code || first.status || first.errCode)) || '').trim()
    if (code === 'STORAGE_FILE_NONEXIST') {
      return {
        ok: false,
        reason: 'STORAGE_FILE_NOT_FOUND',
        fileID: cloudBaseFileIdOf(key),
        code,
        message: '影像檔案在雲端儲存中不存在（fileID 形態或對象鍵不符），請檢查影像儲存配置'
      }
    }
    return { ok: false, reason: 'NOT_IMAGE', fileID: cloudBaseFileIdOf(key), code, message: '影像暫時無法顯示，請稍後再試' }
  }
  cachePut(tempUrlCache, key, url, CLOUD_OBJECT_CACHE_LIMIT)
  return { ok: true, url, fileID: String((first && (first.fileID || first.fileId)) || cloudBaseFileIdOf(key)), message: '' }
}

/**
 * 取展示件对象的**整件字节**（临时链接 → `fetch`）。**零转码**：交出去的就是已迁的展示件字节。
 * 按字節如實判容器（不采信自称值）；同一对象键在内存里缓存一份（卡片 + 详情页不重复下载）。
 * @returns {Promise<{ok:boolean, bytes?:Uint8Array, mime?:string, sha256?:string, objectKey?:string, reason?:string, message:string}>}
 */
export async function cloudObjectBytesOfObjectKey(objectKey, options = {}) {
  const key = String(objectKey || '').trim()
  if (!key) return { ok: false, reason: 'MISSING_REQUIRED', message: '影像對象鍵缺位，暫時無法顯示' }
  const cached = objectCache.get(key)
  if (cached && options.noCache !== true) return { ...cached }
  const temp = await cloudTempUrlOfObjectKey(key)
  if (!temp.ok) return { ok: false, reason: temp.reason, message: temp.message }
  let bytes = null
  try {
    const reply = await fetch(temp.url)
    if (!reply || !reply.ok) return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '影像暫時無法讀取，請稍後再試' }
    bytes = new Uint8Array(await reply.arrayBuffer())
  } catch {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '影像暫時無法讀取，請稍後再試' }
  }
  if (bytes.length === 0) return { ok: false, reason: 'EMPTY_CONTENT', message: '影像暫時無法顯示，請稍後再試' }
  const out = {
    ok: true,
    bytes,
    mime: sniffBytesMime(bytes) || '',
    sha256: String(options.sha256 || '').trim().toLowerCase(),
    objectKey: key,
    message: ''
  }
  cachePut(objectCache, key, out, CLOUD_OBJECT_CACHE_LIMIT)
  return { ...out }
}

/** 影像行 ⇒ 整件展示件字节（对象键由行内 `storage` / `sha256` / `storage_key` 机械判定）。 */
export async function cloudObjectBytesOfRow(row, options = {}) {
  const key = cloudBaseObjectKeyOf(row)
  if (!key) return { ok: false, reason: 'NOT_FOUND', message: '本機影像庫中暫無該編號的圖象文件' }
  return await cloudObjectBytesOfObjectKey(key, {
    ...options,
    sha256: String((row && row.sha256) || '').trim().toLowerCase()
  })
}

/* ---------------------------------------------------------------------------
   8. 水合（一次性把 237 行拉进内存快照；并发去重、可重试、绝不抛错）
   --------------------------------------------------------------------------- */

let hydration = null
/**
 * **代次守卫（v2 必修 1）**：每轮水合开始时 +1；超时判负时再 +1 ⇒ **作廢本輪**，
 * 這樣「逾時後才落定的僵尸階段」的狀態寫入會被守衛擋掉（不會把 `failed` 覆寫成 `ready`）。
 */
let generation = 0

/* **v3 T1：待重試窗口**（`sdk-load` 超時後的那 0.8 s）。任何新一輪開始時都會把它作廢，
   並把它的 promise **接到新一輪的結論上** ⇒ 不留永不落定的懸空 promise（否則 `await` 它的
   調用方會永久掛住）。 */
let retryTimer = null
let retryResolve = null

/** 写入失败态（**代次守卫**：非本轮 ⇒ 一字不写，避免僵尸阶段覆盖既有结论）。 */
function fail(gen, reason, message, extra = {}) {
  if (gen !== generation) return statusRef.value
  setStatus('failed', { reason, message, ...extra })
  appRef = null
  return statusRef.value
}

/**
 * 水合（一次性把 237 行拉进内存快照）。本**轮**预算由 `budget` 决定，`deadline` 是到点时刻。
 * 阶段：SDK 装载 → `sdk.init` → 匿名登录 → 逐集合分页查询 —— **每个 await 都被预算包住**
 * （单阶段上限 ＝ `min(阶段预算, 本轮剩余)`，见 `cloudStageBudgetMs()`）。
 * 超时以 `CloudTimeoutError` **上抛**，由 `startHydrationRound()` 统一转成
 * `failed / TIMEOUT` 或（`sdk-load` 阶段的）自动重试。
 * @param {number} attempt 轮次（1 首轮 / 2 自动重试轮）；随状态上报，便于线上排障
 */
async function hydrate(gen, deadline, budget, attempt = 1) {
  const config = cloudBaseConfig()
  if (!cloudBaseConfigured()) {
    if (gen === generation) setStatus('off', { reason: 'NOT_CONFIGURED', message: '未配置 CloudBase 数据源，使用本地实现', envId: '' })
    return statusRef.value
  }
  if (gen !== generation) return statusRef.value
  setStatus('pending', {
    reason: attempt > 1 ? 'HYDRATING_RETRY' : 'HYDRATING',
    message: attempt > 1 ? `正在重試讀取雲端資料（第 ${attempt} 輪）…` : '正在讀取雲端資料…',
    envId: config.envId,
    timeoutMs: budget,
    attempt,
    timeoutStage: '',
    counts: { seals: 0, faces: 0, images: 0, correctionsPublic: 0, correctionSummaries: 0 },
    fetchedAt: ''
  })
  let sdk = null
  try {
    sdk = await withBudget(loadCloudBaseSdk(), deadline, 'sdk-load')
  } catch (err) {
    if (err instanceof CloudTimeoutError) throw err
    sdk = null
  }
  if (!sdk || typeof sdk.init !== 'function') {
    return fail(gen, 'SDK_UNAVAILABLE', 'CloudBase SDK 不可用，已回落到本機示範資料')
  }
  let app = null
  try {
    app = sdk.init({ env: config.envId, ...(config.region ? { region: config.region } : {}) })
  } catch {
    return fail(gen, 'SDK_UNAVAILABLE', 'CloudBase 初始化失敗，已回落到本機示範資料')
  }
  const auth = app && typeof app.auth === 'function' ? app.auth({ persistence: 'local' }) : null
  if (auth) {
    try {
      const user = await withBudget(ensureAnonymousLogin(auth), deadline, 'anonymous-login')
      if (!user) return fail(gen, 'ANONYMOUS_LOGIN_FAILED', '匿名登錄未取得登錄態，已回落到本機示範資料')
    } catch (err) {
      /* **超时 ⇒ 交给上层统一判 TIMEOUT**（与 SDK_UNAVAILABLE / 匿名登录失败同一条回落路径）。 */
      if (err instanceof CloudTimeoutError) throw err
      return fail(gen, 'ANONYMOUS_LOGIN_FAILED', '匿名登錄失敗，已回落到本機示範資料')
    }
  }
  const db = app && typeof app.database === 'function' ? app.database() : null
  if (!db || typeof db.collection !== 'function') {
    return fail(gen, 'DATABASE_UNAVAILABLE', 'CloudBase 資料庫不可用，已回落到本機示範資料')
  }
  const raw = {}
  const paging = {}
  /* **空集诊断容器（§3c）**：逐集合判定 → 诚实空态 / 可疑空集分别登记。 */
  const emptyVerified = []
  const emptySuspects = []
  try {
    for (const [key, collectionName] of Object.entries(CLOUD_COLLECTIONS)) {
      const detailed = await fetchAllRowsDetailed(db, collectionName, { deadline })
      raw[key] = detailed.rows
      /* 分页读数**如实上报**（页数 / 去重网命中数 / 是否真带稳定次序 / 唯一 `_id` 数）。 */
      paging[key] = {
        pages: detailed.pages,
        duplicatesRemoved: detailed.duplicatesRemoved,
        ordered: detailed.ordered,
        uniqueIds: detailed.uniqueIds
      }
      /* **可疑空集判定（§3c）**：云端**静默返回 0 行**不再被当成「真空」——
         本地同集合有数据 ⇒ 可疑（下面走失败状态机回落本地）；本地也空 ⇒ 诚实空态（不回落，
         也**绝不**把本机种子当云端数据）。 */
      const verdict = cloudEmptyVerdict(key, detailed.rows)
      if (verdict.cloud === 0) {
        if (verdict.suspect) emptySuspects.push(verdict)
        else emptyVerified.push(verdict)
      }
    }
  } catch (err) {
    if (err instanceof CloudTimeoutError) throw err
    return fail(gen, 'QUERY_FAILED', `雲端資料讀取失敗（${(err && err.message) || '未知原因'}），已回落到本機示範資料`)
  }
  /* **可疑空集 ⇒ 回落（§3c）**：与 `QUERY_FAILED` **同一条失败状态机**（`fail()` ⇒ `failed` ⇒
     `db.js::readCollection` 走既有「非 ready」分支 ⇒ 本地实现）；诊断字段（集合名 / 云端行数 /
     本地行数）随状态上报 ⇒ 线上排障一眼分得清「真空」与「被权限/配置挡了」。 */
  if (emptySuspects.length > 0) {
    return fail(
      gen,
      CLOUD_EMPTY_SUSPECT,
      `雲端資料可疑為空（${emptySuspects
        .map((item) => `${item.collection} 雲端 ${item.cloud} 列 / 本機 ${item.local} 列`)
        .join('、')}），已回落到本機示範資料`,
      { emptySuspect: emptySuspects, emptyVerified }
    )
  }
  if (gen !== generation) return statusRef.value
  const snapshot = {
    fetchedAt: new Date().toISOString(),
    provenanceKept: config.keepProvenance,
    orderField: CLOUD_ORDER_FIELD,
    orderDirection: CLOUD_ORDER_DIRECTION,
    paging
  }
  for (const [key, rows] of Object.entries(raw)) {
    snapshot[key] = rows.map((doc) => NORMALIZERS[key](doc, { keepProvenance: config.keepProvenance }))
  }
  appRef = app
  snapshotRef.value = snapshot
  /* 计数按 `CLOUD_COLLECTIONS` 的键面**动态汇总**（新增集合自动纳入，不再写死三个键）。 */
  const counts = {}
  let hydratedRows = 0
  for (const key of Object.keys(CLOUD_COLLECTIONS)) {
    counts[key] = Array.isArray(snapshot[key]) ? snapshot[key].length : 0
    hydratedRows += counts[key]
  }
  setStatus('ready', {
    reason: 'OK',
    message: `雲端資料已就緒（${hydratedRows} 列）`,
    envId: config.envId,
    counts,
    paging,
    attempt,
    timeoutStage: '',
    /* **诚实空态如实登记（§3c）**：云端 0 行且本地同集合也为空 ⇒ **不回落**，但状态留痕；
       可疑空集（已回落）此时恒为空集（有可疑即已 `failed`）。 */
    emptyVerified,
    emptySuspect: [],
    fetchedAt: snapshot.fetchedAt
  })
  return statusRef.value
}

/**
 * **起一輪水合**（唯一入口：首輪 / `sdk-load` 超時後的自動重試輪 / 顯式重試都走這裡）。
 *
 * 任何新一輪都會**作廢待重試窗口**，並把它的 promise 接到本輪結論上（不留懸空 promise）。
 * 超時的分派（v3 T1）：`sdk-load` 階段且是首輪 ⇒ `scheduleHydrationRetry()`
 * （狀態維持 `pending / HYDRATING_RETRY` ⇒ 視圖維持載入態、**不回落本地**）；
 * 其餘一律走既有 `failed / TIMEOUT` 回落路徑（**不拖長**：鑑權 / 查詢面立即失敗就立即回落）。
 * @param {number} budget 本輪總預算（毫秒；0 ⇒ 不設限，僅測試）
 * @param {number} attempt 輪次（1 首輪 / 2 自動重試輪）
 */
function startHydrationRound(budget, attempt) {
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  const supersededResolve = retryResolve
  retryResolve = null
  generation += 1
  const gen = generation
  const deadline = budget > 0 ? Date.now() + budget : 0
  /* **同步起跑**（`hydrate()` 是 async 函数 ⇒ 体内首个 await 之前**同步**执行）：
     `pending` 状态必须在**本次调用返回前**就位 —— 否则紧随其后的同步读取会读到 `off`
     ⇒ 走回本地种子（「先假后真」）。 */
  const round = hydrate(gen, deadline, budget, attempt).catch((err) => {
    if (err instanceof CloudTimeoutError) {
      /* **已作廢的輪次**（例如用户已 `retry`）⇒ 本輪的逾時**一字不寫**（不得覆寫新輪的結論）。 */
      if (gen !== generation) return statusRef.value
      if (attempt === 1 && CLOUD_RETRYABLE_TIMEOUT_STAGES.includes(err.stage)) {
        return scheduleHydrationRetry(budget, err)
      }
      /* 先**作廢本輪**（僵尸阶段的后续写入一律被代次守卫挡掉），再写失败态。 */
      generation += 1
      return fail(
        generation,
        'TIMEOUT',
        `雲端資料讀取超時（本輪預算 ${budget} ms，階段「${err.stage}」未落定），已回落到本機示範資料`,
        { timeoutMs: budget, timeoutStage: err.stage, attempt }
      )
    }
    if (gen !== generation) return statusRef.value
    return fail(gen, 'QUERY_FAILED', `雲端資料讀取失敗（${(err && err.message) || '未知原因'}），已回落到本機示範資料`)
  })
  if (supersededResolve) supersededResolve(round)
  return round
}

/**
 * **`sdk-load` 超時後的自動重試**（见 `CLOUD_HYDRATE_RETRY_*` 头注的理由）。
 * 本函數**不寫 `failed`**：作廢本輪（`generation += 1`，僵屍階段一律被擋）後把狀態留在
 * `pending / HYDRATING_RETRY` ⇒ `db.js::readCollection` 的 `pending` 分支照舊返回空集、
 * **不回落本地種子**（避免把 8 行示範資料當成 79 行藏品展示）；延遲後起重試輪。
 * @returns {Promise<object>} 重試輪的結論（或新一輪的結論，若窗口內被顯式重試取代）
 */
function scheduleHydrationRetry(budget, err) {
  generation += 1 /* 作廢本輪 */
  setStatus('pending', {
    reason: 'HYDRATING_RETRY',
    /* **D-1**：必须印**该阶段实际耗尽的等待上限**（`CloudTimeoutError.budgetMs`
       ＝ `min(阶段预算, 本輪剩余)`，如 `sdk-load` 的 12000），**不得**印本轮的**总预算**
       （20000）—— 后者会让人误以为「等了 20 秒」，与真实归因不符。 */
    message: `雲端資料載入較慢（階段「${err.stage}」超出 ${err.budgetMs} ms 預算），即將自動重試…`,
    timeoutMs: budget,
    timeoutStage: err.stage,
    retryBudgetMs: CLOUD_HYDRATE_RETRY_BUDGET_MS,
    attempt: 2,
    counts: { seals: 0, faces: 0, images: 0, correctionsPublic: 0, correctionSummaries: 0 },
    fetchedAt: ''
  })
  return new Promise((resolve) => {
    retryResolve = resolve
    retryTimer = setTimeout(() => {
      retryTimer = null
      hydration = startHydrationRound(CLOUD_HYDRATE_RETRY_BUDGET_MS, 2)
    }, CLOUD_HYDRATE_RETRY_DELAY_MS)
  })
}

/**
 * 启动/按需触发水合（**幂等**：并发调用共用同一份 promise）。
 * 未配置 ⇒ 立刻回 `off`（一次网络都不发）；失败 ⇒ `failed` ⇒ 数据层自动回落本地实现。
 *
 * **v2 必修 1（超时护栏）／v3 T1（分阶段预算 + 冷启动重试）**：本轮的总预算在**开始时**算出
 * （`deadline = now + 预算`），所有阶段共享它、单阶段另受自己的预算约束（见
 * `cloudStageBudgetMs()`）；超预算 ⇒ 结构化 `failed / TIMEOUT`（或 `sdk-load` 阶段先自动重试
 * 一輪）⇒ **同一条回落路径**。⇒ 页面**不会**停留在 `pending`（质检实据的「长期空态」由此消除），
 * 也不会因为一次冷緩存慢加载就把 79 行藏品静默换成 8 行示范数据。
 * 重试能力保留：`retryCloudBaseHydration()`、以及 `sdk-load` 阶段的一次自动重试。
 */
export function ensureCloudBaseHydration() {
  if (!cloudBaseConfigured()) {
    /* 未配置：**只在状态真的变了才写**（本函数会被数据层的每次读取调用 ⇒ 避免响应式空转）。 */
    if (stateRef.value !== 'off') {
      setStatus('off', { reason: 'NOT_CONFIGURED', message: '未配置 CloudBase 数据源，使用本地实现', envId: '' })
    }
    return Promise.resolve(statusRef.value)
  }
  if (!hydration) hydration = startHydrationRound(cloudBaseTimeoutMs(), 1)
  return hydration
}

/** 重試（已 `failed` / 載入過久時用；清掉一次性状态后重新水合 ⇒ 走同一套预算与回落规则）。 */
export function retryCloudBaseHydration() {
  hydration = null
  generation += 1
  return ensureCloudBaseHydration()
}

/**
 * **仅测试 / 排障用**：清空一次性状态（快照、缓存、注入的 app），让下一轮水合从头开始。
 * 生产代码**不得**调用（正常路径只有启动时那一次水合）。
 */
export function resetCloudBaseSource() {
  generation += 1
  hydration = null
  appRef = null
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  const pendingResolve = retryResolve
  retryResolve = null
  tempUrlCache.clear()
  objectCache.clear()
  snapshotRef.value = null
  setStatus('off', {
    reason: 'NOT_CONFIGURED',
    message: '未配置 CloudBase 数据源，使用本地实现',
    envId: '',
    counts: { seals: 0, faces: 0, images: 0, correctionsPublic: 0, correctionSummaries: 0 },
    attempt: 0,
    timeoutStage: '',
    emptyVerified: [],
    emptySuspect: [],
    fetchedAt: ''
  })
  /* 待重試窗口被作廢 ⇒ 它的 promise 接到「已重置」的結論上（不懸空）。 */
  if (pendingResolve) pendingResolve(statusRef.value)
}
