import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder) {
  pgm.sql(`CREATE TABLE webmail_send_attempts(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,request_digest TEXT NOT NULL CHECK(request_digest~'^[a-f0-9]{64}$'),
    state TEXT NOT NULL DEFAULT 'processing' CHECK(state IN('processing','accepted','uncertain')),
    sent_copy_stored BOOLEAN,accepted_recipient_count INTEGER CHECK(accepted_recipient_count>=0),
    rejected_recipient_count INTEGER CHECK(rejected_recipient_count>=0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),finished_at TIMESTAMPTZ,
    UNIQUE(mailbox_id,user_id,idempotency_key)
  );
  CREATE INDEX webmail_send_unresolved ON webmail_send_attempts(created_at,id)
    WHERE state IN('processing','uncertain');`);
}

export function down(pgm: MigrationBuilder) {
  pgm.sql("DROP TABLE webmail_send_attempts");
}
