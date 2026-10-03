# CPA 原生功能与完整控制台

CPA Nexus 使用完整官方 CLIProxyAPI v8.0.11。原版能力以官方内核及完整官方管理控制台为来源，Nexus 同时提供 OAuth、配额、凭据、配置和插件的中文入口。

| 页面 | 原生功能 |
| --- | --- |
| `/cpa/oauth` | 内建与已注册插件 OAuth、浏览器与设备码授权、回调 URL／授权码、轮询及取消 |
| `/cpa/credentials` | 筛选、分页、多文件导入、批量启停／刷新／下载／删除、模型、字段及冷却重置 |
| `/cpa/quota` | 实际额度观察、供应商主动查询、窗口与重置时间、插件及声明式探针 |
| `/cpa/native` | 官方完整控制台，含供应商专用配额和恢复操作、高级配置、统计、日志与完整插件页面 |
| `/cpa/keys` | 原生客户端密钥，和统一 API Key 页面分别保留 |
| `/cpa/config`、`/cpa/channels`、`/cpa/requests`、`/cpa/logs`、`/cpa/plugins` | 完整配置、路由、上游检查、日志用量、插件与商店 |

## OAuth

固定内核的内建标识包括 `claude`、`codex`、`antigravity`、`devin`、`kimi`、`kimi-ai`、`xai`、`meta`。页面根据已验证的版本契约和实际插件发现显示渠道，区分浏览器与设备码流程。Google Gemini CLI 使用官方 `gemini-cli` 提供器，支持可选 `project_id`；Vertex 保留服务账号 JSON 和 `location` 导入。

新部署默认启用原生插件，部署脚本从官方商店核对仓库并安装 Google 提供器；需要重启时自动等待核心恢复健康。已有明确停用的插件配置保留，页面显示实际安装／注册／启用状态，不将未就绪提供器显示为可用。授权由使用者在供应商页面完成，提供器准备不会登录供应商账号或调用模型。

## 真实配额

Codex、Anthropic、Antigravity、Kimi、Devin、Meta、xAI 的查询通过 CPA 原生 `requests/api-call` 委托固定官方端点，验证所选凭据与供应商匹配。令牌在服务器处理，返回剔除私密字段的数据。显示供应商实际提供的数值；缺少的数据保留未知，不用额度减余额伪造使用量，不把查询失败当作零。

默认显示内核的凭据／模型额度观察，点击查询后才访问上游。使用短缓存、相同请求合并和并发上限。Codex 查询不会自动消耗恢复额度，xAI 不自动发送推理健康测试；官方完整控制台保留这些原生用户操作。

通用插件／声明式配额继续使用官方保留的 v0 `quota/providers`、`quota/fetch`、`quota/reset`。供应商配额重置、请求冷却重置和凭据 Token 刷新是不同操作，页面分别标明。

## 官方完整控制台

面板固定 `v1.25.2`，HTML SHA-256 为 `b6ea0bbd1f7bdb2a3da5d960a5ad71bc89f33212ece21124c390511eef7ce041`。经校验的 HTML、许可证与来源记录保存在 `.runtime/cpa/config/static`，用持久挂载及 `MANAGEMENT_STATIC_PATH` 保留；已有有效资产不被普通更新覆盖。

原版前端通过 Nexus 管理员会话自动连接 `/api/cpa/console/`，完整代理 v8／v0 管理接口、插件资源及子资源。真实管理密钥只在服务器替换，浏览器只保存无权限会话标记；原版偏好使用独立本地存储名称，不覆盖其他原版登录信息。

桥接逐次验证管理员会话，固定访问已配置 CPA 服务并校验路径／参数。模型目录使用内部 `CPA_CLIENT_KEY`，普通 v0／v8 客户端列表操作保留平台内连密钥，其余原生配置及文件操作由内核处理。直接公网管理路径仍不开放。

官方来源：[固定内核管理契约](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.11/docs/management-api-v8.md)、[官方面板发布](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases/tag/v1.25.2)、[Google 提供器](https://github.com/router-for-me/cpa-plugin-gemini-cli)。
