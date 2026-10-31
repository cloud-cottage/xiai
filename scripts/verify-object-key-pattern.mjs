/**
 * 玺爱 · **自检：客户端影像对象键形态（`IMAGE_OBJECT_KEY_PATTERN`）**
 * ============================================================================
 * 被测件：`src/data/cloudbase.js::IMAGE_OBJECT_KEY_PATTERN` —— 影像展示件对象键的
 * **读面单点**（`cloudBaseObjectKeyOf` 按其捕获组核对行内 `sha256`）。本单扩面（§3.68
 * AI 产物容器族）：扩展名分支 `(png|webp)` → `(png|webp|jpg|jpeg)` —— **jpg 为 §3.68 AI
 * 产物引入**（浏览器原生解码，不经服务端转码；服务端 `PRODUCT_MIME_EXT` 的 jpeg 映射同单）。
 *
 * 判据（**模块真导入**，不是正则抄写；零网络、零 dev server、零写入）：
 *   A 段 接受面：`.png` / `.webp` / `.jpg` / `.jpeg` 四族**逐一命中**，且捕获组逐字 ＝
 *     （sha 前两位、64 位 sha、扩展名）；
 *   B 段 拒绝面：`.tiff`（源件不走展示件键面）/ `.gif`（非产物族）/ **无扩展名**（裸 sha 键）
 *     一律**零命中** ＋ 正对照（合法 `.jpg` 键必命中 —— 证明「零命中」不是恒真）。
 * 纪律：断言失败 ⇒ 退出码非 0。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
  断言 / 读数（与既有 verify-*.mjs 同形）
  --------------------------------------------------------------------------- */
const results = []
let failures = 0

function check(id, label, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (!pass) failures += 1
  results.push({ id, label, pass, expected, actual })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}

/* 被测件：真模块导入（`vue` 的 shallowRef / storage / seed 等既有依赖在 Node 下可直接解析 ——
   与 verify-ai-connect-page 导入服务层同一张尺；模块顶层零网络、零 localStorage 硬依赖）。 */
const cloudbase = await import(pathToFileURL(path.join(ROOT, 'src/data/cloudbase.js')).href)
const PATTERN = cloudbase.IMAGE_OBJECT_KEY_PATTERN

/* 一枚合法的 64 位小写十六进制摘要（键形态判据只看形态；内容寻址核对由调用方负责）。 */
const SHA = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
const PREFIX = SHA.slice(0, 2)
const keyOf = (ext) => `xiai/images/${PREFIX}/${SHA}${ext}`

/* ===========================================================================
  A 段：接受面 —— .png / .webp / .jpg / .jpeg 四族逐一命中且捕获组逐字
  =========================================================================== */
console.log(JSON.stringify({ section: 'A', title: '接受面：.png / .webp / .jpg / .jpeg 四族逐一命中且捕获组逐字（前两位 / 64 位 sha / 扩展名）' }))
for (const ext of ['png', 'webp', 'jpg', 'jpeg']) {
  const matched = PATTERN.exec(keyOf(`.${ext}`))
  check(
    `A-${ext}`,
    `\`.${ext}\` 展示件键**接受**：命中且捕获组逐字 ＝（${PREFIX}、64 位 sha、${ext}）`,
    [PREFIX, SHA, ext],
    matched ? [matched[1], matched[2], matched[3]] : null
  )
}

/* ===========================================================================
  B 段：拒绝面 —— .tiff / .gif / 无扩展名 一律零命中（＋ 正对照）
  =========================================================================== */
console.log(JSON.stringify({ section: 'B', title: '拒绝面：.tiff 源件 / .gif 非产物族 / 无扩展名裸键 ⇒ 零命中（正对照证明探测器有效）' }))
{
  const REJECT_EXTS = ['.tiff', '.gif', '']
  const accepted = REJECT_EXTS.filter((ext) => PATTERN.test(keyOf(ext)))
  check('B1', '拒绝面：`.tiff`（源件）/ `.gif`（非产物族）/ **无扩展名**（裸 sha 键）一律**不命中**', [], accepted)
  check('B1b', '正对照：同一探测器对合法 `.jpg` 键**必命中**（拒绝面「零命中」不是恒真）', true, PATTERN.test(keyOf('.jpg')))
}

/* ---------------------------------------------------------------------------
  收尾
  --------------------------------------------------------------------------- */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id),
    pattern: String(PATTERN),
    note: '离线自检：真导入 src/data/cloudbase.js 的导出常量；零网络、零写入、零 dev server。'
  })
)
process.exit(failures === 0 ? 0 : 1)
