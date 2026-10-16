import { z } from "zod";
import type { PoolClient } from "pg";
import * as repo from "../repositories/tenant.repository.js";
import { transaction, type Db } from "../repositories/transaction.js";
import { HttpError } from "../middlewares/errors.js";
import pool from "../config/database.js";
export type Permission = "read" | "manage" | "owner";
export async function requireTenant(
  userId: string,
  orgId: string,
  permission: Permission = "read",
  client?: Db,
  lock = false,
) {
  z.uuid().parse(orgId);
  const organization = (
    await (client ?? pool).query(
      "SELECT status FROM organizations WHERE id=$1" +
        (lock ? " FOR UPDATE" : ""),
      [orgId],
    )
  ).rows[0];
  const member = await repo.membership(userId, orgId, client, lock);
  if (!member || !organization)
    throw new HttpError(404, "Organization not found");
  if (permission !== "read" && organization.status !== "active")
    throw new HttpError(409, "Organization is suspended or retained");
  if (
    (permission === "manage" && member.role === "member") ||
    (permission === "owner" && member.role !== "owner")
  )
    throw new HttpError(403, "Insufficient organization permissions");
  return member.role;
}
export function tenantWrite<T>(
  userId: string,
  orgId: string,
  permission: Permission,
  work: (client: PoolClient) => Promise<T>,
) {
  return transaction(async (client) => {
    await requireTenant(userId, orgId, permission, client, true);
    return work(client);
  });
}
