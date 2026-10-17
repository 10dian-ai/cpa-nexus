# logicc-gauth 交付说明（对接 CPAN）

## 产出格式

每个号产出 `accounts-out/<label>.json`：

```json
{ "name": "账号标签", "sessionId": "sess_…", "clientCookie": "eyJ…" }
```

与 CPAN / logicc2api 的导入格式完全兼容。

## 喂进 CPAN（三选一）

**1. 后台粘贴**：CPAN 管理后台 → Logicc 模块 → 导入，粘贴
`__client值----sess_xxx`（分隔写法 CPAN 自动识别）。

**2. 外调 API**（服务器上自动化）：

```sh
curl --fail-with-body "$CCM_URL/api/external/modules/logicc/accounts" \
  -H "Authorization: Bearer $CCM_SERVICE_KEY" -H 'Content-Type: application/json' \
  --data "{\"text\":\"__client值----sess_xxx\"}"
```

**3. 结构化 items**：

```json
{ "items": [{ "clientCookie": "…", "sessionId": "sess_…" }] }
```

## 运行要求

- 调试 Chrome：`chrome.exe --remote-debugging-port=9222 --user-data-dir=<独立目录>`（登录态留在
  该浏览器；一个会话收割后立即让出，只给号池用——浏览器别再打开 Logicc，防 __client 轮换竞争）
- 依赖：Python 3.10+、patchright、pyotp（commendcodego 的 venv 已含）
- 账号资料行：`企业邮箱----Google密码----辅助邮箱----TOTP密钥----收件箱链接`

## 已验证环节（2026-10-17，sam275 全程）

Google OAuth（邮箱/密码/TOTP 坐标输入）→ 德语 consent（同行 x 最大=确认键）
→ Logicc 条款页（role=checkbox 勾选）→ onboarding（下拉/公司名）→ __client 收割
（Clerk API 查 sid 兜底）→ 号池 ready → 真实对话 ✓

## 纪律

- 遇到不认识的挑战（Google 安全验证/手机验证等）→ 停下报 needs_human，绝不绕过；
- `--dry` 参数：跑到授权页停下等人工接管（调试用）。
