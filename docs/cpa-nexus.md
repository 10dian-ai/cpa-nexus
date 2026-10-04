# CPA Nexus 内核、模块与部署

CPA Nexus 使用完整的官方 CLIProxyAPI 作为模型流量内核，CommandCode 是第一个业务模块。当前使用支持官方 API 的 GOAT 订阅：Cookie 用于官方账号查询和专用 API Key 管理；模型请求携带这个 Key，直接访问官方 Provider API。默认部署不再启动原来的网页协议适配器，也不需要服务器安装 Go 或 Node.js。

更新脚本构建本地应用并等待健康检查，随后重建边缘代理，使 Git 更新后的路由配置及文件挂载立即生效。数据库、Redis 卷、CPA 配置与既有管理员密码保留。

本文所有终端命令在 **Ubuntu 服务器的 SSH 终端** 中运行。1Panel 页面操作会单独注明。

## 服务与数据

```text
统一域名 → edge → app（面板、账号管理、CPA 管理适配）
               → CPA（原生模型流量）
                   → CommandCode 模块 app:3000/v1
                       → 官方 api.commandcode.ai/provider/v1

worker → 官方账号/订阅/额度查询和后台任务
app + worker → PostgreSQL（真实业务记录）+ Redis（队列、租约和缓存）
```

| 服务 | 用途 | 数据是否持久保存 |
|---|---|---|
| `cpa` | 完整官方内核加可重放分组适配，源码/运行镜像固定 | `.runtime/cpa/` 保存配置、凭证、插件及日志 |
| `app` | 统一面板、账号池、管理和模块 API | 业务记录在 PostgreSQL |
| `worker` | Cookie 保活、官方账号与额度同步、自动恢复、队列任务 | 队列在 Redis，任务及账号结果在 PostgreSQL |
| `postgres` | 账号、加密 Cookie、真实额度快照、密钥、日志与模块设置 | 原有 `postgres-data` 命名卷 |
| `redis` | 任务队列、并发租约、会话亲和、短期缓存 | 原有 `redis-data` 命名卷；启用 AOF |
| `edge` | 单一 HTTP 入口，分流面板与模型请求 | 使用仓库中的 Nginx 配置 |

PostgreSQL 是业务数据的依据，Redis 承担多个进程共享的调度状态。缓存不替代官方数据源，真实额度也不从其他套餐或计数相减得到。六个服务都有独立健康检查；Worker 检查 Redis 心跳，避免进程存在而任务已停仍显示健康。

CPA 原生渠道由 CPA 选号；CommandCode 按官方 Chat / Messages 协议提供两个入口，池内部仍由同一个模块选号、原子占用和释放租约。每个入口是整个账号池，CPA 不会对池内账号重复选号。`core/` 源码保留为历史参考，不参加默认启动或调用；旧 `.env` 的 `KERNEL_URL` 可以保留，新的官方 API 通路不读取它。

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

外层 OpenResty 与内部 edge 都需要允许流式输出和客户端取消。这里的入口代理用于 HTTPS 与流量分流；CommandCode 模型调用直接访问官方 API，已经不走旧 GO 网页反代。

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

## 官方 API、模型与密钥

导入 Cookie 后模块查询官方账号、订阅和额度，并获取或管理专用 API Key。推理携带 Bearer Key，不携带 Cookie。官网套餐说明与实际 API 模型权限分别获取和核对，不能只凭套餐名称假定授权；获取失败也不能解释为空模型或覆盖最后成功的结果。

| 配置或密钥 | 用途 |
|---|---|
| `COMMANDCODE_API_URL` | 默认 `https://api.commandcode.ai/provider/v1`，官方推理地址 |
| `COMMANDCODE_MANAGEMENT_URL` | 默认 `https://api.commandcode.ai`，官方账号管理地址 |
| `CPA_MANAGEMENT_KEY` | 仅后台调用 CPA 管理接口，不能给模型客户端 |
| `CPA_CLIENT_KEY` | 平台调用 CPA 的内部凭证；保留在 CPA 的 access/api-keys 配置中 |
| 统一模型 API Key | `ccm_` 前缀，选择一个或多个分组，跨 CPA 和 CommandCode 调用组内来源 |
| CommandCode 桥接 Key | CPA 到模块的内部 `ccm_nexus_` Key，由模块接入建立，普通 Key 列表隐藏并禁止修改 |
| 原有 `ccm_` Key | 原默认组升级为 CPA、CommandCode 两组的并集，保留自定义组、原客户端 Key 与调用地址 |
| 外调服务 API Key | `ccm_service_` 前缀，专用于 CommandCode 的 `/api/external/*`，与模型 Key 独立验证 |
| 历史 CPA 客户端 Key | 保留原生兼容调用，在统一页面的历史密钥区管理，不参与按 Key 的预设路由 |
| `CPA_URL` | 生产容器内 `http://cpa:8317` |
| `CPA_COMMANDCODE_BASE_URL` | 生产容器内 `http://app:3000/v1` |

面板接入模块后建立内部桥接 Key，并向 CPA 注册兼容上游；模型别名带 `commandcode/`。官方目录和账号权限刷新后，模块更新可用模型；模型只能使用官方声明支持的 endpoint。

客户端统一进入 **API Key → 创建 API Key**，模型类型选择一个或多个调用分组，不再选择单一模块。同一 Key 可调用所选分组中 CPA 和 CommandCode 的模型；来源账号也可绑定多个分组，选号与重试仅使用共同的已启用分组。CommandCode 开启时提供 **外调服务 API Key** 类型；停用后只暂停该模块来源与外调接口，CPA 来源继续可用。现有 Key 和数据保留。

历史 CPA 客户端 Key 可逐个迁移为模型 Key 并选择对应来源分组。迁移后仅撤销对应日常客户端旧 Key；`CPA_CLIENT_KEY` 仍用于内部转发。历史密钥节点的列表响应用 `x-nexus-reserved-key-index` 标记该内部凭证，保存或删除整个历史列表时平台会保留它。高级完整 JSON/YAML 配置编辑仍需保留这一凭证。

官方 Provider 模型目录每 5 分钟刷新，官网套餐说明每 15 分钟刷新；记录来源、成功获取时间及刷新失败状态。面板可通过 `GET /api/official/catalog` 查询，通过 `POST /api/official/refresh` 手动更新，这两个接口要求管理员登录。具体套餐依据和刷新规则见 [官方目录说明](official-catalog.md)。

## 入口与原有端点

| 公网路径 | 处理服务 | 权限 |
|---|---|---|
| `/api/accounts`、`/api/accounts/import`、`/api/accounts/actions`、`/api/accounts/:id` | app，原账号查询、导入、操作及详情 | 管理员登录 |
| `/api/jobs/:id`、`/api/keys/*`、`/api/service-keys/*` | app，任务与两种 Key 管理 | 管理员登录 |
| `POST /api/external/accounts` | app，原外调账号添加/批量导入入口 | 独立服务 Key |
| `/api/external/accounts`、`/api/external/accounts/:id`、`/api/external/jobs/:id`、`/api/external/pool` | app，外调账号、任务与池信息 | 独立服务 Key |
| `/api/cpa/*`、`/api/modules/*`、其余平台 `/api/*` | app，平台与 CPA 管理适配 | 管理员登录 |
| `/v1/models`、`/v1/chat/completions`、`/v1/messages`、`/v1/responses` | app 按 Key 分组分流及可选预设 → CPA → 原生账号或模块 | 统一模型 `ccm_` Key；历史 CPA 客户端 Key 保留兼容 |
| `/commandcode/v1/*` | app 模块兼容入口，验证来源分组后通过 CPA 转换格式 | 拥有 CommandCode 来源分组的 `ccm_` Key |
| `/v1/systemone`、`/cpa-api/v1/systemone` | app，官方 System One 专门入口；CPA 未实现该协议 | 拥有 CommandCode 来源分组的 `ccm_` Key |
| 标准 HTTP `/openai/v1/`、`/cpa-api/v1/` 下的 models、chat/completions、messages、responses | app，使用相同的统一模型适配入口 | 统一模型 Key 或历史 CPA 客户端 Key |
| 其余 `/v1/*`、`/v1beta/*`、`/openai/v1/*`、`/backend-api/codex/*`、`/api/provider/*`、`/cpa-api/*`，以及原生 WebSocket | CPA 原生模型协议；`/cpa-api/` 移除前缀 | 历史 CPA 客户端 Key；统一 `ccm_` Key 尚不适用于这些协议 |

所有统一模型 Key 使用同一个 `https://你的域名/v1` Base URL，由 Key 与账号的共同分组决定可用来源。迁移 013 将已有平台模型 Key 转为跨模块选择，内部桥接 Key 保持专用。`/commandcode/v1` 继续兼容原客户端，受相同的分组过滤约束。CommandCode 停用不阻断 CPA 来源。具体操作及协议边界见 [分组说明](groups.md)。

酒馆预设是默认关闭的可选处理模块，在酒馆页面选择模型 API Key 后绑定预设。例如 KA 保持直连，KB 选择经过酒馆模块并叠加全部已开启预设，使用 KB 的 Chat/Messages/Responses 请求才应用该预设。上游账号选择不影响这一规则；原有账号/模块预设记录保留，但统一 Key 不继承旧路由。完整操作和协议边界见 [预设模块](presets.md)。

入口支持 SSE、WebSocket、长连接和断开取消，上传、预设及模型请求体不设人为大小上限。CPA 管理 API、`management.html`、原生管理资源和 `/cpa-api/` 下的配置、凭证、插件及日志文件禁止公网直连；面板通过登录后的后台适配器访问管理接口。

固定版本的 OAuth 回调 `/anthropic/callback`、`/codex/callback`、`/antigravity/callback`、`/devin/callback`、`/callback` 转发至 CPA。部分供应商需要本机回调或 SSH 转发；WebRTC 中继、mDNS 和额外监听端口也需要单独网络部署及真实客户端验收，默认不发布这些额外端口。

## 开发与 CPA 升级

仅本机开发需要宿主 Node.js/npm。开发基础服务无旧 kernel，只在回环地址发布 PostgreSQL、Redis 和 CPA：

```sh
docker compose --env-file .env --env-file .env.cpa -f compose.yml -f compose.dev.yml up -d postgres redis cpa
```

本机 Nuxt 加载两份 env 文件。CPA 访问宿主 Nuxt 时，把 `.env.cpa` 的桥接地址改为 `http://host.docker.internal:3000/v1`，监听容器可达的接口，重启后刷新桥接。Linux 开发需配置 `host-gateway`。不要同时启动生产 app/edge 占用开发端口；生产会覆盖为容器内部地址。

Nexus 完整插件内核使用官方 v8.0.11 源码与运行镜像，保留原始 C ABI、全部路由和插件执行能力；`Dockerfile.cpa` 在固定提交上应用 `ops/cpa-nexus/nexus-plugins.patch`。适配增加真实插件能力发现和请求内分组校验，插件仍能改模型别名、调度或嵌套调用，最终账号选择始终限制在服务器授权集合内。成品镜像为 `cpa-nexus-core:v8.0.11-nexus1`。

官方运行镜像的固定多架构摘要：

```text
eceasy/cli-proxy-api:v8.0.11@sha256:1d7f8c154a9804ba33c5332bf76cdb3a05791d6fd275ccad8f2a63859ab25df9
```

CPA 升级先在独立候选环境使用数据库、配置和凭证副本验证，不能让候选 Worker 消费生产队列。核对管理 API、配置、插件 ABI、渠道/OAuth、工具多轮、流式、WebSocket、取消释放及账号池后，更新 `.env.cpa` 中 `CPA_UPSTREAM_REF`（完整提交 SHA）、`CPA_UPSTREAM_IMAGE`（官方运行镜像摘要）、`CPA_VERSION` 并核对适配补丁可应用；验证完成后设置对应 `CPA_IMAGE` 成品名称，重建 CPA：

```sh
docker compose --env-file .env --env-file .env.cpa -f compose.yml up -d --build --wait cpa
```

edge 自动重新解析服务名。回退需要旧镜像以及匹配的配置、凭证、插件；仅换回镜像不保证旧版能读取新版写入的配置。原生动态库插件也必须匹配 CPU 架构、插件 ABI 和构建环境。

## 官方依据

- [CPA 固定版本配置](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.11/config.example.yaml)
- [CPA 固定版本 HTTP 路由](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.11/internal/api/server_routes.go)
- [CPA 镜像发布流程](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.11/.github/workflows/docker-image.yml)
- [CommandCode 官方](https://commandcode.ai/)
- [GOAT 官方套餐说明](https://commandcode.ai/docs/plans/goat)
- [CommandCode 官方 Provider API](https://commandcode.ai/docs/provider)
- [官方价格及限制](https://commandcode.ai/docs/resources/pricing-limits)
