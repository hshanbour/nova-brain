BEGIN;

CREATE TABLE IF NOT EXISTS nova_memory_candidates (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
  project_id text REFERENCES nova_projects(id) ON DELETE SET NULL,
  conversation_id text REFERENCES nova_conversations(id) ON DELETE SET NULL,
  source_message_id text,
  source_run_id text,
  source_task_id text,
  source_kind text NOT NULL CHECK (source_kind IN ('typed_conversation','completed_task','failed_task')),
  candidate_type text NOT NULL CHECK (candidate_type IN ('verified_fact','owner_claim','preference','project_decision','hypothesis','unresolved_question','completed_task_outcome','failed_task_lesson','correction')),
  content text NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 8192),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(evidence::text) <= 32768),
  provenance text NOT NULL,
  privacy text NOT NULL DEFAULT 'private' CHECK (privacy IN ('private','restricted')),
  scope text NOT NULL DEFAULT 'global' CHECK (scope IN ('global','system','project')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','superseded')),
  fingerprint text NOT NULL,
  supersedes_memory_id text REFERENCES nova_memories(id) ON DELETE SET NULL,
  accepted_memory_id text REFERENCES nova_memories(id) ON DELETE SET NULL,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE(owner_id,fingerprint)
);
CREATE INDEX IF NOT EXISTS nova_memory_candidates_owner_status_idx ON nova_memory_candidates (owner_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS nova_memory_candidates_task_idx ON nova_memory_candidates (owner_id,source_task_id) WHERE source_task_id IS NOT NULL;

INSERT INTO nova_schema_migrations (version) VALUES (20) ON CONFLICT (version) DO NOTHING;
COMMIT;
