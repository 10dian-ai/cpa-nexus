ALTER TABLE nexus_presets ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE nexus_presets ADD COLUMN IF NOT EXISTS sort_order NUMERIC NOT NULL DEFAULT 0 CHECK(sort_order >= 0);
WITH ordered AS (
 SELECT id,row_number() OVER(ORDER BY created_at,id)-1 AS position FROM nexus_presets
)
UPDATE nexus_presets p SET sort_order=ordered.position FROM ordered WHERE p.id=ordered.id;

-- Existing opted-in model keys keep their choice, now using the shared stack.
UPDATE nexus_presets SET enabled=true WHERE id IN (
 SELECT preset_id FROM nexus_key_preset_bindings WHERE mode='preset'
);
ALTER TABLE nexus_key_preset_bindings DROP CONSTRAINT IF EXISTS nexus_key_preset_bindings_mode_check;
ALTER TABLE nexus_key_preset_bindings DROP CONSTRAINT IF EXISTS nexus_key_preset_bindings_check;
UPDATE nexus_key_preset_bindings SET mode='stack',preset_id=NULL,updated_at=now() WHERE mode='preset';
ALTER TABLE nexus_key_preset_bindings ADD CONSTRAINT nexus_key_preset_bindings_mode_check CHECK(mode IN ('preset','stack','bypass'));
ALTER TABLE nexus_key_preset_bindings ADD CONSTRAINT nexus_key_preset_bindings_check CHECK(
 (mode='preset' AND preset_id IS NOT NULL) OR (mode IN ('stack','bypass') AND preset_id IS NULL)
);
CREATE INDEX IF NOT EXISTS nexus_presets_stack_order ON nexus_presets(sort_order,id) WHERE enabled;
