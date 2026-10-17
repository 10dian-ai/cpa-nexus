# logicc-gauth — Logicc Google OAuth 自动登录/注册机

补 CPA Nexus Logicc 模块的缺口：**Google OAuth 注册的账号无法用邮箱密码续期**。
本工具用企业 Google 账号（邮箱 + 密码 + TOTP 密钥）自动走完 OAuth，产出
`{ clientCookie, sessionId }`，兼容 CPAN 与 logicc2api 的导入格式。

## 原理（2026-10-17 全流程实测固化）

```
1. Clerk FAPI：POST /v1/client/sign_ins (strategy=oauth_google, redirect_url)
   → 返回 Google 授权 URL（协议层不被拦；注册用 sign_ups，可能被风控时改走 UI 按钮）
2. patchright 打开授权 URL（反检测浏览器，过 Clerk/Google 指纹检查）
3. Google 登录自动化：邮箱 → 密码 → TOTP（pyotp 现算，时钟敏感）→ consent 继续
4. 回调建立会话 → 从浏览器上下文读取 __client（httpOnly 可读）+ sessionId
5. 立即关闭 Logicc 页面（防浏览器与号池竞争轮换 __client）
```

## 用法

```bash
# 单号登录（account.json 见 accounts-sample.json 格式）
python gauth.py login account.json

# 新号注册（register 意图；sign_ups 被风控时自动降级 UI 点击）
python gauth.py signup account.json

# 批量（每号一个 JSON 或一个 JSON 数组文件）
python gauth.py batch accounts.jsonl
```

输出（stdout JSON + accounts-out/*.json）：CPAN 导入格式
`{"clientCookie": "...", "sessionId": "sess_..."}`，可直接粘贴进
CPAN 后台或 `POST /api/external/modules/logicc/accounts`。

## 纪律（沿用 CPAN）

- Google 侧出现本工具不认识的挑战（安全验证/手机验证/恢复邮箱）→ 停下报
  `needs_human`，绝不绕过；
- 一个 `__client` 只给号池用：工具拿完凭证立即关页面，不再触碰该会话；
- 失败分类：`needs_human` / `bad_credentials` / `transient`，与 CPAN 语义一致。

## 作为 CPAN 模块小内核（v5 新增）

本目录整体作为一个独立容器（`gauth`）随 CPAN 部署：`gauth.py` 原样保留全部
CLI 功能，`server.py` 用 stdlib 把它包成 HTTP 小内核，供 Logicc 模块在
`__client` 失效时自动续期 Google 注册的账号。

- 接口：`GET /health`、`POST /v1/login`（body：`label/googleEmail/googlePassword/totpSecret[/firstName/lastName/company]`；
  返回 `{ok,sessionId,clientCookie}` 或 `{ok:false,reason,message}`，reason ∈
  `needs_human / bad_credentials / transient / busy`）。
- 浏览器：容器内默认 `GAUTH_LAUNCH=1`（patchright 自启无头 Chromium，用完即关）；
  本机调试仍走 `GAUTH_CDP`（默认 9222）连调试 Chrome，行为与 v4 完全一致。
- 单飞：同一时刻只跑一个浏览器流程，并发请求收到 `busy`（HTTP 409）。
- 可选 `GAUTH_TOKEN` 与 CPAN 侧 `LOGICC_GAUTH_TOKEN` 对齐做内网鉴权。

对接细节见仓库 `docs/logicc-module.md` 的「Google 账号续期」一节。
