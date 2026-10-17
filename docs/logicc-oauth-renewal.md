# Logicc OAuth 账号会话续期（gauth 工具 + 流程）

> 针对 [Logicc 模块](logicc-module.md)「邮箱密码自动登录」一节承认的局限：
> **用 Google 等 OAuth 注册、且没有设过密码的账号**，`__client` 过期后
> `canAutoLogin` 直接拒绝（无 `loginEmail/loginPassword`），只能人工重新导出。
> 本目录提供一个实战验证过的半自动续期工具与操作流程。

## 原理

Logicc 的会话由 Clerk 管理。OAuth 账号虽然不能用密码走
`POST /v1/client/sign_ins → attempt_first_factor (strategy=password)`，
但 **OAuth 登录本身走的也是 Clerk**：
`POST /v1/client/sign_ins (strategy=oauth_google, redirect_url=…)` 会返回
Google 授权 URL；完成 Google 登录并回调后，Clerk 建立（或恢复）会话并下发
新的 `__client`。因此：**用账号绑定的 Google 凭据（邮箱+密码+TOTP）自动完成
一次 OAuth 登录，即可产出全新的 `__client` 喂回号池**——与「邮箱密码自动
登录」等价，只是中段发生在 Google。

## 工具

`gauth.py`（patchright + pyotp，Python 3.10+）：页面状态驱动 + JS 整页判断
+ CDP 坐标输入（trusted 事件），一步一验。连接一个**独立的调试 Chrome**
（`--remote-debugging-port=9222`，独立 user-data-dir），全程不碰日常浏览器。

```bash
python gauth.py 账号.json            # 登录/注册自适应（未注册自动走注册）
python gauth.py 账号.json --dry      # 跑到 Google 授权页停下，人工接管调试
```

账号 JSON 字段：`label` / `googleEmail` / `googlePassword` / `totpSecret`
（企业 Google 账号三件套；TOTP 现算，依赖**本机时钟准确**）。

流程（每步整页 JS 判断，日志实时打印控件清单）：

```
Logicc 登录页 → 坐标点「Continue with Google」→ Google 授权页
→ 邮箱（#identifierId）→ 密码（input[type=password]）→ TOTP（pyotp 现算）
→ consent（同行按钮 x 最大 = 确认键，跨语言）→ 回调建会话
→ 读取 __client + sessionId → 输出并立即让出会话
```

中途遇到本工具不认识的挑战（Google 安全验证/手机验证/恢复邮箱等）即停，
报 `needs_human`，人工完成后从当前页面继续——绝不绕过。

## 操作流程（续期一个 OAuth 号）

1. 启动调试 Chrome（独立目录，避免污染日常浏览器）：

   ```sh
   chrome.exe --remote-debugging-port=9222 --user-data-dir=<空目录> --lang=en-US
   ```

2. `python gauth.py 账号.json`，等它自动完成 Google 登录与回调。
3. 从输出/`accounts-out/<label>.json` 取 `__client ---- sessionId`，
   按[导入格式](logicc-module.md)粘回 CPAN（或经外调 API 提交）。
4. **会话让出**：工具已自动导航离开 Logicc 页面；此后该 `__client` 只归
   CPAN 使用，浏览器不要再打开 Logicc（避免轮换竞争使两边同时失效）。

## 实测记录（2026-10-17）

- sam275（独立组织）：裸号 → OAuth 注册 → 条款 → onboarding → 主界面，
  全程本工具驱动（零脚本外人工操作）；`__client` 导入号池后模型请求实测成功。
- 踩坑记录：TOTP 依赖本机时钟（偏差 >30s 全错，先校时）；consent 页语言跟随
  账号设置（按结构定位，不猜文案）；`sign_ups` 创建端点在本机被 Clerk Attack
  Protection 间歇拦截（403 action_blocked）时自动降级为 UI 按钮点击。

## 边界

- Google 侧出现本工具不认识的挑战（手机验证/恢复邮箱/异常活动检查）→
  停下报 `needs_human`，人工完成后继续；不自动绕过任何人机验证。
- 企业 Workspace 账号若被管理员策略限制 OAuth 第三方授权，同样停下报告。
