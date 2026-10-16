import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import {
  enqueueIncidentAlert,
  heartbeatStatus,
  recordHeartbeat,
  runOperationsAlertOnce,
  SyntheticOperationsAlertTransport,
} from "../src/services/operations-alert.service.js";

let incidentId: string | undefined;
after(async () => {
  if (incidentId)
    await pool.query("DELETE FROM platform_incidents WHERE id=$1", [
      incidentId,
    ]);
  await pool.query(
    "DELETE FROM platform_heartbeats WHERE component='notification-worker'",
  );
  await pool.end();
});

test("synthetic incident alerts are explicit, leased, idempotent and heartbeat state is observable", async () => {
  const incident = (
    await pool.query(
      `INSERT INTO platform_incidents(component,symptom,severity)
      VALUES('backup','recovery-failed','critical') RETURNING *`,
    )
  ).rows[0]!;
  incidentId = incident.id;
  await enqueueIncidentAlert(pool, incident, "opened");
  const transport = new SyntheticOperationsAlertTransport();
  await assert.rejects(runOperationsAlertOnce(transport));
  assert.equal(
    await runOperationsAlertOnce(transport, { allowSynthetic: true }),
    "delivered",
  );
  const outbox = (
    await pool.query(
      "SELECT id,state FROM platform_alert_outbox WHERE incident_id=$1",
      [incident.id],
    )
  ).rows[0]!;
  assert.equal(outbox.state, "delivered");
  await pool.query(
    `UPDATE platform_alert_outbox SET state='pending',attempts=0,finished_at=NULL,
    lease_token=NULL,lease_expires_at=NULL WHERE id=$1`,
    [outbox.id],
  );
  assert.equal(
    await runOperationsAlertOnce(transport, { allowSynthetic: true }),
    "delivered",
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM synthetic_alert_deliveries WHERE outbox_id=$1",
          [outbox.id],
        )
      ).rows[0].count,
    ),
    1,
  );
  assert.doesNotMatch(
    JSON.stringify(
      (
        await pool.query(
          "SELECT * FROM synthetic_alert_deliveries WHERE outbox_id=$1",
          [outbox.id],
        )
      ).rows,
    ),
    /synthetic-local-oncall/,
  );
  const instance = `test:${randomUUID()}`;
  await recordHeartbeat("notification-worker", instance, "healthy", 10_000);
  const fresh = (await heartbeatStatus()).find(
    (row) => row.component === "notification-worker",
  );
  assert.equal(fresh?.fresh, true);
  assert.doesNotMatch(JSON.stringify(fresh), new RegExp(instance));
  await pool.query(
    `UPDATE platform_heartbeats SET observed_at=NOW()-INTERVAL '2 seconds',
    expires_at=NOW()-INTERVAL '1 second' WHERE component='notification-worker'`,
  );
  const expired = (await heartbeatStatus()).find(
    (row) => row.component === "notification-worker",
  );
  assert.equal(expired?.fresh, false);
});
