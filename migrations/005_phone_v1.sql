BEGIN;

CREATE TABLE IF NOT EXISTS nova_phone_call_intents (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES nova_conversations(id) ON DELETE CASCADE,
  prepared_run_id text REFERENCES nova_execution_runs(id) ON DELETE SET NULL,
  call_conversation_id text NOT NULL,
  envelope jsonb NOT NULL CHECK (octet_length(envelope::text) <= 32768),
  envelope_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('prepared','waiting_for_approval','approved','dialing','in_progress','completed','failed','uncertain')),
  approval_id text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 1),
  submission_key text UNIQUE,
  provider_call_sid text UNIQUE,
  provider_stream_sid text UNIQUE,
  provider_status text,
  session_token_hash text,
  session_token_expires_at timestamptz,
  session_token_used_at timestamptz,
  outcome text,
  summary text,
  error_code text,
  expires_at timestamptz NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nova_phone_calls_conversation_idx ON nova_phone_call_intents (owner_id,conversation_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS nova_phone_one_active_call_idx ON nova_phone_call_intents (owner_id) WHERE status IN ('dialing','in_progress');

CREATE TABLE IF NOT EXISTS nova_phone_call_events (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  call_intent_id text NOT NULL REFERENCES nova_phone_call_intents(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  event_type text NOT NULL,
  provider_call_sid text,
  provider_stream_sid text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,call_intent_id,event_key)
);

CREATE TABLE IF NOT EXISTS nova_phone_call_turns (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  call_intent_id text NOT NULL REFERENCES nova_phone_call_intents(id) ON DELETE CASCADE,
  input_hash text NOT NULL,
  caller_text text NOT NULL CHECK (octet_length(caller_text) <= 32768),
  nova_text text,
  control text,
  run_id text REFERENCES nova_execution_runs(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('processing','completed','failed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,call_intent_id,id)
);
CREATE INDEX IF NOT EXISTS nova_phone_turns_call_idx ON nova_phone_call_turns (owner_id,call_intent_id,created_at);

INSERT INTO nova_schema_migrations (version) VALUES (14) ON CONFLICT (version) DO NOTHING;
COMMIT;
