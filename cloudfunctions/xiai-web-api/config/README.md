# `config/` — 部署期静态口径件

## `feicui-token-revoked.json` — 斐萃令牌**吊销名单**

斐萃令牌是 **HMAC 自包含令牌**（`v1.<payload>.<sig>`），服务端**不存任何令牌状态**。
「禁用某一枚令牌」只有一条路：把它的 `jti` 写进本文件 ⇒ **重新部署**（路由在进程内只读一次）。

```json
{
  "revoked": [
    { "jti": "jt-0123456789abcdef01234567", "reason": "lost-device", "at": "2026-10-17T00:00:00.000Z" }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `jti` | ✔ | 令牌号（签发回包里的 `jti`；形态 `[A-Za-z0-9_-]{8,64}`，不合的行被忽略） |
| `reason` | ✗ | 自由文字（**只入运维记录**，不上屏、不进回包） |
| `at` | ✗ | 吊销时间（ISO 8601 UTC，仅记录用；判定只看 `jti`） |

判定口径（`cloudfunctions/xiai-user-token/lib/feicuiToken.js::verify`）：命中 `jti` ⇒ `REVOKED` ⇒
路由对外回 `401 TOKEN_INVALID`（**不向客户端区分「已吊销」与「签名错」**）。

### 三种处置（按影响面从小到大）

| 目标 | 动作 | 生效条件 |
|---|---|---|
| **禁用一枚令牌**（某台机器 / 某个 jti） | 把 `jti` 追加进 `revoked` 数组 | 重新部署（`vercel --prod`）后，该令牌立刻 401 |
| **一个用户全部失效** | 无按 uid 的批吊销面 ⇒ 逐枚收集该用户回包里的 `jti` 追加；或直接轮换密钥（影响全体） | 同上 |
| **全体失效 / 定期轮换** | 换 `FEICUI_TOKEN_SECRET`（并改 `FEICUI_TOKEN_KID`） | 重新部署后，**旧令牌全部 401**；最长存活 ≤ 令牌 `exp`（默认 30 天，上限 90 天） |

### 平滑轮换（不打断已发出的令牌）

1. 部署前把**当前**密钥与 kid 放进 `FEICUI_TOKEN_PREVIOUS_SECRET` / `FEICUI_TOKEN_PREVIOUS_KID`；
2. 把 `FEICUI_TOKEN_SECRET` / `FEICUI_TOKEN_KID` 换成新值 ⇒ 新签只用新 kid，旧 kid 仍可验证；
3. 等旧令牌自然到期（≤ 30 天）后，**删掉** `FEICUI_TOKEN_PREVIOUS_*` 再部署一次 ⇒ 旧 kid 彻底退场。

### 注意（如实登记）

- 文件缺失 / JSON 解析失败 ⇒ 路由**按空名单继续**，并在服务端日志与响应头
  `X-Feicui-Revocation: unavailable` 标注 —— **不假装名单已生效**。
- 名单是**静态文件**：改完必须重新部署，没有运行期热更（刻意如此：不引入写面 / 不碰 CloudBase）。
- 本目录**不放任何密钥**：密钥只在 Vercel / 云函数的环境变量里。
