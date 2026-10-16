import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder) {
  pgm.sql(`
    ALTER TABLE mailboxes
      ADD COLUMN desired_status TEXT NOT NULL DEFAULT 'active' CHECK (desired_status IN ('active','suspended')),
      ADD COLUMN desired_revision INTEGER NOT NULL DEFAULT 0 CHECK (desired_revision >= 0),
      ADD COLUMN applied_revision INTEGER NOT NULL DEFAULT 0 CHECK (applied_revision >= 0 AND applied_revision <= desired_revision),
      ADD COLUMN observed_status TEXT NOT NULL DEFAULT 'unknown' CHECK (observed_status IN ('unknown','absent','active','suspended')),
      ADD COLUMN observed_quota_mb INTEGER CHECK (observed_quota_mb > 0),
      ADD COLUMN observed_at TIMESTAMPTZ,
      ADD COLUMN last_provisioning_error TEXT;
    ALTER TABLE provisioning_requests
      ADD COLUMN revision INTEGER,
      ADD COLUMN desired_status TEXT CHECK (desired_status IN ('active','suspended')),
      ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
      ADD COLUMN available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN lease_token UUID,
      ADD COLUMN lease_expires_at TIMESTAMPTZ,
      ADD COLUMN last_error_code TEXT,
      ADD COLUMN finished_at TIMESTAMPTZ;
    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY mailbox_id ORDER BY created_at,id)::integer AS revision
      FROM provisioning_requests
    ) UPDATE provisioning_requests p SET revision=o.revision FROM ordered o WHERE p.id=o.id;
    UPDATE provisioning_requests p SET desired_status=COALESCE((
      SELECT CASE WHEN h.operation='suspend' THEN 'suspended' ELSE 'active' END
      FROM provisioning_requests h WHERE h.mailbox_id=p.mailbox_id AND h.revision<=p.revision
        AND h.operation IN ('create','resume','suspend') ORDER BY h.revision DESC LIMIT 1
    ),'active');
    UPDATE mailboxes m SET desired_revision=COALESCE((SELECT MAX(revision) FROM provisioning_requests WHERE mailbox_id=m.id),0),
      desired_status=COALESCE((SELECT p.desired_status FROM provisioning_requests p WHERE p.mailbox_id=m.id ORDER BY revision DESC LIMIT 1),
        CASE WHEN m.provisioning_status='suspended' THEN 'suspended' ELSE 'active' END);
    -- No baseline worker existed. Recover any orphan processing rows without claiming real observations.
    UPDATE provisioning_requests SET state='pending' WHERE state='processing';
    ALTER TABLE provisioning_requests ALTER COLUMN revision SET NOT NULL, ALTER COLUMN desired_status SET NOT NULL;
    ALTER TABLE provisioning_requests ADD CONSTRAINT provisioning_revision_positive CHECK (revision > 0);
    ALTER TABLE provisioning_requests ADD CONSTRAINT provisioning_lease_consistent CHECK (
      (state='processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state<>'processing' AND lease_token IS NULL AND lease_expires_at IS NULL));
    CREATE UNIQUE INDEX provisioning_mailbox_revision_unique ON provisioning_requests(mailbox_id,revision);
    CREATE INDEX provisioning_due_idx ON provisioning_requests(available_at) WHERE state='pending';
    CREATE INDEX provisioning_lease_idx ON provisioning_requests(lease_expires_at) WHERE state='processing';
    CREATE TABLE audit_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      resource_id UUID,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX audit_tenant_id_idx ON audit_events(organization_id,id DESC);
  `);
}
export function down(pgm: MigrationBuilder) {
  pgm.sql(`DROP TABLE audit_events;
    DROP INDEX provisioning_due_idx; DROP INDEX provisioning_lease_idx; DROP INDEX provisioning_mailbox_revision_unique;
    ALTER TABLE provisioning_requests DROP CONSTRAINT provisioning_lease_consistent, DROP CONSTRAINT provisioning_revision_positive,
      DROP COLUMN revision, DROP COLUMN desired_status, DROP COLUMN attempts, DROP COLUMN max_attempts,
      DROP COLUMN available_at, DROP COLUMN lease_token, DROP COLUMN lease_expires_at, DROP COLUMN last_error_code, DROP COLUMN finished_at;
    ALTER TABLE mailboxes DROP COLUMN desired_status, DROP COLUMN desired_revision, DROP COLUMN applied_revision,
      DROP COLUMN observed_status, DROP COLUMN observed_quota_mb, DROP COLUMN observed_at, DROP COLUMN last_provisioning_error;`);
}
