/**
 * mock 种子数据（spec §8.1 占位策略）。
 *
 * 硬约束：
 * - 命名一律占位：「（演示）XX 博物馆」「张示例」「@yinsuo.example」（§8.1）
 * - 玺印 / 影像为占位（ImageAsset.isPlaceholder = true），字段结构按 §3.8 / §3.9
 * - 图片地址为 `about:placeholder#…`，全站 0 个外链图片、0 个外部请求
 * - 伪随机一律由**固定种子**驱动（§8.1），同一会话多次渲染结果一致
 * - 数据只存内存 / sessionStorage，不落 localStorage（§8.1）
 */
import { TIMEZONE } from '@/config/env.js'
import { PLAN_IDS } from '@/config/pricing.js'
import {
  ASSET_KIND, COLOR_MODE, ENV, ORG_TYPE, REGISTER_SOURCE, REVIEW_STATUS,
  RIGHTS_STATUS, SEAL_STYLE, SEAL_TYPE, API_KEY_STATUS, USER_STATUS,
} from '@/data/contract.js'
import { toCstDate, toCstMonth } from '@/data/time.js'

/** 固定伪随机种子（§8.1：同会话多次渲染一致）。 */
export const SEED = 20260918

/** 演示账号（自助注册通路 A，R2）。 */
export const DEMO_USER = Object.freeze({
  userId: 'u_demo00000001',
  orgName: '（演示）XX 博物馆',
  orgType: ORG_TYPE.MUSEUM,
  contactName: '张示例',
  phone: '13800000000',
  email: 'demo@yinyuan.example',
  /** 前端 mock 不存明文口令（§3.2）：占位散列。 */
  passwordHash: '$mock$argon2id$v=19$m=65536,t=3,p=1$ZGVtby1tb2NrLXNhbHQ$ZGVtby1tb2NrLWhhc2g',
  status: USER_STATUS.ACTIVE,
  planId: PLAN_IDS.STANDARD,
  registerSource: REGISTER_SOURCE.SELF_SERVICE,
})

/** 演示账号登录口令（§11 待决 6 默认邮箱 + 密码；仅演示填充用）。 */
export const DEMO_PASSWORD = 'yinyuan2026'

/**
 * mock 示意账户初始充值余额（**非商品价格**，仅为让流水可复算 Σ流水 = 余额，§5.4）。
 * 价格一律来自 src/config/pricing.js，本文件不得出现任何价格字面量。
 */
export const SEED_INITIAL_RECHARGE_CENTS = 3000000

/** 演示年度授权有效期（R5）。 */
export const SEED_ANNUAL_FEE_PAID_UNTIL = '2027-09-18'

/** mulberry32：固定种子 PRNG。 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(rnd, list) {
  return list[Math.floor(rnd() * list.length)]
}

function intBetween(rnd, min, max) {
  return min + Math.floor(rnd() * (max - min + 1))
}

/** 生成密钥 ID：`key_` + 12 位 Base32（字符集 A-Z2-7，§6.1）。 */
export function randomKid(rnd) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let body = ''
  for (let i = 0; i < 12; i += 1) body += alphabet[Math.floor(rnd() * alphabet.length)]
  return `key_${body}`
}

/** 生成密钥明文：`ys_test_` / `ys_live_` + 32 位 Base62 = 40 字符（§6.1，密码学随机源）。 */
export function generatePlaintextKey(env) {
  const prefix = env === ENV.LIVE ? 'ys_live_' : 'ys_test_'
  const body = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(32)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < 32; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  let out = ''
  for (let i = 0; i < 32; i += 1) out += body[bytes[i] % body.length]
  return prefix + out
}

/** 掩码形态：前缀 + 24 个 • + 主体末 4 位（§6.1）。 */
export function maskKey(plaintext) {
  const prefix = plaintext.slice(0, 8)
  const tail = plaintext.slice(-4)
  return `${prefix}${'•'.repeat(24)}${tail}`
}

/** 种子密钥（3 个，覆盖 test/live 与禁用态，§3.3）。 */
export function seedApiKeys() {
  const rnd = mulberry32(SEED + 7)
  const defs = [
    { label: '展陈联调', env: ENV.TEST, scopes: ['seal:search', 'image:preview'], status: API_KEY_STATUS.ACTIVE, createdAt: '2026-08-20T02:30:00Z' },
    { label: '线上检索服务', env: ENV.LIVE, scopes: ['seal:search', 'image:preview', 'image:original', 'usage:read'], status: API_KEY_STATUS.ACTIVE, createdAt: '2026-08-28T06:10:00Z' },
    { label: '旧版对接（停用）', env: ENV.TEST, scopes: ['seal:search'], status: API_KEY_STATUS.DISABLED, createdAt: '2026-08-05T01:05:00Z' },
  ]
  return defs.map((def) => {
    const plaintext = generatePlaintextKey(def.env)
    return {
      kid: randomKid(rnd),
      label: def.label,
      maskedKey: maskKey(plaintext),
      env: def.env,
      scopes: [...def.scopes],
      status: def.status,
      ipAllowlist: [],
      createdAt: def.createdAt,
      rotatedAt: undefined,
      lastUsedAt: undefined,
      /** mock 内部保留一份「已颁发明文」用于验证掩码一致性；**不对外返回**（§6.2）。 */
      _issuedPlaintext: plaintext,
    }
  })
}

/** 接口池（按路由模板归组，§7.4）。 */
const ENDPOINT_POOL = [
  { endpoint: '/v1/seals:search', method: 'POST', billable: true, preview: false },
  { endpoint: '/v1/seals/{id}', method: 'GET', billable: true, preview: false },
  { endpoint: '/v1/seals/{id}/images', method: 'GET', billable: false, preview: true },
  { endpoint: '/v1/assets/{assetId}/preview', method: 'GET', billable: false, preview: true },
  { endpoint: '/v1/assets/{assetId}/original', method: 'GET', billable: false, preview: false, original: true },
  { endpoint: '/v1/usage/summary', method: 'GET', billable: false, preview: false },
]

const FAIL_CODES = [400, 401, 403, 404, 429, 500]

/**
 * 生成演示用量记录（固定种子；近 330 个自然日 ≈ 覆盖「近 12 个 CST 自然月」整轴）。
 *
 * 天数口径（AC-88 ⑥ / 概览页 04-3「近 12 月」视图）：概览页月粒度轴 = 当期 CST 自然月 + 前 11 个月
 * ＝ 12 桶；此前种子只有 36 天，月视图仅 2 桶有记录（看起来像空图）。现把历史拉长到
 * **覆盖整条近 12 月轴**：取 330 日（< 最短的 11 个连续自然月 334 日），
 * 既保证 12 桶**桶桶有记录**，又保证最老记录不早于轴首月（A12「近 12 月」窗口的校验点）。
 * 只加长历史区间，**不改任何计量口径与单位**（计费口径仍严格按 §7.1；
 * 当月 KPI / 当月流水回放只取当期自然月，不受本参数影响）。
 *
 * 计费口径严格按 §7.1：仅已鉴权且 2xx 的业务请求 +1；预览图只计流量；
 * 高清原图默认不计调用（countOriginalAsCall=false），只计 originalImageCount。
 */
export function seedUsageRecords({ userId, kids, planId, now = new Date(), days = 330 }) {
  const rnd = mulberry32(SEED + 31)
  const records = []
  let seq = 1
  for (let d = days - 1; d >= 0; d -= 1) {
    const dayDate = new Date(now.getTime() - d * 86400000)
    const perDay = intBetween(rnd, 8, 26)
    for (let i = 0; i < perDay; i += 1) {
      const ep = pick(rnd, ENDPOINT_POOL)
      const kid = pick(rnd, kids)
      const at = new Date(dayDate.getTime())
      at.setUTCHours(intBetween(rnd, 0, 23), intBetween(rnd, 0, 59), intBetween(rnd, 0, 59), 0)
      if (at.getTime() > now.getTime()) continue
      const failed = rnd() < 0.045
      const statusCode = failed ? pick(rnd, FAIL_CODES) : 200
      const ok = statusCode === 200
      const imageCount = ok && ep.preview ? intBetween(rnd, 1, 4) : 0
      const originalImageCount = ok && ep.original ? 1 : 0
      const iso = at.toISOString()
      records.push({
        recordId: `ur_${String(seq).padStart(5, '0')}`,
        userId,
        kid: kid.kid,
        endpoint: ep.endpoint,
        method: ep.method,
        statusCode,
        isBillable: ok && ep.billable,
        callCount: ok && ep.billable ? 1 : 0,
        requestedAt: iso,
        cstDate: toCstDate(iso),
        cstMonth: toCstMonth(iso),
        latencyMs: intBetween(rnd, 38, 420),
        imageCount,
        imageBytes: imageCount * intBetween(rnd, 9000, 26000),
        originalImageCount,
        isPreviewOnly: ep.preview,
        traceId: `tr_${(Math.floor(rnd() * 0xffffffff) >>> 0).toString(16).padStart(8, '0')}`,
        planIdAtTime: planId,
        env: kid.env,
      })
      seq += 1
    }
  }
  return records
}

/**
 * 展示通道（切片）历史流量种子（spec §7.2 / §7.7-R17c）。
 *
 * 为什么需要：展示切片流量若**只由当日运行时**产生，则「今日 / 近 7 日 / 近 30 日」三个窗口
 * 会返回同一个数字（窗口平移一天即归零），不像真实系统的累计账。这里按**固定种子**回溯
 * 若干自然日补上历史流量，使各窗口数值不同且均为正——**只计图片流量、不计调用次数**
 * （不产生 UsageRecord 明细行，口径不变）。
 *
 * 约束：① 固定种子（§8.1，同一会话多次渲染一致）；② 时间戳按 UTC 回溯、**不晚于当前时刻**；
 * ③ 两片字节均计入（每组 imageCount = 2），与 A27 的切片张数口径一致。
 */
export function seedDisplayTraffic({ days = 330, now = new Date(), assetIds = [] } = {}) {
  const rnd = mulberry32(SEED + 53)
  const out = []
  for (let d = days - 1; d >= 0; d -= 1) {
    const dayDate = new Date(now.getTime() - d * 86400000)
    const groupsPerDay = intBetween(rnd, 1, 4)
    for (let i = 0; i < groupsPerDay; i += 1) {
      const at = new Date(dayDate.getTime())
      at.setUTCHours(intBetween(rnd, 0, 23), intBetween(rnd, 0, 59), intBetween(rnd, 0, 59), 0)
      if (at.getTime() > now.getTime()) continue
      const iso = at.toISOString()
      const assetId = assetIds.length
        ? assetIds[intBetween(rnd, 0, assetIds.length - 1)]
        : `ia_${String(intBetween(rnd, 1, 9999999999)).padStart(10, '0')}`
      // 每片字节取自与影像同量级的区间（§3.9 bytes 示意值），两片合计为一次展示通道流量。
      const sliceBytes = intBetween(rnd, 9000, 26000)
      out.push({
        at: iso,
        cstDate: toCstDate(iso),
        cstMonth: toCstMonth(iso),
        endpoint: '/v1/assets/{assetId}/display',
        assetId,
        imageBytes: sliceBytes * 2,
        imageCount: 2,
      })
    }
  }
  return out
}

const SEAL_DEFS = [
  { name: '（演示）XX之印', text: 'XX之印', dynasty: '汉', material: '铜', type: SEAL_TYPE.NAME_SEAL, style: SEAL_STYLE.BAI_WEN },
  { name: '（演示）长乐', text: '长乐', dynasty: '汉', material: '铜', type: SEAL_TYPE.AUSPICIOUS, style: SEAL_STYLE.ZHU_WEN },
  { name: '（演示）山水知己', text: '山水', dynasty: '清', material: '石', type: SEAL_TYPE.LEISURE, style: SEAL_STYLE.ZHU_WEN },
  { name: '（演示）XX郡守', text: '郡守', dynasty: '秦', material: '铜', type: SEAL_TYPE.OFFICIAL, style: SEAL_STYLE.BAI_WEN },
  { name: '（演示）鉴藏', text: '鉴藏', dynasty: '宋', material: '玉', type: SEAL_TYPE.COLLECTION, style: SEAL_STYLE.ZHU_WEN },
  { name: '（演示）宜子孙', text: '宜孙', dynasty: '汉', material: '铜', type: SEAL_TYPE.AUSPICIOUS, style: SEAL_STYLE.BAI_WEN },
]

/** 生成演示玺印 + 影像（§3.8 / §3.9，全部占位）。 */
export function seedSeals() {
  const rnd = mulberry32(SEED + 97)
  const seals = []
  for (let i = 0; i < 18; i += 1) {
    const def = SEAL_DEFS[i % SEAL_DEFS.length]
    const sealId = `s_${String(i + 1).padStart(16, '0')}`
    const assetCount = intBetween(rnd, 2, 4)
    const assets = []
    for (let a = 0; a < assetCount; a += 1) {
      const kind = a === 0 ? ASSET_KIND.FACE : a === 1 ? ASSET_KIND.EDGE : ASSET_KIND.IMPRESSION
      const seq = kind === ASSET_KIND.FACE ? 0 : a - 1
      assets.push({
        assetId: `ia_${String(i * 4 + a + 1).padStart(10, '0')}`,
        sealId,
        kind,
        seq,
        previewWebpUrl: `about:placeholder#${kind}-${seq}`,
        previewPngUrl: `about:placeholder#${kind}-${seq}-png`,
        originalTiffKey: `archive/demo/p${String(i + 13).padStart(3, '0')}_${a}.tif`,
        originalHighResUrl: `/v1/assets/ia_${String(i * 4 + a + 1).padStart(10, '0')}/original`,
        bytes: intBetween(rnd, 9000, 26000),
        width: 378,
        height: 378,
        ppi: 400,
        colorMode: def.style === SEAL_STYLE.ZHU_WEN ? COLOR_MODE.PALETTE : COLOR_MODE.BINARY,
        sha256: `${(Math.floor(rnd() * 0xffffffff) >>> 0).toString(16).padStart(8, '0')}${(Math.floor(rnd() * 0xffffffff) >>> 0).toString(16).padStart(8, '0')}`,
        isPlaceholder: true,
        createdAt: '2026-09-18T02:00:00Z',
      })
    }
    seals.push({
      sealId,
      sealCode: `DEMO-p${String(i + 13).padStart(4, '0')}-00`,
      sealName: def.name,
      transcription: def.text,
      transcriptionVariant: [],
      dynasty: def.dynasty,
      material: def.material,
      sealType: def.type,
      sealStyle: def.style,
      sizeMm: { width: 20, height: 20 },
      sourceBook: '（演示）古玺汇编 文物出版社',
      sourcePageNo: i + 13,
      bbox: { x1: 204, y1: 269, x2: 327, y2: 391 },
      assetCount,
      rightsStatus: RIGHTS_STATUS.UNKNOWN,
      reviewStatus: REVIEW_STATUS.MACHINE_EXTRACTED,
      createdAt: '2026-09-18T02:00:00Z',
      updatedAt: '2026-09-18T02:00:00Z',
      assets,
      /** §8.1：复用 feicui 结构作字段示例，但条目本身按占位处理。 */
      isPlaceholder: true,
    })
  }
  return seals
}

/** FAQ（§11 待决 17：本地内容文件，默认 12 条；分类见 §1.5 F2）。 */
export const FAQ_CATEGORIES = Object.freeze([
  { key: 'account', label: '账号与开通' },
  { key: 'key', label: '密钥' },
  { key: 'usage', label: '用量与计费' },
  { key: 'image', label: '图像与技术' },
  { key: 'org', label: '机构合作' },
])

export const FAQ_SEED = Object.freeze([
  { id: 'faq-01', category: 'account', q: '注册后多久可以开始调用？', a: '演示环境中注册即自动开通，无需等待审核；控制台可立即自助生成 API 密钥。' },
  { id: 'faq-02', category: 'account', q: '注册开关关闭时如何开通？', a: '走「申请演示环境」人工审核通路，审核通过后由平台签发演示密钥。' },
  { id: 'faq-03', category: 'account', q: '本轮演示环境会保存我的数据吗？', a: '不会。演示环境的写入只存在于内存或会话存储中，刷新即重置，不落库。' },
  { id: 'faq-04', category: 'key', q: '密钥明文可以再次查看吗？', a: '不可以。明文仅在创建或重生当次展示一次，关闭后任何入口都无法取回。' },
  { id: 'faq-05', category: 'key', q: '密钥重生会更换 kid 吗？', a: '不会。重生后 kid 不变，仅更新最近重生时间，旧明文立即失效。' },
  { id: 'faq-06', category: 'key', q: '一个账号最多可以建几个密钥？', a: '默认上限 5 个，达到上限后需先删除或停用旧密钥。' },
  { id: 'faq-07', category: 'usage', q: '什么算一次计费调用？', a: '已鉴权且返回 2xx 的业务请求各计 1 次；批量接口单请求返回多条仍只计 1 次。' },
  { id: 'faq-08', category: 'usage', q: '浏览预览图会计费吗？', a: '不计调用费，只累计图片流量。仅取预览图不会消耗包量。' },
  { id: 'faq-09', category: 'usage', q: '高清原图如何计价？', a: '按张单独计价，各档同价，不占用月包量，直接从充值余额扣减。' },
  { id: 'faq-10', category: 'usage', q: '月包量可以结转到下个月吗？', a: '不可以。包量按月重置，未使用部分到期作废，不跨月结转。' },
  { id: 'faq-11', category: 'image', q: '归档母版 TIFF G4 可以下载吗？', a: '不可以。TIFF G4 仅用于平台底层归档，不提供对外下载通路。' },
  { id: 'faq-12', category: 'org', q: '机构合作的一般流程是什么？', a: '申请演示环境 → 环境开通 → 密钥签发 → 联调对接 → 计量计费。' },
])

/** 机构资料页可下载清单（§11 待决 15：默认 6 项，全部占位）。 */
export const DOWNLOAD_SEED = Object.freeze([
  { id: 'dl-01', name: '平台白皮书', format: 'PDF', available: false },
  { id: 'dl-02', name: '图像规格说明', format: 'PDF', available: false },
  { id: 'dl-03', name: '著录规范说明', format: 'PDF', available: false },
  { id: 'dl-04', name: '对接流程说明', format: 'PDF', available: false },
  { id: 'dl-05', name: '样例数据包', format: 'ZIP', available: false },
  { id: 'dl-06', name: '报价单', format: 'PDF', available: false },
])

export { PLAN_IDS, TIMEZONE }
