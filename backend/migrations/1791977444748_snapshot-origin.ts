import type { MigrationBuilder } from "node-pg-migrate";
const limits =
  "jsonb_build_object('max_domains',p.max_domains,'max_mailboxes',p.max_mailboxes,'max_members',p.max_members,'max_quota_mb',p.max_quota_mb,'storage_mb',p.storage_mb,'max_mailboxes_per_domain',p.max_mailboxes_per_domain)";
export function up(pgm: MigrationBuilder) {
  pgm.sql(`
CREATE OR REPLACE FUNCTION plan_entitlements(p plans) RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$ SELECT ${limits}||jsonb_build_object('plan_id',p.id,'catalog_version',p.catalog_version) $$;
DROP TRIGGER checkout_snapshot ON billing_checkouts;
UPDATE billing_checkouts SET entitlement_snapshot=entitlement_snapshot||jsonb_build_object('plan_id',plan_id,'catalog_version',catalog_version);
UPDATE organization_subscriptions SET entitlement_snapshot=entitlement_snapshot||jsonb_build_object('plan_id',plan_id,'catalog_version',catalog_version);
CREATE TRIGGER checkout_snapshot BEFORE INSERT OR UPDATE ON billing_checkouts FOR EACH ROW EXECUTE FUNCTION capture_checkout_entitlements();
ALTER TABLE billing_checkouts ADD CONSTRAINT checkout_entitlement_origin CHECK(entitlement_snapshot->>'plan_id'=plan_id AND (entitlement_snapshot->>'catalog_version')::integer=catalog_version AND (entitlement_snapshot ? 'plan_id') AND (entitlement_snapshot ? 'catalog_version'));
ALTER TABLE organization_subscriptions ADD CONSTRAINT subscription_entitlement_origin CHECK(entitlement_snapshot->>'plan_id'=plan_id AND (entitlement_snapshot->>'catalog_version')::integer=catalog_version AND (entitlement_snapshot ? 'plan_id') AND (entitlement_snapshot ? 'catalog_version'));
`);
}
export function down(pgm: MigrationBuilder) {
  pgm.sql(
    `ALTER TABLE billing_checkouts DROP CONSTRAINT checkout_entitlement_origin;ALTER TABLE organization_subscriptions DROP CONSTRAINT subscription_entitlement_origin;DROP TRIGGER checkout_snapshot ON billing_checkouts;UPDATE billing_checkouts SET entitlement_snapshot=entitlement_snapshot-'plan_id'-'catalog_version';UPDATE organization_subscriptions SET entitlement_snapshot=entitlement_snapshot-'plan_id'-'catalog_version';CREATE TRIGGER checkout_snapshot BEFORE INSERT OR UPDATE ON billing_checkouts FOR EACH ROW EXECUTE FUNCTION capture_checkout_entitlements();CREATE OR REPLACE FUNCTION plan_entitlements(p plans) RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$ SELECT ${limits} $$;`,
  );
}
