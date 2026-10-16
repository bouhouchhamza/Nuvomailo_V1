import { randomUUID } from "node:crypto";
import pool from "../config/database.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { transaction } from "../repositories/transaction.js";
import { resolveTxt, type TxtResolver } from "./domain.service.js";
import {
  NotificationTransportError,
  type DomainNotificationTransport,
} from "./domain-notification.adapter.js";
import { queueFailedDomainCustody } from "../repositories/domain-custody.repository.js";

const bounds = (batch: number) => {
  if (!Number.isInteger(batch) || batch < 1 || batch > 100)
    throw new Error("Invalid revalidation batch size");
};

export async function scheduleDueRevalidations(batch = 50, org?: string) {
  bounds(batch);
  return transaction(async (db) =>
    Number(
      (
        await db.query(
          `WITH candidates AS (
          SELECT d.id FROM domains d JOIN organizations o ON o.id=d.organization_id
          WHERE d.status='active' AND o.status='active' AND d.verification_status='verified'
          AND d.revalidation_due_at<=NOW() AND ($2::uuid IS NULL OR d.organization_id=$2)
          AND NOT EXISTS(SELECT 1 FROM domain_revalidation_requests r WHERE r.domain_id=d.id AND r.state IN('pending','processing'))
          ORDER BY d.revalidation_due_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT $1
        ), claimed AS (
          UPDATE domains d SET revalidation_revision=d.revalidation_revision+1,
            revalidation_last_attempt_at=date_trunc('milliseconds',NOW())
          FROM candidates c WHERE d.id=c.id
          RETURNING d.id,d.organization_id,d.revalidation_revision
        ) INSERT INTO domain_revalidation_requests(domain_id,organization_id,revision)
          SELECT id,organization_id,revalidation_revision FROM claimed RETURNING id`,
          [batch, org ?? null],
        )
      ).rowCount ?? 0,
    ),
  );
}

type RevalidationOptions = {
  organizationId?: string;
  leaseMs?: number;
  timeoutMs?: number;
};

async function lookup(
  name: string,
  token: string,
  resolver: TxtResolver,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      resolver(`_nuvomailo-verification.${name}`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new NotificationTransportError("OPERATION_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
    return records.some(
      (chunks) => chunks.join("") === `nuvomailo-verification=${token}`,
    );
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENODATA" || code === "ENOTFOUND") return false;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runRevalidationOnce(
  resolver: TxtResolver = resolveTxt,
  options: RevalidationOptions = {},
) {
  const leaseMs = options.leaseMs ?? 30_000,
    timeoutMs = options.timeoutMs ?? 10_000;
  if (leaseMs < timeoutMs + 1000)
    throw new Error("Revalidation lease too short");
  const claimed = await transaction(async (db) => {
    const row = (
      await db.query(
        `SELECT r.*,d.name,d.verification_token,d.verification_status,d.revalidation_revision,
        d.revalidation_state,d.status AS domain_status,o.status AS organization_status
        FROM domain_revalidation_requests r JOIN domains d ON d.id=r.domain_id
        JOIN organizations o ON o.id=r.organization_id
        WHERE (r.state='pending' OR (r.state='processing' AND r.lease_expires_at<NOW()))
        AND r.available_at<=NOW() AND ($1::uuid IS NULL OR r.organization_id=$1)
        ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
        [options.organizationId ?? null],
      )
    ).rows[0];
    if (!row) return null;
    if (
      String(row.revision) !== String(row.revalidation_revision) ||
      row.verification_status !== "verified" ||
      row.domain_status !== "active" ||
      row.organization_status !== "active"
    ) {
      await db.query(
        "UPDATE domain_revalidation_requests SET state='superseded',finished_at=NOW(),lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
        [row.id],
      );
      return { superseded: true };
    }
    const lease = randomUUID();
    await db.query(
      `UPDATE domain_revalidation_requests SET state='processing',attempts=LEAST(attempts+1,max_attempts),
      lease_token=$2,lease_expires_at=NOW()+($3::integer*INTERVAL '1 millisecond') WHERE id=$1`,
      [row.id, lease, leaseMs],
    );
    return { ...row, lease, superseded: false };
  });
  if (!claimed) return "idle" as const;
  if (claimed.superseded) return "superseded" as const;
  try {
    const verified = await lookup(
      claimed.name,
      claimed.verification_token,
      resolver,
      timeoutMs,
    );
    return transaction(async (db) => {
      const request = (
        await db.query(
          `SELECT * FROM domain_revalidation_requests WHERE id=$1 AND state='processing'
          AND lease_token=$2 AND lease_expires_at>NOW() FOR UPDATE`,
          [claimed.id, claimed.lease],
        )
      ).rows[0];
      if (!request) return "stale" as const;
      const domain = (
        await db.query(
          "SELECT * FROM domains WHERE id=$1 AND organization_id=$2 FOR UPDATE",
          [claimed.domain_id, claimed.organization_id],
        )
      ).rows[0];
      if (
        !domain ||
        domain.verification_status !== "verified" ||
        String(domain.revalidation_revision) !== String(claimed.revision) ||
        domain.verification_token !== claimed.verification_token
      ) {
        await db.query(
          "UPDATE domain_revalidation_requests SET state='superseded',finished_at=NOW(),lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
          [claimed.id],
        );
        return "superseded" as const;
      }
      const result = (
        await db.query(
          `UPDATE domains SET
          revalidation_state=CASE WHEN $3 THEN 'current' WHEN revalidation_grace_expires_at IS NOT NULL AND revalidation_grace_expires_at<=NOW() THEN 'failed' ELSE 'warning' END,
          ownership_revalidated_at=CASE WHEN $3 THEN NOW() ELSE ownership_revalidated_at END,
          revalidation_due_at=CASE WHEN $3 THEN NOW()+INTERVAL '30 days' ELSE NOW()+INTERVAL '1 day' END,
          revalidation_failures=CASE WHEN $3 THEN 0 ELSE revalidation_failures+1 END,
          revalidation_grace_expires_at=CASE WHEN $3 THEN NULL ELSE COALESCE(revalidation_grace_expires_at,NOW()+INTERVAL '30 days') END,
          verification_status=CASE WHEN NOT $3 AND revalidation_grace_expires_at IS NOT NULL AND revalidation_grace_expires_at<=NOW() THEN 'failed' ELSE verification_status END,
          mail_activation=CASE WHEN NOT $3 AND revalidation_grace_expires_at IS NOT NULL AND revalidation_grace_expires_at<=NOW() THEN 'disabled' ELSE mail_activation END
          WHERE id=$1 AND revalidation_revision=$2 RETURNING *`,
          [claimed.domain_id, claimed.revision, verified],
        )
      ).rows[0];
      if (!result) return "superseded" as const;
      const kind = verified
        ? claimed.revalidation_state === "warning"
          ? "recovered"
          : null
        : result.revalidation_state === "failed"
          ? "failed"
          : claimed.revalidation_state !== "warning"
            ? "warning"
            : null;
      if (result.revalidation_state === "failed")
        await queueFailedDomainCustody(db, claimed.domain_id);
      if (kind)
        await db.query(
          `INSERT INTO domain_notification_outbox
          (domain_id,organization_id,revalidation_revision,recipient_user_id,kind)
          SELECT $1,$2,$3,u.id,$4 FROM memberships m JOIN users u ON u.id=m.user_id
          WHERE m.organization_id=$2 AND m.role='owner' AND u.status='active' AND u.email_verified_at IS NOT NULL
          ON CONFLICT(domain_id,revalidation_revision,recipient_user_id,kind) DO NOTHING`,
          [claimed.domain_id, claimed.organization_id, claimed.revision, kind],
        );
      await db.query(
        `UPDATE domain_revalidation_requests SET state='completed',result_state=$3,finished_at=NOW(),
        lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL WHERE id=$1 AND lease_token=$2`,
        [claimed.id, claimed.lease, result.revalidation_state],
      );
      await appendAudit(db, {
        organizationId: claimed.organization_id,
        actorId: null,
        action:
          result.revalidation_state === "current"
            ? "domain.revalidated"
            : result.revalidation_state === "failed"
              ? "domain.revalidation_failed"
              : "domain.revalidation_warning",
        resourceId: claimed.domain_id,
        metadata: {
          scheduled: true,
          revision: Number(claimed.revision),
          requestId: claimed.id,
        },
      });
      return result.revalidation_state as "current" | "warning" | "failed";
    });
  } catch (error) {
    const code =
      error instanceof NotificationTransportError
        ? error.code
        : "DNS_LOOKUP_UNAVAILABLE";
    return transaction(async (db) => {
      const result = (
        await db.query(
          `UPDATE domain_revalidation_requests SET
          state=CASE WHEN attempts<max_attempts THEN 'pending' ELSE 'failed' END,
          available_at=NOW()+INTERVAL '30 seconds',last_error_code=$3,
          lease_token=NULL,lease_expires_at=NULL,
          finished_at=CASE WHEN attempts>=max_attempts THEN NOW() ELSE NULL END
          WHERE id=$1 AND lease_token=$2 AND lease_expires_at>NOW() RETURNING state,domain_id,revision`,
          [claimed.id, claimed.lease, code],
        )
      ).rows[0];
      if (!result) return "stale" as const;
      if (result.state === "failed")
        await db.query(
          "UPDATE domains SET revalidation_due_at=NOW()+INTERVAL '1 hour' WHERE id=$1 AND revalidation_revision=$2",
          [result.domain_id, result.revision],
        );
      return result.state === "pending"
        ? ("retry" as const)
        : ("failed" as const);
    });
  }
}

type NotificationOptions = {
  allowSynthetic?: boolean;
  leaseMs?: number;
  timeoutMs?: number;
};

export async function runDomainNotificationOnce(
  transport: DomainNotificationTransport,
  options: NotificationOptions = {},
) {
  if (transport.mode === "local-synthetic" && !options.allowSynthetic)
    throw new Error(
      "Synthetic notification transport requires explicit opt-in",
    );
  const leaseMs = options.leaseMs ?? 30_000,
    timeoutMs = options.timeoutMs ?? 10_000;
  if (leaseMs < timeoutMs + 1000)
    throw new Error("Notification lease too short");
  const claimed = await transaction(async (db) => {
    const row = (
      await db.query(
        `SELECT n.*,d.name,d.revalidation_state AS current_revalidation_state,
        u.email,u.status AS user_status,u.email_verified_at,
        EXISTS(SELECT 1 FROM memberships m WHERE m.organization_id=n.organization_id
          AND m.user_id=n.recipient_user_id AND m.role='owner') AS current_owner
        FROM domain_notification_outbox n JOIN domains d ON d.id=n.domain_id
        JOIN users u ON u.id=n.recipient_user_id
        WHERE (n.state='pending' OR (n.state='processing' AND n.lease_expires_at<NOW()))
        AND n.available_at<=NOW() ORDER BY n.created_at,n.id LIMIT 1 FOR UPDATE OF n SKIP LOCKED`,
      )
    ).rows[0];
    if (!row) return null;
    const recipientEligible =
        row.user_status === "active" &&
        !!row.email_verified_at &&
        row.current_owner,
      eventCurrent =
        row.current_revalidation_state ===
        (row.kind === "recovered" ? "current" : row.kind);
    if (!recipientEligible || !eventCurrent) {
      await db.query(
        `UPDATE domain_notification_outbox SET state='canceled',finished_at=NOW(),
        last_error_code=$2,lease_token=NULL,lease_expires_at=NULL WHERE id=$1`,
        [
          row.id,
          recipientEligible ? "EVENT_SUPERSEDED" : "RECIPIENT_INELIGIBLE",
        ],
      );
      return { canceled: true };
    }
    const lease = randomUUID();
    await db.query(
      `UPDATE domain_notification_outbox SET state='processing',attempts=LEAST(attempts+1,max_attempts),
      lease_token=$2,lease_expires_at=NOW()+($3::integer*INTERVAL '1 millisecond') WHERE id=$1`,
      [row.id, lease, leaseMs],
    );
    return { ...row, lease, canceled: false };
  });
  if (!claimed) return "idle" as const;
  if (claimed.canceled) return "canceled" as const;
  try {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await Promise.race([
        transport.deliver(
          {
            idempotencyKey: claimed.id,
            outboxId: claimed.id,
            recipientUserId: claimed.recipient_user_id,
            recipientAddress: claimed.email,
            domainName: claimed.name,
            kind: claimed.kind,
          },
          controller.signal,
        ),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new NotificationTransportError("OPERATION_TIMEOUT")),
            { once: true },
          ),
        ),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const ack = await pool.query(
      `UPDATE domain_notification_outbox SET state='delivered',finished_at=NOW(),lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL
      WHERE id=$1 AND lease_token=$2 AND lease_expires_at>NOW() RETURNING id`,
      [claimed.id, claimed.lease],
    );
    return ack.rowCount ? ("delivered" as const) : ("stale" as const);
  } catch (error) {
    const code =
      error instanceof NotificationTransportError
        ? error.code
        : "TRANSPORT_UNAVAILABLE";
    const result = (
      await pool.query(
        `UPDATE domain_notification_outbox SET state=CASE WHEN attempts<max_attempts THEN 'pending' ELSE 'failed' END,
        available_at=NOW()+INTERVAL '30 seconds',last_error_code=$3,lease_token=NULL,lease_expires_at=NULL,
        finished_at=CASE WHEN attempts>=max_attempts THEN NOW() ELSE NULL END
        WHERE id=$1 AND lease_token=$2 AND lease_expires_at>NOW() RETURNING state`,
        [claimed.id, claimed.lease, code],
      )
    ).rows[0];
    return !result
      ? ("stale" as const)
      : result.state === "pending"
        ? ("retry" as const)
        : ("failed" as const);
  }
}
