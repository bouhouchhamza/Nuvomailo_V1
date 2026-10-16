import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import pool from "../config/database.js";
import { transaction, type Db } from "../repositories/transaction.js";

const component = z.enum([
  "control-plane",
  "provisioning-worker",
  "domain-scheduler",
  "notification-worker",
]);
const instance = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);
export type AlertKind = "opened" | "acknowledged" | "resolved";
type IncidentAlert = {
  id: string;
  version: number;
  severity: "warning" | "critical";
  component: string;
  symptom: string;
};

export async function recordHeartbeat(
  name: z.infer<typeof component>,
  instanceId: string,
  state: "healthy" | "degraded" = "healthy",
  ttlMs = 90_000,
) {
  component.parse(name);
  instance.parse(instanceId);
  z.enum(["healthy", "degraded"]).parse(state);
  if (!Number.isInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 600_000)
    throw new Error("Invalid heartbeat TTL");
  const digest = createHash("sha256").update(instanceId).digest("hex");
  await pool.query(
    `INSERT INTO platform_heartbeats(component,instance_digest,state,expires_at)
    VALUES($1,$2,$3,NOW()+($4::integer*INTERVAL '1 millisecond'))
    ON CONFLICT(component,instance_digest) DO UPDATE SET state=EXCLUDED.state,
    observed_at=NOW(),expires_at=EXCLUDED.expires_at`,
    [name, digest, state, ttlMs],
  );
}

export async function heartbeatStatus(db: Db = pool) {
  return (
    await db.query(
      `SELECT component,state,observed_at AS "observedAt",expires_at AS "expiresAt",
      expires_at>NOW() AS fresh FROM platform_heartbeats
      ORDER BY component,observed_at DESC LIMIT 100`,
    )
  ).rows;
}

export async function enqueueIncidentAlert(
  db: Db,
  incident: IncidentAlert,
  kind: AlertKind,
) {
  await db.query(
    `INSERT INTO platform_alert_outbox(incident_id,incident_version,kind,severity)
    VALUES($1,$2,$3,$4) ON CONFLICT(incident_id,incident_version,kind) DO NOTHING`,
    [incident.id, incident.version, kind, incident.severity],
  );
}

export type OperationsAlertEvent = {
  idempotencyKey: string;
  outboxId: string;
  incidentId: string;
  component: string;
  symptom: string;
  kind: AlertKind;
  severity: "warning" | "critical";
};
export interface OperationsAlertTransport {
  readonly mode: "local-synthetic" | "unconfigured";
  deliver(event: OperationsAlertEvent, signal: AbortSignal): Promise<void>;
}
export class OperationsAlertError extends Error {
  constructor(
    readonly code: "TRANSPORT_UNAVAILABLE" | "OPERATION_TIMEOUT",
    readonly retryable = true,
  ) {
    super(code);
  }
}
export class SyntheticOperationsAlertTransport implements OperationsAlertTransport {
  readonly mode = "local-synthetic" as const;
  constructor(private destination = "synthetic-local-oncall") {}
  async deliver(event: OperationsAlertEvent, signal: AbortSignal) {
    if (signal.aborted) throw new OperationsAlertError("OPERATION_TIMEOUT");
    await pool.query(
      `INSERT INTO synthetic_alert_deliveries
      (outbox_id,idempotency_key,incident_id,kind,severity,destination_digest)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        event.outboxId,
        event.idempotencyKey,
        event.incidentId,
        event.kind,
        event.severity,
        createHash("sha256").update(this.destination).digest("hex"),
      ],
    );
  }
}

export async function runOperationsAlertOnce(
  transport: OperationsAlertTransport,
  options: {
    allowSynthetic?: boolean;
    leaseMs?: number;
    timeoutMs?: number;
  } = {},
) {
  if (transport.mode === "local-synthetic" && !options.allowSynthetic)
    throw new Error("Synthetic alert transport requires explicit opt-in");
  const leaseMs = options.leaseMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (leaseMs < timeoutMs + 1000) throw new Error("Alert lease too short");
  const claimed = await transaction(async (db) => {
    const row = (
      await db.query(
        `SELECT a.*,i.component,i.symptom FROM platform_alert_outbox a
        JOIN platform_incidents i ON i.id=a.incident_id
        WHERE (a.state='pending' OR (a.state='processing' AND a.lease_expires_at<NOW()))
        AND a.available_at<=NOW() ORDER BY a.created_at,a.id LIMIT 1
        FOR UPDATE OF a SKIP LOCKED`,
      )
    ).rows[0];
    if (!row) return null;
    const lease = randomUUID();
    await db.query(
      `UPDATE platform_alert_outbox SET state='processing',attempts=LEAST(attempts+1,max_attempts),
      lease_token=$2,lease_expires_at=NOW()+($3::integer*INTERVAL '1 millisecond') WHERE id=$1`,
      [row.id, lease, leaseMs],
    );
    return { ...row, lease };
  });
  if (!claimed) return "idle" as const;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await Promise.race([
        transport.deliver(
          {
            idempotencyKey: claimed.id,
            outboxId: claimed.id,
            incidentId: claimed.incident_id,
            component: claimed.component,
            symptom: claimed.symptom,
            kind: claimed.kind,
            severity: claimed.severity,
          },
          controller.signal,
        ),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new OperationsAlertError("OPERATION_TIMEOUT")),
            { once: true },
          ),
        ),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const acknowledged = await pool.query(
      `UPDATE platform_alert_outbox SET state='delivered',finished_at=NOW(),
      lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL
      WHERE id=$1 AND lease_token=$2 AND lease_expires_at>NOW() RETURNING id`,
      [claimed.id, claimed.lease],
    );
    return acknowledged.rowCount ? ("delivered" as const) : ("stale" as const);
  } catch (error) {
    const code =
        error instanceof OperationsAlertError
          ? error.code
          : "TRANSPORT_UNAVAILABLE",
      retryable =
        error instanceof OperationsAlertError ? error.retryable : true;
    const result = (
      await pool.query(
        `UPDATE platform_alert_outbox SET
        state=CASE WHEN $3 AND attempts<max_attempts THEN 'pending' ELSE 'failed' END,
        available_at=NOW()+INTERVAL '30 seconds',last_error_code=$4,
        lease_token=NULL,lease_expires_at=NULL,
        finished_at=CASE WHEN NOT $3 OR attempts>=max_attempts THEN NOW() ELSE NULL END
        WHERE id=$1 AND lease_token=$2 AND lease_expires_at>NOW() RETURNING state`,
        [claimed.id, claimed.lease, retryable, code],
      )
    ).rows[0];
    return !result
      ? ("stale" as const)
      : result.state === "pending"
        ? ("retry" as const)
        : ("failed" as const);
  }
}
