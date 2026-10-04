# Implementation contract

Node 24 / Nuxt 4, root owns package/config, infrastructure and auth.
Types are in shared/types.ts; DTOs use camelCase, DB uses snake_case.

## Admin API (session authentication; auth/session and auth/login are public)
- GET /api/auth/session -> { authenticated, username }
- POST /api/auth/login {username,password}; POST /api/auth/logout
- GET /api/dashboard -> DashboardView
- GET /api/accounts?q=&status=&group=&page=1&pageSize=50 -> {items:AccountView[],total,page,pageSize,groups:string[]}
- POST /api/accounts/import {text,groupName?,groupIds?:string[]} -> {jobId,accepted,rejected,duplicates}; groupName is a legacy annotation, groupIds control source routing.
- GET /api/jobs/:id -> JobView
- GET /api/accounts/:id -> AccountView
- PATCH /api/accounts/:id {label?,groupName?,groupIds?,note?,enabled?,maxConcurrency?} -> AccountView with groupIds and groupNames.
- POST /api/accounts/actions {ids,action:'refresh'|'enable'|'disable'|'delete'} -> {ok:true,affected}
- GET /api/models -> {items:ModelView[],updatedAt:string|null}
- GET /api/service-keys -> {items:GatewayKeyView[]}; POST {name} -> {key:string,item:GatewayKeyView} (independent external service keys)
- PATCH /api/service-keys/:id {name?,enabled?} -> {ok:true}; DELETE /api/service-keys/:id -> {ok:true}
- GET /api/keys -> {items:GatewayKeyView[]}; POST {name,groupIds?:string[],presetEnabled?:boolean} -> {key:string,item:GatewayKeyView}. New model keys use cross-module routing (`moduleId:'auto'`) and ordinary calls (`presetEnabled:false`). Omitted groupIds select both persistent module default groups; explicit empty or unknown IDs are rejected. Key, group membership and stack/bypass selection commit in one transaction. Legacy moduleId input remains accepted for compatibility; new writes use auto.
- PATCH /api/keys/:id {name?,enabled?,groupIds?,presetEnabled?} -> {ok:true,moduleId}; DELETE /api/keys/:id -> {ok:true}. `presetEnabled:true` applies all enabled presets in order; false bypasses them. Omission preserves the saved route and groups. Name, groups and preset changes are atomic. A stopped preset module allows saving the choice for later activation. Internal ccm_nexus_ bridge keys stay hidden and immutable.
- GET /api/groups -> {items:GroupView[],defaultGroupId,defaultGroupIds:string[],moduleDefaultGroupIds:{commandcode,cpa}}; POST {name,description?,enabled?}; PATCH /api/groups/:id {name?,description?,enabled?}; DELETE rejects global defaults, persistent module defaults or referenced groups. New model keys default to both module groups; new source accounts default to their own module group.
- GET /api/groups/accounts -> {items:GroupAccountView[]}; PATCH {moduleId:'cpa'|'commandcode',sourceType,sourceId,groupIds:string[]} updates source membership. DELETE accepts only missing CPA sources after fresh inventory verification, removing retained memberships without deleting a CPA source.
- GET /api/presets/routes -> {bindings:KeyPresetBinding[]}; PUT {keyId,mode:'inherit'|'stack'|'preset'|'bypass',presetId?} -> {binding:KeyPresetBinding|null}. New UI routes use stack/bypass with null presetId; legacy single-preset payloads remain compatible. An unbound model key runs directly; account and module preset records are not inherited.
- GET /api/logs?page=&pageSize=&model=&status= -> {items:RequestLogView[],total,page,pageSize}
- GET /api/logs/:id -> RequestLogView & {requestBody:unknown,responseBody:unknown,sessionId:string|null}
- GET /api/settings -> {settings:SystemSettings,kernel:{version,upstreamCommit,cliVersion}}
- PATCH /api/settings (SystemSettings) -> same shape as GET
- GET /api/events -> SSE "update" JSON {type,accountId?}; keepalive.

## External service API

All `/api/external/` routes require a dedicated `ccm_service_` key via `Authorization: Bearer KEY` or `x-api-key: KEY`, and require an enabled CommandCode module. Admin sessions and model keys do not authorize these routes. External service keys cannot authorize `/v1/` or admin API routes. Both types are managed on one page; service-key creation requires an enabled CommandCode module. Model-key group choices remain editable while a source module is stopped. Existing keys can still be listed, renamed, disabled or revoked.

- POST /api/external/accounts {text|token|cookie,groupName?,groupIds?} -> HTTP 202 {jobId,accepted,rejected,duplicates}; exactly one credential field is required. Uses the same encrypted asynchronous import queue and group validation as the admin UI.
- GET /api/external/accounts?q=&status=&group=&page=1&pageSize=50 -> {items:AccountView[],total,page,pageSize,groups:string[]}; same validation and stored account data as the admin list, including nullable email. Includes disabled accounts unless filtered; no upstream refresh or credential export.
- GET /api/external/accounts/:id -> AccountView including email and observedModels; UUID validation and 404 for a missing account.
- GET /api/external/jobs/:id -> JobView (404 after the queue job expires).
- GET /api/external/pool -> DashboardView, using the same stored database and Redis state as the admin dashboard. `ready` counts enabled, successfully synced accounts with an API key and no exhausted quota in their stored snapshot; it does not guarantee model access or a free concurrency slot; `lastSyncAt` indicates the latest account sync, not that every account was refreshed then.

See [external-api.md](external-api.md) for request examples, limits and status semantics.

## Shared backend imports root provides
server/lib/config.ts: getConfig() -> {databaseUrl,redisUrl,encryptionKey,adminUsername,adminPassword,appUrl,kernelUrl}
server/lib/db.ts: getDb() -> postgres.Sql; closeDb()
server/lib/redis.ts: getRedis() -> ioredis.Redis; createRedisConnection() -> Redis; closeRedis()
server/lib/crypto.ts: encryptSecret(string), decryptSecret(string), fingerprint(string), hashGatewayKey(string)
server/lib/settings.ts (data agent): getSettings():Promise<SystemSettings>, saveSettings(SystemSettings)
server/lib/queues.ts (data agent): enqueueAccountRefresh(accountId,{reason?,force?}?), getImportQueue()
server/lib/events.ts (root): publishUpdate({type,accountId?})
server/lib/logs.ts (root): insertRequestLog(input) and pagination via SQL
server/lib/auth.ts (root): requireAdmin(event), authenticateGatewayKey(secret):Promise<AuthenticatedModelKey|null>, findEnabledModelKey(id):Promise<AuthenticatedModelKey|null>, requireModelKeyModule(key,moduleId), requireServiceKey(event), authenticateServiceKey(secret):Promise<{id,name}|null>. AuthenticatedModelKey includes id, name and moduleId ('auto'|'cpa'|'commandcode'); legacy fixtures without the field retain CommandCode semantics. Runtime group permissions are re-read from the database rather than stored in the caller snapshot.

## DB schema contract (data agent owns SQL migration)
managed_accounts: id UUID, upstream_user_id TEXT UNIQUE, credential_fingerprint TEXT UNIQUE,
label TEXT, email TEXT NULL, cookie_ciphertext TEXT, api_key_ciphertext TEXT NULL, api_key_id TEXT NULL,
group_name TEXT DEFAULT '', note TEXT DEFAULT '', enabled BOOL, status TEXT (pending/ready/credential_expired/sync_error),
max_concurrency INT, snapshot JSONB NULL, sync_error TEXT NULL, last_sync_at TIMESTAMPTZ NULL,
last_used_at TIMESTAMPTZ NULL, created_at/updated_at TIMESTAMPTZ.
account_models: account_id UUID FK, model_id TEXT, status TEXT(allowed/denied/cooldown),
reason TEXT NULL, cooldown_until TIMESTAMPTZ NULL,last_checked_at TIMESTAMPTZ, PK(account_id,model_id).
model_catalog: model_id TEXT PK,name TEXT,metadata JSONB,updated_at TIMESTAMPTZ.
gateway_keys: id UUID,name TEXT,prefix TEXT,secret_hash TEXT UNIQUE,enabled BOOL,module_id TEXT CHECK IN ('auto','cpa','commandcode') DEFAULT 'auto',created_at,last_used_at NULL; migration 013 makes platform keys cross-module and retains the dedicated internal bridge.
nexus_groups: id UUID,name TEXT UNIQUE,description TEXT,enabled BOOL,is_default BOOL,created_at,updated_at. nexus_account_groups: module_id,account_id TEXT,group_id UUID; nexus_key_groups: key_id UUID,group_id UUID. Both memberships are many-to-many; source/key intersection and enabled group state control routing. Migration 013 defaults existing keys/accounts and adds account cleanup/default-binding triggers.
service_keys: id UUID,name TEXT,prefix TEXT,secret_hash TEXT UNIQUE,enabled BOOL,created_at,last_used_at NULL; separate table for external service credentials (migration 002_service_keys.sql).
nexus_key_preset_bindings: key_id UUID PRIMARY KEY REFERENCES gateway_keys ON DELETE CASCADE,mode TEXT ('stack'|'preset'|'bypass'),preset_id UUID NULL,updated_at; stack and bypass have no preset_id. Ordered multi-preset routing is introduced by migration 012.
app_settings: id INT PK=1,value JSONB,updated_at.
request_logs: id UUID,key_id UUID NULL,account_id UUID NULL,model TEXT,protocol TEXT,
session_id TEXT NULL,status TEXT,http_status INT NULL,duration_ms INT,streaming BOOL,
usage JSONB NULL,error_message TEXT NULL,request_body JSONB NULL,response_body JSONB NULL,
response_truncated BOOL DEFAULT FALSE,created_at TIMESTAMPTZ.

## Gateway (gateway agent)
server/routes/v1/[...path].ts selects the internal CommandCode bridge handler or unified public model handler. Public HTTP GET models and POST chat/completions,messages,responses use grouped ccm_ model keys with cross-module routing. Catalogs are the union of permitted enabled sources; requests and retries stay within those sources. System One uses a grouped CommandCode source. Historical native CPA keys retain direct core authentication; WebSocket and other native protocols still require those keys and do not use per-key presets.
The platform authenticates model keys against PostgreSQL and forwards CPA requests with its private CPA_CLIENT_KEY. The historical config/access/api-keys node preserves this key during PUT/PATCH/DELETE, and GET marks its zero-based index in x-nexus-reserved-key-index without changing the string[] response. Full JSON/YAML configuration edits must retain it explicitly.
For CommandCode, select an account with Redis atomic global+per-account lease, affinity by client session headers/prompt_cache_key. Signed original model-key identity is rechecked on callbacks for enabled state and current group permissions before account execution.
Respect actual MODEL_NOT_IN_PLAN independent of HTTP401. Unknown models can be attempted, observed denials excluded.
Never retry ambiguous execution failures or restart a stream. Preserve content and structured usage.
The root supplies auth/logging functions; data agent supplies queues/settings.
No test credentials in source, no public exposing PostgreSQL/Redis/core, no core automatic update.

- DashboardView.quota contains accountCount and fiveHour/weekly/monthly totals: used, cap, remaining, knownAccounts, unknownAccounts. Missing window data is excluded from totals and counted independently.
- AccountView exposes quotaPaused and quotaResumeAt. Manual disable cancels automatic recovery; enabling a quota-paused account requests an immediate refresh and keeps it paused until recovery is confirmed.
