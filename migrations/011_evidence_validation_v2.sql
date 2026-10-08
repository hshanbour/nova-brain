BEGIN;

ALTER TABLE nova_memories
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE nova_memories
  DROP CONSTRAINT IF EXISTS nova_memories_evidence_size;

ALTER TABLE nova_memories
  ADD CONSTRAINT nova_memories_evidence_size
  CHECK (octet_length(evidence::text) <= 32768);

INSERT INTO nova_schema_migrations (version)
VALUES (21)
ON CONFLICT (version) DO NOTHING;

COMMIT;
