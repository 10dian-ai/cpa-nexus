-- The embedded Devin 2API module is removed. CPA's native Devin provider is
-- unaffected: its credentials live in the CPA kernel and keep module_id='cpa'.
-- Module data (accounts, encrypted tokens, bindings and logs) is deleted.

DELETE FROM nexus_account_groups WHERE module_id='devin2api';
DROP TABLE IF EXISTS devin2api_accounts CASCADE;
DROP FUNCTION IF EXISTS nexus_bind_default_devin2api_group();
DROP FUNCTION IF EXISTS nexus_cleanup_devin2api_groups();
DELETE FROM request_logs WHERE module_id='devin2api';
DELETE FROM platform_modules WHERE id='devin2api';

-- Keys bound only to the module become ordinary cross-source keys. Their
-- group membership still limits what they can call.
UPDATE gateway_keys SET module_id='auto' WHERE module_id='devin2api';

-- Remove the module's default group when nothing else uses it. A group that
-- some key still relies on as its only group is kept (now simply empty), so
-- no key silently loses all routing permissions.
CREATE TEMP TABLE nexus_devin_group ON COMMIT DROP AS
  SELECT group_id FROM nexus_module_group_defaults WHERE module_id='devin2api';
DELETE FROM nexus_module_group_defaults WHERE module_id='devin2api';
DELETE FROM nexus_key_groups kg USING nexus_devin_group d
  WHERE kg.group_id=d.group_id
    AND EXISTS(SELECT 1 FROM nexus_key_groups other WHERE other.key_id=kg.key_id AND other.group_id<>d.group_id);
DELETE FROM nexus_groups g USING nexus_devin_group d
  WHERE g.id=d.group_id AND g.is_default=false
    AND NOT EXISTS(SELECT 1 FROM nexus_account_groups WHERE group_id=g.id)
    AND NOT EXISTS(SELECT 1 FROM nexus_key_groups WHERE group_id=g.id)
    AND NOT EXISTS(SELECT 1 FROM nexus_module_group_defaults WHERE group_id=g.id);

ALTER TABLE gateway_keys DROP CONSTRAINT IF EXISTS gateway_keys_module_id_check;
ALTER TABLE gateway_keys ADD CONSTRAINT gateway_keys_module_id_check CHECK(module_id IN ('auto','cpa','commandcode'));
ALTER TABLE nexus_account_groups DROP CONSTRAINT IF EXISTS nexus_account_groups_module_id_check;
ALTER TABLE nexus_account_groups ADD CONSTRAINT nexus_account_groups_module_id_check CHECK(module_id IN ('commandcode','cpa'));
ALTER TABLE nexus_module_group_defaults DROP CONSTRAINT IF EXISTS nexus_module_group_defaults_module_id_check;
ALTER TABLE nexus_module_group_defaults ADD CONSTRAINT nexus_module_group_defaults_module_id_check CHECK(module_id IN ('commandcode','cpa'));
