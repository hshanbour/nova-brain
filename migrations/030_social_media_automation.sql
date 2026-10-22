BEGIN;

CREATE TABLE IF NOT EXISTS nova_social_media_assets (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES nova_projects(id) ON DELETE CASCADE, content_id text REFERENCES nova_social_content(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('video','image','audio')), storage text NOT NULL CHECK (storage IN ('local','r2')),
  state text NOT NULL CHECK (state IN ('original','rendered','promotion_approved','cloud_ready','rejected')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'), bytes bigint NOT NULL CHECK (bytes > 0), mime_type text NOT NULL,
  rights_status text NOT NULL, consent_status text NOT NULL, local_capability_id text,
  cloud_key text, cloud_url text, cloud_etag text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nova_social_media_assets_scope_idx ON nova_social_media_assets (owner_id,project_id,created_at DESC);

CREATE TABLE IF NOT EXISTS nova_social_media_jobs (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES nova_projects(id) ON DELETE CASCADE, content_id text REFERENCES nova_social_content(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('render','promote')), status text NOT NULL CHECK (status IN ('queued','processing','succeeded','failed','cancelled')),
  input_asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb, output_asset_id text REFERENCES nova_social_media_assets(id) ON DELETE SET NULL,
  recipe jsonb NOT NULL DEFAULT '{}'::jsonb, approval_id text REFERENCES nova_approvals(id) ON DELETE SET NULL, intent_hash text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0, lease_owner text, lease_token text, lease_expires_at timestamptz, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,intent_hash)
);
CREATE INDEX IF NOT EXISTS nova_social_media_jobs_queue_idx ON nova_social_media_jobs (owner_id,type,status,created_at);

CREATE TABLE IF NOT EXISTS nova_social_calendar_entries (
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE, project_id text NOT NULL REFERENCES nova_projects(id) ON DELETE CASCADE,
  event_key text NOT NULL, event_date date NOT NULL, title text NOT NULL, status text NOT NULL DEFAULT 'proposed', recommendation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,project_id,event_key)
);
CREATE INDEX IF NOT EXISTS nova_social_calendar_scope_idx ON nova_social_calendar_entries (owner_id,project_id,event_date);

INSERT INTO nova_schema_migrations (version) VALUES (30) ON CONFLICT (version) DO NOTHING;
COMMIT;
