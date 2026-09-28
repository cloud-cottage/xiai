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
 *   ④ **包名装载**：`@cloudbase/js-sdk`（与 liwu 前端同款 `^2.25.3`）。
 *
 * ④ 的 specifier 由**运行期拼接**（见 `sdkSpecifier()`）并带 Vite 的 ignore 注释：
 * 目的是让 Vite / Rollup **不做静态解析** —— 本仓库当前**未安装**该依赖，静态解析会让
 * `npm run build` 直接失败（那就把本机 5163 dev 与既有构建弄坏了）。⇒ 缺依赖时的行为是
 * 「装载返回 null ⇒ 数据源记 SDK_UNAVAILABLE ⇒ 回落既有本地实现」，**不是**构建失败。
 *
 * ⚠️ **落仓后的上线选择（Zang 侧二选一，见 report.md §5）**：
 *   · **推荐**：`npm i @cloudbase/js-sdk@^2.25.3`，并把 `sdkSpecifier()` 改成返回字面量
 *     `'@cloudbase/js-sdk'`（一行）⇒ Vite 静态打包该依赖，运行时 ④ 命中；
 *   · 或：把 SDK 的 ESM 产物静态托管，给 `VITE_XIAI_CB_SDK_URL` 赋值，走 ③（**零构建改动**）。
 * 本单**未**改 `package.json`（不在接线面内）。
 */

/** 与 liwu 前端同款的 SDK 包名（**逐字**，唯一一处定义点）。 */
export const CLOUDBASE_SDK_PACKAGE = '@cloudbase/js-sdk'

/** 注入缝（离线测试 / 宿主显式提供）；传非函数 ⇒ 清除注入。 */
let sdkProvider = null

export function setCloudBaseSdkProvider(fn) {
  sdkProvider = typeof fn === 'function' ? fn : null
}

/** 运行期拼接的 specifier（**故意不是字面量** ⇒ 打包器不做静态解析，见文件头）。 */
function sdkSpecifier() {
  return [CLOUDBASE_SDK_PACKAGE.slice(0, 11), CLOUDBASE_SDK_PACKAGE.slice(12)].join('/')
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
  try {
    const specifier = sdkSpecifier()
    return await moduleDefault(await import(/* @vite-ignore */ specifier))
  } catch {
    return null
  }
}
