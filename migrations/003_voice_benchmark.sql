CREATE TABLE IF NOT EXISTS nova_voice_benchmark_sessions (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  budget_usd numeric NOT NULL CHECK (budget_usd > 0 AND budget_usd <= 2),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nova_voice_benchmark_results (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES nova_voice_benchmark_sessions(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('stt','tts')),
  provider_id text NOT NULL,
  sample_id text NOT NULL,
  label text NOT NULL,
  status text NOT NULL,
  estimated_cost_usd numeric NOT NULL DEFAULT 0,
  latency_ms integer,
  transcript text,
  metrics jsonb,
  ratings jsonb,
  model text,
  voice text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  revealed boolean NOT NULL DEFAULT false,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nova_voice_benchmark_owner_cost_idx ON nova_voice_benchmark_results (owner_id, created_at);
CREATE INDEX IF NOT EXISTS nova_voice_benchmark_session_idx ON nova_voice_benchmark_results (session_id, created_at);
INSERT INTO nova_schema_migrations (version) VALUES (3) ON CONFLICT (version) DO NOTHING;
