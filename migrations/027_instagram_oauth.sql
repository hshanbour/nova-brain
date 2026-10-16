CREATE TABLE IF NOT EXISTS nova_instagram_oauth_states (
  state_hash text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  session_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nova_instagram_oauth_states_owner_expiry_idx ON nova_instagram_oauth_states (owner_id, expires_at DESC);
CREATE TABLE IF NOT EXISTS nova_instagram_connections (
  owner_id text PRIMARY KEY REFERENCES nova_owners(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  username text NOT NULL,
  scopes jsonb NOT NULL,
  encrypted_access_token jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO nova_schema_migrations (version) VALUES (27) ON CONFLICT (version) DO NOTHING;
