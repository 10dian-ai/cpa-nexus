# 官方模型与订阅目录

CPA Nexus 的 CommandCode 模块使用 **GOAT** 及其他支持 Provider API 的订阅。官方网页提供订阅范围，公开 Provider API 提供准确的模型 ID、上下文长度及协议端点；两者分别保存，不使用模型名称或前缀推测权限。

## 数据来自哪里

| 来源 | 用途 | 自动检查周期 |
| --- | --- | --- |
| [公开 Provider 模型接口](https://api.commandcode.ai/provider/v1/models) | API 模型 ID、名称、上下文及 `supported_endpoints` | 5 分钟 |
| [官方模型页](https://commandcode.ai/models) | 网页目录、厂商、类别、官方最低套餐名称 | 15 分钟 |
| [Go](https://commandcode.ai/docs/plans/go)、[GOAT](https://commandcode.ai/docs/plans/goat)、[Pro](https://commandcode.ai/docs/plans/pro) | 网页内嵌 `planScope.modelIds` 的完整套餐范围 | 15 分钟 |
| [Max](https://commandcode.ai/docs/plans/max) | 官方明确的全模型范围及额外充值资格 | 15 分钟 |
| [定价与限额](https://commandcode.ai/docs/resources/pricing-limits) | 实际套餐表格、每个模型的 `planAllowanceUsd` | 15 分钟 |
| [Provider 文档](https://commandcode.ai/docs/provider) | 各套餐 API 接入资格及明确的特殊协议调用示例 | 15 分钟 |

这是定时同步的官方信息，不是官方推送服务：API 目录正常情况下最多约 5 分钟延迟，套餐网页最多约 15 分钟延迟。后台可以手动刷新；每个来源有 30 秒最小刷新间隔，避免连续点击造成重复抓取。读取面板和处理模型请求都只读取本地快照，不在每次调用时访问官网。

每个来源保存成功检查时间、最近尝试时间、原始网址、ETag、Last-Modified 和错误。官网返回缓存验证头时使用条件请求；目前实测来源没有提供这些验证头，因此会正常重新下载。单个来源最多读取 2 MiB，整个响应读取限时 15 秒；抓取不发送任何账号 Cookie、API Key 或其他凭证。

## 信息的边界

`included` 表示订阅内的模型范围，`apiAccess` 表示该订阅是否能使用 Provider API，`allowanceUsd` 是公开套餐的模型额度，`paygEligible` 表示额外充值余额是否允许使用该模型。它们是不同事实。GOAT 支持 API 不等于 GOAT 包含官网全部模型；某模型未包含在订阅内，也不等于已充值账号一定不能调用。

页面没有完整提供 Team Pro 或 Enterprise 的逐模型范围时，保持 `included: null` 和 `scope: unknown`。没有明确资料的额度也保持 `null`，不从总额度相减或按等级推导。官方名称 `minPlanName` 保留为说明，不参与网关授权判断。

网页 ID 与 Provider ID 也可能不一致。2026-10-03 11:31（北京时间）的真实抓取中：

- 网页目录为 86 个 ID；Provider 返回 85 个 API ID。
- Go 完整范围为 53 个 ID，GOAT 为 63 个，Pro 为 77 个。
- 合并保留 87 个原始 ID；这不是 87 个独立模型产品，因为两处 Claude Haiku 4.5 使用不同 ID。
- 网页是 `claude-haiku-4-5`，Provider 是 `claude-haiku-4-5-20251001`。仅出现在 API 的别名，其 Go、GOAT、Pro 订阅范围保留未知，不靠名称合并。
- `typesafe/jev` 出现在网页目录中，但该次 Provider 列表没有提供其 API 元数据。官方 Provider 文档中的同一请求示例明确绑定 `model: typesafe/jev` 与 `/provider/v1/systemone`，因此保留 `apiCatalogListed: false`、`apiDocumented: true`，支持 `systemone`。列表中的模型仍是 85 个，加上这个有明确文档的特殊模型，已确认 API 支持为 86 个。

这些数字仅说明当次验证结果，运行时以最新成功快照为准。账号的真实套餐、实际模型响应、可用余额和耗尽状态仍来自账号 API 与调用结果，官方公共目录不会覆盖 `account_models` 或账号额度数据。

## 缓存与持久化

迁移 `006_official_catalog.sql` 创建三个独立的 PostgreSQL 表：

- `official_catalog_sources`：每个来源的最后一次有效解析资料及抓取状态。
- `official_catalog_state`：面板和网关使用的整合快照。
- `official_catalog_history`：最多保留 48 份内容不同的快照；时间变化或未修改的轮询不会额外增长历史。

进程内共享 5 秒读取缓存及同时发起的读取，Redis 保存 60 秒目录缓存及 120 秒同步锁。缓存过期会从 PostgreSQL 读取并回填；模型调用不会每次传输整份 Redis 目录。同一进程共享正在进行的同步，多个 Worker 使用同一个分布式锁。Redis 读取临时失败时，目录读取退回 PostgreSQL；Redis 恢复后重新使用缓存。后台同步需要 Redis 锁可用，Redis 故障期间继续保留持久快照。

网络错误、超时、空模型列表、缺失协议字段、网页结构变化或无效套餐范围都保留此前成功资料，并公开 `stale` 与 `error`。解析失败不会用空数组替换现有目录。Redis 和 PostgreSQL 的数据卷随整个部署持久化，重启后可以继续读取最后成功目录。

## 管理接口

这两个接口需要已经登录管理后台。

| 接口 | 行为 |
| --- | --- |
| `GET /api/official/catalog` | 读取本地目录，返回 `models`、`plans`、`sources`、`fetchedAt`、`lastAttemptAt`、`stale`、`error` |
| `POST /api/official/refresh` | 手动刷新到期或超过 30 秒保护间隔的来源，返回同一结构 |

`models[].supportedEndpoints` 为 `chat/completions`、`messages`、`responses`、`systemone` 中官方实际提供的值，不含开头的 `/`。`apiCatalogListed` 表示是否出现在真实公开 API 列表；`apiDocumented` 表示特殊端点是否有官方明确请求示例。`providerAvailable` 表示至少一个来源已明确提供协议。文档示例必须同时包含准确端点、模型 ID、有效请求，并能与官方目录 ID 对应；示例缺失或改变不会凭模型名称授予支持。每个 `planAccess` 的范围、API 资格、额度和充值资格分别提供 `source`、`apiSource`、`allowanceSource`、`paygSource`；在 `sources` 中可找到对应检查时间与错误。

`fetchedAt` 是各已成功来源中的最早成功检查时间，避免一次 API 更新让较早的网页信息看起来全都刚更新。`lastAttemptAt` 是最近尝试时间。某个必要来源未成功、超过检查周期加 30 秒或存在错误时，`stale` 为真。

Worker 每 60 秒调用 `syncOfficialCatalog()` 即可，函数内部按各来源周期控制抓取。`getOfficialCatalog()` 只读缓存和快照；`shouldRefresh(sources, now)` 可用于提前判断是否有来源到期。

网关调用 `getProviderModel(id)` 获取准确协议：已有准确的公开列表或官方文档支持时返回该模型；尚无该模型资料且公开列表从未成功加载时抛出 `OfficialCatalogUnavailableError`；完整公开列表已加载但没有该 ID 的协议支持时返回 `null`。瞬时官网故障后仍可使用上次有效的协议元数据，来源错误会显示在后台。这个函数不会发送 Cookie 或访问真实模型调用端点。

## 验证

真实公开官网片段保存在 `tests/fixtures/official-catalog`，用于检查 React Router 引用表、分段 Next.js RSC、模型协议、明确套餐范围、套餐未知值、API 别名差异和每模型额度。

`npm test -- tests/official-catalog.test.ts` 检查解析失败保留、无凭证条件请求、304、超时、响应大小、缓存回退、刷新频率及并发锁。完整项目验证仍使用 `npm run check`。
