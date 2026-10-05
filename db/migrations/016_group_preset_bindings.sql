-- Per-routing-group Tavern preset overrides.
-- A missing row inherits the global preset library values. A row can override
-- enablement, ordering, source JSON and/or variables for one routing group.
CREATE TABLE IF NOT EXISTS nexus_group_preset_bindings (
 group_id UUID NOT NULL REFERENCES nexus_groups(id) ON DELETE CASCADE,
 preset_id UUID NOT NULL REFERENCES nexus_presets(id) ON DELETE RESTRICT,
 enabled BOOLEAN NULL,
 sort_order NUMERIC NULL CHECK(sort_order IS NULL OR sort_order >= 0),
 source_json JSONB NULL CHECK(source_json IS NULL OR jsonb_typeof(source_json)='object'),
 variables JSONB NULL CHECK(variables IS NULL OR jsonb_typeof(variables)='object'),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(group_id,preset_id)
);
CREATE INDEX IF NOT EXISTS nexus_group_preset_bindings_group_order
 ON nexus_group_preset_bindings(group_id,sort_order,preset_id);
CREATE INDEX IF NOT EXISTS nexus_group_preset_bindings_preset
 ON nexus_group_preset_bindings(preset_id);
