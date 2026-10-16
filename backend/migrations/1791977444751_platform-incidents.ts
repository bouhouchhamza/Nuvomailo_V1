import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder) {
  pgm.sql(`CREATE TABLE platform_incidents (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), component TEXT NOT NULL CHECK(component IN('control-plane','mail-plane','backup','payments')),
 symptom TEXT NOT NULL CHECK(symptom IN('unavailable','queue-delayed','recovery-failed','integrity-review')),
 severity TEXT NOT NULL CHECK(severity IN('warning','critical')),state TEXT NOT NULL DEFAULT 'open' CHECK(state IN('open','acknowledged','resolved')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),created_by UUID REFERENCES users(id) ON DELETE SET NULL,
 updated_by UUID REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),resolved_at TIMESTAMPTZ,
 CHECK((state='resolved')=(resolved_at IS NOT NULL))
 ); CREATE UNIQUE INDEX platform_incident_active ON platform_incidents(component,symptom) WHERE state<>'resolved';`);
}
export function down(pgm: MigrationBuilder) {
  pgm.dropTable("platform_incidents");
}
