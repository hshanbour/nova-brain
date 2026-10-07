BEGIN;

CREATE TABLE IF NOT EXISTS nova_speaker_control_sessions (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  participant_code text NOT NULL CHECK (participant_code IN ('control-01','control-02','control-03')),
  conversation_id text NOT NULL REFERENCES nova_conversations(id) ON DELETE RESTRICT,
  plan jsonb NOT NULL CHECK (jsonb_array_length(plan)=4), consent_version text NOT NULL,
  consent_disclosure text NOT NULL, consent_status text NOT NULL DEFAULT 'pending' CHECK (consent_status IN ('pending','granted','refused')),
  status text NOT NULL CHECK (status IN ('prepared','waiting_for_approval','approved','awaiting_consent','collecting','completed','refused','failed','revoked')),
  accepted_count integer NOT NULL DEFAULT 0 CHECK (accepted_count BETWEEN 0 AND 4),
  cost_cap_usd numeric NOT NULL CHECK (cost_cap_usd > 0 AND cost_cap_usd <= 5),
  call_intent_id text UNIQUE REFERENCES nova_phone_call_intents(id) ON DELETE SET NULL,
  approval_id text UNIQUE REFERENCES nova_approvals(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL, consented_at timestamptz, refused_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nova_speaker_control_sessions_owner_idx ON nova_speaker_control_sessions (owner_id,status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS nova_speaker_control_sessions_one_active_slot_idx ON nova_speaker_control_sessions (owner_id,participant_code) WHERE status NOT IN ('failed','refused','revoked');

CREATE TABLE IF NOT EXISTS nova_speaker_control_samples (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES nova_speaker_control_sessions(id) ON DELETE CASCADE,
  participant_code text NOT NULL, ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 4), submission_key text NOT NULL,
  prompt_id text NOT NULL, language text NOT NULL CHECK (language IN ('arabic','english','mixed')),
  condition_label text NOT NULL CHECK (condition_label IN ('normal_handset','speakerphone')),
  status text NOT NULL CHECK (status IN ('accepted','retry')),
  quality jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(quality::text)<=8192),
  score numeric, representation_version text, preprocessing_version text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,session_id,submission_key)
);
CREATE INDEX IF NOT EXISTS nova_speaker_control_samples_session_idx ON nova_speaker_control_samples (owner_id,session_id,ordinal,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS nova_speaker_control_samples_one_accepted_ordinal_idx ON nova_speaker_control_samples (owner_id,session_id,ordinal) WHERE status='accepted';

INSERT INTO nova_schema_migrations (version) VALUES (19) ON CONFLICT (version) DO NOTHING;
COMMIT;
