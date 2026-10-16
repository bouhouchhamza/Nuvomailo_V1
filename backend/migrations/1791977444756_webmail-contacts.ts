import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder) {
  pgm.sql(`CREATE TABLE webmail_contacts(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL DEFAULT '' CHECK(length(display_name)<=100),
    email TEXT NOT NULL CHECK(length(email) BETWEEN 3 AND 254 AND email=lower(email)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(mailbox_id,user_id,email)
  );
  CREATE INDEX webmail_contacts_owner ON webmail_contacts(user_id,mailbox_id,display_name,email);`);
}

export function down(pgm: MigrationBuilder) {
  pgm.sql("DROP TABLE webmail_contacts");
}
