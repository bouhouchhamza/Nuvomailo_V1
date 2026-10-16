import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { z } from "zod";
import { transaction } from "../repositories/transaction.js";
import { requireTenant } from "./tenant-context.js";
import { enforceResource } from "./entitlement.service.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { HttpError } from "../middlewares/errors.js";
/** Empty control-plane domains only. Mail custody is never transferred by changing a DB owner. */
export async function transferEmptyDomain(
  actor: string,
  org: string,
  id: string,
  input: unknown,
) {
  z.uuid().parse(org);
  z.uuid().parse(id);
  const value = z
    .object({
      targetOrganizationId: z.uuid(),
      dashboardPassword: z.string().min(1).max(128),
    })
    .strict()
    .parse(input);
  if (value.targetOrganizationId === org)
    throw new HttpError(400, "Choose another organization");
  return transaction(async (db) => {
    // Stable lock ordering also covers transfers in opposite directions.
    for (const organization of [org, value.targetOrganizationId].sort())
      await requireTenant(actor, organization, "owner", db, true);
    const user = (
      await db.query(
        "SELECT password_hash FROM users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE",
        [actor],
      )
    ).rows[0];
    if (
      !user ||
      !(await argon2.verify(user.password_hash, value.dashboardPassword))
    )
      throw new HttpError(
        403,
        "Verified identity and password reauthentication required",
      );
    const domain = (
      await db.query(
        "SELECT * FROM domains WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [id, org],
      )
    ).rows[0];
    if (!domain) throw new HttpError(404, "Domain not found");
    if (
      domain.status !== "active" ||
      domain.mail_activation !== "disabled" ||
      domain.mail_ever_activated ||
      domain.routing_generation !== 0 ||
      (
        await db.query(
          "SELECT 1 FROM mailboxes WHERE domain_id=$1 UNION ALL SELECT 1 FROM mail_routes WHERE domain_id=$1 LIMIT 1",
          [id],
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "Only empty domains with no mail activation history can be transferred",
      );
    await enforceResource(db, value.targetOrganizationId, "domains");
    await db.query(
      "UPDATE domains SET organization_id=$2,verification_status='pending',verification_token=$3,verification_expires_at=NOW()+INTERVAL '7 days',mail_activation='disabled' WHERE id=$1",
      [id, value.targetOrganizationId, randomBytes(32).toString("hex")],
    );
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action: "domain.empty_transfer_out",
      resourceId: id,
      metadata: { targetOrganizationId: value.targetOrganizationId },
    });
    await appendAudit(db, {
      organizationId: value.targetOrganizationId,
      actorId: actor,
      action: "domain.empty_transfer_in",
      resourceId: id,
      metadata: { sourceOrganizationId: org },
    });
    return {
      id,
      organizationId: value.targetOrganizationId,
      verificationRequired: true,
      mailReady: false,
      mailDataMoved: false,
    };
  });
}
