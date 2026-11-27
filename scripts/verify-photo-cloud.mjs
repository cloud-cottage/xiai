#!/usr/bin/env node
/**
 * 玺爱 · **实物照片云端化（合并去重 / hidden 可见性 / 两步上传停写 IDB / 管理三钮按行收窄）**
 * 回归套件
 * ============================================================================
 * 被测实现（2026-11-27 本单落盘；**只读**、不改任何被测件）：
 *   · `src/services/photos.js`
 *       —— 合并单点 `mergeSealPhotoRows`（云端在前 / 本机在后 / 同 `sha256` 只留云端份 /
 *          `hidden` 非管理员不可见）；两步上传 `uploadSealPhotoCloud`（① `displayFetch('/image/store')`
 *          ② `userWriteGate('createSealPhoto')`，**全程不碰本机存储**）；管理三 op
 *          `setSealPhotoHidden` / `deleteSealPhoto` 走 `userWriteGate`（**不是** `adminWriteGate`）。
 *   · `src/views/SealDetailView.vue`（模板）
 *       —— 管理三钮按行收窄：整块 `v-if="canManagePhotos"` ＋ 内层
 *          `<template v-if="photo.storage === 'cloud'">` ⇒ **本机遗留行三钮零渲染**。
 *
 * 判据口径（照本仓既有套件）：
 *   · **零联网、零浏览器、零生产读写**：
 *       ① 云函数通道由 `setCloudFunctionTransport` 假件接管（`public` 读面 ＋ `verify` 写面
 *          全在本脚本内按 op 分派，**不打任何真实云函数**）；
 *       ② `globalThis.fetch` 换成本地假件（只认 `/image/store`，摘要按**实际收到的字节**现算）；
 *       ③ `globalThis.indexedDB` 换成内存假库，**逐次 `put` 计数**（“IDB 零写”判据的读数源）；
 *       ④ `localStorage` / `window` 用内存 Map 桩撑起数据层；
 *       ⑤ `writeFaceMode` 强制 `cloud`（否则 `userWriteGate` 走 dev 放行分支 ⇒ 通道探针失效）。
 *   · 模板面走 **SFC 分段去注释**（`<template>` 只剥 `<!-- -->`，`<script>` 剥块注释与行尾 `//`）
 *     —— 产品件注释里逐字写着 `data-photo-hide` / `storage === 'cloud'` 等解释性字样，
 *     不剥会把说明当实码。
 *   · 每条判据可判负；负对照见 F 段（**尺子必须会响**），且只在内存副本上变异，不写被测件。
 *
 * 分段：
 *   A  合并去重（5）：同 `sha256` 只留云端份 / 同 id 去重 / **云端在前、本机在后** /
 *      本机行 `local:true`、云端行 `storage:'cloud'` ＋ `local:false`。
 *   B  hidden 可见性（4）：`canManageSealPhotos` 随角色翻转 / 非管理员合并结果零 `hidden` 行 /
 *      管理员含 `hidden` 行且徽标＝服务层单点 `PHOTO_HIDDEN_BADGE`（上屏繁体「已隱藏」）。
 *   C  两步上传（8）：① 失败 ⇒ **连第 ② 步都不发**、IDB 零写；① 成 ② 败 ⇒ IDB 零写 ＋
 *      **零元数据行** ＋ 文案含「登記失敗」；两步全成 ⇒ IDB 零写 ＋ 列表含新行（云端份）。
 *   D  三钮收窄（5）：整块门 `canManagePhotos` 在场 / 三钩子全在 `storage==='cloud'` 条件块内 /
 *      条件块**外**零钩子 / 由模板抽出的门表达式求值：云端行 3、本机行 0、非管理员 0。
 *   E  静态门（6）：`data-photo-hidden-badge`、本机遗留说明行 `data-photo-local-leftover`、
 *      `userWriteGate('setSealPhotoHidden' | 'deleteSealPhoto')` 调用在场且**零 `adminWriteGate`**，
 *      ＋ 两条通道的**运行时探针**（假通道真收到这两个 op 与逐字载荷）。
 *   F  变异负对照（3）：① 把「不写 IDB」改回写 ⇒ 红；② 去掉 hidden 过滤 ⇒ 红；
 *      ③ 拆掉 `storage==='cloud'` 条件块 ⇒ 红。
 *
 * 纪律：只读 `src/**`；不新增依赖；不打印任何令牌 / 密钥；断言失败 ⇒ 退出码非 0。
 */
/* **测试环境保护哨兵**：本套只跑离线假通道，置 `XIAI_NO_REAL_CARD=1`（漏注入 ⇒ 当场零请求报错，
   绝不悄悄打生产 CARD）。跑本套前不得 export 真 `CARD_API_KEY`（见 `scripts/README-test-net.md`）。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

const VIEW_REL = 'src/views/SealDetailView.vue'
const SERVICE_REL = 'src/services/photos.js'
const SEAL = 'S0001'

/* =========================================================================== */
/* 0. 断言骨架（沿既有套件形态：check(id, desc, expected, actual) ＋ 末尾 JSON 汇总） */
/* =========================================================================== */
const results = []
let failures = 0

function canon(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`)
    .join(',')}}`
}

function check(id, desc, expected, actual) {
  const pass = canon(expected) === canon(actual)
  if (!pass) failures += 1
  results.push({ id, case: desc, pass, expected, actual })
  console.log(JSON.stringify({ id, case: desc, pass, expected, actual }))
}

const section = (id, title) => console.log(JSON.stringify({ section: id, title }))
const countOf = (text, re) => (text.match(re) || []).length
const sha256Hex = (buf) => createHash('sha256').update(Buffer.from(buf)).digest('hex')

/* =========================================================================== */
/* 1. 离线环境：localStorage 桩 ＋ 内存假 IndexedDB（put 逐次计数） ＋ 假 fetch    */
/* =========================================================================== */

/* 1.1 localStorage / window（数据层在 Node 下跑起来的最小桩；只写内存）。 */
const memory = new Map()
const localStorageShim = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => {
    memory.set(key, String(value))
  },
  removeItem: (key) => {
    memory.delete(key)
  },
  clear: () => memory.clear()
}
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = localStorageShim
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}

/* 1.2 内存假 IndexedDB：`put` 逐次计数 ⇒ 「IDB 零写」判据的读数源。
      形态照 `blobstore.js` 的真实用法：`open()` 异步回 `request`（回调先赋值后触发）、
      `transaction()` 同步返回 `tx`（`tx.oncomplete` 在 `run(store)` 之后才被赋值）⇒
      一律用微任务延后触发，避免同步回调早于赋值。 */
const idbLog = { puts: [], deletes: [], gets: 0 }
const idbKv = new Map()

function fakeRequest() {
  return { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: undefined, error: null }
}

function fakeObjectStore() {
  return {
    put(value, key) {
      const request = fakeRequest()
      request.result = key
      idbKv.set(String(key), value)
      idbLog.puts.push(String(key))
      return request
    },
    get(key) {
      const request = fakeRequest()
      idbLog.gets += 1
      request.result = idbKv.get(String(key))
      return request
    },
    getKey(key) {
      const request = fakeRequest()
      request.result = idbKv.has(String(key)) ? String(key) : undefined
      return request
    },
    delete(key) {
      const request = fakeRequest()
      idbKv.delete(String(key))
      idbLog.deletes.push(String(key))
      return request
    },
    clear() {
      const request = fakeRequest()
      idbKv.clear()
      return request
    },
    getAllKeys() {
      const request = fakeRequest()
      request.result = [...idbKv.keys()]
      return request
    }
  }
}

globalThis.indexedDB = {
  databases: async () => [{ name: 'xiai:v1:assetblobs' }],
  open() {
    const request = fakeRequest()
    queueMicrotask(() => {
      const stores = new Set()
      const db = {
        objectStoreNames: { contains: (name) => stores.has(name) },
        createObjectStore: (name) => {
          stores.add(name)
        },
        transaction: () => {
          const tx = { oncomplete: null, onabort: null, onerror: null, error: null, objectStore: () => fakeObjectStore() }
          queueMicrotask(() => {
            if (typeof tx.oncomplete === 'function') tx.oncomplete()
          })
          return tx
        }
      }
      request.result = db
      if (typeof request.onupgradeneeded === 'function') request.onupgradeneeded({ target: request })
      if (typeof request.onsuccess === 'function') request.onsuccess({ target: request })
    })
    return request
  }
}

/* 1.3 假 fetch：只服务 `POST …/image/store`（摘要按**实际收到的字节**现算 ⇒ 不采信自报值）。 */
const fetchLog = []
let fetchMode = 'ok' /* 'ok' | 'reject' */
globalThis.fetch = async (url, init) => {
  fetchLog.push({ url: String(url), method: init && init.method, bytes: init && init.body ? init.body.length : 0 })
  const body = init && init.body
  if (fetchMode === 'reject') {
    return {
      ok: false,
      status: 500,
      json: async () => ({ ok: false, reason: 'STORAGE_UNAVAILABLE', message: '影像暫時無法上傳雲端，請稍後再試；本次未登記任何照片行。' })
    }
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, sha256: sha256Hex(body), bytesLength: body ? body.length : 0 })
  }
}

/* =========================================================================== */
/* 2. 加载被测件 ＋ 通道注入                                                   */
/* =========================================================================== */
const cloudbaseFn = await import(url('src/data/cloudbaseFn.js'))
const writeFace = await import(url('src/data/writeFaceMode.js'))
const session = await import(url('src/data/session.js'))
const db = await import(url('src/data/db.js'))
const userToken = await import(url('src/services/userToken.js'))
const photoService = await import(url(SERVICE_REL))

/* 云端形态（否则 `userWriteGate` 走 dev 放行分支 ⇒ 通道探针永远收不到 op）。 */
writeFace.setWriteFaceModeOverride('cloud')

/* —— 假云函数通道：按 `action` / `op` 分派；**一次都不打真实云函数** —— */
const transportLog = []
const serverState = {
  publicRows: [],
  adminRows: [],
  createOk: true,
  createRow: null,
  hiddenOk: true,
  deleteOk: true
}

cloudbaseFn.setCloudFunctionTransport(async (name, data) => {
  transportLog.push({ name, data })
  const action = data && data.action
  if (action === 'issue') {
    const now = Math.floor(Date.now() / 1000)
    return {
      result: {
        ok: true,
        /* 离线夹具令牌：**不打印、不落盘到仓**（只在本进程内存里走一遭）。 */
        token: `offline-harness-${createHash('sha256').update('verify-photo-cloud').digest('hex').slice(0, 32)}`,
        expiresAt: now + 900,
        issuedAt: now,
        serverNow: now,
        ttlSeconds: 900,
        ver: '1',
        sub: 'u-offline',
        uid: 'u-offline'
      }
    }
  }
  if (action === 'public' && data.op === 'listSealPhotos') {
    return { result: { ok: true, rows: serverState.publicRows, truncated: false } }
  }
  if (action === 'verify') {
    const op = data.op
    if (op === 'listSealPhotosAdmin') {
      return { result: { ok: true, rows: serverState.adminRows, truncated: false } }
    }
    if (op === 'createSealPhoto') {
      if (!serverState.createOk) {
        return { result: { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '服務端拒絕登記該照片行。' } }
      }
      /* 登记成功 ⇒ 服务端列表**真的多了这一行**（模拟真实云端状态，供「列表含新行」判据读）。 */
      const row = serverState.createRow
      serverState.publicRows = [...serverState.publicRows, row]
      serverState.adminRows = [...serverState.adminRows, row]
      return { result: { ok: true, row } }
    }
    if (op === 'setSealPhotoHidden') {
      if (!serverState.hiddenOk) return { result: { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '隱藏狀態更新失敗；本次零寫入。' } }
      const target = (data.payload || {}).photo_id
      const patch = { hidden: (data.payload || {}).hidden === true }
      serverState.publicRows = serverState.publicRows.map((row) => (row.id === target ? { ...row, ...patch } : row))
      serverState.adminRows = serverState.adminRows.map((row) => (row.id === target ? { ...row, ...patch } : row))
      const found = serverState.adminRows.find((row) => row.id === target) || { id: target }
      return { result: { ok: true, row: { ...found, ...patch } } }
    }
    if (op === 'deleteSealPhoto') {
      if (!serverState.deleteOk) return { result: { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '刪除失敗；本次零刪除。' } }
      const target = (data.payload || {}).photo_id
      serverState.publicRows = serverState.publicRows.filter((row) => row.id !== target)
      serverState.adminRows = serverState.adminRows.filter((row) => row.id !== target)
      return { result: { ok: true, deleted: true, object_retained: true } }
    }
  }
  return { result: { ok: false, reason: 'FORBIDDEN', message: 'harness: 未知 op（本假通道只认照片族）。' } }
})

/* 登录态：先取一枚**离线现签**用户令牌（`ensureUserTokenForWrite` 云端形态要求「有令牌」）。 */
const issued = await userToken.requestUserToken('13800000001', 'offline-harness-credential-not-a-real-token')
const ADMIN_USER = { id: 'u-offline', role: 'admin', phone: '13800000001' }
const NORMAL_USER = { id: 'u-offline', role: 'user', phone: '13800000001' }

/* =========================================================================== */
/* 夹具：云端行（含重复 id ＋ hidden 行） ＋ 本机遗留行（含同摘要行）            */
/* =========================================================================== */
const SHA_A = sha256Hex(Buffer.from('photo-A'))
const SHA_B = sha256Hex(Buffer.from('photo-B'))
const SHA_C = sha256Hex(Buffer.from('photo-C'))

serverState.publicRows = [
  { id: 'p-cloud-1', seal_id: SEAL, sha256: SHA_A, bytes: 100, mime: 'image/tiff', hidden: false, created_at: '2026-11-01T00:00:00.000Z' },
  /* 同 id 重复行（服务端异常形态）⇒ 合并单点必须去重，只留首见。 */
  { id: 'p-cloud-1', seal_id: SEAL, sha256: SHA_A, bytes: 100, mime: 'image/tiff', hidden: false, created_at: '2026-11-01T00:00:00.000Z' },
  { id: 'p-cloud-2', seal_id: SEAL, sha256: SHA_B, bytes: 120, mime: 'image/tiff', hidden: true, created_at: '2026-11-02T00:00:00.000Z' }
]
serverState.adminRows = serverState.publicRows.map((row) => ({ ...row }))

db.savePhotoRows([
  { id: 'ph-local-dup', stamp_id: SEAL, user_id: NORMAL_USER.id, sha256: SHA_A, bytes: 100, mime: 'image/tiff', width: 10, height: 10, created_at: '2026-10-01T00:00:00.000Z', storage: 'indexeddb' },
  { id: 'ph-local-only', stamp_id: SEAL, user_id: NORMAL_USER.id, sha256: SHA_C, bytes: 50, mime: 'image/tiff', width: 10, height: 10, created_at: '2026-10-02T00:00:00.000Z', storage: 'indexeddb' }
])

/* =========================================================================== */
/* A. 合并去重                                                                 */
/* =========================================================================== */
section('A', '合并去重：同 sha256 只留云端份 / 同 id 去重 / 云端在前、本机在后 / 本机行 local:true')

session.setUser(ADMIN_USER)
const adminMerged = await photoService.listSealPhotosMerged(SEAL, SEAL, { admin: photoService.canManageSealPhotos() })
const adminIds = adminMerged.rows.map((row) => row.id)

check(
  'A1',
  '管理员合并结果：云端 2 行（重复 id 已去重）＋ 本机仅剩**云端没有同摘要**的 1 行 ⇒ id 序列逐字',
  { ids: ['p-cloud-1', 'p-cloud-2', 'ph-local-only'], cloudCount: 2, localOnly: 1, ok: true },
  { ids: adminIds, cloudCount: adminMerged.cloudCount, localOnly: adminMerged.localOnly, ok: adminMerged.ok === true }
)

check(
  'A2',
  '**同 sha256 只留云端份**：本机 `ph-local-dup`（摘要＝云端 `p-cloud-1`）被合并单点吃掉，零残留',
  { localDupGone: true, dupStillPresent: false },
  {
    localDupGone: !adminIds.includes('ph-local-dup'),
    dupStillPresent: adminIds.includes('ph-local-dup')
  }
)

const cloudIdxs = adminMerged.rows.map((row, index) => (row.storage === 'cloud' ? index : -1)).filter((index) => index >= 0)
const localIdxs = adminMerged.rows.map((row, index) => (row.local === true ? index : -1)).filter((index) => index >= 0)
check(
  'A3',
  '顺序契约：**全部云端行在前、全部本机行在后**（云端行最大下标 < 本机行最小下标）',
  { cloudFirst: true, cloudCount: 2, localCount: 1 },
  {
    cloudFirst:
      cloudIdxs.length > 0 && localIdxs.length > 0 && Math.max(...cloudIdxs) < Math.min(...localIdxs),
    cloudCount: cloudIdxs.length,
    localCount: localIdxs.length
  }
)

check(
  'A4',
  "行标记面：云端行 `storage:'cloud'` ＋ `local:false`；本机行 `local:true` 且**不冒充**云端标记",
  { cloudRowsMarked: 2, localRowsMarked: 1, localRowNotCloud: true },
  {
    cloudRowsMarked: adminMerged.rows.filter((row) => row.storage === 'cloud' && row.local === false).length,
    localRowsMarked: adminMerged.rows.filter((row) => row.local === true).length,
    localRowNotCloud: adminMerged.rows.filter((row) => row.local === true).every((row) => row.storage !== 'cloud')
  }
)

check(
  'A5',
  '云端行 `id` 由服务端 `_id` / `id` 归一成字符串（合并视图行不裸露 `undefined`）',
  { allStringIds: true },
  { allStringIds: adminMerged.rows.every((row) => typeof row.id === 'string' && row.id !== '') }
)

/* =========================================================================== */
/* B. hidden 可见性                                                            */
/* =========================================================================== */
section('B', 'hidden 可见性：非管理员合并结果零 hidden 行 / 管理员含且带「已隱藏」徽标')

const canAdmin = photoService.canManageSealPhotos()
session.setUser(NORMAL_USER)
const canNormal = photoService.canManageSealPhotos()
session.setUser(null)
const canGuest = photoService.canManageSealPhotos()

check(
  'B1',
  '`canManageSealPhotos()` 随登录角色翻转：admin ⇒ true / 普通用户 ⇒ false / 未登录 ⇒ false（同一把尺子）',
  { admin: true, user: false, guest: false },
  { admin: canAdmin, user: canNormal, guest: canGuest }
)

session.setUser(NORMAL_USER)
const normalMerged = await photoService.listSealPhotosMerged(SEAL, SEAL, { admin: photoService.canManageSealPhotos() })
const normalIds = normalMerged.rows.map((row) => row.id)

check(
  'B2',
  '非管理员（`admin:false`）合并结果**不含 hidden 行**：`p-cloud-2` 零命中，其余行照常',
  { hiddenHits: 0, ids: ['p-cloud-1', 'ph-local-only'] },
  { hiddenHits: normalMerged.rows.filter((row) => row.hidden === true).length, ids: normalIds }
)

session.setUser(ADMIN_USER)
const adminMerged2 = await photoService.listSealPhotosMerged(SEAL, SEAL, { admin: photoService.canManageSealPhotos() })
const hiddenRow = adminMerged2.rows.find((row) => row.id === 'p-cloud-2') || null

check(
  'B3',
  '管理员（`admin:true`）合并结果**含 hidden 行**，且徽标字面取服务层单点 `PHOTO_HIDDEN_BADGE`（上屏繁体「已隱藏」）',
  { present: true, hidden: true, badge: '已隱藏', badgeFromServiceConstant: true },
  {
    present: hiddenRow !== null,
    hidden: hiddenRow !== null && hiddenRow.hidden === true,
    badge: hiddenRow ? hiddenRow.hidden_badge : null,
    badgeFromServiceConstant: hiddenRow !== null && hiddenRow.hidden_badge === photoService.PHOTO_HIDDEN_BADGE
  }
)

check(
  'B4',
  '徽标只给 `hidden:true` 的行（可见行零 `hidden_badge`，不给普通行挂锁标）',
  { visibleRowsWithBadge: 0 },
  { visibleRowsWithBadge: adminMerged2.rows.filter((row) => row.hidden !== true && row.hidden_badge !== undefined).length }
)

/* =========================================================================== */
/* C. 两步上传（停写 IDB）                                                      */
/* =========================================================================== */
section('C', '两步上传：① 字节入云 ／ ② 登记行；任一步失败 ⇒ IndexedDB 零写、零元数据行')

/* 造一份**最小但形态合法**的存储件字节（TIFF 魔数 `II*\0` ＋ 可辨体）。 */
function makeTiffBytes(seed, extra = 0) {
  const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])
  const body = Buffer.alloc(24 + extra, seed & 0xff)
  return new Uint8Array(Buffer.concat([head, body]))
}
const TIFF = makeTiffBytes(0x5a, 0)
const TIFF_DIGEST = sha256Hex(TIFF)

const rowsBefore = () => db.listPhotoRows().length
const putsDelta = (from) => idbLog.puts.length - from

/* —— C1：第 ① 步就失败 ⇒ 第 ② 步**根本不会发**、IDB 零写、零元数据行 —— */
session.setUser(NORMAL_USER)
fetchMode = 'reject'
let before = idbLog.puts.length
let rowsAt = rowsBefore()
let transportAt = transportLog.length
const storeFail = await photoService.uploadSealPhotoCloud({
  stampId: SEAL,
  sealId: SEAL,
  bytes: TIFF,
  mime: 'image/tiff',
  width: 4,
  height: 4
})
const createCallsAfterStoreFail = transportLog.slice(transportAt).filter((item) => item.data && item.data.op === 'createSealPhoto').length
check(
  'C1',
  '第 ① 步（`/image/store`）失败 ⇒ 结构化失败交回、**第 ② 步零调用**（不登记行）、IDB 零写、元数据行数不变',
  { ok: false, stored: false, createCalls: 0, idbPuts: 0, rowsDelta: 0, fetchHit: true },
  {
    ok: storeFail.ok,
    stored: storeFail.stored,
    createCalls: createCallsAfterStoreFail,
    idbPuts: putsDelta(before),
    rowsDelta: rowsBefore() - rowsAt,
    fetchHit: fetchLog.some((item) => /\/image\/store$/.test(item.url))
  }
)
check('C1b', '第 ① 步失败文案如实（含「未登記任何照片行」，不静默、不假装成功）', true, /未登記任何照片行/.test(storeFail.message))

/* —— C2：① 成 ② 败 ⇒ **IDB 零写 ＋ 零元数据行 ＋ 文案含「登記失敗」** —— */
fetchMode = 'ok'
serverState.createOk = false
before = idbLog.puts.length
rowsAt = rowsBefore()
const createFail = await photoService.uploadSealPhotoCloud({
  stampId: SEAL,
  sealId: SEAL,
  bytes: TIFF,
  mime: 'image/tiff',
  width: 4,
  height: 4
})
check(
  'C2',
  '① 成 ② 败 ⇒ `ok:false` ＋ `stored:true` ＋ 文案含「登記失敗」（且含「重試不會重複上傳」）；**IndexedDB 零写 ＋ 元数据行零新增**',
  { ok: false, stored: true, registerFailText: true, retryHint: true, idbPuts: 0, rowsDelta: 0 },
  {
    ok: createFail.ok,
    stored: createFail.stored,
    registerFailText: /登記失敗/.test(createFail.message),
    retryHint: /重試不會重複上傳/.test(createFail.message),
    idbPuts: putsDelta(before),
    rowsDelta: rowsBefore() - rowsAt
  }
)
check(
  'C2b',
  '该形态下服务端**确实收到了** `createSealPhoto`（第 ① 步的字节也真打到 `/image/store`）',
  { createCalls: 1, storeCallsAtLeast: 1 },
  {
    createCalls: transportLog.filter((item) => item.data && item.data.op === 'createSealPhoto').length,
    storeCallsAtLeast: Math.min(countOf(fetchLog.map((item) => item.url).join('\n'), /\/image\/store/g), 1)
  }
)

/* —— C3：两步全成 ⇒ IDB 零写 ＋ 列表含新行（云端份） —— */
serverState.createOk = true
const NEW_ROW = {
  id: 'ph-new-cloud',
  seal_id: SEAL,
  sha256: TIFF_DIGEST,
  bytes: TIFF.length,
  mime: 'image/tiff',
  width: 4,
  height: 4,
  hidden: false,
  created_at: '2026-11-27T00:00:00.000Z'
}
serverState.createRow = NEW_ROW
before = idbLog.puts.length
rowsAt = rowsBefore()
const bothOk = await photoService.uploadSealPhotoCloud({
  stampId: SEAL,
  sealId: SEAL,
  bytes: TIFF,
  mime: 'image/tiff',
  width: 4,
  height: 4,
  note: '離線自檢'
})
check(
  'C3',
  "两步全成 ⇒ `ok:true` ＋ 回包 `row.storage:'cloud'`；**IndexedDB 仍零写 ＋ 本机元数据行零新增**（行只在云端）",
  { ok: true, stored: true, rowStorage: 'cloud', idbPuts: 0, rowsDelta: 0 },
  {
    ok: bothOk.ok === true,
    stored: bothOk.stored === true,
    rowStorage: bothOk.row ? bothOk.row.storage : null,
    idbPuts: putsDelta(before),
    rowsDelta: rowsBefore() - rowsAt
  }
)

const afterUpload = await photoService.listSealPhotosMerged(SEAL, SEAL, { admin: true })
check(
  'C4',
  "两步全成 ⇒ **合并列表含新行**（`ph-new-cloud`，且按云端份口径标 `storage:'cloud'` / `local:false`）",
  { present: true, storage: 'cloud', local: false },
  {
    present: afterUpload.rows.some((row) => row.id === 'ph-new-cloud'),
    storage: (afterUpload.rows.find((row) => row.id === 'ph-new-cloud') || {}).storage ?? null,
    local: (afterUpload.rows.find((row) => row.id === 'ph-new-cloud') || {}).local ?? null
  }
)

check(
  'C5',
  '**全程 IDB 零写**：本段三次上传（失败 / 失败 / 成功）累计 `put` 次数恰 0（假库计数器是活的，见 F1 正对照）',
  { puts: 0 },
  { puts: idbLog.puts.length }
)

/* =========================================================================== */
/* D. 管理三钮按行收窄（模板静态断言）                                          */
/* =========================================================================== */
section('D', '管理三钮按行收窄：整块 canManagePhotos ＋ 三钩子全在 storage===cloud 条件块内')

/* —— SFC 分段去注释（照 `verify-photo-lightbox` 的口径：`<template>` 只剥 `<!-- -->`） —— */
function blank(chars, from, to) {
  for (let k = Math.max(0, from); k < Math.min(to, chars.length); k += 1) {
    if (chars[k] !== '\n') chars[k] = ' '
  }
}
function stripHtmlComments(text) {
  const chars = [...text]
  let i = 0
  while (i < chars.length) {
    if (chars[i] === '<' && chars[i + 1] === '!' && chars[i + 2] === '-' && chars[i + 3] === '-') {
      let j = i + 4
      while (j < chars.length && !(chars[j] === '-' && chars[j + 1] === '-' && chars[j + 2] === '>')) j += 1
      const end = Math.min(chars.length, j + 3)
      blank(chars, i, end)
      i = end
      continue
    }
    i += 1
  }
  return chars.join('')
}
/** JS 注释抹白（块注释 ＋ 行尾 `//`；引号 / 反引号内不视为注释起点）。 */
function stripJsComments(text) {
  const chars = [...text]
  const n = chars.length
  let i = 0
  while (i < n) {
    const ch = chars[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i += 1
      while (i < n) {
        if (chars[i] === '\\') {
          i += 2
          continue
        }
        if (chars[i] === quote) break
        i += 1
      }
      i += 1
      continue
    }
    if (ch === '/' && chars[i + 1] === '/') {
      let j = i
      while (j < n && chars[j] !== '\n') j += 1
      blank(chars, i, j)
      i = j
      continue
    }
    if (ch === '/' && chars[i + 1] === '*') {
      let j = i + 2
      while (j < n && !(chars[j] === '*' && chars[j + 1] === '/')) j += 1
      const end = Math.min(n, j + 2)
      blank(chars, i, end)
      i = end
      continue
    }
    i += 1
  }
  return chars.join('')
}
function sectionOf(raw, tag, stripper) {
  const open = raw.indexOf(`<${tag}`)
  if (open === -1) return ''
  const bodyStart = raw.indexOf('>', open)
  const close = raw.lastIndexOf(`</${tag}>`)
  if (bodyStart === -1 || close === -1 || close < bodyStart) return ''
  return stripper ? stripper(raw.slice(bodyStart + 1, close)) : raw.slice(bodyStart + 1, close)
}

const viewRaw = read(VIEW_REL)
const serviceRaw = stripJsComments(read(SERVICE_REL))
const HOOKS = ['data-photo-unhide', 'data-photo-hide', 'data-photo-delete']

/** 引号感知地取开标签（`>` 在引号内不得当标签结束）。 */
function openTagAt(text, start) {
  let i = start
  let quote = ''
  while (i < text.length) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
    } else if (ch === '>') {
      return text.slice(start, i + 1)
    }
    i += 1
  }
  return ''
}

/** 用模板里**真抽出来的门表达式**求值（求不出 ⇒ `null` ⇒ 判据必红，不静默放行）。 */
function evalGate(expr, scope) {
  if (typeof expr !== 'string' || expr.trim() === '') return null
  const keys = Object.keys(scope)
  try {
    return Boolean(new Function(...keys, `return (${expr});`)(...keys.map((key) => scope[key])))
  } catch {
    return null
  }
}

/**
 * 从（已去注释的）模板里抽出三钮的**逐层门**并给出读数。
 * @returns {{containerTag:string, containerGate:string|null, cloudTag:string|null,
 *   cloudGate:string|null, hooksInCloudBlock:number, hooksOutsideCloudBlock:number,
 *   renderHooks:(row:object, canManage:boolean)=>number|null}}
 */
function judgeNarrowing(templateText) {
  const hookAt = templateText.indexOf('data-photo-admin-actions')
  if (hookAt === -1) return null
  const divAt = templateText.lastIndexOf('<div', hookAt)
  if (divAt === -1) return null
  const containerTag = openTagAt(templateText, divAt)
  const innerEnd = templateText.indexOf('</div>', hookAt)
  const inner = innerEnd === -1 ? '' : templateText.slice(divAt + containerTag.length, innerEnd)

  const containerGate = ((/v-if="([^"]*)"/.exec(containerTag) || [])[1]) ?? null

  const cloudOpen = '<template v-if="photo.storage === \'cloud\'">'
  const cloudAt = inner.indexOf(cloudOpen)
  const cloudTag = cloudAt === -1 ? null : cloudOpen
  const cloudGate = cloudAt === -1 ? null : ((/v-if="([^"]*)"/.exec(cloudOpen) || [])[1]) ?? null
  const cloudCloseAt = cloudAt === -1 ? -1 : inner.indexOf('</template>', cloudAt)
  const cloudBlock = cloudAt === -1 || cloudCloseAt === -1 ? '' : inner.slice(cloudAt, cloudCloseAt)
  const outsideBlock =
    cloudAt === -1 || cloudCloseAt === -1
      ? inner
      : inner.slice(0, cloudAt) + inner.slice(cloudCloseAt + '</template>'.length)

  const hooksInCloudBlock = HOOKS.reduce((sum, hook) => sum + countOf(cloudBlock, new RegExp(`${hook}(?![-\\w])`, 'g')), 0)
  const hooksOutsideCloudBlock = HOOKS.reduce((sum, hook) => sum + countOf(outsideBlock, new RegExp(`${hook}(?![-\\w])`, 'g')), 0)

  const renderHooks = (row, canManage) => {
    const scope = { canManagePhotos: canManage, photo: row }
    const outer = evalGate(containerGate, scope)
    if (outer === null) return null
    /* 内层门缺席（＝变异形态：条件块被拆掉）⇒ 视为「无额外条件」——
       这时块外的钩子会直接被渲染出来 ⇒ `hooksOutsideCloudBlock` 与本读数一起转红。 */
    let inner = true
    if (cloudGate !== null) {
      inner = evalGate(cloudGate, scope)
      if (inner === null) return null
    }
    if (!outer || !inner) return hooksOutsideCloudBlock
    return hooksInCloudBlock + hooksOutsideCloudBlock
  }

  return { containerTag, containerGate, cloudTag, cloudGate, hooksInCloudBlock, hooksOutsideCloudBlock, renderHooks }
}

const viewTemplate = stripHtmlComments(sectionOf(viewRaw, 'template', null))
const narrowed = judgeNarrowing(viewTemplate)

check(
  'D1',
  '整块门在场：三钮容器开标签仍带 `v-if="canManagePhotos"`（非管理员 / 游客 ⇒ 整块不渲染，DOM 零命中）',
  { gateFound: true, gate: 'canManagePhotos' },
  { gateFound: narrowed !== null && narrowed.containerGate === 'canManagePhotos', gate: narrowed ? narrowed.containerGate : null }
)

check(
  'D2',
  '**按行收窄**：三颗钩子（unhide / hide / delete）全在 `<template v-if="photo.storage === \'cloud\'">` 条件块内（恰各 1 处）',
  { cloudGate: "photo.storage === 'cloud'", hooksInCloudBlock: 3 },
  { cloudGate: narrowed ? narrowed.cloudGate : null, hooksInCloudBlock: narrowed ? narrowed.hooksInCloudBlock : 0 }
)

check(
  'D3',
  '条件块**外**零钩子（本机遗留行 / 非云端行渲染不到任何管理钮 ⇒ 「给一个必然失败的按钮」这条路被堵死）',
  { hooksOutsideCloudBlock: 0 },
  { hooksOutsideCloudBlock: narrowed ? narrowed.hooksOutsideCloudBlock : -1 }
)

const cloudRow = { id: 'p-cloud-1', storage: 'cloud', local: false }
const localRow = { id: 'ph-local-only', storage: 'indexeddb', local: true }
check(
  'D4',
  '**行为读数**（用模板里真抽出来的门表达式求值）：云端行 3 钩子 / 本机行 0 钩子 / 非管理员 0 钩子',
  { cloud: 3, local: 0, nonAdmin: 0 },
  {
    cloud: narrowed ? narrowed.renderHooks(cloudRow, true) : null,
    local: narrowed ? narrowed.renderHooks(localRow, true) : null,
    nonAdmin: narrowed ? narrowed.renderHooks(cloudRow, false) : null
  }
)

check(
  'D5',
  '收窄不误伤本机行的**可见性**：本机行仍照常进合并列表（本单只砍管理钮，不砍行本身）',
  { localRowVisible: true },
  { localRowVisible: adminMerged2.rows.some((row) => row.id === 'ph-local-only') }
)

/* =========================================================================== */
/* E. 静态门（通道正确性 ＋ 面板读数落点）                                       */
/* =========================================================================== */
section('E', '静态门：hidden 徽标 / 本机遗留说明行 / userWriteGate 两 op 通道（零 adminWriteGate）')

check(
  'E1',
  'hidden 徽标落点在场：模板里 `data-photo-hidden-badge` 恰 1 处（管理员看得到「已隱藏」）',
  { badgeHooks: 1 },
  { badgeHooks: countOf(viewTemplate, /data-photo-hidden-badge(?![-\w])/g) }
)

const leftoverAt = viewTemplate.indexOf('data-photo-local-leftover')
const leftoverTag = leftoverAt === -1 ? '' : openTagAt(viewTemplate, viewTemplate.lastIndexOf('<p', leftoverAt))
check(
  'E2',
  '本机遗留说明行在场：`data-photo-local-leftover` 且由 `v-if="galleryLocalOnly > 0"` 守卫（N=0 ⇒ 整行不渲染）',
  { present: true, guarded: true },
  { present: leftoverTag !== '', guarded: /v-if="galleryLocalOnly > 0"/.test(leftoverTag) }
)

const hiddenCall = /userWriteGate\(\s*SEAL_PHOTO_HIDDEN_OP\b/.test(serviceRaw)
const deleteCall = /userWriteGate\(\s*SEAL_PHOTO_DELETE_OP\b/.test(serviceRaw)
const hiddenConst = /const SEAL_PHOTO_HIDDEN_OP = 'setSealPhotoHidden'/.test(serviceRaw)
const deleteConst = /const SEAL_PHOTO_DELETE_OP = 'deleteSealPhoto'/.test(serviceRaw)
const wrongChannel = /adminWriteGate/.test(serviceRaw)
const gateImported = /import \{ userWriteGate \} from '\.\/userWrite\.js'/.test(serviceRaw)

check(
  'E3',
  "管理两 op 走**正确通道**：`userWriteGate('setSealPhotoHidden' | 'deleteSealPhoto')` 调用在场（常量逐字）＋ 导入自 `./userWrite.js` ＋ **零 `adminWriteGate`**",
  { hiddenCall: true, deleteCall: true, hiddenConst: true, deleteConst: true, gateImported: true, wrongChannel: false },
  { hiddenCall, deleteCall, hiddenConst, deleteConst, gateImported, wrongChannel }
)

/* 运行时通道探针：**真调一次**，假通道必须逐字收到 op 与载荷（不是只看源码字面）。 */
session.setUser(ADMIN_USER)
const probeAt = transportLog.length
const hiddenOut = await photoService.setSealPhotoHidden('p-cloud-2', true)
const hiddenProbe = transportLog.slice(probeAt).find((item) => item.data && item.data.op === 'setSealPhotoHidden')
check(
  'E4',
  "通道探针①：`setSealPhotoHidden('p-cloud-2', true)` ⇒ 假通道收到 `action:'verify'` ＋ op 逐字 ＋ 载荷恰 `{photo_id, hidden}`",
  { action: 'verify', op: 'setSealPhotoHidden', payload: 'hidden:true,photo_id:p-cloud-2', ok: true },
  {
    action: hiddenProbe ? hiddenProbe.data.action : null,
    op: hiddenProbe ? hiddenProbe.data.op : null,
    payload: hiddenProbe ? Object.keys(hiddenProbe.data.payload || {}).sort().map((key) => `${key}:${hiddenProbe.data.payload[key]}`).join(',') : null,
    ok: hiddenOut.ok === true
  }
)

const probeAt2 = transportLog.length
const deleteOut = await photoService.deleteSealPhoto('p-cloud-1')
const deleteProbe = transportLog.slice(probeAt2).find((item) => item.data && item.data.op === 'deleteSealPhoto')
check(
  'E5',
  "通道探针②：`deleteSealPhoto('p-cloud-1')` ⇒ 假通道收到 `action:'verify'` ＋ op 逐字 ＋ 载荷恰 `{photo_id}` ＋ 成功文案含「影像檔案仍保留於雲端儲存」",
  { action: 'verify', op: 'deleteSealPhoto', payload: 'photo_id:p-cloud-1', ok: true, retainHint: true },
  {
    action: deleteProbe ? deleteProbe.data.action : null,
    op: deleteProbe ? deleteProbe.data.op : null,
    payload: deleteProbe ? Object.keys(deleteProbe.data.payload || {}).sort().map((key) => `${key}:${deleteProbe.data.payload[key]}`).join(',') : null,
    ok: deleteOut.ok === true,
    retainHint: /影像檔案仍保留於雲端儲存/.test(deleteOut.message)
  }
)

check(
  'E6',
  '零网络自证：`setCloudFunctionTransport` 注入在位（云函数全走假通道）且假 fetch 只见过 `…/image/store`（零外部 URL）',
  { injected: true, foreignUrls: [] },
  {
    injected: cloudbaseFn.cloudFunctionInjected() === true,
    foreignUrls: [...new Set(fetchLog.map((item) => item.url))].filter((item) => !/\/image\/store$/.test(item))
  }
)

/* =========================================================================== */
/* F. 变异负对照（只在内存副本上改，不写被测件）                                 */
/* =========================================================================== */
section('F', '变异负对照：尺子必须会响（① 写回 IDB ② 去掉 hidden 过滤 ③ 拆掉 cloud 条件块）')

/* F1：把「不写 IDB」改回写（在内存里真 put 一次）⇒ 同一条零写判据必须转红。
       这同时是**假库计数器的正对照**：证明计数器不是恒 0 的死读数。 */
const zeroIdbWrite = (delta) => delta === 0
const f1Baseline = idbLog.puts.length
await db.putPhotoBinary('ph-mutated-back-to-local', TIFF)
const f1Mutated = idbLog.puts.length - f1Baseline
check(
  'F1',
  '负对照①（**变异后 C 段判红**）：把「不写 IDB」改回写（登记前先 `putPhotoBinary` 落一份本机字节）⇒ 同一判据读数由 0 变 1 ⇒ 必红',
  { mutationApplied: true, wouldFailZeroIdbWrite: true, counterIsLive: true },
  {
    mutationApplied: f1Mutated === 1,
    wouldFailZeroIdbWrite: !zeroIdbWrite(f1Mutated),
    counterIsLive: f1Mutated !== f1Baseline
  }
)
/* 清掉变异留下的那一份，免得污染后续读数（内存假库，零副作用）。 */
idbKv.delete('ph-mutated-back-to-local')
idbLog.puts.pop()

/* F2：去掉 hidden 过滤 ⇒ 非管理员合并结果必含 hidden 行 ⇒ B2 判据必须转红。
       做法：从**真源文本**里抽出合并单点三函数，跑「原版」与「删掉过滤行的变异版」。 */
function extractFunction(source, name) {
  const at = source.indexOf(`function ${name}(`)
  if (at === -1) return null
  const open = source.indexOf('{', at)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at, i + 1)
    }
  }
  return null
}
const mergeSrc = ['cloudPhotoRowOf', 'localPhotoRowOf', 'mergeSealPhotoRows']
  .map((name) => extractFunction(serviceRaw, name))
  .filter(Boolean)
const buildMerge = (body) =>
  new Function('PHOTO_STORAGE_CLOUD', 'PHOTO_HIDDEN_BADGE', `${body.join('\n')}\nreturn mergeSealPhotoRows;`)('cloud', '已隱藏')

const mergeReal = mergeSrc.length === 3 ? buildMerge(mergeSrc) : null
const mutatedMergeSrc = mergeSrc.map((text) => text.replace(/\s*if \(!admin && row\.hidden === true\) continue/, ''))
const mergeMutated = mergeSrc.length === 3 ? buildMerge(mutatedMergeSrc) : null

/* 夹具**自带**（不读 `serverState`：E 段的隐藏 / 删除探针已经改过服务端状态），
   形态与 A / B 段同源：云端一可见 + 一 hidden，本机一同摘要 + 一独有摘要。 */
const cloudFixture = [
  { id: 'p-cloud-1', seal_id: SEAL, sha256: SHA_A, hidden: false },
  { id: 'p-cloud-2', seal_id: SEAL, sha256: SHA_B, hidden: true }
]
const localFixture = [
  { id: 'ph-local-dup', stamp_id: SEAL, sha256: SHA_A },
  { id: 'ph-local-only', stamp_id: SEAL, sha256: SHA_C }
]
const noHiddenIn = (rows) => rows.filter((row) => row.hidden === true).length === 0
const realNonAdmin = mergeReal ? mergeReal(cloudFixture, localFixture, false).rows : []
const mutatedNonAdmin = mergeMutated ? mergeMutated(cloudFixture, localFixture, false).rows : []

check(
  'F2',
  '负对照②（**变异后 B2 判红**）：从真源抽出的合并单点**删掉 `if (!admin && row.hidden === true) continue`** ⇒ 非管理员结果含 hidden 行 ⇒ 同一判据由绿转红',
  { mutationApplied: true, wouldFailB2: true, realGreen: true, extracted: 3 },
  {
    mutationApplied: mergeSrc.length === 3 && mutatedMergeSrc.join('') !== mergeSrc.join(''),
    wouldFailB2: !noHiddenIn(mutatedNonAdmin),
    realGreen: mergeReal !== null && noHiddenIn(realNonAdmin) && realNonAdmin.some((row) => row.id === 'p-cloud-1'),
    extracted: mergeSrc.length
  }
)

/* F3：拆掉 `storage==='cloud'` 条件块（内存变异模板）⇒ D 段判据必须转红。 */
const strippedOpen = "<template v-if=\"photo.storage === 'cloud'\">"
/* 内存变异：把条件块降级成**无条件** `<template>`（结构仍在、门没了）⇒ 三钩子直接挂在整块门下。 */
const withoutCloudGate = viewTemplate.replace(strippedOpen, '<template>')
const mutatedNarrowing = judgeNarrowing(withoutCloudGate)
check(
  'F3',
  "负对照③（**变异后 D2/D3/D4 判红**）：在内存里把 `storage==='cloud'` 门拆成无条件 `<template>` ⇒ 三钩子落到块外 ⇒ `hooksOutsideCloudBlock` 由 0 变 3、本机行钩子由 0 变 3",
  { mutationApplied: true, outside: 3, localHooks: 3 },
  {
    mutationApplied: mutatedNarrowing !== null && mutatedNarrowing.cloudGate === null,
    outside: mutatedNarrowing ? mutatedNarrowing.hooksOutsideCloudBlock : -1,
    localHooks: mutatedNarrowing ? mutatedNarrowing.renderHooks(localRow, true) : null
  }
)

/* =========================================================================== */
/* 收尾                                                                        */
/* =========================================================================== */
const total = results.length
const failedIds = results.filter((r) => !r.pass).map((r) => r.id)
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: failedIds,
    note:
      '离线自检：setCloudFunctionTransport 假通道 ＋ 假 fetch（摘要按实际收到字节现算）＋ 内存假 IndexedDB（put 逐次计数）＋ SFC 分段去注释模板扫描 ＋ 内存变异负对照；' +
      '零网络、零浏览器、零生产读写、不打印任何令牌。'
  })
)
process.exit(failures === 0 ? 0 : 1)
