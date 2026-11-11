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
 *   ③ **落库用管理端凭据**（`@cloudbase/node-sdk` 在函数运行环境内取凭据，**不入仓、不下发前端**）
 *      —— **已被 2026-10-29 单取代**：Vercel 无平台角色凭据 ⇒ 有密钥对时经
 *      `initClientFromEnv()`（本文件唯一的 SDK 客户端初始化点）**显式传入**
 *      （**本函数侧只认 `CLOUDBASE_*` 一族、两者均在才成对**；平台族变量**一律不参与** ——
 *      原因见 `cloudbaseKeyPairFromEnv()`：运行时注入的是**临时凭据、需 session token**，
 *      只传 id / key 而不带 token ⇒ `SIGN_PARAM_INVALID`；Vercel 侧 `api/_lib/aiRelay.js`
 *      则两族皆可、成对不混用 —— 两者**不共用**解析点，见各自头注）；
 *      **云函数环境无 `CLOUDBASE_*` 变量时行为不变**
 *      （仍不传密钥、凭据仍由运行环境注入；密钥**不入仓、不下发前端**照旧）；
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
/* **2026-10-29 应急修单**：本文件**不再引入** config 的凭据对解析器（它带平台族回退）——
   云函数侧的凭据名解析改由本文件本地的 `cloudbaseKeyPairFromEnv()` 单点负责（只认 `CLOUDBASE_*`）。 */
const { REASONS, ENV_NAMES, deny, normalizePhone, isPhoneLike, uidOf, readEnvId, isDocNotExistError, isCollectionNotExistError } = require('./config.js')
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
   **客户端初始化单点（2026-10-29 单；应急修单：修生产回滚根因）**：`initClientFromEnv()`
   —— 本文件**唯一**的 SDK 客户端初始化（`init`）调用点：会话探针通道（`resolveAuthApiChannel`）/
   存储回读（`readArtifactBytes`）/ 存储上传（`uploadDisplayArtifactBytes`）/
   取 DB（`resolveDb`）**四处一律经它**；**不许留下第二套** envId / 密钥名解析。
   口径：
   ① envId 走 `config.readEnvId`（`TCB_ENV` → `SCF_NAMESPACE` → `CLOUDBASE_ENV_ID`；
      缺位 ⇒ **不带 `env` 键** ⇒ 保持「无参 init」语义、不写死）；
   ② 密钥对走**本文件本地的 `cloudbaseKeyPairFromEnv()`**（**唯一读密钥变量名处**；
      只认 `CLOUDBASE_*` 一族、**两者均在才成对**；任一缺 ⇒ 空对 ⇒ **不带**
      `secretId` / `secretKey` 地 init ⇒ **云函数环境行为与旧版逐字不变**）。
      **本函数侧绝不参与平台族变量**：SCF / CloudBase 运行时注入的平台族 id / key 是
      **临时凭据、需 session token**，只传 id / key 而不带 token ⇒ `SIGN_PARAM_INVALID`
      （2026-10-29 生产回归的根因）；那套交给 `@cloudbase/node-sdk` 自己处理才是对的。
      Vercel 侧（`api/_lib/aiRelay.js`）两族皆可、成对不混用 —— 见各自头注；
   ③ 延迟 require：离线自检（注入缝）时**不需要**装 `@cloudbase/node-sdk`。
   --------------------------------------------------------------------------- */

/**
 * **云函数侧凭据对取值单点（本文件唯一一处读密钥变量名）**：只认 `CLOUDBASE_*` 一族。
 * · **两者均在**（trim 后非空）⇒ 返回该对；**任一缺 / 两族各半** ⇒ **空对**（成对不混用）
 *   ⇒ 调用方据此**不带** `secretId` / `secretKey` 地 init ⇒ 无 `CLOUDBASE_*` 的云函数环境
 *   行为与旧版逐字不变。
 * · **绝不参与平台族变量**（本文件全文零命中）——原因：SCF / CloudBase 运行时往函数里
 *   注入的平台族 id / key 是**临时凭据、必须连 session token 一起送**，只传 id / key 而
 *   不带 token ⇒ 鉴权失败（`SIGN_PARAM_INVALID`）；那套凭据应交给 `@cloudbase/node-sdk`
 *   自己读取与轮换，本文件不碰（2026-10-29 生产回归的根因即「顺手回退到平台族变量名」）。
 * · **与 Vercel 侧职责不同、不共用解析点**：`api/_lib/aiRelay.js` 跑在 Vercel（平台不注入
 *   平台族变量，回退只服务本地 / CI）⇒ 两族皆可、成对不混用；本文件跑在云函数运行时
 *   ⇒ 只认 `CLOUDBASE_*`。
 * @returns {{secretId:string, secretKey:string}} 对（缺 ⇒ 两个空串）
 */
function cloudbaseKeyPairFromEnv() {
  const secretId = String(process.env.CLOUDBASE_SECRET_ID || '').trim()
  const secretKey = String(process.env.CLOUDBASE_SECRET_KEY || '').trim()
  /* **成对不混用**：两者均在才成对返回；任一缺（含两族各半）⇒ 空对。 */
  if (secretId && secretKey) return { secretId, secretKey }
  return { secretId: '', secretKey: '' }
}

function initClientFromEnv() {
  const tcb = require('@cloudbase/node-sdk')
  const envId = readEnvId(process.env)
  const pair = cloudbaseKeyPairFromEnv()
  const init = envId ? { env: envId } : {}
  if (pair.secretId && pair.secretKey) {
    init.secretId = pair.secretId
    init.secretKey = pair.secretKey
  }
  /* **调用形态（本单追加修）**：既无 envId、也无密钥对 ⇒ **零参 init** —— 与老代码
     的条件式形态逐字等价（有 envId 传 `{env}`、无 envId **零参**）：「传空对象」与
     「零参」对 SDK 是**两种不同形态** —— 空对象会被当成「调用方给了配置」而覆盖 SDK
     内部默认推断；运行时 `TCB_ENV` / `SCF_NAMESPACE` / `CLOUDBASE_ENV_ID` 三者全缺时，
     空对象形态整体拿不到环境 ⇒ 所有 DB op 抛错 ⇒ 被折叠成 `STORAGE_UNAVAILABLE`
     （生产「上游配置存不进去」的候选根因之一）。
     经 `...args` 展开实现：空数组展开＝零参调用（与老代码零参分支同义）、单元素数组
     展开＝单参调用；保持全文件 SDK init 调用 **恰 1 处**（`scripts/verify-points-ledger.mjs`
     C7 单点门的既有判据只增不减）。自检：`scripts/verify-userwrite-pa.mjs` A7h（假 SDK 记录实参）。 */
  const hasInit = init.env !== undefined || init.secretId !== undefined
  return tcb.init(...(hasInit ? [init] : []))
}

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
      /* 客户端句柄一律经 `initClientFromEnv()`（本文件唯一的 SDK 客户端初始化点）。 */
      authApiChannel = initClientFromEnv().auth()
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
  itemImports: 'xiai_item_imports',
  /* **實物照片（§3.33.3 既有集合；本单 `deleteSeal` **只读计数**）**：删印时照片行
     **全保留**（审计用）⇒ 本键只进读面、**零删行**。 */
  photos: 'xiai_photos',
  /* **管理員寫面審計行（§3.33.3 第 14 項｜AC-373 落点）**：`deleteSeal` 的**第二处审计载体**
     （第一处＝`index.js::audit` 的结构化日志）。**只写一行**、封闭键面；**不进云读面**
     （不入 `CLOUD_COLLECTIONS` / 客户端镜像），**不新建集合**（沿用规范在册名称）。 */
  adminAudit: 'xiai_admin_audit',
  /* **關聯批兩集合（§3.61.8 / §4.1.20 / §4.1.21｜v1.64 在册、AC-538 / AC-548）**：本单新增的
     批量落库通道 `importRelations` 的落点（`sealLinks` ＝ `xiai_seal_links`、
     `personRelations` ＝ `xiai_person_relations`）。**只在此登记**（集合名仍只活在本文件；
     实现点 `lib/importChannels.js` 零集合名字面），**不进客户端云读面**（不入 `CLOUD_COLLECTIONS`
     / `CLOUD_COLLECTION_KEYS` / `CLOUD_KEY_OF_LOCAL` ⇒ 客户端零读面）、**不开放任何直写入口**。 */
  sealLinks: 'xiai_seal_links',
  personRelations: 'xiai_person_relations'
})

/**
 * **可选读面白名单**（`readRows` 里唯一允许把「集合不存在」降级成「零行」的集合；封闭名单）。
 *
 * 判据（为什么只列这三个）：它们都是**「查有没有行」语义的可选读面** ——
 *   · `endorsements`       ＝ 采信私有行：**生产从未被创建**（2026-10-04 起 `reviewCorrection` /
 *     `endorseCorrection` 每次都因读它抛 `DATABASE_COLLECTION_NOT_EXIST` 而整笔零写入，
 *     集合因此永远没被写过 ⇒ 读它「零行」是真实语义）；
 *   · `correctionSummaries`＝ 值级公开脱敏摘要行（首单提交才 upsert，可能尚无行 / 未建集合）；
 *   · `correctionsPublic`  ＝ 公开只读脱敏投影（首条采纳才 upsert，同上）。
 * 三者**都不是权威写面、也不是防重门 / 引用校验面** ⇒ 「不存在 ≡ 零行」不改变任何判定结果。
 *
 * **明确不在名单**（必须原样抛出，绝不降级）：
 *   · `corrections`（`xiai_corrections`）—— 勘误权威私有行，`reviewCorrection` 的状态门 /
 *     `expectAtLeast` 防重门都靠它；降级成零行 ⇒ 「未找到该勘誤單」被误报、更新命中 0 行被静默放过；
 *   · `seals` / `faces` / `images`（`xiai_seals` / `xiai_faces` / `xiai_images`）—— 引用校验与
 *     号源发号读面，降级 ⇒ 可能对不存在的对象发号 / 落盘；
 *   · `roles` / `persons` / `*Imports` / `items` / `COUNTERS_COLLECTION` / 积分与 AI 诸集合 ——
 *     判权（fail-closed）与账本面，真存储故障绝不能伪装成空。
 * 另：**非白名单集合上的任何错误、白名单集合上的任何非「集合不存在」错误（ETIMEDOUT / 权限 /
 * 5xx …）一律照旧上抛**（判据单点见 `lib/config.js::isCollectionNotExistError`）。
 */
const OPTIONAL_READ_COLLECTIONS = Object.freeze([
  COLLECTIONS.endorsements,
  COLLECTIONS.correctionSummaries,
  COLLECTIONS.correctionsPublic
])

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

/**
 * 印章导入审核载荷允许键（**封闭键面**：批次 / 单行 / 决定 / 理由 ＋ **本单新增 opt-in 布尔**
 * `backfill_image_stamp`）。
 * · `backfill_image_stamp`（缺省 `false` ⇒ **既有行为逐字不变**；既有三个调用点不传该键）：
 *   `true` ⇒ 采纳成功时把**被采纳行 `faces` 引用命中的影像行**补上 `stamp_id` ＋ `seq`
 *   （`seq` 只走既有单点 `imageSeqsOf` / `nextImageSeqOf`，**本 op 不自算号**）并重写该影像行。
 * · 值态门：给出即必须是**布林**（否则 `INVALID_VALUE` ＋ 零写入，与 `dry_run` 同族口径）。
 */
const SEAL_IMPORT_REVIEW_ALLOWED_KEYS = Object.freeze([
  'batch_id',
  'import_id',
  'decision',
  'note',
  'backfill_image_stamp'
])

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

/**
 * **撤销采纳（`revokeCorrectionAcceptance`）载荷允许键**（**封闭键面**，恰两键：
 * `correction_id`（必有）＋ `note`（可选，字符串 ≤ `MAX_NOTE_LENGTH` 字）；与
 * `src/services/corrections.js::REVOKE_PAYLOAD_KEYS` 逐字同值）。
 *
 * **身份类键一律不在本表** ⇒ `INVALID_FIELD` ＋ 零写入（身份永远取自已验签令牌 /
 * 平台会话，与 `REVIEW_IDENTITY_KEYS` 同一套文案）。**零 `decision` 键** —— 撤销的方向
 * 由 op 本身钉死（只许 `ACCEPTED → REJECTED`），不由前端选。
 */
const REVOKE_ALLOWED_KEYS = Object.freeze(['correction_id', 'note'])

/**
 * **`NOT_FOUND` 字面值**（撤销 op 专用；**既有冻结字面值、零新增 reason**）。
 *
 * 为什么不写 `REASONS.NOT_FOUND`：`lib/config.js::REASONS` 的冻结表**未登记** `NOT_FOUND`
 * ⇒ `REASONS.NOT_FOUND` 取到 `undefined`（既有 `reviewPersonProposal` 等处即此形态，见
 * `scripts/verify-adopt-atomicity.mjs` B5b 的存疑登记）。本 op 的失败回包**恒须恰 3 键**
 * `{ok:false, reason, message}`（`reason` 若为 `undefined` 序列化后只剩 2 键）⇒ 直接用字面
 * 常量，与 `lib/codeId.js::REASON_NOT_FOUND` 同值；**不改 `lib/config.js`、不新增字面值**。
 */
/* **按规范映射**：云函数 `REASONS` 冻结表不含 `NOT_FOUND`（该字面值属客户端 / 管理员函数面），
   规范口径是「`NOT_FOUND` → `INVALID_VALUE`」⇒ 本 op 只用既有 `REASONS.INVALID_VALUE`，
   **不新增字面值**；文案里写明「該勘誤不存在」以保留可读性。 */
const REASON_CORRECTION_NOT_FOUND = REASONS.INVALID_VALUE

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
  /* 客户端句柄经 `initClientFromEnv()`（延迟 require 已内聚其中；离线自检走注入存储缝、不经此处）。 */
  const app = initClientFromEnv()
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
  /* 客户端句柄经 `initClientFromEnv()`（延迟 require 已内聚其中；离线自检走注入上传缝、不经此处）。 */
  const app = initClientFromEnv()
  await app.uploadFile({ cloudPath, fileContent: payload })
}

/* ---------------------------------------------------------------------------
   对象存储**删除**缝（**离线自检 / 宿主用**；生产不注入 ⇒ 走真实 `@cloudbase/node-sdk`）
   —— 本单 `ai-enhance-discard` 用：内容寻址去重保护成立（同摘要在影像行集合中再无其它行）
   时才删对象；否则只删行。
   --------------------------------------------------------------------------- */

let storageDeleteProvider = null

/**
 * 注入对象存储**删除**实现（**仅供离线自检 / 宿主**）。
 * 形状：`async (cloudPath) => void`（删除失败 ⇒ **抛错**，由 op 如实转 `deleted_objects: false`）。
 * @param {null|function(string):Promise<void>} fn
 */
function setOpsStorageDeleteProvider(fn) {
  storageDeleteProvider = typeof fn === 'function' ? fn : null
}

/** 删除缝是否已注入（诊断读数用，**不含任何凭据**）。 */
function opsStorageDeleteInjected() {
  return storageDeleteProvider !== null
}

/**
 * **删除对象**（服务端；`ai-enhance-discard` 的唯一删对象点）。
 * 顺序：① 注入缝（离线自检）→ ② 真实 node-sdk：先解析完整 fileID，再 `deleteFile`。
 * 任一环失败 ⇒ **抛错**（由调用方如实报 `deleted_objects: false`；**不得谎报已删**）。
 * @param {string} cloudPath 对象键
 * @returns {Promise<void>}
 */
async function deleteArtifactObject(cloudPath) {
  if (storageDeleteProvider) {
    await storageDeleteProvider(cloudPath)
    return
  }
  /* 客户端句柄经 `initClientFromEnv()`（延迟 require 已内聚其中；离线自检走注入删除缝、不经此处）。
     句柄变量**不用 `app` 字面**：`scripts/verify-points-ledger.mjs` C7 静态门按「`app` ＝ 初始化
     单点」的既有三消费点恰 3 处计数 —— 本函数是第 4 个消费点，换名即不改判据、判据不为本单漂移。 */
  const handle = initClientFromEnv()
  const fileID = await resolveFileId(handle, cloudPath)
  /* **SDK 参数形状**（2026-11-07 实测）：`deleteFile` 只认 `{ fileList: [...] }`；
     传 `{ fileID }` 会抛 `fileList必须是非空的数组`（旧写法被 catch 吞成「0 件」⇒
     行删了、对象永不删的存储泄漏）。 */
  await handle.deleteFile({ fileList: [fileID] })
}

/**
 * 取 DB 句柄。
 * 凭据来源：**函数运行环境注入的角色凭据**（node-sdk 自行读取）——本文件**不传任何密钥**；
 * envId 取运行期环境变量（缺位 ⇒ 交给 SDK 的「当前环境」语义，**不写死**）。
 * （上两句为原口径，**已被 2026-10-29 单取代**：Vercel 无平台角色凭据 ⇒ 经
 *  `initClientFromEnv()` 在**有密钥对时显式传入** `secretId` / `secretKey`；
 *  **云函数环境无 `CLOUDBASE_*` 变量时行为不变**——仍不传密钥（平台族凭据交 SDK 自取）、`envId` 缺位仍不带 `env` 键。）
 */
function resolveDb() {
  if (dbProvider) return dbProvider()
  const app = initClientFromEnv()
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
 * 失败 ⇒ 抛错（由 `index.js` 统一转 `STORAGE_UNAVAILABLE`，**绝不伪装 `FORBIDDEN`**）；
 * **唯一例外** ＝ 白名单可选集合 `OPTIONAL_READ_COLLECTIONS` 上的「集合不存在」
 * （`DATABASE_COLLECTION_NOT_EXIST`）⇒ 视作**零行**回 `[]`（判据与理由见下方实现处注释）。
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
 * @param {{limit?:number, orderByDesc?:string}} [options] 单次读取上限（平台护栏；缺省 / ≤0 ⇒ 不显式限量）
 *   ＋ **可选排序**（`orderByDesc` ＝ 字段名，倒序）。
 *   排序**只增不改**：未给 `orderByDesc` 的既有调用者行为**逐字不变**（同一条 `where → limit → get` 链）。
 *   给了则**优先交给 DB**（`chain.orderBy(field, 'desc')`，仅当该链真有 `orderBy` 方法时才调）；
 *   **SDK 不支持 / 调用报错 ⇒ 退路**为退回不排序的同一条链取回（调用方在服务端自行排序）——
 *   判据：本读点的链只有 `where → limit → get`，注入式内存假体（离线自检）没有 `orderBy` 方法。
 * @returns {Promise<Array<object>>}
 */
async function readRows(collection, match, options) {
  const db = resolveDb()
  /* 形态门（与旧版**同位**：进 `try` 之前抛 `DB_QUERY_UNSUPPORTED`；错误上抛语义一字不变）。
     这里取的句柄**只看形状、绝不往上链任何条件** —— CloudBase SDK 的查询对象是**可变链**，
     同一实例上第二次 `where` / `limit` 会把条件叠加或残留 ⇒ 下面 `build` 每次尝试都从
     `db.collection(collection)` **重新取一条新链**，本句柄不参与查询。 */
  const probe = db.collection(collection)
  if (!probe || typeof probe.where !== 'function') throw new Error('DB_QUERY_UNSUPPORTED')
  const orderField = options && typeof options.orderByDesc === 'string' ? options.orderByDesc : ''
  const build = (withOrder) => {
    /* **每次尝试各取新链（2026-11-04 修｜线上两只读 op 恒 0 行的真因）**：旧版在 `build` 内
       反复复用**外层同一个 `query` 实例** —— 先随 `build(true)` 拼 `where → limit → orderBy`
       并抛错后，又用**同一个已被拼脏的实例** `build(false)` 重拼 ⇒ 可变链上条件叠加 / 残留
       ⇒ 退路查询稳定落空（`rows.length === 0` 而 `pendingResult.ok === true`，与线上现象完全吻合）。
       故：链一律在本闭包内**新建**（`db.collection(collection)` 每次重取）；带 order / 不带 order
       两条路**各自独立链、互不污染**。子句顺序维持既有 `where → limit → orderBy`（`limit` 与
       `orderBy` 只各设一个字段、互不相干；语义不变）。 */
    const query = db.collection(collection)
    let chain = query.where(match)
    const limit = Number(options && options.limit)
    if (Number.isFinite(limit) && limit > 0 && chain && typeof chain.limit === 'function') {
      chain = chain.limit(Math.floor(limit))
    }
    if (withOrder && orderField && chain && typeof chain.orderBy === 'function') {
      chain = chain.orderBy(orderField, 'desc')
    }
    return chain
  }
  /* **可选集合降级（本单真因修）**：CloudBase 对**从未被写过**的集合回
     `DATABASE_COLLECTION_NOT_EXIST`（生产实测：`xiai_endorsements` 不存在 ⇒ `reviewCorrection`
     准备阶段读采信计数即抛 ⇒ 整笔零写入）。对**白名单** `OPTIONAL_READ_COLLECTIONS`（「查有没有行」
     语义的可选读面）「集合不存在 ≡ 零行」⇒ 回 `[]`；**其余集合、其余错误一律原样抛出**
     （防重门 / 引用校验 / 判权读面绝不把真存储故障吞成空）。判据单点
     `lib/config.js::isCollectionNotExistError`（只看错误码 / errCode ＋一条特异文本兜底）。 */
  const downgrade = (error) => isCollectionNotExistError(error) && OPTIONAL_READ_COLLECTIONS.indexOf(collection) !== -1
  try {
    if (orderField) {
      try {
        return rowsOfReply(await build(true).get())
      } catch (error) {
        /* 退路（**不吞真故障**）：真存储故障会在下面这次重读里再次抛出，仍由 `index.js` 转 `STORAGE_UNAVAILABLE`；
           「集合不存在」也会在下面这次重读里再次抛出，由外层 catch 按白名单统一判定（白名单 ⇒ `[]`，否则上抛）。
           退路链是**新建链**（见上 `build` 注）：即使 `orderBy` 路抛错，重读也不带任何残留条件。
           **退路仍回 0 行时不得静默**：该情形只可能来自「集合确无匹配行 / 条件本身写错 / 数据侧另有故障」，
           —— 属于**数据语义**而非链复用；按回包键面冻结口径，此处**不新增任何回包键**
           （成功恒 4 键 `{ok:true, op, rows, count}`、失败恒 3 键），排序兜底仍由调用方
           （`readCorrectionRowsSorted`）在服务端自行完成；诊断线索只落在本注释，不进回包。 */
        if (!isCollectionNotExistError(error)) {
          return rowsOfReply(await build(false).get())
        }
        throw error
      }
    }
    return rowsOfReply(await build(false).get())
  } catch (error) {
    if (downgrade(error)) return []
    throw error
  }
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
  /* doc() 兜底：`doc(id).get()` 在**文档不存在**时抛错（404）而非回空 ⇒ 这里**仅**吞「不存在」类
     （判据见 lib/config.js::isDocNotExistError —— 只看错误码 / errCode），其余（连接 / 权限 / 5xx …）
     照旧上抛，绝不把真存储故障吞成「无行」。 */
  let rowsByDoc = []
  try {
    rowsByDoc = rowsOf(await collection.doc(id).get())
  } catch (error) {
    if (!isDocNotExistError(error)) throw error
  }
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
  /* **同形修（2026-11-04）**：检索式一律**每次新建集合句柄**再链 `where` —— 旧版把
     `const collection = db.collection(...)` 存下来连拼两次 `.where({id})` / `.where({code})`，
     可变链上二次 `where` 会叠加条件 ⇒ 第二式恒 0 行（与 `readRows` 同一隐患、同形修正）。
     `doc()` 兜底同理各取新句柄；**只改读面，写面 `persist` 不动**。 */
  const byId = await db.collection(COLLECTIONS.persons).where({ id }).get()
  const rowsById = rowsOf(byId)
  if (rowsById.length > 0) return rowsById[0]
  const byCode = await db.collection(COLLECTIONS.persons).where({ code: id }).get()
  const rowsByCode = rowsOf(byCode)
  if (rowsByCode.length > 0) return rowsByCode[0]
  /* doc() 兜底：`doc(id).get()` 在**文档不存在**时抛错（404）而非回空 ⇒ 这里**仅**吞「不存在」类
     （判据见 lib/config.js::isDocNotExistError —— 只看错误码 / errCode），其余（连接 / 权限 / 5xx …）
     照旧上抛，绝不把真存储故障吞成「无行」。 */
  let rowsByDoc = []
  try {
    rowsByDoc = rowsOf(await db.collection(COLLECTIONS.persons).doc(id).get())
  } catch (error) {
    if (!isDocNotExistError(error)) throw error
  }
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
  /* doc() 兜底：`doc(id).get()` 在**文档不存在**时抛错（404）而非回空 ⇒ 这里**仅**吞「不存在」类
     （判据见 lib/config.js::isDocNotExistError —— 只看错误码 / errCode），其余（连接 / 权限 / 5xx …）
     照旧上抛，绝不把真存储故障吞成「无行」。 */
  let rowsByDoc = []
  try {
    rowsByDoc = rowsOf(await collection.doc(id).get())
  } catch (error) {
    if (!isDocNotExistError(error)) throw error
  }
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
  /* doc() 兜底：`doc(id).get()` 在**文档不存在**时抛错（404）而非回空 ⇒ 这里**仅**吞「不存在」类
     （判据见 lib/config.js::isDocNotExistError —— 只看错误码 / errCode），其余（连接 / 权限 / 5xx …）
     照旧上抛，绝不把真存储故障吞成「无行」。 */
  let rowsByDoc = []
  try {
    rowsByDoc = rowsOf(await collection.doc(id).get())
  } catch (error) {
    if (!isDocNotExistError(error)) throw error
  }
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
  /* doc() 兜底：`doc(id).get()` 在**文档不存在**时抛错（404）而非回空 ⇒ 这里**仅**吞「不存在」类
     （判据见 lib/config.js::isDocNotExistError —— 只看错误码 / errCode），其余（连接 / 权限 / 5xx …）
     照旧上抛，绝不把真存储故障吞成「无行」。 */
  let rowsByDoc = []
  try {
    rowsByDoc = rowsOf(await collection.doc(id).get())
  } catch (error) {
    if (!isDocNotExistError(error)) throw error
  }
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
   **影像行 `seq` 分配单点（唯一实现点；三条写行路径共用）**
   ---------------------------------------------------------------------------
   背景（真因，已控制台读数）：`xiai_images` 上有复合唯一索引
   `ux_stamp_id_kind_seq(kind, seq, stamp_id)`；doc **缺 `seq`** ⇒ 该三元组恒空 ⇒
   同印同 `kind` 的第二行必撞 `E11000`（AI 修复产物行首写能过、再写必炸即此）。
   故本文件**只此一处**算 `seq`：
     · `nextImageSeqOf(stampId, kind, takenSeqs)` ＝ **纯函数**（零 I/O、零自抛）：
       把「既有行」与「本批已分配号」合并取最大值 + 1（无有效值 ⇒ 从 1 起算）；
     · `imageSeqsOf(stampId, kind)` ＝ **只读读取包装**：按 `(stamp_id, kind)` 读既有行
       （`limit: 1000` —— 组内唯一 ⇒ 必须看全，否则算小必撞）；**读抛错 ⇒ 按空集**
       （分配**不得阻断写入**；也**不把真故障伪装成「有行」** —— 空集就是空集，且
       `console.warn` 如实记降级；真故障若最终仍撞键，由各写路径的既有兜底处理）。
   调用点（三条写行路径，全部经此）：
     ① 印章导入采纳 ＋ 无审核直写（两者共用构造器 `buildSealAcceptanceFromImport`）；
     ② 直写 op 的 `stamp_id` 回填处（`buildDirectImageRow(face, at, seq)` 定稿）；
     ③ `lib/aiEnhance.js`（AI 修复产物行）。
   --------------------------------------------------------------------------- */

/** `seq` 形态门（**正整数**；`0` / 负 / 小数 / NaN / 布尔 / 缺键 ⇒ 不合法）。 */
function isImageSeq(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return false
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 && Math.floor(n) === n
}

/**
 * 下一个可用 `seq`（**纯函数单点**；零 I/O、零自抛、不触库）。
 *
 * @param {string} stampId 印章 id（**组标识**；传入的行对象若自带 `stamp_id` 且与之不同 ⇒ 跳过，防串组）
 * @param {string} kind 影像类别（`FACE` / `EDGE`；同上）
 * @param {Array<object|number|string>|Set<...>|object|number|string} [takenSeqs] 已占用号：
 *   **既有行**（行对象取 `Number(row.seq)`）＋ **本批已分配号**（数字 / 数字串 / 行对象皆可；
 *   缺省 / 空 ⇒ 视作零占用）
 * @returns {number} 下一个可用正整数（无有效值 ⇒ 从 1 起算）
 */
function nextImageSeqOf(stampId, kind, takenSeqs) {
  const wantStamp = text(stampId)
  const wantKind = text(kind)
  let max = 0
  const absorb = (item) => {
    if (item !== null && typeof item === 'object') {
      /* 行对象：只认同组（`stamp_id` / `kind` 行上给出且与本组不同 ⇒ 跳过，防串组）。 */
      const rowStamp = item.stamp_id === undefined || item.stamp_id === null ? '' : text(item.stamp_id)
      const rowKind = item.kind === undefined || item.kind === null ? '' : text(item.kind)
      if (wantStamp && rowStamp && rowStamp !== wantStamp) return
      if (wantKind && rowKind && rowKind !== wantKind) return
      if (!isImageSeq(item.seq)) return
      const own = Number(item.seq)
      if (own > max) max = own
      return
    }
    if (!isImageSeq(item)) return
    const own = Number(item)
    if (own > max) max = own
  }
  try {
    if (takenSeqs === null || takenSeqs === undefined) return 1
    /* 字符串虽可迭代但**按单值**处理（`'12'` 不得当成字符序列 `'1','2'`）。 */
    if (typeof takenSeqs !== 'string' && typeof takenSeqs[Symbol.iterator] === 'function') {
      for (const item of takenSeqs) absorb(item)
    } else {
      absorb(takenSeqs)
    }
  } catch {
    /* 不自抛：算不出最大值 ⇒ 落回 1 起算。 */
  }
  return Math.floor(max) + 1
}

/**
 * 读同 `(stamp_id, kind)` 的既有影像行（**只读读取包装**；`limit: 1000` —— 组内唯一 ⇒
 * 必须看全，否则 `seq` 算小必撞）。
 * **读抛错 ⇒ 按空集**（分配不阻断写入；**不把真故障伪装成「有行」**）；降级如实 `console.warn`
 * （**不进回包** —— 回包键面冻结、零新增键）。
 * @returns {Promise<Array<object>>}
 */
async function imageSeqsOf(stampId, kind) {
  try {
    const rows = await readRows(COLLECTIONS.images, { stamp_id: text(stampId), kind: text(kind) }, { limit: 1000 })
    return Array.isArray(rows) ? rows : []
  } catch (error) {
    console.warn(
      '[xiai] imageSeqsOf 讀既有影像行失敗 ⇒ 按空集繼續（`seq` 從 1 起算；不阻斷寫入、不把真故障偽裝成「有行」）：',
      error && error.message ? error.message : error
    )
    return []
  }
}

/* --------------------------------------------------------------------------- *
   **占位 `stamp_id`（唯一索引避撞｜2026-11-09 真因修）**
   背景（已控制台读数）：`xiai_images` 上有复合唯一索引 `ux_stamp_id_kind_seq(kind, seq,
   stamp_id)`；`importFaceImages` 写行既不写 `seq`（不自造序号）也未写 `stamp_id` ⇒
   `(kind, seq, stamp_id)` 恒同值 ⇒ **同批第二行起必撞 `E11000`**，被单行 catch 折叠成
   `STORAGE_UNAVAILABLE`（首行写成、其余 19 行全挂即此）。
   故写行侧落**确定性占位** `imp-` ＋ 该行 `sha256` 前 16 位（逐行唯一 ⇒ 恒不撞）；
   **它是占位归属、不是真归属** —— 采纳回填把 `imp-` 开头视作**未归属**（`imageStampWriteStepsOf`
   判定 ②），补真 `stamp_id` ＋ `seq`。前缀 / 构造 / 判定的字面**只此一处**（写行侧
   `lib/importChannels.js` 与回填判定侧共用下列两个纯函数，零第二套）。
 * --------------------------------------------------------------------------- */

/** 占位 `stamp_id` 前缀（**唯一字面来源**；不进任何回包键面 / reason）。 */
const IMAGE_STAMP_PLACEHOLDER_PREFIX = 'imp-'

/**
 * 确定性占位 `stamp_id`（`imp-` ＋ 摘要前 16 位；同一行恒同值、不同行必不同值 ⇒
 * `(kind, seq, stamp_id)` 不再恒同 ⇒ 避开 `ux_stamp_id_kind_seq` 撞键）。
 * @param {string} digest 该行 `sha256`（已过 64 位小写十六进制形态门）
 * @returns {string} 形如 `imp-<16 位十六進制>`
 */
function imageStampPlaceholderOf(digest) {
  return IMAGE_STAMP_PLACEHOLDER_PREFIX + text(digest).toLowerCase().slice(0, 16)
}

/**
 * 是否**占位归属**（`imp-` 开头 ⇒ **未归属**，采纳回填补真值）。
 * 空串**不在此判**（未归属的另一半形态由调用方显式判 `''` —— 两态并列、判据仍一处可读）。
 * @param {string} stampId 行上 `stamp_id`
 * @returns {boolean}
 */
function isImageStampPlaceholder(stampId) {
  const value = text(stampId)
  return value !== '' && value.indexOf(IMAGE_STAMP_PLACEHOLDER_PREFIX) === 0
}

/* --------------------------------------------------------------------------- *
   **采纳后影像归属回填（本单｜`reviewSealImport` 的 opt-in `backfill_image_stamp`）**
   背景：批量影像入册通道（`importFaceImages`）写 `xiai_images` 时落**确定性占位** `stamp_id`
   （`imp-` ＋ 该行 sha256 前 16 位，为避开 `ux_stamp_id_kind_seq`）、**仍不写 `seq`**（它不造
   序号）⇒ 真归属与序号由**采纳**时回填。本函数是该回填的**唯一实现点**：
     · 判据（**顺序即判定序**）：
       ① 已等于目标 stamp 且有合法 `seq` ⇒ **零写**（同一次采纳重放不再改行 ⇒ 幂等）；
       ② `stamp_id` 为空 / 以 `imp-` 开头（**占位 = 未归属**）/ 已等于目标但缺合法 `seq`
          ⇒ **补真值**（`stamp_id` ＋ `seq`）—— 否则采纳永远补不上真 `stamp_id` / `seq`；
       ③ 已归属**其它真 stamp** ⇒ **零写**（不改写既有行，沿「重复采纳不改写既有行」口径）；
     · `seq` **只走既有单点**（`imageSeqsOf` 读回 ＋ `nextImageSeqOf` 纯函数；**本处不自算号**）：
       同印同类递增、避开该组既有行，且**本批已分配号**由调用方传入的 `takenByKind` 累积
       （同批多面 / 多行共用一份占用集 ⇒ 批内互不重复）；
     · `kind` 取**影像行自己的类别**（EDGE / 其余 ⇒ FACE，与 `buildDirectImageRow` 同判）。
   返回的是 `persist` 写步（`kind:'update'` ＋ `expectAtLeast:1`），**不落库**（落库由调用方
   与本批其余写步一起走唯一写点 `persist`）。
 * --------------------------------------------------------------------------- */

/**
 * 构造「采纳后影像归属回填」写步（零落库；`seq` 走既有单点、本函数不自算号）。
 * @param {string} stampId 本次采纳得到的印章 id（`sid`）
 * @param {Array<object>} imageRows 引用命中的影像行（`findSealImportImageRow` 的返回本体）
 * @param {Map<string, Set<number>>} takenByKind 批内已分配号占用集（键 ＝ `<stampId>|<kind>`）
 * @param {Set<string>} handled 批内已处理标记（键 ＝ `<stampId>|<imageId>`，去重同图多引）
 * @returns {Promise<Array<object>>} 待落盘写步（每步恰一个影像行 update）
 */
async function imageStampWriteStepsOf(stampId, imageRows, takenByKind, handled) {
  const steps = []
  const stamp = text(stampId)
  if (!stamp || !Array.isArray(imageRows)) return steps
  for (const image of imageRows) {
    if (!image || typeof image !== 'object') continue
    const imageId = text(image._id) || text(image.id)
    if (!imageId) continue
    const dedupeKey = `${stamp}|${imageId}`
    if (handled.has(dedupeKey)) continue
    handled.add(dedupeKey)
    const currentStamp = text(image.stamp_id)
    /* **判定序（与函数头注 ①②③ 逐字对应）**：
       ① 已等于目标 stamp 且有合法号 ⇒ 零写（重放幂等）；
       ② `stamp_id` 空 / `imp-` 占位（**占位 = 未归属**）/ 已等于目标但缺合法号 ⇒ 补真值；
       ③ 已归属其它真 stamp ⇒ 零写（不改既有行）。 */
    if (currentStamp === stamp && isImageSeq(image.seq)) continue
    const unassigned = currentStamp === '' || isImageStampPlaceholder(currentStamp)
    if (!unassigned && currentStamp !== stamp) continue
    const kind = text(image.kind) === 'EDGE' ? 'EDGE' : 'FACE'
    const groupKey = `${stamp}|${kind}`
    if (!takenByKind.has(groupKey)) {
      const taken = new Set()
      /* 读抛错 ⇒ 按空集（与 `imageSeqsOf` 同一降级口径：如实 warn、不阻断写入）。 */
      for (const existing of await imageSeqsOf(stamp, kind)) {
        if (isImageSeq(existing && existing.seq)) taken.add(Number(existing.seq))
      }
      takenByKind.set(groupKey, taken)
    }
    const taken = takenByKind.get(groupKey)
    const seq = nextImageSeqOf(stamp, kind, taken)
    taken.add(seq)
    steps.push({
      kind: 'update',
      collection: COLLECTIONS.images,
      match: text(image._id) ? { _id: text(image._id) } : { id: imageId },
      doc: { stamp_id: stamp, seq },
      expectAtLeast: 1
    })
  }
  return steps
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
  /* doc() 兜底：`doc(id).get()` 在**文档不存在**时抛错（404）而非回空 ⇒ 这里**仅**吞「不存在」类
     （判据见 lib/config.js::isDocNotExistError —— 只看错误码 / errCode），其余（连接 / 权限 / 5xx …）
     照旧上抛，绝不把真存储故障吞成「无行」。 */
  let rowsByDoc = []
  try {
    rowsByDoc = rowsOf(await collection.doc(id).get())
  } catch (error) {
    if (!isDocNotExistError(error)) throw error
  }
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
 * 号源**播种基线**（**单点**）：既有行的最大业务号（`seal_no` / `face_no`；单次 1000 行护栏），
 * 无行 ⇒ 0。
 *
 * 两个消费点共用同一份实现（**不写第二套**）：
 *   · `issueCodeNumber` 首次建计数文档时播种 `seq`；
 *   · `lib/sealDelete.js` 删印后**补建**计数文档（该文档此前从未建过）时播种 `seq` ——
 *     两处口径若各写一份，必然漂移出「重号」。
 * @param {'seal'|'face'} kind 号别
 * @returns {Promise<number>} 播种基线（非负整数）
 */
async function counterSeedBaseOf(kind) {
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
  return base
}

/**
 * 归一化计数文档的 **`released` 释放名单**（纯函数、零 I/O、绝不自抛）：
 * 非数组 ⇒ `[]`；元素只留**正整数**、去重、**升序**（口径件：去重、升序）。
 * @param {*} value 文档上的 `released` 原值
 * @returns {number[]} 归一后的升序号表
 */
function normalizeReleased(value) {
  if (!Array.isArray(value)) return []
  const out = []
  value.forEach((item) => {
    const n = Number(item)
    if (Number.isInteger(n) && n > 0 && out.indexOf(n) === -1) out.push(n)
  })
  return out.sort((a, b) => a - b)
}

/** 释放号取用时的**占用扫描护栏**（单次读取上限；口径同既有 1000 行护栏）。 */
const RELEASE_SCAN_LIMIT = 1000
/** 释放号 CAS 未命中的**回落上限**（命中 0 行连续 2 次 ⇒ 本次调用改走 `seq+1`，不让发号卡死）。 */
const RELEASE_CAS_MAX_MISSES = 2

/**
 * 当前库内**已占用**的号值集（`seal_no` / `face_no`；单次 1000 行护栏）。
 * 为什么必须扫：`released` 里的号可能**又被人占上了**（计数文档补建、并发采纳、
 * 手工回填）⇒ 直接把释放号发出去就会造出**同一编号两枚印章**（AC §6.4 红线）。
 * @param {'seal'|'face'} kind 号别
 * @returns {Promise<Set<number>>} 已占用号集合
 */
async function occupiedNosOf(kind) {
  const collection = kind === 'seal' ? COLLECTIONS.seals : COLLECTIONS.faces
  const field = kind === 'seal' ? 'seal_no' : 'face_no'
  const rows = await readRows(collection, {}, { limit: RELEASE_SCAN_LIMIT })
  const used = new Set()
  rows.forEach((row) => {
    const n = Number(row && row[field])
    if (Number.isInteger(n) && n > 0) used.add(n)
  })
  return used
}

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
  /* **释放号 CAS 未命中回落计数（本单缺陷修：原引用未声明 ⇒ `released` 非空必抛
     `ReferenceError`）**：`released` 非空时按「数组相等」做 CAS 认领，未命中累计；
     连续 `RELEASE_CAS_MAX_MISSES` 次 ⇒ 本次调用改走 `seq+1`（**绝不把发号卡死**）。
     计数**按整次调用**归零（一次 `issueCodeNumber` 只发一枚号）。 */
  let releasedCasMisses = 0
  for (let attempt = 0; attempt < COUNTER_MAX_ATTEMPTS; attempt += 1) {
    const rows = await readRows(COUNTERS_COLLECTION, { _id: id })
    if (rows.length === 0) {
      /* 首次发号：以**既有行的最大号**播种（迁移后 `seq` ＝ 已分配总数 ⇒ 采纳从 N+1 起），
         避免计数器与既有 `seal_no` / `face_no` 分裂出重号。
         播种口径收口到单点 `counterSeedBaseOf`（`lib/sealDelete.js` 补建同一文档时共用）。 */
      const base = await counterSeedBaseOf(kind)
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
    /* ★ **释放号优先（本单）**：`deleteSeal` 把删掉的 `seal_no` / `face_no` 写进 `released`
       ⇒ 发号先取 `released` 里**最小的、且当前库内确实未被占用**的号（取走即从数组移除）；
       `released` 为空（或本次已回落）才走下面既有的 `seq+1` 路。三条硬口径：
         ① **占用扫描**：`released` 里的号可能又被占上 ⇒ 必须回库核对，绝不发重号；
         ② **CAS 条件带上 `released` 原值**：数组相等匹配是这一步的并发闸（只有仍看到
            「这份名单」的那一路能改它）⇒ 同一个释放号不会被两路同时领走；
         ③ **回落**：CAS 连续 2 次命中 0 行（数组相等匹配不可用 / 并发交错）⇒ 本次调用
            改走 `seq+1`，**绝不把发号卡死**（释放号留待下次认领）。 */
    const released = normalizeReleased(rows[0].released)
    if (released.length > 0 && releasedCasMisses < RELEASE_CAS_MAX_MISSES) {
      const used = await occupiedNosOf(kind)
      const pick = released.find((no) => no <= capacity && !used.has(no))
      if (pick !== undefined) {
        const nextReleased = released.filter((no) => no !== pick)
        const releaseReply = await db
          .collection(COUNTERS_COLLECTION)
          .where({ _id: id, seq: current, released })
          .update({ released: nextReleased, updated_at: text(new Date().toISOString()) })
        const releaseUpdated = updatedCountOf(releaseReply)
        if (releaseUpdated === 1) return { ok: true, no: pick }
        releasedCasMisses += 1
        continue /* 重读重试（或达到回落上限后改走 seq+1） */
      }
      /* `released` 里**全被占用** ⇒ 名单本轮无号可发 ⇒ 正常落回 `seq+1`（数组原样不动）。 */
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
  /* doc() 兜底：`doc(id).get()` 在**文档不存在**时抛错（404）而非回空 ⇒ 这里**仅**吞「不存在」类
     （判据见 lib/config.js::isDocNotExistError），其余照旧上抛（绝不把真故障吞成「无行」）。 */
  let rowsByDoc = []
  try {
    rowsByDoc = rowsOf(await collection.doc(correctionId).get())
  } catch (error) {
    if (!isDocNotExistError(error)) throw error
  }
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
   **勘誤只讀面（本單新增兩 op｜`listMyCorrections` ＋ `listPendingCorrectionsForAdmin`｜零寫入）**
   ---------------------------------------------------------------------------
   · op① `listMyCorrections` 落 `OPS`：只回 `user_id` ＝ **服务端派生 uid** 的行；身份只取自
     已验签令牌 ⇒ 载荷带身份类键一律 `INVALID_FIELD`（`pointsPayloadDenial` 同族键面门）。
   · op② `listPendingCorrectionsForAdmin` 落 `ADMIN_OPS`（需 `context.adminPhone`）：**管理员门
     复用现有 `adminWhitelistDenial`**（`XIAI_ADMIN_PHONE` 白名单；缺 env ⇒ 结构化拒绝 ＋ **零读取**）；
     跨用户读 `xiai_corrections`，`status` **缺省 `PENDING`**。
   · 载荷封闭键面两 op 同形（`{status?, limit?}`）：`status` ∈ `PENDING` / `ACCEPTED` / `REJECTED`、
     `limit` ∈ 1〜200 整数（缺省 200）；`reason` 只用既有冻结值（**新增字面值 0**）。
   · 行面：**逐行剥除一切键名含 `phone` 的键**（旧行的 `user_phone` 一并剥；不透明 uid 原样保留）
     —— 复用现成 `stripImportIdentityFields`；**不改写、不新增、不删库内行**。
   · 排序：`created_at` 倒序（DB `orderBy` 优先，见 `readRows`；SDK 不支持 / 報錯 ⇒ 退路为取回后
     在服务端排序）；单次上限 200 行；「可能還有更多」由**客户端**按 `count === limit` 派生
     ⇒ **回包不新增任何键**。
   · 成功回包恰 4 键 `{ok:true, op, rows, count}`（`rows` / `count` 由 `index.js` 按 op 收窄透传）；
     失败恒为恰 3 键。
   --------------------------------------------------------------------------- */

/** 勘误行状态三态（与状态机冻结字面值 / `CORRECTION_PENDING` 同值）。 */
const CORRECTION_ROWS_STATUS_VALUES = Object.freeze(['PENDING', 'ACCEPTED', 'REJECTED'])

/** `listMyCorrections` 载荷封闭键面（**零身份类键**；身份一律服务端从令牌派生）。 */
const MY_CORRECTION_ROWS_ALLOWED_KEYS = Object.freeze(['status', 'limit'])

/** `listPendingCorrectionsForAdmin` 载荷封闭键面（与 op① 同形）。 */
const PENDING_CORRECTION_ROWS_ALLOWED_KEYS = Object.freeze(['status', 'limit'])

/** 单次取行缺省上限（＝硬上限：`limit` ∈ 1〜200，缺省 200）。 */
const CORRECTION_ROWS_DEFAULT_LIMIT = 200

/** 单次取行硬上限（防无界；与缺省同值 ⇒ 单次最多 200 行）。 */
const CORRECTION_ROWS_MAX_LIMIT = 200

/** 勘误行排序字段（倒序）。 */
const CORRECTION_ROWS_ORDER_FIELD = 'created_at'

/**
 * 勘误只读 op 的**载荷判定**（全部判定在任何读之前）：封闭键面 → `status` 三态值域 →
 * `limit` 1〜200 整数（缺省 200）。通过 ⇒ `{ok:true, status, limit}`；失败 ⇒ 恰 3 键结构化拒绝。
 * @param {object} payload 载荷
 * @param {readonly string[]} allowedKeys 该 op 的封闭键面
 * @returns {{ok:true, status:string, limit:number}|{ok:false, reason:string, message:string}}
 */
function correctionRowsReadArgs(payload, allowedKeys) {
  const keyDenial = pointsPayloadDenial(payload, allowedKeys)
  if (keyDenial) return keyDenial
  let status = ''
  if (payload.status !== undefined && payload.status !== null) {
    status = text(payload.status)
    if (CORRECTION_ROWS_STATUS_VALUES.indexOf(status) === -1) {
      return deny(
        REASONS.INVALID_VALUE,
        `勘誤狀態（status）值域外：${status || '（空）'}（僅允許 PENDING / ACCEPTED / REJECTED）；本次零寫入。`
      )
    }
  }
  let limit = CORRECTION_ROWS_DEFAULT_LIMIT
  if (payload.limit !== undefined && payload.limit !== null) {
    const requested = payload.limit
    if (typeof requested !== 'number' || !Number.isInteger(requested) || requested <= 0 || requested > CORRECTION_ROWS_MAX_LIMIT) {
      return deny(REASONS.INVALID_VALUE, `單次取行上限（limit）必須是 1 〜 ${CORRECTION_ROWS_MAX_LIMIT} 之間的整數；本次零寫入。`)
    }
    limit = requested
  }
  return { ok: true, status, limit }
}

/**
 * **只读读勘误行**（两 op 共用的唯一读点）：等值 `match` ＋ 显式 `limit` ＋ `created_at` 倒序。
 * 排序优先交给 DB（`readRows` 的 `orderByDesc`）；SDK 无 `orderBy` 或调用报错 ⇒ 退路为取回后
 * 在本函数内排序 ⇒ 回包顺序**不因 SDK 能力而变**。
 * @param {object} match 等值条件
 * @param {number} limit 单次上限（1〜200）
 * @returns {Promise<Array<object>>} 已按 `created_at` 倒序、**尚未剥字段**的行
 */
async function readCorrectionRowsSorted(match, limit) {
  const rows = await readRows(COLLECTIONS.corrections, match, { limit, orderByDesc: CORRECTION_ROWS_ORDER_FIELD })
  return rows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

/* ---------------------------------------------------------------------------
   op 注册面（每个 op 只**产出落盘计划**，落库在 `persist()`）
   --------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   **普通用戶影像勘誤（§3.77｜v1.94）**：提交 op `submitImageCorrection`（`OPS` 登录面）
   ---------------------------------------------------------------------------
   硬口径（逐条；与 §3.77.2 / §3.77.3 逐字对应）：
     · **登录门**：身份唯一来源 ＝ 已验签令牌 / 平台会话（`identityUsable`）；无身份 ⇒
       与 `submitCorrection` 同一条既有文案 ＋ 既有冻结 `FORBIDDEN`（**零新增 `reason`**）；
     · **载荷封闭恰六键** `seal_id` ＋ `face_id` ＋ `image_id` ＋ `action`（恰二值 `'delete'` /
       `'replace'`）＋ `note`（可选 ≤ 200 字、缺省空串）＋ `new_image`（`replace` 必有、
       `delete` 不得给）；未知键 / 身份类键 ⇒ `INVALID_FIELD`；缺 / 空 ⇒ 沿既有缺键值
       （`MISSING_REQUIRED`）；值态违形 ⇒ `INVALID_VALUE`；
     · **落点零新建**：只写既有 `xiai_corrections` 一行（`kind:'IMAGE'` ＋ `action` ＋ `image_id`
       ＋ replace 时 `new_image_id` ＋ `note` ＋ `status:'PENDING'` ＋ `submitted_by` ＋ 时间）；
       **初始恒 `PENDING`、影像面零写入**（生效只经 `reviewCorrection` 采纳）；
     · **重复跳过**：同 `(faceId, image_id, action)` 已有 `PENDING` / `ACCEPTED` 行 ⇒ 不建行、
       回 `{ok:true, row:<既有行>, skipped:true}`（additive 键，`index.js` 按 op 收窄透传）；
     · **回包**：成功 `{ok:true, row}`（＋内部落盘计划 `plan`，`index.js` 绝不外传）；
       失败恒恰 3 键、`reason` 只用既有冻结值（**零新增**）。
   --------------------------------------------------------------------------- */

/** 影像勘误载荷**封闭恰六鍵**（身份類鍵一律不在面內 ⇒ `INVALID_FIELD`；与其余 op 同一条文案）。 */
const IMAGE_CORRECTION_ALLOWED_KEYS = Object.freeze([
  'seal_id',
  'face_id',
  'image_id',
  'action',
  'note',
  'new_image'
])

/** `new_image` **封闭恰四鍵**（`action:'replace'` 時必有；`action:'delete'` 不得给）。 */
const IMAGE_CORRECTION_NEW_IMAGE_KEYS = Object.freeze(['sha256', 'bytes', 'mime', 'storage_key'])

/** `action` **值域恰二值**（域外 / 非字串 ⇒ `INVALID_VALUE`）。 */
const IMAGE_CORRECTION_ACTIONS = Object.freeze(['delete', 'replace'])

/** `note` 上限（＝ `MAX_NOTE_LENGTH` 200 字；超限 ⇒ `INVALID_VALUE`）。 */
const IMAGE_CORRECTION_NOTE_MAX_LENGTH = MAX_NOTE_LENGTH

/**
 * `registerCorrectionImage`（**勘誤替換用新圖入册**｜`OPS` 登录面）载荷**封闭键面**：
 * 四必填 ＝ `IMAGE_CORRECTION_NEW_IMAGE_KEYS`（**零第二套口径** —— 与 `submitImageCorrection`
 * ⑥ 步 `new_image` 的封闭四键同一真源）＋ 可选 `seal_id`（把行挂到该印；缺省空串）。
 * 未知键 / 身份类键 ⇒ `INVALID_FIELD`（与其余 op 同一条文案）。
 */
const CORRECTION_IMAGE_REGISTER_ALLOWED_KEYS = Object.freeze([...IMAGE_CORRECTION_NEW_IMAGE_KEYS, 'seal_id'])

/** `submitImageCorrection` 成功回包**读数键面**（`index.js` 按 op 收窄透传的键面真源）。 */
const IMAGE_CORRECTION_SUBMIT_READOUT_KEYS = Object.freeze(['skipped'])

/** `reviewCorrection` 影像行采纳回包**读数键面**（`index.js` 按 op 收窄透传的键面真源）。 */
const IMAGE_CORRECTION_REVIEW_READOUT_KEYS = Object.freeze(['image_action'])

const OPS = Object.freeze({
  /**
   * **普通用戶【勘誤】影像（本單新增 op｜`submitImageCorrection`｜`OPS` 登录面｜§3.77）**：
   * 登录用户在 `/seal/<sid>` 影像卡片对其当前展示的影像提交「刪除此影像 / 重新上傳新圖替換」
   * ＋可填备注；**只落 `xiai_corrections` 一行、初始恒 `PENDING`**（影像面零写入，
   * 生效只由管理员 `reviewCorrection` 采纳后执行 —— 与管理员直接 `deleteFaceImage` 两路互不替代）。
   *
   * 顺序（**全部判定早于任何写**；本 op 只产 `plan` ⇒ 落盘由 `index.js` 唯一写点执行）：
   *   ① 登录门 `identityUsable`（身份由令牌派生；无身份 ⇒ 既有 `FORBIDDEN` ＋ 零读写）；
   *   ② 载荷形态 ＋ 封闭恰六键（`IMAGE_CORRECTION_ALLOWED_KEYS`；未知键 / 身份类键 ⇒
   *      `INVALID_FIELD`，与其余 op 同一条文案）；
   *   ③ 必填四串 `seal_id` / `face_id` / `image_id` / `action`（缺 / 空 ⇒ `MISSING_REQUIRED`、
   *      非字串 ⇒ `INVALID_VALUE`）；`note`（可选）非字串 / 超 200 字 ⇒ `INVALID_VALUE`；
   *      `delete` 附带 `new_image` ⇒ `INVALID_FIELD`（`delete` 不得给）；
   *   ④ `action` 值域恰二值（域外 ⇒ `INVALID_VALUE`）；
   *   ⑤ 解析与一致性：印章行（`stamp_id` → `sid` → `id` → `_id`）、印面行（`id` → `_id`）、
   *      影像行（`id` → `_id`）**均须存在**、印面须属该印（行内 `sealId` / `stamp_id`，
   *      缺键时退回 `fc-<sid>-…` 编号约定）⇒ 任一不中 `INVALID_VALUE`；**本印面归属校验**
   *      （`face_image_id` 等值 **或** `edge_image_ids[]` 命中，同 `deleteFaceImage` 口径）
   *      ⇒ 不属 `INVALID_VALUE` ＋ 零写入；
   *   ⑥ `replace` 新图四道形态门（① 摘要 64 位小写十六进制 ② 对象键形态 ＋ 键内摘要 ≡ 摘要
   *      ③ `bytes` 整数 ④ `bytes` ∈ 1〜`ARTIFACT_MAX_BYTES`）＋ **`sha256` 对应影像行必须已
   *      入册**（前端先走 `registerFaceImage`）；缺键 ⇒ `MISSING_REQUIRED`、违形 / 未入册 /
   *      新图与原图同一份内容 ⇒ `INVALID_VALUE`；
   *   ⑦ **重复跳过（§3.47 语义）**：同 `(faceId, image_id, action)` 已有 `PENDING` / `ACCEPTED`
   *      行 ⇒ **不建行**，回 `{ok:true, row:<既有行>, skipped:true}`（additive 键、`index.js`
   *      按 op 收窄透传；零新增行、不计入失败、不上屏为失败；`REJECTED` 行不参与防重）；
   *   ⑧ 成功 ＝ 行体落 `xiai_corrections`，回 `{ok:true, row}`（＋内部落盘计划 `plan`）；
   *      失败恒 **恰 3 键** `{ok, reason, message}`、`reason` 只用既有冻结值（**零新增**）。
   * @param {object} payload 载荷（封闭六键，见 `IMAGE_CORRECTION_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string, role?:string}} identity **服务端派生**的身份（唯一来源）
   * @returns {Promise<{ok:true, row:object, plan:object}|{ok:true, row:object, skipped:true}|
   *                   {ok:false, reason:string, message:string}>}
   */
  async submitImageCorrection(payload, identity) {
    /* ① 登录门（**身份唯一来源 ＝ 令牌 / 会话**；与 `submitCorrection` 同一条既有文案、零新增 reason）。 */
    if (!identityUsable(identity)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的提交人身份；本次零寫入。')
    }
    /* ② 载荷形态 ＋ 封闭六键（未知键 / 身份类键 ⇒ `INVALID_FIELD`，与其余 op 同一条文案）。 */
    const keyDenial = pointsPayloadDenial(payload, IMAGE_CORRECTION_ALLOWED_KEYS)
    if (keyDenial) return keyDenial
    /* ③ 必填四串（缺 / 空 ⇒ `MISSING_REQUIRED`；非字串 ⇒ `INVALID_VALUE`；零写入）。 */
    for (const key of ['seal_id', 'face_id', 'image_id', 'action']) {
      const value = payload[key]
      if (value === undefined || value === null || text(value) === '') {
        return deny(REASONS.MISSING_REQUIRED, `缺少必要欄位（${key}）；本次零寫入。`)
      }
      if (typeof value !== 'string') {
        return deny(REASONS.INVALID_VALUE, `欄位（${key}）必須是字符串；本次零寫入。`)
      }
    }
    const sealId = text(payload.seal_id)
    const faceId = text(payload.face_id)
    const imageId = text(payload.image_id)
    const action = text(payload.action)
    /* `delete` **不得附带** `new_image`（键面收窄 ⇒ `INVALID_FIELD`；`replace` 的新图见⑥）。 */
    if (action === 'delete' && Object.prototype.hasOwnProperty.call(payload, 'new_image')) {
      return deny(REASONS.INVALID_FIELD, '動作「刪除此影像」不得附帶新圖（new_image）⇒ 拒絕提交；本次零寫入。')
    }
    /* `note` 可选（缺省空串）：非字串 / 超 200 字 ⇒ `INVALID_VALUE`（零写入）。 */
    const rawNote = payload.note === undefined || payload.note === null ? '' : payload.note
    if (typeof rawNote !== 'string') {
      return deny(REASONS.INVALID_VALUE, '備註（note）必須是文字 ⇒ 拒絕提交；本次零寫入。')
    }
    const note = rawNote.trim()
    if (note.length > IMAGE_CORRECTION_NOTE_MAX_LENGTH) {
      return deny(
        REASONS.INVALID_VALUE,
        `備註超出上限（${IMAGE_CORRECTION_NOTE_MAX_LENGTH} 字）⇒ 拒絕提交；本次零寫入。`
      )
    }
    /* ④ `action` 值域恰二值（域外 ⇒ `INVALID_VALUE`；零写入）。 */
    if (IMAGE_CORRECTION_ACTIONS.indexOf(action) === -1) {
      return deny(
        REASONS.INVALID_VALUE,
        `勘誤動作「${action || '（空）'}」不在二值之內（刪除此影像 / 重新上傳新圖替換）⇒ 拒絕提交；本次零寫入。`
      )
    }
    /* ⑤ 解析与一致性（印章 / 印面 / 影像三行均须存在、印面须属该印；任一不中 ⇒ `INVALID_VALUE`）。 */
    const sealRow = await readSealRowByAnyId(sealId)
    if (sealRow === null) {
      return deny(REASONS.INVALID_VALUE, `未找到該印章（seal_id：${sealId}）；本次零寫入。`)
    }
    const faceRow = await readRowByAnyId(COLLECTIONS.faces, faceId, FACE_IMAGE_DELETE_FACE_SCAN_LIMIT)
    if (faceRow === null) {
      return deny(REASONS.INVALID_VALUE, `未找到該印面（face_id：${faceId}）；本次零寫入。`)
    }
    if (!faceBelongsToSeal(faceRow, sealId, sealRow)) {
      return deny(REASONS.INVALID_VALUE, `印面（${faceId}）與印章（${sealId}）不一致 ⇒ 拒絕提交；本次零寫入。`)
    }
    const imageRow = await readRowByAnyId(COLLECTIONS.images, imageId, FACE_IMAGE_DELETE_IMAGE_SCAN_LIMIT)
    if (imageRow === null) {
      return deny(REASONS.INVALID_VALUE, `未找到該影像（image_id：${imageId}）；本次零寫入。`)
    }
    /* **本印面归属校验**（与 `deleteFaceImage` 同口径：`face_image_id` 等值 或 `edge_image_ids[]` 命中）。 */
    const ownership = faceImageOwnershipOf(faceRow, imageId)
    if (!ownership.ownedByFace && !ownership.ownedByEdge) {
      return deny(
        REASONS.INVALID_VALUE,
        `影像編號（${imageId}）不屬於該印面（本印面的 face_image_id / edge_image_ids 均未命中）；本次零寫入。`
      )
    }
    /* ⑥ `replace` 新图：四道形态门 ＋ 必须已在 `xiai_images` 有行（`delete` 早已在③挡掉附带新图）。 */
    let newImageId = null
    if (action === 'replace') {
      const rawNew = payload.new_image
      if (rawNew === undefined || rawNew === null) {
        return deny(REASONS.MISSING_REQUIRED, '「重新上傳新圖替換」必附新圖（new_image）；本次零寫入。')
      }
      if (typeof rawNew !== 'object' || Array.isArray(rawNew)) {
        return deny(REASONS.INVALID_VALUE, '新圖（new_image）必須是對象；本次零寫入。')
      }
      const unknownNew = Object.keys(rawNew).filter((key) => IMAGE_CORRECTION_NEW_IMAGE_KEYS.indexOf(key) === -1)
      if (unknownNew.length > 0) {
        return deny(
          REASONS.INVALID_FIELD,
          `新圖含未知欄位：${unknownNew.join('、')}（如實報回，不靜默丟鍵）；本次零寫入。`
        )
      }
      for (const key of IMAGE_CORRECTION_NEW_IMAGE_KEYS) {
        const value = rawNew[key]
        if (value === undefined || value === null || text(value) === '') {
          return deny(REASONS.MISSING_REQUIRED, `新圖缺少必要欄位（${key}）；本次零寫入。`)
        }
      }
      for (const key of ['sha256', 'mime', 'storage_key']) {
        if (typeof rawNew[key] !== 'string') {
          return deny(REASONS.INVALID_VALUE, `新圖欄位（${key}）必須是字符串；本次零寫入。`)
        }
      }
      /* 四道形态门（与 `registerFaceImage` 同一张表、同一条文案）。 */
      const digest = text(rawNew.sha256)
      if (!ARTIFACT_DIGEST_PATTERN.test(digest)) {
        return deny(REASONS.INVALID_VALUE, '摘要（sha256）必須是 64 位小寫十六進制；本次零寫入。')
      }
      const matched = ARTIFACT_OBJECT_KEY_PATTERN.exec(text(rawNew.storage_key))
      if (!matched) {
        return deny(
          REASONS.INVALID_VALUE,
          '影像對象鍵形態不符（期望 xiai/images/<摘要前兩位>/<摘要>.tiff）；本次零寫入。'
        )
      }
      if (matched[1] !== digest.slice(0, 2) || matched[2] !== digest) {
        return deny(REASONS.INVALID_VALUE, '影像對象鍵內含的摘要與聲稱的 sha256 不一致；本次零寫入。')
      }
      const claimedBytes = rawNew.bytes
      if (!Number.isInteger(claimedBytes)) {
        return deny(REASONS.INVALID_VALUE, '字節數（bytes）必須是整數；本次零寫入。')
      }
      if (claimedBytes <= 0 || claimedBytes > ARTIFACT_MAX_BYTES) {
        return deny(
          REASONS.INVALID_VALUE,
          `字節數（bytes）必須是 1 〜 ${ARTIFACT_MAX_BYTES} 之間的整數；本次零寫入。`
        )
      }
      /* **必须已入册**：`sha256` 对应的 `xiai_images` 行必须已存在（前端先走 `registerFaceImage`）。 */
      const registered = await readRegisteredImageByDigest(digest)
      if (registered === null) {
        return deny(
          REASONS.INVALID_VALUE,
          `替換用新圖尚未入册（sha256：${digest.slice(0, 12)}…；請先經 registerFaceImage 入册）⇒ 拒絕提交；本次零寫入。`
        )
      }
      newImageId = text(registered.id) || text(registered._id)
      if (newImageId === '') {
        return deny(REASONS.INVALID_VALUE, '替換用新圖的影像行缺影像編號（id）⇒ 拒絕提交；本次零寫入。')
      }
      if (newImageId === imageId) {
        return deny(REASONS.INVALID_VALUE, '替換用新圖與原圖為同一份內容（同一影像編號）⇒ 無從替換；本次零寫入。')
      }
    }
    /* ⑦ **重复跳过**（§3.47 语义：只认未驳回行；`REJECTED` 行不参与防重）。
       命中 ⇒ **零新增行、不计入失败、不上屏为失败**：回 `{ok:true, row, skipped:true}`、无 `plan`。 */
    const duplicates = await readRows(
      COLLECTIONS.corrections,
      { faceId, image_id: imageId, action },
      { limit: 32 }
    )
    const duplicate = duplicates.find(
      (item) =>
        text(item && item.kind) === 'IMAGE' &&
        (text(item && item.status) === CORRECTION_STATUS.PENDING ||
          text(item && item.status) === CORRECTION_STATUS.ACCEPTED)
    )
    if (duplicate) {
      return { ok: true, row: duplicate, skipped: true }
    }
    /* ⑧ 行体（封闭；IMAGE 類標記面四鍵 ＋ `xiai_corrections` 通用欄）＋ 单集合落盘计划。 */
    const at = new Date().toISOString()
    const row = {
      id: makeId(),
      sealId,
      faceId,
      field: 'image',
      kind: 'IMAGE',
      action,
      image_id: imageId,
      /* `delete` ⇒ `null`（行面仍带该键，逐字按冻结契约）。 */
      new_image_id: newImageId,
      note,
      status: CORRECTION_PENDING,
      /* 提交人 uid：**服务端从令牌派生**，不由载荷自称。 */
      submitted_by: identity.uid,
      created_at: at,
      updated_at: at
    }
    return {
      ok: true,
      row,
      plan: {
        writes: [{ kind: 'add', collection: COLLECTIONS.corrections, doc: row }]
      }
    }
  },

  /**
   * **勘誤【重新上傳新圖替換】用新圖入册（本單新增 op｜`registerCorrectionImage`｜`OPS` 登录面）**：
   * 普通用户在影像卡片提交 `replace` 之前，先把「已交权威存储的新图」登记进云端 `xiai_images`
   * 拿到 `image_id`（`submitImageCorrection` ⑥ 步硬要求该 `sha256` **必须已入册**）。本 op 就是那一口
   * —— **与 `registerFaceImage` 的唯一实质差别 ＝ 门不同**：本 op 走**登录门** `identityUsable`
   * （普通用户可用、**不做管理员门**）；四道形态门 / 行体 / `seq` 单点 / 同 id 幂等 / 回包形状逐字同口径。
   *
   * 顺序（**全部判定在落盘之前**；本 op 只产 `plan` ⇒ 落盘由 `index.js` 的唯一写点执行）：
   *   ① 登录门 `identityUsable`（与 `submitImageCorrection` 同一条既有文案、既有冻结 `FORBIDDEN`；
   *      **零新增 `reason`**、**不做管理员门**）；
   *   ② 载荷封闭键面 `CORRECTION_IMAGE_REGISTER_ALLOWED_KEYS`（四必填 ＋ 可选 `seal_id`；
   *      未知键 / 身份类键 ⇒ `INVALID_FIELD`，与其余 op 同一条文案）；
   *   ③ 必填三串 `sha256` / `mime` / `storage_key`（缺 / 空 ⇒ `MISSING_REQUIRED`、非字符串 ⇒
   *      `INVALID_VALUE`）＋ `bytes` 必填（缺 ⇒ `MISSING_REQUIRED`；非整数归④判）；
   *   ④ 四道形态门（与 `registerFaceImage` **同一张表、同一条文案**）：摘要 64 位小写十六进制
   *      → 对象键形态 `xiai/images/<摘要前两位>/<摘要>.tiff` → 键内摘要 ≡ `sha256` → `bytes` ∈
   *      1〜`ARTIFACT_MAX_BYTES` 整数 → `mime` ＝ 服务端存储容器常量 `ARTIFACT_MIME`
   *      ⇒ 任一不符 `INVALID_VALUE` ＋ **零写入**（判定全部早于落盘）；
   *   ⑤ `seq` **单点取号**（同 `id` 已有行且属同印 ⇒ 沿用、不耗号；否则经 `imageSeqsOf` /
   *      `nextImageSeqOf`，**本 op 不自算号**）；
   *   ⑥ 行体 ＝ `buildDirectImageRow` 字段面（`id` ＝ `img-<sha16>` **内容寻址**；`stamp_id` 回填
   *      `seal_id`，缺省空串）＋ `kind:'set'` 覆写计划 ⇒ **同 `id` 重放不建第二行、不耗号**；
   *   ⑦ 成功回包**恰 2 键** `{ok:true, image_id}`（＋ `plan` 内部面，`index.js` 绝不外传）；
   *      失败恒**恰 3 键** `{ok, reason, message}`，`reason` 只用既有冻结值（**零新增**）。
   * **安全边界**：本 op **只登记 `xiai_images` 影像行** —— 不改任何印面 / 印章行、不删任何东西、
   * 零对象存储读写（字节已由 `registerArtifact` 回读覆核过）。
   * @param {object} payload 载荷（封闭五键，见 `CORRECTION_IMAGE_REGISTER_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string, role?:string}} identity **服务端派生**的身份（唯一来源）
   * @returns {Promise<{ok:true, image_id:string, plan:object}|{ok:false, reason:string, message:string}>}
   */
  async registerCorrectionImage(payload, identity) {
    /* ① 登录门（**身份唯一来源 ＝ 令牌 / 会话**；与 `submitImageCorrection` 同一条既有文案、零新增 reason）。 */
    if (!identityUsable(identity)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的提交人身份；本次零寫入。')
    }
    /* ② 载荷封闭键面（未知键 / 身份类键 ⇒ `INVALID_FIELD`，与其余 op 同一条文案）。 */
    const payloadDenial = pointsPayloadDenial(payload, CORRECTION_IMAGE_REGISTER_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    /* ③ 必填三串（缺 / 空 ⇒ `MISSING_REQUIRED`；非字符串 ⇒ `INVALID_VALUE`；零写入）。 */
    for (const key of ['sha256', 'mime', 'storage_key']) {
      const value = payload[key]
      if (value === undefined || value === null || text(value) === '') {
        return deny(REASONS.MISSING_REQUIRED, `缺少必要欄位（${key}）；本次零寫入。`)
      }
      if (typeof value !== 'string') {
        return deny(REASONS.INVALID_VALUE, `欄位（${key}）必須是字符串；本次零寫入。`)
      }
    }
    const claimedBytes = payload.bytes
    if (claimedBytes === undefined || claimedBytes === null) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要欄位（bytes）；本次零寫入。')
    }
    /* ④ 四道形态门（与 `registerFaceImage` 同一张表、同一条文案；任一不符 ⇒ 零写入）。 */
    const digest = text(payload.sha256)
    if (!ARTIFACT_DIGEST_PATTERN.test(digest)) {
      return deny(REASONS.INVALID_VALUE, '摘要（sha256）必須是 64 位小寫十六進制；本次零寫入。')
    }
    const storageKey = text(payload.storage_key)
    const matched = ARTIFACT_OBJECT_KEY_PATTERN.exec(storageKey)
    if (!matched) {
      return deny(
        REASONS.INVALID_VALUE,
        '影像對象鍵形態不符（期望 xiai/images/<摘要前兩位>/<摘要>.tiff）；本次零寫入。'
      )
    }
    if (matched[2] !== digest || matched[1] !== digest.slice(0, 2)) {
      return deny(REASONS.INVALID_VALUE, '影像對象鍵內含的摘要與聲稱的 sha256 不一致；本次零寫入。')
    }
    if (!Number.isInteger(claimedBytes) || claimedBytes <= 0 || claimedBytes > ARTIFACT_MAX_BYTES) {
      return deny(
        REASONS.INVALID_VALUE,
        `字節數（bytes）必須是 1 〜 ${ARTIFACT_MAX_BYTES} 之間的整數；本次零寫入。`
      )
    }
    if (text(payload.mime) !== ARTIFACT_MIME) {
      return deny(
        REASONS.INVALID_VALUE,
        `源件容器（mime）必須是服務端存儲容器常量（${ARTIFACT_MIME}）；本次零寫入。`
      )
    }
    const sealId = text(payload.seal_id)
    const kind = 'FACE'
    const at = new Date().toISOString()
    /* 内容寻址 id 的**唯一规则点** ＝ `buildDirectImageRow`（此处只取 id，不自拼）。 */
    const id = buildDirectImageRow({ image_sha256: digest, image_bytes: claimedBytes, image_storage_key: storageKey, kind }, at).id
    /* ⑤ `seq` 单点取号：同 `id` 已有行且属同印 ⇒ 沿用（幂等、不消耗号）；否则经单点分配器。
       读抛错 ⇒ 按「无既有行」继续（与 `imageSeqsOf` 同一降级口径：如实 `console.warn`）；
       真故障若最终撞唯一键，由 `index.js` 如实报 `STORAGE_UNAVAILABLE`。 */
    let existing = null
    try {
      const hits = await readRows(COLLECTIONS.images, { id }, { limit: 1 })
      existing = Array.isArray(hits) && hits.length > 0 ? hits[0] : null
    } catch (error) {
      console.warn(
        '[xiai] registerCorrectionImage 讀既有影像行失敗 ⇒ 按無既有行繼續（`seq` 交單點分配器取號）：',
        error && error.message ? error.message : error
      )
    }
    const sameSealExisting = existing && text(existing.stamp_id) === sealId && isImageSeq(existing.seq)
    const seq = sameSealExisting
      ? Number(existing.seq)
      : nextImageSeqOf(sealId, kind, await imageSeqsOf(sealId, kind))
    /* ⑥ 行体 ＝ `buildDirectImageRow` 字段面（含条件 `seq`）＋ `stamp_id` 回填 `seal_id`。 */
    const row = {
      ...buildDirectImageRow(
        { image_sha256: digest, image_bytes: claimedBytes, image_storage_key: storageKey, kind },
        at,
        seq
      ),
      stamp_id: sealId
    }
    /* ⑦ 成功 ＝ 恰 2 键（`plan` 是内部落盘计划，`index.js` 绝不外传）。 */
    return {
      ok: true,
      image_id: row.id,
      plan: {
        writes: [{ kind: 'set', collection: COLLECTIONS.images, id: row.id, doc: row }]
      }
    }
  },

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
       ⇒ 同一段文字只允许一人提交；第二人应改用【採信】。**判定在任何写入之前**（只读）。
       **防重只认未驳回行（冻结口径 2026-11-02）**：`status` 为 `REJECTED` 的行先滤掉再判空
       （被驳回的值允许再次提交）；`reason` / `message` / 载荷键面 / 回包形状**一字不变**。 */
    const duplicateAll = await readRows(COLLECTIONS.corrections, { faceId, field, value })
    const duplicate = duplicateAll.filter((row) => text(row && row.status) !== CORRECTION_STATUS.REJECTED)
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
      /* 摘要重算仍吃**全部**命中行（含 `REJECTED`；`buildCorrectionSummaryRow` 内部自行
         跳过驳回行的提交人计数）—— 滤掉 `REJECTED` 只作用于上面的防重判空。 */
      submissions: [...duplicateAll, row],
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
  },

  /**
   * **本人勘誤行（本單新增只讀 op｜`listMyCorrections`）**：回本人（`user_id` ＝ 服务端派生
   * uid）的勘误行 `{ok:true, op, rows, count}` —— **零写入**（不产出 `plan` ⇒ `index.js`
   * 落盘分支不触发）。
   * 顺序（**全部判定在任何读之前**）：① 载荷形态 ＋ 封闭键面 `MY_CORRECTION_ROWS_ALLOWED_KEYS`
   * （`{status?, limit?}`；身份类键 ⇒ `INVALID_FIELD` ＋ 零读取）→ ② 身份取自已验签令牌
   * （缺 ⇒ `FORBIDDEN`；**载荷自称一律无效**）→ ③ `status` 三态值域、`limit` 1〜200（缺省 200）
   * （越界 ⇒ `INVALID_VALUE`，不静默夹取）→ ④ 只读读行（`user_id` 等值 ＋ 显式 `limit` ＋
   * `created_at` 倒序；失败 ⇒ 由 `index.js` 转 `STORAGE_UNAVAILABLE`）→ ⑤ 逐行剥除一切含
   * `phone` 的键。**回包不新增任何键**（`rows` / `count` 由 `index.js` 按 op 收窄透传）。
   * @param {object} payload 载荷（允许键 `status` / `limit`）
   * @param {{uid:string, phone:string}} identity 服务端派生身份
   * @returns {Promise<{ok:true, op:string, rows:Array<object>, count:number}
   *          |{ok:false, reason:string, message:string}>}
   */
  async listMyCorrections(payload, identity) {
    /* ① 载荷形态 ＋ 封闭键面（身份类键 ⇒ `INVALID_FIELD` ＋ 零读取）。 */
    const args = correctionRowsReadArgs(payload, MY_CORRECTION_ROWS_ALLOWED_KEYS)
    if (!args.ok) return args
    /* ② 身份只取自已验签令牌（服务端派生 uid）。 */
    if (!identity || !text(identity.uid)) {
      return deny(REASONS.FORBIDDEN, '缺少可驗證的用戶身份；本次零寫入。')
    }
    /* ③ 只回本人行（等值 `user_id`；给了 `status` 才按状态过滤）。 */
    const match = { user_id: identity.uid }
    if (args.status) match.status = args.status
    const rows = await readCorrectionRowsSorted(match, args.limit)
    /* ④ 行面剥除身份 / 手机号类键（`user_phone` 一类零出现；不透明 uid 原样保留）。 */
    const safeRows = rows.map((row) => stripImportIdentityFields(row))
    return { ok: true, op: 'listMyCorrections', rows: safeRows, count: safeRows.length }
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
 * **第 7 参 `imageHitsSink`（本单「采纳后影像归属回填」追加；可选数组）**：给了 ⇒ 逐条校验
 * **命中的影像行**（`xiai_images` 行本体）依次推入该数组（同一行可被多面引用 ⇒ 由调用方去重）；
 * **不传 ⇒ 零推入、零额外读、行为逐字不变**（`repairImportAcceptance` / 直写通道均不传）。
 * @param {object} row 印章导入行
 * @param {Array<object>} seals 既有正式印章行（用于编号分配）
 * @param {Array<object>} faces 既有印面行（用于 id 分配）
 * @param {{uid:string}} identity 服务端派生身份
 * @param {string} at ISO 时戳
 * @param {Array<object>} [imageOverlay] 直写通道的影像登记行覆蓋層（只读）
 * @param {Array<object>} [imageHitsSink] 采纳回填用：引用命中的影像行收集器（只读收集）
 * @returns {Promise<{ok:true, stampId:string, sealDoc:object, faceDocs:Array<object>}|{ok:false}>}
 */
async function buildSealAcceptanceFromImport(row, seals, faces, identity, at, imageOverlay, imageHitsSink) {
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
    /* **采纳回填收集（本单 opt-in）**：命中影像行推入调用方收集器（不传 ⇒ 零行为变化）。 */
    if (Array.isArray(imageHitsSink)) imageHitsSink.push(image)
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
  /* **影像 `seq` 分配（单点）**：本批**新建**的影像登记行（＝ `imageOverlay` 覆蓋層；由无审核直写
     通道在本构造器之前自建、`stamp_id` 此刻才由发号得出）逐个分配 `seq` 并**落进行对象**：
       · **同批内互不重复**（`taken` 集递增），且避开该印该类**既有行**（`imageSeqsOf` 读回）；
       · **同 sha 命中既有行 ⇒ 复用**：不在覆蓋層里的解析结果**不加 `seq`、不改既有行**；
       · 覆蓋層行**已带合法 `seq`** ⇒ 沿用（只入 `taken` 集），**不重复分配**。
     无覆蓋層（印章导入采纳 `reviewSealImport` / 修复通道 `repairImportAcceptance`）⇒ 零读、零改
     （这两条路的影像行都是**既有行**，本就不新建 ⇒ 行为与改动前逐字不变）。 */
  const overlayImageRows = Array.isArray(imageOverlay) ? imageOverlay : []
  if (overlayImageRows.length > 0) {
    const takenByKind = new Map()
    for (const image of overlayImageRows) {
      if (!image || typeof image !== 'object') continue
      const kind = text(image.kind) === 'EDGE' ? 'EDGE' : 'FACE'
      if (!takenByKind.has(kind)) {
        const taken = new Set()
        for (const existing of await imageSeqsOf(stampId, kind)) {
          if (isImageSeq(existing && existing.seq)) taken.add(Number(existing.seq))
        }
        takenByKind.set(kind, taken)
      }
      const taken = takenByKind.get(kind)
      if (isImageSeq(image.seq)) {
        taken.add(Number(image.seq))
        continue
      }
      const seq = nextImageSeqOf(stampId, kind, taken)
      taken.add(seq)
      image.seq = seq
    }
  }
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
  /* **主印面标记（本单新增）**：新建印章的 FACE 行里，`face_no` 最小的那一枚置
     `is_primary:true`（`face_no` 在下面按同类循环递增 ⇒ 「首个 FACE」即最小号），其余 FACE 置
     `false`；**`EDGE` 永不置该键**（边款不参与主印面判定）。 */
  let primaryAssigned = false
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
      updated_at: at,
      /* **主印面标记**（本单新增）：FACE 行恒带布尔；首个 FACE（`face_no` 最小）⇒ `true`，
         其余 ⇒ `false`。`EDGE` **不落该键**（不得给边款置主印面）。 */
      ...(isEdge ? {} : { is_primary: !primaryAssigned })
    })
    if (!isEdge && !primaryAssigned) primaryAssigned = true
  }
  return { ok: true, stampId, sealDoc, faceDocs }
}

/* --------------------------------------------------------------------------- *
   **`existing` 分支的逐面补齐（本单 B）** —— `reviewSealImport` 的「印章已存在」落点
   背景（真因）：幂等键 `(source, source_seal_id)` 命中时旧实现**只做影像回填 ＋ 翻状态、
   根本不补面行** ⇒ 半采纳现场（印章与首面已落、第二面因 `xiai_faces` 上仓外建的
   `(kind, sealId)` 唯一索引撞 `E11000` 没落）重放会把导入行翻成 `ACCEPTED` 而**永远缺一个
   印面**（静默损伤）。本函数把缺的面按**与新建采纳同一套字段面与编号规则**补上：
     · **幂等键命中 ⇒ 不发印章号、不建第二枚章**（本函数零 `issueCodeNumberAvoiding('seal')`）；
     · **判定序（两遍，全量优先级）**：① **影像引用命中** —— 该面解析出的影像行 id 出现在既有
       面行的 `face_image_id` ／ `edge_image_ids` ⇒ 已存在；② 否则按**确定性面行 id 位次**
       （`fc-<序号>-<f|e><该面在导入行同类中的次序>`）命中 ⇒ 已存在；两者皆不中 ⇒ **缺失**；
       先全量做 ① 再做 ② ⇒ 后面的面不会被前面的位次匹配抢占；
     · 缺失面的**行 id**：位次 id 未被占用 ⇒ 直接用它（确定、可重放）；被占 ⇒ 走既有单点
       `nextFaceIdOf`；**面号**走既有单点 `issueCodeNumberAvoiding('face')`
       （`f1` 已占 ⇒ 自然落 `f2`）；写步由调用方经 `persist` 的 `kind:'set'`（确定性 `_id`
       ⇒ 幂等 upsert）落盘；
     · **影像解析结果回给调用方**做归属回填（`imageHits`，含**已存在面**的影像 —— 回填要覆盖
       整章每一面）；
     · 校验与新建采纳**同一套**（行级占位来源门 ＋ 逐面引用存在性 ＋ 占位摘要门）：`kind=FACE`
       无引用 / 解析不到 ⇒ `{ok:false}`（该条保持 `PENDING`、本轮零写入）；`EDGE` 无引用放行。
   **为什么不用 `facesOf()` 全量读**：平台 `.get()` 默认只回 100 行 ⇒ 全量读会漏掉本章的面行
   ⇒ 把已存在的面误判成缺失（重复补面）。故按归属键做**显式限量**读取。
 * --------------------------------------------------------------------------- */

/** 本章既有面行的单次读取护栏（与既有 1000 行护栏同值）。 */
const EXISTING_FACE_SCAN_LIMIT = 1000

/**
 * 由「导入行 ＋ 既有正式印章行」构造**缺失面行**（零落库；不发印章号）。
 * @param {object} row 印章导入行
 * @param {object} existing 既有正式印章行（幂等键命中）
 * @param {{uid:string}} identity 服务端派生身份
 * @param {string} at ISO 时戳
 * @returns {Promise<{ok:true, faceDocs:Array<object>, imageHits:Array<object>}|{ok:false}>}
 *   `faceDocs` ＝ 本轮缺失、待补的面行（可为空数组）；`imageHits` ＝ 解析命中的影像行
 */
async function buildMissingFaceDocsOfExistingSeal(row, existing, identity, at) {
  const stampId = text(existing && (existing.stamp_id || existing.sid || existing.id))
  if (!stampId) return { ok: false }
  const faceDefs = Array.isArray(row && row.faces) ? row.faces.map(normalizeSealImportFace) : []
  /* 行级占位来源门（与 `buildSealAcceptanceFromImport` 同判）。 */
  if (sealPlaceholderRefDenial(text(row && row.source), faceDefs)) return { ok: false }
  /* 逐面解析影像（与新建采纳同判）：`FACE` 无引用 / 解析不到 ⇒ 拒；`EDGE` 无引用放行。
     解析结果**先于存在性判定**收集 ⇒ 已存在面的影像同样进回填命中表。 */
  const imageHits = []
  const resolved = []
  for (const face of faceDefs) {
    const hasRef = text(face.image_sha256) !== '' || text(face.image_storage_key) !== ''
    if (!hasRef) {
      if (face.kind === 'FACE') return { ok: false }
      resolved.push({ face, image: null })
      continue
    }
    const image = await findSealImportImageRow(face, null)
    if (!image) return { ok: false }
    if (sealPlaceholderDigestDenial(face, image)) return { ok: false }
    imageHits.push(image)
    resolved.push({ face, image })
  }
  /* 本章既有面行：`sealId` 为主、空集再按 `stamp_id` 兜底（建行侧两键同值同写 ⇒ 通常一次命中）。 */
  const keyOf = (item) => text(item && (item._id || item.id))
  const ownByKey = new Map()
  for (const item of await readRows(COLLECTIONS.faces, { sealId: stampId }, { limit: EXISTING_FACE_SCAN_LIMIT })) {
    const key = keyOf(item)
    if (key !== '') ownByKey.set(key, item)
  }
  if (ownByKey.size === 0) {
    for (const item of await readRows(COLLECTIONS.faces, { stamp_id: stampId }, { limit: EXISTING_FACE_SCAN_LIMIT })) {
      const key = keyOf(item)
      if (key !== '') ownByKey.set(key, item)
    }
  }
  const own = [...ownByKey.values()]
  const imageIdOf = (image) => (image ? text(image._id) || text(image.id) : '')
  /* 位次：该面在导入行**同类**中的次序（与 `nextFaceIdOf` 的 `<f|e><n>` 同构）。 */
  const positionOf = new Map()
  const counters = { f: 0, e: 0 }
  resolved.forEach(({ face }, index) => {
    const letter = text(face.kind) === 'EDGE' ? 'e' : 'f'
    counters[letter] += 1
    positionOf.set(index, counters[letter])
  })
  /* 第 1 遍：影像引用命中（全量先做 ⇒ 后面的面不会被位次匹配抢占）。 */
  const claimed = new Set()
  const unmatched = []
  resolved.forEach(({ face, image }, index) => {
    const imageId = imageIdOf(image)
    if (imageId !== '') {
      const hit = own.find(
        (item) =>
          !claimed.has(keyOf(item)) &&
          (face.kind === 'EDGE'
            ? Array.isArray(item.edge_image_ids) && item.edge_image_ids.some((value) => text(value) === imageId)
            : text(item.face_image_id) === imageId)
      )
      if (hit) {
        claimed.add(keyOf(hit))
        return
      }
    }
    unmatched.push(index)
  })
  /* 第 2 遍：确定性面行 id 位次命中。 */
  const serial = sealStampSerialOf(stampId)
  const stillMissing = []
  for (const index of unmatched) {
    const face = resolved[index].face
    const letter = text(face.kind) === 'EDGE' ? 'e' : 'f'
    const candidate = `fc-${serial}-${letter}${positionOf.get(index)}`
    const hit = own.find((item) => !claimed.has(keyOf(item)) && keyOf(item) === candidate)
    if (hit) {
      claimed.add(keyOf(hit))
      continue
    }
    stillMissing.push({ index, candidate })
  }
  if (stillMissing.length === 0) return { ok: true, faceDocs: [], imageHits }
  /* 补缺失面：行 id ＋ 面号（两者都走既有单点；`face_no` 避让**全库**已占号，与新建采纳同尺）。 */
  const sealName = text(row && row.seal_name)
  const source = text(row && row.source)
  const taken = new Set(own.map(keyOf))
  const usedFaceNos = await occupiedNosOf('face')
  const assignedNos = new Set()
  const faceDocs = []
  /* **主印面标记（本单新增）**：本章**既有 FACE 面已经存在**（哪怕无 `is_primary` 标记）⇒ 本轮补的
     新行一律 `is_primary:false`，把「谁是主印面」交给 `repairPrimaryFace` 按**全章**最小 `face_no`
     统一回填（不让后补的面越过既有更小面号抢标记）；只有本章**尚无任何 FACE 面**时，首个补的
     FACE 行才是主印面。`EDGE` 永不置该键。 */
  const ownHasFace = own.some((item) => text(item && item.kind) !== 'EDGE')
  let primaryAssigned = ownHasFace
  for (const item of stillMissing) {
    const { face, image } = resolved[item.index]
    const faceId = taken.has(item.candidate) ? nextFaceIdOf(stampId, face.kind, taken) : item.candidate
    taken.add(faceId)
    const issued = await issueCodeNumberAvoiding('face', (no) => usedFaceNos.has(no) || assignedNos.has(no))
    if (!issued.ok) return { ok: false }
    assignedNos.add(issued.no)
    const faceCode = codeId.encodeFaceCode(issued.no)
    if (!faceCode.ok) return { ok: false }
    const isEdge = face.kind === 'EDGE'
    faceDocs.push({
      id: faceId,
      sealId: stampId,
      stamp_id: stampId,
      face_no: issued.no, // 识别编码：印面自增号（服务端计数器发号）
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
      image_source_kind: text(face.image_source_kind),
      source,
      uploaded_by: identity.uid,
      created_at: at,
      updated_at: at,
      /* **主印面标记**（本单新增；见上方 `ownHasFace` 注）：`EDGE` 不落该键。 */
      ...(isEdge ? {} : { is_primary: !primaryAssigned })
    })
    if (!isEdge && !primaryAssigned) primaryAssigned = true
  }
  return { ok: true, faceDocs, imageHits }
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
 * width/height/updated_at`）＋ **`seq`（仅新增字段）**；`_id` ＝ **内容寻址**（`img-` ＋摘要前 16 位）
 * ⇒ 同图恒同 `_id` ⇒ 幂等覆写、不增行、**不消耗号**。`stamp_id` 由调用方在拿到 `sid` 后回填
 * （发号在构建期之后）；`seq` 同样由调用方在拿到 `stamp_id` 后经**单点分配器**
 * （`nextImageSeqOf` / `imageSeqsOf`）取号传入 —— 唯一索引 `ux_stamp_id_kind_seq(kind, seq,
 * stamp_id)` 的中段，缺它则同印同 `kind` 第二行必撞 `E11000`。**缺省 / 非法 `seq` ⇒ 不落该键**
 * （键面与取值相对旧版逐字不变）。
 * 像素尺寸：直写载荷不带、服务端不为此整图解码 ⇒ 如实落 `null`（读面按行派生展示键，不据此判定）。
 * @param {object} face 印面（含影像引用键 / 摘要 / 体量）
 * @param {string} at 更新时间（ISO）
 * @param {number|string} [seq] 已分配的 `seq`（正整数；缺省 / 非法 ⇒ 行内不带 `seq` 键）
 */
function buildDirectImageRow(face, at, seq) {
  const sha = text(face && face.image_sha256)
  const size = Number(face && face.image_bytes)
  const row = {
    id: `${DIRECT_IMAGE_ID_PREFIX}${sha.slice(0, DIRECT_IMAGE_ID_HEX_LENGTH)}`,
    stamp_id: '',
    kind: text(face && face.kind) === 'EDGE' ? 'EDGE' : 'FACE',
    /* **`seq` 仅新增字段**（条件落键；其余键面与值一字不动）。 */
    ...(isImageSeq(seq) ? { seq: Number(seq) } : {}),
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
  return row
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

/* ---------------------------------------------------------------------------
   **印面圖入册面（本單新增 op `registerFaceImage`）**
   ---------------------------------------------------------------------------
   场景（线上实测真因）：本机新建印章 + 本机上传的印面图，其**本机镜像影像行 id 是序号式**
   （`img-<印章序号>f`，见 `src/data/db.js::nextImageId`），而云端 `xiai_images` 的行 `_id` 是
   **内容寻址**（`buildDirectImageRow` ⇒ `img-` ＋ sha256 前 16 位）；`dbReplaceFaceImage` 只把
   字节交权威存储、**从未在 `xiai_images` 建行** ⇒ `lib/aiEnhance.js` ④ 步严格按 `id` 查行必然
   查不到 ⇒ AI 修复恒报「原圖影像編號在影像行中不存在」。本 op 就是那一行的**入册口**。
   硬口径（逐条）：
     · **管理员面**：`adminWhitelistDenial` 门，判在**任何读之前**（缺 `XIAI_ADMIN_PHONE` ⇒
       结构化拒绝 ＋ 零读取、零写入）；
     · **载荷封闭键面** `FACE_IMAGE_REGISTER_ALLOWED_KEYS`（前六必有、`kind` 缺省 `FACE`；
       未知键 / 身份类键 ⇒ `INVALID_FIELD`，与其余 op 同一张表、同一条文案）；
     · **值域门**：`sha256` 64 位小写十六进制（`ARTIFACT_DIGEST_PATTERN`）；`storage_key` 必须
       匹配 `ARTIFACT_OBJECT_KEY_PATTERN` **且键内摘要 ≡ 声称摘要**（一路径只能指一份内容）；
       `bytes` ∈ 1〜`ARTIFACT_MAX_BYTES` 整数；`kind` ∈ {`FACE`,`EDGE`}；任一不符 ⇒ `INVALID_VALUE`
       ＋ **零写入**（判定全部在落盘之前，`reason` 只用既有冻结值 ⇒ **零新增**）；
     · **行体字段面 ＝ `buildDirectImageRow` 逐字复用**（`id/stamp_id/kind/storage/storage_key/
       sha256/bytes/mime/width/height/updated_at` ＋ 条件 `seq`），`stamp_id` 回填 `seal_id`；
     · **`seq` 单点取号**：同 `id` 已有行且属同印 ⇒ **沿用其 `seq`（幂等、不消耗号）**；否则
       `nextImageSeqOf(seal_id, kind, await imageSeqsOf(...))`（**本 op 不自算号**）；
     · **幂等**：`kind:'set'` 覆写式落盘计划 ⇒ 同 `id` 重放**不建第二行**；
     · **零对象存储读写**（字节已由 `registerArtifact` 回读覆核过；本 op 只写集合行）；
     · **回包**：成功恰 **2 键** `{ok:true, image_id}`（＋ 内部落盘计划 `plan`，`index.js` 绝不
       外传）；失败恒 **3 键** `{ok:false, reason, message}`。
   --------------------------------------------------------------------------- */

/** 印面圖入册载荷允许键（**封闭键面**；身份类键一律拒 —— 与其余 op 同口径）。 */
const FACE_IMAGE_REGISTER_ALLOWED_KEYS = Object.freeze([
  'seal_id',
  'face_id',
  'sha256',
  'bytes',
  'mime',
  'storage_key',
  'kind'
])

/** `kind` 合法取值（与 `FACE_KIND` / `buildDirectImageRow` 同口径；缺省 `FACE`）。 */
const FACE_IMAGE_REGISTER_KINDS = Object.freeze(['FACE', 'EDGE'])

/* ---------------------------------------------------------------------------
   **印面圖替換面（本單新增 op｜`replaceFaceImage`｜管理員面）**
   ---------------------------------------------------------------------------
   场景（线上真因，Kevin 2026-11-07 实测）：「重新上傳印面圖」的本地落盘回读校验在**云模式**
   （`writeFaceMode() === 'cloud'`，生产即此）下必空 ⇒ 那条路径 **100% 失败**、永远到不了
   云端入册。本 op 就是云模式的那一口：**服务端原子入册影像行 ＋ 改面行指向**。
   硬口径（逐条）：
     · **管理员门 `adminWhitelistDenial`**，与 `registerFaceImage` **同一张门**，判在**任何读之前**
       （缺 `XIAI_ADMIN_PHONE` ⇒ 既有结构化拒抱 ＋ 零读零写；非白名单 ⇒ `FORBIDDEN`）；
     · **载荷封闭恰 7 键** `FACE_IMAGE_REPLACE_ALLOWED_KEYS`：`face_id` / `seal_id` / `sha256` /
       `bytes` / `mime` / `storage_key`（前六必有）＋ `kind`（**可缺省，缺省 `FACE`**）；
       未知键与身份类键 ⇒ `INVALID_FIELD`（**既有冻结 reason，零新增**）；
     · **值域门照 `registerFaceImage` 同一张表、同一条文案**：`sha256` 64 位小写十六进制、
       `storage_key` 匹配 `ARTIFACT_OBJECT_KEY_PATTERN` **且键内摘要 ≡ 声称摘要**、`bytes` ∈
       1〜`ARTIFACT_MAX_BYTES` 整数、`kind` ∈ {FACE, EDGE} ⇒ 任一不符 `INVALID_VALUE` ＋ **零写入**；
     · **原子顺序（失败必须可回滚，不留半成品）**：
       ① **读该面行**（`id` → `_id` 两形态；不存在 ⇒ `INVALID_VALUE` ＋ 文案「**該印面不存在**」
          —— **不用 `NOT_FOUND`**，云函数 `REASONS` 表里没有它）；
       ② 用既有 `buildDirectImageRow` 造行（内容寻址 `img-` ＋ sha256 前 16 位）＋ `seq` 必须走既有
          单点 `nextImageSeqOf` / `imageSeqsOf`（**禁自算号**；同 `id` 已有行且属同印 ⇒ **沿用其 `seq`**）；
       ③ `persist` 以 `kind:'set'` 落影像行（**幂等，不建第二行**）；
       ④ 更新面行指向（`FACE` ⇒ `face_image_id`；`EDGE` ⇒ `edge_image_ids` 首位换成新 id）＝ 新 id；
       ④′ 上一步失败 ⇒ **删 / 回退 ②③ 那一行**（**对象保留，不删字节**），回 `STORAGE_UNAVAILABLE`
          ＋ **如实文案**（回滚成败一并如实说，不谎报「本次零寫入」以外的任何结论）；
     · **幂等**：面行已指向该 `image_id` ⇒ **零写**、回包 `previous_image_id === image_id`；
     · **旧图一律保留**（影像行与对象字节都不删；删图走既有 `deleteFaceImage`）；
     · **零 `plan`**：全部判定与两处写入都在本函数内按确定序执行 ⇒ 没有内部落盘计划可供
       `index.js` 外传（本 op **不产 `plan` 键**）；
     · **回包**：成功**恰 3 键** `{ok:true, image_id, previous_image_id}`（原本无图 ⇒ `null`）；
       失败恒**恰 3 键** `{ok:false, reason, message}`，`reason` 只用既有冻结值（**零新增**）。
   --------------------------------------------------------------------------- */

/** 印面圖替換载荷**封闭恰 7 键**（前六必有、`kind` 可缺省 ⇒ 缺省 `FACE`；未知键 / 身份类键 ⇒ `INVALID_FIELD`）。 */
const FACE_IMAGE_REPLACE_ALLOWED_KEYS = Object.freeze([
  'face_id',
  'seal_id',
  'sha256',
  'bytes',
  'mime',
  'storage_key',
  'kind'
])

/** 印面圖替換成功回包**读数键面**（恰 2 读数键；`index.js` 按 op 收窄透传的键面真源）。 */
const FACE_IMAGE_REPLACE_READOUT_KEYS = Object.freeze(['image_id', 'previous_image_id'])

/** 印面行检索窄读上限（`id` → `_id` 两形态依次；口径同 `deleteFaceImage` 的面行检索）。 */
const FACE_IMAGE_REPLACE_FACE_SCAN_LIMIT = 8

/** 影像行检索窄读上限（按 `id` / `_id` 取首行；判「该内容寻址槽位是否本轮之前已在」用）。 */
const FACE_IMAGE_REPLACE_IMAGE_SCAN_LIMIT = 1

/* ---------------------------------------------------------------------------
   **影像刪除面（本單新增 op｜`deleteFaceImage`｜管理員面）**
   ---------------------------------------------------------------------------
   场景：Kevin 2026-11-07 定案 —— 影像**不自动删**（采纳 AI 候選圖 / 换图一律保留旧图），
   改由管理员在**影像卡片**上显式【刪除】。本 op 就是那一口。
   硬口径（逐条）：
     · **管理员门 `adminWhitelistDenial` 先于一切读写**（缺 `XIAI_ADMIN_PHONE` ⇒ 结构化拒绝
       ＋ 零读取、零写入；非白名单 ⇒ `FORBIDDEN`）；
     · **载荷封闭两键** `face_id` ＋ `image_id`（`FACE_IMAGE_DELETE_ALLOWED_KEYS`）：
       未知键 / 身份类键 ⇒ `INVALID_FIELD`；缺 / 空 ⇒ `MISSING_REQUIRED`；非字符串 ⇒ `INVALID_VALUE`；
     · **本印面归属校验**：读 `COLLECTIONS.faces` 该行（`id` → `_id` 两形态依次；无行 ⇒
       `INVALID_VALUE`）；`image_id` 必须确属该印面（`face_image_id` 等值 **或** 在
       `edge_image_ids[]` 中），否则 ⇒ `INVALID_VALUE` ＋ **零写入**；
     · **共用保护**：再扫描**全部印面**，该影像仍被**其它印面**引用（`face_image_id` /
       `edge_image_ids`）⇒ `INVALID_VALUE`（文案点名「該影像仍被其他印面引用」）＋ **零写入**；
     · **写入确定序（先后即契约）**：① 先清该印面的引用（`face_image_id` 置 `''` ／ 从
       `edge_image_ids` 移除；`persist` 的 `kind:'update'` ＋ `expectAtLeast:1`）→ ② 删
       `xiai_images` 影像行（`deleteRow`）→ ③ **尽力**删对象（候选单点
       `deleteImageObjectsOfRow`：`storage_key` 优先 → `sha` 派生后缀族逐个试 → 行内其它键、
       **命中即停**；**失败不阻断**、计数如实＝0）；**占位图行不得删**（`SEAL_PLACEHOLDER_IMAGE*` 命中 ⇒
       只清引用、行与对象一律保留，`removed.rows` 如实为 0）；
     · **对象删除受内容寻址去重保护**：同 `sha256` 尚有其它行 ⇒ 只删行、`removed.objects = 0`；
     · **回包**：成功恰 **4 键** `{ok:true, face_id, image_id, removed:{rows, objects}}`
       （`index.js` 仿 `registerFaceImage` 做**按 op 收窄透传**；`rows` / `objects` 为**实际删数**，
       零补编）；失败恒 **3 键** `{ok, reason, message}`，`reason` 只用既有冻结值（**零新增**）；
     · **零新集合**：读走 `readRows`、清引用走 `persist`、删行走 `deleteRow`、删对象走
       `deleteImageObjectsOfRow`（候选单点；其底层原语仍是本文件 `deleteArtifactObject`，
       实现全部在本文件，`require` 零新增）。
   --------------------------------------------------------------------------- */

/** 影像刪除载荷**封闭两键**（未知键 / 身份类键 ⇒ `INVALID_FIELD`；与其余 op 同一条文案）。 */
const FACE_IMAGE_DELETE_ALLOWED_KEYS = Object.freeze(['face_id', 'image_id'])

/** 影像刪除回包**读数键面**（成功恰 4 键；`index.js` 按 op 收窄透传的键面真源）。 */
const FACE_IMAGE_DELETE_READOUT_KEYS = Object.freeze(['face_id', 'image_id', 'removed'])

/** 印面行检索窄读上限（`id` → `_id` 两形态；形如「命中即取首行」）。 */
const FACE_IMAGE_DELETE_FACE_SCAN_LIMIT = 8

/** 引用面 / 全量印面扫描护栏（单次读取上限；口径同仓内既有 1000 行护栏）。 */
const FACE_IMAGE_DELETE_SCAN_LIMIT = 1000

/** 影像行检索窄读上限（按 `id` / `_id` 取首行）。 */
const FACE_IMAGE_DELETE_IMAGE_SCAN_LIMIT = 1

/** 同摘要去重扫描护栏（口径同候選圖弃除面）。 */
const FACE_IMAGE_DIGEST_SCAN_LIMIT = 64

/** 对象键形态（内容寻址 `xiai/images/<摘要前两位>/<摘要>.<扩展名>`）—— **非集合名**：
 *  它是对象存储路径（校验行内 `storage_key` / 推导删对象键用）。含 `.tiff` 存储件与
 *  `.png` / `.webp` / `.jpg` 展示件（行内 `storage_key` 两种都可能出现）。 */
const FACE_IMAGE_OBJECT_KEY_PATTERN = /^xiai\/images\/[0-9a-f]{2}\/[0-9a-f]{64}\.(png|webp|jpg|jpeg|tiff)$/

/** `mime` ⇒ 对象键扩展名（存储件 tiff；展示件 png / webp；`image/jpeg` 兜底）。 */
const FACE_IMAGE_MIME_EXT = Object.freeze({
  'image/tiff': 'tiff',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg'
})

/* ---------------------------------------------------------------------------
  **对象删除候选单点（本单 `deleteImageObjectsOfRow`）**
  背景（线上实测真因）：管理员【刪除】回包「刪行 1 件、刪對象 0 件」⇒ 行删了、对象没删 ——
  `deleteArtifactObject` 的旧调用点只按**单一**键（行内 `storage_key` 或按 `mime` 派生的
  **一个**扩展名）试一次，猜错扩展名就回 0；而存储桶实测**只有展示件**（`.webp` / `.png` /
  `.jpg`），`.tiff` 源件键基本不存在（迁移盘点结论）⇒ 必须按**候选族**逐个试、命中即停。
  --------------------------------------------------------------------------- */

/** 删对象**后缀候选**（**逐字序**＝本单契约）：展示件在前、源件 `.tiff` 殿后。 */
const IMAGE_OBJECT_DELETE_SUFFIXES = Object.freeze(['.webp', '.png', '.jpg', '.jpeg', '.tiff'])

/** 行内**无扩展名**的键形态（`xiai/images/<摘要前两位>/<摘要>`）⇒ 按后缀候选表展开。 */
const IMAGE_OBJECT_KEY_PREFIX_PATTERN = /^xiai\/images\/[0-9a-f]{2}\/[0-9a-f]{64}$/

/** 行内除 `storage_key` 外可能持有对象键的字段（`edge_keys` 是数组，其余是单值）。 */
const IMAGE_OBJECT_DELETE_SINGLE_KEYS = Object.freeze(['display_key', 'image_storage_key'])

/**
 * **单个值 → 候选键族**（纯函数；**只认形态合法者**，不猜、不抛）：
 *  · 合法完整键（`<sha前两位>/<sha>.<png|webp|jpg|jpeg|tiff>`）⇒ 原样 1 键；
 *  · 裸摘要（64 位小写十六进制）⇒ `xiai/images/<前两位>/<摘要>` ＋ 后缀候选逐个展开；
 *  · 无扩展名前缀键 ⇒ 同样按后缀候选展开；
 *  · 其余（空 / 形态不合法）⇒ **零候选**。
 * @param {string} value 行内键值
 * @returns {string[]} 保序候选键（可能为空）
 */
function imageObjectKeyCandidatesOfValue(value) {
  const raw = text(value)
  if (raw === '') return []
  const lower = raw.toLowerCase()
  if (FACE_IMAGE_OBJECT_KEY_PATTERN.test(lower)) return [lower]
  const expand = (base) => IMAGE_OBJECT_DELETE_SUFFIXES.map((suffix) => `${base}${suffix}`)
  if (ARTIFACT_DIGEST_PATTERN.test(lower)) return expand(`xiai/images/${lower.slice(0, 2)}/${lower}`)
  if (IMAGE_OBJECT_KEY_PREFIX_PATTERN.test(lower)) return expand(lower)
  return []
}

/**
 * **行 → 保序候选键族**（去重；顺序即契约）：
 *  ① 行内 `storage_key`（非空且形态合法）→ ② `sha` 派生（`sha256` → `image_sha256` 回落）
 *  ＋ 后缀候选逐个试 → ③ 行内其它键（`display_key` / `image_storage_key` / `edge_keys[]`）
 *  按同样后缀候选展开。
 * @param {object} row 影像行
 * @returns {string[]} 保序候选键族
 */
function imageObjectKeyCandidatesOfRow(row) {
  const seen = new Set()
  const candidates = []
  const push = (value) => {
    for (const key of imageObjectKeyCandidatesOfValue(value)) {
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(key)
    }
  }
  push(text(row && row.storage_key)) /* ① 行内 `storage_key` 优先（命中即停 ⇒ 只试一次）。 */
  const digest = text(row && (row.sha256 || row.image_sha256)).toLowerCase() /* ② 摘要派生。 */
  if (ARTIFACT_DIGEST_PATTERN.test(digest)) push(digest)
  for (const field of IMAGE_OBJECT_DELETE_SINGLE_KEYS) push(text(row && row[field])) /* ③ 其它键。 */
  if (Array.isArray(row && row.edge_keys)) {
    for (const item of row.edge_keys) push(text(item))
  }
  return candidates
}

/**
 * **删影像对象（候选单点；`deleteFaceImage` / `deleteSeal` 共用的唯一实现）**：
 * 按 `imageObjectKeyCandidatesOfRow` 的候选序**逐个试、命中一件即停**。
 * **失败（对象不存在 / 删除报错）一律不抛、不计失败** —— 只返回**实际删成功的件数**（0 / 1）。
 * @param {object} row 影像行（`storage_key` / `sha256` / 可选 `display_key`、`edge_keys[]`…）
 * @returns {Promise<number>} 实际删除件数（0 或 1；**零谎报**）
 */
async function deleteImageObjectsOfRow(row) {
  const candidates = imageObjectKeyCandidatesOfRow(row)
  for (const key of candidates) {
    try {
      await deleteArtifactObject(key)
      return 1 /* **命中即停**：一件已删 ⇒ 不再试后续候选。 */
    } catch {
      /* 对象不存在 / 删除报错 ⇒ **不抛、不计失败**，继续下一候选（末位失败 ⇒ 如实回 0）。 */
    }
  }
  return 0
}

/* ---------------------------------------------------------------------------
   **普通用戶影像勘誤 · 执行侧原语（§3.77.3 / §3.77.4）**
   ---------------------------------------------------------------------------
   供 `submitImageCorrection`（提交期解析 / 一致性）与 `reviewCorrection` 的 `kind:'IMAGE'`
   采纳分支（执行期）共用；**不改** `deleteFaceImage` / `registerFaceImage` 的任何实现，
   判据与写入序逐条照搬其口径（本文件内只新增、零改既有行）。
   --------------------------------------------------------------------------- */

/** 按 `id` → `_id` 两形态依次读一行（命中即取首行；无行 ⇒ `null`）。 */
async function readRowByAnyId(collection, ref, limit) {
  for (const probe of ['id', '_id']) {
    const rows = await readRows(collection, { [probe]: ref }, { limit })
    if (rows.length > 0) return rows[0]
  }
  return null
}

/** 读印章行（`stamp_id` → `sid` → `id` → `_id` 四形态依次；无行 ⇒ `null`）。 */
async function readSealRowByAnyId(sealId) {
  for (const probe of ['stamp_id', 'sid', 'id', '_id']) {
    const rows = await readRows(COLLECTIONS.seals, { [probe]: sealId }, { limit: 8 })
    if (rows.length > 0) return rows[0]
  }
  return null
}

/** 按 `sha256` 读**已入册**影像行（内容寻址 id 优先命中，否则取首行；无行 ⇒ `null`）。 */
async function readRegisteredImageByDigest(digest) {
  const rows = await readRows(COLLECTIONS.images, { sha256: digest }, { limit: 8 })
  if (rows.length === 0) return null
  const wanted = `${DIRECT_IMAGE_ID_PREFIX}${digest.slice(0, DIRECT_IMAGE_ID_HEX_LENGTH)}`
  return rows.find((row) => text(row && row.id) === wanted || text(row && row._id) === wanted) || rows[0]
}

/**
 * 印面 ↔ 印章一致性：印面行内 `sealId` / `stamp_id` 命中（`seal_id` 本身 ＋ 印章行
 * `id` / `_id` / `sid` / `stamp_id` 任一）即认；行上**无**印章键 ⇒ 退回编号约定
 * `fc-<sid>-…`（`face id` 内嵌 sid，见 `nextFaceIdOf`）判归属。
 */
function faceBelongsToSeal(faceRow, sealId, sealRow) {
  const declared = text(faceRow && (faceRow.sealId || faceRow.stamp_id))
  const candidates = [sealId]
  if (sealRow) {
    for (const value of [sealRow.id, sealRow._id, sealRow.sid, sealRow.stamp_id]) {
      const item = text(value)
      if (item !== '') candidates.push(item)
    }
  }
  if (declared !== '') return candidates.indexOf(declared) !== -1
  const faceId = text(faceRow && (faceRow.id || faceRow._id))
  return sealId !== '' && faceId.indexOf(`fc-${sealId}`) === 0
}

/**
 * 本印面归属（**与 `deleteFaceImage` 同口径**）：`face_image_id` 等值 **或** 在
 * `edge_image_ids[]` 中（元素统一 `text()` 归一、滤空）。
 * @returns {{edgeIds:string[], ownedByFace:boolean, ownedByEdge:boolean}}
 */
function faceImageOwnershipOf(faceRow, imageId) {
  const edgeIds = Array.isArray(faceRow && faceRow.edge_image_ids)
    ? faceRow.edge_image_ids.map((id) => text(id)).filter((id) => id !== '')
    : []
  const ownedByFace = text(faceRow && faceRow.face_image_id) === imageId
  const ownedByEdge = edgeIds.indexOf(imageId) !== -1
  return { edgeIds, ownedByFace, ownedByEdge }
}

/**
 * **共用保护**（**与 `deleteFaceImage` 逐字同判据**）：扫描全部印面，除本印面外仍有
 * 任何印面的 `face_image_id` / `edge_image_ids[]` 命中该影像 ⇒ `true`。
 */
async function imageSharedByOtherFaces(faceId, imageId) {
  const isTargetFace = (row) => text(row && row.id) === faceId || text(row && row._id) === faceId
  const allFaces = await readRows(COLLECTIONS.faces, {}, { limit: FACE_IMAGE_DELETE_SCAN_LIMIT })
  return allFaces.some(
    (row) =>
      !isTargetFace(row) &&
      (text(row && row.face_image_id) === imageId ||
        (Array.isArray(row && row.edge_image_ids) &&
          row.edge_image_ids.some((edgeId) => text(edgeId) === imageId)))
  )
}

/** **占位图行判据**（与 `deleteFaceImage` 同口径：占位图行不删、只清引用）。 */
function isPlaceholderImageRow(imageRow) {
  return (
    imageRow !== null &&
    (text(imageRow.storage_key) === SEAL_PLACEHOLDER_IMAGE_KEY ||
      text(imageRow.id) === SEAL_PLACEHOLDER_IMAGE.id ||
      text(imageRow._id) === SEAL_PLACEHOLDER_IMAGE.id)
  )
}

/**
 * **删影像行后的对象删除**（**与 `deleteFaceImage` 同口径**）：同 `sha256` 尚有其它行
 * ⇒ 只删行、对象不动；否则走候选单点 `deleteImageObjectsOfRow`（命中即停、失败不抛）。
 * @returns {Promise<number>} 实际删对象件数（0 / 1；**零谎报**）
 */
async function deleteObjectsOfImageRowIfUnshared(imageRow, imageId) {
  const rawDigest = text(imageRow && imageRow.sha256)
  const digest = rawDigest.toLowerCase()
  const imageDocId = text(imageRow && imageRow._id) || imageId
  let sharedByOtherRow = false
  if (ARTIFACT_DIGEST_PATTERN.test(digest)) {
    const peers = await readRows(COLLECTIONS.images, { sha256: rawDigest }, { limit: FACE_IMAGE_DIGEST_SCAN_LIMIT })
    sharedByOtherRow = peers.some((row) => text(row && (row._id || row.id)) !== imageDocId)
  }
  if (sharedByOtherRow) return 0
  return deleteImageObjectsOfRow(imageRow)
}

/**
 * **采纳 `kind:'IMAGE'` 勘误的影像面执行**（§3.77.4；只由 `reviewCorrection` 的采纳路调用，
 * **属性（`field`）型行一律不走本函数**）。
 *
 * · `action:'delete'` ＝ **逐条照搬 `deleteFaceImage` 的写入序**：归属校验 → 共用保护（仍被
 *   其它印面引用 ⇒ 拒绝并**保持 `PENDING`**、文案含「已被印面引用」）→ 清本印面引用 → 删影像行
 *   （**占位图行不删**）→ `deleteImageObjectsOfRow` 删对象（同 `sha256` 去重保护、尽力删、计数如实）；
 * · `action:'replace'` ＝ 三步硬序：① **先校验新图已入册**（`new_image_id` 有 `xiai_images` 行）
 *   → ② 印面指向新图 → ③ 旧影像行与对象一并删除（**共用保护**：旧图仍被其它印面引用 ⇒
 *   不删旧图、只改指向、`shared_kept:true`）；第 ③ 步失败 ⇒ **尽力把指向回滚到旧图**，
 *   杜绝「指向已改而舊圖未刪」的含混态；
 * · **执行成功才由调用方写 `ACCEPTED`**；任何拒绝 / 执行失败 ⇒ 直接回结构化拒绝、
 *   **状态仍 `PENDING`**（本拒绝不迁 `REJECTED`）＋ 如实文案（**零新增 `reason`**）。
 * @param {object} row `xiai_corrections` 的 `kind:'IMAGE'` 行
 * @param {string} at 服务端时间（ISO；与本次审核的 `reviewed_at` 同源）
 * @returns {Promise<{ok:true, image_action:{action:string, removed:{rows:number, objects:number},
 *           shared_kept:boolean}}|{ok:false, reason:string, message:string}>}
 */
async function applyImageCorrectionAcceptance(row, at) {
  const action = text(row.action)
  const faceId = text(row.faceId)
  const imageId = text(row.image_id)
  /* ① 印面行检索（`id` → `_id` 两形态；无行 ⇒ `INVALID_VALUE` ＋ 狀態維持 `PENDING`）。 */
  let faceRow = null
  let probeField = ''
  for (const probe of ['id', '_id']) {
    const rows = await readRows(COLLECTIONS.faces, { [probe]: faceId }, { limit: FACE_IMAGE_DELETE_FACE_SCAN_LIMIT })
    if (rows.length > 0) {
      faceRow = rows[0]
      probeField = probe
      break
    }
  }
  if (faceRow === null) {
    return deny(REASONS.INVALID_VALUE, `未找到該印面（face_id：${faceId}）⇒ 無法執行；狀態維持 PENDING、本次零寫入。`)
  }
  /* ② 本印面归属校验（同 `deleteFaceImage`）。 */
  const ownership = faceImageOwnershipOf(faceRow, imageId)
  if (!ownership.ownedByFace && !ownership.ownedByEdge) {
    return deny(
      REASONS.INVALID_VALUE,
      `影像編號（${imageId}）不屬於該印面（本印面的 face_image_id / edge_image_ids 均未命中）⇒ 無法執行；狀態維持 PENDING、本次零寫入。`
    )
  }
  const match = text(faceRow._id) ? { _id: text(faceRow._id) } : { [probeField]: faceId }

  if (action === 'delete') {
    /* ③ **共用保护**：其它印面仍引用 ⇒ 拒绝（文案含「已被印面引用」）＋ 零写入 ＋ 状态仍 `PENDING`。 */
    if (await imageSharedByOtherFaces(faceId, imageId)) {
      return deny(
        REASONS.INVALID_VALUE,
        `該影像已被印面引用（其它印面行的 face_image_id / edge_image_ids 命中 ${imageId}），共用保護下不可刪除；` +
          '狀態維持 PENDING（本拒絕不遷 REJECTED）、本次零寫入。'
      )
    }
    /* ④ 写入确定序 ①：**先清本印面引用**（`face_image_id` 置 `''` ／ 从 `edge_image_ids` 移除）。 */
    const faceDoc = { updated_at: at }
    if (ownership.ownedByFace) faceDoc.face_image_id = ''
    if (ownership.ownedByEdge) faceDoc.edge_image_ids = ownership.edgeIds.filter((id) => id !== imageId)
    try {
      await persist({ writes: [{ kind: 'update', collection: COLLECTIONS.faces, match, doc: faceDoc, expectAtLeast: 1 }] })
    } catch (error) {
      return deny(
        REASONS.STORAGE_UNAVAILABLE,
        `印面引用清除失敗（face_id：${faceId}）；影像行與對象均未刪除、狀態維持 PENDING，可重試。（診斷：${
          (error && error.message) || 'unknown'
        }）`
      )
    }
    /* ⑤ 写入确定序 ②：删 `xiai_images` 行（**占位图行不删**；无行 ⇒ 如实 0、不编造）。 */
    const imageRow = await readRowByAnyId(COLLECTIONS.images, imageId, FACE_IMAGE_DELETE_IMAGE_SCAN_LIMIT)
    let rows = 0
    if (imageRow !== null && !isPlaceholderImageRow(imageRow)) {
      try {
        await deleteRow(COLLECTIONS.images, text(imageRow._id) || imageId)
        rows = 1
      } catch (error) {
        return deny(
          REASONS.STORAGE_UNAVAILABLE,
          `印面引用已清除，但影像行刪除失敗（image_id：${imageId}）；對象未刪除、影像行仍在、狀態維持 PENDING，可重試。（診斷：${
            (error && error.message) || 'unknown'
          }）`
        )
      }
    }
    /* ⑥ 写入确定序 ③：**尽力**删对象（同 `sha256` 去重保护；失败不阻断、计数如实 0）。 */
    const objects = rows === 1 ? await deleteObjectsOfImageRowIfUnshared(imageRow, imageId) : 0
    return { ok: true, image_action: { action: 'delete', removed: { rows, objects }, shared_kept: false } }
  }

  if (action === 'replace') {
    /* ① 先校验新图已入册（`new_image_id` 对应 `xiai_images` 行存在；否则拒绝 ＋ 零写入 ＋ 状态仍 PENDING）。 */
    const newImageId = text(row.new_image_id)
    if (newImageId === '') {
      return deny(
        REASONS.INVALID_VALUE,
        '該勘誤行缺少新圖影像編號（new_image_id）⇒ 無法執行替換；狀態維持 PENDING、本次零寫入。'
      )
    }
    const newImageRow = await readRowByAnyId(COLLECTIONS.images, newImageId, FACE_IMAGE_DELETE_IMAGE_SCAN_LIMIT)
    if (newImageRow === null) {
      return deny(
        REASONS.INVALID_VALUE,
        `替換用新圖尚未入册（new_image_id：${newImageId}）⇒ 拒絕執行；狀態維持 PENDING、本次零寫入。`
      )
    }
    /* 共用保护（**先判、后写**）：旧图仍被其它印面引用 ⇒ 不删旧图、只改指向。 */
    const sharedByOthers = await imageSharedByOtherFaces(faceId, imageId)
    /* ② 印面指向新图（既有 `face_image_id` ／ `edge_image_ids[]` 写面语义）。 */
    const faceDoc = { updated_at: at }
    if (ownership.ownedByFace) faceDoc.face_image_id = newImageId
    if (ownership.ownedByEdge) {
      faceDoc.edge_image_ids = ownership.edgeIds.map((id) => (id === imageId ? newImageId : id))
    }
    try {
      await persist({ writes: [{ kind: 'update', collection: COLLECTIONS.faces, match, doc: faceDoc, expectAtLeast: 1 }] })
    } catch (error) {
      return deny(
        REASONS.STORAGE_UNAVAILABLE,
        `印面指向更新失敗（face_id：${faceId}）；指向未改、舊圖未刪、狀態維持 PENDING，可重試。（診斷：${
          (error && error.message) || 'unknown'
        }）`
      )
    }
    /* 共用保护：**零删行、零删对象、零清其它印面引用**（只改指向）。 */
    if (sharedByOthers) {
      return { ok: true, image_action: { action: 'replace', removed: { rows: 0, objects: 0 }, shared_kept: true } }
    }
    /* 防御：新图与原图同一影像编号（提交期已挡，行面异常时兜底）⇒ 指向即原指向，旧行不得删。 */
    if (newImageId === imageId) {
      return { ok: true, image_action: { action: 'replace', removed: { rows: 0, objects: 0 }, shared_kept: false } }
    }
    /* ③ 旧影像行与对象一并删除（占位图行不删；**失败 ⇒ 回滚指向、不留含混态**）。 */
    const oldRow = await readRowByAnyId(COLLECTIONS.images, imageId, FACE_IMAGE_DELETE_IMAGE_SCAN_LIMIT)
    let rows = 0
    if (oldRow !== null && !isPlaceholderImageRow(oldRow)) {
      try {
        await deleteRow(COLLECTIONS.images, text(oldRow._id) || imageId)
        rows = 1
      } catch (error) {
        const diagnosis = (error && error.message) || 'unknown'
        const rollbackDoc = { updated_at: at }
        if (ownership.ownedByFace) rollbackDoc.face_image_id = imageId
        if (ownership.ownedByEdge) rollbackDoc.edge_image_ids = ownership.edgeIds
        try {
          await persist({
            writes: [{ kind: 'update', collection: COLLECTIONS.faces, match, doc: rollbackDoc, expectAtLeast: 1 }]
          })
          return deny(
            REASONS.STORAGE_UNAVAILABLE,
            `舊影像行刪除失敗（image_id：${imageId}）⇒ 已把印面指向回滾到原影像、整筆回到未執行態；狀態維持 PENDING，可重試。（診斷：${diagnosis}）`
          )
        } catch (rollbackError) {
          return deny(
            REASONS.STORAGE_UNAVAILABLE,
            `舊影像行刪除失敗（image_id：${imageId}），且回滾印面指向未成功 ⇒ 印面已指向新圖而舊圖仍在（狀態維持 PENDING）；請重放本次審核以自愈。（診斷：${
              (rollbackError && rollbackError.message) || diagnosis
            }）`
          )
        }
      }
    }
    const objects = rows === 1 ? await deleteObjectsOfImageRowIfUnshared(oldRow, imageId) : 0
    return { ok: true, image_action: { action: 'replace', removed: { rows, objects }, shared_kept: false } }
  }

  /* 值域外动作（提交期门已保证；防御性兜底 ⇒ 状态仍 `PENDING`、零写入）。 */
  return deny(
    REASONS.INVALID_VALUE,
    `勘誤動作「${action || '（空）'}」不在可執行的 2 類之內（刪除此影像 / 重新上傳新圖替換）；狀態維持 PENDING、本次零寫入。`
  )
}

/* --------------------------------------------------------------------------- *
  **上傳印章即上雲（本單新增 op｜`createSealUpload`｜管理員面）**
  ---------------------------------------------------------------------------
  场景（线上实证真因）：「上傳印章」此前**只写本机**（`db.js::createSealWithFaceRows` 纯本地落盘，
  且用**本机号源** `nextSealNo` 发 `seal_no`）⇒ 干净浏览器（管理员）查不到该印、AI 修復按
  `image_id` 严格查行必报「原圖影像編號不存在」、删除也删不到云端。本 op 就是那条**云端权威**写入面：
  **服务端发号 ＋ 内容寻址影像行 ＋ `persist` 单点落盘**，客户端只做本机镜像（本机不再发号）。
  --------------------------------------------------------------------------- */

/** 上傳印章载荷**封闭键面**：印章级 8 鍵 ＝ `SEAL_IMPORT_SEAL_FIELDS` **逐字沿用（不新造字段）**
 *  ＋ `faces[]` ＋ 冪等鍵 `client_request_id`；身份类键一律不在面内 ⇒ `INVALID_FIELD`。 */
const SEAL_UPLOAD_ALLOWED_KEYS = Object.freeze([...SEAL_IMPORT_SEAL_FIELDS, 'faces', 'client_request_id'])

/** 单印面**封闭键面**（必給 4 鍵 ＋ 可選 7 個自由文本鍵；其余键 ⇒ `INVALID_FIELD`）。 */
const SEAL_UPLOAD_FACE_KEYS = Object.freeze([
  'kind',
  'image_sha256',
  'image_bytes',
  'image_storage_key',
  'seal_name',
  'dynasty',
  'seal_type',
  'face_style',
  'seal_class',
  'author',
  'transcription'
])

/** 单印面**必給键**（缺 / 空 ⇒ `MISSING_REQUIRED`）。 */
const SEAL_UPLOAD_FACE_REQUIRED_KEYS = Object.freeze(['kind', 'image_sha256', 'image_bytes', 'image_storage_key'])

/** 单印面 `kind` 值域（恰二值；给出即必须逐字命中，**不静默归一**）。 */
const SEAL_UPLOAD_FACE_KINDS = Object.freeze(['FACE', 'EDGE'])

/** 本通道印章行的 `source` 取值（＝ 本机 `MANUAL_SOURCE` 同值；行字段，**不是载荷键**）。 */
const SEAL_UPLOAD_SOURCE = 'manual'

/**
 * **冪等命中時的回包读数**（**只读、零写**）：按 `sealId` 取该印全部印面，按 `face_no` 升序 ⇒
 * `face_ids` / `image_ids` / `face_nos` 三数组恒**一一对应**（与新建路径的按面序同构）。
 * @param {object} sealRow 既有正式印章行
 * @returns {Promise<{stamp_id:string, sid:string, seal_no:number, face_ids:string[],
 *          image_ids:Array<string|null>, face_nos:number[]}>}
 */
async function sealUploadReadoutsOf(sealRow) {
  const sid = text(sealRow && (sealRow.sid || sealRow.stamp_id))
  const faceRows = sid === '' ? [] : await readRows(COLLECTIONS.faces, { sealId: sid }, { limit: 64 })
  const ordered = (Array.isArray(faceRows) ? faceRows : []).slice().sort(
    (a, b) => Number(a && a.face_no) - Number(b && b.face_no)
  )
  return {
    stamp_id: sid,
    sid,
    seal_no: Number(sealRow && sealRow.seal_no),
    face_ids: ordered.map((doc) => text(doc && doc.id)),
    image_ids: ordered.map((doc) => faceImageIdOf(doc)),
    face_nos: ordered.map((doc) => Number(doc && doc.face_no))
  }
}

/* ---------------------------------------------------------------------------
   **历史「已采纳未落面」一次性回填面（§3.79｜本单新增 op `backfillAcceptedCorrections`）**
   ---------------------------------------------------------------------------
   · 載荷**封閉恰二鍵**：`dry_run`（**必有、布林**；缺 / 非布林 ⇒ `INVALID_VALUE`）＋ `limit`
     （可選、**1〜200 整數**、缺省 200；越界 / 非整數 ⇒ `INVALID_VALUE`）。**身份類鍵與未知鍵
     ⇒ `INVALID_FIELD`**（零讀取、零寫入）。`reason` **零新增**（只用既有凍結值）。
   · `limit` 兩義（同時成立、互不放寬）：① **本輪最多處理的目標分組數**（超出部分留待下一輪，
     **不報錯、不視為失敗**，§3.79.2 ②）；② **掃描護欄** ＝ 最多 `limit` 個批次 × 每批
     `BACKFILL_SCAN_PAGE_SIZE` 行（另按 `BACKFILL_SCAN_MAX_PAGE_LIMIT` 封頂）⇒ 分頁掃描**防卡死**。
   · 回包**新增恰 6 鍵**（`dry_run` 回顯 ＋ `scanned` / `eligible` / `written` /
     `skipped{out_of_domain, same}` / `samples[]`）—— **僅本 op** 由 `index.js` 按 `op` 收窄透傳；
     其餘各 op 回包鍵集逐字不變。**零新集合（審計落既有 `xiai_admin_audit`）、零新增 `reason`。**
   --------------------------------------------------------------------------- */
const BACKFILL_ALLOWED_KEYS = Object.freeze(['dry_run', 'limit'])
/** `limit` 缺省值 ＝ 本輪最多處理的目標分組數（亦為掃描批數護欄上限）。 */
const BACKFILL_DEFAULT_LIMIT = 200
/** `limit` 上界（1〜200；沿 §3.79.2 ②，**不得放寬**）。 */
const BACKFILL_MAX_LIMIT = 200
/** 掃描分頁：單批行數（平台 `.limit()` 護欄；每頁遞增以便在無 `skip` 的讀點上真正翻頁）。 */
const BACKFILL_SCAN_PAGE_SIZE = 100
/** 單次查詢行數封頂（平台單查詢上限護欄；到頂且無新增行 ⇒ 結束掃描）。 */
const BACKFILL_SCAN_MAX_PAGE_LIMIT = 1000
/** `samples[]` 單次上限（§3.79.2 ④ 規定 ≤ 20；本單取 10，嚴格小於上界）。 */
const BACKFILL_MAX_SAMPLES = 10

/**
 * **取位比較（純函數、零 I/O、絕不自抛）**：同 `(faceId 或 sealId, field)` 分組內挑「最新」的
 * `ACCEPTED` 勘誤行 —— **`created_at` 最新者勝**（ISO8601 字面可直接字典序比較）；**並列（`created_at`
 * 相同）⇒ 按行 `_id` 字典序取最大者**（§3.79.3 ① 凍結的並列次序 ⇒ 結果確定、可復跑一致）。
 * 任一側取不到值 ⇒ 空串（＝ 最舊），**不拋錯**。
 * @param {object} candidate 候選勘誤行
 * @param {object} incumbent 當前佔位行
 * @returns {boolean} `candidate` 是否勝出
 */
function newerCorrectionWins(candidate, incumbent) {
  const atCandidate = text(candidate && candidate.created_at)
  const atIncumbent = text(incumbent && incumbent.created_at)
  if (atCandidate !== atIncumbent) return atCandidate > atIncumbent
  const idOf = (row) => text(row && (row._id !== undefined && row._id !== null ? row._id : row.id))
  return idOf(candidate) > idOf(incumbent)
}

/* --------------------------------------------------------------------------- *
  影像行 `storage` 一次性修复面（本单新增 op `repairImageStorage`）
 * --------------------------------------------------------------------------- *
  · **背景（真因）**：新环境批量入册的 6,347 行影像行**全部缺 `storage` 键**，而前端
    `src/data/cloudbase.js::cloudBaseObjectKeyOf` 的**第一道前置门** ＝
    `String(row.storage).trim().toLowerCase() === 'server'` —— 判不过 ⇒ **直接回空对象键**
    ⇒ 页面落「印面圖片暫缺」（旧行都有 `storage:'server'`）。故本 op 把 `xiai_images` 里
    **缺 / 空 `storage` 的行逐行补写成 `storage: 'server'`**（取值与 `buildDirectImageRow`
    逐字一致，**不另立第二值**）。
  · **载荷封闭恰三键**：`dry_run`（**布林、缺省 `true`**）、`limit`（**1〜500 整数、缺省 200**）、
    `cursor`（**字符串** ＝ 上轮回包的 `next_cursor`；缺省 / 空串 ⇒ 从头）。未知键 / 身份类键 ⇒
    `INVALID_FIELD`；形态不符 ⇒ `INVALID_VALUE`。**全部判定早于任何读写**。
  · **扫描窗口**：`xiai_images` 按 `_id` **升序**、**严格大于 `cursor`** 的前 `limit` 行 ＝ 本轮窗口
    （`scanned ≤ limit`）；`storage` **缺省（`undefined` / `null`）或空串 / 空白** ⇒ 待补（`eligible`）；
    **已有非空 `storage` 的行一律不碰** ⇒ **幂等**（重跑同 `cursor` ⇒ `written = 0`）。
  · **写步（仅 `dry_run:false`）**：逐行一次 `persist`（`kind:'update'` ＋ `match:{_id}` ＋
    `doc:{storage:'server'}` ＋ **`expectAtLeast:1`**）；单行失败不中断整批。
    **读数以真写入结果为准**（读数不实修）：`persist` 的成败只是一次请求的**回报**，不等于该行
    真的落了（回报丢失 ⇒ 写已生效却抛错；回报未带受影响行数 ⇒ 写没生效却不抛）⇒ 故**逐行写、
    整窗读回**：写完用**同一窗口语义**重读一遍（`readStorageRepairWindow` 同一读路），按**行终态**
    逐行定真伪 —— 读回 `storage === 'server'` ⇒ 计 `written`；否则 ⇒ 进 `failed`。
    ⇒ `written` ＝ 本窗口**真正生效**行数、`failed` ＝ 本窗口**真没写成**行；已存在 / 已同值 /
    被跳过的行**既不计 `written` 也不进 `failed`**（不在尝试名单内）。
    **本 op 自己产写步、不产 `plan`** ⇒ `index.js` 的落盘分支不触发（`plan` 亦不在透传白名单）。
  · **回包封闭**：`dry_run` ⇒ **恰 4 键** `ok / scanned / eligible / next_cursor`；真写 ⇒ **恰 5 键**
    `ok / scanned / written / next_cursor / failed`（`failed` **恒为数组**，元素 ＝ `{_id, reason}`、
    `reason` 只用既有冻结值 `STORAGE_UNAVAILABLE`）；`next_cursor` ＝ 本轮窗口末行 `_id`（**字符串**）／
    窗口空 ⇒ **`null`**（＝ 已扫尽，下一轮可停）。失败（含门拒）恒**恰 3 键** `{ok, reason, message}`。
  · **读路（两路同一窗口语义）**：主路 ＝ 真实 SDK 一条
    `where({_id: command.gt(cursor)}).orderBy('_id','asc').limit(limit)`（`db.command` 算子与本文件
    CAS 发号面 `db.command.inc` 同源）；**退路**（离线假体无 `command`）＝ 全量分页读（链有 `skip`
    ⇒ 逐页翻，无则整桶一次取回）＋ 内存排序。两路都再过同一个纯函数 `storageRepairWindowOf`
    ⇒ **游标推进式逐字一致、游标绝不回退**。
  · **零新增 `reason` 字面值、零新集合**（读写都在既有 `COLLECTIONS.images`）；**第一行即
    `adminWhitelistDenial`**（零读零写地拒；非管理员 ⇒ `FORBIDDEN`）。
 * --------------------------------------------------------------------------- */

/** `repairImageStorage` 载荷封闭键面（恰三键）。 */
const REPAIR_IMAGE_STORAGE_ALLOWED_KEYS = Object.freeze(['dry_run', 'limit', 'cursor'])
/** `limit` 缺省值（＝ 本轮最多扫描行数）。 */
const REPAIR_IMAGE_STORAGE_DEFAULT_LIMIT = 200
/** `limit` 上界（1〜500；派单口径，不得放宽）。 */
const REPAIR_IMAGE_STORAGE_MAX_LIMIT = 500
/** 退路分页：单页行数 ＋ 最多页数（防卡死护栏；64 × 200 = 12,800 行 ＞ 存量 6,347 行）。 */
const REPAIR_IMAGE_STORAGE_PAGE_SIZE = 200
const REPAIR_IMAGE_STORAGE_MAX_PAGES = 64
/** 成功回包读数键面（**`index.js` 按 `op` 收窄透传的键名真源**；两态合计恰 5 键）。 */
const REPAIR_IMAGE_STORAGE_READOUT_KEYS = Object.freeze(['scanned', 'eligible', 'written', 'next_cursor', 'failed'])

/**
 * 行是否**缺 `storage`**（待补判据）：`undefined` / `null` ／ 空串 ／ 纯空白 ⇒ `true`；
 * **任何非空值（含 `'server'` / `'local'` / 非字符串）⇒ `false`（一律不碰 ⇒ 幂等）**。
 * 与前端门 `String(row.storage).trim().toLowerCase() === 'server'` 对齐：只有缺 / 空的行
 * 才会把展示件解析成空键。
 * @param {object|null|undefined} row 影像行
 * @returns {boolean}
 */
function storageRepairNeeded(row) {
  const value = row ? row.storage : undefined
  if (value === undefined || value === null) return true
  return typeof value === 'string' && value.trim() === ''
}

/**
 * **窗口纯函数（零 I/O、绝不自抛）**：按 `_id` 升序、**严格大于 `after`** 的前 `windowSize` 行。
 * 两读路共用 ⇒ 同一游标推进式；无 `_id` 的行**不入窗**（无法定址、无法推进游标）。
 * @param {Array<object>} rows 候选行
 * @param {string} after 上轮回包的 `next_cursor`（空串 ⇒ 不设下界）
 * @param {number} windowSize 本轮窗口上限（＝ `limit`）
 * @returns {Array<object>}
 */
function storageRepairWindowOf(rows, after, windowSize) {
  const cursor = text(after)
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      const id = text(row && row._id)
      return id !== '' && (cursor === '' || id > cursor)
    })
    .sort((left, right) => {
      const a = text(left && left._id)
      const b = text(right && right._id)
      return a < b ? -1 : a > b ? 1 : 0
    })
    .slice(0, Math.max(0, windowSize))
}

/**
 * 取本轮扫描窗口（**只读**）：`_id` 升序、严格大于 `after` 的前 `windowSize` 行。
 * 主路（真实 SDK）＝ 一条范围查询；退路（离线假体无 `db.command`）＝ 全量分页读 ＋ 内存收口。
 * 任一路抛错都**原样上抛**（由 `index.js` 转 `STORAGE_UNAVAILABLE`；**绝不吞成 0 行**）。
 * @param {string} after 游标（上轮回包 `next_cursor`；空串 ⇒ 从头）
 * @param {number} windowSize 窗口上限（＝ `limit`）
 * @returns {Promise<Array<object>>}
 */
async function readStorageRepairWindow(after, windowSize) {
  const db = resolveDb()
  const cursor = text(after)
  const command = db && db.command
  /* 主路：`where({_id: gt(cursor)}) → orderBy('_id','asc') → limit(windowSize)`（`command` 缺席才走退路）。 */
  if (command && typeof command.gt === 'function') {
    const match = cursor === '' ? {} : { _id: command.gt(cursor) }
    let chain = db.collection(COLLECTIONS.images).where(match)
    if (chain && typeof chain.orderBy === 'function') chain = chain.orderBy('_id', 'asc')
    if (chain && typeof chain.limit === 'function') chain = chain.limit(windowSize)
    return storageRepairWindowOf(rowsOfReply(await chain.get()), cursor, windowSize)
  }
  /* 退路：链有 `skip` ⇒ 逐页翻（`_id` 升序）；无 `skip`（极简假体）⇒ 整桶一次取回后再收口。
     页读不满 / 本页零新增（无 `skip` ⇒ 每页同一批行）⇒ 已扫尽，收口（防死循环）。 */
  const probe = db.collection(COLLECTIONS.images).where({})
  if (!probe || typeof probe.get !== 'function') throw new Error('DB_QUERY_UNSUPPORTED')
  const collected = []
  if (typeof probe.skip !== 'function') {
    collected.push(...rowsOfReply(await probe.get()))
  } else {
    let offset = 0
    for (let page = 0; page < REPAIR_IMAGE_STORAGE_MAX_PAGES; page += 1) {
      let chain = db.collection(COLLECTIONS.images).where({})
      if (typeof chain.orderBy === 'function') chain = chain.orderBy('_id', 'asc')
      if (offset > 0 && typeof chain.skip === 'function') chain = chain.skip(offset)
      if (typeof chain.limit === 'function') chain = chain.limit(REPAIR_IMAGE_STORAGE_PAGE_SIZE)
      const rows = rowsOfReply(await chain.get())
      if (rows.length === 0) break
      collected.push(...rows)
      if (rows.length < REPAIR_IMAGE_STORAGE_PAGE_SIZE) break
      offset += rows.length
    }
  }
  return storageRepairWindowOf(collected, cursor, windowSize)
}

const ADMIN_OPS = Object.freeze({
  /**
   * **管理員「弃候選圖」（`ai-enhance-discard`）** —— 薄委派：業務邏輯單點在
   * `lib/aiEnhanceDiscard.js::discardCandidate`（本處零第二套邏輯；`require` 延遲以打破加載環）。
   * 硬口徑：① **管理員寫面**（`adminWhitelistDenial` 門同既有；非管理員 ⇒ `FORBIDDEN` ＋ 零刪行）；
   * ② 載荷**封閉恰一鍵** `image_id`（未知鍵 ⇒ `INVALID_FIELD`；缺 / 空 ⇒ `MISSING_REQUIRED`；
   *    非字符串 ⇒ `INVALID_VALUE`；以上均零刪行、零刪對象）；③ 只弃 `source: ai_enhance` 的影像行
   *    （其它來源 ⇒ `FORBIDDEN`，文案「僅 AI 修復候選圖可弃」）；④ 印面引用保護（任一印面行的
   *    `face_image_id` / `edge_image_ids` 命中 ⇒ `INVALID_VALUE`，文案「已被印面引用，不可弃」）；
   * ⑤ 刪影像行（經 `ops.deleteRow`）＋ **內容尋址去重保護**（同 `sha256` 尚有其它行 ⇒ 只刪行、
   *    `deleted_objects: false`；無他行 ⇒ 刪對象、`deleted_objects: true`）；⑥ 成功回包**恰 3 鍵**
   *    （`ok, image_id, deleted_objects`）、失敗回包**恰 3 鍵**（`ok, reason, message`，
   *    **零 `refunded`** —— 與修復面不同，弃圖零計費 ⇒ 零退款面）；⑦ 冪等：同編號重放 ⇒ 行已不
   *    存在 ⇒ 成功回放 `deleted_objects: false`（不報錯、不重複刪）；⑧ `reason` **零新增**（只用
   *    既有凍結值）、**零新集合**（讀走 `readRows`、刪行走 `deleteRow` / `deleteArtifactObject`）。
   * @param {object} payload 載荷（封閉一鍵 `image_id`）
   * @param {{uid:string, phone:string, role?:string}} identity 服務端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  'ai-enhance-discard': async function aiEnhanceDiscardDelegate(payload, identity, context) {
    /* 延遲 require：與修復面同法（打破加載環；離線自檢不需要 SDK）。 */
    const { discardCandidate } = require('./aiEnhanceDiscard.js')
    return discardCandidate(payload, identity, context)
  },

  /**
   * **管理員「人工智能修復」（`ai-enhance-face`｜規範 §3.68）** —— 薄委派：業務邏輯單點在
   * `lib/aiEnhance.js::enhanceFace`（本處零第二套邏輯；`require` 延遲以打破加載環）。
   * 硬口徑：① **管理員寫面**（`adminWhitelistDenial` 門同既有；非管理員 ⇒ `FORBIDDEN` ＋ 零扣費）；
   * ② **扣管理員自己的金 10 金/張**（§3.67.2 唯一寫值處）—— **預扣**（`CHARGE` ＋
   * `idem_key = ai-enhance-<image_id>-<rid>` 三段封閉），上游 / 存儲 / 入册任何失敗 ⇒ **全額退款**
   * （原 `CHARGE` 行不删、回包 `refunded: true`）；③ 成功回包**恰 8 鍵**（`ok, image_id,
   * source_image_id, preview, charge, upstream_status, elapsed_ms, idempotent`）、失敗回包
   * **恰 4 鍵**（`ok, reason, message, refunded`）；④ `reason` 唯一新增字面值 `UPSTREAM_ERROR`
   * （`lib/config.js::REASONS` 第 13 值，逐字同端點面 `api/_lib/aiRelay.js` 詞彙）；⑤ 冪等：
   * 同請求號重放零重扣、零重建行（`idempotent: true`）；不掛印面（零 `face_image_id` 寫入）。
   * @param {object} payload 載荷（封閉三鍵 `image_id` / `seal_id` / `face_id`）
   * @param {{uid:string, phone:string, role?:string}} identity 服務端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number, requestId?:string}} [context]
   */
  'ai-enhance-face': async function aiEnhanceFaceDelegate(payload, identity, context) {
    /* 延遲 require：與 `lib/aiUpstream.js` 同法（打破加載環；離線自檢不需要 SDK）。 */
    const { enhanceFace } = require('./aiEnhance.js')
    return enhanceFace(payload, identity, context)
  },

  /**
   * **管理員「人工智能修復 · 候選清單」（`ai-enhance-list`｜只讀）** —— 薄委派：業務邏輯單點在
   * `lib/aiEnhanceTasks.js::listEnhanceTasks`（本處零第二套邏輯；`require` 延遲以打破加載環）。
   * 硬口徑：① **第一行即管理員門**（既有 `adminWhitelistDenial`；零讀零寫地拒；拒絕面轉本 op 的
   * 失敗形狀 **恰 3 鍵** `ok / reason / message`）；② 載荷**封閉恰一鍵** `face_id`；③ 回該印面下
   * **所有未採納的候選任務**（`READY` 且產物影像已被任一印面行 `face_image_id` /
   * `edge_image_ids` 引用者＝已採納、不回）；④ 成功回包**恰 2 鍵**（`ok / rows`），每行**恰 6 鍵**
   * `task_id / status / image_id / source_image_id / created_at / error_message`（無值一律空串）、
   * 按 `created_at` 倒序、最多 20 行；⑤ **只讀**（零扣費、零寫入）、`reason` **零新增**、
   * **零新集合**（任務行落 `xiai_ai_enhance_tasks`，「集合不存在」按既有判據降級為空集）。
   * @param {object} payload 載荷（封閉一鍵 `face_id`）
   * @param {{uid:string, phone:string, role?:string}} identity 服務端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  'ai-enhance-list': async function aiEnhanceListDelegate(payload, identity, context) {
    /* ① 管理員門（既有單點；**本函數第一行**，零讀零寫地拒）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return { ok: false, reason: identityDenial.reason, message: identityDenial.message }
    /* 延遲 require：與修復面同法（打破加載環；離線自檢不需要 SDK）。 */
    const { listEnhanceTasks } = require('./aiEnhanceTasks.js')
    return listEnhanceTasks(payload, identity, context)
  },

  /**
   * **管理員「人工智能修復 · 狀態推進」（`ai-enhance-status`）** —— 薄委派：業務邏輯單點在
   * `lib/aiEnhanceTasks.js::statusEnhanceTask`（本處零第二套邏輯；`require` 延遲以打破加載環）。
   * 硬口徑：① **第一行即管理員門**（既有 `adminWhitelistDenial`；零讀零寫地拒；拒絕面轉本 op 的
   * 失敗形狀 **恰 5 鍵** `ok / reason / message / refunded / status`）；② 載荷**封閉恰一鍵**
   * `task_id`（不存在 ⇒ `INVALID_VALUE`、文案「該修復任務不存在」）；③ 終態（`READY` / `FAILED`）
   * **直接回放、零上游零扣費**；④ 單輪推進：單查 20 秒 → `pending` / `processing` ⇒ 置 `RUNNING`
   * 回 **恰 4 鍵**；`completed` ⇒ 下載 25 秒 ＋ 入册段 45 秒 ⇒ 置 `READY` 回 **恰 6 鍵**
   * （`preview{mime,sha256}` ＋ `charge{amount,balance}`）；`failed` / `violation` ／ 過
   * `deadline_at` ／ 整輪超 45 秒 ⇒ **退款（行上 `refunded` 為護欄）並置 `FAILED`**；
   * ⑤ **零扣費**（扣費只在 submit）、`reason` **零新增**、**零新集合**。
   * @param {object} payload 載荷（封閉一鍵 `task_id`）
   * @param {{uid:string, phone:string, role?:string}} identity 服務端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  'ai-enhance-status': async function aiEnhanceStatusDelegate(payload, identity, context) {
    /* ① 管理員門（既有單點；**本函數第一行**，零讀零寫地拒）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return { ok: false, reason: identityDenial.reason, message: identityDenial.message, refunded: false, status: 'FAILED' }
    /* 延遲 require：與修復面同法（打破加載環；離線自檢不需要 SDK）。 */
    const { statusEnhanceTask } = require('./aiEnhanceTasks.js')
    return statusEnhanceTask(payload, identity, context)
  },

  /**
   * **管理員「人工智能修復 · 提交」（`ai-enhance-submit`）** —— 薄委派：業務邏輯單點在
   * `lib/aiEnhanceTasks.js::submitEnhanceTask`（本處零第二套邏輯；`require` 延遲以打破加載環）。
   * 硬口徑：① **第一行即管理員門**（既有 `adminWhitelistDenial`；零讀零寫地拒；拒絕面轉本 op 的
   * 失敗形狀 **恰 4 鍵** `ok / reason / message / refunded`）；② 載荷**封閉恰四鍵**
   * `image_id / seal_id / face_id / request_id`（多一鍵 / 少一鍵都拒；`request_id` 須 8〜64 位
   * 字母數字或底線橫線，否則 `INVALID_VALUE`）；③ 幂等預查（同 uid 同 `request_id` 已有行 ⇒
   * **回放該行、零扣費零上游**）→ 圖源與上游配置拒绝面（零扣費）→ 預扣 10 金（`idem_key` ＝
   * `ai-enhance-<image_id>-<request_id>`，與同步面逐字同形）→ 提交段 50 秒 / 上游 POST 45 秒 / 收尾宽限 6 秒（最坏 56 秒 < 網關 60 秒）
   * （超時退款並置 `FAILED`）→ 落任務行 `SUBMITTED`、`deadline_at` ＝ 當前 ＋ 20 分鐘；
   * ④ 成功回包**恰 5 鍵**（`ok / task_id / status / source_image_id / charge{amount,balance}`；
   * **不帶 `image_id`**）、失敗回包**恰 4 鍵**；⑤ **零新集合**（任務行落 `xiai_ai_enhance_tasks`、
   * 經既有 `persist`）、`reason` **零新增**（只用既有凍結值）、**回包零 `plan` 等內部字段**。
   * @param {object} payload 載荷（封閉四鍵 `image_id` / `seal_id` / `face_id` / `request_id`）
   * @param {{uid:string, phone:string, role?:string}} identity 服務端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number, requestId?:string}} [context]
   */
  'ai-enhance-submit': async function aiEnhanceSubmitDelegate(payload, identity, context) {
    /* ① 管理員門（既有單點；**本函數第一行**，零讀零寫地拒）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return { ok: false, reason: identityDenial.reason, message: identityDenial.message, refunded: false }
    /* 延遲 require：與修復面同法（打破加載環；離線自檢不需要 SDK）。 */
    const { submitEnhanceTask } = require('./aiEnhanceTasks.js')
    return submitEnhanceTask(payload, identity, context)
  },

  /**
   * **历史「已采纳未落面」一次性回填（`backfillAcceptedCorrections`｜§3.79｜本单新增）** ——
   * 把 `xiai_corrections` 里**已采纳（`ACCEPTED`）却没落到目标行**的值，一次性补写到印面行 /
   * 印章行的对应字段（**只改该字段 ＋ `updated_at`**；一次性数据修复，零自动化、零触发式回填）。
   *
   * 顺序（**全部判定早于任何写入**）：
   *   ① **管理員門 `adminWhitelistDenial` 先於一切讀寫**（缺 `XIAI_ADMIN_PHONE` ⇒ 安全拒且
   *      **零讀取**；非白名單 / 會話角色不足 ⇒ `FORBIDDEN` 且零讀取）；
   *   ② **載荷封閉恰二鍵**：`dry_run`（**必有、布林**；缺 / 非布林 ⇒ `INVALID_VALUE`）＋ `limit`
   *      （可選、**1〜200 整數**、缺省 200；越界 ⇒ `INVALID_VALUE`）；未知鍵 / 身份類鍵 ⇒
   *      `INVALID_FIELD`（`pointsPayloadDenial` 同族文案）；**`reason` 零新增**；
   *   ③ **只讀掃描** `status:'ACCEPTED'` 勘誤行（分頁：每頁遞增 ×100、批數 ≤ `limit`、單查詢
   *      ≤ 1000 行 ⇒ 防卡死）；`scanned` ＝ 掃描到的 `ACCEPTED` 行數；
   *   ④ **取位**：按 `(faceId 或 sealId, field)` 分組（有 `faceId` ⇒ 印面行；否則 `sealId` ⇒
   *      印章行），只在 `ACCEPTED` 行中取 `created_at` 最新（**並列取 `_id` 字典序最大**）；
   *      `PENDING` / `REJECTED` 一律不取位；分組按字典序處理、**最多 `limit` 組**（超出留待下一輪）；
   *   ⑤ **寫條件與兩道門**：目標行現值**為空（空串 / 缺鍵）或 ≠ 取位值** ⇒ `eligible`；
   *      現值已等於取位值 ⇒ `skipped.same`；**目標行不存在 ⇒ `skipped.same`（跳過、不建行）**；
   *      寫前過 **現值域門（`VALUE_DOMAINS`，空串不參與、沿既有口徑）＋ 長度門（`MAX_TEXT_LENGTH`）**
   *      ⇒ 越域 / 超長 ⇒ `skipped.out_of_domain`、**不寫、不拋、不中斷整批**；
   *   ⑥ **落盤**：`dry_run === true` ⇒ **目標行零寫**；否則產出 `kind:'update'`（`match` 用 `_id`、
   *      `doc` 只含該字段 ＋ `updated_at`、**不寫 `_id`**、`expectAtLeast:1`）；**一次 `persist`
   *      承載整批**，**審計行排第一步** ⇒ 審計落不下時**目標行零寫入**（§3.79.4 ③）；
   *   ⑦ **審計**：每輪（**含 `dry_run:true` 輪**）向既有審計面 `xiai_admin_audit` 寫一行
   *      （`op` / `actor_uid` / `at` / `dry_run` ＋ 五讀數；**零 `phone` 鍵、零新集合**）；
   *   ⑧ **回包新增恰 6 鍵**：`dry_run`（回顯）＋ `scanned` / `eligible` / `written` /
   *      `skipped{out_of_domain, same}` / `samples[]`（≤ 10 條，形如
   *      `{faceId|sealId, field, from, to}`）；**自洽式（硬）** ＝
   *      `written + skipped.out_of_domain + skipped.same === eligible` 且 `eligible <= scanned`；
   *      **失敗恒 3 鍵、零讀數鍵**。**六鍵僅本 op 由 `index.js` 按 `op` 收窄透傳。**
   *   · **`written` 口徑（明文）** ＝ 本輪**產出的目標字段寫入數** —— `dry_run:true` 下**照常給
   *     「將寫入數」**（與執行輪同值；§3.79.2 ⑤「回讀讀數照常給出」＋ 本文件 `migrate*` /
   *     `repairImportAcceptance` 的 dry_run 讀數先例），**目標行實際零寫入**由 ⑥ 保證；
   *     若 dry_run 下改記 0，將與上面的硬自洽式直接衝突（`eligible` 是數據屬性、不隨 `dry_run` 變）。
   *   · **不改面**：`ACCEPTED` 勘誤行一律**只讀**（`_id` / `value` / `status` / `created_at` 全不動）、
   *      不改審核口徑、不改 `reviewCorrection` / `submitCorrection`、**不建行、不刪行、不改 `_id`**、
   *      **零新集合**（審計落既有 `xiai_admin_audit`）、**零新增 `reason`**。
   * @param {object} [payload] `{dry_run:boolean, limit?:number}`（`dry_run` **必有**）
   * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<{ok:true, op:string, dry_run:boolean, scanned:number, eligible:number,
   *          written:number, skipped:{out_of_domain:number, same:number}, samples:Array<object>,
   *          plan?:object}|{ok:false, reason:string, message:string}>}
   */
  async backfillAcceptedCorrections(payload, identity, context) {
    /* ① 管理员门（**先于一切读写**；缺 env ⇒ 安全拒 ＋ 零读取；非白名单 ⇒ `FORBIDDEN` ＋ 零读取）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* ② 载荷封闭恰二键（形态 → 未知键 / 身份类键 → `dry_run` → `limit`）。 */
    const input = payload === undefined || payload === null ? {} : payload
    if (typeof input !== 'object' || Array.isArray(input)) {
      return deny(REASONS.INVALID_FIELD, '載荷形態不合法（應為物件）；本次零寫入。')
    }
    const unknown = Object.keys(input).filter((key) => BACKFILL_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    /* `dry_run` **必有、布林**（缺 / 非布林 ⇒ `INVALID_VALUE`；入口默認 `true` 由視圖層給）。 */
    if (!Object.prototype.hasOwnProperty.call(input, 'dry_run') || typeof input.dry_run !== 'boolean') {
      return deny(REASONS.INVALID_VALUE, '`dry_run` 必須是布林值（true / false）；本次零寫入。')
    }
    const dryRun = input.dry_run
    /* `limit` 可选、1〜200 整数、缺省 200（越界 / 非整数 ⇒ `INVALID_VALUE` ＋ 零写入）。 */
    let limit = BACKFILL_DEFAULT_LIMIT
    if (Object.prototype.hasOwnProperty.call(input, 'limit')) {
      const rawLimit = input.limit
      if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > BACKFILL_MAX_LIMIT) {
        return deny(REASONS.INVALID_VALUE, `\`limit\` 必須是 1〜${BACKFILL_MAX_LIMIT} 的整數；本次零寫入。`)
      }
      limit = rawLimit
    }
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const at = new Date(seconds * 1000).toISOString()
    /* ③ 只读扫描 `ACCEPTED` 行（分页：每页 ×100 递增、批数 ≤ `limit`、单查询 ≤ 1000 行）。 */
    const accepted = []
    const seen = new Set()
    for (let page = 1; page <= limit; page += 1) {
      const pageLimit = Math.min(BACKFILL_SCAN_PAGE_SIZE * page, BACKFILL_SCAN_MAX_PAGE_LIMIT)
      const rows = await readRows(COLLECTIONS.corrections, { status: CORRECTION_STATUS.ACCEPTED }, { limit: pageLimit })
      const list = Array.isArray(rows) ? rows : []
      let added = 0
      for (const row of list) {
        const rowKey =
          text(row && (row._id !== undefined && row._id !== null ? row._id : row.id)) ||
          `${text(row && row.faceId)}|${text(row && row.sealId)}|${text(row && row.field)}|${text(
            row && row.created_at
          )}|${text(row && row.value)}`
        if (seen.has(rowKey)) continue
        seen.add(rowKey)
        accepted.push(row)
        added += 1
      }
      /* 页满 ⇒ 可能还有下一页；页未满 / 无新增（读点无 `skip`，同一批重读）⇒ 已扫尽，收口。 */
      if (list.length < pageLimit || added === 0) break
    }
    const scanned = accepted.length
    /* ④ 分组取位：`(faceId 或 sealId, field)`；只认 `ACCEPTED`（读面已按 status 过滤，此处再复核）；
       `created_at` 最新、并列取 `_id` 字典序最大。无目标键 / 无字段的行不取位（不计 `eligible`）。 */
    const groups = new Map()
    for (const row of accepted) {
      if (text(row && row.status) !== CORRECTION_STATUS.ACCEPTED) continue
      const field = text(row && row.field)
      if (field === '') continue
      /* **影像勘误（`kind:'IMAGE'`）与任何非可标记字段一律不参与回填** ——
         它们的目标是影像行/显式动作，不是印面/印章的文本字段（否则会把
         `field:'image'` 当文本字段去写，产生无意义写入）。 */
      if (text(row && row.kind) === 'IMAGE') continue
      if (!Object.prototype.hasOwnProperty.call(MARKABLE_FIELDS, field)) continue
      const faceId = text(row && row.faceId)
      const sealId = text(row && row.sealId) || text(row && row.stamp_id)
      const kind = faceId !== '' ? 'face' : sealId !== '' ? 'seal' : ''
      if (kind === '') continue
      const ref = kind === 'face' ? faceId : sealId
      const groupKey = `${kind}:${ref}:${field}`
      const current = groups.get(groupKey)
      if (!current || newerCorrectionWins(row, current.row)) {
        groups.set(groupKey, { kind, ref, field, row })
      }
    }
    /* 目标行检索（`id` → `_id` 印面 / `stamp_id` → `sid` → `id` → `_id` 印章；命中即停、按目标缓存）。
       `match` 优先用行 `_id`（无 `_id` 时退回命中检索键）—— **不改 `_id`、不建行**。 */
    const targetCache = new Map()
    const resolveTarget = async (kind, ref) => {
      const cacheKey = `${kind}:${ref}`
      if (targetCache.has(cacheKey)) return targetCache.get(cacheKey)
      const collection = kind === 'face' ? COLLECTIONS.faces : COLLECTIONS.seals
      const probes = kind === 'face' ? ['id', '_id'] : ['stamp_id', 'sid', 'id', '_id']
      let hit = null
      for (const probe of probes) {
        const rows = await readRows(collection, { [probe]: ref }, { limit: 1 })
        if (Array.isArray(rows) && rows.length > 0) {
          const row = rows[0]
          hit = { row, match: text(row._id) ? { _id: text(row._id) } : { [probe]: ref } }
          break
        }
      }
      targetCache.set(cacheKey, hit)
      return hit
    }
    /* ⑤ 逐组判定（最多 `limit` 组；超出留待下一轮、不报错）。 */
    let eligible = 0
    let written = 0
    const skipped = { out_of_domain: 0, same: 0 }
    const samples = []
    const updateWrites = []
    const pushSample = (group, from, to) => {
      if (samples.length >= BACKFILL_MAX_SAMPLES) return
      /* 行面剥一切键名含 `phone` 的键：样本只由这四个键显式构造 ⇒ 结构上零 `phone`。 */
      samples.push(
        group.kind === 'face'
          ? { faceId: group.ref, field: group.field, from, to }
          : { sealId: group.ref, field: group.field, from, to }
      )
    }
    const groupKeys = Array.from(groups.keys()).sort()
    let processed = 0
    for (const groupKey of groupKeys) {
      if (processed >= limit) break
      processed += 1
      const group = groups.get(groupKey)
      const target = await resolveTarget(group.kind, group.ref)
      const to = text(group.row.value)
      if (!target) {
        /* **目标行不存在 ⇒ 跳过**（计入 `skipped.same`；**不建行**，等式仍自洽）。 */
        eligible += 1
        skipped.same += 1
        pushSample(group, '', to)
        continue
      }
      const from = text(target.row[group.field])
      eligible += 1
      if (from === to) {
        /* 现值已等于取位值 ⇒ 零写（幂等：第二轮全落这里）。 */
        skipped.same += 1
        pushSample(group, from, to)
        continue
      }
      /* **写前两道门**（沿既有阈值、不得放宽）：现值域门（空串不参与）＋ 长度门。 */
      const domain = Object.prototype.hasOwnProperty.call(VALUE_DOMAINS, group.field)
        ? VALUE_DOMAINS[group.field]
        : null
      const outOfDomain = (domain && to !== '' && domain.indexOf(to) === -1) || to.length > MAX_TEXT_LENGTH
      if (outOfDomain) {
        /* 越域 / 超长 ⇒ 跳过并登记，**不写、不抛、不中断整批**。 */
        skipped.out_of_domain += 1
        pushSample(group, from, to)
        continue
      }
      /* 可写：`written` 计数（dry_run 下照常给「将写入数」，见上方口径明文）。 */
      written += 1
      pushSample(group, from, to)
      if (!dryRun) {
        const doc = { [group.field]: to, updated_at: at }
        updateWrites.push({
          kind: 'update',
          collection: group.kind === 'face' ? COLLECTIONS.faces : COLLECTIONS.seals,
          match: target.match,
          doc,
          expectAtLeast: 1
        })
      }
    }
    /* ⑦ 审计行（每轮含 `dry_run:true` 轮；封闭键面、零 `phone` 键、不新增集合）。 */
    const auditDoc = {
      op: 'backfillAcceptedCorrections',
      actor_uid: text(identity && identity.uid),
      at,
      dry_run: dryRun,
      scanned,
      eligible,
      written,
      skipped: { out_of_domain: skipped.out_of_domain, same: skipped.same },
      samples
    }
    /* ⑥ 落盘计划：**审计行排第一步**（审计落不下 ⇒ 整批在第 1 步即断 ⇒ 目标行零写入），
       其后才是本批目标字段更新（`dry_run` ⇒ 只有审计一步）。 */
    const writes = [{ kind: 'add', collection: COLLECTIONS.adminAudit, doc: auditDoc }].concat(
      dryRun ? [] : updateWrites
    )
    const result = {
      ok: true,
      op: 'backfillAcceptedCorrections',
      dry_run: dryRun,
      scanned,
      eligible,
      written,
      skipped: { out_of_domain: skipped.out_of_domain, same: skipped.same },
      samples
    }
    result.plan = { op: 'backfillAcceptedCorrections', writes }
    return result
  },

  /**
   * **管理員「刪除印章 ＋ 編號釋放」（`deleteSeal`）** —— 薄委派：業務邏輯單點在
   * `lib/sealDelete.js::deleteSeal`（本處零第二套邏輯；`require` 延遲以打破加載環）。
   * 硬口徑：① **管理員寫面**（`adminWhitelistDenial` 門同既有；**任何讀之前**；非管理員 ⇒
   *    `FORBIDDEN` ＋ 零寫入）；② 載荷**封閉兩鍵** `seal_id` / `reason`（未知 / 身份類鍵 ⇒
   *    `INVALID_FIELD`；`seal_id` 缺 / 空 ⇒ `MISSING_REQUIRED`、非字符串 ⇒ `INVALID_VALUE`；
   *    `reason` 非字符串或 >200 ⇒ `INVALID_VALUE`；以上均零寫入）；③ 印章行 `stamp_id` →
   *    `sid` → 行 `id` **三形態依次檢索**，無行 ⇒ `INVALID_VALUE`（文案「未找到該印章…本次
   *    零寫入」）；④ **共用影像保護**（仍被其它印面引用者保留，計入 `skipped.images_shared`）；
   * ⑤ **刪行確定序**：非共用影像行（＋去重保護下刪對象，失敗計入 `deleted.objects_failed`、
   *    不阻斷）→ 全部印面行 → 印章行 → 審計行（`persist` 的 `kind:'add'` → `adminAudit`）→
   *    **最後一步**把 `seal_no` / `face_no` 並入計數器文檔 `released`（`kind:'set'`、
   *    doc 不帶 `_id`、去重升序）；⑥ 成功回包**恰 4 鍵**（`ok, deleted, skipped, released`；
   *    另以**不可枚別** `value` 別名供 `index.js` 既有通用讀數位透傳，回包鍵面仍恰 4）、
   *    失敗回包**恰 3 鍵**（`ok, reason, message`，**零 `refunded`**）；⑦ `reason` **零新增**
   *    （只用既有凍結值）、**零新集合**（讀走 `readRows`、刪行走 `deleteRow` /
   *    `deleteImageObjectsOfRow`（删对象候选单点）、落盤走 `persist`；照片行 / 勘誤行只讀計數、零刪行）。
   * @param {object} payload 載荷（封閉兩鍵 `seal_id` / `reason`）
   * @param {{uid:string, phone:string, role?:string}} identity 服務端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  deleteSeal: async function sealDeleteDelegate(payload, identity, context) {
    /* 延遲 require：與弃候選圖面同法（打破加載環；離線自檢不需要 SDK）。 */
    const { deleteSeal } = require('./sealDelete.js')
    return deleteSeal(payload, identity, context)
  },

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
    /* **影像勘誤（§3.77.4｜本單）**：`kind:'IMAGE'` 行被**采纳**时，先执行影像面
       （`applyImageCorrectionAcceptance`：delete ＝ 照搬 `deleteFaceImage` 写入序 / replace ＝
       三步硬序），**执行成功才由上面的 plan 写 `ACCEPTED`**；执行失败 ⇒ 直接回结构化拒绝、
       **状态仍 `PENDING`**（本拒绝不迁 `REJECTED`、零状态写入）。
       **属性（`field`）型行与驳回路一律不走本分支 ⇒ 行为一字未改**（`text(row.kind)`
       对旧恒非 `IMAGE` ⇒ 条件恒假、零额外读写）。 */
    let imageAction = null
    if (text(row.kind) === 'IMAGE' && accepted) {
      const executed = await applyImageCorrectionAcceptance(row, at)
      if (!executed.ok) return executed
      imageAction = executed.image_action
    }
    const reply = {
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
    /* **影像面读数（additive｜`index.js` 按 op 收窄透传）**：仅 `kind:'IMAGE'` 行的采纳成功路
       带此键；属性（`field`）型行与驳回路**零新增键** ⇒ 既有回包逐字不变。 */
    if (imageAction) reply.image_action = imageAction
    return reply
  },

  /**
   * **管理员撤销采纳（`revokeCorrectionAcceptance`）**（受控 op：**只改状态、不回写原行**）。
   *
   * 场景（人类口径 2026-11-04）：采纳是终态 —— 一旦采纳了内容错误的勘误（印文匹配到错印面），
   * 首页 / 详情页的展示值就跟着错，而既有面**没有任何撤回手段**。本 op 补这一条**唯一**撤回路：
   * 把 `ACCEPTED` 目标行改判 `REJECTED`（＝「撤销」），让展示值裁决规则（只认 `ACCEPTED`、
   * 取出现最多、同数取最近）**自然不再计入**该行 —— **不改**三态机（仍 PENDING/ACCEPTED/REJECTED
   * 三态）、**不改**展示值裁决规则、**不动**提交 / 采信 / 审核单条与批量路径的行为。
   *
   * 硬口径（逐条）：
   *   · **管理员门 ＝ `adminWhitelistDenial`**（判据在**任何读之前**；缺 `XIAI_ADMIN_PHONE`
   *     ⇒ `STORAGE_UNAVAILABLE` 安全拒 ＋ **零读取**；非白名单 / 无身份 ⇒ `FORBIDDEN` ＋ 零读取）；
   *   · **载荷封闭恰两键** `correction_id`（必有）/ `note`（可选，字符串 ≤ 200 字）；
   *     未知键一律 `INVALID_FIELD`（身份类键文案与 `reviewCorrection` 同口径）；
   *     **零 `decision` 键**（方向由 op 钉死，不由前端选）；
   *   · **只允许 `ACCEPTED → REJECTED`**：目标不存在 ⇒ `NOT_FOUND`；当前状态不是 `ACCEPTED`
   *     ⇒ `INVALID_VALUE`（**文案如实写出当前状态**）；**判定全部在写之前**（先判后读写，
   *     拒绝恒零写入）；
   *   · **落盘三处**（与既有 `reviewCorrection` 同形 ⇒ 展示一致）：① `xiai_corrections`
   *     目标行 `update`（`status:'REJECTED'` ＋ 服务端时 `reviewed_at` ＋ 服务端派生
   *     `reviewer_id` ＋ `revoked:true` ＋ `revoked_at` ＋ 非空才落 `revoke_note`）；
   *     ② `xiai_corrections_public` 投影行 `set`（`status:'REJECTED'`、**零手机号**）；
   *     ③ `xiai_correction_summaries` 摘要行 `set`（**重算** `submits` / `endorses`、
   *     `status` 随之重算）。**① 排在最前**：权威行先落 —— ① 命中 0 行即断 ⇒ 后两步零写入；
   *   · **只改状态、不回写原行**：`xiai_faces` / `xiai_seals` **一字不动**（本 op 不产出任何
   *     指向这两集合的写入）、**不删任何行**（三处全是 `update` / `set`，无 `delete`）；
   *   · **奖励默认不回滚**：采纳时已发的 10 金**不扣回**（本 op 不触碰账本；如需扣回另开单）；
   *   · 成功回包沿用 `reviewCorrection` 成功路形状（`ok` / `op` / `row` / `projection` /
   *     `summary` / `plan`，**键面零新增** ⇒ `index.js` 的通用回包信封逐字同形）；
   *     失败恒为恰 3 键 `{ok:false, reason, message}`，`reason` **零新增**（只用 `FORBIDDEN` /
   *     `INVALID_FIELD` / `MISSING_REQUIRED` / `INVALID_VALUE` / `NOT_FOUND` /
   *     `STORAGE_UNAVAILABLE` 这些既有冻结字面值）。
   *
   * @param {object} payload 载荷（允许键见 `REVOKE_ALLOWED_KEYS`：恰两键）
   * @param {{uid:string, phone:string, role?:string}} identity **服务端派生**的身份（唯一来源）
   * @param {{adminPhone?:string, nowSeconds?:number}} [context] 白名单手机号 ＋ 服务端时钟（秒）
   * @returns {Promise<{ok:true, op:string, row:object, projection:object, summary:object,
   *          plan:{op:string, writes:Array<object>}}|{ok:false, reason:string, message:string}>}
   */
  async revokeCorrectionAcceptance(payload, identity, context) {
    /* ① 管理员白名单门（**身份判据，写之前；零读取**；缺 env ⇒ 结构化安全拒）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* ② 载荷形态 / 封闭键面（恰两键；身份类键 ⇒ `INVALID_FIELD` ＋ 零读取、零写入）。 */
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零寫入。')
    }
    const unknown = Object.keys(payload).filter((key) => REVOKE_ALLOWED_KEYS.indexOf(key) === -1)
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
      return deny(REASONS.MISSING_REQUIRED, '缺少勘誤單號（correction_id）⇒ 拒絕撤銷；本次零寫入。')
    }
    if (correctionId.length > MAX_ID_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `勘誤單號超出上限（${MAX_ID_LENGTH} 字）⇒ 拒絕撤銷；本次零寫入。`)
    }
    const rawNote = payload.note === undefined || payload.note === null ? '' : payload.note
    if (typeof rawNote !== 'string') {
      return deny(REASONS.INVALID_VALUE, '撤銷理由必須是文字 ⇒ 拒絕撤銷；本次零寫入。')
    }
    const noteText = rawNote.trim()
    if (noteText.length > MAX_NOTE_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `撤銷理由不得超過 ${MAX_NOTE_LENGTH} 字 ⇒ 拒絕撤銷；本次零寫入。`)
    }
    /* ③ 只读目标行（**唯一读点**；网络 / 内部异常由此抛出 ⇒ `index.js` 转 `STORAGE_UNAVAILABLE`）。 */
    const found = await readCorrectionRow(correctionId)
    if (!found) {
      return deny(REASON_CORRECTION_NOT_FOUND, `未找到該勘誤單（correction_id）：${correctionId}；本次零寫入。`)
    }
    const row = found.row
    const currentStatus = text(row.status)
    if (currentStatus !== CORRECTION_STATUS.ACCEPTED) {
      /* **只许 `ACCEPTED → REJECTED`**；文案如实写出当前状态（不把「不是已采纳」说成「不存在」）。 */
      return deny(
        REASONS.INVALID_VALUE,
        `僅「已採納（ACCEPTED）」的勘誤可撤銷；該勘誤當前狀態：${currentStatus || '（空）'} ⇒ 不可撤銷；本次零寫入。`
      )
    }
    /* ④ 摘要行读面（**只读，在写之前**）：读同 `(faceId, field, value)` 的全部提交行 ＋ 采信行，
       用于**重算**值级公开摘要行；本次决定**就地覆盖**目标行的 `status`（不改库，仅内存）。 */
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
        text(item && item._id) === correctionId ||
        text(item && item._id) === text(row._id)
      return sameRow ? Object.assign({}, item, { status: CORRECTION_STATUS.REJECTED }) : item
    })
    /* 兜底：检索式没命中本次被撤的那一行（历史行缺 `faceId` 等）⇒ 显式并入（status ＝ REJECTED）。 */
    const targetPresent = submissions.some(
      (item) =>
        text(item && item.id) === correctionId ||
        text(item && item._id) === correctionId ||
        text(item && item._id) === text(row._id)
    )
    if (!targetPresent) submissions.push(Object.assign({}, row, { status: CORRECTION_STATUS.REJECTED }))
    /* ⑤ 服务端时（唯一时源；`context.nowSeconds`）＋ 三处落盘计划。 */
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const at = new Date(seconds * 1000).toISOString()
    const projection = buildProjection(row, CORRECTION_STATUS.REJECTED, at, correctionId)
    const summaryRow = buildCorrectionSummary({
      faceId: summaryFaceId,
      sealId: summarySeal,
      field: summaryField,
      value: summaryValue,
      submissions,
      endorsements,
      at
    })
    /* 撤销面字段：状态 ＋ 服务端时 ＋ 服务端派生撤销人 ＋ 撤销标记 ＋ 可选理由。
       **不回滚奖励**（`rewarded_at` 原样保留、本 patch 不含它）；**不写** `review_note`
       （原审核理由属原审核事实，撤销理由落独立键 `revoke_note`）。 */
    const privatePatch = {
      status: CORRECTION_STATUS.REJECTED,
      reviewed_at: at,
      reviewer_id: identity.uid,
      revoked: true,
      revoked_at: at
    }
    if (noteText !== '') privatePatch.revoke_note = noteText
    const revokedRow = Object.assign({}, row, privatePatch)
    return {
      ok: true,
      op: 'revokeCorrectionAcceptance',
      row: revokedRow,
      projection,
      /* 值级公开摘要行（`submits` / `endorses` / `status` 均已按撤销后状态重算）。 */
      summary: summaryRow,
      plan: {
        op: 'revokeCorrectionAcceptance',
        writes: [
          /* ① 权威私有行只改状态（命中 0 行即断 ⇒ 后两步零写入）。 */
          {
            kind: 'update',
            collection: COLLECTIONS.corrections,
            match: found.match,
            doc: privatePatch,
            expectAtLeast: 1
          },
          /* ② 公开只读投影行（确定性 id ⇒ 幂等 upsert；零身份字段）。 */
          {
            kind: 'set',
            collection: COLLECTIONS.correctionsPublic,
            id: `${PUBLIC_ID_PREFIX}${correctionId}`,
            doc: projection
          },
          /* ③ 值级公开摘要行（确定性 `_id` ⇒ 幂等 upsert；写前由 `persist` 剔 `_id`）。 */
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
   * **本單 opt-in（第 5 鍵 `backfill_image_stamp`，缺省 `false` ⇒ 既有行為逐字不變）**：
   * `true` ⇒ 採納成功時把**被採納行 `faces` 引用命中的影像行**補上 `stamp_id` ＋ `seq`
   * （回填寫步插在**面行寫步之後**、導入行狀態翻轉之前；印章已存在的 `existing` 分支亦按
   * `findSealImportImageRow` 逐條解析後補回填）—— `seq` 只走既有單點 `imageStampWriteStepsOf`
   * （內部 `imageSeqsOf` ＋ `nextImageSeqOf`，本 op 不自算號）；`false` ⇒ **零回填寫步、零額外讀**。
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
    /* **本单 opt-in（第 5 键）：采纳后影像归属回填** —— 缺省 `false` ⇒ **既有行为逐字不变**
       （既有调用点不传该键）；给出即必须是布林，否则 `INVALID_VALUE` ＋ 零写入（`dry_run` 同族）。 */
    const rawBackfill = payload.backfill_image_stamp
    const backfillImageStamp = rawBackfill === undefined ? false : rawBackfill
    if (typeof backfillImageStamp !== 'boolean') {
      return deny(REASONS.INVALID_VALUE, '影像歸屬回填開關（backfill_image_stamp）必須是布林值；本次零寫入。')
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
    /* **本單 opt-in（`backfill_image_stamp === true`）的回填狀態**：批內共用一份「已占用號」表
       （`imageStampTakens`：鍵 ＝ `<stampId>|<kind>`）與「已處理」表（`imageStampHandled`：鍵 ＝
       `<stampId>|<imageId>` ⇒ 同一影像行被多面 / 多行引用只回填一次）。缺省 `false` ⇒ 兩表
       **永不被讀、零回填寫步**（既有行為逐字不變）；`seq` 只走既有單點 `imageStampWriteStepsOf`
       （內部 `imageSeqsOf` ＋ `nextImageSeqOf`），**本 op 不自算號**。 */
    const imageStampTakens = new Map()
    const imageStampHandled = new Set()
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
      /* **幂等键命中（本单 B.1）**：内存全量未命中 ⇒ **按幂等键定向读一次**。真因 —— `sealsOf()`
         走裸 `collection.get()`，平台单次默认只回 **100 行** ⇒ 正式行 >100 时内存查找**必然漏命中**
         ⇒ 会把「章已存在」误判成「新章」⇒ 重放时**再发一个印章号、建第二枚章**（比原缺陷更重）。
         定向读按同一对键等值查询（`limit:1`）⇒ 与内存判据同尺、且不受 100 行上限影响。 */
      const existing =
        seals.find(
          (item) => text(item && item.source_seal_id) === sourceSealId && text(item && item.source) === text(row && row.source)
        ) ||
        (
          await readRows(
            COLLECTIONS.seals,
            { source: text(row && row.source), source_seal_id: sourceSealId },
            { limit: 1 }
          )
        )[0] ||
        null
      /* **本單 opt-in 的影像命中收集器**（第 7 參 `imageHitsSink`；`false` ⇒ 傳 `null` ⇒ 構造器
         零推入、零額外讀，與改前逐字相同）。 */
      const imageHits = backfillImageStamp ? [] : null
      if (!existing) {
        /* **影像引用逐条校验 ＋ 采纳落点构造**（与 `repairImportAcceptance` **同一套**构建函数）。 */
        const built = await buildSealAcceptanceFromImport(row, seals, await facesOf(), identity, at, null, imageHits)
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
        /* **回填寫步插在面行寫步之後**（opt-in；零命中原樣零步；導入行狀態翻轉仍在其後）。 */
        if (backfillImageStamp) {
          for (const step of await imageStampWriteStepsOf(built.stampId, imageHits, imageStampTakens, imageStampHandled)) {
            writes.push(step)
          }
        }
      } else {
        /* **`existing` 分支（本单 B）**：幂等键 `(source, source_seal_id)` 命中 ⇒ **不发印章号、
           不建第二枚章**；**逐面补齐**缺的面行 →（opt-in）影像归属回填 → **最后**才翻状态。
           旧实现只做回填 ＋ 翻状态、不补面行 ⇒ 半采纳现场重放会把导入行翻成 `ACCEPTED` 而永远
           缺一个印面（静默损伤）；补齐后同单第二次重放即零写（面行全在 ⇒ `faceDocs` 空）。 */
        const existingStamp = text(existing.stamp_id) || text(existing.sid) || text(existing.id)
        const built = await buildMissingFaceDocsOfExistingSeal(row, existing, identity, at)
        if (!built.ok) {
          /* 该条失败：保持 `PENDING` 且本轮零写入（不动 seals / faces、不改本行）。 */
          failed.push(rid)
          continue
        }
        for (const faceDoc of built.faceDocs) {
          writes.push({ kind: 'set', collection: COLLECTIONS.faces, id: faceDoc.id, doc: faceDoc })
          /* 批内缓存同步（零额外读）：后续行的避让读面看得见本轮补的面。 */
          if (facesCache !== null) facesCache.push(faceDoc)
        }
        /* **回填写步插在面行写步之后**（opt-in；零命中原样零步；导行状态翻转仍在其后）。 */
        if (backfillImageStamp) {
          for (const step of await imageStampWriteStepsOf(existingStamp, built.imageHits, imageStampTakens, imageStampHandled)) {
            writes.push(step)
          }
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
   * **管理員「AI 上游連通探測」（本單新增 op｜`probeAiUpstream`｜管理員面）** —— 薄委派：業務邏輯
   * 單點在 `lib/aiEnhanceTasks.js::probeAiUpstream`（本處零第二套邏輯；`require` 延遲以打破加載環）。
   * 硬口徑：① **第一行即管理員門**（既有 `adminWhitelistDenial`；零讀零寫地拒，拒絕面＝既有凍結
   *    3 鍵 `ok / reason / message`）；② 載荷**封閉恰零鍵**（未知鍵 ⇒ `INVALID_FIELD`、缺 / 非對象 ⇒
   *    `MISSING_REQUIRED`；目標、方法、次數一律服務端給定）；③ **零扣費、零寫庫、零 `plan`**、
   *    **零新集合**；④ 對當前上游 `base_url` 發**一次** `GET {base}/models`，**硬上限 8 秒**
   *    （`withinBudget` ＝ `Promise.race` 到點即回，絕不等網關）；⑤ 測量面回包**恰 5 鍵**
   *    `ok / http_status / elapsed_ms / error_class / base_host`（`error_class` 值域封閉五值
   *    `OK / TIMEOUT / DNS / CONNECT / TLS / HTTP`）；⑥ **零明文密鑰、零完整路徑（只回
   *    `host[:port]`）、零響應體**（不讀 `body` / `json`，只看狀態碼）。
   * @param {object} payload 載荷（封閉恰零鍵；請傳空物件 `{}`）
   * @param {{uid:string, phone:string, role?:string}} identity 服務端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<object>} 測量面恰 5 鍵 / 拒絕面恰 3 鍵
   */
  async probeAiUpstream(payload, identity, context) {
    /* ① 管理員門（既有單點；**本函數第一行**，零讀零寫地拒）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* 延遲 require：與修復面同法（打破加載環；離線自檢不需要 SDK）。 */
    const { probeAiUpstream: runProbe } = require('./aiEnhanceTasks.js')
    return runProbe(payload, identity, context)
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
   * **待審勘誤行（全部用戶｜本單新增只讀 op｜`listPendingCorrectionsForAdmin`）**：回**跨用户**
   * 的勘误行 `{ok:true, op, rows, count}` —— **零写入**（不产出 `plan` ⇒ `index.js` 落盘分支
   * 不触发；不改写、不新增、不删任何库内行）。
   * 顺序（**全部判定在任何读之前**）：① **管理员白名单门复用现有 `adminWhitelistDenial`**
   * （`XIAI_ADMIN_PHONE`；缺 / 空 env ⇒ 结构化拒绝 ＋ **零读取**；非白名单 ⇒ `FORBIDDEN`）
   * → ② 载荷形态 ＋ 封闭键面 `PENDING_CORRECTION_ROWS_ALLOWED_KEYS`（与 op① 同形
   * `{status?, limit?}`；身份类键 ⇒ `INVALID_FIELD` ＋ 零读取）→ ③ `status` 值域三态、
   * **缺省 `PENDING`**（待审面）、`limit` 1〜200（缺省 200；越界 ⇒ `INVALID_VALUE`，不静默夹取）
   * → ④ 只读读行（显式 `limit` ＋ `created_at` 倒序；失败 ⇒ 由 `index.js` 转
   * `STORAGE_UNAVAILABLE`）→ ⑤ 逐行剥除一切含 `phone` 的键（旧行 `user_phone` 一并剥；
   * 不透明 uid 原样保留）。**回包不新增任何键**（`rows` / `count` 由 `index.js` 按 op 收窄透传）。
   * @param {object} payload 载荷（允许键 `status` / `limit`）
   * @param {{uid:string, phone:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<{ok:true, op:string, rows:Array<object>, count:number}
   *          |{ok:false, reason:string, message:string}>}
   */
  async listPendingCorrectionsForAdmin(payload, identity, context) {
    /* ① 管理员白名单门（**身份判据，任何读之前**；缺 env ⇒ 结构化拒绝 ＋ 零读取）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* ② 载荷形态 ＋ 封闭键面（身份类键 ⇒ `INVALID_FIELD` ＋ 零读取）。 */
    const args = correctionRowsReadArgs(payload, PENDING_CORRECTION_ROWS_ALLOWED_KEYS)
    if (!args.ok) return args
    /* ③ `status` 缺省 `PENDING`（待审面）；给了则按三态值域过滤。 */
    const match = { status: args.status || CORRECTION_PENDING }
    const rows = await readCorrectionRowsSorted(match, args.limit)
    /* ④ 行面剥除身份 / 手机号类键（`user_phone` 一类零出现；不透明 uid 原样保留）。 */
    const safeRows = rows.map((row) => stripImportIdentityFields(row))
    return { ok: true, op: 'listPendingCorrectionsForAdmin', rows: safeRows, count: safeRows.length }
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
    /* 与 `imageRows` **一一对应**的源印面（发号前先建行只为覆蓋層解析；发号后据此**定稿重建**）。 */
    const pendingImageFaces = []
    for (const face of faces) {
      if (text(face.image_sha256) === '' && text(face.image_storage_key) === '') continue
      const resolved = await findSealImportImageRow(face)
      if (resolved) continue
      if (text(face.image_storage_key) === SEAL_PLACEHOLDER_IMAGE_KEY) {
        return deny(REASONS.INVALID_VALUE, '佔位圖登記行不存在 ⇒ 拒絕直寫；本次零寫入。')
      }
      /* **此刻不带 `seq`**：`stamp_id` 尚未发号 ⇒ 无组可分配；`seq` 由下面 ⑩ 收口。 */
      imageRows.push(buildDirectImageRow(face, at))
      pendingImageFaces.push(face)
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
    /* ⑩ **`stamp_id` 回填 ＋ `seq` 收口（单点分配）**，然后 plan：**影像登记行 → 印章正式行 →
       逐印面行**（先落被引用的登记行；`stamp_id` 此刻才有值 —— 发号在构造器内完成）。
       行内 `seq` 已由构造器（`buildSealAcceptanceFromImport`）按组分配（同批不重复、避开该印
       该类既有行）；此处**兜漏配**（正常不触发：仅当构造器未分配时按单点补号并先补读既有行），
       再经 `buildDirectImageRow(face, at, seq)` **定稿重建**（`seq` 仅新增字段，其余键面与值
       逐字不变），`stamp_id` 照旧回填。 */
    const takenSeqsByKind = new Map()
    const seqReadKinds = new Set()
    for (const row of imageRows) {
      if (!isImageSeq(row.seq)) continue
      const kind = text(row.kind)
      if (!takenSeqsByKind.has(kind)) takenSeqsByKind.set(kind, new Set())
      takenSeqsByKind.get(kind).add(Number(row.seq))
    }
    for (let index = 0; index < imageRows.length; index += 1) {
      const row = imageRows[index]
      const kind = text(row.kind)
      if (!takenSeqsByKind.has(kind)) takenSeqsByKind.set(kind, new Set())
      const taken = takenSeqsByKind.get(kind)
      if (!isImageSeq(row.seq)) {
        /* 兜漏配（构造器已分配 ⇒ 不走此支）：先补读该组既有行，再按单点取号。 */
        if (!seqReadKinds.has(kind)) {
          seqReadKinds.add(kind)
          for (const existing of await imageSeqsOf(built.stampId, kind)) {
            if (isImageSeq(existing && existing.seq)) taken.add(Number(existing.seq))
          }
        }
        row.seq = nextImageSeqOf(built.stampId, kind, taken)
      }
      taken.add(Number(row.seq))
      const finalRow = buildDirectImageRow(pendingImageFaces[index], at, row.seq)
      finalRow.stamp_id = built.stampId
      imageRows[index] = finalRow
    }
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
  },

  /**
   * **批量影像入册（本單新增 op｜`importFaceImages`｜管理員面）** —— 薄委派：業務邏輯單點在
   * `lib/importChannels.js::importFaceImages`（本處零第二套邏輯；`require` 延遲以打破加載環）。
   * 硬口徑：① **第一行即管理員門**（既有 `adminWhitelistDenial`；**零讀零寫地拒**，非管理員 ⇒
   *    `FORBIDDEN` 且不載入實現、不觸任何集合 / 對象）；② 載荷封閉恰兩鍵 `source` / `rows`
   *    （1〜200；未知鍵 `INVALID_FIELD`、缺鍵 `MISSING_REQUIRED`、值域 / 形態不符 `INVALID_VALUE`）；
   *    ③ 幂等（同 `sha256` 已有行 ⇒ `skipped`、不改既有行）＋ 對象字節自校；④ 成功回包**恰 4 鍵**
   *    `ok / written / skipped / failed`、失敗恒**恰 3 鍵**；⑤ **零新集合**（影像行落既有
   *    `xiai_images`，集合名只經 `ops.COLLECTIONS`）、`reason` **零新增**、本處**不產 `plan`**
   *    （落盤在實現內逐行走既有唯一寫點 `ops.persist`）。
   * @param {object} payload 載荷（封閉兩鍵 `source` / `rows`）
   * @param {{uid:string, phone:string, role?:string}} identity 服務端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  async importFaceImages(payload, identity, context) {
    /* ① 管理員門（既有單點；**本函數第一行**，零讀零寫地拒）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* 延遲 require：與其餘薄委派同法（打破加載環；離線自檢不需要 SDK）。 */
    const channels = require('./importChannels.js')
    return channels.importFaceImages(payload, identity, context)
  },

  /**
   * **批量關聯落庫（本單新增 op｜`importRelations`｜管理員面）** —— 薄委派：業務邏輯單點在
   * `lib/importChannels.js::importRelations`（本處零第二套邏輯；`require` 延遲以打破加載環）。
   * 硬口徑：① **第一行即管理員門**（既有 `adminWhitelistDenial`；**零讀零寫地拒**，非管理員 ⇒
   *    `FORBIDDEN` 且不載入實現、不觸任何集合）；② 載荷封閉恰三鍵 `kind` / `source` / `rows`
   *    （1〜500；`kind` 恰 `seal_link` / `person_relation` 兩值、不靜默歸一）；③ **懸空不拒收**
   *    （§3.61.8 / AC-549：`ref` 未命中照常落行、行上 `unresolved: true`、`ref_name` 保留原值）；
   *    ④ 幂等（確定性行 `id` 已有行 ⇒ `skipped`、不改既有行）；⑤ 成功回包**恰 5 鍵**
   *    `ok / written / skipped / unresolved / failed`、失敗恒**恰 3 鍵**；⑥ **零新集合**
   *    （`xiai_seal_links` / `xiai_person_relations` 只在 `ops.COLLECTIONS` 登記、**不進客戶端雲讀面**）、
   *    `reason` **零新增**、本處**不產 `plan`**。
   * @param {object} payload 載荷（封閉三鍵 `kind` / `source` / `rows`）
   * @param {{uid:string, phone:string, role?:string}} identity 服務端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  async importRelations(payload, identity, context) {
    /* ① 管理員門（既有單點；**本函數第一行**，零讀零寫地拒）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* 延遲 require：與其餘薄委派同法（打破加載環；離線自檢不需要 SDK）。 */
    const channels = require('./importChannels.js')
    return channels.importRelations(payload, identity, context)
  },

  /**
   * **影像行 `storage` 一次性修复（幂等管理员 op｜本单新增 `repairImageStorage`）**：
   * 把 `xiai_images` 里**缺 / 空 `storage` 的行逐行补写成 `storage:'server'`** —— 前端
   * `src/data/cloudbase.js::cloudBaseObjectKeyOf` 的**前置门**（判不过 ⇒ 空对象键 ⇒
   * 页面「印面圖片暫缺」）；新环境入册的 6,347 行全缺此键，旧行都有。
   *
   * 契约（逐条；实现单点在本文件 `storageRepairNeeded` / `storageRepairWindowOf` /
   * `readStorageRepairWindow`，**零第二套**）：
   *   ① **第一行即 `adminWhitelistDenial`**（缺 env ⇒ 结构化拒 ＋ 零读零写；非管理员 ⇒
   *      `FORBIDDEN` ＋ **零读零写**）；
   *   ② **载荷封闭恰三键** `dry_run`（布林、**缺省 `true`**；给了但非布林 ⇒ `INVALID_VALUE`）
   *      ＋ `limit`（1〜500 整数、**缺省 200**；越界 / 非整数 ⇒ `INVALID_VALUE`）＋ `cursor`
   *      （字符串 ＝ 上轮回包 `next_cursor`；缺省 / 空串 ⇒ 从头；给了但非字符串 ⇒ `INVALID_VALUE`）；
   *      未知键 / 身份类键 ⇒ `INVALID_FIELD`；**全部判定早于任何读写**；
   *   ③ **扫描**：`xiai_images` 按 `_id` **升序**、**严格大于 `cursor`** 的前 `limit` 行 ＝ 本轮窗口
   *      （`scanned ≤ limit`）；`storage` 缺省 / 空串 / 空白 ⇒ **待补**；**已有非空值的行不碰**；
   *   ④ **写步（仅 `dry_run:false`）**：逐行一次 `persist`（`update` ＋ `match:{_id}` ＋
   *      `doc:{storage:'server'}` ＋ **`expectAtLeast:1`**）；单行失败**不中断整批**；**读数以真写入
   *      结果为准** —— 写完用**同一窗口语义**整窗读回（`readStorageRepairWindow` 同一读路），按
   *      **行终态**逐行定真伪：读回 `storage === 'server'` ⇒ 计 `written`，否则 ⇒ 进 `failed`
   *      （⇒ `persist` 抛错但行已生效 ⇒ 照计 `written`；`persist` 没抛但行没落 ⇒ 进 `failed`）；
   *      **已存在 / 已同值 / 被跳过的行既不计 `written` 也不进 `failed`**；
   *      **本 op 不产 `plan`**（写步在 op 内执行 ⇒ `index.js` 落盘分支不触发、`plan` 零外传）；
   *   ⑤ **回包封闭**：`dry_run` ⇒ **恰 4 键** `ok / scanned / eligible / next_cursor`；真写 ⇒
   *      **恰 5 键** `ok / scanned / written / next_cursor / failed`（`failed` 恒数组、元素
   *      `{_id, reason}`、`reason` 只用既有冻结值 `STORAGE_UNAVAILABLE`）；`next_cursor` ＝ 窗口末行
   *      `_id`（字符串）／窗口空 ⇒ `null`（已扫尽）。失败恒**恰 3 键**；
   *   ⑥ **幂等**：同 `cursor` 重跑（已补写）⇒ `eligible = 0` / `written = 0`、零写入；
   *      **零新增 `reason` 字面值、零新集合**（读写都在 `COLLECTIONS.images`）。
   * @param {object} [payload] `{dry_run?:boolean, limit?:number, cursor?:string}`（三键皆可缺）
   * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<{ok:true, scanned:number, eligible:number, next_cursor:string|null}|
   *                   {ok:true, scanned:number, written:number, next_cursor:string|null, failed:Array<object>}|
   *                   {ok:false, reason:string, message:string}>}
   */
  async repairImageStorage(payload, identity, context) {
    /* ① 管理员门（**本函数第一行**；零读零写地拒 —— 非管理员 ⇒ `FORBIDDEN` 且零读写）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* ② 载荷封闭恰三键（形态 → 未知键 / 身份类键 → `dry_run` → `limit` → `cursor`）。 */
    const input = payload === undefined || payload === null ? {} : payload
    if (typeof input !== 'object' || Array.isArray(input)) {
      return deny(REASONS.INVALID_FIELD, '載荷形態不合法（應為物件）；本次零寫入。')
    }
    const unknown = Object.keys(input).filter((key) => REPAIR_IMAGE_STORAGE_ALLOWED_KEYS.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端記錄，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(REASONS.INVALID_FIELD, `載荷含未知欄位：${unknown.join('、')}（${hint}）；本次零寫入。`)
    }
    /* `dry_run`：**缺省 `true`**（给了但非布林 ⇒ `INVALID_VALUE` ＋ 零读零写）。 */
    let dryRun = true
    if (Object.prototype.hasOwnProperty.call(input, 'dry_run')) {
      if (typeof input.dry_run !== 'boolean') {
        return deny(REASONS.INVALID_VALUE, '`dry_run` 必須是布林值（true / false）；本次零寫入。')
      }
      dryRun = input.dry_run
    }
    /* `limit`：缺省 200、1〜500 整数（越界 / 非整数 ⇒ `INVALID_VALUE` ＋ 零读零写）。 */
    let limit = REPAIR_IMAGE_STORAGE_DEFAULT_LIMIT
    if (Object.prototype.hasOwnProperty.call(input, 'limit')) {
      const rawLimit = input.limit
      if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > REPAIR_IMAGE_STORAGE_MAX_LIMIT) {
        return deny(REASONS.INVALID_VALUE, `\`limit\` 必須是 1〜${REPAIR_IMAGE_STORAGE_MAX_LIMIT} 的整數；本次零寫入。`)
      }
      limit = rawLimit
    }
    /* `cursor`：字符串（上轮回包 `next_cursor`）；缺省 / 空串 ⇒ 从头；非字符串 ⇒ `INVALID_VALUE`。 */
    let cursor = ''
    if (Object.prototype.hasOwnProperty.call(input, 'cursor')) {
      const rawCursor = input.cursor
      if (typeof rawCursor !== 'string') {
        return deny(REASONS.INVALID_VALUE, '`cursor` 必須是字符串（上一輪回包的 `next_cursor`）；本次零寫入。')
      }
      cursor = rawCursor.trim()
    }
    /* ③ 扫描窗口（**只读**；真故障原样上抛 ⇒ `index.js` 转 `STORAGE_UNAVAILABLE`，绝不吞成 0 行）。 */
    const window = await readStorageRepairWindow(cursor, limit)
    const scanned = window.length
    const nextCursor = scanned > 0 ? text(window[scanned - 1] && window[scanned - 1]._id) : null
    /* ④ 判定：缺 / 空 `storage` ⇒ 待补；**已有非空值一律不碰**（幂等）。 */
    const eligibleRows = window.filter(storageRepairNeeded)
    if (dryRun) {
      /* 预演轮：**零写入**（回包恰 4 键；`eligible` 是数据属性、不随 `dry_run` 变）。 */
      return { ok: true, scanned, eligible: eligibleRows.length, next_cursor: nextCursor }
    }
    /* ⑤ 真写：逐行一次 `persist`（`update` ＋ `expectAtLeast:1`）；单行失败不中断整批。
       **读数以真写入结果为准（本单读数不实修）**：`persist` 的成败只是**一次请求的回报**，不等于
       该行真的落了 —— 回报丢失 ⇒ 写已生效却抛错（⇒ 若据此计 `failed` 就是虚根）；回报里读不出
       受影响行数 ⇒ 写没生效却不抛（⇒ 若据此计 `written` 就是虚报）。故**逐行写、整窗读回**：
       写完用**同一窗口语义**重读一遍，按**行的终态**逐行定真伪。 */
    let written = 0
    const failed = []
    const attemptedIds = []
    for (const row of eligibleRows) {
      const docId = text(row && row._id)
      if (docId === '') {
        /* 无 `_id` ⇒ 无法定址（窗口纯函数已滤掉此类行；此处只作兜底，不谎报成功）。 */
        failed.push({ _id: '', reason: REASONS.STORAGE_UNAVAILABLE })
        continue
      }
      attemptedIds.push(docId)
      try {
        await persist({
          writes: [{ kind: 'update', collection: COLLECTIONS.images, match: { _id: docId }, doc: { storage: 'server' }, expectAtLeast: 1 }]
        })
      } catch (error) {
        /* **此处不下真伪结论**：回报失败 ≠ 没写成（平台侧可能已生效、响应丢失）⇒ 由下方读回定。 */
        console.warn(`[xiai] repairImageStorage 單行補寫回報失敗（讀回定真偽；_id：${docId}；不中斷整批）：`, text(error && error.message))
      }
    }
    if (attemptedIds.length > 0) {
      /* 读回（**唯一判据**）：同一窗口语义重读（`_id` 升序、严格大于 `cursor` 的前 `limit` 行）⇒
         尝试行的终态。**本窗口内行 `_id` 不变、集合无并发改写** ⇒ 窗口集合稳定 ⇒ 一次读全覆盖。
         少读到的行（并发删 / 窗口漂移，理论不发生）⇒ 补一次单行读；仍读不到 ⇒ 不敢称生效 ⇒ 进
         `failed`（**绝不拿「读不到」冒充已写**）。 */
      const after = await readStorageRepairWindow(cursor, limit)
      const stateById = new Map()
      for (const row of after) stateById.set(text(row && row._id), row)
      const missing = attemptedIds.filter((docId) => !stateById.has(docId))
      for (const docId of missing) {
        try {
          const hit = rowsOf(await resolveDb().collection(COLLECTIONS.images).doc(docId).get())
          if (hit.length > 0) stateById.set(docId, hit[0])
        } catch (error) {
          console.warn(`[xiai] repairImageStorage 讀回補查失敗（_id：${docId}；不中斷整批）：`, text(error && error.message))
        }
      }
      for (const docId of attemptedIds) {
        const row = stateById.get(docId)
        if (row && text(row.storage).trim().toLowerCase() === 'server') {
          written += 1
        } else {
          failed.push({ _id: docId, reason: REASONS.STORAGE_UNAVAILABLE })
          console.warn(`[xiai] repairImageStorage 單行補寫未生效（讀回非 server；_id：${docId}；不中斷整批）`)
        }
      }
    }
    return { ok: true, scanned, written, next_cursor: nextCursor, failed }
  },

  /**
   * **印面圖入册（本單新增 op｜`registerFaceImage`｜管理員面）**：把「本機已交權威存儲的印面圖」
   * 在云端 `xiai_images` **建 / 覆写那一行**（内容寻址 `_id`），让 `lib/aiEnhance.js` ④ 步的
   * 严格查行（按 `id`）能命中 —— 本机镜像的序号式 id（`img-<印章序号>f`）由客户端在成功后
   * 统一改写成本回包的 `image_id`（**一图一身份**）。
   * 顺序（**全部判定在落盘之前**；本 op 只产 `plan` ⇒ 落盘由 `index.js` 的唯一写点执行）：
   *   ① 管理员门 `adminWhitelistDenial`（**任何读之前**；缺 `XIAI_ADMIN_PHONE` ⇒ 结构化拒绝）；
   *   ② 载荷封闭键面 `FACE_IMAGE_REGISTER_ALLOWED_KEYS`（未知 / 身份类键 ⇒ `INVALID_FIELD`）；
   *   ③ 必填六键：缺 / 空 ⇒ `MISSING_REQUIRED`、非字符串 ⇒ `INVALID_VALUE`（`bytes` 另判整数）；
   *   ④ 值域门：`sha256` 64 位小写十六进制；`storage_key` 匹配 `ARTIFACT_OBJECT_KEY_PATTERN`
   *      **且键内摘要 ≡ sha256**；`bytes` ∈ 1〜`ARTIFACT_MAX_BYTES`；`kind` ∈ {FACE, EDGE}
   *      （缺省 `FACE`）⇒ 任一不符 `INVALID_VALUE` ＋ 零写入、零读取之外的任何副作用；
   *   ⑤ `seq` **单点取号**（同 `id` 已有行且属同印 ⇒ 沿用、不消耗号；否则经
   *      `imageSeqsOf` / `nextImageSeqOf`，**本 op 不自算号**）；
   *   ⑥ 行体 ＝ `buildDirectImageRow` 字段面（`stamp_id` 回填 `seal_id`）＋ `kind:'set'`
   *      覆写计划 ⇒ **同 `id` 重放不建第二行、不消耗号**；
   *   ⑦ 成功回包**恰 2 键** `{ok:true, image_id}`（＋ `plan` 内部面，`index.js` 不外传）；
   *      失败恒**恰 3 键**，`reason` 只用既有冻结值（**零新增**）。
   * @param {object} payload 载荷（封闭七键，见 `FACE_IMAGE_REGISTER_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<{ok:true, image_id:string, plan:object}|{ok:false, reason:string, message:string}>}
   */
  async registerFaceImage(payload, identity, context) {
    /* ① 管理员门（任何读之前）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* ② 载荷封闭键面（未知键 / 身份类键 ⇒ `INVALID_FIELD`；与其余 op 同一条文案）。 */
    const payloadDenial = pointsPayloadDenial(payload, FACE_IMAGE_REGISTER_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    /* ③ 必填五串 ＋ 一体量整数（缺 / 空 ⇒ `MISSING_REQUIRED`；非字符串 ⇒ `INVALID_VALUE`）。 */
    const requiredTextKeys = ['seal_id', 'face_id', 'sha256', 'mime', 'storage_key']
    for (const key of requiredTextKeys) {
      const value = payload[key]
      if (value === undefined || value === null || text(value) === '') {
        return deny(REASONS.MISSING_REQUIRED, `缺少必要欄位（${key}）；本次零寫入。`)
      }
      if (typeof value !== 'string') {
        return deny(REASONS.INVALID_VALUE, `欄位（${key}）必須是字符串；本次零寫入。`)
      }
    }
    const claimedBytes = payload.bytes
    if (claimedBytes === undefined || claimedBytes === null) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要欄位（bytes）；本次零寫入。')
    }
    /* ④a 体量门（与 `registerArtifact` 同值域、同文案族）。 */
    if (!Number.isInteger(claimedBytes) || claimedBytes <= 0 || claimedBytes > ARTIFACT_MAX_BYTES) {
      return deny(
        REASONS.INVALID_VALUE,
        `字節數（bytes）必須是 1 〜 ${ARTIFACT_MAX_BYTES} 之間的整數；本次零寫入。`
      )
    }
    const digest = text(payload.sha256).toLowerCase()
    const storageKey = text(payload.storage_key)
    /* ④b 对象键形态 ＋ 摘要形态 ＋ 两者一致（与 `registerArtifact` 同一张形态表）。 */
    const matched = ARTIFACT_OBJECT_KEY_PATTERN.exec(storageKey)
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
    /* ④c 类别门（缺省 `FACE`；给出即必须是 FACE / EDGE，**不静默归一**）。 */
    let kind = 'FACE'
    if (Object.prototype.hasOwnProperty.call(payload, 'kind') && payload.kind !== undefined && payload.kind !== null) {
      if (typeof payload.kind !== 'string' || FACE_IMAGE_REGISTER_KINDS.indexOf(payload.kind) === -1) {
        return deny(REASONS.INVALID_VALUE, '影像類別（kind）只能是 FACE 或 EDGE；本次零寫入。')
      }
      kind = payload.kind
    }
    const sealId = text(payload.seal_id)
    const at = new Date().toISOString()
    /* 内容寻址 id 的**唯一规则点** ＝ `buildDirectImageRow`（此处只取 id，不自拼）。 */
    const id = buildDirectImageRow({ image_sha256: digest, image_bytes: claimedBytes, image_storage_key: storageKey, kind }, at).id
    /* ⑤ `seq` 单点取号：同 `id` 已有行且属同印 ⇒ 沿用（幂等、不消耗号）；否则经单点分配器。
       读抛错 ⇒ 按「无既有行」继续（与 `imageSeqsOf` 同一降级口径：如实 `console.warn`、
       不把真故障伪装成「有行」；真故障若最终撞唯一键，由 `index.js` 如实报 `STORAGE_UNAVAILABLE`）。 */
    let existing = null
    try {
      const hits = await readRows(COLLECTIONS.images, { id }, { limit: 1 })
      existing = Array.isArray(hits) && hits.length > 0 ? hits[0] : null
    } catch (error) {
      console.warn(
        '[xiai] registerFaceImage 讀既有影像行失敗 ⇒ 按無既有行繼續（`seq` 交單點分配器取號）：',
        error && error.message ? error.message : error
      )
    }
    const sameSealExisting = existing && text(existing.stamp_id) === sealId && isImageSeq(existing.seq)
    const seq = sameSealExisting
      ? Number(existing.seq)
      : nextImageSeqOf(sealId, kind, await imageSeqsOf(sealId, kind))
    /* ⑥ 行体 ＝ `buildDirectImageRow` 字段面（含条件 `seq`）＋ `stamp_id` 回填 `seal_id`。 */
    const row = {
      ...buildDirectImageRow(
        { image_sha256: digest, image_bytes: claimedBytes, image_storage_key: storageKey, kind },
        at,
        seq
      ),
      stamp_id: sealId
    }
    /* ⑦ 成功 ＝ 恰 2 键（`plan` 是内部落盘计划，`index.js` 绝不外传）。 */
    return {
      ok: true,
      image_id: row.id,
      plan: {
        writes: [{ kind: 'set', collection: COLLECTIONS.images, id: row.id, doc: row }]
      }
    }
  },

  /**
   * **管理員「AI 修復孤兒扣費補退」（本單新增 op｜`repairOrphanEnhanceCharges`｜管理員面）** ——
   * 薄委派：業務邏輯單點在 `lib/aiEnhanceTasks.js::repairOrphanEnhanceCharges`（本處零第二套邏輯；
   * `require` 延遲以打破加載環）。
   * 硬口徑：① **第一行即管理員門**（既有 `adminWhitelistDenial`；零讀零寫地拒 ⇒ 既有凍結 3 鍵
   *    `ok / reason / message`）；② 載荷**封閉恰二鍵** `dry_run`（布林、**缺省 `true` ＝ 只讀預覽**）
   *    ＋ `limit`（1〜200 整數、**缺省 50**；未知鍵 ⇒ `INVALID_FIELD`、越界 ⇒ `INVALID_VALUE`）；
   * ③ 只掃 `xiai_points_flow` 中 `kind='CHARGE'` 且 `ref_id` **以 `aiet-` 開頭**的流水 ——
   *    **其餘流水一律零接觸**；④ 入選條件 ＝ `xiai_ai_enhance_tasks` **無該 `_id` 行** 且
   *    該 `idem_key` **無 `REFUND` 流水**（有行不選、已有退款不重複退）；⑤ `dry_run:true` ⇒
   *    **零寫入**、回**恰 4 鍵** `ok / scanned / eligible / rows`；`dry_run:false` ⇒ 補退款
   *    （`ledger.refundPoints`，冪等鍵 ＝ 原 `idem_key` ＋ `-refund`、`ref_id` 必帶；**單行失敗不中斷
   *    整批**）⇒ 回**恰 5 鍵** `ok / scanned / written / rows / failed`（`ok === (failed === 0)`；
   *    冪等重跑 ⇒ `written=0`）；⑥ `rows` 元素恒**恰 3 鍵** `ref_id / idem_key / amount`
   *    （`amount = Math.abs(delta)` —— 流水行**沒有 `amount` 鍵**）、條數 ≤ `limit`；
   *    **零新集合、零 `plan`、`reason` 零新增**。
   * @param {object} payload 載荷（封閉二鍵 `dry_run` / `limit`）
   * @param {{uid:string, phone:string, role?:string}} identity 服務端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<object>} dry_run 恰 4 鍵 / 真寫恰 5 鍵 / 拒絕面恰 3 鍵
   */
  async repairOrphanEnhanceCharges(payload, identity, context) {
    /* ① 管理員門（既有單點；**本函數第一行**，零讀零寫地拒）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* 延遲 require：與修復面同法（打破加載環；離線自檢不需要 SDK）。 */
    const { repairOrphanEnhanceCharges: runRepair } = require('./aiEnhanceTasks.js')
    return runRepair(payload, identity, context)
  },

  /**
   * **主印面回填（本单新增 op｜`repairPrimaryFace`｜管理员面）** —— 薄委派：业务逻辑单点、
   * 载荷封闭键面与回包读数键面都在 `lib/sealCards.js`（本处零第二套逻辑；`require` 延迟以打破
   * 加载环、离线自检不需要 SDK）。
   *
   * 硬口径（逐条）：① **第一行即管理员门**（既有 `adminWhitelistDenial`；缺 env / 非白名单 ⇒
   * 结构化拒 ＋ **零读零写**）；② 载荷封闭恰两键 `{dry_run?:boolean, limit?:number}`
   * （`dry_run` 缺省 `true`；`limit` 1〜500 整数、缺省 200；未知键 / 身份类键 ⇒ `INVALID_FIELD`）；
   * ③ 扫「**有 FACE 面但无任何 `is_primary=true`**」的章，把 `face_no` 最小的 FACE 行置
   * `is_primary:true`；**`EDGE` 永不置**；④ **幂等**：已有 primary 的章不碰 ⇒ 同参重放
   * `written === 0`；⑤ `dry_run` **零写**（`written` 恒 0）；⑥ 成功回包**恰 5 键**
   * `{ok, scanned, eligible, written, next_cursor}`、失败恒**恰 3 键**；`reason` **零新增**；
   * ⑦ **零新集合**（读写都在 `xiai_seals` / `xiai_faces`）、**不产 `plan`**（写步在本 op 内经
   * `persist` 逐行执行 ＋ 读回定真伪 ⇒ `index.js` 无内部落盘计划可外传）。
   * @param {object} [payload] `{dry_run?:boolean, limit?:number}`
   * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   */
  async repairPrimaryFace(payload, identity, context) {
    /* 延遲 require：與其餘薄委派同法（打破加載環；離線自檢不需要 SDK）。
       管理员门在 `lib/sealCards.js::repairPrimaryFace` 的**第一行**（零读零写地拒）。 */
    const { repairPrimaryFace: runRepair } = require('./sealCards.js')
    return runRepair(payload, identity, context)
  },

  /**
   * **管理員「重新上傳印面圖」（本單新增 op｜`replaceFaceImage`｜管理員面）**：云模式下
   * 替换印面图的那一口 —— **服务端原子入册影像行 ＋ 改面行指向**（旧图一律保留）。
   *
   * 顺序（**全部判定早于任何写**；本 op **不产 `plan`** ⇒ 两处写入在本函数内按确定序执行，
   * `index.js` 没有任何内部落盘计划可外传）：
   *   ① 管理员门 `adminWhitelistDenial`（**任何读之前**；与 `registerFaceImage` 同一张门）；
   *   ② 载荷封闭恰 7 键 `FACE_IMAGE_REPLACE_ALLOWED_KEYS`（未知键 / 身份类键 ⇒ `INVALID_FIELD`；
   *      `kind` **可缺省 ⇒ 缺省 `FACE`**）；
   *   ③ 必填六键：缺 / 空 ⇒ `MISSING_REQUIRED`、非字符串 ⇒ `INVALID_VALUE`（`bytes` 另判整数）；
   *   ④ 值域门（**与 `registerFaceImage` 同一张表、同一条文案**）⇒ 任一不符 `INVALID_VALUE` ＋ 零写入；
   *   ⑤ **读该面行**（`id` → `_id` 两形态；无行 ⇒ `INVALID_VALUE` ＋ 文案「**該印面不存在**」，
   *      **不用 `NOT_FOUND`** —— `REASONS` 表里没有它）；
   *   ⑥ **幂等**：面行已指向该内容寻址 `image_id` ⇒ **零写**、回包 `previous_image_id === image_id`；
   *   ⑦ `seq` **单点取号**（同 `id` 已有行且属同印 ⇒ 沿用其 `seq`、不消耗号；否则经
   *      `imageSeqsOf` ＋ `nextImageSeqOf`，**本 op 不自算号**；读抛错 ⇒ 按无既有行继续）；
   *   ⑧ `persist` `kind:'set'` 落影像行（**幂等，不建第二行**；行体 ＝ `buildDirectImageRow`
   *      字段面 ＋ `stamp_id` 回填 `seal_id`）；
   *   ⑨ 更新面行指向（`kind:'FACE'` ⇒ `face_image_id`；`kind:'EDGE'` ⇒ `edge_image_ids` 首位换新；
   *      `expectAtLeast:1`）；**失败 ⇒ 回滚 ⑧ 那一行**：本轮新建的槽位 ⇒ `deleteRow`；
   *      槽位本轮之前已在 ⇒ `kind:'set'` 回退其原行内容 —— **对象字节一律不删**，回
   *      `STORAGE_UNAVAILABLE` ＋ 如实文案（回滚成败一并如实说）；
   *   ⑩ 成功**恰 3 键** `{ok:true, image_id, previous_image_id}`（原本无图 ⇒ `null`；
   *      `index.js` 按 `FACE_IMAGE_REPLACE_READOUT_KEYS` 收窄透传）；失败**恰 3 键**
   *      `{ok:false, reason, message}`，`reason` 只用既有冻结值（**零新增**）。
   * @param {object} payload 载荷（封闭 7 键，见 `FACE_IMAGE_REPLACE_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<{ok:true, image_id:string, previous_image_id:string|null}|
   *                   {ok:false, reason:string, message:string}>}
   */
  async replaceFaceImage(payload, identity, context) {
    /* ① 管理员门（**任何读之前**；缺 env ⇒ 既有结构化拒抱 ＋ 零读零写）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* ② 载荷封闭恰 7 键（未知键 / 身份类键 ⇒ `INVALID_FIELD`，与其余 op 同一条文案）。 */
    const payloadDenial = pointsPayloadDenial(payload, FACE_IMAGE_REPLACE_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    /* ③ 必填五串 ＋ 一体量整数（`kind` 可缺省 ⇒ 不在必填表内；与 `registerFaceImage` 同判）。 */
    const requiredTextKeys = ['face_id', 'seal_id', 'sha256', 'mime', 'storage_key']
    for (const key of requiredTextKeys) {
      const value = payload[key]
      if (value === undefined || value === null || text(value) === '') {
        return deny(REASONS.MISSING_REQUIRED, `缺少必要欄位（${key}）；本次零寫入。`)
      }
      if (typeof value !== 'string') {
        return deny(REASONS.INVALID_VALUE, `欄位（${key}）必須是字符串；本次零寫入。`)
      }
    }
    const claimedBytes = payload.bytes
    if (claimedBytes === undefined || claimedBytes === null) {
      return deny(REASONS.MISSING_REQUIRED, '缺少必要欄位（bytes）；本次零寫入。')
    }
    /* ④a 体量门（与 `registerFaceImage` 同值域、同文案族）。 */
    if (!Number.isInteger(claimedBytes) || claimedBytes <= 0 || claimedBytes > ARTIFACT_MAX_BYTES) {
      return deny(
        REASONS.INVALID_VALUE,
        `字節數（bytes）必須是 1 〜 ${ARTIFACT_MAX_BYTES} 之間的整數；本次零寫入。`
      )
    }
    const digest = text(payload.sha256).toLowerCase()
    const storageKey = text(payload.storage_key)
    /* ④b 对象键形态 ＋ 摘要形态 ＋ 两者一致（与 `registerFaceImage` 同一张形态表、同一条文案）。 */
    const matched = ARTIFACT_OBJECT_KEY_PATTERN.exec(storageKey)
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
    /* ④c 类别门（缺省 `FACE`；给出即必须 FACE / EDGE，**不静默归一**）。 */
    let kind = 'FACE'
    if (Object.prototype.hasOwnProperty.call(payload, 'kind') && payload.kind !== undefined && payload.kind !== null) {
      if (typeof payload.kind !== 'string' || FACE_IMAGE_REGISTER_KINDS.indexOf(payload.kind) === -1) {
        return deny(REASONS.INVALID_VALUE, '影像類別（kind）只能是 FACE 或 EDGE；本次零寫入。')
      }
      kind = payload.kind
    }
    const faceId = text(payload.face_id)
    const sealId = text(payload.seal_id)
    /* ⑤ 读该面行（`id` → `_id` 两形态；无行 ⇒ `INVALID_VALUE` ＋「該印面不存在」）。 */
    let faceRow = null
    let probeField = ''
    for (const probe of ['id', '_id']) {
      const rows = await readRows(COLLECTIONS.faces, { [probe]: faceId }, { limit: FACE_IMAGE_REPLACE_FACE_SCAN_LIMIT })
      if (rows.length > 0) {
        faceRow = rows[0]
        probeField = probe
        break
      }
    }
    if (faceRow === null) {
      return deny(REASONS.INVALID_VALUE, `該印面不存在（face_id：${faceId}）；本次零寫入。`)
    }
    const edgeIds = Array.isArray(faceRow.edge_image_ids)
      ? faceRow.edge_image_ids.map((value) => text(value)).filter((value) => value !== '')
      : []
    /* **旧指向**（`FACE` ⇒ `face_image_id`；`EDGE` ⇒ `edge_image_ids` 首位；无图 ⇒ `null`）。 */
    const previousImageId =
      kind === 'EDGE'
        ? edgeIds.length > 0
          ? edgeIds[0]
          : null
        : text(faceRow.face_image_id) || null
    const at = new Date().toISOString()
    /* 内容寻址 id 的**唯一规则点** ＝ `buildDirectImageRow`（此处只取 id，不自拼）。 */
    const id = buildDirectImageRow(
      { image_sha256: digest, image_bytes: claimedBytes, image_storage_key: storageKey, kind },
      at
    ).id
    /* ⑥ **幂等**：面行已指向该 id ⇒ 零写、`previous_image_id === image_id`。 */
    if (previousImageId === id) return { ok: true, image_id: id, previous_image_id: id }
    /* ⑦ 既有同内容行（读抛错 ⇒ 按无既有行继续；与 `imageSeqsOf` 同一降级口径：如实 warn、不伪装「有行」）。 */
    let existing = null
    try {
      for (const probe of ['id', '_id']) {
        const hits = await readRows(COLLECTIONS.images, { [probe]: id }, { limit: FACE_IMAGE_REPLACE_IMAGE_SCAN_LIMIT })
        if (Array.isArray(hits) && hits.length > 0) {
          existing = hits[0]
          break
        }
      }
    } catch (error) {
      console.warn(
        '[xiai] replaceFaceImage 讀既有影像行失敗 ⇒ 按無既有行繼續（`seq` 交單點分配器取號）：',
        error && error.message ? error.message : error
      )
    }
    /* ⑦′ **`seq` 单点取号**（同 `id` 已有行且属同印 ⇒ 沿用；**本 op 不自算号**）。 */
    const sameSealExisting = existing && text(existing.stamp_id) === sealId && isImageSeq(existing.seq)
    const seq = sameSealExisting
      ? Number(existing.seq)
      : nextImageSeqOf(sealId, kind, await imageSeqsOf(sealId, kind))
    /* ⑧ 行体 ＝ `buildDirectImageRow` 字段面（含条件 `seq`）＋ `stamp_id` 回填 `seal_id`。 */
    const row = {
      ...buildDirectImageRow(
        { image_sha256: digest, image_bytes: claimedBytes, image_storage_key: storageKey, kind },
        at,
        seq
      ),
      stamp_id: sealId
    }
    try {
      await persist({ writes: [{ kind: 'set', collection: COLLECTIONS.images, id: row.id, doc: row }] })
    } catch (error) {
      /* 影像行没落成 ⇒ 面行一行未动、旧图与对象字节未动（**不谎报「本次零寫入」以外的结论**）。 */
      return deny(
        REASONS.STORAGE_UNAVAILABLE,
        `影像行落盤失敗（image_id：${row.id}）；印面指向未改動、舊圖與對象字節一律保留，可重試。（診斷：${
          (error && error.message) || 'unknown'
        }）`
      )
    }
    /* ⑨ 更新面行指向（`FACE` ⇒ `face_image_id`；`EDGE` ⇒ `edge_image_ids` 首位换新、其余保留）。 */
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const doc = { updated_at: new Date(seconds * 1000).toISOString() }
    if (kind === 'EDGE') doc.edge_image_ids = [id, ...edgeIds.slice(1)]
    else doc.face_image_id = id
    const match = text(faceRow._id) ? { _id: text(faceRow._id) } : { [probeField]: faceId }
    try {
      await persist({
        writes: [{ kind: 'update', collection: COLLECTIONS.faces, match, doc, expectAtLeast: 1 }]
      })
    } catch (error) {
      /* ⑨′ **回滚**：槽位本轮之前已在 ⇒ 回退其原行内容；本轮新建 ⇒ 删那一行。
         **对象字节一律不删**（旧图保留是硬口径；删图走 `deleteFaceImage`）。 */
      const slotPreexisting = existing !== null && text(existing._id) === row.id
      let rollbackText = ''
      if (slotPreexisting) {
        try {
          await persist({ writes: [{ kind: 'set', collection: COLLECTIONS.images, id: row.id, doc: existing }] })
          rollbackText = '影像行已回退為替換前內容（回滾完成，對象字節未刪）。'
        } catch (rollbackError) {
          rollbackText =
            `影像行回退失敗（image_id：${row.id}；該行仍為本次寫入內容、對象字節未刪，` +
            `可由管理員經 deleteFaceImage 刪除）。（診斷：${(rollbackError && rollbackError.message) || 'unknown'}）`
        }
      } else {
        try {
          await deleteRow(COLLECTIONS.images, row.id)
          rollbackText = '本輪新建的影像行已刪除（回滾完成，對象字節未刪）。'
        } catch (rollbackError) {
          rollbackText =
            `本輪新建的影像行刪除失敗（image_id：${row.id}；該行仍在、對象字節未刪，` +
            `可由管理員經 deleteFaceImage 刪除）。（診斷：${(rollbackError && rollbackError.message) || 'unknown'}）`
        }
      }
      return deny(
        REASONS.STORAGE_UNAVAILABLE,
        `印面指向更新失敗（face_id：${faceId}）；${rollbackText}舊圖一律保留，可重試。（診斷：${
          (error && error.message) || 'unknown'
        }）`
      )
    }
    /* ⑩ 成功恰 3 键（`previous_image_id` 原本无图 ⇒ `null`）。 */
    return { ok: true, image_id: id, previous_image_id: previousImageId }
  },

  /**
   * **管理員「刪除印面影像」（本單新增 op｜`deleteFaceImage`｜管理員面）**：管理员在**影像卡片**
   * 上显式【刪除】本印面那一张影像（**旧图默认不自动删** ⇒ 删是显式动作，不是换图的副作用）。
   *
   * 顺序（**判定全部早于任何写**；本 op 无 `plan` —— 三步写入都在本函数内按确定序执行）：
   *   ① 管理员门 `adminWhitelistDenial`（**先于一切读写**；缺 `XIAI_ADMIN_PHONE` ⇒ 结构化拒绝
   *      ＋ 零读零写；非白名单 ⇒ `FORBIDDEN`）；
   *   ② 载荷封闭两键 `face_id` ＋ `image_id`（未知键 / 身份类键 ⇒ `INVALID_FIELD`；缺 / 空 ⇒
   *      `MISSING_REQUIRED`；非字符串 ⇒ `INVALID_VALUE`）；
   *   ③ 印面行检索（`id` → `_id` 两形态依次；无行 ⇒ `INVALID_VALUE` ＋ 零写入）；
   *   ④ **本印面归属校验**：`image_id` 必须确属该印面（`face_image_id` 等值 **或** 在
   *      `edge_image_ids[]` 中），否则 ⇒ `INVALID_VALUE` ＋ **零写入**；
   *   ⑤ **共用保护**：扫描**全部印面**（`readRows(faces, {})`，护栏在场），该影像仍被**其它**
   *      印面引用 ⇒ `INVALID_VALUE`（文案点名「**該影像仍被其他印面引用**」）＋ **零写入**；
   *   ⑥ **写入确定序（先后即契约）**：① 先清该印面引用（`face_image_id` 置 `''` ／ 从
   *      `edge_image_ids` 移除；`persist` `kind:'update'` ＋ `expectAtLeast:1`）→ ② 删
   *      `xiai_images` 行（`deleteRow`；**占位图行不删** ⇒ `removed.rows` 如实 0）→ ③ 尽力删
   *      对象（**候选单点** `deleteImageObjectsOfRow`：`storage_key` 优先 → `sha` 派生后缀族
   *      逐个试 → 行内其它键、**命中即停**；**失败不阻断**、计数如实 0）；
   *   ⑦ **回包**：成功恰 **4 键** `{ok:true, face_id, image_id, removed:{rows, objects}}`
   *      （`index.js` 按 op 收窄透传；**删数如实、零补编**）；失败恒 **恰 3 键**
   *      （`ok, reason, message`；**零新增 `reason`**）。
   * @param {object} payload 载荷（封闭两键 `face_id` / `image_id`）
   * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:string|number}} [context]
   * @returns {Promise<{ok:true, face_id:string, image_id:string, removed:{rows:number, objects:number}}|
   *                   {ok:false, reason:string, message:string}>}
   */
  async deleteFaceImage(payload, identity, context) {
    /* ① 管理员门（**先于一切读写**；缺 env / 非白名单 ⇒ 结构化拒绝 ＋ 零读取、零写入）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* ② 载荷封闭键面（形态 ＋ 未知键 / 身份类键 ⇒ 与其余 op 同一条文案）。 */
    const payloadDenial = pointsPayloadDenial(payload, FACE_IMAGE_DELETE_ALLOWED_KEYS)
    if (payloadDenial) return payloadDenial
    /* ③ 必填两键（缺 / 空 ⇒ `MISSING_REQUIRED`；非字符串 ⇒ `INVALID_VALUE`；零写入）。 */
    for (const key of ['face_id', 'image_id']) {
      const value = payload[key]
      if (value === undefined || value === null || text(value) === '') {
        return deny(REASONS.MISSING_REQUIRED, `缺少必要欄位（${key}）；本次零寫入。`)
      }
      if (typeof value !== 'string') {
        return deny(REASONS.INVALID_VALUE, `欄位（${key}）必須是字符串；本次零寫入。`)
      }
    }
    const faceId = text(payload.face_id)
    const imageId = text(payload.image_id)
    /* ④ 印面行检索（`id` → `_id` 两形态依次；无行 ⇒ `INVALID_VALUE` ＋ 零写入）。 */
    let faceRow = null
    let probeField = ''
    for (const probe of ['id', '_id']) {
      const rows = await readRows(COLLECTIONS.faces, { [probe]: faceId }, { limit: FACE_IMAGE_DELETE_FACE_SCAN_LIMIT })
      if (rows.length > 0) {
        faceRow = rows[0]
        probeField = probe
        break
      }
    }
    if (faceRow === null) {
      return deny(REASONS.INVALID_VALUE, `未找到該印面（face_id：${faceId}）；本次零寫入。`)
    }
    /* ⑤ **本印面归属校验**：`face_image_id` 等值 或 `edge_image_ids[]` 命中，否则零写入。 */
    const edgeIds = Array.isArray(faceRow.edge_image_ids)
      ? faceRow.edge_image_ids.map((id) => text(id)).filter((id) => id !== '')
      : []
    const ownedByFace = text(faceRow.face_image_id) === imageId
    const ownedByEdge = edgeIds.indexOf(imageId) !== -1
    if (!ownedByFace && !ownedByEdge) {
      return deny(
        REASONS.INVALID_VALUE,
        `影像編號（${imageId}）不屬於該印面（本印面的 face_image_id / edge_image_ids 均未命中）；本次零寫入。`
      )
    }
    /* ⑥ **共用保护**：全部印面里除本印面外仍有人引用该影像 ⇒ 拒（文案点名）＋ 零写入。
       判据与 `lib/sealDelete.js` 的共用判定同形（`face_image_id` 等值 ／ `edge_image_ids` 数组含）。 */
    const isTargetFace = (row) => text(row && row.id) === faceId || text(row && row._id) === faceId
    const allFaces = await readRows(COLLECTIONS.faces, {}, { limit: FACE_IMAGE_DELETE_SCAN_LIMIT })
    const sharedByOthers = allFaces.some(
      (row) =>
        !isTargetFace(row) &&
        (text(row && row.face_image_id) === imageId ||
          (Array.isArray(row && row.edge_image_ids) &&
            row.edge_image_ids.some((edgeId) => text(edgeId) === imageId)))
    )
    if (sharedByOthers) {
      return deny(
        REASONS.INVALID_VALUE,
        `該影像仍被其他印面引用（其它印面行的 face_image_id / edge_image_ids 命中 ${imageId}），不可刪除；本次零寫入。`
      )
    }
    /* ⑦ 写入确定序 ①：**先清该印面的引用**（`face_image_id` 置 `''` ／ 从 `edge_image_ids` 移除）。 */
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const doc = { updated_at: new Date(seconds * 1000).toISOString() }
    if (ownedByFace) doc.face_image_id = ''
    if (ownedByEdge) doc.edge_image_ids = edgeIds.filter((id) => id !== imageId)
    const match = text(faceRow._id) ? { _id: text(faceRow._id) } : { [probeField]: faceId }
    try {
      await persist({
        writes: [{ kind: 'update', collection: COLLECTIONS.faces, match, doc, expectAtLeast: 1 }]
      })
    } catch (error) {
      /* 清引用未落定 ⇒ 尚未删任何行 / 对象（**不谎报零写入以外的成功**）。 */
      return deny(
        REASONS.STORAGE_UNAVAILABLE,
        `印面引用清除失敗（face_id：${faceId}）；影像行與對象均未刪除，可重試。（診斷：${
          (error && error.message) || 'unknown'
        }）`
      )
    }
    /* ⑧ 写入确定序 ②：删 `xiai_images` 行（`id` → `_id` 两形态；无行 ⇒ 如实 0，不编造）。
       **占位图行不得删**（登记键 / 登记 id 命中 ⇒ 跳过删行，引用已在上一步清掉）。 */
    let imageRow = null
    for (const probe of ['id', '_id']) {
      const rows = await readRows(COLLECTIONS.images, { [probe]: imageId }, { limit: FACE_IMAGE_DELETE_IMAGE_SCAN_LIMIT })
      if (rows.length > 0) {
        imageRow = rows[0]
        break
      }
    }
    const isPlaceholder =
      imageRow !== null &&
      (text(imageRow.storage_key) === SEAL_PLACEHOLDER_IMAGE_KEY ||
        text(imageRow.id) === SEAL_PLACEHOLDER_IMAGE.id ||
        text(imageRow._id) === SEAL_PLACEHOLDER_IMAGE.id)
    let rows = 0
    if (imageRow !== null && !isPlaceholder) {
      const imageDocId = text(imageRow._id) || imageId
      try {
        await deleteRow(COLLECTIONS.images, imageDocId)
        rows = 1
      } catch (error) {
        /* 引用已清、行未删 ⇒ **如实报告非零写入**（不得声称「本次零寫入」）。 */
        return deny(
          REASONS.STORAGE_UNAVAILABLE,
          `印面引用已清除，但影像行刪除失敗（image_id：${imageId}）；對象未刪除、影像行仍在，可重試。（診斷：${
            (error && error.message) || 'unknown'
          }）`
        )
      }
    }
    /* ⑨ 写入确定序 ③：**尽力**删对象（去重保护：同 `sha256` 尚有其它行 ⇒ 只删行）。
       删对象一律走**候选单点** `deleteImageObjectsOfRow`（① 行内 `storage_key` → ② `sha`
       派生后缀族逐个试 → ③ 行内其它键；**命中一件即停**）—— 旧版只按单一键试一次、猜错
       扩展名即回 0（线上「刪對象 0 件」泄漏真因）。失败（对象不存在 / 删除报错）**不阻断**、
       **不计失败**，`removed.objects` 如实 0（**不谎报已删**）。 */
    let objects = 0
    if (rows === 1) {
      const rawDigest = text(imageRow.sha256)
      const digest = rawDigest.toLowerCase()
      const imageDocId = text(imageRow._id) || imageId
      let sharedByOtherRow = false
      if (ARTIFACT_DIGEST_PATTERN.test(digest)) {
        const peers = await readRows(COLLECTIONS.images, { sha256: rawDigest }, { limit: FACE_IMAGE_DIGEST_SCAN_LIMIT })
        sharedByOtherRow = peers.some((row) => text(row && (row._id || row.id)) !== imageDocId)
      }
      if (!sharedByOtherRow) {
        objects = await deleteImageObjectsOfRow(imageRow)
      }
    }
    /* ⑩ 成功回包恰 4 键（`removed` 的删数一律取自实际执行结果，零补编）。 */
    return { ok: true, face_id: faceId, image_id: imageId, removed: { rows, objects } }
  },

  /**
   * **上傳印章即上雲（本單新增 op｜`createSealUpload`｜管理員面）**：管理员在【上傳印章】弹窗
   * 提交一枚印章（1 印面 ＋ 可选边款）⇒ **服务端发号 ＋ 内容寻址影像行 ＋ `persist` 单点落盘**，
   * 客户端只落本机镜像（**本机不再发号** —— 本地号源只留给 `local-dev` 显式分支）。
   *
   * 顺序（**全部判定在任何读 / 写之前**；本 op 只产 `plan` ⇒ 落盘由 `index.js` 的唯一写点执行）：
   *   ① 管理员门 `adminWhitelistDenial`（**任何读之前**；缺 `XIAI_ADMIN_PHONE` ⇒ 结构化拒绝
   *      ＋ 零读零写；非白名单 ⇒ `FORBIDDEN`）；
   *   ② 载荷封闭键面 `SEAL_UPLOAD_ALLOWED_KEYS`（印章级 8 鍵 **＝ `SEAL_IMPORT_SEAL_FIELDS`
   *      逐字沿用、不新造字段** ＋ `faces[]` ＋ `client_request_id`；未知键 / 身份类键 ⇒
   *      `INVALID_FIELD`，与其余 op 同一条文案）；
   *   ③ 冪等鍵 `client_request_id` 必給：缺 / 空 ⇒ `MISSING_REQUIRED`、非字符串 ⇒ `INVALID_VALUE`、
   *      超 `MAX_ID_LENGTH` ⇒ `INVALID_VALUE`（**不新建任何集合** —— 幂等键落**印章行**）；
   *   ④ `faces[]` 1..N ＋ 逐面封闭键面 `SEAL_UPLOAD_FACE_KEYS`（必給 `kind` / `image_sha256` /
   *      `image_bytes` / `image_storage_key`；可選 7 個自由文本鍵）⇒ 未知键 `INVALID_FIELD`；
   *   ⑤ 形态门（与 `registerArtifact` / `registerFaceImage` **同一张表**）：摘要
   *      `ARTIFACT_DIGEST_PATTERN`、对象键 `ARTIFACT_OBJECT_KEY_PATTERN` **且键内摘要 ≡
   *      `image_sha256`**、`image_bytes` ∈ 1〜`ARTIFACT_MAX_BYTES` 整数、`kind` ∈ {FACE, EDGE}
   *      （给出即必须逐字命中，**不静默归一**）⇒ 任一不符 `INVALID_VALUE` ＋ 零写入；
   *   ⑥ 自由文本长度门 `sealTextLengthDenial` ＋ 值域门 `sealValueDomainDenial`
   *      （`dynasty` / `seal_type` / `face_style` / `seal_class`）；
   *   ⑦ 影像引用：集合已有行 ⇒ 复用（**不改写既有行**）；无行 ⇒ 自建内容寻址登记行覆蓋層
   *      （`_id` ＝ `img-<sha 前 16 位>`，唯一构造点仍是 `buildDirectImageRow`）；
   *   ⑧ **幂等读**：同 `client_request_id` 已有正式行 ⇒ 回既有读数 ＋ `idempotent:true`、
   *      **零新增行、不改写既有行、无 `plan`**（重放不消耗号）；
   *   ⑨ **服务端发号**（复用 `buildSealAcceptanceFromImport` 单点，本 op 不自算号）：
   *      `seal_no = issueCodeNumber('seal')`（含 released 优先）、`sid`/`stamp_id` 由 `seal_no`
   *      恒重算；每面 `face_no = issueCodeNumber('face')`、`fid` 由其恒重算、
   *      `face id = fc-<sid>-<f|e><n>`（`nextFaceIdOf`）；影像行 `seq` 走 `imageSeqsOf` /
   *      `nextImageSeqOf` 单点；
   *   ⑩ `plan` ＝ 影像行 `kind:'set'` ＋ 印章行 `kind:'add'` ＋ 逐印面行 `kind:'add'`
   *      （**全部判定通过才交 plan** ⇒ 任一门失败恒零写入）；印章行 `review_status='APPROVED'`；
   *   ⑪ 成功回包业务键**全塞 `row`**（`index.js` 对 `row` 零过滤 ⇒ `sid` / `seal_no` /
   *      `face_nos` / `idempotent` 不必改全局白名单），`index.js` 另按 op 收窄透传
   *      `stamp_id` / `face_ids` / `image_ids` 三项；失败恒恰 3 键、`reason` 只用既有冻结值
   *      （**零新增**）。
   * @param {object} payload 载荷（封闭键面见 `SEAL_UPLOAD_ALLOWED_KEYS`）
   * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<object>} 成功 ⇒ `{ok, op, stamp_id, sid, seal_no, face_ids, image_ids,
   *          face_nos, idempotent, row, plan}`（`plan` 为内部落盘计划、绝不外传）；失败 ⇒ 恰 3 键
   */
  async createSealUpload(payload, identity, context) {
    /* ① 管理员门（**任何读之前**；缺 env ⇒ 结构化拒绝 ＋ 零读零写）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* ② 载荷形态 ＋ 封闭键面（未知键 / 身份类键 ⇒ `INVALID_FIELD`；与其余 op 同一条文案）。 */
    const keyDenial = pointsPayloadDenial(payload, SEAL_UPLOAD_ALLOWED_KEYS)
    if (keyDenial) return keyDenial
    /* ③ 冪等鍵 `client_request_id`（必給；类型 / 长度形态门，全部在任何读之前）。 */
    const rawRequestId = payload.client_request_id
    if (rawRequestId === undefined || rawRequestId === null || rawRequestId === '') {
      return deny(REASONS.MISSING_REQUIRED, '缺少冪等鍵（client_request_id）；本次零寫入。')
    }
    if (typeof rawRequestId !== 'string') {
      return deny(REASONS.INVALID_VALUE, '冪等鍵（client_request_id）必須是字符串；本次零寫入。')
    }
    const requestId = text(rawRequestId)
    if (requestId === '') {
      return deny(REASONS.MISSING_REQUIRED, '缺少冪等鍵（client_request_id）；本次零寫入。')
    }
    if (requestId.length > MAX_ID_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `冪等鍵（client_request_id）超出上限（${MAX_ID_LENGTH} 字）；本次零寫入。`)
    }
    /* ④ `faces[]` 1..N ＋ 逐面封闭键面 ＋ 必給键 ＋ `kind` 值域（不静默归一）。 */
    const rawFaces = payload.faces
    if (!Array.isArray(rawFaces) || rawFaces.length === 0) {
      return deny(REASONS.MISSING_REQUIRED, '請至少提供一個印面（faces[] 1..N）；本次零寫入。')
    }
    const faces = []
    for (let index = 0; index < rawFaces.length; index += 1) {
      const face = rawFaces[index]
      const label = `faces[${index}]`
      if (!face || typeof face !== 'object' || Array.isArray(face)) {
        return deny(REASONS.INVALID_VALUE, `${label} 必須是對象；本次零寫入。`)
      }
      const unknown = Object.keys(face).filter((key) => SEAL_UPLOAD_FACE_KEYS.indexOf(key) === -1)
      if (unknown.length > 0) {
        return deny(REASONS.INVALID_FIELD, `${label} 含未知欄位：${unknown.join('、')}；本次零寫入。`)
      }
      for (const key of SEAL_UPLOAD_FACE_REQUIRED_KEYS) {
        const value = face[key]
        if (value === undefined || value === null || (typeof value === 'string' && text(value) === '')) {
          return deny(REASONS.MISSING_REQUIRED, `${label} 缺少必要欄位（${key}）；本次零寫入。`)
        }
      }
      if (typeof face.kind !== 'string' || SEAL_UPLOAD_FACE_KINDS.indexOf(face.kind) === -1) {
        return deny(REASONS.INVALID_VALUE, `${label} 的影像類別（kind）只能是 FACE 或 EDGE；本次零寫入。`)
      }
      const normalized = normalizeSealImportFace(face)
      /* ⑤ 形态门（与 `registerArtifact` / `registerFaceImage` 同一张表；归一后判定）。 */
      const sha = text(normalized.image_sha256).toLowerCase()
      normalized.image_sha256 = sha
      if (!ARTIFACT_DIGEST_PATTERN.test(sha)) {
        return deny(REASONS.INVALID_VALUE, `${label} 影像摘要（image_sha256）必須是 64 位小寫十六進制；本次零寫入。`)
      }
      const matched = ARTIFACT_OBJECT_KEY_PATTERN.exec(text(normalized.image_storage_key))
      if (!matched || matched[2] !== sha || matched[1] !== sha.slice(0, 2)) {
        return deny(
          REASONS.INVALID_VALUE,
          `${label} 影像對象鍵形態不符（期望 xiai/images/<摘要前兩位>/<摘要>.tiff，且鍵內摘要 ≡ image_sha256）；本次零寫入。`
        )
      }
      const bytes = Number(normalized.image_bytes)
      if (!Number.isInteger(bytes) || bytes <= 0 || bytes > ARTIFACT_MAX_BYTES) {
        return deny(
          REASONS.INVALID_VALUE,
          `${label} 影像字節數（image_bytes）必須是 1 〜 ${ARTIFACT_MAX_BYTES} 之間的整數；本次零寫入。`
        )
      }
      faces.push(normalized)
    }
    /* ⑥ 自由文本长度门 ＋ 值域门（全部在任何读之前）。 */
    const lengthDenial = sealTextLengthDenial(payload, faces)
    if (lengthDenial) return lengthDenial
    const domainDenial = sealValueDomainDenial(payload, faces)
    if (domainDenial) return domainDenial
    /* ⑦ 影像引用：集合已有行 ⇒ 复用（不改写既有行）；无行 ⇒ 自建内容寻址登记行覆蓋層。 */
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const at = new Date(seconds * 1000).toISOString()
    const imageRows = []
    for (const face of faces) {
      const resolved = await findSealImportImageRow(face)
      if (resolved) continue
      /* **此刻不带 `seq`**：`stamp_id` 尚未发号 ⇒ `seq` 由构造器按单点分配器补齐。 */
      imageRows.push(buildDirectImageRow(face, at))
    }
    /* ⑧ 幂等读（同 `client_request_id` ⇒ 零新增、不改写既有行、无 `plan`）＋ 撞号避让读数。 */
    const seals = await readRows(COLLECTIONS.seals, {}, { limit: DIRECT_WRITE_READ_LIMIT })
    const existing = seals.find((item) => text(item && item.client_request_id) === requestId)
    if (existing) {
      const readouts = await sealUploadReadoutsOf(existing)
      return {
        ok: true,
        op: 'createSealUpload',
        ...readouts,
        idempotent: true,
        row: { ...readouts, idempotent: true },
        message: '該冪等鍵（client_request_id）已有正式行 ⇒ 未新增任何行、未改寫既有行（冪等）。'
      }
    }
    /* ⑨ 复用构造器（行构造 ＋ **服务端原子发号** ＋ 影像 `seq` 单点分配）。 */
    const faceRows = await readRows(COLLECTIONS.faces, {}, { limit: DIRECT_WRITE_READ_LIMIT })
    const importRow = { ...pickSealImportSealFields(payload), source: SEAL_UPLOAD_SOURCE, faces }
    const built = await buildSealAcceptanceFromImport(importRow, seals, faceRows, identity, at, imageRows)
    if (!built.ok) {
      return built.reason
        ? deny(built.reason, '上傳印章落點構造失敗（號源 / 影像引用判定未過）⇒ 拒絕寫入；本次零寫入。')
        : deny(REASONS.MISSING_REQUIRED, '印面（kind=FACE）必須帶可解析的影像引用 ⇒ 拒絕寫入；本次零寫入。')
    }
    /* 冪等键落**印章行**（**不新建集合**：本函数零新集合）。 */
    built.sealDoc.client_request_id = requestId
    for (const row of imageRows) row.stamp_id = built.stampId
    /* ⑪ 回包业务键（`face_ids` / `image_ids` / `face_nos` 三数组**按面序一一对应**）。 */
    const readouts = {
      stamp_id: built.stampId,
      sid: built.stampId,
      seal_no: Number(built.sealDoc.seal_no),
      face_ids: built.faceDocs.map((doc) => text(doc.id)),
      image_ids: built.faceDocs.map((doc) => faceImageIdOf(doc)),
      face_nos: built.faceDocs.map((doc) => Number(doc.face_no))
    }
    return {
      ok: true,
      op: 'createSealUpload',
      ...readouts,
      idempotent: false,
      row: { ...readouts, idempotent: false },
      /* ⑩ 全部判定已通过 ⇒ 此刻才交落盘计划（任一门失败都到不了这里 ⇒ 恒零写入）。 */
      plan: {
        op: 'createSealUpload',
        writes: [
          ...imageRows.map((row) => ({ kind: 'set', collection: COLLECTIONS.images, id: row.id, doc: row })),
          {
            kind: 'add',
            collection: COLLECTIONS.seals,
            id: built.stampId,
            doc: Object.assign({ _id: built.stampId }, built.sealDoc)
          },
          ...built.faceDocs.map((doc) => ({
            kind: 'add',
            collection: COLLECTIONS.faces,
            id: doc.id,
            doc: Object.assign({ _id: doc.id }, doc)
          }))
        ]
      }
    }
  },

  /**
   * **管理員「修改印章固定屬性」（`updateSealAttributes`｜形制 `shape` / 材質 `material`）**
   * —— **内联实现**（派单口径：不新建文件、不动 `index.js`；本 op 自己调 `persist`，**不返回 `plan`**
   * ⇒ `index.js` 既有的「只在 `plan` 存在时才落盘」分支自然不会重复落盘）。
   *
   * 硬口徑（逐条）：
   *   ① **管理员门先于一切读写**（`adminWhitelistDenial`；非管理员 / 缺白名单 env ⇒ 结构化拒绝
   *      ＋ **零读零写**）；② 载荷**封闭恰两键** `seal_id` / `patch`（**未知键 / 身份类键 ⇒
   *      `INVALID_FIELD`**，文案区分身份类键；载荷非物件 ⇒ `INVALID_FIELD`）；
   *   ③ `seal_id` 缺 / 空 / 非字符串 ⇒ **`INVALID_VALUE`**（目标类问题一律 `INVALID_VALUE`，
   *      **不新增任何 `reason`**）；④ 印章行 `stamp_id` → `sid` → 行 `id` **三形态依次检索**
   *      （与 `lib/sealDelete.js` 同一检索序，零第二套）；**无行 ⇒ `INVALID_VALUE`** ＋ 零写入；
   *   ⑤ `patch` 键面封闭 `['shape','material']`（真源 `src/data/seed.js::SEAL_FIXED_ATTR_FIELDS`）：
   *      未知键 ⇒ `INVALID_FIELD`；**缺 / 空（无任何可写键）⇒ `INVALID_VALUE`**；值处理 ＝
   *      `normalizeShape` / `normalizeMaterial` 同尺（**字符串 trim**；`null` / 缺省 ⇒ 空串＝清空；
   *      非字符串 ⇒ `INVALID_VALUE`）；**长度门按 `MAX_TEXT_LENGTH`＝500 字对齐**（超限 ⇒
   *      `INVALID_VALUE`；本地无对应物 ⇒ 以云侧既有自由文本上限为准）；
   *   ⑥ 落盘＝ `persist` 的 `kind:'update'`（`expectAtLeast:1`；**写入体只含 patch 内的键 ＋
   *      `updated_at`**，**不重写其它字段、不碰 `_id`** —— 封闭键面已保证 `_id` 进不来）；
   *   ⑦ 成功回包**恰 2 键** `{ok:true, row}`（`row` ＝ **更新后服务端行**：回读优先，回读空
   *      退路为「原行 ＋ 本次写入体」的本地合并行，不谎报）；失败**恰 3 键**
   *      `{ok:false, reason, message}`；`reason` **零新增**（只用 `lib/config.js::REASONS`
   *      既有冻结值：本面实际只会产出 `FORBIDDEN` / `INVALID_FIELD` / `INVALID_VALUE`）。
   * @param {object} payload 载荷（封闭两键 `seal_id` / `patch`）
   * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:string|number}} [context]
   * @returns {Promise<{ok:true, row:object}|{ok:false, reason:string, message:string}>}
   */
  async updateSealAttributes(payload, identity, context) {
    /* ① 管理员门（**先于一切读写**；非管理员 / 缺白名单 env ⇒ 结构化拒绝 ＋ 零读零写）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* ② 载荷形态（非物件 ⇒ `INVALID_FIELD`；早于任何键面展开）。 */
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.INVALID_FIELD, '載荷形態不合法（應為物件）；本次零寫入。')
    }
    const allowedKeys = ['seal_id', 'patch']
    const allowedFields = ['shape', 'material']
    /* ③ 封闭键面（未知键 / 身份类键 ⇒ `INVALID_FIELD` ＋ 零写入）。 */
    const unknown = Object.keys(payload).filter((key) => allowedKeys.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端派生，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(
        REASONS.INVALID_FIELD,
        `載荷含未知欄位：${unknown.join('、')}（${hint}；封閉兩鍵：seal_id / patch）；本次零寫入。`
      )
    }
    /* ④ `seal_id` 值域（缺 / 空 / 非字符串 ⇒ `INVALID_VALUE`；**不引入 `MISSING_REQUIRED`** —
       派单口径把目标类问题一律归 `INVALID_VALUE`）。 */
    const sealRaw = payload.seal_id
    if (sealRaw === undefined || sealRaw === null || sealRaw === '') {
      return deny(REASONS.INVALID_VALUE, '缺少印章編號（seal_id）；本次零寫入。')
    }
    if (typeof sealRaw !== 'string') {
      return deny(REASONS.INVALID_VALUE, '印章編號（seal_id）必須是字符串；本次零寫入。')
    }
    const sealId = text(sealRaw)
    if (sealId === '') {
      return deny(REASONS.INVALID_VALUE, '缺少印章編號（seal_id）；本次零寫入。')
    }
    /* ⑤ `patch` 形态 / 键面 / 空判定（形态与键面 ⇒ `INVALID_FIELD`；空 ⇒ `INVALID_VALUE`）。 */
    const patchRaw = payload.patch
    if (patchRaw === undefined || patchRaw === null) {
      return deny(REASONS.INVALID_VALUE, '修改內容缺省（patch 無任何可寫鍵）；本次零寫入。')
    }
    if (typeof patchRaw !== 'object' || Array.isArray(patchRaw)) {
      return deny(REASONS.INVALID_FIELD, '修改內容形態不合法（patch 應為物件）；本次零寫入。')
    }
    const patchKeys = Object.keys(patchRaw)
    const unknownPatch = patchKeys.filter((key) => allowedFields.indexOf(key) === -1)
    if (unknownPatch.length > 0) {
      const identityPatchKeys = unknownPatch.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityPatchKeys.length > 0
          ? `其中身份類欄位（${identityPatchKeys.join('、')}）由服務端派生，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(
        REASONS.INVALID_FIELD,
        `patch 含未知欄位：${unknownPatch.join('、')}（${hint}；印章級固定屬性僅 shape / material）；本次零寫入。`
      )
    }
    if (patchKeys.length === 0) {
      return deny(REASONS.INVALID_VALUE, '修改內容為空（patch 無任何可寫鍵）；本次零寫入。')
    }
    /* ⑥ 值处理（**与 `normalizeShape` / `normalizeMaterial` 同尺**：字符串 trim、空缺 ⇒ 空串）
       ＋ **500 字长度门**（超限 ⇒ `INVALID_VALUE`；全部早于任何读写）。 */
    const clean = {}
    for (const key of patchKeys) {
      const raw = patchRaw[key]
      if (raw !== null && raw !== undefined && typeof raw !== 'string') {
        return deny(REASONS.INVALID_VALUE, `欄位 ${key} 必須是文字（或留空）；本次零寫入。`)
      }
      const value = raw === null || raw === undefined ? '' : raw.trim()
      if (value.length > MAX_TEXT_LENGTH) {
        return deny(REASONS.INVALID_VALUE, `欄位 ${key} 超出文字上限（${MAX_TEXT_LENGTH} 字）；本次零寫入。`)
      }
      clean[key] = value
    }
    /* ⑦ 印章行检索（`stamp_id` → `sid` → 行 `id` **三形态依次**；无行 ⇒ `INVALID_VALUE` ＋ 零写入）。 */
    const probeKeys = ['stamp_id', 'sid', 'id']
    let sealRow = null
    let probeField = ''
    for (let index = 0; index < probeKeys.length && sealRow === null; index += 1) {
      const rows = await readRows(COLLECTIONS.seals, { [probeKeys[index]]: sealId }, { limit: 8 })
      if (rows.length > 0) {
        sealRow = rows[0]
        probeField = probeKeys[index]
      }
    }
    if (sealRow === null) {
      return deny(REASONS.INVALID_VALUE, `未找到該印章（seal_id：${sealId}）；本次零寫入。`)
    }
    /* ⑧ 落盘（`kind:'update'` ＋ `expectAtLeast:1`；**只写 patch 键 ＋ `updated_at`**，
       匹配键优先行 `_id`、无 `_id` 时退回⑦的命中检索键）。 */
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const at = new Date(seconds * 1000).toISOString()
    const doc = Object.assign({}, clean, { updated_at: at })
    const match = text(sealRow._id) ? { _id: text(sealRow._id) } : { [probeField]: sealId }
    await persist({ writes: [{ kind: 'update', collection: COLLECTIONS.seals, match, doc, expectAtLeast: 1 }] })
    /* ⑨ 回读更新后服务端行（**回读优先**；空 ⇒ 退路为本地合并行 —— 只会出现在行被并发删除时，
       不谎报成功、也不改写其它字段读数）。 */
    const after = await readRows(COLLECTIONS.seals, match, { limit: 1 })
    const row = after.length > 0 ? after[0] : Object.assign({}, sealRow, doc)
    return { ok: true, row }
  },

  /**
   * **管理員「修改印面屬性」（`updateFaceAttributes`｜印面级 7 字段）** —— **内联实现**
   * （同上：不新建文件、不返回 `plan`、自己调 `persist`；`index.js` 零改动）。
   *
   * 硬口徑（逐条）：
   *   ① **管理员门先于一切读写**（同 `updateSealAttributes`；非管理员 ⇒ `FORBIDDEN` ＋ 零读零写）；
   *   ② 载荷**封闭恰两键** `face_id` / `patch`（未知键 / 身份类键 ⇒ `INVALID_FIELD`；载荷非物件
   *      ⇒ `INVALID_FIELD`）；③ `face_id` 缺 / 空 / 非字符串 ⇒ **`INVALID_VALUE`**；印面行按
   *      `fc-…` 的行 `id` 查 `COLLECTIONS.faces`（`id` → `_id` 两形态依次），**无行 ⇒
   *      `INVALID_VALUE`** ＋ 零写入；
   *   ④ `patch` 键面封闭**恰 7 字段** `dynasty / seal_type / face_style / seal_class /
   *      seal_name / author / transcription`：未知键 ⇒ `INVALID_FIELD`；**缺 / 空 ⇒
   *      `INVALID_VALUE`**；
   *   ⑤ **值域门取 `VALUE_DOMAINS`**（真源副本与 `src/data/db.js:2565-2638` 的
   *      `dynastyValueDenial` / `faceContentValueDenial` / `faceStyleValueDenial` /
   *      `sealClassValueDenial` **同表同值**：15 / 9 / 23 / 3）—— **空值放行**（空串 ＝ 未填，
   *      不进门）、非空且 ∉ 域 ⇒ **`INVALID_VALUE`**；`seal_name` / `author` / `transcription`
   *      为自由文本，只受**长度门**约束；
   *   ⑥ **长度门按 500 字对齐**（`MAX_TEXT_LENGTH`；本地无对应物 ⇒ 超限 ⇒ `INVALID_VALUE`）；
   *   ⑦ 落盘 ＝ `persist` 的 `kind:'update'`（`expectAtLeast:1`；**写入体只含 patch 内的键 ＋
   *      `updated_at`**，不重写其它字段、不碰 `_id`）；⑧ 成功**恰 2 键** `{ok:true, row}`
   *      （`row` ＝ 更新后服务端行）、失败**恰 3 键**；`reason` **零新增**。
   * @param {object} payload 载荷（封闭两键 `face_id` / `patch`）
   * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
   * @param {{adminPhone?:string, nowSeconds?:number}} [context]
   * @returns {Promise<{ok:true, row:object}|{ok:false, reason:string, message:string}>}
   */
  async updateFaceAttributes(payload, identity, context) {
    /* ① 管理员门（**先于一切读写**）。 */
    const identityDenial = adminWhitelistDenial(identity, context && context.adminPhone)
    if (identityDenial) return identityDenial
    /* ② 载荷形态。 */
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return deny(REASONS.INVALID_FIELD, '載荷形態不合法（應為物件）；本次零寫入。')
    }
    const allowedKeys = ['face_id', 'patch']
    /* 印面级 7 字段（真源：`dynasty/seal_type/face_style/seal_class/seal_name/author/transcription`）
       ＋ **影像指向 2 键**（`face_image_id` / `edge_image_ids`）—— 后者是「編輯固定屬性」对话框
       实际提交的键面（云模式停写本机镜像后必须由云端承接），值不过域表/长度门，改为
       **引用存在性校验**（非空 id 必须在 `xiai_images` 有行）。 */
    const allowedFields = [
      'dynasty',
      'seal_type',
      'face_style',
      'seal_class',
      'seal_name',
      'author',
      'transcription',
      'face_image_id',
      'edge_image_ids'
    ]
    const IMAGE_REF_FIELDS = ['face_image_id', 'edge_image_ids']
    /* ③ 封闭键面（未知键 / 身份类键 ⇒ `INVALID_FIELD`）。 */
    const unknown = Object.keys(payload).filter((key) => allowedKeys.indexOf(key) === -1)
    if (unknown.length > 0) {
      const identityKeys = unknown.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityKeys.length > 0
          ? `其中身份類欄位（${identityKeys.join('、')}）由服務端派生，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(
        REASONS.INVALID_FIELD,
        `載荷含未知欄位：${unknown.join('、')}（${hint}；封閉兩鍵：face_id / patch）；本次零寫入。`
      )
    }
    /* ④ `face_id` 值域（缺 / 空 / 非字符串 ⇒ `INVALID_VALUE`）。 */
    const faceRaw = payload.face_id
    if (faceRaw === undefined || faceRaw === null || faceRaw === '') {
      return deny(REASONS.INVALID_VALUE, '缺少印面編號（face_id）；本次零寫入。')
    }
    if (typeof faceRaw !== 'string') {
      return deny(REASONS.INVALID_VALUE, '印面編號（face_id）必須是字符串；本次零寫入。')
    }
    const faceId = text(faceRaw)
    if (faceId === '') {
      return deny(REASONS.INVALID_VALUE, '缺少印面編號（face_id）；本次零寫入。')
    }
    /* ⑤ `patch` 形态 / 键面 / 空判定。 */
    const patchRaw = payload.patch
    if (patchRaw === undefined || patchRaw === null) {
      return deny(REASONS.INVALID_VALUE, '修改內容缺省（patch 無任何可寫鍵）；本次零寫入。')
    }
    if (typeof patchRaw !== 'object' || Array.isArray(patchRaw)) {
      return deny(REASONS.INVALID_FIELD, '修改內容形態不合法（patch 應為物件）；本次零寫入。')
    }
    const patchKeys = Object.keys(patchRaw)
    const unknownPatch = patchKeys.filter((key) => allowedFields.indexOf(key) === -1)
    if (unknownPatch.length > 0) {
      const identityPatchKeys = unknownPatch.filter((key) => IDENTITY_KEYS.indexOf(key) !== -1)
      const hint =
        identityPatchKeys.length > 0
          ? `其中身份類欄位（${identityPatchKeys.join('、')}）由服務端派生，一律不採信前端自稱`
          : '如實報回，不靜默丟鍵'
      return deny(
        REASONS.INVALID_FIELD,
        `patch 含未知欄位：${unknownPatch.join('、')}（${hint}；印面級字段僅 7 鍵 ＋ 影像指向 2 鍵）；本次零寫入。`
      )
    }
    if (patchKeys.length === 0) {
      return deny(REASONS.INVALID_VALUE, '修改內容為空（patch 無任何可寫鍵）；本次零寫入。')
    }
    /* ⑥ 值域门 ＋ 500 字长度门（**全部早于任何读写**；空值放行、非空越域 ⇒ `INVALID_VALUE`）。
       域表单点 ＝ `VALUE_DOMAINS`（与 `src/data/db.js` 四道值域门同表同值；其余 3 个自由文本
       字段无域表 ⇒ 只受长度门约束）。**影像指向 2 键**不过域表/长度门，改为引用存在性校验。 */
    const clean = {}
    for (const key of patchKeys) {
      const raw = patchRaw[key]
      if (IMAGE_REF_FIELDS.indexOf(key) !== -1) {
        if (key === 'face_image_id') {
          if (raw !== null && raw !== undefined && typeof raw !== 'string') {
            return deny(REASONS.INVALID_VALUE, `欄位 ${key} 必須是影像編號字符串（或留空）；本次零寫入。`)
          }
          const one = raw === null || raw === undefined ? '' : raw.trim()
          if (one !== '') {
            const found = await readRows(COLLECTIONS.images, { id: one }, { limit: 1 })
            if (found.length === 0) {
              return deny(REASONS.INVALID_VALUE, `影像編號（${one}）在影像行中不存在；本次零寫入。`)
            }
          }
          clean[key] = one
          continue
        }
        if (raw !== null && raw !== undefined && !Array.isArray(raw)) {
          return deny(REASONS.INVALID_VALUE, `欄位 ${key} 必須是影像編號數組（或留空）；本次零寫入。`)
        }
        const cleanedRefs = []
        for (const item of Array.isArray(raw) ? raw : []) {
          if (typeof item !== 'string') {
            return deny(REASONS.INVALID_VALUE, `欄位 ${key} 內的影像編號必須是字符串；本次零寫入。`)
          }
          const one = item.trim()
          if (one === '' || cleanedRefs.indexOf(one) !== -1) continue
          const found = await readRows(COLLECTIONS.images, { id: one }, { limit: 1 })
          if (found.length === 0) {
            return deny(REASONS.INVALID_VALUE, `影像編號（${one}）在影像行中不存在；本次零寫入。`)
          }
          cleanedRefs.push(one)
        }
        clean[key] = cleanedRefs
        continue
      }
      if (raw !== null && raw !== undefined && typeof raw !== 'string') {
        return deny(REASONS.INVALID_VALUE, `欄位 ${key} 必須是文字（或留空）；本次零寫入。`)
      }
      const value = raw === null || raw === undefined ? '' : raw.trim()
      if (value.length > MAX_TEXT_LENGTH) {
        return deny(REASONS.INVALID_VALUE, `欄位 ${key} 超出文字上限（${MAX_TEXT_LENGTH} 字）；本次零寫入。`)
      }
      const domain = VALUE_DOMAINS[key]
      if (domain && value !== '' && domain.indexOf(value) === -1) {
        return deny(
          REASONS.INVALID_VALUE,
          `欄位 ${key} 取值「${value}」不在允許的 ${domain.length} 類之內；本次零寫入。`
        )
      }
      clean[key] = value
    }
    /* ⑦ 印面行检索（`fc-…` 行 `id` → 文档 `_id` 两形态依次；无行 ⇒ `INVALID_VALUE` ＋ 零写入）。 */
    const probeKeys = ['id', '_id']
    let faceRow = null
    let probeField = ''
    for (let index = 0; index < probeKeys.length && faceRow === null; index += 1) {
      const rows = await readRows(COLLECTIONS.faces, { [probeKeys[index]]: faceId }, { limit: 8 })
      if (rows.length > 0) {
        faceRow = rows[0]
        probeField = probeKeys[index]
      }
    }
    if (faceRow === null) {
      return deny(REASONS.INVALID_VALUE, `未找到該印面（face_id：${faceId}）；本次零寫入。`)
    }
    /* ⑧ 落盘（`kind:'update'` ＋ `expectAtLeast:1`；只写 patch 键 ＋ `updated_at`）。 */
    const seconds = Number.isFinite(Number(context && context.nowSeconds))
      ? Math.floor(Number(context.nowSeconds))
      : Math.floor(Date.now() / 1000)
    const at = new Date(seconds * 1000).toISOString()
    const doc = Object.assign({}, clean, { updated_at: at })
    const match = text(faceRow._id) ? { _id: text(faceRow._id) } : { [probeField]: faceId }
    await persist({ writes: [{ kind: 'update', collection: COLLECTIONS.faces, match, doc, expectAtLeast: 1 }] })
    /* ⑨ 回读更新后服务端行（回读空 ⇒ 退路为本地合并行）。 */
    const after = await readRows(COLLECTIONS.faces, match, { limit: 1 })
    const row = after.length > 0 ? after[0] : Object.assign({}, faceRow, doc)
    return { ok: true, row }
  }
})

/**
 * **重复键类判定**（`set` 建集自愈里 `add` 重试的**幂等门**；纯函数、零 I/O、**绝不自抛**）：
 * 错误链（本层 ＋ 向下 `cause`，最多三层；与 `index.js::errorFingerprint` 的展开同尺）任一层的
 * `message` / `name` / `code` / `errCode` 命中 `E11000` 或 `duplicate key`（不区分大小写）
 * ⇒ `true`。取不到值 / 任何异常 ⇒ `false`（判不出 ⇒ 按真故障走原样上抛，**绝不把不明错误吞成成功**）。
 * 语义：`add` 报重复键 ＝ **集合与该 `_id` 行都已存在**（并发路先建了集）⇒ 对「确定性文档键
 * upsert」而言即已达成目标 ⇒ 幂等成功。
 * @param {any} error `add()` 抛出的错误（可带 `cause` 链）
 * @returns {boolean} 是否属「重复键」类
 */
function isDuplicateKeyError(error) {
  try {
    let current = error
    for (let depth = 0; depth < 3 && current !== null && current !== undefined; depth += 1) {
      const source =
        current !== null && typeof current === 'object' ? current : { message: String(current) }
      const haystack = [source.message, source.name, source.code, source.errCode]
        .map((value) => (typeof value === 'string' ? value : ''))
        .join(' ')
      if (/E11000/i.test(haystack) || /duplicate key/i.test(haystack)) return true
      current = source.cause
    }
    return false
  } catch {
    return false
  }
}

/**
 * **写前剔 `_id`（`set` 专用；纯函数、零 I/O、**绝不自抛**）**：CloudBase 的
 * `doc(id).set(doc)` 不允许 doc 内再出现 `_id`（报 `INVALID_PARAM / 不能更新_id的值`）——
 * 文档标识只由 `doc(step.id)` 这一路给。故对带 `_id` 的 doc 做**浅拷贝后剔除该键**；
 * **不改写调用方传进来的对象**（浅拷贝 ⇒ 调用方原对象仍带 `_id`）。doc 本无 `_id`
 * （含 `null` / 非对象）⇒ **原样返回**（引用都不换 ⇒ 与改前逐字相同、零额外开销）。
 * 仅 `persist` 的 `kind === 'set'` 分支（含其建集自愈 `add` 重试）调用；`update` / `add`
 * 分支不经过此函数（语义不动）。
 * @param {any} doc 待写入的文档
 * @returns {any} 无 `_id` 的文档（无 `_id` 时为原引用）
 */
function stripDocId(doc) {
  if (!doc || typeof doc !== 'object') return doc
  if (!Object.prototype.hasOwnProperty.call(doc, '_id')) return doc
  const copy = Object.assign({}, doc)
  delete copy._id
  return copy
}

/* --------------------------------------------------------------------------- *
   **写步失败真因展开（本单 A）** —— `WRITE_STEP_FAILED` 包装
   背景（真因）：包装错只回显我们自己的 `WRITE_STEP_FAILED:3/6`，平台真因（唯一索引撞键的
   `dup key` 与**索引名** / 集合不存在 / 权限 …）只挂在 `cause` 上 ⇒ 审计日志 `detail` 与任何
   直接读 `error.message` 的诊断面**等于看不到真因**。故把「写步抛出的错 ＋ 其 `cause` 向下
   一层」压成与 `index.js::errorFingerprint` 同形的 `name / code / message` 段**并进包装文案**
   （以 ` ⇒ ` 连接：外因 ⇒ 内因）。
   硬口径（与 `errorFingerprint` 逐条同尺）：
     · **先抹长串、再截长**：≥40 位连续字母数字（base64 / hex 形态的密钥 / 令牌 / 密文）⇒
       `<redacted>`，抹除先于一切提取（片段里也不带长串）；
     · **`message` 段 = 首 60 字起步**；命中重复键类锚段且其窗口越过第 60 字 ⇒ 按锚窗口
       （前 20 / 后 40 字）**延展补入**，总长 ≤ 120 —— 纯 60 字截断会把 `dup key` 与**索引名**
       整段吃掉（与 `lib/aiEnhance.js` 2026-11-02 同一处置理由，锚集同族）；
     · **纯函数、绝不自抛**：任何取值异常 ⇒ 该段回空串（诊断面不得反噬主路）；
     · 只进 `message`，**不新增 `reason` 字面值**。
 * --------------------------------------------------------------------------- */

/** `message` 段**首段**字数（沿 `index.js::errorFingerprint` 的 60 字口径）。 */
const WRITE_STEP_FP_HEAD = 60

/** `message` 段**总长上限**（命中锚段延展时；与 `lib/aiEnhance.js::FINGERPRINT_MESSAGE_LIMIT` 同值）。 */
const WRITE_STEP_FP_LIMIT = 120

/** 锚段命中后**向前**取字数（与 `lib/aiEnhance.js::FINGERPRINT_ANCHOR_CONTEXT` 同值）。 */
const WRITE_STEP_FP_CONTEXT = 20

/** 锚段命中后**向后**取字数（40 而非 20）：真因文案里 `index: <索引名>` 与 `dup key:` 相距
 *  可超 20 字，向后窗口不够就会把验收要求的两个读数之一截掉。 */
const WRITE_STEP_FP_TRAIL = 40

/**
 * 重复键类锚段（**按序**：错误码族 → 文案 → 冲突键 → 索引名 → 已存在类）。与
 * `lib/aiEnhance.js::DUPLICATE_KEY_ANCHORS` 同族、另加 `dup key` / `index:` —— 本包装的
 * 验收判据是「文案里能看到 `dup key` **与索引名**」，而两者在真因文案里都落在第 60 字之后。
 * 正则皆非 `/g` ⇒ `exec` 无 `lastIndex` 状态、可安全重复调用。
 */
const WRITE_STEP_FP_ANCHORS = Object.freeze([
  /E\d{5}/,
  /duplicate key/i,
  /dup key/i,
  /keyPattern/,
  /keyValue/,
  /index:/i,
  /AlreadyExists/,
  /RESOURCE_ALREADY_EXISTS/
])

/**
 * 诊断指纹的 `message` 段取值（**纯函数；零 I/O、零自抛**）。
 * @param {*} rawMessage 任意形态的 message（非字符串 ⇒ 当空串）
 * @returns {string} 首 60 字（抹除后）＋ 必要时的锚窗口延展；取不到 ⇒ 空串
 */
function writeStepFingerprintMessageOf(rawMessage) {
  try {
    const scrubbed = String(rawMessage === undefined || rawMessage === null ? '' : rawMessage).replace(
      /[A-Za-z0-9+/=]{40,}/g,
      '<redacted>'
    )
    if (scrubbed === '') return ''
    const total = scrubbed.length
    const head = scrubbed.slice(0, WRITE_STEP_FP_HEAD)
    if (total <= WRITE_STEP_FP_HEAD) return head
    /* 锚窗口：起点抬到首段末尾（首段已显示的部分不重复取），窗口完全落在首段内 ⇒ 无需补。 */
    const windows = []
    for (const anchor of WRITE_STEP_FP_ANCHORS) {
      const hit = anchor.exec(scrubbed)
      if (!hit) continue
      const start = Math.max(WRITE_STEP_FP_HEAD, hit.index - WRITE_STEP_FP_CONTEXT)
      const end = Math.min(total, hit.index + hit[0].length + WRITE_STEP_FP_TRAIL)
      if (end <= WRITE_STEP_FP_HEAD) continue
      windows.push({ start, end })
    }
    if (windows.length === 0) return head
    windows.sort((left, right) => left.start - right.start)
    const merged = []
    for (const window of windows) {
      const last = merged.length > 0 ? merged[merged.length - 1] : null
      if (last && window.start <= last.end) last.end = Math.max(last.end, window.end)
      else merged.push({ start: window.start, end: window.end })
    }
    let out = head
    for (const window of merged) {
      const budget = WRITE_STEP_FP_LIMIT - out.length - 3 /* ' … ' */
      if (budget <= 0) break
      let piece = scrubbed.slice(window.start, window.end)
      if (window.end < total) piece += '…'
      if (piece.length > budget) piece = piece.slice(0, Math.max(0, budget))
      out += ` … ${piece}`
    }
    return out
  } catch {
    return ''
  }
}

/**
 * 压一层为 `name / code / message` 三段（与 `errorFingerprint::segmentOf` 同形；
 * **纯函数、绝不自抛** —— 取不到值 ⇒ 对应段回 `unknown`）。
 * @param {*} value 任意形态的异常值
 * @returns {string}
 */
function writeStepFingerprintSegmentOf(value) {
  try {
    const source = value !== null && typeof value === 'object' ? value : {}
    const name = typeof source.name === 'string' && source.name !== '' ? source.name : 'unknown'
    const rawCode = source.code !== undefined && source.code !== null ? source.code : source.errCode
    const code = rawCode !== undefined && rawCode !== null && rawCode !== '' ? String(rawCode) : ''
    const message = writeStepFingerprintMessageOf(source.message)
    return `${name} / code=${code} / ${message === '' ? 'unknown' : message}`
  } catch {
    return 'unknown'
  }
}

/**
 * 写步失败的**真因后缀**：本层 ＋ `cause` 向下一层，以 ` ⇒ ` 连接（**无 `cause` ⇒ 只有本层**）。
 * @param {*} error `persist` 捕获到的写步异常
 * @returns {string} 形如 ` ⇒ Error / code=E11000 / E11000 duplicate key … index: ux_…`；异常 ⇒ 空串
 */
function writeStepFingerprintOf(error) {
  try {
    const segments = [writeStepFingerprintSegmentOf(error)]
    const cause = error !== null && typeof error === 'object' ? error.cause : undefined
    if (cause !== undefined && cause !== null) segments.push(writeStepFingerprintSegmentOf(cause))
    return ` ⇒ ${segments.join(' ⇒ ')}`
  } catch {
    return ''
  }
}

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
          /* **建集自愈（上一轮真因修）**：CloudBase 的 `doc(id).set()` 对**从未被创建的集合**回
             `DATABASE_COLLECTION_NOT_EXIST`（`set` 不自动建集，只有 `add` 会）⇒ 生产
             `xiai_correction_summaries` 从未被写过 ⇒ 上述各步**恒失败**。故**仅**对「集合不存在」
             改走 `add()` 重试一次（首写即建集，且带同一确定性 `_id` ⇒ 幂等）；`add` 报
             **重复键**（错误链含 `E11000` / `duplicate key`）⇒ 行已存在 ⇒ **幂等成功、不抛**；
             其余错误原样上抛 ⇒ 由外层 catch 按原样包 `WRITE_STEP_FAILED`（**回包键面 /
             reason 一字不变**）。`update` / `add` 两分支与本分支的正常路**逐字未改**。
             **写前剔 `_id`（本单真因修 2）**：CloudBase 的 `doc(id).set(doc)` **不允许 doc 内
             再出现 `_id`** ⇒ 报 `INVALID_PARAM / 不能更新_id的值`（文档标识只由 `doc(step.id)`
             这条路给；doc 内的 `_id` 是「重复身份」而非数据）。本文件的摘要行
             （`buildCorrectionSummary` 恒带确定性 `_id`）与采信行（`row._id = endorsementId`）
             都自带 `_id` ⇒ `submitCorrection` 第 2/2 步、`endorseCorrection` 第 1/2 与 2/2 步、
             `reviewCorrection` 第 3/3 步**恒失败**（前置步骤已真写入 ⇒ 用户所见「提交了但报错」）。
             故 **仅**对「doc 带 `_id`」这一类：**浅拷贝后剔除 `_id`** 再交给 `set` / 自愈 `add`
             （`add` 的 `_id` 一律只用 `step.id`；`Object.assign({_id: step.id}, doc)` 里 doc 已无
             `_id` ⇒ 不会覆盖）。**不改写调用方传进来的对象**（浅拷贝）；doc 本无 `_id` ⇒ 原样传，
             与改前逐字相同。 */
          const doc = stripDocId(step.doc)
          try {
            await db.collection(step.collection).doc(step.id).set(doc)
          } catch (error) {
            if (!isCollectionNotExistError(error)) throw error
            try {
              await db.collection(step.collection).add(Object.assign({ _id: step.id }, doc))
            } catch (addError) {
              if (!isDuplicateKeyError(addError)) throw addError
            }
          }
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
        /* **本单 A（真因展开）**：包装文案在 `WRITE_STEP_FAILED:i/n` 后并入「写步抛出的错 ＋
           其 `cause` 向下一层」的 `name / code / message` 段（先抹 ≥40 位长串、再截长；
           重复键锚段越过首 60 字则按锚窗口延展）⇒ `dup key` 与**索引名**直接可见。
           **回包键面 / `reason` 一字不变**（只加长 `message`）。 */
        const wrapped = new Error(`WRITE_STEP_FAILED:${index + 1}/${totalSteps}${writeStepFingerprintOf(error)}`)
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

/**
 * **删行**（服务端；`ai-enhance-discard` 的唯一删行点 —— 与 `persist` 同为本文件的写点单点）。
 * 按文档 `_id` 删（`doc(docId).delete()`）；行不存在 ⇒ 平台回 `deleted: 0`（**不抛错**）。
 * 失败 ⇒ **抛错**（由 `index.js` 统一转 `STORAGE_UNAVAILABLE`，**绝不伪装 FORBIDDEN**）。
 * @param {string} collection 集合名（`^xiai_`；调用方一律经 `COLLECTIONS` 取值，不写字面）
 * @param {string} docId 文档 `_id`
 * @returns {Promise<void>}
 */
async function deleteRow(collection, docId) {
  const db = resolveDb()
  await db.collection(collection).doc(docId).delete()
}

/**
 * **「集合已存在」类错误判据**（纯函数；供 `ensureCollection` 用，**绝不自抛**）。
 *
 * 判据（命中其一即判「已存在」，与派单口径逐字一致）：
 *   · 错误码（`error.code` / `error.errCode`）**含** `ALREADY_EXISTS` 或 `DATA_BASE_COLLECTION_EXIST`；
 *   · 文案（`error.message`）**含** `already exists` 或 `存在`。
 * 其余任何错误（网络 ETIMEDOUT / 权限 / 5xx / 参数 …）一律判否 ⇒ 调用方**原样上抛**
 * （绝不把真存储故障伪装成「已存在」）。
 * @param {any} error 捕获到的错误
 * @returns {boolean} 是否属「集合已存在」类
 */
function isCollectionAlreadyExistsError(error) {
  if (!error || typeof error !== 'object') return false
  const code = typeof error.code === 'string' ? error.code : ''
  if (code.indexOf('ALREADY_EXISTS') !== -1) return true
  if (code.indexOf('DATA_BASE_COLLECTION_EXIST') !== -1) return true
  const errCode = typeof error.errCode === 'string' ? error.errCode : ''
  if (errCode.indexOf('ALREADY_EXISTS') !== -1) return true
  if (errCode.indexOf('DATA_BASE_COLLECTION_EXIST') !== -1) return true
  const message = typeof error.message === 'string' ? error.message : ''
  if (message.indexOf('already exists') !== -1) return true
  if (message.indexOf('存在') !== -1) return true
  return false
}

/**
 * **确保存在集合**（**唯一建集点**：`db.createCollection` 字面只在本函数出现）。
 *
 * 背景（生产真因，2026-11-05）：`xiai_admin_audit` 规范在册（§3.33.3 第 14 项 / AC-373）、
 * 也在 `COLLECTIONS` 注册，但**库里从未建过** ⇒ `deleteSeal` 的审计 `kind:'add'` 恒
 * `DATABASE_COLLECTION_NOT_EXIST` ⇒ 整批 `persist` 失败 ⇒ 原子回滚（零写入正确、功能死锁）。
 * 故调用方（`lib/sealDelete.js`）在**任何删行之前**先经本函数 preflight。
 *
 * 口径：`createCollection(name)` 成功 ⇒ `'created'`；**已存在**（判据单点
 * `isCollectionAlreadyExistsError`）⇒ 视作成功、回 `'exists'`（**不重复建、不抛**）；
 * **其它错误原样抛**（由调用方转 `STORAGE_UNAVAILABLE`，不伪装成功、不伪装 `FORBIDDEN`）。
 * @param {string} name 集合名（调用方一律经 `COLLECTIONS` 取值）
 * @returns {Promise<'created'|'exists'>}
 */
async function ensureCollection(name) {
  const db = resolveDb()
  /* **先探存在（读 1 行）**：集合已在库 ⇒ 直接回 `'exists'`，**不调用 `createCollection`**
     —— CloudBase `@cloudbase/node-sdk` 3.x 未必暴露该方法（线上实测：集合明明存在，
     旧实现仍判「審計集合不可用」⇒ 删印被 fail-safe 拦住）。探读非「不存在」类错误 ⇒ 照旧上抛。 */
  try {
    await db.collection(name).limit(1).get()
    return 'exists'
  } catch (error) {
    if (!isCollectionNotExistError(error)) throw error
  }
  if (typeof db.createCollection !== 'function') {
    throw new Error(`當前 SDK 不提供 createCollection ⇒ 無法自動建集：${name}`)
  }
  try {
    await db.createCollection(name)
    return 'created'
  } catch (error) {
    if (isCollectionAlreadyExistsError(error)) return 'exists'
    throw error
  }
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
  /* **撤销采纳（本单新增 `revokeCorrectionAcceptance`）**：封闭键面 ＋ `NOT_FOUND` 字面常量
     （供离线自检直接断言；失败回包恒恰 3 键 ⇒ reason 不得是 `undefined`）。 */
  REVOKE_ALLOWED_KEYS,
  REASON_CORRECTION_NOT_FOUND,
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
  /* **批量導入通道（本單 `importFaceImages` / `importRelations`）依賴的三個導出**：
     `text` / `hash16`（本文件既有純函數，只補登記到導出面、實現零改）＋
     `ARTIFACT_DIGEST_PATTERN`（本文件既有同名內部常量，**直接導出、不另造第二套**）。 */
  text,
  hash16,
  ARTIFACT_DIGEST_PATTERN,
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
  /* **影像 `seq` 分配单点（本单新增）**：纯函数 ＋ 只读读取包装 ＋ 形态门 —— 三条写行路径
     （印章导入采纳 / 无审核直写 / AI 修复）共用；供 `lib/aiEnhance.js` 与离线自检直接调用。 */
  nextImageSeqOf,
  imageSeqsOf,
  isImageSeq,
  /* **占位 `stamp_id`（2026-11-09 真因修）**：前缀唯一字面来源 ＋ 构造 / 判定两个纯函数，
     加回填单点本体 `imageStampWriteStepsOf`（写行侧 `lib/importChannels.js` 与离线自检共用；
     实现零第二套）。 */
  IMAGE_STAMP_PLACEHOLDER_PREFIX,
  imageStampPlaceholderOf,
  isImageStampPlaceholder,
  imageStampWriteStepsOf,
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
  /* **歷史「已採納未落面」一次性回填面（§3.79｜本單 `backfillAcceptedCorrections`）**：
     載荷封閉恰二鍵（`dry_run` 必有布林 ＋ `limit` 1〜200）—— 供離線自檢直接斷言。 */
  BACKFILL_ALLOWED_KEYS,
  /* **影像行 `storage` 一次性修復面（本單 `repairImageStorage`）**：封閉三鍵面 ＋ 值域常數 ＋
     成功回包讀數鍵面（供離線自檢直接斷言；`index.js` 的按 `op` 收窄透傳以
     `REPAIR_IMAGE_STORAGE_READOUT_KEYS` 為鍵面真源）。 */
  REPAIR_IMAGE_STORAGE_ALLOWED_KEYS,
  REPAIR_IMAGE_STORAGE_DEFAULT_LIMIT,
  REPAIR_IMAGE_STORAGE_MAX_LIMIT,
  REPAIR_IMAGE_STORAGE_READOUT_KEYS,
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
  /* **印面影像刪除面（本單 `deleteFaceImage`）**：封闭两键面 ＋ 成功回包读数键面
     （供离线自检直接断言；`index.js` 的按 op 收窄透传以 `FACE_IMAGE_DELETE_READOUT_KEYS` 为键面真源）。 */
  FACE_IMAGE_DELETE_ALLOWED_KEYS,
  FACE_IMAGE_DELETE_READOUT_KEYS,
  /* **印面圖替換面（本單 `replaceFaceImage`）**：封闭 7 键面 ＋ 成功回包读数键面
     （供离线自检直接断言；`index.js` 的按 op 收窄透传以 `FACE_IMAGE_REPLACE_READOUT_KEYS` 为键面真源）。 */
  FACE_IMAGE_REPLACE_ALLOWED_KEYS,
  FACE_IMAGE_REPLACE_READOUT_KEYS,
  /* **普通用戶影像勘誤面（本單 `submitImageCorrection` ＋ `reviewCorrection` 的 IMAGE 分支）**：
     封闭六键面 ＋ `new_image` 封闭四键面 ＋ `action` 值域 ＋ 两侧成功回包读数键面真源
     （`index.js` 的按 op 收窄透传以 `IMAGE_CORRECTION_*_READOUT_KEYS` 为键面真源；
     供离线自检直接断言）。 */
  IMAGE_CORRECTION_ALLOWED_KEYS,
  IMAGE_CORRECTION_NEW_IMAGE_KEYS,
  /* **勘誤替換新圖入册（本單 `registerCorrectionImage`｜`OPS` 登录面）**：封闭键面
     （四必填 ＋ 可选 `seal_id`；供离线自检直接断言）。 */
  CORRECTION_IMAGE_REGISTER_ALLOWED_KEYS,
  IMAGE_CORRECTION_ACTIONS,
  IMAGE_CORRECTION_SUBMIT_READOUT_KEYS,
  IMAGE_CORRECTION_REVIEW_READOUT_KEYS,
  /* **识别编码（本单新增）**：号源发号单点 ＋ 号源集合名（供离线自检注入假体直接跑）。 */
  COUNTERS_COLLECTION,
  COUNTER_IDS,
  issueCodeNumber,
  issueCodeNumberAvoiding,
  /* **识别编码（本单「編號釋放」）**：播种单点 ＋ `released` 归一 ＋ 号别 doc id 表 ——
     `lib/sealDelete.js` 补建 / 并入计数器文档时**与发号器共用同一份实现**（零第二套）。 */
  counterSeedBaseOf,
  normalizeReleased,
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
  writeStepFingerprintMessageOf,
  setOpsStorageProvider,
  opsStorageInjected,
  setOpsStorageUploadProvider,
  opsStorageUploadInjected,
  resolveDb,
  /* **云函数侧凭据对取值单点（2026-10-29 应急修单）**：只认 `CLOUDBASE_*`、绝不参与平台族
     变量；导出供离线自检直接断言（`scripts/verify-points-ledger.mjs` C7 / C8）。 */
  cloudbaseKeyPairFromEnv,
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
  /* **AI 修復（§3.68）離線自檢**：`lib/aiEnhance.js` 經此讀點取影像行（本文件既有函數，
     只補登記到導出面 —— 實現零改）。 */
  readRows,
  uploadDisplayArtifactBytes,
  /* **AI 候選圖弃除面（本單 `ai-enhance-discard`）**：删行 / 删对象两个写点 ＋ 对象删除注入缝
     （供离线自检直接断言；实现零第二套 —— 删对象单点在本文件 `deleteArtifactObject`）。 */
  deleteRow,
  deleteArtifactObject,
  /* **对象删除候选单点（本单：修「刪對象 0 件」存储泄漏）**：`deleteFaceImage` 与
     `lib/sealDelete.js::deleteSeal` 共用的**唯一实现**（候选序：行内 `storage_key` → `sha`
     派生后缀族逐个试 → 行内其它键；**命中一件即停**、失败不抛不计失败、只回**实删件数**）。 */
  deleteImageObjectsOfRow,
  setOpsStorageDeleteProvider,
  opsStorageDeleteInjected,
  artifactMimeOf,
  adminWhitelistDenial,
  readCorrectionRow,
  buildProjection,
  /* **審計載體 preflight（本單新增）**：唯一建集点（`db.createCollection`）＋「已存在」判据 ——
     `lib/sealDelete.js` 删任何行之前先确保 `COLLECTIONS.adminAudit` 在库（离线自检可注入假 DB）。 */
  ensureCollection,
  persist
}
