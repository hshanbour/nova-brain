CREATE TABLE IF NOT EXISTS nova_project_meta_oauth_states (
  state_hash text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES nova_projects(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('instagram_login','facebook_login')),
  session_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nova_project_meta_oauth_states_scope_idx ON nova_project_meta_oauth_states (owner_id,project_id,expires_at DESC);

CREATE TABLE IF NOT EXISTS nova_project_meta_connections (
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES nova_projects(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('instagram_login','facebook_login')),
  account_id text NOT NULL,
  username text NOT NULL,
  facebook_page_id text,
  facebook_page_name text,
  scopes jsonb NOT NULL,
  encrypted_access_token jsonb NOT NULL,
  encrypted_secondary_token jsonb,
  expires_at timestamptz NOT NULL,
  last_synced_at timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id,project_id,provider),
  UNIQUE (owner_id,provider,account_id)
);
CREATE INDEX IF NOT EXISTS nova_project_meta_connections_account_idx ON nova_project_meta_connections (owner_id,provider,account_id);

INSERT INTO nova_project_meta_connections
  (owner_id,project_id,provider,account_id,username,scopes,encrypted_access_token,expires_at,connected_at,updated_at)
SELECT owner_id,'nova-digital-services-uk','instagram_login',account_id,username,scopes,encrypted_access_token,expires_at,connected_at,updated_at
FROM nova_instagram_connections
WHERE EXISTS (SELECT 1 FROM nova_projects WHERE id='nova-digital-services-uk' AND owner_id=nova_instagram_connections.owner_id)
ON CONFLICT (owner_id,project_id,provider) DO NOTHING;

INSERT INTO nova_schema_migrations (version) VALUES (29) ON CONFLICT (version) DO NOTHING;
