/**
 * 玺爱 · 函数层探针 `GET /api/health`
 *
 * 用途一：判别「Vercel 是否在编译本项目的 `api/` 目录」——纯文件名探针。
 *   · `/api/health` 200 ⇒ `api/` 已部署
 *   · `/api/health` 404 ⇒ `api/` 没部署（项目配置问题）
 *   （历史：`api/ai/v1/[...path].js` 这种方括号 catch-all 在非 Next 函数里不生效，
 *     曾被本探针一眼判死；正式路由已改为显式文件名。）
 *
 * 用途二：`?diag=1` **环境自检**。硬口径：
 *   只回**布尔**、**来源名**与**抹掉长串后的短错误信息**，**绝不回任何密钥值、环境 id 原文、
 *   令牌、密文**。它回答的是「中转端点为什么 503 CONFIG_MISSING」这类问题，
 *   不必去翻运行日志猜。
 */
const ENV_ID_NAMES = ['TCB_ENV', 'SCF_NAMESPACE', 'CLOUDBASE_ENV_ID']

/* 密钥环境变量两族（**成对不混用**；与 `api/_lib/aiRelay.js::secretPairOf` 同一优先序）：
   ① `CLOUDBASE_SECRET_ID` / `CLOUDBASE_SECRET_KEY`（生产已按此名填入）
   ② `TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY`（回退，供本地 / CI）。 */
const SECRET_FAMILIES = Object.freeze([
  Object.freeze({ id: 'CLOUDBASE_SECRET_ID', key: 'CLOUDBASE_SECRET_KEY' }),
  Object.freeze({ id: 'TENCENTCLOUD_SECRETID', key: 'TENCENTCLOUD_SECRETKEY' })
])

function present(source, name) {
  const value = source ? source[name] : ''
  return typeof value === 'string' && value.trim().length > 0
}

function envIdSource(source) {
  for (const name of ENV_ID_NAMES) {
    if (present(source, name)) return name
  }
  return ''
}

/** 某一半（`id` / `key`）的**来源名**（值域封闭：族名或空串；**不回值**）。 */
function secretSourceOf(source, half) {
  for (const family of SECRET_FAMILIES) {
    if (present(source, family[half])) return family[half]
  }
  return ''
}

/** 成对解析（**成对不混用**：甲族 id ＋ 乙族 key 不得拼成一对；无对 ⇒ 空对、不抛）。 */
function secretPair(source) {
  for (const family of SECRET_FAMILIES) {
    if (present(source, family.id) && present(source, family.key)) {
      return { source: family.id, id: source[family.id], key: source[family.key] }
    }
  }
  return { source: '', id: '', key: '' }
}

/** 错误信息只保留「形状」：抹掉疑似长串（≥40 位 base64 块）并截断。 */
function shapeOf(error) {
  const raw = error && error.message ? String(error.message) : ''
  const cleaned = raw.replace(/[A-Za-z0-9+/=]{40,}/g, '<redacted>').slice(0, 160)
  return { name: (error && error.name) || 'Error', message: cleaned }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  const url = req && req.url ? String(req.url) : ''
  const wantsDiag = /[?&]diag=1/.test(url)
  const base = {
    ok: true,
    probe: 'xiai-api-health',
    method: req && req.method ? req.method : '',
    ts: Date.now()
  }
  if (!wantsDiag) {
    res.status(200).send(JSON.stringify(base))
    return
  }

  const source = typeof process !== 'undefined' ? process.env : {}
  const secretIdSourceName = secretSourceOf(source, 'id')
  const secretKeySourceName = secretSourceOf(source, 'key')
  const pair = secretPair(source)
  const diag = {
    envIdSource: envIdSource(source),
    /* 来源名（值域封闭：族名或空串；**不回值**）；两个布尔保留（便于人眼）；
       `secretPairConsistent` ＝ 两族名成对命中（同族不混用）。 */
    secretIdSource: secretIdSourceName,
    secretKeySource: secretKeySourceName,
    secretIdPresent: secretIdSourceName !== '',
    secretKeyPresent: secretKeySourceName !== '',
    secretPairConsistent: pair.source !== '',
    upstreamSecretPresent: present(source, 'XIAI_AI_UPSTREAM_SECRET'),
    nodeVersion: typeof process !== 'undefined' && process.version ? process.version : '',
    sdk: null,
    store: null,
    balanceRead: null
  }

  let app = null
  try {
    const tcbModule = await import('@cloudbase/node-sdk')
    const tcb = tcbModule.default || tcbModule
    const init = { env: source[envIdSource(source) || ''] || '' }
    if (pair.id && pair.key) {
      init.secretId = pair.id
      init.secretKey = pair.key
    }
    app = tcb.init(init)
    diag.sdk = { step: 'init', ok: true }
  } catch (error) {
    diag.sdk = Object.assign({ step: 'init', ok: false }, shapeOf(error))
    res.status(200).send(JSON.stringify(Object.assign(base, { diag })))
    return
  }

  try {
    const reply = await app.database().collection('xiai_balances').count()
    diag.balanceRead = { ok: true, total: (reply && reply.total) || 0 }
  } catch (error) {
    diag.balanceRead = Object.assign({ ok: false }, shapeOf(error))
  }

  try {
    const opsModule = await import('../../cloudfunctions/xiai-user-token/lib/ops.js')
    const mod = opsModule.default || opsModule
    if (typeof mod.resolveAiStore === 'function') {
      const store = mod.resolveAiStore(source)
      diag.store = { ok: true, keys: Object.keys(store || {}) }
    } else {
      diag.store = { ok: false, name: 'NoResolver', message: 'resolveAiStore 未导出' }
    }
  } catch (error) {
    diag.store = Object.assign({ ok: false }, shapeOf(error))
  }

  res.status(200).send(JSON.stringify(Object.assign(base, { diag })))
}
