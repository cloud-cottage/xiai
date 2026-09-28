/**
 * 玺爱 · **CloudBase SDK 装载缝（唯一一处知道「SDK 从哪来」的地方）**
 * ----------------------------------------------------------------------------
 * 为什么单独一个文件：装载来源有**三种**合法形态，且**任何一种都不得新增构建期依赖**
 * （本工程既有纪律「不新增依赖」，见 `data/db.js` 的 R-57 注）。本文件把选择收口到一处，
 * `cloudbase.js` 只调 `loadCloudBaseSdk()`，不知道来源。
 *
 * 装载顺序（逐个 fail-safe，取不到返回 `null`，**绝不抛错**）：
 *   ① **注入缝**：`setCloudBaseSdkProvider(fn)`（离线 mock 测试 / 宿主显式注入用）；
 *   ② **宿主已注入的全局**：`globalThis.cloudbase` / `globalThis.CloudBase`
 *      （宿主脚本先行提供 SDK 时走这条）；
 *   ③ **URL 装载**：`VITE_XIAI_CB_SDK_URL` 指向一个在浏览器里可直接 `import()` 的 ESM 地址
 *      （例如静态托管的 SDK 单文件；**不改本仓库任何构建配置**）；
 *   ④ **包名装载**：`@cloudbase/js-sdk`（与 liwu 前端同款版本线 `^2.25.3`）—— **本单已接线**：
 *     依赖已入 `package.json`、specifier 改为**字面量**（见 `sdkSpecifier()`），
 *     ⇒ Vite / Rollup 静态解析并把该依赖打进产物；**且**装载受构建期开关
 *     `VITE_XIAI_DATA_SOURCE === 'cloudbase'` 保护（未配置 ⇒ 该分支被静态消除 ⇒
 *     产物里**不含** SDK 字节）。
 *
 * 与旧版（未装依赖、specifier 运行期拼接）的差别**只有两处**：
 *   1. specifier 由「运行期拼接」改为「字面量」（依赖已装 ⇒ 静态解析成立）；
 *   2. ④ 前置一道构建期数据源开关（常量比较 ⇒ 死分支可被消除）。
 * 其余装载顺序、fail-safe（取不到 ⇒ `null`、**绝不抛错**）**一字未改**。
 * 未配置 CloudBase 时适配层行为与旧版**逐条等价**（见 report-wiring.md 负对照读数）。
 */

/** 与 liwu 前端同款的 SDK 包名（**逐字**，唯一一处定义点）。 */
export const CLOUDBASE_SDK_PACKAGE = '@cloudbase/js-sdk'

/** 注入缝（离线测试 / 宿主显式提供）；传非函数 ⇒ 清除注入。 */
let sdkProvider = null

export function setCloudBaseSdkProvider(fn) {
  sdkProvider = typeof fn === 'function' ? fn : null
}

/**
 * 运行期 specifier。**上线接线①（本单）：改为返回字面量** `'@cloudbase/js-sdk'` ——
 * 依赖已入 `package.json`（`^2.25.3`）⇒ 让 Vite / Rollup **静态解析**该依赖并把它打进产物。
 * 改因：旧版返回运行期拼接串并带 `@vite-ignore` 忽略注释，是为了在**未装依赖**时不让
 * `npm run build` 因解析不到而失败；依赖既然已装，拼接即失去意义，且会让打包器**跳过**该依赖
 * （⇒ 产物不含 SDK、运行时 ④ 恒失败）。
 */
function sdkSpecifier() {
  return '@cloudbase/js-sdk'
}

/** 构建期变量（**字面量取值** ⇒ Vite 的静态替换认得；Node 下 `import.meta.env` 缺位不报错）。 */
function sdkUrlFromEnv() {
  const raw = import.meta.env?.VITE_XIAI_CB_SDK_URL
  return typeof raw === 'string' ? raw.trim() : ''
}

async function moduleDefault(mod) {
  if (!mod) return null
  if (typeof mod === 'function') return mod
  if (mod.default) return mod.default
  return mod
}

/**
 * 装载 CloudBase SDK。
 * @returns {Promise<object|null>} SDK 对象（含 `init`）；任一来源不可用 ⇒ `null`（**不抛错**）
 */
export async function loadCloudBaseSdk() {
  if (sdkProvider) {
    try {
      return await moduleDefault(await sdkProvider())
    } catch {
      return null
    }
  }
  const injected =
    typeof globalThis !== 'undefined' ? globalThis.cloudbase || globalThis.CloudBase || null : null
  if (injected) return await moduleDefault(injected)
  const url = sdkUrlFromEnv()
  if (url) {
    try {
      return await moduleDefault(await import(/* @vite-ignore */ url))
    } catch {
      /* 落到下一条来源 */
    }
  }
  /**
   * ④ 包名装载（**字面量 specifier ⇒ 静态解析 ⇒ 依赖进产物**）。
   *
   * **构建期开关**：条件写成 `import.meta.env.VITE_XIAI_DATA_SOURCE` 的**直接字面量属性访问**
   * （不是先赋给变量再比较）—— 只有这样 Vite 才会做**静态替换**，未配置时整段（含下面的 `import()`）
   * 折叠成死分支被消除 ⇒ 产物里不含 SDK 字节。写成 `const src = import.meta.env.X` 再比较
   * **不带**静态消除保证（那是运行期读数，见 `cloudbase.js` 的 `readEnv()`，它走的就是运行期口径，保持原样）。
   */
  /* Node / 无 Vite 环境（`import.meta.env` 缺位）⇒ 直接视为未配置，**不碰 ④**：
     `typeof` 取值不抛错 ⇒ 保住本文件「取不到返回 null、绝不抛错」的契约（旧版用 `?.` 达到同样目的）。
     构建期这句会被静态替换 + 常量折叠掉，不影响下面那道开关的静态消除。 */
  if (typeof import.meta.env === 'undefined' || import.meta.env === null) return null
  if (import.meta.env.VITE_XIAI_DATA_SOURCE === 'cloudbase') {
    try {
      /* 主路径：**字面量** package specifier（= `sdkSpecifier()` 的取值，两处必须一致）
         ⇒ Vite / Rollup 静态解析 ⇒ 该依赖被静态打包进产物。 */
      return await moduleDefault(await import('@cloudbase/js-sdk'))
    } catch {
      try {
        /* 后备：若产物里该依赖被 externalize（宿主自行提供 SDK 的场景），
           仍可按包名在**运行期**解析；`@vite-ignore` ⇒ 打包器不解析此变量。 */
        return await moduleDefault(await import(/* @vite-ignore */ sdkSpecifier()))
      } catch {
        return null
      }
    }
  }
  return null
}
