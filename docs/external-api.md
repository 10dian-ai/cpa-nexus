# 外调服务 API 与公网加号页

外调 API 是 CPAN 的平台功能，不属于某个模块。持有外调服务 Key 的人或程序可以给 CPA 内核和 Logicc 等模块远程加号、查询导入进度和池子状态。服务器 3041 端口上的公网加号页面使用的是同一组接口。

## 外调服务 Key

在 **API Key → 创建 API Key** 中选择「外调服务 API Key」，勾选它可以加号的模块（默认全部）。完整密钥只显示一次，以 `ccm_service_` 开头。

- 外调 Key 只能访问 `/api/external/*`，不能调用模型；模型 Key 和后台登录也不能访问外调接口。
- Key 的模块范围可以随时修改，停用或撤销立即生效。
- 某个模块停用时，给它加号会返回 503，Key 本身和其他模块不受影响。
- 安全限制：同一来源地址 10 分钟内验证失败 30 次后锁定 10 分钟（返回 429）；每个 Key 每分钟最多 240 次请求。3041 端口另有按地址的 nginx 限速。

请求头二选一：

```http
Authorization: Bearer ccm_service_你的完整密钥
x-api-key: ccm_service_你的完整密钥
```

## 公网加号页面（3041）

`compose.yml` 让 edge（nginx）额外监听 `${INTAKE_BIND_ADDRESS:-0.0.0.0}:${INTAKE_PORT:-3041}`。这个端口上**只有两样东西**：加号页面（`ops/intake/`，纯静态）和 `/api/external/*`。管理后台、模型接口和模块桥接在这个端口上都不存在；转发时会去掉 Cookie、Origin、Referer。

使用流程：打开 `http://服务器:3041/`，输入外调 Key，选择模块（只显示这把 Key 能加号的模块），然后粘贴账号或上传文件，提交后实时显示进度和每条失败的原因。Key 只保存在当前标签页，关闭即清除。

正式对公网开放时，建议用 1Panel 的反向代理为 3041 加 HTTPS，并把 `INTAKE_BIND_ADDRESS` 改为 `127.0.0.1`，只让反代访问。

## 接口

外部调用使用站点根地址，不要加 `/v1`。

```sh
export CCM_URL='http://服务器:3041'
export CCM_SERVICE_KEY='ccm_service_…'
```

### 可加号的模块

`GET /api/external/modules`

```json
{
  "key": { "name": "远程加号" },
  "modules": [
    { "id": "logicc", "name": "Logicc", "enabled": true, "accept": ".json,.txt,.csv",
      "formats": [{ "id": "client-session", "label": "__client + Session ID", "description": "…", "example": "…" }] },
    { "id": "cpa", "name": "CPA 内核", "enabled": true, "accept": ".json,.txt,.csv,.jsonl", "formats": [ … ] }
  ]
}
```

### 加号

`POST /api/external/modules/{moduleId}/accounts`

| 字段 | 类型 | 含义 |
|---|---|---|
| `text` | string | 粘贴的内容：每行一个账号，或一个 JSON 文档，格式自动识别 |
| `files` | `{name, content}[]` | 上传的文本文件，最多 500 个，按同样的规则识别 |
| `items` | unknown[] | 结构化条目，例如 `[{"clientCookie":"…","sessionId":"sess_…"}]` |
| `groupIds` | uuid[] | 可选。新账号加入这些调用分组；不传则进入模块的默认分组。已存在的账号保留原分组 |

至少要提供 `text`、`files`、`items` 中的一项，单次请求最大 32 MB。

```sh
curl --fail-with-body "$CCM_URL/api/external/modules/logicc/accounts" \
  -H "Authorization: Bearer $CCM_SERVICE_KEY" -H 'Content-Type: application/json' \
  --data '{"text":"__client值----sess_xxxxxxxx\n__client值2----sess_yyyyyyyy"}'
```

返回 **202**（有条目入队）或 **200**（没有需要导入的条目）：

```json
{ "jobId": "…", "moduleId": "logicc", "accepted": 2, "rejected": 1, "duplicates": 0,
  "errors": [{ "line": 3, "message": "Session JWT 已过期；请同时提供 __client Cookie 以自动续期" }] }
```

- `accepted`：通过格式校验、去重后交给 Worker 的数量。
- `rejected` 和 `errors`：格式错误的条目。行号的计算顺序是：先粘贴文本，再逐个文件，最后是结构化条目。
- `duplicates`：本次提交内重复的条目，以及池中已有的条目。

### 导入进度

`GET /api/external/jobs/{jobId}`

```json
{ "id": "…", "moduleId": "logicc", "status": "completed", "progress": { "processed": 2, "total": 2 },
  "result": { "imported": 1, "updated": 1, "skipped": 0, "failed": 0, "errors": [] }, "error": null }
```

Worker 会逐条验证：Logicc 会刷新会话并读取模型目录，CPA 会把凭证写入内核。验证失败的条目计入 `failed` 并附上原因。导入失败不会删除已有账号。只能查询这把 Key 有权限的模块的任务。

### 查询

| 接口 | 内容 |
|---|---|
| `GET /api/external/modules/{id}/accounts?page=1&pageSize=50&q=` | 模块账号列表，不含任何凭据 |
| `GET /api/external/modules/{id}/pool` | 池子计数（总数、可用、需处理、模型覆盖等） |

### 各模块接受的格式

**Logicc**：`__client` + Session ID、Cookie 请求头、Session JWT、邮箱 + 密码（`user@example.com----密码`），或 logicc2api 的 JSON。详见 [Logicc 模块](logicc-module.md#账号与凭据)。邮箱密码会在会话失效时用正常登录自动续期。

**CPA 内核**：

| 格式 | 示例 | 写入位置 |
|---|---|---|
| CPA 或各 CLI 导出的 OAuth 凭证 JSON（Codex、Claude、Gemini、Qwen、iFlow、Antigravity 等） | `{"type":"codex","email":"…","access_token":"…"}` | 内核凭证库 |
| Google 服务账号 JSON（可带 `location`） | `{"type":"service_account","client_email":"…","private_key":"…"}` | Vertex 导入 |
| API Key，每行一个，自动识别 | `AIza…` → Gemini，`sk-ant-…` → Claude，`xai-…` → xAI，`sk-…` → OpenAI/Codex | 渠道配置 |
| 指定渠道 | `claude|sk-ant-…|https://relay.example.com|socks5://proxy` | 渠道配置 |
| OpenAI 兼容渠道 | `openai-compatibility|名称|sk-…|https://api.example.com/v1` | 渠道配置 |
| Key JSON | `{"provider":"gemini","apiKey":"AIza…","baseUrl":"…","prefix":"team"}` | 渠道配置 |

Key 会追加到对应渠道族中名为 `remote-intake`（或你指定名称）的分组里，已经存在的 Key 会跳过；内核保留的 `nexus-` 名称不能使用。写入 CPA 配置的操作在内核层串行执行，并且只改动目标渠道族。

## 兼容旧接口

`POST /api/external/accounts` 仍然可用：`text`、`token`、`cookie` 会合并成粘贴内容，用 `moduleId` 指定模块；如果 Key 只能给一个模块加号，可以省略 `moduleId`。新脚本请改用 `/api/external/modules/{id}/accounts`。

后台导入（各模块的「导入账号」）调用 `POST /api/modules/{id}/import`，和外调接口使用同一套解析、队列和 Worker。
