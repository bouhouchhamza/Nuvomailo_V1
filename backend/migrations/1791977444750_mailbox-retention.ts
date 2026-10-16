import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder) {
  pgm.sql(
    `ALTER TABLE mailboxes ADD COLUMN retained_at TIMESTAMPTZ, ADD CONSTRAINT retained_mailbox_suspended CHECK(retained_at IS NULL OR desired_status='suspended');`,
  );
}
export function down(pgm: MigrationBuilder) {
  pgm.sql(
    "ALTER TABLE mailboxes DROP CONSTRAINT retained_mailbox_suspended,DROP COLUMN retained_at;",
  );
}
