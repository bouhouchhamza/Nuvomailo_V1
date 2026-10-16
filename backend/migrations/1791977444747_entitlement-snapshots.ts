import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder) {
  pgm.sql(`
ALTER TABLE plans ADD COLUMN catalog_version INTEGER NOT NULL DEFAULT 1 CHECK(catalog_version>0);
CREATE FUNCTION bump_plan_catalog() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.catalog_version:=OLD.catalog_version+1;RETURN NEW;END $$;
CREATE TRIGGER plans_catalog BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION bump_plan_catalog();
CREATE FUNCTION plan_entitlements(p plans) RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$ SELECT jsonb_build_object('max_domains',p.max_domains,'max_mailboxes',p.max_mailboxes,'max_members',p.max_members,'max_quota_mb',p.max_quota_mb,'storage_mb',p.storage_mb,'max_mailboxes_per_domain',p.max_mailboxes_per_domain) $$;
ALTER TABLE organization_subscriptions ADD COLUMN entitlement_snapshot JSONB,ADD COLUMN catalog_version INTEGER;
ALTER TABLE billing_checkouts ADD COLUMN entitlement_snapshot JSONB,ADD COLUMN catalog_version INTEGER;
UPDATE organization_subscriptions s SET entitlement_snapshot=plan_entitlements(p),catalog_version=p.catalog_version FROM plans p WHERE p.id=s.plan_id;
UPDATE billing_checkouts c SET entitlement_snapshot=plan_entitlements(p),catalog_version=p.catalog_version FROM plans p WHERE p.id=c.plan_id;
ALTER TABLE organization_subscriptions ALTER COLUMN entitlement_snapshot SET NOT NULL,ALTER COLUMN catalog_version SET NOT NULL;
ALTER TABLE billing_checkouts ALTER COLUMN entitlement_snapshot SET NOT NULL,ALTER COLUMN catalog_version SET NOT NULL;
CREATE FUNCTION capture_subscription_entitlements() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
IF NEW.entitlement_snapshot IS NULL THEN SELECT plan_entitlements(p),p.catalog_version INTO NEW.entitlement_snapshot,NEW.catalog_version FROM plans p WHERE p.id=NEW.plan_id;END IF;
IF TG_OP='UPDATE' AND NEW.plan_id<>OLD.plan_id AND NEW.entitlement_snapshot IS NOT DISTINCT FROM OLD.entitlement_snapshot AND NEW.catalog_version=OLD.catalog_version THEN RAISE EXCEPTION 'NEW_ENTITLEMENT_SNAPSHOT_REQUIRED';END IF;
RETURN NEW;END $$;
CREATE TRIGGER subscription_snapshot BEFORE INSERT OR UPDATE ON organization_subscriptions FOR EACH ROW EXECUTE FUNCTION capture_subscription_entitlements();
CREATE FUNCTION capture_checkout_entitlements() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
IF TG_OP='UPDATE' THEN IF ROW(NEW.plan_id,NEW.period,NEW.expected_version,NEW.amount_minor,NEW.currency,NEW.entitlement_snapshot,NEW.catalog_version) IS DISTINCT FROM ROW(OLD.plan_id,OLD.period,OLD.expected_version,OLD.amount_minor,OLD.currency,OLD.entitlement_snapshot,OLD.catalog_version) THEN RAISE EXCEPTION 'IMMUTABLE_CHECKOUT_QUOTE';END IF;
ELSIF NEW.entitlement_snapshot IS NULL THEN SELECT plan_entitlements(p),p.catalog_version INTO NEW.entitlement_snapshot,NEW.catalog_version FROM plans p WHERE p.id=NEW.plan_id;END IF;RETURN NEW;END $$;
CREATE TRIGGER checkout_snapshot BEFORE INSERT OR UPDATE ON billing_checkouts FOR EACH ROW EXECUTE FUNCTION capture_checkout_entitlements();
`);
}
export function down(pgm: MigrationBuilder) {
  pgm.sql(
    `DROP TRIGGER checkout_snapshot ON billing_checkouts;DROP FUNCTION capture_checkout_entitlements();DROP TRIGGER subscription_snapshot ON organization_subscriptions;DROP FUNCTION capture_subscription_entitlements();ALTER TABLE billing_checkouts DROP COLUMN entitlement_snapshot,DROP COLUMN catalog_version;ALTER TABLE organization_subscriptions DROP COLUMN entitlement_snapshot,DROP COLUMN catalog_version;DROP FUNCTION plan_entitlements(plans);DROP TRIGGER plans_catalog ON plans;DROP FUNCTION bump_plan_catalog();ALTER TABLE plans DROP COLUMN catalog_version;`,
  );
}
