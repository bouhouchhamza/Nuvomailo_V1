import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder) {
  pgm.sql(`CREATE TABLE support_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    granted_by UUID NOT NULL REFERENCES users(id),
    staff_user_id UUID NOT NULL REFERENCES platform_staff(user_id),
    scope TEXT NOT NULL DEFAULT 'diagnostics-read' CHECK(scope='diagnostics-read'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '1 hour')
  ); CREATE INDEX support_grants_org ON support_grants(organization_id,created_at DESC);`);
}
export function down(pgm: MigrationBuilder) {
  pgm.dropTable("support_grants");
}
