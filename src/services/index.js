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
/* **印人（person）门面（v1.53 新增｜person-model §6）**：正式印人查询 / 选人搜索 ＋ 提案的
   提交 / 采纳 / 驳回（管理员）。页面与组件仍**只**经本门面访问数据（不得直接 import `../data/*`）。 */
import * as persons from './persons.js'
/* **印谱（item）门面（v1.61 新增｜item 通道切片 A）**：外部批量導入的提交 / 待審讀面 /
   採納·駁回。页面与组件仍**只**经本门面访问数据（不得直接 import `../data/*`）。 */
import * as items from './items.js'
/* **「斐萃令牌」门面（本单改造）**：管理员签发 HMAC 令牌（取代一次性授权码 / CloudBase 核销）；
   页面与组件仍**只**经本门面访问数据。 */
import * as feicui from './feicui.js'
/* **「我的 AI」门面（本單新增）**：7 個 op（AI 金鑰 / 用量 / 上游配置）的唯一業務入口
   （`aiAccess.js`；鍵面真源、op 名字面值全倉唯一處）。页面与组件仍**只**经本门面访问数据。 */
import * as aiAccess from './aiAccess.js'
/* **「人工智能修復」门面（本單新增）**：印面影像 AI 修復的唯一業務入口（`aiEnhance.js`；
   op 名 / 讀數鍵面真源）。页面与组件仍**只**经本门面访问数据（不得直接 import `../data/*`）。 */
import * as aiEnhance from './aiEnhance.js'
/* **「廣場卡片分頁」门面（本單新增）**：首屏 48 枚 ＋ `next_cursor` 續拉 ＋ 四維篩選下推
   ＋ 封面走 `thumb_key`/`display_key`（`sealCards.js`；請求鍵面 / 16 鍵行面 / 篩選映射表真源）。
   页面与组件仍**只**经本门面访问数据（不得直接 import `../data/*`）。 */
import * as sealCards from './sealCards.js'
/* **「校驗作者」候选匹配门面（本單新增）**：公開只讀 op `suggestAuthors` 的唯一消費點
   （`authorMatch.js`；請求鍵面 / 候選 7 鍵面 / 命中字段中文名真源）。
   页面与组件仍**只**经本门面访问数据（不得直接 import `../data/*`）。 */
import * as authorMatch from './authorMatch.js'
/* **CARD 人物索引门面（本单新增）**：广场首屏要触发索引预热（`loadPersonIndex` ＝ 进程内单例，
   并发合并、**不是第二条拉取路径、更不是轮询**）—— 页面与组件仍**只**经本门面访问服务层。 */
import * as personCards from './personCards.js'
/* **出版社（publisher）门面（xiai.spec §3.107｜v1.133 入册）**：名录读面 ＋ ISBN 最长匹配反查 ＋
   管理员新建·改行·号段增删（新行 `_id = code` 只由号段账本发）。页面与组件仍**只**经本门面访问数据
   （不得直接 import `../data/*`）。 */
import * as publishers from './publishers.js'
/* **徽號（用戶暱稱）门面（本單新增｜方案 B）**：云端读 / 改名 ＋ 上屏名三级回落单点
   （`profile.js`；op 名 / 读数键面 / 回落链真源全仓唯一处）。页面与组件仍**只**经本门面访问数据
   （不得直接 import `../data/*`）。 */
import * as profile from './profile.js'
/* **斐萃同步审阅门面（本单新增｜Kevin 2026-11-26 裁定）**：`listToXiai` / `approve` /
   `applyUp` / `reject`（逐项、**零批量直通**）＋ 深链解析 ＋ admin 渲染门。
   审阅口复用 `/my/corrections`（**不新建 `/admin/sync` 路由**）；本期实体只
   `books` / `persons` / `publishers`。页面与组件仍**只**经本门面访问数据
   （不得直接 import `../data/*`、不直调云函数）。 */
import * as sync from './sync.js'

export const services = { auth, seals, corrections, endorsements, persons, photos, points, admin, drive, imageFaces, sealExport, items, feicui, aiAccess, aiEnhance, sealCards, authorMatch, personCards, publishers, profile, sync }

export { auth, seals, corrections, endorsements, persons, photos, points, admin, drive, imageFaces, sealExport, items, feicui, aiAccess, aiEnhance, sealCards, authorMatch, personCards, publishers, profile, sync }
export default services
