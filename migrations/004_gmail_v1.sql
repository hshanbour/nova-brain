BEGIN;

CREATE TABLE IF NOT EXISTS nova_gmail_oauth_states (
  state_hash text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  session_hash text NOT NULL,
  encrypted_code_verifier jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nova_gmail_oauth_states_owner_expiry_idx ON nova_gmail_oauth_states (owner_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS nova_gmail_connections (
  owner_id text PRIMARY KEY REFERENCES nova_owners(id) ON DELETE CASCADE,
  email text NOT NULL,
  scopes jsonb NOT NULL,
  encrypted_access_token jsonb,
  access_token_expires_at timestamptz,
  encrypted_refresh_token jsonb NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nova_gmail_drafts (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  to_recipients jsonb NOT NULL,
  cc_recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  bcc_recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text NOT NULL,
  body text NOT NULL,
  thread_id text,
  in_reply_to text,
  references_header text,
  intent_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nova_gmail_send_intents (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  draft_id text NOT NULL REFERENCES nova_gmail_drafts(id) ON DELETE RESTRICT,
  intent_hash text NOT NULL,
  message_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('sending','sent','uncertain','failed')),
  provider_message_id text,
  provider_thread_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, draft_id)
);

INSERT INTO nova_schema_migrations (version) VALUES (13) ON CONFLICT (version) DO NOTHING;
COMMIT;
