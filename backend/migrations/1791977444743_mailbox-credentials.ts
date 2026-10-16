import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder) {
  pgm.sql(`
ALTER TABLE mailboxes ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 0 CHECK(credential_generation>=0);
CREATE TABLE mailbox_credential_grants(digest TEXT PRIMARY KEY,mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id UUID NOT NULL REFERENCES identity_sessions(id) ON DELETE CASCADE,
 purpose TEXT NOT NULL CHECK(purpose IN('setup','reset','rotate')),expires_at TIMESTAMPTZ NOT NULL,consumed_at TIMESTAMPTZ,revoked_at TIMESTAMPTZ);
CREATE TABLE mailbox_credential_artifacts(id UUID PRIMARY KEY,mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 generation INTEGER NOT NULL CHECK(generation>0),key_id TEXT NOT NULL,nonce BYTEA NOT NULL,tag BYTEA NOT NULL,sealed BYTEA NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(mailbox_id,generation));
CREATE TABLE mailbox_credential_requests(id UUID PRIMARY KEY,mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 generation INTEGER NOT NULL CHECK(generation>0),artifact_id UUID REFERENCES mailbox_credential_artifacts(id),
 state TEXT NOT NULL CHECK(state IN('hashing','pending','processing','applied','superseded','failed')),attempts INTEGER NOT NULL DEFAULT 0,
 lease_token UUID,lease_expires_at TIMESTAMPTZ,available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK((state='processing')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),UNIQUE(mailbox_id,generation));
CREATE INDEX credential_requests_due_idx ON mailbox_credential_requests(available_at) WHERE state IN('pending','processing');
`);
}
export function down(pgm: MigrationBuilder) {
  pgm.sql(
    `DROP TABLE mailbox_credential_requests;DROP TABLE mailbox_credential_artifacts;DROP TABLE mailbox_credential_grants;ALTER TABLE mailboxes DROP COLUMN credential_generation;`,
  );
}
