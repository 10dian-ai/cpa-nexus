ALTER TABLE nexus_presets DROP CONSTRAINT IF EXISTS nexus_presets_name_check;
ALTER TABLE nexus_presets DROP CONSTRAINT IF EXISTS nexus_presets_description_check;
ALTER TABLE nexus_presets ADD CONSTRAINT nexus_presets_name_check CHECK(length(name) >= 1);
UPDATE app_settings SET value=jsonb_set(value,'{maxRequestBodyMb}','0'::jsonb,true),updated_at=now() WHERE id=1;
