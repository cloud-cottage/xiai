# `xiai-admin-token` — 管理员令牌云函数（写面 Phase 1）

## 它做什么 / 不做什么

| | 内容 |
|---|---|
| **做** | ① `action:'issue'` 签发短期令牌（**手机号白名单 + 验证码**双重判定，**HMAC-SHA256** 签名，**TTL 15 分钟**）；② `action:'verify'` 校验令牌（验签 → 有效期 → 手机号白名单 → `op` 值域 / 字段门）并**滑动续期**（成功回吐新令牌） |
| **做（Phase 2）** | `op:'reviewCorrection'`（勘误审核）：**服务端验签后权威落盘两处** —— ① 私有集合 `xiai_corrections` 的审核状态（`status` / `reviewed_at` / `reviewer_id`，驳回另加 `review_note`）；② 新公开只读集合 `xiai_corrections_public` 的**脱敏投影行**（**零身份字段**，供全站只读展示「勘误采纳后的展示值」）。**判定全部在写之前**（拒绝 ⇒ 零写入） |
| **不做** | `setInviteReward`（Phase 1）**仍不做持久化写入**（落盘在客户端 `ok:true` 之后）；`reviewCorrection` **不覆盖**印章 / 印面原始数据、**不发奖**（发奖仍在客户端服务层）；不碰 `liwu` 任何集合 / 函数（集合名一律 `^xiai_`） |

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

審覈  { action:'verify', token:'<令牌>', op:'reviewCorrection',
        payload:{ correction_id:'<勘误单号>', decision:'ACCEPTED'|'REJECTED', note:'<可选驳回理由 ≤200 字>' } }
  → { ok:true, op, authority:'SERVER', row, projection, wrote, identity, sub, serverNow, renewedToken, … }
  → { ok:false, reason, message }            // 无令牌 / 验签失败 / 过期 / 手机号不符 / 未知 op /
                                             //   未知单号 / 已审终态（不可重复）/ 决定值域不符 /
                                             //   采纳值超出冻结值域 / 存储不可用
```

`reviewCorrection` 的落点（**服务端权威**）：
- 私有 `xiai_corrections`（ACL `PRIVATE`，**只能**由函数以管理端凭据写）：`status` ∈ `{ACCEPTED, REJECTED}`、
  `reviewed_at`、`reviewer_id`（＝**服务端**从令牌声明派生的 `u-<手机号>`）；**仅驳回且非空理由**才写 `review_note`。
- 公开 `xiai_corrections_public`（**新建、只读**）：**脱敏投影行**，键面封闭为
  `{correction_id, faceId, sealId, stamp_id, field, field_label, value, status, reviewed_at, updated_at, schema}`，
  **零身份字段**（无 `userId` / `user_id` / `user_phone` / `reviewer_id` / `identity_source` / `basis` / `created_at`）；
  行 id ＝ 确定性 `cp-<勘误单号>` ⇒ 同单重放恒**覆盖同一行**（幂等 upsert）。

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

Phase 1 无需依赖；**Phase 2 写面**经 `lib/ops.js` **延迟 require** `@cloudbase/node-sdk`
（管理端凭据取自函数运行环境；`require` 只在**真实落库**时发生 ⇒ 离线自检注入假 DB 时无需安装）⇒
部署前需在本目录 `npm install` 并把 `node_modules` 一并上传。

## 与写面的关系（Phase 1 边界）

- 客户端 `src/services/adminToken.js` 取票 / 缓存 / 携带 / 滑动续期；`src/services/admin.js::setInviteReward`
  在**本函数返回 `ok:true` 之后**才落盘 —— **服务端验签是唯一判据**（R-WF1），前端永不下发写权限判据。
- **Phase 2 已落地的写面 `reviewCorrection`**：勘误审核由**本函数**权威落盘（私有状态 ＋ 公开投影），
  客户端只做镜像；`reviewer_id` 由**已验签令牌声明**派生（`u-<手机号>`），**不采信前端自称**。
- **Phase 2（仍未覆盖）**：`xiai_config` 权威落位、审计行、refresh 令牌、`jti` 黑名单、频控。
