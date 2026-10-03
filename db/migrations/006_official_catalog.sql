-- Official public catalog is independent of account permissions and observed gateway models.
CREATE TABLE IF NOT EXISTS official_catalog_sources (
  id text PRIMARY KEY,
  url text NOT NULL,
  payload jsonb,
  fetched_at timestamptz,
  last_attempt_at timestamptz,
  etag text,
  last_modified text,
  error text,
  model_count integer CHECK (model_count IS NULL OR model_count >= 0)
);
CREATE TABLE IF NOT EXISTS official_catalog_state (
  id text PRIMARY KEY CHECK (id = 'commandcode'),
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS official_catalog_history (
  id bigserial PRIMARY KEY,
  content_hash text NOT NULL UNIQUE,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
