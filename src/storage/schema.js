export const SCHEMA_VERSION = 2;

export const SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS nova_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS nova_owners (
    id text PRIMARY KEY,
    full_name text NOT NULL,
    preferred_name text,
    arabic_name text,
    facts jsonb NOT NULL DEFAULT '{}'::jsonb,
    preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
    goals jsonb NOT NULL DEFAULT '[]'::jsonb,
    contextual_info jsonb NOT NULL DEFAULT '{}'::jsonb,
    provenance text NOT NULL,
    privacy text NOT NULL DEFAULT 'private',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS nova_projects (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS nova_conversations (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
    title text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS nova_messages (
    sequence bigserial PRIMARY KEY,
    id text UNIQUE NOT NULL,
    conversation_id text NOT NULL REFERENCES nova_conversations(id) ON DELETE CASCADE,
    owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('user', 'assistant')),
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS nova_messages_conversation_order_idx ON nova_messages (conversation_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS nova_memories (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
    category text NOT NULL,
    content text NOT NULL,
    provenance text NOT NULL,
    privacy text NOT NULL DEFAULT 'private',
    sensitivity text NOT NULL DEFAULT 'normal',
    scope text NOT NULL DEFAULT 'global',
    project_id text REFERENCES nova_projects(id) ON DELETE SET NULL,
    confidence numeric,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS nova_memories_owner_active_idx ON nova_memories (owner_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS nova_memories_project_idx ON nova_memories (owner_id, project_id)`,
  `CREATE TABLE IF NOT EXISTS nova_execution_runs (
    id text PRIMARY KEY, owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
    project_id text REFERENCES nova_projects(id) ON DELETE SET NULL, conversation_id text REFERENCES nova_conversations(id) ON DELETE SET NULL,
    goal text NOT NULL, status text NOT NULL, current_step integer NOT NULL DEFAULT 0,
    result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS nova_runs_owner_recent_idx ON nova_execution_runs (owner_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS nova_approvals (
    id text PRIMARY KEY, owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
    project_id text REFERENCES nova_projects(id) ON DELETE SET NULL, run_id text REFERENCES nova_execution_runs(id) ON DELETE SET NULL,
    tool text NOT NULL, reason text NOT NULL, risk_level text NOT NULL, arguments jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'pending', decision text, created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS nova_approvals_owner_pending_idx ON nova_approvals (owner_id, status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS nova_activity_events (
    sequence bigserial PRIMARY KEY, id text UNIQUE NOT NULL, owner_id text NOT NULL REFERENCES nova_owners(id) ON DELETE CASCADE,
    project_id text REFERENCES nova_projects(id) ON DELETE SET NULL, run_id text REFERENCES nova_execution_runs(id) ON DELETE SET NULL,
    action text NOT NULL, tool text, status text NOT NULL, summary text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS nova_activity_owner_recent_idx ON nova_activity_events (owner_id, sequence DESC)`,
  `INSERT INTO nova_schema_migrations (version) VALUES (1), (2) ON CONFLICT (version) DO NOTHING`
]);
