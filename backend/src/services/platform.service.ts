import { z } from "zod";
import pool from "../config/database.js";
import { transaction, type Db } from "../repositories/transaction.js";
import { HttpError } from "../middlewares/errors.js";
import { retry } from "../repositories/operations.repository.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { heartbeatStatus } from "./operations-alert.service.js";
export async function requireStaff(
  actor: string,
  sessionId: string | undefined,
  write = false,
  db: Db = pool,
) {
  if (!sessionId)
    throw new HttpError(403, "Staff session with recent MFA required");
  const staff = (
    await db.query(
      `SELECT p.role FROM platform_staff p JOIN users u ON u.id=p.user_id
    JOIN identity_sessions s ON s.user_id=u.id WHERE p.user_id=$1 AND s.id=$2
    AND u.status='active' AND u.email_verified_at IS NOT NULL AND u.mfa_secret_enc IS NOT NULL
    AND s.revoked_at IS NULL AND s.expires_at>NOW() AND s.mfa_verified_at>NOW()-INTERVAL '15 minutes'`,
      [actor, sessionId],
    )
  ).rows[0];
  if (!staff || (write && staff.role !== "operator"))
    throw new HttpError(403, "Staff session with recent MFA required");
  return staff.role as "viewer" | "operator";
}
export async function directory(
  actor: string,
  sessionId: string | undefined,
  input: unknown,
) {
  await requireStaff(actor, sessionId);
  const { limit, before, search } = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      before: z.uuid().optional(),
      search: z.string().max(100).default(""),
    })
    .strict()
    .parse(input);
  return (
    await pool.query(
      `SELECT o.id,o.name,o.slug,o.status,o.created_at,
    (SELECT count(*)::int FROM domains d WHERE d.organization_id=o.id) AS domains,
    (SELECT count(*)::int FROM domains d JOIN mailboxes m ON m.domain_id=d.id WHERE d.organization_id=o.id) AS mailboxes
    FROM organizations o WHERE ($1::uuid IS NULL OR o.id<$1) AND (o.name ILIKE '%'||$2||'%' OR o.slug ILIKE '%'||$2||'%') ORDER BY o.id DESC LIMIT $3`,
      [before ?? null, search, limit],
    )
  ).rows;
}
export async function detail(
  actor: string,
  sessionId: string | undefined,
  id: string,
) {
  await requireStaff(actor, sessionId);
  z.uuid().parse(id);
  const org = (
    await pool.query(
      "SELECT id,name,slug,status,created_at,deleted_at FROM organizations WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!org) throw new HttpError(404, "Organization not found");
  const domains = (
    await pool.query(
      "SELECT id,name,verification_status FROM domains WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
      [id],
    )
  ).rows;
  const mailboxes = (
    await pool.query(
      "SELECT m.id,m.local_part,d.name AS domain,m.quota_mb,m.desired_status,m.observed_status,m.provisioning_status FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE d.organization_id=$1 ORDER BY m.created_at DESC LIMIT 100",
      [id],
    )
  ).rows;
  return {
    organization: org,
    domains,
    mailboxes,
    mailNodeStatus: "not-activated",
    mailUsage: "not-synchronized",
  };
}
export async function queue(actor: string, sessionId: string | undefined) {
  await requireStaff(actor, sessionId);
  return (
    await pool.query(
      "SELECT p.id,p.mailbox_id,p.operation,p.revision,p.state,p.attempts,p.last_error_code,p.available_at FROM provisioning_requests p WHERE p.state<>'completed' ORDER BY p.created_at DESC LIMIT 100",
    )
  ).rows;
}
export async function events(actor: string, sessionId: string | undefined) {
  await requireStaff(actor, sessionId);
  return (
    await pool.query(
      "SELECT id,actor_user_id,action,target_id,reason,created_at FROM platform_events ORDER BY id DESC LIMIT 100",
    )
  ).rows;
}
export async function catalog(actor: string, sessionId: string | undefined) {
  await requireStaff(actor, sessionId);
  return (await pool.query("SELECT * FROM plans ORDER BY id LIMIT 1000")).rows;
}
export async function operationalHealth(
  actor: string,
  sessionId: string | undefined,
) {
  await requireStaff(actor, sessionId);
  const queues = (
    await pool.query(`SELECT 'provisioning' AS queue,state,count(*)::int AS jobs,COALESCE(max(EXTRACT(EPOCH FROM (NOW()-created_at)))::int,0) AS oldest_seconds,count(*) FILTER(WHERE state='processing' AND lease_expires_at<NOW())::int AS expired_leases FROM provisioning_requests WHERE state IN('pending','processing','failed') GROUP BY state
  UNION ALL SELECT 'credentials',state,count(*)::int,COALESCE(max(EXTRACT(EPOCH FROM(NOW()-created_at)))::int,0),count(*) FILTER(WHERE state='processing' AND lease_expires_at<NOW())::int FROM mailbox_credential_requests WHERE state IN('hashing','pending','processing','failed') GROUP BY state
  UNION ALL SELECT 'routing',state,count(*)::int,COALESCE(max(EXTRACT(EPOCH FROM(NOW()-created_at)))::int,0),count(*) FILTER(WHERE state='processing' AND lease_expires_at<NOW())::int FROM mail_routing_requests WHERE state IN('pending','processing','failed') GROUP BY state
  UNION ALL SELECT 'usage',state,count(*)::int,COALESCE(max(EXTRACT(EPOCH FROM(NOW()-created_at)))::int,0),count(*) FILTER(WHERE state='processing' AND lease_expires_at<NOW())::int FROM mailbox_usage_requests WHERE state IN('pending','processing','failed') GROUP BY state
  UNION ALL SELECT 'domain-revalidation',state,count(*)::int,COALESCE(max(EXTRACT(EPOCH FROM(NOW()-created_at)))::int,0),count(*) FILTER(WHERE state='processing' AND lease_expires_at<NOW())::int FROM domain_revalidation_requests WHERE state IN('pending','processing','failed') GROUP BY state
  UNION ALL SELECT 'domain-notification',state,count(*)::int,COALESCE(max(EXTRACT(EPOCH FROM(NOW()-created_at)))::int,0),count(*) FILTER(WHERE state='processing' AND lease_expires_at<NOW())::int FROM domain_notification_outbox WHERE state IN('pending','processing','failed') GROUP BY state
  UNION ALL SELECT 'platform-alert',state,count(*)::int,COALESCE(max(EXTRACT(EPOCH FROM(NOW()-created_at)))::int,0),count(*) FILTER(WHERE state='processing' AND lease_expires_at<NOW())::int FROM platform_alert_outbox WHERE state IN('pending','processing','failed') GROUP BY state
  UNION ALL SELECT 'billing-renewal',state,count(*)::int,COALESCE(max(EXTRACT(EPOCH FROM(NOW()-created_at)))::int,0),count(*) FILTER(WHERE state='processing' AND lease_expires_at<NOW())::int FROM billing_renewal_requests WHERE state IN('pending','processing','failed','uncertain') GROUP BY state
  UNION ALL SELECT 'webmail-send',state,count(*)::int,COALESCE(max(EXTRACT(EPOCH FROM(NOW()-created_at)))::int,0),count(*) FILTER(WHERE state='processing' AND created_at<NOW()-INTERVAL '2 minutes')::int FROM webmail_send_attempts WHERE state IN('processing','uncertain') AND resolution IS NULL GROUP BY state ORDER BY queue,state`)
  ).rows as {
    queue: string;
    state: string;
    jobs: number;
    oldest_seconds: number;
    expired_leases: number;
  }[];
  const heartbeats = await heartbeatStatus();
  return {
    observedAt: new Date().toISOString(),
    source: "control-plane-database",
    queues,
    heartbeats,
    attention: queues
      .filter(
        (row) =>
          row.state === "failed" ||
          row.expired_leases > 0 ||
          row.oldest_seconds > 300,
      )
      .map((row) => ({
        queue: row.queue,
        state: row.state,
        jobs: row.jobs,
        reason:
          row.state === "failed"
            ? "failed-requests"
            : row.expired_leases > 0
              ? "expired-leases"
              : "backlog-age",
      })),
    mailTransport: "not-observed",
    diskCapacity: "not-observed",
    backupFreshness: "not-observed",
    heartbeatAttention: heartbeats
      .filter((row) => !row.fresh || row.state === "degraded")
      .map((row) => ({
        component: row.component,
        reason: row.fresh ? "degraded" : "expired",
      })),
    externalNotifications: false,
    syntheticAlertNotifications: true,
    syntheticDomainNotifications: true,
  };
}
export async function setStatus(
  actor: string,
  sessionId: string | undefined,
  kind: "organization" | "account",
  id: string,
  input: unknown,
) {
  z.uuid().parse(id);
  const { status, reason } = z
    .object({
      status: z.enum(["active", "suspended"]),
      reason: z.enum([
        "security-incident",
        "abuse-investigation",
        "owner-request",
      ]),
    })
    .strict()
    .parse(input);
  await requireStaff(actor, sessionId, true);
  return transaction(async (db) => {
    // Staff-row revocation serializes with admitted writes; no tenant role grants staff power.
    await db.query(
      "SELECT user_id FROM platform_staff WHERE user_id=$1 FOR SHARE",
      [actor],
    );
    await requireStaff(actor, sessionId, true, db);
    if (kind === "account") {
      if (id === actor)
        throw new HttpError(409, "Cannot suspend your own staff account");
      if (
        (await db.query("SELECT 1 FROM platform_staff WHERE user_id=$1", [id]))
          .rowCount
      )
        throw new HttpError(
          409,
          "Staff lifecycle requires a separate reviewed workflow",
        );
      const changed = await db.query(
        "UPDATE users SET status=$2,auth_version=auth_version+1 WHERE id=$1 RETURNING id",
        [id, status],
      );
      if (!changed.rowCount) throw new HttpError(404, "Account not found");
      await db.query(
        "UPDATE identity_sessions SET revoked_at=NOW() WHERE user_id=$1",
        [id],
      );
    } else {
      const changed = await db.query(
        "UPDATE organizations SET status=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING id",
        [id, status],
      );
      if (!changed.rowCount) throw new HttpError(404, "Organization not found");
    }
    await db.query(
      "INSERT INTO platform_events(actor_user_id,action,target_id,reason) VALUES($1,$2,$3,$4)",
      [actor, kind + "." + status, id, reason],
    );
    return { status, mailPolicyChanged: false };
  });
}
export async function updatePlan(
  actor: string,
  sessionId: string | undefined,
  id: string,
  input: unknown,
) {
  z.string()
    .regex(/^[a-z0-9-]{3,40}$/)
    .parse(id);
  const data = z
    .object({
      name: z.string().trim().min(1).max(100),
      currency: z.string().regex(/^[A-Z]{3}$/),
      monthlyMinor: z.number().int().min(0).max(100000000),
      yearlyMinor: z.number().int().min(0).max(100000000),
      maxDomains: z.number().int().min(1).max(10000),
      maxMailboxes: z.number().int().min(1).max(100000),
      maxMembers: z.number().int().min(1).max(100000),
      maxQuotaMb: z.number().int().min(1).max(1048576),
      storageMb: z.number().int().min(1).max(1000000000),
      maxMailboxesPerDomain: z.number().int().min(1).max(100000),
      active: z.boolean(),
    })
    .strict()
    .parse(input);
  await requireStaff(actor, sessionId, true);
  return transaction(async (db) => {
    await db.query(
      "SELECT user_id FROM platform_staff WHERE user_id=$1 FOR SHARE",
      [actor],
    );
    await requireStaff(actor, sessionId, true, db);
    const plan = (
      await db.query(
        `INSERT INTO plans(id,name,currency,monthly_minor,yearly_minor,max_domains,max_mailboxes,max_members,max_quota_mb,storage_mb,max_mailboxes_per_domain,active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,currency=EXCLUDED.currency,monthly_minor=EXCLUDED.monthly_minor,yearly_minor=EXCLUDED.yearly_minor,max_domains=EXCLUDED.max_domains,max_mailboxes=EXCLUDED.max_mailboxes,max_members=EXCLUDED.max_members,max_quota_mb=EXCLUDED.max_quota_mb,storage_mb=EXCLUDED.storage_mb,max_mailboxes_per_domain=EXCLUDED.max_mailboxes_per_domain,active=EXCLUDED.active RETURNING *`,
        [
          id,
          data.name,
          data.currency,
          data.monthlyMinor,
          data.yearlyMinor,
          data.maxDomains,
          data.maxMailboxes,
          data.maxMembers,
          data.maxQuotaMb,
          data.storageMb,
          data.maxMailboxesPerDomain,
          data.active,
        ],
      )
    ).rows[0];
    await db.query(
      "INSERT INTO platform_events(actor_user_id,action,reason) VALUES($1,'plan.catalog_updated',$2)",
      [actor, "catalog-update:" + id],
    );
    return plan;
  });
}
export async function retryJob(
  actor: string,
  sessionId: string | undefined,
  id: string,
  input: unknown,
) {
  z.uuid().parse(id);
  const { reason } = z
    .object({
      reason: z.enum([
        "provider-recovered",
        "configuration-corrected",
        "owner-request",
      ]),
    })
    .strict()
    .parse(input);
  await requireStaff(actor, sessionId, true);
  return transaction(async (db) => {
    await db.query(
      "SELECT user_id FROM platform_staff WHERE user_id=$1 FOR SHARE",
      [actor],
    );
    await requireStaff(actor, sessionId, true, db);
    const job = (
      await db.query(
        "SELECT d.organization_id FROM provisioning_requests p JOIN mailboxes m ON m.id=p.mailbox_id JOIN domains d ON d.id=m.domain_id WHERE p.id=$1",
        [id],
      )
    ).rows[0];
    if (!job) throw new HttpError(404, "Job not found");
    const org = (
      await db.query(
        "SELECT status FROM organizations WHERE id=$1 FOR UPDATE",
        [job.organization_id],
      )
    ).rows[0];
    if (org?.status !== "active")
      throw new HttpError(409, "Organization is not active");
    const changed = await retry(db, job.organization_id, id);
    if (!changed)
      throw new HttpError(409, "Only dead-lettered requests can be retried");
    await db.query(
      "INSERT INTO platform_events(actor_user_id,action,target_id,reason) VALUES($1,'provisioning.staff_retry',$2,$3)",
      [actor, id, reason],
    );
    await appendAudit(db, {
      organizationId: job.organization_id,
      actorId: actor,
      action: "provisioning.staff_retry_requested",
      resourceId: changed.mailbox_id,
      metadata: { requestId: id, reason },
    });
    return { id, state: "pending" };
  });
}
