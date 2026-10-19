#!/usr/bin/env node
/**
 * 玺爱 · **占位图登记行写入**（`xiai_images` 一条；影像例外｜仅 feicui/sealbank 来源）
 * ============================================================================
 * 做什么：把仓内随包资产 `public/placeholders/seal-no-image.jpg` 登记为**一条**影像行
 * （`_id = img-placeholder-seal-no-image`、`storage_key = placeholder/seal-no-image`、
 * `storage = bundled`），使 sealbank 导入行的 `faces[].image_storage_key` 能**解析得到**
 * （采纳门 `buildSealAcceptanceFromImport` 只查 `xiai_images`，不碰二进制）。
 *
 * 为什么必须显式登记：采纳门的语义是「**宣告了引用就必须解析得到**」——占位图也不例外。
 * 登记行**不含二进制**（`storage='bundled'` ⇒ 字节来自随包资产，前端 `loadImageDataUrl`
 * 的占位分支负责取回）；云端桶里**没有**、也**不需要**这个对象。
 *
 * 幂等：`doc(id).set()` ⇒ 重复执行只覆盖同一行（不产生第二条、不改 `_id`）。
 *
 * 凭据（**本脚本绝不写死、绝不读取仓内 `.env` 之外的密钥**）：
 *   · 需要 CloudBase 管理端凭据：`TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY`
 *     （或在云函数 / 已登录 `tcb` 的机器上跑），外加 `TCB_ENV`（或 `CLOUDBASE_ENV_ID`）。
 *   · **缺凭据 ⇒ 只做 dry-run 并如实退出（码 3）**，绝不假装写入成功、绝不写任何生产数据。
 *
 * 用法：
 *   node scripts/register-seal-placeholder-image.mjs            # dry-run（默认；只打印计划）
 *   node scripts/register-seal-placeholder-image.mjs --write    # 真写（需凭据；幂等 set）
 *   node scripts/register-seal-placeholder-image.mjs --json     # 机读输出
 */

import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const COLLECTION = 'xiai_images'

const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
const JSON_OUT = argv.includes('--json')

/* 常量真源：`src/data/seed.js`（ESM；纯数据、无副作用）。 */
const seed = await import(pathToFileURL(path.join(ROOT, 'src/data/seed.js')).href)
const { SEAL_PLACEHOLDER_IMAGE } = seed

const assetPath = path.join(ROOT, 'public', SEAL_PLACEHOLDER_IMAGE.asset_url.replace(/^\//, ''))
const report = { asset: assetPath, key: SEAL_PLACEHOLDER_IMAGE.key, write: WRITE, ok: false, reason: '', plan: null }

function finish(code) {
  process.exit(code)
}

if (!existsSync(assetPath)) {
  report.reason = `占位图资产不存在：${assetPath}`
  console.error(report.reason)
  finish(2)
}

const bytes = readFileSync(assetPath)
const sha256 = createHash('sha256').update(bytes).digest('hex')
report.asset_bytes = bytes.length
report.asset_sha256 = sha256

/* **登记值与资产字节必须逐字一致**（任一不符 ⇒ 拒绝登记；改图必须同时改常量）。 */
if (sha256 !== SEAL_PLACEHOLDER_IMAGE.sha256 || bytes.length !== SEAL_PLACEHOLDER_IMAGE.bytes) {
  report.reason =
    `登记值与资产不一致：sha256 ${sha256} / bytes ${bytes.length} ≠ 登记 ` +
    `${SEAL_PLACEHOLDER_IMAGE.sha256} / ${SEAL_PLACEHOLDER_IMAGE.bytes}`
  console.error(report.reason)
  finish(2)
}

const now = new Date().toISOString()
const doc = {
  _id: SEAL_PLACEHOLDER_IMAGE.id,
  id: SEAL_PLACEHOLDER_IMAGE.id,
  /* **不是** FACE / EDGE：本行**不对应任何真实印面**，只是占位图登记（无 `stamp_id` ⇒ 不进任何画廊）。 */
  kind: 'PLACEHOLDER',
  storage: SEAL_PLACEHOLDER_IMAGE.storage, // 'bundled'（**刻意不是** 'server'）
  storage_key: SEAL_PLACEHOLDER_IMAGE.key,
  sha256,
  bytes: bytes.length,
  mime: SEAL_PLACEHOLDER_IMAGE.mime,
  width: SEAL_PLACEHOLDER_IMAGE.width,
  height: SEAL_PLACEHOLDER_IMAGE.height,
  /* 来源归属（**唯一**允许引用本键的家族；判定在导入行 `source` 上，本字段只作登记说明）。 */
  source_scope: SEAL_PLACEHOLDER_IMAGE.source_scope,
  note: '公共占位图（無影像資訊）：米白宣紙底＋朱紅印章邊框＋豎排「待補充」；僅 sealbank/feicui 來源可引用',
  updated_at: now
}
report.plan = { collection: COLLECTION, op: 'doc(id).set', doc }

const envId = String(process.env.TCB_ENV || process.env.CLOUDBASE_ENV_ID || '').trim()
const hasSecret = !!(process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY)

if (!WRITE) {
  report.ok = true
  report.reason = 'dry-run（未写入；加 --write 且具备凭据才落库）'
  console.log(JSON.stringify(report, null, 1))
  finish(0)
}

if (!envId || !hasSecret) {
  report.ok = false
  report.reason =
    `凭据缺口：envId=${envId ? '已配置' : '缺（TCB_ENV / CLOUDBASE_ENV_ID）'}，` +
    `密钥=${hasSecret ? '已配置' : '缺（TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY）'} ⇒ 未执行任何写入`
  console.error(report.reason)
  console.error('计划已就绪；具备凭据后重跑：node scripts/register-seal-placeholder-image.mjs --write')
  finish(3)
}

let tcb
try {
  tcb = require('@cloudbase/node-sdk')
} catch (error) {
  report.reason = `@cloudbase/node-sdk 不可用：${(error && error.message) || error} ⇒ 未执行任何写入`
  console.error(report.reason)
  finish(3)
}

const app = tcb.init({ env: envId })
const db = app.database()
try {
  const res = await db.collection(COLLECTION).doc(doc._id).set(doc)
  /* **写后回读**（外部写入必须回读核验；不拿「调用成功」当「落盘成功」）。 */
  const readBack = await db.collection(COLLECTION).where({ storage_key: SEAL_PLACEHOLDER_IMAGE.key }).get()
  const rows = (readBack && readBack.data) || []
  report.write_result = { updated: (res && res.updated) || 0, read_back_rows: rows.length }
  report.ok = rows.length === 1 && String(rows[0].sha256) === sha256
  report.reason = report.ok
    ? '已写入并回读核验（1 行，摘要一致）'
    : `回读核验不符：命中 ${rows.length} 行`
  console.log(JSON.stringify(report, null, 1))
  finish(report.ok ? 0 : 4)
} catch (error) {
  report.ok = false
  report.reason = `写入失败：${(error && error.message) || error}`
  console.error(report.reason)
  finish(5)
}
