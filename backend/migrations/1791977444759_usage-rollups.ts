import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder) {
  pgm.sql(`CREATE TABLE organization_usage_rollups(
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    mailbox_count INTEGER NOT NULL CHECK(mailbox_count>=0),
    fresh_mailbox_count INTEGER NOT NULL CHECK(fresh_mailbox_count>=0),
    stale_mailbox_count INTEGER NOT NULL CHECK(stale_mailbox_count>=0),
    unknown_mailbox_count INTEGER NOT NULL CHECK(unknown_mailbox_count>=0),
    observed_usage_bytes BIGINT NOT NULL CHECK(observed_usage_bytes>=0),
    observed_message_count BIGINT NOT NULL CHECK(observed_message_count>=0),
    allocated_quota_bytes BIGINT NOT NULL CHECK(allocated_quota_bytes>=0),
    coverage_complete BOOLEAN NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK(fresh_mailbox_count+stale_mailbox_count+unknown_mailbox_count=mailbox_count),
    CHECK(coverage_complete=(mailbox_count>0 AND stale_mailbox_count=0 AND unknown_mailbox_count=0))
  );`);
}

export function down(pgm: MigrationBuilder) {
  pgm.sql("DROP TABLE organization_usage_rollups");
}
