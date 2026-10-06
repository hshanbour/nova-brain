BEGIN;

CREATE TABLE IF NOT EXISTS nova_owner_contact_policies (
  owner_id text PRIMARY KEY REFERENCES nova_owners(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  enabled boolean NOT NULL DEFAULT false,
  allowed_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  quiet_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  cooldown_minutes integer NOT NULL CHECK (cooldown_minutes BETWEEN 1 AND 240),
  daily_limit integer NOT NULL CHECK (daily_limit BETWEEN 1 AND 5),
  maximum_calls integer NOT NULL CHECK (maximum_calls BETWEEN 1 AND 5),
  used_calls integer NOT NULL DEFAULT 0 CHECK (used_calls >= 0),
  expires_at timestamptz NOT NULL,
  paused_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nova_speaker_channel_calibrations (
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  speaker_profile_id text NOT NULL REFERENCES nova_speaker_profiles(id) ON DELETE CASCADE,
  channel text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_consent','collecting','ready','revoked')),
  representation_version text NOT NULL,
  owner_match_threshold numeric,
  ambiguity_margin numeric,
  sample_count integer NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  session_count integer NOT NULL DEFAULT 0 CHECK (session_count >= 0),
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  consent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY(owner_id,speaker_profile_id,channel)
);

CREATE INDEX IF NOT EXISTS nova_speaker_channel_calibrations_owner_idx
  ON nova_speaker_channel_calibrations (owner_id,channel,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS nova_owner_callback_eligibilities (
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES nova_autonomy_tasks(id) ON DELETE CASCADE,
  terminal_state_version integer NOT NULL,
  conversation_id text REFERENCES nova_conversations(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (reason IN ('task_completed','task_blocked_owner_required')),
  status text NOT NULL CHECK (status IN ('eligible','ineligible')),
  decision_code text NOT NULL,
  policy_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,task_id,terminal_state_version)
);

CREATE INDEX IF NOT EXISTS nova_owner_callback_eligibilities_owner_idx
  ON nova_owner_callback_eligibilities (owner_id,status,created_at DESC);

INSERT INTO nova_schema_migrations (version) VALUES (16), (17) ON CONFLICT (version) DO NOTHING;

COMMIT;
