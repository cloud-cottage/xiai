/**
 * 玺爱 · 种子数据（纯前端 mock，零外部请求）
 *
 * 数据模型归属：**以玺爱为主**（canonical），斐萃旧结构只作入库映射来源。
 * canonical 层级：印章 `seal` 1 对 N 印面 `face`；边款是 `kind = EDGE` 的特殊印面，
 * 三类属性（固定 / 可标记 / 影像）**按印面归属**（见 SEED_FACES）。
 *
 * 兼容说明：印面行同时给出规范字段名 `id` / `sealId` / `kind`，并保留既落盘
 * services 与视图在用的 `stamp_id` 别名（＝`sealId`），**不要删除该别名**。
 * 印章行上的可标记字段仅为兼容既落盘视图保留；canonical 载体是印面。
 *
 * 「默认 1 印面 = 1 印章」只是新建种子时的默认值，不是模型限制：
 * 种子里已含多印面样本（XAI-0001：2 个印面 + 1 个边款）。
 */

/* **身份标识（uid）单点**：`src/data/uid.js`（`u-` ＋ sha256(手机号) 前 16 位，不可反推手机号）。 */
import { uidOf } from './uid.js'
/* **印章批 3（v1.55｜§3.55.5）**：内容指紋（導入行「疑似重複」軟提示用）的雜湊实现
   —— 复用既有 `assetmeta.js::sha256Hex`（自带、同步、跨环境），**不另造第二把尺子**。 */
import { sha256Hex } from './assetmeta.js'

/**
 * 玺爱新增字段：斐萃 seals 表中无对应列，属平台自建口径。
 *
 * **R-59（2026-09-21｜字段退役）**：【印文简体字】已**整体删除** —— 本清单不再列出它、
 * 种子行与新建行都不写该键，既有行（印章行 + 印面行）上的该键由数据层
 * `db.js` 的 `migrateTraditionalData()` **一次性幂等清除**（Kevin 明确授权改写历史行，
 * 本字段是唯一例外；其余字段的「旧值不改写」口径不变）。
 */
export const XIAI_ONLY_FIELDS = {
  author: '作者（斐萃無對應列，璽愛新增）'
}

/**
 * 玺爱平台**唯一管理员**手机号 —— 管理员判定的**唯一真源**（数据层常量）。
 *
 * 口径：管理员手机号只以本常量为准（README 与实现均引此处，不得另立第二个来源）。
 * 引导时数据层会按它**就地纠正**浏览器里已存在的 `users`（老库兼容，无需清库、
 * 无需升命名空间版本）：
 *   - 手机号 == `ADMIN_PHONE` ⇒ `role` 强制为 `admin`（该账号不存在则创建并写回）；
 *   - 手机号 ≠ `ADMIN_PHONE` 而 `role` 仍为 `admin` ⇒ 降为 `user`。
 * 纠正实现在 `src/data/db.js` 的 `reconcileAdminRoles()`，由 `ensureSeed()` 在**每次
 * 引导**时调用（与种子版本号无关）。
 */
export const ADMIN_PHONE = '16601061656'

/** 管理员账号昵称：仅用于**新建**该账号时；老库已有同名账号保留其原昵称。 */
export const ADMIN_NICKNAME = '庫守'






/** **8 级灰（R-83）**：灰度化后中位切分的量化级数＝调色板项数（**本工程唯一真源**）。 */

/**
 * **切向序列（R-87 冻结、逐字）**：刀1 `vertical`、刀2 `horizontal`（⊥刀1）、
 * **刀3 `vertical`（回刀1 方向）**；印面 4 块取**前 2 刀**、实拍 8 块取**3 刀**。
 *
 * 纪律：**不得**增删改序、**不得**在别处再写一份同序列；跨刀方向**必须交替**
 * （刀 3 与刀 2 不同向是 Kevin 明确口径）。
 */
export const SLICE_DIRECTIONS = ['vertical', 'horizontal', 'vertical']

/**
 * **切片张数真源（R-87）**：按**切片类别**取刀数 ——
 *   - `FACE`：**印面**，切 2 刀 ⇒ **4 块＝2×2**；
 *   - `PHOTO`：**实拍**（用户实物照），切 3 刀 ⇒ **8 块＝4×2**。
 *
 * 类别取值口径：`FACE` ＝ 印面族影像（影像行的 `kind` 即 `FACE` / `EDGE`，两者都按印面 4 块）；
 * `PHOTO` ＝ 实物照片族（R-86）。**未登记的类别按印面 4 块**（保守：不虚增张数），
 * 由 `db.js` 的 `sliceMetaOf(imageId, kind)` 统一解析 —— **不得**在别处写死张数或切位。
 */
export const SLICE_CUT_COUNTS = {
  FACE: 2,
  PHOTO: 3
}

/** 切片元数据键名（**R-87 / R-88 冻结**：影像行上的持久化键 `slice_meta`）。 */
export const SLICE_META_FIELD = 'slice_meta'

/**
 * **印面级固定属性白名单（真源）**：`['face_image_id', 'edge_image_ids']`。
 *
 * 一道门（字段面）：不在此列的键 ⇒ `INVALID_FIELD` ＋ 零写入（判定在任何写入之前）；
 * 二道门（值域面）各自另判（见 `db.js`）。
 * **本单（R-135 配色面整体退场）之后**：该列**只有两项** —— 已退场的那个键不在此列，
 * 显式传它 ⇒ `INVALID_FIELD`（不再有任何值域门 / 默认值 / 落盘动作）。
 */
export const FIXED_ATTR_FIELDS = ['face_image_id', 'edge_image_ids']

/** 印面类型：FACE＝印面，EDGE＝边款（边款是一种特殊印面）。 */
export const FACE_KIND = {
  FACE: 'FACE',
  EDGE: 'EDGE'
}

/**
 * 种子用户。
 *
 * 管理员账号手机号取自 `ADMIN_PHONE`（唯一真源），账号 id 与登录服务自动建号的
 * 命名口径一致（**不透明 uid**：`src/data/uid.js::uidOf(手机号)` ⇒ `u-` ＋ sha256 前 16 位，
 * **不可反推手机号**）。**原管理员号 `13800000001` 已不再是管理员**：
 * 它既不在本种子里，也不再是 `admin`；老库中若残留该账号，由
 * `reconcileAdminRoles()` 就地降为普通用户（不删行、不清库）。**老库既有 `u-<手机号>` 形态的
 * 账号行保留不改、不迁移**（登录按手机号匹配，与 id 形态无关）。
 */
export const SEED_USERS = [
  {
    id: uidOf(ADMIN_PHONE),
    phone: ADMIN_PHONE,
    nickname: ADMIN_NICKNAME,
    role: 'admin',
    points: 50,
    created_at: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'u-demo',
    phone: '13800000002',
    nickname: '印友',
    role: 'user',
    points: 50,
    created_at: '2026-01-01T00:00:00.000Z'
  }
]

export const SEED_SEALS = [
  {
    sealGroupId: 'g-0001',
    stamp_id: 'XAI-0001',
    seal_name: '長壽',
    transcription: '取「長樂無極、壽比南山」之意，漢人吉語印常用語。',
    dynasty: '漢',
    seal_type: '吉語印',
    seal_style: '白文',
    material: '青銅',
    asset_kind: 'SEAL',
    review_status: 'APPROVED',
    author: '無名'
  },
  {
    sealGroupId: 'g-0002',
    stamp_id: 'XAI-0002',
    seal_name: '騎都尉印',
    transcription: '漢代武職官印，騎都尉掌羽林騎兵，秩比二千石。',
    dynasty: '漢',
    seal_type: '官印',
    seal_style: '白文',
    material: '青銅',
    asset_kind: 'SEAL',
    review_status: 'APPROVED',
    author: '無名'
  },
  {
    sealGroupId: 'g-0003',
    stamp_id: 'XAI-0003',
    seal_name: '昌',
    transcription: '單字圓印，戰國私印常見形制，多作佩印之用。',
    dynasty: '戰國',
    seal_type: '私印',
    seal_style: '朱文',
    material: '玉',
    asset_kind: 'SEAL',
    review_status: 'APPROVED',
    author: '無名'
  },
  {
    sealGroupId: 'g-0004',
    stamp_id: 'XAI-0004',
    seal_name: '文彭之印',
    transcription: '明代文人篆刻開山之作，印風秀潤，開吳門一派。',
    dynasty: '明',
    seal_type: '私印',
    seal_style: '朱文',
    material: '青田石',
    asset_kind: 'SEAL',
    review_status: 'APPROVED',
    author: '文彭'
  },
  {
    sealGroupId: 'g-0005',
    stamp_id: 'XAI-0005',
    seal_name: '丁敬身印',
    transcription: '浙派宗師丁敬自用印，切刀澀進，古拗峭折。',
    dynasty: '清',
    seal_type: '私印',
    seal_style: '白文',
    material: '壽山石',
    asset_kind: 'SEAL',
    review_status: 'APPROVED',
    author: '丁敬'
  },
  {
    sealGroupId: 'g-0006',
    stamp_id: 'XAI-0006',
    seal_name: '家在錢塘',
    transcription: '閒章，寓鄉思。浙派閒章多取里居、志向入印。',
    dynasty: '清',
    seal_type: '閒章',
    seal_style: '白文',
    material: '壽山石',
    asset_kind: 'SEAL',
    review_status: 'APPROVED',
    author: '陳豫鍾'
  },
  {
    sealGroupId: 'g-0007',
    stamp_id: 'XAI-0007',
    seal_name: '乾隆御覽之寶',
    transcription: '清宮鑒藏璽，多鈐於內府書畫引首，規制宏整。',
    dynasty: '清',
    seal_type: '鑒藏印',
    seal_style: '朱文',
    material: '田黃',
    asset_kind: 'SEAL',
    review_status: 'APPROVED',
    author: '清內府'
  },
  {
    sealGroupId: 'g-0008',
    stamp_id: 'XAI-0008',
    seal_name: '安持',
    transcription: '陳巨來號安持，元朱文精絕，時稱近代第一。',
    dynasty: '近現代',
    seal_type: '私印',
    seal_style: '朱文',
    material: '昌化凍石',
    asset_kind: 'SEAL',
    review_status: 'PENDING',
    author: '陳巨來'
  }
]

/**
 * 印面影像（对齐 images 表）。每枚印章至少一张 FACE；
 * 部分印章另附 EDGE（边款）。
 * 因本工程零外部请求，不存真实图象，仅存可复算的元数据与摘要占位。
 *
 * **R-87 / R-88（2026-09-21｜切割元数据）**：影像行另有**切片元数据**键 `slice_meta`
 * （＝`{directions, ratios, cols, rows, cuts}`）。它**不在本数组里写死字面量** ——
 * 落盘时由数据层用**同一确定性派生函数**（`db.js` 的 `sliceMetaOf`）补上，
 * 以免「种子字面量」与「派生真源」两处漂移（同一 image id 必得同一元数据，
 * 故既有行**无需迁移**，派生即可复现）。
 */
export const SEED_IMAGES = [
  { id: 'img-0001f', stamp_id: 'XAI-0001', kind: 'FACE', sha256: '3d1f0b2a6c7e4915b8a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718', bytes: 184320, width: 1600, height: 1600, color_mode: 'RGB' },
  { id: 'img-0001g', stamp_id: 'XAI-0001', kind: 'FACE', sha256: '5c6d7e8f90a1b2c3d4e5f60718293a4b3d1f0b2a6c7e4915b8a2c3d4e5f60718e', bytes: 141312, width: 1200, height: 1200, color_mode: 'RGB' },
  { id: 'img-0001e', stamp_id: 'XAI-0001', kind: 'EDGE', sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f903d1f0b2a6c7e4915b8a2c3d4e5f60718', bytes: 210112, width: 2400, height: 800, color_mode: 'RGB' },

  { id: 'img-0002f', stamp_id: 'XAI-0002', kind: 'FACE', sha256: 'b2c3d4e5f60718293a4b5c6d7e8f90a13d1f0b2a6c7e4915b8a2c3d4e5f607182', bytes: 176540, width: 1600, height: 1600, color_mode: 'RGB' },

  { id: 'img-0003f', stamp_id: 'XAI-0003', kind: 'FACE', sha256: 'c3d4e5f60718293a4b5c6d7e8f90a1b23d1f0b2a6c7e4915b8a2c3d4e5f6071829', bytes: 158900, width: 1400, height: 1400, color_mode: 'RGB' },

  { id: 'img-0004f', stamp_id: 'XAI-0004', kind: 'FACE', sha256: 'd4e5f60718293a4b5c6d7e8f90a1b2c33d1f0b2a6c7e4915b8a2c3d4e5f6071829a', bytes: 199872, width: 1800, height: 1800, color_mode: 'RGB' },
  { id: 'img-0004e', stamp_id: 'XAI-0004', kind: 'EDGE', sha256: 'e5f60718293a4b5c6d7e8f90a1b2c3d43d1f0b2a6c7e4915b8a2c3d4e5f6071829ab', bytes: 245760, width: 2600, height: 900, color_mode: 'RGB' },

  { id: 'img-0005f', stamp_id: 'XAI-0005', kind: 'FACE', sha256: 'f60718293a4b5c6d7e8f90a1b2c3d4e53d1f0b2a6c7e4915b8a2c3d4e5f6071829abc', bytes: 172032, width: 1600, height: 1600, color_mode: 'RGB' },
  { id: 'img-0005e', stamp_id: 'XAI-0005', kind: 'EDGE', sha256: '0718293a4b5c6d7e8f90a1b2c3d4e5f63d1f0b2a6c7e4915b8a2c3d4e5f6071829abcd', bytes: 233984, width: 2600, height: 900, color_mode: 'RGB' },

  { id: 'img-0006f', stamp_id: 'XAI-0006', kind: 'FACE', sha256: '18293a4b5c6d7e8f90a1b2c3d4e5f6073d1f0b2a6c7e4915b8a2c3d4e5f60718a', bytes: 165376, width: 1600, height: 1600, color_mode: 'RGB' },

  { id: 'img-0007f', stamp_id: 'XAI-0007', kind: 'FACE', sha256: '293a4b5c6d7e8f90a1b2c3d4e5f607183d1f0b2a6c7e4915b8a2c3d4e5f60718b', bytes: 289792, width: 2000, height: 2000, color_mode: 'RGB' },
  { id: 'img-0007e', stamp_id: 'XAI-0007', kind: 'EDGE', sha256: '3a4b5c6d7e8f90a1b2c3d4e5f60718293d1f0b2a6c7e4915b8a2c3d4e5f60718c', bytes: 301056, width: 2800, height: 960, color_mode: 'RGB' },

  { id: 'img-0008f', stamp_id: 'XAI-0008', kind: 'FACE', sha256: '4b5c6d7e8f90a1b2c3d4e5f60718293a3d1f0b2a6c7e4915b8a2c3d4e5f60718d', bytes: 168960, width: 1600, height: 1600, color_mode: 'GRAY' }
]

/**
 * **朝代真源（R-20｜唯一真源，冻结）**：逐字 **15 类**，**顺序即本数组顺序**，不得增删改序。
 *
 * 口径（裁定全文见 `docs/xiai-plan.md` §12.7）：
 *   - 录入面（新增印章 / 勘误）**选项只能来自本常量**，不得再 ∪ 库内派生值
 *     （旧形态 `unionOptions(DYNASTY_OPTIONS, seals.listDynastyOptions())` 已废除）；
 *   - **数据层独立校验**（第二道门，见 `db.js` 的 `dynastyValueDenial`）：凡**写入** `dynasty`
 *     的行都必须 `∈ 本数组`，否则结构化拒绝 `{ok:false, reason:'INVALID_VALUE'}` + 零写入；
 *   - **R-21 旧值不改写（读路径口径）**：既有行的旧值（`漢` / `戰國` / `明` / `清` /
 *     `近現代` 等）**在读路径上一律原样读出**，**不做值域校验**；
 *     广场筛选＝本 15 类（规范顺序）＋库内旧值（去重、追加于后）。
 *   - **R-58 / R-60（2026-09-21｜繁体化）**：本 15 类的字面自本轮起为**繁体**
 *     （＝OpenCC `s2t` 的逐字输出，可复算）；库内既有行的枚举字段由数据层
 *     `db.js` 的 `migrateTraditionalData()` 按**显式值映射表**归一（映射不到的旧值
 *     如 `戰國` / `明` / `清` / `近現代` **保留原样并登记**，不归一、不猜）。
 */
export const DYNASTY_OPTIONS = [
  '春秋',
  '戰國',
  '秦',
  '漢',
  '魏晉',
  '隋唐',
  '宋元',
  '明早中期',
  '晚明',
  '清初',
  '清中期',
  '晚清',
  '民國',
  '新中國',
  '當代'
]

/** 朝代值是否在冻结的 15 类之内（**纯谓词**，不抛错；供数据层值域门复用同一真源）。 */
export function isKnownDynasty(value) {
  if (value === null || value === undefined) return false
  return DYNASTY_OPTIONS.includes(String(value))
}

/* ============================================================================
   印面内容（R-30）与印面风格（R-31）—— **常量真源**（唯一，就地存放）

/**
 * **印面内容（9 值｜冻结）**：显示名＝【印面内容】，键名沿用 `seal_type`。
 *
 * **顺序即显示顺序**，不得增删改序。录入面（新增印章 / 勘误）选项**只能来自本数组**
 * （不得再 ∪ 库内派生值）；既有行的旧值（`吉語印` / `鑒藏印` / `閒章` 等）**读路径一律照读**
 * （不做值域校验）。
 *
 * **R-58 / R-60（2026-09-21｜繁体化）**：本 9 类的字面自本轮起为**繁体**（`s2t` 输出）。
 * 库内既有的**异体旧值**由数据层按显式映射表归一（实测：`鑒藏印` ⇒ `鑑藏印`；`s2t`
 * 逐字转换**不会**得到该结果，故必须显式列入映射表）；映射不到的旧值保原样 + 登记。
 */
export const FACE_CONTENT_OPTIONS = [
  '官印',
  '私印',
  '姓名印',
  '齋館印',
  '鑑藏印',
  '吉語印',
  '肖形印',
  '花押印',
  '閒章'
]

/** **印面内容**值是否在冻结的 9 类之内（**纯谓词**，不抛错；供值域门复用同一真源）。 */
export function isKnownFaceContent(value) {
  if (value === null || value === undefined) return false
  return FACE_CONTENT_OPTIONS.includes(String(value))
}

/**
 * **印面风格（23 值｜冻结）**：显示名＝【印面风格】，键名＝**新键 `face_style`**（印面级）。
 *
 * **顺序即显示顺序**（按时代 / 流派脉络排列），不得增删改序。旧行一律无该字段 ⇒
 * 读值＝**空串**（**无回落**：不从 `seal_style` / 印章行取任何值 —— 那会等于编造）。
 */
export const FACE_STYLE_OPTIONS = [
  '三晉古璽',
  '楚古璽',
  '燕古璽',
  '齊古璽',
  '秦印',
  '漢白文鑄印',
  '漢玉印',
  '將軍急就章',
  '漢朱文',
  '朱白相間印',
  '魏晉印',
  '隋唐九疊篆印',
  '元朱文',
  '浙派',
  '鄧派',
  '歙派',
  '吳讓之印風',
  '趙之謙印風',
  '黃牧甫印風',
  '吳昌碩印風',
  '趙叔孺印風',
  '陳巨來印風',
  '來楚生印風'
]

/** **印面风格**值是否在冻结的 23 类之内（**纯谓词**，不抛错；供值域门复用同一真源）。 */
export function isKnownFaceStyle(value) {
  if (value === null || value === undefined) return false
  return FACE_STYLE_OPTIONS.includes(String(value))
}

/**
 * **印章大類（3 值｜冻结）**：顯示名＝【大類】，键名＝**新键 `seal_class`**（**印面级**）。
 *
 * **顺序即显示顺序**，**值域封闭**（恰三值：`古璽` / `流派印` / `雜項`），不得增删改序。
 * 录入面（新增印章 / 勘误）选项**只能来自本数组**；**印面级无回落**（不从印章行 / 其它键取任何值，
 * 旧行一律无该键 ⇒ 读值＝空串）。
 *
 * 口径：与朝代 15 / 印面内容 9 / 印面风格 23 **同口型**（真源单点在 `seed.js`，
 * 视图层与数据层 / 服务层**只引真源，不得硬编码副本**）。
 */
export const SEAL_CLASS_OPTIONS = ['古璽', '流派印', '雜項']

/** **大類**值是否在冻结的 3 类之内（**纯谓词**，不抛错；供值域门复用同一真源）。 */
export function isKnownSealClass(value) {
  if (value === null || value === undefined) return false
  return SEAL_CLASS_OPTIONS.includes(String(value))
}

/**
 * **大類建议值（按朝代预填的唯一真源）**：分段覆盖 `DYNASTY_OPTIONS` 全 15 类——
 *   - 春秋〜宋元（春秋 / 戰國 / 秦 / 漢 / 魏晉 / 隋唐 / 宋元）⇒ `古璽`；
 *   - 明早中期〜民國（明早中期 / 晚明 / 清初 / 清中期 / 晚清 / 民國）⇒ `流派印`；
 *   - 新中國 / 當代 ⇒ `雜項`。
 *
 * **仅作建议**：上传弹窗据此**预填** `seal_class`，**不锁死**（用户可手动改；改后以用户所选落盘）。
 * 未知 / 空朝代 ⇒ 空串（**不猜**）。视图层**不得**另写第二套映射。
 */
export const SEAL_CLASS_SUGGESTIONS = [
  { seal_class: '古璽', dynasties: ['春秋', '戰國', '秦', '漢', '魏晉', '隋唐', '宋元'] },
  { seal_class: '流派印', dynasties: ['明早中期', '晚明', '清初', '清中期', '晚清', '民國'] },
  { seal_class: '雜項', dynasties: ['新中國', '當代'] }
]

/** 按朝代取**建议大類**（纯函数；未命中 ⇒ 空串）。视图层只调它，**不自写第二套映射**。 */
export function suggestSealClass(dynasty) {
  const text = dynasty === null || dynasty === undefined ? '' : String(dynasty).trim()
  if (!text) return ''
  const hit = SEAL_CLASS_SUGGESTIONS.find((item) => item.dynasties.includes(text))
  return hit ? hit.seal_class : ''
}

/**
 * **旧分类枚举（5 值）—— 只作历史留档，保留导出；当前全仓无任何消费方**。
 *
 * ⚠️ **消费方现状（2026-09-20 实测）**：**无 UI / 服务消费方** —— `UploadSealDialog.vue` 等
 * 组件**已不再 import 它、也不再取值**（`grep -rn "SEAL_TYPE_OPTIONS" src/` 的命中只剩本条
 * 注释与 `UploadSealDialog.vue` 里**描述「旧形态已删除」的一行注释**，无任何 `import` / 取值；
 * 证据 ＝ `qa-recheck/kong-r5clean-20260920/grep-sealtypeoptions.txt`）。
 * 本常量只为「不删既有导出」而留（R-30：旧常量保留导出）。
 *
 * ⚠️ **自 R-30 起它不再是录入真源**：录入面（新增印章 / 勘误）的选项真源是
 * `FACE_CONTENT_OPTIONS`（9 值）。新代码**不得**由它派生出选项面
 * （`SEAL_TYPE_OPTIONS` 与 9 值不是同一套口径：它是繁体旧形态，会被值域门按 `INVALID_VALUE` 拒绝）。
 * 库内既有值（含繁体）受 R-32「旧值不改写」保护，仍可读、可筛。
 *
 * **R-58 / R-60（2026-09-21）**：本常量**保留 `鑒藏印` 异体字面未改**（它无任何消费方、
 * 也不属上屏面；改它等于动一个「只为不删既有导出而留」的历史留档）。若其值被写进库，
 * 会经 `db.js` 的显式值映射表归一为 R-58 的 `鑑藏印`。
 */
export const SEAL_TYPE_OPTIONS = ['官印', '私印', '吉語印', '閒章', '鑒藏印']

/* ============================================================================
   印章级固定属性（R-22 / R-23 / **R-32**）

/** 印章级固定属性字段名（**冻结契约**：`SEAL_SHAPE_FIELD = 'shape'`）。 */
export const SEAL_SHAPE_FIELD = 'shape'

/** 印章级固定属性字段名（**R-32 冻结**：`SEAL_MATERIAL_FIELD = 'material'`）。 */
export const SEAL_MATERIAL_FIELD = 'material'

/** 印章级固定属性白名单（**R-32 冻结契约**：`['shape','material']`）。 */
export const SEAL_FIXED_ATTR_FIELDS = [SEAL_SHAPE_FIELD, SEAL_MATERIAL_FIELD]

/* ============================================================================
   印面 `face`（canonical 一等实体）
   ============================================================================ */

function faceSeed({
  id,
  sealId,
  kind,
  faceImageId = null,
  material,
  edgeImageIds = [],
  markable = {},
  source = null
}) {
  return {
    id,
    sealId, // 规范字段：所属印章（印章 1 对 N 印面）
    stamp_id: sealId, // 兼容别名：等同于 sealId，供既落盘 services / 视图按原命名读取
    kind, // FACE＝印面 / EDGE＝边款（边款是一种特殊印面）
    face_image_id: faceImageId, // 固定属性：印面图片
    material, // 固定属性：材质（**历史上**属印面级；R-32 后真源移至印章行，本处旧值保留）
    edge_image_ids: edgeImageIds, // 固定属性：边款图片 ID（kind = EDGE 的影像 id）
    // 可标记属性（勘误对象）
    seal_name: markable.seal_name || '',
    dynasty: markable.dynasty || '',
    seal_type: markable.seal_type || '', // 印面内容（R-30：印面级真源，键名沿用 seal_type）
    face_style: markable.face_style || '', // 印面风格（R-31：新键；种子一律空串，无回落）
    author: markable.author || '',
    transcription: markable.transcription || '',
    source, // 来源追踪（可空）
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  }
}

export const SEED_FACES = [
  /* ---- XAI-0001 長壽：多印面样本（2 个印面 + 1 个边款） ---- */
  faceSeed({
    id: 'fc-0001-f1',
    sealId: 'XAI-0001',
    kind: FACE_KIND.FACE,
    faceImageId: 'img-0001f',
    material: '青銅',
    markable: {
      seal_name: '長壽',
      dynasty: '漢',
      seal_type: '吉語印',
      author: '無名',
      transcription: '取「長樂無極、壽比南山」之意，漢人吉語印常用語。'
    },
    source: { book: '《漢印文字徵》', page: '卷三 十二頁' }
  }),
  faceSeed({
    id: 'fc-0001-f2',
    sealId: 'XAI-0001',
    kind: FACE_KIND.FACE,
    faceImageId: 'img-0001g',
    material: '青銅',
    markable: {
      seal_name: '長壽合文',
      dynasty: '漢',
      seal_type: '吉語印',
      author: '無名',
      transcription: '同印之另一面，二字作合文，筆畫互借，為漢代吉語印習見佈局。'
    },
    source: null
  }),
  faceSeed({
    id: 'fc-0001-e1',
    sealId: 'XAI-0001',
    kind: FACE_KIND.EDGE,
    faceImageId: null,
    material: '青銅',
    edgeImageIds: ['img-0001e'],
    markable: {
      seal_name: '長壽',
      dynasty: '漢',
      seal_type: '吉語印',
      author: '無名',
      transcription: '邊款一行，記此印為漢吉語印之同範者，可與卷三者互證。'
    },
    source: { book: '《漢印文字徵》', page: '卷三 十二頁' }
  }),

  /* ---- 其余印章：默认 1 印面 = 1 印章（仅为种子默认值，非模型限制） ---- */
  faceSeed({
    id: 'fc-0002-f1',
    sealId: 'XAI-0002',
    kind: FACE_KIND.FACE,
    faceImageId: 'img-0002f',
    material: '青銅',
    markable: {
      seal_name: '騎都尉印',
      dynasty: '漢',
      seal_type: '官印',
      author: '無名',
      transcription: '漢代武職官印，騎都尉掌羽林騎兵，秩比二千石。'
    },
    source: null
  }),
  faceSeed({
    id: 'fc-0003-f1',
    sealId: 'XAI-0003',
    kind: FACE_KIND.FACE,
    faceImageId: 'img-0003f',
    material: '玉',
    markable: {
      seal_name: '昌',
      dynasty: '戰國',
      seal_type: '私印',
      author: '無名',
      transcription: '單字圓印，戰國私印常見形制，多作佩印之用。'
    },
    source: null
  }),
  faceSeed({
    id: 'fc-0004-f1',
    sealId: 'XAI-0004',
    kind: FACE_KIND.FACE,
    faceImageId: 'img-0004f',
    material: '青田石',
    markable: {
      seal_name: '文彭之印',
      dynasty: '明',
      seal_type: '私印',
      author: '文彭',
      transcription: '明代文人篆刻開山之作，印風秀潤，開吳門一派。'
    },
    source: null
  }),
  faceSeed({
    id: 'fc-0004-e1',
    sealId: 'XAI-0004',
    kind: FACE_KIND.EDGE,
    faceImageId: null,
    material: '青田石',
    edgeImageIds: ['img-0004e'],
    markable: {
      seal_name: '文彭之印',
      dynasty: '明',
      seal_type: '私印',
      author: '文彭',
      transcription: '邊款記「壬寅秋日三橋自制」，刀法溫潤，為吳門派自用印之證。'
    },
    source: null
  }),
  faceSeed({
    id: 'fc-0005-f1',
    sealId: 'XAI-0005',
    kind: FACE_KIND.FACE,
    faceImageId: 'img-0005f',
    material: '壽山石',
    markable: {
      seal_name: '丁敬身印',
      dynasty: '清',
      seal_type: '私印',
      author: '丁敬',
      transcription: '浙派宗師丁敬自用印，切刀澀進，古拗峭折。'
    },
    source: null
  }),
  faceSeed({
    id: 'fc-0005-e1',
    sealId: 'XAI-0005',
    kind: FACE_KIND.EDGE,
    faceImageId: null,
    material: '壽山石',
    edgeImageIds: ['img-0005e'],
    markable: {
      seal_name: '丁敬身印',
      dynasty: '清',
      seal_type: '私印',
      author: '丁敬',
      transcription: '邊款記「龍泓山人自製」，款字用刀如筆，可觀浙派趨向。'
    },
    source: null
  }),
  faceSeed({
    id: 'fc-0006-f1',
    sealId: 'XAI-0006',
    kind: FACE_KIND.FACE,
    faceImageId: 'img-0006f',
    material: '壽山石',
    markable: {
      seal_name: '家在錢塘',
      dynasty: '清',
      seal_type: '閒章',
      author: '陳豫鍾',
      transcription: '閒章，寓鄉思。浙派閒章多取里居、志向入印。'
    },
    source: null
  }),
  faceSeed({
    id: 'fc-0007-f1',
    sealId: 'XAI-0007',
    kind: FACE_KIND.FACE,
    faceImageId: 'img-0007f',
    material: '田黃',
    markable: {
      seal_name: '乾隆御覽之寶',
      dynasty: '清',
      seal_type: '鑒藏印',
      author: '清內府',
      transcription: '清宮鑒藏璽，多鈐於內府書畫引首，規制宏整。'
    },
    source: null
  }),
  faceSeed({
    id: 'fc-0007-e1',
    sealId: 'XAI-0007',
    kind: FACE_KIND.EDGE,
    faceImageId: null,
    material: '田黃',
    edgeImageIds: ['img-0007e'],
    markable: {
      seal_name: '乾隆御覽之寶',
      dynasty: '清',
      seal_type: '鑒藏印',
      author: '清內府',
      transcription: '邊款記內府編次，可與《石渠寶笈》著錄相參。'
    },
    source: null
  }),
  faceSeed({
    id: 'fc-0008-f1',
    sealId: 'XAI-0008',
    kind: FACE_KIND.FACE,
    faceImageId: 'img-0008f',
    material: '昌化凍石',
    markable: {
      seal_name: '安持',
      dynasty: '近現代',
      seal_type: '私印',
      author: '陳巨來',
      transcription: '陳巨來號安持，元朱文精絕，時稱近代第一。'
    },
    source: null
  })
]

/* ============================================================================
   **印人（person）真源（person-model-draft-v0.1 §2 / §3）**
   ----------------------------------------------------------------------------
   归属 ＝ **玺爱 canonical 唯一真源**：正式印人（历史作者，A 支）落新集合 `xiai_persons`；
   提案 / 审核行落 `xiai_person_proposals`；平台用户（B 支）**并入既有 `xiai_users`**、
   **不另建集合、不建 person 行**。
   本常量区**只落「新集合名 / 编号前缀与形态 / 值的默认」**；读写、值域门、显示名派生在
   `data/db.js`。**绝不碰 `liwu` 命名面**（一律 `xiai_` 前缀）。
   ============================================================================ */

/** 正式印人集合名（`xiai_` 前缀；与云控制台新建的集合逐字一致）。 */
export const XIAI_PERSONS_COLLECTION = 'xiai_persons'

/** 印人提案 / 审核行集合名（`xiai_` 前缀）。 */
export const XIAI_PERSON_PROPOSALS_COLLECTION = 'xiai_person_proposals'

/** 印人编号前缀（Kevin 亲选：与印章 `XA`、资料夹 `SL` 同型 ⇒ `PR`）。 */
export const PERSON_CODE_PREFIX = 'PR'

/** 印人编号形态（`PR` 大写 ASCII ＋ 恰 9 位零填充；与 `^XA\d{9}$` 同型）。 */
export const PERSON_CODE_PATTERN = /^PR\d{9}$/

/** 序号 → 印人编号：`PR` ＋ 9 位零填充。 */
export function formatPersonCode(serial) {
  return `${PERSON_CODE_PREFIX}${String(serial).padStart(9, '0')}`
}

/**
 * 印人属性字段清单（`xiai_persons` 行；＝**提交面**同形）。
 *   - 姓 / 名：字符串，可空；
 *   - `字` / `号` / `别名`：**一律数组**（CBDB 别名本就是数组，**不猜分类**）；
 *   - 生卒：只存**公元整数**；「不详」＝`null`（**不设特值、不设区间字符串**）；
 *   - `cbdb_id` / `card_id`：**本期不接线，只落两个可空字段**（零读取、零形态校验）；
 *   - 预留字段位（本期不接线）：`years_lived` / `birth_era_text` / `death_era_text` /
 *     `dynasty` / `gender`。
 * `display_name` **不在此列**（派生、**不落盘**，见 `db.js::personDisplayName`）。
 */
export const PERSON_FIELDS = [
  'family_name',
  'given_name',
  'courtesy_names',
  'art_names',
  'alias_names',
  'birth_year',
  'death_year',
  'years_lived',
  'birth_era_text',
  'death_era_text',
  'dynasty',
  'gender',
  'cbdb_id',
  'card_id',
  /* **批 2 前置（v1.54｜§3.54.13 / §4.1.14 表下注（v1.54））**：A 支 `xiai_persons` 扩四字段
     ＋ 两繁简副字段。**繁体为正字段、简体入 `*_chs` 副字段；不做任何转换改写**；
     `source` / `source_id` 为元数据、**无繁简面**。四字段**只经采纳路径写**（值来自导入行）。 */
  'native_place',
  'biography',
  'source',
  'source_id',
  'native_place_chs',
  'biography_chs'
]

/**
 * 印人一行「值的默认」（**新增提案 / 采纳后生成**都以本形态起手，缺省一律空、不设特值）。
 * 数组键 ⇒ `[]`；标量键 ⇒ `''`；生卒 ⇒ `null`（「不详」＝空）。
 * @returns {object} 空印人字段面（**不含 `id` / `code` / 溯源 / 时间戳** —— 那些由采纳路径系统写）
 */
export function emptyPersonFields() {
  const out = {}
  const arrayKeys = ['courtesy_names', 'art_names', 'alias_names']
  const nullKeys = ['birth_year', 'death_year', 'years_lived']
  PERSON_FIELDS.forEach((key) => {
    if (arrayKeys.includes(key)) out[key] = []
    else if (nullKeys.includes(key)) out[key] = null
    else out[key] = ''
  })
  return out
}

/** 印人提案三态（与勘误三态同形：单向、**终态不回退**）。 */
export const PERSON_PROPOSAL_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED'
}

/* ============================================================================
   **印人批 2 前置增量：外部批量导入通道（v1.54｜§3.54.13 〜 §3.54.18 ＋ §4.1.16）**
   ----------------------------------------------------------------------------
   外部批量导入先落暂存集合 `xiai_person_imports` 的 `PENDING` 行；管理员批量采纳
   （`PENDING → ACCEPTED`）⇒ **幂等**落 `xiai_persons`（按 `source_person_id` 幂等）；
   `REJECTED` ⇒ **零写入**。两集合皆**单写者**（不开放任何直写入口，含管理员直写）。
   **本常量区只落「集合名 / 字段真源 / 三态枚举 / 键前缀」**；读写、幂等键、直写门在
   `data/db.js`；云侧读面在 `data/cloudbase.js`；写通道在 `services/persons.js` ＋ 云函数。
   本增量**零新增 `reason` 字面值**（值域 / 形态校验若有，一律沿用既有冻结表）。
   ============================================================================ */

/** 外部批量导入暂存集合名（`xiai_` 前缀；逐字，云控制台新建的集合须与此逐字一致）。 */
export const XIAI_PERSON_IMPORTS_COLLECTION = 'xiai_person_imports'

/** 导入行文档键前缀（确定性 / 可读）。 */
export const PERSON_IMPORT_ID_PREFIX = 'pi-'

/** 导入行三态（**恰三态、单向、终态不回退**；与提案三态逐字同形）。 */
export const PERSON_IMPORT_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED'
}

/**
 * **导入行行级元数据字段（§4.1.16）**：行主键 / 批次 / 来源 / 幂等键 / 状态 / 导入与审核留痕。
 * 身份类键（`imported_by` / `reviewer_id`）**一律落不透明 uid、零手机号**（沿 §3.49）。
 */
export const PERSON_IMPORT_ROW_FIELDS = [
  'id',
  'batch_id',
  'source',
  'source_person_id',
  'status',
  'imported_by',
  'imported_at',
  'reviewed_at',
  'reviewer_id',
  'review_note'
]

/**
 * **导入行归一化载荷字段（§4.1.16「归一化载荷」；同 feicui 侧归一化面）**。
 *   - 姓 / 名 / 字 / 号 / 别名：文本 / **数组**（沿 §4.1.14 提交面同形）；
 *   - 生卒：**公元整数**（「不详」＝`null`，不设特值）；
 *   - `native_place`（＋`_chs`）/ `biography`（＋`_chs`）：**繁体为正、简体入 `*_chs`**；
 *   - `nationality` / `name_full`：**只落导入行、不落 person**（除非人类另裁）；
 *   - `source` / `source_id`：元数据；行级另有同名字段（本处为载荷面副本）。
 *   - **v1.57（§3.54.19）**：`courtesy_names_extraction` / `art_names_extraction` /
 *     `alias_names_extraction` —— 各 `string[]`、与对应值数组**等长**、元素为**非空字符串**、
 *     **值域不封闭**（今日恒 `rule-based`）；**加性、可选、不破坏**（缺键不拒收）；
 *     **只落导入行、采纳不落 person 行**。载荷字段 **15 → 18**。
 */
export const PERSON_IMPORT_PAYLOAD_FIELDS = [
  'name_full',
  'family_name',
  'given_name',
  'courtesy_names',
  'courtesy_names_extraction',
  'art_names',
  'art_names_extraction',
  'alias_names',
  'alias_names_extraction',
  'birth_year',
  'death_year',
  'native_place',
  'native_place_chs',
  'biography',
  'biography_chs',
  'nationality',
  'cbdb_id',
  'source_id'
]

/**
 * **导入行字段真源（全集；恰一处定义点）** ＝ 行级元数据 ＋ 归一化载荷。
 * **不得在别处另立第二套同义字段**（沿「真值函数是唯一尺子」精神）。
 */
export const PERSON_IMPORT_FIELDS = [...PERSON_IMPORT_ROW_FIELDS, ...PERSON_IMPORT_PAYLOAD_FIELDS]

/**
 * 导入一行「值的默认」：数组键 ⇒ `[]`；生卒 ⇒ `null`；其余 ⇒ `''`（缺省一律空、不设特值）。
 * @returns {object} 空导入载荷面（**不含 `id` / `status` / 身份 / 时间戳** —— 那些由导入 / 采纳路径系统写）
 */
export function emptyPersonImportPayload() {
  const out = {}
  const arrayKeys = ['courtesy_names', 'courtesy_names_extraction', 'art_names', 'art_names_extraction', 'alias_names', 'alias_names_extraction']
  const nullKeys = ['birth_year', 'death_year']
  PERSON_IMPORT_PAYLOAD_FIELDS.forEach((key) => {
    if (arrayKeys.includes(key)) out[key] = []
    else if (nullKeys.includes(key)) out[key] = null
    else out[key] = ''
  })
  return out
}

/* ============================================================================
   **印章批 3 前置增量：印章外部批量導入通道（v1.55｜§3.55 ＋ §4.1.17）**
   ----------------------------------------------------------------------------
   外部批量導入先落暫存集合 `xiai_seal_imports` 的 `PENDING` 行；管理員採納
   （`PENDING → ACCEPTED`）⇒ **整條**冪等落 `xiai_seals`（印章級）＋ `xiai_faces`（印面級，
   含邊款 `kind=EDGE`），且**同置** `review_status='APPROVED'`（按 `source` ＋ `source_seal_id`
   冪等；重複採納**不改寫既有行**）；`REJECTED` ⇒ **零寫入**。本集合**單寫者**
   （不開放任何直寫入口，含管理員直寫）。
   **本常量區只落「集合名 / 字段真源 / 三態枚舉 / 鍵前綴」**；讀寫、冪等鍵、直寫門在
   `data/db.js`；雲側讀面在 `data/cloudbase.js`；寫通道在 `services/seals.js` ＋ 雲函數。
   本增量**零新增 `reason` 字面值**（值域 / 形態校驗一律沿用既有凍結表）；
   `[data-admin-action]` **不新增**（與印人導入區塊共用同一鈎子值；見 §3.55.8）。
   印章級 / 印面級字段**逐字沿用既有 `xiai_seals` / `xiai_faces` 口徑，不另立第二套**。
   ============================================================================ */

/** 印章外部批量導入暫存集合名（`xiai_` 前綴；逐字，雲控制台新建的集合須與此逐字一致）。 */
export const XIAI_SEAL_IMPORTS_COLLECTION = 'xiai_seal_imports'

/** 印章導入行文檔鍵前綴（確定性 / 可讀）。 */
export const SEAL_IMPORT_ID_PREFIX = 'si-'

/** 印章導入行三態（**恰三態、單向、終態不回退**；與提案 / 印人導入三態逐字同形）。 */
export const SEAL_IMPORT_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED'
}

/**
 * **導入行行級元數據字段（§3.55.3 / §4.1.17）**：行主鍵 / 批次 / 來源 / 冪等鍵 / 狀態 /
 * 導入與審核留痕 / 內容指紋（軟提示）。身份類鍵（`imported_by` / `reviewer_id`）
 * **一律落不透明 uid、零手機號**（沿 §3.49）。
 */
export const SEAL_IMPORT_ROW_FIELDS = [
  'id',
  'batch_id',
  'source',
  'source_seal_id',
  'status',
  'imported_by',
  'imported_at',
  'reviewed_at',
  'reviewer_id',
  'review_note',
  /* **內容指紋（軟提示）**：印章級標識字段的規範化串雜湊；**只作「疑似重複」軟提示**，
     **不構成拒收理由**（明文：指紋不構成拒收理由；沿 §3.55.5）。 */
  'content_fingerprint'
]

/**
 * **導入行印章級字段（逐字沿既有 `xiai_seals` 口徑；不另立第二套字段名 / 第二套枚舉）**。
 * 即既有印章實體會寫的鍵面（`SEAL_INSERT_INPUT_FIELDS` 的規範名 ＋ `transcription`）
 * —— 落正式行时由採納路徑按同名字段映射（沿 §4.1.2 / §4.3）。
 * **【印面風格】`face_style` /【大類】`seal_class` / 作者引用 `author_person_id` 屬
 * **印面級**（canonical 真源在印面行，見 §4.3 表下注 v1.50 / §3.54.7）⇒ 只在 `faces[]` 面，
 * **不在印章級**（不得在印章行存鏡像 ⇒ 避免雙寫漂移）。
 */
export const SEAL_IMPORT_SEAL_FIELDS = [
  'seal_name',
  'dynasty',
  'seal_type',
  'seal_style',
  'material',
  'shape',
  'author',
  'transcription'
]

/**
 * **導入行印面級字段（每印面；含影像鍵 / 摘要引用）** —— `kind` ∈ `FACE_KIND`
 * （`FACE` / `EDGE`；**邊款 `kind=EDGE` 須在列，不得排除**）。
 * 影像二進制**不在此面**（只存鍵 / 摘要引用；沿 §3.55.6 影像先行）。
 */
export const SEAL_IMPORT_FACE_FIELDS = [
  'kind',
  'seal_name',
  'dynasty',
  'seal_type',
  'face_style',
  'seal_class',
  'author',
  'author_person_id',
  'transcription',
  'image_storage_key',
  'image_sha256',
  'image_bytes',
  'image_mime'
]

/** 影像引用鍵面（每印面；**（鍵 / 摘要）二元組** —— 導入行只存引用、不存二進制）。 */
export const SEAL_IMPORT_IMAGE_REF_FIELDS = ['image_storage_key', 'image_sha256', 'image_bytes', 'image_mime']

/**
 * **導入行字段真源（全集；恰一處定義點）** ＝ 行級元數據 ＋ 印章級 ＋ 印面數組 `faces`。
 * **不得在別處另立第二套同義字段**（沿「真值函數是唯一尺子」精神）。
 */
export const SEAL_IMPORT_FIELDS = [...SEAL_IMPORT_ROW_FIELDS, ...SEAL_IMPORT_SEAL_FIELDS, 'faces']

/**
 * 導入行「值的默認」（印章級）：**一律空串**（缺省不設特值）。
 * @returns {object} 空印章級字段面（**不含 `id` / `status` / 身份 / 時間戳**）
 */
export function emptySealImportFields() {
  const out = {}
  SEAL_IMPORT_SEAL_FIELDS.forEach((key) => {
    out[key] = ''
  })
  return out
}

/**
 * 導入行「單印面值的默認」：`kind` 默認 `FACE`、`image_bytes` 默認 `0`、其餘空串。
 * @returns {object} 空印面字段面
 */
export function emptySealImportFace() {
  const out = {}
  SEAL_IMPORT_FACE_FIELDS.forEach((key) => {
    if (key === 'kind') out[key] = FACE_KIND.FACE
    else if (key === 'image_bytes') out[key] = 0
    else out[key] = ''
  })
  return out
}

/**
 * **導入行內容指紋（純函數；§3.55.5 軟提示用）**：印章級標識字段的**規範化串雜湊**
 * （逐字段 `trim` 後以 `\u0001` 連接、取 `sha256`）。
 * **只作「疑似重複」軟提示、交管理員裁；明文：指紋不構成拒收理由**（沿 §3.55.5）。
 * @param {object} fields 印章級字段面（導入行 / 正式印章行均可）
 * @returns {string} 64 位小寫十六進制指紋
 */
export function sealImportFingerprint(fields) {
  const src = fields && typeof fields === 'object' ? fields : {}
  const normalized = SEAL_IMPORT_SEAL_FIELDS.map((key) =>
    String(src[key] === undefined || src[key] === null ? '' : src[key]).trim()
  ).join('\u0001')
  return sha256Hex(normalized)
}
