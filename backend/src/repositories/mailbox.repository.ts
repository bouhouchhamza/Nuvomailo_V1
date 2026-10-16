import pool from "../config/database.js";
import type { PoolClient } from "pg";
import type { Mailbox } from "../models/mailbox.model.js";
import { HttpError } from "../middlewares/errors.js";
import type { ProvisioningRequest } from "../services/provisioning.adapter.js";
const projection =
  "m.*, m.local_part || '@' || d.name AS address, d.mail_activation";
export async function list(orgId: string) {
  return (
    await pool.query<Mailbox>(
      `SELECT ${projection} FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE d.organization_id=$1 ORDER BY m.created_at`,
      [orgId],
    )
  ).rows;
}
export async function get(orgId: string, id: string) {
  return (
    await pool.query<Mailbox>(
      `SELECT ${projection} FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE d.organization_id=$1 AND m.id=$2`,
      [orgId, id],
    )
  ).rows[0];
}
export async function enqueue(
  client: PoolClient,
  mailbox: Mailbox,
  operation: ProvisioningRequest["operation"],
) {
  return (
    await client.query<ProvisioningRequest>(
      `INSERT INTO provisioning_requests (mailbox_id,operation,quota_mb,revision,desired_status,inbound_policy)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        mailbox.id,
        operation,
        mailbox.quota_mb,
        mailbox.desired_revision,
        mailbox.desired_status,
        mailbox.desired_inbound_policy,
      ],
    )
  ).rows[0]!;
}
// Caller holds the tenant authorization lock and owns this transaction.
export async function create(
  client: PoolClient,
  orgId: string,
  domainId: string,
  localPart: string,
  quota: number,
) {
  const domain = (
    await client.query<{ id: string; name: string }>(
      "SELECT id,name FROM domains WHERE id=$1 AND organization_id=$2 AND verification_status='verified' AND status='active' FOR SHARE",
      [domainId, orgId],
    )
  ).rows[0];
  if (!domain) return null;
  if (
    (
      await client.query(
        "SELECT 1 FROM mail_routes WHERE domain_id=$1 AND local_part=$2",
        [domainId, localPart],
      )
    ).rowCount
  )
    throw new HttpError(409, "Address is retained by a mail route");
  const mailbox = (
    await client.query<Mailbox>(
      "INSERT INTO mailboxes (domain_id,local_part,quota_mb,desired_revision) VALUES ($1,$2,$3,1) RETURNING *",
      [domainId, localPart, quota],
    )
  ).rows[0]!;
  const job = await enqueue(client, mailbox, "create");
  return {
    mailbox: { ...mailbox, address: `${localPart}@${domain.name}` },
    job,
  };
}
export async function update(
  client: PoolClient,
  orgId: string,
  id: string,
  operation: ProvisioningRequest["operation"],
  quota?: number,
) {
  const mailbox = (
    await client.query<Mailbox>(
      `SELECT ${projection} FROM mailboxes m JOIN domains d ON d.id=m.domain_id
    WHERE d.organization_id=$1 AND m.id=$2 AND d.verification_status='verified' AND d.status='active' FOR UPDATE OF m`,
      [orgId, id],
    )
  ).rows[0];
  if (!mailbox) return null;
  if (mailbox.retained_at)
    throw new HttpError(
      409,
      "Restore the retained mailbox before changing its configuration",
    );
  const desired =
    operation === "suspend"
      ? "suspended"
      : operation === "resume"
        ? "active"
        : mailbox.desired_status;
  const inbound =
    operation === "resume" ? "accept" : mailbox.desired_inbound_policy;
  const updated = (
    await client.query<Mailbox>(
      `UPDATE mailboxes SET quota_mb=$2,desired_status=$3,desired_inbound_policy=$4,desired_revision=desired_revision+1,
    provisioning_status='pending_provisioning',last_provisioning_error=NULL,updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, quota ?? mailbox.quota_mb, desired, inbound],
    )
  ).rows[0]!;
  const job = await enqueue(client, updated, operation);
  return { mailbox: { ...updated, address: mailbox.address }, job };
}
