/**
 * 玺爱 · 本地持久化底座（纯前端 mock）
 *
 * 本文件是全工程**唯一**允许直接读写 localStorage 的模块。
 * 组件与服务之外的任何代码都不得触碰浏览器存储。
 */

const NS = 'xiai:v1:'

function safeParse(raw) {
  if (raw === null || raw === undefined) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function readKey(key) {
  try {
    return safeParse(window.localStorage.getItem(NS + key))
  } catch {
    return null
  }
}

export function writeKey(key, value) {
  try {
    const target = migrationBackupWriteKey(key, value)
    window.localStorage.setItem(NS + target, JSON.stringify(value))
    /* **兼容镜像（仅副本键族）**：真正落点与调用方给的键不同（＝按代际改了落点），且**调用方
       那个键此刻为空** ⇒ 把同一份副本补写在它那里（老调用方只认旧键名时仍读得到一份回滚副本；
       该键**已有值**时**绝不覆盖** —— 这正是「旧副本不被取代」）。非副本键：`target === key`，
       本段不进，写口径逐字不变。 */
    if (target !== key && window.localStorage.getItem(NS + key) === null) {
      window.localStorage.setItem(NS + key, JSON.stringify(value))
    }
    return true
  } catch {
    return false
  }
}

export function removeKey(key) {
  try {
    window.localStorage.removeItem(NS + key)
    return true
  } catch {
    return false
  }
}

export function hasKey(key) {
  try {
    return window.localStorage.getItem(NS + key) !== null
  } catch {
    return false
  }
}

/**
 * 本工程**全部**存储键的登记表（口径：加了 `xiai:v1:` 命名空间后即真实键名）。
 *
 * 登记纪律：
 *   - 新增键**必须**在这里登记（否则「本工程用了哪些键」不再可枚举）；
 *   - 登记**只是登记**：`readKey` / `writeKey` / `removeKey` / `hasKey` 一律仍是
 *     `NS + key` 的朴素拼接，**不因登记表而改变任何既有键的读写口径**；
 *     漏登记的键（老库里的历史键）照旧可读可写，行为一字不变。
 *     ⚠️ **唯一例外（R-91 本单）**：**回滚副本键族**（名字以 `migration-backup:` 开头
 *     且在 `MIGRATION_BACKUP_GENERATIONS` 内）的**写**路径按「代际」路由到该代自己的槽位
 *     （并在调用方那个键**为空**时补一份兼容镜像）—— 理由见文件末「回滚副本的代际键」段：
 *     不路由则新代迁移会**重建**同一个键、把上一代的副本**取代**掉。
 *     **读 / 清除**路径仍逐字朴素（读哪个键就取哪个键的值；`hasKey` 报物理存在），
 *     非副本键完全不受影响。
 */
export const STORAGE_KEYS = {
  seals: 'seals',
  faces: 'faces',
  images: 'images',
  users: 'users',
  corrections: 'corrections',
  photos: 'photos',
  points: 'points',
  session: 'session',
  downloaded: 'downloaded',
  seeded: 'seeded',
  theme: 'theme',
  /**
   * **用途：「我的雲盤」資料夾行**（规范 §4.1.8｜v1.21 新增；写方 ＝ `data/drive.js`，只经本文件）。
   * 真实键名 `xiai:v1:seallists`；行 ＝ `{id, code, owner_user_id, name, created_at, updated_at}`。
   * 与既有 13 键**逐字无交集**（新增键不得与既有键同名、不得复用既有键承载新实体）。
   */
  seallists: 'seallists',
  /**
   * **用途：資料夾引用行**（规范 §4.1.9｜v1.21 新增；写方 ＝ `data/drive.js`）。
   * 真实键名 `xiai:v1:seallist-items`；行 ＝ `{id, seallist_id, seal_id, added_at}`（**引用式**：
   * 不得落印章字段副本 —— 副本会漂移，且会把单值推过 AC-33 的 64 KiB 线）。
   */
  seallistItems: 'seallist-items',
  /**
   * **用途：分享連結行**（规范 §4.1.10｜v1.21 新增；写方 ＝ `data/drive.js`）。
   * 真实键名 `xiai:v1:shares`；行 ＝ `{id, seallist_id, code, owner_user_id, created_at, expires_at, revoked_at}`；
   * 有效 / 过期 / 已作废**一律现场派生**（不得落第二份状态字段）。
   */
  shares: 'shares',
  /**
   * **用途：邀請行**（规范 §4.1.11｜v1.21 新增；写方 ＝ `data/drive.js`）。
   * 真实键名 `xiai:v1:invites`；行 ＝ `{id, inviter_user_id, invitee_user_id, reward, created_at, settled_at}`。
   * **邀请关系只落本键** —— `users` 行不得新增邀请相关键（新增 ⇒ `INVALID_FIELD` ＋ 零写入）。
   */
  invites: 'invites',
  /**
   * **用途：站點配置（可改数值的落点）**（规范 §4.1.12｜v1.21 新增；写方 ＝ `data/drive.js`）。
   * 真实键名 `xiai:v1:invite-reward`；值形态 ＝ `{invite_reward: <number>}`（非负整数）。
   * 默认值 10 的真源仍是规范 §5.1（唯一写值处）；本键**引用**该默认值，不构成第二处口径数值。
   */
  inviteReward: 'invite-reward',
  /**
   * **用途：繁体化迁移的回滚副本**（R-60｜写方＝`db.js` 的 `migrateTraditionalData()`，
   * 值＝迁移动手**之前**的原始行数组，含 `at` / `version` / `counts` / 各行集合）。
   * 与其它键同一命名空间（真实键名 `xiai:v1:migration-backup:r57trad`），
   * 同样只经本文件的 `writeKey` / `readKey` 读写。
   * 真源常量仍是 `db.js` 导出的 `TRAD_MIGRATION_BACKUP_KEY`（该常量取本项 ⇒ 只有一处值）。
   */
  migrationBackupTrad: 'migration-backup:r57trad',
  /**
   * **用途：配色類型迁移（记账版本 `3` / R-83・R-84）的回滚副本**（写方＝`db.js` 的
   * `migrateTraditionalData()`，值＝该次动手**之前**的原始行数组，含 `at` / `version` / `counts`）。
   *
   * 为什么必须**独立**一个键（R-91 本单）：迁移已升到版本 `3`，而此前工程内只有
   * `migration-backup:r57trad` 一个副本键 ⇒ 报 v3 的迁移会**重建**该键，
   * 把上一代（v1 / v2）的副本**取代**掉（旧副本不可回取）。本键让**两代副本共存**：
   * `migration-backup:r57trad`＝v1 / v2 那一代，本键＝v3 那一代。
   * 路由与读 / 写 / 清除统一走文件末的「回滚副本的代际键」段（`MIGRATION_BACKUP_GENERATIONS`）。
   */
  migrationBackupPalette: 'migration-backup:r83palette',
  /**
   * **用途：公開勘誤投影行的本機鏡像**（读面接线新增；写方 ＝ `db.js` 的
   * `savePublicCorrectionRows` / `services/corrections.js` 的采纳镜像，读方 ＝ `db.js`
   * `listPublicCorrectionRows`）。真实键名 `xiai:v1:corrections-public`。
   * 行 ＝ **已采纳勘误的公开投影**（键面与云端 `xiai_corrections_public` 文档**逐字对齐**：
   * `_id = 'cp-<correction_id>'` ＋ `{correction_id, faceId, sealId, stamp_id, field, field_label,
   * value, status:'ACCEPTED', reviewed_at, updated_at, schema:'xiai-corrections-public-v1'}`；
   * 身份类键（`user_id` / `reviewer_id` / `review_note`）**一律不落**）。
   * `_id` 与云端文档键**同值** ⇒ 云端形态下数据层覆盖层按 `_id` 配对合成一行，
   * 行身份（`correction_id` → `id`，剥 `cp-`）去重归一，同一条勘误**只计一次**。
   * 它是云端公开只读集合 `xiai_corrections_public` 的**本机镜像 / 展示缓存**，
   * **不是**勘误本体（本体在 `corrections` 键 / 云端 `xiai_corrections`）。
   * 与既有键**逐字无交集**（既有键一字不动、不改名、不删）。
   */
  correctionsPublic: 'corrections-public',
  /**
   * **用途：采信（採信）私有行的本機鏡像**（本单新增；写方 ＝ `services/endorsements.js`，
   * 读方 ＝ 同服务的幂等判定 `已採信`）。真实键名 `xiai:v1:endorsements`。
   * 行 ＝ **本人**的采信行（`{_id, faceId, sealId, stamp_id, field, value, user_id,
   * identity_source, created_at}` —— `user_id` 是不透明 uid，**不落手机号**）——
   * 它**不是**公开面，仅供本机判定「我是否已对该值采信」。
   * 云端权威行落在私有集合 `xiai_endorsements`（ACL PRIVATE ⇒ 只能由云函数写）；本键是镜像 / 缓存。
   * 与既有键**逐字无交集**（既有键一字不动、不改名、不删）。
   */
  endorsements: 'endorsements',
  /**
   * **用途：值级公开摘要行的本機鏡像**（本单新增；写方 ＝ `services/corrections.js` /
   * `services/endorsements.js` 的写面镜像，读方 ＝ `db.js::listCorrectionSummaryRows` →
   * 详情页「N 人提交 / M 人採信」与候选值列表）。真实键名 `xiai:v1:correction-summaries`。
   * 行 ＝ 值级公开摘要行（`{_id:'cs-<faceId>-<field>-<value 的 sha256 前 16 位>', faceId, sealId,
   * stamp_id, field, value, submits, endorses, status, submitter_uids, updated_at,
   * schema:'xiai-correction-summaries-v1'}`）—— **零手机号**、uid 允许（`submitter_uids` 是不透明
   * uid 去重列表，**不带昵称 / 手机号**）。
   * `_id` 与云端文档键**同值** ⇒ 云端形态下数据层覆盖层按 `_id` 配对合成一行。
   * 它是云端公开只读集合 `xiai_correction_summaries` 的**本机镜像 / 展示缓存**；
   * 取代此前尚未上线的 `endorsement-counts` 键（**不留两套**）。
   * 与既有键**逐字无交集**（既有键一字不动、不改名、不删）。
   */
  correctionSummaries: 'correction-summaries',
  /**
   * **用途：正式印人（A 支 歷史作者）的本機鏡像**（person-model §2｜v1.53 新增；
   * 写方 ＝ `db.js` 的 `savePersonRows`（**仅采纳路径调用**），读方 ＝ `listPersonRows` /
   * `personById` / `personExistsById` / `resolveAuthorName`）。
   * 真实键名 `xiai:v1:persons`。行 ＝ `{id, code, family_name, given_name, courtesy_names[],
   * art_names[], alias_names[], birth_year, death_year, cbdb_id, card_id, proposal_id,
   * created_by, created_at, updated_at}`；`display_name` **派生不落盘**（§2「派生不落盘」）。
   * 它是云端 `xiai_persons` 集合的本机镜像 / 展示缓存；**不得**承载平台用户（B 支并在 `users`）。
   * 与既有键**逐字无交集**（既有键一字不动、不改名、不删）。
   */
  persons: 'persons',
  /**
   * **用途：印人提案 / 审核行**（person-model §3｜v1.53 新增；写方 ＝ `services/persons.js`，
   * 读方 ＝ `db.js` 的 `listPersonProposalRows`）。
   * 真实键名 `xiai:v1:person-proposals`。行 ＝ `{id, batch_id, target_person_id, status,
   * family_name, given_name, courtesy_names[], art_names[], alias_names[], birth_year, death_year,
   * cbdb_id, card_id, note, submitted_by, submitted_at, reviewed_at, reviewer_id, review_note,
   * dedupe_key}`；`status` 三态单向终态不回退（§3 / §3.47）。
   * 它是云端 `xiai_person_proposals` 集合的本机镜像；**正式印人只经采纳路径产生**（§2 单写者）。
   * 与既有键**逐字无交集**（既有键一字不动、不改名、不删）。
   */
  personProposals: 'person-proposals',
  /**
   * **用途：外部批量導入行（暫存 / PENDING）的本機鏡像**（批 2 前置｜v1.54｜§3.54.14 / §4.1.16 新增；
   * 写方 ＝ `db.js::savePersonImportRows`（**仅外部导入通道与采纳路径调用**），读方 ＝
   * `listPersonImportRows` / `personImportBySourceId`）。
   * 真实键名 `xiai:v1:person-imports`。行 ＝ `{id, batch_id, source, source_person_id,
   * status, name_full, family_name, given_name, courtesy_names[], art_names[], alias_names[],
   * birth_year, death_year, native_place, native_place_chs, biography, biography_chs,
   * nationality, cbdb_id, source_id, imported_by, imported_at, reviewed_at, reviewer_id,
   * review_note}`；`status` 恰三态单向终态不回退（§3.54.14）；身份类键（`imported_by` /
   * `reviewer_id`）**零手机号**（沿 §3.49）。
   * 它是云端 `xiai_person_imports` 集合的本机镜像；**本集合与 `persons` 皆单写者**
   * （只经采纳路径写；不开放任何直写入口，含管理员直写 ⇒ `FORBIDDEN` ＋ 零写入）。
   * 与既有键**逐字无交集**（既有键一字不动、不改名、不删）。
   */
  personImports: 'person-imports'
}

/* ============================================================================
   回滚副本的**代际键**（R-91）
   ----------------------------------------------------------------------------
   问题（本单收口）：迁移的记账版本在涨（1 → 2 → **3**），但副本键只有一个
   （`migration-backup:r57trad`）⇒ 版本 `3` 的迁移一来就在**同一个键**上写自己的快照，
   上一代的副本**被取代**（老库里的 v1/v2 原貌再也回不去）。

   做法：把副本键族按**代际**登记在下表，并让**写**路径按值里的记账版本 `version`
   路由到**该代自己的键**：
     - `version 1..2` ⇒ `migration-backup:r57trad`（v1 / v2 那一代，**不再被后续代覆盖**）；
     - `version 3..`   ⇒ `migration-backup:r83palette`（v3 配色類型那一代）。
   值里没有可用的 `version` ⇒ 按调用方给的原键朴素写（老行为，不猜、不改写口径）。
   （老库已在该键有副本 ⇒ **绝不覆盖** ⇒ 旧副本原样留在它自己那一代）。

   ⚠️ **如实登记的已知后果（不是缺陷遮掩，是冻结文件的边界）**：写方 `db.js` 仍是
   `writeKey(TRAD_MIGRATION_BACKUP_KEY, payload)`（`TRAD_MIGRATION_BACKUP_KEY` = 本表
   `migrationBackupTrad`，那文件**本单不得改**）⇒ ① 副本字节按上表落在 `r83palette`
   （这正是本单要的「旧副本不被取代」）；② 但 `db.js` 报告里的 `backup_key` 字段仍会
   打印 `migration-backup:r57trad`（写方常量，非实际落点），`backup_supersedes_previous`
   也会因为「读到过旧副本」而为 `true` —— 两个**报告字段**与实况不符。把 `db.js` 的
   写方键换成代际感知的同一个真源（或让它读 `migrationBackupWriteKey` 的结果）即可消掉，
   已登记为跨单缺口。
   ============================================================================ */

/** 副本键代际表（顺序＝代数升序；`to: Infinity`＝最新一代，承接其后所有版本）。 */
export const MIGRATION_BACKUP_GENERATIONS = Object.freeze([
  Object.freeze({ key: STORAGE_KEYS.migrationBackupTrad, from: 1, to: 2, label: 'r57trad' }),
  Object.freeze({ key: STORAGE_KEYS.migrationBackupPalette, from: 3, to: Infinity, label: 'r83palette' })
])

/** 已登记的副本键（判「是不是副本键族」用；顺序同代际表）。 */
export const MIGRATION_BACKUP_KEYS = Object.freeze(MIGRATION_BACKUP_GENERATIONS.map((gen) => gen.key))

/**
 * **写路径的代际路由**：副本键族 + 值带记账 `version` ⇒ 返回该代自己的键；
 * 其它情形一律返回原键（既有写口径零变化）。
 * @param {string} key 调用方给的键
 * @param {*} value 待写值
 * @returns {string} 真正落盘的键
 */
export function migrationBackupWriteKey(key, value) {
  if (!MIGRATION_BACKUP_KEYS.includes(key)) return key
  const version = value && typeof value === 'object' ? Number(value.version) : Number.NaN
  if (!Number.isFinite(version)) return key
  const gen = MIGRATION_BACKUP_GENERATIONS.find((item) => version >= item.from && version <= item.to)
  return gen ? gen.key : key
}

/**
 * **读路径（逐代读）**：每个已登记的副本键各读一次 ⇒ `{ [键]: 副本 | null }`。
 * 读口径**逐字朴素**（读哪个键就是那个键的值，不跨键兜底）⇒ 每一代副本都能**单独**取到
 * （这正是「两代共存」的判据：两个键各自都有值）。
 */
export function readMigrationBackups() {
  const out = {}
  MIGRATION_BACKUP_KEYS.forEach((key) => {
    out[key] = readKey(key)
  })
  return out
}

/** **最新一代副本**（代数最高且真的有值的那一代）⇒ `{ key, version, payload } | null`。 */
export function latestMigrationBackup() {
  for (let i = MIGRATION_BACKUP_GENERATIONS.length - 1; i >= 0; i -= 1) {
    const gen = MIGRATION_BACKUP_GENERATIONS[i]
    const payload = readKey(gen.key)
    if (payload !== null && payload !== undefined) {
      return {
        key: gen.key,
        version: payload && typeof payload === 'object' ? payload.version ?? null : null,
        payload
      }
    }
  }
  return null
}

/**
 * **清除路径（逐代清除，与登记表同步）**：把每个**已登记**的副本键一并删掉
 * （只删代际表里的键 ⇒ 不误伤任何别的键）。返回逐键结果，供排障与自证。
 * @returns {{ok:boolean, removed:string[], results:Record<string, boolean>}}
 */
export function clearMigrationBackups() {
  const results = {}
  const removed = []
  MIGRATION_BACKUP_KEYS.forEach((key) => {
    const had = hasKey(key)
    const ok = removeKey(key)
    results[key] = ok
    if (had && ok) removed.push(key)
  })
  return { ok: Object.values(results).every((flag) => flag === true), removed, results }
}
