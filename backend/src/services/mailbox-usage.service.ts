import { randomUUID } from "node:crypto";
import { z } from "zod";
import pool from "../config/database.js";
import { transaction } from "../repositories/transaction.js";
import { requireTenant, tenantWrite } from "./tenant-context.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { HttpError } from "../middlewares/errors.js";
import {
  UsageProviderError,
  type MailboxUsageReader,
} from "./mailbox-usage.adapter.js";

type UsageRow = {
  observed_usage_bytes?: string | number | null;
  observed_message_count?: string | number | null;
  usage_observed_at?: Date | string | null;
  usage_last_error_code?: string | null;
};
export function usagePresentation(row: UsageRow) {
  const observedAt = row.usage_observed_at
    ? new Date(row.usage_observed_at)
    : null;
  return {
    usageState: !observedAt
      ? ("unknown" as const)
      : Date.now() - observedAt.getTime() <= 15 * 60_000
        ? ("fresh" as const)
        : ("stale" as const),
    usageBytes:
      row.observed_usage_bytes == null
        ? null
        : Number(row.observed_usage_bytes),
    messageCount:
      row.observed_message_count == null
        ? null
        : Number(row.observed_message_count),
    usageObservedAt: observedAt?.toISOString() ?? null,
    usageLastErrorCode: row.usage_last_error_code ?? null,
  };
}
export async function status(actor: string, org: string, id: string) {
  z.uuid().parse(id);
  await requireTenant(actor, org, "read");
  const row = (
    await pool.query(
      "SELECT observed_usage_bytes,observed_message_count,usage_observed_at,usage_last_error_code FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE m.id=$1 AND d.organization_id=$2",
      [id, org],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "Mailbox not found");
  return usagePresentation(row);
}
export async function requestRefresh(actor: string, org: string, id: string) {
  z.uuid().parse(id);
  return tenantWrite(actor, org, "manage", async (db) => {
    const mailbox = (
      await db.query(
        "SELECT m.id,d.mail_activation,d.status,d.verification_status FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE m.id=$1 AND d.organization_id=$2 FOR UPDATE OF m",
        [id, org],
      )
    ).rows[0];
    if (!mailbox) throw new HttpError(404, "Mailbox not found");
    if (
      mailbox.status !== "active" ||
      mailbox.verification_status !== "verified" ||
      mailbox.mail_activation === "disabled"
    )
      throw new HttpError(409, "Mailbox usage provider is not enabled");
    const inserted = (
      await db.query(
        `INSERT INTO mailbox_usage_requests(mailbox_id,requested_by) VALUES($1,$2)
      ON CONFLICT(mailbox_id) WHERE state IN('pending','processing') DO NOTHING RETURNING id,state`,
        [id, actor],
      )
    ).rows[0];
    const row =
      inserted ??
      (
        await db.query(
          "SELECT id,state FROM mailbox_usage_requests WHERE mailbox_id=$1 AND state IN('pending','processing')",
          [id],
        )
      ).rows[0];
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action: "mailbox.usage_refresh_requested",
      resourceId: id,
      metadata: { requestId: row.id, deduplicated: !inserted },
    });
    return { ...row, deduplicated: !inserted };
  });
}
export async function scheduleUsage(
  maxAgeMs: number,
  batch = 50,
  org?: string,
) {
  if (
    !Number.isInteger(maxAgeMs) ||
    maxAgeMs < 0 ||
    !Number.isInteger(batch) ||
    batch < 1 ||
    batch > 100
  )
    throw new Error("Invalid usage schedule bounds");
  return transaction(async (db) =>
    Number(
      (
        await db.query(
          `WITH candidates AS (
    SELECT m.id FROM mailboxes m JOIN domains d ON d.id=m.domain_id JOIN organizations o ON o.id=d.organization_id
    WHERE o.status='active' AND d.status='active' AND d.verification_status='verified' AND d.mail_activation='local-lab'
    AND ($3::uuid IS NULL OR d.organization_id=$3) AND (m.usage_observed_at IS NULL OR m.usage_observed_at<NOW()-($1::integer*INTERVAL '1 millisecond'))
    AND NOT EXISTS(SELECT 1 FROM mailbox_usage_requests r WHERE r.mailbox_id=m.id AND r.state IN('pending','processing'))
    ORDER BY m.usage_observed_at NULLS FIRST,m.created_at FOR UPDATE OF m SKIP LOCKED LIMIT $2)
    INSERT INTO mailbox_usage_requests(mailbox_id) SELECT id FROM candidates RETURNING id`,
          [maxAgeMs, batch, org ?? null],
        )
      ).rowCount ?? 0,
    ),
  );
}
export async function refreshUsageRollups(batch = 50, organizationId?: string) {
  if (!Number.isInteger(batch) || batch < 1 || batch > 100)
    throw new Error("Invalid rollup batch size");
  return transaction(async (db) =>
    Number(
      (
        await db.query(
          `WITH eligible AS (
          SELECT o.id FROM organizations o WHERE o.status='active'
          AND ($2::uuid IS NULL OR o.id=$2)
          AND EXISTS(SELECT 1 FROM domains d JOIN mailboxes m ON m.domain_id=d.id WHERE d.organization_id=o.id)
          ORDER BY o.id LIMIT $1), candidates AS (
          SELECT id FROM eligible
          WHERE pg_try_advisory_xact_lock(hashtextextended(id::text,4759))), aggregates AS (
          SELECT c.id AS organization_id,count(m.id)::integer AS mailbox_count,
          count(m.id) FILTER(WHERE m.usage_observed_at>=NOW()-INTERVAL '15 minutes')::integer AS fresh_count,
          count(m.id) FILTER(WHERE m.usage_observed_at IS NOT NULL AND m.usage_observed_at<NOW()-INTERVAL '15 minutes')::integer AS stale_count,
          count(m.id) FILTER(WHERE m.usage_observed_at IS NULL)::integer AS unknown_count,
          COALESCE(sum(m.observed_usage_bytes),0)::bigint AS usage_bytes,
          COALESCE(sum(m.observed_message_count),0)::bigint AS message_count,
          COALESCE(sum(m.quota_mb::bigint*1048576),0)::bigint AS quota_bytes
          FROM candidates c JOIN domains d ON d.organization_id=c.id JOIN mailboxes m ON m.domain_id=d.id
          GROUP BY c.id)
          INSERT INTO organization_usage_rollups(organization_id,mailbox_count,fresh_mailbox_count,
          stale_mailbox_count,unknown_mailbox_count,observed_usage_bytes,observed_message_count,
          allocated_quota_bytes,coverage_complete)
          SELECT organization_id,mailbox_count,fresh_count,stale_count,unknown_count,usage_bytes,
          message_count,quota_bytes,(mailbox_count>0 AND stale_count=0 AND unknown_count=0)
          FROM aggregates ON CONFLICT(organization_id) DO UPDATE SET
          mailbox_count=EXCLUDED.mailbox_count,fresh_mailbox_count=EXCLUDED.fresh_mailbox_count,
          stale_mailbox_count=EXCLUDED.stale_mailbox_count,unknown_mailbox_count=EXCLUDED.unknown_mailbox_count,
          observed_usage_bytes=EXCLUDED.observed_usage_bytes,observed_message_count=EXCLUDED.observed_message_count,
          allocated_quota_bytes=EXCLUDED.allocated_quota_bytes,coverage_complete=EXCLUDED.coverage_complete,
          computed_at=NOW() RETURNING organization_id`,
          [batch, organizationId ?? null],
        )
      ).rowCount ?? 0,
    ),
  );
}

export async function organizationUsage(actor: string, organizationId: string) {
  await requireTenant(actor, organizationId, "read");
  const row = (
    await pool.query(
      `SELECT mailbox_count AS "mailboxCount",fresh_mailbox_count AS "freshMailboxCount",
      stale_mailbox_count AS "staleMailboxCount",unknown_mailbox_count AS "unknownMailboxCount",
      observed_usage_bytes AS "observedUsageBytes",observed_message_count AS "observedMessageCount",
      allocated_quota_bytes AS "allocatedQuotaBytes",coverage_complete AS "coverageComplete",
      computed_at AS "computedAt" FROM organization_usage_rollups WHERE organization_id=$1`,
      [organizationId],
    )
  ).rows[0];
  if (!row)
    return {
      rollupState: "unknown" as const,
      coverageComplete: false,
      billingEligible: false,
    };
  const fresh = Date.now() - new Date(row.computedAt).getTime() <= 15 * 60_000;
  return {
    ...row,
    rollupState: fresh ? ("fresh" as const) : ("stale" as const),
    billingEligible: false,
    billingReason:
      row.coverageComplete && fresh
        ? "pricing-not-approved"
        : "incomplete-observations",
  };
}
type UsageOptions = {
  allowLab?: boolean;
  leaseMs?: number;
  timeoutMs?: number;
  organizationId?: string;
};
export async function runUsageOnce(
  reader: MailboxUsageReader,
  options: UsageOptions = {},
) {
  if (reader.mode === "local-lab" && !options.allowLab)
    throw new Error("Local lab usage reader requires explicit opt-in");
  const leaseMs = options.leaseMs ?? 60_000,
    timeoutMs = options.timeoutMs ?? 15_000;
  if (leaseMs < timeoutMs + 1000) throw new Error("Usage lease too short");
  const job = await transaction(async (db) => {
    const row = (
      await db.query(
        `SELECT r.*,d.organization_id,m.local_part||'@'||d.name AS address FROM mailbox_usage_requests r
      JOIN mailboxes m ON m.id=r.mailbox_id JOIN domains d ON d.id=m.domain_id JOIN organizations o ON o.id=d.organization_id
      WHERE (r.state='pending' OR (r.state='processing' AND r.lease_expires_at<NOW())) AND r.available_at<=NOW()
      AND o.status='active' AND d.status='active' AND d.verification_status='verified' AND d.mail_activation='local-lab'
      AND ($1::uuid IS NULL OR d.organization_id=$1) ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
        [options.organizationId ?? null],
      )
    ).rows[0];
    if (!row) return null;
    const lease = randomUUID();
    await db.query(
      "UPDATE mailbox_usage_requests SET state='processing',attempts=LEAST(attempts+1,max_attempts),lease_token=$2,lease_expires_at=NOW()+($3::integer*INTERVAL '1 millisecond') WHERE id=$1",
      [row.id, lease, leaseMs],
    );
    return { ...row, lease };
  });
  if (!job) return "idle" as const;
  try {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), timeoutMs);
    let observation;
    try {
      observation = await Promise.race([
        reader.read(
          {
            organizationId: job.organization_id,
            mailboxId: job.mailbox_id,
            address: job.address,
          },
          controller.signal,
        ),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new UsageProviderError("OPERATION_TIMEOUT", true)),
            { once: true },
          ),
        ),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (
      !Number.isSafeInteger(observation.usageBytes) ||
      observation.usageBytes < 0 ||
      !Number.isSafeInteger(observation.messageCount) ||
      observation.messageCount < 0
    )
      throw new UsageProviderError("PROVIDER_REJECTED", false);
    const updated = await transaction(async (db) => {
      await db.query("SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE", [
        job.mailbox_id,
      ]);
      const ack = await db.query(
        `UPDATE mailbox_usage_requests SET state='completed',lease_token=NULL,lease_expires_at=NULL,finished_at=NOW(),last_error_code=NULL
        WHERE id=$1 AND lease_token=$2 AND lease_expires_at>NOW() RETURNING id`,
        [job.id, job.lease],
      );
      if (!ack.rowCount) return false;
      await db.query(
        "UPDATE mailboxes SET observed_usage_bytes=$2,observed_message_count=$3,usage_observed_at=NOW(),usage_last_error_code=NULL WHERE id=$1",
        [job.mailbox_id, observation.usageBytes, observation.messageCount],
      );
      await appendAudit(db, {
        organizationId: job.organization_id,
        actorId: null,
        action: "mailbox.usage_observed",
        resourceId: job.mailbox_id,
        metadata: {
          requestId: job.id,
          usageBytes: observation.usageBytes,
          messageCount: observation.messageCount,
        },
      });
      return true;
    });
    return updated ? ("completed" as const) : ("stale" as const);
  } catch (error) {
    const code =
        error instanceof UsageProviderError
          ? error.code
          : "PROVIDER_UNAVAILABLE",
      retryable = error instanceof UsageProviderError ? error.retryable : true;
    const updated = await transaction(async (db) => {
      const row = (
        await db.query(
          `UPDATE mailbox_usage_requests SET state=CASE WHEN $3 AND attempts<max_attempts THEN 'pending' ELSE 'failed' END,
        available_at=NOW()+INTERVAL '30 seconds',lease_token=NULL,lease_expires_at=NULL,last_error_code=$4,
        finished_at=CASE WHEN NOT $3 OR attempts>=max_attempts THEN NOW() ELSE NULL END
        WHERE id=$1 AND lease_token=$2 AND lease_expires_at>NOW() RETURNING mailbox_id,state`,
          [job.id, job.lease, retryable, code],
        )
      ).rows[0];
      if (!row) return false;
      await db.query(
        "UPDATE mailboxes SET usage_last_error_code=$2 WHERE id=$1",
        [row.mailbox_id, code],
      );
      return row.state as "pending" | "failed";
    });
    return updated === "pending"
      ? ("retry" as const)
      : updated === "failed"
        ? ("failed" as const)
        : ("stale" as const);
  }
}
