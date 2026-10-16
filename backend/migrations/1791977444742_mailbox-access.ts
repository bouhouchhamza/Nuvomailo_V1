import type {MigrationBuilder} from "node-pg-migrate";
export function up(pgm:MigrationBuilder){pgm.sql(`CREATE TABLE mailbox_access(
  mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK(permission IN('read','write')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(mailbox_id,user_id));CREATE INDEX mailbox_access_user_idx ON mailbox_access(user_id);`);}
export function down(pgm:MigrationBuilder){pgm.sql(`DROP TABLE mailbox_access;`);}
