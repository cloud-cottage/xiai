# 拆解件：登录改「真实短信验证码 + 密码」双路 ＋ 忘记密码重置

- 状态：**全部落地 · 离线验证全绿 · 已提交（本地 `c8df923`）· 推送被 GitHub 权限所阻（`0xfits` 对 `cloud-cottage/xiai` 无写权）· 生产未部署**
- 作者：Zang（总监）· 2026-11-15
- 性质：**需求拆解 / 派单口径件**（非规范、非代码）。规范升版归 Jing，实现归 Kong，质检归 Neng。
- 输入＝ Kevin 2026-11-15 原话：**「把登录方式改为真实短信验证码」** ＋ 追加原话：**「真实短信验证码和密码两种方式组合，如何忘记密码可以用验证码登录，再重置密码。」**

## 进度台账（2026-11-15）

| 批次 | 状态 | 结果 |
|---|---|---|
| **P0 探针** | ✅ | 三态结论 = **B 可桥接**；envId `liwu-cny1313-d1gb2fukyb7cb19bb`；身份源已开通（`PhoneNumberLogin:true`，`SmsDayLimit:30`）；`/auth/v1/user/me` 会真验签 |
| **P1a 后端** | ✅ 落地（未部署） | `lib/platformAuth.js`（250 行）+ `index.js::handleIssue` 判定链 + `config.js` 去固定码必填 |
| **P1b 前端** | ✅ 落地（未部署） | 真发码 + 60s 冷却 + 频控原文；`src/data/cloudbaseAuth.js`（`persistence:'none'` 隔离）；固定码面““零残留 |
| **P1c 管理面** | ✅ 落地（未部署） | `xiai-admin-token` 同构改真码 + 白名单；两条 `platformAuth.js` **逐字节相同**（diff 空） |
| **质检 Neng** | ✅ **PASS** | build 绿；非预期红 = 0；安全红线逐行验（`index.js:377` 严格相等，`issueToken` 仅在 :387/:660）；故障语义 `STORAGE_UNAVAILABLE`；独立 13 条负向全绿 |
| **规范 Jing** | ✅ | `docs/xiai.spec.md` **v1.117 → v1.118**：新增 §3.95 + §10.102（`AC-795`〜`AC-807`）；`W-43` 收口（用户面）、`W-65` 作废；集合/reason/ADMIN_OPS/钩子计数全不变；快照 `docs/versions/xiai.spec.v1.117.md` |
| **P2 密码路** | ✅ 代码+离线验证完成（未部署） | 6 组自测 **91/91 绿**（连跑两次一致）；`npm run build` **EXIT=0**；`finalizeLogin` 单点（定义 1 / 调用 2 / `saveUserRows(` 1）；测试落 `tests/p2-auth-password.mjs` |
| **R-L3 脚本迁移** | ✅ 18/18 全绿（假密钥下） | writeface-p1 **61/61**、admin-review-op **87/87**（R-L11 变异测试证非恒真、R-L12/R-L13 判据改后无误伤）；全 18 个缺密钥均 SKIP exit 0 |
| **规范 v1.119** | ✅ | 快照 `docs/versions/xiai.spec.v1.118.md`（md5 `a7efce80…`，12,813 行 / 6,066,719 B）；新增 §10.103（`AC-808`〜`AC-826`）；新开 `W-93`〜`W-96`（ADMIN_OPS 三读数、钩子套件漂移、`FROZEN_REASONS` 缺项、README 区域文案） |
| **终验 Neng** | 🔄 进行中 | build + 两份 tests + 18 脚本两形态 + 安全红线 + 持久化单点复核 |
| **P3 令牌持久化** | ✅ 代码+离线验证完成（未部署） | `tests/p3-token-persistence.mjs` **69/69 绿**；localStorage 单点（信封恰 4 键）；`verify` 按服务端 `expiresAt` 滑动续期回写；`TOKEN_INVALID`/版本不符清持久化且不重试；内部故障**不清**令牌；登出清两通道；R-L9 区域参数化（`XIAI_AUTH_REGION`→`TCB_REGION`→`ap-shanghai`） |
| **上线** | ⏸ 待人类 | 见 §11 |

## 11. 上线（操作说明书另开一册）

**逐步操作见 `docs/xiai-login-sms-go-live-sop-2026-11-15.md`**（六步、每步一操作约 100 字、带可粘贴命令与故障对照表）。本节只留三条发布纪律：

1. **同批上线**（R-L4）：`xiai-user-token` + `xiai-admin-token` 代码与前端 `dist` 同一时间窗；只上一边 = 登录全断。
2. **代码通道**：只用 `tcb fn code update <name> -e <envId>`（不碰环境变量）；禁用 `tcb fn deploy` / `tcb fn config update`（会把含密钥配置写盘并可能用空值覆盖线上变量）；禁用 `tcb fn detail`（原文回显密钥）。
3. **回滚**：两个函数各自回滚上一版本 + Vercel Promote 上一个 production 部署，两样同批回。

**附：发布门与遗留**

- `run-verify-suite.sh` 暂不可作发布门（18 个脚本已迁移、缺密钥 SKIP；残余红为既存非登录类）；期间门 = `npm run build` + `tests/p2-auth-password.mjs` + `tests/p3-token-persistence.mjs` + 真机联调。
- **已知既存红**（与本轮无关，单独排期）：基线 `failed_ids=36`，含 6 个两轮均崩的脚本（`admin-review-op` / `ai-enhance-wire` / `correction-display` / `person-model` / `phrase-data` / `writeface-p1`）+ `W-93`〜`W-96`。
- **规范遗留**：§3.94 号段由 v1.117 宣告行占用但正文本体缺位（`grep -c '^### 3\.94'` = 0），本轮自 §3.95 续号未占用 —— 待 Jing 另单收口。

---

## 1. 已定决策（Kevin 2026-11-15 三选三答，不可改写）

| 项 | 决策 | 说明 |
|---|---|---|
| 架构 | **方案 B：云开发平台原生短信验证码登录 + 平台 `setPassword` 改密** | 不自建腾讯云 SMS；走云开发「短信验证码登录」身份源 |
| 令牌续期 | **令牌持久化到 localStorage + 30 天滑动续期** | 兜底撤销面＝`XIAI_USER_TOKEN_VERSION`（改它＝全体旧令牌失效） |
| 前置 | **先探针再开工** | 探针未定论前不动生产代码 |

## 2. 方案 B 的命门（必须先证，探针第 5 问）

业务身份 `uid = 'u-' + sha256(phone)[:16]`（`src/data/uid.js::uidOf` 与云函数 `lib/config.js` 同算法），现存勘误 / 采信 / 积分 / 影像行全按它落库 ⇒ **口径不可变**。

而 `xiai-user-token` 的 `issue` 必须**独立**判定「此客户端刚完成该手机号的短信验证」。若服务端只能听客户端自报手机号 ⇒ 可冒充任意人（含管理员 `XIAI_ADMIN_PHONE`）签发令牌 ⇒ **B 不成立**。

判定证据两条：
- **(a)** 把 `verification_token + verification_code` 交云函数，云函数调 CloudBase Auth 的 verify 接口二次校验（需查该接口是否可凭环境内凭据调用 —— 若需 `client_secret`，须评估是否可入环境变量）；
- **(b)** 从平台会话反查手机号（`getEndUserInfo` / `queryUserInfo` 是否有手机号字段）。

**三态后果**：
- **B 可桥接** ⇒ 按第 4 节批次推进（uid 口径零变、无需身份映射集合）。
- **B 需降级** ⇒ 回报 Kevin 重选短信通道（自建腾讯云 SMS 或其它），不得自行降级。
- **B 不可行** ⇒ 同上，且明确「固定码 `W-43` 无法在本轮收口」。

## 3. 目标流程（人类可见行为）

1. 登录页两条路并存：**手机号 + 密码** ／ **手机号 + 真实短信验证码**；两路都落**同一枚 xiai 令牌、同一 `uid`、同一 session**、同样的写面权限。
2. 取码：60s 冷却、平台限频（每号每分钟 1 条、每日上限）**如实上屏**（不得吞成通用提示）。
3. 忘记密码：短信码登录成功（已登录态）⇒ 输入新密码 ⇒ 重置成功 ⇒ 用新密码登录。
4. 密码规则（默认，一句话可改）：8–20 位，含字母与数字；弱密码拒并如实说明。
5. 演示码路径**必须下线**：删前端 `DEMO_SMS_CODE` / `requestCode()` 自动填入 / `loginCodeHint()` 的演示文案；服务端 `XIAI_USER_SMS_CODE` 固定码校验下线（`W-43` 由「已接受风险」收口为「已消除」）。

## 4. 批次拆分（探针通过后按此派单）

| 批次 | 归属 | 内容 | 出口判据 |
|---|---|---|---|
| **P0 探针** | Kong | 7 问取证 + 三态结论（见派单） | 结论 + 人类待办清单 |
| **P1 发码与码登录** | Kong | `src/services/auth.js` 取码改真实发送（含冷却/限频文案）；登录改 OTP；`cloudfunctions/xiai-user-token` 的 `issue` 改为服务端权威判定（依探针 (a)/(b) 落点）；`uid` 口径不变 | 真机收码可登录；错码/过期/重放/越权全被拒且零写入 |
| **P2 密码双路** | Kong | 密码登录接上 session + 令牌（现为半成品 `auth.js:150`）；忘记密码＝已登录态 `setPassword`；弱密码与错误文案 | 密码登录可提交勘误；重置后旧密码失效 |
| **P3 令牌持久化** | Kong | `src/services/token.js` 改 localStorage + 30 天滑动续期；`src/services/userWrite.js:79` 静默补签链改判据（不得再用固定码）；令牌丢失时引导重新登录 | 刷新页面不掉登录；令牌过期后写面结构化拒绝并引导 |
| **P4 收口与规范** | Jing | 规范升版：登录面改写、`§3.43` 演示码面取代、`W-43` 收口、`W-65`（漂移防护）作废、新增 AC（真码/限频/重置/持久化）；集合清单如因探针结论有增减须逐项留痕 | 规范与实现逐条对齐 |
| **P5 全量回归** | Neng | 新负向套件（错码 / 过期 / 重放 / 限频 / 未注册号 / 弱密码 / 令牌过期）+ `node scripts/run-verify-suite.sh` 全绿 | 全绿报告 + 上屏证据 |

## 5. 影响面（现盘，已实地确认）

- `src/services/auth.js:33`（固定码常量）、`:46`（`requestCode`）、`:59`（`loginCodeHint`）、`:82`（`login`）、`:150`（`loginWithPassword`）
- `src/views/LoginView.vue:33-41`（取码自动填入）、`:57-66`（密码路不写 session）
- `src/services/userWrite.js:79`（用固定码静默补签）
- `src/services/token.js`（令牌只存内存）、`src/services/userToken.js`
- `cloudfunctions/xiai-user-token/index.js:302`（`code === config.smsCode`）、`lib/config.js:90`（`XIAI_USER_SMS_CODE`）
- 依赖：`@cloudbase/js-sdk 2.25.3`（已含 `getVerification` / OTP / `setPassword`）；**node-sdk 服务端无改密 API**（只有 `getAuthContext` / `createTicket`）
- **全仓零短信集成（2026-11-15 实证）**：对 `/Users/kevin/bistro` 全域 grep `SendSms|SmsSingleSend|tencentcloud-sdk-nodejs-sms|sendSmsCode|getVerification|signInWithSms`，命中仅 `xiai/dist/assets/index.esm-*.js`（js-sdk 自身字符串）与 `docs/versions/*.md` 历史快照 ⇒ **无任何真实短信发送调用、无任何短信 SDK 依赖**。

## 6. 风险与红线

1. **不得用客户端自报手机号签令牌**（等同冒充任意人，含管理员白名单）。
2. **不得把短信密鑰 / 令牌 / 手机号原文**写进报告、日志、会话（沿用 `§3.44.5` 追加注口径）。
3. 平台限频是**外部硬约束**：60s 冷却文案必须如实说明「每分钟 1 条 / 每日上限」，不得假装成功。
4. OTP 平台用户与业务 `uid` 是**双身份**：若探针结论要求绑定关系，须由服务端在**已验证**前提下写入，不得由客户端直接绑。
5. 存量固定码登录产生的 session / 令牌：**不迁移、不作废既有数据行**；但固定码本身必须失效（否则本轮无意义）。
6. 本件不授权任何实现方自行扩范围（不改写面其它 op、不动积分/勘误业务规则）。

## 7. 待人类（Kevin）事项

- 云开发控制台开通「短信验证码登录」身份源（含实名 / 短信服务与配额确认）。
- 提供一个可收码的手机号用于探针与联调（**不落盘、不写报告**）。
- 确认 `envId`＝**`liwu-cny1313-d1gb2fukyb7cb19bb`**（标准版，2026-11-09 建；证据 `cloudbaserc.json:2`、`.env.production:4`、`tcb env:list`）。**本件初稿猜测的 `liwu-d8gek6jjdab1d087c` 是旧环境，已作废**。

---

## 8. 探针结论（Kong 2026-11-15，只读取证）

- **三态结论 ＝ B 可桥接**。服务端无需任何 secret 即可独立确认手机号归属：
  - `POST https://<envId>.ap-shanghai.tcb-api.tencentcloudapi.com/auth/v1/verification/verify?client_id=<envId>`（`client_id` 即 envId，无 secret 需求；伪造 id/code 回 400 而非 401，证明可达校验逻辑）；
  - `GET /auth/v1/user/me?client_id=<envId>` **会真验签** `access_token`（无令牌 401；伪造 Bearer 回 200 + `INVALID_ACCESS_TOKEN`）。
- 平台身份源已开通：`PhoneNumberLogin: true`、`SmsVerificationConfig Type=default`、`SmsDayLimit=30`；该环境平台用户 total=1（仅内置超管、无 Phone）⇒ **无过渡账号需要迁移**。
- 云函数侧 `getAuthContext(context)` 只回 `{uid, loginType}`，**无手机号** ⇒ 不得把「平台会话」当手机号真源。
- OTP 调用形态（js-sdk 实装 **2.32.0**）：`getVerification({phone_number, target:'USER'})` → `verification_id`；`verify({verification_id, verification_code})` → `verification_token`；`signIn({username, verification_token})`；会话对象含 `phone` / `access_token` / `is_anonymous`。
- 重置密码现成通道：`resetPasswordForEmail(phone)`（发码 → verify → `resetPassword({phone_number,new_password,verification_token})` → 自动密码登录）；`sudo({verification_token})` + `setPassword` 为第二形态；`updatePasswordByOld` 需旧密码，忘记密码场景不适用。三条改密 API 均 `withCredentials`（只作用本人会话）。
- **仍需一次真实收码才能坐实**：verify 成功态返回体与 `verification_token` 声明里 `phone_number` 的确切字段名（探针只跑到错误分支）。

## 9. Zang 裁定（B 内部口径；每项一句话可改）

| 编号 | 裁定 | 依据 |
|---|---|---|
| **R-L1** | 服务端权威凭证 ＝ 平台 `access_token`；`issue` 入参由 `{phone, code}` 改为 `{phone, platformAccessToken}`；云函数调 `/auth/v1/user/me` 验签取 `phone_number`，与客户端声明手机号**双向一致**才签令牌；`uid` 口径零变 | 探针 Q5(a) 实测 |
| **R-L2** | 密码登录成功同样用 `access_token` 换 xiai 令牌（与 R-L1 同构），修好现 `loginWithPassword` 半成品 | `src/services/auth.js:150-187` |
| **R-L3** | 自检脚本改「用当前密钥现签令牌注入」，**不在生产引入固定码后门**；若密钥对脚本不可得，回报后再定 | 11 个脚本依赖固定码 |
| **R-L4** | 前后端**同批上线**：新后端拒固定码 + 旧前端仍发固定码 ＝ 全站登不上 ⇒ 实现期不部署 | 发布顺序风险 |
| **R-L5** | 管理面 `xiai-admin-token` 的固定码 `XIAI_ADMIN_SMS_CODE`（`index.js:156`）**同批收口**（Kevin 未表态 ⇒ 按推荐默认推进；一句话可改） | 否则 `W-43` 只收一半 |
| **R-L6** | 读面匿名会话与 OTP 会话必须**持久化隔离**（不同 app 实例或独立存储键），否则登录后读面权限漂移 | 探针风险项 |
| **R-L7** | 真实收码联调**放在 P1 实现完成后**、上线前一次（Kevin 未表态 ⇒ 默认推进） | 不打断实现 |
| **R-L8** | 「无令牌 + 有会话 ⇒ 静默补签」已被 P1 **有意删除**（真码无法静默补签）⇒ `verify-admin-write-via-login` 的 E1/E1b/E1c/E1d 与 `verify-review-token-path` 的 D0/D0b/D0c/D0d **改断言语义**为「无令牌 ⇒ 结构化拒绝 FORBIDDEN ＋ 可读重新登录引导 ＋ 零写入 ＋ 零往返」；不得删断言、不得改成恒真 | P1b 删除了该路径，旧断言测的是已不存在的行为 |
| **R-L9** | D4「鉴权面零域名」判据：平台 auth host 允许存在，但必须**单一常量**且区域可被环境变量覆盖（默认 `ap-shanghai`）；判据改读「除 `AUTH_HOST_SUFFIX` 单一常量外，鉴权面零域名」 | `platformAuth.js` 触发 D4（区域后缀硬编码，换区即失配） |
| **R-L10** | P3 令牌持久化范围：`localStorage` 键由 `src/services/token.js` **单点**管理；TTL 30 天 + 每次 verify 成功滑动续期；撤销面仍为 `XIAI_USER_TOKEN_VERSION`；**已有持久化令牌时写面零提示、零重新登录** | Kevin 已选「持久化 + 30 天」 |
| **R-L11** | R-L8 生效范围**扩到** `verify-writeface-p1` 的 B1/B1b/B1c（同一根因：静默补签已被 P1 删除）⇒ 改为「无令牌（有无会话皆同）⇒ FORBIDDEN ＋ 零往返 ＋ 零写入」；B1n/B1n2/B1n3 已覆盖该判据，可并列保留 | 子代理实测 0 次往返即在传输缝前被拒 |
| **R-L12** | `verify-admin-review-op` 的 **C7**（「函数源码零 11 位数字」）判据改为**手机号形态正则**（与 `lib/config.js::PHONE_PATTERN` 同源），因现判据误伤 `lib/codeId.js` 的 `FID_MAX`（22⁸ 码空间容量，非手机号） | 判据过宽，非真缺陷 |
| **R-L13** | `verify-admin-review-op` 的 **D7**（零域名）按 R-L9 执行：`lib/platformAuth.js` 列入**白名单豁免**（它必须拼平台 auth 端点），其余文件仍零域名 | R-L9 的具体落点 |

## 10. 未表态项的默认口径（Kevin 2026-11-15 clarify 超时，按推荐推进；均一句话可改）

1. **管理面同批收口**（R-L5）⇒ 另开 P1c 批次：`xiai-admin-token` 同步改「平台 `access_token` 验签 + `XIAI_ADMIN_PHONE` 白名单」，删 `XIAI_ADMIN_SMS_CODE` 判定。
2. **自检脚本** ⇒ 走 R-L3「现签令牌注入」。若实现时确认密钥对脚本不可得，**必须回报 Zang 再定**，不得自行开白名单测试码后门。
3. **收码联调** ⇒ UAT 时一次，前置条件是 P1a/P1b 合入本机、未部署。
