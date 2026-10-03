CREATE TABLE IF NOT EXISTS nexus_key_preset_bindings (
 key_id UUID PRIMARY KEY REFERENCES gateway_keys(id) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN ('preset','bypass')),
 preset_id UUID REFERENCES nexus_presets(id) ON DELETE RESTRICT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((mode='preset' AND preset_id IS NOT NULL) OR (mode='bypass' AND preset_id IS NULL))
);
CREATE INDEX IF NOT EXISTS nexus_key_preset_bindings_preset ON nexus_key_preset_bindings(preset_id);

-- Retain old module/account choices as history, without locking presets that
-- can no longer be managed through the API key route editor.
CREATE TABLE IF NOT EXISTS nexus_legacy_preset_bindings (
 module_id TEXT NOT NULL,
 account_id TEXT NOT NULL DEFAULT '',
 mode TEXT NOT NULL,
 preset_id UUID,
 updated_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(module_id,account_id)
);
INSERT INTO nexus_legacy_preset_bindings(module_id,account_id,mode,preset_id,updated_at)
 SELECT module_id,account_id,mode,preset_id,updated_at FROM nexus_preset_bindings
 ON CONFLICT(module_id,account_id) DO NOTHING;
DELETE FROM nexus_preset_bindings;
