'use strict'
/**
 * 玺爱 · 用户写面 · **权威落盘**（写面 Phase A ＋ 本单新增「採信」）
 * ----------------------------------------------------------------------------
 * 本文件是**本函数唯一的持久化路径**（静态扫描判据：`collection(` 只在本文件出现，
 * 且集合名一律 `^xiai_` ⇒ **绝不碰 liwu 集合**）。
 *
 * 硬口径（逐条）：
 *   ① **创建者身份以服务端为准** ✗ 不采信前端自称：`identity` 由 `index.js` 从**令牌声明**派生
 *      （`uid = uidOf(sub)`、`phone = sub`），载荷里的任何身份类键一律 ⇒ `INVALID_FIELD` ＋ 零写入；
 *      **落盘行只落不透明 uid（`u-`＋sha256 前 16 位），不落手机号**（人类口径 ①②）。
 *   ② **判定全部在写之前**（缺字段 / 值域 / 字段面任一不过 ⇒ 返回拒绝，**不触库写**）；
 *   ③ **落库用管理端凭据**（`@cloudbase/node-sdk` 在函数运行环境内取凭据，**不入仓、不下发前端**）；
 *      `xiai_corrections` / `xiai_endorsements` 的 ACL 是 `PRIVATE` ⇒ **只能这样写**，前端直连 SDK 写必被拒；
 *   ④ **本文件不写任何密钥 / 手机号字面值**；`row` 里只落**派生结果**（uid / 手机号）。
 *
 * 本单（採信）追加的冻结机制：
 *   · **采信目标键 ＝ `(faceId, field, value)`**（严格防重 ⇒ 同值恒指同一条提交；按值精确字符串
 *     比较，**不做任何归一**：异体 / 标点差异都算不同的一段文字）；
 *   · **提交侧防重**：`submitCorrection` 在**任何写入之前**检查同 `(faceId, field, value)` 是否已有行
 *     （含云端：以服务端为准）⇒ 已有 ⇒ `DUPLICATE_VALUE` ＋ 零写入；
 *   · **新 op `endorseCorrection`**：幂等（同 `(faceId, field, value, user_id)` ⇒ `ALREADY_ENDORSED`
 *     ＋ 零写入）、**不得自采**（同值的提交人就是本人 ⇒ 拒）、成功时**两处落盘**
 *     （采信行 `xiai_endorsements`［私有］＋ 值级公开摘要行 `xiai_correction_summaries`［脱敏］）；
 *     计数由服务端**重算**并幂等 upsert（自愈：重试 / 重放不涨数）。
 *   · **值级公开摘要行（本单合并面）**：`{ faceId, sealId, stamp_id, field, value, submits,
 *     endorses, status, submitter_uids, updated_at, schema }` —— **零手机号**、uid 允许；
 *     `submits` ＝ 未 REJECTED 的提交行**去重人数**、`endorses` ＝ 采信行**去重人数**、
 *     `status` ＝ 该值当前状态、`submitter_uids` ＝提交人 uid 去重列表（**不带昵称 / 手机号**）。
 *     `submitCorrection` / `endorseCorrection` / `reviewCorrection` **成功后一律重算并 upsert**
 *     该 `(faceId, field, value)` 的摘要行（幂等：重读 / 重放不涨数）。
 *   · **公开摘要面零手机号**：`xi` 一律不下发 `user_phone`（本文件构造的摘要行里根本没有；
 *     只有不透明 uid 列表）。
 */

const crypto = require('crypto')
const { REASONS, ENV_NAMES, deny, normalizePhone, isPhoneLike, uidOf } = require('./config.js')
/* **识别编码（sid / fid）纯函数单点**：`lib/codeId.js` 与前端 `src/utils/codeId.js`
   **逐字节相同**（`scripts/verify-code-id.mjs` 机械断言）；本文件只经它编 / 解码，不自写第二套。 */
const codeId = require('./codeId.js')
/* 展示件轉碼器（本單新增；純 JS 零新依賴 —— node:zlib ＋ 自寫 CRC32）。 */
const { tiffToPng } = require('./tiffToPng.js')
/* **V6-a**：调用者**平台会话身份**判权（additive）。`IDENTITY_SOURCES` 是身份来源标记的
   **单一定义点**（既有令牌路取值 `SERVER_TOKEN` 逐字沿用；会话路为 `SESSION`）。 */
const { IDENTITY_SOURCES, ROLE, isSessionIdentity, identitySourceOf, identityUsable, setAuthApiChannelProvider } = require('./sessionAuthority.js')
/* **本单改造（斐萃令牌）**：HMAC 自包含令牌的**纯函数面**（签/验 / kid 轮换 / 吊销判定；
   零 SDK、零 IO、零时钟隐依赖；密钥只从 env 读，缺即 fail-closed）。 */
const feicuiToken = require('./feicuiToken.js')
/* **積分賬本（「金」上雲｜本單）**：唯一賬本實現點在 `lib/ledger.js`
   （余额读取 / 扣费 / 退款 / 发奖 / 流水清单 / 初始幂等发放六件事单点落地）。
   本文件只做两件事：① 经 `resolveLedgerStore()` 给它供**生产集合句柄**（`collection(`
   字面仍只在本文件 ⇒ 静态门 A8 / A8b / D4 照旧成立）；② 在 `OPS` 注册两个**客户端可调**的
   只读 op（`getPointsBalance` / `listPointsFlow`，走既有登录令牌门）。本文件**不写第二套账本**。 */
const ledger = require('./ledger.js')
/* **AI 金鑰 / 上游 / 用量（本單）**：三件实现单点在 `lib/aiKeys.js` / `lib/aiUpstream.js` /
   `lib/aiUsage.js`。本文件只做三件事：① 经 `resolveAiStore()` 给它们供**生产集合句柄**
   （`collection(` 字面仍只在本文件 ⇒ 静态门 A8 / A8b / D4 / D1U / D1A 照旧成立）；② 在 `OPS`
   注册 5 个**客户端可调**的 op（`issueAiKey` / `listAiKeys` / `revokeAiKey` / `updateAiKeyLimits`
   / `getAiUsage`，走既有登录令牌门）；③ 在 `ADMIN_OPS` 注册 2 个**管理员** op
   （`getAiUpstream` / `setAiUpstream`，走既有管理員門 `adminWhitelistDenial`）。
   本文件**不写第二套** AI 金鑰 / 上游 / 用量逻辑。 */
const aiKeys = require('./aiKeys.js')
const aiUpstream = require('./aiUpstream.js')
const aiUsage = require('./aiUsage.js')

/* ---------------------------------------------------------------------------
   **V6-a 探测（additive）**：`sessionProbe` 的诊断通道读取器 —— **本单修正**：自两 `index.js` **迁回本文件**
   （`lib/ops.js`），使 `index.js` 保持**零 SDK 字面**、**恢复 C3 / C6 / A15 三条静态门**；
   探针语义与两 `sessionAuthority.js` 副本逐字节同不变。本文件因此＝两个写面函数**唯一的 SDK 落点**。
   口径：**延迟 require ＋ 懒解析**（离线 / 无 SDK ⇒ 通道为 null ⇒ 探针三读数零值回显；解析只发生一次、
   且只在探针被调时发生）；通道在探针内**只读**使用（`getAuthContext` 只解析 context 形状与环境注入、
   零网络零写入）、**绝不参与任何判权路径**；任何失败都被探针的 try/catch 与 3s 超时护栏兜住 ⇒ 不影响写面主路。
   --------------------------------------------------------------------------- */

let authApiChannelResolved = false
let authApiChannel = null

/** 会话探针的诊断通道读取器（**同步**返回 `channel | null`；懒解析、只解析一次；抛错由探针侧兜零值）。 */
function resolveAuthApiChannel() {
  if (!authApiChannelResolved) {
    authApiChannelResolved = true
    try {
      const tcb = require('@cloudbase/node-sdk')
      const envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE || process.env.CLOUDBASE_ENV_ID || ''
      authApiChannel = (envId ? tcb.init({ env: envId }) : tcb.init()).auth()
    } catch {
      authApiChannel = null
    }
  }
  return authApiChannel
}

setAuthApiChannelProvider(resolveAuthApiChannel)

/**
 * 集合白名单（封闭；**一律 `xiai_` 前缀**）。
 * 映射真源 ＝ `src/data/storage.js` 的 `STORAGE_KEYS`（＋ `xiai_` 前缀）。
 *   · `corrections`        ＝ 勘误私有行（既有）；
 *   · `endorsements`       ＝ **采信私有行**（既有；含 user_id［不透明 uid］⇒ PRIVATE；**不落 user_phone**）；
 *   · `correctionSummaries`＝ **值级公开脱敏摘要行**（本单**合并**面；含 `submits` / `endorses` /
 *     `status` / `submitter_uids`；**零手机号**、uid 允许、匿名可读 ⇒ 「未采纳提交的公开摘要面」，
 *     让【採信】**跨浏览器 / 跨用户**成立。取代此前尚未上线的 `xiai_endorsement_counts`，
 *     **不留两套公开面**）；
 *   · `correctionsPublic`  ＝ **公开只读脱敏投影集合**（V3；＝ 已采纳勘误的跨浏览器投影，
 *     `_id='cp-<勘误单号>'`、键面封闭、**零身份字段**）。
 */
const COLLECTIONS = Object.freeze({
  corrections: 'xiai_corrections',
  endorsements: 'xiai_endorsements',
  correctionSummaries: 'xiai_correction_summaries',
  correctionsPublic: 'xiai_corrections_public',
  /* **V6-a 新增**：平台会话身份 → 角色（服务器私有；判权读点，见 `readRoleRow`）。 */
  roles: 'xiai_roles',
  /* **印人（person-model §2 / §3）**：正式印人（canonical；**只经采纳路径写**）＋ 提案 / 审核行。 */
  persons: 'xiai_persons',
  personProposals: 'xiai_person_proposals',
  /* **印人批 2 前置（v1.54｜§3.54.14 / §4.1.16）**：外部批量导入暂存 / PENDING 集合
     （单写者；只经外部导入通道与采纳路径写；不开放任何直写入口）。 */
  personImports: 'xiai_person_imports',
  /* **印章批 3（v1.55｜§3.55 ＋ §4.1.17）**：印章外部批量導入暫存集合（單寫者；只經外部導入
     通道與採納路徑寫；不開放任何直寫入口），以及**既有正式落點** `seals` / `faces`（採納整條落）
     與影像讀面 `images`（採納時逐條校驗引用對象存在）。 */
  sealImports: 'xiai_seal_imports',
  seals: 'xiai_seals',
  faces: 'xiai_faces',
  images: 'xiai_images',
  /* **item 通道切片 A（v1.61）**：正式印谱（`xiai_items`，canonical；**只经采纳路径写**）
     与印谱外部批量導入暂存 / PENDING 集合（`xiai_item_imports`；单写者）。
     本机镜像键见 `src/data/db.js` 的 `items` / `item-imports`。 */
  items: 'xiai_items',
  itemImports: 'xiai_item_imports'
})

/**
 * 可勘误字段表（键 → 上屏顯示名）。
 * **真源 ＝ `src/services/corrections.js::MARKABLE_FIELDS`**；本表是**服务端副本**
 * （服务端要自己填 `field_label`，不能采信客户端给的显示名）。
 * ⇒ 该「同值」由 `scripts/verify-userwrite-pa.mjs` 的 `D2` **机械断言**（两表逐字相等），
 *   新增字段时两处必须同改，否则断言立即失败（**不让副本静默漂移**）。
 */
const MARKABLE_FIELDS = Object.freeze({
  seal_name: '印文',
  dynasty: '朝代',
  seal_type: '印面內容',
  face_style: '印面風格',
  seal_class: '大類',
  author: '作者',
  transcription: '印文釋義'
})

/** 勘误提交载荷允许键（**固定属性 / 身份类键都不在其中**）。 */
const ALLOWED_KEYS = Object.freeze([
  'faceId',
  'sealId',
  'stampId',
  'field',
  'value',
  'basis',
  /* **识别编码四键（口径件 §3｜本单登记）**：`seal_no` / `sid` / `face_no` / `fid` 由**服务端先落盘**
     （计数器发号 ＋ 按 `no` 重算），**前端后发**；登记进封闭面只是为了让「服务端已产出的回显键」
     不被 `INVALID_FIELD` 误伤 —— 本 op **不读不写**它们（落盘行由服务端自己构造，载荷值一律不采信）。 */
  'seal_no',
  'sid',
  'face_no',
  'fid'
])

/** 采信载荷允许键（**封闭键面**：`['faceId','sealId','stampId','field','value']`；身份类键一律拒）。 */
const ENDORSE_ALLOWED_KEYS = Object.freeze(['faceId', 'sealId', 'stampId', 'field', 'value'])

/** 印人提案载荷允许键（**封闭键面**；身份类键一律拒 —— 提交人由服务端派生）。
 *  **批 2（v1.54｜§3.54.13 / §4.1.16）**：`native_place` / `biography` / `source` / `source_id`
 *  （四扩字段）＋ `native_place_chs` / `biography_chs`（两繁简副字段）—— 12 键扩为 **18 键**，
 *  与 `src/services/persons.js::submitPersonProposal` 的载荷键面**逐字同集**。 */
const PERSON_PROPOSAL_ALLOWED_KEYS = Object.freeze([
  'batch_id',
  'target_person_id',
  'family_name',
  'given_name',
  'courtesy_names',
  'art_names',
  'alias_names',
  'birth_year',
  'death_year',
  'cbdb_id',
  'card_id',
  'native_place',
  'biography',
  'source',
  'source_id',
  'native_place_chs',
  'biography_chs',
  'note'
])

/** 印人提案审核载荷允许键（**封闭键面**：单号 / 决定 / 理由）。 */
const PERSON_REVIEW_ALLOWED_KEYS = Object.freeze(['proposal_id', 'decision', 'note'])

/* **印人批 2 前置（v1.54｜§3.54.14 / §3.54.15）**：外部批量导入通道 ＋ 管理员批量采纳通道。 */

/** 外部导入行三态（与 `src/services/persons.js::PERSON_IMPORT_STATUS` 逐字同值）。 */
const PERSON_IMPORT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED'
})

/** 外部导入行文档键前缀（确定性 / 可读；与前端 `pi-` 同族）。 */
const PERSON_IMPORT_ID_PREFIX = 'pi-'

/** 外部导入提交载荷允许键（**封闭键面**；身份类键一律拒 —— 导入人由服务端派生）。
 *  **v1.57（§3.54.19 / §4.1.16 追加注）**：归一化载荷加性扩 3 个 extraction 键
 *  （`courtesy_names_extraction` / `art_names_extraction` / `alias_names_extraction`）——
 *  与 `src/data/seed.js::PERSON_IMPORT_PAYLOAD_FIELDS` / `src/services/persons.js` 逐字同集；
 *  封闭键面 **18 → 21**；缺键不拒收（旧 18 键形态仍被接受；仅提供时校验形态）。 */
const PERSON_IMPORT_ALLOWED_KEYS = Object.freeze([
  'batch_id',
  'source',
  'source_person_id',
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
])

/** 外部导入审核载荷允许键（**封闭键面**：批次 / 单行 / 决定 / 理由）。 */
const PERSON_IMPORT_REVIEW_ALLOWED_KEYS = Object.freeze(['batch_id', 'import_id', 'decision', 'note'])

/* **印章批 3（v1.55｜§3.55 ＋ §4.1.17）**：印章外部批量導入通道 ＋ 管理員採納通道。
   与 `src/data/seed.js` / `src/services/seals.js` 的冻结面**逐字同值**。 */

/** 印章導入行三态（与 `src/services/seals.js::SEAL_IMPORT_STATUS_EXPORT` / `seed.js::SEAL_IMPORT_STATUS` 逐字同值）。 */
const SEAL_IMPORT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED'
})

/** 印章導入行文档键前缀（确定性 / 可读；与前端 `si-` 同族）。 */
const SEAL_IMPORT_ID_PREFIX = 'si-'

/** 印章编号前缀（与 `src/data/db.js::SEAL_STAMP_ID_PREFIX` 逐字同值）。 */
const SEAL_STAMP_ID_PREFIX = 'XA'

/** 印章導入行**印章級字段面**（逐字沿 `src/data/seed.js::SEAL_IMPORT_SEAL_FIELDS`；不另立第二套）。 */
const SEAL_IMPORT_SEAL_FIELDS = Object.freeze([
  'seal_name',
  'dynasty',
  'seal_type',
  'seal_style',
  'material',
  'shape',
  'author',
  'transcription'
])

/** 印章導入行**印面級字段面**（每印面；含影像引用键 / 摘要；边款 `kind=EDGE` 须在列）。 */
const SEAL_IMPORT_FACE_FIELDS = Object.freeze([
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
  'image_mime',
  /* **影面新增鍵**：`image_source_kind`（`yt` / `ytsw` / `yzbk`；**值域不封閉**、原样收）。 */
  'image_source_kind'
])

/* **印章導入行：源側擴面（51 鍵）** —— 与 `src/data/seed.js::SEAL_IMPORT_SOURCE_FIELDS`
   **逐字同值**（不另立第二套）。`raw_json` 不在此面（**只落導入行**）。 */
const SEAL_IMPORT_SOURCE_FIELDS = Object.freeze([
  'source_seal_id',
  'seal_uri',
  'category',
  'seal_wen',
  'seal_wen_chs',
  'seal_wen_pinyin',
  'seal_wen_wzly',
  'seal_wen_wzly_chs',
  'seal_wen_yssw',
  'seal_wen_yssw_chs',
  'seal_wen_wyz',
  'seal_wen_zjsw',
  'seal_wen_zjsw_chs',
  'seal_ys_xz',
  'seal_ys_label',
  'seal_ys_kf',
  'seal_ys_st',
  'seal_zyz',
  'seal_yz',
  'seal_yz_person_name',
  'seal_yz_person_name_chs',
  'seal_yz_name',
  'seal_yz_ref_id',
  'seal_yzzkz',
  'seal_yzzkz_chs',
  'seal_yzzkz_id',
  'seal_bk',
  'seal_bk_chs',
  'seal_bkzkz',
  'seal_bkzkz_chs',
  'seal_bkzkz_id',
  'as_book_id',
  'related_book',
  'seal_yt_url',
  'seal_ytsw_url',
  'seal_yzbk_url',
  'seal_yzqt_url',
  'seal_threed_url',
  'seal_title',
  'seal_title_chs',
  'seal_org',
  'seal_org_name',
  'seal_cz',
  'seal_cc',
  'seal_ly',
  'seal_yn',
  'seal_yksj_lsjn',
  'seal_yksj_lsjn_chs',
  'seal_yksj_gyjn',
  'audit_status',
  'misc'
])

/** 源側擴面中整數或 `null` 的字段（**不得 `0` / 空串等特值**；与 `seed.js` 同值）。 */
const SEAL_IMPORT_SOURCE_INT_FIELDS = Object.freeze(['seal_ys_xz'])
/** 源側擴面中對象（或 `null`）的字段（**原样落**；与 `seed.js` 同值）。 */
const SEAL_IMPORT_SOURCE_OBJECT_FIELDS = Object.freeze(['misc'])
/** 源側擴面中原样收的字段（字符串或數字；**不得据它过滤、不得归一**；与 `seed.js` 同值）。 */
const SEAL_IMPORT_SOURCE_RAW_FIELDS = Object.freeze(['audit_status'])

/** 印章級鍵面（全集）＝ 既有 8 鍵 ＋ 源側擴面 51 鍵（恰 59 鍵）。 */
const SEAL_IMPORT_SEAL_LEVEL_FIELDS = Object.freeze([...SEAL_IMPORT_SEAL_FIELDS, ...SEAL_IMPORT_SOURCE_FIELDS])

/** 指紋面 ＝ 印章級鍵面**減行級冪等鍵** `source_seal_id`（恰 58 鍵；与 `seed.js` 同值）。 */
const SEAL_IMPORT_FINGERPRINT_FIELDS = Object.freeze(
  SEAL_IMPORT_SEAL_LEVEL_FIELDS.filter((key) => key !== 'source_seal_id')
)

/** 印章导入提交载荷允许键（**封闭键面**；身份类键一律拒 —— 导入人由服务端派生）。 */
const SEAL_IMPORT_ALLOWED_KEYS = Object.freeze([
  'batch_id',
  'source',
  /* `raw_json` **只落導入行**（正式集合不帶）；`source_seal_id` 由源側擴面帶入（冪等鍵）。 */
  'raw_json',
  ...SEAL_IMPORT_SEAL_FIELDS,
  ...SEAL_IMPORT_SOURCE_FIELDS,
  'faces',
  /* **行級缺圖標記** `image_status`（值域恰二值 `present` / `source_no_image`；缺省 ⇒ `present`）：
     源側**無圖**之印章以 `source_no_image` 落行（`faces[]` 允許為空，保住文本本體）。 */
  'image_status'
])

/** 導入行行級鍵 `image_status` 的值域（恰二值；与 `seed.js::SEAL_IMPORT_IMAGE_STATUS` 逐字同值）。 */
const SEAL_IMPORT_IMAGE_STATUS = Object.freeze({
  PRESENT: 'present',
  SOURCE_NO_IMAGE: 'source_no_image'
})

/**
 * **占位圖（影像例外｜僅 feicui/sealbank 來源可引用）** —— 与
 * `src/data/seed.js::SEAL_PLACEHOLDER_IMAGE_KEY` / `SEAL_PLACEHOLDER_IMAGE` **逐字同值**
 * （云函数独立部署、不能 import 前端源；两处任一改动必须同时改，`scripts/verify-seal-placeholder.mjs`
 * 会断言两侧同值）。
 *
 * 为什么需要：sealbank（真微印網）書版索引 5,529 條源側無圖。走 `source_no_image ＋ faces=[]` ⇒
 * **印面行不存在**；占位圖模式讓 faces[0] 指向同一張已登記的公共佔位圖，保住「一個印面」。
 *
 * 硬口徑：
 *   · **僅 sealbank 家族來源**（`isSealBankSource`：來源標籤含 `sealbank`）可引用本鍵；其餘來源 ⇒ 拒
 *     （提交門 `submitSealImport` 與採納門 `buildSealAcceptanceFromImport` **各判一次**）；
 *   · 本鍵**不是**內容尋址鍵（不符 `^xiai/images/<hh>/<sha>.png|webp$`）⇒ 客戶端 `cloudBaseObjectKeyOf`
 *     對它回空串；**不得**為此放寬通用判據（通用影像行的內容尋址校驗一字不改）；
 *   · 登記行的 `sha256` 必須 ≡ 下表（採納時按面校驗：佔位鍵 ＋ 摘要不符 ⇒ 拒，防「同名換圖」）。
 */
const SEAL_PLACEHOLDER_IMAGE_KEY = 'placeholder/seal-no-image'

const SEAL_PLACEHOLDER_IMAGE = Object.freeze({
  key: SEAL_PLACEHOLDER_IMAGE_KEY,
  id: 'img-placeholder-seal-no-image',
  sha256: '18d94039af1b1d4289b60fb6ef527323e05bc739b41229081c94702407de329c',
  bytes: 23357,
  mime: 'image/jpeg',
  width: 512,
  height: 512,
  storage: 'bundled',
  source_scope: 'sealbank'
})

/** 來源標籤是否屬 sealbank（feicui）家族 —— 佔位圖例外的**唯一**判據（与 seed.js 同判）。 */
function isSealBankSource(source) {
  return /sealbank/i.test(text(source))
}

/**
 * 佔位圖引用**來源門**：任一印面 `image_storage_key === 佔位鍵` 且來源非 sealbank ⇒ 違規。
 * @returns {null|string} 違規 ⇒ 可讀拒因；合規 / 無佔位引用 ⇒ `null`
 */
function sealPlaceholderRefDenial(source, faces) {
  const list = Array.isArray(faces) ? faces : []
  const hit = list.some((face) => text(face && face.image_storage_key) === SEAL_PLACEHOLDER_IMAGE_KEY)
  if (!hit) return null
  if (isSealBankSource(source)) return null
  return `佔位圖（${SEAL_PLACEHOLDER_IMAGE_KEY}）僅限 sealbank（feicui）來源的導入行引用；本次零寫入。`
}

/**
 * 佔位圖引用**摘要門**（採納時）：指向佔位鍵者，其 `image_sha256`（若宣告）必須 ≡ 登記摘要；
 * 解析到的影像行也必須是登記行（同鍵同摘要）。防「佔位鍵 + 換圖」與「佔位鍵 + 空摘要」混用。
 * @returns {null|string}
 */
function sealPlaceholderDigestDenial(face, image) {
  if (text(face && face.image_storage_key) !== SEAL_PLACEHOLDER_IMAGE_KEY) return null
  const declared = text(face && face.image_sha256)
  if (declared && declared !== SEAL_PLACEHOLDER_IMAGE.sha256) {
    return `佔位圖摘要不符（宣告 ${declared} ≠ 登記 ${SEAL_PLACEHOLDER_IMAGE.sha256}）⇒ 拒絕採納；本次零寫入。`
  }
  const rowSha = text(image && image.sha256)
  if (rowSha && rowSha !== SEAL_PLACEHOLDER_IMAGE.sha256) {
    return `影像行的摘要與佔位圖登記值不符（${rowSha}）⇒ 拒絕採納；本次零寫入。`
  }
  return null
}

/** 印章导入审核载荷允许键（**封闭键面**：批次 / 单行 / 决定 / 理由）。 */
const SEAL_IMPORT_REVIEW_ALLOWED_KEYS = Object.freeze(['batch_id', 'import_id', 'decision', 'note'])

/* **item 通道切片 A（v1.61）**：印谱外部批量導入通道 ＋ 管理員採納通道。
   与 `src/data/seed.js` / `src/services/items.js` 的冻结面**逐字同值**。 */

/** 印谱導入行三态（与 `src/data/seed.js::ITEM_IMPORT_STATUS` 逐字同值）。 */
const ITEM_IMPORT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED'
})

/** 印谱導入行文档键前缀（确定性 / 可读；与前端 `ii-` 同族）。 */
const ITEM_IMPORT_ID_PREFIX = 'ii-'

/** `misc` 子對象的 5 鍵（与 `src/data/seed.js::ITEM_MISC_FIELDS` 逐字同值）。 */
const ITEM_MISC_FIELDS = Object.freeze(['bookZzxs', 'bookCj', 'bookSk', 'bookSz', 'bookPsqk'])

/** 源側「無紀年」佔位字面（歸一 ⇒ `null`；与 `seed.js::ITEM_DATE_PLACEHOLDER` 同值）。 */
const ITEM_DATE_PLACEHOLDER = 'N.D.'

/** 整數或 `null` 的字段（**不得 `0` / 空串等特值**）。 */
const ITEM_BODY_INT_FIELDS = Object.freeze(['volume_count', 'date_year'])

/** 布爾字段（形態門：**布爾或 `null`**；`null` ＝ 源側未知 ⇒ 放行、不拒收、不落 `false`；其它非布爾 ⇒ `INVALID_VALUE` ＋ 零寫入）。 */
const ITEM_BODY_BOOL_FIELDS = Object.freeze(['has_image', 'has_annotation'])

/**
 * 印谱本體 22 字段（与 `src/data/seed.js::ITEM_BODY_FIELDS` **逐字同值**；不另立第二套）。
 * `raw_json` **不在此列**（只存導入行）。
 */
const ITEM_BODY_FIELDS = Object.freeze([
  'source_item_id',
  'as_book_id',
  'as_id',
  'book_uri',
  'category',
  'title',
  'title_chs',
  'title_other',
  'title_other_chs',
  'volume_count',
  'date_text',
  'date_year',
  'publisher',
  'abstract',
  'abstract_chs',
  'abstract_title',
  'edition',
  'donor',
  'has_image',
  'has_annotation',
  'language',
  'misc'
])

/** 印谱导入提交载荷允许键（**封闭键面**；身份类键一律拒 —— 导入人由服务端派生）。 */
const ITEM_IMPORT_ALLOWED_KEYS = Object.freeze(['batch_id', 'source', 'raw_json', ...ITEM_BODY_FIELDS])

/** 印谱导入审核载荷允许键（**封闭键面**：批次 / 单行 / 决定 / 理由）。 */
const ITEM_IMPORT_REVIEW_ALLOWED_KEYS = Object.freeze(['batch_id', 'import_id', 'decision', 'note'])

/** 印人提案三态（与 `src/services/persons.js::PERSON_STATUS` 逐字同值）。 */
const PERSON_PROPOSAL_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED'
})

/** 印人提案文档键前缀（确定性 / 可读；与前端 `pp-` 同族）。 */
const PERSON_PROPOSAL_ID_PREFIX = 'pp-'

/** 印人编号前缀（与 `src/data/seed.js::PERSON_CODE_PREFIX` 逐字同值）。 */
const PERSON_CODE_PREFIX = 'PR'

/**
 * 明令不可由载荷提供的业务键（防御性登记 ⇒ 报告里可逐字列出；不在 `ALLOWED_KEYS` 里即已拒绝，
 * 本表用于**把「身份类键」与「普通未知键」在文案上分开**，便于排障与取证）。
 */
const IDENTITY_KEYS = Object.freeze([
  'userId',
  'user_id',
  'user_phone',
  'uid',
  'phone',
  'role',
  'status',
  'created_at',
  'reviewer_id',
  'rewarded_at'
])

/** 自由文本上限（防无界写入；超限 ⇒ `INVALID_VALUE`）。 */
const MAX_TEXT_LENGTH = 500

/** 勘误初态（与 `src/services/corrections.js::CORRECTION_STATUS.PENDING` 逐字同值）。 */
const CORRECTION_PENDING = 'PENDING'

/** 值级公开摘要行的 schema 版本（与 `src/services/corrections.js::CORRECTION_SUMMARY_SCHEMA` 逐字同值）。 */
const CORRECTION_SUMMARY_SCHEMA = 'xiai-correction-summaries-v1'

/** 采信行身份来源标记（取证用：本行的身份来自服务端令牌，不由前端自称）。 */
const ENDORSEMENT_IDENTITY_SOURCE = IDENTITY_SOURCES.SERVER_TOKEN

/** 采信行文档键前缀（确定性 ⇒ 重放落同一行）。 */
const ENDORSEMENT_ID_PREFIX = 'en-'

/** 值级公开摘要行文档键前缀（`cs-`；确定性 ⇒ 同值恒指同一行）。 */
const CORRECTION_SUMMARY_ID_PREFIX = 'cs-'

/* ---------------------------------------------------------------------------
   管理员写面（V3：收敛到「登录令牌 ＋ 服务端手机号白名单」）
   ---------------------------------------------------------------------------
   本单把管理员写面（`reviewCorrection` / `setInviteReward`）从 `xiai-admin-token`
   搬到**用户令牌函数**：服务端接受**登录令牌**（本函数 `action:'issue'` 签发的用户令牌）
   ＋「令牌声明里的手机号 ∈ 管理员白名单（环境变量 `XIAI_ADMIN_PHONE`，挂在**本函数**上）」
   ⇒ 采纳 / 驳回、改邀请奖励**永不需要第二个码、零弹窗**。
   硬口径（逐条）：
     · **白名单真源 ＝ `XIAI_ADMIN_PHONE`**；手机号取自**服务端从令牌声明派生的
       `identity.phone`**，**绝不采信前端自称**；
     · **缺 / 空 env ⇒ 安全默认**：所有管理员类 op 一律**结构化拒绝 ＋ 零写入**
       （不得因未配置而放行、不得静默）；
     · **判定（身份白名单 ＋ 值域）全部在写之前**；
     · 失败形状恒为恰 3 键 `{ok:false, reason, message}`。
   真源副本（与 `cloudfunctions/xiai-admin-token/lib/ops.js` **逐字同值**，由
   `scripts/verify-admin-write-via-login.mjs` 机械断言相等 ⇒ 不让副本静默漂移）。
   --------------------------------------------------------------------------- */

/** 勘误三态（与 `src/services/corrections.js::CORRECTION_STATUS` 逐字同值）。 */
const CORRECTION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED'
})

/** 旧决定字面值 → 规范值（`APPROVED` 按采纳兼容；与管理员函数 `LEGACY_DECISION` 同口径）。 */
const LEGACY_DECISION = Object.freeze({ APPROVED: 'ACCEPTED' })

/** 允许的两种终端决定（此外一律 `INVALID_VALUE` ＋ 零写入）。 */
const DECISIONS = Object.freeze(['ACCEPTED', 'REJECTED'])

/* 采纳值域真源副本（真源 ＝ `src/data/seed.js`；与管理员函数 `VALUE_DOMAINS` 逐字同值）。 */
const DYNASTY_OPTIONS = Object.freeze([
  '商周暨春秋',
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
])

const FACE_CONTENT_OPTIONS = Object.freeze([
  '官印',
  '私印',
  '姓名印',
  '齋館印',
  '鑑藏印',
  '吉語印',
  '肖形印',
  '花押印',
  '閒章'
])

const FACE_STYLE_OPTIONS = Object.freeze([
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
])

/* 【大類】值域真源副本（真源 ＝ `src/data/seed.js::SEAL_CLASS_OPTIONS`；3 值封闭集合）。
   与前端真源逐字相等由 `scripts/verify-seal-class.mjs` 机械断言。 */
const SEAL_CLASS_OPTIONS = Object.freeze(['古璽', '流派印', '雜項'])

/** 需值域门约束的字段 → 冻结真源（逐字段一对一；其余字段不受第二道门约束）。 */
const VALUE_DOMAINS = Object.freeze({
  dynasty: DYNASTY_OPTIONS,
  seal_type: FACE_CONTENT_OPTIONS,
  face_style: FACE_STYLE_OPTIONS,
  seal_class: SEAL_CLASS_OPTIONS
})

/** 审核载荷允许键（**封闭键面**；与 `src/services/corrections.js::REVIEW_PAYLOAD_KEYS` 逐字同值）。 */
const REVIEW_ALLOWED_KEYS = Object.freeze(['correction_id', 'decision', 'note'])

/** 邀请奖励载荷允许键（**封闭键面**：只有 `value`）。 */
const REWARD_ALLOWED_KEYS = Object.freeze(['value'])

/** 审核载荷里明令不可由前端提供的身份类键（防御性登记 ⇒ 文案上把「身份类」与「普通未知键」分开）。 */
const REVIEW_IDENTITY_KEYS = Object.freeze([
  'userId',
  'user_id',
  'user_phone',
  'uid',
  'phone',
  'role',
  'status',
  'created_at',
  'reviewed_at',
  'reviewer_id',
  'rewarded_at',
  'identity_source',
  'review_note'
])

/** 驳回理由上限（与数据层 `writeCorrectionDecision` / 管理员函数 `MAX_NOTE_LENGTH` 同值）。 */
const MAX_NOTE_LENGTH = 200

/** 勘误单号上限（防无界；超限 ⇒ `INVALID_VALUE`）。 */
const MAX_ID_LENGTH = 128

/** 公开只读投影行字段面（**封闭**；**零身份字段**；与管理员函数 `PUBLIC_PROJECTION_KEYS` 逐字同值）。 */
const PUBLIC_PROJECTION_KEYS = Object.freeze([
  'correction_id',
  'faceId',
  'sealId',
  'stamp_id',
  'field',
  'field_label',
  'value',
  'status',
  'reviewed_at',
  'updated_at',
  'schema'
])

/** 公开投影明令禁止的键（身份面 ＋ 用户自由文本 `basis`）；与投影键面交集必须为空。 */
const IDENTITY_PROJECTION_KEYS = Object.freeze([
  'userId',
  'user_id',
  'user_phone',
  'uid',
  'phone',
  'reviewer_id',
  'identity_source',
  'basis'
])

/** 公开投影 schema 版本（与管理员函数 `PUBLIC_SCHEMA` 逐字同值）。 */
const PUBLIC_SCHEMA = 'xiai-corrections-public-v1'

/** 公开投影行 id 前缀（`cp-<勘误单号>` ⇒ 确定性，同单重放恒同一行 ⇒ 幂等 upsert）。 */
const PUBLIC_ID_PREFIX = 'cp-'

/* ---------------------------------------------------------------------------
   **影像產物登記面（本單新增 op `registerArtifact`）**
   ---------------------------------------------------------------------------
   场景：客户端把「存储件字节（单页 8bit Deflate TIFF）」**直传云存储**（内容寻址键），
   然后调本 op 让**服务端回读该对象、自行重算摘要与字节数**，与客户端声称值**逐字比对**。
   硬口径（逐条）：
     · **只验证，不写集合**（本 op 不产出 `plan` ⇒ `index.js` 的落盘分支不会触发）；
     · **不采信客户端自称**：`sha256` / `bytesLength` 一律以服务端**回读该对象算出的真值**为准，
       声称值只用于**比对**（不一致 ⇒ 结构化拒绝 ＋ 零写入，且**不报告任何真值**）；
     · **对象键形态自持**（服务端自己也判一遍）：`xiai/images/<sha 前两位>/<sha>.tiff`，
       且 `<sha>` 段必须 ≡ 声称的 `sha256` ⇒ 客户端无法用一个路径冒充另一份内容；
     · **上限与工程同值**（4 MiB ＝ `src/utils/image.js::IMAGE_LIMITS.maxStoredBytes` /
       规范 §3.29.2 的 `STORED_MAX_BYTES`）—— 先按声称体量挡住超大请求，再回读（读取有界）；
     · **容器墨数门**：回读字节认不出 TIFF（`II*\0` / `MM\0*`）⇒ 结构化拒绝（本面的产物一律 TIFF）；
     · 失败形态恒为恰 3 键 `{ok:false, reason, message}`，`reason` ∈ 既有冻结表（**新增字面值 0**）。
   --------------------------------------------------------------------------- */

/** 登记载荷允许键（**封闭键面**；身份类键一律拒 —— 与其它 op 同口径）。 */
const ARTIFACT_ALLOWED_KEYS = Object.freeze(['cloudPath', 'sha256', 'bytesLength'])

/** 影像产物对象键形态（与 `src/data/cloudbase.js::IMAGE_OBJECT_KEY_PATTERN` 的「新增产物」面同形；
 *  既有展示件行是 `…/<sha>.png|webp`，本面新产物一律 `…/<sha>.tiff`）。 */
const ARTIFACT_OBJECT_KEY_PATTERN = /^xiai\/images\/([0-9a-f]{2})\/([0-9a-f]{64})\.tiff$/

/** 产物容器（存储面容器字面值的**转口副本**；真源仍 ＝ `src/utils/tiff.js::TIFF_MIME`）。 */
const ARTIFACT_MIME = 'image/tiff'

/** 产物体量上限（与工程产物侧上限 4 MiB 同值；参见 `src/utils/image.js::IMAGE_LIMITS`）。 */
const ARTIFACT_MAX_BYTES = 4 * 1024 * 1024

/** 摘要形态（64 位小写十六进制；与 `src/services/imageAuthority.js::normalizeDigest` 同口径）。 */
const ARTIFACT_DIGEST_PATTERN = /^[0-9a-f]{64}$/

/* ---------------------------------------------------------------------------
   **展示件轉碼面（本單新增 op `ensureDisplayArtifact`）**
   ---------------------------------------------------------------------------
   背景（人類已實測定案）：瀏覽器不能原生解 TIFF ⇒ 新上傳的 `.tiff` 原圖在線上無法顯示；
   桶安全規則**按擴展名放行**（同會話同前綴 `.png` ⇒ `getTempFileURL` 成功；`.tiff` ⇒
   `STORAGE_EXCEED_AUTHORITY`）⇒ 原圖 TIFF 不暴露給匿名讀（恰好是想要的安全面），而
   `.png` 展示件天然可讀。⇒ 展示件由**服務端**轉碼並上傳到**同目錄同名內容尋址鍵**
   `xiai/images/<摘要前兩位>/<摘要>.png`（讀面單點按行派生該鍵，見 `src/data/cloudbase.js`）。
   --------------------------------------------------------------------------- */

/** 展示件轉碼載荷允許鍵（**封閉鍵面**：只有 `cloudPath` / `sha256`；身份類鍵一律拒）。 */
const DISPLAY_ALLOWED_KEYS = Object.freeze(['cloudPath', 'sha256'])

/** TIFF 魔数（小端 `II*\0` / 大端 `MM\0*`；与 `src/utils/tiff.js` 同值、只作墨数门）。 */
const TIFF_MAGIC_LE = Object.freeze([0x49, 0x49, 0x2a, 0x00])
const TIFF_MAGIC_BE = Object.freeze([0x4d, 0x4d, 0x00, 0x2a])

/** 真字节类 ⇒ `Buffer`（其余 ⇒ `null`；认不出即失败，不静默放大）。 */
function bufferOf(value) {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, 'binary')
  return null
}

/** 按字节墨数判容器（认不出 ⇒ 空串 —— **不采信自称值**）。 */
function artifactMimeOf(bytes) {
  const v = bufferOf(bytes)
  if (!v || v.length < 8) return ''
  const le = TIFF_MAGIC_LE.every((byte, index) => v[index] === byte)
  const be = TIFF_MAGIC_BE.every((byte, index) => v[index] === byte)
  return le || be ? ARTIFACT_MIME : ''
}

/* ---------------------------------------------------------------------------
   DB 注入缝（**离线自检 / 宿主用**；生产不注入 ⇒ 走真实 `@cloudbase/node-sdk`）
   --------------------------------------------------------------------------- */

let dbProvider = null

/**
 * 注入 DB 实现（`() => database`；传非函数 ⇒ 清除注入）。
 * @param {null|function():object} fn
 */
function setOpsDbProvider(fn) {
  dbProvider = typeof fn === 'function' ? fn : null
}

/** 是否已注入（诊断读数用，**不含任何凭据**）。 */
function opsDbInjected() {
  return dbProvider !== null
}

/* ---------------------------------------------------------------------------
   对象存储读取缝（**离线自检 / 宿主用**；生产不注入 ⇒ 走真实 `@cloudbase/node-sdk`）
   --------------------------------------------------------------------------- */

let storageProvider = null

/**
 * 注入对象存储读取实现（**仅供离线自检 / 宿主**）。
 * 形状：`async (cloudPath) => Buffer|Uint8Array`（对象不存在 ⇒ **抛错**）。
 * @param {null|function(string):Promise<Buffer|Uint8Array>} fn
 */
function setOpsStorageProvider(fn) {
  storageProvider = typeof fn === 'function' ? fn : null
}

/** 是否已注入（诊断读数用，**不含任何凭据**）。 */
function opsStorageInjected() {
  return storageProvider !== null
}

/* ---------------------------------------------------------------------------
   对象存储**上传**缝（**离线自检 / 宿主用**；生产不注入 ⇒ 走真实 `@cloudbase/node-sdk`）
   —— 本单 `ensureDisplayArtifact` 用：服务端把转码出的展示件 PNG 上传到内容寻址键。
   --------------------------------------------------------------------------- */

let storageUploadProvider = null

/**
 * 注入对象存储**上传**实现（**仅供离线自检 / 宿主**）。
 * 形状：`async ({cloudPath, bytes}) => void`（上传失败 ⇒ **抛错**，由 op 转结构化拒绝）。
 * @param {null|function(object):Promise<void>} fn
 */
function setOpsStorageUploadProvider(fn) {
  storageUploadProvider = typeof fn === 'function' ? fn : null
}

/** 上传缝是否已注入（诊断读数用，**不含任何凭据**）。 */
function opsStorageUploadInjected() {
  return storageUploadProvider !== null
}

/**
 * 服务端取 **fileID**（`cloud://<envId>.<bucket>/<对象键>`）。
 *
 * 为什么不拼字面量：bucket 名**不得在代码里硬编码**（工程纪律；前端唯一默认值的定义点在
 * `src/data/cloudbase.js::CLOUD_STORAGE_BUCKET_DEFAULT`）。这里让**平台自己**回答：
 * `@cloudbase/node-sdk` **v3.18.3** 的 `IGetUploadMetadataResult` 形状是**嵌套**的 ——
 * 回包的 `data.fileId` 才是本环境该对象的完整 fileID（`{ data: { url, token, authorization,
 * fileId, cosFileId, download_url } }`）；早前按**扁平**取值恒 `undefined`
 * ⇒ 生产恒 `STORAGE_UNAVAILABLE`（本单真因）。
 * 容错：个别回包若为**扁平** `{ fileId }`（无 `data` 中介）⇒ 仍取用（向前兼容）；
 * **两种形态都拿不到 / 取到空白 ⇒ 抛错**（由 `registerArtifact` 转结构化拒绝，**不猜、不拼**）。
 * @param {object} app `@cloudbase/node-sdk` 的 app 实例
 * @param {string} cloudPath 对象键
 * @returns {Promise<string>} 完整 fileID
 */
async function resolveFileId(app, cloudPath) {
  const meta = await app.getUploadMetadata({ cloudPath })
  /* 主读取：**嵌套**（SDK v3.18.3 真实形状）；扁平只作向前兼容的转口读取（`readFileId(meta)`）。 */
  const readFileId = (source) => (source && typeof source.fileId === 'string' ? source.fileId : null)
  const nested = meta && meta.data && typeof meta.data.fileId === 'string' ? meta.data.fileId : null
  const flat = readFileId(meta)
  const fileId = nested !== null ? nested : flat
  if (typeof fileId !== 'string' || fileId.trim() === '') throw new Error('STORAGE_FILEID_UNRESOLVED')
  return fileId.trim()
}

/**
 * **回读对象字节**（服务端；`registerArtifact` 的唯一数据来源）。
 *
 * 顺序：① 注入缝（离线自检）→ ② 真实 node-sdk：先解析完整 fileID，再 `downloadFile`。
 * 任一环失败 ⇒ **抛错**（由调用方转 `STORAGE_UNAVAILABLE` / `INVALID_VALUE`，**不得伪装 FORBIDDEN**）。
 * @param {string} cloudPath 对象键
 * @returns {Promise<Buffer>}
 */
async function readArtifactBytes(cloudPath) {
  if (storageProvider) {
    const injected = await storageProvider(cloudPath)
    const bytes = bufferOf(injected)
    if (!bytes) throw new Error('STORAGE_INJECTED_SHAPE_INVALID')
    return bytes
  }
  /* 延迟 require：离线自检（注入存储）时**不需要**装 `@cloudbase/node-sdk`。 */
  const tcb = require('@cloudbase/node-sdk')
  const envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE || process.env.CLOUDBASE_ENV_ID || ''
  const app = envId ? tcb.init({ env: envId }) : tcb.init()
  const fileID = await resolveFileId(app, cloudPath)
  const reply = await app.downloadFile({ fileID })
  const bytes = bufferOf(reply && reply.fileContent)
  if (!bytes) throw new Error('STORAGE_DOWNLOAD_EMPTY')
  return bytes
}

/**
 * **上传展示件字节**（服务端；`ensureDisplayArtifact` 的唯一写存储点）。
 *
 * 顺序：① 注入缝（离线自检）→ ② 真实 node-sdk `uploadFile({cloudPath, fileContent})`。
 * **内容寻址 ⇒ 天然幂等**：同鍵重複上傳即覆寫同內容，**不做存在性探測**（与
 * `registerArtifact` 的「零存在性判定」同口径；重复调用安全）。
 * 任一环失败 ⇒ **抛错**（由调用方转 `STORAGE_UNAVAILABLE`，**不得伪装 FORBIDDEN**）。
 * @param {string} cloudPath 展示件对象键（`xiai/images/<摘要前两位>/<摘要>.png`）
 * @param {Buffer|Uint8Array} bytes 展示件 PNG 字节
 * @returns {Promise<void>}
 */
async function uploadDisplayArtifactBytes(cloudPath, bytes) {
  const payload = bufferOf(bytes)
  if (!payload || payload.length === 0) throw new Error('DISPLAY_UPLOAD_EMPTY')
  if (storageUploadProvider) {
    await storageUploadProvider({ cloudPath, bytes: payload })
    return
  }
  /* 延迟 require：离线自检（注入上传缝）时**不需要**装 `@cloudbase/node-sdk`。 */
  const tcb = require('@cloudbase/node-sdk')
  const envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE || process.env.CLOUDBASE_ENV_ID || ''
  const app = envId ? tcb.init({ env: envId }) : tcb.init()
  await app.uploadFile({ cloudPath, fileContent: payload })
}

/**
 * 取 DB 句柄。
 * 凭据来源：**函数运行环境注入的角色凭据**（node-sdk 自行读取）——本文件**不传任何密钥**；
 * envId 取运行期环境变量（缺位 ⇒ 交给 SDK 的「当前环境」语义，**不写死**）。
 */
function resolveDb() {
  if (dbProvider) return dbProvider()
  /* 延迟 require：离线自检（注入 DB）时**不需要**装 `@cloudbase/node-sdk`。 */
  const tcb = require('@cloudbase/node-sdk')
  const envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE || process.env.CLOUDBASE_ENV_ID || ''
  const app = envId ? tcb.init({ env: envId }) : tcb.init()
  return app.database()
}

/**
 * **積分賬本的集合句柄供給點（生產單點）**：`xiai_balances` / `xiai_points_flow`
 * 两集合**服务端专属私有** —— 参照 `COUNTERS_COLLECTION`（`xiai_counters`）先例：
 * **不进**本文件的 `COLLECTIONS` 读写面登记表（那是既有 13 个集合的登记表；账本两集合
 * 只由 `lib/ledger.js` 一处读写，单点即审计点），**更不进**前端 `CLOUD_COLLECTIONS` /
 * `CLOUD_COLLECTION_KEYS` / `CLOUD_KEY_OF_LOCAL` ⇒ 客户端零读面。
 * 离线自检可经 `ledger.setLedgerStoreProvider` 注入假体（不经本函数）。
 */
function resolveLedgerStore() {
  const db = resolveDb()
  return {
    balances: db.collection(ledger.LEDGER_COLLECTIONS.balances),
    flow: db.collection(ledger.LEDGER_COLLECTIONS.flow)
  }
}

/**
 * **AI 三面的集合句柄供給點（生產單點）**：`xiai_ai_keys` / `xiai_ai_upstream` / `xiai_ai_usage`
 * 三集合**服务端专属私有** —— 参照 `COUNTERS_COLLECTION` / 账本两集合先例：**不进**本文件的
 * `COLLECTIONS` 读写面登记表（那是既有 13 个集合的登记表；AI 三集合只由 `lib/aiKeys.js` /
 * `lib/aiUpstream.js` / `lib/aiUsage.js` 三处读写，单点即审计点），**更不进**前端
 * `CLOUD_COLLECTIONS` / `CLOUD_COLLECTION_KEYS` / `CLOUD_KEY_OF_LOCAL` ⇒ 客户端零读面。
 * 离线自检可经 `aiKeys.setAiKeyStoreProvider` / `aiUpstream.setUpstreamStoreProvider` /
 * `aiUsage.setAiUsageStoreProvider` 注入假体（不经本函数）。
 */
function resolveAiStore() {
  const db = resolveDb()
  return {
    keys: db.collection(aiKeys.AI_KEYS_COLLECTION),
    upstream: db.collection(aiUpstream.AI_UPSTREAM_COLLECTION),
    usage: db.collection(aiUsage.AI_USAGE_COLLECTION)
  }
}

function makeId() {
  return `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/** 不可逆摘要前 16 位（确定性文档键的**唯一**来源；不用于任何授权判定）。 */
function hash16(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16)
}

/** 采信行文档键：`(faceId, field, value, user_id)` 确定性派生 ⇒ 重放落同一行（幂等）。 */
function endorsementDocId(faceId, field, value, uid) {
  return `${ENDORSEMENT_ID_PREFIX}${hash16(JSON.stringify([faceId, field, value, uid]))}`
}

/** 值级公开摘要行文档键：`cs-<faceId>-<field>-<value 的 sha256 前 16 位>`（与前端 / 规范同构）。 */
function correctionSummaryDocId(faceId, field, value) {
  return `${CORRECTION_SUMMARY_ID_PREFIX}${faceId}-${field}-${hash16(value)}`
}

/**
 * 由「提交行集合 ＋ 采信行集合」构造**值级公开摘要行**（纯函数；**零手机号**、uid 允许）。
 *
 * 口径（人类冻结）：
 *   · `submits` ＝ **未 REJECTED 的提交行去重人数**（按 uid 去重；无 uid 时按行 id）；
 *   · `endorses` ＝ **采信行去重人数**（按 uid 去重；无 uid 时按行 `_id`）；
 *   · `status` ＝ 任一行 `ACCEPTED` ⇒ `ACCEPTED`；全 `REJECTED`（且非空）⇒ `REJECTED`；否则 `PENDING`；
 *   · `submitter_uids` ＝ **未 REJECTED** 提交行的提交人 uid 去重列表（**不得带昵称 / 手机号**）；
 *   · `_id` 确定性 ⇒ **幂等 upsert**（重读 / 重放不涨数）。
 * @returns {object} 摘要行
 */
function buildCorrectionSummary({ faceId, sealId, field, value, submissions, endorsements, at }) {
  const statuses = []
  const submitterUids = []
  const seenSubmitters = new Set()
  ;(Array.isArray(submissions) ? submissions : []).forEach((row) => {
    const status = text(row && row.status) || CORRECTION_PENDING
    statuses.push(status)
    if (status === CORRECTION_STATUS.REJECTED) return // 被驳回的提交不计入 submits / submitter_uids
    const uid = text(row && (row.user_id || row.userId))
    const identity = uid || text(row && (row.id || row._id))
    if (!identity || seenSubmitters.has(identity)) return
    seenSubmitters.add(identity)
    if (uid) submitterUids.push(uid)
  })
  const seenEndorsers = new Set()
  ;(Array.isArray(endorsements) ? endorsements : []).forEach((row) => {
    const uid = text(row && (row.user_id || row.userId))
    const identity = uid || text(row && (row._id || row.id))
    if (identity) seenEndorsers.add(identity)
  })
  const hasAccepted = statuses.indexOf(CORRECTION_STATUS.ACCEPTED) !== -1
  const allRejected = statuses.length > 0 && statuses.every((item) => item === CORRECTION_STATUS.REJECTED)
  const status = hasAccepted ? CORRECTION_STATUS.ACCEPTED : allRejected ? CORRECTION_STATUS.REJECTED : CORRECTION_PENDING
  const normalizedSeal = text(sealId)
  return {
    _id: correctionSummaryDocId(faceId, field, value),
    faceId: text(faceId),
    sealId: normalizedSeal,
    stamp_id: normalizedSeal,
    field: text(field),
    value: text(value),
    submits: seenSubmitters.size,
    endorses: seenEndorsers.size,
    status,
    submitter_uids: submitterUids,
    updated_at: text(at),
    schema: CORRECTION_SUMMARY_SCHEMA
  }
}

/**
 * 取查询响应里的行数组（形态容错；认不出 ⇒ `[]`，**明确空集、不猜**）。
 * 与 `src/data/cloudbase.js::rowsOfReply` 同口径（只读；本文件是服务端唯一读点）。
 */
function rowsOfReply(reply) {
  if (!reply) return []
  if (Array.isArray(reply)) return reply
  if (Array.isArray(reply.data)) return reply.data
  const data = reply.data || reply.result || null
  if (data && Array.isArray(data.list)) return data.list
  if (data && Array.isArray(data.data)) return data.data
  if (Array.isArray(reply.list)) return reply.list
  return []
}

/**
 * **读**（**唯一读点**）：按等值条件读某集合的行。
 * 失败 ⇒ 抛错（由 `index.js` 统一转 `STORAGE_UNAVAILABLE`，**绝不伪装 `FORBIDDEN`**）。
 * `collection(` 只在本文件出现 ⇒ 静态判据仍成立。
 * **分页护栏（本单 I-3 真因）**：真实 CloudBase 的 `.get()` **默认上限 100 行** —— 不显式
 * `.limit()` 时 `where({batch_id}).get()` 只回该批**前 100 行**（**与状态无关**）⇒ 批内超过 100 行
 * 时，处理完前 100 行后**每次调用读到的仍是这同一批已终态行**（循环里全 `skipped`）⇒
 * `plan.writes` 恒空。故本读点接受 `options.limit`（显式 `.limit(n)`，n 由调用方给）。
 * 注入式内存假体（离线自检）认不出 `.limit` ⇒ **原样读全部**（等价于不限量，**不构成降级**：
 * 假体的行集本就是调用方可读到的全集）。**正确性口径 ＝ 调用方按 `status` 过滤目标行**
 * （终态行不再进入读集 ⇒ **天然自愈分页**、可反复调用直至清空）；`.limit` 只是单次体量护栏。
 * @param {string} collection 集合名（`^xiai_`）
 * @param {object} match 等值条件
 * @param {{limit?:number}} [options] 单次读取上限（平台护栏；缺省 / ≤0 ⇒ 不显式限量）
 * @returns {Promise<Array<object>>}
 */
async function readRows(collection, match, options) {
  const db = resolveDb()
  const query = db.collection(collection)
  if (!query || typeof query.where !== 'function') throw new Error('DB_QUERY_UNSUPPORTED')
  let chain = query.where(match)
  const limit = Number(options && options.limit)
  if (Number.isFinite(limit) && limit > 0 && chain && typeof chain.limit === 'function') {
    chain = chain.limit(Math.floor(limit))
  }
  return rowsOfReply(await chain.get())
}

/**
 * **V6-a**：按平台会话 uid 读**角色行**（集合 `xiai_roles`；判权读点、**只读**）。
 *
 * 形态：先按等值键 `uid` 检索；未命中再按文档 `_id` ＝ uid 兜底（兼容两种落库约定）。
 * **读失败 ⇒ 抛错**（由 `sessionAuthority.resolveSessionAuthority` 转
 * `STORAGE_UNAVAILABLE`，**绝不伪装 `FORBIDDEN`**）；**无行 ⇒ 返回 `null`**
 * （由判权侧 fail-closed 处理）。
 * @param {string} uid 平台会话 uid
 * @returns {Promise<object|null>}
 */
async function readRoleRow(uid) {
  const id = text(uid)
  if (!id) return null
  const db = resolveDb()
  const collection = db.collection(COLLECTIONS.roles)
  const byField = await collection.where({ uid: id }).get()
  const rowsByField = rowsOfReply(byField)
  if (rowsByField.length > 0) return rowsByField[0]
  const byDoc = await collection.doc(id).get()
  const rowsByDoc = rowsOf(byDoc)
  if (rowsByDoc.length > 0) return rowsByDoc[0]
  return null
}

/**
 * **印人读点（person-model §4.1 / §4.2；只读）**：按 `id` / `code` / 文档 `_id` 兜底读正式印人行。
 * @param {string} ref 引用（`author_person_id` 或印人 id / code）
 * @returns {Promise<object|null>}
 */
async function readPersonRow(ref) {
  const id = text(ref)
  if (!id) return null
  const db = resolveDb()
  const collection = db.collection(COLLECTIONS.persons)
  const byId = await collection.where({ id }).get()
  const rowsById = rowsOf(byId)
  if (rowsById.length > 0) return rowsById[0]
  const byCode = await collection.where({ code: id }).get()
  const rowsByCode = rowsOf(byCode)
  if (rowsByCode.length > 0) return rowsByCode[0]
  const byDoc = await collection.doc(id).get()
  const rowsByDoc = rowsOf(byDoc)
  if (rowsByDoc.length > 0) return rowsByDoc[0]
  return null
}

/**
 * **印人提案读点（§3；只读）**：按业务键 `id` / 文档 `_id` 兜底读提案行。
 * @param {string} proposalId
 * @returns {Promise<{row:object, match:object}|null>}
 */
async function readPersonProposalRow(proposalId) {
  const id = text(proposalId)
  if (!id) return null
  const db = resolveDb()
  const collection = db.collection(COLLECTIONS.personProposals)
  const byId = await collection.where({ id }).get()
  const rowsById = rowsOf(byId)
  if (rowsById.length > 0) return { row: rowsById[0], match: { id } }
  const byDoc = await collection.doc(id).get()
  const rowsByDoc = rowsOf(byDoc)
  if (rowsByDoc.length > 0) return { row: rowsByDoc[0], match: { _id: id } }
  return null
}

/**
 * **外部导入行读点（§3.54.14；只读）**：按业务键 `id` / 文档 `_id` 兜底读导入行。
 * @param {string} importId
 * @returns {Promise<{row:object, match:object}|null>}
 */
async function readPersonImportRow(importId) {
  const id = text(importId)
  if (!id) return null
  const db = resolveDb()
  const collection = db.collection(COLLECTIONS.personImports)
  const byId = await collection.where({ id }).get()
  const rowsById = rowsOf(byId)
  if (rowsById.length > 0) return { row: rowsById[0], match: { id } }
  const byDoc = await collection.doc(id).get()
  const rowsByDoc = rowsOf(byDoc)
  if (rowsByDoc.length > 0) return { row: rowsByDoc[0], match: { _id: id } }
  return null
}

/* ---------------------------------------------------------------------------
   **印章批 3（v1.55）**：印章導入行读点 ＋ 归一面 ＋ 幂等落行派生（与前端 / 管理函数逐字同构）
   --------------------------------------------------------------------------- */

/**
 * **印章導入行读点（§3.55.3；只读）**：按业务键 `id` / 文档 `_id` 兜底读导入行。
 * @param {string} importId
 * @returns {Promise<{row:object, match:object}|null>}
 */
async function readSealImportRow(importId) {
  const id = text(importId)
  if (!id) return null
  const db = resolveDb()
  const collection = db.collection(COLLECTIONS.sealImports)
  const byId = await collection.where({ id }).get()
  const rowsById = rowsOf(byId)
  if (rowsById.length > 0) return { row: rowsById[0], match: { id } }
  const byDoc = await collection.doc(id).get()
  const rowsByDoc = rowsOf(byDoc)
  if (rowsByDoc.length > 0) return { row: rowsByDoc[0], match: { _id: id } }
  return null
}

/** 印章導入行**内容指纹**（纯函数；印章級鍵面（8 ＋ 51）规范化串杂凑 —— 与 `seed.js::sealImportFingerprint` 同算法）。 */
function sealImportFingerprintOf(fields) {
  const src = fields && typeof fields === 'object' ? fields : {}
  const normalized = SEAL_IMPORT_FINGERPRINT_FIELDS.map((key) => text(src[key] === undefined || src[key] === null ? '' : src[key])).join('\u0001')
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/** 源側擴面**單值归一**（**原样保留**：字符串 / 整數 / `null`；`misc` ⇒ 對象或 `null`；缺值 ⇒ `null`）。 */
function sealSourceValueOf(key, value) {
  if (value === undefined || value === null) return null
  if (SEAL_IMPORT_SOURCE_OBJECT_FIELDS.indexOf(key) !== -1) {
    return typeof value === 'object' && !Array.isArray(value) ? { ...value } : null
  }
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

/** 源側擴面（51 鍵）从導入行取（**原样**：字符串 / 整數 / `null`；`misc` 對象；缺值 ⇒ `null`）。 */
function sealSourceFieldsOf(row) {
  const src = row && typeof row === 'object' ? row : {}
  const out = {}
  SEAL_IMPORT_SOURCE_FIELDS.forEach((key) => {
    out[key] = key === 'source_seal_id' ? text(src.source_seal_id) : sealSourceValueOf(key, src[key])
  })
  return out
}

/**
 * **源側擴面形態門**（判定恒在寫之前）：只允许「字符串（非空）/ 整數（非 `0`）/ `null`」；
 * `misc` ⇒ 對象或 `null`；`audit_status` 原样收（字符串或數字）。
 * 违规 ⇒ `INVALID_VALUE` ＋ 零写入（`reason` 零新增）。
 * @returns {null|{ok:false, reason:string, message:string}}
 */
function sealSourceValueDenial(payload) {
  const src = payload && typeof payload === 'object' ? payload : {}
  for (const key of SEAL_IMPORT_SOURCE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    const value = src[key]
    if (value === null || value === undefined) continue
    if (SEAL_IMPORT_SOURCE_OBJECT_FIELDS.indexOf(key) !== -1) {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return deny(REASONS.INVALID_VALUE, `${key} 必須是對象或 null ⇒ 拒絕導入；本次零寫入。`)
      }
      continue
    }
    if (typeof value === 'string') {
      if (value === '') {
        return deny(REASONS.INVALID_VALUE, `${key} 不得為空串（源側無值請用 null）⇒ 拒絕導入；本次零寫入。`)
      }
      continue
    }
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value === 0) {
        return deny(REASONS.INVALID_VALUE, `${key} 必須是整數或 null（不得 0 / 空串等特值）⇒ 拒絕導入；本次零寫入。`)
      }
      continue
    }
    return deny(REASONS.INVALID_VALUE, `${key} 只允許字符串 / 整數 / null ⇒ 拒絕導入；本次零寫入。`)
  }
  return null
}

/**
 * **行級鍵 `image_status` 取値**：未提供（`undefined` / `null`）⇒ **`present`**（向後兼容）；
 * 已提供 ⇒ 逐字取值，**值域外 ⇒ `null`**（调用方据此 `INVALID_VALUE` ＋ 零写入）。
 * @returns {string|null} `present` / `source_no_image` / `null`（非法）
 */
function sealImportImageStatusOf(payload) {
  const src = payload && typeof payload === 'object' ? payload : {}
  const raw = src.image_status
  if (raw === undefined || raw === null) return SEAL_IMPORT_IMAGE_STATUS.PRESENT
  const value = text(raw)
  if (value === SEAL_IMPORT_IMAGE_STATUS.PRESENT || value === SEAL_IMPORT_IMAGE_STATUS.SOURCE_NO_IMAGE) return value
  return null
}

/** 归一刻章級字段面（既有 8 鍵 ⇒ 文本；源側擴面 51 鍵 ⇒ **原样**：字符串 / 整數 / `null`、`misc` 對象）。 */
function pickSealImportSealFields(payload) {
  const src = payload === undefined || payload === null ? {} : payload
  const out = {}
  SEAL_IMPORT_SEAL_FIELDS.forEach((key) => {
    out[key] = text(src[key])
  })
  SEAL_IMPORT_SOURCE_FIELDS.forEach((key) => {
    if (key === 'source_seal_id') {
      out[key] = text(src.source_seal_id)
      return
    }
    out[key] = sealSourceValueOf(key, src[key])
  })
  return out
}

/** 归一单印面（`kind` 默认 `FACE`；`image_bytes` 默认 `0`；其余文本）。 */
function normalizeSealImportFace(face) {
  const f = face && typeof face === 'object' ? face : {}
  const out = {}
  SEAL_IMPORT_FACE_FIELDS.forEach((key) => {
    if (key === 'kind') {
      out[key] = text(f.kind) === 'EDGE' ? 'EDGE' : 'FACE'
      return
    }
    if (key === 'image_bytes') {
      const n = Number(f.image_bytes)
      out[key] = Number.isFinite(n) && n > 0 ? Math.round(n) : 0
      return
    }
    out[key] = text(f[key])
  })
  return out
}

/** 印章序号（`XA` ＋ 9 位；用于派生印面 id 的 `<序号>` 位）。 */
function sealStampSerialOf(stampId) {
  const matched = new RegExp(`^${SEAL_STAMP_ID_PREFIX}(\\d{9})$`).exec(text(stampId))
  if (matched) return matched[1]
  return text(stampId).replace(/[^0-9A-Za-z]/g, '')
}

/**
 * 下一印章编号（**R-5 前的旧实现**）：`XA` ＋ 9 位序号，**跳过已占用**。
 * ⚠️ **已退出采纳主路**：R-5 起新印章 `stamp_id` ＝ `sid`（`issueCodeNumber` 发号 ＋
 * `codeId.encodeSealCode` 重算，见 `buildSealAcceptanceFromImport`）；本函数只保留作
 * **旧号识别**参考、**不再产出新值**。`db.js::nextSealStampId` 已同改为发 `sid`
 * （两处口径已不再相同 —— 如实登记，勿再按「同口径」断言）。 */
function nextSealStampIdOf(rows) {
  let max = 0
  ;(Array.isArray(rows) ? rows : []).forEach((row) => {
    const matched = new RegExp(`^${SEAL_STAMP_ID_PREFIX}(\\d{9})$`).exec(text(row && row.stamp_id))
    if (matched) max = Math.max(max, Number(matched[1]))
  })
  const taken = new Set((Array.isArray(rows) ? rows : []).map((row) => text(row && row.stamp_id)))
  let index = max + 1
  while (taken.has(`${SEAL_STAMP_ID_PREFIX}${String(index).padStart(9, '0')}`)) index += 1
  return `${SEAL_STAMP_ID_PREFIX}${String(index).padStart(9, '0')}`
}

/** 印面 id：`fc-<印章序号>-<f|e><n>`（同类递增，冲突则继续挑；与 `db.js::nextFaceId` 同口径）。 */
function nextFaceIdOf(stampId, kind, taken) {
  const letter = text(kind) === 'EDGE' ? 'e' : 'f'
  const serial = sealStampSerialOf(stampId)
  let index = 1
  while (taken.has(`fc-${serial}-${letter}${index}`)) index += 1
  return `fc-${serial}-${letter}${index}`
}

/**
 * **影像引用存在性读点（§3.55.6｜复用既有 `xiai_images` 集合；只读）**：
 * 按（摘要 / 内容寻址键）查引用对象；命中 ⇒ 回该行，否则 ⇒ `null`（缺失 ⇒ 采纳时该条拒绝）。
 *
 * **无审核直写面追加（可选第 2 参 `overlay`）**：直写 op **自写 `xiai_images` 登记行**（该集合在
 * 生产没有任何 op 写者），登记行**尚未落库**（只在 `plan` 内）⇒ 本读点**先查覆蓋層、未命中再回落
 * 集合**。覆蓋層只由直写 op 传入；**既有三个调用点不传 ⇒ 行为逐字不变**。
 * @param {object} face 印面（含 `image_sha256` / `image_storage_key`）
 * @param {Array<object>} [overlay] 直写通道的影像登记行覆蓋層（只读）
 */
async function findSealImportImageRow(face, overlay) {
  const sha = text(face && face.image_sha256)
  const key = text(face && face.image_storage_key)
  const pending = imageOverlayRowOf(overlay, sha, key)
  if (pending) return pending
  if (sha) {
    const rows = await readRows(COLLECTIONS.images, { sha256: sha })
    if (rows.length > 0) return rows[0]
  }
  if (key) {
    const rows = await readRows(COLLECTIONS.images, { storage_key: key })
    if (rows.length > 0) return rows[0]
  }
  return null
}

/**
 * 直写通道影像登记行覆蓋層的**命中判定**（纯函数；`sha` → `storage_key` 两级，与上面的集合读点同序）。
 * @returns {object|null}
 */
function imageOverlayRowOf(overlay, sha, key) {
  const list = Array.isArray(overlay) ? overlay : []
  if (sha) {
    const hit = list.find((row) => text(row && row.sha256) === sha)
    if (hit) return hit
  }
  if (key) {
    const hit = list.find((row) => text(row && row.storage_key) === key)
    if (hit) return hit
  }
  return null
}

/* ---------------------------------------------------------------------------
   item 通道切片 A（v1.61）：印谱導入辅助（值域 / 形態門 ＋ 本體归一 ＋ 讀行）
   --------------------------------------------------------------------------- */

/** **整数或 `null`**（**不得 `0` / 空串 / 非整数 / 布尔**）；违规 ⇒ `{ok:false}`。 */
function itemStrictIntOrNull(value) {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (typeof value === 'boolean') return { ok: false }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value === 0) return { ok: false }
    return { ok: true, value }
  }
  if (typeof value === 'string') {
    const t = value.trim()
    if (t === '' || !/^-?\d+$/.test(t)) return { ok: false }
    const n = Number(t)
    if (!Number.isInteger(n) || n === 0) return { ok: false }
    return { ok: true, value: n }
  }
  return { ok: false }
}

/** 本体文本归一（**逐字保留 `null`**；`date_text` 的源侧占位 `'N.D.'` ⇒ `null`）。 */
function itemTextOrNull(key, value) {
  if (value === null || value === undefined) return null
  const t = String(value)
  if (key === 'date_text' && t.trim() === ITEM_DATE_PLACEHOLDER) return null
  return t
}

/** `misc` 子對象归一（5 鍵；缺鍵 ⇒ `null`）。 */
function normalizeItemMisc(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const out = {}
  ITEM_MISC_FIELDS.forEach((key) => {
    out[key] = src[key] === undefined ? null : src[key]
  })
  return out
}

/** **值域 / 形态门（X6）**：放行 ⇒ `null`；违规 ⇒ 结构化拒绝（`INVALID_VALUE`）。布尔字段为**布尔或 `null`**（`null` ＝ 源側未知）。 */
function itemValueDenial(payload) {
  const src = payload && typeof payload === 'object' ? payload : {}
  for (const key of ITEM_BODY_INT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    if (!itemStrictIntOrNull(src[key]).ok) {
      return deny(REASONS.INVALID_VALUE, `${key} 必須是整數或 null（不得 0 / 空串等特值）⇒ 拒絕導入；本次零寫入。`)
    }
  }
  for (const key of ITEM_BODY_BOOL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    if (src[key] !== null && typeof src[key] !== 'boolean') {
      return deny(REASONS.INVALID_VALUE, `${key} 必須是布爾（true / false）或 null（源側未知）⇒ 拒絕導入；本次零寫入。`)
    }
  }
  return null
}

/** 由载荷 / 導入行取**本体 22 字段**（归一；`raw_json` / 行级元数据不在内）。 */
function itemBodyOf(src) {
  const s = src && typeof src === 'object' ? src : {}
  const out = {}
  ITEM_BODY_FIELDS.forEach((key) => {
    if (key === 'source_item_id') {
      out[key] = text(s.source_item_id)
      return
    }
    if (key === 'misc') {
      out[key] = normalizeItemMisc(s.misc)
      return
    }
    if (ITEM_BODY_INT_FIELDS.includes(key)) {
      const parsed = itemStrictIntOrNull(s[key])
      out[key] = parsed.ok ? parsed.value : null
      return
    }
    if (ITEM_BODY_BOOL_FIELDS.includes(key)) {
      /* **布爾或 `null`**：`null` ＝ 源側未知 ⇒ **原樣保留**（不落 `false`、不歸一成布爾）；缺鍵 ⇒ 默認 `false`。 */
      out[key] = s[key] === null ? null : s[key] === true
      return
    }
    out[key] = itemTextOrNull(key, s[key])
  })
  return out
}

/**
 * 按導入行號讀印谱導入行（先按業務鍵 `id` 檢索；未命中再按文檔 `_id` 兜底；**只讀**）。
 * @param {string} importId
 * @returns {Promise<{row:object, match:object}|null>}
 */
async function readItemImportRow(importId) {
  const id = text(importId)
  if (!id) return null
  const db = resolveDb()
  const collection = db.collection(COLLECTIONS.itemImports)
  const byId = await collection.where({ id }).get()
  const rowsById = rowsOf(byId)
  if (rowsById.length > 0) return { row: rowsById[0], match: { id } }
  const byDoc = await collection.doc(id).get()
  const rowsByDoc = rowsOf(byDoc)
  if (rowsByDoc.length > 0) return { row: rowsByDoc[0], match: { _id: id } }
  return null
}

/* ---------------------------------------------------------------------------
   管理员写面：白名单门 ＋ 读数（**全部只读 / 判定，不触写**）
   --------------------------------------------------------------------------- */

/**
 * **管理员白名单门**（V3 唯一授权判据之一；**写之前**判定）。
 * 手机号取自**服务端从令牌声明派生的 `identity.phone`**（`index.js` 唯一来源）——
 * 这里只做「逐字等于 `XIAI_ADMIN_PHONE`」的比对，**绝不采信前端自称**。
 * 缺 / 空 env ⇒ **结构化拒绝 ＋ 零写入**（安全默认；**不因未配置而放行**）。
 * @param {{uid:string, phone:string}|null|undefined} identity 服务端派生身份
 * @param {string} adminPhone 白名单手机号（来自 `readConfig().adminPhone`；缺 / 空 ⇒ `''`）
 * @returns {null|{ok:false, reason:string, message:string}} 放行 ⇒ `null`
 */
function adminWhitelistDenial(identity, adminPhone) {
  /* **V6-a 会话路**：身份来自平台会话 ⇒ 授权判据 ＝ `xiai_roles` 的角色（`role === 'admin'`），
     **不依赖手机号白名单**（会话路无手机号；白名单只活在令牌路）。会话路的角色已由
     `index.js` 的 `resolveSessionAuthority` 按 requiredRoles 判过 ⇒ 这里只复核 role，fail-closed。 */
  if (isSessionIdentity(identity)) {
    if (identity.role !== ROLE.ADMIN) {
      return deny(REASONS.FORBIDDEN, '僅管理員可以執行此操作（平台會話角色不足）；本次零寫入。')
    }
    return null
  }
  const expected = normalizePhone(adminPhone)
  if (!expected) {
    /* 未配置 ⇒ **内部不可用**（不是「越权」）⇒ 与工程口径一致用 `STORAGE_UNAVAILABLE`；
       明文：**不得**因未配置而放行，也不得静默。 */
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      '管理員寫入面未配置（缺環境變量：XIAI_ADMIN_PHONE）⇒ 拒絕所有管理員類操作；本次零寫入。'
    )
  }
  if (!identity || !identity.phone) {
    return deny(REASONS.FORBIDDEN, '缺少可驗證的管理員身份；本次零寫入。')
  }
  if (normalizePhone(identity.phone) !== expected) {
    return deny(REASONS.FORBIDDEN, '僅管理員可以執行此操作（手機號不在白名單）；本次零寫入。')
  }
  return null
}

/** 归一化 `where(...).update(...)` 的返回为「受影响行数」（读不出 ⇒ `null`，不作强判）。 */
function updatedCountOf(result) {
  if (!result || typeof result !== 'object') return null
  const candidates = [result.updated, result.modified, result.matched, result.data && result.data.updated]
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  }
  return null
}

/** 归一化一行 `where(...).get()` / `doc(...).get()` 的返回（兼容 `{data:[...]}` 与裸数组）。 */
function rowsOf(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.data)) return result.data
  if (result && result.data && typeof result.data === 'object') return [result.data]
  return []
}

/* ---------------------------------------------------------------------------
   **识别编码号源（口径件 §3｜R-2）**：`xiai_counters`（`_id` ∈ `seal` / `face`，文档含 `seq`）。
   · **服务端专用集合**：**不进** `CLOUD_COLLECTIONS` / `CLOUD_COLLECTION_KEYS` / `CLOUD_KEY_OF_LOCAL`
     （客户端零读面），也**不进**本文件的 `COLLECTIONS`（那是既有 13 个集合的读写面登记表；
     号源只由下面 `issueCodeNumber` 一处读写，单点即审计点）。
   · 号域上限沿编码器容量（`codeId.SID_MAX - 1` / `codeId.FID_MAX - 1`）⇒ 越界结构化拒绝。
   --------------------------------------------------------------------------- */
const COUNTERS_COLLECTION = 'xiai_counters'
const COUNTER_IDS = Object.freeze({ seal: 'seal', face: 'face' })
const COUNTER_CAPACITY = Object.freeze({ seal: codeId.SID_MAX - 1, face: codeId.FID_MAX - 1 })
const COUNTER_MAX_ATTEMPTS = 8

/**
 * **原子发号（唯一号源）**：按 `_id` 认领计数文档的下一个号。
 *
 * 实现口径 ＝ **单文档条件更新（CAS）＋ SDK 原子自增算子 `db.command.inc(1)`**：
 *   ① `readRows(COUNTERS_COLLECTION, {_id})` 读当前 `seq`（与本文件其它读点同一入口）；
 *   ② 文档不存在 ⇒ `add({_id, seq: 1})`（`_id` 冲突 ＝ 并发建行 ⇒ 重读重试）；
 *   ③ 文档存在 ⇒ `where({_id, seq: 当前值}).update({seq: db.command.inc(1)})`
 *      —— 过滤条件**锁住旧值** ⇒ 单文档原子更新下恰一路认领成功；`updated === 1` ⇒ 号 ＝ 旧值+1；
 *      `updated === 0`（并发抢先）⇒ 重读重试；**`updated` 读不出（null）⇒ 一律按失败重读**
 *      （宁可留下空洞，也**绝不把同一个号发给两路** —— AC §6.4「无重号」优先）。
 *
 * 为什么不用「`_.inc(1)` ＋ 读回新值」：`@cloudbase/node-sdk` 的 `update()` 回包**只含 `updated`
 * 计数、不含自增后的新值**（本仓既有 `updatedCountOf` 只读 `updated` 即为实据）⇒ 必须读回；
 * 而读回与另一路的 `inc` 交错会把同一个号发给两路 ⇒ 违反 AC §6.4。故取 CAS：
 * 认领成功与否由**服务端单文档更新**裁决，号由「被锁住的旧值 + 1」确定性得出，**无重号**。
 *
 * @param {'seal'|'face'} kind 号别
 * @returns {Promise<{ok:true, no:number}|{ok:false, reason:string, message:string}>}
 */
async function issueCodeNumber(kind) {
  const id = COUNTER_IDS[kind]
  if (!id) return deny(REASONS.INVALID_VALUE, `未知的識別編號發號類別：${String(kind)}；本次零寫入。`)
  const capacity = COUNTER_CAPACITY[kind]
  const db = resolveDb()
  for (let attempt = 0; attempt < COUNTER_MAX_ATTEMPTS; attempt += 1) {
    const rows = await readRows(COUNTERS_COLLECTION, { _id: id })
    if (rows.length === 0) {
      /* 首次发号：以**既有行的最大号**播种（迁移后 `seq` ＝ 已分配总数 ⇒ 采纳从 N+1 起），
         避免计数器与既有 `seal_no` / `face_no` 分裂出重号。 */
      let base = 0
      if (kind === 'seal') {
        const seals = await readRows(COLLECTIONS.seals, {}, { limit: 1000 })
        seals.forEach((row) => {
          const own = Number(row && row.seal_no)
          if (Number.isInteger(own) && own > base) base = own
        })
      } else {
        const faces = await readRows(COLLECTIONS.faces, {}, { limit: 1000 })
        faces.forEach((row) => {
          const own = Number(row && row.face_no)
          if (Number.isInteger(own) && own > base) base = own
        })
      }
      if (base >= capacity) {
        return deny(REASONS.INVALID_VALUE, `識別編碼號源已達容量上限（${capacity}）；本次零寫入。`)
      }
      try {
        await db.collection(COUNTERS_COLLECTION).add({ _id: id, seq: base, updated_at: text(new Date().toISOString()) })
      } catch (error) {
        continue /* 并发建行冲突 ⇒ 重读重试 */
      }
      /* 建行后按 CAS 认领 base+1（建行写入的 `seq: base` 是「已发放到 base」的基线）。 */
      continue
    }
    const current = Number(rows[0].seq)
    if (!Number.isFinite(current) || current < 0 || Math.floor(current) !== current) {
      return deny(REASONS.INVALID_VALUE, '計數文檔形態不合法（seq 非非負整數）；本次零寫入。')
    }
    if (current >= capacity) {
      return deny(REASONS.INVALID_VALUE, `識別編碼號源已達容量上限（${capacity}）；本次零寫入。`)
    }
    const command = db && db.command
    const increment = command && typeof command.inc === 'function' ? command.inc(1) : current + 1
    const reply = await db
      .collection(COUNTERS_COLLECTION)
      .where({ _id: id, seq: current })
      .update({ seq: increment, updated_at: text(new Date().toISOString()) })
    const updated = updatedCountOf(reply)
    if (updated === 1) return { ok: true, no: current + 1 }
    if (updated === null) {
      /* 计数读不出 ⇒ **按失败重读**（宁留空洞、不发重号）。 */
      continue
    }
    /* updated === 0 ⇒ 并发抢先 ⇒ 重读重试。 */
  }
  return deny(REASONS.STORAGE_UNAVAILABLE, '識別編號發號競爭超時；本次零寫入。')
}

/**
 * 发号 ＋ **避开既有行占位**（采纳路径专用）：撞号继续取下一个号，**绝不改写既有行**。
 * @param {'seal'|'face'} kind 号别
 * @param {(no:number)=>boolean} isTaken 既有行是否已占该号
 */
async function issueCodeNumberAvoiding(kind, isTaken) {
  for (let guard = 0; guard < 128; guard += 1) {
    const issued = await issueCodeNumber(kind)
    if (!issued.ok) return issued
    if (!isTaken(issued.no)) return issued
  }
  return deny(REASONS.STORAGE_UNAVAILABLE, '識別編號發號撞號重試超限；本次零寫入。')
}

/**
 * 按勘误单号读**私有**行（`xiai_corrections`）。
 * 先按业务键 `id` 检索；未命中再按文档 `_id` 兜底（兼容以文档 id 直接落库的历史行）。
 * **只读**：不产生任何写入。与管理员函数 `readCorrectionRow` **同口径**。
 * @param {string} correctionId
 * @returns {Promise<{row:object, match:object}|null>} `match` ＝ 命中所用的检索式（更新时复用）
 */
async function readCorrectionRow(correctionId) {
  const db = resolveDb()
  const collection = db.collection(COLLECTIONS.corrections)
  const byId = await collection.where({ id: correctionId }).get()
  const rowsById = rowsOf(byId)
  if (rowsById.length > 0) return { row: rowsById[0], match: { id: correctionId } }
  const byDoc = await collection.doc(correctionId).get()
  const rowsByDoc = rowsOf(byDoc)
  if (rowsByDoc.length > 0) return { row: rowsByDoc[0], match: { _id: correctionId } }
  return null
}

/**
 * 由私有行 + 决定构造**公开只读投影行**（**封闭键面**；**零身份字段**）。
 * 与管理员函数 `buildProjection` **逐字同形**。
 */
function buildProjection(row, decision, at, correctionId) {
  const field = text(row.field)
  return {
    correction_id: text(row.id) || text(correctionId),
    faceId: text(row.faceId),
    sealId: text(row.sealId || row.stamp_id),
    stamp_id: text(row.stamp_id || row.sealId),
    field,
    field_label: text(row.field_label) || MARKABLE_FIELDS[field] || '',
    value: text(row.value),
    status: decision,
    reviewed_at: at,
    updated_at: at,
    schema: PUBLIC_SCHEMA
  }
}

/* ---------------------------------------------------------------------------
   **本单改造（斐萃令牌）**：签发面的**载荷封闭键面**。
   `target`（uid 或手机号）/ `role` / `ttl_seconds` 三键之外一律 `INVALID_FIELD`；
   令牌本体、`jti`、`kid`、`iat` / `exp` 全由服务端产出 ⇒ 前端**没有任何身份类键**可传。
   --------------------------------------------------------------------------- */
const FEICUI_TOKEN_ALLOWED_KEYS = Object.freeze(['target', 'role', 'ttl_seconds'])

/* ---------------------------------------------------------------------------
   **積分賬本面（「金」上雲｜本單新增 op）**：载荷封闭键面 ＋ 键面门。
   `getPointsBalance` **零载荷键**（读本人余额，无参）；`listPointsFlow` 只认
   `limit` / `cursor` 两键；**身份类键一律不在白名单内** ⇒ `INVALID_FIELD` ＋ 零写入
   （身份永远取自已验签令牌，不采信前端自报）。
   --------------------------------------------------------------------------- */
const POINTS_BALANCE_ALLOWED_KEYS = Object.freeze([])
const POINTS_FLOW_ALLOWED_KEYS = Object.freeze(['limit', 'cursor'])

/* ---------------------------------------------------------------------------
   **AI 金鑰 / 用量面（本單新增 5 個用戶 op）**：载荷封闭键面 ＋ 键面门。
   · `issueAiKey` 只认 `label` / `day_limit` / `minute_limit`；`listAiKeys` / `getAiUsage`
     **零载荷键**（读本人数据，无参）；`revokeAiKey` 只认 `key_id`；`updateAiKeyLimits` 只认
     `key_id` / `day_limit` / `minute_limit`；
   · **身份类键（`uid` / `userId` / `user_id` / `role` / `phone` …）与明文 / 摘要类键
     （`key` / `key_hash` …）一律不在白名单内** ⇒ `INVALID_FIELD` ＋ 零写入
     （身份永远取自已验签令牌，不采信前端自报；明文金鑰只由服务端铸造）。
   · 键面门复用 `pointsPayloadDenial`（形态 ＋ 封闭键面；判定早于任何读 / 写）。
   --------------------------------------------------------------------------- */
const AI_KEY_ISSUE_ALLOWED_KEYS = Object.freeze(['label', 'day_limit', 'minute_limit'])
const AI_KEY_LIST_ALLOWED_KEYS = Object.freeze([])
const AI_KEY_REVOKE_ALLOWED_KEYS = Object.freeze(['key_id'])
const AI_KEY_LIMITS_ALLOWED_KEYS = Object.freeze(['key_id', 'day_limit', 'minute_limit'])
const AI_USAGE_ALLOWED_KEYS = Object.freeze([])

/* **AI 上游配置面（本單新增 2 個管理員 op）**：载荷封闭键面 —— `actor_uid` **不由载荷自称**
   （服务端从 `identity.uid` 派生）；`key` 是**上游明文金鑰**（服务端加密落库，不回包）。 */
const AI_UPSTREAM_ALLOWED_KEYS = Object.freeze(['base_url', 'model', 'key', 'timeout_ms'])
/** 读面（`getAiUpstream`）**零允许键**（读配置无参；任何键 ⇒ `INVALID_FIELD` ＋ 零写入）。 */
const AI_UPSTREAM_ALLOWED_KEYS_VIEW = Object.freeze([])

/**
 * 积分两 op 的载荷键面门（形态 ＋ 封闭键面；判定早于任何读 / 写）。
 * @param {object} payload
 * @param {ReadonlyArray<string>} allowedKeys
 * @returns {null|{ok:false, reason:string, message:string}}
 */
function pointsPayloadDenial(payload, allowedKeys) {
  if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
  }
  const unknown = Object.keys(payload).filter((key) => allowedKeys.indexOf(key) === -1)
  if (unknown.length > 0) {
    const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
    const hint =
      identityKeys.length > 0
        ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
        : '如實報回，不靜默丟鍵'
    return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
  }
  return null
}

/* ---------------------------------------------------------------------------
   op 注册面（每个 op 只**产出落盘计划**，落库在 `persist()`）
   --------------------------------------------------------------------------- */

const OPS = Object.freeze({
  /**
   * 提交勘误（**用户写路径**；单集合插入）。
   * **本单追加防重门**：在任何写入之前，若同 `(faceId, field, value)` 已有行 ⇒ `DUPLICATE_VALUE`
   * ＋ 零写入（同一段文字只允许一人提交，第二人应改用【採信】）。
   * @param {object} payload 载荷（允许键见 `ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份（唯一来源；载荷里的身份键无效）
   * @returns {Promise<{ok:true, op:string, row:object, plan:{collection:string, doc:object}}|{ok:false, reason:string, message:string}>}
   */
  async submitCorrection(payload, identity) {
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const faceId = text(payload.faceId)
    const sealId = text(payload.sealId)
    const stampId = text(payload.stampId)
    const field = text(payload.field)
    const value = text(payload.value)
    const basis = text(payload.basis)
    if (!faceId) return deny(REASONS.MISSING_REQUIRED, '缺少印面（faceId）⇒ 拒絕提交；本次零寫入。')
    if (Object.prototype.hasOwnProperty.call(MARKABLE_FIELDS, field) !== true) {
      return deny(REASONS.INVALID_FIELD, `該屬性不支持勘誤（field）：${field || '（空）'}；本次零寫入。`)
    }
    if (!value) return deny(REASONS.MISSING_REQUIRED, '缺少勘誤值（value）⇒ 拒絕提交；本次零寫入。')
    if (value.length > MAX_TEXT_LENGTH || basis.length > MAX_TEXT_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `勘誤文字超出上限（${MAX_TEXT_LENGTH} 字）⇒ 拒絕提交；本次零寫入。`)
    }
    /* **作者引用型判定（person-model §4.2）**：`author` 的载荷值是 `author_person_id` ⇒
       必须指向**既有印人**（服务端权威判据，**写之前**）；库中无此人 ⇒ 结构化拒绝
       （沿用既有字面值 `INVALID_VALUE`；**不新增 reason**）＋ 零写入。 */
    if (field === 'author') {
      const person = await readPersonRow(value)
      if (!person) {
        return deny(
          REASONS.INVALID_VALUE,
          `該印面「作者」引用的印人（${value || '（空）'}）在庫中不存在 ⇒ 拒絕提交；` +
            '請先提交印人提案、經管理員審覈通過後再選；本次零寫入。'
        )
      }
    }
    if (!identityUsable(identity)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的提交人身份；本次零寫入。')
    }
    /* **提交侧防重（本单追加）**：同 `(faceId, field, value)` 已有行（含云端：以服务端为准）
       ⇒ 同一段文字只允许一人提交；第二人应改用【採信】。**判定在任何写入之前**（只读）。 */
    const duplicate = await readRows(COLLECTIONS.corrections, { faceId, field, value })
    if (duplicate.length > 0) {
      return deny(
        REASONS.DUPLICATE_VALUE,
        `該印面「${MARKABLE_FIELDS[field]}」已有完全相同的提交值「${value}」⇒` +
          '同一段文字只允許一人提交；若你贊同該值，請改用【採信】為它佐證；本次零寫入。'
      )
    }
    const at = new Date().toISOString()
    const row = {
      id: makeId(),
      faceId,
      sealId: sealId || stampId, // 规范字段：所属印章
      stamp_id: sealId || stampId, // 兼容别名：＝sealId，勿删
      userId: identity.uid, // 规范字段：提交人（**服务端派生、不可反推手机号**）
      user_id: identity.uid, // 兼容别名：＝userId（**服务端派生**）
      /* **业务行不再落手机号**（人类口径 ②）：新行无 `user_phone` 键；
         旧行保留不改、读路径容忍缺键（**不得据旧行仍含 `user_phone` 判负**）。 */
      identity_source: identitySourceOf(identity), // 取证用：身份来源标记（令牌路 SERVER_TOKEN / 会话路 SESSION）
      field,
      field_label: MARKABLE_FIELDS[field],
      value,
      basis,
      status: CORRECTION_PENDING,
      created_at: at,
      reviewed_at: null,
      reviewer_id: null,
      rewarded_at: null
    }
    /* **摘要行重算（本单）**：提交成功后 upsert 该 `(faceId, field, value)` 的**值级公开摘要行**
       （`submits` 含本次新增行 ⇒ 1；`status` 自 `PENDING` 起；`submitter_uids` ＝ 本人 uid）。 */
    const summaryRow = buildCorrectionSummary({
      faceId,
      sealId: row.sealId,
      field,
      value,
      submissions: [...duplicate, row],
      endorsements: [],
      at
    })
    return {
      ok: true,
      op: 'submitCorrection',
      row,
      summary: summaryRow,
      plan: {
        writes: [
          { kind: 'add', collection: COLLECTIONS.corrections, doc: row },
          { kind: 'set', collection: COLLECTIONS.correctionSummaries, id: summaryRow._id, doc: summaryRow }
        ]
      }
    }
  },

  /**
   * **採信**（用户写路径；本单新增 op）：对他人同 `(faceId, field, value)` 的提交点「採信」，
   * 只作**佐证 / 可信度计数**，不改变对外展示（生效仍由管理员采纳决定）。
   *
   * 顺序（**全部判定与读取都在写入之前**）：
   *   ① 载荷键面（封闭：`ENDORSE_ALLOWED_KEYS`；身份类键 ⇒ `INVALID_FIELD`）；
   *   ② 值域门：字段 ∈ `MARKABLE_FIELDS`、faceId 非空、value 非空且 ≤ 500 字；
   *   ③ **不得自采**：同 `(faceId, field, value)` 的**提交人就是本人** ⇒ 拒（`FORBIDDEN`；
   *      理由用**待规范单确认的新字面值**，暂用 `FORBIDDEN` 并逐字登记）；
   *   ④ **幂等**：同 `(faceId, field, value, user_id)` 已有采信行 ⇒ `ALREADY_ENDORSED` ＋ 零写入；
   *   ⑤ 成功 ⇒ 两处落盘：采信行（私有）＋ 公开计数行（**重算 count**、幂等 upsert、零身份字段）。
   *
   * 采信行形状（服务端落盘、私有集合 `xiai_endorsements`）：
   *   `{ _id, faceId, sealId, stamp_id, field, value, user_id, identity_source:'SERVER_TOKEN', created_at }`
   *   （**不落手机号**：`user_id` 是不透明 uid；人类口径 ②）
   * 值级公开摘要行形状（`xiai_correction_summaries`、**零手机号**、uid 允许）：
   *   `{ _id:`cs-<faceId>-<field>-<value 的 sha256 前 16 位>`, faceId, sealId, stamp_id, field, value,
   *     submits, endorses, status, submitter_uids, updated_at, schema }`
   * @param {object} payload 载荷（允许键见 `ENDORSE_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   */
  async endorseCorrection(payload, identity) {
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => ENDORSE_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const faceId = text(payload.faceId)
    const sealId = text(payload.sealId)
    const stampId = text(payload.stampId)
    const field = text(payload.field)
    const value = text(payload.value)
    if (!faceId) return deny(REASONS.MISSING_REQUIRED, '缺少印面（faceId）⇒ 拒絕採信；本次零寫入。')
    if (Object.prototype.hasOwnProperty.call(MARKABLE_FIELDS, field) !== true) {
      return deny(REASONS.INVALID_FIELD, `該屬性不支持採信（field）：${field || '（空）'}；本次零寫入。`)
    }
    if (!value) return deny(REASONS.MISSING_REQUIRED, '缺少採信值（value）⇒ 拒絕採信；本次零寫入。')
    if (value.length > MAX_TEXT_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `採信文字超出上限（${MAX_TEXT_LENGTH} 字）⇒ 拒絕採信；本次零寫入。`)
    }
    if (!identityUsable(identity)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的採信人身份；本次零寫入。')
    }
    /* ③ **不得自采**：读同值的提交行，若提交人就是本人 ⇒ 拒（待规范单确认的**新字面值**，
       暂用 `FORBIDDEN` 并逐字登记 ⇒ 便于规范侧改名）。 */
    const submissions = await readRows(COLLECTIONS.corrections, { faceId, field, value })
    const submitters = submissions
      .map((item) => text(item && (item.user_id || item.userId)))
      .filter((id) => id !== '')
    if (submitters.indexOf(identity.uid) !== -1) {
      return deny(
        REASONS.FORBIDDEN,
        '該值就是你自己的提交，不能對自己的提交採信；本次零寫入。'
      )
    }
    /* ④ **幂等**：同 `(faceId, field, value, user_id)` 已有采信行 ⇒ 拒 ＋ 零写入。 */
    const mine = await readRows(COLLECTIONS.endorsements, {
      faceId,
      field,
      value,
      user_id: identity.uid
    })
    if (mine.length > 0) {
      return deny(
        REASONS.ALREADY_ENDORSED,
        '你已經採信過該值（同一段文字只記一次）；本次零寫入。'
      )
    }
    /* ⑤ 成功：构造两处落盘计划（采信行 ＋ 值级公开摘要行）。 */
    const normalizedSeal = sealId || stampId
    const at = new Date().toISOString()
    const endorsementId = endorsementDocId(faceId, field, value, identity.uid)
    const row = {
      _id: endorsementId,
      faceId,
      sealId: normalizedSeal,
      stamp_id: normalizedSeal,
      field,
      value,
      user_id: identity.uid,
      /* **业务行不再落手机号**（人类口径 ②）：采信私有行只落不透明 uid。 */
      identity_source: identitySourceOf(identity),
      created_at: at
    }
    /* **摘要行重算（自愈）**：读该键的全部采信行（含本次新增的那一行）＋ 该键的提交行，
       重算 `submits` / `endorses` / `status` / `submitter_uids` ⇒ 重试 / 重放 / 并发落同一 `_id`
       都不会把计数涨多；**绝不**用「原计数 ＋ 1」。 */
    const all = await readRows(COLLECTIONS.endorsements, { faceId, field, value })
    const endorsements = [...all, { _id: endorsementId, user_id: identity.uid }]
    const summaryRow = buildCorrectionSummary({
      faceId,
      sealId: normalizedSeal,
      field,
      value,
      submissions,
      endorsements,
      at
    })
    return {
      ok: true,
      op: 'endorseCorrection',
      row,
      /* 值级公开摘要行（**零手机号**、uid 允许；服务端下发面 ⇒ 前端只做镜像，不在前端重建）。 */
      summary: summaryRow,
      plan: {
        writes: [
          { kind: 'set', collection: COLLECTIONS.endorsements, id: endorsementId, doc: row },
          { kind: 'set', collection: COLLECTIONS.correctionSummaries, id: summaryRow._id, doc: summaryRow }
        ]
      }
    }
  },

  /**
   * **影像產物登記（本單新增 op｜`registerArtifact`）**：客户端**直传云存储**之后，由服务端
   * **回读该对象、自行重算 `sha256` 与字节数**，与客户端声称值**逐字比对**。
   *
   * 顺序（**判定全部在回读之前，且本 op 零落盘** —— 不产出 `plan` ⇒ `index.js` 不落任何集合）：
   *   ① 载荷形态 / 键面（封闭 `ARTIFACT_ALLOWED_KEYS`；身份类键 ⇒ `INVALID_FIELD`）；
   *   ② 值域门：`sha256` 64 位小写十六进制；`cloudPath` 匹配
   *      `xiai/images/<摘要前两位>/<摘要>.tiff` **且键内摘要 ≡ 声称摘要**（一路径只能指一份内容）；
   *      `bytesLength` 正整数且 ≤ 4 MiB（与产物侧上限同值 ⇒ 回读有界）；
   *   ③ 回读对象（服务端；失败 ⇒ `STORAGE_UNAVAILABLE`，**绝不伪装 `FORBIDDEN`**）；
   *   ④ 空内容 / 容器墨数不是 TIFF（`II*\0` / `MM\0*`）⇒ `INVALID_VALUE`（**不新增 reason 字面值**）；
   *   ⑤ **逐字比对**：重算摘要 / 重算字节数与声称值**任一不符** ⇒ `INVALID_VALUE` ＋ 零写入
   *      （回包**不吐任何真值** —— 不让本 op 变成「按路径查摘要」的探测器）；
   *   ⑥ 一致 ⇒ 扁平回包 `{ok:true, sha256, bytesLength, mime, storageKey, idempotent}`
   *      ＋ 同一对象的 `artifact` 分组视图（供信封 / 客户端逐字透传；不改动扁平六键任一）。
   *
   * `idempotent`（本 op 语义）＝ **本次调用未产生任何写入**（对象已以该摘要存在且一致）⇒ 恒 `true`。
   * 客户端对外回包的 `idempotent`（＝「本轮之前对象是否已存在」）由客户端按**同一读面机制**自行判定。
   * @param {object} payload 载荷（允许键见 `ARTIFACT_ALLOWED_KEYS`）
   * @returns {Promise<object>} 成功 ⇒ 扁平回包；失败 ⇒ 恰 3 键结构化拒绝
   */
  async registerArtifact(payload) {
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => ARTIFACT_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const cloudPath = text(payload.cloudPath)
    const digest = text(payload.sha256).toLowerCase()
    const claimed = payload.bytesLength
    const matched = ARTIFACT_OBJECT_KEY_PATTERN.exec(cloudPath)
    if (!matched) {
      return deny(
        REASONS.INVALID_VALUE,
        '影像對象鍵形態不符（期望 xiai/images/<摘要前兩位>/<摘要>.tiff）；本次零寫入。'
      )
    }
    if (!ARTIFACT_DIGEST_PATTERN.test(digest)) {
      return deny(REASONS.INVALID_VALUE, '摘要（sha256）必須是 64 位小寫十六進制；本次零寫入。')
    }
    if (matched[2] !== digest || matched[1] !== digest.slice(0, 2)) {
      return deny(REASONS.INVALID_VALUE, '影像對象鍵內含的摘要與聲稱的 sha256 不一致；本次零寫入。')
    }
    if (!Number.isInteger(claimed) || claimed <= 0 || claimed > ARTIFACT_MAX_BYTES) {
      return deny(
        REASONS.INVALID_VALUE,
        `字節數（bytesLength）必須是 1 〜 ${ARTIFACT_MAX_BYTES} 之間的整數；本次零寫入。`
      )
    }
    let bytes = null
    try {
      bytes = await readArtifactBytes(cloudPath)
    } catch {
      /* 「對象不存在」与「存储不可用」在服务端都表现为取不到 ⇒ 一律 `STORAGE_UNAVAILABLE`
         （**不得伪装 `FORBIDDEN`**；也不吐内部原因）。 */
      return deny(REASONS.STORAGE_UNAVAILABLE, '雲端對象存儲不可用或該影像對象不存在；本次零寫入。')
    }
    if (bytes.length === 0) {
      return deny(REASONS.INVALID_VALUE, '影像對象為空內容；本次零寫入。')
    }
    const mime = artifactMimeOf(bytes)
    if (!mime) {
      return deny(
        REASONS.INVALID_VALUE,
        '該對象不是本面認可的影像容器（存儲件應為單頁 8bit Deflate TIFF）；本次零寫入。'
      )
    }
    const actual = crypto.createHash('sha256').update(bytes).digest('hex')
    if (actual !== digest || bytes.length !== claimed) {
      /* **不吐真值**（摘要 / 真体量都不回）—— 不把本 op 变成探测器。 */
      return deny(REASONS.INVALID_VALUE, '回讀校驗失敗：對象的字節數或摘要與聲稱值不一致；本次零寫入。')
    }
    /* 扁平六键（brief 冻结形态）＋ 同一对象的 `artifact` 分组视图（供信封 / 客户端透传）。 */
    const verified = { sha256: actual, bytesLength: bytes.length, mime, storageKey: cloudPath, idempotent: true }
    return {
      ok: true,
      sha256: verified.sha256,
      bytesLength: verified.bytesLength,
      mime: verified.mime,
      storageKey: verified.storageKey,
      idempotent: verified.idempotent,
      artifact: verified
    }
  },

  /**
   * **展示件轉碼（本單新增 op｜`ensureDisplayArtifact`）**：瀏覽器不能原生解 TIFF ⇒
   * 新上傳的 `.tiff` 原圖在線上無法顯示。本 op 在**服務端**把原圖轉碼成展示件 PNG，
   * 並上傳到**同目錄同名內容尋址鍵** `xiai/images/<摘要前兩位>/<摘要>.png`。
   *
   * 順序（**鍵形態判定全部在讀回之前**；本 op 不落任何集合 —— 不產出 `plan` ⇒ `index.js`
   * 的落盤分支不觸發，僅寫對象存儲）：
   *   ① 載荷形態 / 鍵面（封閉 `DISPLAY_ALLOWED_KEYS`：只有 `cloudPath` / `sha256`）；
   *   ② 鍵形態自校驗：`xiai/images/<摘要前兩位>/<摘要>.tiff` 且鍵內摘要 ≡ 聲稱摘要
   *      ⇒ 否則拒**且不讀**（一路徑只能指一份內容）；
   *   ③ 讀回原對象（失敗 ⇒ `STORAGE_UNAVAILABLE`，**絕不偽裝 `FORBIDDEN`**）；
   *   ④ 空內容 / 容器墨數不是 TIFF ⇒ `INVALID_VALUE`；**重算摘要 ≠ 鍵內摘要** ⇒ `INVALID_VALUE`
   *      （內容尋址完整性：不轉碼「內容與鍵不符」的對象，也不吐真值）；
   *   ⑤ `tiffToPng`（純 JS 轉碼器；不支持的變體 ⇒ `TIFF_UNSUPPORTED` ⇒ 一律 `INVALID_VALUE`，
   *      **不新增 reason 字面值**）；
   *   ⑥ 上傳展示件（**內容尋址 ⇒ 天然冪等**：重複調用安全，不做存在性探測，同鍵覆寫同內容）；
   *      上傳失敗 ⇒ `STORAGE_UNAVAILABLE`；
   *   ⑦ 成功回包 `{ok:true, sha256, displayKey, bytesLength, width, height}` ＋ `display` 分組視圖。
   *
   * **失敗隔離（本 op 的硬口徑）**：本 op 的任何失敗都**不影響已成功的上傳 / 落行** ——
   * 客戶端把它當 best-effort（失敗只結構化登記、不上拋、不阻斷行寫入，
   * 見 `src/services/imageAuthority.js` 的 B 路）。
   * @param {object} payload 载荷（允许键见 `DISPLAY_ALLOWED_KEYS`）
   * @returns {Promise<object>} 成功 ⇒ 扁平回包 ＋ `display` 分组视图；失败 ⇒ 恰 3 键结构化拒绝
   */
  async ensureDisplayArtifact(payload) {
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => DISPLAY_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const cloudPath = text(payload.cloudPath)
    const digest = text(payload.sha256).toLowerCase()
    /* ② 鍵形態自校驗（**讀回之前**；與 `registerArtifact` 同一張形態表）。 */
    const matched = ARTIFACT_OBJECT_KEY_PATTERN.exec(cloudPath)
    if (!matched) {
      return deny(
        REASONS.INVALID_VALUE,
        '影像對象鍵形態不符（期望 xiai/images/<摘要前兩位>/<摘要>.tiff）；本次零寫入。'
      )
    }
    if (!ARTIFACT_DIGEST_PATTERN.test(digest)) {
      return deny(REASONS.INVALID_VALUE, '摘要（sha256）必須是 64 位小寫十六進制；本次零寫入。')
    }
    if (matched[2] !== digest || matched[1] !== digest.slice(0, 2)) {
      return deny(REASONS.INVALID_VALUE, '影像對象鍵內含的摘要與聲稱的 sha256 不一致；本次零寫入。')
    }
    /* ③ 讀回原對象。 */
    let bytes = null
    try {
      bytes = await readArtifactBytes(cloudPath)
    } catch {
      return deny(REASONS.STORAGE_UNAVAILABLE, '雲端對象存儲不可用或該影像對象不存在；本次零寫入。')
    }
    if (bytes.length === 0) {
      return deny(REASONS.INVALID_VALUE, '影像對象為空內容；本次零寫入。')
    }
    if (!artifactMimeOf(bytes)) {
      return deny(
        REASONS.INVALID_VALUE,
        '該對象不是本面認可的影像容器（源件應為單頁 8bit Deflate TIFF）；本次零寫入。'
      )
    }
    /* ④ 內容尋址完整性：鍵名摘要 ≡ 對象真身摘要（**不采信客戶端自稱**；不吐真值）。 */
    const actual = crypto.createHash('sha256').update(bytes).digest('hex')
    if (actual !== digest) {
      return deny(REASONS.INVALID_VALUE, '回讀校驗失敗：對象的摘要與鍵內摘要不一致；本次零寫入。')
    }
    /* ⑤ 轉碼（純 JS；不支持的變體 ⇒ 結構化拒絕，**不新增 reason 字面值**）。 */
    let decoded = null
    try {
      decoded = await tiffToPng(bytes)
    } catch {
      return deny(
        REASONS.INVALID_VALUE,
        '原圖轉碼失敗：該 TIFF 不是本面支持的單頁 8bit Deflate RGB 形態；本次零寫入。'
      )
    }
    /* ⑥ 上傳展示件（內容尋址鍵；冪等覆寫，不做存在性探測）。 */
    const displayKey = `xiai/images/${matched[1]}/${matched[2]}.png`
    try {
      await uploadDisplayArtifactBytes(displayKey, decoded.png)
    } catch {
      return deny(REASONS.STORAGE_UNAVAILABLE, '展示件上傳失敗（雲端存儲不可用）；本次零寫入。')
    }
    /* ⑦ 成功回包（brief 冻结形态）＋ `display` 分組視圖（供信封 / 客戶端逐字透傳）。 */
    const display = {
      sha256: digest,
      displayKey,
      bytesLength: decoded.png.length,
      width: decoded.width,
      height: decoded.height
    }
    return {
      ok: true,
      op: 'ensureDisplayArtifact',
      sha256: display.sha256,
      displayKey: display.displayKey,
      bytesLength: display.bytesLength,
      width: display.width,
      height: display.height,
      display
    }
  },

  /**
   * **提交印人提案（§3；任何登录用户）**：封闭键面 → 至少一处姓名 / 字 / 号 / 别名 →
   * 引用型目标（修改既有）存在性 → **防重键**（同 `(target_person_id, 姓名, 生卒, cbdb_id)`
   * 已有未驳回提案 ⇒ `DUPLICATE_VALUE` ＋ 零写入）→ 落 `xiai_person_proposals`
   * （**提交人 uid 由服务端派生、零手机号**）。
   * @param {object} payload 载荷（允许键见 `PERSON_PROPOSAL_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   * @returns {Promise<{ok:true, op:string, row:object, plan:object}|{ok:false, reason:string, message:string}>}
   */
  async submitPersonProposal(payload, identity) {
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => PERSON_PROPOSAL_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const family = text(payload.family_name)
    const given = text(payload.given_name)
    const asArray = (value) => (Array.isArray(value) ? value.map((item) => text(item)).filter((item) => item !== '') : [])
    const courtesy = asArray(payload.courtesy_names)
    const art = asArray(payload.art_names)
    const alias = asArray(payload.alias_names)
    if (!family && !given && courtesy.length === 0 && art.length === 0 && alias.length === 0) {
      return deny(REASONS.MISSING_REQUIRED, '請至少填寫姓名 / 字 / 號 / 別名之一 ⇒ 拒絕提交；本次零寫入。')
    }
    if (!identityUsable(identity)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的提交人身份；本次零寫入。')
    }
    const target = text(payload.target_person_id)
    if (target) {
      const person = await readPersonRow(target)
      if (!person) return deny(REASONS.NOT_FOUND, `要修改的印人（${target}）不存在 ⇒ 拒絕提交；本次零寫入。`)
    }
    const toInt = (value) => {
      if (value === null || value === undefined || value === '') return null
      const num = Number(value)
      return Number.isFinite(num) ? Math.round(num) : null
    }
    const birth = toInt(payload.birth_year)
    const death = toInt(payload.death_year)
    const cbdb = text(payload.cbdb_id)
    const dedupe = [target, `${family}${given}`, birth === null ? '' : String(birth), death === null ? '' : String(death), cbdb].join('|')
    const duplicates = await readRows(COLLECTIONS.personProposals, { dedupe_key: dedupe })
    if (duplicates.some((row) => text(row && row.status) !== CORRECTION_STATUS.REJECTED)) {
      return deny(REASONS.DUPLICATE_VALUE, '同一印人（姓名 ＋ 生卒 ＋ cbdb_id）已有待審提案 ⇒ 只允許一人提交；本次零寫入。')
    }
    const at = new Date().toISOString()
    const row = {
      id: `${PERSON_PROPOSAL_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      batch_id: text(payload.batch_id),
      target_person_id: target || null,
      status: PERSON_PROPOSAL_STATUS.PENDING,
      family_name: family,
      given_name: given,
      courtesy_names: courtesy,
      art_names: art,
      alias_names: alias,
      birth_year: birth,
      death_year: death,
      cbdb_id: cbdb,
      card_id: text(payload.card_id),
      /* **批 2（v1.54｜§3.54.13 / §4.1.16）**：四扩字段（繁体为正）＋ 两繁简副字段 ——
         逐字透传、**不做任何转换改写**；采纳时由 `reviewPersonProposal` 映射进 `xiai_persons`。 */
      native_place: text(payload.native_place),
      biography: text(payload.biography),
      source: text(payload.source),
      source_id: text(payload.source_id),
      native_place_chs: text(payload.native_place_chs),
      biography_chs: text(payload.biography_chs),
      note: text(payload.note),
      submitted_by: identity.uid,
      submitted_at: at,
      reviewed_at: null,
      reviewer_id: null,
      review_note: '',
      dedupe_key: dedupe
    }
    return {
      ok: true,
      op: 'submitPersonProposal',
      row,
      plan: { writes: [{ kind: 'add', collection: COLLECTIONS.personProposals, doc: row }] }
    }
  },

  /**
   * **提交外部導入行（§3.54.14 / §3.54.15；外部批量導入通道）**：封閉鍵面 → 冪等鍵必有 →
   * **冪等**（同 `source_person_id` 已有行 ⇒ 原樣返回、不改寫既有行）→ 至少一處姓名 / 字 / 號 / 別名
   * → 落 `xiai_person_imports`（**status 初始 `PENDING`；導入人 uid 由服務端派生、零手機號**）。
   * @param {object} payload 载荷（允许键见 `PERSON_IMPORT_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   * @returns {Promise<{ok:boolean, op:string, row?:object, idempotent?:boolean, plan?:object, reason?:string, message:string}>}
   */
  async submitPersonImport(payload, identity) {
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => PERSON_IMPORT_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const sourceId = text(payload.source_person_id)
    if (!sourceId) {
      return deny(REASONS.MISSING_REQUIRED, '缺少外部冪等鍵（source_person_id）⇒ 拒絕導入；本次零寫入。')
    }
    if (sourceId.length > MAX_ID_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `外部冪等鍵超出上限（${MAX_ID_LENGTH} 字）⇒ 拒絕導入；本次零寫入。`)
    }
    const family = text(payload.family_name)
    const given = text(payload.given_name)
    const asArray = (value) => (Array.isArray(value) ? value.map((item) => text(item)).filter((item) => item !== '') : [])
    const courtesy = asArray(payload.courtesy_names)
    const art = asArray(payload.art_names)
    const alias = asArray(payload.alias_names)
    if (!family && !given && courtesy.length === 0 && art.length === 0 && alias.length === 0) {
      return deny(REASONS.MISSING_REQUIRED, '導入行請至少帶姓名 / 字 / 號 / 別名之一 ⇒ 拒絕導入；本次零寫入。')
    }
    /* **v1.57（§3.54.19 / §4.1.16 追加注）**：3 個 extraction 鍵的形態校驗 ——
       **僅在載荷提供了該鍵時**校驗：`string[]` ＋ 元素為非空字串 ＋ 與對應值陣列等長；
       **值域不封閉**（今日恒 `rule-based`，不據取值拒收）。違形態 ⇒ `INVALID_VALUE` ＋ 零寫入
       （沿既有凍結 reason 表，**零新增**）。 */
    const extractionDenial = (key, counterpart) => {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) return null
      const value = payload[key]
      if (!Array.isArray(value)) {
        return deny(REASONS.INVALID_VALUE, `載荷 ${key} 必須是陣列（string[]）⇒ 拒絕導入；本次零寫入。`)
      }
      for (const item of value) {
        if (typeof item !== 'string' || item.trim() === '') {
          return deny(REASONS.INVALID_VALUE, `載荷 ${key} 的元素必須是非空字串 ⇒ 拒絕導入；本次零寫入。`)
        }
      }
      if (value.length !== counterpart.length) {
        return deny(REASONS.INVALID_VALUE, `載荷 ${key} 必須與對應值陣列等長（${value.length} ≠ ${counterpart.length}）⇒ 拒絕導入；本次零寫入。`)
      }
      return null
    }
    const extractionPairs = [
      ['courtesy_names_extraction', courtesy],
      ['art_names_extraction', art],
      ['alias_names_extraction', alias]
    ]
    for (const [key, counterpart] of extractionPairs) {
      const denial = extractionDenial(key, counterpart)
      if (denial) return denial
    }
    if (!identityUsable(identity)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的導入人身份；本次零寫入。')
    }
    /* **冪等**（§3.54.14）：同 `source_person_id` 已有導入行 ⇒ 原樣返回（不改寫既有行）。 */
    const duplicates = await readRows(COLLECTIONS.personImports, { source_person_id: sourceId })
    if (duplicates.length > 0) {
      return { ok: true, op: 'submitPersonImport', row: duplicates[0], idempotent: true, message: '該外部冪等鍵（source_person_id）已存在導入行 ⇒ 未改寫（冪等）。' }
    }
    const toInt = (value) => {
      if (value === null || value === undefined || value === '') return null
      const num = Number(value)
      return Number.isFinite(num) ? Math.round(num) : null
    }
    const at = new Date().toISOString()
    const row = {
      id: `${PERSON_IMPORT_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      batch_id: text(payload.batch_id),
      source: text(payload.source),
      source_person_id: sourceId,
      status: PERSON_IMPORT_STATUS.PENDING,
      name_full: text(payload.name_full),
      family_name: family,
      given_name: given,
      courtesy_names: courtesy,
      courtesy_names_extraction: asArray(payload.courtesy_names_extraction),
      art_names: art,
      art_names_extraction: asArray(payload.art_names_extraction),
      alias_names: alias,
      alias_names_extraction: asArray(payload.alias_names_extraction),
      birth_year: toInt(payload.birth_year),
      death_year: toInt(payload.death_year),
      native_place: text(payload.native_place),
      native_place_chs: text(payload.native_place_chs),
      biography: text(payload.biography),
      biography_chs: text(payload.biography_chs),
      nationality: text(payload.nationality),
      cbdb_id: text(payload.cbdb_id),
      source_id: text(payload.source_id),
      imported_by: identity.uid,
      imported_at: at,
      reviewed_at: null,
      reviewer_id: null,
      review_note: ''
    }
    return {
      ok: true,
      op: 'submitPersonImport',
      row,
      plan: { writes: [{ kind: 'add', collection: COLLECTIONS.personImports, doc: row }] }
    }
  },

  /**
   * **提交印章外部導入行（§3.55.5；外部批量導入通道）**：封闭键面 → 冪等鍵（`source_seal_id`）必有 →
   * `faces[]` 至少 1 条（1..N，含边款 `kind=EDGE`）→ **源側擴面形態門（E-1：字符串（非空）/ 整數（非 0）/
   * `null`；`misc` 對象；`audit_status` 原样收）** → **冪等**（同 `source` ＋ `source_seal_id`
   * 已有行 ⇒ 原样返回、不改写既有行）→ 落 `xiai_seal_imports`（**status 初始 `PENDING`；
   * 導入人 uid 由服务端派生、零手机号**）。内容指纹只作软提示、**不构成拒收理由**。
   * `raw_json` **只落導入行**（正式集合不帶）。
   * @param {object} payload 载荷（允许键见 `SEAL_IMPORT_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   * @returns {Promise<{ok:boolean, op:string, row?:object, idempotent?:boolean, plan?:object, reason?:string, message:string}>}
   */
  async submitSealImport(payload, identity) {
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => SEAL_IMPORT_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const sourceId = text(payload.source_seal_id)
    if (!sourceId) {
      return deny(REASONS.MISSING_REQUIRED, '缺少外部冪等鍵（source_seal_id）⇒ 拒絕導入；本次零寫入。')
    }
    if (sourceId.length > MAX_ID_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `外部冪等鍵超出上限（${MAX_ID_LENGTH} 字）⇒ 拒絕導入；本次零寫入。`)
    }
    const imageStatus = sealImportImageStatusOf(payload)
    if (imageStatus === null) {
      return deny(REASONS.INVALID_VALUE, 'image_status 只允許 present / source_no_image（缺省視為 present）⇒ 拒絕導入；本次零寫入。')
    }
    const faces = Array.isArray(payload.faces) ? payload.faces.map(normalizeSealImportFace) : []
    /* **佔位圖來源門**（本單新增｜影像例外）：佔位鍵僅 sealbank（feicui）家族可引用；
       其餘來源引用 ⇒ `INVALID_VALUE` ＋ 零寫入。**通用影像引用校驗一字未改**（本門只認這一個鍵）。 */
    const placeholderDenial = sealPlaceholderRefDenial(payload.source, faces)
    if (placeholderDenial) return deny(REASONS.INVALID_VALUE, placeholderDenial)
    if (faces.length === 0 && imageStatus !== SEAL_IMPORT_IMAGE_STATUS.SOURCE_NO_IMAGE) {
      return deny(
        REASONS.MISSING_REQUIRED,
        '導入行請至少帶一個印面（faces[] 1..N，含邊款 kind=EDGE；源側無圖之印章可帶 image_status=source_no_image 例外）⇒ 拒絕導入；本次零寫入。'
      )
    }
    /* **源側擴面形態門**：任一違規 ⇒ `INVALID_VALUE` ＋ 零寫入（在寫之前、亦在冪等判定之前）。 */
    const sourceDenial = sealSourceValueDenial(payload)
    if (sourceDenial) return sourceDenial
    if (!identityUsable(identity)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的導入人身份；本次零寫入。')
    }
    const source = text(payload.source)
    /* **冪等**（§3.55.5）：同 `source` ＋ `source_seal_id` 已有導入行 ⇒ 原樣返回（不改写既有行）。 */
    const duplicates = await readRows(COLLECTIONS.sealImports, { source, source_seal_id: sourceId })
    if (duplicates.length > 0) {
      return { ok: true, op: 'submitSealImport', row: duplicates[0], idempotent: true, message: '該外部冪等鍵（source ＋ source_seal_id）已存在導入行 ⇒ 未改寫（冪等）。' }
    }
    const at = new Date().toISOString()
    const sealFields = pickSealImportSealFields(payload)
    const row = {
      id: `${SEAL_IMPORT_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      batch_id: text(payload.batch_id),
      source,
      source_seal_id: sourceId,
      status: SEAL_IMPORT_STATUS.PENDING,
      ...sealFields,
      faces,
      /* **行級缺圖標記**：只在載荷宣告時落該鍵（未提供 ⇒ 不落鍵，既有帶 faces 之載荷行為一字不變）。 */
      ...(Object.prototype.hasOwnProperty.call(payload, 'image_status') && payload.image_status !== undefined && payload.image_status !== null
        ? { image_status: imageStatus }
        : {}),
      /* `raw_json` **只落導入行**（正式集合不帶；不參與任何判定）。 */
      raw_json: payload.raw_json === undefined ? null : payload.raw_json,
      content_fingerprint: sealImportFingerprintOf(sealFields),
      imported_by: identity.uid,
      imported_at: at,
      reviewed_at: null,
      reviewer_id: null,
      review_note: ''
    }
    return {
      ok: true,
      op: 'submitSealImport',
      row,
      plan: { writes: [{ kind: 'add', collection: COLLECTIONS.sealImports, doc: row }] }
    }
  },

  /**
   * **提交印谱外部導入行（v1.61；外部批量導入通道）**：封閉鍵面 → 冪等鍵（`source_item_id`）必有 →
   * **值域 / 形態門（X6）** → **冪等**（同 `source_item_id` 已有行 ⇒ 原樣返回、不改寫既有行）→
   * 落 `xiai_item_imports`（**status 初始 `PENDING`；導入人 uid 由服務端派生、零手機號**）。
   * `raw_json` **只落導入行**（正式集合不帶）。
   * @param {object} payload 载荷（允许键见 `ITEM_IMPORT_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   * @returns {Promise<{ok:boolean, op:string, row?:object, idempotent?:boolean, plan?:object, reason?:string, message:string}>}
   */
  async submitItemImport(payload, identity) {
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => ITEM_IMPORT_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const sourceId = text(payload.source_item_id)
    if (!sourceId) {
      return deny(REASONS.MISSING_REQUIRED, '缺少外部冪等鍵（source_item_id）⇒ 拒絕導入；本次零寫入。')
    }
    if (sourceId.length > MAX_ID_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `外部冪等鍵超出上限（${MAX_ID_LENGTH} 字）⇒ 拒絕導入；本次零寫入。`)
    }
    /* **值域 / 形態門（X6）**：任一違規 ⇒ `INVALID_VALUE` ＋ 零寫入。 */
    const valueDenial = itemValueDenial(payload)
    if (valueDenial) return valueDenial
    if (!identityUsable(identity)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的導入人身份；本次零寫入。')
    }
    /* **冪等**：同 `source_item_id` 已有導入行 ⇒ 原樣返回（不改寫既有行）。 */
    const duplicates = await readRows(COLLECTIONS.itemImports, { source_item_id: sourceId })
    if (duplicates.length > 0) {
      return { ok: true, op: 'submitItemImport', row: duplicates[0], idempotent: true, message: '該外部冪等鍵（source_item_id）已存在導入行 ⇒ 未改寫（冪等）。' }
    }
    const body = itemBodyOf({ ...payload, source_item_id: sourceId })
    const at = new Date().toISOString()
    const row = {
      id: `${ITEM_IMPORT_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      batch_id: text(payload.batch_id),
      source: text(payload.source),
      source_item_id: sourceId,
      status: ITEM_IMPORT_STATUS.PENDING,
      ...body,
      raw_json: payload.raw_json === undefined ? null : payload.raw_json,
      imported_by: identity.uid,
      imported_at: at,
      reviewed_at: null,
      reviewer_id: null,
      review_note: ''
    }
    return {
      ok: true,
      op: 'submitItemImport',
      row,
      plan: { writes: [{ kind: 'add', collection: COLLECTIONS.itemImports, doc: row }] }
    }
  },

  /**
   * **積分餘額（「金」上雲｜本單新增 op｜`getPointsBalance`）**：回**服务端权威**余额
   * `{ok:true, points, updated_at}`（**新用户首次读即幂等发初始 50 金** —— 发放动作在
   * `lib/ledger.js::readBalance` → `ensureBalance` 内完成，带 `INITIAL` 流水；同一 uid
   * 重复初始化只发一次；**不采信前端自报**）。
   * 顺序（**全部判定在任何写之前**；本 op 不产出 `plan` ⇒ `index.js` 落盘分支不触发）：
   *   ① 载荷形态 ＋ 封闭键面（`POINTS_BALANCE_ALLOWED_KEYS` ＝ 空集 ⇒ 任何键
   *      ⇒ `INVALID_FIELD` ＋ 零写入）；② 身份取自已验签令牌（缺 ⇒ `FORBIDDEN`）；
   *   ③ 账本读（失败 ⇒ 账本侧结构化拒绝 / `STORAGE_UNAVAILABLE`，**绝不伪装 `FORBIDDEN`**）。
   * @param {object} payload 载荷（**零允许键**）
   * @param {{uid:string, phone:string}} identity 服务端派生身份
   * @returns {Promise<{ok:true, points:number, updated_at:string}
   *          |{ok:false, reason:string, message:string}>}
   */
  async getPointsBalance(payload, identity) {
    const payloadDenial = pointsPayloadDenial(payload, POINTS_BALANCE_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    if (!identity || !text(identity.uid)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的用戶身份；本次零寫入。')
    }
    const balance = await ledger.readBalance(identity.uid)
    if (!balance.ok) return balance
    return { ok: true, points: balance.points, updated_at: balance.updated_at }
  },

  /**
   * **積分流水清單（「金」上雲｜本單新增 op｜`listPointsFlow`）**：回**本人**流水
   * `{ok:true, rows:[{delta,kind,ref_type,ref_id,balance_after,created_at}], count}`
   * —— 逐行由 `lib/ledger.js` 投影为**恰 6 键** ⇒ **回包零 `uid`、零 `_id`**；
   * 未结算（写入中断遗留）的预留行不下发。
   * 顺序（**全部判定在任何读之前**；本 op 零写入）：① 载荷形态 ＋ 封闭键面
   * （`limit` / `cursor` 两键；未登记键 ⇒ `INVALID_FIELD` ＋ 零写入）；
   * ② 身份取自已验签令牌（缺 ⇒ `FORBIDDEN`）；③ `limit` 1〜1000、`cursor` 非负整数
   * （越界 ⇒ `INVALID_VALUE`，不静默夹取）；④ 只读读行（失败 ⇒ `STORAGE_UNAVAILABLE`）。
   * @param {object} payload 载荷（允许键 `limit` / `cursor`）
   * @param {{uid:string, phone:string}} identity 服务端派生身份
   * @returns {Promise<{ok:true, rows:Array<object>, count:number}
   *          |{ok:false, reason:string, message:string}>}
   */
  async listPointsFlow(payload, identity) {
    const payloadDenial = pointsPayloadDenial(payload, POINTS_FLOW_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    if (!identity || !text(identity.uid)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的用戶身份；本次零寫入。')
    }
    const flow = await ledger.listFlow(identity.uid, { limit: payload.limit, cursor: payload.cursor })
    if (!flow.ok) return flow
    return { ok: true, rows: flow.rows, count: flow.count }
  },

  /**
   * **簽發 AI 金鑰（「AI 金鑰」本單新增 op｜`issueAiKey`）**：服务端铸造明文、库内零明文。
   * 回包**恰 8 键** `{ok, key_id, key, key_prefix, label, day_limit, minute_limit, created_at}`
   * —— `key` 是**唯一一次明文**（`sk-xiai-` 拼 32 位十六进制）；`key_hash` / `_id` **不下发**。
   * 顺序（**全部判定在任何写之前**；本 op 不产出 `plan` ⇒ `index.js` 落盘分支不触发）：
   *   ① 载荷形态 ＋ 封闭键面（`label` / `day_limit` / `minute_limit`；身份 / 明文类键
   *      ⇒ `INVALID_FIELD` ＋ 零写入）；② 身份取自已验签令牌（缺 ⇒ `FORBIDDEN`）；
   *   ③ 值域门（label ≤ 40 字、日限 1〜1000 缺省 20、分鐘限 1〜120 缺省 5；越界 / 非整数
   *      ⇒ `INVALID_VALUE` ＋ 零写入）；④ 每人 ACTIVE 上限 10 枚（超限 ⇒ `INVALID_VALUE`
   *      ＋ 零写入；【登记】契约愿望字面值 `LIMIT_EXCEEDED` 不在冻结表 ⇒ 不自行新增）。
   * @param {object} payload 载荷（允许键见 `AI_KEY_ISSUE_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity 服务端派生身份
   */
  async issueAiKey(payload, identity) {
    const payloadDenial = pointsPayloadDenial(payload, AI_KEY_ISSUE_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    if (!identity || !text(identity.uid)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的用戶身份；本次零寫入。')
    }
    return aiKeys.issueAiKey({
      uid: identity.uid,
      label: payload.label,
      day_limit: payload.day_limit,
      minute_limit: payload.minute_limit
    })
  },

  /**
   * **本人 AI 金鑰清單（本單新增 op｜`listAiKeys`）**：回 `{ok, rows, count}`，
   * `rows` 逐行**恰 8 键** `{key_id, key_prefix, label, status, created_at, revoked_at,
   * day_limit, minute_limit}` ⇒ **零 `key_hash`、零明文**（投影单点在 `lib/aiKeys.js`）。
   * 本 op **只读、零写入**。
   * @param {object} payload 载荷（**零允许键**）
   * @param {{uid:string, phone:string}} identity 服务端派生身份
   */
  async listAiKeys(payload, identity) {
    const payloadDenial = pointsPayloadDenial(payload, AI_KEY_LIST_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    if (!identity || !text(identity.uid)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的用戶身份；本次零寫入。')
    }
    const list = await aiKeys.listAiKeys({ uid: identity.uid })
    if (!list.ok) return list
    return { ok: true, rows: list.rows, count: list.count }
  },

  /**
   * **吊銷 AI 金鑰（本單新增 op｜`revokeAiKey`）**：只許本人（行属他人 / `key_id` 不存在
   * ⇒ **同一** `FORBIDDEN` ＋ 零写入 ⇒ 不洩露「該鍵是否存在」）；已吊销 ⇒ `ok:true` ＋
   * `already:true`（**行不新增、一字不改**）。回包**恰 5 键**
   * `{ok, key_id, status, revoked_at, already}`。
   * @param {object} payload 载荷（允许键 `key_id`）
   * @param {{uid:string, phone:string}} identity 服务端派生身份
   */
  async revokeAiKey(payload, identity) {
    const payloadDenial = pointsPayloadDenial(payload, AI_KEY_REVOKE_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    if (!identity || !text(identity.uid)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的用戶身份；本次零寫入。')
    }
    return aiKeys.revokeAiKey({ uid: identity.uid, key_id: payload.key_id })
  },

  /**
   * **改寫 AI 金鑰限額（本單新增 op｜`updateAiKeyLimits`）**：只許本人（同吊销口径：行属
   * 他人 / 不存在 ⇒ `FORBIDDEN` ＋ 零写入）；限额必须**同时给两个**且值域内（缺字段 ⇒
   * `MISSING_REQUIRED`；越界 / 非整数 ⇒ `INVALID_VALUE` ＋ 零写入）。回包**恰 5 键**
   * `{ok, key_id, day_limit, minute_limit, updated_at}`。
   * @param {object} payload 载荷（允许键 `key_id` / `day_limit` / `minute_limit`）
   * @param {{uid:string, phone:string}} identity 服务端派生身份
   */
  async updateAiKeyLimits(payload, identity) {
    const payloadDenial = pointsPayloadDenial(payload, AI_KEY_LIMITS_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    if (!identity || !text(identity.uid)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的用戶身份；本次零寫入。')
    }
    return aiKeys.updateAiKeyLimits({
      uid: identity.uid,
      key_id: payload.key_id,
      day_limit: payload.day_limit,
      minute_limit: payload.minute_limit
    })
  },

  /**
   * **本人 AI 用量 ＋ 金額（本單新增 op｜`getAiUsage`）**：回**恰 4 键**
   * `{ok, points, today:{used,limit}, minute:{used,limit}}` —— `points` 取自**既有账本**
   * `ledger.readBalance`（不自读余额集合）；两个窗口取自 `lib/aiUsage.peekUsage`
   * （**只读、零写入**；限额 ＝ 本人 ACTIVE 金鑰的最小限额）。
   * @param {object} payload 载荷（**零允许键**）
   * @param {{uid:string, phone:string}} identity 服务端派生身份
   */
  async getAiUsage(payload, identity) {
    const payloadDenial = pointsPayloadDenial(payload, AI_USAGE_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    if (!identity || !text(identity.uid)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的用戶身份；本次零寫入。')
    }
    const usage = await aiUsage.peekUsage({ uid: identity.uid })
    if (usage && usage.ok === false) return usage
    const balance = await ledger.readBalance(identity.uid)
    if (!balance.ok) return balance
    return { ok: true, points: balance.points, today: usage.day, minute: usage.minute }
  }
})

/* ---------------------------------------------------------------------------
   管理员写面 op 注册面（V3 新增；**登录令牌 ＋ 手机号白名单**）
   ---------------------------------------------------------------------------
   调用形状：`ADMIN_OPS[op](payload, identity, context)`，其中
     · `identity` ＝ **服务端从令牌声明派生**（`{uid:'u-'+sha256(手机号)前16位, phone:'<11 位>'}`）；
     · `context`  ＝ `{adminPhone:'<白名单手机号>', nowSeconds:<服务端秒>}`。
   `adminPhone` 来自 `readConfig().adminPhone`（**缺 / 空 ⇒ 白名单门结构化拒绝**）；
   `nowSeconds` 是**服务端唯一时源**（`reviewed_at` 由它派生）。
   每个 op 只**产出落盘计划**（或成功回包），落库一律在 `persist()`。
   --------------------------------------------------------------------------- */

/* **一次性朝代值迁移（§3.53.5）**：只改两个**人类点名旧值** —— `战国` → `戰國`；`秦汉` → 清空（`''`）。
   其它任何 `dynasty` 取值一律逐字不动（R-21 旧值不改写红线）。载荷封闭键面 ＝ `['dry_run']`。 */
const MIGRATE_ALLOWED_KEYS = Object.freeze(['dry_run'])
const DYNASTY_MIGRATION = Object.freeze({ '\u6218\u56fd': '戰國', '\u79e6\u6c49': '' })

/* **值域收敛面（同族｜本单新增 op `migrateSealValueDomains`）**：逐 `(集合, 字段)` → **冻结真源**。
   执行口径与 `migrateDynastyValues` 的 `秦汉 → ''` **同口径**：**只把真源外值清空为 `''`**；
   真源内值**一字不动**；**不得臆测映射**（例：`清` 不得 → `清中期`）。
   真源单点 ＝ `DYNASTY_OPTIONS` / `FACE_CONTENT_OPTIONS` / `FACE_STYLE_OPTIONS` / `SEAL_CLASS_OPTIONS`。 */
const SEAL_VALUE_DOMAIN_TARGETS = Object.freeze([
  Object.freeze({ collection: COLLECTIONS.seals, key: 'seals', field: 'dynasty', domain: DYNASTY_OPTIONS }),
  Object.freeze({ collection: COLLECTIONS.seals, key: 'seals', field: 'seal_type', domain: FACE_CONTENT_OPTIONS }),
  Object.freeze({ collection: COLLECTIONS.faces, key: 'faces', field: 'seal_type', domain: FACE_CONTENT_OPTIONS }),
  Object.freeze({ collection: COLLECTIONS.faces, key: 'faces', field: 'face_style', domain: FACE_STYLE_OPTIONS }),
  Object.freeze({ collection: COLLECTIONS.faces, key: 'faces', field: 'seal_class', domain: SEAL_CLASS_OPTIONS })
])

/* **本单 I-3（真因修复）**：待审导入行**单次读取上限** —— 平台分页护栏（CloudBase `.get()`
   默认 100 行）。**正确性口径 ＝ 取行式按 `status = PENDING` 过滤**（终态行不再进入读集 ⇒
   天然自愈分页、可反复调用直至清空）；本常量只是单次体量护栏。 */
const IMPORT_REVIEW_PAGE_SIZE = 200
/* **本单 I-2**：修复扫描（`status = ACCEPTED`）的单次读取上限（同护栏口径）。 */
const IMPORT_REPAIR_SCAN_LIMIT = 1000
/* **本单 I-2**：修复 op 的载荷键面（沿迁移 op 同型；`['dry_run']`；**零新增键面**）。 */
const REPAIR_ALLOWED_KEYS = MIGRATE_ALLOWED_KEYS
/* **本单 I-2**：修复通道逐集合面（集合 ＝ 导入集合；键 ＝ 幂等键字段；正式集合见 `formal`）。 */
const IMPORT_REPAIR_TARGETS = Object.freeze([
  Object.freeze({ key: 'person', imports: COLLECTIONS.personImports, formal: COLLECTIONS.persons, idKey: 'source_person_id', label: '印人' }),
  Object.freeze({ key: 'item', imports: COLLECTIONS.itemImports, formal: COLLECTIONS.items, idKey: 'source_item_id', label: '印谱' }),
  Object.freeze({ key: 'seal', imports: COLLECTIONS.sealImports, formal: COLLECTIONS.seals, idKey: 'source_seal_id', label: '印章' })
])

/* ---------------------------------------------------------------------------
   **E-3 / E-4（外部批量導入＝本機專屬面｜本單｜階段乙）**
   ---------------------------------------------------------------------------
   E-3：只讀取行通道 op `pullImportRows` —— 把**雲端**三族導入行**單向取回本機**
   （階段甲復用於存量搬遷；階段乙用於「雲端包 → 本機審」）。
   硬口徑（逐條）：
     · **只讀**：本 op **不產出 `plan`** ⇒ `index.js` 的落盤分支不觸發 ⇒ **零寫入**；
     · **管理員白名單門**（沿 `adminWhitelistDenial`；缺 `XIAI_ADMIN_PHONE` ⇒ 結構化拒絕）；
     · **載荷鍵面封閉** ＝ `PULL_IMPORT_ROWS_ALLOWED_KEYS`
       （`{batch_id, collection, status, limit}`；未登記鍵 ⇒ `INVALID_FIELD` ＋ 零寫入）；
     · **集合三選一**：`collection` ∈ `{personImports, sealImports, itemImports}`（值域封閉）；
       未給 `collection` 時由 `batch_id` 前綴推斷（推不出 ⇒ `INVALID_VALUE` ＋ 零寫入）；
     · **狀態值域**（可選）：`PENDING` / `ACCEPTED` / `REJECTED`（值域外 ⇒ `INVALID_VALUE`）；
     · **單次上限**：`limit` ∈ `[1, IMPORT_REPAIR_SCAN_LIMIT]` 的整數（缺省 ⇒
       `IMPORT_REVIEW_PAGE_SIZE`）—— **顯式 `.limit()`** 以避開平台默認 100 行上限；
     · **不返回身份字段**：行內**任何 `…phone…` 鍵一律剝除**（`user_phone` 一類零出現）；
       不透明 uid（如 `imported_by`）**原樣保留**；
     · 成功回包**恰四鍵** `{ok:true, op:'pullImportRows', rows:[…], count:N}`；
       失敗形態恒為恰 3 鍵；`reason` ∈ 既有凍結表（**新增字面值 0**）。
   E-4：`index.js` 的包封收窄分支按 `op` 只對三 review op 透出
   `accepted_ids / rejected_ids / skipped / failed / done / remaining`；其中 `remaining` 由
   本文件的 `countRemainingImportPending`（**只讀、帶顯式 limit**）供給。
   --------------------------------------------------------------------------- */

/** `pullImportRows` 載荷允許鍵（**封閉鍵面**；身份類鍵一律拒）。 */
const PULL_IMPORT_ROWS_ALLOWED_KEYS = Object.freeze(['batch_id', 'collection', 'status', 'limit'])

/** 集合鍵（前端字面） → 集合名（`^xiai_`）**三選一**（值域封閉）。 */
const PULL_IMPORT_COLLECTION_KEYS = Object.freeze({
  personImports: COLLECTIONS.personImports,
  sealImports: COLLECTIONS.sealImports,
  itemImports: COLLECTIONS.itemImports
})

/** 由 `batch_id` 前綴推斷導入集合（**後備路**；大小寫不敏感；推不出 ⇒ `''`）。 */
const PULL_IMPORT_BATCH_PREFIXES = Object.freeze([
  Object.freeze({ prefix: 'person', key: 'personImports' }),
  Object.freeze({ prefix: 'pi-', key: 'personImports' }),
  Object.freeze({ prefix: 'seal', key: 'sealImports' }),
  Object.freeze({ prefix: 'si-', key: 'sealImports' }),
  Object.freeze({ prefix: 'item', key: 'itemImports' }),
  Object.freeze({ prefix: 'ii-', key: 'itemImports' })
])

/** 導入行狀態值域（三族逐字同值：`PENDING` / `ACCEPTED` / `REJECTED`）。 */
const PULL_IMPORT_STATUS_VALUES = Object.freeze(['PENDING', 'ACCEPTED', 'REJECTED'])

/** 單次取行缺省上限（沿待審取行護欄 `IMPORT_REVIEW_PAGE_SIZE`）。 */
const PULL_IMPORT_DEFAULT_LIMIT = IMPORT_REVIEW_PAGE_SIZE

/** 單次取行硬上限（沿修復掃描護欄 `IMPORT_REPAIR_SCAN_LIMIT`；防無界）。 */
const PULL_IMPORT_MAX_LIMIT = IMPORT_REPAIR_SCAN_LIMIT

/**
 * 剝除導入行內**身份 / 手機號類**鍵（遞歸；鍵名凡含 `phone`（不分大小寫）一律剝除；
 * **不透明 uid 鍵**（如 `imported_by`）**原樣保留**）。深度護欄 8 層（防病態結構）。
 * @param {*} value
 * @param {number} [depth]
 * @returns {*}
 */
function stripImportIdentityFields(value, depth) {
  const level = typeof depth === 'number' ? depth : 0
  if (level > 8 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => stripImportIdentityFields(item, level + 1))
  const out = {}
  Object.keys(value).forEach((key) => {
    if (/phone/i.test(key)) return
    out[key] = stripImportIdentityFields(value[key], level + 1)
  })
  return out
}

/**
 * 由 `batch_id` 前綴推斷導入集合（**後備路**；大小寫不敏感；推不出 ⇒ 空串）。
 * @param {string} batchId
 * @returns {string} 集合名（`^xiai_`）或 `''`
 */
function importCollectionOfBatchPrefix(batchId) {
  const id = text(batchId).toLowerCase()
  if (!id) return ''
  for (const item of PULL_IMPORT_BATCH_PREFIXES) {
    if (id.indexOf(item.prefix) === 0) return PULL_IMPORT_COLLECTION_KEYS[item.key]
  }
  return ''
}

/** 三 review op → 導入集合（供包封收窄讀「剩餘待審」）。 */
const IMPORT_REVIEW_COLLECTION_BY_OP = Object.freeze({
  reviewPersonImport: COLLECTIONS.personImports,
  reviewSealImport: COLLECTIONS.sealImports,
  reviewItemImport: COLLECTIONS.itemImports
})

/**
 * **E-4 包封收窄讀點（只讀）**：該 `op` 對應導入集合（給了 `batch_id` ⇒ 限該批；未給 ⇒ 整集合）
 * 的**剩餘待審（`PENDING`）條數** —— 供 `index.js` 在**落盤之後**再讀一次
 * （**顯式 `.limit(IMPORT_REVIEW_PAGE_SIZE)`**，沿待審取行護欄）。
 *
 * **讀失敗 ⇒ 返回 `null`**（由 `index.js` **不放該鍵** —— **不得填 0 冒充**、
 * 不得把「讀不到」當 0）；未知 `op` ⇒ 亦 `null`。
 * @param {string} op
 * @param {string} batchId
 * @returns {Promise<number|null>}
 */
async function countRemainingImportPending(op, batchId) {
  const collection = IMPORT_REVIEW_COLLECTION_BY_OP[text(op)]
  if (!collection) return null
  const batch = text(batchId)
  /* 三族 `PENDING` 字面值逐字同值（`PERSON_IMPORT_STATUS` / `SEAL_IMPORT_STATUS` / `ITEM_IMPORT_STATUS`）。 */
  const match = batch ? { batch_id: batch, status: 'PENDING' } : { status: 'PENDING' }
  try {
    const rows = await readRows(collection, match, { limit: IMPORT_REVIEW_PAGE_SIZE })
    return rows.length
  } catch {
    return null
  }
}

/**
 * **印人编号分配**（`PR` ＋ 9 位流水，**跳过已占用**）—— `reviewPersonImport` 与
 * `repairImportAcceptance` **同一套编号规则**（不另立第二套）。
 * @param {Array<object>} persons 既有正式印人行
 * @returns {string}
 */
function nextPersonCodeOf(persons) {
  const rows = Array.isArray(persons) ? persons : []
  let max = 0
  rows.forEach((item) => {
    const matched = new RegExp(`^${PERSON_CODE_PREFIX}(\\d{9})$`).exec(text(item && item.code))
    if (matched) max = Math.max(max, Number(matched[1]))
  })
  const taken = new Set(rows.map((item) => text(item && item.code)))
  let index = max + 1
  while (taken.has(`${PERSON_CODE_PREFIX}${String(index).padStart(9, '0')}`)) index += 1
  return `${PERSON_CODE_PREFIX}${String(index).padStart(9, '0')}`
}

/**
 * 由**导入行**构造正式印人行 —— `reviewPersonImport` / `repairImportAcceptance` **同一套字段面**
 * （值来自导入行，**不做任何转换改写**）。
 * @param {object} row 导入行
 * @param {{uid:string}} identity 服务端派生身份（落 `created_by`）
 * @param {string} at ISO 时戳
 * @param {string} code 已分配的正式编号
 * @returns {object}
 */
function buildPersonDocFromImport(row, identity, at, code) {
  return {
    id: code,
    code,
    family_name: text(row.family_name),
    given_name: text(row.given_name),
    courtesy_names: Array.isArray(row.courtesy_names) ? row.courtesy_names : [],
    art_names: Array.isArray(row.art_names) ? row.art_names : [],
    alias_names: Array.isArray(row.alias_names) ? row.alias_names : [],
    birth_year: row.birth_year === undefined ? null : row.birth_year,
    death_year: row.death_year === undefined ? null : row.death_year,
    years_lived: null,
    birth_era_text: '',
    death_era_text: '',
    dynasty: '',
    gender: '',
    cbdb_id: text(row.cbdb_id),
    card_id: '',
    /* **person 六扩字段（值来自采纳的导入行；不做任何转换改写）**。 */
    native_place: text(row.native_place),
    biography: text(row.biography),
    source: text(row.source),
    source_id: text(row.source_id),
    native_place_chs: text(row.native_place_chs),
    biography_chs: text(row.biography_chs),
    source_person_id: text(row.source_person_id), // **幂等键（溯源）**
    proposal_id: '',
    created_by: identity.uid,
    created_at: at,
    updated_at: at
  }
}

/**
 * 由**导入行**构造采纳落点（**正式印章行 ＋ 逐印面行**）—— `reviewSealImport` /
 * `repairImportAcceptance` **同一套字段面与编号规则**（不另立第二套）。
 *
 * **影像引用逐条校验**（沿既有口径）：宣告了引用但解析不到 ⇒ `{ok:false}`；
 * `kind=FACE` **无任何引用**亦 ⇒ `{ok:false}`（边款 `EDGE` 无引用则放行）。
 * **第 6 参 `imageOverlay`（无审核直写面追加；可选）**：直写 op 自建的影像登记行覆蓋層
 * （登记行尚未落库）⇒ 逐条校验时**先查覆蓋層**；**既有三个调用点不传 ⇒ 行为逐字不变**。
 * @param {object} row 印章导入行
 * @param {Array<object>} seals 既有正式印章行（用于编号分配）
 * @param {Array<object>} faces 既有印面行（用于 id 分配）
 * @param {{uid:string}} identity 服务端派生身份
 * @param {string} at ISO 时戳
 * @param {Array<object>} [imageOverlay] 直写通道的影像登记行覆蓋層（只读）
 * @returns {Promise<{ok:true, stampId:string, sealDoc:object, faceDocs:Array<object>}|{ok:false}>}
 */
async function buildSealAcceptanceFromImport(row, seals, faces, identity, at, imageOverlay) {
  const faceDefs = Array.isArray(row && row.faces) ? row.faces.map(normalizeSealImportFace) : []
  /* **佔位圖來源門 ＋ 摘要門**（本單新增｜影像例外；與提交門同判）：
     佔位鍵僅 sealbank（feicui）家族可引用；指向佔位鍵者其摘要必須 ≡ 登記摘要。 */
  const placeholderDenial = sealPlaceholderRefDenial(text(row && row.source), faceDefs)
  if (placeholderDenial) return { ok: false, reason: REASONS.INVALID_VALUE }
  const resolvedFaces = []
  for (const face of faceDefs) {
    const hasRef = text(face.image_sha256) !== '' || text(face.image_storage_key) !== ''
    if (!hasRef) {
      if (face.kind === 'FACE') return { ok: false }
      resolvedFaces.push({ face, image: null })
      continue
    }
    const image = await findSealImportImageRow(face, imageOverlay)
    if (!image) return { ok: false }
    const digestDenial = sealPlaceholderDigestDenial(face, image)
    if (digestDenial) return { ok: false, reason: REASONS.INVALID_VALUE }
    resolvedFaces.push({ face, image })
  }
  /* **识别编码（口径件 §3｜R-2 / R-5）**：采纳时由**服务端计数器**原子发号 ⇒ `seal_no`，
     `sid` ＝ `encodeSealCode(seal_no)`；`stamp_id` 的值 **＝ `sid`**（旧 `XA…` / 纯数字形态不再产生）。
     载荷里的 `sid` / `seal_no` **一律不采信**（本函数自产）；与既有行撞号 ⇒ 继续取号（不改写既有行）。 */
  const issuedSeal = await issueCodeNumberAvoiding('seal', (no) =>
    (Array.isArray(seals) ? seals : []).some((item) => Number(item && item.seal_no) === no)
  )
  if (!issuedSeal.ok) return { ok: false, reason: issuedSeal.reason }
  const sealNo = issuedSeal.no
  const sealCode = codeId.encodeSealCode(sealNo)
  if (!sealCode.ok) return { ok: false, reason: REASONS.INVALID_VALUE }
  const stampId = sealCode.code
  const serial = sealStampSerialOf(stampId)
  const source = text(row && row.source)
  const sealName = text(row && row.seal_name)
  const sealDoc = {
    /* **源側擴面 51 鍵整條落正式行**（E-3；`category` 逐字由下方平台別名覆蓋 ⇒ 見注）。 */
    ...sealSourceFieldsOf(row),
    seal_no: sealNo, // 识别编码：权威自增号（服务端计数器发号）
    sid: stampId, // 识别编码：由 `seal_no` 恒重算（＝ `stamp_id`，R-5）
    sealGroupId: `g-${serial}`,
    stamp_id: stampId, // **R-5：值 ＝ `sid`**
    id: stampId,
    seal_name: sealName,
    name: sealName,
    transcription: text(row && row.transcription),
    dynasty: text(row && row.dynasty),
    seal_type: text(row && row.seal_type),
    /* `category` 是**平台既有別名**（＝ `seal_type`，印面內容）；源側 `category`（印章 / 印譜）
       只留導入行 ⇒ 不得让别名语义被覆盖（`normalizeSealRow` 读面亦按 `seal_type` 归一）。 */
    category: text(row && row.seal_type),
    seal_style: text(row && row.seal_style),
    material: text(row && row.material),
    shape: text(row && row.shape),
    asset_kind: 'SEAL',
    /* **同置**：採納 ⇒ 正式行 `review_status='APPROVED'`（与導入行 `status='ACCEPTED'` 同时推进）。 */
    review_status: 'APPROVED',
    author: text(row && row.author),
    source,
    source_seal_id: text(row && row.source_seal_id),
    uploaded_by: identity.uid,
    created_at: at,
    updated_at: at
  }
  const taken = new Set((Array.isArray(faces) ? faces : []).map((item) => text(item && item.id)))
  const faceDocs = []
  for (const { face, image } of resolvedFaces) {
    const faceId = nextFaceIdOf(stampId, face.kind, taken)
    taken.add(faceId)
    const isEdge = face.kind === 'EDGE'
    /* **识别编码（印面侧）**：`face_no` 同样由计数器原子发号、`fid` 由其恒重算；撞号继续取。 */
    const issuedFace = await issueCodeNumberAvoiding('face', (no) =>
      (Array.isArray(faces) ? faces : []).some((item) => Number(item && item.face_no) === no) ||
      faceDocs.some((item) => Number(item.face_no) === no)
    )
    if (!issuedFace.ok) return { ok: false, reason: issuedFace.reason }
    const faceNo = issuedFace.no
    const faceCode = codeId.encodeFaceCode(faceNo)
    if (!faceCode.ok) return { ok: false, reason: REASONS.INVALID_VALUE }
    faceDocs.push({
      id: faceId,
      sealId: stampId,
      stamp_id: stampId,
      face_no: faceNo, // 识别编码：印面自增号（服务端计数器发号）
      fid: faceCode.code, // 识别编码：由 `face_no` 恒重算
      kind: face.kind,
      face_image_id: !isEdge && image ? text(image.id) : null,
      edge_image_ids: isEdge && image ? [text(image.id)] : [],
      seal_name: text(face.seal_name) || sealName,
      dynasty: text(face.dynasty) || text(row && row.dynasty),
      seal_type: text(face.seal_type),
      face_style: text(face.face_style),
      seal_class: text(face.seal_class),
      author: text(face.author),
      author_person_id: text(face.author_person_id),
      transcription: text(face.transcription),
      /* **影面新增鍵**（原样收；值域不封閉）。 */
      image_source_kind: text(face.image_source_kind),
      source,
      uploaded_by: identity.uid,
      created_at: at,
      updated_at: at
    })
  }
  return { ok: true, stampId, sealDoc, faceDocs }
}

/* ---------------------------------------------------------------------------
  **无审核直写面（人类口径 2026-10-28）**：`createSealWithFaceDirect`（直写正式行）
  ＋ `querySealByFingerprint`（只读三态对照）
  ---------------------------------------------------------------------------
  口径（Kevin 2026-10-28 逐字）：
    · 正式落点 `xiai_seals` / `xiai_faces` **允许无审核直写**，但**来源限白名单**；
    · 幂等键 ＝ `source` ＋ `source_seal_id`（面级另用 `faces[].image_sha256` 内容寻址去重）；
    · **面行 `xiai_faces` 必落 `image_sha256`**（印章行不必）；
    · 鉴权收紧 S1 ＋ S2：`XIAI_DIRECT_WRITE_PHONE`（分权：该身份**只能直写**、不得调 `review*`）
      ＋ `XIAI_DIRECT_WRITE_SOURCES`（逗号分隔来源表）；**缺 env ⇒ fail-closed 拒所有直写**。
  设计件：`bistro/feicui/ops/xiai-uplink-probe/direct-write-design-2026-10-28.md`（§1 / §2 / §3.2 / §5）。
  硬口径（逐条）：
    · 两个 op 都落 `ADMIN_OPS`（**不开新的用户级写面**）；
    · **判定全部在写之前**；失败恒为恰 3 键 `{ok:false, reason, message}`，`reason` **零新增字面值**；
    · op 只产 `plan`，落库一律在 `persist()`（**单点落盘**）；幂等命中 / 只读 ⇒ **无 `plan`**；
    · **业务键全部塞进 `row`**（`index.js` 对 `row` **零过滤**）⇒ **不改 `index.js` 全局回包白名单**；
      `plan` 是内部面、仍**绝不外传**。
  --------------------------------------------------------------------------- */

/** 直写载荷键面 ＝ **复用印章导入键面**（不另立第二套 ⇒ 未知键判定与 `submitSealImport` 逐字同门）。
 *  `batch_id` / `raw_json` / `image_status` 允许出现在载荷里，但**直写正式行不落这三键**
 *  （直写不经暂存行；构建器亦不读它们）。 */
const DIRECT_WRITE_ALLOWED_KEYS = SEAL_IMPORT_ALLOWED_KEYS

/** 直写回包 `row` 的业务键面（**恰含**这 9 键；由 `scripts/verify-direct-write.mjs` 机械断言）。 */
const DIRECT_WRITE_ROW_KEYS = Object.freeze([
  'ok',
  'sid',
  'fid',
  'seal_no',
  'face_no',
  'face_id',
  'image_id',
  'faces',
  'idempotent'
])

/** 直写回包 `row.faces[]` 单条键面（**恰含**这 5 键）。 */
const DIRECT_WRITE_FACE_KEYS = Object.freeze(['fid', 'face_no', 'face_id', 'image_id', 'kind'])

/** 指纹对照查询载荷键面（**封闭四元组**；身份类键一律拒）。 */
const SEAL_FINGERPRINT_QUERY_KEYS = Object.freeze(['transcription', 'dynasty', 'author', 'image_sha256'])

/** 指纹对照三态（**服务端唯一判据键**；一次回齐，不许前端自行拼判断）。 */
const SEAL_FINGERPRINT_MATCH = Object.freeze({ FULL: 'FULL', IMAGE_DIFF: 'IMAGE_DIFF', NONE: 'NONE' })

/** 指纹对照回包 `row` 的业务键面（**恰含**这 8 键）。 */
const SEAL_FINGERPRINT_ROW_KEYS = Object.freeze([
  'match',
  'sid',
  'fid',
  'face_id',
  'seal_name',
  'image_id',
  'image_sha256',
  'faces'
])

/** 指纹对照回包 `row.faces[]` 单条键面（**恰含**这 4 键）。 */
const SEAL_FINGERPRINT_FACE_KEYS = Object.freeze(['fid', 'face_id', 'image_id', 'image_sha256'])

/** 直写影像登记行 id 前缀 ＋ 摘要位数（**内容寻址** ⇒ 同图恒同 `_id` ⇒ 幂等覆写、不增行）。 */
const DIRECT_IMAGE_ID_PREFIX = 'img-'
const DIRECT_IMAGE_ID_HEX_LENGTH = 16

/** 直写单次读取护栏（撞号避让 / 幂等读 / 取面；号源权威仍在计数器 `issueCodeNumber`）。 */
const DIRECT_WRITE_READ_LIMIT = 1000

/** env 字符串读取（**名字真源 ＝ `config.js::ENV_NAMES`；本文件不写任何值**）。 */
function envStringOf(name, env) {
  const source = env || process.env
  const raw = source ? source[name] : undefined
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * 直写收紧 env（S1 ＋ S2）读数：`XIAI_DIRECT_WRITE_PHONE`（分权手机号）＋
 * `XIAI_DIRECT_WRITE_SOURCES`（逗号分隔来源白名单）。**任一缺 ⇒ 对应项为空** ⇒ 调用侧 fail-closed。
 * @param {object} [env] 环境（缺省 `process.env`；离线自检可注入）
 */
function directWriteEnvOf(env) {
  const raw = envStringOf(ENV_NAMES.DIRECT_WRITE_SOURCES, env)
  return {
    phone: normalizePhone(envStringOf(ENV_NAMES.DIRECT_WRITE_PHONE, env)),
    sources: raw === '' ? [] : raw.split(',').map((item) => item.trim()).filter((item) => item !== '')
  }
}

/**
 * S1 直写**身份门**（op 第一句；**fail-closed**：缺 env ⇒ 拒所有直写、无手机号 ⇒ 拒、
 * 手机号不在表 ⇒ 拒）。**平台会话路无手机号 ⇒ 不满足分权判据 ⇒ 拒**（如需会话路直写须另开单拍板）。
 * @param {{uid:string, phone:string}|null|undefined} identity 服务端派生身份
 * @param {object} [env] 环境（缺省 `process.env`）
 * @returns {null|{ok:false, reason:string, message:string}} 放行 ⇒ `null`
 */
function directWriteIdentityDenial(identity, env) {
  const expected = directWriteEnvOf(env).phone
  if (!expected) {
    /* 未配置 ⇒ **内部不可用**（不是「越权」）⇒ 沿工程口径用 `STORAGE_UNAVAILABLE`；
       明文：**不得**因未配置而放行，也不得静默。 */
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      '直寫面未配置（缺環境變量：XIAI_DIRECT_WRITE_PHONE）⇒ 拒絕所有直寫操作；本次零寫入。'
    )
  }
  if (!identity || !identity.phone) {
    return deny(REASONS.FORBIDDEN, '缺少可驗證的直寫身份（直寫面只認分權白名單手機號；平台會話路無手機號 ⇒ 不放行）；本次零寫入。')
  }
  if (normalizePhone(identity.phone) !== expected) {
    return deny(REASONS.FORBIDDEN, '僅直寫專用身份可以執行此操作（手機號不在 XIAI_DIRECT_WRITE_PHONE 白名單）；本次零寫入。')
  }
  return null
}

/**
 * S2 直写**来源门**（fail-closed：缺 env ⇒ 拒**所有**来源；`source` 不在表 ⇒ 拒）。
 * 与占位图门**互不替代**：`feicui-local-dist` 走真实影像，占位图门照旧只认 sealbank 家族
 * （`sealPlaceholderRefDenial` / `isSealBankSource` **一字未改**）。
 * @returns {null|{ok:false, reason:string, message:string}}
 */
function directWriteSourceDenial(source, env) {
  const sources = directWriteEnvOf(env).sources
  if (sources.length === 0) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      '直寫來源白名單未配置（缺環境變量：XIAI_DIRECT_WRITE_SOURCES）⇒ 拒絕所有直寫；本次零寫入。'
    )
  }
  if (sources.indexOf(text(source)) === -1) {
    return deny(REASONS.FORBIDDEN, '來源標籤不在直寫來源白名單（XIAI_DIRECT_WRITE_SOURCES）⇒ 拒絕直寫；本次零寫入。')
  }
  return null
}

/**
 * S1 **分权泄漏面**：`review*` 系 op 对「直写专身份」**显式拒**（该身份只能直写、不得审核）。
 * 泄漏场景 ＝ 同一手机号**同时**被配进 `XIAI_ADMIN_PHONE` 与 `XIAI_DIRECT_WRITE_PHONE`
 * （否则管理员白名单门本就会拒它）。env 缺 / 身份不是直写身份 ⇒ `null`
 * （放行判定交回管理员白名单门，**不误伤**）。
 * @returns {null|{ok:false, reason:string, message:string}}
 */
function directWriteReviewerDenial(identity, env) {
  const expected = directWriteEnvOf(env).phone
  if (!expected || !identity || !identity.phone) return null
  if (normalizePhone(identity.phone) !== expected) return null
  return deny(REASONS.FORBIDDEN, '直寫專用身份不得執行審覈類操作（S1 分權：該身份只能直寫）；本次零寫入。')
}

/**
 * 直写影像**登记行**（B2：`xiai_images` 在生产没有任何 op 写者 ⇒ 直写 op 自写）。
 * 字段面 ＝ 设计件 §1.5 / §3.2 ⑤（`id/stamp_id/kind/storage/storage_key/sha256/bytes/mime/
 * width/height/updated_at`）；`_id` ＝ **内容寻址**（`img-` ＋摘要前 16 位）⇒ 同图恒同 `_id`
 * ⇒ 幂等覆写、不增行、**不消耗号**。`stamp_id` 由调用方在拿到 `sid` 后回填（发号在构建期之后）。
 * 像素尺寸：直写载荷不带、服务端不为此整图解码 ⇒ 如实落 `null`（读面按行派生展示键，不据此判定）。
 */
function buildDirectImageRow(face, at) {
  const sha = text(face && face.image_sha256)
  const size = Number(face && face.image_bytes)
  return {
    id: `${DIRECT_IMAGE_ID_PREFIX}${sha.slice(0, DIRECT_IMAGE_ID_HEX_LENGTH)}`,
    stamp_id: '',
    kind: text(face && face.kind) === 'EDGE' ? 'EDGE' : 'FACE',
    storage: 'server',
    storage_key: text(face && face.image_storage_key),
    sha256: sha,
    bytes: Number.isFinite(size) && size > 0 ? Math.round(size) : null,
    /* 源件容器（真图一律 TIFF，与 `registerArtifact` 同口径）；`.tiff` 源件行在读面按行**派生**
       展示键 `.png`（`cloudBaseObjectKeyOf`）⇒ 匿名读不到原图字节。 */
    mime: ARTIFACT_MIME,
    width: null,
    height: null,
    updated_at: at
  }
}

/** 印面行 ⇒ 回包用 `image_id`（＝ `face_image_id`［FACE］/ `edge_image_ids[0]`［EDGE］/ `null`）。 */
function faceImageIdOf(doc) {
  if (!doc || typeof doc !== 'object') return null
  if (text(doc.kind) === 'EDGE') {
    const list = Array.isArray(doc.edge_image_ids) ? doc.edge_image_ids : []
    return list.length > 0 && text(list[0]) !== '' ? text(list[0]) : null
  }
  return text(doc.face_image_id) || null
}

/** 自由文本长度门（**构建器不做长度门 ⇒ op 自加**；`MAX_TEXT_LENGTH` 同值；空串不参与判定）。 */
function sealTextLengthDenial(payload, faces) {
  const over = []
  const scan = (key, value) => {
    if (typeof value === 'string' && value.length > MAX_TEXT_LENGTH) over.push(key)
  }
  SEAL_IMPORT_SEAL_FIELDS.forEach((key) => scan(key, payload[key]))
  ;(Array.isArray(faces) ? faces : []).forEach((face) => {
    SEAL_IMPORT_FACE_FIELDS.forEach((key) => scan(`faces[].${key}`, face[key]))
  })
  if (over.length === 0) return null
  return deny(REASONS.INVALID_VALUE, `自由文本超出上限（${MAX_TEXT_LENGTH} 字）：${over.join('、')}；本次零寫入。`)
}

/** 值域门（`VALUE_DOMAINS` 现只用于 `reviewCorrection` ⇒ **直写面自加**；空串不参与判定）。
 *  明文：域表按**字段名**取（`dynasty` / `seal_type` / `face_style` / `seal_class`），
 *  报错文案用**带前缀的键名**（`faces[].<key>`）以便排障。 */
function sealValueDomainDenial(payload, faces) {
  const bad = []
  const scan = (label, key, value) => {
    const domain = VALUE_DOMAINS[key]
    const current = text(value)
    if (!domain || current === '') return
    if (domain.indexOf(current) === -1) bad.push(label)
  }
  SEAL_IMPORT_SEAL_FIELDS.forEach((key) => scan(key, key, payload[key]))
  ;(Array.isArray(faces) ? faces : []).forEach((face) => {
    SEAL_IMPORT_FACE_FIELDS.forEach((key) => scan(`faces[].${key}`, key, face[key]))
  })
  if (bad.length === 0) return null
  return deny(REASONS.INVALID_VALUE, `值域外取值：${bad.join('、')}；本次零寫入。`)
}

/** 既有正式行 ⇒ 幂等回包用 `row`（**只读**；面行按 `sealId` 取该印全部面）。 */
async function directWriteRowOfExistingSeal(sealRow, idempotent) {
  const sid = text(sealRow && (sealRow.sid || sealRow.stamp_id))
  const faceRows = sid === '' ? [] : await readRows(COLLECTIONS.faces, { sealId: sid }, { limit: 64 })
  const faces = faceRows.map((doc) => ({
    fid: text(doc && doc.fid),
    face_no: Number(doc && doc.face_no),
    face_id: text(doc && doc.id),
    image_id: faceImageIdOf(doc),
    kind: text(doc && doc.kind) === 'EDGE' ? 'EDGE' : 'FACE'
  }))
  const primary = faceRows.find((doc) => text(doc && doc.kind) !== 'EDGE') || faceRows[0] || {}
  return {
    ok: true,
    sid,
    fid: text(primary.fid),
    seal_no: Number(sealRow && sealRow.seal_no),
    face_no: Number(primary.face_no),
    face_id: text(primary.id),
    image_id: faceImageIdOf(primary),
    faces,
    idempotent
  }
}

const ADMIN_OPS = Object.freeze({
  /**
   * **一次性幂等编号迁移（R-3 ＋ R-5｜V3 全量重编）** —— 管理员写面（白名单门同 `migrateDynastyValues`）。
   *
   * 契约（口径件 §4 / §8，逐条）：
   *   · **入参** `{ dry_run?: boolean }`（**缺省 `true`**；键面 ＝ `MIGRATE_ALLOWED_KEYS`，封闭）。
   *   · **改写面恰五个键族**：`xiai_seals.stamp_id`（＋新增 `seal_no` / `sid`）、
   *     `xiai_faces.stamp_id` / `sealId`（＋新增 `face_no` / `fid`）、`xiai_images.stamp_id`、
   *     `xiai_corrections.sealId` / `stamp_id`、`xiai_corrections_public.sealId` / `stamp_id`
   *     （**公开投影行两键同改** —— 口径件 §4 裁决：只改一个会让 §6.6「旧码命中 0」判负）。
   *   · **其余字段一字不动** —— `faceId`、影像 `_id`、行 `_id`、`seal_name`、`sealGroupId` … 逐字保留。
   *   · **发号顺序（一经分派即固定）**：印章按旧 `stamp_id` 数值升序（`"1"`…`"79"` ⇒ `seal_no` 1…79）；
   *     印面按「所属印章号 ＋ 同类序号（FACE 在前、EDGE 在后）」升序 ⇒ `face_no` 1…79。
   *     **已有号的行不重新发号**（幂等：只补缺号行）。
   *   · `sid` / `fid` 一律由 `no` **重算**（`codeId` 纯函数）；号域越界 ⇒ 结构化拒绝 ＋ 零写入。
   *   · **回包（固定键面）**：`{ ok, op, dry_run, scanned:{seals,faces,images,corrections,
   *     corrections_public}, assigned:{seals,faces}, rewritten:{…5 集合}, skipped:{…5 集合},
   *     mapping:{ seals:[{old_stamp_id,seal_no,sid}], faces:[{face_id,old_seal,face_no,fid}] },
   *     samples:[…], idempotent, plan? }` —— `mapping` 是**完整旧→新映射表**（干跑即得，供人工核）。
   *   · **幂等**：重放 ⇒ `assigned` 全 `0`、`rewritten` 全 `0`、**零写入**（不产 `plan`）。
   *   · `dry_run:true` ⇒ **零写入**，只回读数与映射表。
   *   · **不在本 op 内**：`xiai_seal_imports` 3,781 行不入（采纳时才发号）；`xiai_counters`
   *     **不进云读面**；不写 `faceId` / 影像 `_id` / 行 `_id`。
   * @param {object} [payload] `{ dry_run?: boolean }`
   * @param {{uid:string, phone:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  async migrateCodeNumbers(payload, identity, context) {
    /* ① 管理员白名单门（写之前；缺 env ⇒ 结构化拒绝 ＋ 零写入）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    const input = payload === undefined || payload === null ? {} : payload
    if (typeof input !== 'object' || Array.isArray(input)) {
      return deny(REASONS.INVALID_FIELD, '載荷形態不合法（應為物件）；本次零寫入。')
    }
    const unknown = Object.keys(input).filter((key) => MIGRATE_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}；本次零寫入。`)
    }
    let dryRun = true
    if (Object.prototype.hasOwnProperty.call(input, 'dry_run')) {
      if (typeof input.dry_run !== 'boolean') {
        return deny(REASONS.INVALID_VALUE, '`dry_run` 必須是布林值（true / false）；本次零寫入。')
      }
      dryRun = input.dry_run
    }

    /* ② 只读扫描（五个集合；单次上限 1000 行，分页护栏口径同既有 op）。 */
    const readAll = (collection) => readRows(collection, {}, { limit: 1000 })
    const seals = await readAll(COLLECTIONS.seals)
    const faces = await readAll(COLLECTIONS.faces)
    const images = await readAll(COLLECTIONS.images)
    const corrections = await readAll(COLLECTIONS.corrections)
    const publics = await readAll(COLLECTIONS.correctionsPublic)

    const scanned = {
      seals: seals.length,
      faces: faces.length,
      images: images.length,
      corrections: corrections.length,
      corrections_public: publics.length
    }
    const assigned = { seals: 0, faces: 0 }
    const rewritten = { seals: 0, faces: 0, images: 0, corrections: 0, corrections_public: 0 }
    const skipped = { seals: 0, faces: 0, images: 0, corrections: 0, corrections_public: 0 }
    const samples = []
    const writes = []
    const MAX_SAMPLES = 5
    const rowId = (row) => text(row && (row._id || row.id))
    const intOrNull = (value) => {
      const n = Number(value)
      return Number.isInteger(n) && n >= 1 ? n : null
    }
    /* 旧号识别（与 `db.js::legacySealSerialOf` 同一套换算；**只读、不改写旧行**）。 */
    const legacySerialOf = (stampId) => {
      const raw = text(stampId)
      if (!raw) return null
      if (/^\d{1,12}$/.test(raw)) return Number(raw)
      const xa = /^XA(\d{9})$/.exec(raw)
      if (xa) return Number(xa[1])
      const legacy = /^XAI-(\d+)$/.exec(raw)
      if (legacy) return Number(legacy[1])
      return null
    }
    const pushSample = (collection, id, before, after) => {
      if (samples.length < MAX_SAMPLES * 5) samples.push({ collection, id, before, after })
    }

    /* ③ 印章：已有 `seal_no` 的行占位不动；「已是 sid 形态却无号」的行按码反解占位；
          其余缺号行按**旧号数值升序**领号（跳过已占 ⇒ 幂等 + 无重号）。 */
    const finalSealNo = new Map()
    const usedSealNos = new Set()
    seals.forEach((row) => {
      const own = intOrNull(row && row.seal_no)
      if (own) {
        finalSealNo.set(row, own)
        usedSealNos.add(own)
      }
    })
    const backfilledSeals = []
    seals.forEach((row) => {
      if (finalSealNo.has(row)) return
      const decoded = codeId.decodeSealCode(text(row && row.stamp_id))
      if (decoded.ok) {
        finalSealNo.set(row, decoded.no)
        usedSealNos.add(decoded.no)
        backfilledSeals.push(row)
      }
    })
    const pendingSeals = seals
      .filter((row) => !finalSealNo.has(row))
      .sort((a, b) => {
        const sa = legacySerialOf(a && a.stamp_id)
        const sb = legacySerialOf(b && b.stamp_id)
        const na = sa === null ? Number.MAX_SAFE_INTEGER : sa
        const nb = sb === null ? Number.MAX_SAFE_INTEGER : sb
        if (na !== nb) return na - nb
        return rowId(a).localeCompare(rowId(b))
      })
    let sealCursor = 1
    pendingSeals.forEach((row) => {
      while (usedSealNos.has(sealCursor)) sealCursor += 1
      finalSealNo.set(row, sealCursor)
      usedSealNos.add(sealCursor)
      assigned.seals += 1
      sealCursor += 1
    })

    /* ④ 印章改写（键族：`stamp_id` → sid；新增 `seal_no` / `sid`）＋ 完整映射表。 */
    const mappingSeals = []
    const sealKeyToNo = new Map()
    for (const row of seals) {
      const no = finalSealNo.get(row)
      const encoded = codeId.encodeSealCode(no)
      if (!encoded.ok) {
        return deny(REASONS.INVALID_VALUE, `印章 ${rowId(row)} 的新號越界（seal_no=${no}）；本次零寫入。`)
      }
      const sid = encoded.code
      const oldStamp = text(row && row.stamp_id)
      sealKeyToNo.set(oldStamp, no)
      sealKeyToNo.set(sid, no)
      mappingSeals.push({ old_stamp_id: oldStamp, seal_no: no, sid })
      const doc = {}
      if (intOrNull(row && row.seal_no) !== no) doc.seal_no = no
      if (text(row && row.sid) !== sid) doc.sid = sid
      if (oldStamp !== sid) doc.stamp_id = sid
      if (Object.keys(doc).length > 0) {
        rewritten.seals += 1
        pushSample(COLLECTIONS.seals, rowId(row), { stamp_id: oldStamp, seal_no: row && row.seal_no }, doc)
        writes.push({ kind: 'update', collection: COLLECTIONS.seals, match: { _id: rowId(row) }, doc, expectAtLeast: 1 })
      } else {
        skipped.seals += 1
      }
    }
    mappingSeals.sort((a, b) => a.seal_no - b.seal_no)

    /* ⑤ 印面：按「所属印章号 ＋ 同类序号」升序领号（FACE 在前、EDGE 在后）。 */
    const kindOrder = (row) => (text(row && row.kind) === 'EDGE' ? 1 : 0)
    const faceSealNoOf = (row) => {
      const key = text(row && (row.sealId || row.stamp_id))
      return sealKeyToNo.has(key) ? sealKeyToNo.get(key) : Number.MAX_SAFE_INTEGER
    }
    const finalFaceNo = new Map()
    const usedFaceNos = new Set()
    faces.forEach((row) => {
      const own = intOrNull(row && row.face_no)
      if (own) {
        finalFaceNo.set(row, own)
        usedFaceNos.add(own)
      }
    })
    faces.forEach((row) => {
      if (finalFaceNo.has(row)) return
      const decoded = codeId.decodeFaceCode(text(row && row.fid))
      if (decoded.ok) {
        finalFaceNo.set(row, decoded.no)
        usedFaceNos.add(decoded.no)
      }
    })
    const pendingFaces = faces
      .filter((row) => !finalFaceNo.has(row))
      .sort(
        (a, b) =>
          faceSealNoOf(a) - faceSealNoOf(b) ||
          kindOrder(a) - kindOrder(b) ||
          rowId(a).localeCompare(rowId(b))
      )
    let faceCursor = 1
    pendingFaces.forEach((row) => {
      while (usedFaceNos.has(faceCursor)) faceCursor += 1
      finalFaceNo.set(row, faceCursor)
      usedFaceNos.add(faceCursor)
      assigned.faces += 1
      faceCursor += 1
    })

    /* ⑥ 印面改写（键族：`stamp_id` / `sealId` → 新 sid；新增 `face_no` / `fid`）。 */
    const mappingFaces = []
    for (const row of faces) {
      const no = finalFaceNo.get(row)
      const encoded = codeId.encodeFaceCode(no)
      if (!encoded.ok) {
        return deny(REASONS.INVALID_VALUE, `印面 ${rowId(row)} 的新號越界（face_no=${no}）；本次零寫入。`)
      }
      const fid = encoded.code
      const sealKey = text(row && (row.sealId || row.stamp_id))
      const newSealSid = sealKeyToNo.has(sealKey) ? codeId.encodeSealCode(sealKeyToNo.get(sealKey)).code : ''
      mappingFaces.push({ face_id: rowId(row), old_seal: sealKey, face_no: no, fid })
      const doc = {}
      if (newSealSid) {
        if (text(row && row.stamp_id) !== newSealSid) doc.stamp_id = newSealSid
        if (text(row && row.sealId) !== newSealSid) doc.sealId = newSealSid
      }
      if (intOrNull(row && row.face_no) !== no) doc.face_no = no
      if (text(row && row.fid) !== fid) doc.fid = fid
      if (Object.keys(doc).length > 0) {
        rewritten.faces += 1
        pushSample(COLLECTIONS.faces, rowId(row), { stamp_id: row && row.stamp_id, sealId: row && row.sealId, face_no: row && row.face_no }, doc)
        writes.push({ kind: 'update', collection: COLLECTIONS.faces, match: { _id: rowId(row) }, doc, expectAtLeast: 1 })
      } else {
        skipped.faces += 1
      }
    }
    mappingFaces.sort((a, b) => a.face_no - b.face_no)

    /* ⑦ 影像（键族：`stamp_id` → 新 sid；影像 `_id` **不动**）。 */
    const resolveSealSid = (key) => {
      const raw = text(key)
      if (!raw) return ''
      if (sealKeyToNo.has(raw)) {
        const encoded = codeId.encodeSealCode(sealKeyToNo.get(raw))
        return encoded.ok ? encoded.code : ''
      }
      return codeId.decodeSealCode(raw).ok ? raw : ''
    }
    for (const row of images) {
      const sid = resolveSealSid(row && (row.stamp_id || row.sealId))
      if (!sid) {
        skipped.images += 1
        continue
      }
      if (text(row && row.stamp_id) !== sid) {
        rewritten.images += 1
        pushSample(COLLECTIONS.images, rowId(row), { stamp_id: row && row.stamp_id }, { stamp_id: sid })
        writes.push({ kind: 'update', collection: COLLECTIONS.images, match: { _id: rowId(row) }, doc: { stamp_id: sid }, expectAtLeast: 1 })
      } else {
        skipped.images += 1
      }
    }

    /* ⑧ 勘误私有行（键族：`sealId` / `stamp_id` → 新 sid；`faceId` **不动**）。 */
    for (const row of corrections) {
      const sid = resolveSealSid(row && (row.sealId || row.stamp_id))
      if (!sid) {
        skipped.corrections += 1
        continue
      }
      const doc = {}
      if (text(row && row.sealId) !== sid) doc.sealId = sid
      if (text(row && row.stamp_id) !== sid) doc.stamp_id = sid
      if (Object.keys(doc).length > 0) {
        rewritten.corrections += 1
        pushSample(COLLECTIONS.corrections, rowId(row), { sealId: row && row.sealId, stamp_id: row && row.stamp_id }, doc)
        writes.push({ kind: 'update', collection: COLLECTIONS.corrections, match: { _id: rowId(row) }, doc, expectAtLeast: 1 })
      } else {
        skipped.corrections += 1
      }
    }

    /* ⑨ 公开投影行（键族：`sealId` **与** `stamp_id` **两键同改** —— 口径件 §4 裁决：
          该集合行同时带两个键，只改一个会让 §6.6「旧码命中 0」判负 ⇒ 两键一并改写为新 sid；
          `faceId` 等其余字段仍一字不动）。 */
    for (const row of publics) {
      const sid = resolveSealSid(row && (row.sealId || row.stamp_id))
      if (!sid) {
        skipped.corrections_public += 1
        continue
      }
      const doc = {}
      if (text(row && row.sealId) !== sid) doc.sealId = sid
      if (text(row && row.stamp_id) !== sid) doc.stamp_id = sid
      if (Object.keys(doc).length > 0) {
        rewritten.corrections_public += 1
        pushSample(COLLECTIONS.correctionsPublic, rowId(row), { sealId: row && row.sealId, stamp_id: row && row.stamp_id }, doc)
        writes.push({ kind: 'update', collection: COLLECTIONS.correctionsPublic, match: { _id: rowId(row) }, doc, expectAtLeast: 1 })
      } else {
        skipped.corrections_public += 1
      }
    }

    /* ⑩ 回包：只有「执行态且有写入」才产落盘计划 ⇒ `dry_run` / 重放 ⇒ 零写入。 */
    const rewrittenTotal = Object.keys(rewritten).reduce((sum, key) => sum + rewritten[key], 0)
    const result = {
      ok: true,
      op: 'migrateCodeNumbers',
      dry_run: dryRun,
      scanned,
      assigned,
      rewritten,
      skipped,
      mapping: { seals: mappingSeals, faces: mappingFaces },
      samples,
      idempotent: assigned.seals + assigned.faces === 0 && rewrittenTotal === 0
    }
    if (!dryRun && writes.length > 0) result.plan = { op: 'migrateCodeNumbers', writes }
    return result
  },

  /**
   * **【本单改造】簽發一枚斐萃（feicui）令牌** —— 管理员写面（**仅管理员**：沿用 `adminWhitelistDenial`：
   * 会话路看 `xiai_roles` 的 `role==='admin'`，令牌路看手机号白名单；两路都 fail-closed）。
   *
   * 为什么是**签名令牌**而不是一次性授权码：斐萃（本地电脑版）要长期调 yinyuan2026 的读面，
   * 而 `YINYUAN_API_KEY` **只许待在 xiai 侧**（斐萃侧零上游密钥）。令牌**自包含**
   * （`v1.<payload>.<hmac>`，payload `{v,uid,role,jti,iat,exp,kid}`）⇒ 服务端**验签即确权、不存状态**；
   * 「禁用」＝把 `jti` 写进 `config/feicui-token-revoked.json` 重新部署；「全体失效」＝轮换
   * `FEICUI_TOKEN_SECRET` ＋ `FEICUI_TOKEN_KID`。**本 op 零落盘**（不写任何集合、不读写 CloudBase）。
   *
   * 硬口径：
   *   · **载荷封闭三键**（`FEICUI_TOKEN_ALLOWED_KEYS`）：`target` / `role` / `ttl_seconds`；
   *     令牌本体、`jti`、`kid`、`iat` / `exp`、签发人一律服务端产出；
   *   · `target` 支持 **11 位手机号**（按仓内既有口径 `uidOf` ⇒ `u-`＋sha256 前 16 位，**不落手机号**）
   *     或**已有 uid**（`u-…` / 平台会话 uid）；二者都不是 ⇒ `INVALID_VALUE`（**回包不回显目标原文**）；
   *   · `role ∈ {user, admin}`（缺省 `user`）；`ttl_seconds` 缺省 **30 天**，区间
   *     `[300, 7776000]` 秒（越界 ⇒ `INVALID_VALUE`，**不静默夹取**）；
   *   · **缺 `FEICUI_TOKEN_SECRET` ⇒ `STORAGE_UNAVAILABLE`**（不签发、不降级）；
   *   · 回包只给**令牌与它的元数据**（`token` / `uid` / `role` / `kid` / `jti` / `iat` / `exp` /
   *     `expires_at` / `ttl_seconds`）—— 不再有 `plan`（本 op **不写库**）。
   *
   * @param {{target?:string, role?:string, ttl_seconds?:number}} payload
   * @param {{uid:string, role:string, identity_source:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context] 白名单手机号 ＋ 服务端时钟（秒）
   * @returns {Promise<{ok:true, op:string, row:object}|{ok:false, reason:string, message:string}>}
   */
  async issueFeicuiToken(payload, identity, context) {
    /* ① 管理员门（**写/签之前**；缺 env 或角色不足 ⇒ 结构化拒绝）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* ② 载荷形态 / 封闭键面。 */
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload：target / role / ttl_seconds）；本次不簽發。')
    }
    const unknown = Object.keys(payload).filter((key) => FEICUI_TOKEN_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端派生，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未登記欄位：${unknown.join('、')}（${hint}）；本次不簽發。`)
    }
    /* ③ 目标 → uid（**手机号按仓内既有口径派生，回包与报错都不回显目标原文**）。 */
    const target = text(payload.target)
    if (!target) {
      return deny(REASONS.MISSING_REQUIRED, '缺少目標（target：11 位手機號或既有 uid）；本次不簽發。')
    }
    let uid = ''
    if (isPhoneLike(target)) uid = uidOf(target)
    else if (/^[A-Za-z0-9._:-]{1,128}$/.test(target)) uid = target
    if (!uid) {
      return deny(REASONS.INVALID_VALUE, '目標形態不合（既非 11 位手機號，也非合法 uid）；本次不簽發。')
    }
    /* ④ 角色 / TTL 值域。 */
    const role = text(payload.role) || ROLE.USER
    if (feicuiToken.ROLES.indexOf(role) === -1) {
      return deny(REASONS.INVALID_VALUE, `角色「${role}」不在允許面（user / admin）之內；本次不簽發。`)
    }
    let ttlSeconds = feicuiToken.DEFAULT_TTL_SECONDS
    if (payload.ttl_seconds !== undefined && payload.ttl_seconds !== null && payload.ttl_seconds !== '') {
      const parsed = Number(payload.ttl_seconds)
      if (!Number.isFinite(parsed) || Math.floor(parsed) !== parsed) {
        return deny(REASONS.INVALID_VALUE, 'TTL 必須是整數秒數；本次不簽發。')
      }
      if (parsed < feicuiToken.MIN_TTL_SECONDS || parsed > feicuiToken.MAX_TTL_SECONDS) {
        return deny(
          REASONS.INVALID_VALUE,
          `TTL 超出允許區間（${feicuiToken.MIN_TTL_SECONDS}–${feicuiToken.MAX_TTL_SECONDS} 秒）；本次不簽發。`
        )
      }
      ttlSeconds = parsed
    }
    /* ⑤ 签发（**密钥只从函数环境变量读**；缺 ⇒ fail-closed）。 */
    const signed = feicuiToken.sign({
      uid,
      role,
      ttlSeconds,
      env: process.env,
      nowSeconds: context && Number.isFinite(context.nowSeconds) ? context.nowSeconds : undefined
    })
    if (!signed.ok) {
      const internal = signed.reason === feicuiToken.DETAILS.SECRET_MISSING || signed.reason === feicuiToken.DETAILS.CLOCK_UNAVAILABLE
      return deny(
        internal ? REASONS.STORAGE_UNAVAILABLE : REASONS.INVALID_VALUE,
        `${signed.message || '斐萃令牌簽發失敗。'}`
      )
    }
    return {
      ok: true,
      op: 'issueFeicuiToken',
      /* **回给管理员的最小面**：令牌 ＋ 元数据；无 plan ⇒ 零落盘。 */
      row: {
        token: signed.token,
        uid: signed.uid,
        role: signed.role,
        kid: signed.kid,
        jti: signed.jti,
        iat: signed.iat,
        exp: signed.exp,
        expires_at: signed.expires_at,
        ttl_seconds: signed.ttl_seconds
      }
    }
  },

  /**
   * 审核勘误（**管理员写路径**；两处落盘：先公开脱敏投影、后私有状态）。
   * 判定顺序（**全部在写之前**）：① 管理员白名单门 → ② 载荷形态 / 键面 →
   * ③ 单号 / 决定值域 / 理由长度 → ④ 读私有行 → ⑤ 存在性 / 状态门（仅 `PENDING` 可审）→
   * ⑥ 采纳值域门（R-20 / R-30 / R-31）。
   * @param {object} payload 载荷（允许键见 `REVIEW_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份（唯一来源）
   * @param {{adminPhone?:string, nowSeconds?:number}} [context] 白名单手机号 ＋ 服务端时钟（秒）
   * @returns {Promise<{ok:true, op:string, row:object, projection:object,
   *          plan:{op:string, writes:Array<object>}}|{ok:false, reason:string, message:string}>}
   */
  async reviewCorrection(payload, identity, context) {
    /* ① 管理员白名单门（**身份判据，写之前**；缺 env ⇒ 结构化拒绝 ＋ 零写入）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* **S1 分权（无审核直写面本单）**：直写专身份**不得**执行 `review*` 系 op（该身份只能直写）。 */
    const directWriteDenial = directWriteReviewerDenial(identity)
    if (directWriteDenial) return directWriteDenial
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => REVIEW_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => REVIEW_IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const correctionId = text(payload.correction_id)
    if (!correctionId) {
      return deny(REASONS.MISSING_REQUIRED, '缺少勘誤單號（correction_id）⇒ 拒絕審覈；本次零寫入。')
    }
    if (correctionId.length > MAX_ID_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `勘誤單號超出上限（${MAX_ID_LENGTH} 字）⇒ 拒絕審覈；本次零寫入。`)
    }
    const rawDecision = text(payload.decision)
    const decision = LEGACY_DECISION[rawDecision] || rawDecision
    if (DECISIONS.indexOf(decision) === -1) {
      return deny(
        REASONS.INVALID_VALUE,
        `審覈決定「${rawDecision || '（空）'}」不在允許的 2 類之內（ACCEPTED 採納 / REJECTED 駁回；` +
          '舊字面值 APPROVED 按採納兼容）⇒ 拒絕寫入；本次零寫入。'
      )
    }
    const rawNote = payload.note === undefined || payload.note === null ? '' : payload.note
    if (typeof rawNote !== 'string') {
      return deny(REASONS.INVALID_VALUE, '駁回理由必須是文字 ⇒ 拒絕審覈；本次零寫入。')
    }
    const noteText = rawNote.trim()
    if (noteText.length > MAX_NOTE_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `駁回理由不得超過 ${MAX_NOTE_LENGTH} 字 ⇒ 拒絕審覈；本次零寫入。`)
    }
    /* ④ 读私有行（**只读**；网络 / 内部异常由此抛出 ⇒ `index.js` 转 `STORAGE_UNAVAILABLE`）。 */
    const found = await readCorrectionRow(correctionId)
    if (!found) {
      return deny(REASONS.INVALID_VALUE, `未找到該勘誤單（correction_id）：${correctionId}；本次零寫入。`)
    }
    const row = found.row
    const currentStatus = text(row.status)
    if (currentStatus !== CORRECTION_STATUS.PENDING) {
      return deny(
        REASONS.INVALID_VALUE,
        `該勘誤已審覈（當前狀態：${currentStatus || '（空）'}）⇒ 不可重複處理（終態不回退）；本次零寫入。`
      )
    }
    const accepted = decision === CORRECTION_STATUS.ACCEPTED
    /* ⑥ 采纳值域门（**写之前**）：被采纳的值必须 ∈ 冻结真源；不在 ⇒ 结构化拒绝 ＋ 零写入。 */
    if (accepted) {
      const domain = Object.prototype.hasOwnProperty.call(VALUE_DOMAINS, text(row.field))
        ? VALUE_DOMAINS[text(row.field)]
        : null
      if (domain && domain.indexOf(text(row.value)) === -1) {
        return deny(
          REASONS.INVALID_VALUE,
          `採納被拒：建議值不在「${MARKABLE_FIELDS[text(row.field)] || text(row.field)}」的凍結值域內（該勘誤建議「駁回」）；本次零寫入。`
        )
      }
    }
    /* **摘要行读面（本单）**：读该 `(faceId, field, value)` 的全部提交行 ＋ 采信行（**只读**，
       在写之前）——用于重算值级公开摘要行；本次决定**就地覆盖**目标行的 `status`（不改库，仅内存）。 */
    const summaryFaceId = text(row.faceId)
    const summaryField = text(row.field)
    const summaryValue = text(row.value)
    const summarySeal = text(row.sealId || row.stamp_id)
    const siblings = await readRows(COLLECTIONS.corrections, {
      faceId: summaryFaceId,
      field: summaryField,
      value: summaryValue
    })
    const endorsements = await readRows(COLLECTIONS.endorsements, {
      faceId: summaryFaceId,
      field: summaryField,
      value: summaryValue
    })
    const submissions = siblings.map((item) => {
      const sameRow =
        text(item && item.id) === correctionId ||
        text(item && item._id) === text(row._id) ||
        text(item && item._id) === correctionId
      return sameRow ? Object.assign({}, item, { status: decision }) : item
    })
    /* 兜底：若检索式没命中本次被审的那一行（历史行缺 `faceId` 等）⇒ 显式并入（status 取本次决定）。 */
    const targetPresent = submissions.some(
      (item) =>
        text(item && item.id) === correctionId ||
        text(item && item._id) === correctionId ||
        text(item && item._id) === text(row._id)
    )
    if (!targetPresent) submissions.push(Object.assign({}, row, { status: decision }))
    /* 落盘计划：**先公开投影（派生、确定性 id ⇒ 幂等 upsert）、后私有状态（权威）**。 */
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const at = new Date(seconds * 1000).toISOString()
    const projection = buildProjection(row, decision, at, correctionId)
    /* **摘要行重算（本单）**：采纳 / 驳回成功后 upsert 值级公开摘要行（status 随之更新）。 */
    const summaryRow = buildCorrectionSummary({
      faceId: summaryFaceId,
      sealId: summarySeal,
      field: summaryField,
      value: summaryValue,
      submissions,
      endorsements,
      at
    })
    const privatePatch = {
      status: decision,
      reviewed_at: at,
      reviewer_id: identity.uid
    }
    /* **僅駁回且有理由**才落 `review_note`（采納 / 空理由不出现该键）。 */
    if (!accepted && noteText !== '') privatePatch.review_note = noteText
    const decidedRow = Object.assign({}, row, privatePatch)
    return {
      ok: true,
      op: 'reviewCorrection',
      row: decidedRow,
      projection,
      /* 值级公开摘要行（status 已随采纳 / 驳回更新）。 */
      summary: summaryRow,
      plan: {
        op: 'reviewCorrection',
        writes: [
          {
            kind: 'set',
            collection: COLLECTIONS.correctionsPublic,
            id: `${PUBLIC_ID_PREFIX}${correctionId}`,
            doc: projection
          },
          {
            kind: 'update',
            collection: COLLECTIONS.corrections,
            match: found.match,
            doc: privatePatch,
            expectAtLeast: 1
          },
          {
            kind: 'set',
            collection: COLLECTIONS.correctionSummaries,
            id: summaryRow._id,
            doc: summaryRow
          }
        ]
      }
    }
  },

  /**
   * 设置邀请奖励数值（**管理员写路径**；值域门 ＋ 白名单门，**均在任何写入之前**）。
   * 明文：**本 op 不产出云落盘计划** —— 站点配置键（`xiai:v1:invite-reward`）活在客户端
   * localStorage（链路 `admin.js → drive.js → storage.js`，与管理员函数 Phase 1 同口径）；
   * 本 op 的职责只是「服务端判身份 ＋ 判值域」，过门后才由**客户端**写该配置键。
   * @param {object} payload 载荷（允许键见 `REWARD_ALLOWED_KEYS`：只有 `value`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   * @param {{adminPhone?:string}} [context] 白名单手机号
   * @returns {{ok:true, op:string, value:number}|{ok:false, reason:string, message:string}}
   */
  setInviteReward(payload, identity, context) {
    /* ① 管理员白名单门（**身份判据，写之前**；缺 env ⇒ 结构化拒绝 ＋ 零写入）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => REWARD_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => REVIEW_IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const value = payload.value
    if (!Number.isInteger(value) || value < 0) {
      return deny(
        REASONS.INVALID_VALUE,
        '邀請獎勵必須是「非負整數」（非整數 / 負數 / 非數字一律拒收）；本次零寫入。'
      )
    }
    return { ok: true, op: 'setInviteReward', value }
  },

  /**
   * **审核印人提案（管理员；person-model §3）**：① 管理员白名单门 → ② 载荷键面 →
   * ③ 单号 / 决定值域 / 理由长度 → ④ 读提案行 → ⑤ 状态门（仅 `PENDING` 可审）→
   * ⑥ 采纳 ⇒ **幂等**生成 `xiai_persons` 行（`proposal_id` 溯源；重复采纳不新增 / 不改写）；
   * 驳回 ⇒ **零写入**（仅提案行状态）。reason 一律沿用既有冻结字面值。
   * @param {object} payload 载荷（允许键见 `PERSON_REVIEW_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  async reviewPersonProposal(payload, identity, context) {
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* **S1 分权（无审核直写面本单）**：直写专身份**不得**执行 `review*` 系 op（该身份只能直写）。 */
    const directWriteDenial = directWriteReviewerDenial(identity)
    if (directWriteDenial) return directWriteDenial
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => PERSON_REVIEW_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => REVIEW_IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const proposalId = text(payload.proposal_id)
    if (!proposalId) {
      return deny(REASONS.MISSING_REQUIRED, '缺少印人提案單號（proposal_id）⇒ 拒絕審覈；本次零寫入。')
    }
    if (proposalId.length > MAX_ID_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `印人提案單號超出上限（${MAX_ID_LENGTH} 字）⇒ 拒絕審覈；本次零寫入。`)
    }
    const rawDecision = text(payload.decision)
    const decision = LEGACY_DECISION[rawDecision] || rawDecision
    if (DECISIONS.indexOf(decision) === -1) {
      return deny(
        REASONS.INVALID_VALUE,
        `審覈決定「${rawDecision || '（空）'}」不在允許的 2 類之內（ACCEPTED 採納 / REJECTED 駁回）⇒ 拒絕寫入；本次零寫入。`
      )
    }
    const rawNote = payload.note === undefined || payload.note === null ? '' : payload.note
    if (typeof rawNote !== 'string') {
      return deny(REASONS.INVALID_VALUE, '駁回理由必須是文字 ⇒ 拒絕審覈；本次零寫入。')
    }
    const noteText = rawNote.trim()
    if (noteText.length > MAX_NOTE_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `駁回理由不得超過 ${MAX_NOTE_LENGTH} 字 ⇒ 拒絕審覈；本次零寫入。`)
    }
    const found = await readPersonProposalRow(proposalId)
    if (!found) {
      return deny(REASONS.NOT_FOUND, `未找到該印人提案（proposal_id）：${proposalId}；本次零寫入。`)
    }
    const row = found.row
    if (text(row.status) !== PERSON_PROPOSAL_STATUS.PENDING) {
      return deny(
        REASONS.INVALID_VALUE,
        `該印人提案已審覈（當前狀態：${text(row.status) || '（空）'}）⇒ 不可重複處理（終態不回退）；本次零寫入。`
      )
    }
    const accepted = decision === PERSON_PROPOSAL_STATUS.ACCEPTED
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const at = new Date(seconds * 1000).toISOString()
    const privatePatch = { status: decision, reviewed_at: at, reviewer_id: identity.uid }
    if (!accepted && noteText !== '') privatePatch.review_note = noteText
    const writes = [
      { kind: 'update', collection: COLLECTIONS.personProposals, match: found.match, doc: privatePatch, expectAtLeast: 1 }
    ]
    let person = null
    if (accepted && !row.target_person_id) {
      const persons = rowsOfReply(await resolveDb().collection(COLLECTIONS.persons).get())
      const existing = persons.find((item) => text(item && item.proposal_id) === proposalId)
      if (existing) {
        person = existing
      } else {
        let max = 0
        persons.forEach((item) => {
          const matched = new RegExp(`^${PERSON_CODE_PREFIX}(\\d{9})$`).exec(text(item && item.code))
          if (matched) max = Math.max(max, Number(matched[1]))
        })
        const taken = new Set(persons.map((item) => text(item && item.code)))
        let index = max + 1
        while (taken.has(`${PERSON_CODE_PREFIX}${String(index).padStart(9, '0')}`)) index += 1
        const code = `${PERSON_CODE_PREFIX}${String(index).padStart(9, '0')}`
        person = {
          id: code,
          code,
          family_name: text(row.family_name),
          given_name: text(row.given_name),
          courtesy_names: Array.isArray(row.courtesy_names) ? row.courtesy_names : [],
          art_names: Array.isArray(row.art_names) ? row.art_names : [],
          alias_names: Array.isArray(row.alias_names) ? row.alias_names : [],
          birth_year: row.birth_year === undefined ? null : row.birth_year,
          death_year: row.death_year === undefined ? null : row.death_year,
          years_lived: null,
          birth_era_text: '',
          death_era_text: '',
          dynasty: '',
          gender: '',
          cbdb_id: text(row.cbdb_id),
          card_id: text(row.card_id),
          /* **批 2（v1.54｜§3.54.13 / §4.1.16）**：采纳提案落 `xiai_persons` 行时带上六扩字段
             （四正字段 ＋ 两繁简副字段；值来自提案行，**不做任何转换改写**）。 */
          native_place: text(row.native_place),
          biography: text(row.biography),
          source: text(row.source),
          source_id: text(row.source_id),
          native_place_chs: text(row.native_place_chs),
          biography_chs: text(row.biography_chs),
          proposal_id: proposalId,
          created_by: identity.uid,
          created_at: at,
          updated_at: at
        }
        writes.push({ kind: 'set', collection: COLLECTIONS.persons, id: code, doc: person })
      }
    }
    return {
      ok: true,
      op: 'reviewPersonProposal',
      row: Object.assign({}, row, privatePatch),
      person,
      plan: { op: 'reviewPersonProposal', writes }
    }
  },

  /**
   * **審核外部導入行（採納 / 駁回；§3.54.15）**：① 管理員白名單門 → ② 載荷鍵面 →
   * ③ 批次 / 單行 / 決定值域 / 理由長度 → ④ 讀導入行（批次或單行；只讀）→
   * **採納** ⇒ 對每條 `PENDING` 行按 `source_person_id` **冪等**落 `xiai_persons`
   * （重複採納**不改寫既有行**；幂等键缺失的行**保持 `PENDING` 且零寫入**）；
   * **駁回** ⇒ **零寫入**（僅導入行狀態）。三態單向、終態不回退。reason 一律沿用既有凍結字面值。
   * @param {object} payload 载荷（允许键见 `PERSON_IMPORT_REVIEW_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  async reviewPersonImport(payload, identity, context) {
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* **S1 分权（无审核直写面本单）**：直写专身份**不得**执行 `review*` 系 op（该身份只能直写）。 */
    const directWriteDenial = directWriteReviewerDenial(identity)
    if (directWriteDenial) return directWriteDenial
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => PERSON_IMPORT_REVIEW_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => REVIEW_IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const batchId = text(payload.batch_id)
    const importId = text(payload.import_id)
    if (!batchId && !importId) {
      return deny(REASONS.MISSING_REQUIRED, '缺少導入批次號（batch_id）或導入行號（import_id）⇒ 拒絕審覈；本次零寫入。')
    }
    const rawDecision = text(payload.decision)
    const decision = LEGACY_DECISION[rawDecision] || rawDecision
    if (DECISIONS.indexOf(decision) === -1) {
      return deny(
        REASONS.INVALID_VALUE,
        `審覈決定「${rawDecision || '（空）'}」不在允許的 2 類之內（ACCEPTED 採納 / REJECTED 駁回）⇒ 拒絕寫入；本次零寫入。`
      )
    }
    const rawNote = payload.note === undefined || payload.note === null ? '' : payload.note
    if (typeof rawNote !== 'string') {
      return deny(REASONS.INVALID_VALUE, '駁回理由必須是文字 ⇒ 拒絕審覈；本次零寫入。')
    }
    const noteText = rawNote.trim()
    if (noteText.length > MAX_NOTE_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `駁回理由不得超過 ${MAX_NOTE_LENGTH} 字 ⇒ 拒絕審覈；本次零寫入。`)
    }
    /* ④ 读导入行（批次或单行；**只读** —— 不是写）。
       **本单 I-3（真因修复）**：批次路**按 `status = PENDING` 取行 ＋ 显式限量**
       —— 旧式 `where({batch_id}).get()` 受平台默认上限 100 行所限，批内超过 100 行时
       **处理完前 100 行后每次都读到同一批已终态行** ⇒ `plan.writes` 恒空。按 `PENDING`
       取行 ⇒ 已审行不再进入读集 ⇒ **天然自愈分页，可反复调用直至清空**。
       本批若**无待审行**（已全部处理完）⇒ 再只读一次本批（限量）以**如实报出 `skipped`**，
       而不是把「做完了」伪装成 `NOT_FOUND`。 */
    let targets = []
    let skippedSeed = []
    if (importId) {
      const found = await readPersonImportRow(importId)
      if (found) targets = [found.row]
    } else {
      targets = await readRows(
        COLLECTIONS.personImports,
        { batch_id: batchId, status: PERSON_IMPORT_STATUS.PENDING },
        { limit: IMPORT_REVIEW_PAGE_SIZE }
      )
      if (targets.length === 0) {
        const done = await readRows(COLLECTIONS.personImports, { batch_id: batchId }, { limit: IMPORT_REVIEW_PAGE_SIZE })
        skippedSeed = done.map((row) => text(row && row.id)).filter((id) => id !== '')
      }
    }
    if (targets.length === 0 && skippedSeed.length === 0) {
      return deny(REASONS.NOT_FOUND, `未找到匹配的外部導入行（batch_id：${batchId || '（空）'} / import_id：${importId || '（空）'}）；本次零寫入。`)
    }
    const accepted = decision === PERSON_IMPORT_STATUS.ACCEPTED
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const at = new Date(seconds * 1000).toISOString()
    const writes = []
    const acceptedIds = []
    const rejectedIds = []
    const skipped = skippedSeed.slice()
    const failed = []
    let personsCache = null
    const personsOf = async () => {
      if (personsCache === null) personsCache = rowsOfReply(await resolveDb().collection(COLLECTIONS.persons).get())
      return personsCache
    }
    for (const row of targets) {
      const rid = text(row && row.id)
      const current = text(row && row.status) || PERSON_IMPORT_STATUS.PENDING
      const privatePatch = { status: decision, reviewed_at: at, reviewer_id: identity.uid }
      if (!accepted && noteText !== '') privatePatch.review_note = noteText
      /* 终态不回退：已审行**跳过**（幂等重放场景不改写既有终态）。 */
      if (current !== PERSON_IMPORT_STATUS.PENDING) {
        skipped.push(rid)
        continue
      }
      if (!accepted) {
        writes.push({ kind: 'update', collection: COLLECTIONS.personImports, match: { id: rid }, doc: privatePatch, expectAtLeast: 1 })
        rejectedIds.push(rid)
        continue
      }
      const sourceId = text(row && row.source_person_id)
      if (!sourceId) {
        /* 幂等键缺失 ⇒ **该行失败、保持 PENDING 且零写入**（不动 person、不改本行）。 */
        failed.push(rid)
        continue
      }
      const persons = await personsOf()
      /* **I-1 顺序（本单硬口径）**：**先落正式行**（按幂等键去重 ⇒ 重跑不产生重复行），
         **后翻导入行状态**（`expectAtLeast:1`）—— 见下方 `writes` 压栈顺序。 */
      const existing = persons.find((item) => text(item && item.source_person_id) === sourceId)
      if (!existing) {
        const code = nextPersonCodeOf(persons)
        const person = buildPersonDocFromImport(row, identity, at, code)
        persons.push(person)
        writes.push({ kind: 'set', collection: COLLECTIONS.persons, id: code, doc: person })
      }
      writes.push({ kind: 'update', collection: COLLECTIONS.personImports, match: { id: rid }, doc: privatePatch, expectAtLeast: 1 })
      acceptedIds.push(rid)
    }
    return {
      ok: true,
      op: 'reviewPersonImport',
      accepted,
      accepted_ids: acceptedIds,
      rejected_ids: rejectedIds,
      skipped,
      failed,
      plan: { op: 'reviewPersonImport', writes }
    }
  },

  /**
   * **審核印章外部導入行（採納 / 駁回；§3.55.4 / §3.55.5）**：① 管理員白名單門 → ② 載荷鍵面 →
   * ③ 批次 / 單行 / 決定值域 / 理由長度 → ④ 讀導入行（批次或單行；只讀）→
   * **採納** ⇒ 對每條 `PENDING` 行按 `source` ＋ `source_seal_id` **冪等**整條落
   * `xiai_seals` ＋ `xiai_faces`（`review_status='APPROVED'`；重複採納**不改寫既有行**）；
   * **採納時逐條校驗影像引用對象存在**（缺失 ⇒ 該條拒絕 ＋ 零寫入；`kind=FACE` 無引用亦拒）；
   * **駁回** ⇒ **零寫入**（僅導入行狀態）。三態單向、終態不回退。reason 一律沿用既有凍結字面值。
   * @param {object} payload 载荷（允许键见 `SEAL_IMPORT_REVIEW_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  async reviewSealImport(payload, identity, context) {
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* **S1 分权（无审核直写面本单）**：直写专身份**不得**执行 `review*` 系 op（该身份只能直写）。 */
    const directWriteDenial = directWriteReviewerDenial(identity)
    if (directWriteDenial) return directWriteDenial
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => SEAL_IMPORT_REVIEW_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const batchId = text(payload.batch_id)
    const importId = text(payload.import_id)
    if (!batchId && !importId) {
      return deny(REASONS.MISSING_REQUIRED, '缺少導入批次號（batch_id）或導入行號（import_id）⇒ 拒絕審覈；本次零寫入。')
    }
    const rawDecision = text(payload.decision)
    const decision = LEGACY_DECISION[rawDecision] || rawDecision
    if (DECISIONS.indexOf(decision) === -1) {
      return deny(
        REASONS.INVALID_VALUE,
        `審覈決定「${rawDecision || '（空）'}」不在允許的 2 類之內（ACCEPTED 採納 / REJECTED 駁回）⇒ 拒絕寫入；本次零寫入。`
      )
    }
    const rawNote = payload.note === undefined || payload.note === null ? '' : payload.note
    if (typeof rawNote !== 'string') {
      return deny(REASONS.INVALID_VALUE, '駁回理由必須是文字 ⇒ 拒絕審覈；本次零寫入。')
    }
    const noteText = rawNote.trim()
    if (noteText.length > MAX_NOTE_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `駁回理由不得超過 ${MAX_NOTE_LENGTH} 字 ⇒ 拒絕審覈；本次零寫入。`)
    }
    /* ④ 读导入行（批次或单行；**只读** —— 不是写）。
       **本单 I-3**：批次路**按 `status = PENDING` 取行 ＋ 显式限量**（同 person 通道口径；
       旧式按 `batch_id` 取行受平台默认 100 行上限 ⇒ 批内 > 100 行时永远推进不了第 101 行）。
       本批若无待审行 ⇒ 再只读一次本批（限量）以**如实报出 `skipped`**，不伪装成 `NOT_FOUND`。 */
    let targets = []
    let skippedSeed = []
    if (importId) {
      const found = await readSealImportRow(importId)
      if (found) targets = [found.row]
    } else {
      targets = await readRows(
        COLLECTIONS.sealImports,
        { batch_id: batchId, status: SEAL_IMPORT_STATUS.PENDING },
        { limit: IMPORT_REVIEW_PAGE_SIZE }
      )
      if (targets.length === 0) {
        const done = await readRows(COLLECTIONS.sealImports, { batch_id: batchId }, { limit: IMPORT_REVIEW_PAGE_SIZE })
        skippedSeed = done.map((row) => text(row && row.id)).filter((id) => id !== '')
      }
    }
    if (targets.length === 0 && skippedSeed.length === 0) {
      return deny(REASONS.NOT_FOUND, `未找到匹配的印章外部導入行（batch_id：${batchId || '（空）'} / import_id：${importId || '（空）'}）；本次零寫入。`)
    }
    const accepted = decision === SEAL_IMPORT_STATUS.ACCEPTED
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const at = new Date(seconds * 1000).toISOString()
    const writes = []
    const acceptedIds = []
    const rejectedIds = []
    const skipped = skippedSeed.slice()
    const failed = []
    let sealsCache = null
    let facesCache = null
    const sealsOf = async () => {
      if (sealsCache === null) sealsCache = rowsOfReply(await resolveDb().collection(COLLECTIONS.seals).get())
      return sealsCache
    }
    const facesOf = async () => {
      if (facesCache === null) facesCache = rowsOfReply(await resolveDb().collection(COLLECTIONS.faces).get())
      return facesCache
    }
    for (const row of targets) {
      const rid = text(row && row.id)
      const current = text(row && row.status) || SEAL_IMPORT_STATUS.PENDING
      const privatePatch = { status: decision, reviewed_at: at, reviewer_id: identity.uid }
      if (!accepted && noteText !== '') privatePatch.review_note = noteText
      /* 终态不回退：已审行**跳过**（幂等重放场景不改写既有终态）。 */
      if (current !== SEAL_IMPORT_STATUS.PENDING) {
        skipped.push(rid)
        continue
      }
      if (!accepted) {
        writes.push({ kind: 'update', collection: COLLECTIONS.sealImports, match: { id: rid }, doc: privatePatch, expectAtLeast: 1 })
        rejectedIds.push(rid)
        continue
      }
      const sourceSealId = text(row && row.source_seal_id)
      if (!sourceSealId) {
        /* 幂等键缺失 ⇒ **该行失败、保持 PENDING 且零写入**（不动正式行、不改本行）。 */
        failed.push(rid)
        continue
      }
      const seals = await sealsOf()
      /* **I-1 顺序（本单硬口径）**：**先落正式行**（印章 ＋ 印面；按 `(source_seal_id, source)`
         幂等键去重 ⇒ 重跑不产生重复行），**后翻导入行状态**（`expectAtLeast:1`）。 */
      const existing = seals.find((item) => text(item && item.source_seal_id) === sourceSealId && text(item && item.source) === text(row && row.source))
      if (!existing) {
        /* **影像引用逐条校验 ＋ 采纳落点构造**（与 `repairImportAcceptance` **同一套**构建函数）。 */
        const built = await buildSealAcceptanceFromImport(row, seals, await facesOf(), identity, at)
        if (!built.ok) {
          /* 该条失败：保持 PENDING 且零写入（不动 seals / faces、不改本行）。 */
          failed.push(rid)
          continue
        }
        seals.push(built.sealDoc)
        writes.push({ kind: 'set', collection: COLLECTIONS.seals, id: built.stampId, doc: built.sealDoc })
        const allFaces = await facesOf()
        for (const faceDoc of built.faceDocs) {
          writes.push({ kind: 'set', collection: COLLECTIONS.faces, id: faceDoc.id, doc: faceDoc })
          allFaces.push(faceDoc)
        }
      }
      writes.push({ kind: 'update', collection: COLLECTIONS.sealImports, match: { id: rid }, doc: privatePatch, expectAtLeast: 1 })
      acceptedIds.push(rid)
    }
    return {
      ok: true,
      op: 'reviewSealImport',
      accepted,
      accepted_ids: acceptedIds,
      rejected_ids: rejectedIds,
      skipped,
      failed,
      plan: { op: 'reviewSealImport', writes }
    }
  },

  /**
   * **審核印谱外部導入行（採納 / 駁回；v1.61）**：① 管理員白名單門 → ② 載荷鍵面 →
   * ③ 批次 / 單行 / 決定值域 / 理由長度 → ④ 讀導入行（批次或單行；只讀）→
   * **採納** ⇒ 對每條 `PENDING` 行按 `source_item_id` **冪等**落 `xiai_items`
   * （重複採納**不改寫既有行**；冪等鍵缺失的行**保持 `PENDING` 且零寫入**）；
   * **駁回** ⇒ **零寫入**（僅導入行狀態）。三態單向、終態不回退。reason 一律沿用既有凍結字面值。
   * 採納落正式行：**恰本體 22 字段**（**無 `raw_json`**；沿 X4）。
   * @param {object} payload 载荷（允许键见 `ITEM_IMPORT_REVIEW_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  async reviewItemImport(payload, identity, context) {
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* **S1 分权（无审核直写面本单）**：直写专身份**不得**执行 `review*` 系 op（该身份只能直写）。 */
    const directWriteDenial = directWriteReviewerDenial(identity)
    if (directWriteDenial) return directWriteDenial
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => ITEM_IMPORT_REVIEW_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => REVIEW_IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const batchId = text(payload.batch_id)
    const importId = text(payload.import_id)
    if (!batchId && !importId) {
      return deny(REASONS.MISSING_REQUIRED, '缺少導入批次號（batch_id）或導入行號（import_id）⇒ 拒絕審覈；本次零寫入。')
    }
    const rawDecision = text(payload.decision)
    const decision = LEGACY_DECISION[rawDecision] || rawDecision
    if (DECISIONS.indexOf(decision) === -1) {
      return deny(
        REASONS.INVALID_VALUE,
        `審覈決定「${rawDecision || '（空）'}」不在允許的 2 類之內（ACCEPTED 採納 / REJECTED 駁回）⇒ 拒絕寫入；本次零寫入。`
      )
    }
    const rawNote = payload.note === undefined || payload.note === null ? '' : payload.note
    if (typeof rawNote !== 'string') {
      return deny(REASONS.INVALID_VALUE, '駁回理由必須是文字 ⇒ 拒絕審覈；本次零寫入。')
    }
    const noteText = rawNote.trim()
    if (noteText.length > MAX_NOTE_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `駁回理由不得超過 ${MAX_NOTE_LENGTH} 字 ⇒ 拒絕審覈；本次零寫入。`)
    }
    /* ④ 读导入行（批次或单行；**只读** —— 不是写）。
       **本单 I-3**：批次路**按 `status = PENDING` 取行 ＋ 显式限量**（同 person / seal 通道口径；
       旧式按 `batch_id` 取行受平台默认 100 行上限 ⇒ 批内 > 100 行时永远推进不了第 101 行）。
       本批若无待审行 ⇒ 再只读一次本批（限量）以**如实报出 `skipped`**，不伪装成 `NOT_FOUND`。 */
    let targets = []
    let skippedSeed = []
    if (importId) {
      const found = await readItemImportRow(importId)
      if (found) targets = [found.row]
    } else {
      targets = await readRows(
        COLLECTIONS.itemImports,
        { batch_id: batchId, status: ITEM_IMPORT_STATUS.PENDING },
        { limit: IMPORT_REVIEW_PAGE_SIZE }
      )
      if (targets.length === 0) {
        const done = await readRows(COLLECTIONS.itemImports, { batch_id: batchId }, { limit: IMPORT_REVIEW_PAGE_SIZE })
        skippedSeed = done.map((row) => text(row && row.id)).filter((id) => id !== '')
      }
    }
    if (targets.length === 0 && skippedSeed.length === 0) {
      return deny(REASONS.NOT_FOUND, `未找到匹配的印谱外部導入行（batch_id：${batchId || '（空）'} / import_id：${importId || '（空）'}）；本次零寫入。`)
    }
    const accepted = decision === ITEM_IMPORT_STATUS.ACCEPTED
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context && context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const at = new Date(seconds * 1000).toISOString()
    const writes = []
    const acceptedIds = []
    const rejectedIds = []
    const skipped = skippedSeed.slice()
    const failed = []
    let itemsCache = null
    const itemsOf = async () => {
      if (itemsCache === null) itemsCache = rowsOfReply(await resolveDb().collection(COLLECTIONS.items).get())
      return itemsCache
    }
    for (const row of targets) {
      const rid = text(row && row.id)
      const current = text(row && row.status) || ITEM_IMPORT_STATUS.PENDING
      const privatePatch = { status: decision, reviewed_at: at, reviewer_id: identity.uid }
      if (!accepted && noteText !== '') privatePatch.review_note = noteText
      /* 终态不回退：已审行**跳过**（幂等重放场景不改写既有终态）。 */
      if (current !== ITEM_IMPORT_STATUS.PENDING) {
        skipped.push(rid)
        continue
      }
      if (!accepted) {
        writes.push({ kind: 'update', collection: COLLECTIONS.itemImports, match: { id: rid }, doc: privatePatch, expectAtLeast: 1 })
        rejectedIds.push(rid)
        continue
      }
      const sourceId = text(row && row.source_item_id)
      if (!sourceId) {
        /* 幂等键缺失 ⇒ **该行失败、保持 PENDING 且零写入**（不动 items、不改本行）。 */
        failed.push(rid)
        continue
      }
      const items = await itemsOf()
      const existing = items.find((item) => text(item && item.source_item_id) === sourceId)
      if (!existing) {
        /* **採納落正式行：恰本體 22 字段**（**無 `raw_json`、無行級元數據**）。 */
        const itemDoc = itemBodyOf(row)
        items.push(itemDoc)
        writes.push({ kind: 'set', collection: COLLECTIONS.items, id: sourceId, doc: itemDoc })
      }
      writes.push({ kind: 'update', collection: COLLECTIONS.itemImports, match: { id: rid }, doc: privatePatch, expectAtLeast: 1 })
      acceptedIds.push(rid)
    }
    return {
      ok: true,
      op: 'reviewItemImport',
      accepted,
      accepted_ids: acceptedIds,
      rejected_ids: rejectedIds,
      skipped,
      failed,
      plan: { op: 'reviewItemImport', writes }
    }
  },

  /**
   * **半采纳修复（幂等管理员 op｜本单 I-2）**：扫描三个导入集合中 `status = ACCEPTED` 而
   * **其正式行不存在**的**孤儿行**（孤儿判据 ＝ 按各通道**幂等键**在正式集合里查不到行）
   * ⇒ **补齐正式行**。
   *
   * 契约记录（逐条）：
   *   · **孤儿判据（幂等键）**：person ⇒ `xiai_persons.source_person_id`；item ⇒
   *     `xiai_items.source_item_id`；seal ⇒ `xiai_seals.source_seal_id` **＋ `source`**
   *     （与采纳去重键逐字同口径）。**幂等键缺失**的导入行**不计为孤儿**（无键不可判定；
   *     采纳路径本就不会把它置为终态）。
   *   · **补齐口径 ＝ 沿用各通道现有构建函数的同一套字段面与编号规则**（不另立第二套）：
   *     person ⇒ `buildPersonDocFromImport` ＋ `nextPersonCodeOf`；item ⇒ `itemBodyOf`；
   *     seal ⇒ `buildSealAcceptanceFromImport`（**含影像引用逐条校验**：引用解析不到 ⇒
   *     该条**不补**、**如实留在 `orphan` 计数里**）。
   *   · **预演 `dry_run:true`（缺省）** ⇒ **零写入**，只吐权威清单：逐集合 `scanned`（读到的
   *     `ACCEPTED` 行数）/ `orphan`（孤儿数）/ `samples`（≤5，含导入行号 ＋ 幂等键）。
   *   · **执行 `dry_run:false`** ⇒ 逐孤儿产出正式行 `set`（**先正式行，与采纳路径同序**）。
   *   · **幂等**：重放（库内已无孤儿）⇒ `orphan` 全 `0`、**零写入**、`idempotent:true`。
   *   · **入参**：`{ dry_run?: boolean }`（缺省 `true`；键面封闭 ＝ `REPAIR_ALLOWED_KEYS`）。
   *   · **回包（固定键面）**：`{ ok, op, dry_run, scanned:{person,item,seal}, orphan:{…},
   *     changed:{…}, samples:[…], idempotent, plan? }`。
   *   · **权限**：走既有管理员白名单门（缺 env ⇒ 结构化拒 ＋ 零写入；非白名单 ⇒ `FORBIDDEN`
   *     ＋ 零写入）；**零新增 `reason` 字面值**；判定在写之前。
   * @param {object} [payload] `{ dry_run?: boolean }`（缺省 ⇒ `{dry_run:true}`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<{ok:true, op:string, dry_run:boolean, scanned:object, orphan:object,
   *          changed:object, samples:Array<object>, idempotent:boolean, plan?:object}
   *          |{ok:false, reason:string, message:string}>}
   */
  async repairImportAcceptance(payload, identity, context) {
    /* ① 管理员白名单门（**身份判据，写之前**；缺 env ⇒ 结构化拒绝 ＋ 零写入）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    const input = payload === undefined || payload === null ? {} : payload
    if (typeof input !== 'object' || Array.isArray(input)) {
      return deny(REASONS.INVALID_FIELD, '載荷形態不合法（應為物件）；本次零寫入。')
    }
    const unknown = Object.keys(input).filter((key) => REPAIR_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}；本次零寫入。`)
    }
    let dryRun = true
    if (Object.prototype.hasOwnProperty.call(input, 'dry_run')) {
      if (typeof input.dry_run !== 'boolean') {
        return deny(REASONS.INVALID_VALUE, '`dry_run` 必須是布林值（true / false）；本次零寫入。')
      }
      dryRun = input.dry_run
    }
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const at = new Date(seconds * 1000).toISOString()
    const scanned = { person: 0, item: 0, seal: 0 }
    const orphan = { person: 0, item: 0, seal: 0 }
    const changed = { person: 0, item: 0, seal: 0 }
    const samples = []
    const writes = []
    const MAX_SAMPLES = 5
    for (const target of IMPORT_REPAIR_TARGETS) {
      /* ② 只读扫描：本集合 `ACCEPTED` 行（限量护栏）＋ 正式集合现有行（幂等键查存）。 */
      const imports = await readRows(target.imports, { status: 'ACCEPTED' }, { limit: IMPORT_REPAIR_SCAN_LIMIT })
      const formal = await readRows(target.formal, {})
      scanned[target.key] = imports.length
      const hasFormal = (row) => {
        const key = text(row && row[target.idKey])
        if (!key) return true
        if (target.key === 'seal') {
          return formal.some((item) => text(item && item.source_seal_id) === key && text(item && item.source) === text(row && row.source))
        }
        return formal.some((item) => text(item && item[target.idKey]) === key)
      }
      for (const row of imports) {
        if (!text(row && row[target.idKey])) continue
        if (hasFormal(row)) continue
        orphan[target.key] += 1
        if (samples.length < MAX_SAMPLES) {
          samples.push({ collection: target.imports, import_id: text(row && row.id), key: text(row && row[target.idKey]), formal: target.formal })
        }
        if (dryRun) continue
        if (target.key === 'person') {
          const code = nextPersonCodeOf(formal)
          const doc = buildPersonDocFromImport(row, identity, at, code)
          formal.push(doc)
          writes.push({ kind: 'set', collection: target.formal, id: code, doc })
          changed[target.key] += 1
          continue
        }
        if (target.key === 'item') {
          const doc = itemBodyOf(row)
          formal.push(doc)
          writes.push({ kind: 'set', collection: target.formal, id: text(row && row.source_item_id), doc })
          changed[target.key] += 1
          continue
        }
        /* 印章通道：**同一套**构建函数（含影像引用校验）⇒ 解析不到引用的行**不补**。 */
        const faces = await readRows(COLLECTIONS.faces, {})
        const built = await buildSealAcceptanceFromImport(row, formal, faces, identity, at)
        if (!built.ok) continue
        formal.push(built.sealDoc)
        writes.push({ kind: 'set', collection: target.formal, id: built.stampId, doc: built.sealDoc })
        for (const faceDoc of built.faceDocs) {
          faces.push(faceDoc)
          writes.push({ kind: 'set', collection: COLLECTIONS.faces, id: faceDoc.id, doc: faceDoc })
        }
        changed[target.key] += 1
      }
    }
    const totalOrphan = orphan.person + orphan.item + orphan.seal
    const result = {
      ok: true,
      op: 'repairImportAcceptance',
      dry_run: dryRun,
      scanned,
      orphan,
      changed,
      samples,
      idempotent: totalOrphan === 0
    }
    /* 只有「执行态且有写入」才产出落盘计划 ⇒ `dry_run` / 无孤儿 ⇒ **零写入**。 */
    if (!dryRun && writes.length > 0) result.plan = { op: 'repairImportAcceptance', writes }
    return result
  },

  /**
   * **一次性朝代值迁移（幂等管理员 op｜§3.53.5 两值收窄）**：把**两张集合** `xiai_seals` 与
   * `xiai_faces` 里 `dynasty` 字段的两个**人类点名旧值**归一 —— `战国` → `戰國`；
   * `秦汉` → 清空（`''`）。
   *
   * 契约记录（逐条）：
   *   · **一次性**：仅针对上述两个**点名旧值**，**只改这两个字符串**；**其它任何 `dynasty`
   *     取值一律逐字不动**（含 `明` / `清` / `近現代` / 空值 等 —— R-21「旧值不改写」红线）。
   *   · **幂等**：重跑（无 `战国` / `秦汉` 残留）⇒ `changed` 计数全 0、**零写入**、`idempotent:true`。
   *   · **预演 `dry_run:true`（缺省）** ⇒ **零写入**，只返回命中计数与抽样（`changed` 为**将改**行数）。
   *   · **入参**：`{ dry_run?: boolean }`（缺省 `true`）。
   *   · **回包（固定键面）**：`{ ok, op, dry_run, scanned:{seals,faces}, changed:{seals,faces},
   *     samples:[{collection,id,from,to}], idempotent }`；**行数口径 ＝ 逐集合目标值命中数**
   *     （`changed` 为命中数，非 driver `updated` 猜测）。
   *   · **权限**：走既有管理员白名单（缺 env ⇒ 结构化拒 ＋ 零写入；非白名单 ⇒ `FORBIDDEN` ＋
   *     零写入）；**零新增 `reason` 字面值**；判定在写之前。
   * @param {object} [payload] `{ dry_run?: boolean }`（缺省 ⇒ `{dry_run:true}`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<{ok:true, op:string, dry_run:boolean, scanned:object, changed:object,
   *          samples:Array<object>, idempotent:boolean, plan?:object}
   *          |{ok:false, reason:string, message:string}>}
   */
  async migrateDynastyValues(payload, identity, context) {
    /* ① 管理员白名单门（**身份判据，写之前**；缺 env ⇒ 结构化拒绝 ＋ 零写入）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    const input = payload === undefined || payload === null ? {} : payload
    if (typeof input !== 'object' || Array.isArray(input)) {
      return deny(REASONS.INVALID_FIELD, '載荷形態不合法（應為物件）；本次零寫入。')
    }
    const unknown = Object.keys(input).filter((key) => MIGRATE_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}；本次零寫入。`)
    }
    /* `dry_run` 缺省 `true`（只讀預演）；给了就必须是布林。 */
    let dryRun = true
    if (Object.prototype.hasOwnProperty.call(input, 'dry_run')) {
      if (typeof input.dry_run !== 'boolean') {
        return deny(REASONS.INVALID_VALUE, '`dry_run` 必須是布林值（true / false）；本次零寫入。')
      }
      dryRun = input.dry_run
    }
    /* ② 只读扫描：逐集合读全部行，统计**目标值命中数**（口径 ＝ 命中数，非 affected 猜测）。 */
    const targets = [
      { collection: COLLECTIONS.seals, key: 'seals' },
      { collection: COLLECTIONS.faces, key: 'faces' }
    ]
    const scanned = { seals: 0, faces: 0 }
    const changed = { seals: 0, faces: 0 }
    const samples = []
    const writes = []
    const MAX_SAMPLES = 5
    for (const target of targets) {
      const rows = await readRows(target.collection, {})
      scanned[target.key] = rows.length
      for (const row of rows) {
        const from = text(row && row.dynasty)
        const to = DYNASTY_MIGRATION[from]
        if (to === undefined) continue
        changed[target.key] += 1
        const id = text(row && (row._id || row.id))
        if (samples.length < MAX_SAMPLES) {
          samples.push({ collection: target.collection, id, from, to })
        }
        if (!dryRun && id) {
          writes.push({
            kind: 'update',
            collection: target.collection,
            match: { _id: id },
            doc: { dynasty: to },
            expectAtLeast: 1
          })
        }
      }
    }
    const idempotent = changed.seals + changed.faces === 0
    const result = {
      ok: true,
      op: 'migrateDynastyValues',
      dry_run: dryRun,
      scanned,
      changed,
      samples,
      idempotent
    }
    /* 只有「执行态且有写入」才产出落盘计划 ⇒ `dry_run` / 无残留 ⇒ **零写入**。 */
    if (!dryRun && writes.length > 0) result.plan = { op: 'migrateDynastyValues', writes }
    return result
  },

  /**
   * **一次性值域收敛（幂等管理员 op｜本单）**：把**真源外**的旧值收敛 —— `xiai_seals` 的
   * `dynasty`（真源 ＝ `DYNASTY_OPTIONS` 15 类）与 `seal_type`（真源 ＝ `FACE_CONTENT_OPTIONS`
   * 9 类）；`xiai_faces` 的 `seal_type`（9）／`face_style`（`FACE_STYLE_OPTIONS` 23 类）／
   * `seal_class`（`SEAL_CLASS_OPTIONS` 3 类）。**只把真源外值清空为 `''`**（与 `migrateDynastyValues`
   * 的 `秦汉 → ''` **同口径**）；**真源内值一字不动**；**不得臆测映射**（`清` 不得 → `清中期`）。
   *
   * 契约记录（逐条；沿 `migrateDynastyValues` 先例同型）：
   *   · **预演 `dry_run:true`（缺省）** ⇒ **零写入**，只返回逐集合行数、**逐字段权威分布
   *     `distinct`**（真源外旧值清单的唯一权威来源 —— **页面读数不作数**）与真源外命中数。
   *   · **执行 `dry_run:false`** ⇒ 只把**真源外**值清空为 `''`（逐处一处 `update`）；真源内值零改动。
   *   · **幂等**：重放（库内已无真源外值）⇒ `changed` 全 `0`、**零写入**、`idempotent:true`。
   *   · **入参**：`{ dry_run?: boolean }`（缺省 `true`；键面封闭 ＝ `MIGRATE_ALLOWED_KEYS`）。
   *   · **回包（固定键面）**：`{ ok, op, dry_run, scanned:{seals,faces,distinct:{[`<key>.<field>`]:
   *     {total, empty, distinct, cleared}}}, changed:{[`<key>.<field>`]:number}, samples:[
   *     {collection,field,id,from,to}], idempotent }`；**行数口径 ＝ 逐集合读取行数，命中口径 ＝
   *     真源外值计数**（非 driver `updated` 猜测）。
   *   · **权限**：走既有管理员白名单门（缺 env ⇒ 结构化拒 ＋ 零写入；非白名单 / 会话角色不足 ⇒
   *     `FORBIDDEN` ＋ 零写入）；**零新增 `reason` 字面值**；判定在写之前。
   * @param {object} [payload] `{ dry_run?: boolean }`（缺省 ⇒ `{dry_run:true}`）
   * @param {{uid:string, phone:string}} identity **服务端派生**的身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<{ok:true, op:string, dry_run:boolean, scanned:object, changed:object,
   *          samples:Array<object>, idempotent:boolean, plan?:object}
   *          |{ok:false, reason:string, message:string}>}
   */
  async migrateSealValueDomains(payload, identity, context) {
    /* ① 管理员白名单门（**身份判据，写之前**；缺 env ⇒ 结构化拒绝 ＋ 零写入）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    const input = payload === undefined || payload === null ? {} : payload
    if (typeof input !== 'object' || Array.isArray(input)) {
      return deny(REASONS.INVALID_FIELD, '載荷形態不合法（應為物件）；本次零寫入。')
    }
    const unknown = Object.keys(input).filter((key) => MIGRATE_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}；本次零寫入。`)
    }
    /* `dry_run` 缺省 `true`（只讀預演）；给了就必须是布林。 */
    let dryRun = true
    if (Object.prototype.hasOwnProperty.call(input, 'dry_run')) {
      if (typeof input.dry_run !== 'boolean') {
        return deny(REASONS.INVALID_VALUE, '`dry_run` 必須是布林值（true / false）；本次零寫入。')
      }
      dryRun = input.dry_run
    }
    /* ② 只读扫描：逐集合**只读一次**（行数计入 `scanned`）；逐字段统计**权威分布**与真源外命中数。 */
    const rowsByKey = {}
    const scanned = { seals: 0, faces: 0, distinct: {} }
    for (const target of SEAL_VALUE_DOMAIN_TARGETS) {
      if (Object.prototype.hasOwnProperty.call(rowsByKey, target.key)) continue
      const rows = await readRows(target.collection, {})
      rowsByKey[target.key] = rows
      scanned[target.key] = rows.length
    }
    const changed = {}
    const samples = []
    const writes = []
    const MAX_SAMPLES = 5
    for (const target of SEAL_VALUE_DOMAIN_TARGETS) {
      const rows = rowsByKey[target.key]
      const targetId = `${target.key}.${target.field}`
      const distinct = {}
      let empty = 0
      let hits = 0
      for (const row of rows) {
        const from = text(row && row[target.field])
        /* 空值不算「真源外旧值」，也不改（清空是**终态** ⇒ 重放必零改动）。 */
        if (from === '') {
          empty += 1
          continue
        }
        distinct[from] = (distinct[from] || 0) + 1
        /* **真源内值一字不动**（R-21「旧值不改写」在真源内的部分）。 */
        if (target.domain.indexOf(from) !== -1) continue
        hits += 1
        const id = text(row && (row._id || row.id))
        if (samples.length < MAX_SAMPLES) {
          samples.push({ collection: target.collection, field: target.field, id, from, to: '' })
        }
        if (!dryRun && id) {
          const patch = {}
          patch[target.field] = ''
          writes.push({
            kind: 'update',
            collection: target.collection,
            match: { _id: id },
            doc: patch,
            expectAtLeast: 1
          })
        }
      }
      scanned.distinct[targetId] = { total: rows.length, empty, distinct, cleared: hits }
      changed[targetId] = hits
    }
    const idempotent = Object.values(changed).every((value) => value === 0)
    const result = {
      ok: true,
      op: 'migrateSealValueDomains',
      dry_run: dryRun,
      scanned,
      changed,
      samples,
      idempotent
    }
    /* 只有「执行态且有写入」才产出落盘计划 ⇒ `dry_run` / 无残留 ⇒ **零写入**。 */
    if (!dryRun && writes.length > 0) result.plan = { op: 'migrateSealValueDomains', writes }
    return result
  },

  /**
   * **E-3 只讀取行（本單新增 op｜`pullImportRows`）**：把**雲端**三族導入行（待審 / 終態）
   * **單向取回本機** —— 階段甲復用於存量搬遷，階段乙用於「雲端包 → 本機審」。
   *
   * 順序（**全部判定在任何讀之前；本 op 零寫入** —— 不產出 `plan` ⇒ `index.js` 的落盤分支
   * 不觸發、`docId` 恒空）：
   *   ① 管理員白名單門（缺 `XIAI_ADMIN_PHONE` ⇒ `STORAGE_UNAVAILABLE`；非白名單 / 會話角色不足
   *      ⇒ `FORBIDDEN`；**恆零寫入**）；
   *   ② 載荷形態 / 鍵面（封閉 `PULL_IMPORT_ROWS_ALLOWED_KEYS`；未登記鍵 ⇒ `INVALID_FIELD`）；
   *   ③ 集合判定：`collection` 值域封閉三選一；未給 ⇒ 由 `batch_id` 前綴推斷；兩者皆不成
   *      ⇒ `INVALID_VALUE`（**不猜集合**）；
   *   ④ 狀態值域（可選）與 `limit` 形態 / 範圍（**值域外 ⇒ `INVALID_VALUE` ＋ 零寫入**）；
   *   ⑤ **只讀**讀行（顯式 `.limit()`；失敗 ⇒ 拋錯 ⇒ `index.js` 轉 `STORAGE_UNAVAILABLE`，
   *      **絕不偽裝 `FORBIDDEN`**）；
   *   ⑥ 逐行**剝除身份 / 手機號類鍵**（`…phone…` 零出現；不透明 uid 原樣）⇒ 回
   *      `{ok:true, op:'pullImportRows', rows:[…], count:N}`（**恰四鍵**、**無 `plan`**）。
   * @param {object} payload 載荷（允許鍵見 `PULL_IMPORT_ROWS_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity **服務端派生**的身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<{ok:true, op:string, rows:Array<object>, count:number}
   *          |{ok:false, reason:string, message:string}>}
   */
  async pullImportRows(payload, identity, context) {
    /* ① 管理员白名单门（**身份判据，任何读之前**；缺 env ⇒ 结构化拒绝 ＋ 零写入）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    /* ② 載荷鍵面（封閉；未登記鍵 ⇒ `INVALID_FIELD` ＋ 零寫入）。 */
    const unknown = Object.keys(payload).filter((key) => PULL_IMPORT_ROWS_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const batchId = text(payload.batch_id)
    const collectionKey = text(payload.collection)
    /* ③ 集合判定（三選一；未給 ⇒ 由 `batch_id` 前綴推斷；**推不出不猜**）。 */
    let collection = ''
    if (collectionKey) {
      if (!Object.prototype.hasOwnProperty.call(PULL_IMPORT_COLLECTION_KEYS, collectionKey)) {
        return deny(
          REASONS.INVALID_VALUE,
          `導入集合（collection）值域外：${collectionKey}（僅允許 personImports / sealImports / itemImports）；本次零寫入。`
        )
      }
      collection = PULL_IMPORT_COLLECTION_KEYS[collectionKey]
    } else {
      collection = importCollectionOfBatchPrefix(batchId)
      if (!collection) {
        return deny(
          REASONS.INVALID_VALUE,
          '無法判定導入集合：請提供 collection（personImports / sealImports / itemImports）或可識別前綴的 batch_id；本次零寫入。'
        )
      }
    }
    /* ④a 狀態值域（可選；值域外 ⇒ `INVALID_VALUE` ＋ 零寫入）。 */
    let status = ''
    if (payload.status !== undefined && payload.status !== null) {
      status = text(payload.status)
      if (PULL_IMPORT_STATUS_VALUES.indexOf(status) === -1) {
        return deny(
          REASONS.INVALID_VALUE,
          `導入行狀態（status）值域外：${status || '（空）'}（僅允許 PENDING / ACCEPTED / REJECTED）；本次零寫入。`
        )
      }
    }
    /* ④b 單次上限（可選；**整數 1 〜 硬上限**；缺省 ⇒ 待審取行護欄值）。 */
    let limit = PULL_IMPORT_DEFAULT_LIMIT
    if (payload.limit !== undefined && payload.limit !== null) {
      const requested = payload.limit
      if (typeof requested !== 'number' || !Number.isInteger(requested) || requested <= 0 || requested > PULL_IMPORT_MAX_LIMIT) {
        return deny(
          REASONS.INVALID_VALUE,
          `單次取行上限（limit）必須是 1 〜 ${PULL_IMPORT_MAX_LIMIT} 之間的整數；本次零寫入。`
        )
      }
      limit = requested
    }
    /* ⑤ 只讀讀行（顯式 `.limit()`；空 `match` ⇒ 整集合，沿 `migrateSealValueDomains` 同型讀法）。 */
    const match = {}
    if (batchId) match.batch_id = batchId
    if (status) match.status = status
    const rows = await readRows(collection, match, { limit })
    /* ⑥ 逐行剝除身份 / 手機號類鍵（`user_phone` 一類零出現；不透明 uid 原樣）。 */
    const safeRows = rows.map((row) => stripImportIdentityFields(row))
    return { ok: true, op: 'pullImportRows', rows: safeRows, count: safeRows.length }
  },

  /**
   * **无审核直写（本单新增｜管理员面｜`createSealWithFaceDirect`）**：
   * ① S1 身份门（`XIAI_DIRECT_WRITE_PHONE`；fail-closed）→ ② 封闭键面（＝ 导入键面）→
   * ③ S2 来源白名单（`XIAI_DIRECT_WRITE_SOURCES`；fail-closed）→ ④ `source` ＋ `source_seal_id`
   * 幂等键必有 → ⑤ 印面 1..N ＋ `kind=FACE` 必有影像引用 ＋ 摘要 / 对象键 / 体量形态门 →
   * ⑥ 源侧扩面形态门 ＋ 自由文本长度门 ＋ 值域门 → ⑦ **幂等读**（同 `source` ＋ `source_seal_id`
   * 已有正式行 ⇒ `idempotent:true`、返回既有 `sid`/`fid`、**零新增行、不改写既有行**）→
   * ⑧ 自写 `xiai_images` 登记行（内容寻址 `_id`）＋ **复用 `buildSealAcceptanceFromImport`**
   * （行构造 ＋ 原子发号）→ ⑨ **面行追加 `image_sha256`**（口径：面行必落；印章行不必）→
   * ⑩ 回包业务键**全塞 `row`**（`index.js` 对 `row` 零过滤 ⇒ **不改全局回包白名单**）。
   *
   * 影像通道（设计件 §3.2）：客户端**先直传对象**（内容寻址键 `xiai/images/<hh>/<sha>.tiff`）→
   * 调 `OPS.registerArtifact`（服务端回读字节 / 摘要校验，**零落盘**）→ 可选
   * `OPS.ensureDisplayArtifact`（展示件，best-effort）→ 本 op 校验**引用形态**并**自写登记行**。
   * 本 op **不读对象字节**（载荷只带引用）；引用解析不到 ⇒ 拒（零写入）。
   *
   * `source='feicui-local-dist'` **不靠占位图**（真实影像）；占位图门一字未改（仍只认 sealbank 家族）。
   * @param {object} payload 载荷（允许键见 `DIRECT_WRITE_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<object>} 成功 ⇒ `{ok, op, row, plan}`；幂等命中 ⇒ 无 `plan`；失败 ⇒ 恰 3 键
   */
  async createSealWithFaceDirect(payload, identity, context) {
    /* ① S1 身份门（**写之前**；fail-closed）。 */
    const identityDenial = directWriteIdentityDenial(identity)
    if (identityDenial) return identityDenial
    /* ② 载荷形态 ＋ 封闭键面（与 `submitSealImport` 逐字同门）。 */
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => DIRECT_WRITE_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    const source = text(payload.source)
    /* ③ S2 来源白名单（fail-closed：缺 env ⇒ 拒所有来源）。 */
    const sourceDenial = directWriteSourceDenial(source)
    if (sourceDenial) return sourceDenial
    const sourceId = text(payload.source_seal_id)
    if (!sourceId) {
      return deny(REASONS.MISSING_REQUIRED, '缺少外部冪等鍵（source_seal_id）⇒ 拒絕直寫；本次零寫入。')
    }
    if (sourceId.length > MAX_ID_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `外部冪等鍵超出上限（${MAX_ID_LENGTH} 字）⇒ 拒絕直寫；本次零寫入。`)
    }
    /* ④ 印面 1..N ＋ 引用形态门（`kind=FACE` 必有引用；`EDGE` 可空）。 */
    const faces = Array.isArray(payload.faces) ? payload.faces.map(normalizeSealImportFace) : []
    if (faces.length === 0) {
      return deny(REASONS.MISSING_REQUIRED, '直寫行請至少帶一個印面（faces[] 1..N，含邊款 kind=EDGE）⇒ 拒絕直寫；本次零寫入。')
    }
    /* 佔位圖來源門**一字未改**（只认 sealbank 家族）；`feicui-local-dist` 走真实影像。 */
    const placeholderDenial = sealPlaceholderRefDenial(source, faces)
    if (placeholderDenial) return deny(REASONS.INVALID_VALUE, placeholderDenial)
    for (const face of faces) {
      face.image_sha256 = text(face.image_sha256).toLowerCase()
      const sha = text(face.image_sha256)
      const key = text(face.image_storage_key)
      const hasRef = sha !== '' || key !== ''
      if (!hasRef) {
        if (face.kind === 'FACE') {
          return deny(REASONS.MISSING_REQUIRED, '印面（kind=FACE）必須帶影像引用（image_storage_key ＋ image_sha256）⇒ 拒絕直寫；本次零寫入。')
        }
        continue
      }
      /* 佔位鍵另由來源門 ＋ 摘要門判（`sealPlaceholderRefDenial` / `sealPlaceholderDigestDenial`）；
         **内容寻址键**走通用形态门（与 `registerArtifact` 同一张表）。 */
      if (key === SEAL_PLACEHOLDER_IMAGE_KEY) continue
      if (!ARTIFACT_DIGEST_PATTERN.test(sha)) {
        return deny(REASONS.INVALID_VALUE, '影像摘要（image_sha256）必須是 64 位小寫十六進制；本次零寫入。')
      }
      const matched = ARTIFACT_OBJECT_KEY_PATTERN.exec(key)
      if (!matched || matched[2] !== sha || matched[1] !== sha.slice(0, 2)) {
        return deny(
          REASONS.INVALID_VALUE,
          '影像對象鍵形態不符（期望 xiai/images/<摘要前兩位>/<摘要>.tiff，且鍵內摘要 ≡ image_sha256）；本次零寫入。'
        )
      }
      const bytes = Number(face.image_bytes)
      if (!Number.isInteger(bytes) || bytes <= 0 || bytes > ARTIFACT_MAX_BYTES) {
        return deny(
          REASONS.INVALID_VALUE,
          `影像字節數（image_bytes）必須是 1 〜 ${ARTIFACT_MAX_BYTES} 之間的整數；本次零寫入。`
        )
      }
    }
    /* ⑤ 源侧扩面形态门 ＋ 自由文本长度门 ＋ 值域门（全部写之前）。 */
    const sourceValueDenial = sealSourceValueDenial(payload)
    if (sourceValueDenial) return sourceValueDenial
    const lengthDenial = sealTextLengthDenial(payload, faces)
    if (lengthDenial) return lengthDenial
    const domainDenial = sealValueDomainDenial(payload, faces)
    if (domainDenial) return domainDenial
    if (!identityUsable(identity)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的直寫身份；本次零寫入。')
    }
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const at = new Date(seconds * 1000).toISOString()
    /* ⑦ 影像登记行（**先传对象 → 本 op 只校验引用**）：集合里已有行 ⇒ **不改写既有行**；
       内容寻址键无行 ⇒ 自建登记行（同 sha 恒同 `_id` ⇒ 幂等覆写、不增行）。 */
    const imageRows = []
    for (const face of faces) {
      if (text(face.image_sha256) === '' && text(face.image_storage_key) === '') continue
      const resolved = await findSealImportImageRow(face)
      if (resolved) continue
      if (text(face.image_storage_key) === SEAL_PLACEHOLDER_IMAGE_KEY) {
        return deny(REASONS.INVALID_VALUE, '佔位圖登記行不存在 ⇒ 拒絕直寫；本次零寫入。')
      }
      imageRows.push(buildDirectImageRow(face, at))
    }
    /* ⑥ **幂等读**（`source` ＋ `source_seal_id`；命中 ⇒ 零新增行、**不改写既有行**、**无 `plan`**）。 */
    const seals = await readRows(COLLECTIONS.seals, {}, { limit: DIRECT_WRITE_READ_LIMIT })
    const existing = seals.find(
      (item) => text(item && item.source_seal_id) === sourceId && text(item && item.source) === source
    )
    if (existing) {
      return {
        ok: true,
        op: 'createSealWithFaceDirect',
        row: await directWriteRowOfExistingSeal(existing, true),
        message: '該外部冪等鍵（source ＋ source_seal_id）已有正式行 ⇒ 未新增任何行、未改寫既有行（冪等）。'
      }
    }
    /* ⑧ 复用构造器（**行构造 ＋ 原子发号**一次搞定）；影像引用经登记行覆蓋層解析（尚未落库）。 */
    const importRow = { ...pickSealImportSealFields(payload), source, source_seal_id: sourceId, faces }
    const faceRows = await readRows(COLLECTIONS.faces, {}, { limit: DIRECT_WRITE_READ_LIMIT })
    const built = await buildSealAcceptanceFromImport(importRow, seals, faceRows, identity, at, imageRows)
    if (!built.ok) {
      return built.reason
        ? deny(built.reason, '直寫落點構造失敗（影像引用 / 佔位圖 / 號域判定未過）⇒ 拒絕直寫；本次零寫入。')
        : deny(REASONS.INVALID_VALUE, '直寫落點構造失敗（印面必須帶可解析的影像引用）⇒ 拒絕直寫；本次零寫入。')
    }
    /* ⑨ **面行追加 `image_sha256`**（口径：面行必落；印章行不必）。 */
    const replies = []
    built.faceDocs.forEach((doc, index) => {
      doc.image_sha256 = text(faces[index] && faces[index].image_sha256) || null
      replies.push({
        fid: text(doc.fid),
        face_no: Number(doc.face_no),
        face_id: text(doc.id),
        image_id: faceImageIdOf(doc),
        kind: text(doc.kind) === 'EDGE' ? 'EDGE' : 'FACE'
      })
    })
    /* ⑩ plan：**影像登记行 → 印章正式行 → 逐印面行**（先落被引用的登记行；`stamp_id` 此刻才有值）。 */
    imageRows.forEach((row) => {
      row.stamp_id = built.stampId
    })
    const primaryIndex = built.faceDocs.findIndex((doc) => text(doc.kind) !== 'EDGE')
    const primaryAt = primaryIndex === -1 ? 0 : primaryIndex
    return {
      ok: true,
      op: 'createSealWithFaceDirect',
      row: {
        ok: true,
        sid: built.stampId,
        fid: replies[primaryAt].fid,
        seal_no: Number(built.sealDoc.seal_no),
        face_no: replies[primaryAt].face_no,
        face_id: replies[primaryAt].face_id,
        image_id: replies[primaryAt].image_id,
        faces: replies,
        idempotent: false
      },
      plan: {
        op: 'createSealWithFaceDirect',
        writes: [
          ...imageRows.map((row) => ({ kind: 'set', collection: COLLECTIONS.images, id: row.id, doc: row })),
          { kind: 'set', collection: COLLECTIONS.seals, id: built.stampId, doc: built.sealDoc },
          ...built.faceDocs.map((doc) => ({ kind: 'set', collection: COLLECTIONS.faces, id: doc.id, doc }))
        ]
      }
    }
  },

  /**
   * **指纹对照（本单新增｜只读三态｜`querySealByFingerprint`）**：
   * 入参四元组 `transcription` / `dynasty` / `author` / `image_sha256`（封闭键面）；文本侧**至少给 1 个**；
   * `image_sha256` 未给 ⇒ **不可能判 `FULL`**（三态里「同图」无判据）⇒ 命中即 `IMAGE_DIFF`（如实）。
   *
   * 三态**服务端一次回齐**（`match` 是唯一判据键；**不许前端自行拼判断** —— 沿 `index.js`
   * 「服务端权威行、前端只做镜像」的既有纪律）：
   *   · `FULL`      ＝ 文本条件命中 **且** 至少一面 `image_sha256` 相同（【上传】禁用：同图同文 ⇒ 本地改名即可）；
   *   · `IMAGE_DIFF` ＝ 文本条件命中、无任何面 sha 相同（【上传】启用：同文不同图）；
   *   · `NONE`      ＝ 文本条件 0 行（【上传】启用：正常新传）。
   *
   * **只读、零写**（不产出 `plan` ⇒ `index.js` 恒 `shouldPersist=false`）。
   * 身份门：op 落 `ADMIN_OPS` 面（不开用户级读面），门 ＝ **管理员 或 直写专身份**（二选一放行；
   * 两者各自 fail-closed）—— local-dist 的【对照】页由直写专身份调用。
   * @param {object} payload 载荷（允许键见 `SEAL_FINGERPRINT_QUERY_KEYS`）
   * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<object>} 成功 ⇒ `{ok, op, row}`；失败 ⇒ 恰 3 键
   */
  async querySealByFingerprint(payload, identity, context) {
    /* ① 身份门（只读面；管理员 或 直写专身份；各自 fail-closed）。 */
    const adminDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    const directDenial = adminDenial ? directWriteIdentityDenial(identity) : null
    if (directDenial) return directDenial
    /* ② 载荷形态 ＋ 封闭四元组键面（零读面副作用）。 */
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零讀取。')
    }
    const unknown = Object.keys(payload).filter((key) => SEAL_FINGERPRINT_QUERY_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零讀取。`)
    }
    const transcription = text(payload.transcription)
    const dynasty = text(payload.dynasty)
    const author = text(payload.author)
    const digest = text(payload.image_sha256).toLowerCase()
    if (!transcription && !dynasty && !author) {
      return deny(REASONS.MISSING_REQUIRED, '指紋對照至少要給一個文本側鍵（transcription / dynasty / author）；本次零讀取。')
    }
    if (digest !== '' && !ARTIFACT_DIGEST_PATTERN.test(digest)) {
      return deny(REASONS.INVALID_VALUE, '影像摘要（image_sha256）必須是 64 位小寫十六進制；本次零讀取。')
    }
    /* ③ 只读取行（文本侧非空条件；`image_sha256` 只作三态判据、不作集合条件 —— 摘要活在面行上）。 */
    const match = {}
    if (transcription) match.transcription = transcription
    if (dynasty) match.dynasty = dynasty
    if (author) match.author = author
    const seals = await readRows(COLLECTIONS.seals, match, { limit: DIRECT_WRITE_READ_LIMIT })
    if (seals.length === 0) {
      return {
        ok: true,
        op: 'querySealByFingerprint',
        row: {
          match: SEAL_FINGERPRINT_MATCH.NONE,
          sid: '',
          fid: '',
          face_id: '',
          seal_name: '',
          image_id: null,
          image_sha256: digest,
          faces: []
        }
      }
    }
    const reports = []
    for (const seal of seals) {
      const sid = text(seal && (seal.sid || seal.stamp_id))
      const faceRows = sid === '' ? [] : await readRows(COLLECTIONS.faces, { sealId: sid }, { limit: 64 })
      const faces = faceRows.map((doc) => ({
        fid: text(doc && doc.fid),
        face_id: text(doc && doc.id),
        image_id: faceImageIdOf(doc),
        image_sha256: text(doc && doc.image_sha256),
        /* 仅供内部挑选主面（不进回包 `faces[]` 单条键面）。 */
        __kind: text(doc && doc.kind) === 'EDGE' ? 'EDGE' : 'FACE',
        __seal_name: text(doc && doc.seal_name)
      }))
      reports.push({
        seal,
        sid,
        faces,
        hit: digest === '' ? null : faces.find((face) => face.image_sha256 === digest) || null
      })
    }
    const full = reports.find((report) => report.hit) || null
    const target = full || reports[0]
    const primary =
      (target.hit ? target.hit : target.faces.find((face) => face.__kind !== 'EDGE') || target.faces[0]) || {}
    return {
      ok: true,
      op: 'querySealByFingerprint',
      row: {
        match: full ? SEAL_FINGERPRINT_MATCH.FULL : SEAL_FINGERPRINT_MATCH.IMAGE_DIFF,
        sid: target.sid,
        fid: text(primary.fid),
        face_id: text(primary.face_id),
        seal_name: text(primary.__seal_name) || text(target.seal && (target.seal.seal_name || target.seal.name)),
        image_id: primary.image_id === undefined ? null : primary.image_id,
        image_sha256: digest,
        faces: target.faces.map((face) => ({
          fid: face.fid,
          face_id: face.face_id,
          image_id: face.image_id,
          image_sha256: face.image_sha256
        }))
      }
    }
  },

  /**
   * **读 AI 上游配置（本單新增 op｜`getAiUpstream`｜管理员面）**：回**恰 6 键**
   * `{ok, base_url, model, key_mask, timeout_ms, updated_at}` —— **零 `key_cipher` /
   * `key_iv` / `key_tag`、零上游明文**（投影单点在 `lib/aiUpstream.getUpstreamPublic`）。
   * 顺序：① **管理員門**（`adminWhitelistDenial`：非管理员 ⇒ `FORBIDDEN` ＋ 零写入）
   * → ② 载荷封闭键面（**零允许键** ⇒ 任何键 `INVALID_FIELD` ＋ 零写入）→ ③ 只读取行。
   * @param {object} payload 载荷（**零允许键**）
   * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  async getAiUpstream(payload, identity, context) {
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    const payloadDenial = pointsPayloadDenial(payload, AI_UPSTREAM_ALLOWED_KEYS_VIEW)
    if (payloadDenial) return payloadDenial
    const view = await aiUpstream.getUpstreamPublic()
    if (view && view.ok === false) return view
    return {
      ok: true,
      base_url: view.base_url,
      model: view.model,
      key_mask: view.key_mask,
      timeout_ms: view.timeout_ms,
      updated_at: view.updated_at
    }
  },

  /**
   * **写 AI 上游配置（本單新增 op｜`setAiUpstream`｜管理员面）**：回**恰 6 键**
   * `{ok, base_url, model, key_mask, timeout_ms, updated_at}`（＝写后公共面；**零密文、零明文**）。
   * 顺序：① **管理員門**（`adminWhitelistDenial`：非管理员 ⇒ `FORBIDDEN` ＋ 零写入）
   * → ② 载荷封闭键面（`base_url` / `model` / `key` / `timeout_ms`；`actor_uid` **不由载荷自称**
   * —— 服务端取 `identity.uid`）→ ③ 模块侧：**先判主密钥 env**（缺 ⇒ `CONFIG_MISSING` ＋ 零写入，
   * 不得静默用空密钥、不得明文落库）→ base_url 协议值域（https 协议、host 非空）→ `timeout_ms` ∈ [1000,120000] 缺省 60000
   * → `key` 省略则沿用旧密文 → 整行 set。
   * @param {object} payload 载荷（允许键 `base_url` / `model` / `key` / `timeout_ms`）
   * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  async setAiUpstream(payload, identity, context) {
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    const payloadDenial = pointsPayloadDenial(payload, AI_UPSTREAM_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    return aiUpstream.setUpstream({
      actor_uid: identity.uid,
      base_url: payload.base_url,
      model: payload.model,
      key: payload.key,
      timeout_ms: payload.timeout_ms
    })
  }
})

/**
 * 落盘（**唯一写点**）。
 *
 * 两种计划形态（互斥）：
 *   · `{collection, doc}`        ⇒ 单文档 `add()`（既有 `submitCorrection` 逐字沿用）；
 *   · `{writes:[{kind:'set', collection, id, doc} | {kind:'add', collection, doc}]}`
 *     ⇒ 按序执行（本单 `endorseCorrection` 的两处落盘；`set` ＝ 确定性文档键 upsert ⇒ 幂等）。
 *
 * **原子性说明（如实登记）**：CloudBase 无跨文档事务面（本工程既有 op 亦为单写）。
 * 本单把「采信行 → 公开计数行」排成**确定序**，且两键皆**确定性 `_id` ＋ 幂等 upsert**
 * ⇒ 任一步在重试后可自愈（不会重复计数、不会产生第二行）；中途失败 ⇒ 抛错，由 `index.js`
 * 转 `STORAGE_UNAVAILABLE`（**不伪装成功、不伪装 `FORBIDDEN`**）。
 *
 * **本单 I-1（半采纳如实登记）**：任一步失败 ⇒ **立即中断、不再执行后续步骤**，并把
 * **已成功步数 / 总步数 / 失败步序号**挂在抛出的错误上（`completedSteps` / `totalSteps` /
 * `failedStep`）⇒ `index.js` 据此**如实报告**（**不得再声称「本次零寫入」**，除非确实零写入）。
 * @param {{collection?:string, doc?:object, writes?:Array<object>}} plan
 * @returns {Promise<string>} 首要文档标识；失败 ⇒ 抛错（带进度信息）
 */
async function persist(plan) {
  const db = resolveDb()
  if (plan && Array.isArray(plan.writes)) {
    let primary = ''
    const totalSteps = plan.writes.length
    let completedSteps = 0
    for (let index = 0; index < plan.writes.length; index += 1) {
      const step = plan.writes[index]
      try {
        if (step && step.kind === 'set') {
          await db.collection(step.collection).doc(step.id).set(step.doc)
          if (!primary) primary = String(step.id)
          completedSteps += 1
          continue
        }
        if (step && step.kind === 'update') {
          /* 按检索式 `update`（V3 管理员写面：私有行状态）；命中 0 行（并发改动 / 单号不存在）
             ⇒ 抛错 ⇒ 由 `index.js` 转 `STORAGE_UNAVAILABLE`（**不伪装成功 / 不伪装 FORBIDDEN**）。 */
          const result = await db.collection(step.collection).where(step.match).update(step.doc)
          const updated = updatedCountOf(result)
          if (typeof step.expectAtLeast === 'number' && updated !== null && updated < step.expectAtLeast) {
            throw new Error(`update-matched-too-few:${updated}`)
          }
          if (!primary) {
            const hit = await db.collection(step.collection).where(step.match).get()
            const rows = rowsOf(hit)
            if (rows.length > 0) primary = text(rows[0]._id) || text(rows[0].id)
          }
          completedSteps += 1
          continue
        }
        const result = await db.collection(step.collection).add(step.doc)
        const id = result && (result.id || result._id || (result.data && result.data.id))
        if (!primary) primary = id ? String(id) : ''
        completedSteps += 1
      } catch (error) {
        const wrapped = new Error(`WRITE_STEP_FAILED:${index + 1}/${totalSteps}`)
        wrapped.failedStep = index + 1
        wrapped.totalSteps = totalSteps
        wrapped.completedSteps = completedSteps
        wrapped.cause = error
        throw wrapped
      }
    }
    return primary
  }
  const result = await db.collection(plan.collection).add(plan.doc)
  const id = result && (result.id || result._id || (result.data && result.data.id))
  return id ? String(id) : ''
}

module.exports = {
  COLLECTIONS,
  MARKABLE_FIELDS,
  ALLOWED_KEYS,
  /* **本单改造**：斐萃令牌载荷封闭键面 ＋ 签/验纯函数（离线自检按同一真源断言）。 */
  FEICUI_TOKEN_ALLOWED_KEYS,
  feicuiToken,
  ENDORSE_ALLOWED_KEYS,
  IDENTITY_KEYS,
  MAX_TEXT_LENGTH,
  CORRECTION_PENDING,
  CORRECTION_SUMMARY_SCHEMA,
  ENDORSEMENT_IDENTITY_SOURCE,
  ENDORSEMENT_ID_PREFIX,
  CORRECTION_SUMMARY_ID_PREFIX,
  /* 纯函数：值级公开摘要行的构造 / 文档键（供离线自检与报告直接执行）。 */
  buildCorrectionSummary,
  correctionSummaryDocId,
  /* V3 管理员写面（登录令牌 ＋ 手机号白名单）。 */
  CORRECTION_STATUS,
  LEGACY_DECISION,
  DECISIONS,
  DYNASTY_OPTIONS,
  FACE_CONTENT_OPTIONS,
  FACE_STYLE_OPTIONS,
  SEAL_CLASS_OPTIONS,
  VALUE_DOMAINS,
  REVIEW_ALLOWED_KEYS,
  REWARD_ALLOWED_KEYS,
  REVIEW_IDENTITY_KEYS,
  MAX_NOTE_LENGTH,
  MAX_ID_LENGTH,
  PUBLIC_PROJECTION_KEYS,
  IDENTITY_PROJECTION_KEYS,
  PUBLIC_SCHEMA,
  PUBLIC_ID_PREFIX,
  /* 影像產物登記面（本單新增；供離線自檢直接斷言）。 */
  ARTIFACT_ALLOWED_KEYS,
  ARTIFACT_OBJECT_KEY_PATTERN,
  ARTIFACT_MIME,
  ARTIFACT_MAX_BYTES,
  /* 展示件轉碼面（本單新增 `ensureDisplayArtifact`；供離線自檢直接斷言）。 */
  DISPLAY_ALLOWED_KEYS,
  /* 印人提案面（person-model §2 / §3；供离线自检直接断言）。 */
  PERSON_PROPOSAL_ALLOWED_KEYS,
  PERSON_REVIEW_ALLOWED_KEYS,
  PERSON_PROPOSAL_STATUS,
  PERSON_PROPOSAL_ID_PREFIX,
  PERSON_CODE_PREFIX,
  /* 外部批量導入面（批 2 前置 §3.54.14 / §3.54.15；供离线自检直接断言）。 */
  PERSON_IMPORT_ALLOWED_KEYS,
  PERSON_IMPORT_REVIEW_ALLOWED_KEYS,
  PERSON_IMPORT_STATUS,
  PERSON_IMPORT_ID_PREFIX,
  /* 印章外部批量導入面（批 3 前置 §3.55.5 / §4.1.17；供离线自检直接断言）。 */
  SEAL_IMPORT_ALLOWED_KEYS,
  SEAL_IMPORT_REVIEW_ALLOWED_KEYS,
  SEAL_IMPORT_STATUS,
  SEAL_IMPORT_IMAGE_STATUS,
  /* **佔位圖（影像例外｜本單新增；供離線自檢直接斷言兩側同值 / 直接跑採納門）**。 */
  SEAL_PLACEHOLDER_IMAGE_KEY,
  SEAL_PLACEHOLDER_IMAGE,
  buildSealAcceptanceFromImport,
  /* **无审核直写面（本单新增｜人类口径 2026-10-28）**：两 op 的封闭键面 / 三态枚举 /
     env 与三道硬门（供离线自检直接断言与直接跑）。 */
  DIRECT_WRITE_ALLOWED_KEYS,
  DIRECT_WRITE_ROW_KEYS,
  DIRECT_WRITE_FACE_KEYS,
  SEAL_FINGERPRINT_QUERY_KEYS,
  SEAL_FINGERPRINT_MATCH,
  SEAL_FINGERPRINT_ROW_KEYS,
  SEAL_FINGERPRINT_FACE_KEYS,
  directWriteEnvOf,
  directWriteIdentityDenial,
  directWriteSourceDenial,
  directWriteReviewerDenial,
  buildDirectImageRow,
  SEAL_IMPORT_ID_PREFIX,
  SEAL_IMPORT_SEAL_FIELDS,
  SEAL_IMPORT_FACE_FIELDS,
  /* 印章導入行源側擴面（51 鍵｜E-1；供離線自檢直接斷言）。 */
  SEAL_IMPORT_SOURCE_FIELDS,
  SEAL_IMPORT_SEAL_LEVEL_FIELDS,
  SEAL_IMPORT_FINGERPRINT_FIELDS,
  SEAL_IMPORT_SOURCE_INT_FIELDS,
  SEAL_IMPORT_SOURCE_OBJECT_FIELDS,
  SEAL_IMPORT_SOURCE_RAW_FIELDS,
  /* 印谱外部批量導入面（item 通道切片 A｜v1.61；供离线自检直接断言）。 */
  ITEM_IMPORT_ALLOWED_KEYS,
  ITEM_IMPORT_REVIEW_ALLOWED_KEYS,
  ITEM_IMPORT_STATUS,
  ITEM_IMPORT_ID_PREFIX,
  ITEM_BODY_FIELDS,
  ITEM_MISC_FIELDS,
  ITEM_BODY_INT_FIELDS,
  ITEM_BODY_BOOL_FIELDS,
  ITEM_DATE_PLACEHOLDER,
  /* 一次性朝代值遷移面（§3.53.5；供離線自檢直接斷言）。 */
  MIGRATE_ALLOWED_KEYS,
  DYNASTY_MIGRATION,
  /* 值域收斂面（本單 `migrateSealValueDomains`；供離線自檢直接斷言）。 */
  SEAL_VALUE_DOMAIN_TARGETS,
  /* **本單 I-2 / I-3**：修復通道面與待審取行護欄（供離線自檢直接斷言）。 */
  IMPORT_REVIEW_PAGE_SIZE,
  IMPORT_REPAIR_SCAN_LIMIT,
  REPAIR_ALLOWED_KEYS,
  IMPORT_REPAIR_TARGETS,
  /* **本單 E-3 / E-4**：只讀取行通道面（`pullImportRows`）與包封收窄讀點
     （供離線自檢直接斷言）。 */
  PULL_IMPORT_ROWS_ALLOWED_KEYS,
  PULL_IMPORT_COLLECTION_KEYS,
  PULL_IMPORT_BATCH_PREFIXES,
  PULL_IMPORT_STATUS_VALUES,
  PULL_IMPORT_DEFAULT_LIMIT,
  PULL_IMPORT_MAX_LIMIT,
  IMPORT_REVIEW_COLLECTION_BY_OP,
  stripImportIdentityFields,
  importCollectionOfBatchPrefix,
  countRemainingImportPending,
  OPS,
  ADMIN_OPS,
  /* **识别编码（本单新增）**：号源发号单点 ＋ 号源集合名（供离线自检注入假体直接跑）。 */
  COUNTERS_COLLECTION,
  issueCodeNumber,
  issueCodeNumberAvoiding,
  /* **積分賬本（「金」上雲｜本單）**：集合句柄供給點 ＋ 载荷封闭键面 ＋ 账本模块本体
     （供离线自检注入假体直接断言；账本实现单点在 `lib/ledger.js`）。 */
  resolveLedgerStore,
  POINTS_BALANCE_ALLOWED_KEYS,
  POINTS_FLOW_ALLOWED_KEYS,
  pointsPayloadDenial,
  ledger,
  /* **AI 金鑰 / 上游 / 用量（本單）**：集合句柄供給點 ＋ 载荷封闭键面 ＋ 三模块本体
     （供离线自检注入假体直接断言；实现单点在 `lib/aiKeys.js` / `lib/aiUpstream.js` /
     `lib/aiUsage.js`）。 */
  resolveAiStore,
  AI_KEY_ISSUE_ALLOWED_KEYS,
  AI_KEY_LIST_ALLOWED_KEYS,
  AI_KEY_REVOKE_ALLOWED_KEYS,
  AI_KEY_LIMITS_ALLOWED_KEYS,
  AI_USAGE_ALLOWED_KEYS,
  AI_UPSTREAM_ALLOWED_KEYS,
  AI_UPSTREAM_ALLOWED_KEYS_VIEW,
  aiKeys,
  aiUpstream,
  aiUsage,
  setOpsDbProvider,
  opsDbInjected,
  setOpsStorageProvider,
  opsStorageInjected,
  setOpsStorageUploadProvider,
  opsStorageUploadInjected,
  resolveDb,
  readRoleRow,
  readPersonRow,
  readPersonProposalRow,
  readPersonImportRow,
  readSealImportRow,
  readItemImportRow,
  IDENTITY_SOURCES,
  isSessionIdentity,
  identitySourceOf,
  identityUsable,
  readArtifactBytes,
  uploadDisplayArtifactBytes,
  artifactMimeOf,
  adminWhitelistDenial,
  readCorrectionRow,
  buildProjection,
  persist
}
