/**
 * 玺爱 · **本地写入口的降级形态**（写面 Phase 1 新增｜机制 + 清单式标注）
 * ----------------------------------------------------------------------------
 * 口径（Kevin 已定，逐字落成机制）：
 *   「**本地写入口保留但降级为 dev / 离线形态（生产下禁用或明确标注）**」
 *
 * 本文件只做**机制**，不做写路径搬迁（搬迁属 Phase 2）：
 *   ① **一个可测的开关** `writeFaceMode()`：`'cloud'`（有云写入面 ⇒ 本地写入口为 dev / 离线形态）
 *      / `'local-dev'`（无云写入面 ⇒ 本地写入口就是当下唯一形态，**但明确标注为「非正式写入路径」**）；
 *   ② **一个可测的门** `localWriteDenial()` / `assertLocalWriteAllowed()`：云端模式下对
 *      「未迁移的本地写入口」返回**结构化拒绝**（沿用既有冻结字面值 `FORBIDDEN`，**不新增 reason**）；
 *   ③ **一份清单式标注** `localWriteRegistry()`：**8 个裸 `save*Rows`（无任何权限门）**
 *      ＋ **6 个 `drive.js` 裸写入口** ＋ **10 个管理员写入口**，逐条带 `文件:行号` 与迁移状态。
 *
 * 明文边界（不得据本文件判任何条通过）：
 *   · 本文件的 `assertLocalWriteAllowed()` **在 Phase 1 尚未接进那 8 个裸写入口**（W-36 / W-43 未裁 ⇒
 *     写路径全量搬迁未启动）；本单只交付**机制 + 清单**与**一个已完成校验的垂直切片**。
 *   · 清单里的 `文件:行号` 是**只读实测读数**（基准 `f906467`），不是规范口径。
 */

import { cloudBaseConfigured } from './cloudbase.js'

/** 写入口形态（封闭两值）。 */
export const WRITE_FACE_MODES = Object.freeze({
  /** 已有云写入面 ⇒ 本地写入口＝**dev / 离线形态**（生产下禁用）。 */
  CLOUD: 'cloud',
  /** 无云写入面 ⇒ 本地写入口即当下形态，**明确标注「非正式写入路径」**。 */
  LOCAL_DEV: 'local-dev'
})

/** 迁移状态（Phase 1 只有「已过云端校验的那一个」是 `migrated`）。 */
export const WRITE_FACE_ENTRY_STATUS = Object.freeze({
  UNMIGRATED: 'phase1-unmigrated',
  MIGRATED: 'phase1-migrated'
})

/** 分组（清单按此三组组织）。 */
export const WRITE_FACE_GROUPS = Object.freeze({
  RAW_PERSIST: 'raw-persist',
  DRIVE_RAW: 'drive-raw',
  ADMIN_ENTRY: 'admin-entry'
})

/** 形态覆盖（注入缝取值；`null` ＝ 未覆盖）。 */
let modeOverride = null

/** 显式覆盖（`VITE_XIAI_WRITE_FACE=local-dev` ⇒ 强制 dev / 离线形态；仅供本地开发）。 */
function forcedMode() {
  if (modeOverride) return modeOverride
  const raw = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_XIAI_WRITE_FACE : ''
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value === WRITE_FACE_MODES.LOCAL_DEV || value === WRITE_FACE_MODES.CLOUD ? value : ''
}

/**
 * **注入缝**（离线自检 / 宿主显式指定形态；沿用 `cloudbaseSdk.js::setCloudBaseSdkProvider` 同族做法）。
 * 传非 `'cloud'` / `'local-dev'` ⇒ 清除覆盖，回到「按是否配置云写入面自动判定」。
 * @param {'cloud'|'local-dev'|null} mode
 */
export function setWriteFaceModeOverride(mode) {
  modeOverride = mode === WRITE_FACE_MODES.CLOUD || mode === WRITE_FACE_MODES.LOCAL_DEV ? mode : null
  return writeFaceMode()
}

/**
 * 当前写入口形态（**唯一判据来源**；页面 / 服务**不得**各自判断，只读这里）。
 * @returns {'cloud'|'local-dev'}
 */
export function writeFaceMode() {
  const forced = forcedMode()
  if (forced) return forced
  return cloudBaseConfigured() ? WRITE_FACE_MODES.CLOUD : WRITE_FACE_MODES.LOCAL_DEV
}

/** 形态的中文标注（上屏 / 报告用；`local-dev` 明确写「非正式写入路径」）。 */
export function writeFaceModeLabel() {
  return writeFaceMode() === WRITE_FACE_MODES.CLOUD
    ? '雲端寫入面（本機寫入入口＝dev / 離線形態）'
    : '本機寫入形態（dev / 離線；**非正式寫入路徑**）'
}

/* ---------------------------------------------------------------------------
   清单式标注（**8 个裸 save*Rows ＋ 6 个 drive 裸写入口 ＋ 10 个管理员写入口**）
   --------------------------------------------------------------------------- */

/** 裸落盘写函数（**无任何权限判定**：不经 `forbiddenFor`、不经服务层门）。 */
const RAW_PERSIST_ENTRIES = Object.freeze([
  { id: 'raw-saveSealRows', file: 'src/data/db.js', line: 1297, symbol: 'saveSealRows' },
  { id: 'raw-saveFaceRows', file: 'src/data/db.js', line: 1307, symbol: 'saveFaceRows' },
  { id: 'raw-saveImageRows', file: 'src/data/db.js', line: 1330, symbol: 'saveImageRows' },
  { id: 'raw-saveUserRows', file: 'src/data/db.js', line: 1577, symbol: 'saveUserRows' },
  { id: 'raw-saveCorrectionRows', file: 'src/data/db.js', line: 1601, symbol: 'saveCorrectionRows' },
  { id: 'raw-savePhotoRows', file: 'src/data/db.js', line: 1609, symbol: 'savePhotoRows' },
  { id: 'raw-savePointRows', file: 'src/data/db.js', line: 1643, symbol: 'savePointRows' },
  { id: 'raw-saveDownloadRows', file: 'src/data/db.js', line: 1651, symbol: 'saveDownloadRows' }
])

/** `drive.js` 的裸写入口（同样不经管理员门；`writeInviteRewardSetting` 由服务层把关）。 */
const DRIVE_RAW_ENTRIES = Object.freeze([
  { id: 'drive-writeDriveRows', file: 'src/data/drive.js', line: 347, symbol: 'writeDriveRows' },
  { id: 'drive-writeSeallistRows', file: 'src/data/drive.js', line: 389, symbol: 'writeSeallistRows' },
  { id: 'drive-writeSeallistItemRows', file: 'src/data/drive.js', line: 399, symbol: 'writeSeallistItemRows' },
  { id: 'drive-writeShareRows', file: 'src/data/drive.js', line: 409, symbol: 'writeShareRows' },
  { id: 'drive-writeInviteRows', file: 'src/data/drive.js', line: 419, symbol: 'writeInviteRows' },
  { id: 'drive-writeInviteRewardSetting', file: 'src/data/drive.js', line: 485, symbol: 'writeInviteRewardSetting' }
])

/** 管理员写入口（10 条；`W1` 〜 `W10` 编号沿用设计单 §1.2 的 A 表）。 */
const ADMIN_ENTRIES = Object.freeze([
  {
    id: 'W1',
    file: 'src/services/admin.js',
    line: 84,
    symbol: 'updateFaceFixedAttributes',
    dataLayer: 'src/data/db.js:1832 writeFaceFixedAttributes',
    note: '印面固定属性；数据层另有 forbiddenFor'
  },
  {
    id: 'W2',
    file: 'src/services/admin.js',
    line: 93,
    symbol: 'updateFixedAttributes',
    dataLayer: 'src/data/db.js:1861 writeFixedAttributes',
    note: '兼容入口；数据层另有 forbiddenFor'
  },
  {
    id: 'W3',
    file: 'src/data/db.js',
    line: 1914,
    symbol: 'writeSealFixedAttributes',
    dataLayer: '（本行即数据层）',
    note: '印章级【形制】/【材质】；**服务层入口本单未逐行复核**（只登记数据层）'
  },
  {
    id: 'W4',
    file: 'src/services/admin.js',
    line: 117,
    symbol: 'setInviteReward',
    dataLayer: 'src/data/drive.js:485 writeInviteRewardSetting',
    note: '**Phase 1 垂直切片：已改为 async 并经云函数验签后才落盘**',
    status: WRITE_FACE_ENTRY_STATUS.MIGRATED
  },
  {
    id: 'W5',
    file: 'src/services/corrections.js',
    line: 356,
    symbol: 'review',
    dataLayer: 'src/data/db.js:3158 writeCorrectionDecision',
    note: '勘误裁决；数据层另有 forbiddenFor'
  },
  {
    id: 'W6',
    file: 'src/services/corrections.js',
    line: 400,
    symbol: 'reviewCorrection',
    dataLayer: '同上',
    note: '兼容入口；**现存缺陷：拒绝形态缺 `reason`**（只返回 `{ok:false, message}`）'
  },
  {
    id: 'W7',
    file: 'src/data/db.js',
    line: 3226,
    symbol: 'markCorrectionRewarded',
    dataLayer: '（本行即数据层）',
    note: '勘误奖励标记'
  },
  {
    id: 'W8',
    file: 'src/data/db.js',
    line: 3003,
    symbol: 'createSealWithFaceRows',
    dataLayer: '另含 insertSealRow:2532 / insertImageRow:2594 / insertFaceRow:2706',
    note: '上传印章（新增进藏品库）'
  },
  {
    id: 'W9',
    file: 'src/data/db.js',
    line: 2876,
    symbol: 'replaceFaceImage',
    dataLayer: '（本行即数据层）',
    note: '重新上传印面图'
  },
  {
    id: 'W10',
    file: 'src/services/sealExport.js',
    line: 488,
    symbol: 'exportSealData',
    dataLayer: '零硬拦截（只生成本地产物）',
    note: '一键导出（读面偏写面）；拒绝形态 `{ok:false, reason, message}`'
  }
])

function annotate(entry, group) {
  const status = entry.status || WRITE_FACE_ENTRY_STATUS.UNMIGRATED
  return Object.freeze({
    ...entry,
    group,
    status,
    /* 清单式标注的逐条文字（机械可读 + 人可读）。 */
    annotation:
      status === WRITE_FACE_ENTRY_STATUS.MIGRATED
        ? '已過雲端驗簽（Phase 1 切片）：寫入前必須由 `xiai-admin-token` 回 `ok:true`'
        : '**未遷移**：Phase 1 未過雲端驗簽 ⇒ 生產下屬 dev / 離線形態，不得當作正式寫入路徑'
  })
}

/** 全量清单（冻结；**恰 8 + 6 + 10 ＝ 24 条**）。 */
export const LOCAL_WRITE_REGISTRY = Object.freeze([
  ...RAW_PERSIST_ENTRIES.map((entry) => annotate(entry, WRITE_FACE_GROUPS.RAW_PERSIST)),
  ...DRIVE_RAW_ENTRIES.map((entry) => annotate(entry, WRITE_FACE_GROUPS.DRIVE_RAW)),
  ...ADMIN_ENTRIES.map((entry) => annotate(entry, WRITE_FACE_GROUPS.ADMIN_ENTRY))
])

/** 清单（逐条含 `文件:行号` / 分组 / 迁移状态 / 标注文字）。 */
export function localWriteRegistry() {
  return LOCAL_WRITE_REGISTRY
}

/**
 * **机制读数**（自检 / 报告用）：分组计数 + 迁移状态计数 + 逐条 `文件:行号`。
 * @returns {{mode:string, total:number, byGroup:object, byStatus:object, entries:Array<{id:string, at:string, status:string}>}}
 */
export function localWriteReadout() {
  const byGroup = {}
  const byStatus = {}
  for (const entry of LOCAL_WRITE_REGISTRY) {
    byGroup[entry.group] = (byGroup[entry.group] || 0) + 1
    byStatus[entry.status] = (byStatus[entry.status] || 0) + 1
  }
  return {
    mode: writeFaceMode(),
    total: LOCAL_WRITE_REGISTRY.length,
    byGroup,
    byStatus,
    entries: LOCAL_WRITE_REGISTRY.map((entry) => ({
      id: entry.id,
      at: `${entry.file}:${entry.line}`,
      status: entry.status
    }))
  }
}

/* ---------------------------------------------------------------------------
   门（供 Phase 2 的写路径搬迁逐处接入；Phase 1 只交付机制 + 自检读数）
   --------------------------------------------------------------------------- */

/**
 * 本地写入口在**当前形态**下是否允许落盘。
 * @returns {null|{ok:false, reason:'FORBIDDEN', message:string}} `null` ＝ 放行（dev / 离线形态）
 */
export function localWriteDenial() {
  if (writeFaceMode() !== WRITE_FACE_MODES.CLOUD) return null
  return {
    ok: false,
    reason: 'FORBIDDEN',
    message:
      '本機寫入入口在雲端寫入面下已停用（dev / 離線形態，非正式寫入路徑）；請改走雲端校驗後的寫入路徑。本次零寫入。'
  }
}

/** 同上，别名（抛错式命名但**不抛错** —— 结构化拒绝，与工程纪律一致）。 */
export function assertLocalWriteAllowed() {
  return localWriteDenial()
}
