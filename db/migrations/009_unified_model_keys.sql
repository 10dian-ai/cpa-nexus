ALTER TABLE gateway_keys
  ADD COLUMN IF NOT EXISTS module_id TEXT NOT NULL DEFAULT 'commandcode'
  CHECK (module_id IN ('cpa', 'commandcode'));
