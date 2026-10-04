ALTER TABLE gateway_keys DROP CONSTRAINT IF EXISTS gateway_keys_module_id_check;
ALTER TABLE gateway_keys ADD CONSTRAINT gateway_keys_module_id_check CHECK(module_id IN ('auto','cpa','commandcode'));
ALTER TABLE gateway_keys ALTER COLUMN module_id SET DEFAULT 'auto';
UPDATE gateway_keys SET module_id='auto' WHERE left(prefix,10)<>'ccm_nexus_';
CREATE TABLE IF NOT EXISTS nexus_groups (
 id UUID PRIMARY KEY, name TEXT NOT NULL UNIQUE CHECK(length(trim(name))>0), description TEXT NOT NULL DEFAULT '',
 enabled BOOLEAN NOT NULL DEFAULT true, is_default BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS nexus_groups_single_default ON nexus_groups(is_default) WHERE is_default;
INSERT INTO nexus_groups(id,name,is_default) VALUES('00000000-0000-4000-8000-000000000001','默认分组',true) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS nexus_account_groups (
 module_id TEXT NOT NULL CHECK(module_id IN ('commandcode','cpa')), account_id TEXT NOT NULL,
 group_id UUID NOT NULL REFERENCES nexus_groups(id) ON DELETE RESTRICT,
 PRIMARY KEY(module_id,account_id,group_id)
);
CREATE INDEX IF NOT EXISTS nexus_account_groups_group ON nexus_account_groups(group_id,module_id,account_id);
CREATE TABLE IF NOT EXISTS nexus_key_groups (
 key_id UUID NOT NULL REFERENCES gateway_keys(id) ON DELETE CASCADE,
 group_id UUID NOT NULL REFERENCES nexus_groups(id) ON DELETE RESTRICT, PRIMARY KEY(key_id,group_id)
);
CREATE INDEX IF NOT EXISTS nexus_key_groups_group ON nexus_key_groups(group_id,key_id);
INSERT INTO nexus_account_groups(module_id,account_id,group_id)
 SELECT 'commandcode',id::text,'00000000-0000-4000-8000-000000000001'::uuid FROM managed_accounts
 ON CONFLICT DO NOTHING;
INSERT INTO nexus_key_groups(key_id,group_id)
 SELECT id,'00000000-0000-4000-8000-000000000001'::uuid FROM gateway_keys WHERE left(prefix,10)<>'ccm_nexus_'
 ON CONFLICT DO NOTHING;
-- Keep raw inserts and background imports compatible; explicit API bindings replace this default in their transaction.
CREATE OR REPLACE FUNCTION nexus_bind_default_account_group() RETURNS trigger AS $$
BEGIN
 INSERT INTO nexus_account_groups(module_id,account_id,group_id)
 VALUES('commandcode',NEW.id::text,'00000000-0000-4000-8000-000000000001') ON CONFLICT DO NOTHING;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS nexus_default_account_group ON managed_accounts;
CREATE TRIGGER nexus_default_account_group AFTER INSERT ON managed_accounts FOR EACH ROW EXECUTE FUNCTION nexus_bind_default_account_group();
CREATE OR REPLACE FUNCTION nexus_cleanup_account_groups() RETURNS trigger AS $$
BEGIN
 DELETE FROM nexus_account_groups WHERE module_id='commandcode' AND account_id=OLD.id::text;
 RETURN OLD;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS nexus_cleanup_account_groups ON managed_accounts;
CREATE TRIGGER nexus_cleanup_account_groups AFTER DELETE ON managed_accounts FOR EACH ROW EXECUTE FUNCTION nexus_cleanup_account_groups();
CREATE OR REPLACE FUNCTION nexus_bind_default_key_group() RETURNS trigger AS $$
BEGIN
 IF left(NEW.prefix,10)<>'ccm_nexus_' THEN
  INSERT INTO nexus_key_groups(key_id,group_id) VALUES(NEW.id,'00000000-0000-4000-8000-000000000001') ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS nexus_default_key_group ON gateway_keys;
CREATE TRIGGER nexus_default_key_group AFTER INSERT ON gateway_keys FOR EACH ROW EXECUTE FUNCTION nexus_bind_default_key_group();
