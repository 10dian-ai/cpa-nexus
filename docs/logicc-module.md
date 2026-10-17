# Logicc 模块

Logicc 模块把多个 Logicc 网页账号统一成一个号池，经 CPA 内核对外提供模型。它是 CPA 下的普通模块：自己管理账号、会话、调度和用量计算，但不能读写 CPA 的配置。

## 调用链

```
客户端 ─► /v1（ccm_ 模型 Key）─► Key 分组 ─► 尝试序列（分组 × 来源）
       ─► 服务分组的酒馆预设 ─► CPA 内核（Messages / Responses / Gemini → Chat）
       ─► 内核桥接渠道 nexus-logicc（模型别名 logicc/<模型 ID>）
       ─► /api/modules/logicc/bridge/v1/chat/completions ─► Logicc 号池 ─► app.logicc.com
```

- 客户端按原模型名调用，例如 `claude-sonnet-4-5`；也可以写 `logicc/claude-sonnet-4-5`，只走 Logicc。
- 同一分组里，Logicc 先于该组的 CPA 原生来源尝试。Logicc 失败（账号都在冷却、凭据失效、上游 5xx）时，路由自动换到下一个来源或分组。
- 只有 `auto`（跨来源）模型 Key 会用到 Logicc；只绑定 CPA 的 Key 不会。
- 模块只实现 OpenAI Chat Completions。其他协议由 CPA 转换，和 CPA 原生渠道的处理方式一致。

## 内核桥接渠道

模块不持有 CPA 管理密钥，也不调用 CPA 配置接口。它只**声明**两件事：回调路径，以及当前可提供的模型。注册工作由内核层 `server/lib/cpa/module-bridges.ts` 完成：

- 渠道名固定为 `nexus-<模块>`。内核只改自己名下以 `nexus-` 开头的渠道，用户的其他渠道原样保留。
- 渠道密钥 `ccm_nexus_logicc_…` 由内核生成，以哈希加密存储，只能用于回调这个模块。
- 每次路由都带一组签名请求头：Key ID、服务分组、请求 ID、过期时间、HMAC 签名。CPA 原样转发这组头，模块校验签名后，只从被签名的那个分组里选号。客户端自己发的 `x-nexus-*` 请求头在进入 CPA 前就会被删掉。
- 公网入口（nginx 3000/3041）对 `/api/modules/*/bridge` 一律返回 404，只有 Compose 网络内的 CPA 能访问。
- 账号增减、分组变化、模块启停后，渠道自动同步。Worker 也会每两分钟核对一次。

## 账号与凭据

Logicc 使用 Clerk 登录。一个 `__client` Cookie 可以为它的会话签发短期 JWT（约一分钟）：

```
POST https://clerk.logicc.com/v1/client/sessions/{sessionId}/tokens   (Cookie: __client=…)
```

- JWT 按需签发，加密缓存在 Redis，过期前 10 秒失效。多个进程同时刷新同一账号时，用 Redis 锁保证只刷一次。
- Clerk 在任何响应里轮换 `__client` 时，都按版本号写回数据库，并发写入不会互相覆盖。
- 后台每次检测账号时，会像 Logicc 网页一样调用一次 `POST …/sessions/{id}/touch`，标记会话仍在使用，防止会话因长时间不活动被注销。
- Logicc 返回 401 时，强制刷新 JWT 并重试一次。
- **一次拒绝不判失效。** Clerk 和 Logicc 前面都有防机器人保护，偶尔会拒绝服务器发来的请求，而 Clerk 返回 403 也不一定代表会话已经没了。账号被拒后冷却 5 分钟，仍留在号池里，后台说明里会显示「第 N/3 次」；只有连续 3 次被拒、中间没有任何一次成功，才标为「凭证失效」并退出调度。之后后台检测一旦成功，会自动恢复。返回网页而不是接口数据的情况（防火墙、Cloudflare 拦截）只冷却 2 分钟，不算一次拒绝。并发请求同时失败只算一次。
- 只有 JWT、没有 Cookie 的账号可以用到 JWT 过期为止，过期后立即退出调度。
- 暂时不可用账号的模型仍然保留在目录里：客户端收到的是可以重试的 503，路由也会换到其他来源，而不是返回 404「模型不存在」。

**一个 `__client` 只给 CPAN 一个人用。** 浏览器里的 Logicc 页面也会让 Clerk 轮换 `__client`，两边共用同一个登录时，一边轮换后另一边手里的值就会失效。取凭据时请用无痕窗口登录，复制后直接关闭窗口（不要退出登录），之后这个登录只由 CPAN 使用。
- 凭据用 `APP_ENCRYPTION_KEY` 加密存储，页面和接口都不会返回凭据。

支持的导入格式（自动识别，可以混合粘贴）：

| 格式 | 示例 |
|---|---|
| **邮箱 + 密码**（仅支持密码登录的账号） | `user@example.com----密码`，或 JSON `{"email":"…","password":"…"}` |
| **Google 账号**（OAuth 注册的账号） | `user@gmail.com----Google密码----TOTP密钥`，或 JSON `{"googleEmail":"…","googlePassword":"…","totpSecret":"…"}`；gauth 的五段式 `邮箱----密码----辅助邮箱----TOTP----收件箱链接` 也能识别（后两段忽略） |
| logicc2api 导出的 JSON（数组、`{accounts:[…]}`、单个对象或 JSON Lines） | `[{"name":"账号1","clientCookie":"…","sessionId":"sess_…","enabled":true}]` |
| Cookie 请求头 | `__client=…; __session=eyJ…` |
| 分隔写法 | `__client值----sess_…`、`名称|__client值|sess_…`，也支持 Tab、空格、逗号分隔 |
| 只有 `__client` | 导入时向 Clerk 查询当前会话 |
| 只有 Session JWT | `eyJ…`（`sid` 即会话 ID） |
| 浏览器 Cookie 导出 | `[{"name":"__client","value":"…","domain":"clerk.logicc.com"}]` |

同一会话重复导入时，会更新凭据并保留原有分组。

## 邮箱密码自动登录

`__client` 由 Clerk 定期轮换，并且有最长有效期；会话到期后，带邮箱密码的账号可以用一次**正常登录**重新拿到会话，不用手动贴 Cookie。

- 登录就是 Logicc 网页登录时走的那套 Clerk 接口：`POST /v1/client/sign_ins`（邮箱）→ `POST …/attempt_first_factor`（`strategy=password`）。成功后响应里带回新的 `__client` 和会话 ID，写回数据库。
- 邮箱和密码用 `APP_ENCRYPTION_KEY` 加密存储，页面和接口都不回显，只显示打码的邮箱（如 `al***@gmail.com`）。
- 触发时机：某账号的 `__client` 失效、又没有别的方式续期时，按需登录一次；后台周期检测也会给「待登录」的账号重试。都有单飞锁和按账号的退避（人机验证 30 分钟、密码错误 6 小时、网络波动 5 分钟），不会反复打 Clerk。
- **遇到验证就停，绝不绕过。** 登录时若 Clerk 要求人机验证（captcha / Turnstile）、两步验证或邮箱验证码，账号标为「待登录」退出调度，等人工处理；系统不会尝试满足或绕过这些验证。
- 处理「待登录」：在账号页点「重新登录」立即再试一次（适合你刚在别处过完人机验证），或直接重新导入一份 `__client`。
- 仅适用于**开启了密码登录**的账号。用 Google 注册、且没有设过密码的账号走下面的 gauth 内核续期。
- 可在「Logicc 设置」里全局关闭自动登录，或在单个账号上关闭。

## Google 账号续期（logicc-gauth 小内核）

Google OAuth 注册的账号没有 Logicc 密码，密码登录这条路走不通。对这类账号，CPAN 用 **logicc-gauth 小内核**（`gauth/` 目录，独立容器 `gauth`，只在 Compose 内网可达）自动重走整套 OAuth：

```
Logicc 登录页 → Continue with Google → 邮箱 → 密码 → TOTP（pyotp 现算）
→ consent（同行 x 最大 = 确认）→ 回调建立会话 → 收割 __client + sessionId → 让出会话
```

- 内核是 `gauth/gauth.py`（patchright 反检测浏览器）加一层 stdlib HTTP 封装（`gauth/server.py`），对外只暴露 `GET /health` 和 `POST /v1/login`；浏览器流程**单飞**，正忙时返回 `busy`，模块按 2 分钟退避重试。
- 模块侧入口在 `server/modules/logicc/gauth.ts`：`LOGICC_GAUTH_URL` 指向内核（compose 里默认 `http://gauth:8320`），`LOGICC_GAUTH_TOKEN` 是可选的共享令牌。不配 URL 时 Google 续期整体停用，其余功能不受影响。
- Google 凭据（邮箱、密码、TOTP 密钥、可选的 onboarding 资料）同样用 `APP_ENCRYPTION_KEY` 加密存储，按 Google 邮箱去重；账号导入时给三件套即建号（初始「待登录」），首次内核登录后进入号池。
- 续期失败原因与密码登录一致：`needs_human`（Google 出现安全验证/手机验证等内核不认识的挑战，停下绝不绕过）→「待登录」；`bad_credentials`（密码或 TOTP 错误）→「凭证失效」；`transient` → 短退避后重试。退避时长比密码登录更长（网络波动 10 分钟），浏览器流程也用更长的单飞锁（10 分钟）。
- CLI 原功能全部保留：`python gauth.py 账号.json [--dry]` 直连本机调试 Chrome（`GAUTH_CDP`，默认 9222）跑同样的流程，产出 `accounts-out/<label>.json`，可直接粘进后台导入。
- **纪律不变：一个 `__client` 只给号池用。** 内核收割完立即让出会话（跳转 about:blank），浏览器不再触碰该登录，防止与号池竞争轮换 `__client`。


## 调度

- 只从请求被签名的分组里选号，并且排除已停用、未就绪、在冷却、或已确认不能用该模型的账号。
- 优先选进行中请求最少的账号，相同时轮询。每个账号有并发上限，0 表示不限；全部满载时返回 429。
- 冷却时长：429 为 60 秒，额度或套餐限制 300 秒，凭据被拒 300 秒，被防火墙拦截 120 秒，上游或网络错误 15 秒。
- 一个请求在第一个字输出前失败，会换下一个账号，最多尝试「单次请求最多尝试账号数」次。已经开始输出之后再失败，就在响应流里报告错误。
- 后台每 10 秒处理一批到期账号（每批 36 个、6 个并发）：刷新会话并读取模型目录，大约 10 分钟可以覆盖 2000 个账号。

## 用量计算

Logicc 不返回 usage，而 CPAN 前面是按用量收费的 New API，所以 usage 在模块内计算。规则是**宁可多算，绝不少算**：

```
输入 = ⌈本地计数(发给 Logicc 的完整提示 + Logicc 内置工具回灌的结果) × 输入倍率⌉ + 固定输入开销
输出 = ⌈本地计数(正文 + 思考内容 + 工具调用 JSON) × 输出倍率⌉ + 固定输出开销
```

- 「发给 Logicc 的完整提示」已经包含服务分组的酒馆预设、拍平后的全部历史和工具说明。不走酒馆的请求按客户原始内容计数，走酒馆的请求，预设部分也会计入。
- 本地计数使用 o200k 分词器，对 GPT 系列和官方一致。Claude、Gemini 没有公开的本地分词器，用 ≥1 的倍率放大（默认 1.25、1.15）；其他模型默认 1.3。
- 固定开销（默认输入 256、输出 8）用来覆盖 Logicc 自己加在提示外、平台看不到的隐藏指令。
- 配置 Anthropic 或 Gemini 的计数 Key 后，模块会在生成的同时调用官方免费计数接口，计费取官方计数和本地估算中**较大**的值。开启自动校准后，如果官方计数超过「本地计数 × 倍率」，就自动调高该族的倍率；倍率只会调高，不会调低。
- Logicc 自己返回了 usage 时，取它和本地结果中较大的值。
- 流式响应在 `[DONE]` 前一定会发送 usage chunk，不管客户端有没有要求。客户端只收到 `prompt_tokens`、`completion_tokens`、`total_tokens` 三个标准字段，计算方式（分词族、倍率、本地计数）只记在请求日志的路由信息里，不会传给你的客户。

## 客户端看到的错误

模型 API 的调用者看不到请求实际去了哪里。平台、CPA、模块或上游返回的错误，在发给客户端前统一经过 `server/lib/public-errors.ts`：

- 只发英文。无法清理的中文说明换成按状态码给出的英文通用说明，例如 503 是 `Service temporarily unavailable, please retry later`。
- 网址、域名、IP、邮箱，以及 Logicc、Clerk、CPA、桥接渠道名和各类接入名一律换成 `***`；错误码里如果出现这些名称，换成标准错误码（如 `service_unavailable`）。
- 成功响应里的桥接别名 `logicc/<模型>` 会换回模型原名；`/v1/models` 的 `owned_by` 显示模型厂商（openai、anthropic、google…），不显示渠道。
- 详细原因（中文、含渠道）只保存在请求日志和账号状态里，供管理员排查。

## 能力边界

- Logicc 没有原生 function calling。工具调用通过提示词模拟，再把模型的回答解析成标准 `tool_calls`；参数不符合 schema 时返回错误，不会把错误结果当成调用。重度工具客户端（Claude Code、Codex）建议在模块设置里把「客户端工具调用」改为「不处理」，这类请求会交给其他来源。
- 图片、音频、文件以及 `response_format` 结构化输出不支持，模块会把这类请求让给其他来源（`nexus_source_unsupported`）。
- 每个请求在 Logicc 新建一个对话，多轮历史被拍平成一个提示，所以长对话的输入会随轮数增长，计费也会如实反映这一点。
- `web_search`、`image_generation` 映射到 Logicc 内置工具。

## 设置与数据

- 模块设置保存在 `nexus_module_settings`，计数 Key 加密存储，只写不读。
- 账号表是 `logicc_accounts`，自动校准记录在 `logicc_usage_calibration`。
- 请求日志的 `module_id='logicc'`、`source_id=<账号 ID>`；路由信息里有 `usageSource` 和 `usageDetail`。

## 测试

`tests/logicc-*.test.ts` 覆盖了以下内容：
- 导入格式解析
- Clerk 刷新的单飞与 Cookie 轮换
- 号池在真实 PostgreSQL 上的分组隔离
- 网关对接假 Logicc 服务：流式与非流式、换号、冷却、工具解析、usage 只多不少、能力边界、并发满载

`tests/cpa-inference.test.ts` 覆盖桥接路由、签名请求头和 failover；`tests/module-bridges.test.ts` 覆盖内核只改自己的渠道。
