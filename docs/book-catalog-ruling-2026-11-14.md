# 裁定：印譜匯觀（book 数据 ＋ 影像归属印谱）

- 状态：**已裁定**（Kevin 2026-11-14 CST，含四处追问的答复）
- 性质：非规范。供实现 / 规范 / 质检单作唯一口径真源。

## 〇、Kevin 原话

> A：首页左侧的菜单栏增加：【印譜匯觀】，顺序放到【我的云盘】的前面。这个菜单暂时只有管理员可见，管理员可以在这里创建 book 数据。
> B：book 叫【印譜】，book数据包括：1、name，书的名称（简体繁体均可，不强制），2、ISBN 编号（可空），3、CIP 编号（可空），4、book ID，5、作者（不为空），6、首次出版年份（可空）
> C：每张 face 的图片，或者不指定 face 的 seal 的图片，都可以指定 book ID，供管理员整理数据之间的关系。这种数据关系和book 数据暂时只有管理员可见

追问答复：
- 一张影像**只归一本书**（一对多，单值 `book_id`）；
- 作者**必须是印人库已收录的人**（引用型，与勘误作者同门）；
- book ID **五位纯数字递增**（`00001`、`00002`…），**管理员不可改**；
- 挂书入口**两处都要**（详情页每张图旁下拉 ＋ 印譜頁批量挑图）。

## 一、数据模型

### 1.1 新集合 `xiai_books`

| 字段 | 类型 | 必填 | 口径 |
|---|---|---|---|
| `id` | 字符串 | ✓ | **＝ book_id**，五位纯数字（`'00001'`），**系统发号、不可改** |
| `name` | 字符串 | ✓ | 书名。**简繁均可、不强制转换**，上屏原样输出（不跑 `s2t`） |
| `isbn` | 字符串 | 可空 | 空串 / `null` 均视为「未著录」；非空时保留原样（连字符不剥） |
| `cip` | 字符串 | 可空 | 同上 |
| `author_person_id` | 字符串 | ✓ | **引用型**：必须是 `xiai_persons` 已收录印人（与勘误作者同门）；上屏用 `persons.personName` |
| `publisher` | 字符串 | 可空 | **【出版社】**（2026-11-15 Kevin 追加）：空串 / `null` ⇒「未著录」；非空原样保留，长度上界 **200**（与书名同级；编号类 `isbn`/`cip` 仍 64） |
| `first_publish_year` | 整数 | 可空 | 首次出版年份；非空时须为 `1000`〜当年 的整数 |
| `created_by` / `created_at` / `updated_at` | — | — | 审计面，服务端写，客户端不可递 |

### 1.2 关系字段：`xiai_images.book_id`

- 影像行（`xiai_images`）新增 **`book_id`**（字符串，可空）。
- **一对多**：一张影像至多一本书 ⇒ 单值字符串，**不是数组**。
- 覆盖 Kevin 的 C 条两类影像：face 的图片（面行 `face_image_id` 指向的影像行）与**不指定 face 的 seal 图片**（`stamp_id` 指向本章、且未被任何面行引用的影像行）—— 二者都是 `xiai_images` 行，故**同一字段覆盖**。
- 清空（`book_id = null`）合法：等于「取消归属」。
- **不做级联删除**：本批**book 无删除能力**（避免悬空引用）；影像被删不影响 book。

## 二、菜单与路由

- `src/components/AppSidebar.vue` 的 `items` 插入一项，**位置在 `my-drive` 之前**：
  `{ key: 'books', to: { name: 'books' }, glyph: '譜', label: '印譜匯觀' }`
  （glyph 沿用单字约定，**不画 SVG**）。
- 新路由 `/books`（`name: 'books'`，`meta.title: '印譜匯觀'`），视图 `src/views/BookIndexView.vue`。
- **仅管理员可见**：非管理员 / 未登录 ⇒ 菜单项**不渲染**（不得 `disabled` / CSS 隐藏冒充）；
  直接访问 `/books` ⇒ 页面显示无权限提示，**零 book 数据请求**（不得先取后藏）；服务端另有管理员门（双门）。

## 三、写入面（新增 3 个管理员 op）

全部走既有管理员门 `adminWhitelistDenial`（缺 env / 非白名单 ⇒ 结构化拒 ＋ 零读零写）。
**载荷一律封闭键面**，未知键 ⇒ `INVALID_FIELD`。`ADMIN_OPS` 计数 **现取 +3**。

| op | 载荷（封闭） | 回包 | 口径 |
|---|---|---|---|
| `createBook` | `name / isbn / cip / author_person_id / first_publish_year`（5 键） | `{ ok, book_id }` | `author_person_id` 必须是已收录印人（`readPersonRow` 同门）；`book_id` 服务端发号；**幂等**：同 `name` ＋ 同 `author_person_id` 已存在 ⇒ 返回既有 `book_id`、不建第二行 |
| `listBooks` | `{}`（空载荷） | `{ ok, books: [...], total }` | 管理员读；按 `id` 升序 |
| `setImageBook` | `image_id / book_id`（2 键；`book_id` 传 `null` ＝ 取消） | `{ ok, image_id, book_id }` | 校验影像行存在且 `book_id` 指向的书存在；**读回比对**（不得以 `updated >= 1` 判成功） |

发号：**复用既有发号单点**（`issueCodeNumberAvoiding(kind, isTaken)` 形态），`isTaken` 按 `xiai_books.id` 查重；**禁止**随机 id / 时间戳 / 客户端发号。

## 四、前端

### 4.1 `/books` 页（管理员）

1. **列表**：book ID / 书名 / 作者（人名）/ 首次出版年 / ISBN / CIP / 关联影像数。
2. **新建表单**：书名（必填）、作者（`PersonPicker`，候选源 `persons.referablePersons()`，必填）、ISBN、CIP、首次出版年（可空）⇒ 调 `createBook`。
3. **批量挂图**：选中一本书 → 从影像列表勾选 → 挂上（逐张调 `setImageBook`）；已归属其它书的影像**明示当前归属**，改挂需管理员确认。

### 4.2 印章详情页

- 每张影像旁（face 图与整章图）加「所屬印譜」下拉，**仅管理员可见**；选中即时提交 `setImageBook`，成功后读回确认；失败给出可见反馈且**不保留假状态**。
- 下拉项来源 `listBooks`（书名 ＋ ID）；另有「未歸屬」项（清空）。

### 4.3 普通用户零泄漏

- 菜单项不渲染；`/books` 不可达；详情页无下拉；**`book_id` 不得出现在任何普通用户可见的 DTO / 卡片**（与浏览量「卡片不显示」同口径）。
- book 数据与图↔书关系**暂时只有管理员可见**（Kevin C 条原文）。

## 五、验收

1. 管理员登录：左侧菜单第 4 项为【印譜匯觀】，位于【我的雲盤】之前；普通用户 / 未登录：该项 0 命中。
2. `/books` 可建书：五字段门生效（`name` / `author_person_id` 必填；`isbn` / `cip` / `first_publish_year` 可空；年份越界拒）；新建成功拿到**五位数字** `book_id`，递增不重号。
3. 作者只能选已收录印人（无命中 ⇒ 提示去提交印人提案，不得放行自由文本）。
4. 详情页 face 图与整章图都能挂书 / 清空；同一张图挂第二本 ⇒ 替换为最新（一对多）。
5. `setImageBook` 成功后读回一致（不得假成功）。
6. 普通用户侧：`/books` 无数据请求、详情页无下拉、DTO 无 `book_id`。
7. `[data-admin-action]` 仍恰 12 值；`ADMIN_OPS` 仅 **+3**。
