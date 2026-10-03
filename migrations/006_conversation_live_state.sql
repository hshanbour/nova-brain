BEGIN;

CREATE TABLE IF NOT EXISTS nova_conversation_live_state (
  conversation_id text PRIMARY KEY REFERENCES nova_conversations(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  context_version bigint NOT NULL DEFAULT 0 CHECK (context_version >= 0),
  rolling_summary text NOT NULL DEFAULT '' CHECK (octet_length(rolling_summary) <= 65536),
  unresolved_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(unresolved_state::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nova_conversation_events (
  sequence bigserial PRIMARY KEY,
  id text UNIQUE NOT NULL,
  conversation_id text NOT NULL REFERENCES nova_conversations(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  turn_id text,
  message_id text,
  event_type text NOT NULL,
  status text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nova_conversation_events_order_idx
  ON nova_conversation_events (owner_id, conversation_id, sequence);

INSERT INTO nova_schema_migrations (version) VALUES (15) ON CONFLICT (version) DO NOTHING;

COMMIT;
