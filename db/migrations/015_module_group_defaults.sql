-- The source modules keep separate default call groups. A group remains reusable
-- across modules; the mapping is persistent so renaming a group does not break it.
CREATE TABLE IF NOT EXISTS nexus_module_group_defaults (
 module_id TEXT PRIMARY KEY CHECK(module_id IN ('commandcode','cpa')),
 group_id UUID NOT NULL REFERENCES nexus_groups(id) ON DELETE RESTRICT,
 legacy_default_migrated BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO nexus_groups(id,name,description)
 SELECT gen_random_uuid(),'CommandCode','CommandCode 账号的默认调用组'
 WHERE NOT EXISTS(SELECT 1 FROM nexus_module_group_defaults WHERE module_id='commandcode')
 AND NOT EXISTS(SELECT 1 FROM nexus_groups WHERE lower(name)='commandcode')
 ON CONFLICT(name) DO NOTHING;
INSERT INTO nexus_groups(id,name,description)
 SELECT gen_random_uuid(),'CPA','CPA 凭证与插件来源的默认调用组'
 WHERE NOT EXISTS(SELECT 1 FROM nexus_module_group_defaults WHERE module_id='cpa')
 AND NOT EXISTS(SELECT 1 FROM nexus_groups WHERE lower(name)='cpa')
 ON CONFLICT(name) DO NOTHING;
INSERT INTO nexus_module_group_defaults(module_id,group_id)
 SELECT 'commandcode',id FROM nexus_groups WHERE lower(name)='commandcode' ORDER BY is_default DESC,created_at,id LIMIT 1
 ON CONFLICT(module_id) DO NOTHING;
INSERT INTO nexus_module_group_defaults(module_id,group_id)
 SELECT 'cpa',id FROM nexus_groups WHERE lower(name)='cpa' ORDER BY is_default DESC,created_at,id LIMIT 1
 ON CONFLICT(module_id) DO NOTHING;

-- Replace only the old global default membership; retain every custom binding.
INSERT INTO nexus_account_groups(module_id,account_id,group_id)
 SELECT ag.module_id,ag.account_id,d.group_id FROM nexus_account_groups ag
 JOIN nexus_module_group_defaults d ON d.module_id=ag.module_id
 WHERE ag.group_id='00000000-0000-4000-8000-000000000001' AND NOT d.legacy_default_migrated
 ON CONFLICT DO NOTHING;
DELETE FROM nexus_account_groups ag USING nexus_module_group_defaults d
 WHERE ag.module_id=d.module_id AND ag.group_id='00000000-0000-4000-8000-000000000001'
 AND ag.group_id<>d.group_id AND NOT d.legacy_default_migrated;

-- Existing unrestricted model keys keep the union of both source modules.
-- The private CommandCode bridge is not a user key and must never be rebound.
INSERT INTO nexus_key_groups(key_id,group_id)
 SELECT kg.key_id,d.group_id FROM nexus_key_groups kg
 JOIN gateway_keys k ON k.id=kg.key_id CROSS JOIN nexus_module_group_defaults d
 WHERE kg.group_id='00000000-0000-4000-8000-000000000001' AND left(k.prefix,10)<>'ccm_nexus_'
 AND EXISTS(SELECT 1 FROM nexus_module_group_defaults WHERE NOT legacy_default_migrated)
 ON CONFLICT DO NOTHING;
DELETE FROM nexus_key_groups kg USING gateway_keys k
 WHERE kg.key_id=k.id AND kg.group_id='00000000-0000-4000-8000-000000000001' AND left(k.prefix,10)<>'ccm_nexus_'
 AND EXISTS(SELECT 1 FROM nexus_module_group_defaults WHERE NOT legacy_default_migrated)
 AND NOT EXISTS(SELECT 1 FROM nexus_module_group_defaults WHERE group_id=kg.group_id);
UPDATE nexus_module_group_defaults SET legacy_default_migrated=true;

CREATE OR REPLACE FUNCTION nexus_bind_default_account_group() RETURNS trigger AS $$
BEGIN
 INSERT INTO nexus_account_groups(module_id,account_id,group_id)
 SELECT 'commandcode',NEW.id::text,group_id FROM nexus_module_group_defaults WHERE module_id='commandcode'
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION nexus_bind_default_key_group() RETURNS trigger AS $$
BEGIN
 IF left(NEW.prefix,10)<>'ccm_nexus_' THEN
  INSERT INTO nexus_key_groups(key_id,group_id)
  SELECT NEW.id,group_id FROM nexus_module_group_defaults ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
