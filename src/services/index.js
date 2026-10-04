/**
 * 玺爱 · services 统一门面
 *
 * 约定：页面与组件**只能**通过本门面访问数据，
 * 不得直接读写 localStorage，也不得直接 import ../data/*。
 */

import * as auth from './auth.js'
import * as seals from './seals.js'
import * as corrections from './corrections.js'
/* **采信（採信）门面（本单新增）**：对他人同 `(faceId, field, value)` 的勘误提交点【採信】
   （只作佐证 / 可信度计数；生效仍由管理员采纳决定）。页面与组件仍**只**经本门面访问数据。 */
import * as endorsements from './endorsements.js'
import * as photos from './photos.js'
import * as points from './points.js'
import * as admin from './admin.js'
/* **「一鍵導出印章數據」（管理員專屬）**：詳情頁按鈕 → 單表 `.xlsx`（含內嵌影像）。
   页面与组件仍**只**经本门面访问数据。 */
import * as sealExport from './sealExport.js'
/* **【我的雲盤】门面（v1.21 新增｜K-1）**：資料夾 / 引用行 / 分享的读写入口与分享页投影
   （`resolveShare`）。页面与组件仍**只**经本门面访问数据（不得直接 import `../data/*`）。 */
import * as drive from './drive.js'
/* **读取面客户端（直出三面 ＋ 块面）**：下載面（原字節直出）/ 縮略面（256 單件）/ 塊面
   （逐塊，幾何只消費響應）。页面与组件仍**只**经本门面访问 —— 不得直接调 `fetch('/api/image/*')`。 */
import * as imageFaces from './imageFaces.js'

export const services = { auth, seals, corrections, endorsements, photos, points, admin, drive, imageFaces, sealExport }

export { auth, seals, corrections, endorsements, photos, points, admin, drive, imageFaces, sealExport }
export default services
