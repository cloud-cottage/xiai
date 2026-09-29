#!/usr/bin/env node
/**
 * 玺爱 · 词组表**可取回数据资源**生成器（R-PB2；运行期零依赖，只用 Node 标准库）。
 *
 * 为什么有这一层：`import()` **取不到下载进度**（没有该 API）⇒ 词组表从「JS 模块」改成
 * 「可 `fetch` 的数据资源」，浏览器才能用 `response.body` 的流式读取算**真实百分比**。
 * 本脚本把 OpenCC 词组表（`键\t值` 逐行）**无损地**压成三种成分：
 *   ① `#AUTO` 块：值**恰等于**逐字表结果（`toTraditionalText(key)`）的条目 ⇒ 只存**键**，
 *      值在运行期由逐字表**重算**（逐字表本来就在主包，不新增任何字节）；
 *   ② `#REST` 块：其余条目，按键排序后**相对上一行键做公共前缀压缩**（行首 1 字节 ＝
 *      公共前缀长度 `a`＋n，其后是后缀）；
 *   ③ 头部 1 行：条数 / 两块条数 / 前 16 字键摘要 `digest`（FNV-1a 32 位，运行期复算对拍）。
 * 无损性：运行期把两块还原成完整 `键\t值` 行集合后做 digest 对拍 ⇒ **要么逐字还原，
 * 要么显式失败**（不会静默给出半张表）。同一份还原逻辑由 `scripts/verify-phrase-data.mjs`
 * 对**旧 JS 模块**逐条对拍（条数 ＋ 全表键值 ＋ 生成物字节）。
 *
 * 用法（源既可以是旧 JS 模块，也可以是纯 `键\t值` 文本）：
 *   node scripts/build-phrase-data.mjs <src.js|src.txt> --kind=s2t [--out=<path>]
 * 例（重建旧 JS 模块作为源，模块本身已被数据资源取代）：
 *   git show 8bd5c99:src/utils/traditional-phrases-s2t.js > /tmp/s2t.src.js
 *   node scripts/build-phrase-data.mjs /tmp/s2t.src.js --kind=s2t
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))

/** FNV-1a 32 位（与 `src/utils/traditional.js` 内 `phraseTableDigest()` 实现**逐字相同**）。 */
export function phraseTableDigest(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 从 JS 模块源码里取出模板字符串（声明行到独占一行的收尾反引号）；不是 JS ⇒ 原样返回。 */
function extractTable(src) {
  const lines = String(src).split('\n')
  const at = lines.findIndex((l) => /=\s*`\\?\s*$/.test(l))
  if (at === -1) return src
  const out = []
  for (let i = at + 1; i < lines.length; i += 1) {
    if (lines[i] === '`') return out.join('\n') + '\n'
    out.push(lines[i])
  }
  throw new Error('UNTERMINATED_TEMPLATE')
}

export function encodePhraseTable(rawTable, glyphConvert) {
  const lines = String(rawTable).split('\n').filter((line) => line.length > 0)
  const auto = []
  const rest = []
  for (const line of lines) {
    const tab = line.indexOf('\t')
    if (tab <= 0) throw new Error('MALFORMED_LINE: ' + JSON.stringify(line.slice(0, 40)))
    const key = line.slice(0, tab)
    const value = line.slice(tab + 1)
    if (value.indexOf('\t') !== -1) throw new Error('TAB_IN_VALUE')
    if (glyphConvert && glyphConvert(key) === value) auto.push(key)
    else rest.push({ key, value })
  }
  const keys = new Set(lines.map((l) => l.slice(0, l.indexOf('\t'))))
  if (keys.size !== lines.length) throw new Error('DUPLICATE_KEYS')
  rest.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  let body = ''
  let prev = ''
  let maxKey = 0
  for (const { key, value } of rest) {
    let n = 0
    while (n < key.length && n < prev.length && key[n] === prev[n]) n += 1
    if (n > 25) throw new Error('PREFIX_TOO_LONG: ' + n)
    body += String.fromCharCode(97 + n) + key.slice(n) + '\t' + value + '\n'
    prev = key
    maxKey = Math.max(maxKey, key.length)
  }
  const digest = phraseTableDigest(
    auto.map((k) => k + '\t' + glyphConvert(k) + '\n').join('') + rest.map((r) => r.key + '\t' + r.value + '\n').join('')
  )
  const header =
    '#PHRASE-TABLE v1 entries=' + lines.length + ' auto=' + auto.length + ' rest=' + rest.length +
    ' maxkey=' + maxKey + ' digest=' + digest + '\n'
  return {
    text: header + '#AUTO\n' + (auto.length ? auto.join('\n') + '\n' : '') + '#REST\n' + body,
    entries: lines.length,
    autoEntries: auto.length,
    restEntries: rest.length,
    digest,
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const src = args.find((a) => !a.startsWith('--'))
  const kindArg = (args.find((a) => a.startsWith('--kind=')) || '--kind=s2t').split('=')[1]
  const outArg = args.find((a) => a.startsWith('--out='))
  if (!src) {
    console.error('用法: node scripts/build-phrase-data.mjs <src.js|src.txt> --kind=s2t|t2s [--out=<path>]')
    process.exit(2)
  }
  const kind = kindArg === 't2s' ? 't2s' : 's2t'
  const mod = await import(path.join(root, 'src/utils/traditional.js'))
  // 逐字重算口径：s2t 用逐字表（`toTraditionalText`）；t2s 不做 AUTO 推导（表仅 5 KB）。
  const glyphConvert = kind === 's2t' ? (k) => mod.toTraditionalText(k) : null
  const enc = encodePhraseTable(extractTable(readFileSync(src, 'utf8')), glyphConvert)
  const out = outArg ? outArg.split('=')[1] : path.join(root, 'src/utils/traditional-phrases-' + kind + '.txt')
  writeFileSync(out, enc.text)
  const gz = (await import('node:zlib')).gzipSync(Buffer.from(enc.text, 'utf8'), { level: 9 }).length
  console.log(
    JSON.stringify(
      { out, kind, entries: enc.entries, auto: enc.autoEntries, rest: enc.restEntries, digest: enc.digest, rawBytes: Buffer.byteLength(enc.text), gzipBytes: gz },
      null,
      2
    )
  )
}
