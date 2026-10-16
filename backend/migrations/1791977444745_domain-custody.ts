import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder) {
  pgm.sql(`ALTER TABLE domains ADD COLUMN mail_ever_activated BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE domains SET mail_ever_activated=TRUE WHERE verification_status='verified' OR mail_activation<>'disabled';
CREATE FUNCTION preserve_domain_custody() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.mail_ever_activated:=COALESCE(OLD.mail_ever_activated,FALSE) OR NEW.mail_ever_activated OR NEW.mail_activation<>'disabled'; RETURN NEW; END $$;
CREATE TRIGGER domains_custody BEFORE UPDATE ON domains FOR EACH ROW EXECUTE FUNCTION preserve_domain_custody();`);
}
export function down(pgm: MigrationBuilder) {
  pgm.sql(
    "DROP TRIGGER domains_custody ON domains;DROP FUNCTION preserve_domain_custody();ALTER TABLE domains DROP COLUMN mail_ever_activated;",
  );
}
