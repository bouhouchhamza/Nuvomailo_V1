import { randomUUID } from "node:crypto";
import { z } from "zod";
import pool from "../config/database.js";
import { transaction } from "../repositories/transaction.js";
import { tenantWrite, requireTenant } from "./tenant-context.js";
import { appendAudit } from "../repositories/audit.repository.js";
import { HttpError } from "../middlewares/errors.js";
export interface RoutingTarget {
  organizationId: string;
  domain: string;
  generation: number;
  idempotencyKey: string;
  routes: { source: string; destinations: string[] }[];
}
export interface RoutingApplier {
  apply(target: RoutingTarget): Promise<void>;
}
export async function listRoutes(actor: string, org: string) {
  await requireTenant(actor, org);
  return (
    await pool.query(
      "SELECT r.*,r.local_part||'@'||d.name AS address,d.routing_generation FROM mail_routes r JOIN domains d ON d.id=r.domain_id WHERE d.organization_id=$1 ORDER BY r.created_at DESC LIMIT 100",
      [org],
    )
  ).rows;
}
export async function saveRoute(actor: string, org: string, input: unknown) {
  const data = z
    .object({
      domainId: z.uuid(),
      localPart: z
        .string()
        .trim()
        .toLowerCase()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
      kind: z.enum(["alias", "forward"]),
      targets: z.array(z.uuid()).min(1).max(10),
      enabled: z.boolean().default(true),
    })
    .strict()
    .parse(input);
  if (
    new Set(data.targets).size !== data.targets.length ||
    (data.kind === "alias" && data.targets.length !== 1)
  )
    throw new HttpError(
      400,
      "Alias needs one target; destinations must be unique",
    );
  return tenantWrite(actor, org, "manage", async (db) => {
    const domain = (
      await db.query(
        "SELECT * FROM domains WHERE id=$1 AND organization_id=$2 AND verification_status='verified' AND status='active' FOR UPDATE",
        [data.domainId, org],
      )
    ).rows[0];
    if (!domain) throw new HttpError(404, "Verified active domain required");
    if (
      (
        await db.query(
          "SELECT 1 FROM mailboxes WHERE domain_id=$1 AND local_part=$2",
          [data.domainId, data.localPart],
        )
      ).rowCount
    )
      throw new HttpError(409, "Address belongs to a mailbox");
    const targets = (
      await db.query(
        "SELECT m.id FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE m.id=ANY($1::uuid[]) AND d.organization_id=$2 AND (NOT $3::boolean OR (d.verification_status='verified' AND d.status='active' AND m.desired_status='active'))",
        [data.targets, org, data.enabled],
      )
    ).rows;
    if (targets.length !== data.targets.length)
      throw new HttpError(
        422,
        "Only active same-organization mailboxes are allowed",
      );
    const previous = (
      await db.query(
        "SELECT id FROM mail_routes WHERE domain_id=$1 AND local_part=$2",
        [data.domainId, data.localPart],
      )
    ).rows[0];
    if (
      !previous &&
      (
        await db.query(
          "SELECT count(*)::int AS n FROM mail_routes WHERE domain_id=$1",
          [data.domainId],
        )
      ).rows[0]!.n >= 20
    )
      throw new HttpError(409, "Domain routing limit reached");
    const route = (
      await db.query(
        "INSERT INTO mail_routes(domain_id,local_part,kind,targets,enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(domain_id,local_part) DO UPDATE SET kind=EXCLUDED.kind,targets=EXCLUDED.targets,enabled=EXCLUDED.enabled RETURNING *",
        [data.domainId, data.localPart, data.kind, data.targets, data.enabled],
      )
    ).rows[0];
    const generation = (
      await db.query(
        "UPDATE domains SET routing_generation=routing_generation+1 WHERE id=$1 RETURNING routing_generation",
        [data.domainId],
      )
    ).rows[0]!.routing_generation;
    const rows = (
      await db.query(
        "SELECT r.local_part||'@'||d.name AS source,array_agg(m.local_part||'@'||td.name ORDER BY m.id) AS destinations FROM mail_routes r JOIN domains d ON d.id=r.domain_id JOIN mailboxes m ON m.id=ANY(r.targets) JOIN domains td ON td.id=m.domain_id WHERE r.domain_id=$1 AND r.enabled GROUP BY r.id,d.name ORDER BY r.local_part",
        [data.domainId],
      )
    ).rows;
    const id = randomUUID(),
      snapshot: RoutingTarget = {
        organizationId: org,
        domain: domain.name,
        generation,
        idempotencyKey: id,
        routes: rows,
      };
    await db.query(
      "INSERT INTO mail_routing_requests(id,domain_id,generation,snapshot) VALUES($1,$2,$3,$4)",
      [id, data.domainId, generation, JSON.stringify(snapshot)],
    );
    await appendAudit(db, {
      organizationId: org,
      actorId: actor,
      action: "mail.routing_requested",
      resourceId: route.id,
      metadata: {
        requestId: id,
        generation,
        enabled: data.enabled,
        kind: data.kind,
      },
    });
    return {
      route,
      requestId: id,
      generation,
      state: "pending",
      externalForwarding: false,
    };
  });
}
export async function runRoutingOnce(applier: RoutingApplier) {
  const job = await transaction(async (db) => {
    const row = (
      await db.query(
        `SELECT r.*,d.routing_generation FROM mail_routing_requests r JOIN domains d ON d.id=r.domain_id JOIN organizations o ON o.id=d.organization_id WHERE (r.state='pending' OR (r.state='processing' AND r.lease_expires_at<NOW())) AND r.available_at<=NOW() AND d.mail_activation='local-lab' AND d.status='active' AND d.verification_status='verified' AND o.status='active' ORDER BY r.created_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
      )
    ).rows[0];
    if (!row) return null;
    if (row.generation !== row.routing_generation) {
      await db.query(
        "UPDATE mail_routing_requests SET state='superseded',lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
        [row.id],
      );
      return null;
    }
    const lease = randomUUID();
    await db.query(
      "UPDATE mail_routing_requests SET state='processing',lease_token=$2,lease_expires_at=NOW()+INTERVAL '60 seconds',attempts=attempts+1 WHERE id=$1",
      [row.id, lease],
    );
    return { ...row, lease };
  });
  if (!job) return "idle";
  try {
    await applier.apply(job.snapshot);
    await pool.query(
      "UPDATE mail_routing_requests r SET state=CASE WHEN d.routing_generation=r.generation THEN 'applied' ELSE 'superseded' END,lease_token=NULL,lease_expires_at=NULL FROM domains d WHERE r.id=$1 AND r.lease_token=$2 AND d.id=r.domain_id",
      [job.id, job.lease],
    );
    return "applied";
  } catch {
    await pool.query(
      "UPDATE mail_routing_requests SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,lease_token=NULL,lease_expires_at=NULL,available_at=NOW()+INTERVAL '30 seconds' WHERE id=$1 AND lease_token=$2",
      [job.id, job.lease],
    );
    return "retry";
  }
}
