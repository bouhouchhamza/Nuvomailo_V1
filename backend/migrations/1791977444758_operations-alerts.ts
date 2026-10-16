import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder) {
  pgm.sql(`CREATE TABLE platform_heartbeats(
    component TEXT NOT NULL CHECK(component IN('control-plane','provisioning-worker','domain-scheduler','notification-worker')),
    instance_digest TEXT NOT NULL CHECK(instance_digest~'^[a-f0-9]{64}$'),
    state TEXT NOT NULL CHECK(state IN('healthy','degraded')),
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(component,instance_digest),CHECK(expires_at>observed_at)
  );
  CREATE INDEX platform_heartbeats_expiry ON platform_heartbeats(expires_at,component);
  CREATE TABLE platform_alert_outbox(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES platform_incidents(id) ON DELETE CASCADE,
    incident_version INTEGER NOT NULL CHECK(incident_version>0),
    kind TEXT NOT NULL CHECK(kind IN('opened','acknowledged','resolved')),
    severity TEXT NOT NULL CHECK(severity IN('warning','critical')),
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','delivered','failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
    max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 5),
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),lease_token UUID,lease_expires_at TIMESTAMPTZ,
    last_error_code TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),finished_at TIMESTAMPTZ,
    UNIQUE(incident_id,incident_version,kind),
    CHECK((state='processing')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
  );
  CREATE INDEX platform_alert_due ON platform_alert_outbox(available_at,created_at)
    WHERE state IN('pending','processing');
  CREATE TABLE synthetic_alert_deliveries(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outbox_id UUID NOT NULL UNIQUE REFERENCES platform_alert_outbox(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL UNIQUE,
    incident_id UUID NOT NULL REFERENCES platform_incidents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN('opened','acknowledged','resolved')),
    severity TEXT NOT NULL CHECK(severity IN('warning','critical')),
    destination_digest TEXT NOT NULL CHECK(destination_digest~'^[a-f0-9]{64}$'),
    delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
}

export function down(pgm: MigrationBuilder) {
  pgm.sql(
    "DROP TABLE synthetic_alert_deliveries;DROP TABLE platform_alert_outbox;DROP TABLE platform_heartbeats;",
  );
}
