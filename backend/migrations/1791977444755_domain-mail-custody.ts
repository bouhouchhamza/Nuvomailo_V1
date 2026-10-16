import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder) {
  pgm.sql(`ALTER TABLE mailboxes
    ADD COLUMN desired_inbound_policy TEXT NOT NULL DEFAULT 'accept' CHECK(desired_inbound_policy IN('accept','defer')),
    ADD COLUMN observed_inbound_policy TEXT NOT NULL DEFAULT 'unknown' CHECK(observed_inbound_policy IN('unknown','accept','defer'));
  ALTER TABLE provisioning_requests
    ADD COLUMN inbound_policy TEXT NOT NULL DEFAULT 'accept' CHECK(inbound_policy IN('accept','defer'));
  ALTER TABLE provisioning_requests DROP CONSTRAINT provisioning_requests_operation_check;
  ALTER TABLE provisioning_requests ADD CONSTRAINT provisioning_requests_operation_check
    CHECK(operation IN('create','set_quota','suspend','resume','reconcile','domain_custody'));`);
}

export function down(pgm: MigrationBuilder) {
  pgm.sql(`UPDATE provisioning_requests SET operation='suspend' WHERE operation='domain_custody';
    ALTER TABLE provisioning_requests DROP CONSTRAINT provisioning_requests_operation_check;
    ALTER TABLE provisioning_requests ADD CONSTRAINT provisioning_requests_operation_check
      CHECK(operation IN('create','set_quota','suspend','resume','reconcile'));
    ALTER TABLE provisioning_requests DROP COLUMN inbound_policy;
    ALTER TABLE mailboxes DROP COLUMN observed_inbound_policy,DROP COLUMN desired_inbound_policy;`);
}
