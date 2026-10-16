# CPA Nexus 平台范围

确认日期：2026-10-16。

CPA Nexus 是以 CLIProxyAPI（CPA）为内核的模块化 AI 管理平台，层级如下：

1. **平台**：管理员登录、模块开关、API Key 与调用分组、请求日志、外调服务 API。
2. **CPA 内核（一级）**：统一模型入口，负责原生渠道、凭证、OAuth、配额、插件，以及**全部** CPA 配置写入。
3. **酒馆内核（二级）**：可选的预设处理，按服务分组叠加。
4. **模块**：账号池模块，目前是 Logicc，经内核的桥接渠道接入。

CommandCode 模块已移除（迁移 021）。原嵌入式 Devin 模块在迁移 019 已经移除；CPA 原生的 Devin 提供器属于内核，保持不变。

## 模块契约

模块在 `shared/modules.ts` 注册稳定 ID、名称、版本、能力和导航。平台和 CPA 内核是必需模块，其余可以停用。停用只影响新的模型请求、新导入和新的后台任务，进行中的请求和任务照常完成，账号数据和管理页面保留。模块状态写入 PostgreSQL，各进程最迟 2 秒内看到变化。

账号池模块实现 `server/modules/contract.ts` 中的 `PoolModule`：

| 方法 | 用途 |
|---|---|
| `health()` | 模块管理页显示的状态 |
| `servingModels()` | 当前可提供的模型，由内核发布到桥接渠道 |
| `handleBridgeChat()` | 处理 CPA 回调的 Chat Completions 请求 |
| `reconcileBridge()` | 向内核层声明桥接渠道，路径和模型 |

加号能力实现 `server/lib/intake/contract.ts` 中的 `IntakeHandler`：描述接受的格式、离线解析、Worker 逐条处理、不含凭据的账号列表和池子计数。CPA 内核的加号处理器在内核层（`server/lib/cpa/intake.ts`），模块的处理器在各自目录。

新模块只需要注册 manifest、`PoolModule` 和 `IntakeHandler`。分组、路由、预设、计费观察、日志、外调 API、加号页面和后台导入对话框会自动适用。

## 内核权限边界

- **只有内核层（`server/lib/cpa/`）可以写 CPA 配置。** 模块只声明自己需要什么，不持有管理密钥，也不调用 CPA 配置接口。
- 内核写入 `config/api-keys` 时，统一使用事务锁 `withKernelConfigLock` 串行执行；桥接渠道只改动以 `nexus-` 开头、属于本平台的渠道。
- 桥接渠道密钥由内核生成；回调还必须带上路由器签名的分组请求头，客户端无法伪造。

## 统一入口

`/v1`、`/v1beta` 上的 `ccm_` 模型 Key：
1. 解析 Key 的分组和多分组策略；
2. 按「分组 × 来源」排出尝试顺序：组内先尝试模块，再按名称匹配度尝试 CPA 来源；
3. 每次尝试使用服务分组的酒馆预设，CPA 原生 Devin 来源额外做思考参数转换；
4. 遇到凭据、权限、限流、上游错误或模块主动让出（`nexus_source_unsupported`）时，换下一个来源或分组。

历史 CPA 客户端 Key、原生 WebSocket 等保持原生通路。

## 外调服务

外调服务 Key（`ccm_service_`）是平台级凭据，按模块授权加号范围，详见[外调服务 API 与公网加号页](external-api.md)。

## 升级与验收

升级前先执行 `bash scripts/deploy.sh backup`。迁移 021 会删除 CommandCode 的账号、目录和日志，把 CommandCode 的默认分组原地改名为「Logicc」（ID 不变，原来使用这个分组的 Key 继续有效），并为外调 Key 加上模块范围。

交付检查包括：类型检查、单元测试与真实 HTTP 测试、隔离的 PostgreSQL / Redis 集成测试、生产构建、接入假 CPA 和假 Logicc 的端到端冒烟测试（加号页 → 导入 → 桥接注册 → /v1 调用 → 日志）。真实 Logicc 账号和 Linux Docker / 1Panel 部署的验收需要另行记录。
