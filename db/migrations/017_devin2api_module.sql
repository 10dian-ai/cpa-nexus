-- Devin 2API is an extension module.  Keep its account bindings and
-- credentials separate from managed_accounts, which belongs to CommandCode.
-- The module id is intentionally `devin2api` so it cannot be confused with
-- CPA's native Devin OAuth provider.

ALTER TABLE gateway_keys DROP CONSTRAINT IF EXISTS gateway_keys_module_id_check;
ALTER TABLE gateway_keys ADD CONSTRAINT gateway_keys_module_id_check
  CHECK(module_id IN ('auto','cpa','commandcode','devin2api'));

ALTER TABLE nexus_account_groups DROP CONSTRAINT IF EXISTS nexus_account_groups_module_id_check;
ALTER TABLE nexus_account_groups ADD CONSTRAINT nexus_account_groups_module_id_check
  CHECK(module_id IN ('commandcode','cpa','devin2api'));

ALTER TABLE nexus_module_group_defaults DROP CONSTRAINT IF EXISTS nexus_module_group_defaults_module_id_check;
ALTER TABLE nexus_module_group_defaults ADD CONSTRAINT nexus_module_group_defaults_module_id_check
  CHECK(module_id IN ('commandcode','cpa','devin2api'));

-- The CPAN app owns the embedded Devin runtime. Only the encrypted token is
-- persisted here; plaintext credentials never enter the database.
CREATE TABLE IF NOT EXISTS devin2api_accounts (
 id UUID PRIMARY KEY,
 label TEXT NOT NULL DEFAULT '',
 -- Nullable permits an account to be created before credentials are entered;
 -- when present this value is always encrypted by the application layer.
 token_ciphertext TEXT,
 base_url TEXT DEFAULT 'https://server.codeium.com',
 model TEXT DEFAULT '',
 proxy TEXT,
 enabled BOOLEAN NOT NULL DEFAULT true,
 status TEXT NOT NULL DEFAULT 'pending'
   CHECK(status IN ('pending','ready','disabled','credential_expired','sync_error')),
 max_concurrency INTEGER NOT NULL DEFAULT 2 CHECK(max_concurrency BETWEEN 1 AND 100),
 snapshot JSONB,
 sync_error TEXT,
 last_sync_at TIMESTAMPTZ,
 last_used_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devin2api_accounts_poll
 ON devin2api_accounts(status,last_sync_at);
CREATE INDEX IF NOT EXISTS devin2api_accounts_enabled
 ON devin2api_accounts(enabled,updated_at DESC);

-- This is the only log metadata needed to distinguish a Devin request from a
-- native CPA/CommandCode request.  Existing rows remain valid and retain a
-- null module id for backwards-compatible historical display.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS module_id TEXT;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS source_id TEXT;
CREATE INDEX IF NOT EXISTS request_logs_module
 ON request_logs(module_id,created_at DESC);
CREATE INDEX IF NOT EXISTS request_logs_source
 ON request_logs(source_id,created_at DESC);

INSERT INTO platform_modules(id,enabled)
 VALUES('devin2api',false)
 ON CONFLICT(id) DO NOTHING;

-- Give the extension its own default group.  A pre-existing group with the
-- same name is reused so migrations remain idempotent for restored databases.
INSERT INTO nexus_groups(id,name,description)
 SELECT gen_random_uuid(),'Devin','Devin 2API 账号的默认调用组'
 WHERE NOT EXISTS(
   SELECT 1 FROM nexus_groups WHERE lower(name)='devin'
 )
 ON CONFLICT(name) DO NOTHING;
INSERT INTO nexus_module_group_defaults(module_id,group_id)
 SELECT 'devin2api',id FROM nexus_groups
 WHERE lower(name)='devin'
 ORDER BY is_default DESC,created_at,id LIMIT 1
 ON CONFLICT(module_id) DO NOTHING;

-- Keep model-key defaults backwards compatible. Devin access is granted by
-- explicitly selecting the Devin group; installing the extension must not
-- silently widen existing or newly created client keys.
CREATE OR REPLACE FUNCTION nexus_bind_default_key_group() RETURNS trigger AS $$
BEGIN
 IF left(NEW.prefix,10)<>'ccm_nexus_' THEN
  INSERT INTO nexus_key_groups(key_id,group_id)
  SELECT NEW.id,group_id FROM nexus_module_group_defaults
  WHERE module_id IN ('commandcode','cpa') ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- New account rows receive the module default group in the same way that
-- managed_accounts receive the CommandCode default group.  API code may later
-- replace that membership with an explicit set of groups in one transaction.
CREATE OR REPLACE FUNCTION nexus_bind_default_devin2api_group() RETURNS trigger AS $$
BEGIN
 INSERT INTO nexus_account_groups(module_id,account_id,group_id)
 SELECT 'devin2api',NEW.id::text,group_id
 FROM nexus_module_group_defaults WHERE module_id='devin2api'
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS nexus_default_devin2api_account_group ON devin2api_accounts;
CREATE TRIGGER nexus_default_devin2api_account_group
 AFTER INSERT ON devin2api_accounts FOR EACH ROW
 EXECUTE FUNCTION nexus_bind_default_devin2api_group();

CREATE OR REPLACE FUNCTION nexus_cleanup_devin2api_groups() RETURNS trigger AS $$
BEGIN
 DELETE FROM nexus_account_groups
 WHERE module_id='devin2api' AND account_id=OLD.id::text;
 RETURN OLD;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS nexus_cleanup_devin2api_account_group ON devin2api_accounts;
CREATE TRIGGER nexus_cleanup_devin2api_account_group
 AFTER DELETE ON devin2api_accounts FOR EACH ROW
 EXECUTE FUNCTION nexus_cleanup_devin2api_groups();
