import { z } from "zod";
import * as repo from "../repositories/tenant.repository.js";
import { createOrganizationWithOwner } from "../repositories/organization.repository.js";
import { findUserByEmail } from "../repositories/user.repository.js";
import { HttpError } from "../middlewares/errors.js";
import { requireTenant, tenantWrite } from "./tenant-context.js";
import { transaction } from "../repositories/transaction.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { enforceResource } from "./entitlement.service.js";
export const uuid = z.uuid();
const orgSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});
const roleSchema = z.enum(["admin", "member"]);
export async function authorize(
  userId: string,
  orgId: string,
  write = false,
  ownerOnly = false,
) {
  return requireTenant(
    userId,
    orgId,
    ownerOnly ? "owner" : write ? "manage" : "read",
  );
}
export const listOrganizations = repo.organizations;
export async function createOrganization(userId: string, input: unknown) {
  const data = orgSchema.parse(input);
  return transaction(async (client) => {
    const organization = await createOrganizationWithOwner(
      data.name,
      data.slug,
      userId,
      client,
    );
    await appendAudit(client, {
      organizationId: organization.id,
      actorId: userId,
      action: "organization.created",
      resourceId: organization.id,
    });
    await client.query(
      "INSERT INTO organization_subscriptions(organization_id,plan_id,state,period_end) VALUES($1,'development','trial',NOW()+INTERVAL '14 days')",
      [organization.id],
    );
    return organization;
  });
}
export async function getOrganization(userId: string, orgId: string) {
  const role = await authorize(userId, orgId);
  return { ...(await repo.organization(orgId)), role };
}
export async function updateOrganization(
  userId: string,
  orgId: string,
  input: unknown,
) {
  const { name } = orgSchema.pick({ name: true }).parse(input);
  return tenantWrite(userId, orgId, "manage", async (client) => {
    const organization = await repo.renameOrganization(orgId, name, client);
    await appendAudit(client, {
      organizationId: orgId,
      actorId: userId,
      action: "organization.updated",
      resourceId: orgId,
    });
    return organization;
  });
}
export async function listMembers(userId: string, orgId: string) {
  await authorize(userId, orgId);
  return repo.members(orgId);
}
export async function inviteMember(
  userId: string,
  orgId: string,
  input: unknown,
) {
  await authorize(userId, orgId, true, true);
  const data = z
    .object({
      email: z.string().trim().toLowerCase().email(),
      role: roleSchema,
    })
    .parse(input);
  const user = await findUserByEmail(data.email);
  if (!user) throw new HttpError(404, "User must register before being added");
  return tenantWrite(userId, orgId, "owner", async (client) => {
    await enforceResource(client, orgId, "members");
    const result = await repo.addMember(orgId, user.id, data.role, client);
    await appendAudit(client, {
      organizationId: orgId,
      actorId: userId,
      action: "membership.added",
      resourceId: user.id,
      metadata: { role: data.role },
    });
    return result;
  });
}
export async function updateMember(
  userId: string,
  orgId: string,
  targetId: string,
  input?: unknown,
) {
  await authorize(userId, orgId, true, true);
  uuid.parse(targetId);
  return tenantWrite(userId, orgId, "owner", async (client) => {
    const result =
      input === undefined
        ? await repo.removeMember(orgId, targetId, client)
        : await repo.changeMember(
            orgId,
            targetId,
            z.object({ role: roleSchema }).parse(input).role,
            client,
          );
    if (!result)
      throw new HttpError(409, "Member not found or protected owner");
    await appendAudit(client, {
      organizationId: orgId,
      actorId: userId,
      action:
        input === undefined ? "membership.removed" : "membership.role_changed",
      resourceId: targetId,
    });
    return result;
  });
}
