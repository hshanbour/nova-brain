ALTER TABLE nova_project_sources ADD COLUMN IF NOT EXISTS extraction_status text NOT NULL DEFAULT 'not_required' CHECK (extraction_status IN ('not_required','completed','failed'));
ALTER TABLE nova_project_sources ADD COLUMN IF NOT EXISTS extracted_text text CHECK (extracted_text IS NULL OR octet_length(extracted_text) <= 131072);
ALTER TABLE nova_project_sources ADD COLUMN IF NOT EXISTS extraction_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(extraction_metadata::text) <= 16384);
ALTER TABLE nova_project_sources ADD COLUMN IF NOT EXISTS retrieved_at timestamptz;
INSERT INTO nova_schema_migrations(version) VALUES (24) ON CONFLICT DO NOTHING;
