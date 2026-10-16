import pool from "../config/database.js";
import type { Organization } from "../models/organization.model.js";
import type { PoolClient } from "pg";

export async function findOrganizationBySlug(
  slug: string,
): Promise<Organization | null> {
  const result = await pool.query<Organization>(
    `SELECT id, name, slug, created_at
     FROM organizations
     WHERE slug = $1
     LIMIT 1`,
    [slug],
  );

  return result.rows[0] ?? null;
}
export async function createOrganizationWithOwner(
  name: string,
  slug: string,
  ownerId: string,
  suppliedClient?: PoolClient,
): Promise<Organization> {
  const client = suppliedClient ?? (await pool.connect());
  try {
    if (!suppliedClient) await client.query("BEGIN");
    const result = await client.query<Organization>(
      `INSERT INTO organizations (name, slug)
            VALUES($1, $2)
            RETURNING id, name, slug, created_at`,
      [name, slug],
    );

    const organization = result.rows[0];
    if (!organization) {
      throw new Error("Organization creation failed");
    }
    await client.query(
      `INSERT INTO memberships
            (user_id, organization_id, role)
            VALUES ($1, $2, $3)`,
      [ownerId, organization.id, "owner"],
    );
    if (!suppliedClient) await client.query("COMMIT");
    return organization;
  } catch (error) {
    if (!suppliedClient) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (!suppliedClient) client.release();
  }
}
