import { z } from "zod";
import pool from "../config/database.js";
import { transaction } from "../repositories/transaction.js";
import { requireTenant, tenantWrite } from "./tenant-context.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { HttpError } from "../middlewares/errors.js";
import { enforceResource, entitlements } from "./entitlement.service.js";
export async function listInvitations(actor: string, org: string) {
  await requireTenant(actor, org, "owner");
  return (
    await pool.query(
      "SELECT id,email,role,expires_at,accepted_at,revoked_at FROM membership_invitations WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
      [org],
    )
  ).rows;
}
export async function invite(actor: string, org: string, input: unknown) {
  const { email, role } = z
    .object({
      email: z.string().trim().toLowerCase().email().max(254),
      role: z.enum(["admin", "member"]),
    })
    .strict()
    .parse(input);
  z.uuid().parse(org);
  return transaction(async (db) => {
    await requireTenant(actor, org, "owner", db);
    await db.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
      org,
    ]);
    await requireTenant(actor, org, "owner", db, true);
    const exists = (
      await db.query(
        "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND lower(u.email)=$2",
        [org, email],
      )
    ).rowCount;
    if (exists) throw new HttpError(409, "Already a member");
    await db.query(
      "UPDATE membership_invitations SET revoked_at=NOW() WHERE organization_id=$1 AND lower(email)=$2 AND accepted_at IS NULL AND revoked_at IS NULL",
      [org, email],
    );
    await enforceResource(db, org, "invitations");
    const result = (
      await db.query(
        "INSERT INTO membership_invitations(organization_id,email,role,invited_by) VALUES($1,$2,$3,$4) RETURNING id,email,role,expires_at",
        [org, email, role, actor],
      )
    ).rows[0];
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action: "membership.invited",
      resourceId: result.id,
      metadata: { role },
    });
    return result;
  });
}
export async function inbox(actor: string) {
  return (
    await pool.query(
      "SELECT i.id,i.role,i.expires_at,o.name AS organization_name FROM membership_invitations i JOIN users u ON lower(u.email)=lower(i.email) JOIN organizations o ON o.id=i.organization_id WHERE u.id=$1 AND u.email_verified_at IS NOT NULL AND u.status='active' AND o.status='active' AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>NOW() ORDER BY i.created_at DESC LIMIT 100",
      [actor],
    )
  ).rows;
}
export async function accept(actor: string, id: string) {
  z.uuid().parse(id);
  return transaction(async (db) => {
    const user = (
      await db.query(
        "SELECT email,email_verified_at,status FROM users WHERE id=$1 FOR SHARE",
        [actor],
      )
    ).rows[0];
    if (!user || user.status !== "active" || !user.email_verified_at)
      throw new HttpError(
        403,
        "Verify your email before accepting invitations",
      );
    const reference = (
      await db.query(
        "SELECT organization_id FROM membership_invitations WHERE id=$1 AND lower(email)=$2",
        [id, user.email.toLowerCase()],
      )
    ).rows[0];
    if (!reference) throw new HttpError(404, "Invitation not found");
    const org = (
      await db.query(
        "SELECT status FROM organizations WHERE id=$1 FOR UPDATE",
        [reference.organization_id],
      )
    ).rows[0];
    const invitation = (
      await db.query(
        "SELECT * FROM membership_invitations WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (
      org?.status !== "active" ||
      !invitation ||
      invitation.revoked_at ||
      invitation.accepted_at ||
      new Date(invitation.expires_at).getTime() <= Date.now()
    )
      throw new HttpError(409, "Invitation is no longer available");
    const plan = await entitlements(db, reference.organization_id);
    const count = Number(
      (
        await db.query(
          "SELECT count(*) AS n FROM memberships WHERE organization_id=$1",
          [reference.organization_id],
        )
      ).rows[0]!.n,
    );
    if (!plan.canExpand || count >= plan.max_members)
      throw new HttpError(409, "Organization member limit reached");
    await db.query(
      "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,$3)",
      [actor, reference.organization_id, invitation.role],
    );
    await db.query(
      "UPDATE membership_invitations SET accepted_at=NOW() WHERE id=$1",
      [id],
    );
    await appendAudit(db, {
      organizationId: reference.organization_id,
      actorId: actor,
      action: "membership.invitation_accepted",
      resourceId: id,
    });
    return { organizationId: reference.organization_id };
  });
}
export async function revoke(actor: string, org: string, id: string) {
  z.uuid().parse(id);
  return tenantWrite(actor, org, "owner", async (db) => {
    const changed = await db.query(
      "UPDATE membership_invitations SET revoked_at=NOW() WHERE id=$1 AND organization_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id",
      [id, org],
    );
    if (!changed.rowCount) throw new HttpError(404, "Invitation not found");
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action: "membership.invitation_revoked",
      resourceId: id,
    });
  });
}
export async function transfer(actor: string, org: string, input: unknown) {
  const { userId } = z.object({ userId: z.uuid() }).strict().parse(input);
  // Acquire organization lock before membership locks for concurrent transfers.
  return transaction(async (db) => {
    z.uuid().parse(org);
    const visible = (
      await db.query(
        "SELECT 1 FROM memberships WHERE user_id=$1 AND organization_id=$2",
        [actor, org],
      )
    ).rowCount;
    if (!visible) throw new HttpError(404, "Organization not found");
    await db.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
      org,
    ]);
    await requireTenant(actor, org, "owner", db, true);
    if (userId === actor) throw new HttpError(409, "Already the owner");
    const target = (
      await db.query(
        "SELECT m.role,u.status,u.email_verified_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 FOR UPDATE OF m",
        [org, userId],
      )
    ).rows[0];
    if (!target || target.status !== "active" || !target.email_verified_at)
      throw new HttpError(409, "An active verified member is required");
    await db.query(
      "UPDATE memberships SET role=CASE WHEN user_id=$2 THEN 'owner' ELSE 'admin' END WHERE organization_id=$1 AND user_id IN ($2,$3)",
      [org, userId, actor],
    );
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action: "organization.ownership_transferred",
      resourceId: userId,
    });
  });
}
export async function leave(actor: string, org: string) {
  return tenantWrite(actor, org, "read", async (db) => {
    const member = (
      await db.query(
        "DELETE FROM memberships WHERE organization_id=$1 AND user_id=$2 AND role<>'owner' RETURNING user_id",
        [org, actor],
      )
    ).rows[0];
    if (!member) throw new HttpError(409, "Transfer ownership before leaving");
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action: "membership.left",
      resourceId: actor,
    });
  });
}
