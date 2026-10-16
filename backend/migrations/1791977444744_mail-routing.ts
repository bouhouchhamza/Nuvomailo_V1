import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder) {
  pgm.sql(`ALTER TABLE domains ADD COLUMN routing_generation INTEGER NOT NULL DEFAULT 0 CHECK(routing_generation>=0);
CREATE TABLE mail_routes(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,local_part TEXT NOT NULL CHECK(local_part~'^[a-z0-9]+([._-][a-z0-9]+)*$' AND length(local_part)<=64),kind TEXT NOT NULL CHECK(kind IN('alias','forward')),targets UUID[] NOT NULL CHECK(cardinality(targets) BETWEEN 1 AND 10),enabled BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(domain_id,local_part));
CREATE TABLE mail_routing_requests(id UUID PRIMARY KEY,domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,generation INTEGER NOT NULL,snapshot JSONB NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','applied','superseded','failed')),attempts INTEGER NOT NULL DEFAULT 0,lease_token UUID,lease_expires_at TIMESTAMPTZ,available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),CHECK((state='processing')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),UNIQUE(domain_id,generation));
CREATE INDEX routing_due_idx ON mail_routing_requests(available_at) WHERE state IN('pending','processing');`);
}
export function down(pgm: MigrationBuilder) {
  pgm.sql(
    "DROP TABLE mail_routing_requests;DROP TABLE mail_routes;ALTER TABLE domains DROP COLUMN routing_generation;",
  );
}
