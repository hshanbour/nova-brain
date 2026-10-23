BEGIN;

CREATE TABLE IF NOT EXISTS nova_r2_usage_months (
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES nova_projects(id) ON DELETE CASCADE,
  billing_month date NOT NULL,
  class_a_operations bigint NOT NULL DEFAULT 0 CHECK (class_a_operations >= 0),
  class_b_operations bigint NOT NULL DEFAULT 0 CHECK (class_b_operations >= 0),
  reserved_storage_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_storage_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, project_id, billing_month)
);

CREATE INDEX IF NOT EXISTS nova_r2_usage_months_scope_idx
  ON nova_r2_usage_months (owner_id, project_id, billing_month DESC);

INSERT INTO nova_schema_migrations (version) VALUES (31) ON CONFLICT (version) DO NOTHING;
COMMIT;
