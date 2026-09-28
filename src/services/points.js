/**
 * 玺爱 · 积分（单位「金」）服务
 *
 * 已冻结口径：
 *   - 新用户初始 50 金
 *   - 下载高清印面消耗 5 金，按**印章**维度计费：同一枚印章无论下载多少印面
 *     只算 1 次；同一「下载会话」内重复点击不得二次扣费（须幂等）
 *   - 勘误被采纳奖励 10 金
 *
 * 常量与只读查询保持骨架形态；扣费、奖励与流水的写入闭环追加在文件末尾
 * 的「闭环补全」段，页面一律经 services 门面调用。
 */

import {
  listPointRows,
  listDownloadRows,
  listUserRows,
  saveUserRows,
  savePointRows,
  saveDownloadRows
} from '../data/db.js'
import { readInvites, writeInviteRows, readInviteRewardSetting, userRowsInviteDenial, writeUserRowsGuarded } from '../data/drive.js'
import { currentUser, setUser } from '../data/session.js'

export const GOLD_UNIT = '金'
export const GOLD_INITIAL = 50
export const DOWNLOAD_COST = 5
export const CORRECTION_REWARD = 10

/**
 * **邀请注册奖励的默认值（10 金｜规范 §5.1 表下注（v1.21 追加）①：邀请人与被邀请人各 10 金）。**
 *
 * 为什么常量落在这里：§5.1 是**唯一写值处**（默认值写在那里），运行期可改值落站点配置键
 * `invite-reward`（§4.1.12）；本常量即「配置键缺失时的回落值」，**全工程只此一处**
 * （组件 / 视图不得硬编码该数值 ⇒ 一律经 `readInviteReward()` / `inviteRewardValue()` 取值）。
 */
export const INVITE_REWARD_DEFAULT = 10

export function getBalance() {
  const user = currentUser()
  return user ? user.points : 0
}

export function listLedger() {
  const user = currentUser()
  if (!user) return []
  return listPointRows().filter((row) => row.user_id === user.id)
}

/**
 * 下载报价（只读）。
 * charged 表示该印章在当前下载会话内是否已经计费过——用于保证幂等。
 * 注意：这里只做判断，不产生费用，也不写流水。
 */
export function quoteDownload(stampId, sessionKey) {
  const user = currentUser()
  if (!user) {
    return { ok: false, reason: 'UNAUTHENTICATED', cost: DOWNLOAD_COST, charged: false }
  }
  const charged = listDownloadRows().some(
    (row) =>
      row.user_id === user.id &&
      row.stamp_id === stampId &&
      row.session_key === sessionKey
  )
  const cost = charged ? 0 : DOWNLOAD_COST
  const affordable = charged || user.points >= DOWNLOAD_COST
  return {
    ok: affordable,
    reason: affordable ? 'OK' : 'INSUFFICIENT_GOLD',
    cost,
    charged,
    balance: user.points
  }
}


/* ============================================================================
   闭环补全（增量追加）
   ----------------------------------------------------------------------------
   上方既有的常量与只读查询签名、行为均未改动。
   以下为「扣费 / 奖励 / 流水」的写入闭环：余额变更与流水写入在同一处完成，
   保证余额与流水始终一致。页面不得自行读写存储，一律走 services 门面。
   ============================================================================ */

export const LEDGER_TYPE = {
  INITIAL: '初始贈送',
  DOWNLOAD: '下載消耗',
  CORRECTION_REWARD: '勘誤獎勵',
  /**
   * **第 4 类流水（v1.21 新增｜R-112）＝「邀請註冊」**（规范 §4.1.6 表下注（v1.21 追加）①：
   * 类型枚举自 v1.21 起为四类；**既有三类字面逐字未改**）。
   */
  INVITE: '邀請註冊'
}

let downloadSession = null

/**
 * 一次页面会话共用一个下载会话标识。
 * 计费维度是印章：同一印章在同一会话内重复点击不再扣费（幂等）。
 */
export function downloadSessionKey() {
  if (!downloadSession) {
    downloadSession = `ds-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
  return downloadSession
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 落库并同步登录态，返回更新后的用户副本。 */
function commitBalance(user) {
  const rows = listUserRows()
  saveUserRows(rows.map((row) => (row.id === user.id ? { ...row, ...user } : row)))
  const session = currentUser()
  if (session && session.id === user.id) setUser(user)
  return user
}

function appendLedger(user, amount, type, ref = {}) {
  const fresh = listUserRows().find((row) => row.id === user.id) || user
  const row = {
    id: makeId('lg'),
    user_id: user.id,
    amount,
    type,
    ref_type: ref.refType || 'account',
    ref_id: ref.refId || user.id,
    ref_label: ref.refLabel || '',
    balance_after: fresh.points,
    created_at: new Date().toISOString()
  }
  savePointRows([...listPointRows(), row])
  return row
}

/** 新账号的初始赠送流水（同一账号只记一次）。 */
export function grantInitialGold(user) {
  if (!user || !user.id) return { ok: false, created: false }
  if (listPointRows().some((row) => row.user_id === user.id)) return { ok: true, created: false }
  appendLedger(user, GOLD_INITIAL, LEDGER_TYPE.INITIAL, { refType: 'account', refLabel: '新用戶初始贈送' })
  return { ok: true, created: true }
}

/**
 * 按印章维度扣费下载高清印面。
 * @returns {{ok:boolean, reason:string, cost:number, charged:boolean, balance:number, message:string}}
 */
export function chargeSealDownload(stampId, sessionKey = downloadSessionKey(), sealName = '') {
  const user = currentUser()
  if (!user) {
    return {
      ok: false,
      reason: 'UNAUTHENTICATED',
      cost: DOWNLOAD_COST,
      charged: false,
      balance: 0,
      message: '請先登錄後再下載高清原圖'
    }
  }
  const downloads = listDownloadRows()
  const paidBefore = downloads.some(
    (row) => row.user_id === user.id && row.stamp_id === stampId && row.session_key === sessionKey
  )
  if (paidBefore) {
    return {
      ok: true,
      reason: 'ALREADY_CHARGED',
      cost: 0,
      charged: true,
      balance: user.points,
      message: `本次會話已爲《${sealName || stampId}》計費，不再重複扣除金`
    }
  }
  if (user.points < DOWNLOAD_COST) {
    return {
      ok: false,
      reason: 'INSUFFICIENT_GOLD',
      cost: DOWNLOAD_COST,
      charged: false,
      balance: user.points,
      message: `金餘額不足：下載需 ${DOWNLOAD_COST} 金，當前 ${user.points} 金`
    }
  }
  const updated = commitBalance({ ...user, points: user.points - DOWNLOAD_COST })
  saveDownloadRows([
    ...downloads,
    {
      id: makeId('dl'),
      user_id: user.id,
      stamp_id: stampId,
      session_key: sessionKey,
      cost: DOWNLOAD_COST,
      created_at: new Date().toISOString()
    }
  ])
  appendLedger(updated, -DOWNLOAD_COST, LEDGER_TYPE.DOWNLOAD, {
    refType: 'seal',
    refId: stampId,
    refLabel: sealName
  })
  return {
    ok: true,
    reason: 'OK',
    cost: DOWNLOAD_COST,
    charged: true,
    balance: updated.points,
    message: `已扣除 ${DOWNLOAD_COST} 金，本次會話內該印章不再重複扣費`
  }
}

/** 勘误被采纳的奖励（同一勘误只发一次）。 */
export function awardCorrectionReward(userId, correctionId) {
  if (listPointRows().some((row) => row.type === LEDGER_TYPE.CORRECTION_REWARD && row.ref_id === correctionId)) {
    return { ok: true, awarded: false, message: '該勘誤的獎勵此前已發放' }
  }
  const target = listUserRows().find((row) => row.id === userId)
  if (!target) return { ok: false, awarded: false, message: '未找到提交該勘誤的賬號' }
  const updated = commitBalance({ ...target, points: target.points + CORRECTION_REWARD })
  appendLedger(updated, CORRECTION_REWARD, LEDGER_TYPE.CORRECTION_REWARD, {
    refType: 'correction',
    refId: correctionId
  })
  return { ok: true, awarded: true, balance: updated.points, message: `已獎勵 ${CORRECTION_REWARD} 金` }
}

/* ============================================================================
   **邀請註冊獎勵（v1.21 新增｜R-112｜规范 §3.21.7 ＋ §5.1 表下注 ＋ §5.5 ＋ §4.1.11 / §4.1.12）**
   ----------------------------------------------------------------------------
   口径（逐条落到本段）：
     - **双方各 10**：一次成功邀请产生**两笔**奖励（邀请人 ＋、被邀请人 ＋），各自一笔
       `邀請註冊` 流水，**各自带「变更后余额」**（余额链仍可逐笔复算）；
     - **触发时点 ＝ 被邀请人註冊成功**（调用方只在该时点调本函数；不以邀请人登录 / 确认 /
       被邀请人下载等其它条件触发）；
     - **幂等**：同一邀请关系只结算一次（`invite.settled_at` 非空 ⇒ 不再发放；流水里已有
       同一邀请行的第 4 类流水 ⇒ 同样不再发放 ⇒ 双保险）；
     - **读配置键取值**：金额取自站点配置键 `invite-reward`（缺键 / 不可读 ⇒ 回落
       `INVITE_REWARD_DEFAULT`，即 §5.1 的默认值），并**把发放值快照进 `invite.reward`**
       （历史行与历史流水一经写入**不再改写** —— 改配置只影响之后的结算）；
     - **关系只落 `invites` 行**：`users` 行不得新增任何邀请相关键（新增 ⇒ `INVALID_FIELD`
       ＋ 零写入，该门由数据层行白名单把守；本段只更新既有 `points` 字段）。
   写入顺序（避免「已发奖而无结算痕迹」）：先落 `invites` 行（`invitee_user_id` ＋ `reward`
   快照 ＋ `settled_at`），再落两笔流水与余额。所有拒绝判定都早于任何写入。
   ============================================================================ */

/**
 * 读运行期可改值（结构化读数；**页面插值用**，含来源标注 ⇒ 页面不硬编码数字）。
 * @returns {{ok:boolean, value:number, source:'setting'|'default', present:boolean, reason?:string, message:string}}
 */
export function readInviteReward() {
  const read = readInviteRewardSetting()
  if (!read.ok) {
    return {
      ok: false,
      value: INVITE_REWARD_DEFAULT,
      source: 'default',
      present: false,
      reason: read.reason,
      message: `${read.message}（頁面按規範 §5.1 的預設值顯示）`
    }
  }
  if (!read.present) {
    return {
      ok: true,
      value: INVITE_REWARD_DEFAULT,
      source: 'default',
      present: false,
      message: '尚未設置可改值：按規範 §5.1 的預設值顯示。'
    }
  }
  return { ok: true, value: read.value, source: 'setting', present: true, message: read.message }
}

/** 现行有效值（配置键 ⇒ 默认值回落；供结算内部取数）。 */
export function inviteRewardValue() {
  const read = readInviteReward()
  return read.value
}

/**
 * 邀请面的余额提交：**必经「邀请键」门**的用户行写入口（`writeUserRowsGuarded`）——
 * 越权 / 契约外键一律 `INVALID_FIELD` ＋ 零写入，本函数据此返回 `null` 由调用方收口。
 * （既有的 `commitBalance` 行为一字未动，仍服务下载 / 勘误 / 初始赠送三条既有路径。）
 */
function commitInviteBalance(user) {
  const rows = listUserRows().map((row) => (row.id === user.id ? { ...row, ...user } : row))
  const write = writeUserRowsGuarded(rows)
  if (!write.ok) return null
  const session = currentUser()
  if (session && session.id === user.id) setUser(user)
  return user
}

/**
 * 邀请结算（**双方各一笔**；幂等；读配置键取值；发放值快照进 `invite.reward`）。
 *
 * @param {string} inviterId 邀请人用户 id
 * @param {string} inviteeId 被邀请人用户 id（＝刚註冊成功的那位）
 * @returns {{ok:true, settled:boolean, idempotent?:boolean, reward?:number, invite?:object,
 *            ledger?:Array<object>, inviter?:object, invitee?:object, message:string}
 *          |{ok:false, reason:string, message:string}}
 */
export function settleInviteReward(inviterId, inviteeId) {
  const inviter = String(inviterId ?? '').trim()
  const invitee = String(inviteeId ?? '').trim()
  if (!inviter || !invitee) {
    return { ok: false, settled: false, reason: 'INVALID_VALUE', message: '邀請結算需要邀請人與被邀請人的賬號標識；本次零寫入。' }
  }
  if (inviter === invitee) {
    return { ok: false, settled: false, reason: 'INVALID_VALUE', message: '邀請人與被邀請人不能是同一個賬號；本次零寫入。' }
  }

  /* 两方账号都存在才结算（判定在任何写入之前 ⇒ 拒绝时零写入）。 */
  const inviterUser = listUserRows().find((row) => row.id === inviter)
  const inviteeUser = listUserRows().find((row) => row.id === invitee)
  if (!inviterUser || !inviteeUser) {
    return { ok: false, settled: false, reason: 'INVALID_VALUE', message: '邀請結算需要兩方賬號都存在於用戶表；本次零寫入。' }
  }

  /* 邀请键门（§4.1.11 表下注 ①）：`users` 行不得出现任何邀请相关键 ——
     两方用户行一经带上（无论谁写的）⇒ `INVALID_FIELD` ＋ 零写入（判定早于任何写入）。 */
  const userRowDenial = userRowsInviteDenial([inviterUser, inviteeUser])
  if (userRowDenial) return { ...userRowDenial, settled: false }

  const read = readInvites()
  if (!read.ok) return { ...read, settled: false }

  const settledBefore = read.rows.find(
    (row) => row.inviter_user_id === inviter && row.invitee_user_id === invitee && row.settled_at
  )
  if (settledBefore) {
    return {
      ok: true,
      settled: false,
      idempotent: true,
      reason: 'ALREADY_SETTLED',
      reward: settledBefore.reward,
      invite: settledBefore,
      message: '同一邀請關係只結算一次，本次不再發放。'
    }
  }

  const pending = read.rows.find(
    (row) => row.inviter_user_id === inviter && (row.invitee_user_id === null || row.invitee_user_id === invitee)
  )
  if (pending && listPointRows().some((row) => row.type === LEDGER_TYPE.INVITE && row.ref_id === pending.id)) {
    return {
      ok: true,
      settled: false,
      idempotent: true,
      reason: 'ALREADY_SETTLED',
      reward: pending.reward,
      invite: pending,
      message: '同一邀請關係只結算一次，本次不再發放。'
    }
  }

  const reward = inviteRewardValue()
  const at = new Date().toISOString()
  const settledRow = pending
    ? { ...pending, invitee_user_id: invitee, reward, settled_at: at }
    : {
        id: makeId('iv'),
        inviter_user_id: inviter,
        invitee_user_id: invitee,
        reward,
        created_at: at,
        settled_at: at
      }
  const nextInvites = pending
    ? read.rows.map((row) => (row.id === pending.id ? settledRow : row))
    : [...read.rows, settledRow]

  const writeInvite = writeInviteRows(nextInvites)
  if (!writeInvite.ok) return { ...writeInvite, settled: false }

  const inviterUpdated = commitInviteBalance({ ...inviterUser, points: inviterUser.points + reward })
  if (!inviterUpdated) {
    return { ok: false, settled: false, reason: 'INVALID_FIELD', message: '邀請人用戶行未通過「邀請鍵」門；本次未發放任何獎勵。' }
  }
  const inviterLedger = appendLedger(inviterUpdated, reward, LEDGER_TYPE.INVITE, {
    refType: 'invite',
    refId: settledRow.id,
    refLabel: LEDGER_TYPE.INVITE
  })

  const freshInvitee = listUserRows().find((row) => row.id === invitee) || inviteeUser
  const inviteeUpdated = commitInviteBalance({ ...freshInvitee, points: freshInvitee.points + reward })
  if (!inviteeUpdated) {
    return { ok: false, settled: false, reason: 'INVALID_FIELD', message: '被邀請人用戶行未通過「邀請鍵」門；本次未發放被邀請人那一筆。' }
  }
  const inviteeLedger = appendLedger(inviteeUpdated, reward, LEDGER_TYPE.INVITE, {
    refType: 'invite',
    refId: settledRow.id,
    refLabel: LEDGER_TYPE.INVITE
  })

  return {
    ok: true,
    settled: true,
    idempotent: false,
    reward,
    invite: settledRow,
    ledger: [inviterLedger, inviteeLedger],
    inviter: { id: inviter, amount: reward, balance: inviterUpdated.points, ledger_id: inviterLedger.id },
    invitee: { id: invitee, amount: reward, balance: inviteeUpdated.points, ledger_id: inviteeLedger.id },
    message: `已向邀請人與被邀請人各發放 ${reward} 金。`
  }
}
