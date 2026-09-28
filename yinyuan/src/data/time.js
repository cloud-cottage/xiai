/**
 * 时间口径工具（spec §7.5）：存储一律 UTC ISO8601，展示一律 Asia/Shanghai。
 * 归属日 / 月按 CST 派生（UsageRecord.cstDate / cstMonth、LedgerEntry 同）。
 */
import { TIMEZONE } from '@/config/env.js'

const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
})
const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
})

/** UTC ISO → CST 归属日 'YYYY-MM-DD'。 */
export function toCstDate(iso) {
  if (!iso) return '—'
  return DATE_FMT.format(new Date(iso))
}

/** UTC ISO → CST 归属月 'YYYY-MM'。 */
export function toCstMonth(iso) {
  if (!iso) return '—'
  return toCstDate(iso).slice(0, 7)
}

/** UTC ISO → 展示串 'YYYY-MM-DD HH:mm CST'。 */
export function toCstDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${DATE_FMT.format(d)} ${TIME_FMT.format(d)} CST`
}

const DAY_MS = 86400000

/**
 * 最近 N 个 **CST 自然桶**（升序），用于图表 X 轴与数据对齐（spec §1.3 P-M1-04 04-3）。
 *
 * 说明：适配层聚合方法（A12）只返回**有数据**的桶，若无数据月/日则缺席；
 * 图表轴必须覆盖完整窗口（否则「近 12 月」只剩两三个刻度），故由本纯函数提供轴刻度，
 * 页面把 A12 序列映射到该轴上（缺席桶显示零值，符合 §1.3 交互 5「不显示占位假数字」）。
 *
 * @param {'day'|'month'} bucket 桶粒度
 * @param {number} count 桶数量（含当期）
 * @param {Date} [now] 注入时钟（测试用）
 * @returns {string[]} 'YYYY-MM-DD'（day）或 'YYYY-MM'（month），升序
 */
export function recentCstBuckets(bucket, count, now = new Date()) {
  const n = Math.max(1, Math.floor(Number(count) || 0))
  const out = []
  if (bucket === 'month') {
    const [year, month] = toCstMonth(now.toISOString()).split('-').map(Number)
    for (let i = n - 1; i >= 0; i -= 1) {
      const total = year * 12 + (month - 1) - i
      out.push(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`)
    }
    return out
  }
  // CST 自然日锚点：'YYYY-MM-DDT00:00:00Z' 在 CST 即当日 08:00，故 toCstDate 原样返回该日
  const anchor = Date.parse(`${toCstDate(now.toISOString())}T00:00:00Z`)
  for (let i = n - 1; i >= 0; i -= 1) {
    out.push(toCstDate(new Date(anchor - i * DAY_MS).toISOString()))
  }
  return out
}
