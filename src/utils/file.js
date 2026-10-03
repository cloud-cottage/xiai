/** 玺爱 · 本地文件工具
 *
 * 零外链约束下，本机生成与保存文件，不发起任何外部网络请求。
 */

/** 在本机保存一个纯文本文件。 */
export function saveLocalText(filename, content) {
  if (typeof document === 'undefined') return false
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  return true
}

/** 在本机保存一个二进制文件（字節原样落盘；**不做任何转码 / 加水印**）。 */
export function saveLocalBinary(filename, bytes, mime) {
  if (typeof document === 'undefined') return false
  const view = bytes instanceof Uint8Array
    ? bytes
    : (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(bytes))
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes || [])
  const blob = new Blob([view], { type: mime || 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  return true
}

/**
 * 把用户选择的图片读成数据地址（仅本机读取，不上传）。
 *
 * ⚠️ **兼容保留**（旧调用方 `UploadSealDialog.vue` 仍用它做印面图预览 → 由数据层
 * `normalizeImagePayload` 收口成字节）。**实物照片 / 任何新增上传路径不得再用它**：
 * dataURL 形态既会放大体量（base64 ≈ 4/3 字节），也会诱使实现方把整张图写进
 * `localStorage`（AC-33 判负根因）。新增上传请走 `utils/image.js`
 * （`loadImageFile` → `exportSquareImage`）产出**二进制**，再由服务层入库。
 */
export function readImageAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve({ ok: false, message: '請選擇圖片文件' })
      return
    }
    if (!String(file.type || '').startsWith('image/')) {
      resolve({ ok: false, message: '請選擇圖片文件（JPG / PNG / WebP）' })
      return
    }
    const reader = new FileReader()
    reader.onload = () => resolve({ ok: true, dataUrl: String(reader.result || '') })
    reader.onerror = () => resolve({ ok: false, message: '圖片讀取失敗，請重試' })
    reader.readAsDataURL(file)
  })
}

/**
 * 印面资料清单（**独立工具，不在「下載高清原圖」路径上**）：把一枚印章的印面资料与影像摘要
 * 汇成一份纯文本清单 —— 只列**资料与摘要**，**清单本身不是影像**。
 *
 * ⚠️ **文案纠偏（2026-09-23｜K-P4b）**：本函数此前写着「演示數據不含真實圖象，下載內容爲
 * 印面資料清單…」——**该表述已不成立**：庫内影像是**真图象**（新增产物 ＝ 单页 8bit Deflate
 * TIFF），且「下載高清原圖」下發的是**真图象的原始存檔字節**（不加水印、不經切分内核、
 * 零轉碼），不是資料清單。⇒ 本函数只承担「资料清单」这一独立用途，**不得再被当作下载产物**。
 *
 * 清单按**印面**逐条列出（含边款），三类属性取自各印面自身。
 *
 * **R-44 / R-49（2026-09-20｜主印面口径收敛）**：改前此处手写了一份
 * `faces.find((face) => face.kind === 'FACE')`（**同一语义的第六处实现**），本单清掉。
 * **本函数不自行选主印面**：`seal.faceImage` **就是**上游（`services/seals.js` 的
 * `listSeals` / `getSealById` 视图模型）按 R-44 冻结口径 —— 调用**数据层单点**
 * `db.primaryFaceIn` —— 选出的**主印面的印面图片（影像行）**；本函数只消费它
 * （＝「向上接受一个已选好的主印面」，不在此处再写一份 `kind === 'FACE'` 的规则）。
 *
 * 为什么不是自己 import 数据层的 `primaryFaceIn`（**不得硬塞依赖**）：本文件由**页面 / 组件**
 * （`SquareView.vue` / `SealDetailView.vue`）直接 import，而数据层文件头写明
 * 「本文件是 services 层的下游；**组件不得直接 import 本文件**」—— 若在此 import，页面 →
 * `utils/file.js` → `data/db.js` 的模块图就绕开了服务层（层级倒置）。
 * 故**收敛方式＝消费上游已选好的主印面影像**，本文件内**不得**再出现
 * `kind === 'FACE'` 之流的主印面选择谓词。
 *
 * **显示名（r2 读面接线）同一条纪律**：本函数**不 import** `services/corrections.js`
 * （同为层级倒置）⇒ 印文显示值由**调用方**按**单点** `resolveSealDisplayName` 算好后经
 * 第 2 参 `displayName` 传入（采纳值 → 原始 `seal_name` →「佚名」恰一处）；缺省才回落到
 * 行自带的 `seal_name`，两者皆空才「佚名」。
 * @param {object} seal 印章视图模型（含 `faces` / `faceImage` / `edgeImages`）
 * @param {string} [displayName=''] 由 `services/corrections.js::resolveSealDisplayName` 算出的显示印文
 */
export function hdManifestText(seal, displayName = '') {
  const faces = (seal && seal.faces) || []
  const face = (seal && seal.faceImage) || {}
  const edges = (seal && seal.edgeImages) || []
  const rawName = displayName || String((seal && seal.seal_name) || '')
  const lines = [
    '璽愛 · 高清印面資料',
    '（本清單爲印面資料與影像摘要；影像原件請於頁面以「下載高清原圖」下載）',
    `印章編號：${seal.stamp_id}`,
    `印文：${rawName || '佚名'}`,
    `朝代：${seal.dynasty || '—'}`,
    `分類：${seal.seal_type || '—'}`,
    `作者：${seal.author || '—'}`,
    `材質：${seal.material || '—'}`,
    `印文釋義：${seal.transcription || '—'}`,
    `印面影像標識：${face.id || '—'}`,
    `影像摘要（SHA-256）：${face.sha256 || '—'}`,
    `影像尺寸：${face.width || '—'} × ${face.height || '—'}`,
    `影像體量：${face.bytes === undefined ? '—' : `${face.bytes} 字節`}`,
    `色彩模式：${face.color_mode || '—'}`,
    `邊款影像標識：${edges.map((img) => img.id).join('、') || '無'}`,
    '',
    `印面清單（共 ${faces.length} 個）：`
  ]
  faces.forEach((item, index) => {
    lines.push(
      `  ${index + 1}. ${item.kind === 'EDGE' ? '邊款' : '印面'} ${item.id}`,
      `     印文：${item.seal_name || '—'}`,
      `     朝代 / 分類 / 作者：${item.dynasty || '—'} / ${item.seal_type || '—'} / ${item.author || '—'}`,
      `     印面圖片：${item.face_image_id || '—'}`
    )
    if (item.edge_image_ids && item.edge_image_ids.length > 0) {
      lines.push(`     邊款圖片 ID：${item.edge_image_ids.join('、')}`)
    }
  })
  return `${lines.join('\n')}\n`
}
