BEGIN;

CREATE TABLE IF NOT EXISTS nova_speaker_enrollment_consents (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  purpose text NOT NULL, consent_version text NOT NULL, consent_actor text NOT NULL,
  channel text NOT NULL, provenance text NOT NULL, status text NOT NULL CHECK (status IN ('active','revoked')),
  consented_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS nova_speaker_enrollment_active_consent_idx ON nova_speaker_enrollment_consents (owner_id,purpose,channel) WHERE status='active';

CREATE TABLE IF NOT EXISTS nova_speaker_enrollment_sessions (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  consent_id text NOT NULL REFERENCES nova_speaker_enrollment_consents(id) ON DELETE RESTRICT,
  conversation_id text NOT NULL REFERENCES nova_conversations(id) ON DELETE RESTRICT,
  session_number integer NOT NULL CHECK (session_number IN (1,2)), expected_samples integer NOT NULL CHECK (expected_samples=3),
  condition_label text NOT NULL, phrase_plan jsonb NOT NULL CHECK (jsonb_array_length(phrase_plan)=3),
  status text NOT NULL CHECK (status IN ('prepared','waiting_for_approval','approved','collecting','completed','failed','revoked')),
  accepted_count integer NOT NULL DEFAULT 0 CHECK (accepted_count BETWEEN 0 AND 3), total_required integer NOT NULL DEFAULT 6 CHECK (total_required=6),
  call_intent_id text UNIQUE REFERENCES nova_phone_call_intents(id) ON DELETE SET NULL,
  approval_id text UNIQUE REFERENCES nova_approvals(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nova_speaker_enrollment_sessions_owner_idx ON nova_speaker_enrollment_sessions (owner_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS nova_speaker_enrollment_samples (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES nova_speaker_enrollment_sessions(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 3), submission_key text NOT NULL,
  prompt_id text NOT NULL, language text NOT NULL, condition_label text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','retry')),
  quality jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(quality::text)<=8192),
  encrypted_representation jsonb, representation_version text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,session_id,submission_key)
);
CREATE INDEX IF NOT EXISTS nova_speaker_enrollment_samples_session_idx ON nova_speaker_enrollment_samples (owner_id,session_id,ordinal,created_at);

INSERT INTO nova_schema_migrations (version) VALUES (18) ON CONFLICT (version) DO NOTHING;
COMMIT;
