#!/usr/bin/env node
/**
 * 玺爱 · 词组表数据资源**等价性自证**（R-PB3；Node 标准库 + 本仓库源码，不联网）。
 *
 * 用法（`<old-dir>` 里放 `8bd5c99` 的三件套：`traditional.js` ＋ 两张词组表 `.js`）：
 *   git show 8bd5c99:src/utils/traditional.js                > <old-dir>/traditional.js
 *   git show 8bd5c99:src/utils/traditional-phrases-s2t.js     > <old-dir>/traditional-phrases-s2t.js
 *   git show 8bd5c99:src/utils/traditional-phrases-t2s.js     > <old-dir>/traditional-phrases-t2s.js
 *   node scripts/verify-phrase-data.mjs <old-dir> [--json out.json]
 * （`<old-dir>` 里若无 `package.json`，先 `printf '{"type":"module"}' > <old-dir>/package.json`
 *   —— 三件套是 ESM 源码，拷出来还没进包时 Node 默认按 CommonJS 解析。）
 *
 * 三项读数（逐项打印 PASS/FAIL，任一 FAIL ⇒ 退出码 1）：
 *   ① **条数一致**：新路径 `phraseTableInfo().entries` ≡ 旧模块 `*_PHRASE_TABLE_META.entries`；
 *   ② **逐字对拍**：本单样例集（策展 24 条）＋ 旧表抽样（每 188 条取 1 ⇒ 261 条）＋
 *      **全表 49,051 键**在「旧路径」与「新路径」的输出**逐字相同**；t2s 方向同做抽样对拍；
 *   ③ **恒等不退化**：已是繁体的文本 `s2t(x) === x`；并做**生成物字节对拍**
 *      （拿旧表重新编码 ⇒ 与仓库里那份 `.txt` **逐字节相同**）＋ **负对照**
 *      （把表内容改 1 个字符 ⇒ 必须抛 `PHRASE_TABLE_INTEGRITY`，不许静默通过）。
 *
 * 新路径的取回用**真 `fetch` 语义**：这里把 `globalThis.fetch` 换成读文件的同义实现
 * （`Response` ＋ `content-length` ＋ 流式 body），⇒ 跑的就是浏览器里那条 `loadPhraseTable()` 代码。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const oldDir = path.resolve(argv.find((a) => !a.startsWith('--')) || '')
const jsonOut = argv.find((a) => a.startsWith('--json='))

const report = { checks: [], readings: {} }
function check(name, pass, detail) {
  report.checks.push({ name, pass: !!pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '  <<< ' + detail}`)
}

/* ---------- 新路径：真 `fetch` 语义（读文件 + content-length + 流式 body） ---------- */
globalThis.fetch = async (url) => {
  const file = url.startsWith('file:') || url.startsWith('/') ? fileURLToPath(url.startsWith('file:') ? url : 'file://' + url) : url
  const buf = readFileSync(file)
  return new Response(buf, { status: 200, headers: { 'content-length': String(buf.length), 'content-type': 'text/plain; charset=utf-8' } })
}

const NEW = await import(path.join(root, 'src/utils/traditional.js'))
const OLD = await import(path.join(oldDir, 'traditional.js'))
const OLD_S2T = await import(path.join(oldDir, 'traditional-phrases-s2t.js'))
const OLD_T2S = await import(path.join(oldDir, 'traditional-phrases-t2s.js'))
const gen = await import(path.join(root, 'scripts/build-phrase-data.mjs'))

/* ---------- ① 条数一致 ---------- */
const events = []
const infoS2T = await NEW.loadPhraseTable('s2t', (p) => events.push(p))
check(
  '① s2t 条数一致（新 info.entries ≡ 旧 META.entries）',
  infoS2T.entries === OLD_S2T.S2T_PHRASE_TABLE_META.entries,
  `${infoS2T.entries} vs ${OLD_S2T.S2T_PHRASE_TABLE_META.entries}`
)
check('① s2t 两块条数自洽（auto + rest ≡ entries）', infoS2T.autoEntries + infoS2T.restEntries === infoS2T.entries, JSON.stringify(infoS2T))
const infoT2S = await NEW.loadPhraseTable('t2s', () => {})
check(
  '① t2s 条数一致',
  infoT2S.entries === OLD_T2S.T2S_PHRASE_TABLE_META.entries,
  `${infoT2S.entries} vs ${OLD_T2S.T2S_PHRASE_TABLE_META.entries}`
)
report.readings.tableInfo = { s2t: infoS2T, t2s: infoT2S }

/* 进度事件的形状（真 percent：首个 0、末个 1、单调不减、total ≡ 资源字节） */
const dl = events.filter((e) => e.phase === 'download')
const ratios = dl.map((e) => e.ratio)
const bytes = readFileSync(path.join(root, 'src/utils/traditional-phrases-s2t.txt')).length
check('① 进度事件含 download 相位且首个 ratio ≡ 0', dl.length > 0 && ratios[0] === 0, `${dl.length} 事件，首 ${ratios[0]}`)
check(
  '① 进度事件 ratio 单调不减且末个 ≡ 1',
  ratios.every((r, i) => i === 0 || r >= ratios[i - 1]) && ratios[ratios.length - 1] === 1,
  JSON.stringify(ratios.slice(-3))
)
check('① total ≡ 资源字节数（Content-Length 真读数）', dl.every((e) => e.total === bytes), `total=${dl[0] && dl[0].total} bytes=${bytes}`)
report.readings.progressEvents = { count: dl.length, ratios: ratios.slice(0, 6).concat(['…'], ratios.slice(-2)), total: dl[0] && dl[0].total }

/* ---------- ② 逐字对拍 ---------- */
const oldLines = OLD_S2T.S2T_PHRASE_TABLE.split('\n').filter(Boolean)
const curated = [
  '干净', '干净利落', '二噁英', '龙须沟', '龟鉴', '干支', '面条', '后台', '什么', '这里',
  '里面', '头发', '发展', '后来', '千里', '钟表', '关于', '作为', '才干', '丰富',
  '印文释義', '印面', '篆刻', '藏品介绍', '印章尺寸'
]
const strideSample = []
for (let i = 0; i < oldLines.length; i += 188) strideSample.push(oldLines[i].slice(0, oldLines[i].indexOf('\t')))
const allKeys = oldLines.map((l) => l.slice(0, l.indexOf('\t')))

async function pairDiff(keys) {
  let diff = 0
  const first = []
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500)
    const [a, b] = await Promise.all([
      Promise.all(chunk.map((k) => OLD.toTraditionalFull(k))),
      Promise.all(chunk.map((k) => NEW.toTraditionalFull(k)))
    ])
    for (let j = 0; j < chunk.length; j += 1) {
      if (a[j] !== b[j]) {
        diff += 1
        if (first.length < 5) first.push({ key: chunk[j], old: a[j], new: b[j] })
      }
    }
  }
  return { count: keys.length, diff, first }
}

const curatedDiff = await pairDiff(curated)
const strideDiff = await pairDiff(strideSample)
const fullDiff = await pairDiff(allKeys)
check('② 策展样例集（24 条）新旧逐字相同', curatedDiff.diff === 0, JSON.stringify(curatedDiff.first))
check(`② 旧表抽样（${strideSample.length} 条）新旧逐字相同`, strideDiff.diff === 0, JSON.stringify(strideDiff.first))
check(`② 全表（${allKeys.length} 键）新旧逐字相同`, fullDiff.diff === 0, JSON.stringify(fullDiff.first))
report.readings.pairDiff = { curated: curatedDiff, stride: { count: strideDiff.count, diff: strideDiff.diff }, full: { count: fullDiff.count, diff: fullDiff.diff } }

/* t2s 方向：抽 60 条 t2s 键（含策展）对拍 */
const t2sKeys = OLD_T2S.T2S_PHRASE_TABLE.split('\n').filter(Boolean).map((l) => l.slice(0, l.indexOf('\t')))
const t2sSample = t2sKeys.filter((_, i) => i % 5 === 0).slice(0, 60)
let t2sDiff = 0
for (const k of t2sSample) {
  const [a, b] = [await OLD.toSimplifiedFull(k), await NEW.toSimplifiedFull(k)]
  if (a !== b) t2sDiff += 1
}
check(`② t2s 抽样（${t2sSample.length} 条）新旧逐字相同`, t2sDiff === 0, `diff=${t2sDiff}`)
report.readings.pairDiff.t2s = { count: t2sSample.length, diff: t2sDiff }

/* ---------- ③ 恒等不退化 ＋ 生成物字节对拍 ＋ 负对照 ---------- */
const traditionalSeed = [
  '轉換只處理可自動定形的字；少數多義字需自行核對。',
  '將「印文釋義」的內容轉爲繁體（建議使用繁體字提交）；已是繁體時不變。',
  '乾淨', '龍鬚溝', '龜鑑', '印章尺寸與印面影像', '篆刻知識分享平臺',
  '後臺', '裡面', '頭髮', '關於', '作爲', '千裏', '鍾錶'
]
let identityDiff = 0
const identityBad = []
for (const s of traditionalSeed) {
  const o = await OLD.toTraditionalFull(s)
  const n = await NEW.toTraditionalFull(s)
  if (n !== s || o !== n) {
    identityDiff += 1
    identityBad.push({ s, old: o, new: n })
  }
}
check(`③ 已是繁体的文本 s2t(x) === x（${traditionalSeed.length} 条，且新旧一致）`, identityDiff === 0, JSON.stringify(identityBad))

const genS2T = gen.encodePhraseTable(OLD_S2T.S2T_PHRASE_TABLE, (k) => NEW.toTraditionalText(k))
const shipped = readFileSync(path.join(root, 'src/utils/traditional-phrases-s2t.txt'), 'utf8')
const genT2S = gen.encodePhraseTable(OLD_T2S.T2S_PHRASE_TABLE, null)
const shippedT2S = readFileSync(path.join(root, 'src/utils/traditional-phrases-t2s.txt'), 'utf8')
check('③ 生成物字节对拍：旧表重新编码 ≡ 仓库里的 s2t 数据资源', genS2T.text === shipped, `${genS2T.text.length} vs ${shipped.length}`)
check('③ 生成物字节对拍：旧表重新编码 ≡ 仓库里的 t2s 数据资源', genT2S.text === shippedT2S, `${genT2S.text.length} vs ${shippedT2S.length}`)
check('③ 新旧摘要实现一致（生成器 ≡ 运行期）', gen.phraseTableDigest(shipped) === NEW.phraseTableDigest(shipped), '')

/* 负对照：改 1 个字符的副本 ⇒ 必须显式抛 PHRASE_TABLE_INTEGRITY（不许静默通过） */
const corrupt = shipped.replace('㓦划', '㓦劃')
const realFetch = globalThis.fetch
globalThis.fetch = async () =>
  new Response(Buffer.from(corrupt, 'utf8'), { status: 200, headers: { 'content-length': String(Buffer.byteLength(corrupt)) } })
const fresh = await import(path.join(root, 'src/utils/traditional.js') + '?neg=' + Date.now())
let negCode = null
try {
  await fresh.loadPhraseTable('s2t', () => {})
} catch (err) {
  negCode = err && err.code
}
check('③ 负对照：内容被改 1 字符 ⇒ 抛 PHRASE_TABLE_INTEGRITY（不静默）', negCode === 'PHRASE_TABLE_INTEGRITY', String(negCode))

/* 负对照 2：取表失败（INTEGRITY）时 `toTraditionalFull` 的**契约回落**仍在：不抛错、回落逐字层 */
const fellBack = await fresh.toTraditionalFull('干净')
check('③ 回落实测：取表失败时 toTraditionalFull 不抛错并回落逐字层（干净 ⇒ 干淨）', fellBack === '干淨', fellBack)
globalThis.fetch = realFetch

report.all_ok = report.checks.every((c) => c.pass)
if (jsonOut) writeFileSync(jsonOut.split('=')[1], JSON.stringify(report, null, 2))
console.log(`\nall_ok=${report.all_ok}  checks=${report.checks.length}`)
process.exit(report.all_ok ? 0 : 1)
