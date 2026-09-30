# `xiai-user-token`（玺爱 · 用户令牌云函数｜写面 Phase A）

给**普通用户**发可验证登录令牌，并承担**一条**经云端校验的用户写路径（勘误提交）。
**与 `xiai-admin-token` 共用同一套令牌机制与失败形态**（同一份 `lib/token.js`，逐字节相同）。

## 环境变量（**唯一注入点**；仓内零字面值）

| 名称 | 必填 | 说明 |
|---|---|---|
| `XIAI_USER_SMS_CODE` | ✔ | 验证码（**W-43 已接受风险：固定值，暂缓**；本函数只把它做成注入点） |
| `XIAI_USER_TOKEN_SECRET` | ✔ | HMAC-SHA256 密钥（64 hex；**与管理员函数不是同一把** ⇒ 令牌不跨函数通用） |
| `XIAI_USER_TOKEN_VERSION` | ✗ | 撤销面版本号（默认 `1`；改值 ⇒ 全体旧令牌立刻失效） |
| `XIAI_USER_TOKEN_TTL_SECONDS` | ✗ | 令牌 TTL（默认 `900` ＝ 15 分钟，**与管理员令牌同值**） |
| `XIAI_USER_TOKEN_LEEWAY_SECONDS` | ✗ | 跨实例时钟余量（默认 `60`；**只作容差，不作放宽**） |

**手机号没有白名单**（普通用户写面本来就是"任何已登录用户"）；**没有手机号/密钥字面值**。
envId 在运行期从 `TCB_ENV` / `SCF_NAMESPACE` / `CLOUDBASE_ENV_ID` 读（**不写死**，与 liwu 既有函数同一读法）。

## 调用契约

```
① 签发（服务端验证登录）
   {action:'issue', phone, code}
   → {ok:true, token, sub:masked, subFingerprint, uid, issuedAt, expiresAt, ttlSeconds, ver, serverNow}
   → {ok:false, reason:'FORBIDDEN',          message:'手機號或驗證碼不正確；本次零寫入。'}
   → {ok:false, reason:'STORAGE_UNAVAILABLE', message:'…未配置…'}   （环境变量缺位）

② 校验 ＋ 权威落盘 ＋ 滑动续期
   {action:'verify', token, op, payload}
   → {ok:true, op, row, docId, authority:'SERVER', identity:{uid, phone:masked, phoneFingerprint},
      serverNow, renewedToken, renewedExpiresAt, renewedTtlSeconds, ver}
   → {ok:false, reason, message}   （恰 3 键；reason ∈ 既有冻结表）

   已登记 op：`submitCorrection` → 集合 `xiai_corrections`（`PRIVATE` ⇒ 只能由本函数以管理端凭据写）
```

**令牌形态**：`<base64url(payload)>.<base64url(hmac-sha256(payload))>`，payload `{v,sub,role,iat,exp,jti,ver}`。
**创建者身份**：`uid = u-<手机号>` 由服务端**确定性派生**（与前端 `auth.js` 的 `u-${phone}` 同一约定）；
手机号来自**已验签的令牌声明**；载荷里出现 `userId`/`user_id`/`phone`/`role`… ⇒ `INVALID_FIELD` ＋ 零写入。

## 失败形态（**新增 `reason` 字面值 ＝ 0**）

| 场景 | `reason` | 说明 |
|---|---|---|
| 无令牌 / 格式错 / **签名错** | `FORBIDDEN` | **三者同一条文案**（防探测） |
| 令牌过期 / 版本不符 / 手机号不合法 / `role≠user` | `FORBIDDEN` | 各自的繁体可读文案 |
| 签发时手机号或验证码不符 | `FORBIDDEN` | **不区分「号」与「码」**（防枚举） |
| 未知 `op` / 载荷含未知或身份类字段 | `INVALID_FIELD` | 如實報回，不静默丢键 |
| 缺 `faceId` / 缺 `value` | `MISSING_REQUIRED` | |
| 文字超上限 | `INVALID_VALUE` | |
| 环境变量缺位 / 存储不可用 / 内部异常 | `STORAGE_UNAVAILABLE` | **不得伪装 `FORBIDDEN`** |

## 部署

```bash
# 在含 cloudbaserc.json 的目录内（functionRoot 按 cwd 前缀拼接 ⇒ 用相对路径）
cloudbase functions:deploy xiai-user-token --force
```

`cloudbaserc.json` 的该函数条目须含：`runtime: Nodejs18.15`、`installDependency: true`
（**本函数有依赖** `@cloudbase/node-sdk`，与 P1 的零依赖声明不同 ⇒ 已在报告登记）、
以及上表 5 个 `envVariables`（**该文件含密钥 ⇒ 不入仓、不进交付目录**）。

## 边界（本单未做，如实登记）

- **读面未迁移**：`xiai_corrections` 的读仍走本机 localStorage（云端行只在写入后由服务端回传做本地镜像）。
- **服务端未复判封闭值域**（朝代 14 / 印面内容 9 / 印面风格 23）：为免造第二套枚举，值域门仍在服务层；
  服务端只判**结构 / 身份 / 必填 / 键面**。
- 撤销面 / refresh / 频控未做（与 P1 登记一致）。
