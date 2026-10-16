import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder) {
  pgm.sql(`
ALTER TABLE mailboxes ADD COLUMN observed_usage_bytes BIGINT CHECK(observed_usage_bytes>=0),
  ADD COLUMN observed_message_count BIGINT CHECK(observed_message_count>=0),
  ADD COLUMN usage_observed_at TIMESTAMPTZ,
  ADD COLUMN usage_last_error_code TEXT;
CREATE TABLE mailbox_usage_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 5),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token UUID, lease_expires_at TIMESTAMPTZ, last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
  CHECK((state='processing')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX mailbox_usage_one_outstanding ON mailbox_usage_requests(mailbox_id) WHERE state IN('pending','processing');
CREATE INDEX mailbox_usage_due ON mailbox_usage_requests(available_at,created_at) WHERE state IN('pending','processing');
`);
}
export function down(pgm: MigrationBuilder) {
  pgm.sql(`DROP TABLE mailbox_usage_requests; ALTER TABLE mailboxes DROP COLUMN usage_last_error_code,
    DROP COLUMN usage_observed_at,DROP COLUMN observed_message_count,DROP COLUMN observed_usage_bytes;`);
}
