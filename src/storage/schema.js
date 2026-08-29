export const SCHEMA_VERSION = 1;

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
  `INSERT INTO nova_schema_migrations (version) VALUES (1) ON CONFLICT (version) DO NOTHING`
]);
