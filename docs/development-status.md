# 开发与验证记录

日期：2026-09-12。本轮完成全项目审查、修复和回归，详情见[审查报告](full-project-audit.md)。

## 已通过

- 最终 npm run check 退出码0：Nuxt与Worker类型检查、Vitest、Nuxt生产构建、Worker/迁移打包及固定内核构建。
- Vitest4.1.11：27个测试文件、201项全部通过，没有跳过项。
- 包含15项真实PostgreSQL测试：迁移幂等、账号约束与搜索、删除引用保留日志、日志筛选与稳定分页、结构化JSON、特殊Unicode无损保存及历史修复。
- 包含9项真实Redis/BullMQ测试：并发容量、续租、过期恢复、亲和迁移、失租、冷却、优先级、延迟提升与实际Worker处理。
- 完整 npm audit：生产与开发依赖均0项已知漏洞；依赖树中ioredis/esbuild版本一致。
- Compose生产、开发、1Panel网络覆盖配置静态检查通过；固定内核产物语法检查通过。
- 生产模式HTTP端到端26项通过：登录/退出、设置、两类密钥、合成Cookie导入与Worker处理、账号快照、搜索、模型目录、三协议流式与非流式、日志、套餐拒绝、密钥停用与撤销、SSE首帧。

- 最终图标定向6项通过：匿名GET/HEAD本地ph与ph.json正常，私有API/其他集合/写方法仍受保护，SSR与浏览器均无图标加载失败或公网回退。

## 本轮测试隔离

PostgreSQL17使用本机已安装的程序创建独立临时数据目录；Redis7.4.11使用经过SHA-256验证的Windows便携构建。它们仅监听127.0.0.1，未更改已有业务数据库。集成用例使用随机schema/Redis前缀，结束时清理测试记录。

生产冒烟使用独立测试数据库、Redis测试实例及两个合成账号。上游身份、额度、Key创建和模型响应由本地HTTP fixture提供；app/worker/数据库/Redis均为真实运行的生产构建组件。这证明内部整链路工作，不代表真实上游套餐权限或额度已经实测。

## 验证边界

本机Docker Desktop仍因早已存在的dockerInference套接字错误无法启动。因此尚未执行Linux Compose镜像构建及整套服务启动、Ubuntu/1Panel反向代理、真实账号批量导入，以及真实Command Code/Codex/Claude Code客户端端到端联调。

独立Chromium浏览器完成11项交互检查：登录与SSR hydration、账号搜索、导入弹窗验证/关闭及第三个合成账号的真实UI提交、Worker完成、进度关闭与URL清理、账号编辑与实时更新合并、设置保存/还原、模型观察、两类Key弹窗、结构化日志、390px移动导航与无横向溢出。控制台错误、警告及资源失败均为空；桌面概览和移动设置截图另经目视复核。内置CUA工具初始化失败后，使用已有Playwright及缓存Chromium，没有安装浏览器或连接用户浏览器。

## 验证材料

- artifacts/audit-infra/full-check.log：最终完整检查输出。
- artifacts/audit-infra/dependency-audit.json：完整依赖审计。
- artifacts/audit-infra/app-audit-e2e-report.json：最终构建重启后的26项内部链路验证。
- artifacts/audit-infra/app-audit-browser-report.json：11项浏览器交互与空错误列表。
- artifacts/audit-infra/app-audit-icons-report.json：最终图标路由、SSR及日志的6项检查。
- artifacts/audit-infra/browser-*.png：登录、概览、账号、设置、密钥、日志及移动布局截图。
- artifacts/audit-infra下的模拟器及测试脚本仅用于本地合成数据验证，不进入发布镜像。

此前的单账号真实上游核验和69模型探测记录仍是历史材料，不用于冒充本轮真实上游验证。没有重置Docker、删除其数据、更改系统功能、使用真实账号凭证，或提交/推送代码。

测试中的预期401/400拒绝路径仍会触发h3对中文statusMessage的使用建议，已确认不影响中文错误响应；它不是运行异常。强制关闭Docker进程被自动审批拒绝，理由是可能影响已有容器，因此保留Docker进程，未执行强制终止。

最终收尾：本任务app、worker、本地上游模拟器、独立PostgreSQL和Redis均已正常停止；14009/14010/55439/56389端口已确认关闭。测试数据与报告保留在被忽略的artifacts目录，已有业务数据库未被改动。

## 2026-10-03 · CPA Nexus 模块化平台

项目更新为 CPA Nexus 0.2.0。保留既有未提交改动与 CommandCode 功能，增加独立官方 CPA 内核、模块清单与持久启停、统一中文面板、v8 管理适配、原生插件资源适配及可持续升级的部署结构。

生产内核固定官方 v8.0.11 镜像与摘要；原 Compose 项目名保留以复用现有数据库命名卷，.env 不变，新增 CPA 配置使用 .env.cpa 与 .runtime/cpa/。公网模型入口由 CPA 接管，CommandCode 通过独立别名与内部加密密钥桥接。普通模块密钥列表不展示该内部密钥。

验证：最终 npm run check 成功，42 个测试文件、399 项测试全部通过，没有跳过，类型检查与生产构建通过。环境包括全新隔离 PostgreSQL 17、Redis 7.4，以及经过官方 SHA256 校验的 CPA Windows 插件版和独立 Nginx。测试不会读取或修改现有账号数据。

额外真实应用联调 17 项通过：实际 CPA 版本与配置、真实 Worker 导入模拟账号、真实模型目录、Chat/Messages/Responses 三种协议 JSON 与 SSE、模块停启与数据保留、内部密钥过滤、调用日志。此处上游为本地合成服务，不能解释成真实 CommandCode 套餐或供应商授权已验收。

真实 edge 对应用与 CPA 的14项检查通过；独立入口测试验证 SSE 首块实时送达、WebSocket101升级和下游断开关闭上游。桌面1440/1366与手机390的21项页面/导航截图无横向溢出和浏览器运行错误，另外11项浏览器交互通过，包含配置标量/null、请求检查显式提交、Vertex无效文件原生拒绝、模块启停/取消与导航同步。测试后模块启用状态与临时配置已恢复。

本轮实际联调修复了仅从文档无法确认的问题：v8.0.11不接受兼容渠道keys元素中的request-retry/disable-cooling，因此只使用渠道级覆盖；Nitro静态模块子目录会遮蔽部分动态启停路径，因此统一面板使用稳定PATCH /api/modules。同时保留会话/子代理动态请求头、按CPA客户端摘要隔离亲和范围，并处理独立CPA认证错误不会清除平台管理员会话。

验证材料保存在 ignored artifacts/nexus-verification/：final-check.log、real-cpa-smoke-report.json、edge/real-edge-report.json、ui/results.json与ui/functional-results.json。真实生产Linux Docker/1Panel、实际供应商OAuth与账号、完整客户端工具多轮以及高级UDP媒体网络仍需各自部署验收；本轮没有部署生产服务或使用真实上游凭证。新版平台不提供无条件自动替换内核，候选升级与回退流程见docs/cpa-nexus.md。


最终收尾：本轮独立app、worker、CPA、模拟上游、PostgreSQL和Redis已停止；14029/14030/18317/55449/56409端口关闭。截图、报告和测试数据保留在ignored artifacts目录，没有留下持续运行的测试服务。

## 2026-10-03 · GOAT 官方 API 与官方目录

按用户新的账号方案迁移至 GOAT（官网名称）。Cookie 用于账号身份、额度和专用 API Key 管理；推理直接使用官方 Provider API，不运行旧 Go 私有协议内核。默认 Compose 保留 postgres、redis、cpa、app、worker、edge 六个服务。没有增加其他内核分支或产品。

官方数据：8个公开来源抓取成功，实时列表85个API目录ID与网页86个ID按精确标识保留，合并87个原始ID。官方文档明确提供Jev/System One请求示范，因此额外记录文档API支持；API目录计数与文档支持计数独立。GOAT完整包含范围来自官方planScope，实测63个；数量是本轮快照，不是固定常量或未来保证。未知套餐/充值/账号实际权限保持独立。

新增官方模型与套餐页面、后台同步及手动刷新；API目录每5分钟、网页每15分钟检查，进程5秒/Redis60秒缓存、条件请求、分布式锁、PostgreSQL持久快照与最多48份变化历史。解析或请求失败保留有效数据并标记来源错误。旧反代观察标为legacy-proxy；官方权限使用official-provider，套餐变更后旧观察不充当新权限。

Chat与Messages按官方supported_endpoints分别接入CPA，保持Responses入口。旧ccm_客户端通过/commandcode/v1保留原模型名与格式，日志及亲和范围通过签名保留原调用者。System One为非流式独立端点。管理员导入、加账号、外调、任务、池、账号、访问Key与服务Key接口保留；外调加账号仍按原token/cookie/text输入并返回202异步任务。

验证：完整npm run check成功，46个文件、462项测试全部通过无跳过，包含隔离PostgreSQL/Redis、真实官方CPA8.0.11与真实Nginx，生产构建通过。另新数据库与本地模拟官方服务23项整链路通过，包括Cookie取Key、公开官方抓取、三协议JSON/SSE、旧Claude客户端转换、SystemOne、服务Key加账号/任务/池、原调用者日志归属，以及推理没有浏览器Cookie。未使用真实上游账号凭证或真实模型请求。

Docker-only部署脚本新增init/up/update/status/logs/stop/backup，在临时Node容器生成配置，无需宿主Node或修改已有.env。Ubuntu/1Panel、持久网络、备份恢复和固定CPA升级写入部署说明；Compose production/development/1Panel静态解析和Bash语法通过。真实Linux容器构建与备份恢复仍需部署验收，不能由Windows本地检查代替。

材料保存在ignored artifacts/official-catalog/和artifacts/gota-verification/：公开实时快照、full-check.log、real-smoke-report.json与界面检查。


GOAT界面验收：桌面1440与手机390的21项检查全部通过，JS/console错误0、浏览器直接抓官网0；套餐筛选、精确ID分页、矩阵局部滚动、Go不支持API与Enterprise未知、Jev文档端点等核对完成。最终构建又通过8个source标签及来源时间提示断言。截图为 artifacts/gota-verification/ui/1440-official-viewport.png 与390-official-viewport.png。

收尾：本轮app/worker/CPA/模拟官方服务和独立PostgreSQL/Redis已停止，测试端口释放。未改真实.env或真实账号数据，报告保留在ignored artifacts目录。
