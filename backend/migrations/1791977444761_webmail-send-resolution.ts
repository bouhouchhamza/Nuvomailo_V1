import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder) {
  pgm.sql(`ALTER TABLE webmail_send_attempts
    ADD COLUMN resolution TEXT CHECK(resolution IN('confirmed_sent','confirmed_not_sent')),
    ADD COLUMN resolved_at TIMESTAMPTZ,
    ADD CONSTRAINT webmail_send_resolution_complete CHECK(
      (resolution IS NULL AND resolved_at IS NULL) OR
      (resolution IS NOT NULL AND resolved_at IS NOT NULL)
    );
  DROP INDEX webmail_send_unresolved;
  CREATE INDEX webmail_send_unresolved ON webmail_send_attempts(created_at,id)
    WHERE state IN('processing','uncertain') AND resolution IS NULL;`);
}

export function down(pgm: MigrationBuilder) {
  pgm.sql(`DROP INDEX webmail_send_unresolved;
  CREATE INDEX webmail_send_unresolved ON webmail_send_attempts(created_at,id)
    WHERE state IN('processing','uncertain');
  ALTER TABLE webmail_send_attempts DROP CONSTRAINT webmail_send_resolution_complete,
    DROP COLUMN resolution,DROP COLUMN resolved_at;`);
}
