CREATE TABLE IF NOT EXISTS nexus_presets (
 id UUID PRIMARY KEY,
 name TEXT NOT NULL CHECK(length(name)>=1),
 description TEXT NOT NULL DEFAULT '',
 source_json JSONB NOT NULL CHECK(jsonb_typeof(source_json)='object'),
 variables JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(variables)='object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS nexus_preset_bindings (
 module_id TEXT NOT NULL REFERENCES platform_modules(id) ON DELETE CASCADE,
 account_id TEXT NOT NULL DEFAULT '',
 mode TEXT NOT NULL CHECK(mode IN ('preset','bypass')),
 preset_id UUID REFERENCES nexus_presets(id) ON DELETE RESTRICT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(module_id,account_id),
 CHECK((mode='preset' AND preset_id IS NOT NULL) OR (mode='bypass' AND preset_id IS NULL))
);
CREATE INDEX IF NOT EXISTS nexus_preset_bindings_preset ON nexus_preset_bindings(preset_id);
INSERT INTO platform_modules(id,enabled) VALUES('presets',false) ON CONFLICT(id) DO NOTHING;
