/**
 * 玺爱 · services 统一门面
 *
 * 约定：页面与组件**只能**通过本门面访问数据，
 * 不得直接读写 localStorage，也不得直接 import ../data/*。
 */

import * as auth from './auth.js'
import * as seals from './seals.js'
import * as corrections from './corrections.js'
import * as photos from './photos.js'
import * as points from './points.js'
import * as admin from './admin.js'
/* **【我的雲盤】门面（v1.21 新增｜K-1）**：資料夾 / 引用行 / 分享的读写入口与分享页投影
   （`resolveShare`）。页面与组件仍**只**经本门面访问数据（不得直接 import `../data/*`）。 */
import * as drive from './drive.js'
/* **读取面客户端（直出三面 ＋ 块面）**：下載面（原字節直出）/ 縮略面（256 單件）/ 塊面
   （逐塊，幾何只消費響應）。页面与组件仍**只**经本门面访问 —— 不得直接调 `fetch('/api/image/*')`。 */
import * as imageFaces from './imageFaces.js'

export const services = { auth, seals, corrections, photos, points, admin, drive, imageFaces }

export { auth, seals, corrections, photos, points, admin, drive, imageFaces }
export default services
