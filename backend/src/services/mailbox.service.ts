import { z } from "zod";
import { authorize, uuid } from "./tenant.service.js";
import * as repo from "../repositories/mailbox.repository.js";
import { HttpError } from "../middlewares/errors.js";
import { tenantWrite } from "./tenant-context.js";
import { appendAudit } from "../repositories/audit.repository.js";
import type { Mailbox } from "../models/mailbox.model.js";
import { enforceMailbox } from "./entitlement.service.js";
import { usagePresentation } from "./mailbox-usage.service.js";
const quota = z.number().int().min(1).max(1048576);
const localPart = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
function present(mailbox: Mailbox) {
  return {
    ...mailbox,
    provisioningMode: "pending-phase-6" as const,
    liveMailAvailable: false,
    ...usagePresentation(mailbox),
    usageRefreshAvailable: mailbox.mail_activation === "local-lab",
  };
}
export async function listMailboxes(userId: string, orgId: string) {
  await authorize(userId, orgId);
  return (await repo.list(orgId)).map(present);
}
export async function getMailbox(userId: string, orgId: string, id: string) {
  await authorize(userId, orgId);
  uuid.parse(id);
  const box = await repo.get(orgId, id);
  if (!box) throw new HttpError(404, "Mailbox not found");
  return present(box);
}
export async function createMailbox(
  userId: string,
  orgId: string,
  input: unknown,
) {
  await authorize(userId, orgId, true);
  const data = z
    .object({ domainId: uuid, localPart, quotaMb: quota.default(100) })
    .strict()
    .parse(input);
  return tenantWrite(userId, orgId, "manage", async (client) => {
    await enforceMailbox(client, orgId, data.domainId, data.quotaMb);
    const result = await repo.create(
      client,
      orgId,
      data.domainId,
      data.localPart,
      data.quotaMb,
    );
    if (!result)
      throw new HttpError(
        422,
        "A verified domain owned by this organization is required",
      );
    await appendAudit(client, {
      organizationId: orgId,
      actorId: userId,
      action: "mailbox.create_requested",
      resourceId: result.mailbox.id,
      metadata: {
        requestId: result.job.id,
        revision: result.mailbox.desired_revision,
      },
    });
    return present(result.mailbox);
  });
}
export async function updateMailbox(
  userId: string,
  orgId: string,
  id: string,
  input: unknown,
) {
  await authorize(userId, orgId, true);
  uuid.parse(id);
  const data = z
    .union([
      z.object({ quotaMb: quota }).strict(),
      z.object({ action: z.enum(["suspend", "resume"]) }).strict(),
    ])
    .parse(input);
  return tenantWrite(userId, orgId, "manage", async (client) => {
    if ("quotaMb" in data) {
      const box = await repo.get(orgId, id);
      if (!box) throw new HttpError(404, "Mailbox not found");
      await enforceMailbox(client, orgId, box.domain_id, data.quotaMb, id);
    }
    const result = await repo.update(
      client,
      orgId,
      id,
      "quotaMb" in data ? "set_quota" : data.action,
      "quotaMb" in data ? data.quotaMb : undefined,
    );
    if (!result)
      throw new HttpError(404, "Mailbox on a verified domain not found");
    await appendAudit(client, {
      organizationId: orgId,
      actorId: userId,
      action: "mailbox.configuration_requested",
      resourceId: id,
      metadata: {
        requestId: result.job.id,
        revision: result.mailbox.desired_revision,
      },
    });
    return present(result.mailbox);
  });
}
