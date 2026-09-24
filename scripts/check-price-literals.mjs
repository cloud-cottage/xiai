/**
 * spec §4.3 校验：除单一配置源（src/config/pricing.js）外，
 * 页面 / 组件 / 文案 / 样式中不得出现价格与包量字面量。
 *
 * 用法：node scripts/check-price-literals.mjs
 * 例外仅允许「行级 + 文件级」双重命中，且必须写明理由（见 EXCEPTIONS）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const EXTS = ['.js', '.mjs', '.vue', '.css', '.html']

/** 全文件豁免：唯一价格与包量配置源（spec §4.3）。 */
const FILE_ALLOWED = new Set(['src/config/pricing.js', 'scripts/check-price-literals.mjs'])

/** 行级豁免：必须同时命中文件与行模式，并写明理由。 */
const EXCEPTIONS = [
  {
    file: 'src/config/app-config.js',
    line: /demoEnvQuota/,
    reason: '演示环境额度（spec §11 待决 18：30 天 + 2,000 次），非付费套餐包量；不作为任何商品价格消费',
  },
]

/** spec §4.3 明列的字面量 */
const PATTERNS = [
  ['3600', /\b3600\b/],
  ['12000', /\b12000\b/],
  ['36000', /\b36000\b/],
  ['2000', /\b2000\b/],
  ['10000', /\b10000\b/],
  ['50000', /\b50000\b/],
  ['0.80 / 0.8', /0\.80?\b/],
  ['0.50 / 0.5', /0\.50?\b/],
  ['0.30 / 0.3', /0\.30?\b/],
  ['2.00', /\b2\.00\b/],
  // —— D7 扩充（防回归）：充值档位金额（§4.3 充值档位校验 / §11.1-②）——
  // 界面出现的档位必须来自 PRICING.recharge.presetsCents，不得在页面/文案里写死。
  ['充值档 1000 元', /(?<![\d.,])1000\s*元/],
  ['充值档 5000 元', /(?<![\d.,])5000\s*元/],
  ['充值档 10000 元', /(?<![\d.,])10000\s*元/],
  ['充值档分 100000', /(?<![\d.,])100000\b(?!\d)/],
  ['充值档分 500000', /(?<![\d.,])500000\b(?!\d)/],
  ['充值档分 1000000', /(?<![\d.,])1000000\b(?!\d)/],
  // —— D7 扩充（防回归）：典型场景数字（§4.3 场景文案插值 / §8.5-3）——
  // 必须由 getPricingTable().scenarioText 插值，页面不得硬编码「200 次 / 100 方 / 10 张」。
  ['场景 200 次', /\b200\s*次/],
  ['场景 100 方', /\b100\s*方/],
  ['场景 10 张', /\b10\s*张/],
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (EXTS.some((e) => name.endsWith(e))) out.push(full)
  }
  return out
}

const hits = []
let exempted = 0
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file)
  if (FILE_ALLOWED.has(rel)) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const [label, re] of PATTERNS) {
      if (!re.test(line)) continue
      const exempt = EXCEPTIONS.some((e) => e.file === rel && e.line.test(line))
      if (exempt) {
        exempted += 1
        continue
      }
      hits.push(`${rel}:${i + 1}  [${label}]  ${line.trim()}`)
    }
  })
}

if (hits.length) {
  console.error(`✗ 发现 ${hits.length} 处价格/包量字面量（应移入 src/config/pricing.js）：`)
  for (const h of hits) console.error('  ' + h)
  process.exit(1)
}

console.log('✓ 价格字面量静态检查通过（spec §4.3 / AC-19）')
for (const e of EXCEPTIONS) console.log(`  · 行级豁免 ${e.file}（${e.reason}）`)
if (exempted) console.log(`  共豁免 ${exempted} 处命中`)
