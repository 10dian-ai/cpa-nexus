-- Multi-group model keys: the order of a key's groups is now meaningful and a
-- key chooses how requests use them.
--   failover: use the first group that serves the model; switch to the next
--             group when every source there fails or is unavailable.
--   mixed:    rotate between the groups that serve the model; failures still
--             fall through to the remaining groups.
ALTER TABLE nexus_key_groups ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;
WITH ordered AS (
  SELECT kg.key_id, kg.group_id,
    row_number() OVER (PARTITION BY kg.key_id ORDER BY g.created_at, g.id) - 1 AS position
  FROM nexus_key_groups kg JOIN nexus_groups g ON g.id = kg.group_id
)
UPDATE nexus_key_groups kg SET position = ordered.position
  FROM ordered WHERE kg.key_id = ordered.key_id AND kg.group_id = ordered.group_id;
CREATE INDEX IF NOT EXISTS nexus_key_groups_order ON nexus_key_groups(key_id, position);

ALTER TABLE gateway_keys ADD COLUMN IF NOT EXISTS group_strategy TEXT NOT NULL DEFAULT 'failover';
ALTER TABLE gateway_keys DROP CONSTRAINT IF EXISTS gateway_keys_group_strategy_check;
ALTER TABLE gateway_keys ADD CONSTRAINT gateway_keys_group_strategy_check CHECK (group_strategy IN ('failover', 'mixed'));

-- SillyTavern presets are now chosen by the group that serves a request, not
-- by a per-key switch. A group without its own preset settings inherits the
-- library's enabled presets. Groups whose keys all bypassed presets before
-- this change get explicit "off" rows, so upgrading never starts injecting
-- presets into traffic that previously had none.
INSERT INTO nexus_group_preset_bindings (group_id, preset_id, enabled)
SELECT g.id, p.id, false
FROM nexus_groups g CROSS JOIN nexus_presets p
WHERE NOT EXISTS (SELECT 1 FROM nexus_group_preset_bindings b WHERE b.group_id = g.id)
  AND NOT EXISTS (
    SELECT 1 FROM nexus_key_groups kg
    JOIN nexus_key_preset_bindings kb ON kb.key_id = kg.key_id AND kb.mode IN ('stack', 'preset')
    WHERE kg.group_id = g.id
  )
ON CONFLICT (group_id, preset_id) DO NOTHING;
