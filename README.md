# CPA Nexus · CPA 中枢

基于 CLIProxyAPI 的模块化 AI 管理平台。独立 CPA 处理统一模型流量，CommandCode 模块通过 Cookie 管理账号、获取专用 API Key，并直接调用 GOAT 官方 Provider API。

## 功能

- CPA 配置、凭证与 OAuth、渠道与模型、日志与用量、原生插件。
- CPA 原版完整控制台、独立 OAuth 与供应商配额中心、Google 官方提供器和完整插件页面。
- 统一 API Key 页面：模型 Key 绑定 CPA 或 CommandCode，按 Key 启停、撤销和选择预设；CommandCode 开启后可创建外调服务 Key。
- GOAT 账号池：批量导入、保活、真实额度、自动恢复、并发租约、会话亲和和调用日志。
- 官方模型与套餐目录：准确模型 ID、原生协议、包含范围、来源和检查时间；未知资料保留未知。
- 原加账号、外调、任务、账号、密钥、日志与设置接口保留。
- 可选酒馆 JSON 预设：提示词/参数编辑，为不同模型 API Key 选择直连或预设处理。
- PostgreSQL 持久数据与官网快照，Redis 队列、并发、会话和缓存。

## Ubuntu / 1Panel 部署

服务器只需 Docker 与 Compose，在项目目录执行：

```sh
bash scripts/deploy.sh up
```

脚本使用一次性 Node 容器初始化配置并构建启动，无需宿主机安装 Node。已有 `.env`、加密密钥、配置及数据不会覆盖。部署固定 CPA 版本，不自动替换内核。

管理员用户名与密码位于 `.env`；`.env.cpa` 的 `CPA_CLIENT_KEY` 用于平台内部调用 CPA，应保留在内核访问密钥配置中。日常客户端 Key 在面板 **API Key** 页面创建。默认只绑定主机 `127.0.0.1:3000`。正式域名部署前配置 HTTPS `APP_URL`。

首次登录：导入 GOAT Cookie → 查看账号同步 → 在官方目录确认更新 → 在模块管理接入 CommandCode → 在 **API Key** 创建绑定 CommandCode 的模型 Key → 客户端使用 `/v1` 和原模型 ID。调用 CPA 原生渠道时，在同一页面创建绑定 CPA 的模型 Key。

[详细部署、1Panel 网络、备份恢复与升级说明](docs/cpa-nexus.md)。

常用操作：

```sh
bash scripts/deploy.sh status
bash scripts/deploy.sh logs
bash scripts/deploy.sh update
bash scripts/deploy.sh backup
bash scripts/deploy.sh stop
```

## 调用入口

| 地址 | 密钥 | 用途 |
|---|---|---|
| `/v1` | 统一模型 API Key，`ccm_` 前缀 | 按 Key 与来源账号的共同分组转发，可跨 CPA 和 CommandCode 来源调用 |
| `/commandcode/v1` | 拥有 CommandCode 账号所属分组的 `ccm_` Key | 保留独立模块入口和旧客户端格式、日志与会话归属 |
| `/v1/systemone` 或 `/commandcode/v1/systemone` | 拥有 CommandCode 账号所属分组的 `ccm_` Key | 官方决策模型专用接口 |
| `/api/external/accounts` 等 | `ccm_service_` Key | 加账号、账号查询、任务与池状态 |

Anthropic 模型使用官方 Messages，其他模型按官方 `supported_endpoints` 调用。Cookie 仅用于管理，推理只发送选定账号的正常 API Key。旧 `commandcode-proxy` 不再是默认部署或构建依赖，原始快照保留为历史材料。

模型 Key 选择一个或多个分组，不再选择单一模块。账号来源也可以属于多个分组，只有 Key 与来源存在共同的已启用分组才可调用，模型列表与重试遵守相同权限。升级时存量账号和 Key 进入默认组；将账号与 Key 改为各自独立的分组即可分流。历史 CPA 客户端 Key 继续原生兼容，不参与平台分组和酒馆处理；可迁移日常调用到统一分组 Key，同时保留内部 `CPA_CLIENT_KEY`。原生 WebSocket 和非 Chat/Messages/Responses 协议继续使用历史 CPA 客户端 Key。

## 官方目录与缓存

Worker 自动检查：API 目录每 5 分钟、官网每 15 分钟。面板每分钟读取后台缓存，也可手动刷新。抓取失败保留有效快照并显示错误；网站与 API 的不同 ID 不按名字合并。

模型 API 实际观察与官网套餐包含范围分开保存。旧 Go 反代观察留作历史，不算作官方 API 权限；套餐改变后重新观察。套餐外模型是否可用还取决于充值、账号和官方实际响应。

官网快照保存在 PostgreSQL，Redis 缓存 60 秒，进程缓存 5 秒；同一同步使用分布式锁、条件请求与有界超时，不为每个账号重复抓取。

[目录与数据语义](docs/official-catalog.md) · [外调 API](docs/external-api.md) · [模块契约](docs/platform-requirements.md) · [账号与 Key 分组](docs/groups.md) · [酒馆预设与 API Key 路由](docs/presets.md)。

[CPA 原生功能与完整控制台](docs/cpa-native.md) 列出原版 OAuth、配额、插件、原生密钥及高级管理入口。

酒馆预设模块默认关闭，支持导入/编辑/导出 JSON。模型 Key 可选择是否经过酒馆模块：启用后按顺序叠加全部已开启预设；分组继续约束可用账号。System One 保持原通路。

## 本机开发与验证

```sh
npm ci
npm run setup
docker compose --env-file .env --env-file .env.cpa -f compose.yml -f compose.dev.yml up -d postgres redis cpa
npm run db:migrate
npm run dev
```

另一个终端执行 `npm run dev:worker`。本机 CPA 到 Nuxt 的桥接地址配置见部署文档。

```sh
npm run check
```

设置 `TEST_DATABASE_URL`、`TEST_REDIS_URL` 启用随机 schema 和前缀的集成测试；设置 `TEST_CPA_BINARY`、`TEST_NGINX_BINARY` 可增加实际内核与入口验证。记录见 [开发记录](docs/development-status.md)。

## 备份与边界

一起备份 PostgreSQL、Redis、`.env`、`.env.cpa` 和 `.runtime/cpa/`，保留 `APP_ENCRYPTION_KEY`。候选 CPA 更新先验证接口、协议、插件和模块，再切换生产；配置与凭证必须匹配回退版本。

本地模拟上游验证不等于真实供应商账号验收。高级网络能力、生产 Linux / 1Panel 和真实 OAuth 按部署环境验证。原版完整控制台支持插件资源、子资源和管理扩展的管理员会话代理，无需手写资源清单。

## 上游许可

CLIProxyAPI 与历史 CommandCode 适配器分别遵循上游许可。`reference/commandcode-proxy-6217305` 保留 MIT 版权声明；当前官方 API 接入不运行该私有协议适配器。
