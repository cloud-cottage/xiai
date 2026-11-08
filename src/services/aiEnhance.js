/**
 * 玺爱 · **「人工智能修復」門面（印面影像）**（本單新增；**本單改為「提交 ＋ 輪詢狀態」異步形態**）
 * ============================================================================
 * 包装云函数 `xiai-user-token` 的 **5 個 op**（鍵面與服務端 `lib/ops.js` 注册面**逐字一致**）：
 *   · `ai-enhance-submit` / `ai-enhance-status` / `ai-enhance-list`（**本單新增的異步三件套**：
 *     提交**立即**回任務號 ⇒ 前端每 4 秒輪詢狀態 ⇒ 詳情頁開窗先列本印面的任務以**續接** ——
 *     雲端網關約 60 秒必掐同步長調用的病根由此根治）；
 *   · `ai-enhance-face`（**legacy**：同步長調用，服務端 24〜106 秒才回包 ⇒ 網關必掐 ⇒
 *     用戶只看到「網路異常」而候選圖其實已入庫 —— **前端已不再調用**；常量與 `READOUT_KEYS`
 *     **逐字保留**，僅供離線自檢與舊契約對照，本文件內零調用點）；
 *   · `ai-enhance-discard`（管理員面；棄置候選修復圖；**不涉及退款**）。
 *
 * **通道（唯一、不另造第二條）**：`userWrite.js::userWriteGate` → `token.js::userGate` →
 * `data/cloudbaseFn.js::callCloudFunction('xiai-user-token', …)` —— 與勘誤 / 採信 / AI 金鑰等
 * 既有寫面**同一條**用戶令牌通道（含「刷新後靜默補簽」自愈）。本文件**不直連** `callCloudFunction`、
 * **不自建**第二套装载；回包讀數面經 `gate()` 的 `options.readoutKeys` **additive 透傳**声明取得。
 *
 * 契約（**服務端單並行實現，以此為準**；本文件只做形狀校驗、**不補編任何鍵**）：
 *   · `ai-enhance-face` 載荷**封閉三鍵**：`image_id`（原圖）/ `seal_id` / `face_id`；
 *     成功回包：`{ok:true, image_id, source_image_id, preview:{mime, sha256}, charge:{amount, balance},
 *     row}`（`row` ＝ 服務端**已落庫的那一行本身**）；
 *     失敗回包：`{ok:false, reason, message, refunded}`（`refunded === true` ⇒ 本次未消耗金）。
 *   · `ai-enhance-discard` 載荷**封閉一鍵**：`image_id`（候選影像編號）；
 *     成功回包**恰 3 鍵**：`{ok:true, image_id, deleted_objects}`；
 *     失敗回包**恰 3 鍵**：`{ok:false, reason, message}`（**無 `refunded`** —— 弃置不退款）。
 *   · **異步三件套（本單；服務端凍結契約逐字）**：
 *     `ai-enhance-submit` 載荷**封閉四鍵** `image_id / seal_id / face_id / request_id`
 *     （`request_id` ＝ 前端生成的**本次嘗試穩定編號**，8〜64 位字母數字或下劃線；**同一次嘗試
 *     重發必須復用同一個**才冪等）；成功**恰五鍵** `ok / task_id / status / source_image_id /
 *     charge{amount,balance}`；失敗**恰四鍵** `ok / reason / message / refunded`。
 *     `ai-enhance-status` 載荷**封閉一鍵** `task_id`；`RUNNING` **恰四鍵** `ok / task_id /
 *     status / upstream_status`；`READY` **恰六鍵** `ok / task_id / status / image_id /
 *     preview{mime,sha256} / charge{amount,balance}`；`FAILED` **恰五鍵** `ok:false / reason /
 *     message / refunded / status`。
 *     `ai-enhance-list` 載荷**封閉一鍵** `face_id`；回包**恰兩鍵** `ok / rows`，每行**恰六鍵**
 *     `task_id / status / image_id / source_image_id / created_at / error_message`。
 *     狀態字面值**只有** `SUBMITTED` / `RUNNING` / `READY` / `FAILED` 四個；`reason` **零新增**
 *     （沿用既有凍結值：`UPSTREAM_ERROR` / `INVALID_VALUE` / `FORBIDDEN` / `INSUFFICIENT_POINTS`
 *     / `CONFIG_MISSING` / `STORAGE_UNAVAILABLE` / `MISSING_REQUIRED` / `INVALID_FIELD`）。
 *
 * 硬口徑（逐條）：
 *  ① **失敗原樣透傳**：服務端結構化拒絕的 `{ok:false, reason, message}` **一字不改寫**；
 *     前置檢查的拒絕（未登錄 / 非管理員 / 缺鍵）用**獨立字面值**
 *     `LOGIN_REQUIRED` / `NOT_ADMIN` / `INVALID_INPUT`（與 `feicui.js` / `aiAccess.js` 同族做法；
 *     **不是**服務端授權面）。
 *  ② **`refunded` 如實透傳**：失敗時是否已退費只由服務端說了算 —— 前端**不推斷、不補寫**
 *     （回包無該鍵 ⇒ `refunded:false`；文案面由詳情頁決定要不要寫「本次未消耗金」）。
 *  ③ **回包形狀校驗**：`image_id` 缺位 / 非字串 ⇒ 如實結構化拒絕（**不編造影像編號**）；
 *     `preview` / `charge` 缺位 ⇒ 對應讀數為 `null`（**不編造 mime / 摘要 / 扣費數字**）。
 *  ④ 組件 / 視圖**只經本文件**；op 名字面值與讀數鍵面**全倉只在此處**。
 *  ⑤ **dev / 離線形態**：過門但未經雲端 ⇒ 如實結構化拒絕（非正式路徑；**零扣費、零影像**）。
 *  ⑥ **候選行鏡像（本單）**：終局回包（`READY`）附的 `row` ⇒ 先按既有范式整表寫
 *     （`db.saveImageRows`；`local-dev` 舊路徑一字不變），雲模式下 `saveImageRows` 停寫本機
 *     ⇒ 再 upsert 進**雲端快照內存緩存**（`db.upsertImageRowCache`：**零落盤、零 IndexedDB**），
 *     讓 `listImageRows()` 立刻看得見該行（`loadImageDataUrl` 的雲端分支才成立）；
 *     讀 / 寫 / upsert 任何失敗或 `row` 缺席 ⇒ **只降級**成 `mirror: false`
 *     （仍 `ok: true`、仍回 `image_id`，UI 可據此提示刷新），**絕不改判成功**。
 * ============================================================================
 */

import { isAdmin, isLoggedIn } from '../data/session.js'
import { listImageRows, saveImageRows, upsertImageRowCache } from '../data/db.js'
import { userWriteGate } from './userWrite.js'

/**
 * **legacy** op 名（`ai-enhance-face`；與 `lib/ops.js` 注册面逐字一致；全倉唯一出現處）。
 *
 * **前端已不再調用它**（本單改走異步三件套，見文件頭）：它是同步長調用，服務端 24〜106 秒
 * 才回包 ⇒ CloudBase 網關約 60 秒必掐 ⇒ 用戶只看到「網路異常」而候選圖其實已入庫、扣金已發生。
 * 常量與 `READOUT_KEYS` **逐字保留**（離線自檢 / 舊契約對照在用），本文件內**零調用點**。
 */
export const AI_ENHANCE_OP = 'ai-enhance-face'

/**
 * **提交修復任務**的 op 名（服務端**立即回任務號**，上游在雲端繼續跑；全倉唯一出現處）。
 * 載荷**封閉四鍵**：`image_id` / `seal_id` / `face_id` / `request_id`。
 */
export const AI_ENHANCE_SUBMIT_OP = 'ai-enhance-submit'

/**
 * **查任務狀態**的 op 名（前端每 4 秒輪一次；全倉唯一出現處）。載荷**封閉一鍵**：`task_id`。
 * 三種回包與四個狀態字面值見文件頭契約段。
 */
export const AI_ENHANCE_STATUS_OP = 'ai-enhance-status'

/**
 * **列本印面的修復任務**的 op 名（詳情頁開窗先調它以**續接**未完成任務；全倉唯一出現處）。
 * 載荷**封閉一鍵**：`face_id`。
 */
export const AI_ENHANCE_LIST_OP = 'ai-enhance-list'

/**
 * **棄置候選修復圖**的 op 名（服務端單並行實現；全倉唯一出現處，與 `AI_ENHANCE_OP` 同族）。
 *
 * 語義：管理員對**本次修復產出的候選影像**不滿意 ⇒ 請服務端棄置（移除）該候選影像。
 * **不涉及退款**（修復金在上游成功時已花掉；棄置只是清掉不想要的候選件）。
 */
export const AI_ENHANCE_DISCARD_OP = 'ai-enhance-discard'

/** **單張修復成本（金）**：調用前在彈窗內明示；**實際扣費以回包 `charge.amount` 爲準**（服務端是判據）。 */
export const AI_ENHANCE_COST = 10

/**
 * **`ai-enhance-face` 的雲端調用超時預算（毫秒）**（本單「超時預算」新增）。
 *
 * 為什麼是 120000：上游出圖需 20〜60 秒（`timeout_ms` 服務端默認 60000），加雲函數冷啟動、
 * 下載原圖與落庫 —— 以「上游默認 2 倍」留餘量，避免全局 15000 ms 預算必然誤殺慢出圖。
 * 只作用於 `ai-enhance-face`；`ai-enhance-discard` **仍走全局默認**（它很快，零退款面不等慢上游）。
 * 全局默認 `CLOUD_FUNCTION_TIMEOUT_MS`（15000 ms）**逐字不變**（見 `data/cloudbaseFn.js`）。
 */
export const AI_ENHANCE_TIMEOUT_MS = 120000

/* ============================================================================
   「提交 ＋ 輪詢狀態」的節奏與上屏文案（本單；**凍結值，逐字照抄上屏**）
   ============================================================================ */

/** **輪詢間隔（毫秒）**：每 4 秒問一次狀態（契約點名）。 */
export const AI_ENHANCE_POLL_INTERVAL_MS = 4000

/** **輪詢總預算（毫秒）**：最長 20 分鐘；到點即停（雲端任務不撤回，重開本窗仍可續接）。 */
export const AI_ENHANCE_POLL_DEADLINE_MS = 20 * 60 * 1000

/** **連續傳輸失敗判死門檻**：輪詢期間的網路失敗**不當場判死**，連續 3 次才按
 *  `STORAGE_UNAVAILABLE` 返回（單次失敗只記數、照常等下一輪）。 */
export const AI_ENHANCE_POLL_MAX_TRANSPORT_FAILURES = 3

/**
 * **傳輸層失敗的上屏整句**（繁體、成品整句、**直接照抄不拼接**）。
 *
 * 為什麼由本文件替換原文：`data/cloudbaseFn.js::TRANSPORT_MESSAGES.*` 是**全站共用**文案
 * （那句對 AI 修復場景是**假話** —— 任務其實可能已在雲端跑、扣金已預扣），本文件**不改它**；
 * 但 AI 修復的失敗上屏**不得**照抄它 ⇒ 過門回來的傳輸層失敗一律換成本句。
 * 同時它也是視圖區分「傳輸層失敗 vs 服務端失敗」的**唯一判據**（文案逐字比對）。
 */
export const AI_ENHANCE_TRANSPORT_MESSAGE =
  '雲端連線失敗；本次修復任務可能仍在進行，稍後重開本窗可續接結果，不會重複扣金。'

/** **輪詢逾 20 分鐘的上屏整句**（同樣**不照抄**全站共用傳輸文案；任務未撤回 ⇒ 重開仍可續接）。 */
export const AI_ENHANCE_TIMEOUT_MESSAGE =
  '修復逾時（20 分鐘）未回報結果；雲端任務可能仍在進行，稍後重開本窗可續接結果，不會重複扣金。'

/** **用戶取消 / 關窗的上屏整句**（只停止等待；服務端任務不撤回）。 */
export const AI_ENHANCE_STOPPED_MESSAGE = '已停止等待（雲端任務仍在進行）；稍後重開本窗可續接結果。'

/** 前置攔截的 reason（**本層判定，零網路；不是服務端的授權面**；與 `feicui.js` / `aiAccess.js` 同族）。 */
export const LOGIN_REQUIRED = 'LOGIN_REQUIRED'
export const NOT_ADMIN = 'NOT_ADMIN'
export const INVALID_INPUT = 'INVALID_INPUT'

/**
 * 回包讀數鍵面（與服務端成功回包的**非信封鍵**逐字同集）—— 經 `gate()` 的 `readoutKeys`
 * **additive 透傳**声明取得（未声明 ⇒ 鍵在信封上、值恆 `undefined`）。
 */
const READOUT_KEYS = Object.freeze(['image_id', 'source_image_id', 'preview', 'charge'])

/**
 * 【棄】回包讀數鍵面（與服務端成功回包的**非信封鍵**逐字同集：`image_id` / `deleted_objects`）
 * —— 經 `gate()` 的 `readoutKeys` **additive 透傳**声明取得。
 */
const DISCARD_READOUT_KEYS = Object.freeze(['image_id', 'deleted_objects'])

/**
 * **`ai-enhance-submit` 成功回包的非信封鍵**（＝ 凍結契約「恰五鍵」去掉 `ok`）——
 * 經 `gate()` 的 `readoutKeys` **additive 透傳**声明取得。
 */
const SUBMIT_READOUT_KEYS = Object.freeze(['task_id', 'status', 'source_image_id', 'charge'])

/**
 * **`ai-enhance-status` 成功回包的非信封鍵**（＝ `RUNNING` 四鍵 ∪ `READY` 六鍵 去掉 `ok`；
 * `FAILED` 走 gate 的結構化拒絕分支 ⇒ `reason` / `message` / `refunded` 由 gate 原樣帶出）。
 */
const STATUS_READOUT_KEYS = Object.freeze([
  'task_id',
  'status',
  'upstream_status',
  'image_id',
  'preview',
  'charge'
])

/** **`ai-enhance-list` 回包的非信封鍵**（＝ 凍結契約「恰兩鍵」去掉 `ok`）。 */
const LIST_READOUT_KEYS = Object.freeze(['rows'])

/* ============================================================================
   候選行**鏡像**（服務端成功回包帶 `row` ⇒ 客戶端把它補進 `listImageRows()` 讀面）
   ----------------------------------------------------------------------------
   為什麼要這一步：`seals.js::loadImageDataUrl` 走雲端分支的前提是 `listImageRows()`
   找得到該行；服務端已落庫、讀面卻沒有 ⇒ `meta = null` ⇒ 回落本地 blobstore ⇒
   右格報「影像二進制不在本地存儲中」。
   **本單改口徑**：雲模式下 `db.saveImageRows` 停寫本機（提交 `b98bc47`）⇒ 單靠整表寫
   **什麼都沒寫**（回 `rows`、不落任何存儲）⇒ 整表寫照舊走（`local-dev` 舊路徑一字不變），
   雲模式**再補一步** `db.upsertImageRowCache(row)` —— 只進**雲端快照內存緩存**
   （零落盤、**零 IndexedDB**、不寫 localStorage），`listImageRows()` 立刻看得見該行。

   硬口徑（逐條）：
   ① 只在**成功**回包上做；`reply.row` 非對象 ⇒ **不追加、不崩**（照常返回 `image_id`）。
   ② **冪等**：該 id 已在讀面裡 ⇒ **不重複追加**（行數不變）。
   ③ 鏡像讀 / 寫 / upsert **任何失敗只降級**：仍返回 `ok: true` 與 `image_id`，並給可讀提示位
      `mirror: false`（UI 據此提示刷新）；**絕不把成功改判成失敗**。
   ④ `mirror` 只是「`listImageRows()` 此刻是否真有該行」的**如實讀數**（寫完再讀一次核對），
      不是服務端判定；`reply.row` 缺席（舊服務端 / 未透傳）同樣回 `mirror: false`。
   ⑤ 讀寫一律走 `db` 的 `listImageRows` / `saveImageRows` 同族入口（**先讀現有行再 append**，
      與 `db.js::insertImageRow` 的落盤範式逐字同構），本文件零 localStorage 字面值。

   注入縫：`setAiEnhanceMirrorStore`（離線自檢注入假鏡像存儲；生產不注入 ⇒ 走 db 真入口）。
   ============================================================================ */

let mirrorStore = null

/**
 * 注入鏡像存儲（`{list(): Array, save(rows): any}`）；傳非對象 ⇒ 清除注入。
 * **僅供離線自檢 / 宿主**（生產不注入 ⇒ 走 `db` 的 `listImageRows` / `saveImageRows`）。
 * @param {null|object} store
 */
export function setAiEnhanceMirrorStore(store) {
  mirrorStore = store && typeof store === 'object' ? store : null
}

/** 讀現有影像行（注入縫 → `db.listImageRows`）。 */
function mirrorListRows() {
  if (mirrorStore && typeof mirrorStore.list === 'function') return mirrorStore.list()
  return listImageRows()
}

/** 寫整份影像行（注入縫 → `db.saveImageRows`；回 `false` 視為寫入未成立）。 */
function mirrorSaveRows(rows) {
  if (mirrorStore && typeof mirrorStore.save === 'function') return mirrorStore.save(rows)
  return saveImageRows(rows)
}

/**
 * 把候選行補進 `listImageRows()` 讀面（**冪等**；兩步：整表寫 ＋ 雲端快照內存 upsert）。
 *
 * 為什麼是兩步：雲模式下 `db.saveImageRows` 停寫本機（提交 `b98bc47`）⇒ 只走整表寫
 * **不落任何存儲**、讀面仍看不見該行；`local-dev` 形態則仍由整表寫落盤（**舊路徑一字不變**），
 * 內存 upsert 只是補位（身份已在底層行裡 ⇒ 不重複追加）。
 *
 * @param {*} row 服務端回包的 `row`（已落庫的那一行）
 * @returns {boolean} `listImageRows()` 此刻是否真有該行（任何失敗一律 `false`，**不拋**）
 */
function mirrorCandidateRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  const id =
    typeof row.id === 'string' && row.id !== ''
      ? row.id
      : typeof row._id === 'string' && row._id !== ''
        ? row._id
        : ''
  if (id === '') return false
  try {
    const current = mirrorListRows()
    const rows = Array.isArray(current) ? current : []
    const already = rows.some((item) => item && (item.id === id || item._id === id))
    if (already) return true
    /* ① 整表寫（**先讀現有行再 append**；`local-dev` 舊路徑逐字不變）。 */
    if (mirrorSaveRows(rows.concat([row])) === false) return false
    /* ② 雲端快照內存 upsert（**零落盤、零 IndexedDB**）：雲模式下讀面由此看得見該行。 */
    if (upsertImageRowCache(row) !== true) return false
    /* ③ 如實讀數：再讀一次讀面核對 —— 不拿「寫呼叫沒報錯」冒充「已經有了」。 */
    return mirrorListRows().some((item) => item && (item.id === id || item._id === id))
  } catch {
    /* 鏡像讀 / 寫失敗 ⇒ 只降級（`mirror: false`），**不改判成功**。 */
    return false
  }
}

/* ---------------------------------------------------------------------------
   【棄】棄置候選修復圖（op `ai-enhance-discard`；服務端單並行實現，以此為準）
   ----------------------------------------------------------------------------
   契約（本文件只做形狀校驗、**不補編任何鍵**）：
     · 載荷**封閉一鍵**：`image_id`（剛才修復產出的候選影像編號）；
     · 成功回包：`{ok:true, image_id, deleted_objects}`（**恰 3 鍵**）；
     · 失敗回包：`{ok:false, reason, message}`（**恰 3 鍵；無 `refunded`** —— 棄置不涉及退款：
       修復金在上游成功時已花掉，棄置只是移除不想要的候選件）。
   硬口徑：前置拒絕（未登錄 / 非管理員 / 缺 `image_id`）用獨立字面值 `LOGIN_REQUIRED` /
   `NOT_ADMIN` / `INVALID_INPUT`（零網路）；過門後服務端 `reason` / `message` **一字不改寫**
   （`FORBIDDEN` / `INVALID_VALUE` 等原文上屏）；`image_id` 缺位即如實拒絕（**不編造影像編號**）。
   --------------------------------------------------------------------------- */

/**
 * **全站共用的傳輸 / 形狀文案不得出現在 AI 修復的失敗上屏**（本單硬口徑）。
 *
 * `data/cloudbaseFn.js::TRANSPORT_MESSAGES.*` 與 `token.js::shapeDenial` 是**全站共用**文案
 * （前綴「雲端校驗…」），本文件**不改它**；但 AI 修復的傳輸層失敗**實際可能已提交 / 已扣金**
 * ⇒ 照抄它在此處是**假話**。判據＝「傳輸層失敗 ＋ 原文是那族共用文案」⇒ 換成本文件凍結的
 * 上屏整句（**只換 message、`reason` 一字不改**）；服務端自己的拒絕文案（哪怕同為
 * `STORAGE_UNAVAILABLE`）**逐字透傳**。
 * @param {string} reason 上屏 reason（原樣回傳，不改寫）
 * @param {string} message 上屏原文
 * @returns {string}
 */
function stripLegacyTransportNote(reason, message) {
  const text = String(message === undefined || message === null ? '' : message)
  if (reason !== 'STORAGE_UNAVAILABLE' || !text.includes('雲端校驗')) return text
  return '棄置候選圖連線失敗；候選圖仍在（本次未棄置），可稍後重試。'
}

/**
 * 棄置一枚候選修復影像（**不退款**；服務端裁決）。
 *
 * @param {string} imageId 剛才修復產出的候選影像編號
 * @returns {Promise<{ok:true, imageId:string, deletedObjects:boolean}
 *          |{ok:false, reason:string, message:string}>}
 */
export async function discardFaceImage(imageId) {
  const id = String(imageId === undefined || imageId === null ? '' : imageId).trim()
  if (!isLoggedIn.value) {
    return { ok: false, reason: LOGIN_REQUIRED, message: '請先登錄後再棄置候選圖（前端前置；未發出任何請求、未退款）。' }
  }
  if (!isAdmin.value) {
    return { ok: false, reason: NOT_ADMIN, message: '僅管理員可以棄置候選圖（前端前置；未發出任何請求、未退款）。' }
  }
  if (!id) {
    return { ok: false, reason: INVALID_INPUT, message: '棄置候選圖需要候選影像編號（image_id），本次未發出任何請求。' }
  }

  const gate = await userWriteGate(AI_ENHANCE_DISCARD_OP, { image_id: id }, { readoutKeys: DISCARD_READOUT_KEYS })
  /* 傳輸層 / 補簽 / 服務端結構化拒絕 ⇒ **原樣透傳**（**不加 `refunded`** —— 契約恰 3 鍵）。 */
  if (!gate || gate.ok !== true) {
    const reason = (gate && gate.reason) || 'STORAGE_UNAVAILABLE'
    return {
      ok: false,
      reason,
      message: stripLegacyTransportNote(
        reason,
        (gate && gate.message) || '棄置候選圖服務暫時不可用，請稍後再試。'
      )
    }
  }
  if (gate.dev === true) {
    /* dev / 離線形態：門放行但**未經雲端** ⇒ 如實結構化拒絕（不編造已棄置假讀數）。 */
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: 'dev / 離線形態：未經雲端驗證，棄置候選圖不可用（非正式路徑；本次零退款、零影像變更）。'
    }
  }

  /* **回包形狀校驗**：`image_id` 是「已棄置哪一枚」的唯一憑據 ⇒ 缺位即如實拒絕（不編造影像編號）。 */
  const discardedId = typeof gate.image_id === 'string' ? gate.image_id.trim() : ''
  if (!discardedId) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '棄置候選圖回包形狀不可辨識（未附影像編號 image_id），請刷新後再試。'
    }
  }
  return {
    ok: true,
    imageId: discardedId,
    deletedObjects: gate.deleted_objects === true
  }
}

function denial(reason, message) {
  return { ok: false, reason, message, refunded: false }
}

/** 數值讀數歸一（缺位 / 非數值 ⇒ `NaN`，由調用方「未記載」分檔，**不補 0 冒充**）。 */
function numberOrNaN(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : NaN
}

/**
 * **雲端逾時文案的柔性補筆**（本單「超時預算」新增）。
 *
 * 判據（兩條同時成立才補）：`reason === 'STORAGE_UNAVAILABLE'` **且**服務端 / 傳輸層 message 含
 * 「逾時」（既有 `TRANSPORT_MESSAGES.TIMEOUT` 文案即含此二字）。補筆只加在 **message 末尾**、
 * **reason 與原 message 一字不改寫**（既有「失敗原樣透傳」硬口徑不變）——
 * 目的是**不讓用戶誤以為一定失敗**：預算放寬後雲端可能仍在跑，刷新可確認候選圖是否已生成。
 * 其他任何失敗（`FORBIDDEN` / `INVALID_VALUE` / 非逾時傳輸失敗 …）**零補筆、逐字透傳**。
 * @param {string} reason 上屏 reason（原樣回傳，不改寫）
 * @param {string} message 上屏原文
 * @returns {{reason:string, message:string}}
 */
function timeoutSoftNote(reason, message) {
  const text = String(message === undefined || message === null ? '' : message)
  if (reason !== 'STORAGE_UNAVAILABLE' || !text.includes('逾時')) return { reason, message: text }
  return { reason, message: `${text}（雲端可能仍在處理：稍後重新整理該印面可確認是否已生成候選圖；若未生成則未扣金。）` }
}

/* ============================================================================
   異步三件套的內部實現（本單「提交 ＋ 輪詢狀態」）
   ----------------------------------------------------------------------------
   硬口徑（逐條）：
   ① **失敗形狀恒恰三鍵** `ok / reason / message` ＋ `refunded`（是否退費**只由服務端說了算**，
      前端不推斷、不補寫）；
   ② **服務端裁決原樣透傳**（回包帶 `refunded` 布爾 ⇒ 即服務端裁決；`reason` / `message`
      一字不改寫，只沿用既有「逾時」柔性補筆 `timeoutSoftNote`）；
   ③ **傳輸層 / 形狀不可辨識**（`STORAGE_UNAVAILABLE` 且**無**服務端裁決）⇒ 換成本文件凍結的
      上屏整句（全站共用傳輸文案在 AI 修復場景是**假話** —— 任務其實可能已提交 ⇒ 根除）；
      輪詢期**連續 3 次**才判死，單次失敗只記數、照常等下一輪；
   ④ **零新增 reason 字面值**；狀態只認 `SUBMITTED` / `RUNNING` / `READY` / `FAILED` 四個凍結值；
   ⑤ 輪詢之間一律 `setTimeout` **讓出事件循環**；取消 / 關窗 / 卸載**只停止等待**
      （返回 `null`），**絕不撤回服務端任務**。
   ============================================================================ */

/** 輪詢讓步：`setTimeout` 一跳（讓出事件循環；不占用渲染 / 輸入）。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 生成**本次嘗試**的 `request_id`（8〜64 位字母數字或下劃線；本函數一次調用內恒定 ⇒
 * 同一次嘗試若重發**復用同一個**才冪等 —— 契約點名）。
 * @returns {string}
 */
function makeRequestId() {
  const tail = Math.random().toString(36).slice(2, 10) /* 恰 8 位 `[0-9a-z]` */
  const stamp = Date.now().toString(36)
  return `ai_${stamp}_${tail}`.slice(0, 64)
}

/**
 * 是否為**服務端結構化失敗裁決**：回包帶 `refunded` **布爾** ⇒ 退費與否只由服務端說了算
 * （契約：`ai-enhance-submit` 失敗恰四鍵、`ai-enhance-status::FAILED` 恰五鍵，都含 `refunded`；
 * 傳輸層 / 補簽 / 形狀失敗**一律不帶該鍵**）。
 * @param {*} reply 過門回包
 * @returns {boolean}
 */
function isServerFailure(reply) {
  return Boolean(reply && reply.ok === false && typeof reply.refunded === 'boolean')
}

/**
 * 把過門回包折成**既有失敗形狀**（`{ok:false, reason, message, refunded}`；恒三鍵 ＋ `refunded`）。
 * 見本段硬口徑 ②③。
 * @param {*} reply 過門回包（可為 `null`）
 * @returns {{ok:false, reason:string, message:string, refunded:boolean}}
 */
function failureOf(reply) {
  if (isServerFailure(reply)) {
    const noted = timeoutSoftNote(reply.reason, reply.message)
    return { ok: false, reason: noted.reason, message: noted.message, refunded: reply.refunded === true }
  }
  const reason = reply && typeof reply.reason === 'string' && reply.reason !== '' ? reply.reason : 'STORAGE_UNAVAILABLE'
  if (reason !== 'STORAGE_UNAVAILABLE') {
    /* 補簽 / 前置 / 服務端非傳輸層拒絕 ⇒ **原樣透傳**（不吞真因）。 */
    return {
      ok: false,
      reason,
      message: reply && typeof reply.message === 'string' ? reply.message : '',
      refunded: false
    }
  }
  /* 傳輸層 / 形狀不可辨識 ⇒ 換成本文件凍結的上屏整句（**不偽裝 `FORBIDDEN`**）。 */
  return denial('STORAGE_UNAVAILABLE', AI_ENHANCE_TRANSPORT_MESSAGE)
}

/**
 * 把 `ai-enhance-status` 的 **`READY`** 終局回包折成**既有成功形狀**
 * （`ok / imageId / sourceImageId / preview / charge / message / mirror` —— 逐字不變）。
 * @param {object} gate 已過門的 `READY` 回包
 * @param {{sourceImageId:string, charge:object|null}} context 提交期帶過來的真實讀數（續接時為空）
 * @returns {{ok:true, imageId:string, sourceImageId:string, preview:object|null,
 *            charge:object|null, message:string, mirror:boolean}}
 */
function successOf(gate, context) {
  const held = context || {}
  /* **回包形狀校驗**：`image_id` 是後續「右格取圖」與【取】改寫指向的唯一憑據 ⇒ 缺位即如實拒絕
     （**不編造影像編號**）；`preview` / `charge` 缺位 ⇒ 對應讀數 `null`（調用方按「未記載」分檔）。 */
  const newImageId = typeof gate.image_id === 'string' ? gate.image_id.trim() : ''
  if (!newImageId) {
    return denial('STORAGE_UNAVAILABLE', '人工智能修復回包形狀不可辨識（未附修復影像編號 image_id）；本次未改印面指向。')
  }
  const preview = gate.preview && typeof gate.preview === 'object'
    ? {
        mime: typeof gate.preview.mime === 'string' ? gate.preview.mime : '',
        sha256: typeof gate.preview.sha256 === 'string' ? gate.preview.sha256 : ''
      }
    : null
  /* 扣費以 **`READY` 回包的 `charge`** 爲準（服務端判據）；它缺席才回落到提交期那一枚**真實**
     讀數（不是補 0 冒充）。 */
  const chargeSource = gate.charge && typeof gate.charge === 'object' ? gate.charge : held.charge
  const charge = chargeSource && typeof chargeSource === 'object'
    ? { amount: numberOrNaN(chargeSource.amount), balance: numberOrNaN(chargeSource.balance) }
    : null
  const replySourceImageId = typeof gate.source_image_id === 'string' ? gate.source_image_id.trim() : ''
  /* **候選行本地鏡像**（本單）：服務端附 `row` ⇒ 追加進本地影像行鏡像，右格立即出圖；
     讀 / 寫失敗或 `row` 缺席（**異步契約不含 `row`**）⇒ 只降級成 `mirror: false`（提示刷新），
     **不改判成功**。 */
  const mirror = mirrorCandidateRow(gate.row)
  return {
    ok: true,
    imageId: newImageId,
    sourceImageId: replySourceImageId || held.sourceImageId || '',
    preview,
    charge,
    message: '',
    mirror
  }
}

/**
 * **輪詢任務狀態**（op `ai-enhance-status`；每 `AI_ENHANCE_POLL_INTERVAL_MS` 一輪，
 * 最長 `AI_ENHANCE_POLL_DEADLINE_MS`，或用戶取消）。
 * @param {string} taskId 任務號
 * @param {(() => boolean)|null} shouldCancel 「只停止等待」判據（取消 / 關窗 / 卸載 ⇒ 真）
 * @param {{sourceImageId:string, charge:object|null}} context
 * @returns {Promise<object|null>} 成功形狀 / 失敗形狀；**`null` ＝ 用戶主動停止等待**
 *   （**非成功非失敗**：服務端任務不撤回，重開本窗仍可續接）。
 */
async function pollEnhanceTask(taskId, shouldCancel, context) {
  const deadline = Date.now() + AI_ENHANCE_POLL_DEADLINE_MS
  let transportFailures = 0
  for (;;) {
    /* ① 取消 / 關窗 ⇒ **只停止等待**（已在手的終局回包照常返回 ⇒ 仍「被收取」）。 */
    if (shouldCancel && shouldCancel()) return null
    /* ② 20 分鐘預算到點 ⇒ 停（任務仍在雲端，重開本窗可續接）。 */
    if (Date.now() >= deadline) return denial('STORAGE_UNAVAILABLE', AI_ENHANCE_TIMEOUT_MESSAGE)

    const gate = await userWriteGate(AI_ENHANCE_STATUS_OP, { task_id: taskId }, { readoutKeys: STATUS_READOUT_KEYS })

    if (gate && gate.ok === true) {
      /* 連通性恢復 ⇒ 清零連續傳輸失敗計數（判死門檻只認「連續」）。 */
      transportFailures = 0
      /* dev / 離線形態：門放行但**未經雲端** ⇒ 如實結構化拒絕（不編造狀態 / 扣費假讀數）。 */
      if (gate.dev === true) {
        return denial('STORAGE_UNAVAILABLE', 'dev / 離線形態：未經雲端驗證，人工智能修復不可用（非正式路徑；本次零扣費）。')
      }
      const status = typeof gate.status === 'string' ? gate.status : ''
      if (status === 'SUBMITTED' || status === 'RUNNING') {
        /* ③ 未終局 ⇒ `setTimeout` **讓出事件循環**後再問下一輪。 */
        await sleep(AI_ENHANCE_POLL_INTERVAL_MS)
        continue
      }
      if (status === 'READY') return successOf(gate, context)
      /* 狀態字面值只認四個凍結值 ⇒ 其餘一律如實結構化拒絕（不猜、不補編）。 */
      return denial('STORAGE_UNAVAILABLE', '人工智能修復狀態回包形狀不可辨識（status 非凍結字面值）；稍後重開本窗可續接。')
    }

    /* ④ 服務端 `FAILED` 裁決（`refunded` 布爾在場）⇒ **原文透傳**（不吞 message、不改寫 reason）。 */
    if (isServerFailure(gate)) return failureOf(gate)
    const reason = gate && typeof gate.reason === 'string' && gate.reason !== '' ? gate.reason : 'STORAGE_UNAVAILABLE'
    /* ⑤ 其余非傳輸層拒絕（`FORBIDDEN` / `INSUFFICIENT_POINTS` …）⇒ 同樣原文透傳。 */
    if (reason !== 'STORAGE_UNAVAILABLE') return failureOf(gate)
    /* ⑥ **傳輸層失敗不當場判死**：連續 `AI_ENHANCE_POLL_MAX_TRANSPORT_FAILURES` 次才返回；
       中間任何一次成功回到非終局狀態都把計數清零（見下）。 */
    transportFailures += 1
    if (transportFailures >= AI_ENHANCE_POLL_MAX_TRANSPORT_FAILURES) {
      return denial('STORAGE_UNAVAILABLE', AI_ENHANCE_TRANSPORT_MESSAGE)
    }
    await sleep(AI_ENHANCE_POLL_INTERVAL_MS)
  }
}

/**
 * 發起一次印面人工智能修復（**會計費**：單張 10 金；服務端裁決）—— **本單改為「提交 ＋ 輪詢狀態」**：
 * 生成 `request_id` → `ai-enhance-submit` **立即拿任務號** → 每 4 秒 `ai-enhance-status` 輪詢，
 * 最長 20 分鐘或**用戶取消**；得 `READY` 拼既有成功形狀、得 `FAILED` 按既有失敗形狀**原文透傳**。
 *
 * 前置（零網路）：未登錄 ⇒ `LOGIN_REQUIRED`；非管理員 ⇒ `NOT_ADMIN`；三鍵缺任一 ⇒ `INVALID_INPUT`。
 * 過門後一律交雲端；失敗（補簽 / 服務端拒絕 / 傳輸 / 形狀不可辨識）⇒ **原樣透傳** `{ok:false, …}`
 * （傳輸層例外：換成本文件凍結的上屏整句，見 `AI_ENHANCE_TRANSPORT_MESSAGE`）。
 *
 * @param {{image_id:string, seal_id:string, face_id:string}} input 載荷（封閉三鍵）
 * @param {{taskId?:string, sourceImageId?:string, onTask?:(taskId:string)=>void,
 *          shouldCancel?:()=>boolean}} [runtime] **本單新增的運行時縫**（不改回包形狀）：
 *   `taskId` ＝ **續接**既有任務（詳情頁開窗時由 `listCandidates` / 本組件記憶給出 ⇒ **不再
 *   submit**，直接輪詢同一個 `task_id`）；`sourceImageId` ＝ 續接時的原圖編號（列表行帶出）；
 *   `onTask` ＝ 提交一拿到任務號就回呼（調用方**立刻記住**，關窗後才可續接）；
 *   `shouldCancel` ＝ 「只停止等待」判據（取消 / 關窗 / 卸載 ⇒ 真）—— 真 ⇒ 返回 `null`，
 *   **服務端任務不撤回**。
 * @returns {Promise<{ok:true, imageId:string, sourceImageId:string,
 *          preview:{mime:string, sha256:string}|null,
 *          charge:{amount:number, balance:number}|null,
 *          mirror:boolean}
 *          |{ok:false, reason:string, message:string, refunded:boolean}>}
 *          成功必帶 `mirror`：`true` ＝ 本機影像行鏡像已含服務端回的候選行；
 *          `false` ＝ 未鏡像成功（`row` 缺席 / 鏡像讀寫失敗）⇒ 仍 `ok: true`，UI 可據此提示刷新；
 *          **`null` ＝ 用戶主動停止等待**（`shouldCancel` 爲真；非成功非失敗、任務不撤回）。
 */
export async function enhanceFaceImage(input, runtime) {
  const opts = runtime || {}
  const payload = input || {}
  const imageId = String(payload.image_id === undefined || payload.image_id === null ? '' : payload.image_id).trim()
  const sealId = String(payload.seal_id === undefined || payload.seal_id === null ? '' : payload.seal_id).trim()
  const faceId = String(payload.face_id === undefined || payload.face_id === null ? '' : payload.face_id).trim()
  if (!isLoggedIn.value) {
    return denial(LOGIN_REQUIRED, '請先登錄後再使用人工智能修復（前端前置；未發出任何請求、未扣金）。')
  }
  if (!isAdmin.value) {
    return denial(NOT_ADMIN, '僅管理員可以使用人工智能修復（前端前置；未發出任何請求、未扣金）。')
  }
  if (!imageId || !sealId || !faceId) {
    return denial(
      INVALID_INPUT,
      `人工智能修復需要原圖影像編號（image_id）／印章編號（seal_id）／印面編號（face_id）三鍵齊備，本次未發出任何請求、未扣金。`
    )
  }

  /* ------------------------------------------------------------------
     ① **提交**（op `ai-enhance-submit`；**立即回任務號**，上游在雲端繼續跑）——
     或**續接**既有任務（`runtime.taskId` 由詳情頁開窗的 `listCandidates` / 本組件記憶給出
     ⇒ **不再 submit**，直接輪詢同一個 `task_id`）。
     提交 / 狀態兩發都走**全局默認超時預算**（15000 ms；它們都是**快回包**）——
     只有 legacy 的 `ai-enhance-face` 才需要 `AI_ENHANCE_TIMEOUT_MS`（120000），全局默認逐字不變。
     ------------------------------------------------------------------ */
  const shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : null
  const onTask = typeof opts.onTask === 'function' ? opts.onTask : null
  let sourceImageId = typeof opts.sourceImageId === 'string' ? opts.sourceImageId.trim() : ''
  let charge = null
  let taskId = String(opts.taskId === undefined || opts.taskId === null ? '' : opts.taskId).trim()

  if (taskId === '') {
    const submitted = await userWriteGate(
      AI_ENHANCE_SUBMIT_OP,
      { image_id: imageId, seal_id: sealId, face_id: faceId, request_id: makeRequestId() },
      { readoutKeys: SUBMIT_READOUT_KEYS }
    )
    if (submitted && submitted.ok === true && submitted.dev === true) {
      /* dev / 離線形態：門放行但**未經雲端** ⇒ 如實結構化拒絕（不編造修復影像 / 扣費假讀數）。 */
      return denial('STORAGE_UNAVAILABLE', 'dev / 離線形態：未經雲端驗證，人工智能修復不可用（非正式路徑；本次零扣費）。')
    }
    /* 傳輸層 / 補簽 / 服務端結構化拒絕 ⇒ 折成既有失敗形狀（服務端的 `reason` / `message`
       **一字不改寫**；傳輸層換成本文件凍結的上屏整句）。 */
    if (!submitted || submitted.ok !== true) return failureOf(submitted)
    taskId = typeof submitted.task_id === 'string' ? submitted.task_id.trim() : ''
    if (taskId === '') {
      return denial('STORAGE_UNAVAILABLE', '人工智能修復提交回包形狀不可辨識（未附任務編號 task_id）；本次未改印面指向。')
    }
    sourceImageId = typeof submitted.source_image_id === 'string' ? submitted.source_image_id.trim() : sourceImageId
    charge = submitted.charge && typeof submitted.charge === 'object' ? submitted.charge : null
    /* **任務號立刻交調用方記住**（關窗 / 取消後重開仍可續接；本文件零存儲、零瀏覽器存儲）。 */
    try {
      onTask(taskId)
    } catch {
      /* 記憶回呼失敗**不改判**本次調用（續接另有 `listCandidates` 這條正路）。 */
    }
  }

  /* ------------------------------------------------------------------
     ② **輪詢**（op `ai-enhance-status`；每 4 秒一輪、最長 20 分鐘或用戶取消）。
     `READY` ⇒ 既有成功形狀；`FAILED` ⇒ 既有失敗形狀（服務端 `reason` / `message` 原文透傳）。
     ------------------------------------------------------------------ */
  return pollEnhanceTask(taskId, shouldCancel, { sourceImageId, charge })
}

/**
 * **列本印面的修復任務**（op `ai-enhance-list`；**新增導出**）—— 詳情頁**開窗先調它**，
 * 據此續接未完成的修復任務（`SUBMITTED` / `RUNNING` ⇒ 續輪詢同一個 `task_id`；
 * `READY` 且尚未被本印面採納 ⇒ 直接進「已完成」態）。
 *
 * @param {string} faceId 印面編號
 * @returns {Promise<{ok:true, rows:Array}|{ok:false, reason:string, message:string, refunded:boolean}>}
 *          `rows` **逐字透傳**（服務端行面原樣；不改寫、不補編任何鍵、不派生假行）。
 */
export async function listCandidates(faceId) {
  const id = String(faceId === undefined || faceId === null ? '' : faceId).trim()
  if (!id) {
    return denial(INVALID_INPUT, '候選修復任務清單需要印面編號（face_id），本次未發出任何請求。')
  }
  const gate = await userWriteGate(AI_ENHANCE_LIST_OP, { face_id: id }, { readoutKeys: LIST_READOUT_KEYS })
  /* dev / 離線形態：門放行但**未經雲端** ⇒ 如實結構化拒絕（沒有服務端任務可列）。 */
  if (gate && gate.ok === true && gate.dev === true) {
    return denial('STORAGE_UNAVAILABLE', 'dev / 離線形態：未經雲端驗證，候選修復任務清單不可用（非正式路徑）。')
  }
  if (!gate || gate.ok !== true) return failureOf(gate)
  if (!Array.isArray(gate.rows)) {
    return denial('STORAGE_UNAVAILABLE', '候選修復任務清單回包形狀不可辨識（未附 rows 陣列）；稍後重開本窗可再試。')
  }
  return { ok: true, rows: gate.rows }
}
