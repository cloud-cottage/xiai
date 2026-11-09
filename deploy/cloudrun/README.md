# xiai-api 上云部署包（CloudBase 云托管 · CloudBase Run）

把 `server/`（Python 3.11 / FastAPI 影像服务 `xiai-api`）打成镜像并部署到云托管的**全部物料**。
浏览链路已由「影像静态化」（P0：`xiai/display/` + `xiai/thumb/` 对象直读）摘掉，本包是 **P1 底座准备**；
CFS 挂载与 COS→CFS 原件补齐属 **P2（待支付立项）**，见 §6。

## 0. 目录

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 镜像定义：`python:3.11-slim` + `nodejs`（切分薄桥必需）+ `server/requirements.txt` |
| `start.sh` | 容器入口：定 `XIAI_AUTHORITY_ROOT` → `exec uvicorn --host 0.0.0.0 --port ${PORT:-5191}` |
| `.dockerignore` | 构建上下文排除表（**单一真源**；`package.sh` 会把它放到包根） |
| `package.sh` | 装配器：`stage` / `build [tag]` / `zip` / `clean` |
| `README.md` | 本文 |

要点：**构建上下文 = 仓库根**（镜像要 `server/`、`src/`、`package.json`）；上下文里
**不含 `data/originals`（1.2 GB）**，原件走挂载（P2）或保持「浏览不依赖原件」（P0 现状）。

## 1. 前置

```bash
cd xiai/deploy/cloudrun
./package.sh zip          # ⇒ out/xiai-api-<时间戳>.zip（zip 根含 Dockerfile）
# 或本地出镜像：
./package.sh build xiai-api:0.1.0-p3
```

不装 Docker 也能出包：`zip` 只用 `rsync + zip`。

## 2. 控制台上传步骤（二选一）

**A. 本地 zip 上传（最快）**

1. 云开发控制台 → 选环境 `liwu-cny1313`（`liwu-cny1313-d1gb2fukyb7cb19bb`）→ **云托管 → 服务 → 新建服务**；
2. 代码来源选 **本地上传**，传 `deploy/cloudrun/out/xiai-api-*.zip`；
3. 构建方式 **Dockerfile**，Dockerfile 路径 `./Dockerfile`（zip 根即是），构建参数留空；
4. 部署配置按下表填 → 创建部署，等构建与启动完成。

**B. Git 仓库来源（可复现）**

1. 代码来源选仓库 → 指向 `xiai` 仓；
2. **Dockerfile 路径**填 `deploy/cloudrun/Dockerfile`，构建上下文 = 仓库根（默认即根）；
3. 其余同 A。

> 两种方式都**不要**在仓库根手写 `.dockerignore`：单一真源在 `deploy/cloudrun/.dockerignore`，
> zip 由 `package.sh` 负责放到包根；走 Git 来源时若平台只认仓库根 `.dockerignore`，
> 把该文件复制到根即可（内容一字不改）。

## 3. 服务参数（部署配置）

| 项 | 值 | 说明 |
| --- | --- | --- |
| 服务端口 | **5191** | `EXPOSE 5191`；控制台端口必须与之一致 |
| 协议 | HTTP | 无 TLS 终结需求（前面有网关） |
| 健康检查 | HTTP `GET /api/health`，200 | 仓库**已有**健康端点（只读、幂等、零副作用），未自创端点 |
| 规格 | **0.5 vCPU / 1 GiB** | 已定 |
| 实例数 | 按需（先 1） | 静态化后读面不再经服务，可压到最低 |
| 环境变量 `XIAI_AUTHORITY_ROOT` | `/data/originals` | 镜像已 `ENV`，P2 挂 CFS 时即挂载点 |
| 环境变量 `PORT` | 平台注入 | `start.sh` 取 `${PORT:-5191}` |
| 工作目录 | `/app` | `package.json` 在此（`"type": "module"`，供 `src/tilesplicer` ESM 导入） |

## 4. VPC / 固定出口 IP 自测

已开通固定出口 IP：**`111.229.107.48`**（出网 SNAT）。

```bash
# ① 服务侧自测（容器内 / 或云托管「终端 / 日志」进容器）
curl -s https://ifconfig.me ; echo        # 期望：111.229.107.48
curl -s localhost:5191/api/health | head -c 200   # 期望：{"ok":true,"name":"xiai-api",…

# ② 外网回打（服务发布后，用域名/公网入口）
curl -s -o /dev/null -w '%{http_code}\n' https://<服务域名>/api/health   # 期望：200
```

若 ① 回的不是 `111.229.107.48`：检查服务是否绑在**该环境的固定 IP 出口**（出网策略 /
NAT 网关），而不是容器自身 IP —— 固定的是**出网源地址**。

VPC：云托管服务与同环境云函数/数据库同 VPC 内网互通；跨环境访问（如旧环境数据库）
必须走公网或对等连接 —— 本包不依赖任何跨环境内网调用。

## 5. 与线上口径的一致性（镜像内事实）

- 服务代码与本地同源：`server/app/{main,store,codec,slicer,errors}.py`，**未改任何业务逻辑**；
- 绑定地址：本地 `server/run.sh` 绑 `127.0.0.1`（AC-156），容器绑 `0.0.0.0`（平台要求）——
  这是**唯一**差异，且在 `start.sh` 而非业务代码里；
- 切分薄桥要 `node`：`apt install nodejs` 已装；`geom.mjs` 读 `/app/src/tilesplicer/**`，
  缺任一文件 ⇒ `/api/tilesplicer/**`、`/api/image/slices` 结构化 500（零伪数据）；
- 健康检查用**已有** `GET /api/health`（未新增端点）。

## 6. CFS 挂载与原件补齐（**P2，待支付立项**）

云托管底座 43 元/月尚无支付场景摊销，**暂不立项** ⇒ 本包**不接** COS→CFS 拉取。

- 现状（P0 静态化后）：浏览链路读 `xiai/display/`、`xiai/thumb/` 对象直读，
  **不经本服务**；`/data/originals` 为空 ⇒ `GET /api/image/original/{sha256}`、
  `?sha256=` 形态的 thumb/download 返回结构化 `NOT_FOUND`（不崩服务）。
- 立项后要补的两件事（口径已备）：
  1. 挂载：云托管 → 存储挂载 → CFS，**挂载点 `/data/originals`**（与 `XIAI_AUTHORITY_ROOT` 一致）、
     挂载可读写、同 VPC；
  2. 首启补齐：`scripts/migration/upload-cos.mjs --src data/originals --prefix xiai/originals/`
     先把原件送上 COS，再由一次性 Job / `start.sh` 拉取补齐（**默认建议**：
     一次性 Job 先灌满 CFS → `start.sh` 只做「缺失即报错退出」，避免每次启动都可能拉 1.2 GB）。
     两种取舍（启动时拉 vs 一次性 Job + 只校验）**都在本 README 记录**，立项时二选一即可。

## 7. 回滚

- 云托管 → 该服务 → **版本历史** → 选上一个可用版本 → **回滚 / 重新部署**（平台保留历史镜像）；
- 或本地重打：`git checkout <上一提交> && ./package.sh build <tag> && 控制台重新上传`；
- 数据面无迁移风险：镜像不带 `data/originals`，CFS（P2）与对象存储里的数据**不由镜像管理**，
  回滚只换进程、不碰数据。

## 8. 本地验收口径（不依赖 Docker）

```bash
cd xiai/server
XIAI_AUTHORITY_ROOT=/tmp/xiai-root-probe \
  .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 5191
```

四条必测（读数见交付报告）：`POST /api/image/store` → 200 + sha256；
`GET/POST /api/image/thumb?sha256=…` → 200 + `image/webp`；
`POST /api/image/download` → 下载件 sha256 ≡ store 返回值；
`POST /api/image/decode`（非 TIFF）→ 415 结构化 `NOT_IMAGE`；
另加一条：`curl 0.0.0.0:5191/api/health` 通 ⇒ 确认**只监听 0.0.0.0**。
