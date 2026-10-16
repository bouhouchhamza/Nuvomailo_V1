import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder) {
  pgm.sql(`CREATE TABLE mailboxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
    local_part TEXT NOT NULL CHECK (local_part=lower(local_part) AND length(local_part) BETWEEN 1 AND 64),
    quota_mb INTEGER NOT NULL DEFAULT 100 CHECK (quota_mb IN (100,200)),
    provisioning_status TEXT NOT NULL DEFAULT 'pending_provisioning' CHECK (provisioning_status IN ('pending_provisioning','active','failed','suspended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(domain_id,local_part)
  );
  CREATE INDEX mailboxes_domain_idx ON mailboxes(domain_id);
  CREATE TABLE provisioning_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN ('create','set_quota','suspend','resume')),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','completed','failed')),
    quota_mb INTEGER NOT NULL CHECK (quota_mb IN (100,200)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  ); CREATE INDEX provisioning_pending_idx ON provisioning_requests(state,created_at);`);
}
export function down(pgm: MigrationBuilder) {
  pgm.sql("DROP TABLE provisioning_requests; DROP TABLE mailboxes;");
}
