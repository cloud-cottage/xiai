/**
 * 玺爱 · **「人工智能修復」門面（印面影像）**（本單新增）
 * ============================================================================
 * 包装云函数 `xiai-user-token` 的 **2 個 op**（鍵面與服務端 `lib/ops.js` 注册面**逐字一致**）：
 *   · `ai-enhance-face`（管理員面；服務端另有獨立管理員門 ＋ 計費判定）；
 *   · `ai-enhance-discard`（管理員面；棄置候選修復圖；**不涉及退款**）。
 *
 * **通道（唯一、不另造第二條）**：`userWrite.js::userWriteGate` → `token.js::userGate` →
 * `data/cloudbaseFn.js::callCloudFunction('xiai-user-token', …)` —— 與勘誤 / 採信 / AI 金鑰等
 * 既有寫面**同一條**用戶令牌通道（含「刷新後靜默補簽」自愈）。本文件**不直連** `callCloudFunction`、
 * **不自建**第二套装载；回包讀數面經 `gate()` 的 `options.readoutKeys` **additive 透傳**声明取得。
 *
 * 契約（**服務端單並行實現，以此為準**；本文件只做形狀校驗、**不補編任何鍵**）：
 *   · `ai-enhance-face` 載荷**封閉三鍵**：`image_id`（原圖）/ `seal_id` / `face_id`；
 *     成功回包：`{ok:true, image_id, source_image_id, preview:{mime, sha256}, charge:{amount, balance}}`；
 *     失敗回包：`{ok:false, reason, message, refunded}`（`refunded === true` ⇒ 本次未消耗金）。
 *   · `ai-enhance-discard` 載荷**封閉一鍵**：`image_id`（候選影像編號）；
 *     成功回包**恰 3 鍵**：`{ok:true, image_id, deleted_objects}`；
 *     失敗回包**恰 3 鍵**：`{ok:false, reason, message}`（**無 `refunded`** —— 弃置不退款）。
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
 * ============================================================================
 */

import { isAdmin, isLoggedIn } from '../data/session.js'
import { userWriteGate } from './userWrite.js'

/** 雲函數 op 名（與 `lib/ops.js` 注册面逐字一致；全倉唯一出現處）。 */
export const AI_ENHANCE_OP = 'ai-enhance-face'

/**
 * **棄置候選修復圖**的 op 名（服務端單並行實現；全倉唯一出現處，與 `AI_ENHANCE_OP` 同族）。
 *
 * 語義：管理員對**本次修復產出的候選影像**不滿意 ⇒ 請服務端棄置（移除）該候選影像。
 * **不涉及退款**（修復金在上游成功時已花掉；棄置只是清掉不想要的候選件）。
 */
export const AI_ENHANCE_DISCARD_OP = 'ai-enhance-discard'

/** **單張修復成本（金）**：調用前在彈窗內明示；**實際扣費以回包 `charge.amount` 爲準**（服務端是判據）。 */
export const AI_ENHANCE_COST = 10

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
    return {
      ok: false,
      reason: (gate && gate.reason) || 'STORAGE_UNAVAILABLE',
      message: (gate && gate.message) || '棄置候選圖服務暫時不可用，請稍後再試。'
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
 * 發起一次印面人工智能修復（**會計費**：單張 10 金；服務端裁決）。
 *
 * 前置（零網路）：未登錄 ⇒ `LOGIN_REQUIRED`；非管理員 ⇒ `NOT_ADMIN`；三鍵缺任一 ⇒ `INVALID_INPUT`。
 * 過門後一律交雲端；失敗（補簽 / 服務端拒絕 / 傳輸 / 形狀不可辨識）⇒ **原樣透傳** `{ok:false, …}`。
 *
 * @param {{image_id:string, seal_id:string, face_id:string}} input 載荷（封閉三鍵）
 * @returns {Promise<{ok:true, imageId:string, sourceImageId:string,
 *          preview:{mime:string, sha256:string}|null,
 *          charge:{amount:number, balance:number}|null}
 *          |{ok:false, reason:string, message:string, refunded:boolean}>}
 */
export async function enhanceFaceImage(input) {
  const options = input || {}
  const imageId = String(options.image_id === undefined || options.image_id === null ? '' : options.image_id).trim()
  const sealId = String(options.seal_id === undefined || options.seal_id === null ? '' : options.seal_id).trim()
  const faceId = String(options.face_id === undefined || options.face_id === null ? '' : options.face_id).trim()
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

  const gate = await userWriteGate(
    AI_ENHANCE_OP,
    { image_id: imageId, seal_id: sealId, face_id: faceId },
    { readoutKeys: READOUT_KEYS }
  )
  /* 传输层 / 補簽 / 服務端結構化拒絕 ⇒ **原樣透傳**（`refunded` 有鍵才帶，不補寫）。 */
  if (!gate || gate.ok !== true) {
    return {
      ok: false,
      reason: (gate && gate.reason) || 'STORAGE_UNAVAILABLE',
      message: (gate && gate.message) || '人工智能修復服務暫時不可用，請稍後再試。',
      refunded: Boolean(gate && gate.refunded === true)
    }
  }
  if (gate.dev === true) {
    /* dev / 離線形態：門放行但**未經雲端** ⇒ 如實結構化拒絕（不編造修復影像 / 扣費假讀數）。 */
    return denial('STORAGE_UNAVAILABLE', 'dev / 離線形態：未經雲端驗證，人工智能修復不可用（非正式路徑；本次零扣費）。')
  }

  /* **回包形狀校驗**：`image_id` 是後續「右格取圖」與【取】改寫指向的唯一憑據 ⇒ 缺位即如實拒絕
     （**不編造影像編號**）；`preview` / `charge` 缺位 ⇒ 對應讀數 `null`（調用方按「未記載」分檔）。 */
  const newImageId = typeof gate.image_id === 'string' ? gate.image_id.trim() : ''
  if (!newImageId) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '人工智能修復回包形狀不可辨識（未附修復影像編號 image_id）；本次未改印面指向。',
      refunded: false
    }
  }
  const preview = gate.preview && typeof gate.preview === 'object'
    ? {
        mime: typeof gate.preview.mime === 'string' ? gate.preview.mime : '',
        sha256: typeof gate.preview.sha256 === 'string' ? gate.preview.sha256 : ''
      }
    : null
  const charge = gate.charge && typeof gate.charge === 'object'
    ? { amount: numberOrNaN(gate.charge.amount), balance: numberOrNaN(gate.charge.balance) }
    : null
  return {
    ok: true,
    imageId: newImageId,
    sourceImageId: typeof gate.source_image_id === 'string' ? gate.source_image_id.trim() : '',
    preview,
    charge,
    message: ''
  }
}
