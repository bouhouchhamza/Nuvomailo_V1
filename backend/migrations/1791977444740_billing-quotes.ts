import type {MigrationBuilder} from "node-pg-migrate";
export function up(pgm:MigrationBuilder){pgm.sql(`ALTER TABLE billing_checkouts ADD COLUMN amount_minor INTEGER,ADD COLUMN currency TEXT;
  UPDATE billing_checkouts c SET amount_minor=CASE WHEN c.period='yearly' THEN p.yearly_minor ELSE p.monthly_minor END,currency=p.currency FROM plans p WHERE p.id=c.plan_id;
  ALTER TABLE billing_checkouts ALTER COLUMN amount_minor SET NOT NULL,ALTER COLUMN currency SET NOT NULL,
    ADD CONSTRAINT checkout_amount_nonnegative CHECK(amount_minor>=0),ADD CONSTRAINT checkout_currency CHECK(currency~'^[A-Z]{3}$');`);}
export function down(pgm:MigrationBuilder){pgm.sql(`ALTER TABLE billing_checkouts DROP COLUMN amount_minor,DROP COLUMN currency;`);}
