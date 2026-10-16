import type {MigrationBuilder} from "node-pg-migrate";
export function up(pgm:MigrationBuilder){pgm.sql(`
  ALTER TABLE users ADD COLUMN mfa_secret_enc TEXT,ADD COLUMN mfa_pending_enc TEXT,
    ADD COLUMN mfa_pending_expires TIMESTAMPTZ,ADD COLUMN mfa_last_counter BIGINT NOT NULL DEFAULT -1;
  ALTER TABLE identity_sessions ADD COLUMN mfa_verified_at TIMESTAMPTZ;
  CREATE TABLE mfa_recovery_codes(digest TEXT PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,used_at TIMESTAMPTZ);
  CREATE INDEX mfa_recovery_user_idx ON mfa_recovery_codes(user_id);
  CREATE TABLE platform_staff(user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('viewer','operator')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE platform_events(id BIGSERIAL PRIMARY KEY,actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,target_id UUID,reason TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
`);}
export function down(pgm:MigrationBuilder){pgm.sql(`DROP TABLE platform_events,platform_staff,mfa_recovery_codes;
  ALTER TABLE identity_sessions DROP COLUMN mfa_verified_at;
  ALTER TABLE users DROP COLUMN mfa_secret_enc,DROP COLUMN mfa_pending_enc,DROP COLUMN mfa_pending_expires,DROP COLUMN mfa_last_counter;`);}
