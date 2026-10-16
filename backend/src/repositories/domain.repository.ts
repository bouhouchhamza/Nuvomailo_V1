import pool from "../config/database.js";
import type { Domain } from "../models/domain.model.js";
import type { Db } from "./transaction.js";
export async function list(orgId: string) {
  return (
    await pool.query<Domain>(
      "SELECT * FROM domains WHERE organization_id=$1 ORDER BY created_at",
      [orgId],
    )
  ).rows;
}
export async function get(orgId: string, id: string, client: Db = pool) {
  return (
    await client.query<Domain>(
      "SELECT * FROM domains WHERE organization_id=$1 AND id=$2",
      [orgId, id],
    )
  ).rows[0];
}
export async function create(
  orgId: string,
  name: string,
  token: string,
  client: Db = pool,
) {
  return (
    await client.query<Domain>(
      "INSERT INTO domains (organization_id,name,verification_token) VALUES ($1,$2,$3) RETURNING *",
      [orgId, name, token],
    )
  ).rows[0]!;
}
export async function claimAttempt(
  orgId: string,
  id: string,
  client: Db = pool,
) {
  return (
    await client.query<Domain>(
      `UPDATE domains SET verification_attempts=verification_attempts+1,last_attempt_at=NOW()
    WHERE organization_id=$1 AND id=$2 AND verification_expires_at>NOW()
    AND (last_attempt_at IS NULL OR last_attempt_at<NOW()-INTERVAL '60 seconds') RETURNING *`,
      [orgId, id],
    )
  ).rows[0];
}
export async function recordResult(
  orgId: string,
  id: string,
  token: string,
  verified: boolean,
  client: Db = pool,
) {
  return (
    await client.query<Domain>(
      `UPDATE domains SET verification_status=CASE WHEN $4 THEN 'verified' ELSE 'failed' END,
    verified_at=CASE WHEN $4 THEN NOW() ELSE NULL END,
    revalidation_state=CASE WHEN $4 THEN 'current' ELSE 'due' END,
    ownership_revalidated_at=CASE WHEN $4 THEN NOW() ELSE NULL END,
    revalidation_due_at=CASE WHEN $4 THEN NOW()+INTERVAL '30 days' ELSE NOW() END,
    revalidation_failures=0,revalidation_grace_expires_at=NULL,revalidation_revision=revalidation_revision+1
    WHERE organization_id=$1 AND id=$2 AND verification_token=$3 AND verification_expires_at>NOW() RETURNING *`,
      [orgId, id, token, verified],
    )
  ).rows[0];
}
export async function renew(
  orgId: string,
  id: string,
  token: string,
  client: Db = pool,
) {
  return (
    await client.query<Domain>(
      `UPDATE domains SET verification_token=$3, verification_status='pending', verified_at=NULL,
    verification_expires_at=NOW()+INTERVAL '7 days',
    revalidation_state='due',ownership_revalidated_at=NULL,revalidation_due_at=NOW(),
    revalidation_last_attempt_at=NULL,revalidation_failures=0,revalidation_grace_expires_at=NULL,
    revalidation_revision=revalidation_revision+1
    WHERE organization_id=$1 AND id=$2 AND verification_status<>'verified' RETURNING *`,
      [orgId, id, token],
    )
  ).rows[0];
}
