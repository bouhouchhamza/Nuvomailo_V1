import pool from "../config/database.js";
import { randomUUID } from "node:crypto";
import { transaction } from "./transaction.js";
import { appendAudit } from "./audit.repository.js";
import type {
  ProvisioningRequest,
  MailboxTarget,
  MailboxObservation,
} from "../services/provisioning.adapter.js";
export interface ClaimedJob extends ProvisioningRequest {
  organization_id: string;
  address: string;
  attempts: number;
  max_attempts: number;
  lease_token: string;
  domain_verified: boolean;
  domain_enabled: boolean;
  exhausted: boolean;
}
export async function claim(
  leaseMs: number,
  orgId?: string,
): Promise<ClaimedJob | undefined> {
  return transaction(async (client) => {
    // Mailbox is the serialization key. Lock order is mailbox then job throughout the queue.
    const box = (
      await client.query<{
        id: string;
        organization_id: string;
        address: string;
        domain_verified: boolean;
        domain_enabled: boolean;
      }>(
        `
      SELECT m.id,d.organization_id,m.local_part||'@'||d.name AS address,d.verification_status='verified' AS domain_verified,d.mail_activation='local-lab' AS domain_enabled
      FROM mailboxes m JOIN domains d ON d.id=m.domain_id JOIN organizations o ON o.id=d.organization_id
      WHERE o.status='active' AND d.status='active' AND ($1::uuid IS NULL OR d.organization_id=$1) AND EXISTS (
        SELECT 1 FROM provisioning_requests p WHERE p.mailbox_id=m.id
        AND ((p.state='pending' AND p.available_at<=NOW()) OR (p.state='processing' AND p.lease_expires_at<=NOW()))
        AND NOT EXISTS (SELECT 1 FROM provisioning_requests earlier WHERE earlier.mailbox_id=p.mailbox_id AND earlier.revision<p.revision AND earlier.state<>'completed')
      ) ORDER BY m.created_at,m.id LIMIT 1 FOR UPDATE OF m SKIP LOCKED`,
        [orgId ?? null],
      )
    ).rows[0];
    if (!box) return;
    const previous = (
      await client.query<
        ProvisioningRequest & {
          attempts: number;
          max_attempts: number;
          state: string;
        }
      >(
        `
      SELECT * FROM provisioning_requests WHERE mailbox_id=$1
      AND id=(SELECT id FROM provisioning_requests WHERE mailbox_id=$1 AND state<>'completed' ORDER BY revision LIMIT 1)
      AND ((state='pending' AND available_at<=NOW()) OR (state='processing' AND lease_expires_at<=NOW())) FOR UPDATE`,
        [box.id],
      )
    ).rows[0];
    // The mailbox candidate query may have started before another claimant committed.
    // Recheck head eligibility in this fresh statement after acquiring its mailbox lock.
    if (!previous) return;
    const token = randomUUID();
    const job = (
      await client.query<ClaimedJob>(
        `UPDATE provisioning_requests SET state='processing',lease_token=$2,
      lease_expires_at=NOW()+($3::integer * INTERVAL '1 millisecond'),attempts=LEAST(attempts+1,max_attempts),finished_at=NULL
      WHERE id=$1 RETURNING *`,
        [previous.id, token, leaseMs],
      )
    ).rows[0]!;
    const exhausted = previous.attempts >= previous.max_attempts;
    await appendAudit(client, {
      organizationId: box.organization_id,
      actorId: null,
      action:
        previous.state === "processing"
          ? "provisioning.lease_recovered"
          : "provisioning.claimed",
      resourceId: box.id,
      metadata: {
        requestId: job.id,
        revision: job.revision,
        attempt: job.attempts,
      },
    });
    return { ...job, ...box, id: job.id, exhausted };
  });
}
export function target(job: ClaimedJob): MailboxTarget {
  return {
    organizationId: job.organization_id,
    mailboxId: job.mailbox_id,
    address: job.address,
    revision: job.revision,
    quotaMb: job.quota_mb,
    status: job.desired_status,
    inboundPolicy: job.inbound_policy,
    idempotencyKey: job.id,
  };
}
type Outcome =
  | { kind: "completed"; observation: MailboxObservation }
  | { kind: "deferred"; delayMs: number }
  | { kind: "failed"; code: string; retryable: boolean; delayMs: number };
export async function finish(
  job: ClaimedJob,
  outcome: Outcome,
): Promise<boolean> {
  return transaction(async (client) => {
    // Fence stale completions and serialize with API intent changes/other workers.
    await client.query("SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE", [
      job.mailbox_id,
    ]);
    const active = (
      await client.query(
        "SELECT id FROM provisioning_requests WHERE id=$1 AND state='processing' AND lease_token=$2 AND lease_expires_at>NOW() FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rows[0];
    if (!active) return false;
    const retry =
      outcome.kind === "failed" &&
      outcome.retryable &&
      job.attempts < job.max_attempts;
    const state =
      outcome.kind === "completed"
        ? "completed"
        : outcome.kind === "deferred" || retry
          ? "pending"
          : "failed";
    const code =
      outcome.kind === "failed"
        ? outcome.code
        : outcome.kind === "deferred"
          ? "INTEGRATION_PENDING"
          : null;
    const delay = outcome.kind === "completed" ? 0 : outcome.delayMs;
    await client.query(
      `UPDATE provisioning_requests SET state=$3,lease_token=NULL,lease_expires_at=NULL,
      available_at=NOW()+($4::integer * INTERVAL '1 millisecond'),last_error_code=$5,
      attempts=CASE WHEN $6 THEN GREATEST(attempts-1,0) ELSE attempts END,
      finished_at=CASE WHEN $3 IN ('completed','failed') THEN NOW() ELSE NULL END WHERE id=$1 AND lease_token=$2`,
      [
        job.id,
        job.lease_token,
        state,
        delay,
        code,
        outcome.kind === "deferred",
      ],
    );
    if (outcome.kind === "completed") {
      await client.query(
        `UPDATE mailboxes SET observed_status=$2,observed_quota_mb=$3,observed_inbound_policy=$5,observed_at=NOW(),
        applied_revision=GREATEST(applied_revision,$4),last_provisioning_error=NULL,
        provisioning_status=CASE WHEN desired_revision=$4 THEN $2 ELSE 'pending_provisioning' END,updated_at=NOW() WHERE id=$1`,
        [
          job.mailbox_id,
          outcome.observation.status,
          outcome.observation.quotaMb,
          job.revision,
          outcome.observation.inboundPolicy,
        ],
      );
    } else {
      await client.query(
        `UPDATE mailboxes SET provisioning_status=CASE WHEN $2='failed' THEN 'failed' ELSE 'pending_provisioning' END,
        last_provisioning_error=$3,updated_at=NOW() WHERE id=$1`,
        [job.mailbox_id, state, code],
      );
    }
    await appendAudit(client, {
      organizationId: job.organization_id,
      actorId: null,
      action:
        outcome.kind === "completed"
          ? "provisioning.completed"
          : outcome.kind === "deferred"
            ? "provisioning.deferred"
            : retry
              ? "provisioning.retry_scheduled"
              : "provisioning.dead_lettered",
      resourceId: job.mailbox_id,
      metadata: {
        requestId: job.id,
        revision: job.revision,
        attempt: job.attempts,
        errorCode: code,
      },
    });
    return true;
  });
}
export async function list(orgId: string, limit: number, before?: string) {
  return (
    await pool.query(
      `SELECT p.id,p.mailbox_id,p.operation,p.revision,p.desired_status,p.quota_mb,p.state,p.attempts,p.max_attempts,
    p.available_at,p.last_error_code,p.lease_expires_at,p.created_at,p.finished_at,m.local_part||'@'||d.name AS address
    FROM provisioning_requests p JOIN mailboxes m ON m.id=p.mailbox_id JOIN domains d ON d.id=m.domain_id
    WHERE d.organization_id=$1 AND ($3::uuid IS NULL OR (p.created_at,p.id)<(
      SELECT cursor.created_at,cursor.id FROM provisioning_requests cursor JOIN mailboxes cm ON cm.id=cursor.mailbox_id
      JOIN domains cd ON cd.id=cm.domain_id WHERE cursor.id=$3 AND cd.organization_id=$1
    )) ORDER BY p.created_at DESC,p.id DESC LIMIT $2`,
      [orgId, limit, before ?? null],
    )
  ).rows;
}
