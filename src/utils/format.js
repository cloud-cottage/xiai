/** 玺爱 · 格式化工具 */

/**
 * 勘误三态文案。显示文案不随枚举改名而变化：「已采纳」不变。
 * 键为规范冻结字面值 PENDING / ACCEPTED / REJECTED；
 * 另保留旧字面值 APPROVED（读取时已由数据层归一，此处仅作防御性兜底）。
 */
const STATUS_LABELS = {
  PENDING: '待審覈',
  ACCEPTED: '已採納',
  APPROVED: '已採納',
  REJECTED: '駁回'
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || '待審覈'
}

export function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 取印文首字，用于无外链场景下的印面缩略字符位。 */
export function sealGlyph(text) {
  if (typeof text !== 'string' || text.length === 0) return '印'
  return Array.from(text)[0]
}

/**
 * **導入行審核循環的終態文案（累計口徑｜F-1）** —— 純函式（零 IO / 零副作用，可直接調用自測）。
 *
 * 修正對象 ＝ `MyCorrectionsView.vue::runImportReviewLoop` 逐輪覆寫 `message`、只剩末輪條數
 * ⇒ 同一屏出現兩個條數（進度「已處理 1000」對終態「已駁回 200」）。
 *
 * 口徑（**唯一**）：`count` ＝ 逐輪 `accepted_ids.length` ＋ `rejected_ids.length` 的**累計**；
 * `rounds` ＝ **實際完成**（回包 `ok === true`）的服務端調用次數；動詞隨 `decision`
 * （`ACCEPTED` ⇒ 採納，其餘 ⇒ 駁回；**不寫死**）。
 * `remaining` **缺席**（`null` / `undefined` / 非有限數）⇒ **不寫「剩餘」一句**（**不得填 0**）；
 * 僅 `remaining > 0` 才附「剩餘 N 條，可再次點擊續審」。
 * `skippedCount` / `failedCount` ＝ 逐輪回包 `skipped.length` / `failed.length` 的**累計**
 * （**回包陣列長度，唯一真源**；不得由 `done` / `remaining` 推）；可選，預設 0。
 *
 * 真因讀數（失敗 / 跳過）的處置（**不吞掉** ／ **不重複報**）：
 *   · `rounds === 1` ⇒ 服務端 `message` 與累計口徑**同值**（單次調用不存在「只剩末輪」問題）
 *     ⇒ **原樣前置保留**；該句內**已含**「失敗 N / 跳過 M」（如 `已採納 200 條…（失敗 3 / 跳過 2）`）
 *     ⇒ 本函式**不再追加**失敗 / 跳過一段（**不重複報**）；
 *   · `rounds > 1` ⇒ 服務端 `message` 的條數僅為末輪，原樣拼接即**重現 F-1**（同一屏兩個條數）
 *     ⇒ **不拼**；另**只補回真因**：`failedCount > 0` 或 `skippedCount > 0` 時，於基句括號內
 *     追加 `；失敗 f · 跳過 s`（**只列 > 0 的那一項**；兩項皆 0 ⇒ **不追加**，**不編造**）。
 *     （其餘真因面在失敗 / 中斷路徑由調用方原文上屏，不經此函式。）
 */
export function importReviewFeedbackText({
  decision,
  count,
  rounds,
  remaining,
  serverMessage,
  skippedCount,
  failedCount
} = {}) {
  const verb = String(decision || '') === 'ACCEPTED' ? '採納' : '駁回'
  const n = Number.isFinite(Number(count)) ? Number(count) : 0
  const r = Number.isFinite(Number(rounds)) ? Number(rounds) : 0
  const hasRemaining = remaining !== null && remaining !== undefined && Number.isFinite(Number(remaining))
  const tail = hasRemaining && Number(remaining) > 0 ? `；剩餘 ${Number(remaining)} 條，可再次點擊續審` : ''
  /* 真因累計（回包陣列長度，唯一真源）；非有限數一律歸 0 ⇒ 不外洩 NaN、不編造。 */
  const skipped = Number.isFinite(Number(skippedCount)) ? Number(skippedCount) : 0
  const failed = Number.isFinite(Number(failedCount)) ? Number(failedCount) : 0
  const reasons = []
  if (failed > 0) reasons.push(`失敗 ${failed}`)
  if (skipped > 0) reasons.push(`跳過 ${skipped}`)
  /* 僅多輪（`rounds > 1`）且真因非零才補；單輪由服務端原文自帶 ⇒ 不重複報。 */
  const reasonTail = r > 1 && reasons.length > 0 ? `；${reasons.join(' · ')}` : ''
  const base = `本輪共${verb} ${n} 條（共 ${r} 次調用${reasonTail}）${tail}。`
  const server = String(serverMessage || '')
  return server && r === 1 ? `${server}｜${base}` : base
}
