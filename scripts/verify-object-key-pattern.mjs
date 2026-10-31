/**
 * 玺爱 · **自检：客户端影像对象键形态（`IMAGE_OBJECT_KEY_PATTERN`）＋ 三处一致性守卫**
 * ============================================================================
 * 被测件：`src/data/cloudbase.js::IMAGE_OBJECT_KEY_PATTERN` —— 影像展示件对象键的
 * **读面单点**（`cloudBaseObjectKeyOf` 按其捕获组核对行内 `sha256`）；同单被测件还有
 * `IMAGE_EXT_MIME`（扩展名 ↔ mime 一致性校验表）与 `cloudBaseObjectKeyOf`（行 → 展示键）。
 * §3.68 扩面（AI 产物容器族）：扩展名分支 `(png|webp)` → `(png|webp|jpg|jpeg)` —— **jpg 为
 * §3.68 AI 产物引入**（浏览器原生解码，不经服务端转码；服务端 `PRODUCT_MIME_EXT` 的 jpeg
 * 映射同单）。
 *
 * 判据（**模块真导入**，不是正则抄写；零网络、零 dev server、零写入）：
 *   A 段 接受面：`.png` / `.webp` / `.jpg` / `.jpeg` 四族**逐一命中**，且捕获组逐字 ＝
 *     （sha 前两位、64 位 sha、扩展名）；
 *   B 段 拒绝面：`.tiff`（源件不走展示件键面）/ `.gif`（非产物族）/ **无扩展名**（裸 sha 键）
 *     一律**零命中** ＋ 正对照（合法 `.jpg` 键必命中 —— 证明「零命中」不是恒真）。
 *   C 段 **三处一致性守卫**（系统性防回退，比单例断言重要）：① 四扩展名逐一 —— PATTERN 命中
 *     ＋ `IMAGE_EXT_MIME[ext]` 有值 ＋ 构造合法行（`storage=server`、`sha256` ≡ 键内摘要、
 *     `storage_key` 用该扩展名、`mime` 取 `IMAGE_EXT_MIME[ext]`）调 `cloudBaseObjectKeyOf`
 *     **拿回原键**（另有 C1b：mime 取**独立字面参照**的生产行形态，防「表值自指比对」）；② 负对照 —— 同一行只把 mime 改成不匹配值（如 `.jpg` 配 `image/png`）
 *     ⇒ 必须回**空串**；③ 静态守卫 —— `IMAGE_EXT_MIME` 键集合与 PATTERN 扩展名分支允许
 *     集合**相等**（双向 ⊆ ＋ 相等，防今后任一侧单边扩展）。
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
const IMAGE_EXT_MIME = cloudbase.IMAGE_EXT_MIME
const objectKeyOf = cloudbase.cloudBaseObjectKeyOf

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

/* ===========================================================================
  C 段：**三处一致性守卫**（系统性防回退 —— 本段比单例断言重要）
  ------------------------------------------------------------------------
  背景（§3.68 实测事故）：`cloudBaseObjectKeyOf` 的一致性校验是
  `if (declared && IMAGE_EXT_MIME[matched[3]] !== declared) return ''`
  ⇒ 扩展名分支（`IMAGE_OBJECT_KEY_PATTERN`）与 `IMAGE_EXT_MIME` 必须**成对**演进。
  当时 PATTERN 已扩 `(png|webp|jpg|jpeg)` 而 `IMAGE_EXT_MIME` 只有 png/webp ⇒
  `.jpg` 合法行（storage=server、sha 与键内摘要一致、mime=image/jpeg）被校验判空串
  ⇒ 读面拿不到对象键 ⇒ 页面「影像暫時無法顯示」，而**数据行完全正确**。
  ⇒ 本段把「三处一致」钉成机械判据：任一侧单边扩展必红。
  ① 正面对：四种扩展名逐一 —— PATTERN 命中 ＋ `IMAGE_EXT_MIME[ext]` 有值 ＋ 构造的合法行
     （storage=server、sha256 ≡ 键内摘要、storage_key 用该扩展名、mime 取 `IMAGE_EXT_MIME[ext]`）
     调 `cloudBaseObjectKeyOf` **拿回原键**；
  ② 负对照：同一行只把 mime 故意改成不匹配值（`.png` 配 `image/webp`、其余配 `image/png`）
     ⇒ `cloudBaseObjectKeyOf` 必须回**空串**（证明 ① 不是恒真）；
  ③ 静态守卫：从 PATTERN 源码抽出末位扩展名分支集合，与 `IMAGE_EXT_MIME` 键集合
     **双向 ⊆ 且相等**（防今后再单边扩展）。
  =========================================================================== */
console.log(JSON.stringify({ section: 'C', title: '三处一致性守卫：PATTERN 命中 ＋ IMAGE_EXT_MIME 有值 ＋ cloudBaseObjectKeyOf 拿回原键（＋mime 不匹配负对照 ＋ 两集合相等静态门）' }))
{
  const EXTS = ['png', 'webp', 'jpg', 'jpeg']

  /* ① 正面对：逐扩展名三联断言（PATTERN 命中 / 表有值 / 函数拿回原键）。 */
  for (const ext of EXTS) {
    const key = keyOf(`.${ext}`)
    const mime = IMAGE_EXT_MIME[ext]
    check(`C1-${ext}-pattern`, `\`.${ext}\`：\`IMAGE_OBJECT_KEY_PATTERN\` 命中（三处之一）`, true, PATTERN.test(key))
    check(`C1-${ext}-mime`, `\`.${ext}\`：\`IMAGE_EXT_MIME['${ext}']\` 有值（三处之二）`, 'string', typeof mime)
    check(
      `C1-${ext}-keyof`,
      `\`.${ext}\`：合法行（storage=server、sha256 ≡ 键内摘要、storage_key 用 .${ext}、mime=${mime}）调 \`cloudBaseObjectKeyOf\` 拿回原键（三处之三）`,
      key,
      objectKeyOf({ storage: 'server', sha256: SHA, storage_key: key, mime })
    )
  }

  /* ① b 生产行形态（**独立字面参照**，不从 IMAGE_EXT_MIME 取 —— 否则是自指比对）：
     生产库里 `.jpg` 展示件行的 `mime` 逐字是 `image/jpeg`（§3.68 AI 产物引入时的行形态）。
     修前事故正是一张这样的行被判空串 ⇒ 本条把该形态钉死：表值与字面参照必须一致。 */
  const PRODUCTION_MIME = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' }
  for (const ext of EXTS) {
    const key = keyOf(`.${ext}`)
    check(
      `C1b-${ext}-prodrow`,
      `\`.${ext}\` 生产行形态（mime 逐字 '${PRODUCTION_MIME[ext]}'，独立字面参照）⇒ \`cloudBaseObjectKeyOf\` 拿回原键`,
      key,
      objectKeyOf({ storage: 'server', sha256: SHA, storage_key: key, mime: PRODUCTION_MIME[ext] })
    )
  }

  /* ② 负对照：同一行只把 mime 改成不匹配值 ⇒ 必须回空串（校验器真的在判，不是恒放行）。 */
  for (const ext of EXTS) {
    const key = keyOf(`.${ext}`)
    const wrongMime = ext === 'png' ? 'image/webp' : 'image/png'
    check(
      `C2-${ext}-mismatch`,
      `\`.${ext}\` 行只把 mime 改成不匹配值 '${wrongMime}' ⇒ \`cloudBaseObjectKeyOf\` 回空串`,
      '',
      objectKeyOf({ storage: 'server', sha256: SHA, storage_key: key, mime: wrongMime })
    )
  }

  /* ③ 静态守卫：两集合相等（双向 ⊆ ＋ 相等；防任一侧单边扩展）。 */
  const branchMatched = /\\\.\(([^)]+)\)\$\//.exec(String(PATTERN))
  check('C3a', '从 `IMAGE_OBJECT_KEY_PATTERN` 源码抽出末位扩展名分支（形如 `\\.(a|b|…)$`）', true, Boolean(branchMatched))
  const BRANCH_EXTS = branchMatched ? branchMatched[1].split('|') : []
  const MIME_EXTS = Object.keys(IMAGE_EXT_MIME)
  check('C3b', '`IMAGE_EXT_MIME` 键集合 ⊆ PATTERN 分支允许集合（无单边 mime 键）', [], MIME_EXTS.filter((ext) => BRANCH_EXTS.indexOf(ext) === -1))
  check('C3c', 'PATTERN 分支允许集合 ⊆ `IMAGE_EXT_MIME` 键集合（无单边扩展名 —— 漏改本侧即 §3.68 事故形态）', [], BRANCH_EXTS.filter((ext) => MIME_EXTS.indexOf(ext) === -1))
  check('C3d', '两边集合**相等**（排序后逐字；排除「各多各的」形态）', [...BRANCH_EXTS].sort(), [...MIME_EXTS].sort())
  check('C3e', '四族 png / webp / jpg / jpeg 恰同时在两边集合内', EXTS, EXTS.filter((ext) => BRANCH_EXTS.indexOf(ext) !== -1 && MIME_EXTS.indexOf(ext) !== -1))
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
    ext_mime: IMAGE_EXT_MIME,
    note: '离线自检：真导入 src/data/cloudbase.js 的导出常量与 cloudBaseObjectKeyOf；零网络、零写入、零 dev server。C 段＝三处一致性守卫（PATTERN / IMAGE_EXT_MIME / cloudBaseObjectKeyOf 成对演进，防单边扩展）。'
  })
)
process.exit(failures === 0 ? 0 : 1)
