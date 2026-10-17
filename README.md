# CPA Nexus · CPA 中枢

以 CLIProxyAPI（CPA）为内核的模块化 AI 管理平台。CPA 负责全部模型流量和自己的配置；酒馆预设是可选的二级处理；Logicc 等账号池模块只通过内核创建的桥接渠道接入，没有权限改写 CPA。

## 功能

- **CPA 内核**：配置、凭证与 OAuth、渠道与模型、配额、日志与用量、原生插件与插件商店、原版完整控制台。
- **统一 API Key**：模型 Key 选择一个或多个调用分组，可以跨 CPA 原生来源和 Logicc 号池调用，支持按顺序自动切换或混合轮换，失败自动换来源。新建的 Key 默认带上 CPA 和 Logicc 两个分组。
- **酒馆预设（可选）**：JSON 预设的导入、编辑和导出，按服务分组叠加，叠加后多出的 token 计入该次请求的 usage。
- **Logicc 模块**：Logicc 网页账号池。支持 `__client`、Session JWT 或邮箱密码导入；会话失效时用邮箱密码正常登录自动续期（遇到人机验证会停下等人工，绝不绕过）。按分组隔离、按并发调度、自动冷却；工具调用通过提示词模拟；usage 在本地计算，只多不少。详见 [Logicc 模块](docs/logicc-module.md)。
- **外调服务 API 与公网加号页**：外调 Key 按模块授权，可以远程给 CPA 内核（凭证文件、Vertex 服务账号、各家 API Key）和 Logicc 加号；服务器 3041 端口提供图形化加号页面。详见 [外调服务 API](docs/external-api.md)。
- PostgreSQL 保存持久数据，Redis 负责队列、租约、会话缓存和限流；请求头隐私策略见 [请求头隐私](docs/request-header-privacy.md)。

## Ubuntu / 1Panel 部署

服务器只需要 Docker 和 Compose。在项目目录执行：

```sh
bash scripts/deploy.sh up
```

脚本用一次性的 Node 容器初始化配置，然后构建并启动，宿主机不需要安装 Node。已有的 `.env`、加密密钥、配置和数据都不会被覆盖。部署固定 CPA 版本，不会自动替换内核。

- 管理后台：`127.0.0.1:${APP_PORT:-3000}`，只绑定本机，需要通过 1Panel 反代访问。正式使用域名前，先配置 HTTPS 的 `APP_URL`。
- 公网加号页：`${INTAKE_BIND_ADDRESS:-0.0.0.0}:${INTAKE_PORT:-3041}`。这个端口上只有加号页和外调 API，没有管理后台；建议也用 1Panel 反代加上 HTTPS。

管理员用户名和密码在 `.env` 里。`.env.cpa` 中的 `CPA_CLIENT_KEY` 是平台调用 CPA 用的内部凭证，必须保留在内核访问密钥配置中。

首次使用：
1. 确认 CPA 内核已连接，导入 CPA 凭证或在 3041 页面加号；
2. 导入 Logicc 账号；
3. 在 **API Key** 页面创建模型 Key（默认带上 CPA 和 Logicc 分组），客户端使用 `/v1` 和原模型名调用。

[部署、1Panel 网络、备份恢复与升级](docs/cpa-nexus.md)

常用操作：

```sh
bash scripts/deploy.sh status
bash scripts/deploy.sh logs
bash scripts/deploy.sh update
bash scripts/deploy.sh backup
bash scripts/deploy.sh stop
```

**从含 CommandCode 的版本升级**：先执行 `bash scripts/deploy.sh backup`，再执行 `update`。迁移 021 会删除 CommandCode 的账号、目录和日志，把原 CommandCode 默认分组原地改名为「Logicc」（原来使用这个分组的 Key 继续有效），并给现有外调 Key 授予全部模块的加号权限。CPA 原生凭证、分组、预设和历史日志不受影响。

## 调用入口

| 地址 | 密钥 | 用途 |
|---|---|---|
| `/v1`、`/v1beta` | 统一模型 API Key（`ccm_` 前缀） | 按 Key 与来源的共同分组路由，跨 CPA 与 Logicc，失败自动切换 |
| `/v1`、`/v1beta` | 历史 CPA 客户端 Key | 原生直通 CPA |
| `/api/external/*`（3000 或 3041） | 外调服务 Key（`ccm_service_` 前缀） | 给有权限的模块加号、查询任务和池子状态 |

模型列表只显示模型原名，调用时由 CPAN 换成来源的真实名称：CPA 的 Devin 来源会转换思考参数，Logicc 来源经 `logicc/<模型>` 桥接渠道调用。

[模块契约与内核权限边界](docs/platform-requirements.md) · [账号与 Key 分组](docs/groups.md) · [酒馆预设](docs/presets.md) · [CPA 原生功能与完整控制台](docs/cpa-native.md)

## 本机开发与验证

```sh
npm ci
npm run setup
docker compose --env-file .env --env-file .env.cpa -f compose.yml -f compose.dev.yml up -d postgres redis cpa
npm run db:migrate
npm run dev
```

在另一个终端执行 `npm run dev:worker`。本机 CPA 回调桥接用的地址由 `NEXUS_BRIDGE_BASE_URL` 指定（例如 `http://host.docker.internal:3000`）。

```sh
npm run check
```

设置 `TEST_DATABASE_URL` 和 `TEST_REDIS_URL` 后，会启用使用随机 schema 和随机前缀的集成测试；设置 `TEST_CPA_BINARY`、`TEST_NGINX_BINARY` 可以增加真实内核和入口的验证。

## 备份与边界

PostgreSQL、Redis、`.env`、`.env.cpa` 和 `.runtime/cpa/` 要一起备份，并保留 `APP_ENCRYPTION_KEY`（Logicc 凭据和桥接密钥都用它加密）。CPA 的候选更新要先验证接口、协议、插件和模块，再切换到生产；配置和凭证必须与回退版本匹配。

用本地模拟上游做的验证，不能替代真实供应商账号的验收。Logicc 的网页接口不是公开 API，可能随时变化；它的使用条款由账号所有者自行确认。

## 上游许可

CLIProxyAPI 遵循其上游许可。`ops/cpa-nexus/UPSTREAM-LICENSE` 保留了当前完整 CPA 内核的 MIT 声明，源码的固定版本和增量适配见 `Dockerfile.cpa`。Logicc 模块的提示词拍平与工具解析参考了 logicc2api（MIT）。
