/**
 * 玺爱 · **离线自检专用**：给 `src/services/displayImage.js` 的构建期 env 读数加注入缝
 * ==============================================================================
 * **只服务离线自检（`scripts/verify-image-api-fallback.mjs`），不改磁盘上任何 `src/**` 文件。**
 *
 * 为什么需要它：`displayApiCandidates()` 取的是 `import.meta.env.VITE_XIAI_API_BASE` /
 * `import.meta.env.PROD` —— 这是 **Vite 构建期静态替换**的值：浏览器产物里它恒存在；
 * **Node 下 `import.meta.env` 恒 `undefined`** ⇒ 离线自检只能看到 dev 那一档，
 * 「生产两档顺序」「env 覆盖单档」这两条判据**根本跑不到**。
 *
 * 本 hook 只做一件事：加载 `src/services/displayImage.js` 时把源码里的
 * `import.meta.env` 换成 `(globalThis.__XIAI_TEST_ENV__ || import.meta.env)`
 * —— 即**补上构建期该有的那份 env**；`globalThis.__XIAI_TEST_ENV__` 未设置时表达式与原式
 * **完全等价**（回落 `import.meta.env`），其余字节逐字不动（注释里的同名串一并换、无运行时影响）。
 *
 * 纪律：
 *   · 只认**这一个文件**；锚点（`import.meta.env` 字面）不在 ⇒ **当场抛错**，
 *     自检直接变红，**绝不静默放行**（宁可红，不假绿）。
 *   · 不 patch 判据、不 patch 被测逻辑、不为测试在 `src/**` 开第二套写口。
 *   · 除本文件外零副作用：其它 URL 一律原样交回 `nextLoad`。
 *
 * 用法（必须在 `import()` 任何 `src/**` 模块**之前**调用 `register()`）：
 *   import { register } from 'node:module'
 *   register(pathToFileURL(path.join(HERE, 'lib/display-env-shim.mjs')).href)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 被补 env 的唯一目标文件（相对仓库根的尾缀，避免路径分隔符差异）。 */
const TARGET_SUFFIX = '/src/services/displayImage.js'

/** 唯一锚点（`displayImage.js` 取构建期 env 的字面；与源码逐字一致）。 */
const ANCHOR = 'import.meta.env'

/** 替换体（保持原式语义；仅在显式注入测试 env 时改道）。 */
const REPLACEMENT = '(globalThis.__XIAI_TEST_ENV__ || import.meta.env)'

export async function load(url, context, nextLoad) {
  if (typeof url !== 'string' || !url.endsWith(TARGET_SUFFIX)) return nextLoad(url, context)
  const source = readFileSync(fileURLToPath(url), 'utf8')
  const hits = source.split(ANCHOR).length - 1
  if (hits < 1) {
    throw new Error(
      `display-env-shim: 锚点 \`${ANCHOR}\` 在 ${url} 命中 0 次 —— ` +
        'displayImage.js 取 env 的写法已改，离线自检拒绝静默放行（请人工复核本 hook 是否仍适用）。'
    )
  }
  return {
    format: 'module',
    shortCircuit: true,
    source: source.split(ANCHOR).join(REPLACEMENT)
  }
}
