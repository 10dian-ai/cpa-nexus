ALTER TABLE account_models ADD COLUMN IF NOT EXISTS observation_scope TEXT NOT NULL DEFAULT 'legacy-proxy';
ALTER TABLE account_models ALTER COLUMN observation_scope SET DEFAULT 'official-provider';
CREATE INDEX IF NOT EXISTS account_models_provider_scope ON account_models(model_id,observation_scope,status);
