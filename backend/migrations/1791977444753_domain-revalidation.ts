import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder) {
  pgm.sql(`ALTER TABLE domains
    ADD COLUMN revalidation_state TEXT NOT NULL DEFAULT 'due' CHECK(revalidation_state IN('due','current','warning','failed')),
    ADD COLUMN ownership_revalidated_at TIMESTAMPTZ,
    ADD COLUMN revalidation_due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN revalidation_last_attempt_at TIMESTAMPTZ,
    ADD COLUMN revalidation_failures INTEGER NOT NULL DEFAULT 0 CHECK(revalidation_failures>=0),
    ADD COLUMN revalidation_grace_expires_at TIMESTAMPTZ;
  CREATE TABLE released_domain_claims(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), original_domain_id UUID NOT NULL UNIQUE,
    organization_id UUID NOT NULL REFERENCES organizations(id), name_digest TEXT NOT NULL CHECK(name_digest~'^[a-f0-9]{64}$'),
    released_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL CHECK(reason IN('owner-no-longer-controls','test-claim')),
    released_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
}
export function down(pgm: MigrationBuilder) {
  pgm.sql(`DROP TABLE released_domain_claims;ALTER TABLE domains DROP COLUMN revalidation_grace_expires_at,
    DROP COLUMN revalidation_failures,DROP COLUMN revalidation_last_attempt_at,DROP COLUMN revalidation_due_at,
    DROP COLUMN ownership_revalidated_at,DROP COLUMN revalidation_state;`);
}
