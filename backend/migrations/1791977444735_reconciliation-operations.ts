import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder) {
  pgm.sql(`ALTER TABLE provisioning_requests DROP CONSTRAINT provisioning_requests_operation_check;
    ALTER TABLE provisioning_requests ADD CONSTRAINT provisioning_requests_operation_check
      CHECK (operation IN ('create','set_quota','suspend','resume','reconcile'));`);
}
export function down(pgm: MigrationBuilder) {
  // Retain work when returning to the old schema; a quota operation still has a full snapshot.
  pgm.sql(`UPDATE provisioning_requests SET operation='set_quota' WHERE operation='reconcile';
    ALTER TABLE provisioning_requests DROP CONSTRAINT provisioning_requests_operation_check;
    ALTER TABLE provisioning_requests ADD CONSTRAINT provisioning_requests_operation_check CHECK (operation IN ('create','set_quota','suspend','resume'));`);
}
