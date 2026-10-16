import argon2 from "argon2";
import { z } from "zod";
import pool from "../config/database.js";
import { transaction } from "../repositories/transaction.js";
import { requireTenant } from "./tenant-context.js";
import { requireStaff } from "./platform.service.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { HttpError } from "../middlewares/errors.js";
export async function issue(
  actor: string,
  session: string | undefined,
  org: string,
  input: unknown,
) {
  const value = z
    .object({
      staffUserId: z.uuid(),
      minutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
      dashboardPassword: z.string().min(1).max(128),
    })
    .strict()
    .parse(input);
  return transaction(async (db) => {
    await requireTenant(actor, org, "owner", db, true);
    if (
      Number(
        (
          await db.query(
            "SELECT count(*) AS count FROM support_grants WHERE organization_id=$1 AND revoked_at IS NULL AND expires_at>NOW()",
            [org],
          )
        ).rows[0].count,
      ) >= 20
    )
      throw new HttpError(409, "Revoke an existing support grant first");
    const user = (
      await db.query(
        `SELECT u.password_hash FROM users u JOIN identity_sessions s ON s.user_id=u.id
      WHERE u.id=$1 AND s.id=$2 AND u.status='active' AND u.email_verified_at IS NOT NULL
      AND s.revoked_at IS NULL AND s.expires_at>NOW()
      AND (u.mfa_secret_enc IS NULL OR s.mfa_verified_at>NOW()-INTERVAL '15 minutes') FOR SHARE OF u,s`,
        [actor, session],
      )
    ).rows[0];
    if (
      !user ||
      !(await argon2.verify(user.password_hash, value.dashboardPassword))
    )
      throw new HttpError(403, "Verified owner reauthentication required");
    if (
      !(
        await db.query(
          "SELECT 1 FROM platform_staff p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND u.status='active' AND u.email_verified_at IS NOT NULL AND u.mfa_secret_enc IS NOT NULL FOR SHARE OF p,u",
          [value.staffUserId],
        )
      ).rowCount
    )
      throw new HttpError(422, "Eligible support identity required");
    const grant = (
      await db.query(
        "INSERT INTO support_grants(organization_id,granted_by,staff_user_id,expires_at) VALUES($1,$2,$3,NOW()+$4*INTERVAL '1 minute') RETURNING id,staff_user_id,scope,created_at,expires_at",
        [org, actor, value.staffUserId, value.minutes],
      )
    ).rows[0];
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action: "support.granted",
      resourceId: grant.id,
      metadata: {
        staffUserId: value.staffUserId,
        minutes: value.minutes,
        scope: "diagnostics-read",
      },
    });
    return grant;
  });
}
export async function list(actor: string, org: string) {
  if ((await requireTenant(actor, org, "read")) !== "owner")
    throw new HttpError(403, "Owner required");
  return (
    await pool.query(
      "SELECT id,staff_user_id,scope,created_at,expires_at,revoked_at FROM support_grants WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
      [org],
    )
  ).rows;
}
export async function revoke(actor: string, org: string, id: string) {
  z.uuid().parse(id);
  return transaction(async (db) => {
    // Owners may revoke access even while the organization is suspended.
    if ((await requireTenant(actor, org, "read", db, true)) !== "owner")
      throw new HttpError(403, "Owner required");
    const row = (
      await db.query(
        "UPDATE support_grants SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1 AND organization_id=$2 RETURNING id",
        [id, org],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "Support grant not found");
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action: "support.revoked",
      resourceId: id,
    });
  });
}
export async function diagnostics(
  actor: string,
  session: string | undefined,
  id: string,
) {
  z.uuid().parse(id);
  return transaction(async (db) => {
    await requireStaff(actor, session, false, db);
    const grant = (
      await db.query(
        `SELECT g.organization_id FROM support_grants g JOIN organizations o ON o.id=g.organization_id
      JOIN memberships m ON m.organization_id=o.id AND m.user_id=g.granted_by AND m.role='owner'
      JOIN users u ON u.id=g.granted_by
      WHERE g.id=$1 AND g.staff_user_id=$2 AND g.revoked_at IS NULL AND g.expires_at>NOW()
      AND o.status='active' AND u.status='active' AND u.email_verified_at IS NOT NULL FOR SHARE OF g,o,m,u`,
        [id, actor],
      )
    ).rows[0];
    if (!grant) throw new HttpError(404, "Active support grant not found");
    const queues = (
      await db.query(
        `SELECT p.state,count(*)::int AS count FROM provisioning_requests p JOIN mailboxes m ON m.id=p.mailbox_id JOIN domains d ON d.id=m.domain_id WHERE d.organization_id=$1 GROUP BY p.state`,
        [grant.organization_id],
      )
    ).rows;
    const resources = (
      await db.query(
        `SELECT (SELECT count(*)::int FROM domains WHERE organization_id=$1) AS domains,
      (SELECT count(*)::int FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE d.organization_id=$1) AS mailboxes`,
        [grant.organization_id],
      )
    ).rows[0];
    await appendAudit(db, {
      organizationId: grant.organization_id,
      actorId: actor,
      action: "support.diagnostics_read",
      resourceId: id,
    });
    return {
      scope: "diagnostics-read",
      resources,
      queues,
      mailUsage: "not-synchronized",
    };
  });
}
