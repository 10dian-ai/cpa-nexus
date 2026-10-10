# 账号与 API Key 分组

在「账号分组」创建分组，为账号和模型 API Key 各选择一个或多个分组。模型 Key 不需要选择来源模块：它可以调用这些分组中已启用账号提供的模型。Devin 账号必须加入 Devin 分组后才会参与 `devin/` 模型路由。CommandCode 外调管理 Key 继续使用原来的外调接口。

例如，CommandCode 账号 A 只属于「工作」，账号 B 只属于「个人」。Key A 只选「工作」，Key B 只选「个人」，即使两个账号提供同名模型，两个 Key 也分别使用自己的账号。Key 选择两个分组时，可用来源取这两个分组的并集；账号加入多个分组时，可供这些分组的 Key 使用。

## 面板操作

1. 在「调用分组」点击「创建分组」，也可在 CPA 凭证的分组编辑弹窗中直接新建。
2. 在「CPA 内核 → 凭证管理」的「调用分组」列点击「编辑分组」，选择一个或多个组并保存；同一文件展开的虚拟凭证共享来源分组。
3. 侧栏中「CPA 内核 → 凭证分组」「CommandCode 模块 → 账号分组」和「Devin 模块 → 账号分组」分别显示所属模块的来源。
4. 在 API Key 页面选择相同组：只选 CommandCode 调用该组账号，只选 CPA 调用该组凭证；同时选择可跨模块调用。

使用 Basis Points 等独立执行器时，插件来源和它需要读取的底层账号凭证应加入该 Key 所选分组。账号凭证内容不会因修改分组而改变。

## 设置与迁移

- CommandCode、CPA 和 Devin 分别使用「CommandCode」「CPA」「Devin」三个模块默认调用组；新账号和首次发现的来源默认加入各自模块的组。
- 升级时，只把原「默认分组」的账号绑定替换为对应模块组，保留其他自定义组。原模型 Key 的「默认分组」替换为 CPA 与 CommandCode 两个模块组的并集，保留升级前的调用范围和其他自定义组；Devin 组不会自动加入已有或新建 Key，必须显式选择；私有桥接 Key 不调整。
- 为需要隔离的来源改选专用分组，并让对应 Key 只选择所需分组。模型 Key 同时选择两个模块组时，可跨模块调用；只选 CommandCode 或 CPA 时使用对应组的来源。需要调用 Devin 时，把 Devin 分组显式加入模型 Key。
- 模块默认组记录按 ID 持久保存，可以改名，不因名称变化重新创建；模块默认组不能删除。其他自定义分组可以跨模块复用。
- 分组停用后，其授权不参与模型目录或调用。账号、Key 自身停用同样不参与调度。
- 模型目录只显示当前 Key 的分组可用模型。Key 手动请求其他组的来源前缀也会被拒绝，不因同名模型自动越过分组。
- 酒馆模块按分组管理：选择经过酒馆的模型 Key，先使用自己的组内来源，再按该 Key 所选启用分组的预设开关、顺序和覆盖配置叠加。没有分组覆盖时继承全局预设库；多个分组同时启用时按分组创建时间和 ID 合并，同一预设只取第一个分组的配置。

两个模块同时提供相同模型 ID 时，当前入口优先使用有可用组内账号的 CommandCode 官方 Provider ID；否则匹配组内 CPA 来源。需要明确指定 CPA 来源时，可以使用该来源允许的原始前缀模型名。多个组内 CPA 来源同名时轮换，所有选择均不越过授权分组。

### `devin/` 模型：CPA 原生 Devin 渠道与 Devin 模块

CPA 内核自带的 Devin 渠道（OAuth/凭证管理里的 `devin` 凭证）和 Devin 模块都使用 `devin/<模型>` 这个命名空间，两者互不依赖：

1. Key 绑定 Devin 模块（`devin2api`）时，所有请求都交给 Devin 模块。
2. `auto` Key 调用 `devin/` 模型时，只有 Devin 模块已启用，且 Key 的某个启用分组里有能提供该模型的 Devin 模块账号，才进入 Devin 模块，并使用命中分组的酒馆预设。
3. 其他情况（Devin 模块停用、Key 未选择 Devin 分组、绑定 CPA 的 Key）都留在 CPA 内核，由 CPA 原生 Devin 渠道按组内凭证执行。
4. Devin 模块目录暂时不可用、而 CPA 也没有这个模型时，返回 Devin 模块自己的错误，便于排查。

`POST /v1/messages/count_tokens` 也接受 `ccm_` 模型 Key：它与 `/v1/messages` 使用相同的组内 CPA 来源，不叠加预设、不记账；只由 Devin 模块或 CommandCode 提供的模型不支持计数，返回 404。

平台拒绝的请求按 HTTP 状态返回对应的错误类型（OpenAI 格式：`invalid_api_key`、`permission_denied`、`model_not_found`、`service_unavailable` 等；Anthropic 格式：`authentication_error`、`permission_error`、`not_found_error`、`overloaded_error` 等）。只有酒馆预设无法应用（HTTP 422）时才是 `preset_route_error`。

## CPA 来源与原生功能

CPA 使用完整官方 v8.0.15，OAuth、刷新、配额、协议转换、模型别名和流式响应继续由内核执行。分组按实际来源隔离：OAuth 凭据文件、原生配置中的每个上游 Key 都有稳定来源身份。Google 一个文件中的多个虚拟项目账号共享该来源的分组；项目模型目录取实际运行时账号模型的并集。

完整插件内核通过请求内授权集合限制真实账号与独立插件执行器。模型名保持原样交给原版路由/转换/调度插件；每次选号、重试和嵌套插件调用都继承同一集合，不再用单个预选来源前缀限制插件，也不按插件名称或版本白名单拒绝插件。OAuth 文件、配置 Key、运行时插件账号和无凭据独立插件执行器均可作为来源绑定分组。同文件的虚拟项目共享来源分组。

标准插件向 CPA 注册的账号可分别绑定分组。没有注册账号的独立执行器以 `plugin:<id>` 作为一个来源；如果插件把自己的多个上游 Key 隐藏在内部池里，只能整体分组，逐 Key 分流需要插件提供账号注册接口。CommandCode 账号由本模块逐账号管理，仍支持两个账号分别绑定不同组。

服务器在内部管理通道注册短期授权集合，客户端请求只附服务器签名的短引用；认证密钥、策略签名和全量账号 ID 不发到客户端或供应商。原版客户端未附策略时继续原行为。未安装适配或未配置内部策略密钥时，平台分组调用明确要求更新内核，不退回全账号池。

「CPA 原生客户端 Key」保留官方完整行为，不自动套用 Nexus 分组。需要账号隔离的客户端应创建平台「模型 API Key」。后台显示这一差别，避免把原生 Key 误认为经过平台分组管控。

来源删除或暂时未注册时，原分组绑定会保留，并在页面标记来源状态。确认来源已经删除后，可手动清理绑定；临时停用来源的分组授权不会自动丢失。仍有账号或 Key 绑定的分组不能删除，默认组和模块默认调用组不能删除。

## 管理 API

以下接口使用管理员登录会话及现有同源检查：

| 方法与路径 | 功能 |
| --- | --- |
| `GET /api/groups` | 分组名称、状态及账号／Key 数量；`moduleDefaultGroupIds` 为 CPA、CommandCode、Devin 各模块默认组 ID，`defaultGroupIds` 为兼容历史行为的新模型 Key 默认组（仅 CPA 与 CommandCode） |
| `POST /api/groups` | 创建：`name`、可选 `description`、`enabled` |
| `PATCH /api/groups/:id` | 编辑分组名称、描述或开关 |
| `DELETE /api/groups/:id` | 删除未绑定的非默认分组 |
| `GET /api/groups/accounts?moduleId=cpa` | 来源与已绑定分组；也可选 `commandcode`、`devin2api` 或不传 |
| `PATCH /api/groups/accounts` | 设置来源组：`moduleId`、`sourceType`、`sourceId`、`groupIds` |
| `DELETE /api/groups/accounts` | 清理已确认不存在的来源绑定，参数同来源标识 |

模型 Key 创建接口支持 `groupIds`，不传时选择 CPA、CommandCode 两个模块默认组；编辑时不传则保留原分组。`groupIds` 至少一个，重复 ID 去重；停用组可保留绑定但不会赋予调用能力。原生配置及凭据内容不在分组库存响应中暴露。

官方行为依据：[CPA v8.0.15 来源模型选择](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.15/sdk/cliproxy/auth/conductor_selection.go)、[插件能力协议](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.15/sdk/pluginapi/types.go)。分组的多来源授权行为参考 [New API 分组文档](https://docs.newapi.pro/zh/docs/guide/feature-guide/admin/group)、[渠道选择源码](https://github.com/QuantumNous/new-api/blob/main/service/channel_select.go)，实现使用本项目的 Postgres 数据和内核请求上下文中的来源授权集合。
