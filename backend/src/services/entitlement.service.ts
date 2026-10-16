import type { Db } from "../repositories/transaction.js";
import { HttpError } from "../middlewares/errors.js";
import { z } from "zod";
const snapshot = z
  .object({
    plan_id: z.string().min(1).max(40),
    catalog_version: z.number().int().min(1),
    max_domains: z.number().int().min(1).max(10000),
    max_mailboxes: z.number().int().min(1).max(100000),
    max_members: z.number().int().min(1).max(100000),
    max_quota_mb: z.number().int().min(1).max(1048576),
    storage_mb: z.number().int().min(1).max(1000000000),
    max_mailboxes_per_domain: z.number().int().min(1).max(100000),
  })
  .strict();
export async function entitlements(db: Db, org: string) {
  const plan = (
    await db.query(
      `SELECT p.*,s.state,s.period_end,s.grace_until,s.cancel_at_period_end,s.entitlement_snapshot,s.catalog_version AS subscription_catalog_version FROM plans p
    LEFT JOIN organization_subscriptions s ON s.plan_id=p.id AND s.organization_id=$1
    WHERE p.id=COALESCE((SELECT plan_id FROM organization_subscriptions WHERE organization_id=$1),'development')`,
      [org],
    )
  ).rows[0];
  if (!plan) throw new HttpError(503, "Entitlements unavailable");
  const captured = plan.entitlement_snapshot
    ? snapshot.safeParse(plan.entitlement_snapshot)
    : undefined;
  if (captured && !captured.success)
    throw new HttpError(503, "Entitlement snapshot invalid");
  const ended =
    plan.period_end && new Date(plan.period_end).getTime() <= Date.now();
  const grace =
    plan.grace_until && new Date(plan.grace_until).getTime() > Date.now();
  return {
    ...plan,
    ...(captured?.success ? captured.data : {}),
    catalog_version: plan.subscription_catalog_version ?? plan.catalog_version,
    snapshotFrozen: !!captured?.success,
    canExpand:
      !plan.state ||
      (plan.state === "trial" && !ended) ||
      (plan.state === "active" && !ended) ||
      ((plan.state === "grace" || plan.state === "past_due") && grace),
    billingMode: "sandbox",
    livePayments: false,
  };
}
export async function enforceResource(
  db: Db,
  org: string,
  kind: "domains" | "members" | "invitations",
) {
  const plan = await entitlements(db, org);
  if (!plan.canExpand)
    throw new HttpError(
      409,
      "Subscription does not permit new resources; existing data is retained",
    );
  const used =
    kind === "domains"
      ? (
          await db.query(
            "SELECT count(*)::int AS n FROM domains WHERE organization_id=$1",
            [org],
          )
        ).rows[0]!.n
      : (
          await db.query(
            "SELECT (SELECT count(*) FROM memberships WHERE organization_id=$1)+(SELECT count(*) FROM membership_invitations WHERE organization_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>NOW()) AS n",
            [org],
          )
        ).rows[0]!.n;
  if (
    Number(used) >= (kind === "domains" ? plan.max_domains : plan.max_members)
  )
    throw new HttpError(409, "Organization resource limit reached");
}
export async function enforceMailbox(
  db: Db,
  org: string,
  domain: string,
  quota: number,
  existingId?: string,
) {
  const plan = await entitlements(db, org);
  const current = existingId
    ? (
        await db.query(
          "SELECT m.quota_mb FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE m.id=$1 AND d.organization_id=$2",
          [existingId, org],
        )
      ).rows[0]
    : undefined;
  if (!plan.canExpand && (!current || quota > current.quota_mb))
    throw new HttpError(
      409,
      "Subscription does not permit expansion; existing mail is retained",
    );
  if (quota > plan.max_quota_mb && (!current || quota > current.quota_mb))
    throw new HttpError(400, "Requested quota exceeds plan limit");
  const totals = (
    await db.query(
      `SELECT count(*)::int AS count,COALESCE(sum(m.quota_mb),0)::bigint AS storage,
    count(*) FILTER(WHERE m.domain_id=$2)::int AS per_domain FROM mailboxes m JOIN domains d ON d.id=m.domain_id
    WHERE d.organization_id=$1 AND ($3::uuid IS NULL OR m.id<>$3)`,
      [org, domain, existingId ?? null],
    )
  ).rows[0]!;
  if (
    !existingId &&
    (totals.count >= plan.max_mailboxes ||
      totals.per_domain >= plan.max_mailboxes_per_domain)
  )
    throw new HttpError(409, "Mailbox limit reached");
  if (
    Number(totals.storage) + quota > Number(plan.storage_mb) &&
    (!current || quota > current.quota_mb)
  )
    throw new HttpError(409, "Configured storage exceeds plan entitlement");
}
