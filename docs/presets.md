# 酒馆预设模块

预设是可选的请求处理模块，默认关闭。在「模块管理」或「酒馆预设」页面启用后，只有选用了预设路由的请求会增加提示词处理；其余请求保持原模块的调用方式。关闭模块保留预设与绑定，新的调用恢复直连，进行中的请求继续完成。

## 导入和编辑

1. 打开「酒馆预设」，上传 SillyTavern Chat Completion 预设 JSON，或粘贴 JSON 文本。预设、上下文变量和提示词展开不设置人为大小上限。
2. 编辑名称、提示词内容、顺序、启停、深度插入、采样参数和上下文变量。也可以编辑完整原始 JSON。
3. 查看兼容检查，保存后选择路由。导出保留原始文档中的未知字段，运行时只向模型发送支持的参数。

角色名、用户名称、角色描述、场景、世界书内容等需要在「上下文变量」填写实际内容。本模块不自动加载酒馆角色卡、检索世界书或执行酒馆扩展。没有提供的上下文标记不会凭空产生内容；必需宏缺失时会显示诊断。`setvar/getvar`、随机/日期宏、STScript 和扩展执行尚不支持，含这些有效提示词的预设可以保存编辑，但不能绑定为可调用预设。

支持 `prompts`、全局 `prompt_order`（100000）、提示词启停、相对顺序、深度/优先级、生成触发器、传统主提示词及历史后提示词；也支持 Prompt Manager 的包装/平铺顺序导出。参数默认值只补充客户端未提供的值，客户端的模型、stream、tools、tool_choice 和明确设置的采样参数保持优先。图片内容及工具调用/结果保持结构与配对。

Claude Messages 按酒馆的转换规则：开头的 system 进入独立 system 字段，历史中或历史后的 system 在原位置转换为 user 内容，再合并相邻同角色内容。Responses 保留输入、工具与指令；如果请求使用 `previous_response_id` 或 `conversation` 引用不可见历史，无法准确按酒馆顺序编排，返回 422，请发送完整上下文。System One 决策、图片/视频及 WebSocket 会话沿用原生调用，不处理聊天预设。

## 按 API key 选择

在统一「API key」页面创建模型调用 key，并将每个 key 绑定到 CommandCode 或 CPA。随后在「酒馆预设」页面选择这个平台 API key，选择「普通调用，不使用预设」或「使用酒馆预设」。外调服务密钥和内部桥接密钥不能绑定预设。

例如创建 KA、KB 两个模型 key，只给 KB 绑定酒馆预设。同一个模型通过 KA 调用时保留客户端消息，通过 KB 调用时应用选定预设。模块和上游账号不会成为 key 的默认预设来源；模型模块仍负责账号池选号、额度与并发控制。key 改绑模块后保留自己的预设选择，预设绑定随 key 一同撤销。

模块关闭时可以提前保存 key 选择，启用后生效。仍被 key 使用的预设不能删除或改成不兼容内容，需要先解除绑定。System One 等非聊天接口继续沿用原生调用。

### CommandCode 调用

CommandCode key 可以使用原始官方模型 ID。经 CPA 兼容转换后，内部回调使用签名恢复原 key 的身份，重新验证 key 当前启用状态和 CommandCode 绑定，然后仅应用这个 key 的预设。没有可信原 key 身份的内部桥接调用不应用预设。一次明确拒绝重试到另一个上游账号时，从原客户端请求重新生成同一个 key 的预设，避免重复叠加；日志记录实际发送的请求。

### CPA 调用

CPA 模型 key 由平台认证，再使用配置好的 CPA 客户端密钥调用内核。预设按平台 key 选择，不按凭证账号或模型前缀选择；未绑定预设的 key 保持直连。CPA 原生旧客户端密钥继续透传，预设请使用平台创建的模型 key。

### 旧账号配置迁移

升级时，旧模块默认和账号路由完整归档到 `nexus_legacy_preset_bindings`，停止生效。预设库和 CPA 原有模型前缀仍保留，可在新页面为 API key 重新选择预设。历史归档不引用活跃预设的外键，因此不会阻止删除已不再使用的预设。

## 管理接口

所有以下接口沿用管理员登录与来源检查，`ccm_service_` 外部服务密钥不能管理预设。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/api/presets` | 列表（含 moduleEnabled）/ 导入新预设 |
| GET / PATCH / DELETE | `/api/presets/:id` | 查看/编辑/删除 |
| GET | `/api/presets/:id/export` | 导出原始 JSON |
| POST | `/api/presets/validate` | 检查名称、JSON 与变量 |
| GET / PUT | `/api/presets/routes` | 读取/设置 API key 绑定；PUT 使用 keyId，mode 为 inherit、bypass 或 preset |
| PATCH | `/api/modules` | `{ "id": "presets", "enabled": true }` |

预设、上传和请求体不设置人为大小上限；旧 `maxRequestBodyMb` 字段保留兼容并固定为 0（不限制）。预设转换使用 JSON，不接受压缩请求体。CPA 原生旧密钥请求继续流式透传；平台模型 key 经过认证与请求校验，响应仍流式传递。CPA 保留协议转换和执行，原生非聊天能力继续走完整内核入口。`x-nexus-preset-id` 响应头标记实际使用的预设，流式响应不缓冲，客户端断开会取消上游。

预设和绑定持久化在 PostgreSQL（迁移 008、010），进程短缓存减少重复解析，修改立即使当前进程缓存失效；多应用实例最迟在短缓存过期后更新，不增加服务或部署依赖。

格式及行为依据：[SillyTavern Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)、[官方消息转换源码](https://github.com/SillyTavern/SillyTavern/blob/release/src/prompt-converters.js)。CPA 账号路由依据项目固定的官方 [v8.0.11 源码](https://github.com/router-for-me/CLIProxyAPI/tree/v8.0.11)。本模块独立实现 JSON 兼容处理。
