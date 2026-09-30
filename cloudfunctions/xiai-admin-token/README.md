# `xiai-admin-token` — 管理员令牌云函数（写面 Phase 1）

## 它做什么 / 不做什么

| | 内容 |
|---|---|
| **做** | ① `action:'issue'` 签发短期令牌（**手机号白名单 + 验证码**双重判定，**HMAC-SHA256** 签名，**TTL 15 分钟**）；② `action:'verify'` 校验令牌（验签 → 有效期 → 手机号白名单 → `op` 值域 / 字段门）并**滑动续期**（成功回吐新令牌） |
| **不做** | **不做任何持久化写入**（Phase 1 授权面与持久化面分离 ⇒ **负向调用天然零写入**）；不引入任何外部依赖（只用 Node 内置 `crypto`）；不碰 `liwu` 任何集合 / 函数（只在本函数内工作） |

## 环境变量（**唯一真源；本目录代码里没有任何密钥 / 手机号 / 验证码字面值**）

| 名称 | 必填 | 说明 |
|---|---|---|
| `XIAI_ADMIN_PHONE` | ✓ | 管理员手机号白名单。**工程真源仍是 `src/data/seed.js:39` 的 `ADMIN_PHONE`**，此处是同一真源的**注入点**（非第二处定义点） |
| `XIAI_ADMIN_SMS_CODE` | ✓ | 管理端验证码（环境注入；**不得**写进代码或构建产物 —— `W-43` 未裁，本函数不代裁认人方式） |
| `XIAI_ADMIN_TOKEN_SECRET` | ✓ | HMAC 密钥，**随机生成**；只存函数环境变量，**不入仓 / 不入构建产物 / 不进日志** |
| `XIAI_ADMIN_TOKEN_VERSION` | ✗ | 密钥版本（撤销面）：递增 ⇒ **全体旧令牌即刻失效**。缺省 `1` |
| `XIAI_ADMIN_TOKEN_TTL_SECONDS` | ✗ | 令牌 TTL 秒数，缺省 `900`（15 分钟） |
| `XIAI_ADMIN_TOKEN_LEEWAY_SECONDS` | ✗ | 跨实例时钟余量，缺省 `60`（**只作容差，不作放宽**） |

**配置缺失 ⇒ 一律结构化拒绝**（`reason = STORAGE_UNAVAILABLE`，语义 ＝ 内部不可用）；
**绝不用 `FORBIDDEN` 冒充内部故障**（R-WF2）。

## 调用契约

```
签发  { action:'issue',  phone:'<11 位>', code:'<验证码>' }
  → { ok:true, token, sub(masked), subFingerprint, issuedAt, expiresAt, ttlSeconds, ver, serverNow }
  → { ok:false, reason, message }            // 手机号或验证码不符 ⇒ FORBIDDEN（不区分两者，防枚举）

校验  { action:'verify', token:'<令牌>', op:'setInviteReward', payload:{ value:<非负整数> } }
  → { ok:true, op, value, sub, serverNow, renewedToken, renewedExpiresAt, renewedTtlSeconds, ver }
  → { ok:false, reason, message }            // 无令牌 / 验签失败 / 过期 / 手机号不符 / 未知 op / 值域不符
```

**失败形状恒为恰 3 键 `{ok:false, reason, message}`**（沿用工程纪律，不加旁路诊断字段）；
内部判别码（`TOKEN_EXPIRED` 一类）**只进函数日志**（`console.log` 单行 JSON，不含令牌 / 密钥 / 手机号原文）。

## 部署（CLI 登录态，不需密钥）

```bash
# ① 生成密钥（**不落仓**；只把它写进函数环境变量）
SECRET=$(openssl rand -hex 32)

# ② 在仓外临时目录放一份 cloudbaserc.json（含 envId / 函数名 / 环境变量）
#    形如：
#    { "envId": "<envId>", "functionRoot": "<本目录的绝对路径>",
#      "functions": [{ "name": "xiai-admin-token", "timeout": 10, "memorySize": 256,
#        "envVariables": { "XIAI_ADMIN_PHONE": "...", "XIAI_ADMIN_SMS_CODE": "...",
#                          "XIAI_ADMIN_TOKEN_SECRET": "$SECRET" } }] }

# ③ 部署（在该临时目录里执行，cloudbaserc.json 与 cwd 同层）
cloudbase functions:deploy xiai-admin-token -e <envId>
```

本函数**零依赖** ⇒ 无需 `npm install`、无需上传 `node_modules`。

## 与写面的关系（Phase 1 边界）

- 客户端 `src/services/adminToken.js` 取票 / 缓存 / 携带 / 滑动续期；`src/services/admin.js::setInviteReward`
  在**本函数返回 `ok:true` 之后**才落盘 —— **服务端验签是唯一判据**（R-WF1），前端永不下发写权限判据。
- **Phase 2（未覆盖）**：真库写入（`xiai_config` 权威落位）、审计行、refresh 令牌、`jti` 黑名单、频控。
