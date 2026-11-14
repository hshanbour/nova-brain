-- Apply explicitly to the intended existing workspace. No contacts, messages,
-- lease fields or queue rows are rewritten. Keep the relaxed constraints when
-- rolling the application back if any rows already use one of the new states.
BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE nova_whatsapp_inbound_messages
  DROP CONSTRAINT nova_whatsapp_inbound_messages_status_check,
  ADD CONSTRAINT nova_whatsapp_inbound_messages_status_check CHECK (
    status IN ('queued','processing','replied','failed','awaiting_owner_review','opt_out_received')
  );
ALTER TABLE nova_whatsapp_outbound_messages
  DROP CONSTRAINT nova_whatsapp_outbound_messages_status_check,
  ADD CONSTRAINT nova_whatsapp_outbound_messages_status_check CHECK (
    status IN ('sending','submitted','queued','sent','delivered','read','undelivered','failed','uncertain','blocked')
  );
INSERT INTO nova_schema_migrations (version) VALUES (32) ON CONFLICT (version) DO NOTHING;
COMMIT;
