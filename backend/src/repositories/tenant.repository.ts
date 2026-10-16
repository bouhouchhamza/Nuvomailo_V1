import pool from "../config/database.js";
import type { Db } from "./transaction.js";
export type Role = "owner" | "admin" | "member";
export async function membership(
  userId: string,
  orgId: string,
  client: Db = pool,
  lock = false,
) {
  return (
    await client.query<{ role: Role }>(
      "SELECT role FROM memberships WHERE user_id=$1 AND organization_id=$2" +
        (lock ? " FOR SHARE" : ""),
      [userId, orgId],
    )
  ).rows[0];
}
export async function organizations(userId: string) {
  return (
    await pool.query(
      "SELECT o.*, m.role FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=$1 ORDER BY o.created_at",
      [userId],
    )
  ).rows;
}
export async function organization(orgId: string) {
  return (await pool.query("SELECT * FROM organizations WHERE id=$1", [orgId]))
    .rows[0];
}
export async function renameOrganization(
  orgId: string,
  name: string,
  client: Db = pool,
) {
  return (
    await client.query(
      "UPDATE organizations SET name=$2 WHERE id=$1 RETURNING *",
      [orgId, name],
    )
  ).rows[0];
}
export async function members(orgId: string) {
  return (
    await pool.query(
      "SELECT u.id, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY m.created_at",
      [orgId],
    )
  ).rows;
}
export async function addMember(
  orgId: string,
  userId: string,
  role: Role,
  client: Db = pool,
) {
  return (
    await client.query(
      "INSERT INTO memberships (organization_id,user_id,role) VALUES ($1,$2,$3) RETURNING user_id,role",
      [orgId, userId, role],
    )
  ).rows[0];
}
export async function changeMember(
  orgId: string,
  userId: string,
  role: Role,
  client: Db = pool,
) {
  return (
    await client.query(
      "UPDATE memberships SET role=$3 WHERE organization_id=$1 AND user_id=$2 AND role <> 'owner' RETURNING user_id,role",
      [orgId, userId, role],
    )
  ).rows[0];
}
export async function removeMember(
  orgId: string,
  userId: string,
  client: Db = pool,
) {
  return (
    await client.query(
      "DELETE FROM memberships WHERE organization_id=$1 AND user_id=$2 AND role <> 'owner' RETURNING user_id",
      [orgId, userId],
    )
  ).rows[0];
}
