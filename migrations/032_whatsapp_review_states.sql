-- For the connected workspace, confirm neon.branch_id, neon.endpoint_id and
-- current_database() in the release session. Both statuses are shared with
-- the generic WhatsApp handler. Capture the previous constraint definitions,
-- inbound/outbound row counts and lease/attempt snapshot before applying.
-- Explicitly retaining the worker and outbound holds allows verification of the
-- same queue after commit. Application rollback can keep these wider checks.
-- Restore the old checks only if no rows use the new states; preserve receipts.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5s';
-- A busy table aborts the transaction before any constraint is replaced.
LOCK TABLE public.nova_whatsapp_inbound_messages, public.nova_whatsapp_outbound_messages
  IN ACCESS EXCLUSIVE MODE NOWAIT;
ALTER TABLE public.nova_whatsapp_inbound_messages
  DROP CONSTRAINT nova_whatsapp_inbound_messages_status_check,
  ADD CONSTRAINT nova_whatsapp_inbound_messages_status_check CHECK (
    status IN ('queued','processing','replied','failed','awaiting_owner_review','opt_out_received')
  );
ALTER TABLE public.nova_whatsapp_outbound_messages
  DROP CONSTRAINT nova_whatsapp_outbound_messages_status_check,
  ADD CONSTRAINT nova_whatsapp_outbound_messages_status_check CHECK (
    status IN ('sending','submitted','queued','sent','delivered','read','undelivered','failed','uncertain','blocked')
  );
INSERT INTO public.nova_schema_migrations (version) VALUES (32) ON CONFLICT (version) DO NOTHING;
COMMIT;
