import type {MigrationBuilder} from "node-pg-migrate";
export function up(pgm:MigrationBuilder){pgm.sql(`ALTER TABLE domains ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','suspended','retained')),
  ADD COLUMN mail_activation TEXT NOT NULL DEFAULT 'disabled' CHECK(mail_activation IN('disabled','local-lab')),
  ADD COLUMN retained_at TIMESTAMPTZ;`);}
export function down(pgm:MigrationBuilder){pgm.sql(`ALTER TABLE domains DROP COLUMN retained_at,DROP COLUMN mail_activation,DROP COLUMN status;`);}
