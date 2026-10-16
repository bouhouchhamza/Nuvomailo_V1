import { z } from "zod";
import { domainToASCII } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { Resolver } from "node:dns/promises";
import { authorize, uuid } from "./tenant.service.js";
import * as repo from "../repositories/domain.repository.js";
import { HttpError } from "../middlewares/errors.js";
import type { Domain } from "../models/domain.model.js";
import { requireTenant, tenantWrite } from "./tenant-context.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { enforceResource } from "./entitlement.service.js";
import { transaction } from "../repositories/transaction.js";
import { queueFailedDomainCustody } from "../repositories/domain-custody.repository.js";
export type TxtResolver = (name: string) => Promise<string[][]>;
export const resolveTxt: TxtResolver = (name) =>
  new Resolver({ timeout: 3000, tries: 2 }).resolveTxt(name);
export const domainName = z
  .string()
  .trim()
  .max(253)
  .transform((s) => domainToASCII(s.toLowerCase()))
  .refine(
    (s) =>
      s.length <= 253 &&
      s.includes(".") &&
      s
        .split(".")
        .every((label) =>
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
        ) &&
      /[a-z]/.test(s.split(".").at(-1)!),
    "Enter a public domain name without protocol, port or path",
  );
function present(domain: Domain) {
  return {
    ...domain,
    dnsChallenge: {
      type: "TXT",
      name: `_nuvomailo-verification.${domain.name}`,
      value: `nuvomailo-verification=${domain.verification_token}`,
    },
    mailReadiness: "not-configured",
  };
}
function ownershipRecord(domain: Domain) {
  const state =
    domain.revalidation_state === "current" &&
    domain.revalidation_due_at &&
    new Date(domain.revalidation_due_at).getTime() <= Date.now()
      ? "due"
      : domain.revalidation_state;
  return { ...present(domain), revalidation_state: state };
}
export async function listDomains(userId: string, orgId: string) {
  await authorize(userId, orgId);
  return (await repo.list(orgId)).map(ownershipRecord);
}
export async function revalidateDomain(
  userId: string,
  orgId: string,
  id: string,
  resolver: TxtResolver = resolveTxt,
) {
  uuid.parse(id);
  const claimed = await tenantWrite(userId, orgId, "manage", async (client) => {
    const domain = (
      await client.query<Domain>(
        `UPDATE domains SET revalidation_last_attempt_at=date_trunc('milliseconds',NOW()),
      revalidation_revision=revalidation_revision+1
      WHERE id=$1 AND organization_id=$2 AND verification_status='verified'
      AND (revalidation_last_attempt_at IS NULL OR revalidation_last_attempt_at<NOW()-INTERVAL '60 seconds') RETURNING *`,
        [id, orgId],
      )
    ).rows[0];
    if (!domain) {
      const existing = await repo.get(orgId, id, client);
      if (!existing) throw new HttpError(404, "Domain not found");
      if (existing.verification_status !== "verified")
        throw new HttpError(
          409,
          "Verify the current ownership challenge first",
        );
      throw new HttpError(429, "Wait 60 seconds between ownership checks");
    }
    await appendAudit(client, {
      organizationId: orgId,
      actorId: userId,
      action: "domain.revalidation_attempted",
      resourceId: id,
    });
    return domain;
  });
  let records: string[][];
  try {
    records = await resolver(`_nuvomailo-verification.${claimed.name}`);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENODATA" || code === "ENOTFOUND") records = [];
    else throw new HttpError(503, "DNS lookup unavailable; try again later");
  }
  const verified = records.some(
    (chunks) =>
      chunks.join("") ===
      `nuvomailo-verification=${claimed.verification_token}`,
  );
  return tenantWrite(userId, orgId, "manage", async (client) => {
    const result = (
      await client.query<Domain>(
        `UPDATE domains SET
      revalidation_state=CASE WHEN $4 THEN 'current' WHEN revalidation_grace_expires_at IS NOT NULL AND revalidation_grace_expires_at<=NOW() THEN 'failed' ELSE 'warning' END,
      ownership_revalidated_at=CASE WHEN $4 THEN NOW() ELSE ownership_revalidated_at END,
      revalidation_due_at=CASE WHEN $4 THEN NOW()+INTERVAL '30 days' ELSE NOW()+INTERVAL '1 day' END,
      revalidation_failures=CASE WHEN $4 THEN 0 ELSE revalidation_failures+1 END,
      revalidation_grace_expires_at=CASE WHEN $4 THEN NULL ELSE COALESCE(revalidation_grace_expires_at,NOW()+INTERVAL '30 days') END,
      verification_status=CASE WHEN NOT $4 AND revalidation_grace_expires_at IS NOT NULL AND revalidation_grace_expires_at<=NOW() THEN 'failed' ELSE verification_status END,
      mail_activation=CASE WHEN NOT $4 AND revalidation_grace_expires_at IS NOT NULL AND revalidation_grace_expires_at<=NOW() THEN 'disabled' ELSE mail_activation END
      WHERE id=$1 AND organization_id=$2 AND verification_token=$3 AND verification_status='verified'
      AND revalidation_last_attempt_at=$5 AND revalidation_revision=$6 RETURNING *`,
        [
          id,
          orgId,
          claimed.verification_token,
          verified,
          claimed.revalidation_last_attempt_at,
          claimed.revalidation_revision,
        ],
      )
    ).rows[0];
    if (!result)
      throw new HttpError(409, "Domain ownership changed during revalidation");
    const custodyJobs =
      result.revalidation_state === "failed"
        ? await queueFailedDomainCustody(client, result.id)
        : 0;
    await appendAudit(client, {
      organizationId: orgId,
      actorId: userId,
      action: verified
        ? "domain.revalidated"
        : result.revalidation_state === "failed"
          ? "domain.revalidation_failed"
          : "domain.revalidation_warning",
      resourceId: id,
      metadata: {
        failures: result.revalidation_failures ?? 0,
        state: result.revalidation_state ?? "due",
      },
    });
    return {
      ...ownershipRecord(result),
      ownershipRetained: result.verification_status === "verified",
      mailPolicyChanged: false,
      mailPolicyChangeQueued: custodyJobs > 0,
    };
  });
}
export async function releaseEmptyDomain(
  userId: string,
  sessionId: string | undefined,
  orgId: string,
  id: string,
  input: unknown,
) {
  uuid.parse(id);
  const data = z
    .object({
      confirmName: domainName,
      dashboardPassword: z.string().min(1).max(128),
      reason: z.enum(["owner-no-longer-controls", "test-claim"]),
    })
    .strict()
    .parse(input);
  return transaction(async (client) => {
    await requireTenant(userId, orgId, "owner", client, true);
    const user = (
      await client.query(
        `SELECT u.password_hash FROM users u JOIN identity_sessions s ON s.user_id=u.id
      WHERE u.id=$1 AND s.id=$2 AND u.status='active' AND u.email_verified_at IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at>NOW()
      AND (u.mfa_secret_enc IS NULL OR s.mfa_verified_at>NOW()-INTERVAL '15 minutes') FOR SHARE OF u,s`,
        [userId, sessionId],
      )
    ).rows[0];
    if (
      !user ||
      !(await argon2.verify(user.password_hash, data.dashboardPassword))
    )
      throw new HttpError(403, "Verified owner reauthentication required");
    const domain = (
      await client.query<Domain>(
        "SELECT * FROM domains WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [id, orgId],
      )
    ).rows[0];
    if (!domain) throw new HttpError(404, "Domain not found");
    if (data.confirmName !== domain.name)
      throw new HttpError(400, "Domain confirmation does not match");
    const occupied = (
      await client.query(
        "SELECT 1 FROM mailboxes WHERE domain_id=$1 UNION ALL SELECT 1 FROM mail_routes WHERE domain_id=$1 UNION ALL SELECT 1 FROM mail_routing_requests WHERE domain_id=$1 LIMIT 1",
        [id],
      )
    ).rowCount;
    if (
      domain.mail_ever_activated ||
      occupied ||
      Number(
        (domain as Domain & { routing_generation?: number })
          .routing_generation ?? 0,
      ) !== 0
    )
      throw new HttpError(
        409,
        "Only empty domains with no mail activation or routing history can be released",
      );
    await client.query(
      "INSERT INTO released_domain_claims(original_domain_id,organization_id,name_digest,released_by,reason) VALUES($1,$2,$3,$4,$5)",
      [
        id,
        orgId,
        createHash("sha256").update(domain.name).digest("hex"),
        userId,
        data.reason,
      ],
    );
    await appendAudit(client, {
      organizationId: orgId,
      actorId: userId,
      action: "domain.released",
      resourceId: id,
      metadata: { reason: data.reason, nameReusable: true },
    });
    await client.query("DELETE FROM domains WHERE id=$1", [id]);
    return {
      id,
      released: true,
      nameReusable: true,
      dnsChanged: false,
      mailDataDeleted: false,
    };
  });
}
export async function createDomain(
  userId: string,
  orgId: string,
  input: unknown,
) {
  await authorize(userId, orgId, true);
  const { name } = z.object({ name: domainName }).parse(input);
  return tenantWrite(userId, orgId, "manage", async (client) => {
    await enforceResource(client, orgId, "domains");
    const domain = await repo.create(
      orgId,
      name,
      randomBytes(32).toString("hex"),
      client,
    );
    await appendAudit(client, {
      organizationId: orgId,
      actorId: userId,
      action: "domain.created",
      resourceId: domain.id,
    });
    return present(domain);
  });
}
export async function renewChallenge(
  userId: string,
  orgId: string,
  id: string,
) {
  await authorize(userId, orgId, true);
  uuid.parse(id);
  if (!(await repo.get(orgId, id)))
    throw new HttpError(404, "Domain not found");
  return tenantWrite(userId, orgId, "manage", async (client) => {
    const domain = await repo.renew(
      orgId,
      id,
      randomBytes(32).toString("hex"),
      client,
    );
    if (!domain)
      throw new HttpError(409, "Verified domains do not need a new challenge");
    await appendAudit(client, {
      organizationId: orgId,
      actorId: userId,
      action: "domain.challenge_renewed",
      resourceId: id,
    });
    return present(domain);
  });
}
export async function verifyDomain(
  userId: string,
  orgId: string,
  id: string,
  resolver: TxtResolver = resolveTxt,
) {
  await authorize(userId, orgId, true);
  uuid.parse(id);
  const existing = await repo.get(orgId, id);
  if (!existing) throw new HttpError(404, "Domain not found");
  if (existing.verification_status === "verified") return present(existing);
  if (new Date(existing.verification_expires_at).getTime() <= Date.now())
    throw new HttpError(409, "Challenge expired; renew it before verifying");
  const domain = await tenantWrite(userId, orgId, "manage", async (client) => {
    const claimed = await repo.claimAttempt(orgId, id, client);
    if (claimed)
      await appendAudit(client, {
        organizationId: orgId,
        actorId: userId,
        action: "domain.verification_attempted",
        resourceId: id,
      });
    return claimed;
  });
  if (!domain)
    throw new HttpError(429, "Wait 60 seconds between verification attempts");
  let records: string[][];
  try {
    records = await resolver(`_nuvomailo-verification.${domain.name}`);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENODATA" || code === "ENOTFOUND") records = [];
    else throw new HttpError(503, "DNS lookup unavailable; try again later");
  }
  const verified = records.some(
    (chunks) =>
      chunks.join("") === `nuvomailo-verification=${domain.verification_token}`,
  );
  return tenantWrite(userId, orgId, "manage", async (client) => {
    const result = await repo.recordResult(
      orgId,
      id,
      domain.verification_token,
      verified,
      client,
    );
    if (!result)
      throw new HttpError(
        409,
        "Challenge changed or expired during verification",
      );
    await appendAudit(client, {
      organizationId: orgId,
      actorId: userId,
      action: verified ? "domain.verified" : "domain.verification_failed",
      resourceId: id,
    });
    return present(result);
  });
}
