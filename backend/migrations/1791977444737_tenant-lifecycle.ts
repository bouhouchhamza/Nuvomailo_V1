import type {MigrationBuilder} from "node-pg-migrate";
export function up(pgm:MigrationBuilder){pgm.sql(`
  ALTER TABLE organizations ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','retained')),
    ADD COLUMN deleted_at TIMESTAMPTZ;
  CREATE TABLE membership_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','member')),
    invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '7 days',
    accepted_at TIMESTAMPTZ,revoked_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE UNIQUE INDEX membership_invitation_open_unique ON membership_invitations(organization_id,lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;
  CREATE INDEX membership_invitation_email_idx ON membership_invitations(lower(email));
`);}
export function down(pgm:MigrationBuilder){pgm.sql(`DROP TABLE membership_invitations;ALTER TABLE organizations DROP COLUMN deleted_at,DROP COLUMN status;`);}
