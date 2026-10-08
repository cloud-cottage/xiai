/**
 * 玺爱 · 剪贴板图片粘贴（**共用纯函数**，三处上传面共用）
 * ============================================================================
 * 适用上传面三处：**新增印章印面图**（`UploadSealDialog.vue`）／**上传实物照片**／
 * **替换印面图**（均 `SealDetailView.vue`）。
 *
 * 设计纪律（本模块是「处理体」的可测内核，不含任何组件状态）：
 *   1. **纯逻辑**：只做「读剪贴板对象 → 判定是否接管 → 取出图片文件」的决策；
 *      不触碰组件状态、不写任何存储、不发任何网络请求、不读文件内容。
 *      —— 因此可在本机 Node 下用合成对象离线自检（见 `scripts/verify-clipboard-paste.mjs`）。
 *   2. **文本优先不劫持**：剪贴板同时含非空纯文本时，**一律不接管**
 *      （`handled:false` ＋ reason `TEXT_PRIORITY`），把浏览器默认的文本粘贴留给用户；
 *      仅当「没有文字、且有图片文件」时才接管（`handled:true`）。
 *   3. **共用处理体**：三处上传面各自把「选图处理体」抽成 `apply*(file)`，
 *      `@change`（选择本机文件）与 `@paste`（一键粘贴）共用**同一**处理体 ⇒
 *      解码 / 上限校验 / 取景 / 入库口径全站只有一份，不因多一条入口而分叉。
 */

/** 上传面可读提示（繁體）：说明可直接粘贴剪贴板图片，且文字优先不劫持。 */
export const PASTE_HINT =
  '亦可直接粘貼剪貼板中的圖片：游標置於本區按 Ctrl/⌘+V，即取剪貼板中的圖片，無需先另存爲檔案。' +
  '剪貼板同時含文字時按文字粘貼（文字優先），不會被截走。'

/** 文本优先降级说明：本区**不接管**这次粘贴时给用户的可读交代（繁體）。 */
export const PASTE_TEXT_PRIORITY_MESSAGE =
  '剪貼板同時含文字，已按你的文字粘貼（文字優先，未改爲貼圖）。'

/** 无图片说明：剪贴板里没有图片时给用户的可读交代（繁體）。 */
export const PASTE_NO_IMAGE_MESSAGE =
  '剪貼板中沒有圖片，請改爲點按「選擇本機圖片文件」上傳。'

/** 冻结的接管判定字面值（供调用方分支，不参与上屏）。 */
export const PASTE_REASONS = Object.freeze({
  IMAGE: 'IMAGE',
  TEXT_PRIORITY: 'TEXT_PRIORITY',
  NO_IMAGE: 'NO_IMAGE'
})

/** 纯：按 MIME 判是否图片（`image/*`）。 */
export function isImageMime(mime) {
  return String(mime || '')
    .trim()
    .toLowerCase()
    .startsWith('image/')
}

/**
 * 纯：读剪贴板里的纯文本（缺失 / 不可读 ⇒ 空串）。
 * 只读不写、无副作用；依次尝试 `text/plain` → `text` → `Text`。
 * @param {{getData?:(type:string)=>string}} clipboardData
 */
export function clipboardPlainText(clipboardData) {
  if (!clipboardData || typeof clipboardData.getData !== 'function') return ''
  for (const type of ['text/plain', 'text', 'Text']) {
    try {
      const value = clipboardData.getData(type)
      if (typeof value === 'string' && value !== '') return value
    } catch {
      /* 读某类型失败 ⇒ 试下一个；都不行即当「无文本」。 */
    }
  }
  return ''
}

/**
 * 纯：列出剪贴板里的图片文件（只认 `kind==='file'` 且 MIME 为 `image/*`）。
 * 优先走 `items`（`getAsFile`）；退路是 `files`。**不读文件内容**（只取 File 句柄）。
 * @param {{items?:Array, files?:Array}} clipboardData
 * @returns {Array} 图片文件数组（可能为空）
 */
export function clipboardImageFiles(clipboardData) {
  if (!clipboardData) return []
  const out = []
  const items = clipboardData.items
  if (items && typeof items.length === 'number') {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (!item || item.kind !== 'file' || !isImageMime(item.type)) continue
      if (typeof item.getAsFile !== 'function') continue
      let file = null
      try {
        file = item.getAsFile()
      } catch {
        file = null
      }
      if (file) out.push(file)
    }
  }
  if (out.length === 0 && clipboardData.files && typeof clipboardData.files.length === 'number') {
    for (let i = 0; i < clipboardData.files.length; i += 1) {
      const file = clipboardData.files[i]
      if (file && isImageMime(file.type)) out.push(file)
    }
  }
  return out
}

/**
 * 纯函数：决定一次粘贴是否应由本上传面**接管**。
 *
 * 判定顺序（**文本优先**）：
 *   ① 剪贴板含非空纯文本 ⇒ `{ handled:false, reason:'TEXT_PRIORITY' }`（绝不劫持）；
 *   ② 否则无图片文件   ⇒ `{ handled:false, reason:'NO_IMAGE' }`；
 *   ③ 否则（有图片、无文字）⇒ `{ handled:true, reason:'IMAGE', file }`。
 *
 * @param {object} clipboardData 原生 `ClipboardEvent.clipboardData`（或同形合成对象）
 * @returns {{handled:boolean, reason:string, file:File|null, message:string}}
 *   `message` 为可读繁體交代；**接管时为空串**（界面零噪声）。
 */
export function resolvePastedImage(clipboardData) {
  const text = clipboardPlainText(clipboardData)
  if (text.trim() !== '') {
    /* 文本优先：剪贴板同时含文字 ⇒ 不劫持（保留浏览器默认文本粘贴行为）。 */
    return {
      handled: false,
      reason: PASTE_REASONS.TEXT_PRIORITY,
      file: null,
      message: PASTE_TEXT_PRIORITY_MESSAGE
    }
  }
  const files = clipboardImageFiles(clipboardData)
  if (files.length === 0) {
    return {
      handled: false,
      reason: PASTE_REASONS.NO_IMAGE,
      file: null,
      message: PASTE_NO_IMAGE_MESSAGE
    }
  }
  return { handled: true, reason: PASTE_REASONS.IMAGE, file: files[0], message: '' }
}

/**
 * 共用处理体入口：把一次 `paste` 事件转成决策，并在**接管**时调用 `accept(file)`。
 *
 * ⚠️ **本函数不调用 `preventDefault`**：由调用方按 `handled` 自行决定 ——
 * 文本优先（`handled:false`）时必须**放行**默认行为，否则就变成劫持。
 *
 * @param {object} event 原生 paste 事件（读 `clipboardData`，退回 `dataTransfer`）
 * @param {(file:File)=>void} [accept] 接管时接收图片文件（其内部处理体与选图同源）
 * @returns {{handled:boolean, reason:string, file:File|null, message:string}} 同上
 */
export function handleClipboardPaste(event, accept) {
  const data = event && (event.clipboardData || event.dataTransfer)
  const decision = resolvePastedImage(data)
  if (decision.handled && typeof accept === 'function') accept(decision.file)
  return decision
}
