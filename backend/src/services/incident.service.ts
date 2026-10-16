import { z } from "zod";
import pool from "../config/database.js";
import { transaction } from "../repositories/transaction.js";
import { requireStaff } from "./platform.service.js";
import { HttpError } from "../middlewares/errors.js";
import { enqueueIncidentAlert } from "./operations-alert.service.js";
export async function list(actor: string, session: string | undefined) {
  await requireStaff(actor, session);
  return {
    notificationDelivery: "local-synthetic-available",
    alertQueue: (
      await pool.query(
        `SELECT state,count(*)::int AS events FROM platform_alert_outbox
        GROUP BY state ORDER BY state`,
      )
    ).rows,
    incidents: (
      await pool.query(
        "SELECT id,component,symptom,severity,state,version,created_at,updated_at,resolved_at FROM platform_incidents ORDER BY (state='resolved'),updated_at DESC LIMIT 100",
      )
    ).rows,
  };
}
export async function open(
  actor: string,
  session: string | undefined,
  input: unknown,
) {
  const data = z
    .object({
      component: z.enum(["control-plane", "mail-plane", "backup", "payments"]),
      symptom: z.enum([
        "unavailable",
        "queue-delayed",
        "recovery-failed",
        "integrity-review",
      ]),
      severity: z.enum(["warning", "critical"]),
    })
    .strict()
    .parse(input);
  return transaction(async (db) => {
    await db.query(
      "SELECT user_id FROM platform_staff WHERE user_id=$1 FOR SHARE",
      [actor],
    );
    await requireStaff(actor, session, true, db);
    const row = (
      await db.query(
        "INSERT INTO platform_incidents(component,symptom,severity,created_by,updated_by) VALUES($1,$2,$3,$4,$4) ON CONFLICT(component,symptom) WHERE state<>'resolved' DO NOTHING RETURNING *",
        [data.component, data.symptom, data.severity, actor],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(
        409,
        "An active incident already covers this symptom",
      );
    await db.query(
      "INSERT INTO platform_events(actor_user_id,action,target_id,reason) VALUES($1,'incident.opened',$2,$3)",
      [actor, row.id, data.symptom],
    );
    await enqueueIncidentAlert(db, row, "opened");
    return row;
  });
}
export async function transition(
  actor: string,
  session: string | undefined,
  id: string,
  input: unknown,
) {
  z.uuid().parse(id);
  const data = z
    .object({
      version: z.number().int().positive(),
      action: z.enum(["acknowledge", "resolve"]),
    })
    .strict()
    .parse(input);
  return transaction(async (db) => {
    await db.query(
      "SELECT user_id FROM platform_staff WHERE user_id=$1 FOR SHARE",
      [actor],
    );
    await requireStaff(actor, session, true, db);
    const state = data.action === "acknowledge" ? "acknowledged" : "resolved";
    const row = (
      await db.query(
        `UPDATE platform_incidents SET state=$3,version=version+1,updated_by=$4,updated_at=NOW(),resolved_at=CASE WHEN $3='resolved' THEN NOW() ELSE NULL END WHERE id=$1 AND version=$2 AND (state='open' AND $3='acknowledged' OR state='acknowledged' AND $3='resolved') RETURNING *`,
        [id, data.version, state, actor],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(
        409,
        "Incident changed or transition is not allowed; reload first",
      );
    await db.query(
      "INSERT INTO platform_events(actor_user_id,action,target_id,reason) VALUES($1,$2,$3,$4)",
      [actor, `incident.${state}`, id, data.action],
    );
    await enqueueIncidentAlert(
      db,
      row,
      state === "acknowledged" ? "acknowledged" : "resolved",
    );
    return row;
  });
}
