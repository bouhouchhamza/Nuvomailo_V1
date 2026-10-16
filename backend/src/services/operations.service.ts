import { z } from "zod";
import { requireTenant, tenantWrite } from "./tenant-context.js";
import * as repo from "../repositories/operations.repository.js";
import * as queue from "../repositories/provisioning.repository.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { HttpError } from "../middlewares/errors.js";
const page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(),
});
export async function listAudit(userId: string, orgId: string, input: unknown) {
  await requireTenant(userId, orgId, "manage");
  const data = page
    .extend({
      before: z
        .string()
        .regex(/^[1-9][0-9]{0,17}$/)
        .optional(),
    })
    .parse(input);
  const rows = await repo.audit(orgId, data.limit + 1, data.before);
  const items = rows.slice(0, data.limit);
  return {
    items,
    nextCursor: rows.length > data.limit ? String(items.at(-1)!.id) : null,
  };
}
export async function listRequests(
  userId: string,
  orgId: string,
  input: unknown,
) {
  await requireTenant(userId, orgId, "manage");
  const data = page.extend({ before: z.uuid().optional() }).parse(input);
  const rows = await queue.list(orgId, data.limit + 1, data.before);
  const items = rows.slice(0, data.limit);
  return {
    items,
    nextCursor: rows.length > data.limit ? items.at(-1)!.id : null,
  };
}
export async function retryRequest(userId: string, orgId: string, id: string) {
  z.uuid().parse(id);
  return tenantWrite(userId, orgId, "manage", async (client) => {
    const result = await repo.retry(client, orgId, id);
    if (result === null)
      throw new HttpError(404, "Provisioning request not found");
    if (result === false)
      throw new HttpError(409, "Only dead-lettered requests can be retried");
    await appendAudit(client, {
      organizationId: orgId,
      actorId: userId,
      action: "provisioning.retry_requested",
      resourceId: result.mailbox_id,
      metadata: { requestId: id },
    });
    return { id, state: "pending" };
  });
}
export async function reconcileMailbox(
  userId: string,
  orgId: string,
  id: string,
) {
  z.uuid().parse(id);
  return tenantWrite(userId, orgId, "manage", async (client) => {
    const result = await repo.reconcile(client, orgId, id);
    if (result === null)
      throw new HttpError(404, "Mailbox on verified domain not found");
    if (result === false)
      throw new HttpError(
        409,
        "Resolve outstanding provisioning requests before reconciliation",
      );
    await appendAudit(client, {
      organizationId: orgId,
      actorId: userId,
      action: "mailbox.reconciliation_requested",
      resourceId: id,
      metadata: { requestId: result.id, revision: result.revision },
    });
    return { id: result.id, state: "pending" };
  });
}
