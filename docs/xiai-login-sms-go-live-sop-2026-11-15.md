# 上线操作说明书：真实短信验证码登录（xiai）

- 适用提交：`af939cf`（`feat(auth): 登录改真实短信验证码 + 密码双路 + 忘记密码重置 + 令牌持久化`）
- 目标环境：`liwu-cny1313-d1gb2fukyb7cb19bb`（云开发），前端 Vercel 项目 `xiai`
- 判定口径：以下每条都是「一个操作 ≈ 100 字说明」，照做即可；命令一律在 `/Users/kevin/bistro/xiai` 下执行

> 两条硬规矩（违反会出事）：**① 不要用 `tcb fn deploy` 或 `tcb fn config update`** —— 它们会把含密钥的配置写到本地磁盘，并可能用 `cloudbaserc.json` 里的空环境变量覆盖线上变量。**② 不要用 `tcb fn detail`** —— 它会原文回显环境变量（含密钥）。代码只走 `tcb fn code update`，环境变量只走控制台。

---

## 第 0 步｜核对 `xiai-user-token` 的环境变量（约 100 字）

打开云开发控制台 → 云函数 → `xiai-user-token` → 函数配置 → 环境变量。必须有两项非空：`XIAI_USER_TOKEN_SECRET`（已确认在位）、**`XIAI_ADMIN_PHONE`**（管理员手机号，与 `src/data/seed.js::ADMIN_PHONE` 同值）。可选：`XIAI_USER_TOKEN_VERSION`（默认 1）、`XIAI_USER_TOKEN_LEEWAY_SECONDS`（默认 60）。

**缺 `XIAI_ADMIN_PHONE` 会怎样**：管理面整片不可用 —— 采纳、驳回、邀请奖励一律 `FORBIDDEN`（这是安全默认，不会放行）。普通用户登录与勘误提交仍正常，所以只测登录发现不了这个问题。

**关于 `xiai-admin-token`（管理员令牌函数）**：**本轮不需要给它配任何环境变量**。实测前端对它零调用点，管理面白名单真源在 `xiai-user-token` 上；它缺变量时回 `STORAGE_UNAVAILABLE`（fail-closed，由于无人调用，无实际影响）。将来若要启用管理员专用通道，再给它配 `XIAI_ADMIN_TOKEN_SECRET` + `XIAI_ADMIN_PHONE`。

---

## 第 1 步｜配 30 天令牌有效期（约 100 字）

在 `xiai-user-token` 的环境变量页面加一项：`XIAI_USER_TOKEN_TTL_SECONDS=2592000`（2592000 秒 = 30 天）。可选再加 `XIAI_AUTH_REGION=ap-shanghai`（不填默认就是它，本环境无需设置）。`xiai-admin-token` 的 `XIAI_ADMIN_TOKEN_TTL_SECONDS` **只在将来启用该函数时才需要**，本轮可跳过。

**注意这个页面是整表替换**：编辑时把原有键（含 `XIAI_USER_TOKEN_SECRET`、`XIAI_ADMIN_PHONE`）一起保留提交，漏掉的键等于删除 —— 那条函数会立刻报「服务未配置」，全员登录失败。

---

## 第 2 步｜部署后端两个函数（约 100 字）

终端执行两条（顺序无关，各自约 20 秒）：

```bash
cd /Users/kevin/bistro/xiai
tcb fn code update xiai-user-token  -e liwu-cny1313-d1gb2fukyb7cb19bb
tcb fn code update xiai-admin-token -e liwu-cny1313-d1gb2fukyb7cb19bb
```

`code update` 只上传代码、不碰环境变量（这正是 W-68 裁定的合规通道之一）。跑完用 `tcb fn list -e liwu-cny1313-d1gb2fukyb7cb19bb` 看「更新时间」是否变成刚才。

**`xiai-admin-token` 那条别怕报错**：它没有环境变量，部署后任何调用都回 `STORAGE_UNAVAILABLE` —— 这是预期的 fail-closed，不是部署失败；因为前端对它零调用点，不影响任何功能。部署它的意义在于把旧代码里「认固定码 `729341`」的活口焊死。

**做错会怎样**：改用 `tcb fn deploy` ⇒ 环境变量可能被 `cloudbaserc.json` 里的空值覆盖，`xiai-user-token` 的密钥全丢，全站登录立刻失效。

---

## 第 3 步｜部署前端（自动，约 100 字）

本项目的前端由 **Vercel × GitHub 集成自动部署**：只要代码推到 `cloud-cottage/xiai` 的 `main`，Vercel 项目 `xiai` 就会自动构建上线（本次推送后约 1 分钟生效，已在生产验证：产物含 `platformAccessToken`/`getVerification`，`729341` 零命中）。

**不要用本机的 `vercel --prod`**：本机 CLI 登录的账号是 `coldrinx-7076`，看不到 `xiai` 这个 team 项目，会报 "Could not retrieve Project Settings"。手工部署请用 Kevin 本人的 Vercel 账号，或直接在 Vercel 控制台点 Redeploy。

**为什么不能只上一边**：新后端只认 `{phone, platformAccessToken}`，旧前端还发 `{phone, code}` ⇒ 登录全断；反之亦然。所以「推 GitHub」与「第 2 步」必须在同一窗口内完成，这几十秒内登不上是正常现象。

---

## 第 4 步｜验证后端真的换了血（约 100 字）

在浏览器打开站点登录页，故意用**旧的固定演示码** `729341` 登录任意手机号。预期：**必须失败**（提示「手機號或驗證碼不正確」）。

判据原理：老函数认这个固定码，会直接签发令牌并登录成功；新函数只认平台短信会话，所以必然拒绝。这条是「后端确实换成新版」最直接、最不依赖日志的证据。

**做得对**：失败 = 已换血。**若仍能登录** ⇒ 第 2 步没真正生效，回查 `fn list` 更新时间，别继续往下走。

---

## 第 5 步｜真机收码联调（约 100 字）

在登录页输本人手机号 → 点「獲取驗證碼」→ **确实收到短信** → 填码 → 点「登錄」。成功后做一次写操作（提交一条勘误或点一次「採信」）确认写面可用，再刷新页面确认仍是登录态（这是 30 天持久化令牌在起作用）。

再做三条负向：①换一个没登录过的手机号，应建成新账号而不是登进旧账号；②用非白名单手机号进管理面审核，应被结构化拒绝；③把验证码故意输错，应提示错误且不建账号、不写数据。

---

## 第 6 步｜验收密码与找回密码（约 100 字）

先在控制台「用户管理」建或改一个带手机号 + 密码的账号（用户名填 11 位手机号）。然后：①登录页「手機號 + 密碼」页签，用该账号登录 → 应成功并能提交勘误；②点「忘記密碼？」→ 输手机号取码 → 输验证码 + 新密码（8–20 位、含字母与数字）→ 提交；③用**新密码**登录应成功，用**旧密码**登录应失败。

**注意短信配额**：每号每分钟 1 条、该环境日上限 30 条，联调别反复取码。

---

## 回滚（出问题 3 分钟内回到旧态，约 100 字）

两条一起回，不能只回一边：**后端** —— 云开发控制台 → 云函数 → 选中函数 → 版本管理 → 把 `xiai-user-token` 和 `xiai-admin-token` 各自回滚到上一个版本；**前端** —— Vercel → 项目 `xiai` → Deployments → 找到上一个生产部署 → Promote to Production。

回滚完成后立刻验一次：用旧固定码 `729341` 能登录成功 = 旧函数确实回来了、整站已恢复旧形态。

---

## 故障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| 收到短信了，但填码后提示「手機號或驗證碼不正確」 | 平台 `/auth/v1/user/me` 回体里手机号字段名与代码预期（`phone_number`）不一致，验签拿不到号 ⇒ fail-closed | 在 `cloudfunctions/*/lib/platformAuth.js::pickPhoneNumber` 的兼容键里按实测字段名加一行（两份文件必须同改、保持逐字节相同），重跑第 2 步 |
| 登录提示「用戶令牌服務內部錯誤」 | 缺令牌密钥、`envId` 解析不到、或区域写错 | 回第 0/1 步核对；确认环境变量里 `TCB_ENV`/`SCF_NAMESPACE`/`CLOUDBASE_ENV_ID` 至少一项能解析出 envId |
| 点「獲取驗證碼」提示「当前调用的 getVerification() 所需的登录方式尚未在云开发控制台启用」 | 身份源被关 | 控制台 → 登录授权 → 开启「短信验证码登录」 |
| 取码失败 | 每号每分钟 1 条、环境日上限 30 条 | 等 60 秒再试；额度用尽等次日重置 |
| 取码报「账号不存在」/ 显示「短訊驗證服務暫時不可用」 | **旧版缺陷（已于 `39baea5` 修复）**：取码带了 `target:'USER'`，平台只给已注册用户发码，而新号占绝大多数 | 确认前端是新版（产物里 `target:"USER"` 应为 0、`isUsernameRegistered` 应存在）；若仍出现，说明前端未更新，重新触发 Vercel 构建 |
| 刷新页面就掉登录 | `XIAI_*_TOKEN_TTL_SECONDS` 没配（仍是 900 秒） | 回第 1 步配置后重新登录一次 |
| 管理员审核全部被拒 | `XIAI_ADMIN_PHONE` 缺或与登录手机号不一致 | 回第 0 步核对，注意管理面只认白名单里那一个号 |

## 上线后仍需要在意的遗留（与本次改动无关，另行排期）

`W-93` 管理员 op 计数三处读数不一致、`W-94` 钩子取值套件计数漂移、`W-95` `FROZEN_REASONS` 缺项、`W-96` README 仍写死 `ap-shanghai` —— 详见 `docs/xiai.spec.md` §11。
