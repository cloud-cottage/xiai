# `xiai-user-token`（玺爱 · 用户令牌云函数｜写面 Phase A）

给**普通用户**发可验证登录令牌，并承担**一条**经云端校验的用户写路径（勘误提交）。
**与 `xiai-admin-token` 共用同一套令牌机制与失败形态**（同一份 `lib/token.js`，逐字节相同）。

## 环境变量（**唯一注入点**；仓内零字面值）

| 名称 | 必填 | 说明 |
|---|---|---|
| `XIAI_USER_SMS_CODE` | ✗ | **已下线**（P1a/R-L1，2026-11-15）：固定演示码**不再参与登录授权判定**、**不在必填集**；变量名保留（其它代码可能引用 / 排障），本函数只读「是否仍配置」的布尔读数 |
| `XIAI_USER_TOKEN_SECRET` | ✔ | HMAC-SHA256 密钥（64 hex；**与管理员函数不是同一把** ⇒ 令牌不跨函数通用） |
| `XIAI_USER_TOKEN_VERSION` | ✗ | 撤销面版本号（默认 `1`；改值 ⇒ 全体旧令牌立刻失效） |
| `XIAI_USER_TOKEN_TTL_SECONDS` | ✗ | 令牌 TTL（默认 `900` ＝ 15 分钟，**与管理员令牌同值**） |
| `XIAI_USER_TOKEN_LEEWAY_SECONDS` | ✗ | 跨实例时钟余量（默认 `60`；**只作容差，不作放宽**） |

**手机号没有白名单**（普通用户写面本来就是"任何已登录用户"）；**没有手机号/密钥字面值**。
envId 在运行期从 `TCB_ENV` / `SCF_NAMESPACE` / `CLOUDBASE_ENV_ID` 读（**不写死**，与 liwu 既有函数同一读法）。

## 调用契约

```
① 签发（服务端验证登录｜**P1a/R-L1，2026-11-15**）
   {action:'issue', phone, platformAccessToken}
   判定链：① 手机号形态 → ② 平台会话验签取号
           （`POST https://<envId>.ap-shanghai.tcb-api.tencentcloudapi.com/auth/v1/user/me?client_id=<envId>`
            ＋ 请求头 `Authorization: Bearer …`）→ ③ 双向一致（严格相等）→ ④ `uidOf(phone)` 签令牌
   → {ok:true, token, sub:masked, subFingerprint, uid, issuedAt, expiresAt, ttlSeconds, ver, serverNow}
   → {ok:false, reason:'FORBIDDEN',          message:'手機號或驗證碼不正確；本次零寫入。'}
      （凭证不成立 / 回体无手机号 / 号不一致 / 缺参 —— **同一文案，不区分「号不对」与「凭证不对」**）
   → {ok:false, reason:'STORAGE_UNAVAILABLE', message:'…'}   （缺密钥 / envId 缺 / 网络 / 超时 / 平台回未知错误码）
   ⚠ 旧入参 `{phone, code}`（固定演示码）**已下线** ⇒ 恒 `FORBIDDEN`（旧客户端必须与后端同批上线，R-L4）

② 校验 ＋ 权威落盘 ＋ 滑动续期
   {action:'verify', token, op, payload}
   → {ok:true, op, row, docId, authority:'SERVER', identity:{uid, phone:masked, phoneFingerprint},
      serverNow, renewedToken, renewedExpiresAt, renewedTtlSeconds, ver}
   → {ok:false, reason, message}   （恰 3 键；reason ∈ 既有冻结表）

   已登记 op：`submitCorrection` → 集合 `xiai_corrections`（`PRIVATE` ⇒ 只能由本函数以管理端凭据写）

③ 只读会话验签（**跨仓契约**：斐萃影子库服务端代验浏览器登录态；**零落盘 · 不签发 · 不续期**）
   {action:'verifySession', token}
   → {ok:true, uid:'u-<16 hex>', role:'user'|'admin'}          （恰 3 键）
   → {ok:false, reason: TOKEN_INVALID | TOKEN_EXPIRED, message}  （缺 token / 非字符串 / 空串 ⇒ TOKEN_INVALID）
   → {ok:false, reason: STORAGE_UNAVAILABLE, message}          （缺密钥等基础设施故障 ⇒ **不伪装令牌无效**）
   说明：不需要 `op` / `payload`（在 authority / op 值域判定**之前**短路）；
         `uid` 只由**已验签**的 `sub` 经 `uidOf` 派生，回包**零手机号、零令牌片段**；
         同一令牌连续调用返回同一 `uid`（幂等无副作用）。
```

**令牌形态**：`<base64url(payload)>.<base64url(hmac-sha256(payload))>`，payload `{v,sub,role,iat,exp,jti,ver}`。
**创建者身份**：`uid = u-<手机号>` 由服务端**确定性派生**（与前端 `auth.js` 的 `u-${phone}` 同一约定）；
手机号来自**已验签的令牌声明**；载荷里出现 `userId`/`user_id`/`phone`/`role`… ⇒ `INVALID_FIELD` ＋ 零写入。

## 失败形态（**新增 `reason` 字面值 ＝ 0**）

| 场景 | `reason` | 说明 |
|---|---|---|
| 无令牌 / 格式错 / **签名错** | `FORBIDDEN` | **三者同一条文案**（防探测） |
| 令牌过期 / 版本不符 / 手机号不合法 / `role≠user` | `FORBIDDEN` | 各自的繁体可读文案 |
| 签发时手机号不符 / 平台凭证不成立 / 号不一致 / 缺参 | `FORBIDDEN` | **不区分「号不对」与「凭证不对」**（防枚举） |
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
以及上表 `envVariables`（`XIAI_USER_SMS_CODE` **已非必填**，可安全下线；其余按表）。

## 斐萃（feicui）令牌 —— 管理员签发面（本单改造）

斐萃（本地電腦版）要调 yinyuan2026 的读面，而 `YINYUAN_API_KEY` **只许待在 xiai 侧**。
斐萃改持一枚**璽愛签发的 HMAC 令牌**，打本站转发路由 `GET /api/feicui/v1/<path>`。

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `FEICUI_TOKEN_SECRET` | ✔ | 令牌签名密钥（HMAC-SHA256；**缺失 ⇒ 签不出、验不过**，fail-closed） |
| `FEICUI_TOKEN_KID` | ✗ | 当前密钥号（缺省 `k1`）；轮换时改值 |
| `FEICUI_TOKEN_PREVIOUS_SECRET` / `FEICUI_TOKEN_PREVIOUS_KID` | ✗ | 平滑轮换期：旧 kid 仍可验，新签只用当前 kid |

**op**：`issueFeicuiToken`（登记在 `ADMIN_OPS`，**仅管理员**；会话路看 `xiai_roles.role==='admin'`，
令牌路看 `XIAI_ADMIN_PHONE` 白名单；两路都 fail-closed）。

```
{action:'verify', op:'issueFeicuiToken', payload:{target, role?, ttl_seconds?}}
  target      = 11 位手机号（服务端按 `uidOf` 派生 `u-`＋sha256 前 16 位）或既有 uid
  role        = user | admin（缺省 user）
  ttl_seconds = 300 … 7776000（缺省 2592000 ＝ 30 天；越界 ⇒ INVALID_VALUE，不夹取）
→ {ok:true, row:{token, uid, role, kid, jti, iat, exp, expires_at, ttl_seconds}}   （**零落盘**，无 plan）
→ {ok:false, reason, message}   （FORBIDDEN / INVALID_FIELD / INVALID_VALUE / MISSING_REQUIRED / STORAGE_UNAVAILABLE）
```

**令牌形态**：`v1.<base64url(payload)>.<base64url(HMAC-SHA256)>`，payload 恰 7 键
`{v, uid, role, jti, iat, exp, kid}`；服务端**验签即确权、不存任何令牌状态**。
**禁用 / 轮换**：见 `config/README.md`（`jti` 进吊销名单＝单枚失效；换密钥＝全体失效）。

## 边界（本单未做，如实登记）

- **读面未迁移**：`xiai_corrections` 的读仍走本机 localStorage（云端行只在写入后由服务端回传做本地镜像）。
- **服务端未复判封闭值域**（朝代 14 / 印面内容 9 / 印面风格 23）：为免造第二套枚举，值域门仍在服务层；
  服务端只判**结构 / 身份 / 必填 / 键面**。
- 撤销面 / refresh / 频控未做（与 P1 登记一致）。
