# 账号与 API Key 分组

在「账号分组」创建分组，为账号和模型 API Key 各选择一个或多个分组。模型 Key 不需要选择来源模块：它可以调用这些分组中已启用账号提供的模型。CommandCode 外调管理 Key 继续使用原来的外调接口。

例如，CommandCode 账号 A 只属于「工作」，账号 B 只属于「个人」。Key A 只选「工作」，Key B 只选「个人」，即使两个账号提供同名模型，两个 Key 也分别使用自己的账号。Key 选择两个分组时，可用来源取这两个分组的并集；账号加入多个分组时，可供这些分组的 Key 使用。

## 设置与迁移

- 已有模型 Key 和 CommandCode 账号迁入「默认」分组；首次发现的 CPA 来源也加入默认分组，保留原有可用行为。
- 为需要隔离的来源改选专用分组，并让对应 Key 选择该分组。保留默认组会继续让默认组的 Key 使用该来源。
- 分组停用后，其授权不参与模型目录或调用。账号、Key 自身停用同样不参与调度。
- 模型目录只显示当前 Key 的分组可用模型。Key 手动请求其他组的来源前缀也会被拒绝，不因同名模型自动越过分组。
- 酒馆开关与分组独立：选择经过酒馆的模型 Key，先使用自己的组内来源，再按顺序叠加已开启的预设。

两个模块同时提供相同模型 ID 时，当前入口优先使用有可用组内账号的 CommandCode 官方 Provider ID；否则匹配组内 CPA 来源。需要明确指定 CPA 来源时，可以使用该来源允许的原始前缀模型名。多个组内 CPA 来源同名时轮换，所有选择均不越过授权分组。

## CPA 来源与原生功能

CPA 使用完整官方 v8.0.11，OAuth、刷新、配额、协议转换、模型别名和流式响应继续由内核执行。分组按实际来源隔离：OAuth 凭据文件、原生配置中的每个上游 Key 都有稳定来源身份。Google 一个文件中的多个虚拟项目账号共享该来源的分组；项目模型目录取实际运行时账号模型的并集。

平台在保存来源分组或首次选择该来源调用时，为其准备独占的 CPA 模型前缀。已有独占前缀会复用；多个来源共用的前缀会拆开。页面显示实际前缀，使用旧共用前缀的原生客户端需要相应调整。`force-model-prefix=false` 时，原生裸模型名字仍按官方行为保留。平台模型 Key 可以继续请求通常的裸模型名字，服务器把它映射到选定来源的独占前缀，不要求客户端填写内部前缀。

调用前核验来源实际注册的模型以及其他来源是否共用该路由。CPA 重试只针对这个独占来源的凭据，不会使用组外账号；同一来源展开的虚拟账号仍由内核调度。同名模型可在允许的来源之间轮换，但选定来源失败后不退回不带来源前缀的全局模型池。

无持久化来源的纯内存／插件账号、重复且无法唯一识别的配置账号，会显示不可独立分组的原因。插件可能改写模型路由，而固定内核的插件发现 API 不公布全部路由能力，因此目前分组调用支持已核验的官方 `gemini-cli` **1.0.5** 以及没有启用其他插件的内核；启用尚未适配的插件时，分组请求明确拒绝，原生管理与客户端功能继续保留。Home 外部调度模式隐藏本地管理接口，无法核验本地来源时不会绕过分组。

「CPA 原生客户端 Key」保留官方完整行为，不自动套用 Nexus 分组。需要账号隔离的客户端应创建平台「模型 API Key」。后台显示这一差别，避免把原生 Key 误认为经过平台分组管控。

来源删除或暂时未注册时，原分组绑定会保留，并在页面标记来源状态。确认来源已经删除后，可手动清理绑定；临时停用来源的分组授权不会自动丢失。仍有账号或 Key 绑定的分组不能删除，默认组不能删除。

## 管理 API

以下接口使用管理员登录会话及现有同源检查：

| 方法与路径 | 功能 |
| --- | --- |
| `GET /api/groups` | 分组名称、状态及账号／Key 数量 |
| `POST /api/groups` | 创建：`name`、可选 `description`、`enabled` |
| `PATCH /api/groups/:id` | 编辑分组名称、描述或开关 |
| `DELETE /api/groups/:id` | 删除未绑定的非默认分组 |
| `GET /api/groups/accounts?moduleId=cpa` | 来源与已绑定分组；也可选 `commandcode` 或不传 |
| `PATCH /api/groups/accounts` | 设置来源组：`moduleId`、`sourceType`、`sourceId`、`groupIds` |
| `DELETE /api/groups/accounts` | 清理已确认不存在的来源绑定，参数同来源标识 |

模型 Key 创建接口支持 `groupIds`，不传时选择默认组；编辑时不传则保留原分组。`groupIds` 至少一个，重复 ID 去重；停用组可保留绑定但不会赋予调用能力。原生配置及凭据内容不在分组库存响应中暴露。

官方行为依据：[CPA v8.0.11 来源模型选择](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.11/sdk/cliproxy/auth/conductor_selection.go)、[来源模型前缀转换](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.11/sdk/cliproxy/auth/conductor_models.go)、[Google 提供器 v1.0.5 能力注册](https://github.com/router-for-me/cpa-plugin-gemini-cli/blob/v1.0.5/internal/plugin/plugin.go)。分组的多来源授权行为参考 [New API 分组文档](https://docs.newapi.pro/zh/docs/guide/feature-guide/admin/group)、[渠道选择源码](https://github.com/QuantumNous/new-api/blob/main/service/channel_select.go)，实现使用本项目的 Postgres 数据与 CPA 官方前缀机制。
