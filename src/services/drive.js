/**
 * 玺爱 · 【我的雲盤】服务层（資料夾 / 引用行 / 分享）
 *
 * 依据（规范 v1.22 §3.21.3 〜 §3.21.6 ＋ §4.1.8 〜 §4.1.10 ＋ §6.3 ＋ 增量件 §5.1 ③④⑤）：
 *   - **引用式**：資料夾只持印章**引用**（`seal_id`）；「移出」恰 ＝ 删那条引用行，
 *     印章行 / 印面行 / 影像行与**其它资料夹的引用行**逐字不变；
 *   - **一印章多夹**、**夹内 `added_at` 降序**（同值时按引用行 `id` 降序 ⇒ 确定序，
 *     该确定序同时写在 `README` 的登记段）；
 *   - **编号** `SL` ＋ 9 位零填充（自 `SL000000001` 起连续递增、全局唯一）；
 *   - **重复存入幂等**（同夹同印不新增第二行、不改写 `added_at`）；
 *   - **枚数 / 条目 id 数组一律现场派生**（资料夹行内不落第二份 —— 双写必然漂移）；
 *   - **分享**：8 位小写 ASCII 短碼（全局唯一）＋ `expires_at ＝ created_at ＋ 720 小时`；
 *     「重新生成」⇒ 旧行立刻落 `revoked_at`（**不删行**）＋ 新行新 `code`；
 *     **同一資料夾任一時刻恰 ≤ 1 條有效分享**；
 *   - **投影**：`resolveShare(code)` 在**投影层**就把被遮内容摘掉（未登錄 ⇒ 名 ＋ 印數 ＋
 *     夹内倒序前 3 枚；第 4 枚起的任何印文 / 縮略圖欄位**不在返回物件裏**）；
 *     登錄後（含非擁有者）返回完整清单（**只读**）。
 *
 * 权限（§6.3）：写操作（新建 / 存入 / 移出 / 生成分享 / 重新生成）**仅拥有者** ⇒
 * 非拥有者一律 `{ok:false, reason:'FORBIDDEN'}` ＋ **零写入**；读分享面**不得**以「非擁有者」拒
 * （读面口径对三态一致），但本文件的读入口一律**只读**，不提供任何越权写路径。
 *
 * 上屏文案一律**繁体**（`s2t(x) === x`），且**零「切分」措辞**。
 */

import { listSealRows, listFaceRows, primaryFaceIn } from '../data/db.js'
import { currentUser } from '../data/session.js'
import {
  readSeallists,
  writeSeallistRows,
  readSeallistItems,
  writeSeallistItemRows,
  readShares,
  writeShareRows
} from '../data/drive.js'

/* ============================================================================
   口径常量（**唯一落点**；组件侧不得硬编码这些数值 —— §5.1 表下注 ＋ §5.3 共同禁令）
   ============================================================================ */

/** 資料夾编号前缀与位数（§4.1.8：`SL` 大写 ASCII ＋ 恰 9 位零填充）。 */
export const SEALLIST_CODE_PREFIX = 'SL'
export const SEALLIST_CODE_DIGITS = 9
export const SEALLIST_CODE_PATTERN = /^SL\d{9}$/

/** 分享短碼（§4.1.10：恰 8 位、小写 ASCII 字母或数字）。 */
export const SHARE_CODE_LENGTH = 8
export const SHARE_CODE_PATTERN = /^[0-9a-z]{8}$/
export const SHARE_CODE_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 分享默认有效期（§3.21.5(b)：恰 30 天，按 720 小时计 ⇒ 2592000000 毫秒）。 */
export const SHARE_TTL_HOURS = 720
export const SHARE_TTL_MS = SHARE_TTL_HOURS * 60 * 60 * 1000

/** 未登錄可见枚数（§3.21.6：前 3 枚）。 */
export const SHARE_PREVIEW_LIMIT = 3

/** 分享状态（**一律现场派生**，不落第二份状态字段）。 */
export const SHARE_STATE = Object.freeze({
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  UNKNOWN: 'UNKNOWN'
})

/** 短碼生成的冲突重试上限（§11 W-24 的字符集内部规则待裁 ⇒ 本单只用「同字符集 ＋ 唯一性重试」）。 */
const SHARE_CODE_MAX_TRIES = 32

/* ============================================================================
   小工具
   ============================================================================ */

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function allow(patch) {
  return { ok: true, ...patch }
}

function deny(reason, message) {
  return { ok: false, reason, message }
}

/** 未登錄 ⇒ 结构化拒绝（不得静默失败）。 */
function unauthenticated(message) {
  return deny('UNAUTHENTICATED', message)
}

/** 越权 ⇒ 结构化拒绝（与数据层同字面值 `FORBIDDEN`；判定早于任何写入）。 */
function forbidden(message) {
  return deny('FORBIDDEN', message)
}

function nowIso() {
  return new Date().toISOString()
}

/** 时间降序（同值时按 `id` 降序 ⇒ 确定序，与 README 登记一致）。 */
function byTimeDesc(a, b) {
  const diff = Date.parse(b.added_at || b.created_at || 0) - Date.parse(a.added_at || a.created_at || 0)
  if (diff !== 0) return diff
  return String(b.id || '').localeCompare(String(a.id || ''))
}

function fold(text) {
  return String(text ?? '').trim()
}

/* ============================================================================
   印章「引用侧面」的现场派生（**只读**：印文 `seal_name` ＋ 缩略图影像 `image_id`）
   ----------------------------------------------------------------------------
   引用式要求：资料夹行 / 引用行**只持 `seal_id`**（不得落印文 / 影像 id / 影像字节副本）。
   展示所需的印文与缩略图**在读取时由印章本体现场派生**（全工程就此一处派生实现，
   避免与印章本体漂移）；本函数**不写任何一行**。
   ============================================================================ */

function sealBriefOf(sealId) {
  const id = fold(sealId)
  const seal = listSealRows().find((row) => row.id === id || row.stamp_id === id) || null
  if (!seal) return { seal_id: id, seal_name: '', image_id: '', found: false }
  const stampId = seal.id || seal.stamp_id || id
  const faces = listFaceRows().filter((row) => (row.sealId || row.stamp_id) === stampId)
  const primary = primaryFaceIn(faces)
  return {
    seal_id: id,
    seal_name: seal.seal_name || seal.name || '',
    image_id: primary && primary.face_image_id ? String(primary.face_image_id) : '',
    found: true
  }
}

/* ============================================================================
   資料夾：新建 / 读取（拥有者面）
   ============================================================================ */

/** 编号生成：按存量编号取最大值 ＋ 1（自 `SL000000001` 起连续递增 ⇒ 不跳号、不重复）。 */
function nextSeallistCode(rows) {
  let max = 0
  rows.forEach((row) => {
    const code = String(row.code || '')
    if (!SEALLIST_CODE_PATTERN.test(code)) return
    const value = Number(code.slice(SEALLIST_CODE_PREFIX.length))
    if (Number.isFinite(value) && value > max) max = value
  })
  return `${SEALLIST_CODE_PREFIX}${String(max + 1).padStart(SEALLIST_CODE_DIGITS, '0')}`
}

/**
 * 新建資料夾（§4.1.8）：`owner_user_id` 恒为当前登录用户；`updated_at ＝ created_at`。
 * @returns {{ok:true, row:object, code:string}|{ok:false, reason:string, message:string}}
 */
export function createFolder(name) {
  const user = currentUser()
  if (!user) return unauthenticated('請先登錄後再新增資料夾。')

  const clean = fold(name)
  if (!clean) return deny('INVALID_VALUE', '請先填寫資料夾名稱。')

  const read = readSeallists()
  if (!read.ok) return read

  const now = nowIso()
  const row = {
    id: makeId('sl'),
    code: nextSeallistCode(read.rows),
    owner_user_id: user.id,
    name: clean,
    created_at: now,
    updated_at: now
  }
  const write = writeSeallistRows([...read.rows, row])
  if (!write.ok) return write
  return allow({ row, code: row.code, count: write.count, folder_id: row.id, message: `已新增資料夾「${clean}」` })
}

/** 当前登录用户的資料夾清单（`created_at` 降序；`item_count` 现场派生）。 */
export function listMyFolders() {
  const user = currentUser()
  if (!user) return unauthenticated('請先登錄後再查看資料夾。')

  const folders = readSeallists()
  if (!folders.ok) return folders
  const items = readSeallistItems()
  if (!items.ok) return items

  const rows = folders.rows
    .filter((row) => row.owner_user_id === user.id)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map((row) => ({
      ...row,
      item_count: items.rows.filter((item) => item.seallist_id === row.id).length
    }))

  return allow({
    rows,
    count: rows.length,
    empty: rows.length === 0,
    message: rows.length === 0 ? '尚無資料夾，先新增一個資料夾吧。' : `共 ${rows.length} 個資料夾。`
  })
}

/** 拥有者判定（非拥有者 ⇒ `FORBIDDEN` ＋ 零写入）。 */
function ownedFolder(folderId, actionLabel) {
  const user = currentUser()
  if (!user) return unauthenticated('請先登錄後再繼續。')
  const read = readSeallists()
  if (!read.ok) return read
  const folder = read.rows.find((row) => row.id === folderId)
  if (!folder) return deny('INVALID_VALUE', `找不到該資料夾（${actionLabel}）；本次零寫入。`)
  if (folder.owner_user_id !== user.id) {
    return forbidden(`僅資料夾的擁有者可以${actionLabel}；本次零寫入。`)
  }
  return allow({ rows: read.rows, folder, actor: user })
}

/** 读单个資料夾（拥有者面；含现场派生的枚数）。 */
export function getFolder(folderId) {
  const owned = ownedFolder(folderId, '查看該資料夾')
  if (!owned.ok) return owned
  const items = readSeallistItems()
  if (!items.ok) return items
  const rows = items.rows.filter((item) => item.seallist_id === owned.folder.id)
  return allow({
    folder: { ...owned.folder, item_count: rows.length },
    item_count: rows.length,
    message: `資料夾「${owned.folder.name}」共 ${rows.length} 枚印章。`
  })
}

/* ============================================================================
   存入 / 移出（引用式）
   ============================================================================ */

/**
 * 把印章存入資料夾（**幂等**：同夹同印重复存入 ⇒ 不新增第二行、不改写 `added_at`）。
 * @returns {{ok:true, created:boolean, idempotent:boolean, item:object, item_count:number, message:string}
 *          |{ok:false, reason:string, message:string}}
 */
export function addSealToFolder(folderId, sealId) {
  const owned = ownedFolder(folderId, '把印章存入該資料夾')
  if (!owned.ok) return owned

  const target = fold(sealId)
  if (!target) return deny('INVALID_VALUE', '缺少印章標識；本次零寫入。')

  const brief = sealBriefOf(target)
  if (!brief.found) return deny('INVALID_VALUE', '找不到該印章（引用式要求引用存在的印章）；本次零寫入。')

  const items = readSeallistItems()
  if (!items.ok) return items

  const existing = items.rows.find((row) => row.seallist_id === owned.folder.id && row.seal_id === target)
  const itemCount = items.rows.filter((row) => row.seallist_id === owned.folder.id).length
  if (existing) {
    /* 幂等：既有行逐字不变（含 `added_at`），仍给可见反馈（§3.21.4(f)）。 */
    return allow({
      created: false,
      idempotent: true,
      item: existing,
      item_count: itemCount,
      message: `「${owned.folder.name}」中已有這枚印章。`
    })
  }

  const item = { id: makeId('sli'), seallist_id: owned.folder.id, seal_id: target, added_at: nowIso() }
  const write = writeSeallistItemRows([...items.rows, item])
  if (!write.ok) return write
  return allow({
    created: true,
    idempotent: false,
    item,
    item_count: itemCount + 1,
    message: `已存入「${owned.folder.name}」`
  })
}

/**
 * 从資料夾移出印章（**恰 ＝ 删那条引用行**）：印章行 / 印面行 / 影像行与其它资料夹的引用行逐字不变。
 * @returns {{ok:true, removed:boolean, item:object|null, item_count:number, message:string}
 *          |{ok:false, reason:string, message:string}}
 */
export function removeSealFromFolder(folderId, sealId) {
  const owned = ownedFolder(folderId, '把印章移出該資料夾')
  if (!owned.ok) return owned

  const target = fold(sealId)
  if (!target) return deny('INVALID_VALUE', '缺少印章標識；本次零寫入。')

  const items = readSeallistItems()
  if (!items.ok) return items

  const hit = items.rows.find((row) => row.seallist_id === owned.folder.id && row.seal_id === target)
  if (!hit) {
    return allow({
      removed: false,
      item: null,
      item_count: items.rows.filter((row) => row.seallist_id === owned.folder.id).length,
      message: `「${owned.folder.name}」中本來就沒有這枚印章。`
    })
  }
  const next = items.rows.filter((row) => row.id !== hit.id)
  const write = writeSeallistItemRows(next)
  if (!write.ok) return write
  return allow({
    removed: true,
    item: hit,
    item_count: next.filter((row) => row.seallist_id === owned.folder.id).length,
    message: '已移出資料夾（印章仍在藏品庫中）。'
  })
}

/**
 * 夹内清单（**`added_at` 降序**；枚数现场派生；每条的印文 / 缩略图现场由印章本体现派生）。
 * 读面：**仅拥有者**（非拥有者 ⇒ `FORBIDDEN`）—— 分享链的读面口径走 `resolveShare`，不在此处。
 */
export function listFolderItems(folderId) {
  const owned = ownedFolder(folderId, '查看該資料夾的印章')
  if (!owned.ok) return owned

  const items = readSeallistItems()
  if (!items.ok) return items

  const ordered = items.rows.filter((row) => row.seallist_id === owned.folder.id).sort(byTimeDesc)
  const rows = ordered.map((item) => ({ ...item, ...sealBriefOf(item.seal_id) }))
  return allow({
    folder: owned.folder,
    rows,
    seal_ids: rows.map((row) => row.seal_id),
    item_count: rows.length,
    order: 'added_at 降序（同值時按引用行 id 降序）',
    empty: rows.length === 0,
    message: rows.length === 0 ? '這個資料夾還是空的。' : `共 ${rows.length} 枚印章`
  })
}

/* ============================================================================
   分享：生成 / 重新生成 / 按短碼读取（两态投影）
   ============================================================================ */

/** 状态现场派生（`revoked_at` ⇒ 已作废；否则按 `expires_at` 与当前时间比对）。 */
export function shareStateOf(row, nowMs = Date.now()) {
  if (!row) return SHARE_STATE.UNKNOWN
  if (row.revoked_at) return SHARE_STATE.REVOKED
  const expires = Date.parse(row.expires_at)
  if (!Number.isFinite(expires)) return SHARE_STATE.UNKNOWN
  return expires <= nowMs ? SHARE_STATE.EXPIRED : SHARE_STATE.ACTIVE
}

function codeTaken(rows, code) {
  return rows.some((row) => row.code === code)
}

/** 生成一个全局唯一的 8 位短碼（撞码即重试；超上限 ⇒ 结构化拒绝 ＋ 零写入）。 */
function mintShareCode(rows) {
  for (let attempt = 0; attempt < SHARE_CODE_MAX_TRIES; attempt += 1) {
    let code = ''
    for (let index = 0; index < SHARE_CODE_LENGTH; index += 1) {
      code += SHARE_CODE_ALPHABET[Math.floor(Math.random() * SHARE_CODE_ALPHABET.length)]
    }
    if (!codeTaken(rows, code)) return code
  }
  return ''
}

/** 该资料夹当前有效的分享行（至多 1 条；`≤ 1` 由数据层值域门同时兜底）。 */
export function activeShareOf(folderId) {
  const shares = readShares()
  if (!shares.ok) return shares
  const hit = shares.rows.find((row) => row.seallist_id === folderId && shareStateOf(row) === SHARE_STATE.ACTIVE)
  return allow({ row: hit || null, found: Boolean(hit) })
}

function newShareRow(folder, rows) {
  const code = mintShareCode(rows)
  if (!code) return null
  const created = nowIso()
  return {
    id: makeId('sh'),
    seallist_id: folder.id,
    code,
    owner_user_id: folder.owner_user_id,
    created_at: created,
    expires_at: new Date(Date.parse(created) + SHARE_TTL_MS).toISOString(),
    revoked_at: null
  }
}

/**
 * 生成分享（仅拥有者）。**已有有效分享时返回既有那条**（`created:false`）——
 * 这样「同时最多一条有效」在生成路径上天然成立；要换链接请走 `regenerateShare`。
 * @returns {{ok:true, created:boolean, row:object}|{ok:false, reason:string, message:string}}
 */
export function createShare(folderId) {
  const owned = ownedFolder(folderId, '生成該資料夾的分享連結')
  if (!owned.ok) return owned

  const shares = readShares()
  if (!shares.ok) return shares

  const current = shares.rows.find(
    (row) => row.seallist_id === owned.folder.id && shareStateOf(row) === SHARE_STATE.ACTIVE
  )
  if (current) {
    return allow({ created: false, row: current, code: current.code, message: '該資料夾已有有效的分享連結，直接沿用。' })
  }

  const row = newShareRow(owned.folder, shares.rows)
  if (!row) {
    return deny('STORAGE_UNAVAILABLE', `短碼生成連續衝突（已重試 ${SHARE_CODE_MAX_TRIES} 次）；本次零寫入，請稍後再試。`)
  }
  const write = writeShareRows([...shares.rows, row])
  if (!write.ok) return write
  return allow({ created: true, row, code: row.code, message: '已生成分享連結。' })
}

/**
 * 重新生成分享（仅拥有者）：**旧行立刻落 `revoked_at`（旧链立即失效）＋ 不删旧行 ＋ 新行新 `code`**。
 * 旧行与新行在**同一次集合写**里落盘（单键覆盖 ⇒ 不存在「旧链未作废而新链已存在」的中间态）。
 * @returns {{ok:true, row:object, revoked:object|null}|{ok:false, reason:string, message:string}}
 */
export function regenerateShare(folderId) {
  const owned = ownedFolder(folderId, '重新生成該資料夾的分享連結')
  if (!owned.ok) return owned

  const shares = readShares()
  if (!shares.ok) return shares

  const active = shares.rows.find(
    (row) => row.seallist_id === owned.folder.id && shareStateOf(row) === SHARE_STATE.ACTIVE
  )
  const row = newShareRow(owned.folder, shares.rows)
  if (!row) {
    return deny('STORAGE_UNAVAILABLE', `短碼生成連續衝突（已重試 ${SHARE_CODE_MAX_TRIES} 次）；本次零寫入，請稍後再試。`)
  }
  const revoked = active ? { ...active, revoked_at: nowIso() } : null
  const next = shares.rows.map((item) => (revoked && item.id === revoked.id ? revoked : item))
  const write = writeShareRows([...next, row])
  if (!write.ok) return write
  return allow({
    row,
    revoked,
    code: row.code,
    message: revoked ? '已重新生成連結，舊連結立即失效。' : '已生成分享連結。'
  })
}

/**
 * 按短碼读取（**投影层摘除被遮内容**；未登錄 ⇒ 名 ＋ 印數 ＋ 夹内倒序前 3 枚）。
 *
 * 返回形状（**未登錄**）：`{ok, state, code, folder_id, folder_name, item_count, authenticated,
 * locked, visible_limit, masked_count, visible_items:[{seal_id, seal_name, image_id}], message}`。
 * 未登錄时 `visible_items` **恰为前 3 枚**；**第 4 枚起的任何印文 / 縮略圖欄位都不在本物件内**
 * （没有 `all_items` / `item_ids` / 任何第二份清单位）。
 * 登錄后（含非擁有者）⇒ `visible_items` ＝ 完整清单（**只读**，本函数不提供任何写路径）。
 * @returns {{ok:true, ...}|{ok:false, reason:string, message:string}}
 */
export function resolveShare(code) {
  const text = fold(code)
  if (!SHARE_CODE_PATTERN.test(text)) {
    return deny('INVALID_VALUE', '分享連結無效：短碼形態不符（應為 8 位小寫字母或數字）。')
  }

  const shares = readShares()
  if (!shares.ok) return shares
  const row = shares.rows.find((item) => item.code === text)
  if (!row) {
    return allow({
      state: SHARE_STATE.UNKNOWN,
      code: text,
      folder_id: '',
      folder_name: '',
      item_count: 0,
      authenticated: Boolean(currentUser()),
      locked: true,
      visible_limit: 0,
      masked_count: 0,
      visible_items: [],
      message: '這個分享連結不存在或已失效。'
    })
  }

  const state = shareStateOf(row)
  if (state !== SHARE_STATE.ACTIVE) {
    return allow({
      state,
      code: text,
      folder_id: '',
      folder_name: '',
      item_count: 0,
      authenticated: Boolean(currentUser()),
      locked: true,
      visible_limit: 0,
      masked_count: 0,
      visible_items: [],
      message: state === SHARE_STATE.EXPIRED ? '這個分享連結已過期。' : '這個分享連結已失效。'
    })
  }

  const folders = readSeallists()
  if (!folders.ok) return folders
  const folder = folders.rows.find((item) => item.id === row.seallist_id)
  if (!folder) {
    return deny('INVALID_VALUE', '分享行指向的資料夾不存在（資料可能已損壞）；本次不投影任何印文 / 縮略圖。')
  }

  const items = readSeallistItems()
  if (!items.ok) return items
  const ordered = items.rows.filter((item) => item.seallist_id === folder.id).sort(byTimeDesc)
  const briefs = ordered.map((item) => sealBriefOf(item.seal_id))
  const authenticated = Boolean(currentUser())
  const visible = authenticated ? briefs : briefs.slice(0, SHARE_PREVIEW_LIMIT)

  return allow({
    state: SHARE_STATE.ACTIVE,
    code: text,
    folder_id: folder.id,
    folder_name: folder.name,
    item_count: briefs.length,
    authenticated,
    locked: !authenticated,
    visible_limit: authenticated ? briefs.length : SHARE_PREVIEW_LIMIT,
    masked_count: authenticated ? 0 : Math.max(briefs.length - SHARE_PREVIEW_LIMIT, 0),
    visible_items: visible,
    order: 'added_at 降序（同值時按引用行 id 降序）',
    message: authenticated ? '已按只讀方式返回完整清單。' : '登錄後查看完整清單'
  })
}
