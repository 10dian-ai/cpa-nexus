CREATE TABLE IF NOT EXISTS platform_modules (
 id TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT true,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS module_integrations (
 module_id TEXT PRIMARY KEY,
 key_id UUID REFERENCES gateway_keys(id) ON DELETE SET NULL,
 credential_ciphertext TEXT NOT NULL,
 model_count INTEGER NOT NULL DEFAULT 0,
 connected_at TIMESTAMPTZ,
 last_error TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
