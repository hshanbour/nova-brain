ALTER TABLE nova_social_content ADD COLUMN IF NOT EXISTS plan jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE nova_social_content DROP CONSTRAINT IF EXISTS nova_social_content_plan_size;
ALTER TABLE nova_social_content ADD CONSTRAINT nova_social_content_plan_size CHECK (octet_length(plan::text) <= 32768);
CREATE TABLE IF NOT EXISTS nova_social_metric_snapshots (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES nova_projects(id) ON DELETE CASCADE,
  provider text NOT NULL,
  metrics jsonb NOT NULL CHECK (octet_length(metrics::text) <= 32768),
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nova_social_metric_snapshots_scope_idx ON nova_social_metric_snapshots (owner_id,project_id,captured_at DESC);
INSERT INTO nova_schema_migrations(version) VALUES (26) ON CONFLICT DO NOTHING;
