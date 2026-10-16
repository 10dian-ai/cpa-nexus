-- CommandCode is removed and Logicc becomes the platform's account-pool module.
--
-- * Module bridges into CPA are owned by the kernel layer (nexus_module_bridges);
--   modules no longer hold CPA channel credentials or write kernel configuration.
-- * CommandCode accounts, its official catalog, bridge keys and logs are deleted.
-- * CommandCode's default call group is reused as Logicc's default group, so
--   existing model keys and per-group presets carry over to the new pool.

CREATE TABLE IF NOT EXISTS nexus_module_bridges (
 module_id TEXT PRIMARY KEY CHECK(module_id IN ('logicc')),
 secret_hash TEXT NOT NULL UNIQUE,
 secret_ciphertext TEXT NOT NULL,
 model_count INTEGER NOT NULL DEFAULT 0,
 connected_at TIMESTAMPTZ,
 last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nexus_module_settings (
 module_id TEXT PRIMARY KEY,
 value JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(value)='object'),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Remove CommandCode data. Request logs keep their own source columns.
DELETE FROM nexus_account_groups WHERE module_id='commandcode';
-- CommandCode logs are the ones tied to its accounts; CPA native history stays.
DELETE FROM request_logs WHERE module_id='commandcode' OR (module_id IS NULL AND account_id IS NOT NULL);
ALTER TABLE request_logs DROP COLUMN IF EXISTS account_id;
DROP TABLE IF EXISTS key_creation_intents CASCADE;
DROP TABLE IF EXISTS account_models CASCADE;
DROP TABLE IF EXISTS managed_accounts CASCADE;
DROP TABLE IF EXISTS model_catalog CASCADE;
DROP TABLE IF EXISTS module_integrations CASCADE;
DROP TABLE IF EXISTS official_catalog_history CASCADE;
DROP TABLE IF EXISTS official_catalog_state CASCADE;
DROP TABLE IF EXISTS official_catalog_sources CASCADE;
DROP FUNCTION IF EXISTS nexus_bind_default_account_group() CASCADE;
DROP FUNCTION IF EXISTS nexus_cleanup_account_groups() CASCADE;
DELETE FROM platform_modules WHERE id='commandcode';

-- CommandCode's private CPA bridge key is not a client key.
DELETE FROM gateway_keys WHERE left(prefix,10)='ccm_nexus_';
UPDATE gateway_keys SET module_id='auto' WHERE module_id NOT IN ('auto','cpa');
ALTER TABLE gateway_keys DROP CONSTRAINT IF EXISTS gateway_keys_module_id_check;
ALTER TABLE gateway_keys ADD CONSTRAINT gateway_keys_module_id_check CHECK(module_id IN ('auto','cpa'));
ALTER TABLE gateway_keys ALTER COLUMN module_id SET DEFAULT 'auto';

-- Module identifiers for groups.
ALTER TABLE nexus_account_groups DROP CONSTRAINT IF EXISTS nexus_account_groups_module_id_check;
ALTER TABLE nexus_module_group_defaults DROP CONSTRAINT IF EXISTS nexus_module_group_defaults_module_id_check;

UPDATE nexus_groups g SET name='Logicc', description='Logicc 账号的默认调用组', updated_at=now()
 FROM nexus_module_group_defaults d
 WHERE d.module_id='commandcode' AND d.group_id=g.id AND lower(g.name)='commandcode'
   AND NOT EXISTS(SELECT 1 FROM nexus_groups other WHERE lower(other.name)='logicc' AND other.id<>g.id);
UPDATE nexus_module_group_defaults SET module_id='logicc'
 WHERE module_id='commandcode' AND NOT EXISTS(SELECT 1 FROM nexus_module_group_defaults WHERE module_id='logicc');
DELETE FROM nexus_module_group_defaults WHERE module_id NOT IN ('cpa','logicc');

INSERT INTO nexus_groups(id,name,description)
 SELECT gen_random_uuid(),'Logicc','Logicc 账号的默认调用组'
 WHERE NOT EXISTS(SELECT 1 FROM nexus_module_group_defaults WHERE module_id='logicc')
   AND NOT EXISTS(SELECT 1 FROM nexus_groups WHERE lower(name)='logicc')
 ON CONFLICT(name) DO NOTHING;
INSERT INTO nexus_module_group_defaults(module_id,group_id,legacy_default_migrated)
 SELECT 'logicc',id,true FROM nexus_groups WHERE lower(name)='logicc' ORDER BY created_at,id LIMIT 1
 ON CONFLICT(module_id) DO NOTHING;

ALTER TABLE nexus_account_groups ADD CONSTRAINT nexus_account_groups_module_id_check CHECK(module_id IN ('cpa','logicc'));
ALTER TABLE nexus_module_group_defaults ADD CONSTRAINT nexus_module_group_defaults_module_id_check CHECK(module_id IN ('cpa','logicc'));

-- Logicc accounts. Credentials are encrypted by the application.
CREATE TABLE IF NOT EXISTS logicc_accounts (
 id UUID PRIMARY KEY,
 label TEXT NOT NULL DEFAULT '',
 note TEXT NOT NULL DEFAULT '',
 session_id TEXT NOT NULL UNIQUE CHECK(session_id ~ '^sess_[A-Za-z0-9]+$'),
 client_cookie_ciphertext TEXT,
 token_ciphertext TEXT,
 token_expires_at TIMESTAMPTZ,
 credential_version INTEGER NOT NULL DEFAULT 0,
 enabled BOOLEAN NOT NULL DEFAULT true,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','credential_expired','sync_error')),
 max_concurrency INTEGER NOT NULL DEFAULT 2 CHECK(max_concurrency >= 0),
 models JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(models)='array'),
 sync_error TEXT,
 last_sync_at TIMESTAMPTZ,
 last_used_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(client_cookie_ciphertext IS NOT NULL OR token_ciphertext IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS logicc_accounts_sync ON logicc_accounts(enabled,last_sync_at);

CREATE OR REPLACE FUNCTION nexus_bind_default_logicc_group() RETURNS trigger AS $$
BEGIN
 INSERT INTO nexus_account_groups(module_id,account_id,group_id)
 SELECT 'logicc',NEW.id::text,group_id FROM nexus_module_group_defaults WHERE module_id='logicc'
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS nexus_default_logicc_group ON logicc_accounts;
CREATE TRIGGER nexus_default_logicc_group AFTER INSERT ON logicc_accounts FOR EACH ROW EXECUTE FUNCTION nexus_bind_default_logicc_group();

CREATE OR REPLACE FUNCTION nexus_cleanup_logicc_groups() RETURNS trigger AS $$
BEGIN
 DELETE FROM nexus_account_groups WHERE module_id='logicc' AND account_id=OLD.id::text;
 RETURN OLD;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS nexus_cleanup_logicc_groups ON logicc_accounts;
CREATE TRIGGER nexus_cleanup_logicc_groups AFTER DELETE ON logicc_accounts FOR EACH ROW EXECUTE FUNCTION nexus_cleanup_logicc_groups();

-- Factors learned from official token counts. They only ever increase.
CREATE TABLE IF NOT EXISTS logicc_usage_calibration (
 family TEXT NOT NULL CHECK(family IN ('openai','claude','gemini','other')),
 direction TEXT NOT NULL CHECK(direction IN ('input','output')),
 factor NUMERIC(8,4) NOT NULL CHECK(factor >= 1),
 samples INTEGER NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(family,direction)
);

-- External service keys become a platform feature scoped to source modules.
ALTER TABLE service_keys ADD COLUMN IF NOT EXISTS module_ids TEXT[] NOT NULL DEFAULT ARRAY['logicc','cpa']::text[];
ALTER TABLE service_keys DROP CONSTRAINT IF EXISTS service_keys_module_ids_check;
ALTER TABLE service_keys ADD CONSTRAINT service_keys_module_ids_check
 CHECK(cardinality(module_ids) > 0 AND module_ids <@ ARRAY['logicc','cpa']::text[]);
