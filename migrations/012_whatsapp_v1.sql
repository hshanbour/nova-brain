BEGIN;

CREATE TABLE IF NOT EXISTS nova_whatsapp_inbound_messages (
  message_sid text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  contact_id text NOT NULL,
  contact_ciphertext text NOT NULL,
  body_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','processing','replied','failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  run_id text,
  assistant_message_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nova_whatsapp_inbound_owner_contact_idx ON nova_whatsapp_inbound_messages (owner_id,contact_id,created_at DESC);
CREATE INDEX IF NOT EXISTS nova_whatsapp_inbound_queue_idx ON nova_whatsapp_inbound_messages (owner_id,status,next_attempt_at,created_at);

CREATE TABLE IF NOT EXISTS nova_whatsapp_outbound_messages (
  inbound_sid text PRIMARY KEY REFERENCES nova_whatsapp_inbound_messages(message_sid) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  body_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('sending','submitted','queued','sent','delivered','read','undelivered','failed','uncertain')),
  provider_message_sid text UNIQUE,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nova_whatsapp_outbound_owner_status_idx ON nova_whatsapp_outbound_messages (owner_id,status,updated_at DESC);

INSERT INTO nova_schema_migrations (version) VALUES (22) ON CONFLICT (version) DO NOTHING;
COMMIT;
