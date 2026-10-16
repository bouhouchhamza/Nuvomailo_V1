import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder) {
  pgm.sql(`
UPDATE domains SET mail_ever_activated=TRUE;
CREATE OR REPLACE FUNCTION preserve_domain_custody() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.mail_ever_activated:=(CASE WHEN TG_OP='UPDATE' THEN OLD.mail_ever_activated ELSE FALSE END) OR NEW.mail_ever_activated OR NEW.mail_activation<>'disabled'; RETURN NEW; END $$;
DROP TRIGGER domains_custody ON domains;
CREATE TRIGGER domains_custody BEFORE INSERT OR UPDATE ON domains FOR EACH ROW EXECUTE FUNCTION preserve_domain_custody();`);
}
export function down(pgm: MigrationBuilder) {
  pgm.sql(
    `DROP TRIGGER domains_custody ON domains;CREATE TRIGGER domains_custody BEFORE UPDATE ON domains FOR EACH ROW EXECUTE FUNCTION preserve_domain_custody();`,
  );
}
