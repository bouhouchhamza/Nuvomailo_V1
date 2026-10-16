import type { Db } from "./transaction.js";
export interface AuditEvent {
  organizationId: string;
  actorId: string | null;
  action: string;
  resourceId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}
export async function appendAudit(client: Db, event: AuditEvent) {
  await client.query(
    "INSERT INTO audit_events (organization_id,actor_user_id,action,resource_id,metadata) VALUES ($1,$2,$3,$4,$5)",
    [
      event.organizationId,
      event.actorId,
      event.action,
      event.resourceId ?? null,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}
