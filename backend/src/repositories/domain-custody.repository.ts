import type { PoolClient } from "pg";

export async function queueFailedDomainCustody(
  client: PoolClient,
  domainId: string,
) {
  const result = await client.query(
    `WITH changed AS (
      UPDATE mailboxes SET desired_status='suspended',desired_inbound_policy='defer',
        desired_revision=desired_revision+1,provisioning_status='pending_provisioning',
        last_provisioning_error=NULL,updated_at=NOW()
      WHERE domain_id=$1 AND (desired_status<>'suspended' OR desired_inbound_policy<>'defer')
      RETURNING id,quota_mb,desired_revision,desired_status,desired_inbound_policy
    ) INSERT INTO provisioning_requests
      (mailbox_id,operation,quota_mb,revision,desired_status,inbound_policy)
      SELECT id,'domain_custody',quota_mb,desired_revision,desired_status,desired_inbound_policy
      FROM changed RETURNING id`,
    [domainId],
  );
  return result.rowCount ?? 0;
}
