import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder) {
  pgm.sql(`
ALTER TABLE domains ADD COLUMN revalidation_revision BIGINT NOT NULL DEFAULT 0 CHECK(revalidation_revision>=0);
CREATE TABLE domain_revalidation_requests(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL CHECK(revision>0), state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN('pending','processing','completed','superseded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 5),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), lease_token UUID, lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT, result_state TEXT CHECK(result_state IN('current','warning','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
  UNIQUE(domain_id,revision), CHECK((state='processing')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX domain_revalidation_one_outstanding ON domain_revalidation_requests(domain_id)
  WHERE state IN('pending','processing');
CREATE INDEX domain_revalidation_due ON domain_revalidation_requests(available_at,created_at)
  WHERE state IN('pending','processing');
CREATE INDEX domains_revalidation_due ON domains(revalidation_due_at,id)
  WHERE verification_status='verified' AND status='active';

CREATE TABLE domain_notification_outbox(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  revalidation_revision BIGINT NOT NULL CHECK(revalidation_revision>0),
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('warning','failed','recovered')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','delivered','canceled','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 5),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), lease_token UUID, lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
  UNIQUE(domain_id,revalidation_revision,recipient_user_id,kind),
  CHECK((state='processing')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX domain_notification_due ON domain_notification_outbox(available_at,created_at)
  WHERE state IN('pending','processing');
CREATE TABLE synthetic_notification_deliveries(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), outbox_id UUID NOT NULL UNIQUE REFERENCES domain_notification_outbox(id) ON DELETE CASCADE,
  idempotency_key UUID NOT NULL UNIQUE, recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_address_digest TEXT NOT NULL CHECK(recipient_address_digest~'^[a-f0-9]{64}$'),
  kind TEXT NOT NULL CHECK(kind IN('warning','failed','recovered')), delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`);
}

export function down(pgm: MigrationBuilder) {
  pgm.sql(`DROP TABLE synthetic_notification_deliveries;DROP TABLE domain_notification_outbox;
    DROP TABLE domain_revalidation_requests;ALTER TABLE domains DROP COLUMN revalidation_revision;`);
}
