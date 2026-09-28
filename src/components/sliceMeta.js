/**
 * 玺爱 · 切分元数据适配层（**纯函数**；组件侧只读，不碰任何存储）
 * ----------------------------------------------------------------------------
 * 职责：把「影像行 / 照片行」上的**切分元数据**归一成展示层可用的几何描述。
 *
 * 真源＝**单一具名路径**（本模块内**不设候选键 / 不设候选导出名 / 不设回落**）：
 *   ① 容器键名：数据层常量 `SLICE_META_FIELD`（当前 `slice_meta`）—— **一个名字**，无别名表；
 *   ② 容器形状：**逐字冻结** `{directions, ratios, cols, rows, cuts}`（数据层 `sliceMetaOf(imageId, kind)`
 *      的**唯一**产物形状）—— 只读 `directions` / `ratios`，不做多形态探测；
 *   ③ 刀向字面值：`SLICE_DIRECTIONS` 的前两项（`vertical` / `horizontal`）—— 本模块**不写**方向字面量。
 * **张数与切位一律来自元数据**（R-87）：本模块内没有张数 / 切位字面量，也**不派生**第二套。
 *
 * 真源缺位 ⇒ **结构化拒绝**（不回落、不编造、不留过渡形态）：
 *   - `reason: 'TRUTH_UNAVAILABLE'`：数据层常量 `SLICE_META_FIELD` 读不到（模块级已无真源）；
 *   - `reason: 'META_MISSING'`：行上没有该键（真源容器缺位）⇒ 拒绝派生张数 / 切位；
 *   - `reason: 'META_INVALID'`：容器在但刀向 / 切位不可采信（非法字面、比值非有限数、刀向全不可识别）；
 *   - `reason: 'SIZE_UNKNOWN'`：尺寸元数据缺失（宽 / 高 为 0）⇒ 无几何可言。
 * 任一情形返回 `{ok:false, reason, slices:[], ...}`（**不含**任何硬编码张数 / 切位）。
 * 数据层解析：影像行在**落盘 / 读路径**即补 `slice_meta`（`db.js` `withSliceMeta` / `insertImageRow`）
 * ⇒ 展示层永远能读到真源；读不到即「真源坏了」，此时必须显性拒绝而不是让界面继续看起来对。
 *
 * **几何真源＝TileSplicer 内核**（R-98 `src/tilesplicer/`）：本模块**只转调**（`directionOf` /
 * `clampRatio` / `pixelRectsFromCuts` / `seamOf`）——**不再自持**归一边界切分、逐块取整换算或
 * 无缝判据（同一语义只有内核一处实现）。口径（与内核一致）：每刀对**当前每一块**各切一刀
 * ⇒ 相邻块**共用同一个边界数值**，天生**无缝、无叠盖、并集＝整图**（R-87「拼接必须视觉无缝」）。
 *
 * 纪律：本模块**不 import 数据层 db / 服务层**（只吃传进来的行对象 + 真源常量 + 内核纯函数），
 * 也**不出现任何字面色值**（颜色由 `SliceImage.vue` 运行时读主题 token）。
 */

import * as seedLayer from '../data/seed.js'

/**
 * **切割 / 拼接真源＝TileSplicer 内核**（R-98）：本模块只**转调**内核纯函数，
 * **不再持有一份同义实现**（刀向归一 / 比值夹取 / 逐块几何 / 无缝判据）。
 */
import { directionOf, clampRatio, pixelRectsFromCuts, seamOf } from '../tilesplicer/index.js'

/** 切分元数据容器键名（**单一具名真源**：数据层常量 `SLICE_META_FIELD`；无候选、无别名）。 */
export const SLICE_META_FIELD =
  typeof seedLayer.SLICE_META_FIELD === 'string' ? seedLayer.SLICE_META_FIELD.trim() : ''

/** 行上资产类别的**单一具名键**（数据层影像行的 `kind` 列；不做候选键探测）。 */
export const ASSET_CLASS_FIELD = 'kind'

const MAX_CUT_LEVELS = 12 // 级数上限：防元数据异常导致块数爆炸（异常元数据不采信）。

function toInt(value) {
  const num = Number(value)
  return Number.isFinite(num) ? Math.round(num) : 0
}

/** 比值归一：**机械夹到 `[0,1]`**；非有限数 ⇒ `null`（＝不采信 ⇒ 调用方结构化拒绝）。真源＝内核 `clampRatio`。 */
function boundedRatio(value) {
  return clampRatio(value)
}

/** 刀向归一：**只认真源字面值**（大小写无关）；其余一律不可识别（返回空串）。真源＝内核 `directionOf`。 */
function normalizeDirection(value) {
  return directionOf(value)
}

/** 行上的资产类别（元数据 **单一具名键** `kind`）；读不到 ⇒ 空串。 */
export function assetClassOf(row) {
  if (!row || typeof row !== 'object') return ''
  const value = row[ASSET_CLASS_FIELD]
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : ''
}

/** 从行上读出切分元数据容器（**只读真源键名一个**）；无 ⇒ `null`。 */
export function sliceContainerOf(row) {
  if (!row || typeof row !== 'object' || !SLICE_META_FIELD) return null
  const value = row[SLICE_META_FIELD]
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { key: SLICE_META_FIELD, meta: value }
  }
  return null
}

/**
 * 刀向序列 + 切位序列归一：**只认冻结形状** `{directions:string[], ratios:number[]}`。
 * 任一刀向不可识别 / 比值非有限数 ⇒ 返回 `{ok:false}`（调用方**结构化拒绝**，不回落 0.5）。
 * @returns {{ok:boolean, cuts:Array<{direction:string, offsetRatio:number}>}}
 */
function cutsFromMeta(meta) {
  const directions = Array.isArray(meta.directions) ? meta.directions : []
  const ratios = Array.isArray(meta.ratios) ? meta.ratios : []
  if (!directions.length) return { ok: false, cuts: [] }
  const cuts = []
  for (let index = 0; index < Math.min(directions.length, MAX_CUT_LEVELS); index += 1) {
    const normalized = normalizeDirection(directions[index])
    if (!normalized) return { ok: false, cuts: [] }
    const ratio = boundedRatio(ratios[index])
    if (ratio === null) return { ok: false, cuts: [] }
    cuts.push({ direction: normalized, offsetRatio: ratio })
  }
  return { ok: cuts.length > 0, cuts }
}

/**
 * 由刀向 / 切位派生**逐块矩形**（源像素；行主序 `index = row * cols + col`）。
 * 实现真源＝**TileSplicer 内核**（`src/tilesplicer/core.js::pixelRectsFromCuts`）：本函数**只转调**，
 * 不含任何边界切分或取整换算式。边界一律取自内核的**同一份数组** ⇒ 相邻块边缘坐标相接
 * （无白缝、无叠盖、无重复像素）。
 * @returns {Array<{index:number, col:number, row:number, x:number, y:number, width:number, height:number}>}
 */
export function tilesFromCuts(sourceWidth, sourceHeight, cuts) {
  return pixelRectsFromCuts(sourceWidth, sourceHeight, cuts)
}

/** 结构化拒绝（**统一出口**；不含任何硬编码张数 / 切位 / 色值）。 */
function rejected(reason, message, extra = {}) {
  return {
    ok: false,
    reason,
    source: '',
    containerKey: '',
    sliceCount: 0,
    direction: '',
    offsetRatio: [],
    cuts: [],
    slices: [],
    meta: null,
    message,
    ...extra
  }
}

/**
 * 行 → 归一化切分描述（展示层唯一入口）。
 * @param {object} row 影像行 / 照片行（服务层视图模型；**元数据载体**）
 * @param {{sourceWidth?:number, sourceHeight?:number, cutKind?:string}} [options]
 * @returns {{ok:boolean, reason:string, source:'metadata'|'', containerKey:string, sliceCount:number,
 *            direction:string, offsetRatio:number[], cuts:Array<{direction:string, offsetRatio:number}>,
 *            sourceWidth:number, sourceHeight:number, slices:Array<object>, cutKind:string,
 *            meta:object|null, assetClass:string, message:string}}
 */
export function sliceMetaOf(row, options = {}) {
  const assetClass = assetClassOf(row)
  const cutKind = String(options.cutKind || assetClass || '')
  const found = sliceContainerOf(row)
  const meta = found ? found.meta : null
  const sourceWidth = toInt(options.sourceWidth ?? row?.width ?? row?.source_width ?? meta?.sourceWidth)
  const sourceHeight = toInt(options.sourceHeight ?? row?.height ?? row?.source_height ?? meta?.sourceHeight)

  if (!SLICE_META_FIELD) {
    return rejected(
      'TRUTH_UNAVAILABLE',
      '切分元數據真源缺位：數據層常量 SLICE_META_FIELD 讀不到 ⇒ 拒絕解析（既不採別名鍵，也不派生張數 / 切位）',
      { sourceWidth, sourceHeight, cutKind, assetClass }
    )
  }
  if (!found) {
    return rejected(
      'META_MISSING',
      `切分元數據真源缺位：影像行上沒有 ${SLICE_META_FIELD} 鍵（容器未落地）⇒ 拒絕派生張數 / 切位`,
      { sourceWidth, sourceHeight, cutKind, assetClass }
    )
  }
  const parsed = cutsFromMeta(meta)
  if (!parsed.ok) {
    return rejected(
      'META_INVALID',
      `切分元數據不可采信：${SLICE_META_FIELD} 的刀向 / 切位不符凍結形狀（directions / ratios）⇒ 拒絕派生`,
      { sourceWidth, sourceHeight, cutKind, assetClass, meta, containerKey: found.key }
    )
  }

  const cuts = parsed.cuts
  const slices = tilesFromCuts(sourceWidth, sourceHeight, cuts)
  const usable = sourceWidth > 0 && sourceHeight > 0 && slices.length > 0
  if (!usable) {
    return rejected(
      'SIZE_UNKNOWN',
      '切分元數據不可用：影像尺寸元數據缺失（寬 / 高 爲 0）',
      { sourceWidth, sourceHeight, cutKind, assetClass, meta, containerKey: found.key, direction: cuts.map((cut) => cut.direction).join(','), offsetRatio: cuts.map((cut) => cut.offsetRatio), cuts }
    )
  }
  return {
    ok: true,
    reason: '',
    source: 'metadata',
    containerKey: found.key,
    sliceCount: slices.length,
    direction: cuts.map((cut) => cut.direction).join(','),
    offsetRatio: cuts.map((cut) => cut.offsetRatio),
    cuts,
    sourceWidth,
    sourceHeight,
    slices,
    cutKind,
    meta,
    assetClass,
    message: `切分元數據：${slices.length} 塊（行上元數據 ${found.key}）`
  }
}

/**
 * 无缝性机械读数（供展示层自证 / 取证复用，纯函数）。
 * 实现真源＝**TileSplicer 内核**（`src/tilesplicer/core.js::seamOf`）：本函数**只转调**。
 *   - `areaEqualsSource`：块面积之和**恰等于**源图面积（叠盖 / 重复像素会偏大，留缝会偏小）；
 *   - `noOverlap`：两两矩形交集面积之和为 0；
 *   - `edgesAdjacent`：每条内部边界都同时是「某块右/下边缘」与「另一块左/上边缘」（同一坐标）；
 *   - `seamless`：三者皆真。
 * 注：内核（与 `utils/image.js::rectSeamReport` 同源）对**零面积源图**（宽或高 ＝ 0）判
 * `areaEqualsSource: false` ⇒ `seamless: false`；本模块此前对该退化输入判 `true`，
 * 现随内核口径收严（**几何与正常输入读数零变化**，见等价证明）。
 */
export function seamReport(sourceWidth, sourceHeight, slices) {
  return seamOf(slices, sourceWidth, sourceHeight)
}
