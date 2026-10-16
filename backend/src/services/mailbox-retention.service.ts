import { z } from "zod";
import { tenantWrite } from "./tenant-context.js";
import * as repo from "../repositories/mailbox.repository.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { HttpError } from "../middlewares/errors.js";
/** Reversible retention only: reserves address/quota and never removes provider data. */
export async function retainOrRestore(
  actor: string,
  org: string,
  id: string,
  input: unknown,
) {
  z.uuid().parse(id);
  const { action } = z
    .object({ action: z.enum(["retain", "restore"]) })
    .strict()
    .parse(input);
  return tenantWrite(actor, org, "owner", async (db) => {
    const box = (
      await db.query(
        "SELECT m.* FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE m.id=$1 AND d.organization_id=$2 FOR UPDATE OF m",
        [id, org],
      )
    ).rows[0];
    if (!box) throw new HttpError(404, "Mailbox not found");
    if (
      (action === "retain" && box.retained_at) ||
      (action === "restore" && !box.retained_at)
    )
      return { id, retained: !!box.retained_at, changed: false };
    // Clear before the revisioned resume to satisfy the database suspension invariant.
    if (action === "restore")
      await db.query("UPDATE mailboxes SET retained_at=NULL WHERE id=$1", [id]);
    const result = await repo.update(
      db,
      org,
      id,
      action === "retain" ? "suspend" : "resume",
    );
    if (!result)
      throw new HttpError(
        409,
        "An active verified domain is required; domain custody must be restored first",
      );
    if (action === "retain")
      await db.query("UPDATE mailboxes SET retained_at=NOW() WHERE id=$1", [
        id,
      ]);
    await db.query(
      "UPDATE mailbox_credential_grants SET revoked_at=COALESCE(revoked_at,NOW()) WHERE mailbox_id=$1 AND consumed_at IS NULL",
      [id],
    );
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action:
        action === "retain" ? "mailbox.retained" : "mailbox.restore_requested",
      resourceId: id,
      metadata: {
        revision: result.mailbox.desired_revision,
        requestId: result.job.id,
      },
    });
    return {
      id,
      retained: action === "retain",
      changed: true,
      revision: result.mailbox.desired_revision,
      providerApplied: false,
    };
  });
}
