CREATE TABLE IF NOT EXISTS nova_project_sources (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES nova_projects(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('owner_statement','owner_document','public_url','github','vercel','neon','stripe')),
  label text NOT NULL CHECK (octet_length(label) BETWEEN 1 AND 500),
  locator text,
  content_hash text,
  access_mode text NOT NULL DEFAULT 'reference_only' CHECK (access_mode IN ('reference_only','read_only')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('proposed','active','revoked')),
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(permissions::text) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(owner_id,project_id,source_type,content_hash)
);
CREATE INDEX IF NOT EXISTS nova_project_sources_scope_idx ON nova_project_sources (owner_id,project_id,status,created_at DESC);
