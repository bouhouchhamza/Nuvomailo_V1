import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder) {
  pgm.sql(`
    ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
      ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0 CHECK(auth_version>=0), ADD COLUMN email_verified_at TIMESTAMPTZ;
    CREATE TABLE identity_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX identity_sessions_user_idx ON identity_sessions(user_id);
    CREATE TABLE refresh_tokens (
      digest TEXT PRIMARY KEY, session_id UUID NOT NULL REFERENCES identity_sessions(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), consumed_at TIMESTAMPTZ);
    CREATE INDEX refresh_tokens_session_idx ON refresh_tokens(session_id);
    CREATE TABLE identity_grants (
      digest TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('reset','verify')), auth_version INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX identity_grants_user_idx ON identity_grants(user_id);
    CREATE TABLE security_events (id BIGSERIAL PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX security_events_user_idx ON security_events(user_id,id DESC);
  `);
}
export function down(pgm: MigrationBuilder) {
  pgm.sql(`DROP TABLE security_events,identity_grants,refresh_tokens,identity_sessions;
    ALTER TABLE users DROP COLUMN email_verified_at,DROP COLUMN auth_version,DROP COLUMN status;`);
}
