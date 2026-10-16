import type {MigrationBuilder} from "node-pg-migrate";
export function up(pgm:MigrationBuilder){pgm.sql(`
  ALTER TABLE mailboxes DROP CONSTRAINT mailboxes_quota_mb_check;
  ALTER TABLE mailboxes ADD CONSTRAINT mailboxes_quota_mb_check CHECK(quota_mb BETWEEN 1 AND 1048576);
  ALTER TABLE provisioning_requests DROP CONSTRAINT provisioning_requests_quota_mb_check;
  ALTER TABLE provisioning_requests ADD CONSTRAINT provisioning_requests_quota_mb_check CHECK(quota_mb BETWEEN 1 AND 1048576);
  CREATE TABLE plans(
    id TEXT PRIMARY KEY CHECK(id~'^[a-z0-9-]{3,40}$'),name TEXT NOT NULL,currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency~'^[A-Z]{3}$'),
    monthly_minor INTEGER NOT NULL CHECK(monthly_minor>=0),yearly_minor INTEGER NOT NULL CHECK(yearly_minor>=0),
    max_domains INTEGER NOT NULL CHECK(max_domains BETWEEN 1 AND 10000),max_mailboxes INTEGER NOT NULL CHECK(max_mailboxes BETWEEN 1 AND 100000),
    max_members INTEGER NOT NULL CHECK(max_members BETWEEN 1 AND 100000),max_quota_mb INTEGER NOT NULL CHECK(max_quota_mb BETWEEN 1 AND 1048576),
    storage_mb BIGINT NOT NULL CHECK(storage_mb>0),max_mailboxes_per_domain INTEGER NOT NULL CHECK(max_mailboxes_per_domain>0),active BOOLEAN NOT NULL DEFAULT true);
  INSERT INTO plans(id,name,monthly_minor,yearly_minor,max_domains,max_mailboxes,max_members,max_quota_mb,storage_mb,max_mailboxes_per_domain) VALUES
    ('development','Development sandbox',0,0,10,100,100,200,20000,100),
    ('sandbox-team','Team sandbox',0,0,25,500,250,10240,512000,250);
  CREATE TABLE organization_subscriptions(
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,plan_id TEXT NOT NULL REFERENCES plans(id),
    state TEXT NOT NULL CHECK(state IN ('trial','active','past_due','grace','canceled')),
    period TEXT NOT NULL DEFAULT 'monthly' CHECK(period IN ('monthly','yearly')),
    period_end TIMESTAMPTZ NOT NULL,grace_until TIMESTAMPTZ,cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
    provider TEXT NOT NULL DEFAULT 'sandbox' CHECK(provider IN ('sandbox','unconfigured')),version INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE billing_checkouts(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES plans(id),period TEXT NOT NULL CHECK(period IN ('monthly','yearly')),state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed','expired')),
    expected_version INTEGER NOT NULL DEFAULT 0,expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '30 minutes',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE billing_webhook_events(id UUID PRIMARY KEY,payload_digest TEXT NOT NULL,received_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE invoices(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    event_id UUID NOT NULL UNIQUE REFERENCES billing_webhook_events(id),currency TEXT NOT NULL,amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),
    state TEXT NOT NULL CHECK(state IN ('paid','failed')),provider TEXT NOT NULL DEFAULT 'sandbox',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE INDEX invoices_org_idx ON invoices(organization_id,created_at DESC);
`);}
export function down(pgm:MigrationBuilder){pgm.sql(`DROP TABLE invoices,billing_webhook_events,billing_checkouts,organization_subscriptions,plans;
  ALTER TABLE mailboxes DROP CONSTRAINT mailboxes_quota_mb_check;
  ALTER TABLE mailboxes ADD CONSTRAINT mailboxes_quota_mb_check CHECK(quota_mb IN(100,200));
  ALTER TABLE provisioning_requests DROP CONSTRAINT provisioning_requests_quota_mb_check;
  ALTER TABLE provisioning_requests ADD CONSTRAINT provisioning_requests_quota_mb_check CHECK(quota_mb IN(100,200));`);}
