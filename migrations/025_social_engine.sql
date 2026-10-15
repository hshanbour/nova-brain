CREATE TABLE IF NOT EXISTS nova_social_content (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES nova_projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('post','reel','story')), title text NOT NULL, caption text NOT NULL, script text NOT NULL DEFAULT '',
  platforms jsonb NOT NULL CHECK (jsonb_array_length(platforms) BETWEEN 1 AND 2), media jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb, evidence_status text NOT NULL CHECK (evidence_status IN ('unverified','verified','not_applicable')),
  originality_status text NOT NULL CHECK (originality_status IN ('unverified','passed','failed')),
  status text NOT NULL CHECK (status IN ('draft','review_ready','scheduled','published','failed','uncertain','cancelled')),
  content_hash text NOT NULL, approved_hash text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nova_social_content_owner_project_idx ON nova_social_content (owner_id,project_id,created_at DESC);
CREATE TABLE IF NOT EXISTS nova_social_publications (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES nova_projects(id) ON DELETE CASCADE, content_id text NOT NULL REFERENCES nova_social_content(id) ON DELETE RESTRICT,
  content_hash text NOT NULL, platforms jsonb NOT NULL, publish_at timestamptz NOT NULL,
  intent_hash text NOT NULL, approval_id text REFERENCES nova_approvals(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('scheduled','publishing','published','failed','uncertain','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0, lease_owner text, lease_token text, lease_expires_at timestamptz,
  provider_results jsonb NOT NULL DEFAULT '{}'::jsonb, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,intent_hash)
);
CREATE INDEX IF NOT EXISTS nova_social_publication_queue_idx ON nova_social_publications (owner_id,status,publish_at);
INSERT INTO nova_schema_migrations(version) VALUES (25) ON CONFLICT DO NOTHING;
