
import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX users_email_unique
      ON users (LOWER(email));

    CREATE TABLE organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE memberships (
      user_id UUID NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,

      organization_id UUID NOT NULL
        REFERENCES organizations(id) ON DELETE CASCADE,

      role TEXT NOT NULL
        CHECK (role IN ('owner', 'admin', 'member')),

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY (user_id, organization_id)
    );

    CREATE INDEX memberships_organization_idx
      ON memberships (organization_id);
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE memberships;
    DROP TABLE organizations;
    DROP TABLE users;
  `);
};
