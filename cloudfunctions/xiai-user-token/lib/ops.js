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
const { REASONS, deny, normalizePhone } = require('./config.js')
/* 展示件轉碼器（本單新增；純 JS 零新依賴 —— node:zlib ＋ 自寫 CRC32）。 */
const { tiffToPng } = require('./tiffToPng.js')
/* **V6-a**：调用者**平台会话身份**判权（additive）。`IDENTITY_SOURCES` 是身份来源标记的
   **单一定义点**（既有令牌路取值 `SERVER_TOKEN` 逐字沿用；会话路为 `SESSION`）。 */
const { IDENTITY_SOURCES, ROLE, isSessionIdentity, identitySourceOf, identityUsable, setAuthApiChannelProvider } = require('./sessionAuthority.js')

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
  personImports: 'xiai_person_imports'
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
const ALLOWED_KEYS = Object.freeze(['faceId', 'sealId', 'stampId', 'field', 'value', 'basis'])

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

/** 外部导入提交载荷允许键（**封闭键面**；身份类键一律拒 —— 导入人由服务端派生）。 */
const PERSON_IMPORT_ALLOWED_KEYS = Object.freeze([
  'batch_id',
  'source',
  'source_person_id',
  'name_full',
  'family_name',
  'given_name',
  'courtesy_names',
  'art_names',
  'alias_names',
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
  '先秦',
  '秦',
  '漢',
  '魏晉',
  '隋唐',
  '宋元',
  '明中期',
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
 * @param {string} collection 集合名（`^xiai_`）
 * @param {object} match 等值条件
 * @returns {Promise<Array<object>>}
 */
async function readRows(collection, match) {
  const db = resolveDb()
  const query = db.collection(collection)
  if (!query || typeof query.where !== 'function') throw new Error('DB_QUERY_UNSUPPORTED')
  return rowsOfReply(await query.where(match).get())
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
      art_names: art,
      alias_names: alias,
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

const ADMIN_OPS = Object.freeze({
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
    /* ④ 读导入行（批次或单行；**只读** —— 不是写）。 */
    let targets = []
    if (importId) {
      const found = await readPersonImportRow(importId)
      if (found) targets = [found.row]
    } else {
      targets = await readRows(COLLECTIONS.personImports, { batch_id: batchId })
    }
    if (targets.length === 0) {
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
    const skipped = []
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
      const existing = persons.find((item) => text(item && item.source_person_id) === sourceId)
      if (!existing) {
        let max = 0
        persons.forEach((item) => {
          const matched = new RegExp(`^${PERSON_CODE_PREFIX}(\\d{9})$`).exec(text(item && item.code))
          if (matched) max = Math.max(max, Number(matched[1]))
        })
        const taken = new Set(persons.map((item) => text(item && item.code)))
        let index = max + 1
        while (taken.has(`${PERSON_CODE_PREFIX}${String(index).padStart(9, '0')}`)) index += 1
        const code = `${PERSON_CODE_PREFIX}${String(index).padStart(9, '0')}`
        const person = {
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
          source_person_id: sourceId, // **幂等键（溯源）**
          proposal_id: '',
          created_by: identity.uid,
          created_at: at,
          updated_at: at
        }
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
 * @param {{collection?:string, doc?:object, writes?:Array<object>}} plan
 * @returns {Promise<string>} 首要文档标识；失败 ⇒ 抛错
 */
async function persist(plan) {
  const db = resolveDb()
  if (plan && Array.isArray(plan.writes)) {
    let primary = ''
    for (const step of plan.writes) {
      if (step && step.kind === 'set') {
        await db.collection(step.collection).doc(step.id).set(step.doc)
        if (!primary) primary = String(step.id)
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
        continue
      }
      const result = await db.collection(step.collection).add(step.doc)
      const id = result && (result.id || result._id || (result.data && result.data.id))
      if (!primary) primary = id ? String(id) : ''
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
  OPS,
  ADMIN_OPS,
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
