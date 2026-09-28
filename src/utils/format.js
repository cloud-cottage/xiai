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
