# CPA Nexus 内核、模块与部署

CPA Nexus 使用完整的官方 CLIProxyAPI 作为模型流量内核，Logicc 是账号池模块，经内核创建的桥接渠道接入（见 [Logicc 模块](logicc-module.md)）。服务器不需要安装 Go 或 Node.js。

更新脚本构建本地应用并等待健康检查，随后重建边缘代理，使 Git 更新后的路由配置及文件挂载立即生效。数据库、Redis 卷、CPA 配置与既有管理员密码保留。

本文所有终端命令在 **Ubuntu 服务器的 SSH 终端** 中运行。1Panel 页面操作会单独注明。

## 服务与数据

```text
统一域名 → edge → app（面板、账号管理、CPA 管理适配）
               → CPA（原生模型流量）
                   → 桥接渠道 nexus-logicc → app:3000/api/modules/logicc/bridge/v1
                       → Logicc 网页 API（app.logicc.com）
公网 3041 → edge → 加号页面 + /api/external/*（仅此两项）

worker → 账号导入、Logicc 会话续期与模型同步、桥接渠道维护、日志清理
app + worker → PostgreSQL（真实业务记录）+ Redis（队列、租约和缓存）
```

| 服务 | 用途 | 数据是否持久保存 |
|---|---|---|
| `cpa` | 完整官方内核加可重放分组适配，源码/运行镜像固定 | `.runtime/cpa/` 保存配置、凭证、插件及日志 |
| `app` | 统一面板、模块网关、管理和外调 API | 业务记录在 PostgreSQL |
| `worker` | 导入队列、Logicc 会话保活与模型同步、桥接渠道维护 | 队列在 Redis，任务及账号结果在 PostgreSQL |
| `postgres` | 账号、加密凭据、密钥、分组、日志与模块设置 | 原有 `postgres-data` 命名卷 |
| `redis` | 任务队列、并发租约、会话亲和、短期缓存 | 原有 `redis-data` 命名卷；启用 AOF |
| `edge` | HTTP 入口：3000 分流面板与模型请求；3041 只提供加号页与外调 API | 使用仓库中的 Nginx 配置 |

PostgreSQL 是业务数据的依据，Redis 承担多个进程共享的调度状态。六个服务都有独立健康检查；Worker 检查 Redis 心跳，避免进程存在而任务已停仍显示健康。

CPA 原生渠道由 CPA 选号；Logicc 渠道在 CPA 里只是一个整体渠道（关闭了 CPA 的重试和冷却），号池内部由模块按分组、并发和冷却选号，CPA 不会对池内账号重复选号。

全新部署的 Compose 项目名为 `cpa-nexus`。如果需要迁移原数据，在旧 `.env` 显式设置 `NEXUS_COMPOSE_PROJECT=commandcode-manager` 以复用旧数据库与 Redis 卷，并保留 `APP_ENCRYPTION_KEY`。删除旧部署后全新安装不设置此选项，会生成独立 Nexus 数据卷与随机凭证。

## 最方便的部署方式：只有 Docker

需要 Docker 和 Docker Compose v2，可以使用 1Panel 已安装的 Docker。无需在宿主机安装 npm、Node.js、Go、PostgreSQL 或 Redis。

用 **1Panel 文件管理** 将项目上传到 `/opt/cpa-nexus`，或者更新已有项目目录。升级旧部署时继续使用原目录，保留 `.env`、`.env.cpa` 和 `.runtime/`。

**SSH 终端：**

```sh
cd /opt/cpa-nexus
bash scripts/deploy.sh init
```

脚本在一次性 Docker 容器中创建缺失配置，随机生成管理员、数据库、Redis 和 CPA 密钥。重复初始化不会覆盖已有文件或修改密码，不会导入真实账号或发模型请求，也不把密码打印进日志。

**1Panel 文件管理：** 打开 `.env` 设置网址；登录用户名和密码在 `ADMIN_USERNAME`、`ADMIN_PASSWORD`。

```dotenv
APP_URL=https://你的实际域名
APP_PORT=3000
BIND_ADDRESS=127.0.0.1
```

保持默认绑定 `127.0.0.1`，由网站反向代理提供外网访问。数据库、Redis 和 CPA 端口只用于私有 Docker 网络。若网站代理可以访问宿主机回环端口：

```sh
bash scripts/deploy.sh up
```

`up` 构建项目、启动六个服务，并等待健康检查完成。然后打开 `APP_URL` 登录。首次构建需要下载镜像和依赖，耗时取决于网络和服务器资源。1Panel OpenResty 通常在另一个容器内，建议使用下一节的持久网络。

## 1Panel 与 HTTPS

**SSH 终端：** 查看 OpenResty 的网络：

```sh
docker ps --format 'table {{.Names}}\t{{.Networks}}\t{{.Ports}}'
```

**1Panel 文件管理：** 在 `.env` 添加 OpenResty 容器已有的实际网络名称。下方仅为示例：

```dotenv
PANEL_NETWORK=1panel-network
```

**SSH 终端：**

```sh
bash scripts/deploy.sh up --1panel
```

**1Panel 网站页面：** 创建反向代理网站，代理到 `http://nexus-edge:3000`，绑定域名并申请 HTTPS 证书。原 `http://ccm-app:3000` 别名保留。网络与别名写在 Compose 中，服务器重启和容器重建后继续生效，不使用固定容器 IP。

网站代理应保留 Host/HTTPS 转发头、允许 WebSocket、关闭流式缓冲并增加模型请求超时。检查对应代理规则的这些配置，保留 1Panel 自动生成的代理目标和证书配置：

```nginx
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_buffering off;
proxy_request_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_ignore_client_abort off;
```

外层 OpenResty 与内部 edge 都需要允许流式输出和客户端取消。这里的入口代理用于 HTTPS 与流量分流。

**公网加号页（3041）**：edge 默认在 `${INTAKE_BIND_ADDRESS:-0.0.0.0}:${INTAKE_PORT:-3041}` 发布加号页。要加 HTTPS，可以在 1Panel 新建一个反向代理网站，代理到 `http://nexus-edge:3041`，并把 `.env` 里的 `INTAKE_BIND_ADDRESS` 改成 `127.0.0.1`。3041 上只有加号页和 `/api/external/*`，管理后台、模型接口和模块桥接在这个端口一律返回 404。记得在服务器防火墙或安全组放行对应端口。

## 常用运维命令

在项目目录运行。使用 1Panel 网络时保留末尾的 `--1panel`：

```sh
bash scripts/deploy.sh status --1panel
bash scripts/deploy.sh logs --1panel
bash scripts/deploy.sh stop --1panel
bash scripts/deploy.sh up --1panel
```

更新本项目源码之后：

```sh
bash scripts/deploy.sh backup --1panel
bash scripts/deploy.sh update --1panel
```

`update` 根据当前目录源码重建应用，保留配置、密钥和数据卷，继续使用 `.env.cpa` 中固定的 CPA 镜像。它不自动拉 Git、切到 CPA 最新版或删除数据库。`unless-stopped` 使正常运行服务在服务器重启后自动启动；手动执行 `stop` 的服务需要再次执行 `up`。

## 备份和恢复

```sh
bash scripts/deploy.sh backup --1panel
```

备份保存在 `artifacts/backups/UTC时间/`。脚本短暂停止原先运行的 app、worker、CPA 和 edge，导出 PostgreSQL；Redis SAVE 后也短暂停止，以归档一致的 AOF/RDB。完成或失败后尝试恢复原先运行的服务，不删除数据卷。

| 文件 | 内容 |
|---|---|
| `postgres.dump` | PostgreSQL 全库导出 |
| `redis.tar.gz` | Redis 持久化目录，含 AOF 和 RDB |
| `config.tar.gz` | `.env`、`.env.cpa`、完整 `.runtime/cpa/` |
| `images.txt` | 当时使用的镜像记录 |
| `COMPLETE` | 完整备份标记；缺少时不要作为完整备份恢复 |

把整个备份目录复制到服务器外保存。不能只备份数据库：`.env` 的加密密钥、CPA 配置和凭证必须配套恢复。备份包含登录密钥及供应商凭证，应私密保存。

下面在**新服务器或空数据卷**恢复，不能直接覆盖现有生产环境。上传项目和完整备份；将 `备份时间` 替换成实际目录名，确认目标目录没有需要保留的配置和 CPA 状态，再运行：

```sh
cd /opt/cpa-nexus
BACKUP_DIR="$PWD/artifacts/backups/备份时间"
test -f "$BACKUP_DIR/COMPLETE"
tar -xzf "$BACKUP_DIR/config.tar.gz"
nexus_compose() {
  docker compose --env-file .env --env-file .env.cpa -f compose.yml "$@"
}
nexus_compose up -d --wait postgres redis
nexus_compose exec -T postgres pg_restore -U ccm -d commandcode --clean --if-exists < "$BACKUP_DIR/postgres.dump"
nexus_compose stop redis
REDIS_VOLUME="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$(nexus_compose ps -aq redis)")"
test -n "$REDIS_VOLUME"
docker run --rm --volume "$REDIS_VOLUME:/data" \
  --mount "type=bind,src=$BACKUP_DIR,dst=/backup,readonly" \
  node:24-alpine tar -xzf /backup/redis.tar.gz -C /data
```

若新服务器的 OpenResty 网络不同，先修改 `.env` 的 `PANEL_NETWORK`；恢复域名或修改 `APP_URL`，最后运行 `bash scripts/deploy.sh up --1panel`。未使用 1Panel 网络则去掉 `--1panel`。应用和 Worker 应在数据库、Redis、凭证恢复完之前保持停止。不要执行 `docker compose down -v`，它会删除数据卷。

## 密钥与配置

| 配置或密钥 | 用途 |
|---|---|
| `CPA_MANAGEMENT_KEY` | 仅内核层调用 CPA 管理接口，模块与客户端都拿不到 |
| `CPA_CLIENT_KEY` | 平台调用 CPA 的内部凭证；保留在 CPA 的 access/api-keys 配置中 |
| `NEXUS_BRIDGE_BASE_URL` | CPA 回调模块桥接的地址，生产容器内为 `http://app:3000` |
| `INTAKE_PORT` / `INTAKE_BIND_ADDRESS` | 公网加号页端口与绑定地址，默认 `3041` / `0.0.0.0` |
| 统一模型 API Key | `ccm_` 前缀，选择一个或多个分组，跨 CPA 和 Logicc 调用组内来源；新 Key 默认带 CPA 与 Logicc 两组 |
| 模块桥接 Key | `ccm_nexus_<模块>_`，由内核生成并写进桥接渠道，只能用于 CPA 回调该模块，不出现在 Key 列表 |
| 外调服务 API Key | `ccm_service_` 前缀，平台级，按模块授权加号范围，见 [外调服务 API](external-api.md) |
| 历史 CPA 客户端 Key | 保留原生兼容调用，在统一页面的历史密钥区管理，不参与分组和预设 |
| `CPA_URL` | 生产容器内 `http://cpa:8317` |

旧 `.env` 中的 `COMMANDCODE_*`、`CPA_COMMANDCODE_BASE_URL`、`KERNEL_URL` 已不再读取，可以删除。

从含 CommandCode 的版本升级：先 `bash scripts/deploy.sh backup`，再 `bash scripts/deploy.sh update`。Worker 启动时自动执行迁移 021：删除 CommandCode 账号、官方目录、内部桥接 Key 和相关日志；原 CommandCode 默认分组原地改名为「Logicc」，选了它的 Key 继续有效；外调 Key 获得全部模块的加号权限。CPA 中原来的 `nexus-commandcode`、`nexus-commandcode-messages` 渠道由 Worker 在两分钟内自动清理（内核只清理自己 `nexus-` 前缀下已无模块声明的渠道，用户渠道不动）。

历史 CPA 客户端 Key 可逐个迁移为模型 Key 并选择对应来源分组。迁移后仅撤销对应日常客户端旧 Key；`CPA_CLIENT_KEY` 仍用于内部转发。历史密钥节点的列表响应用 `x-nexus-reserved-key-index` 标记该内部凭证，保存或删除整个历史列表时平台会保留它。高级完整 JSON/YAML 配置编辑仍需保留这一凭证。

## 入口与原有端点

| 公网路径 | 处理服务 | 权限 |
|---|---|---|
| `/api/jobs/:id`、`/api/keys/*`、`/api/service-keys/*` | app，导入任务与两种 Key 管理 | 管理员登录 |
| `/api/external/*`（3000 与 3041） | app，按模块加号、任务与池信息 | 外调服务 Key |
| `/api/modules/*/bridge/*` | 仅 Compose 网络内的 CPA 回调；公网一律 404 | 内核桥接 Key + 签名路由头 |
| `/api/cpa/*`、`/api/modules/*`、`/api/logicc/*`、其余平台 `/api/*` | app，平台、CPA 管理适配与模块管理 | 管理员登录 |
| `/v1/*`、`/v1beta/*`（含 `/openai/v1/*`、`/cpa-api/v1/*`、`/cpa-api/v1beta/*`）的标准 HTTP 请求 | app 统一入口：`ccm_` Key 按分组顺序／策略选择来源（Logicc 经桥接渠道、CPA 原生凭证），应用该分组预设和 Devin 参数转换后交给 CPA；历史 CPA 客户端 Key 原样转发 | 统一模型 `ccm_` Key；历史 CPA 客户端 Key |
| `/backend-api/codex/*`、`/api/provider/*`、其余 `/cpa-api/*`，以及 `/v1` WebSocket | CPA 原生模型协议；`/cpa-api/` 移除前缀 | 历史 CPA 客户端 Key |

所有统一模型 Key 使用同一个 `https://你的域名/v1` Base URL，由 Key 与账号的共同分组决定可用来源。Logicc 停用时它的桥接渠道会从 CPA 移除，不影响 CPA 来源。具体操作及协议边界见 [分组说明](groups.md)。

酒馆预设是默认关闭的可选处理模块，按调用分组设置：请求由哪个分组处理，就叠加该分组已开启的预设（Chat/Messages/Responses 请求）。多分组 Key 自动切换到下一个分组时，预设也随之换成那个分组的设置。原有账号/模块预设记录保留，但统一 Key 不继承旧路由。完整操作和协议边界见 [预设模块](presets.md)。

入口支持 SSE、WebSocket、长连接和断开取消，上传、预设及模型请求体不设人为大小上限。CPA 管理 API、`management.html`、原生管理资源和 `/cpa-api/` 下的配置、凭证、插件及日志文件禁止公网直连；面板通过登录后的后台适配器访问管理接口。

固定版本的 OAuth 回调 `/anthropic/callback`、`/codex/callback`、`/antigravity/callback`、`/devin/callback`、`/callback` 转发至 CPA。部分供应商需要本机回调或 SSH 转发；WebRTC 中继、mDNS 和额外监听端口也需要单独网络部署及真实客户端验收，默认不发布这些额外端口。

## 开发与 CPA 升级

仅本机开发需要宿主 Node.js/npm。开发基础服务无旧 kernel，只在回环地址发布 PostgreSQL、Redis 和 CPA：

```sh
docker compose --env-file .env --env-file .env.cpa -f compose.yml -f compose.dev.yml up -d postgres redis cpa
```

本机 Nuxt 加载两份 env 文件。CPA 访问宿主 Nuxt 时，把 `NEXUS_BRIDGE_BASE_URL` 设为 `http://host.docker.internal:3000`，监听容器可达的接口，然后在模块管理里点「同步桥接渠道」。Linux 开发需配置 `host-gateway`。不要同时启动生产 app/edge 占用开发端口；生产会覆盖为容器内部地址。

Nexus 完整插件内核使用官方 v8.0.32 源码与运行镜像，保留原始 C ABI、全部路由和插件执行能力；`Dockerfile.cpa` 在固定提交上依次应用 `ops/cpa-nexus/` 下的 `nexus-plugins.patch`、`nexus-log-redaction.patch`、`nexus-devin-errors.patch`。适配增加真实插件能力发现和请求内分组校验，插件仍能改模型别名、调度或嵌套调用，最终账号选择始终限制在服务器授权集合内。成品镜像为 `cpa-nexus-core:v8.0.32-nexus1`。

从 v8.0.15（或更早的 v8.0.11）内核升级：先 `bash scripts/deploy.sh backup`，再 `bash scripts/deploy.sh update`（1Panel 加 `--1panel`）。update 会把 `.env.cpa` 里旧的项目固定版本自动换成 v8.0.32 并重建内核；运维自己改过的镜像或源码版本保持不动，需要自己改。这次升级的 Devin 相关变化：周、日额度用完后整个凭证冷却到重置时间，不再按模型逐个试；容量拒绝和新错误文案换号且不冷却；Devin 凭证只参加第一轮重试（见[分组文档](groups.md)）。

官方运行镜像的固定多架构摘要：

```text
eceasy/cli-proxy-api:v8.0.32@sha256:68f6e2d691f7b71aca21cfe87c77b7076cbea26c8ef490b15619b1623a7c0699
```

CPA 升级先在独立候选环境使用数据库、配置和凭证副本验证，不能让候选 Worker 消费生产队列。核对管理 API、配置、插件 ABI、渠道/OAuth、工具多轮、流式、WebSocket、取消释放及账号池后，更新 `.env.cpa` 中 `CPA_UPSTREAM_REF`（完整提交 SHA）、`CPA_UPSTREAM_IMAGE`（官方运行镜像摘要）、`CPA_VERSION` 并核对适配补丁可应用；验证完成后设置对应 `CPA_IMAGE` 成品名称，重建 CPA：

```sh
docker compose --env-file .env --env-file .env.cpa -f compose.yml up -d --build --wait cpa
```

edge 自动重新解析服务名。回退需要旧镜像以及匹配的配置、凭证、插件；仅换回镜像不保证旧版能读取新版写入的配置。原生动态库插件也必须匹配 CPU 架构、插件 ABI 和构建环境。

## 官方依据

- [CPA 固定版本配置](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.32/config.example.yaml)
- [CPA 固定版本 HTTP 路由](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.32/internal/api/server_routes.go)
- [CPA 镜像发布流程](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.32/.github/workflows/docker-image.yml)
- [logicc2api（Logicc 网页接口参考，MIT）](https://github.com/JamesZhaoY/logicc2api)
