# 酒馆预设模块

预设是可选的请求处理模块，默认关闭。在「模块管理」或「酒馆预设」页面启用后，只有选用了预设路由的请求会增加提示词处理；其余请求保持原模块的调用方式。关闭模块保留预设与绑定，新的调用恢复直连，进行中的请求继续完成。

## 导入和编辑

1. 打开「酒馆预设」，上传 SillyTavern Chat Completion 预设 JSON，或粘贴 JSON 文本。单个文档上限 1 MiB。
2. 编辑名称、提示词内容、顺序、启停、深度插入、采样参数和上下文变量。也可以编辑完整原始 JSON。
3. 查看兼容检查，保存后选择路由。导出保留原始文档中的未知字段，运行时只向模型发送支持的参数。

角色名、用户名称、角色描述、场景、世界书内容等需要在「上下文变量」填写实际内容。本模块不自动加载酒馆角色卡、检索世界书或执行酒馆扩展。没有提供的上下文标记不会凭空产生内容；必需宏缺失时会显示诊断。`setvar/getvar`、随机/日期宏、STScript 和扩展执行尚不支持，含这些有效提示词的预设可以保存编辑，但不能绑定为可调用预设。

支持 `prompts`、全局 `prompt_order`（100000）、提示词启停、相对顺序、深度/优先级、生成触发器、传统主提示词及历史后提示词；也支持 Prompt Manager 的包装/平铺顺序导出。参数默认值只补充客户端未提供的值，客户端的模型、stream、tools、tool_choice 和明确设置的采样参数保持优先。图片内容及工具调用/结果保持结构与配对。

Claude Messages 按酒馆的转换规则：开头的 system 进入独立 system 字段，历史中或历史后的 system 在原位置转换为 user 内容，再合并相邻同角色内容。Responses 保留输入、工具与指令；如果请求使用 `previous_response_id` 或 `conversation` 引用不可见历史，无法准确按酒馆顺序编排，返回 422，请发送完整上下文。System One 决策、图片/视频及 WebSocket 会话沿用原生调用，不处理聊天预设。

## 路由选择

模块默认可选择直连或一个预设。账号可选择「跟随模块默认设置」「直连，不使用预设」或一个独立预设；账号的明确设置覆盖模块默认。路由配置可以在模块关闭时提前保存。仍被绑定的预设不能删除；修改成不兼容内容之前必须解除绑定。

### CommandCode 账号

在账号详情选择请求预设。账号池先按真实额度、权限、会话亲和与并发租约选定账号，再应用这个账号的预设。一次明确拒绝重试到另一个账号时，重新从原客户端请求生成新账号的预设，避免重复叠加。日志记录实际发送的请求。

原有 `ccm_` 模型密钥同时支持 `/v1` 和 `/commandcode/v1`，使用原始官方模型 ID。CPA 客户端密钥通过 `/v1` 使用 `commandcode/<官方模型ID>`；两种入口都在最终账号执行处应用一次 CommandCode 预设。

### CPA 原生账号

在 CPA 凭证详情设置 OAuth 账号路由，或在预设页面选择 CPA API Key 账号。保存账号路由时，为账号保留已有独占模型前缀；没有前缀或共用前缀时设置稳定的独占前缀，并核对持久配置与实际模型目录。

使用面板显示的 `前缀/原模型名` 发起调用，会先使用对应账号预设，再由 CPA 执行该账号。未使用独占前缀的 CPA 池调用使用 CPA 模块默认预设，账号仍由 CPA 自动选择。关闭预设模块后前缀模型继续可用，只跳过预设处理。

原生 provider 的 API Key 使用 v8 每 key 的 prefix 覆盖，不改动同组其他 Key。OpenAI 兼容渠道的前缀属于整个渠道，选中多 Key 渠道中的一个账号时，会把该 Key 拆为保留所有其他设置的独立渠道；原渠道继续保留其他 Key。Config 账号绑定使用稳定的 `config:<auth_index>`，前缀改变后运行时 credential ID 改变也不会丢失绑定。重复的同 provider/上游/Key 无法获得唯一身份，须先合并。CommandCode 托管桥和没有持久配置的插件/临时 WebSocket 凭据不能作为 CPA 独立账号修改。

## 管理接口

所有以下接口沿用管理员登录与来源检查，`ccm_service_` 外部服务密钥不能管理预设。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/api/presets` | 列表（含 moduleEnabled）/ 导入新预设 |
| GET / PATCH / DELETE | `/api/presets/:id` | 查看/编辑/删除 |
| GET | `/api/presets/:id/export` | 导出原始 JSON |
| POST | `/api/presets/validate` | 检查名称、JSON 与变量 |
| GET / PUT | `/api/presets/routes` | 读取/设置绑定；mode 为 inherit、bypass 或 preset |
| GET | `/api/presets/cpa-routes` | 非敏感 CPA 账号路由能力和模型前缀 |
| PATCH | `/api/modules` | `{ "id": "presets", "enabled": true }` |

启用的预设请求使用平台的 `maxRequestBodyMb` JSON 限制，不接受压缩请求体。未启用预设时 CPA 请求与响应流式透传；CPA 保留认证、协议转换和执行，原生非聊天能力继续走完整内核入口。`x-nexus-preset-id` 响应头标记实际使用的预设，流式响应不缓冲，客户端断开会取消上游。

预设和绑定持久化在 PostgreSQL（迁移 008），进程短缓存减少重复解析，修改立即使当前进程缓存失效；多应用实例最迟在短缓存过期后更新，不增加服务或部署依赖。

格式及行为依据：[SillyTavern Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)、[官方消息转换源码](https://github.com/SillyTavern/SillyTavern/blob/release/src/prompt-converters.js)。CPA 账号路由依据项目固定的官方 [v8.0.11 源码](https://github.com/router-for-me/CLIProxyAPI/tree/v8.0.11)。本模块独立实现 JSON 兼容处理。
