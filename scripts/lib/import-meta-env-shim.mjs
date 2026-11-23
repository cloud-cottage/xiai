/**
 * 玺爱 · **构建期 `import.meta.env` 假体（ESM loader hook）**
 * ============================================================================
 * **只服务离线自检（`scripts/verify-*.mjs`），不改磁盘上任何 `src/**` 文件。**
 *
 * 为什么要它：`src/data/cloudbase.js::readEnv()` 取的是 `import.meta.env || {}`。
 * 这是 **Vite 构建期静态替换**的值 —— 浏览器产物里它恒存在；**Node 下它恒 `undefined`**
 * ⇒ `cloudBaseConfigured()` 恒 `false` ⇒ `services/personCards.js::fetchIndexState()`
 * 在**发请求之前**就早退 `STORAGE_UNAVAILABLE`，`setCloudFunctionTransport` 注入的
 * `listPersonCards` 回包**根本到不了**（实测：`loadPersonIndex` 返回
 * `{ok:false, reason:'STORAGE_UNAVAILABLE'}`）。于是「作者显示链」的**索引正面**没法离线跑。
 *
 * 本 hook 只做一件事：加载 `src/data/cloudbase.js` 时把那一行
 * `const env = import.meta.env || {}`
 * 换成
 * `const env = (globalThis.__XIAI_TEST_ENV__ || import.meta.env) || {}`
 * —— 即**补上构建期本该有的那份 env**，其余字节逐字不动；`globalThis.__XIAI_TEST_ENV__`
 * 未设置时表达式与原式**完全等价**（回落 `import.meta.env || {}`）。
 *
 * 纪律：
 *   · 只认**这一个文件 + 这一行字面值**；锚点不在（源码改过）⇒ **当场抛错**，
 *     自检直接变红，**绝不静默放行**（宁可红，不假绿）。
 *   · 不 patch 判据、不 patch 被测逻辑、不碰 `cloudBaseConfigured` 本身 ——
 *     门仍在，只是给它**构建期该有的输入**。
 *   · 除本文件外零副作用：其它 URL 一律原样交回 `nextLoad`。
 *
 * 用法（必须在 `import()` 任何 `src/**` 模块**之前**调用 `register()`）：
 *   import { register } from 'node:module'
 *   register(pathToFileURL(path.join(HERE, 'lib/import-meta-env-shim.mjs')).href)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 被补 env 的唯一目标文件（相对 `src/` 的尾缀，避免路径分隔符差异）。 */
const TARGET_SUFFIX = '/src/data/cloudbase.js'

/** 唯一锚点（`cloudbase.js::readEnv()` 的取值行；与源码逐字一致）。 */
const ANCHOR = 'const env = import.meta.env || {}'

/** 替换体（保持原式语义；仅在显式注入测试 env 时改道）。 */
const REPLACEMENT = 'const env = (globalThis.__XIAI_TEST_ENV__ || import.meta.env) || {}'

export async function load(url, context, nextLoad) {
  if (typeof url !== 'string' || !url.endsWith(TARGET_SUFFIX)) return nextLoad(url, context)
  const source = readFileSync(fileURLToPath(url), 'utf8')
  const hits = source.split(ANCHOR).length - 1
  if (hits !== 1) {
    throw new Error(
      `import-meta-env-shim: 锚点在 ${url} 命中 ${hits} 次（期望恰 1）—— cloudbase.js 取值行已改，` +
        '离线自检拒绝静默放行（请人工复核本 hook 是否仍适用）。'
    )
  }
  return { format: 'module', shortCircuit: true, source: source.replace(ANCHOR, REPLACEMENT) }
}
