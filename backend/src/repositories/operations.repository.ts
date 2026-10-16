import pool from "../config/database.js";
import type { PoolClient } from "pg";
import { enqueue } from "./mailbox.repository.js";
import type { Mailbox } from "../models/mailbox.model.js";
import { transaction } from "./transaction.js";
import { appendAudit } from "./audit.repository.js";
export async function audit(orgId: string, limit: number, before?: string) {
  return (
    await pool.query(
      `SELECT id,actor_user_id,action,resource_id,metadata,created_at FROM audit_events
    WHERE organization_id=$1 AND ($3::bigint IS NULL OR id<$3) ORDER BY id DESC LIMIT $2`,
      [orgId, limit, before ?? null],
    )
  ).rows;
}
export async function retry(client: PoolClient, orgId: string, id: string) {
  const job = (
    await client.query<{ mailbox_id: string }>(
      `SELECT p.mailbox_id FROM provisioning_requests p
    JOIN mailboxes m ON m.id=p.mailbox_id JOIN domains d ON d.id=m.domain_id WHERE d.organization_id=$1 AND p.id=$2`,
      [orgId, id],
    )
  ).rows[0];
  if (!job) return null;
  await client.query("SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE", [
    job.mailbox_id,
  ]);
  const updated = (
    await client.query(
      `UPDATE provisioning_requests SET state='pending',attempts=0,available_at=NOW(),last_error_code=NULL,finished_at=NULL
    WHERE id=$1 AND state='failed' RETURNING id,mailbox_id`,
      [id],
    )
  ).rows[0];
  if (!updated) return false;
  await client.query(
    "UPDATE mailboxes SET provisioning_status='pending_provisioning',last_provisioning_error=NULL WHERE id=$1",
    [job.mailbox_id],
  );
  return updated as { id: string; mailbox_id: string };
}
export async function reconcile(client: PoolClient, orgId: string, id: string) {
  const box = (
    await client.query<Mailbox>(
      `SELECT m.* FROM mailboxes m JOIN domains d ON d.id=m.domain_id
    WHERE d.organization_id=$1 AND m.id=$2 AND d.verification_status='verified' FOR UPDATE OF m`,
      [orgId, id],
    )
  ).rows[0];
  if (!box) return null;
  if (
    (
      await client.query(
        "SELECT id FROM provisioning_requests WHERE mailbox_id=$1 AND state<>'completed' LIMIT 1",
        [id],
      )
    ).rows.length
  )
    return false;
  const updated = (
    await client.query<Mailbox>(
      `UPDATE mailboxes SET desired_revision=desired_revision+1,provisioning_status='pending_provisioning',
    last_provisioning_error=NULL,updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id],
    )
  ).rows[0]!;
  return enqueue(client, updated, "reconcile");
}
export async function scheduleReconciliations(
  staleAfterMs: number,
  limit = 50,
  orgId?: string,
) {
  return transaction(async (client) => {
    const boxes = (
      await client.query<Mailbox & { organization_id: string }>(
        `SELECT m.*,d.organization_id FROM mailboxes m JOIN domains d ON d.id=m.domain_id
      WHERE d.verification_status='verified' AND ($3::uuid IS NULL OR d.organization_id=$3)
        AND m.applied_revision=m.desired_revision AND m.applied_revision>0
        AND m.observed_at<NOW()-($1::integer*INTERVAL '1 millisecond')
        AND NOT EXISTS(SELECT 1 FROM provisioning_requests p WHERE p.mailbox_id=m.id AND p.state<>'completed')
      ORDER BY m.observed_at,m.id LIMIT $2 FOR UPDATE OF m SKIP LOCKED`,
        [staleAfterMs, limit, orgId ?? null],
      )
    ).rows;
    for (const box of boxes) {
      const updated = (
        await client.query<Mailbox>(
          "UPDATE mailboxes SET desired_revision=desired_revision+1,provisioning_status='pending_provisioning',updated_at=NOW() WHERE id=$1 RETURNING *",
          [box.id],
        )
      ).rows[0]!;
      const job = await enqueue(client, updated, "reconcile");
      await appendAudit(client, {
        organizationId: box.organization_id,
        actorId: null,
        action: "mailbox.reconciliation_scheduled",
        resourceId: box.id,
        metadata: { requestId: job.id, revision: job.revision },
      });
    }
    return boxes.length;
  });
}
