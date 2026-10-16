import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder) {
  pgm.sql(`CREATE TABLE billing_renewal_requests(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subscription_version INTEGER NOT NULL CHECK(subscription_version>0),
    plan_id TEXT NOT NULL REFERENCES plans(id),
    period TEXT NOT NULL CHECK(period IN('monthly','yearly')),
    prior_period_end TIMESTAMPTZ NOT NULL,
    amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),
    currency TEXT NOT NULL CHECK(currency~'^[A-Z]{3}$'),
    entitlement_snapshot JSONB NOT NULL,
    catalog_version INTEGER NOT NULL CHECK(catalog_version>0),
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','succeeded','failed','superseded','uncertain')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
    max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 5),
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_token UUID,lease_expires_at TIMESTAMPTZ,last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),finished_at TIMESTAMPTZ,
    UNIQUE(organization_id,subscription_version,prior_period_end),
    CHECK((state='processing')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK(entitlement_snapshot->>'plan_id'=plan_id AND
      (entitlement_snapshot->>'catalog_version')::integer=catalog_version)
  );
  CREATE INDEX billing_renewals_due ON billing_renewal_requests(available_at,created_at)
    WHERE state IN('pending','processing');
  CREATE TABLE synthetic_billing_renewal_effects(
    request_id UUID PRIMARY KEY REFERENCES billing_renewal_requests(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL UNIQUE,
    outcome TEXT NOT NULL CHECK(outcome IN('succeeded','failed')),
    provider_reference_digest TEXT NOT NULL CHECK(provider_reference_digest~'^[a-f0-9]{64}$'),
    effected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE invoices ALTER COLUMN event_id DROP NOT NULL;
  ALTER TABLE invoices ADD COLUMN renewal_request_id UUID UNIQUE REFERENCES billing_renewal_requests(id);
  ALTER TABLE invoices ADD CONSTRAINT invoice_source CHECK(
    (event_id IS NOT NULL AND renewal_request_id IS NULL) OR
    (event_id IS NULL AND renewal_request_id IS NOT NULL));`);
}

export function down(pgm: MigrationBuilder) {
  pgm.sql(`DELETE FROM invoices WHERE renewal_request_id IS NOT NULL;
    ALTER TABLE invoices DROP CONSTRAINT invoice_source;
    ALTER TABLE invoices DROP COLUMN renewal_request_id;
    ALTER TABLE invoices ALTER COLUMN event_id SET NOT NULL;
    DROP TABLE synthetic_billing_renewal_effects;
    DROP TABLE billing_renewal_requests;`);
}
