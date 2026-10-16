# 账号与 API Key 分组

在「账号分组」创建分组，为账号和模型 API Key 各选择一个或多个分组。模型 Key 不需要选择来源模块：它可以调用这些分组中已启用的 CPA 来源和 Logicc 账号提供的模型。外调服务 Key 不参与分组，它的权限是按模块授予的（见[外调服务 API](external-api.md)）。

例如，Logicc 账号 A 只属于「工作」，账号 B 只属于「个人」。Key A 只选「工作」，Key B 只选「个人」，即使两个账号提供同名模型，两个 Key 也分别使用自己的账号。Key 选择多个分组时，按 Key 中设置的顺序和「多分组策略」使用它们（见下节）；账号加入多个分组时，可供这些分组的 Key 使用。

## 多分组 Key：自动切换与混合轮换

模型 Key 的分组是有顺序的，在 API Key 编辑弹窗里可以上移／下移。选择两个以上分组时，还可以选择策略：

- **自动切换（默认）**：每个请求从第一个能提供该模型的分组开始；这个分组内的来源都失败（凭证失效、无权限、限流、上游 5xx、超时、模型不存在等）时，自动换到下一个分组重试。
- **混合轮换**：能提供该模型的分组按请求轮流排在第一位，把流量分到各分组；失败时同样继续尝试剩下的分组。

切换只发生在任何内容发给客户端之前；客户端自身的参数错误（例如缺少 `messages`）不会换组，直接返回。每次尝试都只允许 CPA 选择该分组内的凭证，不会越组。请求日志的 `usage.nexus` 记录实际处理的分组、原生模型名、CPA 实际使用的凭证（`authIndex`，日志的来源列也会显示对应来源）以及被跳过的分组和原因（`failover`）。

**酒馆预设跟着分组走**：请求最终由哪个分组处理，就使用该分组在「酒馆预设」页面里的预设开关、顺序和配置；Key 本身不再有“是否经过酒馆”的开关。分组没有单独设置时继承预设库的全局开关；某个分组不想加预设，就在该分组下把预设全部关闭。

## 面板操作

1. 在「调用分组」点击「创建分组」，也可在 CPA 凭证的分组编辑弹窗中直接新建。
2. 在「CPA 内核 → 凭证管理」的「调用分组」列点击「编辑分组」，选择一个或多个组并保存；同一文件展开的虚拟凭证共享来源分组。
3. 侧栏中「CPA 内核 → 凭证分组」和「Logicc 模块 → 账号分组」分别显示所属模块的来源；Logicc 账号也可以在「账号管理」的编辑弹窗中修改分组。
4. 在 API Key 页面选择相同组：只选 Logicc 组就只调用这些账号，只选 CPA 组就只调用这些凭证，同时选择则可跨模块调用。多个分组时调整顺序并选择多分组策略。

使用 Basis Points 等独立执行器时，插件来源和它需要读取的底层账号凭证应加入该 Key 所选分组。账号凭证内容不会因修改分组而改变。

## 设置与迁移

- CPA 和 Logicc 分别使用「CPA」「Logicc」两个模块默认调用组，它们和其他分组一样是普通分组，可以改名、停用或复用。新导入的 Logicc 账号和首次发现的 CPA 来源默认加入各自模块的组；新建的模型 Key 默认同时带上这两个组。
- 迁移 021 移除了 CommandCode：原「CommandCode」模块组原地改名为「Logicc」，ID 不变，所以原来选了这个组的 Key 会继续调用到 Logicc 账号。迁移 020 为已有 Key 按分组创建时间写入初始顺序，策略为自动切换；升级前所有 Key 都不经过酒馆的分组会写入“全部关闭”的预设设置，升级不会给原来直连的流量加上预设。
- 为需要隔离的来源改选专用分组，并让对应 Key 只选择所需分组。模型 Key 同时选择两个模块组时，可跨模块调用；只选 Logicc 或 CPA 时使用对应组的来源。CPA 的 Devin 凭证和其他 CPA 凭证一样按所在分组参与调用。
- 模块默认组记录按 ID 持久保存，可以改名，不因名称变化重新创建；模块默认组不能删除。其他自定义分组可以跨模块复用。
- 分组停用后，其授权不参与模型目录或调用。账号、Key 自身停用同样不参与调度。
- 模型目录只显示当前 Key 的分组可用模型，并且只显示模型原本的名字（见下文「模型名称」）。Key 手动请求其他组的来源前缀也会被拒绝，不因同名模型自动越过分组。
- 模型不在 Key 的任何分组里时返回 404 `model_not_found`。
- 酒馆模块按分组管理：请求由哪个分组处理，就叠加该分组的预设开关、顺序和覆盖配置；没有分组覆盖时继承全局预设库。

同一分组内两个模块都提供相同模型时，先尝试组内 Logicc 账号（经内核桥接渠道），失败后再用组内 CPA 来源；也可以写 `logicc/<模型>` 明确只用 Logicc。需要明确指定 CPA 来源时，可以使用该来源允许的原始前缀模型名。多个组内 CPA 来源同名时由 CPA 在组内凭证间轮换，所有选择均不越过授权分组。

### 模型名称

`GET /v1/models`（以及 Gemini 格式的 `GET /v1beta/models`）只返回模型原本的名字：去掉 CPA 的 `devin/` 命名空间和来源前缀，也不带 `-high`、`(high)` 之类的思考后缀，同名模型只出现一次。New API 等上游平台直接同步这份列表即可。

调用时 CPAN 自动把原名换成分组内来源的真实模型名（例如 `claude-opus-4-8` → `devin/claude-opus-4-8`、`gpt-5` → `my-prefix/gpt-5`）。旧写法继续可用：`devin/claude-opus-4-8`、带来源前缀的名字、`claude-opus-4-8-high`、`claude-opus-4-8(high)`。

### CPA Devin 渠道的参数

Devin 模型由 CPA 内核自带的 Devin 渠道（凭证管理里的 `devin` 凭证）按组内凭证执行。原内置 Devin 模块已移除，升级迁移会清理它的账号、分组绑定和日志，绑定该模块的 Key 改为普通 Key。

Devin 的每个思考档位其实是一个独立的上游模型，CPA 通过 `devin/<模型>(<档位>)` 选择档位，并不理解 OpenAI/Anthropic/Gemini 的思考参数。CPAN 在请求到达 CPA 之前做转换：

1. 档位来源依次是：模型名后缀（`-high`、`(max)`）→ 请求参数（`reasoning_effort`、`reasoning.effort`、`output_config.effort`、`thinking.budget_tokens`、`thinking.type: disabled`、`reasoning.max_tokens`、Gemini `thinkingConfig`）→ 「API Key → 调用设置」里的默认档位（默认 high）。预算按 ≤4096 low、≤16384 medium、≤32768 high、更大 max 换算。
2. 档位按 CPA Devin 目录中该模型实际提供的档位就近取值；目录里没有思考档位的模型保持原名。
3. 已转换的思考字段会从请求体中删除；开启「移除采样参数」时，思考模式下同时删除 `temperature`、`top_p`、`top_k`（Devin 官方客户端不发送这些参数）。

请求日志的 `usage.nexus.devin` 记录最终档位、档位来源和删除的字段。

Devin 有时把后端临时故障报告为 `permission_denied: an internal error occurred`。CPAN 在 CPA 配置中写入 `oauth.request-scoped-errors.devin` 规则：这种错误直接换下一个 Devin 凭证，不再让该模型在凭证上冷却约一分钟；全部凭证都失败时，再由 CPAN 切换到下一个分组。已有的其他自定义规则会保留。

### 图片自动压缩与 413

请求里的 base64 图片（OpenAI `image_url`、Responses `input_image`、Anthropic `source.type: base64`、Gemini `inline_data`）超过 512 KB 或最长边超过设定值时，CPAN 会先等比缩小（默认最长边 2048 px、质量 85，带透明通道的转 WebP，其余转 JPEG），再发给任何来源。模型看到的清晰度基本不变，四张手机照片通常从几十 MB 降到几 MB。网络图片链接、动图和无法解析的数据原样转发。可在「API Key → 调用设置」修改或关闭；日志的 `usage.nexus.images` 记录压缩前后大小。

上游代理（常见是 nginx 默认的 1 MB 请求体上限）返回 413 时，CPAN 先对同一个来源依次用更小的图片重试（最长边 1536 / 1024 / 768 px，质量 80 / 75 / 70，从原图重新压缩），仍被拒绝再尝试其他来源和分组；都不接受时返回 `request_too_large`，说明请求大小和图片压缩情况，而不是转发 nginx 的 HTML 错误页。

### 支持的入口

`ccm_` 模型 Key 可以调用 `/v1` 下的所有 CPA 模型路径（chat/completions、messages、messages/count_tokens、responses、responses/compact、embeddings、images、audio、videos 等）和 Gemini 格式的 `/v1beta/models/<模型>:generateContent`、`:streamGenerateContent`、`:countTokens`。Key 可以放在 `Authorization: Bearer`、`x-api-key`、`x-goog-api-key` 或 `?key=` 中。不带 `model` 字段的请求（multipart 上传、任务查询、`responses/<id>/cancel` 等）交给 CPA 处理，但只允许使用 Key 所有分组内的凭证。WebSocket 升级仍直接交给 CPA，只能使用 CPA 原生客户端 Key。

`POST /v1/messages/count_tokens` 与 `/v1/messages` 使用相同的组内 CPA 来源，不叠加预设、不记账；只由 Logicc 提供的模型不支持计数，返回 404。

平台拒绝的请求按 HTTP 状态返回对应的错误类型（OpenAI 格式：`invalid_api_key`、`permission_denied`、`model_not_found`、`service_unavailable` 等；Anthropic 格式：`authentication_error`、`permission_error`、`not_found_error`、`overloaded_error` 等）。只有酒馆预设无法应用（HTTP 422）时才是 `preset_route_error`。

## CPA 来源与原生功能

CPA 使用完整官方 v8.0.15，OAuth、刷新、配额、协议转换、模型别名和流式响应继续由内核执行。分组按实际来源隔离：OAuth 凭据文件、原生配置中的每个上游 Key 都有稳定来源身份。Google 一个文件中的多个虚拟项目账号共享该来源的分组；项目模型目录取实际运行时账号模型的并集。

完整插件内核通过请求内授权集合限制真实账号与独立插件执行器。模型名保持原样交给原版路由/转换/调度插件；每次选号、重试和嵌套插件调用都继承同一集合，不再用单个预选来源前缀限制插件，也不按插件名称或版本白名单拒绝插件。OAuth 文件、配置 Key、运行时插件账号和无凭据独立插件执行器均可作为来源绑定分组。同文件的虚拟项目共享来源分组。

标准插件向 CPA 注册的账号可分别绑定分组。没有注册账号的独立执行器以 `plugin:<id>` 作为一个来源；如果插件把自己的多个上游 Key 隐藏在内部池里，只能整体分组，逐 Key 分流需要插件提供账号注册接口。Logicc 账号由模块逐个管理，每个账号都可以单独绑定分组。

服务器在内部管理通道注册短期授权集合，客户端请求只附服务器签名的短引用；认证密钥、策略签名和全量账号 ID 不发到客户端或供应商。原版客户端未附策略时继续原行为。未安装适配或未配置内部策略密钥时，平台分组调用明确要求更新内核，不退回全账号池。

「CPA 原生客户端 Key」保留官方完整行为，不自动套用 Nexus 分组。它们同样经过 CPAN 的 `/v1` 入口，请求体和认证原样转发，只移除 Cookie、来源 IP、设备与追踪类请求头。需要账号隔离的客户端应创建平台「模型 API Key」。后台显示这一差别，避免把原生 Key 误认为经过平台分组管控。

来源删除或暂时未注册时，原分组绑定会保留，并在页面标记来源状态。确认来源已经删除后，可手动清理绑定；临时停用来源的分组授权不会自动丢失。仍有账号或 Key 绑定的分组不能删除，默认组和模块默认调用组不能删除。

## 管理 API

以下接口使用管理员登录会话及现有同源检查：

| 方法与路径 | 功能 |
| --- | --- |
| `GET /api/groups` | 分组名称、状态及账号／Key 数量；`moduleDefaultGroupIds` 为 CPA、Logicc 各模块默认组 ID，`defaultGroupIds` 为新模型 Key 默认组 |
| `POST /api/groups` | 创建：`name`、可选 `description`、`enabled` |
| `PATCH /api/groups/:id` | 编辑分组名称、描述或开关 |
| `DELETE /api/groups/:id` | 删除未绑定的非默认分组 |
| `GET /api/groups/accounts?moduleId=cpa` | 来源与已绑定分组；也可选 `logicc` 或不传 |
| `PATCH /api/groups/accounts` | 设置来源组：`moduleId`、`sourceType`、`sourceId`、`groupIds` |
| `DELETE /api/groups/accounts` | 清理已确认不存在的来源绑定，参数同来源标识 |

模型 Key 创建接口支持 `groupIds`（顺序即调用顺序）和 `groupStrategy`（`failover` 自动切换，默认；`mixed` 混合轮换），不传 `groupIds` 时选择 CPA、Logicc 两个模块默认组；编辑时不传则保留原值。`groupIds` 至少一个，重复 ID 去重；停用组可保留绑定但不会赋予调用能力。原生配置及凭据内容不在分组库存响应中暴露。

官方行为依据：[CPA v8.0.15 来源模型选择](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.15/sdk/cliproxy/auth/conductor_selection.go)、[插件能力协议](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.15/sdk/pluginapi/types.go)。分组的多来源授权行为参考 [New API 分组文档](https://docs.newapi.pro/zh/docs/guide/feature-guide/admin/group)、[渠道选择源码](https://github.com/QuantumNous/new-api/blob/main/service/channel_select.go)，实现使用本项目的 Postgres 数据和内核请求上下文中的来源授权集合。
